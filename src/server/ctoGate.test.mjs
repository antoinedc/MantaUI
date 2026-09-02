// BET-1518 — §9.3 the gate: the pure act/ask/none decision, highest-effective
// plan selection, τ extremes, and the plans.json pass (act via the executor
// seam, ask cards, per-record dedupe, silent-log rows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAU, clampTau, createCtoGate, evaluateGate } from "./ctoGate.mjs";

const PLAN = (id, cls, confidence) => ({ id, class: cls, confidence });

// ---------------------------------------------------------------------------
// Pure gate
// ---------------------------------------------------------------------------

test("evaluateGate: no plans → none; empty/junk arrays too", () => {
  assert.deepEqual(evaluateGate({ plans: [], tau: 0.7 }), { verb: "none" });
  assert.deepEqual(evaluateGate({ plans: [null, 3, "x"], tau: 0.7 }), { verb: "none" });
  assert.deepEqual(evaluateGate({ tau: 0.7 }), { verb: "none" });
});

test("evaluateGate: effective = confidence × calibration; ≥ τ acts, < τ asks", () => {
  // 0.9 × 0.8 = 0.72 ≥ 0.7 → act
  assert.equal(evaluateGate({ plans: [PLAN("p", "start-job", 0.9)], tau: 0.7, calibration: { "start-job": 0.8 } }).verb, "act");
  // 0.9 × 0.7 = 0.63 < 0.7 → ask
  assert.equal(evaluateGate({ plans: [PLAN("p", "start-job", 0.9)], tau: 0.7, calibration: { "start-job": 0.7 } }).verb, "ask");
  // fresh class (absent from the map) = 0.5 → 0.9 × 0.5 = 0.45 < 0.7 → ask
  const fresh = evaluateGate({ plans: [PLAN("p", "host-maintenance", 0.9)], tau: 0.7, calibration: {} });
  assert.equal(fresh.verb, "ask");
  assert.equal(fresh.effective, 0.45);
});

test("evaluateGate: the highest-effective plan wins; the rest ride along", () => {
  const r = evaluateGate({
    plans: [PLAN("p1", "start-job", 0.6), PLAN("p2", "start-job", 0.99), PLAN("p3", "start-job", 0.3)],
    tau: 0.7,
    calibration: { "start-job": 1.0 },
  });
  assert.equal(r.verb, "act");
  assert.equal(r.plan.id, "p2");
  assert.deepEqual(r.others.map((p) => p.id), ["p1", "p3"]);
  // ties keep the first
  const tie = evaluateGate({ plans: [PLAN("a", "x", 0.5), PLAN("b", "x", 0.5)], tau: 0.4, calibration: { x: 1.0 } });
  assert.equal(tie.plan.id, "a");
});

test("evaluateGate: τ extremes — τ 1 never acts, τ 0 always acts", () => {
  const plans = [PLAN("p", "x", 0.99)];
  assert.equal(evaluateGate({ plans, tau: 1, calibration: { x: 1.0 } }).verb, "ask");
  assert.equal(evaluateGate({ plans, tau: 0, calibration: { x: 1.0 } }).verb, "act");
  // even a zero-confidence plan acts at τ 0 (act, never ask)
  assert.equal(evaluateGate({ plans: [PLAN("p", "x", 0)], tau: 0, calibration: { x: 0.5 } }).verb, "act");
});

test("clampTau: non-finite → default 0.7; out-of-range clamps into [0,1]", () => {
  assert.equal(DEFAULT_TAU, 0.7);
  assert.equal(clampTau(NaN), 0.7);
  assert.equal(clampTau("bogus"), 0.7);
  assert.equal(clampTau(-1), 0);
  assert.equal(clampTau(3), 1);
  assert.equal(clampTau(0.55), 0.55);
});

test("evaluateGate: no class special-casing — config-change and tool-write are ordinary classes", () => {
  for (const cls of ["config-change", "tool-write"]) {
    assert.equal(
      evaluateGate({ plans: [PLAN("p", cls, 1.0)], tau: 0.7, calibration: { [cls]: 1.0 } }).verb,
      "act",
      `${cls}: a fully-calibrated max-confidence plan acts like any other`,
    );
  }
});

