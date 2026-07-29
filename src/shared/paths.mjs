// paths.mjs — single source of truth for on-disk state directory names AND
// the `~` → `$HOME` expansion used by every caller that takes a user-supplied
// path.
//
// Directory names: every on-box state directory used to be a raw dot-prefixed
// string literal scattered across 20+ files (box server, relay, install
// scripts). That made a rename brittle — a blind find/replace WILL miss one.
// Route every usage through these constants instead of hardcoding the literal.
//
// Layout: everything nests under one top-level dir (~/.manta/) except the
// three call sites that historically had their own top-level dir; those keep
// separate names for now to minimize churn, but still route through here.

import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const STATE_DIRNAME = ".manta";
export const UPLOAD_DIRNAME = ".manta-uploads";
export const OUTBOX_DIRNAME = ".manta-outbox";
export const SECRETS_DIRNAME = ".manta-secrets";

// ---------------------------------------------------------------------------
// Where the state directories live — and how to redirect them
// ---------------------------------------------------------------------------
//
// Every state dir hangs off ONE base, resolved through `stateHome()`. In
// production that base is `os.homedir()` and nothing sets the override, so the
// layout is byte-identical to the old `join(homedir(), STATE_DIRNAME, …)`.
//
// WHY THE OVERRIDE EXISTS. The box's live state (box credentials, secrets,
// schedules, webhooks, tmux ownership, cap jobs) used to be reachable ONLY at
// `$HOME/.manta`, computed at import time, with no way to point it elsewhere.
// The test suite runs as the same user on the same machine as a live box — and
// on this project the CI runner IS the dev box — so the only thing separating a
// unit test from the production store was every test remembering to inject its
// own I/O. That discipline failed exactly once and cost the box its identity:
// an auth test called revoke() with the default writers, which unlinked
// ~/.manta/auth.json and minted a fresh box_id/box_token on every `npm test`
// (see the auth.test.mjs `engine()` helper). auth.json was simply the file that
// got hit first — a forgotten injection in the secrets, schedule or webhook
// tests would have deleted real user data the same way.
//
// So the test runners set MANTA_STATE_HOME to a throwaway directory (see
// scripts/testSandbox.mjs, wired through package.json + vitest.config.ts). A
// test that forgets to inject now writes into the sandbox instead of the live
// box, which turns a silent production-data loss into a no-op.
//
// This is NOT a general "configurable state dir" feature: production must keep
// resolving to $HOME so a stray env var can't silently orphan a box's identity.
// Treat it as a test-isolation seam.
export function stateHome() {
  const override = process.env.MANTA_STATE_HOME;
  return typeof override === "string" && override.trim() !== "" ? override : homedir();
}

// `<stateHome>/.manta/<...parts>` — the box's own state files.
export function statePath(...parts) {
  return join(stateHome(), STATE_DIRNAME, ...parts);
}

// The three dirs that historically sat next to `.manta` rather than inside it.
export function uploadRoot() {
  return join(stateHome(), UPLOAD_DIRNAME);
}

export function outboxRoot() {
  return join(stateHome(), OUTBOX_DIRNAME);
}

export function secretsRoot() {
  return join(stateHome(), SECRETS_DIRNAME);
}

// Leading `~` → os.homedir(); `~/foo` → `<homedir>/foo`. Other strings pass
// through unchanged. Single source of truth — three copies of this used to
// live in tmux.mjs, opencode.mjs and pluginManifest.mjs.
//
// Uses `path.join` (not string concat) so the result uses the platform's
// native separator — byte-identical to the old behaviour on POSIX, and
// correctly avoids `C:\Users\x/foo` mixed separators on Windows.
export function expandTilde(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

// macOS-only PATH prefix. GUI-launched Electron apps don't inherit the
// user's shell PATH on macOS, so Homebrew binaries (npm/npx/pod) are
// invisible to spawn() — prepend them so the spawn succeeds. On every
// other platform we leave PATH alone: Windows uses `;` as the separator
// (so a POSIX prefix corrupts PATH), and on Linux the prefix paths
// usually don't exist anyway.
//
// Single source of truth — used by the desktop plugin runner
// (`src/main/capExecutor.ts`) and the box server's Claude credential
// refresh (`src/server/opencode.mjs`); both processes spawn the same set
// of macOS-only tools.
export const DARWIN_PATH_PREFIX = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Returns a copy of `baseEnv` with the platform's PATH prefix applied.
 *
 * On macOS the prefix is `[/opt/homebrew/bin, /usr/local/bin]`, joined
 * with `path.delimiter` and prepended to the existing PATH — GUI-launched
 * Electron apps and the box server's `systemd --user` service both don't
 * inherit the login shell's PATH, so Homebrew binaries are invisible to
 * spawn() without this. On every other platform the function leaves PATH
 * byte-identical: Windows uses `;` as the separator so a POSIX prefix
 * would corrupt PATH for every child, and even on Linux the prefix paths
 * usually don't exist. The case matters on Windows too — Node usually
 * surfaces the variable as `Path`, and writing a `PATH` key next to an
 * existing `Path` key produces an env with both, which one the child sees
 * is undefined.
 */
export function patchPath(baseEnv, platform) {
  if (platform !== "darwin") {
    // No PATH write at all off macOS — see comment above.
    return { ...baseEnv };
  }
  const existing = baseEnv.PATH ?? process.env.PATH ?? "";
  return {
    ...baseEnv,
    PATH: [...DARWIN_PATH_PREFIX, existing].join(delimiter),
  };
}
