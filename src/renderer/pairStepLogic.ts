// pairStepLogic.ts — pure, framework-free core for the desktop onboarding Step 1
// (Pair) screen (BET-49-T2).
//
// The desktop pair screen differs from the mobile one (renderer/mobile/
// pairingLogic.ts) in one way: the desktop user also types the SERVER URL to
// pair against (the mobile client already knows its own base from
// localStorage["manta_server"]). So Step 1's submit gate is "a non-empty server
// URL AND a 6-digit code", and the claim is performed by the main process over
// the `auth:claim` IPC channel (which persists config on success).
//
// The 6-digit code contract + HTTP-outcome classification are the SHARED ones
// (src/shared/claim.mjs). This module adds only the desktop-specific URL
// normalization + the combined submit gate, so the whole non-React surface of
// the screen is unit-testable without a DOM or a live server.

import { isSubmittableCode } from "../shared/claim.mjs";

/**
 * Normalize a server URL for submission: trim surrounding whitespace and any
 * trailing slashes (so "http://box:8787/" and "http://box:8787" are equal).
 * Does NOT inject a scheme — an empty or scheme-less value is left as-is and
 * gated by isValidServerUrl below (the user corrects it inline).
 */
export function normalizeServerUrl(raw: string): string {
  return String(raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * True when `raw` looks like a fetchable http(s) URL. Kept deliberately loose —
 * we don't validate the host, only that there's an http(s):// scheme and
 * something after it. The real reachability check is the claim round-trip
 * itself (a bad host surfaces as a network failure the UI shows for correction).
 */
export function isValidServerUrl(raw: string): boolean {
  const url = normalizeServerUrl(raw);
  return /^https?:\/\/.+/i.test(url);
}

/**
 * True when the Connect button should be enabled: not mid-request, a valid
 * server URL, AND a submittable (6-digit) code. Pure — the caller passes the
 * current field values + in-flight flag.
 */
export function canConnect(input: {
  serverUrl: string;
  code: string;
  submitting: boolean;
}): boolean {
  if (input.submitting) return false;
  if (!isValidServerUrl(input.serverUrl)) return false;
  return isSubmittableCode(input.code);
}
