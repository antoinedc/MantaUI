// state.mjs — `~/.manta/knowledge/state.sqlite` (git-ignored, node:sqlite).
//
// One synchronous connection owned by the knowledge engine. Everything in it is
// derived or operational (session→project map, page FTS index, budget ledger,
// briefing session state, change log, kv counters) — the durable knowledge
// itself lives in the git store.
//
// node:sqlite needs Node 24 (the box runtime). On an older runtime
// `openState()` throws a `KnowledgeError("unsupported")` and the whole
// subsystem reports itself off (spec §3.2).
//
// Other modules add tables through `state.migrate(id, ddl)`: idempotent, each
// id applied once, recorded in `schema_migrations`.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../../shared/paths.mjs";
import { KnowledgeError } from "./errors.mjs";

export const defaultStatePath = () => statePath("knowledge", "state.sqlite");

const BASE_SCHEMA = [
  [
    "base-1",
    `
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS session_project (
      session_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      canonical_id TEXT NOT NULL,
      directory TEXT,
      oc_project_id TEXT,
      parent_id TEXT,
      source TEXT NOT NULL,
      captured INTEGER NOT NULL DEFAULT 0,
      pinned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_project_slug ON session_project(slug);
    CREATE TABLE IF NOT EXISTS backfill_unresolved (
      session_id TEXT PRIMARY KEY,
      oc_project_id TEXT,
      directory TEXT
    );
    CREATE TABLE IF NOT EXISTS page_meta (
      path TEXT PRIMARY KEY, area TEXT NOT NULL, slug TEXT, title TEXT, verified TEXT, sources TEXT, mtime INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(title, body, path UNINDEXED, area UNINDEXED, slug UNINDEXED);
    CREATE TABLE IF NOT EXISTS page_use (path TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, last_at INTEGER);
    CREATE TABLE IF NOT EXISTS budget_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL, at INTEGER NOT NULL, task_class TEXT NOT NULL, model TEXT, band TEXT,
      tokens TEXT, usd REAL NOT NULL, priced INTEGER NOT NULL, slug TEXT
    );
    CREATE INDEX IF NOT EXISTS budget_day ON budget_ledger(day);
    CREATE TABLE IF NOT EXISTS batch_ledger (day TEXT NOT NULL, slug TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, slug));
    CREATE TABLE IF NOT EXISTS briefing_session (
      session_id TEXT PRIMARY KEY,
      slug TEXT, state TEXT NOT NULL, token TEXT, permit INTEGER NOT NULL DEFAULT 0,
      issued_at INTEGER, acked_at INTEGER, missed INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS briefing_week (week TEXT PRIMARY KEY, served INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS note_hash (hash TEXT NOT NULL, slug TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (hash, slug));
    CREATE INDEX IF NOT EXISTS note_hash_at ON note_hash(at);
    CREATE TABLE IF NOT EXISTS changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT,
      area TEXT, slug TEXT, undoable INTEGER NOT NULL DEFAULT 0, undone_at INTEGER, error TEXT,
      commit_sha TEXT, decision_id TEXT, batch_id TEXT, data TEXT
    );
    `,
  ],
];

/**
 * Open (creating) the state database. `importSqlite` is injectable
 * (`() => import("node:sqlite")`) so tests can substitute a module and the
 * unsupported path is testable.
 * @returns {Promise<KnowledgeState>}
 */
export async function openState({ path = defaultStatePath(), importSqlite = () => import("node:sqlite") } = {}) {
  let mod;
  try {
    mod = await importSqlite();
  } catch (e) {
    throw new KnowledgeError("unsupported", "Shared knowledge needs the Node 24 runtime (node:sqlite) and is off on this box.", {
      status: 503,
      details: String(e?.message ?? e),
    });
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new mod.DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* non-fatal */
  }
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, at INTEGER NOT NULL)");

  const state = {
    db,
    path,
    migrate(id, ddl) {
      const done = db.prepare("SELECT 1 AS x FROM schema_migrations WHERE id = ?").get(id);
      if (done) return false;
      db.exec("BEGIN");
      try {
        db.exec(ddl);
        db.prepare("INSERT INTO schema_migrations (id, at) VALUES (?, ?)").run(id, Date.now());
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
      return true;
    },
    kvGet(key, fallback = null) {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
      return row ? row.value : fallback;
    },
    kvSet(key, value) {
      db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
    },
    kvDelete(key) {
      db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    },
    /** Run `fn` inside one transaction (BEGIN/COMMIT, ROLLBACK on a throw). */
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
  for (const [id, ddl] of BASE_SCHEMA) state.migrate(id, ddl);
  return state;
}
