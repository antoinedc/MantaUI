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
//     (docs/cto-implementation-map.md §4); a DB projectID is NEVER surfaced
//     under a name like `workspaceId`, and no checkout/repo/worktree
//     semantics are inferred from it.
//   • NO SIDE EFFECTS. No prompt sends, no tmux/window/job creation, no
//     fetches — a passive read must never wake an agent (spec U04).
//   • HONEST DEGRADATION. `unsupported` (no node:sqlite on this runtime),
//     `source_unavailable` (no DB path / unreadable source — distinct from
//     unsupported, cause preserved through the accessor),
//     `reference_expired` (a stale/unknown session/message/part reference)
//     and `invalid_input` (bad caller arguments, including the forbidden
//     workspace-key filter) are distinct statuses. An empty result over a
//     healthy source is `status:"ok"` WITH coverage/observedAt — never a
//     fabricated "nothing happened" (spec U27).
//   • ONE AUTHORITATIVE BUDGET. The completed response's SERIALIZED size is
//     the only measure — no per-field parallel accounting, no slack guesses.
//     After each item is added, if the whole response exceeds 24 KiB the
//     item's designated text fields are bounded (serialized-aware, measured
//     on the completed response) and only if that cannot suffice is the item
//     omitted and counted — the walk then CONTINUES and the cursor rules
//     keep every older source row reachable. Stable IDs are never cut.
//   • SERIALIZER-INDEPENDENT MATCHING. Search candidates are selected on the
//     DECODED JSON fields (SQLite json_extract), never on raw stored JSON —
//     the stored form is serializer-dependent (`café` vs `caf\u00e9`, `\/`,
//     surrogate escapes); JS matching stays authoritative.
//   • BOUNDED. Server-side limits are enforced independently of caller
//     arguments: hit/message/part limits, keyset cursors that cannot repeat
//     rows and never end the walk while the scan window was full.

import { getDb, getDbOpenFailure } from "./opencodeDb.mjs";

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
  // Spec §4.2: 24 KiB returned text per call, measured on the SERIALIZED
  // response, enforced server-side.
  textBudgetBytes: 24 * 1024,
  // Per-part evidence cap inside an `around` window, so one huge tool dump
  // cannot blind the rest of the neighborhood (each cut is reported).
  partEvidenceMaxBytes: 6 * 1024,
  // Per-message bound on how many parts one `around` evidence read may fetch
  // (read-bound; anything beyond is reported via `partsOmitted`). When the
  // read is anchored at a partId, the window is centered on that part.
  partsPerMessageMax: 50,
  // Scan window before the JS-side filter pass (mirrors messageSearch.mjs).
  // When a page fills this window, the cursor advances past the last
  // CONSUMED candidate so older matches stay reachable.
  scanLimit: 800,
});

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const byteLen = (s) => ENC.encode(s).length;
const serializedBytes = (o) => byteLen(JSON.stringify(o));

// ---------------------------------------------------------------------------
// Shared envelope + the ONE authoritative budget helper
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

// The ONE authoritative budget mechanism — there is no parallel per-field
// accounting and no slack guesses. Items are constructed FULLY first
// (including pre-caps and markers); then `compactToBudget` enforces the only
// invariant that matters: the COMPLETED response's serialized size.
// Phase 1 bounds the largest field with an exact minimal cut (content-
// maximal); phase 2 fair-shares the remaining overflow across all boundable
// fields; phase 3 drops units tail-first only when bounding is exhausted.
// Every step is measured on the completed response, so JSON escape expansion
// (newlines, quotes, \uXXXX) cannot defeat a cut. Stable IDs are never cut —
// only the named text fields shrink; every cut is stamped with omitted-size
// metadata.
function stampBound(obj, field, text, markerObj, prefix, sourceBytes) {
  obj[field] = text;
  if (!markerObj || typeof markerObj !== "object") return;
  markerObj[`${prefix}Truncated`] = true;
  markerObj[`${prefix}SourceBytes`] = sourceBytes;
  markerObj[`${prefix}ReturnedBytes`] = byteLen(text);
}

function clearBound(markerObj, prefix) {
  if (!markerObj || typeof markerObj !== "object") return;
  delete markerObj[`${prefix}Truncated`];
  delete markerObj[`${prefix}SourceBytes`];
  delete markerObj[`${prefix}ReturnedBytes`];
}

