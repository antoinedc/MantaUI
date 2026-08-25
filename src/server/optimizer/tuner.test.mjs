// Tests for optimizer/tuner.mjs — the conservative bandit that earns its own
// parameter changes (Optimizer P2.5, BET-1347). Pure/injected throughout: the
// policy store load/save, tuner-state load/save, clock, activity log and
// guardrail observer are all stubbed in-memory. Run via `npm run test:server`
// (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTuner,
  countRefetchChurn,
  nextTuneStep,
  TUNE_STEPS,
  TUNE_MIN_NEW_SESSIONS,
  TUNE_OBSERVE_MS,
  DEFAULT_TUNED,
} from "./tuner.mjs";

function makeTuner({ enabled = true, now, directory = "/repo", policy = {}, sessionCount = 100 } = {}) {
  let table = { repos: { [directory]: { ...policy } } };
  let policyWrites = 0;
  let tunerState = {};
  const activity = [];
  let clock = typeof now === "function" ? now() : (now ?? 1_700_000_000_000);

  const tuner = createTuner({
    directory,
    load: async () => JSON.parse(JSON.stringify(table)),
    save: async (t) => {
      table = JSON.parse(JSON.stringify(t));
      policyWrites++;
    },
    loadTunerState: async () => tunerState,
    saveTunerState: async (s) => {
      tunerState = s;
    },
    enabled: () => enabled,
    now: () => clock,
    sessionCount: () => sessionCount,
    activityLog: {
      append: async (e) => {
        activity.push(e);
        return { ok: true, entry: e };
      },
    },
  });

  return {
    tuner,
    advance: (ms) => (clock += ms),
    getTable: () => table,
    policyWrites: () => policyWrites,
    activity: () => activity,
  };
}

test("nextTuneStep: moves exactly one parameter one ladder rung toward aggressive (lower)", () => {
  // maskAfterUses cycles first: 20 -> 16 (one step, never more).
  const step = nextTuneStep({ maskAfterUses: 20, batchTokens: 40_000, protectTailTokens: 60_000 });
  assert.deepEqual(step, { param: "maskAfterUses", from: 20, to: 16 });

  // maskAfterUses already at its most aggressive rung -> batchTokens moves.
  const step2 = nextTuneStep({ maskAfterUses: 8, batchTokens: 40_000, protectTailTokens: 60_000 });
  assert.deepEqual(step2, { param: "batchTokens", from: 40_000, to: 20_000 });

  // Every param at the aggressive end -> nothing to tune.
  const none = nextTuneStep({ maskAfterUses: 8, batchTokens: 10_000, protectTailTokens: 24_000 });
  assert.equal(none, null);

  // Defaults (DEFAULT_TUNED = 12 / 20k / 40k) can move: mask 12 -> 10.
  const def = nextTuneStep({});
  assert.equal(def.param, "maskAfterUses");
  assert.equal(def.from, DEFAULT_TUNED.maskAfterUses);
  assert.equal(def.to, 10);
});

test("countRefetchChurn: counts a re-run whose earlier output was masked, ignores the rest", () => {
  // Chronological fixture. Entry 2 masks a read_file output; entry 3 re-runs
  // the SAME (session, tool, input) after the mask -> churn. Entries 4-6 are
  // different session / different tool / different input / never masked -> no
  // churn.
  const rows = [
    { sessionID: "a", tool: "read_file", input: { path: "x" }, output: "real v1" },
    { sessionID: "a", tool: "read_file", input: { path: "x" }, output: "[manta: trimmed - re-run read_file with {\"path\":\"x\"}]" },
    { sessionID: "a", tool: "read_file", input: { path: "x" }, output: "real v2" }, // churn
    { sessionID: "b", tool: "read_file", input: { path: "x" }, output: "real" }, // diff session
    { sessionID: "a", tool: "ls", input: { dir: "y" }, output: "real" }, // diff tool, never masked
    { sessionID: "a", tool: "read_file", input: { path: "z" }, output: "real" }, // diff input
  ];
  const res = countRefetchChurn(rows);
  assert.equal(res.count, 1);
  assert.equal(res.masked, 1);
  assert.equal(res.ratio, 1);
});

test("countRefetchChurn: an un-masked re-run is NOT churn, empty/failed input -> zero", () => {
  // A real tool re-uses its own output across time but was never masked -> no
  // churn.
  const rows = [
    { sessionID: "a", tool: "grep", input: { q: "x" }, output: "out1" },
    { sessionID: "a", tool: "grep", input: { q: "x" }, output: "out2" },
  ];
  assert.deepEqual(countRefetchChurn(rows), { count: 0, masked: 0, ratio: 0 });
  assert.deepEqual(countRefetchChurn(null), { count: 0, masked: 0, ratio: 0 });
  assert.deepEqual(countRefetchChurn("nope"), { count: 0, masked: 0, ratio: 0 });
});

