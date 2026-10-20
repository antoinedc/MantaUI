// optimizer/counterfactual.mjs — the optimizer's trim-report store (Optimizer
// P1.3 BET-1335 → additive token-turns BET-1368 → v3 sticky trims, priced per
// model, spec 2026-10-20 §5).
//
// What the manta-optimizer opencode plugin reports (POST
// /api/optimizer/counterfactual) is one report PER REQUEST (spec §5.1, C2):
//   applied — net tokens ACTUALLY removed from that request (the real trims the
//             plugin replayed/applied), independent of policy mode.
//   shadow  — what trimming WOULD have removed (simulated, never sent) — the
//             "potential" while the switch is off.
//   change / shadowChange — whether the trim set grew/cleared on this request.
//   rewarmTokens / shadowRewarmTokens — the cache re-write the (real/simulated)
//             growth or clear caused (0 unless that request changed the set).
//   rates — the exact $/Mtok the plugin's gate used for this request.
//
// Semantics: a report is ADDITIVE token-turns. Each report is added into its
// day and hour bucket (keyed off the report's own ts). ACTUAL and POTENTIAL are
// kept in separate halves and are NEVER pooled. Each report is PRICED AT INGEST
// with its own `rates` and the dollar figure is stored — later windows only sum
// stored dollars, so a price change can never rewrite history:
//
//     usd = trimmed × r − rewarm × (w − r)        ($/Mtok × tokens / 1e6)
//
// A report with no usable `rates` (or no model) adds its tokens but no dollars
// and counts as UNPRICED; the unpriced share is reported, never imputed. A
// cost-only report (trimmed 0, rewarm > 0) is therefore NEGATIVE — a re-cache
// that has not paid back yet is a real cost.
//
// A report with NO `v` is the pre-v3 shape (an old plugin during rollout): it is
// accepted with 200 and IGNORED. v2 buckets and the legacy sessions map are
// dropped on load (summing two meanings is worse than a gap).
//
// Split strictly into pure/store (createCounterfactualStore — injected I/O) and
// PURE validators + bucketSeries/summaryFields. No real state dir is touched
// unless index.mjs wires a load/save; tests inject in-memory load/save.

import { statePath } from "../../shared/paths.mjs";
import { dayKey, hourKey, bucketKeyToMs, recentBucketKeys } from "../../shared/timeBuckets.mjs";
import { reportUsd } from "../../shared/optimizerSavings.mjs";

// Persistence file for the store (wired by index.mjs via the shared
// jsonStore atomic writer — see the hygiene note there). New store, new file:
// `statePath()` keeps it sandboxed under the test seam.
export const COUNTERFACTUAL_PATH = statePath("optimizer-counterfactual.json");

export const MAX_SESSIONS = 500;
export const RETAIN_DAYS = 90;
export const RETAIN_HOURS = 72;
export const SUMMARY_DAYS = 30;
export const STATE_VERSION = 3;
export const REPORT_VERSION = 3;

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

const emptyEntry = () => ({ trimmed: 0, rewarm: 0, usd: 0, pricedReports: 0, unpricedReports: 0 });

// Add one side (actual | potential) of a report into a bucket's half. A report
// with nothing to price (trimmed 0 AND rewarm 0) is exactly $0 whatever the
// rates, so it counts as priced — idle requests must not dilute the priced
// share when no price is known.
function addSide(half, mk, { trimmed, rewarm }, rates, modelKnown) {
  if (!half.byModel || typeof half.byModel !== "object") half.byModel = {};
  const e = (half.byModel[mk] ??= emptyEntry());
  e.trimmed = num(e.trimmed) + trimmed;
  e.rewarm = num(e.rewarm) + rewarm;
  const usd = trimmed === 0 && rewarm === 0 ? 0 : modelKnown ? reportUsd({ trimmed, rewarm, rates }) : null;
  if (usd === null) {
    e.unpricedReports = num(e.unpricedReports) + 1;
  } else {
    e.usd = num(e.usd) + usd;
    e.pricedReports = num(e.pricedReports) + 1;
  }
}

