// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AMBIENT_CAP_USD,
  DEFAULT_NIGHT_CAP_USD,
  FRACTILE_INIT,
  THRIFTY_SHED_ORDER,
  THRIFTY_KEEP,
  createCtoBudget,
  ambientCapUsd,
  dayKey,
  defaultBudgetPayload,
  defaultQuotaState,
  didDayRoll,
  expectedHourlyBurnUsd,
  foldQuotaState,
  hoursIntoLocalDay,
  isAmbientCapHit,
  isWorkShedInThrifty,
  nightCapUsd,
  notchFractile,
  overnightSpendUsd,
  planReserve,
  priceTokens,
  recordSpend,
  spendForDay,
  spendPerHourNow,
  tierAllows,
  todaySpend,
} from "./ctoBudget.mjs";

// A fixed "local midnight" baseline for deterministic tests (any epoch ms that
// is a local midnight is fine; we derive other times from it).
function dayStart(offsetDays = 0) {
  const d = new Date(2026, 7, 28, 0, 0, 0, 0); // Aug 28 2026, local midnight
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}
const MIDNIGHT = dayStart(0);
const NOON = MIDNIGHT + 12 * 3_600_000;

// A budget over a given payload snapshot with all external reads quiet (no
// jobs, no git probes, no ledger/verdict/segment rows); `now` pins the clock.
function makeQuietBudget(payload, now) {
  let current = payload;
  const store = { load: async () => current, save: async (p) => (current = p) };
  return createCtoBudget({
    store,
    jobsRead: async () => [],
    gitProbe: async () => ({ exists: false, isAncestor: false }),
    ledgerRead: async () => [],
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    now,
  });
}

test("cap defaults to $2.50 and honors ctoAmbientCap", () => {
  assert.equal(ambientCapUsd({}), DEFAULT_AMBIENT_CAP_USD);
  assert.equal(ambientCapUsd({ ctoAmbientCap: 1.25 }), 1.25);
  assert.equal(ambientCapUsd({ ctoAmbientCap: 0 }), 0);
  assert.equal(ambientCapUsd({ ctoAmbientCap: -3 }), DEFAULT_AMBIENT_CAP_USD);
  assert.equal(ambientCapUsd({ ctoAmbientCap: "x" }), DEFAULT_AMBIENT_CAP_USD);
  // Retired spelling kept as a one-release fallback for stale configs.
  assert.equal(ambientCapUsd({ ctoAmbientCapUsd: 1.25 }), 1.25);
  // Canonical key wins when both spellings are present.
  assert.equal(ambientCapUsd({ ctoAmbientCap: 5, ctoAmbientCapUsd: 1.25 }), 5);
  // Malformed canonical falls through to a well-formed legacy alias, then default.
  assert.equal(ambientCapUsd({ ctoAmbientCap: "x", ctoAmbientCapUsd: 1.25 }), 1.25);
  assert.equal(ambientCapUsd({ ctoAmbientCap: -3, ctoAmbientCapUsd: 1.25 }), 1.25);
});

test("day rolls at local midnight (spend lands in separate day buckets)", () => {
  const late = MIDNIGHT + 23 * 3_600_000 + 59_999; // 23:59:59.999
  const fresh = MIDNIGHT + 86_400_000; // next local midnight
  let p = defaultBudgetPayload();
  p = recordSpend(p, { now: late, usd: 2.0 });
  p = recordSpend(p, { now: fresh, usd: 0.5 });
  assert.equal(todaySpend(p, late), 2.0);
  assert.equal(todaySpend(p, fresh), 0.5);
  assert.equal(spendForDay(p, dayKey(fresh)), 0.5);
  assert.notEqual(dayKey(late), dayKey(fresh));
});

test("didDayRoll detects that a midnight passed since the last record", () => {
  let p = defaultBudgetPayload();
  p = recordSpend(p, { now: MIDNIGHT + 60_000 });
  assert.equal(didDayRoll(p, MIDNIGHT + 60_000), false);
  assert.equal(didDayRoll(p, MIDNIGHT + 24 * 3_600_000 + 60_000), true);
  // No recorded spend at all → no roll signal.
  assert.equal(didDayRoll(defaultBudgetPayload(), MIDNIGHT + 86_400_000), false);
});

test("hard cap trips once today's spend reaches the cap (boundary inclusive)", () => {
  let p = defaultBudgetPayload();
  assert.equal(isAmbientCapHit(p, NOON, 2.5), false);
  p = recordSpend(p, { now: NOON, usd: 2.49 });
  assert.equal(isAmbientCapHit(p, NOON, 2.5), false);
  p = recordSpend(p, { now: NOON, usd: 0.01 });
  assert.equal(isAmbientCapHit(p, NOON, 2.5), true);
  // A new day resets the cap.
  assert.equal(isAmbientCapHit(p, MIDNIGHT + 86_400_000, 2.5), false);
});

test("recordSpend accumulates usd and call count per bucket", () => {
  let p = defaultBudgetPayload();
  p = recordSpend(p, { now: NOON, usd: 1, calls: 1 });
  p = recordSpend(p, { now: NOON + 1000, usd: 2, calls: 3 });
  const b = p.days[dayKey(NOON)];
  assert.equal(b.usd, 3);
  assert.equal(b.calls, 4);
});

