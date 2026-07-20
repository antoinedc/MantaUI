// gatewayRegister.mjs — box-side registration against the hosted push gateway
// (BET-198 §WP2). Replaces the box's old outbound dial to the relay with a
// single POST to the gateway's `/register` endpoint that creates / refreshes
// the per-box DNS A record and (on first boot) mints a `gateway_token`. The
// token is persisted into ~/.manta/auth.json — the SAME file that holds
// `box_token` — using the shared atomic-write helper.
//
// Behavior:
//   - First boot (no `gateway_token` in auth.json):
//       POST /register with body { box_id }, NO auth header.
//       Persists the returned `gateway_token` + `gateway_host`.
//   - Subsequent boot (`gateway_token` already on disk):
//       POST /register with body { box_id } + Authorization: Bearer <token>
//       (idempotent IP refresh). The response carries only `{ host }` — we
//       do NOT rewrite auth.json because the token did not change.
//   - Any failure (fetch throw, non-2xx): `console.warn` + return. NEVER
//     throw — push startup is best-effort; the next boot will retry.
//   - `process.env.MANTA_GATEWAY_BASE === "off"` → return immediately. Used
//     by dev boxes + CI to skip network entirely.
//
// All I/O is injectable so the unit tests run with an in-memory file and a
// fake fetch — no FS, no real network.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { atomicWrite } from "./storeUtils.mjs";
import { STORE_PATH as DEFAULT_AUTH_PATH } from "./auth.mjs";

// Gateway base URL. The env override exists ONLY for tests + dev boxes; prod
// uses the canonical https://gateway.mantaui.com. The "off" sentinel is the
// opt-out used by CI and the local dev box where we don't want any network
// at boot.
const DEFAULT_GATEWAY_BASE =
  process.env.MANTA_GATEWAY_BASE ?? "https://gateway.mantaui.com";

// ---------------------------------------------------------------------------
// Pure helpers (testable in isolation)
// ---------------------------------------------------------------------------

// box_id shape matches src/server/auth.mjs isValidToken (32 lowercase hex).
// We don't import the function to avoid a cycle once auth.mjs is wired into
// the same boot path — but the test asserts the same regex.
function isValidBoxId(boxId) {
  return typeof boxId === "string" && /^[0-9a-f]{32}$/.test(boxId);
}

// Load the persisted auth.json. Returns `{ box_id, box_token, gateway_token,
// gateway_host }` for any subset of fields the file actually has; returns
// `null` when the file is missing/unreadable/has no box_id. Extra fields
// (created_at, etc.) are passed through so a subsequent save round-trip is
// lossless.
export function loadAuthIdentity(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      box_id: typeof parsed.box_id === "string" ? parsed.box_id : null,
      box_token: typeof parsed.box_token === "string" ? parsed.box_token : null,
      gateway_token:
        typeof parsed.gateway_token === "string" ? parsed.gateway_token : null,
      gateway_host:
        typeof parsed.gateway_host === "string" ? parsed.gateway_host : null,
      _raw: parsed,
    };
  } catch {
    return null;
  }
}

