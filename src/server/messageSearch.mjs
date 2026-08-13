// messageSearch.mjs — ⌘F conversation search over opencode's own SQLite.
//
// BET-698 replaces the client-side "download N transcripts over HTTP and
// scan them" fan-out with ONE server-side query against opencode's
// `opencode.db`. The renderer batches nothing; it sends (query, sessionIds)
// and we return the ordered hits. The active conversation is searched by the
// same query (sessionIds[0] = primary), which also fixes the old
// tail-only-current gap (it previously scanned the ~last 100 loaded
// messages, not full history).
//
// Cap semantics (defaults kept server-side; the renderer never overrides):
//   maxPrimary     = hit cap for sessionIds[0] (the active conversation)
//   maxPerSession  = hit cap for every other session
//   maxTotal       = overall hit cap
//
// Degradation: a box that has not taken the Node 24 runtime yet has no
// `node:sqlite`, or there is no opencode.db — both return
// { supported:false, hits:[] } and the UI shows "update the box". searchMessages
// NEVER throws; DB errors are logged once, the handle is closed+nulled so the
// next call reopens, and we return { supported:true, hits:[] }.
//
// The schema (verified live; do not re-derive):
//   part(id TEXT PK, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)
//   message(id TEXT PK, session_id TEXT, time_created INTEGER, data TEXT)
// part.data / message.data are JSON blobs.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SNIPPET_PRE_CHARS = 60;
const SNIPPET_POST_CHARS = 200;
// SQLite's LIKE is ASCII case-insensitive; we re-check in JS anyway. The
// MAX_LIMIT over-fetch bounds a LIKE scan before the JS text-part filter
// drops non-text rows (tool arguments etc.).
const MAX_LIMIT = 800;

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
// degrade to { supported:false }, not crash the server. Null handle on any
// failure.
async function getDb() {
  if (dbHandle) return dbHandle;
  const path = resolveDbPath();
  if (!path) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    dbHandle = new DatabaseSync(path, { readOnly: true });
    return dbHandle;
  } catch (e) {
    console.warn("[messageSearch] node:sqlite unavailable:", e?.message ?? e);
    dbHandle = null;
    return null;
  }
}

// The only exported entry point used by rpc.mjs.
export async function searchMessages({
  query,
  sessionIds,
  maxPrimary = 50,
  maxPerSession = 3,
  maxTotal = 200,
} = {}) {
  const q = typeof query === "string" ? query : "";
  const scope = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : [];
  if (q.trim() === "" || scope.length === 0) {
    return { supported: true, hits: [] };
  }
  const db = await getDb();
  if (!db) return { supported: false, hits: [] };

  try {
    const pattern = likePattern(q);
    const placeholders = scope.map(() => "?").join(", ");
    const limit = Math.min(maxTotal * 4, MAX_LIMIT);
    const sql = `
      SELECT p.session_id, p.message_id, p.data AS part_data,
             m.data AS msg_data, p.time_created
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE p.session_id IN (${placeholders})
        AND p.data LIKE ? ESCAPE '\\'
      ORDER BY p.time_created DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...scope, pattern, limit);
    const hits = buildHits(rows, q, {
      sessionIds: scope,
      primarySessionId: scope[0],
      maxPrimary,
      maxPerSession,
      maxTotal,
    });
    return { supported: true, hits };
  } catch (e) {
    // Query error: log once, drop the handle so the next call reopens, and
    // degrade to an empty (but supported) result — never an exception.
    console.error("[messageSearch] query failed:", e?.message ?? e);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    dbHandle = null;
    return { supported: true, hits: [] };
  }
}

// Pure: build a SQLite LIKE pattern for `query`, escaping `\`, `%` and `_`
// and wrapping in %…%. Parameterised only — never concatenate user input.
export function likePattern(query) {
  return "%" + String(query).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

// Pure: turn raw SQLite rows (already newest-first by time_created) into a
// flat, ordered TranscriptHit[].
export function buildHits(rows, query, opts = {}) {
  const {
    sessionIds = [],
    primarySessionId = sessionIds[0] ?? null,
    maxPrimary = 50,
    maxPerSession = 3,
    maxTotal = 200,
  } = opts;
  const q = String(query ?? "").toLowerCase();
  if (!q) return [];

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ");
  const rankOf = new Map(sessionIds.map((s, i) => [s, i]));
  const perSession = new Map(); // session_id -> hit count produced
  const byMessage = new Set(); // message_id already produced a hit

  const hits = [];
  for (const row of rows) {
    if (hits.length >= maxTotal) break;

    // part_data → text part only.
    let part;
    try {
      part = JSON.parse(row.part_data);
    } catch {
      continue;
    }
    if (!part || part.type !== "text") continue;
    if (typeof part.text !== "string") continue;
    if (part.synthetic || part.ignored) continue;

    // One hit per message — first match wins.
    if (byMessage.has(row.message_id)) continue;

    const idx = part.text.toLowerCase().indexOf(q);
    if (idx < 0) continue;

    // role from message blob; a parse failure elsewhere skips this row but
    // must never throw.
    let role = "assistant";
    let msg = null;
    try {
      msg = JSON.parse(row.msg_data);
    } catch {
      continue;
    }
    if (!msg || typeof msg !== "object") continue;
    role = msg.role === "user" ? "user" : "assistant";

    // Per-session hit cap.
    const sid = row.session_id;
    const cap = sid === primarySessionId ? maxPrimary : maxPerSession;
    const count = perSession.get(sid) ?? 0;
    if (count >= cap) continue;
    perSession.set(sid, count + 1);
    byMessage.add(row.message_id);

    // Snippet fields — same contract as the deleted renderer searchTranscript.
    const start = Math.max(0, idx - SNIPPET_PRE_CHARS);
    hits.push({
      sessionId: sid,
      messageId: row.message_id,
      role,
      pre: (start > 0 ? "…" : "") + clean(part.text.slice(start, idx)),
      match: clean(part.text.slice(idx, idx + query.length)),
      post: clean(
        part.text.slice(idx + query.length, idx + query.length + SNIPPET_POST_CHARS),
      ),
      timeCreated: row.time_created ?? null,
    });
  }

  // Final order: by the session's index in sessionIds, then time_created
  // descending within a session (stable sort preserves the input order, and
  // the input is already time-descending per session).
  hits.sort((a, b) => (rankOf.get(a.sessionId) ?? 0) - (rankOf.get(b.sessionId) ?? 0));
  return hits;
}
