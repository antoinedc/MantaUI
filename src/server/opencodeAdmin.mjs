// opencodeAdmin.mjs — administrative actions against the box's own opencode
// service (BET-123 Part 3, replacing the "opencode:restart" no-op stub).
//
// opencode runs as a systemd --user service (`opencode-serve`), NOT inside a
// tmux session — restarting it is a straight `systemctl --user restart`. This
// is SEPARATE from manta-server itself: restarting opencode does not restart
// manta-server, but it DOES drop every in-flight opencode turn across every
// chat-mode window (config changes like subagent blocks are only re-read at
// opencode startup, so this is the only way to apply them without a manual
// SSH/terminal command).
//
// Security note (documented, not hidden): this hands manta-server the ability
// to bounce a systemd user service on the box it runs on. Acceptable on a
// single-user localhost box — there is no argument interpolation (execFile
// with a fixed argv array, no shell), so there is no injection surface. The
// call is deliberately NOT exposed as an auto-run side effect of any other
// action; it is only ever triggered by an explicit user click behind a
// destructive-action confirm dialog (src/renderer/SubagentsCard.tsx) or the
// existing Providers "restart to apply" flow.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/**
 * Restart the box's opencode service via `systemctl --user restart
 * opencode-serve`. Fixed argv array passed to execFile — never a shell
 * string — so there is no command-injection surface regardless of caller
 * input (there is none: this takes no arguments).
 *
 * `exec` is injectable for tests; defaults to the real execFile (promisified).
 *
 * @param {(cmd: string, args: string[]) => Promise<unknown>} [exec]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function restartOpencode(exec = execFileAsync) {
  try {
    await exec("systemctl", ["--user", "restart", "opencode-serve"]);
    return { ok: true };
  } catch (e) {
    console.warn("[opencodeAdmin] restart failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Trigger the box's self-update script (`scripts/self-update.sh` in the
 * repo root). Fixed argv passed to execFile — never a shell string — so
 * there is no command-injection surface regardless of caller input (this
 * takes no caller input). The script itself does `git fetch + reset --hard
 * origin/main + npm ci --omit=dev + systemctl --user restart manta-server`;
 * the restart will kill this manta-server process mid-run, so we spawn the
 * child DETACHED and unref() it — never await on exit. The caller (RPC
 * handler in src/server/rpc.mjs) gets the child PID back; the renderer
 * UpdateBar fires this on click and the HTTP promise resolves immediately.
 *
 * `spawnFile` is injectable for tests; defaults to the real execFileCb
 * (the callback variant, since we DON'T want the promisified form — we
 * need the raw ChildProcess to unref). Tests inject a stub that records
 * the call.
 *
 * @param {string} scriptPath - absolute path to scripts/self-update.sh
 *   (resolved by the RPC handler from `import.meta.url`).
 * @param {(cmd: string, args: string[], opts: { detached?: boolean, stdio?: string }) => { pid?: number, unref: () => void }} [spawnFile]
 * @returns {Promise<{ ok: true, pid?: number } | { ok: false, error: string }>}
 */
export async function runServerSelfUpdate(scriptPath, spawnFile = execFileCb) {
  try {
    const child = spawnFile(scriptPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    console.warn("[opencodeAdmin] self-update failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
