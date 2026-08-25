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
