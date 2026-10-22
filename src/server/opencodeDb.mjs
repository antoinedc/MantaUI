// opencodeDb.mjs — the single read-only access layer for opencode's own
// SQLite store (`opencode.db`). Extracted from messageSearch.mjs so that any
// consumer (conversation search, the model ledger, …) shares ONE resolution
// path and ONE lazily-opened connection/degradation path instead of each
// opening its own handle.
//
// Degradation: a box that has not taken the Node 24 runtime yet has no
// `node:sqlite`, there is no opencode.db at the resolved path, or the file does
// not carry the OpenCode V2 schema (a V1 database that has not been migrated
// yet) — all make `getDb()` return `null` (never throw). Read-only is a hard
// invariant; this database is never opened writable.
//
// OpenCode V2 SCHEMA (what every reader here is written against; produced by a
// real V2 2.0.30 server, and by its in-place V1 migration):
//   session_v2(id, project_id, workspace_id, parent_id, directory, title, agent,
//              model, cost, tokens_*, time_created, time_updated, time_archived …)
//   session_message(id, session_id, type, seq, time_created, time_updated, data)
//     type = user | assistant | synthetic | system | shell | skill | compaction |
//            model-switched | agent-switched | location-switched | idle
//     data = JSON. user: {text, files?, time}. assistant: {agent, model:{providerID,
//            id}, content:[{type:"text"|"reasoning"|"tool", …}], cost, tokens:{input,
//            output,reasoning,cache:{read,write}}, finish, time:{created,streamed,
//            completed}}. A tool content item is {type:"tool", id, name,
//            state:{status, input, content:[{type:"text",text}], metadata, error?}}.
//   project(id, worktree …), project_directory(project_id, directory …)
// There is NO `part` table in V2: a message's parts are the items of its
// `content` array (or the single text of a user/synthetic/system message). The
// PART_SQL / MESSAGE_SQL subqueries below present them in the shape the CTO
// readers were written for (part rows with a V1-shaped `data` JSON), so the
// callers keep their query logic and only the source changed.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { migrationStatePath } from "./upgradeV2Prepare.mjs";

let dbHandle = null;
// The path the cached handle was opened against. The migration cutover changes
// OPENCODE_DB while the server runs; a handle on the OLD path must not outlive it.
let dbHandlePath = null;
// The reason the last getDb() attempt could not hand out a handle — set on
// every attempt (null on success or before the first). Additive P1a: lets
// consumers distinguish `unsupported` (no node:sqlite on this runtime) from
// `source_unavailable` (no DB path / open failure) instead of collapsing
// both into a bare null. Existing consumers are unaffected: getDb() still
// returns null on both.
let _openFailure = null;
// Test-only: a substitute for the node:sqlite module, so tests can fake a
// DatabaseSync without ever opening the real opencode.db. Not runtime API.
// If the substitute carries `__importError` (an Error), getDb() treats it as
// the dynamic-import failure itself — the deterministic way to exercise the
// `unsupported` degradation on a runtime that HAS node:sqlite.
let _modOverride = null;
export function _setSqliteModuleOverride(mod) {
  _modOverride = mod;
}

// The database a COMPLETED copy-mode V1→V2 migration left behind
// (`<stateHome>/.manta/v2-migration.json`: state "completed", mode "copy",
// targetDb). On such a box opencode-serve runs with OPENCODE_DB=<targetDb> in its
// OWN service environment while manta-server's environment never sees it, so
// without this the readers would fall back to the untouched V1 `opencode.db`,
// fail the V2-schema guard and report `supported:false` for everything. Any other
// state (absent, mid-flight, failed, rolled back, in-place — where the DB IS the
// default path) contributes nothing. Read per resolve, invalidated on the state
// file's mtime/size, so a box that completes the upgrade while manta-server runs is
// picked up without a restart. The target must still exist on disk.
let stateTargetCache = { file: null, mtimeMs: -1, size: -1, target: null };
function migratedTargetDb() {
  const file = migrationStatePath();
  let st;
  try {
    st = statSync(file);
  } catch {
    stateTargetCache = { file, mtimeMs: -1, size: -1, target: null };
    return null;
  }
  const c = stateTargetCache;
  if (c.file !== file || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    let target = null;
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (s && s.state === "completed" && s.mode === "copy" && typeof s.targetDb === "string" && s.targetDb) target = s.targetDb;
    } catch {
      /* unreadable / half-written state file: no opinion */
    }
    stateTargetCache = { file, mtimeMs: st.mtimeMs, size: st.size, target };
  }
  const target = stateTargetCache.target;
  return target && existsSync(target) ? target : null;
}

