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
//   the `bui.dev.antoinedc.com` vhost fronts it). Override with RELAY_PORT /
//   RELAY_HOST. RELAY_PORT=0 selects an ephemeral port (tests, dev).
//
// WHAT'S STILL DEFERRED (live-provisioning, do NOT block on it here — same seams
// M2 left open): real Apple x5c/verifyJws crypto, real APNs/FCM certs + prod
// PushSender, and the IAP-bound verifyBox/authenticatePhone lookups. This file
// only COMPOSES the DEV-OPEN/structural defaults into a runnable service.

import http from "node:http";
import { WebSocketServer } from "ws";

import { createRelayServer } from "./index.mjs";
import {
  createRelayApi,
  createDefaultPhoneAuth,
  createDefaultSubscriptionCheck,
} from "./api.mjs";
import { createReceiptValidator, bindReceipt } from "./iap.mjs";
import { createRelayPush } from "./push.mjs";
import { openStore } from "./store.mjs";
import { isValidToken } from "../server/webhooks.mjs";

export const DEFAULT_RELAY_PORT = 20787;

// The WS upgrade path the box dials out to. Anything else that arrives as an
// upgrade is rejected (a stray WS upgrade must not fall into the HTTP router).
const BOX_UPGRADE_PATH = "/box";

// Cap on an IAP/push request body so an unbounded POST can't exhaust memory
// before the phone is even authenticated. 256 KiB is generous for a JWS +
// token registration; larger bodies are refused with 413.
const MAX_BODY_BYTES = 256 * 1024;

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
 *                               ~/.bui-mobile/relay.sqlite); ":memory:" default.
 * @param {Map|object|null} [opts.boxTokens]     box-leg verifier seam.
 * @param {Map|object|null} [opts.accountTokens] phone-auth seam.
 * @param {(req)=>({accountId:string}|null)} [opts.authenticatePhone]
 *   shared phone auth; defaults to createDefaultPhoneAuth({ accountTokens }).
 * @param {(jws:string)=>object} [opts.verifyJws]  IAP crypto seam (structural default).
 * @param {object} [opts.pushSender]  a PushSender (stub default).
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
    boxTokens = null,
    accountTokens = null,
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
    opts.authenticatePhone || createDefaultPhoneAuth({ accountTokens, warn });

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
    boxTokens,
    log,
    warn,
    now,
  });

  // --- Phone-facing API (Stage 4) ------------------------------------------
  // Wire it with the box leg's proxyRequest and the SHARED store + auth + gate.
  const api = createRelayApi({
    store,
    proxyRequest: boxLeg.proxyRequest,
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

  // --- The single http.Server ----------------------------------------------
  const server = http.createServer((req, res) => {
    // Try the IAP/push routes first; they call res and return true when they
    // own the path. Otherwise fall through to the phone API router.
    iapPushHandler(req, res, () => apiHandler(req, res));
  });

  // Route WS upgrades: only /box reaches the box leg; anything else is refused.
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      pathname = "/";
    }
    if (pathname !== BOX_UPGRADE_PATH) {
      // Not a box dial-out; reject cleanly so a stray upgrade can't hang.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Feed the accepted socket into the box leg's own 'connection' handler,
      // which does the credential parse + verify + acceptBox.
      wss.emit("connection", ws, req);
    });
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
    port,
    host,
    start,
    close,
    // exposed for tests / diagnostics
    _authenticatePhone: authenticatePhone,
    _hasActiveSubscription: hasActiveSubscription,
    _receiptValidator: receiptValidator,
  };
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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// CLI entry — start the combined relay when run directly
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/relay/server.mjs");

if (isMain) {
  // Default the shared store to a file under ~/.bui-mobile so a restart keeps
  // box bindings + receipts. RELAY_STORE_PATH overrides.
  const storePath =
    process.env.RELAY_STORE_PATH ||
    (process.env.HOME ? `${process.env.HOME}/.bui-mobile/relay.sqlite` : undefined);
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
