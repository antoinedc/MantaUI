// optimizer/series.test.mjs — the windowed consumption series read (BET-1369).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOptimizerSeries,
  createOptimizerSeries,
  RANGES,
  _resetSeriesMemo,
} from "./series.mjs";

// Ledger row fixture — the fields `aggregate` / the series bucket agg read.
function row(over = {}) {
  return {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    agent: "build",
    parentId: null,
    directory: "/work/proj",
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    startedMs: 0,
    completedMs: 0,
    ...over,
  };
}

// A counterfactual store whose snapshot has a couple of masked days/hours.
function fakeStore(snapshot) {
  return { snapshot: async () => snapshot };
}

test("buildOptimizerSeries: unknown range falls back to 24h / hour bucket", async () => {
  let since = null;
  const out = await buildOptimizerSeries({
    range: "bogus",
    fetchRows: async (s) => {
      since = s;
      return [];
    },
    now: new Date(2026, 7, 24, 12, 0, 0).getTime(),
    counterfactualStore: null,
  });
  assert.equal(out.supported, true);
  assert.equal(out.range, "24h");
  assert.equal(out.bucket, "hour");
  assert.equal(out.series.length, 24);
  // The window reads only the last 24 hours of rows, not 30 days and slice.
  assert.equal(since, new Date(2026, 7, 23, 12, 0, 0).getTime());
});

test("buildOptimizerSeries: 30d maps to a 30-point day-bucket series", async () => {
  const out = await buildOptimizerSeries({
    range: "30d",
    fetchRows: async () => [],
    now: new Date(2026, 7, 24, 12, 0, 0).getTime(),
    counterfactualStore: null,
  });
  assert.equal(out.bucket, "day");
  assert.equal(out.series.length, 30);
  assert.equal(out.range, "30d");
});

test("buildOptimizerSeries: sent series sums each day's tokensSent", async () => {
  const twoDaysAgo = new Date(2026, 7, 24, 12, 0, 0).getTime() - 2 * 86_400_000;
  const out = await buildOptimizerSeries({
    range: "7d",
    fetchRows: async () => [
      row({ startedMs: twoDaysAgo, input: 5, cacheRead: 5, cacheWrite: 5, output: 5 }),
    ],
    now: new Date(2026, 7, 24, 12, 0, 0).getTime(),
    counterfactualStore: null,
  });
  const matching = out.series.find((p) => p.tokensSent === 20);
  assert.ok(matching, "the day with the 20-token row is present and summed");
  // Every other bucket is zero-filled.
  assert.equal(out.series.reduce((s, p) => s + p.tokensSent, 0), 20);
});

test("buildOptimizerSeries: zips counterfactual onto the sent series by bucket key", async () => {
  // dayKey / recentBucketKeys are LOCAL-calendar, so build the store's keys the
  // same way (a local-date formatter, not toISOString which is UTC).
  const localDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const nowMs = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const todayLoc = new Date(2026, 7, 24, 0, 0, 0);
  const yesterdayLoc = new Date(2026, 7, 23, 0, 0, 0);
  const store = fakeStore({
    days: {
      [localDay(yesterdayLoc)]: { maskedTokens: 400 },
      // `today` has NO key — a sparse store must not throw, and its bucket
      // must zip to maskedTokens 0, not shift alignment.
    },
  });
  const out = await buildOptimizerSeries({
    range: "7d",
    fetchRows: async () => [row({ startedMs: nowMs, input: 1, output: 9 })],
    now: nowMs,
    counterfactualStore: store,
  });
  // Same length for both lines (counterfactual is never a different length).
  assert.equal(out.series.length, 7);
  const sentTot = out.series.reduce((s, p) => s + p.tokensSent, 0);
  const maskedTot = out.series.reduce((s, p) => s + p.maskedTokens, 0);
  assert.equal(sentTot, 10);
  assert.equal(maskedTot, 400, "only yesterday's masked tokens are counted");
  assert.equal(out.counterfactualAvailable, true);
  // The `today` bucket (start of today) zipped with no key → maskedTokens 0.
  const todayBucket = out.series.find((p) => p.t === todayLoc.getTime());
  assert.ok(todayBucket, "today's bucket is present");
  assert.equal(todayBucket.maskedTokens, 0);
});

