// dbTasks.mjs — heavy READ-ONLY queries over opencode's own SQLite store, written
// as plain `(db, args) => result` functions so they run in two places with the
// SAME code: inside the dbWorker thread (production: manta-server's event loop
// never waits on them) and inline against a handle (tests, or MANTA_DB_OFFLOAD=inline).
//
// WHY: node:sqlite is synchronous. On the real box the history is ~34 GB, and a
// query whose predicate cannot be answered from an index (a text search over all
// parts, a 14-day tool-call scan, a GROUP BY over every message) is a multi-minute
// call. On the main thread that freezes every client (the 2026-10-19 wedge class).
//
// The shared trick is time windows: walk the message table in WINDOWS of ~N
// messages using the `time_created` index, run the caller's SQL over each window,
// and stop at a hard deadline. Every window is a short, index-driven query; a
// deadline returns what was read so far plus where to resume, so the result
// degrades to "the newest part of the answer" instead of "nothing" or "a frozen
// server".

import { aggregateEndpointStats, extractEndpointRow, scanSessionSync, latestRowsSync } from "./modelLedger.mjs";

export const WINDOW_TOKEN = "/*RANGE*/";
const MAXT = 8_640_000_000_000_000; // beyond any epoch ms

const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

/**
 * The time bound `windowMessages` messages away from `edge` along the
 * `time_created` index (an index walk of that many entries, no row reads).
 * dir "desc": the time_created of the windowMessages-th newest message <= edge;
 * dir "asc": of the windowMessages-th oldest message >= edge. null → fewer
 * messages than that remain (the window is the whole remainder).
 */
function windowEdge(db, dir, edge, windowMessages, sessionId) {
  const scope = sessionId ? "session_id = ? AND " : "";
  const sql =
    dir === "desc"
      ? `SELECT time_created AS t FROM session_message WHERE ${scope}time_created <= ? ORDER BY time_created DESC LIMIT 1 OFFSET ?`
      : `SELECT time_created AS t FROM session_message WHERE ${scope}time_created >= ? ORDER BY time_created ASC LIMIT 1 OFFSET ?`;
  const row = db.prepare(sql).get(...(sessionId ? [sessionId] : []), edge, windowMessages - 1);
  return row && typeof row.t === "number" ? row.t : null;
}

/**
 * Successive inclusive [lo, hi] time windows covering [from..to] in `dir`
 * order, each ~windowMessages messages wide. Ties at a boundary stay inside one
 * window (both ends inclusive, the next window starts past it).
 */
export function* windowRanges(db, { dir = "desc", from, to, windowMessages = 200, sessionId }) {
  const asc = dir === "asc";
  let edge = Number.isFinite(from) ? Math.trunc(from) : asc ? 0 : MAXT;
  const far = Number.isFinite(to) ? Math.trunc(to) : asc ? MAXT : 0;
  const size = Math.max(1, intOr(windowMessages, 200));
  for (;;) {
    if (asc ? edge > far : edge < far) return;
    let bound = windowEdge(db, dir, edge, size, sessionId);
    bound = bound === null ? far : asc ? Math.min(bound, far) : Math.max(bound, far);
    yield asc ? { lo: edge, hi: bound, next: bound + 1 } : { lo: bound, hi: edge, next: bound - 1 };
    if (bound === far) return;
    edge = asc ? bound + 1 : bound - 1;
  }
}

/**
 * Run `sql` over successive time windows of the message table.
 *
 * `sql` MUST contain WINDOW_TOKEN exactly where an extra `AND <col> >= lo AND
 * <col> <= hi` belongs; the token is replaced with integer literals only (no
 * injection surface). It must NOT carry its own LIMIT — the remaining row budget
 * is appended.
 *
 * `sessionId` scopes the window walk to one session (the (session_id,
 * time_created, id) index) — the caller's SQL must filter on it too.
 *
 * @returns {{rows: any[], complete: boolean, limited: boolean, resumeAt: number|null, windows: number}}
 *   complete: every window up to `to` was read. limited: stopped because `limit`
 *   rows were collected. Neither: the deadline hit → continue from `resumeAt`
 *   (the next unread edge, same direction/inclusivity as `from`).
 */
export function scanWindows(db, o) {
  const dir = o.dir === "asc" ? "asc" : "desc";
  const col = o.col ?? "p.time_created";
  const limit = Math.max(1, intOr(o.limit, 800));
  const params = o.params ?? [];
  const deadlineAt = Number.isFinite(o.deadlineAt) ? o.deadlineAt : Infinity;
  const rows = [];
  let windows = 0;
  let resumeAt = Number.isFinite(o.from) ? Math.trunc(o.from) : dir === "asc" ? 0 : MAXT;
  for (const w of windowRanges(db, { dir, from: o.from, to: o.to, windowMessages: o.windowMessages, sessionId: o.sessionId })) {
    if (Date.now() >= deadlineAt) return { rows, complete: false, limited: false, resumeAt, windows };
    const range = `AND ${col} >= ${w.lo} AND ${col} <= ${w.hi}`;
    const text = `${o.sql.replace(WINDOW_TOKEN, range)} LIMIT ${limit - rows.length}`;
    for (const r of db.prepare(text).all(...params)) rows.push(r);
    windows++;
    resumeAt = w.next;
    if (rows.length >= limit) return { rows, complete: false, limited: true, resumeAt, windows };
  }
  return { rows, complete: true, limited: false, resumeAt: null, windows };
}

