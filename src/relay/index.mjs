// index.mjs — the relay process entry point (M2, BET-36 Stage 2).
//
// WHAT THIS SLICE IS: the BOX-FACING leg of the relay. Boxes sit behind NAT/
// CGNAT, so they cannot be dialed IN to; instead each box dials OUT to the relay
// and holds a single long-lived authenticated WebSocket. The relay accepts those
// outbound dial-outs, authenticates the box on the handshake, and registers the
// live socket in the Stage-1 RoutingTable keyed by box_id, persisting the box in
// the Stage-2 SQLite store. That is ALL this slice does.
//
// WHAT THIS SLICE IS NOT (owned by later slices, do not add here):
//   - The box-side dial-out CLIENT that opens the socket        → Stage 3
//   - The phone-facing HTTP endpoints + request/stream proxy    → Stage 4
//   - Push (APNs/FCM), IAP receipt validation, metering         → Stage 5
//
// AUTH MODEL (box handshake):
//   A box authenticates by presenting its box_id + box_token on the upgrade
//   request. Browsers/boxes differ in what they can set, so we accept the token
//   two ways, mirroring src/server/index.mjs's WS gate:
//     - Authorization: Bearer <box_token>  header (non-browser clients), OR
//     - ?token=<box_token>  query param     (fallback)
//   and the box_id as ?box_id=<box_id> query param (or an `x-box-id` header).
//   Both must pass isValidToken (32-hex) shape validation from webhooks.mjs, and
//   then an injectable verifyBox({boxId, token}) decides acceptance. The default
//   verifier (createDefaultVerifier) implements trust-on-first-use via the
//   store: sha256(token) is recorded on the first dial-out for a box_id; later
//   dial-outs must hash-compare (constant-time). verifyBox remains the seam for
//   an out-of-store verifier (e.g. Stage-5 IAP-bound secrets); nothing else
//   here changes.
//
// PORT: 20787 by default (bui 20xxx block per AGENTS.md), override with
//   RELAY_PORT. Bind host override with RELAY_HOST (default 0.0.0.0).

import { WebSocketServer } from "ws";
import { isValidToken, createRateLimiter } from "../server/webhooks.mjs";
import {
  RoutingTable,
  PendingRequests,
  StreamRegistry,
  encodeFrame,
  decodeFrame,
  FRAME_TYPES,
} from "./protocol.mjs";
import { openStore, BOX_STATUS, hashToken, hashEquals } from "./store.mjs";

export const DEFAULT_RELAY_PORT = 20787;

// Default timeout (ms) for a phone→box proxied request. A box that never
// answers must not leak a pending entry / hang the phone HTTP response forever;
// the correlation rejects with a timeout and the proxy maps that to a 504.
export const PROXY_REQUEST_TIMEOUT_MS = 30000;

// Rate limit for the UNAUTHENTICATED dial-in handshake — the only pre-auth
// surface a box hits. Keyed by remote IP. A genuine box reconnects a handful of
// times; a scanner hammering the port is throttled. Capacity 10, refill 0.5/s.
export const DIALIN_RL_CAPACITY = 10;
export const DIALIN_RL_REFILL_PER_SEC = 0.5;

// ---------------------------------------------------------------------------
// Handshake credential extraction (pure, tested)
// ---------------------------------------------------------------------------

/**
 * Pull the box_id + box_token out of an incoming upgrade request's URL + headers.
 * Header forms win over query params (a non-browser box can set headers; a
 * browser-like client falls back to the query string).
 *
 *   box_token: `Authorization: Bearer <t>` header  OR  ?token=<t>
 *   box_id:    `x-box-id: <id>` header             OR  ?box_id=<id>
 *
 * Returns { boxId, token } with either field null when absent/malformed. Does
 * NOT decide auth — that's verifyBox. This just parses.
 *
 * @param {object} args
 * @param {string} args.url        req.url (path + query)
 * @param {object} [args.headers]  req.headers
 * @param {string} [args.host]     req.headers.host (for URL base)
 */
