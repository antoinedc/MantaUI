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

import { budgetStore } from "./ctoStores.mjs";
import { startOfDay } from "./ctoRollups.mjs";
import { blendedPrice } from "../shared/blendedPrice.mjs";

export const DEFAULT_AMBIENT_CAP_USD = 2.5;
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

// ---------------------------------------------------------------------------
// The I/O accessor the engine consumes (injected store + seams).
// ---------------------------------------------------------------------------

export function createCtoBudget({ store = budgetStore, price = priceTokens, now = Date.now } = {}) {
  async function load() {
    try {
      return normalizeBudget(await store.load());
    } catch {
      return defaultBudgetPayload();
    }
  }
  async function save(payload) {
    await store.save(normalizeBudget(payload));
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
  return {
    record,
    payload: load,
    todayUsd: async () => todaySpend(await load(), now()),
    isCapHit: async (capUsd) => isAmbientCapHit(await load(), now(), capUsd),
    spendPerHourUsd: async () => spendPerHourNow(await load(), now()),
    expectedHourlyBurnUsd: async ({ capUsd } = {}) => expectedHourlyBurnUsd(await load(), { now: now(), capUsd }),
    didDayRoll: async () => didDayRoll(await load(), now()),
  };
}
