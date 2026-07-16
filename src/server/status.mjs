// Per-window activity poller for the mobile server.
//
// Ports src/main/status.ts to local tmux execution (no SSH hop — this process
// IS the remote). Every ~2s we capture the last N lines of every tmux pane in
// one tmux pass, detect claude's busy markers, and publish a WindowStatus[]
// batch on the event bus so mobile sidebar dots work.
//
// Detection heuristic is identical to the desktop: BUSY_RE looks for claude's
// live status line (spinner glyph + verb + ellipsis + parenthesised duration),
// countSubagents looks for Task(…) followed by ⎿  Running… within 3 lines.

import { run } from "./tmux.mjs";

const POLL_MS = 2000;
const CAPTURE_LINES = 40;
const CAPTURE_CONCURRENCY = 8;

// Sentinel that won't appear in captured terminal content (ANSI-stripped text).
export const MARK = "__MANTA_PANE__";

// Patterns — kept identical to src/main/status.ts.
//
// Live status line: spinner glyph at column 0, word+ellipsis, then (…·…).
// Anchored to ^ so indented copies inside chat messages don't trigger us.
const BUSY_RE = /^[✻✳✶✽✢·*]\s+\S+…[^\n]*\([^)\n]+·[^)\n]*\)/mu;

// Task subagent in-flight: header must be flush-left, Running… follows within 3 lines.
const TASK_HEADER_RE = /^●\s+Task\(/;
const TASK_RUNNING_RE = /⎿\s+Running…/;

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing.
// ---------------------------------------------------------------------------

export function countSubagents(body) {
  const lines = body.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!TASK_HEADER_RE.test(lines[i])) continue;
    // Walk forward up to ~3 lines looking for ⎿  Running…. Stop at any other
    // ⎿ line — that means this Task already produced output and is no longer
    // in-flight.
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

export function parseStatus(stdout) {
  const out = [];
  // Split on marker. Odd indices are headers "<session>:<windowIndex>",
  // even indices (following each header) are pane body text.
  const parts = stdout.split(MARK);
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i];
    const body = parts[i + 1] ?? "";
    // session names cannot contain ':'; use lastIndexOf to be safe.
    const colon = header.lastIndexOf(":");
    if (colon < 0) continue;
    const session = header.slice(0, colon);
    const idxStr = header.slice(colon + 1).trim();
    const windowIndex = Number(idxStr);
    if (!Number.isFinite(windowIndex)) continue;

    const running = BUSY_RE.test(body);
    const subagents = countSubagents(body);

    out.push({ session, windowIndex, running, subagents });
  }
  return out;
}

// ---------------------------------------------------------------------------
// I/O — build the tmux command sequence and collect captured output.
// ---------------------------------------------------------------------------

// Enumerate all windows (session:index), then capture each pane's last N
// lines, bracketed by MARK sentinels so parseStatus can demux them.
//
// Desktop does this in one shell pipeline over SSH; here we can't do that
// in a single run() call (no shell). Instead:
//   1. list-windows -a  → "session\twindowIndex" lines
//   2. capture-pane -p -S -N for each window, bounded-concurrency parallel
//      (CAPTURE_CONCURRENCY workers), results reassembled in `targets` order
//      so parseStatus's MARK-delimited demux stays stable regardless of
//      which capture resolves first.

export async function collectPanes(runFn = run) {
  // Step 1: list all windows.
  let winStdout;
  try {
    const r = await runFn("tmux", [
      "list-windows", "-a",
      "-F", "#{session_name}:#{window_index}",
    ]);
    winStdout = r.stdout;
  } catch {
    // No tmux server running or no sessions — return empty.
    return "";
  }

  const targets = winStdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (targets.length === 0) return "";

  // Step 2: capture each pane, bounded-concurrency parallel. Results are
  // written into an index-aligned array, not pushed as promises resolve, so
  // the final join is always in `targets` order.
  const captured = new Array(targets.length).fill("");
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      try {
        const r = await runFn("tmux", [
          "capture-pane",
          "-t", targets[i],
          "-p",
          "-S", String(-CAPTURE_LINES),
        ]);
        captured[i] = r.stdout;
      } catch {
        // Window may have been killed between list and capture — skip it.
        captured[i] = "";
      }
    }
  }
  const poolSize = Math.min(CAPTURE_CONCURRENCY, targets.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const chunks = [];
  for (let i = 0; i < targets.length; i++) {
    chunks.push(`\n${MARK}${targets[i]}${MARK}\n`);
    chunks.push(captured[i]);
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Poller lifecycle.
// ---------------------------------------------------------------------------

/**
 * Start the status poller. Returns a stop() function.
 *
 * @param {object} bus       - event bus with .publish({ kind, payload })
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=2000]
 * @returns {{ stop: () => void }}
 */
export function startStatusPoller(bus, { intervalMs = POLL_MS } = {}) {
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const stdout = await collectPanes();
      const batch = parseStatus(stdout);
      bus.publish({ kind: "status", payload: batch });
    } catch (e) {
      // Defensive: collectPanes already absorbs tmux errors; this catches
      // anything else (e.g. bus.publish throwing) without crashing the process.
      console.warn("[status] tick failed:", e?.message ?? e);
    } finally {
      inFlight = false;
    }
  }

  // Fire one tick immediately so the sidebar fills in without waiting intervalMs.
  void tick();

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't hold the process open for the poller alone (mirrors events.mjs keep-alive).
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
