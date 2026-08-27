// modelCatalog.test.mjs — unit tests for the box-side model catalogue.
//
// Pure matching runs against a checked-in fixture (a trimmed subset of
// models.json), never the network. The I/O tests stub `fetchImpl` and point
// each controller at its own `cachePath` inside MANTA_STATE_HOME, so a fetch
// failure / cache-hit exercise writes nothing outside the sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { stateHome, statePath } from "../shared/paths.mjs";
import {
  CACHE_PATH,
  normalize,
  normalizePayload,
  createModelIndex,
  createModelCatalogController,
  startModelCatalogPoller,
  lookupModel,
  matchModel,
  allModels,
  buildPriceMap,
} from "./modelCatalog.mjs";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/modelCatalog.fixture.json", import.meta.url), "utf-8"),
);

// A minimal fetch stub: `ok`/`status` control the response contract, `json`
// the body. Enough for refresh() without a network connection.
function stubFetch({ ok = true, status = 200, body = FIXTURE } = {}) {
  return async () => ({ ok, status, json: async () => body });
}

function failingFetch(message = "boom") {
  return async () => {
    throw new Error(message);
  };
}

const ORNITH_SIZES = ["9B", "31B", "35B", "397B"];

// ---------------------------------------------------------------------------
// Pure matching — driven by the three real cases from the issue
// ---------------------------------------------------------------------------

test("matchModel resolves an opaque local id to its exact catalogue entry", () => {
  const index = createModelIndex(FIXTURE);
  const res = index.matchModel("qwen3.6-27b");
  assert.equal(res.kind, "exact");
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].id, "qwen/qwen3.6-27b");
});

test("matchModel returns every same-family size rather than guessing (ambiguous)", () => {
  const index = createModelIndex(FIXTURE);
  const res = index.matchModel("ornith");
  assert.equal(res.kind, "ambiguous");
  const ids = res.candidates.map((e) => e.id).sort();
  assert.equal(ids.length, ORNITH_SIZES.length);
  for (const size of ORNITH_SIZES) {
    assert.ok(res.candidates.some((e) => e.name === `Ornith ${size}`), `missing Ornith ${size}`);
  }
  // Deliberately not collapsed to one candidate despite the size gap.
  assert.deepEqual(
    res.candidates.map((e) => e.family),
    Array(ORNITH_SIZES.length).fill("ornith"),
  );
});

test("matchModel reports none for a meaningless identifier", () => {
  const index = createModelIndex(FIXTURE);
  assert.deepEqual(index.matchModel("default"), { kind: "none", candidates: [] });
  // An unmatchable id behaves the same as the unsupported-catalogue case.
  assert.deepEqual(index.matchModel("not-a-real-model"), { kind: "none", candidates: [] });
});

test("matchModel is case-insensitive and normalises separators", () => {
  const index = createModelIndex(FIXTURE);
  assert.equal(index.matchModel("Qwen3.6-27B").kind, "exact");
  assert.equal(index.matchModel("qwen3-6_27b").kind, "exact");
  assert.equal(index.matchModel("qwen3.6 27b").kind, "exact");
  assert.equal(index.matchModel("ORNITH").kind, "ambiguous");
});

test("lookupModel finds a catalogue id, exact and normalised", () => {
  const index = createModelIndex(FIXTURE);
  assert.equal(index.lookupModel("minimax/MiniMax-M3")?.id, "minimax/MiniMax-M3");
  // Case/separator differences still resolve to the same entry.
  assert.equal(index.lookupModel("Minimax/minimax-m3")?.id, "minimax/MiniMax-M3");
  assert.equal(index.lookupModel("deepseek/deepseek-chat")?.id, "deepseek/deepseek-chat");
  assert.equal(index.lookupModel("does/not-exist"), null);
});

test("allModels returns the full catalogue and does not hand out the internal list", () => {
  const index = createModelIndex(FIXTURE);
  const all = index.allModels();
  assert.equal(all.length, FIXTURE.length);
  all.push({ id: "mutated" });
  assert.equal(index.allModels().length, FIXTURE.length, "mutation must not leak");
});

