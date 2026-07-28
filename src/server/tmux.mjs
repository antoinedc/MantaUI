import { spawn as cpSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { expandTilde, STATE_DIRNAME } from "../shared/paths.mjs";
import { atomicWrite } from "./storeUtils.mjs";

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

// ---------------------------------------------------------------------------
// BET-348: Manta-owned session sidecar
// ---------------------------------------------------------------------------
//
// The renderer needs to know which tmux sessions Manta created (so it can
// spawn a fresh shell in cwd) vs which ones pre-existed on the box (so it
// should `tmux attach-session -t <session>:<windowIndex>` instead — see the
// SpawnOptions.tmuxTarget field in src/shared/types.ts). The tmux sidecar is
// the only signal: nothing in tmux's own state distinguishes "Manta made
// this" from "the user started this in their own terminal before opening
// Manta".
//
// We persist the set of Manta-owned session names to
// `~/.manta/tmux-sessions.json`. On server startup / every `listProjects`
// call we reconcile against `tmux list-sessions`: entries for sessions
// that have been killed (by anyone — Manta, the user, the OS) are pruned,
// so a session that disappeared doesn't silently re-claim "owned" status
// if it reappears under the same name later. The reconciliation also
// satisfies "the marker doesn't leak across reboots and incorrectly claim
// ownership" from the BET-348 acceptance criteria — after a reboot the
// sidecar is read once, reconciled, and only contains sessions that
// actually exist right now.
//
// Atomic-write pattern (same as schedule.mjs / secrets.mjs) so a crash
// mid-write never leaves a half-truncated JSON file behind.

export const OWNED_SESSIONS_PATH = join(homedir(), STATE_DIRNAME, "tmux-sessions.json");

// Plain reader — not reactive. Returns the persisted set; missing/corrupt
// files collapse to an empty set so the server can boot. Exported for
// unit tests + the public `listOwnedSessions` helper below.
export async function loadOwnedSessions(path = OWNED_SESSIONS_PATH, fs = { readFile }) {
  try {
    if (!existsSync(path)) return [];
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    // Defensive: tolerate either {sessions: [...]} (the wire shape) or a
    // bare array (legacy shape from earlier design drafts). Anything else
    // collapses to [] so a corrupt file doesn't break the renderer.
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    return arr.filter((s) => typeof s === "string");
  } catch {
    // ENOENT / EACCES / JSON parse error — start empty, don't crash.
    return [];
  }
}

async function saveOwnedSessions(sessions, path = OWNED_SESSIONS_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify({ sessions }, null, 2));
}

// Synchronous variant used at server boot / by tests that don't want to
// mock `fs/promises`. Same contract: missing or unparseable → [].
export function loadOwnedSessionsSync(path = OWNED_SESSIONS_PATH) {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    return arr.filter((s) => typeof s === "string");
  } catch {
    return [];
  }
}

// Cached set, hydrated lazily on the first call after server boot and
// kept in sync by `addOwnedSession` / `removeOwnedSession`. Read on
// every `listProjects()` to stamp `mantaOwned` on each session.
//
// `ownedSessionsCachePath` is the active target. Production code never
// touches it — it stays at `OWNED_SESSIONS_PATH`. Tests override it via
// `_setOwnedSessionsPath` (test-only hook) to redirect writes to a tmp
// file. The helper defaults pick up the active path so a test that
// primed the cache doesn't have to thread `{ path }` through every
// call.
let ownedSessionsCache = null;
let ownedSessionsCachePath = OWNED_SESSIONS_PATH;
async function getOwnedSessions(path = ownedSessionsCachePath) {
  if (ownedSessionsCache === null || ownedSessionsCachePath !== path) {
    ownedSessionsCache = await loadOwnedSessions(path);
    ownedSessionsCachePath = path;
  }
  return new Set(ownedSessionsCache);
}
export async function addOwnedSession(name, { path = ownedSessionsCachePath } = {}) {
  if (typeof name !== "string" || !name) return;
  const cur = await getOwnedSessions(path);
  if (cur.has(name)) return; // idempotent
  cur.add(name);
  ownedSessionsCache = [...cur];
  ownedSessionsCachePath = path;
  await saveOwnedSessions(ownedSessionsCache, path);
}
export async function removeOwnedSession(name, { path = ownedSessionsCachePath } = {}) {
  if (typeof name !== "string" || !name) return;
  const cur = await getOwnedSessions(path);
  if (!cur.has(name)) return; // idempotent
  cur.delete(name);
  ownedSessionsCache = [...cur];
  ownedSessionsCachePath = path;
  await saveOwnedSessions(ownedSessionsCache, path);
}

/** Test-only: reset the module-level cache + active path so the next
 *  call re-hydrates from disk. Used by tmux.test.mjs to keep test
 *  cases hermetic — production code never calls this. */
export function _resetOwnedSessionsCache() {
  ownedSessionsCache = null;
  ownedSessionsCachePath = OWNED_SESSIONS_PATH;
}

