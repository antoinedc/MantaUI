// @vitest-environment jsdom
//
// Component tests for the Optimizer P2.5 (BET-1347) legibility surfaces on the
// Settings → Models optimizer card: the activity feed's empty state, the
// pressure chips (neutral when there is no signal, never a fabricated pace),
// and the metered-endpoints row (role + price, deliberately NO gauge).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { OptimizerCard } from "./OptimizerCard";
import type { OptimizerSummary } from "../shared/types";

const CD = { cacheRead: 8000, cacheWrite: 1000, input: 1000, output: 500 };

function fixture(over: Partial<OptimizerSummary> = {}): OptimizerSummary {
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

describe("OptimizerCard — P2.5 legibility surfaces", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    resetStore({ optimizerEnabled: false });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("with an empty activity feed renders the documented empty state and NO feed rows", async () => {
    installMockApi({ optimizerSummary: () => Promise.resolve(fixture({ activity: { entries: [] } })) });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Nothing changed yet. Manta needs a few days of your usage before it starts tuning anything.");
    // No feed rows: no headline times, and no feed container content.
    expect(h.container.querySelectorAll(".opt-ev").length).toBe(0);
  });

  it("renders feed rows + a rolled-back row stays visually distinct when entries exist", async () => {
    installMockApi({
      optimizerSummary: () =>
        Promise.resolve(
          fixture({
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
    // The fixture window has tokensPerPct: null → no signal.
    installMockApi({ optimizerSummary: () => Promise.resolve(fixture()) });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("no pressure signal yet");
    // The neutral chip is the only chip — no warn chip for an absent signal
    // (the "ahead of pace" phrase in window copy must not become a chip).
    const chipText = [...h.container.querySelectorAll(".opt-chip")].map((c) => c.textContent ?? "").join(" ");
    expect(chipText).not.toContain("ahead of pace");
    expect(h.container.querySelectorAll(".opt-chip.warn").length).toBe(0);
  });

  it("a window ahead of pace (signal present, deficit > 0) renders a warn chip", async () => {
    const f = fixture();
    f.windows[0].tokensPerPct = 100;
    f.windows[0].deficit = 23;
    installMockApi({ optimizerSummary: () => Promise.resolve(f) });
    h = mount(<OptimizerCard />);
    await h.flush();
    expect(h.text()).toContain("+23 pts ahead of pace");
    expect(h.container.querySelectorAll(".opt-chip.warn").length).toBe(1);
  });

  it("a metered endpoint renders the row with role + price and NO gauge element", async () => {
    const f = fixture({
      metered: [
        { name: "OpenAI · gpt-5.2", role: "fallback when over pace", price: "$2.40 / Mtok blended" },
        { name: "Groq · llama-4-70b", role: "explore + title work", price: "$0.31 / Mtok blended" },
      ],
    });
    installMockApi({ optimizerSummary: () => Promise.resolve(f) });
    h = mount(<OptimizerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Metered endpoints");
    expect(text).toContain("gpt-5.2");
    expect(text).toContain("$2.40 / Mtok blended");
    // Gauges are only for subscription windows (1 in the fixture) — the
    // metered row is a slim role+price line with NO gauge.
    const windowCount = f.windows.length;
    expect(h.container.querySelectorAll(".opt-gauge").length).toBe(windowCount);
  });

  it("compaction stat shows 'X of Y in background' when the scheduler reports", async () => {
    installMockApi({
      optimizerSummary: () =>
        Promise.resolve(
          fixture({
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
