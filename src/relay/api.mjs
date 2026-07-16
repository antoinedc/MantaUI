// api.mjs — the PHONE-FACING leg of the relay (M2, BET-36 Stage 4).
//
// WHAT THIS SLICE IS: the HTTP surface a phone talks to, plus the phone→box
// proxy. The box-facing leg (Stage 2 `index.mjs`) already accepts box dial-outs
// and holds each box's live tunnel in the RoutingTable, and exposes a
// `proxyRequest(boxId, req)` that frames a phone request down that tunnel and
// resolves with the box's response. THIS slice sits on top of that:
//
//   1. Account↔box routing endpoints (phone-authenticated):
//        GET  /api/boxes                 → the authed account's boxes.
//        GET  /api/boxes/:box_id         → one box's details (must be owned).
//        POST /api/boxes/:box_id/revoke  → drop the box↔account binding.
//   2. Phone→box PROXY: any other /box/:box_id/<subpath> request is forwarded to
//        the box's live tunnel via proxyRequest and the box response is relayed
//        back. 503 when the box has no live tunnel; 504 on box timeout.
//   3. FREE vs GATED split (structure only): metadata subpaths (project list,
//        session titles/stats) are served free; transcript/stream/prompt/pty
//        subpaths pass through a requireSubscription seam that, for now, checks
//        the store for an active receipt bound to the box and returns 402 when
//        none exists. The actual Apple-receipt VALIDATION is Stage 5 — this
//        slice provides the gate seam + the 402, not the receipt crypto.
//
// WHAT THIS SLICE IS NOT (owned by later slices, do NOT add here):
//   - Real Apple IAP receipt validation + native push (APNs/FCM) + byte
//     metering                                                       → Stage 5
//   - The RN phone app.
//
// AUTH (phone leg): reuses `src/server/webhooks.mjs` isValidToken (shape) +
// createRateLimiter (per account/box token bucket). WHO a phone is (which
// account) is decided by an injectable `authenticatePhone(req)` seam. The
// default (createDefaultPhoneAuth) extracts a bearer token, shape-validates it,
// and looks up sha256(token) in the store's `account_tokens` table — only
// tokens minted at /pair time resolve. The seam itself remains so a future
// Stage-5 IAP-account lookup can be injected without touching the router.
//
// TESTABILITY: the router core operates on a NORMALIZED request object
// ({ method, path, headers, body }) and returns a normalized response
// ({ status, headers, body }), so every endpoint + the proxy + the gate is
// exercised under node:test with a store fake and a proxyRequest fake — no real
// HTTP server, no real sockets, no Apple calls. `attach(httpServer)` wraps the
// same core in a Node `http` request listener for the CLI entry.

import { isValidToken, createRateLimiter } from "../server/webhooks.mjs";
import { hashToken } from "./store.mjs";

// Per-phone-token rate limit for the API surface. A phone polls its box list and
// proxies a handful of requests; a token hammering the relay is throttled.
export const PHONE_RL_CAPACITY = 60;
export const PHONE_RL_REFILL_PER_SEC = 10;

// ---------------------------------------------------------------------------
// Free vs gated path classification (structure only; enforcement = Stage 5)
// ---------------------------------------------------------------------------

// A proxied box subpath is FREE (metadata) or GATED (subscription-only). The
// classification is deliberately a small, explicit prefix table rather than a
// scattered per-route check so Stage 5 wires receipt enforcement in ONE place
// (requireSubscription) against ONE source of truth.
//
// FREE (metadata): the pre-subscription preview surface — project/session lists,
//   titles, running/idle status, token/message/tool counts. These serve real
//   metadata so the phone can render the free preview.
// GATED (subscription): the full-capability surface — live transcript streaming,
//   sending prompts, terminal (PTY) access.
const GATED_PREFIXES = ["/transcript", "/stream", "/events", "/prompt", "/pty", "/message"];

