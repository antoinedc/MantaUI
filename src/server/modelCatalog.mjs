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

// The provider-keyed view of models.dev. Fetched ONLY for its per-model
// `cost`, which the provider-agnostic models.json does not carry. The
// entries themselves still come from CATALOG_URL — this is a merge, never a
// source swap, because the entry ids/handles drive identity resolution.
export const CATALOG_PRICE_URL = "https://models.dev/api.json";

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
// Price map (BET-1367): models.dev api.json per-model cost, keyed by catalogue id
// ---------------------------------------------------------------------------

/**
 * PURE. Build a `Map<"<provider>/<model>", {input, output, cacheRead, cacheWrite}>`
 * price map from the models.dev api.json payload, restricted to the ids in
 * `knownIds`. Each model's `cost` object's snake-cased fields
 * (`input`/`output`/`cache_read`/`cache_write`) are canonicalised to the same
 * camel shape opencode's `_normalizePrice` produces; a value that is not a
 * finite number >= 0 becomes `undefined`, NEVER 0 (unknown and free are
 * different). Upstream `tiers` / `context_over_200k` / audio / reasoning rates
 * are deliberately DROPPED — context-tiered pricing is not modelled anywhere in
 * this codebase and a partial model would be worse than none. A model is keyed
 * by whichever of its own ids (the api.json object key, or the
 * provider-prefixed form) is present in the catalogue — never double-prefixed,
 * never re-keyed.
 */
export function buildPriceMap(payload, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set([]);
  const prices = new Map();
  const norm = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  for (const [providerId, provider] of Object.entries(payload ?? {})) {
    const models = provider && typeof provider === "object" ? provider.models : null;
    if (!models || typeof models !== "object") continue;
    for (const [modelKey, m] of Object.entries(models)) {
      if (m === null || typeof m !== "object") continue;
      const cost = m.cost && typeof m.cost === "object" ? m.cost : null;
      if (!cost) continue;
      const input = norm(cost.input);
      const output = norm(cost.output);
      const cacheRead = norm(cost.cache_read);
      const cacheWrite = norm(cost.cache_write);
      if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
        continue;
      }
      const priced = {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      };
      // Key construction is deliberately data-agnostic. api.json keys are
      // inconsistent across providers: some are already fully qualified
      // (`nvidia/llama-3.3-…`), some bare (`claude-opus-4-7` under `anthropic`),
      // some carry a different provider's prefix (`hpc-ai` → `deepseek/…`). Try
      // the object key first, then the provider-prefixed form; attach under
      // whichever of the entry's own ids is actually present in the catalogue.
      // Never double-prefix (`nvidia/nvidia/…`) and never hunt across providers.
      let key = modelKey;
      if (!known.has(key)) key = `${providerId}/${modelKey}`;
      if (!known.has(key)) continue;
      prices.set(key, priced);
    }
  }
  return prices;
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
      // BET-1367: merge the per-model cost from the provider-keyed api.json
      // into the catalogue. Non-fatal: a failed price fetch leaves the entries
      // exactly as models.json served them (today's behaviour), never blanks a
      // working catalogue. The merge is additive only — an entry that already
      // has a `cost` is never overwritten, and no entry is dropped or re-keyed.
      let priced = next;
      try {
        const pRes = await doFetch(CATALOG_PRICE_URL);
        if (pRes && pRes.ok) {
          const prices = buildPriceMap(await pRes.json(), new Set(next.map((e) => e.id)));
          if (prices.size > 0) {
            priced = next.map((e) =>
              prices.has(e.id) && !e.cost ? { ...e, cost: prices.get(e.id) } : e,
            );
          }
        }
      } catch (e) {
        console.warn("[model-catalog] price merge skipped:", e?.message ?? e);
      }
      catalog = createModelIndex(priced);
      await writeJsonAtomic(cachePath, JSON.stringify(priced), { mode: 0o600 });
      return { ok: true, size: priced.length };
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
