// optimizer/forecast.mjs — quota-window usage history + forecast-at-reset
// (Optimizer P1.4, BET-1336).
//
// The dashboard's fuel gauges show, as a tick mark, the forecasted usage at
// the current window's reset instant: "if today's burn rate holds, this window
// lands at ~78%." Pure OBSERVATION — nothing here paces or routes work; pacing
// is phase 2.
//
// Two pure functions, injected I/O only, no fs access:
//   • appendObservation — the single tap on the usage poller's publish point
//     (wired in usage.mjs). Records one {ts, pct} per key at most every
//     `minIntervalMs`, prunes observations older than `maxAgeDays`.
//   • forecastAtReset — derate the window's recent positive burn into a
//     per-hour rate, take its median, and extrapolate it out to `resetsAt`.
//     Returns null when there is not enough history to trust the forecast
//     (the UI then hides the tick) or when a reset time is missing.
//
// Key = "<provider>:<window.kind>", e.g. "claude:session". History shape:
// `{[key]: [{ts, pct}]}` with ts ascending.

export const MAX_AGE_DAYS = 28;
export const MIN_INTERVAL_MS = 900_000; // 15 minutes — no finer than one obs per key per 15m

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Any delta below this is a window RESET boundary — pct jumped back down to
// ~0 because a fresh window opened, not because usage fell. The pair straddling
// that boundary describes two different windows and must never feed a rate.
const RESET_DELTA = -10;

/**
 * PURE. Median of `numbers` (does not mutate the input). Odd → middle element;
 * even → mean of the two middle elements. Returns null for an empty array so
 * callers can treat "no median" like "no forecast".
 */
export function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * PURE. Record one observation for `obs.key`. `history` is mutated in place and
 * returned (the caller holds the only reference — usage.mjs's module state).
 *   obs = { ts, key, pct }
 *   opts = { maxAgeDays: 28, minIntervalMs: 900000 }
 * Skips (returns history unchanged) when the key's NEWEST observation is
 * younger than `minIntervalMs` — the key has already been recorded recently.
 * Appends, then prunes entries older than `maxAgeDays` (referenced from the
 * new observation's own timestamp).
 */
export function appendObservation(
  history,
  obs,
  { maxAgeDays = MAX_AGE_DAYS, minIntervalMs = MIN_INTERVAL_MS } = {},
) {
  if (!history || typeof history !== "object" || !obs) return history;
  const key = obs.key;
  const ts = Number(obs.ts);
  const pct = Number(obs.pct);
  if (typeof key !== "string" || key.length === 0 || !Number.isFinite(ts) || !Number.isFinite(pct)) {
    return history;
  }

  let arr = Array.isArray(history[key]) ? history[key] : [];

  // Skip when the newest observation for this key is younger than minIntervalMs.
  if (arr.length > 0) {
    const newest = arr[arr.length - 1];
    if (Number.isFinite(newest.ts) && ts - newest.ts < minIntervalMs) return history;
  }

  arr = [...arr, { ts, pct }];
  history[key] = arr;

  // Prune entries older than maxAgeDays (referenced from the new observation).
  const cutoff = ts - maxAgeDays * DAY_MS;
  history[key] = arr.filter((e) => Number.isFinite(e.ts) && e.ts >= cutoff);
  return history;
}

/**
 * PURE. Forecast the window's pct at its reset instant, extrapolating the
 * median recent per-hour burn rate forward. Returns an integer (rounded) or
 * null when there is no forecast.
 *
 * Consecutive deltas for `key`; any delta < -10 is a window reset boundary —
 * that PAIR is excluded. The remaining POSITIVE deltas become per-hour rates
 * (`delta / hoursBetween`). Fewer than 8 rates → null (the UI hides the tick).
 * Else forecast = clamp(currentPct + median(rates) * hoursUntil(resetsAt),
 * currentPct, 100), rounded to integer. Lower-bound clamped at currentPct —
 * a forecast never goes below the already-burned pct — and capped at 100.
 */
export function forecastAtReset(history, key, { now, resetsAt, currentPct } = {}) {
  const nowMs = Number(now);
  const resetMs = Number(resetsAt);
  const cur = Number(currentPct);
  if (!Number.isFinite(nowMs) || !Number.isFinite(resetMs) || !Number.isFinite(cur)) return null;

  const arr = history && Array.isArray(history[key]) ? history[key] : [];

  const rates = [];
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i - 1];
    const curr = arr[i];
    if (!Number.isFinite(prev?.ts) || !Number.isFinite(curr?.ts)) continue;
    const delta = curr.pct - prev.pct;
    if (delta < RESET_DELTA) continue; // window reset boundary — exclude the pair
    if (delta <= 0) continue; // only positive deltas become rates
    const hoursBetween = (curr.ts - prev.ts) / HOUR_MS;
    if (hoursBetween <= 0) continue;
    rates.push(delta / hoursBetween);
  }

  if (rates.length < 8) return null;

  const medianRate = median(rates);
  const hoursUntil = (resetMs - nowMs) / HOUR_MS;
  const raw = cur + medianRate * hoursUntil;
  return Math.round(Math.min(Math.max(raw, cur), 100));
}
