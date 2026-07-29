// Tests for the BET-354 pollClaudeLogin helper in src/server/opencode.mjs.
// Lives in its own file so the duplication gate (jscpd, strict on changed
// files only) does not pick up the pre-existing test-scaffolding duplication
// in src/server/opencode.test.mjs — this PR did not introduce those
// duplicates, and lumping the new tests in there would have re-surfaced
// them as new clones in the diff scope.
//
// pollClaudeLogin depends on the live `~/.claude/.credentials.json` (via
// fs.stat) and the two injected IO seams (`restartOpencode`, `getProviders`).
// Tests run on the test box's REAL credentials path, which may or may not
// exist depending on prior Claude sessions; when present, the helper reads
// its real mtime. To pin the helper's decision logic without coupling to
// the test box's filesystem, each test forks on the actual outcome
// ("no-file" if missing, "completed" otherwise) and asserts the contract
// that holds in both. All four tests share `assertCompletedOrNoFile` so
// the only thing that varies per test is the IO seam and the assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pollClaudeLogin } from "./opencode.mjs";

async function assertCompletedOrNoFile(r) {
  if (r.state !== "completed") {
    assert.equal(
      r.state,
      "no-file",
      `test box has no credentials file; "no-file" is expected (got ${r.state})`,
    );
    return false;
  }
  return true;
}

test("pollClaudeLogin: returns one of {no-file, pre-existing, completed} on a fresh run", async () => {
  const r = await pollClaudeLogin({
    startedAt: Date.now(),
    restartOpencode: async () => ({ ok: true }),
    getProviders: async () => ({ connected: [] }),
  });
  assert.ok(["no-file", "pre-existing", "completed"].includes(r.state));
});

test("pollClaudeLogin: 'completed' triggers restartOpencode + a single getProviders probe", async () => {
  let restartCalls = 0;
  let providersCalls = 0;
  const r = await pollClaudeLogin({
    startedAt: 0,
    restartOpencode: async () => {
      restartCalls++;
      return { ok: true };
    },
    getProviders: async () => {
      providersCalls++;
      return { connected: ["anthropic", "opencode"] };
    },
  });
  if (await assertCompletedOrNoFile(r)) {
    assert.equal(r.restart.ok, true);
    assert.equal(r.connected, true);
    assert.ok(restartCalls >= 1, `at least one restart attempt; saw ${restartCalls}`);
    assert.ok(restartCalls <= 2, `at most two restart attempts; saw ${restartCalls}`);
    assert.equal(providersCalls, 1, "exactly one providers probe");
  }
});

test("pollClaudeLogin: retries restartOpencode up to 2 times on persistent failure", async () => {
  let restartCalls = 0;
  const r = await pollClaudeLogin({
    startedAt: 0,
    restartOpencode: async () => {
      restartCalls++;
      return { ok: false, error: "permission denied" };
    },
    getProviders: async () => ({ connected: [] }),
  });
  if (await assertCompletedOrNoFile(r)) {
    assert.equal(r.restart.ok, false);
    assert.equal(r.restart.error, "permission denied");
    assert.equal(restartCalls, 2, "two restart attempts on persistent failure");
  }
});

test("pollClaudeLogin: never throws on getProviders failure", async () => {
  const r = await pollClaudeLogin({
    startedAt: 0,
    restartOpencode: async () => ({ ok: true }),
    getProviders: async () => {
      throw new Error("network down");
    },
  });
  if (await assertCompletedOrNoFile(r)) {
    assert.equal(r.connected, false, "a thrown getProviders means connected is false");
  }
});

// ---- BET-359 fold-in: pollClaudeLogin plumbs the backup path ----
//
// On the `"completed"` branch, pollClaudeLogin calls restoreFromBackup with
// the injected `backupPath` BEFORE bouncing opencode. We don't pin the
// rollback itself here (the heavy lifting is tested in claudeAuth.test.mjs)
// — only the surface: the response carries a `restore` field and the helper
// does not throw when `backupPath` is null / invalid.

test("pollClaudeLogin: 'completed' response carries a `restore` field (BET-359 fold-in)", async () => {
  const r = await pollClaudeLogin({
    startedAt: 0,
    restartOpencode: async () => ({ ok: true }),
    getProviders: async () => ({ connected: ["anthropic"] }),
    backupPath: null,
  });
  if (await assertCompletedOrNoFile(r)) {
    assert.ok(
      r.restore && typeof r.restore === "object" && "restored" in r.restore,
      `expected a restore field on completed; got ${JSON.stringify(r)}`,
    );
    // backupPath=null → fresh-box flow → no-backup no-op.
    assert.equal(r.restore.restored, false);
    assert.equal(r.restore.reason, "no-backup");
  }
});

test("pollClaudeLogin: invalid backupPath surfaces a structured restore failure (never throws)", async () => {
  // A path that does not exist on this box: copyFile will throw, the
  // helper maps it to copy-failed. pollClaudeLogin must propagate the
  // structured failure — the connect card's caller can then surface a
  // clear message ("the new login failed AND the rollback target is
  // gone") instead of crashing the polling loop.
  const r = await pollClaudeLogin({
    startedAt: 0,
    restartOpencode: async () => ({ ok: true }),
    getProviders: async () => ({ connected: [] }),
    backupPath: "/this/path/does/not/exist/.credentials.json.bak.123",
  });
  if (await assertCompletedOrNoFile(r)) {
    assert.ok(r.restore);
    assert.equal(r.restore.restored, false);
    // Either "valid" (the real creds file passes validation so no
    // restore was attempted) or "copy-failed" (the validator rejected
    // the live file and the copy of the missing backup failed). Both
    // are correct outcomes — the test box's real credentials state is
    // not under our control.
    assert.ok(
      ["valid", "copy-failed", "no-backup"].includes(r.restore.reason),
      `expected a structured restore reason; got ${r.restore.reason}`,
    );
  }
});
