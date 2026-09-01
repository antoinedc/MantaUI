// testSandbox.test.mjs — pins the per-process sandbox semantics (BET-1493).
//
// The sandbox must give every node:test file-process its OWN state home while
// keeping the two contracts that predate it: an explicitly-set MANTA_STATE_HOME
// (no owner marker — external caller or vitest.config.ts injection) is shared
// as-is, and repeated calls in one process return the same directory. The
// inherited-home case is what the runner creates on node 20 (the coordinator's
// preload runs first, then every spawned test-file child inherits its env):
// without the per-process split those children all raced on one ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxStateHome } from "./testSandbox.mjs";

const HOME_VAR = "MANTA_STATE_HOME";
const OWNER_VAR = "MANTA_STATE_HOME_OWNER";

// The preload side effect already set real values in THIS process — save and
// restore them around each scenario so the module's env reads are exercised
// from a controlled state without disturbing anything that runs after us.
function withEnv(home, owner, fn) {
  const savedHome = process.env[HOME_VAR];
  const savedOwner = process.env[OWNER_VAR];
  try {
    if (home === undefined) delete process.env[HOME_VAR];
    else process.env[HOME_VAR] = home;
    if (owner === undefined) delete process.env[OWNER_VAR];
    else process.env[OWNER_VAR] = owner;
    return fn();
  } finally {
    if (savedHome === undefined) delete process.env[HOME_VAR];
    else process.env[HOME_VAR] = savedHome;
    if (savedOwner === undefined) delete process.env[OWNER_VAR];
    else process.env[OWNER_VAR] = savedOwner;
  }
}

test("explicitly-set home with no owner marker is respected and shared as-is", () => {
  withEnv("/tmp/external-caller-home", undefined, () => {
    assert.equal(sandboxStateHome(), "/tmp/external-caller-home");
    assert.equal(process.env[HOME_VAR], "/tmp/external-caller-home");
    // The owner marker must stay unset — the external caller keeps control.
    assert.equal(process.env[OWNER_VAR], undefined);
  });
});

test("home created by this process is returned unchanged (idempotent)", () => {
  const mine = String(process.pid);
  withEnv("/tmp/already-mine-home", mine, () => {
    assert.equal(sandboxStateHome(), "/tmp/already-mine-home");
    assert.equal(process.env[OWNER_VAR], mine);
  });
});

test("home inherited from a parent sandbox process is split per process", () => {
  const root = "/tmp/inherited-root";
  withEnv(root, "999999", () => {
    const dir = sandboxStateHome();
    assert.equal(dir, join(root, `proc-${process.pid}`));
    assert.ok(existsSync(dir), "the per-process slice must be created");
    assert.equal(process.env[HOME_VAR], dir);
    assert.equal(process.env[OWNER_VAR], String(process.pid));
    // Subsequent calls in the same process return the same slice.
    assert.equal(sandboxStateHome(), dir);
  });
});

test("unset home creates a fresh throwaway root owned by this process", () => {
  withEnv(undefined, undefined, () => {
    const dir = sandboxStateHome();
    assert.ok(
      dir.startsWith(join(tmpdir(), "manta-test-home-")),
      `expected a fresh manta-test-home root under the OS temp dir, got ${dir}`,
    );
    assert.ok(existsSync(dir));
    assert.equal(process.env[HOME_VAR], dir);
    assert.equal(process.env[OWNER_VAR], String(process.pid));
    // Idempotent within the process.
    assert.equal(sandboxStateHome(), dir);
  });
});

test("empty-string home is treated as unset; empty owner as no marker", () => {
  withEnv("", "", () => {
    const dir = sandboxStateHome();
    assert.ok(dir.startsWith(join(tmpdir(), "manta-test-home-")));
  });
  withEnv("/tmp/external-empty-owner", "", () => {
    assert.equal(sandboxStateHome(), "/tmp/external-empty-owner");
  });
});
