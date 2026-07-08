import { describe, it, expect } from "vitest";
import { deriveSubagentName, reconcileSubagents } from "./subagentSync.mjs";

describe("deriveSubagentName", () => {
  it("uses the catalog family key on a hit", () => {
    expect(deriveSubagentName("anthropic", "claude-haiku-4", new Set())).toBe("haiku");
    expect(deriveSubagentName("anthropic", "claude-opus-4", new Set())).toBe("opus");
  });

  it("falls back to a slugified modelID when no family matches", () => {
    expect(deriveSubagentName("voska", "my-custom-model-v2", new Set())).toBe(
      "my-custom-model-v2",
    );
  });

  it("slugifies dots/spaces/special chars and collapses repeats", () => {
    expect(deriveSubagentName("voska", "Weird Model!!  v2.0", new Set())).toBe(
      "weird-model-v2-0",
    );
  });

  it("falls back to providerID, then 'model', when modelID slugifies to empty", () => {
    expect(deriveSubagentName("voska", "___", new Set())).toBe("voska");
    expect(deriveSubagentName("!!!", "___", new Set())).toBe("model");
  });

  it("appends -2, -3, ... on collision", () => {
    const taken = new Set(["haiku"]);
    expect(deriveSubagentName("anthropic", "claude-haiku-4", taken)).toBe("haiku-2");
    taken.add("haiku-2");
    expect(deriveSubagentName("anthropic", "claude-haiku-4", taken)).toBe("haiku-3");
  });

  it("treats the taken set case-insensitively", () => {
    const taken = new Set(["Haiku"]);
    expect(deriveSubagentName("anthropic", "claude-haiku-4", taken)).toBe("haiku-2");
  });

  it("is stable across repeated calls with the same taken set", () => {
    const taken = new Set(["haiku"]);
    const a = deriveSubagentName("anthropic", "claude-haiku-4", taken);
    const b = deriveSubagentName("anthropic", "claude-haiku-4", taken);
    expect(a).toBe(b);
  });

  it("accepts an array as well as a Set for taken", () => {
    expect(deriveSubagentName("anthropic", "claude-haiku-4", ["haiku"])).toBe("haiku-2");
  });
});

describe("reconcileSubagents", () => {
  const haiku = { providerID: "anthropic", id: "claude-haiku-4" };
  const opus = { providerID: "anthropic", id: "claude-opus-4" };
  const custom = { providerID: "voska", id: "my-model" };

  it("upserts a new model with no existing agent", () => {
    const { upsert, remove } = reconcileSubagents({ models: [haiku] });
    expect(remove).toEqual([]);
    expect(upsert).toHaveLength(1);
    expect(upsert[0]).toMatchObject({ name: "haiku", model: "anthropic/claude-haiku-4" });
    expect(upsert[0].description).toContain("Fast");
  });

  it("does not upsert a model that already has an agent block (no-op, preserves it)", () => {
    const existingAgents = [
      { name: "haiku", model: "anthropic/claude-haiku-4", description: "Fast" },
    ];
    const { upsert, remove } = reconcileSubagents({ models: [haiku], existingAgents });
    expect(upsert).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("preserves a user-renamed agent for an already-registered model", () => {
    const existingAgents = [
      { name: "quick", model: "anthropic/claude-haiku-4", description: "My custom desc" },
    ];
    const { upsert, remove } = reconcileSubagents({ models: [haiku], existingAgents });
    expect(upsert).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("removes the agent block for a deactivated model", () => {
    const existingAgents = [
      { name: "haiku", model: "anthropic/claude-haiku-4", description: "Fast" },
    ];
    const { upsert, remove } = reconcileSubagents({
      models: [haiku],
      existingAgents,
      deactivated: ["anthropic/claude-haiku-4"],
    });
    expect(upsert).toEqual([]);
    expect(remove).toEqual(["haiku"]);
  });

  it("does not add a deactivated model with no existing agent block to remove", () => {
    const { upsert, remove } = reconcileSubagents({
      models: [haiku],
      deactivated: ["anthropic/claude-haiku-4"],
    });
    expect(upsert).toEqual([]);
    expect(remove).toEqual([]);
  });

  it("never touches a hand-made agent whose model isn't in the known list", () => {
    const existingAgents = [
      { name: "my-hand-made", model: "anthropic/some-unknown-model", description: "mine" },
    ];
    const { upsert, remove } = reconcileSubagents({ models: [haiku], existingAgents });
    expect(remove).toEqual([]);
    // Untouched means: not upserted (no clobber) and not removed.
    expect(upsert.find((u) => u.name === "my-hand-made")).toBeUndefined();
  });

  it("handles a mixed batch: new + no-op + deactivated-remove + untouched hand-made", () => {
    const existingAgents = [
      { name: "opus", model: "anthropic/claude-opus-4", description: "Deep" },
      { name: "old-custom", model: "voska/my-model", description: "custom" },
      { name: "hand-rolled", model: "anthropic/retired-model", description: "manual" },
    ];
    const { upsert, remove } = reconcileSubagents({
      models: [haiku, opus, custom],
      existingAgents,
      deactivated: ["voska/my-model"],
    });
    expect(upsert).toHaveLength(1);
    expect(upsert[0].model).toBe("anthropic/claude-haiku-4");
    expect(remove).toEqual(["old-custom"]);
  });

  it("resolves name collisions between newly-derived subagents deterministically", () => {
    // Two different unknown-family models that would slugify to the same base.
    const a = { providerID: "voska", id: "Custom Model" };
    const b = { providerID: "voska2", id: "custom-model" };
    const { upsert } = reconcileSubagents({ models: [a, b] });
    const names = upsert.map((u) => u.name).sort();
    expect(names).toEqual(["custom-model", "custom-model-2"]);
  });

  it("is idempotent — running the reconciled state back through produces no further ops", () => {
    const first = reconcileSubagents({ models: [haiku, opus] });
    expect(first.upsert).toHaveLength(2);
    const existingAgents = first.upsert.map((u) => ({ ...u }));
    const second = reconcileSubagents({ models: [haiku, opus], existingAgents });
    expect(second.upsert).toEqual([]);
    expect(second.remove).toEqual([]);
  });

  it("defaults to empty arrays when called with no arguments", () => {
    expect(reconcileSubagents({})).toEqual({ upsert: [], remove: [] });
    expect(reconcileSubagents(undefined)).toEqual({ upsert: [], remove: [] });
  });
});
