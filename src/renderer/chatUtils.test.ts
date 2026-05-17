import { describe, it, expect } from "vitest";
import {
  formatTokens,
  formatDuration,
  ctxStageColor,
  filterCommands,
  dedupeAgainstBuiltins,
  ASSUMED_CONTEXT_TOKENS,
  resolveContextLimit,
  classifyFinish,
  describeTruncation,
} from "./chatUtils";

// ===== formatTokens =====

describe("formatTokens", () => {
  it("shows raw count below 1k", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(1)).toBe("1 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
  });

  it("shows one-decimal k between 1k and 100k", () => {
    expect(formatTokens(1000)).toBe("1k tokens");
    expect(formatTokens(1500)).toBe("1.5k tokens");
    expect(formatTokens(12_400)).toBe("12.4k tokens");
    expect(formatTokens(99_999)).toBe("100k tokens"); // rounds up
  });

  it("drops decimal when it would be .0", () => {
    expect(formatTokens(5_000)).toBe("5k tokens");
    expect(formatTokens(10_000)).toBe("10k tokens");
  });

  it("shows rounded k at 100k and above", () => {
    expect(formatTokens(100_000)).toBe("100k tokens");
    expect(formatTokens(123_456)).toBe("123k tokens");
    expect(formatTokens(200_000)).toBe("200k tokens");
  });
});

// ===== formatDuration =====

describe("formatDuration", () => {
  it("returns <1s for anything under 1000ms", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("returns seconds for sub-minute durations", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(5_500)).toBe("6s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("returns minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(104_000)).toBe("1m 44s");
  });

  it("returns hours, minutes, and seconds", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
    expect(formatDuration(7_384_000)).toBe("2h 3m 4s");
  });
});

// ===== ctxStageColor =====

describe("ctxStageColor", () => {
  it("returns green below 50%", () => {
    expect(ctxStageColor(0)).toBe("#22c55e");
    expect(ctxStageColor(49)).toBe("#22c55e");
  });

  it("returns yellow from 50% to 74%", () => {
    expect(ctxStageColor(50)).toBe("#eab308");
    expect(ctxStageColor(74)).toBe("#eab308");
  });

  it("returns orange from 75% to 89%", () => {
    expect(ctxStageColor(75)).toBe("#f97316");
    expect(ctxStageColor(89)).toBe("#f97316");
  });

  it("returns red from 90% and above", () => {
    expect(ctxStageColor(90)).toBe("#ef4444");
    expect(ctxStageColor(100)).toBe("#ef4444");
  });
});

// ===== ASSUMED_CONTEXT_TOKENS =====

describe("ASSUMED_CONTEXT_TOKENS", () => {
  it("is 200k", () => {
    expect(ASSUMED_CONTEXT_TOKENS).toBe(200_000);
  });
});

// ===== resolveContextLimit =====

describe("resolveContextLimit", () => {
  it("returns the model's real context limit when set", () => {
    expect(resolveContextLimit({ limit: { context: 1_000_000 } })).toBe(
      1_000_000,
    );
    expect(resolveContextLimit({ limit: { context: 200_000 } })).toBe(200_000);
  });

  it("falls back to the assumed default when model is null/undefined", () => {
    expect(resolveContextLimit(null)).toBe(ASSUMED_CONTEXT_TOKENS);
    expect(resolveContextLimit(undefined)).toBe(ASSUMED_CONTEXT_TOKENS);
  });

  it("falls back when limit or limit.context is missing", () => {
    expect(resolveContextLimit({})).toBe(ASSUMED_CONTEXT_TOKENS);
    expect(resolveContextLimit({ limit: {} })).toBe(ASSUMED_CONTEXT_TOKENS);
  });

  it("rejects non-positive, non-finite, and non-numeric values", () => {
    expect(resolveContextLimit({ limit: { context: 0 } })).toBe(
      ASSUMED_CONTEXT_TOKENS,
    );
    expect(resolveContextLimit({ limit: { context: -1 } })).toBe(
      ASSUMED_CONTEXT_TOKENS,
    );
    expect(resolveContextLimit({ limit: { context: Infinity } })).toBe(
      ASSUMED_CONTEXT_TOKENS,
    );
    expect(resolveContextLimit({ limit: { context: NaN } })).toBe(
      ASSUMED_CONTEXT_TOKENS,
    );
  });
});

// ===== classifyFinish =====

