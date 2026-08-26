// Tests for optimizer/summary.mjs — the `optimizer:summary` read model
// (BET-1333, Optimizer P1.1). Pure/injected throughout: no real DB, no real
// state dir — `fetchRows` and `getDb` are stubbed. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptimizerSummary, createOptimizerSummary, WINDOW_DAYS, BUILD_BUDGET_MS, TTL_MS, _resetSummaryMemo } from "./summary.mjs";
import { createCounterfactualStore } from "./counterfactual.mjs";

// A promise plus the resolve/reject to settle it on demand — lets tests drive
// a never-resolving build deterministically without real sleeps (BET-1360).
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function row(over = {}) {
  return {
    sessionID: "s1",
    cost: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    startedMs: 0,
    completedMs: 0,
    ...over,
  };
}

// The canonical one-row fixture used by several breakdown assertions — the
// same row object, so any shared behaviour runs against the same shape.
function baseRows(now) {
  return [row({ cost: 5, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, startedMs: now })];
}

// Runs `fn` with console.warn captured, restoring it afterwards; returns the
// captured lines. Two tests assert on the [optimizer] TTL-verifier log.
async function captureWarns(fn) {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
  return warns;
}

// Build `count` consecutive turns in one session, each `gapMs` after the
// previous completion — deterministic consecutive pairs for the TTL verifier.
// Every pair is cold (cacheRead 0) and well-clear of the 5000-ctx floor, so a
// `count` >= 7 yields a conclusive "measured 5m" verdict.
function sessionTurns({ count, gapMs = 10 * 60_000 }) {
  const rows = [];
  let start = 1_750_000_000_000;
  for (let i = 0; i < count; i++) {
    const completed = start + 10_000;
    rows.push(
      row({
        sessionID: "s1",
        startedMs: start,
        completedMs: completed,
        input: 10_000,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    );
    start = completed + gapMs;
  }
  return rows;
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
  const rows = baseRows(now);
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
  // The placeholders children 4 fills, kept for a stable contract. No
  // counterfactualStore wired → counterfactual is empty: maskedTokens 0 on
  // every day, savedPct 0 on every session, the counterfactual key null.
  // `ttl` (BET-1340): a single row yields no consecutive pairs → the default
  // measurement; no configured TTL readable (readCacheTtl → null) → no
  // verification. Diagnostic only, never user-facing in P1.
  assert.deepEqual(s.ttl, {
    measuredMs: 300_000,
    confidence: "default",
    observations: 0,
    configuredMs: null,
    matched: null,
  });
  assert.equal(s.counterfactual, null);
  // No usage snapshots wired → windows is empty (P1.4: the quota-window slice).
  assert.deepEqual(s.windows, []);
  assert.ok(s.dailySeries.every((d) => d.maskedTokens === 0));
  assert.ok(s.bySession.every((e) => e.savedPct === 0));
});

test("buildOptimizerSummary merges the counterfactual into dailySeries + bySession and fills the counterfactual key", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  // tokensSent = 1+2+3+4 = 10 for s1.
  const rows = baseRows(now);
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

test("buildOptimizerSummary: windows slice maps stored snapshots + forecast-at-reset (BET-1336)", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const rows = [row({ cost: 1, input: 1, cacheRead: 1, cacheWrite: 1, output: 1, startedMs: now })];
  const fetchRows = async () => rows;

  const H = 3_600_000;
  // Two snapshots, each with a session+weekly window (shortest-first order).
  const snapshots = [
    {
      provider: "claude",
      planLabel: "Max 20x",
      fetchedAt: now,
      windows: [
        { kind: "session", label: "5h", pct: 30, resetsAt: now + 50 * H },
        { kind: "weekly", label: "week", pct: 40, resetsAt: now + 100 * H },
      ],
    },
    { provider: "codex", fetchedAt: now, windows: [{ kind: "session", label: "5h", pct: 20, resetsAt: now + 50 * H }] },
  ];
  // History: enough +1/hr observations for the first snapshot's session window
  // to produce a forecast; nothing for the others → their forecastPct is null.
  const history = {
    "claude:session": [0, 1, 2, 3, 4, 5, 6, 7, 8].map((pct, i) => ({ ts: now - (8 - i) * H, pct })),
  };

  const s = await buildOptimizerSummary({ fetchRows, now, usageSnapshots: () => snapshots, usageHistory: () => history });

  assert.equal(s.windows.length, 3);
  // The popover order: snapshot order, each snapshot's windows shortest-first.
  assert.deepEqual(
    s.windows.map((w) => [w.provider, w.windowLabel]),
    [
      ["claude", "5h"],
      ["claude", "week"],
      ["codex", "5h"],
    ],
  );
  // First window: 9 observations of +1/hr → median 1; resetsAt 50h away from
  // now, currentPct 30 → 30 + 1*50 = 80.
  assert.equal(s.windows[0].forecastPct, 80);
  assert.equal(s.windows[0].pct, 30);
  assert.equal(s.windows[0].resetsAt, now + 50 * H);
  assert.equal(s.windows[0].planLabel, "Max 20x");
  // No history for the others → forecastPct null, resetsAt preserved.
  assert.equal(s.windows[1].forecastPct, null);
  assert.equal(s.windows[1].resetsAt, now + 100 * H);
  assert.equal(s.windows[2].forecastPct, null);
});

test("buildOptimizerSummary: measured 5m vs configured 1h logs one [optimizer] mismatch line (BET-1340)", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  // 8 turns → 7 conclusive cold pairs → measured 5m with confidence "measured".
  const rows = sessionTurns({ count: 8 });
  const fetchRows = async () => rows;
  const readCacheTtl = async () => "1h"; // opencode configured to SEND 1h

  let s;
  const warns = await captureWarns(async () => {
    s = await buildOptimizerSummary({ fetchRows, now, readCacheTtl });
  });

  // One [optimizer] mismatch line is logged.
  const mismatch = warns.filter((m) => m.includes("[optimizer] cache-TTL mismatch"));
  assert.equal(mismatch.length, 1);
  assert.match(mismatch[0], /measured 5m vs configured 1h/);

  // The diagnostic entry reflects the disagreement.
  assert.equal(s.ttl.measuredMs, 300_000);
  assert.equal(s.ttl.confidence, "measured");
  assert.equal(s.ttl.configuredMs, 3_600_000);
  assert.equal(s.ttl.matched, false);
});

