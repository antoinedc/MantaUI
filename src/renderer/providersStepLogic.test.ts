import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_ID,
  OPENAI_ID,
  OPENAI_BASE_URL,
  connectedProviderIds,
  isProviderConnected,
  canContinueProviders,
  canContinueModel,
  selectableModels,
  formatContextWindow,
  canSubmitProviderKey,
} from "./providersStepLogic";
import type { OpencodeModel } from "../shared/types";

function model(providerID: string, id: string, context?: number): OpencodeModel {
  return {
    id,
    providerID,
    name: id,
    ...(context != null ? { limit: { context } } : {}),
  };
}

describe("connectedProviderIds", () => {
  it("returns empty for null/empty", () => {
    expect(connectedProviderIds(null).size).toBe(0);
    expect(connectedProviderIds(undefined).size).toBe(0);
    expect(connectedProviderIds([]).size).toBe(0);
  });

  it("collects the distinct providerIDs present in the model list", () => {
    const ids = connectedProviderIds([
      model("anthropic", "claude-sonnet-4-6"),
      model("anthropic", "claude-opus-4-7"),
      model("deepseek", "deepseek-chat"),
    ]);
    expect([...ids].sort()).toEqual(["anthropic", "deepseek"]);
  });

  it("ignores entries with a missing/blank providerID", () => {
    const ids = connectedProviderIds([
      { id: "x", providerID: "", name: "x" },
      model("openai", "gpt-4o"),
    ]);
    expect([...ids]).toEqual(["openai"]);
  });
});

describe("isProviderConnected", () => {
  const models = [model("anthropic", "claude-sonnet-4-6")];
  it("true only for a provider with a connected model", () => {
    expect(isProviderConnected(models, ANTHROPIC_ID)).toBe(true);
    expect(isProviderConnected(models, OPENAI_ID)).toBe(false);
    expect(isProviderConnected(null, ANTHROPIC_ID)).toBe(false);
  });
});

describe("canContinueProviders", () => {
  it("false while loading (null) or with no connected provider", () => {
    expect(canContinueProviders(null)).toBe(false);
    expect(canContinueProviders([])).toBe(false);
  });
  it("true once at least one provider is connected", () => {
    expect(canContinueProviders([model("anthropic", "claude-sonnet-4-6")])).toBe(true);
  });
});

describe("canContinueModel", () => {
  it("requires a selection with a non-empty modelID", () => {
    expect(canContinueModel(null)).toBe(false);
    expect(canContinueModel(undefined)).toBe(false);
    expect(canContinueModel({ providerID: "anthropic", modelID: "" })).toBe(false);
    expect(canContinueModel({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })).toBe(true);
  });
});

describe("selectableModels", () => {
  it("returns every model from a connected provider, in original order", () => {
    const models = [
      model("anthropic", "claude-sonnet-4-6"),
      model("openai", "gpt-4o"),
    ];
    // every provider present is connected by construction, so all pass through
    expect(selectableModels(models).map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "gpt-4o",
    ]);
  });
  it("drops entries with a blank providerID", () => {
    const models: OpencodeModel[] = [
      { id: "ghost", providerID: "", name: "ghost" },
      model("anthropic", "claude-sonnet-4-6"),
    ];
    expect(selectableModels(models).map((m) => m.id)).toEqual(["claude-sonnet-4-6"]);
  });
  it("handles null", () => {
    expect(selectableModels(null)).toEqual([]);
  });
});

describe("formatContextWindow", () => {
  it("formats thousands as K", () => {
    expect(formatContextWindow(200000)).toBe("200K context");
    expect(formatContextWindow(128000)).toBe("128K context");
  });
  it("formats millions as M", () => {
    expect(formatContextWindow(1000000)).toBe("1M context");
    expect(formatContextWindow(2000000)).toBe("2M context");
    expect(formatContextWindow(1500000)).toBe("1.5M context");
  });
  it("returns null for missing/invalid limits", () => {
    expect(formatContextWindow(null)).toBeNull();
    expect(formatContextWindow(undefined)).toBeNull();
    expect(formatContextWindow(0)).toBeNull();
    expect(formatContextWindow(-5)).toBeNull();
    expect(formatContextWindow(Number.NaN)).toBeNull();
  });
  it("passes small values through unscaled", () => {
    expect(formatContextWindow(512)).toBe("512 context");
  });
});

describe("canSubmitProviderKey", () => {
  it("requires id + baseURL + apiKey and not submitting", () => {
    const base = { id: OPENAI_ID, baseURL: OPENAI_BASE_URL, apiKey: "sk-x", submitting: false };
    expect(canSubmitProviderKey(base)).toBe(true);
    expect(canSubmitProviderKey({ ...base, apiKey: "  " })).toBe(false);
    expect(canSubmitProviderKey({ ...base, id: "" })).toBe(false);
    expect(canSubmitProviderKey({ ...base, baseURL: "" })).toBe(false);
    expect(canSubmitProviderKey({ ...base, submitting: true })).toBe(false);
  });
});
