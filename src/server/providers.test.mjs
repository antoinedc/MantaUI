// Tests for src/server/providers.mjs
//
// Pure helper tests (no I/O) + handler tests that mock the opencode HTTP
// endpoint and the local opencode.jsonc file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse as parseJsonc } from "jsonc-parser";
import {
  parseModelsResponse,
  upsertProviderBlock,
  readProviderEndpoints,
  findStoredApiKey,
  discoverModels,
  discoverModelsForEndpoint,
  setProviders,
  editConfig,
  migrateLegacyWhitelists,
  disabledMarkerOps,
  disabledModelIds,
  opencodeConfigPath,
  getProviderEndpoints,
  upsertAgentBlock,
  readAgentBlocks,
  getSubagents,
  setSubagents,
  setSkillRegistryUrls,
  syncSubagents,
  setReferences,
  setModelCost,
  mantaPlanAgentBlock,
  ensureMantaPlanAgent,
  selectCacheTtlTargets,
  resolveCacheTtlFromConfig,
  planCacheTtlOps,
  syncCacheTtl,
  readCacheTtl,
  ensureCtoAgent,
  ctoAgentBlock,
  startCtoAgentRecovery,
  ctoPromptPath,
  ctoMaterializedPromptPath,
  materializeCtoPrompt,
  refreshCtoDoctrine,
  createCtoDoctrineRestarter,
} from "./providers.mjs";

// ---------------------------------------------------------------------------
// Shared writer-harness helper.
//
// Every config writer (providers, subagents, references, skill registries, the
// CTO agents, the cache TTL) goes through ONE editConfig, so one in-memory
// opencode.jsonc + recording reload serves them all. Nothing here touches the
// real file or a live opencode.
// ---------------------------------------------------------------------------

function memConfig(initial = "{}", { reload } = {}) {
  const state = { text: initial, writes: 0, reloads: 0, config: () => parseJsonc(state.text) };
  const deps = {
    readText: async () => state.text,
    writeText: async (t) => { state.writes += 1; state.text = t; },
    reload: reload ?? (async () => { state.reloads += 1; return { ok: true, reloaded: true }; }),
    // setProviders' catalog source: nothing hidden unless a test says so, and
    // no settle wait (the loop below has its own test).
    listModelIds: async () => [],
    settleMs: 0,
  };
  return { state, deps };
}

// ---------------------------------------------------------------------------
// parseModelsResponse
// ---------------------------------------------------------------------------

describe("parseModelsResponse", () => {
  it("parses a valid OpenAI-compatible /models response", () => {
    const body = JSON.stringify({
      data: [
        { id: "gpt-4o" },
        { id: "gpt-4o-mini" },
        { id: "o1" },
      ],
    });
    const result = parseModelsResponse(body);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.models, [
        { id: "gpt-4o" },
        { id: "gpt-4o-mini" },
        { id: "o1" },
      ]);
    }
  });

  it("returns bad_response for non-JSON body", () => {
    const result = parseModelsResponse("not json");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "bad_response");
    }
  });

  it("returns bad_response when data is not an array", () => {
    const result = parseModelsResponse(JSON.stringify({ data: "not-array" }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "bad_response");
    }
  });

  it("returns bad_response for empty data array", () => {
    const result = parseModelsResponse(JSON.stringify({ data: [] }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.models, []);
    }
  });

  it("detects auth errors in 200 JSON response", () => {
    const body = JSON.stringify({
      error: { message: "Invalid API key", code: "invalid_api_key" },
    });
    const result = parseModelsResponse(body);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "unauthorized");
    }
  });

  it("does NOT treat error:null as auth error (success with null error)", () => {
    const body = JSON.stringify({
      data: [{ id: "test-model" }],
      error: null,
    });
    const result = parseModelsResponse(body);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.models.length, 1);
      assert.equal(result.models[0].id, "test-model");
    }
  });

  it("filters out models with empty id", () => {
    const body = JSON.stringify({
      data: [{ id: "valid" }, { id: "" }, { id: null }, {}],
    });
    const result = parseModelsResponse(body);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.models, [{ id: "valid" }]);
    }
  });

  it("handles non-object entries in data array", () => {
    const body = JSON.stringify({ data: ["string", 42, null, { id: "ok" }] });
    const result = parseModelsResponse(body);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.models, [{ id: "ok" }]);
    }
  });
});

// ---------------------------------------------------------------------------
// upsertProviderBlock
// ---------------------------------------------------------------------------

describe("upsertProviderBlock", () => {
  it("adds a new provider to an empty config", () => {
    const cfg = {};
    const result = upsertProviderBlock(cfg, {
      id: "myprovider",
      name: "My Provider",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      enabledModels: ["model-a", "model-b"],
    });
    assert.deepEqual(result.provider["myprovider"], {
      npm: "@ai-sdk/openai-compatible",
      name: "My Provider",
      options: {
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
      },
      models: {
        "model-a": { id: "model-a", name: "model-a" },
        "model-b": { id: "model-b", name: "model-b" },
      },
    });
  });

  // V2 IGNORES `whitelist` (proven on the pinned binary: a whitelisted
  // openrouter block still listed all 385 catalog models). The block lists
  // exactly the selection; hiding the rest of a catalog provider is
  // disabledMarkerOps' job, under the native `providers` key.
  it("never writes a whitelist — V2 ignores it", () => {
    const result = upsertProviderBlock({}, {
      id: "openrouter",
      name: "Openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "k",
      enabledModels: ["deepseek/deepseek-v4-flash"],
    });
    assert.equal("whitelist" in result.provider.openrouter, false);
    assert.deepEqual(Object.keys(result.provider.openrouter.models), ["deepseek/deepseek-v4-flash"]);
  });

  it("preserves other config keys when adding a provider", () => {
    const cfg = { skills: { urls: ["https://example.com/skills"] } };
    const result = upsertProviderBlock(cfg, {
      id: "p1",
      name: "P1",
      baseURL: "https://p1.example.com",
      apiKey: "key1",
      enabledModels: ["m1"],
    });
    assert.deepEqual(result.skills, { urls: ["https://example.com/skills"] });
    assert.ok(result.provider);
    assert.ok(result.provider.p1);
  });

  it("replaces an existing provider block", () => {
    const cfg = {
      provider: {
        old: {
          npm: "old-npm",
          name: "Old",
          options: { baseURL: "https://old.com", apiKey: "old-key" },
          models: { oldModel: { id: "oldModel", name: "oldModel" } },
        },
      },
    };
    const result = upsertProviderBlock(cfg, {
      id: "old",
      name: "New Name",
      baseURL: "https://new.com",
      apiKey: "new-key",
      enabledModels: ["newModel"],
    });
    assert.equal(result.provider.old.name, "New Name");
    assert.equal(result.provider.old.options.baseURL, "https://new.com");
    assert.equal(result.provider.old.options.apiKey, "new-key");
    assert.deepEqual(Object.keys(result.provider.old.models), ["newModel"]);
  });

  it("keeps existing apiKey when input.apiKey is undefined", () => {
    const cfg = {
      provider: {
        existing: {
          npm: "@ai-sdk/openai-compatible",
          name: "Existing",
          options: { baseURL: "https://ex.com", apiKey: "secret-kept" },
          models: {},
        },
      },
    };
    const result = upsertProviderBlock(cfg, {
      id: "existing",
      name: "Existing",
      baseURL: "https://ex.com",
      // apiKey intentionally omitted
      enabledModels: [],
    });
    assert.equal(
      result.provider.existing.options.apiKey,
      "secret-kept",
    );
  });

  it("sets apiKey to empty string when explicitly provided as empty", () => {
    const cfg = {
      provider: {
        existing: {
          npm: "@ai-sdk/openai-compatible",
          name: "Existing",
          options: { baseURL: "https://ex.com", apiKey: "secret" },
          models: {},
        },
      },
    };
    const result = upsertProviderBlock(cfg, {
      id: "existing",
      name: "Existing",
      baseURL: "https://ex.com",
      apiKey: "",
      enabledModels: [],
    });
    assert.equal(result.provider.existing.options.apiKey, "");
  });
});

// ---------------------------------------------------------------------------
// readProviderEndpoints
// ---------------------------------------------------------------------------

describe("readProviderEndpoints", () => {
  it("projects provider map to renderer-safe metadata", () => {
    const cfg = {
      provider: {
        anthropic: {
          npm: "@ai-sdk/anthropic",
          name: "Anthropic",
          options: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-..." },
          models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" } },
        },
      },
    };
    const endpoints = readProviderEndpoints(cfg);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].id, "anthropic");
    assert.equal(endpoints[0].name, "Anthropic");
    // stripUrlUserinfo preserves trailing slash (only scrubs userinfo);
    // normBaseURL (used by findStoredApiKey) strips it.
    assert.equal(endpoints[0].baseURL, "https://api.anthropic.com/");
    assert.equal(endpoints[0].hasApiKey, true);
    assert.deepEqual(endpoints[0].enabledModels, ["claude-sonnet-4-6"]);
  });

  // V2 hides a catalog model with the NATIVE `providers.<id>.models.<m>.disabled`
  // marker; the selection shown in the card is `models` minus those.
  it("derives enabledModels from models minus the native disabled markers", () => {
    const cfg = {
      provider: {
        openrouter: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://openrouter.ai/api/v1", apiKey: "k" },
          models: { a: { id: "a" }, b: { id: "b" } },
        },
      },
      providers: { openrouter: { models: { b: { disabled: true }, c: { disabled: true } } } },
    };
    assert.deepEqual(readProviderEndpoints(cfg)[0].enabledModels, ["a"]);
  });

  // A pre-cutover file still carries the V1 whitelist; it is inert in V2 but
  // still names what the user chose, so the card shows it until re-saved.
  it("shows a legacy whitelist as the selection until the endpoint is re-saved", () => {
    const cfg = {
      provider: {
        openrouter: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://openrouter.ai/api/v1", apiKey: "k" },
          whitelist: ["a"],
          models: { a: { id: "a" }, b: { id: "b" } },
        },
      },
    };
    assert.deepEqual(readProviderEndpoints(cfg)[0].enabledModels, ["a"]);
  });

  it("scrubs userinfo from baseURL", () => {
    const cfg = {
      provider: {
        custom: {
          npm: "@ai-sdk/openai-compatible",
          name: "Custom",
          options: { baseURL: "https://user:pass@host.com/v1", apiKey: "k" },
          models: {},
        },
      },
    };
    const endpoints = readProviderEndpoints(cfg);
    assert.equal(endpoints[0].baseURL, "https://host.com/v1");
  });

  it("uses id as name when name is missing", () => {
    const cfg = {
      provider: {
        bare: { npm: "x", options: { baseURL: "https://bare.example/v1" }, models: {} },
      },
    };
    const endpoints = readProviderEndpoints(cfg);
    assert.equal(endpoints[0].name, "bare");
  });

  it("returns empty array for config with no providers", () => {
    assert.deepEqual(readProviderEndpoints({}), []);
  });

  // REGRESSION: plugin-authed provider blocks (e.g. anthropic via
  // opencode-claude-auth) have no options.baseURL. They must NOT be projected
  // into the ProvidersCard: the card's Refresh would fetch `"" + "/models"`
  // ("unreachable: could not reach the endpoint"), and a model toggle / remove
  // on the row would rewrite the block as an @ai-sdk/openai-compatible
  // endpoint with an empty baseURL, corrupting the plugin auth.
  it("excludes plugin-authed blocks without a baseURL (anthropic)", () => {
    const cfg = {
      provider: {
        anthropic: {
          // Real shape from a claude-auth setup: models but no options.baseURL.
          models: { "claude-opus-4-8": { id: "claude-opus-4-8" } },
        },
        voska: {
          npm: "@ai-sdk/openai-compatible",
          name: "VoskaAI",
          options: { baseURL: "https://api.voska.org/v1", apiKey: "k" },
          models: { "qwen3.6-27b": {} },
        },
      },
    };
    const endpoints = readProviderEndpoints(cfg);
    assert.deepEqual(endpoints.map((e) => e.id), ["voska"]);
  });
});

