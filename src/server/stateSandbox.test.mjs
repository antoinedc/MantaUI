// stateSandbox.test.mjs — the canary that keeps the suite off the live box.
//
// Server modules resolve their stores at import time (`const STORE_PATH =
// statePath("auth.json")`). In production that lands in `$HOME/.manta`; under
// the test runners it must land in the throwaway dir that
// scripts/testSandbox.mjs creates and exports through MANTA_STATE_HOME.
//
// This file asserts the WIRING rather than any behaviour, because the wiring is
// what failed: with the stores pointing at `$HOME`, the only protection was
// every test injecting its own I/O, and one auth test that didn't call
// `revoke()` with the real writers deleted `~/.manta/auth.json` and minted a
// fresh box identity on every `npm test` — silently re-keying the maintainer's
// box (whose CI runner is that same machine) and locking every manta-native AI
// tool out of it. If someone drops the `--import ./scripts/testSandbox.mjs`
// flag from package.json, that exposure comes back invisibly. These assertions
// make it come back RED instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sep } from "node:path";
import { stateHome, statePath } from "../shared/paths.mjs";
import { STORE_PATH as AUTH_STORE_PATH } from "./auth.mjs";

test("the test run has a sandboxed state home", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  assert.ok(
    sandbox && sandbox.trim() !== "",
    "MANTA_STATE_HOME is unset — run the suite via `npm test` / `npm run test:server` " +
      "(they pass --import ./scripts/testSandbox.mjs). Without it, any test that " +
      "forgets to inject its I/O reads and WRITES the live box's stores.",
  );
  assert.notEqual(sandbox, homedir(), "the sandbox must not be the real home directory");
  assert.equal(stateHome(), sandbox);
});

test("store paths resolve inside the sandbox, not the live box", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  // The auth store is the one that actually got destroyed, so pin it by name
  // rather than only checking the generic resolver.
  assert.ok(
    AUTH_STORE_PATH.startsWith(sandbox + sep),
    `auth store resolved to ${AUTH_STORE_PATH}, which is outside the sandbox ${sandbox}`,
  );
  assert.ok(!AUTH_STORE_PATH.startsWith(homedir() + sep + ".manta"));
  assert.ok(statePath("secrets.json").startsWith(sandbox + sep));
});
