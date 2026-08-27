// Tests for optimizer/counterfactual.mjs — the observe-mode masking
// counterfactual store (Optimizer P1.3, BET-1335). Pure/injected throughout:
// no real state dir — `load`/`save` are in-memory and `now` is a controlled
// clock. Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCounterfactualStore,
  validateCounterfactualReport,
  bucketSeries,
  MAX_SESSIONS,
  RETAIN_DAYS,
  RETAIN_HOURS,
} from "./counterfactual.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hourKey(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)}T${String(d.getHours()).padStart(2, "0")}`;
}

function makeStore({ initial = {}, now }) {
  let state = initial;
  const saves = [];
  const store = createCounterfactualStore({
    load: async () => state,
    save: async (s) => {
      state = s;
      saves.push(JSON.parse(JSON.stringify(s)));
    },
    now: () => now(),
  });
  return { store, saves, get: () => state };
}

function fixed(ms) {
  return () => ms;
}

test("validation: valid report passes, each bad field is rejected", () => {
  assert.equal(
    validateCounterfactualReport({ sessionID: "abc", maskedTokens: 1, maskedParts: 2, ts: 3 }),
    null,
  );
  // sessionID
  assert.ok(validateCounterfactualReport({ sessionID: "", maskedTokens: 1, maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: "x".repeat(129), maskedTokens: 1, maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: 42, maskedTokens: 1, maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ maskedTokens: 1, maskedParts: 1, ts: 1 }));
  // numeric fields
  assert.ok(validateCounterfactualReport({ sessionID: "a", maskedTokens: -1, maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: "a", maskedTokens: NaN, maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: "a", maskedTokens: "1", maskedParts: 1, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: "a", maskedTokens: 1, maskedParts: -5, ts: 1 }));
  assert.ok(validateCounterfactualReport({ sessionID: "a", maskedTokens: 1, maskedParts: 1, ts: NaN }));
  assert.ok(validateCounterfactualReport(null));
});

test("store.record rejects invalid and leaves state untouched", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(now) });
  const res = await store.record({ sessionID: "", maskedTokens: 1, maskedParts: 1, ts: 1 });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.deepEqual(get(), {}); // no load/normalize, no mutation on an invalid report
});

test("a report REPLACES the session's latest values but ADDS to the day's bucket (token-turns)", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const today = dayKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 3, ts: t });
  await store.record({ sessionID: "s2", maskedTokens: 200, maskedParts: 2, ts: t });
  assert.equal(get().days[today].maskedTokens, 300, "two sessions today sum");
  assert.equal(get().days[today].reports, 2);

  // s1's newer report REPLACES its session entry (1000) but ADDS its token-turns
  // to today's bucket (100 + 1000 from s1, 200 from s2 = 1300).
  await store.record({ sessionID: "s1", maskedTokens: 1000, maskedParts: 4, ts: t });
  assert.equal(get().days[today].maskedTokens, 1300);
  assert.equal(get().sessions.s1.maskedTokens, 1000);
});

test("day entries are per-day snapshots: a session moving days updates today only", async () => {
  // day0 t, day1 = next day.
  const t0 = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const t1 = t0 + DAY_MS;
  let current = t0;
  const { store, get } = makeStore({ now: () => current });
  const d0 = dayKey(t0);
  const d1 = dayKey(t1);

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 1, ts: t0 });
  await store.record({ sessionID: "s2", maskedTokens: 200, maskedParts: 1, ts: t0 });
  // Move a full day forward (both the server clock and the report ts).
  current = t1;
  await store.record({ sessionID: "s1", maskedTokens: 50, maskedParts: 1, ts: t1 });

  assert.equal(get().days[d0].maskedTokens, 300, "day0 keeps its snapshot (s1 100 + s2 200)");
  assert.equal(get().days[d1].maskedTokens, 50, "day1 is just s1's latest");
});

