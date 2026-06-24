import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join, basename } from "node:path";
import { watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import {
  killAll,
  killPty,
  listPathCompletions,
  listWorktrees,
  remoteDirExists,
  resizePty,
  spawnPty,
  tmuxConfigStatus,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxList,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxRenameSession,
  tmuxRenameWindow,
  tmuxRestampSessionId,
  tmuxRestoreConfig,
  tmuxSelectWindow,
  tmuxSetupConfig,
  uploadFiles,
  uploadBuffer,
  cleanupUploads,
  peekRemoteFile,
  listOutbox,
  pullToDownloads,
  writePty,
  runSshOnce,
} from "./pty.js";
import { info as transportInfo, invalidate as invalidateTransport } from "./transport.js";
import { probe as setupProbe, bootstrap as setupBootstrap } from "./setup.js";
import { startStatusPoller, stopStatusPoller } from "./status.js";
import { noteSessionActivity } from "./transcriptCache.js";
import {
  listMessages as opencodeListMessages,
  getCachedMessages as opencodeGetCachedMessages,
  subscribeEvents as opencodeSubscribeEvents,
  sendPrompt as opencodeSendPrompt,
  abortSession as opencodeAbortSession,
  listPermissions as opencodeListPermissions,
  replyPermission as opencodeReplyPermission,
  listQuestions as opencodeListQuestions,
  replyQuestion as opencodeReplyQuestion,
  rejectQuestion as opencodeRejectQuestion,
  invalidateForward as invalidateOpencodeForward,
  teardownForward as teardownOpencodeForward,
  listModels as opencodeListModels,
  getDefaultModel as opencodeGetDefaultModel,
  getVcsBranch as opencodeGetVcsBranch,
  getSessionDirectorySync,
  resolveSessionDirectory as opencodeResolveSessionDirectory,
  setDirectoryReadyGate,
  listSessions as opencodeListSessions,
  forkSession as opencodeForkSession,
  compactSession as opencodeCompactSession,
  deleteSession as opencodeDeleteSession,
  listCommands as opencodeListCommands,
  listAgents as opencodeListAgents,
  findFiles as opencodeFindFiles,
  runCommand as opencodeRunCommand,
  createSession as opencodeCreateSession,
  generateSessionTitle as opencodeGenerateTitle,
  eventTunnelRestart,
  teardownEventTunnel,
  type PromptModel,
  type PromptAttachment,
  type PromptAgentMention,
} from "./opencode.js";
import {
  classifyStreamHealth,
  isSubstantiveFrame,
  STREAM_STALL_MS,
} from "./forwardHeal.js";
import { buildRemoteConfigWriteCmd } from "./remoteConfigWrite.js";
import {
  startDesktopPresence,
  stopDesktopPresence,
} from "./desktopPresence.js";
import {
  startDesktopNotifications,
  stopDesktopNotifications,
} from "./desktopNotify.js";
import {
  initSharedConfigSync,
  pushSharedConfig,
  pullSharedConfig,
} from "./sharedConfigSync.js";
import {
  initScheduleClient,
  listSchedules,
  deleteSchedule,
} from "./schedule.js";
// Plain-JS modules shared with the mobile server (src/server/*.mjs). The
// bundler resolves .mjs imports here; main.process never sees them as TS.
// Types live in groq.d.mts. Keep them dep-free so they stay portable across
// both transports.
import { transcribeAudio, classifyVoiceCommand } from "../shared/groq.mjs";
import { patchTouchesSharedConfig } from "../shared/sharedConfig.mjs";
import {
  IPC,
  type AppConfig,
  type AgentFileReady,
  type Project,
  type ProjectMeta,
  type SpawnOptions,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { host: "", projects: [] };

function commit(next: Partial<AppConfig>): AppConfig {
  config = { ...config, ...next };
  saveConfig(config);
  return config;
}

function upsertProjectMeta(meta: ProjectMeta): void {
  const others = config.projects.filter((p) => p.tmuxSession !== meta.tmuxSession);
  commit({ projects: [...others, meta] });
}

function deleteProjectMeta(tmuxSession: string): void {
  commit({ projects: config.projects.filter((p) => p.tmuxSession !== tmuxSession) });
}

// Resolve the cwd for a session-creating opencode op (new chat session via
// /clear, fork, etc.). Renderer-supplied cwd is preferred when it's a real
// path, but falls through to the project's stored defaultCwd whenever the
// renderer sends an empty string or the literal "~". opencode's session.create
// requires an absolute directory, and the per-pane paneCurrentPath the
// renderer normally passes can drift (or be empty for fresh chat-holder panes)
// so the workspace's defaultCwd is the canonical source of truth for "where
// this project lives".
function resolveProjectCwd(sessionName: string, inputCwd?: string): string {
  const trimmed = inputCwd?.trim();
  if (trimmed && trimmed !== "~") return trimmed;
  const meta = config.projects.find((p) => p.tmuxSession === sessionName);
  return meta?.defaultCwd?.trim() || trimmed || "~";
}

function startPollerIfReady(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!config.host) {
    stopStatusPoller();
    return;
  }
  startStatusPoller(mainWindow, () => config);
}

// Opencode SSE bus — multi-stream.
//
// opencode's `/event` endpoint is scoped by `?directory=<cwd>`: a POST with
// `?directory=X` emits its message/session events on the stream subscribed
// to `?directory=X` only. To catch every project's events we open:
//   - one global stream (`/event`) for unscoped events (server.heartbeat,
//     vcs.branch.updated, etc.), AND
//   - one scoped stream per directory we've ever cached (createSession,
//     forkSession, listSessions all feed `sessionDirectoryCache` and fire
//     `onSessionDirectoryAdded`).
//
// On start we bootstrap by listing existing sessions so server-restart
// scenarios re-open every directory's stream automatically.
//
// Reconnect: each stream loop has its own backoff. We do NOT tear down all
// streams when one dies — others keep flowing.
let opencodeBusStopped = true;
const opencodeStreams = new Map<string, () => void>(); // key: "" (global) or dir
let unsubscribeDirAdded: (() => void) | null = null;

// Refcount of open ChatPanels per scoped directory. A scoped stream is kept
// alive while ≥1 panel for that dir is mounted and is torn down when the last
// one unmounts (renderer drives this via opencodeOpenStream/CloseStream on
// ChatPanel mount/unmount). The global stream ("") is never refcounted — it
// always runs. This bounds concurrent streams to the sessions actually open
// in the UI; previously the bus streamed every dir opencode knew about.
const streamRefcounts = new Map<string, number>();

// Per-directory readiness: resolves the first time a scoped stream's SSE
// connection is established (opencodeSubscribeEvents returned a live stream).
// setDirectoryReadyGate uses this so a scoped prompt waits for its
// subscription before POSTing. Re-armed on each (re)connect attempt.
type Ready = { promise: Promise<void>; resolve: () => void };
const streamReady = new Map<string, Ready>();

// Per-directory "active work" tracker, fed from opencode's own
// session.status / session.idle events (authoritative — it's opencode's
// state, not a timing heuristic). Read by the stall watchdog: only when a
// directory has active work is "heartbeats but no substantive frames" a
// stall (mode B); a genuinely idle directory legitimately sees heartbeats
// only and must never be flagged. session.status also flows on the GLOBAL
// stream, so this stays accurate even when a scoped stream is the one
// stalling.
const activeWorkByDir = new Map<string, boolean>();

function noteSessionStatus(ev: { type: string; properties?: unknown }): void {
  if (ev.type !== "session.status" && ev.type !== "session.idle") return;
  const p = (ev.properties ?? {}) as {
    sessionID?: unknown;
    status?: { type?: unknown };
  };
  if (typeof p.sessionID !== "string") return;
  const dir = getSessionDirectorySync(p.sessionID);
  if (!dir) return;
  if (ev.type === "session.idle") {
    activeWorkByDir.set(dir, false);
    return;
  }
  const t = p.status?.type;
  if (t === "busy" || t === "retry") activeWorkByDir.set(dir, true);
  else if (t === "idle") activeWorkByDir.set(dir, false);
}

function readyFor(directory: string): Ready {
  let r = streamReady.get(directory);
  if (!r) {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => (resolve = res));
    r = { promise, resolve };
    streamReady.set(directory, r);
  }
  return r;
}

