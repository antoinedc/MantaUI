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
// Re-exporting keeps this module's public API (and its tests) unchanged, and
// the local import is what the controller below calls.
import { createModelIndex } from "../shared/modelCatalog.mjs";
export { normalize, entryHandles, createModelIndex } from "../shared/modelCatalog.mjs";

// The provider-agnostic view of models.dev. The per-provider view is already
// consumed indirectly via opencode's `/provider`; this one is not.
export const CATALOG_URL = "https://models.dev/models.json";

// The litellm price ledger — the catalogue's companion (~¥3.2k models, each
// with per-token $ figures). models.dev identities the models; this file prices
// them. Fetched alongside the catalogue and merged in `refresh()` so routing's
// implausible-zero reference can price every priced model even when the
// per-provider view (the box's own endpoints) quotes 0/0.
export const CATALOG_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

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
// Price map (BET-1367): litellm's per-token $ figures, keyed by model id
// ---------------------------------------------------------------------------

// Convert the litellm price payload ($/token, keyed by model id) into a
// $/Mtok price map. Direct input/output figures map to `input`/`output`; the
// cache-read rate maps to `cacheRead` (the cache-creation / write rate is
// deliberately dropped — the blended blend never prices it). Per-token figures
// are scaled ×1000 to Mtok to match every other rate in the box. Pure: a
// single pass, no I/O; models with no usable price are omitted entirely.
export function buildPriceMap(payload) {
  const prices = {};
  const scale = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1000 : undefined;
  for (const e of normalizePayload(payload)) {
    if (typeof e?.id !== "string" || e.id === "") continue;
    const input = scale(e.input_cost_per_token);
    const output = scale(e.output_cost_per_token);
    const cacheRead = scale(e.cache_read_input_token_cost);
    if (input === undefined && output === undefined && cacheRead === undefined) continue;
    prices[e.id] = {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
    };
  }
  return prices;
}

// Merge a price map into a catalogue entry list by exact model id: for every
// entry whose id is priced, fold the price's `input`/`output`/`cacheRead` into
// the entry's `cost`, keeping any cost fields the entry already had. Entries
// with no matching price (and ids only in the map, not the catalogue) are left
// untouched. PURE — returns a NEW array, never mutates the input.
export function mergePriceMap(entries, priceMap) {
  const map = priceMap && typeof priceMap === "object" ? priceMap : {};
  return (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e || typeof e !== "object") return e;
    const price = map[e.id];
    if (!price || typeof price !== "object") return e;
    const cost = { ...(e.cost && typeof e.cost === "object" ? e.cost : {}) };
    let wrote = false;
    for (const key of ["input", "output", "cacheRead"]) {
      if (typeof price[key] === "number" && Number.isFinite(price[key])) {
        cost[key] = price[key];
        wrote = true;
      }
    }
    return wrote ? { ...e, cost } : e;
  });
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
 * @param {typeof globalThis.fetch} [opts.priceFetchImpl] defaults to `fetchImpl`;
 *   a separate stub lets price-fetch failures be exercised without failing the
 *   catalogue itself
 * @param {string} [opts.cachePath] defaults to `CACHE_PATH`
 * @param {number} [opts.intervalMs]
 */
export function createModelCatalogController({
  fetchImpl,
  cachePath = CACHE_PATH,
  intervalMs = DEFAULT_POLL_MS,
  priceFetchImpl,
} = {}) {
  const cached = readJsonSync(cachePath, null);
  let catalog = createModelIndex(normalizePayload(cached));

  async function refresh() {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const doPriceFetch = priceFetchImpl ?? doFetch;
    try {
      const res = await doFetch(CATALOG_URL);
      if (!res || !res.ok) {
        throw new Error(`model catalog fetch failed: ${res?.status ?? "no response"}`);
      }
      const payload = await res.json();
      let next = normalizePayload(payload);
      if (next.length === 0) throw new Error("model catalog empty");
      // BET-1367: fetch the litellm price ledger and merge the matching
      // entries' input/output/cacheRead ($/Mtok) into the catalogue so routing
      // can price every priced model. A price-fetch failure is NON-fatal — the
      // catalogue itself is still good; the models just go unpriced.
      try {
        const priceRes = await doPriceFetch(CATALOG_PRICE_URL);
        if (priceRes && priceRes.ok) {
          const merged = mergePriceMap(next, buildPriceMap(await priceRes.json()));
          if (merged.length > 0) next = merged;
        }
      } catch {
        /* no prices → the catalogue stands alone */
      }
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

// The box's own singleton. There is exactly ONE catalogue on the box;
// `opencode:model-catalog` and the module-level lookup/match/allModels read
// it, and `startModelCatalogPoller` is what keeps IT fresh. (It used to build
// a second, unrelated controller — the BET-1272 defect that left the singleton
// empty forever on a first boot that predated the cache file, so the RPC
// reported `{supported:false}` while the cache on disk held hundreds of
// entries.) Before the poller starts the matcher reflects whatever is cached
// on disk at import; a never-populated box reports `{supported:false}` — safe,
// honest, non-blocking.
const boxCatalog = createModelCatalogController({});

/**
 * Load the box's model catalogue and keep it fresh. Starts the module-level
 * singleton and returns handles onto it. Reuses `startPoller.mjs` (immediate
 * first tick, inFlight guard, `timer.unref()`). Returns `{ stop }` plus the
 * same lookup/match/allModels/status as the controller, so a caller can read
 * the catalogue through one object while the module-level
 * `lookupModel`/`matchModel`/`allModels` stay in sync — they all read
 * `boxCatalog`.
 */
export function startModelCatalogPoller(opts = {}) {
  void opts;
  const handle = boxCatalog.start();
  return {
    stop: handle.stop,
    refresh: boxCatalog.refresh,
    lookupModel: boxCatalog.lookupModel,
    matchModel: boxCatalog.matchModel,
    allModels: boxCatalog.allModels,
    status: boxCatalog.status,
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
