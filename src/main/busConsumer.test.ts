import { describe, it, expect } from "vitest";
import { isStale, STALE_MS } from "./busConsumer.js";

// M8: the stale-frame liveness decision is deliberately pure so the watchdog's
// threshold is pinned — a half-open stream must reconnect, but a fresh stream
// that is simply between heartbeats must not.
describe("isStale", () => {
  // A fixed `now`: reading the clock once per call straddled a millisecond tick
  // now and then and made the boundary case flaky.
  const now = 1_000_000_000_000;

  it("is false while frames keep arriving within the staleness window", () => {
    expect(isStale(now, now, STALE_MS)).toBe(false);
    expect(isStale(now - 10_000, now, STALE_MS)).toBe(false);
    expect(isStale(now - STALE_MS, now, STALE_MS)).toBe(false);
  });

  it("is true once no frame has arrived for longer than STALE_MS", () => {
    expect(isStale(now - STALE_MS - 1, now, STALE_MS)).toBe(true);
    expect(isStale(now - 120_000, now, STALE_MS)).toBe(true);
  });
});
