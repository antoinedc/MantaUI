// agent/index.mjs — the BOX-SIDE dial-out client (M2, BET-36 Stage 3).
//
// WHAT THIS SLICE IS: the daemon that RUNS ON THE BOX and dials OUT to the
// relay. Boxes sit behind NAT/CGNAT and cannot be dialed IN to, so the box opens
// a single long-lived, authenticated outbound WebSocket to the relay and holds
// it. When the relay forwards a phone→box `request` frame down that tunnel, this
// client proxies it to the local box server (127.0.0.1:8787) and streams the
// response back over the tunnel, framed per the Stage-1 protocol.
//
// It is the mirror image of the Stage-2 relay server (`src/relay/index.mjs`):
//   - the relay ACCEPTS an inbound ws, authenticates the box on the handshake,
//     registers the live socket, and (Stage 4) will send `request` frames;
//   - THIS client DIALS OUT, presents its box_id + box_token on the handshake,
//     holds the socket, reconnects on drop, and answers `request` frames.
//
// WHAT THIS SLICE IS NOT (owned by later slices, do NOT add here):
//   - Phone-facing HTTP endpoints + the phone→box proxy on the relay  → Stage 4
//   - Push (APNs/FCM), IAP receipt validation, metering                → Stage 5
//   - Editing box-server routes — this slice only CALLS 127.0.0.1:8787 as a
//     client (via the injectable local-fetch leg).
//
// AUTH: reuses the box identity minted by `src/server/auth.mjs`
// (`~/.manta/auth.json` → { box_id, box_token }). We do NOT invent a new
// identity; `loadAuth()` is the single source, and the handshake presents the
// same `Authorization: Bearer <box_token>` + `x-box-id: <box_id>` the relay's
// `parseHandshake` expects.
//
// RECONNECT: mirrors the M0 "never permanently abandon WS reconnect" rule — the
// reconnect loop retries forever with exponential backoff (full-jitter) and only
// stops when `stop()` is called. The backoff is INJECTABLE and defaults to the
// `.mjs` mirror of `src/shared/net/backoff.ts` `ExponentialBackoff` (see
// createBackoff below for why the TS class can't be imported into a node:test
// `.mjs` and how the two are kept in lock-step by test).
//
// TRANSPORT-INJECTABLE: both I/O legs are injected so the whole client runs
// under node:test with fakes — no real network, no real box server:
//   - `connect(url, { headers })` → the outbound WS transport (send / onMessage
//     / onClose / close), defaulting to a real `ws` adapter.
//   - `localFetch(request)` → the leg that calls 127.0.0.1:8787, defaulting to
//     the global `fetch`.

import { loadAuth } from "../../server/auth.mjs";
import { isValidToken } from "../../server/webhooks.mjs";
import {
  encodeFrame,
  decodeFrame,
  FRAME_TYPES,
  StreamRegistry,
} from "../protocol.mjs";

// Default relay endpoint. Overridable via RELAY_URL or the `relayUrl` option.
// wss:// in production (TLS-terminated by the relay's front door); ws:// only
// for a same-box dev relay.
export const DEFAULT_RELAY_URL = "wss://relay.mantaui.com";

// Default local box server the client proxies requests to. The box server binds
// 0.0.0.0:8787 (src/server/index.mjs); we reach it over loopback.
export const DEFAULT_LOCAL_BASE = "http://127.0.0.1:8787";

// Reconnect backoff defaults (ms). Mirror the M0 SSE/WS reconnect: start ~1s,
// cap at 30s, grow x2, full-jitter — identical parameters to the
// ConnectionManager default in src/shared/net/connectionManager.ts.
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;

