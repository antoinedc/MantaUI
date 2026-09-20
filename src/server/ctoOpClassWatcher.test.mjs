// ctoOpClassWatcher.test.mjs — BET-1533: pure predicate tests for the
// operation-class outcome watcher. Hermetic — no fs, no stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOpClass,
  formatOpClassReason,
  opClassOf,
  OP_CLASS_BLOCK_WINDOW,
  OP_CLASS_BLOCK_SPAN_MS,
  OP_CLASS_DEGRADED_WINDOW,
  OP_CLASS_OUTCOME_KIND,
} from "./ctoOpClassWatcher.mjs";

const HOUR = OP_CLASS_BLOCK_SPAN_MS;
const T0 = 1_789_429_793_440; // 2026-09-14T23:49:53Z — the outage window start

let seq = 0;
// One outcome row. Defaults: a segment-summary model-error at a moving ts.
// `operation` is omitted entirely unless provided (the taskClass-fallback
// tests rely on the key being absent).
function row({ ts = (T0 += 1), operation, code = "model-error", taskClass, kind } = {}) {
  seq += 1;
  return {
    kind: kind ?? OP_CLASS_OUTCOME_KIND,
    ts,
    ...(operation !== undefined ? { operation } : {}),
    ...(taskClass !== undefined ? { taskClass } : {}),
    code,
  };
}

const fail = (over = {}) => row({ operation: "segment-summary", code: "model-error", ...over });
const ok = (over = {}) => row({ operation: "segment-summary", code: "ok", ...over });

// ----------------------------- class key ---------------------------------

test("opClassOf prefers operation, falls back to taskClass, else null", () => {
  assert.equal(opClassOf({ operation: "segment-summary", taskClass: "ambient-summarize" }), "segment-summary");
  assert.equal(opClassOf({ taskClass: "suggest" }), "suggest");
  assert.equal(opClassOf({ operation: "", taskClass: "suggest" }), "suggest");
  assert.equal(opClassOf({}), null);
  assert.equal(opClassOf(null), null);
});

// ----------------------------- blocker -----------------------------------

test("10 consecutive failures spanning ≥1h raise exactly one blocker", () => {
  const base = 1_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1_000) }));
  const { raised, alarms } = evaluateOpClass(rows, { nowMs: base + HOUR + 10_000 });
  assert.equal(raised.length, 1);
  const a = raised[0];
  assert.equal(a.severity, "blocker");
  assert.equal(a.taskClass, "segment-summary");
  assert.equal(a.generation, 1);
  assert.equal(a.code, "model-error");
  assert.equal(a.codeCount, 10);
  assert.equal(a.window, OP_CLASS_BLOCK_WINDOW);
  assert.ok(a.spanMs >= HOUR);
  assert.equal(alarms["segment-summary"].active, true);
  assert.equal(alarms["segment-summary"].generation, 1);
});

test("10 failures inside 59 min do not raise; a later failure stretches the span and raises", () => {
  const base = 2_000_000;
  // 10 failures across 59 minutes → span < 1h → nothing.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + Math.floor((i * 59 * 60_000) / 9) }));
  let out = evaluateOpClass(rows, { nowMs: base + HOUR });
  assert.equal(out.raised.length, 0);

  // An 11th failure 3h after the first stretches the last-10 span past 1h.
  // The fold is stateless per call — the engine re-reads the whole window
  // every tick, so the test re-feeds all rows.
  const stretched = [...rows, fail({ ts: base + 3 * HOUR })];
  out = evaluateOpClass(stretched, { nowMs: base + 3 * HOUR + 1, alarms: out.alarms });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].severity, "blocker");
});

test("exactly 1h span counts (≥ is inclusive)", () => {
  const base = 3_000_000;
  const rows = [fail({ ts: base }), fail({ ts: base + HOUR })];
  // only 2 attempts — pad to 10 with rows inside the hour so the last-10
  // window is [base, base+HOUR] exactly.
  for (let i = 1; i < 9; i++) rows.push(fail({ ts: base + i }));
  rows.sort((a, b) => a.ts - b.ts);
  const { raised } = evaluateOpClass(rows, { nowMs: base + HOUR + 1 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].spanMs, HOUR);
});

