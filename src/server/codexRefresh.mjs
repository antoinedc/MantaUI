// codexRefresh.mjs — OAuth refresh for a Codex (ChatGPT) SEAT that is NOT the
// live login (multi-account spec §3/§4, phase 2).
//
// The live login lives in opencode's auth.json, and opencode refreshes it. A
// seat's own copy (~/.manta-secrets/accounts/codex/<seatId>/auth.json) is ours to
// keep fresh, because the manta-accounts plugin sends that seat's access token
// on requests for conversations assigned to it.
//
// FACTS this is written against (verified against opencode's own Codex loader):
//   • POST https://auth.openai.com/oauth/token, form body
//     grant_type=refresh_token & refresh_token=… & client_id=app_EMoamEEZ73f0CkXaXp7hrann
//   • the response is {access_token, refresh_token, id_token, expires_in}
//   • REFRESH TOKENS ROTATE — the new one must be persisted or the seat is signed
//     out the next time. So the file is rewritten atomically BEFORE the result is
//     reported, and concurrent refreshes of one file are single-flight.
//   • the ChatGPT account id comes from the id_token, then the access_token:
//     chatgpt_account_id ?? ["https://api.openai.com/auth"].chatgpt_account_id
//     ?? organizations[0].id; when neither carries one the previous id is kept.
//
// Tokens are never logged and never appear in a returned reason.

import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "./jsonStore.mjs";

export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_CLAIM = "https://api.openai.com/auth";
// The proactive sweep refreshes a seat this far ahead of expiry (spec: 5 min).
export const CODEX_REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;

/** The claims of a JWT (no signature check — we only read our own tokens). */
export function decodeJwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/** ChatGPT account id out of decoded claims, in opencode's precedence order. */
export function accountIdFromClaims(claims) {
  const id = claims?.chatgpt_account_id ?? claims?.[AUTH_CLAIM]?.chatgpt_account_id ?? claims?.organizations?.[0]?.id;
  return typeof id === "string" && id ? id : null;
}

/** id_token first, then access_token. Null when neither carries one. */
export function extractAccountId(tokens) {
  for (const t of [tokens?.id_token, tokens?.access_token]) {
    if (!t) continue;
    const id = accountIdFromClaims(decodeJwtClaims(t));
    if (id) return id;
  }
  return null;
}

/**
 * The new openai entry after a successful token response. Pure.
 * @param {object} prev  the entry being replaced (its other fields are kept)
 * @param {{access_token?:string, refresh_token?:string, id_token?:string, expires_in?:number}} tokens
 * @param {number} nowMs
 * @returns {object|null} null when the response has no access token
 */
export function applyTokenResponse(prev, tokens, nowMs) {
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) return null;
  const expiresIn = typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;
  return {
    ...prev,
    type: "oauth",
    refresh: typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : prev.refresh,
    access: tokens.access_token,
    expires: nowMs + expiresIn * 1000,
    accountId: extractAccountId(tokens) ?? prev.accountId,
  };
}

/** Is a token with this expiry due for the proactive refresh? Pure. */
export function shouldRefreshCodexAhead(expiresAt, nowMs, marginMs = CODEX_REFRESH_MARGIN_MS) {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt - nowMs <= marginMs;
}

async function readAuthFile(file) {
  try {
    const raw = JSON.parse(await readFile(file, "utf-8"));
    const wrapped = raw?.openai && typeof raw.openai === "object";
    const entry = wrapped ? raw.openai : raw?.access ? raw : null;
    if (!entry || entry.type !== "oauth") return null;
    return { raw, wrapped, entry };
  } catch {
    return null;
  }
}

/** The expiry (epoch ms) of the seat file's access token, or null. */
export async function readCodexExpiry(file) {
  const f = await readAuthFile(file);
  return typeof f?.entry?.expires === "number" ? f.entry.expires : null;
}

/** The openai oauth entry of an auth.json-shaped file, or null. */
export async function readCodexEntry(file) {
  return (await readAuthFile(file))?.entry ?? null;
}

const inFlight = new Map();

/**
 * Run `fn` at most once at a time per key; a caller arriving meanwhile gets the
 * SAME promise. Every refresh of one login goes through here (a rotating refresh
 * token must never be spent twice), keyed by the file that holds the login.
 */
export function singleFlight(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = (async () => fn())().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * ONE token-endpoint call. Never throws; reasons carry no secrets.
 * @returns {Promise<{ok:true, tokens:object}|{ok:false, reason:string}>}
 */
export async function requestCodexTokens(refreshToken, { fetchImpl = fetch, log = console, label = "refresh" } = {}) {
  let res;
  try {
    res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!res?.ok) {
    // 400/401 from the token endpoint = the refresh token itself was refused.
    const reason = res?.status === 400 || res?.status === 401 ? "refresh-token-rejected" : `http-${res?.status ?? "unknown"}`;
    log.log?.("[codex-auth] %s ok=false reason=%s", label, reason);
    return { ok: false, reason };
  }
  try {
    return { ok: true, tokens: await res.json() };
  } catch {
    return { ok: false, reason: "bad-response" };
  }
}

/**
 * Refresh one seat file. Single-flight per file (a rotating refresh token must
 * never be spent twice). Never throws.
 * @param {{seatId?: string, file: string}} target
 * @param {{fetchImpl?: typeof fetch, now?: () => number, log?: {log?:Function}}} [deps]
 * @returns {Promise<{ok:true, expiresAt:number}|{ok:false, reason:string}>}
 */
export function refreshCodexSeat({ seatId, file }, deps = {}) {
  return singleFlight(file, () => doRefresh({ seatId, file }, deps));
}

async function doRefresh({ seatId, file }, { fetchImpl = fetch, now = Date.now, log = console } = {}) {
  const f = await readAuthFile(file);
  if (!f) return { ok: false, reason: "no-credentials" };
  if (typeof f.entry.refresh !== "string" || !f.entry.refresh) return { ok: false, reason: "no-refresh-token" };

  const r = await requestCodexTokens(f.entry.refresh, { fetchImpl, log, label: `seat refresh seat=${seatId ?? "-"}` });
  if (!r.ok) return r;
  const next = applyTokenResponse(f.entry, r.tokens, now());
  if (!next) return { ok: false, reason: "bad-response" };

  // Persist the ROTATED refresh token before reporting success.
  const out = f.wrapped ? { ...f.raw, openai: next } : next;
  try {
    await writeJsonAtomic(file, JSON.stringify(out), { mode: 0o600 });
  } catch {
    return { ok: false, reason: "write-failed" };
  }
  log.log?.("[codex-auth] seat refresh seat=%s ok=true expiresAt=%s", seatId ?? "-", next.expires);
  return { ok: true, expiresAt: next.expires };
}
