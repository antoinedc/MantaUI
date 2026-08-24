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
 * @property {string} label      Human label, e.g. "5h".
 * @property {number} pct        0-100, ALWAYS present. Derived when the
 *                               provider reports only absolutes.
 * @property {number} [used]     Absolute count when the provider exposes one.
 * @property {number} [limit]    Absolute cap when the provider exposes one.
 * @property {number} [resetsAt] Epoch MILLISECONDS.
 * @property {number} [startedAt] Epoch ms when this window opened. Absent when
 *   the provider does not report a window start — consumers must NOT guess a
 *   start from `resetsAt` minus an assumed window length.
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
 * @property {string} [kind]        "subscription" | "credit" — DECLARED by the
 *                                  adapter/descriptor, never inferred. A
 *                                  subscription that also reports a credit
 *                                  balance (codex) must not be priced as credit.
 * @property {UsageWindow[]} windows
 * @property {{label:string,value:string}[]} [extras]  Credits balance, model pools.
 * @property {number} [balance]    Account credit in dollars. May be NEGATIVE
 *                                 (overdrawn). Absent means *unknown*, never 0.
 * @property {number} [overagePrice] $ per unit beyond the included allowance,
 *                                 when the plan publishes one.
 * @property {boolean} [exhausted] The provider will refuse work now.
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
import { isUsageAtLimit } from "./usageStopper.mjs";
import { loadAccountReaders } from "./accountReaders.mjs";
import { loadAuthFile, DEFAULT_AUTH_PATH } from "./gatewayRegister.mjs";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { appendObservation } from "./optimizer/forecast.mjs";

export { normalizeWindow };

// The registry of built-in readers. Registry only — the engine below never
// branches on a provider name. Holds the code adapters AND the descriptor-
// backed readers (BET-1239): each descriptor in ./accountDescriptors/ becomes
// an ordinary reader with the SAME `{id, providerIDs, detect, fetch}` shape as
// the code adapters, so the engine cannot tell them apart. Growing the
// supported list is authoring one JSON file — no change here, no branch.
export const ADAPTERS = [
  claudeAdapter,
  codexAdapter,
  kimiAdapter,
  ...loadAccountReaders(),
];

// Map an opencode providerID ("anthropic" | "openai" | "kimi-for-coding") to
// its usage adapter id ("claude" | "codex" | "kimi"). The two namespaces differ
// on purpose (see the UsageSnapshot.providerIDs note); the usage-stopped
// classifier keys on the ADAPTER id, so a session's providerID must be mapped
// before it reaches the classifier / the at-limit re-check. Returns null for an
// unlisted provider (out of scope — a pay-as-you-go key).
export function adapterForProviderID(providerID) {
  if (typeof providerID !== "string") return null;
  return ADAPTERS.find((a) => Array.isArray(a.providerIDs) && a.providerIDs.includes(providerID))?.id ?? null;
}

// The reverse mapping: usage adapter id ("claude" | "codex" | "kimi") -> the
// opencode providerID it covers. The resume engine needs this to send a "Keep
// going" continuation on the pinned model: the stopped record stores the model
// by its usage ADAPTER id, but opencode's prompt injector keys the model
// override by opencode providerID + modelID, and the two namespaces differ on
// purpose (see adapterForProviderID). Each adapter covers exactly one opencode
// providerID today. Returns null for an unlisted adapter (out of scope).
export function providerIDForAdapter(adapterId) {
  if (typeof adapterId !== "string") return null;
  return ADAPTERS.find((a) => a.id === adapterId && Array.isArray(a.providerIDs) && a.providerIDs.length > 0)?.providerIDs[0] ?? null;
}

// Re-check ONE adapter's usage immediately (spec §4, signal 2), reusing the
// existing adapter fetch rather than writing a second fetch. Returns true when
// that provider is currently at its limit. Best-effort: a missing credential,
// a failed fetch or an unlisted id all resolve to false (they must never
// over-enrol from a stale/absent reading).
export async function recheckAdapterAtLimit(adapterId, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const adapter = ADAPTERS.find((a) => a.id === adapterId);
  if (!adapter) return false;
  try {
    let detected = false;
    try {
      detected = await adapter.detect({ fetchImpl, now });
    } catch {
      detected = false;
    }
    if (!detected) return false;
    const raw = await adapter.fetch({ fetchImpl, now });
    const windows = Array.isArray(raw?.windows) ? raw.windows.filter(Boolean) : [];
    return isUsageAtLimit(windows);
  } catch {
    return false;
  }
}

