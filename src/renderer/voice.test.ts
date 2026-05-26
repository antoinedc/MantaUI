import { describe, it, expect } from "vitest";
import {
  fuzzyMatchModel,
  resolveQuestionAnswer,
  describeVoiceAction,
} from "./voice";
import type { OpencodeModel } from "../shared/types";

const MODELS: OpencodeModel[] = [
  { id: "claude-opus-4-7",   providerID: "anthropic", name: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-5", providerID: "anthropic", name: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5",  providerID: "anthropic", name: "Claude Haiku 4.5" },
  { id: "gpt-5",             providerID: "openai",    name: "GPT-5" },
];

describe("fuzzyMatchModel", () => {
  it("matches by exact id", () => {
    const m = fuzzyMatchModel("claude-opus-4-7", MODELS);
    expect(m?.id).toBe("claude-opus-4-7");
  });
  it("matches by single token in id", () => {
    expect(fuzzyMatchModel("opus", MODELS)?.id).toBe("claude-opus-4-7");
    expect(fuzzyMatchModel("sonnet", MODELS)?.id).toBe("claude-sonnet-4-5");
    expect(fuzzyMatchModel("haiku", MODELS)?.id).toBe("claude-haiku-4-5");
    expect(fuzzyMatchModel("gpt", MODELS)?.id).toBe("gpt-5");
  });
  it("matches by multi-token across id", () => {
    expect(fuzzyMatchModel("sonnet 4", MODELS)?.id).toBe("claude-sonnet-4-5");
  });
  it("matches by name when id misses", () => {
    expect(fuzzyMatchModel("claude opus", MODELS)?.id).toBe("claude-opus-4-7");
  });
  it("matches by provider as a loose fallback", () => {
    expect(fuzzyMatchModel("openai", MODELS)?.id).toBe("gpt-5");
  });
  it("returns null when nothing matches", () => {
    expect(fuzzyMatchModel("llama", MODELS)).toBeNull();
    expect(fuzzyMatchModel("", MODELS)).toBeNull();
    expect(fuzzyMatchModel("opus", [])).toBeNull();
  });
});

describe("resolveQuestionAnswer", () => {
  const OPTIONS = [
    { label: "Yes, proceed" },
    { label: "No, cancel" },
    { label: "Try a different approach" },
  ];
  it("indexes by 1-based numeric", () => {
    expect(resolveQuestionAnswer("1", OPTIONS)).toBe("Yes, proceed");
    expect(resolveQuestionAnswer("3", OPTIONS)).toBe("Try a different approach");
  });
  it("indexes by word numbers", () => {
    expect(resolveQuestionAnswer("two", OPTIONS)).toBe("No, cancel");
  });
  it("matches exact label case-insensitive", () => {
    expect(resolveQuestionAnswer("YES, PROCEED", OPTIONS)).toBe("Yes, proceed");
  });
  it("matches substring", () => {
    expect(resolveQuestionAnswer("yes", OPTIONS)).toBe("Yes, proceed");
    expect(resolveQuestionAnswer("different", OPTIONS)).toBe(
      "Try a different approach",
    );
  });
  it("returns null when out-of-range or no match", () => {
    expect(resolveQuestionAnswer("5", OPTIONS)).toBeNull();
    expect(resolveQuestionAnswer("0", OPTIONS)).toBeNull();
    expect(resolveQuestionAnswer("maybe", OPTIONS)).toBeNull();
    expect(resolveQuestionAnswer("", OPTIONS)).toBeNull();
  });
});

describe("describeVoiceAction", () => {
  it("renders a debug-friendly string per kind", () => {
    expect(describeVoiceAction({ kind: "submit", text: "hi" })).toBe("submit: hi");
    expect(describeVoiceAction({ kind: "model", query: "opus" })).toBe(
      "model: opus",
    );
    expect(describeVoiceAction({ kind: "switch-window", index: 3 })).toBe(
      "switch-window: 3",
    );
    expect(describeVoiceAction({ kind: "clear" })).toBe("clear");
    expect(describeVoiceAction({ kind: "unknown", transcript: "huh" })).toBe(
      "unknown: huh",
    );
  });
});
