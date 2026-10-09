// seatAssignment.mjs — which SEAT a conversation's requests use (multi-account
// spec §4 request path + §5.3 rules 1–2, phase 2).
//
//   resolve(provider, sessionID, parentSessionID)
//     → { seatId, live: true }                                   pass-through
//     → { seatId, live: false, provider, credentialFile, expiresAt? }   swap
//
// The `manta-accounts` opencode plugin (docs/opencode-plugins/manta-accounts.ts)
// calls this on every model request. It is the only consumer.
//
// NO CREDENTIAL EVER LEAVES THIS PROCESS. The answer names the seat's credential
// FILE (absolute path under ~/.manta-secrets/accounts/, 0600, same OS user) and
// the plugin reads the token from it itself. The box's HTTP surface is reachable
// from the internet through the gateway hostname and every paired device holds
// the bearer token, so a route that returned a token would let any of them pull
// Claude/Codex credentials remotely. `expiresAt` is not secret and is included.
//
// RULES IMPLEMENTED (phase 2)
//   1. A NEW conversation takes a seat: manual mode → the active seat; auto mode
//      → the least-loaded seat (ties to the active seat).
//   2. A conversation STAYS on its seat; its sub-agents use the same seat (they
//      share its cached prefix). Only a seat that no longer exists or can no
//      longer serve (signed out / no readable credentials) releases it …
//   3. (phase 4, spec §5.3 rules 3–4) AUTOMATIC mode only. A conversation MOVES when
//      its seat's load (`seatLoad`: the highest ACTIVE, FRESH window — 5h, weekly,
//      a model-scoped weekly in force) reaches 95, OR the seat is full/exhausted,
//      OR it can no longer serve (signed out / expired). ONE pure function,
//      `decideMove`, decides it:
//        • load 95–99: move only to a seat under 70 (same org first, then
//          least-loaded); if none is under 70, STAY until 100;
//        • exhausted / unusable: any seat with room (<100) — a seat under 70
//          still first, same org first;
//        • a seat left within 5 h is never a target for a load move, and for a
//          forced move only when nothing else has room;
//        • a move to ANOTHER org (a cache re-send) happens at most once per
//          conversation per 5 h (`crossOrgMovedAt`); a same-org move is free and
//          uncapped. A dead seat (unusable) is exempt from the cap: it cannot serve.
//      The 95/70 split + the 5 h no-move-back is the hysteresis: a conversation
//      that just left a seat at 91 cannot come back when that seat reads 60.
//      Every automatic move is recorded {movedFrom, movedAt, reason, trigger,
//      crossOrg} and announced (`onMoved`).
//   MANUAL MODE (phase 3): every conversation uses the active seat. The stored
//      assignment is still kept up to date (so `sessionAssignment` answers what
//      the NEXT request will use) and a switch is recorded as a move with reason
//      "manual" — but no `moved` event: the user did it on purpose.
//   NOT here (phase 4): the 90%/70% proactive thresholds, same-org preference,
//   the once-per-5h cross-org cap, move notices.
//
// A "conversation" is the ROOT session. opencode sends the sub-agent's
// `x-opencode-parent-session-id` one level only, so a deeper chain is followed
// through the child → root map recorded on the way in.
//
// STATE (~/.manta/seat-assignments.json, 0600, atomic) — sibling to accounts.json
// on purpose: the accounts store rewrites its whole file from memory, so a shared
// file would let either writer clobber the other. No credential is stored here,
// only session id → seat id.

import { readJsonSync, writeJsonAtomic, createMutex } from "./jsonStore.mjs";
import { statePath } from "../shared/paths.mjs";
import { leastLoadedSeat, isSeatExhausted, seatLoad, seatLoadWindow } from "../shared/seatChoice.mjs";
import { ACCOUNT_PROVIDERS, notePluginSeen } from "./accounts.mjs";