test("buildOptimizerSummary: no mismatch log when the verifier has nothing conclusive", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  // A single row → 0 observations → confidence "default" → verifyCacheTtl
  // returns null, so nothing is logged even when configured is 1h.
  const fetchRows = async () => [row({ startedMs: now })];
  const readCacheTtl = async () => "1h";

  let s;
  const warns = await captureWarns(async () => {
    s = await buildOptimizerSummary({ fetchRows, now, readCacheTtl });
  });

  assert.ok(warns.every((m) => !m.includes("[optimizer] cache-TTL mismatch")), "no mismatch line expected");
  assert.equal(s.ttl.confidence, "default");
  assert.equal(s.ttl.configuredMs, null);
  assert.equal(s.ttl.matched, null);
});

test("buildOptimizerSummary: activity slice surfaces the store's newest entries, empty without a store (BET-1347)", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const fetchRows = async () => [row({ startedMs: now })];
  // No store wired → empty feed (the documented empty state), never a zero.
  const noStore = await buildOptimizerSummary({ fetchRows, now });
  assert.deepEqual(noStore.activity, { entries: [] });

  const activityStore = {
    recent: async (n) =>
      [{ id: "abc12345", ts: now, kind: "tune", subject: "x", verdict: "kept", evidence: { turns: 5 } }],
  };
  const withStore = await buildOptimizerSummary({ fetchRows, now, activityStore });
  assert.equal(withStore.activity.entries.length, 1);
  assert.equal(withStore.activity.entries[0].kind, "tune");
});

// Races `promise` against a short timer so a deadlock fails the suite instead
// of hanging CI. BET-1359: the old self-await wiring never settled.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`BET-1359: expected resolution within ${ms}ms, hung`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("BET-1359: meteredEndpoints that reads its injected ctx resolves (no self-await deadlock)", async () => {
  _resetSummaryMemo();
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  let received = null;
  const summary = createOptimizerSummary({
    getDb: async () => ({ prepare() { return { all: () => [row({ startedMs: now }) ] }; }, close() {} }),
    now: () => 3_000_000,
    meteredEndpoints: async (ctx) => {
      received = ctx;
      return [{ name: "openai · gpt-4o", role: "pay-per-token endpoint", price: "$5.00 / Mtok blended" }];
    },
  });

  const s = await withTimeout(summary(), 2000);
  assert.equal(s.supported, true);
  assert.equal(s.metered.length, 1);
  assert.ok(received, "meteredEndpoints must have been invoked with the context");
});

