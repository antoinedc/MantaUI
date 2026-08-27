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
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { statePath } from "../shared/paths.mjs";

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
 * takes no caller input). The script updates the box (git fetch + reset on a
 * checkout, or download+verify+replace on a packaged install), runs
 * `npm ci --omit=dev`, refreshes the opencode tools + agent guidance, then
 * `systemctl --user restart manta-server`; the restart will kill this
 * manta-server process mid-run, so we spawn the child DETACHED and unref()
 * it — never await on exit. The caller (RPC handler in src/server/rpc.mjs)
 * gets the outcome back; the renderer UpdateBar fires this on click.
 *
 * BET-640: early failures (anything before the restart) are knowable — the
 * script writes its output to the state-dir log (`self-update.log`, truncated
 * each run) and exits non-zero before the restart. We watch the child for up
 * to `timeoutMs` (20s default): if it exits non-zero inside that window we
 * resolve `{ ok:false, error: <last line of the log> }`; if it is still
 * running at the timeout (the normal case — it has reached the restart, which
 * killed us in a sibling process) we resolve `{ ok:true }`. The promise always
 * settles within `timeoutMs` regardless of the child's eventual fate.
 *
 * `spawnFile` is injectable for tests; defaults to the real execFileCb (the
 * callback variant, since we DON'T want the promisified form — we need the
 * raw ChildProcess to unref + attach exit listeners). Tests inject a stub
 * whose returned child mimics the relevant surface.
 *
 * @param {string} scriptPath - absolute path to scripts/self-update.sh
 *   (resolved by the RPC handler from `import.meta.url`).
 * @param {(cmd: string, args: string[], opts: { detached?: boolean, stdio?: string }) => { pid?: number, unref: () => void, once?: (ev: string, cb: Function) => void, on?: (ev: string, cb: Function) => void }} [spawnFile]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function runServerSelfUpdate(
  scriptPath,
  spawnFile = execFileCb,
  { timeoutMs = SELF_UPDATE_WATCH_MS, publish } = {},
) {
  const logPath = statePath("self-update.log");
  // NOTE: progress polling below assumes scripts/self-update.sh truncates this
  // log (`: > "$LOG_FILE"`) as one of its first acts, so anything the poller
  // reads belongs to the CURRENT run. If a tick ever landed before that
  // truncation it would latch `highestStep` on the previous run's final step
  // and publish nothing for this one — the bar would stay empty. The script
  // truncates within milliseconds of starting and the first tick is 500ms in,
  // so this is not reachable in practice; it is also benign (no progress bar,
  // i.e. today's behaviour) and self-corrects on the next update. Do NOT
  // "fix" it by truncating here — that destroys the log `lastLogLine` reads
  // to report an early failure.
  try {
    const child = spawnFile(scriptPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    return await new Promise((resolve) => {
      let settled = false;
      // BET progress: while the child runs, tail the log for `MANTA_PROGRESS
      // <step>/<total> <label>` markers and republish each NEW (strictly
      // increasing) step to the bus so the renderer's UpdateBar can render a
      // determinate progress bar. Optional — no `publish`, no polling. Every
      // read is defensive: a missing/unreadable log must never throw.
      let highestStep = 0;
      let pollTimer = null;
      if (typeof publish === "function") {
        pollTimer = setInterval(() => {
          try {
            const text = readFileSync(logPath, "utf8");
            for (const line of text.split(/\r?\n/)) {
              const p = parseProgressLine(line);
              if (p && p.step > highestStep) {
                highestStep = p.step;
                publish({
                  kind: "serverUpdateProgress",
                  payload: { step: p.step, total: p.total, label: p.label },
                });
              }
            }
          } catch {
            // Log not yet written / unreadable — try again next tick.
          }
        }, 500);
        if (typeof pollTimer.unref === "function") pollTimer.unref();
      }
      const clearPoll = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearPoll();
        // Still running at the watch window → it reached the server restart.
        resolve({ ok: true });
      }, timeoutMs);
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearPoll();
        resolve(ok ? { ok: true } : { ok: false, error: lastLogLine(logPath, err) });
      };
      if (typeof child.once === "function") {
        child.once("error", (e) => finish(false, e));
        child.once("exit", (code) => finish(code === 0, code));
      }
    });
  } catch (e) {
    console.warn("[opencodeAdmin] self-update failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const SELF_UPDATE_WATCH_MS = 20_000;

/**
 * Parse a single `MANTA_PROGRESS <step>/<total> <label>` line emitted by
 * scripts/self-update.sh into `{ step, total, label }`, or `null` when the
 * line does not match / is malformed (step out of the 1..total range, total
 * non-positive, non-finite numbers). Pure + tolerant of surrounding
 * whitespace and null/undefined input.
 *
 * @param {unknown} line
 * @returns {{ step: number, total: number, label: string } | null}
 */
export function parseProgressLine(line) {
  const m = /^MANTA_PROGRESS (\d+)\/(\d+) (.+)$/.exec(String(line ?? "").trim());
  if (!m) return null;
  const step = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return null;
  if (step < 1 || step > total) return null;
  return { step, total, label: m[3].trim() };
}

// Strip SGR colour codes and a leading status glyph from a self-update log
// line. The shell helpers in scripts/self-update.sh colour their output and
// prefix a glyph; both are noise once the text is interpolated into the UI
// banner, where "Update failed: ✗ …" reads as a doubled error.
function cleanLogLine(line) {
  return line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^[✗✓!▸]\s*/, "")
    .trim();
}

// Last non-empty line of the self-update log, or a fallback derived from the
// error/exit that triggered the failure report. Never throws.
function lastLogLine(logPath, err) {
  const fallback = err instanceof Error ? err.message : err == null ? "server update failed" : String(err);
  try {
    const lines = readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .map(cleanLogLine)
      .filter((l) => l.length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : fallback;
  } catch {
    return fallback;
  }
}
