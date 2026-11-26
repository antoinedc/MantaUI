// Tests for the live Claude Code version claim file (issue #1684). Injected
// I/O for the sync logic; one real-fs case (inside the MANTA_STATE_HOME sandbox)
// pins the atomic default writer and the path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAUDE_CLI_VERSION_FILENAME,
  claudeCliVersionPath,
  createClaudeCliVersionSync,
  startClaudeCliVersionSync,
} from "./claudeCliVersion.mjs";
import { stateHome } from "../shared/paths.mjs";

function memFs(initial) {
  const files = new Map(initial == null ? [] : [["/f", initial]]);
  const writes = [];
  return {
    files,
    writes,
    path: () => "/f",
    readFile: async (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p);
    },
    writeFile: async (p, text) => {
      writes.push(text);
      files.set(p, text);
    },
  };
}

test("path is <state home>/.manta/claude-cli-version, inside the sandbox", () => {
  assert.equal(claudeCliVersionPath(), join(stateHome(), ".manta", CLAUDE_CLI_VERSION_FILENAME));
  assert.ok(claudeCliVersionPath().startsWith(process.env.MANTA_STATE_HOME), "the suite must never target the real ~/.manta");
});

test("record: writes a new version once, and not again while unchanged", async () => {
  const fs = memFs();
  const sync = createClaudeCliVersionSync(fs);
  assert.equal(await sync.record("2.1.301"), true);
  assert.equal(await sync.record("2.1.301"), false);
  assert.equal(await sync.record(" 2.1.301 \n"), false, "whitespace is not a change");
  assert.deepEqual(fs.writes, ["2.1.301\n"]);
});

test("record: a changed version (CLI updated) is written", async () => {
  const fs = memFs("2.1.207\n");
  const sync = createClaudeCliVersionSync(fs);
  assert.equal(await sync.record("2.1.301"), true);
  assert.equal(fs.files.get("/f"), "2.1.301\n");
});

test("record: a file deleted behind our back is repaired (disk is re-read, not trusted from memory)", async () => {
  const fs = memFs();
  const sync = createClaudeCliVersionSync(fs);
  await sync.record("2.1.301");
  fs.files.delete("/f");
  assert.equal(await sync.record("2.1.301"), true);
  assert.equal(fs.files.get("/f"), "2.1.301\n");
});

test("record: junk is never written", async () => {
  const fs = memFs("2.1.301\n");
  const sync = createClaudeCliVersionSync(fs);
  for (const v of [null, undefined, "", "banana", "2.1.x", 7, {}, "2"]) {
    assert.equal(await sync.record(v), false, JSON.stringify(v));
  }
  assert.deepEqual(fs.writes, []);
});

test("record: a failing write is reported, never thrown, and retried on the next call", async () => {
  const fs = memFs();
  const warnings = [];
  let fail = true;
  const sync = createClaudeCliVersionSync({
    ...fs,
    warn: (m) => warnings.push(m),
    writeFile: async (p, t) => {
      if (fail) throw new Error("EACCES");
      return fs.writeFile(p, t);
    },
  });
  assert.equal(await sync.record("2.1.301"), false);
  assert.match(warnings[0], /could not write \/f: EACCES/);
  fail = false;
  assert.equal(await sync.record("2.1.301"), true);
});

test("record: racing callers write once", async () => {
  const fs = memFs();
  const sync = createClaudeCliVersionSync(fs);
  const results = await Promise.all([sync.record("2.1.301"), sync.record("2.1.301"), sync.record("2.1.301")]);
  assert.deepEqual(results, [true, false, false]);
  assert.equal(fs.writes.length, 1);
});

test("refresh: reads the CLI's version and persists it; a missing CLI or a throw writes nothing", async () => {
  const fs = memFs();
  const sync = createClaudeCliVersionSync({ ...fs, readCliVersion: async () => "2.1.305" });
  assert.equal(await sync.refresh(), true);
  assert.equal(fs.files.get("/f"), "2.1.305\n");

  const none = createClaudeCliVersionSync({ ...memFs(), readCliVersion: async () => null });
  assert.equal(await none.refresh(), false);
  const boom = createClaudeCliVersionSync({
    ...memFs(),
    readCliVersion: async () => {
      throw new Error("spawn failed");
    },
  });
  assert.equal(await boom.refresh(), false);
});

test("startClaudeCliVersionSync: syncs at boot and again on every interval until stopped", async () => {
  let reads = 0;
  const fs = memFs();
  const sync = createClaudeCliVersionSync({
    ...fs,
    readCliVersion: async () => `2.1.${300 + reads++}`,
  });
  const { stop } = startClaudeCliVersionSync({ sync, intervalMs: 10 });
  // Wait for the boot tick + two interval ticks (bounded, so a loaded runner can't flake it).
  for (let i = 0; i < 200 && reads < 3; i++) await new Promise((r) => setTimeout(r, 10));
  stop();
  const afterStop = reads;
  assert.ok(afterStop >= 3, `boot tick + at least two interval ticks (got ${afterStop})`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(reads, afterStop, "stopped");
  assert.match(fs.files.get("/f"), /^2\.1\.\d+\n$/);
});

test("default writer: atomic temp+rename under the state home, creating the directory, no temp left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-ccv-"));
  const file = join(dir, ".manta", "claude-cli-version");
  try {
    const sync = createClaudeCliVersionSync({ path: () => file, readCliVersion: async () => "2.1.310" });
    assert.equal(await sync.refresh(), true);
    assert.equal(readFileSync(file, "utf8"), "2.1.310\n");
    assert.deepEqual(readdirSync(dirname(file)), ["claude-cli-version"]);
    assert.equal(await sync.refresh(), false, "unchanged → no rewrite");
    assert.equal(await readFile(file, "utf8"), "2.1.310\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(file), false);
});
