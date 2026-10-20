// optimizer/prices.mjs — per-model list prices for the optimizer's trim gate
// (sticky-trims spec §3, contract C1).
//
// The optimizer plugin trims history only when the trim pays for the model in
// use, so it needs the cache-read / cache-write price of EXACTLY that model.
// This module resolves them, provider-agnostically, and normalises them to the
// C1 shape the plugin consumes.
//
// RESOLUTION for a `(providerID, modelID)` — opencode's own ids:
//   1. user-declared `provider.<p>.models.<m>.cost` in opencode.jsonc
//      (opencode's own standard; covers private/custom providers). A declared
//      record DECIDES: if it is unusable the model is unpriced — we never reach
//      past what the user declared to a catalogue number.
//   2. the models.dev provider-keyed table, from Manta's OWN price cache
//      (`statePath("model-prices.json")`, written by modelCatalog.mjs on each
//      successful api.json fetch). Ignored when older than 7 days.
//   3. otherwise unpriced.
//
// RULES (spec §3.1):
//   • Lookup is EXACT on (providerID, modelID). Never borrow another provider's
//     price for the same model — hosts differ and some don't cache.
//   • opencode's live `/provider` cost is NEVER used: it reports $0 for
//     subscription-authenticated providers, contradicting the list-price
//     assumption.
//   • A record is USABLE iff input > 0 AND cacheRead > 0. A missing/zero
//     cacheWrite means "no write premium": cacheWrite := input.
//   • tiers[] (context tiers) are authoritative; context_over_200k is used only
//     when there is no tiers[], as ONE tier at 200000. A tier applies when the
//     prompt is STRICTLY GREATER than its `minPromptTokens`; the highest
//     applying tier wins (the plugin does that — we only sort ascending). A
//     field missing from a tier inherits the base record's value. A tier that
//     is itself unusable makes the WHOLE model unpriced (fail closed: dropping
//     it would silently apply the cheaper lower-tier rate to huge prompts).
//   • 1-hour cache: `cacheWrite1h` is emitted ONLY for a model Manta configures
//     for the 1-hour cache (it is in the Anthropic-SDK target set AND its
//     opencode config carries cacheControl ttl "1h"). The record's own 1-hour
//     write price wins when present; otherwise, because that restricts the model
//     to Anthropic-SDK models, Anthropic's published 1-hour tariff of
//     2 × that level's input price is used (base and per tier, after
//     inheritance). Never inferred from an observed TTL; the 2× rule is NEVER
//     applied to a model that is not 1h-configured.
//
// Split: pure functions (testable without a box) + `createOptimizerPrices`
// (injected I/O, ~60s memo). Nothing here writes anything.

import { statePath } from "../../shared/paths.mjs";
import { selectCacheTtlTargets } from "../providers.mjs";

export const PRICES_PATH = statePath("model-prices.json");
export const PRICE_CACHE_VERSION = 1;
export const CATALOG_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const PRICES_MEMO_MS = 60_000;

// models.dev has no 1-hour write field today (verified against the cached
// api.json: cost keys are input/output/cache_read/cache_write/input_audio/
// output_audio/reasoning/tiers/context_over_200k). These names are what we
// accept if it ever appears; both are read at base and tier level.
const ONE_HOUR_KEYS = ["cache_write_1h", "cache_write_1hr"];
const OVER_200K_SIZE = 200_000;

const has = (o, k) => o !== null && typeof o === "object" && Object.hasOwn(o, k);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const rate = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

// ---------------------------------------------------------------------------
// Raw cost-record sanitising (what the price cache stores)
// ---------------------------------------------------------------------------

