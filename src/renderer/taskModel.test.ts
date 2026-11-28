// The model a task ran on, as the screens name it: the catalog's own name ("GPT-6 Sol"), never the raw "provider/model" key
// unless the catalog doesn't know it.
import { describe, expect, it } from "vitest";
import type { OpencodeModel } from "../shared/types";
import { taskModelLabel } from "./taskModel";

const models = [
  { id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol" },
  { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5" },
] as unknown as OpencodeModel[];

describe("taskModelLabel", () => {
  it("names the model the way the model pickers do: the catalog's name", () => {
    expect(taskModelLabel("openai/gpt-6-sol", models)).toBe("GPT-6 Sol");
    expect(taskModelLabel("anthropic/claude-sonnet-5-5", models)).toBe("Claude Sonnet 5.5");
  });
  it("falls back to the model id when the catalog doesn't know it (or hasn't loaded)", () => {
    expect(taskModelLabel("openai/gpt-7", models)).toBe("gpt-7");
    expect(taskModelLabel("openai/gpt-6-sol", null)).toBe("gpt-6-sol");
    expect(taskModelLabel("local/org/model-x", [])).toBe("org/model-x");
  });
  it("is null when the task has no recorded model", () => {
    expect(taskModelLabel(null, models)).toBeNull();
    expect(taskModelLabel(undefined, models)).toBeNull();
    expect(taskModelLabel("", models)).toBeNull();
    expect(taskModelLabel("nonsense", models)).toBeNull();
  });
});