// Persist the box identity PLUS the freshly-issued gateway_token + host back
// to auth.json atomically. We NEVER lose the existing box_id / box_token —
// the new fields are merged over the previous JSON. `data` parameter is the
// full desired file contents (NOT a patch): the caller passes
// `{ ...existing, gateway_token, gateway_host }` so the file stays lossless
// for fields we don't know about.
async function persistAuthIdentity(path, data) {
  await atomicWrite(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or refresh) this box with the hosted push gateway. Best-effort —
 * never throws. See file-level docblock for the full state machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.authPath]   Path to ~/.manta/auth.json (injectable).
 * @param {string} [opts.gatewayBase] Gateway base URL (default
 *                                     MANTA_GATEWAY_BASE env or
 *                                     https://gateway.mantaui.com).
 * @param {typeof fetch} [opts.fetchImpl] Fetch impl (default globalThis.fetch).
 * @param {typeof console} [opts.console] Console (injectable for tests).
 * @returns {Promise<{ ok: boolean, skipped?: string, status?: number, error?: string }>}
 *   ok=true means registration succeeded (first-boot OR re-register).
 *   ok=false means fetch failed OR returned non-2xx; the server is still up.
 *   skipped is set when MANTA_GATEWAY_BASE==="off" or the box has no box_id.
 */
export async function registerWithGateway({
  authPath = DEFAULT_AUTH_PATH,
  gatewayBase = DEFAULT_GATEWAY_BASE,
  fetchImpl,
  console: consoleImpl = console,
} = {}) {
  const log = consoleImpl.log.bind(consoleImpl);
  const warn = consoleImpl.warn.bind(consoleImpl);
  const doFetch = fetchImpl ?? globalThis.fetch;

  // Dev / CI opt-out: no network at all.
  if (gatewayBase === "off") {
    return { ok: false, skipped: "off" };
  }

  // Read the box identity. A box with no box_id (very first boot, before
  // ensureAuth() ran) is a no-op — the next boot will have it.
  const ident = loadAuthIdentity(authPath);
  if (!ident || !ident.box_id) {
    warn("[gateway-register] no box_id in auth.json — skipping (next boot will retry)");
    return { ok: false, skipped: "no_box_id" };
  }
  if (!isValidBoxId(ident.box_id)) {
    warn("[gateway-register] malformed box_id in auth.json — skipping");
    return { ok: false, skipped: "bad_box_id" };
  }

  // Build the request. First boot → no Authorization header (gateway mints
  // a fresh token). Subsequent boot → include the bearer (gateway uses it to
  // verify and skips token re-issue, returning only { host }).
  const headers = { "content-type": "application/json" };
  if (ident.gateway_token) {
    headers.authorization = `Bearer ${ident.gateway_token}`;
  }
  const url = `${gatewayBase}/register`;
  let resp;
  try {
    resp = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ box_id: ident.box_id }),
    });
  } catch (e) {
    warn(
      `[gateway-register] fetch failed: ${e?.message ?? e} (url=${url}) — next boot will retry`,
    );
    return { ok: false, error: "fetch_failed" };
  }

  if (!resp || !resp.ok) {
    warn(
      `[gateway-register] non-2xx status=${resp?.status ?? "?"} url=${url} — next boot will retry`,
    );
    return { ok: false, status: resp?.status ?? 0, error: "non_2xx" };
  }

  // Parse the JSON body. A malformed response must NOT corrupt auth.json —
  // we leave it untouched and warn.
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    warn(`[gateway-register] malformed JSON in response: ${e?.message ?? e}`);
    return { ok: false, error: "bad_json" };
  }
  if (!body || typeof body !== "object") {
    warn("[gateway-register] response body is not a JSON object");
    return { ok: false, error: "bad_json" };
  }

  // First-boot path: the gateway mints a token. Persist BOTH token + host
  // atomically, preserving every other field in auth.json.
  if (typeof body.gateway_token === "string" && body.gateway_token) {
    if (typeof body.host !== "string" || !body.host) {
      warn("[gateway-register] missing host in /register response — not persisting");
      return { ok: false, error: "missing_host" };
    }
    const next = {
      ...(ident._raw ?? {}),
      box_id: ident.box_id,
      gateway_token: body.gateway_token,
      gateway_host: body.host,
    };
    try {
      await persistAuthIdentity(authPath, next);
    } catch (e) {
      warn(
        `[gateway-register] failed to persist auth.json: ${e?.message ?? e} — retry on next boot`,
      );
      return { ok: false, error: "persist_failed" };
    }
    log(
      `[gateway-register] registered box_id=${ident.box_id.slice(0, 8)}… host=${body.host}`,
    );
    return { ok: true, registered: true, host: body.host };
  }

  // Re-register path: response carries only `{ host }` (no token re-issue).
  // auth.json is unchanged — we just confirm reachability so logs are useful.
  if (typeof body.host === "string" && body.host) {
    log(
      `[gateway-register] refreshed box_id=${ident.box_id.slice(0, 8)}… host=${body.host}`,
    );
    return { ok: true, registered: false, host: body.host };
  }

  warn("[gateway-register] response had no gateway_token and no host");
  return { ok: false, error: "empty_response" };
}

export { DEFAULT_GATEWAY_BASE };
