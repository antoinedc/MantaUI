// src/server/ctoBudget.mjs
// BET-1388 — the CTO's ambient-spend economics (spec §10.6-6, §12.1, §12.2,
// §13.3). Pure logic + injected I/O in the style of ctoRollups.mjs / ctoEngine.mjs:
// nothing here touches a live box.
//
// What lives here:
//   - Per-day ambient spend accumulation into budget.json (day rolls at local
//     midnight — same local-midnight clock as the rollups layer, reused below).
//   - The independent HARD CAP (`ctoAmbientCap`, default $2.50 / day): a
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

import { budgetStore, patchStore } from "./ctoStores.mjs";
import { startOfDay } from "./ctoRollups.mjs";
import { blendedPrice } from "../shared/blendedPrice.mjs";
import { effectsForVerdict } from "./ctoVerdicts.mjs";
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
// malformed. `ctoAmbientCap` is the config key (§12.1) — the same key the UI
// writes. `ctoAmbientCapUsd` is a retired spelling kept as a one-release
// fallback for stale configs; the canonical key wins when both are present.
export function ambientCapUsd(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg.ctoAmbientCap : undefined;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  const legacy = cfg && typeof cfg === "object" ? cfg.ctoAmbientCapUsd : undefined;
  return typeof legacy === "number" && Number.isFinite(legacy) && legacy >= 0
    ? legacy
    : DEFAULT_AMBIENT_CAP_USD;
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

/**
 * Tonight's estimated overnight spend, priced from the cto ledger (§11.2): the
 * sum of `priceTokens` over TODAY's `cto.overnight.job_started` rows' estTokens
 * (the prompt-size estimate the engine records at dispatch — §12.1 metering
 * style). Rows from other days, other kinds, or without a usable estTokens are
 * ignored; an unpriceable `modelCost` (null / no cost rates) prices at 0, so
 * the night cap cannot trip from an unknown model — pass a priceable cost.
 */
export function overnightSpendUsd(rows, { now, modelCost = null } = {}) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const key = dayKey(t);
  let total = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.kind !== "cto.overnight.job_started") continue;
    if (typeof r?.ts !== "number" || !Number.isFinite(r.ts) || dayKey(r.ts) !== key) continue;
    const toks = Number(r?.estTokens);
    if (!Number.isFinite(toks) || toks <= 0) continue;
    total += priceTokens({ model: { cost: modelCost }, tokens: toks });
  }
  return dollar(total);
}

// ---------------------------------------------------------------------------
// Expected hourly burn — A2 watchdog figure (§13.3 / BET-1385 placeholder).
// ---------------------------------------------------------------------------

/**
 * The expected ambient $/hour — the baseline the A2 watchdog compares the
 * measured per-hour burn against (>2× → auto-thrifty, >4× → auto-pause).
 * Derived from the trailing 7-day spend, divided by ACTIVE days only
 * (day-buckets with non-zero spend, × 24) — a blanket 7×24 denominator crushed
 * the baseline toward 0 on a box that spends on only a few days a week
 * (BET-1462 defects 1–2). The result is floored at the cap-equivalent even
 * pace (cap / 24): no history may push the baseline below what the box is
 * configured to spend, or a tiny measured burn reads as a huge multiple and
 * trips the watchdog (the 2026-08-31 auto-pause incident).
 */
export function expectedHourlyBurnUsd(payload, { now, capUsd } = {}) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const cap = dollar(capUsd);
  let total = 0;
  let activeDays = 0;
  let sod = startOfDay(t);
  for (let i = 0; i < BURN_HISTORY_DAYS; i++) {
    const usd = spendForDay(payload, String(sod));
    if (usd > 0) activeDays += 1;
    total += usd;
    sod -= 24 * HOUR_MS;
  }
  return Math.max(dollar(total) / (Math.max(1, activeDays) * 24), cap / 24);
}

/**
 * The measured ambient $/hour so far today — the watchdog's `getSpendPerHour`.
 * The divisor never drops below one hour: 30 seconds past local midnight a
 * single $0.01 call measures $0.01/hr, not ~$1.20 (BET-1462 defect 3). At the
 * exact midnight instant (0 hours elapsed) the reading is 0.
 */
