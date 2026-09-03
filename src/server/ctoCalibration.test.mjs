// BET-1518 — §9.5 per-class calibration: the Beta estimator, the §9.6
// verdict→outcome mapping, the last-30 window fold, and the store-backed
// engine (sink, plan outcomes, act-and-report queue).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALIBRATION_WINDOW,
  calibrationFromPayload,
  calibrationOf,
  createCtoCalibration,
  applyOutcomeToClasses,
  outcomeOfVerdict,
} from "./ctoCalibration.mjs";

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

test("calibrationOf: the §9.5 estimator is (successes+1)/(outcomes+2)", () => {
  assert.equal(calibrationOf(0, 0), 0.5); // fresh class
  // the D22 bootstrap walk: 3 accepted successes → 0.67 → 0.75 → 0.8
  assert.equal(calibrationOf(1, 1), (1 + 1) / 3);
  assert.equal(calibrationOf(2, 2), 3 / 4);
  assert.equal(calibrationOf(3, 3), 4 / 5);
  assert.equal(calibrationOf(28, 30), 29 / 32);
  // invalid reads are fresh, never NaN
  assert.equal(calibrationOf(NaN, NaN), 0.5);
  assert.equal(calibrationOf(-5, 2), 1 / 4);
});

test("calibrationFromPayload: missing row is 0.5; the window wins over stale counts", () => {
  assert.equal(calibrationFromPayload(null, "x"), 0.5);
  assert.equal(calibrationFromPayload({}, "x"), 0.5);
  assert.equal(calibrationFromPayload({ classes: {} }, "x"), 0.5);
  // counts-derived path when no window exists
  assert.equal(
    calibrationFromPayload({ classes: { a: { successes: 3, outcomes: 4 } } }, "a"),
    4 / 6,
  );
  // window-derived path: counts that disagree with the window are re-derived
  const win = [{ ok: true }, { ok: true }, { ok: false }];
  assert.equal(
    calibrationFromPayload({ classes: { a: { successes: 99, outcomes: 99, recent: win } } }, "a"),
    3 / 5,
  );
});

test("outcomeOfVerdict: the §9.6 calibration column", () => {
  assert.equal(outcomeOfVerdict("accept"), "success");
  assert.equal(outcomeOfVerdict("edit"), "success");
  assert.equal(outcomeOfVerdict("dismiss"), "failure");
  assert.equal(outcomeOfVerdict("correct"), "failure");
  // a never flag dominates whatever the verdict said
  assert.equal(outcomeOfVerdict("accept", true), "failure");
  assert.equal(outcomeOfVerdict("dismiss", true), "failure");
  // veto is not a gate verdict; open/expire never enter calibration
  assert.equal(outcomeOfVerdict("veto"), null);
  assert.equal(outcomeOfVerdict("open"), null);
  assert.equal(outcomeOfVerdict("expire"), null);
});

test("applyOutcomeToClasses: window trim at 30 and derived counts", () => {
  let classes = {};
  for (let i = 0; i < CALIBRATION_WINDOW + 5; i++) {
    classes = applyOutcomeToClasses(classes, "cls", i % 2 === 0, i);
  }
  const row = classes.cls;
  assert.equal(row.outcomes, CALIBRATION_WINDOW, "the window never exceeds 30");
  const oldest = row.recent[0]?.ts;
  assert.equal(oldest, 5, "the five oldest outcomes were evicted");
  const expected = row.recent.filter((e) => e?.ok === true).length;
  assert.equal(row.successes, expected, "successes are the window's derived count");
});

// ---------------------------------------------------------------------------
// Engine: the verdict sink fold
// ---------------------------------------------------------------------------

function makeMemStore(initial = {}) {
  let state = { v: 1, ...initial };
  return {
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async (payload) => {
      state = JSON.parse(JSON.stringify(payload ?? {}));
    },
  };
}

test("engine: a verdict sink folds suggestion-subject accept into the class window", async () => {
  const store = makeMemStore();
  const ledgerRows = [];
  const cal = createCtoCalibration({
    store,
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => 1000,
  });
  await cal.noteVerdictEffects({}, { subject: { type: "suggestion", id: "c1", class: "start-job" }, verdict: "accept" });
  const st = await cal.getState();
  assert.equal(st.classes["start-job"].successes, 1);
  assert.equal(st.classes["start-job"].outcomes, 1);
  assert.equal(st.classes["start-job"].calibration, (1 + 1) / (1 + 2));
  assert.ok(ledgerRows.some((r) => r.kind === "calibrate.fold" && r.class === "start-job" && r.outcome === "success"));
});

