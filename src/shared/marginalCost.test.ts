import { describe, it, expect } from "vitest";
import {
  marginalCost,
  depletionFactor,
  CREDIT_PREMIUM,
  RESET_RAMP_MS,
} from "./marginalCost.mjs";
import type { AccountState, MargCostModel } from "./marginalCost.mjs";

// Every cost input/output rate here is 15, so the blended price is exactly
// $15 / 1M regardless of mix (missing cache rates bill at the input rate).
// That gives tests a clean, legible exchange-rate anchor.
const MODEL: MargCostModel = { cost: { input: 15, output: 15 } };

type Window = NonNullable<NonNullable<AccountState["windows"]>[number]>;

function sub(win: Window | Window[]): AccountState {
  const windows = Array.isArray(win) ? win : [win];
  return { kind: "subscription", windows };
}

function w(pct: number, startedAt: number, resetsAt: number): Window {
  return { pct, startedAt, resetsAt };
}

function credit(balance?: number): AccountState {
  return balance === undefined ? { kind: "credit" } : { kind: "credit", balance };
}

// A window that is comfortably far from reset: `resetsAt - nowMs === RESET_RAMP_MS`,
// so the near-reset damp is exactly 1 and does not interfere with pacing tests.
const R = RESET_RAMP_MS;
// nowMs is fixed at 0 for every pacing test; windows are positioned by their
// start/reset times.

const EXCHANGE = 15;

describe("marginalCost — subscription pacing", () => {
  it("under pace ≈ free: 20% consumed / 60% elapsed → far below the exchange rate", () => {
    // elapsed 0.6, resetsAt = R (damp 1). pace = 0.2/0.6 = 0.333 → cost = 15 * 0.111.
    const res = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(20, -1.5 * R, R)) });
    expect(res.exhausted).toBe(false);
    expect(res.cost).toBeGreaterThan(0);
    expect(res.cost).toBeLessThan(EXCHANGE * 0.15); // ~1.67, vs exchange 15
    expect(Number.isFinite(res.cost)).toBe(true);
  });

  it("pace, not fill: same pct at two different elapsed values → materially different costs", () => {
    // pct 60 fixed. elapsed 0.2 → pace 3 (over); elapsed 0.6 → pace 1 (on pace).
    const fast = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(60, -0.25 * R, R)) });
    const slow = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(60, -1.5 * R, R)) });
    // 15*9 = 135 vs 15*1 = 15 — a gauge reading pct alone would say they're equal.
    expect(fast.cost).toBeGreaterThan(slow.cost * 5);
    expect(slow.cost).toBeCloseTo(EXCHANGE, 3);
  });

  it("over pace rises: 80% consumed / 30% elapsed → above the exchange rate", () => {
    // pace = 0.8/0.3 = 2.667 → cost = 15 * 7.11 ≈ 106.7.
    const res = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(80, -0.4286 * R, R)) });
    expect(res.cost).toBeGreaterThan(EXCHANGE);
    expect(res.cost).toBeCloseTo(106.7, 1);
  });

  it("on pace = exchange rate, within tolerance", () => {
    // pace = 0.6/0.6 = 1 → cost is exactly the exchange rate (15).
    const res = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(60, -1.5 * R, R)) });
    expect(res.cost).toBeCloseTo(EXCHANGE, 5);
  });

  it("binding window wins: the scarcer of two windows determines the result", () => {
    // Window 1: pace 0.5 → 3.75. Window 2: pace 2.667 → 106.7 (the binding one).
    const res = marginalCost({
      model: MODEL,
      nowMs: 0,
      replacementCost: EXCHANGE,
      account: sub([w(30, -1.5 * R, R), w(80, -0.4286 * R, R)]),
    });
    expect(res.exhausted).toBe(false);
    expect(res.cost).toBeCloseTo(106.7, 1);
  });

  it("near reset is cheap: same pace, resetsAt imminent → cheaper", () => {
    // Both pace 1 (consumed 0.5 / elapsed 0.5). Far window: damp 1 → 15.
    // Near window: resetsAt = 0.1R → damp 0.1 → 1.5. Same pace, same fill.
    const far = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(50, -1 * R, R)) });
    const near = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(50, -0.1 * R, 0.1 * R)) });
    expect(near.cost).toBeLessThan(far.cost);
    expect(far.cost).toBeCloseTo(EXCHANGE, 3);
    expect(near.cost).toBeCloseTo(EXCHANGE * 0.1, 3);
  });

  it("startedAt missing → falls back to consumed alone and says so in basis", () => {
    const res = marginalCost({
      model: MODEL,
      nowMs: 0,
      replacementCost: EXCHANGE,
      account: {
        kind: "subscription",
        windows: [{ pct: 50, resetsAt: R }], // no startedAt
      },
    });
    expect(res.basis).toBe("subscription-consumed");
    // consumed 0.5, treated as pace → 15 * 0.25 = 3.75 (damp 1).
    expect(res.cost).toBeCloseTo(EXCHANGE * 0.25, 3);
  });
});

