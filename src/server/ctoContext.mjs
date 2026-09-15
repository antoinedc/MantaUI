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
//     unresolved and id semantics are UNVERIFIED
//     (docs/cto-implementation-map.md §4, retracted-draft note); a DB
//     projectID is NEVER surfaced under a name like `workspaceId`, and no
//     checkout/repo/worktree semantics are inferred from it.
//   • NO SIDE EFFECTS. No prompt sends, no tmux/window/job creation, no
//     fetches — a passive read must never wake an agent (spec U04).
//   • HONEST DEGRADATION. `unsupported` (no node:sqlite on this runtime),
//     `source_unavailable` (no DB path / unreadable source — distinct from
//     unsupported, cause preserved through the accessor),
//     `reference_expired` (a stale/unknown session/message reference) and
//     `invalid_input` (bad caller arguments, including the forbidden
//     workspace-key filter) are distinct statuses. An empty result over a
//     healthy source is `status:"ok"` WITH coverage/observedAt — never a
//     fabricated "nothing happened" (spec U27).
//   • BOUNDED. Server-side limits are enforced independently of caller
//     arguments: hit/message limits, keyset cursors that cannot repeat rows
//     and never end the walk while the scan window was full, and a hard
//     24 KiB budget measured on the ACTUAL serialized response (every
//     returned text field — snippets, titles, directories, tool names —
//     counts; cuts set aggregate truncation/omitted metadata; stable IDs are
//     never cut — an item that cannot fit is omitted and counted instead).

import { getDb, getDbOpenFailure } from "./opencodeDb.mjs";
import { likePattern } from "./messageSearch.mjs";

export const CTO_CONTEXT_LIMITS = Object.freeze({
  searchHitsDefault: 20,
  searchHitsMax: 50,
  sessionsDefault: 20,
  sessionsMax: 50,
  aroundBeforeDefault: 5,
  aroundAfterDefault: 5,
  // The 40-message cap INCLUDES the anchor (spec §4.2: "40 messages per
  // request"), so at most 39 neighbors.
  aroundMessagesMax: 40,
  // Spec §4.2: 24 KiB returned text per call, measured on the serialized
  // response, enforced server-side.
  textBudgetBytes: 24 * 1024,
  // Per-part evidence cap inside an `around` window, so one huge tool dump
  // cannot blind the rest of the neighborhood (each cut is reported).
  partEvidenceMaxBytes: 6 * 1024,
  // Per-message bound on how many parts one `around` evidence read may fetch
  // (read-bound; anything beyond is reported via `partsOmitted`).
  partsPerMessageMax: 50,
  // LIKE scan window before the JS-side filter/budget pass (mirrors
  // messageSearch.mjs). When a page fills this window, the cursor advances
  // past the last CONSUMED candidate so older matches stay reachable.
  scanLimit: 800,
});

const ENC = new TextEncoder();
const DEC = new TextDecoder();
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

// Honest degradation with the cause preserved: the accessor reports WHY the
// handle is null — a runtime without node:sqlite is `unsupported`, a missing
// or unreadable source is `source_unavailable`. Never collapsed.
function sourceUnavailable() {
  const cause = getDbOpenFailure();
  if (cause?.reason === "unsupported") {
    return envelope("unsupported", { detail: `node:sqlite unavailable on this runtime: ${cause.detail ?? "unknown"}`, hits: [], sessions: [], messages: [], nextCursor: null, truncated: false, omittedCount: 0 });
  }
  return envelope("source_unavailable", { detail: cause?.detail ?? "no opencode source database is available on this box", hits: [], sessions: [], messages: [], nextCursor: null, truncated: false, omittedCount: 0 });
}

