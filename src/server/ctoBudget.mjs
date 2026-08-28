// src/server/ctoBudget.mjs
// BET-1388 — the CTO's ambient-spend economics (spec §10.6-6, §12.1, §12.2,
// §13.3). Pure logic + injected I/O in the style of ctoRollups.mjs / ctoEngine.mjs:
// nothing here touches a live box.
//
// What lives here:
//   - Per-day ambient spend accumulation into budget.json (day rolls at local
//     midnight — same local-midnight clock as the rollups layer, reused below).
//   - The independent HARD CAP (`ctoAmbientCapUsd`, default $2.50 / day): a
//     ceiling on ambient spend that the engine consults BEFORE every ambient
//     model call, at every tier, regardless of the A12 tier dial.
//   - THRIFTY mode (§10.6-6 / §12.2): a numbered capability-shed ladder the
//     engine consults before each work type. Shed in order (1) speculative
//     candidate generation, (2) probe fan-outs, (3) profile extraction, (4)
//     hourly rollups. Kept to the last token: blocker detection, segment
//     one-liners, digest-on-open. Rungs 1–3 are the contract future (P2)
//     features must consult; rung 4 is live now (the engine skips hour
//     reduces; the day reduce reconstructs missing hours over segments).
//   - TIER gating (§3.3): `tierAllows(tier, feature)` — the pure contract the
//     engine (and later P2 features) consult before a gated work type.
//   - The A2 watchdog's expected-hourly-burn figure, derived from the trailing
//     7-day ambient spend (replaces the placeholder constant the watchdog
//     shipped with).
//
// Spend is PRICED from the existing model-ledger/catalogue pricing data via
// blendedPrice (src/shared/blendedPrice.mjs): the model's `cost` rates blended
// across the cache-heavy default mix, times the token count. An unpriceable
// model (no cost data) prices at 0 — honest: we cannot charge what we cannot
// measure.

// ---------------------------------------------------------------------------
// Reserve & spendable (§11.2, §11.3) — BET-1400
// ---------------------------------------------------------------------------
//
// The overnight CTO reserves a slice of each WINDOWED provider's plan window
// against the user's own near-term demand, so overnight autonomy never starves
// the user's interactive work. Everything here lives in FRACTION-OF-WINDOW
// space (Option A — see ctoForecast.mjs for the units decision):
//
//   reserve   = newsvendor fractile of next-day forecast demand (fraction),
//               or the §11.3 pre-forecast fallback max(observed daily max,
//               60% of window) under 14 days of history.
//   spendable = remaining − reserve, floored at 0.  (created/spendable)
//
// The fractile initializes at P95 and NOTCHES across the ladder
// [P90, P95, P99]: up (≤ P99) on each user cap-hit; down (≥ P90) after 30
// clean days. Notching is active only once ≥ 14 days of history exist — the
// pre-forecast fallback is not a fractile and never notches.
//
// Clean-day / cap-hit definitions (BET-1400 blocker resolution): a cap-hit =
// the user's plan window is exhausted (an adapter reports a window at/over
// its limit, `pct >= 100`); a clean day = no cap-hit AND no forecast-exceeding
// spend that day. Both are recorded as §14.5 ledger rows by the accessor.
//
// WINDOWLESS / NO-ADAPTER (§11.2): the reserve math is disabled (there is
// nothing to reserve) and overnight spend is bounded by an absolute $ budget,
// `ctoNightCapUsd` (user-set in Behavior, default $5/night). The forecaster
// still runs to feed the Health card, but produces no reserve.

import { budgetStore } from "./ctoStores.mjs";
import { startOfDay } from "./ctoRollups.mjs";
import { blendedPrice } from "../shared/blendedPrice.mjs";
import {
  forecastNextDayFraction,
  forecastMape,
  trailingDailySeries,
  dailyUsageFractions,
} from "./ctoForecast.mjs";

export const DEFAULT_NIGHT_CAP_USD = 5;
export const DEFAULT_AMBIENT_CAP_USD = 2.5;

