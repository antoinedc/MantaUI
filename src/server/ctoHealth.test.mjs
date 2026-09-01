// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

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

// The budget payload's real shape: day buckets keyed by local-midnight ms
// (BET-1405 fixed the read — it used to look for a `today` key that never
// existed, so the row rendered `collecting` forever).
function localDayKey(ts) {
  const d = new Date(ts);
  return String(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
}

test("ambient spend: with a reading, value renders spend vs cap", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ctoAmbientCap: 2.5,
    budgetRead: async () => ({ days: { [localDayKey(NOW)]: { usd: 0.42, calls: 2 } }, updatedMs: NOW }),
  });
  const s = stats.find((x) => x.id === "ambientSpendToday");
  assert.equal(s.n, 1);
  assert.equal(s.value, "$0.42 of $2.50 / day");
});

test("ambient spend: live meter with a quiet today renders $0.00", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ctoAmbientCap: 2.5,
    budgetRead: async () => ({ days: { [localDayKey(NOW - 3 * DAY)]: { usd: 1.1, calls: 4 } }, updatedMs: NOW - 3 * DAY }),
  });
  const s = stats.find((x) => x.id === "ambientSpendToday");
  assert.equal(s.n, 1);
  assert.equal(s.value, "$0.00 of $2.50 / day");
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

// --- Suggestion acceptance (BET-1391, 30d) ------------------------------

function verdict(verdict, never, tsOffsetDays) {
  return { ts: NOW - (tsOffsetDays ?? 0) * DAY, verdict, ...(never ? { never: true } : {}) };
}

test("suggestion acceptance: collecting (n/10) until 10 acceptance-deciding verdicts", async () => {
  const verdicts = Array.from({ length: 5 }, (_, i) => verdict("accept", false, i));
  const { stats } = await computeHealthStats({ now: () => NOW, verdictsRead: async () => verdicts });
  const s = stats.find((x) => x.id === "suggestionAcceptance");
  assert.equal(s.min, HEALTH_STAT_MIN.suggestionAcceptance);
  assert.equal(s.n, 5);
  assert.equal(s.value, null);
});

test("suggestion acceptance: open/expire never enter the acceptance counters", async () => {
  const verdicts = [
    verdict("accept", false, 0),
    verdict("open", false, 0),
    verdict("expire", false, 0),
    verdict("accept", false, 0),
  ];
  const { stats } = await computeHealthStats({ now: () => NOW, verdictsRead: async () => verdicts });
  const s = stats.find((x) => x.id === "suggestionAcceptance");
  assert.equal(s.n, 2); // only the two accept verdicts decide acceptance
  assert.equal(s.value, null); // still collecting
});

test("suggestion acceptance: ≥10 verdicts renders accepted % (accept/edit success; other verdicts rejection)", async () => {
  const verdicts = [
    ...Array.from({ length: 7 }, () => verdict("accept", false, 0)),
    ...Array.from({ length: 3 }, () => verdict("dismiss", false, 0)),
  ];
  const { stats } = await computeHealthStats({ now: () => NOW, verdictsRead: async () => verdicts });
  const s = stats.find((x) => x.id === "suggestionAcceptance");
  assert.equal(s.n, 10);
  assert.equal(s.value, "70% accepted");
});

test("suggestion acceptance: a `never` flag counts as a rejection", async () => {
  const verdicts = [
    ...Array.from({ length: 6 }, () => verdict("accept", false, 0)),
    ...Array.from({ length: 4 }, () => verdict("accept", true, 0)), // never-flagged accept → rejection
  ];
  const { stats } = await computeHealthStats({ now: () => NOW, verdictsRead: async () => verdicts });
  const s = stats.find((x) => x.id === "suggestionAcceptance");
  assert.equal(s.n, 10);
  assert.equal(s.value, "60% accepted");
});

test("suggestion acceptance: verdicts older than 30d are excluded", async () => {
  const old = verdict("accept", false, 40);
  const fresh = Array.from({ length: 10 }, () => verdict("accept", false, 1));
  const { stats } = await computeHealthStats({ now: () => NOW, verdictsRead: async () => [old, ...fresh] });
  const s = stats.find((x) => x.id === "suggestionAcceptance");
  assert.equal(s.n, 10);
});

test("BET-1400: forecast accuracy row reflects the cached quota MAPE", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    budgetRead: async () => ({ quota: { claude: { provider: "claude", mape14: 12.4, fractile: 0.95 } } }),
  });
  const f = stats.find((s) => s.id === "forecastAccuracy");
  assert.equal(f.value, "12.4%");
  assert.equal(f.n, 1);
  // no quota row with a numeric MAPE -> collecting
  const { stats: empty } = await computeHealthStats({ now: () => NOW, budgetRead: async () => ({ quota: {} }) });
  assert.equal(empty.find((s) => s.id === "forecastAccuracy").n, 0);
});