/**
 * Classify a proxied box subpath as gated (subscription-only) or free.
 * `subpath` is the portion AFTER `/box/:box_id` (always begins with `/`).
 * Pure + exported so a test pins the free/gated boundary directly.
 */
export function isGatedSubpath(subpath) {
  if (typeof subpath !== "string" || !subpath) return false;
  // Normalize: compare against the first path segment so query strings and
  // deeper subpaths (`/stream/abc`) classify by their leading segment.
  const clean = subpath.split("?")[0];
  return GATED_PREFIXES.some(
    (p) => clean === p || clean.startsWith(`${p}/`),
  );
}

// ---------------------------------------------------------------------------
// Phone authentication seam
// ---------------------------------------------------------------------------

/**
 * Build the default phone authenticator (BET-152 / ADR-5).
 *
 * Extracts a bearer token from `Authorization: Bearer <t>` (or `?token=<t>`),
 * shape-validates it with isValidToken, and resolves it to an account_id by
 * looking up `sha256(token)` in the store's `account_tokens` table. The store
 * is REQUIRED (no dev-open fallback): a relay with no token store has no
 * known accounts and every phone request must reject.
 *
 * Returns a function (normReq) => { accountId } | null.
 *
 * @param {object} opts
 * @param {object} opts.store    an openStore() handle (getAccountByTokenHash).
 *                                Required.
 * @param {(msg:string)=>void} [opts.warn]  injectable warn sink (tests silence).
 */
export function createDefaultPhoneAuth({ store, warn = console.warn } = {}) {
  if (!store || typeof store.getAccountByTokenHash !== "function") {
    throw new Error("createDefaultPhoneAuth: store required");
  }
  return function authenticatePhone(req) {
    const token = extractBearer(req);
    if (!isValidToken(token)) return null;
    const accountId = store.getAccountByTokenHash(hashToken(token));
    return typeof accountId === "string" && accountId ? { accountId } : null;
  };
}

// Pull a bearer token out of a normalized request (Authorization header first,
// then ?token= fallback — same two forms the box handshake accepts).
function extractBearer(req) {
  const headers = req?.headers || {};
  const authz = headers["authorization"] || headers["Authorization"];
  if (typeof authz === "string" && authz.trim()) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    const t = (m ? m[1] : authz).trim();
    if (t) return t;
  }
  const q = parseQuery(req?.path).get("token");
  return q && q.trim() ? q.trim() : null;
}

// ---------------------------------------------------------------------------
// Subscription gate seam (Stage 5 replaces the check body, not the seam)
// ---------------------------------------------------------------------------

/**
 * Build the default subscription check: a box is entitled iff the store has at
 * least one receipt bound to it whose entitlement is active. THIS SLICE does NOT
 * validate the receipt against Apple — it only asks the store "is a receipt
 * bound and unexpired?". Stage 5 swaps the store's receipt rows for
 * Apple-validated ones; the seam (and the 402 the router returns) is unchanged.
 *
 * @param {object} store  a relay store (listReceiptsForBox).
 * @param {() => number} [now]
 * @returns {(boxId:string) => boolean}
 */
export function createDefaultSubscriptionCheck(store, now = () => Date.now()) {
  return function hasActiveSubscription(boxId) {
    let receipts;
    try {
      receipts = store.listReceiptsForBox(boxId);
    } catch {
      return false;
    }
    if (!Array.isArray(receipts) || receipts.length === 0) return false;
    const t = now();
    // Active = at least one receipt with no expiry, or an expiry in the future.
    return receipts.some(
      (r) => r.expires_at == null || Number(r.expires_at) > t,
    );
  };
}

// ---------------------------------------------------------------------------
// The relay API — normalized-request router + Node http adapter
// ---------------------------------------------------------------------------

