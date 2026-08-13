// opencode HTTP proxy — server-side.
//
// Opencode runs on the SAME machine as this Node server, listening at
// http://127.0.0.1:4096. No SSH tunnel or port-forward is needed; the desktop
// + mobile clients reach this server over HTTPS (paired, Bearer-token auth).
//
// Export names are kept exactly as the rpc-wiring task expects them (see
// task comments on each function).

import { spawn as cpSpawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { expandTilde, patchPath } from "../shared/paths.mjs";
import {
  CREDENTIALS_PATH,
  parseCredentials,
  isRefreshTokenExpired,
  classifyRefreshOutcome,
  isClaudeCredentialError,
  shouldAttemptRecovery,
  shouldRefreshAhead,
  extractClaudeAuthUrl,
  classifyClaudeLoginProgress,
  defaultCredentialsValidator,
  restoreFromBackup,
} from "./claudeAuth.mjs";
// BET-418 §A removed the BET-380 background-job permission/question routing;
// delegate.mjs ownership helpers (relatedSessionIds/jobNameForSession) are no
// longer imported here.

const REMOTE_PORT = 4096;

/** Build the full URL for an opencode API path. */
export function apiUrl(path) {
  return `http://127.0.0.1:${REMOTE_PORT}${path}`;
}

// ===== Loopback connection pooling =====
//
// Node's global `fetch` (undici) opens a FRESH TCP socket to 127.0.0.1:4096
// for every call and closes it when the response is consumed — each closed
// socket lingers in TIME_WAIT. Under load (a reconcile/list sweep across many
// sessions) this burst-creates thousands of one-shot sockets and can exhaust
// the loopback ephemeral-port range → new connect() fails with EADDRNOTAVAIL.
// Same socket-pooling rationale as the desktop's previous forwardFetch path —
// but here the connection goes straight to opencode on this same box (no SSH
// forward). There's no concurrency semaphore here (mobile fan-out is bounded by
// a single client), so we just pool the sockets.
//
// http.Agent gives fetch a keep-alive pool so it reuses a bounded set of
// sockets instead of burning one per call. maxSockets 16 matches the desktop
// FORWARD_FETCH_MAX_CONCURRENCY for consistency. The SSE stream path
// (openEventStream) deliberately does NOT use this agent — a long-lived
// streaming body would pin a pool socket forever.
const ocAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 16,
  maxFreeSockets: 16,
});

/** Test-only accessor: assert the pool config / single-instance invariant. */
export function _getOcAgent() {
  return ocAgent;
}

// The transport ocFetch uses. Production = the pooled http.request impl below
// (`pooledOcRequest`). Tests can swap in a `(url, init) => Promise<Response>`
// stub via `_setOcTransport` so they intercept requests without a live server
// (the old tests mocked globalThis.fetch, which the pooled path bypasses).
let ocTransport = null; // lazily set to pooledOcRequest after it's defined

/** Test-only: override the transport ocFetch dispatches through. Pass null to
 *  restore the default pooled transport. */
export function _setOcTransport(fn) {
  ocTransport = fn;
}

/** Test-only: exercise the real pooled transport directly (bypasses any
 *  installed test stub) so a socket-reuse test can hit a live local server. */
export function _pooledOcRequest(url, init) {
  return pooledOcRequest(url, init);
}

// A `fetch` replacement for opencode's NON-STREAMING endpoints that routes the
// request through the keep-alive pool via node:http.request (or a test stub).
//
// NOTE: undici's global `fetch` does NOT honor the classic `agent` option (nor
// can we pass a pooled undici `dispatcher` — the Node-bundled undici isn't a
// resolvable module, so importing it would mean a new npm dependency). Verified
// on this box: `fetch(url, { agent })` reuses undici's own default pool
// regardless of the agent passed, so it can't be capped/controlled. So we issue
// the request via http.request through our own http.Agent and adapt the
// IncomingMessage into a WHATWG Response — every caller keeps using `.ok` /
// `.status` / `.json()` / `.text()` unchanged. Same http.Agent-then-adapt
// technique the desktop's previous pooledRequest used (over the SSH forward);
// here the same pattern goes straight to opencode on this box.
function ocFetch(url, init) {
  return (ocTransport ?? pooledOcRequest)(url, init);
}

function pooledOcRequest(url, init) {
  return new Promise((resolve, reject) => {
    const method = (init?.method ?? "GET").toString();
    const headers = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) headers[k] = String(v);
    }
    const req = http.request(url, { method, headers, agent: ocAgent }, (msg) => {
      const body = new ReadableStream({
        start(controller) {
          msg.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
          msg.on("end", () => {
            try { controller.close(); } catch { /* already closed */ }
          });
          msg.on("error", (err) => {
            try { controller.error(err); } catch { /* already errored */ }
          });
        },
        cancel() {
          // Return the socket to the pool promptly when the body is discarded.
          msg.destroy();
        },
      });
      const status = msg.statusCode ?? 0;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(msg.headers)) {
        if (Array.isArray(v)) {
          for (const one of v) resHeaders.append(k, one);
        } else if (typeof v === "string") {
          resHeaders.set(k, v);
        }
      }
      const nullBody = status === 204 || status === 205 || status === 304;
      resolve(
        new Response(nullBody ? null : body, {
          status,
          statusText: msg.statusMessage ?? "",
          headers: resHeaders,
        }),
      );
    });
    req.on("error", reject);
    const bodyInit = init?.body;
    if (bodyInit != null && method !== "GET" && method !== "HEAD") {
      req.write(bodyInit);
    }
    req.end();
  });
}

// Drain-and-discard a response body without reading its content. With a
// keep-alive pool, an UNCONSUMED body pins its socket open (undici won't
// return it to the pool until read/cancelled), defeating reuse and
// re-introducing the churn this fix removes. Every ocFetch caller that gets a
// Response but returns/throws WITHOUT reading the body must call this on the
// non-consuming exit. Safe on an already-consumed/bodyless Response.
export async function discardBody(res) {
  try {
    await res?.body?.cancel();
  } catch {
    /* already consumed / locked / errored */
  }
}

/**
 * Parse a single SSE text line into a JS object.
 * Returns null for comment lines (": …") and non-data lines.
 * Mirrors the per-line parsing inside opencode.ts's subscribeEvents gen().
 */
export function parseSseFrame(line) {
  if (!line.startsWith("data:")) return null;
  try {
    return JSON.parse(line.slice(5).trimStart());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-session project-directory scope
// ---------------------------------------------------------------------------
//
// opencode's tool execution runs from the server's startup cwd, NOT from
// session.directory metadata. To make tools execute in the project worktree,
// every session-mutating POST must carry `?directory=<absolute-worktree-path>`.
// opencode's `/event` SSE stream is ALSO scoped by `?directory=`: events from
// a scoped POST land only on the matching scoped stream. The bus below
// (subscribeEvents) opens one subscription per directory we know about so
// every project's events flow back into the renderer.
//
// We cache session→directory locally so each prompt/command POST doesn't
// require an extra GET /session lookup.

const sessionDirectoryCache = new Map();
const directoryListeners = new Set(); // notified on new directory

function rememberSessionDirectory(sessionId, directory) {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) return;
  const prev = sessionDirectoryCache.get(sessionId);
  sessionDirectoryCache.set(sessionId, directory);
  if (prev !== directory) {
    for (const fn of directoryListeners) {
      try { fn(directory); } catch { /* ignore listener error */ }
    }
  }
}

// Cache a session→directory WITHOUT opening a scoped stream. Used by the
// subscribe bootstrap: we want existing sessions' dirs resolvable (so the
// first prompt is fast) but we must NOT open a `/event?directory=` stream for
// every session in the catalog. On a box with many opencode workspaces (e.g.
// Multica), listSessions() returns ~100 dirs, and eagerly streaming each one
// piled up hundreds of connections that buried opencode serve and made every
// request crawl. Streams now open on demand via ensureStreamForDirectory when
// a session is actually used (prompt / message fetch).
function cacheSessionDirectoryQuiet(sessionId, directory) {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) return;
  sessionDirectoryCache.set(sessionId, directory);
}

// Opens the scoped stream for a directory if a subscription is active. Set by
// subscribeEvents (to its openFor); called by getSessionDirectoryQuery so an
// in-use session's events arrive even though the bootstrap didn't pre-open it.
let ensureStreamForDirectory = null;

// ---------------------------------------------------------------------------
// Scoped-stream readiness gate (BET-115 fix C)
//
// opencode's `/event?directory=` is a fresh subscription every time it opens
// (fresh session/reconnect), and events emitted BEFORE the subscription
// registers upstream are lost forever — no replay. `sendPrompt` (and the
// other session-mutating calls) POST through `getSessionDirectoryQuery`,
// which fire-and-forgets `ensureStreamForDirectory(dir)`. On a brand-new
// session that races: the POST can land before the scoped stream is actually
// listening, so the first turn's events vanish and the UI looks frozen.
//
// `streamReadyState` tracks, per directory key ("" = global), a promise that
// resolves the first time `openEventStream`'s upstream fetch comes back OK
// (see `onConnect` below). `getSessionDirectoryQuery` awaits it with a 5s
// bound before returning — long enough for a normal connect, short enough
// that a wedged opencode degrades to "send anyway" rather than hanging the
// prompt forever.
// ---------------------------------------------------------------------------
const streamReadyState = new Map(); // key -> { promise, resolve }

// Test-only: shrink the 5s readiness bound so tests don't have to sleep for
// real. Reset to null (→ default 5000) between tests.
let readinessTimeoutMsOverride = null;
export function _setReadinessTimeoutMs(ms) {
  readinessTimeoutMsOverride = ms;
}

function makePendingReadyEntry() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function getOrCreateStreamReady(key) {
  let entry = streamReadyState.get(key);
  if (!entry) {
    entry = makePendingReadyEntry();
    streamReadyState.set(key, entry);
  }
  return entry;
}

/** Called by openEventStream's onConnect: the scoped subscription is live. */
function markStreamConnected(key) {
  getOrCreateStreamReady(key).resolve();
}