// ---------------------------------------------------------------------------
// The plans.json pass
// ---------------------------------------------------------------------------

function makePlansStore(records = {}) {
  let state = { v: 1, records: JSON.parse(JSON.stringify(records)) };
  return {
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async (payload) => {
      state = JSON.parse(JSON.stringify(payload ?? {}));
    },
  };
}

function makeCards() {
  const written = [];
  return {
    written,
    upsertDecision: async (c) => {
      const prev = written.find((w) => w.id === c.id);
      if (prev) Object.assign(prev, c);
      else written.push(c);
      return { ok: true, changed: !prev, isNew: !prev };
    },
  };
}

test("gatePass: an act-worthy record executes once and stamps the record", async () => {
  const executed = [];
  const plans = makePlansStore({
    f1: { findingId: "f1", finding: { text: "stale cache", refs: ["m1"] }, plans: [PLAN("pl1", "start-job", 0.95)] },
  });
  const ledgerRows = [];
  const g = createCtoGate({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    cards: makeCards(),
    now: () => 500,
    tau: async () => 0.7,
    calibrationOf: async () => ({ "start-job": 1.0 }),
    executePlan: async (plan) => {
      executed.push(plan.id);
      return { ok: true };
    },
    recordAct: async () => ({}),
  });
  const r1 = await g.gatePass();
  assert.deepEqual({ records: r1.records, acted: r1.acted }, { records: 1, acted: 1 });
  assert.deepEqual(executed, ["pl1"]);
  assert.ok(ledgerRows.some((row) => row.kind === "gate.acted" && row.planId === "pl1"));
  // the record is consumed: a second pass re-gates nothing
  const r2 = await g.gatePass();
  assert.equal(r2.records, 0);
  assert.deepEqual(executed, ["pl1"]);
  const after = await plans.load();
  assert.equal(after.records.f1.gated.verb, "act");
});

test("gatePass: below-τ record emits exactly one ask card (Do it first, effective as score)", async () => {
  const plans = makePlansStore({
    f1: {
      findingId: "f1",
      finding: { text: "flaky probe", refs: ["a1"] },
      plans: [PLAN("pl-low", "start-job", 0.9)],
    },
  });
  const cards = makeCards();
  const ledgerRows = [];
  const g = createCtoGate({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    cards,
    now: () => 500,
    tau: async () => 0.7,
    calibrationOf: async () => ({ "start-job": 0.5 }), // 0.9 × 0.5 = 0.45 < 0.7
    executePlan: async () => ({ ok: true }), // would act if asked — proves the gate asks
  });
  const r = await g.gatePass();
  assert.equal(r.acted, 0);
  assert.equal(r.asked, 1);
  const card = cards.written[0];
  assert.equal(card.id, "pl-low");
  assert.equal(card.variant, "decision");
  assert.equal(card.cls, "start-job");
  assert.equal(card.score, 0.45);
  assert.equal(card.options[0].label, "Do it");
  assert.equal(card.options[0].answer, "accept");
  assert.equal(card.options[0].action.type, "plan");
  assert.ok(ledgerRows.some((row) => row.kind === "gate.asked" && row.cardId === "pl-low"));
  // second pass: the record is consumed → no duplicate card
  const r2 = await g.gatePass();
  assert.equal(r2.asked, 0);
  assert.equal(cards.written.length, 1);
});

test("gatePass: a plan-less record silent-logs for the §14.3 audit", async () => {
  const plans = makePlansStore({
    f1: { findingId: "f1", finding: { text: "orphan finding" }, plans: [] },
  });
  const ledgerRows = [];
  const g = createCtoGate({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    cards: makeCards(),
    now: () => 500,
    tau: async () => 0.7,
  });
  const r = await g.gatePass();
  assert.equal(r.none, 1);
  assert.ok(ledgerRows.some((row) => row.kind === "gate.none" && row.findingId === "f1" && row.reason === "no-plan"));
  const after = await plans.load();
  assert.equal(after.records.f1.gated.verb, "none");
});

