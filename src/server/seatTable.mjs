// seatTable.mjs — the seat table: the last `accounts.seatStates(provider)` answer
// per provider, kept in memory so a placement lookup is a memory read
// (docs/superpowers/specs/2026-11-12-claude-seat-routing.md §3.1).
//
// WHY. `seatStates` re-reads every seat file and, once a minute, runs discovery
// (which can call Anthropic's profile API). Running that on the request path made
// the seat answer slower than the plugin's budget, so new conversations fell back
// to a dead login. The table moves all of it to the background:
//
//   rebuilt at startup · every SEAT_TABLE_REFRESH_MS · right after an accounts
//   store change / a seat refresh outcome / forgetSeat (callers `invalidate()`)
//   · after a best-effort recursive fs.watch event on the seats root (debounced).
//
// Rebuilds are single-flight: a request for a rebuild while one is running queues
// ONE more (it must see state that changed after the running one started), never
// a pile. A rebuild that fails keeps the previous table and warns once per streak.
//
// Pure of the accounts module: it is handed `readStates(provider)`; timers, the
// watcher and the logger are injectable, so tests never sleep or touch the disk.

import { watch as fsWatch } from "node:fs";

/** The background rebuild cadence — the guarantee behind the best-effort watcher. */
export const SEAT_TABLE_REFRESH_MS = 10_000;
/** How long `resolve` waits for the FIRST build before answering "warming". */
export const SEAT_TABLE_FIRST_BUILD_WAIT_MS = 3_000;
/** fs.watch events within this long of each other cause one rebuild. */
export const SEAT_TABLE_WATCH_DEBOUNCE_MS = 250;

/** Real timers that never keep the process alive. */
export const realTimers = {
  set(fn, ms) {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clear(h) {
    clearTimeout(h);
  },
};

/**
 * @param {object} deps
 * @param {(provider: string) => Promise<object|null>} deps.readStates  `accounts.seatStates`
 * @param {string[]} [deps.providers]
 * @param {string|null} [deps.watchRoot]  the seats root to watch (null → no watcher)
 * @param {typeof fsWatch} [deps.watch]
 * @param {{set: (fn: Function, ms: number) => any, clear: (h: any) => void}} [deps.timers]
 * @param {number} [deps.refreshMs]
 * @param {number} [deps.watchDebounceMs]
 * @param {{warn?: Function}} [deps.log]
 */
export function createSeatTable({
  readStates,
  providers = ["claude", "codex"],
  watchRoot = null,
  watch = fsWatch,
  timers = realTimers,
  refreshMs = SEAT_TABLE_REFRESH_MS,
  watchDebounceMs = SEAT_TABLE_WATCH_DEBOUNCE_MS,
  log = console,
} = /** @type {any} */ ({})) {
  /** @type {Map<string, {states: object|null}>} */
  const entries = new Map();
  let inflight = null;
  let queued = null;
  let started = false;
  let periodic = null;
  let watcher = null;
  let watchTimer = null;
  let failing = false;
  let watchWarned = false;
  /** @type {Array<{provider: string, resolve: (ok: boolean) => void, timer: any}>} */
  let waiters = [];

  async function buildOnce() {
    let allOk = true;
    await Promise.all(
      providers.map(async (provider) => {
        try {
          entries.set(provider, { states: (await readStates(provider)) ?? null });
        } catch (e) {
          allOk = false;
          if (!failing) log.warn?.(`[seat-table] rebuild for ${provider} failed (keeping the previous table):`, e?.message ?? e);
        }
      }),
    );
    failing = !allOk;
    settleWaiters();
  }

  function settleWaiters() {
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      timers.clear(w.timer);
      w.resolve(entries.has(w.provider));
    }
  }

  /**
   * Rebuild now (single-flight). Resolves when a build that STARTED after this
   * call has finished. Never rejects.
   * @returns {Promise<void>}
   */
  function rebuild() {
    if (!inflight) {
      inflight = buildOnce().finally(() => {
        inflight = null;
      });
      return inflight;
    }
    if (!queued) {
      queued = inflight.then(() => {
        queued = null;
        return rebuild();
      });
    }
    return queued;
  }

  /** Schedule a rebuild without waiting for it. */
  function invalidate(_reason = "") {
    void rebuild();
  }

  function armPeriodic() {
    if (!started) return;
    periodic = timers.set(() => {
      periodic = null;
      startWatcher();
      void rebuild().finally(armPeriodic);
    }, refreshMs);
  }

  function startWatcher() {
    if (!watchRoot || watcher || !started) return;
    try {
      const w = watch(watchRoot, { recursive: true }, (_event, filename) => {
        // Atomic writes leave temp siblings behind for an instant; the final rename is the event that matters.
        if (typeof filename === "string" && filename.includes(".tmp-")) return;
        if (watchTimer) timers.clear(watchTimer);
        watchTimer = timers.set(() => {
          watchTimer = null;
          invalidate("fs-watch");
        }, watchDebounceMs);
      });
      w.on?.("error", (e) => {
        if (!watchWarned) log.warn?.("[seat-table] watching the seats directory stopped; the periodic rebuild still runs:", e?.message ?? e);
        watchWarned = true;
        try {
          w.close?.();
        } catch {
          /* already closed */
        }
        if (watcher === w) watcher = null;
      });
      w.unref?.();
      watcher = w;
    } catch (e) {
      if (!watchWarned) log.warn?.("[seat-table] cannot watch the seats directory; the periodic rebuild still runs:", e?.message ?? e);
      watchWarned = true;
    }
  }

  return {
    /** The last states for a provider (the `accounts.seatStates` shape), or null. Synchronous. */
    get(provider) {
      return entries.get(provider)?.states ?? null;
    },
    /** Has a build for this provider finished (successfully) at least once? */
    has(provider) {
      return entries.has(provider);
    },
    /**
     * Wait for the FIRST build of a provider, at most `timeoutMs`. Resolves true
     * as soon as it is available (immediately when it already is), false on a
     * timeout or when the build that just finished could not produce it.
     * Starts a build when none has ever run.
     * @returns {Promise<boolean>}
     */
    ready(provider, timeoutMs = SEAT_TABLE_FIRST_BUILD_WAIT_MS) {
      if (entries.has(provider)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { provider, resolve, timer: null };
        w.timer = timers.set(() => {
          waiters = waiters.filter((x) => x !== w);
          resolve(entries.has(provider));
        }, timeoutMs);
        waiters.push(w);
        if (!inflight) void rebuild();
      });
    },
    invalidate,
    rebuild,
    /** Begin the background life: first build, periodic rebuilds, the fs watcher. */
    start() {
      if (started) return;
      started = true;
      startWatcher();
      void rebuild().finally(armPeriodic);
    },
    stop() {
      started = false;
      if (periodic) timers.clear(periodic);
      if (watchTimer) timers.clear(watchTimer);
      periodic = watchTimer = null;
      try {
        watcher?.close?.();
      } catch {
        /* already closed */
      }
      watcher = null;
    },
  };
}