/**
 * Called by openEventStream's onDisconnect: the scoped subscription dropped.
 * Re-arm with a FRESH pending promise so a prompt sent during the reconnect
 * window waits for the NEW subscription rather than resolving instantly off
 * the stale (already-resolved) promise. Callers that already captured the old
 * promise reference are still bounded by the 5s race in
 * getSessionDirectoryQuery, so this can't hang a caller indefinitely.
 */
function markStreamDisconnected(key) {
  streamReadyState.set(key, makePendingReadyEntry());
}

/** Test-only: clear readiness state between scenarios. */
export function _resetStreamReadyState() {
  streamReadyState.clear();
}

// ---------------------------------------------------------------------------
// Scoped-stream eviction (unbounded-stream-growth fix)
//
// opencode's `/event?directory=` streams open lazily (good) but the subscribe
// registry never removed an entry, so every distinct directory ever touched
// kept a permanent SSE connection to opencode. On a box that churns one-shot
// workspaces (e.g. the Multica watchdog spawns a fresh throwaway
// `multica_workspaces/.../workdir` every run), this grows without bound: a
// dead workdir's stream lingers forever, and the matching per-directory state
// inside opencode accumulates too — the slow-degradation the user sees.
//
// Eviction is SAFE because every stream is re-openable on demand:
// `getSessionDirectoryQuery` calls `ensureStreamForDirectory(dir)` (idempotent)
// before every prompt/message fetch, so closing an idle stream cannot lose
// events for an active session — the next use re-opens it. A prompt (write)
// additionally AWAITS the readiness gate so it cannot race ahead of its own
// subscription; a transcript fetch (read) opens the stream but does not wait,
// because a read has no reply to lose and the wait is up to 5s on exactly the
// cold/just-evicted stream this eviction creates. The global stream (key "")
// is NEVER evicted (it carries unscoped events and has no directory to
// disappear).
//
// A stream is evicted when its directory:
//   (a) no longer exists on disk (the one-shot workdir was deleted), OR
//   (b) has seen no event/use for STREAM_IDLE_MS, OR
//   (c) is over the STREAM_MAX hard cap — the least-recently-active scoped
//       streams are dropped down to the cap (LRU).
// ---------------------------------------------------------------------------

export const STREAM_IDLE_MS = 2 * 60 * 60 * 1000; // 2h idle → evict
export const STREAM_MAX = 32; // hard LRU cap on scoped streams (excl. global)
export const STREAM_SWEEP_MS = 5 * 60 * 1000; // sweep cadence

/**
 * Pure: decide which scoped-stream keys to evict. The global key ("") is
 * always retained. `existsFn(dir)` reports whether the directory still exists
 * on disk (injected so the logic is testable without touching the FS).
 *
 * @param {object} args
 * @param {Iterable<string>} args.keys        current stream keys (incl. "")
 * @param {Map<string,number>} args.lastActivity  key -> last-active epoch ms
 * @param {(dir:string)=>boolean} args.existsFn    directory-exists predicate
 * @param {number} args.now                    epoch ms
 * @param {number} [args.idleMs=STREAM_IDLE_MS]
 * @param {number} [args.maxStreams=STREAM_MAX]
 * @returns {string[]} keys to close (never includes "")
 */
export function selectStreamsToEvict({
  keys,
  lastActivity,
  existsFn,
  now,
  idleMs = STREAM_IDLE_MS,
  maxStreams = STREAM_MAX,
}) {
  const scoped = [...keys].filter((k) => k !== "");
  const evict = new Set();

  for (const key of scoped) {
    // (a) directory gone from disk → evict.
    let exists = true;
    try {
      exists = existsFn(key);
    } catch {
      exists = true; // an existsFn error is not proof the dir is gone; keep it.
    }
    if (!exists) {
      evict.add(key);
      continue;
    }
    // (b) idle past the threshold → evict.
    const last = lastActivity.get(key) ?? 0;
    if (now - last > idleMs) evict.add(key);
  }

  // (c) LRU hard cap over the survivors: keep the most-recently-active up to
  // maxStreams, evict the rest (least-recently-active first).
  const survivors = scoped.filter((k) => !evict.has(k));
  if (survivors.length > maxStreams) {
    survivors
      .sort((a, b) => (lastActivity.get(b) ?? 0) - (lastActivity.get(a) ?? 0))
      .slice(maxStreams)
      .forEach((k) => evict.add(k));
  }

  return [...evict];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSessionDirectory(sessionId) {
  try {
    const res = await ocFetch(apiUrl(`/session/${encodeURIComponent(sessionId)}`));
    if (!res.ok) {
      await discardBody(res);
      return null;
    }
    const body = await res.json();
    return typeof body?.directory === "string" ? body.directory : null;
  } catch {
    return null;
  }
}

async function getSessionDirectoryQuery(sessionId, { awaitReady = true } = {}) {
  let dir = sessionDirectoryCache.get(sessionId);
  if (!dir) {
    const fetched = await fetchSessionDirectory(sessionId);
    if (fetched) {
      rememberSessionDirectory(sessionId, fetched);
      dir = fetched;
    }
  }
  // This session is genuinely being used (prompt / message fetch routes here),
  // so ensure its scoped stream is open — covers BOTH the freshly-fetched dir
  // and a dir that the bootstrap cached quietly (cacheSessionDirectoryQuiet
  // doesn't open a stream). opencode emits this prompt's events only on the
  // scoped channel; without the stream they're lost and the session looks
  // frozen. Idempotent (openFor no-ops if already open).
  //
  // Readiness gate: wait (bounded) for the scoped stream's FIRST successful
  // connect before returning, so a session-mutating call (sendPrompt et al.)
  // can't race ahead of its own event subscription and lose the reply. Bound
  // is deliberately short — a wedged opencode must never hang the prompt.
  //
  // `awaitReady:false` (read-only callers — see listMessages) still OPENS the
  // stream but does not wait for it. A read has no reply that could be lost to
  // the race the gate protects against, and the wait is up to 5s on a cold or
  // LRU-evicted stream.
  if (dir && ensureStreamForDirectory) {
    try { ensureStreamForDirectory(dir); } catch { /* non-fatal */ }
    if (awaitReady) {
      const ready = getOrCreateStreamReady(dir).promise;
      await Promise.race([ready, sleep(readinessTimeoutMsOverride ?? 5000)]);
    }
  }
  return dir ? `?directory=${encodeURIComponent(dir)}` : "";
}

/** Test-only: reset cache between scenarios. */
export function _resetSessionDirectoryCache() {
  sessionDirectoryCache.clear();
}

/**
 * Test-only: register a directory listener (same set the SSE manager uses).
 * Lets tests assert the lazy-fetch path actually notifies — the listener
 * firing is what opens the scoped stream, and the bug was a bare cache.set
 * that skipped it. Returns an unsubscribe fn.
 */
export function _onSessionDirectoryAdded(fn) {
  directoryListeners.add(fn);
  return () => directoryListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a new session in the given directory with an optional title.
 *  @param {{ directory: string, title?: string }} opts
 *  @returns {Promise<{ id: string, title: string, directory: string, projectID: string }>}
 */
// opencode requires an ABSOLUTE directory: given `~/projects/x` it resolves
// the tilde against its own server cwd ($HOME), persisting the corrupt
// `/home/dev/~/projects/x`. resolveProjectCwd-fed callers (/clear) pass tilde
// paths. The server runs ON the opencode host, so `expandTilde` from
// src/shared/paths.mjs expands against this process's own $HOME before
// opencode sees the path.
export async function createSession({ directory, title = "", permission }) {
  const absDir = expandTilde(directory);
  const url = `/session?directory=${encodeURIComponent(absDir)}`;
  const body = { title };
  // BET-418 §A: a background job is created with a permission ruleset so it
  // never asks once running. opencode's POST /session accepts a `permission`
  // array (verified working against opencode v1.15.12) — forward it verbatim
  // when provided. The ruleset MUST end with a catch-all deny (enforced by
  // buildPermissionRuleset in delegate.mjs).
  if (Array.isArray(permission) && permission.length > 0) {
    body.permission = permission;
  }
  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode createSession ${res.status}: ${await res.text()}`);
  }
  const sess = await res.json();
  // Fall back to the EXPANDED dir, never the raw tilde (the bug we fixed).
  rememberSessionDirectory(sess.id, sess.directory ?? absDir);
  return sess;
}

// Part types NO client renders. `slim` drops them from the wire.
//
// The desktop renderer DOES render `reasoning` (ctrl+O) and `patch`/`file`
// parts, which is exactly why slim is OPT-IN and desktop never asks for it:
// only the native iOS transcript mapper, which switches on `text` and `tool`
// and falls through everything else, sets it. Measured on a real 63-message
// session these are ~20% of the payload, decoded on-device and then dropped.
const SLIM_DROP_PART_TYPES = new Set(["step-start", "step-finish", "reasoning", "snapshot"]);

/**
 * Shrink a transcript for a client that renders only text + tool parts.
 *
 * Two reductions, both lossless for such a client:
 *
 *  1. Drop the part types in SLIM_DROP_PART_TYPES. This is a DENY-list, not an
 *     allow-list, so a part type opencode adds later still reaches the client
 *     rather than silently vanishing.
 *  2. Drop `state.metadata.output` when it is byte-identical to `state.output`.
 *     opencode writes a tool's stdout to BOTH fields, and on a real session
 *     that duplicate alone was ~30% of the whole payload. `metadata.output` is
 *     the LIVE stream while a tool runs (`state.output` only exists once it
 *     completes), so it is dropped ONLY on the exact-match case — a running
 *     tool keeps its live text.
 *
 * Pure: takes and returns plain JSON, no I/O. The input is not mutated.
 * @param {any[]} messages
 */
export function slimTranscript(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    const parts = Array.isArray(msg?.parts) ? msg.parts : null;
    if (!parts) return msg;
    const kept = [];
    for (const part of parts) {
      if (SLIM_DROP_PART_TYPES.has(part?.type)) continue;
      kept.push(stripDuplicateToolOutputPart(part));
    }
    return { ...msg, parts: kept };
  });
}

/** Strip a single message's byte-identical duplicate tool output — lossless.
 *  Only exact duplicates (metadata.output === state.output) are removed; the
 *  renderer's `resolveToolOutput` prefers `state.output`, so the live text is
 *  preserved. Applied to EVERY transcript for every client (listMessages and
 *  the single-message splice getMessage both run it), independent of the
 *  iOS-only `slim` option. Does not mutate the input. */
export function stripDuplicateToolOutput(message) {
  if (!message || !Array.isArray(message.parts)) return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    const next = stripDuplicateToolOutputPart(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

/** Drop a tool part's duplicated stdout. Returns the part unchanged otherwise. */
function stripDuplicateToolOutputPart(part) {
  const state = part?.state;
  const metadata = state?.metadata;
  if (!metadata || typeof metadata !== "object") return part;
  if (typeof metadata.output !== "string") return part;
  if (metadata.output !== state.output) return part;
  const { output: _dropped, ...restMetadata } = metadata;
  return { ...part, state: { ...state, metadata: restMetadata } };
}

/** Fetch a session's message transcript.
 *
 *  @param {string} sessionId
 *  @param {{limit?: number, slim?: boolean}} [opts]
 *    limit — return only the most recent N messages (opencode's `?limit=`
 *      returns the TAIL, chronologically ordered; verified live). Omit for the
 *      whole history (the desktop's "Load earlier" / follow-up refetches).
 *    slim  — additionally drop parts the iOS client never renders (opt-in;
 *      mobile only). Duplicate tool stdout is ALWAYS stripped for every
 *      client regardless of `slim` (see stripDuplicateToolOutput).
 */
export async function listMessages(sessionId, opts = {}) {
  // Open the session's scoped event stream BEFORE reading the transcript
  // snapshot, so live events emitted around the snapshot land on the now-open
  // stream instead of vanishing (opencode has no replay).
  //
  // We do NOT await the readiness gate here. The gate exists so a
  // session-MUTATING call (sendPrompt et al.) can't race ahead of its own
  // event subscription and lose the reply; a read has no reply to lose. On a
  // cold or evicted stream that wait costs up to 5s, and it was being paid in
  // front of every transcript fetch — the single largest component of "opening
  // a session on mobile is slow". `ensureStreamForDirectory` still runs, so
  // the stream is opened either way; we just don't block the read on it.
  let query = "";
  try {
    query = await getSessionDirectoryQuery(sessionId, { awaitReady: false });
  } catch {
    /* non-fatal: fetch the snapshot regardless */
  }
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : null;
  if (limit != null) query += `${query ? "&" : "?"}limit=${limit}`;
  const url = `/session/${encodeURIComponent(sessionId)}/message${query}`;
  const res = await ocFetch(apiUrl(url));
  if (!res.ok) {
    throw new Error(`opencode listMessages ${res.status}: ${await res.text()}`);
  }
  const messages = await res.json();
  const stripped = messages.map(stripDuplicateToolOutput);
  return opts.slim ? slimTranscript(stripped) : stripped;
}

/** Fetch a single message by id (GET /session/{id}/message/{messageID}).
 *  Returns null on miss/error so the caller can fall back to a full refetch.
 *  @param {string} sessionId
 *  @param {string} messageId
 */
export async function getMessage(sessionId, messageId) {
  try {
    const url = `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
    const res = await ocFetch(apiUrl(url));
    if (!res.ok) {
      await discardBody(res);
      return null;
    }
    return stripDuplicateToolOutput(await res.json());
  } catch {
    return null;
  }
}

/**
 * Send a user message (prompt_async — returns 204 immediately; response
 * streams via SSE). Model is per-prompt; omit to use opencode's default.
 *
 * @param {{ sessionId: string, text: string, model?: { providerID: string, modelID: string, variant?: string }, attachments?: Array<{ remotePath: string, mime: string, filename?: string }>, mentions?: Array<{ name: string, source: { value: string, start: number, end: number } }> }} opts
 */
export async function sendPrompt({ sessionId, text, model, attachments, mentions }) {
  // Scope tools + events to the session's worktree. The matching per-directory
  // subscription in subscribeEvents below ensures the events still reach
  // listeners (the global /event subscription wouldn't see them otherwise).
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/prompt_async${dirQ}`;
  const parts = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  if (mentions) {
    for (const m of mentions) {
      parts.push({ type: "agent", name: m.name, source: m.source });
    }
  }
  parts.push({ type: "text", text });

  const body = { parts };
  if (model) {
    body.model = { providerID: model.providerID, modelID: model.modelID };
    if (model.variant) body.variant = model.variant;
  }

  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode sendPrompt ${res.status}: ${await res.text()}`);
  }
}

