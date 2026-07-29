// Tests for the opencode restart invariant (BET-357 §5).
//
// Pins the behaviour the BET-352 POC established empirically and that BET-354
// §3 already relies on: opencode reads `~/.claude/.credentials.json` at
// startup, so a running opencode process does NOT observe credentials rewritten
// under it — only a fresh process picks up the new file.
//
// The pm's spec asks for an integration-style check that pins this with a
// real child, so a future change to the Claude auth plugin cannot silently
// regress the connect flow back to "no restart required" (the BET-352 POC's
// `RESULTS.md` Q4 claim, which was wrong).
//
// Test setup is hermetic:
//   - Each test mints a temp HOME directory and writes a controlled
//     `.claude/.credentials.json` into it. The real credentials path on this
//     box is NEVER touched (the parent process's CREDENTIALS_PATH import is
//     irrelevant here — the test only writes to the temp path).
//   - The child process inherits HOME=tempDir so its `homedir()` resolves
//     the controlled path. Its `fs.readFileSync` at startup captures the
//     snapshot — that capture is the entire point of the test.
//   - Each test cleans up its child + temp dir in `finally` so a failure on
//     one test does not leak processes into the next.
//
// The WRITE side is simulated by writing the credentials file directly
// because `refreshClaudeCredentials` spawns the real `claude` CLI (which we
// cannot do in tests). The test pins the invariant the refresh helper's
// write effect depends on — if a future change to the auth plugin made
// opencode re-read credentials on every request, the existing tests in
// `opencode.pollClaudeLogin.test.mjs` would NOT catch it (they fake
// `restartOpencode`/`getProviders` via injection and never spawn a real
// process). This file does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Fake "opencode" child script
// ---------------------------------------------------------------------------
//
// Models exactly the behaviour we need to pin: opencode reads the credentials
// file ONCE at startup and never re-reads it. The script:
//   1. reads `${HOME}/.claude/.credentials.json` synchronously at startup
//   2. prints `STARTUP:<json-blob>` to stderr so the parent test can assert
//      what was captured
//   3. on a `QUERY` line on stdin, prints `NOW:<same-json-blob>` — proving
//      the captured value did NOT change when the file under it was rewritten
//   4. stays alive (setInterval keeps the event loop open) until the parent
//      kills it via SIGTERM
//
// `${HOME}` is set by the parent's spawn() env, so the test controls the
// credentials path completely.

const FAKE_OPENCODE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const credsFile = path.join(process.env.HOME, ".claude", ".credentials.json");
let snapshot = null;
let readErr = null;
try {
  snapshot = fs.readFileSync(credsFile, "utf-8");
} catch (e) {
  readErr = e && e.code ? e.code : String(e);
}
const out = JSON.stringify({ snapshot, readErr });
process.stderr.write("STARTUP:" + out + "\\n");
process.stdin.setEncoding("utf-8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line === "QUERY") {
      process.stderr.write("NOW:" + out + "\\n");
    }
  }
});
setInterval(() => {}, 60_000);
`;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function setupFakeHome() {
  const homeDir = mkdtempSync(path.join(tmpdir(), "opencode-restart-test-"));
  mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  const credsFile = path.join(homeDir, ".claude", ".credentials.json");
  return { homeDir, credsFile };
}

function writeCreds(credsFile, content) {
  writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: content }));
}

function spawnFakeOpencode(homeDir) {
  return spawn(process.execPath, ["-e", FAKE_OPENCODE_SCRIPT], {
    env: { ...process.env, HOME: homeDir },
    stdio: ["pipe", "ignore", "pipe"],
  });
}

/** Read stderr line-by-line and resolve with the first line matching `prefix`.
 *  Rejects on timeout or unexpected exit. Used to capture the child's
 *  startup snapshot and its on-demand `QUERY` responses. */
function readTaggedLine(child, prefix, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith(prefix)) {
          settled = true;
          clearTimeout(timer);
          child.stderr.off("data", onData);
          resolve(line.slice(prefix.length));
          return;
        }
      }
    };
    const onError = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      reject(e);
    };
    const onExit = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      reject(new Error(`child exited (code ${code}) before emitting ${prefix}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      reject(new Error(`timeout (${timeoutMs}ms) waiting for ${prefix}; saw: ${buf.slice(0, 200)}`));
    }, timeoutMs);
    child.stderr.on("data", onData);
    child.stderr.on("error", onError);
    child.on("exit", onExit);
  });
}

function killChild(child) {
  if (!child || child.killed || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(safety);
      resolve();
    };
    child.once("exit", done);
    const safety = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 1000);
    try { child.kill("SIGTERM"); } catch { done(); }
  });
}

