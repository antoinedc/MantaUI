// claim.ts — pure classification of a POST /auth/claim outcome for the RN app.
//
// Ported from the web client's shared classifier (src/shared/claim.mjs +
// src/shared/transport.mjs) so the Expo app maps an HTTP outcome to a
// user-facing result EXACTLY like the desktop/web clients do: a 403 means "wrong
// code", a 429 means "rate limited", a 200 with a malformed body is rejected
// before any token is persisted.
//
// Pure (no fetch, no Keychain, no RN globals) → unit-tested under repo-root
// vitest. The impure fetch + expo-secure-store wiring lives in ../api/pairingApi.ts.

// A pairing code is exactly 6 decimal digits (mirrors the server's
// isValidPairingCode in src/server/auth.mjs).
const PAIRING_CODE_RE = /^[0-9]{6}$/;

// A box_id / box_token is exactly 32 lowercase hex chars (128 bits). Strict, so
// a malformed value can never smuggle a path-traversal / header-injection
// payload into a Bearer header. Mirrors src/server/auth.mjs isValidToken and
// src/shared/transport.mjs isValidBoxToken.
const BOX_TOKEN_RE = /^[0-9a-f]{32}$/;

export type ClaimFailureKind =
  | "wrong_code"
  | "rate_limited"
  | "invalid_response"
  | "network"
  | "server_error";

export type ClaimOutcome =
  | { ok: true; boxToken: string; boxId: string }
  | { ok: false; kind: ClaimFailureKind; message: string };

export type ClaimResult = ClaimOutcome;

/**
 * Strip every non-digit and clamp to the first 6 digits. Pure — safe to call on
 * every keystroke of the manual code input.
 */
export function normalizeCode(raw: string): string {
  return String(raw ?? "")
    .replace(/\D+/g, "")
    .slice(0, 6);
}

/** True when `code` is exactly 6 digits — i.e. worth POSTing to /auth/claim. */
export function isSubmittableCode(code: string): boolean {
  return PAIRING_CODE_RE.test(code);
}

/** True when `token` is a valid 32-hex box_id / box_token. */
export function isValidBoxToken(token: unknown): token is string {
  return typeof token === "string" && BOX_TOKEN_RE.test(token);
}

// User-facing copy for each failure category. Kept short — rendered inline under
// the code input.
const FAILURE_MESSAGE: Record<ClaimFailureKind, string> = {
  wrong_code: "That code didn't work. Check it and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  invalid_response: "Unexpected response from the server. Try again.",
  network: "Couldn't reach the server. Check the URL and try again.",
  server_error: "The server had a problem. Try again.",
};

function fail(kind: ClaimFailureKind): ClaimOutcome {
  return { ok: false, kind, message: FAILURE_MESSAGE[kind] };
}

/**
 * Validate a 200 /auth/claim body. Mirrors src/shared/transport.mjs
 * parseClaimResponse: a non-object body, or missing / malformed box_token /
 * box_id, is invalid.
 */
function parseClaimResponse(
  json: unknown,
): { ok: true; boxToken: string; boxId: string } | { ok: false } {
  if (!json || typeof json !== "object") return { ok: false };
  const boxToken = (json as Record<string, unknown>).box_token;
  const boxId = (json as Record<string, unknown>).box_id;
  if (!isValidBoxToken(boxToken) || !isValidBoxToken(boxId)) return { ok: false };
  return { ok: true, boxToken, boxId };
}

/**
 * Classify a POST /auth/claim outcome into a typed ClaimOutcome. Pure: the
 * caller performs the fetch and hands the parsed pieces here.
 *
 * Server contract (src/server/auth.mjs claim() + index.mjs):
 *   200 { box_token, box_id } — success (validated via parseClaimResponse)
 *   400 { error }             — malformed pairing code (shape rejected server-side)
 *   403 { error }             — wrong / expired / already-used code
 *   429 { error }             — rate limited (too many attempts)
 *   5xx                       — server error
 *
 * 400 and 403 collapse to `wrong_code`: the server returns 403 for every guess
 * (no partial-progress leak), and a 400 here means our own 6-digit guard was
 * bypassed — either way the actionable message is "that code didn't work."
 */
export function classifyClaimResult(status: number, body: unknown): ClaimOutcome {
  if (status === 200) {
    const parsed = parseClaimResponse(body);
    if (parsed.ok) return { ok: true, boxToken: parsed.boxToken, boxId: parsed.boxId };
    return fail("invalid_response");
  }
  if (status === 429) return fail("rate_limited");
  if (status === 400 || status === 403) return fail("wrong_code");
  if (status >= 500) return fail("server_error");
  // Any other status (401/404/…) is an unexpected server state, not a wrong
  // code — surface it as a generic server error rather than blaming the input.
  return fail("server_error");
}

/** Result for a fetch that never produced an HTTP response (offline, DNS, …). */
export function networkFailure(): ClaimOutcome {
  return fail("network");
}
