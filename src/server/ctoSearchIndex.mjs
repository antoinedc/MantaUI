// ctoSearchIndex.mjs — the Manta-owned SQLite FTS5 search index over
// opencode's read-only source (unified-CTO spec §4.1/§4.3, P1b1 slice: the
// index foundation — bounded incremental sync + bounded ranked search as a
// MODULE API only. No tool, no UI, no runtime background poller wiring yet;
// nothing here is exposed through rpc/tools/UI, and nothing schedules itself).
//
// Invariants this module owns:
//   • READ-ONLY SOURCE. The opencode DB is read through the shared
//     `opencodeDb.mjs` handle (`DatabaseSync(path, {readOnly:true})`) — the
//     same one ctoContext uses. The index never writes a table, index or row
//     into the source, and no source mutation can rebuild the index.
//   • DISPOSABLE INDEX. The FTS5 database lives at
//     `statePath("cto", "search-index.sqlite")` (so the `MANTA_STATE_HOME`
//     test sandbox redirects it like every Manta store) and is NOT
//     authoritative conversation storage. Corruption is detected
//     (`PRAGMA quick_check`) and healed by DELETING and rebuilding the index
//     file — an explicit failure is returned only if even the rebuild fails.
//     The source is never touched by recovery.
//   • EVIDENCE CONTRACT. Exactly the eligible scalar evidence of a part is
//     indexed, extracted by the P1a-reviewed seam `partCandidates()`
//     (ctoContext.mjs): text parts contribute `$.text` only; tool parts
//     contribute tool name / `state.input` / `state.output` scalars.
//     Reasoning and metadata are NEVER indexed as evidence. Unknown part
//     types yield no candidates and are not indexed.
//   • INCREMENTAL BY UPDATE TIMESTAMP + STABLE ID. Each stream (sessions,
//     messages, parts) is scanned as a keyset over
//     `(COALESCE(time_updated,0), id)` — NOT creation-only, so a streamed
//     part edit (whose row time_updated moves) is re-indexed. A part row is
//     processed as a REPLACE: its previous FTS terms are deleted and the
//     current evidence inserted, so a stale term disappears on update.
//   • ATOMIC CURSOR. All writes of one sync call — mirror rows, FTS rows,
//     the deletion reconcile, and the persisted cursor — run in ONE
//     transaction. The cursor is written only in the same commit as every
//     row through it; a failed batch rolls back and the next sync retries
//     the same window. Bounds are bytes-first: per-field and per-part
//     evidence caps (UTF-8-safe) so one huge tool dump cannot blow up the
//     index, and the search response honors the spec's 24 KiB budget.
//   • BOUNDED DELETION RECONCILE. Source rows deleted after indexing cannot
//     be seen by a timestamp cursor, so each sync verifies a bounded sample
//     of indexed parts (oldest-verified first) against the source and drops
//     rows whose source part is gone — eventual, bounded, honest.
//   • PROVENANCE SEAM. Internal-ephemeral exclusion comes from the
//     ESTABLISHED provenance registry (`internalSessions.internalSessionIds`
//     — session IDs, never titles), injectable via `provenanceFilter` for
//     tests and future callers. Provenance is stored per session mirror row
//     as `internal` or `unclassified` (no inference beyond the registry);
//     search excludes `internal` by default. If the registry itself fails,
//     the batch fails CLOSED without advancing the cursor.
//   • HONEST STATUSES. `unsupported` (no node:sqlite — lazy import, Node 20
//     degrades, never a static import), `source_unavailable` (no source DB),
//     `provenance_unavailable` (registry failure), `index_unavailable`
//     (rebuild failed), `index_error` (operation failed; the handle is
//     closed so the next call reopens/rebuilds), `invalid_input` (bad caller
//     arguments) are distinct. An empty result over a healthy empty index is
//     `ok` WITH coverage counts — never a fabricated "nothing happened".
//
// Query policy: the user's query is LITERAL text — see ftsQuery.mjs (each
// whitespace-separated term double-quoted and AND-joined; FTS5
// metacharacters can never act as operators; unicode terms match by the
// tokenizer's unicode folding).

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { getDb, getDbOpenFailure } from "./opencodeDb.mjs";
import { partCandidates } from "./ctoContext.mjs";
import { internalSessionIds } from "./internalSessions.mjs";
import { ftsMatchExpression } from "./ftsQuery.mjs";

