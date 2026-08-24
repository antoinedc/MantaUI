// Tests for optimizer/summary.mjs — the `optimizer:summary` read model
// (BET-1333, Optimizer P1.1). Pure/injected throughout: no real DB, no real
// state dir — `fetchRows` and `getDb` are stubbed. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptimizerSummary, createOptimizerSummary, WINDOW_DAYS } from "./summary.mjs";
import { createCounterfactualStore } from "./counterfactual.mjs";

function row(over = {}) {
  return {
    sessionID: "s1",
    cost: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    startedMs: 0,
    ...over,
  };
}

function memStore(now, seed = {}) {
  let state = seed;
  return createCounterfactualStore({
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    now,
  });
}

test("buildOptimizerSummary returns the full shape with empty counterfactual, reusing aggregate totals/cacheShare", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const rows = [row({ cost: 5, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, startedMs: now })];
  const fetchRows = async () => rows;

  const s = await buildOptimizerSummary({ fetchRows, now });

  assert.equal(s.supported, true);
  assert.equal(s.windowDays, WINDOW_DAYS);
  // totals/cacheShare come from the existing `aggregate`.
  assert.deepEqual(s.totals, { turns: 1, cost: 5, input: 1, output: 4, cacheRead: 2, cacheWrite: 3 });
  assert.ok(typeof s.cacheShare.output === "number");
  // dailySeries/bySession derived from the same rows.
  assert.equal(s.dailySeries.length, WINDOW_DAYS);
  assert.equal(s.bySession[0].sessionID, "s1");
  // ttl is measured from the same rows (BET-1334): a single row yields no
  // consecutive pairs → the default prediction.
  assert.deepEqual(s.ttl, { ms: 300_000, confidence: "default", observations: 0 });
  // No counterfactualStore wired → counterfactual is empty: maskedTokens 0 on
  // every day, savedPct 0 on every session, the counterfactual key null.
  assert.equal(s.counterfactual, null);
  assert.equal(s.windows, null);
  assert.ok(s.dailySeries.every((d) => d.maskedTokens === 0));
  assert.ok(s.bySession.every((e) => e.savedPct === 0));
});

test("buildOptimizerSummary merges the counterfactual into dailySeries + bySession and fills the counterfactual key", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  // tokensSent = 1+2+3+4 = 10 for s1.
  const rows = [row({ cost: 5, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, startedMs: now })];
  const fetchRows = async () => rows;
  const store = memStore(now);
  assert.equal((await store.record({ sessionID: "s1", maskedTokens: 5, maskedParts: 1, ts: now })).ok, true);

  const s = await buildOptimizerSummary({ fetchRows, now, counterfactualStore: store });

  // The day of `now` holds s1's maskedTokens (5); every other day is 0.
  const today = new Date(now);
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const todayEntry = s.dailySeries.find((d) => d.day === key);
  assert.equal(todayEntry.maskedTokens, 5);
  assert.ok(s.dailySeries.filter((d) => d.day !== key).every((d) => d.maskedTokens === 0));
  // savedPct = 5 / (5 + 10) = 1/3 on the s1 bySession entry.
  assert.equal(s.bySession.length, 1);
  assert.equal(s.bySession[0].savedPct, 5 / 15);
  // The counterfactual placeholder is now populated with the raw store fields.
  assert.deepEqual(s.counterfactual.bySession, { s1: { maskedTokens: 5 } });
  assert.equal(s.counterfactual.dailySeries.find((d) => d.day === key).maskedTokens, 5);
});

test("buildOptimizerSummary: savedPct is 0 when a session has no counterfactual", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const rows = [row({ sessionID: "s1", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, startedMs: now })];
  const fetchRows = async () => rows;
  const store = memStore(now);
  // A report for a DIFFERENT session — s1 has no counterfactual.
  await store.record({ sessionID: "other", maskedTokens: 9, maskedParts: 1, ts: now });

  const s = await buildOptimizerSummary({ fetchRows, now, counterfactualStore: store });
  assert.equal(s.bySession[0].sessionID, "s1");
  assert.equal(s.bySession[0].savedPct, 0);
});

test("createOptimizerSummary returns { supported:false } when getDb resolves null", async () => {
  const summary = createOptimizerSummary({ getDb: async () => null, now: () => 1_000_000 });
  assert.deepEqual(await summary(), { supported: false });
});

test("createOptimizerSummary memoizes: two calls within 60s trigger one DB query", async () => {
  let prepares = 0;
  const stubDb = {
    prepare() {
      prepares += 1;
      return { all: () => [] };
    },
    close() {},
  };
  const getDb = async () => stubDb;
  const now = () => 1_000_000; // fixed clock → both calls within the TTL
  const summary = createOptimizerSummary({ getDb, now });

  const first = await summary();
  const second = await summary();

  assert.equal(first.supported, true);
  assert.equal(second, first); // same memoized object
  assert.equal(prepares, 1, "the DB query must run exactly once across memoized calls");
});

test("createOptimizerSummary in-flight guard shares one build across concurrent calls", async () => {
  let resolves = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const stubDb = {
    prepare() {
      resolves += 1;
      return { all: () => [] };
    },
    close() {},
  };
  const getDb = async () => {
    await gate;
    return stubDb;
  };
  const summary = createOptimizerSummary({ getDb, now: () => 5_000_000 });

  const p1 = summary();
  const p2 = summary();
  release();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1, r2);
  assert.equal(resolves, 1, "concurrent calls must share a single in-flight build");
});
