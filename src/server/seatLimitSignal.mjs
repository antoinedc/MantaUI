// seatLimitSignal.mjs — a failed turn that hit a rate/usage limit re-places its
// conversation immediately (multi-account §5.3 follow-up).
//
// The usage poller runs every 10 minutes, so a seat can jump from <95% straight
// to its limit between polls and the 95% move never happens. On a limit signal
// we (1) mark the conversation's seat limited, (2) force one fresh usage poll —
// debounced per provider so a burst of failures costs one refresh — and (3) ask
// the seat assigner to re-decide the conversation. The conversation's NEXT
// request then resolves to the seat it was moved to.
//
// Pure + dependency-injected; wired in index.mjs.

/** At most one forced usage refresh per provider per this long. */
export const LIMIT_REFRESH_DEBOUNCE_MS = 30_000;

/** Seats exist for these providers only (usage-adapter id === account provider). */
const SEAT_PROVIDERS = new Set(["claude", "codex"]);

/**
 * @param {object} deps
 * @param {() => Promise<unknown>} deps.refreshUsage  the usage poller's tick
 * @param {{markLimited: Function, reconsider: Function}} deps.assigner
 * @param {() => number} [deps.now]
 * @param {number} [deps.debounceMs]
 * @param {{warn?: Function}} [deps.log]
 * @returns {(signal: {sessionId: string, adapterId: string, kind?: string}) => Promise<{moved:boolean}|null>}
 */
export function createLimitSignalHandler({ refreshUsage, assigner, now = () => Date.now(), debounceMs = LIMIT_REFRESH_DEBOUNCE_MS, log = console }) {
  /** @type {Map<string, {at: number, run: Promise<unknown>}>} */
  const refreshes = new Map();

  function refresh(provider) {
    const prev = refreshes.get(provider);
    const t = now();
    if (prev && t - prev.at < debounceMs) return prev.run; // joins the in-flight / recent refresh
    const run = Promise.resolve()
      .then(() => refreshUsage())
      .catch((e) => log.warn?.("[seat-limit] usage refresh failed:", e?.message ?? e));
    refreshes.set(provider, { at: t, run });
    return run;
  }

  return async function onLimitSignal({ sessionId, adapterId, kind } = {}) {
    if (!SEAT_PROVIDERS.has(adapterId) || !sessionId) return null;
    try {
      // Mark first: requests arriving while the poll is in flight already avoid the seat.
      assigner.markLimited(adapterId, sessionId);
      await refresh(adapterId);
      const res = await assigner.reconsider(adapterId, sessionId);
      if (res?.moved) log.warn?.(`[seat-limit] ${adapterId} conversation re-placed after ${kind ?? "limit"} signal: ${res.from} -> ${res.to}`);
      return res ?? { moved: false };
    } catch (e) {
      log.warn?.("[seat-limit] re-placement failed:", e?.message ?? e);
      return null;
    }
  };
}