test("normalize collapses separators and case", () => {
  assert.equal(normalize("Qwen3.6-27B"), "qwen3-6-27b");
  assert.equal(normalize("qwen3.6_27b"), "qwen3-6-27b");
  // The `/` separator is preserved (BET-1303 5.1) so the vendor/model boundary
  // survives — this behaviour was the bug the old flattening encoded.
  assert.equal(normalize("minimax/MiniMax-M3"), "minimax/minimax-m3");
  assert.equal(normalize(" default "), "default");
});

test("normalizePayload accepts both the array and the id-keyed-object shape", () => {
  assert.equal(normalizePayload(FIXTURE).length, FIXTURE.length);
  const asObject = Object.fromEntries(FIXTURE.map((e) => [e.id, e]));
  const fromObject = normalizePayload(asObject);
  assert.equal(fromObject.length, FIXTURE.length);
  assert.ok(fromObject.every((e) => typeof e.id === "string"));
  // Preserves the id when the object value already carries one.
  assert.equal(normalizePayload({ "x/y": { ...FIXTURE[0], id: "override/id" } })[0].id, "override/id");
  // Garbage → empty, never throws.
  assert.deepEqual(normalizePayload(null), []);
  assert.deepEqual(normalizePayload("nope"), []);
});

// ---------------------------------------------------------------------------
// BET-1367: the price map (buildPriceMap) and its merge in refresh()
// ---------------------------------------------------------------------------

// A fetch stub that serves the catalogue from `catBody` and the price ledger
// from `priceBody` (differentiated by the api.json URL), so a merge test can
// drive each fetch independently without a network connection.
function stagedFetch({ catBody = FIXTURE, priceBody, priceOk = true } = {}) {
  return async (url) => {
    if (String(url).includes("api.json")) {
      return { ok: priceOk, status: priceOk ? 200 : 500, json: async () => priceBody };
    }
    return { ok: true, status: 200, json: async () => catBody };
  };
}

// Mirrors the REAL api.json shape: per-model fields live under `cost`, and the
// models object keys are INCONSISTENT across providers — `qwen`/`anthropic` use
// bare keys (`qwen3.6-27b`, `claude-opus-4-7`), while `hpc-ai` keys its
// deepseek models with an already-qualified id (`deepseek/…`). Neither field
// placement nor key convention can be assumed.
const PRICE_PAYLOAD = {
  qwen: {
    models: {
      "qwen3.6-27b": { cost: { input: 0.002, output: 0.006, cache_read: 0.001, cache_write: 0.00125 } },
    },
  },
  anthropic: {
    models: {
      "claude-opus-4-7": { cost: { input: 5, output: 25 } },
    },
  },
  // Already-qualified object key: must join as `deepseek/deepseek-v4-flash`,
  // never double-prefixed to `hpc-ai/deepseek/…`.
  "hpc-ai": {
    models: {
      "deepseek/deepseek-v4-flash": { cost: { input: 0.003 } },
    },
  },
  min: {
    models: {
      "neg-rate": { cost: { input: -1, output: 2 } }, // negative → undefined, never 0
      "non-num": { cost: { input: "x", output: 1 } },
      "tiered": { cost: { input: 2 }, tiers: { "1k": { input: 0.1 } }, context_over_200k: { input: 0.1 } },
    },
  },
};

test("buildPriceMap joins bare and already-qualified api.json keys, pruning to knownIds", () => {
  const map = buildPriceMap(PRICE_PAYLOAD, new Set([
    "qwen/qwen3.6-27b", // bare object key → provider-prefixed form
    "anthropic/claude-opus-4-7", // bare object key → provider-prefixed form
    "deepseek/deepseek-v4-flash", // already-qualified object key → as-is
  ]));
  assert.deepEqual(map.get("qwen/qwen3.6-27b"), {
    input: 0.002,
    output: 0.006,
    cacheRead: 0.001,
    cacheWrite: 0.00125,
  });
  assert.deepEqual(map.get("anthropic/claude-opus-4-7"), { input: 5, output: 25 });
  // An already-qualified object key is never double-prefixed or re-keyed.
  assert.deepEqual(map.get("deepseek/deepseek-v4-flash"), { input: 0.003 });
  assert.equal(map.get("hpc-ai/deepseek/deepseek-v4-flash"), undefined);
  assert.equal(map.get("hpc-ai/deepseek-v4-flash"), undefined);
  // A knownId with no matching provider/model is simply absent.
  assert.equal(map.has("minimax/MiniMax-M3"), false);
});

