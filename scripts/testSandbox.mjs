// testSandbox.mjs — point the box's state directories at a throwaway dir for
// the duration of a test run.
//
// WHY THIS EXISTS. The suite runs as the same user, on the same machine, as a
// live box — and this project's CI runner IS the maintainer's dev box. Every
// server module resolves its store from `$HOME` (`~/.manta/auth.json`,
// `~/.manta/secrets.json`, `~/.manta/schedule.json`, …), so the ONLY thing that
// kept a unit test from writing the production store was each test remembering
// to inject its own I/O. That held until it didn't: an auth test called
// `revoke()` with the default writers, which deletes `~/.manta/auth.json` and
// mints a fresh box identity — so every `npm test` silently re-keyed the box,
// locking every manta-native AI tool out of it while the already-paired UI kept
// working (the server holds the old token in memory). See src/shared/paths.mjs.
//
// Injection discipline is still correct and still expected — this is the layer
// UNDER it, so that forgetting it costs a confusing test failure instead of a
// production credential wipe. It is deliberately a blunt instrument: one env
// var, set before any module is imported, honored by `stateHome()`.
//
// Wiring (both runners, because both can import server modules):
//   • node:test  — `node --import ./scripts/testSandbox.mjs --test …`
//                  (--import runs this before any test file is loaded)
//   • vitest     — `vitest.config.ts` calls `sandboxStateHome()` and passes the
//                  result through `test.env`, which vitest injects into every
//                  worker before the test module is evaluated.
//
// PER-PROCESS ISOLATION (BET-1493). `node --test` runs each test file as its
// own concurrent process, and the runner hands every child the coordinator's
// full environment (`env: { ...process.env, … }` in the runner's spawn). When
// the coordinator ran this preload first — the node 20 behavior, which is what
// CI pins via setup-node — every child therefore saw the ALREADY-SET
// MANTA_STATE_HOME and reused it, so all concurrent test-file processes shared
// ONE sandbox and raced on the same stores (e.g. the cto ledger): a test
// asserting exact ledger contents intermittently observed rows appended by a
// different file's process. Newer runners (node ≥ 22) spawn children before
// their own `--import` preload evaluates, so each child created a fresh root —
// masking the race locally.
//
// So the home is per-process: the module marks the home it created with
// MANTA_STATE_HOME_OWNER (the creating pid). A process that inherits a home
// marked by a DIFFERENT pid subdivides it — `<inherited root>/proc-<pid>` —
// so every test-file process gets its own slice of the throwaway tree while
// the whole run stays under one inspectable root. A home with NO owner marker
// is treated as an explicit external choice and shared as-is, so a caller that
// wants a specific sandbox (or a nested runner, like vitest.config.ts
// injecting one home into its workers) keeps control.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_VAR = "MANTA_STATE_HOME";
const OWNER_VAR = "MANTA_STATE_HOME_OWNER";

/**
 * Resolve the sandbox directory for this process, creating it on first call.
 * Idempotent: returns the already-chosen directory on subsequent calls in the
 * same process, so the two runners and any nested import agree on one location.
 *
 * The directory tree is intentionally NOT cleaned up: it lives under the OS
 * temp dir, holds only bytes a test wrote, and keeping it makes a failing
 * test's leftovers inspectable. The OS reclaims it.
 */
export function sandboxStateHome() {
  const existing = process.env[HOME_VAR];
  const owner = process.env[OWNER_VAR];

  if (typeof existing === "string" && existing.trim() !== "") {
    const inheritedFromOther =
      typeof owner === "string" && owner.trim() !== "" && owner !== String(process.pid);
    if (!inheritedFromOther) return existing;

    // Inherited from a parent sandbox process (the node:test coordinator) —
    // carve out this process's own slice so concurrent test files never share
    // stores (BET-1493). Stays under the run's throwaway root.
    const dir = join(existing, `proc-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    process.env[HOME_VAR] = dir;
    process.env[OWNER_VAR] = String(process.pid);
    return dir;
  }

  const dir = mkdtempSync(join(tmpdir(), "manta-test-home-"));
  process.env[HOME_VAR] = dir;
  process.env[OWNER_VAR] = String(process.pid);
  return dir;
}

// Side effect on import — this module is loaded via `node --import`, which runs
// it before the first test file is evaluated (module-level `statePath(...)`
// constants are therefore computed against the sandbox, not against $HOME).
sandboxStateHome();
