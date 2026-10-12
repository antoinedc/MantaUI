// seatRetryWatch.mjs — wakes a conversation that is asleep in an opencode
// retry once its seat has been moved (docs/superpowers/specs/2026-10-12-seat-
// switch-mid-turn.md, "Layer 2").
//
// A seat that hits its usage limit mid-turn makes the provider answer HTTP 429;
// opencode treats that as retryable and sleeps on `retry-after` — hours, for a
// plan limit. That is a `session.status {type:"retry"}` event, never a
// `session.error`, so the seat-limit signal never fires, and even when the
// usage poller later moves the conversation there is no "next request" for the
// move to take effect on. This watch closes the loop (backstop; the plugin's
// in-request switch is the primary fix):
//
//   * a retry whose message is a rate/usage limit → run the limit handler (mark
//     the seat limited, refresh usage, re-decide the conversation);
//   * when the conversation HAS been moved — by that handler, or by any
//     automatic move reported through `onMoved` (the 10-minute poller) — abort
//     the sleeping retry and, for a top-level conversation, send "Keep going".
//
// It only ever acts when the conversation's CURRENT seat has room, so a
// conversation with no seat that has room keeps opencode's normal retry (no
// abort loop).
//
// Two things make that reliable (the first version missed both):
//   * a periodic `sweep()` asks opencode itself which sessions are retrying
//     (`GET /session/status` per directory), because a retry event fires once
//     per attempt — hours apart for a plan limit — and is lost across a server
//     restart, and the usage poller never moves a sleeping conversation;
//   * the wake condition is "the current seat has room", not "the limit handler
//     just moved it": the conversation may already have been moved by another
//     path (the plugin's /limit call, the session.error path) while the request
//     kept sleeping on the old seat.
//
// "Is this a sub-agent?" is derived from the seat assignment itself: the
// assigner resolves a child to its conversation root (`conversation !== id`).
// That is the cheapest reliable test — a child that makes a request is always
// linked before it can be retrying, and it needs no opencode round-trip.
//
// Pure + dependency-injected; wired in index.mjs.

import { classifyLimitSignal } from "./usageStopper.mjs";
import { KEEP_GOING_PROMPT } from "./usageResume.mjs";

/** At most one limit signal per session per this long. */
export const SIGNAL_DEBOUNCE_MS = 60_000;
/** At most one recovery (abort + "Keep going") per session per this long. */
export const RECOVER_DEBOUNCE_MS = 120_000;
/**
 * A retry whose next attempt is this close (or closer) is left alone: the
 * plugin handles that attempt itself, so aborting would only throw away a turn
 * that recovers on its own. Only a LONG sleep needs waking.
 */
export const RECOVER_MIN_WAIT_MS = 30_000;
/**
 * The sweep runs every minute; the limit handler (mark the seat limited, force a
 * usage poll) is a heavier call than that cadence warrants, and re-marking would
 * keep a seat "full" for as long as a session sleeps. So within one sleep the
 * sweep runs the handler at most this often and otherwise only re-decides
 * (`reconsider`, which reads the current usage and changes nothing else).
 */
export const SWEEP_HANDLER_REPEAT_MS = 5 * 60_000;

const PRUNE_ABOVE = 500;

/**
 * The model of the LAST user message in an opencode transcript, as
 * `{providerID, modelID}`, or null. A user message carries it as `info.model`
 * (opencode ≥1.1x); some builds put `providerID`/`modelID` straight on `info`.
 * @param {unknown} messages  `[{info, parts}]`
 */
export function lastUserModelFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "user") continue;
    const m = info.model && typeof info.model === "object" ? info.model : info;
    if (typeof m?.providerID === "string" && m.providerID && typeof m?.modelID === "string" && m.modelID) {
      return { providerID: m.providerID, modelID: m.modelID };
    }
    return null; // the last user message is the one that counts
  }
  return null;
}