// Cache TTL is the poll interval; there is no separate cache layer (per spec).
const POLL_MS = 600_000; // 10 minutes
// How long after a tick that first saw an expired window we re-poll, so the
// carried-forward reading is replaced in seconds rather than up to POLL_MS.
const STALE_RETRY_MS = 20_000;
// How many CONSECUTIVE fast re-polls a waiting window may trigger. Bounded on
// purpose: a provider only publishes the replacement numbers once there is
// activity, so an idle user's window can sit past its reset instant
// indefinitely and an unbounded retry-while-stale loop would hammer a
// rate-limited endpoint forever. Three attempts covers the ordinary case in
// about a minute, then we fall back to the normal poll.
const MAX_STALE_RETRIES = 3;
// A 429 backoff is always clamped into this band. The floor exists because
// Anthropic's usage endpoint answers with `retry-after: 0` — honouring that
// literally would hot-loop the endpoint — and the ceiling exists because a
// provider asking for an hour still must not blank the dial for an hour.
// Both ends collapse the old "header present / header absent" branch into one
// expression.
export const MIN_RATE_LIMIT_BACKOFF_MS = 2 * 60_000;  // 2 minutes
export const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000; // 15 minutes
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
  // BET-1336: observation tap at the publish point — called with the published
  // UsageSnapshot[] whenever the content actually changes. Null in tests /
  // direct users → no history recording.
  observe = null,
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
  // How many consecutive fast re-polls the current waiting streak has already
  // used. Reset to 0 the moment no window is waiting, so each reset boundary
  // gets its own budget.
  let staleRetries = 0;
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
          const hasBalance = typeof raw?.balance === "number";
          // A snapshot carrying a balance and no windows is VALID — an unfunded
          // credit account (e.g. OpenRouter with total_credits: 0) must be
          // distinguishable from "not connected", and a balance-only snapshot is
          // exactly the shape `accountDescriptor` was written to support
          // (BET-1269 5g). The throw applies only to a snapshot with neither.
          if (windows.length === 0 && !hasBalance) {
            throw new Error("adapter returned zero usable windows");
          }
          results.push({
            provider: adapter.id,
            providerIDs: adapter.providerIDs,
            ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
            ...(raw.planLabel ? { planLabel: raw.planLabel } : {}),
            windows,
            ...(Array.isArray(raw.extras) && raw.extras.length > 0 ? { extras: raw.extras } : {}),
            // Carry the account-level fields through so a changed balance /
            // overage / exhausted flag lands in contentKey and actually
            // surfaces a usage.updated. (BET-1238: dropping these here would
            // make the balance read as frozen — the dial never learns it
            // moved because results is rebuilt each tick, not passed through.)
            ...(raw.balance !== undefined ? { balance: raw.balance } : {}),
            ...(raw.overagePrice !== undefined ? { overagePrice: raw.overagePrice } : {}),
            ...(raw.exhausted === true ? { exhausted: true } : {}),
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
      if (!anyStale) {
        staleRetries = 0;
        clearTimeout(staleRetry);
      } else if (staleRetries < MAX_STALE_RETRIES) {
        staleRetries += 1;
        console.log(
          `[usage] window past its reset instant — re-polling in ${staleRetryMs}ms ` +
            `(${staleRetries}/${MAX_STALE_RETRIES})`,
        );
        clearTimeout(staleRetry);
        staleRetry = setTimeout(() => void tick(), staleRetryMs);
        staleRetry?.unref?.();
      }

      snapshots = results;
      const key = contentKey(results);
      if (key !== lastContentKey) {
        lastContentKey = key;
        observe?.(results);
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
  const poller = createUsagePoller({
    publish: (evt) => bus.publish(evt),
    observe: recordWindowObservations,
  });
  activePoller = poller;
  const p = startPoller(() => poller.tick(), { intervalMs, label: "usage" });
  return {
    stop() {
      p.stop();
      poller.stop();
      if (activePoller === poller) activePoller = null;
    },
    // The resume engine reuses THIS poller to force one immediate re-check at
    // a provider's expected reset instant (BET-1048) instead of running a
    // second polling loop. Exposing the underlying tick lets a caller
    // re-fetch usage on demand; the engine is the only caller today.
    tick: () => poller.tick(),
  };
}

/** @returns {UsageSnapshot[]} */
export function listSnapshots() {
  return activePoller ? activePoller.snapshots : [];
}

// ---------------------------------------------------------------------------
// Quota-window observation history + forecast-at-reset (BET-1336, P1.4)
// ---------------------------------------------------------------------------
//
// Pure OBSERVATION — the dashboard's fuel gauges show a tick at the forecasted
// pct at the current window's reset. Nothing here paces or routes work (that
// is phase 2). The single observation tap is at the poller's publish point
// (createUsagePoller's `observe` hook — wired to `recordWindowObservations` in
// startUsagePoller below), so there is no second poller and no adapter change.
// History is persisted at `statePath("usage-history.json")` via the shared
// jsonStore atomic writer; loaded once lazily and saved on a single debounced
// 30s timer so the poll loop never hammers the disk.
const HISTORY_PATH = statePath("usage-history.json");
const HISTORY_SAVE_DEBOUNCE_MS = 30_000;

// Lazily loaded `{[key]: [{ts, pct}]}` (key = "<provider>:<window.kind>").
let usageHistory = null;
let historySaveTimer = null;

/** @returns {Record<string, Array<{ts:number, pct:number}>>} */
export function getUsageHistory() {
  if (usageHistory === null) usageHistory = readJsonSync(HISTORY_PATH, {});
  return usageHistory;
}

// One debounced 30s save timer (single timer, unref'd so it never holds the
// process open). Writing the current in-memory state is idempotent and tiny.
function scheduleHistorySave() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    const snapshot = usageHistory;
    if (snapshot == null) return;
    writeJsonAtomic(HISTORY_PATH, JSON.stringify(snapshot, null, 2)).catch((e) =>
      console.warn("[usage] history save failed:", e?.message ?? e),
    );
  }, HISTORY_SAVE_DEBOUNCE_MS);
  historySaveTimer?.unref?.();
}

