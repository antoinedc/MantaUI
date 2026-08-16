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
 * @property {boolean} [stale] True when this reading describes a window whose
 *   reset instant has already passed: the provider has not published the new
 *   window's numbers yet, so `pct` still belongs to the window that just
 *   ended. Set by the poller (this module), never by an adapter. Consumers
 *   must not raise an alert from a stale window; the dial carries the last
 *   reading forward and labels it "resetting…" rather than blanking.
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
const POLL_MS = 600_000; // 10 minutes
// How long after a tick that first saw an expired window we re-poll, so the
// carried-forward reading is replaced in seconds rather than up to POLL_MS.
const STALE_RETRY_MS = 20_000;
// A 429 backoff is always clamped into this band. The floor exists because
// Anthropic's usage endpoint answers with `retry-after: 0` — honouring that
// literally would hot-loop the endpoint — and the ceiling exists because a
// provider asking for an hour still must not blank the dial for an hour.
// Both ends collapse the old "header present / header absent" branch into one
// expression.
const MIN_RATE_LIMIT_BACKOFF_MS = 2 * 60_000;  // 2 minutes
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000; // 15 minutes
// How long a snapshot may be carried forward across failed/backed-off ticks
// before it is dropped. Sits above the stale-warning threshold the popover
// uses, so a carried reading visibly ages into a warning before it disappears.
const MAX_CARRY_FORWARD_MS = 30 * 60_000; // 30 minutes

/**
 * Strip `fetchedAt` for the "did anything actually change" comparison — a
 * fresh fetch always has a new timestamp, so comparing the full object would
 * publish on every tick regardless of content, defeating the whole point of
 * the dedupe (BET-737 spec: "only when the serialized snapshot set actually
 * changed... a poller that republishes an identical payload every 10 minutes
 * wakes every connected client for nothing").
 */
function contentKey(results) {
  return JSON.stringify(results.map(({ fetchedAt, ...rest }) => rest));
}

/**
 * Clamp a provider's requested retry delay into the supported band. A missing
 * or non-finite value is treated as 0 and therefore lands on the floor — the
 * "no header" and "retry-after: 0" cases are deliberately the SAME case, which
 * is what lets the caller drop its ternary.
 * @param {number|undefined} retryAfterMs
 * @returns {number}
 */
export function rateLimitBackoffMs(retryAfterMs) {
  const ms = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, ms));
}

/**
 * The previous tick's snapshot for `adapterId`, if it is young enough to keep
 * showing. Returns the SAME object reference on purpose: an unchanged
 * contentKey is what keeps a failed tick off the bus entirely.
 * @param {UsageSnapshot[]} prevSnapshots
 * @param {string} adapterId
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @returns {UsageSnapshot | null}
 */
export function carryForward(prevSnapshots, adapterId, nowMs, maxAgeMs = MAX_CARRY_FORWARD_MS) {
  const prev = (prevSnapshots ?? []).find((s) => s.provider === adapterId);
  if (!prev) return null;
  return nowMs - prev.fetchedAt > maxAgeMs ? null : prev;
}

/**
 * @param {object} [opts]
 * @param {UsageAdapter[]} [opts.adapters]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {(evt: {kind:string, payload:object}) => void} [opts.publish]
 * @param {number} [opts.staleRetryMs]
 * @returns {{ tick: () => Promise<void>, stop: () => void, snapshots: UsageSnapshot[] }}
 */
export function createUsagePoller({
  adapters = ADAPTERS,
  fetchImpl = fetch,
  now = () => Date.now(),
  publish,
  staleRetryMs = STALE_RETRY_MS,
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
  // Whether the PREVIOUS tick saw an expired window — the fast re-poll is
  // armed on the false->true edge only (see the header note on why a
  // retry-while-stale loop would never terminate for an idle user).
  let hadStale = false;
  let staleRetry = null;

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
        if (until != null && nowMs < until) {
          const carried = carryForward(snapshots, adapter.id, nowMs);
          if (carried) results.push(carried);
          continue; // still backed off
        }

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
          // A throw, a non-2xx, or zero usable windows: carry the previous
          // reading forward so a transient failure doesn't blank the dial
          // (visually indistinguishable from "this plan has no limits"). The
          // SAME object reference keeps contentKey unchanged, so a failed
          // tick publishes nothing.
          if (e?.status === 429) {
            backoffUntil.set(adapter.id, nowMs + rateLimitBackoffMs(e.retryAfterMs));
          }
          warnOnce(adapter.id, e);
          const carried = carryForward(snapshots, adapter.id, nowMs);
          if (carried) results.push(carried);
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
      // A window whose reset instant has passed is reporting the OLD window's
      // numbers. Flag it rather than dropping it — the dial carries the last
      // reading forward — and never let it drive an alert downstream.
      let anyStale = false;
      for (const snap of results) {
        for (const w of snap.windows) {
          if (w.resetsAt != null && w.resetsAt <= nowMs) {
            w.stale = true;
            anyStale = true;
          }
        }
      }
      if (anyStale && !hadStale) {
        console.log(`[usage] window past its reset instant — re-polling in ${staleRetryMs}ms`);
        clearTimeout(staleRetry);
        staleRetry = setTimeout(() => void tick(), staleRetryMs);
        staleRetry?.unref?.();
      }
      hadStale = anyStale;

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
      clearTimeout(staleRetry);
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
