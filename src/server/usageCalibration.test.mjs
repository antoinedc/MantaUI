import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createUsageCalibration,
  estimateK,
  sampleFromSnapshot,
  median,
  quantile,
  MAX_INTERVAL_MS,
  SAMPLES_SAVE_DEBOUNCE_MS,
  ESTIMATE_EVERY_MS,
} from "./usageCalibration.mjs";

const T0 = 1_800_000_000_000;
const STEP = 10 * 60_000;
const H5 = 5 * 3_600_000;
const DAY = 86_400_000;
const WEEKLY_RESET = T0 + 40 * DAY;

// One observation.
const ob = (t, s, l, { sReset = null, lReset = WEEKLY_RESET, sStale = false, lStale = false, extra = [] } = {}) => ({
  t,
  short: { pct: s, ...(sReset ? { resetsAt: sReset } : {}), ...(sStale ? { stale: true } : {}) },
  long: [{ kind: "weekly", pct: l, resetsAt: lReset, ...(lStale ? { stale: true } : {}) }, ...extra],
});

// A seat whose 5h window rises `rate` points per 10-min step and whose weekly
// is exactly `cumulative / K` — reported through `quant` (floor = a provider
// that only shows whole percents). The 5h window restarts every 30 steps.
function series({ K = 7.5, steps = 432, rate = 1.5, quant = Math.floor, start = T0, offset = 0, phase = 0 } = {}) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const j = i + offset;
    const window = Math.floor(j / 30);
    const within = (j % 30) + 1;
    out.push(ob(start + i * STEP, Math.round(rate * within), quant((rate * (j + 1)) / K + phase), { sReset: start + (window + 1) * H5 }));
  }
  return out;
}

const seatsOf = (n, make) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`claude:seat-${i + 1}`, make(i)]));
const near = (actual, expected, tol = 0.03) => assert.ok(Math.abs(actual - expected) / expected <= tol, `${actual} not within ${tol * 100}% of ${expected}`);

test("recovers a known K within 3% from smoothly rising readings (5 seats, different rates and phases)", () => {
  const samples = { version: 1, seats: seatsOf(5, (i) => series({ K: 7.4, rate: 1 + i * 0.4, offset: i * 7, quant: (x) => Math.round(x * 10) / 10 })) };
  const est = estimateK(samples, { nowMs: T0 + 432 * STEP }).claude;
  assert.equal(est.seats, 5);
  near(est.value, 7.4);
  assert.ok(est.spread < 0.05);
  assert.ok(est.samples > 1000);
});

test("quantised low-rate usage (the weekly whole-percent counter moves every third interval) is recovered", () => {
  // short ≈ +2.5 per step, K 7.5 → weekly ≈ +0.33 per step: a whole point every third step (rates differ per seat so no run aliases with the whole-percent grid).
  const samples = { seats: seatsOf(5, (i) => series({ K: 7.5, rate: 2.3 + i * 0.1, steps: 600, offset: i * 4, quant: Math.floor })) };
  const est = estimateK(samples, { nowMs: T0 + 600 * STEP }).claude;
  near(est.value, 7.5);
  // Zero-Δweekly intervals stayed in their runs: counting only the intervals where the weekly moved would read ~3× too low.
  assert.ok(est.value > 7.2);
});

test("the median across seats is the provider value", () => {
  const Ks = [7.0, 7.4, 7.5, 7.8, 8.0];
  const samples = { seats: seatsOf(5, (i) => series({ K: Ks[i], quant: (x) => Math.round(x * 10) / 10 })) };
  const est = estimateK(samples, { nowMs: T0 + 432 * STEP }).claude;
  near(est.value, 7.5, 0.04);
  assert.equal(Object.keys(est.perSeat).length, 5);
});