function sanitizeRates(c) {
  const out = {};
  for (const k of ["input", "output", "cache_read", "cache_write", ...ONE_HOUR_KEYS]) {
    const v = rate(c?.[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * PURE. Keep only the numeric fields of a raw models.dev / opencode `cost`
 * object (plus context tiers and context_over_200k). Returns null when nothing
 * usable survives. Bounds the price cache and keeps junk out of it.
 */
export function sanitizeCost(cost) {
  if (!isObj(cost)) return null;
  const out = sanitizeRates(cost);
  if (Array.isArray(cost.tiers)) {
    const tiers = [];
    for (const t of cost.tiers) {
      if (!isObj(t) || !isObj(t.tier) || t.tier.type !== "context") continue;
      const size = t.tier.size;
      if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
      tiers.push({ ...sanitizeRates(t), tier: { type: "context", size } });
    }
    if (tiers.length > 0) out.tiers = tiers;
  }
  if (isObj(cost.context_over_200k)) {
    const o = sanitizeRates(cost.context_over_200k);
    if (Object.keys(o).length > 0) out.context_over_200k = o;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * PURE. Extract `{ [providerID]: { [modelID]: sanitizedCost } }` from the
 * models.dev api.json payload, keyed EXACTLY as the payload keys them. Returns
 * null when the payload is not a usable api.json (not an object, or it yields
 * no cost record at all) — the caller must then NOT advance `fetchedAt`.
 */
export function extractPriceRecords(payload) {
  if (!isObj(payload)) return null;
  const providers = {};
  let n = 0;
  for (const [pid, provider] of Object.entries(payload)) {
    const models = isObj(provider) ? provider.models : null;
    if (!isObj(models)) continue;
    for (const [mid, m] of Object.entries(models)) {
      if (!isObj(m)) continue;
      const cost = sanitizeCost(m.cost);
      if (!cost) continue;
      (providers[pid] ??= {})[mid] = cost;
      n++;
    }
  }
  return n > 0 ? providers : null;
}

/** PURE. The persisted price-cache document. */
export function buildPriceCache(providers, fetchedAt) {
  return { version: PRICE_CACHE_VERSION, fetchedAt, providers };
}

/**
 * PURE. Validate a loaded price-cache document. Returns
 * `{ fetchedAt, providers }` or null (wrong version / shape → "no cache").
 */
export function readPriceCache(raw) {
  if (!isObj(raw) || raw.version !== PRICE_CACHE_VERSION) return null;
  if (typeof raw.fetchedAt !== "number" || !Number.isFinite(raw.fetchedAt) || raw.fetchedAt <= 0) return null;
  if (!isObj(raw.providers)) return null;
  return { fetchedAt: raw.fetchedAt, providers: raw.providers };
}

// ---------------------------------------------------------------------------
// Normalisation → the C1 shape
// ---------------------------------------------------------------------------

function pickOneHour(c) {
  for (const k of ONE_HOUR_KEYS) {
    const v = rate(c?.[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Overlay a tier's own fields over the base's (a field missing from the tier
// inherits the base value).
function overlay(c, base) {
  return {
    input: rate(c?.input) ?? base?.input,
    cacheRead: rate(c?.cache_read) ?? base?.cacheRead,
    cacheWrite: rate(c?.cache_write) ?? base?.cacheWrite,
    oneHour: pickOneHour(c) ?? base?.oneHour,
  };
}

// Finalise an overlaid rate set: usable gate, write default, 1h rule. null =
// unusable.
function finalize(r, oneHour) {
  if (!(typeof r.input === "number" && r.input > 0)) return null;
  if (!(typeof r.cacheRead === "number" && r.cacheRead > 0)) return null;
  const out = {
    input: r.input,
    cacheRead: r.cacheRead,
    cacheWrite: typeof r.cacheWrite === "number" && r.cacheWrite > 0 ? r.cacheWrite : r.input,
  };
  if (oneHour) {
    // Own 1h price wins; else Anthropic's published 1h tariff, 2 × input.
    out.cacheWrite1h = typeof r.oneHour === "number" && r.oneHour > 0 ? r.oneHour : 2 * r.input;
  }
  return out;
}

/**
 * PURE. Normalise a raw (sanitised or not) cost record to the C1 per-model
 * shape `{ input, cacheRead, cacheWrite, cacheWrite1h?, tiers? }` in $/Mtok, or
 * null when the model is unpriced for the optimizer's gate. `oneHour` = the
 * model is configured for the 1-hour cache (then `cacheWrite1h` is emitted at
 * base and in every tier: the record's own price, else 2 × that level's input).
 */
export function normalizeCostRecord(raw, { oneHour = false } = {}) {
  const cost = sanitizeCost(raw);
  if (!cost) return null;
  const base = overlay(cost, null);
  const rec = finalize(base, oneHour);
  if (!rec) return null;

  // Tiers beat context_over_200k; the latter is used only with no tiers[].
  let tierSources = [];
  if (Array.isArray(cost.tiers) && cost.tiers.length > 0) {
    tierSources = cost.tiers.map((t) => ({ size: t.tier.size, c: t }));
  } else if (isObj(cost.context_over_200k)) {
    tierSources = [{ size: OVER_200K_SIZE, c: cost.context_over_200k }];
  }
  if (tierSources.length > 0) {
    const bySize = new Map();
    for (const { size, c } of tierSources) {
      const t = finalize(overlay(c, base), oneHour);
      if (!t) return null; // fail closed: an unusable tier makes the model unpriced
      bySize.set(size, { minPromptTokens: size, ...t });
    }
    rec.tiers = [...bySize.values()].sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  }
  return rec;
}

/**
 * PURE. Resolve one model's price record (C1 shape + `source`) or null.
 * `config` is the parsed opencode.jsonc; `catalog` is the validated price cache
 * `{ fetchedAt, providers }` or null.
 */
export function resolveModelPrice({ providerID, modelID, config, catalog, now, oneHour = false }) {
  const pcfg = has(config?.provider, providerID) ? config.provider[providerID] : null;
  const mcfg = has(pcfg?.models, modelID) ? pcfg.models[modelID] : null;
  if (isObj(mcfg?.cost)) {
    const rec = normalizeCostRecord(mcfg.cost, { oneHour });
    return rec ? { ...rec, source: "config" } : null;
  }
  if (!catalog || typeof catalog.fetchedAt !== "number") return null;
  if (now - catalog.fetchedAt > CATALOG_STALE_MS) return null;
  if (!has(catalog.providers, providerID) || !has(catalog.providers[providerID], modelID)) return null;
  const rec = normalizeCostRecord(catalog.providers[providerID][modelID], { oneHour });
  return rec ? { ...rec, source: "catalog" } : null;
}

// Is this model on opencode's 1-hour cache? It must be one Manta can configure
// (Anthropic-SDK target) AND opencode's own config must carry ttl "1h" for it —
// the config is the mechanism, the box setting only the intent.
function isOneHour(config, targets, providerID, modelID) {
  if (!targets.has(`${providerID}/${modelID}`)) return false;
  const p = config?.provider;
  if (!has(p, providerID) || !has(p[providerID]?.models, modelID)) return false;
  return p[providerID].models[modelID]?.options?.cacheControl?.ttl === "1h";
}

/**
 * PURE. The C1 body plus `unpriced`:
 *   { fetchedAt, models: { "<p>/<m>": record }, unpriced: ["<p>/<m>", …] }
 * The universe is the models of CONNECTED providers (`providers.all` filtered
 * by `providers.connected`). If opencode's provider list is unavailable
 * (`all` absent) it degrades to the models declared with a `cost` in the config,
 * and `unpriced` is empty (nothing to enumerate).
 */
export function computePrices({ providers, config, catalog, now }) {
  const all = Array.isArray(providers?.all) ? providers.all : null;
  const connected = new Set(Array.isArray(providers?.connected) ? providers.connected : []);
  const targets = new Set(
    selectCacheTtlTargets({ all: all ?? [], connected: [...connected] }).map((t) => `${t.providerID}/${t.modelID}`),
  );

  const universe = [];
  if (all) {
    for (const p of all) {
      if (!p || typeof p.id !== "string" || !connected.has(p.id)) continue;
      for (const modelID of Object.keys(isObj(p.models) ? p.models : {})) {
        universe.push([p.id, modelID]);
      }
    }
  } else if (isObj(config?.provider)) {
    for (const [pid, p] of Object.entries(config.provider)) {
      for (const [mid, m] of Object.entries(isObj(p?.models) ? p.models : {})) {
        if (isObj(m?.cost)) universe.push([pid, mid]);
      }
    }
  }

  const models = {};
  const unpriced = [];
  for (const [providerID, modelID] of universe) {
    const key = `${providerID}/${modelID}`;
    const rec = resolveModelPrice({
      providerID,
      modelID,
      config,
      catalog,
      now,
      oneHour: isOneHour(config, targets, providerID, modelID),
    });
    if (rec) models[key] = rec;
    else unpriced.push(key);
  }
  unpriced.sort();
  return { fetchedAt: catalog ? catalog.fetchedAt : 0, models, unpriced };
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Memoised (~60s, in-flight guarded) price reader. All I/O is injected:
 *   listProviders() → { all, connected }  (opencode `/provider`)
 *   readConfig()    → parsed opencode.jsonc (may throw → treated as {})
 *   loadCatalog()   → the raw price-cache document (or null)
 *   now             → number | () => number
 * Returns `{ get, invalidate }`. `get()` never throws: any failure degrades to
 * an empty-but-valid body (`{fetchedAt:0, models:{}, unpriced:[]}` shape).
 */
export function createOptimizerPrices({ listProviders, readConfig, loadCatalog, now }) {
  const nowMs = () => (typeof now === "function" ? now() : (now ?? Date.now()));
  let memo = null; // { at, value }
  let inFlight = null;
  let generation = 0; // bumped by invalidate() so a stale build can't repopulate the memo

  async function build() {
    const t = nowMs();
    let providers = { connected: [] };
    try {
      providers = (await listProviders()) ?? { connected: [] };
    } catch (e) {
      console.warn("[optimizer] prices: provider list failed:", e?.message ?? e);
    }
    let config = {};
    try {
      config = (await readConfig()) ?? {};
    } catch (e) {
      console.warn("[optimizer] prices: opencode config unreadable:", e?.message ?? e);
    }
    let catalog = null;
    try {
      catalog = readPriceCache(await loadCatalog());
    } catch {
      catalog = null;
    }
    return computePrices({ providers, config, catalog, now: t });
  }

  function get() {
    const t = nowMs();
    if (memo && t - memo.at < PRICES_MEMO_MS) return Promise.resolve(memo.value);
    if (inFlight) return inFlight;
    const gen = generation;
    const p = build()
      .then((value) => {
        if (gen === generation) memo = { at: t, value };
        return value;
      })
      .catch((e) => {
        console.warn("[optimizer] prices build failed:", e?.message ?? e);
        return { fetchedAt: 0, models: {}, unpriced: [] };
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  }

  function invalidate() {
    generation++;
    memo = null;
    inFlight = null;
  }

  return { get, invalidate };
}