/**
 * Tap the poller's publish point: record one observation per snapshot window
 * with `key = "<provider>:<window.kind>"`. Pure appendObservation handles the
 * min-interval dedupe + max-age prune; this is only the iteration + persistence
 * glue. `snapshots` is the published UsageSnapshot[].
 * @param {UsageSnapshot[]} snapshots
 */
export function recordWindowObservations(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return;
  const history = getUsageHistory();
  for (const snap of snapshots) {
    for (const w of snap.windows ?? []) {
      appendObservation(history, {
        ts: snap.fetchedAt,
        key: `${snap.provider}:${w.kind}`,
        pct: w.pct,
      });
    }
  }
  scheduleHistorySave();
}

// ---------------------------------------------------------------------------
// Live read for the deck harness (BET-1299) — the running server's poller
// ---------------------------------------------------------------------------
//
// `listSnapshots()` reads the ONE poller instance `startUsagePoller` creates in
// the running manta-server process. A separate process — the routing replay
// harness (scripts/routing/deck-a.mjs) — has no poller of its own, so its
// `listSnapshots()` is always `[]` and every priced endpoint would report a
// false `cost.basis: unknown` even though production routing prices correctly.
// This function fetches the SAME in-process cache from the live server over its
// `usage:list` RPC, so deck checks reflect production truth. Never throws and
// returns `[]` on any failure — the services contract (a missing account bag
// must never break a decision) applies identically here.

// The local binding is the direct server process (no Caddy/DNS/TLS hop) — the
// same box the deck runs on. Same default + env override as index.mjs.
function localServerBaseUrl() {
  const port = Number(process.env.MANTA_MOBILE_PORT ?? 8787);
  return `http://127.0.0.1:${port}`;
}

/**
 * Read the live server's polled usage snapshots over its `usage:list` RPC.
 * @param {{ fetchImpl?: typeof fetch, authPath?: string, baseUrl?: string }} [opts]
 * @returns {Promise<UsageSnapshot[]>}
 */
export async function listLiveSnapshots({
  fetchImpl = fetch,
  authPath = DEFAULT_AUTH_PATH,
  baseUrl = localServerBaseUrl(),
} = {}) {
  try {
    const token = loadAuthFile(authPath)?.box_token;
    if (!token) return [];
    const res = await fetchImpl(`${baseUrl}/rpc/${encodeURIComponent("usage:list")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ args: [] }),
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const snapshots = json?.result;
    return Array.isArray(snapshots) ? snapshots : [];
  } catch {
    return [];
  }
}
