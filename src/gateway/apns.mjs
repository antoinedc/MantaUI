// apns.mjs — Apple APNs native push (gateway-side).
//
// MOVED from src/server/push.mjs in BET-199. The gateway now holds the
// `.p8` Apple key (BET-198 §1: "Single push path"). Boxes do not hold APNs
// credentials anymore — their push.mjs fans out via POST /push on the
// gateway (BET-201 will swap the box internals).
//
// The shape of `sendApns` changed because the gateway is stateless about
// device tokens: it does NOT maintain an apns-tokens.json (that's box-side
// state). The new contract returns `{ok, prune}` per token — the gateway's
// /push handler passes that result back to the box, which owns the actual
// `removeApnsToken` call.
//
// Same crypto + HTTP plumbing as before:
//   - ES256 JWT (Apple's spec: header {alg:"ES256",kid:<keyId>}, claims
//     {iss:<teamId>, iat:<unix-seconds>}), cached for 45 min to amortize the
//     ~5ms P-256 sign cost.
//   - HTTP/2 to api.push.apple.com:443, path /3/device/<token>.
//   - 410 Gone / 400 BadDeviceToken / 400 Unregistered → prune:true.
//
// Config is loaded once at startup from /etc/manta-gateway/apns.json
// (same shape as the `apns` block in ~/.manta/config.json on the box:
// `{ teamId, keyId, p8Path, bundleId }`).
//
// Pure helpers (buildApnsJwt, buildApnsRequest, buildApnsPayload) are
// exported unchanged for unit tests; the module-level JWT cache is exported
// via `_resetApnsJwtCache` so tests can force a re-sign.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createSign, randomBytes } from "node:crypto";
import http2 from "node:http2";

const APNS_JWT_TTL_SEC = 45 * 60;

let _apnsJwtCache = null; // { teamId, keyId, p8Path, jwt, exp }

// ---------------------------------------------------------------------------
// Config — load once at startup
// ---------------------------------------------------------------------------

// Read `{ teamId, keyId, p8Path, bundleId }` from a JSON file. Same shape as
// the box's apns config block (src/server/local.mjs apnsConfig). Returns
// null if the file is missing, malformed, or any required field is empty.
export async function loadApnsConfig(path) {
  if (typeof path !== "string" || !path) {
    throw new Error("loadApnsConfig: path required");
  }
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text);
    const { teamId, keyId, p8Path, bundleId } = parsed ?? {};
    if (typeof teamId !== "string" || !teamId) return null;
    if (typeof keyId !== "string" || !keyId) return null;
    if (typeof p8Path !== "string" || !p8Path) return null;
    if (typeof bundleId !== "string" || !bundleId) return null;
    return { teamId, keyId, p8Path, bundleId };
  } catch {
    return null;
  }
}

// Default config path on prod. systemd places this at
// /etc/manta-gateway/apns.json (BET-198 WP6 runbook step 1).
export const DEFAULT_APNS_CONFIG_PATH = "/etc/manta-gateway/apns.json";

// ---------------------------------------------------------------------------
// Pure JWT / payload / request builders
// ---------------------------------------------------------------------------