// The fractile notch ladder — P95 init, P99 ceiling, P90 floor (§11.3).
export const FRACTILE_LADDER = Object.freeze([0.9, 0.95, 0.99]);
export const FRACTILE_INIT = 0.95;
// ≥ this many days of history activates notching (the pre-forecast fallback —
// which is not a fractile — never notches).
export const RESERVE_ACTIVATE_DAYS = 14;
// This many consecutive clean days lower the fractile one notch (§11.3).
export const RESERVE_CLEAN_DAYS = 30;
// The §11.3 fallback floor: 60% of the window.
export const RESERVE_FALLBACK_FLOOR = 0.6;
// Rolling look-back for the daily series — 8 weeks.
export const RESERVE_FORECAST_DAYS = 56;
export const BURN_HISTORY_DAYS = 7;
export const HOUR_MS = 3_600_000;

// A local-midnight day key. Reuses startOfDay from the rollups layer so the
// budget and the rollups agree on when a "day" starts and rolls.
export function dayKey(ts) {
  return String(startOfDay(typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now()));
}

// Hours elapsed since local midnight for `ts` (used to derive a per-hour burn).
export function hoursIntoLocalDay(ts) {
  const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  const sod = startOfDay(t);
  return Math.max(0, (t - sod) / HOUR_MS);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function dollar(v) {
  return Math.max(0, num(v));
}

export function defaultBudgetPayload() {
  return { days: {} };
}

// Normalise a stored budget payload defensively (bad/absent → empty).
export function normalizeBudget(payload) {
  if (!payload || typeof payload !== "object") return defaultBudgetPayload();
  const days = payload.days && typeof payload.days === "object" ? payload.days : {};
  return { ...payload, days };
}

export function dayBucket(payload, key) {
  const days = normalizeBudget(payload).days;
  const b = days[key];
  return b && typeof b === "object" ? b : { usd: 0, calls: 0 };
}

export function spendForDay(payload, key) {
  return dollar(dayBucket(payload, key).usd);
}

export function todaySpend(payload, now) {
  return spendForDay(payload, dayKey(now));
}

// The configured per-day ambient cap; falls back to the default when absent or
// malformed. `ctoAmbientCapUsd` is the config key (§12.1).
export function ambientCapUsd(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg.ctoAmbientCapUsd : undefined;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : DEFAULT_AMBIENT_CAP_USD;
}

// True once today's spend reaches the cap. Boundary: spends == cap counts as a
// hit (a call about to push us to the cap is blocked, not allowed through).
export function isAmbientCapHit(payload, now, capUsd) {
  return todaySpend(payload, now) >= dollar(capUsd);
}

// Accumulate a spend/call into the current local day's bucket. Pure.
export function recordSpend(payload, { now, usd, calls = 1 } = {}) {
  const p = normalizeBudget(payload);
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const key = dayKey(t);
  const prev = dayBucket(p, key);
  const days = { ...p.days, [key]: { usd: dollar(prev.usd) + dollar(usd), calls: num(prev.calls) + ((calls | 0) || 1) } };
  return { ...p, days, updatedMs: t };
}

// True when the budget's most recent record belongs to a day other than the
// current one — i.e. a local midnight has passed since the last recorded spend.
// The engine uses this to auto-clear thrifty at the daily reset (§10.6-6).
export function didDayRoll(payload, now) {
  const p = normalizeBudget(payload);
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  if (typeof p.updatedMs !== "number" || !Number.isFinite(p.updatedMs)) return false;
  return dayKey(p.updatedMs) !== dayKey(t);
}

// ---------------------------------------------------------------------------
// Pricing — tokens → USD via the model's own cost data (blendedPrice).
// ---------------------------------------------------------------------------

/**
 * The USD cost of a turn: blended price per million tokens × tokens / 1e6.
 * `model` may carry `cost` (the catalogue-provided rates); the resolved model
 * is enriched with its cost before it reaches the budget. An unpriceable model
 * (no cost) prices at 0 via blendedPrice's unknown fallback.
 */
export function priceTokens({ model, tokens, mix } = {}) {
  const perMillion = blendedPrice(model ?? {}, mix).price;
  return dollar((num(tokens) / 1_000_000) * perMillion);
}

// ---------------------------------------------------------------------------
// Expected hourly burn — A2 watchdog figure (§13.3 / BET-1385 placeholder).
// ---------------------------------------------------------------------------

/**
 * The expected ambient $/hour, derived from the trailing 7-day ambient spend
 * (total / (7 × 24)). This is what the A2 watchdog compares the measured
 * per-hour burn against (>2× → auto-thrifty, >4× → auto-pause).
 *
 * Degenerate case: when the trailing 7-day history holds no spend (a fresh
 * box), we fall back to the cap-equivalent even pace (cap / 24) rather than 0 —
 * otherwise a box with no history would trip the watchdog instantly on its very
 * first ambient call.
 */
export function expectedHourlyBurnUsd(payload, { now, capUsd } = {}) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const cap = dollar(capUsd);
  let total = 0;
  let sod = startOfDay(t);
  for (let i = 0; i < BURN_HISTORY_DAYS; i++) {
    total += spendForDay(payload, String(sod));
    sod -= 24 * HOUR_MS;
  }
  if (!(total > 0)) return cap / 24;
  return dollar(total) / (BURN_HISTORY_DAYS * 24);
}

