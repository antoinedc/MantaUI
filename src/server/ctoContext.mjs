// ctoContext.mjs — passive read-only historical context over opencode's own
// SQLite store (unified-CTO spec §4.2, P1a slice: the three source-read
// operations — session discovery, bounded text/tool-evidence search, and the
// message neighborhood — contract-only until the tool/UI wiring lands in a
// later phase; nothing here is exposed through rpc/tools/UI yet).
//
// Invariants this module owns:
//   • READ-ONLY. The only I/O is the shared read-only handle from
//     opencodeDb.mjs (`DatabaseSync(path, {readOnly:true})`). No table, index
//     or row is ever created/written in the source DB; no FTS index exists yet
//     (P1b) — every answer is a bounded direct source read, and `coverage`
//     says so honestly.
//   • OBSERVED IDENTITIES ONLY. Filters and outputs carry opencode's own
//     `project_id` / `workspace_id` verbatim as observed values, each marked
//     `projectMapping:"unmapped"` — the Manta-workspace mapping is explicitly
//     unresolved (docs/cto-implementation-map.md §4) and a DB projectID is
//     NEVER surfaced under a name like `workspaceId`.
//   • NO SIDE EFFECTS. No prompt sends, no tmux/window/job creation, no
//     fetches — a passive read must never wake an agent (spec U04).
//   • HONEST DEGRADATION. `unsupported` (no node:sqlite on this runtime),
//     `source_unavailable` (no DB path / unreadable source),
//     `reference_expired` (a stale/unknown session/message reference) and
//     `invalid_input` (bad caller arguments, including the forbidden
//     workspace-key filter) are distinct statuses. An empty result over a
//     healthy source is `status:"ok"` WITH coverage/observedAt — never a
//     fabricated "nothing happened" (spec U27).
//   • BOUNDED. Server-side limits are enforced independently of caller
//     arguments: hit/message limits, keyset cursors that cannot repeat rows,
//     and a hard 24 KiB returned-text budget per call with explicit
//     truncation + omitted-size metadata (never silent truncation).

import { getDb } from "./opencodeDb.mjs";
import { likePattern } from "./messageSearch.mjs";

export const CTO_CONTEXT_LIMITS = Object.freeze({
  searchHitsDefault: 20,
  searchHitsMax: 50,
  sessionsDefault: 20,
  sessionsMax: 50,
  aroundBeforeDefault: 5,
  aroundAfterDefault: 5,
  aroundMessagesMax: 40,
  // Spec §4.2: 24 KiB returned text per call, enforced server-side.
  textBudgetBytes: 24 * 1024,
  // Per-part evidence cap inside an `around` window, so one huge tool dump
  // cannot blind the rest of the neighborhood (each cut is reported).
  partEvidenceMaxBytes: 6 * 1024,
  // LIKE over-fetch bound before the JS-side filter/budget pass (mirrors
  // messageSearch.mjs).
  scanLimit: 800,
  // Title/text-passthrough cap for session rows.
  titleMaxChars: 500,
});

const ENC = new TextEncoder();
const byteLen = (s) => ENC.encode(s).length;

// ---------------------------------------------------------------------------
// Shared envelope + budget helpers
// ---------------------------------------------------------------------------

function envelope(status, extra = {}) {
  const observedAt = new Date().toISOString();
  const coverage =
    status === "ok"
      ? { mode: "direct-source", indexed: false }
      : { mode: "none", indexed: false };
  return { supported: status === "ok" || status === "reference_expired" || status === "invalid_input", status, observedAt, coverage, ...extra };
}

function invalidInput(detail) {
  return envelope("invalid_input", { detail, hits: [], sessions: [], messages: [], nextCursor: null, truncated: false, omittedCount: 0 });
}

function unavailable(detail) {
  return envelope("source_unavailable", { detail, hits: [], sessions: [], messages: [], nextCursor: null, truncated: false, omittedCount: 0 });
}