// Resolve opencode's SQLite path. `MANTA_OPENCODE_DB` (test/override hook) wins
// as-is, then `OPENCODE_DB` — the variable opencode itself honours, which the
// V1→V2 migration sets for opencode when it points V2 at a COPY of the V1 database
// — then the copy recorded by a completed copy-mode migration (see
// migratedTargetDb), then the first existing default. null → the box cannot search.
export function resolveDbPath() {
  if (process.env.MANTA_OPENCODE_DB) return process.env.MANTA_OPENCODE_DB;
  if (process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ":memory:") return process.env.OPENCODE_DB;
  const migrated = migratedTargetDb();
  if (migrated) return migrated;
  if (process.env.XDG_DATA_HOME) {
    const p = join(process.env.XDG_DATA_HOME, "opencode", "opencode.db");
    if (existsSync(p)) return p;
    return null;
  }
  const p = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (existsSync(p)) return p;
  return null;
}

// Does this database carry the V2 tables the readers query? A test double
// without `prepare` (the busy_timeout fakes) is trusted as-is.
function hasV2Schema(handle) {
  if (typeof handle?.prepare !== "function") return true;
  try {
    const names = new Set(
      handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session_message')")
        .all()
        .map((r) => r.name),
    );
    return names.has("session_v2") && names.has("session_message");
  } catch {
    return false;
  }
}

// Lazily open node:sqlite read-only. The import lives in a try/catch because
// on a box that hasn't taken the Node 24 runtime yet it throws — that must
// degrade to `null`, not crash the server. A cached handle that a consumer
// closed (query-error recovery) is reopened on the next call. Null handle on
// any failure — with the CAUSE recorded for getDbOpenFailure().
export async function getDb() {
  _openFailure = null;
  const path = resolveDbPath();
  if (dbHandle && dbHandle.isOpen !== false) {
    if (path === dbHandlePath) return dbHandle;
    try {
      dbHandle.close();
    } catch {
      /* already closed */
    }
    dbHandle = null;
  }
  if (!path) {
    _openFailure = { reason: "source_unavailable", detail: "no opencode.db at any resolved path" };
    return null;
  }
  let mod;
  if (_modOverride !== null) {
    if (_modOverride && _modOverride.__importError) {
      _openFailure = { reason: "unsupported", detail: String(_modOverride.__importError?.message ?? _modOverride.__importError) };
      return null;
    }
    mod = _modOverride;
  } else {
    try {
      mod = await import("node:sqlite");
    } catch (e) {
      console.warn("[opencodeDb] node:sqlite unavailable:", e?.message ?? e);
      _openFailure = { reason: "unsupported", detail: e?.message ?? String(e) };
      dbHandle = null;
      return null;
    }
  }
  try {
    dbHandle = new mod.DatabaseSync(path, { readOnly: true });
    dbHandlePath = path;
    try {
      // BET-1360: bounded wait for a WAL-checkpoint-locked page, so a reader
      // that meets a busy handle waits at most 5000ms instead of failing
      // immediately (SQLite default) or blocking forever.
      dbHandle.exec("PRAGMA busy_timeout = 5000");
    } catch (e) {
      // Non-fatal: a handle without the pragma is still usable.
      console.warn("[opencodeDb] busy_timeout pragma failed:", e?.message ?? e);
    }
    if (!hasV2Schema(dbHandle)) {
      _openFailure = { reason: "source_unavailable", detail: "opencode.db has no V2 schema (session_v2 / session_message) — not migrated yet" };
      try {
        dbHandle.close();
      } catch {
        /* best effort */
      }
      dbHandle = null;
      return null;
    }
    return dbHandle;
  } catch (e) {
    console.warn("[opencodeDb] could not open opencode.db read-only:", e?.message ?? e);
    _openFailure = { reason: "source_unavailable", detail: e?.message ?? String(e) };
    dbHandle = null;
    return null;
  }
}

// The path the live shared handle is open against (null when none). Worker
// threads (dbOffload.mjs) open the same file by path with their own read-only handle.
export function currentDbPath() {
  return dbHandle && dbHandle.isOpen !== false ? dbHandlePath : null;
}

