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
  isTerminalTodo,
  allTodosTerminal,
  selectActiveTodos,
  isSelfFilteringLifecycleEvent,
  applyQuestionEvent,
  commandPrefixKey,
  detectCommandFromText,
  MIN_COMMAND_PREFIX_LEN,
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

// ===== isTerminalTodo / allTodosTerminal =====

describe("isTerminalTodo", () => {
  it("treats completed as terminal", () => {
    expect(isTerminalTodo({ status: "completed" })).toBe(true);
  });

  it("treats cancelled as terminal", () => {
    expect(isTerminalTodo({ status: "cancelled" })).toBe(true);
  });

  it("is case-insensitive (status strings from older opencode may vary)", () => {
    expect(isTerminalTodo({ status: "Completed" })).toBe(true);
    expect(isTerminalTodo({ status: "CANCELLED" })).toBe(true);
  });

  it("returns false for non-terminal statuses", () => {
    expect(isTerminalTodo({ status: "pending" })).toBe(false);
    expect(isTerminalTodo({ status: "in_progress" })).toBe(false);
    expect(isTerminalTodo({ status: "blocked" })).toBe(false);
  });

  it("returns false when status is missing or unexpected", () => {
    expect(isTerminalTodo({})).toBe(false);
    expect(isTerminalTodo({ status: null })).toBe(false);
    expect(isTerminalTodo({ status: 42 })).toBe(false);
  });
});

describe("allTodosTerminal", () => {
  it("returns true when every item is completed or cancelled", () => {
    expect(
      allTodosTerminal([
        { status: "completed" },
        { status: "cancelled" },
        { status: "completed" },
      ]),
    ).toBe(true);
  });

  it("returns false when any item is non-terminal", () => {
    expect(
      allTodosTerminal([
        { status: "completed" },
        { status: "in_progress" },
      ]),
    ).toBe(false);
  });

  it("returns false for empty lists (nothing to dismiss)", () => {
    expect(allTodosTerminal([])).toBe(false);
  });
});

// ===== selectActiveTodos =====

describe("selectActiveTodos", () => {
  const list = [{ content: "a", status: "pending" }];
  const older = [{ content: "old", status: "pending" }];

  it("REGRESSION: empty live list clears the card even when the transcript still has a non-empty TodoWrite", () => {
    // The exact bug: model calls TodoWrite([]) to clear. todo.updated fires
    // with todos:[] → liveTodos=[]. The transcript still holds the prior
    // non-empty list. Old selector gated on liveTodos.length>0, fell through
    // to the transcript, and re-pinned the stale list. Empty live list is
    // authoritative "cleared" → must return null.
    expect(selectActiveTodos([], older, false)).toBeNull();
  });

  it("uses live list when present and non-empty (wins over transcript)", () => {
    expect(selectActiveTodos(list, older, false)).toBe(list);
  });

  it("falls back to transcript ONLY when no live event seen (liveTodos null)", () => {
    expect(selectActiveTodos(null, older, false)).toBe(older);
    expect(selectActiveTodos(undefined, older, false)).toBe(older);
  });

  it("returns null when dismissed, regardless of live or transcript", () => {
    expect(selectActiveTodos(list, older, true)).toBeNull();
    expect(selectActiveTodos(null, older, true)).toBeNull();
  });

  it("returns null when nothing is available", () => {
    expect(selectActiveTodos(null, null, false)).toBeNull();
    expect(selectActiveTodos(null, [], false)).toBeNull();
  });

  it("empty live list beats dismissed=false AND a non-empty transcript (full bug matrix)", () => {
    // Belt-and-suspenders: even with dismissed false and a populated
    // transcript, an empty live list must hide the card.
    expect(selectActiveTodos([], [{ status: "completed" }], false)).toBeNull();
  });
});

// ===== isSelfFilteringLifecycleEvent =====

describe("isSelfFilteringLifecycleEvent", () => {
  it("REGRESSION: question.asked must bypass the per-session guard", () => {
    // The bug: onOpencodeEvent's blanket `props.sessionID !== sessionId`
    // early-return dropped question.asked (whose properties.sessionID is the
    // question's session) before refreshQuestions() could fire — so the
    // question card never appeared. These types must be exempt.
    expect(isSelfFilteringLifecycleEvent("question.asked")).toBe(true);
    expect(isSelfFilteringLifecycleEvent("question.replied")).toBe(true);
    expect(isSelfFilteringLifecycleEvent("question.rejected")).toBe(true);
  });

  it("permission lifecycle events are also exempt (same self-filtering handler)", () => {
    expect(isSelfFilteringLifecycleEvent("permission.asked")).toBe(true);
    expect(isSelfFilteringLifecycleEvent("permission.replied")).toBe(true);
    expect(isSelfFilteringLifecycleEvent("permission.rejected")).toBe(true);
  });

  it("transcript/state events are NOT exempt (they stay per-session filtered)", () => {
    // These genuinely should be dropped for other sessions — exempting them
    // would leak another session's deltas into the viewed transcript.
    for (const t of [
      "message.part.delta",
      "message.updated",
      "todo.updated",
      "session.idle",
      "command.executed",
      "vcs.branch.updated",
      "server.heartbeat",
    ]) {
      expect(isSelfFilteringLifecycleEvent(t)).toBe(false);
    }
  });
});

