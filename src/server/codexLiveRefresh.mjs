// codexLiveRefresh.mjs — keeps the LIVE ChatGPT (Codex) login fresh while Codex
// is idle.
//
// The live login is the `openai` entry in opencode's auth store. opencode only
// refreshes it when a model request needs it, so a box that has not used Codex
// for a day sits on an expired token: the usage poll 401s every time, no
// snapshot is published and the usage dial disappears. This refreshes it
// ahead of expiry (the proactive sweep) and on a 401 (the usage poller).
//
// RULES this is written to (do not loosen):
//   • The refresh token ROTATES. It is single-flight per login (shared with
//     every other refresh of the same file through codexRefresh.singleFlight), and
//     the new entry is persisted BEFORE anything else happens.
//   • Persisting goes through opencode's OWN API (injected `persist`, in
//     production `setProviderAuthEntry("openai", …)`) — never by writing
//     auth.json ourselves — and is verified by reading the entry back.
//   • The entry is RE-READ right before refreshing: if opencode already has a
//     fresher one (it refreshed meanwhile, or the login changed) nothing is spent.
//   • If the token endpoint accepted the refresh but persisting then failed, the
//     rotated entry is held in memory and re-persisted on the next call instead of
//     refreshing again (the old refresh token is already burned), as long as
//     opencode still holds the entry it was derived from.
// Tokens are never logged and never appear in a returned reason.

import {
  CODEX_REFRESH_MARGIN_MS,
  applyTokenResponse,
  requestCodexTokens,
  shouldRefreshCodexAhead,
  singleFlight,
} from "./codexRefresh.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.readEntry  opencode's current `openai` oauth entry (re-read every time)
 * @param {(entry: object) => Promise<{ok:boolean}>} deps.persist  write it THROUGH opencode's API
 * @param {(entry: object) => Promise<unknown>} [deps.afterPersist]  e.g. mirror into the seat directory
 * @param {string} [deps.flightKey]  the file that holds the login (single-flight key)
 */
export function createLiveCodexRefresher({
  readEntry,
  persist,
  afterPersist = async () => {},
  flightKey = "codex-live",
  fetchImpl = fetch,
  now = Date.now,
  log = console,
  marginMs = CODEX_REFRESH_MARGIN_MS,
  persistAttempts = 3,
  retryDelayMs = 500,
  sleep = wait,
} = {}) {
  // The rotated entry whose persisting failed, and the refresh token it replaced.
  let pending = null;

  async function persistVerified(entry) {
    let reason = "persist-failed";
    for (let i = 0; i < persistAttempts; i++) {
      if (i > 0) await sleep(retryDelayMs);
      let r;
      try {
        r = await persist(entry);
      } catch {
        r = { ok: false };
      }
      if (!r?.ok) {
        reason = "persist-failed";
        continue;
      }
      const back = await readEntry().catch(() => null);
      if (back && back.access === entry.access && back.refresh === entry.refresh) return { ok: true };
      reason = "verify-failed";
    }
    return { ok: false, reason };
  }

  async function finish(entry, basedOn) {
    pending = { entry, basedOn };
    const p = await persistVerified(entry);
    if (!p.ok) {
      log.log?.("[codex-auth] live refresh ok=false reason=%s (will retry persisting)", p.reason);
      return { ok: false, reason: p.reason };
    }
    pending = null;
    try {
      await afterPersist(entry);
    } catch {
      // mirroring is best-effort; the login itself is already saved
    }
    log.log?.("[codex-auth] live refresh ok=true expiresAt=%s", entry.expires);
    return { ok: true, expiresAt: entry.expires };
  }

  async function run({ force = false, rejectedAccess = null } = {}) {
    const cur = await readEntry().catch(() => null);
    if (!cur) return { ok: false, reason: "no-credentials" };

    if (pending) {
      // opencode still holds the entry we rotated away from → save the rotated
      // one rather than burning another refresh token. Otherwise opencode has
      // moved on by itself and ours is obsolete.
      if (cur.refresh === pending.basedOn) return finish(pending.entry, pending.basedOn);
      pending = null;
    }

    // Due by the clock, or (a 401 for the token we sent) that very token is still
    // the one opencode holds. Anything else means opencode got there first.
    const due = shouldRefreshCodexAhead(cur.expires, now(), marginMs);
    const rejectedStillCurrent = typeof rejectedAccess === "string" && rejectedAccess !== "" && cur.access === rejectedAccess;
    if (!force && !due && !rejectedStillCurrent) {
      return { ok: true, skipped: rejectedAccess ? "already-fresher" : "fresh" };
    }

    if (typeof cur.refresh !== "string" || !cur.refresh) return { ok: false, reason: "no-refresh-token" };
    const r = await requestCodexTokens(cur.refresh, { fetchImpl, log, label: "live refresh" });
    if (!r.ok) return r;
    const next = applyTokenResponse(cur, r.tokens, now());
    if (!next) return { ok: false, reason: "bad-response" };
    return finish(next, cur.refresh);
  }

  return {
    /**
     * Refresh the live login if it is due (or, with `rejectedAccess`, if that
     * token was refused and is still the one opencode holds; `force` skips the
     * expiry check). Never throws.
     * @returns {Promise<{ok:true, expiresAt?:number, skipped?:string}|{ok:false, reason:string}>}
     */
    refresh(opts = {}) {
      return singleFlight(flightKey, () => run(opts)).catch(() => ({ ok: false, reason: "error" }));
    },
  };
}

