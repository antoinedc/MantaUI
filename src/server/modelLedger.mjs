// modelLedger.mjs — read-only spend/latency ledger over opencode's store.
//
// OpenCode V2 store: assistant turns are `session_message` rows of type
// 'assistant' whose `data` is {agent, model:{providerID,id}, cost, tokens:{input,
// output,reasoning,cache:{read,write}}, time:{created,completed}, content:[…]};
// sessions are `session_v2`. (V1's `message`/`part`/`session` tables are gone.)
//
// BET-1219: the measurement half of model routing. Nobody can see where model
// spend actually goes; on this box ~90% of it is prompt cache, not output
// tokens, and subagents silently run on the most expensive model available.
// This module adds the MEASUREMENT only — no routing, no behaviour change.
// Later routing decisions are tuned from these numbers, so this ships first.
//
// Split strictly into pure (`aggregate`) and I/O (`ledgerSummary`):
//   • aggregate — all arithmetic. Pure; no DB. Exported for tests.
//   • ledgerSummary — SQL via getDb() + JSON.parse, then aggregate().
//
// Degradation: mirrors messageSearch.mjs — when getDb() yields null (no Node
// 24 runtime, or no opencode.db at the resolved path) ledgerSummary returns
// { supported:false } and never throws. Read-only is a hard invariant; the
// shared handle from opencodeDb.mjs is opened read-only and stays so.

import { getDb, isSharedHandle } from "./opencodeDb.mjs";
import { runDbTask } from "./dbOffload.mjs";
import { aggregateReliability } from "../shared/toolReliability.mjs";
import { dayKey, hourKey, recentBucketKeys } from "../shared/timeBuckets.mjs";

// Turns longer than this are excluded from TIMING only (still counted for
// cost) — the spec cap is 600s of wall-clock.
const TIMING_MAX_MS = 600_000;

// Reliability and telemetry describe how an endpoint behaves NOW. A rolling
// window is what lets a provider that had a bad week recover on its own.
export const ROUTING_LEDGER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Coerce an arbitrary JSON value to a finite number, else 0. Value-missing
// or a NaN/Infinity anywhere in the ledger is a bug; every division must
// yield 0, never NaN/Infinity.
function num(x) {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

// Divide with a hard divide-by-zero guard: 0/0 and n/0 both yield 0.
function safeDiv(n, d) {
  const dd = num(d);
  return dd === 0 ? 0 : num(n) / dd;
}

// Percentile of an ascending-sorted array (linear-approach index). Caller
// gates on the minimum sample count; safe on empty input (returns 0).
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// Timing duration (ms) for a row, or null when the row is excluded from
// timing: either boundary missing/zero, a zero/negative duration, or a
// duration over TIMING_MAX_MS. Excluded rows still count toward cost.
function timedDurationMs(startedMs, completedMs) {
  const s = num(startedMs);
  const c = num(completedMs);
  if (s <= 0 || c <= 0) return null;
  const d = c - s;
  if (!(d > 0) || d > TIMING_MAX_MS) return null;
  return d;
}

/**
 * PURE. Fold raw (already-parsed) rows into the spend/latency ledger.
 *
 * `rows` is Array<{ providerID, modelID, agent, parentId, directory, cost,
 * input, output, reasoning, cacheRead, cacheWrite, startedMs, completedMs }>.
 * `ledgerSummary` builds that shape; `aggregate` does all arithmetic.
 *
 * Every array in the result is sorted by `cost` descending. Never throws and
 * never emits NaN/Infinity — empty input yields all-zeros.
 */
export function aggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];

  const totals = { turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Group accumulators, keyed so undefined/null collapse to one bucket each.
  const modelMap = new Map(); // "providerID/modelID" -> { … }
  const agentMap = new Map(); // agent string (or null marker) -> { … }
  const projectMap = new Map(); // directory (or empty marker) -> { … }

  for (const r of list) {
    const cost = num(r.cost);
    const input = num(r.input);
    const output = num(r.output);
    const cacheRead = num(r.cacheRead);
    const cacheWrite = num(r.cacheWrite);

    totals.turns += 1;
    totals.cost += cost;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;

    // ---- byModel ----
    const modelKey = `${r.providerID ?? ""}/${r.modelID ?? ""}`;
    let m = modelMap.get(modelKey);
    if (!m) {
      m = { key: modelKey, turns: 0, cost: 0, outTotal: 0, outTimed: 0, durSec: 0, durations: [] };
      modelMap.set(modelKey, m);
    }
    m.turns += 1;
    m.cost += cost;
    m.outTotal += output;

    const durMs = timedDurationMs(r.startedMs, r.completedMs);
    if (durMs !== null) {
      m.outTimed += output;
      m.durSec += durMs / 1000;
      m.durations.push(durMs);
    }

    // ---- byAgent ----
    const agent = r.agent ?? null;
    const agentKey = agent === null ? "__null__" : agent;
    let a = agentMap.get(agentKey);
    if (!a) {
      a = { agent, isChild: false, turns: 0, cost: 0 };
      agentMap.set(agentKey, a);
    }
    a.turns += 1;
    a.cost += cost;
    // A subagent/child session is one whose parentId is set. isChild is true
    // if any contributing row came from a child session.
    if (r.parentId != null) a.isChild = true;

    // ---- byProject ----
    const directory = r.directory ?? "";
    const projectKey = directory === "" ? "__empty__" : directory;
    let p = projectMap.get(projectKey);
    if (!p) {
      p = { directory, turns: 0, cost: 0 };
      projectMap.set(projectKey, p);
    }
    p.turns += 1;
    p.cost += cost;
  }

  // ---- byModel ----
  const byModel = [];
  for (const m of modelMap.values()) {
    byModel.push({
      key: m.key,
      turns: m.turns,
      cost: m.cost,
      costPerTurn: safeDiv(m.cost, m.turns),
      outPerTurn: safeDiv(m.outTotal, m.turns),
      // Timing only: sum(output) / sum(durationSeconds) across timed turns.
      tokensPerSec: safeDiv(m.outTimed, m.durSec),
      p50Ms: m.durations.length >= 5 ? percentile(m.durations, 0.5) : null,
      p90Ms: m.durations.length >= 5 ? percentile(m.durations, 0.9) : null,
    });
  }
  byModel.sort(byCostDesc);

  // ---- byAgent ----
  const byAgent = [];
  for (const a of agentMap.values()) {
    byAgent.push({ agent: a.agent, isChild: a.isChild, turns: a.turns, cost: a.cost, costPerTurn: safeDiv(a.cost, a.turns) });
  }
  byAgent.sort(byCostDesc);

  // ---- byProject ----
  const byProject = [];
  for (const p of projectMap.values()) {
    byProject.push({ directory: p.directory, turns: p.turns, cost: p.cost });
  }
  byProject.sort(byCostDesc);

  // ---- cacheShare ----
  // Fractions of the summed billed token cost proxy
  // (input + output + cacheRead + cacheWrite); the four sum to ~1.
  const proxy = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const cacheShare = {
    output: safeDiv(totals.output, proxy),
    cacheRead: safeDiv(totals.cacheRead, proxy),
    cacheWrite: safeDiv(totals.cacheWrite, proxy),
    input: safeDiv(totals.input, proxy),
  };

  return { totals, cacheShare, byModel, byAgent, byProject };
}