// Serialized-aware exact minimal cut of one field: binary-search the largest
// raw cut whose COMPLETED serialized response fits the budget. Returns the
// best text, or null when even an emptied field cannot make it fit.
function exactBoundField(result, obj, field, markerObj, prefix, sourceBytes) {
  const val = obj[field];
  let lo = 0;
  let hi = byteLen(val);
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    stampBound(obj, field, fitText(val, mid).text, markerObj, prefix, sourceBytes);
    if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) {
      best = obj[field];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function compactToBudget(result, units) {
  // `units`: drop-order list (tail first) of { fields: [{obj, field,
  // sourceBytes?, markerObj?, prefix?}], pop: () => void }.
  if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) return;
  result.truncated = true; // any compaction is an honest cut — reported
  const allFields = units
    .flatMap((u) => u.fields)
    .filter((f) => typeof f.obj?.[f.field] === "string" && f.obj[f.field] !== "");
  const markerOf = (f) => ({ markerObj: f.markerObj ?? f.obj, prefix: f.prefix ?? f.field });
  const originalOf = (f) => {
    const { markerObj, prefix } = markerOf(f);
    return f.sourceBytes ?? markerObj[`${prefix}SourceBytes`] ?? byteLen(f.obj[f.field]);
  };
  // Snapshot the TRUE original sizes ONCE — phase 1's restores clear markers,
  // and later phases must still report the full source size, not a shrunk
  // intermediate.
  const trueOriginal = new Map(allFields.map((f) => [f, originalOf(f)]));
  const srcOf = (f) => trueOriginal.get(f);

  // Protected fields (the requested anchor part's evidence) are excluded
  // from EVERY non-final pass: neighbors relieve the overflow first — the
  // decisive anchor text is trimmed only in the final pass, and only when no
  // neighbor shrink can satisfy the budget.
  const protectedSet = new Set(
    units
      .filter((u) => u.canDrop === false)
      .flatMap((u) => u.fields)
      .filter((f) => f.protected),
  );
  // Phase 1 — exact minimal cut, largest field first — over UNPROTECTED
  // fields only. A field that cannot cover the whole overflow is restored
  // (markers cleaned — later phases decide).
  const bySize = allFields
    .filter((f) => !protectedSet.has(f))
    .sort((a, b) => byteLen(b.obj[b.field]) - byteLen(a.obj[a.field]));
  for (const f of bySize) {
    if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) return;
    const val = f.obj[f.field];
    const { markerObj, prefix } = markerOf(f);
    const best = exactBoundField(result, f.obj, f.field, markerObj, prefix, srcOf(f));
    if (best != null) {
      stampBound(f.obj, f.field, best, markerObj, prefix, srcOf(f));
      return;
    }
    f.obj[f.field] = val;
    clearBound(markerObj, prefix);
  }

  // Phase 2 — proportional fair share over the UNPROTECTED fields: no single
  // field covers the overflow, so each gives up an amount PROPORTIONAL to
  // its size (small evidence survives; big dumps give the most; PROTECTED
  // fields — the requested anchor part's evidence — give last). Rounds
  // re-measure the completed response until it fits or nothing is left.
  let guard = 64;
  while (serializedBytes(result) > CTO_CONTEXT_LIMITS.textBudgetBytes && guard-- > 0) {
    const live = allFields.filter((f) => f.obj[f.field] !== "" && !protectedSet.has(f));
    if (live.length === 0) break;
    const over = serializedBytes(result) - CTO_CONTEXT_LIMITS.textBudgetBytes;
    const total = live.reduce((n, f) => n + byteLen(f.obj[f.field]), 0);
    for (const f of live) {
      const val = f.obj[f.field];
      const share = Math.min(byteLen(val), Math.ceil((over * byteLen(val)) / total) + 1);
      const { markerObj, prefix } = markerOf(f);
      stampBound(f.obj, f.field, fitText(val, byteLen(val) - share).text, markerObj, prefix, srcOf(f));
    }
  }

  // Phase 3 — drop units tail-first until the response fits. Protected
  // units (canDrop:false, e.g. the requested anchor part's evidence) are
  // skipped, never omitted.
  for (const unit of units) {
    if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) return;
    if (unit.canDrop === false) continue;
    unit.pop();
    result.truncated = true;
  }

  // Phase 4 — last resort: bound the PROTECTED fields themselves (the
  // requested evidence is bounded, never omitted).
  for (const f of allFields) {
    if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) return;
    if (!protectedSet.has(f)) continue;
    const val = f.obj[f.field];
    if (typeof val !== "string" || val === "") continue;
    const { markerObj, prefix } = markerOf(f);
    const best = exactBoundField(result, f.obj, f.field, markerObj, prefix, srcOf(f));
    if (best != null) stampBound(f.obj, f.field, best, markerObj, prefix, srcOf(f));
    result.truncated = true;
  }
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

