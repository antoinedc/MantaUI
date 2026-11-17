// ctoSearchIndex.mjs — the Manta-owned SQLite FTS5 search index over
// opencode's read-only source (unified-CTO spec §4.1/§4.3, P1b1 RESCOPED
// slice: safe index lifecycle + bounded refresh + FIRST-PAGE search only,
// as a factory module API. No tool, no UI, no poller wiring, no pagination —
// a `cursor` argument is explicitly rejected until P1b2).
//
// Invariants:
//   • READ-ONLY SOURCE. Evidence is read through the shared `opencodeDb.mjs`
//     handle; the index never writes to the source.
//   • ONE OWNED CONNECTION. Each instance owns exactly ONE SQLite connection
//     to its index file, reused across every operation, with an explicit
//     `close()` (ops after close fail `index_closed`). The connection
//     factory is injectable (tests count opens/closes).
//   • DISPOSABLE, NEVER DESTRUCTIVE. The index lives at
//     `statePath("cto", "search-index.sqlite")` by default (injectable path)
//     so the `MANTA_STATE_HOME` sandbox covers it. Open failures classify as
//     retryable `index_busy` or explicit `index_corrupt` (quick_check /
//     foreign schema version) and the file is RETAINED — this module never
//     unlinks or rewrites it; recovery is a deliberate later step.
//   • BOUNDED CYCLIC REFRESH (eventual, not a snapshot). NO watermark CDC:
//     each `sync()` re-reads one bounded batch per stream (sessions,
//     messages, parts) at a cycling position persisted in the index, so
//     EVERY source row — including content edited without moving
//     `time_updated` and late rows with old timestamps — is re-read every
//     cycle and re-indexed when changed (parts hash-gated, mirrors plain
//     upserts). `coverage.eventual` says so; index absence is NOT
//     authoritative absence (P1a direct reads remain the fallback).
//     DELETION verification uses the same rotating per-table keyset (rowid)
//     cursor, so every indexed row — not just the first N — is existence-
//     checked once per cycle; absence is eventual within documented cycles.
//   • OWNERSHIP BEFORE ANY WRITE. The canonical index path (realpath,
//     symlinks resolved) must differ from the source DB, and an EXISTING
//     file at the path is validated READ-ONLY first: no Manta marker
//     (`PRAGMA application_id` + schema_version) → `unowned_index`, the
//     foreign/source database preserved byte- and row-identical. Only a
//     fresh file (or a file carrying our marker) is initialized, markers
//     written atomically inside one transaction.
//   • SINGLEFLIGHT INITIALIZATION. Concurrent operations share ONE opening
//     promise (exactly one handle); `close()` during a pending open settles
//     it by closing the handle exactly once and every in-flight operation
//     reports `index_closed` instead of a late success.
//   • INCOMPLETENESS IS METADATA, NEVER SILENT. Extraction bounds and byte
//     caps persist per document (`indexed_parts.incomplete`/`.truncated`);
//     `search`/`status`/`sync` report the index-wide `incompleteParts`
//     coverage even when a query has zero hits. Numeric counters are always
//     initialized (a zero-change batch reports 0s, never undefined/NaN).
//   • EVIDENCE, BOUNDED AND HONEST. Extraction walks the part JSON with
//     explicit scalar/node/depth bounds and REPORTS every omission (incl.
//     depth caps) instead of silently dropping the 33rd scalar. Eligible
//     classes mirror the P1a-reviewed contract (ctoContext
//     `partCandidates`): text parts contribute `$.text` only
//     (synthetic/ignored excluded); tool parts contribute tool name /
//     `state.input` / `state.output` scalars. Reasoning and metadata are
//     never evidence. Byte caps (per-field, per-part) are UTF-8-safe.
//   • PROVENANCE FROM THE AUTHORITATIVE REGISTRY. Internal-ephemeral
//     exclusion is resolved at BOTH sync and search time from the injected
//     `provenanceFilter` (default: the established `internalSessions`
//     registry — session IDs, never titles), independent of mirror
//     progress: a part indexed before its session mirror row exists is
//     still excluded. An inaccessible registry fails the operation CLOSED
//     (`provenance_unavailable`; no partial answers). Recorded values are
//     `internal` / `unclassified` only — never inferred.
//   • FIRST-PAGE SEARCH. `search()` returns at most `limit` ranked hits
//     (server-side clamp) from a bounded scan window, with `truncated` and
//     `omittedCount` when more existed — never a cursor that rank/index
//     churn would invalidate. A `cursor` argument is `invalid_input`.
//   • HONEST STATUSES. `unsupported` (no node:sqlite — lazy import, Node 20
//     degrades, never a static import), `source_unavailable`,
//     `provenance_unavailable`, `index_corrupt` (retained on disk),
//     `index_busy` (retryable lock), `index_error`, `index_closed`,
//     `invalid_input` are distinct. Empty results over a healthy index are
//     `ok` WITH coverage counts — never a fabricated "nothing happened".
//
//   • RECENT-FIRST, THEN EVERYTHING (shared-knowledge §7.2). The cyclic sweep
//     walks every stream NEWEST first, so a fresh index answers about recent work
//     long before the whole history is read. A separate head pass reads, in order
//     and without gaps, whatever is newer than the newest row already seen, so new
//     activity is indexed on the next sync rather than a whole cycle later.
//   • BOUNDED SIZE. The index is capped (default 1 GiB, `maxBytes`). Over the
//     cap, `sync()` evicts the OLDEST sessions down to ~90 % of it in one round
//     and records an eviction floor: the sweep never re-reads anything at or
//     below the floor, so evicted history is not indexed again and evicted again.
//     The cap is on LIVE bytes (pages in use); FTS5 deletes only free space after
//     a compaction, so an eviction that does not get under the cap also runs an
//     FTS5 `optimize` — a full rewrite of the index (seconds per 100 MB on the
//     calling thread), paid once per round, i.e. once per ~10 % of the cap indexed.
//
// Query policy: the user's query is LITERAL text — see ftsQuery.mjs. `search()`
// takes `anyTerms: true` for a ranked OR of the terms (otherwise every term must
// match) and `directories: [...]` to restrict hits to a SET of session
// directories (an empty set matches nothing).

import { existsSync, mkdirSync, realpathSync } from "node:fs";
// `join` is used by canonicalPath's symlinked-parent fallback. It was never
// imported, so that fallback threw a ReferenceError instead of resolving the
// path — and because the throw sat inside a nested `catch`, it was swallowed
// into the outer `return p`, silently degrading canonicalisation to the raw
// path for every not-yet-existing file.
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { getDb, getDbOpenFailure, resolveDbPath, PART_SQL, MESSAGE_SQL, partExists } from "./opencodeDb.mjs";
import { runOnHandle } from "./dbOffload.mjs";

