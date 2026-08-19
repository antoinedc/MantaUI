import { describe, it, expect } from "vitest";
import { describeModel, familyKey, fuzzyMatchModel, suggestModels, isDeprecated, readModalities } from "./modelGuide.mjs";

describe("describeModel", () => {
  it("matches haiku family", () => {
    const r = describeModel("anthropic", "claude-haiku-4");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
    expect(r?.blurb).toContain("Fast");
    expect(r?.goodFor).toContain("Mechanical edits and simple refactors");
  });

  it("matches sonnet family", () => {
    const r = describeModel("anthropic", "claude-sonnet-4");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
    expect(r?.blurb).toContain("Balanced");
  });

  it("matches opus family", () => {
    const r = describeModel("anthropic", "claude-opus-4");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep");
    expect(r?.blurb).toContain("Deep");
  });

  it("matches gpt-4o-mini", () => {
    const r = describeModel("openai", "gpt-4o-mini");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("matches o4-mini", () => {
    const r = describeModel("openai", "o4-mini");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("matches gpt-4o", () => {
    const r = describeModel("openai", "gpt-4o");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("matches o1 family", () => {
    const r = describeModel("openai", "o1-preview");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep");
  });

  it("matches o3 family", () => {
    const r = describeModel("openai", "o3-mini");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep");
  });

  it("matches gemini-flash", () => {
    const r = describeModel("google", "gemini-1.5-flash");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("matches gemini-pro", () => {
    const r = describeModel("google", "gemini-1.5-pro");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("is case-insensitive", () => {
    const r1 = describeModel("anthropic", "Claude-Haiku-4");
    const r2 = describeModel("anthropic", "CLAUDE-HAIKU-4");
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(r1?.tier).toBe("fast");
    expect(r2?.tier).toBe("fast");
  });

  it("matches variant suffixes", () => {
    const r = describeModel("anthropic", "claude-haiku-4-20250101");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("returns null for no match", () => {
    expect(describeModel("unknown", "random-model")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(describeModel("anthropic", "")).toBeNull();
    expect(describeModel("anthropic", null as unknown as string)).toBeNull();
    expect(describeModel("anthropic", undefined as unknown as string)).toBeNull();
  });

  it("first match wins when multiple keys could match", () => {
    // "gpt-4o-mini" contains both "gpt-4o-mini" and "mini", but the catalog
    // has gpt-4o-mini listed before any generic "mini" entry (if it existed).
    // This tests that iteration order matters.
    const r = describeModel("openai", "gpt-4o-mini-turbo");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast"); // gpt-4o-mini wins, not a hypothetical later "mini"
  });

  it("matches codex-mini", () => {
    const r = describeModel("openai", "gpt-5.1-codex-mini");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("matches codex-max", () => {
    const r = describeModel("openai", "gpt-5.1-codex-max");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep");
  });

  it("matches codex", () => {
    const r = describeModel("openai", "gpt-5.2-codex");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("matches gpt-5", () => {
    const r = describeModel("openai", "gpt-5.1");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("matches kimi-for-coding-highspeed", () => {
    const r = describeModel("kimi-for-coding", "kimi-for-coding-highspeed");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast");
  });

  it("matches kimi-for-coding", () => {
    const r = describeModel("kimi-for-coding", "kimi-for-coding");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("matches k3-256k", () => {
    const r = describeModel("kimi-for-coding", "k3-256k");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced");
  });

  it("matches k3", () => {
    const r = describeModel("kimi-for-coding", "k3");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep");
  });

  it("resolves gpt-5.2-codex to the codex entry, not the bare gpt-5 one", () => {
    const r = describeModel("openai", "gpt-5.2-codex");
    expect(r).toBeTruthy();
    // codex is "balanced"; gpt-5 is also "balanced", so use blurb to disambiguate.
    expect(r?.blurb).toContain("Codex-tuned");
  });

  it("resolves gpt-5.1-codex-mini to codex-mini, not codex", () => {
    const r = describeModel("openai", "gpt-5.1-codex-mini");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast"); // codex-mini is fast; codex is balanced
  });

  it("resolves gpt-5.1-codex-max to codex-max, not codex", () => {
    const r = describeModel("openai", "gpt-5.1-codex-max");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("deep"); // codex-max is deep; codex is balanced
  });

  it("resolves k3-256k to k3-256k, not k3", () => {
    const r = describeModel("kimi-for-coding", "k3-256k");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("balanced"); // k3-256k is balanced; k3 is deep
  });

  it("resolves kimi-for-coding-highspeed to the highspeed entry", () => {
    const r = describeModel("kimi-for-coding", "kimi-for-coding-highspeed");
    expect(r).toBeTruthy();
    expect(r?.tier).toBe("fast"); // highspeed is fast; kimi-for-coding is balanced
  });
});

describe("familyKey", () => {
  it("returns the matched catalog key", () => {
    expect(familyKey("claude-haiku-4")).toBe("haiku");
    expect(familyKey("gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("returns null for no match", () => {
    expect(familyKey("random-model")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(familyKey("")).toBeNull();
    expect(familyKey(null as unknown as string)).toBeNull();
  });

  it("returns a non-null key for newly cataloged models so subagent naming stops falling back to slugs", () => {
    expect(familyKey("gpt-5.2-codex")).toBe("codex");
    expect(familyKey("k3")).toBe("k3");
  });
});

const MODELS = [
  { providerID: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
  { providerID: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { providerID: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { providerID: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { providerID: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { providerID: "openai", id: "gpt-4o", name: "GPT-4o" },
  { providerID: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { providerID: "voska", id: "default", name: "Voska Default" },
];

describe("fuzzyMatchModel", () => {
  it("matches an exact model id", () => {
    expect(fuzzyMatchModel("claude-opus-4-7", MODELS)?.id).toBe("claude-opus-4-7");
  });

  it("matches the fewest-word id for a single-token family query (\"opus\")", () => {
    expect(fuzzyMatchModel("opus", MODELS)?.id).toBe("claude-opus-5");
  });

  it("prefers the exact-word model over a longer id (\"opus 5\")", () => {
    expect(fuzzyMatchModel("opus 5", MODELS)?.id).toBe("claude-opus-5");
  });

  it("still matches a single-token family query to the fewest-word id", () => {
    // "opus" appears in several ids; fewest-word wins deterministically.
    expect(fuzzyMatchModel("opus", MODELS)?.id).toBeDefined();
  });

  it("matches a multi-word query against a model name (\"gpt 4o mini\")", () => {
    expect(fuzzyMatchModel("gpt 4o mini", MODELS)?.id).toBe("gpt-4o-mini");
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatchModel("SONNET", MODELS)?.id).toBe("claude-sonnet-4-6");
  });

  it("falls back to a providerID match for a bare provider name", () => {
    expect(fuzzyMatchModel("openai", MODELS)?.providerID).toBe("openai");
  });

  it("resolves an explicit providerID/modelID form", () => {
    expect(fuzzyMatchModel("voska/default", MODELS)?.id).toBe("default");
    expect(fuzzyMatchModel("voska/default", MODELS)?.providerID).toBe("voska");
  });

  it("resolves providerID/family form via the reused matcher", () => {
    expect(fuzzyMatchModel("anthropic/opus 5", MODELS)?.id).toBe("claude-opus-5");
  });

  it("returns null for no match or empty input", () => {
    expect(fuzzyMatchModel("gpt-5", MODELS)).toBeNull();
    expect(fuzzyMatchModel("", MODELS)).toBeNull();
    expect(fuzzyMatchModel("opus", [])).toBeNull();
    expect(fuzzyMatchModel(null as unknown as string, MODELS)).toBeNull();
  });
});

describe("suggestModels", () => {
  it("rates candidates whose id/name contain a query token", () => {
    const s = suggestModels("4o", MODELS, 3);
    expect(s.map((m) => m.id).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(s[0].providerID).toBe("openai");
  });

  it("respects the limit", () => {
    // every model contains the "claude" token; limit 2 caps the result.
    expect(suggestModels("claude", MODELS, 2).length).toBe(2);
  });

  it("returns empty for no overlap", () => {
    expect(suggestModels("zzzz", MODELS)).toEqual([]);
    expect(suggestModels("", MODELS)).toEqual([]);
    expect(suggestModels(null as unknown as string, MODELS)).toEqual([]);
  });
});

describe("isDeprecated", () => {
  it("returns true only for status === 'deprecated'", () => {
    expect(isDeprecated({ status: "deprecated" })).toBe(true);
    expect(isDeprecated({ status: "active" })).toBe(false);
    expect(isDeprecated({})).toBe(false);
    expect(isDeprecated(null)).toBe(false);
    expect(isDeprecated(undefined)).toBe(false);
  });
});

describe("readModalities", () => {
  it("passes an array of strings through unchanged", () => {
    expect(readModalities(["text", "image", "pdf"])).toEqual(["text", "image", "pdf"]);
  });

  it("reads the object-of-flags form, keeping only the true keys in key order", () => {
    expect(readModalities({ image: true, text: true, pdf: false })).toEqual(["image", "text"]);
  });

  it("drops non-string members of an array", () => {
    expect(readModalities(["text", 5, null, "image"])).toEqual(["text", "image"]);
  });

  it("returns [] for undefined, null, a string, or a number", () => {
    expect(readModalities(undefined)).toEqual([]);
    expect(readModalities(null)).toEqual([]);
    expect(readModalities("text")).toEqual([]);
    expect(readModalities(42)).toEqual([]);
  });
});