// Is `db` the shared handle getDb() hands out (so a worker opening currentDbPath() reads the same file)?
export function isSharedHandle(db) {
  return db != null && db === dbHandle && dbHandle.isOpen !== false;
}

// Why the last getDb() returned null: {reason: "unsupported"|"source_unavailable",
// detail} — or null when the handle is available / no attempt was made.
// Additive read; existing null-returning contract unchanged.
export function getDbOpenFailure() {
  return _openFailure;
}

// Clears the cached handle so the next `getDb()` reopens it. Test-only: not
// part of the runtime API.
export function _resetDbHandle() {
  dbHandle = null;
  dbHandlePath = null;
}

// Test-only read of the cached handle, so fixtures can close the connection
// the shared accessor opened before dropping the reference (`_resetDbHandle`
// only nulls it — the OS file handle would leak and keep a temp dir pinned).
// Not part of the runtime API.
export function _getDbHandle() {
  return dbHandle;
}

// ---------------------------------------------------------------------------
// V2 part / message projections
// ---------------------------------------------------------------------------

// Message types that carry readable conversation content. (idle, model-switched,
// agent-switched, location-switched, shell and compaction are bookkeeping.)
export const CONTENT_MESSAGE_TYPES = Object.freeze(["user", "assistant", "synthetic", "system"]);
const CONTENT_TYPES_SQL = CONTENT_MESSAGE_TYPES.map((t) => `'${t}'`).join(",");

// The part id of item `idx` of message `messageId`. V2 has no part ids, so one is
// derived: `part_<message id without its msg_ prefix>x<4-digit index>` — stable,
// alphanumeric for real ids (matches the part_/msg_/ses_ reference pattern),
// sorts in content order, and reversible (see parsePartId).
export function partIdFor(messageId, idx) {
  const base = String(messageId).startsWith("msg_") ? String(messageId).slice(4) : String(messageId);
  return `part_${base}x${String(idx).padStart(4, "0")}`;
}

/** Inverse of partIdFor → { messageIds: [candidate message ids], idx } | null. */
export function parsePartId(partId) {
  const m = /^part_(.+)x(\d{4})$/.exec(String(partId ?? ""));
  if (!m) return null;
  return { messageIds: [`msg_${m[1]}`, m[1]], idx: Number(m[2]) };
}

const PART_ID_SQL = (idx) =>
  `'part_' || CASE WHEN m.id LIKE 'msg\\_%' ESCAPE '\\' THEN substr(m.id, 5) ELSE m.id END || 'x' || printf('%04d', ${idx})`;

// The text of a tool state's `content` array (what V1 called state.output).
const TOOL_OUTPUT_SQL = (v) =>
  `COALESCE((SELECT group_concat(json_extract(x.value, '$.text'), char(10)) FROM json_each(${v}, '$.state.content') x WHERE json_extract(x.value, '$.type') = 'text'), json_extract(${v}, '$.state.error.message'))`;

// NOTE the `->` (not json_extract) on input/metadata: json_extract returns a JSON STRING value
// as bare SQL text, and json() of that throws "malformed JSON" — which aborted any scan that
// reached a tool call whose input is a plain string (a model emitting non-JSON arguments;
// present in the real history). `->` always yields valid JSON text (strings come back quoted).
// One V2 content item as a V1-shaped part `data` JSON. Written in SQL (not JS) so
// the json_tree/json_extract candidate queries keep working over the SAME paths:
//   text      → {type:"text", text}
//   reasoning → {type:"reasoning", text}
//   tool      → {type:"tool", tool:<name>, state:{status, input, output, metadata}}
const ITEM_DATA_SQL = (v) => `CASE json_extract(${v}, '$.type')
    WHEN 'text' THEN json_object('type', 'text', 'text', json_extract(${v}, '$.text'))
    WHEN 'reasoning' THEN json_object('type', 'reasoning', 'text', json_extract(${v}, '$.text'))
    WHEN 'tool' THEN json_object('type', 'tool', 'tool', json_extract(${v}, '$.name'),
      'state', json_object('status', json_extract(${v}, '$.state.status'),
                           'input', json(COALESCE(${v} -> '$.state.input', '{}')),
                           'output', ${TOOL_OUTPUT_SQL(v)},
                           'metadata', json(COALESCE(${v} -> '$.state.metadata', '{}'))))
    ELSE json_object('type', COALESCE(json_extract(${v}, '$.type'), 'unknown'))
  END`;