test("buildOptimizerSeries: a NULL counterfactual store yields zeros, never a throw", async () => {
  const out = await buildOptimizerSeries({
    range: "24h",
    fetchRows: async () => [],
    now: new Date(2026, 7, 24, 12, 0, 0).getTime(),
    counterfactualStore: null,
  });
  assert.equal(out.series.reduce((s, p) => s + p.maskedTokens, 0), 0);
  assert.equal(out.counterfactualAvailable, false);
});

test("buildOptimizerSeries: totals fold turns/cost from the window's rows", async () => {
  const nowMs = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const out = await buildOptimizerSeries({
    range: "24h",
    fetchRows: async () => [
      row({ startedMs: nowMs, input: 1, output: 9, cost: 1.0 }),
      row({ startedMs: nowMs - 3_600_000, input: 2, output: 8, cost: 2.0 }),
    ],
    now: nowMs,
    counterfactualStore: null,
  });
  assert.equal(out.totals.turns, 2);
  assert.equal(out.totals.cost, 3.0);
  assert.equal(out.totals.tokensSent, 20);
  assert.equal(out.totals.maskedTokens, 0);
});

// ---- createOptimizerSeries (memo + in-flight + degradation) ----

test("createOptimizerSeries returns { supported:false } when getDb resolves null", async () => {
  _resetSeriesMemo();
  const s = createOptimizerSeries({ getDb: async () => null, now: () => 1_000_000 });
  assert.deepEqual(await s("24h"), { supported: false });
});

test("createOptimizerSeries memoizes PER RANGE: a 7d call is a separate slot, not a 24h hit", async () => {
  _resetSeriesMemo();
  let prepares = 0;
  const stubDb = {
    prepare() {
      prepares += 1;
      return { all: () => [] };
    },
    close() {},
  };
  const getDb = async () => stubDb;
  const s = createOptimizerSeries({ getDb, now: () => 1_000_000 });

  const a1 = await s("24h");
  const a2 = await s("24h"); // memo hit
  assert.equal(a1, a2);
  assert.equal(prepares, 1, "repeated 24h within TTL hits the same memo slot");

  const b1 = await s("7d"); // different range → different query
  assert.notEqual(b1, a1);
  assert.equal(prepares, 2, "7d is a SEPARATE memo slot, not a 24h cache hit");
});

test("createOptimizerSeries in-flight guard shares one build across concurrent calls", async () => {
  _resetSeriesMemo();
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
  const s = createOptimizerSeries({ getDb, now: () => 5_000_000 });

  const p1 = s("24h");
  const p2 = s("24h");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2);
  assert.equal(resolves, 1, "concurrent calls for the same range share a single build");
});

test("_resetSeriesMemo clears both slots so the next build re-queries", async () => {
  _resetSeriesMemo();
  let prepares = 0;
  const stubDb = {
    prepare() {
      prepares += 1;
      return { all: () => [] };
    },
    close() {},
  };
  const getDb = async () => stubDb;
  const s = createOptimizerSeries({ getDb, now: () => 1_000_000 });

  await s("24h");
  await s("24h"); // memo hit
  assert.equal(prepares, 1);
  _resetSeriesMemo();
  await s("24h");
  assert.equal(prepares, 2, "after _resetSeriesMemo the next call re-queries");
});

test("RANGES exposes exactly the three documented windows", () => {
  assert.deepEqual(Object.keys(RANGES).sort(), ["24h", "30d", "7d"]);
  assert.equal(RANGES["24h"].bucket, "hour");
  assert.equal(RANGES["7d"].bucket, "day");
  assert.equal(RANGES["30d"].bucket, "day");
});