test("BET-1400: cap-hits-caused counts §14.5 rows in the last 30 days only", async () => {
  const capAt = (offsetDays) => ({ kind: "cto.cap_hit", ts: NOW - offsetDays * DAY });
  const { stats } = await computeHealthStats({
    now: () => NOW,
    ledgerRead: async () => [capAt(1), capAt(5), capAt(45)],
  });
  const c = stats.find((s) => s.id === "capHitsCaused");
  assert.equal(c.value, "2 window(s) hit"); // 45 days ago excluded
});

test("BET-1400: reserve fractile row surfaces the primary quota fractile", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    budgetRead: async () => ({ quota: { claude: { provider: "claude", fractile: 0.99 } } }),
  });
  const r = stats.find((s) => s.id === "reserveFractile");
  assert.equal(r.value, "P99 · claude");
});

test("BET-1417: windowless-first box labels the mode — never a bare fractile for a reserve-disabled provider", async () => {
  // BET-1400's windowless quota row persists the P95-init fractile with
  // reserve disabled (§11.2); the row must surface the mode, not imply a
  // reserve exists at that fractile.
  const { stats } = await computeHealthStats({
    now: () => NOW,
    budgetRead: async () => ({
      quota: { claude: { provider: "claude", mode: "windowless", reserve: 0, fractile: 0.95 } },
    }),
  });
  const r = stats.find((s) => s.id === "reserveFractile");
  assert.equal(r.value, "P95 (windowless — reserve off) · claude");
});

test("BET-1417: a windowless row never shadows a reserve-enabled provider's fractile", async () => {
  // Mixed box: the windowless provider is iterated first, but the live
  // reserve fractile belongs to the windowed one.
  const { stats } = await computeHealthStats({
    now: () => NOW,
    budgetRead: async () => ({
      quota: {
        gpt: { provider: "gpt", mode: "windowless", reserve: 0, fractile: 0.95 },
        claude: { provider: "claude", mode: "forecast", fractile: 0.99 },
      },
    }),
  });
  const r = stats.find((s) => s.id === "reserveFractile");
  assert.equal(r.value, "P99 · claude");
});

test("BET-1417: windowed row behavior unchanged (mode not surfaced in the value)", async () => {
  for (const mode of ["forecast", "fallback", null, undefined]) {
    const { stats } = await computeHealthStats({
      now: () => NOW,
      budgetRead: async () => ({
        quota: { claude: { provider: "claude", mode, fractile: 0.9 } },
      }),
    });
    const r = stats.find((s) => s.id === "reserveFractile");
    assert.equal(r.value, "P90 · claude");
  }
});

// --- BET-1405: the ROI self-report row (§12.4) -----------------------------

test("ROI row: collecting — first report <date> until the first monthly roll", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    roiRead: async () => ({ month: null, roll: null, collectingUntil: NOW + 9 * DAY }),
  });
  const r = stats.find((s) => s.id === "roi");
  assert.equal(r.n, 0);
  assert.equal(r.min, 1);
  assert.equal(r.value, null);
  assert.match(r.collectingText, /^collecting — first report \w+ \d+$/);
});

test("ROI row: no activity yet → plain collecting (no fabricated date)", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    roiRead: async () => ({ month: null, roll: null, collectingUntil: null }),
  });
  const r = stats.find((s) => s.id === "roi");
  assert.equal(r.value, null);
  assert.equal(r.collectingText, "collecting");
});

test("ROI row: renders the month roll with spend, outcomes and recommendation", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    roiRead: async () => ({
      month: "2026-07",
      roll: {
        month: "2026-07",
        spendUsd: 4.12,
        accepted: 2,
        merged: 1,
        incidents: 0,
        recommendation: { tier: "stay", reason: "3 outcomes for $4.12 — holding" },
      },
      collectingUntil: null,
    }),
  });
  const r = stats.find((s) => s.id === "roi");
  assert.equal(r.n, 1);
  assert.equal(r.label, "ROI · Jul 2026");
  assert.equal(
    r.value,
    "$4.12 · 2 accepted · 1 merged · 0 pre-surfaced — recommend stay: 3 outcomes for $4.12 — holding",
  );
});

test("ROI row: roiRead failure degrades to collecting, never throws", async () => {
  const { stats } = await computeHealthStats({
    now: () => NOW,
    roiRead: async () => {
      throw new Error("store down");
    },
  });
  const r = stats.find((s) => s.id === "roi");
  assert.equal(r.value, null);
  assert.equal(r.collectingText, "collecting");
});
