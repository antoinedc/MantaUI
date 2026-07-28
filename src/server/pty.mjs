// Ephemeral, cwd-keyed PTYs (shell-in-cwd Terminal mode, or an AI CLI TUI
// launch mode), exposed over the RPC layer's pty:* channels.
//
// BET-138: this module used to attach to a tmux session (`tmux attach-session`,
// keyed by projectName) for BOTH the /pty WebSocket handler and the pty:* RPC
// channels. The tmux-attach path and the /pty WS handler are gone (manta never
// creates a "claude-TUI" tmux window anymore, so there is nothing to attach
// to). This module now spawns a real shell (or, for a launcher mode, an AI
// CLI like `claude`) directly in the session's working directory. No tmux
// involvement, no scrollback recovery — the PTY dies with the shell/CLI.
//
// PtyEvent shape (kind field, not type):
//   { kind: "data", sessionKey: string, data: string }
//   { kind: "exit", sessionKey: string, code: number | null }
//
// This matches what src/shared/types.ts declares and what Terminal.tsx
// expects (via onPtyEvent / IPC.ptyEvent).

import { spawn as ptySpawnNative } from "node-pty";
import { expandTilde } from "../shared/paths.mjs";
import { findLauncher } from "./launcherRegistry.mjs";
import { tmuxSpawnEnv } from "./tmux.mjs";

// Test-only hook: replace spawnShellPty with a spy/stub so a regression
// test can assert that `spawn(opts, onEvent)` correctly forwards
// `tmuxTarget` to the spawner (BET-348 acceptance criterion: "a non-
// empty `tmuxTarget` reaches `spawnShellPty`"). Without this hook the
// only verifiable path runs through resolvePtyCommand — which proves
// the argv shape but not the wiring. Mirrors _setRun() in tmux.mjs.
let spawnShellPtyImpl = spawnShellPty;
export function _setSpawnShellPty(fn) {
  spawnShellPtyImpl = fn ?? spawnShellPty;
}

