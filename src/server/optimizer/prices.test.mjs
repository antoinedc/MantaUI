// optimizer/prices.test.mjs — per-model price resolution (sticky trims §3, C1).
// Pure / injected I/O only: no opencode, no real config, no state dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeCost,
  extractPriceRecords,
  buildPriceCache,
  readPriceCache,
  normalizeCostRecord,
  resolveModelPrice,
  computePrices,
  createOptimizerPrices,
  CATALOG_STALE_MS,
  PRICES_MEMO_MS,
  PRICE_CACHE_VERSION,
} from "./prices.mjs";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const catalogOf = (providers, fetchedAt = NOW - DAY) => ({ fetchedAt, providers });

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

test("normalize: usable record maps to $/Mtok camel shape; missing cacheWrite → input", () => {
  assert.deepEqual(
    normalizeCostRecord({ input: 0.091, output: 0.182, cache_read: 0.0182 }),
    { input: 0.091, cacheRead: 0.0182, cacheWrite: 0.091 },
  );
  assert.deepEqual(
    normalizeCostRecord({ input: 4, output: 20, cache_read: 0.2, cache_write: 5 }),
    { input: 4, cacheRead: 0.2, cacheWrite: 5 },
  );
  // an explicit zero write is "no premium" too
  assert.equal(normalizeCostRecord({ input: 4, output: 20, cache_read: 0.2, cache_write: 0 }).cacheWrite, 4);
});

test("normalize: zero/missing input or cacheRead → unusable (null)", () => {
  assert.equal(normalizeCostRecord({ input: 0, output: 1, cache_read: 0.1 }), null);
  assert.equal(normalizeCostRecord({ output: 1, cache_read: 0.1 }), null);
  assert.equal(normalizeCostRecord({ input: 2, output: 1 }), null, "no cache_read");
  assert.equal(normalizeCostRecord({ input: 2, output: 1, cache_read: 0 }), null, "free reads have no saving to price");
  assert.equal(normalizeCostRecord({ input: -1, output: 1, cache_read: 0.1 }), null);
  assert.equal(normalizeCostRecord(null), null);
  assert.equal(normalizeCostRecord("x"), null);
  assert.equal(normalizeCostRecord({ input: "2", cache_read: "0.2" }), null);
});

test("tiers beat context_over_200k; sorted ascending; missing tier fields inherit the base", () => {
  const rec = normalizeCostRecord({
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
    tiers: [
      { input: 8, cache_read: 0.8, tier: { type: "context", size: 400_000 } }, // cache_write inherits 2.5
      { input: 4, output: 15, cache_read: 0.4, cache_write: 5, tier: { type: "context", size: 272_000 } },
    ],
    context_over_200k: { input: 99, output: 99, cache_read: 9, cache_write: 9 },
  });
  assert.deepEqual(
    rec.tiers.map((t) => t.minPromptTokens),
    [272_000, 400_000],
  );
  assert.deepEqual(rec.tiers[0], { minPromptTokens: 272_000, input: 4, cacheRead: 0.4, cacheWrite: 5 });
  assert.deepEqual(rec.tiers[1], { minPromptTokens: 400_000, input: 8, cacheRead: 0.8, cacheWrite: 2.5 });
  assert.ok(!JSON.stringify(rec).includes("99"), "context_over_200k ignored when tiers exist");
});

test("context_over_200k becomes ONE tier at 200000 only when there are no tiers", () => {
  const rec = normalizeCostRecord({
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
    context_over_200k: { input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5 },
  });
  assert.deepEqual(rec.tiers, [{ minPromptTokens: 200_000, input: 6, cacheRead: 0.6, cacheWrite: 7.5 }]);
  assert.equal(normalizeCostRecord({ input: 3, output: 1, cache_read: 0.3 }).tiers, undefined);
});

test("an UNUSABLE tier makes the whole model unpriced (fail closed)", () => {
  assert.equal(
    normalizeCostRecord({
      input: 2,
      output: 10,
      cache_read: 0.2,
      tiers: [{ input: 4, cache_read: 0, tier: { type: "context", size: 100_000 } }],
    }),
    null,
  );
});