// Clamp a caller limit into [1, max]; a non-number/<=0 argument falls back to
// the default (server-side limits are enforced regardless of caller args).
function clampLimit(value, dflt, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

// Pure: cut `text` to at most `maxBytes` UTF-8 bytes. Returns
// { text, truncated, returnedBytes, sourceBytes }.
function fitText(text, maxBytes) {
  const source = byteLen(text);
  if (source <= maxBytes) return { text, truncated: false, returnedBytes: source, sourceBytes: source };
  let cut = text;
  while (cut.length > 0 && byteLen(cut) > maxBytes) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, returnedBytes: byteLen(cut), sourceBytes: source };
}

// A running 24 KiB budget across one response. `take(text, cap)` returns the
// text that fits within both the per-item cap and the remaining budget and
// reports how it was cut.
function createBudget() {
  let remaining = CTO_CONTEXT_LIMITS.textBudgetBytes;
  return {
    get remaining() {
      return remaining;
    },
    take(text, cap) {
      const allowed = Math.min(cap, remaining);
      if (allowed <= 0) return { text: "", truncated: byteLen(text) > 0, returnedBytes: 0, sourceBytes: byteLen(text) };
      const fit = fitText(text, allowed);
      remaining -= fit.returnedBytes;
      return fit;
    },
  };
}

// Opaque keyset cursor: {v, t, i} (t = numeric time, i = id tiebreak),
// base64url-encoded. Order is always (time DESC, id DESC) — a strict keyset,
// so pages can never repeat a row.
function encodeCursor(t, i) {
  return Buffer.from(JSON.stringify({ v: 1, t, i }), "utf8").toString("base64url");
}

// Returns {ok, t, i} or {ok:false} — never throws on caller garbage.
function decodeCursor(raw) {
  if (typeof raw !== "string" || raw === "") return { ok: false };
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (obj?.v !== 1 || typeof obj.t !== "number" || typeof obj.i !== "string") return { ok: false };
    return { ok: true, t: obj.t, i: obj.i };
  } catch {
    return { ok: false };
  }
}

// Pure: the forbidden-input guard. Project identity mapping is unresolved;
// callers pass OBSERVED source values (projectId/directory/sessionId). A
// `workspaceId` (or `workspaceID`) key — the exact conflation the map §4
// corrected — is rejected explicitly instead of being silently reinterpreted.
function hasForbiddenWorkspaceKey(input) {
  return input != null && typeof input === "object" && (input.workspaceId != null || input.workspaceID != null);
}

// The session columns every read returns, verbatim from the source.
const SESSION_COLS = "id, parent_id, project_id, workspace_id, directory, title, time_created, time_updated, time_archived";

// Pure: an observed source row → the session record. Identity fields keep the
// DB's own names/meaning (`projectId` ← project_id); `projectMapping` is
// always the explicit "unmapped" marker (never a Manta workspace id).
function sessionRecord(row) {
  return {
    id: row.id,
    parentSessionId: row.parent_id ?? null,
    projectId: row.project_id ?? null,
    workspaceId: row.workspace_id ?? null,
    directory: row.directory ?? null,
    title: typeof row.title === "string" ? row.title : null,
    archived: row.time_archived != null,
    timeCreated: row.time_created ?? null,
    timeUpdated: row.time_updated ?? null,
    timeArchived: row.time_archived ?? null,
    projectMapping: "unmapped",
  };
}

function queryFailed(e) {
  console.error("[ctoContext] source read failed:", e?.message ?? e);
  return unavailable(`source read failed: ${e?.message ?? e}`);
}

// ---------------------------------------------------------------------------
// 1. listSessions — discover ALL historical sessions (incl. closed/archived
//    and child sessions; there is no live-window requirement — the source DB
//    is the only thing consulted).
// ---------------------------------------------------------------------------

