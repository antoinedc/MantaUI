import { describe, it, expect } from "vitest";
import { blendedPrice, mixFromCounts, DEFAULT_MIX } from "./blendedPrice.mjs";
import type { BlendedCost, BlendedModel } from "./blendedPrice.mjs";

// Shorthand model builders. `cost` is omitted by default so each test can pass
// exactly what it wants.
function model(cost?: BlendedCost): BlendedModel {
  return cost === undefined ? {} : { cost };
}

describe("blendedPrice — the headline case", () => {
  it("a model with a cache discount is materially cheaper than one without, at identical input/output", () => {
    // Two endpoints quote the same input/output (5 / 25). One publishes a
    // cache read discount (0.5), the other publishes none (missing → full
    // input rate). This is the case an input+output sum gets backwards.
    const withDiscount = blendedPrice(model({ input: 5, output: 25, cacheRead: 0.5 }));
    const noDiscount = blendedPrice(model({ input: 5, output: 25 }));
    expect(withDiscount.price).toBeLessThan(noDiscount.price);
    expect(withDiscount.known).toBe(true);
    expect(noDiscount.known).toBe(true);
  });

  it("declared cacheRead: 0 is cheaper than cacheRead missing (unknown → full input rate)", () => {
    const declaredZero = blendedPrice(model({ input: 5, output: 25, cacheRead: 0 }));
    const missing = blendedPrice(model({ input: 5, output: 25 }));
    expect(declaredZero.price).toBeLessThan(missing.price);
  });
});

describe("blendedPrice — declared free vs implausible zero", () => {
  it("a declared-free model with no reference is price 0, known true", () => {
    const res = blendedPrice(model({ input: 0, output: 0 }));
    expect(res).toEqual({ price: 0, known: true, mixSource: "default", reference: "absent" });
  });

  it("implausible zero (input 0, output 0) with a priced reference is known false and returns the reference price", () => {
    const res = blendedPrice(model({ input: 0, output: 0 }), undefined, { input: 5, output: 25 });
    expect(res.known).toBe(false);
    expect(res.price).toBe(30); // reference.input + reference.output
  });

  it("only fires the implausible-zero rule when a reference is supplied", () => {
    expect(blendedPrice(model({ input: 0, output: 0 })).known).toBe(true);
  });
});

describe("blendedPrice — missing data", () => {
  it("no cost at all → known false, price 0 with no reference", () => {
    const res = blendedPrice(model());
    expect(res.known).toBe(false);
    expect(res.price).toBe(0);
  });

  it("no cost at all → known false, returns reference price when given", () => {
    const res = blendedPrice(model(), undefined, { input: 5, output: 25 });
    expect(res.known).toBe(false);
    expect(res.price).toBe(30);
  });

  it("a missing input or output rate makes the whole price unknown", () => {
    expect(blendedPrice(model({ input: 5 })).known).toBe(false);
    expect(blendedPrice(model({ output: 25 })).known).toBe(false);
  });
});

describe("blendedPrice — mix normalization", () => {
  it("a mix that does not sum to 1 is rescaled to the same result as its normalised form", () => {
    const raw = { input: 0.4, output: 0.25, cacheRead: 0.2, cacheWrite: 0.15 }; // sums to 1.0
    const scaled = { input: 4, output: 2.5, cacheRead: 2, cacheWrite: 1.5 }; // sums to 10
    const m = model({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(blendedPrice(m, raw).price).toBeCloseTo(blendedPrice(m, scaled).price, 10);
  });

  it("no mix uses DEFAULT_MIX, which is cache-heavy", () => {
    expect(DEFAULT_MIX.cacheRead).toBeGreaterThan(DEFAULT_MIX.input + DEFAULT_MIX.output);
    expect(Object.values(DEFAULT_MIX).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe("blendedPrice — degenerate input is finite and non-negative", () => {
  it.each([
    ["empty object", () => model(), {}],
    ["null", () => null, {}],
    ["NaN rates", () => model({ input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN }), {}],
    ["negative rates", () => model({ input: -5, output: -25, cacheRead: -1 }), {}],
  ])("%s", (_name, build, mix) => {
    const res = blendedPrice(build(), mix);
    expect(typeof res.price).toBe("number");
    expect(Number.isFinite(res.price)).toBe(true);
    expect(res.price).toBeGreaterThanOrEqual(0);
  });
});

describe("blendedPrice — source flags (BET-1265)", () => {
  it("reports a default mix and absent reference when neither is supplied", () => {
    const res = blendedPrice(model({ input: 5, output: 25 }));
    expect(res.mixSource).toBe("default");
    expect(res.reference).toBe("absent");
  });

  it("reports measured + catalogue when a usable mix and a reference are supplied", () => {
    const res = blendedPrice(model({ input: 5, output: 25 }), { input: 0.5, output: 0.1, cacheRead: 0.3, cacheWrite: 0.1 }, { input: 5, output: 25 });
    expect(res.mixSource).toBe("measured");
    expect(res.reference).toBe("catalogue");
  });

  it("an all-zero mix falls back to default and reports it", () => {
    const res = blendedPrice(model({ input: 5, output: 25 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(res.mixSource).toBe("default");
  });

  it("the unknown-price early return carries both flags too", () => {
    const res = blendedPrice(model({ input: 5 }), undefined, { input: 5, output: 25 });
    expect(res.known).toBe(false);
    expect(res.mixSource).toBe("default");
    expect(res.reference).toBe("catalogue");
  });
});

describe("mixFromCounts", () => {
  it("turns raw token counts into fractions of the total", () => {
    const m = mixFromCounts({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    expect(m.input).toBeCloseTo(0.25, 10);
    expect(Object.values(m).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("all-zero counts return DEFAULT_MIX (no division by zero)", () => {
    const m = mixFromCounts({ input: 0, output: 0 });
    expect(m).toEqual({ ...DEFAULT_MIX });
  });

  it("undefined counts are treated as zero / safe on empty input", () => {
    expect(mixFromCounts()).toEqual({ ...DEFAULT_MIX });
  });
});