test("non-context tiers are ignored", () => {
  const rec = normalizeCostRecord({
    input: 2,
    output: 10,
    cache_read: 0.2,
    tiers: [{ input: 50, cache_read: 5, tier: { type: "speed", size: 1 } }],
  });
  assert.equal(rec.tiers, undefined);
});

test("1-hour: cacheWrite1h only when oneHour; own price wins, else 2 × input (base and per tier)", () => {
  const raw = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, cache_write_1h: 10 };
  // not 1h-configured → the 1h field is NOT emitted, even though the record has it
  assert.deepEqual(normalizeCostRecord(raw, { oneHour: false }), { input: 5, cacheRead: 0.5, cacheWrite: 6.25 });
  // explicit field wins over the 2× tariff (7, not 2 × 5)
  assert.deepEqual(normalizeCostRecord({ ...raw, cache_write_1h: 7 }, { oneHour: true }), {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 7,
  });
  // 1h-configured, NO 1h price → priced with Anthropic's 1h tariff, 2 × input
  const no1h = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
  assert.deepEqual(normalizeCostRecord(no1h, { oneHour: true }), {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  });
  // never applied when not 1h-configured
  assert.equal(normalizeCostRecord(no1h, { oneHour: false }).cacheWrite1h, undefined);
  // tiered, no 1h anywhere: each tier gets 2 × ITS effective input (inherited input too)
  const tiered = {
    ...no1h,
    tiers: [
      { input: 10, cache_read: 1, tier: { type: "context", size: 200_000 } },
      { cache_read: 2, tier: { type: "context", size: 500_000 } }, // inherits base input 5
    ],
  };
  const rec = normalizeCostRecord(tiered, { oneHour: true });
  assert.equal(rec.cacheWrite1h, 10);
  assert.equal(rec.tiers[0].cacheWrite1h, 20);
  assert.equal(rec.tiers[1].cacheWrite1h, 10);
  assert.equal(normalizeCostRecord(tiered, { oneHour: false }).tiers[0].cacheWrite1h, undefined);
  // a base 1h price is inherited by a tier that has none of its own; a tier's own price wins
  const tiered1h = {
    ...raw,
    tiers: [
      { input: 10, cache_read: 1, tier: { type: "context", size: 200_000 } },
      { input: 12, cache_read: 2, cache_write_1h: 99, tier: { type: "context", size: 500_000 } },
    ],
  };
  const rec1h = normalizeCostRecord(tiered1h, { oneHour: true });
  assert.equal(rec1h.tiers[0].cacheWrite1h, 10, "inherited from base");
  assert.equal(rec1h.tiers[1].cacheWrite1h, 99, "tier's own wins");
});

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

const OPUS = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 };

