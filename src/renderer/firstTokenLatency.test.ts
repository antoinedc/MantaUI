// firstTokenLatency.test.ts — pin the first-token-latency instrumentation's
// window semantics (BET-553 / §17). Real-clock timing is not asserted (flaky);
// the shape is: one start per (path, session), first-chunk wins, and
// markRendered reports the elapsed ms and clears the start.

import { describe, it, expect, beforeEach } from "vitest";
import {
  markFirstToken,
  markRendered,
  lastMeasurement,
  onMeasurement,
  resetFirstTokenLatency,
} from "./firstTokenLatency";

describe("firstTokenLatency — first token → rendered window", () => {
  beforeEach(() => resetFirstTokenLatency());

  it("starts empty", () => {
    expect(lastMeasurement()).toEqual({ interpreted: null, raw: null });
  });

  it("reports the elapsed ms from first chunk to rendered, per session", () => {
    // Deterministic fake clock: t0 = 1000, rendered at 1900 → 900ms.
    markFirstToken("interpreted", "sess-a", 1000);
    const ms = markRendered("interpreted", "sess-a", 1900);
    expect(ms).toBe(900);
    expect(lastMeasurement()).toEqual({ interpreted: 900, raw: null });
  });

  it("keeps only the first chunk in the window (not later chunks)", () => {
    // Three flushes for the same turn before render: only the first sets t0.
    markFirstToken("interpreted", "sess-a", 1000);
    markFirstToken("interpreted", "sess-a", 1100); // ignored — 1000 already wins
    markFirstToken("interpreted", "sess-a", 1200); // ignored
    const ms = markRendered("interpreted", "sess-a", 1900);
    expect(ms).toBe(900); // 1900 − 1000, not 1900 − 1200
  });

  it("keys per-path — interpreted and raw do not collide and both are readable", () => {
    markFirstToken("interpreted", "sess-a", 500);
    markFirstToken("raw", "sess-a", 700);
    expect(markRendered("raw", "sess-a", 900)).toBe(200);
    expect(markRendered("interpreted", "sess-a", 1500)).toBe(1000);
    expect(lastMeasurement()).toEqual({ interpreted: 1000, raw: 200 });
  });

  it("returns null when rendering without a recorded start", () => {
    expect(markRendered("interpreted", "sess-unknown", 1000)).toBeNull();
    markFirstToken("interpreted", "sess-a", 10);
    expect(markRendered("interpreted", "sess-a", 20)).toBe(10);
    expect(markRendered("interpreted", "sess-a", 30)).toBeNull();
  });

  it("reset clears starts, per-path measurements and observers", () => {
    markFirstToken("interpreted", "sess-a", 10);
    markRendered("interpreted", "sess-a", 20);
    resetFirstTokenLatency();
    expect(markRendered("interpreted", "sess-a", 99)).toBeNull();
    expect(lastMeasurement()).toEqual({ interpreted: null, raw: null });
    const seen: Array<unknown> = [];
    onMeasurement((m) => seen.push(m));
    resetFirstTokenLatency();
    markFirstToken("interpreted", "sess-a", 1);
    markRendered("interpreted", "sess-a", 2);
    expect(seen).toEqual([]);
  });
});
