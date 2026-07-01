import { describe, it, expect } from "vitest";
import { parseModelsResponse, upsertProviderBlock, removeProviderBlock, readProviderEndpoints, findStoredApiKey, droppedProviders } from "./providers.js";
import { stripLineComments } from "./setup.js";

describe("parseModelsResponse", () => {
  it("extracts ids from a valid OpenAI /v1/models body", () => {
    const body = JSON.stringify({
      object: "list",
      data: [
        { id: "qwen3.6-27b", object: "model" },
        { id: "default", object: "model" },
        { id: "ornith", object: "model" },
      ],
    });
    expect(parseModelsResponse(body)).toEqual({
      ok: true,
      models: [{ id: "qwen3.6-27b" }, { id: "default" }, { id: "ornith" }],
    });
  });

  it("returns ok:true with empty list when data is empty", () => {
    expect(parseModelsResponse(JSON.stringify({ data: [] }))).toEqual({
      ok: true,
      models: [],
    });
  });

  it("returns bad_response for non-JSON", () => {
    const r = parseModelsResponse("<html>502 Bad Gateway</html>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });

  it("returns unauthorized when body looks like an auth error", () => {
    const body = JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } });
    const r = parseModelsResponse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unauthorized");
  });

  it("returns bad_response when JSON lacks a data array", () => {
    const r = parseModelsResponse(JSON.stringify({ object: "list" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });

  it("treats `error: null` alongside data as success (gateway success shape)", () => {
    const body = JSON.stringify({ object: "list", error: null, data: [{ id: "m1" }] });
    expect(parseModelsResponse(body)).toEqual({ ok: true, models: [{ id: "m1" }] });
  });
});

describe("upsertProviderBlock", () => {
  const base = {
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude-opus-4-8",
    plugin: ["opencode-claude-auth-bui@1.5.4-bui.1"],
    skills: { urls: [] },
  };

  it("adds a provider block without touching other keys", () => {
    const out = upsertProviderBlock(base, {
      id: "voska",
      name: "VoskaAI",
      baseURL: "https://api.voska.org/v1",
      apiKey: "sk-test",
      enabledModels: ["qwen3.6-27b", "ornith"],
    });
    expect(out.model).toBe("anthropic/claude-opus-4-8");
    expect(out.plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
    expect(out.skills).toEqual({ urls: [] });
    const p = (out.provider as Record<string, any>).voska;
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.name).toBe("VoskaAI");
    expect(p.options).toEqual({ baseURL: "https://api.voska.org/v1", apiKey: "sk-test" });
    expect(Object.keys(p.models)).toEqual(["qwen3.6-27b", "ornith"]);
    expect(p.models["ornith"]).toEqual({ id: "ornith", name: "ornith" });
  });

  it("preserves the existing apiKey when input apiKey is undefined", () => {
    const withProv = upsertProviderBlock(base, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      apiKey: "sk-old", enabledModels: ["qwen3.6-27b"],
    });
    const out = upsertProviderBlock(withProv, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      enabledModels: ["qwen3.6-27b", "default"], // no apiKey field
    });
    const p = (out.provider as Record<string, any>).voska;
    expect(p.options.apiKey).toBe("sk-old");
    expect(Object.keys(p.models)).toEqual(["qwen3.6-27b", "default"]);
  });

  it("CLEARS the apiKey when input apiKey is an empty string (distinct from undefined)", () => {
    const withProv = upsertProviderBlock(base, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      apiKey: "sk-old", enabledModels: ["qwen3.6-27b"],
    });
    const out = upsertProviderBlock(withProv, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      apiKey: "", enabledModels: ["qwen3.6-27b"], // explicit empty = clear
    });
    const p = (out.provider as Record<string, any>).voska;
    expect(p.options.apiKey).toBe("");
  });
});

describe("findStoredApiKey", () => {
  const cfg = {
    provider: {
      voska: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.voska.org/v1", apiKey: "sk-voska" },
        models: {},
      },
      other: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.other.com/v1", apiKey: "sk-other" },
        models: {},
      },
    },
  };

  it("recovers the key for an exact baseURL match", () => {
    expect(findStoredApiKey(cfg, "https://api.voska.org/v1")).toBe("sk-voska");
  });

  it("matches trailing-slash-insensitively on either side", () => {
    // stored without slash, queried with slash
    expect(findStoredApiKey(cfg, "https://api.voska.org/v1/")).toBe("sk-voska");
    // stored with slash, queried without
    const slashCfg = {
      provider: {
        voska: { npm: "x", options: { baseURL: "https://api.voska.org/v1/", apiKey: "sk-s" }, models: {} },
      },
    };
    expect(findStoredApiKey(slashCfg, "https://api.voska.org/v1")).toBe("sk-s");
  });

  it("returns '' when no provider baseURL matches", () => {
    expect(findStoredApiKey(cfg, "https://api.nope.com/v1")).toBe("");
  });

  it("returns '' when there is no provider key", () => {
    expect(findStoredApiKey({ model: "anthropic/x" }, "https://api.voska.org/v1")).toBe("");
  });
});