test("BET-1359: meteredEndpoints is handed a ctx object, never the summary function", async () => {
  _resetSummaryMemo();
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  let arg = "unset";
  const summary = createOptimizerSummary({
    getDb: async () => ({ prepare() { return { all: () => [row({ startedMs: now }) ] }; }, close() {} }),
    now: () => 4_000_000,
    meteredEndpoints: async (ctx) => {
      arg = ctx;
      return [];
    },
  });

  const s = await summary();
  assert.equal(s.supported, true);
  assert.equal(typeof arg, "object");
  assert.ok(Array.isArray(arg.windows), "ctx must carry a windows array");
  assert.ok(typeof arg.cacheShare === "object" && arg.cacheShare !== null, "ctx must carry a cacheShare object");
  assert.notEqual(arg, summary, "meteredEndpoints must never receive the summary function");
  assert.notEqual(arg, s, "meteredEndpoints must never receive the whole summary");
});

test("BET-1359: meteredEndpoints receives the SAME windows + cacheShare the summary returns", async () => {
  _resetSummaryMemo();
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const H = 3_600_000;
  const snapshots = [
    {
      provider: "claude",
      planLabel: "Max 20x",
      fetchedAt: now,
      windows: [{ kind: "session", label: "5h", pct: 30, resetsAt: now + 50 * H }],
    },
  ];
  const rows = [row({ cost: 5, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, startedMs: now })];
  let ctx = null;
  const summary = createOptimizerSummary({
    getDb: async () => ({ prepare() { return { all: () => rows }; }, close() {} }),
    now: () => now,
    usageSnapshots: () => snapshots,
    usageHistory: () => ({}),
    meteredEndpoints: async (c) => {
      ctx = c;
      return [];
    },
  });

  const s = await summary();
  assert.equal(s.supported, true);
  assert.ok(ctx, "meteredEndpoints must have been invoked");
  // The context is the very objects the summary returns — plumbing, not a copy.
  assert.equal(ctx.windows, s.windows);
  assert.equal(ctx.cacheShare, s.cacheShare);
  // Sanity: the context genuinely carries the known window + cacheShare.
  assert.equal(s.windows.length, 1);
  assert.equal(s.windows[0].provider, "claude");
  assert.deepEqual(ctx.windows, s.windows);
  assert.deepEqual(ctx.cacheShare, s.cacheShare);
});

test("BET-1359: metered row lands in summary.metered", async () => {
  _resetSummaryMemo();
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const s = await buildOptimizerSummary({
    fetchRows: async () => [row({ startedMs: now })],
    now,
    meteredEndpoints: async () => [{ name: "openai · gpt-4o", role: "pay-per-token endpoint", price: "$5.00 / Mtok blended" }],
  });
  assert.equal(s.metered.length, 1);
  assert.equal(s.metered[0].name, "openai · gpt-4o");
});

test("BET-1359: metered degradation unchanged (throw / non-array / not-a-function → [])", async () => {
  _resetSummaryMemo();
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const fetchRows = async () => [row({ startedMs: now })];

  const throwing = await buildOptimizerSummary({
    fetchRows,
    now,
    meteredEndpoints: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(throwing.metered, []);

  const nonArray = await buildOptimizerSummary({ fetchRows, now, meteredEndpoints: async () => ({ not: "array" }) });
  assert.deepEqual(nonArray.metered, []);

  const notFn = await buildOptimizerSummary({ fetchRows, now, meteredEndpoints: "not-a-function" });
  assert.deepEqual(notFn.metered, []);
});

test("BET-1359: _resetSummaryMemo clears the cache so the next build re-queries", async () => {
  _resetSummaryMemo();
  let prepares = 0;
  const stubDb = {
    prepare() {
      prepares += 1;
      return { all: () => [] };
    },
    close() {},
  };
  const summary = createOptimizerSummary({ getDb: async () => stubDb, now: () => 9_000_000 });

  const first = await summary();
  assert.equal(prepares, 1);
  // Within TTL → memoized, no re-query.
  await summary();
  assert.equal(prepares, 1);

  _resetSummaryMemo();
  const second = await summary();
  assert.equal(prepares, 2, "after reset the next build must re-query");
  assert.notEqual(second, first);
});

// BET-1360 — bounded build budget. All tests drive time with an injected
// mutable `now` and inject controllable builds (deferred getDb) so nothing
// sleeps for real seconds.

test("BET-1360: a wedged build yields {supported:false} within the budget instead of hanging", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  const hung = deferred();
  const summary = createOptimizerSummary({ getDb: () => hung.promise, now: () => t });
  const first = summary(); // starts an in-flight build at t=1_000_000
  // Advance the clock past the budget: the caller must resolve, not hang.
  t = 1_000_000 + BUILD_BUDGET_MS + 1;
  const result = await withTimeout(summary(), 2000);
  assert.deepEqual(result, { supported: false });
  hung.resolve(null); // let the wedged build settle before the test ends
  await withTimeout(first, 2000);
});

test("BET-1360: no stampede — concurrent callers never start a second build", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  let getDbCalls = 0;
  const hung = deferred();
  const summary = createOptimizerSummary({
    getDb: () => { getDbCalls += 1; return hung.promise; },
    now: () => t,
  });
  const first = summary();
  t = 1_000_000 + BUILD_BUDGET_MS + 1;
  const results = await Promise.all(Array.from({ length: 10 }, () => summary()));
  for (const r of results) assert.deepEqual(r, { supported: false });
  assert.equal(getDbCalls, 1, "only the first caller may start a build");
  hung.resolve(null);
  await withTimeout(first, 2000);
});

