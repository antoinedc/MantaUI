import { describe, it, expect } from "vitest";
import { isStale, STALE_MS } from "./busConsumer.js";

// M8: the stale-frame liveness decision is deliberately pure so the watchdog's
// threshold is pinned — a half-open stream must reconnect, but a fresh stream
// that is simply between heartbeats must not.
describe("isStale", () => {
  it("is false while frames keep arriving within the staleness window", () => {
    expect(isStale(Date.now(), Date.now(), STALE_MS)).toBe(false);
    expect(isStale(Date.now() - 10_000, Date.now(), STALE_MS)).toBe(false);
    expect(isStale(Date.now() - STALE_MS, Date.now(), STALE_MS)).toBe(false);
  });

  it("is true once no frame has arrived for longer than STALE_MS", () => {
    expect(isStale(Date.now() - STALE_MS - 1, Date.now(), STALE_MS)).toBe(true);
    expect(isStale(Date.now() - 120_000, Date.now(), STALE_MS)).toBe(true);
  });
});