/**
 * The measured ambient $/hour so far today — the watchdog's `getSpendPerHour`.
 * Returns 0 before the first hour of the day has elapsed.
 */
export function spendPerHourNow(payload, now) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const h = hoursIntoLocalDay(t);
  if (h <= 0) return 0;
  return todaySpend(payload, t) / h;
}

// ---------------------------------------------------------------------------
// Thrifty shed ladder (§10.6-6 / §12.2).
// ---------------------------------------------------------------------------

// The numbered shed order. Rungs 1–3 are the contract future P2 features must
// consult (they have no implementation yet — the declaration IS the interface);
// rung 4 is live now.
export const THRIFTY_SHED_ORDER = Object.freeze([
  "speculative", // (1) speculative candidate generation
  "probe", //        (2) probe fan-outs
  "profile", //      (3) profile extraction passes
  "hourly_rollups", // (4) hourly rollups (segments still summarized; hours reconstructed)
]);

// Kept to the last token (never shed by the ladder — they only stop at the
// absolute hard cap, enforced in the engine's pre-call gate).
export const THRIFTY_KEEP = Object.freeze([
  "blocker_detection",
  "segment_one_liners",
  "digest_on_open",
]);

/** True when `workType` is shed while thrifty is on. Kept work returns false. */
export function isWorkShedInThrifty(workType) {
  return THRIFTY_SHED_ORDER.includes(workType);
}

// ---------------------------------------------------------------------------
// Tier gating (§3.3) — the pure contract features consult before running.
// ---------------------------------------------------------------------------

// The minimum tier each gated feature requires. Default tier is `low`.
export const FEATURE_TIERS = Object.freeze({
  // low tier (default): the steady read-layer + rails the engine runs always.
  rollups: "low",
  digest: "low",
  facts_sync: "low",
  rails: "low",
  ledger: "low",
  // medium tier adds the ambient "think ahead" surface (P2 features must gate
  // on these; nothing implements them yet).
  suggestion: "medium",
  probe: "medium",
  profile: "medium",
  // high tier adds the overnight batch.
  overnight: "high",
});

export const TIER_ORDER = Object.freeze(["low", "medium", "high"]);

export function normalizeTier(tier) {
  return TIER_ORDER.includes(tier) ? tier : "low";
}

/**
 * Does `tier` allow `feature`? A tier allows every feature whose required tier
 * is at or below it (low ⊂ medium ⊂ high). Unknown/ungated features return
 * true (no one is locked out of something not yet gated).
 */
