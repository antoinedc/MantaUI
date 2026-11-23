import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBackgroundBudget,
  validateAndMergeBackgroundWork,
  readBackgroundWork,
  weeklyDueAt,
  projectWeeklyPct,
  normalizeTokens,
  priceTokens,
  resolveRates,
  levelCap,
  isWeeklyKind,
  isWeeklyWindow,
  localDay,
  nextLocalMidnight,
  BATCH_SHARE,
  MAX_DAILY_CAP_USD,
  WORK_CLASS,
  WORK_BANDS,
  FALLBACK_RATES,
} from "./backgroundBudget.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 10, 17, 12, 0, 0).getTime();
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const ADAPTERS = { anthropic: "claude", openai: "codex", deepseek: "deepseek" };

const week = (o = {}) => ({ kind: "weekly", label: "7d", pct: 10, resetsAt: T0 + 3 * DAY, ...o });
const five = (o = {}) => ({ kind: "session", label: "5h", pct: 10, resetsAt: T0 + 2 * HOUR, ...o });
const claude = (windows, o = {}) => ({ provider: "claude", providerIDs: ["anthropic"], kind: "subscription", planLabel: "Max 20x", windows, fetchedAt: T0, ...o });

function memStore(initial = null) {
  const s = {
    data: initial,
    saves: 0,
    async load() {
      return s.data ? structuredClone(s.data) : null;
    },
    async save(d) {
      s.data = structuredClone(d);
      s.saves += 1;
    },
  };
  return s;
}

function winState(over = {}) {
  return {
    resetsAt: T0 + 3 * DAY,
    windowStart: null,
    bgPct: 0,
    batchPct: 0,
    bgTokensSinceTick: 0,
    batchTokensSinceTick: 0,
    bgNotInLedgerSinceTick: 0,
    lastTick: { at: T0, pct: 10 },
    tokensPerPct: null,
    hit100At: null,
    seenAt: T0,
    ...over,
  };
}
const seeded = (windows) => memStore({ v: 1, windows, days: {}, fallbackTokens: {} });

function rig(o = {}) {
  const clock = { t: T0 };
  const world = {
    snaps: o.snaps ?? [claude([week(), five()])],
    totals: o.totals ?? { byProvider: { anthropic: 0 } },
    sinceCalls: [],
    cfg: { backgroundWork: o.bw },
    prices: o.prices ?? { models: {} },
    desktop: o.desktop ?? "present",
    lastPrompt: o.lastPrompt ?? 0,
    pacing: o.pacing ?? null,
    connected: o.connected ?? [],
    defaultModel: "defaultModel" in o ? o.defaultModel : OPUS,
  };
  const store = o.store ?? memStore();
  const logs = [];
  const b = createBackgroundBudget({
    store,
    log: { append: (r) => logs.push(r) },
    configGet: async () => {
      if (world.cfgError) throw new Error("cfg");
      return world.cfg;
    },
    listSnapshots: () => world.snaps,
    providerTokenTotals: async ({ sinceMs }) => {
      world.sinceCalls.push(sinceMs);
      return typeof world.totals === "function" ? world.totals(sinceMs) : world.totals;
    },
    getPrices: async () => world.prices,
    bandOf: (p, m) => (m === "cheap" ? "fast" : "deep"),
    adapterForProviderID: (p) => ADAPTERS[p] ?? null,
    resolveDefaultModel: async () => world.defaultModel,
    desktopState: () => world.desktop,
    lastUserPromptAt: () => world.lastPrompt,
    pacingWindows: world.pacing ? async () => world.pacing : null,
    listConnectedProviders: async () => world.connected,
    now: () => clock.t,
  });
  return { b, store, clock, world, logs };
}

// ---- pure helpers ----

test("isWeeklyKind / levelCap: weekly-kind windows (incl. scoped) use the weekly cap, every other kind the short cap", () => {
  assert.equal(isWeeklyKind("weekly"), true);
  assert.equal(isWeeklyKind("weekly_scoped:Fable"), true);
  assert.equal(isWeeklyKind("session"), false);
  assert.equal(levelCap("normal", "weekly"), 5);
  assert.equal(levelCap("normal", "session"), 10);
  assert.equal(levelCap("light", "weekly"), 2);
  assert.equal(levelCap("light", "session"), 5);
  assert.equal(levelCap("off", "weekly"), 0);
});

test("validateAndMergeBackgroundWork: merges partials, rounds cents, rejects invalid and unknown", () => {
  assert.deepEqual(validateAndMergeBackgroundWork(undefined, {}), { ok: true, value: { level: "normal", dailyCapUsd: 5, runWhenBusy: false } });
  assert.deepEqual(validateAndMergeBackgroundWork({ level: "light", dailyCapUsd: 7 }, { level: "off" }).value, { level: "off", dailyCapUsd: 7, runWhenBusy: false });
  assert.deepEqual(validateAndMergeBackgroundWork({ level: "light", dailyCapUsd: 7 }, { dailyCapUsd: 1.234 }).value, { level: "light", dailyCapUsd: 1.23, runWhenBusy: false });
  assert.equal(validateAndMergeBackgroundWork(null, { dailyCapUsd: 0 }).value.dailyCapUsd, 0);
  assert.equal(validateAndMergeBackgroundWork(null, { dailyCapUsd: MAX_DAILY_CAP_USD }).ok, true);
  for (const bad of [{ level: "max" }, { level: 3 }, { dailyCapUsd: -1 }, { dailyCapUsd: 100.01 }, { dailyCapUsd: "5" }, { dailyCapUsd: NaN }, { dailyCapUsd: Infinity }, { runWhenBusy: "yes" }, { runWhenBusy: 1 }, { color: "red" }]) {
    const r = validateAndMergeBackgroundWork(null, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /\w/);
  }
  assert.equal(validateAndMergeBackgroundWork({ level: "light", runWhenBusy: true }, { level: "off" }).value.runWhenBusy, true, "a partial write keeps the stored override");
  assert.equal(validateAndMergeBackgroundWork({ runWhenBusy: true }, { runWhenBusy: false }).value.runWhenBusy, false);
  assert.equal(validateAndMergeBackgroundWork(null, "x").ok, false);
  assert.equal(validateAndMergeBackgroundWork(null, [1]).ok, false);
});

test("readBackgroundWork: invalid stored values read as defaults, valid parts survive", () => {
  assert.deepEqual(readBackgroundWork(undefined), { level: "normal", dailyCapUsd: 5, runWhenBusy: false });
  assert.deepEqual(readBackgroundWork({ level: "bogus", dailyCapUsd: "x", runWhenBusy: "yes" }), { level: "normal", dailyCapUsd: 5, runWhenBusy: false });
  assert.deepEqual(readBackgroundWork({ level: "light", dailyCapUsd: 12.5, runWhenBusy: true }), { level: "light", dailyCapUsd: 12.5, runWhenBusy: true });
  assert.deepEqual(readBackgroundWork({ level: "off", dailyCapUsd: 500 }), { level: "off", dailyCapUsd: 5, runWhenBusy: false });
});

test("weeklyDueAt: on a plan it waits for 24 h before the weekly reset; pay-per-token keeps its own schedule", () => {
  const resetsAt = T0 + 3 * DAY;
  assert.equal(weeklyDueAt({ mode: "payg", intervalDueAt: T0 - DAY, resetsAt }), T0 - DAY);
  assert.equal(weeklyDueAt({ mode: "plan", intervalDueAt: T0 - DAY, resetsAt }), resetsAt - DAY, "interval elapsed long ago: waits for the near-reset moment");
  assert.equal(weeklyDueAt({ mode: "plan", intervalDueAt: resetsAt - HOUR, resetsAt }), resetsAt - HOUR, "interval elapses inside the last 24 h: its own time");
  assert.equal(weeklyDueAt({ mode: "plan", intervalDueAt: resetsAt + HOUR, resetsAt }), resetsAt + HOUR, "interval elapses in a later window: its own time");
  assert.equal(weeklyDueAt({ mode: "plan", intervalDueAt: T0, resetsAt: null }), T0);
});