test("resolve: config cost beats the catalogue", () => {
  const config = { provider: { anthropic: { models: { "claude-opus-5-5": { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } } } };
  const catalog = catalogOf({ anthropic: { "claude-opus-5-5": OPUS } });
  const r = resolveModelPrice({ providerID: "anthropic", modelID: "claude-opus-5-5", config, catalog, now: NOW });
  assert.equal(r.source, "config");
  assert.equal(r.input, 1);
});

test("resolve: a declared-but-unusable config cost DECIDES — it never falls back to the catalogue", () => {
  const config = { provider: { anthropic: { models: { "claude-opus-5-5": { cost: { input: 1, output: 2 } } } } } };
  const catalog = catalogOf({ anthropic: { "claude-opus-5-5": OPUS } });
  assert.equal(resolveModelPrice({ providerID: "anthropic", modelID: "claude-opus-5-5", config, catalog, now: NOW }), null);
});

test("resolve: catalogue is exact on (providerID, modelID) — never borrows another provider's price", () => {
  const catalog = catalogOf({
    anthropic: { "claude-opus-5-5": OPUS },
    openrouter: { "anthropic/claude-opus-5-5": { input: 99, output: 99, cache_read: 9 } },
  });
  // another host serving the same model: no record under THAT provider → unpriced
  assert.equal(resolveModelPrice({ providerID: "bedrock", modelID: "claude-opus-5-5", config: {}, catalog, now: NOW }), null);
  // a bare model id under a provider that only has the qualified key → unpriced
  assert.equal(resolveModelPrice({ providerID: "openrouter", modelID: "claude-opus-5-5", config: {}, catalog, now: NOW }), null);
  const r = resolveModelPrice({ providerID: "openrouter", modelID: "anthropic/claude-opus-5-5", config: {}, catalog, now: NOW });
  assert.equal(r.input, 99);
  assert.equal(r.source, "catalog");
});

test("resolve: a stale catalogue (> 7 days) is treated as absent; config still works", () => {
  const stale = catalogOf({ anthropic: { m: OPUS } }, NOW - CATALOG_STALE_MS - 1);
  assert.equal(resolveModelPrice({ providerID: "anthropic", modelID: "m", config: {}, catalog: stale, now: NOW }), null);
  const edge = catalogOf({ anthropic: { m: OPUS } }, NOW - CATALOG_STALE_MS);
  assert.ok(resolveModelPrice({ providerID: "anthropic", modelID: "m", config: {}, catalog: edge, now: NOW }));
  const config = { provider: { anthropic: { models: { m: { cost: { input: 1, output: 2, cache_read: 0.1 } } } } } };
  assert.equal(resolveModelPrice({ providerID: "anthropic", modelID: "m", config, catalog: stale, now: NOW }).source, "config");
  assert.equal(resolveModelPrice({ providerID: "anthropic", modelID: "m", config: {}, catalog: null, now: NOW }), null);
});

test("resolve: prototype-ish ids never resolve through inherited properties", () => {
  const catalog = catalogOf({ anthropic: { m: OPUS } });
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(resolveModelPrice({ providerID: id, modelID: "m", config: {}, catalog, now: NOW }), null);
    assert.equal(resolveModelPrice({ providerID: "anthropic", modelID: id, config: {}, catalog, now: NOW }), null);
  }
});

// ---------------------------------------------------------------------------
// price-cache extraction / validation
// ---------------------------------------------------------------------------

test("sanitizeCost keeps only finite non-negative numbers + context tiers; null when nothing survives", () => {
  assert.equal(sanitizeCost({ input: "x", output: -1 }), null);
  assert.equal(sanitizeCost(null), null);
  assert.deepEqual(
    sanitizeCost({
      input: 2,
      output: 10,
      cache_read: 0.2,
      junk: "x",
      reasoning: 9,
      tiers: [{ input: 4, tier: { type: "context", size: 272000 } }, { input: 1 }, { tier: { type: "context", size: -5 } }],
    }),
    { input: 2, output: 10, cache_read: 0.2, tiers: [{ input: 4, tier: { type: "context", size: 272000 } }] },
  );
});

test("extractPriceRecords: provider-keyed, exact keys; null for garbage / no records", () => {
  const out = extractPriceRecords({
    openai: { models: { "gpt-6-sol": { cost: OPUS }, nocost: { name: "x" } } },
    openrouter: { models: { "deepseek/deepseek-v4-flash": { cost: { input: 0.091, output: 0.182, cache_read: 0.0182 } } } },
    junk: "nope",
    empty: { models: {} },
  });
  assert.deepEqual(Object.keys(out).sort(), ["openai", "openrouter"]);
  assert.deepEqual(Object.keys(out.openrouter), ["deepseek/deepseek-v4-flash"]);
  assert.equal(extractPriceRecords(null), null);
  assert.equal(extractPriceRecords([]), null);
  assert.equal(extractPriceRecords({ a: { models: {} } }), null);
  assert.equal(extractPriceRecords("x"), null);
});

test("price cache document: versioned; readPriceCache rejects wrong version / shape", () => {
  const doc = buildPriceCache({ a: { m: OPUS } }, NOW);
  assert.equal(doc.version, PRICE_CACHE_VERSION);
  assert.deepEqual(readPriceCache(doc), { fetchedAt: NOW, providers: { a: { m: OPUS } } });
  assert.equal(readPriceCache({ ...doc, version: 2 }), null);
  assert.equal(readPriceCache({ ...doc, fetchedAt: 0 }), null);
  assert.equal(readPriceCache({ ...doc, providers: [] }), null);
  assert.equal(readPriceCache(null), null);
  assert.equal(readPriceCache([]), null);
});

// ---------------------------------------------------------------------------
// computePrices (the C1 body + unpriced)
// ---------------------------------------------------------------------------

