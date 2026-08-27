// @vitest-environment jsdom
//
// Component tests for the Settings → Models optimizer card (BET-1337 + P2.5
// BET-1347 + BET-1369). BET-1369 made the consumption chart + the range-scoped
// stats read from the windowed `optimizer:series` RPC (24h/7d/30d) instead of
// folding over the summary's fixed 30-day dailySeries, so these tests drive
// BOTH reads: `optimizerSummary` (the rest of the card) and `optimizerSeries`
// (the chart + Sent/Saved/Cost-per-turn).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { OptimizerCard } from "./OptimizerCard";
import type { OptimizerSummary, OptimizerSeries, OptimizerRange } from "../shared/types";

const CD = { cacheRead: 8000, cacheWrite: 1000, input: 1000, output: 500 };

function summaryFixture(over: Partial<OptimizerSummary> = {}): OptimizerSummary {
  return {
    supported: true,
    windowDays: 30,
    totals: { turns: 100, cost: 12.34, input: 1000, output: 500, cacheRead: 8000, cacheWrite: 1000 },
    cacheShare: { ...CD },
    dailySeries: [
      { day: "2026-08-01", tokensSent: 1000, maskedTokens: 0 },
      { day: "2026-08-02", tokensSent: 1200, maskedTokens: 0 },
    ],
    bySession: [{ sessionID: "s1", turns: 100, cost: 12.34, tokensSent: 2200, savedPct: 0 }],
    ttl: { measuredMs: 300_000, confidence: "default", observations: 0, configuredMs: 300_000, matched: null },
    counterfactual: { dailySeries: [], bySession: {} },
    windows: [
      {
        provider: "claude",
        planLabel: "Max 20x",
        windowLabel: "week",
        kind: "weekly",
        pct: 34,
        resetsAt: 0,
        forecastPct: 52,
        deficit: 0,
        tokensPerPct: null,
      },
    ],
    activity: { entries: [] },
    compaction: null,
    metered: [],
    ...over,
  };
}

// A 24h hourly series by default (two points, no counterfactual). `range` is
// honoured so a "7d" click can produce a day-bucket series.
function seriesFixture(over: Partial<OptimizerSeries> = {}): OptimizerSeries {
  return {
    supported: true,
    range: "24h",
    bucket: "hour",
    startMs: new Date(2026, 7, 23, 14, 0, 0).getTime(),
    endMs: new Date(2026, 7, 24, 14, 0, 0).getTime(),
    series: [
      { t: new Date(2026, 7, 23, 14, 0, 0).getTime(), tokensSent: 10, maskedTokens: 0 },
      { t: new Date(2026, 7, 23, 15, 0, 0).getTime(), tokensSent: 20, maskedTokens: 0 },
    ],
    counterfactualAvailable: false,
    totals: { turns: 100, cost: 12.34, tokensSent: 30, maskedTokens: 0 },
    saved: { usd: 0, potentialUsd: 0, basis: "measured", pricedShare: 1 },
    ...over,
  };
}

// Install both reads with sane defaults; tests override specifics per-case.
function setApi(overrides: {
  optimizerSummary?: () => Promise<OptimizerSummary>;
  optimizerSeries?: (range: OptimizerRange) => Promise<OptimizerSeries | { supported: false }>;
} = {}) {
  return installMockApi({
    optimizerSummary: () => Promise.resolve(summaryFixture()),
    optimizerSeries: (range: OptimizerRange) => Promise.resolve(seriesFixture({ range })),
    ...overrides,
  });
}

// Find the range selector chip whose label is `label` and click it.
function clickRange(h: Harness, label: string): void {
  const btn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!btn) throw new Error(`no range chip "${label}" found`);
  act(() => btn.click());
}

