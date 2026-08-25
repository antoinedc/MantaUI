import { describe, it, expect } from "vitest";
import {
  seedDeficit,
  advanceDeficit,
  shadowPrice,
  ecoLevel,
  protectionActive,
  quantile,
  OPTIMIZER_LYAPUNOV_V,
  PROTECTION_QUANTILE,
  PROTECTION_LAMBDA_MULTIPLIER,
  MIN_TOKENS_PER_PCT_SAMPLE,
  ECO_THRESHOLDS,
} from "./quotaPressure.mjs";

describe("seedDeficit — closed form at elapsed fractions", () => {
  // A 100-hour window from t=0 to t=100h.
  const SPAN = 100 * 60 * 60 * 1000;
  const startedAt = 0;
  const resetsAt = SPAN;

  it("0% elapsed, any pct -> deficit is that pct (nothing drained yet)", () => {
    // elapsed 0 → pct - 0 = pct.
    expect(seedDeficit({ pct: 30, startedAt, resetsAt, now: 0 })).toBeCloseTo(30, 6);
    expect(seedDeficit({ pct: 0, startedAt, resetsAt, now: 0 })).toBeCloseTo(0, 6);
  });

  it("50% elapsed -> pct - 50, clamped at 0", () => {
    const now = SPAN / 2;
    expect(seedDeficit({ pct: 80, startedAt, resetsAt, now })).toBeCloseTo(30, 6); // 80 - 50
    expect(seedDeficit({ pct: 40, startedAt, resetsAt, now })).toBeCloseTo(0, 6); // 40 - 50 → 0
  });

  it("100% elapsed -> pct - 100, clamped at 0", () => {
    const now = SPAN;
    expect(seedDeficit({ pct: 90, startedAt, resetsAt, now })).toBeCloseTo(0, 6); // 90 - 100 → 0
    expect(seedDeficit({ pct: 100, startedAt, resetsAt, now })).toBeCloseTo(0, 6); // exactly full → 0
  });

  it("unusable timestamps -> 0 (never guess a start time)", () => {
    expect(seedDeficit({ pct: 50, startedAt: undefined, resetsAt, now: 1 })).toBe(0);
    expect(seedDeficit({ pct: 50, startedAt, resetsAt: undefined, now: 1 })).toBe(0);
    expect(seedDeficit({ pct: 50, startedAt, resetsAt, now: undefined })).toBe(0);
    expect(seedDeficit({})).toBe(0);
  });
});

describe("advanceDeficit — the accumulator step", () => {
  it("accumulates over pace -> Q grows", () => {
    // Window resets 1000ms after prevNow. rate = (100-50)/1000 = 0.05/ms.
    // Over a 500ms step the drain is 25 pct-points; pct jumps 50→80 (delta 30).
    const Q = advanceDeficit({
      prev: 0,
      pct: 80,
      prevPct: 50,
      resetsAt: 1000 + 0, // prevNow=0 → resets in 1000ms
      now: 500,
      prevNow: 0,
    });
    expect(Q).toBeCloseTo(30 - 25, 6); // 5
  });

  it("under pace -> clamped at 0 (the discount regime never goes negative)", () => {
    // Same window; pct jumps 50→60 (delta 10) vs drain 25 → -15, clamped 0.
    const Q = advanceDeficit({
      prev: 0,
      pct: 60,
      prevPct: 50,
      resetsAt: 1000,
      now: 500,
      prevNow: 0,
    });
    expect(Q).toBe(0);
  });

  it("on pace (pct growth == drain) keeps Q constant", () => {
    // rate=(100-50)/1000=0.05/ms; over 500ms drain=25. pct 50→75 (delta 25).
    const Q = advanceDeficit({
      prev: 10,
      pct: 75,
      prevPct: 50,
      resetsAt: 1000,
      now: 500,
      prevNow: 0,
    });
    expect(Q).toBeCloseTo(10, 6);
  });

  it("clamps to [0, 100]", () => {
    const high = advanceDeficit({
      prev: 95,
      pct: 100,
      prevPct: 0,
      resetsAt: 1e9,
      now: 1,
      prevNow: 0,
    });
    expect(high).toBe(100);
    const low = advanceDeficit({ prev: 5, pct: 10, prevPct: 90, resetsAt: 10, now: 9, prevNow: 0 });
    expect(low).toBe(0);
  });
});

describe("shadowPrice", () => {
  it("zero at and below pace (deficit <= 0)", () => {
    expect(shadowPrice(0)).toBe(0);
    expect(shadowPrice(-5)).toBe(0);
  });

  it("= deficit / V above pace", () => {
    expect(shadowPrice(25)).toBeCloseTo(1, 6); // V=25 makes lambda 1 at 25 pct-points
    expect(shadowPrice(12.5)).toBeCloseTo(0.5, 6);
    expect(shadowPrice(50)).toBeCloseTo(2, 6);
  });
});

describe("ecoLevel — boundaries and monotonicity", () => {
  it("boundaries at exactly 10, 25, 40", () => {
    expect(ecoLevel(9)).toBe(0);
    expect(ecoLevel(10)).toBe(1);
    expect(ecoLevel(24)).toBe(1);
    expect(ecoLevel(25)).toBe(2);
    expect(ecoLevel(39)).toBe(2);
    expect(ecoLevel(40)).toBe(3);
    expect(ecoLevel(100)).toBe(3);
  });

  it("monotonic non-decreasing over a swept range", () => {
    let prev = -1;
    for (let d = 0; d <= 120; d += 0.5) {
      const lvl = ecoLevel(d);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });
});

describe("protectionActive — the newsvendor protection level", () => {
  // 8+ rates gives the confidence the quantile needs.
  const rates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("false with fewer than 8 rate samples", () => {
    expect(protectionActive({ rates: rates.slice(0, 7), hoursUntilReset: 10, remainingPct: 5 })).toBe(false);
    expect(protectionActive({ rates: [], hoursUntilReset: 10, remainingPct: 5 })).toBe(false);
  });

  it("true/false around the 0.65 quantile", () => {
    // sorted rates [1..10]; q=0.65 → idx=floor(9*0.65)=floor(5.85)=5 → value 6.
    // budget = 6 * hoursUntilReset. With hoursUntilReset=2, budget=12.
    // remainingPct 12 → true (<=); remainingPct 13 → false.
    const hours = 2;
    expect(protectionActive({ rates, hoursUntilReset: hours, remainingPct: 12 })).toBe(true);
    expect(protectionActive({ rates, hoursUntilReset: hours, remainingPct: 13 })).toBe(false);
  });

  it("true when there is essentially no budget left at all", () => {
    expect(protectionActive({ rates, hoursUntilReset: 5, remainingPct: 0 })).toBe(true);
  });
});

describe("exports sanity", () => {
  it("PROTECTION_QUANTILE = 1 - v_low/v_high", () => {
    expect(PROTECTION_QUANTILE).toBeCloseTo(0.65, 6);
    expect(PROTECTION_LAMBDA_MULTIPLIER).toBe(3);
    expect(MIN_TOKENS_PER_PCT_SAMPLE).toBe(5);
    expect(OPTIMIZER_LYAPUNOV_V).toBe(25);
    expect(ECO_THRESHOLDS).toEqual([10, 25, 40]);
  });

  it("quantile returns the element at the linear-approach index", () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(Math.round((4 - 1) * 0.5) === 1 ? 2 : 2); // idx floor(3*.5)=1
    expect(quantile([], 0.5)).toBe(null);
  });
});