function byCostDesc(a, b) {
  return num(b.cost) - num(a.cost);
}

// Local-calendar day key "YYYY-MM-DD" for a timestamp. Rows are bucketed into
// the user's local day, matching how the dashboard graph is read. Shared:
// `dayKey` / `recentBucketKeys` come from src/shared/timeBuckets.mjs — the
// same single definition the optimizer counterfactual store uses.

/**
 * PURE. Per-session spend over `rows` (flat ledger rows from
 * `fetchLedgerRows`), top 20 sessions by cost descending. `sessionID` is the
 * opencode session id (may be null for unjoined rows — collapsed to a single
 * bucket so no spend is dropped). `tokensSent` is the total context processed
 * (input + cacheRead + cacheWrite + output), not billing-weighted cost.
 */
export function aggregateBySession(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  for (const r of list) {
    const sessionID = r.sessionID ?? null;
    const key = sessionID === null ? "__null__" : sessionID;
    let e = map.get(key);
    if (!e) {
      e = { sessionID, turns: 0, cost: 0, tokensSent: 0 };
      map.set(key, e);
    }
    e.turns += 1;
    e.cost += num(r.cost);
    e.tokensSent += tokensSent(r);
  }
  return [...map.values()].sort(byCostDesc).slice(0, 20);
}

/**
 * PURE. Daily `tokensSent` series over the last `days` days ending at `now`,
 * oldest→newest, ZERO-FILLED for days with no rows. Each entry is a local
 * calendar day. `days` defaults to 30.
 */
export function aggregateDailySeries(rows, days = 30, now = Date.now()) {
  return aggregateSeriesByBucket(rows, "day", days, now).map(({ key, tokensSent }) => ({ day: key, tokensSent }));
}

/**
 * PURE. Hourly `tokensSent` series over the last `hours` local-calendar hours
 * ending at `now`, oldest→newest, ZERO-FILLED. Entry shape { hour, tokensSent }.
 * Ledger rows already carry a per-message timestamp, so this works
 * retroactively over all existing history — no migration, no schema change.
 */
export function aggregateHourlySeries(rows, hours = 24, now = Date.now()) {
  return aggregateSeriesByBucket(rows, "hour", hours, now).map(({ key, tokensSent }) => ({ hour: key, tokensSent }));
}

// PURE core shared by the two named series above: buckets `rows` by local
// calendar bucket (day/hour via the shared timeBuckets key builders), sums
// `tokensSent` per bucket, and zero-fills the `count` most recent buckets
// ending at `now`, oldest→newest. Returns [{ key, tokensSent }]; the two
// exported wrappers differ only in the key NAME (`day` vs `hour`) and the
// bucket size — one loop, not two.
function aggregateSeriesByBucket(rows, bucket, count, now) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, Math.floor(num(count)) || 1);
  const keyOf = bucket === "hour" ? hourKey : dayKey;
  const byBucket = new Map();
  for (const r of list) {
    const key = keyOf(r.startedMs);
    byBucket.set(key, (byBucket.get(key) || 0) + tokensSent(r));
  }
  const out = [];
  for (const key of recentBucketKeys(bucket, n, now)) {
    out.push({ key, tokensSent: byBucket.get(key) || 0 });
  }
  return out;
}

// tokensSent counts total context processed through the model (all input buckets + output), not billing-weighted cost — the dashboard graph shows weight, the Saved stat shows money.
function tokensSent(row) {
  return num(row.input) + num(row.cacheRead) + num(row.cacheWrite) + num(row.output);
}

/**
 * I/O. The ONE ledger row read. Served from the incremental in-memory cache
 * below (see "Incremental ledger row cache") — it no longer runs a SQL scan per
 * call. Extracts the flat ledger row shape (the
 * `aggregate`/aggregate* fold inputs) from assistant messages over `sinceMs`.
 * Projected query: the role filter + JSON parsing run in SQLite via
 * `json_extract`, so the SELECT streams only the fields the flat shape needs
 * instead of the full `data` blob (parsing it in JS was ~3 s on a cold 30-day read). Returns the role-filtered flat rows, mapped
 * into the exact same shape the old JS-parse path produced (same field names,
 * same typing) so `aggregate`, `aggregateBySession`, `aggregateDailySeries`,
 * `measureEffectiveTtl` and the routing fold consume them unchanged.
 *
 * Tool-call reliability needs the raw `data` blob, so it is NOT read here: see
 * `endpointSummary` (an off-thread windowed scan, dbTasks.mjs). Degradation matches the old path: a row whose `data`
 * is malformed JSON or lacks `role === "assistant"` is skipped silently. The
 * `json_valid(m.data)` guard filters malformed rows out BEFORE `json_extract`
 * runs (json_extract throws on invalid JSON rather than returning NULL, so the
 * guard is what keeps a single bad row from failing the whole query); rows
 * that are valid JSON but not an assistant message are excluded by the
 * `= 'assistant'` predicate. Never throws. Query/parse scaffolding lives in
 * the callers.
 */