/**
 * @param {object} deps
 * @param {(sessionId: string) => ({provider: string, conversation: string}|null)} deps.sessionAssignment
 *        the seat assigner's lookup (`conversation !== sessionId` ⇒ a sub-agent)
 * @param {(signal: {sessionId: string, adapterId: string, kind: string}) => Promise<{moved?: boolean, from?: string, to?: string}|null>} deps.onLimitSignal
 *        the shared limit handler (mark limited → refresh usage → reconsider)
 * @param {(sessionId: string) => boolean|null} [deps.conversationSeatFull]
 *        the assigner's read: is the seat this session's conversation is assigned
 *        to full? `null` = no assignment / unknown (default: always null)
 * @param {(provider: string, sessionId: string) => Promise<{moved?: boolean, from?: string, to?: string}|null>} [deps.reconsider]
 *        re-decide the conversation without marking its seat limited
 * @param {() => Promise<string[]>|string[]} [deps.listDirectories]  directories to scan in `sweep()`
 * @param {(directory: string) => Promise<Record<string, {type?: string, message?: string, next?: number}>>} [deps.listStatuses]
 *        opencode's `GET /session/status?directory=` map; must throw on failure
 * @param {(sessionId: string) => string|null|undefined} [deps.sessionDirectory]  where a session lives, if known
 * @param {(sessionId: string) => Promise<unknown>} deps.abortSession
 * @param {(sessionId: string) => Promise<{providerID: string, modelID: string}|null|undefined>} [deps.lastUserModel]
 * @param {(args: {sessionId: string, text: string, model?: object}) => Promise<unknown>} deps.deliver  promptDelivery.deliver
 * @param {() => number} [deps.now]
 * @param {{warn?: Function, log?: Function}} [deps.log]
 */