/** The generic worker entry: a plain `sql` over time windows (ctoSearch, tool scan, message search). */
function windowedRows(db, args) {
  return scanWindows(db, { ...args, deadlineAt: Date.now() + intOr(args.budgetMs, 15_000) });
}

/**
 * Per-endpoint measurement over assistant messages created >= sinceMs, newest
 * first, window by window. The JSON walk (tool calls) and the aggregation both
 * happen HERE, off the main thread; only the small result crosses back.
 * `complete:false` → the deadline hit: the figures cover the NEWEST part of the
 * window only (`coveredFromMs` says how far back).
 */
function endpointStats(db, { sinceMs = 0, budgetMs = 60_000, windowMessages = 400 } = {}) {
  const deadlineAt = Date.now() + intOr(budgetMs, 60_000);
  const since = Math.max(0, intOr(sinceMs, 0));
  const stmtText = (w) => `SELECT m.data AS data FROM session_message m WHERE m.type = 'assistant' AND m.time_created >= ${w.lo} AND m.time_created <= ${w.hi}`;
  const rows = [];
  let coveredFromMs = null;
  let complete = true;
  for (const w of windowRanges(db, { dir: "desc", to: since, windowMessages })) {
    if (Date.now() >= deadlineAt) {
      complete = false;
      break;
    }
    for (const { data } of db.prepare(stmtText(w)).all()) {
      const row = extractEndpointRow(data);
      if (row) rows.push(row);
    }
    coveredFromMs = w.lo;
  }
  return { endpoints: aggregateEndpointStats(rows), complete, coveredFromMs };
}

/**
 * ⌘F text search over the given sessions, newest first. One session at a time
 * (each walks its own (session_id, time_created) index in windows), merged and
 * cut to `limit`. `sql` is the caller's part query with WINDOW_TOKEN and a
 * single `p.session_id = ?` placeholder first, then `pattern`.
 */
function sessionSearch(db, { scope, sql, pattern, limit = 800, perSessionLimit = limit, budgetMs = 8_000, windowMessages = 100 }) {
  const deadlineAt = Date.now() + intOr(budgetMs, 8_000);
  const all = [];
  let complete = true;
  for (const sessionId of scope) {
    if (Date.now() >= deadlineAt) {
      complete = false;
      break;
    }
    const r = scanWindows(db, { sql, params: [sessionId, pattern], sessionId, limit: perSessionLimit, windowMessages, deadlineAt });
    for (const row of r.rows) all.push(row);
    if (!r.complete && !r.limited) complete = false;
  }
  all.sort((a, b) => b.time_created - a.time_created || (a.part_id < b.part_id ? 1 : a.part_id > b.part_id ? -1 : 0));
  return { rows: all.slice(0, limit), complete };
}

/**
 * Ledger rows for a batch of sessions: [{id, floor, ceil, meta}] → per-session
 * entries over message time_created in [floor, ceil). Processes items in order
 * until the budget is spent (always at least one), returning how many it did so
 * the caller can ask for the rest — each call stays short, results stream back.
 */
function ledgerScan(db, { items, pageRows = 100, budgetMs = 3_000 }) {
  const deadlineAt = Date.now() + intOr(budgetMs, 3_000);
  const results = [];
  let processed = 0;
  for (const it of items) {
    if (processed > 0 && Date.now() >= deadlineAt) break;
    const ceil = it.ceil === null || it.ceil === undefined || it.ceil === Infinity ? Number.MAX_SAFE_INTEGER : it.ceil;
    results.push({ index: processed, entries: scanSessionSync(db, it.id, it.meta, it.floor, ceil, pageRows) });
    processed++;
  }
  return { results, processed };
}

/** The newest ledger rows of each session in `items` ([{id, meta}]), any age. */
function ledgerLatest(db, { items }) {
  return { results: items.map((it) => ({ id: it.id, entries: latestRowsSync(db, it.id, it.meta) })) };
}

/**
 * Sessions with a user/assistant message created in [start, end), oldest first-message
 * first, with their first in-range message time. One index seek per candidate
 * session (session_id, time_created) instead of a GROUP BY over every message in the
 * range (25 s on the real box). Candidates are the sessions updated since `start`
 * (a session's time_updated is never older than its newest message beyond a small
 * slack — see LEDGER_HORIZON_SLACK_MS).
 */
function sessionsInRange(db, { start, end, slackMs = 10 * 60 * 1000 }) {
  const cands = db
    .prepare("SELECT id, directory, agent, time_updated FROM session_v2 WHERE time_updated IS NULL OR time_updated >= ?")
    .all(Math.max(0, intOr(start, 0) - slackMs));
  const first = db.prepare(
    "SELECT MIN(time_created) AS t FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') AND time_created >= ? AND time_created < ?",
  );
  const out = [];
  for (const c of cands) {
    const r = first.get(c.id, intOr(start, 0), intOr(end, MAXT));
    if (r && typeof r.t === "number") out.push({ sid: String(c.id), directory: c.directory ?? null, agent: c.agent ?? null, first_ts: r.t });
  }
  out.sort((a, b) => a.first_ts - b.first_ts || (a.sid < b.sid ? -1 : 1));
  return out;
}

export const TASKS = { sessionsInRange, windowedRows, endpointStats, sessionSearch, ledgerScan, ledgerLatest };
