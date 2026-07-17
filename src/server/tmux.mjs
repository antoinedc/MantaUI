import { spawn as cpSpawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const FS = "\t";

// Expand a leading ~ against this process's $HOME. The mobile server runs ON
// the box, so a `~/projects/x` cwd is a real local path here. Without this a
// literal mkdir("~/projects/x") would create a directory named "~" — the same
// tilde-corruption chokepoint documented for opencode session.create. Mirrors
// expandTilde in src/server/opencode.mjs (kept local — that one isn't exported).
export function expandTildePath(p) {
  if (typeof p !== "string" || !p.startsWith("~")) return p;
  const home = homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + "/" + p.slice(2);
  return p; // ~user form — leave for the shell, not ours to guess
}

function spawnRun(cmd, args) {
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

// The transport every tmux command dispatches through. Production = spawnRun
// (real child_process). Tests swap in a fake `(cmd, args) => Promise<{stdout,
// stderr}>` via `_setRun` so the chat-mode branch (which calls tmux new-window
// + set-window-option) is unit-testable without a live tmux server. Mirrors
// the `_setOcTransport` pattern in src/server/opencode.mjs.
let runImpl = spawnRun;

export function run(cmd, args) {
  return runImpl(cmd, args);
}

/** Test-only: override the tmux command transport. Pass null to restore. */
export function _setRun(fn) {
  runImpl = fn ?? spawnRun;
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
  const winFmt = `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}#{?window_active,1,0}${FS}#{pane_current_path}${FS}#{@manta-session-id}`;
  const sess = await run("tmux", ["list-sessions", "-F", sessFmt]).catch(() => ({ stdout: "" }));
  const wins = await run("tmux", ["list-windows", "-a", "-F", winFmt]).catch(() => ({ stdout: "" }));
  return parseSessions(sess.stdout, wins.stdout);
}

// Chat-mode windows don't run a TUI — bui renders its own React ChatPanel
// into the slot. The tmux pane just holds the window alive so the existing
// project/window model still works. `sleep infinity` exits cleanly when the
// window is killed (no zombies) and consumes no CPU.
export const CHAT_HOLDER_CMD = "sleep infinity";

// `exit-empty off` keeps the tmux server alive across empty-session moments,
// and `destroy-unattached off` keeps the per-project session pinned after
// the last client detaches — without these, the next "new window" call can
// race against a destroyed target and fail with "can't find session: X".
async function applySessionSurvivability(name) {
  await run("tmux", ["set-option", "-t", name, "exit-empty", "off"]).catch(() => {});
  await run("tmux", ["set-option", "-t", name, "destroy-unattached", "off"]).catch(() => {});
}

// True iff err is the tmux "can't find session" stderr from `run()`'s
// rejection. Pure + exported for testability — desktop (over HTTPS) and
// mobile transports both rely on the same auto-heal behaviour.
export function isMissingSessionError(err, sessionName) {
  if (!err || typeof err.message !== "string") return false;
  if (/can.?t find session/i.test(err.message)) return true;
  if (err.message.includes(`session not found: ${sessionName}`)) return true;
  return false;
}

// For chat-mode: create an opencode session in `cwd` and return its id;
// non-chat is a no-op returning null. Centralised so the new-session and
// new-window paths stay aligned. `oc` is the src/server/opencode.mjs
// namespace, injected by the rpc handler (kept as a param so tmux.mjs stays
// dependency-injected + unit-testable). opencode is LOCAL to this box.
// `oc.createSession` expands a leading `~` itself (see expandTilde in
// opencode.mjs), so the tilde-corruption chokepoint is already covered there.
async function maybeCreateChatSession(oc, chatMode, cwd, title) {
  if (!chatMode) return null;
  if (!oc || typeof oc.createSession !== "function") {
    throw new Error("chat mode requires an opencode client (oc.createSession)");
  }
  const sess = await oc.createSession({ directory: cwd, title });
  return sess.id;
}

// Create the tmux window with an explicit index-returning form. For chat-mode
// we launch the holder pane (`sleep infinity`) instead of the default shell so
// the pane is inert under bui's overlaid ChatPanel; for non-chat we launch the
// default shell (no trailing command).
async function newWindowGetIndexInternal(sessionName, windowName, cwd, chatMode) {
  const { stdout } = await run("tmux", [
    "new-window",
    "-t", sessionName,
    "-n", windowName,
    "-P", "-F", "#{window_index}",
    ...(cwd ? ["-c", cwd] : []),
    ...(chatMode ? ["sh", "-c", CHAT_HOLDER_CMD] : []),
  ]);
  const idx = Number(stdout.trim());
  if (!Number.isFinite(idx)) {
    throw new Error(`tmux new-window returned unexpected index: ${JSON.stringify(stdout.trim())}`);
  }
  return idx;
}

// Create a session and return the index of its initial window.
async function newSessionGetIndex(name, cwd, windowName, chatMode) {
  const { stdout } = await run("tmux", [
    "new-session", "-d", "-s", name, "-c", cwd ?? ".",
    "-P", "-F", "#{window_index}",
    ...(windowName ? ["-n", windowName] : []),
    ...(chatMode ? ["sh", "-c", CHAT_HOLDER_CMD] : []),
  ]);
  const idx = Number(stdout.trim());
  return Number.isFinite(idx) ? idx : 0;
}

// @param {object} input
// @param {string} input.name           tmux session (project) name
// @param {string} [input.cwd]          working directory (absolute/tilde)
// @param {string} [input.windowName]   initial window name
// @param {boolean} [input.createDir]   mkdir -p the cwd first (onboarding)
// @param {boolean} [input.chatMode]    create an opencode chat-mode window
// @param {object} [input.oc]           opencode client (required when chatMode)
export async function newSession({ name, cwd, windowName, createDir, chatMode, oc }) {
  // Onboarding's first-project step opts into auto-creation via createDir: a
  // missing ~/projects/<name> should be created, not silently swallowed. tmux
  // new-session -c falls back to $HOME for a non-existent dir, so the mkdir -p
  // must run FIRST. mkdir failure (e.g. permission denied) rejects here so the
  // caller renders an inline error. The Sidebar path leaves createDir unset.
  if (createDir && cwd) {
    await mkdir(expandTildePath(cwd), { recursive: true });
  }
  // Chat-mode: create the opencode session BEFORE the tmux window so we can
  // stamp @manta-session-id on it. Without the stamp the renderer sees
  // opencodeSessionId === null and renders Terminal instead of ChatPanel —
  // this was the BET-113 regression.
  const sid = await maybeCreateChatSession(
    oc, chatMode, cwd ?? ".", `${name} / ${windowName ?? "default"}`,
  );
  const idx = await newSessionGetIndex(name, cwd, windowName, !!chatMode);
  await applySessionSurvivability(name);
  if (sid) await restampSessionId(name, idx, sid);
  return listProjects();
}
export async function newWindow({ sessionName, windowName, cwd, chatMode, oc }) {
  const sid = await maybeCreateChatSession(
    oc, chatMode, cwd ?? ".", `${sessionName} / ${windowName}`,
  );
  let idx;
  try {
    idx = await newWindowGetIndexInternal(sessionName, windowName, cwd, !!chatMode);
  } catch (err) {
    // Auto-heal: the project's tmux session vanished between calls
    // (server restart, manual kill, etc.). Recreate it with this window
    // as the first window. We do NOT recreate the opencode session — `sid`
    // is already resolved and reusable as the stamp.
    if (!isMissingSessionError(err, sessionName)) throw err;
    idx = await newSessionGetIndex(sessionName, cwd, windowName, !!chatMode);
    await applySessionSurvivability(sessionName);
  }
  if (sid) await restampSessionId(sessionName, idx, sid);
  return listProjects();
}

/**
 * Create a new tmux window and return its index (integer).
 * Used by fork/clear composites which need to stamp @manta-session-id on the
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
 * Stamp (or update) the @manta-session-id user-option on a tmux window.
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
    "@manta-session-id", sessionId,
  ]);
}
