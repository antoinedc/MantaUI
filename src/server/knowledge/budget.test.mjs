import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASS_BANDS, FALLBACK_RATES, MAX_BATCHES_PER_PROJECT_PER_DAY, createBudget, localDay, priceTokens, resolveRates } from "./budget.mjs";
import { memState } from "./testHelpers.mjs";

const PRICES = {
  models: {
    "a/cheap": { input: 1, output: 5 },
    "a/mid": { input: 3, output: 15 },
    "a/deep": { input: 15, output: 75 },
    "b/deep2": { input: 10, output: 40 },
  },
};
const bandOf = (p, m) => ({ "a/cheap": "fast", "a/mid": "balanced", "a/deep": "deep", "b/deep2": "deep" })[`${p}/${m}`] ?? null;

test("priceTokens: $/Mtok over input, output, cache read (default 10% of input) and cache write", () => {
  const usd = priceTokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, { input: 3, output: 15 });
  assert.equal(usd, 3 + 15 + 0.3 + 3);
  assert.equal(priceTokens({}, { input: 3, output: 15 }), 0);
});

test("a priced model is charged its own rates", () => {
  const r = resolveRates({ providerID: "a", modelID: "mid", band: "deep", prices: PRICES, bandOf });
  assert.equal(r.priced, true);
  assert.equal(r.rates.input, 3);
});

test("an unpriced model is charged at the highest price of any priced model in its band", () => {
  const r = resolveRates({ providerID: "x", modelID: "mystery", band: "deep", prices: PRICES, bandOf });
  assert.equal(r.priced, false);
  assert.equal(r.rates.input, 15); // a/deep beats b/deep2
  const fast = resolveRates({ providerID: "x", modelID: "mystery", band: "fast", prices: PRICES, bandOf });
  assert.equal(fast.rates.input, 1);
});

test("no priced model in the band → the dearest priced model overall; none at all → the fallback rates", () => {
  assert.equal(resolveRates({ providerID: "x", modelID: "y", band: "nope", prices: PRICES, bandOf }).rates.input, 15);
  assert.equal(resolveRates({ providerID: "x", modelID: "y", band: "deep", prices: { models: {} }, bandOf }).rates, FALLBACK_RATES);
  assert.equal(resolveRates({ providerID: "x", modelID: "y", prices: undefined }).rates, FALLBACK_RATES);
});

function rig({ cap = 1, prices = PRICES } = {}) {
  let t = new Date(2026, 10, 16, 10, 0, 0).getTime();
  return memState().then((state) => {
    const b = createBudget({ state, settings: { get: async () => ({ dailyCapUsd: cap }) }, getPrices: () => prices, bandOf, now: () => t });
    return { b, state, setNow: (x) => (t = x), now: () => t };
  });
}

test("records dollars per local day by task class band; canSpend flips at the cap and resets next day", async () => {
  const { b, setNow, now } = await rig({ cap: 0.5 });
  assert.equal((await b.canSpend()).ok, true);
  const r = await b.record({ taskClass: "curator-rules", model: { providerID: "a", modelID: "deep" }, tokens: { input: 20_000, output: 4_000 } });
  assert.equal(r.priced, true);
  assert.ok(Math.abs(r.usd - (20_000 * 15 + 4_000 * 75) / 1e6) < 1e-9); // 0.6
  const s = await b.canSpend();
  assert.equal(s.ok, false);
  assert.ok(s.spentUsd >= 0.6);
  assert.equal(b.byClass()[0].taskClass, "curator-rules");
  setNow(now() + 24 * 3600 * 1000);
  assert.equal((await b.canSpend()).ok, true);
});

test("an unpriced model's call still counts against the cap (priced:false)", async () => {
  const { b } = await rig({ cap: 0.01 });
  const r = await b.record({ taskClass: "knowledge-capture", model: { providerID: "q", modelID: "unknown" }, tokens: { input: 100_000, output: 10_000 } });
  assert.equal(r.priced, false);
  assert.ok(r.usd > 0);
  assert.equal((await b.canSpend()).ok, false);
});

test("a directly supplied usd (a trial session's recorded usage) is stored as-is", async () => {
  const { b } = await rig();
  const r = await b.record({ taskClass: "knowledge-trial", usd: 0.123 });
  assert.equal(r.usd, 0.123);
  assert.equal(b.spentToday(), 0.123);
});

test("at most 24 curator batches per project per day", async () => {
  const { b, setNow, now } = await rig();
  for (let i = 0; i < MAX_BATCHES_PER_PROJECT_PER_DAY; i++) {
    assert.equal(b.canBatch("p"), true);
    b.recordBatch("p");
  }
  assert.equal(b.canBatch("p"), false);
  assert.equal(b.canBatch("other"), true);
  setNow(now() + 24 * 3600 * 1000);
  assert.equal(b.canBatch("p"), true);
});

test("the class → band table matches spec §6.2 and localDay is box-local", () => {
  assert.deepEqual(CLASS_BANDS, { "knowledge-capture": "fast", "knowledge-corrections": "fast", "knowledge-trial": "balanced", "curator-notes": "balanced", "curator-rules": "deep", "curator-skills": "deep" });
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
});