test("priceTokens prices via the model cost and a cache-heavy mix", () => {
  const model = {
    providerID: "anthropic",
    id: "claude-3-5-sonnet",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  // ~0.8 cacheRead * 0.3 + 0.08 input * 3 + 0.07 write * 3.75 + 0.05 output * 15
  // = 0.24 + 0.24 + 0.2625 + 0.75 = 1.4925 $ / 1M tokens.
  const usd = priceTokens({ model, tokens: 1_000_000 });
  assert.ok(Math.abs(usd - 1.4925) < 1e-9);
  // Proportional: 500k tokens ≈ half.
  assert.ok(Math.abs(priceTokens({ model, tokens: 500_000 }) - usd / 2) < 1e-9);
  // Free model → 0 regardless of tokens.
  assert.equal(priceTokens({ model: { cost: { input: 0, output: 0 } }, tokens: 5_000_000 }), 0);
  // Unknown cost → 0 (cannot price what we cannot measure).
  assert.equal(priceTokens({ model: { providerID: "x", id: "y" }, tokens: 1_000_000 }), 0);
});

test("BET-1462: trailing spend pacing below the cap-equivalent pace floors at cap/24", () => {
  // Spend $16.80 over 7 days → 16.80 / 168h = $0.10/h — below the $2.50
  // cap-equivalent pace, so the new floor wins (BET-1462 defect 1).
  let p = defaultBudgetPayload();
  for (let i = 0; i < 7; i++) {
    p = recordSpend(p, { now: MIDNIGHT + i * 86_400_000 + 1000, usd: 2.4 });
  }
  const burn = expectedHourlyBurnUsd(p, { now: MIDNIGHT + 6 * 86_400_000 + 2000, capUsd: 2.5 });
  assert.ok(Math.abs(burn - 2.5 / 24) < 1e-9);
  // Old spend ages out of the 7-day window: one active day → 1.68/24h = $0.07,
  // again below the floor (BET-1462 defects 1+2).
  const p2 = recordSpend(defaultBudgetPayload(), { now: MIDNIGHT + 6 * 86_400_000 + 1000, usd: 1.68 });
  const burn2 = expectedHourlyBurnUsd(p2, { now: MIDNIGHT + 6 * 86_400_000 + 5000, capUsd: 2.5 });
  assert.ok(Math.abs(burn2 - 2.5 / 24) < 1e-9);
});

test("BET-1462: expected burn floors at the cap-equivalent pace (incident numbers)", () => {
  // 2026-08-31 incident: the box's 7-day ambient total was $0.00005173744. The
  // old baseline ($0.00000031/hr, no floor) let today's $0.0000041/hr measured
  // burn read as >4x and auto-pause the engine. With the floor, the same
  // history yields the cap-equivalent pace.
  const p = recordSpend(defaultBudgetPayload(), {
    now: MIDNIGHT + 6 * 86_400_000 + 1000,
    usd: 5.173744e-5,
  });
  const burn = expectedHourlyBurnUsd(p, { now: MIDNIGHT + 6 * 86_400_000 + 5000, capUsd: 2.5 });
  assert.ok(Math.abs(burn - 2.5 / 24) < 1e-9);
});

test("BET-1462: a lone active day divides by 24h, not the blanket 168h", () => {
  // A single $5 call inside an otherwise-empty trailing window: the active-day
  // denominator (defect 2) measures $5/24 ≈ $0.2083 — above the $2.50 floor,
  // so the division itself is observable (not 5/168 ≈ $0.0298).
  const p = recordSpend(defaultBudgetPayload(), { now: MIDNIGHT + 6 * 86_400_000 + 1000, usd: 5 });
  const burn = expectedHourlyBurnUsd(p, { now: MIDNIGHT + 6 * 86_400_000 + 5000, capUsd: 2.5 });
  assert.ok(Math.abs(burn - 5 / 24) < 1e-9);
  assert.ok(Math.abs(burn - 5 / 168) > 1e-9);
});

test("empty history falls back to the cap-equivalent pace (never 0)", () => {
  const burn = expectedHourlyBurnUsd(defaultBudgetPayload(), { now: NOON, capUsd: 2.5 });
  assert.equal(burn, 2.5 / 24);
});

test("spendPerHourNow measures today's burn vs hours elapsed", () => {
  const p = recordSpend(defaultBudgetPayload(), { now: NOON, usd: 1.2 }); // 12h into day
  assert.ok(Math.abs(spendPerHourNow(p, NOON) - 0.1) < 1e-9);
  assert.equal(spendPerHourNow(p, MIDNIGHT), 0); // 0 hours elapsed
});

test("BET-1462: spendPerHourNow never divides by a fraction of an hour", () => {
  // 30 seconds past local midnight with $0.01 spent: the divisor is floored at
  // 1 hour → $0.01/hr, not $0.01/0.0083h ≈ $1.20 (the 2026-08-31 trip shape).
  const early = MIDNIGHT + 30_000;
  const p = recordSpend(defaultBudgetPayload(), { now: early, usd: 0.01 });
  const perHour = spendPerHourNow(p, early);
  assert.ok(Math.abs(perHour - 0.01) < 1e-9);
  assert.ok(Math.abs(perHour - 1.2) > 1e-9);
});

test("thrifty shed ladder: ordered shed vs the kept-to-last-token set", () => {
  assert.deepEqual(THRIFTY_SHED_ORDER, ["speculative", "probe", "profile", "hourly_rollups"]);
  assert.deepEqual(THRIFTY_KEEP, ["blocker_detection", "segment_one_liners", "digest_on_open"]);
  for (const w of THRIFTY_SHED_ORDER) assert.equal(isWorkShedInThrifty(w), true);
  for (const w of THRIFTY_KEEP) assert.equal(isWorkShedInThrifty(w), false);
  assert.equal(isWorkShedInThrifty("nonsense"), false);
});

test("tierAllows table (low ⊂ medium ⊂ high; default low)", () => {
  // low tier gates: steady read-layer.
  assert.equal(tierAllows("low", "rollups"), true);
  assert.equal(tierAllows("low", "digest"), true);
  assert.equal(tierAllows("low", "facts_sync"), true);
  assert.equal(tierAllows("low", "rails"), true);
  assert.equal(tierAllows("low", "ledger"), true);
  // low tier is denied the medium/high ambient surface.
  assert.equal(tierAllows("low", "suggestion"), false);
  assert.equal(tierAllows("low", "probe"), false);
  assert.equal(tierAllows("low", "profile"), false);
  assert.equal(tierAllows("low", "overnight"), false);
  // medium adds suggestion/probe/profile but not overnight.
  assert.equal(tierAllows("medium", "suggestion"), true);
  assert.equal(tierAllows("medium", "probe"), true);
  assert.equal(tierAllows("medium", "profile"), true);
  assert.equal(tierAllows("medium", "overnight"), false);
  // high adds overnight (and everything below).
  assert.equal(tierAllows("high", "overnight"), true);
  assert.equal(tierAllows("high", "rollups"), true);
  // Unknown tier falls back to low; unknown feature is ungated.
  assert.equal(tierAllows(undefined, "suggestion"), false);
  assert.equal(tierAllows("bogus", "suggestion"), false);
  assert.equal(tierAllows("low", "whatever_new"), true);
});

test("createCtoBudget records into an injected store and reports todayUsd/cap", async () => {
  let saved = { v: 1, days: {} };
  const store = {
    load: async () => saved,
    save: async (p) => {
      saved = p;
    },
  };
  const price = ({ tokens }) => tokens / 1_000_000 * 5; // deterministic $5/1M
  const clock = { ms: NOON };
  const budget = createCtoBudget({ store, price, now: () => clock.ms });

  assert.equal(await budget.todayUsd(), 0);
  assert.equal(await budget.isCapHit(2.5), false);

  await budget.record({ model: {}, tokens: 500_000 }); // $2.50
  assert.equal(await budget.todayUsd(), 2.5);
  assert.equal(await budget.isCapHit(2.5), true);

  // A spend that crosses the cap is still recorded (it already happened);
  // the NEXT call gates. 
  // Expected burn + spend-per-hour derive from the same store. $2.50 today
  // only (one active day) → $2.50 / 24h, matching the cap-equivalent floor
  // (BET-1462 defect 2 replaced the old blanket $2.50 / 168h).
  assert.equal(await budget.expectedHourlyBurnUsd({ capUsd: 2.5 }), 2.5 / 24);
  assert.ok((await budget.spendPerHourUsd()) > 0);
});

test("createCtoBudget degrades safely when the store is down", async () => {
  const store = {
    load: async () => {
      throw new Error("boom");
    },
    save: async () => {
      throw new Error("boom");
    },
  };
  const budget = createCtoBudget({ store, now: () => NOON });
  assert.equal(await budget.todayUsd(), 0);
  assert.equal(await budget.isCapHit(2.5), false);
  await budget.record({ model: {}, tokens: 1000 }); // must not throw
  assert.equal(await budget.expectedHourlyBurnUsd({ capUsd: 2.5 }), 2.5 / 24);
});

// ---------------------------------------------------------------------------
// BET-1400 — reserve & spendable (§11.2, §11.3)
// ---------------------------------------------------------------------------

test("nightCapUsd defaults to $5 and honors ctoNightCapUsd", () => {
  assert.equal(nightCapUsd({}), DEFAULT_NIGHT_CAP_USD);
  assert.equal(nightCapUsd({ ctoNightCapUsd: 3 }), 3);
  assert.equal(nightCapUsd({ ctoNightCapUsd: 0 }), 0);
  assert.equal(nightCapUsd({ ctoNightCapUsd: -1 }), DEFAULT_NIGHT_CAP_USD);
});

test("notchFractile walks the [P90,P95,P99] ladder and clamps", () => {
  assert.equal(notchFractile(0.95, +1), 0.99);
  assert.equal(notchFractile(0.99, +1), 0.99); // max P99
  assert.equal(notchFractile(0.95, -1), 0.9);
  assert.equal(notchFractile(0.9, -1), 0.9); // min P90
  assert.equal(notchFractile(999, +1), 0.99); // unknown normalises from P95 init
});

test("foldQuotaState: no notching before activation (>= 14 days)", () => {
  const s = foldQuotaState(defaultQuotaState(), { capHits: 5, earnedCleanDays: 60, activated: false });
  assert.equal(s.fractile, FRACTILE_INIT);
  assert.equal(s.cleanDays, 0);
  assert.equal(s.activated, false);
});

test("foldQuotaState: cap-hits raise the fractile one notch (max P99)", () => {
  const s = foldQuotaState(defaultQuotaState(), { capHits: 1, activated: true });
  assert.equal(s.fractile, 0.99);
  // a second hit stays clamped at P99
  const s2 = foldQuotaState(defaultQuotaState(), { capHits: 2, activated: true });
  assert.equal(s2.fractile, 0.99);
  // from P90 a single hit climbs one rung
  const s3 = foldQuotaState({ ...defaultQuotaState(), fractile: 0.9 }, { capHits: 1, activated: true });
  assert.equal(s3.fractile, 0.95);
});

test("foldQuotaState: 30 clean days lower the fractile one notch (min P90)", () => {
  const s = foldQuotaState(defaultQuotaState(), { earnedCleanDays: 30, activated: true });
  assert.equal(s.fractile, 0.9);
  assert.equal(s.cleanDays, 0); // streak reset after the notch
  // 60 clean days still notch only once per fold
  const s2 = foldQuotaState(defaultQuotaState(), { earnedCleanDays: 60, activated: true });
  assert.equal(s2.fractile, 0.9);
  // from 0.99 one clean month steps down to 0.95
  const s3 = foldQuotaState({ ...defaultQuotaState(), fractile: 0.99 }, { earnedCleanDays: 30, activated: true });
  assert.equal(s3.fractile, 0.95);
});

test("planReserve: pre-forecast fallback below 14 days uses max(observed, 60% window)", () => {
  const plan = planReserve({ state: defaultQuotaState(), series: [0.1, 0.1, 0.1], remainingPct: 50 });
  assert.equal(plan.mode, "fallback");
  assert.equal(plan.activated, false);
  assert.equal(plan.fractile, FRACTILE_INIT);
  assert.equal(plan.reserve, 0.6); // max(0.1, 0.6)
  assert.equal(plan.spendableFrac, 0); // remaining(0.5) < reserve(0.6) → floored at 0
});

test("planReserve: forecast mode above the gate; spendable = remaining − reserve", () => {
  const series = Array(14).fill(0.1);
  const plan = planReserve({
    state: defaultQuotaState(),
    series,
    remainingPct: 90,
    forecast: () => ({ mode: "forecast", value: 0.3, point: 0.25, sigma: 0.05 }),
  });
  assert.equal(plan.mode, "forecast");
  assert.equal(plan.activated, true);
  assert.ok(Math.abs(plan.reserve - 0.3) < 1e-9);
  assert.ok(Math.abs(plan.spendableFrac - 0.6) < 1e-9);
});

test("planReserve: spendable floored at 0 when remaining < reserve", () => {
  const plan = planReserve({
    state: { ...defaultQuotaState(), activated: true },
    series: Array(14).fill(0.1),
    remainingPct: 20,
    forecast: () => ({ mode: "forecast", value: 0.3 }),
  });
  assert.equal(plan.spendableFrac, 0);
});

test("planReserve: forecast that returns fallback still degrades to the fallback", () => {
  const plan = planReserve({
    state: { ...defaultQuotaState(), activated: true },
    series: Array(14).fill(0.1),
    remainingPct: 80,
    forecast: () => ({ mode: "fallback", value: null }),
  });
  assert.equal(plan.mode, "fallback");
  assert.equal(plan.reserve, 0.6);
});

test("computeSpendable: windowless/no-adapter routes to the $ bound (no reserve, no history → no MAPE)", async () => {
  let saved = null;
  const ledgerRows = [];
  const budget = createCtoBudget({
    store: { load: async () => ({}), save: async (p) => (saved = p) },
    cfg: () => ({ ctoNightCapUsd: 3 }),
    ledger: { append: (r) => ledgerRows.push(r) },
  });
  const plan = await budget.computeSpendable({ provider: "someone", windowed: false });
  assert.equal(plan.mode, "windowless");
  assert.equal(plan.windowed, false);
  assert.equal(plan.spendableFrac, null);
  assert.equal(plan.reserve, 0);
  assert.equal(plan.nightCapUsd, 3);
  // no usable history → the forecaster yields no MAPE, but the key set still
  // matches the windowed plan (uniform seam for C3)
  assert.equal(plan.mape14, null);
  assert.equal(plan.historyDays, 0);
  assert.equal(plan.maxObserved, 0);
  assert.equal(plan.remainingFrac, null);
  // a quota row is still persisted (mode windowless, reserve 0)
  assert.equal(saved.quota.someone.mode, "windowless");
  assert.equal(saved.quota.someone.reserve, 0);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.reserve" && r.mode === "windowless"));
});

test("computeSpendable: windowless still computes the forecast for the health card (§11.2)", async () => {
  let saved = null;
  const ledgerRows = [];
  const budget = createCtoBudget({
    store: { load: async () => ({}), save: async (p) => (saved = p) },
    now: () => NOON,
    history: async () => ({ "kimi:session": [{ ts: NOON, pct: 10 }] }),
    buildSeries: () => ({ series: Array(14).fill(0.1), historyDays: 14, maxObserved: 0.1 }),
    mapeFn: () => 7.5,
    ledger: { append: (r) => ledgerRows.push(r) },
    cfg: () => ({ ctoNightCapUsd: 3 }),
  });
  const plan = await budget.computeSpendable({ provider: "kimi", windowed: false });
  assert.equal(plan.windowed, false);
  assert.equal(plan.mode, "windowless");
  assert.equal(plan.reserve, 0);
  assert.equal(plan.spendableFrac, null);
  assert.equal(plan.mape14, 7.5); // the forecaster ran — the health card is fed
  assert.equal(plan.historyDays, 14);
  assert.ok(Math.abs(plan.maxObserved - 0.1) < 1e-9);
  assert.equal(plan.nightCapUsd, 3);
  // the persisted row carries the MAPE and no reserve
  assert.equal(saved.quota.kimi.mape14, 7.5);
  assert.equal(saved.quota.kimi.reserve, 0);
  assert.equal(saved.quota.kimi.mode, "windowless");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.reserve" && r.mode === "windowless"));
});

test("computeSpendable: windowed persists quota + attaches §14.5 ledger rows", async () => {
  let saved = null;
  const ledgerRows = [];
  const store = {
    load: async () => ({}),
    save: async (p) => {
      saved = p;
    },
  };
  const budget = createCtoBudget({
    store,
    now: () => NOON,
    history: async () => ({ "claude:session": [{ ts: NOON, pct: 10 }] }),
    buildSeries: (obs, t) => ({ series: Array(14).fill(0.1), historyDays: 14, maxObserved: 0.1 }),
    forecast: () => ({ mode: "forecast", value: 0.25, point: 0.2, sigma: 0.05 }),
    mapeFn: () => 5,
    ledger: { append: (r) => ledgerRows.push(r) },
  });
  const plan = await budget.computeSpendable({ provider: "claude", remainingPct: 80, windowed: true, capHitsSince: 1 });
  assert.equal(plan.windowed, true);
  assert.equal(plan.reserve, 0.25);
  assert.ok(Math.abs(plan.spendableFrac - 0.55) < 1e-9); // 0.8 − 0.25
  assert.equal(plan.fractile, 0.99); // capHitsSince 1 notched up
  assert.equal(plan.mape14, 5);
  // persisted quota row reflects the plan
  assert.equal(saved.quota.claude.reserve, 0.25);
  assert.equal(saved.quota.claude.activated, true);
  // fractile change + reserve line both ledgered
  const kinds = ledgerRows.map((r) => r.kind);
  assert.ok(kinds.includes("cto.reserve.fractile"));
  assert.ok(kinds.includes("cto.reserve"));
  const fracRow = ledgerRows.find((r) => r.kind === "cto.reserve.fractile");
  assert.equal(fracRow.from, 0.95);
  assert.equal(fracRow.to, 0.99);
});

test("recordCapHit writes a cto.cap_hit ledger row", async () => {
  const ledgerRows = [];
  const budget = createCtoBudget({
    store: { load: async () => ({}), save: async () => {} },
    now: () => NOON,
    ledger: { append: (r) => ledgerRows.push(r) },
  });
  await budget.recordCapHit({ provider: "claude", pct: 100 });
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].kind, "cto.cap_hit");
  assert.equal(ledgerRows[0].provider, "claude");
  assert.equal(ledgerRows[0].pct, 100);
});

