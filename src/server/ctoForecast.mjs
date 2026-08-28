// src/server/ctoForecast.mjs
// BET-1400 — the CTO's usage forecasting math (spec §11.2, §11.3, §14.5).
// Pure: no I/O, no imports from the live box. All inputs are injected.
//
// WHAT LIVES HERE (per the issue's "Files": ctoForecast.mjs = pure math +
// injected history):
//   - dailyUsageFractions      pct observations -> per-day usage as a fraction
//                              of the plan window (Option A, §11.3 — see below).
//   - holtWinters              additive Holt-Winters with damped trend and
//                              weekly seasonality (m=7) over a daily series.
//   - sampleStd / mape         residual scatter + forecast accuracy (§14.5).
//   - quantileForecast         newsvendor fractile from residual sigma.
//   - forecastNextDayFraction  the small exported "reserve" math: hand a
//                              trailing daily series + a fractile, get the
//                              next-day point/quantile forecast or the
//                              pre-forecast fallback.
//   - trailingDailySeries      builds the contiguous rolling-8-week daily
//                              series a forecast consumes, from observations.
//
// RESERVE UNITS (the BET-1400 blocker, resolved to Option A): reserve and
// spendable live in FRACTION-OF-WINDOW space, and the demand series comes from
// the box's existing per-provider pct observation history
// (`usage.mjs` → `statePath("usage-history.json")`, BET-1336), NOT from the
// model ledger. The windowed adapters (claude/codex/kimi) only report a
// fraction of the plan window (claude/codex: pct only; kimi: used/limit request
// counts) — they expose no window capacity in token/$ units, so a reserve
// expressed in ledger units could never be compared to `remaining`. Working in
// fraction-of-window space makes every formula in §11.3 coherent
// (`reserve = max(observed daily max, 60% of window)` meaningful, `remaining −
// reserve` comparable) with zero invented capacity. The pct history *is* a
// usage history, so this does not stretch §11.3's "usage ledger".
//
// CLEAN-DAY / CAP-HIT DEFINITIONS (also resolved by the BET-1400 blocker): a
// cap-hit = the user's provider plan window is exhausted (an adapter snapshot
// reports a window at/over its limit, `pct >= 100`). A clean day = no cap-hit
// AND no forecast-exceeding spend that day. Both are recorded as §14.5 ledger
// rows and consumed by the notch state machine in ctoBudget.mjs.

import { dayKey } from "../shared/timeBuckets.mjs";

// Standard normal Z for the newsvendor fractiles §11.3 names. The fractile
// ladder is P90 / P95 / P99; the Z values let `quantileForecast` translate
// residual sigma into the forecast at a given fractile.
export const QUANTILE_Z = Object.freeze({
  0.9: 1.2815515655446004,
  0.95: 1.6448536269514722,
  0.99: 2.3263478740408408,
});

/** Rolling look-back for the daily series — 8 weeks (56 days), per §11.3. */
export const FORECAST_LOOKBACK_DAYS = 56;

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Sample standard deviation; 0 for < 2 samples. */
export function sampleStd(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(ss / (xs.length - 1));
}

/** Mean absolute percentage error (×100, i.e. "%"). null for < 2 non-zero
 *  actuals — a MAPE with one or zero samples is noise, not signal (§10.5 never
 *  shows noise). Zero actuals are skipped (division undefined). */
export function mape(actual, forecast) {
  if (!Array.isArray(actual) || !Array.isArray(forecast)) return null;
  let sum = 0;
  let n = 0;
  const len = Math.min(actual.length, forecast.length);
  for (let i = 0; i < len; i++) {
    const a = actual[i];
    const f = forecast[i];
    if (!Number.isFinite(a) || !Number.isFinite(f) || a === 0) continue;
    sum += Math.abs((a - f) / a);
    n += 1;
  }
  return n >= 2 ? (sum / n) * 100 : null;
}