function startOpencodeBus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!config.host) {
    stopOpencodeBus();
    return;
  }
  opencodeBusStopped = false;

  // NOTE: we deliberately do NOT auto-open a scoped stream for every directory
  // that shows up in the cache. On a box with many opencode workspaces (e.g.
  // Multica), listSessions() floods the cache with ~100 dirs and auto-opening
  // a persistent stream per dir buried opencode serve under hundreds of
  // connections (the "sessions stuck loading / sends time out" regression).
  // Streams are now opened on demand: a ChatPanel mounting acquires its dir's
  // stream (refcounted) and the readiness gate opens one for an in-flight
  // prompt. See acquire/releaseOpencodeStream.

  // Readiness gate: a scoped prompt (opencode.ts:getSessionDirectoryQuery)
  // calls this after resolving its session directory. We open the scoped
  // stream (idempotent) and block until its SSE subscription is live, so the
  // POST can't out-race its own event channel. Bounded at 5s — a wedged
  // server must not freeze the prompt; degrade to "send anyway" instead.
  setDirectoryReadyGate(async (dir) => {
    if (opencodeBusStopped || !dir) return;
    ensureOpencodeStream(dir);
    const ready = readyFor(dir).promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(() => {
        console.warn(
          `[opencode-bus] readiness gate TIMEOUT dir=${dir} ` +
            `(sending prompt anyway; events may be delayed)`,
        );
        res();
      }, 5000);
    });
    try {
      await Promise.race([ready, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // Always run the global stream.
  ensureOpencodeStream("");

  // Seed the session-directory cache so the sidebar can resolve sessions, but
  // do NOT open a scoped stream per known dir (that was the connection-flood
  // bug). Scoped streams open on demand when a ChatPanel mounts.
  void opencodeListSessions(config).catch(() => { /* non-fatal bootstrap */ });
}

function stopOpencodeBus(): void {
  opencodeBusStopped = true;
  setDirectoryReadyGate(null);
  if (unsubscribeDirAdded) {
    try { unsubscribeDirAdded(); } catch { /* ignore */ }
    unsubscribeDirAdded = null;
  }
  for (const stop of opencodeStreams.values()) {
    try { stop(); } catch { /* ignore */ }
  }
  opencodeStreams.clear();
  streamReady.clear();
  activeWorkByDir.clear();
  // Tear down the dedicated event tunnel — no consumers once the bus stops.
  teardownEventTunnel();
}

function ensureOpencodeStream(directory: string): void {
  if (opencodeBusStopped) return;
  if (opencodeStreams.has(directory)) return;
  let stopped = false;
  // Stop function is wired before the async loop starts, so callers can
  // teardown even if we haven't received the first event yet.
  opencodeStreams.set(directory, () => {
    stopped = true;
    const dispose = activeDispose;
    if (dispose) {
      try { dispose(); } catch { /* ignore */ }
    }
  });
  let activeDispose: (() => void) | null = null;
  void (async function loop() {
    let backoffMs = 500;
    while (!stopped && !opencodeBusStopped) {
      if (!config.host) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // Hoisted so the finally can always clear it even if subscribe throws.
      let watchdog: ReturnType<typeof setInterval> | null = null;
      try {
        const stream = await opencodeSubscribeEvents(
          config,
          directory || undefined,
        );
        activeDispose = stream.dispose;
        backoffMs = 500;
        // Subscription is live: unblock any prompt waiting on this dir.
        readyFor(directory).resolve();
        console.log(
          `[opencode-bus] stream CONNECTED dir=${directory || "<global>"} ` +
            `(open streams: ${[...opencodeStreams.keys()]
              .map((k) => k || "<global>")
              .join(", ")})`,
        );
        // Stalled-stream watchdog. A half-dead ControlMaster (post sleep /
        // wifi change) lets this fetch CONNECT and deliver the first
        // `server.connected` frame, then stops pumping — no heartbeats, no
        // events. `ssh -O check` still passes so ensureForward can't see it.
        // We watch frame arrival here: if classifyStreamHealth says stalled
        // (connected long enough for ≥1 heartbeat, but total frame silence),
        // force-evict our ControlMaster and dispose the stream. The dispose
        // ends the `for await`, and the existing finally→backoff→loop then
        // reconnects through the fresh master ensureForward boots.
        const connectedAt = Date.now();
        let lastFrameAt = connectedAt;
        let lastSubstantiveAt = connectedAt;
        let frames = 0;
        let stalledOut = false;
        watchdog = setInterval(() => {
          const now = Date.now();
          // Active-work for THIS stream's directory. Scoped streams read
          // their own dir's state. The global stream (directory === "")
          // must report activeWork=false here: opencode delivers
          // session/message events ONLY to the matching `?directory=`
          // stream (see opencode.ts:1301-1305). The global stream is
          // expected to carry only keep-alives + a small set of
          // cross-cutting events. Earlier this used the union of every
          // dir's activeWork, which meant any mid-turn session anywhere
          // false-triggered mode B on <global> every ~45s → the watchdog
          // tore down ALL scoped streams (including the one actively
          // receiving frames for that session) → user-visible "hang" mid
          // turn. Treating global as never-mode-B keeps mode A (fully dead
          // mux) intact while removing the false positive.
          const activeWork = directory
            ? activeWorkByDir.get(directory) === true
            : false;
          const health = classifyStreamHealth({
            framesSinceConnect: frames,
            msSinceConnect: now - connectedAt,
            msSinceLastFrame: now - lastFrameAt,
            msSinceLastSubstantiveFrame: now - lastSubstantiveAt,
            activeWork,
          });
          if (health === "stalled") {
            stalledOut = true;
            const silentS = Math.round((now - lastFrameAt) / 1000);
            const substS = Math.round((now - lastSubstantiveAt) / 1000);
            // Two recovery paths, scaled to the signal:
            //
            // - activeWork=true (the user is waiting on real events): a true
            //   half-dead mux is dropping their assistant deltas. Worth the
            //   blast radius of an eventTunnelRestart — every other stream
            //   reconnects, but the user's in-flight turn gets unblocked.
            //
            // - activeWork=false (idle directory): "no frames in 50s" can
            //   mean the mux died, OR the remote opencode-serve is just
            //   slow (we've observed it pegged at 6 GB RES with full swap,
            //   delaying heartbeats by tens of seconds). Restarting the
            //   tunnel for every idle stream that times out cascades into
            //   tearing down ALL streams every ~50s — that's what the user
            //   feels as "UI stuck a lot". Just respawn THIS one stream;
            //   the others stay live. If the tunnel really is dead, every
            //   other stream will independently trip mode A and we converge
            //   on the same outcome, just without amplification.
            const action = activeWork
              ? "restarting event tunnel + reconnecting"
              : "reconnecting this stream only (idle — likely server lag, not dead mux)";
            console.warn(
              `[opencode-bus] STALLED dir=${directory || "<global>"} ` +
                `(no frames ${silentS}s / no substantive ${substS}s, ` +
                `activeWork=${activeWork}) — ${action}`,
            );
            if (activeWork) {
              // The event stream rides its OWN dedicated ssh -L -N tunnel
              // (isolated from the RPC ControlMaster). Kill it; the next
              // subscribeEvents respawns a FRESH connection. RPC/pty are
              // untouched — no shared-mux collateral.
              eventTunnelRestart();
            }
            try { stream.dispose(); } catch { /* already disposed */ }
          }
        }, Math.min(STREAM_STALL_MS, 10_000));
        let evCount = 0;
        for await (const ev of stream.iter) {
          if (stopped || opencodeBusStopped || stalledOut) break;
          const nowFrame = Date.now();
          lastFrameAt = nowFrame;
          frames++;
          // Track substantive (non-keep-alive) frames separately so the
          // watchdog can detect a HALF-dead mux (heartbeats flow, real
          // events don't). Also feed opencode's own busy/idle state into
          // the per-directory active-work tracker the watchdog consults.
          if (isSubstantiveFrame(ev.type)) lastSubstantiveAt = nowFrame;
          noteSessionStatus(ev);
          // Bump the per-session activity stamp so the transcript cache knows
          // its on-disk copy is stale until the next listMessages refresh.
          // Without this, a remount mid-turn (user switches away after sending
          // and comes back) paints the cached pre-send transcript for the ~6s
          // the fresh fetch takes — looks like the send never happened.
          // Only events with a string sessionID count; transport keep-alives
          // (server.connected, server.heartbeat) carry no sessionID and are
          // harmlessly skipped.
          {
            const sid = (ev.properties as { sessionID?: unknown } | undefined)?.sessionID;
            if (typeof sid === "string" && sid) noteSessionActivity(sid);
          }
          // Lightweight success-path trace: first event + every 50th, so the
          // log shows events ARE flowing for a dir (vs. silent = the bug)
          // without flooding on delta storms.
          if (evCount === 0 || evCount % 50 === 0) {
            console.log(
              `[opencode-bus] event#${evCount} dir=${directory || "<global>"} ` +
                `type=${ev.type}`,
            );
          }
          evCount++;

          // Trust mode: auto-reply "always" to every permission.asked. The
          // card never reaches the renderer, so tools execute without
          // prompting — closest analog to Claude Code's
          // --dangerously-skip-permissions.
          if (ev.type === "permission.asked" && config.chatAutoAllow) {
            const perm = ev.properties as
              | { id?: string; sessionID?: string }
              | undefined;
            if (perm?.id) {
              // MUST pass sessionID. opencode's WorkspaceRoutingMiddleware
              // silently no-ops a reply sent to the wrong workspace, so an
              // unscoped "always" left the permission pending on the server.
              // The bus still suppressed the live card, but the next
              // refreshPermissions()/panel-mount re-fetched the still-pending
              // entry and surfaced a card the user had to click manually —
              // i.e. auto-allow "didn't work" for any non-default-workspace
              // session. Scoping the reply is what actually unsticks the tool.
              opencodeReplyPermission(
                config,
                perm.id,
                "always",
                perm.sessionID,
              ).catch((e) => {
                console.warn(
                  "[opencode-bus] auto-allow failed:",
                  (e as Error).message,
                );
                // Fall back to manual approval: forward the event so the
                // renderer can render the card (mirrors the mobile pump).
                // Without this a failed auto-allow silently hangs the turn.
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send(IPC.opencodeEvent, ev);
                }
              });
            }
            // Suppress forwarding on the success path — the renderer doesn't
            // need to render the card. The subsequent permission.replied event
            // still flows through. (On failure the .catch above re-forwards.)
            continue;
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.opencodeEvent, ev);
          }
        }
      } catch (e) {
        // Server might not be up yet — fine, retry. We don't proactively
        // start opencode serve here; that happens on first chat-mode window
        // creation (in pty.ts → maybeCreateChatSession → ensureRunning).
        console.warn(
          `[opencode-bus${directory ? `:${directory}` : ""}] SSE loop:`,
          (e as Error).message,
        );
      } finally {
        activeDispose = null;
        if (watchdog) clearInterval(watchdog);
        // Stream dropped: re-arm readiness so a prompt issued during the
        // reconnect window waits for the new subscription instead of racing
        // a dead one. Drop the resolved promise; readyFor() makes a fresh.
        streamReady.delete(directory);
      }
      if (stopped || opencodeBusStopped) break;
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 8000);
    }
    opencodeStreams.delete(directory);
    streamReady.delete(directory);
  })();
}

