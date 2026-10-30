// handoff/state.mjs — the persisted shape of ~/.manta/handoffs.json (spec §7)
// and its pure helpers: normalization, retention, record ids, the public view.
//
//   records       prunable card history
//   links         {replacedBy?, replaces?, branchedFrom?, branches[]} per session
//   continuations per successor: {recordId, preamble?, claim?, draft?, draftRevision?, draftConsumed?, send?}
//   fences        pred session -> {successorId, recordId}
//   held          target session -> [{id, kind, args, at}] admissions parked by a fence / claim / release
//   dismissedSessions  session -> when the user dismissed its handoff suggestions
//   sessionModes       session -> its own handoff mode (absent = the box default)

import { randomBytes } from "node:crypto";
import { HANDOFF_MODES } from "./policy.mjs";

export const RECORD_RETENTION_MS = 30 * 24 * 3600_000;
export const RECORD_RETENTION_MAX = 500;
export const TERMINAL_STATES = Object.freeze(["committed", "failed", "cancelled", "dismissed"]);

export function emptyState() {
  return { version: 1, records: {}, links: {}, continuations: {}, fences: {}, held: {}, dismissedSessions: {}, sessionModes: {} };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** PURE. Any parsed JSON → a well-formed state; garbage degrades to empty sections. */
export function normalizeState(raw) {
  const s = emptyState();
  if (!isObj(raw)) return s;
  for (const k of ["records", "links", "continuations", "fences"]) if (isObj(raw[k])) s[k] = raw[k];
  if (isObj(raw.held)) {
    for (const [k, v] of Object.entries(raw.held)) if (Array.isArray(v) && v.length > 0) s.held[k] = v;
  }
  if (isObj(raw.dismissedSessions)) {
    for (const [k, v] of Object.entries(raw.dismissedSessions)) if (typeof v === "number" && Number.isFinite(v)) s.dismissedSessions[k] = v;
  }
  if (isObj(raw.sessionModes)) {
    for (const [k, v] of Object.entries(raw.sessionModes)) if (HANDOFF_MODES.includes(v)) s.sessionModes[k] = v;
  }
  return s;
}

/** `hof_` + 20 base36 characters (§15). */
export function mintRecordId(bytes = randomBytes(16)) {
  const n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  return `hof_${n.toString(36).padStart(20, "0").slice(-20)}`;
}

/** PURE. A continuation whose content a client or the next admission still has to consume — never pruned. */
export function continuationUnconsumed(c) {
  if (!isObj(c)) return false;
  return Boolean(c.preamble || c.claim || (c.send && !c.send.confirmed) || (c.draft && c.draftConsumed !== c.draftRevision));
}

/**
 * PURE. Drop terminal records older than 30 days and beyond the newest 500 —
 * EXCEPT records whose continuation is unconsumed (and anything not terminal).
 * @returns {string[]} the ids removed (state is mutated)
 */
export function pruneRecords(state, now, { maxAge = RECORD_RETENTION_MS, max = RECORD_RETENTION_MAX } = {}) {
  const keep = (r) => {
    if (!TERMINAL_STATES.includes(r.state)) return true;
    const cont = r.successorId ? state.continuations[r.successorId] : null;
    return continuationUnconsumed(cont);
  };
  const removed = [];
  const terminal = Object.values(state.records)
    .filter((r) => TERMINAL_STATES.includes(r.state) && !keep(r))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  terminal.forEach((r, i) => {
    if (i >= max || now - r.updatedAt > maxAge) {
      delete state.records[r.id];
      removed.push(r.id);
    }
  });
  // A consumed continuation is dead weight once its record is gone.
  for (const [sid, c] of Object.entries(state.continuations)) {
    if (!continuationUnconsumed(c) && !state.records[c.recordId]) delete state.continuations[sid];
  }
  return removed;
}

/**
 * Drop links while NEITHER end exists any more (§7). `exists(sessionId)` is
 * async and must answer true when unsure — only a definitive absence prunes.
 */
export async function pruneLinks(state, exists) {
  const gone = new Set();
  const alive = async (sid) => {
    if (gone.has(sid)) return false;
    const ok = await exists(sid);
    if (!ok) gone.add(sid);
    return ok;
  };
  for (const [sid, l] of Object.entries(state.links)) {
    const ends = [sid, l.replacedBy, l.replaces, l.branchedFrom, ...(l.branches ?? [])].filter(Boolean);
    let any = false;
    for (const e of ends) {
      if (await alive(e)) {
        any = true;
        break;
      }
    }
    if (!any) delete state.links[sid];
  }
}

const isSendRecord = (r) => r?.internal?.plan?.disposition === "send" || r?.disposition === "send";

/**
 * PURE. Whether a Rewrite (a full-history generation on the session's own model)
 * can be offered on a record right now: it settled (`ready`/`failed`), it was
 * written from a trimmed transcript (`rewriteEstimate` exists), it is not a
 * send, and its source session was not replaced. Transient locks are NOT part of
 * it — they publish nothing when released; the action itself answers `busy`.
 * @param {any} r
 * @param {{ replaced?: boolean }} [o]
 */
export function rewriteAvailable(r, { replaced = false } = {}) {
  return rewriteBlockedReason(r, { replaced }) === null;
}

/** PURE. Why a Rewrite isn't available (a sentence a person can read), or null when it is. */
export function rewriteBlockedReason(r, { replaced = false } = {}) {
  if (!r) return "This handoff has expired.";
  if (r.state === "generating") return "This handoff is being written right now.";
  if (r.state !== "ready" && r.state !== "failed") return "This handoff can't be rewritten right now.";
  if (isSendRecord(r)) return "A handoff that starts a new conversation can't be rewritten.";
  if (replaced) return "This conversation was already handed off.";
  if (!r.rewriteEstimate) return "Only a handoff written from a trimmed transcript can be rewritten.";
  return null;
}

/**
 * The client-facing record: the §11 contract fields only — internals stay on the box.
 * `replaced` = the record's source session has been replaced (it feeds `canRewrite`).
 */
export function publicRecord(r, { replaced = false } = {}) {
  if (!r) return null;
  const out = {
    id: r.id,
    fromSessionId: r.fromSessionId,
    kind: r.kind,
    trigger: r.trigger,
    state: r.state,
    text: r.text ?? "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  for (const k of ["successorId", "messageId", "step", "how", "disposition", "reason", "contextTokens", "writer", "rewriteEstimate"]) if (r[k] !== undefined) out[k] = r[k];
  out.canRewrite = rewriteAvailable(r, { replaced });
  return out;
}

export function publicEvent(r, { replaced = false } = {}) {
  const p = { id: r.id, fromSessionId: r.fromSessionId, state: r.state };
  for (const k of ["successorId", "how", "disposition", "writer", "rewriteEstimate"]) if (r[k] !== undefined) p[k] = r[k];
  p.canRewrite = rewriteAvailable(r, { replaced });
  return p;
}