// ---------------------------------------------------------------------------
// BET-1405 — ROI monthly roll (§12.4)
// ---------------------------------------------------------------------------

import {
  ROI_MIN_OUTCOMES_RAISE,
  ROI_MIN_SPEND_USD_LOWER,
  ROI_PENDING_RETENTION_MS,
  roiMonthKey,
  monthWindow,
  monthSpendUsd,
  acceptedSuggestions,
  preSurfacedIncidents,
  isJobMerged,
  roiRecommendation,
} from "./ctoBudget.mjs";

const AUG_KEY = roiMonthKey(MIDNIGHT); // 2026-08 local
const JUL_KEY = "2026-07";

test("roiMonthKey + monthWindow are local-month consistent", () => {
  assert.equal(AUG_KEY, "2026-08");
  const w = monthWindow(AUG_KEY);
  assert.equal(w.startTs, new Date(2026, 7, 1).getTime()); // Aug 1, local
  assert.equal(w.endTs, monthWindow("2026-09").startTs); // Aug has 31 days
  assert.equal(monthWindow("nope"), null);
  assert.equal(monthWindow("2026-13"), null);
  assert.equal(monthWindow(undefined), null);
});

test("monthSpendUsd sums only the buckets inside the month window", () => {
  let p = defaultBudgetPayload();
  p = recordSpend(p, { now: MIDNIGHT + 3_600_000, usd: 1.25 }); // Aug 28
  p = recordSpend(p, { now: dayStart(-5) + 3_600_000, usd: 0.75 }); // Aug 23
  p = recordSpend(p, { now: dayStart(-40) + 3_600_000, usd: 9.99 }); // July
  assert.equal(monthSpendUsd(p, monthWindow(AUG_KEY)), 2.0);
  assert.equal(monthSpendUsd(p, monthWindow(JUL_KEY)), 9.99);
  assert.equal(monthSpendUsd(p, null), 0);
});