test("retention prunes day entries older than RETAIN_DAYS; recent ones survive", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const oldDay = dayKey(now - (RETAIN_DAYS + 1) * DAY_MS);
  const recentDay = dayKey(now - 10 * DAY_MS);
  const {
    store,
    get,
  } = makeStore({
    initial: {
      version: 2,
      days: {
        [oldDay]: { maskedTokens: 999, reports: 1 },
        [recentDay]: { maskedTokens: 7, reports: 1 },
      },
      hours: {},
      sessions: {},
    },
    now: fixed(now),
  });

  await store.record({ sessionID: "s1", maskedTokens: 5, maskedParts: 1, ts: now });

  const days = get().days;
  assert.equal(days[oldDay], undefined, "entries older than 90 days are pruned");
  assert.deepEqual(days[recentDay], { maskedTokens: 7, reports: 1 }, "recent entries survive");
});

test("sessions are capped at MAX_SESSIONS, evicting the oldest lastTs first", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(now) });

  // Fill to the cap with ascending timestamps.
  for (let i = 0; i < MAX_SESSIONS; i++) {
    await store.record({ sessionID: `s${i}`, maskedTokens: i, maskedParts: 1, ts: now + i });
  }
  assert.equal(Object.keys(get().sessions).length, MAX_SESSIONS);

  // A new, newest session pushes the OLDEST (s0) out.
  await store.record({ sessionID: "newest", maskedTokens: MAX_SESSIONS, maskedParts: 1, ts: now + 1_000_000 });
  const sessions = get().sessions;
  assert.equal(Object.keys(sessions).length, MAX_SESSIONS);
  assert.equal(sessions.s0, undefined, "oldest lastTs is evicted first");
  assert.ok(sessions.newest, "the newest report survives");
});

test("summaryFields returns a zero-filled 30d maskedTokens series and per-session maskedTokens", async () => {
  const { store } = makeStore({ now: fixed(new Date(2026, 7, 24, 12, 0, 0).getTime()) });
  const { summaryFields } = await import("./counterfactual.mjs");
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  await store.record({ sessionID: "s1", maskedTokens: 123, maskedParts: 1, ts: t });

  const f = await summaryFields(store);
  assert.equal(f.dailySeries.length, 30);
  const today = dayKey(t);
  assert.equal(f.dailySeries.find((d) => d.day === today).maskedTokens, 123);
  assert.ok(f.dailySeries.filter((d) => d.day !== today).every((d) => d.maskedTokens === 0));
  assert.deepEqual(f.bySession, { s1: { maskedTokens: 123 } });
});

test("two reports from the SAME session in the same hour SUM (additive token-turns — the BET-1368 regression)", async () => {
  const t = new Date(2026, 7, 24, 12, 30, 0).getTime(); // ts: same hour
  const { store, get } = makeStore({ now: fixed(t) });
  const bucket = hourKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 42, maskedParts: 2, ts: t });
  await store.record({ sessionID: "s1", maskedTokens: 58, maskedParts: 2, ts: t });

  // The old code kept only the latest (58); additive keeps the running total.
  assert.equal(get().hours[bucket].maskedTokens, 100);
  assert.equal(get().hours[bucket].reports, 2);
  // The sessions map still holds the LATEST (replace semantics unchanged).
  assert.equal(get().sessions.s1.maskedTokens, 58);
  // It also landed in today's day bucket.
  assert.equal(get().days[dayKey(t)].maskedTokens, 100);
});

// ----- BET-1344: applied / mode on the report -----

test("validation: applied/mode accepted when present, optional when absent", () => {
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc",
      maskedTokens: 1,
      maskedParts: 2,
      ts: 3,
      applied: true,
      mode: "act",
    }),
    null,
    "valid report with applied + mode passes",
  );
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc",
      maskedTokens: 1,
      maskedParts: 2,
      ts: 3,
      applied: false,
      mode: "observe",
    }),
    null,
  );
  // Both absent (observe-only plugin) → still valid.
  assert.equal(
    validateCounterfactualReport({ sessionID: "abc", maskedTokens: 1, maskedParts: 2, ts: 3 }),
    null,
  );
});

test("validation: applied must be a boolean, mode must be observe|act (rejected by field name)", () => {
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc", maskedTokens: 1, maskedParts: 1, ts: 1, applied: "yes",
    }),
    "applied",
  );
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc", maskedTokens: 1, maskedParts: 1, ts: 1, applied: 1,
    }),
    "applied",
  );
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc", maskedTokens: 1, maskedParts: 1, ts: 1, mode: "bogus",
    }),
    "mode",
  );
  assert.equal(
    validateCounterfactualReport({
      sessionID: "abc", maskedTokens: 1, maskedParts: 1, ts: 1, mode: "observe",
    }),
    null,
  );
});

