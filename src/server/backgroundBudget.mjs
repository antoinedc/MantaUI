// backgroundBudget.mjs — ONE budget for everything the box does that the user did not ask for
// (shared knowledge + the background CTO). Spec: docs/superpowers/specs/2026-11-17-background-work-budget.md
// (§17 amends earlier sections and wins).
//
// On a subscription plan the budget is a SHARE of the plan's quota windows (Off / Light / Normal);
// on a pay-per-token key it is a dollar cap per local day. `check` decides before a call, `record`
// books what it really cost, `tick` attributes the plan's reported usage movement to background work,
// `status` is what the UI shows. Everything is dependency-injected; nothing here touches a live box.
//
// `check` and `record` never throw. A gate that cannot decide refuses (`unavailable`): it fails closed.

import { windowAppliesToModel } from "../shared/seatChoice.mjs";
import { statePath } from "../shared/paths.mjs";
import { createMutex, readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { tokensSent } from "./modelLedger.mjs";

// ---------------------------------------------------------------------------
// Constants (exported: the UI copy, the tests and the follow-up routine read them)
// ---------------------------------------------------------------------------

export const LEVELS = Object.freeze(["off", "light", "normal"]);
export const DEFAULT_LEVEL = "normal";
export const DEFAULT_DAILY_CAP_USD = 5;
export const MAX_DAILY_CAP_USD = 100;
export const DEFAULT_BACKGROUND_WORK = Object.freeze({ level: DEFAULT_LEVEL, dailyCapUsd: DEFAULT_DAILY_CAP_USD });

/** Share of a window (percent) background work may use, by level. */
export const LEVEL_CAPS = Object.freeze({
  off: Object.freeze({ weekly: 0, short: 0 }),
  light: Object.freeze({ weekly: 2, short: 5 }),
  normal: Object.freeze({ weekly: 5, short: 10 }),
});
/** Batch work stops at this share of each cap; the rest is kept for continuous work. */
export const BATCH_SHARE = 0.6;
/** A short (non-weekly) window — or a weekly one with no projection — above this pct is "busy". */
export const WINDOW_BUSY_PCT = 70;
/** A weekly window projected to end above this pct pauses background work. */
export const PROJECTED_HIGH_PCT = 80;
/** Within NEAR_RESET_MS of a weekly reset the projection rule becomes `pct + (cap − bgPct) <= this`. */
export const NEAR_RESET_END_PCT = 95;
export const NEAR_RESET_MS = 24 * 3_600_000;
/** A batch job due for longer than this starts regardless of presence (it must not starve). */
export const OVERDUE_MS = 48 * 3_600_000;
/** `userAway` needs no user-started turn on the box for this long. */
export const USER_ACTIVE_MS = 15 * 60_000;
/** The projection is known only once this share of the window has elapsed. */
export const MIN_PROJECTION_ELAPSED = 0.2;
/** A `resetsAt` this much later than the stored one is a reset (codex drifts by seconds per poll). */
export const RESET_JUMP_MS = 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
export const RETENTION_DAYS = 60;
export const TICK_MS = 10 * 60_000;
const WINDOW_FORGET_MS = 14 * 24 * 3_600_000;
const WAITING_BATCH_TTL_MS = 6 * 3_600_000;

export const CLASS = Object.freeze({ CONTINUOUS: "continuous", BATCH: "batch" });
export const WORK_CLASS = Object.freeze({
  "knowledge-capture": CLASS.CONTINUOUS,
  "curator-notes": CLASS.CONTINUOUS,
  "curator-rules": CLASS.CONTINUOUS,
  "curator-skills": CLASS.CONTINUOUS,
  "knowledge-corrections": CLASS.BATCH,
  "knowledge-tidy": CLASS.BATCH,
  "knowledge-trial": CLASS.BATCH,
  "cto-ambient": CLASS.CONTINUOUS,
  "cto-overnight": CLASS.BATCH,
  "cto-backfill": CLASS.BATCH,
});
export const WORK_TYPES = Object.freeze(Object.keys(WORK_CLASS));
/** Router band that prices a model with no price of its own (§5.5). */
export const WORK_BANDS = Object.freeze({
  "knowledge-capture": "fast",
  "knowledge-corrections": "fast",
  "knowledge-tidy": "fast",
  "knowledge-trial": "balanced",
  "curator-notes": "balanced",
  "curator-rules": "deep",
  "curator-skills": "deep",
  "cto-ambient": "fast",
  "cto-overnight": "balanced",
  "cto-backfill": "fast",
});

export const REASONS = Object.freeze(["off", "level-cap", "window-busy", "projected-high", "exhausted", "usd-cap", "unavailable"]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (finite(v) && v >= 0 ? v : 0);
const round2 = (v) => Math.round(v * 100) / 100;
const warn = (...a) => console.warn("[background-budget]", ...a);

export function localDay(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nextLocalMidnight(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** `weekly`, `weekly_scoped:*`, … — every other kind ("session" = 5 hours, daily, …) is short. */
export function isWeeklyKind(kind) {
  return typeof kind === "string" && (kind === "weekly" || kind.startsWith("weekly"));
}

export function levelCap(level, kind) {
  const caps = LEVEL_CAPS[level] ?? LEVEL_CAPS[DEFAULT_LEVEL];
  return isWeeklyKind(kind) ? caps.weekly : caps.short;
}

const modelOf = (m) => {
  if (typeof m === "string") {
    const i = m.indexOf("/");
    return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : null;
  }
  return m && typeof m.providerID === "string" && m.providerID && typeof m.modelID === "string" && m.modelID ? { providerID: m.providerID, modelID: m.modelID } : null;
};

// ---------------------------------------------------------------------------
// Configuration: `backgroundWork` { level, dailyCapUsd } (§9, §17.18)
// ---------------------------------------------------------------------------

const validCap = (v) => finite(v) && v >= 0 && v <= MAX_DAILY_CAP_USD;

/** PURE. The stored value read leniently: an invalid or missing part reads as its default. */
export function readBackgroundWork(stored) {
  const o = isObj(stored) ? stored : {};
  return {
    level: LEVELS.includes(o.level) ? o.level : DEFAULT_LEVEL,
    dailyCapUsd: validCap(o.dailyCapUsd) ? round2(o.dailyCapUsd) : DEFAULT_DAILY_CAP_USD,
  };
}

/**
 * PURE. Validate a (partial) `backgroundWork` write and merge it into the stored value.
 * `current` is the stored object (may be missing/invalid → defaults). Returns `{ok:true, value}` or
 * `{ok:false, error}`, the error being a sentence the UI shows as-is.
 */
export function validateAndMergeBackgroundWork(current, patch) {
  if (!isObj(patch)) return { ok: false, error: "Background work settings must be an object." };
  const base = readBackgroundWork(current);
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "level") {
      if (!LEVELS.includes(value)) return { ok: false, error: 'Background work on plans must be "off", "light" or "normal".' };
      next.level = value;
    } else if (key === "dailyCapUsd") {
      if (!validCap(value)) return { ok: false, error: `The daily cap for API keys must be a number from $0 to $${MAX_DAILY_CAP_USD}.` };
      next.dailyCapUsd = round2(value);
    } else {
      return { ok: false, error: `Unknown background work setting "${key}".` };
    }
  }
  return { ok: true, value: next };
}

// ---------------------------------------------------------------------------
// Pricing (§5.5) — moved from knowledge/budget.mjs; one path for both subsystems
// ---------------------------------------------------------------------------

// Last resort when the box has no priced model at all ($ per million tokens).
export const FALLBACK_RATES = Object.freeze({ input: 15, output: 75 });
const CACHE_READ_FACTOR = 0.1;

/** A bare total (the runner could only estimate prompt + answer) is split 90 % input / 10 % output. */
export function normalizeTokens(tokens) {
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) return { input: Math.round(tokens * 0.9), output: Math.round(tokens * 0.1) };
  if (!tokens || typeof tokens !== "object") return undefined;
  // opencode's own message shape nests the cache buckets (`cache: {read, write}`); the runner's usage is flat.
  if (tokens.cache && typeof tokens.cache === "object") {
    const { cache, ...rest } = tokens;
    return { ...rest, cacheRead: rest.cacheRead ?? cache.read, cacheWrite: rest.cacheWrite ?? cache.write };
  }
  return tokens;
}

/** PURE. $ for `tokens` at `rates` ($ per million tokens). */
export function priceTokens(tokens, rates) {
  const input = num(rates.input);
  const output = num(rates.output);
  const cacheWrite = rates.cacheWrite !== undefined ? num(rates.cacheWrite) : input;
  const cacheRead = rates.cacheRead !== undefined ? num(rates.cacheRead) : input * CACHE_READ_FACTOR;
  const t = tokens ?? {};
  return (num(t.input) * input + num(t.output) * output + num(t.cacheRead) * cacheRead + num(t.cacheWrite) * cacheWrite + num(t.reasoning) * output) / 1e6;
}

/** PURE. The rates to charge: the model's own, else the dearest priced model of its band, else the dearest overall, else FALLBACK_RATES. */
export function resolveRates({ providerID, modelID, band, prices, bandOf }) {
  const models = prices?.models ?? {};
  const own = models[`${providerID}/${modelID}`];
  if (own && num(own.input) > 0 && num(own.output) > 0) return { rates: own, priced: true };
  const dearest = (keys) => {
    let best = null;
    for (const k of keys) {
      const r = models[k];
      if (!r || !(num(r.input) > 0)) continue;
      if (!best || num(r.input) + num(r.output) > num(best.input) + num(best.output)) best = r;
    }
    return best;
  };
  const keys = Object.keys(models);
  const inBand =
    band && bandOf
      ? keys.filter((k) => {
          const i = k.indexOf("/");
          return bandOf(k.slice(0, i), k.slice(i + 1)) === band;
        })
      : [];
  const r = dearest(inBand) ?? dearest(keys);
  return { rates: r ?? FALLBACK_RATES, priced: false };
}

// ---------------------------------------------------------------------------
// Timing helpers (§8, §17.17)
// ---------------------------------------------------------------------------

/**
 * PURE. When a weekly batch job (`knowledge-corrections`, `knowledge-tidy`) becomes due. `intervalDueAt` is when its
 * own interval elapses (its existing schedule). On a plan it waits for `resetsAt − 24 h` of the governing weekly
 * window, unless its interval only elapses after that reset (a later window: keep its own time). Pay-per-token, or a
 * window with no known reset: its existing schedule. The 48 h "overdue" rule counts from the returned instant.
 */
export function weeklyDueAt({ mode, intervalDueAt, resetsAt } = {}) {
  if (!finite(intervalDueAt)) return intervalDueAt;
  if (mode !== "plan" || !finite(resetsAt)) return intervalDueAt;
  if (intervalDueAt >= resetsAt) return intervalDueAt;
  return Math.max(intervalDueAt, resetsAt - NEAR_RESET_MS);
}

/** PURE. The end-of-window projection (§6.5, §17.8): known for a weekly-kind window once ≥ 20 % of it has elapsed. */
export function projectWeeklyPct({ kind, pct, resetsAt, startedAt, windowStart, now }) {
  if (!isWeeklyKind(kind) || !finite(pct) || !finite(resetsAt) || !finite(now)) return null;
  const start = finite(startedAt) ? startedAt : finite(windowStart) ? windowStart : resetsAt - WEEK_MS;
  const span = resetsAt - start;
  const elapsed = now - start;
  if (!(span > 0) || elapsed < MIN_PROJECTION_ELAPSED * span || elapsed > span) return null;
  return (pct * span) / elapsed;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const newDay = () => ({ payg: { usd: 0, batchUsd: 0 }, plan: { usd: 0 }, byWork: {} });

function normalizeState(raw) {
  const o = isObj(raw) ? raw : {};
  return {
    v: 1,
    windows: isObj(o.windows) ? o.windows : {},
    days: isObj(o.days) ? o.days : {},
    fallbackTokens: isObj(o.fallbackTokens) ? o.fallbackTokens : {},
  };
}

function newWindowState(w, t) {
  return {
    resetsAt: finite(w.resetsAt) ? w.resetsAt : null,
    windowStart: finite(w.startedAt) ? w.startedAt : null,
    bgPct: 0,
    batchPct: 0,
    bgTokensSinceTick: 0,
    batchTokensSinceTick: 0,
    bgNotInLedgerSinceTick: 0,
    lastTick: { at: t, pct: w.pct },
    tokensPerPct: null,
    hit100At: w.pct >= 100 ? t : null,
    seenAt: t,
  };
}

/**
 * A reading whose window has already ended: the poller flagged it (`stale`), or its `resetsAt` has passed since it was
 * read (the last reading is reused until the next successful poll). It describes the window that just ended.
 */
const isStaleWindow = (w, t) => w.stale === true || (finite(w.resetsAt) && w.resetsAt <= t);

const zeroCounters = (ws) => {
  ws.bgTokensSinceTick = 0;
  ws.batchTokensSinceTick = 0;
  ws.bgNotInLedgerSinceTick = 0;
};

/** The default store: one JSON file in the state dir (atomic writes). */
export function createBackgroundBudgetStore(path = statePath("background-budget.json")) {
  return {
    path,
    load: async () => readJsonSync(path, null),
    save: (data) => writeJsonAtomic(path, JSON.stringify(data)),
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{load:()=>Promise<any>, save:(s:any)=>Promise<void>}} [deps.store]  JSON state (default: a file under the state dir)
 * @param {{append:(row:object)=>any}} [deps.log]  append-only evidence log (§11)
 * @param {()=>Promise<object>} deps.configGet  reads the box config (`backgroundWork`)
 * @param {()=>Promise<object[]>|object[]} deps.listSnapshots  usage.mjs aggregate snapshots
 * @param {(a:{sinceMs:number})=>Promise<{byProvider:Record<string,number>}|null>} deps.providerTokenTotals  modelLedger.mjs
 * @param {()=>Promise<{models:object}>} [deps.getPrices]  $ per million tokens by "<provider>/<model>"
 * @param {(providerID:string, modelID:string)=>string|null} [deps.bandOf]  "fast"|"balanced"|"deep"|null
 * @param {(providerID:string)=>string|null} [deps.adapterForProviderID]  usage adapter id, or null for a pay-per-token key
 * @param {()=>Promise<{providerID:string,modelID:string}|null>} [deps.resolveDefaultModel]  the box default model
 * @param {()=>string} [deps.desktopState]  "present"|"away"|"gone" (push.desktopState)
 * @param {()=>number} [deps.lastUserPromptAt]  epoch ms of the last user-started turn (0 when unknown)
 * @param {()=>boolean} [deps.userAway]  overrides the desktopState + lastUserPromptAt reading (§8)
 * @param {()=>Promise<Record<string,{tokensPerPct?:number}>>} [deps.pacingWindows]  optimizer pacing's `pressureWindows` (tokensPerPct fallback)
 * @param {()=>Promise<string[]>} [deps.listConnectedProviders]  connected opencode providerIDs (status only)
 * @param {()=>number} [deps.now]
 */
export function createBackgroundBudget({
  store = createBackgroundBudgetStore(),
  log = null,
  configGet,
  listSnapshots = () => [],
  providerTokenTotals = async () => null,
  getPrices = async () => ({ models: {} }),
  bandOf = () => null,
  adapterForProviderID = () => null,
  resolveDefaultModel = async () => null,
  desktopState = () => "present",
  lastUserPromptAt = () => 0,
  userAway: userAwayOverride = null,
  pacingWindows = null,
  listConnectedProviders = async () => [],
  now = Date.now,
} = {}) {
  const mutex = createMutex();
  let state = null;
  let loading = null;
  const refusedBuckets = new Map();
  const waiting = new Map(); // workType → {dueSince, at}

  // ---- evidence log (§11, §17.22): best-effort, never touches a decision ----
  function emit(row) {
    try {
      const p = log?.append?.({ ts: now(), ...row });
      if (p && typeof p.catch === "function") return p.catch(() => {});
    } catch {
      /* evidence is best-effort */
    }
    return undefined;
  }

  const hourOf = (t) => Math.floor(t / 3_600_000);

  function noteRefusal(workType, cls, d, extra) {
    const t = now();
    const bucketKey = `${workType}|${d.reason}|${hourOf(t)}`;
    let b = refusedBuckets.get(bucketKey);
    if (!b) {
      b = { hour: hourOf(t), row: { type: "refused", workType, class: cls, reason: d.reason }, count: 0 };
      refusedBuckets.set(bucketKey, b);
    }
    b.count += 1;
    b.row = {
      ...b.row,
      key: d.window?.key ?? null,
      pct: d.window?.pct ?? null,
      projectedPct: d.window?.projectedPct ?? null,
      bgPct: d.window?.bgPct ?? null,
      cap: extra?.cap ?? d.window?.cap ?? null,
      ceiling: extra?.ceiling === true,
    };
    flushRefusals(false);
  }

  /** Write the coalesced `refused` rows of hours that have ended (or all of them). Resolves once they are written. */
  function flushRefusals(all) {
    const h = hourOf(now());
    const writes = [];
    for (const [k, b] of refusedBuckets) {
      if (!all && b.hour >= h) continue;
      refusedBuckets.delete(k);
      writes.push(emit({ ...b.row, ts: b.hour * 3_600_000, count: b.count }));
    }
    return Promise.all(writes).then(() => undefined);
  }

  // ---- state access ----
  function ensureState() {
    if (state) return Promise.resolve(state);
    loading ??= Promise.resolve()
      .then(() => store.load())
      .then((raw) => (state = normalizeState(raw)))
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /** Run a SYNCHRONOUS mutation of the state under the mutex, then persist it. A save failure is logged and dropped. */
  function mutate(fn) {
    return mutex.runExclusive(async () => {
      const st = await ensureState();
      const result = fn(st);
      const cutoff = localDay(now() - RETENTION_DAYS * 86_400_000);
      for (const k of Object.keys(st.days)) if (k < cutoff) delete st.days[k];
      try {
        await store.save(st);
      } catch (e) {
        warn("saving the budget state failed:", e?.message ?? e);
      }
      return result;
    });
  }

  // ---- config / billing ----
  async function readConfig() {
    return readBackgroundWork((await configGet())?.backgroundWork);
  }

  async function snapshots() {
    const list = await Promise.resolve(listSnapshots());
    return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.provider === "string" && !s.seatId);
  }

  const isPlanSnapshot = (s) => s.kind === "subscription" || (s.kind == null && Array.isArray(s.windows) && s.windows.some(Boolean));

  async function pickModel(model) {
    const m = modelOf(model);
    if (m) return m;
    try {
      return modelOf(await resolveDefaultModel());
    } catch {
      return null;
    }
  }

  /** §4: plan or pay-per-token for a call on `model`, with the windows that govern a plan call. */
  function billingFor(model, snaps) {
    if (!model) return { mode: "payg", fallback: true, adapterId: null, snapshot: null, windows: [] };
    const adapterId = adapterForProviderID(model.providerID) ?? null;
    if (!adapterId) return { mode: "payg", fallback: false, adapterId: null, snapshot: null, windows: [] };
    const snapshot = snaps.find((s) => s.provider === adapterId) ?? null;
    if (!snapshot) return { mode: "payg", fallback: true, adapterId, snapshot: null, windows: [] };
    if (snapshot.kind === "credit") return { mode: "payg", fallback: false, adapterId, snapshot, windows: [] };
    if (!isPlanSnapshot(snapshot)) return { mode: "payg", fallback: true, adapterId, snapshot, windows: [] };
    const windows = governing(snapshot, model);
    if (windows.length === 0) return { mode: "payg", fallback: true, adapterId, snapshot, windows: [] };
    return { mode: "plan", fallback: false, adapterId, snapshot, windows };
  }

  function governing(snapshot, model) {
    const key = model ? `${model.providerID}/${model.modelID}` : null;
    const seen = new Set();
    const out = [];
    for (const w of Array.isArray(snapshot.windows) ? snapshot.windows : []) {
      if (!w || w.active === false || !finite(w.pct)) continue;
      if (!windowAppliesToModel(w, key)) continue;
      if (seen.has(w.kind)) continue;
      seen.add(w.kind);
      out.push(w);
    }
    return out;
  }

  const windowKey = (snapshot, w) => `${snapshot.provider}:${w.kind}`;

  async function pacingTokensPerPct(key) {
    try {
      const w = await pacingWindows?.();
      const v = w?.[key]?.tokensPerPct;
      return finite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  // ---- the decision (§5.3, §17.3/5/10/11) ----

  function paygDecision({ cfg, cls, fallback, ts }) {
    const st = state;
    const cap = cfg.dailyCapUsd;
    const day = st.days[localDay(ts)] ?? newDay();
    const total = num(day.payg.usd);
    const batch = num(day.payg.batchUsd);
    const resumesAt = nextLocalMidnight(ts);
    const base = { mode: "payg", fallback, resumesAt };
    if (cap <= 0 || total >= cap) return { d: { ok: false, ...base, reason: "usd-cap" }, cap, ceiling: false };
    if (cls === CLASS.BATCH && batch >= BATCH_SHARE * cap) return { d: { ok: false, ...base, reason: "usd-cap" }, cap, ceiling: true };
    return { d: { ok: true, mode: "payg", fallback, reason: null, resumesAt: null }, cap, ceiling: false };
  }

  async function windowView({ snapshot, w, level, ts }) {
    const key = windowKey(snapshot, w);
    const stale = isStaleWindow(w, ts);
    const ws = stale ? null : state.windows[key];
    const cap = levelCap(level, w.kind);
    const tpp = ws ? (finite(ws.tokensPerPct) && ws.tokensPerPct > 0 ? ws.tokensPerPct : ws.bgTokensSinceTick > 0 ? await pacingTokensPerPct(key) : null) : null;
    const inFlight = tpp ? num(ws.bgTokensSinceTick) / tpp : 0;
    const inFlightBatch = tpp ? num(ws.batchTokensSinceTick) / tpp : 0;
    const projectedPct = stale
      ? null
      : projectWeeklyPct({ kind: w.kind, pct: w.pct, resetsAt: w.resetsAt, startedAt: w.startedAt, windowStart: ws?.windowStart, now: ts });
    return {
      key,
      kind: w.kind,
      stale,
      pct: w.pct,
      bgPct: num(ws?.bgPct) + inFlight,
      batchPct: num(ws?.batchPct) + inFlightBatch,
      cap,
      projectedPct,
      resetsAt: finite(w.resetsAt) ? w.resetsAt : null,
      windowStart: finite(w.startedAt) ? w.startedAt : finite(ws?.windowStart) ? ws.windowStart : isWeeklyKind(w.kind) && finite(w.resetsAt) ? w.resetsAt - WEEK_MS : null,
      w,
    };
  }

  const publicWindow = (v) => ({
    key: v.key,
    pct: v.pct,
    bgPct: round2(v.bgPct),
    cap: v.cap,
    resetsAt: v.resetsAt,
    ...(v.projectedPct != null ? { projectedPct: round2(v.projectedPct) } : {}),
  });

  async function planDecision({ snapshot, windows, cls, level, ts }) {
    const refuse = (reason, v, resumesAt, ceiling = false) => ({
      d: { ok: false, mode: "plan", fallback: false, reason, window: publicWindow(v), resumesAt: finite(resumesAt) ? resumesAt : null },
      cap: v.cap,
      ceiling,
    });
    if (level === "off") {
      const first = windows[0] ? await windowView({ snapshot, w: windows[0], level, ts }) : null;
      return { d: { ok: false, mode: "plan", fallback: false, reason: "off", ...(first ? { window: publicWindow(first) } : {}), resumesAt: null }, cap: 0, ceiling: false };
    }
    const views = [];
    for (const w of windows) views.push(await windowView({ snapshot, w, level, ts }));
    const fresh = views.filter((v) => !v.stale);
    // §17.5: within 24 h of a weekly-kind reset the batch ceiling lifts to the full cap.
    const lift = cls === CLASS.BATCH && fresh.some((v) => isWeeklyKind(v.kind) && finite(v.resetsAt) && v.resetsAt > ts && v.resetsAt - ts <= NEAR_RESET_MS);

    if (fresh.length > 0 && snapshot.exhausted === true) {
      const top = fresh.reduce((a, b) => (b.pct > a.pct ? b : a));
      return refuse("exhausted", top, top.resetsAt);
    }
    for (const v of views) {
      if (!v.stale && v.pct >= 100) return refuse("exhausted", v, v.resetsAt);
      if (v.bgPct >= v.cap) return refuse("level-cap", v, v.resetsAt);
      if (cls === CLASS.BATCH && !lift && v.batchPct >= BATCH_SHARE * v.cap) return refuse("level-cap", v, v.resetsAt, true);
      if (v.stale) continue; // a stale reading describes the window that just ended: treated as fresh
      const weekly = isWeeklyKind(v.kind);
      if (!weekly) {
        if (v.pct > WINDOW_BUSY_PCT) return refuse("window-busy", v, v.resetsAt);
        continue;
      }
      const nearEnd = finite(v.resetsAt) && v.resetsAt > ts && v.resetsAt - ts <= NEAR_RESET_MS;
      if (nearEnd) {
        if (v.pct + Math.max(0, v.cap - v.bgPct) > NEAR_RESET_END_PCT) return refuse("projected-high", v, v.resetsAt);
      } else if (v.projectedPct != null) {
        if (v.projectedPct > PROJECTED_HIGH_PCT) {
          const span = finite(v.resetsAt) && finite(v.windowStart) ? v.resetsAt - v.windowStart : null;
          const flatAt = span != null ? v.windowStart + (v.pct / PROJECTED_HIGH_PCT) * span : v.resetsAt;
          return refuse("projected-high", v, finite(v.resetsAt) ? Math.min(v.resetsAt, flatAt) : null);
        }
      } else if (v.pct > WINDOW_BUSY_PCT) {
        return refuse("window-busy", v, v.resetsAt);
      }
    }
    // Allowed: report the window closest to its cap.
    const tight = views.reduce((a, b) => (a && a.bgPct / (a.cap || 1) >= b.bgPct / (b.cap || 1) ? a : b), null);
    return {
      d: { ok: true, mode: "plan", fallback: false, reason: null, ...(tight ? { window: publicWindow(tight) } : {}), resumesAt: null },
      cap: tight?.cap ?? 0,
      ceiling: false,
    };
  }

  async function decide({ workType, model }) {
    const cls = WORK_CLASS[workType];
    if (!cls) {
      const d = unavailable();
      noteRefusal(String(workType), CLASS.CONTINUOUS, d, {});
      return { d, cls: CLASS.CONTINUOUS };
    }
    const cfg = await readConfig();
    await ensureState();
    const ts = now();
    const m = await pickModel(model);
    const bm = billingFor(m, await snapshots());
    const r = bm.mode === "payg"
      ? paygDecision({ cfg, cls, fallback: bm.fallback, ts })
      : await planDecision({ snapshot: bm.snapshot, windows: bm.windows, cls, level: cfg.level, ts });
    if (!r.d.ok) noteRefusal(workType, cls, r.d, { cap: r.cap, ceiling: r.ceiling });
    return { ...r, cls };
  }

  const unavailable = () => ({ ok: false, mode: "payg", fallback: true, reason: "unavailable", resumesAt: null });

  /** May this work start now? Never throws. */
  async function check({ workType, model } = {}) {
    try {
      return (await decide({ workType, model })).d;
    } catch (e) {
      warn("check failed, refusing:", e?.message ?? e);
      const d = unavailable();
      try {
        noteRefusal(String(workType), WORK_CLASS[workType] ?? CLASS.CONTINUOUS, d, {});
      } catch {
        /* evidence only */
      }
      return d;
    }
  }

  // ---- recording (§5.4, §17.4/9) ----

  /** Book what a call really cost. `usage` is the real token usage (or a bare size estimate); `usd` a recorded cost. Never throws. */
  async function record({ workType, model, usage, usd, inLedger } = {}) {
    let m = null;
    let mode = "payg";
    let tokens;
    let cost = 0;
    let priced = true;
    try {
      tokens = normalizeTokens(usage);
      m = await pickModel(model);
      const bm = billingFor(m, await snapshots().catch(() => []));
      mode = bm.mode;
      if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) cost = usd;
      else if (tokens) {
        const prices = await Promise.resolve(getPrices()).catch(() => ({ models: {} }));
        const band = (m && bandOf(m.providerID, m.modelID)) || WORK_BANDS[workType] || null;
        const r = resolveRates({ providerID: m?.providerID, modelID: m?.modelID, band, prices, bandOf });
        cost = priceTokens(tokens, r.rates);
        priced = r.priced;
      }
      const sent = tokens ? tokensSent(tokens) : 0;
      const cls = WORK_CLASS[workType] ?? CLASS.CONTINUOUS;
      const batch = cls === CLASS.BATCH;
      const ts = now();
      const planWindows = bm.mode === "plan" ? bm.windows.map((w) => ({ key: windowKey(bm.snapshot, w), w })) : [];
      const keys = planWindows.map((x) => x.key);
      await mutate((st) => {
        const day = (st.days[localDay(ts)] ??= newDay());
        const w = (day.byWork[workType] ??= { calls: 0, tokens: 0, usd: 0, paygUsd: 0, planUsd: 0 });
        w.calls += 1;
        w.tokens += sent;
        w.usd += cost;
        if (bm.mode === "payg") {
          w.paygUsd += cost;
          day.payg.usd += cost;
          if (batch) day.payg.batchUsd += cost;
          // §17.9: a plan whose snapshot is missing still spent plan quota — attributed at the next good tick.
          if (bm.fallback && bm.adapterId && sent > 0) {
            const fb = (st.fallbackTokens[bm.adapterId] ??= { bg: 0, batch: 0, notInLedger: 0 });
            fb.bg += sent;
            if (batch) fb.batch += sent;
            if (inLedger === false) fb.notInLedger += sent;
          }
        } else {
          w.planUsd += cost;
          day.plan.usd += cost;
          for (const { key: k, w: live } of planWindows) {
            // Spend before the first tick saw the window still counts: the state is created from the live reading.
            // (not from a stale reading: it describes a window that has ended, and a state made from it would
            // close spuriously when the new window appears)
            let ws = st.windows[k];
            if (!ws) {
              if (isStaleWindow(live, ts)) continue;
              ws = st.windows[k] = newWindowState(live, ts);
            }
            ws.bgTokensSinceTick += sent;
            if (batch) ws.batchTokensSinceTick += sent;
            if (inLedger === false) ws.bgNotInLedgerSinceTick += sent;
          }
        }
      });
      emit({ type: "spend", workType, mode, class: cls, fallback: bm.fallback, tokens: sent, usd: cost, key: keys.length ? keys.join(",") : null });
    } catch (e) {
      warn("record failed, dropped:", e?.message ?? e);
    }
    return { usd: cost, priced, mode };
  }

  function usdToday({ workType, mode } = {}) {
    const day = state?.days?.[localDay(now())];
    if (!day) return 0;
    if (!workType) return mode === "payg" ? num(day.payg.usd) : mode === "plan" ? num(day.plan.usd) : num(day.payg.usd) + num(day.plan.usd);
    const w = day.byWork[workType];
    if (!w) return 0;
    return mode === "payg" ? num(w.paygUsd) : mode === "plan" ? num(w.planUsd) : num(w.usd);
  }

  // ---- presence and timing (§8, §17.16/17) ----

  function userAway() {
    try {
      if (typeof userAwayOverride === "function") return userAwayOverride() === true;
      if (desktopState() === "present") return false;
      const last = Number(lastUserPromptAt());
      return !(Number.isFinite(last) && last > 0 && now() - last < USER_ACTIVE_MS);
    } catch {
      return false;
    }
  }

  async function governingWeeklyReset(model) {
    const m = await pickModel(model);
    const bm = billingFor(m, await snapshots());
    if (bm.mode !== "plan") return { mode: bm.mode, resetsAt: null };
    let resetsAt = null;
    for (const w of bm.windows) {
      if (!isWeeklyKind(w.kind) || isStaleWindow(w, now()) || !finite(w.resetsAt)) continue;
      if (resetsAt === null || w.resetsAt < resetsAt) resetsAt = w.resetsAt;
    }
    return { mode: "plan", resetsAt };
  }

  /** The instant a weekly batch job becomes due for `model` (§17.17): `weeklyDueAt` with the governing window resolved. */
  async function dueAt({ model, intervalDueAt } = {}) {
    try {
      const { mode, resetsAt } = await governingWeeklyReset(model);
      return weeklyDueAt({ mode, intervalDueAt, resetsAt });
    } catch {
      return intervalDueAt;
    }
  }

  /**
   * §8: may a DUE batch job start now? Batch work starts only on one of: the user is away (`away`); on a plan a governing
   * weekly window resets within 24 h (`near-reset`); the job has been due for over 48 h (`overdue`). A start is written to
   * the evidence log with the rule that admitted it. A refusal remembers the job as waiting for the Status row.
   */
  async function goodMomentForBatch({ workType, model, dueSince } = {}) {
    try {
      const ts = now();
      const away = userAway();
      const { mode, resetsAt } = await governingWeeklyReset(model);
      const hoursToReset = finite(resetsAt) ? round2((resetsAt - ts) / 3_600_000) : null;
      let rule = null;
      if (away) rule = "away";
      else if (mode === "plan" && finite(resetsAt) && resetsAt > ts && resetsAt - ts <= NEAR_RESET_MS) rule = "near-reset";
      else if (finite(dueSince) && ts - dueSince > OVERDUE_MS) rule = "overdue";
      if (!rule) {
        waiting.set(workType, { dueSince: finite(dueSince) ? dueSince : ts, at: ts });
        return { ok: false, rule: null, reason: "waiting-for-quiet" };
      }
      waiting.delete(workType);
      let pct = null;
      let projectedPct = null;
      try {
        const m = await pickModel(model);
        const bm = billingFor(m, await snapshots());
        const w = bm.windows.filter((x) => isWeeklyKind(x.kind)).sort((a, b) => b.pct - a.pct)[0] ?? bm.windows[0];
        if (w) {
          pct = w.pct;
          const ws = state?.windows?.[windowKey(bm.snapshot, w)];
          projectedPct = projectWeeklyPct({ kind: w.kind, pct: w.pct, resetsAt: w.resetsAt, startedAt: w.startedAt, windowStart: ws?.windowStart, now: ts });
        }
      } catch {
        /* evidence only */
      }
      emit({
        type: "batch-start",
        workType,
        rule,
        desktopState: safeDesktopState(),
        userAway: away,
        hoursToReset,
        pct,
        projectedPct: projectedPct == null ? null : round2(projectedPct),
        dueForH: finite(dueSince) ? round2((ts - dueSince) / 3_600_000) : null,
      });
      return { ok: true, rule, reason: null };
    } catch (e) {
      warn("goodMomentForBatch failed, waiting:", e?.message ?? e);
      return { ok: false, rule: null, reason: "unavailable" };
    }
  }

  function safeDesktopState() {
    try {
      return desktopState();
    } catch {
      return null;
    }
  }

  // ---- tick (§6.2, §17.6-9) ----

  let tickFlight = null;
  /** Attribute the plans' reported usage movement to background work. Runs on a 10-minute poller AND on every `usage.updated`. */
  function tick() {
    tickFlight ??= doTick()
      .catch((e) => warn("tick failed:", e?.message ?? e))
      .finally(() => {
        tickFlight = null;
      });
    return tickFlight;
  }

  async function sumProviders(providerIDs, sinceMs) {
    const totals = await providerTokenTotals({ sinceMs });
    if (!totals || !isObj(totals.byProvider)) return null;
    let sum = 0;
    for (const id of providerIDs) sum += num(totals.byProvider[id]);
    return sum;
  }

  async function doTick() {
    const t = now();
    const cfg = await readConfig().catch(() => readBackgroundWork(null));
    const snaps = (await snapshots()).filter((s) => s.kind !== "credit" && isPlanSnapshot(s));
    const items = [];

    // Phase 1 (under the mutex, no I/O): resets, first sightings, flat/negative moves; collect the windows that moved up.
    await mutate((st) => {
      for (const snap of snaps) {
        const providerIDs = Array.isArray(snap.providerIDs) ? snap.providerIDs : [];
        const pending = st.fallbackTokens[snap.provider];
        for (const w of snap.windows) {
          if (!w || w.active === false || !finite(w.pct)) continue;
          const key = windowKey(snap, w);
          let ws = st.windows[key];
          if (!ws) {
            st.windows[key] = newWindowState(w, t);
            continue;
          }
          ws.seenAt = t;
          if (pending) {
            ws.bgTokensSinceTick += pending.bg;
            ws.batchTokensSinceTick += pending.batch;
            ws.bgNotInLedgerSinceTick += pending.notInLedger;
          }
          // The provider has not published the new window yet — or this reading is the last one reused after its window
          // ended. Either way it carries no news: no reset is detected from it, and it is not attributed.
          if (isStaleWindow(w, t)) continue;
          const storedReset = ws.resetsAt;
          const newReset = w.resetsAt;
          if (!finite(storedReset) && finite(newReset)) {
            st.windows[key] = newWindowState(w, t); // first sighting of a reset instant
            continue;
          }
          // A reset is a NEW window: its reset instant is later than the stored one (it passed and the provider moved
          // on, or it jumped by more than the drift codex shows).
          if (finite(storedReset) && finite(newReset) && newReset > storedReset && (t >= storedReset || newReset - storedReset > RESET_JUMP_MS)) {
            emit({
              type: "window-close",
              key,
              finalPct: ws.lastTick?.pct ?? null,
              bgPct: round2(ws.bgPct),
              batchPct: round2(ws.batchPct),
              cap: levelCap(cfg.level, w.kind),
              hit100At: ws.hit100At ?? null,
            });
            ws.windowStart = finite(w.startedAt) ? w.startedAt : Math.min(storedReset, t);
            ws.resetsAt = newReset;
            ws.bgPct = 0;
            ws.batchPct = 0;
            zeroCounters(ws);
            ws.lastTick = { at: t, pct: w.pct };
            ws.hit100At = w.pct >= 100 ? t : null;
            continue;
          }
          if (finite(newReset)) ws.resetsAt = newReset; // codex drifts by seconds per poll: not a reset
          if (w.pct >= 100 && !ws.hit100At) ws.hit100At = t;
          if (!ws.lastTick) {
            ws.lastTick = { at: t, pct: w.pct };
            continue;
          }
          const dPct = w.pct - ws.lastTick.pct;
          if (dPct === 0) continue; // pct moves in coarse steps: the tokens are attributed when it moves
          if (dPct < 0) {
            // a seat switch of a multi-seat aggregate: rebase, keep what was attributed
            ws.lastTick = { at: t, pct: w.pct };
            zeroCounters(ws);
            continue;
          }
          items.push({
            key,
            providerIDs,
            at: ws.lastTick.at,
            pct: w.pct,
            dPct,
            captured: { bg: ws.bgTokensSinceTick, batch: ws.batchTokensSinceTick, notInLedger: ws.bgNotInLedgerSinceTick },
          });
        }
        if (pending) delete st.fallbackTokens[snap.provider];
      }
      for (const [k, ws] of Object.entries(st.windows)) if (t - num(ws.seenAt) > WINDOW_FORGET_MS) delete st.windows[k];
    });

    // Phase 2 (no mutex): the ledger's token total since each window's last tick.
    for (const it of items) {
      try {
        it.L = await sumProviders(it.providerIDs, it.at);
      } catch (e) {
        warn("reading the ledger failed:", e?.message ?? e);
        it.L = null;
      }
    }

    // Phase 3 (under the mutex): attribute.
    await mutate((st) => {
      for (const it of items) {
        if (it.L == null) continue; // counters carry forward
        const ws = st.windows[it.key];
        if (!ws?.lastTick || ws.lastTick.at !== it.at) continue; // changed meanwhile (a reset)
        const T = it.L + it.captured.notInLedger;
        if (T > 0) {
          ws.bgPct += it.dPct * Math.min(1, it.captured.bg / T);
          ws.batchPct += it.dPct * Math.min(1, it.captured.batch / T);
          if (it.dPct >= 1) ws.tokensPerPct = T / it.dPct;
        }
        emit({
          type: "tick",
          key: it.key,
          dPct: round2(it.dPct),
          T,
          bgTokens: it.captured.bg,
          bgPct: round2(ws.bgPct),
          batchPct: round2(ws.batchPct),
          tokensPerPct: ws.tokensPerPct == null ? null : Math.round(ws.tokensPerPct),
        });
        ws.lastTick = { at: t, pct: it.pct };
        ws.bgTokensSinceTick = Math.max(0, ws.bgTokensSinceTick - it.captured.bg);
        ws.batchTokensSinceTick = Math.max(0, ws.batchTokensSinceTick - it.captured.batch);
        ws.bgNotInLedgerSinceTick = Math.max(0, ws.bgNotInLedgerSinceTick - it.captured.notInLedger);
      }
    });
    flushRefusals(false);
  }

  // ---- status (§10, §17.20) ----

  const pausedOf = (r, cfg) =>
    r.d.ok
      ? null
      : {
          reason: r.d.reason,
          ...(r.d.window?.key ? { windowKey: r.d.window.key } : {}),
          // A batch-ceiling refusal quotes the share larger jobs may use (60 % of the cap), not the whole cap.
          value:
            r.d.reason === "usd-cap"
              ? round2(r.ceiling ? BATCH_SHARE * cfg.dailyCapUsd : cfg.dailyCapUsd)
              : r.d.reason === "level-cap"
                ? r.d.window?.cap != null
                  ? round2(r.ceiling ? BATCH_SHARE * r.d.window.cap : r.d.window.cap)
                  : null
                : r.d.reason === "projected-high"
                  ? r.d.window?.projectedPct ?? r.d.window?.pct ?? null
                  : r.d.window?.pct ?? null,
          resumesAt: r.d.resumesAt ?? null,
        };

  async function status() {
    const cfg = await readConfig();
    await ensureState();
    const ts = now();
    const snaps = await snapshots();
    const defaultModel = await pickModel(null);
    const connected = await Promise.resolve(listConnectedProviders()).catch(() => []);
    const connectedList = Array.isArray(connected) ? connected : [];

    const plans = [];
    const adaptersSeen = new Set();
    for (const snap of snaps) {
      if (snap.kind === "credit" || !isPlanSnapshot(snap)) continue;
      adaptersSeen.add(snap.provider);
      const useModel = defaultModel && adapterForProviderID(defaultModel.providerID) === snap.provider ? defaultModel : null;
      const windows = governing(snap, useModel);
      const views = [];
      for (const w of windows) views.push(await windowView({ snapshot: snap, w, level: cfg.level, ts }));
      const cont = windows.length ? await planDecision({ snapshot: snap, windows, cls: CLASS.CONTINUOUS, level: cfg.level, ts }) : null;
      const bat = windows.length ? await planDecision({ snapshot: snap, windows, cls: CLASS.BATCH, level: cfg.level, ts }) : null;
      plans.push({
        adapter: snap.provider,
        ...(typeof snap.planLabel === "string" ? { planLabel: snap.planLabel } : {}),
        fallback: false,
        windows: views.map((v) => ({
          key: v.key,
          kind: v.kind,
          label: typeof v.w.label === "string" && v.w.label ? v.w.label : v.kind,
          pct: v.pct,
          bgPct: round2(v.bgPct),
          cap: v.cap,
          projectedPct: v.projectedPct == null ? null : round2(v.projectedPct),
          resetsAt: v.resetsAt,
        })),
        paused: cont ? pausedOf(cont, cfg) : null,
        batchPaused: bat ? pausedOf(bat, cfg) : null,
      });
    }

    const paygProviders = [];
    let paygPausedR = null;
    let paygBatchR = null;
    const paygDecisionFor = (cls, fallback) => paygDecision({ cfg, cls, fallback, ts });
    for (const pid of connectedList) {
      const adapter = adapterForProviderID(pid) ?? null;
      if (!adapter) {
        paygProviders.push(pid);
        continue;
      }
      if (adaptersSeen.has(adapter)) continue;
      const snap = snaps.find((s) => s.provider === adapter);
      if (snap && snap.kind === "credit") {
        paygProviders.push(pid);
        continue;
      }
      if (!snap) {
        // A plan provider whose usage can't be read: the dollar cap governs (§4.3).
        adaptersSeen.add(adapter);
        const c = paygDecisionFor(CLASS.CONTINUOUS, true);
        const b = paygDecisionFor(CLASS.BATCH, true);
        plans.push({ adapter, fallback: true, windows: [], paused: pausedOf(c, cfg), batchPaused: pausedOf(b, cfg) });
      }
    }
    paygPausedR = paygDecisionFor(CLASS.CONTINUOUS, false);
    paygBatchR = paygDecisionFor(CLASS.BATCH, false);

    const day = state.days[localDay(ts)] ?? newDay();
    const monthPrefix = localDay(ts).slice(0, 7);
    let usdMonth = 0;
    for (const [k, v] of Object.entries(state.days)) if (k.startsWith(monthPrefix)) usdMonth += num(v?.payg?.usd);

    const waitingBatch = [];
    for (const [workType, w] of waiting) {
      if (ts - w.at > WAITING_BATCH_TTL_MS) waiting.delete(workType);
      else waitingBatch.push({ workType, dueSince: w.dueSince });
    }

    return {
      level: cfg.level,
      dailyCapUsd: cfg.dailyCapUsd,
      payg: {
        providers: paygProviders,
        usdToday: round2(num(day.payg.usd)),
        usdMonth: round2(usdMonth),
        paused: pausedOf(paygPausedR, cfg),
        batchPaused: pausedOf(paygBatchR, cfg),
      },
      plans,
      waitingBatch,
      byWork: Object.entries(day.byWork).map(([workType, w]) => ({ workType, calls: w.calls, usd: round2(num(w.usd)), tokens: w.tokens })),
    };
  }

  // Load eagerly so `usdToday` (synchronous) answers from the first call after boot.
  void ensureState().catch((e) => warn("loading the budget state failed:", e?.message ?? e));

  return {
    check,
    record,
    goodMomentForBatch,
    dueAt,
    tick,
    status,
    usdToday,
    flushEvidence: () => flushRefusals(true),
  };
}
