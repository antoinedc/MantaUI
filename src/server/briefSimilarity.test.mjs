// The similarity fixture and the tuning sweep (spec 2026-11-28-research-layer.md §6.5, AC-4.2).
// The threshold in the code is NOT chosen by hand: this test sweeps 0.10–0.60 over the labelled pairs of
// fixtures/briefSimilarity.json, picks the best one, asserts the AC-4.2 targets at it, and asserts the constant equals the pick.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SIMILARITY_THRESHOLD, SUPPRESSION_FACTOR, lineKeysOf, learnedLineSet, signatureOf, buildStats, similarity } from "./briefSimilarity.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/briefSimilarity.json", import.meta.url), "utf-8"));
const LABELS = ["paraphrase", "templated", "hard-negative", "negative"];

/** The scores of every pair, computed the way the box computes them: line statistics and token statistics over a background corpus (the fixture's own briefs). */
function scorePairs(pairs) {
  const raws = pairs.flatMap((p) => [p.a, p.b]);
  const lineDf = new Map();
  for (const r of raws) for (const k of new Set(lineKeysOf(r.brief))) lineDf.set(k, (lineDf.get(k) ?? 0) + 1);
  const learnedLines = learnedLineSet(lineDf, raws.length);
  const sigOf = new Map(raws.map((r) => [r, signatureOf(r, { learnedLines })]));
  const stats = buildStats([...sigOf.values()]);
  return pairs.map((p) => ({ pair: p, score: similarity(sigOf.get(p.a), sigOf.get(p.b), stats) }));
}

/** Precision/recall of "score ≥ threshold ⇒ same kind of work". No prediction at all counts as precision 1 (nothing was wrongly offered). */
function measure(scored, threshold) {
  let tp = 0, fp = 0, fn = 0;
  const byLabel = Object.fromEntries(LABELS.map((l) => [l, { hit: 0, n: 0 }]));
  for (const { pair, score } of scored) {
    const predicted = score >= threshold;
    byLabel[pair.label].n++;
    if (predicted) byLabel[pair.label].hit++;
    if (predicted && pair.same) tp++;
    else if (predicted && !pair.same) fp++;
    else if (!predicted && pair.same) fn++;
  }
  return {
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    templatedRecall: byLabel.templated.hit / byLabel.templated.n,
    hardNegativeLeaks: byLabel["hard-negative"].hit,
    byLabel,
  };
}

const sweep = () => {
  const scored = scorePairs(fixture.pairs);
  const out = [];
  for (let i = 0; i <= 20; i++) {
    const threshold = Math.round((0.1 + i * 0.025) * 1000) / 1000;
    out.push({ threshold, ...measure(scored, threshold) });
  }
  return { scored, rows: out };
};

/** AC-4.2's four conditions at one threshold. */
const meetsTargets = (m) => m.precision >= 0.9 && m.recall >= 0.6 && m.templatedRecall >= 0.8 && m.hardNegativeLeaks === 0;

describe("the labelled fixture (AC-4.2)", () => {
  test("has at least 60 pairs in the four kinds the spec lists", () => {
    const n = (l) => fixture.pairs.filter((p) => p.label === l).length;
    assert.ok(fixture.pairs.length >= 60, `${fixture.pairs.length} pairs`);
    assert.ok(n("paraphrase") >= 20 && n("templated") >= 10 && n("hard-negative") >= 20 && n("negative") >= 10);
    assert.ok(fixture.pairs.every((p) => p.a.title && p.a.brief && p.b.title && p.b.brief), "each pair is {title, brief} x 2");
    assert.ok(new Set(fixture.pairs.map((p) => p.id)).size === fixture.pairs.length, "ids are unique");
  });

  test("some threshold meets precision ≥ 0.90, recall ≥ 0.60, templated recall ≥ 0.80 and keeps every hard negative apart", () => {
    const { rows } = sweep();
    const ok = rows.filter(meetsTargets);
    assert.ok(ok.length > 0, `no threshold meets the targets:\n${rows.map((r) => `${r.threshold}: P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)} T=${r.templatedRecall.toFixed(2)} leaks=${r.hardNegativeLeaks}`).join("\n")}`);
  });

  test("the shipped threshold is the one the sweep picks (highest recall among those meeting the targets; the highest threshold on a tie)", () => {
    const { rows } = sweep();
    const ok = rows.filter(meetsTargets);
    assert.ok(ok.length > 0, "no threshold meets the targets");
    const best = ok.reduce((a, b) => (b.recall > a.recall || (b.recall === a.recall && b.threshold > a.threshold) ? b : a));
    assert.equal(SIMILARITY_THRESHOLD, best.threshold, `re-tune: the sweep now picks ${best.threshold}`);
    const m = rows.find((r) => r.threshold === SIMILARITY_THRESHOLD);
    assert.ok(meetsTargets(m), "targets hold at the shipped threshold");
  });

  test("the suppression bar is 0.8 × the clustering threshold", () => {
    assert.equal(SUPPRESSION_FACTOR, 0.8);
  });
});