test("projectWeeklyPct: weekly only, needs 20 % of the window elapsed, default start = resetsAt − 7 days", () => {
  const base = { kind: "weekly", pct: 50, resetsAt: T0 + 3 * DAY, now: T0 };
  assert.equal(projectWeeklyPct(base), 87.5);
  assert.equal(projectWeeklyPct({ ...base, kind: "session" }), null);
  assert.equal(projectWeeklyPct({ ...base, resetsAt: T0 + 6.5 * DAY }), null, "7 % elapsed");
  assert.equal(projectWeeklyPct({ ...base, startedAt: T0 - 2 * DAY, resetsAt: T0 + 5 * DAY }), 175, "the window's own start beats the default");
  assert.equal(projectWeeklyPct({ ...base, windowStart: T0 - DAY / 2 }), null, "a stored start 14 % into the window");
  assert.equal(projectWeeklyPct({ ...base, windowStart: T0 - 2 * DAY, resetsAt: T0 + 5 * DAY }), 175, "the stored start after a reset");
  assert.equal(projectWeeklyPct({ ...base, resetsAt: null }), null);
  assert.equal(projectWeeklyPct({ ...base, kind: "weekly_scoped:Fable" }), 87.5);
});

test("pricing: own price, else dearest of the band, else dearest overall, else the fallback rates; nested cache shape and bare totals", () => {
  const prices = { models: { "p/a": { input: 1, output: 2 }, "p/b": { input: 10, output: 20 }, "p/c": { input: 5, output: 5 } } };
  const bandOf = (p, m) => (m === "c" ? "fast" : "deep");
  assert.deepEqual(resolveRates({ providerID: "p", modelID: "a", band: "deep", prices, bandOf }), { rates: prices.models["p/a"], priced: true });
  assert.deepEqual(resolveRates({ providerID: "p", modelID: "zz", band: "deep", prices, bandOf }), { rates: prices.models["p/b"], priced: false });
  assert.deepEqual(resolveRates({ providerID: "p", modelID: "zz", band: "fast", prices, bandOf }), { rates: prices.models["p/c"], priced: false });
  assert.deepEqual(resolveRates({ providerID: "p", modelID: "zz", band: "balanced", prices, bandOf }), { rates: prices.models["p/b"], priced: false }, "no model in the band: dearest overall");
  assert.deepEqual(resolveRates({ providerID: "p", modelID: "zz", band: "fast", prices: { models: {} }, bandOf }), { rates: FALLBACK_RATES, priced: false });
  assert.deepEqual(normalizeTokens({ input: 1, cache: { read: 2, write: 3 } }), { input: 1, cacheRead: 2, cacheWrite: 3 });
  assert.deepEqual(normalizeTokens(1000), { input: 900, output: 100 });
  assert.equal(normalizeTokens("x"), undefined);
  assert.equal(priceTokens({ input: 1e6, output: 1e6, reasoning: 1e6 }, { input: 10, output: 20 }), 50);
  assert.equal(priceTokens({ cacheRead: 1e6 }, { input: 10, output: 20 }), 1, "cache read defaults to 10 % of input");
});

// ---- billing mode ----

test("billing: no adapter → pay-per-token (not a fallback); credit snapshot → pay-per-token; subscription → plan; codex with a balance is still a plan", async () => {
  const noAdapter = rig({ snaps: [] });
  const d1 = await noAdapter.b.check({ workType: "cto-ambient", model: { providerID: "openrouter", modelID: "x" } });
  assert.deepEqual([d1.ok, d1.mode, d1.fallback], [true, "payg", false]);

  const credit = rig({ snaps: [{ provider: "deepseek", providerIDs: ["deepseek"], kind: "credit", balance: 3, windows: [], fetchedAt: T0 }] });
  const d2 = await credit.b.check({ workType: "cto-ambient", model: { providerID: "deepseek", modelID: "chat" } });
  assert.deepEqual([d2.ok, d2.mode, d2.fallback], [true, "payg", false]);

  const plan = rig();
  const d3 = await plan.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d3.ok, d3.mode, d3.fallback], [true, "plan", false]);

  const codex = rig({ snaps: [{ provider: "codex", providerIDs: ["openai"], kind: "subscription", balance: 12, windows: [five()], fetchedAt: T0 }] });
  const d4 = await codex.b.check({ workType: "cto-ambient", model: { providerID: "openai", modelID: "gpt-6-sol" } });
  assert.deepEqual([d4.ok, d4.mode], [true, "plan"]);

  const absentKind = rig({ snaps: [claude([week()], { kind: undefined })] });
  assert.equal((await absentKind.b.check({ workType: "cto-ambient", model: OPUS })).mode, "plan", "absent kind with a window is a plan");
});

test("billing: an adapter with no snapshot (never fetched / failing) falls back to the dollar cap and says so", async () => {
  const r = rig({ snaps: [] });
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.ok, d.mode, d.fallback], [true, "payg", true]);
  await r.b.record({ workType: "cto-ambient", model: OPUS, usd: 5 });
  const blocked = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([blocked.ok, blocked.reason, blocked.mode, blocked.fallback], [false, "usd-cap", "payg", true]);
});

test("billing: a null model is the box default; with no default at all the dollar cap governs", async () => {
  const r = rig();
  assert.equal((await r.b.check({ workType: "cto-ambient", model: null })).mode, "plan", "default is the Claude plan model");
  const none = rig({ defaultModel: null });
  const d = await none.b.check({ workType: "cto-ambient", model: null });
  assert.deepEqual([d.ok, d.mode, d.fallback], [true, "payg", true]);
});

test("billing: a plan with no window that applies to the model is a fallback; a model-scoped window only governs its own model", async () => {
  const scopedOnly = rig({ snaps: [claude([week({ kind: "weekly_scoped:Fable", scope: "Fable" })])] });
  const d = await scopedOnly.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.mode, d.fallback], ["payg", true]);
  const fable = await scopedOnly.b.check({ workType: "cto-ambient", model: { providerID: "anthropic", modelID: "claude-fable-5-1" } });
  assert.equal(fable.mode, "plan");
  const inactive = rig({ snaps: [claude([week({ active: false }), five()])] });
  assert.equal((await inactive.b.check({ workType: "cto-ambient", model: OPUS })).window.key, "claude:session", "inactive windows never govern");
});

// ---- decision rules: plan ----

test("level off refuses everything on a plan", async () => {
  const r = rig({ bw: { level: "off" } });
  const d = await r.b.check({ workType: "knowledge-capture", model: OPUS });
  assert.deepEqual([d.ok, d.reason, d.mode, d.resumesAt], [false, "off", "plan", null]);
});

test("exhausted: a window at 100 %, or a snapshot that says exhausted, refuses with resumesAt = the reset", async () => {
  const full = rig({ snaps: [claude([week({ pct: 100 })])] });
  const d = await full.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.reason, d.resumesAt], ["exhausted", T0 + 3 * DAY]);
  const flagged = rig({ snaps: [claude([week({ pct: 60 }), five({ pct: 20 })], { exhausted: true })] });
  const d2 = await flagged.b.check({ workType: "cto-ambient", model: OPUS });
  assert.equal(d2.reason, "exhausted");
  assert.equal(d2.window.key, "claude:weekly", "reported on the highest-pct window");
});

test("level-cap: background share + in-flight reaches the level cap (weekly 5 % on Normal, 2 % on Light)", async () => {
  const store = seeded({ "claude:weekly": winState({ bgPct: 5 }) });
  const r = rig({ store });
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.ok, d.reason, d.resumesAt, d.window.cap, d.window.bgPct], [false, "level-cap", T0 + 3 * DAY, 5, 5]);

  const under = rig({ store: seeded({ "claude:weekly": winState({ bgPct: 4.9 }) }) });
  assert.equal((await under.b.check({ workType: "cto-ambient", model: OPUS })).ok, true);

  const light = rig({ bw: { level: "light" }, store: seeded({ "claude:weekly": winState({ bgPct: 2 }) }) });
  assert.equal((await light.b.check({ workType: "cto-ambient", model: OPUS })).reason, "level-cap");

  const short = rig({ store: seeded({ "claude:session": winState({ bgPct: 10, resetsAt: T0 + 2 * HOUR }) }) });
  const ds = await short.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([ds.reason, ds.window.key, ds.window.cap], ["level-cap", "claude:session", 10]);
});