export async function ctoListSessions({
  projectId,
  directory,
  includeArchived = true,
  limit,
  cursor,
  ...rest
} = {}) {
  if (hasForbiddenWorkspaceKey(rest)) {
    return invalidInput("project identity mapping is unresolved; pass observed projectId/directory, never a Manta workspace key");
  }
  const cap = clampLimit(limit, CTO_CONTEXT_LIMITS.sessionsDefault, CTO_CONTEXT_LIMITS.sessionsMax);
  let cur = null;
  if (cursor != null) {
    const d = decodeCursor(cursor);
    if (!d.ok) return invalidInput("cursor is not a valid ctoContext cursor");
    cur = d;
  }

  const db = await getDb();
  if (!db) return unavailable("no opencode source database is available on this box");

  try {
    const where = [];
    const params = [];
    if (projectId != null) {
      where.push("project_id = ?");
      params.push(projectId);
    }
    if (directory != null) {
      where.push("directory = ?");
      params.push(directory);
    }
    if (includeArchived === false) where.push("time_archived IS NULL");
    if (cur) {
      where.push("((time_updated < ?) OR (time_updated = ? AND id < ?))");
      params.push(cur.t, cur.t, cur.i);
    }
    const sql = `SELECT ${SESSION_COLS} FROM session ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY time_updated DESC, id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, CTO_CONTEXT_LIMITS.scanLimit);

    const budget = createBudget();
    const sessions = [];
    for (const row of rows) {
      if (sessions.length >= cap) break;
      const rec = sessionRecord(row);
      const fit = budget.take(rec.title ?? "", CTO_CONTEXT_LIMITS.titleMaxChars);
      if (fit.truncated) rec.titleTruncated = true;
      if (fit.returnedBytes === 0 && (rec.title?.length ?? 0) > 0) {
        break; // text budget exhausted before this row's title
      }
      rec.title = fit.text || null;
      sessions.push(rec);
    }
    const truncated = rows.length > sessions.length;
    const last = sessions[sessions.length - 1];
    return {
      ...envelope("ok"),
      sessions,
      truncated,
      omittedCount: Math.max(0, rows.length - sessions.length),
      nextCursor: last ? encodeCursor(last.timeUpdated ?? 0, last.id) : null,
    };
  } catch (e) {
    return queryFailed(e);
  }
}

// ---------------------------------------------------------------------------
// 2. search — bounded text + tool-evidence search over the source parts.
//    Text parts contribute the classic pre/match/post snippet; tool parts
//    contribute evidence (tool name / input / output) with the field that
//    matched. One hit per part. Ordering is (time_created DESC, id DESC) with
//    a strict keyset cursor — pages never repeat a hit.
// ---------------------------------------------------------------------------

// Pure: the searchable text candidates of one parsed part, most-specific
// first. Returns [] for parts with no text evidence.
export function partCandidates(part) {
  if (!part || typeof part !== "object") return [];
  if (part.type === "text") {
    if (part.synthetic || part.ignored) return [];
    if (typeof part.text !== "string" || part.text === "") return [];
    return [{ field: "text", text: part.text }];
  }
  if (part.type === "tool") {
    const out = [];
    if (typeof part.tool === "string" && part.tool !== "") out.push({ field: "tool_name", text: part.tool });
    const state = part.state && typeof part.state === "object" ? part.state : null;
    const input = state?.input;
    if (input != null) out.push({ field: "input", text: typeof input === "string" ? input : JSON.stringify(input) });
    const output = state?.output;
    if (output != null) out.push({ field: "output", text: typeof output === "string" ? output : JSON.stringify(output) });
    return out.filter((c) => c.text !== "");
  }
  return [];
}

// Pure: build one hit from a source row + its parsed part/message. `budget`
// is the call-wide 24 KiB envelope; `q` the lowercased query.
function buildHit(row, part, msg, q, query, budget) {
  let role = "assistant";
  if (msg && typeof msg === "object" && msg.role === "user") role = "user";

  const idxOf = (text) => text.toLowerCase().indexOf(q);
  const candidates = partCandidates(part).map((c) => ({ ...c, idx: idxOf(c.text) }));
  const match = candidates.find((c) => c.idx >= 0);
  if (!match) return null;

  const hit = {
    sessionId: row.session_id,
    messageId: row.message_id,
    partId: row.part_id,
    role,
    kind: part.type === "tool" ? "tool" : "text",
    timeCreated: row.time_created ?? null,
    projectMapping: "unmapped",
  };
  if (part.type === "tool") {
    hit.tool = { name: typeof part.tool === "string" ? part.tool : null, status: part.state?.status ?? null, matchedField: match.field };
  }

  // Snippet: a bounded pre/match/post window from the full matched field,
  // charged against the call-wide budget. The budget applies to the ASSEMBLED
  // snippet: if it does not fit, the whole snippet is cut to what remains and
  // reported as one truncated string (match segment preserved first, so a
  // cut never silently drops the match itself). sourceBytes names the FULL
  // matched field — honest omitted size.
  const idx = match.idx;
  const start = Math.max(0, idx - 60);
  const clean = (s) => s.replace(/\s+/g, " ");
  const fieldBytes = byteLen(match.text);
  const assembled =
    clean((start > 0 ? "…" : "") + match.text.slice(start, idx)) +
    clean(match.text.slice(idx, idx + query.length)) +
    clean(match.text.slice(idx + query.length, idx + query.length + 200));
  const fit = budget.take(assembled, CTO_CONTEXT_LIMITS.textBudgetBytes);
  if (fit.truncated) {
    hit.snippetTruncated = true;
    hit.sourceBytes = fieldBytes;
    hit.returnedBytes = fit.returnedBytes;
    hit.snippet = { pre: "", match: fit.text, post: "" };
  } else {
    hit.snippet = {
      pre: clean((start > 0 ? "…" : "") + match.text.slice(start, idx)),
      match: clean(match.text.slice(idx, idx + query.length)),
      post: clean(match.text.slice(idx + query.length, idx + query.length + 200)),
    };
  }
  return hit;
}

export async function ctoSearch({ query, projectId, directory, sessionId, limit, cursor, ...rest } = {}) {
  if (hasForbiddenWorkspaceKey(rest)) {
    return invalidInput("project identity mapping is unresolved; pass observed projectId/directory/sessionId, never a Manta workspace key");
  }
  const q = typeof query === "string" ? query : "";
  if (q.trim() === "") return invalidInput("query must be a non-empty string");
  const cap = clampLimit(limit, CTO_CONTEXT_LIMITS.searchHitsDefault, CTO_CONTEXT_LIMITS.searchHitsMax);
  let cur = null;
  if (cursor != null) {
    const d = decodeCursor(cursor);
    if (!d.ok) return invalidInput("cursor is not a valid ctoContext cursor");
    cur = d;
  }

  const db = await getDb();
  if (!db) return unavailable("no opencode source database is available on this box");

  try {
    const where = ["p.data LIKE ? ESCAPE '\\'"];
    const params = [likePattern(q)];
    if (projectId != null) {
      where.push("s.project_id = ?");
      params.push(projectId);
    }
    if (directory != null) {
      where.push("s.directory = ?");
      params.push(directory);
    }
    if (sessionId != null) {
      where.push("p.session_id = ?");
      params.push(sessionId);
    }
    if (cur) {
      where.push("((p.time_created < ?) OR (p.time_created = ? AND p.id < ?))");
      params.push(cur.t, cur.t, cur.i);
    }
    const sql = `
      SELECT p.id AS part_id, p.session_id, p.message_id, p.time_created,
             p.data AS part_data, m.data AS msg_data
      FROM part p
      JOIN message m ON m.id = p.message_id
      LEFT JOIN session s ON s.id = p.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.time_created DESC, p.id DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params, CTO_CONTEXT_LIMITS.scanLimit);

    const budget = createBudget();
    const hits = [];
    let exhausted = false;
    for (const row of rows) {
      if (hits.length >= cap || budget.remaining <= 0) {
        exhausted = true;
        break;
      }
      let part;
      let msg;
      try {
        part = JSON.parse(row.part_data);
        msg = JSON.parse(row.msg_data);
      } catch {
        continue;
      }
      const hit = buildHit(row, part, msg, q.toLowerCase(), q, budget);
      if (hit) hits.push(hit);
    }
    // Honest truncation: `exhausted` is only set when candidate rows in the
    // scanned window had to be dropped (hit cap or text budget), never when
    // the window simply ended — an equal-count page is not a false "cut".
    // Continuation beyond the scanned window is the caller paging via
    // nextCursor until an empty page.
    const truncated = exhausted;
    const last = hits[hits.length - 1];
    return {
      ...envelope("ok"),
      hits,
      truncated,
      omittedCount: Math.max(0, rows.length - hits.length),
      nextCursor: last ? encodeCursor(last.timeCreated ?? 0, last.partId) : null,
    };
  } catch (e) {
    return queryFailed(e);
  }
}

