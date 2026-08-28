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

test("cap defaults to $2.50 and honors ctoAmbientCapUsd", () => {
  assert.equal(ambientCapUsd({}), DEFAULT_AMBIENT_CAP_USD);
  assert.equal(ambientCapUsd({ ctoAmbientCapUsd: 1.25 }), 1.25);
  assert.equal(ambientCapUsd({ ctoAmbientCapUsd: 0 }), 0);
  assert.equal(ambientCapUsd({ ctoAmbientCapUsd: -3 }), DEFAULT_AMBIENT_CAP_USD);
  assert.equal(ambientCapUsd({ ctoAmbientCapUsd: "x" }), DEFAULT_AMBIENT_CAP_USD);
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

test("expected hourly burn derives from trailing 7-day spend", () => {
  // Spend $16.80 over 7 days → 16.80 / 168h = $0.10/h.
  let p = defaultBudgetPayload();
  for (let i = 0; i < 7; i++) {
    p = recordSpend(p, { now: MIDNIGHT + i * 86_400_000 + 1000, usd: 2.4 });
  }
  const burn = expectedHourlyBurnUsd(p, { now: MIDNIGHT + 6 * 86_400_000 + 2000, capUsd: 2.5 });
  assert.ok(Math.abs(burn - 0.1) < 1e-9);
  // Old spend ages out of the 7-day window: the day-7 bucket alone, /168h.
  const onlyRecent = defaultBudgetPayload();
  expectedHourlyBurnUsd;
  const p2 = recordSpend(defaultBudgetPayload(), { now: MIDNIGHT + 6 * 86_400_000 + 1000, usd: 1.68 });
  const burn2 = expectedHourlyBurnUsd(p2, { now: MIDNIGHT + 6 * 86_400_000 + 5000, capUsd: 2.5 });
  assert.ok(Math.abs(burn2 - 1.68 / 168) < 1e-9);
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
  // only (no older history) → $2.50 / 168h; the fresh-box fallback only fires
  // when there is NO history at all.
  assert.equal(await budget.expectedHourlyBurnUsd({ capUsd: 2.5 }), 2.5 / 168);
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

test("computeSpendable: windowless/no-adapter routes to the $ bound (no reserve)", async () => {
  const budget = createCtoBudget({ store: { load: async () => ({}), save: async () => {} }, cfg: () => ({ ctoNightCapUsd: 3 }) });
  const plan = await budget.computeSpendable({ provider: "someone", windowed: false });
  assert.equal(plan.mode, "windowless");
  assert.equal(plan.windowed, false);
  assert.equal(plan.spendable, null);
  assert.equal(plan.reserve, 0);
  assert.equal(plan.nightCapUsd, 3);
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