const DAY_MS = 24 * 60 * 60_000;
/** An assignment (or child link) nobody has touched for this long is dropped. */
export const ASSIGNMENT_TTL_MS = 30 * DAY_MS;
/** `lastUsedAt` is refreshed at most this often, so a busy conversation does not
 *  rewrite the file on every request. */
export const TOUCH_INTERVAL_MS = 60 * 60_000;
/** A conversation does not go back to a seat it left this recently (no flip-flop). */
export const MOVE_BACK_BLOCK_MS = 5 * 60 * 60_000;
/** A cross-org move (a full history re-send) happens at most once per conversation per this long. */
export const CROSS_ORG_CAP_MS = 5 * 60 * 60_000;
/** Spec §5.3 rule 3: a conversation moves when its seat reaches this load… */
export const MOVE_AT_PCT = 95;
/** …to a seat under this load (else it stays until its seat is full). */
export const MOVE_TARGET_BELOW_PCT = 70;
/** A seat a failed turn reported as limited is treated as full for this long,
 *  even when the usage reading (up to a poll interval old) still says otherwise. */
export const LIMITED_MARK_MS = 5 * 60_000;
const STORE_VERSION = 1;
const MAX_ID_LEN = 200;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export function emptyAssignments() {
  return { version: STORE_VERSION, providers: { claude: {}, codex: {} }, children: {} };
}

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LEN;

/** Defensive: whatever is on disk becomes a well-formed store (never throws). */
export function normalizeAssignments(raw) {
  const out = emptyAssignments();
  for (const provider of ACCOUNT_PROVIDERS) {
    const src = raw?.providers?.[provider];
    if (!src || typeof src !== "object") continue;
    for (const [conv, a] of Object.entries(src)) {
      if (!isId(conv) || !isId(a?.seatId)) continue;
      const assignedAt = Number.isFinite(a.assignedAt) ? a.assignedAt : 0;
      const kept = {
        seatId: a.seatId,
        assignedAt,
        lastUsedAt: Number.isFinite(a.lastUsedAt) ? a.lastUsedAt : assignedAt,
      };
      if (isId(a.movedFrom) && Number.isFinite(a.movedAt)) {
        kept.movedFrom = a.movedFrom;
        kept.movedAt = a.movedAt;
        kept.reason = typeof a.reason === "string" ? a.reason : "exhausted";
        const trig = a.trigger;
        if (trig && typeof trig.kind === "string" && Number.isFinite(trig.pct)) kept.trigger = { kind: trig.kind, pct: trig.pct };
        if (typeof a.crossOrg === "boolean") kept.crossOrg = a.crossOrg;
      }
      if (Number.isFinite(a.crossOrgMovedAt)) kept.crossOrgMovedAt = a.crossOrgMovedAt;
      if (a.left && typeof a.left === "object") {
        const left = {};
        for (const [seatId, at] of Object.entries(a.left)) if (isId(seatId) && Number.isFinite(at)) left[seatId] = at;
        if (Object.keys(left).length > 0) kept.left = left;
      }
      out.providers[provider][conv] = kept;
    }
  }
  for (const [child, c] of Object.entries(raw?.children ?? {})) {
    if (isId(child) && isId(c?.root)) out.children[child] = { root: c.root, at: Number.isFinite(c.at) ? c.at : 0 };
  }
  return out;
}

/**
 * The conversation (root session) a request belongs to, and the link to record.
 * `parentSessionID` wins (it is the sender's own statement); a known child maps
 * to its root; a parent that is itself a known child maps to ITS root.
 *
 * @param {{sessionID: string, parentSessionID?: string|null, children: Record<string,{root:string}>}} args
 * @returns {{root: string, link: {child: string, root: string}|null}}
 */
export function resolveRoot({ sessionID, parentSessionID = null, children }) {
  if (parentSessionID && parentSessionID !== sessionID) {
    const root = children[parentSessionID]?.root ?? parentSessionID;
    return { root, link: children[sessionID]?.root === root ? null : { child: sessionID, root } };
  }
  return { root: children[sessionID]?.root ?? sessionID, link: null };
}