// ---------------------------------------------------------------------------
// 3. around — the chronological text/tool-evidence neighborhood of one
//    message, with stable source IDs. before/after are message-granular and
//    clamped server-side (default 5 each; at most 40 messages per request).
// ---------------------------------------------------------------------------

// Pure: for an `around` evidence item, the most decisive field of a tool
// part is its RESULT (output) — the thing that can contradict a claim
// (spec U05) — then the input, then the bare tool name.
function primaryEvidenceField(candidates) {
  const byPreference = ["output", "input", "tool_name", "text"];
  for (const field of byPreference) {
    const found = candidates.find((c) => c.field === field);
    if (found) return found;
  }
  return candidates[candidates.length - 1];
}

// Pure: the evidence entries for one message's parts, under the call budget.
// Each part yields at most one evidence item, capped per part so one huge
// tool output cannot consume the whole window.
function evidenceForParts(partRows, budget) {
  const items = [];
  for (const row of partRows) {
    let part;
    try {
      part = JSON.parse(row.data);
    } catch {
      continue;
    }
    const candidates = partCandidates(part);
    if (candidates.length === 0) continue;
    const primary = primaryEvidenceField(candidates);
    const isTool = part.type === "tool";
    const fit = budget.take(primary.text, CTO_CONTEXT_LIMITS.partEvidenceMaxBytes);
    const item = {
      partId: row.id,
      kind: isTool ? "tool" : "text",
      timeCreated: row.time_created ?? null,
      text: fit.text,
    };
    if (fit.truncated) {
      item.truncated = true;
      item.sourceBytes = fit.sourceBytes;
      item.returnedBytes = fit.returnedBytes;
    }
    if (isTool) {
      item.tool = { name: typeof part.tool === "string" ? part.tool : null, status: part.state?.status ?? null };
    }
    items.push(item);
  }
  return items;
}

