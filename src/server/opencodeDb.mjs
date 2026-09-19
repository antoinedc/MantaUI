// opencodeDb.mjs — the single read-only access layer for opencode's own
// SQLite store (`opencode.db`). Extracted from messageSearch.mjs so that any
// consumer (conversation search, the model ledger, …) shares ONE resolution
// path and ONE lazily-opened connection/degradation path instead of each
// opening its own handle.
//
// Degradation: a box that has not taken the Node 24 runtime yet has no
// `node:sqlite`, or there is no opencode.db at the resolved path — both make
// `getDb()` return `null` (never throw). Read-only is a hard invariant; this
// database is never opened writable.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

let dbHandle = null;
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

// Resolve opencode's SQLite path. First existing wins; a test/override hook
// (`MANTA_OPENCODE_DB`) is used as-is. null → the box cannot search.
export function resolveDbPath() {
  if (process.env.MANTA_OPENCODE_DB) return process.env.MANTA_OPENCODE_DB;
  if (process.env.XDG_DATA_HOME) {
    const p = join(process.env.XDG_DATA_HOME, "opencode", "opencode.db");
    if (existsSync(p)) return p;
    return null;
  }
  const p = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (existsSync(p)) return p;
  return null;
}

// Lazily open node:sqlite read-only. The import lives in a try/catch because
// on a box that hasn't taken the Node 24 runtime yet it throws — that must
// degrade to `null`, not crash the server. A cached handle that a consumer
// closed (query-error recovery) is reopened on the next call. Null handle on
// any failure — with the CAUSE recorded for getDbOpenFailure().
export async function getDb() {
  _openFailure = null;
  if (dbHandle && dbHandle.isOpen !== false) return dbHandle;
  const path = resolveDbPath();
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
    try {
      // BET-1360: bounded wait for a WAL-checkpoint-locked page, so a reader
      // that meets a busy handle waits at most 5000ms instead of failing
      // immediately (SQLite default) or blocking forever.
      dbHandle.exec("PRAGMA busy_timeout = 5000");
    } catch (e) {
      // Non-fatal: a handle without the pragma is still usable.
      console.warn("[opencodeDb] busy_timeout pragma failed:", e?.message ?? e);
    }
    return dbHandle;
  } catch (e) {
    console.warn("[opencodeDb] could not open opencode.db read-only:", e?.message ?? e);
    _openFailure = { reason: "source_unavailable", detail: e?.message ?? String(e) };
    dbHandle = null;
    return null;
  }
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
}

// Test-only read of the cached handle, so fixtures can close the connection
// the shared accessor opened before dropping the reference (`_resetDbHandle`
// only nulls it — the OS file handle would leak and keep a temp dir pinned).
// Not part of the runtime API.
export function _getDbHandle() {
  return dbHandle;
}

// lookupProjectIdByDirectory(directory) → opencode project id | null
//
// §4.1's live observation path for the project-identity work: the opencode
// project id opencode CURRENTLY resolves for a checkout directory. Read-only,
// bounded, and degrading — a missing DB, schema drift, or any query error
// yields null (an unobservable id never blocks or guesses).
//
// A directory lookup can return MULTIPLE project rows after a remote-less
// recreation forks the id [PROVEN in §4.1]. Disambiguate by LIVENESS, not by
// row order: the live id is the one opencode most recently stamped on a
// session row pointing at that project. The `global` pseudo-project id is
// never returned (§4.1: never persist it as a repository identity either).
export async function lookupProjectIdByDirectory(directory) {
  if (typeof directory !== "string" || directory.length === 0) return null;
  const db = await getDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT project_id AS id FROM project_directory WHERE directory = ?")
      .all(directory);
    const ids = [...new Set(rows.map((r) => (r?.id == null ? null : String(r.id))).filter((id) => id && id !== "global"))];
    if (ids.length === 0) return null;
    if (ids.length === 1) return ids[0];
    const placeholders = ids.map(() => "?").join(",");
    const live = db
      .prepare(
        `SELECT project_id AS id FROM session WHERE project_id IN (${placeholders})
         ORDER BY COALESCE(time_created, 0) DESC LIMIT 1`,
      )
      .all(...ids);
    const id = live[0]?.id == null ? null : String(live[0].id);
    return id && ids.includes(id) ? id : null;
  } catch {
    return null;
  }
}