// ---------------------------------------------------------------------------
// Backoff — the .mjs mirror of src/shared/net/backoff.ts ExponentialBackoff
// ---------------------------------------------------------------------------
//
// WHY A MIRROR AND NOT AN IMPORT: `backoff.ts` is TypeScript compiled only by
// tsc/vite for the renderer/main bundles (tsconfig.web/node). This client is a
// pure `.mjs` exercised by `node --test`, which cannot import a `.ts` module at
// runtime and is not part of the typecheck graph — exactly like `protocol.mjs`
// and `index.mjs`, which also stay `.mjs` and inject their own clock rather than
// importing the TS primitives. So the DEFAULT backoff here is a tiny factory
// implementing the SAME formula and the SAME { next, reset, attempt } contract
// as ExponentialBackoff. A TS caller wiring this client can inject the canonical
// class directly (its instances satisfy this contract). The parity is pinned by
// a test ("backoff mirror matches ExponentialBackoff semantics") so the two
// cannot silently diverge. This is deliberate reuse-of-shape, not a competing
// second algorithm.
export function createBackoff({
  base = RECONNECT_BASE_MS,
  max = RECONNECT_MAX_MS,
  factor = 2,
  jitter = true,
  rng = Math.random,
} = {}) {
  let attempt = 0;
  return {
    next() {
      const computed = base * Math.pow(factor, attempt);
      const capped = Math.min(computed, max);
      attempt += 1;
      return jitter ? rng() * capped : capped;
    },
    reset() {
      attempt = 0;
    },
    attempt() {
      return attempt;
    },
  };
}

// ---------------------------------------------------------------------------
// Real `ws` transport (default connect()). Adapts a dialed-out ws WebSocket to
// the tiny transport contract (send / onMessage / onClose / close) the client
// is written against — the box-side twin of the relay's wsTransport().
// ---------------------------------------------------------------------------

// Lazily import `ws` only when a real connection is actually dialed, so tests
// (which inject a fake `connect`) never pull in the module and the client stays
// importable in environments without it.
async function defaultConnect(url, { headers } = {}) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(url, { headers });
  const msgCbs = [];
  const closeCbs = [];
  let openResolved = false;

  const transport = {
    ws,
    send(frame) {
      let raw;
      if (typeof frame === "string") {
        raw = frame;
      } else {
        try {
          raw = encodeFrame(frame);
        } catch {
          return; // programmer-built frame failed validation; never crash send
        }
      }
      try {
        ws.send(raw);
      } catch {
        /* socket closing/closed — the close handler drives reconnect */
      }
    },
    onMessage(cb) {
      msgCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing/closed */
      }
    },
  };

  ws.on("message", (data) => {
    for (const cb of msgCbs.slice()) cb(data);
  });
  ws.on("close", () => {
    for (const cb of closeCbs.slice()) cb();
  });
  // ws emits 'error' then 'close'; swallow 'error' so an errored socket doesn't
  // crash the process — the 'close' handler drives the reconnect.
  ws.on("error", () => {});

  // Resolve once the socket is open so the reconnect loop can reset its backoff
  // on a genuine connect. A socket that errors before opening rejects.
  await new Promise((resolve, reject) => {
    ws.once("open", () => {
      openResolved = true;
      resolve();
    });
    ws.once("error", (err) => {
      if (!openResolved) reject(err);
    });
  });

  return transport;
}

// ---------------------------------------------------------------------------
// Local-fetch leg (default localFetch()). Calls the box server over loopback.
// ---------------------------------------------------------------------------

