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

// Expiry is gated above the demand floor: when the offered work is below the weekly capacity, that
// much of the weekly must expire under ANY placement, so the gate measures only what a policy could
// have prevented (`expiredAboveFloor = max(0, expired − floor)`, floor = max(0, 1 − offered/capacity)). Two floors
// are computed (over the whole trace, and over each counted reset's preceding 7 days); the LOWER gates, so
// neither estimate can grant more excuse than it supports.
for (const scale of [0.4, 0.6]) {
  test(`scale ${scale}: after's expired weekly headroom above the demand floor is at most 60 % of baseline's`, async () => {
    const { b, a } = await resultsFor(scale);
    const ab = aggregate(b);
    const aa = aggregate(a);
    const base = ab.expiredAboveFloorPct.mean;
    const aft = aa.expiredAboveFloorPct.mean;
    const d = pairedDiff(b, a, (r) => r.expiredAboveFloorPct);
    const f = (x) => x.toFixed(2);
    assert.ok(base > 0, `the gate would be vacuous: baseline expires nothing above the floor (floor ${ab.floorPct.mean.toFixed(2)} (whole trace ${ab.wholeFloorPct.mean.toFixed(2)}, counted ${ab.countedFloorPct.mean.toFixed(2)}), expired ${ab.expiredPerSeatWeekPct.mean.toFixed(2)})`);
    assert.ok(
      aft <= 0.6 * base,
      `%/seat-wk — floor used ${f(ab.floorPct.mean)} (whole trace ${f(ab.wholeFloorPct.mean)}, counted seat-weeks ${f(ab.countedFloorPct.mean)}; the lower one gates); baseline expired ${f(ab.expiredPerSeatWeekPct.mean)} (above floor ${f(base)}), after expired ${f(aa.expiredPerSeatWeekPct.mean)} (above floor ${f(aft)}) = ${base > 0 ? ((100 * aft) / base).toFixed(0) : "n/a"} % of baseline (above-floor diff ${f(d.mean)} ± sd ${f(d.sd)} over ${SEEDS.length} seeds; gate 60 %)`,
    );
  });
}

test("a run is reproducible", async () => {
  const after = await loadPolicy("after");
  const run = () => runSeeds({ trace, policy: after, scale: 0.8, seeds: [SEEDS[1]] });
  assert.deepEqual(run(), run());
  assert.ok(mean(run().map((r) => r.servedPct)) > 50);
});