export async function fetchLedgerRows(db, sinceMs) {
  return defaultLedgerCache.fetchRows(db, sinceMs);
}

// ---------------------------------------------------------------------------
// Incremental ledger row cache.
//
// node:sqlite's DatabaseSync is SYNCHRONOUS: every `stmt.all()` freezes the
// whole server. `message.time_created` has no index, so the old windowed query
// scanned (and json_extract-ed) the entire message table on every call — 0.8 s
// for a 1-day window, 3 s for full history — from several periodic pollers.
// That starved the event loop, HTTP stopped answering and the watchdog
// restarted the server.
//
// The fix is to never ask SQLite the same question twice:
//   • warm load — walk the (small) session table and read each session's
//     assistant rows through the (session_id, time_created, id) index in small
//     keyset pages, yielding to the event loop between pages, so no single
//     synchronous call runs longer than a few tens of ms;
//   • refresh — at most once per TTL, re-read only sessions whose
//     `time_updated` moved (or that still hold an unfinished row), and within
//     them only messages newer than the previous refresh minus an overlap;
//   • serve — every call filters the cached rows in memory.
// Callers during a warm-up / refresh await the SAME in-flight promise.
//
// Known, accepted limitation: a message deleted from opencode lingers in the
// cache until its session is re-scanned over that time range (deleted rows in a
// re-scanned range ARE dropped); a deleted SESSION is dropped on the next
// refresh.
// ---------------------------------------------------------------------------

export const LEDGER_CACHE_TTL_MS = 25_000;
// Re-scan messages this far behind the previous refresh: rows change until
// they complete, and clocks/commits are not perfectly ordered.
export const LEDGER_REFRESH_OVERLAP_MS = 60 * 60 * 1000;
// An unfinished row older than this is treated as abandoned (an aborted turn
// never completes) and stops forcing re-scans of its session.
export const LEDGER_ABANDONED_MS = 24 * 60 * 60 * 1000;
export const LEDGER_PAGE_ROWS = 100;
// A cold read of a wide window loads this recent tier FIRST and publishes it, then
// extends to the full window — so a small read (the optimizer's 24 h series) never waits
// for a 30-day load that happens to be running.
export const LEDGER_FIRST_TIER_MS = 48 * 60 * 60 * 1000;
// Further horizons an extension steps through (publishing each), so a 7-day read does
// not wait for the 30-day one: 48 h → 7 d → 14 d (the routing window) → 30 d → target.
export const LEDGER_TIERS_MS = Object.freeze([48 * 3_600_000, 7 * 86_400_000, 14 * 86_400_000, 30 * 86_400_000]);
// A session's time_updated can trail its newest message's time_created by a few
// hundred ms (measured on the real box: 9 of 289 recent sessions, worst 300 ms).
// Skipping a session as "older than the horizon" therefore leaves this much slack.
export const LEDGER_HORIZON_SLACK_MS = 10 * 60 * 1000;
export const LEDGER_YIELD_BUDGET_MS = 30;

/**
 * PURE. The message-created floor to re-scan a session from. A never-seen
 * session is read from 0; a known one from the earlier of (previous refresh −
 * overlap) and its oldest still-unfinished row.
 */
export function ledgerRescanFloor({ known, lastRefreshMs, incompleteFromMs, overlapMs = LEDGER_REFRESH_OVERLAP_MS }) {
  if (!known) return 0;
  const base = Math.max(0, num(lastRefreshMs) - overlapMs);
  return typeof incompleteFromMs === "number" ? Math.min(base, incompleteFromMs) : base;
}

/**
 * PURE. Which sessions need (re-)reading, and from where. `sessionList` is
 * Array<{ id, timeUpdated }>, `cached` a Map<id, { timeUpdated, incompleteFromMs }>.
 * A session is re-read when it is new, its `time_updated` moved (or is unknown),
 * or it still holds a recent unfinished row. Returns Array<{ id, floor }>.
 */
export function selectSessionsToScan({ sessionList, cached, lastRefreshMs, nowMs, overlapMs = LEDGER_REFRESH_OVERLAP_MS, abandonedMs = LEDGER_ABANDONED_MS, horizonMs = 0 }) {
  const out = [];
  for (const s of sessionList) {
    const c = cached.get(s.id);
    if (!c) {
      // The cache holds rows created >= horizonMs. A session last touched before
      // that has none to add; a session that moved (or whose update time is unknown) is read from the horizon.
      if (horizonMs > 0 && typeof s.timeUpdated === "number" && s.timeUpdated < horizonMs - LEDGER_HORIZON_SLACK_MS) continue;
      out.push({ id: s.id, floor: horizonMs });
      continue;
    }
    const live = typeof c.incompleteFromMs === "number" && c.incompleteFromMs > nowMs - abandonedMs;
    const moved = typeof s.timeUpdated !== "number" || typeof c.timeUpdated !== "number" || s.timeUpdated > c.timeUpdated;
    if (!moved && !live) continue;
    out.push({ id: s.id, floor: ledgerRescanFloor({ known: true, lastRefreshMs, incompleteFromMs: live ? c.incompleteFromMs : undefined, overlapMs }) });
  }
  return out;
}