export const CTO_SEARCH_INDEX_LIMITS = Object.freeze({
  // One sync call processes AT MOST `limit` rows PER STREAM (spec §4.3
  // "bound each scan batch"), clamped server-side.
  syncBatchDefault: 200,
  syncBatchMax: 500,
  // Spec §4.2 defaults, enforced server-side.
  searchHitsDefault: 20,
  searchHitsMax: 50,
  // Bytes-first evidence caps (UTF-8), applied at index time: the index
  // stores bounded evidence, not whole transcripts. A cut is recorded on the
  // part row (`truncated`) and the tail is simply not searchable — that is
  // the honest cost of a bounded index.
  fieldEvidenceMaxBytes: 8 * 1024,
  partEvidenceMaxBytes: 16 * 1024,
  sessionTitleMaxBytes: 512,
  // Spec §4.2: 24 KiB returned text per call, measured on the serialized
  // response; overflow drops tail hits (retry-reachable via the cursor).
  responseBudgetBytes: 24 * 1024,
  // Bounded deletion reconcile + provenance refresh per sync call.
  deleteReconcileMax: 64,
  provenanceRefreshMax: 16,
  // FTS5 snippet bounds (tokens) — keeps per-hit text bounded by construction.
  snippetTokens: 24,
});

const SCHEMA_VERSION = "1";
const INDEX_FILENAME = "search-index.sqlite";
const CURSOR_KEY = "cursor";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const byteLen = (s) => ENC.encode(s).length;

// Initial keyset position: before every row (COALESCE(time_updated,0) >= 0,
// and every TEXT id > ""). Streams advance to the last consumed row.
const CURSOR_START = Object.freeze({ t: -1, i: "" });

function zeroCounts() {
  return { sessions: { scanned: 0, upserted: 0, removed: 0 }, messages: { scanned: 0, upserted: 0, removed: 0 }, parts: { scanned: 0, upserted: 0, removed: 0 }, verifiedParts: 0, refreshedSessions: 0 };
}

function baseEnvelope() {
  return { supported: true, status: "ok", observedAt: new Date().toISOString() };
}

