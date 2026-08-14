// usage.mjs — subscription plan usage engine (BET-737).
//
// Polls each registered provider adapter (src/server/usageAdapters/) for its
// current rolling-5h + weekly plan usage and publishes a normalized
// UsageSnapshot[] on the bus, so the renderer (BET-USAGE-B: dial + popover)
// can show it without ever polling a provider itself. Mirrors
// src/server/delegate.mjs / src/server/capabilities.mjs: pure decision logic
// + injected I/O, no top-level side effects, an in-flight-guarded poller with
// timer.unref() so it never holds the process open.
//
// THIS IS NOT THE CONTEXT-WINDOW INDICATOR. Context % is per-conversation
// (SessionHeader.tsx ContextPill) and already exists; this engine is
// per-SUBSCRIPTION plan usage. Never share code, colour scale, or placement
// with the context pill — that's a hard boundary from the design spec.
//
// One code path: this file never branches on a provider name. Each adapter
// (claude.mjs / codex.mjs / kimi.mjs) is ~80 lines implementing the same
// `{id, providerIDs, detect(), fetch()}` shape; the only thing they share is
// normalizeWindow (usageAdapters/normalizeWindow.mjs), the one place a raw
// provider window becomes a UsageWindow. Adding a fourth provider is one new
// adapter file — zero changes here.
//
// Frozen types (JSDoc typedefs — this repo's server modules are `.mjs`, no
// `.d.ts`). BET-USAGE-B/C import `UsageSnapshot`/`UsageWindow` from
// src/shared/types.ts (the TS mirror of this shape), not from here.
//
/**
 * @typedef {Object} UsageWindow
 * @property {"session"|"weekly"|string} kind  Open set — a provider with a
 *   daily window works with no engine change.
 * @property {string} label      Human label, e.g. "Session (5h)".
 * @property {number} pct        0-100, ALWAYS present. Derived when the
 *                               provider reports only absolutes.
 * @property {number} [used]     Absolute count when the provider exposes one.
 * @property {number} [limit]    Absolute cap when the provider exposes one.
 * @property {number} [resetsAt] Epoch MILLISECONDS.
 * @property {boolean} [binding] The provider says this window bites first.
 */
/**
 * @typedef {Object} UsageSnapshot
 * @property {string} provider      Adapter id: "claude" | "codex" | "kimi".
 * @property {string[]} providerIDs opencode providerIDs this snapshot covers
 *                                  (copied verbatim from the adapter's own
 *                                  `providerIDs` — see UsageAdapter below).
 *                                  BET-USAGE-B matches the renderer's active
 *                                  model to a snapshot through THIS field, not
 *                                  `provider` — the adapter id ("claude") and
 *                                  opencode's providerID ("anthropic") are
 *                                  different namespaces on purpose (adapter id
 *                                  is this engine's registry key; providerID is
 *                                  opencode's), so a name-equality match would
 *                                  silently fail for every adapter.
 * @property {string} [planLabel]   "Max 20x", "Pro", "Allegretto".
 * @property {UsageWindow[]} windows
 * @property {{label:string,value:string}[]} [extras]  Credits balance, model pools.
 * @property {number} fetchedAt     Epoch ms of the successful fetch.
 */
/**
 * @typedef {Object} UsageAdapter
 * @property {string} id
 * @property {string[]} providerIDs  opencode providerIDs this adapter covers,
 *                                   used by the renderer to match the active
 *                                   model to a snapshot.
 * @property {(deps?: object) => Promise<boolean>} detect  Is the credential present?
 * @property {(deps?: object) => Promise<Omit<UsageSnapshot,"fetchedAt">>} fetch
 */

import { normalizeWindow } from "./usageAdapters/normalizeWindow.mjs";
import { startPoller } from "./startPoller.mjs";
import { claudeAdapter } from "./usageAdapters/claude.mjs";
import { codexAdapter } from "./usageAdapters/codex.mjs";
import { kimiAdapter } from "./usageAdapters/kimi.mjs";

export { normalizeWindow };

// The registry of built-in adapters. Registry only — the engine below never
// branches on a provider name.
export const ADAPTERS = [claudeAdapter, codexAdapter, kimiAdapter];

// Cache TTL is the poll interval; there is no separate cache layer (per spec).
const POLL_MS = 180_000; // 3 minutes
// Default per-adapter backoff on a bare 429 (no usable Retry-After).
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000; // 15 minutes

/**
 * Strip `fetchedAt` for the "did anything actually change" comparison — a
 * fresh fetch always has a new timestamp, so comparing the full object would
 * publish on every tick regardless of content, defeating the whole point of
 * the dedupe (BET-737 spec: "only when the serialized snapshot set actually
 * changed... a poller that republishes an identical payload every 3 minutes
 * wakes every connected client for nothing").
 */
function contentKey(results) {
  return JSON.stringify(results.map(({ fetchedAt, ...rest }) => rest));
}

/**
 * @param {object} [opts]
 * @param {UsageAdapter[]} [opts.adapters]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {(evt: {kind:string, payload:object}) => void} [opts.publish]
 * @returns {{ tick: () => Promise<void>, stop: () => void, snapshots: UsageSnapshot[] }}
 */