// v3 buckets: {actual:{byModel}, potential:{byModel}, reports}. Adds one
// (validated v3) report into the bucket at `key`.
function addToBucket(bucketMap, key, report) {
  const b = bucketMap[key] ?? {};
  if (!b.actual || typeof b.actual !== "object") b.actual = { byModel: {} };
  if (!b.potential || typeof b.potential !== "object") b.potential = { byModel: {} };
  const mk = modelKey(report);
  const modelKnown = mk !== "unknown";
  addSide(
    b.actual,
    mk,
    { trimmed: report.applied.trimmedTokens, rewarm: report.rewarmTokens },
    report.rates,
    modelKnown,
  );
  addSide(
    b.potential,
    mk,
    { trimmed: report.shadow.trimmedTokens, rewarm: report.shadowRewarmTokens },
    report.rates,
    modelKnown,
  );
  b.reports = num(b.reports) + 1;
  bucketMap[key] = b;
}

// v3 normalize. v2 buckets and the legacy sessions map are dropped (any file
// that is not exactly STATE_VERSION loads empty). `version` is always persisted.
function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const isCurrent = s.version === STATE_VERSION;
  return {
    version: STATE_VERSION,
    days: isCurrent && s.days && typeof s.days === "object" ? s.days : {},
    hours: isCurrent && s.hours && typeof s.hours === "object" ? s.hours : {},
    sessions: isCurrent && s.sessions && typeof s.sessions === "object" ? s.sessions : {},
  };
}

const isNonNegNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isShortId = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;

/**
 * PURE. True for the pre-v3 report shape: no `v` at all (an old plugin during
 * rollout). The route accepts these with 200 and ignores them.
 */
export function isLegacyReport(report) {
  return report !== null && typeof report === "object" && report.v === undefined;
}

/**
 * PURE. Validates a v3 counterfactual report (spec §5.1). Returns `null` when
 * valid, else an error string naming the offending field. Shared by the store's
 * `record` and the `/api/optimizer/counterfactual` route.
 *   v — must be 3
 *   sessionID — non-empty string, ≤128 chars; ts — finite ≥ 0
 *   providerID / modelID — optional, non-empty strings ≤200 chars
 *   rates — optional {cacheRead, cacheWrite, fetchedAt: finite ≥ 0,
 *     source: "config"|"catalog"}
 *   applied / shadow — required {trimmedTokens, trimmedParts: finite ≥ 0}
 *   change "none"|"grow"|"clear"; shadowChange "none"|"grow"
 *   rewarmTokens / shadowRewarmTokens — required, finite ≥ 0; > 0 is rejected
 *     when the matching change is "none" (a re-warm needs a change that caused it)
 */