test("acceptedSuggestions reuses the §9.5 verdict mapping (never-flag ≠ accept)", () => {
  const w = monthWindow(AUG_KEY);
  const rows = [
    { verdict: "accept", ts: MIDNIGHT + 1_000 },
    { verdict: "edit", ts: MIDNIGHT + 2_000 },
    { verdict: "dismiss", ts: MIDNIGHT + 3_000 },
    { verdict: "accept", never: true, ts: MIDNIGHT + 4_000 },
    { verdict: "accept", ts: dayStart(-40) }, // outside window
    { verdict: "accept", ts: undefined },
  ];
  assert.equal(acceptedSuggestions(rows, w), 2);
  assert.equal(acceptedSuggestions([], w), 0);
  assert.equal(acceptedSuggestions(rows, null), 0);
});

test("preSurfacedIncidents: resolved blocker whose source event predates any user prompt on the session counts", () => {
  const w = monthWindow(AUG_KEY);
  const resolvedRows = [
    { kind: "card.resolved", variant: "blocker", cardId: "c1", sessionID: "s1", ts: MIDNIGHT + 2 * 86_400_000 },
    { kind: "card.resolved", variant: "blocker", cardId: "c2", sessionID: "s2", ts: MIDNIGHT + 2 * 86_400_000 },
    { kind: "card.resolved", variant: "blocker", cardId: "c3", sessionID: null, ts: MIDNIGHT + 2 * 86_400_000 }, // health — no sessionID, excluded
    { kind: "card.resolved", variant: "question", cardId: "c4", sessionID: "s4", ts: MIDNIGHT + 2 * 86_400_000 }, // not a blocker
    { kind: "card.resolved", variant: "blocker", cardId: "c5", sessionID: "s5", ts: dayStart(-40) }, // outside window
  ];
  const createdTsByCardId = { c1: MIDNIGHT + 1 * 86_400_000, c2: MIDNIGHT - 10 * 86_400_000, c5: dayStart(-40) };
  const promptTsBySession = new Map([
    // s1: no prompt before the card existed → counts
    // s2: user was already on the session 12 days before the card → does NOT count
    ["s2", [MIDNIGHT - 12 * 86_400_000]],
  ]);
  assert.equal(
    preSurfacedIncidents({ resolvedRows, createdTsByCardId, promptTsBySession, window: w }),
    1,
  );
});

