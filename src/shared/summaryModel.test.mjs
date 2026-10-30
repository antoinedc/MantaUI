import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_CAPABLE_MODEL_REASON,
  SUMMARY_MIN_CONTEXT,
  blendedPrice,
  isEligibleSummaryModel,
  priceLabelFor,
  publicCandidate,
  rankSummaryModels,
  searchSummaryCandidates,
  shortlist,
} from "./summaryModel.mjs";

const model = (providerID, id, over = {}) => ({
  providerID,
  id,
  name: id,
  family: undefined,
  limit: { context: 200_000 },
  capabilities: { output: ["text"] },
  ...over,
});
const price = (input, output) => ({ input, output, cacheWrite: input, source: "catalog" });
const entry = (m, listPrice = null, catalogEntry = null) => ({ model: m, listPrice, catalogEntry });
// A benchmark field where score 70 ranks at the 0.9 percentile and 5 at 0.05.
const field = { benchmarkPercentile: (_name, score) => (score >= 70 ? 0.9 : score >= 30 ? 0.5 : 0.05) };
const bench = (score) => ({ benchmarks: [{ name: "SWE-Bench Verified", score }] });

test("eligibility: deprecated, the free `opencode` tier, small / unknown context and non-text models are out", () => {
  assert.equal(isEligibleSummaryModel(model("anthropic", "ok")), true);
  assert.equal(isEligibleSummaryModel(model("anthropic", "old", { status: "deprecated" })), false);
  assert.equal(isEligibleSummaryModel(model("opencode", "free")), false);
  assert.equal(isEligibleSummaryModel(model("p", "small", { limit: { context: SUMMARY_MIN_CONTEXT - 1 } })), false);
  assert.equal(isEligibleSummaryModel(model("p", "edge", { limit: { context: SUMMARY_MIN_CONTEXT } })), true);
  assert.equal(isEligibleSummaryModel(model("p", "unknown", { limit: { context: null } })), false);
  assert.equal(isEligibleSummaryModel(model("p", "img", { capabilities: { output: ["image"] } })), false);
  assert.equal(isEligibleSummaryModel(model("p", "noinfo", { capabilities: { output: [] } })), true, "no modality information is not 'supports nothing'");
});

test("a model deactivated for chat is still eligible: only the hard gates apply (no activation list is consulted)", () => {
  const r = rankSummaryModels({ entries: [entry(model("anthropic", "claude-haiku-4", { family: "haiku", enabled: true }), price(1, 5))] });
  assert.equal(r.candidates.length, 1);
  assert.equal(r.pick.modelID, "claude-haiku-4");
});

test("quality gate: benchmark >= 0.20 or a seeded family passes; structural never does", () => {
  const r = rankSummaryModels({
    entries: [
      entry(model("or", "benched-good"), price(1, 1), bench(70)),
      entry(model("or", "benched-bad"), price(0.01, 0.01), bench(5)),
      entry(model("or", "fam", { family: "sonnet" }), price(3, 15)),
      // structural only: reasoning + big context, no catalogue match and no family
      entry(model("or", "guess", { capabilities: { output: ["text"], reasoning: true }, limit: { context: 500_000 } }), price(0.001, 0.001)),
    ],
    field,
  });
  const by = Object.fromEntries(r.candidates.map((c) => [c.modelID, c]));
  assert.equal(by["benched-good"].qualityKnown, true);
  assert.equal(by["fam"].qualityKnown, true);
  assert.equal(by["benched-bad"].qualityKnown, false, "a 0.05 percentile is below the gate");
  assert.equal(by["guess"].qualityKnown, false, "structural is a guess from size/price");
  assert.equal(by["guess"].basis, "structural");
  assert.deepEqual(r.candidates.map((c) => c.modelID), ["benched-good", "fam", "guess", "benched-bad"], "quality-passing by price, then the rest by price");
  assert.equal(r.pick.modelID, "benched-good");
});

test("an OpenRouter id is identified through the catalogue entry; with no catalogue only a family can pass", () => {
  const viaCatalogue = rankSummaryModels({
    entries: [entry(model("openrouter", "deepseek/deepseek-v4-flash"), price(0.1, 0.3), bench(70))],
    field,
  });
  assert.equal(viaCatalogue.pick?.modelID, "deepseek/deepseek-v4-flash");
  const noCatalogue = rankSummaryModels({
    entries: [entry(model("openrouter", "deepseek/deepseek-v4-flash"), price(0.1, 0.3), null), entry(model("anthropic", "claude-haiku-4", { family: "haiku" }), price(1, 5))],
    field: null,
  });
  assert.equal(noCatalogue.pick.modelID, "claude-haiku-4");
  assert.equal(noCatalogue.candidates.find((c) => c.providerID === "openrouter").qualityKnown, false);
});

