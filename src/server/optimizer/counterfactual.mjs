// optimizer/counterfactual.mjs — the OBSERVE-ONLY masking counterfactual store
// (Optimizer P1.3, BET-1335; additive token-turn buckets BET-1368).
//
// What the manta-optimizer opencode plugin reports (POST
// /api/optimizer/counterfactual) is not spend — it is the "what manta WOULD
// trim" counterfactual: for a session's current message history, how many
// tokens/parts the masking policy would drop. The plugin is read + report
// only; it never mutates the message history. This module stores those
// reports so the dashboard's "raw vs optimized" graph has a real second line
// before any actuation exists.
//
// Semantics (BET-1368): a report is ADDITIVE token-turns. A tool output masked
// at turn 5 stays out of the prompt for turns 6, 7, 8…; every one of those
// turns you avoid paying to send it again. Each plugin report is exactly one
// turn's worth of that, so each report is added into its bucket (keyed off the
// report's own ts, not the clock). `days`/`hours` store, per local day/hour,
// the summed maskedTokens token-turns (plus the applied/rewarm subsets and the
// per-model split). The `sessions` map keeps its REPLACE semantics (each
// report replaces the session's latest values) because it backs `bySession` /
// savedPct, not the dollar figure.
//
// Split strictly into pure/store (createCounterfactualStore — injected I/O)
// and PURE validators + bucketSeries/summaryFields. No real state dir is
// touched unless index.mjs wires a load/save; tests inject in-memory load/save.

import { statePath } from "../../shared/paths.mjs";
import { dayKey, hourKey, bucketKeyToMs, recentBucketKeys } from "../../shared/timeBuckets.mjs";

// Persistence file for the store (wired by index.mjs via the shared
// jsonStore atomic writer — see the hygiene note there). New store, new file:
// `statePath()` keeps it sandboxed under the test seam.
export const COUNTERFACTUAL_PATH = statePath("optimizer-counterfactual.json");

export const MAX_SESSIONS = 500;
export const RETAIN_DAYS = 90;
export const RETAIN_HOURS = 72;
export const SUMMARY_DAYS = 30;
export const STATE_VERSION = 2;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// A report timestamp in the future, or older than the day retention, is
// clamped to `now` so a delayed/garbage ts can't create an unbounded bucket or
// a runaway future entry.
function clampTs(ts, now) {
  const t = num(ts);
  const n = num(now);
  if (t > n) return n;
  if (n - t > RETAIN_DAYS * DAY_MS) return n;
  return t;
}

// "providerID/modelID" when BOTH are non-empty strings, else the literal
// "unknown" — the store keys on what the report carries, never fabrication.
function modelKey(report) {
  const p = report.providerID;
  const m = report.modelID;
  return typeof p === "string" && p.length > 0 && typeof m === "string" && m.length > 0
    ? `${p}/${m}`
    : "unknown";
}

// v2 buckets are ADDITIVE token-turns. Adds one report into the bucket at
// `key` (creating an empty bucket on first report). Defensive about a partial
// or legacy bucket shape that lacks some of the v2 fields — each accumulates
// from 0.
function addToBucket(bucketMap, key, report) {
  const b = bucketMap[key] ?? {};
  b.maskedTokens = (b.maskedTokens ?? 0) + num(report.maskedTokens);
  b.appliedTokens = (b.appliedTokens ?? 0) + (report.applied === true ? num(report.maskedTokens) : 0);
  b.rewarmTokens = (b.rewarmTokens ?? 0) + num(report.rewarmTokens);
  b.reports = (b.reports ?? 0) + 1;
  if (!b.byModel || typeof b.byModel !== "object") b.byModel = {};
  const mk = modelKey(report);
  b.byModel[mk] = (b.byModel[mk] ?? 0) + num(report.maskedTokens);
  bucketMap[key] = b;
}

// v2 normalize. Buckets became additive token-turns in BET-1368, so the OLD
// snapshot-semantics buckets are dropped (summing two meanings is worse than a
// gap) while the sessions map is kept (its replace semantics are unchanged).
// `version` is always persisted.
function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const isV2 = s.version === STATE_VERSION;
  return {
    version: STATE_VERSION,
    days: isV2 && s.days && typeof s.days === "object" ? s.days : {},
    hours: isV2 && s.hours && typeof s.hours === "object" ? s.hours : {},
    sessions: s.sessions && typeof s.sessions === "object" ? s.sessions : {},
  };
}