test("preSurfacedIncidents: missing creation row falls back to the resolution ts", () => {
  const w = monthWindow(AUG_KEY);
  const count = preSurfacedIncidents({
    resolvedRows: [{ kind: "card.resolved", variant: "blocker", cardId: "cx", sessionID: "sx", ts: MIDNIGHT + 86_400_000 }],
    createdTsByCardId: {},
    promptTsBySession: new Map([["sx", [MIDNIGHT + 86_400_000 - 1]]]),
    window: w,
  });
  assert.equal(count, 0); // a prompt one ms before the fallback source ts disqualifies
});

test("isJobMerged: branch gone counts as merged; present needs merge-base ancestry; squash-merged PR counts (BET-1422)", () => {
  assert.equal(isJobMerged({ exists: false, isAncestor: false }), true);
  assert.equal(isJobMerged({ exists: true, isAncestor: true }), true);
  assert.equal(isJobMerged({ exists: true, isAncestor: false }), false);
  assert.equal(isJobMerged({ exists: true }), false);
  assert.equal(isJobMerged(null), false);
  assert.equal(isJobMerged(undefined), false);
  // The squash-merge signal: branch still present and not an ancestor, but
  // the forge reports its PR merged.
  assert.equal(isJobMerged({ exists: true, isAncestor: false, prMerged: true }), true);
  assert.equal(isJobMerged({ exists: true, isAncestor: false, prMerged: false }), false);
  assert.equal(isJobMerged({ exists: true, isAncestor: false, prMerged: null }), false);
  // The local signals keep precedence over the forge signal.
  assert.equal(isJobMerged({ exists: false, prMerged: false }), true);
  assert.equal(isJobMerged({ exists: true, isAncestor: true, prMerged: false }), true);
});

test("roiRecommendation rules: stay / lower / raise / hold", () => {
  assert.deepEqual(roiRecommendation({ spendUsd: 0, accepted: 0, merged: 0, incidents: 0 }), {
    tier: "stay",
    reason: "no spend and no counted outcomes yet",
  });
  assert.deepEqual(roiRecommendation({ spendUsd: 1.5, accepted: 0, merged: 0, incidents: 0 }), {
    tier: "lower",
    reason: "$1.50 spent with no counted outcomes",
  });
  assert.deepEqual(roiRecommendation({ spendUsd: 0.2, accepted: 0, merged: 0, incidents: 0 }), {
    tier: "stay",
    reason: "0 outcomes for $0.20 — holding",
  });
  assert.equal(
    roiRecommendation({ spendUsd: 3, accepted: ROI_MIN_OUTCOMES_RAISE - 1, merged: 1, incidents: 0 }).tier,
    "raise",
  );
  assert.equal(
    roiRecommendation({ spendUsd: 3, accepted: 2, merged: 0, incidents: 0 }).tier,
    "stay",
  );
  assert.equal(ROI_MIN_SPEND_USD_LOWER, 1);
});