test("intervals that cannot be validated are rejected: reset crossing, stale, negative delta, gaps > 20 min", () => {
  const reset = (t0) => [
    ob(t0, 95, 40, { sReset: t0 + 1000 }),
    ob(t0 + STEP, 3, 41, { sReset: t0 + H5 }), // a 5h reset crossed (resetsAt moved, pct fell)
  ];
  const good = series({ K: 7.5, steps: 300, quant: (x) => Math.round(x * 10) / 10 });
  const only = (obs) => estimateK({ seats: { "claude:x": obs } }, { nowMs: T0 + 400 * STEP }).claude.perSeat.x;
  assert.equal(only(reset(T0)).intervals, 0);
  // The same pairs fed with an unchanged resetsAt and a falling pct → negative delta.
  assert.equal(only([ob(T0, 50, 10, { sReset: T0 + H5 }), ob(T0 + STEP, 3, 12, { sReset: T0 + H5 })]).intervals, 0);
  assert.equal(only([ob(T0, 10, 10, { sReset: T0 + H5 }), ob(T0 + STEP, 15, 9, { sReset: T0 + H5 })]).intervals, 0, "a weekly that fell is a provider correction");
  // Stale at either end.
  assert.equal(only([ob(T0, 10, 10, { sReset: T0 + H5 }), ob(T0 + STEP, 15, 11, { sReset: T0 + H5, sStale: true })]).intervals, 0);
  assert.equal(only([ob(T0, 10, 10, { sReset: T0 + H5, lStale: true }), ob(T0 + STEP, 15, 11, { sReset: T0 + H5 })]).intervals, 0);
  // Weekly reset crossed.
  assert.equal(only([ob(T0, 10, 90, { sReset: T0 + H5 }), ob(T0 + STEP, 15, 91, { sReset: T0 + H5, lReset: WEEKLY_RESET + 7 * DAY })]).intervals, 0);
  // Longer than 20 minutes.
  assert.equal(only([ob(T0, 10, 10, { sReset: T0 + H5 }), ob(T0 + MAX_INTERVAL_MS + 1, 15, 11, { sReset: T0 + H5 })]).intervals, 0);
  assert.equal(only([ob(T0, 10, 10, { sReset: T0 + H5 }), ob(T0 + MAX_INTERVAL_MS, 15, 11, { sReset: T0 + H5 })]).intervals, 1, "exactly 20 min qualifies");

  // Interleaving garbage into a clean series changes nothing: it only breaks runs.
  const dirty = [];
  good.forEach((o, i) => {
    dirty.push(o);
    if (i % 31 === 15) dirty.push({ ...ob(o.t + 1000, 99, 99, { sStale: true, lStale: true, sReset: o.short.resetsAt }) }); // a garbage stale reading
    if (i % 47 === 20) dirty.push(ob(o.t + 2000, 1, 0, { sReset: 5 })); // a negative-delta glitch
  });
  const est = estimateK({ seats: seatsOf(4, () => dirty) }, { nowMs: T0 + 400 * STEP }).claude;
  near(est.value, 7.5, 0.05);
});

test("a run whose weekly never moved contributes nothing (its 5h points are not counted)", () => {
  const flat = Array.from({ length: 20 }, (_, i) => ob(T0 + i * STEP, i, 10, { sReset: T0 + H5 }));
  const est = estimateK({ seats: { "claude:x": flat } }, { nowMs: T0 + DAY }).claude.perSeat.x;
  assert.equal(est.sumShort, 0);
  assert.equal(est.sumLong, 0);
  assert.equal(est.runs, 0);
});

test("guards: ≥ 20 weekly points per seat, ≥ 3 seats, dispersion ≤ 0.2 — else null", () => {
  const nowMs = T0 + 432 * STEP;
  const mk = (Ks, steps = 432) => ({ seats: Object.fromEntries(Ks.map((K, i) => [`claude:s${i}`, series({ K, steps, quant: (x) => Math.round(x * 10) / 10 })])) });
  assert.equal(estimateK(mk([7.5, 7.5]), { nowMs }).claude.value, null, "two seats");
  assert.equal(estimateK(mk([7.5, 7.5]), { nowMs }).claude.seats, 2);
  const wide = estimateK(mk([5, 7.5, 10]), { nowMs }).claude;
  assert.equal(wide.value, null, "p10-p90 spread / median above 0.2");
  assert.ok(wide.spread > 0.2);
  near(estimateK(mk([7.2, 7.5, 7.8]), { nowMs }).claude.value, 7.5);
  // Too little weekly movement on a seat: it does not count toward the three.
  const thin = { seats: { ...mk([7.5, 7.5]).seats, "claude:thin": series({ K: 7.5, steps: 30, quant: (x) => Math.round(x * 10) / 10 }) } };
  const t = estimateK(thin, { nowMs }).claude;
  assert.equal(t.perSeat.thin.k, null);
  assert.equal(t.seats, 2);
  assert.equal(t.value, null);
});