// ES256 JWT used for APNs auth. Apple requires:
//   header: { alg:"ES256", kid:<keyId> }
//   claims: { iss:<teamId>, iat:<unix-seconds> }
// ES256 = ECDSA over the P-256 curve with SHA-256. Apple's .p8 is the
// PKCS#8 PEM of an EC private key, which Node's crypto accepts directly.
export async function buildApnsJwt(cfg, { now } = {}) {
  if (!cfg?.teamId || !cfg?.keyId || !cfg?.p8Path) {
    throw new Error("buildApnsJwt: missing teamId/keyId/p8Path");
  }
  const pem = readFileSync(cfg.p8Path, "utf-8");
  const header = { alg: "ES256", kid: cfg.keyId };
  const iat = now ?? Math.floor(Date.now() / 1000);
  const claims = { iss: cfg.teamId, iat };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign({ key: pem, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

// Cache-and-reuse the APNs JWT for APNS_JWT_TTL_SEC. Pure w.r.t. time
// (caller-injected `now`); mutates module-level `_apnsJwtCache`.
async function getApnsJwt(cfg, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const t = now();
  const c = _apnsJwtCache;
  if (
    c &&
    c.teamId === cfg.teamId &&
    c.keyId === cfg.keyId &&
    c.p8Path === cfg.p8Path &&
    c.exp > t
  ) {
    return c.jwt;
  }
  const jwt = await buildApnsJwt(cfg, { now: t });
  _apnsJwtCache = {
    teamId: cfg.teamId,
    keyId: cfg.keyId,
    p8Path: cfg.p8Path,
    jwt,
    exp: t + APNS_JWT_TTL_SEC,
  };
  return jwt;
}

// Test hook: drop the JWT cache so the next send rebuilds.
export function _resetApnsJwtCache() {
  _apnsJwtCache = null;
}

// Build the HTTP/2 request shape for one APNs send.
export function buildApnsRequest({ cfg, deviceToken, payload, jwt }) {
  if (!cfg?.bundleId) throw new Error("buildApnsRequest: missing bundleId");
  if (typeof deviceToken !== "string" || !deviceToken) {
    throw new Error("buildApnsRequest: missing deviceToken");
  }
  return {
    host: "api.push.apple.com",
    path: `/3/device/${encodeURIComponent(deviceToken)}`,
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": cfg.bundleId,
      "apns-push-type": "alert",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

// Map an internal notification payload to the APNs `aps` envelope.
// Apple requires the title/body under `aps.alert`. `thread-id` groups
// notifications from the same session into one stack on the lock screen.
export function buildApnsPayload(payload) {
  const title = typeof payload?.title === "string" ? payload.title : "";
  const body = typeof payload?.body === "string" ? payload.body : "";
  const sessionId =
    typeof payload?.sessionId === "string" && payload.sessionId
      ? payload.sessionId
      : null;
  const aps = { alert: { title, body } };
  if (sessionId) aps["thread-id"] = sessionId;
  return { aps, sessionId };
}

// ---------------------------------------------------------------------------
// sendApns — gateway-side, stateless about device tokens
// ---------------------------------------------------------------------------

/**
 * Send ONE push to ONE APNs token.
 *
 * Returns `{ ok, prune, reason }`:
 *   - ok=true,  prune=false → delivered (Apple 200)
 *   - ok=false, prune=true  → dead token (410 Gone, 400 BadDeviceToken, or
 *                              400 Unregistered) — caller must remove it
 *                              from its own device-token store
 *   - ok=false, prune=false → transient error (network blip, Apple 5xx,
 *                              other 400 reason) — keep the token
 *
 * `fetchImpl` is injected for tests. Production uses `defaultApnsSender`
 * (HTTP/2 to api.push.apple.com). The sender's contract is the same as
 * the box-side original: take a built `req` object, return
 * `{status, body}`.
 *
 * @param {{token:string, payload:{title:string, body:string, sessionId?:string|null}}} args
 * @param {{teamId:string, keyId:string, p8Path:string, bundleId:string}} apnsConfig
 * @param {(req:any)=>Promise<{status:number, body:any}>} [fetchImpl] injected for tests
 */
export async function sendApns({ token, payload }, apnsConfig, fetchImpl) {
  if (typeof token !== "string" || !token) {
    throw new Error("sendApns: token required");
  }
  if (!apnsConfig) throw new Error("sendApns: apnsConfig required");

  const useFetch = fetchImpl ?? defaultApnsSender;
  const jwt = await getApnsJwt(apnsConfig);
  const envelope = buildApnsPayload(payload);
  const req = buildApnsRequest({
    cfg: apnsConfig,
    deviceToken: token,
    payload: envelope,
    jwt,
  });

  let res;
  try {
    res = await useFetch(req);
  } catch (e) {
    console.warn("[gateway-apns] send error:", e?.message ?? e);
    return { ok: false, prune: false, reason: "transport" };
  }
  const status = res?.status ?? 0;
  const reason = res?.body?.reason ?? "";
  if (status === 200) {
    return { ok: true, prune: false, reason: "" };
  }
  if (
    status === 410 ||
    (status === 400 && (reason === "BadDeviceToken" || reason === "Unregistered"))
  ) {
    return { ok: false, prune: true, reason: reason || "dead-token" };
  }
  return { ok: false, prune: false, reason: reason || "http-error" };
}

// Default HTTP/2 sender for APNs (production). Resolves with
// `{ status, body }` on response, or throws on socket/connect failure.
async function defaultApnsSender(req) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${req.host}`);
    session.on("error", reject);
    const r = session.request({
      ":method": req.method,
      ":path": req.path,
      ...req.headers,
    });
    r.on("response", (headers) => {
      const status = headers[":status"] ?? 0;
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        session.close();
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body = raw;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          /* non-JSON body — leave as string */
        }
        resolve({ status, body });
      });
    });
    r.on("error", (e) => {
      session.close();
      reject(e);
    });
    r.end(req.body);
  });
}