test("refreshRoi: samples terminal CTO jobs, probes merges, persists months + pending", async () => {
  let payload = recordSpend(defaultBudgetPayload(), { now: dayStart(-40), usd: 0.5 }); // July activity
  const store = {
    load: async () => payload,
    save: async (p) => {
      payload = p;
    },
  };
  const jobs = [
    { id: "j1", actor: "cto", status: "done", branch: "cto/j1", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 },
    { id: "j2", actor: "cto", status: "done", branch: "cto/j2", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 },
    { id: "j3", actor: "user", status: "done", branch: "u/j3", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 }, // not CTO
    { id: "j4", actor: "cto", status: "running", branch: "cto/j4", cwd: "/proj", finishedAt: null }, // not terminal
    { id: "j5", actor: "cto", status: "done", branch: null, finishedAt: MIDNIGHT + 86_400_000 }, // no branch
  ];
  const probes = {
    "cto/j1": { exists: false, isAncestor: false }, // deleted-on-merge
    "cto/j2": { exists: true, isAncestor: false }, // not merged (yet)
  };
  const budget = createCtoBudget({
    store,
    jobsRead: async () => jobs,
    gitProbe: async ({ branch }) => probes[branch] ?? { exists: true, isAncestor: false },
    ledgerRead: async () => [],
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    now: () => MIDNIGHT + 2 * 86_400_000,
  });
  const r1 = await budget.refreshRoi();
  assert.equal(r1.pending.length, 2); // j1, j2 sampled
  assert.equal(r1.months[AUG_KEY].merged, 1); // j1 merged
  const r2 = await budget.refreshRoi();
  assert.equal(r2.pending.length, 2);
  assert.equal(r2.months[AUG_KEY].merged, 1); // idempotent — j1 not double-counted
  // The Health row renders the latest CLOSED month (July — its spend only),
  // while August's accumulator keeps the merged count for its own roll.
  const snap = await budget.roiSnapshot();
  assert.equal(snap.month, JUL_KEY);
  assert.equal(snap.roll.merged, 0);
  assert.equal(snap.roll.spendUsd, 0.5);
  assert.equal(snap.roll.recommendation.tier, "stay"); // $0.50 with no outcomes — below the $1 lower bar
  assert.equal(snap.collectingUntil, monthWindow(JUL_KEY).endTs); // first report passed
});

test("refreshRoi: counts a squash-merged PR the local git signals cannot see (BET-1422)", async () => {
  let payload = defaultBudgetPayload();
  const store = { load: async () => payload, save: async (p) => (payload = p) };
  // A squash merge creates a NEW commit, so every branch here reads "present,
  // not an ancestor" — the two local-git signals can never fire for these.
  const jobs = [
    { id: "j1", actor: "cto", status: "done", branch: "cto/j1", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 }, // PR #11 squash-merged
    { id: "j2", actor: "cto", status: "done", branch: "cto/j2", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 }, // PR #12 still open
    { id: "j3", actor: "cto", status: "done", branch: "cto/j3", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 }, // never had a PR
    { id: "j4", actor: "cto", status: "done", branch: "cto/j4", cwd: "/proj", finishedAt: MIDNIGHT + 86_400_000 }, // forge unreachable on refresh 1
  ];
  const asked = [];
  let forgeUp = false; // j4's forge is down on refresh 1, back on refresh 2
  const budget = createCtoBudget({
    store,
    jobsRead: async () => jobs,
    gitProbe: async () => ({ exists: true, isAncestor: false }),
    discoverJobPr: async ({ branch }) => {
      asked.push(branch);
      if (branch === "cto/j1") return { repoKey: "github.com/o/r", number: 11 };
      if (branch === "cto/j2") return { repoKey: "github.com/o/r", number: 12 };
      if (branch === "cto/j3") return null; // the forge answered — definitively no PR
      if (!forgeUp) throw new Error("forge down"); // j4 — not consultable (transient)
      return null;
    },
    forgeProbe: async ({ number }) => (number === 11 ? true : number === 12 ? false : null),
    ledgerRead: async () => [],
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    now: () => MIDNIGHT + 2 * 86_400_000,
  });
  await budget.refreshRoi();
  assert.deepEqual(asked, ["cto/j1", "cto/j2", "cto/j3", "cto/j4"]);
  const rows = () => Object.fromEntries(payload.roi.pending.map((j) => [j.id, j]));
  assert.equal(payload.roi.months[AUG_KEY].merged, 1); // only the squash-merged j1
  assert.equal(rows().j1.counted, true);
  assert.deepEqual(rows().j1.pr, { repoKey: "github.com/o/r", number: 11 });
  assert.equal(rows().j2.counted, false);
  assert.deepEqual(rows().j2.pr, { repoKey: "github.com/o/r", number: 12 }); // resolution persisted
  assert.equal(rows().j3.counted, false);
  assert.equal(rows().j3.prTried, true); // definitive no-PR — never re-asked
  assert.equal(rows().j4.counted, false);
  assert.equal(rows().j4.prTried, undefined); // transient failure — retried

  // Refresh 2: idempotent count; j2/j3 are not re-asked (pr resolved /
  // prTried); j4 retries and, the forge now answering, is marked definitively.
  forgeUp = true;
  await budget.refreshRoi();
  assert.deepEqual(asked.filter((b) => b === "cto/j4").length, 2);
  assert.deepEqual(asked.filter((b) => b === "cto/j2").length, 1);
  assert.deepEqual(asked.filter((b) => b === "cto/j3").length, 1);
  assert.equal(payload.roi.months[AUG_KEY].merged, 1);
  assert.equal(rows().j4.prTried, true);
});

test("refreshRoi: recomputes the previous month once after it closes, then freezes", async () => {
  let payload = defaultBudgetPayload();
  const store = {
    load: async () => payload,
    save: async (p) => {
      payload = p;
    },
  };
  let ledger = [
    { kind: "card.created", cardId: "c9", ts: dayStart(-40) + 1_000 },
    { kind: "card.resolved", variant: "blocker", cardId: "c9", sessionID: "s9", ts: dayStart(-40) + 2_000 },
  ];
  const budget = createCtoBudget({
    store,
    ledgerRead: async () => ledger,
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    jobsRead: async () => [],
    gitProbe: async () => ({ exists: false, isAncestor: false }),
    now: () => MIDNIGHT, // Aug 28 — July is closed
  });
  await budget.refreshRoi();
  const july1 = payload.roi.months[JUL_KEY];
  assert.equal(july1.incidents, 1);
  assert.equal(july1.frozen, true);

  // A later data change must NOT rewrite a frozen month.
  ledger = [];
  await budget.refreshRoi();
  const july2 = payload.roi.months[JUL_KEY];
  assert.equal(july2.incidents, 1);
  assert.equal(july2.frozen, true);

  // The current (open) month recomputes every refresh.
  const aug = payload.roi.months[AUG_KEY];
  assert.equal(aug.frozen, false);
});