test("only the last 14 days count", () => {
  const old = series({ K: 3, steps: 432, start: T0 });
  const fresh = series({ K: 7.5, steps: 432, start: T0 + 20 * DAY, quant: (x) => Math.round(x * 10) / 10 });
  const samples = { seats: seatsOf(4, () => [...old, ...fresh]) };
  near(estimateK(samples, { nowMs: T0 + 20 * DAY + 432 * STEP }).claude.value, 7.5);
});

test("model caps are never fitted: weekly_scoped windows are ignored, a seat with only a scoped window has no K", () => {
  const scoped = (pct) => [{ kind: "weekly_scoped:fable", pct, resetsAt: WEEKLY_RESET }];
  const base = series({ K: 7.5, quant: (x) => Math.round(x * 10) / 10 });
  // The cap moves at a wildly different ratio; it must not influence the weekly fit.
  const withCap = base.map((o, i) => ({ ...o, long: [...o.long, ...scoped(Math.round(i * 0.9))] }));
  near(estimateK({ seats: seatsOf(4, () => withCap) }, { nowMs: T0 + 432 * STEP }).claude.value, 7.5);
  const onlyScoped = base.map((o, i) => ({ ...o, long: scoped(Math.round(i * 0.9)) }));
  const est = estimateK({ seats: { "claude:cap": onlyScoped } }, { nowMs: T0 + 432 * STEP }).claude;
  assert.equal(est.perSeat.cap.k, null);
  assert.equal(est.perSeat.cap.intervals, 0);
});

test("the module never reads the legacy usage history", () => {
  const src = readFileSync(new URL("./usageCalibration.mjs", import.meta.url), "utf8");
  const imports = src.split("\n").filter((l) => /^import\b/.test(l));
  assert.ok(imports.length > 0);
  for (const line of imports) assert.doesNotMatch(line, /forecast|usage\.mjs|usage-history|usageHistory/);
  assert.doesNotMatch(src, /getUsageHistory|appendObservation/);
});

test("sampleFromSnapshot pairs the session window with weekly by kind, and skips what cannot pair", () => {
  const snap = (windows) => ({ provider: "claude", seatId: "seat-1", fetchedAt: T0, windows });
  const s = sampleFromSnapshot(
    snap([
      { kind: "session", pct: 10, resetsAt: T0 + H5, stale: true },
      { kind: "weekly", pct: 30, resetsAt: WEEKLY_RESET },
      { kind: "weekly_scoped:fable", pct: 5, resetsAt: WEEKLY_RESET },
    ]),
  );
  assert.deepEqual(s, { t: T0, short: { pct: 10, resetsAt: T0 + H5, stale: true }, long: [{ kind: "weekly", pct: 30, resetsAt: WEEKLY_RESET }] });
  assert.equal(sampleFromSnapshot(snap([{ kind: "session", pct: 10 }])), null, "no weekly");
  assert.equal(sampleFromSnapshot(snap([{ kind: "weekly", pct: 10 }])), null, "no 5h window");
  assert.equal(sampleFromSnapshot(snap([{ kind: "session", pct: 1 }, { kind: "weekly", pct: 1, active: false }])), null, "an inactive weekly is not a pair");
  assert.deepEqual(sampleFromSnapshot(snap([{ kind: "session", pct: 0 }, { kind: "weekly", pct: 2 }])).short, { pct: 0 }, "a not-started 5h window has no resetsAt");
});

test("median / quantile helpers", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.1), 1.4);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.9), 4.6);
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function fakeTimers() {
  const queue = [];
  return {
    timers: {
      setTimeout: (fn, ms) => {
        queue.push({ fn, ms });
        return { unref() {} };
      },
      clearTimeout() {},
    },
    queue,
  };
}

