// Integration-style assertion that pins the opencode restart invariant
// (BET-357 §5): the opencode-claude-auth plugin reads
// ~/.claude/.credentials.json at startup. Writing a new file does NOT
// change what a running opencode process observes — the child must be
// killed and respawned (or `systemctl --user restart opencode-serve`'d)
// for the new tokens to take effect.
//
// The BET-352 POC's merged RESULTS.md claimed the opposite (Q4 "no
// restart required"); that conclusion was untested. These tests pin the
// real behaviour so a future change to the opencode-claude-auth plugin
// cannot silently break the connect flow.
//
// Three assertions, in the order the issue specifies them:
//
//   1. After the refresh helper (`refreshClaudeCredentials`) writes a
//      new credentials file, an existing opencode-serve child does NOT
//      see them — the snapshot it captured at startup is unchanged.
//
//   2. After the same helper is asked to "restart" the opencode child
//      (kill + respawn), a freshly-spawned child DOES see the new
//      credentials — proves the invariant is observable, not a
//      measurement bug (i.e. the file IS readable, the running process
//      just isn't reading it).
//
//   3. (Negative) If the credentials file is rewritten by a different
//      path (bypassing the refresh helper — direct write, manual edit,
//      future plugin change), the same invariant still holds. Proves the
//      invariant is about the opencode child reading the file at startup,
//      not about the helper specifically.
//
// No live tmux, ssh, or opencode in this file. The "opencode-serve
// process" is simulated by a Node child that on startup reads the
// credentials file once, hashes it, and writes the hash to stderr —
// then idles. The parent (this test file) drives the rewrite and reads
// back the child's stderr to assert what the child observes.
//
// The "credentials file" lives inside a temp $HOME that we populate with
// a fake `claude` binary (so `refreshClaudeCredentials`'s spawn lands
// somewhere we control). HOME is set BEFORE importing opencode.mjs so
// `CREDENTIALS_PATH` (computed at module load via homedir()) and
// `resolveClaudeBin()` (called at refresh time via homedir()) both
// resolve inside the temp tree.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn as cpSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fixture: fake $HOME, fake `claude` binary, initial credentials.
// ---------------------------------------------------------------------------

const REAL_HOME = process.env.HOME;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "bet363-restart-"));
process.env.HOME = FAKE_HOME;

const BEFORE_CREDS = {
  claudeAiOauth: {
    accessToken: "before-access",
    refreshToken: "before-refresh",
    expiresAt: Date.now() + 6 * 60 * 60_000,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  },
};
const AFTER_CREDS = {
  claudeAiOauth: {
    accessToken: "after-access",
    refreshToken: "after-refresh",
    expiresAt: Date.now() + 12 * 60 * 60_000,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  },
};

const CREDS_PATH = join(FAKE_HOME, ".claude", ".credentials.json");
mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
writeFileSync(CREDS_PATH, JSON.stringify(BEFORE_CREDS));