/** Test-only: redirect the default path used by `addOwnedSession` /
 *  `removeOwnedSession` when no `{ path }` option is supplied. The
 *  production callers (renameSession / killSession / newSession /
 *  reconcileOwnedSessions) don't pass `path`, so they pick up this
 *  override. Combined with `_resetOwnedSessionsCache`, tests can drive
 *  the full public surface (renameSession etc.) against a tmp file
 *  without touching `~/.manta/tmux-sessions.json`. */
export function _setOwnedSessionsPath(path) {
  ownedSessionsCachePath = path ?? OWNED_SESSIONS_PATH;
  ownedSessionsCache = null;
}

// Reconcile the cache against the live tmux state: drop entries for
// sessions that no longer exist (manually killed outside Manta, killed by
// the user in their own terminal, or pruned by `destroy-unattached`).
// Best-effort: a tmux error here doesn't break `listProjects` (we'd
// rather serve an over-permissive set than fail the listing).
async function reconcileOwnedSessions(liveSessions) {
  const live = new Set(liveSessions);
  // Pin the path at the start so the cache load and the eventual save
  // both use the same target — without this the test override (which
  // redirects `ownedSessionsCachePath`) only steers the read, and the
  // dirty-cache write below would silently land on the production
  // path. In production `ownedSessionsCachePath` is always
  // `OWNED_SESSIONS_PATH`, so this is a no-op there.
  const path = ownedSessionsCachePath;
  const cur = await getOwnedSessions(path);
  let dirty = false;
  for (const name of cur) {
    if (!live.has(name)) {
      cur.delete(name);
      dirty = true;
    }
  }
  if (dirty) {
    ownedSessionsCache = [...cur];
    await saveOwnedSessions(ownedSessionsCache, path);
  }
  return cur;
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

export function parseSessions(sessStdout, winStdout, owned = new Set()) {
  // Phase 1: build ordered session map from list-sessions output.
  const sessions = new Map();
  for (const line of sessStdout.split("\n").filter(Boolean)) {
    const [name, att] = line.split(FS);
    sessions.set(name, {
      tmuxSession: name,
      attached: att === "1",
      windows: [],
      // BET-348: stamp Manta-ownership on each session as we go. The
      // `owned` set is what was loaded from `~/.manta/tmux-sessions.json`
      // (reconciled against live state by `listProjects`). Absent from the
      // Set = false, never undefined, so the renderer's `mantaOwned ?? false`
      // never trips over an uninitialized field.
      mantaOwned: owned.has(name),
    });
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
  // BET-348: build the owned set from the cache (hydrated on first call),
  // reconcile it against the LIVE tmux session list — anything in the
  // sidecar that no longer exists gets pruned before we serve the listing,
  // so the renderer can't see a session that "remembers ownership" of a
  // session that was killed. Then stamp each session with mantaOwned.
  const parsedSess = parseSessions(sess.stdout, "");
  const liveNames = parsedSess.map((p) => p.tmuxSession);
  const owned = await reconcileOwnedSessions(liveNames);
  return parseSessions(sess.stdout, wins.stdout, owned);
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
  // BET-348: record ownership AFTER tmux accepted the new-session. If
  // anything above threw, we never get here — and we'd rather fail loud
  // than stamp a phantom entry. The next listProjects() will reconcile
  // the sidecar against tmux's live list, so a stale entry from a
  // crashed create() is bounded by the next listing call. Pin the
  // path so a test-time path override (`_setOwnedSessionsPath`) is
  // honored — without this the write would silently land on the
  // production default.
  await addOwnedSession(name, { path: ownedSessionsCachePath });
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
  // BET-348: keep the sidecar in sync with the rename — otherwise the
  // renamed session would lose its "Manta-owned" mark and the renderer
  // would misclassify it as a pre-existing window on the next listing.
  // Pin the path here so the helpers don't drift to the production
  // default if a test has redirected `ownedSessionsCachePath` via the
  // `_setOwnedSessionsPath` test hook.
  const path = ownedSessionsCachePath;
  await removeOwnedSession(oldName, { path });
  await addOwnedSession(newName, { path });
  return listProjects();
}
export async function renameWindow({ sessionName, windowIndex, newName }) {
  await run("tmux", ["rename-window", "-t", `${sessionName}:${windowIndex}`, newName]);
  return listProjects();
}
export async function killSession(sessionName) {
  await run("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  // BET-348: prune the sidecar eagerly on the explicit-kill path. The
  // listProjects() reconciliation below is a defense in depth for kills
  // that happened outside Manta (e.g. user typed :kill-session in their
  // own terminal), but here we KNOW Manta just issued the kill, so the
  // sidecar should drop the entry without waiting for the next listing.
  // Fail-open on the sidecar write: if the disk hiccups, the
  // reconciliation in listProjects() will still catch the orphaned
  // entry next time around. Pin the path so a test-time path override
  // is honored (no silent write to the production default).
  try { await removeOwnedSession(sessionName, { path: ownedSessionsCachePath }); } catch { /* best-effort */ }
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