test("tuner: disabled -> no policy write, no activity, no-op", async () => {
  const h = makeTuner({ enabled: false, policy: { maskAfterUses: 20 } });
  const res = await h.tuner.tune({
    sessionCount: 200,
    guardrail: { tripped: true, which: "churn" },
    ecoChanged: true,
  });
  assert.equal(res.action, "no-op");
  assert.equal(h.policyWrites(), 0);
  assert.equal(h.activity().length, 0);
});

test("tuner: a positive trigger applies one step and writes the policy once", async () => {
  const h = makeTuner({ directory: "/repo", policy: { maskAfterUses: 20, batchTokens: 40_000, protectTailTokens: 60_000 } });
  const res = await h.tuner.tune({ sessionCount: 120, newSessions: TUNE_MIN_NEW_SESSIONS });
  assert.equal(res.action, "applied");
  assert.equal(res.param, "maskAfterUses");
  assert.equal(res.to, 16);
  assert.equal(h.policyWrites(), 1);
  assert.equal(h.getTable().repos["/repo"].maskAfterUses, 16);
  // No activity entry yet — it settles when kept/reverted.
  assert.equal(h.activity().length, 0);
});

test("tuner: each guardrail trips and reverts, naming itself, restoring the old value", async () => {
  for (const which of ["cache-hit", "churn", "cost-per-turn"]) {
    const h = makeTuner({ directory: "/repo", policy: { maskAfterUses: 20, batchTokens: 40_000, protectTailTokens: 60_000 } });
    await h.tuner.tune({ sessionCount: 120 }); // apply maskAfterUses 20 -> 16
    assert.equal(h.getTable().repos["/repo"].maskAfterUses, 16);
    // Guardrail trips during the observation window.
    const res = await h.tuner.tune({
      guardrail: { tripped: true, which, evidence: { [which === "cache-hit" ? "hitDropPts" : which === "churn" ? "churn" : "wow"]: 0.5 } },
    });
    assert.equal(res.action, "reverted");
    assert.equal(res.guardrail, which);
    // Old value restored (writes: 1 apply + 1 restore = 2).
    assert.equal(h.getTable().repos["/repo"].maskAfterUses, 20);
    assert.equal(h.policyWrites(), 2);
    const entry = h.activity()[0];
    assert.equal(entry.verdict, "rolled-back");
    assert.equal(entry.evidence.guardrail, which);
    assert.equal(entry.from, 20);
    assert.equal(entry.to, 20);
  }
});

test("tuner: a kept change writes the policy file exactly once (apply), value stays, activity records kept", async () => {
  const h = makeTuner({ directory: "/repo", policy: { maskAfterUses: 20, batchTokens: 40_000, protectTailTokens: 60_000 } });
  await h.tuner.tune({ sessionCount: 120 }); // apply: maskAfterUses 20 -> 16 (write #1)
  assert.equal(h.policyWrites(), 1);
  // Advance past the observation window with no guardrail trip.
  h.advance(TUNE_OBSERVE_MS + 1000);
  const res = await h.tuner.tune({ sessionCount: 121 });
  assert.equal(res.action, "kept");
  // Kept does NOT rewrite policy — still the applied value, still 1 write.
  assert.equal(h.policyWrites(), 1);
  assert.equal(h.getTable().repos["/repo"].maskAfterUses, 16);
  const entry = h.activity()[0];
  assert.equal(entry.verdict, "kept");
  assert.equal(entry.from, 20);
  assert.equal(entry.to, 16);
});

test("tuner: no trigger -> no tune; backstop sweep with no trigger also no-op", async () => {
  const h = makeTuner({ directory: "/repo", policy: { maskAfterUses: 20 } });
  const res = await h.tuner.tune({ sessionCount: 5 }); // only 5 new sessions, no trigger
  assert.equal(res.action, "no-tune");
  assert.equal(h.policyWrites(), 0);
});

test("tuner: snapshot reflects pending + last counters", async () => {
  const h = makeTuner({ directory: "/repo", policy: { maskAfterUses: 20 } });
  await h.tuner.tune({ sessionCount: 120 });
  const snap = await h.tuner.snapshot();
  assert.equal(snap.pending.param, "maskAfterUses");
  assert.equal(snap.lastSessionCount, 120);
});