function harness(extra = {}) {
  let nowMs = T0;
  const saved = [];
  const savedSamples = [];
  const ft = fakeTimers();
  const cal = createUsageCalibration({
    load: () => saved.at(-1) ?? extra.stored ?? null, // the file, as the last save left it
    loadSamples: () => extra.samples ?? null,
    save: async (s) => void saved.push(structuredClone(s)),
    saveSamples: async (s) => void savedSamples.push(structuredClone(s)),
    now: () => nowMs,
    timers: ft.timers,
    log: { warn() {} },
  });
  return { cal, saved, savedSamples, queue: ft.queue, setNow: (t) => (nowMs = t), now: () => nowMs };
}

// A seat snapshot as the poller publishes it.
const snapFrom = (seatId, o, provider = "claude") => ({
  provider,
  seatId,
  fetchedAt: o.t,
  windows: [
    { kind: "session", label: "5h", pct: o.short.pct, ...(o.short.resetsAt ? { resetsAt: o.short.resetsAt } : {}) },
    { kind: "weekly", label: "7d", pct: o.long[0].pct, resetsAt: o.long[0].resetsAt },
  ],
});

// A harness fed 200 polls (10 min apart) from `seatCount` seats whose weekly follows K = 7.5.
function pollSeats(seatCount) {
  const h = harness();
  const all = Array.from({ length: seatCount }, (_, i) => series({ K: 7.5, steps: 200, offset: (i + 1) * 5, quant: (x) => Math.round(x * 10) / 10 }));
  for (let i = 0; i < 200; i++) {
    h.setNow(T0 + i * STEP);
    h.cal.onPolled(all.map((s, n) => snapFrom(`seat-${n + 1}`, s[i])));
  }
  return h;
}

test("onPolled accumulates paired observations, estimates hourly, and writes the store only when the result changed", () => {
  const h = pollSeats(4);
  const last = h.saved.at(-1);
  near(last.providers.claude.kByKind.weekly.value, 7.5);
  assert.equal(last.providers.claude.kByKind.weekly.seats, 4);
  assert.deepEqual(last.providers.claude.defaults, { weekly: 7.5 });
  // Hourly estimate: 200 steps ≈ 33 h → far fewer runs than ticks; and an extra explicit estimate with no new data writes nothing.
  assert.ok(h.saved.length > 0 && h.saved.length <= 34, `saves ${h.saved.length}`);
  h.cal.estimate();
  const before = h.saved.length;
  h.cal.estimate();
  h.cal.estimate();
  assert.equal(h.saved.length, before, "unchanged result → no write");
  const reader = h.cal.readerFor("claude");
  near(reader("weekly"), 7.5);
  near(reader("weekly_scoped:Fable"), 3.75);
});

test("a duplicate reading (same fetchedAt) is not appended twice, and the first call estimates immediately", () => {
  const h = harness();
  const o = series({ steps: 2 })[0];
  h.cal.onPolled([snapFrom("seat-1", o)]);
  h.cal.onPolled([snapFrom("seat-1", o)]);
  h.cal.onPolled([snapFrom("seat-1", { ...o, t: o.t - 5 })]);
  h.queue[0].fn();
  assert.equal(h.savedSamples.length, 1);
  assert.equal(h.savedSamples[0].seats["claude:seat-1"].length, 1);
});

test("the samples save is debounced to ONE 30 s timer, unref'd, and prunes to 14 days", () => {
  const h = harness();
  const o = series({ steps: 3 });
  h.cal.onPolled([snapFrom("seat-1", o[0])]);
  h.cal.onPolled([snapFrom("seat-1", o[1])]);
  assert.equal(h.queue.length, 1);
  assert.equal(h.queue[0].ms, SAMPLES_SAVE_DEBOUNCE_MS);
  assert.equal(h.savedSamples.length, 0);
  h.queue[0].fn();
  assert.equal(h.savedSamples.length, 1);
  assert.equal(h.savedSamples[0].seats["claude:seat-1"].length, 2);
  // 15 days later the first two readings are gone.
  const late = ob(T0 + 15 * DAY, 5, 5, { sReset: T0 + 15 * DAY + H5 });
  h.setNow(late.t);
  h.cal.onPolled([snapFrom("seat-1", late)]);
  assert.equal(h.queue.length, 2, "a new timer after the first fired");
  h.queue[1].fn();
  assert.equal(h.savedSamples[1].seats["claude:seat-1"].length, 1);
});