export function validateCounterfactualReport(report) {
  const r = report ?? {};
  if (r.v !== REPORT_VERSION) return "v";
  if (typeof r.sessionID !== "string" || r.sessionID.length === 0 || r.sessionID.length > 128) {
    return "sessionID";
  }
  if (!isNonNegNum(r.ts)) return "ts";
  if (r.providerID !== undefined && !isShortId(r.providerID)) return "providerID";
  if (r.modelID !== undefined && !isShortId(r.modelID)) return "modelID";
  if (r.rates !== undefined) {
    const q = r.rates;
    if (q === null || typeof q !== "object") return "rates";
    if (!isNonNegNum(q.cacheRead)) return "rates.cacheRead";
    if (!isNonNegNum(q.cacheWrite)) return "rates.cacheWrite";
    if (!isNonNegNum(q.fetchedAt)) return "rates.fetchedAt";
    if (q.source !== "config" && q.source !== "catalog") return "rates.source";
  }
  for (const k of ["applied", "shadow"]) {
    const side = r[k];
    if (side === null || typeof side !== "object") return k;
    if (!isNonNegNum(side.trimmedTokens)) return `${k}.trimmedTokens`;
    if (!isNonNegNum(side.trimmedParts)) return `${k}.trimmedParts`;
  }
  if (r.change !== "none" && r.change !== "grow" && r.change !== "clear") return "change";
  if (r.shadowChange !== "none" && r.shadowChange !== "grow") return "shadowChange";
  if (!isNonNegNum(r.rewarmTokens)) return "rewarmTokens";
  if (!isNonNegNum(r.shadowRewarmTokens)) return "shadowRewarmTokens";
  if (r.rewarmTokens > 0 && r.change === "none") return "rewarmTokens";
  if (r.shadowRewarmTokens > 0 && r.shadowChange === "none") return "shadowRewarmTokens";
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
 *   record(report) → {ok, error?, ignored?}. A pre-v3 report (no `v`) →
 *   {ok:true, ignored:true} and nothing is stored. Otherwise validates; prices
 *   the report AT INGEST with its own `rates`; ADDITIVELY writes it into its
 *   day and hour buckets (keyed off report.ts, clamped), actual and potential
 *   separately; adds the applied tokens to the session's running total; prunes
 *   old day/hour buckets; caps sessions; persists.
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
    if (isLegacyReport(report)) return { ok: true, ignored: true };
    const err = validateCounterfactualReport(report);
    if (err) return { ok: false, error: err };
    const s = await ensureLoaded();
    // Bucketing keys off the report's own timestamp (clamped to now when in
    // the future or beyond day retention) — NOT the injected clock — so a
    // delayed report lands in the bucket its turn actually belonged to.
    const ts = clampTs(report.ts, nowMs());
    // The session map backs bySession / savedPct (the composer's per-
    // conversation figure): the running total of tokens ACTUALLY removed.
    const prev = s.sessions[report.sessionID];
    s.sessions[report.sessionID] = {
      trimmedTokens: num(prev?.trimmedTokens) + report.applied.trimmedTokens,
      lastTs: ts,
    };
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
 * PURE. Totals of one half (`actual` | `potential`) of a bucket across models:
 * `{ trimmed, rewarm, usd, pricedReports, unpricedReports }`. Tolerates a
 * missing/partial half (→ zeros). `usd` is the SUM OF THE STORED per-report
 * dollars — never re-priced.
 */
export function sideTotals(half) {
  const out = emptyEntry();
  const byModel = half && typeof half.byModel === "object" && half.byModel ? half.byModel : {};
  for (const e of Object.values(byModel)) {
    out.trimmed += num(e?.trimmed);
    out.rewarm += num(e?.rewarm);
    out.usd += num(e?.usd);
    out.pricedReports += num(e?.pricedReports);
    out.unpricedReports += num(e?.unpricedReports);
  }
  return out;
}

const sideOf = (b, k) => (b && b[k] && typeof b[k] === "object" ? b[k] : { byModel: {} });

/**
 * PURE(over the store's snapshot). The `count` most recent buckets of size
 * `bucket` ("day" | "hour"), oldest→newest, ZERO-FILLED where nothing was
 * reported. Each entry:
 *   { key, t, reports,
 *     actual:    { byModel, trimmed, rewarm, usd, pricedReports, unpricedReports },
 *     potential: { …same… } }
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
    const actual = sideOf(b, "actual");
    const potential = sideOf(b, "potential");
    return {
      key,
      t: bucketKeyToMs(key),
      reports: b ? num(b.reports) : 0,
      actual: { byModel: actual.byModel ?? {}, ...sideTotals(actual) },
      potential: { byModel: potential.byModel ?? {}, ...sideTotals(potential) },
    };
  });
}

/**
 * PURE(over the store's snapshot). Shape consumed by buildOptimizerSummary:
 *   dailySeries: [{day, actualTrimmedTokens, potentialTrimmedTokens,
 *     maskedTokens}] — `days` days, oldest→newest, ZERO-FILLED. `maskedTokens`
 *     is an ALIAS of potentialTrimmedTokens (the pre-v3 field name).
 *   bySession: {[sessionID]: {actualTrimmedTokens, maskedTokens}} — each
 *     session's running total of tokens ACTUALLY removed (`maskedTokens` is an
 *     alias). `savedPct` is NOT computed here: it needs tokensSent, which only
 *     summary.mjs has (it computes it against its own bySession).
 */
export async function summaryFields(store, { days = SUMMARY_DAYS, now = Date.now() } = {}) {
  const series = await bucketSeries(store, { bucket: "day", count: days, now });
  const s = await store.snapshot();
  const bySession = {};
  for (const [id, sd] of Object.entries(s.sessions ?? {})) {
    if (sd && typeof sd.trimmedTokens === "number") {
      bySession[id] = { actualTrimmedTokens: sd.trimmedTokens, maskedTokens: sd.trimmedTokens };
    }
  }
  return {
    dailySeries: series.map((e) => ({
      day: e.key,
      actualTrimmedTokens: e.actual.trimmed,
      potentialTrimmedTokens: e.potential.trimmed,
      maskedTokens: e.potential.trimmed,
    })),
    bySession,
  };
}
