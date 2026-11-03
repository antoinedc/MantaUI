// Acceptance for the weekly-deadline seat rules (spec 2026-11-03-seat-placement-weekly-deadline §8):
// the live `decideSeat` against the pinned pre-change code, over the committed demand trace, with the
// offered work identical per seed. Lives here (not in scripts/) because the test globs cover src/server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTrace, loadPolicy, runSeeds, aggregate, pairedDiff, edfCounterexample, SEEDS, mean } from "../../scripts/seats/replay.mjs";
import { legacyMode } from "../shared/seatChoice.mjs";

const trace = loadTrace();
const SCALES = [0.4, 0.6, 0.8, 1.0];

// The whole run is a few seconds, so all five fixed seeds are used.
const results = new Map();
async function resultsFor(scale) {
  if (!results.has(scale)) {
    const [baseline, after] = await Promise.all([loadPolicy("baseline"), loadPolicy("after")]);
    const b = runSeeds({ trace, policy: baseline, scale, seeds: SEEDS });
    const a = runSeeds({ trace, policy: after, scale, seeds: SEEDS });
    results.set(scale, { b, a });
  }
  return results.get(scale);
}

test("the harness feeds `after` fresh weekly readings with resetsAt: it never runs in legacy mode after warm-up", async () => {
  const after = await loadPolicy("after");
  let bins = 0;
  let legacy = 0;
  runSeeds({
    trace,
    policy: after,
    scale: 0.6,
    seeds: [SEEDS[0]],
    probe: (snaps, { nowMs, measured, model }) => {
      if (!measured) return;
      bins++;
      assert.ok(snaps.every((s) => s.windows.some((w) => w.kind === "weekly" && Number.isFinite(w.resetsAt))), "every seat reports a weekly with a reset");
      if (legacyMode(snaps, { nowMs, model })) legacy++;
    },
  });
  assert.ok(bins > 1000, `probed ${bins} bins`);
  assert.equal(legacy, 0, "legacyMode must be false for every measured bin");
});

test("§2.5 counter-example: the earliest-deadline rule serves 250 of 250 (the baseline 200)", async () => {
  const r = edfCounterexample({ policy: await loadPolicy("after") });
  assert.equal(r.offered, 250);
  assert.ok(Math.abs(r.served - 250) < 1e-6, `served ${r.served}`);
});

for (const scale of SCALES) {
  test(`scale ${scale}: after serves at least baseline − 0.5 pt`, async () => {
    const { b, a } = await resultsFor(scale);
    const base = aggregate(b).servedPct.mean;
    const aft = aggregate(a).servedPct.mean;
    const d = pairedDiff(b, a, (r) => r.servedPct);
    assert.ok(aft >= base - 0.5, `served: baseline ${base.toFixed(2)} after ${aft.toFixed(2)} (diff ${d.mean.toFixed(2)} ± sd ${d.sd.toFixed(2)} over ${SEEDS.length} seeds)`);
  });
}

for (const scale of [0.4, 0.6]) {
  test(`scale ${scale}: after's expired weekly headroom is at most 60 % of baseline's`, async () => {
    const { b, a } = await resultsFor(scale);
    const base = aggregate(b).expiredPerSeatWeekPct.mean;
    const aft = aggregate(a).expiredPerSeatWeekPct.mean;
    const d = pairedDiff(b, a, (r) => r.expiredPerSeatWeekPct);
    assert.ok(aft <= 0.6 * base, `expired %/seat-wk: baseline ${base.toFixed(2)} after ${aft.toFixed(2)} = ${((100 * aft) / base).toFixed(0)} % of baseline (diff ${d.mean.toFixed(2)} ± sd ${d.sd.toFixed(2)} over ${SEEDS.length} seeds; gate 60 %)`);
  });
}

test("a run is reproducible", async () => {
  const after = await loadPolicy("after");
  const run = () => runSeeds({ trace, policy: after, scale: 0.8, seeds: [SEEDS[1]] });
  assert.deepEqual(run(), run());
  assert.ok(mean(run().map((r) => r.servedPct)) > 50);
});