// ---------------------------------------------------------------------------
// findStoredApiKey
// ---------------------------------------------------------------------------

describe("findStoredApiKey", () => {
  it("finds apiKey by normalized baseURL match", () => {
    const cfg = {
      provider: {
        p1: {
          npm: "x",
          name: "P1",
          options: { baseURL: "https://api.example.com/v1/", apiKey: "found-it" },
          models: {},
        },
      },
    };
    // Input has trailing slash stripped — should still match
    assert.equal(findStoredApiKey(cfg, "https://api.example.com/v1"), "found-it");
  });

  it("returns empty string when no provider matches", () => {
    const cfg = {
      provider: {
        p1: {
          npm: "x",
          name: "P1",
          options: { baseURL: "https://api.example.com", apiKey: "key1" },
          models: {},
        },
      },
    };
    assert.equal(findStoredApiKey(cfg, "https://other.example.com"), "");
  });

  it("returns empty string when matched provider has no key", () => {
    const cfg = {
      provider: {
        p1: {
          npm: "x",
          name: "P1",
          options: { baseURL: "https://api.example.com" },
          models: {},
        },
      },
    };
    assert.equal(findStoredApiKey(cfg, "https://api.example.com"), "");
  });
});

// ---------------------------------------------------------------------------
// stripUrlUserinfo (indirectly tested via readProviderEndpoints + findStoredApiKey)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// discoverModels — handler test (mocks global fetch)
// ---------------------------------------------------------------------------

describe("discoverModels", () => {
  const origFetch = globalThis.fetch;

  it("returns parsed models from a successful /models endpoint", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const result = await discoverModels("https://api.example.com/v1", "sk-test");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.models.length, 2);
      assert.equal(result.models[0].id, "m1");
    }
    globalThis.fetch = origFetch;
  });

  it("returns unauthorized for 401 auth errors", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    const result = await discoverModels("https://api.example.com/v1", "bad-key");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "unauthorized");
    }
    globalThis.fetch = origFetch;
  });

  it("returns unreachable on network failure", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await discoverModels("https://unreachable.local/v1", "");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "unreachable");
    }
    globalThis.fetch = origFetch;
  });

  // REGRESSION: an empty baseURL used to reach fetch("/models") and surface as
  // a misleading "unreachable: could not reach the endpoint". It must return a
  // clear bad_response without touching the network.
  it("returns bad_response (not unreachable) for an empty baseURL", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch must not be called for an empty baseURL");
    };
    for (const bad of ["", "   ", undefined, null]) {
      const result = await discoverModels(bad, "");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, "bad_response");
        assert.match(result.detail ?? "", /no baseURL/);
      }
    }
    globalThis.fetch = origFetch;
  });

  it("returns bad_response for non-JSON body", async () => {
    globalThis.fetch = async () =>
      new Response("not json at all", { status: 200 });
    const result = await discoverModels("https://api.example.com/v1", "");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "bad_response");
    }
    globalThis.fetch = origFetch;
  });
});

// ---------------------------------------------------------------------------
// getProviderEndpoints — the config-reading path backing "opencode:get-providers"
// (BET-114). Must return a ProviderEndpoint[] (ARRAY) projected from
// opencode.jsonc, NOT the raw /provider HTTP object { all, connected, default }.
// readConfig is injected so we don't touch the real ~/.config/opencode file.
// ---------------------------------------------------------------------------