// Wall-clock budget of one sync batch's windowed source reads (db worker, off the event loop).
const SYNC_READ_BUDGET_MS = 30_000;
import { internalSessionIds } from "./internalSessions.mjs";
import { ftsMatchExpression, ftsAnyTermExpression } from "./ftsQuery.mjs";

export const CTO_SEARCH_INDEX_LIMITS = Object.freeze({
  // One sync re-reads AT MOST `limit` rows PER STREAM (clamped server-side).
  syncBatchDefault: 200,
  syncBatchMax: 500,
  // Spec §4.2 search defaults, enforced server-side.
  searchHitsDefault: 20,
  searchHitsMax: 50,
  // Bounded scan window for one search call (raw rows fetched before filtering).
  searchScanWindow: 200,
  // Spec §4.2: 24 KiB returned text per call, measured on the serialized response.
  responseBudgetBytes: 24 * 1024,
  // Extraction bounds — explicit; omissions are REPORTED, never silent drops.
  maxScalars: 64,
  maxNodes: 512,
  maxDepth: 6,
  // Bytes-first evidence caps (UTF-8), applied at index time.
  fieldEvidenceMaxBytes: 8 * 1024,
  partEvidenceMaxBytes: 16 * 1024,
  sessionTitleMaxBytes: 512,
  // Bounded deletion reconciliation per sync call.
  deleteReconcileMax: 64,
  sessionVerifyMax: 16,
  // FTS5 snippet bounds (tokens) — per-hit text bounded by construction.
  snippetTokens: 24,
  // Size cap of the index file (live bytes) and where one eviction round stops.
  maxIndexBytes: 1024 * 1024 * 1024,
  evictTargetRatio: 0.9,
  // Most directories one search may filter on.
  searchDirectoriesMax: 20_000,
});

const SCHEMA_VERSION = "2";
// Beyond any epoch ms: the top of the newest-first walk.
const MAX_T = Number.MAX_SAFE_INTEGER;
const MAX_EVICT_ROUNDS = 4;
// Ownership marker in the file header ("MANT"): an existing database at the
// index path without it is foreign and is never written.
const APPLICATION_ID = 0x4d414e54;
const INDEX_FILENAME = "search-index.sqlite";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const byteLen = (s) => ENC.encode(s).length;

const DDL = `
  CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS indexed_sessions (
    id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, workspace_id TEXT,
    directory TEXT, title TEXT, archived INTEGER, provenance TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
  CREATE TABLE IF NOT EXISTS indexed_messages (
    id TEXT PRIMARY KEY, session_id TEXT, role TEXT, source_time INTEGER);
  CREATE TABLE IF NOT EXISTS indexed_parts (
    part_id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
    source_time INTEGER, field_count INTEGER, truncated INTEGER,
    incomplete INTEGER, data_hash TEXT);
  CREATE INDEX IF NOT EXISTS indexed_parts_session ON indexed_parts(session_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS indexed_evidence USING fts5(
    text, field UNINDEXED, part_id UNINDEXED);
`;

function defaultIndexPath() {
  return statePath("cto", INDEX_FILENAME);
}

// Test-only: the resolved default path (asserts sandbox coverage).
export function _defaultSearchIndexPath() {
  return defaultIndexPath();
}

async function defaultLoadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (e) {
    console.warn("[ctoSearchIndex] node:sqlite unavailable:", e?.message ?? e);
    return null;
  }
}