test("in-flight: tokens recorded since the last tick count against the cap through tokensPerPct (own measurement, else the pacing fallback)", async () => {
  const mk = (extra) => seeded({ "claude:weekly": winState({ bgPct: 4.9, bgTokensSinceTick: 200, ...extra }) });
  const measured = rig({ store: mk({ tokensPerPct: 1000 }) });
  assert.equal((await measured.b.check({ workType: "cto-ambient", model: OPUS })).reason, "level-cap");
  const unknown = rig({ store: mk({}) });
  assert.equal((await unknown.b.check({ workType: "cto-ambient", model: OPUS })).ok, true, "unknown rate: the next tick catches up");
  const pacing = rig({ store: mk({}), pacing: { "claude:weekly": { tokensPerPct: 1000 } } });
  assert.equal((await pacing.b.check({ workType: "cto-ambient", model: OPUS })).reason, "level-cap", "falls back to the optimizer pacing's measurement");
});

test("window-busy: a short window above 70 % pauses background work until it resets", async () => {
  const r = rig({ snaps: [claude([week(), five({ pct: 74 })])] });
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.reason, d.window.key, d.window.pct, d.resumesAt], ["window-busy", "claude:session", 74, T0 + 2 * HOUR]);
  assert.equal((await rig({ snaps: [claude([week(), five({ pct: 70 })])] }).b.check({ workType: "cto-ambient", model: OPUS })).ok, true, "70 is not above 70");
});

test("weekly projection: above 80 % refuses (resumesAt = flat-usage crossing); at or below passes; a weekly pct > 70 pauses when the projection is unknown", async () => {
  // 4 of 7 days elapsed, 50 % used → 87.5 % projected.
  const high = rig({ snaps: [claude([week({ pct: 50 })])] });
  const d = await high.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.reason, d.window.projectedPct], ["projected-high", 87.5]);
  assert.equal(d.resumesAt, T0 - 4 * DAY + (50 / 80) * 7 * DAY, "min(resetsAt, windowStart + pct/80 × span)");
  assert.equal((await rig({ snaps: [claude([week({ pct: 40 })])] }).b.check({ workType: "cto-ambient", model: OPUS })).ok, true, "70 % projected");

  // 7 % of the window elapsed: unknown projection → rule 4 (pct > 70).
  const early = (pct) => rig({ snaps: [claude([week({ pct, resetsAt: T0 + 6.5 * DAY })])] });
  assert.equal((await early(75).b.check({ workType: "cto-ambient", model: OPUS })).reason, "window-busy");
  assert.equal((await early(60).b.check({ workType: "cto-ambient", model: OPUS })).ok, true);
});

test("a known window start (startedAt, or the stored start after a reset) beats the 7-day default", async () => {
  // Opened 1 day ago, resets in 6: 1/7 elapsed → still unknown; opened 3 days ago, resets in 4 days: 3/7 elapsed.
  const startedAt = T0 - 3 * DAY;
  const r = rig({ snaps: [claude([week({ pct: 40, startedAt, resetsAt: T0 + 4 * DAY })])] });
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.equal(d.window.projectedPct, 93.33, "40 × 7/3");
  assert.equal(d.reason, "projected-high");
});

test("near the end of a week (≤ 24 h) the projection rule becomes pct + (cap − bgPct) ≤ 95", async () => {
  const near = (pct, bgPct = 0) => rig({ snaps: [claude([week({ pct, resetsAt: T0 + 12 * HOUR })])], store: seeded({ "claude:weekly": winState({ bgPct, resetsAt: T0 + 12 * HOUR }) }) });
  const d = await near(92).b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.ok, d.reason, d.resumesAt], [false, "projected-high", T0 + 12 * HOUR]);
  assert.equal((await near(88).b.check({ workType: "cto-ambient", model: OPUS })).ok, true);
  assert.equal((await near(88, 3).b.check({ workType: "cto-ambient", model: OPUS })).ok, true);
  assert.equal((await near(93, 1).b.check({ workType: "cto-ambient", model: OPUS })).reason, "projected-high");
});

test("a stale window is treated as fresh: rules 4-5 skipped, its share reads 0", async () => {
  const r = rig({
    snaps: [claude([week({ pct: 90, stale: true }), five({ pct: 99, stale: true })])],
    store: seeded({ "claude:weekly": winState({ bgPct: 9 }), "claude:session": winState({ bgPct: 9 }) }),
  });
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.ok, d.window.bgPct], [true, 0]);
});

test("batch ceiling: batch work stops at 60 % of the cap while continuous work may use the rest; within 24 h of a weekly reset the ceiling lifts", async () => {
  assert.equal(BATCH_SHARE, 0.6);
  const mk = (resetsAt = T0 + 3 * DAY) => rig({ snaps: [claude([week({ resetsAt })])], store: seeded({ "claude:weekly": winState({ bgPct: 3.2, batchPct: 3, resetsAt }) }) });
  const r = mk();
  const batch = await r.b.check({ workType: "knowledge-tidy", model: OPUS });
  assert.deepEqual([batch.ok, batch.reason], [false, "level-cap"]);
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OPUS })).ok, true, "continuous work is unaffected");
  r.b.flushEvidence();
  assert.equal(r.logs.find((l) => l.type === "refused").ceiling, true);

  // total ≥ cap also refuses batch
  const total = rig({ store: seeded({ "claude:weekly": winState({ bgPct: 5, batchPct: 0 }) }) });
  assert.equal((await total.b.check({ workType: "cto-overnight", model: OPUS })).reason, "level-cap");

  const lifted = mk(T0 + 12 * HOUR);
  assert.equal((await lifted.b.check({ workType: "knowledge-tidy", model: OPUS })).ok, true, "within 24 h of the reset the ceiling lifts to the full cap");
});

test("flushEvidence writes the current hour's coalesced refusal rows and resolves once they are written (the shutdown hook awaits it)", async () => {
  const r = rig({ bw: { level: "off" } });
  await r.b.check({ workType: "cto-overnight", model: OPUS });
  await r.b.check({ workType: "cto-overnight", model: OPUS });
  assert.equal(r.logs.filter((l) => l.type === "refused").length, 0, "the current hour is still coalescing in memory");
  const done = r.b.flushEvidence();
  assert.equal(typeof done.then, "function");
  await done;
  const rows = r.logs.filter((l) => l.type === "refused");
  assert.deepEqual(rows.map((x) => [x.workType, x.count]), [["cto-overnight", 2]]);
  await r.b.flushEvidence();
  assert.equal(r.logs.filter((l) => l.type === "refused").length, 1, "nothing is written twice");
});

test("every refusal carries the work class; unknown work types are refused as unavailable", async () => {
  const r = rig({ bw: { level: "off" } });
  await r.b.check({ workType: "cto-overnight", model: OPUS });
  await r.b.check({ workType: "nonsense", model: OPUS });
  r.b.flushEvidence();
  const rows = r.logs.filter((l) => l.type === "refused");
  assert.deepEqual(rows.map((x) => [x.workType, x.reason, x.class]).sort(), [["cto-overnight", "off", "batch"], ["nonsense", "unavailable", "continuous"]]);
  assert.equal(WORK_CLASS["curator-notes"], "continuous");
  assert.equal(WORK_CLASS["knowledge-actions"], "continuous");
  assert.equal(WORK_BANDS["knowledge-actions"], "fast");
  assert.equal(WORK_CLASS["knowledge-trial"], "batch");
});

// ---- decision rules: pay-per-token ----

const OR = { providerID: "openrouter", modelID: "x" };

