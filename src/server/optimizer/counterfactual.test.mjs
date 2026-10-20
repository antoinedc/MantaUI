// Tests for optimizer/counterfactual.mjs — the v3 trim-report store (sticky
// trims, spec §5). Pure/injected throughout: no real state dir — `load`/`save`
// are in-memory and `now` is a controlled clock. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCounterfactualStore,
  validateCounterfactualReport,
  isLegacyReport,
  bucketSeries,
  summaryFields,
  sideTotals,
  MAX_SESSIONS,
  RETAIN_DAYS,
  RETAIN_HOURS,
  STATE_VERSION,
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

const fixed = (ms) => () => ms;
const T0 = new Date(2026, 9, 20, 12, 0, 0).getTime();

// Opus-5.5-ish: r = 0.2, w = 5 ($/Mtok).
const RATES = { cacheRead: 0.2, cacheWrite: 5, source: "catalog", fetchedAt: T0 - HOUR_MS };

// A valid v3 report; override any field.
function rep(over = {}) {
  return {
    v: 3,
    sessionID: "ses_a",
    ts: T0,
    providerID: "anthropic",
    modelID: "claude-opus-5-5",
    rates: RATES,
    applied: { trimmedTokens: 100_000, trimmedParts: 4 },
    shadow: { trimmedTokens: 0, trimmedParts: 0 },
    change: "none",
    shadowChange: "none",
    rewarmTokens: 0,
    shadowRewarmTokens: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// validator
// ---------------------------------------------------------------------------

test("validator: a complete v3 report passes; v must be 3", () => {
  assert.equal(validateCounterfactualReport(rep()), null);
  assert.equal(validateCounterfactualReport(rep({ v: 2 })), "v");
  assert.equal(validateCounterfactualReport(rep({ v: undefined })), "v");
  assert.ok(validateCounterfactualReport(null));
  // model + rates are optional
  const bare = rep();
  delete bare.providerID;
  delete bare.modelID;
  delete bare.rates;
  assert.equal(validateCounterfactualReport(bare), null);
});

test("validator: each bad field is rejected by name", () => {
  assert.equal(validateCounterfactualReport(rep({ sessionID: "" })), "sessionID");
  assert.equal(validateCounterfactualReport(rep({ sessionID: "x".repeat(129) })), "sessionID");
  assert.equal(validateCounterfactualReport(rep({ ts: -1 })), "ts");
  assert.equal(validateCounterfactualReport(rep({ ts: NaN })), "ts");
  assert.equal(validateCounterfactualReport(rep({ providerID: "" })), "providerID");
  assert.equal(validateCounterfactualReport(rep({ modelID: 7 })), "modelID");
  assert.equal(validateCounterfactualReport(rep({ rates: { ...RATES, source: "live" } })), "rates.source");
  assert.equal(validateCounterfactualReport(rep({ rates: { ...RATES, cacheRead: -1 } })), "rates.cacheRead");
  assert.equal(validateCounterfactualReport(rep({ rates: { ...RATES, cacheWrite: "5" } })), "rates.cacheWrite");
  assert.equal(validateCounterfactualReport(rep({ rates: { ...RATES, fetchedAt: NaN } })), "rates.fetchedAt");
  assert.equal(validateCounterfactualReport(rep({ rates: 5 })), "rates");
  assert.equal(validateCounterfactualReport(rep({ applied: undefined })), "applied");
  assert.equal(
    validateCounterfactualReport(rep({ applied: { trimmedTokens: -1, trimmedParts: 0 } })),
    "applied.trimmedTokens",
  );
  assert.equal(
    validateCounterfactualReport(rep({ shadow: { trimmedTokens: 0, trimmedParts: NaN } })),
    "shadow.trimmedParts",
  );
  assert.equal(validateCounterfactualReport(rep({ change: "shrink" })), "change");
  assert.equal(validateCounterfactualReport(rep({ shadowChange: "clear" })), "shadowChange");
  assert.equal(validateCounterfactualReport(rep({ rewarmTokens: -3 })), "rewarmTokens");
  assert.equal(validateCounterfactualReport(rep({ shadowRewarmTokens: "1" })), "shadowRewarmTokens");
});

test("validator: rewarm > 0 needs a change that caused it (real and shadow)", () => {
  assert.equal(validateCounterfactualReport(rep({ change: "none", rewarmTokens: 10 })), "rewarmTokens");
  assert.equal(validateCounterfactualReport(rep({ change: "grow", rewarmTokens: 10 })), null);
  assert.equal(validateCounterfactualReport(rep({ change: "clear", rewarmTokens: 10 })), null);
  assert.equal(
    validateCounterfactualReport(rep({ shadowChange: "none", shadowRewarmTokens: 10 })),
    "shadowRewarmTokens",
  );
  assert.equal(
    validateCounterfactualReport(rep({ shadowChange: "grow", shadowRewarmTokens: 10 })),
    null,
  );
});

test("isLegacyReport: a report with no `v` is the pre-v3 shape", () => {
  assert.equal(isLegacyReport({ sessionID: "a", maskedTokens: 1, maskedParts: 1, ts: 1 }), true);
  assert.equal(isLegacyReport(rep()), false);
  assert.equal(isLegacyReport(rep({ v: 2 })), false); // a wrong `v` is invalid, not legacy
  assert.equal(isLegacyReport(null), false);
});

// ---------------------------------------------------------------------------
// store: ingest, pricing, separation
// ---------------------------------------------------------------------------

test("record: invalid is rejected and leaves state untouched", async () => {
  const { store, saves } = makeStore({ now: fixed(T0) });
  const res = await store.record(rep({ change: "bogus" }));
  assert.deepEqual(res, { ok: false, error: "change" });
  assert.equal(saves.length, 0);
});

test("record: a v2-shaped report is accepted and IGNORED (nothing stored)", async () => {
  const { store, saves } = makeStore({ now: fixed(T0) });
  const res = await store.record({ sessionID: "old", maskedTokens: 9_999, maskedParts: 3, ts: T0, applied: true });
  assert.deepEqual(res, { ok: true, ignored: true });
  assert.equal(saves.length, 0);
  const rows = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.equal(rows[0].reports, 0);
  assert.equal(rows[0].actual.trimmed, 0);
});

test("pricing at ingest: usd = trimmed×r − rewarm×(w−r), per model, stored", async () => {
  const { store, get } = makeStore({ now: fixed(T0) });
  // 100k trimmed at r=0.2 → +$0.02; 280k re-warm at (w−r)=4.8 → −$1.344
  await store.record(rep({ change: "grow", rewarmTokens: 280_000 }));
  const e = get().days[dayKey(T0)].actual.byModel["anthropic/claude-opus-5-5"];
  assert.equal(e.trimmed, 100_000);
  assert.equal(e.rewarm, 280_000);
  assert.ok(Math.abs(e.usd - (100_000 * 0.2 - 280_000 * 4.8) / 1e6) < 1e-12);
  assert.equal(e.pricedReports, 1);
  assert.equal(e.unpricedReports, 0);
});

test("a cost-only report (trimmed 0, rewarm > 0) is NEGATIVE", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(
    rep({ applied: { trimmedTokens: 0, trimmedParts: 0 }, change: "grow", rewarmTokens: 50_000 }),
  );
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.ok(row.actual.usd < 0);
  assert.ok(Math.abs(row.actual.usd - (-50_000 * 4.8) / 1e6) < 1e-12);
});

test("usd is FROZEN at ingest: each report keeps the rates it carried", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(rep({ rates: { ...RATES, cacheRead: 0.2 } }));
  await store.record(rep({ rates: { ...RATES, cacheRead: 0.5 } })); // a later price change
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.ok(Math.abs(row.actual.usd - (100_000 * 0.2 + 100_000 * 0.5) / 1e6) < 1e-12);
  assert.equal(row.actual.pricedReports, 2);
});