const MSG_COLS = "id, time_created, time_updated, data";

function messageRecord(row, { anchor = false } = {}) {
  return {
    id: row.id,
    role: (() => {
      try {
        const d = JSON.parse(row.data);
        return d && d.role === "user" ? "user" : "assistant";
      } catch {
        return "assistant";
      }
    })(),
    timeCreated: row.time_created ?? null,
    anchor,
  };
}

export async function ctoAround({ sessionId, messageId, before, after } = {}) {
  if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") {
    return invalidInput("sessionId and messageId are required source references");
  }
  // Server-side clamp: before/after default to 5 each and their SUM is capped
  // at 40 messages per request (spec §4.2) — the anchor itself is additional.
  const nBefore = clampLimit(before ?? CTO_CONTEXT_LIMITS.aroundBeforeDefault, CTO_CONTEXT_LIMITS.aroundBeforeDefault, CTO_CONTEXT_LIMITS.aroundMessagesMax);
  const useBefore = Math.min(nBefore, CTO_CONTEXT_LIMITS.aroundMessagesMax);
  const nAfter = clampLimit(after ?? CTO_CONTEXT_LIMITS.aroundAfterDefault, CTO_CONTEXT_LIMITS.aroundAfterDefault, CTO_CONTEXT_LIMITS.aroundMessagesMax);
  const useAfter = Math.min(nAfter, CTO_CONTEXT_LIMITS.aroundMessagesMax - useBefore);

  const db = await getDb();
  if (!db) return unavailable("no opencode source database is available on this box");

  try {
    const sess = db.prepare(`SELECT ${SESSION_COLS} FROM session WHERE id = ?`).get(sessionId);
    if (!sess) {
      return envelope("reference_expired", { detail: `session ${sessionId} not found in source`, messages: [], truncated: false, omittedCount: 0 });
    }
    const anchorRow = db.prepare(`SELECT ${MSG_COLS} FROM message WHERE id = ? AND session_id = ?`).get(messageId, sessionId);
    if (!anchorRow) {
      return envelope("reference_expired", { detail: `message ${messageId} not found in source session ${sessionId}`, messages: [], truncated: false, omittedCount: 0 });
    }
    const anchorMsg = messageRecord(anchorRow, { anchor: true });

    const beforeRows = useBefore > 0
      ? db
          .prepare(
            `SELECT ${MSG_COLS} FROM message WHERE session_id = ? AND ((time_created < ?) OR (time_created = ? AND id < ?)) ORDER BY time_created DESC, id DESC LIMIT ?`,
          )
          .all(sessionId, anchorRow.time_created ?? 0, anchorRow.time_created ?? 0, anchorRow.id, useBefore)
      : [];
    const afterRows = useAfter > 0
      ? db
          .prepare(
            `SELECT ${MSG_COLS} FROM message WHERE session_id = ? AND ((time_created > ?) OR (time_created = ? AND id > ?)) ORDER BY time_created ASC, id ASC LIMIT ?`,
          )
          .all(sessionId, anchorRow.time_created ?? 0, anchorRow.time_created ?? 0, anchorRow.id, useAfter)
      : [];

    const budget = createBudget();
    const partStmt = db.prepare("SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC");
    let omittedCount = 0;
    const chronological = [...beforeRows.slice().reverse(), anchorRow, ...afterRows];
    const recs = chronological.map((row) => (row === anchorRow ? anchorMsg : messageRecord(row)));

    // Budget priority: the anchor's own evidence is taken FIRST, then the
    // neighborhood in chronological order — one huge before-tool-dump cannot
    // blind the message the caller actually asked about.
    const anchorRec = recs.find((r) => r.anchor === true);
    if (anchorRec) anchorRec.parts = evidenceForParts(partStmt.all(anchorRec.id), budget);
    for (const rec of recs) {
      if (rec.parts !== undefined) continue;
      if (budget.remaining <= 0) {
        rec.parts = [];
        omittedCount++;
        continue;
      }
      rec.parts = evidenceForParts(partStmt.all(rec.id), budget);
    }

    return {
      ...envelope("ok"),
      session: { ...sessionRefOf(sess), anchorMessageId: messageId },
      messages: recs,
      truncated: omittedCount > 0,
      omittedCount,
    };
  } catch (e) {
    return queryFailed(e);
  }
}

// Pure: the observed-identity reference block for a session row.
function sessionRefOf(sess) {
  return {
    sessionId: sess.id,
    projectId: sess.project_id ?? null,
    workspaceId: sess.workspace_id ?? null,
    directory: sess.directory ?? null,
    archived: sess.time_archived != null,
    projectMapping: "unmapped",
  };
}
