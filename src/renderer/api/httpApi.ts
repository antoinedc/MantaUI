import {
  IPC,
  type AgentFileReady,
  type OpencodeEvent,
  type PtyEvent,
  type WindowStatus,
} from "../../shared/types.js";
import type { Api } from "../../preload/index.js";
import {
  classifyClaimResult,
  networkFailure,
  type ClaimResult,
} from "../mobile/pairingLogic.js";

// ---------------------------------------------------------------------------
// Server base URL resolution (3 deployment contexts):
//   1. localStorage["bui_server"] override (Settings screen / power users) —
//      always wins. This is how the Capacitor APK points itself at the box.
//   2. Page served over http(s) from a real host (tunnel / LAN / domain) →
//      same-origin. Critical for the HTTPS cloudflare tunnel: hardcoding
//      http://IP here gets blocked as Mixed Content from an https page.
//      location.origin carries the page's own scheme, so no protocol skew.
//   3. Otherwise (Capacitor http://localhost, file:) → no fallback. The
//      mobile/web client is currently descoped from v1; fail fast with a
//      clear error so a tester knows to set localStorage["bui_server"]
//      rather than silently hitting some hardcoded box.
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

export function serverBase(): string {
  const v = localStorage.getItem("bui_server");
  if (v) return v.replace(/\/+$/, "");
  const { protocol, hostname, origin } = window.location;
  if ((protocol === "https:" || protocol === "http:") && !LOCAL_HOSTS.has(hostname)) {
    return origin.replace(/\/+$/, "");
  }
  throw new Error(
    "bui mobile/web server not configured. Set localStorage['bui_server'] " +
    "to your server URL (e.g. http://192.168.1.10:8787) and reload.",
  );
}

// ---------------------------------------------------------------------------
// Bearer-token plumbing (M1 auth gate, BET-51)
// ---------------------------------------------------------------------------
//
// bui-server now gates every data route behind a single shared box_token,
// presented as `Authorization: Bearer <box_token>`. The token is obtained via
// the pairing handshake (POST /auth/claim, done by M1-T2's pairing UI) and
// persisted client-side in localStorage["bui_token"] — a sibling of the
// existing localStorage["bui_server"] key.
//
// Two request families:
//   • fetch (/rpc, /api/*) — can set headers → send the Bearer header.
//   • WebSocket (/events, and the /pty terminal WS) — the browser WebSocket
//     API can't set request headers, so the token rides as a ?token= query
//     param instead. The server accepts ?token= on /events + /pty ONLY.
//
// The helpers below are pure (no fetch, no DOM beyond the injected token) so
// the request-building logic is unit-testable without a live server.

/** Storage key holding the box_token (sibling of "bui_server"). */
export const TOKEN_KEY = "bui_token";

/**
 * Thrown when the server rejects a request with HTTP 401 (missing/invalid
 * box_token). The UI layer (M1-T2) catches this to route the user to the
 * pairing screen. Distinguishable from a generic network/RPC Error via
 * `instanceof AuthRequiredError` (and the `name` field for cross-realm safety).
 */
export class AuthRequiredError extends Error {
  readonly status = 401 as const;
  constructor(message = "authentication required") {
    super(message);
    this.name = "AuthRequiredError";
    // Restore prototype chain for `instanceof` under transpiled ES5 targets.
    Object.setPrototypeOf(this, AuthRequiredError.prototype);
  }
}

/** Read the persisted box_token, or null when unpaired. */
export function clientToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t && t.length > 0 ? t : null;
  } catch {
    // localStorage unavailable (private mode / SSR) — treat as unpaired.
    return null;
  }
}

/**
 * Build the headers for a fetch request, attaching the Bearer token when one
 * is present. Pure: pass the token in explicitly so this is testable without
 * touching localStorage. A missing token yields no Authorization header (the
 * request still goes out; the server answers 401 and the caller surfaces
 * AuthRequiredError so the UI can pair).
 */
export function authHeaders(
  token: string | null,
  base: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = { ...base };
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

/**
 * Append `?token=<box_token>` to a WebSocket URL (browsers can't set headers
 * on a WS handshake). Preserves any existing query string. Pure. A null token
 * returns the URL unchanged (server answers 401 on the handshake).
 */
export function withTokenParam(url: string, token: string | null): string {
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Persist the box_token so subsequent rpc/upload/download/WS calls authenticate.
 * Sibling of localStorage["bui_server"]. Wrapped so a private-mode / disabled
 * localStorage throws a clear error the pairing UI can surface rather than
 * silently "succeeding" and then 401-looping.
 */
export function saveClientToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** Clear the persisted box_token (re-pair path: revoked/rotated token). */
export function clearClientToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage unavailable — nothing to clear */
  }
}

