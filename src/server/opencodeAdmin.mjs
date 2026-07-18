// opencodeAdmin.mjs — administrative actions against the box's own opencode
// service (BET-123 Part 3, replacing the "opencode:restart" no-op stub).
//
// opencode runs as a systemd --user service (`opencode-serve`), NOT inside a
// tmux session — restarting it is a straight `systemctl --user restart`. This
// is SEPARATE from bui-server itself: restarting opencode does not restart
// bui-server, but it DOES drop every in-flight opencode turn across every
// chat-mode window (config changes like subagent blocks are only re-read at
// opencode startup, so this is the only way to apply them without a manual
// SSH/terminal command).
//
// Security note (documented, not hidden): this hands bui-server the ability
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
