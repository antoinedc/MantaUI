// pricing.mjs — the budget's price source: LIST prices ($ per million tokens, input AND
// output) of every model of the connected providers, from the same resolution the
// optimizer uses (opencode.jsonc `cost` → Manta's models.dev price cache → the
// model's own cost). The optimizer's trim table (`optimizer/prices.mjs` `computePrices`)
// is cache-gate shaped and has no output price, so the budget reads `resolveListPrice`.
//
// deps: listProviders() → {all, connected}, readConfig(), loadCatalog() → the raw price cache.
// Memoised ~60 s; `get()` never throws (an empty table means "unpriced", which the budget
// charges at the dearest known rate).

import { readPriceCache, resolveListPrice } from "../optimizer/prices.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function createListPrices({ listProviders, readConfig, loadCatalog, now = Date.now, memoMs = 60_000 } = {}) {
  let memo = null;
  let inFlight = null;
  async function build() {
    let providers = { all: [], connected: [] };
    try {
      providers = (await listProviders?.()) ?? providers;
    } catch {
      /* unpriced */
    }
    let config = {};
    try {
      config = (await readConfig?.()) ?? {};
    } catch {
      config = {};
    }
    let catalog = null;
    try {
      catalog = readPriceCache(await loadCatalog?.());
    } catch {
      catalog = null;
    }
    const connected = new Set(Array.isArray(providers.connected) ? providers.connected : []);
    const models = {};
    for (const p of Array.isArray(providers.all) ? providers.all : []) {
      if (!p || typeof p.id !== "string" || !connected.has(p.id)) continue;
      for (const [modelID, m] of Object.entries(isObj(p.models) ? p.models : {})) {
        const rec = resolveListPrice({ providerID: p.id, modelID, config, catalog, model: m });
        if (rec && rec.input > 0 && rec.output > 0) models[`${p.id}/${modelID}`] = { input: rec.input, output: rec.output, cacheWrite: rec.cacheWrite };
      }
    }
    return { models };
  }
  return {
    async get() {
      const t = now();
      if (memo && t - memo.at < memoMs) return memo.value;
      inFlight ??= build()
        .then((value) => {
          memo = { at: t, value };
          return value;
        })
        .catch(() => ({ models: {} }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    invalidate() {
      memo = null;
    },
  };
}
