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
// { supported:false, hits:[], groups:[] } and the UI shows "update the box".
// searchMessages NEVER throws; DB errors are logged once, the handle is closed
// so the next call reopens (see opencodeDb.mjs), and we return
// { supported:true, hits:[], groups:[], degraded:true } so clients show a
// failure instead of "no matches".
//
// The schema (OpenCode V2, verified on a real 2.0.30 store; do not re-derive):
//   session_message(id, session_id, type, seq, time_created, time_updated, data)
// There is no `part` table: a message's parts are the items of its `data.content`
// (assistant) or its single `data.text` (user/synthetic/system). PART_SQL
// (opencodeDb.mjs) presents them as part rows — id, message_id, session_id,
// time_created, role, V1-shaped JSON `data` — so the match logic below is
// unchanged: only text parts that are not synthetic are searched.

import { getDb, PART_SQL } from "./opencodeDb.mjs";
import { runDbTask } from "./dbOffload.mjs";

const SNIPPET_PRE_CHARS = 60;
const SNIPPET_POST_CHARS = 200;
// SQLite's LIKE is ASCII case-insensitive; we re-check in JS anyway. The
// MAX_LIMIT over-fetch bounds a LIKE scan before the JS text-part filter
// drops non-text rows (tool arguments etc.).
const MAX_LIMIT = 800;
// Wall-clock budget of one search scan (in the db worker, not on the event loop).
export const SEARCH_BUDGET_MS = 8_000;
// One session's text parts matching the pattern, newest first. `/*RANGE*/` is where the
// worker injects the time window (dbTasks.scanWindows); params: session id, LIKE pattern.
const PART_SEARCH_SQL = `
  SELECT p.id AS part_id, p.session_id, p.message_id, p.data AS part_data,
         json_object('role', p.role) AS msg_data, p.time_created
  FROM ${PART_SQL} p
  WHERE p.session_id = ?
    AND json_extract(p.data, '$.text') LIKE ? ESCAPE '\\' /*RANGE*/
  ORDER BY p.time_created DESC, p.id DESC`;

// Pure: the search scope for scope:"all" (D23/D24, spec 06 Q1). The primary
// conversation comes first (even when no window carries it — the active chat is
// always searched), then every window of every project, in `projects` order
// (the same list tmux:list serves), whose `opencodeSessionId` is non-empty,
// de-duplicated. Job windows are included. `labels` maps a session id to the
// tmux session + window name that carries it (the primary only when a window
// does).
export function resolveSearchScope(projects, primarySessionId) {
  const sessionIds = [];
  const seen = new Set();
  const labels = new Map();
  const add = (sid) => {
    if (seen.has(sid)) return;
    seen.add(sid);
    sessionIds.push(sid);
  };
  if (typeof primarySessionId === "string" && primarySessionId !== "") add(primarySessionId);
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const w of Array.isArray(p?.windows) ? p.windows : []) {
      const sid = w?.opencodeSessionId;
      if (typeof sid !== "string" || sid === "") continue;
      add(sid);
      if (!labels.has(sid)) labels.set(sid, { workspace: p.tmuxSession ?? null, name: w.name ?? null });
    }
  }
  return { sessionIds, labels };
}

// Pure: group the flat, scope-ordered hits by session in first-appearance
// order, the primary's group first (`isCurrent`). `label` is the ONLY title
// policy both clients render verbatim: "<workspace> › <name>" when both are
// known, otherwise the raw session id.
export function groupHits(hits, { primarySessionId = null, labels = new Map() } = {}) {
  const order = [];
  const bySession = new Map();
  for (const h of Array.isArray(hits) ? hits : []) {
    let g = bySession.get(h.sessionId);
    if (!g) {
      const known = labels.get(h.sessionId);
      const workspace = known?.workspace ? known.workspace : null;
      const name = known?.name ? known.name : null;
      g = {
        sessionId: h.sessionId,
        isCurrent: primarySessionId != null && h.sessionId === primarySessionId,
        workspace,
        name,
        label: workspace && name ? `${workspace} › ${name}` : h.sessionId,
        hits: [],
      };
      bySession.set(h.sessionId, g);
      order.push(g);
    }
    g.hits.push(h);
  }
  const current = order.find((g) => g.isCurrent);
  return current ? [current, ...order.filter((g) => g !== current)] : order;
}