// Cursor rules shared by the two paginated ops: an output-cap early break
// leaves unconsumed candidates — the cursor stays at the last EMITTED item so
// they remain reachable. Items omitted by the budget compaction must stay
// reachable too: the cursor then also points at the last EMITTED item, so the
// next page retries them with a fresh budget (or, with nothing emitted,
// advances past the last consumed row — never a false end). A FULL scan
// window with nothing omitted advances the cursor past the last CONSUMED row
// — even a fully-discarded page continues the walk. A smaller window with
// nothing omitted means the source is exhausted — the walk ends here.
function finishPage(result, { earlyBreak, rows, emitted, timeKey, idKey, emittedTimeKey, emittedIdKey }) {
  const windowFull = rows.length === CTO_CONTEXT_LIMITS.scanLimit;
  const anyOmitted = emitted.length < rows.length;
  const lastEmitted = emitted[emitted.length - 1];
  const lastConsumed = rows[rows.length - 1];
  result.truncated = result.truncated || earlyBreak || windowFull || anyOmitted;
  result.omittedCount = Math.max(0, rows.length - emitted.length);
  const lastEmittedCursor = lastEmitted ? encodeCursor(lastEmitted[emittedTimeKey] ?? 0, lastEmitted[emittedIdKey]) : null;
  const lastConsumedCursor = lastConsumed ? encodeCursor(lastConsumed[timeKey] ?? 0, lastConsumed[idKey]) : null;
  result.nextCursor = earlyBreak
    ? lastEmittedCursor
    : anyOmitted
      ? (lastEmittedCursor ?? lastConsumedCursor)
      : windowFull
        ? lastConsumedCursor
        : null;
  return result;
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
    let earlyBreak = false;
    for (const row of rows) {
      if (result.sessions.length >= cap) {
        earlyBreak = true;
        break;
      }
      result.sessions.push(sessionRecord(row));
    }
    // ONE authoritative compaction, iterated until the WHOLE completed
    // response — cursor included — fits: bound escape-heavy titles and
    // directories first (measured on the completed response); drop tail
    // sessions only when no bound suffices. Each omission is counted and
    // stays retry-reachable via the cursor rules.
    const page = { earlyBreak, rows, emitted: result.sessions, timeKey: "time_updated", idKey: "id", emittedTimeKey: "timeUpdated", emittedIdKey: "id" };
    let guard = 16;
    while (guard-- > 0) {
      compactToBudget(
        result,
        result.sessions.slice().reverse().map((rec) => ({
          fields: [
            { obj: rec, field: "title" },
            { obj: rec, field: "directory" },
          ],
          pop: () => result.sessions.pop(),
        })),
      );
      finishPage(result, page);
      if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) break;
    }
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
//    Candidate selection is SERIALIZER-INDEPENDENT: the DECODED JSON fields
//    are matched in SQL (json_extract + instr, case-folded like LIKE's ASCII
//    semantics), never the raw stored JSON — whose escape form depends on the
//    writer (`café` vs `caf\u00e9`, `\/`, surrogate pairs). JS matching stays
//    authoritative. Parameterized only; no FTS, no index changes.
// ---------------------------------------------------------------------------

