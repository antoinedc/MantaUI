import { describe, it, expect } from "vitest";
import { parseModelsResponse, upsertProviderBlock, removeProviderBlock, readProviderEndpoints } from "./providers.js";

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
});
