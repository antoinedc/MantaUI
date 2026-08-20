// modelCatalog.mjs — cache the provider-agnostic model catalogue on the box.
//
// BET-1241 (Automatic Manta Routing, stage 5). models.dev is opencode's own
// internal catalogue — the model list Manta already receives via `/provider`
// IS that data — but opencode exposes only the per-provider view. The
// provider-agnostic view (`https://models.dev/models.json`) answers "what *is*
// this model, wherever it is served", which is what makes an opaque provider
// alias resolvable. This module fetches and caches that view so the decision
// core can answer three questions without touching the network:
//
//   • lookupModel(catalogId) — is this exact catalogue id present?
//   • matchModel(localModelId) — which catalogue entries could this opaque
//     local id be? (exact / ambiguous / none)
//   • allModels() — the full set, for modelQuality's percentile ranking.
//
// Split deliberately: the pure matching lives in `createModelIndex` (no I/O,
// unit-testable with a fixture); `createModelCatalogController` owns the
// fetch → cache → degrade dance. The degradation contract matches the sibling
// measurement modules (modelLedger.mjs, messageSearch.mjs): a missing or
// failing catalogue NEVER throws and NEVER blanks a working cache — it serves
// the last good copy, or reports `{ supported:false }` when there has never
// been one. An absent catalogue means models are unidentifiable, which the
// eligibility gate already handles honestly; it must not fail a routing
// decision.
//
// CACHE PATH — `statePath("model-catalog.json")` resolves through
// `stateHome()`, so the test sandbox (`MANTA_STATE_HOME`) redirects writes
// away from the live box. Never build a path with `join(homedir(), …)`
// directly (see AGENTS.md "THE SUITE RUNS ON A LIVE BOX").

import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";
// The pure matching code lives in shared so the renderer's identity block and
// the server's routing core share ONE matcher (see shared/modelCatalog.mjs).
// Re-exporting keeps this module's public API (and its tests) unchanged.
export { normalize, entryHandles, createModelIndex } from "../shared/modelCatalog.mjs";

// The provider-agnostic view of models.dev. The per-provider view is already
// consumed indirectly via opencode's `/provider`; this one is not.
export const CATALOG_URL = "https://models.dev/models.json";

// Cache last-good copy to state – `statePath` lands inside the box's state
// dir (or the test sandbox when MANTA_STATE_HOME is set).
export const CACHE_PATH = statePath("model-catalog.json");

// Refresh cadence. The catalogue is opencode's own, changes rarely, and is a
// large-ish download (hundreds of models), so we poll slowly and fall back to
// the cached copy between refreshes. startPoller gives us the immediate first
// tick, the inFlight re-entrancy guard and `timer.unref()` for free.
const DEFAULT_POLL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Coercing the raw network payload to a list of entries
// ---------------------------------------------------------------------------

// models.json ships as either an array of entries (each with an `id`) or an
// object keyed by catalogue id. Handle both so an upstream format change
// doesn't silently empty the catalogue.
export function normalizePayload(payload) {
  if (Array.isArray(payload)) {
    return payload.filter(
      (e) => e !== null && typeof e === "object",
    );
  }
  if (payload !== null && typeof payload === "object") {
    return Object.entries(payload)
      .map(([id, v]) =>
        v !== null && typeof v === "object"
          ? { ...v, id: typeof v.id === "string" && v.id !== "" ? v.id : id }
          : null,
      )
      .filter((e) => e !== null);
  }
  return [];
}

// ---------------------------------------------------------------------------
// I/O: fetch → cache → degrade
// ---------------------------------------------------------------------------

/**
 * Build a model-catalogue controller: loads the last-good copy from `cachePath`
 * (empty when there is none), can `refresh()` from the network, and exposes the
 * matcher against the current catalogue.
 *
 * Degradation (never throws, never blanks a working cache):
 *   • fetch fails but a cache exists (in-memory or on disk) → serve the cache;
 *   • no cache AND fetch fails → `{ supported:false }` (empty catalogue), which
 *     `matchModel` reports as `{ kind:"none" }` and `allModels` as `[]`.
 *
 * @param {object} [opts]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @param {string} [opts.cachePath] defaults to `CACHE_PATH`
 * @param {number} [opts.intervalMs]
 */
export function createModelCatalogController({
  fetchImpl,
  cachePath = CACHE_PATH,
  intervalMs = DEFAULT_POLL_MS,
} = {}) {
  const cached = readJsonSync(cachePath, null);
  let catalog = createModelIndex(normalizePayload(cached));

  async function refresh() {
    const doFetch = fetchImpl ?? globalThis.fetch;
    try {
      const res = await doFetch(CATALOG_URL);
      if (!res || !res.ok) {
        throw new Error(`model catalog fetch failed: ${res?.status ?? "no response"}`);
      }
      const payload = await res.json();
      const next = normalizePayload(payload);
      if (next.length === 0) throw new Error("model catalog empty");
      catalog = createModelIndex(next);
      await writeJsonAtomic(cachePath, JSON.stringify(payload), { mode: 0o600 });
      return { ok: true, size: next.length };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  return {
    refresh,
    start() {
      return startPoller(refresh, { intervalMs, label: "modelCatalog" });
    },
    lookupModel: (id) => catalog.lookupModel(id),
    matchModel: (id) => catalog.matchModel(id),
    allModels: () => catalog.allModels(),
    status: () => ({ supported: catalog.size > 0, size: catalog.size }),
  };
}

// The box's own singleton. `startModelCatalogPoller` loads the cached copy and
// arms the periodic refresh; before it is called the matcher is empty
// (`{supported:false}`) — safe, honest, non-blocking.
const boxCatalog = createModelCatalogController({});

/**
 * Load the box's model catalogue and keep it fresh. Reuses `startPoller.mjs`
 * (immediate first tick, inFlight guard, `timer.unref()`). Returns `{ stop }`
 * plus the same lookup/match/allModels/status as the controller, so a caller
 * (later routing stages) can read the catalogue through one object while the
 * module-level `lookupModel`/`matchModel`/`allModels` stay in sync.
 */
export function startModelCatalogPoller(opts = {}) {
  const controller = createModelCatalogController(opts);
  const handle = controller.start();
  return {
    stop: handle.stop,
    refresh: controller.refresh,
    lookupModel: controller.lookupModel,
    matchModel: controller.matchModel,
    allModels: controller.allModels,
    status: controller.status,
  };
}

export function lookupModel(catalogId) {
  return boxCatalog.lookupModel(catalogId);
}

export function matchModel(localModelId) {
  return boxCatalog.matchModel(localModelId);
}

export function allModels() {
  return boxCatalog.allModels();
}
