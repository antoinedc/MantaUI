// Smoke tests for the seat replay harness skeleton (scripts/seats/replay.mjs) and
// its committed trace. The policy-vs-policy acceptance test is Phase 3's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, buildWorkload, loadTrace, loadPolicy, runSeeds, edfCounterexample, applyDecision, SEEDS } from "../../scripts/seats/replay.mjs";

const trace = loadTrace();

test("the committed trace is anonymous demand numbers plus weekly-reset phases", () => {
  assert.deepEqual(Object.keys(trace).sort(), ["K", "binMs", "demand", "endMs", "note", "seats", "startMs", "version"]);
  assert.equal(trace.seats.length, 10);
  assert.deepEqual(trace.seats.map((s) => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(trace.seats.map((s) => s.org), ["A", "A", "A", "A", "A", "B", "B", "B", "B", "B"]);
  for (const s of trace.seats) assert.deepEqual(Object.keys(s).sort(), ["id", "org", "weeklyResetAt"]);
  assert.equal(trace.demand.length, (trace.endMs - trace.startMs) / trace.binMs);
  assert.ok(trace.demand.every((d) => Number.isFinite(d) && d >= 0));
  assert.ok(JSON.stringify(trace).length < 200_000);
  assert.doesNotMatch(JSON.stringify(trace), /ses_|@/);
});

test("mulberry32 is deterministic per seed", () => {
  const a = mulberry32(11);
  const b = mulberry32(11);
  const seq = Array.from({ length: 5 }, () => a());
  assert.deepEqual(seq, Array.from({ length: 5 }, () => b()));
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(seq, Array.from({ length: 5 }, mulberry32(12)));
});

test("the offered workload depends only on the seed (and scale), never on a policy", () => {
  const w1 = buildWorkload(trace, { seed: 23, scale: 0.6 });
  const w2 = buildWorkload(trace, { seed: 23, scale: 0.6 });
  assert.deepEqual(w1.requestsByBin, w2.requestsByBin);
  const total = (w) => w.requestsByBin.flat().reduce((s, r) => s + r.d, 0);
  assert.ok(Math.abs(total(w1) - 0.6 * trace.demand.reduce((a, b) => a + b, 0)) < 1e-6, "every bin's demand is fully split over its conversations");
  assert.notDeepEqual(w1.requestsByBin, buildWorkload(trace, { seed: 24, scale: 0.6 }).requestsByBin);
});

test("the baseline policy runs end to end and is reproducible; its numbers are sane", async () => {
  const policy = await loadPolicy("baseline");
  const run = () => runSeeds({ trace, policy, scale: 0.6, seeds: SEEDS.slice(0, 2) });
  const a = run();
  assert.deepEqual(a, run());
  for (const r of a) {
    assert.ok(r.servedPct > 80 && r.servedPct <= 100, `served ${r.servedPct}`);
    assert.ok(r.expiredPerSeatWeekPct >= 0 && r.expiredPerSeatWeekPct < 100);
    assert.ok(r.moves > 0);
  }
  // Lag exercises the stale / not-started paths without breaking the run.
  const lagged = runSeeds({ trace, policy, scale: 0.6, seeds: [SEEDS[0]], lagMin: 10 });
  assert.ok(lagged[0].servedPct > 80);
});

test("`after` loads the live decideSeat; an unknown policy is refused", async () => {
  const after = await loadPolicy("after");
  assert.equal(after.name, "after");
  assert.equal(typeof after.decideSeat, "function");
  await assert.rejects(loadPolicy("nope"), /unknown policy/);
});

test("§2.5 counter-example: the baseline (least-loaded, no weekly deadline) serves 200 of 250", async () => {
  const r = edfCounterexample({ policy: await loadPolicy("baseline") });
  assert.equal(r.offered, 250);
  assert.ok(Math.abs(r.served - 200) < 1e-6, `served ${r.served}`);
});

test("applyDecision reproduces place()'s record updates", () => {
  const t = 1_000_000_000;
  const existing = { seatId: "a", left: { x: t - 10 * 3_600_000, y: t - 3_600_000 }, crossOrgMovedAt: t - 3_600_000 };
  const moved = applyDecision(existing, { reason: "moved", seatId: "b", from: "a", why: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false }, t, { model: "m" });
  assert.deepEqual(moved.left, { y: t - 3_600_000, a: t }, "stale blocks pruned, the seat just left is blocked");
  assert.equal(moved.crossOrgMovedAt, existing.crossOrgMovedAt, "the cross-org cap carries through a same-org move");
  assert.equal(moved.movedAt, t);
  assert.equal(moved.model, "m");
  const soon = applyDecision(existing, { reason: "moved", seatId: "b", from: "a", why: "reset-soon", crossOrg: false }, t);
  assert.equal(soon.left.a, undefined, "an optional reset-soon move leaves no block");
  const cross = applyDecision(existing, { reason: "moved", seatId: "b", from: "a", why: "exhausted", crossOrg: true }, t);
  assert.equal(cross.crossOrgMovedAt, t);
  const stamped = applyDecision(existing, { reason: "moved", seatId: "b", from: "a", why: "load", crossOrg: false }, t, { policy: { recordMove: (rec, d, ex, now) => void (rec.stampedAt = now) } });
  assert.equal(stamped.stampedAt, t);
  assert.deepEqual(applyDecision(null, { reason: "assigned", seatId: "a" }, t, { model: "m" }), { seatId: "a", assignedAt: t, lastUsedAt: t, model: "m" });
  assert.equal(applyDecision(existing, { reason: "kept", seatId: "a" }, t), existing);
});