test("a connected subscription provider wins over cheaper pay-per-token models; two subscriptions → lowest tier, then price", () => {
  const r = rankSummaryModels({
    entries: [
      entry(model("deepseek", "cheap", { family: "haiku" }), price(0.05, 0.1)),
      entry(model("anthropic", "claude-sonnet", { family: "sonnet" }), price(3, 15)),
      entry(model("anthropic", "claude-haiku", { family: "haiku" }), price(1, 5)),
      entry(model("openai", "gpt-5-codex", { family: "codex" }), null),
    ],
    subscriptionIds: new Set(["anthropic", "openai"]),
  });
  // fast tier first, then balanced by price (priced before unpriced), then the paid model
  assert.deepEqual(r.candidates.map((c) => c.modelID), ["claude-haiku", "claude-sonnet", "gpt-5-codex", "cheap"]);
  assert.equal(r.pick.modelID, "claude-haiku");
  assert.equal(r.candidates[0].priceLabel, "subscription");
  assert.equal(r.candidates[3].priceLabel, "$0.05 / $0.10 per M");
});

test("pay-per-token: blended list price input + output/25 ascending; unpriced after priced; ties → score → id (deterministic)", () => {
  const e = (id, p, family = "sonnet") => entry(model("p", id, { family }), p);
  const r = rankSummaryModels({
    entries: [
      e("z-unpriced", null),
      e("b-same", price(1, 5)),
      e("a-same", price(1, 5)),
      e("output-heavy", price(0.5, 100)), // 0.5 + 4 = 4.5
      e("input-heavy", price(4, 1)), // 4 + 0.04 = 4.04
      e("cheapest", price(0.3, 0.5)),
    ],
  });
  assert.deepEqual(r.candidates.map((c) => c.modelID), ["cheapest", "a-same", "b-same", "input-heavy", "output-heavy", "z-unpriced"]);
  assert.equal(blendedPrice(price(1, 5)), 1.2);
  assert.equal(blendedPrice({ input: 1 }), null);
  const again = rankSummaryModels({ entries: [...r.candidates.map((c) => entry(c.model, c.listPrice))].reverse() });
  assert.deepEqual(again.candidates.map((c) => c.modelID), r.candidates.map((c) => c.modelID), "input order does not change the result");
});

test("nothing passing the quality gate → pick null with the pinned reason; the candidates are still listed for a manual choice", () => {
  const r = rankSummaryModels({ entries: [entry(model("p", "mystery"), price(1, 1))] });
  assert.equal(r.pick, null);
  assert.equal(r.reason, NO_CAPABLE_MODEL_REASON);
  assert.equal(r.candidates.length, 1);
  assert.equal(rankSummaryModels({ entries: [] }).pick, null);
});

test("search finds an eligible model by name, id or provider; empty query lists in rank order; capped", () => {
  const entries = Array.from({ length: 60 }, (_, i) => entry(model("p", `m-${String(i).padStart(2, "0")}`, { family: "haiku", name: `Model ${i}` }), price(1 + i / 100, 5)));
  const { candidates } = rankSummaryModels({ entries });
  assert.equal(searchSummaryCandidates(candidates, "").length, 50);
  assert.equal(searchSummaryCandidates(candidates, "M-07")[0].modelID, "m-07");
  assert.equal(searchSummaryCandidates(candidates, "model 59").length, 1);
  assert.equal(searchSummaryCandidates(candidates, "p/m-3").length, 10);
  assert.equal(searchSummaryCandidates(candidates, "nope").length, 0);
});

test("shortlist caps at 30 and always includes the current model", () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(model("p", `m-${String(i).padStart(2, "0")}`, { family: "haiku" }), price(1 + i / 100, 5)));
  const { candidates } = rankSummaryModels({ entries });
  assert.equal(shortlist(candidates).length, 30);
  const cur = { providerID: "p", modelID: "m-39" };
  const withCur = shortlist(candidates, cur);
  assert.equal(withCur.length, 30);
  assert.ok(withCur.some((c) => c.modelID === "m-39"));
  assert.equal(shortlist(candidates, { providerID: "p", modelID: "gone" }).length, 30, "an unknown current model adds nothing");
});

test("publicCandidate carries only the contract fields; priceLabel for unpriced is null", () => {
  const { candidates } = rankSummaryModels({ entries: [entry(model("p", "m", { family: "haiku" }), null)] });
  assert.deepEqual(publicCandidate(candidates[0]), { providerID: "p", modelID: "m", name: "m", priceLabel: null, recommended: true, qualityKnown: true });
  assert.equal(priceLabelFor({ listPrice: price(0.8, 4), subscription: false }), "$0.80 / $4 per M");
});