test("buildPriceMap drops tiers/context and maps unknown rates to undefined (never 0)", () => {
  const map = buildPriceMap(PRICE_PAYLOAD, new Set(["min/neg-rate", "min/non-num", "min/tiered"]));
  // Negative and non-numeric rates become undefined and are omitted, never 0.
  assert.deepEqual(map.get("min/neg-rate"), { output: 2 });
  assert.deepEqual(map.get("min/non-num"), { output: 1 });
  // tiers / context_over_200k rates are deliberately dropped.
  assert.deepEqual(map.get("min/tiered"), { input: 2 });
});

test("buildPriceMap empty payload yields an empty map", () => {
  assert.equal(buildPriceMap({}, new Set(["a/b"])).size, 0);
  assert.equal(buildPriceMap(null, new Set(["a/b"])).size, 0);
  assert.equal(buildPriceMap({ qwen: { models: {} } }, new Set(["qwen/x"])).size, 0);
});

test("refresh merges catalogue prices and never drops/re-keys entries", async () => {
  const cachePath = statePath("model-catalog.test-priced.json");
  const ctl = createModelCatalogController({
    fetchImpl: stagedFetch({ priceBody: PRICE_PAYLOAD }),
    cachePath,
  });
  const res = await ctl.refresh();
  assert.equal(res.ok, true);
  assert.equal(res.size, FIXTURE.length);
  // The qwen entry picked up its cost; ids and count are unchanged.
  const pricedEntry = ctl.lookupModel("qwen/qwen3.6-27b");
  assert.deepEqual(pricedEntry.cost, { input: 0.002, output: 0.006, cacheRead: 0.001, cacheWrite: 0.00125 });
  assert.equal(ctl.allModels().length, FIXTURE.length);
  assert.equal(ctl.lookupModel("minimax/MiniMax-M3").cost, undefined);
});

test("refresh does not overwrite an entry that already has a cost", async () => {
  const catBody = FIXTURE.map((e) =>
    e.id === "qwen/qwen3.6-27b" ? { ...e, cost: { input: 9, output: 9 } } : e,
  );
  const cachePath = statePath("model-catalog.test-preexisting.json");
  const ctl = createModelCatalogController({
    fetchImpl: stagedFetch({ catBody, priceBody: PRICE_PAYLOAD }),
    cachePath,
  });
  const res = await ctl.refresh();
  assert.equal(res.ok, true);
  assert.deepEqual(ctl.lookupModel("qwen/qwen3.6-27b").cost, { input: 9, output: 9 });
});

test("a failing price fetch leaves entries byte-identical to the models.json result", async () => {
  const cachePath = statePath("model-catalog.test-pricefail.json");
  const ctl = createModelCatalogController({
    fetchImpl: stagedFetch({ priceBody: PRICE_PAYLOAD, priceOk: false }),
    cachePath,
  });
  const res = await ctl.refresh();
  assert.equal(res.ok, true);
  assert.equal(res.size, FIXTURE.length);
  // Deep equality against the pristine fixture — the price-fetch failure must
  // not touch a single entry (this is the regression that matters).
  assert.deepEqual(ctl.allModels(), FIXTURE);
});

// ---------------------------------------------------------------------------
// I/O: refresh → cache → degrade
// ---------------------------------------------------------------------------

test("a successful refresh serves the catalogue and writes a cache copy", async () => {
  const cachePath = statePath("model-catalog.test-success.json");
  const ctl = createModelCatalogController({ fetchImpl: stubFetch(), cachePath });
  const res = await ctl.refresh();
  assert.equal(res.ok, true);
  assert.equal(res.size, FIXTURE.length);
  assert.equal(ctl.status().supported, true);
  assert.equal(ctl.matchModel("ornith").kind, "ambiguous");
  // The last-good copy is on disk for the next boot.
  const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.equal(onDisk.length, FIXTURE.length);
});