describe("removeProviderBlock", () => {
  it("drops only the named provider", () => {
    const cfg = {
      model: "anthropic/x",
      provider: {
        voska: { npm: "@ai-sdk/openai-compatible", models: {} },
        other: { npm: "@ai-sdk/openai-compatible", models: {} },
      },
    };
    const out = removeProviderBlock(cfg, "voska");
    expect((out.provider as Record<string, unknown>).voska).toBeUndefined();
    expect((out.provider as Record<string, unknown>).other).toBeDefined();
    expect(out.model).toBe("anthropic/x");
  });
});

describe("readProviderEndpoints", () => {
  it("returns endpoint metadata with hasApiKey and enabledModels, never the key", () => {
    const cfg = {
      provider: {
        voska: {
          npm: "@ai-sdk/openai-compatible",
          name: "VoskaAI",
          options: { baseURL: "https://api.voska.org/v1", apiKey: "sk-secret" },
          models: { "qwen3.6-27b": { id: "qwen3.6-27b" }, ornith: { id: "ornith" } },
        },
      },
    };
    const eps = readProviderEndpoints(cfg);
    expect(eps).toEqual([
      {
        id: "voska",
        name: "VoskaAI",
        baseURL: "https://api.voska.org/v1",
        hasApiKey: true,
        enabledModels: ["qwen3.6-27b", "ornith"],
      },
    ]);
    expect(JSON.stringify(eps)).not.toContain("sk-secret");
  });

  it("returns [] when there is no provider key", () => {
    expect(readProviderEndpoints({ model: "anthropic/x" })).toEqual([]);
  });

  it("strips userinfo credentials embedded in baseURL", () => {
    const cfg = {
      provider: {
        p: {
          npm: "@ai-sdk/openai-compatible",
          name: "P",
          options: { baseURL: "https://user:s3cret@api.example.com/v1", apiKey: "k" },
          models: { m: { id: "m" } },
        },
      },
    };
    const eps = readProviderEndpoints(cfg);
    expect(eps[0].baseURL).toBe("https://api.example.com/v1");
    expect(JSON.stringify(eps)).not.toContain("s3cret");
  });
});

// Regression: readRemoteConfig parses opencode.jsonc by running it through
// stripLineComments (string-literal-aware) then JSON.parse. A real config has
// `"$schema": "https://opencode.ai/config.json"` and provider `baseURL`s whose
// `//` lives INSIDE a string. A naive `//`-to-EOL strip truncates those strings
// and makes JSON.parse throw on a valid config — which surfaced as an empty
// providers list and every save failing with "unparseable, refusing to write".
// This proves the strip used by readRemoteConfig preserves in-string `//`.
describe("readRemoteConfig comment-strip regression (URLs in strings)", () => {
  it("parses a realistic JSONC config with https:// URLs and // comments", () => {
    const jsonc = `{
  // top-level comment
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-opus-4-8",
  "plugin": ["opencode-claude-auth-bui@1.5.4-bui.1"],
  "provider": {
    "voska": {
      "npm": "@ai-sdk/openai-compatible", // openai-compatible
      "name": "VoskaAI",
      "options": { "baseURL": "https://api.voska.org/v1", "apiKey": "sk-x" },
      "models": { "qwen3.6-27b": { "id": "qwen3.6-27b" } }
    }
  }
}`;
    const cfg = JSON.parse(stripLineComments(jsonc)) as Record<string, unknown>;
    // The $schema URL must survive intact (not truncated to "https:").
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    const eps = readProviderEndpoints(cfg);
    expect(eps).toEqual([
      {
        id: "voska",
        name: "VoskaAI",
        baseURL: "https://api.voska.org/v1",
        hasApiKey: true,
        enabledModels: ["qwen3.6-27b"],
      },
    ]);
  });
});

// Regression (2026-07-01): a Refresh→check-model→Save wiped opencode.jsonc down
// to an 85-byte skeleton, dropping every provider (voska, anthropic) + the
// claude-auth plugin. Root cause: setProviders read a partial/empty config
// under a degraded link, merged the upsert onto {}, and wrote the skeleton.
// droppedProviders is the guard that catches this: any provider that existed
// before and vanished after WITHOUT an explicit remove means the read was bad.
describe("droppedProviders (non-destructive write guard)", () => {
  it("flags providers that vanish without being removed (the wipe bug)", () => {
    // before had anthropic+voska; a bad/empty read made after empty; no removes.
    const before = { anthropic: {}, voska: {} };
    const after = {}; // upsert merged onto an empty read
    expect(droppedProviders(before, after, [])).toEqual(["anthropic", "voska"]);
  });

  it("does NOT flag a provider that was explicitly removed", () => {
    const before = { anthropic: {}, voska: {} };
    const after = { anthropic: {} }; // voska removed on purpose
    expect(droppedProviders(before, after, ["voska"])).toEqual([]);
  });

  it("does NOT flag on a normal upsert that keeps everything", () => {
    const before = { anthropic: {}, voska: {} };
    const after = { anthropic: {}, voska: {} }; // toggled a model, both survive
    expect(droppedProviders(before, after, [])).toEqual([]);
  });

  it("does NOT flag adding a brand-new provider to an empty config", () => {
    const before = {}; // legitimately fresh config
    const after = { voska: {} };
    expect(droppedProviders(before, after, [])).toEqual([]);
  });
});
