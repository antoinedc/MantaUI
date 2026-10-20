import { describe, it, expect } from "vitest";
import { reportUsd, summarizeSaved } from "./optimizerSavings.mjs";

// Opus-5.5-ish list prices: cache read $0.2/Mtok, cache write $5/Mtok.
const RATES = { cacheRead: 0.2, cacheWrite: 5 };

describe("reportUsd — one report, priced with its own rates", () => {
  it("usd = trimmed × r − rewarm × (w − r), per million tokens", () => {
    // 520k trimmed, 280k re-warmed: the spec's worked example.
    const usd = reportUsd({ trimmed: 520_000, rewarm: 280_000, rates: RATES });
    expect(usd).toBeCloseTo((520_000 * 0.2 - 280_000 * 4.8) / 1e6, 12);
    expect(usd).toBeLessThan(0); // the re-cache has not paid back yet
  });

  it("trimmed-only is a pure gain; rewarm-only is a pure cost", () => {
    expect(reportUsd({ trimmed: 1_000_000, rewarm: 0, rates: RATES })).toBeCloseTo(0.2, 12);
    expect(reportUsd({ trimmed: 0, rewarm: 1_000_000, rates: RATES })).toBeCloseTo(-4.8, 12);
  });

  it("a provider with no write premium (w == r) never nets a re-warm cost", () => {
    expect(reportUsd({ trimmed: 1_000_000, rewarm: 5_000_000, rates: { cacheRead: 0.0182, cacheWrite: 0.0182 } })).toBeCloseTo(0.0182, 12);
  });

  it("unusable rates → null (UNPRICED), never 0", () => {
    expect(reportUsd({ trimmed: 1, rewarm: 0 })).toBeNull();
    expect(reportUsd({ trimmed: 1, rewarm: 0, rates: null })).toBeNull();
    expect(reportUsd({ trimmed: 1, rewarm: 0, rates: { cacheRead: 0, cacheWrite: 5 } })).toBeNull();
    expect(reportUsd({ trimmed: 1, rewarm: 0, rates: { cacheRead: -1, cacheWrite: 5 } })).toBeNull();
    expect(reportUsd({ trimmed: 1, rewarm: 0, rates: { cacheRead: 0.2, cacheWrite: NaN } })).toBeNull();
    expect(reportUsd({ trimmed: 1, rewarm: 0, rates: { cacheRead: 0.2 } as never })).toBeNull();
  });

  it("junk token counts count as 0", () => {
    expect(reportUsd({ trimmed: NaN, rewarm: -5, rates: RATES })).toBe(0);
  });
});

describe("summarizeSaved — a window is a SUM of stored usd", () => {
  it("sums stored dollars across models; share is report-count weighted", () => {
    const out = summarizeSaved([
      { trimmed: 10, rewarm: 2, usd: 0.5, pricedReports: 3, unpricedReports: 0 },
      { trimmed: 5, rewarm: 0, usd: 0.25, pricedReports: 1, unpricedReports: 0 },
    ]);
    expect(out).toEqual({ usd: 0.75, basis: "measured", pricedShare: 1, trimmed: 15, rewarm: 2 });
  });

  it("a cost-only window is negative and is NOT clamped", () => {
    const out = summarizeSaved([{ trimmed: 0, rewarm: 280_000, usd: -1.344, pricedReports: 1, unpricedReports: 0 }]);
    expect(out.usd).toBeCloseTo(-1.344, 12);
    expect(out.basis).toBe("measured");
  });

  it("unpriced reports add tokens, never dollars; partial basis", () => {
    const out = summarizeSaved([
      { trimmed: 100, rewarm: 0, usd: 2, pricedReports: 1, unpricedReports: 0 },
      { trimmed: 900, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 3 },
    ]);
    expect(out.usd).toBe(2); // not imputed up to 1000 tokens
    expect(out.trimmed).toBe(1000);
    expect(out.basis).toBe("partial");
    expect(out.pricedShare).toBe(0.25);
  });

  it("reports exist but none priced → usd null, unpriced, share 0", () => {
    const out = summarizeSaved([{ trimmed: 5, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 2 }]);
    expect(out).toMatchObject({ usd: null, basis: "unpriced", pricedShare: 0 });
  });

  it("an empty window is the genuine zero: 0, measured, share 1", () => {
    for (const e of [[], undefined, null, [null, undefined, {}]]) {
      expect(summarizeSaved(e as never)).toMatchObject({ usd: 0, basis: "measured", pricedShare: 1 });
    }
  });
});