function clampLimit(value, dflt, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

// UTF-8-safe cut to `maxBytes` without splitting a code point (encode once,
// back up over continuation bytes). Bytes, not chars — the caps above are
// byte budgets.
function cutUtf8(text, maxBytes) {
  if (byteLen(text) <= maxBytes) return { text, truncated: false };
  const bytes = ENC.encode(text);
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end--;
  return { text: DEC.decode(bytes.subarray(0, end)), truncated: true };
}

// ---------------------------------------------------------------------------
// Index handle: lazy open, schema init/version, corruption rebuild
// ---------------------------------------------------------------------------

let _indexDb = null;
let _indexOpenFailure = null;
// Test-only substitutes, mirroring opencodeDb.mjs's seams.
let _modOverride = null;
export function _setSqliteModuleOverride(mod) {
  _modOverride = mod;
}
// Test-only: the resolved index path (so tests corrupt the exact file).
export function _searchIndexPath() {
  return statePath("cto", INDEX_FILENAME);
}
// Test/runtime: drop the cached handle so the next call reopens (and a
// corrupt file is re-detected by quick_check instead of hidden by cached
// pages). Not part of the runtime API.
export function _closeSearchIndexHandle() {
  if (_indexDb) {
    try {
      _indexDb.close();
    } catch {
      /* already closed */
    }
  }
  _indexDb = null;
}

async function loadSqlite() {
  if (_modOverride !== null) {
    if (_modOverride && _modOverride.__importError) return null;
    return _modOverride;
  }
  try {
    return await import("node:sqlite");
  } catch (e) {
    console.warn("[ctoSearchIndex] node:sqlite unavailable:", e?.message ?? e);
    return null;
  }
}

const DDL = `
  CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS indexed_sessions (
    id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, workspace_id TEXT,
    directory TEXT, title TEXT, archived INTEGER, provenance TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
    source_time INTEGER, last_verified_at INTEGER);
  CREATE TABLE IF NOT EXISTS indexed_messages (
    id TEXT PRIMARY KEY, session_id TEXT, role TEXT,
    source_time INTEGER, last_verified_at INTEGER);
  CREATE TABLE IF NOT EXISTS indexed_parts (
    part_id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
    source_time INTEGER, field_count INTEGER, truncated INTEGER,
    indexed_at INTEGER, last_verified_at INTEGER);
  CREATE VIRTUAL TABLE IF NOT EXISTS indexed_evidence USING fts5(
    text, field UNINDEXED, part_id UNINDEXED);
`;

// Open (or reopen) the index. Corruption anywhere in the open path —
// quick_check, DDL, or a schema-version mismatch — deletes the file and
// rebuilds ONCE; a second failure returns null with the cause recorded.
// Returns { db, rebuilt } | { unsupported: true } | { failed: Error }.
async function openIndex() {
  _indexOpenFailure = null;
  const mod = await loadSqlite();
  if (!mod || typeof mod.DatabaseSync !== "function") return { unsupported: true };
  const path = _searchIndexPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    _indexOpenFailure = e;
    return { failed: e };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let db = null;
    try {
      db = new mod.DatabaseSync(path);
      const check = db.prepare("PRAGMA quick_check").get();
      if (!check || check.quick_check !== "ok") {
        throw new Error(`index corrupt (quick_check: ${check?.quick_check ?? "unknown"})`);
      }
      db.exec(DDL);
      const ver = db.prepare("SELECT value FROM index_meta WHERE key = 'schema_version'").get();
      if (ver == null) {
        db.prepare("INSERT INTO index_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
      } else if (ver.value !== SCHEMA_VERSION) {
        throw new Error(`index schema version ${ver.value} != ${SCHEMA_VERSION}`);
      }
      _indexDb = db;
      return { db, rebuilt: attempt > 0 };
    } catch (e) {
      if (db) {
        try {
          db.close();
        } catch {
          /* best effort */
        }
      }
      if (attempt === 0) {
        console.warn("[ctoSearchIndex] index unusable, rebuilding:", e?.message ?? e);
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try {
            rmSync(path + suffix, { force: true });
          } catch {
            /* best effort — the retry surfaces a persistent failure */
          }
        }
        continue;
      }
      _indexOpenFailure = e;
      return { failed: e };
    }
  }
  return { failed: _indexOpenFailure ?? new Error("index open failed") };
}

function readCursor(db) {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(CURSOR_KEY);
  if (!row) return { session: { ...CURSOR_START }, message: { ...CURSOR_START }, part: { ...CURSOR_START } };
  try {
    const parsed = JSON.parse(row.value);
    return {
      session: parsed?.session ?? { ...CURSOR_START },
      message: parsed?.message ?? { ...CURSOR_START },
      part: parsed?.part ?? { ...CURSOR_START },
    };
  } catch {
    return { session: { ...CURSOR_START }, message: { ...CURSOR_START }, part: { ...CURSOR_START } };
  }
}

// ---------------------------------------------------------------------------
// sync — one bounded, atomic batch
// ---------------------------------------------------------------------------

