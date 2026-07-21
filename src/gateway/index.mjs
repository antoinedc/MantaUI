// index.mjs — gateway HTTP service entrypoint.
//
// The hosted push gateway (BET-198 §1, the ONLY thing the relay replacement
// keeps in our operated infra). Binds 127.0.0.1:20081 (claimed in
// shared/ports/registry.md) and terminates behind the system Caddy on
// `gateway.mantaui.com`. Three routes:
//
//   GET  /healthz       — 200 {"ok":true}, no auth (deploy probe)
//   POST /register      — mint or refresh a box's gateway_token; create /
//                          update the Cloudflare DNS A record for
//                          <box_id>.boxes.mantaui.com. Rate-limited per
//                          source IP.
//   POST /push          — fan out a notification to the box's registered
//                          APNs device tokens. Returns per-token results
//                          so the box can prune its own token store.
//
// Pure + injected I/O: every dependency (loadStore / saveStore / fetchImpl /
// createOrUpdate / sendApns / now) is parameterizable for tests; production
// uses real FS + global fetch + real Cloudflare DNS + real APNs.
//
// Source IP: NEVER trust an `ip` field in the body (spoofable). Read
// `X-Forwarded-For` first value (Caddy fronts the gateway), fall back to
// `socket.remoteAddress` when the header is absent.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readBody, sendJson, sendText } from "./http.mjs";
import {
  isValidBoxId,
  loadStore,
  saveStore,
  makeEntry,
  hostFor,
} from "./store.mjs";
import { createOrUpdate, cloudflareCredsFromEnv, ovhSubDomainFor } from "./dns.mjs";
import { sendApns, loadApnsConfig } from "./apns.mjs";

// 10 registrations per source IP per hour. Same shape as the relay's pair
// rate limiter (src/relay/server.mjs). The window is one hour, the cap is
// per-IP, and the bucket resets after the window elapses (we just drop the
// entry on the next take()). Boxes re-register on every boot; a VPS that
// reboots twice an hour is unusual, so 10/hour is comfortable.
const REGISTER_RL_CAPACITY = 10;
const REGISTER_RL_WINDOW_MS = 60 * 60 * 1000;

// Per-token cap on /push. Apple's rate limits are per-token, but the
// gateway is best-effort batched — capping at 20 keeps a single box's fanout
// bounded and the response under 256 KiB.
const PUSH_MAX_TOKENS = 20;

// Box hostname suffix (matches store.hostFor / dns.createRecord's caller).
const BOXES_DOMAIN = "boxes.mantaui.com";

// ---------------------------------------------------------------------------
// Pure helpers (testable in isolation)
// ---------------------------------------------------------------------------

// Pull the client IP out of the request — X-Forwarded-For first value (when
// present) wins; otherwise the socket's remoteAddress. Returns the empty
// string when neither is usable (IPv6 unspecified, etc.) — caller treats
// that as a 400.
//
// X-Forwarded-For is a comma-separated list: the left-most is the original
// client (the one Caddy actually saw). Anything to the right was appended
// by intermediate proxies. We trust the first value because Caddy is the
// only thing in front of us, and on the prod box we control Caddy.
export function sourceIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const sock = req.socket?.remoteAddress;
  if (typeof sock === "string" && sock) return sock;
  return "";
}

// Extract the bearer token from an Authorization header. Same shape as
// src/server/auth.mjs parseBearer but kept in this module to avoid a
// cross-package import.
export function bearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  if (!v) return null;
  const m = /^Bearer\s+(.+)$/i.exec(v);
  const tok = m ? m[1].trim() : v;
  return tok || null;
}

// Constant-time bearer compare (both must be 32-hex strings; the relay
// gates push at the bearer level and we never want a timing leak on the
// gateway side).
export function tokenEquals(expected, presented) {
  if (typeof expected !== "string" || typeof presented !== "string") return false;
  if (expected.length !== presented.length) return false;
  // Use a simple loop — both are 32 hex chars; an attacker can't recover
  // the secret byte-by-byte from response latency this way. (Same model
  // as src/server/auth.mjs tokenMatches for 32-hex tokens.)
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return mismatch === 0;
}

// Token shape: 32 lowercase hex (matches the box_id shape — same family).
export function isValidGatewayToken(t) {
  return typeof t === "string" && /^[0-9a-f]{32}$/.test(t);
}

// APNs device token: 64-char hex. We accept any non-empty hex string; Apple
// accepts both old 32-char and new 64-char tokens. Lenient validation: just
// a string of hex, capped length so a megabyte of body can't sneak in.
export function isHexToken(t) {
  return typeof t === "string" && /^[0-9a-fA-F]{1,128}$/.test(t);
}

