import { describe, it, expect } from "vitest";
import { describeModel, familyKey } from "./modelGuide.mjs";

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
