import { afterEach, describe, expect, it } from "vitest";
import { nowMs, pinDemoClock } from "./clock";
import { useStore } from "./store";
import { DEMO_T0 } from "./api/demoFixture";

afterEach(() => {
  useStore.setState({ videoRenderNow: null });
});

describe("renderer clock seam", () => {
  it("falls back to the wall clock when nothing pinned it", () => {
    const before = Date.now();
    const now = nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("returns the pinned instant once pinned", () => {
    pinDemoClock(DEMO_T0);
    expect(nowMs()).toBe(DEMO_T0);
    // Stable across calls — the point is that a capture taken a day later
    // renders identical elapsed labels.
    expect(nowMs()).toBe(DEMO_T0);
  });

  it("makes every fixture elapsed label a function of the fixture, not today", () => {
    // The bug this guards: with a live clock, `nowMs() - lastMessageAt` for a
    // fixture anchored at DEMO_T0 renders the distance from the anchor to
    // TODAY, so it grows by one day every day and expires every committed
    // capture (marketing shots + visual baselines) at the next day boundary.
    pinDemoClock(DEMO_T0);
    const fixtureEvent = DEMO_T0 - 14 * 60_000;
    expect(nowMs() - fixtureEvent).toBe(14 * 60_000);
  });
});
