// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AGE_TICK_MS,
  WORKING_TICK_MS,
  nowMs,
  pinDemoClock,
  useAgeTick,
  useClockTick,
} from "./clock";
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

// Minimal hook harness — the repo has no @testing-library; it mounts with
// react-dom/client + act (see hooks/useSseBus.test.tsx).
function mountHook<T>(hook: () => T): {
  renders: () => number;
  latest: () => T | undefined;
  unmount: () => void;
} {
  let count = 0;
  let latest: T | undefined;
  const Probe = () => {
    count++;
    latest = hook();
    return null;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    renders: () => count,
    latest: () => latest,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("age ticker", () => {
  // THE REGRESSION THIS LOCKS IN: an elapsed-time label reads the clock during
  // render, so without a ticker it only advances when something ELSE
  // re-renders the sidebar. It appeared to work only because the activity
  // poller pushed a fresh status object every 2s — incidental coupling that
  // leaves "1m" frozen at "1m" the moment that stream stops, while the status
  // dot (driven by opencode's own session events) keeps updating.
  it("re-renders subscribers on its own, with no other state change", () => {
    vi.useFakeTimers();
    try {
      const h = mountHook(() => useAgeTick());
      const initial = h.renders();
      act(() => {
        vi.advanceTimersByTime(AGE_TICK_MS * 3);
      });
      expect(h.renders()).toBeGreaterThan(initial);
      h.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops ticking once the last subscriber unmounts", () => {
    vi.useFakeTimers();
    try {
      const h = mountHook(() => useAgeTick());
      act(() => {
        vi.advanceTimersByTime(AGE_TICK_MS);
      });
      const atUnmount = h.latest();
      h.unmount();
      act(() => {
        vi.advanceTimersByTime(AGE_TICK_MS * 5);
      });
      // Version frozen → the shared interval was torn down, not left running.
      const fresh = mountHook(() => useAgeTick());
      expect(fresh.latest()).toBe(atUnmount);
      fresh.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("all rows share ONE interval — N rows cost N re-renders on one tick, not N timers", () => {
    vi.useFakeTimers();
    try {
      const a = mountHook(() => useAgeTick());
      const b = mountHook(() => useAgeTick());
      act(() => {
        vi.advanceTimersByTime(AGE_TICK_MS);
      });
      // Same version → both advanced off the same tick, in step.
      expect(a.latest()).toBe(b.latest());
      a.unmount();
      b.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is bounded well under a minute so a whole-minute label can't lag visibly", () => {
    expect(AGE_TICK_MS).toBeLessThan(60_000);
  });

  it("keeps different intervals on independent tickers, and useAgeTick still ticks at AGE_TICK_MS", () => {
    vi.useFakeTimers();
    try {
      const age = mountHook(() => useAgeTick());
      const work = mountHook(() => useClockTick(WORKING_TICK_MS));
      const age0 = age.latest()!;
      const work0 = work.latest()!;
      // Within the 10s bucket (4.5s) only the 1s bucket fires — independence,
      // not a shared global tick.
      act(() => {
        vi.advanceTimersByTime(4500);
      });
      expect(age.latest()).toBe(age0);
      expect(work.latest()).toBe(work0 + 4);
      // Cross an AGE_TICK_MS boundary: the 10s bucket ticks exactly once.
      act(() => {
        vi.advanceTimersByTime(AGE_TICK_MS - 4500);
      });
      expect(age.latest()).toBe(age0 + 1);
      age.unmount();
      work.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
