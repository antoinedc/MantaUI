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
// An already-set MANTA_STATE_HOME is respected, so a caller that wants a
// specific sandbox (or a nested runner) keeps control.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the sandbox directory for this run, creating it on first call.
 * Idempotent: returns the already-chosen directory on subsequent calls, so the
 * two runners and any nested import agree on one location.
 *
 * The directory is intentionally NOT cleaned up: it lives under the OS temp
 * dir, holds only bytes a test wrote, and keeping it makes a failing test's
 * leftovers inspectable. The OS reclaims it.
 */
export function sandboxStateHome() {
  const existing = process.env.MANTA_STATE_HOME;
  if (typeof existing === "string" && existing.trim() !== "") return existing;
  const dir = mkdtempSync(join(tmpdir(), "manta-test-home-"));
  process.env.MANTA_STATE_HOME = dir;
  return dir;
}

// Side effect on import — this module is loaded via `node --import`, which runs
// it before the first test file is evaluated (module-level `statePath(...)`
// constants are therefore computed against the sandbox, not against $HOME).
sandboxStateHome();
