// quotaPressure.mjs — the pure deficit-queue / shadow-price / eco math behind
// the optimizer's pacing controller (Optimizer P2.3, BET-1345).
//
// PURE: no node:* imports, no Date.now(), no I/O — everything arrives as an
// argument. This is the shared "src/shared" half of the pacing controller;
// the stateful observation/persistence half lives in
// src/server/optimizer/pacing.mjs.
//
// MODEL — a deficit queue per quota window, tracked in PCT-POINTS (absolute
// quota is not derivable: UsageWindow.limit is optional and absent for the
// claude adapter, plan totals are unpublished and vary by tier). Q_w grows
// while a window burns above pace (the drift-plus-penalty step in
// advanceDeficit), is clamped to [0,100], and is closed-form-seeded on a
// cold start / reset (seedDeficit) so a box that restarts at 90% through a
// window does not believe Q = 0.
//
// The shadow price lambda = max(0, Q_w)/V is ADDITIVE on top of the existing
// pace curve (marginalCost.mjs). `max(0, Q_w)` is zero while a window is on or
// under pace, so today's arithmetic is preserved byte-for-byte in that whole
// regime — the two terms only ever coexist over pace, where the deficit queue
// is meant to be the controller.

export const OPTIMIZER_LYAPUNOV_V = 25; // pct-points of deficit that make lambda = 1
export const PROTECTION_V_LOW = 0.35; // relative value of a general/explore turn
export const PROTECTION_V_HIGH = 1.0; // relative value of a build/plan turn
export const PROTECTION_QUANTILE = 1 - PROTECTION_V_LOW / PROTECTION_V_HIGH; // 0.65
export const PROTECTION_LAMBDA_MULTIPLIER = 3;
export const MIN_TOKENS_PER_PCT_SAMPLE = 5; // pct-points of movement before tokensPerPct is trusted
export const ECO_THRESHOLDS = [10, 25, 40]; // deficit pct-points -> eco level 1/2/3

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * PURE. Percentile of an ascending-sorted array at fraction `q` in [0,1]
 * (linear-approach index, matching the ledger's percentile helper). Returns
 * null for an empty array — callers gate on the sample count.
 */
export function quantile(sorted, q) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const p = Math.min(1, Math.max(0, q));
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * PURE. The cold-start deficit: `max(0, pct - 100 * elapsed / span)`, the
 * closed form of the queue integrated at a constant drain rate. `elapsed` is
 * the fraction of the window already gone at `now`. Returns 0 when
 * `startedAt`/`resetsAt` are unusable (no window start → cannot compute
 * elapsed — never guess).
 *
 * @returns {number}
 */
export function seedDeficit({ pct, startedAt, resetsAt, now } = {}) {
  if (!isNum(startedAt) || !isNum(resetsAt) || !isNum(now)) return 0;
  const span = resetsAt - startedAt;
  if (!(span > 0)) return 0;
  const elapsed = Math.max(0, Math.min(1, (now - startedAt) / span));
  return Math.max(0, (isNum(pct) ? pct : 0) - 100 * elapsed);
}

/**
 * PURE. The accumulator step, faithful to the drift-plus-penalty form:
 *   Q += (pct - prevPct) - rate * dt
 * where `rate = (100 - prevPct) / max(1, resetsAt - prevNow)` per ms and
 * `dt = now - prevNow`. The second term drains the queue at the window's
 * average burn-to-full rate, so a window that stays exactly on pace neither
 * over- nor under-accumulates. Result clamped to [0, 100].
 *
 * A window RESET is detected by the CALLER (`pct < prevPct - 10` — the same
 * boundary rule forecast.mjs uses); on reset the accumulator is discarded and
 * the caller re-seeds (seedDeficit). This only advances a live window.
 *
 * @param {object} args { prev, pct, prevPct, resetsAt, now, prevNow }
 * @returns {number}
 */
export function advanceDeficit({ prev, pct, prevPct, resetsAt, now, prevNow } = {}) {
  if (!isNum(resetsAt) || !isNum(now) || !isNum(prevNow)) return isNum(prev) ? prev : 0;
  const span = Math.max(1, resetsAt - prevNow);
  const rate = (100 - (isNum(prevPct) ? prevPct : 0)) / span;
  const dt = now - prevNow;
  const next = (isNum(prev) ? prev : 0) + ((isNum(pct) ? pct : 0) - (isNum(prevPct) ? prevPct : 0)) - rate * dt;
  return Math.min(100, Math.max(0, next));
}

/**
 * PURE. The shadow price lambda for a deficit. `max(0, deficit) / V`,
 * dimensionless — it multiplies a dollar figure downstream. Zero at or below
 * pace (deficit <= 0), preserving today's cost in that regime.
 *
 * @returns {number}
 */
export function shadowPrice(deficit) {
  return Math.max(0, isNum(deficit) ? deficit : 0) / OPTIMIZER_LYAPUNOV_V;
}

/**
 * PURE. Eco level from the max deficit across a provider's windows: 0 below
 * 10, 1 below 25, 2 below 40, else 3. Monotonic non-decreasing — a test
 * asserts that over a swept range.
 *
 * @returns {0|1|2|3}
 */
export function ecoLevel(maxDeficit) {
  const d = isNum(maxDeficit) ? maxDeficit : 0;
  if (d < ECO_THRESHOLDS[0]) return 0;
  if (d < ECO_THRESHOLDS[1]) return 1;
  if (d < ECO_THRESHOLDS[2]) return 2;
  return 3;
}

/**
 * PURE. The newsvendor protection level: is the remaining budget likely to run
 * out before reset, given the MEASURED per-hour rate distribution? False with
 * fewer than 8 rate samples (the same confidence gate forecastAtReset uses).
 * Else true when:
 *   remainingPct <= clamp(quantile(rates, PROTECTION_QUANTILE) * hoursUntilReset, 0, 100)
 * i.e. the remaining budget is within the burn the (1 - v_low/v_high)-quantile
 * rate is expected to consume before reset. `rates` is a per-hour pct-points
 * sample array (ascending not required — sorted here).
 *
 * @returns {boolean}
 */
export function protectionActive({ rates, hoursUntilReset, remainingPct } = {}) {
  if (!Array.isArray(rates) || rates.length < 8) return false;
  if (!isNum(hoursUntilReset) || !isNum(remainingPct)) return false;
  const sorted = [...rates].map(Number).filter(isNum).sort((a, b) => a - b);
  if (sorted.length < 8) return false;
  const q = quantile(sorted, PROTECTION_QUANTILE);
  if (q == null) return false;
  const budget = Math.min(100, Math.max(0, q * hoursUntilReset));
  return remainingPct <= budget;
}