export function tierAllows(tier, feature) {
  const required = FEATURE_TIERS[feature];
  if (!required) return true;
  const reqIdx = TIER_ORDER.indexOf(required);
  const tierIdx = TIER_ORDER.indexOf(normalizeTier(tier));
  return tierIdx !== -1 && reqIdx !== -1 && tierIdx >= reqIdx;
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** The configured nightly $ bound for windowless/no-adapter overnight work
 *  (config `ctoNightCapUsd`, default $5/night, §11.2). */
export function nightCapUsd(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg.ctoNightCapUsd : undefined;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : DEFAULT_NIGHT_CAP_USD;
}

/** A fresh per-provider reserve-quota state row (stored under `budget.quota`). */
export function defaultQuotaState(provider = null) {
  return {
    provider,
    fractile: FRACTILE_INIT,
    activated: false,
    cleanDays: 0,
    mode: null,
    reserve: 0,
    spendable: 0,
    maxObserved: 0,
    historyDays: 0,
    remainingFrac: 0,
    mape14: null,
    updatedMs: null,
  };
}

/** Normalise a stored budget payload defensively, preserving the `quota` bag. */
export function normalizeQuota(payload) {
  const p = normalizeBudget(payload);
  const quota = p.quota && typeof p.quota === "object" ? p.quota : {};
  return { ...p, quota };
}

/** Move a fractile one ladder notch up (+1) or down (−1), clamped to the
 *  ladder [P90, P95, P99]. Unknown current values normalise to the P95 init
 *  before stepping. */
export function notchFractile(current, direction) {
  let idx = FRACTILE_LADDER.indexOf(current);
  if (idx === -1) idx = FRACTILE_LADDER.indexOf(FRACTILE_INIT);
  const target = Math.max(0, Math.min(FRACTILE_LADDER.length - 1, idx + (direction > 0 ? 1 : direction < 0 ? -1 : 0)));
  return FRACTILE_LADDER[target];
}

/**
 * Fold cap-hit / clean-day signals into a quota state (pure). Notching is only
 * applied once `activated` (≥ 14 days of history — the caller decides, since
 * only it knows the history length):
 *   - each cap-hit raises the fractile one notch (already clamped to ≤ P99),
 *   - `RESERVE_CLEAN_DAYS` accumulated clean days lower it one notch, then
 *     reset the clean streak (a clean day = no cap-hit AND no
 *     forecast-exceeding spend).
 * Returns a new state; the input is never mutated.
 */
export function foldQuotaState(state, { capHits = 0, earnedCleanDays = 0, activated = false } = {}) {
  const s = state && typeof state === "object" ? { ...state } : defaultQuotaState(null);
  let fractile = s.fractile ?? FRACTILE_INIT;
  let cleanDays = s.cleanDays ?? 0;
  if (activated) {
    cleanDays = Math.max(0, cleanDays) + Math.max(0, Number.isFinite(Number(earnedCleanDays)) ? earnedCleanDays | 0 : 0);
    const hits = Math.max(0, Number(Number(capHits) | 0));
    for (let i = 0; i < hits; i++) fractile = notchFractile(fractile, +1);
    if (cleanDays >= RESERVE_CLEAN_DAYS) {
      fractile = notchFractile(fractile, -1);
      cleanDays = 0;
    }
  }
  return { ...s, fractile, cleanDays, activated: !!activated };
}

/**
 * The §11.3 reserve + spendable for one provider's plan window (pure). `series`
 * is the contiguous trailing daily fraction series (oldest→newest, from the
 * forecast module); `forecast` is a `({series, fractile}) => {mode, value}`
 * function (default: the HW/quantile forecast — injectable for tests). Below
 * the 14-day activation gate (or when the forecaster has insufficient data) it
 * returns the pre-forecast fallback `max(observed daily max, 60% of window)`
 * at the P95 init fractile — which never notches.
 */
export function planReserve({
  state = defaultQuotaState(),
  series,
  remainingPct,
  forecast = ({ fractile } = {}) => forecastNextDayFraction({ series, fractile }),
  fallbackFloor = RESERVE_FALLBACK_FLOOR,
} = {}) {
  const vals = Array.isArray(series) ? series.filter(Number.isFinite) : [];
  const maxObserved = vals.length ? Math.max(0, ...vals) : 0;
  const historyDays = vals.filter((v) => v > 0).length;
  const activated = !!state?.activated || historyDays >= RESERVE_ACTIVATE_DAYS;
  const fractile = activated ? (state?.fractile ?? FRACTILE_INIT) : FRACTILE_INIT;

  let mode;
  let reserve;
  let point = null;
  let sigma = null;
  if (!activated) {
    mode = "fallback";
    reserve = Math.max(maxObserved, fallbackFloor);
  } else {
    const fc = forecast({ series, fractile }) ?? { mode: "fallback", value: null };
    if (fc?.mode === "forecast" && typeof fc.value === "number") {
      mode = "forecast";
      reserve = fc.value;
      point = fc.point ?? null;
      sigma = fc.sigma ?? null;
    } else {
      mode = "fallback";
      reserve = Math.max(maxObserved, fallbackFloor);
    }
  }
  reserve = clamp01(reserve);
  const remainingFrac = clamp01((Number(remainingPct) || 0) / 100);
  const spendableFrac = Math.max(0, remainingFrac - reserve);
  return {
    mode,
    activated,
    fractile,
    reserve,
    maxObserved,
    historyDays,
    remainingFrac,
    spendableFrac,
    point,
    sigma,
  };
}

// ---------------------------------------------------------------------------
// The I/O accessor the engine consumes (injected store + seams).
// ---------------------------------------------------------------------------
// The I/O accessor the engine consumes (injected store + seams).
// ---------------------------------------------------------------------------

export function createCtoBudget({
  store = budgetStore,
  price = priceTokens,
  now = Date.now,
  // BET-1400 seams (all injectable for sandboxed tests; index.mjs wires the
  // real usage-history + §14.5 ledger):
  history = async () => ({}), // () => { "<provider>:<kind>": [{ts,pct}] }
  historyKey = (provider, kind) => `${provider}:${kind}`,
  buildSeries = (obs, t) => trailingDailySeries(dailyUsageFractions(obs), { now: t, days: RESERVE_FORECAST_DAYS }),
  forecast = ({ series, fractile }) => forecastNextDayFraction({ series, fractile }),
  mapeFn = forecastMape,
  cfg = () => ({}), // () => config object (ctoNightCapUsd read here)
  ledger = null, // optional { append(row) } — the §14.5 activity ledger
} = {}) {
  async function load() {
    try {
      return normalizeQuota(await store.load());
    } catch {
      return normalizeQuota(defaultBudgetPayload());
    }
  }
  async function save(payload) {
    await store.save(normalizeQuota(payload));
  }
  async function ledgerAppend(row) {
    try {
      if (ledger && typeof ledger.append === "function") await ledger.append(row);
    } catch {
      /* ledger is best-effort — never fail quota evaluation on a ledger write */
    }
  }
  async function record({ model, tokens, nowMs } = {}) {
    const t = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : now();
    const usd = price({ model, tokens });
    try {
      const payload = await load();
      const next = recordSpend(payload, { now: t, usd, calls: 1 });
      await save(next);
      return { usd, dayKey: dayKey(t) };
    } catch {
      // Metering is best-effort: a store failure must never break the model
      // call that produced the spend. The spend is dropped, not fatal.
      return { usd, dayKey: dayKey(t), ok: false };
    }
  }

  /**
   * Re-evaluate one provider's reserve + spendable (§11.3): read the provider's
   * pct observation history, fold cap-hit/clean-day signals into its quota
   * state, compute the reserve at the active fractile (or the pre-forecast
   * fallback), persist the quota row + the §14.5 forecast cache, and return the
   * plan. This is the function C3's overnight scheduler calls on its 30-min
   * re-evaluation; the Health card reads the persisted `budget.quota`.
   *
   * `windowed: false` (a windowless provider or one with no adapter, §11.2)
   * disables the reserve: it returns `{windowed:false, mode:'windowless',
   * spendable:null, reserve:0, nightCapUsd}` and bounds overnight spend by the
   * absolute `ctoNightCapUsd` budget instead.
   */
  async function computeSpendable({
    provider,
    remainingPct,
    windowKind = "session",
    windowed = true,
    capHitsSince = 0,
    earnedCleanDays = 0,
  } = {}) {
    const t = typeof now === "function" ? now() : typeof now === "number" ? now : Date.now();
    if (!windowed) {
      let conf = {};
      try {
        conf = (await cfg()) ?? {};
      } catch {
        conf = {};
      }
      if (!conf || typeof conf !== "object") conf = {};
      return {
        provider,
        windowed: false,
        mode: "windowless",
        reserve: 0,
        spendable: null,
        remainingFrac: null,
        historyDays: 0,
        nightCapUsd: nightCapUsd(conf),
      };
    }
    const hist = (await history().catch(() => ({}))) ?? {};
    const obs = hist[historyKey(provider, windowKind)] ?? [];
    const { series, historyDays, maxObserved } = buildSeries(obs, t);

    const payload = await load();
    const prev = payload.quota?.[provider] ?? defaultQuotaState(provider);
    const activated = !!prev.activated || historyDays >= RESERVE_ACTIVATE_DAYS;
    const folded = foldQuotaState(prev, { capHits: capHitsSince, earnedCleanDays, activated });
    const plan = planReserve({ state: folded, series, remainingPct, forecast });
    const quota = {
      ...folded,
      provider,
      mode: plan.mode,
      reserve: plan.reserve,
      spendable: plan.spendableFrac,
      maxObserved: plan.maxObserved,
      historyDays: plan.historyDays,
      remainingFrac: plan.remainingFrac,
      mape14: mapeFn({ series, tailDays: 14 }),
      updatedMs: t,
    };
    const nextPayload = { ...payload, quota: { ...payload.quota, [provider]: quota } };
    try {
      await save(nextPayload);
    } catch {
      /* quota persistence is best-effort */
    }
    // §14.5 ledger rows: a fractile notch and a spendable-reserve line.
    if (folded.fractile !== (prev.fractile ?? FRACTILE_INIT)) {
      await ledgerAppend({ kind: "cto.reserve.fractile", ts: t, provider, from: prev.fractile ?? FRACTILE_INIT, to: folded.fractile });
    }
    await ledgerAppend({ kind: "cto.reserve", ts: t, provider, reserve: plan.reserve, spendable: plan.spendableFrac, fractile: plan.fractile, mode: plan.mode });
    return { provider, windowed: true, ...plan, mape14: quota.mape14 };
  }

  /**
   * Record a user cap-hit (the provider's plan window exhausted, `pct >= 100`)
   * as a §14.5 ledger row. Does not itself notch — the next evaluate folds the
   * cap-hit into the quota state. Purely a recording seam for the poller/engine
   * that observes the exhaustion.
   */
  async function recordCapHit({ provider, tsMs, pct } = {}) {
    const t = typeof tsMs === "number" && Number.isFinite(tsMs) ? tsMs : (typeof now === "function" ? now() : Date.now());
    await ledgerAppend({ kind: "cto.cap_hit", ts: t, provider, pct });
    return { ok: true };
  }

  return {
    record,
    payload: load,
    todayUsd: async () => todaySpend(await load(), now()),
    isCapHit: async (capUsd) => isAmbientCapHit(await load(), now(), capUsd),
    spendPerHourUsd: async () => spendPerHourNow(await load(), now()),
    expectedHourlyBurnUsd: async ({ capUsd } = {}) => expectedHourlyBurnUsd(await load(), { now: now(), capUsd }),
    didDayRoll: async () => didDayRoll(await load(), now()),
    computeSpendable,
    recordCapHit,
  };
}