describe("marginalCost — credit", () => {
  it("depleting credit rises: balance 100 → 10 → 1 is monotonically more expensive", () => {
    const c100 = marginalCost({ model: MODEL, nowMs: 0, account: credit(100) });
    const c10 = marginalCost({ model: MODEL, nowMs: 0, account: credit(10) });
    const c1 = marginalCost({ model: MODEL, nowMs: 0, account: credit(1) });
    expect(c1.cost).toBeGreaterThan(c10.cost);
    expect(c10.cost).toBeGreaterThan(c100.cost);
    expect(Number.isFinite(c1.cost)).toBe(true);
  });

  it("no balance reading → factor 1, priced at its declared rate", () => {
    expect(depletionFactor(undefined)).toBe(1);
    const res = marginalCost({ model: MODEL, nowMs: 0, account: credit() });
    expect(res.cost).toBeCloseTo(EXCHANGE * CREDIT_PREMIUM, 5); // blended × premium, no depletion
    // rank independence: unrelated inputs (replacementCost is subscription-only)
    // must not move the credit cost.
    const withUnrelated = marginalCost({ model: MODEL, nowMs: 0, account: credit(), replacementCost: 999 });
    expect(withUnrelated.cost).toBeCloseTo(res.cost, 10);
  });

  it("a negative balance is overdrawn, not a small positive number", () => {
    const negative = marginalCost({ model: MODEL, nowMs: 0, account: credit(-0.57) });
    const tinyPositive = marginalCost({ model: MODEL, nowMs: 0, account: credit(0.01) });
    expect(negative.exhausted).toBe(true);
    expect(negative.cost).toBe(Infinity);
    expect(tinyPositive.exhausted).toBe(false);
    expect(tinyPositive.cost).toBeLessThan(Infinity);
  });
});

describe("marginalCost — the asymmetry (subscription < credit at equal scarcity)", () => {
  it("at equal scarcity a subscription costs less than a credit balance, every time", () => {
    // Subscription on-pace (pace 1) = exchange rate 15.
    const subRes = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(60, -1.5 * R, R)) });
    expect(subRes.cost).toBeCloseTo(EXCHANGE, 5);

    // A credit balance, even one at unit depletion (huge balance), must cost more.
    for (const balance of [1e9, 100, 10, 1, 0.5]) {
      const creditRes = marginalCost({ model: MODEL, nowMs: 0, account: credit(balance) });
      expect(creditRes.exhausted).toBe(false);
      expect(subRes.cost).toBeLessThan(creditRes.cost);
    }

    // At matching neutral scarcity the gap is exactly the named premium — this
    // pins CREDIT_PREMIUM as the mechanism, not an accident of curve shape.
    const neutralCredit = marginalCost({ model: MODEL, nowMs: 0, account: credit(1e9) });
    expect(neutralCredit.cost / subRes.cost).toBeCloseTo(CREDIT_PREMIUM, 5);
  });
});

describe("marginalCost — exhausted first", () => {
  it("each exhausted signal returns exhausted:true and cost Infinity", () => {
    const byFlag = marginalCost({ model: MODEL, nowMs: 0, account: { kind: "credit", balance: 50, exhausted: true } });
    const byPct = marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(100, -1.5 * R, R)) });
    const byZero = marginalCost({ model: MODEL, nowMs: 0, account: credit(0) });
    const byNegative = marginalCost({ model: MODEL, nowMs: 0, account: credit(-0.57) });

    for (const res of [byFlag, byPct, byZero, byNegative]) {
      expect(res.exhausted).toBe(true);
      expect(res.cost).toBe(Infinity);
      expect(res.basis).toBe("exhausted");
    }
  });

  it("every non-exhausted return is finite and ≥ 0; Infinity appears only on exhaustion", () => {
    const cases = [
      marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(20, -1.5 * R, R)) }),
      marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(60, -1.5 * R, R)) }),
      marginalCost({ model: MODEL, nowMs: 0, replacementCost: EXCHANGE, account: sub(w(80, -0.4286 * R, R)) }),
      marginalCost({ model: MODEL, nowMs: 0, account: credit(10) }),
      marginalCost({ model: MODEL, nowMs: 0, account: credit() }),
      marginalCost({ model: MODEL, nowMs: 0, account: { kind: "none" } }),
      marginalCost({ model: MODEL, nowMs: 0, account: null }),
    ];
    for (const res of cases) {
      expect(res.exhausted).toBe(false);
      expect(res.cost).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(res.cost)).toBe(true);
    }
  });
});
