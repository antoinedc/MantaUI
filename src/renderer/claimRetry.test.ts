import { describe, expect, it } from "vitest";
import {
  CLAIM_TRANSIENT_ATTEMPTS,
  CLAIM_TRANSIENT_DELAY_MS,
  shouldRetryClaim,
} from "./claimRetry";

describe("shouldRetryClaim", () => {
  it("retries transient failures (network, server_error)", () => {
    expect(shouldRetryClaim("network")).toBe(true);
    expect(shouldRetryClaim("server_error")).toBe(true);
  });

  it("fails immediately on non-transient failures", () => {
    expect(shouldRetryClaim("wrong_code")).toBe(false);
    expect(shouldRetryClaim("rate_limited")).toBe(false);
    expect(shouldRetryClaim("invalid_response")).toBe(false);
  });

  it("bounds the window at ~20s (5 attempts, 4s apart), not the old 45s pump", () => {
    expect(CLAIM_TRANSIENT_ATTEMPTS).toBe(5);
    expect(CLAIM_TRANSIENT_DELAY_MS).toBe(4000);
  });
});