/** Abort the running generation for a session (idempotent).
 *
 *  MUST carry `?directory=<session.directory>` like every other session-
 *  mutating POST (prompt_async, command, fork, compact). opencode v2 routes
 *  session mutations to the per-directory worker; an unscoped abort lands
 *  on the wrong worker so the per-directory worker keeps generating. The
 *  renderer's running indicator clears because opencode emits *some* idle
 *  signal in response, but the model loop never actually stops.
 *  @param {string} sessionId
 */
export async function abortSession(sessionId) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/abort${dirQ}`;
  const res = await ocFetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode abortSession ${res.status}: ${await res.text()}`);
  }
}

/** List sessions scoped to a project directory.
 *  @param {string} [directory]
 */
export async function listSessions(directory) {
  const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const res = await ocFetch(apiUrl(`/session${qs}`));
  if (!res.ok) {
    throw new Error(`opencode listSessions ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Does this opencode session still exist?
 *
 * Answered with a DIRECT lookup (`GET /session/{id}`), never by scanning
 * `listSessions()`. opencode caps `GET /session` at 100 records and the
 * unscoped form returns the 100 most-recently-updated sessions BOX-WIDE, so on
 * any box with real history a perfectly healthy session is absent from that
 * page — a scan reports it as gone. That false "gone" is destructive: the
 * delegate sweeper reads it as "parent session gone", stops the background job
 * (BET-418 §B) and stamps it `stopped by user`, so every delegated job died
 * within a sweep tick and the sidebar never had a job to show.
 *
 * Returns:
 *   true   — 200, the session is alive
 *   false  — 404, the session is genuinely gone (the ONLY negative)
 *   true   — anything else (5xx, network error): best-effort "assume alive",
 *            preserving the existing rule that a transient opencode blip must
 *            never orphan a healthy job. Only a definitive 404 is destructive.
 *
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
export async function sessionExists(sessionId) {
  if (!sessionId) return false;
  try {
    const res = await ocFetch(apiUrl(`/session/${encodeURIComponent(sessionId)}`));
    if (res.status === 404) return false;
    return true;
  } catch {
    return true; // transient failure — never treat as "gone"
  }
}

/**
 * Fork a session (copies history up to messageID into a new session).
 * @param {{ sessionId: string, messageID?: string }} opts
 */
export async function forkSession({ sessionId, messageID }) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/fork${dirQ}`;
  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  if (!res.ok) {
    throw new Error(`opencode forkSession ${res.status}: ${await res.text()}`);
  }
  const sess = await res.json();
  rememberSessionDirectory(sess.id, sess.directory);
  return sess;
}

/** Summarize a session in-place to free context (v2 compact endpoint).
 *  @param {string} sessionId
 */
export async function compactSession(sessionId) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/api/session/${encodeURIComponent(sessionId)}/compact${dirQ}`;
  const res = await ocFetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode compactSession ${res.status}: ${await res.text()}`);
  }
}

/** Delete a session and its messages on the opencode server.
 *  Named deleteSessionRaw to distinguish from any local session cleanup.
 *  @param {string} sessionId
 */
