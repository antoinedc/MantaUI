// Progress — durable, session-scoped "where are we right now" state for a
// background turn (design spec §6.1 the shape, §6.2 the sinks, §6.3 why it
// earns its place). A running turn today is opaque: "Ruminating…" is a verb the
// model did not choose, and there is no way for it to say "step 3 of 5" or "I
// have stopped and need a human decision" in its own words. Progress is that
// channel.
//
// Three rules that are the whole design:
//   - REPLACE, NEVER APPEND. Each report overwrites the previous. There is no
//     history, no array, no growth — the transcript is already the log; this is
//     "where are we right now", a different and much smaller thing.
//   - `step` IS MONOTONIC. A report with a lower `step` than the stored one
//     keeps the stored value (a bar going 4/5 → 2/5 reads as a bug even when
//     the model meant it). `total` may change freely (plans change). Mirrors
//     the strictly-increasing guard in opencodeAdmin.mjs's parseProgressLine.
//   - CLEAR ON SESSION END, and prune records older than 7 days on a sweep.
//
// One sink is implemented in this issue: `ui`, which IS just the durable record
// plus the progress.updated bus event. The `forge` / `tracker` / `push` sinks
// are later issues; a model asking for one must not break its own turn, so the
// `sinks` array is accepted + validated but unknown values are ignored with a
// warning.
//
// Shape mirrors src/server/schedule.mjs: pure logic exported at the top, a
// durable store via statePath() with atomic writes, CRUD with injected I/O and
// a publish callback, and a startProgressSweeper() engine factory that uses the
// shared startPoller() helper (the schedule/delegate/capabilities sweep shape,
// extracted so this isn't a fourth copy).
//
// Server-owned (NOT in desktop main) so it survives Mac-app-close and box
// reboot like every other box store. The renderer half is a separate issue;
// this issue is the server half + the progress_report opencode tool.

import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";

export const PROGRESS_STATES = ["working", "blocked", "done", "failed"];
const VALID_STATES = new Set(PROGRESS_STATES);
// Records not updated within 7 days are pruned (silent retention).
export const PROGRESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
const STORE_PATH = statePath("progress.json");

// ---------------------------------------------------------------------------
// Pure merge rule — the whole design
// ---------------------------------------------------------------------------

/**
 * Merge a (possibly partial) report onto the previous record. Pure.
 *
 * - label / detail / state: replaced when provided, else inherited.
 * - state: must be working|blocked|done|failed; an unknown value is rejected.
 * - step: monotonic — a lower step keeps the stored value; total is free to
 *   change (plans change) and is replaced when provided.
 * - updatedAt: always advances (to `now()`).
 *
 * `prev` may be undefined (the first report for a session).
 *
 * @param {object|null} prev
 * @param {object} next
 * @param {() => number} now
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function applyReport(prev, next, now = () => Date.now()) {
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return { ok: false, error: "report must be an object" };
  }
  const state = next.state ?? prev?.state ?? "working";
  if (!VALID_STATES.has(state)) {
    return { ok: false, error: `invalid state "${state}" (expected ${PROGRESS_STATES.join("|")})` };
  }

  let step = prev?.step ?? null;
  if (next.step !== undefined && next.step !== null) {
    const n = Number(next.step);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "step must be a non-negative integer" };
    }
    // Monotonic guard: never step backwards. A plan that re-scopes keeps the
    // highest step seen.
    if (step === null || n > step) step = n;
  }

  let total = prev?.total ?? null;
  if (next.total !== undefined && next.total !== null) {
    const t = Number(next.total);
    if (!Number.isInteger(t) || t <= 0) {
      return { ok: false, error: "total must be a positive integer" };
    }
    total = t;
  }

  return {
    ok: true,
    record: {
      sessionID: next.sessionID ?? prev?.sessionID ?? null,
      label: next.label !== undefined ? String(next.label) : (prev?.label ?? ""),
      step,
      total,
      state,
      detail: next.detail !== undefined ? String(next.detail) : (prev?.detail ?? ""),
      updatedAt: now(),
    },
  };
}

// ---------------------------------------------------------------------------
// Store (atomic, keyed by sessionID — one record per session)
// ---------------------------------------------------------------------------

export async function loadRecords(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return {};
}

export async function saveRecords(records, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(records, null, 2));
}

// ---------------------------------------------------------------------------
// CRUD (all injected-I/O; no live bus/filesystem in tests)
// ---------------------------------------------------------------------------

/**
 * Apply a model's report to the store — replace, never append. Publishes
 * `progress.updated` on the bus on every change. Unknown sink names are
 * ignored with a warning (a model asking for a not-yet-implemented sink must
 * not break its own turn).
 */