// ADR-1 (BET-151): every relay→box proxied request must be authenticated to the
// LOCAL box server with the BOX's own `box_token`. Devices only ever hold an
// account token presented to the RELAY; they never see the box_token. So when
// the agent forwards a REQUEST frame to 127.0.0.1:8787 it must UNCONDITIONALLY
// overwrite any inbound `Authorization` header — including a foreign one
// accidentally carried in `frame.headers` — with `Bearer <box_token>`. Trusting
// the inbound value would let a misconfigured client pin the wrong auth and
// leak the box_token through the relay.
//
// `auth` is `{ box_id, box_token }`; in production it's whatever `loadAuth()`
// returned for the local box. The function is exported (named) so tests can
// drive it with a synthetic auth without standing up the whole agent.
//
// Header keys are matched case-insensitively (HTTP headers are case-insensitive;
// `Authorization`, `authorization`, and `AUTHORIZATION` all mean the same name).
// `frame.headers` is left unmutated (caller still owns the frame).
export function makeDefaultLocalFetch(localBase, auth) {
  if (!auth || !isValidToken(auth?.box_token)) {
    throw new Error(
      "makeDefaultLocalFetch: valid { box_token } required " +
        "(the box's own identity — never the device's account token)",
    );
  }
  const bearer = `Bearer ${auth.box_token}`;
  return async function defaultLocalFetch({ method, path, headers, body }) {
    const url = `${localBase}${path.startsWith("/") ? path : `/${path}`}`;
    // Copy the inbound headers verbatim, then drop ANY `authorization` key
    // (case-insensitive) and unconditionally install the BOX bearer.
    const outHeaders = {};
    if (headers && typeof headers === "object") {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === "authorization") continue;
        outHeaders[k] = headers[k];
      }
    }
    outHeaders.authorization = bearer;
    const res = await fetch(url, {
      method,
      headers: outHeaders,
      body: body != null && method !== "GET" && method !== "HEAD" ? body : undefined,
    });
    const respHeaders = {};
    for (const [k, v] of res.headers) respHeaders[k] = v;
    const text = await res.text();
    return { status: res.status, headers: respHeaders, body: text };
  };
}

// ---------------------------------------------------------------------------
// Streaming local-fetch leg (BET-156). Calls the box server over loopback but
// returns the response body as a stream (ReadableStream<Uint8Array>) instead
// of buffering. Used for SSE/PTY where buffering would defeat streaming.
// ---------------------------------------------------------------------------

// ADR-1 applies identically to the streaming fetch: every outbound request
// carries the box's own `Bearer <box_token>` regardless of what the inbound
// frame carried. Same case-insensitive header-stripping as makeDefaultLocalFetch.
//
// The returned function resolves with `{ status, headers, body }` where `body`
// is the response's ReadableStream — the caller (handleStreamOpen) reads it
// chunk-by-chunk and pumps each chunk as a STREAM_DATA frame.
//
// We do NOT consume the body here: stream consumers own the lifecycle and the
// relay decides when to abort/end. If the local fetch rejects (offline / TLS
// / etc.) the returned promise rejects — the caller emits STREAM_ABORT.
export function makeDefaultLocalFetchStream(localBase, auth) {
  if (!auth || !isValidToken(auth?.box_token)) {
    throw new Error(
      "makeDefaultLocalFetchStream: valid { box_token } required " +
        "(the box's own identity — never the device's account token)",
    );
  }
  const bearer = `Bearer ${auth.box_token}`;
  return async function defaultLocalFetchStream({ method, path, headers, body }) {
    const url = `${localBase}${path.startsWith("/") ? path : `/${path}`}`;
    const outHeaders = {};
    if (headers && typeof headers === "object") {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === "authorization") continue;
        outHeaders[k] = headers[k];
      }
    }
    outHeaders.authorization = bearer;
    const res = await fetch(url, {
      method,
      headers: outHeaders,
      body: body != null && method !== "GET" && method !== "HEAD" ? body : undefined,
    });
    const respHeaders = {};
    for (const [k, v] of res.headers) respHeaders[k] = v;
    return { status: res.status, headers: respHeaders, body: res.body };
  };
}

// ADR-1 (BET-151) — pure config decision: should the box server start the relay
// agent at boot? The product default is YES (relay-first is the path to a paid
// mobile app — BET-151). The owner's box can opt out by writing
// `"relayEnabled": false` into `~/.manta/config.json` (e.g. self-hosted with
// direct-HTTPS only). No env override here on purpose — configGet() is the
// single switch, mirroring how `chatAutoAllow` is gated.
//
// Truth table (tested):
//   undefined / null config   → true (relay-first default)
//   { relayEnabled: true }    → true
//   { relayEnabled: false }   → false
//   { relayEnabled: "no" }    → true (only `=== false` opts out — same shape
//                                 as a JS truthy check; do NOT over-engineer)
export function shouldStartRelayAgent(config) {
  if (config == null) return true;
  return config.relayEnabled !== false;
}

