// auth.mjs — single-box token auth for manta-server (the always-on Linux box).
//
// PROBLEM: today src/server/index.mjs binds 0.0.0.0:8787 with ZERO auth. The
// only authenticated route is the public /hook/<token> webhook leg. Everything
// else (/rpc, /events, /pty, /api/*, /push/*) is open to anyone who can reach
// the box. That is the #1 blocker for shipping anything commercial — every
// paired device (desktop + mobile) must be distinguishable from "a random
// internet scanner."
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
// box. Store: ~/.manta/auth.json (0600), same pattern as
// schedule.mjs / secrets.mjs / webhooks.mjs.
//
// SCOPE (M1): the server-side auth core only — token gen/persist, the pairing
// handshake, the request gate. The desktop "Pair device" Settings UI (M6) and
// the mobile QR scanner (M3) are separate issues; they consume /auth/pair +
// /auth/claim built here.

import { unlink } from "node:fs/promises";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { createDeviceRegistry, DEVICES_STORE_PATH, DEVICE_IDLE_TTL_MS, saveDevicesRaw } from "./devices.mjs";

const STORE_PATH = statePath("auth.json");

// How often the device registry's in-memory `last_seen` touches are flushed to
// disk. authorize() runs on every authenticated request, so persisting each
// one would be a write per request; a 1s throttle keeps the device-list's
// last_seen roughly fresh without any write amplification.
const DEVICE_PERSIST_MS = 1000;

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
// box_token). Only the pairing handshake, the per-device revocation handshake,
// and the public webhook delivery leg (which carries its own per-hook
// token+HMAC) are exempt. Everything else — /rpc, /events, /pty, /api/*,
// /push/*, static assets — is gated.
//
// Rationale for each exemption:
//   /auth/pair, /auth/claim — bootstrap; you can't present a token you don't
//     have yet. Rate-limited + code-gated instead.
//   /auth/revoke            — per-device "remove this box" handshake (BET-357 §2).
//     The caller MUST present a valid token, but the standard gate collapses
//     malformed-token and missing-token into the same 401, which loses a
//     useful signal for the desktop's classifier (400 vs 401). This route
//     does its own validation (see authEngine.revoke), distinguishing shape
//     errors from auth errors so the UI can surface a more actionable note.
//   /pair, /pair/qr.png, /pair/logo.png — the pairing onboarding page; a
//     visitor by definition has no token yet. The page carries no secrets
//     (code is in the URL fragment; qr.png is a shape-validated encoder).
//   /hook/<token>          — external senders can't hold the box_token; the hook
//     already authenticates via its own 128-bit token + HMAC (webhooks.mjs).
//   /pages/<sub>           — hosted HTML page (AI `serve_page` tool). The page
//     is public by design and its visitor holds no box_token; the box hostname
//     itself is a 128-bit unguessable label, and the response's sandbox CSP
//     (see src/server/servePage.mjs pageResponseHeaders) denies the page any
//     access to the origin's credentials (localStorage, cookies).
//   OPTIONS (handled by caller) — CORS preflight carries no credentials.
//
// NOTE: /auth/status is intentionally NOT exempt — it reports whether the
// caller's token is valid, so it must run through the gate.
export function isExemptPath(path) {
  if (typeof path !== "string") return false;
  if (path === "/auth/pair" || path === "/auth/claim" || path === "/auth/revoke") return true;
  if (path === "/pair" || path === "/pair/qr.png" || path === "/pair/logo.png") return true;
  if (path === "/hook/" || path.startsWith("/hook/")) return true;
  if (path === "/pages/" || path.startsWith("/pages/")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Local-only gate for minting pairing codes
// ---------------------------------------------------------------------------
//
// GET /auth/pair must be callable ONLY from the box itself (the `manta pair` CLI,
// or any other channel that terminates on the box).
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
// Query-param token fallback for header-less clients (/events ONLY)
// ---------------------------------------------------------------------------
//
// Browsers cannot set an Authorization header on a WebSocket handshake (or on
// an EventSource), so the streaming route accepts the box_token as a
// ?token=<box_token> query param instead. This is DELIBERATELY limited to
// /events + /pty: every other route must present a real Bearer header, so a
// token can never leak into a proxy/referrer log for a normal data request.
// (BET-138 removed the /pty WS — BET-158 brings it back as a binary-safe
// terminal WS. Direct clients (desktop + mobile browser) connect with the
// box's own box_token; the ?token= query param is the browser-fallback for
// clients that can't set WS headers.)
//
// Pure + testable: given a path, the Authorization header value, and the raw
// ?token= query value, return the effective Authorization value to feed into
// authorize(). The header always wins when present (non-browser clients keep
// using it); the query token is honored only as a fallback and only on the
// allowlisted stream paths (/events, /pty).
export const QUERY_TOKEN_PATHS = new Set(["/events", "/pty"]);

export function queryTokenAllowedForPath(path) {
  return QUERY_TOKEN_PATHS.has(path);
}

export function authorizationForRequest(path, headerValue, queryToken) {
  // A real Authorization header always takes precedence, on any route.
  if (typeof headerValue === "string" && headerValue.trim() !== "") {
    return headerValue;
  }
  // No header: fall back to ?token= ONLY on the allowlisted stream path.
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

// Letters for the two-sided four-character verification code. Unambiguous
// alphabet (no I/L/O that read like 1/0), uppercase. Digits likewise avoid
// 0/1. The code is four chars grouped as two pairs — "K7 Q2" (§5.3) — stored
// contiguously ("K7Q2"); the panel renders the space.
const VERIFY_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const VERIFY_DIGITS = "23456789";

export function genVerifyCode() {
  // Two pairs of [letter][digit] draw — e.g. "K7Q2" → displayed "K7 Q2".
  let s = "";
  for (let pair = 0; pair < 2; pair++) {
    s += VERIFY_LETTERS[randomInt(0, VERIFY_LETTERS.length)];
    s += VERIFY_DIGITS[randomInt(0, VERIFY_DIGITS.length)];
  }
  return s;
}

// Normalize a presented verification code for comparison: strip whitespace +
// fold case so "K7 Q2", "k7 q2" and "K7Q2" all match the same minted code.
// The human reads the pair form on both screens, so we never want a stray
// space or case to break the two-factor confirm.
export function normalizeVerifyCode(s) {
  return typeof s === "string" ? s.replace(/\s+/g, "").toUpperCase() : "";
}

// ---------------------------------------------------------------------------
// Store (atomic write + 0600 via jsonStore.mjs — single source of truth)
// ---------------------------------------------------------------------------

// Load the persisted { box_id, box_token, created_at }. Returns null if the
// file is missing or corrupt (caller then generates a fresh identity).
export function loadAuth(path = STORE_PATH) {
  const parsed = readJsonSync(path, null);
  if (
    parsed &&
    isValidToken(parsed.box_id) &&
    isValidToken(parsed.box_token)
  ) {
    return {
      box_id: parsed.box_id,
      box_token: parsed.box_token,
      created_at: parsed.created_at ?? null,
    };
  }
  return null;
}

export async function saveAuth(auth, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

// Delete the persisted auth file. Idempotent — a missing file is not an error
// (the caller is racing for "delete a box" semantics where concurrent revokes
// are fine, and a not-yet-created store on a fresh install is irrelevant).
// Used by revoke() to satisfy the BET-357 §2 contract: "the old box_token no
// longer works" is enforced by regenerating a fresh identity (see revoke),
// but the on-disk file is rewritten by the regenerate step so the store shape
// stays consistent across revocation.
export async function deleteAuth(path = STORE_PATH) {
  try {
    await unlink(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return;
    throw e;
  }
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
  let active = null; // { code, verify, expiresAt }

  function issue() {
    active = { code: genPairingCode(), verify: genVerifyCode(), expiresAt: now() + ttlMs };
    return { code: active.code, verify: active.verify, expiresAt: active.expiresAt };
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

  // Two-factor confirm check (the "matches" affordance carried back in the
  // claim): does `verify` match the four characters minted alongside `code`?
  // Non-consumeing — a mismatch must NOT burn the one-time code (a wrong
  // verify is a human/typo error on the deferred phone screen, not an attack),
  // so the joiner can correct and retry within the code's window.
  function verifyMatches(code, verify) {
    if (!isValidPairingCode(code) || typeof verify !== "string" || verify === "") return false;
    if (!active) return false;
    if (now() > active.expiresAt) {
      active = null;
      return false;
    }
    const ca = Buffer.from(active.code, "utf-8");
    const cbCode = Buffer.from(String(code), "utf-8");
    const codeMatches = ca.length === cbCode.length && timingSafeEqual(ca, cbCode);
    if (!codeMatches) return false;
    const va = Buffer.from(active.verify, "utf-8");
    const vb = Buffer.from(normalizeVerifyCode(verify), "utf-8");
    return va.length === vb.length && timingSafeEqual(va, vb);
  }

  function clear() {
    active = null;
  }

  function hasActive() {
    return !!active && now() <= active.expiresAt;
  }

  return { issue, consume, verifyMatches, clear, hasActive };
}

// ---------------------------------------------------------------------------
// Engine — the object index.mjs wires into the request pipeline
// ---------------------------------------------------------------------------

/**
 * Build the stateful auth engine used by index.mjs. Owns the box identity, the
 * pairing registry, and the per-request gate.
 *
 * When `enforce` is false (env escape hatch MANTA_AUTH_DISABLED=1), the gate
 * allows everything and the server prints a loud one-time warning — this exists
 * only so an existing self-hoster who upgrades isn't instantly locked out of
 * their own box before they've paired. The DEFAULT is enforce=true.
 *
 * @param {object} deps
 *   auth        — { box_id, box_token, created_at } from ensureAuth()
 *   enforce     — gate on (default true)
 *   ttlMs       — pairing-code TTL (default 5 minutes)
 *   now         — injectable clock for tests
 *   idleTtlMs   — device token idle-expiry threshold (§6.4, default 90 days).
 *                 Passed through to the device registry; see devices.mjs.
 *   saveAuth    — injectable writer (default saveAuth) for the post-revoke
 *                 regenerate step
 *   deleteAuth  — injectable unlink (default deleteAuth) for the post-revoke
 *                 "wipe + regenerate" path.
 *   devices     — injectable device registry (createDeviceRegistry instance).
 *                 Tests MUST inject their own (with no-op load/save); the
 *                 DEFAULT targets ~/.manta/devices.json (0600) and is owned by
 *                 index.mjs.
 *
 * DANGER — the saveAuth/deleteAuth DEFAULTS target the real box store
 * (~/.manta/auth.json). Only index.mjs, which owns that store, may rely on
 * them. Any other caller (tests above all) MUST inject its own writers: a
 * revoke() with a matching token silently rotates the identity of the machine
 * running the code, which locks every already-paired device and every
 * manta-native AI tool out of the box until it re-pairs. See the `engine()`
 * helper in auth.test.mjs.
 */
export function createAuthEngine({
  auth,
  enforce = true,
  ttlMs = PAIRING_TTL_MS,
  now = () => Date.now(),
  idleTtlMs = DEVICE_IDLE_TTL_MS,
  saveAuth: saveAuthFn = saveAuth,
  deleteAuth: deleteAuthFn = deleteAuth,
  devices: devicesFn,
} = {}) {
  if (!auth || !isValidToken(auth.box_id) || !isValidToken(auth.box_token)) {
    throw new Error("createAuthEngine: valid { box_id, box_token } required");
  }
  const pairing = createPairingRegistry({ ttlMs, now });

  // Per-device credential registry. Default targets ~/.manta/devices.json;
  // the shared box_token is seeded as the `primary` device so existing paired
  // devices (desktop + manta-native AI tools) keep working unchanged.
  const devices = devicesFn ?? createDeviceRegistry({ now, idleTtlMs });
  // Seed/resync the primary (shared box_token) device — idempotent: if a
  // primary already exists (upgrade path) this just re-syncs its token; on a
  // fresh registry it creates one. This is what keeps the existing desktop +
  // manta-native AI tools authenticating against the new per-device gate.
  devices.seedPrimary(auth.box_token);

  // Fire-and-forget, throttled flush of the device registry (last_seen). Safe
  // to ignore: it never blocks the synchronous auth path, and a lost write
  // only means a stale last_seen on the next process start.
  let lastDevicePersist = 0;
  function maybePersistDevices(force = false) {
    const t = now();
    if (force || t - lastDevicePersist > DEVICE_PERSIST_MS) {
      lastDevicePersist = t;
      devices.persist().catch(() => {});
    }
  }

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
    if (presented && devices.authorize(presented)) {
      // matched a live device (primary or per-device) → authorized; last_seen
      // bumped in memory, flushed at most once per DEVICE_PERSIST_MS.
      maybePersistDevices();
      return { ok: true };
    }
    if (devices.needPersist && devices.needPersist()) {
      // authorize() rejected BECAUSE it just revoked an idle-expired device.
      // That revocation must be durable even though authorize only flushes on
      // success — force it (fire-and-forget; a lost write just means the next
      // request re-detects + re-revokes from the durable stale last_seen).
      maybePersistDevices(true);
    }
    return { ok: false, status: 401, error: "unauthorized" };
  }

  // Handle GET /auth/pair — mint a one-time pairing code. Rate-limiting is
  // applied by the caller (index.mjs) via the shared limiter; here we just
  // issue. Returns the code + the four-character verification code + box_id so
  // the desktop can render it / a QR and the joiner can two-factor confirm (§5.3).
  function pair() {
    const { code, verify, expiresAt } = pairing.issue();
    return { ok: true, pairing_code: code, box_id: auth.box_id, expiresAt, verify };
  }

  // Handle POST /auth/claim — exchange a valid code for a device credential.
  // One-time: a correct code is consumed. Returns 400 on a missing/invalid
  // code and 403 on a wrong/expired/already-used code (so a guesser learns only
  // "no", never partial progress).
  //
  // TWO PATHS, keyed by the two-factor confirm (`verify`):
  //   • verify ABSENT  → legacy first-pair path: resume the PRIMARY (shared
  //     box_token) device and return `box_token = auth.box_token` exactly as
  //     before — existing paired clients keep working unchanged.
  //   • verify PRESENT → joiner path (§6.1/§6.3): the caller echoes the four
  //     characters the desktop panel shows (the "matches" confirmation). A
  //     mismatch → 403 WITHOUT consuming the code (retryable). On a match the
  //     claim PROVISIONS A DISTINCT device in the Stage-2 registry — never the
  //     desktop's own token — so a joiner can never impersonate the desktop or
  //     an existing device.
  //
  // Either way the response keeps the `{ box_token, box_id }` shape existing
  // clients already persist; `device_id` is additive.
  function claim({ pairing_code, verify = null, device_id = null, name = null } = {}) {
    if (!isValidPairingCode(pairing_code)) {
      return { ok: false, status: 400, error: "invalid pairing code" };
    }
    const twoFactor = typeof verify === "string" && verify !== "";
    if (twoFactor && !pairing.verifyMatches(pairing_code, verify)) {
      return { ok: false, status: 403, error: "verification failed" };
    }
    if (!pairing.consume(pairing_code)) {
      return { ok: false, status: 403, error: "pairing failed" };
    }

    if (twoFactor) {
      // Joiner path — a DISTINCT device, never the primary. A device_id we're
      // given resumes that device (its own distinct token, which by definition
      // is a per-device entry, not the desktop's); absent, mint a fresh id.
      const joinerId =
        device_id && typeof device_id === "string" && device_id !== "" ? device_id : genToken();
      const { entry } = devices.claim({ deviceId: joinerId, name });
      maybePersistDevices(true);
      return {
        ok: true,
        box_token: entry.token,
        box_id: auth.box_id,
        device_id: entry.device_id,
      };
    }

    // Legacy path — resume the PRIMARY (shared box_token) device.
    const { entry } = devices.claim({ deviceId: device_id, name });
    maybePersistDevices(true);
    return {
      ok: true,
      box_token: entry.token,
      box_id: auth.box_id,
      device_id: entry.device_id,
    };
  }

  // Handle DELETE /auth/revoke — two modes:
  //   • PER-DEVICE (device_id supplied): kill only that device's token, leaving
  //     every other device (and the primary box_token holder) working. This is
  //     §6.3/§6.4 "revoke one device" — the revoked token is dead on its very
  //     next request.
  //   • WHOLE-BOX RESET (no device_id): the legacy "remove this box" handshake
  //     (BET-357 §2) — regenerate the entire identity, so EVERY credential
  //     (primary + per-device) must re-pair.
  //
  // Three distinct failure shapes for the desktop's classifier:
  //   • no token presented           → 401 (the standard "unauthorized")
  //   • token is not 32-hex          → 400 (malformed; the device's own value
  //                                    was wrong before it ever reached us)
  //   • token is well-shaped but not a live device → 401
  async function revoke({ token, device_id = null } = {}) {
    if (typeof token !== "string" || token === "") {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    if (!isValidToken(token)) {
      return { ok: false, status: 400, error: "malformed token" };
    }
    // The presented token must itself belong to a live (non-revoked) device —
    // primary or per-device. authorize() bumps last_seen as a side effect.
    if (!devices.authorize(token)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }

    // ---- Per-device revoke: caller names the target device ----
    if (device_id) {
      const target = devices.getDevice(device_id);
      if (!target) return { ok: false, status: 404, error: "device not found" };
      if (devices.revokeDevice(device_id) === null) {
        return { ok: false, status: 404, error: "device not found" };
      }
      maybePersistDevices(true);
      return { ok: true, box_id: auth.box_id, device_id, reset: false };
    }

    // ---- Whole-box reset (legacy back-compat path) ----
    // Caller is a live device and wants the whole box reset. Mint a fresh
    // identity, write it, swap it into the closed-over `auth`, and reset the
    // device registry to a single fresh primary. The OLD token (and every
    // per-device token) is dead from this instant.
    const fresh = {
      box_id: genToken(),
      box_token: genToken(),
      created_at: now(),
    };
    // Clear any active pairing: the code minted under the old identity is
    // moot now (it would authorize the old token, which nothing holds).
    pairing.clear();
    // Wipe the on-disk file first so a power-fail between writes can't leave
    // a stale token behind, then write the fresh identity atomically. Best-
    // effort on the unlink (an absent file is fine — the write below re-
    // creates it).
    await deleteAuthFn();
    await saveAuthFn(fresh);
    // Reset the device registry to the fresh primary token (drops every
    // per-device credential).
    devices.resetAll(fresh.box_token);
    maybePersistDevices(true);
    // Mutate the closed-over `auth` in place. The caller (index.mjs) holds a
    // reference to the same object via `boxAuth`, so it sees the new values.
    auth.box_id = fresh.box_id;
    auth.box_token = fresh.box_token;
    auth.created_at = fresh.created_at;
    return { ok: true, box_id: fresh.box_id, device_id: null, reset: true };
  }

  // Linked-device list for the desktop (Stage 5) + any paired device: public
  // metadata per live device (no tokens). The caller iid is already validated
  // by the auth gate when this is served behind /auth/devices.
  function listDevices() {
    return devices.listDevices();
  }

  return {
    box_id: auth.box_id,
    enforce,
    authorize,
    pair,
    claim,
    revoke,
    listDevices,
    // exposed for /auth/status and tests
    hasActivePairing: () => pairing.hasActive(),
    clearPairing: () => pairing.clear(),
  };
}

export { PAIRING_TTL_MS, STORE_PATH };
