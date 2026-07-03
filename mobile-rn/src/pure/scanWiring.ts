// scanWiring.ts — pure decision logic for the QR-scan → pair flow.
//
// When the camera decodes a barcode, the screen must decide: is this a valid bui
// pairing QR? If so, extract { serverUrl, code } so the impure layer can claim
// the token. If not, show an inline error. Keeping that branch pure (no camera,
// no fetch) makes it unit-testable — the RN screen just renders whatever this
// returns.

import { parsePairPayload, type PairPayload } from "./pairPayload";

export type ScanDecision =
  | { kind: "pair"; payload: PairPayload }
  | { kind: "invalid"; message: string };

// Inline copy for a decoded string that isn't a bui pairing QR.
const INVALID_QR_MESSAGE = "That's not a bui pairing QR code.";

/**
 * Decide what to do with a decoded QR string. A valid `bui://pair?...` (or the
 * deferred-deeplink https form) yields `{ kind: "pair", payload }`; anything
 * else (a URL to a website, a wifi QR, a truncated string) yields
 * `{ kind: "invalid" }` with a user-facing message. Pure — reuses the ported
 * BET-73 parser so the accept/reject contract is single-sourced.
 */
export function decideScan(raw: string): ScanDecision {
  const payload = parsePairPayload(raw);
  if (payload) return { kind: "pair", payload };
  return { kind: "invalid", message: INVALID_QR_MESSAGE };
}

// ---------------------------------------------------------------------------
// Camera-permission → UI-state classification
// ---------------------------------------------------------------------------
//
// expo-camera's useCameraPermissions hook reports one of: granted, denied,
// undetermined (never asked). We also model "unavailable" for environments with
// no camera at all (Expo Go on a simulator). The screen renders the scan button
// only when the camera is usable, and an inline hint otherwise — so the user
// always has the manual fallback.

export type CameraAvailability = "ready" | "prompt" | "denied" | "unavailable";

export interface CameraPermissionLike {
  granted: boolean;
  // expo-camera's PermissionStatus: "granted" | "denied" | "undetermined".
  status?: string;
  // Whether the OS will still show a prompt if we ask (false once permanently
  // denied). expo-camera exposes this as `canAskAgain`.
  canAskAgain?: boolean;
}

/**
 * Map an expo-camera permission object (or null when the platform has no camera
 * module) to a CameraAvailability the screen renders from. Pure.
 *   • null / no module         → "unavailable"  (simulator; manual entry only)
 *   • granted                  → "ready"        (show the scan button)
 *   • denied + can ask again   → "prompt"       (button re-requests permission)
 *   • denied + cannot ask      → "denied"       (deep-link to Settings hint)
 *   • undetermined             → "prompt"       (first tap requests permission)
 */
export function classifyCameraAvailability(
  perm: CameraPermissionLike | null | undefined,
): CameraAvailability {
  if (!perm) return "unavailable";
  if (perm.granted) return "ready";
  if (perm.status === "denied" && perm.canAskAgain === false) return "denied";
  return "prompt";
}