/**
 * What the usage poller calls when a Codex usage fetch answers 401: refresh the
 * login the rejected token belongs to — the LIVE login through the live
 * refresher, a seat's own directory copy through the seat refresher (both
 * single-flight per file). Debounced per login so a login that keeps 401ing for
 * some other reason is not refreshed on every fast re-poll. Never throws.
 *
 * @param {object} deps
 * @param {{refresh: Function}} deps.live
 * @param {(provider: string) => Promise<null|{seats: Array<{seatId:string, live:boolean, file:string|null}>}>} deps.seatStates
 * @param {(target: {seatId:string, file:string}) => Promise<{ok:boolean}>} deps.refreshSeat
 * @param {(file: string) => Promise<null|{access?:string, expires?:number}>} [deps.readSeatEntry]
 * @returns {(args: {adapterId:string, seatId?:string|null, rejectedToken?:string}) => Promise<{ok:boolean}>}
 */
export function createUnauthorizedHandler({
  live,
  seatStates,
  refreshSeat,
  readSeatEntry = async () => null,
  now = Date.now,
  debounceMs = 2 * 60_000,
  marginMs = CODEX_REFRESH_MARGIN_MS,
} = {}) {
  const lastAttempt = new Map();
  return async function onUnauthorized({ adapterId, seatId = null, rejectedToken = "" } = {}) {
    if (adapterId !== "codex") return { ok: false };
    try {
      let target = null;
      if (seatId) {
        const seat = (await seatStates("codex"))?.seats?.find((x) => x.seatId === seatId);
        if (!seat) return { ok: false };
        if (!seat.live) {
          if (!seat.file) return { ok: false };
          target = { seatId, file: seat.file };
        }
      }
      const key = target ? `seat:${target.file}` : "live";
      const t = now();
      if (t - (lastAttempt.get(key) ?? -Infinity) < debounceMs) return { ok: false, reason: "debounced" };

      if (!target) {
        const r = await live.refresh({ rejectedAccess: rejectedToken });
        if (!r?.skipped) lastAttempt.set(key, t);
        return r;
      }
      // A seat's own copy: skip when it already holds a different, still-valid token.
      const entry = await readSeatEntry(target.file);
      if (rejectedToken && entry && entry.access !== rejectedToken && !shouldRefreshCodexAhead(entry.expires, t, marginMs)) {
        return { ok: true, skipped: "already-fresher" };
      }
      lastAttempt.set(key, t);
      return await refreshSeat(target);
    } catch {
      return { ok: false };
    }
  };
}
