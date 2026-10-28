// rpc.models.test.mjs — integration smoke test for the WS09 channel registration
// (M-09-srv-1). It builds the REAL handlers with injected fakes and calls every
// new / wrapped channel once, asserting each resolves to its pinned shape, and
// that the models writes push the saved config through syncState.applyConfig and
// publish `models.updated`. Hermetic: no opencode, no tmux, no config file (the
// stopped store lives in the MANTA_STATE_HOME test sandbox).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHandlers } from "./rpc.mjs";
import { upsertStopped } from "./stoppedStore.mjs";
import { createUsageAlerts } from "./usageAlerts.mjs";
import { createModelIndex } from "./modelCatalog.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/modelCatalog.fixture.json", import.meta.url), "utf-8"));

const MODELS = [
  { providerID: "anthropic", id: "claude-opus-4-7", name: "Opus 4.7", limit: { context: 1_000_000 } },
  { providerID: "anthropic", id: "claude-haiku-4", name: "Haiku 4", limit: { context: 200_000 } },
  { providerID: "anthropic", id: "claude-3-opus", name: "Opus 3", status: "deprecated" },
  { providerID: "custom", id: "zzz-unknown", name: "zzz-unknown" },
];

function setup() {
  const published = [];
  const applied = [];
  const config = { modelOverrides: {} };
  const syncCalls = [];
  const costCalls = [];
  const invalidated = [];
  const listProjectsCalls = [];
  const alerts = createUsageAlerts({ publish: (e) => published.push(e), bootId: "boot-test" });
  const deps = {
    tmux: { listProjects: async () => (listProjectsCalls.push(1), [{ tmuxSession: "manta", windows: [{ name: "fix login", opencodeSessionId: "ses_1" }] }]) },
    oc: {
      listModels: async () => MODELS,
      listMessages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] }],
      getProviders: async () => ({ connected: [], all: [] }),
    },
    pty: {},
    bus: { publish: (e) => published.push(e) },
    syncState: {
      refreshNow: async () => {},
      applyConfig: (c) => applied.push(c),
      snapshot: () => ({ projects: [] }),
      payloadSince: (s, g) => ({ gen: g, seq: 0, changed: {} }),
      everSucceeded: () => true,
    },
    local: {
      configGet: async () => ({ ...config }),
      configUpdate: async (patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete config[k];
          else config[k] = v;
        }
        return { ...config };
      },
    },
    push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
    syncSubagentsDetailed: async (input) => {
      syncCalls.push(input);
      return { agents: [], read: "ok", write: "ok", reload: "ok" };
    },
    setModelCostDetailed: async (input) => {
      costCalls.push(input);
      return { ok: true, changed: true, reloaded: true };
    },
    getUsageAlerts: () => alerts,
    optimizerPrices: {
      get: async () => ({ fetchedAt: 1, models: {}, unpriced: ["custom/zzz-unknown", "openrouter/deepseek/flash"] }),
      invalidate: () => invalidated.push(1),
    },
    optimizerSummary: async () => ({
      supported: true,
      cacheShare: { output: 0, cacheRead: 0.74, cacheWrite: 0.13, input: 0.13 },
      bySession: [],
      ttl: null,
      windows: [],
      activity: { entries: [] },
      compaction: null,
      metered: [],
    }),
    optimizerSeries: async (range) => ({
      supported: true,
      range: range ?? "24h",
      bucket: "hour",
      series: [{ t: 0, tokensSent: 10, actualTrimmedTokens: 0, potentialTrimmedTokens: 0, maskedTokens: 0 }],
      totals: { turns: 1, cost: 0.5, tokensSent: 10, actualTrimmedTokens: 0, potentialTrimmedTokens: 0, maskedTokens: 0, rewarmTokens: 0 },
      saved: { usd: 0, potentialUsd: 0, pricedShare: 1, basis: "measured" },
    }),
  };
  return { deps, published, applied, config, syncCalls, costCalls, invalidated, alerts };
}

const modelsUpdated = (published) => published.filter((e) => e.kind === "models.updated").length;

