// Reports which AI CLI TUI launchers (src/server/launcherRegistry.mjs) are
// currently available on this box, for the session-mode dropdown (BET-138
// refinement). "Available" = the binary resolves on PATH AND (if the
// launcher declares a `provider`) opencode reports that provider connected.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LAUNCHERS } from "./launcherRegistry.mjs";

const pExecFile = promisify(execFile);

// Resolve a binary on the box PATH. Returns true iff `command -v <bin>` exits
// 0. Runs via the login shell (not a bare execFile PATH lookup) so it matches
// the user's interactive env — `claude` is often installed under
// ~/.local/bin, which a bare spawn's PATH may not include.
export async function binExists(bin) {
  if (!bin || !/^[\w.-]+$/.test(bin)) return false; // guard: no shell metachars
  try {
    const shell = process.env.SHELL || "bash";
    await pExecFile(shell, ["-lc", `command -v ${bin}`], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// getProviders() -> { all, connected, default }. `connected` is the list of
// provider ids opencode has working auth for.
export async function listAvailableLaunchers({
  binExists: probe = binExists,
  getProviders,
}) {
  const providers = await getProviders().catch(() => ({ connected: [] }));
  const connected = new Set(providers.connected || []);
  const out = [];
  for (const l of LAUNCHERS) {
    // provider === null/undefined means "no provider gate" (pure-CLI launcher).
    const providerOk = l.provider == null || connected.has(l.provider);
    if (!providerOk) continue;
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
