// accountsEvents.mjs — the accounts bus events (multi-account spec §8, "Bus").
//
//   accounts.updated {provider}                               — the list changed
//   accounts.moved   {sessionId, provider, from, to, fromLabel, toLabel, reason,
//                     trigger, crossOrg}                       — the resolver moved a conversation
//                     (reason "load"|"exhausted"|"unusable"; trigger {kind,pct}|null)
//
// `accounts.updated` fires from many places (a store write, an assignment being
// placed, a usage reading landing), and a burst of new conversations would
// otherwise flood every connected client with refetches. So it is THROTTLED to
// at most one per provider per second — leading edge first (the first change is
// announced at once), and a change that lands inside the window is announced
// once when the window ends (a trailing edge), never dropped.
//
// `accounts.moved` is rare and each one matters to the conversation it names, so
// it is never throttled or merged.

export const UPDATE_MIN_INTERVAL_MS = 1000;

/**
 * @param {object} deps
 * @param {(evt: {kind: string, payload: object}) => void} deps.publish  the bus publisher
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {number} [deps.minIntervalMs]
 */
export function createAccountsEvents({
  publish,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  minIntervalMs = UPDATE_MIN_INTERVAL_MS,
}) {
  /** provider → {lastAt: number, timer: unknown|null} */
  const state = new Map();

  function fire(provider, entry) {
    entry.lastAt = now();
    entry.timer = null;
    try {
      publish({ kind: "accounts.updated", payload: { provider } });
    } catch {
      // a bus subscriber failing must never break the caller
    }
  }

  /** Announce that `provider`'s list changed (throttled). */
  function updated(provider) {
    if (typeof provider !== "string" || !provider) return;
    let entry = state.get(provider);
    if (!entry) {
      entry = { lastAt: -Infinity, timer: null };
      state.set(provider, entry);
    }
    if (entry.timer) return; // a trailing announcement is already scheduled
    const wait = entry.lastAt + minIntervalMs - now();
    if (wait <= 0) {
      fire(provider, entry);
      return;
    }
    entry.timer = setTimer(() => fire(provider, entry), wait);
  }

  /** Announce a move (immediate). */
  function moved(evt) {
    try {
      publish({
        kind: "accounts.moved",
        payload: {
          sessionId: evt.sessionId,
          provider: evt.provider,
          from: evt.from,
          to: evt.to,
          reason: evt.reason,
          fromLabel: evt.fromLabel ?? evt.from,
          toLabel: evt.toLabel ?? evt.to,
          trigger: evt.trigger ?? null,
          crossOrg: evt.crossOrg === true,
        },
      });
    } catch {
      // as above
    }
  }

  return { updated, moved };
}