/**
 * PURE. Merge freshly-read entries into a session's cached rows. `rows` is a
 * Map<msgId, { createdMs, row }>; `fetched` the entries read for messages with
 * created >= `floor`. Upserts by id, and drops cached rows inside the re-read
 * range that no longer exist (deleted upstream). Returns the oldest created
 * time among still-unfinished rows (undefined when none). Rows are dropped only
 * inside the re-read range [floor, ceil).
 */
export function mergeLedgerEntries(rows, fetched, floor, ceil = Infinity) {
  const seen = new Set();
  for (const e of fetched) {
    seen.add(e.id);
    rows.set(e.id, { createdMs: e.createdMs, row: e.row });
  }
  for (const [id, e] of rows) {
    if (!seen.has(id) && typeof e.createdMs === "number" && e.createdMs >= floor && e.createdMs < ceil) rows.delete(id);
  }
  let incompleteFromMs;
  for (const e of rows.values()) {
    if (typeof e.row.completedMs === "number" && e.row.completedMs > 0) continue;
    if (typeof e.createdMs !== "number") continue;
    if (incompleteFromMs === undefined || e.createdMs < incompleteFromMs) incompleteFromMs = e.createdMs;
  }
  return incompleteFromMs;
}

// Skip message rows whose serialized `data` is larger than this. Assistant
// messages are tiny (live box: 78k of them, max 28 KB, avg 0.5 KB), but USER
// messages can carry pasted files/images — 220 rows over 100 KB, one of 103 MB,
// 680 MB in total. Parsing those blobs is what made a 10-row page take 2 s, and
// they can never be ledger rows. `octet_length(data)` (SQLite >= 3.43) is
// answered from the record header without loading the payload, so guarding on it
// keeps the blob unread (measured: 0 ms vs 200 ms for `length()`, which must
// read a TEXT value to count characters; older SQLite falls back to `length`).
// Accepted limitation: an assistant row larger than this would be skipped.
export const LEDGER_MAX_ROW_BYTES = 131_072;

// One keyset page of a session's messages. The inner SELECT is bounded by
// LIMIT so a page never scans more than `limit` message rows through the
// (session_id, time_created, id) index; malformed JSON yields d = NULL (role
// NULL → skipped in JS) but still advances the cursor. Non-assistant rows come
// back with role != 'assistant' and are filtered in JS for the same reason.
const ledgerPageSql = (sizeFn) => `
  SELECT id AS msg_id, time_created AS created_at,
         json_extract(d,'$.agent')                   AS msgAgent,
         json_extract(d,'$.model.providerID')        AS providerID,
         json_extract(d,'$.model.id')                AS modelID,
         json_extract(d,'$.cost')                    AS cost,
         json_extract(d,'$.tokens.input')            AS input,
         json_extract(d,'$.tokens.output')           AS output,
         json_extract(d,'$.tokens.reasoning')        AS reasoning,
         json_extract(d,'$.tokens.cache.read')       AS cacheRead,
         json_extract(d,'$.tokens.cache.write')      AS cacheWrite,
         json_extract(d,'$.time.created')            AS startedMs,
         json_extract(d,'$.time.completed')          AS completedMs
  FROM (SELECT id, time_created, CASE WHEN ${sizeFn}(data) <= ${LEDGER_MAX_ROW_BYTES} AND json_valid(data) = 1 THEN data END AS d
        FROM session_message
        WHERE session_id = ? AND type = 'assistant' AND time_created >= ? AND time_created < ?
          AND (time_created > ? OR (time_created = ? AND id > ?))
        ORDER BY time_created, id
        LIMIT ?)
  ORDER BY created_at, msg_id`;

function ledgerRowFrom(r, sessionId, meta) {
  return {
    providerID: r.providerID ?? null,
    modelID: r.modelID ?? null,
    sessionID: sessionId,
    agent: meta.agent ?? r.msgAgent ?? null,
    parentId: meta.parentId ?? null,
    directory: meta.directory ?? null,
    cost: r.cost,
    input: r.input,
    output: r.output,
    reasoning: r.reasoning,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    startedMs: r.startedMs,
    completedMs: r.completedMs,
  };
}

function readSessionList(db) {
  let rows;
  let hasUpdated = true;
  try {
    rows = db.prepare("SELECT id, parent_id, agent, directory, time_updated FROM session_v2").all();
  } catch {
    // Older/foreign schema without session.time_updated: every session is then
    // treated as changed (bounded by the message-time floor).
    hasUpdated = false;
    rows = db.prepare("SELECT id, parent_id, agent, directory FROM session_v2").all();
  }
  return rows.map((r) => ({
    id: String(r.id),
    meta: {
      parentId: r.parent_id != null ? String(r.parent_id) : null,
      agent: r.agent ?? null,
      directory: r.directory ?? null,
    },
    timeUpdated: hasUpdated && typeof r.time_updated === "number" ? r.time_updated : null,
  }));
}

/**
 * SYNC. Read one session's assistant rows with message time_created in
 * [floor, ceil), in keyset pages. Pure over `db` — it is what the db worker runs
 * (dbTasks.ledgerScan) and what the inline (test) path wraps with a pacer.
 */
export function scanSessionSync(db, sid, meta, floor, ceil, pageRows = LEDGER_PAGE_ROWS) {
  const entries = [];
  for (const page of scanSessionPages(db, sid, meta, floor, ceil, pageRows)) for (const e of page) entries.push(e);
  return entries;
}

