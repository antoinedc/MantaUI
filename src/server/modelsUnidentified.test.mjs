import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModelIndex } from "./modelCatalog.mjs";
import { describeMissing } from "../shared/autoEligibility.mjs";
import {
  buildUnidentifiedRows,
  unidentifiedList,
  buildDeclaration,
  mergeDeclared,
  createModelsUnidentified,
  INTRO,
  FOOTER,
  UNAVAILABLE_TEXT,
} from "./modelsUnidentified.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/modelCatalog.fixture.json", import.meta.url), "utf-8"));
const catalog = createModelIndex(FIXTURE);
const emptyCatalog = createModelIndex([]);

// An endpoint serving a catalogue model under its own name, with no price/caching facts.
const qwen = { providerID: "custom", id: "qwen3.6-27b", name: "qwen3.6-27b", limit: { context: 131072 } };
const ornith = { providerID: "custom", id: "ornith", name: "ornith" };
const opaque = { providerID: "custom", id: "zzz-unknown", name: "zzz-unknown" };
// Fully described: catalogue-known identity, price + cache rates reported by the endpoint.
const described = {
  providerID: "custom",
  id: "qwen3.6-27b",
  name: "q",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};

describe("describeMissing (moved)", () => {
  test("0 / 1 / 2 / 4 keys + unknown keys", () => {
    assert.equal(describeMissing([]), null);
    assert.equal(describeMissing(["bogus"]), null);
    assert.equal(describeMissing(["price"]), "what it costs");
    assert.equal(describeMissing(["identity", "caching"]), "which model, and whether it caches");
    assert.equal(
      describeMissing(["identity", "price", "caching", "quality"]),
      "which model, what it costs, whether it caches, and how it compares",
    );
    assert.equal(describeMissing(["identity", "bogus", "price"]), "which model, and what it costs");
  });
});

describe("buildUnidentifiedRows", () => {
  test("a fully described endpoint is not listed", () => {
    assert.deepEqual(buildUnidentifiedRows({ models: [described], declared: {}, catalog }), []);
  });

  test("exact (certain): 'Matched automatically' + what Auto still needs; only 'change'", () => {
    const [row] = buildUnidentifiedRows({ models: [qwen], declared: {}, catalog });
    assert.equal(row.state, "exact");
    assert.equal(row.confidence, "certain");
    assert.equal(row.label, "custom / qwen3.6-27b");
    assert.equal(row.catalogId, "qwen/qwen3.6-27b");
    assert.deepEqual(row.missing, ["price", "caching"]);
    assert.match(row.help, /^Matched automatically → Qwen3\.6-27B/);
    assert.match(row.help, / — Auto still needs: what it costs, and whether it caches$/);
    assert.deepEqual(row.actions, ["change"]);
    assert.equal(row.match.id, "qwen/qwen3.6-27b");
    assert.equal(row.match.context, 131072);
  });

  test("exact probable: 'We think this is …' with evidence; confirm + change", () => {
    const probableCatalog = {
      lookupModel: catalog.lookupModel,
      allModels: catalog.allModels,
      matchModel: () => ({
        kind: "exact",
        candidates: [catalog.lookupModel("qwen/qwen3.6-27b")],
        confidence: "probable",
        evidence: "same context window",
      }),
    };
    const [row] = buildUnidentifiedRows({ models: [opaque], declared: {}, catalog: probableCatalog });
    assert.equal(row.confidence, "probable");
    assert.match(row.help, /^We think this is Qwen3\.6-27B — same context window — Auto still needs: /);
    assert.deepEqual(row.actions, ["confirm", "change"]);
  });

  test("ambiguous: candidates in matcher order, chips when ≤ 4, help counts candidates", () => {
    const [row] = buildUnidentifiedRows({ models: [ornith], declared: {}, catalog });
    assert.equal(row.state, "ambiguous");
    assert.equal(row.candidates.length, 4);
    assert.equal(row.chips, true);
    assert.deepEqual(row.actions, ["pick"]);
    assert.match(row.help, /^4 models share this name — which one is it\?/);
    assert.ok(row.candidates.every((c) => c.id && c.name));
  });

  test("ambiguous with more than 4 candidates → no chips (client shows the form)", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `x/m${i}`, name: `M${i}` }));
    const c = {
      lookupModel: (id) => many.find((e) => e.id === id) ?? null,
      allModels: () => many,
      matchModel: () => ({ kind: "ambiguous", candidates: many, confidence: "certain", evidence: "model name" }),
    };
    const [row] = buildUnidentifiedRows({ models: [opaque], declared: {}, catalog: c });
    assert.equal(row.chips, false);
    assert.match(row.help, /^5 models share this name — which one is it\? — model name$/);
  });

  test("none: 'No match' + identify", () => {
    const [row] = buildUnidentifiedRows({ models: [opaque], declared: {}, catalog });
    assert.equal(row.state, "none");
    assert.equal(row.help, "No match — tell us which model this is");
    assert.deepEqual(row.actions, ["identify"]);
    assert.deepEqual(row.candidates, []);
    assert.equal(row.catalogId, null);
  });

  test("a complete declaration makes the endpoint eligible → not listed", () => {
    const declared = { "custom/zzz-unknown": { catalogId: "qwen/qwen3.6-27b", price: "free", caches: false } };
    assert.deepEqual(buildUnidentifiedRows({ models: [opaque], declared, catalog }), []);
  });
});