test("pay-per-token: refuses at the daily cap, resumes at local midnight; a cap of 0 means no background work", async () => {
  const r = rig({ snaps: [], bw: { dailyCapUsd: 5 } });
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OR })).ok, true);
  await r.b.record({ workType: "cto-ambient", model: OR, usd: 4.99 });
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OR })).ok, true);
  await r.b.record({ workType: "cto-ambient", model: OR, usd: 0.01 });
  const d = await r.b.check({ workType: "cto-ambient", model: OR });
  assert.deepEqual([d.ok, d.reason, d.mode, d.resumesAt], [false, "usd-cap", "payg", nextLocalMidnight(T0)]);
  r.clock.t = nextLocalMidnight(T0) + 1;
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OR })).ok, true, "a new local day");

  const zero = rig({ snaps: [], bw: { dailyCapUsd: 0 } });
  assert.equal((await zero.b.check({ workType: "knowledge-capture", model: OR })).reason, "usd-cap");
});

test("pay-per-token batch ceiling: batch work stops at 60 % of the cap, continuous work continues", async () => {
  const r = rig({ snaps: [], bw: { dailyCapUsd: 5 } });
  await r.b.record({ workType: "cto-overnight", model: OR, usd: 3 });
  assert.equal((await r.b.check({ workType: "cto-overnight", model: OR })).reason, "usd-cap");
  assert.equal((await r.b.check({ workType: "knowledge-trial", model: OR })).reason, "usd-cap");
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OR })).ok, true);
  await r.b.record({ workType: "cto-ambient", model: OR, usd: 2 });
  assert.equal((await r.b.check({ workType: "cto-ambient", model: OR })).reason, "usd-cap", "total reached");
});

test("plan-mode list-price spend never counts against the dollar cap", async () => {
  const r = rig({ bw: { dailyCapUsd: 1 } });
  await r.b.record({ workType: "cto-ambient", model: OPUS, usd: 50, inLedger: false });
  assert.equal(r.b.usdToday({ mode: "payg" }), 0);
  assert.equal(r.b.usdToday({ mode: "plan" }), 50);
  assert.equal(r.b.usdToday(), 50);
  assert.equal(r.b.usdToday({ workType: "cto-ambient", mode: "plan" }), 50);
  assert.equal(r.b.usdToday({ workType: "cto-ambient", mode: "payg" }), 0);
});

// ---- recording ----

test("record prices real usage at list price; a recorded usd is used as-is; an unpriced model is charged at the band's dearest", async () => {
  const prices = { models: { "openrouter/x": { input: 10, output: 20 }, "openrouter/big": { input: 30, output: 60 }, "openrouter/cheap": { input: 1, output: 2 } } };
  const r = rig({ snaps: [], prices });
  const a = await r.b.record({ workType: "knowledge-capture", model: OR, usage: { input: 1e6, output: 5e5 } });
  assert.deepEqual([a.usd, a.priced, a.mode], [20, true, "payg"]);
  const asIs = await r.b.record({ workType: "knowledge-trial", model: OR, usd: 0.5 });
  assert.equal(asIs.usd, 0.5);
  const unpriced = await r.b.record({ workType: "knowledge-capture", model: { providerID: "openrouter", modelID: "unknown" }, usage: { input: 1e6 } });
  assert.deepEqual([unpriced.usd, unpriced.priced], [30, false], "bandOf → deep → dearest priced");
  const bare = await r.b.record({ workType: "cto-ambient", model: OR, usage: 1_000_000 });
  assert.equal(bare.usd, 9 + 2, "a bare size estimate is split 90/10");
  const none = rig({ snaps: [] });
  const fb = await none.b.record({ workType: "cto-ambient", model: OR, usage: { input: 1e6 } });
  assert.deepEqual([fb.usd, fb.priced], [15, false], "no priced model at all");
  assert.equal(r.b.usdToday({ workType: "knowledge-capture" }), 50);
});

test("record never throws: a failing store or ledger loses the booking, not the call", async () => {
  const store = memStore();
  store.save = async () => {
    throw new Error("disk full");
  };
  const r = rig({ store, snaps: [] });
  const out = await r.b.record({ workType: "cto-ambient", model: OR, usd: 1 });
  assert.equal(out.usd, 1);
  const r2 = rig({ snaps: [] });
  r2.world.prices = null;
  assert.equal((await r2.b.record({ workType: "cto-ambient", model: OR, usage: { input: 1 } })).mode, "payg");
  assert.deepEqual(await r2.b.record(), { usd: 0, priced: true, mode: "payg" });
});

test("record keeps per-work-type daily totals and prunes days past 60", async () => {
  const r = rig({ snaps: [] });
  await r.b.record({ workType: "curator-notes", model: OR, usage: { input: 10, output: 5 }, usd: 0.25 });
  await r.b.record({ workType: "curator-notes", model: OR, usd: 0.5 });
  const st = await r.b.status();
  const row = st.byWork.find((x) => x.workType === "curator-notes");
  assert.deepEqual([row.calls, row.usd, row.tokens], [2, 0.75, 15]);
  r.clock.t = T0 + 61 * DAY;
  await r.b.record({ workType: "curator-notes", model: OR, usd: 0.1 });
  assert.deepEqual(Object.keys(r.store.data.days), [localDay(T0 + 61 * DAY)]);
});

// ---- tick ----

async function started(o = {}) {
  const r = rig({ snaps: [claude([week({ pct: 10 })])], ...o });
  await r.b.tick(); // first sighting
  return r;
}
const win = (r, key = "claude:weekly") => r.store.data.windows[key];

test("tick: first sighting records the window and attributes nothing", async () => {
  const r = await started();
  const w = win(r);
  assert.deepEqual([w.bgPct, w.lastTick.pct, w.lastTick.at, w.resetsAt], [0, 10, T0, T0 + 3 * DAY]);
  assert.equal(r.world.sinceCalls.length, 0);
});

test("tick: usage movement is attributed by token share (in-ledger tokens) and tokensPerPct is measured", async () => {
  const r = await started();
  r.clock.t = T0 + 10 * 60_000;
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 700, output: 300 }, inLedger: true });
  assert.equal(win(r).bgTokensSinceTick, 1000);
  r.world.snaps = [claude([week({ pct: 12 })])];
  r.world.totals = { byProvider: { anthropic: 4000, other: 99999 } };
  await r.b.tick();
  const w = win(r);
  assert.equal(w.bgPct, 0.5, "dPct 2 × 1000/4000");
  assert.equal(w.tokensPerPct, 2000);
  assert.deepEqual([w.bgTokensSinceTick, w.lastTick.pct, w.lastTick.at], [0, 12, T0 + 10 * 60_000]);
  assert.deepEqual(r.world.sinceCalls, [T0], "the ledger is read since the previous tick, for this snapshot's providers only");
});

test("tick: tokens not in the ledger (deleted ephemeral sessions) join the denominator exactly once", async () => {
  const r = await started();
  await r.b.record({ workType: "knowledge-capture", model: OPUS, usage: { input: 1000 }, inLedger: false });
  assert.equal(win(r).bgNotInLedgerSinceTick, 1000);
  r.world.snaps = [claude([week({ pct: 12 })])];
  r.world.totals = { byProvider: { anthropic: 3000 } }; // everything else the ledger saw
  r.clock.t += 600_000;
  await r.b.tick();
  assert.equal(win(r).bgPct, 0.5, "dPct 2 × 1000 / (3000 + 1000)");
  assert.equal(win(r).bgNotInLedgerSinceTick, 0);
});

test("tick: movement with no tokens on the box (another device) is not attributed", async () => {
  const r = await started();
  r.world.snaps = [claude([week({ pct: 13 })])];
  r.world.totals = { byProvider: { anthropic: 0 } };
  r.clock.t += 600_000;
  await r.b.tick();
  assert.deepEqual([win(r).bgPct, win(r).lastTick.pct, win(r).tokensPerPct], [0, 13, null]);
});

test("tick: a flat pct carries the counters and the old tick; tokensPerPct needs dPct ≥ 1", async () => {
  const r = await started();
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 500 } });
  r.clock.t += 600_000;
  await r.b.tick();
  assert.deepEqual([win(r).bgTokensSinceTick, win(r).lastTick.at], [500, T0]);
  r.world.snaps = [claude([week({ pct: 10.5 })])];
  r.world.totals = { byProvider: { anthropic: 500 } };
  r.clock.t += 600_000;
  await r.b.tick();
  assert.equal(win(r).bgPct, 0.5, "all of the half-point");
  assert.equal(win(r).tokensPerPct, null, "dPct < 1: keeps the previous (none)");
});