function teardown(child, homeDir) {
  return killChild(child).finally(() => {
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("restart invariant: a running opencode child does NOT pick up new credentials written after it started", async () => {
  const { homeDir, credsFile } = setupFakeHome();
  let child;
  try {
    // Pre-state: write v1 credentials and spawn a child that captures them.
    writeCreds(credsFile, { accessToken: "OLD_TOKEN", refreshToken: "OLD_REFRESH" });
    child = spawnFakeOpencode(homeDir);
    const startup = JSON.parse(await readTaggedLine(child, "STARTUP:"));
    assert.equal(startup.readErr, null, "child read v1 without error");
    assert.equal(startup.snapshot, JSON.stringify({ claudeAiOauth: { accessToken: "OLD_TOKEN", refreshToken: "OLD_REFRESH" } }));

    // Action: write v2 credentials (the only effect of the real refresh
    // helper / `claude auth login` flow that we can reproduce in a test
    // without spawning the actual `claude` CLI).
    writeCreds(credsFile, { accessToken: "NEW_TOKEN", refreshToken: "NEW_REFRESH" });

    // Assertion: ask the child what it sees NOW. The captured-at-startup
    // value must still be OLD — the running child never re-reads.
    child.stdin.write("QUERY\n");
    const now = JSON.parse(await readTaggedLine(child, "NOW:"));
    assert.equal(now.snapshot, JSON.stringify({ claudeAiOauth: { accessToken: "OLD_TOKEN", refreshToken: "OLD_REFRESH" } }),
      "running child still reports the OLD credentials it captured at startup");
    assert.ok(!now.snapshot.includes("NEW_TOKEN"),
      "running child did NOT observe the new credentials written under it");
  } finally {
    await teardown(child, homeDir);
  }
});

test("restart invariant: a fresh opencode child DOES see the new credentials", async () => {
  const { homeDir, credsFile } = setupFakeHome();
  let child;
  try {
    // First generation: write v1, spawn child, child captures v1.
    writeCreds(credsFile, { accessToken: "OLD_TOKEN", refreshToken: "OLD_REFRESH" });
    child = spawnFakeOpencode(homeDir);
    const firstStartup = JSON.parse(await readTaggedLine(child, "STARTUP:"));
    assert.equal(firstStartup.snapshot, JSON.stringify({ claudeAiOauth: { accessToken: "OLD_TOKEN", refreshToken: "OLD_REFRESH" } }));

    // Action: rewrite to v2, kill the first child, spawn a replacement.
    writeCreds(credsFile, { accessToken: "NEW_TOKEN", refreshToken: "NEW_REFRESH" });
    await killChild(child);
    child = spawnFakeOpencode(homeDir);
    const secondStartup = JSON.parse(await readTaggedLine(child, "STARTUP:"));
    assert.equal(secondStartup.snapshot, JSON.stringify({ claudeAiOauth: { accessToken: "NEW_TOKEN", refreshToken: "NEW_REFRESH" } }),
      "fresh child sees the new credentials (the post-restart path the connect flow relies on)");
    assert.ok(!secondStartup.snapshot.includes("OLD_TOKEN"),
      "fresh child did NOT see the stale v1 credentials");
  } finally {
    await teardown(child, homeDir);
  }
});

test("restart invariant: holds even when writes bypass the refresh helper (direct fs write)", async () => {
  // Negative case from the pm's spec: the invariant must be about the
  // opencode read behaviour, not about any specific write path. A direct
  // fs write (no `claude` CLI, no refresh helper in sight) must produce
  // the same outcome — running process sees old, fresh process sees new.
  const { homeDir, credsFile } = setupFakeHome();
  let child;
  try {
    writeCreds(credsFile, { accessToken: "DIRECT_OLD" });
    child = spawnFakeOpencode(homeDir);
    const startup = JSON.parse(await readTaggedLine(child, "STARTUP:"));
    assert.ok(startup.snapshot.includes("DIRECT_OLD"));

    // Bypass the refresh helper entirely — just write the file with a
    // different name first and rename, so we mirror what a real CLI does
    // (atomic replace) rather than truncating in place.
    const tmpFile = credsFile + ".tmp";
    writeFileSync(tmpFile, JSON.stringify({ claudeAiOauth: { accessToken: "DIRECT_NEW" } }));
    renameSync(tmpFile, credsFile);

    child.stdin.write("QUERY\n");
    const now = JSON.parse(await readTaggedLine(child, "NOW:"));
    assert.ok(now.snapshot.includes("DIRECT_OLD"),
      "running child still reports DIRECT_OLD after an atomic-replace write");
    assert.ok(!now.snapshot.includes("DIRECT_NEW"),
      "running child did NOT pick up DIRECT_NEW — invariant is about the read side, not the write path");
  } finally {
    await teardown(child, homeDir);
  }
});