test("an ok among the last 10 attempts blocks the blocker", () => {
  const base = 4_000_000;
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(fail({ ts: base + i * 1_000 }));
  rows.push(ok({ ts: base + 10_000 })); // success inside the window
  rows.push(fail({ ts: base + HOUR + 1_000 }));
  const { raised } = evaluateOpClass(rows, { nowMs: base + 2 * HOUR });
  assert.equal(raised.length, 0);
});

test("dominant failure code is the most frequent in the window", () => {
  const base = 5_000_000;
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(fail({ ts: base + i * 1_000, code: "model-error" }));
  for (let i = 0; i < 3; i++) rows.push(fail({ ts: base + HOUR + 10_000 + i, code: "transport-error" }));
  rows.sort((a, b) => a.ts - b.ts);
  const { raised } = evaluateOpClass(rows, { nowMs: base + HOUR + 20_000 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].code, "model-error");
  assert.equal(raised[0].codeCount, 7);
});

// ----------------------------- degraded ----------------------------------

test("degraded: <50% over 20 attempts raises with lower text severity", () => {
  const base = 6_000_000;
  const rows = [];
  for (let i = 0; i < 11; i++) rows.push(fail({ ts: base + i })); // 11 failures
  for (let i = 0; i < 9; i++) rows.push(ok({ ts: base + 1_000 + i })); // 9 ok
  rows.sort((a, b) => a.ts - b.ts);
  const { raised } = evaluateOpClass(rows, { nowMs: base + 1_000_000 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].severity, "degraded");
  assert.equal(raised[0].window, OP_CLASS_DEGRADED_WINDOW);
  assert.equal(raised[0].okCount, 9);
  assert.equal(raised[0].code, "model-error");
  assert.equal(raised[0].codeCount, 11);
  // blocker takes precedence when both shapes hold: same rows, stretched so
  // the last 10 span ≥1h, must reclassify as blocker severity.
  const allFail = [];
  for (let i = 0; i < 20; i++) allFail.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
  const out2 = evaluateOpClass(allFail, { nowMs: base + 3 * HOUR });
  assert.equal(out2.raised.length, 1);
  assert.equal(out2.raised[0].severity, "blocker");
});

test("degraded boundary: exactly 50% ok does not raise", () => {
  const base = 7_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i }));
  for (let i = 0; i < 10; i++) rows.push(ok({ ts: base + 1_000 + i }));
  rows.sort((a, b) => a.ts - b.ts);
  const { raised } = evaluateOpClass(rows, { nowMs: base + 2_000_000 });
  assert.equal(raised.length, 0);
});

test("fewer than 20 attempts never degrade; fewer than 10 never block", () => {
  const base = 8_000_000;
  const { raised } = evaluateOpClass([fail({ ts: base }), fail({ ts: base + 10 * HOUR })], {
    nowMs: base + 10 * HOUR,
  });
  assert.equal(raised.length, 0);
});

// ----------------------------- gated / kinds -----------------------------

test("gated rows are skipped entirely — they are not attempts", () => {
  const base = 9_000_000;
  const rows = [];
  // 10 real failures spanning ≥1h, with 10 gated rows interleaved — the
  // gated rows must neither fill the window nor break the failure run.
  for (let i = 0; i < 10; i++) {
    rows.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
    rows.push(row({ ts: base + i * (HOUR / 9 + 1) + 1, code: "gated" }));
  }
  rows.sort((a, b) => a.ts - b.ts);
  const { raised } = evaluateOpClass(rows, { nowMs: base + 2 * HOUR });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].codeCount, 10);
});

test("non-outcome rows are filtered out", () => {
  const base = 10_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
  rows.push({ kind: "cto.ephemeral_begin", ts: base, operation: "segment-summary", code: "model-error" });
  const { raised } = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(raised.length, 1);
});

// ----------------------------- dedupe / latch ----------------------------

