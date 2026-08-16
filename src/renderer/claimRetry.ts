// claimRetry.ts — bounded transient-retry policy for the onboarding auto-claim.
//
// A FRESH install mints a NEW box_id and registers a NEW public hostname with
// the gateway; it takes a couple of seconds for that hostname to become
// reachable (gateway + Caddy propagation). The desktop auto-claim fires
// immediately after install and, on the first try, can hit that window and
// fail transiently (BET-1002). That transient failure surfaces as a
// `network` or `server_error` ClaimFailureKind — exactly the ones this module
// says may be retried.
//
// Deliberately NOT in src/shared/claim.mjs (which classifies outcomes): this is
// a renderer-only retry budget on top of a single claim, and claim.mjs is
// shared with the manual PairStep path, which must not change. Pure + tested.

import type { ClaimFailureKind } from "../shared/claim.mjs";

// How many total attempts the auto-claim makes (the first attempt plus up to
// four retries).
export const CLAIM_TRANSIENT_ATTEMPTS = 5;

// Fixed delay between transient-failure retries.
export const CLAIM_TRANSIENT_DELAY_MS = 4000;

/**
 * True when a failed claim is transient and worth retrying. A fresh install's
 * provisioning window (gateway + Caddy propagation) shows up as a network
 * failure ("Couldn't reach the server…") or a server_error ("The server had a
 * problem. Try again."). A non-transient failure (wrong code, malformed
 * response, rate limit) must fail immediately — never retry a wrong code.
 */
export function shouldRetryClaim(kind: ClaimFailureKind): boolean {
  return kind === "network" || kind === "server_error";
}
