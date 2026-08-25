// Tests for optimizer/counterfactual.mjs — the observe-mode masking
// counterfactual store (Optimizer P1.3, BET-1335). Pure/injected throughout:
// no real state dir — `load`/`save` are in-memory and `now` is a controlled
// clock. Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCounterfactualStore,
  validateCounterfactualReport,
  MAX_SESSIONS,
  RETAIN_DAYS,
} from "./counterfactual.mjs";

const DAY_MS = 86_400_000;

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

test("a report REPLACES the session's counterfactual, and today's day is the sum of sessions whose latest report is today", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const today = dayKey(t);

  await store.record({ sessionID: "s1", maskedTokens: 100, maskedParts: 3, ts: t });
  await store.record({ sessionID: "s2", maskedTokens: 200, maskedParts: 2, ts: t });
  assert.equal(get().days[today].maskedTokens, 300, "two sessions today sum");
  assert.equal(get().days[today].reports, 2);

  // s1's NEWER report replaces its old 100 → today becomes 200(s1) + 200(s2).
  await store.record({ sessionID: "s1", maskedTokens: 1000, maskedParts: 4, ts: t });
  assert.equal(get().days[today].maskedTokens, 1200);
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
      days: {
        [oldDay]: { maskedTokens: 999, reports: 1 },
        [recentDay]: { maskedTokens: 7, reports: 1 },
      },
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

test("record is idempotent per report (same report twice → same state)", async () => {
  const t = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const { store, get } = makeStore({ now: fixed(t) });
  const today = dayKey(t);
  await store.record({ sessionID: "s1", maskedTokens: 42, maskedParts: 2, ts: t });
  const first = JSON.parse(JSON.stringify(get()));
  await store.record({ sessionID: "s1", maskedTokens: 42, maskedParts: 2, ts: t });
  assert.deepEqual(get(), first);
  assert.equal(get().days[today].maskedTokens, 42);
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