// Per-IP rate limiter for /register. Bucket = count + windowStart; the
// bucket resets to `capacity` after a full window of idle. `now` injectable.
export function createRegisterRateLimiter({
  capacity = REGISTER_RL_CAPACITY,
  windowMs = REGISTER_RL_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();
  return function take(ip) {
    if (typeof ip !== "string" || !ip) return false;
    const t = now();
    const cur = buckets.get(ip);
    if (!cur || t - cur.windowStart >= windowMs) {
      buckets.set(ip, { count: 1, windowStart: t });
      return true;
    }
    if (cur.count >= capacity) return false;
    cur.count += 1;
    return true;
  };
}

// Generate a fresh gateway_token (32-char hex, 128 bits).
export function generateGatewayToken() {
  return randomBytes(16).toString("hex");
}

// Compute the DNS record name for a box_id. Re-exported from dns.mjs so the
// /register route can build the record name it hands to createOrUpdate.
// (Historical name `ovhSubDomainFor` — kept as an alias through the OVH→
// Cloudflare migration; it now returns the FULL record name.)
export { ovhSubDomainFor };

// ---------------------------------------------------------------------------
// Route handlers — each one returns a {status, json?} or {status, text?}
// ---------------------------------------------------------------------------

// Handle POST /register. Mutates `store` (in-memory map) and calls
// `persist` (test-injected saveStore) when an entry is created or updated.
export async function handleRegister({
  body,
  ip,
  store,
  persist,
  rateLimiter,
  createDnsRecord,
  now = () => Date.now(),
  log = console.log,
}) {
  // Rate limit FIRST — refuse before we touch the store.
  if (!rateLimiter(ip)) {
    return { status: 429, json: { error: "rate_limited" } };
  }
  const { box_id } = body ?? {};
  if (!isValidBoxId(box_id)) {
    return { status: 400, json: { error: "invalid_box_id" } };
  }
  if (typeof ip !== "string" || !ip) {
    return { status: 400, json: { error: "no_source_ip" } };
  }
  const existing = store[box_id];
  if (existing) {
    // Re-registration: require the bearer.
    const presented = body?.__bearer;
    if (!presented || !tokenEquals(existing.gateway_token, presented)) {
      return { status: 401, json: { error: "unauthorized" } };
    }
    let updatedRecordId = existing.recordId;
    if (existing.ip !== ip) {
      try {
        const r = await createDnsRecord({
          boxId: box_id,
          subDomain: ovhSubDomainFor(box_id),
          target: ip,
          existingRecordId: existing.recordId,
        });
        updatedRecordId = r.recordId;
      } catch (e) {
        // DNS failure is non-fatal: the box already has a hostname, just
        // at an out-of-date IP. Log and return the existing host.
        log(`[gateway] DNS update failed for ${box_id}: ${e?.message ?? e}`);
        return { status: 200, json: { host: existing.host } };
      }
    }
    const next = {
      ...existing,
      ip,
      updatedAt: now(),
      recordId: updatedRecordId,
    };
    store[box_id] = next;
    await persist(store);
    return { status: 200, json: { host: next.host } };
  }
  // First registration: mint a token, create the A record, persist, return.
  let recordId = null;
  try {
    const r = await createDnsRecord({
      boxId: box_id,
      subDomain: ovhSubDomainFor(box_id),
      target: ip,
      existingRecordId: null,
    });
    recordId = r.recordId;
  } catch (e) {
    log(`[gateway] DNS create failed for ${box_id}: ${e?.message ?? e}`);
    return { status: 502, json: { error: "dns_create_failed" } };
  }
  const gateway_token = generateGatewayToken();
  const host = hostFor(box_id);
  const entry = makeEntry({ box_id, gateway_token, ip, host, recordId, now });
  store[box_id] = entry;
  await persist(store);
  return { status: 200, json: { host, gateway_token } };
}

// Handle POST /push. Stateless about device tokens — returns per-token
// `{token, ok, prune}` so the box can prune its own store.
export async function handlePush({
  body,
  store,
  apnsConfig,
  fetchImpl,
}) {
  const { box_id, tokens, payload } = body ?? {};
  if (!isValidBoxId(box_id)) {
    return { status: 400, json: { error: "invalid_box_id" } };
  }
  const entry = store[box_id];
  if (!entry) {
    return { status: 401, json: { error: "unauthorized" } };
  }
  const presented = body?.__bearer;
  if (!presented || !tokenEquals(entry.gateway_token, presented)) {
    return { status: 401, json: { error: "unauthorized" } };
  }
  if (!Array.isArray(tokens)) {
    return { status: 400, json: { error: "tokens_must_be_array" } };
  }
  if (tokens.length > PUSH_MAX_TOKENS) {
    return { status: 400, json: { error: `too_many_tokens (max ${PUSH_MAX_TOKENS})` } };
  }
  for (const t of tokens) {
    if (!isHexToken(t)) {
      return { status: 400, json: { error: "invalid_token" } };
    }
  }
  if (!payload || typeof payload !== "object") {
    return { status: 400, json: { error: "payload_required" } };
  }
  if (!apnsConfig) {
    return { status: 503, json: { error: "apns_disabled" } };
  }
  // Fan out — best-effort, every token gets its own result. Order
  // preserved so the box can correlate results[tokens[i]] by index.
  const results = [];
  for (const token of tokens) {
    try {
      const r = await sendApns({ token, payload }, apnsConfig, fetchImpl);
      results.push({ token, ok: r.ok, prune: r.prune });
    } catch (e) {
      results.push({ token, ok: false, prune: false });
      console.warn(`[gateway-push] token error: ${e?.message ?? e}`);
    }
  }
  return { status: 200, json: { results } };
}

// ---------------------------------------------------------------------------
// HTTP server factory
// ---------------------------------------------------------------------------

/**
 * Build the HTTP server. Production usage:
 *
 *   import { createGatewayServer } from "./index.mjs";
 *   const { start, stop } = createGatewayServer({ apnsConfig, dnsCreds });
 *   await start();
 *
 * Tests construct it with fakes:
 *
 *   createGatewayServer({
 *     port: 0, // ephemeral
 *     loadStore: () => ({}),
 *     saveStore: async () => {},
 *     fetchImpl: fakeFetch,
 *     dnsCreds: { appKey, appSecret, consumerKey, endpoint },
 *     apnsConfig: null,
 *   });
 *
 * `port` = 0 yields an ephemeral port (for tests); prod binds 20081.
 */
export function createGatewayServer({
  port = Number(process.env.GATEWAY_PORT) || 20081,
  host = process.env.GATEWAY_HOST || "127.0.0.1",
  storePath = process.env.GATEWAY_STORE_PATH || "/var/lib/manta-gateway/boxes.json",
  load = () => loadStore(storePath),
  save = (map) => saveStore(map, storePath),
  fetchImpl = globalThis.fetch,
  dnsCreds,
  // Override the DNS-createOrUpdate wrapper. Production wires the real
  // helper from dns.mjs; tests inject a fake that pushes to an in-memory
  // calls array (no OVH, no record-id allocation).
  createDnsRecord,
  apnsConfig = null,
  rateLimiter = createRegisterRateLimiter(),
  log = console.log,
  warn = console.warn,
} = {}) {
  const dnsCreateOrUpdate = createDnsRecord ?? ((args) => createOrUpdate({ ...args, fetchImpl, creds: dnsCreds }));
  // Mutable in-memory copy of the store. Loaded once at start() and re-
  // loaded on each mutation (cheap — single small JSON file). Tests inject
  // a stable map; production wires the FS-backed load/save.
  let store = {};

  async function persist(next) {
    store = next;
    await save(next);
  }

  async function handle(req, res) {
    const url = (req.url || "/").split("?")[0];
    const ip = sourceIp(req);

    // CORS preflight — short-circuit before any other handling.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, x-box-id",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }

    if (req.method === "GET" && url === "/healthz") {
      return sendText(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.method !== "POST") {
      return sendJson(res, 404, { error: "not_found" });
    }

    if (url !== "/register" && url !== "/push") {
      return sendJson(res, 404, { error: "not_found" });
    }

    readBody(req, async (err, raw) => {
      if (err) {
        return sendJson(
          res,
          err.code === "too_large" ? 413 : 400,
          { error: err.code === "too_large" ? "payload_too_large" : "bad_request" },
        );
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return sendJson(res, 400, { error: "invalid_json" });
      }
      // Stash the bearer on the body so route handlers don't have to
      // re-parse the Authorization header. Tests inject __bearer directly.
      body.__bearer = bearerToken(req.headers?.authorization);

      try {
        if (url === "/register") {
          const r = await handleRegister({
            body,
            ip,
            store,
            persist,
            rateLimiter,
            createDnsRecord: dnsCreateOrUpdate,
            log,
          });
          return sendJson(res, r.status, r.json);
        }
        // /push
        const r = await handlePush({
          body,
          store,
          apnsConfig,
          fetchImpl,
        });
        return sendJson(res, r.status, r.json);
      } catch (e) {
        warn(`[gateway] handler error: ${e?.message ?? e}`);
        return sendJson(res, 500, { error: "internal_error" });
      }
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      warn(`[gateway] unhandled: ${e?.message ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });

  async function start() {
    store = await load();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    return { host, port: server.address()?.port };
  }

  function stop() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, stop, get store() { return store; } };
}

// ---------------------------------------------------------------------------
// CLI entry — start the gateway when run directly
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/gateway/index.mjs");

if (isMain) {
  const creds = cloudflareCredsFromEnv();
  if (!creds.ok) {
    console.error(`[gateway] ${creds.error}`);
    process.exit(1);
  }
  const apns = await loadApnsConfig(process.env.APNS_CONFIG_PATH || "/etc/manta-gateway/apns.json").catch(() => null);
  if (!apns) {
    console.warn("[gateway] apns config missing — /push will return 503");
  }
  const svc = createGatewayServer({
    dnsCreds: { apiToken: creds.apiToken, zoneId: creds.zoneId, endpoint: creds.endpoint },
    apnsConfig: apns,
  });
  svc
    .start()
    .then(({ host, port }) => {
      console.log(`[gateway] up on http://${host}:${port}`);
    })
    .catch((err) => {
      console.error("[gateway] failed to start:", err);
      process.exit(1);
    });
  const shutdown = () => svc.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
