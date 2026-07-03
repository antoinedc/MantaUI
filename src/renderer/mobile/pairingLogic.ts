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
// The input contract + HTTP-outcome classification now live in the shared,
// process-boundary-safe src/shared/claim.mjs (so the desktop main process can
// classify the same way without importing renderer code). This module
// re-exports them for the mobile client's existing call sites + tests, and adds
// the mobile-only form state machine (pairingReducer) on top.

export {
  normalizeCode,
  isSubmittableCode,
  classifyClaimResult,
  networkFailure,
} from "../../shared/claim.mjs";
import { isSubmittableCode, normalizeCode } from "../../shared/claim.mjs";
import type { ClaimFailureKind, ClaimOutcome } from "../../shared/claim.mjs";

// Historical alias: the mobile client + tests refer to the classified outcome
// as `ClaimResult`. `ClaimOutcome` is the shared name; keep both in sync.
export type { ClaimFailureKind };
export type ClaimResult = ClaimOutcome;

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
  | { type: "fail"; result: Extract<ClaimResult, { ok: false }> }
  | { type: "scanFail"; reason: ScanFailReason };

// ---------------------------------------------------------------------------
// QR scan failure → inline message (BET-74)
// ---------------------------------------------------------------------------
//
// The scan path (PairingScreen "Scan QR code" button) can fail three ways
// before we ever reach the claim: a decoded string that isn't a bui pairing QR,
// a refused camera permission, or no native scanner at all (browser/PWA). Each
// maps to a distinct inline message; the manual 6-digit input stays usable in
// every case. Kept here (pure) so the "scan failed → error" transition is
// unit-tested like the rest of the reducer.

/** Why the scan branch failed, from the caller's point of view. */
export type ScanFailReason = "invalid" | "denied" | "unavailable";

/** Human message shown inline for each scan failure reason. */
export function scanFailMessage(reason: ScanFailReason): string {
  switch (reason) {
    case "invalid":
      return "Not a bui pairing QR — enter the code manually.";
    case "denied":
      return "Camera permission needed — enter the code manually.";
    case "unavailable":
      return "Scanning not available — enter the code manually.";
  }
}

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
    case "scanFail": {
      // A scan attempt failed before any claim; surface the reason inline and
      // leave the manual code (if any) untouched so the user can keep typing.
      // Ignored mid-flight (a claim is already in progress).
      if (state.status === "submitting") return state;
      return { ...state, status: "error", error: scanFailMessage(action.reason) };
    }
    default:
      return state;
  }
}

/** True when the Connect button should be enabled. */
export function canSubmit(state: PairingState): boolean {
  return state.status !== "submitting" && isSubmittableCode(state.code);
}
