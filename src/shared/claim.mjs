// claim.mjs — pure, framework-free classification of a pairing-claim outcome.
//
// One wire shape (BET-49, BET-198 — relay dropped): the box's POST /auth/claim
// returns { ok, box_token, box_id }. The token IS the box_token (the box's own
// identity); persisted as config.boxToken, presented as Bearer to the box.
//
// Reached from THREE places that must all agree on how an HTTP outcome maps to
// a user-facing result:
//   • the mobile/web client   (src/renderer/mobile/pairingLogic.ts re-exports)
//   • the desktop onboarding   (src/renderer/onboarding/PairStep.tsx via IPC)
//   • the desktop main process (src/main/index.ts auth:claim handler — it does
//                               the fetch, then classifies with these helpers)
//
// Keeping the classification here (a shared .mjs, importable from both the
// renderer tsconfig and the main tsconfig without crossing the process
// boundary) is the single source of truth: a 403 means "wrong code" and a 429
// means "rate limited" in exactly one place. Token-shape validation of a 200
// body is delegated to parseClaimResponse, which gates the field names so a
// malformed token can never be persisted from any entry point.
//
// Pure (no fetch, no DOM, no Node built-ins) → unit-tested in
// src/shared/claim.test.ts.

import { parseClaimResponse, isValidBoxToken } from "./transport.mjs";

// A pairing code is exactly 6 decimal digits (mirrors the server's
// isValidPairingCode in src/server/auth.mjs — kept in sync so a client rejects
// an obviously-wrong code before spending a round-trip + a rate-limit token).
const PAIRING_CODE_RE = /^[0-9]{6}$/;

/**
 * Normalize raw <input> text into a candidate pairing code: strip every
 * non-digit (so spaces / dashes a user types or a paste carries are dropped)
 * and clamp to the first 6 digits. Pure — safe to call on every keystroke.
 */
export function normalizeCode(raw) {
  return String(raw ?? "").replace(/\D+/g, "").slice(0, 6);
}

/** True when `code` is exactly 6 digits — i.e. worth POSTing to /auth/claim. */
export function isSubmittableCode(code) {
  return PAIRING_CODE_RE.test(code);
}

// User-facing copy for each failure category. Kept short — rendered inline
// under the code input.
const FAILURE_MESSAGE = {
  wrong_code: "That code didn't work. Check it and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  invalid_response: "Unexpected response from the server. Try again.",
  network: "Couldn't reach the server. Check the URL and try again.",
  server_error: "The server had a problem. Try again.",
};

function fail(kind) {
  return { ok: false, kind, message: FAILURE_MESSAGE[kind] };
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
 * 400 and 403 collapse to `wrong_code`: the server deliberately returns 403 for
 * every guess (no partial-progress leak), and a 400 here means our own
 * client-side 6-digit guard was bypassed — either way the actionable message
 * for the user is "that code didn't work."
 *
 * @param {number}  status  HTTP status code.
 * @param {unknown} body    Parsed JSON body, or null when absent/unparsable.
 * @returns {ClaimOutcome}
 */
export function classifyClaimResult(status, body) {
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
export function networkFailure() {
  return fail("network");
}
