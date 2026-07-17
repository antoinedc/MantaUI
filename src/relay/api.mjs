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
// Streaming classification — which subpaths are stream-muxed (BET-156 §3)
// ---------------------------------------------------------------------------
//
// The relay can forward a phone request to the box via the buffered
// proxyRequest path (request + response, body buffered at the box's local
// fetch — fine for JSON/snapshots) OR via the streaming streamRequest path
// (SSE-style incremental chunks pumped as STREAM_* frames — required for
// /events so the phone's EventSource receives bytes as the box emits them).
// The decision is subpath-based, NOT content-type-based: the relay doesn't
// know what the box will return until it asks, and asking first would defeat
// the streaming behavior we want.
//
// The list is deliberately small and explicit (mirrors GATED_PREFIXES): every
// path here must be a known streaming endpoint on the box server. Adding a new
// entry is a one-line change AND a contract change with the box — both must
// land together. Don't add a wildcard.
const STREAMING_SUBPATH_PREFIXES = ["/events"];

/**
 * Classify a proxied box subpath as streaming (forwarded via STREAM_* frames)
 * or buffered (forwarded via REQUEST/RESPONSE). Pure + exported so a test
 * pins the boundary directly.
 */
export function isStreamingSubpath(subpath) {
  if (typeof subpath !== "string" || !subpath) return false;
  const clean = subpath.split("?")[0];
  return STREAMING_SUBPATH_PREFIXES.some(
    (p) => clean === p || clean.startsWith(`${p}/`),
  );
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
 * @param {(boxId,req,callbacks)=>{streamId:number,abort:(reason?:string)=>void}} [opts.streamRequest]
 *   the streaming box-tunnel proxy from createRelayServer().streamRequest. Used
 *   for /events (and any future streaming subpath); non-streaming requests keep
 *   using proxyRequest so the buffered path is unchanged. Optional for
 *   backwards-compat — when omitted, streaming subpaths fall back to the
 *   buffered path (SSE bytes arrive all at once, which is the pre-BET-156
 *   behavior and lets older relays still satisfy the rest of the surface).
 * @param {(req)=>({accountId:string}|null)} [opts.authenticatePhone]
 *   phone auth seam; default createDefaultPhoneAuth({ store, warn }).
 * @param {(boxId:string)=>boolean} [opts.hasActiveSubscription]
 *   gate seam; default createDefaultSubscriptionCheck(store, now).
 * @param {object} [opts.meter]  the per-box meter from createBoxMeter({ store, now }).
 *   When provided, the proxy branch enforces the per-box cap (over-cap → 429
 *   `quota_exceeded`), records byte counters (ingress once on the request body,
 *   egress once for buffered responses or per STREAM_DATA chunk for streamed
 *   responses), and `boxView` exposes `bytes_in`/`bytes_out` from the store.
 *   Optional so callers (and tests) without a meter still get full routing.
 *   See BET-157 / metering.mjs for the contract.
 * @param {(key:string)=>boolean} [opts.rateLimiter]  take(key)=>bool; created if omitted.
 * @param {() => number} [opts.now=Date.now]
 * @param {(...a)=>void} [opts.warn]
 */
export function createRelayApi(opts = {}) {
  const {
    store,
    proxyRequest,
    streamRequest,
    meter = null,
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
  //
  // `streamingSink` is optional. When the request is for a streaming subpath
  // (/events), dispatch sets up the STREAM_* proxy and pipes every frame into
  // the sink instead of returning a buffered response. The nodeHandler sees
  // the `__stream` sentinel on the returned response and drives the sink.
  // -------------------------------------------------------------------------
  async function route(req, streamingSink) {
    try {
      return await dispatch(req, streamingSink);
    } catch (err) {
      warn(`[relay-api] handler error: ${String(err?.message || err)}`);
      return json(500, { error: "internal_error" });
    }
  }

  async function dispatch(req, streamingSink) {
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
      return json(200, { boxes: boxes.map((b) => boxView(b, store.getUsage(b.box_id))) });
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
      return json(200, { box: boxView(box, store.getUsage(boxId)) });
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

      // Streaming subpaths (/events etc) take the STREAM_* path: the relay
      // opens a stream to the box, then drives the phone's HTTP response
      // from the box's STREAM_* frames. The router signals "I'm handling
      // this inline" by returning a __stream sentinel whose `handler` the
      // nodeHandler drives directly.
      //
      // When streamRequest is not configured (older relay) we fall through
      // to the buffered path — pre-BET-156 behavior, the phone gets the
      // full body at end-of-stream. Better than refusing the request.
      if (isStreamingSubpath(subpath) && streamRequest) {
        // Cap check before opening the stream (BET-157 §3): an over-cap
        // request never frames STREAM_OPEN — we return a buffered 429 JSON
        // so the phone sees the rejection as a status, not as a silently
        // closed stream. GATED vs FREE is metered identically — the bucket
        // selection uses hasActiveSubscription as the `paid` flag.
        if (meter && !meter.allow(boxId, { paid: hasActiveSubscription(boxId) })) {
          return json(429, { error: "quota_exceeded", box_id: boxId });
        }
        const ingress = Buffer.byteLength(req.body ?? "");
        let resolved = false;
        return {
          __stream: true,
          handler: () => {
            if (resolved) return;
            resolved = true;
            // Record ingress once when the stream is actually opened (the
            // box's STREAM_OPEN is being framed). Egress starts at 0 and is
            // accumulated per STREAM_DATA chunk below.
            if (meter) meter.record(boxId, { ingress, egress: 0 });
            return streamRequest(boxId, {
              method,
              path: subpath,
              headers: sanitizeForwardHeaders(req.headers),
              body: req.body,
            }, {
              onHead: (h) => streamingSink({ kind: "head", status: h.status, headers: h.headers }),
              onData: (data) => {
                // Per-chunk egress metering at the single place chunks are
                // written (BET-157 §2). record() swallows its own errors so
                // a metering write never breaks the phone's stream.
                if (meter && data) {
                  meter.record(boxId, { ingress: 0, egress: Buffer.byteLength(data) });
                }
                streamingSink({ kind: "data", data });
              },
              onEnd: () => streamingSink({ kind: "end" }),
              onAbort: (reason) => streamingSink({ kind: "abort", reason: String(reason || "aborted") }),
            });
          },
        };
      }

      // Pre-flight cap check on the buffered path (BET-157 §3): the rate-
      // limit verdict decides whether we burn a tunnel round-trip. Recorded
      // bytes come AFTER the round-trip succeeds (below) so a rejected or
      // failed request leaves no usage.
      if (meter && !meter.allow(boxId, { paid: hasActiveSubscription(boxId) })) {
        return json(429, { error: "quota_exceeded", box_id: boxId });
      }
      const ingress = Buffer.byteLength(req.body ?? "");

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
        // Record ingress + egress once the round-trip completes. On any
        // throw below we intentionally do NOT record (a failed request costs
        // nothing — the issue's over-cap rejection also avoids recording).
        if (meter) {
          meter.record(boxId, {
            ingress,
            egress: Buffer.byteLength(resp?.body ?? ""),
          });
        }
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
      // streamHandle hoisted to the listener scope so the httpReq.on("close")
      // handler below can abort an in-flight stream when the phone hangs up.
      // It is assigned after dispatch resolves (the stream isn't opened until
      // the route returns the __stream sentinel).
      let streamHandle = null;
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

        // The streaming sink drives httpRes from STREAM_* frames. It's only
        // invoked when dispatch returns the __stream sentinel; for buffered
        // responses we use the regular writeHead+end below.
        let headWritten = false;
        const streamingSink = (event) => {
          try {
            switch (event.kind) {
              case "head": {
                // Content-Length must NOT be set for streaming responses
                // (BET-156 §3). The box may have sent one in its response head;
                // strip it. Cache-Control: no-store is required so the phone
                // doesn't cache stale event-stream chunks.
                const headers = stripForStream(event.headers);
                headers["cache-control"] = "no-store";
                httpRes.writeHead(event.status, headers);
                httpRes.flushHeaders();
                headWritten = true;
                break;
              }
              case "data":
                if (headWritten && event.data) httpRes.write(event.data);
                break;
              case "end":
                if (headWritten) httpRes.end();
                break;
              case "abort":
                if (headWritten) httpRes.end();
                break;
              default:
                break;
            }
          } catch {
            /* socket already closed */
          }
        };

        route(req, streamingSink).then((resp) => {
          if (resp && resp.__stream) {
            // Streaming branch: dispatch armed the stream proxy and will pipe
            // every STREAM_* frame through streamingSink. The handle returned
            // by streamRequest is what we abort if the phone hangs up.
            streamHandle = resp.handler();
            return;
          }
          // Buffered branch (unchanged behavior).
          const headers = { ...(resp.headers || {}) };
          const payload = resp.body == null ? "" : resp.body;
          if (!hasHeader(headers, "content-type")) {
            headers["content-type"] = "application/json";
          }
          httpRes.writeHead(resp.status, headers);
          httpRes.end(payload);
        });
      });
      // Phone hang-up mid-stream → abort the relay-side stream so the box's
      // local fetch ends and no STREAM_DATA frames get sent to a dead socket.
      httpReq.on("close", () => {
        if (streamHandle && typeof streamHandle.abort === "function") {
          try { streamHandle.abort("client disconnected"); } catch { /* ignore */ }
        }
      });
      httpReq.on("error", () => {
        try {
          if (!httpRes.headersSent) {
            httpRes.writeHead(400);
            httpRes.end();
          }
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
//
// `usage` is the metering row from `store.getUsage(boxId)` (may be null when
// the box has never been proxied through). When provided, `bytes_in` /
// `bytes_out` are surfaced so clients see per-box usage with no extra endpoint.
function boxView(b, usage = null) {
  return {
    box_id: b.box_id,
    status: b.status,
    created_at: b.created_at,
    last_seen: b.last_seen,
    bytes_in: usage?.ingress ?? 0,
    bytes_out: usage?.egress ?? 0,
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

// Strip headers that MUST NOT be on a streaming response (BET-156 §3):
//   • content-length — chunked transfer uses no Content-Length; if the box
//     advertised one we set it ourselves or Node may complain.
//   • transfer-encoding — Node controls this once we flushHeaders; any value
//     from the box could conflict with the chunked encoding we initiate.
// The result is the headers map to pass to writeHead.
function stripForStream(headers) {
  const out = {};
  const DROP = new Set(["content-length", "transfer-encoding"]);
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (!DROP.has(k.toLowerCase())) out[k] = v;
    }
  }
  return out;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}
