// sudoPass.ts — stage / clear the sudo password on the remote box (BET-979).
//
// The public-path install needs root for three commands (install Caddy, write
// its site config, reload it). When the box has password-sudo (not
// passwordless), install.sh uses a SUDO_ASKPASS helper that echoes the
// password from ~/.manta-sudo-pass. That staging is done HERE, from the
// desktop, over TWO separate one-line ssh calls that wrap the install:
//
//   1. before the install:  bash -lc 'umask 077; cat > "$HOME/.manta-sudo-pass"'
//      — the password is written to that ssh child's STDIN (never argv), so
//        it is invisible to `ps` on the box.
//   2. after the install (always):  bash -lc 'rm -f "$HOME/.manta-sudo-pass"'
//
// Rationale this file preserves:
//   - The password is delivered through its own short ssh call, NEVER through
//     the install stream — structurally impossible for it to reach the
//     streamed log (pushTail / send line).
//   - Neither call uses `-tt`, so there is no remote pty echoing the password
//     into any log.
//   - `clearSudoPass` never throws: a failed cleanup must never fail an
//     otherwise-good install.
//
// Both functions go through `execRemote` in runner.ts — the single spawn
// layer. This is the ONLY ssh call that passes stdin (runner.ts's `stdin`
// option); the real install stream is unchanged.

import { execRemote, type SpawnFn } from "./runner.js";
import type { SshTarget } from "../../shared/sshTarget.js";

// The ssh remote commands. Deliberately live in exactly this file so the
// shell strings are unit-testable in one place and never drift from each
// other or from install.sh's SUDO_ASKPASS contract (~/.manta-sudo-pass).
export const WRITE_SUDO_PASS_CMD = `bash -lc 'umask 077; cat > "$HOME/.manta-sudo-pass"'`;
export const CLEAR_SUDO_PASS_CMD = `bash -lc 'rm -f "$HOME/.manta-sudo-pass"'`;

export type SudoPassDeps = {
  /** Inject for tests; defaults to runner's real spawn. */
  spawn?: SpawnFn;
};

/** Stage the sudo password at ~/.manta-sudo-pass on the box, delivered via
 *  stdin (never argv). Returns true on exit code 0. Call this BEFORE
 *  runInstall, after the user answered the sudo-password modal. */
export async function writeSudoPass(
  alias: SshTarget,
  password: string,
  deps: SudoPassDeps = {},
): Promise<boolean> {
  const r = await execRemote(alias, WRITE_SUDO_PASS_CMD, {
    spawn: deps.spawn,
    stdin: password,
    timeoutMs: 30_000,
  });
  return r.code === 0;
}

/** Remove ~/.manta-sudo-pass from the box. Never throws — a failed cleanup
 *  must not fail an otherwise-good install (D1 step 2 "always"). Idempotent:
 *  `rm -f` on a missing file is a no-op. */
export async function clearSudoPass(
  alias: SshTarget,
  deps: SudoPassDeps = {},
): Promise<void> {
  try {
    await execRemote(alias, CLEAR_SUDO_PASS_CMD, {
      spawn: deps.spawn,
      timeoutMs: 15_000,
    });
  } catch {
    // swallow — cleanup is best-effort
  }
}