// Keyset over (COALESCE(time_updated,0), id): creation-time rows are caught
// once; an EDITED row (time_updated moves) is caught again. This is the
// "not creation-only" incremental rule (spec §4.3). Column lists are
// code-owned constants (no injection surface): `part` carries
// message_id + session_id; `message` carries session_id only.
function streamSql(table, extraCols) {
  return `SELECT id, ${extraCols} COALESCE(time_updated, 0) AS t, time_updated, data
          FROM ${table}
          WHERE (COALESCE(time_updated, 0) > ?) OR (COALESCE(time_updated, 0) = ? AND id > ?)
          ORDER BY COALESCE(time_updated, 0) ASC, id ASC
          LIMIT ?`;
}
const MESSAGE_STREAM_SQL = streamSql("message", "session_id,");
const PART_STREAM_SQL = streamSql("part", "session_id, message_id,");
const SESSION_STREAM_SQL = `SELECT id, parent_id, project_id, workspace_id, directory, title,
    time_created, time_updated, time_archived, COALESCE(time_updated, 0) AS t
  FROM session
  WHERE (COALESCE(time_updated, 0) > ?) OR (COALESCE(time_updated, 0) = ? AND id > ?)
  ORDER BY COALESCE(time_updated, 0) ASC, id ASC
  LIMIT ?`;

function advance(pos, rows) {
  if (!rows.length) return pos;
  return { t: rows[rows.length - 1].t, i: rows[rows.length - 1].id };
}

// Replace-semantics upsert of one part: previous FTS terms + row are deleted,
// then the current eligible evidence is inserted. A part that no longer
// yields candidates (or has unparseable data) removes any previous index rows.
function upsertPart(db, row, now) {
  const delEv = db.prepare("DELETE FROM indexed_evidence WHERE part_id = ?");
  const hadRow = db.prepare("SELECT 1 AS x FROM indexed_parts WHERE part_id = ?").get(row.id) != null;
  let part = null;
  try {
    part = row.data == null ? null : JSON.parse(row.data);
  } catch {
    part = null;
  }
  const candidates = part ? partCandidates(part) : [];
  if (!candidates.length) {
    delEv.run(row.id);
    const removed = hadRow ? 1 : 0;
    if (hadRow) db.prepare("DELETE FROM indexed_parts WHERE part_id = ?").run(row.id);
    return { upserted: 0, removed };
  }
  let budget = CTO_SEARCH_INDEX_LIMITS.partEvidenceMaxBytes;
  let truncated = false;
  const rows = [];
  for (const c of candidates) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const cap = Math.min(CTO_SEARCH_INDEX_LIMITS.fieldEvidenceMaxBytes, budget);
    const cut = cutUtf8(c.text, cap);
    if (cut.truncated || byteLen(c.text) > cap) truncated = true;
    budget -= byteLen(cut.text);
    rows.push([cut.text, c.field, row.id]);
  }
  delEv.run(row.id);
  db.prepare(
    `INSERT INTO indexed_parts (part_id, session_id, message_id, source_time, field_count, truncated, indexed_at, last_verified_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(part_id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id,
       source_time=excluded.source_time, field_count=excluded.field_count, truncated=excluded.truncated,
       indexed_at=excluded.indexed_at, last_verified_at=excluded.last_verified_at`,
  ).run(row.id, row.session_id, row.message_id, row.time_updated ?? 0, rows.length, truncated ? 1 : 0, now, now);
  const ins = db.prepare("INSERT INTO indexed_evidence (text, field, part_id) VALUES (?,?,?)");
  for (const r of rows) ins.run(...r);
  return { upserted: 1, removed: 0 };
}

function upsertMessage(db, row, now) {
  let role = null;
  try {
    const data = row.data == null ? null : JSON.parse(row.data);
    if (data && typeof data.role === "string") role = data.role;
  } catch {
    role = null;
  }
  db.prepare(
    `INSERT INTO indexed_messages (id, session_id, role, source_time, last_verified_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, role=excluded.role,
       source_time=excluded.source_time, last_verified_at=excluded.last_verified_at`,
  ).run(row.id, row.session_id, role, row.time_updated ?? 0, now);
}