// ---------------------------------------------------------------------------
// RelayAgent — the dial-out client
// ---------------------------------------------------------------------------

/**
 * Create the box-side relay dial-out client.
 *
 * @param {object} [opts]
 * @param {string} [opts.relayUrl]   relay base ws/wss URL (default DEFAULT_RELAY_URL / env RELAY_URL)
 * @param {string} [opts.localBase]  local box server base (default DEFAULT_LOCAL_BASE)
 * @param {{box_id:string,box_token:string}} [opts.auth]
 *   box identity; defaults to loadAuth() from ~/.manta/auth.json. Plumbed into
 *   `makeDefaultLocalFetch` so every proxied request carries the BOX's own
 *   `Bearer <box_token>` to 127.0.0.1:8787 (ADR-1) — never a device token.
 * @param {(url:string,o:{headers:object})=>Promise<Transport>} [opts.connect]
 *   INJECTABLE outbound-WS opener. Resolves with a transport once connected,
 *   rejects if the connection fails. Defaults to the real `ws` adapter.
 * @param {(req:{method,path,headers,body})=>Promise<{status,headers,body}>} [opts.localFetch]
 *   INJECTABLE local-server leg. Defaults to `makeDefaultLocalFetch(localBase,
 *   auth)`, which overwrites any inbound `Authorization` header with the box's
 *   own bearer before calling `fetch`.
 * @param {(req:{method,path,headers,body})=>Promise<{status,headers,body}>} [opts.localFetchStream]
 *   INJECTABLE streaming local-server leg. Same auth-overwrite semantics as
 *   `localFetch`, but returns the response body as a ReadableStream (used for
 *   SSE/PTY where buffering would defeat streaming). Defaults to
 *   `makeDefaultLocalFetchStream(localBase, auth)`.
 * @param {{next():number,reset():void,attempt():number}} [opts.backoff]
 *   INJECTABLE reconnect backoff (ExponentialBackoff-compatible). Default mirror
 *   of src/shared/net/backoff.ts.
 * @param {(fn:()=>void,ms:number)=>any} [opts.setTimer]   default setTimeout
 * @param {(h:any)=>void} [opts.clearTimer]                default clearTimeout
 * @param {(...a:any)=>void} [opts.log]   injectable logger (default console.log)
 * @param {(...a:any)=>void} [opts.warn]  injectable warn   (default console.warn)
 */
