import { spawn as cpSpawn } from "node:child_process";

const FS = "\t";

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = cpSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve({ stdout, stderr })
                 : reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
  });
}

export function parseSessions(sessStdout, winStdout) {
  // Phase 1: build ordered session map from list-sessions output.
  const sessions = new Map();
  for (const line of sessStdout.split("\n").filter(Boolean)) {
    const [name, att] = line.split(FS);
    sessions.set(name, { tmuxSession: name, attached: att === "1", windows: [] });
  }
  // Phase 2: join windows into their session. Skip orphan window lines.
  for (const line of winStdout.split("\n").filter(Boolean)) {
    const parts = line.split(FS);
    const [session, index, wname, active, pane, sidRaw] = parts;
    if (!sessions.has(session)) continue; // defensive: orphan
    sessions.get(session).windows.push({
      index: Number(index), name: wname,
      active: active === "1", paneCurrentPath: pane,
      opencodeSessionId: sidRaw ? sidRaw : null,
    });
  }
  return Array.from(sessions.values()).map((s) => ({
    ...s,
    defaultCwd: s.windows[0]?.paneCurrentPath ?? "~",
  }));
}

export async function listProjects() {
  const sessFmt = `#{session_name}${FS}#{?session_attached,1,0}`;
  const winFmt = `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}#{?window_active,1,0}${FS}#{pane_current_path}${FS}#{@bui-session-id}`;
  const sess = await run("tmux", ["list-sessions", "-F", sessFmt]).catch(() => ({ stdout: "" }));
  const wins = await run("tmux", ["list-windows", "-a", "-F", winFmt]).catch(() => ({ stdout: "" }));
  return parseSessions(sess.stdout, wins.stdout);
}

// See src/main/pty.ts:sessionSurvivabilityCmd for the rationale.
// `exit-empty off` keeps the tmux server alive across empty-session moments,
// and `destroy-unattached off` keeps the per-project session pinned after
// the last client detaches — without these, the next "new window" call can
// race against a destroyed target and fail with "can't find session: X".
async function applySessionSurvivability(name) {
  await run("tmux", ["set-option", "-t", name, "exit-empty", "off"]).catch(() => {});
  await run("tmux", ["set-option", "-t", name, "destroy-unattached", "off"]).catch(() => {});
}

// True iff err is the tmux "can't find session" stderr from `run()`'s
// rejection. Pure + exported for testability — mirrors
// `isMissingSessionError` in src/main/pty.ts so the desktop and mobile
// transports have matching auto-heal behaviour.
export function isMissingSessionError(err, sessionName) {
  if (!err || typeof err.message !== "string") return false;
  if (/can.?t find session/i.test(err.message)) return true;
  if (err.message.includes(`session not found: ${sessionName}`)) return true;
  return false;
}

export async function newSession({ name, cwd, windowName }) {
  await run("tmux", ["new-session", "-d", "-s", name, "-c", cwd ?? ".",
    ...(windowName ? ["-n", windowName] : [])]);
  await applySessionSurvivability(name);
  return listProjects();
}
export async function newWindow({ sessionName, windowName, cwd }) {
  try {
    await run("tmux", ["new-window", "-t", sessionName, "-n", windowName,
      ...(cwd ? ["-c", cwd] : [])]);
  } catch (err) {
    // Auto-heal: the project's tmux session vanished between calls
    // (server restart, manual kill, etc.). Recreate it with this window
    // as the first window — see src/main/pty.ts:tmuxNewWindow for the
    // matching desktop-transport branch.
    if (!isMissingSessionError(err, sessionName)) throw err;
    await run("tmux", ["new-session", "-d", "-s", sessionName, "-n", windowName,
      ...(cwd ? ["-c", cwd] : [])]);
    await applySessionSurvivability(sessionName);
  }
  return listProjects();
}

/**
 * Create a new tmux window and return its index (integer).
 * Used by fork/clear composites which need to stamp @bui-session-id on the
 * new window immediately after creation.
 *
 * @param {string} sessionName
 * @param {string} windowName
 * @param {string} [cwd]
 * @returns {Promise<number>} index of the newly created window
 */
export async function newWindowGetIndex(sessionName, windowName, cwd) {
  const { stdout } = await run("tmux", [
    "new-window",
    "-t", sessionName,
    "-n", windowName,
    "-P", "-F", "#{window_index}",
    ...(cwd ? ["-c", cwd] : []),
  ]);
  const idx = Number(stdout.trim());
  if (!Number.isFinite(idx)) {
    throw new Error(`tmux new-window returned unexpected index: ${JSON.stringify(stdout.trim())}`);
  }
  return idx;
}

export async function renameSession({ oldName, newName }) {
  await run("tmux", ["rename-session", "-t", oldName, newName]);
  return listProjects();
}
export async function renameWindow({ sessionName, windowIndex, newName }) {
  await run("tmux", ["rename-window", "-t", `${sessionName}:${windowIndex}`, newName]);
  return listProjects();
}
export async function killSession(sessionName) {
  await run("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  return listProjects();
}
export async function killWindow({ sessionName, windowIndex }) {
  await run("tmux", ["kill-window", "-t", `${sessionName}:${windowIndex}`]).catch(() => {});
  return listProjects();
}
// Propagates errors (unlike the fail-open inline select-window in index.mjs).
export async function selectWindow({ sessionName, windowIndex }) {
  await run("tmux", ["select-window", "-t", `${sessionName}:${windowIndex}`]);
}

/**
 * Stamp (or update) the @bui-session-id user-option on a tmux window.
 * This is how the renderer knows a window is a chat-mode window and which
 * opencode session it belongs to.
 *
 * @param {string} sessionName
 * @param {number} windowIndex
 * @param {string} sessionId   opencode session id (e.g. "ses_...")
 */
export async function restampSessionId(sessionName, windowIndex, sessionId) {
  await run("tmux", [
    "set-window-option",
    "-t", `${sessionName}:${windowIndex}`,
    "@bui-session-id", sessionId,
  ]);
}