/**
 * Exchange a 6-digit pairing code for the box_token via POST /auth/claim, and
 * classify the outcome into a typed {@link ClaimResult}. The claim endpoint is
 * one of the two unauthenticated bootstrap routes (see src/server/auth.mjs), so
 * this does NOT attach the Bearer header. On success the token is persisted
 * here (single write-site) before the result is returned.
 *
 * Pure classification lives in pairingLogic.classifyClaimResult; this function
 * owns only the fetch + the transport-level error → networkFailure() mapping.
 */
export async function submitPairingCode(code: string): Promise<ClaimResult> {
  let res: Response;
  try {
    res = await fetch(`${serverBase()}/auth/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: code }),
    });
  } catch {
    // fetch rejects (offline / DNS / TLS / serverBase() throwing) — no HTTP
    // response reached us.
    return networkFailure();
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body (proxy/HTML error page) — leave null; classify by status */
  }
  const result = classifyClaimResult(res.status, body);
  if (result.ok) saveClientToken(result.boxToken);
  return result;
}

// ---------------------------------------------------------------------------
// Generic JSON-RPC helper
// ---------------------------------------------------------------------------

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(
    `${serverBase()}/rpc/${encodeURIComponent(channel)}`,
    {
      method: "POST",
      headers: authHeaders(clientToken(), { "content-type": "application/json" }),
      body: JSON.stringify({ args }),
    },
  );
  // 401 → unpaired / stale token. Surface a distinguishable error so the UI
  // layer (M1-T2) can route to the pairing screen instead of showing a raw
  // "HTTP 401" toast.
  if (res.status === 401) throw new AuthRequiredError();
  let json: { result?: unknown; error?: string } = {};
  try { json = await res.json(); } catch { /* non-JSON body (proxy/HTML error) */ }
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result as T;
}

// ---------------------------------------------------------------------------
// SSE stream — one shared EventSource, lazily created.
// ---------------------------------------------------------------------------

type Kind = "opencode" | "pty" | "status" | "screenshot" | "agentFile";

const listeners: Record<Kind, Set<(p: unknown) => void>> = {
  opencode: new Set(),
  pty: new Set(),
  status: new Set(),
  screenshot: new Set(),
  agentFile: new Set(),
};

// The live event stream is a WebSocket (not SSE/EventSource): iOS standalone
// PWAs can't reliably receive EventSource, but WebSockets work there (the
// /pty WS already tunnels fine in the installed PWA). Server exposes the
// same {kind,payload} envelope on a /events WS.
let es: WebSocket | null = null;
// WS has no built-in auto-reconnect (EventSource did). Track a backoff timer
// and the current backoff delay (ms; doubles per failed attempt, capped,
// reset to 0 on a healthy onopen).
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _backoff = 0;

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

// WS URL: same origin as serverBase(), http→ws / https→wss. Same-origin so
// it rides the same (Cloudflare) tunnel the page came from — the /pty WS
// proves WS tunnels reliably here, including in the iOS standalone PWA.
//
// Browsers can't set an Authorization header on a WebSocket handshake, so the
// box_token rides as a ?token= query param — the server accepts ?token= on
// /events (and /pty) only. Appended last so it survives if the base URL ever
// carries its own query string.
function wsUrl(): string {
  const base = serverBase().replace(/^http/, "ws") + "/events";
  return withTokenParam(base, clientToken());
}

// (Re)create the shared events WebSocket. Idempotent: a socket that is OPEN
// or CONNECTING is left alone; only a missing/CLOSING/CLOSED one is
// (re)opened. Listeners live in the module `listeners` map (not bound to the
// socket), so swapping `es` is transparent to every on() consumer. The
// {kind,payload} frame is byte-identical to the old SSE envelope, so the
// dispatch body is unchanged.
//
// GOTCHA: serverBase() can throw if localStorage["bui_server"] is unset on
// a non-localhost page (mobile/web descope — fail-fast intent). This
// function is called synchronously from on() inside React useEffects, so
// an uncaught throw white-screens the renderer with no recovery path.
// Catch the throw here, log once, and let the next openStream() call
// retry (the user typically fixes it by entering a server URL and
// reloading). The `bootError` from refresh() carries the user-facing
// message; we just need to not crash before that surfaces.
function openStream() {
  if (es && (es.readyState === WebSocket.OPEN || es.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (es) {
    try { es.close(); } catch { /* already dead */ }
  }
  let url: string;
  try {
    url = wsUrl();
  } catch (e) {
    // No server URL configured. Log once for DevTools and bail — refresh()
    // will produce its own bootError that the UI renders.
    console.warn(
      "[bui] events WebSocket not opened:",
      e instanceof Error ? e.message : String(e),
    );
    return;
  }
  es = new WebSocket(url);
  es.onmessage = (m) => {
    try {
      const { kind, payload } = JSON.parse(m.data as string) as {
        kind: Kind;
        payload: unknown;
      };
      const set = listeners[kind];
      if (set) for (const fn of set) fn(payload);
    } catch {
      // non-JSON / control frame — ignore
    }
  };
  const drop = () => {
    // WebSocket has NO built-in auto-reconnect (EventSource did). Mark the
    // drop and ALWAYS schedule an explicit reconnect with bounded backoff.
    //
    // We intentionally do NOT bail when `listeners` is momentarily empty.
    // iOS standalone PWAs kill the first socket within seconds of a cold
    // launch — frequently BEFORE React mounts and subscribes. An earlier
    // "no listeners → give up" guard made that race permanent: the socket
    // died pre-subscription, reconnect was abandoned, and the app stayed
    // static forever (worked in Safari, which doesn't early-kill sockets).
    // ensureStream() is only ever called from on() (i.e. while a listener
    // is being added), so a listener will exist shortly; keep the socket
    // alive so it's ready. _backoff caps the retry interval; onopen's
    // _hadError path refetches whatever was missed.
    _hadError = true;
    if (_reconnectTimer) return;
    _backoff = Math.min(_backoff ? _backoff * 2 : 1000, 15000);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      openStream();
    }, _backoff);
  };
  es.onerror = drop;
  es.onclose = drop;
  es.onopen = () => {
    _backoff = 0; // healthy connection — reset backoff for any future drop
    if (_hadError) {
      // Reconnect after a drop — refetch state that may have changed while
      // disconnected (existing resync path, unchanged).
      _hadError = false;
      fireResync();
    }
    // else: initial connect — initial load already fetches.
  };
}

// iOS suspends an installed standalone PWA when backgrounded / screen-locked.
// It kills the connection and (in standalone) often fires nothing on resume,
// leaving the socket dead with no events — app "opens once then goes static".
// On return to foreground (visibilitychange→visible) or bfcache restore
// (pageshow), if the socket isn't live, reopen it. _hadError makes the fresh
// onopen drive fireResync() (single resync trigger — don't also call it here).
let _resumeWatchdogInstalled = false;
function installResumeWatchdog() {
  if (_resumeWatchdogInstalled) return;
  _resumeWatchdogInstalled = true;
  const recover = () => {
    if (document.visibilityState !== "visible") return;
    const live =
      es && (es.readyState === WebSocket.OPEN || es.readyState === WebSocket.CONNECTING);
    if (!live) {
      _hadError = true; // make the next onopen fire the resync
      openStream();
    }
  };
  document.addEventListener("visibilitychange", recover);
  window.addEventListener("pageshow", recover);
}

function ensureStream() {
  openStream();
  installResumeWatchdog();
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

  // -- setup wizard --
  // Mobile server doesn't run a setup wizard today (the user has already
  // installed/started the mobile server) — return a stub indicating that.
  // Desktop wires the real implementation through Electron IPC.
  setupProbe: () => rpc(IPC.setupProbe),
  setupBootstrap: () => rpc(IPC.setupBootstrap),

  // -- clipboard --
  clipboardWriteText: (text) => rpc(IPC.clipboardWriteText, text),
  clipboardReadImage: () => rpc(IPC.clipboardReadImage),

  // -- screenshot detection (SSE push) --
  onScreenshotDetected: (cb) =>
    on<{ source: "clipboard" | "file"; path?: string }>("screenshot", cb),

  // Cross-device shared-config sync is desktop-driven (the desktop pushes to /
  // pulls from this server). On mobile there's no inbound config-pull push, so
  // this is a no-op subscription that returns an unsubscriber. Mobile edits
  // persist locally and the desktop pulls them on its next sync.
  onConfigChanged: () => () => {},

  // Desktop OS-notification directives are a desktop-only IPC (the mobile PWA
  // is notified via Web Push, not this channel). No-op on mobile.
  onDesktopNotify: () => () => {},

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
      headers: authHeaders(clientToken(), {
        "x-filename": encodeURIComponent(filename),
        "content-type": "application/octet-stream",
      }),
      body: buffer,
    });
    if (res.status === 401) throw new AuthRequiredError();
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

  // -- agent → device file push (outbox) --
  // The mobile server's outbox poller (src/server/outbox.mjs) publishes
  // `agentFile` bus events when the AI drops a file in ~/.bui-outbox/. On a
  // device these always arrive as a confirm toast (autoPulled:false) since
  // there's no silent disk write — the user taps Save → agentPullFile triggers
  // a browser download.
  onAgentFileReady: (cb) => on<AgentFileReady>("agentFile", cb),
  // "Pull to downloads" on a device = trigger a browser download of the
  // server-local file. We point an <a download> at /api/download and let the
  // WebView/browser save it (the server deletes the source on success — the
  // one-shot mailbox). Returns "" so the ChatPanel toast knows there's no
  // local path to "Reveal" (a desktop-only affordance) and just dismisses.
  agentPullFile: async (remotePath) => {
    try {
      const url = `${serverBase()}/api/download?path=${encodeURIComponent(remotePath)}`;
      // /api/download is a gated data route, but an <a download> element can't
      // carry an Authorization header (and ?token= is scoped to /events + /pty
      // only). Fetch the bytes with the Bearer header, then hand a blob: URL to
      // a synthetic <a> so the browser saves it. Falls back to a direct <a href>
      // when unpaired (server answers 401 there — nothing to save).
      const res = await fetch(url, {
        method: "GET",
        headers: authHeaders(clientToken()),
      });
      if (res.status === 401) throw new AuthRequiredError();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = remotePath.split("/").pop() ?? "file";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the click has a chance to start the save.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (e) {
      // Re-throw auth errors so the UI can route to pairing; swallow the rest
      // (a failed download trigger is non-fatal to the chat flow).
      if (e instanceof AuthRequiredError) throw e;
      /* download trigger failed — non-fatal */
    }
    return "";
  },
  // No OS file manager to reveal into on a phone/browser — no-op.
  revealInFolder: async (_localPath) => {},

  /**
   * Markdown links in ChatPanel always call `window.api.openExternal(href)`
   * after `e.preventDefault()`. On desktop this hops to Electron's
   * `shell.openExternal` which spawns the Mac default browser. On mobile we
   * have no system-browser bridge, but the WebView itself IS a browser —
   * `window.open(url, "_blank")` makes Safari/Chrome handle it correctly
   * (new tab in browser, switch-to-Safari in standalone PWAs, system
   * external browser in the Capacitor APK via the WebView's default link
   * handler). The previous server-side rpc no-op (see local.mjs comment)
   * silently swallowed every chat link click — this restores that behavior.
   * Returns Promise<void> to match the desktop signature; the open call is
   * fire-and-forget.
   */
  openExternal: async (url) => {
    try {
      window.open(url, "_blank", "noreferrer");
    } catch {
      /* popup blocker / about:blank in restricted contexts — silent */
    }
  },

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
  opencodeMessagesCached: (sessionId) =>
    rpc(IPC.opencodeMessagesCached, sessionId),
  opencodeMessagesReconcile: (sessionId) =>
    rpc(IPC.opencodeMessagesReconcile, sessionId),
  opencodeMessage: (sessionId, messageId) =>
    rpc(IPC.opencodeMessage, sessionId, messageId),
  opencodeOpenStream: (sessionId) => rpc(IPC.opencodeOpenStream, sessionId),
  opencodeCloseStream: (sessionId) => rpc(IPC.opencodeCloseStream, sessionId),
  onOpencodeEvent: (cb) => on<OpencodeEvent>("opencode", cb),

  /**
   * The preload packs opencodePrompt args into a single object before invoking:
   *   ipcRenderer.invoke(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions })
   * We mirror that packing exactly.
   */
  opencodePrompt: (sessionId, text, model, attachments, mentions) =>
    rpc(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions }),

  opencodeAbort: (sessionId) => rpc(IPC.opencodeAbort, sessionId),
  opencodePermissions: (sessionId) =>
    rpc(IPC.opencodePermissions, sessionId),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply, sessionId })
   */
  opencodePermissionReply: (requestId, reply, sessionId) =>
    rpc(IPC.opencodePermissionReply, { requestId, reply, sessionId }),

  // -- question tool --
  opencodeQuestions: (sessionId) => rpc(IPC.opencodeQuestions, sessionId),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodeQuestionReply, { requestId, answers, sessionId })
   */
  opencodeQuestionReply: (requestId, answers, sessionId) =>
    rpc(IPC.opencodeQuestionReply, { requestId, answers, sessionId }),

  /**
   * Preload packs: ipcRenderer.invoke(IPC.opencodeQuestionReject, { requestId, sessionId })
   */
  opencodeQuestionReject: (requestId, sessionId) =>
    rpc(IPC.opencodeQuestionReject, { requestId, sessionId }),

  // -- model picker --
  opencodeModels: () => rpc(IPC.opencodeModels),
  opencodeGetProviders: () => rpc(IPC.opencodeGetProviders),
  opencodeSetProviders: (ops) => rpc(IPC.opencodeSetProviders, ops),
  opencodeDiscoverModels: (baseURL, apiKey) => rpc(IPC.opencodeDiscoverModels, baseURL, apiKey),
  opencodeRestart: () => rpc(IPC.opencodeRestart),
  opencodeDefaultModel: () => rpc(IPC.opencodeDefaultModel),
  opencodeVcsBranch: (directory) => rpc(IPC.opencodeVcsBranch, directory),

  // -- session management --
  opencodeListSessions: (directory) => rpc(IPC.opencodeListSessions, directory),
  opencodeForkSession: (input) => rpc(IPC.opencodeForkSession, input),
  opencodeCompactSession: (sessionId) =>
    rpc(IPC.opencodeCompactSession, sessionId),
  opencodeDeleteSession: (input) => rpc(IPC.opencodeDeleteSession, input),

  // -- scheduled prompts (bui-server owned; in-process on mobile) --
  scheduleList: (sessionId) => rpc(IPC.scheduleList, sessionId),
  scheduleDelete: (id) => rpc(IPC.scheduleDelete, id),

  // -- secrets (bui-server owned; in-process on mobile) --
  secretsList: (sessionId, all) => rpc(IPC.secretsList, sessionId, all),
  secretsSet: (input) => rpc(IPC.secretsSet, input),
  secretsDelete: (id) => rpc(IPC.secretsDelete, id),

  // -- inbound webhooks (bui-server owned; in-process on mobile) --
  webhookList: (sessionId) => rpc(IPC.webhookList, sessionId),
  webhookDelete: (id) => rpc(IPC.webhookDelete, id),

  // -- typeahead --
  opencodeCommands: () => rpc(IPC.opencodeCommands),
  opencodeAgents: () => rpc(IPC.opencodeAgents),
  opencodeFindFiles: (input) => rpc(IPC.opencodeFindFiles, input),

  // -- slash-command execution --
  opencodeRunCommand: (input) => rpc(IPC.opencodeRunCommand, input),

  // -- /clear --
  opencodeClearSession: (input) => rpc(IPC.opencodeClearSession, input),

  // -- auto-rename: throwaway-session title generation --
  opencodeGenerateTitle: (input) => rpc(IPC.opencodeGenerateTitle, input),

  // -- voice (Groq STT + classifier) --
  // The RPC body is JSON, so the ArrayBuffer can't ride along raw. Base64-
  // encode it here; rpc.mjs decodes back to a Buffer on the server side.
  // For typical 5s clips this is ~70-100KB → ~95-135KB base64; well under
  // the server's per-request body cap and not worth a multipart endpoint.
  voiceTranscribe: ({ buffer, mime }) => {
    const b64 = arrayBufferToBase64(buffer);
    return rpc(IPC.voiceTranscribe, { buffer: b64, mime });
  },
  voiceClassifyCommand: (input) => rpc(IPC.voiceClassifyCommand, input),
};

// Base64-encode an ArrayBuffer in chunks. `btoa(String.fromCharCode(...))`
// blows the call stack past ~125k bytes; chunked apply keeps it safe for
// any clip size MediaRecorder will hand us.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
