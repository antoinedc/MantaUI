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
//   repairs            one-time data repairs already done -> the ISO time they completed; `pendingTaskLinks`
//                      ({ [pred]: { succ, since } }) holds the subagent links the repair could not yet judge
//   successors         session -> true for every session Manta made as a handoff successor (durable provenance:
//                      never pruned with the records, so "original or Manta-made" survives record retention)
//   arrivals           fenced session -> background results that landed on it during a handoff transition
//                      (relayed to the successor at commit, dropped at rollback)
//   relays             relay id -> { admitted, suppressed, at, from, original, rec?, tries?, nextAt? } (durable relay
//                      idempotency; `admitted:false` / `suppressed:null` are UNRESOLVED work a retry driver finishes)

import { randomBytes } from "node:crypto";
import { HANDOFF_MODES } from "./policy.mjs";

export const RECORD_RETENTION_MS = 30 * 24 * 3600_000;
export const RECORD_RETENTION_MAX = 500;
export const TERMINAL_STATES = Object.freeze(["committed", "failed", "cancelled", "dismissed"]);

export function emptyState() {
  return { version: 1, records: {}, links: {}, continuations: {}, fences: {}, held: {}, dismissedSessions: {}, sessionModes: {}, repairs: {}, successors: {}, arrivals: {}, relays: {} };
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
  if (isObj(raw.repairs)) {
    for (const [k, v] of Object.entries(raw.repairs)) {
      if (k === "pendingTaskLinks") {
        const pending = {};
        if (isObj(v)) {
          for (const [pred, e] of Object.entries(v)) if (isObj(e) && typeof e.succ === "string" && e.succ && typeof e.since === "number" && Number.isFinite(e.since)) pending[pred] = { succ: e.succ, since: e.since };
        }
        if (Object.keys(pending).length > 0) s.repairs.pendingTaskLinks = pending;
      } else if (typeof v === "string" && v) s.repairs[k] = v;
    }
  }
  if (isObj(raw.successors)) {
    for (const [k, v] of Object.entries(raw.successors)) if (v === true) s.successors[k] = true;
  }
  if (isObj(raw.arrivals)) {
    for (const [k, v] of Object.entries(raw.arrivals)) {
      const list = (Array.isArray(v) ? v : []).filter((a) => isObj(a) && typeof a.id === "string" && a.id).map((a) => ({
        id: a.id,
        ...(typeof a.text === "string" ? { text: a.text } : {}),
        ...(typeof a.description === "string" ? { description: a.description } : {}),
        metadata: isObj(a.metadata) ? a.metadata : {},
        at: typeof a.at === "number" && Number.isFinite(a.at) ? a.at : 0,
      }));
      if (list.length > 0) s.arrivals[k] = list;
    }
  }
  if (isObj(raw.relays)) {
    for (const [k, v] of Object.entries(raw.relays)) {
      if (!isObj(v) || typeof v.at !== "number" || !Number.isFinite(v.at)) continue;
      s.relays[k] = {
        admitted: v.admitted === true,
        suppressed: RELAY_SUPPRESSED.includes(v.suppressed) ? v.suppressed : null,
        at: v.at,
        ...(typeof v.from === "string" ? { from: v.from } : {}),
        ...(typeof v.original === "string" ? { original: v.original } : {}),
        ...(isObj(v.rec) && typeof v.rec.id === "string" ? { rec: { id: v.rec.id, ...(typeof v.rec.text === "string" ? { text: v.rec.text } : {}), ...(typeof v.rec.description === "string" ? { description: v.rec.description } : {}), metadata: isObj(v.rec.metadata) ? v.rec.metadata : {} } } : {}),
        ...(Number.isInteger(v.tries) && v.tries >= 0 ? { tries: v.tries } : {}),
        ...(typeof v.nextAt === "number" && Number.isFinite(v.nextAt) ? { nextAt: v.nextAt } : {}),
      };
    }
  }
  return s;
}

/** How a relay kept the retired session from acting on its copy (null = not settled yet, retried by a later detection). */
export const RELAY_SUPPRESSED = Object.freeze(["cancelled", "interrupted", "idle", "left"]);
export const RELAY_RETENTION_MS = 7 * 24 * 3600_000;
export const RELAY_MAX = 2000;

/** An entry that still owes work: the copy isn't at the live end yet, or the retired session isn't confirmed quiet. */
export const relayUnresolved = (r) => r.admitted !== true || r.suppressed == null;

/**
 * PURE. Drop relay entries older than 7 days — completed receipts AND unresolved work (a hard expiry: `onExpire(id, entry)` is
 * told about each unresolved one so it can be logged) — then evict the oldest COMPLETED receipts beyond the cap. Unresolved
 * entries are never evicted by the cap.
 * @returns {number} how many were removed
 */
export function pruneRelays(state, now, { maxAge = RELAY_RETENTION_MS, max = RELAY_MAX, onExpire } = {}) {
  let removed = 0;
  for (const [id, r] of Object.entries(state.relays)) {
    if (now - r.at > maxAge) {
      if (relayUnresolved(r)) onExpire?.(id, r);
      delete state.relays[id];
      removed++;
    }
  }
  const over = Object.keys(state.relays).length - max;
  if (over > 0) {
    const done = Object.keys(state.relays).filter((id) => !relayUnresolved(state.relays[id]));
    for (const id of done.sort((x, y) => state.relays[x].at - state.relays[y].at).slice(0, over)) {
      delete state.relays[id];
      removed++;
    }
  }
  return removed;
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