// Refcounted acquire/release for scoped streams. The renderer calls these on
// ChatPanel mount/unmount so a dir's stream lives exactly as long as a panel
// needs it. Empty dir (global) is ignored here — it's always open.
function acquireOpencodeStream(directory: string): void {
  if (!directory || opencodeBusStopped) return;
  streamRefcounts.set(directory, (streamRefcounts.get(directory) ?? 0) + 1);
  ensureOpencodeStream(directory);
}

function releaseOpencodeStream(directory: string): void {
  if (!directory) return;
  const n = (streamRefcounts.get(directory) ?? 0) - 1;
  if (n > 0) {
    streamRefcounts.set(directory, n);
    return;
  }
  // Last panel for this dir closed — drop the refcount and tear the stream
  // down so we stop holding the connection (the fix for leaked CLOSE-WAIT
  // sockets piling up on opencode serve).
  streamRefcounts.delete(directory);
  const stop = opencodeStreams.get(directory);
  if (stop) {
    try { stop(); } catch { /* ignore */ }
  }
}

// Periodic upload cleanup. Runs once on (re)start and every hour afterward;
// each run deletes batches older than the configured threshold. Worst-case
// staleness ≈ uploadCleanupHours + 1h.
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function scheduleUploadCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (!config.host) return;
  const hours = config.uploadCleanupHours ?? 1;
  if (hours <= 0) return;
  void cleanupUploads(config, hours);
  cleanupTimer = setInterval(
    () => void cleanupUploads(config, config.uploadCleanupHours ?? 1),
    60 * 60 * 1000,
  );
}