/** Drop assignments and child links older than the TTL. Returns a new store, or
 *  the same object when nothing was old enough. */
export function pruneAssignments(store, nowMs, ttlMs = ASSIGNMENT_TTL_MS) {
  const cutoff = nowMs - ttlMs;
  let changed = false;
  const next = emptyAssignments();
  for (const provider of ACCOUNT_PROVIDERS) {
    for (const [conv, a] of Object.entries(store.providers[provider] ?? {})) {
      if (a.lastUsedAt >= cutoff) next.providers[provider][conv] = a;
      else changed = true;
    }
  }
  for (const [child, c] of Object.entries(store.children)) {
    if (c.at >= cutoff) next.children[child] = c;
    else changed = true;
  }
  return changed ? next : store;
}

/**
 * Pick a seat for a conversation that has none (rule 1). Seats that cannot
 * serve (`usable: false`) are never chosen.
 *
 *   manual → the active seat, falling back to the least-loaded usable seat only
 *            when the active one cannot serve (a request must not fail on it);
 *   auto   → the least-loaded usable seat, ties to the active seat. A seat with
 *            no usage reading ranks after every seat with one (seatChoice).
 *
 * @param {{mode: string, activeSeatId: string|null, seats: Array<{seatId:string, usable:boolean}>,
 *          seatSnapshots?: Array<{seatId?:string}>}} args
 * @returns {string|null}
 */
export function chooseSeat({ mode, activeSeatId, seats, seatSnapshots = [] }) {
  const usable = seats.filter((s) => s.usable);
  if (usable.length === 0) return null;
  if (mode === "manual" && usable.some((s) => s.seatId === activeSeatId)) return activeSeatId;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const candidates = usable.map((s) => bySeat.get(s.seatId) ?? { seatId: s.seatId });
  return leastLoadedSeat(candidates, { activeSeatId })?.seatId ?? usable[0].seatId;
}

/**
 * Has this seat hit its limit? The provider flagged it exhausted, or an ACTIVE,
 * FRESH window is at 100% (an inactive scoped window or a stale reading — the
 * window that just reset — does not count). No reading at all → not exhausted
 * (unknown is not full). Pure.
 * @param {object|null|undefined} snap  a seat snapshot
 */
export function isSeatFull(snap) {
  if (!snap) return false;
  if (isSeatExhausted(snap)) return true;
  const load = seatLoad(snap);
  return load !== null && load >= 100;
}

/** Which "org" a seat belongs to for the same-org preference: the account's orgId
 *  when it has one, else the account itself (an unidentified account is only ever
 *  "the same org" as its own seats). */
export function seatOrgKey(seat) {
  return seat?.orgId ? `org:${seat.orgId}` : `acct:${seat?.accountId ?? seat?.seatId}`;
}

/**
 * Spec §5.3 rules 3–4 as ONE pure decision: should this conversation leave its
 * seat, and for which one? `null` = stay.
 *
 * @param {object} args
 * @param {{seatId:string, left?:Record<string,number>, crossOrgMovedAt?:number}} args.existing  the stored assignment
 * @param {Array<{seatId:string, usable:boolean, accountId?:string, orgId?:string|null}>} args.seats
 * @param {Array<object>} [args.seatSnapshots]  per-seat usage readings
 * @param {number} args.nowMs
 * @param {string|null} [args.activeSeatId]  tie-break between equally loaded seats
 * @returns {null|{seatId:string, from:string, why:"load"|"exhausted"|"unusable",
 *                 trigger:{kind:string,pct:number}|null, crossOrg:boolean}}
 */