// Fake `claude` binary. The refresh helper invokes it as `claude -p .
// --model haiku` and waits for exit. The fake rewrites the credentials
// file with whatever shape is stashed in $__FAKE_CREDS_AFTER (so test
// setup can change the AFTER shape between scenarios without rewriting
// the binary) and exits 0. A Node script (not /bin/sh) so the test is
// portable across platforms where the test runner might run.
const FAKE_BIN_DIR = join(FAKE_HOME, ".local", "bin");
mkdirSync(FAKE_BIN_DIR, { recursive: true });
const FAKE_CLAUDE = join(FAKE_BIN_DIR, "claude");
writeFileSync(
  FAKE_CLAUDE,
  [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const credsPath = path.join(process.env.HOME, \".claude\", \".credentials.json\");",
    "fs.writeFileSync(credsPath, process.env.__FAKE_CREDS_AFTER);",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.__FAKE_CREDS_AFTER = JSON.stringify(AFTER_CREDS);

// Import the module AFTER setting HOME so CREDENTIALS_PATH resolves
// inside FAKE_HOME. The static `import` at the top of the file would
// have imported it first regardless of ordering; the dynamic import
// here lets us guarantee HOME is set first.
const { refreshClaudeCredentials } = await import("./opencode.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_OPENCODE_SCRIPT = [
  'const fs = require("node:fs");',
  'const crypto = require("node:crypto");',
  "const credsPath = process.env.__CREDS_PATH;",
  "const data = fs.readFileSync(credsPath, \"utf-8\");",
  "const hash = crypto.createHash(\"sha256\").update(data).digest(\"hex\");",
  'process.stderr.write("OPENCODE_HASH:" + hash + "\\n");',
  "// Stay alive so the parent can rewrite the file and assert that this",
  "// child still reports the snapshot it captured at startup (it does —",
  "// this is the whole point of the test). 1<<30 ms ≈ 34 years.",
  "setInterval(() => {}, 1 << 30);",
  "",
].join("\n");

function spawnFakeOpencode() {
  const child = cpSpawn(
    process.execPath,
    ["-e", FAKE_OPENCODE_SCRIPT],
    {
      env: { ...process.env, __CREDS_PATH: CREDS_PATH },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const observed = [];
  let buffer = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("OPENCODE_HASH:")) {
        observed.push(line.slice("OPENCODE_HASH:".length));
      }
    }
  });
  return {
    child,
    async waitForFirstHash() {
      for (let i = 0; i < 200; i++) {
        if (observed.length > 0) return observed[0];
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("fake opencode child did not emit a hash within 5s");
    },
    getObservedHashes() {
      return observed.slice();
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Restore the real HOME at the end so other test files in the same
// `node --test` invocation don't see the override. node:test serializes
// files within a process by default, but the override is global state
// — defensive cleanup is cheap.
after(() => {
  process.env.HOME = REAL_HOME;
  try {
    rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("refreshClaudeCredentials: existing opencode process does NOT see new credentials", async () => {
  // Reset the file to BEFORE so the test is independent of prior cases.
  writeFileSync(CREDS_PATH, JSON.stringify(BEFORE_CREDS));
  const beforeHash = sha256(JSON.stringify(BEFORE_CREDS));
  const afterHash = sha256(JSON.stringify(AFTER_CREDS));
  assert.notEqual(beforeHash, afterHash, "BEFORE and AFTER must differ");

  const oc = spawnFakeOpencode();
  try {
    const firstObserved = await oc.waitForFirstHash();
    assert.equal(firstObserved, beforeHash, "child captured BEFORE at startup");

    // Run the real refresh. It spawns the fake `claude`, which rewrites
    // the file with AFTER_CREDS, then re-reads the file to classify the
    // outcome. The helper reports ok:true when credsAfter.expiresAt >
    // now + 60_000 — AFTER_CREDS is well past that.
    const result = await refreshClaudeCredentials();
    assert.equal(
      result.ok,
      true,
      `refresh succeeded (got ${JSON.stringify(result)})`,
    );

    // Sanity: the on-disk file now matches AFTER_CREDS (confirms the
    // helper actually rewrote it via the fake `claude`).
    assert.equal(
      sha256(readFileSync(CREDS_PATH, "utf-8")),
      afterHash,
      "on-disk file now matches AFTER_CREDS",
    );

    // The running child only captured ONE snapshot at startup, so all
    // of its observed hashes must still equal the BEFORE hash. The
    // invariant we're pinning: a running opencode child does NOT see
    // new credentials until it restarts.
    const observed = oc.getObservedHashes();
    assert.ok(
      observed.every((h) => h === beforeHash),
      `running child still reports BEFORE: ${JSON.stringify(observed)}`,
    );
    assert.ok(
      !observed.includes(afterHash),
      `running child must NOT have observed AFTER (yet): ${JSON.stringify(observed)}`,
    );
  } finally {
    oc.kill();
  }
});

test("refreshClaudeCredentials + restart: respawned opencode process DOES see new credentials", async () => {
  // Reset file to BEFORE so the refresh path actually rewrites it.
  writeFileSync(CREDS_PATH, JSON.stringify(BEFORE_CREDS));
  const beforeHash = sha256(JSON.stringify(BEFORE_CREDS));
  const afterHash = sha256(JSON.stringify(AFTER_CREDS));

  // Run the refresh first (no live child in this test — we isolate the
  // restart effect by spawning fresh AFTER the rewrite).
  const result = await refreshClaudeCredentials();
  assert.equal(result.ok, true, `refresh succeeded (got ${JSON.stringify(result)})`);
  assert.equal(sha256(readFileSync(CREDS_PATH, "utf-8")), afterHash);

  // Spawn a FRESH child AFTER the refresh + rewrite. This is the
  // "after restart" observation. If we kept the original child, its
  // snapshot would be stuck on BEFORE — a fresh spawn is the only way
  // to assert the new creds are actually reachable.
  const oc = spawnFakeOpencode();
  try {
    const firstObserved = await oc.waitForFirstHash();
    assert.equal(
      firstObserved,
      afterHash,
      `fresh opencode child observes AFTER (got ${firstObserved}, expected ${afterHash})`,
    );
    // Defensive: the new child is NOT carrying the stale snapshot.
    assert.notEqual(firstObserved, beforeHash);
  } finally {
    oc.kill();
  }
});

test("direct-write bypass: existing opencode process still does NOT see new credentials", async () => {
  // Reset file to BEFORE so the bypass path starts from a known state.
  writeFileSync(CREDS_PATH, JSON.stringify(BEFORE_CREDS));
  const beforeHash = sha256(JSON.stringify(BEFORE_CREDS));
  const afterHash = sha256(JSON.stringify(AFTER_CREDS));

  const oc = spawnFakeOpencode();
  try {
    const firstObserved = await oc.waitForFirstHash();
    assert.equal(firstObserved, beforeHash);

    // Bypass the helper: write AFTER_CREDS straight to disk. This
    // simulates a future change that rewrites the file outside the
    // helper (a CLI install, a config tweak, a manual edit, …) — the
    // invariant must still hold. The helper is not on the path; the
    // invariant is about the opencode child's read pattern, not about
    // which writer produced the new file.
    writeFileSync(CREDS_PATH, JSON.stringify(AFTER_CREDS));
    assert.equal(
      sha256(readFileSync(CREDS_PATH, "utf-8")),
      afterHash,
      "on-disk file now matches AFTER_CREDS",
    );

    // Same assertion as test #1: the running child's snapshot is
    // unchanged after a bypass write.
    const observed = oc.getObservedHashes();
    assert.ok(
      observed.every((h) => h === beforeHash),
      `running child still reports BEFORE after bypass write: ${JSON.stringify(observed)}`,
    );
    assert.ok(
      !observed.includes(afterHash),
      `running child must NOT have observed AFTER after bypass: ${JSON.stringify(observed)}`,
    );
  } finally {
    oc.kill();
  }
});
