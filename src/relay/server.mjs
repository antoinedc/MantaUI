// server.mjs — the COMBINED relay entrypoint (M2.7, BET-72).
//
// WHAT THIS SLICE IS: the shippable process that finally joins the two relay
// halves M2 built but never wired together. Before this file:
//   - `index.mjs` (Stage 2) started ONLY the box-facing WebSocket leg — a bare
//     WebSocketServer, no HTTP server.
//   - `api.mjs` (Stage 4) was a router core with no listener — nothing bound
//     `.nodeHandler()` to a port or handed it the box leg's `proxyRequest`.
//   - `iap.mjs` / `push.mjs` (Stage 5) were libraries with no HTTP routes
//     mounted at all.
// The BET-71 device check could only verify the composition via a throwaway
// in-process harness. This file makes that harness permanent, tested product
// code: ONE `http.Server` that serves BOTH legs on ONE port, sharing ONE store.
//
// COMPOSITION (mirrors the BET-71 harness shape):
//   - A single `http.Server`.
//   - WS `upgrade` on `/box`  → the Stage-2 box leg (`createRelayServer`), which
//     is created with an injected `noServer` WebSocketServer so it does NOT own
//     its own listener; we drive `handleUpgrade` from the shared server.
//   - All other HTTP → first the IAP + push routes mounted here, then (fallthrough)
//     the Stage-4 phone API (`createRelayApi().nodeHandler()`), wired with the
//     box leg's `proxyRequest`.
//   - ONE `openStore({ path })` shared by box leg, api, iap binding, and push.
//   - ONE `authenticatePhone` seam shared by the api AND the iap/push routes, so
//     both phone surfaces move together (and Stage 5 swaps them in one place).
//
// PORT: 127.0.0.1:20787 by default (bui 20xxx block; loopback because Caddy /
//   the `relay.mantaui.com` vhost fronts it). Override with RELAY_PORT /
//   RELAY_HOST. RELAY_PORT=0 selects an ephemeral port (tests, dev).
//
// WHAT'S STILL DEFERRED (live-provisioning, do NOT block on it here): real Apple
// x5c/verifyJws crypto, real APNs/FCM certs + prod PushSender. The relay's box
// auth (TOFU, BET-152) and account-token mint are now real (store-backed).

import http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { STATE_DIRNAME } from "../shared/paths.mjs";

import { createRelayServer } from "./index.mjs";
import {
  createRelayApi,
  createDefaultPhoneAuth,
  createDefaultSubscriptionCheck,
} from "./api.mjs";
import { createBoxMeter } from "./metering.mjs";
import { createReceiptValidator, bindReceipt } from "./iap.mjs";
import { createRelayPush } from "./push.mjs";
import { openStore, hashToken } from "./store.mjs";
import {
  isValidToken,
  createRateLimiter,
} from "../server/webhooks.mjs";

export const DEFAULT_RELAY_PORT = 20787;

// The WS upgrade path the box dials out to. Anything else that arrives as an
// upgrade is rejected (a stray WS upgrade must not fall into the HTTP router).
const BOX_UPGRADE_PATH = "/box";

// The device-facing terminal WS upgrade path. Parsed relative to /box/:id/pty
// — the path that a relay-paired device connects to so its terminal bytes
// flow through the tunnel's STREAM_* mux. The path is intentionally narrow
// (no wildcards) so an upgrade to /box/<id>/anything-else is rejected cleanly
// rather than silently misrouted.
const DEVICE_PTY_UPGRADE_RE = /^\/box\/([^/]+)\/pty$/;

// Cap on an IAP/push + /pair request body so an unbounded POST can't exhaust
// memory before the phone is even authenticated. 256 KiB is generous for a JWS
// + token registration; larger bodies are refused with 413.
const MAX_BODY_BYTES = 256 * 1024;

// The /pair bootstrap endpoint is UNAUTHENTICATED (the device has nothing to
// present yet — the whole point of /pair is to GET credentials). Rate-limited
// to mirror the box's own /auth/* limiter (src/server/auth.mjs AUTH_RL_*):
// capacity 10, refill 0.2/sec ≈ 12/min sustained — a human pairing needs a
// handful of hits; a guesser is throttled hard. Combined with the 5-min code
// TTL and the 10^6 pairing-code space, the code is not brute-forceable in the
// window.
export const PAIR_RL_CAPACITY = 10;
export const PAIR_RL_REFILL_PER_SEC = 0.2;

// A pairing code is exactly 6 decimal digits (matches the box-side
// isValidPairingCode in src/server/auth.mjs). Stricter than isValidToken so a
// pairing body can't smuggle a path or extra payload via the code field.
const PAIR_CODE_RE = /^\d{6}$/;