describe("unidentifiedList", () => {
  test("supported envelope carries intro/footer", () => {
    const l = unidentifiedList({ models: [opaque], declared: {}, catalog });
    assert.equal(l.supported, true);
    assert.equal(l.intro, INTRO);
    assert.equal(l.footer, FOOTER);
    assert.equal(l.rows.length, 1);
    assert.equal(l.unavailableText, undefined);
  });
  test("empty catalogue → supported:false with the unavailable text and no rows", () => {
    const l = unidentifiedList({ models: [opaque], declared: {}, catalog: emptyCatalog });
    assert.deepEqual([l.supported, l.rows, l.unavailableText], [false, [], UNAVAILABLE_TEXT]);
  });
});

describe("buildDeclaration / mergeDeclared", () => {
  test("identity only", () => {
    assert.deepEqual(buildDeclaration({ catalogId: "a/b" }), { decl: { catalogId: "a/b" } });
    assert.equal(buildDeclaration({ catalogId: "" }).error.field, "catalogId");
  });
  test("form: free price, no caching", () => {
    const r = buildDeclaration({ form: { catalogId: "a/b", price: "free", costIn: "", costOut: "", caching: "none", reads: true, writes: true } });
    assert.deepEqual(r.decl, { catalogId: "a/b", price: "free", caches: false });
  });
  test("form: custom with one blank rate → 0; caching custom keeps the toggles", () => {
    const r = buildDeclaration({ form: { catalogId: "a/b", price: "custom", costIn: "3", costOut: "", caching: "custom", reads: true, writes: false } });
    assert.deepEqual(r.decl, { catalogId: "a/b", price: { input: 3, output: 0 }, caches: { read: true, write: false } });
  });
  test("missing price / custom with no rates → field error 'price'", () => {
    for (const price of [null, "custom"]) {
      const r = buildDeclaration({ form: { catalogId: "a/b", price, costIn: "", costOut: "", caching: "none", reads: true, writes: true } });
      assert.deepEqual(r.error, { field: "price", message: "Choose Free or enter a price." });
    }
  });
  test("mergeDeclared: preset defaults to balanced, same-key fields overwrite, absent keep, other keys untouched", () => {
    assert.deepEqual(mergeDeclared(undefined, "k", { catalogId: "x" }), { preset: "balanced", declaredModels: { k: { catalogId: "x" } } });
    const merged = mergeDeclared(
      { preset: "economy", declaredModels: { k: { catalogId: "old", price: "free" }, other: { catalogId: "o" } } },
      "k",
      { catalogId: "new" },
    );
    assert.deepEqual(merged, {
      preset: "economy",
      declaredModels: { k: { catalogId: "new", price: "free" }, other: { catalogId: "o" } },
    });
  });
});