// Clamp a caller limit into [1, max]; a non-number/<=0 argument falls back to
// the default (server-side limits are enforced regardless of caller args).
function clampLimit(value, dflt, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

// Like clampLimit but ZERO is a valid explicit ask (e.g. `around` with
// before:0 after:0 = the anchor only). Negative/non-numeric → default.
function clampCount(value, dflt, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.min(Math.floor(n), max);
}

// Pure: cut `text` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
// code point. Linear: encode once, back up over UTF-8 continuation bytes,
// decode the prefix — never the O(n²) slice-and-reencode loop.
function fitText(text, maxBytes) {
  const source = byteLen(text);
  if (source <= maxBytes) return { text, truncated: false, returnedBytes: source, sourceBytes: source };
  if (maxBytes <= 0) return { text: "", truncated: source > 0, returnedBytes: 0, sourceBytes: source };
  const bytes = ENC.encode(text);
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end--;
  const cut = DEC.decode(bytes.subarray(0, end));
  return { text: cut, truncated: true, returnedBytes: byteLen(cut), sourceBytes: source };
}

// A per-call budget measured on ACTUAL SERIALIZED bytes: the envelope
// (including the session reference and empty item array) is measured first,
// each item is charged at its own full JSON size, and a fixed slack covers
// the fields filled in after charging (nextCursor). The caller can then
// assert the whole serialized response stays within 24 KiB.
// Truncation markers (`<field>Truncated` + two byte counts) are stamped on an
// item AFTER the shrink is computed — reserve room for them so a cut item
// still fits the remaining budget.
const MARKER_SLACK_BYTES = 96;

function createResponseBudget(sampleEnvelope) {
  const CURSOR_SLACK_BYTES = 128;
  let remaining = CTO_CONTEXT_LIMITS.textBudgetBytes - byteLen(JSON.stringify(sampleEnvelope)) - CURSOR_SLACK_BYTES;
  return {
    get remaining() {
      return remaining;
    },
    set remaining(v) {
      remaining = v;
    },
    // Charge one item's full serialized size against the budget. If it does
    // not fit, shrink the named text fields IN ORDER (never IDs or markers)
    // to what remains — each field may carry its own pre-cap (e.g. the
    // per-part evidence cap) — stamping `<field>Truncated` + source/returned
    // byte markers on the item. Returns {ok:false} when the item still
    // cannot fit — the caller omits it entirely and counts it (stable IDs
    // are never emitted in a uselessly cut form).
    charge(item, textFields, caps = {}) {
      let bytes = byteLen(JSON.stringify(item));
      const cuts = [];
      // Track the ORIGINAL field size per field — a budget re-shrink after a
      // pre-cap must still report the full source, not the pre-capped text.
      const original = {};
      for (const field of textFields) {
        const val = item[field];
        if (typeof val === "string") original[field] = byteLen(val);
      }
      // 1. Per-field pre-caps apply ALWAYS (they bound the item shape — e.g.
      // one huge tool dump cannot eat the whole around window), not just on
      // budget pressure.
      for (const field of textFields) {
        const cap = caps[field];
        const val = item[field];
        if (cap == null || typeof val !== "string" || val === "") continue;
        if (byteLen(val) <= cap) continue;
        const fit = fitText(val, cap);
        item[field] = fit.text;
        item[`${field}Truncated`] = true;
        item[`${field}SourceBytes`] = original[field];
        item[`${field}ReturnedBytes`] = fit.returnedBytes;
        cuts.push(field);
      }
      bytes = byteLen(JSON.stringify(item));
      // 2. Budget shrink: only when the item still does not fit the remaining
      // budget (IDs and markers are never cut).
      for (const field of textFields) {
        if (bytes <= remaining) break;
        const val = item[field];
        if (typeof val !== "string" || val === "") break;
        const otherBytes = bytes - byteLen(val);
        const avail = remaining - otherBytes - MARKER_SLACK_BYTES;
        if (avail <= 0) break;
        const fit = fitText(val, Math.min(avail, caps[field] ?? Infinity));
        item[field] = fit.text;
        item[`${field}Truncated`] = true;
        item[`${field}SourceBytes`] = original[field] ?? fit.sourceBytes;
        item[`${field}ReturnedBytes`] = fit.returnedBytes;
        if (!cuts.includes(field)) cuts.push(field);
        bytes = byteLen(JSON.stringify(item));
      }
      if (bytes > remaining) return { ok: false, cuts };
      remaining -= bytes;
      return { ok: true, cuts };
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
// DB's own names/meaning (`projectId` ← project_id, semantics UNVERIFIED per
// the revised map); `projectMapping` is always the explicit "unmapped" marker
// (never a Manta workspace id, no checkout/repo inference).
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
  return envelope("source_unavailable", { detail: `source read failed: ${e?.message ?? e}`, hits: [], sessions: [], messages: [], nextCursor: null, truncated: false, omittedCount: 0 });
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
  if (!db) return sourceUnavailable();

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

    const result = { ...envelope("ok"), sessions: [], truncated: false, omittedCount: 0, nextCursor: null };
    const budget = createResponseBudget(result);
    let earlyBreak = false;
    let anyCut = false;
    for (const row of rows) {
      if (result.sessions.length >= cap) {
        earlyBreak = true;
        break;
      }
      const rec = sessionRecord(row);
      const charged = budget.charge(rec, ["title", "directory"]);
      if (!charged.ok) {
        // Cannot fit even shrunk — stop here so unconsumed candidates stay
        // reachable on the next page (fresh budget) instead of being consumed
        // and lost; this page counts them as omitted.
        earlyBreak = true;
        break;
      }
      if (charged.cuts.length > 0) {
        anyCut = true;
        result.truncated = true;
      }
      result.sessions.push(rec);
    }
    // Cursor rule: an early break (output cap / budget) leaves unconsumed
    // candidate rows — the cursor must stay at the last EMITTED session so
    // they remain reachable. When the loop consumed a FULL scan window, the
    // cursor advances past the last CONSUMED row — even a page with zero
    // emitted sessions then advances, so a discarded/omitted full window can
    // never masquerade as the end of history. A window smaller than the scan
    // cap means the source is exhausted — the walk ends here.
    const windowFull = rows.length === CTO_CONTEXT_LIMITS.scanLimit;
    const lastEmitted = result.sessions[result.sessions.length - 1];
    const lastConsumed = rows[rows.length - 1];
    result.truncated = result.truncated || earlyBreak || windowFull;
    result.omittedCount = Math.max(0, rows.length - result.sessions.length);
    result.nextCursor = earlyBreak
      ? lastEmitted
        ? encodeCursor(lastEmitted.timeUpdated ?? 0, lastEmitted.id)
        : null
      : windowFull && lastConsumed
        ? encodeCursor(lastConsumed.time_updated ?? 0, lastConsumed.id)
        : null;
    return result;
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
//
//    Candidate selection matches the RAW stored JSON and its JSON-ESCAPED
//    query form, so decoded evidence containing quotes, backslashes or
//    newlines (e.g. a Windows path stored as `C:\\Users\\...`) stays
//    reachable — the raw-only LIKE silently excluded those. Parameterized
//    only; no FTS, no index changes.
// ---------------------------------------------------------------------------

// Pure: the JSON-escaped body of `query` as opencode's JSON writer would have
// stored it inside `part.data` (quotes, backslashes, control chars).
function jsonEscapedQuery(query) {
  return JSON.stringify(query).slice(1, -1);
}

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

// Pure: build one hit from a source row + its parsed part/message. Returns
// { hit, fieldBytes } or null.
function buildHit(row, part, msg, q, query) {
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

  // Snippet: a bounded pre/match/post window from the full matched field.
  // Budget fitting happens later on the serialized item (chargeHit), which
  // may collapse this to one truncated string — the match segment is kept
  // first so a cut never silently drops the match itself.
  const idx = match.idx;
  const start = Math.max(0, idx - 60);
  const clean = (s) => s.replace(/\s+/g, " ");
  hit.snippet = {
    pre: clean((start > 0 ? "…" : "") + match.text.slice(start, idx)),
    match: clean(match.text.slice(idx, idx + query.length)),
    post: clean(match.text.slice(idx + query.length, idx + query.length + 200)),
  };
  return { hit, fieldBytes: byteLen(match.text) };
}

// Charge one hit's full serialized size; if it does not fit, collapse the
// snippet to what remains (IDs and tool evidence are never cut) — an
// emitted hit always carries usable stable IDs.
function chargeHit(hit, budget, fieldBytes) {
  const assembled = hit.snippet.pre + hit.snippet.match + hit.snippet.post;
  let bytes = byteLen(JSON.stringify(hit));
  if (bytes <= budget.remaining) {
    budget.remaining -= bytes;
    return { ok: true, cut: false };
  }
  const otherBytes = bytes - byteLen(assembled);
  const avail = budget.remaining - otherBytes - MARKER_SLACK_BYTES;
  if (avail < 0) return { ok: false, cut: false };
  const fit = fitText(assembled, avail);
  hit.snippet = { pre: "", match: fit.text, post: "" };
  hit.snippetTruncated = true;
  hit.snippetSourceBytes = fieldBytes;
  hit.snippetReturnedBytes = fit.returnedBytes;
  bytes = byteLen(JSON.stringify(hit));
  if (bytes > budget.remaining) return { ok: false, cut: true };
  budget.remaining -= bytes;
  return { ok: true, cut: true };
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
  if (!db) return sourceUnavailable();

  try {
    // Dual candidate selection: the raw stored JSON, plus the JSON-escaped
    // form of the query — the raw-only LIKE cannot see decoded quotes,
    // backslashes or newlines (a Windows path is stored as `C:\\...`).
    const where = ["(p.data LIKE ? ESCAPE '\\' OR p.data LIKE ? ESCAPE '\\')"];
    const params = [likePattern(q), likePattern(jsonEscapedQuery(q))];
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

    const result = { ...envelope("ok"), hits: [], truncated: false, omittedCount: 0, nextCursor: null };
    const budget = createResponseBudget(result);
    let earlyBreak = false;
    let anyCut = false;
    for (const row of rows) {
      if (result.hits.length >= cap || budget.remaining <= 0) {
        earlyBreak = true;
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
      const built = buildHit(row, part, msg, q.toLowerCase(), q);
      if (!built) continue;
      const charged = chargeHit(built.hit, budget, built.fieldBytes);
      if (!charged.ok) {
        // Cannot fit even shrunk — stop so unconsumed candidates stay
        // reachable on the next page (fresh budget) instead of being consumed
        // and lost; this page counts them as omitted.
        earlyBreak = true;
        break;
      }
      if (charged.cut) {
        anyCut = true;
        result.truncated = true;
      }
      result.hits.push(built.hit);
    }
    // Cursor rule (see ctoListSessions): early break → cursor at the last
    // EMITTED hit so unconsumed candidates stay reachable; a FULL scan window
    // → cursor past the last CONSUMED candidate, so a page whose whole window
    // was discarded/omitted still advances instead of falsely ending the walk
    // and hiding older matches; a smaller window means the source is
    // exhausted and the walk ends.
    const windowFull = rows.length === CTO_CONTEXT_LIMITS.scanLimit;
    const lastEmitted = result.hits[result.hits.length - 1];
    const lastConsumed = rows[rows.length - 1];
    result.truncated = result.truncated || earlyBreak || windowFull;
    result.omittedCount = Math.max(0, rows.length - result.hits.length);
    result.nextCursor = earlyBreak
      ? lastEmitted
        ? encodeCursor(lastEmitted.timeCreated ?? 0, lastEmitted.partId)
        : null
      : windowFull && lastConsumed
        ? encodeCursor(lastConsumed.time_created ?? 0, lastConsumed.part_id)
        : null;
    return result;
  } catch (e) {
    return queryFailed(e);
  }
}

// ---------------------------------------------------------------------------
// 3. around — the chronological text/tool-evidence neighborhood of one
//    message, with stable source IDs. before/after are message-granular,
//    ZERO is a valid explicit ask (anchor only), and the 40-message cap
//    INCLUDES the anchor (39 neighbors max). Part reads are bounded per
//    message and stop early once the call budget is exhausted, with metadata.
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
// tool output cannot consume the whole window. Stops early once the budget
// is exhausted and reports how many parts were skipped.
function evidenceForParts(partRows, budget) {
  const items = [];
  let skipped = 0;
  for (const row of partRows) {
    if (budget.remaining <= 0) {
      skipped++;
      continue;
    }
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
    const item = {
      partId: row.id,
      kind: isTool ? "tool" : "text",
      timeCreated: row.time_created ?? null,
      text: primary.text,
    };
    if (isTool) {
      item.tool = { name: typeof part.tool === "string" ? part.tool : null, status: part.state?.status ?? null };
    }
    const charged = budget.charge(item, ["text"], { text: CTO_CONTEXT_LIMITS.partEvidenceMaxBytes });
    if (!charged.ok) {
      skipped++;
      continue;
    }
    if (charged.cuts.length > 0) item.textTruncated = true;
    items.push(item);
  }
  return { items, skipped };
}

const MSG_COLS = "id, time_created, time_updated, data";
const PART_READ_LIMIT = CTO_CONTEXT_LIMITS.partsPerMessageMax + 1; // +1 detects overflow

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
  // Server-side clamp: before/after default to 5 each, ZERO is a valid
  // explicit ask (anchor only), and the 40-message cap INCLUDES the anchor —
  // at most 39 neighbors per request (spec §4.2). `after` absorbs whatever
  // slack `before` could not use, so an over-ask fills the cap when the
  // source allows it.
  const maxNeighbors = CTO_CONTEXT_LIMITS.aroundMessagesMax - 1;
  const useBefore = Math.min(clampCount(before ?? CTO_CONTEXT_LIMITS.aroundBeforeDefault, CTO_CONTEXT_LIMITS.aroundBeforeDefault, maxNeighbors), maxNeighbors);

  const db = await getDb();
  if (!db) return sourceUnavailable();

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
    const useAfter = Math.min(
      clampCount(after ?? CTO_CONTEXT_LIMITS.aroundAfterDefault, CTO_CONTEXT_LIMITS.aroundAfterDefault, maxNeighbors),
      maxNeighbors - beforeRows.length,
    );
    const afterRows = useAfter > 0
      ? db
          .prepare(
            `SELECT ${MSG_COLS} FROM message WHERE session_id = ? AND ((time_created > ?) OR (time_created = ? AND id > ?)) ORDER BY time_created ASC, id ASC LIMIT ?`,
          )
          .all(sessionId, anchorRow.time_created ?? 0, anchorRow.time_created ?? 0, anchorRow.id, useAfter)
      : [];

    const chronological = [...beforeRows.slice().reverse(), anchorRow, ...afterRows];
    const result = {
      ...envelope("ok"),
      session: { ...sessionRefOf(sess), anchorMessageId: messageId },
      messages: [],
      truncated: false,
      omittedCount: 0,
    };
    const budget = createResponseBudget(result);

    // Every message RECORD is charged up-front (its id/role/timestamps are
    // returned text too); a record that cannot fit is omitted and counted —
    // stable IDs are never emitted in a uselessly cut form.
    const recs = [];
    for (const row of chronological) {
      const rec = row === anchorRow ? anchorMsg : messageRecord(row);
      if (!budget.charge(rec, []).ok) {
        result.truncated = true;
        result.omittedCount++;
        continue;
      }
      recs.push(rec);
    }

    // Budget priority: the anchor's own evidence is taken FIRST, then the
    // neighborhood in chronological order — one huge before-tool-dump cannot
    // blind the message the caller actually asked about. Part reads are
    // bounded (PART_READ_LIMIT) and stop early once the budget is spent;
    // both report via `partsOmitted`.
    let anyCut = false;
    const buildParts = (rec) => {
      const fetched = db
        .prepare("SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC LIMIT ?")
        .all(rec.id, PART_READ_LIMIT);
      const readCapped = fetched.length > CTO_CONTEXT_LIMITS.partsPerMessageMax;
      const rowsToScan = readCapped ? fetched.slice(0, CTO_CONTEXT_LIMITS.partsPerMessageMax) : fetched;
      const { items, skipped } = evidenceForParts(rowsToScan, budget);
      if (readCapped || skipped > 0) {
        rec.partsOmitted = true;
        result.truncated = true;
        result.omittedCount += skipped;
      }
      if (items.some((it) => it.textTruncated)) {
        anyCut = true;
        result.truncated = true;
      }
      rec.parts = items;
      return skipped;
    };
    const anchorRec = recs.find((r) => r.anchor === true);
    if (anchorRec) buildParts(anchorRec);
    for (const rec of recs) {
      if (rec.parts !== undefined) continue;
      if (budget.remaining <= 0) {
        rec.parts = [];
        rec.partsOmitted = true;
        result.truncated = true;
        result.omittedCount++;
        continue;
      }
      buildParts(rec);
    }
    result.messages = recs;
    result.truncated = result.truncated || anyCut;
    return result;
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