test("fires once per incident: re-feeding the same rows does not re-fire", () => {
  const base = 11_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
  const first = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(first.raised.length, 1);
  // A second evaluation with the SAME (still-in-window) rows must not re-fire.
  const second = evaluateOpClass(rows, { nowMs: base + HOUR + 20, alarms: first.alarms });
  assert.equal(second.raised.length, 0);
  // ...and neither does a third.
  const third = evaluateOpClass(rows, { nowMs: base + HOUR + 30, alarms: second.alarms });
  assert.equal(third.raised.length, 0);
});

test("recovery: one ok newer than the alarm clears the latch", () => {
  const base = 12_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
  let out = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(out.raised.length, 1);
  // An ok row OLDER than firedAt (sliding-window re-feed) must NOT clear.
  let stale = evaluateOpClass(rows, { nowMs: base + HOUR + 20, alarms: out.alarms });
  assert.equal(stale.raised.length, 0);
  assert.equal(stale.recovered.length, 0);
  assert.equal(stale.alarms["segment-summary"].active, true);
  // A FRESH ok (ts > firedAt) clears the latch.
  const okAt = base + HOUR + 15;
  stale = evaluateOpClass([ok({ ts: okAt })], { nowMs: okAt + 1, alarms: stale.alarms });
  assert.equal(stale.recovered.length, 1);
  assert.equal(stale.alarms["segment-summary"].active, false);
});

test("re-arms after one success then a fresh failure run, with a new generation", () => {
  const base = 13_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1) }));
  let out = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].generation, 1);

  // Recovery.
  const okAt = base + 2 * HOUR;
  out = evaluateOpClass([ok({ ts: okAt })], { nowMs: okAt + 1, alarms: out.alarms });
  assert.equal(out.recovered.length, 1);

  // A fresh failure run (10 more failures spanning ≥1h after the ok) re-arms.
  const fresh = [];
  for (let i = 0; i < 10; i++) fresh.push(fail({ ts: okAt + 60_000 + i * (HOUR / 9 + 1) }));
  out = evaluateOpClass(fresh, { nowMs: okAt + 60_000 + HOUR + 10, alarms: out.alarms });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].generation, 2);
});

// ----------------------------- grouping ----------------------------------

test("classes are watched independently", () => {
  const base = 14_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(fail({ ts: base + i * (HOUR / 9 + 1), operation: "segment-summary" }));
  for (let i = 0; i < 5; i++) rows.push(fail({ ts: base + i, operation: "segment-one-liner" }));
  const { raised } = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].taskClass, "segment-summary");
});

test("unsorted rows are sorted; missing operation falls back to taskClass", () => {
  const base = 15_000_000;
  // No `operation` key at all — the class key must come from taskClass.
  const rows = [
    row({ ts: base + HOUR + 5, taskClass: "suggest" }),
    row({ ts: base + 3, taskClass: "suggest" }),
    row({ ts: base + 1, taskClass: "suggest" }),
    row({ ts: base + 2, taskClass: "suggest" }),
    row({ ts: base + 4, taskClass: "suggest" }),
    row({ ts: base + 5, taskClass: "suggest" }),
    row({ ts: base + 6, taskClass: "suggest" }),
    row({ ts: base + 7, taskClass: "suggest" }),
    row({ ts: base + 8, taskClass: "suggest" }),
    row({ ts: base + 9, taskClass: "suggest" }),
  ];
  const { raised } = evaluateOpClass(rows, { nowMs: base + HOUR + 10 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].taskClass, "suggest");
});

// ----------------------------- reason text -------------------------------

test("reason names the class, the dominant code, and the count", () => {
  const blocker = formatOpClassReason({
    taskClass: "segment-summary",
    severity: "blocker",
    window: 10,
    spanMs: 2.5 * HOUR,
    code: "model-error",
    codeCount: 10,
    okCount: 0,
  });
  assert.match(blocker, /segment-summary/);
  assert.match(blocker, /model-error/);
  assert.match(blocker, /×10/);
  assert.match(blocker, /0 ok/);

  const degraded = formatOpClassReason({
    taskClass: "segment-one-liner",
    severity: "degraded",
    window: 20,
    code: "create-http",
    codeCount: 12,
    okCount: 8,
  });
  assert.match(degraded, /segment-one-liner/);
  assert.match(degraded, /create-http/);
  assert.match(degraded, /×12/);
  assert.match(degraded, /8\/20/);
});