function clampLimit(value, dflt, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

// UTF-8-safe cut to `maxBytes` without splitting a code point.
function cutUtf8(text, maxBytes) {
  if (byteLen(text) <= maxBytes) return { text, truncated: false };
  const bytes = ENC.encode(text);
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end--;
  return { text: DEC.decode(bytes.subarray(0, end)), truncated: true };
}

function sha256(s) {
  return createHash("sha256").update(s ?? "").digest("hex");
}

// ---------------------------------------------------------------------------
// Bounded evidence extraction — mirrors the P1a eligibility contract
// (ctoContext ELIGIBLE_PATH_CLASSES) with EXPLICIT, REPORTED bounds.
// ---------------------------------------------------------------------------

// text → $.text only; tool → $.tool + $.state.input + $.state.output
// scalars. A scalar is a string (verbatim) or any non-null primitive
// (String()-ed) — objects/arrays are walked, never serialized wholesale.
function extractEvidence(part, limits) {
  const out = { candidates: [], omittedScalars: 0, omittedNodes: 0, depthCapped: false };
  if (!part || typeof part !== "object") return out;
  const budget = { scalars: limits.maxScalars, nodes: limits.maxNodes };

  const push = (field, value) => {
    if (budget.scalars <= 0) {
      out.omittedScalars++;
      return;
    }
    if (typeof value === "string") {
      if (value !== "") {
        out.candidates.push({ field, text: value });
        budget.scalars--;
      }
      return;
    }
    if (value != null && typeof value !== "object") {
      out.candidates.push({ field, text: String(value) });
      budget.scalars--;
    }
  };
  const walk = (value, field, depth) => {
    if (budget.nodes <= 0) {
      out.omittedNodes++;
      return;
    }
    budget.nodes--;
    if (depth > limits.maxDepth) {
      out.depthCapped = true;
      return;
    }
    if (value != null && typeof value === "object") {
      for (const v of Array.isArray(value) ? value : Object.values(value)) walk(v, field, depth + 1);
      return;
    }
    push(field, value);
  };

  if (part.type === "text") {
    if (!part.synthetic && !part.ignored && typeof part.text === "string" && part.text !== "") {
      out.candidates.push({ field: "text", text: part.text });
    }
    return out;
  }
  if (part.type === "tool") {
    if (typeof part.tool === "string" && part.tool !== "") out.candidates.push({ field: "tool_name", text: part.tool });
    const state = part.state && typeof part.state === "object" ? part.state : null;
    walk(state?.input, "input", 0);
    walk(state?.output, "output", 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The index instance — ONE owned connection, explicit lifecycle
// ---------------------------------------------------------------------------

/**
 * Create one search-index instance.
 *
 * @param {object} [deps]
 * @param {string} [deps.path]  index file path (default
 *   `statePath("cto", "search-index.sqlite")`).
 * @param {() => Promise<string[] | Set<string>>} [deps.provenanceFilter]
 *   resolves internal-ephemeral session IDs (established provenance, never
 *   titles); defaults to the existing `internalSessions` registry. A thrown
 *   error fails sync AND search closed (`provenance_unavailable`).
 * @param {() => number} [deps.now]
 * @param {{ DatabaseSync: Function } | null} [deps.sqliteModule]  injectable
 *   node:sqlite module (tests count connections; `null` → `unsupported`).
 *   Default: lazy `import("node:sqlite")` on first use.
 * @param {number} [deps.maxBytes]  size cap of the index (live bytes); default 1 GiB.
 */
export function createCtoSearchIndex(deps = {}) {
  const {
    path = defaultIndexPath(),
    provenanceFilter = internalSessionIds,
    now = Date.now,
    sqliteModule,
    maxBytes = CTO_SEARCH_INDEX_LIMITS.maxIndexBytes,
  } = deps;

  let db = null;
  let closed = false;
  let cachedModule = sqliteModule === undefined ? null : sqliteModule; // null = unresolved

  function baseEnvelope() {
    return { supported: true, status: "ok", observedAt: new Date().toISOString() };
  }
  // Honest coverage whenever a result is NOT a successful read/sync.
  const uncovered = () => ({ mode: "fts-index", indexedParts: null, eventual: true });
  // `supported:false` means THIS BOX cannot perform the operation at all
  // (no node:sqlite, no source database, or a closed instance) — the same
  // contract ctoContext uses. Explicit failure statuses (corrupt/busy/
  // error/unowned) leave supported:true: the runtime is capable, the
  // operation failed for the stated reason.
  const operationSupported = (status) => status !== "unsupported" && status !== "source_unavailable" && status !== "index_closed";

  function closedEnvelope(op) {
    return { ...baseEnvelope(), supported: false, status: "index_closed", detail: `index instance is closed (${op}); create a new instance` };
  }

  // Locks are retryable; corruption is explicit and the file is NEVER unlinked.
  function classifyError(e) {
    const code = e?.errcode ?? e?.code;
    const msg = String(e?.message ?? e);
    if (code === 5 || /busy|locked/i.test(msg)) return "index_busy";
    if (code === 11 || code === 26 || /corrupt|not a database|malformed/i.test(msg)) return "index_corrupt";
    return "index_error";
  }

  async function loadModule() {
    if (sqliteModule !== undefined) {
      if (typeof sqliteModule === "function") return await sqliteModule();
      return sqliteModule;
    }
    if (cachedModule !== null) return cachedModule;
    cachedModule = await defaultLoadSqlite();
    return cachedModule;
  }

  // Canonical form with symlinks resolved; a not-yet-existing path falls
  // back to its real parent + basename (still detects a symlinked parent).
  function canonicalPath(p) {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(p)), p === dirname(p) ? "." : (p.split("/").pop() || p));
      } catch {
        return p;
      }
    }
  }

  // Open (or reuse) the ONE owned connection — SINGLEFLIGHT: concurrent
  // operations share one opening promise, so N concurrent ops open exactly
  // one handle. Never destructive on failure; an EXISTING file at the path
  // is validated READ-ONLY before any writable open/DDL:
  //   • canonical path === source DB path        → unowned_index (no open)
  //   • foreign database (no Manta marker)       → unowned_index, untouched
  //   • not a database / our marker + bad version→ index_corrupt, retained
  //   • locks                                    → retryable index_busy
  // A fresh file is initialized atomically (application_id + DDL + schema
  // marker in ONE transaction) inside the owned namespace.
  let initPromise = null;
  async function doOpen() {
    const mod = await loadModule();
    if (!mod || typeof mod.DatabaseSync !== "function") return { unsupported: true };
    const srcPath = resolveDbPath();
    if (srcPath && canonicalPath(path) === canonicalPath(srcPath)) {
      return { status: "unowned_index", detail: "index path resolves to the read-only source database; refusing to open writable" };
    }
    if (existsSync(path)) {
      // Read-only ownership probe FIRST — a foreign/source file is never touched.
      let ro = null;
      try {
        ro = new mod.DatabaseSync(path, { readOnly: true });
        const check = ro.prepare("PRAGMA quick_check").get();
        if (!check || check.quick_check !== "ok") {
          return { status: "index_corrupt", detail: `index failed quick_check (${check?.quick_check ?? "unknown"}); file retained — explicit recovery required` };
        }
        const appId = ro.prepare("PRAGMA application_id").get();
        if (!appId || appId.application_id !== APPLICATION_ID) {
          return { status: "unowned_index", detail: "existing database at the index path carries no Manta search-index marker; preserved untouched" };
        }
        const ver = ro.prepare("SELECT value FROM index_meta WHERE key = 'schema_version'").get();
        if (ver == null || ver.value !== SCHEMA_VERSION) {
          return { status: "index_corrupt", detail: `index schema version ${ver?.value ?? "missing"} != ${SCHEMA_VERSION}; file retained — explicit recovery required` };
        }
      } catch (e) {
        const status = classifyError(e);
        const detail = status === "index_corrupt"
          ? `index probe failed: ${e?.message ?? e}; file retained — explicit recovery required`
          : `index probe failed: ${e?.message ?? e}`;
        return { status, detail };
      } finally {
        if (ro) {
          try {
            ro.close();
          } catch {
            /* best effort */
          }
        }
      }
    } else {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch (e) {
        return { status: "index_error", detail: `cannot create index directory: ${e?.message ?? e}` };
      }
    }
    let d;
    try {
      d = new mod.DatabaseSync(path);
    } catch (e) {
      return { status: classifyError(e), detail: `cannot open index: ${e?.message ?? e}` };
    }
    try {
      // A brand-new file: let freed pages be handed back to the OS after an eviction.
      if (d.prepare("PRAGMA page_count").get().page_count === 0) d.exec("PRAGMA auto_vacuum = INCREMENTAL");
      d.exec("BEGIN IMMEDIATE");
      d.exec(DDL);
      const ver = d.prepare("SELECT value FROM index_meta WHERE key = 'schema_version'").get();
      if (ver == null) {
        d.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
        d.prepare("INSERT INTO index_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
      }
      d.exec("COMMIT");
      return { db: d };
    } catch (e) {
      try {
        d.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
      try {
        d.close();
      } catch {
        /* best effort */
      }
      const status = classifyError(e);
      const detail = status === "index_corrupt"
        ? `index open failed: ${e?.message ?? e}; file retained — explicit recovery required`
        : `index open failed: ${e?.message ?? e}`;
      return { status, detail };
    }
  }

  function openIndex() {
    if (db) return Promise.resolve({ db });
    if (closed) return Promise.resolve({ status: "index_closed", detail: "index instance is closed" });
    if (!initPromise) {
      initPromise = doOpen();
      // Settled ONCE: on success the owned handle is adopted; if close()
      // happened during the await, the handle is closed exactly here and
      // never handed out; a failure clears the flight so a later op may retry.
      initPromise.then(
        (result) => {
          if (closed) {
            if (result.db) {
              try {
                result.db.close();
              } catch {
                /* best effort */
              }
            }
            initPromise = null;
            return;
          }
          if (result.db) db = result.db;
          else initPromise = null;
        },
        () => {
          initPromise = null;
        },
      );
    }
    return initPromise;
  }

  // Sweep state, one JSON value: `cycle` = where the NEWEST-FIRST walk of each
  // stream resumes (descending keyset), `head` = the newest row already seen per
  // stream (null until the first read), read upward gap-free by the head pass.
  // `floor` (separate key) is the eviction floor. A state written by an older
  // layout (no `v: 2`) is ignored: the walk simply starts again from the top.
  const SWEEP_START = { t: MAX_T, i: "" };
  const freshSweep = () => ({
    cycle: { session: { ...SWEEP_START }, message: { ...SWEEP_START }, part: { ...SWEEP_START } },
    head: { session: null, message: null, part: null },
  });
  function sweepPosition(db) {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'sweep'").get();
    const out = freshSweep();
    if (row) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed?.v === 2) {
          for (const name of ["session", "message", "part"]) {
            if (parsed.cycle?.[name]) out.cycle[name] = parsed.cycle[name];
            if (parsed.head?.[name]) out.head[name] = parsed.head[name];
          }
        }
      } catch {
        /* defaults */
      }
    }
    return out;
  }
  function evictionFloor(db) {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'evict_floor'").get();
    const n = Number(row?.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const setMeta = (db, key, value) =>
    db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

  // Cycling keyset sweeps, NEWEST FIRST — re-reads EVERY row each cycle: same-timestamp edits
  // and late rows are reflected eventually (bounded, no watermark CDC). Column lists are
  // code-owned constants; `session_v2` has no `data` column (verified V2 schema).
  //   • session: keyed (COALESCE(time_updated,0), id) — a few thousand rows, one query.
  //   • message / part: keyed (time_created, id). They read the V2 projections
  //     (MESSAGE_SQL / PART_SQL), whose rows have NO index on time_updated: a
  //     time_updated keyset forced a full scan + sort of the multi-GB message table per
  //     batch (>150 s on the real history). time_created IS indexed, so these streams
  //     walk it in WINDOWS (dbTasks.scanWindows) off the main thread. A part's
  //     time_updated is still its message's, so an edited message is re-indexed the
  //     next time the cycle passes its time_created.
  // The head pass is the same query mirrored (ascending, strictly after the head).
  const SESSION_T = "COALESCE(time_updated, 0)";
  const SESSION_COLS = "id, parent_id, project_id, workspace_id, directory, title, time_created, time_updated, time_archived";
  const SESSION_CYCLE_SQL = `SELECT ${SESSION_COLS}, ${SESSION_T} AS t
            FROM session_v2
            WHERE ((${SESSION_T} < ?) OR (${SESSION_T} = ? AND id < ?)) AND ${SESSION_T} > ?
            ORDER BY ${SESSION_T} DESC, id DESC
            LIMIT ?`;
  const SESSION_HEAD_SQL = `SELECT ${SESSION_COLS}, ${SESSION_T} AS t
            FROM session_v2
            WHERE (${SESSION_T} > ?) OR (${SESSION_T} = ? AND id > ?)
            ORDER BY ${SESSION_T} ASC, id ASC
            LIMIT ?`;
  const timeSweepSql = (table, cols, withData, dir) =>
    `SELECT id, ${cols} time_created AS t, time_updated${withData ? ", data" : ""}
            FROM ${table} p
            WHERE ${dir === "desc" ? "(p.time_created < ? OR (p.time_created = ? AND p.id < ?))" : "(p.time_created > ? OR (p.time_created = ? AND p.id > ?))"} /*RANGE*/
            ORDER BY p.time_created ${dir === "desc" ? "DESC" : "ASC"}, p.id ${dir === "desc" ? "DESC" : "ASC"}`;
  const STREAMS = {
    session: { cycleSql: SESSION_CYCLE_SQL, headSql: SESSION_HEAD_SQL },
    message: {
      windowed: true,
      cycleSql: timeSweepSql(MESSAGE_SQL, "session_id, role,", false, "desc"),
      headSql: timeSweepSql(MESSAGE_SQL, "session_id, role,", false, "asc"),
    },
    part: {
      windowed: true,
      cycleSql: timeSweepSql(PART_SQL, "session_id, message_id,", true, "desc"),
      headSql: timeSweepSql(PART_SQL, "session_id, message_id,", true, "asc"),
    },
  };

  // One stream's two reads: the head pass (rows after the head, oldest first) and the
  // newest-first cycle batch (below the cycle position, above the eviction floor).
  async function readStream(src, name, pos, floor, batch) {
    const stream = STREAMS[name];
    const cycle = pos.cycle[name];
    const head = pos.head[name];
    const out = { head: [], cycle: [], cycleAtEnd: false };
    if (stream.windowed) {
      const scan = (args) => runOnHandle(src, "windowedRows", { col: "p.time_created", limit: batch, windowMessages: 200, budgetMs: SYNC_READ_BUDGET_MS, ...args });
      if (head) out.head = (await scan({ sql: stream.headSql, params: [head.t, head.t, head.i], dir: "asc", from: Math.max(0, head.t) })).rows;
      // `atEnd`: the walk reached the floor — the cycle is complete. A scan that hit its
      // budget (neither complete nor full) just resumes from the last row next batch.
      const r = await scan({ sql: stream.cycleSql, params: [cycle.t, cycle.t, cycle.i], dir: "desc", from: cycle.t, ...(floor > 0 ? { to: floor + 1 } : {}) });
      out.cycle = r.rows;
      out.cycleAtEnd = r.complete;
    } else {
      if (head) out.head = src.prepare(stream.headSql).all(head.t, head.t, head.i, batch);
      out.cycle = src.prepare(stream.cycleSql).all(cycle.t, cycle.t, cycle.i, floor, batch);
      out.cycleAtEnd = out.cycle.length < batch;
    }
    return out;
  }

  function advanceOrCycle(pos, rows, atEnd) {
    if (atEnd) return { ...SWEEP_START }; // cycle complete
    if (rows.length === 0) return pos; // budget ran out before any row: try again from here
    const last = rows[rows.length - 1];
    return { t: last.t, i: last.id };
  }

  // The head only ever moves up: to the newest row of an ascending head read, or — on the
  // very first read — to the newest row of a cycle batch that started at the top.
  function advanceHead(pos, name, read) {
    if (read.head.length > 0) {
      const last = read.head[read.head.length - 1];
      return { t: last.t, i: last.id };
    }
    const atTop = pos.cycle[name].t === MAX_T;
    if (pos.head[name] == null && atTop && read.cycle.length > 0) return { t: read.cycle[0].t, i: read.cycle[0].id };
    return pos.head[name];
  }

  function upsertSession(row, excluded) {
    const title = row.title == null ? null : cutUtf8(row.title, CTO_SEARCH_INDEX_LIMITS.sessionTitleMaxBytes).text;
    const provenance = excluded.has(row.id) ? "internal" : "unclassified";
    db.prepare(
      `INSERT INTO indexed_sessions (id, parent_id, project_id, workspace_id, directory, title, archived,
         provenance, time_created, time_updated, time_archived)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, project_id=excluded.project_id,
         workspace_id=excluded.workspace_id, directory=excluded.directory, title=excluded.title,
         archived=excluded.archived, provenance=excluded.provenance, time_created=excluded.time_created,
         time_updated=excluded.time_updated, time_archived=excluded.time_archived`,
    ).run(
      row.id, row.parent_id ?? null, row.project_id ?? null, row.workspace_id ?? null, row.directory ?? null,
      title, row.time_archived != null ? 1 : 0, provenance, row.time_created ?? null, row.time_updated ?? null,
      row.time_archived ?? null,
    );
  }

  function upsertMessage(row) {
    // V2: the role is derived from the message type by MESSAGE_SQL (user | assistant).
    const role = typeof row.role === "string" ? row.role : null;
    db.prepare(
      `INSERT INTO indexed_messages (id, session_id, role, source_time) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, role=excluded.role,
         source_time=excluded.source_time`,
    ).run(row.id, row.session_id, role, row.time_updated ?? 0);
  }

  // Hash-gated replace: unchanged rows skip FTS churn; changed rows REPLACE
  // their terms (stale term disappears); ineligible parts remove prior rows.
  function upsertPart(row) {
    const hash = sha256(row.data ?? "");
    const existing = db.prepare("SELECT data_hash FROM indexed_parts WHERE part_id = ?").get(row.id);
    if (existing && existing.data_hash === hash) return { changed: false, indexed: false, omitted: 0, truncated: false };
    let part = null;
    try {
      part = row.data == null ? null : JSON.parse(row.data);
    } catch {
      part = null;
    }
    const extraction = extractEvidence(part, CTO_SEARCH_INDEX_LIMITS);
    // Depth caps are invisible in the candidate list — persist them.
    const omitted = extraction.omittedScalars + extraction.omittedNodes + (extraction.depthCapped ? 1 : 0);
    let budget = CTO_SEARCH_INDEX_LIMITS.partEvidenceMaxBytes;
    let truncated = false;
    const evRows = [];
    for (const c of extraction.candidates) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const cap = Math.min(CTO_SEARCH_INDEX_LIMITS.fieldEvidenceMaxBytes, budget);
      const cut = cutUtf8(c.text, cap);
      if (cut.truncated || byteLen(c.text) > cap) truncated = true;
      budget -= byteLen(cut.text);
      evRows.push([cut.text, c.field, row.id]);
    }
    db.prepare("DELETE FROM indexed_evidence WHERE part_id = ?").run(row.id);
    if (!evRows.length) {
      db.prepare("DELETE FROM indexed_parts WHERE part_id = ?").run(row.id);
      return { changed: true, omitted, truncated: false, indexed: false };
    }
    const incomplete = omitted > 0 || truncated ? 1 : 0;
    db.prepare(
      `INSERT INTO indexed_parts (part_id, session_id, message_id, source_time, field_count, truncated, incomplete, data_hash)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(part_id) DO UPDATE SET session_id=excluded.session_id, message_id=excluded.message_id,
         source_time=excluded.source_time, field_count=excluded.field_count, truncated=excluded.truncated,
         incomplete=excluded.incomplete, data_hash=excluded.data_hash`,
    ).run(row.id, row.session_id, row.message_id, row.time_updated ?? 0, evRows.length, truncated ? 1 : 0, incomplete, hash);
    const ins = db.prepare("INSERT INTO indexed_evidence (text, field, part_id) VALUES (?,?,?)");
    for (const r of evRows) ins.run(...r);
    return { changed: true, omitted, truncated, indexed: true };
  }

  // Bounded deletion reconcile with a ROTATING per-table keyset cursor
  // (rowid): every indexed row — not just the first N — is existence-checked
  // once per cycle (batch wraps to the start when the table tail is reached),
  // so deletion of part N+65 is also eventual. The sweep reads SOURCE rows
  // and cannot see deletions; this pass is what bounds them.
  function verifyPosition() {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'verify'").get();
    const start = { part: 0, session: 0 };
    if (!row) return start;
    try {
      const parsed = JSON.parse(row.value);
      return { part: parsed?.part ?? 0, session: parsed?.session ?? 0 };
    } catch {
      return start;
    }
  }

  function reconcileDeletions(src) {
    let removed = 0;
    const verify = verifyPosition();
    const next = {};
    
    const pRows = db
      .prepare("SELECT part_id, rowid AS rid FROM indexed_parts WHERE rowid > ? ORDER BY rowid ASC LIMIT ?")
      .all(verify.part, CTO_SEARCH_INDEX_LIMITS.deleteReconcileMax);
    for (const p of pRows) {
      if (!partExists(src, p.part_id)) {
        db.prepare("DELETE FROM indexed_evidence WHERE part_id = ?").run(p.part_id);
        db.prepare("DELETE FROM indexed_parts WHERE part_id = ?").run(p.part_id);
        removed++;
      }
    }
    // Full cycle reached (fewer rows than the batch) → wrap to the start.
    next.part = pRows.length < CTO_SEARCH_INDEX_LIMITS.deleteReconcileMax ? 0 : pRows[pRows.length - 1].rid;
    const liveSession = src.prepare("SELECT 1 AS x FROM session_v2 WHERE id = ?");
    const sRows = db
      .prepare("SELECT id, rowid AS rid FROM indexed_sessions WHERE rowid > ? ORDER BY rowid ASC LIMIT ?")
      .all(verify.session, CTO_SEARCH_INDEX_LIMITS.sessionVerifyMax);
    for (const s of sRows) {
      if (liveSession.get(s.id) == null) {
        db.prepare("DELETE FROM indexed_sessions WHERE id = ?").run(s.id);
      }
    }
    next.session = sRows.length < CTO_SEARCH_INDEX_LIMITS.sessionVerifyMax ? 0 : sRows[sRows.length - 1].rid;
    db.prepare("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      "verify",
      JSON.stringify(next),
    );
    return { removed, verified: pRows.length + sRows.length, verify: next };
  }

  // Live size of the index: pages in use (freed pages are reused, so the file does not
  // grow past the cap by more than one batch).
  function liveBytes(d) {
    const pages = d.prepare("PRAGMA page_count").get().page_count;
    const free = d.prepare("PRAGMA freelist_count").get().freelist_count;
    const size = d.prepare("PRAGMA page_size").get().page_size;
    return (pages - free) * size;
  }

  // Over the cap → one eviction round: drop the OLDEST sessions (by last update) and
  // everything indexed under them until about `evictTargetRatio` of the cap is left, then
  // raise the eviction floor to the newest evicted session so the sweep never re-reads it.
  // The amount to drop is estimated as a share of the indexed parts; the deletes are set
  // based (one pass over the evidence table per round, not one per part). Parts whose
  // session row was never indexed are swept up when they are not newer than the newest
  // victim, or — with no session rows left at all — oldest first. Own transaction; a failure
  // rolls back and leaves the index over the cap for the next sync to retry.
  function enforceSizeCap(d) {
    const total = { sessions: 0, parts: 0 };
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return total;
    // The share is estimated from the page count, which includes fixed overhead, so a
    // round can fall short on a small index: repeat (bounded) until under the cap.
    for (let round = 0; round < MAX_EVICT_ROUNDS && liveBytes(d) > maxBytes; round++) {
      const r = evictRound(d);
      total.sessions += r.sessions;
      total.parts += r.parts;
      if (r.parts === 0) break;
    }
    return total;
  }

  function evictRound(d) {
    const none = { sessions: 0, parts: 0 };
    const live = liveBytes(d);
    try {
      d.exec("BEGIN IMMEDIATE");
      d.exec("CREATE TEMP TABLE IF NOT EXISTS evict_sessions (id TEXT PRIMARY KEY)");
      d.exec("CREATE TEMP TABLE IF NOT EXISTS evict_parts (part_id TEXT PRIMARY KEY)");
      d.exec("DELETE FROM temp.evict_sessions");
      d.exec("DELETE FROM temp.evict_parts");
      const totalParts = d.prepare("SELECT count(*) AS n FROM indexed_parts").get().n;
      const share = Math.min(1, (live - maxBytes * CTO_SEARCH_INDEX_LIMITS.evictTargetRatio) / live);
      const wantParts = Math.max(1, Math.ceil(totalParts * share));
      let newest = 0;
      let gathered = 0;
      const sessions = d.prepare("SELECT id, COALESCE(time_updated, time_created, 0) AS t FROM indexed_sessions ORDER BY t ASC, id ASC").all();
      const addSession = d.prepare("INSERT OR IGNORE INTO temp.evict_sessions (id) VALUES (?)");
      const addParts = d.prepare("INSERT OR IGNORE INTO temp.evict_parts (part_id) SELECT part_id FROM indexed_parts WHERE session_id = ?");
      for (const v of sessions) {
        if (gathered >= wantParts) break;
        addSession.run(v.id);
        gathered += Number(addParts.run(v.id).changes ?? 0);
        newest = Math.max(newest, v.t);
      }
      if (newest > 0) {
        d.prepare(
          `INSERT OR IGNORE INTO temp.evict_parts (part_id)
           SELECT part_id FROM indexed_parts
           WHERE source_time <= ? AND session_id NOT IN (SELECT id FROM indexed_sessions)`,
        ).run(newest);
      }
      if (gathered < wantParts) {
        // No session rows left to evict (or too few): fall back to the oldest parts.
        d.prepare(
          `INSERT OR IGNORE INTO temp.evict_parts (part_id)
           SELECT part_id FROM indexed_parts ORDER BY source_time ASC, part_id ASC LIMIT ?`,
        ).run(wantParts - gathered);
      }
      const parts = Number(d.prepare("SELECT count(*) AS n FROM temp.evict_parts").get().n);
      const sessionCount = Number(d.prepare("SELECT count(*) AS n FROM temp.evict_sessions").get().n);
      d.exec("DELETE FROM indexed_evidence WHERE part_id IN (SELECT part_id FROM temp.evict_parts)");
      d.exec("DELETE FROM indexed_parts WHERE part_id IN (SELECT part_id FROM temp.evict_parts)");
      d.exec("DELETE FROM indexed_messages WHERE session_id IN (SELECT id FROM temp.evict_sessions)");
      d.exec("DELETE FROM indexed_sessions WHERE id IN (SELECT id FROM temp.evict_sessions)");
      if (newest > evictionFloor(d)) setMeta(d, "evict_floor", String(newest));
      d.exec("DELETE FROM temp.evict_sessions");
      d.exec("DELETE FROM temp.evict_parts");
      d.exec("COMMIT");
      // FTS5 deletes leave the old postings in place until segments are merged, so the rows
      // going away free the content table but not the index: compact it, and hand the freed
      // pages back to the file (fresh index files are created with incremental auto-vacuum).
      // Only when the delete alone did not get under the cap — a full rewrite is the cost.
      if (liveBytes(d) > maxBytes) {
        d.exec("INSERT INTO indexed_evidence(indexed_evidence) VALUES('optimize')");
        d.exec("PRAGMA incremental_vacuum");
      }
      return { sessions: sessionCount, parts };
    } catch (e) {
      try {
        d.exec("ROLLBACK");
      } catch {
        /* the owned connection stays; the next sync retries */
      }
      console.error("[ctoSearchIndex] size-cap eviction failed (nothing committed):", e?.message ?? e);
      return none;
    }
  }

  function failEnvelope(status, detail) {
    return { ...baseEnvelope(), supported: operationSupported(status), status, detail, coverage: uncovered() };
  }

  function zeroCounts() {
    return {
      sessions: { scanned: 0, upserted: 0 },
      messages: { scanned: 0, upserted: 0 },
      parts: { scanned: 0, indexed: 0, unchanged: 0, removed: 0, extractionOmitted: 0, byteTruncated: 0 },
      verifiedParts: 0,
    };
  }

  return {
    /** Drop the owned connection (idempotent). Operations afterwards fail closed. */
    close() {
      closed = true;
      if (db) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        db = null;
      }
    },

    /**
     * One bounded refresh batch: re-read up to `limit` rows per stream at the
     * cycling sweep position (changes re-indexed; parts hash-gated), then
     * boundedly reconcile deletions. ONE transaction — nothing partial.
     */
    async sync({ limit, provenanceFilter: provenanceOverride } = {}) {
      if (closed) return closedEnvelope("sync");
      const base = baseEnvelope();
      const batch = clampLimit(limit, CTO_SEARCH_INDEX_LIMITS.syncBatchDefault, CTO_SEARCH_INDEX_LIMITS.syncBatchMax);
      const resolveProvenance = provenanceOverride ?? provenanceFilter;

      let excluded;
      try {
        excluded = new Set(await resolveProvenance());
      } catch (e) {
        return { ...failEnvelope("provenance_unavailable", `provenance registry failed: ${e?.message ?? e}`), scanned: zeroCounts(), sweep: null };
      }
      const src = await getDb();
      if (!src) {
        const cause = getDbOpenFailure();
        const status = cause?.reason === "unsupported" ? "unsupported" : "source_unavailable";
        return { ...failEnvelope(status, cause?.detail ?? "no opencode source database is available on this box"), scanned: zeroCounts(), sweep: null };
      }
      const opened = await openIndex();
      if (closed) return closedEnvelope("sync"); // close() during the open await wins
      if (opened.unsupported) return { ...failEnvelope("unsupported", "node:sqlite unavailable on this runtime"), scanned: zeroCounts(), sweep: null };
      if (!opened.db) return { ...failEnvelope(opened.status, opened.detail), scanned: zeroCounts(), sweep: null };
      const indexDb = opened.db;

      const counts = zeroCounts();
      try {
        // Source reads FIRST (the windowed ones run in the db worker and are awaited);
        // the index write transaction then opens and closes synchronously.
        const sweep = sweepPosition(indexDb);
        const floor = evictionFloor(indexDb);
        const read = {};
        for (const name of Object.keys(STREAMS)) read[name] = await readStream(src, name, sweep, floor, batch);
        indexDb.exec("BEGIN IMMEDIATE");
        const next = { v: 2, cycle: {}, head: {} };
        for (const name of Object.keys(STREAMS)) {
          const countsKey = name === "session" ? "sessions" : name === "message" ? "messages" : "parts";
          const { head, cycle, cycleAtEnd } = read[name];
          // Newest-first cycle rows first, then the head rows (older duplicates are hash-gated / idempotent).
          const rows = [...cycle, ...head];
          for (const row of rows) {
            if (name === "session") upsertSession(row, excluded);
            else if (name === "message") upsertMessage(row);
            else {
              if (_syncFault) _syncFault({ stream: name, row });
              const r = upsertPart(row);
              counts.parts.indexed += r.indexed ? 1 : 0;
              counts.parts.unchanged += r.changed ? 0 : 1;
              counts.parts.extractionOmitted += r.omitted;
              counts.parts.byteTruncated += r.truncated ? 1 : 0;
            }
          }
          counts[countsKey].scanned = rows.length;
          if (name !== "part") counts[countsKey].upserted = rows.length;
          next.cycle[name] = advanceOrCycle(sweep.cycle[name], cycle, cycleAtEnd);
          next.head[name] = advanceHead(sweep, name, read[name]);
        }
        const rec = reconcileDeletions(src);
        counts.parts.removed = rec.removed;
        counts.verifiedParts = rec.verified;
        setMeta(indexDb, "sweep", JSON.stringify(next));
        setMeta(indexDb, "synced_at", JSON.stringify(new Date(now()).toISOString()));
        indexDb.exec("COMMIT");
        const evicted = enforceSizeCap(indexDb);
        const totals = indexDb
          .prepare("SELECT count(*) AS total, sum(incomplete = 1 OR truncated = 1) AS incomplete FROM indexed_parts")
          .get();
        return {
          ...base,
          status: "ok",
          coverage: { mode: "fts-index", indexedParts: totals.total, incompleteParts: totals.incomplete ?? 0, eventual: true },
          sweep: next,
          scanned: counts,
          size: { liveBytes: liveBytes(indexDb), maxBytes, evictionFloor: evictionFloor(indexDb), evicted },
        };
      } catch (e) {
        try {
          indexDb.exec("ROLLBACK");
        } catch {
          /* the owned connection stays; the next call retries cleanly */
        }
        const status = classifyError(e);
        console.error(`[ctoSearchIndex] sync batch failed (${status}, nothing committed):`, e?.message ?? e);
        return { ...base, status, detail: `sync batch failed: ${e?.message ?? e}`, coverage: uncovered(), scanned: zeroCounts(), sweep: null };
      }
    },

    /**
     * FIRST-PAGE ranked search over the index only. `anyTerms: true` ranks rows
     * matching ANY term (bm25), default requires every term; `directories` limits
     * hits to sessions in that set of directories ([] → no hits). Each hit also
     * carries `directory` and `at` (the source update time, ms). No pagination (a
     * `cursor` is rejected); `truncated`/`omittedCount` say when more
     * existed. Internal sessions are excluded from the authoritative
     * registry, independent of mirror progress.
     */
    async search({ query, sessionId, projectId, directory, directories, anyTerms = false, includeInternal = false, limit, cursor, provenanceFilter: provenanceOverride } = {}) {
      if (closed) return closedEnvelope("search");
      const base = baseEnvelope();
      const resolveProvenance = provenanceOverride ?? provenanceFilter;
      if (cursor != null) {
        return { ...base, status: "invalid_input", detail: "pagination is not supported by this PR (bounded first page only); cursor rejected", coverage: uncovered(), hits: [], truncated: false, omittedCount: 0 };
      }
      const parsed = anyTerms === true ? ftsAnyTermExpression(query) : ftsMatchExpression(query);
      if (!parsed.ok) {
        return { ...base, status: "invalid_input", detail: parsed.reason, coverage: uncovered(), hits: [], truncated: false, omittedCount: 0 };
      }
      // A SET of directories: only hits from sessions in one of them. An empty set
      // matches nothing (a caller that resolved "no allowed projects" must see no hits).
      let dirSet = null;
      if (directories != null) {
        if (!Array.isArray(directories) || directories.length > CTO_SEARCH_INDEX_LIMITS.searchDirectoriesMax) {
          return { ...base, status: "invalid_input", detail: `directories must be an array of at most ${CTO_SEARCH_INDEX_LIMITS.searchDirectoriesMax} paths`, coverage: uncovered(), hits: [], truncated: false, omittedCount: 0 };
        }
        dirSet = [...new Set(directories.filter((d) => typeof d === "string" && d !== ""))];
      }
      const cap = clampLimit(limit, CTO_SEARCH_INDEX_LIMITS.searchHitsDefault, CTO_SEARCH_INDEX_LIMITS.searchHitsMax);

      // The registry is resolved ALWAYS (authoritative labels + uniform
      // fail-closed), and used to FILTER unless the caller opts in.
      let registryInternal;
      try {
        registryInternal = new Set(await resolveProvenance());
      } catch (e) {
        return { ...base, status: "provenance_unavailable", detail: `provenance registry failed: ${e?.message ?? e}`, coverage: uncovered(), hits: [], truncated: false, omittedCount: 0 };
      }
      const filterInternal = includeInternal === false;

      const opened = await openIndex();
      if (closed) return closedEnvelope("search"); // close() during the open await wins
      if (opened.unsupported) return failEnvelope("unsupported", "node:sqlite unavailable on this runtime");
      if (!opened.db) return failEnvelope(opened.status, opened.detail);
      const indexDb = opened.db;

      if (dirSet !== null && dirSet.length === 0) {
        return { ...base, status: "ok", coverage: { mode: "fts-index", indexedParts: null, eventual: true, retrieval: "bounded-first-page" }, hits: [], truncated: false, omittedCount: 0 };
      }
      try {
        const filters = [
          [sessionId != null, "indexed_parts.session_id = ?", sessionId],
          [projectId != null, "indexed_sessions.project_id = ?", projectId],
          [directory != null, "indexed_sessions.directory = ?", directory],
          [dirSet !== null, "indexed_sessions.directory IN (SELECT value FROM json_each(?))", dirSet === null ? null : JSON.stringify(dirSet)],
        ].filter(([has]) => has);
        const where = ["indexed_evidence MATCH ?", ...filters.map(([, f]) => f)];
        const params = [parsed.expr, ...filters.map(([, , v]) => v)];
        const window = CTO_SEARCH_INDEX_LIMITS.searchScanWindow;
        const sql = `
          SELECT indexed_evidence.part_id AS part_id, indexed_evidence.field AS field,
                 snippet(indexed_evidence, 0, '', '', '…', ${CTO_SEARCH_INDEX_LIMITS.snippetTokens}) AS snip,
                 indexed_parts.session_id AS session_id, indexed_parts.message_id AS message_id,
                 indexed_parts.source_time AS source_time,
                 indexed_messages.role AS role,
                 indexed_sessions.provenance AS mirror_provenance,
                 indexed_sessions.directory AS directory
          FROM indexed_evidence
          JOIN indexed_parts ON indexed_parts.part_id = indexed_evidence.part_id
          LEFT JOIN indexed_messages ON indexed_messages.id = indexed_parts.message_id
          LEFT JOIN indexed_sessions ON indexed_sessions.id = indexed_parts.session_id
          WHERE ${where.join(" AND ")}
          ORDER BY rank ASC, indexed_evidence.part_id ASC, indexed_evidence.field ASC
          LIMIT ?`;
        const raw = indexDb.prepare(sql).all(...params, window);
        const totals = indexDb
          .prepare("SELECT count(*) AS total, sum(incomplete = 1 OR truncated = 1) AS incomplete FROM indexed_parts")
          .get();
        const coverage = { mode: "fts-index", indexedParts: totals.total, incompleteParts: totals.incomplete ?? 0, eventual: true, retrieval: "bounded-first-page" };

        // AUTHORITATIVE registry exclusion — irrespective of mirror progress
        // (a part indexed before its session mirror row is still filtered).
        let hits = [];
        let filteredInternal = 0;
        for (const row of raw) {
          const isInternal = registryInternal.has(row.session_id) || row.mirror_provenance === "internal";
          if (isInternal && filterInternal) {
            filteredInternal++;
            continue;
          }
          hits.push({
            sessionId: row.session_id,
            messageId: row.message_id,
            partId: row.part_id,
            field: row.field,
            kind: row.field === "text" ? "text" : "tool",
            role: row.role ?? null,
            provenance: isInternal ? "internal" : row.mirror_provenance ?? "unclassified",
            timeUpdated: row.source_time ?? null,
            at: row.source_time ?? null,
            directory: row.directory ?? null,
            snippet: row.snip ?? "",
          });
          if (hits.length >= cap) break;
        }

        // ONE authoritative budget on the SERIALIZED response (spec §4.2):
        // overflow drops TAIL hits. `omittedCount` counts EVERY matching row
        // not returned; `truncated` is honest; no cursor is fabricated.
        let omittedCount = Math.max(0, raw.length - filteredInternal - hits.length);
        let truncated = omittedCount > 0 || raw.length >= window;
        const serialized = () => byteLen(JSON.stringify({ hits }));
        while (hits.length > 0 && serialized() > CTO_SEARCH_INDEX_LIMITS.responseBudgetBytes) {
          hits.pop();
          omittedCount++;
          truncated = true;
        }
        return { ...base, status: "ok", coverage, hits, truncated, omittedCount };
      } catch (e) {
        const status = classifyError(e);
        console.error(`[ctoSearchIndex] search failed (${status}):`, e?.message ?? e);
        return { ...base, status, detail: `search failed: ${e?.message ?? e}`, coverage: uncovered(), hits: [], truncated: false, omittedCount: 0 };
      }
    },

    /** Honest diagnostics: counts + sweep positions (used by tests/wiring). */
    async status() {
      if (closed) return closedEnvelope("status");
      const base = baseEnvelope();
      const opened = await openIndex();
      if (closed) return closedEnvelope("status"); // close() during the open await wins
      if (opened.unsupported) return failEnvelope("unsupported", "node:sqlite unavailable on this runtime");
      if (!opened.db) return failEnvelope(opened.status, opened.detail);
      const indexDb = opened.db;
      try {
        const count = (table) => indexDb.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
        const incomplete = indexDb.prepare("SELECT count(*) AS n FROM indexed_parts WHERE incomplete = 1 OR truncated = 1").get().n;
        return {
          ...base,
          status: "ok",
          counts: { sessions: count("indexed_sessions"), messages: count("indexed_messages"), parts: count("indexed_parts"), evidence: count("indexed_evidence"), incompleteParts: incomplete },
          sweep: sweepPosition(indexDb),
          size: { liveBytes: liveBytes(indexDb), maxBytes, evictionFloor: evictionFloor(indexDb) },
        };
      } catch (e) {
        return { ...base, status: "index_error", detail: `status failed: ${e?.message ?? e}` };
      }
    },
  };
}

// Test-only fault injection inside the sync transaction (throws roll
// everything back — pins "failed batch commits nothing").
let _syncFault = null;
export function _setSyncFault(fn) {
  _syncFault = fn;
}