function provider(id, models, npm) {
  return {
    id,
    models: Object.fromEntries(models.map((m) => [m, { id: m, api: npm ? { npm } : {} }])),
  };
}

test("computePrices: connected models only; priced vs unpriced split; fetchedAt from the catalogue", () => {
  const providers = {
    connected: ["anthropic", "openai"],
    all: [
      provider("anthropic", ["claude-opus-5-5", "no-price"], "@ai-sdk/anthropic"),
      provider("openai", ["gpt-6-sol"]),
      provider("not-connected", ["x"]),
    ],
  };
  const catalog = catalogOf({
    anthropic: { "claude-opus-5-5": OPUS },
    openai: { "gpt-6-sol": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, tiers: [{ input: 4, output: 15, cache_read: 0.4, cache_write: 5, tier: { type: "context", size: 272000 } }], context_over_200k: { input: 4, output: 15, cache_read: 0.4, cache_write: 5 } } },
    "not-connected": { x: OPUS },
  }, NOW - 1000);
  const out = computePrices({ providers, config: {}, catalog, now: NOW });
  assert.equal(out.fetchedAt, NOW - 1000);
  assert.deepEqual(Object.keys(out.models).sort(), ["anthropic/claude-opus-5-5", "openai/gpt-6-sol"]);
  assert.deepEqual(out.unpriced, ["anthropic/no-price"]);
  assert.equal(out.models["openai/gpt-6-sol"].tiers.length, 1, "tiers beat context_over_200k");
  assert.equal(out.models["openai/gpt-6-sol"].source, "catalog");
});

test("computePrices: a 1h-configured Anthropic-SDK model without a 1h price is priced with 2 × input; 5m-configured gets no 1h field", () => {
  const providers = {
    connected: ["anthropic"],
    all: [provider("anthropic", ["opus-1h", "opus-5m"], "@ai-sdk/anthropic")],
  };
  const catalog = catalogOf({ anthropic: { "opus-1h": OPUS, "opus-5m": OPUS } });
  const config = { provider: { anthropic: { models: { "opus-1h": { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } } } } } };
  const out = computePrices({ providers, config, catalog, now: NOW });
  assert.deepEqual(Object.keys(out.models).sort(), ["anthropic/opus-1h", "anthropic/opus-5m"]);
  assert.deepEqual(out.unpriced, []);
  assert.equal(out.models["anthropic/opus-1h"].cacheWrite1h, 8, "2 × input (4)");
  assert.equal(out.models["anthropic/opus-5m"].cacheWrite1h, undefined, "5m-configured never carries a 1h price");

  // a 1h price in the catalogue wins over the 2× tariff
  const catalog1h = catalogOf({ anthropic: { "opus-1h": { ...OPUS, cache_write_1h: 9 }, "opus-5m": { ...OPUS, cache_write_1h: 9 } } });
  const out2 = computePrices({ providers, config, catalog: catalog1h, now: NOW });
  assert.equal(out2.models["anthropic/opus-1h"].cacheWrite1h, 9);
  assert.equal(out2.models["anthropic/opus-5m"].cacheWrite1h, undefined, "5m-configured never carries a 1h price");
});

test("computePrices: a cacheControl 1h on a NON-Anthropic-SDK model is a stray option — not 1h", () => {
  const providers = { connected: ["openai"], all: [provider("openai", ["m"], "@ai-sdk/openai")] };
  const catalog = catalogOf({ openai: { m: OPUS } });
  const config = { provider: { openai: { models: { m: { options: { cacheControl: { ttl: "1h" } } } } } } };
  const out = computePrices({ providers, config, catalog, now: NOW });
  assert.ok(out.models["openai/m"]);
});

test("computePrices: an unpriced model never appears in models (so the plugin cannot grow for it)", () => {
  const providers = { connected: ["local"], all: [provider("local", ["private"])] };
  const out = computePrices({ providers, config: {}, catalog: null, now: NOW });
  assert.deepEqual(out.models, {});
  assert.deepEqual(out.unpriced, ["local/private"]);
  assert.equal(out.fetchedAt, 0);
});