describe("getProviderEndpoints", () => {
  const VOSKA_CFG = {
    provider: {
      voska: {
        npm: "@ai-sdk/openai-compatible",
        name: "Voska AI",
        options: { baseURL: "https://api.voska.org/v1", apiKey: "vk-secret" },
        models: { "voska-large": { id: "voska-large", name: "voska-large" } },
      },
    },
  };

  it("returns a ProviderEndpoint[] array (not the raw {all,connected,default} object)", async () => {
    const cfg = VOSKA_CFG;
    const result = await getProviderEndpoints(async () => cfg);
    // BET-114 regression: the handler must hand the form an ARRAY of endpoints.
    assert.ok(Array.isArray(result), "expected an array, not the raw provider object");
    assert.ok(!("all" in result), "must not be the raw /provider { all, connected, default } shape");
  });

  it("prefills a configured custom provider (Voska AI) with renderer-safe metadata", async () => {
    const cfg = VOSKA_CFG;
    const result = await getProviderEndpoints(async () => cfg);
    const voska = result.find((e) => e.id === "voska");
    assert.ok(voska, "Voska AI provider should be surfaced to the form");
    assert.equal(voska.name, "Voska AI");
    assert.equal(voska.baseURL, "https://api.voska.org/v1");
    assert.equal(voska.hasApiKey, true); // presence only — the secret never leaves the box
    assert.deepEqual(voska.enabledModels, ["voska-large"]);
  });

  it("returns [] when the config reader throws (unparseable/absent config)", async () => {
    const result = await getProviderEndpoints(async () => {
      throw new Error("unparseable");
    });
    assert.deepEqual(result, []);
  });

  it("returns [] for a config with no providers", async () => {
    const result = await getProviderEndpoints(async () => ({}));
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// setProviders — the provider writer. One editConfig (one write, one reload),
// then the selection reconcile for catalog providers. In-memory file + stubbed
// reload / model list: nothing touches the live opencode or the real file.
// ---------------------------------------------------------------------------

const VOSKA = { id: "voska", name: "Voska AI", baseURL: "https://api.voska.org/v1", apiKey: "sk", enabledModels: ["voska-1"] };

describe("setProviders", () => {
  it("upserts a provider block in ONE write and ONE reload, comments kept", async () => {
    const { state, deps } = memConfig('{\n  // keep me\n  "model": "x/y"\n}');
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.ok(state.text.includes("// keep me"));
    const block = state.config().provider.voska;
    assert.equal(block.name, "Voska AI");
    assert.equal(block.npm, "@ai-sdk/openai-compatible");
    assert.equal(block.options.baseURL, "https://api.voska.org/v1");
    assert.equal(block.options.apiKey, "sk");
    assert.deepEqual(Object.keys(block.models), ["voska-1"]);
    assert.equal("whitelist" in block, false);
    assert.equal(state.config().model, "x/y");
  });

  it("keeps the stored apiKey when the renderer omits it, plus keys manta does not manage", async () => {
    const existing = {
      provider: {
        voska: {
          npm: "@ai-sdk/openai-compatible",
          name: "Voska AI",
          headers: { "x-team": "t" },
          options: { baseURL: "https://api.voska.org/v1", apiKey: "stored-secret" },
          models: { "voska-1": { id: "voska-1", options: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
        },
      },
    };
    const { state, deps } = memConfig(JSON.stringify(existing));
    const { apiKey: _omit, ...noKey } = VOSKA;
    await setProviders({ upsert: [{ ...noKey, enabledModels: ["voska-1", "voska-2"] }] }, deps);
    const block = state.config().provider.voska;
    assert.equal(block.options.apiKey, "stored-secret");
    assert.deepEqual(block.headers, { "x-team": "t" });
    assert.deepEqual(block.models["voska-1"].options.cacheControl, { type: "ephemeral", ttl: "1h" }, "a retained model keeps its per-model options");
    assert.deepEqual(Object.keys(block.models).sort(), ["voska-1", "voska-2"]);
  });

  it("a deselected model leaves the block's models (no lingering entry)", async () => {
    const existing = { provider: { voska: { npm: "x", name: "V", options: { baseURL: "https://a/v1", apiKey: "k" }, models: { a: { id: "a" }, b: { id: "b" } } } } };
    const { state, deps } = memConfig(JSON.stringify(existing));
    await setProviders({ upsert: [{ id: "voska", name: "V", baseURL: "https://a/v1", enabledModels: ["a"] }] }, deps);
    assert.deepEqual(Object.keys(state.config().provider.voska.models), ["a"]);
  });

  it("strips a legacy whitelist when the endpoint is re-saved", async () => {
    const existing = { provider: { voska: { npm: "x", name: "V", options: { baseURL: "https://a/v1", apiKey: "k" }, whitelist: ["a", "b"], models: {} } } };
    const { state, deps } = memConfig(JSON.stringify(existing));
    await setProviders({ upsert: [{ id: "voska", name: "V", baseURL: "https://a/v1", enabledModels: ["a"] }] }, deps);
    assert.equal("whitelist" in state.config().provider.voska, false);
  });

  it("a remove deletes the endpoint AND its native disable markers, with a single reload", async () => {
    const existing = {
      provider: { voska: { name: "V", options: { baseURL: "https://a/v1" }, models: {} }, keep: { name: "K" } },
      providers: { voska: { models: { x: { disabled: true } } } },
    };
    const { state, deps } = memConfig(JSON.stringify(existing));
    const result = await setProviders({ remove: ["voska"] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.reloads, 1);
    const cfg = state.config();
    assert.equal(cfg.provider.voska, undefined);
    assert.equal(cfg.providers?.voska, undefined);
    assert.deepEqual(cfg.provider.keep, { name: "K" });
  });

  it("a mixed upsert+remove batch is ONE write and ONE reload", async () => {
    const { state, deps } = memConfig(JSON.stringify({ provider: { old: { name: "Old" } } }));
    const result = await setProviders({ upsert: [VOSKA], remove: ["old"] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.equal(state.config().provider.old, undefined);
    assert.ok(state.config().provider.voska);
  });

  it("an empty batch touches nothing", async () => {
    const { state, deps } = memConfig();
    assert.deepEqual(await setProviders({}, deps), { ok: true });
    assert.equal(state.writes + state.reloads, 0);
  });

  it("hides the unselected models of a CATALOG provider with native disabled markers", async () => {
    const { state, deps } = memConfig();
    const catalog = ["m1", "m2", "m3", "m4"];
    // V2 lists the catalog once the block exists (the selected one is in `models`).
    deps.listModelIds = async (id) => (id === "openrouter" ? catalog : []);
    const result = await setProviders(
      { upsert: [{ id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", apiKey: "k", enabledModels: ["m2"] }] },
      deps,
    );
    assert.equal(result.ok, true);
    const cfg = state.config();
    assert.deepEqual(Object.keys(cfg.provider.openrouter.models), ["m2"]);
    assert.deepEqual(cfg.providers.openrouter.models, { m1: { disabled: true }, m3: { disabled: true }, m4: { disabled: true } });
    assert.equal(state.writes, 2, "provider block, then the markers");
    assert.equal(state.reloads, 2, "each write is reloaded, so V2 can list the catalog before the markers");
  });

  it("re-enabling a model removes its marker; an empty marker block disappears", async () => {
    const existing = { providers: { openrouter: { models: { m1: { disabled: true }, m3: { disabled: true } } } } };
    const { state, deps } = memConfig(JSON.stringify(existing));
    await setProviders({ upsert: [{ id: "openrouter", name: "O", baseURL: "https://o/v1", apiKey: "k", enabledModels: ["m1", "m3"] }] }, deps);
    assert.equal(state.config().providers?.openrouter, undefined);
  });

  it("a custom endpoint whose catalog IS its selection gets no markers (one write)", async () => {
    const { state, deps } = memConfig();
    deps.listModelIds = async () => ["voska-1"];
    await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(state.writes, 1);
    assert.equal(state.config().providers, undefined);
  });

  it("waits (bounded) for V2's registry to catch up with the reload before reading the catalog", async () => {
    const { state, deps } = memConfig();
    let calls = 0;
    // The first two reads happen before V2 has the new provider; the third has it.
    deps.listModelIds = async () => (++calls < 3 ? [] : ["m1", "m2", "m3"]);
    deps.settleMs = 5000;
    deps.sleep = async () => {};
    await setProviders({ upsert: [{ id: "openrouter", name: "O", baseURL: "https://o/v1", apiKey: "k", enabledModels: ["m2"] }] }, deps);
    assert.equal(calls, 3);
    assert.deepEqual(state.config().providers.openrouter.models, { m1: { disabled: true }, m3: { disabled: true } });
  });

  it("gives up waiting at the deadline and saves what it has (never hangs the save)", async () => {
    const { state, deps } = memConfig();
    let calls = 0;
    deps.listModelIds = async () => { calls++; return []; };
    deps.settleMs = 1;
    deps.sleep = async () => { await new Promise((r) => setTimeout(r, 3)); };
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, true);
    assert.ok(calls >= 1);
    assert.ok(state.config().provider.voska);
  });

  it("an unreachable model list does not fail the save (markers just are not extended)", async () => {
    const { state, deps } = memConfig();
    deps.listModelIds = async () => { throw new Error("opencode down"); };
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.writes, 1);
  });

  it("surfaces a reload the server rejected (never reports success over a stale live config)", async () => {
    const { deps } = memConfig();
    deps.reload = async () => ({ ok: false, error: "opencode config reload failed (500): boom" });
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  });

  it("opencode simply not running is fine — the edit is on disk for its next start", async () => {
    const { state, deps } = memConfig();
    deps.reload = async () => ({ ok: true, reloaded: false, reason: "opencode unreachable" });
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, true);
    assert.ok(state.config().provider.voska);
  });

  it("refuses an unparseable config and writes nothing", async () => {
    const { state, deps } = memConfig("{ not json");
    const result = await setProviders({ upsert: [VOSKA] }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /unparseable/);
    assert.equal(state.writes, 0);
  });
});

describe("disabledMarkerOps / disabledModelIds", () => {
  it("disabledModelIds reads the native markers only", () => {
    const cfg = { providers: { p: { models: { a: { disabled: true }, b: { name: "b" }, c: { disabled: false } } } } };
    assert.deepEqual(disabledModelIds(cfg, "p"), ["a"]);
    assert.deepEqual(disabledModelIds({}, "p"), []);
  });

  it("is null when the markers already match", () => {
    const cfg = { providers: { p: { models: { a: { disabled: true } } } } };
    assert.equal(disabledMarkerOps(cfg, "p", ["b"], ["a", "b"]), null);
  });

  it("keeps non-marker keys under providers.<id>.models and only rewrites markers", () => {
    const cfg = { providers: { p: { models: { keep: { name: "k" }, a: { disabled: true } } } } };
    const [edit] = disabledMarkerOps(cfg, "p", ["z"], ["b"]);
    assert.deepEqual(edit.path, ["providers", "p", "models"]);
    assert.deepEqual(edit.value, { keep: { name: "k" }, a: { disabled: true }, b: { disabled: true } });
  });
});

describe("migrateLegacyWhitelists", () => {
  const legacy = {
    provider: {
      openrouter: { npm: "x", name: "O", options: { baseURL: "https://o/v1", apiKey: "k" }, whitelist: ["m2"], models: { m2: { id: "m2" } } },
      plain: { npm: "x", name: "P", options: { baseURL: "https://p/v1" }, models: { a: { id: "a" } } },
    },
  };

  it("drops the inert whitelist and hides the unselected catalog models natively", async () => {
    const { state, deps } = memConfig(JSON.stringify(legacy));
    deps.readConfig = async () => state.config();
    deps.listModelIds = async (id) => (id === "openrouter" ? ["m1", "m2", "m3"] : []);
    const r = await migrateLegacyWhitelists(deps);
    assert.deepEqual(r, { ok: true, migrated: ["openrouter"] });
    const cfg = state.config();
    assert.equal("whitelist" in cfg.provider.openrouter, false);
    assert.deepEqual(Object.keys(cfg.provider.openrouter.models), ["m2"]);
    assert.deepEqual(cfg.providers.openrouter.models, { m1: { disabled: true }, m3: { disabled: true } });
    assert.deepEqual(cfg.provider.plain.models, { a: { id: "a" } });
  });

  it("is idempotent: a migrated config is a no-op (no write, no reload)", async () => {
    const { state, deps } = memConfig(JSON.stringify(legacy));
    deps.readConfig = async () => state.config();
    deps.listModelIds = async () => ["m1", "m2", "m3"];
    await migrateLegacyWhitelists(deps);
    const before = { writes: state.writes, reloads: state.reloads };
    const again = await migrateLegacyWhitelists(deps);
    assert.deepEqual(again, { ok: true, migrated: [] });
    assert.deepEqual({ writes: state.writes, reloads: state.reloads }, before);
  });
});

// ---------------------------------------------------------------------------
// discoverModelsForEndpoint — the ProvidersCard Refresh entrypoint
// ---------------------------------------------------------------------------

describe("discoverModelsForEndpoint", () => {
  const origFetch = globalThis.fetch;
  const okResponse = () =>
    new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  const cfgWithKey = {
    provider: {
      voska: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.voska.org/v1", apiKey: "stored-secret" },
        models: {},
      },
    },
  };

  it("recovers the stored api key when the renderer sends an empty key (Refresh contract)", async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      seen.push({ url: String(url), auth: opts?.headers?.Authorization ?? "" });
      return okResponse();
    };
    try {
      const result = await discoverModelsForEndpoint(
        "https://api.voska.org/v1", "", async () => cfgWithKey,
      );
      assert.equal(result.ok, true);
      assert.equal(seen[0].auth, "Bearer stored-secret");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("uses an explicit api key as-is without reading the config", async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      seen.push({ auth: opts?.headers?.Authorization ?? "" });
      return okResponse();
    };
    try {
      const result = await discoverModelsForEndpoint(
        "https://api.voska.org/v1", "explicit",
        async () => { throw new Error("readConfig must not be called"); },
      );
      assert.equal(result.ok, true);
      assert.equal(seen[0].auth, "Bearer explicit");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("degrades to keyless discovery when the config is unreadable", async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      seen.push({ auth: opts?.headers?.Authorization ?? "" });
      return okResponse();
    };
    try {
      const result = await discoverModelsForEndpoint(
        "https://public.example/v1", "", async () => { throw new Error("boom"); },
      );
      assert.equal(result.ok, true);
      assert.equal(seen[0].auth, "", "no Authorization header sent");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("still rejects an empty baseURL with a clear error (no network)", async () => {
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    try {
      const result = await discoverModelsForEndpoint("", "", async () => cfgWithKey);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, "bad_response");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Subagent block manipulation
// ---------------------------------------------------------------------------

describe("upsertAgentBlock", () => {
  it("inserts a new agent", () => {
    const cfg = {};
    const result = upsertAgentBlock(cfg, {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "Fast worker for mechanical tasks",
    });
    assert.deepEqual(result.agent.fast, {
      model: "anthropic/claude-haiku-4",
      description: "Fast worker for mechanical tasks",
      mode: "subagent",
    });
  });

  it("preserves other keys in config", () => {
    const cfg = { provider: { openai: {} }, other: "data" };
    const result = upsertAgentBlock(cfg, {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "Fast",
    });
    assert.deepEqual(result.provider, { openai: {} });
    assert.equal(result.other, "data");
  });

  it("forces mode to subagent", () => {
    const cfg = {};
    const result = upsertAgentBlock(cfg, {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "Fast",
    });
    assert.equal(result.agent.fast.mode, "subagent");
  });

  it("replaces an existing agent", () => {
    const cfg = {
      agent: {
        fast: {
          model: "anthropic/claude-haiku-3",
          description: "Old",
          mode: "subagent",
        },
      },
    };
    const result = upsertAgentBlock(cfg, {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "New",
    });
    assert.equal(result.agent.fast.model, "anthropic/claude-haiku-4");
    assert.equal(result.agent.fast.description, "New");
  });
});

describe("readAgentBlocks", () => {
  it("projects model-having agents", () => {
    const cfg = {
      agent: {
        fast: {
          model: "anthropic/claude-haiku-4",
          description: "Fast worker",
          mode: "subagent",
        },
        deep: {
          model: "anthropic/claude-opus-4",
          description: "Deep thinker",
          mode: "subagent",
        },
      },
    };
    const result = readAgentBlocks(cfg);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "Fast worker",
    });
    assert.deepEqual(result[1], {
      name: "deep",
      model: "anthropic/claude-opus-4",
      description: "Deep thinker",
    });
  });

  it("skips agents without a model (built-in agents)", () => {
    const cfg = {
      agent: {
        fast: { model: "anthropic/claude-haiku-4", description: "Fast", mode: "subagent" },
        explore: { description: "Built-in explore agent", mode: "subagent" },
      },
    };
    const result = readAgentBlocks(cfg);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "fast");
  });

  it("defaults missing description to empty string", () => {
    const cfg = {
      agent: {
        fast: { model: "anthropic/claude-haiku-4", mode: "subagent" },
      },
    };
    const result = readAgentBlocks(cfg);
    assert.equal(result[0].description, "");
  });

  it("returns empty array when no agent key", () => {
    const cfg = {};
    const result = readAgentBlocks(cfg);
    assert.deepEqual(result, []);
  });

  it("returns empty array when agent is not an object", () => {
    const cfg = { agent: "not-an-object" };
    const result = readAgentBlocks(cfg);
    assert.deepEqual(result, []);
  });
});

describe("getSubagents", () => {
  it("projects agent blocks via injected readConfig", async () => {
    const mockConfig = {
      agent: {
        fast: { model: "anthropic/claude-haiku-4", description: "Fast", mode: "subagent" },
      },
    };
    const result = await getSubagents(async () => mockConfig);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "fast");
  });

  it("returns empty array on unparseable config", async () => {
    const result = await getSubagents(async () => { throw new Error("parse error"); });
    assert.deepEqual(result, []);
  });
});

describe("setSubagents", () => {
  it("writes agent.<name> in ONE write and ONE reload — no restart", async () => {
    const { state, deps } = memConfig('{\n  // keep\n  "agent": { "old": { "model": "a/b", "mode": "subagent" } }\n}');
    const result = await setSubagents(
      { upsert: [{ name: "fast", model: "anthropic/claude-haiku-4", description: "New fast" }] },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.ok(state.text.includes("// keep"));
    const cfg = state.config();
    assert.deepEqual(cfg.agent.fast, { model: "anthropic/claude-haiku-4", description: "New fast", mode: "subagent" });
    assert.ok(cfg.agent.old, "only the changed agent is touched");
  });

  it("keeps the keys of an existing block that manta does not manage", async () => {
    const { state, deps } = memConfig(JSON.stringify({ agent: { fast: { model: "a/b", mode: "subagent", temperature: 0.2 } } }));
    await setSubagents({ upsert: [{ name: "fast", model: "a/c", description: "d" }] }, deps);
    assert.equal(state.config().agent.fast.temperature, 0.2);
    assert.equal(state.config().agent.fast.model, "a/c");
  });

  it("a remove deletes the block with a reload (the restart is gone)", async () => {
    const { state, deps } = memConfig(JSON.stringify({ agent: { haiku: { model: "a/b", mode: "subagent" }, keep: { model: "a/c", mode: "subagent" } } }));
    const result = await setSubagents({ remove: ["haiku"] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.reloads, 1);
    assert.deepEqual(Object.keys(state.config().agent), ["keep"]);
  });

  it("a mixed upsert+remove batch is a single write and reload", async () => {
    const { state, deps } = memConfig(JSON.stringify({ agent: { haiku: { model: "a/b", mode: "subagent" } } }));
    const result = await setSubagents(
      { upsert: [{ name: "fast", model: "anthropic/claude-haiku-4", description: "Fast" }], remove: ["haiku"] },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.deepEqual(Object.keys(state.config().agent), ["fast"]);
  });

  it("surfaces a failed write and removes nothing", async () => {
    const { state, deps } = memConfig(JSON.stringify({ agent: { haiku: { model: "a/b", mode: "subagent" } } }));
    deps.writeText = async () => { throw new Error("disk full"); };
    const result = await setSubagents({ upsert: [{ name: "fast", model: "x", description: "F" }], remove: ["haiku"] }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /disk full/);
    assert.ok(state.config().agent.haiku, "a failed batch leaves the file as it was");
  });
});

// ---------------------------------------------------------------------------
// setSkillRegistryUrls — the BET-1031 writer. Routes the user's registry list
// to opencode's `skills.urls`, touching only the `urls` key so unrelated keys
// are preserved.
// ---------------------------------------------------------------------------

describe("setSkillRegistryUrls", () => {
  it("writes skills.urls with the given list and reloads", async () => {
    const { state, deps } = memConfig();
    const result = await setSkillRegistryUrls(["https://example.com/a.json", "https://example.com/b.json"], deps);
    assert.equal(result.ok, true);
    assert.deepEqual(state.config(), { skills: { urls: ["https://example.com/a.json", "https://example.com/b.json"] } });
    assert.equal(state.reloads, 1);
  });

  it("touches only urls, never other skills keys", async () => {
    const { state, deps } = memConfig(JSON.stringify({ skills: { urls: ["old"], paths: ["/x"] } }));
    await setSkillRegistryUrls(["https://example.com/a.json"], deps);
    assert.deepEqual(state.config().skills, { urls: ["https://example.com/a.json"], paths: ["/x"] });
  });

  it("normalizes a non-array value to an empty list (defensive, no throw)", async () => {
    const { state, deps } = memConfig();
    const result = await setSkillRegistryUrls(null, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(state.config().skills.urls, []);
  });

  it("propagates a rejected reload back to the caller", async () => {
    const { deps } = memConfig();
    deps.reload = async () => ({ ok: false, error: "opencode config reload failed (500): boom" });
    const result = await setSkillRegistryUrls(["https://example.com/a.json"], deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /reload failed/);
  });
});

// ---------------------------------------------------------------------------
// syncSubagents — the BET-123 auto-register reconciliation entrypoint.
// readConfig + applySubagents are both injectable, so these tests never
// touch the real opencode.jsonc.
// ---------------------------------------------------------------------------

describe("syncSubagents", () => {
  const haiku = { providerID: "anthropic", id: "claude-haiku-4" };
  const opus = { providerID: "anthropic", id: "claude-opus-4" };

  it("deactivating a worker model preserves primary CTO roles sharing that model", async () => {
    const calls = [];
    const cfg = { agent: {
      cto: { model: "anthropic/claude-opus-4", mode: "primary" },
      "cto-plan": { model: "anthropic/claude-opus-4", mode: "primary" },
      opus: { model: "anthropic/claude-opus-4", mode: "subagent" },
    } };
    await syncSubagents(
      { models: [opus], deactivated: ["anthropic/claude-opus-4"] },
      async () => cfg,
      async ops => { calls.push(ops); return { ok: true }; },
    );
    assert.deepEqual(calls, [{ upsert: [], remove: ["opus"] }]);
    assert.deepEqual(readAgentBlocks(cfg).map(a => a.name), ["opus"]);
  });

  it("registers a worker even when a primary role already uses its model", async () => {
    const calls = [];
    await syncSubagents(
      { models: [opus] },
      async () => ({ agent: { opus: { model: "anthropic/claude-opus-4", mode: "primary" } } }),
      async ops => { calls.push(ops); return { ok: true }; },
    );
    assert.equal(calls[0].upsert.length, 1);
    assert.equal(calls[0].upsert[0].model, "anthropic/claude-opus-4");
    assert.equal(calls[0].upsert[0].name, "opus-2");
    assert.deepEqual(calls[0].remove, []);
  });

  it("upserts new models and returns the resulting SubagentDef[]", async () => {
    const calls = [];
    const applySubagents = async (ops) => { calls.push(ops); return { ok: true }; };
    const result = await syncSubagents(
      { models: [haiku], deactivated: [] },
      async () => ({}),
      applySubagents,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].upsert.length, 1);
    assert.equal(calls[0].upsert[0].model, "anthropic/claude-haiku-4");
    assert.deepEqual(calls[0].remove, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "haiku");
  });

  it("is a no-op (does not call applySubagents) when nothing changed", async () => {
    let called = false;
    const applySubagents = async () => { called = true; return { ok: true }; };
    const existingCfg = {
      agent: { haiku: { model: "anthropic/claude-haiku-4", description: "Fast", mode: "subagent" } },
    };
    const result = await syncSubagents(
      { models: [haiku], deactivated: [] },
      async () => existingCfg,
      applySubagents,
    );
    assert.equal(called, false);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "haiku");
  });

  it("removes a deactivated model's agent block", async () => {
    const calls = [];
    const applySubagents = async (ops) => { calls.push(ops); return { ok: true }; };
    const existingCfg = {
      agent: { haiku: { model: "anthropic/claude-haiku-4", description: "Fast", mode: "subagent" } },
    };
    const result = await syncSubagents(
      { models: [haiku], deactivated: ["anthropic/claude-haiku-4"] },
      async () => existingCfg,
      applySubagents,
    );
    assert.deepEqual(calls[0].remove, ["haiku"]);
    assert.deepEqual(result, []);
  });

  it("handles a mixed batch of upsert + remove in one call", async () => {
    const calls = [];
    const applySubagents = async (ops) => { calls.push(ops); return { ok: true }; };
    const existingCfg = {
      agent: { opus: { model: "anthropic/claude-opus-4", description: "Deep", mode: "subagent" } },
    };
    const result = await syncSubagents(
      { models: [haiku, opus], deactivated: ["anthropic/claude-opus-4"] },
      async () => existingCfg,
      applySubagents,
    );
    assert.equal(calls[0].upsert.length, 1);
    assert.equal(calls[0].upsert[0].model, "anthropic/claude-haiku-4");
    assert.deepEqual(calls[0].remove, ["opus"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "haiku");
  });

  it("degrades to [] when the config can't be read", async () => {
    const result = await syncSubagents(
      { models: [haiku] },
      async () => { throw new Error("boom"); },
    );
    assert.deepEqual(result, []);
  });

  it("degrades to the pre-sync list when the write fails, without throwing", async () => {
    const existingCfg = {};
    const applySubagents = async () => ({ ok: false, error: "disk full" });
    const result = await syncSubagents(
      { models: [haiku] },
      async () => existingCfg,
      applySubagents,
    );
    assert.deepEqual(result, []); // pre-sync existingAgents was also []
  });

  it("is idempotent: a second call against the post-sync config is a no-op", async () => {
    let cfg = {};
    const applySubagents = async (ops) => {
      for (const name of ops.remove ?? []) delete cfg.agent?.[name];
      for (const input of ops.upsert ?? []) {
        cfg = { ...cfg, agent: { ...(cfg.agent ?? {}), [input.name]: { model: input.model, description: input.description, mode: "subagent" } } };
      }
      return { ok: true };
    };
    const first = await syncSubagents({ models: [haiku, opus] }, async () => cfg, applySubagents);
    assert.equal(first.length, 2);

    let secondCalled = false;
    const applySubagents2 = async (ops) => { secondCalled = true; return applySubagents(ops); };
    const second = await syncSubagents({ models: [haiku, opus] }, async () => cfg, applySubagents2);
    assert.equal(secondCalled, false);
    assert.equal(second.length, 2);
  });
});

// ---------------------------------------------------------------------------
// upsertAgentBlock — manta-plan (BET-984): a custom primary agent must keep
// mode "primary" AND its plan-exit/plan-enter allows (opencode merges an
// agent's own permission block AFTER the shared deny-by-default plan flags,
// so last match wins), with a prompt referencing the {file:...} prompt file.
// ---------------------------------------------------------------------------

describe("upsertAgentBlock — manta-plan", () => {
  it("keeps mode primary, plan_exit/plan_enter allow, and a {file:...} prompt", () => {
    const cfg = {};
    const result = upsertAgentBlock(cfg, mantaPlanAgentBlock("/box/docs/opencode/skills/manta-plan/prompt.md"));
    const block = result.agent["manta-plan"];
    assert.equal(block.mode, "primary");
    assert.equal(block.permission.plan_exit, "allow");
    assert.equal(block.permission.plan_enter, "allow");
    assert.equal(block.permission.bash, "ask");
    assert.equal(block.permission.edit[".opencode/plans/**"], "allow");
    assert.equal(block.permission.edit["*"], "ask");
    assert.match(block.prompt, /^\{file:.*prompt\.md\}$/);
  });

  it("does not clobber unrelated keys in config", () => {
    const cfg = { provider: { openai: {} }, other: "data" };
    const result = upsertAgentBlock(cfg, mantaPlanAgentBlock("/box/prompt.md"));
    assert.deepEqual(result.provider, { openai: {} });
    assert.equal(result.other, "data");
    assert.equal(result.agent["manta-plan"].mode, "primary");
  });

  it("defaults mode to subagent for ordinary blocks (prompt/permission omitted)", () => {
    const cfg = {};
    const result = upsertAgentBlock(cfg, {
      name: "fast",
      model: "anthropic/claude-haiku-4",
      description: "Fast",
    });
    assert.equal(result.agent.fast.mode, "subagent");
    assert.equal(result.agent.fast.permission, undefined);
    assert.equal(result.agent.fast.prompt, undefined);
  });
});

// ---------------------------------------------------------------------------
// ensureMantaPlanAgent (BET-984) — readConfig/applySubagents/restart/promptPath
// are all injectable, so these never touch the real opencode.jsonc or spawn a
// systemctl restart.
// ---------------------------------------------------------------------------

describe("ensureMantaPlanAgent", () => {
  it("is a no-op (no write) when a manta-plan block already exists", async () => {
    let applied = false;
    const existingCfg = {
      agent: { "manta-plan": { mode: "primary", description: "X", permission: {}, prompt: "{file:/x.md}" } },
    };
    const result = await ensureMantaPlanAgent({
      readConfig: async () => existingCfg,
      applySubagents: async () => { applied = true; return { ok: true }; },
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(applied, false);
  });

  it("upserts the block with exact fields when absent", async () => {
    const applied = [];
    const result = await ensureMantaPlanAgent({
      readConfig: async () => ({}),
      applySubagents: async (ops) => { applied.push(ops); return { ok: true }; },
      promptPath: "/box/docs/opencode/skills/manta-plan/prompt.md",
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(applied.length, 1);
    const upsert = applied[0].upsert[0];
    assert.equal(upsert.name, "manta-plan");
    assert.equal(upsert.mode, "primary");
    assert.equal(upsert.permission.plan_exit, "allow");
    assert.equal(upsert.permission.plan_enter, "allow");
    assert.equal(upsert.prompt, "{file:/box/docs/opencode/skills/manta-plan/prompt.md}");
    assert.equal(upsert.model, undefined, "model must stay unset (inherit)");
  });

  it("reports a failed write as not-ok and unchanged", async () => {
    const result = await ensureMantaPlanAgent({
      readConfig: async () => ({}),
      applySubagents: async () => ({ ok: false, error: "disk full" }),
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
  });

  it("does not throw on an unreadable config (non-fatal)", async () => {
    const result = await ensureMantaPlanAgent({
      readConfig: async () => { throw new Error("boom"); },
      applySubagents: async () => { throw new Error("must not be called"); },
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, false);
  });

  it("end to end through the real writer: one write, one reload, comments kept", async () => {
    const { state, deps } = memConfig('{\n  // keep me\n  "model": "a/b"\n}');
    const result = await ensureMantaPlanAgent({
      readConfig: async () => state.config(),
      applySubagents: (ops) => setSubagents(ops, deps),
      promptPath: "/box/prompt.md",
    });
    assert.deepEqual([result.ok, result.changed], [true, true]);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.ok(state.text.includes("// keep me"));
    assert.equal(state.config().agent["manta-plan"].mode, "primary");
  });
});

// ---------------------------------------------------------------------------
// ensureCtoAgent (BET-1164) — same shape as ensureMantaPlanAgent, but its
// default promptPath now resolves to the MATERIALIZED doctrine file (this
// doctrine work), not the committed source doc directly.
// ---------------------------------------------------------------------------

const CTO_TEST_PROMPT = "/box/cto-prompt.md";

// In-memory opencode.jsonc: ensureCtoAgent reads/writes text, never a real file.
function ctoFileFixture(initial) {
  const { state, deps } = memConfig(initial);
  return { deps: { ...deps, promptPath: CTO_TEST_PROMPT }, state };
}

// A permission block whose keys are in the WRONG order: known permission keys
// first, the rest ("*", custom tools) after — i.e. `"*":"deny"` lands LAST and,
// with last-match-wins evaluation, overrides every earlier allow. This is the
// shape the old PATCH endpoint used to persist; it is also what a hand edit or
// a pre-cutover file can still contain.
function reorderedCtoPermission() {
  const desired = ctoAgentBlock(CTO_TEST_PROMPT).permission;
  const known = ["read", "edit", "glob", "grep", "list", "bash", "task", "external_directory", "todowrite", "question", "webfetch", "websearch", "lsp", "doom_loop", "skill"];
  const out = {};
  for (const k of known) if (k in desired) out[k] = desired[k];
  for (const k of Object.keys(desired)) if (!(k in out)) out[k] = desired[k];
  return out;
}

describe("ensureCtoAgent", () => {
  it("regression: repairs a reordered permission shape with ONE write and ONE reload, in desired order", async () => {
    const wrong = reorderedCtoPermission();
    assert.equal(Object.keys(wrong)[0], "read", "fixture must reproduce the reordered shape");
    const stale = { mode: "primary", model: "user/model", permission: wrong, options: { preserve: true } };
    const { deps, state } = ctoFileFixture(JSON.stringify({ agent: { cto: stale, "cto-plan": stale } }));
    const result = await ensureCtoAgent(deps);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    const cfg = state.config();
    const want = Object.keys(ctoAgentBlock(CTO_TEST_PROMPT).permission);
    for (const name of ["cto", "cto-plan"]) {
      const block = cfg.agent[name];
      assert.deepEqual(Object.keys(block.permission), want);
      assert.equal(Object.keys(block.permission)[0], "*");
      assert.equal(block.model, "user/model");
      assert.deepEqual(block.options, { preserve: true });
      assert.equal(block.disable, false);
    }
    assert.match(cfg.agent["cto-plan"].description, /planning/);
    assert.match(cfg.agent["cto-plan"].prompt, /PLAN ONLY/);
  });

  it("converges: feeding the written text back performs no write and no reload", async () => {
    const stale = { mode: "primary", permission: reorderedCtoPermission() };
    const first = ctoFileFixture(JSON.stringify({ agent: { cto: stale } }));
    await ensureCtoAgent(first.deps);
    const second = ctoFileFixture(first.state.text);
    const result = await ensureCtoAgent(second.deps);
    assert.deepEqual([result.ok, result.changed], [true, false]);
    assert.equal(second.state.writes, 0);
    assert.equal(second.state.reloads, 0);
    assert.equal(second.state.text, first.state.text);
  });

  it("steady state from a correct file is a pure read", async () => {
    const seed = ctoFileFixture("{}");
    await ensureCtoAgent(seed.deps);
    const { deps, state } = ctoFileFixture(seed.state.text);
    const result = await ensureCtoAgent(deps);
    assert.equal(result.changed, false);
    assert.equal(state.writes, 0);
    assert.equal(state.reloads, 0);
  });

  it("only rewrites the agent that differs, still one write + one reload", async () => {
    const seed = ctoFileFixture("{}");
    await ensureCtoAgent(seed.deps);
    const cfg = seed.state.config();
    cfg.agent.cto.permission = reorderedCtoPermission();
    const { deps, state } = ctoFileFixture(JSON.stringify(cfg));
    await ensureCtoAgent(deps);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.equal(Object.keys(state.config().agent.cto.permission)[0], "*");
  });

  it("preserves comments and unrelated config around the edit", async () => {
    const input = `{
  // keep me
  "provider": { "x": { "name": "X" } }, /* and me */
  "agent": {
    // the cto block
    "cto": { "mode": "primary", "permission": "deny" },
    "other": { "mode": "subagent" }
  }
}
`;
    const { deps, state } = ctoFileFixture(input);
    const result = await ensureCtoAgent(deps);
    assert.equal(result.ok, true);
    for (const c of ["// keep me", "/* and me */", "// the cto block"]) assert.ok(state.text.includes(c), c);
    const cfg = state.config();
    assert.deepEqual(cfg.provider, { x: { name: "X" } });
    assert.deepEqual(cfg.agent.other, { mode: "subagent" });
    assert.equal(Object.keys(cfg.agent.cto.permission)[0], "*");
  });

  it("installs both role variants into an absent/empty config with one write and one reload", async () => {
    const { deps, state } = ctoFileFixture("{}");
    const result = await ensureCtoAgent({ ...deps, model: "p/m" });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    const cfg = state.config();
    assert.equal(cfg.agent.cto.mode, "primary");
    assert.equal(cfg.agent.cto.model, "p/m");
    assert.equal(cfg.agent.cto.permission.cto_cto, "allow");
    assert.equal(cfg.agent.cto.prompt, `{file:${CTO_TEST_PROMPT}}`);
    assert.ok(cfg.agent["cto-plan"]);
  });

  it("refuses to overwrite an unparseable file and never throws", async () => {
    const { deps, state } = ctoFileFixture("{ not json");
    const result = await ensureCtoAgent({ ...deps, log: { warn() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unreadable");
    assert.equal(state.writes, 0);
    assert.equal(state.reloads, 0);
  });

  it("a rejected reload is not-ok (the file is written); a read failure is not-ok", async () => {
    const { deps, state } = ctoFileFixture("{}");
    const r = await ensureCtoAgent({ ...deps, reload: async () => ({ ok: false, error: "boom" }), log: { warn() {} } });
    assert.deepEqual([r.ok, r.changed, r.error], [false, true, "boom"]);
    assert.equal(state.writes, 1);
    const r2 = await ensureCtoAgent({ ...deps, readText: async () => { throw new Error("nope"); }, log: { warn() {} } });
    assert.equal(r2.ok, false);
  });

  it("opencode not running is fine: the blocks are on disk for its next start", async () => {
    const { deps, state } = ctoFileFixture("{}");
    const r = await ensureCtoAgent({ ...deps, reload: async () => ({ ok: true, reloaded: false }) });
    assert.deepEqual([r.ok, r.changed], [true, true]);
    assert.ok(state.config().agent.cto);
  });

  it("defaults promptPath to the materialized doctrine file, not the committed source doc", () => {
    // Regression guard for the customisation seam: a caller that doesn't
    // override promptPath must get the box-side materialized path, never the
    // read-only committed docs/ file (which a user edit has nowhere to live).
    assert.equal(ctoMaterializedPromptPath().endsWith("/cto/prompt.md"), true);
    assert.notEqual(ctoMaterializedPromptPath(), ctoPromptPath());
  });
});

describe("CTO agent startup recovery", () => {
  it("retries a failed install on a timer, stops on success, and never overlaps", async () => {
    const timers = [];
    let calls = 0;
    let finish;
    const recovery = startCtoAgentRecovery(() => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    }, { setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
    assert.equal(calls, 1);
    assert.equal(timers.length, 0);
    finish(false);
    await recovery.started;
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 30000);
    const next = timers.shift().fn();
    assert.equal(calls, 2);
    assert.equal(timers.length, 0);
    finish(true);
    await next;
    assert.equal(timers.length, 0);
    recovery.stop();
  });
});

// ---------------------------------------------------------------------------
// materializeCtoPrompt / refreshCtoDoctrine (BET-1164 follow-up) — the I/O
// wrapper around ctoDoctrine.mjs's pure composeCtoPrompt. Every case here
// injects readFile/writeFile/mkdir/restart, so nothing touches the real
// filesystem or opencode.
// ---------------------------------------------------------------------------

describe("materializeCtoPrompt", () => {
  const BASE = "# On-call CTO\n\n## Guardrails\n\n- Never fabricate data.\n";

  it("composes the doctrine and writes it to the output path", async () => {
    const writes = [];
    const result = await materializeCtoPrompt({
      style: "handson",
      houseRules: "Always confirm before deploying.",
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async (p) => { assert.equal(p, "/base/prompt.md"); return BASE; },
      writeFile: async (p, data) => { writes.push({ p, data }); },
      mkdir: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.fellBack, false);
    assert.equal(result.path, "/box/cto/prompt.md");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].p, "/box/cto/prompt.md");
    assert.match(writes[0].data, /Operating doctrine: Hands-on/);
    assert.match(writes[0].data, /Always confirm before deploying\./);
    assert.ok(writes[0].data.includes("Never fabricate data."), "guardrails survive verbatim");
  });

  it("creates the output directory before writing (best-effort)", async () => {
    let mkdirCalledWith = null;
    await materializeCtoPrompt({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => BASE,
      writeFile: async () => {},
      mkdir: async (dir, opts) => { mkdirCalledWith = { dir, opts }; },
    });
    assert.equal(mkdirCalledWith.dir, "/box/cto");
    assert.equal(mkdirCalledWith.opts.recursive, true);
  });

  it("a mkdir failure is swallowed (best-effort) and the write still proceeds", async () => {
    const writes = [];
    const result = await materializeCtoPrompt({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => BASE,
      writeFile: async (p, data) => { writes.push({ p, data }); },
      mkdir: async () => { throw new Error("EEXIST"); },
    });
    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
  });

  it("falls back to writing the committed base prompt VERBATIM when composing/writing the doctrine fails", async () => {
    const writes = [];
    let call = 0;
    const result = await materializeCtoPrompt({
      style: "balanced",
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => BASE,
      writeFile: async (p, data) => {
        call += 1;
        if (call === 1) throw new Error("disk full"); // the composed write fails
        writes.push({ p, data }); // the fallback write succeeds
      },
      mkdir: async () => {},
      log: { error: () => {}, warn: () => {} },
    });
    assert.equal(result.ok, false, "reports failure — the caller must know the doctrine did not apply");
    assert.equal(result.fellBack, true);
    assert.equal(writes.length, 1, "the fallback write happened");
    assert.equal(writes[0].data, BASE, "the fallback content is the committed prompt, byte-for-byte");
  });

  it("reports failure (never throws) when even the fallback write fails", async () => {
    const result = await materializeCtoPrompt({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => BASE,
      writeFile: async () => { throw new Error("disk full"); },
      mkdir: async () => {},
      log: { error: () => {}, warn: () => {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fellBack, false);
  });

  it("reports failure (never throws) when the committed base prompt itself cannot be read", async () => {
    const result = await materializeCtoPrompt({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => { throw new Error("ENOENT"); },
      writeFile: async () => { throw new Error("must not be called"); },
      mkdir: async () => { throw new Error("must not be called"); },
      log: { error: () => {}, warn: () => {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fellBack, false);
  });

  it("defaults outputPath to the fixed materialized path", async () => {
    const result = await materializeCtoPrompt({
      basePromptPath: "/base/prompt.md",
      readFile: async () => BASE,
      writeFile: async () => {},
      mkdir: async () => {},
    });
    assert.equal(result.path, ctoMaterializedPromptPath());
  });
});

describe("refreshCtoDoctrine", () => {
  it("materializes the prompt and reloads opencode's config via the injected reload", async () => {
    const writes = [];
    let reloaded = false;
    const result = await refreshCtoDoctrine({
      style: "executive",
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => "# base\n",
      writeFile: async (p, data) => { writes.push({ p, data }); },
      mkdir: async () => {},
      reload: async () => { reloaded = true; return { ok: true, reloaded: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reloaded, true);
    assert.equal(reloaded, true);
    assert.equal(writes.length, 1);
  });

  it("a rejected reload is logged, not thrown — and never undoes the write", async () => {
    const warnings = [];
    const result = await refreshCtoDoctrine({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => "# base\n",
      writeFile: async () => {},
      mkdir: async () => {},
      reload: async () => ({ ok: false, error: "opencode config reload failed (500)" }),
      log: { error: () => {}, warn: (...a) => warnings.push(a) },
    });
    assert.equal(result.reloaded, false);
    assert.equal(result.ok, true);
    assert.ok(warnings.length > 0);
  });

  it("does not throw when reload itself throws", async () => {
    const result = await refreshCtoDoctrine({
      basePromptPath: "/base/prompt.md",
      outputPath: "/box/cto/prompt.md",
      readFile: async () => "# base\n",
      writeFile: async () => {},
      mkdir: async () => {},
      reload: async () => { throw new Error("ECONNREFUSED"); },
      log: { error: () => {}, warn: () => {} },
    });
    assert.equal(result.reloaded, false);
  });
});

// createCtoDoctrineRestarter — used to defer an opencode RESTART until the box
// was idle (a restart kills every in-flight turn). V2 applies the doctrine by
// config reload, which never touches a running turn, so there is nothing to
// defer: refresh() applies at once even while sessions are busy, isPending() is
// always false and tick() does nothing. The shape is kept for the wiring that
// still calls it.
describe("createCtoDoctrineRestarter", () => {
  const IO = {
    basePromptPath: "/base/prompt.md",
    outputPath: "/box/cto/prompt.md",
    readFile: async () => "# base\n",
    writeFile: async () => {},
    mkdir: async () => {},
    log: { error: () => {}, warn: () => {}, info: () => {} },
  };

  it("applies immediately when the box is idle", async () => {
    let reloads = 0;
    const mgr = createCtoDoctrineRestarter({ ...IO, reload: async () => { reloads += 1; return { ok: true, reloaded: true }; }, anyBusy: () => false });
    const r = await mgr.refresh({ style: "executive", houseRules: "" });
    assert.equal(r.ok, true);
    assert.equal(r.reloaded, true);
    assert.equal(r.pending, false);
    assert.equal(reloads, 1);
    assert.equal(mgr.isPending(), false);
  });

  it("applies immediately even while a session is mid-turn — a reload does not touch it", async () => {
    let reloads = 0;
    const mgr = createCtoDoctrineRestarter({ ...IO, reload: async () => { reloads += 1; return { ok: true, reloaded: true }; }, anyBusy: () => true });
    const r = await mgr.refresh({ style: "executive", houseRules: "be terse" });
    assert.equal(r.reloaded, true, "no deferral: nothing in flight can be killed");
    assert.equal(r.pending, false);
    assert.equal(reloads, 1);
    assert.equal(mgr.isPending(), false);
    assert.deepEqual(await mgr.tick(), { applied: false });
    assert.equal(reloads, 1, "tick never reloads");
  });

  it("a failed reload is not pending: the file is written and applies at the next reload/start", async () => {
    const mgr = createCtoDoctrineRestarter({ ...IO, reload: async () => ({ ok: false, error: "500" }) });
    const r = await mgr.refresh({ style: "executive", houseRules: "" });
    assert.equal(r.ok, true);
    assert.equal(r.reloaded, false);
    assert.equal(r.pending, false);
    assert.equal(mgr.isPending(), false);
  });

  it("opencode not running counts as not reloaded, not as an error", async () => {
    const mgr = createCtoDoctrineRestarter({ ...IO, reload: async () => ({ ok: true, reloaded: false }) });
    const r = await mgr.refresh({ style: "executive", houseRules: "" });
    assert.equal(r.reloaded, false);
  });
});

// setReferences — BET-1023. Writes go through the single editConfig writer.
describe("setReferences", () => {
  it("upserts a local path reference", async () => {
    const { state, deps } = memConfig();
    const result = await setReferences({ upsert: [{ alias: "docs", path: "../docs", description: "Product docs" }] }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(state.config(), { references: { docs: { path: "../docs", description: "Product docs" } } });
    assert.equal(state.reloads, 1);
  });

  it("upserts a git repository reference with branch", async () => {
    const { state, deps } = memConfig();
    const result = await setReferences({ upsert: [{ alias: "sdk", repository: "anomalyco/opencode-sdk-js", branch: "main" }] }, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(state.config().references.sdk, { repository: "anomalyco/opencode-sdk-js", branch: "main" });
  });

  it("never writes a bare shorthand string — always an explicit object", async () => {
    const { state, deps } = memConfig();
    await setReferences({ upsert: [{ alias: "docs", path: "../docs" }] }, deps);
    assert.equal(typeof state.config().references.docs, "object");
    assert.equal(state.config().references.docs.path, "../docs");
  });

  it("REPLACES an alias's entry: switching a path to a repository drops the old path", async () => {
    const { state, deps } = memConfig(JSON.stringify({ references: { docs: { path: "../docs", description: "d" } } }));
    await setReferences({ upsert: [{ alias: "docs", repository: "o/r" }] }, deps);
    assert.deepEqual(state.config().references.docs, { repository: "o/r" });
  });

  it("a remove deletes the alias (and the empty references object)", async () => {
    const { state, deps } = memConfig(JSON.stringify({ references: { docs: { path: "../docs" } }, model: "a/b" }));
    const result = await setReferences({ remove: ["docs"] }, deps);
    assert.equal(result.ok, true);
    assert.equal(state.reloads, 1);
    assert.equal(state.config().references?.docs, undefined);
    assert.equal(state.config().model, "a/b");
  });

  it("a mixed batch is a single write and reload", async () => {
    const { state, deps } = memConfig(JSON.stringify({ references: { old: { path: "/o" } } }));
    await setReferences({ upsert: [{ alias: "docs", path: "../docs" }], remove: ["old"] }, deps);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
    assert.deepEqual(Object.keys(state.config().references), ["docs"]);
  });

  it("no-ops when there is nothing to upsert", async () => {
    const { state, deps } = memConfig();
    const result = await setReferences({}, deps);
    assert.equal(result.ok, true);
    assert.equal(state.writes + state.reloads, 0);
  });

  it("surfaces a rejected reload", async () => {
    const { deps } = memConfig();
    deps.reload = async () => ({ ok: false, error: "opencode config reload failed (500)" });
    const result = await setReferences({ upsert: [{ alias: "docs", path: "../docs" }] }, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  });
});

// ---------------------------------------------------------------------------
// editConfig — THE single opencode.jsonc writer. Surgical jsonc-parser edits
// keep comments; a no-op never writes or reloads; an unparseable file is never
// overwritten. Everything is injected — never touches the real file or a live
// opencode.
// ---------------------------------------------------------------------------

const SRC = '{\n  // keep me\n  "provider": {\n    "a": {"x":1},\n    "b": {"y":2}\n  },\n  "model": "m"\n}';

describe("editConfig", () => {
  it("sets a leaf and leaves a // comment elsewhere intact — one write, one reload", async () => {
    const { state, deps } = memConfig(SRC);
    const r = await editConfig([{ path: ["provider", "a", "x"], value: 2 }], deps);
    assert.deepEqual(r, { ok: true, changed: true, reloaded: true });
    assert.ok(state.text.includes("// keep me"));
    assert.equal(state.config().provider.a.x, 2);
    assert.equal(state.config().provider.b.y, 2);
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
  });

  it("deletes a key (value undefined) with a reload — removals no longer restart", async () => {
    const { state, deps } = memConfig(SRC);
    const r = await editConfig([{ path: ["provider", "b"], value: undefined }], deps);
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.ok(state.text.includes("// keep me"));
    assert.ok(!state.text.includes('"b"'));
    assert.equal(state.reloads, 1);
  });

  it("prunes ancestors a delete leaves empty, but never the top-level key", async () => {
    const { state, deps } = memConfig(JSON.stringify({ provider: { anthropic: { models: { m: { options: { cacheControl: { ttl: "1h" } } } } } }, model: "a/b" }));
    await editConfig([{ path: ["provider", "anthropic", "models", "m", "options", "cacheControl"], value: undefined }], deps);
    assert.deepEqual(state.config(), { provider: {}, model: "a/b" });
  });

  it("keeps a non-empty parent when pruning", async () => {
    const { state, deps } = memConfig(JSON.stringify({ provider: { p: { models: { m: { options: { cacheControl: {} }, name: "n" } } } } }));
    await editConfig([{ path: ["provider", "p", "models", "m", "options", "cacheControl"], value: undefined }], deps);
    assert.deepEqual(state.config().provider.p.models.m, { name: "n" });
  });

  it("missing key → ok:true changed:false; NO write, NO reload", async () => {
    const { state, deps } = memConfig(SRC);
    const r = await editConfig([{ path: ["provider", "zzz-does-not-exist"], value: undefined }], deps);
    assert.deepEqual(r, { ok: true, changed: false, reloaded: false });
    assert.equal(state.writes + state.reloads, 0);
  });

  it("setting the value that is already there is a no-op too", async () => {
    const { state, deps } = memConfig('{"model":"m"}');
    const r = await editConfig([{ path: ["model"], value: "m" }], deps);
    assert.equal(r.changed, false);
    assert.equal(state.writes + state.reloads, 0);
  });

  it("an absent/empty file is treated as {} and created", async () => {
    const { state, deps } = memConfig("");
    const r = await editConfig([{ path: ["skills", "urls"], value: ["u"] }], deps);
    assert.equal(r.ok, true);
    assert.deepEqual(state.config(), { skills: { urls: ["u"] } });
  });

  it("a builder function sees the file as it is now and may return no edits", async () => {
    const { state, deps } = memConfig('{"n":1}');
    let seen;
    const r = await editConfig((cfg) => { seen = cfg; return []; }, deps);
    assert.deepEqual(seen, { n: 1 });
    assert.equal(r.changed, false);
    assert.equal(state.writes, 0);
  });

  it("serializes concurrent edits: neither read-modify-write loses the other", async () => {
    const { state, deps } = memConfig("{}");
    // A slow reader widens the race window the lock has to close.
    const slowRead = deps.readText;
    deps.readText = async () => { await new Promise((r) => setTimeout(r, 15)); return slowRead(); };
    await Promise.all([
      editConfig([{ path: ["agent", "a"], value: { model: "x/y" } }], deps),
      editConfig([{ path: ["references", "r"], value: { path: "/p" } }], deps),
      editConfig((cfg) => [{ path: ["n"], value: Object.keys(cfg).length }], deps),
    ]);
    const cfg = state.config();
    assert.deepEqual(cfg.agent, { a: { model: "x/y" } });
    assert.deepEqual(cfg.references, { r: { path: "/p" } });
    assert.equal(cfg.n, 2, "the third edit ran after the first two landed");
  });

  it("refuses an unparseable file: nothing written, nothing reloaded", async () => {
    const { state, deps } = memConfig("{ not json");
    const r = await editConfig([{ path: ["a"], value: 1 }], deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /unparseable/);
    assert.equal(state.writes + state.reloads, 0);
  });

  it("a reload the server REJECTS is ok:false (the live config may still be the old one)", async () => {
    const { state, deps } = memConfig(SRC);
    deps.reload = async () => ({ ok: false, error: "opencode config reload failed (500): boom" });
    const r = await editConfig([{ path: ["model"], value: "n" }], deps);
    assert.equal(r.ok, false);
    assert.equal(r.changed, true, "the file was written");
    assert.match(r.error, /500/);
    assert.equal(state.config().model, "n");
  });

  it("opencode not running → ok:true reloaded:false (applies at its next start)", async () => {
    const { deps } = memConfig(SRC);
    deps.reload = async () => ({ ok: true, reloaded: false, reason: "opencode unreachable" });
    const r = await editConfig([{ path: ["model"], value: "n" }], deps);
    assert.deepEqual(r, { ok: true, changed: true, reloaded: false });
  });

  it("never throws — a failing read surfaces as ok:false with an error", async () => {
    const { deps } = memConfig();
    deps.readText = async () => { throw new Error("EACCES"); };
    const r = await editConfig([{ path: ["a"], value: 1 }], deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /EACCES/);
  });

  it("a failed edit does not wedge the lock for the next one", async () => {
    const { deps: bad } = memConfig();
    bad.readText = async () => { throw new Error("boom"); };
    await editConfig([{ path: ["a"], value: 1 }], bad);
    const { state, deps } = memConfig("{}");
    const r = await editConfig([{ path: ["a"], value: 1 }], deps);
    assert.equal(r.ok, true);
    assert.equal(state.config().a, 1);
  });
});

describe("opencodeConfigPath", () => {
  it("honours MANTA_OPENCODE_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
    assert.equal(opencodeConfigPath({ MANTA_OPENCODE_CONFIG: "/x/o.jsonc", XDG_CONFIG_HOME: "/xdg" }), "/x/o.jsonc");
    assert.equal(opencodeConfigPath({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/opencode/opencode.jsonc");
    assert.match(opencodeConfigPath({}), /\.config\/opencode\/opencode\.jsonc$/);
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache TTL → opencode config
// ---------------------------------------------------------------------------

// What GET /api/model returns for a box with an Anthropic provider (plugin- or
// key-authed), an OpenAI one, and a Vertex-Anthropic one.
const V2_MODELS = [
  { providerID: "anthropic", modelID: "claude-opus-4-8", package: "@opencode/ai/providers/anthropic" },
  { providerID: "anthropic", modelID: "claude-sonnet-4-5", package: "@opencode/ai/providers/anthropic" },
  { providerID: "openai", modelID: "gpt-5", package: "@opencode/ai/providers/openai" },
  { providerID: "google-vertex-anthropic", modelID: "claude-x", package: "@opencode/ai/providers/google-vertex-anthropic" },
];

// Config fixture: the models that carry a cacheControl, by id. Factored out
// because every case below needs the same 5-deep provider→models→options
// shape and repeating it inline is both noisy and a duplication-gate clone.
function ttlCfg(...modelIDs) {
  const models = {};
  for (const id of modelIDs) {
    models[id] = { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
  }
  return { provider: { anthropic: { models } } };
}

describe("selectCacheTtlTargets", () => {
  it("selects only Anthropic-package models V2 lists", () => {
    assert.deepEqual(selectCacheTtlTargets(V2_MODELS), [
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      { providerID: "google-vertex-anthropic", modelID: "claude-x" },
    ]);
  });

  it("de-duplicates, and does not mistake a provider that merely contains the word", () => {
    const r = selectCacheTtlTargets([
      { providerID: "a", modelID: "m", package: "@opencode/ai/providers/anthropic" },
      { providerID: "a", modelID: "m", package: "@opencode/ai/providers/anthropic" },
      { providerID: "b", modelID: "n", package: "@opencode/ai/providers/anthropicish" },
    ]);
    assert.deepEqual(r, [{ providerID: "a", modelID: "m" }]);
  });

  it("empty/garbage input → []", () => {
    assert.deepEqual(selectCacheTtlTargets(), []);
    assert.deepEqual(selectCacheTtlTargets([null, {}, { providerID: "a" }]), []);
    assert.deepEqual(selectCacheTtlTargets({ all: [], connected: [] }), []);
  });
});

describe("resolveCacheTtlFromConfig", () => {
  const targets = [{ providerID: "anthropic", modelID: "m1" }];

  it("reads 1h back off a configured model", () => {
    assert.equal(resolveCacheTtlFromConfig(ttlCfg("m1"), targets), "1h");
  });

  it("also reads the V2-native spelling (providers.<id>.models.<m>.settings.cacheControl)", () => {
    const cfg = { providers: { anthropic: { models: { m1: { settings: { cacheControl: { type: "ephemeral", ttl: "1h" } } } } } } };
    assert.equal(resolveCacheTtlFromConfig(cfg, targets), "1h");
  });

  // Absent is not "unknown" — it is opencode's native breakpoint caching,
  // which Anthropic defaults to 5 minutes (measured on the wire).
  it("absent cacheControl → 5m", () => {
    assert.equal(resolveCacheTtlFromConfig({}, targets), "5m");
    assert.equal(resolveCacheTtlFromConfig({ provider: { anthropic: { models: { m1: {} } } } }, targets), "5m");
  });
});

describe("planCacheTtlOps", () => {
  const targets = [
    { providerID: "anthropic", modelID: "m1" },
    { providerID: "anthropic", modelID: "m2" },
  ];
  const leaf = (m) => ["provider", "anthropic", "models", m, "options", "cacheControl"];

  it("1h sets cacheControl for every target", () => {
    const edits = planCacheTtlOps({ targets, ttl: "1h", cfg: {} });
    assert.deepEqual(edits, [
      { path: leaf("m1"), value: { type: "ephemeral", ttl: "1h" } },
      { path: leaf("m2"), value: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  // The no-op guard is what keeps a re-save from triggering a pointless write
  // and reload.
  it("1h is a no-op when already 1h", () => {
    assert.deepEqual(planCacheTtlOps({ targets, ttl: "1h", cfg: ttlCfg("m1", "m2") }), []);
  });

  it("1h also clears a shadowing native-spelling value", () => {
    const cfg = { providers: { anthropic: { models: { m1: { settings: { cacheControl: { type: "ephemeral", ttl: "5m" } } } } } } };
    const edits = planCacheTtlOps({ targets: [targets[0]], ttl: "1h", cfg });
    assert.deepEqual(edits.map((e) => e.path.join(".")), [leaf("m1").join("."), "providers.anthropic.models.m1.settings.cacheControl"]);
    assert.equal(edits[1].value, undefined);
  });

  // 5m must be the key being ABSENT, never an explicit ttl:"5m".
  it("5m removes the key rather than writing ttl:5m", () => {
    const edits = planCacheTtlOps({ targets, ttl: "5m", cfg: ttlCfg("m1") });
    assert.deepEqual(edits, [{ path: leaf("m1"), value: undefined }]);
  });

  it("5m is a no-op when nothing is configured", () => {
    assert.deepEqual(planCacheTtlOps({ targets, ttl: "5m", cfg: {} }), []);
  });
});

describe("syncCacheTtl", () => {
  const targets = [{ providerID: "anthropic", modelID: "m1" }];

  it("1h writes the setting and reloads — one write, one reload", async () => {
    const { state, deps } = memConfig();
    const r = await syncCacheTtl({ ttl: "1h", targets }, deps);
    assert.deepEqual(r, { ok: true, ttl: "1h", changed: true, restarted: false });
    assert.deepEqual(state.config().provider.anthropic.models.m1.options.cacheControl, { type: "ephemeral", ttl: "1h" });
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
  });

  it("5m removes it with a RELOAD — it no longer restarts opencode or ends a running turn", async () => {
    const { state, deps } = memConfig(JSON.stringify(ttlCfg("m1")));
    const r = await syncCacheTtl({ ttl: "5m", targets }, deps);
    assert.deepEqual(r, { ok: true, ttl: "5m", changed: true, restarted: false });
    assert.equal(state.reloads, 1);
    assert.deepEqual(state.config(), { provider: {} });
  });

  it("no-op reports changed:false and touches nothing", async () => {
    const { state, deps } = memConfig();
    const r = await syncCacheTtl({ ttl: "5m", targets }, deps);
    assert.deepEqual(r, { ok: true, ttl: "5m", changed: false, restarted: false });
    assert.equal(state.writes + state.reloads, 0);
  });

  it("surfaces a rejected reload instead of reporting success", async () => {
    const { deps } = memConfig();
    deps.reload = async () => ({ ok: false, error: "boom" });
    const r = await syncCacheTtl({ ttl: "1h", targets }, deps);
    assert.equal(r.ok, false);
    assert.equal(r.error, "boom");
  });

  it("rejects an unknown ttl by name", async () => {
    const r = await syncCacheTtl({ ttl: "2h", targets }, memConfig().deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown cacheTtl: 2h/);
  });

  it("resolves targets from V2's model list when not supplied", async () => {
    const { state, deps } = memConfig();
    const r = await syncCacheTtl({ ttl: "1h" }, { ...deps, listModels: async () => V2_MODELS });
    assert.equal(r.ok, true);
    // only the Anthropic-package models, not gpt-5
    assert.deepEqual(Object.keys(state.config().provider.anthropic.models), ["claude-opus-4-8", "claude-sonnet-4-5"]);
    assert.deepEqual(Object.keys(state.config().provider["google-vertex-anthropic"].models), ["claude-x"]);
    assert.equal(state.config().provider.openai, undefined);
  });

  it("an unreachable model list is an error, not a silent success", async () => {
    const { state, deps } = memConfig();
    const r = await syncCacheTtl({ ttl: "1h" }, { ...deps, listModels: async () => { throw new Error("opencode down"); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /opencode down/);
    assert.equal(state.writes, 0);
  });

  it("an unreadable config is an error, not a silent success", async () => {
    const { deps } = memConfig("{ not json");
    const r = await syncCacheTtl({ ttl: "1h", targets }, deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /unparseable/);
  });
});

describe("readCacheTtl", () => {
  it("reports the ttl opencode is configured for", async () => {
    const r = await readCacheTtl({
      listModels: async () => V2_MODELS,
      readConfig: async () => ttlCfg("claude-opus-4-8"),
    });
    assert.equal(r, "1h");
  });

  it("returns null (not a guess) when opencode can't be read", async () => {
    const r = await readCacheTtl({
      listModels: async () => {
        throw new Error("down");
      },
    });
    assert.equal(r, null);
  });

  it("returns null when there are no Anthropic models at all", async () => {
    const r = await readCacheTtl({
      listModels: async () => [V2_MODELS[2]],
      readConfig: async () => ({}),
    });
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// setModelCost — sticky-trims C6. Declares ONE model's list price through the
// single editConfig writer, and touches nothing else.
// ---------------------------------------------------------------------------

describe("setModelCost", () => {
  const ok = { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash", cost: { input: 0.09, output: 0.18, cache_read: 0.018, cache_write: 0.09 } };
  const COST = { input: 0.09, output: 0.18, cache_read: 0.018, cache_write: 0.09 };

  it("writes ONLY the cost key of that one model, then reloads once", async () => {
    const { state, deps } = memConfig();
    const res = await setModelCost(ok, deps);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(state.config(), { provider: { openrouter: { models: { "deepseek/deepseek-v4-flash": { cost: COST } } } } });
    assert.equal(state.writes, 1);
    assert.equal(state.reloads, 1);
  });

  it("never rebuilds a provider block: everything else in it (and in the file) survives, comments included", async () => {
    const before = `{
  // my providers
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "options": { "baseURL": "https://openrouter.ai/api/v1", "apiKey": "sk-keep" },
      "models": { "deepseek/deepseek-v4-flash": { "name": "Flash", "limit": { "context": 1000 } }, "other": { "name": "Other" } }
    }
  },
  "skills": { "urls": ["https://example.test"] }
}`;
    const { state, deps } = memConfig(before);
    await setModelCost(ok, deps);
    assert.match(state.text, /\/\/ my providers/);
    const cfg = state.config();
    assert.deepEqual(cfg.provider.openrouter.models["deepseek/deepseek-v4-flash"], { name: "Flash", limit: { context: 1000 }, cost: COST });
    assert.deepEqual(cfg.provider.openrouter.models.other, { name: "Other" });
    assert.equal(cfg.provider.openrouter.options.apiKey, "sk-keep");
    assert.equal(cfg.provider.openrouter.npm, "@ai-sdk/openai-compatible");
    assert.deepEqual(cfg.skills, { urls: ["https://example.test"] });
  });

  it("a re-declared price REPLACES the old one (no stale cache rates left behind); an identical one is a no-op", async () => {
    const { state, deps } = memConfig(JSON.stringify({ provider: { p: { models: { m: { cost: { input: 9, output: 9, cache_read: 9, cache_write: 9 } } } } } }));
    assert.deepEqual(await setModelCost({ providerID: "p", modelID: "m", cost: { input: 1, output: 2 } }, deps), { ok: true });
    assert.deepEqual(state.config().provider.p.models.m.cost, { input: 1, output: 2 });
    const writes = state.writes;
    assert.deepEqual(await setModelCost({ providerID: "p", modelID: "m", cost: { input: 1, output: 2 } }, deps), { ok: true });
    assert.equal(state.writes, writes, "nothing differs → no write, no reload");
  });

  it("cache fields are optional; input and output are required", async () => {
    const { state, deps } = memConfig();
    assert.deepEqual(await setModelCost({ providerID: "p", modelID: "m", cost: { input: 1, output: 2 } }, deps), { ok: true });
    assert.deepEqual(state.config().provider.p.models.m.cost, { input: 1, output: 2 });
    const writes = state.writes;
    for (const cost of [{ input: 1 }, { output: 2 }, {}, { input: "1", output: 2 }, { input: 1, output: -2 }]) {
      const r = await setModelCost({ providerID: "p", modelID: "m", cost }, deps);
      assert.equal(r.ok, false, JSON.stringify(cost));
    }
    assert.equal(state.writes, writes, "nothing is written for an invalid body");
  });

  it("numbers must be finite and >= 0 (cache fields too)", async () => {
    const { state, deps } = memConfig();
    for (const bad of [NaN, Infinity, -0.01, "3", true]) {
      for (const k of ["input", "output", "cache_read", "cache_write"]) {
        const cost = { input: 1, output: 2, [k]: bad };
        const r = await setModelCost({ providerID: "p", modelID: "m", cost }, deps);
        assert.equal(r.ok, false, `${k}=${String(bad)}`);
      }
    }
    assert.equal(state.writes, 0);
    // zero is a legitimate declared price
    assert.deepEqual(await setModelCost({ providerID: "p", modelID: "m", cost: { input: 0, output: 0, cache_read: 0 } }, deps), { ok: true });
    assert.deepEqual(state.config().provider.p.models.m.cost, { input: 0, output: 0, cache_read: 0 });
  });

  it("rejects invalid ids before any write", async () => {
    const { state, deps } = memConfig();
    const cost = { input: 1, output: 2 };
    for (const bad of ["", "a b", "a;b", "x".repeat(201), "ünï", "a\nb", "../x\u0000", "__proto__", "constructor", 5, null, undefined]) {
      assert.equal((await setModelCost({ providerID: bad, modelID: "m", cost }, deps)).ok, false, `providerID ${String(bad)}`);
      assert.equal((await setModelCost({ providerID: "p", modelID: bad, cost }, deps)).ok, false, `modelID ${String(bad)}`);
    }
    assert.equal(state.writes, 0);
    // ids with the allowed punctuation pass, each as ONE key (a "." or "/" never splits a path)
    for (const good of ["deepseek/deepseek-v4-flash", "claude-opus-4.7", "a:b@c_d-e", "x".repeat(200)]) {
      assert.equal((await setModelCost({ providerID: "p", modelID: good, cost }, deps)).ok, true, good);
      assert.deepEqual(state.config().provider.p.models[good].cost, cost, good);
    }
  });

  it("a non-object body / cost is rejected, never thrown", async () => {
    const { state, deps } = memConfig();
    assert.equal((await setModelCost(undefined, deps)).ok, false);
    assert.equal((await setModelCost(null, deps)).ok, false);
    assert.equal((await setModelCost({ providerID: "p", modelID: "m", cost: [1, 2] }, deps)).ok, false);
    assert.equal((await setModelCost({ providerID: "p", modelID: "m", cost: "x" }, deps)).ok, false);
    assert.equal(state.writes, 0);
  });

  it("surfaces the writer's error; an unparseable file is refused and left untouched", async () => {
    const rejected = memConfig("{}", { reload: async () => ({ ok: false, error: "reload rejected (500)" }) });
    assert.deepEqual(await setModelCost(ok, rejected.deps), { ok: false, error: "reload rejected (500)" });
    const broken = memConfig("{ not json");
    const r = await setModelCost(ok, broken.deps);
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(broken.state.text, "{ not json", "never overwritten");
    assert.equal(broken.state.writes, 0);
  });
});