export function decideMove({ existing, seats, seatSnapshots = [], nowMs, activeSeatId = null }) {
  const cur = seats.find((s) => s.seatId === existing.seatId);
  if (!cur) return null;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const own = bySeat.get(cur.seatId);

  let why;
  let trigger;
  if (!cur.usable) {
    why = "unusable";
    trigger = null; // no window: the seat cannot serve at all
  } else if (isSeatFull(own)) {
    why = "exhausted";
    trigger = seatLoadWindow(own) ?? { kind: "exhausted", pct: 100 };
  } else {
    const load = seatLoad(own);
    if (load === null || load < MOVE_AT_PCT) return null;
    why = "load";
    trigger = seatLoadWindow(own);
  }
  const hard = why !== "load";
  const left = existing.left ?? {};
  const crossOrgCapped = why !== "unusable" && typeof existing.crossOrgMovedAt === "number" && nowMs - existing.crossOrgMovedAt < CROSS_ORG_CAP_MS;
  const curOrg = seatOrgKey(cur);

  const candidates = [];
  for (const s of seats) {
    if (!s.usable || s.seatId === cur.seatId) continue;
    const snap = bySeat.get(s.seatId) ?? { seatId: s.seatId };
    if (isSeatFull(snap)) continue;
    const same = seatOrgKey(s) === curOrg;
    if (!same && crossOrgCapped) continue;
    candidates.push({
      snap,
      same,
      load: seatLoad(snap),
      blocked: typeof left[s.seatId] === "number" && nowMs - left[s.seatId] < MOVE_BACK_BLOCK_MS,
    });
  }

  const pick = (pool) => {
    const roomy = (c) => c.load !== null && c.load < MOVE_TARGET_BELOW_PCT;
    const tiers = [
      pool.filter((c) => roomy(c) && c.same),
      pool.filter((c) => roomy(c) && !c.same),
      ...(hard ? [pool.filter((c) => c.same), pool.filter((c) => !c.same)] : []),
    ];
    for (const tier of tiers) {
      const best = leastLoadedSeat(tier.map((c) => c.snap), { activeSeatId });
      if (best) return pool.find((c) => c.snap === best);
    }
    return null;
  };

  // A recently-left seat is a last resort, and only when the conversation HAS to
  // move; a soft (95–99) move never goes back.
  let chosen = pick(candidates.filter((c) => !c.blocked));
  if (!chosen && hard) chosen = pick(candidates.filter((c) => c.blocked));
  let seatId = chosen ? chosen.snap.seatId : null;
  if (!seatId && why === "unusable") {
    // A dead seat must release its conversation even when every other seat is
    // full or capped: serving from a full seat beats failing on a dead one.
    const usable = seats.filter((s) => s.usable && s.seatId !== cur.seatId);
    seatId = chooseSeat({ mode: "auto", activeSeatId, seats: usable, seatSnapshots });
  }
  if (!seatId) return null;
  const target = seats.find((s) => s.seatId === seatId);
  return { seatId, from: cur.seatId, why, trigger, crossOrg: seatOrgKey(target) !== curOrg };
}

/**
 * Rules 1–3 for one request, with no I/O.
 * @returns {{seatId: string|null, reason: "kept"|"assigned"|"moved"|"none", from?: string,
 *            why?: "manual"|"load"|"exhausted"|"unusable", trigger?: {kind:string,pct:number}|null, crossOrg?: boolean}}
 */