export async function deleteSessionRaw(sessionId) {
  sessionDirectoryCache.delete(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}`;
  const res = await ocFetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`opencode deleteSession ${res.status}: ${await res.text()}`);
  }
}

// Auto-rename: generate a 1-2 word title via a THROWAWAY session.
// opencode has no one-shot completion endpoint, so we create→prompt→poll→delete
// a hidden session. Returns the RAW model reply; the renderer sanitizes it.
// Returns "" on timeout/failure so the caller skips the rename rather than
// erroring.
export async function generateSessionTitle({ directory, instruction }) {
  const absDir = expandTilde(directory);
  let model = null;
  try {
    model = await getDefaultModel();
  } catch {
    /* non-fatal */
  }

  let sid = null;
  try {
    const createRes = await ocFetch(
      apiUrl(`/session?directory=${encodeURIComponent(absDir)}`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "manta-auto-title" }),
      },
    );
    if (!createRes.ok) {
      await discardBody(createRes);
      return "";
    }
    sid = (await createRes.json()).id;

    const promptBody = { parts: [{ type: "text", text: instruction }] };
    if (model) {
      promptBody.model = { providerID: model.providerID, modelID: model.modelID };
    }
    const promptRes = await ocFetch(
      apiUrl(
        `/session/${encodeURIComponent(sid)}/prompt_async?directory=${encodeURIComponent(absDir)}`,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(promptBody),
      },
    );
    if (!promptRes.ok) {
      await discardBody(promptRes);
      return "";
    }

    const msgUrl = apiUrl(`/session/${encodeURIComponent(sid)}/message`);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await ocFetch(msgUrl);
      if (!r.ok) {
        await discardBody(r);
        continue;
      }
      const msgs = await r.json();
      const text = extractAssistantText(msgs);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  } finally {
    if (sid) {
      try {
        await deleteSessionRaw(sid);
      } catch {
        /* ignore */
      }
    }
  }
}

function extractAssistantText(msgs) {
  const out = [];
  for (const m of msgs ?? []) {
    if (m?.info?.role !== "assistant") continue;
    for (const p of m.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    }
  }
  return out.join("").trim();
}

// ---------------------------------------------------------------------------
// Permission flow (Write/Edit/Bash approval)
// ---------------------------------------------------------------------------

// Background delegation jobs no longer route their permission/question asks
// into the parent's panel (BET-418 §A): a job is created with a pre-flight
// permission ruleset so it never asks anything once running. The BET-380
// widening (relatedSessionIds / jobNameForSession / fromJobName stamping /
// merged multi-directory fetch) is deleted. listPermissions/listQuestions are
// back to plain scoped reads of the requested session's directory.

/** List all pending tool-use permissions.
 *  Scoped to the session's directory when sessionId is provided. opencode's
 *  WorkspaceRoutingMiddleware makes the UNSCOPED endpoint return [] for
 *  sessions bound to a non-default directory — so without `?directory=` the
 *  PermissionCard never appears on mobile and the turn hangs forever (the
 *  live `per_…` is sitting in the server's pending map, we just can't see
 *  it). Mirrors listQuestions below + desktop listPermissions.
 *  @param {string} [sessionId]
 *  @returns {Promise<Array<{ id: string, sessionID: string, permission: string, ... }>>}
 */
export async function listPermissions(sessionId) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const res = await ocFetch(apiUrl(`/permission${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listPermissions ${res.status}: ${await res.text()}`);
  }
  const all = await res.json();
  const list = Array.isArray(all) ? all : [];
  // opencode's /permission is `?directory=`-scoped, not session-scoped: a
  // directory can hold pending items from multiple sessions (orphan/subagent
  // sessions included). Filter the directory-wide response down to the
  // requested sessionId so callers never see cross-session leaks (BET-110).
  // Background-job children no longer surface here (BET-418 §A).
  if (!sessionId) return list;
  return list.filter((p) => p.sessionID === sessionId);
}

/** Approve or deny a permission request.
 *  Same workspace-routing rule as listPermissions: an UNSCOPED reply 404s
 *  (PermissionNotFoundError) or silently no-ops if routed to the wrong
 *  workspace, so the tool stays pending forever. Pass sessionId so the reply
 *  lands on the pending entry's scope. This was the root cause of mobile
 *  trust-mode auto-allow failing with `PermissionNotFoundError`.
 *  @param {{ requestId: string, reply: "once"|"always"|"reject", sessionId?: string }} opts
 */
export async function replyPermission({ requestId, reply, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/permission/${encodeURIComponent(requestId)}/reply${dirQ}`;
  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyPermission ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Question flow (Question tool)
// ---------------------------------------------------------------------------

/** List pending questions from the Question tool.
 *  Scoped to the session's directory when sessionId is provided, so questions
 *  from the correct workspace are returned. Without scoping, opencode returns
 *  questions for the default workspace only — causing the QuestionCard to
 *  never appear for non-default sessions and the agent to hang forever.
 *  @param {string} [sessionId]
 *  @returns {Promise<Array<{ id: string, sessionID: string, questions: Array<...>, ... }>>}
 */
export async function listQuestions(sessionId) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const res = await ocFetch(apiUrl(`/question${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listQuestions ${res.status}: ${await res.text()}`);
  }
  const all = await res.json();
  const list = Array.isArray(all) ? all : [];
  // opencode's /question is `?directory=`-scoped, not session-scoped — see
  // listPermissions above. Filter to the requested sessionId (BET-110).
  // Background-job children no longer surface here (BET-418 §A).
  if (!sessionId) return list;
  return list.filter((q) => q.sessionID === sessionId);
}

/**
 * Reply to a question (one answers array per QuestionInfo entry).
 *
 * opencode's /question endpoints are `?directory=`-scoped like prompt_async;
 * an UNSCOPED reply 200s but never resumes the blocked tool (agent hangs in
 * "processing"). Scope to the question's session directory.
 * @param {{ requestId: string, answers: string[][], sessionId?: string }} opts
 */
export async function replyQuestion({ requestId, answers, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/question/${encodeURIComponent(requestId)}/reply${dirQ}`;
  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyQuestion ${res.status}: ${await res.text()}`);
  }
}

/** Reject (dismiss) a question without answering.
 *  @param {{ requestId: string, sessionId?: string }} opts
 */
export async function rejectQuestion({ requestId, sessionId }) {
  const dirQ = sessionId ? await getSessionDirectoryQuery(sessionId) : "";
  const url = `/question/${encodeURIComponent(requestId)}/reject${dirQ}`;
  const res = await ocFetch(apiUrl(url), { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode rejectQuestion ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Models / providers
// ---------------------------------------------------------------------------

/**
 * Get the default model from the first connected provider.
 * Single source of truth for live provider state is `getProviders()`
 * (BET-318). Keeping the inline `GET /provider` fetch out of here
 * eliminates the latent drift trap between this caller and the
 * `opencode:provider-auth` `status` action.
 *
 * Returns `null` when opencode is unreachable, returns a non-2xx,
 * or when no connected provider has a default model recorded.
 * @returns {Promise<{ providerID: string, modelID: string }|null>}
 */
export async function getDefaultModel() {
  const { connected, default: defaults } = await getProviders();
  for (const id of connected) {
    const modelID = defaults?.[id];
    if (modelID) return { providerID: id, modelID };
  }
  return null;
}

/**
 * Read the live provider state from opencode's `GET /provider`.
 * Single source of truth for callers that need the authoritative
 * `connected[]` list (and the full `all`/`default` shape when available).
 *
 * Used by the `opencode:provider-auth` `status` action to feed
 * `subscriptionProviders.subscriptionStatuses(connected)`.
 *
 * @returns {Promise<{ connected: string[], all?: Array<{id:string}>, default?: Record<string,string> }>}
 *   Never throws — a transport failure or non-2xx response yields
 *   `{ connected: [] }` so the caller's `connected[]` reads are safe.
 */
export async function getProviders() {
  try {
    const res = await ocFetch(apiUrl("/provider"));
    if (!res.ok) {
      await discardBody(res);
      return { connected: [] };
    }
    const data = await res.json();
    return {
      connected: Array.isArray(data?.connected) ? data.connected : [],
      all: Array.isArray(data?.all) ? data.all : undefined,
      default:
        data?.default && typeof data.default === "object" ? data.default : undefined,
    };
  } catch {
    return { connected: [] };
  }
}

/**
 * List all models from CONNECTED providers only.
 * Strips raw API keys by reconstructing the model shape (normalizeProviderModel).
 * Routes through `getProviders()` so the live `/provider` fetch lives in
 * exactly one place (BET-342 — sibling of BET-320 for `getDefaultModel`).
 * @returns {Promise<Array<{ id: string, providerID: string, name: string, ... }>>}
 */
export async function listModels(overrides = {}) {
  const out = [];
  try {
    const { connected: connectedIds, all } = await getProviders();
    if (!Array.isArray(all)) return out;
    const connected = new Set(connectedIds);
    for (const p of all) {
      if (!p.id || !connected.has(p.id)) continue;
      for (const modelId of Object.keys(p.models ?? {})) {
        const m = _normalizeProviderModel(p.id, modelId, (p.models ?? {})[modelId]);
        const key = `${m.providerID}/${m.id}`;
        out.push(applyModelOverride(m, overrides?.[key]));
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

// applyModelOverride(m, override) — merge a user-supplied Settings → Models
// display override (name / description / context size) onto a normalized
// OpencodeModel. Pure and exported for tests. A non-falsy `override` yields a
// NEW model object (never mutates the input); omitted fields fall back to the
// provider's own values.
export function applyModelOverride(m, override) {
  if (!override || typeof override !== "object") return m;
  let next = m;
  if (typeof override.name === "string" && override.name.trim() !== "") {
    next = { ...next, name: override.name.trim() };
  }
  if (typeof override.description === "string" && override.description.trim() !== "") {
    next = { ...next, description: override.description.trim() };
  }
  const ctx = override.context;
  if (typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0) {
    next = { ...next, limit: { ...(m.limit ?? {}), context: ctx } };
  }
  return next;
}

function _normalizeProviderModel(providerID, modelId, m) {
  let variants;
  const vRaw = m.variants;
  if (Array.isArray(vRaw)) {
    variants = vRaw
      .map((v) => (v && typeof v === "object" ? String(v.id ?? "") : ""))
      .filter(Boolean)
      .map((id) => ({ id }));
  } else if (vRaw && typeof vRaw === "object") {
    variants = Object.keys(vRaw).map((id) => ({ id }));
  }
  return {
    id: String(m.id ?? modelId),
    providerID,
    family: typeof m.family === "string" ? m.family : undefined,
    name: typeof m.name === "string" ? m.name : String(m.id ?? modelId),
    status: typeof m.status === "string" ? m.status : undefined,
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    limit: m.limit,
    capabilities: m.capabilities,
    variants: variants && variants.length > 0 ? variants : undefined,
  };
}

// ---------------------------------------------------------------------------
// Subscription provider auth (BET-308, BET-309)
// ---------------------------------------------------------------------------
//
// Thin HTTP proxies to opencode's `/provider/auth`, `/provider/{id}/oauth/
// authorize`, `/provider/{id}/oauth/callback`, `PUT /auth/{id}`, and
// `DELETE /auth/{id}` endpoints. Policy (which method to pick, which
// shape to render) lives in src/server/subscriptionProviders.mjs; this
// file only transports the request and surfaces a structured failure
// (`{ok:false, error, detail?}`) on a non-2xx. Error vocabulary matches
// src/server/providers.mjs's discoverModels: "unreachable" | "unauthorized"
// | "bad_response" — reuse rather than invent.
//
// `setProviderApiKey` is the one path that handles a secret: the key is
// written to opencode's auth store box-side and NEVER echoed back, not in
// the return value and not in any log line.

/**
 * Fetch the auth-method list for every provider (GET /provider/auth).
 * @returns {Promise<Record<string, Array<{type:string,label?:string,prompts?:Array<unknown>}>|null>>}
 *          raw shape — the renderer's RPC layer wraps this in the
 *          resolveAuthMethod policy from subscriptionProviders.mjs.
 */
export async function listProviderAuthMethods() {
  try {
    const res = await ocFetch(apiUrl("/provider/auth"));
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await discardBody(res);
      return { ok: false, error: "bad_response", detail: detail.slice(0, 200) };
    }
    const data = await res.json();
    return { ok: true, methods: data ?? {} };
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e?.message ?? e) };
  }
}

/**
 * Start a provider's OAuth flow (POST /provider/{id}/oauth/authorize {method}).
 * Returns the raw `{url, method, instructions}` from opencode; the caller
 * applies describeConnectShape to pick the renderer's UI.
 * @param {string} providerID
 * @param {number} methodIndex   resolved via resolveAuthMethod, NEVER a literal
 */
export async function startProviderOauth(providerID, methodIndex) {
  try {
    const res = await ocFetch(apiUrl(`/provider/${encodeURIComponent(providerID)}/oauth/authorize`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: methodIndex }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await discardBody(res);
      return { ok: false, error: "bad_response", detail: detail.slice(0, 200) };
    }
    const data = await res.json();
    return {
      ok: true,
      url: typeof data?.url === "string" ? data.url : "",
      method: typeof data?.method === "string" ? data.method : "auto",
      instructions: typeof data?.instructions === "string" ? data.instructions : "",
    };
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e?.message ?? e) };
  }
}

/**
 * Complete a paste-back OAuth flow (POST /provider/{id}/oauth/callback {method, code}).
 * @param {string} providerID
 * @param {number} methodIndex
 * @param {string} code   the user-typed code from the device / browser page
 */
export async function completeProviderOauth(providerID, methodIndex, code) {
  try {
    const res = await ocFetch(apiUrl(`/provider/${encodeURIComponent(providerID)}/oauth/callback`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: methodIndex, code }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await discardBody(res);
      // 401 from opencode means a wrong/expired code — surface as a distinct
      // vocabulary word so the renderer can label the input correctly.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "unauthorized", detail: detail.slice(0, 200) };
      }
      return { ok: false, error: "bad_response", detail: detail.slice(0, 200) };
    }
    await discardBody(res);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e?.message ?? e) };
  }
}

