import {
  IPC,
  type OpencodeEvent,
  type PtyEvent,
  type WindowStatus,
} from "../../shared/types.js";
import type { Api } from "../../preload/index.js";

// ---------------------------------------------------------------------------
// Server base URL resolution (3 deployment contexts):
//   1. localStorage["bui_server"] override (Settings screen / power users) —
//      always wins. This is how the Capacitor APK points itself at the box.
//   2. Page served over http(s) from a real host (tunnel / LAN / domain) →
//      same-origin. Critical for the HTTPS cloudflare tunnel: hardcoding
//      http://IP here gets blocked as Mixed Content from an https page.
//      location.origin carries the page's own scheme, so no protocol skew.
//   3. Otherwise (Capacitor http://localhost, file:) → dev-box fallback.
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

function serverBase(): string {
  const v = localStorage.getItem("bui_server");
  if (v) return v.replace(/\/+$/, "");
  const { protocol, hostname, origin } = window.location;
  if ((protocol === "https:" || protocol === "http:") && !LOCAL_HOSTS.has(hostname)) {
    return origin.replace(/\/+$/, "");
  }
  return "http://157.90.224.92:8787";
}

// ---------------------------------------------------------------------------
// Generic JSON-RPC helper
// ---------------------------------------------------------------------------

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(
    `${serverBase()}/rpc/${encodeURIComponent(channel)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    },
  );
  let json: { result?: unknown; error?: string } = {};
  try { json = await res.json(); } catch { /* non-JSON body (proxy/HTML error) */ }
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result as T;
}

// ---------------------------------------------------------------------------
// SSE stream — one shared EventSource, lazily created.
// ---------------------------------------------------------------------------

type Kind = "opencode" | "pty" | "status" | "screenshot";

const listeners: Record<Kind, Set<(p: unknown) => void>> = {
  opencode: new Set(),
  pty: new Set(),
  status: new Set(),
  screenshot: new Set(),
};

let es: EventSource | null = null;

// ---------------------------------------------------------------------------
// Reconnect-resync state.
// ---------------------------------------------------------------------------

// Set to true after the first onerror so we know the NEXT onopen is a
// reconnect (not the initial connect).  Reset to false after firing the resync
// so rapid flapping doesn't spam listeners — the next genuine reconnect after
// another onerror will set it again.
let _hadError = false;

// Guard: only fire the resync once per reconnect event even if onopen somehow
// fires multiple times in quick succession.
let _resyncing = false;

/**
 * Fire two synthetic, side-effect-free OpencodeEvents so that every active
 * ChatPanel refetches messages, permissions, AND questions after the SSE
 * stream reconnects.
 *
 * Synthetic event 1 — "permission.replied"
 *   ChatPanel handler (lines ~736-741): calls refreshPermissions() (→
 *   opencodePermissions re-fetch) AND scheduleRefetch() (→ opencodeMessages
 *   re-fetch, debounced 300 ms).  No state mutations; purely triggers fetches.
 *
 * Synthetic event 2 — "question.asked"
 *   ChatPanel handler (lines ~745-753): calls refreshQuestions() (→
 *   opencodeQuestions re-fetch).  No state mutations; purely triggers a fetch.
 *
 * Both events have no sessionID in properties so they pass the early
 * `if (props.sessionID && props.sessionID !== sessionId) return` guard in
 * every mounted ChatPanel, causing each panel to refetch for its own session.
 *
 * Neither event type mutates transcript state (no delta/part/id fields are
 * processed for these types) — they only schedule fetch calls.
 */
function fireResync() {
  if (_resyncing) return;
  _resyncing = true;
  // Use setTimeout(0) so we don't fire synchronously inside onopen.
  setTimeout(() => {
    _resyncing = false;
    const set = listeners.opencode;
    if (set.size === 0) return; // no listeners yet — nothing to do
    // Synthetic event 1: triggers refreshPermissions() + scheduleRefetch()
    const ev1: OpencodeEvent = { type: "permission.replied", properties: {} };
    for (const fn of set) { try { fn(ev1); } catch { /* listener error — ignore, see onmessage */ } }
    // Synthetic event 2: triggers refreshQuestions()
    const ev2: OpencodeEvent = { type: "question.asked", properties: {} };
    for (const fn of set) { try { fn(ev2); } catch { /* listener error — ignore */ } }
  }, 0);
}

function ensureStream() {
  if (es) return;
  es = new EventSource(`${serverBase()}/events`);
  es.onmessage = (m) => {
    try {
      const { kind, payload } = JSON.parse(m.data) as {
        kind: Kind;
        payload: unknown;
      };
      const set = listeners[kind];
      if (set) for (const fn of set) fn(payload);
    } catch {
      // keep-alive comment or malformed line — ignore
    }
  };
  es.onerror = () => {
    // EventSource will auto-reconnect; mark that a drop occurred so the
    // next onopen knows it's a reconnect (not the initial connect).
    _hadError = true;
  };
  es.onopen = () => {
    if (_hadError) {
      // This is a reconnect after a drop — fire the resync.
      _hadError = false;
      fireResync();
    }
    // else: initial connect — do nothing (initial load already fetches).
  };
}

// The preload's `onX` methods return `() => Electron.IpcRenderer` because
// `ipcRenderer.removeListener(...)` returns IpcRenderer. Our shim returns
// `() => void` conceptually, but to be assignable to the inferred Api type we
// cast the unsubscribe thunk to the Electron type via `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function on<T>(kind: Kind, cb: (p: T) => void): () => any {
  ensureStream();
  const fn = cb as (p: unknown) => void;
  listeners[kind].add(fn);
  return () => listeners[kind].delete(fn);
}

// ---------------------------------------------------------------------------
// httpApi — implements every method of the Api type.
// ---------------------------------------------------------------------------

export const httpApi: Api = {
  // -- config --
  configGet: () => rpc(IPC.configGet),
  configUpdate: (patch) => rpc(IPC.configUpdate, patch),

  // -- project metadata --
  projectMetaUpsert: (meta) => rpc(IPC.projectMetaUpsert, meta),
  projectMetaDelete: (tmuxSession) => rpc(IPC.projectMetaDelete, tmuxSession),

  // -- transport --
  transportInfo: () => rpc(IPC.transportInfo),

  // -- tmux operations --
  tmuxList: () => rpc(IPC.tmuxList),
  tmuxNewSession: (input) => rpc(IPC.tmuxNewSession, input),
  tmuxNewWindow: (input) => rpc(IPC.tmuxNewWindow, input),
  tmuxRenameSession: (input) => rpc(IPC.tmuxRenameSession, input),
  tmuxRenameWindow: (input) => rpc(IPC.tmuxRenameWindow, input),
  tmuxKillSession: (sessionName) => rpc(IPC.tmuxKillSession, sessionName),
  tmuxKillWindow: (input) => rpc(IPC.tmuxKillWindow, input),
  tmuxSelectWindow: (input) => rpc(IPC.tmuxSelectWindow, input),

  // -- git --
  gitListWorktrees: (cwd) => rpc(IPC.gitListWorktrees, cwd),

  // -- filesystem --
  fsListDirs: (partial) => rpc(IPC.fsListDirs, partial),

  // -- tmux config management --
  tmuxConfigStatus: () => rpc(IPC.tmuxConfigStatus),
  tmuxSetupConfig: () => rpc(IPC.tmuxSetupConfig),
  tmuxRestoreConfig: () => rpc(IPC.tmuxRestoreConfig),

  // -- clipboard --
  clipboardWriteText: (text) => rpc(IPC.clipboardWriteText, text),
  clipboardReadImage: () => rpc(IPC.clipboardReadImage),

  // -- screenshot detection (SSE push) --
  onScreenshotDetected: (cb) =>
    on<{ source: "clipboard" | "file"; path?: string }>("screenshot", cb),

  // -- file uploads --
  uploadFiles: (input) => rpc(IPC.uploadFiles, input),

  /**
   * Upload raw bytes to the server's /api/upload endpoint.
   *
   * The server (handleUpload) expects:
   *   POST /api/upload?session=<projectName>
   *   X-Filename: <filename>
   *   body: raw bytes
   * and returns { path: <absolute path on server> }.
   *
   * The preload packs args as a single object { projectName, filename, buffer }.
   * We match that exactly; the return value is the remote path string.
   */
  uploadBuffer: async ({ projectName, filename, buffer }) => {
    const url = `${serverBase()}/api/upload?session=${encodeURIComponent(projectName)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-filename": encodeURIComponent(filename),
        "content-type": "application/octet-stream",
      },
      body: buffer,
    });
    let json: { path?: string; error?: string } = {};
    try { json = (await res.json()) as { path?: string; error?: string }; } catch { /* non-JSON body (proxy/HTML error) */ }
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.path ?? "";
  },

  // Electron-only: returns the OS path for a File object.
  // In the browser there is no OS path — return empty string.
  getPathForFile: (_file: File): string => "",

  // -- misc --
  peekRemoteFile: (remotePath) => rpc(IPC.peekRemoteFile, remotePath),
  openExternal: (url) => rpc(IPC.openExternal, url),

  // -- PTY --
  ptySpawn: (opts) => rpc(IPC.ptySpawn, opts),
  ptyWrite: (projectName, data) => rpc(IPC.ptyWrite, projectName, data),
  ptyResize: (projectName, cols, rows) =>
    rpc(IPC.ptyResize, projectName, cols, rows),
  ptyKill: (projectName) => rpc(IPC.ptyKill, projectName),
  onPtyEvent: (cb) => on<PtyEvent>("pty", cb),

  // -- window status --
  onStatusEvent: (cb) => on<WindowStatus[]>("status", cb),

  // -- opencode chat --
  opencodeMessages: (sessionId) => rpc(IPC.opencodeMessages, sessionId),
  onOpencodeEvent: (cb) => on<OpencodeEvent>("opencode", cb),

  /**
   * The preload packs opencodePrompt args into a single object before invoking:
   *   ipcRenderer.invoke(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions })
   * We mirror that packing exactly.
   */
  opencodePrompt: (sessionId, text, model, attachments, mentions) =>
    rpc(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions }),

  opencodeAbort: (sessionId) => rpc(IPC.opencodeAbort, sessionId),
  opencodePermissions: () => rpc(IPC.opencodePermissions),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply })
   */
  opencodePermissionReply: (requestId, reply) =>
    rpc(IPC.opencodePermissionReply, { requestId, reply }),

  // -- question tool --
  opencodeQuestions: () => rpc(IPC.opencodeQuestions),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodeQuestionReply, { requestId, answers })
   */
  opencodeQuestionReply: (requestId, answers) =>
    rpc(IPC.opencodeQuestionReply, { requestId, answers }),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodeQuestionReject, { requestId })
   */
  opencodeQuestionReject: (requestId) =>
    rpc(IPC.opencodeQuestionReject, { requestId }),

  // -- model picker --
  opencodeModels: () => rpc(IPC.opencodeModels),
  opencodeDefaultModel: () => rpc(IPC.opencodeDefaultModel),
  opencodeVcsBranch: (directory) => rpc(IPC.opencodeVcsBranch, directory),

  // -- session management --
  opencodeListSessions: (directory) => rpc(IPC.opencodeListSessions, directory),
  opencodeForkSession: (input) => rpc(IPC.opencodeForkSession, input),
  opencodeCompactSession: (sessionId) =>
    rpc(IPC.opencodeCompactSession, sessionId),
  opencodeDeleteSession: (input) => rpc(IPC.opencodeDeleteSession, input),

  // -- typeahead --
  opencodeCommands: () => rpc(IPC.opencodeCommands),
  opencodeAgents: () => rpc(IPC.opencodeAgents),
  opencodeFindFiles: (input) => rpc(IPC.opencodeFindFiles, input),

  // -- slash-command execution --
  opencodeRunCommand: (input) => rpc(IPC.opencodeRunCommand, input),

  // -- /clear --
  opencodeClearSession: (input) => rpc(IPC.opencodeClearSession, input),
};