/**
 * Subquery of PART rows, columns: id, message_id, session_id, time_created,
 * time_updated, role ('user'|'assistant'), data (V1-shaped JSON text). Selectable
 * like a table: `FROM ${PART_SQL} p WHERE p.session_id = ?` — a filter on
 * session_id / message_id is pushed down into the message scan (both are plain
 * columns of session_message in every arm), so per-session reads stay indexed.
 * `time_created` is the owning message's; order within a message is the id (the
 * index is zero-padded).
 */
export const PART_SQL = `(
  SELECT ${PART_ID_SQL("e.key")} AS id, m.id AS message_id, m.session_id AS session_id,
         m.time_created AS time_created, m.time_updated AS time_updated, 'assistant' AS role,
         ${ITEM_DATA_SQL("e.value")} AS data
  FROM session_message m, json_each(m.data, '$.content') e
  WHERE m.type = 'assistant'
  UNION ALL
  SELECT ${PART_ID_SQL("0")} AS id, m.id AS message_id, m.session_id AS session_id,
         m.time_created AS time_created, m.time_updated AS time_updated,
         CASE m.type WHEN 'user' THEN 'user' ELSE 'assistant' END AS role,
         CASE m.type WHEN 'user' THEN json_object('type', 'text', 'text', json_extract(m.data, '$.text'))
                     ELSE json_object('type', 'text', 'text', json_extract(m.data, '$.text'), 'synthetic', json('true')) END AS data
  FROM session_message m
  WHERE m.type IN ('user', 'synthetic', 'system')
)`;

/**
 * Subquery of MESSAGE rows (content-bearing types only): id, session_id,
 * time_created, time_updated, role, data. `data` is the raw V2 JSON.
 */
export const MESSAGE_SQL = `(
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created, m.time_updated AS time_updated,
         CASE m.type WHEN 'user' THEN 'user' ELSE 'assistant' END AS role, m.type AS type, m.data AS data
  FROM session_message m
  WHERE m.type IN (${CONTENT_TYPES_SQL})
)`;

/** Does the part `partId` exist? true/false, or null when it cannot be told. */
export function partExists(db, partId) {
  const parsed = parsePartId(partId);
  if (!parsed) return false;
  const rows = db
    .prepare("SELECT type, json_array_length(data, '$.content') AS n FROM session_message WHERE id IN (?, ?)")
    .all(...parsed.messageIds);
  return rows.some((r) => (r.type === "assistant" ? parsed.idx < (r.n ?? 0) : parsed.idx === 0 && ["user", "synthetic", "system"].includes(r.type)));
}

// lookupProjectIdByDirectory(directory) → opencode project id | null
//
// §4.1's live observation path for the project-identity work: the opencode
// project id opencode CURRENTLY resolves for a checkout directory. Read-only,
// bounded, and degrading — a missing DB, schema drift, or any query error
// yields null (an unobservable id never blocks or guesses).
//
// A directory can map to MULTIPLE project ids after a remote-less recreation
// forks the id [PROVEN in §4.1]. V2 records the association in three places —
// project_directory (the explicit link), project.worktree (the project's root)
// and the sessions themselves (session_v2.project_id for a session started in
// that directory; the only one populated for a migrated V1 history) — so all
// three are consulted. Disambiguate by LIVENESS, not by row order: the live id
// is the one opencode most recently stamped on a session row pointing at that
// project. The `global` pseudo-project id is never returned (§4.1: never
// persist it as a repository identity either).
export async function lookupProjectIdByDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT project_id AS id FROM project_directory WHERE directory = ?
         UNION SELECT id FROM project WHERE worktree = ?
         UNION SELECT project_id FROM session_v2 WHERE directory = ?`,
      )
      .all(directory, directory, directory);
    const ids = [...new Set(rows.map((r) => (r?.id == null ? null : String(r.id))).filter((id) => id && id !== "global"))];
    if (ids.length === 0) return null;
    if (ids.length === 1) return ids[0];
    const placeholders = ids.map(() => "?").join(",");
    const live = db
      .prepare(
        `SELECT project_id AS id FROM session_v2 WHERE project_id IN (${placeholders})
         ORDER BY COALESCE(time_created, 0) DESC LIMIT 1`,
      )
      .all(...ids);
    const id = live[0]?.id == null ? null : String(live[0].id);
    return id && ids.includes(id) ? id : null;
  } catch {
    return null;
  }
}