describe("OptimizerCard — BET-1369 range selector + windowed stats", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    resetStore({ optimizerEnabled: false });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("defaults to 24h: asks optimizerSeries for '24h' and shows the 24h Sent label", async () => {
    const { api } = setApi();
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(api.calls.optimizerSeries?.flat()).toContain("24h");
    expect(h.text()).toContain("Sent (24h)");
    expect(h.text()).toContain("24h average");
  });

  it("clicking the 7d chip asks optimizerSeries for '7d' and relabels Sent", async () => {
    const { api } = setApi({
      optimizerSeries: (range) =>
        Promise.resolve(seriesFixture({ range, bucket: "day", series: [{ t: Date.now(), tokensSent: 5, maskedTokens: 0 }] })),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    clickRange(h, "7d");
    await h.flush();
    const ranges = api.calls.optimizerSeries?.map((a) => a[0]);
    expect(ranges).toContain("7d");
    expect(h.text()).toContain("Sent (7d)");
  });

  it("renders the chip group with all three ranges", async () => {
    setApi();
    h = mount(<OptimizerCard />);
    await h.flush();
    const chips = [...h.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(chips).toContain("24h");
    expect(chips).toContain("7d");
    expect(chips).toContain("30d");
  });

  it("the chart axis ticks come from the windowed series, not the summary's dailySeries", async () => {
    setApi({
      optimizerSeries: () =>
        Promise.resolve(
          seriesFixture({
            bucket: "day",
            range: "7d",
            series: [
              { t: new Date(2026, 7, 23, 0, 0, 0).getTime(), tokensSent: 10, maskedTokens: 0 },
              { t: new Date(2026, 7, 24, 0, 0, 0).getTime(), tokensSent: 20, maskedTokens: 0 },
            ],
          }),
        ),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    const texts = [...h.container.querySelectorAll("svg.opt-chart text")].map((t) => t.textContent ?? "");
    // Day-bucket labels via chartAxisTicks over the SERIES t's.
    expect(texts.some((t) => t.includes("Aug 23"))).toBe(true);
    expect(texts.some((t) => t.includes("Aug 24"))).toBe(true);
  });

  it("the Counterfactual stat reads the series maskedTokens and shows the saved overlay", async () => {
    setApi({
      optimizerSeries: () =>
        Promise.resolve(
          seriesFixture({
            series: [
              { t: Date.now(), tokensSent: 1000, maskedTokens: 500 },
              { t: Date.now(), tokensSent: 1000, maskedTokens: 500 },
            ],
            counterfactualAvailable: true,
            totals: { turns: 10, cost: 2, tokensSent: 2000, maskedTokens: 1000 },
            saved: { usd: 0.37, potentialUsd: 0.37, basis: "measured", pricedShare: 1 },
          }),
        ),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    // maskedTotal 1000 → the chart overlay shows the masked total + the est.
    // figure (two decimals from saved.usd), and the counterfactual legend line
    // appears.
    expect(h.text()).toContain("−1k tokens · ≈ $0.37 est.");
    expect(h.text()).toContain("raw counterfactual");
  });

  it("Cache-hit and Sessions details still say 30d while Sent and Cost/turn say 24h", async () => {
    setApi();
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Sent (24h)");
    expect(text).toContain("24h average");
    // Summary-scoped details unchanged:
    expect(text).toContain("· 30d");
    expect(text).toContain("TTL 5m default");
    // Sessions stat detail reads 30d (no compaction in fixture).
    expect(h.container.textContent).toContain("30d");
  });

  it("an unpriced Saved stat renders 'not priced' with the documented detail", async () => {
    setApi({
      optimizerSeries: (range) =>
        Promise.resolve(seriesFixture({ range, saved: { usd: null, potentialUsd: null, basis: "unpriced", pricedShare: 0 } })),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("not priced");
    expect(h.text()).toContain("these endpoints declare no price");
  });

  it("a negative Saved stat renders a warn −$ figure and the re-warm detail", async () => {
    const saved: OptimizerSeries["saved"] = { usd: -0.43, potentialUsd: 0.2, basis: "measured", pricedShare: 1 };
    setApi({ optimizerSeries: (range) => Promise.resolve(seriesFixture({ range, saved })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("−$0.43");
    expect(h.text()).toContain("re-warm cost exceeded the saving");
    expect(h.container.querySelector(".opt-stat-v.warn")).toBeTruthy();
  });

  it("a measured positive Saved stat renders two-decimal ≈ $X.XX and the potential detail", async () => {
    const saved: OptimizerSeries["saved"] = { usd: 1.234, potentialUsd: 1.25, basis: "measured", pricedShare: 1 };
    setApi({ optimizerSeries: (range) => Promise.resolve(seriesFixture({ range, saved })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("≈ $1.23");
    expect(h.text()).toContain("≈$1.25 potential");
  });

  it("a partial Saved stat shows potential · % priced on the detail line", async () => {
    const saved: OptimizerSeries["saved"] = { usd: 2.4, potentialUsd: 3.6, basis: "partial", pricedShare: 0.5 };
    setApi({ optimizerSeries: (range) => Promise.resolve(seriesFixture({ range, saved })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("≈ $2.40");
    expect(h.text()).toContain("≈$3.60 potential · 50% priced");
  });

  it("an optimizer-off window (nothing applied) renders Saved as ≈ $0.00, not 'not priced'", async () => {
    const saved: OptimizerSeries["saved"] = { usd: 0, potentialUsd: 1.25, basis: "measured", pricedShare: 1 };
    setApi({ optimizerSeries: (range) => Promise.resolve(seriesFixture({ range, saved })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("≈ $0.00");
    expect(h.text()).not.toContain("not priced");
  });

  it("no counterfactual in a 24h window shows the hourly explanation under the legend", async () => {
    setApi();
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("Hourly comparison starts collecting today.");
    expect(h.text()).not.toContain("raw counterfactual");
  });

  it("no counterfactual in a 7d/30d window shows the no-trimming explanation", async () => {
    const { api } = setApi({
      optimizerSeries: (range) => Promise.resolve(seriesFixture({ range, bucket: "day" })),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    // The fixture's series has maskedTokens 0 → counterfactualAvailable false.
    // Switch to 7d (day bucket) to see the non-hourly explanation.
    clickRange(h, "7d");
    await h.flush();
    expect(api.calls.optimizerSeries?.map((a) => a[0])).toContain("7d");
    expect(h.text()).toContain("No trimming recorded in this window.");
  });

  it("an unsupported series read degrades the chart block only; the rest of the card still renders", async () => {
    setApi({ optimizerSeries: () => Promise.resolve({ supported: false }) });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Spend history needs a newer box runtime.");
    // The summary-driven surfaces still render.
    expect(text).toContain("Token optimizer");
    expect(text).toContain("Prompt cache");
  });

  it("an empty window renders the range-specific no-activity empty state and NO chart", async () => {
    setApi({
      optimizerSeries: (range) =>
        Promise.resolve(seriesFixture({ range, series: [], totals: { turns: 0, cost: 0, tokensSent: 0, maskedTokens: 0 } })),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("No model activity in the last 24h.");
    expect(h.container.querySelectorAll("svg.opt-chart").length).toBe(0);
  });

  it("with an empty activity feed renders the documented empty state and NO feed rows", async () => {
    setApi({ optimizerSummary: () => Promise.resolve(summaryFixture({ activity: { entries: [] } })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Nothing changed yet. Manta needs a few days of your usage before it starts tuning anything.");
    expect(h.container.querySelectorAll(".opt-ev").length).toBe(0);
  });

  it("renders feed rows + a rolled-back row stays visually distinct when entries exist", async () => {
    setApi({
      optimizerSummary: () =>
        Promise.resolve(
          summaryFixture({
            activity: {
              entries: [
                { id: "a", ts: 1_700_000_000_000, kind: "tune", subject: "trim threshold 16 → 12 tool uses", from: 16, to: 12, verdict: "kept", evidence: { turns: 62 } },
                { id: "b", ts: 1_700_000_000_001, kind: "tune", subject: "protected tail 40k → 24k", from: 40_000, to: 24_000, verdict: "rolled-back", revertedAt: 1_700_000_000_100, evidence: { churn: 0.03 } },
              ],
            },
          }),
        ),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Kept — trim threshold 16 → 12 tool uses");
    expect(text).toContain("Rolled back — protected tail 40k → 24k");
    expect(h.container.querySelectorAll(".opt-ev").length).toBe(2);
    expect(h.container.querySelectorAll(".opt-ev.rb").length).toBe(1);
  });

  it("no pressure signal renders the neutral chip and NO warn chip", async () => {
    setApi();
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("no pressure signal yet");
    const chipText = [...h.container.querySelectorAll(".opt-chip")].map((c) => c.textContent ?? "").join(" ");
    expect(chipText).not.toContain("ahead of pace");
    expect(h.container.querySelectorAll(".opt-chip.warn").length).toBe(0);
  });

  it("a window ahead of pace (signal present, deficit > 0) renders a warn chip", async () => {
    const f = summaryFixture();
    f.windows[0].tokensPerPct = 100;
    f.windows[0].deficit = 23;
    setApi({ optimizerSummary: () => Promise.resolve(f) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("+23 pts ahead of pace");
    expect(h.container.querySelectorAll(".opt-chip.warn").length).toBe(1);
  });

  it("a metered endpoint renders the row with role + price and NO gauge element", async () => {
    setApi({
      optimizerSummary: () =>
        Promise.resolve(
          summaryFixture({
            metered: [
              { name: "OpenAI · gpt-5.2", role: "fallback when over pace", price: "$2.40 / Mtok blended" },
              { name: "Groq · llama-4-70b", role: "explore + title work", price: "$0.31 / Mtok blended" },
            ],
          }),
        ),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Metered endpoints");
    expect(text).toContain("gpt-5.2");
    expect(text).toContain("$2.40 / Mtok blended");
    const windowCount = summaryFixture().windows.length;
    expect(h.container.querySelectorAll(".opt-gauge").length).toBe(windowCount);
  });

  it("compaction stat shows 'X of Y in background' when the scheduler reports", async () => {
    setApi({
      optimizerSummary: () =>
        Promise.resolve(
          summaryFixture({
            compaction: { background: 6, total: 7 },
            windows: [{ provider: "claude", planLabel: "Max", windowLabel: "week", kind: "weekly", pct: 10, resetsAt: 0, forecastPct: null, deficit: null, tokensPerPct: null }],
          }),
        ),
    });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("6 of 7 in background");
  });
});