/**
 * Write an API key into opencode's auth store (PUT /auth/{id} {type:"api", key}).
 *
 * SECURITY: the key is NEVER echoed back to the caller and NEVER logged.
 * `setProviderApiKey` returns `{ok:boolean}` only; a logged error must not
 * contain the key, only the provider id.
 * @param {string} providerID
 * @param {string} key
 */
export async function setProviderApiKey(providerID, key) {
  try {
    const res = await ocFetch(apiUrl(`/auth/${encodeURIComponent(providerID)}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await discardBody(res);
      // Provider-specific validation (e.g. Kimi 401s on a bad key) comes back
      // as 401 — re-use "unauthorized" so the renderer can show the right copy.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "unauthorized", detail: detail.slice(0, 200) };
      }
      return { ok: false, error: "bad_response", detail: detail.slice(0, 200) };
    }
    await discardBody(res);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e?.message ?? e) };
  }
}

/**
 * Remove a provider's auth from opencode's store (DELETE /auth/{id}).
 * Idempotent — a missing entry returns 404 from opencode, which we surface
 * as `{ok:true}` (the user's intent is satisfied: the auth is gone).
 * @param {string} providerID
 */
export async function removeProviderAuth(providerID) {
  try {
    const res = await ocFetch(apiUrl(`/auth/${encodeURIComponent(providerID)}`), {
      method: "DELETE",
    });
    if (res.ok || res.status === 404) {
      await discardBody(res);
      return { ok: true };
    }
    const detail = await res.text().catch(() => "");
    await discardBody(res);
    return { ok: false, error: "bad_response", detail: detail.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e?.message ?? e) };
  }
}

/**
 * Resolve where opencode itself persists provider auth — including the API
 * keys `setProviderApiKey` above writes via `PUT /auth/{id}` — as
 * `{"<providerID>": {"type":"api"|"oauth", "key"|"access"/"refresh", …}}`.
 * See docs/subscription-providers.md §1.3: "Codex/Kimi/Copilot tokens live
 * in opencode's own auth store … opencode refreshes them itself."
 *
 * Mirrors messageSearch.mjs's `resolveDbPath()` for the SAME opencode XDG
 * data directory: `XDG_DATA_HOME` first when set, else `homedir()`-based —
 * never hardcode `/home/…`. A box that sets `XDG_DATA_HOME` (review cycle 2
 * Nit) would otherwise never find a real key here, and `detect()` would
 * silently report false with no error, the quiet-failure mode this repo
 * already decided against for opencode's other data-dir resolver.
 * @returns {string}
 */
export function opencodeAuthPath() {
  const base = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(base, "opencode", "auth.json");
}

/**
 * Pure: extract a provider's API key from the ALREADY-READ text of
 * opencode's auth store. Mirrors `parseCredentials` above exactly — never
 * throws, returns `""` (not null; this value is used directly as a header)
 * for invalid JSON, a missing provider entry, or an entry whose `key` isn't
 * a non-empty string (e.g. an oauth-type entry, which has `access`/`refresh`
 * instead — see the `anthropic` shape this same file writes).
 *
 * Separated from the file read below so it's directly unit-testable without
 * touching a real auth store, the same split `parseCredentials` /
 * `readCredsSnapshot` uses.
 *
 * @param {string} rawFileText
 * @param {string} providerId
 * @returns {string}
 */
export function parseProviderApiKey(rawFileText, providerId) {
  try {
    const parsed = JSON.parse(rawFileText);
    const entry = parsed?.[providerId];
    // Discriminate on `type === "api"` before trusting any `key` value: the
    // key is used directly as a `Bearer` header, so a non-api entry (e.g. an
    // oauth one) must never supply it even if it happens to carry a `key`
    // field.
    return entry?.type === "api" && typeof entry?.key === "string" && entry.key.length > 0
      ? entry.key
      : "";
  } catch {
    return "";
  }
}

/**
 * Read a provider's raw API key straight off opencode's own auth store
 * (BET-737's usage engine needs it to call a provider's usage endpoint
 * itself — opencode exposes no usage-reporting RPC of its own). This is a
 * READER only, never a second place to write the key: the only writer is
 * `setProviderApiKey` above (the Kimi connect card, via `PUT /auth/{id}`).
 *
 * Mirrors `readCredsSnapshot` above exactly: tolerates a missing file by
 * returning `""` — NEVER throws, so a caller can `await` this
 * unconditionally. The parse itself is `parseProviderApiKey` above.
 *
 * The file-read function is injectable (`readFile`), defaulting to the real
 * `readFileSync`, so tests can drive the missing-file / unparseable cases
 * with a fake reader and never touch a real auth store on a live box.
 *
 * SECURITY: this resolves a LIVE credential. It must never log, echo, or
 * return the key anywhere but to its direct caller, and a caller must never
 * fold it into an error message.
 *
 * @param {string} providerId
 * @param {{ readFile?: (file: string, encoding: string) => string }} [opts]
 * @returns {Promise<string>}
 */
export async function readProviderApiKey(providerId, { readFile = readFileSync } = {}) {
  let raw;
  try {
    raw = readFile(opencodeAuthPath(), "utf-8");
  } catch {
    return "";
  }
  return parseProviderApiKey(raw, providerId);
}

// ---------------------------------------------------------------------------
// VCS
// ---------------------------------------------------------------------------

/**
 * Get the current VCS branch for a working directory.
 *
 * We DO NOT call opencode's `GET /vcs` because that endpoint caches branch
 * state per-worker and never reflects a `git checkout` performed in the
 * user's terminal. Instead we shell out to `git -C <dir> branch --show-current`
 * directly. Returns null for empty dir, non-git, detached HEAD, or any
 * failure.
 *
 * @param {string} [directory]
 * @returns {Promise<string|null>}
 */
export async function getVcsBranch(directory) {
  if (!directory) return null;
  return new Promise((resolve) => {
    const proc = cpSpawn(
      "git",
      ["-C", directory, "branch", "--show-current"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      const name = stdout.trim();
      resolve(name ? name : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Claude credential auto-refresh (BET-139, BET-280)
// ---------------------------------------------------------------------------

// Single-flight guard: concurrent auth-error events share one in-flight
// refresh promise instead of racing multiple `claude` spawns. The cooldown
// in `maybeRecoverCredentials` is the FIRST gate (saves most spawns);
// this guard catches whatever still gets through inside the same burst.
let _refreshInFlight = null;
// Last-recovery timestamp (epoch ms) for the cooldown gate. A single
// expired-credential burst on the live box produced ~12 error events in
// ~25 seconds; without a cooldown each one would spawn its own `claude`
// process.
let _lastRecoveryAt = null;
/** Test-only: peek the recovery cooldown state. */
export function _getRecoveryCooldownState() {
  return { lastRecoveryAt: _lastRecoveryAt };
}
/** Test-only: reset recovery cooldown state between scenarios. */
export function _resetRecoveryCooldownState() {
  _lastRecoveryAt = null;
}

/** Resolve the `claude` CLI binary. manta-server's service PATH excludes the
 *  user's ~/.local/bin (where the claude installer symlinks the binary), so a
 *  bare "claude" fails to spawn. Check the known install locations first and
 *  fall back to bare "claude" (resolved via the augmented PATH) if none match.
 *
 *  CLAUDE-SPECIFIC BY DESIGN: every other provider (Codex, Kimi, ...) uses
 *  opencode's native /provider/{id}/oauth/* flow — there is no external CLI
 *  to spawn, no credential to refresh, and the rest of this file's
 *  subscription-provider auth proxy is provider-agnostic. Do NOT generalize
 *  this helper; the auth-machinery it backs (`doRefresh`,
 *  `maybeRecoverCredentials`, `startCredentialRefreshPoller`) is similarly
 *  Claude-only and is kept that way to avoid papering over the differences. */
function resolveClaudeBin() {
  // `~/.local/bin` is the resolver's concern — that's where the official
  // `claude` CLI installer places its symlink. `/usr/local/bin` is a
  // generic POSIX fallback for hand-installed copies. We deliberately do
  // NOT include a macOS-only Homebrew candidate here: the PATH patch
  // below already prepends the macOS Homebrew prefix, so a Homebrew-
  // installed claude is visible to the spawned child without us probing
  // each Homebrew location explicitly.
  const candidates = [
    path.join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore and try the next candidate
    }
  }
  return "claude";
}

/**
 * BET-421 §E: is the `claude` CLI installed on this box? Used by the
 * connect card to decide whether to run the lazy installer before sign-in.
 * Pure over an injected `existsFn` so the decision is unit-testable.
 * Returns `{ installed, path }` — `path` is the resolved binary path, or
 * `"claude"` (the bare-name fallback) when nothing is on disk.
 */
export function claudeCliStatus({ existsFn = existsSync } = {}) {
  const bin = resolveClaudeBinExists(existsFn);
  return { installed: bin.installed, path: bin.path };
}

// Separated from resolveClaudeBin so claudeCliStatus can report the resolved
// path AND whether it actually exists (resolveClaudeBin returns "claude" as
// a last-resort bare name, which is NOT "installed").
function resolveClaudeBinExists(existsFn) {
  const candidates = [
    path.join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (existsFn(c)) return { installed: true, path: c };
    } catch {
      // ignore and try the next candidate
    }
  }
  return { installed: false, path: "claude" };
}

/** Best-effort read + parse of ~/.claude/.credentials.json. Null on any
 *  read or parse failure (file missing, permissions, malformed JSON). */
function readCredsSnapshot() {
  try {
    return parseCredentials(readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Re-mint expired Claude OAuth credentials by shelling out to the `claude`
 * CLI — the exact fix the user performs by hand today. Mirrors getVcsBranch's
 * cpSpawn-wrapped-in-a-Promise shape.
 *
 * Triggered from exactly ONE place: `maybeRecoverCredentials` below, which is
 * called from the opencode event pump (`src/server/index.mjs`). Single-flight
 * guarded so concurrent auth errors share one refresh instead of duplicate
 * spawns.
 *
 * @returns {Promise<{ ok: boolean, reason?: "no-credentials" | "refresh-token-expired" | "failed", expiresAt?: number }>}
 */
export async function refreshClaudeCredentials() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = doRefresh().finally(() => {
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

/**
 * Server-side trigger for the Claude credential auto-refresh (BET-280).
 * Called from the opencode event pump on every `session.error`; only fires
 * a refresh when the error matches our message-shape predicate (catches the
 * UnknownError wrapper the plugin throws today AND the legacy error-name
 * compatibility branch in `isClaudeCredentialError`) AND the cooldown gate
 * is open (catches the burst).
 *
 * Runs without a client attached — that's the BET-280 whole point. The
 * renderer used to drive this via an IPC channel + an SSE callback, which
 * required a chat panel for the session to be mounted in a connected client.
 * Errors on a session nobody was watching (the live failure) never recovered.
 *
 * Never throws — a rejection from `refreshClaudeCredentials` is swallowed
 * (the function logs its own outcome line and the caller doesn't await the
 * result anyway).
 *
 * @param {unknown} evt  opencode event from `subscribeEvents`
 */
export async function maybeRecoverCredentials(evt) {
  try {
    if (evt?.type !== "session.error") return;
    if (!isClaudeCredentialError(evt.properties?.error)) return;
    if (!shouldAttemptRecovery(_lastRecoveryAt, Date.now())) return;
    _lastRecoveryAt = Date.now();
    // The refresh function logs its own outcome; we don't await it because
    // the pump must never block. A failure is benign (next event within the
    // cooldown won't retry; one past the cooldown will).
    void refreshClaudeCredentials();
  } catch (e) {
    // Defensive: a thrown predicate or unexpected shape must never escape
    // into the pump. Log so the operator can see it happened.
    console.warn("[claude-auth] maybeRecoverCredentials failed:", e?.message ?? e);
  }
}

async function doRefresh() {
  const credsBefore = readCredsSnapshot();

  // Pre-checks — no point spawning `claude` if we already know it can't work.
  if (!credsBefore) {
    return logAndReturn({ ok: false, reason: "no-credentials" });
  }
  if (isRefreshTokenExpired(credsBefore, Date.now())) {
    return logAndReturn({ ok: false, reason: "refresh-token-expired" });
  }

  // Run the CLI refresh (this is the "run claude" the user does by hand).
  // Non-zero exit / spawn error (e.g. ENOENT) doesn't short-circuit — we
  // re-check the actual credentials file afterward, which is the source of
  // truth regardless of the process's exit code.
  //
  // manta-server runs as a `systemd --user` service whose PATH is the minimal
  // system PATH (/usr/local/bin:/usr/bin:/bin) — it does NOT include the
  // user's ~/.local/bin, where the `claude` CLI installer places its symlink.
  // A bare cpSpawn("claude") therefore ENOENTs, the refresh reports "failed",
  // and the auto-refresh card never clears. Resolve the binary explicitly and
  // augment PATH so the child (and any tool it re-execs) can find it.
  //
  // PATH augmentation is platform-aware: `patchPath` prepends the macOS
  // Homebrew prefix on darwin and leaves PATH byte-identical on every
  // other platform. We still need to prepend `~/.local/bin` here because
  // that's the resolver's concern, not the platform helper's — `patchPath`
  // doesn't know about Claude-specific install locations.
  const claudeBin = resolveClaudeBin();
  const baseEnv = {
    ...process.env,
    PATH: [path.join(homedir(), ".local", "bin"), process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
    TERM: "dumb",
  };
  await new Promise((resolve) => {
    const proc = cpSpawn(claudeBin, ["-p", ".", "--model", "haiku"], {
      cwd: tmpdir(),
      env: patchPath(baseEnv, process.platform),
      stdio: "ignore",
      timeout: 60_000,
    });
    proc.on("error", () => resolve());
    proc.on("exit", () => resolve());
  });

  const credsAfter = readCredsSnapshot();
  const now = Date.now();
  const outcome = classifyRefreshOutcome({ credsBefore, credsAfter, now });
  if (outcome === "ok") {
    return logAndReturn({ ok: true, expiresAt: credsAfter.expiresAt });
  }
  return logAndReturn({ ok: false, reason: outcome });
}

function logAndReturn(result) {
  console.log(
    "[claude-auth] refresh ok=%s reason=%s expiresAt=%s",
    result.ok,
    result.reason ?? "-",
    result.expiresAt ?? "-",
  );
  return result;
}

// ---------------------------------------------------------------------------
// Proactive pre-expiry refresh poller (BET-281)
// ---------------------------------------------------------------------------
//
// Today the access token is only refreshed reactively — `maybeRecoverCredentials`
// fires when an `session.error` matches the credential-expired predicate. The
// user eats one broken turn on every ~8h expiry window. This poller clocks
// `~/.claude/.credentials.json` and runs the existing `refreshClaudeCredentials`
// ahead of time, so the reactive path becomes a backup rather than the only
// line of defense.
//
// Shape mirrors `startCleanupPoller` / `createCleanupSweep` in servePage.mjs:
// factory body guarded by an `inFlight` boolean so a slow tick can't overlap
// the next, immediate `sweep()` at startup, `setInterval` with `unref()` so
// the timer never holds the event loop open.
//
// Default interval: 10 min. Default lead time (inside `shouldRefreshAhead`):
// 30 min. With Claude tokens living ~8h, those defaults give us >= 1
// refresh-ahead per token window while limiting the cost of an unexpected
// loopback FS read to ~144/day. Not configurable per the issue spec.

const CREDENTIAL_REFRESH_MS = 10 * 60 * 1000;

export function createCredentialRefreshSweep({
  readCreds = readCredsSnapshot,
  refresh = refreshClaudeCredentials,
  shouldRefresh = shouldRefreshAhead,
  now = Date.now,
} = {}) {
  let inFlight = false;

  async function sweep() {
    if (inFlight) return;
    inFlight = true;
    try {
      const creds = readCreds();
      if (shouldRefresh(creds, now())) {
        try {
          await refresh();
        } catch {
          // never throw — a refresh failure must not kill the timer
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return { sweep };
}

export function startCredentialRefreshPoller({ intervalMs = CREDENTIAL_REFRESH_MS } = {}) {
  const { sweep } = createCredentialRefreshSweep();
  // Run once immediately so a fresh server boot doesn't have to wait
  // intervalMs to discover an already-near-expiry credential.
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Commands, agents, file search
// ---------------------------------------------------------------------------

/** List built-in and user-defined slash commands.
 *  @returns {Promise<Array<{ name: string, description?: string, source?: string, ... }>>}
 */
export async function listCommands() {
  const res = await ocFetch(apiUrl("/command"));
  if (!res.ok) {
    throw new Error(`opencode listCommands ${res.status}: ${await res.text()}`);
  }
  const raw = await res.json();
  return raw.map((c) => ({
    name: String(c.name ?? ""),
    description: typeof c.description === "string" ? c.description : undefined,
    source: typeof c.source === "string" ? c.source : undefined,
    argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : undefined,
    agent: typeof c.agent === "string" ? c.agent : undefined,
    model: typeof c.model === "string" ? c.model : undefined,
    template: typeof c.template === "string" ? c.template : undefined,
  }));
}

/** List primary and sub-agents.
 *  @returns {Promise<Array<{ name: string, description?: string, mode?: string, ... }>>}
 */
export async function listAgents() {
  const res = await ocFetch(apiUrl("/agent"));
  if (!res.ok) {
    throw new Error(`opencode listAgents ${res.status}: ${await res.text()}`);
  }
  const raw = await res.json();
  return raw.map((a) => ({
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    mode: typeof a.mode === "string" ? a.mode : undefined,
    native: typeof a.native === "boolean" ? a.native : undefined,
    builtIn: typeof a.builtIn === "boolean" ? a.builtIn : undefined,
  }));
}

/** ripgrep-backed file search under a directory.
 *  @param {{ query: string, directory: string }} opts
 *  @returns {Promise<string[]>}
 */
export async function findFiles({ query, directory }) {
  const qs =
    `?query=${encodeURIComponent(query)}&directory=${encodeURIComponent(directory)}`;
  const res = await ocFetch(apiUrl(`/find/file${qs}`));
  if (!res.ok) {
    throw new Error(`opencode findFiles ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Invoke a slash command inside a session.
 * model is serialised as "providerID/modelID" string (unlike prompt_async's object).
 *
 * @param {{ sessionId: string, command: string, arguments: string, attachments?: Array<{ remotePath: string, mime: string, filename?: string }>, model?: { providerID: string, modelID: string, variant?: string } }} opts
 */
export async function runCommand({ sessionId, command, arguments: argumentsStr, attachments, model }) {
  const dirQ = await getSessionDirectoryQuery(sessionId);
  const url = `/session/${encodeURIComponent(sessionId)}/command${dirQ}`;
  const parts = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  const body = { command, arguments: argumentsStr, parts };
  if (model) {
    body.model = `${model.providerID}/${model.modelID}`;
    if (model.variant) body.variant = model.variant;
  }
  const res = await ocFetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode runCommand ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// SSE event subscription
// ---------------------------------------------------------------------------

// Transport used by the long-lived SSE stream in openEventStream. Production
// = the real global `fetch` (undici) — deliberately NOT the pooled ocFetch
// transport (a keep-alive pool socket would be pinned forever by a streaming
// body; see the ocAgent comment above). Tests can override this to simulate
// a controllable SSE response (including WHEN it "connects") without a live
// opencode server.
let eventStreamTransport = null;
/** Test-only: override the transport openEventStream dispatches through.
 *  Pass null to restore the default (global fetch). */
export function _setEventStreamTransport(fn) {
  eventStreamTransport = fn;
}
function eventFetch(url, init) {
  return (eventStreamTransport ?? fetch)(url, init);
}

// Liveness: opencode emits a `server.heartbeat` on BOTH the global and every
// scoped /event stream roughly every 10s, even when idle (verified on the box:
// ~6 heartbeats in 65s). So a healthy connection ALWAYS receives bytes within
// ~10s. If we go longer than this with zero bytes the subscription has gone
// DEAF — opencode stopped publishing to it (correlated with session
// churn/prune in the same directory) WITHOUT closing the TCP, so reader.read()
// blocks forever, the reconnect loop never runs, and the readiness gate stays
// stuck "connected". This is the user's recurring "must leave + re-enter the
// session to see updates" bug (every manta-server restart masked it until the
// next deafness). 45s = 4+ missed heartbeats — long enough to never
// false-positive on a GC pause / one dropped frame, short enough to self-heal
// well within the time a user notices nothing streaming.
export const LIVENESS_TIMEOUT_MS = 45_000;
const LIVENESS_CHECK_MS = 15_000;

/**
 * Pure: has the stream gone deaf? True when no byte has arrived for longer than
 * timeoutMs (given opencode's ~10s heartbeat, that means the subscription
 * stopped delivering). Exported for unit tests.
 * @param {number} lastByteAt  epoch ms of the last byte received
 * @param {number} now         epoch ms
 * @param {number} [timeoutMs=LIVENESS_TIMEOUT_MS]
 */
export function isStreamDeaf(lastByteAt, now, timeoutMs = LIVENESS_TIMEOUT_MS) {
  return now - lastByteAt > timeoutMs;
}

// One long-lived SSE connection to opencode's /event endpoint, optionally
// scoped to a project `?directory=`. Auto-reconnects on drop with 1.5 s
// delay; returns stop() that flips stopped=true AND aborts the in-flight
// fetch so reader.read() unblocks immediately.
//
// `hooks.onConnect` fires each time the upstream fetch comes back OK, before
// the parse loop starts — this is what resolves the readiness gate above.
// `hooks.onDisconnect` fires whenever a (non-teardown) connection ends, so
// the readiness gate can re-arm for the next connect.
//
// A per-connection liveness watchdog aborts the controller when the stream
// goes deaf (see LIVENESS_TIMEOUT_MS) — the abort unblocks reader.read(), which
// falls through to onDisconnect + the 1.5s reconnect, re-establishing a live
// subscription. `opts.livenessTimeoutMs` / `opts.livenessCheckMs` are injectable
// for tests (0 check disables the watchdog).
function openEventStream(onEvent, directory, hooks = {}, opts = {}) {
  const { onConnect, onDisconnect } = hooks;
  const livenessTimeoutMs = opts.livenessTimeoutMs ?? LIVENESS_TIMEOUT_MS;
  const livenessCheckMs =
    opts.livenessCheckMs != null ? opts.livenessCheckMs : LIVENESS_CHECK_MS;
  const key = directory || "(global)";
  let stopped = false;
  let currentController = null;

  const path = directory
    ? `/event?directory=${encodeURIComponent(directory)}`
    : "/event";

  (async function loop() {
    while (!stopped) {
      const controller = new AbortController();
      currentController = controller;
      let lastByteAt = Date.now();
      let deaf = false;
      let watchdog = null;
      try {
        const res = await eventFetch(apiUrl(path), {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          throw new Error(`opencode SSE ${res.status}: ${res.statusText}`);
        }
        console.log(`[opencode-bus] stream CONNECTED dir=${key}`);
        onConnect?.();
        lastByteAt = Date.now();
        // Liveness watchdog: abort the connection if it goes silent past the
        // heartbeat window. The abort rejects the pending reader.read() below,
        // dropping us into the reconnect path. unref'd so it never holds the
        // process open.
        if (livenessCheckMs > 0) {
          watchdog = setInterval(() => {
            if (stopped) return;
            if (isStreamDeaf(lastByteAt, Date.now(), livenessTimeoutMs)) {
              deaf = true;
              console.log(
                `[opencode-bus] stream ${key} deaf >${Math.round(livenessTimeoutMs / 1000)}s — reconnecting`,
              );
              try { controller.abort(); } catch { /* already aborted */ }
            }
          }, livenessCheckMs);
          watchdog.unref?.();
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            lastByteAt = Date.now(); // any byte (heartbeat or real) = alive
            buf += dec.decode(value, { stream: true });
            let idx;
            // Events are separated by double-newline (SSE spec)
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let data = "";
              for (const line of chunk.split("\n")) {
                if (line.startsWith("data:")) {
                  data += (data ? "\n" : "") + line.slice(5).trimStart();
                }
                // ignore event: / id: / retry: lines — type is inside the JSON
              }
              if (!data) continue;
              try {
                onEvent(JSON.parse(data));
              } catch {
                // skip malformed event
              }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* already released */ }
          controller.abort(); // always abort to release the connection
        }
      } catch {
        /* reconnect on error, deaf-abort, or AbortError from stop() */
      } finally {
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
      }
      // The connection just ended (cleanly, via error, or a deaf-abort) and
      // we're about to retry — a real drop, not an intentional stop(). Re-arm
      // the readiness gate so a prompt sent during this reconnect window waits
      // for the NEXT successful connect instead of resolving off a stale "was
      // connected" promise.
      if (!stopped) {
        console.log(`[opencode-bus] stream DISCONNECTED dir=${key}`);
        onDisconnect?.();
        // A deaf reconnect is immediate — the subscription is already dead and
        // every second of silence is dropped events. A normal error backs off.
        await sleep(deaf ? 250 : 1500);
      }
    }
  })();

  return () => { stopped = true; currentController?.abort(); };
}

/**
 * Subscribe to opencode events across ALL project directories.
 *
 * opencode's `/event` is project-scoped: a POST with `?directory=X` emits
 * its events on the stream subscribed to `?directory=X` only. To catch
 * everything we open the global stream PLUS one stream per directory we've
 * seen (via createSession / forkSession / listSessions). Newly-discovered
 * directories auto-spawn a stream via the directoryListeners hook.
 *
 * Bootstrap: we call listSessions() once on subscribe so existing sessions
 * (from a previous server restart) have their directories cached and a
 * stream opened.
 *
 * @param {(event: object) => void} onEvent
 * @param {object} [opts]
 * @param {(dir:string)=>boolean} [opts.existsFn]  directory-exists predicate
 *   (injected for tests; defaults to fs.existsSync).
 * @param {number} [opts.sweepIntervalMs]  eviction sweep cadence (default
 *   STREAM_SWEEP_MS; set 0 to disable the timer — tests call the returned
 *   `_sweep` directly).
 * @param {number} [opts.idleMs]      idle-eviction threshold (default STREAM_IDLE_MS)
 * @param {number} [opts.maxStreams]  LRU cap (default STREAM_MAX)
 * @param {() => string[]} [opts.eagerDirectories]  callback returning the small
 *   bounded set of directories to pre-open scoped streams for at startup
 *   (e.g. live chat-session directories supplied by index.mjs from
 *   `tmux.listProjects()`). The full session catalog stays lazily-opened — the
 *   many-workspace flood fix — only this bounded live set is pre-opened so a
 *   fresh box's first turn never races an unopened subscription.
 * @returns {() => void} stop
 */
export function subscribeEvents(onEvent, opts = {}) {
  const streams = new Map(); // key: "" (global) or directory string
  // key -> last-active epoch ms. Bumped when a stream is opened AND every time
  // the session that owns its directory is used (ensureStreamForDirectory), so
  // an in-use directory never looks idle even between reconnects.
  const lastActivity = new Map();
  const existsFn = opts.existsFn ?? existsSync;
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const maxStreams = opts.maxStreams ?? STREAM_MAX;
  const sweepIntervalMs =
    opts.sweepIntervalMs != null ? opts.sweepIntervalMs : STREAM_SWEEP_MS;
  // Directories of LIVE chat sessions (a small bounded set — the actual open
  // chat windows), injected by index.mjs from tmux.listProjects(). Their scoped
  // streams are opened EAGERLY at startup so a fresh box's first turn never
  // races an unopened subscription. The full session catalog stays
  // lazily-opened (the many-workspace flood fix); only this bounded live set
  // is pre-opened.
  const eagerDirectories = typeof opts.eagerDirectories === "function"
    ? opts.eagerDirectories
    : () => [];
  // Liveness-watchdog knobs (see openEventStream) — passed through, injectable
  // for tests. Undefined → openEventStream's defaults (45s timeout / 15s check).
  const streamOpts = {
    livenessTimeoutMs: opts.livenessTimeoutMs,
    livenessCheckMs: opts.livenessCheckMs,
  };
  let stopped = false;

  const touch = (key) => { lastActivity.set(key, Date.now()); };

  const openFor = (key, dir) => {
    touch(key); // opening or re-using a stream counts as activity
    if (streams.has(key)) return;
    streams.set(
      key,
      openEventStream(
        (ev) => { touch(key); onEvent(ev); }, // an arriving event = activity
        dir,
        {
          onConnect: () => markStreamConnected(key),
          onDisconnect: () => markStreamDisconnected(key),
        },
        streamOpts,
      ),
    );
  };

  // Close + forget one scoped stream. The global stream ("") is never passed
  // here. Readiness state is cleared so a later re-open re-arms the gate.
  const closeStream = (key) => {
    const stop = streams.get(key);
    if (stop) { try { stop(); } catch { /* ignore */ } }
    streams.delete(key);
    lastActivity.delete(key);
    streamReadyState.delete(key);
  };

  // One eviction pass. Pure decision in selectStreamsToEvict; this just applies
  // it. Safe: every evicted directory re-opens on next use via
  // ensureStreamForDirectory (idempotent) + the readiness gate.
  const _sweep = () => {
    if (stopped) return;
    let toEvict;
    try {
      toEvict = selectStreamsToEvict({
        keys: streams.keys(),
        lastActivity,
        existsFn,
        now: Date.now(),
        idleMs,
        maxStreams,
      });
    } catch {
      return; // never let a sweep error break the event pump
    }
    for (const key of toEvict) closeStream(key);
    if (toEvict.length > 0) {
      console.log(`[opencode-bus] evicted ${toEvict.length} idle/dead scoped stream(s); ${streams.size} remain`);
    }
  };

  // Global stream catches non-scoped events (server.heartbeat, vcs.branch.updated,
  // and any future event that opencode emits without a directory).
  openFor("", undefined);

  // Auto-open scoped streams for newly-discovered directories (createSession /
  // forkSession route through rememberSessionDirectory, which fires this).
  const listener = (dir) => {
    if (stopped || !dir) return;
    openFor(dir, dir);
  };
  directoryListeners.add(listener);

  // Expose the on-demand opener so getSessionDirectoryQuery can open a stream
  // the moment a session is actually used, rather than us pre-opening one for
  // every session in the catalog.
  ensureStreamForDirectory = (dir) => {
    if (stopped || !dir) return;
    openFor(dir, dir);
  };

  // Prime the dir cache from existing sessions so a prompt to a pre-existing
  // session resolves its directory fast — but do NOT open a stream per
  // session here. Streams open lazily when a session is used (see
  // getSessionDirectoryQuery → ensureStreamForDirectory). This is the fix for
  // the connection flood: on a many-workspace box, eagerly streaming every
  // session in listSessions() opened hundreds of connections to opencode.
  //
  // Eager-open runs FIRST (synchronously inside the IIFE) so it never blocks
  // behind listSessions — a slow / hung opencode on the bootstrap fetch
  // would otherwise defer the scoped streams and the first turn on a live
  // chat window would race an unopened subscription (BET-256 follow-up —
  // test `subscribeEvents eagerly opens scoped streams for supplied
  // eagerDirectories at startup` was flaky under CI load when listSessions
  // blocked the IIFE).
  (async () => {
    try {
      const dirs = eagerDirectories();
      const seen = new Set();
      for (const dir of Array.isArray(dirs) ? dirs : []) {
        if (stopped) break;
        if (typeof dir !== "string" || dir.length === 0 || seen.has(dir)) continue;
        seen.add(dir);
        openFor(dir, dir);
      }
    } catch { /* non-fatal: eager-open is best-effort */ }

    try {
      const sessions = await listSessions();
      for (const s of sessions || []) {
        if (s?.id && typeof s?.directory === "string") {
          cacheSessionDirectoryQuiet(s.id, s.directory);
        }
      }
    } catch { /* non-fatal: bootstrap is best-effort */ }
  })();

  // Periodic eviction sweep. unref() so it never keeps the process alive on its
  // own. Disabled when sweepIntervalMs is 0 (tests drive _sweep directly).
  let sweepTimer = null;
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(_sweep, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  const stop = () => {
    stopped = true;
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    directoryListeners.delete(listener);
    ensureStreamForDirectory = null;
    for (const s of streams.values()) {
      try { s(); } catch { /* ignore */ }
    }
    streams.clear();
    lastActivity.clear();
  };
  // Test hooks: drive one sweep pass, open a scoped stream, and inspect live
  // stream keys without a real timer / real opencode / real session.
  stop._sweep = _sweep;
  stop._streamKeys = () => [...streams.keys()];
  stop._touch = touch;
  stop._openFor = openFor;
  return stop;
}

// ---------------------------------------------------------------------------
// BET-354: in-app Claude connect flow
// ---------------------------------------------------------------------------
//
// The renderer's connect card spawns `claude auth login` on the box, streams
// its output via the existing pty bus, feeds the Anthropic callback code back
// through pty:write, and polls for completion. This module owns the IO: the
// completion-detection file stat + the opencode restart + the connected[]
// verification. Pure logic (URL extraction, classifyClaudeLoginProgress) lives
// in claudeAuth.mjs and is unit-tested there. The credential-overwrite hazard
// the POC flagged is mitigated by the file-mtime check in
// `pollClaudeLogin` — the flow only advances when the credentials file was
// modified AFTER the card mounted, so an existing valid login is never
// silently destroyed.
//
// BET-359 fold-in (BET-367 §4): the connect flow takes a one-shot snapshot
// of the existing credentials file at `startClaudeLogin` time
// (`backupClaudeCredentials` in claudeAuth.mjs) BEFORE the renderer spawns
// `claude auth login`. The backup path is plumbed through to
// `pollClaudeLogin` via the `backupPath` arg; on `"completed"` we validate
// the freshly-written file and call `restoreFromBackup` to roll back to
// the snapshot if the new file is empty / malformed.

import { stat as fsStat } from "node:fs/promises";
import { restartOpencode as restartOpencodeImpl } from "./opencodeAdmin.mjs";

/**
 * Poll the credentials file + opencode status. Called by the connect card on
 * its periodic tick (every 1s while `kind === "waiting"` or
 * `kind === "needsClaudeLogin"`).
 *
 * State machine:
 *   - `"no-file"`     — credentials file is missing. Keep polling.
 *   - `"pre-existing"`— file exists but was last modified BEFORE the card
 *                       mounted. The user already had a working login and
 *                       did not complete a fresh OAuth. Stop polling with
 *                       `ok: false` and a distinct reason; the renderer
 *                       surfaces this as a fail with the right copy.
 *   - `"completed"`   — file exists and was modified AT or AFTER the card
 *                       mounted. Call `restartOpencode()` (BET-354: a
 *                       restart is needed — verified live by BET-352 POC;
 *                       the opencode-claude-auth plugin reads the file at
 *                       startup, not at request time, despite the
 *                       RESULTS.md Q4 "no restart required" claim that was
 *                       not exercised against the positive path). Then
 *                       poll `GET /provider` until `anthropic` appears in
 *                       `connected[]` (or until the 15s deadline).
 *
 * BET-359 fold-in: when `backupPath` is supplied (set by `startClaudeLogin`),
 * the `"completed"` branch validates the freshly-written file and rolls
 * back from the snapshot via `restoreFromBackup` if the new file is empty
 * / malformed. A rollback is surfaced as `restore: { restored: true }` in
 * the response — never silent.
 *
 * Never throws. `restartOpencode` failure is non-fatal — the renderer can
 * still see `connected: true` on a slower retry.
 *
 * @param {{
 *   startedAt: number,
 *   restartOpencode?: typeof restartOpencodeImpl,
 *   getProviders?: typeof getProviders,
 *   now?: number,
 *   backupPath?: string | null,
 *   validator?: (rawFileText: string) => boolean,
 * }} args
 * @returns {Promise<
 *   | { state: "no-file" }
 *   | { state: "pre-existing" }
 *   | { state: "completed"; restart: { ok: true } | { ok: false; error: string }; connected: boolean; restartAttempts: number; restore?: { restored: true, from: string, to: string } | { restored: false, reason: string, error?: string } }
 * >}
 */
export async function pollClaudeLogin({
  startedAt,
  restartOpencode = restartOpencodeImpl,
  getProviders: getProvidersImpl = getProviders,
  now = Date.now(),
  backupPath = null,
  validator = defaultCredentialsValidator,
} = {}) {
  let stat;
  try {
    stat = await fsStat(CREDENTIALS_PATH);
  } catch {
    stat = { mtimeMs: null };
  }
  const progress = classifyClaudeLoginProgress(stat, startedAt);
  if (progress !== "completed") {
    return { state: progress };
  }

  // BET-359: validate the freshly-written file BEFORE bouncing opencode.
  // A `claude auth login` that overwrote the file with an empty / malformed
  // blob (mid-OAuth crash, disk-full, CLI bug) would otherwise be observed
  // as "completed" by the mtime check, and the subsequent restart would
  // leave every running session holding a half-broken token. The rollback
  // happens HERE — before restart — so a restored file is what opencode
  // sees on its next boot. Never throws (restoreFromBackup is contractually
  // non-throwing), so the surrounding flow is unaffected by a restore.
  const restore = await restoreFromBackup({
    credentialsFile: CREDENTIALS_PATH,
    backupPath,
    validator,
  });

  // Credentials updated → bounce opencode so the new tokens are read at
  // startup. Mirrors the desktop `restartOpencode()` from the existing
  // providers/subagents flow but called from the server side of the
  // connect card (the rpc.mjs wiring invokes it through this helper so
  // the restart happens with NO renderer involvement — the connect card
  // can be in any state, including "user is on another tab").
  //
  // We retry the restart up to 2 times because the `applying` phase in
  // ConnectProvider.tsx already polls `connected[]` and we want the second
  // restart attempt to win even if the first lost a systemctl race (the
  // opencode-serve unit may still be "activating" on the first try after
  // a fresh boot). The renderer's own 30s readiness poll (ConnectProvider
  // `applying` phase) is the source of truth for "user sees done".
  let restartResult;
  for (let attempt = 0; attempt < 2; attempt++) {
    restartResult = await restartOpencode();
    if (restartResult?.ok) break;
  }

  // Probe the provider list — opencode usually needs a moment to bind +
  // re-scan the auth store after a restart, so the first call often returns
  // an empty `connected[]`. The renderer's 30s readiness poll covers the
  // case where even our two-call attempt misses; this probe exists only so
  // a server-side caller (or a future non-renderer consumer) has a hint.
  let connected = false;
  try {
    const { connected: ids } = await getProvidersImpl();
    connected = Array.isArray(ids) && ids.includes("anthropic");
  } catch {
    connected = false;
  }

  return {
    state: "completed",
    restart: restartResult,
    connected,
    restartAttempts: 2,
    restore,
  };
}