export function spendPerHourNow(payload, now) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const h = hoursIntoLocalDay(t);
  if (h <= 0) return 0;
  return todaySpend(payload, t) / Math.max(1, h);
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
// ROI self-report (§12.4) — BET-1405
// ---------------------------------------------------------------------------
//
// A MONTHLY ledger roll: total CTO spend vs counted outcomes (accepted
// suggestions, merged CTO branches, incidents where a blocker surfaced before
// the user hit them) + a tier recommendation. Copy-only — the recommendation
// never writes the dial; the Health row renders it and the user decides.
//
// Data durability drives the shape. The three outcome counters differ:
//   - spend: budget.json day buckets (durable, indefinite),
//   - accepted suggestions + incidents: verdicts.json (180d) and the §14.5
//     ledger (180d) — recomputable for any month inside retention,
//   - merged branches: delegate jobs are swept after 7 days, so the month's
//     job list cannot be re-read at month end. Instead every terminal CTO job
//     is SAMPLED into `budget.roi.pending` (branch + project dir + finish ts)
//     while the record is fresh; each later refresh probes the project repo
//     (the existing git read of the project) and counts the merge. A merge
//     discovered late (the branch was cleaned up days later) still lands on
//     its finish month.
//
// Recommendation rules (deterministic, documented — the roll is labeled
// self-reported and imperfect counts are acceptable):
//   - no spend and no outcomes           → stay ("nothing to judge yet")
//   - spend ≥ $1 and zero outcomes       → lower (money without results)
//   - outcomes ≥ ROI_MIN_OUTCOMES_RAISE  → raise (earning its keep)
//   - otherwise                          → stay (hold the current tier)

export const ROI_MIN_OUTCOMES_RAISE = 5;
export const ROI_MIN_SPEND_USD_LOWER = 1;