export async function reportProgress(
  input,
  { load = loadRecords, save = saveRecords, publish, now = () => Date.now() } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "body must be an object" };
  }
  const sessionID = input.sessionID;
  if (typeof sessionID !== "string" || !sessionID) {
    return { ok: false, error: "sessionID is required" };
  }
  const records = await load();
  const prev = records[sessionID];
  const merged = applyReport(prev, { ...input, sessionID }, now);
  if (!merged.ok) return merged;
  records[sessionID] = merged.record;
  await save(records);
  publish?.({ kind: "progress.updated", payload: { sessionID } });
  if (Array.isArray(input.sinks)) {
    for (const s of input.sinks) {
      if (s !== "ui") {
        console.warn(`[progress] ignoring unknown sink "${s}" (only "ui" is implemented)`);
      }
    }
  }
  return { ok: true, record: merged.record };
}

export async function readProgressRecord(sessionID, { load = loadRecords } = {}) {
  if (!sessionID) return null;
  const records = await load();
  return records[sessionID] ?? null;
}

export async function listProgress({ load = loadRecords } = {}) {
  return load();
}

/**
 * Clear the record for a session on session end. No record → no-op
 * ({deleted:false}); a deleted record optionally publishes progress.updated.
 */
export async function clearProgress(
  sessionID,
  { load = loadRecords, save = saveRecords, publish } = {},
) {
  if (typeof sessionID !== "string" || !sessionID) {
    return { ok: false, error: "sessionID is required" };
  }
  const records = await load();
  if (!records[sessionID]) return { ok: true, deleted: false };
  delete records[sessionID];
  await save(records);
  publish?.({ kind: "progress.updated", payload: { sessionID } });
  return { ok: true, deleted: true };
}

// ---------------------------------------------------------------------------
// Retention sweep
// ---------------------------------------------------------------------------

/**
 * Pure: drop records whose updatedAt is older than `retentionMs`. Returns the
 * retained map plus a `changed` flag so the caller saves only when something
 * was pruned. Silent (dropped records do NOT publish — retention is not an
 * update).
 */
export function pruneRecords(records, nowMs = Date.now(), retentionMs = PROGRESS_RETENTION_MS) {
  const cutoff = nowMs - retentionMs;
  const out = {};
  let changed = false;
  for (const [sid, rec] of Object.entries(records ?? {})) {
    const updated = Number(rec?.updatedAt);
    if (Number.isFinite(updated) && updated < cutoff) {
      changed = true;
      continue;
    }
    out[sid] = rec;
  }
  return { records: out, changed };
}

export async function sweepProgress({
  load = loadRecords,
  save = saveRecords,
  now = () => Date.now(),
} = {}) {
  const records = await load();
  const { records: retained, changed } = pruneRecords(records, now());
  if (changed) await save(retained);
}

export function startProgressSweeper({ publish } = {}, { intervalMs = SWEEP_INTERVAL_MS, storePath } = {}) {
  const path = storePath ?? STORE_PATH;
  return startPoller(
    () =>
      sweepProgress({
        load: () => loadRecords(path),
        save: (r) => saveRecords(r, path),
      }),
    { intervalMs, label: "progress" },
  );
}