// ===== applyQuestionEvent =====

describe("applyQuestionEvent", () => {
  const SID = "ses_view";
  const askedProps = {
    id: "que_1",
    sessionID: SID,
    questions: [{ question: "TS or JS?", header: "Lang", options: [] }],
    tool: { messageID: "msg_1", callID: "toolu_1" },
  };

  it("REGRESSION: question.asked populates the list FROM THE EVENT PAYLOAD (not a /question re-poll)", () => {
    // The bug (since 1a5a336): handler called refreshQuestions() → GET
    // /question, which is empty for live questions in opencode v1.15, so
    // the card never appeared. The event payload IS the QuestionRequest;
    // applying it must surface the question.
    const next = applyQuestionEvent([], "question.asked", askedProps, SID);
    expect(next).toHaveLength(1);
    // Canonical id = tool.callID (unifies live event with transcript-scan
    // recovery, which has no que_ id). The que_ id is retained as requestId
    // so a replied event echoing it still clears the card.
    expect(next[0].id).toBe("toolu_1");
    expect(next[0].requestId).toBe("que_1");
    expect(next[0].questions).toEqual(askedProps.questions);
    expect(next[0].tool).toEqual(askedProps.tool);
  });

  it("question.replied removes the answered question", () => {
    const prev = [askedProps];
    expect(
      applyQuestionEvent(prev, "question.replied", { id: "que_1", sessionID: SID }, SID),
    ).toEqual([]);
  });

  it("question.rejected removes the dismissed question", () => {
    const prev = [askedProps];
    expect(
      applyQuestionEvent(prev, "question.rejected", { id: "que_1", sessionID: SID }, SID),
    ).toEqual([]);
  });

  it("question.asked for a DIFFERENT session is ignored (not surfaced in the viewed panel)", () => {
    const other = { ...askedProps, id: "que_2", sessionID: "ses_other" };
    expect(applyQuestionEvent([], "question.asked", other, SID)).toEqual([]);
  });

  it("re-asking the same id dedupes (no duplicate cards)", () => {
    const first = applyQuestionEvent([], "question.asked", askedProps, SID);
    const second = applyQuestionEvent(first, "question.asked", askedProps, SID);
    expect(second).toHaveLength(1);
  });

  it("preserves unrelated pending questions when one is replied", () => {
    const q2 = { ...askedProps, id: "que_2" };
    const prev = [askedProps, q2];
    const next = applyQuestionEvent(prev, "question.replied", { id: "que_1", sessionID: SID }, SID);
    expect(next).toEqual([q2]);
  });

  it("malformed payloads are no-ops (missing id / missing questions)", () => {
    expect(applyQuestionEvent([], "question.asked", undefined, SID)).toEqual([]);
    expect(applyQuestionEvent([], "question.asked", { sessionID: SID }, SID)).toEqual([]);
    expect(
      applyQuestionEvent([], "question.asked", { id: "que_x", sessionID: SID }, SID),
    ).toEqual([]); // no questions array
  });
});

describe("applyQuestionEvent — callID unification & defensive removal", () => {
  const SID = "ses_v";
  const askedViaEvent = {
    id: "que_99",
    sessionID: SID,
    questions: [{ question: "q", header: "h", options: [] }],
    tool: { messageID: "msg_9", callID: "toolu_9" },
  };

  it("asked keys the stored question on tool.callID (unifies with transcript scan)", () => {
    const next = applyQuestionEvent([], "question.asked", askedViaEvent, SID);
    expect(next[0].id).toBe("toolu_9"); // callID, not que_99
  });

  it("replied clears the card even when its id differs from the stored callID", () => {
    const asked = applyQuestionEvent([], "question.asked", askedViaEvent, SID);
    // opencode echoes que_/requestID on replied, not the callID we keyed on
    const cleared = applyQuestionEvent(
      asked,
      "question.replied",
      { sessionID: SID, requestID: "que_99" },
      SID,
    );
    expect(cleared).toEqual([]);
  });

  it("rejected clears via tool.callID match too", () => {
    const asked = applyQuestionEvent([], "question.asked", askedViaEvent, SID);
    const cleared = applyQuestionEvent(
      asked,
      "question.rejected",
      { tool: { callID: "toolu_9" } },
      SID,
    );
    expect(cleared).toEqual([]);
  });
});

