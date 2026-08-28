import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealthStats, HEALTH_STAT_MIN } from "./ctoHealth.mjs";

const DAY = 86_400_000;
// Opens are stamped on the box clock near `now` (the trailing-7d window), so
// tests pin `now` and place opens on the current day.
const currentDay = 1_700_000_000_000;
const NOW = currentDay + 5 * DAY;

function opensAt(...msIntoDays) {
  return msIntoDays.map((m) => ({ kind: "cto.digest_opened", ts: currentDay + m }));
}

test("digest opens: collecting (n/7) until 7 opens accumulate", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ledgerRead: async () => opensAt(currentDay + 5 * DAY - 9 * 3_600_000),
  });
  const d = stats.find((s) => s.id === "digestOpens");
  assert.equal(d.n, 1);
  assert.equal(d.min, HEALTH_STAT_MIN.digestOpens);
  assert.equal(d.value, null);
});

test("digest opens: once ≥7 opens, value renders count + median time of day", async () => {
  const times = [
    NOW - 4 * 3_600_000, NOW - 3 * 3_600_000, NOW - 2 * 3_600_000,
    NOW - 1 * 3_600_000, NOW - 2_000_000, NOW - 1_000_000, NOW - 500_000,
  ];
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ledgerRead: async () => opensAt(...times),
  });
  const d = stats.find((s) => s.id === "digestOpens");
  assert.equal(d.n, 7);
  assert.match(d.value, /7 opens · median \d\d:\d\d/);
});

test("digest opens: older than 7d are excluded", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ledgerRead: async () => [
      { kind: "cto.digest_opened", ts: NOW - 8 * DAY },
      { kind: "cto.digest_opened", ts: NOW - 1 * DAY },
    ],
  });
  const d = stats.find((s) => s.id === "digestOpens");
  assert.equal(d.n, 1);
});

test("ambient spend: budget absent or unpopulated → collecting (0/1)", async () => {
  const { stats } = await computeHealthStats({
    budgetRead: async () => null,
  });
  const s = stats.find((x) => x.id === "ambientSpendToday");
  assert.equal(s.n, 0);
  assert.equal(s.min, 1);
  assert.equal(s.value, null);
});

test("ambient spend: with a reading, value renders spend vs cap", async () => {
  const { stats } = await computeHealthStats({
    ctoAmbientCap: 2.5,
    budgetRead: async () => ({ today: { spend: 0.42 } }),
  });
  const s = stats.find((x) => x.id === "ambientSpendToday");
  assert.equal(s.n, 1);
  assert.equal(s.value, "$0.42 of $2.50 / day");
});

test("pipeline lag: collecting until summarized segments accrue", async () => {
  const { stats } = await computeHealthStats({
    listSegments: async () => [{ window: [1, 2], summarizedAt: 6 }],
  });
  const s = stats.find((x) => x.id === "pipelineLag");
  assert.equal(s.n, 1);
  assert.equal(s.value, null);
});

test("pipeline lag: median of close→summary gaps once ≥7", async () => {
  const close = 1_700_000_000_000;
  const gapsMin = [1, 2, 3, 4, 5, 6, 7]; // 7 samples
  const segments = gapsMin.map((m, i) => ({
    window: [close + i, close + i],
    summarizedAt: close + i + m * 60_000,
  }));
  const { stats } = await computeHealthStats({ listSegments: async () => segments });
  const s = stats.find((x) => x.id === "pipelineLag");
  assert.equal(s.n, 7);
  // sorted lags 1..7 → median index 3 = 4 min
  assert.equal(s.value, "4 min median");
});

test("pipeline lag: lag <= 0 or missing summarizedAt excluded", async () => {
  const close = 1_700_000_000_000;
  const segments = [
    { window: [close, close], summarizedAt: close - 100 }, // negative lag → excluded
    { window: [close, close] }, // no summarizedAt → excluded
    { window: [close, close], summarizedAt: close + 300_000 },
  ];
  const { stats } = await computeHealthStats({ listSegments: async () => segments });
  const s = stats.find((x) => x.id === "pipelineLag");
  assert.equal(s.n, 1);
});

test("listSegments / ledger / budget failures degrade to collecting, never throw", async () => {
  const { stats } = await computeHealthStats({
    ledgerRead: async () => {
      throw new Error("boom");
    },
    budgetRead: async () => {
      throw new Error("boom");
    },
    listSegments: async () => {
      throw new Error("boom");
    },
  });
  for (const s of stats) {
    assert.deepEqual(s.value, null);
  }
});