/** The generator behind scanSessionSync: one array of entries per page, so a caller can pace itself between pages. */
export function* scanSessionPages(db, sid, meta, floor, ceil, pageRows = LEDGER_PAGE_ROWS) {
  const ceilBound = Number.isFinite(ceil) ? ceil : Number.MAX_SAFE_INTEGER;
  let stmt;
  try {
    stmt = db.prepare(ledgerPageSql("octet_length"));
  } catch {
    stmt = db.prepare(ledgerPageSql("length")); // SQLite < 3.43: no octet_length
  }
  let curT = Number.MIN_SAFE_INTEGER;
  let curId = "";
  for (;;) {
    const page = stmt.all(sid, floor, ceilBound, curT, curT, curId, pageRows);
    const entries = [];
    for (const r of page) {
      // The SQL already selects assistant rows only; a row whose JSON is
      // malformed/oversized comes back with every field NULL and is skipped.
      if (r.providerID == null && r.modelID == null && r.startedMs == null) continue;
      entries.push({
        id: String(r.msg_id),
        createdMs: typeof r.created_at === "number" ? r.created_at : null,
        row: ledgerRowFrom(r, sid, meta),
      });
    }
    yield entries;
    if (page.length < pageRows) return;
    const last = page[page.length - 1];
    curT = last.created_at;
    curId = String(last.msg_id);
  }
}

/** SYNC. The newest assistant rows of one session (any age), as ledger rows. */
export function latestRowsSync(db, sid, meta = {}, n = 50) {
  const rows = db
    .prepare(
      `SELECT id AS msg_id, time_created AS created_at,
              json_extract(data,'$.agent') AS msgAgent, json_extract(data,'$.model.providerID') AS providerID,
              json_extract(data,'$.model.id') AS modelID, json_extract(data,'$.cost') AS cost,
              json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.output') AS output,
              json_extract(data,'$.tokens.reasoning') AS reasoning, json_extract(data,'$.tokens.cache.read') AS cacheRead,
              json_extract(data,'$.tokens.cache.write') AS cacheWrite, json_extract(data,'$.time.created') AS startedMs,
              json_extract(data,'$.time.completed') AS completedMs
       FROM (SELECT id, time_created, CASE WHEN length(data) <= ${LEDGER_MAX_ROW_BYTES} AND json_valid(data) = 1 THEN data END AS data
             FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created DESC, id DESC LIMIT ?)`,
    )
    .all(sid, n);
  const out = [];
  for (const r of rows) {
    if (r.providerID == null && r.modelID == null && r.startedMs == null) continue;
    out.push({ id: String(r.msg_id), createdMs: typeof r.created_at === "number" ? r.created_at : null, row: ledgerRowFrom(r, sid, meta) });
  }
  return out;
}

/**
 * Build a ledger row cache. One instance per process in production
 * (`defaultLedgerCache`); tests build their own with a fake clock / small
 * pages. State is keyed by db HANDLE, so a reopened handle (query-error
 * recovery) starts from a fresh warm load and the old cache is collectable.
 *
 * HORIZON. The cache holds every row created >= `horizonMs` (complete), for
 * every session — not the whole history. The first read loads exactly the
 * window asked for; a later read of an OLDER window extends the horizon by
 * reading only the gap. This is what keeps a cold start proportional to the
 * window instead of to 34 GB of history (the all-history warm-up was ~5-7
 * minutes of back-to-back synchronous page queries, single pages up to 1.6 s).
 * It leans on the invariant `session.time_updated >= max(message.time_created)`
 * to skip sessions that cannot hold rows in range.
 *
 * WHERE THE SCAN RUNS. With `offload` (production) the page queries run in the
 * db worker thread (dbTasks.ledgerScan, in time-budgeted chunks of sessions) and
 * the main thread only merges the results; without it (tests, non-shared
 * handles) they run inline, paced by `yieldBudgetMs` as before.
 */
