// optimizer/series.test.mjs — the windowed consumption series read (BET-1369).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOptimizerSeries,
  createOptimizerSeries,
  RANGES,
  _resetSeriesMemo,
} from "./series.mjs";
import { createCounterfactualStore } from "./counterfactual.mjs";

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

// A counterfactual store whose snapshot has a couple of trimmed days/hours.
function fakeStore(snapshot) {
  return { snapshot: async () => snapshot };
}

// A v3 bucket with one model on each half (no pricing detail — the zip tests
// only look at token counts).
function bucket({ actual = 0, potential = 0 } = {}) {
  const half = (trimmed) => ({
    byModel: { "p/m": { trimmed, rewarm: 0, usd: 0, pricedReports: 1, unpricedReports: 0 } },
  });
  return { actual: half(actual), potential: half(potential), reports: 1 };
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
      [localDay(yesterdayLoc)]: bucket({ potential: 400, actual: 150 }),
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
  const potTot = out.series.reduce((s, p) => s + p.potentialTrimmedTokens, 0);
  const actTot = out.series.reduce((s, p) => s + p.actualTrimmedTokens, 0);
  assert.equal(sentTot, 10);
  assert.equal(potTot, 400, "only yesterday's trimmed tokens are counted");
  assert.equal(maskedTot, 400, "maskedTokens is an alias of potentialTrimmedTokens");
  assert.equal(actTot, 150, "actual is its own line — never pooled with potential");
  assert.equal(out.totals.actualTrimmedTokens, 150);
  assert.equal(out.totals.potentialTrimmedTokens, 400);
  assert.equal(out.counterfactualAvailable, true);
  // The `today` bucket (start of today) zipped with no key → maskedTokens 0.
  const todayBucket = out.series.find((p) => p.t === todayLoc.getTime());
  assert.ok(todayBucket, "today's bucket is present");
  assert.equal(todayBucket.maskedTokens, 0);
  assert.equal(todayBucket.actualTrimmedTokens, 0);
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
  assert.equal(out.totals.actualTrimmedTokens, 0);
  assert.equal(out.totals.rewarmTokens, 0);
});

// ---- sticky trims: the window's `saved` figure = a SUM of stored per-report usd ----

const NOW = new Date(2026, 7, 24, 12, 0, 0).getTime();
const RATES = { cacheRead: 0.2, cacheWrite: 5, source: "catalog", fetchedAt: NOW - 3_600_000 };

function v3(over = {}) {
  return {
    v: 3,
    sessionID: "ses_a",
    ts: NOW,
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    rates: RATES,
    applied: { trimmedTokens: 0, trimmedParts: 0 },
    shadow: { trimmedTokens: 0, trimmedParts: 0 },
    change: "none",
    shadowChange: "none",
    rewarmTokens: 0,
    shadowRewarmTokens: 0,
    ...over,
  };
}

// A REAL store (in-memory load/save) so ingest-time pricing is exercised end to end.
async function seeded(reports) {
  let state = {};
  const store = createCounterfactualStore({ load: async () => state, save: async (x) => { state = x; }, now: () => NOW });
  for (const r of reports) await store.record(r);
  return store;
}

const window7d = (store) =>
  buildOptimizerSeries({ range: "7d", fetchRows: async () => [], now: NOW, counterfactualStore: store });

test("buildOptimizerSeries: no store → `saved` is the genuine empty set (0, measured, share 1)", async () => {
  const out = await window7d(null);
  assert.deepEqual(out.saved, { usd: 0, potentialUsd: 0, pricedShare: 1, basis: "measured" });
  assert.equal(out.totals.rewarmTokens, 0);
});

test("buildOptimizerSeries: `saved` sums the usd STORED at ingest (no read-time pricing)", async () => {
  const store = await seeded([
    v3({ applied: { trimmedTokens: 1_000_000, trimmedParts: 3 } }), // +$0.20
    v3({ applied: { trimmedTokens: 500_000, trimmedParts: 1 } }), // +$0.10
  ]);
  const out = await window7d(store);
  assert.ok(Math.abs(out.saved.usd - 0.3) < 1e-9);
  assert.equal(out.saved.basis, "measured");
  assert.equal(out.saved.pricedShare, 1);
  assert.equal(out.saved.potentialUsd, 0, "nothing simulated");
  assert.equal(out.totals.actualTrimmedTokens, 1_500_000);
});

test("buildOptimizerSeries: a cost-only window is NEGATIVE and the re-cache tokens are exposed", async () => {
  const store = await seeded([v3({ change: "grow", rewarmTokens: 280_000 })]);
  const out = await window7d(store);
  assert.ok(out.saved.usd < 0, "a re-cache that has not paid back is a cost");
  assert.ok(Math.abs(out.saved.usd - (-280_000 * 4.8) / 1e6) < 1e-9);
  assert.equal(out.totals.rewarmTokens, 280_000);
});

test("buildOptimizerSeries: actual and potential dollars are separate (the switch is off → only potential)", async () => {
  const store = await seeded([
    v3({ shadow: { trimmedTokens: 1_000_000, trimmedParts: 3 } }),
  ]);
  const out = await window7d(store);
  assert.equal(out.saved.usd, 0, "off → it saved nothing");
  assert.ok(Math.abs(out.saved.potentialUsd - 0.2) < 1e-9, "potential still shows what it would save");
  assert.equal(out.totals.potentialTrimmedTokens, 1_000_000);
  assert.equal(out.totals.actualTrimmedTokens, 0);
  assert.equal(out.counterfactualAvailable, true);
});

test("buildOptimizerSeries: unpriced reports add tokens, never dollars; share and basis say so", async () => {
  const noRates = v3({ applied: { trimmedTokens: 1_000_000, trimmedParts: 1 } });
  delete noRates.rates;
  const priced = v3({ applied: { trimmedTokens: 1_000_000, trimmedParts: 1 } });
  const out = await window7d(await seeded([noRates, priced]));
  assert.ok(Math.abs(out.saved.usd - 0.2) < 1e-9, "only the priced report contributes dollars");
  assert.equal(out.saved.basis, "partial");
  assert.equal(out.saved.pricedShare, 0.5);
  assert.equal(out.totals.actualTrimmedTokens, 2_000_000, "unpriced tokens still count");
});

test("buildOptimizerSeries: reports exist but none priced → usd null, unpriced", async () => {
  const noRates = v3({ applied: { trimmedTokens: 1_000_000, trimmedParts: 1 } });
  delete noRates.rates;
  const out = await window7d(await seeded([noRates]));
  assert.equal(out.saved.usd, null);
  assert.equal(out.saved.basis, "unpriced");
  assert.equal(out.saved.pricedShare, 0);
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
  const getDb = async () => ({});
  const fetchRows = async () => {
    prepares += 1;
    return [];
  };
  const s = createOptimizerSeries({ getDb, now: () => 1_000_000, fetchRows });

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
  const getDb = async () => ({});
  const fetchRows = async () => {
    prepares += 1;
    return [];
  };
  const s = createOptimizerSeries({ getDb, now: () => 1_000_000, fetchRows });

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
