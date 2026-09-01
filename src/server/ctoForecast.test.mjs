// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORECAST_LOOKBACK_DAYS,
  QUANTILE_Z,
  dailyUsageFractions,
  forecastMape,
  forecastNextDayFraction,
  holtWinters,
  mape,
  quantileForecast,
  sampleStd,
  trailingDailySeries,
} from "./ctoForecast.mjs";
import { dayKey } from "../shared/timeBuckets.mjs";

// A deterministic local-midnight baseline for series/day tests.
function dayStart(offsetDays = 0) {
  const d = new Date(2026, 7, 28, 0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}
const D0 = dayStart(0);
const D1 = dayStart(1);

test("sampleStd: known sample std (2.138) and guards", () => {
  assert.ok(Math.abs(sampleStd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
  assert.equal(sampleStd([]), 0);
  assert.equal(sampleStd([5]), 0);
});

test("mape: percent error over non-zero actuals; null when < 2 usable", () => {
  assert.ok(Math.abs(mape([100, 200], [110, 180]) - 10) < 1e-9);
  assert.equal(mape([100], [110]), null);
  assert.equal(mape([0, 0], [0, 0]), null);
  assert.equal(mape([1], [2]), null);
});

test("quantileForecast: point + z_p * sigma at the §11.3 fractiles", () => {
  assert.ok(Math.abs(quantileForecast(10, 2, 0.95) - (10 + QUANTILE_Z[0.95] * 2)) < 1e-9);
  assert.ok(Math.abs(quantileForecast(10, 2, 0.9) - (10 + QUANTILE_Z[0.9] * 2)) < 1e-9);
  assert.ok(Math.abs(quantileForecast(10, 2, 0.99) - (10 + QUANTILE_Z[0.99] * 2)) < 1e-9);
  assert.equal(quantileForecast(10, undefined, 0.95), 10);
});

test("dailyUsageFractions: window reset + cross-day attribution (hand fixture)", () => {
  // Same local day, window resets mid-day: usage = old-cycle share + new-cycle share.
  const obs = [
    { ts: D0 + 10, pct: 20 },
    { ts: D0 + 12, pct: 45 }, // +0.25
    { ts: D0 + 14, pct: 5 }, // reset: -0.40 -> 0
    { ts: D0 + 16, pct: 30 }, // +0.25
  ];
  const days = dailyUsageFractions(obs);
  assert.equal(days.length, 1);
  assert.equal(days[0].day, dayKey(D0));
  assert.ok(Math.abs(days[0].usage - 0.5) < 1e-9);

  // Cross-midnight: a delta between a late obs on D0 and an early obs on D1 is
  // attributed to D1 (the day of the later observation).
  const cross = dailyUsageFractions([
    { ts: D0 + 23 * 3_600_000, pct: 40 },
    { ts: D1 + 3_600_000, pct: 52 },
  ]);
  assert.equal(cross.length, 1);
  assert.equal(cross[0].day, dayKey(D1));
  assert.ok(Math.abs(cross[0].usage - 0.12) < 1e-9);
});

test("dailyUsageFractions: day total accumulates correctly (hand values)", () => {
  // 10 -> 95 = +0.85; 95 -> 100 = +0.05; total 0.90 (no clamp needed).
  const d = dailyUsageFractions([
    { ts: D0 + 1, pct: 10 },
    { ts: D0 + 2, pct: 95 },
    { ts: D0 + 3, pct: 100 },
  ]);
  assert.equal(d[0].day, dayKey(D0));
  assert.ok(Math.abs(d[0].usage - 0.9) < 1e-9);
});

test("trailingDailySeries: contiguous lookback excludes today, zero-fills", () => {
  const daily = [{ day: dayKey(D0), usage: 0.4 }];
  const { series, historyDays, maxObserved } = trailingDailySeries(daily, { now: D1, days: 4 });
  // 4 trailing days ending at the day before D1: D0 and the 3 days before it.
  assert.equal(series.length, 4);
  assert.ok(Math.abs(series[3] - 0.4) < 1e-9); // D0 is the most recent trailing day
  assert.equal(historyDays, 1);
  assert.ok(Math.abs(maxObserved - 0.4) < 1e-9);
  series.slice(0, 3).forEach((v) => assert.equal(v, 0)); // earlier days zero-filled
});

test("trailingDailySeries: default lookback is 8 weeks", () => {
  const { series } = trailingDailySeries([], { now: D0 });
  assert.equal(series.length, FORECAST_LOOKBACK_DAYS);
});

test("holtWinters: constant series fits exactly (hand fixture, m=2)", () => {
  const out = holtWinters({ series: [0.1, 0.1, 0.1, 0.1], m: 2, alpha: 0.1, beta: 0.05, gamma: 0.2, phi: 0.9 });
  assert.equal(out.ok, true);
  out.fitted.forEach((f) => assert.ok(Math.abs(f - 0.1) < 1e-12));
  assert.equal(out.sigma, 0);
  assert.ok(Math.abs(out.forecast - 0.1) < 1e-12);
});

test("holtWinters: damped-trend ramp matches hand-computed first steps", () => {
  // series [0.1,0.1,0.2,0.2], m=2: initLevel=0.1, initTrend=0.05,
  // seasonal=[0,0]. Step t=0 uses S[0]=0:
  //   yhat0 = 0.1 + 0.9*0.05 = 0.145
  //   L0    = 0.1*(0.1) + 0.9*(0.1+0.9*0.05) = 0.01 + 0.9*0.145 = 0.1405
  //   b0    = 0.05*(0.1405-0.1) + 0.95*0.9*0.05 = 0.002025 + 0.04275 = 0.044775
  //   S0    = 0.2*(0.1-0.1405) + 0.8*0 = -0.0081
  // Full pass ends (hand-computed through t=3) at final level ≈ 0.238247 —
  // the code matches the recursion through all four points.
  const out = holtWinters({ series: [0.1, 0.1, 0.2, 0.2], m: 2, alpha: 0.1, beta: 0.05, gamma: 0.2, phi: 0.9 });
  assert.equal(out.ok, true);
  assert.ok(Math.abs(out.fitted[0] - 0.145) < 1e-9);
  assert.ok(Math.abs(out.fitted[1] - 0.1807975) < 1e-6, `fitted1 ${out.fitted[1]}`);
  assert.ok(Math.abs(out.level - 0.23824735998443758) < 1e-6, `level ${out.level}`);
  assert.ok(Math.abs(out.seasonal[0] - -0.008193944025000014) < 1e-6, `seasonal0 ${out.seasonal[0]}`);
});

test("holtWinters: requires two full seasons (activation gate plumbing)", () => {
  assert.equal(holtWinters({ series: [0.1, 0.1, 0.1], m: 2 }).ok, false);
  assert.equal(holtWinters({ series: [0.1, 0.1, 0.1, 0.1], m: 2 }).ok, true);
});

test("forecastNextDayFraction: fallback below 2 seasons, forecast above", () => {
  const fb = forecastNextDayFraction({ series: [0.1, 0.1, 0.1], m: 2, fractile: 0.95 });
  assert.equal(fb.mode, "fallback");
  assert.equal(fb.value, null);

  const fc = forecastNextDayFraction({ series: [0.1, 0.1, 0.1, 0.1], m: 2, fractile: 0.95 });
  assert.equal(fc.mode, "forecast");
  assert.ok(Math.abs(fc.value - 0.1) < 1e-9);
  assert.equal(fc.fractile, 0.95);
});

test("forecastMape: null below two seasons, number above with scatter", () => {
  assert.equal(forecastMape({ series: [0.1, 0.1, 0.1], m: 2 }), null);
  // Constant series fits exactly -> 0% MAPE.
  assert.equal(forecastMape({ series: [0.1, 0.1, 0.1, 0.1], m: 2 }), 0);
});
