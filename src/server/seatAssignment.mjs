// seatAssignment.mjs — which SEAT a conversation's requests use (multi-account
// spec §4 request path + §5.3 rules 1–2, phase 2).
//
//   resolve(provider, sessionID, parentSessionID)
//     → { seatId, live: true }                                   pass-through
//     → { seatId, live: false, accessToken, accountId?, expiresAt? }   swap
//
// The `manta-accounts` opencode plugin (docs/opencode-tools/manta-accounts-plugin.ts)
// calls this on every model request. It is the only consumer, and the token it
// gets back travels over the loopback, bearer-gated /api only — never to a
// renderer, never into a log.
//
// RULES IMPLEMENTED (phase 2)
//   1. A NEW conversation takes a seat: manual mode → the active seat; auto mode
//      → the least-loaded seat (ties to the active seat).
//   2. A conversation STAYS on its seat; its sub-agents use the same seat (they
//      share its cached prefix). Only a seat that no longer exists or can no
//      longer serve (signed out / no readable credentials) releases it.
//   NOT here (phase 4): moving a conversation off a seat that is nearly full.
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
import { leastLoadedSeat } from "../shared/seatChoice.mjs";
import { ACCOUNT_PROVIDERS, notePluginSeen } from "./accounts.mjs";

const DAY_MS = 24 * 60 * 60_000;
/** An assignment (or child link) nobody has touched for this long is dropped. */
export const ASSIGNMENT_TTL_MS = 30 * DAY_MS;
/** `lastUsedAt` is refreshed at most this often, so a busy conversation does not
 *  rewrite the file on every request. */
export const TOUCH_INTERVAL_MS = 60 * 60_000;
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
      out.providers[provider][conv] = {
        seatId: a.seatId,
        assignedAt,
        lastUsedAt: Number.isFinite(a.lastUsedAt) ? a.lastUsedAt : assignedAt,
      };
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
 * Rules 1–2 for one request, with no I/O.
 * @returns {{seatId: string|null, reason: "kept"|"assigned"|"none"}}
 */
export function decideSeat({ existing, mode, activeSeatId, seats, seatSnapshots }) {
  if (existing) {
    const seat = seats.find((s) => s.seatId === existing.seatId);
    if (seat?.usable) return { seatId: existing.seatId, reason: "kept" };
  }
  const seatId = chooseSeat({ mode, activeSeatId, seats, seatSnapshots });
  return seatId ? { seatId, reason: "assigned" } : { seatId: null, reason: "none" };
}

/** What the plugin receives for one seat. A live seat carries no credential. */
export function seatResult(seat) {
  if (!seat || seat.live || !seat.credential?.accessToken) return { seatId: seat?.seatId ?? null, live: true };
  const out = { seatId: seat.seatId, live: false, accessToken: seat.credential.accessToken };
  if (seat.credential.accountId) out.accountId = seat.credential.accountId;
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
   * @returns {Promise<{seatId: string|null, live: boolean, accessToken?: string, accountId?: string, expiresAt?: number}>}
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
      });
      if (!decision.seatId) return { seatId: null, live: true };

      if (decision.reason === "assigned") {
        s.providers[provider][root] = { seatId: decision.seatId, assignedAt: t, lastUsedAt: t };
        dirty = true;
      } else if (existing && t - existing.lastUsedAt >= TOUCH_INTERVAL_MS) {
        existing.lastUsedAt = t;
        dirty = true;
      }
      if (dirty) {
        store = pruneAssignments(s, t);
        await persist();
      }
      return seatResult(states.seats.find((x) => x.seatId === decision.seatId));
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
        return seatResult(after?.seats.find((x) => x.seatId === seatId));
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, run);
    }
    return run;
  }

  return { resolve, refreshSeat, _store: () => ensure() };
}