describe("classifyFinish", () => {
  it("returns null for benign / non-truncation finishes", () => {
    expect(classifyFinish("end_turn")).toBeNull();
    expect(classifyFinish("stop")).toBeNull();
    expect(classifyFinish("tool_use")).toBeNull();
    expect(classifyFinish("tool_calls")).toBeNull();
    expect(classifyFinish("stop_sequence")).toBeNull();
    expect(classifyFinish("pause_turn")).toBeNull();
    expect(classifyFinish("refusal")).toBeNull();
  });

  it("returns null for empty / missing finish", () => {
    expect(classifyFinish(null)).toBeNull();
    expect(classifyFinish(undefined)).toBeNull();
    expect(classifyFinish("")).toBeNull();
  });

  it("classifies Anthropic-native context wall", () => {
    expect(classifyFinish("model_context_window_exceeded")).toBe(
      "context-wall",
    );
  });

  it("classifies output-cap from Anthropic / OpenAI / Gemini", () => {
    expect(classifyFinish("max_tokens")).toBe("output-cap"); // Anthropic
    expect(classifyFinish("length")).toBe("output-cap"); // OpenAI
    expect(classifyFinish("MAX_TOKENS")).toBe("output-cap"); // Gemini (case-insensitive)
  });

  it("promotes output-cap to tool-cutoff when last part is a tool_use", () => {
    expect(classifyFinish("max_tokens", { lastPartIsToolUse: true })).toBe(
      "tool-cutoff",
    );
    expect(classifyFinish("length", { lastPartIsToolUse: true })).toBe(
      "tool-cutoff",
    );
  });

  it("does NOT promote context-wall to tool-cutoff (different fix path)", () => {
    // context-wall while tool_use is still distinct: compaction is the
    // remedy, not raising max_tokens. Keep it as context-wall.
    expect(
      classifyFinish("model_context_window_exceeded", {
        lastPartIsToolUse: true,
      }),
    ).toBe("context-wall");
  });

  it("ignores lastPartIsToolUse for non-truncation finishes", () => {
    expect(classifyFinish("end_turn", { lastPartIsToolUse: true })).toBeNull();
    expect(classifyFinish("tool_use", { lastPartIsToolUse: true })).toBeNull();
  });
});

// ===== describeTruncation =====

describe("describeTruncation", () => {
  it("returns distinct label/hint for each kind", () => {
    const a = describeTruncation("output-cap");
    const b = describeTruncation("context-wall");
    const c = describeTruncation("tool-cutoff");
    // Distinct
    expect(a.label).not.toBe(b.label);
    expect(b.label).not.toBe(c.label);
    expect(a.label).not.toBe(c.label);
    // Non-empty
    for (const d of [a, b, c]) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });

  it("context-wall hint recommends /compact", () => {
    expect(describeTruncation("context-wall").hint).toMatch(/compact/i);
  });

  it("tool-cutoff label flags retry", () => {
    expect(describeTruncation("tool-cutoff").label).toMatch(/retry/i);
  });
});

// ===== filterCommands =====

const COMMANDS = [
  { name: "clear", description: "Clear chat" },
  { name: "fork", description: "Fork session" },
  { name: "compact", description: "Compact context" },
  { name: "help", description: "Show help" },
];

describe("filterCommands", () => {
  it("returns all commands when query is empty", () => {
    expect(filterCommands(COMMANDS, "")).toHaveLength(4);
  });

  it("filters by substring match (case-insensitive)", () => {
    expect(filterCommands(COMMANDS, "c")).toEqual([
      { name: "clear", description: "Clear chat" },
      { name: "compact", description: "Compact context" },
    ]);
    expect(filterCommands(COMMANDS, "C")).toEqual([
      { name: "clear", description: "Clear chat" },
      { name: "compact", description: "Compact context" },
    ]);
  });

  it("returns empty array when no match", () => {
    expect(filterCommands(COMMANDS, "zzz")).toEqual([]);
  });

  it("matches full name", () => {
    expect(filterCommands(COMMANDS, "fork")).toEqual([
      { name: "fork", description: "Fork session" },
    ]);
  });
});

// ===== dedupeAgainstBuiltins =====

describe("dedupeAgainstBuiltins", () => {
  const builtins = new Set(["clear", "help", "fork", "compact"]);

  it("removes commands whose names are in the builtin set", () => {
    const opencode = [
      { name: "clear", description: "Opencode clear" },
      { name: "init", description: "Init project" },
      { name: "help", description: "Opencode help" },
      { name: "update-claudemd", description: "Update docs" },
    ];
    const result = dedupeAgainstBuiltins(opencode, builtins);
    expect(result).toEqual([
      { name: "init", description: "Init project" },
      { name: "update-claudemd", description: "Update docs" },
    ]);
  });

  it("returns all commands when none collide", () => {
    const opencode = [
      { name: "deploy", description: "Deploy" },
      { name: "refactor", description: "Refactor" },
    ];
    expect(dedupeAgainstBuiltins(opencode, builtins)).toHaveLength(2);
  });

  it("returns empty array when all commands collide", () => {
    const opencode = [{ name: "clear" }, { name: "help" }];
    expect(dedupeAgainstBuiltins(opencode, builtins)).toEqual([]);
  });
});
