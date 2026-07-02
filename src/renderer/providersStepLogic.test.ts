import { describe, it, expect } from "vitest";
import type { OpencodeModel } from "../shared/types";
import {
  connectedProviderIds,
  isProviderConnected,
  canContinueProviders,
  customDraftError,
  openaiKeyError,
  modelDisplayName,
  formatContextWindow,
  sortModelsForPicker,
  canContinueModel,
  ANTHROPIC_ID,
  OPENAI_ID,
} from "./providersStepLogic";

const model = (over: Partial<OpencodeModel>): OpencodeModel => ({
  id: "m",
  providerID: "p",
  name: "M",
  ...over,
});

describe("connectedProviderIds", () => {
  it("collects the distinct providerIDs of served models", () => {
    const ids = connectedProviderIds([
      model({ id: "claude-sonnet-4-6", providerID: "anthropic" }),
      model({ id: "claude-opus-4-7", providerID: "anthropic" }),
      model({ id: "gpt-4o", providerID: "openai" }),
    ]);
    expect([...ids].sort()).toEqual(["anthropic", "openai"]);
  });

  it("is empty for no models (nothing connected)", () => {
    expect(connectedProviderIds([]).size).toBe(0);
  });

  it("ignores models with an empty providerID", () => {
    expect(connectedProviderIds([model({ providerID: "" })]).size).toBe(0);
  });
});

describe("isProviderConnected", () => {
  const models = [model({ providerID: ANTHROPIC_ID })];
  it("true when the provider serves a model", () => {
    expect(isProviderConnected(models, ANTHROPIC_ID)).toBe(true);
  });
  it("false when it does not", () => {
    expect(isProviderConnected(models, OPENAI_ID)).toBe(false);
  });
});

describe("canContinueProviders", () => {
  it("false with zero connected providers", () => {
    expect(canContinueProviders([])).toBe(false);
  });
  it("true with at least one", () => {
    expect(canContinueProviders([model({ providerID: "anthropic" })])).toBe(true);
  });
});

describe("customDraftError", () => {
  it("requires id", () => {
    expect(customDraftError({ id: "  ", name: "", baseURL: "https://x/v1", apiKey: "" })).toMatch(
      /id is required/i,
    );
  });
  it("requires baseURL", () => {
    expect(customDraftError({ id: "x", name: "", baseURL: "", apiKey: "" })).toMatch(
      /base url is required/i,
    );
  });
  it("requires http(s) baseURL", () => {
    expect(customDraftError({ id: "x", name: "", baseURL: "api.x.com/v1", apiKey: "" })).toMatch(
      /http/i,
    );
  });
  it("null when valid (key optional)", () => {
    expect(customDraftError({ id: "x", name: "X", baseURL: "https://api.x.com/v1", apiKey: "" })).toBeNull();
  });
});

describe("openaiKeyError", () => {
  it("requires a key", () => {
    expect(openaiKeyError("   ")).toMatch(/api key is required/i);
  });
  it("null when present", () => {
    expect(openaiKeyError("sk-abc")).toBeNull();
  });
});

describe("modelDisplayName", () => {
  it("prefers name", () => {
    expect(modelDisplayName(model({ id: "claude-sonnet-4-6", name: "Claude Sonnet" }))).toBe(
      "Claude Sonnet",
    );
  });
  it("falls back to id when name blank", () => {
    expect(modelDisplayName(model({ id: "claude-sonnet-4-6", name: "  " }))).toBe(
      "claude-sonnet-4-6",
    );
  });
});

describe("formatContextWindow", () => {
  it("formats whole thousands as K", () => {
    expect(formatContextWindow(model({ limit: { context: 200000 } }))).toBe("200K context");
  });
  it("keeps one decimal for non-whole K", () => {
    expect(formatContextWindow(model({ limit: { context: 32800 } }))).toBe("32.8K context");
  });
  it("sub-1000 renders raw", () => {
    expect(formatContextWindow(model({ limit: { context: 512 } }))).toBe("512 context");
  });
  it("null when unknown", () => {
    expect(formatContextWindow(model({ limit: undefined }))).toBeNull();
    expect(formatContextWindow(model({ limit: { context: 0 } }))).toBeNull();
  });
});

describe("sortModelsForPicker", () => {
  it("groups by provider then display name, stably", () => {
    const sorted = sortModelsForPicker([
      model({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" }),
      model({ id: "claude-opus-4-7", providerID: "anthropic", name: "Claude Opus" }),
      model({ id: "claude-sonnet-4-6", providerID: "anthropic", name: "Claude Sonnet" }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["claude-opus-4-7", "claude-sonnet-4-6", "gpt-4o"]);
  });
  it("does not mutate the input", () => {
    const input = [model({ id: "b" }), model({ id: "a" })];
    sortModelsForPicker(input);
    expect(input.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("canContinueModel", () => {
  const models = [model({ id: "claude-sonnet-4-6", providerID: "anthropic" })];
  it("false with no selection", () => {
    expect(canContinueModel(models, null)).toBe(false);
  });
  it("true when the selection is still served", () => {
    expect(canContinueModel(models, { providerID: "anthropic", modelID: "claude-sonnet-4-6" })).toBe(
      true,
    );
  });
  it("false when the selected model is no longer served", () => {
    expect(canContinueModel(models, { providerID: "anthropic", modelID: "gone" })).toBe(false);
  });
});