// ===== Screenshot detector =====
//
// Two parallel detection paths — together they cover all four macOS screenshot
// shortcuts without any native module:
//
// 1. Clipboard poller (500ms): catches ⌘⇧Control+3/4 (clipboard-only shots).
//    Tracks clipboard "generation" by hashing availableFormats() + image size;
//    when a new image appears it pushes screenshotDetected to the renderer.
//    We intentionally do NOT read the full pixel buffer every tick — only
//    formats + size, so the poll is cheap. The renderer calls uploadBuffer
//    which reads the clipboard once via a separate IPC.
//
// 2. Desktop folder watcher: catches ⌘⇧3/4 (file-only shots). macOS names
//    them "Screenshot YYYY-MM-DD at HH.MM.SS.png". The fs.watch callback
//    fires on the rename event (file creation) and we filter by that pattern.
//    We push the absolute path so the renderer can scp it directly via
//    uploadFiles (no extra read needed).
//
// Both paths are no-ops when no mainWindow exists. The Desktop watcher is
// started once at app-ready and never restarted (the Desktop path doesn't
// change). The clipboard poller is the same.

const SCREENSHOT_RE = /^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}.*\.png$/i;

let screenshotClipboardTimer: ReturnType<typeof setInterval> | null = null;
let screenshotDesktopWatcher: ReturnType<typeof fsWatch> | null = null;

// Cheap fingerprint: join of available formats + "<w>x<h>". We don't hash
// pixel data — just enough to detect "something new appeared".
function clipboardImageFingerprint(): string {
  const fmts = clipboard.availableFormats().join(",");
  if (!fmts.includes("image")) return "";
  const img = clipboard.readImage();
  if (img.isEmpty()) return "";
  const { width, height } = img.getSize();
  return `${fmts}|${width}x${height}`;
}

function startScreenshotDetector(): void {
  // macOS-only: the clipboard fingerprint relies on Mac's screencapture
  // populating the clipboard on ⌘⇧^3/4, and the file watcher targets the
  // Mac-default `~/Desktop/Screenshot YYYY-MM-DD at HH.MM.SS.png` filename.
  // On Linux/Windows both paths would no-op at best and burn CPU on the
  // 500ms clipboard poller at worst.
  if (process.platform !== "darwin") return;

  // --- Clipboard poller ---
  let lastFingerprint = clipboardImageFingerprint();
  screenshotClipboardTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const fp = clipboardImageFingerprint();
    if (fp && fp !== lastFingerprint) {
      lastFingerprint = fp;
      mainWindow.webContents.send(IPC.screenshotDetected, { source: "clipboard" });
    }
  }, 500);

  // --- Desktop folder watcher ---
  const desktop = join(homedir(), "Desktop");
  try {
    screenshotDesktopWatcher = fsWatch(desktop, (event, filename) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event !== "rename" || !filename) return;
      if (!SCREENSHOT_RE.test(basename(filename))) return;
      const fullPath = join(desktop, filename);
      // Small delay — fs.watch fires on the rename (inode creation) before
      // the file is fully written. 300ms is enough for a PNG flush.
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(IPC.screenshotDetected, {
          source: "file",
          path: fullPath,
        });
      }, 300);
    });
  } catch {
    // Desktop might not exist or be accessible (e.g. on Linux in dev).
    // Silently skip — clipboard poller still works.
  }
}

function stopScreenshotDetector(): void {
  if (screenshotClipboardTimer) {
    clearInterval(screenshotClipboardTimer);
    screenshotClipboardTimer = null;
  }
  if (screenshotDesktopWatcher) {
    screenshotDesktopWatcher.close();
    screenshotDesktopWatcher = null;
  }
}

// ===== Agent → laptop outbox poller =====
//
// The reverse of drag-and-drop. The remote AI drops a file into
// `~/.bui-outbox/` and we pull it to the Mac's Downloads folder. This poller
// is the detection half (the transfer is pty.ts:pullToDownloads); it mirrors
// the screenshot Desktop watcher's philosophy — cheap periodic check over the
// warm ControlMaster, push a toast to the renderer.
//
// Cadence is 3s: file pushes are a deliberate, low-frequency action (the AI
// finished generating something), so we don't need sub-second latency, and a
// single `find` over the warm master is ~30-60ms.