test("a failed fetch degrades to the last good cached copy", async () => {
  const cachePath = statePath("model-catalog.test-cache.json");
  // Seed the cache the way a prior successful boot would have.
  const { writeJsonAtomic } = await import("./jsonStore.mjs");
  await writeJsonAtomic(cachePath, JSON.stringify(FIXTURE), { mode: 0o600 });

  const ctl = createModelCatalogController({ fetchImpl: failingFetch(), cachePath });
  assert.equal(ctl.status().supported, true, "cache is served before any refresh");
  const res = await ctl.refresh();
  assert.equal(res.ok, false);
  // The cache is intact and the matcher still answers.
  assert.equal(ctl.status().supported, true);
  assert.equal(ctl.matchModel("qwen3.6-27b").kind, "exact");
  assert.equal(ctl.matchModel("ornith").kind, "ambiguous");
});

test("no cache + failed fetch → { supported:false }, never throws", async () => {
  const cachePath = statePath("model-catalog.test-none.json"); // does not exist
  const ctl = createModelCatalogController({ fetchImpl: failingFetch(), cachePath });
  assert.equal(ctl.status().supported, false);
  const res = await ctl.refresh();
  assert.equal(res.ok, false);
  assert.equal(ctl.status().supported, false);
  assert.deepEqual(ctl.allModels(), []);
  assert.deepEqual(ctl.matchModel("anything"), { kind: "none", candidates: [] });
});

test("a failed refresh never blanks a catalogue already held in memory", async () => {
  const cachePath = statePath("model-catalog.test-blank.json");
  const ok = createModelCatalogController({ fetchImpl: stubFetch(), cachePath });
  await ok.refresh();
  assert.equal(ok.status().supported, true);
  // Flip the catalogue's source to a failing fetch on the SAME cache path:
  // the in-memory catalogue must survive a later failed refresh.
  const ctl = createModelCatalogController({ fetchImpl: failingFetch(), cachePath });
  assert.equal(ctl.status().supported, true, "booted from the on-disk copy");
  const res = await ctl.refresh();
  assert.equal(res.ok, false);
  assert.equal(ctl.status().supported, true, "failed refresh keeps the good copy");
  assert.equal(ctl.matchModel("ornith").kind, "ambiguous");
});

test("a poller refresh is visible through the module-level allModels() — ONE catalogue (BET-1272)", async () => {
  // Regression: startModelCatalogPoller used to build a SECOND, unrelated
  // controller, so the module-level allModels() (which `opencode:model-catalog`
  // reads) never saw a refresh on a first boot that predated the cache file —
  // the box reported `{supported:false}` while the cache on disk held hundreds
  // of entries. The poller must start the module's OWN singleton, so a fresh
  // fetch on the box must be visible through the module-level API.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  const poller = startModelCatalogPoller();
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (allModels().length === FIXTURE.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      allModels().length,
      FIXTURE.length,
      "module-level allModels must reflect the poller's refresh",
    );
    assert.equal(matchModel("qwen3.6-27b").kind, "exact");
    assert.equal(lookupModel("minimax/MiniMax-M3")?.id, "minimax/MiniMax-M3");
  } finally {
    poller.stop();
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Sandbox canary — the cache path must resolve INSIDE MANTA_STATE_HOME
// ---------------------------------------------------------------------------

test("the catalogue cache path resolves inside the state sandbox", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  assert.ok(sandbox && sandbox.trim() !== "", "MANTA_STATE_HOME must be set");
  assert.equal(stateHome(), sandbox);
  assert.ok(
    CACHE_PATH.startsWith(sandbox + sep),
    `cache path resolved to ${CACHE_PATH}, outside the sandbox ${sandbox}`,
  );
  assert.ok(statePath("model-catalog.json").startsWith(sandbox + sep));
});
