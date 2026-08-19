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
// any failure.
export async function getDb() {
  if (dbHandle && dbHandle.isOpen !== false) return dbHandle;
  const path = resolveDbPath();
  if (!path) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    dbHandle = new DatabaseSync(path, { readOnly: true });
    return dbHandle;
  } catch (e) {
    console.warn("[opencodeDb] node:sqlite unavailable:", e?.message ?? e);
    dbHandle = null;
    return null;
  }
}

// Clears the cached handle so the next `getDb()` reopens it. Test-only: not
// part of the runtime API.
export function _resetDbHandle() {
  dbHandle = null;
}