function upsertSession(db, row, excluded, now) {
  const title = row.title == null ? null : cutUtf8(row.title, CTO_SEARCH_INDEX_LIMITS.sessionTitleMaxBytes).text;
  const provenance = excluded.has(row.id) ? "internal" : "unclassified";
  db.prepare(
    `INSERT INTO indexed_sessions (id, parent_id, project_id, workspace_id, directory, title, archived,
       provenance, time_created, time_updated, time_archived, source_time, last_verified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, project_id=excluded.project_id,
       workspace_id=excluded.workspace_id, directory=excluded.directory, title=excluded.title,
       archived=excluded.archived, provenance=excluded.provenance, time_created=excluded.time_created,
       time_updated=excluded.time_updated, time_archived=excluded.time_archived,
       source_time=excluded.source_time, last_verified_at=excluded.last_verified_at`,
  ).run(
    row.id, row.parent_id ?? null, row.project_id ?? null, row.workspace_id ?? null, row.directory ?? null,
    title, row.time_archived != null ? 1 : 0, provenance, row.time_created ?? null, row.time_updated ?? null,
    row.time_archived ?? null, row.t, now,
  );
}

// Bounded reconcile: verify a sample of indexed parts (oldest-verified first)
// against the source and drop rows whose source part is gone; refresh a
// sample of session mirrors' provenance (the registry may have grown since
// the session row last changed). Both are eventual and bounded per sync.
function reconcile(db, src, excluded, now) {
  let removed = 0;
  const delPart = db.prepare("DELETE FROM indexed_parts WHERE part_id = ?");
  const delEv = db.prepare("DELETE FROM indexed_evidence WHERE part_id = ?");
  const touchPart = db.prepare("UPDATE indexed_parts SET last_verified_at = ? WHERE part_id = ?");
  const livePart = src.prepare("SELECT 1 AS x FROM part WHERE id = ?");
  const sample = db
    .prepare("SELECT part_id FROM indexed_parts ORDER BY last_verified_at ASC, part_id ASC LIMIT ?")
    .all(CTO_SEARCH_INDEX_LIMITS.deleteReconcileMax);
  for (const p of sample) {
    if (livePart.get(p.part_id) == null) {
      delEv.run(p.part_id);
      delPart.run(p.part_id);
      removed++;
    } else {
      touchPart.run(now, p.part_id);
    }
  }
  let refreshed = 0;
  const touchSession = db.prepare(
    "UPDATE indexed_sessions SET provenance = ?, last_verified_at = ? WHERE id = ?",
  );
  const liveSession = src.prepare("SELECT 1 AS x FROM session WHERE id = ?");
  const delSession = db.prepare("DELETE FROM indexed_sessions WHERE id = ?");
  const sSample = db
    .prepare("SELECT id FROM indexed_sessions ORDER BY last_verified_at ASC, id ASC LIMIT ?")
    .all(CTO_SEARCH_INDEX_LIMITS.provenanceRefreshMax);
  for (const s of sSample) {
    if (liveSession.get(s.id) == null) {
      delSession.run(s.id);
    } else {
      touchSession.run(excluded.has(s.id) ? "internal" : "unclassified", now, s.id);
      refreshed++;
    }
  }
  return { removed, refreshed, verified: sample.length };
}

/**
 * Sync one bounded batch from the read-only source into the index.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]  rows per stream for this batch (clamped to
 *   CTO_SEARCH_INDEX_LIMITS.syncBatchMax = 500).
 * @param {() => Promise<string[] | Set<string>>} [opts.provenanceFilter]
 *   resolves the internal-ephemeral session IDs (established provenance,
 *   never titles). Defaults to the existing registry
 *   (`internalSessions.internalSessionIds`). A thrown error fails the batch
 *   closed without advancing the cursor.
 * @param {() => number} [opts.now]
 */
