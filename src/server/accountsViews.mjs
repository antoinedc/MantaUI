// accountsViews.mjs — the renderer-facing views of the multi-account store
// (multi-account spec §8 "Contract v2"). PURE: no I/O, no clocks. Everything a
// view needs is passed in, so the builders are tested on plain data.
//
//   ProviderView → AccountView[] → SeatView[]
//
// NOTHING SECRET: a view carries labels, emails, plans, usage readings and
// counts — never a credential, a credential path or a token. The seat's
// `credentialDir` (a filesystem path) is deliberately not copied.

import { seatLoad } from "../shared/seatChoice.mjs";
import { chooseSeat, decideMove, MOVE_AT_PCT, isSeatFull } from "./seatAssignment.mjs";
import { allSeats, findSeat } from "./accounts.mjs";

/**
 * A seat's status as the UI shows it.
 *   • the LIVE login is "ok" whatever the store says — opencode owns and
 *     refreshes it, so an "expired" mark left from when it was a directory seat
 *     is stale (same reasoning as `seatStates.usable`);
 *   • a stored "expired" / "signed-out" stays;
 *   • a seat that cannot serve (no readable credentials) is "signed-out", even
 *     if the store last saw it "ok";
 *   • anything else is "ok" / "unknown" as stored.
 * @param {{storedStatus?: string, live: boolean, usable: boolean}} args
 * @returns {"ok"|"expired"|"signed-out"|"unknown"}
 */
export function seatViewStatus({ storedStatus, live, usable }) {
  if (live) return "ok";
  if (storedStatus === "expired") return "expired";
  if (storedStatus === "signed-out" || !usable) return "signed-out";
  return storedStatus === "ok" ? "ok" : "unknown";
}

/**
 * How many conversations sit on each seat.
 *   • auto mode: the assignments, counted per seat;
 *   • manual mode: the resolver ignores stored assignments and sends EVERY
 *     conversation to the seat it would choose now, so all of the provider's
 *     assignments count toward that seat.
 * @returns {Record<string, number>}
 */
export function countConversations({ mode, activeSeatId, seats, seatSnapshots, assignments }) {
  const counts = {};
  const list = Object.values(assignments ?? {});
  if (mode === "manual") {
    const target = chooseSeat({ mode, activeSeatId, seats, seatSnapshots }) ?? activeSeatId;
    if (target && list.length > 0) counts[target] = list.length;
    return counts;
  }
  for (const a of list) counts[a.seatId] = (counts[a.seatId] ?? 0) + 1;
  return counts;
}

/**
 * The seat a NEW conversation would take (rule 1) — the very function the
 * server's resolver uses, so the hint cannot disagree with what then happens.
 * Manual mode: the active seat. (Where an existing conversation would MOVE is
 * `moveTargetFor`.)
 * @returns {string|null}
 */
export function nextSeatFor({ mode, activeSeatId, seats, seatSnapshots }) {
  if (mode === "manual") return activeSeatId ?? null;
  return chooseSeat({ mode: "auto", activeSeatId, seats, seatSnapshots });
}

/**
 * Where a conversation sitting on the most loaded seat that is at/over the move
 * threshold (and carries conversations) would go — the SAME `decideMove` the
 * resolver runs, applied to a hypothetical conversation with no history of moves.
 * `null` in manual mode (no automatic moves), when no in-use seat is at the
 * threshold, or when that conversation would stay.
 * @param {{mode:string, activeSeatId:string|null, seats:Array<object>, seatSnapshots:Array<object>,
 *          counts:Record<string,number>, nowMs?:number}} args
 * @returns {string|null}
 */
export function moveTargetFor({ mode, activeSeatId, seats, seatSnapshots, counts, nowMs = 0 }) {
  if (mode !== "auto") return null;
  const bySeat = new Map((seatSnapshots ?? []).filter((x) => x?.seatId).map((x) => [x.seatId, x]));
  let worst = null;
  let worstLoad = -1;
  for (const s of seats) {
    if ((counts?.[s.seatId] ?? 0) === 0) continue;
    const snap = bySeat.get(s.seatId);
    const load = isSeatFull(snap) ? 100 : (seatLoad(snap) ?? -1);
    if (load >= MOVE_AT_PCT && load > worstLoad) {
      worst = s;
      worstLoad = load;
    }
  }
  if (!worst) return null;
  return decideMove({ existing: { seatId: worst.seatId }, seats, seatSnapshots: seatSnapshots ?? [], nowMs, activeSeatId })?.seatId ?? null;
}

/**
 * @param {object} args
 * @param {"claude"|"codex"} args.provider
 * @param {{mode:string, activeSeatId:string|null, accounts:Array<object>}} args.state  the stored provider state
 * @param {{seats: Array<{seatId:string, live:boolean, usable:boolean}>}|null} args.states  `accounts.seatStates(provider)`
 * @param {Array<object>} args.seatSnapshots  this provider's per-seat usage readings
 * @param {Record<string, object>} args.assignments  this provider's conversation → assignment map
 * @param {boolean} args.routingActive
 * @returns {object|null}  null when the provider has no seat
 */
