import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildTableRows,
  buildTable,
  buildPicker,
  overrideFor,
  subOutcome,
  createModelsTable,
  modelKey,
} from "./modelsTable.mjs";

const M = (providerID, id, extra = {}) => ({ providerID, id, name: extra.name ?? id, ...extra });
const opus = M("anthropic", "claude-opus-4-7", { name: "Opus 4.7", limit: { context: 1_000_000 } });
const haiku = M("anthropic", "claude-haiku-4", { name: "Haiku 4", limit: { context: 200_000 } });
const old = M("anthropic", "claude-3-opus", { name: "Opus 3", status: "deprecated" });
const gpt = M("openai", "gpt-5.6", { name: "GPT 5.6" });
const gptFast = M("openai", "gpt-5.6-fast", { name: "GPT 5.6 Fast" });
const orphanFast = M("databricks", "x-fast", { name: "X Fast" });

function harness({ models = [opus, haiku, old, gpt, gptFast], config = {}, sync, recents = [], listOverridden } = {}) {
  const state = { config: { ...config }, published: [], updates: [], syncCalls: [] };
  const svc = createModelsTable({
    listModels: async (overrides) => (listOverridden ? listOverridden(overrides, models) : models),
    configGet: async () => ({ ...state.config }),
    configUpdate: async (patch) => {
      state.updates.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete state.config[k];
        else state.config[k] = v;
      }
      return { ...state.config };
    },
    syncSubagentsDetailed:
      sync ??
      (async (input) => {
        state.syncCalls.push(input);
        return { agents: [], read: "ok", write: "ok", reload: "ok" };
      }),
    getModelPrefs: async () => ({ sessions: {}, recents }),
    publish: (e) => state.published.push(e),
  });
  return { svc, state };
}

describe("buildTableRows", () => {
  test("live row: Main/Sub on, can be default, tier + context + description", () => {
    const [row] = buildTableRows({ models: [opus], config: {} });
    assert.equal(row.key, "anthropic/claude-opus-4-7");
    assert.equal(row.contextLabel, "1M");
    assert.equal(row.tier, "deep");
    assert.equal(row.isMain, true);
    assert.equal(row.isSub, true);
    assert.equal(row.canMakeDefault, true);
    assert.equal(row.defaultHint, null);
    assert.equal(row.deprecated, false);
    assert.deepEqual(row.editable, { name: "Opus 4.7", description: row.description, context: 1_000_000 });
  });

  test("deprecated, not opted in → locked: Main/Sub off, hint, cannot be default", () => {
    const [row] = buildTableRows({ models: [old], config: {} });
    assert.equal(row.deprecated, true);
    assert.equal(row.deprecatedLocked, true);
    assert.equal(row.isMain, false);
    assert.equal(row.isSub, false);
    assert.equal(row.canMakeDefault, false);
    assert.equal(row.defaultHint, "Enable this deprecated model first");
  });

  test("deprecated and opted in → ordinary row", () => {
    const [row] = buildTableRows({ models: [old], config: { optInModels: [modelKey(old.providerID, old.id)] } });
    assert.equal(row.deprecated, true);
    assert.equal(row.deprecatedLocked, false);
    assert.equal(row.isMain, true);
    assert.equal(row.canMakeDefault, true);
  });

  test("Main off → can't be default, hint 'Enable Main first'", () => {
    const [row] = buildTableRows({ models: [haiku], config: { deactivatedMainModels: ["anthropic/claude-haiku-4"] } });
    assert.equal(row.isMain, false);
    assert.equal(row.canMakeDefault, false);
    assert.equal(row.defaultHint, "Enable Main first");
  });

  test("searchText is lower-case and includes the guide's 'good for' lines", () => {
    const [row] = buildTableRows({ models: [haiku], config: {} });
    assert.equal(row.searchText, row.searchText.toLowerCase());
    assert.match(row.searchText, /haiku 4/);
    assert.match(row.searchText, /anthropic/);
    assert.match(row.searchText, /mechanical edits/);
  });

  test("unknown context → null label", () => {
    const [row] = buildTableRows({ models: [gpt], config: {} });
    assert.equal(row.contextLabel, null);
  });

  test("isDefault follows config.defaultModel", () => {
    const rows = buildTableRows({
      models: [opus, haiku],
      config: { defaultModel: { providerID: "anthropic", modelID: "claude-haiku-4" } },
    });
    assert.deepEqual(rows.map((r) => r.isDefault), [false, true]);
  });
});

