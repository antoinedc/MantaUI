import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCostDraft, groupUnpriced, withUnpricedGroups, createModelsPricing } from "./modelsPricing.mjs";

const EMPTY = { input: "", output: "", cacheRead: "", cacheWrite: "" };

describe("parseCostDraft (moved from ModelPriceForm)", () => {
  test("requires input, output and cache read — with the field named", () => {
    assert.deepEqual(parseCostDraft({ ...EMPTY, output: "15", cacheRead: "0.3" }), { ok: false, field: "input", message: "Input price is required." });
    assert.deepEqual(parseCostDraft({ ...EMPTY, input: "3", cacheRead: "0.3" }), { ok: false, field: "output", message: "Output price is required." });
    assert.deepEqual(parseCostDraft({ ...EMPTY, input: "3", output: "15" }), { ok: false, field: "cacheRead", message: "Cache read price is required." });
  });

  test("builds the writer body; cache write is optional", () => {
    assert.deepEqual(parseCostDraft({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "" }), { ok: true, cost: { input: 3, output: 15, cache_read: 0.3 } });
    assert.deepEqual(parseCostDraft({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" }), {
      ok: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    });
  });

  test("'.5' and '3.' are accepted; 0 is a price", () => {
    assert.deepEqual(parseCostDraft({ input: ".5", output: "3.", cacheRead: "0", cacheWrite: "" }), { ok: true, cost: { input: 0.5, output: 3, cache_read: 0 } });
  });

  test("'1e3' / '0x10' / '-1' / '1,5' / Infinity / NaN are refused", () => {
    for (const bad of ["-1", "abc", "1e3", "0x10", "1,5", "Infinity", "NaN"]) {
      const r = parseCostDraft({ input: bad, output: "1", cacheRead: "1", cacheWrite: "" });
      assert.equal(r.ok, false, bad);
      assert.equal(r.field, "input");
    }
    assert.deepEqual(parseCostDraft({ input: "1", output: "1", cacheRead: "-0.1", cacheWrite: "" }), {
      ok: false,
      field: "cacheRead",
      message: "Cache read price must be a number of dollars per million tokens (0 or more).",
    });
    assert.deepEqual(parseCostDraft({ input: "1", output: "1", cacheRead: "0.1", cacheWrite: "x" }), {
      ok: false,
      field: "cacheWrite",
      message: "Cache write price must be a number of dollars per million tokens (0 or more).",
    });
  });
});

describe("groupUnpriced / withUnpricedGroups", () => {
  test("first-slash split, sorted; malformed keys dropped", () => {
    assert.deepEqual(groupUnpriced(["openrouter/deepseek/deepseek-v4-flash", "acme/b", "acme/a"]), [
      { providerID: "acme", models: ["a", "b"] },
      { providerID: "openrouter", models: ["deepseek/deepseek-v4-flash"] },
    ]);
    assert.deepEqual(groupUnpriced(["nomodel", "/x", "p/"]), []);
  });
  test("a result without `unpriced` is left untouched", () => {
    const old = { fetchedAt: 1, models: {} };
    assert.equal(withUnpricedGroups(old), old);
    assert.deepEqual(withUnpricedGroups({ unpriced: ["a/b"], models: {} }).unpricedByProvider, [{ providerID: "a", models: ["b"] }]);
  });
});

describe("models:set-price", () => {
  const draft = { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "" };
  function harness(result, { prices = { unpriced: ["a/x"], models: {} } } = {}) {
    const calls = { write: [], invalidated: 0 };
    const svc = createModelsPricing({
      setModelCostDetailed: async (i) => {
        calls.write.push(i);
        return result;
      },
      invalidatePrices: () => { calls.invalidated += 1; },
      getPrices: async () => prices,
    });
    return { svc, calls };
  }

  test("validation error → ok:false with the field, nothing written", async () => {
    const { svc, calls } = harness({ ok: true });
    const r = await svc.setPrice({ providerID: "a", modelID: "x", draft: { ...draft, input: "" } });
    assert.deepEqual(r, { ok: false, field: "input", message: "Input price is required." });
    assert.equal(calls.write.length, 0);
  });

  test("written + reloaded → ok:true, message, prices invalidated, fresh groups", async () => {
    const { svc, calls } = harness({ ok: true, changed: true, reloaded: true });
    const r = await svc.setPrice({ providerID: "a", modelID: "x", draft });
    assert.deepEqual(r, { ok: true, message: "Saved — the optimizer will use these prices", unpricedByProvider: [{ providerID: "a", models: ["x"] }] });
    assert.deepEqual(calls.write[0], { providerID: "a", modelID: "x", cost: { input: 3, output: 15, cache_read: 0.3 } });
    assert.equal(calls.invalidated, 1);
  });

  test("written but reload refused → ok:true WITH a warning, prices invalidated", async () => {
    const { svc, calls } = harness({ ok: false, changed: true, reloaded: false, error: "reload 500" });
    const r = await svc.setPrice({ providerID: "a", modelID: "x", draft });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Saved — the optimizer will use these prices");
    assert.match(r.warning, /^opencode didn't reload its config/);
    assert.equal(calls.invalidated, 1);
  });

  test("not written → 'Nothing was changed', no invalidation", async () => {
    const { svc, calls } = harness({ ok: false, changed: false, error: "disk full" });
    const r = await svc.setPrice({ providerID: "a", modelID: "x", draft });
    assert.deepEqual(r, { ok: false, message: "Couldn't save — disk full. Nothing was changed; try again." });
    assert.equal(calls.invalidated, 0);
  });

  test("a failed prices re-read still reports the save (empty groups)", async () => {
    const svc = createModelsPricing({
      setModelCostDetailed: async () => ({ ok: true, changed: true, reloaded: true }),
      invalidatePrices: () => {},
      getPrices: async () => { throw new Error("nope"); },
    });
    const r = await svc.setPrice({ providerID: "a", modelID: "x", draft });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unpricedByProvider, []);
  });
});