test("gatePass: an unwired executor degrades the act to the ask card (reason no-executor)", async () => {
  const plans = makePlansStore({
    f1: { findingId: "f1", finding: { text: "act-worthy" }, plans: [PLAN("pl-act", "config-change", 1.0)] },
  });
  const cards = makeCards();
  const g = createCtoGate({
    plans,
    ledger: { append: async () => {} },
    cards,
    now: () => 500,
    tau: async () => 0.7,
    calibrationOf: async () => ({ "config-change": 1.0 }),
    executePlan: null, // BET-1519 wires it
  });
  const r = await g.gatePass();
  assert.equal(r.acted, 0);
  assert.equal(r.asked, 1);
  assert.equal(cards.written[0].id, "pl-act");
  // config-change is NOT special-cased: the only thing between the plan and
  // execution was the missing executor.
});

test("gatePass: a re-triage overwrites the record → the new plans re-gate", async () => {
  const plans = makePlansStore({
    f1: { findingId: "f1", finding: { text: "v1" }, plans: [PLAN("pl-a", "start-job", 0.99)] },
  });
  let executed = 0;
  const g = createCtoGate({
    plans,
    ledger: { append: async () => {} },
    cards: makeCards(),
    now: () => 500,
    tau: async () => 0.7,
    calibrationOf: async () => ({ "start-job": 1.0 }),
    executePlan: async () => ({ ok: true, executed: ++executed }),
  });
  await g.gatePass();
  assert.equal(executed, 1);
  // re-triage replaces the record body (the gated stamp disappears)
  await plans.save({ v: 1, records: { f1: { findingId: "f1", finding: { text: "v2" }, plans: [PLAN("pl-b", "start-job", 0.99)], triagedAt: 900 } } });
  const r2 = await g.gatePass();
  assert.equal(r2.records, 1);
  assert.equal(executed, 2);
});

test("gatePass: multiple plans on one record — only the best executes, never more than one", async () => {
  const executed = [];
  const plans = makePlansStore({
    f1: {
      findingId: "f1",
      finding: { text: "multi" },
      plans: [PLAN("pl-1", "start-job", 0.7), PLAN("pl-2", "start-job", 0.99), PLAN("pl-3", "start-job", 0.5)],
    },
  });
  const g = createCtoGate({
    plans,
    ledger: { append: async () => {} },
    cards: makeCards(),
    now: () => 500,
    tau: async () => 0.7,
    calibrationOf: async () => ({ "start-job": 1.0 }),
    executePlan: async (plan) => {
      executed.push(plan.id);
      return { ok: true };
    },
  });
  const r = await g.gatePass();
  assert.equal(r.acted, 1);
  assert.deepEqual(executed, ["pl-2"], "only the highest-effective plan executes");
});

test("gatePass: no plans store or unreadable store → a no-op pass that never throws", async () => {
  const g1 = createCtoGate({ plans: null, tau: async () => 0.7 });
  assert.deepEqual(await g1.gatePass(), { records: 0, acted: 0, asked: 0, none: 0 });
  const g2 = createCtoGate({ plans: { load: async () => { throw new Error("gone"); } }, tau: async () => 0.7 });
  assert.deepEqual(await g2.gatePass(), { records: 0, acted: 0, asked: 0, none: 0 });
});

test("gatePass: τ reads live from the config seam per pass", async () => {
  let tauValue = 0.7;
  const plans = makePlansStore({
    f1: { findingId: "f1", finding: { text: "t" }, plans: [PLAN("p", "x", 0.75)] },
  });
  let executed = 0;
  const g = createCtoGate({
    plans,
    ledger: { append: async () => {} },
    cards: makeCards(),
    now: () => 500,
    tau: async () => tauValue,
    calibrationOf: async () => ({ x: 1.0 }),
    executePlan: async () => ({ ok: true, executed: ++executed }),
  });
  const r1 = await g.gatePass(); // 0.75 ≥ 0.7 → act, consumed
  assert.equal(r1.acted, 1);
  await plans.save({ v: 1, records: { f1: { findingId: "f1", finding: { text: "t" }, plans: [PLAN("p", "x", 0.75)] } } });
  tauValue = 0.9; // raise the bar → the same candidate now asks
  const r2 = await g.gatePass();
  assert.equal(r2.acted, 0);
  assert.equal(r2.asked, 1);
});
