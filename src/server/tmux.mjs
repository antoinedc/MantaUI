import { spawn as cpSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { expandTilde } from "../shared/paths.mjs";

const FS = "\t";

/**
 * The environment tmux must be invoked with.
 *
 * tmux sanitises "unprintable" bytes in `-F` output when it is running under a
 * non-UTF-8 locale: our TAB field separator comes back as `_`. Services get NO
 * locale from their supervisor — launchd passes none at all, and a systemd
 * --user unit only has what the unit file declares — so every tmux query made
 * by the box server was silently mangled: `list-sessions` yielded
 * `"<name>_<attachedFlag>"` as the session NAME, and every window line failed
 * to match a known session and was dropped. The visible symptom is a workspace
 * with a corrupted name and zero windows, which is what the macOS box did.
 *
 * Fixing it here (rather than in a plist / unit file) makes it independent of
 * how the server was started — including the nohup fallback and any
 * hand-rolled supervisor — and it is the only place tmux is ever spawned.
 * An explicit locale from the environment always wins; we only supply a
 * default when there is none. macOS has no `C.UTF-8`, so it gets the
 * always-present `en_US.UTF-8`.
 *
 * Exported for testing.
 */
export function tmuxSpawnEnv(env = process.env, platform = process.platform) {
  const existing = env.LC_ALL || env.LANG;
  if (existing) return { ...env };
  return { ...env, LC_ALL: platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" };
}

function spawnRun(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = cpSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: tmuxSpawnEnv() });
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
    const [session, index, wname, active, pane, sidRaw, wtRaw] = parts;
    if (!sessions.has(session)) continue; // defensive: orphan
    sessions.get(session).windows.push({
      index: Number(index), name: wname,
      active: active === "1", paneCurrentPath: pane,
      opencodeSessionId: sidRaw ? sidRaw : null,
      // BET-246: when MantaUI auto-created a worktree for this window, the
      // absolute path is stamped on `@manta-worktree-path`. Empty/null = not
      // a worktree window — clean-on-close must skip it.
      worktreePath: wtRaw ? wtRaw : null,
    });
  }
  return Array.from(sessions.values()).map((s) => ({
    ...s,
    defaultCwd: s.windows[0]?.paneCurrentPath ?? "~",
  }));
}

export async function listProjects() {
  const sessFmt = `#{session_name}${FS}#{?session_attached,1,0}`;
  const winFmt = `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}#{?window_active,1,0}${FS}#{pane_current_path}${FS}#{@manta-session-id}${FS}#{@manta-worktree-path}`;
  const sess = await run("tmux", ["list-sessions", "-F", sessFmt]).catch(() => ({ stdout: "" }));
  const wins = await run("tmux", ["list-windows", "-a", "-F", winFmt]).catch(() => ({ stdout: "" }));
  return parseSessions(sess.stdout, wins.stdout);
}

// Chat-mode windows don't run a TUI — manta renders its own React ChatPanel
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
// `cwd` is required to be an absolute directory — callers (newSession /
// newWindow / newWindowGetIndex) flow through `resolveCwdOrThrow` first, which
// expands `~` and rejects a missing dir. The BET-307 tmux-side chokepoint.
async function maybeCreateChatSession(oc, chatMode, cwd, title) {
  if (!chatMode) return null;
  if (!oc || typeof oc.createSession !== "function") {
    throw new Error("chat mode requires an opencode client (oc.createSession)");
  }
  const sess = await oc.createSession({ directory: cwd, title });
  return sess.id;
}

// THE single place a caller-supplied cwd becomes a real directory handed to
// tmux or opencode. tmux's `-c` does NOT expand `~`, and for a missing dir it
// silently falls back to $HOME with exit code 0 — which is how every project
// created with the UI's default `~` path ended up in the home directory.
// Expand here and fail loudly instead of landing somewhere the user did not
// ask for. Exported for unit tests in src/server/tmux.test.mjs.
export function resolveCwdOrThrow(cwd) {
  const dir = expandTilde(cwd ?? ".");
  if (!existsSync(dir)) {
    throw new Error(`working directory does not exist: ${dir}`);
  }
  return dir;
}

// Create a session and return the index of its initial window. `cwd` MUST be
// an absolute path — callers run it through `resolveCwdOrThrow` first.
async function newSessionGetIndex(name, cwd, windowName, chatMode) {
  const { stdout } = await run("tmux", [
    "new-session", "-d", "-s", name, "-c", cwd,
    "-P", "-F", "#{window_index}",
    ...(windowName ? ["-n", windowName] : []),
    ...(chatMode ? ["sh", "-c", CHAT_HOLDER_CMD] : []),
  ]);
  const idx = Number(stdout.trim());
  return Number.isFinite(idx) ? idx : 0;
}

