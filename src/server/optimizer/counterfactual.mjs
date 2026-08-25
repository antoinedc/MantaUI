// optimizer/counterfactual.mjs — the OBSERVE-ONLY masking counterfactual store
// (Optimizer P1.3, BET-1335).
//
// What the manta-optimizer opencode plugin reports (POST
// /api/optimizer/counterfactual) is not spend — it is the "what manta WOULD
// trim" counterfactual: for a session's current message history, how many
// tokens/parts the masking policy would drop. The plugin is read + report
// only; it never mutates the message history. This module stores those
// reports so the dashboard's "raw vs optimized" graph has a real second line
// before any actuation exists.
//
// Semantics (a report REPLACES, never increments): each session keeps only its
// LATEST report's values, because each report is the full would-mask for that
// session's current history. `days` stores, per local day, the sum over
// sessions of each session's latest maskedTokens as of that day's last report.
//
// Split strictly into pure/store (createCounterfactualStore — injected I/O)
// and a PURE validator + summaryFields. No real state dir is touched unless
// index.mjs wires a load/save; tests inject in-memory load/save.

import { statePath } from "../../shared/paths.mjs";

// Persistence file for the store (wired by index.mjs via the shared
// jsonStore atomic writer — see the hygiene note there). New store, new file:
// `statePath()` keeps it sandboxed under the test seam.
export const COUNTERFACTUAL_PATH = statePath("optimizer-counterfactual.json");

export const MAX_SESSIONS = 500;
export const RETAIN_DAYS = 90;
export const SUMMARY_DAYS = 30;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Local-calendar day key "YYYY-MM-DD", matching how the dashboard graph is read.
function dayKey(ms) {
  const d = new Date(num(ms));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_MS = 86_400_000;

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    days: s.days && typeof s.days === "object" ? s.days : {},
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
  return null;
}

// Recompute a day's entry: the sum of maskedTokens (and count of sessions)
// over all sessions whose latest report falls on that local day.
function computeDay(sessions, day) {
  let maskedTokens = 0;
  let reports = 0;
  for (const sd of Object.values(sessions)) {
    if (!sd || typeof sd.lastTs !== "number") continue;
    if (dayKey(sd.lastTs) === day) {
      maskedTokens += num(sd.maskedTokens);
      reports++;
    }
  }
  return { maskedTokens, reports };
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
 * `{days, sessions}` (or {}), `save(state)` persists it atomically, `now` is
 * the clock (number or zero-arg fn, for tests). Pure logic — no fs access
 * unless the injected load/save touch it.
 *
 * Returns { record, snapshot }:
 *   record({sessionID, maskedTokens, maskedParts, ts}) → {ok, error?}. Validates;
 *   replaces the session's latest report; prunes old day entries; caps sessions
 *   at MAX_SESSIONS; recomputes today's day entry; persists; {ok:true}.
 *   snapshot() → the current state ({days, sessions}), loading from load() on
 *   first access. Backs summaryFields().
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
    const t = nowMs();
    const today = dayKey(t);
    // REPLACE the session's counterfactual (each report is the full would-mask
    // for that session's current history, not an increment).
    const session = {
      maskedTokens: num(report.maskedTokens),
      maskedParts: num(report.maskedParts),
      lastTs: num(report.ts),
    };
    // BET-1344: keep the actuation telemetry when supplied (both optional, so
    // an observe-only plugin's report still merges cleanly).
    if (report.applied !== undefined) session.applied = report.applied;
    if (report.mode !== undefined) session.mode = report.mode;
    s.sessions[report.sessionID] = session;
    capSessions(s.sessions);
    // Retention: drop day entries older than RETAIN_DAYS (ISO keys compare
    // lexicographically).
    const cutoff = dayKey(t - RETAIN_DAYS * DAY_MS);
    for (const k of Object.keys(s.days)) {
      if (k < cutoff) delete s.days[k];
    }
    // Day entries are snapshots "as of that day's last report" — only today's
    // is recomputed.
    s.days[today] = computeDay(s.sessions, today);
    await save(s);
    return { ok: true };
  }

  async function snapshot() {
    return ensureLoaded();
  }

  return { record, snapshot };
}

/**
 * PURE(over the store's snapshot). Shape consumed by buildOptimizerSummary:
 *   dailySeries: [{day, maskedTokens}] — SUMMARY_DAYS days, oldest→newest,
 *     ZERO-FILLED for days with no counterfactual report.
 *   bySession: {[sessionID]: {maskedTokens}} — each session's latest
 *     maskedTokens. `savedPct` is NOT computed here: it needs tokensSent,
 *     which only summary.mjs has (it computes it against its own bySession).
 */
export async function summaryFields(store, { days = SUMMARY_DAYS, now = Date.now() } = {}) {
  const s = await store.snapshot();
  const n = Math.max(1, Math.floor(num(days)) || 1);
  const bySession = {};
  for (const [id, sd] of Object.entries(s.sessions ?? {})) {
    if (sd && typeof sd.maskedTokens === "number") {
      bySession[id] = { maskedTokens: sd.maskedTokens };
    }
  }
  const t = typeof now === "function" ? num(now()) : num(now ?? Date.now());
  const dailySeries = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    dailySeries.push({ day: key, maskedTokens: s.days?.[key]?.maskedTokens ?? 0 });
  }
  return { dailySeries, bySession };
}