export function createLedgerRowCache({
  ttlMs = LEDGER_CACHE_TTL_MS,
  now = Date.now,
  pageRows = LEDGER_PAGE_ROWS,
  yieldBudgetMs = LEDGER_YIELD_BUDGET_MS,
  clock = () => performance.now(),
  yieldFn = () => new Promise((r) => setImmediate(r)),
  offload = false,
  chunkBudgetMs = 750, // small chunks keep each result message (and its main-thread deserialize + merge) short
  run = runDbTask,
} = {}) {
  const states = new WeakMap();

  function stateFor(db) {
    let st = states.get(db);
    if (!st) {
      st = { sessions: new Map(), warmed: false, horizonMs: Infinity, refreshedAt: 0, checkedAt: 0, inflight: null, tierWaiters: [] };
      states.set(db, st);
    }
    return st;
  }

  // Merge one session's freshly read entries into the cache.
  function applyEntries(st, s, entries, floor, ceil) {
    let c = st.sessions.get(s.id);
    if (!c) {
      c = { meta: s.meta, timeUpdated: s.timeUpdated, incompleteFromMs: undefined, rows: new Map() };
      st.sessions.set(s.id, c);
    } else {
      c.meta = s.meta;
      c.timeUpdated = s.timeUpdated;
      for (const e of c.rows.values()) {
        e.row.agent = s.meta.agent ?? e.row.agent;
        e.row.parentId = s.meta.parentId;
        e.row.directory = s.meta.directory;
      }
    }
    // Computed over ALL the session's rows (not just the re-read range), so an
    // extension that only re-read the older gap still reports the true oldest unfinished row.
    c.incompleteFromMs = mergeLedgerEntries(c.rows, entries, floor, ceil);
  }

  // Read `todo` ([{id, floor, ceil}]) and merge each result as it arrives.
  async function scanAll(db, st, todo, byId, pacer) {
    if (todo.length === 0) return;
    if (offload && isSharedHandle(db)) {
      let i = 0;
      while (i < todo.length) {
        const chunk = todo.slice(i, i + 200).map((t) => ({ ...t, meta: byId.get(t.id).meta }));
        const r = await run("ledgerScan", { items: chunk, pageRows, budgetMs: chunkBudgetMs }, { timeoutMs: chunkBudgetMs + 60_000 });
        for (const res of r.results) {
          const t = todo[i + res.index];
          applyEntries(st, byId.get(t.id), res.entries, t.floor, t.ceil);
          await pacer();
        }
        i += Math.max(1, r.processed);
        await pacer();
      }
      return;
    }
    for (const t of todo) {
      const s = byId.get(t.id);
      const entries = [];
      for (const page of scanSessionPages(db, t.id, s.meta, t.floor, t.ceil, pageRows)) {
        for (const e of page) entries.push(e);
        await pacer();
      }
      applyEntries(st, s, entries, t.floor, t.ceil);
      await pacer();
    }
  }

  // Lower the horizon from where it is to `target`, one published tier at a time.
  async function extendTo(db, st, list, byId, target, pacer) {
    const steps = LEDGER_TIERS_MS.map((d) => now() - d).filter((h) => h > target && h < st.horizonMs);
    steps.push(target);
    for (const h of steps) {
      if (h >= st.horizonMs) continue;
      const gap = list.filter((x) => x.timeUpdated === null || x.timeUpdated >= h - LEDGER_HORIZON_SLACK_MS).map((x) => ({ id: x.id, floor: h, ceil: st.horizonMs }));
      await scanAll(db, st, gap, byId, pacer);
      st.horizonMs = h;
      for (const wake of st.tierWaiters.splice(0)) wake();
    }
  }

  async function refresh(db, st, target) {
    const startedAt = now();
    let lastYield = clock();
    const pacer = async () => {
      if (clock() - lastYield >= yieldBudgetMs) {
        await yieldFn();
        lastYield = clock();
      }
    };
    const list = readSessionList(db);
    await pacer();
    const present = new Set(list.map((x) => x.id));
    for (const sid of [...st.sessions.keys()]) if (!present.has(sid)) st.sessions.delete(sid);
    const byId = new Map(list.map((x) => [x.id, x]));
    if (!st.warmed) {
      // Cold. Load the recent tier first (when the window is wider), publish it, then extend.
      const tier = now() - LEDGER_FIRST_TIER_MS;
      const first = target < tier ? tier : target;
      st.horizonMs = first;
      const todo = list.filter((x) => x.timeUpdated === null || x.timeUpdated >= first - LEDGER_HORIZON_SLACK_MS).map((x) => ({ id: x.id, floor: first, ceil: Infinity }));
      await scanAll(db, st, todo, byId, pacer);
      st.warmed = true;
      st.refreshedAt = startedAt;
      st.checkedAt = now();
      for (const wake of st.tierWaiters.splice(0)) wake();
      if (target < first) await extendTo(db, st, list, byId, target, pacer);
    } else {
      const todo = selectSessionsToScan({
        sessionList: list.map((x) => ({ id: x.id, timeUpdated: x.timeUpdated })),
        cached: st.sessions,
        lastRefreshMs: st.refreshedAt,
        nowMs: startedAt,
        horizonMs: st.horizonMs,
      }).map((t) => ({ ...t, ceil: Infinity }));
      await scanAll(db, st, todo, byId, pacer);
      if (target < st.horizonMs) await extendTo(db, st, list, byId, target, pacer);
    }
    st.refreshedAt = startedAt;
  }

  async function ensureFresh(db, sinceMs = 0) {
    const st = stateFor(db);
    const want = Math.max(0, num(sinceMs));
    for (;;) {
      const covered = st.warmed && want >= st.horizonMs;
      // Serve what is cached while a refresh / extension of a WIDER window is still running.
      if (covered && (st.inflight || now() - st.checkedAt < ttlMs)) return;
      if (st.inflight) {
        // Wait for the pass to finish OR for it to publish a tier that covers this window.
        await new Promise((resolve) => {
          st.tierWaiters.push(() => {
            if (st.warmed && want >= st.horizonMs) resolve();
          });
          st.inflight.then(resolve, resolve);
        });
        continue;
      }
      const target = st.warmed ? Math.min(st.horizonMs, want) : want;
      let failed = null;
      st.inflight = (async () => {
        try {
          await refresh(db, st, target);
        } catch (e) {
          if (!st.warmed) {
            // Half-loaded cache would serve a silently truncated ledger — drop
            // it and let the caller see the failure; the next call retries.
            st.sessions = new Map();
            st.refreshedAt = 0;
            st.horizonMs = Infinity;
            failed = e;
            return;
          }
          // A failed refresh keeps serving the (slightly stale) cache; the TTL
          // below stops it from retrying on every call.
          console.warn("[modelLedger] ledger cache refresh failed:", e?.message ?? e);
          if (want < st.horizonMs) failed = e; // an extension that failed leaves the window uncovered
        } finally {
          st.checkedAt = now();
          st.inflight = null;
          for (const wake of st.tierWaiters.splice(0)) wake();
        }
      })();
      await st.inflight;
      if (failed) throw failed;
      if (st.warmed && want >= st.horizonMs) return;
    }
  }

  return {
    /** Same contract as the old query: flat rows with message time_created >= sinceMs. */
    async fetchRows(db, sinceMs) {
      const since = num(sinceMs);
      await ensureFresh(db, since);
      const out = [];
      for (const c of stateFor(db).sessions.values()) {
        for (const e of c.rows.values()) {
          if (typeof e.createdMs === "number" && e.createdMs >= since) out.push({ ...e.row });
        }
      }
      return out;
    },
    /**
     * The newest row per session (highest completedMs, later row wins ties) for
     * a small set of session ids, at ANY age. Map<sessionId, row>. Read straight
     * from each session's newest rows (an index seek) — NOT from the horizon
     * cache, so asking about an idle session never loads its history.
     */
    async latestBySession(db, sessionIds) {
      const ids = [...new Set(sessionIds ?? [])];
      const out = new Map();
      if (ids.length === 0) return out;
      const meta = new Map(readSessionList(db).map((x) => [x.id, x.meta]));
      let fetched;
      if (offload && isSharedHandle(db)) {
        fetched = (await run("ledgerLatest", { items: ids.filter((id) => meta.has(id)).map((id) => ({ id, meta: meta.get(id) })) })).results;
      } else {
        fetched = ids.filter((id) => meta.has(id)).map((id) => ({ id, entries: latestRowsSync(db, id, meta.get(id)) }));
      }
      for (const { id, entries } of fetched) {
        let best = null;
        let bestCompleted = 0;
        // entries are newest-first; the old contract was "later row wins ties" in time order.
        for (const e of [...entries].reverse()) {
          const completed = typeof e.row.completedMs === "number" ? e.row.completedMs : 0;
          if (best === null || completed >= bestCompleted) {
            best = e.row;
            bestCompleted = completed;
          }
        }
        if (best) out.set(id, { ...best });
      }
      return out;
    },
  };
}

