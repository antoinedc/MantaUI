// Tests for optimizer/forecast.mjs — quota-window usage history + forecast-at-
// reset (Optimizer P1.4, BET-1336). Pure functions, no I/O. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendObservation, forecastAtReset, median } from "./forecast.mjs";

const H = 3_600_000; // one hour, ms
const D = 86_400_000; // one day, ms

function hist(points) {
  return { k: points.map(([ts, pct]) => ({ ts, pct })) };
}

test("median: odd length returns the middle element", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([7]), 7);
});

test("median: even length returns the mean of the two middle elements", () => {
  assert.equal(median([1, 4, 2, 3]), 2.5);
  assert.equal(median([10, 20]), 15);
});

test("median: empty array returns null", () => {
  assert.equal(median([]), null);
});

test("appendObservation: skips when the newest observation is younger than minIntervalMs", () => {
  const history = {};
  appendObservation(history, { ts: 0, key: "c:s", pct: 10 }, { minIntervalMs: 900_000 });
  assert.equal(history["c:s"].length, 1);
  // 5 minutes later — still inside the 15m min interval → skipped.
  appendObservation(history, { ts: 5 * 60_000, key: "c:s", pct: 12 }, { minIntervalMs: 900_000 });
  assert.equal(history["c:s"].length, 1);
  // At exactly minIntervalMs the observation is no longer "younger" → appended.
  appendObservation(history, { ts: 900_000, key: "c:s", pct: 12 }, { minIntervalMs: 900_000 });
  assert.equal(history["c:s"].length, 2);
});

test("appendObservation: keys are independent", () => {
  const history = {};
  appendObservation(history, { ts: 0, key: "c:s", pct: 10 });
  appendObservation(history, { ts: 1, key: "c:w", pct: 20 });
  assert.equal(history["c:s"].length, 1);
  assert.equal(history["c:w"].length, 1);
});

test("appendObservation: prunes entries older than maxAgeDays", () => {
  const history = {};
  appendObservation(history, { ts: 0, key: "c:s", pct: 10 }, { maxAgeDays: 28 });
  appendObservation(history, { ts: 1 * D, key: "c:s", pct: 11 }, { maxAgeDays: 28 });
  // New obs 29 days after the first: cutoff = 29d - 28d = 1d → the t=0 entry
  // (0 < 1d) is pruned, the day-1 entry survives.
  appendObservation(history, { ts: 29 * D, key: "c:s", pct: 12 }, { maxAgeDays: 28 });
  assert.equal(history["c:s"].length, 2);
  assert.equal(history["c:s"][0].ts, 1 * D);
});

test("forecastAtReset: excludes the reset-boundary pair and clamps correctly", () => {
  // 100→0 is a reset (delta -100 < -10): that pair must NOT feed a rate.
  // The 0→1…7→8 deltas are +1/hr → 8 positive rates, median 1.
  const now = 0;
  const history = hist([100, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((pct, i) => [i * H, pct]));
  const resetsAt = now + 50 * H; // 50h away
  // forecast = clamp(8 + 1*50, 8, 100) = 58
  assert.equal(forecastAtReset(history, "k", { now, resetsAt, currentPct: 8 }), 58);
});

test("forecastAtReset: a reset pair that WOULD count as a rate keeps <8 → null", () => {
  // 7 positive +1/hr deltas plus one reset pair (100→0). Counting the reset
  // would give 8 "rates" → non-null; correctly excluding it leaves 7 → null.
  const now = 0;
  const history = hist([100, 0, 1, 2, 3, 4, 5, 6, 7].map((pct, i) => [i * H, pct]));
  assert.equal(
    forecastAtReset(history, "k", { now, resetsAt: now + 50 * H, currentPct: 7 }),
    null,
  );
});

test("forecastAtReset: fewer than 8 rates returns null", () => {
  const now = 0;
  const history = hist([1, 2, 3, 4, 5, 6].map((pct, i) => [i * H, pct])); // 5 deltas
  assert.equal(forecastAtReset(history, "k", { now, resetsAt: now + H, currentPct: 6 }), null);
});

test("forecastAtReset: clamps at 100", () => {
  const now = 0;
  const history = hist([1, 2, 3, 4, 5, 6, 7, 8, 9].map((pct, i) => [i * H, pct])); // 8 deltas +1/hr
  // median 1, hoursUntil 200h → 5 + 200 = 205 → clamped to 100.
  assert.equal(forecastAtReset(history, "k", { now, resetsAt: now + 200 * H, currentPct: 5 }), 100);
});

test("forecastAtReset: clamps at currentPct when the window already reset", () => {
  const now = 0;
  const history = hist([1, 2, 3, 4, 5, 6, 7, 8, 9].map((pct, i) => [i * H, pct])); // median 1
  // resetsAt in the past → hoursUntil negative → raw < currentPct → clamped up to currentPct.
  assert.equal(forecastAtReset(history, "k", { now, resetsAt: now - 5 * H, currentPct: 60 }), 60);
});

test("forecastAtReset: rounds to integer", () => {
  const now = 0;
  const history = hist([1, 2, 3, 4, 5, 6, 7, 8, 9].map((pct, i) => [i * H, pct])); // median 1
  // hoursUntil = 1.5h → raw = 10 + 1.5 = 11.5 → rounds to 12.
  assert.equal(forecastAtReset(history, "k", { now, resetsAt: now + 1.5 * H, currentPct: 10 }), 12);
});

test("forecastAtReset: null when currentPct/resetsAt is not a finite number", () => {
  const history = hist([1, 2, 3, 4, 5, 6, 7, 8, 9].map((pct, i) => [i * H, pct]));
  assert.equal(forecastAtReset(history, "k", { now: 0, resetsAt: undefined, currentPct: 5 }), null);
  assert.equal(forecastAtReset(history, "k", { now: 0, resetsAt: 100, currentPct: Number.NaN }), null);
});
