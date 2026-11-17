// promptOrigins.mjs — a positive record of WHO authored each prompt message
// (shared-knowledge spec §9.2). The knowledge system treats a message as
// user-authored evidence only when a `user` origin was recorded for its id at
// the one chokepoint every manta-server prompt passes through
// (`postPrompt` in opencode.mjs). Anything else — another origin, no record,
// a message from before the upgrade — is NOT user-authored (fail closed).
//
// Storage: one table in `statePath("knowledge", "state.sqlite")`, the same
// file the knowledge engine keeps its other tables in (so the connection runs
// WAL + a busy timeout and creates only its own table). Rows are kept 90 days.
//
// `node:sqlite` needs Node 24 (the box runtime). Without it the store reports
// `available: false`, records nothing and answers "not user-authored" — it
// never throws into the send path.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";

let defaultSqlite = null;
try {
  defaultSqlite = await import("node:sqlite");
} catch {
  defaultSqlite = null;
}

export const PROMPT_ORIGINS = Object.freeze(["user", "schedule", "webhook", "peer", "job", "routine", "cto", "plugin", "unknown"]);
export const PROMPT_ORIGIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 5000;

/** The default store file (shared with the knowledge engine's other tables). */
export function defaultPromptOriginsPath() {
  return statePath("knowledge", "state.sqlite");
}

/** Anything that is not a known origin string is `unknown` — never "user" by accident. */
export function normalizeOrigin(origin) {
  return typeof origin === "string" && PROMPT_ORIGINS.includes(origin) ? origin : "unknown";
}

/**
 * @param {object} [deps]
 * @param {string} [deps.path]  sqlite file (default `statePath("knowledge","state.sqlite")`).
 * @param {() => number} [deps.now]
 * @param {{ DatabaseSync: Function } | null} [deps.sqliteModule]  injectable node:sqlite module; `null` = unavailable.
 * @param {(...a: any[]) => void} [deps.warn]
 * @returns {{
 *   available: boolean,
 *   record: (o: { messageID: string, sessionID: string, origin?: string }) => boolean,
 *   get: (messageID: string) => string | null,
 *   isUserAuthored: (messageID: string) => boolean,
 *   prune: () => number,
 *   close: () => void,
 * }}
 */
export function createPromptOrigins(deps = {}) {
  const { path = defaultPromptOriginsPath(), now = Date.now, sqliteModule = defaultSqlite, warn = console.warn } = deps;
  const available = sqliteModule != null && typeof sqliteModule.DatabaseSync === "function";

  let db = null;
  let failed = false; // an open failure is not retried in a loop; the store stays inert
  let lastPruneAt = 0;
  const stmts = {};

  function open() {
    if (db) return db;
    if (!available || failed) return null;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const d = new sqliteModule.DatabaseSync(path);
      d.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      d.exec("PRAGMA journal_mode = WAL");
      d.exec(`CREATE TABLE IF NOT EXISTS prompt_origin (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        at INTEGER NOT NULL)`);
      d.exec("CREATE INDEX IF NOT EXISTS prompt_origin_at ON prompt_origin (at)");
      stmts.insert = d.prepare("INSERT OR IGNORE INTO prompt_origin (message_id, session_id, origin, at) VALUES (?, ?, ?, ?)");
      stmts.get = d.prepare("SELECT origin FROM prompt_origin WHERE message_id = ?");
      stmts.prune = d.prepare("DELETE FROM prompt_origin WHERE at < ?");
      db = d;
      return db;
    } catch (e) {
      failed = true;
      warn("[promptOrigins] store unavailable:", e?.message ?? e);
      return null;
    }
  }

  function prune() {
    const d = open();
    if (!d) return 0;
    try {
      const r = stmts.prune.run(now() - PROMPT_ORIGIN_RETENTION_MS);
      lastPruneAt = now();
      return Number(r?.changes ?? 0);
    } catch (e) {
      warn("[promptOrigins] prune failed:", e?.message ?? e);
      return 0;
    }
  }

  return {
    available,

    /**
     * Record the origin of a prompt message. First write wins: V2 treats a
     * re-posted message id as the same message, so a later call can neither
     * upgrade nor downgrade it. Never throws; returns whether a row was added.
     */
    record({ messageID, sessionID, origin } = {}) {
      if (typeof messageID !== "string" || !messageID || typeof sessionID !== "string" || !sessionID) return false;
      const d = open();
      if (!d) return false;
      try {
        const t = now();
        const r = stmts.insert.run(messageID, sessionID, normalizeOrigin(origin), t);
        if (t - lastPruneAt > PRUNE_EVERY_MS) prune();
        return Number(r?.changes ?? 0) > 0;
      } catch (e) {
        warn("[promptOrigins] record failed:", e?.message ?? e);
        return false;
      }
    },

    /** The recorded origin, or null when there is no record. */
    get(messageID) {
      if (typeof messageID !== "string" || !messageID) return null;
      const d = open();
      if (!d) return null;
      try {
        return stmts.get.get(messageID)?.origin ?? null;
      } catch (e) {
        warn("[promptOrigins] get failed:", e?.message ?? e);
        return null;
      }
    },

    /** True only for a recorded `user` origin; no record, any other origin, or a store failure is false. */
    isUserAuthored(messageID) {
      return this.get(messageID) === "user";
    },

    /** Drop rows older than the 90-day retention. Returns the number removed. */
    prune,

    close() {
      if (db) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        db = null;
      }
      failed = true; // a closed store stays inert
    },
  };
}