export function decideSeat({ existing, mode, activeSeatId, seats, seatSnapshots, nowMs = 0 }) {
  if (mode === "manual") {
    // MANUAL MODE (spec §5.2): every conversation uses the active seat, whatever
    // its stored assignment says — picking a seat applies to ALL conversations
    // from their next request. A conversation that was on another (still
    // existing) seat is MOVED, recorded as a manual move; one whose seat is
    // gone is simply placed. The active seat falls back exactly as `chooseSeat`
    // does when it cannot serve, so a request never fails on it.
    const seatId = chooseSeat({ mode, activeSeatId, seats, seatSnapshots });
    if (!seatId) return { seatId: null, reason: "none" };
    if (!existing) return { seatId, reason: "assigned" };
    if (existing.seatId === seatId) return { seatId, reason: "kept" };
    if (seats.some((s) => s.seatId === existing.seatId)) {
      return { seatId, reason: "moved", from: existing.seatId, why: "manual" };
    }
    return { seatId, reason: "assigned" };
  }
  if (existing) {
    const seat = seats.find((s) => s.seatId === existing.seatId);
    if (seat) {
      if (mode === "auto") {
        const move = decideMove({ existing, seats, seatSnapshots, nowMs, activeSeatId });
        if (move) return { seatId: move.seatId, reason: "moved", from: move.from, why: move.why, trigger: move.trigger, crossOrg: move.crossOrg };
      }
      if (seat.usable) return { seatId: existing.seatId, reason: "kept" };
    }
  }
  const seatId = chooseSeat({ mode, activeSeatId, seats, seatSnapshots });
  return seatId ? { seatId, reason: "assigned" } : { seatId: null, reason: "none" };
}

/**
 * A short human line for an automatic move — the activity-log text and the basis
 * of the conversation notice: "Moved a conversation from Seat 1 (91% of 5h) to
 * Seat 2". Pure.
 * @param {{fromLabel?:string, toLabel?:string, from?:string, to?:string, reason?:string,
 *          trigger?:{kind:string,pct:number}|null, crossOrg?:boolean}} evt
 */
export function describeSeatMove(evt) {
  const from = evt.fromLabel || evt.from || "a seat";
  const to = evt.toLabel || evt.to || "another seat";
  let why = "";
  if (evt.reason === "unusable") why = " (signed out)";
  else if (evt.trigger) {
    const win = windowWord(evt.trigger.kind);
    const pct = Math.round(evt.trigger.pct);
    why = evt.reason === "exhausted" ? ` (${win} limit reached)` : ` (${pct}% of ${win})`;
  } else if (evt.reason === "exhausted") why = " (limit reached)";
  return `Moved a conversation from ${from}${why} to ${to}${evt.crossOrg ? " — another org, history re-sent" : ""}`;
}

function windowWord(kind) {
  if (kind === "session") return "5h";
  if (typeof kind === "string" && kind.startsWith("weekly_scoped")) return "weekly (model)";
  if (kind === "weekly") return "weekly";
  return typeof kind === "string" && kind ? kind : "usage";
}

/**
 * The optimizer activity-log entry for an automatic move (see
 * optimizer/activityLog.mjs): counts and short labels only — never a session id
 * or any conversation content.
 */
export function seatMoveActivityEntry(evt) {
  const evidence = { reason: String(evt.reason ?? "") };
  if (evt.trigger) {
    evidence.windowPct = Math.round(evt.trigger.pct);
    evidence.window = windowWord(evt.trigger.kind);
  }
  if (evt.crossOrg) evidence.crossOrg = "yes";
  return {
    kind: "seat-move",
    verdict: "applied",
    subject: describeSeatMove(evt),
    from: evt.fromLabel || evt.from,
    to: evt.toLabel || evt.to,
    evidence,
  };
}

/**
 * What the plugin receives for one seat: never a credential, only where it is.
 * A live seat (or one with nothing readable) is `live: true` — the request goes
 * through untouched.
 */
export function seatResult(provider, seat) {
  if (!seat || seat.live || !seat.file || !seat.credential) return { seatId: seat?.seatId ?? null, live: true };
  const out = { seatId: seat.seatId, live: false, provider, credentialFile: seat.file };
  if (typeof seat.credential.expiresAt === "number") out.expiresAt = seat.credential.expiresAt;
  return out;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{seatStates: Function}} deps.accounts  the accounts service
 * @param {() => Array<object>} [deps.listSeatSnapshots]  the usage poller's per-seat readings
 * @param {(provider: string, target: {seatId:string, dir:string|null, file:string|null}) => Promise<object>} deps.refreshSeatCredentials
 *        performs the real refresh for a NON-live seat (Claude CLI / Codex OAuth)
 */
