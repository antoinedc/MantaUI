// claimRetry.test.ts — tests for the BET-705 §c claim auto-retry loop.

import { describe, it, expect, vi } from "vitest";
import type { ClaimOutcome } from "../shared/claim.mjs";
import {
  claimWithRetry,
  isTransientClaimFailure,
  CLAIM_RETRY_DELAY_MS,
  CLAIM_RETRY_TOTAL_MS,
  type ClaimRetryDeps,
} from "./claimRetry";

function okOutcome(): ClaimOutcome {
  return { ok: true, boxId: "a".repeat(32), boxToken: "b".repeat(32) };
}
type FailureKind = Extract<ClaimOutcome, { ok: false }>["kind"];

function fail(kind: FailureKind): ClaimOutcome {
  return { ok: false, kind, message: "x" } as ClaimOutcome & { ok: false };
}

function makeClock(): { deps: ClaimRetryDeps; t: { value: number } } {
  const t = { value: 0 };
  const deps: ClaimRetryDeps = {
    sleep: async (ms) => {
      t.value += ms;
    },
    now: () => t.value,
  };
  return { deps, t };
}

describe("claimWithRetry (BET-705 c)", () => {
  it("transient failure → retries → succeeds on the next attempt", async () => {
    const { deps } = makeClock();
    const attempt = vi
      .fn<() => Promise<ClaimOutcome>>()
      .mockResolvedValueOnce(fail("network"))
      .mockResolvedValueOnce(okOutcome());
    const { outcome, elapsedMs } = await claimWithRetry(attempt, deps);
    expect(outcome.ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBe(CLAIM_RETRY_DELAY_MS);
    // The single retry wait advanced the injected clock by one delay.
    expect(deps.now()).toBe(CLAIM_RETRY_DELAY_MS);
  });

  it("transient forever → gives up once the 45s budget is exhausted", async () => {
    const { deps } = makeClock();
    const attempt = vi.fn(async () => fail("server_error"));
    const { outcome, elapsedMs } = await claimWithRetry(attempt, deps);
    expect(outcome.ok).toBe(false);
    // Attempt 0 runs at t=0, and one more attempt per delay while under budget.
    const expectedAttempts = Math.floor(CLAIM_RETRY_TOTAL_MS / CLAIM_RETRY_DELAY_MS) + 1;
    expect(attempt).toHaveBeenCalledTimes(expectedAttempts);
    expect(elapsedMs).toBeLessThanOrEqual(CLAIM_RETRY_TOTAL_MS + CLAIM_RETRY_DELAY_MS);
    // The last attempt happened after the budget was effectively reached.
    expect(elapsedMs).toBeGreaterThanOrEqual(CLAIM_RETRY_TOTAL_MS);
  });

  it("non-transient failure → no retry", async () => {
    const { deps } = makeClock();
    const attempt = vi.fn(async () => fail("wrong_code"));
    const { outcome, elapsedMs } = await claimWithRetry(attempt, deps);
    expect(outcome.ok).toBe(false);
    expect((outcome as { kind: string }).kind).toBe("wrong_code");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(0);
  });
});

describe("isTransientClaimFailure", () => {
  it("true only for network and server_error", () => {
    expect(isTransientClaimFailure(fail("network"))).toBe(true);
    expect(isTransientClaimFailure(fail("server_error"))).toBe(true);
    expect(isTransientClaimFailure(fail("wrong_code"))).toBe(false);
    expect(isTransientClaimFailure(fail("rate_limited"))).toBe(false);
    expect(isTransientClaimFailure(fail("invalid_response"))).toBe(false);
    expect(isTransientClaimFailure(okOutcome())).toBe(false);
  });
});