// ===== commandPrefixKey =====

describe("commandPrefixKey", () => {
  it("returns the full template when there are no placeholders", () => {
    const tpl = "# Refactor\n\nDo a refactoring session, no args.";
    expect(commandPrefixKey(tpl)).toBe(tpl);
  });

  it("truncates at the first $ARGUMENTS placeholder", () => {
    const tpl = "Create a component named $ARGUMENTS with TypeScript.";
    expect(commandPrefixKey(tpl)).toBe("Create a component named");
  });

  it("truncates at the first $N positional placeholder", () => {
    const tpl = "Create a file named $1 in $2 with content $3.";
    expect(commandPrefixKey(tpl)).toBe("Create a file named");
  });

  it("returns null for templates shorter than MIN_COMMAND_PREFIX_LEN", () => {
    // Even with a long template, if the prefix before the first $ is short,
    // it would generate too many false positives. Reject.
    expect(commandPrefixKey("$1 do thing")).toBeNull();
    expect(commandPrefixKey("Run $1 do thing")).toBeNull(); // "Run" < 12
  });

  it("strips trailing whitespace from the prefix", () => {
    const tpl = "Some prefix here   $ARGUMENTS more stuff";
    expect(commandPrefixKey(tpl)).toBe("Some prefix here");
  });

  it("handles non-string input defensively", () => {
    expect(commandPrefixKey(undefined as unknown as string)).toBeNull();
  });

  it("treats sentinel length correctly", () => {
    // Exactly MIN_COMMAND_PREFIX_LEN chars → accepted.
    const exact = "a".repeat(MIN_COMMAND_PREFIX_LEN);
    expect(commandPrefixKey(exact)).toBe(exact);
    // One char shorter → rejected.
    expect(commandPrefixKey("a".repeat(MIN_COMMAND_PREFIX_LEN - 1))).toBeNull();
  });
});

// ===== detectCommandFromText =====

describe("detectCommandFromText", () => {
  const commands = [
    { name: "refactor", template: "# Refactor\n\nYou are doing a focused refactoring session." },
    { name: "deploy", template: "# Deploy\n\nDeploy the project to production using ./scripts/deploy.sh." },
    { name: "component", template: "Create a new React component named $ARGUMENTS with TypeScript." },
    { name: "short", template: "$1 foo" }, // prefix too short, ignored
  ];

  it("returns null for empty / missing text", () => {
    expect(detectCommandFromText("", commands)).toBeNull();
    expect(detectCommandFromText(undefined as unknown as string, commands)).toBeNull();
  });

  it("returns null when no command matches", () => {
    expect(detectCommandFromText("Just a plain user prompt.", commands)).toBeNull();
  });

  it("matches a no-argument command on full template equality", () => {
    expect(detectCommandFromText(commands[0].template!, commands)).toBe("refactor");
  });

  it("matches a placeholder command on its static prefix", () => {
    expect(
      detectCommandFromText("Create a new React component named Button with TypeScript.", commands),
    ).toBe("component");
  });

  it("ignores commands whose prefix is too short", () => {
    // The "short" command has a sub-MIN_COMMAND_PREFIX_LEN prefix and must
    // not match arbitrary user prompts that happen to start similarly.
    expect(detectCommandFromText("any text whatsoever", commands)).toBeNull();
  });

  it("picks the longest matching prefix when multiple commands would match", () => {
    const overlap = [
      { name: "general", template: "# Header line that is long enough." },
      { name: "specific", template: "# Header line that is long enough. With more detail here." },
    ];
    // Text matches both prefixes; the more specific one wins.
    const text = "# Header line that is long enough. With more detail here. and trailing text";
    expect(detectCommandFromText(text, overlap)).toBe("specific");
  });

  it("returns null for empty commands list", () => {
    expect(detectCommandFromText("# Refactor\n\nYou are doing...", [])).toBeNull();
  });

  it("skips commands without a template", () => {
    const noTemplate = [{ name: "x" }, { name: "refactor", template: commands[0].template }];
    expect(detectCommandFromText(commands[0].template!, noTemplate)).toBe("refactor");
  });
});