// Create the tmux window with an explicit index-returning form. For chat-mode
// we launch the holder pane (`sleep infinity`) instead of the default shell so
// the pane is inert under manta's overlaid ChatPanel; for non-chat we launch the
// default shell (no trailing command).
//
// `chatMode` defaults to false (fork-session is the 3-arg caller from
// src/server/rpc.mjs and never wanted chatMode). Exported so rpc handlers can
// create windows directly (fork-session stamp path) without going through
// newWindow + restampSessionId.
//
// THE tmux-side chokepoint lives here too — `newWindowGetIndex` is reachable
// from outside the `newSession`/`newWindow` envelope (rpc.mjs:376 fork-session
// calls it directly), so we resolve and reject a missing dir the same way.
export async function newWindowGetIndex(sessionName, windowName, cwd, chatMode = false) {
  const dir = resolveCwdOrThrow(cwd);
  const { stdout } = await run("tmux", [
    "new-window",
    "-t", sessionName,
    "-n", windowName,
    "-P", "-F", "#{window_index}",
    "-c", dir,
    ...(chatMode ? ["sh", "-c", CHAT_HOLDER_CMD] : []),
  ]);
  const idx = Number(stdout.trim());
  if (!Number.isFinite(idx)) {
    throw new Error(`tmux new-window returned unexpected index: ${JSON.stringify(stdout.trim())}`);
  }
  return idx;
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
    await mkdir(expandTilde(cwd), { recursive: true });
  }
  // THE tmux-side chokepoint: expand `~` and fail loudly for a missing dir
  // BEFORE we create an opencode session (chatMode) or call tmux.
  const dir = resolveCwdOrThrow(cwd);
  // Chat-mode: create the opencode session BEFORE the tmux window so we can
  // stamp @manta-session-id on it. Without the stamp the renderer sees
  // opencodeSessionId === null and renders Terminal instead of ChatPanel —
  // this was the BET-113 regression.
  const sid = await maybeCreateChatSession(
    oc, chatMode, dir, `${name} / ${windowName ?? "default"}`,
  );
  const idx = await newSessionGetIndex(name, dir, windowName, !!chatMode);
  await applySessionSurvivability(name);
  if (sid) await restampSessionId(name, idx, sid);
  return listProjects();
}
export async function newWindow({ sessionName, windowName, cwd, chatMode, worktreePath, oc }) {
  // THE tmux-side chokepoint. Resolves before we opencode-create or tmux-call,
  // so a bad cwd throws before we orphan an opencode session.
  const dir = resolveCwdOrThrow(cwd);
  const sid = await maybeCreateChatSession(
    oc, chatMode, dir, `${sessionName} / ${windowName}`,
  );
  let idx;
  try {
    idx = await newWindowGetIndex(sessionName, windowName, dir, !!chatMode);
  } catch (err) {
    // Auto-heal: the project's tmux session vanished between calls
    // (server restart, manual kill, etc.). Recreate it with this window
    // as the first window. We do NOT recreate the opencode session — `sid`
    // is already resolved and reusable as the stamp.
    if (!isMissingSessionError(err, sessionName)) throw err;
    idx = await newSessionGetIndex(sessionName, dir, windowName, !!chatMode);
    await applySessionSurvivability(sessionName);
  }
  if (sid) await restampSessionId(sessionName, idx, sid);
  // BET-246: stamp the worktree path (if any) so clean-on-close knows this
  // window owns the worktree and may safely remove it. Mirrors the
  // restampSessionId pattern — separate option name so the two stamps
  // never collide.
  if (worktreePath) await stampWorktreePath(sessionName, idx, worktreePath);
  return listProjects();
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

/**
 * Stamp (or update) the @manta-worktree-path user-option on a tmux window.
 * Used by BET-246's clean-on-close to know which windows own a worktree
 * that manta created (vs. pre-existing worktrees, which must NEVER be
 * removed). Mirrors restampSessionId verbatim — separate option name so
 * the two stamps never collide.
 *
 * @param {string} sessionName
 * @param {number} windowIndex
 * @param {string} path   absolute worktree path
 */
export async function stampWorktreePath(sessionName, windowIndex, path) {
  await run("tmux", [
    "set-window-option",
    "-t", `${sessionName}:${windowIndex}`,
    "@manta-worktree-path", path,
  ]);
}
