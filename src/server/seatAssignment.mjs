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
//      → the least-loaded seat under 70 whose org has ANOTHER seat under 70 (a
//      free same-org escape route for its later move), else the least-loaded seat
//      under 70, else the least-loaded seat (ties to the active seat).
//   2. A conversation STAYS on its seat; its sub-agents use the same seat (they
//      share its cached prefix). Only a seat that no longer exists or can no
//      longer serve (signed out / no readable credentials) releases it …
//   3. (phase 4, spec §5.3 rules 3–4) AUTOMATIC mode only. A conversation MOVES when
//      its seat's load (`seatLoad`: the highest ACTIVE, FRESH window — 5h, weekly,
//      a model-scoped weekly in force) reaches 95, OR the seat is full/exhausted,
//      OR it can no longer serve (signed out / expired). ONE pure function,
//      `decideMove`, decides it. A same-org move is free (shared prompt cache), so
//      every same-org seat with room is tried before ANY other-org seat:
//        • load 95–99: a same-org seat under 95, else an other-org seat under 70,
//          else STAY until 100;
//        • exhausted / unusable: a same-org seat with room (<100), else an other-org
//          seat under 70, else any other-org seat with room;
//        • a seat left within 5 h is never a target for a load move, and for a
//          forced move only when nothing else has room;
//        • an OPTIONAL (load 95–99) move to ANOTHER org (a cache re-send) happens
//          at most once per conversation per 5 h (`crossOrgMovedAt`); a same-org
//          move is free and uncapped. A full or dead seat is exempt from the cap:
//          it cannot serve, and stalling until its reset is worse than a re-send.
//      The 95/70 split + the 5 h no-move-back is the hysteresis: a conversation
//      that just left a seat at 91 cannot come back when that seat reads 60.
//   4. USE IT OR LOSE IT (auto mode). What a seat has left when its window resets
//      is lost; a seat that has just reset keeps its quota for later. So:
//        • among the seats a placement or a move may pick, one whose quota resets
//          within RESET_SOON_MS (and is under 95) goes first — soonest first,
//          then least-loaded — before plain least-loaded;
//        • a conversation whose seat is NOT under pressure (below 95) and does
//          not itself reset within RESET_SOON_MS moves to a SAME-ORG seat (free:
//          shared cache) that does and is under 70 — reason "reset-soon". Never
//          to another org, never back to a seat left within 5 h; once on a seat
//          that resets soon it stays (its own reset is soon too).
//        • a reset-soon move does NOT block the seat it left (the 5 h block is for
//          pressure moves): an optional move must not shrink a later forced move's
//          escape options. It cannot ping-pong — it only goes toward a seat that
//          resets within the hour, and such a seat never reset-soon-moves away.
//      Every automatic move is recorded {movedFrom, movedAt, reason, trigger,
//      crossOrg} and passed to `onMoved` (index.mjs announces it in the chat —
//      except a reset-soon move, a routine optimisation that stays silent there).
//   MANUAL MODE (phase 3): every conversation uses the active seat. The stored
//      assignment is still kept up to date (so `sessionAssignment` answers what
//      the NEXT request will use) and a switch is recorded as a move with reason
//      "manual" — but no `moved` event: the user did it on purpose.
//   WEEKLY DEADLINE (seat-placement-weekly-deadline spec §3). When some seat has a
//      fresh weekly window with a known reset, `placementFor` / `moveFor` run the
//      deadline rules R1–R6 (`chooseSeatByDeadline` / `decideMoveByDeadline`): the
//      seat whose weekly resets first is served first, packing the 5h where that
//      costs nothing. Otherwise (a 5h-only provider, or no weekly reading) the
//      legacy rules above run byte-for-byte. Those two dispatchers are the ONLY
//      entry points; `chooseSeat` / `decideMove` / `resetSoonMove` stay for the
//      legacy path and their tests.
//
// MODEL-SCOPED LIMITS. A usage window scoped to one model ("7d · Fable") limits only
//   requests for that model (seatChoice `windowAppliesToModel`). Every load / full /
//   least-loaded decision therefore takes the conversation's MODEL: the request's
//   own on `resolve`, the stored one (`assignment.model`, the model of its most
//   recent request) for a server-side re-decision (`reconsider`,
//   `conversationSeatFull`). Model unknown → scoped windows are ignored, so a seat
//   whose Fable cap is full is still a target for an Opus conversation; the
//   reactive path (429 → `markLimited` → seat full → move) covers a conversation
//   that does land on a capped model.
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
import {
  leastLoadedSeat,
  isSeatExhausted,
  seatLoad,
  seatLoadWindow,
  nextResetAt,
  soonestResettingSeat,
  bestSeatByRank,
  legacyMode,
  seatDeadlineAt,
  seatSlackPts,
  shortWindowState,
} from "../shared/seatChoice.mjs";
import { ACCOUNT_PROVIDERS, notePluginSeen } from "./accounts.mjs";
import { createSeatAttribution } from "./seatAttribution.mjs";

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
/** Rule 4: a seat whose quota resets within this long is used first. */
export const RESET_SOON_MS = 60 * 60_000;
/** A seat a failed turn reported as limited is treated as full for this long,
 *  even when the usage reading (up to a poll interval old) still says otherwise. */