describe("WS09 channels (M-09-srv-1)", () => {
  test("models:table / models:picker resolve to their pinned shapes", async () => {
    const { deps } = setup();
    const h = buildHandlers(deps);
    const t = await h["models:table"]();
    assert.equal(t.supported, true);
    assert.equal(t.rows.length, 4);
    assert.ok(t.rows[0].searchText && "canMakeDefault" in t.rows[0] && "editable" in t.rows[0]);
    const p = await h["models:picker"]();
    assert.deepEqual(Object.keys(p).sort(), ["delegateGroups", "groups", "locked", "recents", "selectable", "supported"]);
    assert.deepEqual(p.locked, ["anthropic/claude-3-opus"]);
  });

  test("models writes push the saved config through syncState.applyConfig and publish models.updated", async () => {
    const { deps, published, applied, syncCalls } = setup();
    const h = buildHandlers(deps);

    const d = await h["models:set-default"]({ key: "anthropic/claude-opus-4-7" });
    assert.equal(d.ok, true);
    assert.deepEqual(applied.at(-1).defaultModel, { providerID: "anthropic", modelID: "claude-opus-4-7" });
    assert.equal(modelsUpdated(published), 1);

    const m = await h["models:set-main"]({ key: "anthropic/claude-opus-4-7", on: false });
    assert.equal(m.ok, true);
    assert.equal(applied.at(-1).defaultModel, undefined, "hiding the default clears it in the pushed config");
    assert.deepEqual(applied.at(-1).deactivatedMainModels, ["anthropic/claude-opus-4-7"]);
    assert.equal(modelsUpdated(published), 2);

    const s = await h["models:set-sub"]({ key: "anthropic/claude-haiku-4", on: false });
    assert.deepEqual([s.ok, s.outcome, s.retry], [true, "applied", false]);
    assert.deepEqual(syncCalls.at(-1).deactivated, ["anthropic/claude-haiku-4"]);
    assert.equal(modelsUpdated(published), 3);

    const o = await h["models:opt-in"]({ keys: ["anthropic/claude-3-opus"] });
    assert.equal(o.ok, true);
    assert.deepEqual(applied.at(-1).optInModels, ["anthropic/claude-3-opus"]);
    assert.equal(modelsUpdated(published), 4);

    const r = await h["models:retry-sub-sync"]();
    assert.deepEqual([r.ok, r.outcome], [true, "applied"]);

    const ov = await h["models:set-override"]({ key: "anthropic/claude-haiku-4", fields: { name: "Nick", description: "", context: "300000" } });
    assert.equal(ov.ok, true);
    assert.deepEqual(applied.at(-1).modelOverrides, { "anthropic/claude-haiku-4": { name: "Nick", context: 300000 } });
    assert.equal(modelsUpdated(published), 5);

    const bad = await h["models:set-override"]({ key: "anthropic/claude-haiku-4", fields: { context: "x" } });
    assert.deepEqual([bad.ok, bad.field], [false, "context"]);
    assert.equal(modelsUpdated(published), 5, "a refused write publishes nothing");
  });

  test("models:unidentified + both models:declare forms", async () => {
    const { deps, published, applied } = setup();
    const catalog = createModelIndex(FIXTURE);
    // The real handlers read the box-singleton catalogue; the smoke test only needs the
    // channels to resolve to their pinned shapes, so accept either an empty or a loaded one.
    const h = buildHandlers(deps);
    const list = await h["models:unidentified"]();
    assert.ok(typeof list.supported === "boolean" && Array.isArray(list.rows) && typeof list.intro === "string" && typeof list.footer === "string");
    assert.ok(catalog.size > 0);

    const unknown = await h["models:declare"]({ key: "nope/x", catalogId: "a/b" });
    assert.deepEqual([unknown.ok, unknown.code], [false, "unknown-model"]);

    const identity = await h["models:declare"]({ key: "custom/zzz-unknown", catalogId: "qwen/qwen3.6-27b" });
    assert.equal(identity.ok, true);
    assert.ok(["resolved", "still-needs", "catalogue-unavailable"].includes(identity.outcome));
    assert.deepEqual(applied.at(-1).modelRouting.declaredModels["custom/zzz-unknown"].catalogId, "qwen/qwen3.6-27b");

    const form = await h["models:declare"]({
      key: "custom/zzz-unknown",
      form: { catalogId: "qwen/qwen3.6-27b", price: "free", costIn: "", costOut: "", caching: "none", reads: true, writes: true },
    });
    assert.equal(form.ok, true);
    assert.ok(form.list && "rows" in form.list && typeof form.message === "string");
    assert.equal(modelsUpdated(published), 2);

    const missingPrice = await h["models:declare"]({
      key: "custom/zzz-unknown",
      form: { catalogId: "qwen/qwen3.6-27b", price: null, costIn: "", costOut: "", caching: "none", reads: true, writes: true },
    });
    assert.deepEqual([missingPrice.ok, missingPrice.field], [false, "price"]);
  });

  test("models:set-price validates, writes through setModelCostDetailed, invalidates prices, returns the groups", async () => {
    const { deps, costCalls, invalidated } = setup();
    const h = buildHandlers(deps);
    const bad = await h["models:set-price"]({ providerID: "custom", modelID: "zzz-unknown", draft: { input: "", output: "1", cacheRead: "1", cacheWrite: "" } });
    assert.deepEqual([bad.ok, bad.field], [false, "input"]);
    assert.equal(costCalls.length, 0);
    const ok = await h["models:set-price"]({ providerID: "custom", modelID: "zzz-unknown", draft: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "" } });
    assert.equal(ok.ok, true);
    assert.deepEqual(costCalls[0], { providerID: "custom", modelID: "zzz-unknown", cost: { input: 3, output: 15, cache_read: 0.3 } });
    assert.equal(invalidated.length, 1);
    assert.deepEqual(ok.unpricedByProvider.map((g) => g.providerID), ["custom", "openrouter"]);
  });

  test("the wrapped read channels add their `view` / `unpricedByProvider` blocks", async () => {
    const { deps } = setup();
    const h = buildHandlers(deps);
    const prices = await h["optimizer:prices"]();
    assert.deepEqual(prices.unpricedByProvider, [
      { providerID: "custom", models: ["zzz-unknown"] },
      { providerID: "openrouter", models: ["deepseek/flash"] },
    ]);
    const summary = await h["optimizer:summary"]();
    assert.equal(summary.view.switch.label, "Off");
    const series = await h["optimizer:series"]({ range: "7d" });
    assert.equal(series.view.stats[0].label, "Sent (7d)");
    // `ledger:summary` reads opencode's real SQLite store (no injection seam), so it is not
    // called here; its wrapper is the one-line `withLedgerView` pinned in ledgerView.test.mjs.
  });

  test("usage-stopped:view / :apply (dry run + real) over the real stopped store", async () => {
    const { deps, published } = setup();
    const h = buildHandlers(deps);
    const now = Date.now();
    await upsertStopped({ workspace: "manta", conversation: "ses_1", provider: "claude", model: "claude-opus-4-7", window: "weekly", stoppedAt: now - 1000, cachedTokens: 1234 }, {});
    const view = await h["usage-stopped:view"]();
    assert.equal(view.supported, true);
    const row = view.groups.flatMap((g) => g.rows).find((r) => r.conversation === "ses_1");
    assert.deepEqual([row.name, row.snippet], ["fix login", "all done"]);

    const dry = await h["usage-stopped:apply"]({ selected: ["ses_1"], dryRun: true });
    assert.deepEqual([dry.ok, dry.canApply, dry.arm], [true, true, ["ses_1"]]);

    const real = await h["usage-stopped:apply"]({ selected: ["ses_1"] });
    assert.equal(real.ok, true);
    assert.deepEqual(real.applied.armed, ["ses_1"]);
    assert.ok(published.some((e) => e.kind === "usage-stopped.updated"));

    const back = await h["usage-stopped:apply"]({ selected: [] });
    assert.equal(back.ok, true, "unchecking the only armed row is applicable");
    assert.deepEqual(back.applied.disarmed, ["ses_1"]);
  });

  test("usage:alerts / usage:remind-at-reset", async () => {
    const { deps, alerts } = setup();
    const h = buildHandlers(deps);
    const empty = await h["usage:alerts"]();
    assert.deepEqual([empty.supported, empty.bootId, empty.revision, empty.alerts], [true, "boot-test", 0, []]);

    const future = Date.now() + 3_600_000;
    const snap = (pct) => [{ provider: "claude", providerIDs: ["anthropic"], windows: [{ kind: "weekly", label: "Weekly", pct, resetsAt: future }] }];
    alerts.observe(snap(10));
    alerts.observe(snap(100));
    const list = await h["usage:alerts"]();
    assert.equal(list.revision, 1);
    assert.equal(list.alerts[0].level, "limit");

    const noSession = await h["usage:remind-at-reset"]({ key: "claude:weekly" });
    assert.deepEqual([noSession.ok, noSession.code], [false, "no-session"]);
    const noReset = await h["usage:remind-at-reset"]({ key: "claude:unknown", sessionID: "ses_1" });
    assert.deepEqual([noReset.ok, noReset.code], [false, "no-reset"]);
  });

  test("usage:alerts / usage:remind-at-reset answer before the poller exists", async () => {
    const { deps } = setup();
    deps.getUsageAlerts = () => null;
    const h = buildHandlers(deps);
    assert.deepEqual(await h["usage:alerts"](), { supported: true, bootId: null, revision: 0, alerts: [] });
    assert.equal((await h["usage:remind-at-reset"]({ key: "x", sessionID: "s" })).ok, false);
  });
});
