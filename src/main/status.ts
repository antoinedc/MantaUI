import type { BrowserWindow } from "electron";
import { IPC, type AppConfig, type WindowStatus } from "../shared/types.js";
import { runSshOnce } from "./pty.js";

// Per-window activity poller.
//
// Every ~2s, we ask the remote for the last N lines of every tmux pane in one
// SSH call (cheap thanks to ControlMaster), then look for claude's busy markers
// to decide running / subagent count. This is the only way to know activity in
// windows the user isn't currently attached to — xterm only sees the focused
// window's stream.
//
// Detection is heuristic. `esc to interrupt` has been a stable string in
// claude's TUI footer for a long time but it is not a contract; if it changes
// the indicator will go dark and we'll need to update the patterns.

const POLL_MS = 2000;
const CAPTURE_LINES = 40;

// Tag every pane chunk with a marker that won't appear inside captured terminal
// content. capture-pane -p strips ANSI escapes, so plain text only.
const MARK = "__BUI_PANE__";

// One SSH call. List every window using tmux's native `session:index` target
// syntax (session names cannot contain `:`), then capture the last N lines of
// each pane. `|| true` swallows transient "window not found" if a window was
// just killed between list and capture.
const REMOTE_CMD =
  `tmux list-windows -a -F '#{session_name}:#{window_index}' 2>/dev/null | ` +
  `while read t; do ` +
  `printf '\\n${MARK}%s${MARK}\\n' "$t"; ` +
  // No pane suffix: tmux picks the active pane in the window. Hardcoding `.0`
  // breaks when pane-base-index is 1, which is a common ~/.tmux.conf setting.
  `tmux capture-pane -t "$t" -p -S -${CAPTURE_LINES} 2>/dev/null || true; ` +
  `done`;

// Patterns. Kept narrow on purpose — false positives would lie to the user
// about which windows are doing work.
//
// Claude's live status line looks like one of:
//   ✻ Ruminating… (27s · still thinking)
//   * Ruminating… (29s · still thinking)      <- ascii fallback frame
//   ✳ Cogitating… (12s · ↑ 1.2k tokens)
// i.e. spinner glyph + verb-with-Unicode-ellipsis + parens with seconds.
//
// After it finishes, the same line becomes:
//   ✻ Cogitated for 39s
//   ✻ Sautéed for 5s
// (past tense verb, no ellipsis, no parens) — requiring `…` distinguishes
// live from done.
//
// The spinner must also be at column 0. Claude indents every other transcript
// piece (assistant messages get `● ` then `  ` continuation, code blocks are
// indented, the input box content is padded). The only thing rendered flush
// left in the alt screen is the live status indicator itself — so anchoring
// to ^ keeps a literal example like `✻ Ruminating… (27s · still thinking)`
// inside a chat message from triggering us.
// Duration inside the parens can be `10s`, `1m 57s`, `7m 1s`, `2h 30m 1s`,
// etc. — claude renders the full breakdown. So instead of constraining the
// number shape, we just require `(` … `·` … `)` somewhere on the same line,
// where the `·` is the separator before the rest of the status fields.
const BUSY_RE = /^[✻✳✶✽✢·*]\s+\S+…[^\n]*\([^)\n]+·[^)\n]*\)/mu;
// Subagents are specifically the `Task` tool — its in-flight render looks like:
//   ● Task(some description)
//     ⎿  Running…
// Other tools (Bash, Read, Grep, etc.) also briefly render `⎿  Running…`
// between command-issued and result-received, which our 2s poll occasionally
// catches and would otherwise count as a "subagent". To avoid that flash, we
// only count `⎿  Running…` lines whose preceding non-blank line is a
// `Task(...)` header.
// Anchored to column 0 — same reason as BUSY_RE: claude renders real tool
// headers flush left, while transcript content (assistant messages, code
// blocks, bullet lists) is always indented by at least 2 spaces. Without
// the anchor, my own chat text mentioning `● Task(...)` self-triggers.
const TASK_HEADER_RE = /^●\s+Task\(/;
const TASK_RUNNING_RE = /⎿\s+Running…/;

function countSubagents(body: string): number {
  const lines = body.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!TASK_HEADER_RE.test(lines[i])) continue;
    // Walk forward up to ~3 lines looking for `⎿  Running…`. Stop at any
    // other `⎿` line — that means this Task already produced output and is
    // no longer in flight.
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (TASK_RUNNING_RE.test(lines[j])) {
        count++;
        break;
      }
      if (lines[j].includes("⎿")) break;
    }
  }
  return count;
}

function parseStatus(stdout: string): WindowStatus[] {
  const out: WindowStatus[] = [];
  // Split on marker. Each header chunk is `<session>:<index>`, followed by the
  // pane body chunk. Odd indices in the split are headers, even are bodies.
  const parts = stdout.split(MARK);
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i];
    const body = parts[i + 1] ?? "";
    // session names can contain anything except `:`; rsplit on the last `:`.
    const colon = header.lastIndexOf(":");
    if (colon < 0) continue;
    const session = header.slice(0, colon);
    const idxStr = header.slice(colon + 1).trim();
    const windowIndex = Number(idxStr);
    if (!Number.isFinite(windowIndex)) continue;

    const busyMatch = body.match(BUSY_RE);
    const running = busyMatch !== null;

    const subagents = countSubagents(body);

    void busyMatch;
    out.push({ session, windowIndex, running, subagents });
  }
  return out;
}

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit(win: BrowserWindow, batch: WindowStatus[]): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.statusEvent, batch);
}

async function tick(win: BrowserWindow, config: AppConfig): Promise<void> {
  if (inFlight) return;
  if (!config.host) return;
  inFlight = true;
  try {
    const { stdout } = await runSshOnce(config, REMOTE_CMD);
    const batch = parseStatus(stdout);
    emit(win, batch);
  } catch (e) {
    console.warn("[status] tick failed:", (e as Error).message);
  } finally {
    inFlight = false;
  }
}

export function startStatusPoller(
  win: BrowserWindow,
  getConfig: () => AppConfig,
): void {
  stopStatusPoller();
  // Fire one immediately so the sidebar fills in without waiting 2s.
  void tick(win, getConfig());
  interval = setInterval(() => void tick(win, getConfig()), POLL_MS);
}

export function stopStatusPoller(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
