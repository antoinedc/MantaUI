import { describe, it, expect } from "vitest";
import { describeModel } from "./modelGuide.mjs";

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
});
