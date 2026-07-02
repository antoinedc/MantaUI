// pairingLogic.ts — pure, framework-free core for the mobile pairing screen.
//
// M1-T2 (BET-52): when bui-server reports auth-required (httpApi throws
// AuthRequiredError on a 401), MobileApp renders a 6-digit code-entry screen
// instead of the session list. The user pairs a device by minting a code on
// the box (`bui pair` / GET /auth/pair, local-only) and typing it here; we
// POST it to /auth/claim, and on success persist the returned box_token.
//
// Everything a live server or the DOM is NOT required for lives here so it can
// be unit-tested in isolation (src/renderer/mobile/pairingLogic.test.ts):
//   • normalizeCode / isSubmittableCode — the 6-digit input contract
//   • classifyClaimResult              — map an /auth/claim HTTP outcome to a
//                                        typed success/failure the UI renders
//   • pairingReducer                   — the form state machine (idle →
//                                        submitting → error, and back)
//
// The token-shape validation + success-body parsing is delegated to the shared
// parseClaimResponse (src/shared/transport.mjs) — the single source of truth
// the desktop onboarding (BET-49) also uses — so a malformed box_token can
// never be persisted from either entry point.

import { parseClaimResponse } from "../../shared/transport.mjs";

// A pairing code is exactly 6 decimal digits (mirrors the server's
// isValidPairingCode in src/server/auth.mjs — kept in sync so the client
// rejects an obviously-wrong code before spending a round-trip + a rate-limit
// token on it).
const PAIRING_CODE_RE = /^[0-9]{6}$/;

/**
 * Normalize raw <input> text into a candidate pairing code: strip every
 * non-digit (so spaces / dashes a user types or a paste carries are dropped)
 * and clamp to the first 6 digits. Pure — safe to call on every keystroke.
 */
export function normalizeCode(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "").slice(0, 6);
}

/** True when `code` is exactly 6 digits — i.e. worth POSTing to /auth/claim. */
export function isSubmittableCode(code: string): boolean {
  return PAIRING_CODE_RE.test(code);
}

// ---------------------------------------------------------------------------
// Claim-result classification
// ---------------------------------------------------------------------------

/** Why a claim attempt failed, mapped to a stable UI category. */
export type ClaimFailureKind =
  | "wrong_code" // 400/403 — invalid / expired / already-used code
  | "rate_limited" // 429 — too many attempts
  | "invalid_response" // 200 but body wasn't a valid { box_token, box_id }
  | "network" // fetch rejected / server unreachable
  | "server_error"; // 5xx or any other unexpected status

export type ClaimResult =
  | { ok: true; boxToken: string; boxId: string }
  | { ok: false; kind: ClaimFailureKind; message: string };

// User-facing copy for each failure category. Kept short — rendered inline
// under the code input.
const FAILURE_MESSAGE: Record<ClaimFailureKind, string> = {
  wrong_code: "That code didn't work. Check it and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  invalid_response: "Unexpected response from the server. Try again.",
  network: "Couldn't reach the server. Check your connection.",
  server_error: "The server had a problem. Try again.",
};

function fail(kind: ClaimFailureKind): ClaimResult {
  return { ok: false, kind, message: FAILURE_MESSAGE[kind] };
}

/**
 * Classify a POST /auth/claim outcome into a typed ClaimResult. Pure: the
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
 * @param status  HTTP status code (0 or negative may be used by a caller to
 *                signal a network-level failure; prefer classifyNetworkError).
 * @param body    Parsed JSON body, or null when the body was absent/unparsable.
 */
export function classifyClaimResult(status: number, body: unknown): ClaimResult {
  if (status === 200) {
    const parsed = parseClaimResponse(body);
    if (parsed.ok) return { ok: true, boxToken: parsed.boxToken, boxId: parsed.boxId };
    return fail("invalid_response");
  }
  if (status === 429) return fail("rate_limited");
  if (status === 400 || status === 403) return fail("wrong_code");
  if (status >= 500) return fail("server_error");
  // Any other status (401/404/…) is an unexpected server state, not a wrong
  // code — surface it as a generic server error rather than blaming the user's
  // input.
  return fail("server_error");
}

/** Result for a fetch that never produced an HTTP response (offline, DNS, …). */
export function networkFailure(): ClaimResult {
  return fail("network");
}

// ---------------------------------------------------------------------------
// Pairing form state machine
// ---------------------------------------------------------------------------
//
// A tiny reducer so the screen's control flow (what's enabled, what error
// shows, whether a request is in flight) is pure and testable without React.

export type PairingStatus = "idle" | "submitting" | "error";

export interface PairingState {
  /** Current contents of the code input (already normalized to ≤6 digits). */
  code: string;
  status: PairingStatus;
  /** Inline error message shown under the input, or null when none. */
  error: string | null;
}

export type PairingAction =
  | { type: "edit"; raw: string }
  | { type: "submit" }
  | { type: "success" }
  | { type: "fail"; result: Extract<ClaimResult, { ok: false }> };

export const initialPairingState: PairingState = {
  code: "",
  status: "idle",
  error: null,
};

/**
 * Reduce a pairing action. Rules:
 *   • edit    — while submitting, input is locked (ignored); otherwise update
 *               the (normalized) code and clear any prior error so the user
 *               isn't scolded mid-correction.
 *   • submit  — only starts a request from idle/error AND with a submittable
 *               (6-digit) code; otherwise a no-op. Enters "submitting", clears
 *               the error.
 *   • success — request resolved with a valid token; return to idle, no error.
 *               (The caller persists the token + drops the screen.)
 *   • fail    — request failed; back to "error" with the classified message,
 *               code preserved so the user can fix it.
 */
export function pairingReducer(
  state: PairingState,
  action: PairingAction,
): PairingState {
  switch (action.type) {
    case "edit": {
      if (state.status === "submitting") return state; // locked in-flight
      return { ...state, code: normalizeCode(action.raw), error: null };
    }
    case "submit": {
      if (state.status === "submitting") return state;
      if (!isSubmittableCode(state.code)) return state;
      return { ...state, status: "submitting", error: null };
    }
    case "success": {
      return { ...state, status: "idle", error: null };
    }
    case "fail": {
      return { ...state, status: "error", error: action.result.message };
    }
    default:
      return state;
  }
}

/** True when the Connect button should be enabled. */
export function canSubmit(state: PairingState): boolean {
  return state.status !== "submitting" && isSubmittableCode(state.code);
}