test("refreshRoi: store and probe failures degrade without throwing (no frozen zeros)", async () => {
  const budget = createCtoBudget({
    store: { load: async () => { throw new Error("disk"); }, save: async () => { throw new Error("disk"); } },
    jobsRead: async () => { throw new Error("jobs"); },
    gitProbe: async () => { throw new Error("git"); },
    ledgerRead: async () => { throw new Error("ledger"); },
    verdictsRead: async () => { throw new Error("verdicts"); },
    segmentsRead: async () => { throw new Error("segments"); },
    now: () => MIDNIGHT,
  });
  const r = await budget.refreshRoi();
  assert.deepEqual(r.months, {}); // failed months are never persisted as zeros
  const snap = await budget.roiSnapshot();
  assert.equal(snap.roll, null);
  assert.equal(snap.collectingUntil, null);
});

test("roiSnapshot: collectingUntil is the first month's end from the day buckets", async () => {
  const budget = makeQuietBudget(
    recordSpend(defaultBudgetPayload(), { now: dayStart(-40), usd: 0.5 }),
    () => MIDNIGHT,
  );
  const snap = await budget.roiSnapshot();
  assert.equal(snap.roll, null); // no refresh ran → no roll stored
  assert.equal(snap.collectingUntil, monthWindow(JUL_KEY).endTs);
});

test("pending rows past the retention horizon are dropped — counted AND never-merged (BET-1466 item 5)", async () => {
  let payload = defaultBudgetPayload();
  const store = { load: async () => payload, save: async (p) => (payload = p) };
  // A stateful jobs reader: the job exists only on the first refresh (the
  // jobs store sweeps terminal records after 7 days — long before the 60d
  // pending-retention horizon, so a dropped row is never re-sampled).
  let jobsVisible = true;
  const budget = createCtoBudget({
    store,
    jobsRead: async () => {
      if (!jobsVisible) return [];
      jobsVisible = false;
      return [{ id: "old", actor: "cto", status: "done", branch: "cto/old", cwd: "/p", finishedAt: MIDNIGHT - ROI_PENDING_RETENTION_MS - 1 }];
    },
    gitProbe: async () => ({ exists: true, isAncestor: false }), // never merges
    ledgerRead: async () => [],
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    now: () => MIDNIGHT,
  });
  await budget.refreshRoi();
  await budget.refreshRoi();
  // BET-1466: the uncounted (never-merged) row is the one that used to
  // accumulate forever — it now ages out at the horizon like counted rows.
  assert.equal(payload.roi.pending.length, 0);
});

test("pending retention keeps fresh probe-pending rows and counted fingerprints (BET-1466 item 5)", async () => {
  let payload = defaultBudgetPayload();
  payload.roi = {
    months: {},
    pending: [
      { id: "fresh", counted: false, finishedAt: MIDNIGHT - 1_000 }, // probe-pending → kept
      { id: "staleUncounted", counted: false, finishedAt: MIDNIGHT - ROI_PENDING_RETENTION_MS - 1 }, // aged out (was kept forever)
      { id: "staleCounted", counted: true, finishedAt: MIDNIGHT - ROI_PENDING_RETENTION_MS - 1 }, // aged out (as before)
      { id: "countedNoFinish", counted: true, finishedAt: null }, // counted fingerprint without a ts → kept
    ],
  };
  const store = { load: async () => payload, save: async (p) => (payload = p) };
  const budget = createCtoBudget({
    store,
    jobsRead: async () => [],
    gitProbe: async () => ({ exists: true, isAncestor: false }),
    discoverJobPr: async () => null, // forge: definitively no PR
    ledgerRead: async () => [],
    verdictsRead: async () => [],
    segmentsRead: async () => [],
    now: () => MIDNIGHT,
  });
  await budget.refreshRoi();
  const ids = payload.roi.pending.map((j) => j.id).sort();
  assert.deepEqual(ids, ["countedNoFinish", "fresh"]);
});

// BET-1466 item 4: budget.json is not covered by the store sweep — the spend
// recorder itself now bounds day-bucket and ROI-month growth.
// BET-1486: the prune keys on "no unfrozen month needs these buckets" — the
// roll recomputes the current month on every refresh and the previous month
// once more after it closes, so their buckets survive the burn-window prune.
test("recordSpend prunes day buckets no live ROI recompute reads, and ROI months beyond the horizon", () => {
  const DAY = 86_400_000;
  let p = defaultBudgetPayload();
  p.days[dayKey(MIDNIGHT - 10 * DAY)] = { usd: 9, calls: 9 }; // Aug 18 — current month, outside the burn window → kept
  p.days[dayKey(MIDNIGHT - 6 * DAY)] = { usd: 1, calls: 1 }; // the oldest in-window day → kept
  p.days[dayKey(MIDNIGHT - 40 * DAY)] = { usd: 3, calls: 3 }; // Jul 19 — the previous month, unfrozen → kept
  p.days[dayKey(MIDNIGHT - 70 * DAY)] = { usd: 5, calls: 5 }; // Jun 19 — beyond every live window → dropped
  p.roi = {
    months: {
      [roiMonthKey(MIDNIGHT - 100 * DAY)]: { merged: 3 }, // past the 60d ROI horizon
      [roiMonthKey(MIDNIGHT - 40 * DAY)]: { merged: 1 }, // recent → kept (and the unfrozen previous month)
    },
    pending: [],
  };
  const out = recordSpend(p, { now: MIDNIGHT + 60_000, usd: 0.25 });
  assert.equal(out.days[dayKey(MIDNIGHT - 10 * DAY)].usd, 9, "a current-month bucket outside the burn window survives (the roll recomputes it every refresh)");
  assert.equal(out.days[dayKey(MIDNIGHT - 6 * DAY)].usd, 1, "the oldest in-window bucket survives");
  assert.equal(out.days[dayKey(MIDNIGHT - 40 * DAY)].usd, 3, "the unfrozen previous month's bucket survives (its freeze recompute needs it)");
  assert.equal(out.days[dayKey(MIDNIGHT - 70 * DAY)], undefined, "a bucket no live month recompute reads is dropped");
  assert.equal(out.days[dayKey(MIDNIGHT + 60_000)].usd, 0.25, "today's bucket is written");
  assert.equal(out.roi.months[roiMonthKey(MIDNIGHT - 100 * DAY)], undefined, "an ROI month past the horizon is dropped");
  assert.equal(out.roi.months[roiMonthKey(MIDNIGHT - 40 * DAY)].merged, 1, "a recent ROI month survives");
  assert.equal(out.roi.pending.length, 0, "pending rides along untouched");
});

