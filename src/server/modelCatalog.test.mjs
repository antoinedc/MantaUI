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
  assert.equal(normalize("minimax/MiniMax-M3"), "minimax-minimax-m3");
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

test("startModelCatalogPoller reuses startPoller: immediate tick populates the catalogue", async () => {
  const cachePath = statePath("model-catalog.test-poller.json");
  const poller = startModelCatalogPoller({ fetchImpl: stubFetch(), cachePath });
  try {
    // Immediate first tick is async; bounded-wait until it has landed.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (poller.status().supported) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(poller.status().supported, true);
    assert.equal(poller.matchModel("qwen3.6-27b").kind, "exact");
    assert.equal(poller.lookupModel("minimax/MiniMax-M3")?.id, "minimax/MiniMax-M3");
  } finally {
    poller.stop();
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
