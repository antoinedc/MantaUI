// Long-lived attached PTYs keyed by projectName, exposed over the RPC layer.
//
// This module owns the shared node-pty spawn logic so BOTH the existing
// /pty WebSocket handler (attachPty in index.mjs) and the new pty:* RPC
// channels talk to the same underlying spawn implementation.
//
// PtyEvent shape mirrors src/main/pty.ts (kind field, not type):
//   { kind: "data", projectName: string, data: string }
//   { kind: "exit", projectName: string, code: number | null }
//
// This matches what src/shared/types.ts declares and what Terminal.tsx expects
// (via onPtyEvent / IPC.ptyEvent).

import { spawn as ptySpawnNative } from "node-pty";

// ---------- shared low-level spawn helper ----------
//
// Creates a node-pty that runs `tmux attach-session -t <session>`.
// Optionally selects a specific window index first (WS path uses this).
// Returns the raw IPty object. Does NOT register in the registry.
//
// opts: { session, windowIdx?, cols, rows }
// windowSelectFn: optional (session, windowIdx) => void side-effect before spawn
// (used by the WS path so select-window happens at connect time).

import { spawn as cpSpawn } from "node:child_process";

export function spawnRawPty({ session, windowIdx, cols, rows }) {
  if (windowIdx != null && /^\d+$/.test(String(windowIdx))) {
    cpSpawn("tmux", ["select-window", "-t", `${session}:${windowIdx}`], {
      stdio: "ignore",
    });
  }

  return ptySpawnNative("tmux", ["attach-session", "-t", session], {
    name: "xterm-256color",
    cols: Math.max(20, Math.min(500, Number(cols) || 80)),
    rows: Math.max(5, Math.min(200, Number(rows) || 24)),
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

// ---------- RPC registry ----------
//
// One IPty per projectName. spawn() acts like the desktop spawnPty():
//   - If a pty already exists for projectName, do not tear it down (same
//     behaviour as src/main/pty.ts lines 687-688: "do NOT tear it down").
//   - onEvent(ptyEvent) is called for every data/exit event. The RPC caller
//     passes a closure that forwards to bus.publish.

const ptys = new Map(); // projectName → IPty

/**
 * Spawn (or silently reuse) a pty for opts.projectName.
 * @param {SpawnOptions} opts  { projectName, cols, rows }
 * @param {(e: PtyEvent) => void} onEvent
 */
export function spawn(opts, onEvent) {
  const { projectName, cols, rows } = opts;
  if (!projectName) throw new Error("pty:spawn — projectName required");

  // Mirror desktop: if already exists, do not respawn (avoids disconnect noise).
  if (ptys.has(projectName)) return;

  const pty = spawnRawPty({ session: projectName, cols, rows });
  ptys.set(projectName, pty);

  pty.onData((data) => {
    onEvent({ kind: "data", projectName, data });
  });

  pty.onExit(({ exitCode }) => {
    onEvent({ kind: "exit", projectName, code: exitCode ?? null });
    ptys.delete(projectName);
  });
}

/**
 * Write data to the pty for projectName. No-op if not found (mirror desktop).
 * @param {string} projectName
 * @param {string} data
 */
export function write(projectName, data) {
  ptys.get(projectName)?.write(data);
}

/**
 * Resize the pty for projectName. No-op if not found.
 * @param {string} projectName
 * @param {number} cols
 * @param {number} rows
 */
export function resize(projectName, cols, rows) {
  ptys.get(projectName)?.resize(cols, rows);
}

/**
 * Kill and remove the pty for projectName. Mirror desktop killPty().
 * @param {string} projectName
 */
export function kill(projectName) {
  const p = ptys.get(projectName);
  if (!p) return;
  try { p.kill(); } catch { /* already gone */ }
  ptys.delete(projectName);
}