test("engine: plan-subject verdicts resolve their class from plans.json when unstamped", async () => {
  const store = makeMemStore();
  const plans = makeMemStore({
    records: {
      "f1": { findingId: "f1", plans: [{ id: "plan-1", class: "host-maintenance" }, { id: "plan-2", class: "other" }] },
    },
  });
  const ledgerRows = [];
  const cal = createCtoCalibration({
    store,
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => 1000,
  });
  // unstamped plan verdict → class from the plan row
  await cal.noteVerdictEffects({}, { subject: { type: "plan", id: "plan-1" }, verdict: "dismiss" });
  let st = await cal.getState();
  assert.equal(st.classes["host-maintenance"].outcomes, 1);
  assert.equal(st.classes["host-maintenance"].successes, 0);
  // a stamped subject wins over the lookup — and a SUCCESS verdict on a plan
  // subject that resolves in plans.json is DEFERRED to the executor (BET-1519
  // §9.5: one outcome per plan; the accept's own fold would double-count).
  // Dismiss/correct still fold immediately (dismissed-unexecuted / later-
  // negative are failures here).
  await cal.noteVerdictEffects({}, { subject: { type: "plan", id: "plan-2", class: "config-change" }, verdict: "edit" });
  st = await cal.getState();
  assert.equal(st.classes["config-change"], undefined);
  assert.ok(
    ledgerRows.some((r) => r.kind === "calibrate.fold" && r.outcome === "deferred-to-executor" && r.subjectId === "plan-2"),
  );
});

test("engine: accept on a plan subject DEFERS to the executor; the engine's isPlanSubject wins", async () => {
  const store = makeMemStore();
  const ledgerRows = [];
  const plans = makeMemStore({
    records: { "f1": { findingId: "f1", plans: [{ id: "plan-9", class: "host-maintenance" }] } },
  });
  const cal = createCtoCalibration({
    store,
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => 1000,
    isPlanSubject: async (planId) => planId === "plan-9",
  });
  // the stamped class + the plans.json hit → the accept fold is deferred
  await cal.noteVerdictEffects({}, { subject: { type: "plan", id: "plan-9", class: "host-maintenance" }, verdict: "accept" });
  let st = await cal.getState();
  assert.equal(st.classes["host-maintenance"], undefined);
  assert.ok(ledgerRows.some((r) => r.outcome === "deferred-to-executor" && r.subjectId === "plan-9"));
  // dismiss on the same plan subject folds failure immediately
  await cal.noteVerdictEffects({}, { subject: { type: "plan", id: "plan-9", class: "host-maintenance" }, verdict: "dismiss" });
  st = await cal.getState();
  assert.equal(st.classes["host-maintenance"].outcomes, 1);
  assert.equal(st.classes["host-maintenance"].successes, 0);
});

test("engine: veto/open/expire verdicts never fold; unknown subjects never fold", async () => {
  const store = makeMemStore();
  const cal = createCtoCalibration({ store, ledger: { append: async () => {} }, now: () => 1000 });
  await cal.noteVerdictEffects({}, { subject: { type: "suggestion", id: "c", class: "start-job" }, verdict: "veto" });
  await cal.noteVerdictEffects({}, { subject: { type: "suggestion", id: "c", class: "start-job" }, verdict: "open" });
  await cal.noteVerdictEffects({}, { subject: { type: "veto-window", id: "v", class: "queue-tonight" }, verdict: "veto" });
  await cal.noteVerdictEffects({}, { subject: { type: "plan", id: "p" }, verdict: "accept" }); // no class, no plans store
  const st = await cal.getState();
  assert.deepEqual(st.classes, {});
});

test("engine: notePlanOutcome folds an executor outcome directly", async () => {
  const store = makeMemStore();
  const cal = createCtoCalibration({ store, ledger: { append: async () => {} }, now: () => 1000 });
  await cal.notePlanOutcome({ planId: "p1", class: "config-change", ok: true });
  await cal.notePlanOutcome({ planId: "p1", class: "config-change", ok: false });
  const st = await cal.getState();
  assert.equal(st.classes["config-change"].successes, 1);
  assert.equal(st.classes["config-change"].outcomes, 2);
  const missing = await cal.notePlanOutcome({ ok: true });
  assert.equal(missing.ok, false);
});

test("engine: recordAct queues the mandatory digest report; markAnnounced consumes it", async () => {
  const store = makeMemStore();
  const ledgerRows = [];
  const cal = createCtoCalibration({
    store,
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => 2000,
  });
  await cal.recordAct({ cls: "queue-tonight", text: "Acted on my own (queue-tonight)", action: { type: "queue-tonight" } });
  let pending = await cal.listAnnouncements();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "act");
  assert.match(pending[0].text, /^Acted on my own/);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.act" && r.class === "queue-tonight"));
  await cal.markAnnounced(pending.map((a) => a.id));
  pending = await cal.listAnnouncements();
  assert.equal(pending.length, 0);
});

test("engine: an unreadable store never throws — every class reads fresh (0.5)", async () => {
  const cal = createCtoCalibration({
    store: { load: async () => { throw new Error("disk gone"); }, save: async () => {} },
    ledger: { append: async () => {} },
    now: () => 1000,
  });
  assert.equal(await cal.calibration("start-job"), 0.5);
  const st = await cal.getState();
  assert.deepEqual(st.classes, {});
});