export const LIMITED_MARK_MS = 5 * 60_000;
/** Weekly-deadline placement: a same-org rebalance needs a target whose weekly resets this much earlier. */
export const SAME_ORG_REBALANCE_MS = 6 * 60 * 60_000;
/** …and at most one such optional move per conversation per this long. */
export const MIN_DWELL_MS = 60 * 60_000;
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
      if (isId(a.model)) kept.model = a.model;
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
 *   auto   → the least-loaded seat of the first non-empty tier (ties to the
 *            active seat):
 *              1. known load under 70 AND a same-org escape route — another usable
 *                 seat of the same org (`seatOrgKey`) that is not full and also
 *                 under 70, so this conversation's later move can stay free;
 *              2. known load under 70;
 *              3. every usable seat. A seat with no usage reading ranks after
 *                 every seat with one, a full seat last (seatChoice).
 *            A seat with no org info is its own org, so it never has a route.
 *
 * `model` (the conversation's model id, null = unknown) decides which model-scoped
 * windows count (see the header). In auto mode, within a tier, a seat whose quota
 * resets within RESET_SOON_MS goes first (rule 4); that needs `nowMs`.
 *
 * @param {{mode: string, activeSeatId: string|null,
 *          seats: Array<{seatId:string, usable:boolean, accountId?:string, orgId?:string|null}>,
 *          seatSnapshots?: Array<{seatId?:string}>, model?: string|null, nowMs?: number|null}} args
 * @returns {string|null}
 */
export function chooseSeat({ mode, activeSeatId, seats, seatSnapshots = [], model = null, nowMs = null }) {
  const usable = seats.filter((s) => s.usable);
  if (usable.length === 0) return null;
  if (mode === "manual" && usable.some((s) => s.seatId === activeSeatId)) return activeSeatId;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const entries = usable.map((s) => ({ snap: bySeat.get(s.seatId) ?? { seatId: s.seatId }, org: seatOrgKey(s) }));
  const roomy = (e) => {
    if (isSeatFull(e.snap, { model })) return false;
    const load = seatLoad(e.snap, { model });
    return load !== null && load < MOVE_TARGET_BELOW_PCT;
  };
  const hasEscapeRoute = (e) => entries.some((o) => o !== e && o.org === e.org && roomy(o));
  const tiers = mode === "manual" ? [entries] : [entries.filter((e) => roomy(e) && hasEscapeRoute(e)), entries.filter(roomy), entries];
  for (const tier of tiers) {
    const snaps = tier.map((e) => e.snap);
    const best = (mode === "auto" ? resetSoonFirst(snaps, { nowMs, activeSeatId, model }) : null) ?? leastLoadedSeat(snaps, { activeSeatId, model });
    if (best) return best.seatId;
  }
  return usable[0].seatId;
}

/**
 * Rule 4 inside one tier of candidates: the seat with room (not full, known load
 * under 95) whose quota resets soonest within RESET_SOON_MS, else `null` (the
 * caller falls back to least-loaded). No clock (`nowMs` null) → `null`. Pure.
 */
function resetSoonFirst(snaps, { nowMs, activeSeatId = null, model = null }) {
  if (typeof nowMs !== "number") return null;
  const withRoom = snaps.filter((snap) => {
    const load = seatLoad(snap, { model });
    return !isSeatFull(snap, { model }) && load !== null && load < MOVE_AT_PCT;
  });
  return soonestResettingSeat(withRoom, { nowMs, withinMs: RESET_SOON_MS, activeSeatId, model });
}

/**
 * Has this seat hit its limit? The provider flagged it exhausted, or an ACTIVE,
 * FRESH window that applies to `model` is at 100% (an inactive window, a stale
 * reading — the window that just reset — or a model-scoped window for another
 * model does not count). No reading at all → not exhausted (unknown is not full).
 * Pure.
 * @param {object|null|undefined} snap  a seat snapshot
 * @param {{model?: string|null}} [opts]  the conversation's model id (null = unknown)
 */
export function isSeatFull(snap, { model = null } = {}) {
  if (!snap) return false;
  if (isSeatExhausted(snap)) return true;
  const load = seatLoad(snap, { model });
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
 * @param {string|null} [args.model]  the conversation's model id (null = unknown): which scoped windows count
 * @returns {null|{seatId:string, from:string, why:"load"|"exhausted"|"unusable"|"reset-soon",
 *                 trigger:{kind:string,pct:number}|null, crossOrg:boolean}}
 */
export function decideMove({ existing, seats, seatSnapshots = [], nowMs, activeSeatId = null, model = null }) {
  const cur = seats.find((s) => s.seatId === existing.seatId);
  if (!cur) return null;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const own = bySeat.get(cur.seatId);

  let why;
  let trigger;
  if (!cur.usable) {
    why = "unusable";
    trigger = null; // no window: the seat cannot serve at all
  } else if (isSeatFull(own, { model })) {
    why = "exhausted";
    trigger = seatLoadWindow(own, { model }) ?? { kind: "exhausted", pct: 100 };
  } else {
    const load = seatLoad(own, { model });
    if (load === null || load < MOVE_AT_PCT) return resetSoonMove({ existing, cur, own, seats, bySeat, nowMs, activeSeatId, model });
    why = "load";
    trigger = seatLoadWindow(own, { model });
  }
  const hard = why !== "load";
  const left = existing.left ?? {};
  // The cross-org cap only holds back an OPTIONAL (soft, 95–99%) move. A full or
  // dead seat cannot serve the next turn, so staying means the conversation
  // stalls until a reset hours away; a history re-send beats that. Hard moves
  // already try every same-org seat first, so lifting the cap here only ever
  // crosses orgs when the conversation's own org has nothing left.
  const crossOrgCapped = !hard && typeof existing.crossOrgMovedAt === "number" && nowMs - existing.crossOrgMovedAt < CROSS_ORG_CAP_MS;
  const curOrg = seatOrgKey(cur);

  const candidates = [];
  for (const s of seats) {
    if (!s.usable || s.seatId === cur.seatId) continue;
    const snap = bySeat.get(s.seatId) ?? { seatId: s.seatId };
    if (isSeatFull(snap, { model })) continue;
    const same = seatOrgKey(s) === curOrg;
    if (!same && crossOrgCapped) continue;
    candidates.push({
      snap,
      same,
      load: seatLoad(snap, { model }),
      blocked: typeof left[s.seatId] === "number" && nowMs - left[s.seatId] < MOVE_BACK_BLOCK_MS,
    });
  }

  // Tiers, first non-empty wins (least-loaded within). A same-org move is free, so
  // EVERY same-org seat with room is tried before any other-org one:
  //   soft (load 95–99): same org under 95 (a target that would itself trigger a
  //                      move is pointless) → other org under 70;
  //   hard (full / dead): same org with room → other org under 70 → other org with room.
  // A seat with no reading is never a soft target; it can still take a hard move.
  const pick = (pool) => {
    const known = (c, below) => c.load !== null && c.load < below;
    const tiers = hard
      ? [pool.filter((c) => c.same), pool.filter((c) => !c.same && known(c, MOVE_TARGET_BELOW_PCT)), pool.filter((c) => !c.same)]
      : [pool.filter((c) => c.same && known(c, MOVE_AT_PCT)), pool.filter((c) => !c.same && known(c, MOVE_TARGET_BELOW_PCT))];
    for (const tier of tiers) {
      const snaps = tier.map((c) => c.snap);
      const best = resetSoonFirst(snaps, { nowMs, activeSeatId, model }) ?? leastLoadedSeat(snaps, { activeSeatId, model });
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
    // full or capped: serving from a full seat beats failing on a dead one. Plain
    // least-loaded over what can serve — NOT chooseSeat's escape-route placement,
    // which is a rule for NEW conversations.
    const rest = seats.filter((s) => s.usable && s.seatId !== cur.seatId);
    seatId = leastLoadedSeat(rest.map((s) => bySeat.get(s.seatId) ?? { seatId: s.seatId }), { activeSeatId, model })?.seatId ?? null;
  }
  if (!seatId) return null;
  const target = seats.find((s) => s.seatId === seatId);
  return { seatId, from: cur.seatId, why, trigger, crossOrg: seatOrgKey(target) !== curOrg };
}

/**
 * Rule 4, the move half: a conversation whose seat is not under pressure moves to
 * a same-org seat whose quota resets within RESET_SOON_MS (under 70, not left
 * within 5 h), unless its own seat resets that soon too. `null` = stay. Pure.
 */
function resetSoonMove({ existing, cur, own, seats, bySeat, nowMs, activeSeatId = null, model = null }) {
  if (!cur.usable || typeof nowMs !== "number") return null;
  if (nextResetAt(own, { nowMs, model }) <= nowMs + RESET_SOON_MS) return null;
  const left = existing.left ?? {};
  const curOrg = seatOrgKey(cur);
  const pool = [];
  for (const s of seats) {
    if (!s.usable || s.seatId === cur.seatId || seatOrgKey(s) !== curOrg) continue;
    if (typeof left[s.seatId] === "number" && nowMs - left[s.seatId] < MOVE_BACK_BLOCK_MS) continue;
    const snap = bySeat.get(s.seatId);
    const load = seatLoad(snap, { model });
    if (!snap || isSeatFull(snap, { model }) || load === null || load >= MOVE_TARGET_BELOW_PCT) continue;
    pool.push(snap);
  }
  const best = soonestResettingSeat(pool, { nowMs, withinMs: RESET_SOON_MS, activeSeatId, model });
  return best ? { seatId: best.seatId, from: cur.seatId, why: "reset-soon", trigger: null, crossOrg: false } : null;
}

// ---------------------------------------------------------------------------
// Weekly-deadline rules (spec §3). Pure. `kFor(kind) → number|null` is the
// provider-bound short-windows-per-long-window reader (null = slack unknown).
// ---------------------------------------------------------------------------

const noK = () => null;
const isBlocked = (left, seatId, nowMs) => typeof left?.[seatId] === "number" && nowMs - left[seatId] < MOVE_BACK_BLOCK_MS;

/** The short (5h) window's pct when its reading is known and fresh, else `null`. */
function shortPct(snap, nowMs) {
  if (shortWindowState(snap, { nowMs }).state === "unknown") return null;
  const w = (snap?.windows ?? []).find((x) => x && x.kind === "session");
  return Number.isFinite(w?.pct) ? w.pct : null;
}

/** `eligible ∧ short window known ∧ pct(short) < 95` (the soft-target predicate). */
function isSoftTarget(snap, { nowMs, model }) {
  if (isSeatFull(snap, { model })) return false;
  const p = shortPct(snap, nowMs);
  return p !== null && p < MOVE_AT_PCT;
}

/**
 * Rule R1 — a conversation with no seat (or whose seat is gone) takes the seat
 * whose weekly resets first: `best(softTarget ∧ ¬blocked)` → `best(softTarget)` →
 * `best(hardTarget)` → the least-loaded usable seat. Manual mode never gets here
 * (`placementFor` sends it to `chooseSeat`). `left` is the seats the conversation
 * recently left (empty for a new one).
 *
 * @param {{activeSeatId: string|null, seats: Array<object>, seatSnapshots?: Array<object>, model?: string|null,
 *          nowMs: number, kFor?: ((kind: string) => number|null)|null, left?: Record<string, number>}} args
 * @returns {string|null}
 */
export function chooseSeatByDeadline({ activeSeatId, seats, seatSnapshots = [], model = null, nowMs, kFor = null, left = {} }) {
  const usable = seats.filter((s) => s.usable);
  if (usable.length === 0) return null;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const snaps = usable.map((s) => bySeat.get(s.seatId) ?? { seatId: s.seatId });
  const best = (pool) => bestSeatByRank(pool, { nowMs, model, kFor: kFor ?? noK, activeSeatId });
  const soft = snaps.filter((x) => isSoftTarget(x, { nowMs, model }));
  const tiers = [soft.filter((x) => !isBlocked(left, x.seatId, nowMs)), soft, snaps.filter((x) => !isSeatFull(x, { model }))];
  for (const tier of tiers) {
    const pick = best(tier);
    if (pick) return pick.seatId;
  }
  return leastLoadedSeat(snaps, { activeSeatId, model })?.seatId ?? null;
}

/**
 * Seat placement entry point: the legacy `chooseSeat` in manual mode, without a
 * clock, or in legacy mode (no seat has a fresh weekly with a known reset for
 * `model`); `chooseSeatByDeadline` otherwise. Same arguments as `chooseSeat`,
 * plus `kFor` and `left`.
 */
export function placementFor(args) {
  const { mode, seatSnapshots = [], model = null, nowMs = null } = args;
  if (mode === "manual" || typeof nowMs !== "number" || legacyMode(seatSnapshots, { nowMs, model })) return chooseSeat(args);
  return chooseSeatByDeadline(args);
}

/** When this conversation was last placed or moved (`place()` stamps `assignedAt` on every one, a manual switch included). */
function lastPlacedAt(existing) {
  return Number.isFinite(existing?.assignedAt) ? existing.assignedAt : -Infinity;
}

/**
 * Rules R2–R6 as one pure decision, same result shape as `decideMove` (`null` =
 * stay): dead seat (R2), full/limited seat (R3), the short window at 95+ (R4), a
 * same-org seat whose weekly resets 6h+ earlier (R5), else stay (R6). Within a
 * tier the choice is the seat-rank order (earliest weekly reset first), not
 * least-loaded. A rebalance carries `rebalance: {deadlineFrom, deadlineTo,
 * slackFrom, slackTo}` for the activity log.
 *
 * @returns {null|{seatId:string, from:string, why:"load"|"exhausted"|"unusable"|"rebalance",
 *                 trigger:{kind:string,pct:number}|null, crossOrg:boolean, rebalance?: object}}
 */
export function decideMoveByDeadline({ existing, seats, seatSnapshots = [], nowMs, activeSeatId = null, model = null, kFor = null }) {
  const cur = seats.find((s) => s.seatId === existing.seatId);
  if (!cur) return null;
  const kForKind = kFor ?? noK;
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const own = bySeat.get(cur.seatId);
  const left = existing.left ?? {};
  const curOrg = seatOrgKey(cur);

  const candidates = [];
  for (const s of seats) {
    if (!s.usable || s.seatId === cur.seatId) continue;
    const snap = bySeat.get(s.seatId) ?? { seatId: s.seatId };
    candidates.push({
      seat: s,
      snap,
      same: seatOrgKey(s) === curOrg,
      load: seatLoad(snap, { model }),
      blocked: isBlocked(left, s.seatId, nowMs),
      hard: !isSeatFull(snap, { model }),
      soft: isSoftTarget(snap, { nowMs, model }),
    });
  }
  const rankOpts = { nowMs, model, kFor: kForKind, activeSeatId };
  const best = (pool) => {
    const pick = bestSeatByRank(pool.map((c) => c.snap), rankOpts);
    return pick ? pool.find((c) => c.snap === pick) : null;
  };
  const result = (c, why, trigger, extra = {}) => ({ seatId: c.seat.seatId, from: cur.seatId, why, trigger, crossOrg: seatOrgKey(c.seat) !== curOrg, ...extra });

  // R2 / R3 — the seat cannot serve: same org, then other org under 70, then any
  // other org, each tier over the seats not left within 5h, then the whole ladder
  // again over the blocked ones. A forced move is exempt from the cross-org cap.
  const forced = (why, trigger) => {
    const ladder = (pool) => {
      const hard = pool.filter((c) => c.hard);
      const tiers = [hard.filter((c) => c.same), hard.filter((c) => !c.same && c.load !== null && c.load < MOVE_TARGET_BELOW_PCT), hard.filter((c) => !c.same)];
      for (const tier of tiers) {
        const pick = best(tier);
        if (pick) return pick;
      }
      return null;
    };
    const chosen = ladder(candidates.filter((c) => !c.blocked)) ?? ladder(candidates.filter((c) => c.blocked));
    if (chosen) return result(chosen, why, trigger);
    if (why !== "unusable") return null;
    // A dead seat must release its conversation even when every other seat is full.
    const rest = seats.filter((s) => s.usable && s.seatId !== cur.seatId);
    const fallback = leastLoadedSeat(rest.map((s) => bySeat.get(s.seatId) ?? { seatId: s.seatId }), { activeSeatId, model });
    const target = fallback ? seats.find((s) => s.seatId === fallback.seatId) : null;
    return target ? result({ seat: target }, why, trigger) : null;
  };

  if (!cur.usable) return forced("unusable", null);
  if (isSeatFull(own, { model })) return forced("exhausted", seatLoadWindow(own, { model }) ?? { kind: "exhausted", pct: 100 });

  // R4 — the 5h window is at 95+: finish it where it is unless a seat with room exists.
  const pressure = shortPct(own, nowMs);
  if (pressure !== null && pressure >= MOVE_AT_PCT) {
    const crossOK = !(typeof existing.crossOrgMovedAt === "number" && nowMs - existing.crossOrgMovedAt < CROSS_ORG_CAP_MS);
    const trigger = { kind: "session", pct: pressure };
    const same = best(candidates.filter((c) => c.same && c.soft && !c.blocked));
    if (same) return result(same, "load", trigger);
    if (crossOK) {
      const other = best(candidates.filter((c) => !c.same && c.soft && !c.blocked && c.load !== null && c.load < MOVE_TARGET_BELOW_PCT));
      if (other) return result(other, "load", trigger);
    }
    return null;
  }

  // R5 — optional, same org only: a seat whose weekly resets 6h+ earlier, at most once per MIN_DWELL_MS.
  if (nowMs - lastPlacedAt(existing) < MIN_DWELL_MS) return null;
  const ownDeadline = seatDeadlineAt(own, { nowMs, model });
  const better = (c) => {
    const d = seatDeadlineAt(c.snap, { nowMs, model });
    return d !== null && (ownDeadline === null || d <= ownDeadline - SAME_ORG_REBALANCE_MS);
  };
  const target = best(candidates.filter((c) => c.same && c.soft && !c.blocked && better(c)));
  if (!target) return null;
  const rebalance = {};
  const put = (k, v) => {
    if (typeof v === "number" && Number.isFinite(v)) rebalance[k] = v;
  };
  put("deadlineFrom", ownDeadline);
  put("deadlineTo", seatDeadlineAt(target.snap, { nowMs, model }));
  const slack = (snap) => seatSlackPts(snap, { nowMs, model, kFor: kForKind });
  put("slackFrom", slack(own));
  put("slackTo", slack(target.snap));
  return result(target, "rebalance", null, { rebalance });
}

/**
 * Seat move entry point: the legacy `decideMove` (which includes `resetSoonMove`)
 * without a clock or in legacy mode, `decideMoveByDeadline` otherwise.
 */
export function moveFor(args) {
  const { seatSnapshots = [], model = null, nowMs } = args;
  if (typeof nowMs !== "number" || legacyMode(seatSnapshots, { nowMs, model })) return decideMove(args);
  return decideMoveByDeadline(args);
}

/**
 * Rules 1–4 for one request, with no I/O (R0–R6 when some seat has a weekly deadline).
 * @returns {{seatId: string|null, reason: "kept"|"assigned"|"moved"|"none", from?: string,
 *            why?: "manual"|"load"|"exhausted"|"unusable"|"reset-soon"|"rebalance", trigger?: {kind:string,pct:number}|null, crossOrg?: boolean,
 *            rebalance?: object}}
 */
export function decideSeat({ existing, mode, activeSeatId, seats, seatSnapshots, nowMs = 0, model = null, kFor = null }) {
  if (mode === "manual") {
    // MANUAL MODE (spec §5.2): every conversation uses the active seat, whatever
    // its stored assignment says — picking a seat applies to ALL conversations
    // from their next request. A conversation that was on another (still
    // existing) seat is MOVED, recorded as a manual move; one whose seat is
    // gone is simply placed. The active seat falls back exactly as `chooseSeat`
    // does when it cannot serve, so a request never fails on it.
    const seatId = placementFor({ mode, activeSeatId, seats, seatSnapshots, model, nowMs, kFor });
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
        const move = moveFor({ existing, seats, seatSnapshots, nowMs, activeSeatId, model, kFor });
        if (move) {
          return { seatId: move.seatId, reason: "moved", from: move.from, why: move.why, trigger: move.trigger, crossOrg: move.crossOrg, ...(move.rebalance ? { rebalance: move.rebalance } : {}) };
        }
      }
      if (seat.usable) return { seatId: existing.seatId, reason: "kept" };
    }
  }
  const seatId = placementFor({ mode, activeSeatId, seats, seatSnapshots, model, nowMs, kFor, left: existing?.left });
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
  if (evt.reason === "reset-soon") return `Moved a conversation from ${from} to ${to} (its limit resets within the hour — its remaining quota goes first)`;
  if (evt.reason === "rebalance") {
    // The target's weekly resets sooner; when some of it could not be spent before
    // then anyway, say that instead — that is the quota being rescued.
    if (Number.isFinite(evt.slackTo) && evt.slackTo > 0) return `Moved a conversation from ${from} to ${to} (${to}'s weekly will not be used up before it resets)`;
    return `Moved a conversation from ${from} to ${to} (${to}'s weekly resets sooner — spending that first)`;
  }
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
  if (evt.reason === "rebalance") {
    for (const k of ["deadlineFrom", "deadlineTo"]) if (Number.isFinite(evt[k])) evidence[k] = evt[k];
    for (const k of ["slackFrom", "slackTo"]) if (Number.isFinite(evt[k])) evidence[k] = Math.round(evt[k]);
  }
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
  // Weekly-deadline hooks (both optional). `kFor(provider)` → the provider-bound
  // `(kind) → short-windows-per-long-window | null` reader (absent ⇒ slack is
  // unknown everywhere; deadlines still order). `attribution` is the per-request
  // placement log (`seatAttribution.mjs`, default: the jsonl appender).
  kFor = () => noK,
  attribution = null,
  log = console,
} = {}) {
  /** @type {ReturnType<typeof emptyAssignments>|null} */
  let store = null;
  const mutex = createMutex();
  const refreshing = new Map();
  let defaultAttribution = null;

  /** Record which seat/model served a request — after the decision, never able to fail it. */
  function attribute(provider, session, root, seat, model, reason) {
    queueMicrotask(() => {
      try {
        const writer = attribution ?? (defaultAttribution ??= createSeatAttribution({ log }));
        const out = writer.record({ provider, session, root, seat, model, reason });
        if (out && typeof out.then === "function") out.then(undefined, (e) => log.warn?.("[accounts] seat attribution failed:", e?.message ?? e));
      } catch (e) {
        log.warn?.("[accounts] seat attribution failed:", e?.message ?? e);
      }
    });
  }

  /** The conversation root for the paths that never reach `place` (no store write). */
  function rootOf(sessionID, parentSessionID) {
    try {
      return resolveRoot({ sessionID, parentSessionID, children: ensure().children }).root;
    } catch {
      return sessionID;
    }
  }

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
   * `model` (optional) is the request's model id: it decides which model-scoped
   * windows count for this decision and is recorded as the conversation's model.
   * A malformed one is treated as unknown.
   * @param {{model?: string|null}} [opts]
   * @returns {Promise<{seatId: string|null, live: boolean, provider?: string, credentialFile?: string, expiresAt?: number}>}
   */
  function resolve(provider, sessionID, parentSessionID = null, { model = null } = {}) {
    // Seeing a call at all is what proves the plugin is in the request path.
    markPluginSeen(now());
    if (!ACCOUNT_PROVIDERS.includes(provider)) return Promise.reject(new Error("unknown provider"));
    if (!isId(sessionID)) return Promise.reject(new Error("invalid sessionID"));
    if (parentSessionID != null && !isId(parentSessionID)) return Promise.reject(new Error("invalid parentSessionID"));

    // Serialized: two concurrent first requests of one conversation (a parent
    // and its sub-agent) must land on the SAME seat, not race to two.
    return mutex.runExclusive(async () => {
      const states = await stateOf(provider);
      const requestModel = isId(model) ? model : null;
      // No seats → today's single-credential behaviour. ONE seat → nothing to
      // choose between, and whatever login is live keeps serving.
      if (!states) {
        attribute(provider, sessionID, rootOf(sessionID, parentSessionID), null, requestModel, "none");
        return { seatId: null, live: true };
      }
      if (states.seats.length === 1) {
        attribute(provider, sessionID, rootOf(sessionID, parentSessionID), states.seats[0].seatId, requestModel, "single");
        return { seatId: states.seats[0].seatId, live: true };
      }
      return (await place(provider, states, sessionID, parentSessionID, { model: requestModel })).result;
    });
  }

  /**
   * The placement core shared by `resolve` (a request) and `reconsider` (a limit
   * signal). Runs inside the mutex, with `states` of a multi-seat provider. With
   * `onlyMove`, a conversation that is not assigned, or whose decision is
   * anything but an automatic move, is left completely untouched. `model` is the
   * request's model; without one the conversation's stored model is used.
   * @returns {Promise<{result: object, decision: object|null}>}
   */
  async function place(provider, states, sessionID, parentSessionID, { onlyMove = false, model: requestModel = null } = {}) {
    const s = ensure();
    const t = now();
    const { root, link } = resolveRoot({ sessionID, parentSessionID, children: s.children });
    const existing = s.providers[provider][root] ?? null;
    const untouched = { result: { seatId: null, live: true }, decision: null };
    if (onlyMove && (!existing || states.mode !== "auto")) return untouched;
    const model = requestModel ?? existing?.model ?? null;
    // The model RECORDED for the conversation is its root session's own: a
    // sub-agent on another model (a Sonnet helper under an Opus conversation)
    // decides its own request with its model but must not overwrite the stored
    // one — alternating writes, and a re-decision for the wrong model.
    const isRootRequest = root === sessionID;
    const storedModel = (isRootRequest ? requestModel : null) ?? existing?.model ?? null;
    const decision = decideSeat({
      existing,
      mode: states.mode,
      activeSeatId: states.activeSeatId,
      seats: states.seats,
      seatSnapshots: snapshotsFor(provider),
      nowMs: t,
      model,
      kFor: kFor(provider),
    });
    if (onlyMove && decision.reason !== "moved") return untouched;
    let dirty = false;
    if (link) {
      s.children[link.child] = { root: link.root, at: t };
      dirty = true;
    }
    if (!decision.seatId) {
      attribute(provider, sessionID, root, null, model, "none");
      return { result: { seatId: null, live: true }, decision };
    }

    let assignmentsChanged = false;
    let movedEvent = null;
    if (decision.reason === "assigned") {
      s.providers[provider][root] = { seatId: decision.seatId, assignedAt: t, lastUsedAt: t, ...(storedModel ? { model: storedModel } : {}) };
      dirty = true;
      assignmentsChanged = true;
    } else if (decision.reason === "moved") {
      // Remember where it came from (the move notice shows it) and every seat it
      // left in the last 5 h (so it cannot bounce back).
      const why = decision.why ?? "exhausted";
      const left = {};
      for (const [seatId, at] of Object.entries(existing.left ?? {})) if (t - at < MOVE_BACK_BLOCK_MS) left[seatId] = at;
      // An optional reset-soon move leaves no block behind (rule 4).
      if (why !== "reset-soon") left[decision.from] = t;
      const rec = {
        seatId: decision.seatId,
        assignedAt: t,
        lastUsedAt: t,
        movedFrom: decision.from,
        movedAt: t,
        reason: why,
        left,
      };
      if (storedModel) rec.model = storedModel;
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
          // A rebalance is a routine optimisation: logged, but no chat notice.
          ...(why === "rebalance" ? { silent: true, ...decision.rebalance } : {}),
        };
      }
    } else if (existing) {
      // Kept: refresh lastUsedAt at most hourly, but record a CHANGED model at once
      // (a re-decision after a limit signal must see the model it is on now).
      if (t - existing.lastUsedAt >= TOUCH_INTERVAL_MS) {
        existing.lastUsedAt = t;
        dirty = true;
      }
      if (isRootRequest && requestModel && existing.model !== requestModel) {
        existing.model = requestModel;
        dirty = true;
      }
    }
    if (dirty) {
      store = pruneAssignments(s, t);
      await persist();
    }
    const outcome = onlyMove ? "reconsider" : decision.reason === "moved" ? `moved:${decision.why ?? "exhausted"}` : decision.reason;
    attribute(provider, sessionID, root, decision.seatId, model, outcome);
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
   * Is the seat this session's conversation is assigned to full right now — for
   * the conversation's stored model? Uses the same readings every decision uses
   * (`snapshotsFor`), so a seat a failed turn marked limited counts as full. Synchronous, read-only.
   * @returns {boolean|null} null = the conversation has no assignment for this provider
   */
  function conversationSeatFull(provider, sessionId) {
    if (!ACCOUNT_PROVIDERS.includes(provider) || !isId(sessionId)) return null;
    const s = ensure();
    const root = s.children[sessionId]?.root ?? sessionId;
    const seatId = s.providers[provider]?.[root]?.seatId;
    if (!seatId) return null;
    return isSeatFull(snapshotsFor(provider).find((x) => x?.seatId === seatId), { model: s.providers[provider][root].model ?? null });
  }

  /**
   * Re-decide one conversation NOW (after a limit signal and a fresh usage
   * poll), through the same decision + recording + announcing path as a request.
   * Only an automatic move changes anything: manual mode, an unassigned
   * conversation, a single-seat provider, or no seat with room all leave it be.
   * Decides for the conversation's stored model, or `opts.model` when the caller
   * knows the model of the request that just failed.
   * @param {{model?: string|null}} [opts]
   * @returns {Promise<{moved: boolean, from?: string, to?: string, reason?: string}>}
   */
  function reconsider(provider, sessionId, { model = null } = {}) {
    if (!ACCOUNT_PROVIDERS.includes(provider) || !isId(sessionId)) return Promise.resolve({ moved: false });
    return mutex.runExclusive(async () => {
      const states = await stateOf(provider);
      if (!states || states.seats.length < 2) return { moved: false };
      const { decision } = await place(provider, states, sessionId, null, { onlyMove: true, model: isId(model) ? model : null });
      return decision ? { moved: true, from: decision.from, to: decision.seatId, reason: decision.why } : { moved: false };
    });
  }

  return { resolve, refreshSeat, markLimited, reconsider, conversationSeatFull, assignments, sessionAssignment, forgetSeat, _store: () => ensure() };
}