test("a report without rates (or without a model) adds tokens but no usd and counts unpriced", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  const noRates = rep();
  delete noRates.rates;
  const noModel = rep();
  delete noModel.providerID;
  delete noModel.modelID;
  await store.record(noRates);
  await store.record(noModel);
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.equal(row.actual.trimmed, 200_000);
  assert.equal(row.actual.usd, 0);
  assert.equal(row.actual.pricedReports, 0);
  assert.equal(row.actual.unpricedReports, 2);
  assert.ok("unknown" in row.actual.byModel);
  assert.ok("anthropic/claude-opus-5-5" in row.actual.byModel);
});

test("an idle report (nothing trimmed, nothing re-warmed) is exactly $0 and counts as priced even with no rates", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  const idle = rep({ applied: { trimmedTokens: 0, trimmedParts: 0 } });
  delete idle.rates;
  await store.record(idle);
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.equal(row.actual.pricedReports, 1);
  assert.equal(row.actual.unpricedReports, 0);
});

test("actual and potential are NEVER pooled; per-model within each", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(
    rep({
      applied: { trimmedTokens: 10_000, trimmedParts: 1 },
      shadow: { trimmedTokens: 500_000, trimmedParts: 9 },
      shadowChange: "grow",
      shadowRewarmTokens: 200_000,
    }),
  );
  await store.record(
    rep({
      providerID: "openai",
      modelID: "gpt-6-sol",
      rates: { cacheRead: 0.4, cacheWrite: 0.4, source: "config", fetchedAt: 0 },
      applied: { trimmedTokens: 7_000, trimmedParts: 1 },
      shadow: { trimmedTokens: 0, trimmedParts: 0 },
    }),
  );
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.equal(row.actual.trimmed, 17_000);
  assert.equal(row.potential.trimmed, 500_000);
  assert.deepEqual(Object.keys(row.actual.byModel).sort(), ["anthropic/claude-opus-5-5", "openai/gpt-6-sol"]);
  assert.equal(row.actual.byModel["openai/gpt-6-sol"].trimmed, 7_000);
  assert.equal(row.potential.byModel["openai/gpt-6-sol"].trimmed, 0);
  // potential's own cost: 500k×0.2 − 200k×4.8 = 100k − 960k = −860k ($·1e-6)
  assert.ok(Math.abs(row.potential.byModel["anthropic/claude-opus-5-5"].usd - (-860_000) / 1e6) < 1e-12);
  assert.equal(row.reports, 2);
});