test("tick: a pct drop (a seat switch) rebases without a reset and keeps what was attributed", async () => {
  const r = await started({ store: seeded({ "claude:weekly": winState({ bgPct: 1, bgTokensSinceTick: 50 }) }) });
  r.world.snaps = [claude([week({ pct: 6 })])];
  r.clock.t += 600_000;
  await r.b.tick();
  assert.deepEqual([win(r).bgPct, win(r).lastTick.pct, win(r).bgTokensSinceTick], [1, 6, 0]);
  assert.equal(r.logs.some((l) => l.type === "window-close"), false);
});

test("tick: an unreadable ledger skips the window and the counters carry forward", async () => {
  const r = await started();
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 400 } });
  r.world.snaps = [claude([week({ pct: 12 })])];
  r.world.totals = null;
  r.clock.t += 600_000;
  await r.b.tick();
  assert.deepEqual([win(r).bgTokensSinceTick, win(r).lastTick.pct, win(r).bgPct], [400, 10, 0]);
  r.world.totals = () => {
    throw new Error("ledger down");
  };
  await r.b.tick();
  assert.equal(win(r).bgTokensSinceTick, 400);
});

test("tick: a passed resetsAt is a reset — share zeroed, windowStart = the old reset, window-close written", async () => {
  const r = rig({ snaps: [claude([week({ pct: 90, resetsAt: T0 + HOUR })])], store: seeded({ "claude:weekly": winState({ resetsAt: T0 + HOUR, bgPct: 3, batchPct: 2, bgTokensSinceTick: 7, lastTick: { at: T0, pct: 88 } }) }) });
  r.clock.t = T0 + 2 * HOUR;
  r.world.snaps = [claude([week({ pct: 2, resetsAt: T0 + 2 * HOUR + 7 * DAY })])];
  await r.b.tick();
  const w = win(r);
  assert.deepEqual([w.bgPct, w.batchPct, w.bgTokensSinceTick, w.windowStart, w.resetsAt, w.lastTick.pct], [0, 0, 0, T0 + HOUR, T0 + 2 * HOUR + 7 * DAY, 2]);
  const close = r.logs.find((l) => l.type === "window-close");
  assert.deepEqual([close.key, close.finalPct, close.bgPct, close.batchPct, close.cap], ["claude:weekly", 88, 3, 2, 5]);
});

test("tick: a resetsAt more than an hour later is a reset; codex-style drift of seconds is not", async () => {
  const jump = rig({ snaps: [claude([week({ pct: 4, resetsAt: T0 + 3 * DAY + 2 * HOUR })])], store: seeded({ "claude:weekly": winState({ bgPct: 3 }) }) });
  await jump.b.tick();
  assert.equal(win(jump).bgPct, 0);
  assert.equal(win(jump).windowStart, T0, "min(old reset, now) — the old reset is in the future");

  const drift = rig({ snaps: [claude([week({ pct: 10, resetsAt: T0 + 3 * DAY + 5_000 })])], store: seeded({ "claude:weekly": winState({ bgPct: 3 }) }) });
  await drift.b.tick();
  assert.deepEqual([win(drift).bgPct, win(drift).resetsAt], [3, T0 + 3 * DAY + 5_000]);
});

test("tick: windows stay unattributed while stale (the provider has not published the new window)", async () => {
  const r = rig({ snaps: [claude([week({ pct: 90, resetsAt: T0 - HOUR, stale: true })])], store: seeded({ "claude:weekly": winState({ resetsAt: T0 - HOUR, bgPct: 3 }) }) });
  await r.b.tick();
  assert.equal(win(r).bgPct, 3, "no reset until the new window appears");
  r.world.snaps = [claude([week({ pct: 1, resetsAt: T0 + 7 * DAY })])];
  await r.b.tick();
  assert.equal(win(r).bgPct, 0);
});

test("tick: a reading whose resetsAt has passed is reused until the poller refreshes it — one window-close, no false window-busy, bgPct kept", async () => {
  const stale = week({ pct: 90, resetsAt: T0 + HOUR }); // the poller's last reading: not flagged, its window ended an hour ago
  const r = rig({ snaps: [claude([stale])], store: seeded({ "claude:weekly": winState({ resetsAt: T0 + HOUR, bgPct: 3, batchPct: 2, lastTick: { at: T0, pct: 88 } }) }) });
  r.clock.t = T0 + 2 * HOUR;
  for (let i = 0; i < 4; i += 1) {
    await r.b.tick();
    r.clock.t += 10 * 60_000;
  }
  assert.equal(r.logs.filter((l) => l.type === "window-close").length, 0, "an unchanged reading is not news: no reset is invented from it");
  assert.equal(win(r).bgPct, 3);
  const d = await r.b.check({ workType: "cto-ambient", model: OPUS });
  assert.equal(d.ok, true, "the old window's 90 % is not read as live");
  assert.equal(d.window.bgPct, 0, "…and its share reads 0 — the window that held it has ended");

  // the poller catches up: ONE close, then more unchanged ticks close nothing more
  r.world.snaps = [claude([week({ pct: 2, resetsAt: T0 + 2 * HOUR + 7 * DAY })])];
  for (let i = 0; i < 3; i += 1) {
    await r.b.tick();
    r.clock.t += 10 * 60_000;
  }
  assert.equal(r.logs.filter((l) => l.type === "window-close").length, 1);
  assert.deepEqual([win(r).bgPct, win(r).resetsAt], [0, T0 + 2 * HOUR + 7 * DAY]);
});

test("tick: a failing adapter keeps its last reading; ticks after its resetsAt never repeat the reset", async () => {
  const r = rig({ snaps: [claude([week({ pct: 50, resetsAt: T0 + HOUR })])], store: seeded({ "claude:weekly": winState({ resetsAt: T0 + HOUR, bgPct: 2, bgTokensSinceTick: 40 }) }) });
  r.clock.t = T0 + 3 * HOUR;
  await r.b.tick();
  await r.b.tick();
  assert.deepEqual([win(r).bgPct, win(r).bgTokensSinceTick, win(r).resetsAt], [2, 40, T0 + HOUR]);
  assert.equal(r.logs.some((l) => l.type === "window-close"), false);
});

test("record before the first tick created the window state is kept (state created from the live reading)", async () => {
  const r = rig({ snaps: [claude([week({ pct: 10 }), five({ pct: 5 })])] });
  await r.b.record({ workType: "knowledge-tidy", model: OPUS, usage: { input: 800 }, inLedger: true });
  assert.deepEqual([win(r).bgTokensSinceTick, win(r).batchTokensSinceTick], [800, 800]);
  assert.deepEqual([win(r).lastTick.pct, win(r).resetsAt], [10, T0 + 3 * DAY]);
  assert.equal(win(r, "claude:session").bgTokensSinceTick, 800);
  r.world.snaps = [claude([week({ pct: 12 }), five({ pct: 5 })])];
  r.world.totals = { byProvider: { anthropic: 1600 } };
  r.clock.t += 600_000;
  await r.b.tick();
  assert.equal(win(r).bgPct, 1, "dPct 2 × 800/1600: the early spend is attributed");
});

test("record from a stale reading (before the first tick) creates no window state — no spurious window-close when the new window appears", async () => {
  const r = rig({ snaps: [claude([week({ pct: 90, resetsAt: T0 - HOUR })])] }); // the window ended an hour ago; not flagged
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 500 }, inLedger: true });
  assert.equal(r.store.data.windows["claude:weekly"], undefined);
  r.world.snaps = [claude([week({ pct: 2, resetsAt: T0 + 7 * DAY })])];
  await r.b.tick();
  assert.equal(r.logs.some((l) => l.type === "window-close"), false, "the first tick is a first sighting, not a reset");
  assert.equal(win(r).bgPct, 0);

  const flagged = rig({ snaps: [claude([week({ pct: 90, stale: true })])] });
  await flagged.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 500 } });
  assert.equal(flagged.store.data.windows["claude:weekly"], undefined, "a flagged-stale reading too");
});