// BET-1486: a missing/unfrozen entry for the previous month means its
// post-close recompute (the freeze) has not run yet — its buckets must
// survive the first post-outage spend so the roll freezes the real figure,
// not $0. Once frozen, the buckets are dead weight and prune again.
test("the closed month's buckets survive a post-outage prune until the roll freezes it, then prune (BET-1486)", () => {
  const DAY = 86_400_000;
  // >7-day outage spanning the close: the last pre-outage spend was Aug 20,
  // the first post-boot spend is Sep 10 — the whole of August is outside
  // the 7-day burn window and no roll has run since the close.
  const SEP_10 = dayStart(13) + 3_600_000;
  let p = defaultBudgetPayload();
  p.days[dayKey(dayStart(-8))] = { usd: 7, calls: 7 }; // Aug 20 — the last pre-outage day
  p.roi = { months: {}, pending: [] }; // no August entry → the freeze hasn't run
  let out = recordSpend(p, { now: SEP_10, usd: 0.25 });
  assert.equal(out.days[dayKey(dayStart(-8))].usd, 7, "the closed month's last bucket survives the first post-boot prune");
  // The roll then freezes August (correctly, from the surviving buckets);
  // the next spend prunes them.
  out = { ...out, roi: { months: { "2026-08": { merged: 2, frozen: true } }, pending: [] } };
  const out2 = recordSpend(out, { now: SEP_10 + 60_000, usd: 0.25 });
  assert.equal(out2.days[dayKey(dayStart(-8))], undefined, "once the month is frozen its buckets no longer feed any recompute — pruned");
});

// BET-1486 end-to-end: the exact issue scenario — spends through Aug 20, a
// >7-day outage spanning the close, the first post-boot spend (which prunes),
// then the first roll. The August freeze must read the real spend, not $0.
test("refreshRoi freezes the closed month at its real spend after a >7-day outage spanning the close (BET-1486)", async () => {
  const DAY = 86_400_000;
  const SEP_10 = dayStart(13) + 3_600_000;
  let payload = defaultBudgetPayload();
  payload = recordSpend(payload, { now: dayStart(-23), usd: 3 }); // Aug 5
  payload = recordSpend(payload, { now: dayStart(-8), usd: 7 }); // Aug 20 — the last pre-outage day
  payload = recordSpend(payload, { now: SEP_10, usd: 0.25 }); // Sep 10 — first post-boot spend
  const budget = makeQuietBudget(payload, () => SEP_10);
  const r = await budget.refreshRoi();
  const aug = r.months["2026-08"];
  assert.ok(aug, "the closed month's roll exists");
  assert.equal(aug.frozen, true, "the closed month is frozen on its first post-close recompute");
  assert.ok(Math.abs(aug.spendUsd - 10) < 1e-9, `the freeze reads the real August spend (got ${aug.spendUsd})`);
  assert.ok(Math.abs(r.months["2026-09"].spendUsd - 0.25) < 1e-9, "the current month's spend reads its own buckets");
});

test("overnightSpendUsd prices today's job_started estTokens at the model cost (§11.2)", () => {
  const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // 1.4925 $/Mtok blended
  const rows = [
    { kind: "cto.overnight.job_started", ts: NOON, estTokens: 1_000_000 },
    { kind: "cto.overnight.job_started", ts: NOON + 60_000, estTokens: 500_000 },
    { kind: "cto.overnight.job_started", ts: dayStart(-1), estTokens: 10_000_000 }, // yesterday — ignored
    { kind: "cto.overnight.close", ts: NOON, estTokens: 99 }, // other kind — ignored
    { kind: "cto.overnight.job_started", ts: NOON }, // no estTokens — ignored
    { kind: "cto.overnight.job_started", ts: NOON, estTokens: -5 }, // junk — ignored
  ];
  // 1.5M priceable tokens → 1.5 × 1.4925 = 2.23875
  assert.ok(Math.abs(overnightSpendUsd(rows, { now: NOON, modelCost: cost }) - 2.23875) < 1e-9);
  // Unpriceable model → $0 (the cap cannot trip on an unknown model).
  assert.equal(overnightSpendUsd(rows, { now: NOON, modelCost: null }), 0);
  // Junk rows shape → 0, never throws.
  assert.equal(overnightSpendUsd(null, { now: NOON, modelCost: cost }), 0);
});

test("computeSpendable windowless: the $ night cap flips spendableFrac to 0 when tonight's spend reaches it (§11.2)", async () => {
  let saved = null;
  const ledgerRows = [];
  const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  // 2M priceable tokens × 1.4925 $/Mtok = 2.985 spent; cap 3 not yet reached.
  const underCap = [
    { kind: "cto.overnight.job_started", ts: NOON, estTokens: 2_000_000 },
  ];
  const overCap = [...underCap, { kind: "cto.overnight.job_started", ts: NOON + 1, estTokens: 100_000 }];
  const budget = createCtoBudget({
    store: { load: async () => ({}), save: async (p) => (saved = p) },
    now: () => NOON,
    cfg: () => ({ ctoNightCapUsd: 3 }),
    ledger: { append: (r) => ledgerRows.push(r) },
  });

  const under = await budget.computeSpendable({
    provider: "someone", windowed: false, overnightRows: underCap, overnightModelCost: cost,
  });
  assert.equal(under.spendableFrac, null, "under the cap → no fractional reserve (λ=0)");
  assert.equal(under.overnightCapHit, false);
  assert.ok(Math.abs(under.overnightSpentUsd - 2.985) < 1e-9);

  const over = await budget.computeSpendable({
    provider: "someone", windowed: false, overnightRows: overCap, overnightModelCost: cost,
  });
  assert.equal(over.spendableFrac, 0, "cap exhausted → the machine selects nothing further");
  assert.equal(over.overnightCapHit, true);
  assert.equal(over.nightCapUsd, 3);
  // The caller ledgers the cap-hit; the budget itself only reports it.
  assert.ok(!ledgerRows.some((r) => r.kind === "cto.overnight.night_cap_hit"));
});