export function roiMonthKey(t) {
  const ts = typeof t === "number" && Number.isFinite(t) ? t : Date.now();
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" → { startTs, endTs } in local time; endTs exclusive. Bad keys → null. */
export function monthWindow(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  if (month0 < 0 || month0 > 11) return null;
  const startTs = new Date(year, month0, 1, 0, 0, 0, 0).getTime();
  const endTs = new Date(year, month0 + 1, 1, 0, 0, 0, 0).getTime();
  return { startTs, endTs };
}

/** Sum of the day buckets inside a month window (the month's total CTO spend —
 *  ambient and overnight both meter into the same buckets). */
export function monthSpendUsd(payload, window) {
  const startTs = window?.startTs;
  const endTs = window?.endTs;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 0;
  const days = normalizeBudget(payload).days;
  let total = 0;
  for (const key of Object.keys(days)) {
    const ts = Number(key);
    if (!Number.isFinite(ts) || ts < startTs || ts >= endTs) continue;
    total += dollar(days[key]?.usd);
  }
  return dollar(total);
}

/** Accepted suggestions in a window — the SAME single mapping table the §9.5
 *  router and the Health acceptance row read, so the roll can never drift
 *  from what the rest of the system calls "accepted". */
export function acceptedSuggestions(verdictRows, window) {
  const startTs = window?.startTs;
  const endTs = window?.endTs;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 0;
  const rows = Array.isArray(verdictRows) ? verdictRows : [];
  return rows.filter((v) => {
    const ts = typeof v?.ts === "number" && Number.isFinite(v.ts) ? v.ts : NaN;
    if (!Number.isFinite(ts) || ts < startTs || ts >= endTs) return false;
    const fx = effectsForVerdict(v.verdict, v.never === true);
    return fx.success === true && fx.rejection !== true;
  }).length;
}

/**
 * Incidents surfaced before the user hit them (§12.4) — deterministic over
 * the ledger + segments: a resolved blocker card counts when its card's
 * source event predates ANY user prompt on the owning session (the segments
 * store's 30-day retention is the observation horizon). Cards without a
 * sessionID (health watchdog escalations) cannot be evaluated — excluded,
 * a documented limitation of this self-reported counter.
 */
export function preSurfacedIncidents({ resolvedRows, createdTsByCardId, promptTsBySession, window } = {}) {
  const startTs = window?.startTs;
  const endTs = window?.endTs;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return 0;
  const rows = Array.isArray(resolvedRows) ? resolvedRows : [];
  let count = 0;
  for (const r of rows) {
    const ts = typeof r?.ts === "number" && Number.isFinite(r.ts) ? r.ts : NaN;
    if (!Number.isFinite(ts) || ts < startTs || ts >= endTs) continue;
    if (r?.kind !== "card.resolved" || r?.variant !== "blocker") continue;
    const sessionID = typeof r?.sessionID === "string" && r.sessionID ? r.sessionID : null;
    if (!sessionID) continue;
    const createdTs = createdTsByCardId?.[r.cardId];
    const sourceTs = typeof createdTs === "number" && Number.isFinite(createdTs) ? createdTs : ts;
    const prompts = promptTsBySession?.get?.(sessionID) ?? [];
    const anyPrior = prompts.some((p) => typeof p === "number" && Number.isFinite(p) && p < sourceTs);
    if (!anyPrior) count += 1;
  }
  return count;
}

/**
 * A delegate record's branch merged — pure predicate over the injected git
 * probe of the project repo plus the injected forge probe (BET-1422):
 *   - branch gone (`exists === false`) → merged: the cleanup path deletes
 *     with `git branch -d`, which only succeeds on merged branches — the
 *     deletion is the merge's fingerprint;
 *   - branch present and `merge-base --is-ancestor` true → merged locally;
 *   - branch present but not an ancestor, and the PR the forge carries for
 *     the branch reports merged (`prMerged === true`) → merged: a squash
 *     merge creates a NEW commit, so the local branch tip is never an
 *     ancestor of HEAD and the two local-git signals cannot see it;
 *   - otherwise (including a probe failure or an unknown forge answer) →
 *     not merged.
 */
export function isJobMerged(probe) {
  if (!probe || typeof probe !== "object") return false;
  if (probe.exists === false) return true;
  if (probe.isAncestor === true) return true;
  return probe.prMerged === true;
}

/** The monthly recommendation. Copy-only; the dial is never written. */
export function roiRecommendation({ spendUsd, accepted, merged, incidents } = {}) {
  const spend = dollar(spendUsd);
  const outcomes =
    Math.max(0, Math.trunc(Number(accepted) || 0)) +
    Math.max(0, Math.trunc(Number(merged) || 0)) +
    Math.max(0, Math.trunc(Number(incidents) || 0));
  if (outcomes <= 0 && spend <= 0) return { tier: "stay", reason: "no spend and no counted outcomes yet" };
  if (outcomes <= 0 && spend >= ROI_MIN_SPEND_USD_LOWER) {
    return { tier: "lower", reason: `$${spend.toFixed(2)} spent with no counted outcomes` };
  }
  if (outcomes >= ROI_MIN_OUTCOMES_RAISE) return { tier: "raise", reason: `${outcomes} counted outcomes this month` };
  return {
    tier: "stay",
    reason: `${outcomes} outcome${outcomes === 1 ? "" : "s"} for $${spend.toFixed(2)} — holding`,
  };
}

function normalizeRoi(payload) {
  const p = normalizeQuota(payload);
  const roi = p.roi && typeof p.roi === "object" ? p.roi : {};
  const months = roi.months && typeof roi.months === "object" ? roi.months : {};
  const pending = Array.isArray(roi.pending) ? roi.pending.filter((j) => j && typeof j === "object") : [];
  return { ...p, roi: { months, pending } };
}

function monthAccumulator(months, key) {
  const prev = months[key] && typeof months[key] === "object" ? months[key] : {};
  return {
    month: key,
    spendUsd: dollar(prev.spendUsd),
    accepted: Math.max(0, Math.trunc(Number(prev.accepted) || 0)),
    merged: Math.max(0, Math.trunc(Number(prev.merged) || 0)),
    incidents: Math.max(0, Math.trunc(Number(prev.incidents) || 0)),
    computedAt: typeof prev.computedAt === "number" && Number.isFinite(prev.computedAt) ? prev.computedAt : 0,
    frozen: prev.frozen === true,
  };
}

// Pending rows older than this are dropped (bounded growth; a merge that
// surfaced 60 days late is beyond the report's honest horizon).
export const ROI_PENDING_RETENTION_MS = 60 * 24 * HOUR_MS;

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
  // BET-1405 ROI seams (§12.4 — all injectable; index.mjs wires the real
  // delegate jobs, the project's git read, verdicts, segments and ledger):
  jobsRead = async () => [], // () => [{id, actor, status, branch, cwd, finishedAt}]
  gitProbe = async () => ({ exists: false, isAncestor: false }), // ({cwd, branch}) => {exists, isAncestor}
  // BET-1422 forge seams — the squash-merge signal a local git probe cannot
  // see (a squash creates a NEW commit, so the branch tip never becomes an
  // ancestor of HEAD). discoverJobPr resolves the job's own PR on the forge
  // by its branch head, open OR merged; null = the forge answered and no PR
  // matches (definitive — the roll stops re-asking), a THROW = the forge was
  // not consultable (transient — the roll retries on a later refresh).
  // forgeProbe answers that PR's merged state: true/false/null (unknown —
  // the row stays uncounted and is retried later).
  discoverJobPr = async () => {
    throw new Error("discoverJobPr not wired");
  }, // ({cwd, branch}) => {repoKey, number} | null (null = definitive no-PR)
  forgeProbe = async () => null, // ({repoKey, number, head}) => boolean | null
  verdictsRead = async () => [], // () => [{verdict, never, ts}]
  segmentsRead = async () => [], // () => [{sessionID, events: [{t, kind}]}]
  ledgerRead = async () => [], // () => ledger rows [{kind, ts, ...}]
} = {}) {
  async function load() {
    try {
      return normalizeQuota(await store.load());
    } catch {
      return normalizeQuota(defaultBudgetPayload());
    }
  }
  // BET-1464 defect 3: every budget.json write routes through patchStore —
  // the read-fresh-merge-save runs under the budget store's mutex. The spend
  // recorder fires per model call; the overnight roll (refreshRoi) holds the
  // same mutex across its multi-second probe body, so a mid-roll spend row
  // can no longer be reverted by the roll's stale-snapshot save. Mutators
  // receive the RAW store payload and normalize it themselves; the patch is
  // the full normalized payload (every key owned), so the merged state keeps
  // the on-disk shape the accessors expect.
  function patchBudget(mutate) {
    return patchStore(store, (fresh) => mutate(normalizeQuota(fresh)));
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
      await patchBudget((payload) => recordSpend(payload, { now: t, usd, calls: 1 }));
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
   * disables the reserve — it returns the same key set as the windowed plan
   * (`spendableFrac: null`, `reserve: 0`, `mode: 'windowless'`, plus
   * `nightCapUsd`) and bounds overnight spend by the absolute
   * `ctoNightCapUsd` budget instead: pass the day's ledger rows via
   * `overnightRows` and the overnight model's catalogue `cost` via
   * `overnightModelCost`, and once tonight's estimated overnight spend
   * (`overnightSpendUsd`) reaches the cap the plan's `spendableFrac` flips to
   * 0 (the machine's budgetFrac 0 selects nothing further) with
   * `overnightCapHit: true` — the caller ledgers the cap-hit. An unpriceable
   * model (no `cost`) estimates $0, so the cap cannot trip — the caller
   * should pass a priceable cost object. The forecaster still runs (§11.2):
   * the pct series is built, `mape14` computed (null without usable history)
   * and persisted in the quota row for the Health card.
   */
  async function computeSpendable({
    provider,
    remainingPct,
    windowKind = "session",
    windowed = true,
    capHitsSince = 0,
    earnedCleanDays = 0,
    overnightRows,
    overnightModelCost = null,
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
      // §11.2: reserve disabled, but the forecaster still runs to feed the
      // Health card — build the same pct-history series the windowed path
      // uses and persist a quota row carrying `mape14` (reserve stays 0;
      // overnight spend is bounded by the absolute `ctoNightCapUsd` instead).
      const hist = (await history().catch(() => ({}))) ?? {};
      const obs = hist[historyKey(provider, windowKind)] ?? [];
      const { series, historyDays, maxObserved } = buildSeries(obs, t);
      const mape14 = mapeFn({ series, tailDays: 14 });
      const quota = {
        ...defaultQuotaState(provider),
        mode: "windowless",
        reserve: 0,
        spendable: null,
        maxObserved,
        historyDays,
        remainingFrac: null,
        mape14,
        updatedMs: t,
      };
      try {
        await patchBudget((payload) => ({ ...payload, quota: { ...payload.quota, [provider]: quota } }));
      } catch {
        /* quota persistence is best-effort */
      }
      await ledgerAppend({ kind: "cto.reserve", ts: t, provider, reserve: 0, spendable: null, fractile: quota.fractile, mode: "windowless" });
      // Same key set as the windowed plan below — C3's re-evaluation seam
      // consumes both modes uniformly (null where the concept doesn't apply).
      // §11.2 absolute $ bound: tonight's estimated overnight spend priced
      // from the ledger's job_started rows; cap exhausted → spendableFrac 0.
      const cap = nightCapUsd(conf);
      const spent = overnightSpendUsd(overnightRows, { now: t, modelCost: overnightModelCost });
      const capHit = cap > 0 && spent >= cap;
      return {
        provider,
        windowed: false,
        mode: "windowless",
        activated: false,
        fractile: quota.fractile,
        reserve: 0,
        maxObserved,
        historyDays,
        remainingFrac: null,
        spendableFrac: capHit ? 0 : null,
        point: null,
        sigma: null,
        mape14,
        overnightSpentUsd: spent,
        overnightCapHit: capHit,
        nightCapUsd: cap,
      };
    }
    const hist = (await history().catch(() => ({}))) ?? {};
    const obs = hist[historyKey(provider, windowKind)] ?? [];
    const { series, historyDays, maxObserved } = buildSeries(obs, t);

    // BET-1464 defect 3: the fold derives from the provider's PREVIOUS quota
    // row read FRESH inside the store mutex — the old load-then-save shape
    // suspended inside load(), letting a concurrent spend row land and then
    // reverted it with the stale snapshot.
    let plan = null;
    let quota = null;
    let prev = null;
    let folded = null;
    try {
      await patchBudget((payload) => {
        prev = payload.quota?.[provider] ?? defaultQuotaState(provider);
        const activated = !!prev.activated || historyDays >= RESERVE_ACTIVATE_DAYS;
        folded = foldQuotaState(prev, { capHits: capHitsSince, earnedCleanDays, activated });
        plan = planReserve({ state: folded, series, remainingPct, forecast });
        quota = {
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
        return { ...payload, quota: { ...payload.quota, [provider]: quota } };
      });
    } catch {
      /* quota persistence is best-effort — the fold replays on the next refresh */
    }
    if (!plan) {
      // Degenerate: the store path failed before deriving anything. Re-derive
      // from a plain read (no persistence attempt — same outcome as the old
      // caught save failure) so the caller still gets a plan.
      const payload = await load();
      prev = payload.quota?.[provider] ?? defaultQuotaState(provider);
      const activated = !!prev.activated || historyDays >= RESERVE_ACTIVATE_DAYS;
      folded = foldQuotaState(prev, { capHits: capHitsSince, earnedCleanDays, activated });
      plan = planReserve({ state: folded, series, remainingPct, forecast });
      quota = {
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

  // --- ROI self-report (§12.4, BET-1405) ---------------------------------

  // Per-session user prompt timestamps from the segments store (30d horizon —
  // the observation window the incidents heuristic is honest about).
  async function promptTsBySession() {
    let segments = [];
    try {
      segments = (await segmentsRead()) ?? [];
    } catch {
      segments = [];
    }
    const bySession = new Map();
    for (const s of segments) {
      if (!s || typeof s.sessionID !== "string" || !s.sessionID) continue;
      const events = Array.isArray(s.events) ? s.events : [];
      const list = bySession.get(s.sessionID) ?? [];
      for (const ev of events) {
        if (ev?.kind !== "prompt") continue;
        const t = typeof ev.t === "number" && Number.isFinite(ev.t) ? ev.t : NaN;
        if (Number.isFinite(t)) list.push(t);
      }
      bySession.set(s.sessionID, list);
    }
    return bySession;
  }

  // Recompute one month's store-derived counters (spend/accepted/incidents)
  // and attach the accumulated merged count + the copy-only recommendation.
  // Returns null when ANY source read failed — a month whose sources could
  // not be read must never persist as frozen zeros (noise as signal).
  async function computeMonth(acc, t) {
    const window = monthWindow(acc.month);
    if (!window) return null;
    let payload = null;
    let verdicts = null;
    let ledgerRows = null;
    let prompts = null;
    try {
      payload = await load();
    } catch {
      payload = null;
    }
    try {
      verdicts = (await verdictsRead()) ?? [];
    } catch {
      verdicts = null;
    }
    try {
      ledgerRows = (await ledgerRead()) ?? [];
    } catch {
      ledgerRows = null;
    }
    try {
      prompts = await promptTsBySession();
    } catch {
      prompts = null;
    }
    if (!payload || verdicts == null || ledgerRows == null || prompts == null) return null;
    const createdTsByCardId = {};
    for (const r of ledgerRows) {
      if (r?.kind === "card.created" && typeof r?.cardId === "string" && typeof r?.ts === "number" && Number.isFinite(r.ts)) {
        const prev = createdTsByCardId[r.cardId];
        createdTsByCardId[r.cardId] = typeof prev === "number" ? Math.min(prev, r.ts) : r.ts;
      }
    }
    const resolved = ledgerRows.filter((r) => r?.kind === "card.resolved");
    const spend = monthSpendUsd(payload, window);
    const accepted = acceptedSuggestions(verdicts, window);
    const incidents = preSurfacedIncidents({
      resolvedRows: resolved,
      createdTsByCardId,
      promptTsBySession: prompts,
      window,
    });
    const merged = acc.merged;
    return {
      ...acc,
      spendUsd: spend,
      accepted,
      incidents,
      merged,
      recommendation: roiRecommendation({ spendUsd: spend, accepted, merged, incidents }),
      computedAt: t,
    };
  }

/** A well-formed forge PR reference ({repoKey, number}) — or null. */
function validPrRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  if (typeof ref.repoKey !== "string" || !ref.repoKey) return null;
  if (!Number.isInteger(ref.number) || ref.number < 1) return null;
  return ref;
}

/**
 * Advance the monthly roll (§12.4). Idempotent per refresh; safe to call on
   * every health read. Samples fresh terminal CTO jobs into `roi.pending`
   * (the jobs store sweeps after 7 days — the branch names are the durable
   * record), probes pending branches against the project repo and — for
   * branches still present and not an ancestor of HEAD, which is what a
   * squash merge leaves behind (BET-1422) — against the forge: the job's PR
   * is resolved by branch head once (`prTried` marks a definitive no-PR so
   * PR-less jobs never re-query), then its merged state is probed. Recomputes
   * the store-derived counters: the current month on every refresh, the
   * previous month once after it closes (frozen thereafter). Persisted
   * best-effort — a store failure degrades the report, never the caller.
   */
  async function refreshRoi() {
    const t = typeof now === "function" ? now() : Date.now();
    let months = {};
    let pending = [];
    try {
      // BET-1464 defect 3: the roll holds the budget store's mutex across its
      // whole multi-second body (sampling, probes, month recomputes). The old
      // shape read the payload up front and saved it at the end, so a spend
      // row recorded by a concurrent model call was silently reverted by the
      // stale snapshot. The body is an async IIFE so its awaits hold the
      // store mutex — the serialization IS the fix. The roll's working shape
      // is normalizeRoi's (quota normalization + the roi/months/pending
      // defaults), the same normalizer the old load path applied.
      await patchStore(store, (raw) => {
        const payload = normalizeRoi(raw);
        months = { ...payload.roi.months };
        pending = payload.roi.pending.map((j) => ({ ...j }));
        const countMerged = (row) => {
          const key = roiMonthKey(typeof row.finishedAt === "number" ? row.finishedAt : t);
          const acc = monthAccumulator(months, key);
          acc.merged += 1;
          months[key] = acc;
          row.counted = true;
        };
        return (async () => {
          // 1. Sample terminal CTO-actor jobs not yet snapshotted.
          let jobs = [];
          try {
            jobs = (await jobsRead()) ?? [];
          } catch {
            jobs = [];
          }
          // Every pending id — counted or not — is a dedupe fingerprint: a job
          // already snapshotted (and probed) must never re-sample.
          const known = new Set(pending.map((j) => j.id));
          for (const j of jobs) {
            if (!j || j.actor !== "cto" || j.status !== "done") continue;
            if (typeof j.branch !== "string" || !j.branch) continue;
            if (typeof j.id !== "string" || !j.id || known.has(j.id)) continue;
            pending.push({
              id: j.id,
              branch: j.branch,
              cwd: typeof j.cwd === "string" ? j.cwd : "",
              finishedAt: typeof j.finishedAt === "number" && Number.isFinite(j.finishedAt) ? j.finishedAt : null,
              counted: false,
            });
          }

          // 2. Probe pending branches (merged = branch deleted-on-merge, or
          //    present and an ancestor of the project's HEAD, or its forge PR
          //    reports merged — the squash-merge case, BET-1422). Probe
          //    failures leave the row uncounted for a later refresh.
          for (const row of pending) {
            if (row.counted === true) continue;
            let probe = { exists: false, isAncestor: false };
            try {
              probe = (await gitProbe({ cwd: row.cwd, branch: row.branch })) ?? probe;
            } catch {
              probe = { exists: false, isAncestor: false };
            }
            if (isJobMerged(probe)) {
              countMerged(row);
              continue;
            }
            // The local-git signals can never fire for a squash merge: resolve
            // the job's PR on the forge (once — a resolved PR or a definitive
            // no-PR is persisted on the row so neither is ever re-queried; an
            // unconsultable forge leaves both markers unset so the next
            // refresh retries), then probe its state.
            const havePr = validPrRef(row.pr);
            if (!havePr && row.prTried !== true && typeof discoverJobPr === "function") {
              try {
                const pr = await discoverJobPr({ cwd: row.cwd, branch: row.branch });
                if (validPrRef(pr)) {
                  row.pr = { repoKey: pr.repoKey, number: pr.number };
                } else {
                  row.prTried = true;
                }
              } catch {
                /* transient — retried on a later refresh */
              }
            }
            const pr = validPrRef(row.pr);
            if (!pr) continue;
            let prMerged = null;
            try {
              prMerged = await forgeProbe({ repoKey: pr.repoKey, number: pr.number, head: row.branch });
            } catch {
              prMerged = null;
            }
            if (isJobMerged({ ...probe, prMerged })) countMerged(row);
          }

          // 3. Recompute the store-derived counters: current month every
          //    refresh; the previous month once after it closes, then frozen.
          const currentKey = roiMonthKey(t);
          const currentWindow = monthWindow(currentKey);
          const prevKey = currentWindow ? roiMonthKey(currentWindow.startTs - 1) : null;
          const toCompute = [currentKey];
          if (prevKey && months[prevKey]?.frozen !== true) toCompute.push(prevKey);
          for (const key of toCompute) {
            const acc = monthAccumulator(months, key);
            const isCurrent = key === currentKey;
            const computed = await computeMonth({ ...acc, frozen: !isCurrent }, t);
            if (computed) months[key] = computed;
          }

          // 4. Hygiene: drop stale pending rows.
          const cutoff = t - ROI_PENDING_RETENTION_MS;
          const kept = pending.filter((j) => j.counted === true ? (typeof j.finishedAt === "number" ? j.finishedAt >= cutoff : true) : true);
          const trimmed = kept.slice(-200);
          pending = trimmed;

          return { ...payload, roi: { months, pending: trimmed } };
        })();
      });
    } catch {
      /* ROI persistence is best-effort — a store failure degrades the report */
    }
    return { months, pending };
  }

  /** The render model for the Health ROI row (§12.4): the most recent CLOSED
   *  month's roll, or `collecting — first report <date>` until the first
   *  monthly roll lands (the end of the month of first recorded spend). */
  async function roiSnapshot() {
    const t = typeof now === "function" ? now() : Date.now();
    let payload;
    try {
      payload = normalizeRoi(await store.load());
    } catch {
      payload = normalizeRoi(defaultBudgetPayload());
    }
    const months = payload.roi.months;
    const dayKeys = Object.keys(payload.days)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const firstActivityTs = dayKeys.length ? dayKeys[0] : null;
    const currentKey = roiMonthKey(t);
    const currentWindow = monthWindow(currentKey);
    const prevKey = currentWindow ? roiMonthKey(currentWindow.startTs - 1) : null;
    const roll = prevKey ? (months[prevKey] ?? null) : null;
    return {
      month: roll ? prevKey : null,
      roll,
      collectingUntil:
        firstActivityTs != null ? (monthWindow(roiMonthKey(firstActivityTs))?.endTs ?? null) : null,
    };
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
    refreshRoi,
    roiSnapshot,
  };
}