test("tick: absent resetsAt — no reset detection, resumesAt null; a reset instant appearing later is a first sighting", async () => {
  const none = rig({ snaps: [claude([week({ pct: 10, resetsAt: undefined })])], store: seeded({ "claude:weekly": winState({ resetsAt: null, bgPct: 5 }) }) });
  await none.b.tick();
  assert.deepEqual([win(none).bgPct, win(none).resetsAt], [5, null], "no reset without a reset instant");
  const d = await none.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([d.reason, d.resumesAt], ["level-cap", null]);

  none.world.snaps = [claude([week({ pct: 10, resetsAt: T0 + 3 * DAY })])];
  await none.b.tick();
  assert.deepEqual([win(none).bgPct, win(none).resetsAt], [0, T0 + 3 * DAY]);
});

test("tick: tokens recorded while a plan was in fallback are added at the next good tick", async () => {
  const r = await started();
  r.world.snaps = [];
  const rec = await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 500 }, inLedger: true });
  assert.equal(rec.mode, "payg", "snapshot missing → the dollar cap governs the call");
  assert.equal(r.store.data.fallbackTokens.claude.bg, 500);
  r.world.snaps = [claude([week({ pct: 12 })])];
  r.world.totals = { byProvider: { anthropic: 1000 } };
  r.clock.t += 600_000;
  await r.b.tick();
  assert.equal(win(r).bgPct, 1, "dPct 2 × 500/1000");
  assert.deepEqual(r.store.data.fallbackTokens, {});
});

test("tick: credit and window-less snapshots are ignored; every plan window is tracked under <adapter>:<kind>", async () => {
  const r = rig({
    snaps: [
      claude([week(), five()]),
      { provider: "deepseek", providerIDs: ["deepseek"], kind: "credit", balance: 1, windows: [week()], fetchedAt: T0 },
      { provider: "kimi", providerIDs: ["kimi-for-coding"], kind: "subscription", windows: [], fetchedAt: T0 },
    ],
  });
  await r.b.tick();
  assert.deepEqual(Object.keys(r.store.data.windows).sort(), ["claude:session", "claude:weekly"]);
});

test("tick: records spend into every governing window of the model; a batch record also feeds the batch counter", async () => {
  const r = await started({ snaps: [claude([week({ pct: 10 }), five({ pct: 5 })])] });
  await r.b.record({ workType: "knowledge-tidy", model: OPUS, usage: { input: 100 }, inLedger: true });
  assert.deepEqual([win(r).bgTokensSinceTick, win(r).batchTokensSinceTick], [100, 100]);
  assert.deepEqual([win(r, "claude:session").bgTokensSinceTick, win(r, "claude:session").batchTokensSinceTick], [100, 100]);
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 50 } });
  assert.deepEqual([win(r).bgTokensSinceTick, win(r).batchTokensSinceTick], [150, 100]);
});

test("tick: the batch share is attributed separately", async () => {
  const r = await started();
  await r.b.record({ workType: "knowledge-tidy", model: OPUS, usage: { input: 200 }, inLedger: true });
  await r.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 200 }, inLedger: true });
  r.world.snaps = [claude([week({ pct: 12 })])];
  r.world.totals = { byProvider: { anthropic: 1000 } };
  r.clock.t += 600_000;
  await r.b.tick();
  assert.deepEqual([win(r).bgPct, win(r).batchPct], [0.8, 0.4]);
});

test("tick: concurrent ticks join one run; a first call on a fresh store works", async () => {
  const r = rig();
  await Promise.all([r.b.tick(), r.b.tick(), r.b.tick()]);
  assert.equal(r.store.saves >= 1, true);
  assert.equal(Object.keys(r.store.data.windows).length, 2);
});

test("tick records hit100At the first time a window reaches 100 % and reports it at the window's close", async () => {
  const r = rig({ snaps: [claude([week({ pct: 100, resetsAt: T0 + HOUR })])], store: seeded({ "claude:weekly": winState({ resetsAt: T0 + HOUR, lastTick: { at: T0, pct: 99 } }) }) });
  await r.b.tick();
  assert.equal(win(r).hit100At, T0);
  r.clock.t = T0 + 2 * HOUR;
  r.world.snaps = [claude([week({ pct: 1, resetsAt: T0 + 8 * DAY })])];
  await r.b.tick();
  assert.equal(r.logs.find((l) => l.type === "window-close").hit100At, T0);
  assert.equal(win(r).hit100At, null);
});

// ---- timing ----

test("goodMomentForBatch rule 1: user away (desktop not present, no recent turn)", async () => {
  const r = rig({ desktop: "gone" });
  const g = await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 - HOUR });
  assert.deepEqual(g, { ok: true, rule: "away", reason: null });
  const row = r.logs.find((l) => l.type === "batch-start");
  assert.deepEqual([row.rule, row.desktopState, row.userAway, row.dueForH], ["away", "gone", true, 1]);
});

test("userAway: a user-started turn in the last 15 minutes (a phone user) counts as present", async () => {
  const r = rig({ desktop: "away", lastPrompt: T0 - 5 * 60_000 });
  assert.equal((await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 })).ok, false);
  r.world.lastPrompt = T0 - 20 * 60_000;
  assert.equal((await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 })).rule, "away");
  const present = rig({ desktop: "present", lastPrompt: 0 });
  assert.equal((await present.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 })).ok, false);
  const forced = createBackgroundBudget({ configGet: async () => ({}), userAway: () => true, store: memStore(), now: () => T0 });
  assert.equal((await forced.goodMomentForBatch({ workType: "knowledge-tidy", model: null, dueSince: T0 })).rule, "away");
});

test("goodMomentForBatch rule 2: on a plan, a governing weekly window resetting within 24 h (spare quota about to be wasted)", async () => {
  const near = rig({ snaps: [claude([week({ resetsAt: T0 + 20 * HOUR })])] });
  assert.deepEqual(await near.b.goodMomentForBatch({ workType: "knowledge-corrections", model: OPUS, dueSince: T0 }), { ok: true, rule: "near-reset", reason: null });
  const row = near.logs.find((l) => l.type === "batch-start");
  assert.deepEqual([row.rule, row.hoursToReset], ["near-reset", 20]);
  const far = rig({ snaps: [claude([week({ resetsAt: T0 + 30 * HOUR })])] });
  assert.equal((await far.b.goodMomentForBatch({ workType: "knowledge-corrections", model: OPUS, dueSince: T0 })).ok, false);
  const payg = rig({ snaps: [], defaultModel: OR });
  assert.equal((await payg.b.goodMomentForBatch({ workType: "knowledge-corrections", model: OR, dueSince: T0 })).ok, false, "rule 2 is plan-only");
  const shortOnly = rig({ snaps: [claude([five({ resetsAt: T0 + HOUR })])] });
  assert.equal((await shortOnly.b.goodMomentForBatch({ workType: "knowledge-corrections", model: OPUS, dueSince: T0 })).ok, false, "a 5-hour reset is not a weekly reset");
});

test("goodMomentForBatch rule 3: due for more than 48 h starts regardless; a refusal is remembered as waiting", async () => {
  const r = rig();
  const wait = await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 - 47 * HOUR });
  assert.deepEqual(wait, { ok: false, rule: null, reason: "waiting-for-quiet" });
  assert.deepEqual((await r.b.status()).waitingBatch, [{ workType: "knowledge-tidy", dueSince: T0 - 47 * HOUR }]);
  const go = await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: OPUS, dueSince: T0 - 49 * HOUR });
  assert.deepEqual(go, { ok: true, rule: "overdue", reason: null });
  assert.deepEqual((await r.b.status()).waitingBatch, [], "started: no longer waiting");
});

test("dueAt resolves the governing weekly window for weeklyDueAt", async () => {
  const r = rig({ snaps: [claude([week({ resetsAt: T0 + 3 * DAY })])] });
  assert.equal(await r.b.dueAt({ model: OPUS, intervalDueAt: T0 - DAY }), T0 + 2 * DAY);
  const payg = rig({ snaps: [] , defaultModel: OR });
  assert.equal(await payg.b.dueAt({ model: OR, intervalDueAt: T0 - DAY }), T0 - DAY);
});

