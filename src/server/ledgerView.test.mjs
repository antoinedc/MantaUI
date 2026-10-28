import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ledgerView, withLedgerView } from "./ledgerView.mjs";

const base = (over = {}) => ({
  supported: true,
  cacheShare: { output: 0.14, cacheRead: 0.61, cacheWrite: 0.22, input: 0.03 },
  byModel: [],
  byAgent: [],
  ...over,
});

describe("ledgerView", () => {
  test("segments are in fixed order with rounded whole percentages", () => {
    const v = ledgerView(base());
    assert.deepEqual(
      v.segments.map((s) => [s.kind, s.label, s.pct]),
      [["cacheRead", "cache read", 61], ["cacheWrite", "cache write", 22], ["output", "output", 14], ["input", "fresh input", 3]],
    );
  });

  test("inline threshold: 3% hidden, 4% shown", () => {
    const v = ledgerView(base({ cacheShare: { output: 0.04, cacheRead: 0.5, cacheWrite: 0.43, input: 0.03 } }));
    assert.deepEqual(v.segments.map((s) => s.inline), [true, true, true, false]);
    assert.equal(v.segments[2].pct, 4);
    assert.equal(v.segments[3].pct, 3);
  });

  test("caption sums cache read + write before rounding", () => {
    // 0.614 + 0.226 = 0.84 → 84% (not 61 + 23 = 84 by luck: use values where rounding differs)
    const v = ledgerView(base({ cacheShare: { output: 0.1, cacheRead: 0.444, cacheWrite: 0.444, input: 0.012 } }));
    assert.equal(v.caption, "Cache is 89% of your bill — carrying the conversation, not generating answers.");
  });

  test("top models are capped at 6, tokensPerSec null kept, per-field copy", () => {
    const byModel = Array.from({ length: 9 }, (_, i) => ({
      key: `p/m${i}`, turns: i, cost: i * 2, costPerTurn: 2, outPerTurn: 1, tokensPerSec: i === 0 ? null : 40, p50Ms: null, p90Ms: null,
    }));
    const v = ledgerView(base({ byModel }));
    assert.equal(v.topModels.length, 6);
    assert.deepEqual(v.topModels[0], { key: "p/m0", turns: 0, costPerTurn: 2, tokensPerSec: null, cost: 0 });
    assert.equal(v.topModels[1].tokensPerSec, 40);
  });

  test("null agent → 'main'; isChild preserved; empty texts present", () => {
    const v = ledgerView(base({ byAgent: [{ agent: null, isChild: false, turns: 90, cost: 9, costPerTurn: 0.1 }, { agent: "explore", isChild: true, turns: 3, cost: 1, costPerTurn: 0.33 }] }));
    assert.deepEqual(v.agents.map((a) => [a.label, a.isChild]), [["main", false], ["explore", true]]);
    assert.equal(v.emptyModels, "No model spend recorded.");
    assert.equal(v.emptyAgents, "No agent spend recorded.");
  });

  test("withLedgerView adds view when supported and leaves an unsupported answer untouched", () => {
    const s = base();
    assert.equal(withLedgerView(s).view.segments.length, 4);
    assert.equal(withLedgerView(s).cacheShare, s.cacheShare);
    const unsupported = { supported: false };
    assert.equal(withLedgerView(unsupported), unsupported);
  });
});