const OUTBOX_POLL_MS = 3000;
let outboxTimer: ReturnType<typeof setInterval> | null = null;
// Remote paths we've already acted on this run, so a slow pull (or a
// require-confirm toast the user hasn't answered yet) isn't re-offered every
// tick. Cleared on host change so a new box starts fresh.
const seenOutboxPaths = new Set<string>();
let outboxPolling = false; // re-entrancy guard for the async tick

// Where agent-pushed files land. Configurable override, else ~/Downloads.
function resolveDownloadsDir(): string {
  if (config.downloadsDir && config.downloadsDir.trim()) {
    return config.downloadsDir.trim();
  }
  return app.getPath("downloads");
}

async function pollOutboxOnce(): Promise<void> {
  if (outboxPolling) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!config.host) return;
  outboxPolling = true;
  try {
    const entries = await listOutbox(config);
    // Reconcile the seen-set with what's actually on the remote: a file the
    // poller pulled (and rm'd) drops out of the listing, so prune it from the
    // set. Otherwise the set would grow unbounded across a long session.
    const present = new Set(entries.map((e) => e.path));
    for (const p of [...seenOutboxPaths]) {
      if (!present.has(p)) seenOutboxPaths.delete(p);
    }
    for (const entry of entries) {
      if (seenOutboxPaths.has(entry.path)) continue;
      seenOutboxPaths.add(entry.path);
      void handleOutboxEntry(entry);
    }
  } catch (e) {
    console.warn("[outbox] poll failed:", (e as Error).message);
  } finally {
    outboxPolling = false;
  }
}

async function handleOutboxEntry(entry: {
  path: string;
  name: string;
  size: number;
  session: string | null;
}): Promise<void> {
  const base: AgentFileReady = {
    remotePath: entry.path,
    name: entry.name,
    size: entry.size,
    sessionName: entry.session,
    autoPulled: false,
  };
  if (config.allowAgentPush) {
    // Trust mode: pull immediately, toast is informational.
    try {
      const localPath = await pullToDownloads(
        config,
        entry.path,
        resolveDownloadsDir(),
      );
      // The remote source is gone now (pullToDownloads rm'd it); drop it from
      // the seen-set so a future same-named push is offered again.
      seenOutboxPaths.delete(entry.path);
      pushAgentFileReady({ ...base, autoPulled: true, localPath });
    } catch (e) {
      console.warn("[outbox] auto-pull failed:", (e as Error).message);
      // Fall back to a confirm toast so the file isn't silently lost.
      pushAgentFileReady(base);
    }
  } else {
    // Require-confirm: just announce. The renderer calls agentPullFile on accept.
    pushAgentFileReady(base);
  }
}

function pushAgentFileReady(payload: AgentFileReady): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.agentFileReady, payload);
  }
}

function startOutboxPoller(): void {
  stopOutboxPoller();
  if (!config.host) return;
  void pollOutboxOnce();
  outboxTimer = setInterval(() => void pollOutboxOnce(), OUTBOX_POLL_MS);
}

function stopOutboxPoller(): void {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}