// ---- state, evidence, failure ----

test("the state round-trips through the store: a new instance sees the same totals and window shares", async () => {
  const r = await started();
  await r.b.record({ workType: "cto-ambient", model: OPUS, usd: 2, usage: { input: 10 } });
  const again = rig({ store: r.store, snaps: r.world.snaps });
  await again.b.status();
  assert.equal(again.b.usdToday({ workType: "cto-ambient" }), 2);
  assert.equal(r.store.data.windows["claude:weekly"].lastTick.pct, 10);
});

test("check fails closed: unreadable config, unreadable state, an unknown work type, a throwing snapshot reader", async () => {
  const cfgDown = rig();
  cfgDown.world.cfgError = true;
  const a = await cfgDown.b.check({ workType: "cto-ambient", model: OPUS });
  assert.deepEqual([a.ok, a.reason], [false, "unavailable"]);

  const store = memStore();
  store.load = async () => {
    throw new Error("corrupt");
  };
  const stateDown = rig({ store });
  assert.equal((await stateDown.b.check({ workType: "cto-ambient", model: OPUS })).reason, "unavailable");

  const unknown = rig();
  assert.equal((await unknown.b.check({ workType: "who-knows", model: OPUS })).reason, "unavailable");
  assert.equal((await unknown.b.check()).reason, "unavailable");

  const snapDown = createBackgroundBudget({ store: memStore(), configGet: async () => ({}), listSnapshots: () => { throw new Error("poller"); }, adapterForProviderID: (p) => ADAPTERS[p] ?? null, now: () => T0 });
  assert.equal((await snapDown.check({ workType: "cto-ambient", model: OPUS })).reason, "unavailable");
});

test("evidence: refusals coalesce per (work type, reason, hour) with a count; spend and tick rows carry their fields", async () => {
  const r = rig({ bw: { level: "off" } });
  for (let i = 0; i < 3; i++) await r.b.check({ workType: "cto-ambient", model: OPUS });
  await r.b.check({ workType: "knowledge-capture", model: OPUS });
  assert.equal(r.logs.filter((l) => l.type === "refused").length, 0, "the current hour is still open");
  r.clock.t += HOUR;
  await r.b.check({ workType: "cto-ambient", model: OPUS });
  const flushed = r.logs.filter((l) => l.type === "refused");
  assert.equal(flushed.length, 2, "the first hour's two buckets");
  assert.equal(flushed.find((l) => l.workType === "cto-ambient").count, 3);
  r.b.flushEvidence();
  const all = r.logs.filter((l) => l.type === "refused");
  assert.equal(all.length, 3);
  assert.deepEqual(Object.keys(all[0]).sort(), ["bgPct", "cap", "ceiling", "class", "count", "key", "pct", "projectedPct", "reason", "ts", "type", "workType"]);
});

test("evidence: spend rows carry class and fallback", async () => {
  const r = rig({ snaps: [] });
  await r.b.record({ workType: "knowledge-trial", model: OPUS, usage: { input: 10 } });
  const s = r.logs.find((l) => l.type === "spend");
  assert.deepEqual([s.workType, s.mode, s.class, s.fallback, s.tokens], ["knowledge-trial", "payg", "batch", true, 10]);
  const log = rig({ snaps: [claude([week()])] });
  await log.b.tick();
  await log.b.record({ workType: "cto-ambient", model: OPUS, usage: { input: 10 } });
  assert.equal(log.logs.find((l) => l.type === "spend").key, "claude:weekly");
});

test("a log that throws or rejects never reaches a decision", async () => {
  const b = createBackgroundBudget({ store: memStore(), configGet: async () => ({ backgroundWork: { level: "off" } }), listSnapshots: () => [claude([week()])], adapterForProviderID: (p) => ADAPTERS[p] ?? null, log: { append: () => { throw new Error("x"); } }, now: () => T0 });
  assert.equal((await b.check({ workType: "cto-ambient", model: OPUS })).reason, "off");
  b.flushEvidence();
  const rej = createBackgroundBudget({ store: memStore(), configGet: async () => ({}), log: { append: () => Promise.reject(new Error("x")) }, now: () => T0 });
  await rej.record({ workType: "cto-ambient", model: OPUS, usd: 1 });
});

// ---- status ----

test("status: plan rows with windows, projection and structured pause reasons for continuous and batch work", async () => {
  const r = rig({
    snaps: [claude([week({ pct: 40 }), five({ pct: 20 })])],
    store: seeded({ "claude:weekly": winState({ bgPct: 3.2, batchPct: 3.1 }), "claude:session": winState({ resetsAt: T0 + 2 * HOUR, bgPct: 1 }) }),
    connected: ["anthropic", "openrouter"],
  });
  await r.b.record({ workType: "knowledge-capture", model: OR, usd: 1.2 });
  const s = await r.b.status();
  assert.equal(s.level, "normal");
  assert.equal(s.dailyCapUsd, 5);
  assert.deepEqual(s.payg.providers, ["openrouter"]);
  assert.equal(s.payg.usdToday, 1.2);
  assert.equal(s.payg.usdMonth, 1.2);
  assert.equal(s.payg.paused, null);
  assert.equal(s.plans.length, 1);
  const p = s.plans[0];
  assert.deepEqual([p.adapter, p.planLabel, p.fallback, p.paused], ["claude", "Max 20x", false, null]);
  assert.deepEqual(p.windows.map((w) => w.key), ["claude:weekly", "claude:session"]);
  assert.deepEqual(p.windows[0], { key: "claude:weekly", kind: "weekly", label: "7d", pct: 40, bgPct: 3.2, cap: 5, projectedPct: 70, resetsAt: T0 + 3 * DAY, windowStart: T0 - 4 * DAY, spanMs: null });
  assert.equal(p.windows[1].projectedPct, null);
  assert.deepEqual(p.batchPaused, { reason: "level-cap", windowKey: "claude:weekly", value: 3, resumesAt: T0 + 3 * DAY });
});

test("status: paused reasons carry the value the copy needs", async () => {
  const busy = rig({ snaps: [claude([week(), five({ pct: 74 })])] });
  const s = await busy.b.status();
  assert.deepEqual(s.plans[0].paused, { reason: "window-busy", windowKey: "claude:session", value: 74, resumesAt: T0 + 2 * HOUR });
  const projected = rig({ snaps: [claude([week({ pct: 50 })])] });
  const p = (await projected.b.status()).plans[0].paused;
  assert.deepEqual([p.reason, p.value], ["projected-high", 87.5]);
  const off = await rig({ bw: { level: "off" } }).b.status();
  assert.deepEqual([off.level, off.plans[0].paused.reason], ["off", "off"]);
  const payg = rig({ snaps: [], bw: { dailyCapUsd: 5 } });
  await payg.b.record({ workType: "cto-ambient", model: OR, usd: 5 });
  const ps = (await payg.b.status()).payg;
  assert.deepEqual(ps.paused, { reason: "usd-cap", value: 5, resumesAt: nextLocalMidnight(T0) });
  assert.equal(ps.batchPaused.reason, "usd-cap");
});

test("status: a connected plan provider whose usage can't be read is a fallback row limited by the dollar cap", async () => {
  const r = rig({ snaps: [], connected: ["anthropic"] });
  const s = await r.b.status();
  assert.equal(s.plans.length, 1);
  assert.deepEqual([s.plans[0].adapter, s.plans[0].fallback, s.plans[0].windows], ["claude", true, []]);
  assert.equal(s.plans[0].paused, null);
  assert.deepEqual(s.payg.providers, []);
});

test("status: a credit-kind provider is pay-per-token and an unlisted key too", async () => {
  const r = rig({ snaps: [{ provider: "deepseek", providerIDs: ["deepseek"], kind: "credit", balance: 4, windows: [], fetchedAt: T0 }], connected: ["deepseek", "openrouter"] });
  const s = await r.b.status();
  assert.deepEqual(s.payg.providers, ["deepseek", "openrouter"]);
  assert.deepEqual(s.plans, []);
});