export function createSeatRetryWatch({
  sessionAssignment,
  onLimitSignal,
  abortSession,
  lastUserModel = async () => null,
  conversationSeatFull = () => null,
  reconsider = async () => ({ moved: false }),
  listDirectories = async () => [],
  listStatuses = async () => ({}),
  sessionDirectory = () => null,
  deliver,
  now = () => Date.now(),
  log = console,
}) {
  /** sessionId → what we need to recover it later. */
  const retrying = new Map();
  const signalAt = new Map();
  const recoverAt = new Map();
  let sweeping = false;

  const warn = (...a) => log.warn?.(...a);

  function prune(map, windowMs) {
    if (map.size <= PRUNE_ABOVE) return;
    const t = now();
    for (const [k, at] of map) if (t - at >= windowMs) map.delete(k);
  }

  /**
   * Abort the sleeping retry; for a top-level conversation, then say "Keep going".
   * @returns {Promise<boolean>} true when the retry was actually aborted
   */
  async function recover(sessionId, move = {}) {
    const entry = retrying.get(sessionId);
    if (!entry) return false;
    const t = now();
    if (typeof entry.next === "number" && entry.next - t <= RECOVER_MIN_WAIT_MS) {
      // The next attempt is imminent: keep the entry (a later trigger can still
      // recover it) and remember the move for a later, longer retry.
      entry.pendingMove = move;
      return false;
    }
    const last = recoverAt.get(sessionId);
    if (last !== undefined && t - last < RECOVER_DEBOUNCE_MS) return false;
    delete entry.pendingMove;
    // Marked synchronously: a move reported through onMoved while the limit
    // handler is still returning the same move must not recover twice.
    recoverAt.set(sessionId, t);
    prune(recoverAt, RECOVER_DEBOUNCE_MS);
    retrying.delete(sessionId);
    try {
      await abortSession(sessionId);
    } catch (e) {
      // Nothing was aborted: stay eligible for the next trigger.
      recoverAt.delete(sessionId);
      entry.pendingMove = move;
      retrying.set(sessionId, entry);
      warn(`[seat-retry] abort of ${sessionId} failed:`, e?.message ?? e);
      return false;
    }
    if (!entry.isChild) {
      // A sub-agent is only aborted: its parent's task tool returns and the
      // parent's next request already resolves to the new seat.
      try {
        let model = null;
        try {
          model = await lastUserModel(sessionId);
        } catch (e) {
          warn(`[seat-retry] last user model of ${sessionId} unavailable:`, e?.message ?? e);
        }
        const res = await deliver({ sessionId, text: KEEP_GOING_PROMPT, ...(model ? { model } : {}) });
        if (res?.rejected) warn(`[seat-retry] "Keep going" for ${sessionId} was rejected`);
      } catch (e) {
        warn(`[seat-retry] "Keep going" for ${sessionId} failed:`, e?.message ?? e);
      }
    }
    // A move the handler reported names both seats; otherwise (the conversation
    // was already moved, or its seat simply has room) say where it is now.
    const a = safeAssignment(sessionId)?.assignment;
    const from = move.from ?? a?.movedFrom ?? "?";
    const to = move.to ?? a?.seatId ?? "?";
    log.warn?.(`[seat-retry] recovered ${sessionId} ${from} -> ${to}`);
    return true;
  }

  function safeAssignment(sessionId) {
    try {
      return sessionAssignment(sessionId);
    } catch {
      return null;
    }
  }

  /** The conversation's current seat: full (true), has room (false), unknown (null). Never throws. */
  function seatFull(sessionId) {
    try {
      const v = conversationSeatFull(sessionId);
      return v === true || v === false ? v : null;
    } catch (e) {
      warn(`[seat-retry] seat check for ${sessionId} failed:`, e?.message ?? e);
      return null;
    }
  }

  /** Record (or refresh) a retrying session. Null when it is not on a seat. */
  function track(sessionId, status) {
    const a = sessionAssignment(sessionId);
    if (!a?.provider) {
      retrying.delete(sessionId); // not on a seat: opencode's own retry is all there is
      return null;
    }
    const prev = retrying.get(sessionId);
    const next = typeof status?.next === "number" && Number.isFinite(status.next) ? status.next : undefined;
    const entry = {
      provider: a.provider,
      conversation: a.conversation ?? sessionId,
      isChild: !!a.conversation && a.conversation !== sessionId,
      next,
    };
    if (prev?.pendingMove) entry.pendingMove = prev.pendingMove;
    retrying.set(sessionId, entry);
    return entry;
  }

  /**
   * Decide whether a sleeping retry should be woken, and wake it.
   *   * current seat has room → wake it (no limit handler: the sleeping request
   *     is on an OLDER seat, and marking the new one limited would be wrong).
   *     Only for a limit-type message: an overload retry recovers by itself.
   *   * current seat full (or unknown, with a limit message) → re-decide the
   *     conversation (the limit handler for a limit message, a plain reconsider
   *     otherwise), then wake it if it now sits on a seat with room.
   *   * still on a full seat → nothing: opencode keeps waiting for the reset.
   * @param {"event"|"sweep"} source
   * @returns {Promise<boolean>} true when the retry was aborted
   */
  async function consider(sessionId, entry, message, source) {
    const limit = classifyLimitSignal({ provider: entry.provider, errorMessage: message });
    const full = seatFull(sessionId);
    if (full === false) return limit ? recover(sessionId, {}) : false;
    if (full === null && !limit) return false; // overload / unrelated retry: nothing to do
    const t = now();
    const last = signalAt.get(sessionId);
    if (last !== undefined && t - last < SIGNAL_DEBOUNCE_MS) return false;
    const useHandler = !!limit && (source === "event" || last === undefined || t - last >= SWEEP_HANDLER_REPEAT_MS);
    let res;
    if (useHandler) {
      signalAt.set(sessionId, t);
      prune(signalAt, SWEEP_HANDLER_REPEAT_MS);
      res = await onLimitSignal({ sessionId, adapterId: entry.provider, kind: limit.kind });
    } else {
      res = await reconsider(entry.provider, sessionId);
    }
    if (res?.moved || seatFull(sessionId) === false) return recover(sessionId, res ?? {});
    return false;
  }

  async function onRetry(sessionId, status, source = "event") {
    const entry = track(sessionId, status);
    if (!entry) return false;
    const long = entry.next === undefined || entry.next - now() > RECOVER_MIN_WAIT_MS;
    // A sweep leaves an imminent retry alone; a live event goes on to the same
    // decision so a move is remembered (`pendingMove`) for a later, longer sleep.
    if (source === "sweep" && !long) return false;
    // Already moved while it was waiting, and the sleep is now long: wake it.
    if (entry.pendingMove && long) return recover(sessionId, entry.pendingMove);
    const message = typeof status?.message === "string" ? status.message : undefined;
    return consider(sessionId, entry, message, source);
  }

  /**
   * Ask opencode which sessions are retrying right now and wake the ones whose
   * seat has room. Safe to call at any time and from a timer: it never rejects,
   * and an overlapping call is skipped.
   * @returns {Promise<{retrying: number, woken: number}>}
   */
  async function sweep() {
    if (sweeping) return { retrying: 0, woken: 0 };
    sweeping = true;
    let found = 0;
    let woken = 0;
    try {
      let dirs;
      try {
        dirs = [...new Set((await listDirectories()) ?? [])];
      } catch (e) {
        warn("[seat-retry] sweep: listing directories failed:", e?.message ?? e);
        return { retrying: 0, woken: 0 };
      }
      const answered = new Set();
      const inRetry = new Map(); // sessionId → status
      for (const dir of dirs) {
        let map;
        try {
          map = await listStatuses(dir);
        } catch (e) {
          warn(`[seat-retry] sweep: status of ${dir} failed:`, e?.message ?? e);
          continue; // nothing is learned about this directory: leave its sessions alone
        }
        answered.add(dir);
        for (const [sid, st] of Object.entries(map ?? {})) {
          if (st?.type === "retry") inRetry.set(sid, st);
        }
      }
      // Forget a tracked session the scan shows is no longer asleep — but only
      // when the directory it lives in answered (when we cannot tell where it
      // lives, only when every directory did).
      if (answered.size > 0) {
        for (const sid of [...retrying.keys()]) {
          if (inRetry.has(sid)) continue;
          let dir = null;
          try {
            dir = sessionDirectory(sid) ?? null;
          } catch {
            /* unknown */
          }
          if (dir ? answered.has(dir) : answered.size === dirs.length) retrying.delete(sid);
        }
      }
      for (const [sid, st] of inRetry) {
        try {
          if (!sessionAssignment(sid)?.provider) {
            retrying.delete(sid);
            continue;
          }
          found++;
          if (await onRetry(sid, st, "sweep")) woken++;
        } catch (e) {
          warn(`[seat-retry] sweep of ${sid} failed:`, e?.message ?? e);
        }
      }
      if (found > 0) log.warn?.(`[seat-retry] sweep: ${found} retrying, ${woken} woken`);
      return { retrying: found, woken };
    } catch (e) {
      warn("[seat-retry] sweep failed:", e?.message ?? e);
      return { retrying: found, woken };
    } finally {
      sweeping = false;
    }
  }

  /**
   * Feed every opencode firehose event. Returns a promise tests can await; the
   * pump ignores it. Never rejects.
   */
  function observeEvent(evt) {
    try {
      const props = evt?.properties ?? {};
      const sid = typeof props.sessionID === "string" ? props.sessionID : null;
      if (!sid) return Promise.resolve();
      switch (evt.type) {
        case "session.status": {
          const type = props.status?.type;
          if (type === "retry") {
            return onRetry(sid, props.status).catch((e) => warn("[seat-retry] retry handling failed:", e?.message ?? e));
          }
          if (type === "busy" || type === "idle") retrying.delete(sid);
          return Promise.resolve();
        }
        case "session.idle":
        case "session.error":
        case "session.deleted":
          retrying.delete(sid);
          if (evt.type === "session.deleted") {
            signalAt.delete(sid);
            recoverAt.delete(sid);
          }
          return Promise.resolve();
        default:
          return Promise.resolve();
      }
    } catch (e) {
      warn("[seat-retry] observeEvent failed:", e?.message ?? e);
      return Promise.resolve();
    }
  }

  /**
   * The seat assigner moved a conversation automatically (`evt.sessionId` is the
   * conversation root): recover every session of it that is asleep in a retry.
   * Returns a promise tests can await; never rejects.
   */
  function onMoved(evt) {
    const jobs = [];
    try {
      for (const [sid, entry] of [...retrying]) {
        if (entry.conversation !== evt?.sessionId) continue;
        if (evt?.provider && entry.provider !== evt.provider) continue;
        jobs.push(recover(sid, evt).catch((e) => warn("[seat-retry] recovery failed:", e?.message ?? e)));
      }
    } catch (e) {
      warn("[seat-retry] onMoved failed:", e?.message ?? e);
    }
    return Promise.all(jobs).then(() => undefined);
  }

  return { observeEvent, onMoved, sweep };
}