const defaultLedgerCache = createLedgerRowCache({ offload: true });

/**
 * I/O. Latest ledger row per session for `sessionIds`, from the cache (no
 * full-history scan). Used by the compaction poller. Throws like
 * fetchLedgerRows on a failed warm load; callers already catch.
 */
export async function latestLedgerRowsBySession(db, sessionIds) {
  return defaultLedgerCache.latestBySession(db, sessionIds);
}

/**
 * PURE. Fold raw assistant message `data` into the tool-call reliability,
 * speed, latency and mix figures, keyed per endpoint ("providerID/modelID").
 *
 * Each row may carry tool-call data: `toolCalls` (Array<{name, arguments}>)
 * and an optional `tools` list (Array of tool defs). A row with tool calls is
 * one request that ended in tool calls; per-endpoint reliability reuses the
 * same request-level aggregation as the rest of the app. Timing reuses the
 * existing percentile + timing-exclusion helpers — no second copy.
 *
 * Returns an object keyed by endpoint; the shape is what the routing issue
 * consumes. Never throws.
 */
export function aggregateEndpointStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byEndpoint = new Map();
  for (const r of list) {
    const key = `${r.providerID ?? ""}/${r.modelID ?? ""}`;
    let e = byEndpoint.get(key);
    if (!e) {
      e = {
        key,
        durations: [],
        speeds: [],
        toolRequests: [],
        mix: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      byEndpoint.set(key, e);
    }

    e.mix.input += num(r.input);
    e.mix.output += num(r.output);
    e.mix.cacheRead += num(r.cacheRead);
    e.mix.cacheWrite += num(r.cacheWrite);

    const durMs = timedDurationMs(r.startedMs, r.completedMs);
    if (durMs !== null) {
      e.durations.push(durMs);
      const out = num(r.output);
      e.speeds.push(safeDiv(out, durMs / 1000));
    }

    const calls = Array.isArray(r.toolCalls) ? r.toolCalls : [];
    if (calls.length > 0) {
      e.toolRequests.push({ toolCalls: calls, tools: Array.isArray(r.tools) ? r.tools : [] });
    }
  }

  const out = {};
  for (const key of [...byEndpoint.keys()].sort()) {
    const e = byEndpoint.get(key);
    const durs = e.durations.sort((a, b) => a - b);
    const speeds = e.speeds.sort((a, b) => a - b);
    out[key] = {
      reliability: aggregateReliability(e.toolRequests),
      speed: {
        p50TokensPerSec: speeds.length ? percentile(speeds, 0.5) : null,
        p90TokensPerSec: speeds.length ? percentile(speeds, 0.9) : null,
      },
      latency: {
        p50Ms: durs.length ? percentile(durs, 0.5) : null,
        p90Ms: durs.length ? percentile(durs, 0.9) : null,
      },
      mix: { ...e.mix },
    };
  }
  return out;
}

// Extract the tool calls from a single assistant message: V2 keeps them inline
// in `content` (items of type "tool" carry the name and the parsed input).
function extractToolCalls(data) {
  const parts = Array.isArray(data.content) ? data.content : [];
  const calls = [];
  for (const p of parts) {
    if (!p || typeof p !== "object" || p.type !== "tool") continue;
    const name = p.name;
    const args = p.state && p.state.input;
    if (name == null) continue;
    calls.push({ name, arguments: args });
  }
  return calls;
}

// Best-effort source of the request's tool definitions from the stored message
// data. When absent (the common case — schemata aren't persisted), reliability
// degrades to the conservative invalid-json-only signal, matching the "schema
// absent ⇒ valid" rule in the classification. No new capture path is added.
function extractTools(data) {
  return Array.isArray(data.tools) ? data.tools : [];
}

/**
 * PURE. One stored assistant message (`session_message.data` JSON text) → the
 * flat row `aggregateEndpointStats` folds; null for malformed JSON / a
 * non-object. Runs inside the db worker (dbTasks.endpointStats).
 */