// IPC: renderer calls this to read the current clipboard image as PNG bytes.
// Separate from the poller so we only read full pixel data on demand.
function readClipboardImageBuffer(): Buffer | null {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toPNG();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0e0f12",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Set the app name as early as possible (before `ready`). This drives the
// product name shown in the macOS menu bar, the dock, AND — for packaged
// builds — the source name on OS notifications (otherwise the renderer's
// Web Notification API attributes them to the bundle, i.e. "Electron" in dev).
// `appUserModelId` does the equivalent for Windows toast attribution.
app.setName("Better UI");
app.setAppUserModelId("com.betterui.app");

app.whenReady().then(() => {
  config = loadConfig();
  // Cross-device shared-settings sync: read the live config, and when a newer
  // snapshot is pulled from the mobile server, commit it + tell the renderer.
  initSharedConfigSync({
    getConfig: () => config,
    applyPulled: (snap) => {
      const next = commit(snap as Partial<AppConfig>);
      mainWindow?.webContents.send(IPC.configChanged, next);
    },
  });
  // Scheduled-prompt management client (reaches the box's /api/schedule over
  // the -L 18787 forward). Jobs are server-owned; this only lists/deletes.
  initScheduleClient({ getConfig: () => config });
  registerHandlers();
  createWindow();
  // Defer poller start until renderer is ready to receive events.
  mainWindow?.webContents.once("did-finish-load", () => {
    startPollerIfReady();
    startOpencodeBus();
    scheduleUploadCleanup();
    startScreenshotDetector();
    startOutboxPoller();
    // Report desktop focus to the mobile server so it suppresses redundant
    // mobile "done" pushes while the user is active on desktop.
    startDesktopPresence(() => config);
    // Receive desktop OS-notification directives from bui-server's router
    // (over the same -L 18787 forward) and relay them to the renderer.
    startDesktopNotifications(
      () => config,
      (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.desktopNotify, payload);
        }
      },
    );
    // Pull any newer shared settings made on mobile while desktop was closed.
    void pullSharedConfig().catch(() => {});
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopStatusPoller();
  stopOpencodeBus();
  stopScreenshotDetector();
  stopOutboxPoller();
  if (cleanupTimer) clearInterval(cleanupTimer);
  killAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopStatusPoller();
  stopOpencodeBus();
  stopScreenshotDetector();
  stopOutboxPoller();
  stopDesktopPresence();
  stopDesktopNotifications();
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (config.host) void teardownOpencodeForward(config).catch(() => {});
  killAll();
});

// Compose tmux state + local metadata into the Project view used by the UI.
async function listProjects(): Promise<Project[]> {
  const tmuxSessions = await tmuxList(config);
  const metaByName = new Map(config.projects.map((p) => [p.tmuxSession, p]));

  return tmuxSessions.map((s) => {
    const meta = metaByName.get(s.name);
    const defaultCwd = meta?.defaultCwd || s.windows[0]?.paneCurrentPath || "~";
    return {
      tmuxSession: s.name,
      defaultCwd,
      attached: s.attached,
      windows: s.windows,
    };
  });
}

function registerHandlers(): void {
  ipcMain.handle(IPC.configGet, () => config);

  ipcMain.handle(IPC.configUpdate, async (_e, patch: Partial<AppConfig>) => {
    // Host or identity change → re-detect transport, drop the cached "forward
    // is up" flag, restart pollers/bus against the new target.
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      invalidateTransport();
      invalidateOpencodeForward();
    }
    // If this patch touches a SHAREABLE field, stamp configUpdatedAt so the
    // cross-device sync treats this as the newer snapshot (LWW). Mutating
    // `patch` here means commit() persists the timestamp too. Device-local
    // edits (host/projects/ports/…) do NOT bump the clock.
    const touchesShared = patchTouchesSharedConfig(patch);
    if (touchesShared) {
      (patch as AppConfig).configUpdatedAt = Date.now();
    }
    const next = commit(patch);
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      startPollerIfReady();
      stopOpencodeBus();
      startOpencodeBus();
      // New target → forget which outbox files we've seen and re-poll fresh.
      seenOutboxPaths.clear();
      startOutboxPoller();
    }
    if (
      "host" in patch ||
      "user" in patch ||
      "identityFile" in patch ||
      "uploadCleanupHours" in patch
    ) {
      scheduleUploadCleanup();
    }
    // Skill registry URLs → write skills.urls into remote opencode.jsonc so
    // opencode picks them up on next startup. We read the existing file first
    // to preserve all other settings, then patch only the skills.urls key.
    if ("skillRegistryUrls" in patch && next.host) {
      try {
        const urls = next.skillRegistryUrls ?? [];
        // Read current remote config (may not exist yet — that's fine)
        const readResult = await runSshOnce(
          next,
          `cat ~/.config/opencode/opencode.jsonc 2>/dev/null || echo '{}'`,
        );
        let existing: Record<string, unknown> = {};
        try {
          // Strip JSONC comments before parsing (simple single-line // strip)
          const stripped = readResult.stdout.replace(/\/\/[^\n]*/g, "");
          existing = JSON.parse(stripped);
        } catch {
          // Unparseable — start fresh, preserving the file's plugin entry at least
        }
        // Merge: patch only skills.urls; keep everything else untouched
        const merged = {
          ...existing,
          skills: {
            ...(typeof existing.skills === "object" && existing.skills !== null ? existing.skills as Record<string, unknown> : {}),
            urls,
          },
        };
        const content = JSON.stringify(merged, null, 2);
        // Write the JSON bytes UNCHANGED. The previous code did
        // `printf '%s' ${JSON.stringify(content)}` — double-encoding the
        // already-stringified JSON, which wrote literal backslash-n /
        // escaped-quote garbage and produced an invalid opencode.jsonc that
        // stopped opencode from starting (2026-05-18 incident). The pure,
        // tested builder emits a single-quoted heredoc so arbitrary JSON
        // passes through byte-for-byte. See remoteConfigWrite.ts.
        await runSshOnce(
          next,
          buildRemoteConfigWriteCmd(
            content,
            "~/.config/opencode/opencode.jsonc",
          ),
        );
      } catch (e) {
        // Non-fatal — user can still add URLs manually
        console.error("Failed to write skill registry URLs to remote opencode.jsonc:", e);
      }
    }
    // Push the shareable subset to the mobile server so the other device picks
    // it up (e.g. set the Groq STT key on desktop, get it on mobile). Fire-and-
    // forget over the existing -L 18787 forward; the POST response is the
    // post-merge snapshot, so a racing mobile edit is pulled back in.
    if (touchesShared) void pushSharedConfig().catch(() => {});
    return next;
  });

  ipcMain.handle(IPC.transportInfo, () => transportInfo(config));

  ipcMain.handle(IPC.projectMetaUpsert, (_e, meta: ProjectMeta) => {
    upsertProjectMeta(meta);
    return config;
  });

  ipcMain.handle(IPC.projectMetaDelete, (_e, tmuxSession: string) => {
    deleteProjectMeta(tmuxSession);
    return config;
  });

  ipcMain.handle(IPC.tmuxList, () => listProjects());

  ipcMain.handle(
    IPC.tmuxNewSession,
    async (_e, input: { name: string; cwd: string; windowName?: string; chatMode?: boolean }) => {
      if (!input.name.trim()) throw new Error("Project name is required");
      const cwd = input.cwd.trim() || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewSession(config, input.name.trim(), cwd, input.windowName, input.chatMode === true);
      // Persist defaultCwd locally so future sessions in this project get the same.
      upsertProjectMeta({ tmuxSession: input.name.trim(), defaultCwd: cwd });
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxNewWindow,
    async (
      _e,
      input: { sessionName: string; windowName: string; cwd?: string; chatMode?: boolean },
    ) => {
      const project = config.projects.find((p) => p.tmuxSession === input.sessionName);
      const cwd = input.cwd?.trim() || project?.defaultCwd || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewWindow(
        config,
        input.sessionName,
        input.windowName.trim() || "session",
        cwd,
        input.chatMode === true,
      );
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxRenameSession,
    async (_e, input: { oldName: string; newName: string }) => {
      const newName = input.newName.trim();
      if (!newName) throw new Error("Name is required");
      if (newName === input.oldName) return listProjects();
      await tmuxRenameSession(config, input.oldName, newName);
      // Move local metadata to the new key.
      const meta = config.projects.find((p) => p.tmuxSession === input.oldName);
      if (meta) {
        deleteProjectMeta(input.oldName);
        upsertProjectMeta({ ...meta, tmuxSession: newName });
      }
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxRenameWindow,
    async (
      _e,
      input: { sessionName: string; windowIndex: number; newName: string },
    ) => {
      const newName = input.newName.trim();
      if (!newName) throw new Error("Name is required");
      await tmuxRenameWindow(config, input.sessionName, input.windowIndex, newName);
      return listProjects();
    },
  );

  ipcMain.handle(IPC.tmuxKillSession, async (_e, sessionName: string) => {
    killPty(sessionName);
    await tmuxKillSession(config, sessionName).catch(() => {});
    deleteProjectMeta(sessionName);
    return listProjects();
  });

  ipcMain.handle(
    IPC.tmuxKillWindow,
    async (_e, input: { sessionName: string; windowIndex: number }) => {
      await tmuxKillWindow(config, input.sessionName, input.windowIndex);
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxSelectWindow,
    async (_e, input: { sessionName: string; windowIndex: number }) => {
      await tmuxSelectWindow(config, input.sessionName, input.windowIndex);
    },
  );

  // Clipboard write via Electron main — bypasses renderer permission restrictions
  // that silently block navigator.clipboard.writeText for non-user-gesture writes.
  ipcMain.handle(IPC.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle(
    IPC.uploadFiles,
    (_e, input: { projectName: string; localPaths: string[] }) =>
      uploadFiles(config, input.projectName, input.localPaths),
  );

  ipcMain.handle(
    IPC.uploadBuffer,
    (_e, input: { projectName: string; filename: string; buffer: ArrayBuffer }) =>
      uploadBuffer(config, input.projectName, input.filename, Buffer.from(input.buffer)),
  );

  // Read the current clipboard image as PNG bytes (called on demand after a
  // screenshotDetected push — we don't read full pixel data in the poller).
  ipcMain.handle(IPC.clipboardReadImage, () => {
    const buf = readClipboardImageBuffer();
    return buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null;
  });

  ipcMain.handle(IPC.peekRemoteFile, (_e, remotePath: string) =>
    peekRemoteFile(config, remotePath),
  );

  // Agent outbox → laptop: pull a remote outbox file to the downloads dir.
  // Returns the saved local absolute path. Used by the require-confirm toast's
  // "Save" button (auto-pull mode does this in the poller). Drops the path from
  // the seen-set so a future same-named push is offered again.
  ipcMain.handle(IPC.agentPullFile, async (_e, remotePath: string) => {
    const localPath = await pullToDownloads(
      config,
      remotePath,
      resolveDownloadsDir(),
    );
    seenOutboxPaths.delete(remotePath);
    return localPath;
  });

  // Reveal a local file in Finder / the OS file manager.
  ipcMain.handle(IPC.revealInFolder, (_e, localPath: string) => {
    if (localPath) shell.showItemInFolder(localPath);
  });

  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url));

  ipcMain.handle(IPC.gitListWorktrees, (_e, cwd: string) =>
    listWorktrees(config, cwd),
  );

  ipcMain.handle(IPC.fsListDirs, (_e, partial: string) =>
    listPathCompletions(config, partial),
  );

  // Remote tmux config management
  ipcMain.handle(IPC.tmuxConfigStatus, () => tmuxConfigStatus(config));
  ipcMain.handle(IPC.tmuxSetupConfig, async () => {
    await tmuxSetupConfig(config);
    return tmuxConfigStatus(config);
  });
  ipcMain.handle(IPC.tmuxRestoreConfig, async () => {
    await tmuxRestoreConfig(config);
    return tmuxConfigStatus(config);
  });

  // Setup wizard: one-shot diagnostic + best-effort installer. Both run
  // against the currently saved config (so the user must Save before
  // testing — Settings UI enforces this by disabling the buttons while
  // there are unsaved changes is a TODO; for now we just run with what's
  // persisted).
  ipcMain.handle(IPC.setupProbe, () => setupProbe(config));
  ipcMain.handle(IPC.setupBootstrap, () => setupBootstrap(config));

  // Voice / speech-to-text via Groq. Audio bytes are captured by the
  // renderer (MediaRecorder) and shipped here so the API key never lives
  // in the renderer process. See src/shared/groq.mjs for the HTTP layer
  // and src/shared/voiceClassifier.mjs for the rules classifier.
  ipcMain.handle(
    IPC.voiceTranscribe,
    async (_e, input: { buffer: ArrayBuffer; mime: string }) => {
      const apiKey = config.groqApiKey;
      const model = config.voiceTranscriptionModel;
      return transcribeAudio({
        buffer: input.buffer,
        mime: input.mime,
        apiKey: apiKey ?? "",
        model,
      });
    },
  );

  ipcMain.handle(
    IPC.voiceClassifyCommand,
    async (_e, input: { transcript: string; useLlmFallback?: boolean }) => {
      const apiKey = config.groqApiKey;
      const model = config.voiceCommandModel;
      return classifyVoiceCommand({
        transcript: input.transcript,
        apiKey: apiKey ?? "",
        model,
        useLlmFallback: input.useLlmFallback,
      });
    },
  );

  // Phase 1 chat-mode: one-shot fetch of a session's transcript. Live updates
  // arrive separately via the opencodeEvent stream forwarded by startOpencodeBus.
  ipcMain.handle(IPC.opencodeMessages, (_e, sessionId: string) =>
    opencodeListMessages(config, sessionId),
  );
  // Cached transcript lookup — instant. Renderer paints this immediately at
  // mount, then awaits opencodeMessages in the background for the refresh.
  ipcMain.handle(IPC.opencodeMessagesCached, (_e, sessionId: string) =>
    opencodeGetCachedMessages(sessionId),
  );

  // Scoped-stream lifecycle. A ChatPanel calls openStream on mount and
  // closeStream on unmount; the main process refcounts per directory and only
  // keeps a stream alive while a panel for that dir is open. We remember the
  // dir each open resolved to (openStreamDirs) so the matching close releases
  // the same dir even if the session→dir cache shifts in between.
  const openStreamDirs = new Map<string, string>(); // sessionId -> dir
  ipcMain.handle(IPC.opencodeOpenStream, async (_e, sessionId: string) => {
    if (!sessionId) return;
    const dir = await opencodeResolveSessionDirectory(config, sessionId);
    if (!dir) return; // unresolved → global stream still covers it
    openStreamDirs.set(sessionId, dir);
    acquireOpencodeStream(dir);
  });
  ipcMain.handle(IPC.opencodeCloseStream, (_e, sessionId: string) => {
    if (!sessionId) return;
    const dir = openStreamDirs.get(sessionId);
    if (!dir) return;
    openStreamDirs.delete(sessionId);
    releaseOpencodeStream(dir);
  });

  // Phase 2: send user message + abort generation. Optional `model` overrides
  // the server default for this prompt only (opencode has no session-level
  // model setting). `attachments` and `mentions` are inlined as FileParts /
  // AgentParts in the prompt body.
  ipcMain.handle(
    IPC.opencodePrompt,
    (
      _e,
      input: {
        sessionId: string;
        text: string;
        model?: PromptModel;
        attachments?: PromptAttachment[];
        mentions?: PromptAgentMention[];
      },
    ) =>
      opencodeSendPrompt(
        config,
        input.sessionId,
        input.text,
        input.model,
        input.attachments,
        input.mentions,
      ),
  );
  ipcMain.handle(IPC.opencodeAbort, (_e, sessionId: string) =>
    opencodeAbortSession(config, sessionId),
  );

  // Permission approval. `sessionId` is required for workspace-scoped routing
  // — without it the server returns [] for non-default-workspace sessions
  // and reply requests silently no-op (see listPermissions comment in
  // opencode.ts). Legacy callers without sessionId still work but only see
  // the default workspace's pending entries.
  ipcMain.handle(IPC.opencodePermissions, (_e, sessionId?: string) =>
    opencodeListPermissions(config, sessionId),
  );
  ipcMain.handle(
    IPC.opencodePermissionReply,
    (
      _e,
      input: {
        requestId: string;
        reply: "once" | "always" | "reject";
        sessionId?: string;
      },
    ) =>
      opencodeReplyPermission(
        config,
        input.requestId,
        input.reply,
        input.sessionId,
      ),
  );

  // Question tool. Same workspace-scoping rule as permissions above —
  // `sessionId` is what makes the live `que_…` visible.
  // No chatAutoAllow auto-handling — questions need explicit user choice.
  ipcMain.handle(IPC.opencodeQuestions, (_e, sessionId?: string) =>
    opencodeListQuestions(config, sessionId),
  );
  ipcMain.handle(
    IPC.opencodeQuestionReply,
    (
      _e,
      input: { requestId: string; answers: string[][]; sessionId?: string },
    ) =>
      opencodeReplyQuestion(
        config,
        input.requestId,
        input.answers,
        input.sessionId,
      ),
  );
  ipcMain.handle(
    IPC.opencodeQuestionReject,
    (_e, input: { requestId: string; sessionId?: string }) =>
      opencodeRejectQuestion(config, input.requestId, input.sessionId),
  );

  // Model picker. Strip-and-forward — opencode embeds apiKey in the wire
  // response; opencode.listModels redacts before this leaves main.
  ipcMain.handle(IPC.opencodeModels, () => opencodeListModels(config));
  ipcMain.handle(IPC.opencodeDefaultModel, () => opencodeGetDefaultModel(config));
  ipcMain.handle(IPC.opencodeVcsBranch, (_e, directory?: string) =>
    opencodeGetVcsBranch(config, directory),
  );

  // Session management: list/fork/compact/delete. Fork additionally creates a
  // bui tmux window pointing at the new session so the user sees it appear.
  ipcMain.handle(IPC.opencodeListSessions, (_e, directory?: string) =>
    opencodeListSessions(config, directory),
  );
  ipcMain.handle(
    IPC.opencodeForkSession,
    async (
      _e,
      input: {
        sessionId: string;
        sessionName: string;     // tmux session (bui project)
        windowName: string;      // tmux window label for the new fork
        cwd: string;
        messageID?: string;
      },
    ) => {
      const forked = await opencodeForkSession(config, input.sessionId, input.messageID);
      await tmuxNewWindow(
        config,
        input.sessionName,
        input.windowName,
        resolveProjectCwd(input.sessionName, input.cwd),
        true,                    // chatMode
        forked.id,
      );
      return { newSessionId: forked.id, projects: await listProjects() };
    },
  );
  ipcMain.handle(IPC.opencodeCompactSession, (_e, sessionId: string) =>
    opencodeCompactSession(config, sessionId),
  );
  // Delete: also tear down the matching tmux window (caller passes both since
  // the renderer knows which window owns the session).
  ipcMain.handle(
    IPC.opencodeDeleteSession,
    async (
      _e,
      input: { sessionId: string; sessionName: string; windowIndex: number },
    ) => {
      await opencodeDeleteSession(config, input.sessionId);
      await tmuxKillWindow(config, input.sessionName, input.windowIndex).catch(() => {});
      return listProjects();
    },
  );

  // Scheduled prompts (bui-server owned; reached over the -L 18787 forward).
  ipcMain.handle(IPC.scheduleList, (_e, sessionId?: string) =>
    listSchedules(sessionId),
  );
  ipcMain.handle(IPC.scheduleDelete, (_e, id: string) => deleteSchedule(id));

  // Typeahead sources for @ and / mentions.
  ipcMain.handle(IPC.opencodeCommands, () => opencodeListCommands(config));
  ipcMain.handle(IPC.opencodeAgents, () => opencodeListAgents(config));
  ipcMain.handle(
    IPC.opencodeFindFiles,
    (_e, input: { query: string; directory: string }) =>
      opencodeFindFiles(config, input.query, input.directory),
  );

  // Slash-command execution. Body shape mirrors prompt_async with `command`
  // and `arguments` instead of a free-form text part.
  ipcMain.handle(
    IPC.opencodeRunCommand,
    (
      _e,
      input: {
        sessionId: string;
        command: string;
        arguments: string;
        model?: PromptModel;
        attachments?: PromptAttachment[];
      },
    ) =>
      opencodeRunCommand(
        config,
        input.sessionId,
        input.command,
        input.arguments,
        input.attachments,
        input.model,
      ),
  );

  // /clear flow: create a new opencode session in the same directory, then
  // re-stamp the tmux window's @bui-session-id to the new id. Returns the
  // new session id + refreshed project list so the renderer can swap.
  ipcMain.handle(
    IPC.opencodeClearSession,
    async (
      _e,
      input: {
        sessionName: string;
        windowIndex: number;
        cwd: string;
        title: string;
      },
    ) => {
      const sess = await opencodeCreateSession(
        config,
        resolveProjectCwd(input.sessionName, input.cwd),
        input.title,
      );
      await tmuxRestampSessionId(
        config,
        input.sessionName,
        input.windowIndex,
        sess.id,
      );
      return { newSessionId: sess.id, projects: await listProjects() };
    },
  );

  // Auto-rename: derive a short title for a session via a throwaway opencode
  // session. Returns the RAW model reply; the renderer sanitizes + renames.
  ipcMain.handle(
    IPC.opencodeGenerateTitle,
    async (_e, input: { directory: string; instruction: string }) => {
      return opencodeGenerateTitle(config, input.directory, input.instruction);
    },
  );

  ipcMain.handle(IPC.ptySpawn, async (_e, opts: SpawnOptions) => {
    if (!mainWindow) return;
    await spawnPty(mainWindow, config, opts);
  });

  ipcMain.handle(IPC.ptyWrite, (_e, projectName: string, data: string) => {
    writePty(projectName, data);
  });

  ipcMain.handle(IPC.ptyResize, (_e, projectName: string, cols: number, rows: number) => {
    resizePty(projectName, cols, rows);
  });

  ipcMain.handle(IPC.ptyKill, (_e, projectName: string) => {
    killPty(projectName);
  });
}