test("a no-write-premium provider (w == r) never nets a re-warm cost", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(
    rep({
      rates: { cacheRead: 0.0182, cacheWrite: 0.0182, source: "catalog", fetchedAt: 1 },
      change: "grow",
      rewarmTokens: 400_000,
    }),
  );
  const [row] = await bucketSeries(store, { bucket: "day", count: 1, now: T0 });
  assert.ok(Math.abs(row.actual.usd - (100_000 * 0.0182) / 1e6) < 1e-12);
});

test("both day and hour buckets receive each report; keyed off report.ts, not the clock", async () => {
  const { store, get } = makeStore({ now: fixed(T0) });
  const yesterday = T0 - DAY_MS;
  await store.record(rep({ ts: yesterday }));
  assert.ok(get().days[dayKey(yesterday)]);
  assert.ok(get().hours[hourKey(yesterday)]);
  assert.equal(get().days[dayKey(T0)], undefined);
});

test("a report timestamp in the future is clamped to now", async () => {
  const { store, get } = makeStore({ now: fixed(T0) });
  await store.record(rep({ ts: T0 + 30 * DAY_MS }));
  assert.deepEqual(Object.keys(get().days), [dayKey(T0)]);
});

test("session totals ADD the tokens actually removed (not the simulated set)", async () => {
  const { store, get } = makeStore({ now: fixed(T0) });
  await store.record(rep({ applied: { trimmedTokens: 1_000, trimmedParts: 1 }, shadow: { trimmedTokens: 9_999, trimmedParts: 1 } }));
  await store.record(rep({ applied: { trimmedTokens: 2_500, trimmedParts: 1 } }));
  assert.equal(get().sessions.ses_a.trimmedTokens, 3_500);
  const f = await summaryFields(store, { days: 3, now: T0 });
  assert.deepEqual(f.bySession.ses_a, { actualTrimmedTokens: 3_500, maskedTokens: 3_500 });
});

test("sessions are capped at MAX_SESSIONS, evicting the oldest lastTs first", async () => {
  const initial = { version: STATE_VERSION, days: {}, hours: {}, sessions: {} };
  for (let i = 0; i < MAX_SESSIONS; i++) initial.sessions[`s${i}`] = { trimmedTokens: 1, lastTs: T0 - (MAX_SESSIONS - i) * 1000 };
  const { store, get } = makeStore({ initial, now: fixed(T0) });
  await store.record(rep({ sessionID: "fresh" }));
  const keys = Object.keys(get().sessions);
  assert.equal(keys.length, MAX_SESSIONS);
  assert.ok(keys.includes("fresh"));
  assert.ok(!keys.includes("s0"), "the oldest session was evicted");
});