export async function ctoSearchIndexSync({ limit, provenanceFilter, now = Date.now } = {}) {
  const base = baseEnvelope();
  const batch = clampLimit(limit, CTO_SEARCH_INDEX_LIMITS.syncBatchDefault, CTO_SEARCH_INDEX_LIMITS.syncBatchMax);
  const resolveProvenance = provenanceFilter ?? internalSessionIds;

  let excluded;
  try {
    excluded = new Set(await resolveProvenance());
  } catch (e) {
    return { ...base, status: "provenance_unavailable", detail: `provenance registry failed: ${e?.message ?? e}`, coverage: { mode: "fts-index", indexedParts: null }, cursor: null, scanned: zeroCounts(), rebuilt: false };
  }

  const src = await getDb();
  if (!src) {
    const cause = getDbOpenFailure();
    const status = cause?.reason === "unsupported" ? "unsupported" : "source_unavailable";
    return { ...base, supported: status !== "unsupported", status, detail: cause?.detail ?? "no opencode source database is available on this box", coverage: { mode: "fts-index", indexedParts: null }, cursor: null, scanned: zeroCounts(), rebuilt: false };
  }

  const opened = await openIndex();
  if (opened.unsupported) {
    return { ...base, supported: false, status: "unsupported", detail: "node:sqlite unavailable on this runtime", coverage: { mode: "fts-index", indexedParts: null }, cursor: null, scanned: zeroCounts(), rebuilt: false };
  }
  if (!opened.db) {
    return { ...base, status: "index_unavailable", detail: `index could not be opened or rebuilt: ${opened.failed?.message ?? opened.failed}`, coverage: { mode: "fts-index", indexedParts: null }, cursor: null, scanned: zeroCounts(), rebuilt: false };
  }
  const db = opened.db;

  const counts = zeroCounts();
  try {
    db.exec("BEGIN IMMEDIATE");
    const cursor = readCursor(db);
    const sessionRows = src.prepare(SESSION_STREAM_SQL).all(cursor.session.t, cursor.session.t, cursor.session.i, batch);
    for (const row of sessionRows) upsertSession(db, row, excluded, now());
    const messageRows = src.prepare(MESSAGE_STREAM_SQL).all(cursor.message.t, cursor.message.t, cursor.message.i, batch);
    for (const row of messageRows) upsertMessage(db, row, now());
    const partRows = src.prepare(PART_STREAM_SQL).all(cursor.part.t, cursor.part.t, cursor.part.i, batch);
    for (const row of partRows) {
      if (_syncFault) _syncFault({ phase: "part", row });
      const r = upsertPart(db, row, now());
      counts.parts.upserted += r.upserted;
      counts.parts.removed += r.removed;
    }
    const rec = reconcile(db, src, excluded, now());
    counts.parts.removed += rec.removed;
    counts.refreshedSessions = rec.refreshed;
    counts.verifiedParts = rec.verified;
    counts.sessions.scanned = sessionRows.length;
    counts.messages.scanned = messageRows.length;
    counts.parts.scanned = partRows.length;
    counts.sessions.upserted = sessionRows.length;
    counts.messages.upserted = messageRows.length;
    const next = {
      session: advance(cursor.session, sessionRows),
      message: advance(cursor.message, messageRows),
      part: advance(cursor.part, partRows),
    };
    db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      CURSOR_KEY,
      JSON.stringify(next),
    );
    db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      "synced_at",
      JSON.stringify(new Date(now()).toISOString()),
    );
    db.exec("COMMIT");
    const total = db.prepare("SELECT count(*) AS n FROM indexed_parts").get().n;
    return {
      ...base,
      status: "ok",
      coverage: { mode: "fts-index", indexedParts: total },
      cursor: next,
      scanned: counts,
      rebuilt: opened.rebuilt === true,
    };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the handle is closed below anyway */
    }
    _closeSearchIndexHandle();
    console.error("[ctoSearchIndex] sync batch failed (cursor not advanced):", e?.message ?? e);
    return { ...base, status: "index_error", detail: `sync batch failed: ${e?.message ?? e}`, coverage: { mode: "fts-index", indexedParts: null }, cursor: null, scanned: zeroCounts(), rebuilt: false };
  }
}

// Test-only fault injection: called inside the batch transaction; throwing
// rolls everything back (pins "failed batch does not advance the cursor").
let _syncFault = null;
export function _setSyncFault(fn) {
  _syncFault = fn;
}

// ---------------------------------------------------------------------------
// search — bounded ranked query over the index ONLY (never the source)
// ---------------------------------------------------------------------------