export function extractEndpointRow(dataJson) {
  let data;
  try {
    data = JSON.parse(dataJson);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const tokens = data.tokens ?? {};
  const cache = tokens.cache ?? {};
  return {
    providerID: data.model?.providerID ?? null,
    modelID: data.model?.id ?? null,
    input: tokens.input,
    output: tokens.output,
    cacheRead: cache.read,
    cacheWrite: cache.write,
    startedMs: data.time?.created,
    completedMs: data.time?.completed,
    toolCalls: extractToolCalls(data),
    tools: extractTools(data),
  };
}

/**
 * I/O. Per-endpoint measurement (reliability, speed, latency, mix) over a
 * rolling window of assistant rows. Degrades exactly like `ledgerSummary`:
 * returns { supported:false } — never throws — when there is no readable
 * opencode.db or the scan fails. Read-only.
 *
 * On success the flag is separated from the data: `{ supported: true,
 * endpoints: {…} }`. `endpoints` is 7a's map keyed by "providerID/modelID";
 * the flag being distinct is what lets a caller tell "no ledger"
 * ({supported:false}) from "a ledger with nothing measured" ({endpoints:{}}).
 * `partial:true` marks a scan that hit its time budget: the figures then cover
 * only the newest part of the window.
 *
 * WHERE IT RUNS (2026-10-19 wedge; V2 history ≈ 34 GB): the per-message JSON
 * walk can't be answered from an index, so it is a multi-minute scan. It runs in
 * a worker thread (dbOffload → dbTasks.endpointStats), window by window, newest
 * first, under a hard budget — the main thread only awaits a promise. Caller
 * contract: a fresh reading (< 60 s) is returned as-is; a stale one is returned
 * immediately while ONE background refresh runs (stale-while-revalidate, up to
 * 1 h old); with no reading at all a caller waits at most CALLER_WAIT_MS and
 * then gets { supported:false } while the scan keeps filling the cache. Degraded
 * values are never memoized.
 */
const ENDPOINT_SUMMARY_TTL_MS = 60_000;
const ENDPOINT_SUMMARY_STALE_MS = 60 * 60_000;
const ENDPOINT_SUMMARY_BUCKET_MS = 15 * 60_000; // `since` drifts every call; one scan serves a bucket
export const ENDPOINT_SCAN_BUDGET_MS = 240_000; // a 14-day scan measured ~90 s on the real 34 GB history
export const ENDPOINT_CALLER_WAIT_MS = 8_000;
const endpointSummaryCache = new Map(); // bucketed `since` → { t, summary }
const endpointSummaryInFlight = new Map(); // bucketed `since` → promise

/** Test-only: forget memoized endpoint summaries. Not runtime API. */
export function _resetEndpointSummaryCache() {
  endpointSummaryCache.clear();
}

export async function endpointSummary({ sinceMs = 0, callerWaitMs = ENDPOINT_CALLER_WAIT_MS } = {}) {
  const since = num(sinceMs);
  const key = Math.floor(since / ENDPOINT_SUMMARY_BUCKET_MS);
  const hit = endpointSummaryCache.get(key);
  const now = Date.now();
  // A slow scan earns a longer freshness window: re-scanning every minute would keep a
  // worker thread permanently busy.
  if (hit && now - hit.t < hit.ttl) return hit.summary;
  let run = endpointSummaryInFlight.get(key);
  if (!run) {
    const startedAt = Date.now();
    run = endpointSummaryCompute({ sinceMs: since })
      .then((summary) => {
        if (summary && summary.supported === true) {
          const took = Date.now() - startedAt;
          endpointSummaryCache.set(key, { t: Date.now(), ttl: Math.min(ENDPOINT_SUMMARY_STALE_MS / 2, Math.max(ENDPOINT_SUMMARY_TTL_MS, 5 * took)), summary });
          // Bound the cache: one entry per distinct window bucket, pruned on write.
          if (endpointSummaryCache.size > 16) {
            const t = Date.now();
            for (const [k, v] of endpointSummaryCache) {
              if (t - v.t >= ENDPOINT_SUMMARY_STALE_MS) endpointSummaryCache.delete(k);
            }
          }
        }
        return summary;
      })
      .finally(() => {
        endpointSummaryInFlight.delete(key);
      });
    endpointSummaryInFlight.set(key, run);
  }
  if (hit && now - hit.t < ENDPOINT_SUMMARY_STALE_MS) return hit.summary; // revalidating in the background
  return awaitWithin(run, callerWaitMs, { supported: false });
}

function awaitWithin(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function endpointSummaryCompute({ sinceMs = 0 } = {}) {
  try {
    const r = await runDbTask("endpointStats", { sinceMs, budgetMs: ENDPOINT_SCAN_BUDGET_MS });
    return r.complete ? { supported: true, endpoints: r.endpoints } : { supported: true, endpoints: r.endpoints, partial: true, coveredFromMs: r.coveredFromMs };
  } catch (e) {
    // No database → quietly unsupported. Anything else: log once and degrade to
    // { supported:false } — never an exception, never zeros (a card full of
    // 0.00 would read as "perfect reliability", which is a lie).
    if (e?.code !== "no_db") console.error("[modelLedger] endpoint query failed:", e?.message ?? e);
    return { supported: false };
  }
}

/**
 * I/O. Reads assistant rows via the shared getDb() handle, parses their JSON,
 * and folds them through aggregate(). Returns { supported:false } — never
 * throws — when getDb() yields null, mirroring searchMessages. Rows whose data
 * fails JSON.parse or whose role !== "assistant" are skipped silently.
 */
export async function ledgerSummary({ sinceMs = 0 } = {}) {
  const db = await getDb();
  if (!db) return { supported: false };

  try {
    const rows = await fetchLedgerRows(db, sinceMs);
    return { supported: true, ...aggregate(rows) };
  } catch (e) {
    // Query error: log once, drop the handle so the next call reopens, and
    // degrade to { supported:false } — never an exception.
    console.error("[modelLedger] query failed:", e?.message ?? e);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    return { supported: false };
  }
}

/**
 * I/O. The optimizer's MEASURED tokens-per-pct conversion (Optimizer P2.3,
 * BET-1345) needs a token total per opencode providerID. This sums
 * `tokensSent` (input + cacheRead + cacheWrite + output — all context that
 * passed through the model) across ledger rows per providerID, over the same
 * rolling-window rows the rest of the ledger reads. The pacing state reads the
 * total for a window's providerIDs at its mark and again later, and derives
 * tokens-per-pct from the delta — so the conversion is MEASURED on the box, not
 * assumed, and self-corrects.
 *
 * Returns { byProvider: { "<providerID>": total } } or `null` when the ledger
 * is unavailable (the caller then reports no pacing pressure — fail-open).
 * Never throws.
 */
export async function providerTokenTotals({ sinceMs = 0 } = {}) {
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = await fetchLedgerRows(db, num(sinceMs));
    const byProvider = {};
    for (const r of rows) {
      if (!r.providerID) continue;
      byProvider[r.providerID] = (byProvider[r.providerID] ?? 0) + tokensSent(r);
    }
    return { byProvider };
  } catch (e) {
    // Query error: same degrade contract as the rest of the ledger.
    console.error("[modelLedger] provider token query failed:", e?.message ?? e);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    return null;
  }
}
