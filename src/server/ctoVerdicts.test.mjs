// src/server/ctoVerdicts.test.mjs
// BET-1391 — verdict ledger + §9.5 counter mapping + estimator helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT_COUNTERS,
  VERDICT_VERDICTS,
  effectsForVerdict,
  betaMean,
  betaTailAbove,
  thompsonDraw,
  createVerdictEngine,
  isValidVerdictSubject,
} from "./ctoVerdicts.mjs";

// ---------------------------------------------------------------------------
// §9.5 counter mapping table
// ---------------------------------------------------------------------------

test("VERDICT_COUNTERS maps every verdict to its §9.5 counters", () => {
  assert.deepEqual(VERDICT_COUNTERS.accept, { success: true, access: true });
  assert.deepEqual(VERDICT_COUNTERS.edit, { success: true, access: true });
  assert.deepEqual(VERDICT_COUNTERS.dismiss, { rejection: true });
  assert.deepEqual(VERDICT_COUNTERS.veto, { rejection: true });
  assert.deepEqual(VERDICT_COUNTERS.correct, { rejection: true });
  assert.deepEqual(VERDICT_COUNTERS.open, { access: true });
  assert.deepEqual(VERDICT_COUNTERS.expire, { decay: true });
});

test("mapping is exhaustive: every allowed verdict has a row", () => {
  for (const v of VERDICT_VERDICTS) {
    assert.ok(VERDICT_COUNTERS[v], `verdict "${v}" missing from VERDICT_COUNTERS`);
  }
});

test("open and expire never enter the acceptance counters", () => {
  assert.equal(VERDICT_COUNTERS.open.success, undefined);
  assert.equal(VERDICT_COUNTERS.open.rejection, undefined);
  assert.equal(VERDICT_COUNTERS.expire.success, undefined);
  assert.equal(VERDICT_COUNTERS.expire.rejection, undefined);
});

test("effectsForVerdict folds the `never` flag in as a rejection signal", () => {
  assert.deepEqual(effectsForVerdict("accept"), { success: true, access: true });
  assert.deepEqual(effectsForVerdict("accept", true), { success: true, access: true, rejection: true });
  assert.deepEqual(effectsForVerdict("open"), { access: true });
  assert.deepEqual(effectsForVerdict("dismiss", true), { rejection: true });
});

// ---------------------------------------------------------------------------
// Estimator helpers
// ---------------------------------------------------------------------------

test("betaMean is a/(a+b)", () => {
  assert.equal(betaMean(0, 0), 0);
  assert.equal(betaMean(10, 0), 1);
  assert.equal(betaMean(0, 10), 0);
  assert.equal(betaMean(2, 2), 0.5);
  assert.equal(betaMean(3, 1), 0.75);
});

test("betaTailAbove gates on the Beta-mean tail clearing `conf`", () => {
  // 90 accept / 10 reject → mean 0.9; reliably above 0.8 at 95%.
  assert.equal(betaTailAbove(90, 10, 0.8, 0.95), true);
  // 5 accept / 5 reject → mean 0.5; NOT reliably above 0.8.
  assert.equal(betaTailAbove(5, 5, 0.8, 0.95), false);
  // No counts → never clears the gate (0.5 always fails a >0 gate).
  assert.equal(betaTailAbove(0, 0, 0.5, 0.95), false);
  // Loose confidence lets a modest signal pass where a strict one would not.
  assert.equal(betaTailAbove(6, 4, 0.55, 0.6), true);
  assert.equal(betaTailAbove(6, 4, 0.55, 0.99), false);
});

test("betaTailAbove is monotonic in the accept count (normal approx)", () => {
  const prev = betaTailAbove(20, 300, 0.1, 0.9);
  assert.equal(betaTailAbove(200, 40, 0.1, 0.9), true);
  assert.equal(prev, false);
});

// Deterministic PRNG so Thompson-draw tests are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("thompsonDraw mean tracks the Beta mean (many draws)", () => {
  const rng = mulberry32(42);
  const draws = Array.from({ length: 4000 }, () => thompsonDraw(2, 2, rng));
  const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `draw mean ${mean} should be near 0.5`);
});

test("thompsonDraw handles degenerate Betas without a Gamma(0)", () => {
  assert.equal(thompsonDraw(0, 5), 0);
  assert.equal(thompsonDraw(5, 0), 1);
  assert.equal(thompsonDraw(0, 0), 0.5);
});

// ---------------------------------------------------------------------------
// Valid subject validation
// ---------------------------------------------------------------------------

