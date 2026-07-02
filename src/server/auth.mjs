// auth.mjs — single-box token auth for bui-server (the always-on Linux box).
//
// PROBLEM: today src/server/index.mjs binds 0.0.0.0:8787 with ZERO auth. The
// only authenticated route is the public /hook/<token> webhook leg. Everything
// else (/rpc, /events, /pty, /api/*, /push/*) is open to anyone who can reach
// the box. That is the #1 blocker for shipping anything commercial — the mobile
// sub and the relay both assume the box can tell "my paired device" from "a
// random internet scanner."
//
// SOLUTION (M1, job zero): a single shared bearer token (`box_token`) that every
// request must carry, plus a short-lived pairing-code handshake so a new device
// can obtain that token without the user copy-pasting a 32-char secret.
//
//   box_id       — 32 hex (128-bit) opaque pseudonym for this box. Safe to show
//                  in QR / UI; maps to nothing human. Stable for the box's life.
//   box_token    — 32 hex (128-bit) bearer secret. Presented as
//                  `Authorization: Bearer <box_token>` on every gated request.
//                  Generated on first run, persisted 0600, never logged in full.
//   pairing_code — 6 digits, one-time, ~5 min TTL, in-memory only. A device
//                  proves physical/visual proximity by echoing it back, and in
//                  return receives the box_token. Consumed on first successful
//                  claim (and expires on TTL).
//
// This reuses the webhooks.mjs security toolkit (isValidToken shape, constant-
// time compare, token-bucket rate limiter) so there is one crypto story on the
// box. Store: ~/.bui-mobile/auth.json (0600), same pattern as
// schedule.mjs / secrets.mjs / webhooks.mjs.
//
// SCOPE (M1): the server-side auth core only — token gen/persist, the pairing
// handshake, the request gate. The desktop "Pair device" Settings UI (M6) and
// the mobile QR scanner (M3) are separate issues; they consume /auth/pair +
// /auth/claim built here.

import { writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const STORE_PATH = join(homedir(), ".bui-mobile", "auth.json");

// Pairing codes are short-lived by design: a device must claim within this
// window or the code expires and the user re-opens the pair screen.
const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Rate limit for the UNAUTHENTICATED /auth/* routes. These are the only
// pre-token surface, so they are the brute-force target (guessing a 6-digit
// code). Capacity 10, refill 0.2/sec ≈ 12/min sustained — a human pairing needs
// a handful of hits; a guesser is throttled hard. Combined with the 5-min TTL
// and single active code, 10^6 space is not brute-forceable in the window.
export const AUTH_RL_CAPACITY = 10;
export const AUTH_RL_REFILL_PER_SEC = 0.2;

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

// box_id / box_token are 32 lowercase hex chars (128 bits). Validate strictly
// (same shape/rule as webhooks.mjs isValidToken) so a token can never smuggle a
// path-traversal or header-injection payload.
export function isValidToken(token) {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

// A pairing code is exactly 6 decimal digits. Strict so "000123" and " 123 "
// don't accidentally validate and a code can't carry junk.
export function isValidPairingCode(code) {
  return typeof code === "string" && /^[0-9]{6}$/.test(code);
}

// Constant-time bearer-token comparison. Returns true only when `presented`
// exactly equals `expected` (both must be valid tokens). Any malformed input →
// false, and the compare is timing-safe so a network attacker can't binary-
// search the secret byte-by-byte from response latency.
export function tokenMatches(expected, presented) {
  if (!isValidToken(expected) || !isValidToken(presented)) return false;
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(presented, "utf-8");
  if (a.length !== b.length) return false; // both 32 → always equal, but be safe
  return timingSafeEqual(a, b);
}

// Extract the bearer token from an Authorization header value.
// Accepts "Bearer <token>" (case-insensitive scheme). Returns the token string
// or null. Also accepts a bare token for flexibility, but the canonical form is
// "Bearer <token>".
export function parseBearer(headerValue) {
  if (typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  if (!v) return null;
  const m = /^Bearer\s+(.+)$/i.exec(v);
  const tok = m ? m[1].trim() : v;
  return tok || null;
}

// Decide whether a request path is EXEMPT from auth (reachable without a
// box_token). Only the pairing handshake and the public webhook delivery leg
// (which carries its own per-hook token+HMAC) are exempt. Everything else —
// /rpc, /events, /pty, /api/*, /push/*, static assets — is gated.
//
// Rationale for each exemption:
//   /auth/pair, /auth/claim — bootstrap; you can't present a token you don't
//     have yet. Rate-limited + code-gated instead.
//   /hook/<token>          — external senders can't hold the box_token; the hook
//     already authenticates via its own 128-bit token + HMAC (webhooks.mjs).
//   OPTIONS (handled by caller) — CORS preflight carries no credentials.
//
// NOTE: /auth/status is intentionally NOT exempt — it reports whether the
// caller's token is valid, so it must run through the gate.
export function isExemptPath(path) {
  if (typeof path !== "string") return false;
  if (path === "/auth/pair" || path === "/auth/claim") return true;
  if (path === "/hook/" || path.startsWith("/hook/")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Local-only gate for minting pairing codes
// ---------------------------------------------------------------------------
//
// GET /auth/pair must be callable ONLY from the box itself (the `bui pair` CLI,
// or a channel that terminates on the box like the desktop's SSH -L forward).
// A bare loopback check is NOT enough: cloudflared runs on this box and proxies
// PUBLIC traffic to 127.0.0.1:8787, so tunnel requests also arrive with a
// loopback remoteAddress. What distinguishes them is the forwarding headers the
// tunnel edge injects (cf-connecting-ip, x-forwarded-for, ...) — an external
// attacker cannot strip those, and a genuine local curl never carries them.
//
// So "local" = loopback socket AND zero forwarding headers. Do NOT "improve"
// this by trusting x-forwarded-for contents — spoofable on direct connections.

// Loopback = 127.0.0.0/8 (v4), ::1 (v6), or the v4-mapped form ::ffff:127.x.
export function isLoopbackAddress(addr) {
  if (typeof addr !== "string" || !addr) return false;
  let a = addr.toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// Headers that any reverse proxy / tunnel in front of us injects. Presence of
// ANY of them means the request did not originate on this box, regardless of
// the socket address.
export const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
];

export function isLocalDirectRequest({ remoteAddress, headers } = {}) {
  if (!isLoopbackAddress(remoteAddress)) return false;
  const h = headers && typeof headers === "object" ? headers : {};
  for (const name of FORWARDING_HEADERS) {
    if (h[name] != null && h[name] !== "") return false;
  }
  return true;
}

// Static SPA-shell / PWA asset paths that must load WITHOUT a token, so the
// pairing UI can render before the client holds a box_token. These carry no
// user data — the actual data flows through the gated /api, /rpc, /events, /pty
// routes — so serving the bundle publicly is safe (every SPA does this). This
// is deliberately an allowlist of the shell's own static surface, NOT a blanket
// "GET is public": unknown data routes still fall through to the gate.
//
// Covered: the entry HTML ("/", "/index.html"), Vite's content-hashed bundle
// (/assets/*), the PWA manifest + service worker + icons, and favicon.
export function isPublicAssetPath(path) {
  if (typeof path !== "string") return false;
  if (path === "/" || path === "/index.html") return true;
  if (path === "/sw.js") return true;
  if (path === "/favicon.ico") return true;
  if (path === "/manifest.webmanifest" || path === "/manifest.json") return true;
  if (path.startsWith("/assets/")) return true;
  if (path.startsWith("/icons/")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Query-param token fallback for header-less clients (/events + /pty ONLY)
// ---------------------------------------------------------------------------
//
// Browsers cannot set an Authorization header on a WebSocket handshake (or on
// an EventSource), so the two streaming routes accept the box_token as a
// ?token=<box_token> query param instead. This is DELIBERATELY limited to
// /events and /pty: every other route must present a real Bearer header, so a
// token can never leak into a proxy/referrer log for a normal data request.
//
// Pure + testable: given a path, the Authorization header value, and the raw
// ?token= query value, return the effective Authorization value to feed into
// authorize(). The header always wins when present (non-browser clients keep
// using it); the query token is honored only as a fallback and only on the two
// allowlisted stream paths.
export const QUERY_TOKEN_PATHS = new Set(["/events", "/pty"]);

export function queryTokenAllowedForPath(path) {
  return QUERY_TOKEN_PATHS.has(path);
}

export function authorizationForRequest(path, headerValue, queryToken) {
  // A real Authorization header always takes precedence, on any route.
  if (typeof headerValue === "string" && headerValue.trim() !== "") {
    return headerValue;
  }
  // No header: fall back to ?token= ONLY on the allowlisted stream paths.
  if (
    queryTokenAllowedForPath(path) &&
    typeof queryToken === "string" &&
    queryToken !== ""
  ) {
    return `Bearer ${queryToken}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Token / code generation
// ---------------------------------------------------------------------------

function genToken() {
  return randomBytes(16).toString("hex"); // 32-char, 128-bit
}

function genPairingCode() {
  // randomInt is uniform over [0, 1e6); zero-pad to 6 digits.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Store (atomic write + 0600, same shape as webhooks.mjs / secrets.mjs)
// ---------------------------------------------------------------------------

async function atomicWrite(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
}

// Load the persisted { box_id, box_token, created_at }. Returns null if the
// file is missing or corrupt (caller then generates a fresh identity).
export function loadAuth(path = STORE_PATH) {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (isValidToken(parsed?.box_id) && isValidToken(parsed?.box_token)) {
        return {
          box_id: parsed.box_id,
          box_token: parsed.box_token,
          created_at: parsed.created_at ?? null,
        };
      }
    }
  } catch {
    // corrupt/unreadable → regenerate rather than crash the server.
  }
  return null;
}

export async function saveAuth(auth, path = STORE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(auth, null, 2), 0o600);
}

// Load the box identity, generating + persisting a fresh one on first run.
// Returns { box_id, box_token, created_at }. I/O injectable for tests.
export async function ensureAuth({
  load = loadAuth,
  save = saveAuth,
  now = () => Date.now(),
} = {}) {
  const existing = await load();
  if (existing) return existing;
  const auth = {
    box_id: genToken(),
    box_token: genToken(),
    created_at: now(),
  };
  await save(auth);
  return auth;
}

// ---------------------------------------------------------------------------
// Pairing-code registry (in-memory, one active code, TTL-bounded)
// ---------------------------------------------------------------------------

/**
 * A tiny registry for the pairing handshake. At most ONE code is active at a
 * time — issuing a new one (a fresh /auth/pair) supersedes any prior code, so a
 * "Pair device" re-open invalidates a stale code the user walked away from.
 * A code is consumed on first successful claim and cannot be reused.
 *
 * `now` injectable for deterministic tests.
 */
export function createPairingRegistry({ ttlMs = PAIRING_TTL_MS, now = () => Date.now() } = {}) {
  let active = null; // { code, expiresAt }

  function issue() {
    const code = genPairingCode();
    active = { code, expiresAt: now() + ttlMs };
    return { code, expiresAt: active.expiresAt };
  }

  // Try to consume `code`. Returns true only if it matches the single active,
  // unexpired code — and clears it so it's strictly one-time. Constant-time
  // digit compare to avoid leaking how many leading digits matched.
  function consume(code) {
    if (!isValidPairingCode(code)) return false;
    if (!active) return false;
    if (now() > active.expiresAt) {
      active = null;
      return false;
    }
    const a = Buffer.from(active.code, "utf-8");
    const b = Buffer.from(String(code), "utf-8");
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) active = null; // one-time
    return ok;
  }

  function clear() {
    active = null;
  }

  function hasActive() {
    return !!active && now() <= active.expiresAt;
  }

  return { issue, consume, clear, hasActive };
}

