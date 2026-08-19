// @vitest-environment jsdom
//
// Component tests for the Settings → Models "Where your spend goes" ledger
// card (BET-1221). ModelLedgerCard fetches once on mount via
// window.api.ledgerSummary; these tests install the mock api and settle the
// fetch with h.flush(), then assert on the three honest states.

import { describe, it, expect, afterEach } from "vitest";
import { mount, installMockApi, type Harness } from "./testHarness";
import { ModelLedgerCard } from "./ModelLedgerCard";
import type { LedgerSummary } from "../shared/types";

// A realistic summary: cacheRead dwarfs everything (70%), a couple of models
// (one without a measured tok/s), and a main + one subagent.
function fixture(): LedgerSummary {
  return {
    supported: true,
    totals: { turns: 100, cost: 12.34, input: 1000, output: 500, cacheRead: 80000, cacheWrite: 10000 },
    cacheShare: { output: 0.05, cacheRead: 0.7, cacheWrite: 0.15, input: 0.1 },
    byModel: [
      { key: "anthropic/claude-opus", turns: 40, cost: 8.0, costPerTurn: 0.2, outPerTurn: 500, tokensPerSec: 23.5, p50Ms: 4000, p90Ms: 9000 },
      // tokensPerSec is typed `number` but the box can send null below 5 timed
      // turns (BET-1219) — cast to model that runtime reality, which is exactly
      // the null-guard this card must survive.
      { key: "anthropic/claude-sonnet", turns: 30, cost: 3.0, costPerTurn: 0.1, outPerTurn: 400, tokensPerSec: null as unknown as number, p50Ms: null, p90Ms: null },
    ],
    byAgent: [
      { agent: "main", isChild: false, turns: 80, cost: 10.0, costPerTurn: 0.125 },
      { agent: "explorer", isChild: true, turns: 20, cost: 2.34, costPerTurn: 0.117 },
    ],
    byProject: [],
  };
}

// A summary whose TOP-by-cost model has no tok/s measurement — the guard that
// must render "—" rather than NaN/null.
function fixtureNoTok(): LedgerSummary {
  const f = fixture();
  f.byModel = [
    { ...f.byModel[0], tokensPerSec: null as unknown as number, p50Ms: null, p90Ms: null },
    ...f.byModel.slice(1),
  ];
  return f;
}

describe("ModelLedgerCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("{ supported:false } renders the upgrade sentence and NO $ figure", async () => {
    installMockApi({ ledgerSummary: () => Promise.resolve({ supported: false }) });
    h = mount(<ModelLedgerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Spend history needs a newer box runtime.");
    expect(text).not.toContain("$");
  });

  it("renders the four legend entries and the top-model row from a fixture summary", async () => {
    installMockApi({ ledgerSummary: () => Promise.resolve(fixture()) });
    h = mount(<ModelLedgerCard />);
    await h.flush();
    const text = h.text();
    // The four legend entries.
    expect(text).toContain("cache read");
    expect(text).toContain("cache write");
    expect(text).toContain("output");
    expect(text).toContain("fresh input");
    // The cache sentence.
    expect(text).toContain("Cache is");
    // Top-model row: key, turns, $/turn, tok/s, total.
    expect(text).toContain("anthropic/claude-opus");
    expect(text).toContain("40");
    expect(text).toContain("$0.20");
    expect(text).toContain("23.5");
    expect(text).toContain("$8.00");
    // Subagent pill.
    expect(text).toContain("subagent");
  });

  it("renders — for a model whose tokensPerSec is null, never NaN or null", async () => {
    installMockApi({ ledgerSummary: () => Promise.resolve(fixtureNoTok()) });
    h = mount(<ModelLedgerCard />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("—");
    expect(text).not.toContain("NaN");
    expect(text).not.toMatch(/\bnull\b/);
  });
});