test("BET-1360: self-heal — a build that finishes after the budget still populates the cache", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  const nowDate = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const late = deferred();
  const summary = createOptimizerSummary({
    getDb: () => late.promise.then(() => ({ prepare() { return { all: () => [row({ startedMs: nowDate }) ] }; }, close() {} })),
    now: () => t,
  });
  const first = summary();
  t = 1_000_000 + BUILD_BUDGET_MS + 1;
  const degraded = await withTimeout(summary(), 2000);
  assert.deepEqual(degraded, { supported: false });
  // The slow build finally settles — it populates the cache, it is not a trip.
  late.resolve();
  await withTimeout(first, 2000);
  const healed = await summary();
  assert.equal(healed.supported, true, "a slow build that settles after the budget is not sticky");
});

test("BET-1360: no cross-clearing — a stale build never clears a newer in-flight slot", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  const firstDb = deferred();
  const secondDb = deferred();
  let getDbCalls = 0;
  const summary = createOptimizerSummary({
    getDb: () => {
      getDbCalls += 1;
      return getDbCalls === 1 ? firstDb.promise : secondDb.promise;
    },
    now: () => t,
  });
  const a = summary(); // build A, in flight
  assert.equal(getDbCalls, 1);
  t = 1_000_000 + BUILD_BUDGET_MS + 1;
  await summary(); // degraded against A; no second build
  assert.equal(getDbCalls, 1);

  firstDb.resolve({ prepare() { return { all: () => [] }; }, close() {} }); // A settles, clears itself
  await withTimeout(a, 2000);

  t = 1_000_000 + BUILD_BUDGET_MS + TTL_MS + 1; // past A's TTL → build B
  const b = summary();
  assert.equal(getDbCalls, 2, "B must start after A clears and the cache expires");
  t = t + BUILD_BUDGET_MS + 1;
  await summary();
  await summary();
  assert.equal(getDbCalls, 2, "no third build may be started while B is in flight");
  secondDb.resolve({ prepare() { return { all: () => [] }; }, close() {} });
  await withTimeout(b, 2000);
});

test("BET-1360: fast path unchanged — normal build memoizes for TTL_MS with one query", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  let prepares = 0;
  const nowDate = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const summary = createOptimizerSummary({
    getDb: async () => ({ prepare() { prepares += 1; return { all: () => [row({ startedMs: nowDate }) ] }; }, close() {} }),
    now: () => t,
  });
  const first = await withTimeout(summary(), 2000);
  assert.equal(first.supported, true);
  assert.equal(prepares, 1);
  t += 1; // still inside TTL
  const second = await summary();
  assert.equal(second, first, "within TTL the memoized value is returned");
  assert.equal(prepares, 1, "one query for two calls within the window");
});

test("BET-1360: a rejecting build degrades to {supported:false} and never caches an error", async () => {
  _resetSummaryMemo();
  let t = 1_000_000;
  const summary = createOptimizerSummary({
    getDb: async () => { throw new Error("db open boom"); },
    now: () => t,
  });
  const r1 = await withTimeout(summary(), 2000);
  assert.deepEqual(r1, { supported: false });
  t += 1;
  const r2 = await summary();
  assert.deepEqual(r2, { supported: false });
  assert.equal(r2.value, undefined, "an error must never be cached");
});

test("BET-1360: BUILD_BUDGET_MS is exported so tests reference it, not a magic number", () => {
  assert.equal(typeof BUILD_BUDGET_MS, "number");
  assert.ok(BUILD_BUDGET_MS > 0);
});