export function createSeatAssigner({
  accounts,
  listSeatSnapshots = () => [],
  refreshSeatCredentials,
  load = () => readJsonSync(statePath("seat-assignments.json"), null),
  save = (data) => writeJsonAtomic(statePath("seat-assignments.json"), JSON.stringify(data), { mode: 0o600 }),
  now = () => Date.now(),
  notePluginSeen: markPluginSeen = notePluginSeen,
  // Phase 3 hooks (both optional): `onChange(provider)` after assignments of a
  // provider changed (a conversation placed / moved / forgotten); `onMoved(evt)`
  // when the resolver moved a conversation automatically (load / exhausted /
  // unusable — a manual switch is the user's own act and is not announced).
  onChange = null,
  onMoved = null,
  log = console,
} = {}) {
  /** @type {ReturnType<typeof emptyAssignments>|null} */
  let store = null;
  const mutex = createMutex();
  const refreshing = new Map();

  const ensure = () => (store ??= pruneAssignments(normalizeAssignments(load()), now()));

  // Seats a failed turn reported as limited: `${provider}:${seatId}` → expiry.
  const limitedUntil = new Map();

  /** The per-seat readings every decision uses: the poller's, with any seat
   *  currently marked limited forced to exhausted (a reading can lag the limit
   *  by a whole poll interval). A marked seat with no reading is synthesized. */
  function snapshotsFor(provider) {
    const t = now();
    const snaps = listSeatSnapshots().filter((x) => x?.provider === provider);
    const marked = [];
    for (const [key, until] of limitedUntil) {
      if (until <= t) {
        limitedUntil.delete(key);
        continue;
      }
      if (key.startsWith(`${provider}:`)) marked.push(key.slice(provider.length + 1));
    }
    if (marked.length === 0) return snaps;
    const out = snaps.map((x) => (marked.includes(x.seatId) ? { ...x, exhausted: true } : x));
    for (const seatId of marked) if (!out.some((x) => x.seatId === seatId)) out.push({ provider, seatId, exhausted: true });
    return out;
  }

  async function persist() {
    try {
      await save(store);
    } catch (e) {
      // Losing a write only means a conversation may be re-placed after a
      // restart; it must never fail a model request.
      log.warn?.("[accounts] saving seat assignments failed:", e?.message ?? e);
    }
  }

  function tell(fn) {
    try {
      fn();
    } catch (e) {
      log.warn?.("[accounts] seat-assignment listener failed:", e?.message ?? e);
    }
  }

  async function stateOf(provider) {
    const states = await accounts.seatStates(provider);
    if (!states || states.seats.length === 0) return null;
    return states;
  }

  /**
   * @returns {Promise<{seatId: string|null, live: boolean, provider?: string, credentialFile?: string, expiresAt?: number}>}
   */
  function resolve(provider, sessionID, parentSessionID = null) {
    // Seeing a call at all is what proves the plugin is in the request path.
    markPluginSeen(now());
    if (!ACCOUNT_PROVIDERS.includes(provider)) return Promise.reject(new Error("unknown provider"));
    if (!isId(sessionID)) return Promise.reject(new Error("invalid sessionID"));
    if (parentSessionID != null && !isId(parentSessionID)) return Promise.reject(new Error("invalid parentSessionID"));

    // Serialized: two concurrent first requests of one conversation (a parent
    // and its sub-agent) must land on the SAME seat, not race to two.
    return mutex.runExclusive(async () => {
      const states = await stateOf(provider);
      // No seats → today's single-credential behaviour. ONE seat → nothing to
      // choose between, and whatever login is live keeps serving.
      if (!states) return { seatId: null, live: true };
      if (states.seats.length === 1) return { seatId: states.seats[0].seatId, live: true };
      return (await place(provider, states, sessionID, parentSessionID)).result;
    });
  }

  /**
   * The placement core shared by `resolve` (a request) and `reconsider` (a limit
   * signal). Runs inside the mutex, with `states` of a multi-seat provider. With
   * `onlyMove`, a conversation that is not assigned, or whose decision is
   * anything but an automatic move, is left completely untouched.
   * @returns {Promise<{result: object, decision: object|null}>}
   */
  async function place(provider, states, sessionID, parentSessionID, { onlyMove = false } = {}) {
    const s = ensure();
    const t = now();
    const { root, link } = resolveRoot({ sessionID, parentSessionID, children: s.children });
    const existing = s.providers[provider][root] ?? null;
    const untouched = { result: { seatId: null, live: true }, decision: null };
    if (onlyMove && (!existing || states.mode !== "auto")) return untouched;
    const decision = decideSeat({
      existing,
      mode: states.mode,
      activeSeatId: states.activeSeatId,
      seats: states.seats,
      seatSnapshots: snapshotsFor(provider),
      nowMs: t,
    });
    if (onlyMove && decision.reason !== "moved") return untouched;
    let dirty = false;
    if (link) {
      s.children[link.child] = { root: link.root, at: t };
      dirty = true;
    }
    if (!decision.seatId) return { result: { seatId: null, live: true }, decision };

    let assignmentsChanged = false;
    let movedEvent = null;
    if (decision.reason === "assigned") {
      s.providers[provider][root] = { seatId: decision.seatId, assignedAt: t, lastUsedAt: t };
      dirty = true;
      assignmentsChanged = true;
    } else if (decision.reason === "moved") {
      // Remember where it came from (the move notice shows it) and every seat it
      // left in the last 5 h (so it cannot bounce back).
      const left = {};
      for (const [seatId, at] of Object.entries(existing.left ?? {})) if (t - at < MOVE_BACK_BLOCK_MS) left[seatId] = at;
      left[decision.from] = t;
      const why = decision.why ?? "exhausted";
      const rec = {
        seatId: decision.seatId,
        assignedAt: t,
        lastUsedAt: t,
        movedFrom: decision.from,
        movedAt: t,
        reason: why,
        left,
      };
      if (why !== "manual") {
        if (decision.trigger) rec.trigger = decision.trigger;
        rec.crossOrg = decision.crossOrg === true;
      }
      // The once-per-5h cross-org cap: stamped on a cross-org move, carried
      // forward (while it still matters) through any other move.
      if (why !== "manual" && decision.crossOrg) rec.crossOrgMovedAt = t;
      else if (typeof existing.crossOrgMovedAt === "number" && t - existing.crossOrgMovedAt < CROSS_ORG_CAP_MS) rec.crossOrgMovedAt = existing.crossOrgMovedAt;
      s.providers[provider][root] = rec;
      dirty = true;
      assignmentsChanged = true;
      if (why !== "manual") {
        const label = (id) => states.seats.find((x) => x.seatId === id)?.label ?? id;
        movedEvent = {
          sessionId: root,
          provider,
          from: decision.from,
          to: decision.seatId,
          fromLabel: label(decision.from),
          toLabel: label(decision.seatId),
          reason: why,
          trigger: decision.trigger ?? null,
          crossOrg: decision.crossOrg === true,
        };
      }
    } else if (existing && t - existing.lastUsedAt >= TOUCH_INTERVAL_MS) {
      existing.lastUsedAt = t;
      dirty = true;
    }
    if (dirty) {
      store = pruneAssignments(s, t);
      await persist();
    }
    // After the write, and never allowed to fail the request.
    if (assignmentsChanged) tell(() => onChange?.(provider));
    if (movedEvent) tell(() => onMoved?.(movedEvent));
    return { result: seatResult(provider, states.seats.find((x) => x.seatId === decision.seatId)), decision };
  }

  /**
   * Refresh one seat's credentials and return its resolve-shaped state.
   * Single-flight per seat. A live seat is never refreshed here (opencode / the
   * CLI own it) — it is simply reported live. `null` = no such seat.
   */
  async function refreshSeat(provider, seatId) {
    const key = `${provider}:${seatId}`;
    let run = refreshing.get(key);
    if (!run) {
      run = (async () => {
        const states = await accounts.seatStates(provider);
        const seat = states?.seats.find((x) => x.seatId === seatId);
        if (!seat) return null;
        if (!seat.live && (seat.dir || seat.file)) {
          try {
            await refreshSeatCredentials(provider, { seatId, dir: seat.dir, file: seat.file });
          } catch (e) {
            log.warn?.(`[accounts] refresh of ${provider} ${seatId} failed:`, e?.message ?? e);
          }
        }
        // Re-read: the refresh rewrote the file.
        const after = await accounts.seatStates(provider);
        return seatResult(provider, after?.seats.find((x) => x.seatId === seatId));
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, run);
    }
    return run;
  }

  /** A copy of one provider's assignments: `{[conversation]: assignment}`. */
  function assignments(provider) {
    return structuredClone(ensure().providers[provider] ?? {});
  }

  /**
   * The assignment a conversation (or one of its sub-agents) has, across
   * providers — the most recently used one when it has several. `null` when it
   * has none.
   * @returns {{provider: string, conversation: string, assignment: object}|null}
   */
  function sessionAssignment(sessionId) {
    const s = ensure();
    const conversation = s.children[sessionId]?.root ?? sessionId;
    let best = null;
    for (const provider of ACCOUNT_PROVIDERS) {
      const a = s.providers[provider]?.[conversation];
      if (a && (!best || a.lastUsedAt > best.assignment.lastUsedAt)) best = { provider, conversation, assignment: structuredClone(a) };
    }
    return best;
  }

  /** A seat was removed: its conversations lose the assignment (the next request
   *  places them again, rule 1). Serialized with `resolve`. */
  function forgetSeat(provider, seatId) {
    return mutex.runExclusive(async () => {
      const s = ensure();
      let changed = false;
      for (const [conv, a] of Object.entries(s.providers[provider] ?? {})) {
        if (a.seatId === seatId) {
          delete s.providers[provider][conv];
          changed = true;
        }
      }
      if (changed) {
        await persist();
        tell(() => onChange?.(provider));
      }
      return changed;
    });
  }

  /**
   * A turn of this conversation failed with a limit-type error: treat the seat it
   * is on as full for LIMITED_MARK_MS, whatever the (possibly lagging) usage
   * reading says. Synchronous; the next decision for ANY conversation sees it.
   * @returns {string|null} the seat marked, or null (no assignment)
   */
  function markLimited(provider, sessionId) {
    if (!ACCOUNT_PROVIDERS.includes(provider) || !isId(sessionId)) return null;
    const s = ensure();
    const root = s.children[sessionId]?.root ?? sessionId;
    const seatId = s.providers[provider]?.[root]?.seatId;
    if (!seatId) return null;
    limitedUntil.set(`${provider}:${seatId}`, now() + LIMITED_MARK_MS);
    return seatId;
  }

  /**
   * Re-decide one conversation NOW (after a limit signal and a fresh usage
   * poll), through the same decision + recording + announcing path as a request.
   * Only an automatic move changes anything: manual mode, an unassigned
   * conversation, a single-seat provider, or no seat with room all leave it be.
   * @returns {Promise<{moved: boolean, from?: string, to?: string, reason?: string}>}
   */
  function reconsider(provider, sessionId) {
    if (!ACCOUNT_PROVIDERS.includes(provider) || !isId(sessionId)) return Promise.resolve({ moved: false });
    return mutex.runExclusive(async () => {
      const states = await stateOf(provider);
      if (!states || states.seats.length < 2) return { moved: false };
      const { decision } = await place(provider, states, sessionId, null, { onlyMove: true });
      return decision ? { moved: true, from: decision.from, to: decision.seatId, reason: decision.why } : { moved: false };
    });
  }

  return { resolve, refreshSeat, markLimited, reconsider, assignments, sessionAssignment, forgetSeat, _store: () => ensure() };
}