/**
 * Daily usage (fraction of the window) from raw pct observations (BET-1336
 * history rows: `[{ts, pct}]`, any order). `pct` is 0-100; a day's usage is the
 * shared fraction of the window consumed that day, attributed to the local day
 * of each observation:
 *
 *   usage += max(0, pct[t] − pct[t−1]) / 100     (per observation, same window)
 *
 * A positive delta accumulates consumption within one window cycle; a window
 * RESET shows as a pct DROP, whose negative delta contributes 0 (a reset never
 * "frees" usage), and the fresh cycle then accumulates from its lower baseline —
 * so a mid-day reset correctly keeps BOTH the old cycle's consumption and the
 * new cycle's, and the day total never exceeds 1.0. This is the Option-A
 * "pct delta across a local day within one window cycle".
 * @param {Array<{ts:number, pct:number}>} observations
 * @returns {Array<{day:string, usage:number}>} oldest→newest, one per day that
 *          consumed anything.
 */
export function dailyUsageFractions(observations) {
  const obs = (Array.isArray(observations) ? observations : [])
    .filter((o) => o && typeof o.ts === "number" && Number.isFinite(o.ts) && Number.isFinite(o.pct))
    .sort((a, b) => a.ts - b.ts);
  const byDay = new Map();
  let prev = null;
  for (const cur of obs) {
    const day = dayKey(cur.ts);
    const delta = prev == null ? 0 : (cur.pct - prev.pct) / 100;
    if (delta > 0) {
      byDay.set(day, clamp01((byDay.get(day) ?? 0) + delta));
    }
    prev = cur;
  }
  return [...byDay.entries()]
    .map(([day, usage]) => ({ day, usage }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Build the contiguous, oldest→newest trailing daily series a forecast consumes
 * over the last `days` completed local days (today is partial — excluded, since
 * we forecast from *completed* days). Days with no data are 0 (no usage then).
 * Also returns `historyDays` (distinct days with usage > 0) — the §11.3
 * activation gate ("≥ 14 days") — and `maxObserved` (the §11.3 fallback's
 * "observed daily max").
 * @param {Array<{day:string, usage:number}>} daily  from dailyUsageFractions
 * @param {{now:number, days?:number}} [opts]
 */
export function trailingDailySeries(daily, { now, days = FORECAST_LOOKBACK_DAYS } = {}) {
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const count = Math.max(1, Math.floor(days) || 1);
  const map = new Map((Array.isArray(daily) ? daily : []).map((d) => [d.day, d.usage]));
  const series = [];
  const todayKey = dayKey(t);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(d.getDate() - (i + 1));
    const k = dayKey(d.getTime());
    series.push(clamp01(map.get(k) ?? 0));
  }
  let historyDays = 0;
  let maxObserved = 0;
  for (const v of series) {
    if (v > 0) historyDays += 1;
    if (v > maxObserved) maxObserved = v;
  }
  return { series, historyDays, maxObserved };
}

/**
 * Additive Holt-Winters with damped trend and weekly seasonality (m=7), the
 * three §-standard recursions run directly:
 *
 *   Forecast next:   F_{t+1} = L_t + φ·b_t + S_{t−m+1}          (position t mod m)
 *   Level:           L_t = α(y_t − S_{t−m}) + (1−α)(L_{t−1} + φ·b_{t−1})
 *   Trend:           b_t = β(L_t − L_{t−1}) + (1−β)·φ·b_{t−1}
 *   Seasonal:        S_t = γ(y_t − L_t) + (1−γ)·S_{t−m}
 *
 * with φ the trend damper (0.9 default). Initialization uses two full seasons:
 * level = mean of the first season, trend = (2nd-season mean − 1st-season mean)/
 * m, and each seasonal index = the mean of (y − that week's mean) over the
 * weeks available (a detrended additive seasonal). Requires ≥ 2m samples;
 * otherwise returns `{ok:false, reason:"insufficient"}` and the caller uses the
 * §11.3 pre-forecast fallback (not enough history forecloses a seasonal fit).
 *
 * `sigma` is the sample std of the in-sample one-step residuals from the second
 * season onward (the first season absorbs the init transient — its residuals
 * are noise, not signal).
 *
 * @param {{series:number[], m?:number, alpha?:number, beta?:number,
 *          gamma?:number, phi?:number}} opts
 */
export function holtWinters({ series, m = 7, alpha = 0.1, beta = 0.05, gamma = 0.2, phi = 0.9 }) {
  const y = Array.isArray(series) ? series : [];
  const n = y.length;
  if (n < 2 * m) return { ok: false, reason: "insufficient", n };
  if (!y.every((v) => Number.isFinite(v))) return { ok: false, reason: "non-finite", n };
  const period = Math.max(1, Math.floor(m));
  const a = Math.max(0, Math.min(1, alpha));
  const be = Math.max(0, Math.min(1, beta));
  const g = Math.max(0, Math.min(1, gamma));
  const p = Math.max(0, Math.min(1, phi));

  const meanRange = (lo, hi) => {
    let s = 0;
    for (let i = lo; i < hi; i++) s += y[i];
    return s / (hi - lo);
  };
  const weeks = Math.max(1, Math.floor(n / period));
  const weekBase = [];
  for (let w = 0; w < weeks; w++) weekBase.push(meanRange(w * period, Math.min(w * period + period, n)));
  const baseLevel = meanRange(0, period);
  const initTrend = (meanRange(period, Math.min(2 * period, n)) - baseLevel) / period;
  const S = new Array(period).fill(0);
  for (let j = 0; j < period; j++) {
    let s = 0;
    let c = 0;
    for (let w = 0; w < weeks; w++) {
      const idx = w * period + j;
      if (idx < n) {
        s += y[idx] - weekBase[w];
        c += 1;
      }
    }
    S[j] = c ? s / c : 0;
  }

  let Lprev = baseLevel;
  let bprev = initTrend;
  const fitted = new Array(n).fill(NaN);
  const residuals = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    const pos = ((t % period) + period) % period;
    const yhat = Lprev + p * bprev + S[pos];
    fitted[t] = yhat;
    const res = y[t] - yhat;
    residuals[t] = res;
    const Lt = a * (y[t] - S[pos]) + (1 - a) * (Lprev + p * bprev);
    const bt = be * (Lt - Lprev) + (1 - be) * p * bprev;
    S[pos] = g * (y[t] - Lt) + (1 - g) * S[pos];
    Lprev = Lt;
    bprev = bt;
  }
  const sigma = sampleStd(residuals.slice(period));
  const posNext = ((n % period) + period) % period;
  const forecast = Lprev + p * bprev + S[posNext];
  return {
    ok: true,
    n,
    level: Lprev,
    trend: bprev,
    seasonal: S,
    fitted,
    residuals,
    sigma,
    forecast,
  };
}

/**
 * Newsvendor quantile from a point forecast + residual sigma: `point + z_p·σ`.
 * Z defaults to P95 when `p` is not on the ladder.
 */
export function quantileForecast(point, sigma, p = 0.95) {
  const z = QUANTILE_Z[p];
  const s = Number.isFinite(sigma) ? sigma : 0;
  return (Number.isFinite(point) ? point : 0) + (z !== undefined ? z * s : 0);
}

/**
 * The §11.3 reserve for one provider, given a contiguous trailing daily
 * fraction series and the active fractile. Below the HW minimum (2 seasons) it
 * returns the pre-forecast fallback — `{mode:'fallback', value:null}` — and the
 * caller applies `reserve = max(observed daily max, 60% of window)` (§11.3;
 * the fallback is not a fractile and never notches). Otherwise it returns the
 * fractile quantile of next-day demand in fraction-of-window units.
 *
 * @param {{series:number[], fractile?:number, m?:number, params?:object}} opts
 */
export function forecastNextDayFraction({ series, fractile = 0.95, m = 7, params } = {}) {
  const out = holtWinters({ series, m, ...(params ?? {}) });
  if (!out.ok) {
    return { mode: "fallback", reason: out.reason, value: null, fractile, n: out.n };
  }
  const value = clamp01(quantileForecast(out.forecast, out.sigma, fractile));
  return { mode: "forecast", value, fractile, point: out.forecast, sigma: out.sigma, n: out.n };
}

/** MAPE (%) of the HW fit over the trailing `tailDays` of a daily series —
 *  the §14.5 "forecast accuracy (MAPE 14d)" figure. null when insufficient. */
export function forecastMape({ series, m = 7, params, tailDays = 14 } = {}) {
  const out = holtWinters({ series, m, ...(params ?? {}) });
  if (!out.ok) return null;
  const n = out.n;
  const from = Math.max(0, n - Math.max(1, Math.floor(tailDays) || 1));
  const act = [];
  const f = [];
  for (let i = from; i < n; i++) {
    if (!Number.isFinite(out.fitted[i])) continue;
    act.push(series[i]);
    f.push(out.fitted[i]);
  }
  return mape(act, f);
}