test("the estimate runs on the first call, then at most once an hour", () => {
  const q = (x) => Math.round(x * 10) / 10;
  const samples = { version: 1, seats: seatsOf(3, (i) => series({ K: 7.5, steps: 150, offset: i * 5, quant: q })) };
  const h = harness({ samples });
  const E = T0 + 150 * STEP;
  // Later readings that would move the result (K = 3 data), one per 10 minutes.
  const later = [1, 2, 3].map((n) => series({ K: 3, steps: 20, start: E + STEP, offset: n * 5, quant: q }));
  const feed = (i, at) => {
    h.setNow(at);
    h.cal.onPolled(later.map((s, n) => snapFrom(`seat-${n + 1}`, { ...s[i], t: at })));
  };
  feed(0, E + STEP);
  assert.equal(h.saved.length, 1, "first call estimates");
  for (let i = 1; i <= 5; i++) feed(i, E + (i + 1) * STEP);
  assert.equal(h.saved.length, 1, "within the hour: not re-estimated, though the data moved");
  for (let i = 6; i <= 8; i++) feed(i, E + 62 * 60_000 + i * STEP);
  assert.equal(h.saved.length, 2, "an hour later: estimated again, result changed → written");
});

test("readerFor: claude default 7.5, model caps 0.5·K, other providers null unless they report a weekly", () => {
  const h = harness();
  const claude = h.cal.readerFor("claude");
  assert.equal(claude("weekly"), 7.5);
  assert.equal(claude("weekly_scoped:fable"), 3.75);
  assert.equal(claude("session"), null);
  const codex = h.cal.readerFor("codex");
  assert.equal(codex("weekly"), null);
  assert.equal(codex("weekly_scoped:x"), null);
  h.cal.onPolled([snapFrom("seat-1", series({ steps: 2 })[0], "codex")]);
  assert.equal(codex("weekly"), 7.5);
});

test("readerFor prefers a measured value; a measured model cap is used as measured", () => {
  const stored = {
    version: 1,
    providers: { claude: { kByKind: { weekly: { value: 7.2, samples: 100, seats: 5, updatedAt: T0 }, "weekly_scoped:fable": { value: 3 } }, defaults: { weekly: 7.5 } } },
  };
  const r = harness({ stored }).cal.readerFor("claude");
  assert.equal(r("weekly"), 7.2);
  assert.equal(r("weekly_scoped:fable"), 3);
  assert.equal(r("weekly_scoped:other"), 3.6);
});

test("the calibration store is read lazily and memoised for 60 s", () => {
  let loads = 0;
  let nowMs = T0;
  const cal = createUsageCalibration({ load: () => (loads++, null), loadSamples: () => null, save: async () => {}, saveSamples: async () => {}, now: () => nowMs, log: { warn() {} } });
  assert.equal(loads, 0);
  const r = cal.readerFor("claude");
  r("weekly");
  r("weekly");
  assert.equal(loads, 1);
  nowMs += 61_000;
  r("weekly");
  assert.equal(loads, 2);
});

test("snapshot(): per provider the measured values, defaults, spread and sample count (+ optional extra stats)", () => {
  const h = pollSeats(3);
  const snap = h.cal.snapshot();
  assert.equal(snap.providers.claude.kByKind.weekly.seats, 3);
  assert.deepEqual(snap.providers.claude.defaults, { weekly: 7.5 });
  assert.ok(snap.providers.claude.spread >= 0);
  assert.ok(snap.providers.claude.samples > 0);
  assert.equal("queueStats" in snap, false);

  const withStats = createUsageCalibration({ load: () => null, loadSamples: () => null, save: async () => {}, saveSamples: async () => {}, queueStats: () => ({ dropped: 2 }) });
  assert.deepEqual(withStats.snapshot().queueStats, { dropped: 2 });
});