test("store.record persists applied/mode on the session entry, and omits them when absent", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 3, ts: t, applied: true, mode: "act" });
  assert.equal(get().sessions.s1.applied, true);
  assert.equal(get().sessions.s1.mode, "act");

  // A report without applied/mode does not resurrect them as undefined keys.
  await store.record({ sessionID: "s2", maskedTokens: 50, maskedParts: 1, ts: t });
  assert.equal(Object.hasOwn(get().sessions.s2, "applied"), false);
  assert.equal(Object.hasOwn(get().sessions.s2, "mode"), false);
});

// ----- BET-1368: additive token-turn buckets, hourly retention, model attribution -----

test("a bucket is keyed off report.ts, not the injected clock (delayed report lands in yesterday's bucket)", async () => {
  const todayMs = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const yesterdayMs = todayMs - DAY_MS;
  const { store, get } = makeStore({ now: fixed(todayMs) });

  // The server clock is TODAY, but the report's ts is YESTERDAY.
  await store.record({ sessionID: "s1", maskedTokens: 77, maskedParts: 1, ts: yesterdayMs });

  assert.equal(get().days[dayKey(yesterdayMs)].maskedTokens, 77, "goes to yesterday's day bucket");
  assert.equal(get().days[dayKey(todayMs)], undefined, "NOT today's day bucket");
  assert.equal(get().hours[hourKey(yesterdayMs)].maskedTokens, 77, "and to yesterday's hour bucket");
});

test("applied:true contributes to appliedTokens; applied:false/absent does not; maskedTokens counts in both", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const bucket = hourKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 1, ts: t, applied: true });
  await store.record({ sessionID: "s2", maskedTokens: 50, maskedParts: 1, ts: t, applied: false });
  await store.record({ sessionID: "s3", maskedTokens: 25, maskedParts: 1, ts: t });

  // maskedTokens sums ALL reports; appliedTokens only the applied:true one.
  assert.equal(get().hours[bucket].maskedTokens, 175);
  assert.equal(get().hours[bucket].appliedTokens, 100);
});

test("rewarmTokens accumulates on a bucket; absent means 0", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const bucket = hourKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 10, maskedParts: 1, ts: t, rewarmTokens: 30 });
  await store.record({ sessionID: "s2", maskedTokens: 20, maskedParts: 1, ts: t, rewarmTokens: 5 });
  // No rewarmTokens supplied → 0 contribution.
  await store.record({ sessionID: "s3", maskedTokens: 40, maskedParts: 1, ts: t });

  assert.equal(get().hours[bucket].rewarmTokens, 35);
  assert.equal(get().days[dayKey(t)].rewarmTokens, 35);
});

test("byModel splits maskedTokens on providerID/modelID, 'unknown' when either is missing", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const bucket = hourKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 1, ts: t, providerID: "anthropic", modelID: "claude-sonnet" });
  await store.record({ sessionID: "s2", maskedTokens: 50, maskedParts: 1, ts: t, providerID: "anthropic", modelID: "claude-sonnet" });
  await store.record({ sessionID: "s3", maskedTokens: 25, maskedParts: 1, ts: t, providerID: "anthropic" }); // no modelID
  await store.record({ sessionID: "s4", maskedTokens: 15, maskedParts: 1, ts: t }); // neither

  const b = get().hours[bucket];
  assert.equal(b.byModel["anthropic/claude-sonnet"], 150, "same model sums");
  assert.equal(b.byModel["unknown"], 40, "missing either field buckets to 'unknown'");
});