/**
 * Create (but do not start) the combined relay service: one http.Server serving
 * both the box WS leg and the phone HTTP API (+ IAP/push routes) on one port,
 * over one shared store.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]   defaults to RELAY_PORT env, else DEFAULT_RELAY_PORT.
 * @param {string} [opts.host]   defaults to RELAY_HOST env, else 127.0.0.1.
 * @param {object} [opts.store]  a shared openStore() handle; created from
 *                               storePath when omitted.
 * @param {string} [opts.storePath]  file path for the shared store (e.g.
 *                               ~/.manta/relay.sqlite); ":memory:" default.
 * @param {(req)=>({accountId:string}|null)} [opts.authenticatePhone]
 *   shared phone auth; defaults to createDefaultPhoneAuth({ store, warn }).
 * @param {(boxId,req,o?)=>Promise<{status,headers?,body?}>} [opts.proxyRequest]
 *   override the box-leg proxyRequest (tests inject a fake that bypasses the
 *   live tunnel; production uses boxLeg.proxyRequest).
 * @param {(jws:string)=>object} [opts.verifyJws]  IAP crypto seam (structural default).
 * @param {object} [opts.pushSender]  a PushSender (stub default).
 * @param {(key:string)=>boolean} [opts.pairRateLimiter]  take(key)=>bool for the
 *   unauthenticated /pair bootstrap; created if omitted.
 * @param {() => number} [opts.now=Date.now]
 * @param {(...a)=>void} [opts.log]
 * @param {(...a)=>void} [opts.warn]
 */
export function createRelayService(opts = {}) {
  const {
    port =
      process.env.RELAY_PORT !== undefined && process.env.RELAY_PORT !== ""
        ? Number(process.env.RELAY_PORT)
        : DEFAULT_RELAY_PORT,
    host = process.env.RELAY_HOST || "127.0.0.1",
    storePath,
    verifyJws,
    pushSender,
    now = () => Date.now(),
    log = console.log,
    warn = console.warn,
  } = opts;

  // ONE store shared by every leg. Created here (not by the box leg) so the
  // http.Server owns its lifecycle and close() tears it down exactly once.
  const store = opts.store || openStore({ path: storePath, now });

  // ONE phone-auth seam shared by the API and the IAP/push routes so both phone
  // surfaces authenticate identically and Stage 5 swaps them in one place.
  const authenticatePhone =
    opts.authenticatePhone || createDefaultPhoneAuth({ store, warn });

  // The subscription gate is also shared so the IAP validate route and the API's
  // 402 gate consult the SAME "is a receipt bound + unexpired?" logic.
  const hasActiveSubscription = createDefaultSubscriptionCheck(store, now);

  // --- Box-facing leg (Stage 2) --------------------------------------------
  // Build it with a noServer WebSocketServer so it does NOT open its own
  // listener; we drive handleUpgrade from the shared http.Server below.
  const wss = new WebSocketServer({ noServer: true });
  const boxLeg = createRelayServer({
    wss,
    store,
    log,
    warn,
    now,
  });

  // /pair uses the box leg's proxyRequest to forward the claim to the box's
  // own /auth/claim over its live tunnel. Tests inject a fake via opts.proxyRequest
  // to simulate offline / claim-rejected boxes without a real tunnel.
  const proxyRequest = opts.proxyRequest || boxLeg.proxyRequest;

  // /pair rate limiter (unauthenticated, see PAIR_RL_* constants).
  const pairRateLimiter =
    opts.pairRateLimiter ||
    createRateLimiter({
      capacity: PAIR_RL_CAPACITY,
      refillPerSec: PAIR_RL_REFILL_PER_SEC,
      now,
    });

  // --- Phone-facing API (Stage 4) ------------------------------------------
  // Wire it with the box leg's proxyRequest and the SHARED store + auth + gate.
  // The per-box meter (BET-157 §1) is the COGS instrument: every phone→box
  // request the api proxies is gated by the rate cap and counted into
  // store.getUsage(boxId) — surfaced as bytes_in/bytes_out on boxView. Built
  // once here so both the buffered proxy branch and the STREAM_DATA pump
  // (api.mjs) share the same meter instance.
  const meter = createBoxMeter({ store, now, warn });
  const api = createRelayApi({
    store,
    proxyRequest,
    meter,
    authenticatePhone,
    hasActiveSubscription,
    now,
    warn,
  });
  const apiHandler = api.nodeHandler();

  // --- IAP + push routes (Stage 5, mounted HERE) ---------------------------
  const receiptValidator = createReceiptValidator({ verifyJws, now, warn });
  const push = createRelayPush({
    store,
    sender: pushSender,
    now,
    log,
    warn,
  });

  const iapPushHandler = createIapPushHandler({
    store,
    authenticatePhone,
    receiptValidator,
    push,
    now,
    warn,
  });

  // --- /pair bootstrap (BET-152) -------------------------------------------
  // Unauthenticated (it IS the bootstrap). Rate-limited; on success mints a
  // device token and replies 200 {box_id, account_id, account_token}. The
  // account_token is the ONLY time the plaintext appears — the relay stores
  // only its sha256.
  const pairHandler = createPairHandler({
    store,
    proxyRequest,
    rateLimiter: pairRateLimiter,
    now,
    warn,
  });

  // --- The single http.Server ----------------------------------------------
  const server = http.createServer((req, res) => {
    // CORS preflight: the WKWebView sends an OPTIONS before a cross-origin
    // POST /pair. Answer it directly with 204 + the CORS headers so the real
    // POST is allowed — otherwise the browser aborts and the pairing fetch
    // hangs. (Previously this fell through to the API router's 405, which
    // carried no CORS headers → preflight failed → POST never sent.)
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    // /pair is unauthenticated (bootstrap) — try it first so a missing/wrong
    // body never reaches the authenticated IAP/push path. Then IAP/push, then
    // the phone API router.
    pairHandler(req, res, () => iapPushHandler(req, res, () => apiHandler(req, res)));
  });

  // A second noServer WebSocketServer dedicated to device-facing /pty upgrades
  // (BET-158). Kept separate from `wss` (the box leg) so each 'connection'
  // handler stays single-purpose — adding a third path later (chat, prompts,
  // …) gets its own wss rather than forking the box leg's connection handler.
  const ptyWss = new WebSocketServer({ noServer: true });

  // Route WS upgrades:
  //   /box           → box dial-out (existing — box leg)
  //   /box/:id/pty   → device terminal WS (BET-158 — phone-authenticated,
  //                    subscription-gated, tunnel-bridged)
  // Anything else is refused with a clean 404 so a stray upgrade can't hang.
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const pathname = url.pathname;

    if (pathname === BOX_UPGRADE_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Feed the accepted socket into the box leg's own 'connection' handler,
        // which does the credential parse + verify + acceptBox.
        wss.emit("connection", ws, req);
      });
      return;
    }

    const ptyMatch = DEVICE_PTY_UPGRADE_RE.exec(pathname);
    if (ptyMatch) {
      const boxId = ptyMatch[1];
      handlePtyUpgrade(req, socket, head, {
        boxId,
        url,
        authenticatePhone,
        store,
        hasActiveSubscription,
        boxLeg,
        ptyWss,
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const addr = server.address();
        const boundPort = addr && typeof addr === "object" ? addr.port : port;
        log(`[relay] listening on http://${host}:${boundPort} (box WS + phone API)`);
        resolve({ host, port: boundPort });
      });
    });
  }

  async function close() {
    // Detach the box leg's listener + fail in-flight proxied requests. The box
    // leg was built with an injected wss, so its close() only detaches its
    // 'connection' handler and closes the store — but we own the store here, so
    // we tolerate a double close (store.close swallows re-close).
    try {
      await boxLeg.close();
    } catch {
      /* box leg cleanup best-effort */
    }
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      wss.close();
    } catch {
      /* already closed */
    }
    try {
      ptyWss.close();
    } catch {
      /* already closed */
    }
    try {
      store.close();
    } catch {
      /* already closed by boxLeg.close() */
    }
  }

  return {
    server,
    store,
    boxLeg,
    api,
    push,
    meter,
    port,
    host,
    start,
    close,
    // exposed for tests / diagnostics
    _authenticatePhone: authenticatePhone,
    _hasActiveSubscription: hasActiveSubscription,
    _receiptValidator: receiptValidator,
    _pairHandler: pairHandler,
    _ptyWss: ptyWss,
  };
}