// The decoded-field candidate predicate. json_valid guards malformed rows;
// COALESCE keeps NULL extracts out of the OR chain.
// Candidate selection matches the DECODED JSON atoms (json_tree), never the
// raw stored bytes and never a re-serialization of structured values — the
// stored escape form is writer-dependent (`café` vs `caf\u00e9`, `\/`,
// surrogate pairs), and json_extract on a nested object returns that object's
// JSON text, not its decoded inner strings. json_tree yields every scalar
// atom decoded, whatever serializer wrote the row. ASCII-case-folded, like
// the previous LIKE semantics; parameterized; no FTS, no index changes.
const DECODED_MATCH_SQL = `(
  json_valid(p.data) AND EXISTS (
    SELECT 1 FROM json_tree(p.data) jt
    WHERE jt.type NOT IN ('object', 'array')
      AND instr(lower(COALESCE(jt.value, '')), lower(?)) > 0
  )
)`;
// The FIRST matching decoded atom (document order) — its fullkey names the
// field (part+field provenance) and json_extract decodes the value. The
// candidate handed to JS is this BOUND MATCHED atom itself — not a capped
// client-side traversal, which could hide a true match beyond its caps.
const MATCHED_ATOM_SQL = `(
  SELECT a.fullkey FROM json_tree(p.data) a
  WHERE a.type NOT IN ('object', 'array')
    AND instr(lower(COALESCE(a.value, '')), lower(?)) > 0
  ORDER BY a.id LIMIT 1
)`;
// Which search field a matched atom belongs to, from its fullkey — the
// candidate evidence stays tied to its part+field.
function matchedFieldOf(fullkey) {
  if (typeof fullkey !== "string") return "text";
  if (fullkey === "$.tool") return "tool_name";
  if (fullkey === "$.state.input" || fullkey.startsWith("$.state.input")) return "input";
  if (fullkey === "$.state.output" || fullkey.startsWith("$.state.output")) return "output";
  return "text";
}

// Pure: the decoded scalar strings of a structured JSON value (bounded) —
// the serializer-independent searchable representation, aligned with the
// SQL json_tree atoms so a SQL candidate is always verifiable in JS.
function scalarTexts(value, out = [], seen = { n: 0 }, depth = 0) {
  if (out.length >= 32 || seen.n >= 64 || depth > 4) return out;
  seen.n++;
  if (typeof value === "string") {
    if (value !== "") out.push(value);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      scalarTexts(v, out, seen, depth + 1);
      if (out.length >= 32) break;
    }
    return out;
  }
  if (value != null) out.push(String(value));
  return out;
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
    // Structured input/output contribute their DECODED scalar strings —
    // never a JSON.stringify re-serialization, whose escaping would diverge
    // from what the SQL json_tree atoms matched.
    for (const t of scalarTexts(state?.input)) out.push({ field: "input", text: t });
    for (const t of scalarTexts(state?.output)) out.push({ field: "output", text: t });
    return out.filter((c) => c.text !== "");
  }
  return [];
}