test("hour pruning keeps at most 72 keys; day pruning keeps 90", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const farHour = hourKey(t - (RETAIN_HOURS + 5) * HOUR_MS);
  const nearHour = hourKey(t - 2 * HOUR_MS);
  const farDay = dayKey(t - (RETAIN_DAYS + 5) * DAY_MS);
  const nearDay = dayKey(t - 10 * DAY_MS);
  const { store, get } = makeStore({
    initial: {
      version: 2,
      days: { [farDay]: { maskedTokens: 9, reports: 1 }, [nearDay]: { maskedTokens: 1, reports: 1 } },
      hours: { [farHour]: { maskedTokens: 9, reports: 1 }, [nearHour]: { maskedTokens: 1, reports: 1 } },
      sessions: {},
    },
    now: fixed(t),
  });

  // Burst of reports across 80 hours, then a FINAL report at `t` whose ts anchors
  // the retention cutoffs at `t` — so the OLD tail is pruned, not the new head.
  for (let h = 0; h < 80; h++) {
    await store.record({ sessionID: `s${h}`, maskedTokens: 1, maskedParts: 1, ts: t - h * HOUR_MS });
  }
  await store.record({ sessionID: "final", maskedTokens: 1, maskedParts: 1, ts: t });

  // The window anchored at `t` bounds the hourly count to the 72h window (the
  // boundary slot inclusive — the same lexicographic-comparison retention the
  // day buckets use, "as today") and the daily count to the 90d window.
  assert.ok(Object.keys(get().hours).length <= RETAIN_HOURS + 1, "hours bounded by the 72h window");
  assert.ok(Object.keys(get().days).length <= RETAIN_DAYS + 1, "days bounded by the 90d window");
  assert.equal(get().hours[farHour], undefined, "beyond-72h hour bucket pruned");
  assert.equal(get().days[farDay], undefined, "beyond-90d day bucket pruned");
});

test("a v1 state (no version) loads with days emptied, sessions preserved, persists version 2", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const oldDay = dayKey(now - 5 * DAY_MS);
  let saved = null;
  const store = createCounterfactualStore({
    load: async () => ({
      days: { [oldDay]: { maskedTokens: 999, reports: 1 } }, // snapshot-semantics buckets
      sessions: { s1: { maskedTokens: 42, maskedParts: 2, lastTs: now } },
    }),
    save: async (s) => {
      saved = s;
    },
    now: fixed(now),
  });

  await store.record({ sessionID: "s2", maskedTokens: 7, maskedParts: 1, ts: now });

  assert.equal(saved.version, 2);
  assert.equal(saved.days[oldDay], undefined, "old snapshot buckets are dropped");
  assert.equal(saved.sessions.s1.maskedTokens, 42, "sessions map is preserved");
  assert.equal(saved.sessions.s2.maskedTokens, 7);
});

test("bucketSeries zero-fills, is oldest→newest, and its length equals count for both bucket sizes", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store } = makeStore({ now: fixed(t) });
  // A single report on today, spanning a few buckets.
  await store.record({ sessionID: "s1", maskedTokens: 123, maskedParts: 1, ts: t, applied: true });

  const days = await bucketSeries(store, { bucket: "day", count: 5, now: fixed(t) });
  assert.equal(days.length, 5);
  for (let i = 0; i < days.length - 1; i++) assert.ok(days[i].key < days[i + 1].key, "oldest→newest");
  const today = dayKey(t);
  assert.equal(days.find((d) => d.key === today).maskedTokens, 123);
  assert.ok(days.filter((d) => d.key !== today).every((d) => d.maskedTokens === 0), "zero-filled");
  assert.ok(days.every((d) => typeof d.t === "number" && Number.isFinite(d.t)), "t is the bucket start ms");
  assert.equal(days.find((d) => d.key === today).appliedTokens, 123);

  const hours = await bucketSeries(store, { bucket: "hour", count: 3, now: fixed(t) });
  assert.equal(hours.length, 3);
  const thisHour = hourKey(t);
  assert.equal(hours.find((h) => h.key === thisHour).maskedTokens, 123);
  assert.ok(hours.filter((h) => h.key !== thisHour).every((h) => h.maskedTokens === 0));
});

test("a report timestamp in the future is clamped to now (no runaway future bucket)", async () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(now) });
  await store.record({ sessionID: "s1", maskedTokens: 10, maskedParts: 1, ts: now + 365 * DAY_MS });
  assert.equal(get().days[dayKey(now)].maskedTokens, 10, "forward-dated report lands in today's bucket");
  assert.equal(get().sessions.s1.lastTs, now, "session lastTs is the clamped time");
});
