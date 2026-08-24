// Tests for optimizer/summary.mjs — the `optimizer:summary` read model
// (BET-1333, Optimizer P1.1). Pure/injected throughout: no real DB, no real
// state dir — `fetchRows` and `getDb` are stubbed. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptimizerSummary, createOptimizerSummary, WINDOW_DAYS } from "./summary.mjs";

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

test("buildOptimizerSummary returns the full shape with the three null placeholders, reusing aggregate totals/cacheShare", async () => {
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
  // The three placeholders children 2–4 fill, kept for a stable contract.
  assert.equal(s.ttl, null);
  assert.equal(s.counterfactual, null);
  assert.equal(s.windows, null);
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