function decodeSearchCursor(raw, expr) {
  if (typeof raw !== "string" || raw === "") return { ok: false };
  let json;
  try {
    json = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return { ok: false };
  }
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    return { ok: false };
  }
  if (!d || typeof d !== "object") return { ok: false };
  if (d.q !== expr) return { ok: false, reason: "cursor belongs to a different query" };
  if (typeof d.r !== "number" || !Number.isFinite(d.r)) return { ok: false };
  if (typeof d.i !== "string" || typeof d.f !== "string") return { ok: false };
  return { ok: true, cursor: d };
}

/**
 * Ranked search over the index.
 *
 * @param {object} [opts]
 * @param {string} opts.query  literal query text (see ftsQuery.mjs).
 * @param {string} [opts.sessionId]   observed source session ID filter.
 * @param {string} [opts.projectId]   observed source project_id filter.
 * @param {string} [opts.directory]   observed source directory filter.
 * @param {boolean} [opts.includeInternal]  include `internal` provenance
 *   rows (default false — ephemeral self-analysis stays out of ordinary
 *   project evidence).
 * @param {number} [opts.limit]  clamped to searchHitsMax (50); default 20.
 * @param {string} [opts.cursor]  nextCursor from a previous page; bound to
 *   the same query text.
 */
export async function ctoSearchIndexSearch({ query, sessionId, projectId, directory, includeInternal = false, limit, cursor } = {}) {
  const base = baseEnvelope();
  const parsed = ftsMatchExpression(query);
  if (!parsed.ok) {
    return { ...base, status: "invalid_input", detail: parsed.reason, coverage: { mode: "fts-index", indexedParts: null }, hits: [], nextCursor: null, truncated: false, omittedCount: 0 };
  }
  const cap = clampLimit(limit, CTO_SEARCH_INDEX_LIMITS.searchHitsDefault, CTO_SEARCH_INDEX_LIMITS.searchHitsMax);
  let cur = null;
  if (cursor != null) {
    const d = decodeSearchCursor(cursor, parsed.expr);
    if (!d.ok) {
      return { ...base, status: "invalid_input", detail: d.reason ?? "cursor is not a valid ctoSearchIndex cursor", coverage: { mode: "fts-index", indexedParts: null }, hits: [], nextCursor: null, truncated: false, omittedCount: 0 };
    }
    cur = d.cursor;
  }

  const opened = await openIndex();
  if (opened.unsupported) {
    return { ...base, supported: false, status: "unsupported", detail: "node:sqlite unavailable on this runtime", coverage: { mode: "fts-index", indexedParts: null }, hits: [], nextCursor: null, truncated: false, omittedCount: 0 };
  }
  if (!opened.db) {
    return { ...base, status: "index_unavailable", detail: `index could not be opened or rebuilt: ${opened.failed?.message ?? opened.failed}`, coverage: { mode: "fts-index", indexedParts: null }, hits: [], nextCursor: null, truncated: false, omittedCount: 0 };
  }
  const db = opened.db;

  try {
    const where = ["indexed_evidence MATCH ?"];
    const params = [parsed.expr];
    if (sessionId != null) {
      where.push("indexed_parts.session_id = ?");
      params.push(sessionId);
    }
    if (projectId != null) {
      where.push("indexed_sessions.project_id = ?");
      params.push(projectId);
    }
    if (directory != null) {
      where.push("indexed_sessions.directory = ?");
      params.push(directory);
    }
    if (includeInternal === false) {
      // NULL provenance (no mirror row) counts as unclassified — included.
      where.push("(indexed_sessions.provenance IS NULL OR indexed_sessions.provenance != 'internal')");
    }
    if (cur) {
      where.push("((rank > ?) OR (rank = ? AND indexed_evidence.part_id > ?) OR (rank = ? AND indexed_evidence.part_id = ? AND indexed_evidence.field > ?))");
      params.push(cur.r, cur.r, cur.i, cur.r, cur.i, cur.f);
    }
    const sql = `
      SELECT indexed_evidence.part_id AS part_id, indexed_evidence.field AS field,
             rank AS rank,
             snippet(indexed_evidence, 0, '', '', '…', ${CTO_SEARCH_INDEX_LIMITS.snippetTokens}) AS snip,
             indexed_parts.session_id AS session_id, indexed_parts.message_id AS message_id,
             indexed_parts.source_time AS source_time,
             indexed_messages.role AS role,
             indexed_sessions.provenance AS provenance
      FROM indexed_evidence
      JOIN indexed_parts ON indexed_parts.part_id = indexed_evidence.part_id
      LEFT JOIN indexed_messages ON indexed_messages.id = indexed_parts.message_id
      LEFT JOIN indexed_sessions ON indexed_sessions.id = indexed_parts.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY rank ASC, indexed_evidence.part_id ASC, indexed_evidence.field ASC
      LIMIT ?`;

    const rows = db.prepare(sql).all(...params, cap + 1);
    const more = rows.length > cap;
    const page = more ? rows.slice(0, cap) : rows;
    const total = db.prepare("SELECT count(*) AS n FROM indexed_parts").get().n;
    const coverage = { mode: "fts-index", indexedParts: total, cursor: readCursor(db) };

    // Cursor key material per row, captured BEFORE the budget guard: the
    // keyset is (rank, part_id, field) over the SAME query text.
    const hitKeys = page.map((row) => JSON.stringify({ q: parsed.expr, r: row.rank, i: row.part_id, f: row.field }));
    const hits = page.map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      partId: row.part_id,
      field: row.field,
      kind: row.field === "text" ? "text" : "tool",
      role: row.role ?? null,
      provenance: row.provenance ?? "unclassified",
      timeUpdated: row.source_time ?? null,
      snippet: row.snip ?? "",
    }));

    // ONE authoritative budget on the SERIALIZED response (spec §4.2):
    // overflow drops TAIL hits — each omission is counted and stays
    // reachable on the next page (the cursor stays at the last EMITTED hit).
    let omittedCount = 0;
    let truncated = false;
    const serialized = () => byteLen(JSON.stringify({ hits }));
    while (hits.length > 0 && serialized() > CTO_SEARCH_INDEX_LIMITS.responseBudgetBytes) {
      hits.pop();
      omittedCount++;
      truncated = true;
    }

    let nextCursor = null;
    if (hits.length > 0 && (more || truncated)) {
      nextCursor = Buffer.from(hitKeys[hits.length - 1]).toString("base64");
    } else if (hits.length === 0 && more) {
      // Everything on this page was budget-dropped: advance past the last
      // consumed row so the walk makes progress (retryable on the next page).
      nextCursor = Buffer.from(hitKeys[hitKeys.length - 1]).toString("base64");
    }
    if (more) truncated = true;
    return { ...base, status: "ok", coverage, hits, nextCursor, truncated, omittedCount, rebuilt: opened.rebuilt === true };
  } catch (e) {
    _closeSearchIndexHandle();
    console.error("[ctoSearchIndex] search failed:", e?.message ?? e);
    return { ...base, status: "index_error", detail: `search failed: ${e?.message ?? e}`, coverage: { mode: "fts-index", indexedParts: null }, hits: [], nextCursor: null, truncated: false, omittedCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// status — honest diagnostics (counts + cursor; used by tests and future wiring)
// ---------------------------------------------------------------------------

export async function ctoSearchIndexStatus() {
  const base = baseEnvelope();
  const opened = await openIndex();
  if (opened.unsupported) return { ...base, supported: false, status: "unsupported", detail: "node:sqlite unavailable on this runtime" };
  if (!opened.db) return { ...base, status: "index_unavailable", detail: `index could not be opened or rebuilt: ${opened.failed?.message ?? opened.failed}` };
  const db = opened.db;
  try {
    const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    return {
      ...base,
      status: "ok",
      counts: { sessions: count("indexed_sessions"), messages: count("indexed_messages"), parts: count("indexed_parts"), evidence: count("indexed_evidence") },
      cursor: readCursor(db),
      rebuilt: opened.rebuilt === true,
    };
  } catch (e) {
    _closeSearchIndexHandle();
    return { ...base, status: "index_error", detail: `status failed: ${e?.message ?? e}` };
  }
}
