// usageCalibration.mjs — how many full 5h windows a weekly window holds ("K"),
// measured from paired readings (spec 2026-11-03-seat-placement-weekly-deadline
// §5.4 / §6).
//
// Identifiable from readings alone: when a seat's 5h window rises by ΔS points
// while its weekly rises by ΔL points, one weekly point is worth ΔS/ΔL 5h
// points. It is NOT estimated from usage-history.json (that store keeps {ts,
// pct} at >= 15 min with no resetsAt / stale, so its intervals cannot be
// validated) — this module never reads it. K gets its own paired series,
// appended from the usage poller's `onPolled` hook, which fires after every
// successful tick.
//
// Only the `weekly` kind is ever fitted. A model cap (`weekly_scoped:*`) cannot
// be identified from mixed traffic (Opus traffic moves the 5h window without
// moving a Fable cap), so it resolves to 0.5 · K_weekly.
//
// Pure estimator (`estimateK`) + a service with injected I/O (load/save for the
// calibration store, loadSamples/saveSamples for the sample series, `now`, and
// `timers` for the debounced save). Production paths come from `statePath`
// (MANTA_STATE_HOME sandbox in tests).

import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

const MIN_MS = 60_000;
const MIN_SAMPLE_GAP_MS = MIN_MS; // a burst of ticks (a failed fetch replayed, a manual refresh) adds one observation
const DAY_MS = 86_400_000;

export const SAMPLES_RETENTION_DAYS = 14;
export const SAMPLES_SAVE_DEBOUNCE_MS = 30_000;
export const ESTIMATE_EVERY_MS = 60 * MIN_MS;
export const STORE_MEMO_MS = 60_000;
/** An interval longer than this is not "the same moment" for both windows. */
export const MAX_INTERVAL_MS = 20 * MIN_MS;
/** resetsAt readings of one window can differ by a few ms across polls; a real reset moves them by hours. */
export const RESET_JITTER_MS = 60_000;
export const MIN_LONG_POINTS = 20;
export const MIN_SEATS = 3;
export const MAX_SPREAD = 0.2;
export const DEFAULT_WEEKLY_K = 7.5;
export const SCOPED_CAP_FACTOR = 0.5;
export const WEEKLY_KIND = "weekly";
const SESSION_KIND = "session";
const STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const finite = (n) => typeof n === "number" && Number.isFinite(n);