/**
 * PURE. Validates a counterfactual report. Returns `null` when valid, else an
 * error string naming the offending field. Shared by the store's `record` and
 * the `/api/optimizer/counterfactual` route (so the route stays ~5 lines):
 *   sessionID — non-empty string, ≤128 chars
 *   maskedTokens / maskedParts / ts — finite numbers ≥ 0
 *   applied — optional boolean (BET-1344: whether the mutation was performed)
 *   mode — optional "observe" | "act" (BET-1344). Both are OPTIONAL so a
 *     not-yet-updated observe-only plugin still validates.
 *   providerID / modelID — optional; non-empty strings ≤128 chars when present
 *     (BET-1368: model attribution).
 *   rewarmTokens — optional; finite number ≥ 0 when present (BET-1368: cache
 *     re-warm cost caused).
 *   All BET-1368 fields are OPTIONAL and the store must behave correctly with
 *     all three absent — that is the normal case until the plugin propagates.
 */
export function validateCounterfactualReport(report) {
  const r = report ?? {};
  if (
    typeof r.sessionID !== "string" ||
    r.sessionID.length === 0 ||
    r.sessionID.length > 128
  ) {
    return "sessionID";
  }
  for (const k of ["maskedTokens", "maskedParts", "ts"]) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return k;
  }
  if (r.applied !== undefined && typeof r.applied !== "boolean") return "applied";
  if (r.mode !== undefined && r.mode !== "observe" && r.mode !== "act") return "mode";
  if (
    r.providerID !== undefined &&
    (typeof r.providerID !== "string" || r.providerID.length === 0 || r.providerID.length > 128)
  ) {
    return "providerID";
  }
  if (
    r.modelID !== undefined &&
    (typeof r.modelID !== "string" || r.modelID.length === 0 || r.modelID.length > 128)
  ) {
    return "modelID";
  }
  if (
    r.rewarmTokens !== undefined &&
    (typeof r.rewarmTokens !== "number" || !Number.isFinite(r.rewarmTokens) || r.rewarmTokens < 0)
  ) {
    return "rewarmTokens";
  }
  return null;
}

// Evict sessions beyond MAX_SESSIONS, oldest `lastTs` first.
function capSessions(sessions) {
  const keys = Object.keys(sessions);
  if (keys.length <= MAX_SESSIONS) return;
  const withTs = keys
    .filter((k) => typeof sessions[k]?.lastTs === "number")
    .sort((a, b) => sessions[a].lastTs - sessions[b].lastTs);
  let n = keys.length;
  for (const k of withTs) {
    if (n <= MAX_SESSIONS) break;
    delete sessions[k];
    n--;
  }
  // Sessions with no numeric lastTs (shouldn't happen after normalize + record,
  // but be safe) are evicted last, arbitrarily, until under the cap.
  if (Object.keys(sessions).length > MAX_SESSIONS) {
    for (const k of Object.keys(sessions)) {
      if (Object.keys(sessions).length <= MAX_SESSIONS) break;
      delete sessions[k];
    }
  }
}

/**
 * The counterfactual store. Injected I/O: `load()` returns the persisted
 * `{version, days, hours, sessions}` (or {}), `save(state)` persists it
 * atomically, `now` is the clock (number or zero-arg fn, for tests). Pure
 * logic — no fs access unless the injected load/save touch it.
 *
 * Returns { record, snapshot }:
 *   record({sessionID, maskedTokens, maskedParts, ts, ...}) → {ok, error?}.
 *   Validates; ADDITIVELY writes the report's token-turns into its day and
 *   hour buckets (keyed off report.ts, clamped); replaces the session's
 *   latest values; prunes old day/hour buckets; caps sessions; persists.
 *   snapshot() → the current state ({version, days, hours, sessions}),
 *   loading from load() on first access. Backs bucketSeries / summaryFields.
 */