// Single-quote a token so it survives a `$SHELL -lc "<cmd>"` re-parse intact.
// Bin names + registry flags are trusted (no user input), but quoting keeps
// this correct if a future launcher arg ever contains a space or metachar.
export function shellQuote(token) {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(token)) return token;
  return `'${String(token).replace(/'/g, `'\\''`)}'`;
}

// Decide what to exec for a pty. Pure — returns { file, args }; the caller
// does the spawning. Exported for testing so the three-way branch can be
// pinned without a live node-pty. `shell` is injected (defaults to the
// server's `$SHELL` or "bash") so tests don't depend on the host env.
//
// Branches (in priority order):
//   1. tmuxTarget set      → `tmux attach-session -t <target>`. Wins over
//                            any `launcher`; attaching is not a launcher
//                            choice (BET-346).
//   2. launcher with a     → `$SHELL -lc "<bin> [args…]>"`. Reproduces the
//      registered def         login-shell PATH the availability probe saw
//                            so AI CLIs at ~/.local/bin/ are reachable.
//   3. fallback            → `$SHELL -l`. Plain interactive login shell.
//                            Unknown launcher ids fall through here too.
export function resolvePtyCommand({ launcher, tmuxTarget, shell }) {
  const effectiveShell = shell || process.env.SHELL || "bash";
  if (tmuxTarget) {
    return { file: "tmux", args: ["attach-session", "-t", tmuxTarget] };
  }
  if (launcher && launcher.id) {
    const def = findLauncher(launcher.id);
    if (def) {
      const args = def.buildArgs(launcher.flags || {});
      const cmd = [def.bin, ...args].map(shellQuote).join(" ");
      return { file: effectiveShell, args: ["-l", "-c", cmd] };
    }
    // Unknown launcher id -> fall through to a plain shell.
  }
  return { file: effectiveShell, args: ["-l"] };
}

// ---------- shared low-level spawn helper ----------
//
// Spawns one of three things (decided by resolvePtyCommand):
//   - `tmux attach-session -t <target>` for a window Manta didn't create
//     (tmuxTarget).
//   - a login shell launching an AI CLI TUI (launcher with a registered def).
//   - a plain interactive login shell (base "terminal" mode).
//
// Ephemeral, no scrollback recovery — the PTY dies with whatever it spawned.
// Returns the raw IPty object. Does NOT register it in the registry below.
//
// opts: { cwd, cols, rows, launcher?, tmuxTarget? }
// launcher, if given: { id: string, flags?: Record<string, boolean> }.
// tmuxTarget, if given: "<session>:<windowIndex>" — the exact format
//   killWindow/selectWindow/renameWindow in src/server/tmux.mjs already use.
// Unknown launcher ids fall through to a plain shell (defensive — e.g. a
// stale localStorage mode referencing a launcher that no longer exists).
export function spawnShellPty({ cwd, cols, rows, launcher, tmuxTarget }) {
  const dir = expandTilde(cwd && cwd.trim() ? cwd : "~");
  const size = {
    name: "xterm-256color",
    cwd: dir,
    cols: Math.max(20, Math.min(500, Number(cols) || 80)),
    rows: Math.max(5, Math.min(200, Number(rows) || 24)),
    env: { ...process.env, TERM: "xterm-256color" },
  };

  const shell = process.env.SHELL || "bash";
  const { file, args } = resolvePtyCommand({ launcher, tmuxTarget, shell });

  // Env is selected per branch (matches the three cases in resolvePtyCommand):
  //  - tmux attach: tmuxSpawnEnv() supplies the UTF-8 locale tmux needs —
  //    without it tmux mangles its own -F output under a non-UTF-8 locale
  //    (see AGENTS.md, "A service gets no LOCALE").
  //  - login shell with `-lc <cmd>` launcher: non-interactive, so the
  //    user's rc file cannot trigger an auto-attach block — no
  //    MANTA_TERMINAL needed.
  //  - plain interactive login shell: MANTA_TERMINAL=1 so a user's rc
  //    file can skip a tmux auto-attach block that would otherwise hijack
  //    this shell into a blank tmux alternate-screen.
  const env = tmuxTarget
    ? { ...tmuxSpawnEnv(), TERM: "xterm-256color" }
    : launcher && launcher.id && findLauncher(launcher.id)
      ? size.env
      : { ...size.env, MANTA_TERMINAL: "1" };

  return ptySpawnNative(file, args, { ...size, env });
}

// ---------- RPC registry ----------
//
// One IPty per sessionKey. The caller composes sessionKey as
// `${opencodeSessionId}:${modeId}` (modeId = "terminal" or a launcher id) so
// Terminal mode and each TUI launcher mode of the same chat session get
// independent, kept-warm PTYs.
//   - If a pty already exists for sessionKey, do NOT tear it down (avoids
//     disconnect noise on remount; the incoming onEvent is dropped).
//   - onEvent(ptyEvent) is called for every data/exit event. The RPC caller
//     passes a closure that forwards to bus.publish.

const ptys = new Map(); // sessionKey → IPty

/**
 * Spawn (or silently reuse) a shell/launcher pty for opts.sessionKey.
 * @param {{ sessionKey: string, cwd: string, cols: number, rows: number, launcher?: { id: string, flags?: Record<string, boolean> }, tmuxTarget?: string }} opts
 * @param {(e) => void} onEvent
 */
export function spawn(opts, onEvent) {
  const { sessionKey, cwd, cols, rows, launcher, tmuxTarget } = opts;
  if (!sessionKey) throw new Error("pty:spawn — sessionKey required");

  // Mirror desktop: if already exists, do not respawn (avoids disconnect
  // noise on remount). The incoming onEvent is intentionally dropped on this
  // reuse path — safe ONLY because every caller passes the same sink
  // (bus.publish, a module singleton).
  if (ptys.has(sessionKey)) return;

  const pty = spawnShellPtyImpl({ cwd, cols, rows, launcher, tmuxTarget });
  ptys.set(sessionKey, pty);

  pty.onData((data) => {
    onEvent({ kind: "data", sessionKey, data });
  });

  pty.onExit(({ exitCode }) => {
    onEvent({ kind: "exit", sessionKey, code: exitCode ?? null });
    ptys.delete(sessionKey);
  });
}

/**
 * Write data to the pty for sessionKey. No-op if not found (mirror desktop).
 * @param {string} sessionKey
 * @param {string} data
 */
export function write(sessionKey, data) {
  ptys.get(sessionKey)?.write(data);
}

/**
 * Resize the pty for sessionKey. No-op if not found.
 * @param {string} sessionKey
 * @param {number} cols
 * @param {number} rows
 */
export function resize(sessionKey, cols, rows) {
  ptys.get(sessionKey)?.resize(cols, rows);
}

/**
 * Kill and remove the pty for sessionKey. Mirror desktop killPty().
 * @param {string} sessionKey
 */
export function kill(sessionKey) {
  const p = ptys.get(sessionKey);
  if (!p) return;
  try { p.kill(); } catch { /* already gone */ }
  ptys.delete(sessionKey);
}