describe("buildTable", () => {
  test("defaultLine from the row; falls back to ids when the default is not listed; null when none", () => {
    const withDefault = buildTable({ models: [opus], config: { defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" } } });
    assert.deepEqual(withDefault.defaultLine, { name: "Opus 4.7", providerID: "anthropic" });
    const missing = buildTable({ models: [], config: { defaultModel: { providerID: "x", modelID: "gone" } } });
    assert.deepEqual(missing.defaultLine, { name: "gone", providerID: "x" });
    assert.equal(buildTable({ models: [opus], config: {} }).defaultLine, null);
    assert.equal(buildTable({ models: [opus], config: {} }).defaultKey, null);
  });
});

describe("buildPicker", () => {
  const config = {
    deactivatedMainModels: ["anthropic/claude-haiku-4"],
    optInModels: [],
  };
  test("hidden key absent from groups / selectable / delegateGroups / recents", () => {
    const p = buildPicker({
      models: [opus, haiku],
      config,
      recents: [{ providerID: "anthropic", modelID: "claude-haiku-4" }, { providerID: "anthropic", modelID: "claude-opus-4-7" }],
    });
    const all = JSON.stringify([p.groups, p.selectable, p.delegateGroups, p.recents]);
    assert.ok(!all.includes("claude-haiku-4"));
    assert.deepEqual(p.selectable, ["anthropic/claude-opus-4-7"]);
    assert.deepEqual(p.recents.map((r) => r.key), ["anthropic/claude-opus-4-7"]);
  });

  test("locked deprecated: present in groups + locked, absent from selectable and delegateGroups", () => {
    const p = buildPicker({ models: [opus, old], config: {}, recents: [] });
    assert.deepEqual(p.locked, ["anthropic/claude-3-opus"]);
    assert.ok(p.groups[0].keys.includes("anthropic/claude-3-opus"));
    assert.ok(!p.selectable.includes("anthropic/claude-3-opus"));
    assert.ok(!JSON.stringify(p.delegateGroups).includes("claude-3-opus"));
  });

  test("opted-in deprecated is selectable (and still not a delegate target)", () => {
    const p = buildPicker({ models: [old], config: { optInModels: ["anthropic/claude-3-opus"] }, recents: [] });
    assert.deepEqual(p.locked, []);
    assert.deepEqual(p.selectable, ["anthropic/claude-3-opus"]);
    assert.deepEqual(p.delegateGroups, []);
  });

  test("-fast twin folded out of groups but present in selectable; orphan fast stays", () => {
    const p = buildPicker({ models: [gpt, gptFast, orphanFast], config: {}, recents: [] });
    const openai = p.groups.find((g) => g.provider === "openai");
    assert.deepEqual(openai.keys, ["openai/gpt-5.6"]);
    assert.ok(p.selectable.includes("openai/gpt-5.6-fast"));
    assert.deepEqual(p.groups.find((g) => g.provider === "databricks").keys, ["databricks/x-fast"]);
  });

  test("enabled:false is absent everywhere; groups sorted by provider", () => {
    const off = M("zzz", "dead", { enabled: false });
    const p = buildPicker({ models: [off, gpt, opus], config: {}, recents: [] });
    assert.ok(!JSON.stringify(p).includes("dead"));
    assert.deepEqual(p.groups.map((g) => g.provider), ["anthropic", "openai"]);
  });

  test("recent of a removed model dropped; a recent whose -fast twin is selectable is kept; shape + order kept", () => {
    const p = buildPicker({
      models: [gpt, gptFast],
      config: {},
      recents: [
        { providerID: "gone", modelID: "x" },
        { providerID: "openai", modelID: "gpt-5.6", variant: "high", fast: true },
      ],
    });
    assert.deepEqual(p.recents, [{ providerID: "openai", modelID: "gpt-5.6", variant: "high", fast: true, key: "openai/gpt-5.6" }]);
  });
});

describe("overrideFor", () => {
  const model = { providerID: "p", id: "m", name: "Name", description: "Desc", limit: { context: 1000 } };
  test("blank fields keep the provider default; unchanged fields are not stored", () => {
    assert.deepEqual(overrideFor({ model, fields: { name: "", description: "", context: "" } }), { override: {} });
    assert.deepEqual(overrideFor({ model, fields: { name: "Name", description: "Desc", context: "1000" } }), { override: {} });
  });
  test("changed fields are stored (trimmed)", () => {
    assert.deepEqual(overrideFor({ model, fields: { name: " New ", description: "D2", context: "2000" } }), {
      override: { name: "New", description: "D2", context: 2000 },
    });
  });
  test("invalid context → field error", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "1e3"]) {
      const r = overrideFor({ model, fields: { context: bad } });
      assert.equal(r.error.field, "context", bad);
      assert.equal(r.error.message, "Context size must be a whole number of tokens above 0.");
    }
  });
});

