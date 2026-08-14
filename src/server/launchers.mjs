// Reports which AI CLI TUI launchers (src/server/launcherRegistry.mjs) are
// currently available on this box, for the session-mode dropdown (BET-138
// refinement, BET-310). "Available" = the binary resolves on PATH.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LAUNCHERS } from "./launcherRegistry.mjs";

const pExecFile = promisify(execFile);

// Run a command through a login shell (`bash -lc` or the user's $SHELL) so it
// sees the user's interactive PATH. launchd and systemd services are handed a
// minimal PATH and tools like `claude`, `gh`, `npm` often live under
// ~/.local/bin or a Homebrew prefix that a bare execFile PATH lookup cannot
// see. Reject on non-zero exit (resolves with `{ stdout, stderr }` on success).
export function runLoginShell(cmd, { timeoutMs = 3000 } = {}) {
  const shell = process.env.SHELL || "bash";
  return pExecFile(shell, ["-lc", cmd], { timeout: timeoutMs });
}

// Resolve a binary on the box PATH. Returns true iff `command -v <bin>` exits
// 0. Runs via the login shell (not a bare execFile PATH lookup) so it matches
// the user's interactive env — `claude` is often installed under
// ~/.local/bin, which a bare spawn's PATH may not include.
export async function binExists(bin) {
  if (!bin || !/^[\w.-]+$/.test(bin)) return false; // guard: no shell metachars
  try {
    await runLoginShell(`command -v ${bin}`);
    return true;
  } catch {
    return false;
  }
}

// The deps object is OPTIONAL: the rpc `launchers:list` channel calls with no
// arguments, and only the unit tests inject a probe.
export async function listAvailableLaunchers({
  binExists: probe = binExists,
} = {}) {
  const out = [];
  for (const l of LAUNCHERS) {
    // Hidden launchers (BET-354 `claude-auth-login`) are programmatic
    // spawn targets the connect card drives — they must NOT appear in
    // the user-facing session-mode dropdown. findLauncher still resolves
    // them so pty:spawn can use them by id.
    if (l.hidden) continue;
    if (!(await probe(l.bin))) continue;
    out.push({
      id: l.id,
      label: l.label,
      flags: (l.flags || []).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        default: f.default,
      })),
    });
  }
  return out; // [{ id, label, flags }], registry order
}