export function createUsagePoller({
  adapters = ADAPTERS,
  fetchImpl = fetch,
  now = () => Date.now(),
  publish,
} = {}) {
  let snapshots = [];
  let lastContentKey = null;
  let inFlight = false;
  let stopped = false;
  // Per-adapter 429 backoff state — NOT global. adapterId -> epoch ms until
  // which this adapter's fetch is skipped entirely.
  const backoffUntil = new Map();
  // Which adapters are CURRENTLY in a failing streak, so we warn once per
  // failure TRANSITION rather than once per tick while a provider stays
  // broken.
  const failing = new Set();

  function warnOnce(adapterId, e) {
    if (failing.has(adapterId)) return;
    failing.add(adapterId);
    console.warn(`[usage] adapter "${adapterId}" failed:`, e?.message ?? e);
  }

  async function tick() {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const nowMs = now();
      const results = [];

      for (const adapter of adapters) {
        const until = backoffUntil.get(adapter.id);
        if (until != null && nowMs < until) continue; // still backed off

        let detected = false;
        try {
          detected = await adapter.detect({ fetchImpl, now });
        } catch (e) {
          // detect() must never throw out of the tick either.
          warnOnce(adapter.id, e);
          continue;
        }
        if (!detected) {
          // No credential — not a failure. Skip, ensure no snapshot for it.
          failing.delete(adapter.id);
          backoffUntil.delete(adapter.id);
          continue;
        }

        try {
          const raw = await adapter.fetch({ fetchImpl, now });
          const windows = Array.isArray(raw?.windows) ? raw.windows.filter(Boolean) : [];
          if (windows.length === 0) {
            throw new Error("adapter returned zero usable windows");
          }
          results.push({
            provider: adapter.id,
            providerIDs: adapter.providerIDs,
            ...(raw.planLabel ? { planLabel: raw.planLabel } : {}),
            windows,
            ...(Array.isArray(raw.extras) && raw.extras.length > 0 ? { extras: raw.extras } : {}),
            fetchedAt: nowMs,
          });
          backoffUntil.delete(adapter.id);
          failing.delete(adapter.id);
        } catch (e) {
          // Quarantined: a throw, a non-2xx, or zero usable windows removes
          // this provider's snapshot for the tick and never affects another
          // adapter.
          if (e?.status === 429) {
            const retryMs =
              typeof e.retryAfterMs === "number" && e.retryAfterMs > 0
                ? e.retryAfterMs
                : DEFAULT_RATE_LIMIT_BACKOFF_MS;
            backoffUntil.set(adapter.id, nowMs + retryMs);
          }
          warnOnce(adapter.id, e);
        }
      }

      if (stopped) return;

      // `fetchedAt` means "epoch ms of the successful fetch" (the frozen
      // typedef, mirrored verbatim into shared/types.ts) — so `snapshots`
      // is replaced on EVERY tick, unconditionally, even when the content is
      // identical to last time. Reviewer Block (cycle 1): freezing snapshots
      // on a content-identical tick silently repurposed fetchedAt into
      // "when the numbers last changed", which left `usage:list` reporting
      // an arbitrarily stale timestamp for a perfectly healthy poller — the
      // one thing a usage dial needs to tell "fresh, unchanged" apart from
      // "poller is dead". The dedupe rule from the issue only governs the
      // BUS PUBLISH ("publish … only when the serialized snapshot set
      // actually changed") — it says nothing about the cache, so gating only
      // the publish call below satisfies both with no trade-off.
      snapshots = results;
      const key = contentKey(results);
      if (key !== lastContentKey) {
        lastContentKey = key;
        publish?.({ kind: "usage.updated", payload: { snapshots: results } });
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    stop() {
      stopped = true;
    },
    get snapshots() {
      return snapshots;
    },
  };
}

// ---------------------------------------------------------------------------
// Wired entry point (src/server/index.mjs) + the read side of the RPC channel
// ---------------------------------------------------------------------------
//
// The poller's state is an in-memory cache (the cache TTL IS the poll
// interval — no separate cache layer, no disk store), so unlike
// schedule.mjs/capabilities.mjs there is no `load()` for the RPC handler to
// call. `listSnapshots()` reads the ONE poller instance `startUsagePoller`
// creates in production; `usage.test.mjs` never touches it — it exercises
// `createUsagePoller` directly with injected deps.

let activePoller = null;

/**
 * @param {{ publish: (evt: object) => void }} bus
 * @param {{ intervalMs?: number }} [opts]
 * @returns {{ stop: () => void }}
 */
export function startUsagePoller(bus, { intervalMs = POLL_MS } = {}) {
  const poller = createUsagePoller({ publish: (evt) => bus.publish(evt) });
  activePoller = poller;
  const p = startPoller(() => poller.tick(), { intervalMs, label: "usage" });
  return {
    stop() {
      p.stop();
      poller.stop();
      if (activePoller === poller) activePoller = null;
    },
  };
}

/** @returns {UsageSnapshot[]} */
export function listSnapshots() {
  return activePoller ? activePoller.snapshots : [];
}