describe("subOutcome", () => {
  test("mapping", () => {
    assert.equal(subOutcome({ read: "ok", write: "ok", reload: "ok" }), "applied");
    assert.equal(subOutcome({ read: "ok", write: "noop", reload: "n/a" }), "applied");
    assert.equal(subOutcome({ read: "ok", write: "ok", reload: "failed" }), "saved-not-live");
    assert.equal(subOutcome({ read: "ok", write: "failed", reload: "n/a" }), "not-applied");
    assert.equal(subOutcome({ read: "failed", write: "noop", reload: "n/a" }), "not-applied");
  });
});

describe("createModelsTable writes", () => {
  test("set-default refuses a hidden key and a locked deprecated one", async () => {
    const { svc, state } = harness({ config: { deactivatedMainModels: ["anthropic/claude-haiku-4"] } });
    const hidden = await svc.setDefault({ key: "anthropic/claude-haiku-4" });
    assert.deepEqual([hidden.ok, hidden.code, hidden.message], [false, "not-main", "Turn on Main first."]);
    const locked = await svc.setDefault({ key: "anthropic/claude-3-opus" });
    assert.equal(locked.ok, false);
    assert.equal(state.updates.length, 0);
    assert.equal(state.published.length, 0);
  });

  test("set-default writes defaultModel, returns the new table and publishes models.updated once", async () => {
    const { svc, state } = harness();
    const r = await svc.setDefault({ key: "anthropic/claude-opus-4-7" });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Default set to Opus 4.7.");
    assert.equal(r.table.defaultKey, "anthropic/claude-opus-4-7");
    assert.deepEqual(state.updates, [{ defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" } }]);
    assert.deepEqual(state.published, [{ kind: "models.updated", payload: {} }]);
  });

  test("set-default {key:null} clears the default", async () => {
    const { svc, state } = harness({ config: { defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" } } });
    const r = await svc.setDefault({ key: null });
    assert.equal(r.ok, true);
    assert.equal(r.table.defaultKey, null);
    assert.deepEqual(state.updates, [{ defaultModel: null }]);
  });

  test("unknown key resolves ok:false unknown-model (no write, no frame)", async () => {
    const { svc, state } = harness();
    for (const call of [
      () => svc.setDefault({ key: "nope/x" }),
      () => svc.setMain({ key: "nope/x", on: false }),
      () => svc.setSub({ key: "nope/x", on: false }),
      () => svc.optIn({ keys: ["nope/x"] }),
      () => svc.setOverride({ key: "nope/x", fields: {} }),
    ]) {
      const r = await call();
      assert.deepEqual([r.ok, r.code, r.message], [false, "unknown-model", "That model is no longer on this box."]);
    }
    assert.equal(state.updates.length, 0);
    assert.equal(state.published.length, 0);
  });

  test("set-main off on the default clears it in ONE configUpdate", async () => {
    const { svc, state } = harness({ config: { defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" } } });
    const r = await svc.setMain({ key: "anthropic/claude-opus-4-7", on: false });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Hidden from the model picker. The default was cleared.");
    assert.deepEqual(state.updates, [{ deactivatedMainModels: ["anthropic/claude-opus-4-7"], defaultModel: null }]);
    assert.equal(r.table.defaultKey, null);
    assert.equal(r.table.rows.find((x) => x.key === "anthropic/claude-opus-4-7").isMain, false);
  });

  test("set-main off on a non-default / on again", async () => {
    const { svc, state } = harness();
    const off = await svc.setMain({ key: "anthropic/claude-haiku-4", on: false });
    assert.equal(off.message, "Hidden from the model picker.");
    assert.deepEqual(state.updates[0], { deactivatedMainModels: ["anthropic/claude-haiku-4"] });
    const on = await svc.setMain({ key: "anthropic/claude-haiku-4", on: true });
    assert.equal(on.message, "Shown in the model picker.");
    assert.deepEqual(state.updates[1], { deactivatedMainModels: [] });
  });

  test("set-main / set-sub refuse a locked deprecated model", async () => {
    const { svc } = harness();
    assert.equal((await svc.setMain({ key: "anthropic/claude-3-opus", on: true })).code, "deprecated-locked");
    assert.equal((await svc.setSub({ key: "anthropic/claude-3-opus", on: true })).code, "deprecated-locked");
  });

  test("set-sub: config write OK + reconcile applied → 'Subagent list updated.'", async () => {
    const { svc, state } = harness();
    const r = await svc.setSub({ key: "anthropic/claude-haiku-4", on: false });
    assert.deepEqual([r.ok, r.outcome, r.retry, r.message], [true, "applied", false, "Subagent list updated."]);
    assert.deepEqual(state.syncCalls[0].deactivated, ["anthropic/claude-haiku-4"]);
    assert.equal(state.published.length, 1);
  });

  test("set-sub: reconcile write failed → ok:true, not-applied, retry, preference-saved sentence", async () => {
    const { svc } = harness({ sync: async () => ({ agents: [], read: "ok", write: "failed", reload: "n/a" }) });
    const r = await svc.setSub({ key: "anthropic/claude-haiku-4", on: false });
    assert.deepEqual([r.ok, r.outcome, r.retry], [true, "not-applied", true]);
    assert.equal(r.message, "Preference saved, but the subagent list on the box wasn't updated. Try again to apply it.");
  });

  test("set-sub: read failed → not-applied; write ok + reload failed → saved-not-live, no retry", async () => {
    const readFailed = harness({ sync: async () => ({ agents: [], read: "failed", write: "noop", reload: "n/a" }) });
    assert.equal((await readFailed.svc.setSub({ key: "anthropic/claude-haiku-4", on: false })).outcome, "not-applied");
    const notLive = harness({ sync: async () => ({ agents: [], read: "ok", write: "ok", reload: "failed" }) });
    const r = await notLive.svc.setSub({ key: "anthropic/claude-haiku-4", on: false });
    assert.deepEqual([r.ok, r.outcome, r.retry], [true, "saved-not-live", false]);
    assert.match(r.message, /Restart opencode/);
  });

  test("set-sub: successful no-op reconcile is 'applied'", async () => {
    const { svc } = harness({ sync: async () => ({ agents: [], read: "ok", write: "noop", reload: "n/a" }) });
    assert.equal((await svc.setSub({ key: "anthropic/claude-haiku-4", on: false })).outcome, "applied");
  });

  test("config write rejecting rejects the call (programmer/IO error) and publishes nothing", async () => {
    const published = [];
    const svc = createModelsTable({
      listModels: async () => [haiku],
      configGet: async () => ({}),
      configUpdate: async () => { throw new Error("disk full"); },
      syncSubagentsDetailed: async () => ({ agents: [], read: "ok", write: "ok", reload: "ok" }),
      getModelPrefs: async () => ({ recents: [] }),
      publish: (e) => published.push(e),
    });
    await assert.rejects(() => svc.setSub({ key: "anthropic/claude-haiku-4", on: false }), /disk full/);
    assert.equal(published.length, 0);
  });

  test("retry-sub-sync re-runs only the reconcile (no configUpdate)", async () => {
    const { svc, state } = harness({ config: { deactivatedSubagents: ["anthropic/claude-haiku-4"], optInModels: ["x/y"] } });
    const r = await svc.retrySubSync();
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "applied");
    assert.equal(state.updates.length, 0);
    assert.deepEqual(state.syncCalls[0].deactivated, ["anthropic/claude-haiku-4"]);
    assert.deepEqual(state.syncCalls[0].optIn, ["x/y"]);
  });

  test("opt-in unions keys, reconciles, mirrors the outcome rules and names the model", async () => {
    const { svc, state } = harness();
    const r = await svc.optIn({ keys: ["anthropic/claude-3-opus", "nope/x"] });
    assert.equal(r.ok, true);
    assert.equal(r.message, "Enabled Opus 3.");
    assert.deepEqual(r.ignored, ["nope/x"]);
    assert.deepEqual(state.updates, [{ optInModels: ["anthropic/claude-3-opus"] }]);
    assert.equal(r.table.rows.find((x) => x.key === "anthropic/claude-3-opus").deprecatedLocked, false);
    assert.deepEqual(state.syncCalls[0].optIn, ["anthropic/claude-3-opus"]);
  });

  test("opt-in not-applied appends the sentence and offers retry", async () => {
    const { svc } = harness({ sync: async () => ({ agents: [], read: "ok", write: "failed", reload: "n/a" }) });
    const r = await svc.optIn({ keys: ["anthropic/claude-3-opus"] });
    assert.deepEqual([r.outcome, r.retry], ["not-applied", true]);
    assert.match(r.message, /^Enabled Opus 3\. Preference saved, but the subagent list/);
  });

  test("opt-in with several keys says 'Enabled N models.'", async () => {
    const { svc } = harness({ models: [old, M("a", "dep2", { status: "deprecated", name: "Dep 2" })] });
    const r = await svc.optIn({ keys: ["anthropic/claude-3-opus", "a/dep2"] });
    assert.equal(r.message, "Enabled 2 models.");
  });

  test("concurrent opt-ins both land (serialized read-modify-write)", async () => {
    const { svc, state } = harness({ models: [old, M("a", "dep2", { status: "deprecated" })] });
    // Slow the first update so an unserialized second call would read the stale list.
    const [a, b] = await Promise.all([svc.optIn({ keys: ["anthropic/claude-3-opus"] }), svc.optIn({ keys: ["a/dep2"] })]);
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual([...state.config.optInModels].sort(), ["a/dep2", "anthropic/claude-3-opus"]);
  });

  test("set-override stores only differing fields; clearing everything deletes the key; invalid context writes nothing", async () => {
    const { svc, state } = harness({
      config: { modelOverrides: { "anthropic/claude-haiku-4": { name: "Old" }, "keep/me": { name: "x" } } },
    });
    const saved = await svc.setOverride({ key: "anthropic/claude-haiku-4", fields: { name: "Nick", description: "", context: "300000" } });
    assert.equal(saved.ok, true);
    assert.equal(saved.message, "Saved.");
    assert.deepEqual(state.updates[0].modelOverrides, {
      "anthropic/claude-haiku-4": { name: "Nick", context: 300000 },
      "keep/me": { name: "x" },
    });
    const cleared = await svc.setOverride({ key: "anthropic/claude-haiku-4", fields: { name: "", description: "", context: "" } });
    assert.deepEqual(state.updates[1].modelOverrides, { "keep/me": { name: "x" } });
    assert.equal(cleared.ok, true);
    const n = state.updates.length;
    const bad = await svc.setOverride({ key: "anthropic/claude-haiku-4", fields: { context: "12.5" } });
    assert.deepEqual([bad.ok, bad.field, bad.message], [false, "context", "Context size must be a whole number of tokens above 0."]);
    assert.equal(state.updates.length, n);
  });

  test("set-override diffs against the PROVIDER defaults (un-overridden list)", async () => {
    const calls = [];
    const { svc, state } = harness({
      listOverridden: (overrides, models) => {
        calls.push(overrides);
        return models;
      },
    });
    await svc.setOverride({ key: "anthropic/claude-haiku-4", fields: { name: "Haiku 4" } });
    assert.deepEqual(calls[0], {}, "first list call is the un-overridden one");
    assert.deepEqual(state.updates[0].modelOverrides, {}, "same as the provider name → nothing stored");
  });

  test("models.updated is published exactly once per successful write", async () => {
    const { svc, state } = harness();
    await svc.setMain({ key: "anthropic/claude-haiku-4", on: false });
    await svc.setOverride({ key: "anthropic/claude-haiku-4", fields: { name: "Z" } });
    await svc.table();
    await svc.picker();
    assert.equal(state.published.length, 2);
  });

  test("table() and picker() read live config", async () => {
    const { svc } = harness({
      config: { deactivatedMainModels: ["anthropic/claude-haiku-4"] },
      recents: [{ providerID: "anthropic", modelID: "claude-opus-4-7" }],
    });
    const t = await svc.table();
    assert.equal(t.supported, true);
    assert.equal(t.rows.find((r) => r.key === "anthropic/claude-haiku-4").isMain, false);
    const p = await svc.picker();
    assert.deepEqual(p.recents.map((r) => r.key), ["anthropic/claude-opus-4-7"]);
    assert.ok(!p.selectable.includes("anthropic/claude-haiku-4"));
  });
});
