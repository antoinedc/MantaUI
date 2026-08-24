// Tests for src/server/providers.mjs
//
// Pure helper tests (no I/O) + handler tests that mock the opencode HTTP
// endpoint and the local opencode.jsonc file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseModelsResponse,
  upsertProviderBlock,
  readProviderEndpoints,
  findStoredApiKey,
  discoverModels,
  discoverModelsForEndpoint,
  setProviders,
  removeConfigKeys,
  getProviderEndpoints,
  upsertAgentBlock,
  readAgentBlocks,
  getSubagents,
  setSubagents,
  setSkillRegistryUrls,
  syncSubagents,
  setReferences,
  mantaPlanAgentBlock,
  ensureMantaPlanAgent,
  selectCacheTtlTargets,
  resolveCacheTtlFromConfig,
  planCacheTtlOps,
  syncCacheTtl,
  readCacheTtl,
} from "./providers.mjs";

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
// setProviders — handler test. Writes go through opencode's /global/config
// endpoint (injectable `patch`) and the config-key remover (injectable
// `remove`); neither touches the live opencode endpoint or the real file.
// ---------------------------------------------------------------------------

describe("setProviders", () => {
  it("routes an upsert through PATCH /global/config with only the changed provider", async () => {
    const patches = [];
    const result = await setProviders(
      { upsert: [{ id: "voska", name: "Voska AI", baseURL: "https://api.voska.org/v1", apiKey: "sk", enabledModels: ["voska-1"] }] },
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(patches.length, 1);
    const providerBlock = patches[0].provider["voska"];
    assert.equal(providerBlock.name, "Voska AI");
    assert.equal(providerBlock.options.baseURL, "https://api.voska.org/v1");
    assert.equal(patches[0].provider["other"], undefined, "only the changed provider is patched");
  });

  it("routes a remove through removeConfigKeys (no longer rejects)", async () => {
    let removedPaths = null;
    let patched = false;
    const result = await setProviders(
      { remove: ["voska"] },
      {
        patch: async () => { patched = true; return { ok: true }; },
        remove: async (paths) => { removedPaths = paths; return { ok: true, changed: true }; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(removedPaths, [["provider", "voska"]]);
    assert.equal(patched, false, "a pure remove does not PATCH");
  });

  it("patches before deleting on a mixed upsert+remove batch", async () => {
    const order = [];
    const result = await setProviders(
      { upsert: [{ id: "voska", name: "Voska", baseURL: "https://api.voska.org/v1", apiKey: "sk", enabledModels: [] }], remove: ["old"] },
      {
        patch: async () => { order.push("patch"); return { ok: true }; },
        remove: async () => { order.push("remove"); return { ok: true }; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["patch", "remove"]);
  });

  it("does not delete when the upsert patch fails", async () => {
    let removed = false;
    const result = await setProviders(
      { upsert: [{ id: "voska", name: "Voska", baseURL: "https://api.voska.org/v1", apiKey: "sk", enabledModels: [] }], remove: ["old"] },
      {
        patch: async () => ({ ok: false, error: "boom" }),
        remove: async () => { removed = true; return { ok: true }; },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /boom/);
    assert.equal(removed, false, "must not delete when the upsert patch failed");
  });

  it("surfaces an endpoint error to the caller (no file fallback)", async () => {
    const result = await setProviders(
      { upsert: [{ id: "voska", name: "Voska", baseURL: "https://api.voska.org/v1", apiKey: "sk", enabledModels: [] }] },
      { patch: async () => ({ ok: false, error: "opencode config update failed (500)" }) },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
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
  it("routes an upsert through PATCH /global/config with only the changed agent", async () => {
    const patches = [];
    const result = await setSubagents(
      { upsert: [{ name: "fast", model: "anthropic/claude-haiku-4", description: "New fast" }] },
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(patches.length, 1);
    const block = patches[0].agent["fast"];
    assert.equal(block.model, "anthropic/claude-haiku-4");
    assert.equal(block.description, "New fast");
    assert.equal(block.mode, "subagent", "default mode for an ordinary block");
    assert.equal(patches[0].agent["old"], undefined, "only the changed agent is patched");
  });

  it("routes a remove through removeConfigKeys against the agent key (no longer rejects)", async () => {
    let removedPaths = null;
    let patched = false;
    const result = await setSubagents(
      { remove: ["haiku"] },
      {
        patch: async () => { patched = true; return { ok: true }; },
        remove: async (paths) => { removedPaths = paths; return { ok: true, changed: true }; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(removedPaths, [["agent", "haiku"]]);
    assert.equal(patched, false);
  });

  it("patches before deleting on a mixed upsert+remove batch, and stops when the patch fails", async () => {
    const order = [];
    const okResult = await setSubagents(
      { upsert: [{ name: "fast", model: "anthropic/claude-haiku-4", description: "Fast" }], remove: ["haiku"] },
      {
        patch: async () => { order.push("patch"); return { ok: true }; },
        remove: async () => { order.push("remove"); return { ok: true }; },
      },
    );
    assert.equal(okResult.ok, true);
    assert.deepEqual(order, ["patch", "remove"]);

    let removed = false;
    const failResult = await setSubagents(
      { upsert: [{ name: "fast", model: "x", description: "F" }], remove: ["haiku"] },
      {
        patch: async () => ({ ok: false, error: "boom" }),
        remove: async () => { removed = true; return { ok: true }; },
      },
    );
    assert.equal(failResult.ok, false);
    assert.equal(removed, false, "must not delete when the upsert patch failed");
  });
});

// ---------------------------------------------------------------------------
// setSkillRegistryUrls — the BET-1031 writer. Routes the user's registry list
// to opencode's `skills.urls` through PATCH /global/config, touching only the
// `urls` key (deep-merge) so unrelated keys are preserved.
// ---------------------------------------------------------------------------

describe("setSkillRegistryUrls", () => {
  it("patches skills.urls with the given list", async () => {
    const patches = [];
    const result = await setSkillRegistryUrls(
      ["https://example.com/a.json", "https://example.com/b.json"],
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { skills: { urls: ["https://example.com/a.json", "https://example.com/b.json"] } });
  });

  it("patches only urls, never other skills keys", async () => {
    const patches = [];
    await setSkillRegistryUrls(["https://example.com/a.json"], {
      patch: async (p) => { patches.push(p); return { ok: true }; },
    });
    const keys = Object.keys(patches[0].skills);
    assert.deepEqual(keys, ["urls"], "deep-merge patch must carry only the urls key");
  });

  it("normalizes a non-array value to an empty list (defensive, no throw)", async () => {
    const patches = [];
    const result = await setSkillRegistryUrls(null, {
      patch: async (p) => { patches.push(p); return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(patches[0].skills.urls, []);
  });

  it("propagates a failed opencode write back to the caller", async () => {
    const result = await setSkillRegistryUrls(["https://example.com/a.json"], {
      patch: async () => ({ ok: false, error: "opencode config endpoint unreachable: boom" }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /unreachable/);
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
  it("is a no-op (no write, no restart) when a manta-plan block already exists", async () => {
    let applied = false;
    let restarted = false;
    const existingCfg = {
      agent: { "manta-plan": { mode: "primary", description: "X", permission: {}, prompt: "{file:/x.md}" } },
    };
    const result = await ensureMantaPlanAgent({
      readConfig: async () => existingCfg,
      applySubagents: async () => { applied = true; return { ok: true }; },
      restart: async () => { restarted = true; return { ok: true }; },
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(applied, false);
    assert.equal(restarted, false);
  });

  it("upserts the block with exact fields and restarts when absent", async () => {
    const applied = [];
    const restarts = [];
    const result = await ensureMantaPlanAgent({
      readConfig: async () => ({}),
      applySubagents: async (ops) => { applied.push(ops); return { ok: true }; },
      restart: async () => { restarts.push(1); return { ok: true }; },
      promptPath: "/box/docs/opencode/skills/manta-plan/prompt.md",
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(applied.length, 1);
    assert.equal(restarts.length, 1);
    const upsert = applied[0].upsert[0];
    assert.equal(upsert.name, "manta-plan");
    assert.equal(upsert.mode, "primary");
    assert.equal(upsert.permission.plan_exit, "allow");
    assert.equal(upsert.permission.plan_enter, "allow");
    assert.equal(upsert.prompt, "{file:/box/docs/opencode/skills/manta-plan/prompt.md}");
    assert.equal(upsert.model, undefined, "model must stay unset (inherit)");
  });

  it("does not restart when the write fails", async () => {
    let restarted = false;
    const result = await ensureMantaPlanAgent({
      readConfig: async () => ({}),
      applySubagents: async () => ({ ok: false, error: "disk full" }),
      restart: async () => { restarted = true; return { ok: true }; },
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(restarted, false);
  });

  it("does not throw on an unreadable config (non-fatal)", async () => {
    const result = await ensureMantaPlanAgent({
      readConfig: async () => { throw new Error("boom"); },
      applySubagents: async () => { throw new Error("must not be called"); },
      restart: async () => { throw new Error("must not be called"); },
      promptPath: "/box/prompt.md",
    });
    assert.equal(result.ok, false);
  });
});

// setReferences — BET-1023. Writes go through opencode's /global/config
// endpoint (injectable `patch`, the single config-write path — never a second
// writer). Remove ops are rejected because the endpoint has no delete
// semantics, mirroring setProviders/setSubagents.
describe("setReferences", () => {
  it("upserts a local path reference through the single patch writer", async () => {
    const patches = [];
    const result = await setReferences(
      { upsert: [{ alias: "docs", path: "../docs", description: "Product docs" }] },
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], {
      references: {
        docs: { path: "../docs", description: "Product docs" },
      },
    });
  });

  it("upserts a git repository reference with branch through the single writer", async () => {
    const patches = [];
    const result = await setReferences(
      { upsert: [{ alias: "sdk", repository: "anomalyco/opencode-sdk-js", branch: "main" }] },
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(patches[0], {
      references: {
        sdk: { repository: "anomalyco/opencode-sdk-js", branch: "main" },
      },
    });
  });

  it("never writes a bare shorthand string — always an explicit object", async () => {
    const patches = [];
    await setReferences(
      { upsert: [{ alias: "docs", path: "../docs" }] },
      { patch: async (p) => { patches.push(p); return { ok: true }; } },
    );
    assert.equal(typeof patches[0].references.docs, "object");
    assert.equal(patches[0].references.docs.path, "../docs");
  });

  it("routes a remove through removeConfigKeys against the references key (no longer rejects)", async () => {
    let removedPaths = null;
    let patched = false;
    const result = await setReferences(
      { remove: ["docs"] },
      {
        patch: async () => { patched = true; return { ok: true }; },
        remove: async (paths) => { removedPaths = paths; return { ok: true, changed: true }; },
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(removedPaths, [["references", "docs"]]);
    assert.equal(patched, false);
  });

  it("patches before deleting on a mixed batch, and stops when the patch fails", async () => {
    const order = [];
    const okResult = await setReferences(
      { upsert: [{ alias: "docs", path: "../docs" }], remove: ["old"] },
      {
        patch: async () => { order.push("patch"); return { ok: true }; },
        remove: async () => { order.push("remove"); return { ok: true }; },
      },
    );
    assert.equal(okResult.ok, true);
    assert.deepEqual(order, ["patch", "remove"]);

    let removed = false;
    const failResult = await setReferences(
      { upsert: [{ alias: "docs", path: "../docs" }], remove: ["old"] },
      {
        patch: async () => ({ ok: false, error: "boom" }),
        remove: async () => { removed = true; return { ok: true }; },
      },
    );
    assert.equal(failResult.ok, false);
    assert.equal(removed, false, "must not delete when the upsert patch failed");
  });

  it("no-ops when there is nothing to upsert", async () => {
    let patched = false;
    const result = await setReferences(
      {},
      { patch: async () => { patched = true; return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.equal(patched, false);
  });

  it("surfaces endpoint failures", async () => {
    const result = await setReferences(
      { upsert: [{ alias: "docs", path: "../docs" }] },
      { patch: async () => ({ ok: false, error: "opencode config update failed (500)" }) },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  });
});

// ---------------------------------------------------------------------------
// removeConfigKeys — THE single direct-write path (deletions only). Surgical
// jsonc-parser edits preserve comments; the mandatory opencode restart is
// what stops memory/disk divergence. All deps are injected — never touches
// the real opencode.jsonc or systemctl.
// ---------------------------------------------------------------------------

describe("removeConfigKeys", () => {
  const SRC = '{\n  // keep me\n  "provider": {\n    "a": {"x":1},\n    "b": {"y":2}\n  },\n  "model": "m"\n}';

  it("deletes a key and leaves a // comment elsewhere intact", async () => {
    let written = null;
    let restarts = 0;
    const result = await removeConfigKeys([["provider", "b"]], {
      readText: async () => SRC,
      writeText: async (t) => { written = t; },
      restart: async () => { restarts++; return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.ok(written.includes("// keep me"), "comment preserved");
    assert.ok(!written.includes('"b"'), "removed key is gone");
    assert.equal(restarts, 1);
  });

  it("missing key → ok:true changed:false, writer NOT called, restart NOT called", async () => {
    let written = false;
    let restarts = 0;
    const result = await removeConfigKeys([["provider", "zzz-does-not-exist"]], {
      readText: async () => SRC,
      writeText: async () => { written = true; },
      restart: async () => { restarts++; return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(written, false);
    assert.equal(restarts, 0);
  });

  it("multi-path call removes all and restarts exactly once", async () => {
    let written = null;
    let restarts = 0;
    const result = await removeConfigKeys([["provider", "a"], ["provider", "b"]], {
      readText: async () => SRC,
      writeText: async (t) => { written = t; },
      restart: async () => { restarts++; return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(restarts, 1);
    assert.ok(!written.includes('"a"') && !written.includes('"b"'));
    assert.ok(written.includes("// keep me"));
  });

  it("restart failure → ok:false (never reports success while a live opencode holds the key)", async () => {
    const result = await removeConfigKeys([["provider", "a"]], {
      readText: async () => SRC,
      writeText: async () => {},
      restart: async () => ({ ok: false, error: "systemctl failed" }),
    });
    assert.equal(result.ok, false);
  });

  it("never throws — a failing read surfaces as ok:false with an error", async () => {
    const result = await removeConfigKeys([["provider", "a"]], {
      readText: async () => { throw new Error("ENOENT"); },
      writeText: async () => {},
      restart: async () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache TTL → opencode config (BET-1336)
// ---------------------------------------------------------------------------

const PROVIDERS_FIXTURE = {
  connected: ["anthropic", "openai"],
  all: [
    {
      id: "anthropic",
      models: {
        "claude-opus-4-8": { api: { npm: "@ai-sdk/anthropic" } },
        "claude-sonnet-4-5": { api: { npm: "@ai-sdk/anthropic" } },
      },
    },
    // connected, but its SDK does not take cacheControl
    { id: "openai", models: { "gpt-5": { api: { npm: "@ai-sdk/openai" } } } },
    // qualifying SDK but NOT connected — must be ignored
    {
      id: "google-vertex-anthropic",
      models: { "claude-x": { api: { npm: "@ai-sdk/google-vertex/anthropic" } } },
    },
  ],
};

describe("selectCacheTtlTargets", () => {
  it("selects only Anthropic-SDK models of CONNECTED providers", () => {
    assert.deepEqual(selectCacheTtlTargets(PROVIDERS_FIXTURE), [
      { providerID: "anthropic", modelID: "claude-opus-4-8" },
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    ]);
  });

  it("takes google-vertex/anthropic when it is connected", () => {
    const r = selectCacheTtlTargets({
      connected: ["google-vertex-anthropic"],
      all: [
        {
          id: "google-vertex-anthropic",
          models: { "claude-x": { api: { npm: "@ai-sdk/google-vertex/anthropic" } } },
        },
      ],
    });
    assert.deepEqual(r, [{ providerID: "google-vertex-anthropic", modelID: "claude-x" }]);
  });

  it("empty/garbage input → []", () => {
    assert.deepEqual(selectCacheTtlTargets(), []);
    assert.deepEqual(selectCacheTtlTargets({ all: [null], connected: [] }), []);
  });
});

describe("resolveCacheTtlFromConfig", () => {
  const targets = [{ providerID: "anthropic", modelID: "m1" }];

  it("reads 1h back off a configured model", () => {
    const cfg = {
      provider: {
        anthropic: {
          models: { m1: { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
        },
      },
    };
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

  it("1h upserts cacheControl for every target", () => {
    const { patch, remove } = planCacheTtlOps({ targets, ttl: "1h", cfg: {} });
    assert.deepEqual(remove, []);
    assert.deepEqual(patch.provider.anthropic.models.m1.options.cacheControl, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.equal(patch.provider.anthropic.models.m2.options.cacheControl.ttl, "1h");
  });

  // The no-op guard is what keeps a re-save from triggering a pointless write,
  // and (in the 5m direction) a pointless opencode restart.
  it("1h is a no-op when already 1h", () => {
    const cfg = {
      provider: {
        anthropic: {
          models: {
            m1: { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
            m2: { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
          },
        },
      },
    };
    const { patch, remove } = planCacheTtlOps({ targets, ttl: "1h", cfg });
    assert.equal(patch.provider, undefined);
    assert.deepEqual(remove, []);
  });

  // 5m must be the key being ABSENT, never an explicit ttl:"5m" — writing one
  // would flip opencode into Anthropic automatic caching for a user who never
  // asked, changing the caching strategy rather than just the TTL.
  it("5m removes the key rather than writing ttl:5m", () => {
    const cfg = {
      provider: {
        anthropic: {
          models: { m1: { options: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
        },
      },
    };
    const { patch, remove } = planCacheTtlOps({ targets, ttl: "5m", cfg });
    assert.equal(patch.provider, undefined);
    assert.deepEqual(remove, [["provider", "anthropic", "models", "m1", "options", "cacheControl"]]);
  });

  it("5m is a no-op when nothing is configured", () => {
    const { patch, remove } = planCacheTtlOps({ targets, ttl: "5m", cfg: {} });
    assert.equal(patch.provider, undefined);
    assert.deepEqual(remove, []);
  });
});

describe("syncCacheTtl", () => {
  const targets = [{ providerID: "anthropic", modelID: "m1" }];

  it("1h patches and never restarts", async () => {
    const patched = [];
    const removed = [];
    const r = await syncCacheTtl(
      { ttl: "1h", targets },
      {
        readConfig: async () => ({}),
        patch: async (p) => (patched.push(p), { ok: true }),
        remove: async (p) => (removed.push(p), { ok: true, changed: true }),
      },
    );
    assert.deepEqual(r, { ok: true, ttl: "1h", changed: true, restarted: false });
    assert.equal(patched.length, 1);
    assert.equal(removed.length, 0);
  });

  it("5m removes and reports the restart it caused", async () => {
    const cfg = {
      provider: { anthropic: { models: { m1: { options: { cacheControl: { ttl: "1h" } } } } } },
    };
    const r = await syncCacheTtl(
      { ttl: "5m", targets },
      {
        readConfig: async () => cfg,
        patch: async () => ({ ok: true }),
        remove: async () => ({ ok: true, changed: true }),
      },
    );
    assert.deepEqual(r, { ok: true, ttl: "5m", changed: true, restarted: true });
  });

  it("no-op reports changed:false and touches nothing", async () => {
    let calls = 0;
    const r = await syncCacheTtl(
      { ttl: "5m", targets },
      {
        readConfig: async () => ({}),
        patch: async () => (calls++, { ok: true }),
        remove: async () => (calls++, { ok: true }),
      },
    );
    assert.deepEqual(r, { ok: true, ttl: "5m", changed: false, restarted: false });
    assert.equal(calls, 0);
  });

  it("surfaces a failed patch instead of reporting success", async () => {
    const r = await syncCacheTtl(
      { ttl: "1h", targets },
      { readConfig: async () => ({}), patch: async () => ({ ok: false, error: "boom" }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "boom");
  });

  it("rejects an unknown ttl by name", async () => {
    const r = await syncCacheTtl({ ttl: "2h", targets }, { readConfig: async () => ({}) });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown cacheTtl: 2h/);
  });

  it("resolves targets from the provider list when not supplied", async () => {
    const patched = [];
    const r = await syncCacheTtl(
      { ttl: "1h" },
      {
        listProviders: async () => PROVIDERS_FIXTURE,
        readConfig: async () => ({}),
        patch: async (p) => (patched.push(p), { ok: true }),
      },
    );
    assert.equal(r.ok, true);
    // only the two connected Anthropic-SDK models, not gpt-5
    assert.deepEqual(Object.keys(patched[0].provider.anthropic.models), [
      "claude-opus-4-8",
      "claude-sonnet-4-5",
    ]);
  });

  it("an unreadable config is an error, not a silent success", async () => {
    const r = await syncCacheTtl(
      { ttl: "1h", targets },
      {
        readConfig: async () => {
          throw new Error("unparseable");
        },
      },
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /unparseable/);
  });
});

describe("readCacheTtl", () => {
  it("reports the ttl opencode is configured for", async () => {
    const cfg = {
      provider: {
        anthropic: {
          models: { "claude-opus-4-8": { options: { cacheControl: { ttl: "1h" } } } },
        },
      },
    };
    const r = await readCacheTtl({
      listProviders: async () => PROVIDERS_FIXTURE,
      readConfig: async () => cfg,
    });
    assert.equal(r, "1h");
  });

  it("returns null (not a guess) when opencode can't be read", async () => {
    const r = await readCacheTtl({
      listProviders: async () => {
        throw new Error("down");
      },
    });
    assert.equal(r, null);
  });

  it("returns null when there are no Anthropic-SDK models at all", async () => {
    const r = await readCacheTtl({
      listProviders: async () => ({ connected: ["openai"], all: [{ id: "openai", models: {} }] }),
      readConfig: async () => ({}),
    });
    assert.equal(r, null);
  });
});