test("computePrices: config-declared cost prices a custom model; opencode's own /provider cost is never consulted", () => {
  const providers = {
    connected: ["local"],
    all: [{ id: "local", models: { private: { id: "private", cost: { input: 0, output: 0, cache_read: 0 } } } }],
  };
  const config = { provider: { local: { models: { private: { cost: { input: 1, output: 3, cache_read: 0.1, cache_write: 1.2 } } } } } };
  const out = computePrices({ providers, config, catalog: null, now: NOW });
  assert.deepEqual(out.models["local/private"], { input: 1, cacheRead: 0.1, cacheWrite: 1.2, source: "config" });
  // and with no declared cost, the live /provider $0 does NOT make it priced
  const out2 = computePrices({ providers, config: {}, catalog: null, now: NOW });
  assert.deepEqual(out2.models, {});
});

test("computePrices: when opencode's provider list is unavailable, degrades to config-declared models", () => {
  const config = { provider: { local: { models: { a: { cost: { input: 1, output: 2, cache_read: 0.1 } }, b: {} } } } };
  const out = computePrices({ providers: { connected: [] }, config, catalog: null, now: NOW });
  assert.deepEqual(Object.keys(out.models), ["local/a"]);
  assert.deepEqual(out.unpriced, []);
});

// ---------------------------------------------------------------------------
// memoised wrapper
// ---------------------------------------------------------------------------

function wrapper(overrides = {}) {
  let t = NOW;
  const calls = { providers: 0, config: 0, catalog: 0 };
  const api = createOptimizerPrices({
    listProviders: async () => {
      calls.providers++;
      return { connected: ["anthropic"], all: [provider("anthropic", ["m"])] };
    },
    readConfig: async () => {
      calls.config++;
      return {};
    },
    loadCatalog: async () => {
      calls.catalog++;
      return buildPriceCache({ anthropic: { m: OPUS } }, NOW);
    },
    now: () => t,
    ...overrides,
  });
  return { api, calls, advance: (ms) => (t += ms) };
}

test("createOptimizerPrices: memoises for ~60s, rebuilds after, invalidate() drops the memo", async () => {
  const { api, calls, advance } = wrapper();
  const a = await api.get();
  assert.ok(a.models["anthropic/m"]);
  await api.get();
  assert.equal(calls.providers, 1, "memo hit");
  advance(PRICES_MEMO_MS - 1);
  await api.get();
  assert.equal(calls.providers, 1);
  advance(2);
  await api.get();
  assert.equal(calls.providers, 2, "expired");
  api.invalidate();
  await api.get();
  assert.equal(calls.providers, 3, "invalidated");
});

test("createOptimizerPrices: concurrent callers share one build", async () => {
  const { api, calls } = wrapper();
  await Promise.all([api.get(), api.get(), api.get()]);
  assert.equal(calls.providers, 1);
});

test("createOptimizerPrices: invalidate() during a build stops the stale result repopulating the memo", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let n = 0;
  const { api } = wrapper({
    listProviders: async () => {
      n++;
      if (n === 1) await gate;
      return { connected: ["anthropic"], all: [provider("anthropic", ["m"])] };
    },
  });
  const first = api.get();
  api.invalidate();
  release();
  await first;
  await api.get();
  assert.equal(n, 2, "the stale build did not populate the memo");
});

test("createOptimizerPrices: failures degrade, never throw (provider list / config / catalogue)", async () => {
  const { api } = wrapper({
    listProviders: async () => {
      throw new Error("opencode down");
    },
    readConfig: async () => {
      throw new Error("unparseable");
    },
    loadCatalog: async () => {
      throw new Error("disk");
    },
  });
  const out = await api.get();
  assert.deepEqual(out, { fetchedAt: 0, models: {}, unpriced: [] });
});

test("createOptimizerPrices: a config edit is picked up after invalidate (set-model-cost → source:config)", async () => {
  let cfg = {};
  const { api } = wrapper({ readConfig: async () => cfg });
  assert.equal((await api.get()).models["anthropic/m"].source, "catalog");
  cfg = { provider: { anthropic: { models: { m: { cost: { input: 1, output: 2, cache_read: 0.1 } } } } } };
  api.invalidate();
  assert.equal((await api.get()).models["anthropic/m"].source, "config");
});