// The scope source for scope:"all": the same materialized list tmux:list
// serves (rpc.mjs). syncState.refreshNow() never rejects — a failed listing
// only flips `stale` (syncState.mjs) — so success is re-checked explicitly.
// Once a listing has ever succeeded, a later tmux fault keeps the last-known-
// good list (search and the visible session list never disagree); only "never
// listed since boot" is a failure.
export function projectsFromSyncState(syncState) {
  return async () => {
    if (!syncState.everSucceeded()) await syncState.refreshNow();
    if (!syncState.everSucceeded()) {
      const e = new Error("session list unavailable");
      e.code = "scope_unavailable";
      throw e;
    }
    return syncState.snapshot().projects;
  };
}

const EMPTY = () => ({ supported: true, hits: [], groups: [] });
const DEGRADED = () => ({ supported: true, hits: [], groups: [], degraded: true });

// The only exported entry point used by rpc.mjs (and the CTO engine).
//
// Two input forms:
//   • { query, scope:"all", primarySessionId? } — the box enumerates the
//     windows itself (deps.listProjects) and labels/groups the answer.
//   • legacy { query, sessionIds, … } — sessionIds[0] is the primary; the
//     scope and caps come only from these arguments. deps.listProjects is used
//     solely to label the groups and a failure there never changes the hits.
// `deps` = { listProjects?: () => Promise<Project[]>, runDbTask? } (runDbTask
// is a test seam).
export async function searchMessages(input = {}, deps = {}) {
  const {
    query,
    sessionIds,
    scope: scopeMode,
    primarySessionId: primaryInput,
    maxPrimary: maxPrimaryInput,
    maxPerSession = 3,
    maxTotal = 200,
    budgetMs = SEARCH_BUDGET_MS,
  } = input ?? {};
  const run = deps?.runDbTask ?? runDbTask;
  const listProjects = typeof deps?.listProjects === "function" ? deps.listProjects : null;
  const q = typeof query === "string" ? query : "";
  if (q.trim() === "") return EMPTY();

  const primarySessionId =
    typeof primaryInput === "string" && primaryInput !== "" ? primaryInput : null;
  let scope;
  let labels = new Map();
  let maxPrimary = maxPrimaryInput;
  if (scopeMode === "all") {
    // Never answer a partial, primary-only search while claiming full scope.
    if (!listProjects) {
      console.error("[messageSearch] scope:all without a session-list source");
      return DEGRADED();
    }
    let projects;
    try {
      projects = await listProjects();
    } catch (e) {
      console.error("[messageSearch] scope unavailable:", e?.message ?? e);
      return DEGRADED();
    }
    ({ sessionIds: scope, labels } = resolveSearchScope(projects, primarySessionId));
    // No conversation is favoured without a primary.
    if (maxPrimary === undefined) maxPrimary = primarySessionId ? 50 : maxPerSession;
  } else {
    scope = Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : [];
    if (maxPrimary === undefined) maxPrimary = 50;
  }
  if (scope.length === 0) return EMPTY();

  const db = await getDb();
  if (!db) return { supported: false, hits: [], groups: [] };

  try {
    const pattern = likePattern(q);
    const limit = Math.min(maxTotal * 4, MAX_LIMIT);
    // The scan runs OFF the main thread (dbOffload → dbTasks.sessionSearch): a text
    // search over parts can't be answered from an index, and on a multi-GB history
    // it takes seconds to minutes. Newest first, per session, in time windows, under
    // a hard budget — a hit-poor query on a huge history returns the newest matches
    // with `truncated:true` instead of freezing the server.
    const { rows, complete } = await run("sessionSearch", {
      scope,
      sql: PART_SEARCH_SQL,
      pattern,
      limit,
      perSessionLimit: Math.min(limit, Math.max(maxPrimary, maxPerSession) * 4),
      budgetMs: Math.min(Number.isFinite(budgetMs) ? budgetMs : SEARCH_BUDGET_MS, SEARCH_BUDGET_MS),
    });
    const hits = buildHits(rows, q, {
      sessionIds: scope,
      primarySessionId: scope[0],
      maxPrimary,
      maxPerSession,
      maxTotal,
    });
    if (scopeMode !== "all" && hits.length > 0 && listProjects) {
      // Labels only; a failure here never changes the hits (and is not `degraded`).
      try {
        labels = resolveSearchScope(await listProjects(), null).labels;
      } catch (e) {
        console.warn("[messageSearch] label lookup failed:", e?.message ?? e);
      }
    }
    const groups = groupHits(hits, { primarySessionId, labels });
    return complete
      ? { supported: true, hits, groups }
      : { supported: true, hits, groups, truncated: true };
  } catch (e) {
    if (e?.code === "no_db") return { supported: false, hits: [], groups: [] };
    // Query error / worker trouble: log once and say so — the clients render a
    // failure, never "No matches" (never an exception).
    console.error("[messageSearch] query failed:", e?.message ?? e);
    return DEGRADED();
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
