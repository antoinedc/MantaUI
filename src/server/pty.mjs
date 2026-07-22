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
import { expandTilde } from "./opencode.mjs";
import { findLauncher } from "./launcherRegistry.mjs";

// Single-quote a token so it survives a `$SHELL -lc "<cmd>"` re-parse intact.
// Bin names + registry flags are trusted (no user input), but quoting keeps
// this correct if a future launcher arg ever contains a space or metachar.
export function shellQuote(token) {
  if (/^[A-Za-z0-9._/@:=+-]+$/.test(token)) return token;
  return `'${String(token).replace(/'/g, `'\\''`)}'`;
}

// ---------- shared low-level spawn helper ----------
//
// Spawns either a login shell (no launcher) OR an AI CLI TUI (launcher given)
// in `cwd`. Ephemeral, no tmux. Returns the raw IPty object. Does NOT
// register it in the registry below.
//
// opts: { cwd, cols, rows, launcher? }
// launcher, if given: { id: string, flags?: Record<string, boolean> }.
// Unknown launcher ids fall through to a plain shell (defensive — e.g. a
// stale localStorage mode referencing a launcher that no longer exists).
export function spawnShellPty({ cwd, cols, rows, launcher }) {
  const dir = expandTilde(cwd && cwd.trim() ? cwd : "~");
  const size = {
    name: "xterm-256color",
    cwd: dir,
    cols: Math.max(20, Math.min(500, Number(cols) || 80)),
    rows: Math.max(5, Math.min(200, Number(rows) || 24)),
    env: { ...process.env, TERM: "xterm-256color" },
  };

  const shell = process.env.SHELL || "bash";

  if (launcher && launcher.id) {
    const def = findLauncher(launcher.id);
    if (def) {
      const args = def.buildArgs(launcher.flags || {});
      // Run the CLI through a LOGIN shell (`$SHELL -lc "<cmd>"`), NOT a bare
      // execFile of the binary. The availability probe in launchers.mjs uses
      // `command -v` inside a login shell, so a launcher only ever appears in
      // the dropdown when it resolves in the interactive PATH (claude lives at
      // ~/.local/bin/claude, which is NOT on the systemd --user service PATH).
      // Spawning the bin directly would inherit the server's bare PATH and
      // exit immediately (127 → surfaced to the user as "[shell exited: 1]").
      // The login shell reproduces the same PATH the probe saw, so the CLI is
      // found. When it exits, the login shell exits, so the PTY still dies with
      // the CLI (ephemeral lifecycle preserved).
      const cmd = [def.bin, ...args].map(shellQuote).join(" ");
      return ptySpawnNative(shell, ["-l", "-c", cmd], size);
    }
    // Unknown launcher id -> fall through to a plain shell.
  }

  // Plain shell-in-cwd (base "terminal" mode): an interactive LOGIN shell.
  // MANTA_TERMINAL=1 marks this as a manta embedded terminal so a user's rc file
  // can skip hostile interactive-login behaviour — notably a tmux auto-attach
  // block (common in ~/.bashrc), which would otherwise hijack this shell into a
  // blank tmux alternate-screen and the terminal would look frozen/empty. The
  // login launcher path above is unaffected: it's `-lc <cmd>` (non-interactive)
  // so it never triggers such blocks.
  return ptySpawnNative(shell, ["-l"], {
    ...size,
    env: { ...size.env, MANTA_TERMINAL: "1" },
  });
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
 * @param {{ sessionKey: string, cwd: string, cols: number, rows: number, launcher?: { id: string, flags?: Record<string, boolean> } }} opts
 * @param {(e) => void} onEvent
 */
export function spawn(opts, onEvent) {
  const { sessionKey, cwd, cols, rows, launcher } = opts;
  if (!sessionKey) throw new Error("pty:spawn — sessionKey required");

  // Mirror desktop: if already exists, do not respawn (avoids disconnect
  // noise on remount). The incoming onEvent is intentionally dropped on this
  // reuse path — safe ONLY because every caller passes the same sink
  // (bus.publish, a module singleton).
  if (ptys.has(sessionKey)) return;

  const pty = spawnShellPty({ cwd, cols, rows, launcher });
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
