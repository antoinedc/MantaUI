import { describe, it, expect } from "vitest";
import { promptSideRate, savedUsd } from "./optimizerSavings.mjs";
import type { PromptSideRate } from "./optimizerSavings.mjs";

// The DEFAULT_MIX prompt-side weights, renormalised to input/cacheRead/cacheWrite
// only: input 0.08, cacheRead 0.8, cacheWrite 0.07 → /0.95.
const W_INPUT = 0.08 / 0.95;
const W_READ = 0.8 / 0.95;
const W_WRITE = 0.07 / 0.95;

// Anthropic catalogue prices ($/Mtok) — the numbers from the BET-1370 worked
// maths. cacheWrite == input, cacheRead = input/10.
const S = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 }; // Sonnet
const H = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 }; // Haiku

// With the DEFAULT_MIX these must reproduce the issue's worked figures.
const expectedSonnet = 3 * W_INPUT + 0.3 * W_READ + 3 * W_WRITE;
const expectedHaiku = 1 * W_INPUT + 0.1 * W_READ + 1 * W_WRITE;

describe("promptSideRate", () => {
  it("reproduces the worked Sonnet figure (~$0.78/Mtok) with the default mix", () => {
    const r = promptSideRate(S);
    expect(r.known).toBe(true);
    expect(r.rate).toBeCloseTo(expectedSonnet, 6);
    expect(r.rate).toBeGreaterThan(0.7);
    expect(r.rate).toBeLessThan(0.85);
  });

  it("replicates the DEFAULT_MIX blended-price figures — Haiku is a tenth of Sonnet's cacheRead, so a fraction of Sonnet", () => {
    const s = promptSideRate(S);
    const h = promptSideRate(H);
    expect(h.known).toBe(true);
    expect(h.rate).toBeCloseTo(expectedHaiku, 6);
    expect(h.rate).toBeLessThan(s.rate);
  });

  it("a removed token is never billed as output: the rate uses only input/cacheRead/cacheWrite", () => {
    // If output were (wrongly) included the rate would approach output*0.05;
    // the prompt-side rate stays on the three cheap buckets no matter how
    // expensive output is.
    const pricey = { input: 3, output: 300, cacheRead: 0.3, cacheWrite: 3 };
    const r = promptSideRate(pricey);
    expect(r.rate).toBeCloseTo(expectedSonnet, 6);
  });

  it("missing cacheWrite/cacheRead bill at the full input rate, matching blendedPrice", () => {
    const r = promptSideRate({ input: 3, output: 300 }); // no cache rates
    expect(r.known).toBe(true);
    expect(r.rate).toBeCloseTo(3, 6); // all three prompt buckets at input rate
    expect(r.cacheRead).toBe(3);
    expect(r.cacheWrite).toBe(3);
  });

  it("a declared 0 cache rate stays 0 (free, distinct from unknown → full input)", () => {
    const free = promptSideRate({ input: 3, output: 300, cacheRead: 0, cacheWrite: 0 });
    const missing = promptSideRate({ input: 3, output: 300 });
    expect(free.cacheRead).toBe(0);
    expect(free.cacheWrite).toBe(0);
    expect(free.rate).toBeLessThan(missing.rate);
    expect(free.known).toBe(true);
  });

  it("unknown (missing/non-finite/negative) input → known false, never treated as free", () => {
    expect(promptSideRate({}).known).toBe(false);
    expect(promptSideRate({ input: Number.NaN, output: 10 }).known).toBe(false);
    expect(promptSideRate({ input: -5, output: 10 }).known).toBe(false);
    expect(promptSideRate({ input: 0, output: 0 }).known).toBe(true); // declared free IS known
  });

  it("a degenerate or missing mix falls back to the default prompt-side weights", () => {
    const withDefault = promptSideRate(S);
    const degenerate = promptSideRate(S, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const absent = promptSideRate(S, undefined);
    expect(degenerate.rate).toBeCloseTo(withDefault.rate, 9);
    expect(absent.rate).toBeCloseTo(withDefault.rate, 9);
  });

  it("a measured read-heavy mix shifts the rate down toward cacheRead", () => {
    const r = promptSideRate(S, { input: 0.1, output: 0.1, cacheRead: 0.8, cacheWrite: 0.0 });
    expect(r.rate).toBeLessThan(promptSideRate(S).rate);
  });
});

describe("savedUsd", () => {
  const rates = (m: PromptSideRate) => ({ "claude/sonnet": m });

  it("prices a single known model's token-turns at its prompt-side rate, measured basis", () => {
    const r = savedUsd({ byModel: { "claude/sonnet": 1e6 }, rates: rates(promptSideRate(S)) });
    expect(r.usd).toBeCloseTo(expectedSonnet, 6);
    expect(r.basis).toBe("measured");
    expect(r.pricedShare).toBe(1);
  });

  it("an empty applied set is zero savings with a measured basis (not unpriced, not null)", () => {
    const r = savedUsd({ byModel: {}, rates: rates(promptSideRate(S)) });
    expect(r.usd).toBe(0);
    expect(r.pricedShare).toBe(1);
    expect(r.basis).toBe("measured");
  });

  it("tokens under 'unknown' price at the token-weighted average of the known rates", () => {
    // 1M Sonnet at ~0.78 + 1M unknown at the same average → 2× the known figure.
    const sonnet = promptSideRate(S);
    const r = savedUsd({
      byModel: { "claude/sonnet": 1e6, unknown: 1e6 },
      rates: { "claude/sonnet": sonnet },
    });
    expect(r.usd).toBeCloseTo(2 * expectedSonnet, 6);
    expect(r.basis).toBe("partial");
    expect(r.pricedShare).toBeCloseTo(0.5, 6);
  });

  it("every model unknown → usd null, basis unpriced — do not invent a figure", () => {
    const r = savedUsd({ byModel: { unknown: 5e6 }, rates: {} });
    expect(r.usd).toBeNull();
    expect(r.basis).toBe("unpriced");
    expect(r.pricedShare).toBe(0);
  });

  it("an unpriced model key (no known rate) counts as unknown, and if none priced → null", () => {
    const r = savedUsd({ byModel: { "openai/gpt9": 4e6 }, rates: {} });
    expect(r.usd).toBeNull();
    expect(r.basis).toBe("unpriced");
  });

  it("subtracts the re-warm cost using the dominant known model's cacheWrite−cacheRead delta", () => {
    // Dominant model: cacheWrite 3, cacheRead 0.3 → delta 2.7/Mtok.
    const sonnet = promptSideRate(S);
    const noRewarm = savedUsd({ byModel: { "claude/sonnet": 1e6 }, rates: { "claude/sonnet": sonnet } });
    const withRewarm = savedUsd({
      byModel: { "claude/sonnet": 1e6 },
      rewarmTokens: 200_000, // 0.2 Mtok × 2.7 = $0.54 re-warm
      rates: { "claude/sonnet": sonnet },
    });
    expect(withRewarm.usd!).toBeCloseTo(noRewarm.usd! - (0.2 * 2.7), 6);
  });

  it("a re-warm larger than the saving yields a NEGATIVE usd — never clamped", () => {
    // Tiny saving (100k tokens), huge re-warm (5M): 5M × 2.7 = $13.5 re-warm.
    const sonnet = promptSideRate(S);
    const r = savedUsd({
      byModel: { "claude/sonnet": 100_000 },
      rewarmTokens: 5_000_000,
      rates: { "claude/sonnet": sonnet },
    });
    expect(r.usd).toBeLessThan(0);
    expect(r.basis).toBe("measured");
  });

  it("no known rate → no re-warm subtraction (there is nothing to price against)", () => {
    const r = savedUsd({ byModel: { unknown: 1e6 }, rewarmTokens: 5_000_000, rates: {} });
    expect(r.usd).toBeNull(); // still unpriced — re-warm never manufactures a number
  });

  it("ignores junk token values (negative / non-numeric) without throwing", () => {
    const sonnet = promptSideRate(S);
    const r = savedUsd({
      byModel: { "claude/sonnet": Number.NaN, unknown: -10 },
      rates: { "claude/sonnet": sonnet },
    });
    expect(r.usd).toBe(0);
    expect(r.basis).toBe("measured");
  });
});