test("a measurement that stops passing its guards drops back to the default", () => {
  const stored = { version: 1, providers: { claude: { kByKind: { weekly: { value: 6.1, samples: 9, seats: 5, updatedAt: T0 } }, defaults: { weekly: 7.5 }, spread: 0.1 } } };
  // Only two seats' worth of data remains.
  const samples = { version: 1, seats: Object.fromEntries([1, 2].map((n) => [`claude:seat-${n}`, series({ K: 7.5, steps: 200, quant: (x) => Math.round(x * 10) / 10 })])) };
  const h = harness({ stored, samples });
  h.setNow(T0 + 200 * STEP);
  h.cal.estimate();
  assert.equal(h.saved.at(-1).providers.claude.kByKind.weekly, undefined);
  assert.equal(h.cal.readerFor("claude")("weekly"), 7.5);
});

test("malformed stored observations are dropped on load: onPolled still appends, estimate runs, nothing is logged", () => {
  const good = series({ steps: 3 });
  const warned = [];
  const samples = {
    version: 1,
    seats: {
      "claude:seat-1": [good[0], { t: T0 + 1, short: null, long: [] }, { t: T0 + 2, short: { pct: 1 }, long: {} }, { t: T0 + 3, short: { pct: 1 }, long: [null, 3] }, null, 7, "x", { t: T0 + 4 }],
      "claude:seat-2": [{ t: T0, short: [], long: [] }],
    },
  };
  const h = {};
  let nowMs = T0 + STEP;
  const cal = createUsageCalibration({
    load: () => null,
    loadSamples: () => samples,
    save: async () => {},
    saveSamples: async (s) => void (h.saved = structuredClone(s)),
    now: () => nowMs,
    timers: { setTimeout: (fn) => (h.fire = fn), clearTimeout() {} },
    log: { warn: (...a) => warned.push(a) },
  });
  cal.onPolled([snapFrom("seat-1", good[1])]);
  assert.doesNotThrow(() => cal.estimate());
  h.fire();
  assert.deepEqual(h.saved.seats["claude:seat-1"].map((o) => o.t), [good[0].t, good[1].t], "only the well-formed observations are kept");
  assert.deepEqual(warned, []);
});

test("estimate() prunes every seat's list: a removed seat's key disappears after 14 days", () => {
  const old = series({ steps: 3 });
  const h = harness({ samples: { version: 1, seats: { "claude:gone": old, "claude:seat-1": old } } });
  h.setNow(T0 + 15 * DAY);
  h.cal.onPolled([snapFrom("seat-1", ob(T0 + 15 * DAY, 5, 5, { sReset: T0 + 15 * DAY + H5 }))]);
  h.queue.at(-1).fn();
  const keys = Object.keys(h.savedSamples.at(-1).seats);
  assert.deepEqual(keys, ["claude:seat-1"]);
  assert.equal(h.savedSamples.at(-1).seats["claude:seat-1"].length, 1);
});

test("a burst of ticks 1 s apart adds one observation per seat", () => {
  const h = harness();
  const o = series({ steps: 1 })[0];
  for (let i = 0; i < 5; i++) h.cal.onPolled([snapFrom("seat-1", { ...o, t: o.t + i * 1000 })]);
  h.cal.onPolled([snapFrom("seat-1", { ...o, t: o.t + 61_000 })]);
  h.queue[0].fn();
  assert.equal(h.savedSamples[0].seats["claude:seat-1"].length, 2, "the first, then the one a minute later");
});

test("normalizeStore keeps only finite positive defaults", async () => {
  const { normalizeStore } = await import("./usageCalibration.mjs");
  const out = normalizeStore({ providers: { claude: { defaults: { weekly: 7.5, bad: "x", zero: 0, neg: -1, nan: NaN, nul: null }, kByKind: {} }, codex: { defaults: [1, 2] } } });
  assert.deepEqual(out.providers.claude.defaults, { weekly: 7.5 });
  assert.deepEqual(out.providers.codex.defaults, {});
});
