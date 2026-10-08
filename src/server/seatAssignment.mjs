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
//   3-floor. … and so does an EXHAUSTED seat — in automatic mode only, and only
//      when another usable seat still has room. Without this a conversation would
//      sit on a full seat and fail until it resets, while the provider aggregate
//      (auto: "least-loaded seat") says there is room, so the usage stopper would
//      never even enrol it. Manual mode never moves on its own (spec §5.2): there
//      the aggregate IS the active seat and the stopper handles it. A conversation
//      does not return to a seat it left within 5 hours unless that seat is the
//      only one with room. The move is recorded (`movedFrom`/`movedAt`/`reason`)
//      for phase 4 to surface.
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
import { leastLoadedSeat, isSeatExhausted, seatLoad } from "../shared/seatChoice.mjs";
import { ACCOUNT_PROVIDERS, notePluginSeen } from "./accounts.mjs";

const DAY_MS = 24 * 60 * 60_000;
/** An assignment (or child link) nobody has touched for this long is dropped. */
export const ASSIGNMENT_TTL_MS = 30 * DAY_MS;
/** `lastUsedAt` is refreshed at most this often, so a busy conversation does not
 *  rewrite the file on every request. */
export const TOUCH_INTERVAL_MS = 60 * 60_000;
/** A conversation does not go back to a seat it left this recently (no flip-flop). */
export const MOVE_BACK_BLOCK_MS = 5 * 60 * 60_000;
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
      }
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

/**
 * The seat an exhausted conversation should move to, or null when it should
 * stay (no other usable seat has room). Seats left within 5 h are used only when
 * nothing else has room. Pure.
 */
export function chooseMoveTarget({ existing, seats, seatSnapshots = [], nowMs, activeSeatId = null }) {
  const bySeat = new Map(seatSnapshots.filter((s) => s?.seatId).map((s) => [s.seatId, s]));
  const roomy = seats.filter((s) => s.usable && s.seatId !== existing.seatId && !isSeatFull(bySeat.get(s.seatId)));
  if (roomy.length === 0) return null;
  const left = existing.left ?? {};
  const fresh = roomy.filter((s) => !(typeof left[s.seatId] === "number" && nowMs - left[s.seatId] < MOVE_BACK_BLOCK_MS));
  const pool = fresh.length > 0 ? fresh : roomy;
  return chooseSeat({ mode: "auto", activeSeatId, seats: pool, seatSnapshots });
}

/**
 * Rules 1–2 (+ the exhausted-seat floor) for one request, with no I/O.
 * @returns {{seatId: string|null, reason: "kept"|"assigned"|"moved"|"none", from?: string}}
 */
export function decideSeat({ existing, mode, activeSeatId, seats, seatSnapshots, nowMs = 0 }) {
  if (existing) {
    const seat = seats.find((s) => s.seatId === existing.seatId);
    if (seat?.usable) {
      if (mode === "auto") {
        const own = (seatSnapshots ?? []).find((x) => x?.seatId === existing.seatId);
        if (isSeatFull(own)) {
          const target = chooseMoveTarget({ existing, seats, seatSnapshots, nowMs, activeSeatId });
          if (target) return { seatId: target, reason: "moved", from: existing.seatId };
        }
      }
      return { seatId: existing.seatId, reason: "kept" };
    }
  }
  const seatId = chooseSeat({ mode, activeSeatId, seats, seatSnapshots });
  return seatId ? { seatId, reason: "assigned" } : { seatId: null, reason: "none" };
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
  log = console,
} = {}) {
  /** @type {ReturnType<typeof emptyAssignments>|null} */
  let store = null;
  const mutex = createMutex();
  const refreshing = new Map();

  const ensure = () => (store ??= pruneAssignments(normalizeAssignments(load()), now()));

  async function persist() {
    try {
      await save(store);
    } catch (e) {
      // Losing a write only means a conversation may be re-placed after a
      // restart; it must never fail a model request.
      log.warn?.("[accounts] saving seat assignments failed:", e?.message ?? e);
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

      const s = ensure();
      const t = now();
      const { root, link } = resolveRoot({ sessionID, parentSessionID, children: s.children });
      let dirty = false;
      if (link) {
        s.children[link.child] = { root: link.root, at: t };
        dirty = true;
      }
      const existing = s.providers[provider][root] ?? null;
      const decision = decideSeat({
        existing,
        mode: states.mode,
        activeSeatId: states.activeSeatId,
        seats: states.seats,
        seatSnapshots: listSeatSnapshots().filter((x) => x?.provider === provider),
        nowMs: t,
      });
      if (!decision.seatId) return { seatId: null, live: true };

      if (decision.reason === "assigned") {
        s.providers[provider][root] = { seatId: decision.seatId, assignedAt: t, lastUsedAt: t };
        dirty = true;
      } else if (decision.reason === "moved") {
        // Remember where it came from (phase 4 surfaces it) and every seat it
        // left in the last 5 h (so it cannot bounce back).
        const left = {};
        for (const [seatId, at] of Object.entries(existing.left ?? {})) if (t - at < MOVE_BACK_BLOCK_MS) left[seatId] = at;
        left[decision.from] = t;
        s.providers[provider][root] = {
          seatId: decision.seatId,
          assignedAt: t,
          lastUsedAt: t,
          movedFrom: decision.from,
          movedAt: t,
          reason: "exhausted",
          left,
        };
        dirty = true;
      } else if (existing && t - existing.lastUsedAt >= TOUCH_INTERVAL_MS) {
        existing.lastUsedAt = t;
        dirty = true;
      }
      if (dirty) {
        store = pruneAssignments(s, t);
        await persist();
      }
      return seatResult(provider, states.seats.find((x) => x.seatId === decision.seatId));
    });
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

  return { resolve, refreshSeat, _store: () => ensure() };
}