// ---------------------------------------------------------------------------
// POST /pair — the phone bootstrap (BET-152 / ADR-2, ADR-5)
//
// UNAUTHENTICATED (it is the bootstrap — the device has no credential yet).
// Rate-limited per box_id (mirrors the box's own /auth/* limiter so a brute
// force attempt is bounded the same way on both sides).
//
// On success: mints an account_token, stores hashToken(account_token) in
// account_tokens, returns the PLAINTEXT account_token to the device (the ONLY
// time it leaves the relay), and 200 { box_id, account_id, account_token }.
//
// On the box side: /pair proxies the user-presented 6-digit code to the box's
// own POST /auth/claim over the box's LIVE tunnel. The box is the source of
// truth on whether the code is valid. The relay NEVER sees the box_token —
// the box's response body is discarded entirely (ADR-1).
// ---------------------------------------------------------------------------

/**
 * Build the /pair request handler. Owns exactly `POST /pair` and calls
 * `next()` for everything else so the IAP/push + API chain handles the rest.
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {(boxId,req,o?)=>Promise<{status,headers?,body?}>} opts.proxyRequest
 * @param {(key:string)=>boolean} opts.rateLimiter
 * @param {() => number} [opts.now=Date.now]
 * @param {(msg:string)=>void} [opts.warn]
 */