export function createCounterfactualStore({ load, save, now }) {
  let state = null;
  const nowMs = () => (typeof now === "function" ? num(now()) : num(now ?? Date.now()));

  async function ensureLoaded() {
    if (!state) state = normalizeState(await load());
    return state;
  }

  async function record(report) {
    const err = validateCounterfactualReport(report);
    if (err) return { ok: false, error: err };
    const s = await ensureLoaded();
    // Bucketing keys off the report's own timestamp (clamped to now when in
    // the future or beyond day retention) — NOT the injected clock — so a
    // delayed report lands in the bucket its turn actually belonged to.
    const ts = clampTs(report.ts, nowMs());
    // REPLACE the session's latest counterfactual (each report is the full
    // would-mask for that session's current history; the sessions map backs
    // bySession / savedPct, whose replace semantics are correct for that use).
    const session = {
      maskedTokens: num(report.maskedTokens),
      maskedParts: num(report.maskedParts),
      lastTs: ts,
    };
    // BET-1344: keep the actuation telemetry when supplied (both optional, so
    // an observe-only plugin's report still merges cleanly).
    if (report.applied !== undefined) session.applied = report.applied;
    if (report.mode !== undefined) session.mode = report.mode;
    s.sessions[report.sessionID] = session;
    capSessions(s.sessions);
    // Add the report into its buckets (both sizes, one write path).
    addToBucket(s.days, dayKey(ts), report);
    addToBucket(s.hours, hourKey(ts), report);
    // Retention: drop entries older than RETAIN_DAYS / RETAIN_HOURS (keys
    // compare lexicographically). RETAIN_HOURS = 72 is a hard bound of 72 keys;
    // this file is rewritten atomically on every report, so it must not grow.
    const dayCutoff = dayKey(ts - RETAIN_DAYS * DAY_MS);
    for (const k of Object.keys(s.days)) {
      if (k < dayCutoff) delete s.days[k];
    }
    const hourCutoff = hourKey(ts - RETAIN_HOURS * HOUR_MS);
    for (const k of Object.keys(s.hours)) {
      if (k < hourCutoff) delete s.hours[k];
    }
    await save(s);
    return { ok: true };
  }

  async function snapshot() {
    return ensureLoaded();
  }

  return { record, snapshot };
}

/**
 * PURE(over the store's snapshot). The `count` most recent buckets of size
 * `bucket` ("day" | "hour"), oldest→newest, ZERO-FILLED where nothing was
 * reported. Each entry:
 *   { key, t, maskedTokens, appliedTokens, rewarmTokens, byModel }.
 * `t` is the epoch ms at the START of the local bucket, from bucketKeyToMs.
 * The single series-building path — summaryFields is implemented on top of it.
 */
export async function bucketSeries(store, { bucket = "day", count, now = Date.now() } = {}) {
  const s = await store.snapshot();
  const n = Math.max(1, Math.floor(num(count)) || 1);
  const t = typeof now === "function" ? num(now()) : num(now ?? Date.now());
  const map = bucket === "hour" ? s.hours ?? {} : s.days ?? {};
  return recentBucketKeys(bucket, n, t).map((key) => {
    const b = map[key];
    return {
      key,
      t: bucketKeyToMs(key),
      maskedTokens: b ? num(b.maskedTokens) : 0,
      appliedTokens: b ? num(b.appliedTokens) : 0,
      rewarmTokens: b ? num(b.rewarmTokens) : 0,
      byModel: b && b.byModel && typeof b.byModel === "object" ? b.byModel : {},
    };
  });
}

/**
 * PURE(over the store's snapshot). Shape consumed by buildOptimizerSummary:
 *   dailySeries: [{day, maskedTokens}] — `days` days, oldest→newest,
 *     ZERO-FILLED for days with no counterfactual report. Derived by mapping
 *     bucketSeries({bucket:"day"}).
 *   bySession: {[sessionID]: {maskedTokens}} — each session's latest
 *     maskedTokens. `savedPct` is NOT computed here: it needs tokensSent,
 *     which only summary.mjs has (it computes it against its own bySession).
 */
export async function summaryFields(store, { days = SUMMARY_DAYS, now = Date.now() } = {}) {
  const series = await bucketSeries(store, { bucket: "day", count: days, now });
  const s = await store.snapshot();
  const bySession = {};
  for (const [id, sd] of Object.entries(s.sessions ?? {})) {
    if (sd && typeof sd.maskedTokens === "number") {
      bySession[id] = { maskedTokens: sd.maskedTokens };
    }
  }
  return { dailySeries: series.map((e) => ({ day: e.key, maskedTokens: e.maskedTokens })), bySession };
}