// ---------------------------------------------------------------------------
// Engine — the object index.mjs wires into the request pipeline
// ---------------------------------------------------------------------------

/**
 * Build the stateful auth engine used by index.mjs. Owns the box identity, the
 * pairing registry, and the per-request gate.
 *
 * When `enforce` is false (env escape hatch BUI_AUTH_DISABLED=1), the gate
 * allows everything and the server prints a loud one-time warning — this exists
 * only so an existing self-hoster who upgrades isn't instantly locked out of
 * their own box before they've paired. The DEFAULT is enforce=true.
 *
 * @param {object} deps { auth, enforce, ttlMs, now }
 *   auth    — { box_id, box_token } from ensureAuth()
 *   enforce — gate on (default true)
 */
export function createAuthEngine({
  auth,
  enforce = true,
  ttlMs = PAIRING_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!auth || !isValidToken(auth.box_id) || !isValidToken(auth.box_token)) {
    throw new Error("createAuthEngine: valid { box_id, box_token } required");
  }
  const pairing = createPairingRegistry({ ttlMs, now });

  // Is this request authorized? Returns { ok } or { ok:false, status, error }.
  // Exempt paths and the disabled-enforcement mode short-circuit to allow.
  function authorize({ method, path, authorization }) {
    if (method === "OPTIONS") return { ok: true }; // CORS preflight
    if (isExemptPath(path)) return { ok: true };
    // The SPA shell + PWA assets (GET only) must load pre-token so the pairing
    // UI can render. They carry no user data.
    if (method === "GET" && isPublicAssetPath(path)) return { ok: true };
    if (!enforce) return { ok: true };
    const presented = parseBearer(authorization);
    if (presented && tokenMatches(auth.box_token, presented)) return { ok: true };
    return { ok: false, status: 401, error: "unauthorized" };
  }

  // Handle GET /auth/pair — mint a one-time pairing code. Rate-limiting is
  // applied by the caller (index.mjs) via the shared limiter; here we just
  // issue. Returns the code + box_id so the desktop can render it / a QR.
  function pair() {
    const { code, expiresAt } = pairing.issue();
    return { ok: true, pairing_code: code, box_id: auth.box_id, expiresAt };
  }

  // Handle POST /auth/claim {pairing_code} — exchange a valid code for the
  // box_token. One-time: a correct code is consumed. Returns 400 on a
  // missing/invalid code and 403 on a wrong/expired/already-used code (so a
  // guesser learns only "no", never partial progress).
  function claim({ pairing_code } = {}) {
    if (!isValidPairingCode(pairing_code)) {
      return { ok: false, status: 400, error: "invalid pairing code" };
    }
    if (!pairing.consume(pairing_code)) {
      return { ok: false, status: 403, error: "pairing failed" };
    }
    return { ok: true, box_token: auth.box_token, box_id: auth.box_id };
  }

  return {
    box_id: auth.box_id,
    enforce,
    authorize,
    pair,
    claim,
    // exposed for /auth/status and tests
    hasActivePairing: () => pairing.hasActive(),
    clearPairing: () => pairing.clear(),
  };
}

export { PAIRING_TTL_MS, STORE_PATH };