export function buildProviderView({ provider, state, states, seatSnapshots, assignments, routingActive, nowMs = 0 }) {
  if (allSeats(state).length === 0) return null;
  const stateBySeat = new Map((states?.seats ?? []).map((s) => [s.seatId, s]));
  const snapBySeat = new Map((seatSnapshots ?? []).filter((x) => x?.seatId).map((x) => [x.seatId, x]));
  // The chooser needs `usable` per seat; a seat the state does not know is not usable.
  const orgBySeat = new Map(state.accounts.flatMap((a) => a.seats.map((x) => [x.id, { accountId: a.id, orgId: a.orgId ?? null }])));
  const chooserSeats = allSeats(state).map((s) => ({ seatId: s.id, usable: stateBySeat.get(s.id)?.usable ?? false, ...orgBySeat.get(s.id) }));
  const mode = state.mode === "auto" ? "auto" : "manual";
  const counts = countConversations({
    mode,
    activeSeatId: state.activeSeatId,
    seats: chooserSeats,
    seatSnapshots,
    assignments,
  });

  const accounts = state.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    orgName: a.orgName ?? null,
    plan: a.plan ?? null,
    seats: a.seats.map((seat) => {
      const st = stateBySeat.get(seat.id);
      const snap = snapBySeat.get(seat.id) ?? null;
      const live = st?.live === true;
      return {
        id: seat.id,
        label: seat.label,
        email: seat.email ?? null,
        status: seatViewStatus({ storedStatus: seat.status, live, usable: st?.usable ?? false }),
        live,
        windows: Array.isArray(snap?.windows) ? snap.windows : [],
        load: snap ? seatLoad(snap) : null,
        fetchedAt: typeof snap?.fetchedAt === "number" ? snap.fetchedAt : null,
        conversations: counts[seat.id] ?? 0,
      };
    }),
  }));

  return {
    provider,
    mode,
    activeSeatId: state.activeSeatId ?? null,
    routingActive: Boolean(routingActive),
    nextSeatId: nextSeatFor({ mode, activeSeatId: state.activeSeatId, seats: chooserSeats, seatSnapshots }),
    moveTargetSeatId: moveTargetFor({ mode, activeSeatId: state.activeSeatId, seats: chooserSeats, seatSnapshots, counts, nowMs }),
    accounts,
  };
}

/** The `SeatView` of one seat inside a built provider view, or null. */
export function findSeatView(providerView, seatId) {
  for (const a of providerView?.accounts ?? []) {
    const hit = a.seats.find((s) => s.id === seatId);
    if (hit) return hit;
  }
  return null;
}

/**
 * accounts:session-seat — the seat a conversation uses, from its assignment.
 * In manual mode that is the seat the resolver will choose on the NEXT request
 * (the stored assignment may still name the previous seat until then), so the
 * answer never lags a fresh "use this seat". `lastMove` is only reported when
 * the stored assignment is the current one — a pending manual switch has not
 * happened yet.
 *
 * @param {object} args
 * @param {{provider:string, assignment:{seatId:string, movedFrom?:string, movedAt?:number, reason?:string}}|null} args.found
 * @param {{mode:string, activeSeatId:string|null, accounts:Array<object>}} args.state
 * @param {{seats: Array<{seatId:string, usable:boolean}>}|null} args.states
 * @param {Array<object>} args.seatSnapshots
 * @returns {null|{provider:string, seatId:string, seatLabel:string, accountLabel:string, lastMove?:{from:string, fromLabel:string, at:number, reason:string, trigger?:{kind:string,pct:number}, crossOrg?:boolean}}}
 */
export function buildSessionSeat({ found, state, states, seatSnapshots }) {
  if (!found) return null;
  const { provider, assignment } = found;
  let seatId = assignment.seatId;
  if (state.mode === "manual") {
    const chooserSeats = allSeats(state).map((s) => ({
      seatId: s.id,
      usable: (states?.seats ?? []).find((x) => x.seatId === s.id)?.usable ?? false,
    }));
    seatId = chooseSeat({ mode: "manual", activeSeatId: state.activeSeatId, seats: chooserSeats, seatSnapshots }) ?? seatId;
  }
  const hit = findSeat(state, (s) => s.id === seatId);
  if (!hit) return null; // the seat is gone; the next request places the conversation again
  const out = { provider, seatId, seatLabel: hit.seat.label, accountLabel: hit.account.label };
  if (seatId === assignment.seatId && assignment.movedFrom && Number.isFinite(assignment.movedAt)) {
    const from = findSeat(state, (s) => s.id === assignment.movedFrom);
    out.lastMove = {
      from: assignment.movedFrom,
      fromLabel: from?.seat.label ?? assignment.movedFrom,
      at: assignment.movedAt,
      reason: typeof assignment.reason === "string" ? assignment.reason : "exhausted",
    };
    // Phase 4 (additive): what triggered an automatic move, and whether it
    // crossed orgs (a full history re-send). Absent on manual / older records.
    const trig = assignment.trigger;
    if (trig && typeof trig.kind === "string" && Number.isFinite(trig.pct)) out.lastMove.trigger = { kind: trig.kind, pct: trig.pct };
    if (typeof assignment.crossOrg === "boolean") out.lastMove.crossOrg = assignment.crossOrg;
  }
  return out;
}