/**
 * Create the phone-facing relay API.
 *
 * @param {object} opts
 * @param {object} opts.store                a relay store (bindings/boxes/receipts/account_tokens).
 * @param {(boxId,req,o?)=>Promise<{status,headers?,body?}>} opts.proxyRequest
 *   the box-tunnel proxy from createRelayServer().proxyRequest.
 * @param {(req)=>({accountId:string}|null)} [opts.authenticatePhone]
 *   phone auth seam; default createDefaultPhoneAuth({ store, warn }).
 * @param {(boxId:string)=>boolean} [opts.hasActiveSubscription]
 *   gate seam; default createDefaultSubscriptionCheck(store, now).
 * @param {(key:string)=>boolean} [opts.rateLimiter]  take(key)=>bool; created if omitted.
 * @param {() => number} [opts.now=Date.now]
 * @param {(...a)=>void} [opts.warn]
 */
export function createRelayApi(opts = {}) {
  const {
    store,
    proxyRequest,
    now = () => Date.now(),
    warn = console.warn,
  } = opts;

  if (!store) throw new Error("createRelayApi: store required");
  if (typeof proxyRequest !== "function") {
    throw new Error("createRelayApi: proxyRequest(boxId, req) required");
  }

  const authenticatePhone =
    opts.authenticatePhone || createDefaultPhoneAuth({ store, warn });
  const hasActiveSubscription =
    opts.hasActiveSubscription || createDefaultSubscriptionCheck(store, now);
  const rl =
    opts.rateLimiter ||
    createRateLimiter({
      capacity: PHONE_RL_CAPACITY,
      refillPerSec: PHONE_RL_REFILL_PER_SEC,
      now,
    });

  // -------------------------------------------------------------------------
  // Route a single normalized request. Returns a normalized response. Never
  // throws — a handler fault becomes a 500 so the HTTP layer always has a reply.
  // -------------------------------------------------------------------------
  async function route(req) {
    try {
      return await dispatch(req);
    } catch (err) {
      warn(`[relay-api] handler error: ${String(err?.message || err)}`);
      return json(500, { error: "internal_error" });
    }
  }

  async function dispatch(req) {
    const method = (req.method || "GET").toUpperCase();
    const pathname = (req.path || "/").split("?")[0];

    // Auth gate first — every phone-facing route requires an authenticated
    // account. 401 (not 404) so an unauthenticated caller can't probe route
    // existence.
    const auth = authenticatePhone(req);
    if (!auth || !auth.accountId) {
      return json(401, { error: "unauthorized" });
    }

    // Rate-limit per account (the token bucket key). A single account hammering
    // the surface is throttled; distinct accounts don't starve each other.
    if (!rl(`acct:${auth.accountId}`)) {
      return json(429, { error: "rate_limited" });
    }

    // GET /api/boxes — the authed account's boxes.
    if (method === "GET" && pathname === "/api/boxes") {
      const boxes = store.listBoxesForAccount(auth.accountId) || [];
      return json(200, { boxes: boxes.map((b) => boxView(b)) });
    }

    // /api/boxes/:box_id  and  /api/boxes/:box_id/revoke
    const apiMatch = /^\/api\/boxes\/([^/]+)(\/revoke)?$/.exec(pathname);
    if (apiMatch) {
      const boxId = apiMatch[1];
      const isRevoke = !!apiMatch[2];

      if (!isValidToken(boxId)) return json(404, { error: "not_found" });

      // Ownership: the box must be bound to THIS account. An unowned/unknown box
      // is 404 (don't leak existence of boxes owned by other accounts).
      const binding = store.getBinding(boxId);
      if (!binding || binding.account_id !== auth.accountId) {
        return json(404, { error: "not_found" });
      }

      if (isRevoke) {
        if (method !== "POST") return json(405, { error: "method_not_allowed" });
        const removed = store.unbindBox(boxId);
        return json(200, { revoked: removed, box_id: boxId });
      }

      // GET /api/boxes/:box_id — details.
      if (method !== "GET") return json(405, { error: "method_not_allowed" });
      const box = store.getBox(boxId);
      if (!box) return json(404, { error: "not_found" });
      return json(200, { box: boxView(box) });
    }

    // Phone→box PROXY:  /box/:box_id/<subpath>
    const proxyMatch = /^\/box\/([^/]+)(\/.*)?$/.exec(pathname);
    if (proxyMatch) {
      const boxId = proxyMatch[1];
      const subpath = proxyMatch[2] || "/";
      if (!isValidToken(boxId)) return json(404, { error: "not_found" });

      // Ownership gate — same as the routing endpoints.
      const binding = store.getBinding(boxId);
      if (!binding || binding.account_id !== auth.accountId) {
        return json(404, { error: "not_found" });
      }

      // Subscription gate seam: gated subpaths require an active receipt bound
      // to the box. Metadata subpaths are served free. (Stage 5 fills in real
      // receipt validation behind hasActiveSubscription.)
      if (isGatedSubpath(subpath) && !hasActiveSubscription(boxId)) {
        return json(402, { error: "payment_required", box_id: boxId });
      }

      // Forward to the box's live tunnel. The relay preserves the phone's method
      // + body and forwards the subpath (not the /box/:box_id prefix) so the box
      // server sees the request as if made locally.
      try {
        const resp = await proxyRequest(boxId, {
          method,
          path: subpath,
          headers: sanitizeForwardHeaders(req.headers),
          body: req.body,
        });
        return {
          status: Number.isInteger(resp?.status) ? resp.status : 502,
          headers: resp?.headers || { "content-type": "application/octet-stream" },
          body: resp?.body,
        };
      } catch (err) {
        if (err?.code === "no_tunnel") {
          return json(503, { error: "box_offline", box_id: boxId });
        }
        // Timeout or any other proxy failure → 504 (the box didn't answer in time).
        return json(504, { error: "box_timeout", box_id: boxId });
      }
    }

    return json(404, { error: "not_found" });
  }

  // -------------------------------------------------------------------------
  // Node http adapter — wrap `route` in a request listener.
  // -------------------------------------------------------------------------
  function nodeHandler() {
    return (httpReq, httpRes) => {
      const chunks = [];
      httpReq.on("data", (c) => chunks.push(c));
      httpReq.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
        const req = {
          method: httpReq.method,
          path: httpReq.url || "/",
          headers: httpReq.headers || {},
          body,
        };
        route(req).then((resp) => {
          const headers = { ...(resp.headers || {}) };
          const payload = resp.body == null ? "" : resp.body;
          if (!hasHeader(headers, "content-type")) {
            headers["content-type"] = "application/json";
          }
          httpRes.writeHead(resp.status, headers);
          httpRes.end(payload);
        });
      });
      httpReq.on("error", () => {
        try {
          httpRes.writeHead(400);
          httpRes.end();
        } catch {
          /* response may already be sent */
        }
      });
    };
  }

  return {
    route,
    nodeHandler,
    // exposed for tests / diagnostics
    _authenticatePhone: authenticatePhone,
    _hasActiveSubscription: hasActiveSubscription,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Normalize a stored box row into the phone-facing view. `tunnel_live` is left
// out here (the store row only knows persisted status/last_seen); the router
// reports persisted status. A live-tunnel flag would require the RoutingTable,
// which the API layer doesn't own — status/last_seen is the durable answer.
function boxView(b) {
  return {
    box_id: b.box_id,
    status: b.status,
    created_at: b.created_at,
    last_seen: b.last_seen,
  };
}

function json(status, obj) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function parseQuery(path) {
  try {
    const qs = typeof path === "string" ? path.split("?")[1] : "";
    return new URLSearchParams(qs || "");
  } catch {
    return new URLSearchParams("");
  }
}

// Strip hop-by-hop / auth headers before forwarding a phone request to the box.
// The relay's Authorization is a PHONE↔RELAY credential and must not be leaked
// to the box; the box tunnel is already authenticated at the socket layer.
function sanitizeForwardHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const DROP = new Set([
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
  ]);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!DROP.has(k.toLowerCase())) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