export function createRelayAgent(opts = {}) {
  const {
    relayUrl = process.env.RELAY_URL || DEFAULT_RELAY_URL,
    localBase = DEFAULT_LOCAL_BASE,
    connect = defaultConnect,
    backoff = createBackoff(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    log = console.log,
    warn = console.warn,
  } = opts;

  const auth = opts.auth || loadAuth();
  if (!auth || !isValidToken(auth.box_id) || !isValidToken(auth.box_token)) {
    throw new Error(
      "createRelayAgent: valid { box_id, box_token } required " +
        "(run the box server once to mint ~/.manta/auth.json, or pass opts.auth)",
    );
  }
  const localFetch = opts.localFetch || makeDefaultLocalFetch(localBase, auth);
  const localFetchStream =
    opts.localFetchStream || makeDefaultLocalFetchStream(localBase, auth);

  // Per-box streams inbound over the tunnel (Stage-4 SSE/PTY). We own a registry
  // so a relay→box STREAM_* frame is routed, but the box→phone direction (this
  // client PRODUCING stream data) is what the request proxy drives below.
  const streams = new StreamRegistry();

  let transport = null; // current live transport, or null while (re)connecting
  let reconnectTimer = null;
  let stopped = false; // set by stop(); halts the reconnect loop permanently
  let started = false; // set by start(); the agent only counts as "live" once start() ran
  let connecting = false;

  // Build the authenticated dial-out URL + headers. The relay's parseHandshake
  // accepts box_id/token via header OR query; we present BOTH the header form
  // (canonical, non-browser) — query is unnecessary from a real client.
  function handshake() {
    const url = `${trimTrailingSlash(relayUrl)}/box`;
    const headers = {
      authorization: `Bearer ${auth.box_token}`,
      "x-box-id": auth.box_id,
    };
    return { url, headers };
  }

  // --- request proxy ------------------------------------------------------

  // Handle a relay→box REQUEST frame: proxy it to the local box server and send
  // a RESPONSE frame back correlated by the same id. On a local-fetch failure we
  // reply with an ERROR frame carrying the request id so the relay side settles
  // instead of hanging. The metadata GET path is fully exercised here.
  async function handleRequest(frame) {
    const t = transport;
    if (!t) return; // socket dropped between recv and dispatch; relay will retry
    try {
      const { status, headers, body } = await localFetch({
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: frame.body,
      });
      // Guard: the socket may have dropped while we awaited the local call.
      if (transport !== t) return;
      t.send({
        type: FRAME_TYPES.RESPONSE,
        id: frame.id,
        status,
        headers,
        body,
      });
    } catch (err) {
      if (transport !== t) return;
      t.send({
        type: FRAME_TYPES.ERROR,
        id: frame.id,
        code: "local_fetch_failed",
        message: String(err?.message || err),
      });
    }
  }

  // --- stream proxy (BET-156) ---------------------------------------------

  // Handle a relay→box STREAM_OPEN request form: open a streaming local fetch,
  // forward the response head (status + headers) back as STREAM_OPEN (response
  // form), then pump the response body as STREAM_DATA frames and STREAM_END on
  // clean completion. Aborts (STREAM_ABORT) on local-fetch error / read error.
  //
  // The relay assigned the stream id; the agent must echo the SAME id in its
  // outbound frames so the relay's inbound registry routes them to the right
  // consumer. The frame's `id` is the request's correlating id (kept around
  // for parity with non-stream REQUEST/RESPONSE).
  async function handleStreamOpen(frame) {
    const t = transport;
    if (!t) return; // socket dropped between recv and dispatch; relay will retry

    let res;
    try {
      res = await localFetchStream({
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: frame.body,
      });
    } catch (err) {
      if (transport !== t) return;
      try {
        t.send({
          type: FRAME_TYPES.STREAM_ABORT,
          id: frame.id,
          stream: frame.stream,
          reason: String(err?.message || err),
        });
      } catch {
        /* socket closing; ignore */
      }
      return;
    }

    // Guard: the socket may have dropped while we awaited the local call.
    if (transport !== t) {
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      return;
    }

    // Send the response head as STREAM_OPEN (response form). The relay's inbound
    // stream registry delivers this to the consumer's onOpen; that consumer
    // writes status + headers to the phone's HTTP response.
    const respHeaders = {};
    if (res.headers) {
      // Headers from node:fetch is a Headers object; from a fake test fixture
      // it's typically a Map. Both are iterable as [k, v] pairs — Object.entries
      // doesn't work on either (they're not plain objects), so iterate directly.
      for (const [k, v] of res.headers) respHeaders[k] = v;
    }
    try {
      t.send({
        type: FRAME_TYPES.STREAM_OPEN,
        id: frame.id,
        stream: frame.stream,
        status: res.status,
        headers: respHeaders,
      });
    } catch {
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      return;
    }

    // Pump body chunks as STREAM_DATA frames. The local fetch returns a
    // ReadableStream<Uint8Array>; we decode each chunk with TextDecoder
    // (stream:true handles multi-byte UTF-8 boundaries across chunks) so the
    // relay gets a string per frame — STREAM_DATA.data must be a string by
    // protocol.
    if (!res.body) {
      t.send({ type: FRAME_TYPES.STREAM_END, id: frame.id, stream: frame.stream });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Decode with stream:true so any unterminated multi-byte char at the
        // chunk tail is held over to the next chunk (TextDecoder docs).
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) {
          if (transport !== t) return; // socket dropped mid-pump
          t.send({
            type: FRAME_TYPES.STREAM_DATA,
            id: frame.id,
            stream: frame.stream,
            data: chunk,
          });
        }
      }
      // Flush any tail bytes the decoder held over.
      const tail = decoder.decode();
      if (tail) {
        if (transport !== t) return;
        t.send({
          type: FRAME_TYPES.STREAM_DATA,
          id: frame.id,
          stream: frame.stream,
          data: tail,
        });
      }
      if (transport !== t) return;
      t.send({ type: FRAME_TYPES.STREAM_END, id: frame.id, stream: frame.stream });
    } catch (err) {
      try {
        if (transport === t) {
          t.send({
            type: FRAME_TYPES.STREAM_ABORT,
            id: frame.id,
            stream: frame.stream,
            reason: String(err?.message || err),
          });
        }
      } catch {
        /* socket closing; ignore */
      }
    }
  }

  // Dispatch one decoded inbound frame.
  function onFrame(frame) {
    if (!frame) return; // decodeFrame dropped malformed/oversized/unknown input
    switch (frame.type) {
      case FRAME_TYPES.REQUEST:
        // Metadata GET (and any other single request/response) → proxy now.
        void handleRequest(frame);
        break;
      case FRAME_TYPES.STREAM_OPEN:
        // Request-side open from the relay → open a local streaming fetch and
        // pipe the response back over STREAM_OPEN (response form) + DATA + END.
        // The agent IS the local producer for SSE/PTY streams; the inbound
        // stream registry (this.streams) is for the box→relay direction
        // (already-driven, no-op for the request form here).
        // Guard on the form: a response-side STREAM_OPEN (status, no method)
        // arriving from the relay is a protocol error — drop.
        if (typeof frame.method === "string") {
          void handleStreamOpen(frame);
        } else {
          warn("[relay-agent] ignored STREAM_OPEN without method (response form from relay is invalid)");
        }
        break;
      case FRAME_TYPES.STREAM_DATA:
      case FRAME_TYPES.STREAM_END:
      case FRAME_TYPES.STREAM_ABORT:
        // Box→relay stream frames — routed through the per-transport inbound
        // stream registry. (No box-side consumer registers these today, so
        // the registry's drop-on-no-consumer invariant is fine: a stray
        // STREAM_DATA from the relay is a protocol bug, not a data path.)
        streams.handleFrame(frame);
        break;
      case FRAME_TYPES.PONG:
        // Liveness reply to a PING we sent (ping() below). Nothing to do beyond
        // the fact that a frame arrived — the socket is alive.
        break;
      case FRAME_TYPES.PING:
        // The relay may probe us; answer so it can measure the tunnel is alive.
        transport?.send({ type: FRAME_TYPES.PONG, id: frame.id });
        break;
      case FRAME_TYPES.ERROR:
        // A bare transport-level error from the relay. Log and keep the tunnel.
        warn(`[relay-agent] relay error: ${frame.message || frame.code || "unknown"}`);
        break;
      default:
        break;
    }
  }

  // --- connect / reconnect loop ------------------------------------------

  // Open one connection. On success, wire message/close handlers and reset the
  // backoff. On failure OR a later close, schedule a backoff-delayed reconnect —
  // forever, until stop() (the "never permanently abandon reconnect" invariant).
  async function openOnce() {
    if (stopped || connecting || transport) return;
    connecting = true;
    const { url, headers } = handshake();
    let t;
    try {
      t = await connect(url, { headers });
    } catch (err) {
      connecting = false;
      warn(`[relay-agent] dial-out failed: ${String(err?.message || err)}`);
      scheduleReconnect();
      return;
    }
    connecting = false;
    if (stopped) {
      // stop() raced our connect; close the freshly-opened socket and bail.
      try {
        t.close();
      } catch {
        /* ignore */
      }
      return;
    }
    transport = t;
    backoff.reset();
    log(`[relay-agent] connected to relay as box ${short(auth.box_id)}`);

    t.onMessage((data) => {
      onFrame(decodeFrame(data));
    });
    t.onClose(() => {
      if (transport === t) transport = null;
      // Every live stream must be torn down so nothing hangs half-open across a
      // reconnect (Stage-4 consumers get onAbort).
      streams.abortAll("relay tunnel closed");
      if (stopped) return;
      log(`[relay-agent] tunnel closed; reconnecting`);
      scheduleReconnect();
    });
  }

  // Schedule the next reconnect after a backoff delay. Guards against stacking
  // multiple timers and against running after stop().
  function scheduleReconnect() {
    if (stopped || reconnectTimer || transport || connecting) return;
    const delay = backoff.next();
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (stopped) return;
      void openOnce();
    }, delay);
  }

  // --- public API ---------------------------------------------------------

  // Start dialing out. Idempotent; returns immediately (the first connect runs
  // async and the loop keeps it alive). Await the returned promise to block
  // until the first connection is established (tests use this).
  async function start() {
    stopped = false;
    started = true;
    await openOnce();
  }

  // Send a liveness PING over the tunnel (optional; the relay answers PONG).
  // Returns true if a live transport carried it.
  function ping(id = 0) {
    if (!transport) return false;
    transport.send({ type: FRAME_TYPES.PING, id });
    return true;
  }

  // Stop the client permanently: halt the reconnect loop, cancel any pending
  // timer, tear down live streams, and close the socket. Idempotent. After
  // stop() the client leaves NO open sockets/timers (clean teardown invariant).
  function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
    streams.abortAll("relay-agent stopped");
    if (transport) {
      const t = transport;
      transport = null;
      try {
        t.close();
      } catch {
        /* already closing/closed */
      }
    }
  }

  return {
    start,
    stop,
    ping,
    // Coarse live-state snapshot for the box-server's /relay/status endpoint
    // (install.sh + the renderer dashboard want to know whether the relay
    // handshake succeeded). Three states, no partial ambiguity:
    //   "stopped"    — stop() was called (or before start()); never reconnects
    //   "connected"  — a live transport is open (socket → relay is up)
    //   "connecting" — a dial is in flight OR a reconnect is scheduled
    // `connecting` is intentionally sticky across reconnects so a UI asking
    // "is the link healthy?" doesn't flicker connected/connecting during the
    // backoff window — the link is alive in the sense that the loop hasn't
    // given up, it just isn't open yet.
    status() {
      // "stopped" covers two real states: never started AND stop()'d. Both
      // mean the agent is NOT currently trying to reach the relay. A UI or
      // `/relay/status` consumer treats them identically — the link is down
      // for a reason the box server can explain, not just transient silence.
      if (!started || stopped) return "stopped";
      if (transport) return "connected";
      return "connecting";
    },
    // introspection for tests / Stage-4 wiring
    boxId: auth.box_id,
    isConnected: () => transport != null,
    _onFrame: onFrame,
    _streams: streams,
    _handshake: handshake,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function trimTrailingSlash(u) {
  return typeof u === "string" && u.endsWith("/") ? u.slice(0, -1) : u;
}

// A box_id is 32 hex; log only the first 8 so full pseudonyms don't hit logs.
function short(boxId) {
  return typeof boxId === "string" ? boxId.slice(0, 8) : String(boxId);
}

// ---------------------------------------------------------------------------
// CLI entry — start the client when run directly (node src/relay/agent/index.mjs)
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/relay/agent/index.mjs");

if (isMain) {
  const agent = createRelayAgent();
  agent
    .start()
    .then(() => {
      console.log("[relay-agent] dial-out client running");
    })
    .catch((err) => {
      console.error("[relay-agent] failed to start:", err);
      process.exit(1);
    });
  const shutdown = () => {
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
