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
//   verifier consults an optional boxTokens map (box_id → expected box_token,
//   constant-time compared); if no map is configured it runs in DEV-OPEN mode
//   (any well-formed pair accepted) and logs a loud warning — the real
//   credential source (IAP-bound box_secret) is wired in Stage 5. verifyBox is
//   the single seam Stage 5 replaces; nothing else here changes.
//
// PORT: 20787 by default (bui 20xxx block per AGENTS.md), override with
//   RELAY_PORT. Bind host override with RELAY_HOST (default 0.0.0.0).

import { WebSocketServer } from "ws";
import { isValidToken, createRateLimiter } from "../server/webhooks.mjs";
import { tokenMatches } from "../server/auth.mjs";
import {
  RoutingTable,
  PendingRequests,
  encodeFrame,
  decodeFrame,
  FRAME_TYPES,
} from "./protocol.mjs";
import { openStore, BOX_STATUS } from "./store.mjs";

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
 * Build the default box verifier.
 *
 * @param {object} [opts]
 * @param {Map<string,string>|Record<string,string>|null} [opts.boxTokens]
 *   Optional box_id → expected box_token map. When provided, a handshake is
 *   accepted only if the presented token constant-time matches the stored one.
 *   When omitted (null), the relay runs DEV-OPEN: any shape-valid {boxId, token}
 *   is accepted (a loud warning is logged once). Stage 5 replaces this with the
 *   IAP-bound credential lookup.
 * @param {(msg:string)=>void} [opts.warn]  injectable warn sink (tests silence).
 */
export function createDefaultVerifier({ boxTokens = null, warn = console.warn } = {}) {
  const lookup =
    boxTokens == null
      ? null
      : boxTokens instanceof Map
        ? boxTokens
        : new Map(Object.entries(boxTokens));

  let warnedOpen = false;
  return function verifyBox({ boxId, token }) {
    // Shape gate first — both must be 32-hex. A malformed id/token is never
    // accepted, even in dev-open mode.
    if (!isValidToken(boxId) || !isValidToken(token)) return false;
    if (lookup == null) {
      if (!warnedOpen) {
        warnedOpen = true;
        warn(
          "[relay] DEV-OPEN auth: accepting any well-formed box handshake. " +
            "Configure boxTokens (or a Stage-5 verifier) before production.",
        );
      }
      return true;
    }
    const expected = lookup.get(boxId);
    if (typeof expected !== "string") return false;
    return tokenMatches(expected, token);
  };
}

// ---------------------------------------------------------------------------
// WS → protocol transport adapter
// ---------------------------------------------------------------------------

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
 *   box handshake verifier; defaults to createDefaultVerifier({ boxTokens }).
 * @param {Map|object|null} [opts.boxTokens]  passed to the default verifier.
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
    boxTokens = null,
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
  const verify = verifyBox || createDefaultVerifier({ boxTokens, warn });
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
