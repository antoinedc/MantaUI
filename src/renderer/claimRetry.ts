// claimRetry.ts — pure helpers for the SSH installer's auto-claim retry loop
// (BET-705 §c).
//
// The box's `manta pair` mints the code the moment the install process exits,
// and the auto-claim fires immediately after — so the first claim can race a
// box service that isn't listening on loopback yet. A few seconds of waiting
// usually fixes it, but only TRANSIENT failure kinds (the box service not
// ready) are worth retrying: a wrong/expired code or a malformed response
// won't change by waiting, and retrying it just delays the real error.
//
// This module is pure (injected sleep/now/attempt) so the retry policy is
// unit-testable without a real claim, clock, or Electron bridge.

import type { ClaimOutcome } from "../shared/claim.mjs";

// How long to wait between transient-failure claim retries.
export const CLAIM_RETRY_DELAY_MS = 3_000;

// Total budget for retrying a transient claim failure before giving up and
// surfacing the real error. The box service can legitimately take a while to
// come up; beyond this the user should drop to the manual `manta pair` path.
export const CLAIM_RETRY_TOTAL_MS = 45_000;

/**
 * True when a failed claim might be fixed by waiting — i.e. the box service
 * isn't up yet, not that the pairing code or response is wrong.
 */
export function isTransientClaimFailure(outcome: ClaimOutcome): boolean {
  return !outcome.ok && (outcome.kind === "network" || outcome.kind === "server_error");
}

/** Injectables so the retry loop's clock + wait are test-controllable. */
export type ClaimRetryDeps = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type ClaimRetryResult = {
  /** The final outcome — `ok` on success, or the last failure after giving up. */
  outcome: ClaimOutcome;
  /** Total wall-clock time spent across all attempts, in ms. */
  elapsedMs: number;
};

/**
 * Run the claim, retrying on transient failures every CLAIM_RETRY_DELAY_MS up
 * to CLAIM_RETRY_TOTAL_MS of total budget. Returns the first `ok` outcome, or
 * the last non-transient outcome / the final transient outcome once the budget
 * is exhausted. Non-transient failures are never retried.
 */
export async function claimWithRetry(
  attempt: (n: number) => Promise<ClaimOutcome>,
  deps: ClaimRetryDeps,
): Promise<ClaimRetryResult> {
  const start = deps.now();
  let outcome = await attempt(0);
  let n = 0;
  while (!outcome.ok && isTransientClaimFailure(outcome)) {
    if (deps.now() - start >= CLAIM_RETRY_TOTAL_MS) break;
    await deps.sleep(CLAIM_RETRY_DELAY_MS);
    n += 1;
    outcome = await attempt(n);
  }
  return { outcome, elapsedMs: deps.now() - start };
}