export function parseHandshake({ url, headers = {}, host = "localhost" } = {}) {
  let parsed;
  try {
    parsed = new URL(url ?? "/", `http://${host || "localhost"}`);
  } catch {
    return { boxId: null, token: null, path: null };
  }

  // token: Authorization header first, then ?token=.
  let token = null;
  const authz = headers["authorization"];
  if (typeof authz === "string" && authz.trim()) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    token = (m ? m[1] : authz).trim() || null;
  }
  if (!token) {
    const q = parsed.searchParams.get("token");
    token = q && q.trim() ? q.trim() : null;
  }

  // box_id: x-box-id header first, then ?box_id=.
  let boxId = null;
  const hdrId = headers["x-box-id"];
  if (typeof hdrId === "string" && hdrId.trim()) {
    boxId = hdrId.trim();
  }
  if (!boxId) {
    const q = parsed.searchParams.get("box_id");
    boxId = q && q.trim() ? q.trim() : null;
  }

  return { boxId, token, path: parsed.pathname };
}

/**
 * Build the default box verifier (BET-152 / ADR-4: trust-on-first-use).
 *
 * Behavior:
 *   - Shape gate with isValidToken first (a malformed id/token is NEVER
 *     accepted, and NEVER registers — so a scanner can not seed itself).
 *   - Look up the stored credential for `boxId` in the store.
 *     - No row → first dial-out: persist `sha256(token)`, log the TOFU
 *       registration, accept.
 *     - Row present → accept iff `hashEquals(row.token_hash, hashToken(token))`.
 *     - Hash mismatch → reject (the box presented a different token for the
 *       same box_id; either the box owner rotated without us, or someone is
 *       trying to squat the id).
 *
 * `store` is REQUIRED. There is no dev-open fallback: a relay with no
 * credential store is misconfigured and every handshake must reject.
 *
 * @param {object} opts
 * @param {object} opts.store  an openStore() handle (getBoxCredential /
 *                              setBoxCredential). Required.
 * @param {(msg:string)=>void} [opts.warn]  injectable warn sink (tests silence).
 * @param {(msg:string)=>void} [opts.log]   injectable log sink for the TOFU
 *                                            registration line (tests silence).
 */
export function createDefaultVerifier({ store, warn = console.warn, log = console.log } = {}) {
  if (!store || typeof store.getBoxCredential !== "function") {
    throw new Error("createDefaultVerifier: store required");
  }
  return function verifyBox({ boxId, token }) {
    // Shape gate first — a malformed id/token is NEVER accepted AND never
    // registers, so an attacker can't probe to seed a row.
    if (!isValidToken(boxId) || !isValidToken(token)) return false;
    const cred = store.getBoxCredential(boxId);
    if (!cred) {
      // First dial-out for this box_id → trust-on-first-use: persist sha256
      // (NOT the plaintext token — ADR-1) and accept. setBoxCredential throws
      // on a UNIQUE collision, which surfaces as a hard reject (a stale in-mem
      // routing race or a deliberate double-register attempt).
      store.setBoxCredential(boxId, hashToken(token));
      log(`[relay] box ${boxId.slice(0, 8)} registered (TOFU)`);
      return true;
    }
    return hashEquals(cred.token_hash, hashToken(token));
  };
}

// ---------------------------------------------------------------------------
// noopStreamHandle — return shape for `streamRequest` when the box has no
// live tunnel (or no inbound-stream registry). The caller treats
// `streamId === -1` as "didn't open", and `abort`/`send` are no-ops. Kept
// exported from this module so tests can stub a transport-less call site.
// ---------------------------------------------------------------------------
function noopStreamHandle() {
  return {
    streamId: -1,
    requestId: -1,
    abort() {},
    send() { return false; },
  };
}