export function createPairHandler({
  store,
  proxyRequest,
  rateLimiter,
  now = () => Date.now(),
  warn = console.warn,
}) {
  if (!store) throw new Error("createPairHandler: store required");
  if (typeof proxyRequest !== "function") {
    throw new Error("createPairHandler: proxyRequest required");
  }
  if (typeof rateLimiter !== "function") {
    throw new Error("createPairHandler: rateLimiter required");
  }

  return function handle(req, res, next) {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname !== "/pair") return next();
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    readBody(req, (err, body) => {
      if (err) {
        return sendJson(res, err.code === "too_large" ? 413 : 400, {
          error: err.code === "too_large" ? "payload_too_large" : "bad_request",
        });
      }

      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      routePair({ parsed, store, proxyRequest, rateLimiter, now, warn })
        .then((resp) => sendJson(res, resp.status, resp.json))
        .catch((e) => {
          warn(`[relay-pair] handler error: ${String(e?.message || e)}`);
          sendJson(res, 500, { error: "internal_error" });
        });
    });
  };
}

/**
 * Pure-ish /pair routing core (BET-152). Returns { status, json } so it can be
 * tested directly, like routeIapPush. The PROXIED box response body is
 * DISCARDED — only its status tells us whether the box accepted the claim.
 * The relay must never store, log, or return the box_token.
 *
 * Errors:
 *   400 bad_request      — malformed box_id or pairing code.
 *   429 rate_limited     — per-box bucket exhausted.
 *   401 claim_rejected   — box replied non-200 (do NOT leak box body).
 *   503 box_offline      — no live tunnel for this box_id.
 *   504 box_timeout      — tunnel live but no answer.
 */
