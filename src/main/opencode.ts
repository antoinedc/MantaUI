// opencode integration — SSH-mode helpers still needed by pty.ts (M2-T2.3).
//
// The desktop in http mode talks to bui-server over /rpc + /events; this file
// only exists because pty.ts (Stage 2.3) still boots opencode and creates
// sessions over SSH. All other opencode IPC (listMessages, sendPrompt, SSE
// subscription, permissions, questions, models, sessions, commands, agents,
// findFiles, etc.) lives on the server and is reached by the renderer via
// httpApi — the main-process SSH-backed handlers were removed in BET-101.
//
// Auth: server binds 127.0.0.1 on the remote; the SSH command reaches it
// directly. No OPENCODE_SERVER_PASSWORD configured.

import {
  runSshOnce,
  expandRemotePath,
} from "./pty.js";
import type { AppConfig } from "../shared/types.js";

const REMOTE_PORT = 4096;
export const BUI_OPENCODE_TMUX_SESSION = "bui-opencode";
export const OPENCODE_SID_OPT = "@bui-session-id";

// ===== server lifecycle =====

export async function ensureRunning(config: AppConfig): Promise<void> {
  const { stdout } = await runSshOnce(
    config,
    `if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${REMOTE_PORT}/global/health; then echo healthy; ` +
    `elif tmux has-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null; then echo stale; ` +
    `else echo down; fi`,
  );
  const state = stdout.trim();
  if (state === "healthy") return;

  if (state === "stale") {
    await runSshOnce(
      config,
      `tmux kill-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null || true`,
    );
  }

  const startCmd =
    `tmux new-session -d -s ${BUI_OPENCODE_TMUX_SESSION} ` +
    `'bash -c "export PATH=\\$HOME/.opencode/bin:\\$PATH; ` +
    `opencode serve --port ${REMOTE_PORT} --hostname 127.0.0.1"'`;
  await runSshOnce(config, startCmd);

  await runSshOnce(
    config,
    `for i in $(seq 1 30); do ` +
    `  curl -fsS -o /dev/null http://127.0.0.1:${REMOTE_PORT}/global/health && exit 0; ` +
    `  sleep 1; ` +
    `done; exit 1`,
  );
}

// ===== Per-session project-directory scope =====

const sessionDirectoryCache = new Map<string, string>();

// Repair the `/home/<user>/~/...` corruption that opencode persists when a
// session was created (pre-createSession-fix) with a tilde directory: it
// naively joins its cwd ($HOME) with the literal `~/...`, yielding a path
// that does not exist on disk. Every prompt then scopes to that dead path
// and the turn hangs. The fix at createSession stops NEW corruption; this
// repairs sessions ALREADY persisted corrupt, applied at the cache-ingestion
// chokepoint so a stale `?directory=` is never emitted. Pure + exported for
// tests. Collapses a `/~/` segment; leaves clean paths untouched.
export function repairCorruptDirectory(directory: string): string {
  const idx = directory.indexOf("/~/");
  return idx === -1 ? directory : directory.slice(0, idx) + directory.slice(idx + 2);
}

function rememberSessionDirectory(
  sessionId: string,
  directory: string | undefined | null,
): void {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) {
    return;
  }
  directory = repairCorruptDirectory(directory);
  sessionDirectoryCache.set(sessionId, directory);
}

// Test-only: reset cache between scenarios.
export function _resetSessionDirectoryCache(): void {
  sessionDirectoryCache.clear();
}

export async function createSession(
  config: AppConfig,
  directory: string,
  title: string,
): Promise<{ id: string; title: string; directory: string; projectID: string }> {
  const absDir = directory.startsWith("~")
    ? await expandRemotePath(config, directory)
    : directory;
  const { stdout } = await runSshOnce(
    config,
    `curl -s -X POST 'http://127.0.0.1:${REMOTE_PORT}/session?directory=${encodeURIComponent(absDir)}' ` +
    `-H 'content-type: application/json' -d '${JSON.stringify({ title }).replace(/'/g, "'\\''")}'`,
  );
  const sess = JSON.parse(stdout) as { id: string; directory?: string };
  rememberSessionDirectory(sess.id, sess.directory ?? absDir);
  return {
    id: sess.id,
    title,
    directory: sess.directory ?? absDir,
    projectID: "",
  };
}