// Adapt a live `ws` WebSocket to the tiny transport contract the Stage-1
// RoutingTable/PendingRequests/StreamRegistry are written against
// (send/onMessage/onClose/close). `send` accepts either an already-encoded
// string frame or a frame object (which it encodes). Encode failures are
// swallowed (a programmer-built frame that fails validation must not crash the
// relay's send path) but reported via the optional onError hook.
export function wsTransport(ws, { onError } = {}) {
  return {
    ws,
    send(frame) {
      let raw;
      if (typeof frame === "string") {
        raw = frame;
      } else {
        try {
          raw = encodeFrame(frame);
        } catch (err) {
          onError?.(err);
          return;
        }
      }
      try {
        ws.send(raw);
      } catch (err) {
        onError?.(err);
      }
    },
    onMessage(cb) {
      ws.on("message", (data) => cb(data));
    },
    onClose(cb) {
      ws.on("close", () => cb());
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing/closed */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Relay server
// ---------------------------------------------------------------------------

/**
 * Create (but do not necessarily start) the relay server.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=DEFAULT_RELAY_PORT]
 * @param {string} [opts.host="0.0.0.0"]
 * @param {object} [opts.store]        an openStore() handle; created in-memory if omitted.
 * @param {string} [opts.storePath]    path passed to openStore when store omitted.
 * @param {(a:{boxId:string,token:string})=>boolean} [opts.verifyBox]
 *   box handshake verifier; defaults to createDefaultVerifier({ store, log, warn }).
 * @param {object} [opts.routingTable] a RoutingTable; created if omitted.
 * @param {(...a)=>void} [opts.log]     injectable logger (default console.log).
 * @param {(...a)=>void} [opts.warn]    injectable warn (default console.warn).
 * @param {() => number} [opts.now=Date.now]
 * @param {object} [opts.rateLimiter]  take(key)=>bool; created if omitted.
 * @param {WebSocketServer} [opts.wss] pre-built ws server (tests inject one on
 *                                     an ephemeral port); otherwise built here.
 */
export function createRelayServer(opts = {}) {
  const {
    // Honor an explicit RELAY_PORT=0 (ephemeral port, useful in tests/dev);
    // only fall back to the default when the env var is unset or empty. A plain
    // `Number(...) || DEFAULT` would wrongly treat "0" as falsy and override it.
    port =
      process.env.RELAY_PORT !== undefined && process.env.RELAY_PORT !== ""
        ? Number(process.env.RELAY_PORT)
        : DEFAULT_RELAY_PORT,
    host = process.env.RELAY_HOST || "0.0.0.0",
    storePath,
    verifyBox,
    log = console.log,
    warn = console.warn,
    now = () => Date.now(),
    rateLimiter,
    wss: injectedWss,
  } = opts;

  const store = opts.store || openStore({ path: storePath, now });
  const routing = opts.routingTable || new RoutingTable({
    onEvict: (boxId) => log(`[relay] evicted stale socket for box ${short(boxId)}`),
  });
  const verify = verifyBox || createDefaultVerifier({ store, log, warn });
  const rl =
    rateLimiter ||
    createRateLimiter({
      capacity: DIALIN_RL_CAPACITY,
      refillPerSec: DIALIN_RL_REFILL_PER_SEC,
      now,
    });

  // If a wss is injected (tests), reuse it; else build one that owns its own
  // http listener on { host, port }.
  const wss = injectedWss || new WebSocketServer({ host, port });
  const ownsWss = !injectedWss;

  // Track every accepted box connection so shutdown can close them cleanly and
  // tests can assert no open handles remain.
  const connections = new Set();

  // Per-box request/response correlation. The Stage-4 phone→box proxy sends a
  // REQUEST frame down a box's tunnel and awaits the matching RESPONSE; this map
  // holds the PendingRequests instance for each live box so the box socket's
  // inbound RESPONSE/ERROR frames resolve/reject the right promise. Keyed by the
  // live transport (not box_id) so a stale socket's late frames can't settle a
  // fresh reconnect's pending requests.
  const pendingByTransport = new Map(); // transport -> PendingRequests

  // Per-box INBOUND stream registry (BET-156). Phone→box stream requests are
  // opened on the relay via streamRequest(); the relay assigns a stream id,
  // registers a consumer in the box's per-transport registry, and forwards a
  // STREAM_OPEN request frame down the tunnel. The box's agent responds with
  // STREAM_OPEN (response form) + STREAM_DATA + STREAM_END, all routed through
  // this registry. Keyed by the live transport (not box_id) so a stale
  // socket's late frames can't settle a fresh reconnect's streams.
  const inboundStreamsByTransport = new Map(); // transport -> StreamRegistry

  // Monotonic stream id source for streamRequest. Starts at 1 so stream ids
  // never collide with REQUEST ids (PendingRequests owns its own counter
  // starting at 1 too — both spaces are independent of each other, but
  // keeping them distinct makes wire captures easier to read).
  let nextStreamId = 1;

  /**
   * Handle a single verified/authenticated box connection. Wires the ws into a
   * transport, registers it in the RoutingTable, persists the box row online,
   * and installs close cleanup (unregister + mark offline + bump last_seen).
   */
  function acceptBox(ws, boxId) {
    const transport = wsTransport(ws, {
      onError: (err) => warn(`[relay] send error for box ${short(boxId)}: ${err?.message}`),
    });
    connections.add(ws);

    // Correlation for phone→box proxied requests routed over THIS socket.
    const pending = new PendingRequests({ now });
    pendingByTransport.set(transport, pending);

    // Inbound stream registry for phone→box stream requests routed over THIS
    // socket. Created per-transport so a reconnect's fresh registry doesn't
    // carry stale entries from the previous socket.
    const inboundStreams = new StreamRegistry();
    inboundStreamsByTransport.set(transport, inboundStreams);

    // Register the live socket (evicts+closes any stale socket for this box).
    routing.register(boxId, transport);
    // Persist: box seen + online.
    store.upsertBox(boxId, { status: BOX_STATUS.ONLINE, at: now() });
    log(`[relay] box ${short(boxId)} connected (${routing.size} online)`);

    // Route inbound frames from the box:
    //   - PING     → answer with a PONG (liveness).
    //   - RESPONSE → resolve the matching proxied phone request.
    //   - ERROR    → reject the matching proxied phone request (if it carries an
    //                in-flight id); a bare error is logged, not fatal.
    // STREAM_* box→phone routing is exercised by the proxy's stream path in a
    // later slice; a stream frame with no matching consumer is simply ignored
    // here (never misrouted).
    ws.on("message", (data) => {
      const frame = decodeFrame(data);
      if (!frame) return;
      switch (frame.type) {
        case FRAME_TYPES.PING:
          transport.send({ type: FRAME_TYPES.PONG, id: frame.id });
          break;
        case FRAME_TYPES.RESPONSE:
          pending.resolve(frame);
          break;
        case FRAME_TYPES.STREAM_OPEN:
        case FRAME_TYPES.STREAM_DATA:
        case FRAME_TYPES.STREAM_END:
        case FRAME_TYPES.STREAM_ABORT:
          // Box→relay stream frames. The registry routes by stream id to the
          // consumer registered by streamRequest() (api.mjs). A frame for an
          // unknown stream id is dropped — the StreamRegistry's invariant.
          inboundStreams.handleFrame(frame);
          break;
        case FRAME_TYPES.ERROR:
          if (!pending.rejectFromError(frame)) {
            warn(`[relay] box ${short(boxId)} error: ${frame.message || frame.code || "unknown"}`);
          }
          break;
        default:
          break;
      }
    });

    const cleanup = () => {
      connections.delete(ws);
      // Fail every in-flight proxied request on this socket so no phone HTTP
      // response hangs across a box disconnect, then drop the correlation map.
      pending.rejectAll(new Error("box tunnel closed"));
      pendingByTransport.delete(transport);
      // Abort every live stream on this transport so phone-side streaming
      // responses close cleanly (BET-156 §3). The registry's onAbort callbacks
      // fire before we drop the map so handlers see the abort, not a hang.
      try { inboundStreams.abortAll("box tunnel closed"); } catch { /* ignore */ }
      inboundStreamsByTransport.delete(transport);
      // Only unregister if THIS socket is still the registered one (a fast
      // reconnect may have already replaced us — don't clobber the fresh one).
      routing.unregister(boxId, transport);
      // Persisting offline status can race relay shutdown (close() terminates
      // sockets, whose 'close' fires cleanup AFTER store.close()). Swallow a
      // closed-store throw so a shutdown-time disconnect can't crash the process.
      try {
        store.setBoxStatus(boxId, BOX_STATUS.OFFLINE, { at: now() });
      } catch {
        /* store already closed during shutdown */
      }
      log(`[relay] box ${short(boxId)} disconnected (${routing.size} online)`);
    };
    ws.on("close", cleanup);
    ws.on("error", () => {
      // ws emits 'error' then 'close'; cleanup runs on close. Swallow here so an
      // errored socket doesn't crash the process.
    });
  }

  /**
   * Proxy a single phone→box request over the box's live tunnel and resolve with
   * the box's { status, headers, body } RESPONSE. This is the correlation core
   * the Stage-4 phone-facing proxy (api.mjs) calls; it owns framing + timeout so
   * the HTTP layer stays transport-agnostic.
   *
   * Rejects with `err.code === "no_tunnel"` when the box has no live socket (the
   * caller maps that to 503), or with a timeout Error when the box never answers
   * within `timeoutMs` (caller maps that to 504).
   *
   * @param {string} boxId
   * @param {{method:string,path:string,headers?:object,body?:string}} req
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{status:number,headers?:object,body?:string}>}
   */
  function proxyRequest(boxId, req, { timeoutMs = PROXY_REQUEST_TIMEOUT_MS } = {}) {
    const transport = routing.lookup(boxId);
    if (!transport) {
      const err = new Error(`box ${short(boxId)} has no live tunnel`);
      err.code = "no_tunnel";
      return Promise.reject(err);
    }
    const pending = pendingByTransport.get(transport);
    if (!pending) {
      // Shouldn't happen (every live transport gets a PendingRequests), but be
      // defensive rather than throw synchronously into the HTTP handler.
      const err = new Error(`box ${short(boxId)} has no correlation channel`);
      err.code = "no_tunnel";
      return Promise.reject(err);
    }
    const { id, promise } = pending.create({ timeoutMs });
    transport.send({
      type: FRAME_TYPES.REQUEST,
      id,
      method: req.method,
      path: req.path,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body != null ? { body: req.body } : {}),
    });
    return promise;
  }

  /**
   * Proxy a single phone→box STREAMING request over the box's live tunnel and
   * pipe the box's stream back through the provided callbacks. The caller
   * (api.mjs's /box/:box_id/* handler) drives the phone's HTTP response from
   * these callbacks — onHead → writeHead; onData → write; onEnd / onAbort →
   * end. There is NO returned promise to await because the stream is the
   * response itself; the caller signals completion via end() in onEnd/onAbort.
   *
   * Rejects synchronously (returns `{ noTunnel: true }` shape via callback)
   * when the box has no live socket OR no inbound-stream registry — the caller
   * treats both as a 503 box_offline. Streams are NOT bounded by the
   * request/response timeout (SSE/PTY are long-lived by design); the caller
   * decides its own end-of-stream policy (relay close, device disconnect, …).
   *
   * Wire contract (BET-156 §3):
   *   • The relay assigns a monotonic stream id, registers a consumer in the
   *     box's per-transport inbound registry, and sends a STREAM_OPEN request
   *     form down the tunnel.
   *   • The box agent responds with STREAM_OPEN (response form, status+headers)
   *     → onHead({ status, headers }) fires.
   *   • The box agent pumps the response body as STREAM_DATA frames →
   *     onData(text) fires per frame.
   *   • The box agent sends STREAM_END (or STREAM_ABORT on error) → onEnd /
   *     onAbort(reason) fires.
   *
   * @param {string} boxId
   * @param {{method:string,path:string,headers?:object,body?:string}} req
   * @param {{
   *   onHead: ({status:number, headers:object}) => void,
   *   onData: (text:string, frame?:object) => void,
   *   onEnd:  () => void,
   *   onAbort: (reason:string) => void,
   * }} callbacks
   * @param {object} [opts]
   * @param {string|number} [opts.streamId]   override the monotonic stream
   *   id. Defaults to `nextStreamId++`. Use a stable string discriminator
   *   (e.g. "pty") when the box agent dispatches STREAM_OPEN by stream-type
   *   rather than by id (BET-158 — the agent reads `frame.stream` and routes
   *   to the pty WS bridge when it sees "pty").
   * @returns {{
   *   streamId: string|number,
   *   requestId: number,
   *   abort: (reason?:string) => void,
   *   send: (data: string, opts?: { enc?: "utf8"|"b64" }) => boolean,
   * }}
   *   `streamId` is the logical stream id (numeric by default, or the
   *   caller-supplied string discriminator). `requestId` is the numeric
   *   correlation id STREAM_* frames use to address this stream — frame
   *   fields are validated as integers (protocol.mjs:183-185), so callers
   *   that build outbound frames MUST stamp this id, NOT streamId, into
   *   the frame's `id` field. `abort()` cancels the stream and sends
   *   STREAM_ABORT to the box. `send(data, { enc })` pushes a STREAM_DATA
   *   frame on this stream and returns true on success / false if the
   *   stream is closed or the transport is gone.
   */
  function streamRequest(boxId, req, callbacks, opts = {}) {
    const transport = routing.lookup(boxId);
    if (!transport) {
      // Synchronous no-tunnel: no consumer registered yet, so fire onAbort
      // directly. The caller decides whether to surface 503 or close the
      // phone response.
      try {
        callbacks.onAbort("no_tunnel");
      } catch {
        /* caller ignored */
      }
      return noopStreamHandle();
    }
    const inboundStreams = inboundStreamsByTransport.get(transport);
    if (!inboundStreams) {
      try {
        callbacks.onAbort("no_tunnel");
      } catch {
        /* ignore */
      }
      return noopStreamHandle();
    }
    // Allocate a fresh stream id for this transport. The `id` field stays
    // numeric (the protocol's validator rejects non-integer ids) and is
    // used to correlate the request-side STREAM_OPEN with the agent's
    // response-side STREAM_OPEN. The `stream` field is the logical stream
    // id — a monotonic number by default, or a string discriminator
    // (BET-158 — "pty") when the caller wants the agent to dispatch by
    // stream type. The relay's inbound registry keys off `stream`, so
    // both numeric and string keys work.
    const streamId = opts.streamId ?? nextStreamId++;
    const requestId = nextStreamId++;
    let closed = false;

    // The consumer reads off `frame.status`/`frame.headers` for the response
    // head, then receives per-chunk DATA frames and END/ABORT.
    inboundStreams.open(streamId, {
      onOpen: (frame) => {
        if (closed) return;
        try {
          callbacks.onHead({
            status: frame.status,
            headers: frame.headers || {},
          });
        } catch {
          /* ignore caller errors */
        }
      },
      onData: (text, dataFrame) => {
        if (closed) return;
        try {
          callbacks.onData(text, dataFrame);
        } catch {
          /* ignore */
        }
      },
      onEnd: () => {
        if (closed) return;
        closed = true;
        try {
          callbacks.onEnd();
        } catch {
          /* ignore */
        }
      },
      onAbort: (reason) => {
        if (closed) return;
        closed = true;
        try {
          callbacks.onAbort(reason || "aborted");
        } catch {
          /* ignore */
        }
      },
    });

    // Send the request-side STREAM_OPEN. Body is only forwarded for non-GET/
    // non-HEAD methods (same rule as the request-frame branch).
    transport.send({
      type: FRAME_TYPES.STREAM_OPEN,
      id: requestId,
      stream: streamId,
      method: req.method,
      path: req.path,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body != null && req.method !== "GET" && req.method !== "HEAD"
        ? { body: req.body }
        : {}),
    });

    // Public abort: tear down the consumer locally + send STREAM_ABORT to the
    // box so the local fetch there closes. Idempotent — a second call is a
    // no-op (the onAbort consumer would have fired already or the stream is
    // already closed).
    function abort(reason) {
      if (closed) return;
      closed = true;
      // Locally free the id (the registry's abort fires the consumer's onAbort
      // — but the consumer's onAbort short-circuits via the closed flag above,
      // so callbacks.onAbort is invoked exactly once, here).
      inboundStreams.abort(streamId, reason || "client aborted");
      try {
        transport.send({
          type: FRAME_TYPES.STREAM_ABORT,
          id: requestId,
          stream: streamId,
          reason: reason || "client aborted",
        });
      } catch {
        /* socket closing; ignore */
      }
    }

    // Public send: push a STREAM_DATA frame for this stream. The protocol
    // requires `id` to be a non-negative integer (protocol.mjs:183-185), so
    // the relay ALWAYS stamps `requestId` (the numeric correlation id) —
    // not `streamId` — into the frame's `id` field. The caller may pass
    // `streamId === "pty"` (string discriminator, BET-158) without tripping
    // the validator. Returns false on a closed stream / gone transport.
    //
    // `enc` defaults to "utf8" — the SSE/JSON control frames ride this form.
    // For raw binary data (raw terminal bytes over /pty), pass
    // `enc: "b64"` and pre-base64-encode the payload. The encoding is the
    // CALLER's responsibility (mirrors the wire-side framing layer is
    // opaque to payload content).
    function send(data, sendOpts = {}) {
      if (closed) return false;
      if (!transport || !routing.lookup(boxId)) return false;
      const enc = sendOpts.enc;
      const frame = {
        type: FRAME_TYPES.STREAM_DATA,
        id: requestId,
        stream: streamId,
        data,
      };
      if (enc === "b64") frame.enc = "b64";
      try {
        transport.send(frame);
        return true;
      } catch {
        return false;
      }
    }

    return { streamId, requestId, abort, send };
  }

  // The connection handler: runs AFTER the ws handshake completes. We do the
  // credential parse + verify here (ws gives us req on 'connection'). A rejected
  // box is closed with a 4401 application close code (WS reserves <4000).
  function onConnection(ws, req) {
    const remote = req?.socket?.remoteAddress || "unknown";
    if (!rl(remote)) {
      closeWith(ws, 4429, "rate limited");
      return;
    }
    const { boxId, token } = parseHandshake({
      url: req?.url,
      headers: req?.headers || {},
      host: req?.headers?.host,
    });
    if (!isValidToken(boxId) || !isValidToken(token)) {
      closeWith(ws, 4401, "bad handshake");
      return;
    }
    let ok = false;
    try {
      ok = verify({ boxId, token }) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      closeWith(ws, 4401, "unauthorized");
      return;
    }
    acceptBox(ws, boxId);
  }

  wss.on("connection", onConnection);

  function start() {
    // A ws server built with { port } starts listening immediately; return a
    // promise that resolves once it's listening (or immediately if injected).
    if (!ownsWss) return Promise.resolve({ port, host });
    return new Promise((resolve, reject) => {
      if (wss.address()) {
        resolve({ port, host });
        return;
      }
      wss.once("listening", () => resolve({ port, host }));
      wss.once("error", reject);
    });
  }

  async function close() {
    // Fail any in-flight proxied requests so nothing hangs, then close sockets.
    for (const pending of pendingByTransport.values()) {
      try {
        pending.rejectAll(new Error("relay shutting down"));
      } catch {
        /* ignore */
      }
    }
    pendingByTransport.clear();
    // Close every live box socket, then the server, then the store.
    for (const ws of [...connections]) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    connections.clear();
    if (ownsWss) {
      await new Promise((resolve) => wss.close(() => resolve()));
    } else {
      // Injected wss: we only detach our listener; the owner closes it.
      wss.off("connection", onConnection);
    }
    try {
      store.close();
    } catch {
      /* store may be shared/already closed */
    }
  }

  return {
    wss,
    store,
    routing,
    port,
    host,
    start,
    close,
    // phone→box request correlation (Stage-4 phone-facing proxy calls this)
    proxyRequest,
    // phone→box streaming request correlation (BET-156 §3 — /events, future /pty)
    streamRequest,
    // exposed for tests / Stage 4 wiring
    _onConnection: onConnection,
    _acceptBox: acceptBox,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function closeWith(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
}

// A box_id is 32 hex; log only the first 8 so full pseudonyms don't hit logs.
function short(boxId) {
  return typeof boxId === "string" ? boxId.slice(0, 8) : String(boxId);
}

// ---------------------------------------------------------------------------
// CLI entry — start the relay when run directly (node src/relay/index.mjs)
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/relay/index.mjs");

if (isMain) {
  const relay = createRelayServer();
  relay
    .start()
    .then(({ host, port }) => {
      console.log(`[relay] listening on ws://${host}:${port} (box dial-out leg)`);
    })
    .catch((err) => {
      console.error("[relay] failed to start:", err);
      process.exit(1);
    });
  const shutdown = () => {
    relay.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
