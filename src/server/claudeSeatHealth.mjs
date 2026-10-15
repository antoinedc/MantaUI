// claudeSeatHealth.mjs — what a Claude SEAT's usage call answering 401 means.
//
// A usage 401 on a seat that is NOT the box's live login used to only log a
// warning, so a dead seat kept showing "ok" (and the router kept placing
// conversations on it). Now:
//
//   1. 401 → refresh that seat's own credentials once (single-flight, debounced);
//   2. refresh ok → the poller retries the call once;
//      refresh reason `refresh-token-expired` → the seat is "expired" (the
//        refresh outcome bookkeeping already does that);
//   3. any other failure, or a 401 again after a good refresh → "signed-out"
//      (`onSignedOut`, called by the poller);
//   4. a later good usage reading (`onSeatOk`) or refresh → "ok" again.
//
// The LIVE login is never touched here: opencode owns and refreshes it, and a
// live seat is always reported ok. Codex keeps its own handler
// (codexLiveRefresh.mjs); every function here ignores any other adapter.
//
// Pure injection: nothing here knows about the filesystem or the CLI.

const DEBOUNCE_MS = 2 * 60_000;

/**
 * @param {object} deps
 * @param {(provider: string) => Promise<null|{seats: Array<{seatId:string, live:boolean, dir:string|null}>}>} deps.seatStates
 * @param {(target: {seatId:string, dir:string}) => Promise<{ok:boolean, reason?:string}>} deps.refreshSeat
 *   refresh a seat's credentials AND fold the outcome into its status
 *   (refreshClaudeSeatAndNote)
 * @param {(provider: string, seatId: string) => Promise<boolean>} deps.markSignedOut
 * @param {(provider: string, seatId: string) => Promise<boolean>} deps.noteReadingOk
 * @param {() => number} [deps.now]
 * @param {number} [deps.debounceMs]
 * @param {{warn?: Function}} [deps.log]
 */
export function createClaudeSeatHealth({
  seatStates,
  refreshSeat,
  markSignedOut,
  noteReadingOk,
  now = Date.now,
  debounceMs = DEBOUNCE_MS,
  log = console,
}) {
  const lastAttempt = new Map(); // dir → when a refresh was last attempted
  const inFlight = new Map(); // seatId → the running recovery

  async function nonLiveSeat(seatId) {
    const states = await seatStates("claude");
    const seat = states?.seats?.find((s) => s.seatId === seatId);
    return seat && !seat.live && seat.dir ? seat : null;
  }

  /** Refresh one seat once (debounced). Never throws. */
  async function recover(seatId) {
    try {
      const seat = await nonLiveSeat(seatId);
      if (!seat) return { ok: false, reason: "not-applicable" };
      const t = now();
      if (t - (lastAttempt.get(seat.dir) ?? -Infinity) < debounceMs) return { ok: false, reason: "debounced" };
      lastAttempt.set(seat.dir, t);
      const r = await refreshSeat({ seatId, dir: seat.dir });
      return r?.ok ? { ok: true } : { ok: false, reason: r?.reason ?? "failed" };
    } catch (e) {
      log.warn?.("[claude-auth] recovering a seat after a 401 failed:", e?.message ?? e);
      return { ok: false, reason: "error" };
    }
  }

  return {
    /**
     * The usage poller's 401 recovery. `{ok:true}` → retry once; anything else →
     * the 401 stands. Never throws.
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async onUnauthorized({ adapterId, seatId = null } = {}) {
      if (adapterId !== "claude" || !seatId) return { ok: false, reason: "not-applicable" };
      // Single-flight per seat, claimed BEFORE the first await: two callers
      // landing together share one refresh (and one answer).
      const running = inFlight.get(seatId);
      if (running) return running;
      const run = recover(seatId).finally(() => inFlight.delete(seatId));
      inFlight.set(seatId, run);
      return run;
    },

    /** The 401 stayed after recovery: the seat is signed out. Live seat → nothing. */
    async onSignedOut({ adapterId, seatId } = {}) {
      if (adapterId !== "claude" || !seatId) return;
      if (!(await nonLiveSeat(seatId))) return;
      await markSignedOut("claude", seatId);
    },

    /** A good usage reading: a signed-out seat is ok again. */
    async onSeatOk({ adapterId, seatId } = {}) {
      if (adapterId !== "claude" || !seatId) return;
      await noteReadingOk("claude", seatId);
    },
  };
}