// Pure: build one hit from a source row + its parsed part/message. The
// snippet is assembled unbounded here; the authoritative completed-response
// budget bounds it after the push.
function buildHit(row, part, msg, q, query) {
  let role = "assistant";
  if (msg && typeof msg === "object" && msg.role === "user") role = "user";

  // The candidate is the BOUND MATCHED atom derived from SQL json_tree —
  // tied to its part and field, aligned across serializer escape forms and
  // nested structures, bounded by the SQL LIMIT (never a huge JS tree walk).
  // Part-shape filters (synthetic/ignored text) still apply — they are
  // properties of the part, not of query matching.
  if (part.type === "text" && (part.synthetic || part.ignored)) return null;
  const matched = row.match_value == null ? "" : String(row.match_value);
  const idx = matched.toLowerCase().indexOf(q);
  if (matched === "" || idx < 0) return null;
  const field = matchedFieldOf(row.match_fullkey);

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
    hit.tool = { name: typeof part.tool === "string" ? part.tool : null, status: part.state?.status ?? null, matchedField: field };
  }

  const start = Math.max(0, idx - 60);
  const clean = (s) => s.replace(/\s+/g, " ");
  hit.snippet = {
    pre: clean((start > 0 ? "…" : "") + matched.slice(start, idx)),
    match: clean(matched.slice(idx, idx + query.length)),
    post: clean(matched.slice(idx + query.length, idx + query.length + 200)),
  };
  return { hit, fieldBytes: byteLen(matched) };
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
    // Placeholder order: the two MATCHED_ATOM_SQL subqueries in the SELECT
    // list bind first, then the WHERE's EXISTS, then the filter placeholders.
    const where = [DECODED_MATCH_SQL];
    const params = [q, q, q];
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
             p.data AS part_data, m.data AS msg_data,
             json_extract(p.data, ${MATCHED_ATOM_SQL}) AS match_value,
             ${MATCHED_ATOM_SQL} AS match_fullkey
      FROM part p
      JOIN message m ON m.id = p.message_id
      LEFT JOIN session s ON s.id = p.session_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.time_created DESC, p.id DESC
      LIMIT ?`;
    const rows = db.prepare(sql).all(...params, CTO_CONTEXT_LIMITS.scanLimit);

    const result = { ...envelope("ok"), hits: [], truncated: false, omittedCount: 0, nextCursor: null };
    let earlyBreak = false;
    for (const row of rows) {
      if (result.hits.length >= cap) {
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
      result.hits.push(built.hit);
      // Non-enumerable: the full matched-field size for the omitted-size
      // metadata if the budget bounds this hit's snippet.
      Object.defineProperty(built.hit, "_fieldBytes", { value: built.fieldBytes, enumerable: false });
    }
    // ONE authoritative compaction, iterated until the WHOLE completed
    // response — cursor included — fits: bound snippet `match` segments first
    // (metadata names the FULL matched field); drop tail hits only when no
    // bound suffices. Each omission is counted and stays retry-reachable via
    // the cursor rules.
    const page = { earlyBreak, rows, emitted: result.hits, timeKey: "time_created", idKey: "part_id", emittedTimeKey: "timeCreated", emittedIdKey: "partId" };
    let guard = 16;
    while (guard-- > 0) {
      compactToBudget(
        result,
        result.hits.slice().reverse().map((hit) => ({
          fields: [{ obj: hit.snippet, field: "match", sourceBytes: hit._fieldBytes, markerObj: hit, prefix: "match" }],
          pop: () => result.hits.pop(),
        })),
      );
      finishPage(result, page);
      if (serializedBytes(result) <= CTO_CONTEXT_LIMITS.textBudgetBytes) break;
    }
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
//    message; `partId` anchors the anchor message's part window on that exact
//    part — the contract a search hit uses to fetch its evidence even when
//    the part lies beyond the first bounded read.
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

// Pure: one evidence item from a part row. The text is pre-capped to
// partEvidenceMaxBytes (a shape bound — one huge tool dump cannot eat the
// whole window); the authoritative completed-response budget bounds it
// further after the push.
function buildPartItem(row) {
  let part;
  try {
    part = JSON.parse(row.data);
  } catch {
    return null;
  }
  const candidates = partCandidates(part);
  if (candidates.length === 0) return null;
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
  if (byteLen(item.text) > CTO_CONTEXT_LIMITS.partEvidenceMaxBytes) {
    const fit = fitText(item.text, CTO_CONTEXT_LIMITS.partEvidenceMaxBytes);
    item.text = fit.text;
    item.textTruncated = true;
    item.textSourceBytes = fit.sourceBytes;
    item.textReturnedBytes = fit.returnedBytes;
  }
  return item;
}

const MSG_COLS = "id, time_created, time_updated, data";
const PART_READ_LIMIT = CTO_CONTEXT_LIMITS.partsPerMessageMax + 1; // +1 detects overflow
// When anchored at a partId, the part window is centered: this many parts on
// EACH side of the anchor part (+ the part itself) — all keyset reads, never
// a full unbounded load.
const PART_ANCHOR_SIDE = Math.floor((CTO_CONTEXT_LIMITS.partsPerMessageMax - 1) / 2);

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
    parts: [],
  };
}

export async function ctoAround({ sessionId, messageId, partId, before, after } = {}) {
  if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") {
    return invalidInput("sessionId and messageId are required source references");
  }
  if (partId != null && (typeof partId !== "string" || partId === "")) {
    return invalidInput("partId must be a source part id when provided");
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

    // Optional partId anchor: the anchor message's evidence window centers on
    // this exact part (the contract a search hit uses to reach its evidence
    // even beyond the first bounded part read).
    let anchorPartRow = null;
    if (partId != null) {
      anchorPartRow = db.prepare("SELECT id, time_created, data FROM part WHERE id = ? AND message_id = ? AND session_id = ?").get(partId, messageId, sessionId);
      if (!anchorPartRow) {
        return envelope("reference_expired", { detail: `part ${partId} not found in source message ${messageId}`, messages: [], truncated: false, omittedCount: 0 });
      }
    }

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

    const result = {
      ...envelope("ok"),
      session: { ...sessionRefOf(sess), anchorMessageId: messageId, anchorPartId: partId ?? null },
      messages: [],
      truncated: false,
      omittedCount: 0,
    };

    const chronological = [...beforeRows.slice().reverse(), anchorRow, ...afterRows];
    const recs = chronological.map((row) => (row === anchorRow ? messageRecord(anchorRow, { anchor: true }) : messageRecord(row)));
    result.messages = recs;

    // Part reads: the anchor message first (budget priority), centered on the
    // partId anchor when given; the neighborhood messages read their first
    // bounded window. Items are constructed fully; the compaction below is
    // the only budget authority.
    const fillParts = (rec, anchored) => {
      let itemsSource;
      let readCapped = false;
      if (anchored && anchorPartRow) {
        const side = PART_ANCHOR_SIDE;
        const beforeParts = db
          .prepare(
            "SELECT id, time_created, data FROM part WHERE message_id = ? AND ((time_created < ?) OR (time_created = ? AND id < ?)) ORDER BY time_created DESC, id DESC LIMIT ?",
          )
          .all(rec.id, anchorPartRow.time_created ?? 0, anchorPartRow.time_created ?? 0, anchorPartRow.id, side + 1);
        const afterParts = db
          .prepare(
            "SELECT id, time_created, data FROM part WHERE message_id = ? AND ((time_created > ?) OR (time_created = ? AND id > ?)) ORDER BY time_created ASC, id ASC LIMIT ?",
          )
          .all(rec.id, anchorPartRow.time_created ?? 0, anchorPartRow.time_created ?? 0, anchorPartRow.id, side + 1);
        if (beforeParts.length > side || afterParts.length > side) readCapped = true;
        itemsSource = [...beforeParts.slice(0, side).reverse(), anchorPartRow, ...afterParts.slice(0, side)];
        // A centered window may still leave parts of this message outside it
        // (e.g. 60 parts, window 49) — one bounded COUNT says so honestly.
        if (!readCapped) {
          const total = db.prepare("SELECT count(*) AS n FROM part WHERE message_id = ?").get(rec.id).n;
          readCapped = total > itemsSource.length;
        }
      } else {
        const fetched = db
          .prepare("SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC LIMIT ?")
          .all(rec.id, PART_READ_LIMIT);
        readCapped = fetched.length > CTO_CONTEXT_LIMITS.partsPerMessageMax;
        itemsSource = readCapped ? fetched.slice(0, CTO_CONTEXT_LIMITS.partsPerMessageMax) : fetched;
      }
      rec.parts = [];
      for (const partRow of itemsSource) {
        const item = buildPartItem(partRow);
        if (item) rec.parts.push(item);
      }
      if (readCapped || rec.parts.some((it) => it.textTruncated)) {
        rec.partsOmitted = rec.partsOmitted || readCapped;
        result.truncated = true;
      }
    };
    const anchorRec = recs.find((r) => r.anchor === true);
    if (anchorRec) fillParts(anchorRec, Boolean(anchorPartRow));
    for (const rec of recs) {
      if (rec === anchorRec) continue;
      fillParts(rec, false);
    }

    // ONE authoritative compaction over the COMPLETED response. Units remove
    // their OWN object by reference — never a blind pop, which removed the
    // anchor message while compacting an earlier one. The requested anchor
    // part's evidence is protected (boundable, never omitted); the anchor
    // message is never dropped.
    const units = [];
    for (let m = result.messages.length - 1; m >= 0; m--) {
      const rec = result.messages[m];
      if (Array.isArray(rec.parts)) {
        for (let p = rec.parts.length - 1; p >= 0; p--) {
          const item = rec.parts[p];
          units.push({
            fields: [{ obj: item, field: "text", protected: item.partId === partId }],
            canDrop: item.partId !== partId,
            pop: () => {
              const at = rec.parts.indexOf(item);
              if (at >= 0) rec.parts.splice(at, 1);
              rec.partsOmitted = true;
              result.omittedCount++;
            },
          });
        }
      }
      if (!rec.anchor) {
        units.push({
          fields: [],
          pop: () => {
            const at = result.messages.indexOf(rec);
            if (at >= 0) result.messages.splice(at, 1);
            result.omittedCount++;
          },
        });
      }
    }
    compactToBudget(result, units);
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