function harness({ models = [qwen, ornith, opaque], config = {}, cat = catalog } = {}) {
  const state = { config: { ...config }, published: [], updates: [] };
  const svc = createModelsUnidentified({
    listModels: async () => models,
    configGet: async () => ({ ...state.config }),
    configUpdate: async (patch) => {
      state.updates.push(patch);
      Object.assign(state.config, patch);
      return { ...state.config };
    },
    catalog: cat,
    publish: (e) => state.published.push(e),
  });
  return { svc, state };
}

describe("createModelsUnidentified.declare", () => {
  test("Confirm on an endpoint with no price → still-needs, row kept, help names the gaps", async () => {
    const { svc, state } = harness();
    const r = await svc.declare({ key: "custom/qwen3.6-27b", catalogId: "qwen/qwen3.6-27b" });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "still-needs");
    assert.equal(r.message, "Identity saved — Auto still needs: what it costs, and whether it caches.");
    assert.equal(r.row.key, "custom/qwen3.6-27b");
    assert.ok(r.list.rows.some((x) => x.key === "custom/qwen3.6-27b"));
    assert.deepEqual(state.published, [{ kind: "models.updated", payload: {} }]);
    assert.deepEqual(state.config.modelRouting.declaredModels["custom/qwen3.6-27b"], { catalogId: "qwen/qwen3.6-27b" });
  });

  test("editor form free → resolved, row gone, message names the model", async () => {
    const { svc } = harness();
    const r = await svc.declare({
      key: "custom/zzz-unknown",
      form: { catalogId: "qwen/qwen3.6-27b", price: "free", costIn: "", costOut: "", caching: "none", reads: true, writes: true },
    });
    assert.deepEqual([r.ok, r.outcome, r.row], [true, "resolved", null]);
    assert.equal(r.message, "Saved — Auto can now describe zzz-unknown");
    assert.ok(!r.list.rows.some((x) => x.key === "custom/zzz-unknown"));
  });

  test("missing price → ok:false with the field, nothing written", async () => {
    const { svc, state } = harness();
    const r = await svc.declare({
      key: "custom/zzz-unknown",
      form: { catalogId: "qwen/qwen3.6-27b", price: null, costIn: "", costOut: "", caching: "none", reads: true, writes: true },
    });
    assert.deepEqual([r.ok, r.field, r.message], [false, "price", "Choose Free or enter a price."]);
    assert.equal(state.updates.length, 0);
    assert.equal(state.published.length, 0);
  });

  test("missing catalogId → field 'catalogId'; unknown key → unknown-model", async () => {
    const { svc } = harness();
    const r = await svc.declare({ key: "custom/zzz-unknown", catalogId: "" });
    assert.deepEqual([r.ok, r.field, r.message], [false, "catalogId", "Pick the model this is."]);
    const u = await svc.declare({ key: "nope/x", catalogId: "a" });
    assert.deepEqual([u.ok, u.code], [false, "unknown-model"]);
  });

  test("catalogue unavailable after the write → catalogue-unavailable", async () => {
    const { svc } = harness({ cat: emptyCatalog });
    const r = await svc.declare({ key: "custom/zzz-unknown", catalogId: "qwen/qwen3.6-27b" });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "catalogue-unavailable");
    assert.match(r.message, /^Saved\. Manta couldn't load the model catalogue/);
    assert.equal(r.list.supported, false);
  });

  test("two interleaved declares on different keys both persist", async () => {
    const { svc, state } = harness();
    await Promise.all([
      svc.declare({ key: "custom/qwen3.6-27b", catalogId: "qwen/qwen3.6-27b" }),
      svc.declare({ key: "custom/zzz-unknown", catalogId: "qwen/qwen3.6-27b" }),
    ]);
    assert.deepEqual(Object.keys(state.config.modelRouting.declaredModels).sort(), ["custom/qwen3.6-27b", "custom/zzz-unknown"]);
  });

  test("list() reads the declared map from config", async () => {
    const { svc } = harness({ config: { modelRouting: { preset: "balanced", declaredModels: { "custom/zzz-unknown": { catalogId: "qwen/qwen3.6-27b", price: "free", caches: false } } } } });
    const l = await svc.list();
    assert.ok(!l.rows.some((r) => r.key === "custom/zzz-unknown"));
  });
});