/** Median of finite numbers (does not mutate). Null for an empty list. */
export function median(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const s = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated quantile `q` ∈ [0,1] of a list. Null for an empty list. */
export function quantile(numbers, q) {
  if (!Array.isArray(numbers) || numbers.length === 0) return null;
  const s = [...numbers].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * One paired observation from a seat snapshot, or null when the seat does not
 * report both a 5h (`session`) window and a `weekly` window (nothing to pair).
 * Roles are fixed by kind. Model caps are not stored — they are never fitted.
 * `stale` is recorded only when true and `resetsAt` only when known (compact).
 */
export function sampleFromSnapshot(snap) {
  if (!snap || !finite(snap.fetchedAt) || !Array.isArray(snap.windows)) return null;
  const pack = (w) => ({
    pct: w.pct,
    ...(finite(w.resetsAt) ? { resetsAt: w.resetsAt } : {}),
    ...(w.stale === true ? { stale: true } : {}),
  });
  const usable = (w) => w && w.active !== false && finite(w.pct);
  const short = snap.windows.find((w) => w?.kind === SESSION_KIND && usable(w));
  const long = snap.windows.filter((w) => w?.kind === WEEKLY_KIND && usable(w));
  if (!short || long.length === 0) return null;
  return { t: snap.fetchedAt, short: pack(short), long: long.map((w) => ({ kind: w.kind, ...pack(w) })) };
}

const sameReset = (a, b) => {
  const ha = finite(a);
  const hb = finite(b);
  if (!ha && !hb) return true;
  if (ha !== hb) return false;
  return Math.abs(a - b) <= RESET_JITTER_MS;
};

const weeklyOf = (o) => (Array.isArray(o?.long) ? o.long.find((l) => l?.kind === WEEKLY_KIND) ?? null : null);

/** {ds, dl} for a qualifying interval, null otherwise. */
function qualifyingInterval(a, b) {
  const sa = a.short;
  const sb = b.short;
  const la = weeklyOf(a);
  const lb = weeklyOf(b);
  if (!sa || !sb || !la || !lb) return null;
  if (sa.stale || sb.stale || la.stale || lb.stale) return null;
  const dt = b.t - a.t;
  if (!(dt > 0) || dt > MAX_INTERVAL_MS) return null;
  if (!sameReset(sa.resetsAt, sb.resetsAt) || !sameReset(la.resetsAt, lb.resetsAt)) return null;
  if (!finite(sa.pct) || !finite(sb.pct) || !finite(la.pct) || !finite(lb.pct)) return null;
  const ds = sb.pct - sa.pct;
  const dl = lb.pct - la.pct;
  if (ds < 0 || dl < 0) return null;
  return { ds, dl };
}

function seatRatio(observations, cutoffMs) {
  const obs = observations.filter((o) => o && finite(o.t) && o.t >= cutoffMs).sort((a, b) => a.t - b.t);
  let sumShort = 0;
  let sumLong = 0;
  let intervals = 0;
  let runs = 0;
  let runShort = 0;
  let runLong = 0;
  let runIntervals = 0;
  // A zero-Δlong interval stays inside its run: with rounded percentages the
  // weekly often lags the 5h by several intervals, and dropping those would
  // bias K low. A run only counts once its weekly actually moved.
  const flush = () => {
    if (runLong >= 1) {
      sumShort += runShort;
      sumLong += runLong;
      intervals += runIntervals;
      runs += 1;
    }
    runShort = 0;
    runLong = 0;
    runIntervals = 0;
  };
  for (let i = 1; i < obs.length; i++) {
    const q = qualifyingInterval(obs[i - 1], obs[i]);
    if (!q) {
      flush();
      continue;
    }
    runShort += q.ds;
    runLong += q.dl;
    runIntervals += 1;
  }
  flush();
  return { k: sumLong >= MIN_LONG_POINTS ? sumShort / sumLong : null, sumShort, sumLong, intervals, runs };
}

/**
 * K for the `weekly` kind, per provider, from paired observations. Pure.
 *
 * @param {{seats?: Record<string, object[]>} | Record<string, object[]>} samples
 *   the samples store (`{version, seats}`) or its `seats` map, keyed `<provider>:<seatId>`
 * @param {{nowMs: number, windowDays?: number}} opts
 * @returns {Record<string, {value: number|null, samples: number, seats: number,
 *   spread: number|null, perSeat: Record<string, {k:number|null, sumShort:number, sumLong:number, intervals:number, runs:number}>}>}
 */
export function estimateK(samples, { nowMs, windowDays = SAMPLES_RETENTION_DAYS } = {}) {
  const seatsMap = samples && typeof samples === "object" && samples.seats && typeof samples.seats === "object" ? samples.seats : samples ?? {};
  const cutoff = nowMs - windowDays * DAY_MS;
  const perProvider = new Map();
  for (const [key, observations] of Object.entries(seatsMap)) {
    if (!Array.isArray(observations)) continue;
    const at = key.indexOf(":");
    if (at <= 0) continue;
    const provider = key.slice(0, at);
    if (!perProvider.has(provider)) perProvider.set(provider, {});
    perProvider.get(provider)[key.slice(at + 1)] = seatRatio(observations, cutoff);
  }
  const out = {};
  for (const [provider, perSeat] of perProvider) {
    const ks = Object.values(perSeat)
      .map((s) => s.k)
      .filter((k) => k !== null);
    const med = median(ks);
    const spread = ks.length >= MIN_SEATS && med > 0 ? (quantile(ks, 0.9) - quantile(ks, 0.1)) / med : null;
    const ok = ks.length >= MIN_SEATS && med > 0 && spread !== null && spread <= MAX_SPREAD;
    out[provider] = {
      value: ok ? med : null,
      samples: Object.values(perSeat).reduce((n, s) => n + (s.k !== null ? s.intervals : 0), 0),
      seats: ks.length,
      spread,
      perSeat,
    };
  }
  return out;
}

/** Defensive: whatever is on disk becomes a well-formed calibration store. */
export function normalizeStore(raw) {
  const out = { version: STORE_VERSION, providers: {} };
  const src = raw && typeof raw === "object" ? raw.providers : null;
  if (!src || typeof src !== "object") return out;
  for (const [id, p] of Object.entries(src)) {
    if (!id || !p || typeof p !== "object") continue;
    const kByKind = {};
    for (const [kind, k] of Object.entries(p.kByKind ?? {})) {
      if (k && finite(k.value) && k.value > 0) {
        kByKind[kind] = {
          value: k.value,
          samples: finite(k.samples) ? k.samples : 0,
          seats: finite(k.seats) ? k.seats : 0,
          updatedAt: finite(k.updatedAt) ? k.updatedAt : 0,
        };
      }
    }
    out.providers[id] = {
      kByKind,
      defaults: Object.fromEntries(Object.entries(isObject(p.defaults) ? p.defaults : {}).filter(([, v]) => finite(v) && v > 0)),
      ...(finite(p.spread) ? { spread: p.spread } : {}),
      ...(finite(p.samples) ? { samples: p.samples } : {}),
    };
  }
  return out;
}

const emptySamples = () => ({ version: STORE_VERSION, seats: {} });

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
/** A stored observation the estimator can read: a time, a `short` object and a `long` array of objects. */
const isObservation = (o) => isObject(o) && finite(o.t) && isObject(o.short) && Array.isArray(o.long) && o.long.every(isObject);

function normalizeSamples(raw) {
  const out = emptySamples();
  const src = raw && typeof raw === "object" ? raw.seats : null;
  if (!src || typeof src !== "object") return out;
  for (const [key, arr] of Object.entries(src)) {
    if (Array.isArray(arr) && key.includes(":")) out.seats[key] = arr.filter(isObservation);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @param {object} [deps]
 * @param {() => object|null} [deps.load]   sync read of the calibration store
 * @param {(store: object) => Promise<void>} [deps.save]
 * @param {() => object|null} [deps.loadSamples]  sync read of the samples store
 * @param {(samples: object) => Promise<void>} [deps.saveSamples]
 * @param {() => number} [deps.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers]  the debounced samples save
 * @param {{warn: Function}} [deps.log]
 * @param {Record<string, number>} [deps.defaults]  Claude defaults (spec §2.1: weekly 7.5)
 * @param {(() => object)|null} [deps.queueStats]  extra diagnostics merged into `snapshot()` (the attribution writer's counters)
 */
export function createUsageCalibration({
  load = () => readJsonSync(statePath("usage-calibration.json"), null),
  save = (store) => writeJsonAtomic(statePath("usage-calibration.json"), JSON.stringify(store, null, 2), { mode: 0o600 }),
  loadSamples = () => readJsonSync(statePath("usage-calibration-samples.json"), null),
  saveSamples = (samples) => writeJsonAtomic(statePath("usage-calibration-samples.json"), JSON.stringify(samples), { mode: 0o600 }),
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  log = console,
  defaults = { weekly: DEFAULT_WEEKLY_K },
  queueStats = null,
} = {}) {
  let store = null;
  let storeLoadedAt = 0;
  let samples = null;
  let saveTimer = null;
  let lastEstimateAt = null;
  // Providers seen reporting a weekly window: they get the weekly default too.
  const weeklyProviders = new Set();

  const getStore = () => {
    const t = now();
    if (store === null || t - storeLoadedAt >= STORE_MEMO_MS) {
      store = normalizeStore(load());
      storeLoadedAt = t;
    }
    return store;
  };
  const getSamples = () => {
    if (samples === null) {
      samples = normalizeSamples(loadSamples());
      for (const key of Object.keys(samples.seats)) {
        const at = key.indexOf(":");
        if (at > 0 && samples.seats[key].some((o) => weeklyOf(o))) weeklyProviders.add(key.slice(0, at));
      }
    }
    return samples;
  };

  const defaultsFor = (provider) => (provider === "claude" ? { ...defaults } : weeklyProviders.has(provider) ? { weekly: defaults.weekly ?? DEFAULT_WEEKLY_K } : {});

  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = timers.setTimeout(() => {
      saveTimer = null;
      if (samples === null) return;
      Promise.resolve(saveSamples(samples)).catch((e) => log.warn?.("[usage] calibration samples save failed:", e?.message ?? e));
    }, SAMPLES_SAVE_DEBOUNCE_MS);
    saveTimer?.unref?.();
  };

  /** Drop every seat's observations older than the retention window, and the keys that end up empty (a removed seat). */
  const pruneSamples = (t) => {
    const s = getSamples();
    const cutoff = t - SAMPLES_RETENTION_DAYS * DAY_MS;
    let changed = false;
    for (const [key, list] of Object.entries(s.seats)) {
      const keep = list.filter((o) => o.t >= cutoff);
      if (keep.length === list.length) continue;
      changed = true;
      if (keep.length === 0) delete s.seats[key];
      else s.seats[key] = keep;
    }
    if (changed) scheduleSave();
  };

  const fingerprint = (value, spread) => JSON.stringify([value === null ? null : Math.round(value * 1000), spread === null ? null : Math.round(spread * 1000)]);

  function estimate() {
    const t = now();
    pruneSamples(t);
    const result = estimateK(getSamples(), { nowMs: t });
    const current = getStore();
    const providers = { ...current.providers };
    let changed = false;
    for (const [provider, est] of Object.entries(result)) {
      const stored = providers[provider];
      // Write only when the value or the guards changed, not on every hourly run.
      const storedFp = fingerprint(stored?.kByKind?.[WEEKLY_KIND]?.value ?? null, stored?.spread ?? null);
      if (storedFp === fingerprint(est.value, est.spread)) continue;
      const kByKind = { ...(stored?.kByKind ?? {}) };
      if (est.value !== null) kByKind[WEEKLY_KIND] = { value: est.value, samples: est.samples, seats: est.seats, updatedAt: t };
      else delete kByKind[WEEKLY_KIND];
      providers[provider] = {
        kByKind,
        defaults: defaultsFor(provider),
        ...(est.spread !== null ? { spread: est.spread } : {}),
        samples: est.samples,
      };
      changed = true;
    }
    lastEstimateAt = t;
    if (changed) {
      const next = { version: STORE_VERSION, providers };
      store = next;
      storeLoadedAt = t;
      Promise.resolve(save(next)).catch((e) => log.warn?.("[usage] calibration save failed:", e?.message ?? e));
    }
    return result;
  }

  return {
    /**
     * Feed one successful poll's per-seat snapshots. Appends a paired
     * observation per seat (skipping a seat that already has this reading),
     * prunes to 14 days, schedules the debounced save, and runs the estimate at
     * most once an hour (and on the first call after boot).
     */
    onPolled(seatSnapshots) {
      if (!Array.isArray(seatSnapshots)) return;
      const s = getSamples();
      let added = false;
      for (const snap of seatSnapshots) {
        if (!snap?.provider || !snap?.seatId) continue;
        const obs = sampleFromSnapshot(snap);
        if (!obs) continue;
        const key = `${snap.provider}:${snap.seatId}`;
        const list = (s.seats[key] ??= []);
        // A burst keeps its FIRST reading; safe, because an interval that crosses a reset or a stale reading is rejected anyway.
        if (list.length > 0 && obs.t - list[list.length - 1].t < MIN_SAMPLE_GAP_MS) continue;
        list.push(obs);
        weeklyProviders.add(snap.provider);
        const cutoff = obs.t - SAMPLES_RETENTION_DAYS * DAY_MS;
        let drop = 0;
        while (drop < list.length && list[drop].t < cutoff) drop++;
        if (drop > 0) list.splice(0, drop);
        added = true;
      }
      if (added) scheduleSave();
      const t = now();
      if (lastEstimateAt === null || t - lastEstimateAt >= ESTIMATE_EVERY_MS) {
        try {
          estimate();
        } catch (e) {
          lastEstimateAt = t;
          log.warn?.("[usage] calibration estimate failed:", e?.message ?? e);
        }
      }
    },
    estimate,
    /**
     * A provider-bound reader `kind → number|null`: the measured value when its
     * guards passed, else the default; `weekly_scoped:*` = 0.5 · K_weekly.
     */
    readerFor(provider) {
      return (kind) => {
        const p = getStore().providers[provider];
        const defs = { ...defaultsFor(provider), ...(p?.defaults ?? {}) };
        const weekly = p?.kByKind?.[WEEKLY_KIND]?.value ?? defs[WEEKLY_KIND] ?? null;
        if (kind === WEEKLY_KIND) return weekly;
        if (typeof kind === "string" && kind.startsWith("weekly_scoped")) {
          const measured = p?.kByKind?.[kind]?.value;
          if (finite(measured)) return measured;
          return weekly === null ? null : SCOPED_CAP_FACTOR * weekly;
        }
        const other = p?.kByKind?.[kind]?.value ?? defs[kind];
        return finite(other) ? other : null;
      };
    },
    /** `usage:calibration` payload. */
    snapshot() {
      const st = getStore();
      const ids = new Set(["claude", ...Object.keys(st.providers), ...weeklyProviders]);
      const providers = {};
      for (const id of ids) {
        const p = st.providers[id];
        providers[id] = {
          kByKind: { ...(p?.kByKind ?? {}) },
          defaults: { ...defaultsFor(id), ...(p?.defaults ?? {}) },
          spread: p?.spread ?? null,
          samples: p?.samples ?? 0,
        };
      }
      const extra = typeof queueStats === "function" ? queueStats() : null;
      return { providers, ...(extra ? { queueStats: extra } : {}) };
    },
  };
}
