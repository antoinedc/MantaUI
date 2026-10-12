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
// It only ever acts after a real move, so a conversation with no seat that has
// room keeps opencode's normal retry (no abort loop).
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
  deliver,
  now = () => Date.now(),
  log = console,
}) {
  /** sessionId → what we need to recover it later. */
  const retrying = new Map();
  const signalAt = new Map();
  const recoverAt = new Map();

  const warn = (...a) => log.warn?.(...a);

  function prune(map, windowMs) {
    if (map.size <= PRUNE_ABOVE) return;
    const t = now();
    for (const [k, at] of map) if (t - at >= windowMs) map.delete(k);
  }

  /** Abort the sleeping retry; for a top-level conversation, then say "Keep going". */
  async function recover(sessionId, move = {}) {
    const entry = retrying.get(sessionId);
    if (!entry) return;
    const t = now();
    if (typeof entry.next === "number" && entry.next - t <= RECOVER_MIN_WAIT_MS) {
      // The next attempt is imminent: keep the entry (a later trigger can still
      // recover it) and remember the move for a later, longer retry.
      entry.pendingMove = move;
      return;
    }
    const last = recoverAt.get(sessionId);
    if (last !== undefined && t - last < RECOVER_DEBOUNCE_MS) return;
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
      return;
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
    const from = move.from ?? "?";
    const to = move.to ?? "?";
    log.warn?.(`[seat-retry] recovered ${sessionId} ${from} -> ${to}`);
  }

  async function onRetry(sessionId, status) {
    const a = sessionAssignment(sessionId);
    if (!a?.provider) {
      retrying.delete(sessionId); // not on a seat: opencode's own retry is all there is
      return;
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
    // Already moved while it was waiting, and the sleep is now long: wake it.
    if (entry.pendingMove && (next === undefined || next - now() > RECOVER_MIN_WAIT_MS)) {
      await recover(sessionId, entry.pendingMove);
      return;
    }
    const message = typeof status?.message === "string" ? status.message : undefined;
    const limit = classifyLimitSignal({ provider: a.provider, errorMessage: message });
    if (!limit) return; // overload / unrelated retry: nothing to do
    const t = now();
    const last = signalAt.get(sessionId);
    if (last !== undefined && t - last < SIGNAL_DEBOUNCE_MS) return;
    signalAt.set(sessionId, t);
    prune(signalAt, SIGNAL_DEBOUNCE_MS);
    const res = await onLimitSignal({ sessionId, adapterId: a.provider, kind: limit.kind });
    if (res?.moved) await recover(sessionId, res);
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

  return { observeEvent, onMoved };
}