test("status never throws on an empty box", async () => {
  const b = createBackgroundBudget({ store: memStore(), configGet: async () => ({}), now: () => T0 });
  const s = await b.status();
  assert.deepEqual([s.level, s.dailyCapUsd, s.plans, s.waitingBatch, s.byWork], ["normal", 5, [], [], []]);
});

// ---- follow-ups: runWhenBusy override, spanMs window classification ----

test("runWhenBusy skips exactly the plan-busy rules (short window-busy, weekly projection, near-reset variant, weekly no-projection busy)", async () => {
  const bw = { runWhenBusy: true };
  const ask = (snaps, o = {}) => rig({ snaps, bw, ...o }).b.check({ workType: "cto-ambient", model: OPUS });
  assert.equal((await ask([claude([week(), five({ pct: 74 })])])).ok, true, "short window busy: skipped");
  assert.equal((await ask([claude([week({ pct: 50 })])])).ok, true, "projected-high: skipped");
  assert.equal((await ask([claude([week({ pct: 92, resetsAt: T0 + 12 * HOUR })])])).ok, true, "near-reset variant: skipped");
  assert.equal((await ask([claude([week({ pct: 75, resetsAt: T0 + 6.5 * DAY })])])).ok, true, "weekly with no projection and pct > 70: skipped");
  // …and the same inputs refuse without the override.
  const off = (snaps) => rig({ snaps }).b.check({ workType: "cto-ambient", model: OPUS });
  assert.equal((await off([claude([week(), five({ pct: 74 })])])).reason, "window-busy");
  assert.equal((await off([claude([week({ pct: 50 })])])).reason, "projected-high");
  assert.equal((await off([claude([week({ pct: 92, resetsAt: T0 + 12 * HOUR })])])).reason, "projected-high");
  assert.equal((await off([claude([week({ pct: 75, resetsAt: T0 + 6.5 * DAY })])])).reason, "window-busy");
});

test("runWhenBusy still enforces off, exhausted, level caps (incl. the batch ceiling) and the pay-per-token cap", async () => {
  const bw = { runWhenBusy: true };
  assert.equal((await rig({ bw: { ...bw, level: "off" } }).b.check({ workType: "cto-ambient", model: OPUS })).reason, "off");
  assert.equal((await rig({ bw, snaps: [claude([week({ pct: 100 })])] }).b.check({ workType: "cto-ambient", model: OPUS })).reason, "exhausted");
  assert.equal((await rig({ bw, snaps: [claude([week({ pct: 10 })])], store: seeded({ "claude:weekly": winState({ bgPct: 5 }) }) }).b.check({ workType: "cto-ambient", model: OPUS })).reason, "level-cap");
  const ceil = await rig({ bw, snaps: [claude([week({ pct: 10 })])], store: seeded({ "claude:weekly": winState({ bgPct: 3, batchPct: 3 }) }) }).b.check({ workType: "knowledge-tidy", model: OPUS });
  assert.deepEqual([ceil.ok, ceil.reason], [false, "level-cap"], "batch ceiling is 60 % of the 5 % cap");
  const payg = rig({ bw: { ...bw, dailyCapUsd: 1 } });
  await payg.b.record({ workType: "knowledge-capture", model: { providerID: "deepseek", modelID: "x" }, usd: 1 });
  assert.equal((await payg.b.check({ workType: "knowledge-capture", model: { providerID: "deepseek", modelID: "x" } })).reason, "usd-cap");
});

test("status returns runWhenBusy; a plan paused for busyness reports no pause with the override on", async () => {
  const on = await rig({ snaps: [claude([week({ pct: 50 })])], bw: { runWhenBusy: true } }).b.status();
  assert.equal(on.runWhenBusy, true);
  assert.equal(on.plans[0].paused, null);
  const off = await rig({ snaps: [claude([week({ pct: 50 })])] }).b.status();
  assert.equal(off.runWhenBusy, false);
  assert.equal(off.plans[0].paused.reason, "projected-high");
});

test("isWeeklyWindow: weekly kind OR spanMs ≥ 2 days; levelCap takes a window (or a kind string)", () => {
  assert.equal(isWeeklyWindow({ kind: "session" }), false);
  assert.equal(isWeeklyWindow({ kind: "session", spanMs: 5 * HOUR }), false);
  assert.equal(isWeeklyWindow({ kind: "session", spanMs: 7 * DAY }), true);
  assert.equal(isWeeklyWindow({ kind: "session", spanMs: 2 * DAY }), true);
  assert.equal(isWeeklyWindow({ kind: "session", spanMs: 2 * DAY - 1 }), false);
  assert.equal(isWeeklyWindow({ kind: "weekly_scoped:fable" }), true);
  assert.equal(levelCap("normal", { kind: "session", spanMs: 7 * DAY }), 5);
  assert.equal(levelCap("normal", { kind: "session", spanMs: 5 * HOUR }), 10);
});

test("a codex-style 7-day primary window (kind session, spanMs 7 d) is weekly: 5 % cap, projection, window start = resetsAt − spanMs", async () => {
  const codex = (w) => ({ provider: "codex", providerIDs: ["openai"], kind: "subscription", planLabel: "Pro", windows: [w], fetchedAt: T0 });
  const gpt = { providerID: "openai", modelID: "gpt-6" };
  // 3 of 7 days elapsed (resets in 4 days), 40 % used → 93.3 % projected.
  const w = { kind: "session", label: "7d", pct: 40, spanMs: 7 * DAY, resetsAt: T0 + 4 * DAY };
  const r = rig({ snaps: [codex(w)] });
  const d = await r.b.check({ workType: "cto-ambient", model: gpt });
  assert.deepEqual([d.ok, d.reason, d.window.cap, d.window.projectedPct], [false, "projected-high", 5, 93.33]);
  const s = await r.b.status();
  assert.deepEqual([s.plans[0].windows[0].windowStart, s.plans[0].windows[0].spanMs, s.plans[0].windows[0].cap], [T0 - 3 * DAY, 7 * DAY, 5]);
  // A real 5-hour session window with a spanMs stays short: busy rule, 10 % cap, no projection.
  const short = rig({ snaps: [codex({ kind: "session", label: "5h", pct: 74, spanMs: 5 * HOUR, resetsAt: T0 + 2 * HOUR })] });
  const sd = await short.b.check({ workType: "cto-ambient", model: gpt });
  assert.deepEqual([sd.reason, sd.window.cap, sd.window.projectedPct], ["window-busy", 10, undefined]);
  const ss = (await short.b.status()).plans[0].windows[0];
  assert.deepEqual([ss.windowStart, ss.spanMs], [T0 + 2 * HOUR - 5 * HOUR, 5 * HOUR]);
});

test("weekly batch timing follows the window, not the kind: a 7-day 'session' window makes a batch job near-reset and sets the governing reset", async () => {
  const codex = { provider: "codex", providerIDs: ["openai"], kind: "subscription", windows: [{ kind: "session", label: "7d", pct: 10, spanMs: 7 * DAY, resetsAt: T0 + 12 * HOUR }], fetchedAt: T0 };
  const gpt = { providerID: "openai", modelID: "gpt-6" };
  const r = rig({ snaps: [codex], desktop: "present", lastPrompt: T0 });
  assert.equal((await r.b.goodMomentForBatch({ workType: "knowledge-tidy", model: gpt, dueSince: T0 })).rule, "near-reset");
  assert.equal(await r.b.dueAt({ model: gpt, intervalDueAt: T0 - DAY }), T0 - 12 * HOUR);
});

test("projectWeeklyPct: spanMs picks the weekly classification and the default window start", () => {
  const base = { kind: "session", spanMs: 7 * DAY, pct: 50, resetsAt: T0 + 3 * DAY, now: T0 };
  assert.equal(projectWeeklyPct(base), 87.5);
  assert.equal(projectWeeklyPct({ ...base, spanMs: 5 * HOUR }), null);
  assert.equal(projectWeeklyPct({ ...base, spanMs: 4 * DAY, resetsAt: T0 + 2 * DAY }), 100, "start = resetsAt − spanMs");
});