test("retention: hours keep ≤ RETAIN_HOURS keys, days drop past RETAIN_DAYS", async () => {
  // Old-enough reports are clamped to `now`, so seed a stored state directly
  // and let a fresh report trigger pruning.
  const hours = {};
  for (let i = 0; i < RETAIN_HOURS + 40; i++) hours[hourKey(T0 - i * HOUR_MS)] = { actual: { byModel: {} }, potential: { byModel: {} }, reports: 1 };
  const days = {};
  days[dayKey(T0 - (RETAIN_DAYS + 5) * DAY_MS)] = { reports: 1 };
  days[dayKey(T0 - 3 * DAY_MS)] = { reports: 1 };
  const seeded = makeStore({ initial: { version: STATE_VERSION, days, hours, sessions: {} }, now: fixed(T0) });
  await seeded.store.record(rep());
  const s = seeded.get();
  assert.ok(Object.keys(s.hours).length <= RETAIN_HOURS + 1);
  assert.equal(s.days[dayKey(T0 - (RETAIN_DAYS + 5) * DAY_MS)], undefined);
  assert.ok(s.days[dayKey(T0 - 3 * DAY_MS)]);
});

// ---------------------------------------------------------------------------
// load: v3 drops v2 buckets AND the legacy sessions map
// ---------------------------------------------------------------------------

test("a v2 state loads EMPTY (buckets and the legacy sessions map dropped) and persists version 3", async () => {
  const v2 = {
    version: 2,
    days: { [dayKey(T0)]: { maskedTokens: 5_000, appliedTokens: 1, rewarmTokens: 2, reports: 1, byModel: { x: 1 } } },
    hours: { [hourKey(T0)]: { maskedTokens: 5_000, reports: 1 } },
    sessions: { old: { maskedTokens: 77, maskedParts: 1, lastTs: T0 } },
  };
  const { store, get } = makeStore({ initial: v2, now: fixed(T0) });
  const f0 = await summaryFields(store, { days: 2, now: T0 });
  assert.deepEqual(f0.bySession, {});
  assert.ok(f0.dailySeries.every((d) => d.potentialTrimmedTokens === 0 && d.actualTrimmedTokens === 0));
  await store.record(rep());
  const s = get();
  assert.equal(s.version, 3);
  assert.equal(s.sessions.old, undefined);
  assert.equal(s.days[dayKey(T0)].maskedTokens, undefined, "no v2 field survives");
});

test("a v1 / garbage state also loads empty", async () => {
  for (const initial of [{}, null, { days: { a: 1 } }, "x", { version: 1, sessions: { a: {} } }]) {
    const { store } = makeStore({ initial, now: fixed(T0) });
    const snap = await store.snapshot();
    assert.equal(snap.version, 3);
    assert.deepEqual(snap.days, {});
    assert.deepEqual(snap.sessions, {});
  }
});

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

test("bucketSeries zero-fills, is oldest→newest, length == count for both sizes", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(rep({ ts: T0 - 2 * HOUR_MS }));
  const hours = await bucketSeries(store, { bucket: "hour", count: 5, now: T0 });
  assert.equal(hours.length, 5);
  assert.ok(hours[0].t < hours[4].t);
  assert.equal(hours.filter((h) => h.actual.trimmed > 0).length, 1);
  const days = await bucketSeries(store, { bucket: "day", count: 3, now: T0 });
  assert.equal(days.length, 3);
  assert.deepEqual(days[0].actual, { byModel: {}, trimmed: 0, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 0 });
});

test("summaryFields: zero-filled daily series with actual, potential and the maskedTokens alias", async () => {
  const { store } = makeStore({ now: fixed(T0) });
  await store.record(rep({ shadow: { trimmedTokens: 40_000, trimmedParts: 2 } }));
  const f = await summaryFields(store, { days: 3, now: T0 });
  assert.equal(f.dailySeries.length, 3);
  const today = f.dailySeries[2];
  assert.equal(today.day, dayKey(T0));
  assert.equal(today.actualTrimmedTokens, 100_000);
  assert.equal(today.potentialTrimmedTokens, 40_000);
  assert.equal(today.maskedTokens, 40_000, "alias of potential");
  assert.equal(f.dailySeries[0].actualTrimmedTokens, 0);
});

test("sideTotals tolerates a missing or partial half", () => {
  assert.deepEqual(sideTotals(undefined), { trimmed: 0, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 0 });
  assert.deepEqual(sideTotals({ byModel: { a: { trimmed: 5 }, b: null } }), {
    trimmed: 5, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 0,
  });
});