export async function routePair({ parsed, store, proxyRequest, rateLimiter, now = () => Date.now(), warn = console.warn }) {
  const boxId = parsed.box_id ?? parsed.boxId;
  const code = parsed.code ?? parsed.pairing_code ?? parsed.pairingCode;

  // Validate shapes BEFORE rate-limiting so a malformed request doesn't burn a
  // bucket token a legitimate retry would otherwise have.
  if (!isValidToken(boxId) || typeof code !== "string" || !PAIR_CODE_RE.test(code)) {
    return { status: 400, json: { error: "bad_request" } };
  }

  if (!rateLimiter(`pair:${boxId}`)) {
    return { status: 429, json: { error: "rate_limited" } };
  }

  // Ask the live box to confirm the 6-digit code via its own /auth/claim.
  let resp;
  try {
    resp = await proxyRequest(boxId, {
      method: "POST",
      path: "/auth/claim",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    if (err?.code === "no_tunnel") {
      return { status: 503, json: { error: "box_offline" } };
    }
    // Timeout or any other proxy failure.
    return { status: 504, json: { error: "box_timeout" } };
  }

  const boxStatus = Number.isInteger(resp?.status) ? resp.status : 0;
  if (boxStatus !== 200) {
    // Box rejected (or any other non-200). Do NOT leak the box body — it can
    // carry diagnostic detail a brute-forcer would mine.
    return { status: 401, json: { error: "claim_rejected" } };
  }

  // Discard the box body entirely (it contains the box_token — ADR-1). We only
  // learn "the code was good" via the 200 status.
  void resp.body;

  // Bind or reuse the box's account (one account per box per ADR-5). The
  // `bindings.box_id` FK requires the boxes row to exist; /pair is the FIRST
  // time the relay learns about a box if it hasn't dialed in yet, so upsert
  // the box row first (offline — the box-leg dial-in upserts as ONLINE when
  // the tunnel comes up).
  if (!store.getBox(boxId)) {
    store.upsertBox(boxId, { status: "offline", at: now() });
  }
  let binding = store.getBinding(boxId);
  let accountId;
  if (!binding) {
    accountId = randomBytes(16).toString("hex"); // 32-char hex, opaque
    store.bindBox(boxId, accountId, { at: now() });
  } else {
    accountId = binding.account_id;
  }

  // Mint a fresh device token. Storing only the sha256 — the plaintext is the
  // payload returned to the device on this single 200 reply.
  const accountToken = randomBytes(16).toString("hex");
  store.addAccountToken(hashToken(accountToken), accountId, { at: now() });

  return {
    status: 200,
    json: {
      box_id: boxId,
      account_id: accountId,
      account_token: accountToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Device terminal WS — /box/:id/pty upgrade (BET-158)
//
// A relay-paired device connects a raw WebSocket to `/box/:id/pty` for
// terminal I/O. The relay bridges this socket to the box's local /pty WS over
// the tunnel's STREAM_* mux:
//   • device → box: WS text frames (JSON control strings) → STREAM_DATA
//     (utf8 passthrough — the JSON frames are already text).
//   • box → device: STREAM_DATA { enc:"b64" } → base64-decoded binary WS
//     frames (raw terminal bytes).
//
// Auth + ownership + subscription mirror the HTTP /box/:id proxy path:
//   1. Authenticate via authenticatePhone (Authorization header or ?token=).
//   2. Ownership: the box must be bound to this account (404 otherwise).
//   3. Subscription gate: /pty is a gated subpath (402 close otherwise).
//   4. StreamRequest over the box leg (rejects synchronously when the box
//      has no live tunnel — 503 close).
//
// Encoding rule (BET-158): device→box frames are the JSON control strings
// already-utf8; box→device frames are raw bytes that the agent base64-
// encodes. The relay decodes the base64 before forwarding to the device WS
// so a browser terminal sees raw bytes.
// ---------------------------------------------------------------------------

/**
 * Pure-ish handshake for the /box/:id/pty upgrade. Returns one of:
 *   { kind: "ok", accountId, boxId, subpath }
 *   { kind: "reject", status, body }
 * so the upgrade handler can map rejections to a 4xx HTTP handshake response
 * before the WebSocket is created — keeps the auth/subscription/ownership
 * testable without a real socket.
 *
 * `url` is the parsed upgrade URL. `subpath` is the portion of the original
 * query AFTER `?token=` is stripped — the relay forwards it to the box's
 * own /pty endpoint, which only sees ?session=&cwd=&cols=&rows=&launcher=…
 *
 * @param {object} args
 * @param {URL}    args.url
 * @param {string} args.boxId
 * @param {object} args.headers     node http req.headers
 * @param {(req)=>({accountId}|null)} args.authenticatePhone
 * @param {object} args.store
 * @param {(boxId)=>boolean} args.hasActiveSubscription
 */
export function routePtyUpgrade({ url, boxId, headers, authenticatePhone, store, hasActiveSubscription }) {
  if (!isValidToken(boxId)) {
    return { kind: "reject", status: 404, body: "not_found" };
  }
  // Pass the path WITH the query string — api.mjs's authenticatePhone reads
  // ?token= from the URL via parseQuery(req.path) (mirrors how httpApi.ts
  // and the device's authHeaders accept either header or query token).
  const fullPath = url.pathname + url.search;
  const auth = authenticatePhone({
    method: "GET",
    path: fullPath,
    headers: headers || {},
  });
  if (!auth || !auth.accountId) {
    return { kind: "reject", status: 401, body: "unauthorized" };
  }
  const binding = store.getBinding(boxId);
  if (!binding || binding.account_id !== auth.accountId) {
    return { kind: "reject", status: 404, body: "not_found" };
  }
  if (!hasActiveSubscription(boxId)) {
    return { kind: "reject", status: 402, body: "payment_required" };
  }
  // Strip ?token= (the device-side credential) before forwarding the query
  // down the tunnel — the agent will inject the BOX token itself (ADR-1).
  const subQuery = stripTokenParam(url.searchParams);
  return {
    kind: "ok",
    accountId: auth.accountId,
    boxId,
    subpath: subQuery,
  };
}

/**
 * Strip a `?token=` query param from a URLSearchParams, returning the
 * remaining query string with a leading `?` (or empty string).
 */
function stripTokenParam(params) {
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (k === "token") continue;
    out.append(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Drive the upgrade side: run routePtyUpgrade, then either
 * (a) reject the socket with the proper HTTP status, or
 * (b) open a stream to the box and bridge WS↔STREAM_*.
 *
 * Pure test entry point (`ptyWss` injectable so tests can spy on the
 * handleUpgrade call). The default ptyWss comes from the service-level
 * closure above (a noServer WebSocketServer dedicated to /pty).
 */
export function handlePtyUpgrade(
  req,
  socket,
  head,
  { boxId, url, authenticatePhone, store, hasActiveSubscription, boxLeg, ptyWss, warn = console.warn } = {},
) {
  if (!ptyWss || typeof ptyWss.handleUpgrade !== "function") {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  const decision = routePtyUpgrade({
    url,
    boxId,
    headers: req.headers || {},
    authenticatePhone,
    store,
    hasActiveSubscription,
  });
  if (decision.kind === "reject") {
    socket.write(`HTTP/1.1 ${decision.status} ${reasonText(decision.status)}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  ptyWss.handleUpgrade(req, socket, head, (ws) => {
    ptyWss.emit("connection", ws, req);
    // Hand off the live WS to the bridge. We pass an injectable bridge so
    // tests can drive the streamRequest/stream frames without spinning up
    // a real box leg — see server.test.mjs.
    bridgeDevicePty({
      ws,
      boxId: decision.boxId,
      subpath: decision.subpath,
      boxLeg,
      warn,
    });
  });
}

function reasonText(status) {
  if (status === 401) return "Unauthorized";
  if (status === 402) return "Payment Required";
  if (status === 404) return "Not Found";
  return "Bad Request";
}

/**
 * Bidirectional WS↔STREAM_* bridge for the device-facing /pty socket. Opens
 * a tunnel stream to the box with `stream:"pty"`, wires:
 *   • ws.on("message", text) → STREAM_DATA with utf8 data (no enc).
 *   • STREAM_DATA { enc:"b64" } from box → ws.send(Buffer.from(data, "base64")).
 *     A STREAM_DATA without enc is forwarded as a text frame (defensive — the
 *     agent always sets enc:"b64" for the box→device direction, but a future
 *     device message format change shouldn't silently misroute bytes).
 *   • ws.close / box STREAM_END / STREAM_ABORT → close both sides.
 *
 * Closing either side aborts the OTHER — a half-open terminal is a worse
 * failure mode than a clean teardown (the desktop Terminal reconnect loop is
 * the recovery path).
 */
export function bridgeDevicePty({ ws, boxId, subpath, boxLeg, warn = console.warn }) {
  let deviceClosed = false;
  let boxClosed = false;
  let streamHandle = null;

  function closeBoth(reason) {
    if (deviceClosed && boxClosed) return;
    // Close device side first — closing the WS unblocks the device's
    // reconnect controller (httpApi's WsReconnectController) faster than
    // waiting for the box leg's STREAM_ABORT to round-trip.
    if (!deviceClosed) {
      deviceClosed = true;
      try {
        ws.close(1000, reason || "closed");
      } catch {
        /* already closing */
      }
    }
    if (!boxClosed) {
      boxClosed = true;
      try {
        streamHandle?.abort(reason);
      } catch {
        /* ignore */
      }
    }
  }

  // Open the tunnel stream. streamRequest() rejects synchronously with
  // { noTunnel } semantics (fires onAbort("no_tunnel") and returns
  // { streamId: -1, abort: noop }) when the box has no live socket. We map
  // that to closing the device WS with a 1014 (bad gateway) so the client
  // surfaces "box offline" instead of an open socket that nothing happens on.
  const streamCallbacks = {
    onHead: (_h) => {
      // No HTTP head to write — the device WS is its own head. The box
      // agent will immediately start sending STREAM_DATA frames; nothing to
      // do here. (Kept as an explicit no-op for symmetry with /events and
      // future debug logs.)
    },
    onData: (data, frame) => {
      if (deviceClosed) return;
      try {
        // Box→device: raw terminal bytes. Default enc="utf8" means a text
        // payload — forward as text. enc="b64" means binary base64 — decode
        // and send as a binary frame.
        const enc = frame?.enc;
        if (enc === "b64") {
          ws.send(Buffer.from(data, "base64"));
        } else {
          // Default utf8 — send as a text frame so the device's terminal
          // sees the bytes the agent decoded.
          ws.send(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        }
      } catch (err) {
        warn(`[relay-pty] device send failed: ${String(err?.message || err)}`);
        closeBoth("device send failed");
      }
    },
    onEnd: () => {
      boxClosed = true;
      closeBoth("box ended");
    },
    onAbort: (reason) => {
      boxClosed = true;
      closeBoth(String(reason || "aborted"));
    },
  };

  try {
    streamHandle = boxLeg.streamRequest(
      boxId,
      { method: "GET", path: `/pty${subpath}`, headers: {}, body: undefined },
      streamCallbacks,
      // BET-158 — use the stable "pty" discriminator so the box agent
      // routes the STREAM_OPEN to the pty WS bridge (handleStreamOpenPty)
      // rather than the utf8 SSE pump (handleStreamOpen). The protocol
      // accepts string stream ids; the relay-side numeric stream counter
      // would still work, but the agent's onFrame dispatch reads frame.stream
      // and switches behavior on the literal "pty" string.
      { streamId: "pty" },
    );
    if (!streamHandle || streamHandle.streamId === -1) {
      // streamRequest already fired onAbort("no_tunnel") — just close the
      // device WS so the client sees the disconnect and reconnects (or the
      // renderer surfaces "box offline" via the /relay/status heartbeat).
      try { ws.close(1014, "box_offline"); } catch { /* ignore */ }
      return;
    }
  } catch (err) {
    warn(`[relay-pty] streamRequest failed: ${String(err?.message || err)}`);
    try { ws.close(1014, "stream_open_failed"); } catch { /* ignore */ }
    return;
  }

  // Device → box: text frames are the JSON control strings (utf8 passthrough).
  // Binary frames are unexpected on the wire (the device contract is text
  // JSON control strings — see BET-158 design) but we forward them as base64
  // STREAM_DATA so a future protocol upgrade doesn't drop bytes.
  //
  // BET-158 reviewer fix: route every outbound DATA through
  // streamHandle.send(), which stamps the frame's `id` field with the
  // numeric requestId. The previous ad-hoc helper (sendStreamData) used
  // streamId as both `id` and `stream` — when streamId === "pty" (the BET-158
  // string discriminator), the protocol validator rejects the frame's
  // non-integer id and the frame is silently dropped. Going through send()
  // is the only safe way to ship frames on a discriminator-keyed stream.
  ws.on("message", (raw, isBinary) => {
    if (boxClosed) return;
    if (!streamHandle || typeof streamHandle.send !== "function") return;
    try {
      if (isBinary) {
        // base64-encode and forward with enc:"b64" — matches the box-side
        // direction convention so the box agent decodes uniformly.
        const b64 = Buffer.isBuffer(raw) ? raw.toString("base64") : Buffer.from(raw).toString("base64");
        if (!streamHandle.send(b64, { enc: "b64" })) {
          closeBoth("send dropped");
        }
      } else {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        if (!streamHandle.send(text)) {
          closeBoth("send dropped");
        }
      }
    } catch (err) {
      warn(`[relay-pty] device→box send failed: ${String(err?.message || err)}`);
      closeBoth("send failed");
    }
  });

  ws.on("close", () => {
    deviceClosed = true;
    if (!boxClosed) {
      try { streamHandle?.abort("device closed"); } catch { /* ignore */ }
      boxClosed = true;
    }
  });
  ws.on("error", () => {
    // ws fires 'error' then 'close'; cleanup runs in close.
  });
}

// ---------------------------------------------------------------------------
// IAP + push HTTP routes
// ---------------------------------------------------------------------------

/**
 * Build the IAP + push request handler. It owns exactly these routes and calls
 * `next()` for everything else so the phone API router handles the rest:
 *
 *   POST /api/iap/validate   { box_id, jws }
 *     Validate a StoreKit 2 transaction JWS and bind receipt → box. Opens the
 *     subscription gate for that box. 200 { bound, verified }, 400/402/404.
 *   POST /api/iap/renewed    { box_id, signedPayload }
 *     App Store Server Notification v2 renewal/expiry. Same binding path via
 *     validateNotification. (DEV: box_id supplied in body; live Apple webhooks
 *     carry no bearer — a separate live-provisioning issue swaps the auth.)
 *   POST /api/push/register  { platform, token }
 *     Register the authed account's native APNs/FCM device token.
 *   POST /api/push/unregister { platform }
 *     Drop the authed account's token for a platform.
 *   POST /api/push/send      { box_id, payload }
 *     Trigger a push fan-out to the box owner's registered devices. Returns the
 *     routeNotification decision + delivered tokens (stub sender in DEV).
 *
 * Ownership: every route that names a box requires the authed account to own it
 * (binding.account_id === accountId), returning 404 otherwise so an unowned box
 * is indistinguishable from a missing one.
 */
export function createIapPushHandler({
  store,
  authenticatePhone,
  receiptValidator,
  push,
  now = () => Date.now(),
  warn = console.warn,
}) {
  if (!store) throw new Error("createIapPushHandler: store required");
  if (typeof authenticatePhone !== "function") {
    throw new Error("createIapPushHandler: authenticatePhone required");
  }

  const ROUTES = new Set([
    "/api/iap/validate",
    "/api/iap/renewed",
    "/api/push/register",
    "/api/push/unregister",
    "/api/push/send",
  ]);

  return function handle(req, res, next) {
    const pathname = (req.url || "/").split("?")[0];
    if (!ROUTES.has(pathname)) {
      return next();
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    readBody(req, (err, body) => {
      if (err) {
        return sendJson(res, err.code === "too_large" ? 413 : 400, {
          error: err.code === "too_large" ? "payload_too_large" : "bad_request",
        });
      }

      // Authenticate the phone using the SAME seam the API uses. The IAP/push
      // routes read the bearer from headers, so build a normalized req view.
      const normReq = { method: req.method, path: req.url || "/", headers: req.headers || {} };
      const auth = authenticatePhone(normReq);
      if (!auth || !auth.accountId) {
        return sendJson(res, 401, { error: "unauthorized" });
      }

      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return sendJson(res, 400, { error: "invalid_json" });
      }

      try {
        routeIapPush({ pathname, parsed, auth, store, receiptValidator, push, now })
          .then((resp) => sendJson(res, resp.status, resp.json))
          .catch((e) => {
            warn(`[relay-iap-push] handler error: ${String(e?.message || e)}`);
            sendJson(res, 500, { error: "internal_error" });
          });
      } catch (e) {
        warn(`[relay-iap-push] handler error: ${String(e?.message || e)}`);
        sendJson(res, 500, { error: "internal_error" });
      }
    });
  };
}

// The pure-ish routing core (async because push.deliver is async). Returns
// { status, json }. Ownership + validation live here so it's directly testable.
async function routeIapPush({ pathname, parsed, auth, store, receiptValidator, push, now }) {
  const accountId = auth.accountId;

  // Helper: assert the account owns box_id; returns the boxId or a 404 response.
  function ownedBox(boxId) {
    if (!isValidToken(boxId)) return { error: { status: 404, json: { error: "not_found" } } };
    const binding = store.getBinding(boxId);
    if (!binding || binding.account_id !== accountId) {
      return { error: { status: 404, json: { error: "not_found" } } };
    }
    return { boxId };
  }

  switch (pathname) {
    case "/api/iap/validate": {
      const boxId = parsed.box_id ?? parsed.boxId;
      const jws = parsed.jws ?? parsed.signedTransactionInfo;
      if (typeof jws !== "string" || !jws) {
        return { status: 400, json: { error: "jws_required" } };
      }
      const owned = ownedBox(boxId);
      if (owned.error) return owned.error;
      const result = receiptValidator.validate(jws);
      if (!result.ok) {
        // A structurally/crypto-invalid or expired receipt does not open the
        // gate. 402 so the phone knows it is still unpaid.
        return { status: 402, json: { error: "receipt_invalid", reason: result.reason } };
      }
      bindReceipt(store, { boxId: owned.boxId, transaction: result.transaction, raw: jws }, { now });
      return {
        status: 200,
        json: {
          bound: true,
          box_id: owned.boxId,
          verified: !!result.verified,
          original_transaction_id: result.transaction.originalTransactionId,
          expires_at: result.transaction.expiresAt ?? null,
        },
      };
    }

    case "/api/iap/renewed": {
      const boxId = parsed.box_id ?? parsed.boxId;
      const signedPayload = parsed.signedPayload ?? parsed.signed_payload;
      if (typeof signedPayload !== "string" || !signedPayload) {
        return { status: 400, json: { error: "signed_payload_required" } };
      }
      const owned = ownedBox(boxId);
      if (owned.error) return owned.error;
      const result = receiptValidator.validateNotification(signedPayload);
      if (!result.ok) {
        return { status: 402, json: { error: "receipt_invalid", reason: result.reason } };
      }
      bindReceipt(
        store,
        { boxId: owned.boxId, transaction: result.transaction, raw: signedPayload },
        { now },
      );
      return {
        status: 200,
        json: {
          bound: true,
          box_id: owned.boxId,
          verified: !!result.verified,
          notification_type: result.notificationType ?? null,
          expires_at: result.transaction.expiresAt ?? null,
        },
      };
    }

    case "/api/push/register": {
      const platform = parsed.platform;
      const token = parsed.token;
      if (typeof token !== "string" || !token) {
        return { status: 400, json: { error: "token_required" } };
      }
      try {
        push.register({ accountId, platform, token });
      } catch (e) {
        // A bad platform (not apns|fcm) trips the store's assertPlatform.
        return { status: 400, json: { error: "invalid_registration", reason: String(e?.message || e) } };
      }
      return { status: 200, json: { registered: true, platform } };
    }

    case "/api/push/unregister": {
      const platform = parsed.platform;
      try {
        const removed = push.unregister(accountId, platform);
        return { status: 200, json: { unregistered: removed !== false } };
      } catch (e) {
        return { status: 400, json: { error: "invalid_registration", reason: String(e?.message || e) } };
      }
    }

    case "/api/push/send": {
      const boxId = parsed.box_id ?? parsed.boxId;
      const payload = parsed.payload;
      if (!payload || typeof payload !== "object") {
        return { status: 400, json: { error: "payload_required" } };
      }
      const owned = ownedBox(boxId);
      if (owned.error) return owned.error;
      const summary = await push.deliver({ accountId, payload, presence: parsed.presence });
      return { status: 200, json: { ...summary } };
    }

    default:
      return { status: 404, json: { error: "not_found" } };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Read a request body up to MAX_BODY_BYTES; err.code === "too_large" past cap.
function readBody(req, cb) {
  const chunks = [];
  let total = 0;
  let done = false;
  const finish = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  req.on("data", (c) => {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("payload too large");
      err.code = "too_large";
      req.destroy();
      finish(err);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => finish(null, chunks.length ? Buffer.concat(chunks).toString("utf8") : ""));
  req.on("error", () => finish(Object.assign(new Error("read error"), { code: "read" })));
}

// CORS headers applied to EVERY relay response. The mobile app pairs by
// fetch()ing https://relay.mantaui.com/pair from the WKWebView origin
// (capacitor://localhost or https://localhost) — a cross-origin request. With
// no Access-Control-Allow-Origin the WKWebView blocks the response before it
// reaches JS, and on iOS this manifests as the pairing fetch HANGING (UI stuck
// on "connecting…") rather than a clean rejection. bui-server already sends
// these for the same reason (src/server/index.mjs); the relay must too.
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-box-id",
    "Access-Control-Max-Age": "600",
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders() });
  res.end(body);
}

// ---------------------------------------------------------------------------
// CLI entry — start the combined relay when run directly
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/relay/server.mjs");

if (isMain) {
  // Default the shared store to a file under ~/.manta so a restart keeps
  // box bindings + receipts. RELAY_STORE_PATH overrides.
  const storePath =
    process.env.RELAY_STORE_PATH ||
    (process.env.HOME ? `${process.env.HOME}/${STATE_DIRNAME}/relay.sqlite` : undefined);
  const svc = createRelayService({ storePath });
  svc
    .start()
    .then(({ host, port }) => {
      console.log(`[relay] combined entrypoint up on http://${host}:${port}`);
    })
    .catch((err) => {
      console.error("[relay] failed to start:", err);
      process.exit(1);
    });
  const shutdown = () => {
    svc.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