test("isValidVerdictSubject enforces the §9.5 subject shape", () => {
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1" }), true);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1", class: "digest" }), true);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1", sender: "s1" }), true);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1", sender: { sessionID: "s1" } }), true);
  assert.equal(isValidVerdictSubject(null), false);
  assert.equal(isValidVerdictSubject({}), false);
  assert.equal(isValidVerdictSubject({ type: "fact" }), false);
  assert.equal(isValidVerdictSubject({ type: "", id: "f1" }), false);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "" }), false);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1", sender: 42 }), false);
  assert.equal(isValidVerdictSubject({ type: "fact", id: "f1", class: "" }), false);
});

// ---------------------------------------------------------------------------
// createVerdictEngine.recordVerdict
// ---------------------------------------------------------------------------

function fakeVerdictStore() {
  const entries = [];
  return {
    entries,
    load: async () => ({ v: 1, entries }),
    save: async (payload) => {
      entries.length = 0;
      entries.push(...(payload?.entries ?? []));
    },
  };
}

function makeEngine(overrides = {}) {
  const store = fakeVerdictStore();
  const sinkCalls = [];
  const registry = overrides.registry;
  const engine = createVerdictEngine({
    verdicts: store,
    now: () => 1_000,
    ...(registry ? { registry } : {}),
  });
  if (!registry) engine.registerCounterSink((effects, entry) => sinkCalls.push({ effects, entry }));
  return { engine, store, sinkCalls };
}

test("recordVerdict appends an entry to the verdicts store", async () => {
  const { engine, store } = makeEngine();
  const res = await engine.recordVerdict({
    subject: { type: "fact", id: "f1", sender: "s1" },
    verdict: "accept",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.effects, { success: true, access: true });
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].subject.type, "fact");
  assert.equal(store.entries[0].verdict, "accept");
  assert.equal(store.entries[0].ts, 1_000);
});

test("recordVerdict rejects invalid verdicts and subjects (never throws)", async () => {
  const { engine, store } = makeEngine();
  const badVerdict = await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "banana" });
  assert.equal(badVerdict.ok, false);
  const badSubject = await engine.recordVerdict({ subject: {}, verdict: "open" });
  assert.equal(badSubject.ok, false);
  const badNever = await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "open", never: "yes" });
  assert.equal(badNever.ok, false);
  assert.equal(store.entries.length, 0);
});

test("sink routing: accept → success+access; open → access only; expire → decay only; dismiss → rejection; never → rejection", async () => {
  const { engine, sinkCalls } = makeEngine();
  await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "accept" });
  await engine.recordVerdict({ subject: { type: "fact", id: "f2" }, verdict: "open" });
  await engine.recordVerdict({ subject: { type: "fact", id: "f3" }, verdict: "expire" });
  await engine.recordVerdict({ subject: { type: "fact", id: "f4" }, verdict: "dismiss" });
  await engine.recordVerdict({ subject: { type: "fact", id: "f5", sender: "s5" }, verdict: "accept", never: true });

  const effects = sinkCalls.map((c) => c.effects);
  assert.deepEqual(effects[0], { success: true, access: true });
  assert.deepEqual(effects[1], { access: true });
  assert.deepEqual(effects[2], { decay: true });
  assert.deepEqual(effects[3], { rejection: true });
  assert.deepEqual(effects[4], { success: true, access: true, rejection: true });
});

test("a throwing sink never breaks verdict recording", async () => {
  const { engine, store } = makeEngine();
  engine.registerCounterSink(() => {
    throw new Error("sink exploded");
  });
  const res = await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "accept" });
  assert.equal(res.ok, true);
  assert.equal(store.entries.length, 1);
});

test("listVerdicts returns the recorded verdicts", async () => {
  const { engine } = makeEngine();
  await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "accept" });
  await engine.recordVerdict({ subject: { type: "digest_item", id: "x" }, verdict: "open" });
  const list = await engine.listVerdicts();
  assert.equal(list.length, 2);
  assert.equal(list[0].verdict, "accept");
});

test("a pre-built registry routes through sinks without self-registration", async () => {
  const seen = [];
  const registry = {
    register() {},
    dispatch(effects, entry) {
      seen.push({ effects, entry });
    },
    size: () => 0,
  };
  const { engine } = makeEngine({ registry });
  await engine.recordVerdict({ subject: { type: "fact", id: "f1" }, verdict: "open" });
  assert.deepEqual(seen[0].effects, { access: true });
});
