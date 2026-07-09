import { describe, it, expect } from "vitest";
import {
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  sanitizeGeneratedTitle,
  AUTO_RENAME_EVERY_N_TURNS,
  formatTokens,
  formatBytes,
  formatDuration,
  formatClockTime,
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
  selectVisibleTodos,
  formatHiddenTodosSummary,
  VISIBLE_TODOS_CAP,
  isSelfFilteringLifecycleEvent,
  applyQuestionEvent,
  hydrateQuestion,
  buildQuestionAnswers,
  canSubmitQuestion,
  commandPrefixKey,
  detectCommandFromText,
  MIN_COMMAND_PREFIX_LEN,
  isAssistantTurnComplete,
  isAssistantTurnInProgress,
  computeContextBreakdown,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  computeStaleCache,
  STALE_CACHE_MIN_TOKENS,
  formatAge,
  classifyCacheAge,
  findFlushBoundary,
  mergeBufferedDeltas,
  extractSubagentInfo,
  collectChildSessionIds,
  countRunningSubagents,
  summarizeChildSession,
  registerChildSessionFromCreated,
  shouldDropEventForSessionFilter,
  SCROLL_REPIN_PX,
  distFromBottom,
  classifyScrollForPin,
  wasAtBottomBeforeCommit,
  shouldAbortForQueuedDrain,
  isToolStepBoundary,
  isDrainAbortError,
  describeCron,
  nextCronRun,
  describeNextRun,
  resolveToolOutput,
  reconcileOptimisticUser,
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

// ===== formatBytes =====

describe("formatBytes", () => {
  it("returns empty string for 0 / unknown / negative", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
    expect(formatBytes(NaN)).toBe("");
  });

  it("formats raw bytes under 1 KiB", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KB with one decimal under 10, rounded above", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
  });

  it("scales up through MB / GB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
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

// ===== formatClockTime =====

describe("formatClockTime", () => {
  it("returns empty string for null/undefined/non-finite", () => {
    expect(formatClockTime(null)).toBe("");
    expect(formatClockTime(undefined)).toBe("");
    expect(formatClockTime(NaN)).toBe("");
    expect(formatClockTime(Infinity)).toBe("");
  });

  it("formats epoch ms as zero-padded 24h HH:MM (local time)", () => {
    // Build a known local time so the test is timezone-independent.
    const d = new Date(2026, 0, 2, 9, 5, 0); // 09:05 local
    expect(formatClockTime(d.getTime())).toBe("09:05");
    const d2 = new Date(2026, 0, 2, 23, 59, 0); // 23:59 local
    expect(formatClockTime(d2.getTime())).toBe("23:59");
    const d3 = new Date(2026, 0, 2, 0, 0, 0); // 00:00 local
    expect(formatClockTime(d3.getTime())).toBe("00:00");
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

// ===== computeContextBreakdown =====

describe("computeContextBreakdown", () => {
  it("returns all zeros for null/undefined tokens", () => {
    const b = computeContextBreakdown(null, 200_000);
    expect(b.freshInput).toBe(0);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(0);
    expect(b.totalInput).toBe(0);
    expect(b.pct).toBe(0);
    expect(b.segments.every((s) => s.pct === 0)).toBe(true);
  });

  it("sums input + cache.read + cache.write into totalInput (all three consume the window)", () => {
    const b = computeContextBreakdown(
      { input: 10_000, cache: { read: 30_000, write: 5_000 } },
      200_000,
    );
    expect(b.freshInput).toBe(10_000);
    expect(b.cacheRead).toBe(30_000);
    expect(b.cacheWrite).toBe(5_000);
    expect(b.totalInput).toBe(45_000);
    // 45_000 / 200_000 = 22.5% → 23 rounded
    expect(b.pct).toBe(23);
  });

  it("ignores output / reasoning (not part of context window)", () => {
    // Caller only passes the input-bucket fields; the function MUST NOT
    // try to read .output or .reasoning. Pass-through arbitrary extra
    // keys to confirm.
    const b = computeContextBreakdown(
      {
        input: 1_000,
        cache: { read: 1_000, write: 0 },
        // @ts-expect-error — extra fields should be ignored
        output: 999_999,
        reasoning: 999_999,
      },
      200_000,
    );
    expect(b.totalInput).toBe(2_000);
  });

  it("clamps pct to 100 when over-context", () => {
    const b = computeContextBreakdown(
      { input: 250_000, cache: { read: 0, write: 0 } },
      200_000,
    );
    expect(b.totalInput).toBe(250_000);
    expect(b.pct).toBe(100);
    // Segment percentages should scale down so their sum never exceeds 100.
    const sum = b.segments.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBeLessThanOrEqual(100 + 0.001);
  });

  it("produces per-segment percentages of the LIMIT (not totalInput)", () => {
    const b = computeContextBreakdown(
      { input: 20_000, cache: { read: 60_000, write: 20_000 } },
      200_000,
    );
    // Each segment's pct should equal bucket / 200_000 * 100.
    const fresh = b.segments.find((s) => s.kind === "fresh");
    const read = b.segments.find((s) => s.kind === "cacheRead");
    const write = b.segments.find((s) => s.kind === "cacheWrite");
    expect(fresh?.pct).toBeCloseTo(10, 5);
    expect(read?.pct).toBeCloseTo(30, 5);
    expect(write?.pct).toBeCloseTo(10, 5);
    // And they should sum to the same percent as `pct` (modulo rounding).
    const segSum = (fresh?.pct ?? 0) + (read?.pct ?? 0) + (write?.pct ?? 0);
    expect(Math.round(segSum)).toBe(b.pct);
  });

  it("renders segment order fresh → cacheWrite → cacheRead", () => {
    // The bar reads left→right as cost-decreasing: full-rate fresh
    // tokens, then the warm-up bucket (full + surcharge), then the
    // cheap cached bucket on the right.
    const b = computeContextBreakdown(
      { input: 1, cache: { read: 1, write: 1 } },
      200_000,
    );
    expect(b.segments.map((s) => s.kind)).toEqual([
      "fresh",
      "cacheWrite",
      "cacheRead",
    ]);
  });

  it("treats missing cache as zero", () => {
    const b = computeContextBreakdown({ input: 5_000 }, 200_000);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(0);
    expect(b.totalInput).toBe(5_000);
  });

  it("clamps negative inputs to zero (defensive)", () => {
    const b = computeContextBreakdown(
      { input: -100, cache: { read: -50, write: -1 } },
      200_000,
    );
    expect(b.freshInput).toBe(0);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(0);
    expect(b.totalInput).toBe(0);
  });

  it("falls back to ASSUMED_CONTEXT_TOKENS when limit is non-positive", () => {
    // Avoids division-by-zero / negative-pct paths.
    const b = computeContextBreakdown(
      { input: 100_000, cache: { read: 0, write: 0 } },
      0,
    );
    // 100_000 / 200_000 = 50%
    expect(b.pct).toBe(50);
  });
});

// ===== findFlushBoundary =====

describe("findFlushBoundary", () => {
  it("returns -1 for empty / no-boundary input", () => {
    expect(findFlushBoundary("")).toBe(-1);
    expect(findFlushBoundary("hello world")).toBe(-1);
    expect(findFlushBoundary("single line\n")).toBe(-1);
  });

  it("returns position after \\n\\n for a paragraph break", () => {
    const buf = "first paragraph\n\nsecond";
    const idx = findFlushBoundary(buf);
    // Should slice the "first paragraph\n\n" prefix (length 17).
    expect(idx).toBe("first paragraph\n\n".length);
    expect(buf.slice(0, idx)).toBe("first paragraph\n\n");
    expect(buf.slice(idx)).toBe("second");
  });

  it("returns the LAST boundary when multiple paragraph breaks exist", () => {
    const buf = "one\n\ntwo\n\nthree";
    const idx = findFlushBoundary(buf);
    // Should flush through "one\n\ntwo\n\n".
    expect(idx).toBe("one\n\ntwo\n\n".length);
    expect(buf.slice(0, idx)).toBe("one\n\ntwo\n\n");
    expect(buf.slice(idx)).toBe("three");
  });

  it("does NOT flush \\n\\n inside an open code block", () => {
    // The blank line is inside an open ```fence, so we mustn't flush
    // (the user wants the whole code block at once, and rendering
    // half a fence as inline code is the jitter we're fixing).
    const buf = "intro\n\n```\nfunction foo() {\n\n  return 1;";
    const idx = findFlushBoundary(buf);
    // Only the "intro\n\n" prefix is safe to flush.
    expect(idx).toBe("intro\n\n".length);
  });

  it("flushes through the closing ``` fence + trailing newline", () => {
    const buf = "intro\n\n```\nconst x = 1;\n```\nafter";
    const idx = findFlushBoundary(buf);
    // Should flush through the entire code block AND the newline after
    // the closing fence: "intro\n\n```\nconst x = 1;\n```\n".
    const expected = "intro\n\n```\nconst x = 1;\n```\n";
    expect(idx).toBe(expected.length);
    expect(buf.slice(0, idx)).toBe(expected);
    expect(buf.slice(idx)).toBe("after");
  });

  it("does NOT flush a closing ``` without its trailing newline yet", () => {
    // The closing fence has arrived but no newline followed yet —
    // we don't know if the next char is part of the same line (it
    // shouldn't be, but defensive).
    const buf = "intro\n\n```\nconst x = 1;\n```";
    const idx = findFlushBoundary(buf);
    // Only the leading paragraph is flushable.
    expect(idx).toBe("intro\n\n".length);
  });

  it("treats ``` as a toggle: open / close / open / close", () => {
    // Two complete code blocks with intervening paragraph.
    const buf = "```\nA\n```\n\nbetween\n\n```\nB\n```\nend";
    const idx = findFlushBoundary(buf);
    // Should flush through the SECOND closing fence's trailing newline:
    // "```\nA\n```\n\nbetween\n\n```\nB\n```\n".
    const expected = "```\nA\n```\n\nbetween\n\n```\nB\n```\n";
    expect(idx).toBe(expected.length);
    expect(buf.slice(idx)).toBe("end");
  });

  it("coalesces consecutive newlines past \\n\\n", () => {
    // "\n\n\n" (three newlines) should flush through all three.
    const buf = "para\n\n\nnext";
    const idx = findFlushBoundary(buf);
    expect(buf.slice(0, idx)).toBe("para\n\n\n");
    expect(buf.slice(idx)).toBe("next");
  });

  it("handles ``` at the very start of the buffer", () => {
    // Open code block at position 0.
    const buf = "```js\nconst x = 1;";
    expect(findFlushBoundary(buf)).toBe(-1);
  });

  it("handles ``` immediately followed by ``` (empty code block)", () => {
    const buf = "```\n```\nafter";
    const idx = findFlushBoundary(buf);
    // Should flush through the closing fence's newline.
    const expected = "```\n```\n";
    expect(idx).toBe(expected.length);
  });

  it("ignores stray single backticks (inline code chars)", () => {
    // Single ` is not a fence start; should not toggle the in-code flag.
    const buf = "Use `foo` and `bar`\n\nafter";
    const idx = findFlushBoundary(buf);
    expect(buf.slice(0, idx)).toBe("Use `foo` and `bar`\n\n");
  });
});

// ===== mergeBufferedDeltas =====

describe("mergeBufferedDeltas", () => {
  type Part = { id: string; text?: string; type?: string; [k: string]: unknown };
  type Msg = { info: { id: string }; parts: Part[] };

  const makeMessages = (): Msg[] => [
    {
      info: { id: "msg1" },
      parts: [
        { id: "p1", type: "text", text: "hello " },
        { id: "p2", type: "reasoning", text: "thinking " },
      ],
    },
    {
      info: { id: "msg2" },
      parts: [{ id: "p3", type: "text", text: "" }],
    },
  ];

  it("returns input unchanged when buffer is empty", () => {
    const msgs = makeMessages();
    const result = mergeBufferedDeltas(msgs, new Map());
    expect(result.messages).toBe(msgs);
    expect(result.unmatched).toEqual([]);
  });

  it("returns input unchanged when messages is null/undefined", () => {
    const buf = new Map([
      ["p1", { messageID: "msg1", field: "text", text: "x" }],
    ]);
    expect(mergeBufferedDeltas(null, buf).messages).toBeNull();
    expect(mergeBufferedDeltas(undefined, buf).messages).toBeUndefined();
  });

  it("appends a single delta to the matching part", () => {
    const msgs = makeMessages();
    const buf = new Map([
      ["p1", { messageID: "msg1", field: "text", text: "world" }],
    ]);
    const { messages: next, unmatched } = mergeBufferedDeltas(msgs, buf);
    expect(unmatched).toEqual([]);
    expect(next).not.toBe(msgs); // new reference
    const part = (next as Msg[])[0].parts[0];
    expect(part.text).toBe("hello world");
    // Sibling part untouched.
    expect((next as Msg[])[0].parts[1].text).toBe("thinking ");
  });

  it("appends to multiple parts of the same message in one pass", () => {
    const msgs = makeMessages();
    const buf = new Map([
      ["p1", { messageID: "msg1", field: "text", text: "WORLD" }],
      ["p2", { messageID: "msg1", field: "text", text: "MORE" }],
    ]);
    const { messages: next, unmatched } = mergeBufferedDeltas(msgs, buf);
    expect(unmatched).toEqual([]);
    // Fixture has "hello " with a trailing space; helper just appends.
    expect((next as Msg[])[0].parts[0].text).toBe("hello WORLD");
    expect((next as Msg[])[0].parts[1].text).toBe("thinking MORE");
  });

  it("appends to parts across multiple messages", () => {
    const msgs = makeMessages();
    const buf = new Map([
      ["p1", { messageID: "msg1", field: "text", text: "world" }],
      ["p3", { messageID: "msg2", field: "text", text: "fresh" }],
    ]);
    const { messages: next } = mergeBufferedDeltas(msgs, buf);
    expect((next as Msg[])[0].parts[0].text).toBe("hello world");
    expect((next as Msg[])[1].parts[0].text).toBe("fresh");
  });

  it("reports unmatched partIDs when a part isn't in messages", () => {
    const msgs = makeMessages();
    const buf = new Map([
      ["p1", { messageID: "msg1", field: "text", text: "ok" }],
      ["pNEW", { messageID: "msgNEW", field: "text", text: "race" }],
    ]);
    const { messages: next, unmatched } = mergeBufferedDeltas(msgs, buf);
    expect(unmatched).toEqual(["pNEW"]);
    // The matched one still applies.
    expect((next as Msg[])[0].parts[0].text).toBe("hello ok");
  });

  it("returns same reference when nothing matches", () => {
    const msgs = makeMessages();
    const buf = new Map([
      ["pNEW", { messageID: "msgNEW", field: "text", text: "race" }],
    ]);
    const { messages: next, unmatched } = mergeBufferedDeltas(msgs, buf);
    expect(next).toBe(msgs); // unchanged reference, lets React skip re-render
    expect(unmatched).toEqual(["pNEW"]);
  });

  it("supports non-text fields (e.g. tool output streaming)", () => {
    const msgs: Msg[] = [
      {
        info: { id: "m1" },
        parts: [{ id: "p1", type: "tool", state: { output: "a" } } as Part],
      },
    ];
    const buf = new Map([
      ["p1", { messageID: "m1", field: "output", text: "bcd" }],
    ]);
    const { messages: next } = mergeBufferedDeltas(msgs, buf);
    // The merge writes to the named field on the part itself, NOT into
    // nested state (state.output handling is the caller's
    // responsibility — keep this helper field-flat).
    expect((next as Msg[])[0].parts[0].output).toBe("bcd");
  });

  it("treats missing field as empty string before appending", () => {
    const msgs: Msg[] = [
      { info: { id: "m1" }, parts: [{ id: "p1", type: "text" }] },
    ];
    const buf = new Map([
      ["p1", { messageID: "m1", field: "text", text: "first" }],
    ]);
    const { messages: next } = mergeBufferedDeltas(msgs, buf);
    expect((next as Msg[])[0].parts[0].text).toBe("first");
  });
});

// ===== selectCacheTtlMs =====

describe("selectCacheTtlMs", () => {
  it("returns 5 minutes for '5m'", () => {
    expect(selectCacheTtlMs("5m")).toBe(5 * 60 * 1000);
  });

  it("returns 1 hour for '1h'", () => {
    expect(selectCacheTtlMs("1h")).toBe(60 * 60 * 1000);
  });
});

// ===== selectLastAssistantCompletion =====

describe("selectLastAssistantCompletion", () => {
  it("returns null for empty/null/undefined input", () => {
    expect(selectLastAssistantCompletion(null)).toBeNull();
    expect(selectLastAssistantCompletion(undefined)).toBeNull();
    expect(selectLastAssistantCompletion([])).toBeNull();
  });

  it("returns null when no assistant message has completed yet", () => {
    expect(
      selectLastAssistantCompletion([
        { info: { role: "user", time: { completed: 1000 } } },
      ]),
    ).toBeNull();
    // Assistant message present but in-flight (no completed stamp).
    expect(
      selectLastAssistantCompletion([
        { info: { role: "assistant", time: { created: 1000 } } },
      ]),
    ).toBeNull();
  });

  it("returns the most recent completed assistant turn", () => {
    const msgs = [
      { info: { role: "user", time: { completed: 1000 } } },
      { info: { role: "assistant", time: { completed: 2000 } } },
      { info: { role: "user", time: { completed: 3000 } } },
      { info: { role: "assistant", time: { completed: 4000 } } },
    ];
    expect(selectLastAssistantCompletion(msgs)).toBe(4000);
  });

  it("walks backwards past in-flight assistant turns to find the last complete one", () => {
    // Last assistant has no `completed` (turn still streaming) — should
    // return the prior completed assistant turn instead of null.
    const msgs = [
      { info: { role: "assistant", time: { completed: 1000 } } },
      { info: { role: "user", time: { completed: 1500 } } },
      { info: { role: "assistant", time: { created: 2000 } } },
    ];
    expect(selectLastAssistantCompletion(msgs)).toBe(1000);
  });

  it("ignores non-numeric / zero / negative completion stamps", () => {
    const msgs = [
      { info: { role: "assistant", time: { completed: 0 } } },
      { info: { role: "assistant", time: { completed: -1 } } },
      { info: { role: "assistant", time: {} } },
    ];
    expect(selectLastAssistantCompletion(msgs)).toBeNull();
  });
});

// ===== computeStaleCache =====

describe("computeStaleCache", () => {
  const TTL_5M = 5 * 60 * 1000;
  const TTL_1H = 60 * 60 * 1000;

  it("returns isStale=false when running, regardless of idle time", () => {
    const r = computeStaleCache({
      lastCompleted: 0,
      now: TTL_1H * 10, // far past any TTL
      ttlMs: TTL_5M,
      cachedTokens: 100_000,
      running: true,
    });
    expect(r.isStale).toBe(false);
  });

  it("returns isStale=false when no turn has completed yet", () => {
    const r = computeStaleCache({
      lastCompleted: null,
      now: 999_999_999,
      ttlMs: TTL_5M,
      cachedTokens: 100_000,
    });
    expect(r.isStale).toBe(false);
  });

  it("returns isStale=false when cached prefix is below the minimum", () => {
    const r = computeStaleCache({
      lastCompleted: 0,
      now: TTL_5M * 2,
      ttlMs: TTL_5M,
      cachedTokens: STALE_CACHE_MIN_TOKENS - 1,
    });
    expect(r.isStale).toBe(false);
  });

  it("returns isStale=false when idle is below the TTL", () => {
    const r = computeStaleCache({
      lastCompleted: 1_000_000,
      now: 1_000_000 + TTL_5M - 1,
      ttlMs: TTL_5M,
      cachedTokens: 50_000,
    });
    expect(r.isStale).toBe(false);
    expect(r.idleMs).toBe(TTL_5M - 1);
  });

  it("returns isStale=true when idle >= TTL AND tokens >= min AND not running", () => {
    const r = computeStaleCache({
      lastCompleted: 1_000_000,
      now: 1_000_000 + TTL_5M,
      ttlMs: TTL_5M,
      cachedTokens: 50_000,
    });
    expect(r.isStale).toBe(true);
    expect(r.idleMs).toBe(TTL_5M);
    expect(r.staleTokens).toBe(50_000);
    expect(r.ttlMs).toBe(TTL_5M);
  });

  it("respects a 1h TTL — 30min idle is fresh, 90min is stale", () => {
    const base = 1_000_000;
    const at30 = computeStaleCache({
      lastCompleted: base,
      now: base + 30 * 60_000,
      ttlMs: TTL_1H,
      cachedTokens: 200_000,
    });
    const at90 = computeStaleCache({
      lastCompleted: base,
      now: base + 90 * 60_000,
      ttlMs: TTL_1H,
      cachedTokens: 200_000,
    });
    expect(at30.isStale).toBe(false);
    expect(at90.isStale).toBe(true);
  });

  it("supports a custom minimum threshold", () => {
    const r = computeStaleCache({
      lastCompleted: 0,
      now: TTL_5M * 2,
      ttlMs: TTL_5M,
      cachedTokens: 100,
      minCacheTokens: 50,
    });
    expect(r.isStale).toBe(true);
    expect(r.staleTokens).toBe(100);
  });

  it("clamps idleMs and staleTokens to non-negative", () => {
    // Now BEFORE lastCompleted (clock skew) — should not produce negative idle.
    const r = computeStaleCache({
      lastCompleted: 2_000_000,
      now: 1_000_000,
      ttlMs: TTL_5M,
      cachedTokens: -500,
    });
    expect(r.idleMs).toBe(0);
    expect(r.staleTokens).toBe(0);
    expect(r.isStale).toBe(false);
  });

  it("rounds fractional cachedTokens", () => {
    const r = computeStaleCache({
      lastCompleted: 0,
      now: TTL_5M * 2,
      ttlMs: TTL_5M,
      cachedTokens: 49_999.7,
    });
    expect(r.staleTokens).toBe(50_000);
  });
});

// ===== formatAge =====

describe("formatAge", () => {
  it("collapses sub-minute elapsed to 'now'", () => {
    expect(formatAge(0)).toBe("now");
    expect(formatAge(59_000)).toBe("now");
  });

  it("floors to minutes below an hour", () => {
    expect(formatAge(60_000)).toBe("1m");
    expect(formatAge(59 * 60_000)).toBe("59m");
  });

  it("floors to hours below a day", () => {
    expect(formatAge(60 * 60_000)).toBe("1h");
    expect(formatAge(23 * 3_600_000)).toBe("23h");
  });

  it("floors to days at/above 24h", () => {
    expect(formatAge(24 * 3_600_000)).toBe("1d");
  });

  it("treats negative/NaN input as 'now'", () => {
    expect(formatAge(-1000)).toBe("now");
    expect(formatAge(NaN)).toBe("now");
  });
});

// ===== classifyCacheAge =====

describe("classifyCacheAge", () => {
  const TTL_1H = 3_600_000;
  const TTL_5M = 300_000;

  it("is fresh below 50% of ttl", () => {
    expect(classifyCacheAge(0, 0, TTL_1H)).toBe("fresh");
    expect(classifyCacheAge(0, 1_799_999, TTL_1H)).toBe("fresh");
  });

  it("is aging between 50% and 90% of ttl", () => {
    expect(classifyCacheAge(0, 1_800_000, TTL_1H)).toBe("aging");
    expect(classifyCacheAge(0, 3_239_999, TTL_1H)).toBe("aging");
  });

  it("is stale at/above 90% of ttl", () => {
    expect(classifyCacheAge(0, 3_240_000, TTL_1H)).toBe("stale");
  });

  it("works with the 5m ttl", () => {
    expect(classifyCacheAge(0, 150_000, TTL_5M)).toBe("aging");
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

// ===== selectVisibleTodos / formatHiddenTodosSummary =====

describe("selectVisibleTodos", () => {
  const todo = (content: string, status: string) => ({ content, status });

  it("cap matches the exported constant (sanity)", () => {
    expect(VISIBLE_TODOS_CAP).toBe(5);
  });

  it("returns every todo with zero hidden counts when under the cap", () => {
    const list = [
      todo("a", "pending"),
      todo("b", "in_progress"),
      todo("c", "completed"),
    ];
    const out = selectVisibleTodos(list);
    // Order is in_progress → pending → done, NOT input order.
    expect(out.visible.map((t) => t.content)).toEqual(["b", "a", "c"]);
    expect(out.hiddenPending).toBe(0);
    expect(out.hiddenDone).toBe(0);
  });

  it("returns empty visible + zero hidden for empty input", () => {
    const out = selectVisibleTodos([]);
    expect(out.visible).toEqual([]);
    expect(out.hiddenPending).toBe(0);
    expect(out.hiddenDone).toBe(0);
  });

  it("orders current → pending → done regardless of input order", () => {
    const list = [
      todo("done1", "completed"),
      todo("pend1", "pending"),
      todo("current", "in_progress"),
      todo("done2", "cancelled"),
      todo("pend2", "pending"),
    ];
    const out = selectVisibleTodos(list);
    expect(out.visible.map((t) => t.content)).toEqual([
      "current",
      "pend1",
      "pend2",
      "done1",
      "done2",
    ]);
  });

  it("preserves input order within each bucket (no content re-sort)", () => {
    // Stable order matters — TodoWrite returns the list in the order the
    // model picked; re-sorting by content would scramble user intent.
    const list = [
      todo("z-pending", "pending"),
      todo("a-pending", "pending"),
      todo("m-pending", "pending"),
    ];
    const out = selectVisibleTodos(list);
    expect(out.visible.map((t) => t.content)).toEqual([
      "z-pending",
      "a-pending",
      "m-pending",
    ]);
  });

  it("truncates at the cap and counts hidden by bucket (pending + done)", () => {
    const list = [
      todo("ip", "in_progress"),
      todo("p1", "pending"),
      todo("p2", "pending"),
      todo("p3", "pending"),
      todo("p4", "pending"),
      // Above five fill the visible slots. Below should be hidden.
      todo("p5", "pending"),
      todo("p6", "pending"),
      todo("d1", "completed"),
      todo("d2", "cancelled"),
      todo("d3", "completed"),
    ];
    const out = selectVisibleTodos(list);
    expect(out.visible).toHaveLength(5);
    expect(out.visible.map((t) => t.content)).toEqual([
      "ip",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(out.hiddenPending).toBe(2);
    expect(out.hiddenDone).toBe(3);
  });

  it("hides only done when all in_progress + pending fit under the cap", () => {
    const list = [
      todo("ip", "in_progress"),
      todo("p1", "pending"),
      todo("d1", "completed"),
      todo("d2", "completed"),
      todo("d3", "completed"),
      todo("d4", "completed"),
      todo("d5", "completed"),
    ];
    const out = selectVisibleTodos(list);
    expect(out.visible.map((t) => t.content)).toEqual([
      "ip",
      "p1",
      "d1",
      "d2",
      "d3",
    ]);
    expect(out.hiddenPending).toBe(0);
    expect(out.hiddenDone).toBe(2);
  });

  it("classifies unknown statuses as pending (blocked, etc.)", () => {
    // isTerminalTodo treats only completed/cancelled as terminal — the
    // visible-todo selector mirrors that so a "blocked" item never gets
    // accidentally counted as done.
    const list = [
      todo("ip", "in_progress"),
      todo("blocked", "blocked"),
      todo("done", "completed"),
    ];
    const out = selectVisibleTodos(list, 1);
    expect(out.visible.map((t) => t.content)).toEqual(["ip"]);
    expect(out.hiddenPending).toBe(1); // "blocked" counted as pending
    expect(out.hiddenDone).toBe(1);
  });

  it("respects a custom cap (used by tests; UI always passes the default)", () => {
    const list = [
      todo("ip", "in_progress"),
      todo("p1", "pending"),
      todo("p2", "pending"),
    ];
    const out = selectVisibleTodos(list, 2);
    expect(out.visible.map((t) => t.content)).toEqual(["ip", "p1"]);
    expect(out.hiddenPending).toBe(1);
    expect(out.hiddenDone).toBe(0);
  });

  it("is case-insensitive on status (matches isTerminalTodo behavior)", () => {
    const list = [
      todo("a", "IN_PROGRESS"),
      todo("b", "Completed"),
      todo("c", "Pending"),
    ];
    const out = selectVisibleTodos(list);
    expect(out.visible.map((t) => t.content)).toEqual(["a", "c", "b"]);
  });
});

describe("formatHiddenTodosSummary", () => {
  it("returns null when nothing is hidden", () => {
    expect(formatHiddenTodosSummary(0, 0)).toBeNull();
  });

  it("formats pending-only", () => {
    expect(formatHiddenTodosSummary(5, 0)).toBe("+ 5 pending");
    expect(formatHiddenTodosSummary(1, 0)).toBe("+ 1 pending");
  });

  it("formats done-only", () => {
    expect(formatHiddenTodosSummary(0, 4)).toBe("+ 4 done");
    expect(formatHiddenTodosSummary(0, 1)).toBe("+ 1 done");
  });

  it("formats both with the literal '&' separator from the spec", () => {
    expect(formatHiddenTodosSummary(5, 5)).toBe("+ 5 pending & 5 done");
    expect(formatHiddenTodosSummary(2, 3)).toBe("+ 2 pending & 3 done");
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

// ===== BET-112 regression: live path replaces stale GET /question re-poll =====
//
// The hook's useSseBus now drives question state via applyQuestionEvent on
// every question.* event instead of re-polling GET /question (which returns
// ALL cumulatively-pending workspace questions and dropped both the sessionID
// filter and the que_ requestId). These cases lock the properties the live
// path depends on: distinct in-session asks accumulate WITHOUT stacking a
// cross-session backlog, and every stored card carries a usable requestId so
// submit can actually POST the reply (the "stuck on loading" root cause).
describe("applyQuestionEvent — BET-112 live-path stacking/requestId", () => {
  const SID = "ses_view";
  const mkAsked = (id: string, callID: string) => ({
    id,
    sessionID: SID,
    questions: [{ question: "q", header: "h", options: [] }],
    tool: { messageID: `msg_${callID}`, callID },
  });

  it("two distinct in-session asks yield two cards, each with its own requestId", () => {
    let state = applyQuestionEvent([], "question.asked", mkAsked("que_1", "toolu_1"), SID);
    state = applyQuestionEvent(state, "question.asked", mkAsked("que_2", "toolu_2"), SID);
    expect(state).toHaveLength(2);
    expect(state.map((q) => q.id)).toEqual(["toolu_1", "toolu_2"]);
    // Both cards carry the que_ reply token — without this, submit short-circuits
    // ("reply token was not captured") and the spinner hangs forever.
    expect(state.map((q) => q.requestId)).toEqual(["que_1", "que_2"]);
  });

  it("interleaved cross-session asks never stack into the viewed panel", () => {
    let state = applyQuestionEvent([], "question.asked", mkAsked("que_1", "toolu_1"), SID);
    // A question fired in ANOTHER session (workspace-wide GET would have
    // returned it) must not appear in the viewed panel.
    state = applyQuestionEvent(
      state,
      "question.asked",
      { ...mkAsked("que_9", "toolu_9"), sessionID: "ses_other" },
      SID,
    );
    expect(state).toHaveLength(1);
    expect(state[0].id).toBe("toolu_1");
  });

  it("replying one ask leaves the other pending (no backlog re-render)", () => {
    let state = applyQuestionEvent([], "question.asked", mkAsked("que_1", "toolu_1"), SID);
    state = applyQuestionEvent(state, "question.asked", mkAsked("que_2", "toolu_2"), SID);
    state = applyQuestionEvent(state, "question.replied", { requestID: "que_1", sessionID: SID }, SID);
    expect(state).toHaveLength(1);
    expect(state[0].id).toBe("toolu_2");
    expect(state[0].requestId).toBe("que_2");
  });
});

// ===== hydrateQuestion =====

describe("hydrateQuestion", () => {
  it("copies the server's que_ id into requestId so reply has a token", () => {
    const server = {
      id: "que_42",
      sessionID: "ses_a",
      questions: [{ question: "q", header: "h", options: [] }],
    };
    const h = hydrateQuestion(server);
    // requestId is what opencode's /question/:id/reply requires (^que…)
    expect(h.requestId).toBe("que_42");
  });

  it("uses tool.callID as dedup key when present (matches live-event keying)", () => {
    const h = hydrateQuestion({
      id: "que_7",
      sessionID: "ses_a",
      questions: [{ question: "q", header: "h", options: [] }],
      tool: { messageID: "msg_1", callID: "toolu_7" },
    });
    expect(h.id).toBe("toolu_7");
    expect(h.requestId).toBe("que_7");
  });

  it("falls back to que_ as id when no tool info", () => {
    const h = hydrateQuestion({
      id: "que_7",
      sessionID: "ses_a",
      questions: [{ question: "q", header: "h", options: [] }],
    });
    expect(h.id).toBe("que_7");
    expect(h.requestId).toBe("que_7");
  });

  it("preserves sessionID, questions, and tool intact", () => {
    const tool = { messageID: "msg_1", callID: "toolu_7" };
    const questions = [{ question: "q", header: "h", options: [] }];
    const h = hydrateQuestion({ id: "que_x", sessionID: "ses_y", questions, tool });
    expect(h.sessionID).toBe("ses_y");
    expect(h.questions).toBe(questions);
    expect(h.tool).toEqual(tool);
  });
});

// ===== buildQuestionAnswers / canSubmitQuestion =====

describe("buildQuestionAnswers", () => {
  it("sends only selected labels when no custom text", () => {
    const sel = [new Set(["Yes"])];
    expect(buildQuestionAnswers(sel, [""])).toEqual([["Yes"]]);
  });

  it("sends only custom text when nothing selected", () => {
    const sel = [new Set<string>()];
    expect(buildQuestionAnswers(sel, ["only staging"])).toEqual([
      ["only staging"],
    ]);
  });

  it("appends custom text AFTER selected labels when both present", () => {
    const sel = [new Set(["Yes"])];
    expect(buildQuestionAnswers(sel, ["but only staging"])).toEqual([
      ["Yes", "but only staging"],
    ]);
  });

  it("trims custom text and ignores whitespace-only input", () => {
    const sel = [new Set(["A"])];
    expect(buildQuestionAnswers(sel, ["   "])).toEqual([["A"]]);
    expect(buildQuestionAnswers([new Set(["A"])], ["  hi  "])).toEqual([
      ["A", "hi"],
    ]);
  });

  it("handles multiple questions independently", () => {
    const sel = [new Set(["X"]), new Set<string>()];
    expect(buildQuestionAnswers(sel, ["", "freeform"])).toEqual([
      ["X"],
      ["freeform"],
    ]);
  });

  it("preserves multi-select labels then custom", () => {
    const sel = [new Set(["A", "B"])];
    const out = buildQuestionAnswers(sel, ["note"]);
    expect(out[0]).toContain("A");
    expect(out[0]).toContain("B");
    expect(out[0][out[0].length - 1]).toBe("note");
  });

  it("tolerates a missing customValues entry", () => {
    const sel = [new Set(["A"])];
    expect(buildQuestionAnswers(sel, [])).toEqual([["A"]]);
  });
});

describe("canSubmitQuestion", () => {
  it("true when every question has a selection", () => {
    expect(canSubmitQuestion([new Set(["A"]), new Set(["B"])], ["", ""])).toBe(
      true,
    );
  });

  it("true when a question has only custom text", () => {
    expect(canSubmitQuestion([new Set<string>()], ["typed"])).toBe(true);
  });

  it("false when a question has neither selection nor text", () => {
    expect(canSubmitQuestion([new Set(["A"]), new Set<string>()], ["", ""])).toBe(
      false,
    );
  });

  it("treats whitespace-only custom text as empty", () => {
    expect(canSubmitQuestion([new Set<string>()], ["   "])).toBe(false);
  });

  it("empty request (no questions) is trivially submittable", () => {
    expect(canSubmitQuestion([], [])).toBe(true);
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

// ===== isAssistantTurnComplete =====
//
// Regression: SSE UI completion gap. The spinner is cleared only by live
// `session.idle`/`session.status{idle}`/`session.error` events. When the
// scoped event stream drops AFTER the first post-resume frame but BEFORE
// `session.idle` (half-dead dedicated tunnel — "got a first line then
// hangs"), that idle event is missed forever and the UI spins on a turn
// that finished server-side. This helper lets the renderer recompute
// "done" from the authoritative transcript (assistant `time.completed`)
// on refetch and clear the stuck spinner.

describe("isAssistantTurnComplete", () => {
  it("treats empty / nullish transcript as complete (nothing running)", () => {
    expect(isAssistantTurnComplete([])).toBe(true);
    expect(isAssistantTurnComplete(null)).toBe(true);
    expect(isAssistantTurnComplete(undefined)).toBe(true);
  });

  it("is NOT complete when the last message is a user message (turn in flight)", () => {
    // User just sent; assistant hasn't produced a message yet. Spinner
    // must stay up — clearing here would hide an active turn.
    const msgs = [
      { info: { role: "assistant", time: { completed: 1000 } } },
      { info: { role: "user" } },
    ];
    expect(isAssistantTurnComplete(msgs)).toBe(false);
  });

  it("is NOT complete when the last assistant message has no completion stamp", () => {
    // Mid-generation: opencode stamps time.completed only when the turn
    // fully finishes. Absent stamp = still streaming → keep spinner.
    const msgs = [
      { info: { role: "user" } },
      { info: { role: "assistant", time: { created: 1000 } } },
    ];
    expect(isAssistantTurnComplete(msgs)).toBe(false);
  });

  it("is NOT complete when time is entirely absent on the last assistant message", () => {
    const msgs = [{ info: { role: "assistant" } }];
    expect(isAssistantTurnComplete(msgs)).toBe(false);
  });

  it("is complete when the last assistant message carries time.completed", () => {
    // THE missed-session.idle case: the completed response is in the
    // refetched transcript; the helper recovers "done" without the event.
    const msgs = [
      { info: { role: "user" } },
      { info: { role: "assistant", time: { created: 1000, completed: 1234 } } },
    ];
    expect(isAssistantTurnComplete(msgs)).toBe(true);
  });

  it("treats completed:0 as NOT complete (defensive against falsy stamp)", () => {
    const msgs = [{ info: { role: "assistant", time: { completed: 0 } } }];
    expect(isAssistantTurnComplete(msgs)).toBe(false);
  });

  it("only inspects the LAST message (a finished earlier turn does not mask an active one)", () => {
    const msgs = [
      { info: { role: "user" } },
      { info: { role: "assistant", time: { completed: 1000 } } },
      { info: { role: "user" } },
      { info: { role: "assistant", time: { created: 2000 } } }, // in flight
    ];
    expect(isAssistantTurnComplete(msgs)).toBe(false);
  });
});

// ===== Subagent helpers =====

describe("extractSubagentInfo", () => {
  it("returns null for non-tool parts", () => {
    expect(extractSubagentInfo({ type: "text" })).toBeNull();
    expect(extractSubagentInfo({ type: "reasoning" })).toBeNull();
  });

  it("returns null for non-task tool parts", () => {
    expect(extractSubagentInfo({ type: "tool", tool: "bash", state: { status: "running" } })).toBeNull();
    expect(extractSubagentInfo({ type: "tool", tool: "read" })).toBeNull();
  });

  it("returns null when task tool has no metadata.sessionId yet (pre-stamp window)", () => {
    // Brief window between tool-input.started and the first metadata write
    // where the child id isn't available yet — must not throw, must not
    // produce a malformed SubagentInfo with empty id.
    const p = { type: "tool", tool: "task", state: { status: "pending", input: { subagent_type: "explore" } } };
    expect(extractSubagentInfo(p)).toBeNull();
  });

  it("extracts full info from a completed task part (live shape)", () => {
    // Verbatim from opencode wire (curl /session/.../message). Mirror of
    // the actual shape so a wire change here triggers a test failure.
    const p = {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        input: {
          description: "Find skill loading code",
          prompt: "Search the OpenCode codebase…",
          subagent_type: "explore",
        },
        output: "I found that skills load from…",
        title: "Find skill loading code",
        time: { start: 1000, end: 13500 },
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child123",
          model: { modelID: "claude-sonnet-4-6", providerID: "anthropic" },
          truncated: false,
        },
      },
    };
    expect(extractSubagentInfo(p)).toEqual({
      childSessionId: "ses_child123",
      agent: "explore",
      description: "Find skill loading code",
      prompt: "Search the OpenCode codebase…",
      status: "completed",
      title: "Find skill loading code",
      output: "I found that skills load from…",
      truncated: false,
      durationMs: 12500,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });
  });

  it("defaults agent to 'subagent' when subagent_type is missing", () => {
    const p = {
      type: "tool",
      tool: "task",
      state: { status: "running", input: {}, metadata: { sessionId: "ses_x" } },
    };
    expect(extractSubagentInfo(p)?.agent).toBe("subagent");
  });

  it("returns null durationMs when only start is stamped (mid-run)", () => {
    const p = {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { subagent_type: "explore" },
        time: { start: 1000 },
        metadata: { sessionId: "ses_x" },
      },
    };
    expect(extractSubagentInfo(p)?.durationMs).toBeNull();
  });

  it("maps unknown status strings to 'unknown' instead of leaking arbitrary values", () => {
    const p = {
      type: "tool",
      tool: "task",
      state: { status: "weird-future-status", input: {}, metadata: { sessionId: "ses_x" } },
    };
    expect(extractSubagentInfo(p)?.status).toBe("unknown");
  });

  it("truncated defaults to false when metadata.truncated is absent or non-boolean", () => {
    const p = {
      type: "tool",
      tool: "task",
      state: { status: "completed", input: {}, metadata: { sessionId: "ses_x" } },
    };
    expect(extractSubagentInfo(p)?.truncated).toBe(false);
    const p2 = {
      type: "tool",
      tool: "task",
      state: { status: "completed", input: {}, metadata: { sessionId: "ses_x", truncated: "yes" as unknown } },
    };
    expect(extractSubagentInfo(p2)?.truncated).toBe(false);
  });
});

describe("collectChildSessionIds", () => {
  it("returns an empty Set for null / undefined / empty inputs", () => {
    expect(collectChildSessionIds(null).size).toBe(0);
    expect(collectChildSessionIds(undefined).size).toBe(0);
    expect(collectChildSessionIds([]).size).toBe(0);
  });

  it("collects ids from task tool parts across multiple messages", () => {
    const messages = [
      { parts: [{ type: "text", text: "hello" }] },
      {
        parts: [
          { type: "tool", tool: "bash", state: {} }, // not task
          { type: "tool", tool: "task", state: { metadata: { sessionId: "ses_a" } } },
        ],
      },
      {
        parts: [
          { type: "tool", tool: "task", state: { metadata: { sessionId: "ses_b" } } },
          { type: "tool", tool: "task", state: { metadata: { sessionId: "ses_a" } } }, // dup
        ],
      },
    ];
    const ids = collectChildSessionIds(messages);
    expect(ids.size).toBe(2);
    expect(ids.has("ses_a")).toBe(true);
    expect(ids.has("ses_b")).toBe(true);
  });

  it("skips task parts that have no childSessionId yet", () => {
    const messages = [
      { parts: [{ type: "tool", tool: "task", state: { status: "pending" } }] },
    ];
    expect(collectChildSessionIds(messages).size).toBe(0);
  });
});

describe("countRunningSubagents", () => {
  const taskPart = (childId: string, status: string) => ({
    parts: [{ type: "tool", tool: "task", state: { status, metadata: { sessionId: childId } } }],
  });

  it("returns 0 for null/empty transcript", () => {
    expect(countRunningSubagents(null)).toBe(0);
    expect(countRunningSubagents([])).toBe(0);
  });

  it("counts transcript-status running / pending; skips completed / error", () => {
    const messages = [
      taskPart("a", "running"),
      taskPart("b", "completed"),
      taskPart("c", "pending"),
      taskPart("d", "error"),
    ];
    // a (running) + c (pending) = 2
    expect(countRunningSubagents(messages)).toBe(2);
  });

  it("liveStatus 'idle' WINS over transcript 'running' (the staleness case)", () => {
    // Child just sent session.idle but the parent's task-part status snapshot
    // is still "running" because the parent's transcript hasn't been refetched
    // yet. Without this override, the sidebar would over-count.
    const messages = [taskPart("a", "running"), taskPart("b", "running")];
    const live = new Map<string, "running" | "idle">([
      ["a", "idle"],
      ["b", "running"],
    ]);
    expect(countRunningSubagents(messages, live)).toBe(1);
  });

  it("liveStatus 'running' counts even when transcript says completed", () => {
    // Rare but possible during a refetch race: live SSE says running, the
    // refetched task part still shows the previous completed run. Trust live.
    const messages = [taskPart("a", "completed")];
    const live = new Map<string, "running" | "idle">([["a", "running"]]);
    expect(countRunningSubagents(messages, live)).toBe(1);
  });

  it("missing live entry falls back to transcript status", () => {
    const messages = [taskPart("a", "running")];
    expect(countRunningSubagents(messages, new Map())).toBe(1);
  });
});

describe("summarizeChildSession", () => {
  it("returns zeros for null / empty input", () => {
    expect(summarizeChildSession(null)).toEqual({ toolCount: 0, lastToolName: null, tokens: 0 });
    expect(summarizeChildSession([])).toEqual({ toolCount: 0, lastToolName: null, tokens: 0 });
  });

  it("counts tool calls and records the last tool name", () => {
    const messages = [
      {
        parts: [
          { type: "tool", tool: "glob", state: {} },
          { type: "text", text: "thinking" },
          { type: "tool", tool: "read", state: {} },
          { type: "tool", tool: "bash", state: {} },
        ],
      },
    ];
    const s = summarizeChildSession(messages);
    expect(s.toolCount).toBe(3);
    expect(s.lastToolName).toBe("bash");
  });

  it("sums step-finish tokens across the transcript", () => {
    // step-finish parts carry `tokens` at the part root (verified against
    // StepFinishPart in opencode's OpenAPI). SubagentPart declares the
    // field, so no cast is needed.
    const messages = [
      {
        parts: [
          { type: "step-finish", tokens: { input: 500, output: 100 } },
          { type: "tool", tool: "bash", state: {} },
          { type: "step-finish", tokens: { input: 300, output: 50 } },
        ],
      },
    ];
    expect(summarizeChildSession(messages).tokens).toBe(950);
  });

  it("tolerates step-finish parts with missing tokens", () => {
    const messages = [
      { parts: [{ type: "step-finish" }, { type: "step-finish", tokens: {} }] },
    ];
    expect(summarizeChildSession(messages).tokens).toBe(0);
  });
});

// ===== Per-session event filter (subagent allowlist) =====
//
// These exist to lock in the ordering invariant: registration must run
// BEFORE the filter, otherwise a live `session.created` for a brand-new
// subagent child is dropped by its own filter pass (the new child id
// isn't in the allowlist yet — this very event is what would register
// it).

describe("registerChildSessionFromCreated", () => {
  it("registers a child whose parent is the viewed session", () => {
    const ids = new Set<string>();
    const registered = registerChildSessionFromCreated(
      {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_parent" } },
      },
      "ses_parent",
      ids,
    );
    expect(registered).toBe(true);
    expect(ids.has("ses_child")).toBe(true);
  });

  it("ignores session.created for unrelated parents", () => {
    const ids = new Set<string>();
    const registered = registerChildSessionFromCreated(
      {
        type: "session.created",
        properties: { info: { id: "ses_other", parentID: "ses_someone_else" } },
      },
      "ses_parent",
      ids,
    );
    expect(registered).toBe(false);
    expect(ids.size).toBe(0);
  });

  it("ignores non-session.created events", () => {
    const ids = new Set<string>();
    const registered = registerChildSessionFromCreated(
      {
        type: "message.part.delta",
        properties: { info: { id: "ses_child", parentID: "ses_parent" } },
      },
      "ses_parent",
      ids,
    );
    expect(registered).toBe(false);
    expect(ids.size).toBe(0);
  });

  it("is idempotent — re-registering the same child returns false", () => {
    const ids = new Set<string>(["ses_child"]);
    const registered = registerChildSessionFromCreated(
      {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_parent" } },
      },
      "ses_parent",
      ids,
    );
    expect(registered).toBe(false);
    expect(ids.size).toBe(1);
  });

  it("tolerates missing info or missing id", () => {
    const ids = new Set<string>();
    expect(registerChildSessionFromCreated(
      { type: "session.created", properties: {} },
      "ses_parent",
      ids,
    )).toBe(false);
    expect(registerChildSessionFromCreated(
      { type: "session.created", properties: { info: { parentID: "ses_parent" } } },
      "ses_parent",
      ids,
    )).toBe(false);
    expect(ids.size).toBe(0);
  });
});

describe("shouldDropEventForSessionFilter", () => {
  it("passes events for the viewed session", () => {
    expect(shouldDropEventForSessionFilter(
      { type: "message.part.delta", properties: { sessionID: "ses_self" } },
      "ses_self",
      new Set(),
    )).toBe(false);
  });

  it("drops events for a different, non-child session", () => {
    expect(shouldDropEventForSessionFilter(
      { type: "message.part.delta", properties: { sessionID: "ses_other" } },
      "ses_self",
      new Set(),
    )).toBe(true);
  });

  it("passes events for a known child subagent session", () => {
    const children = new Set(["ses_child"]);
    expect(shouldDropEventForSessionFilter(
      { type: "message.part.delta", properties: { sessionID: "ses_child" } },
      "ses_self",
      children,
    )).toBe(false);
  });

  it("passes question.*/permission.* lifecycle events regardless of session", () => {
    // These are self-filtering — their handlers re-filter by sessionID
    // after triggering a refetch, so the early-return guard must not
    // pre-drop them.
    for (const t of [
      "question.asked",
      "question.replied",
      "question.rejected",
      "permission.asked",
      "permission.replied",
      "permission.rejected",
    ]) {
      expect(shouldDropEventForSessionFilter(
        { type: t, properties: { sessionID: "ses_other" } },
        "ses_self",
        new Set(),
      )).toBe(false);
    }
  });

  it("passes events with no sessionID (vcs.branch.updated et al.)", () => {
    expect(shouldDropEventForSessionFilter(
      { type: "vcs.branch.updated", properties: {} },
      "ses_self",
      new Set(),
    )).toBe(false);
    expect(shouldDropEventForSessionFilter(
      { type: "something.global" },
      "ses_self",
      new Set(),
    )).toBe(false);
  });

  // ===== HIGH-severity regression =====
  //
  // The ordering invariant in onOpencodeEvent: registration MUST run
  // before the filter, otherwise a fresh `session.created` for a brand
  // new subagent child gets dropped by the filter (its sessionID is the
  // CHILD's id, which isn't in the allowlist yet — this very event is
  // what would register it). The earlier Phase-1 implementation had the
  // registration block AFTER the filter and silently fell back to the
  // slower transcript-seeding path.
  it("REGRESSION: session.created for a new child passes the filter when registered first", () => {
    const children = new Set<string>();
    const ev = {
      type: "session.created",
      properties: {
        sessionID: "ses_child", // OpenAPI: this is the NEW session's id
        info: { id: "ses_child", parentID: "ses_parent" },
      },
    };
    // Without prior registration, the filter would drop it.
    expect(shouldDropEventForSessionFilter(ev, "ses_parent", children)).toBe(true);
    // Register first — as ChatPanel does. Now the filter passes it.
    registerChildSessionFromCreated(ev, "ses_parent", children);
    expect(shouldDropEventForSessionFilter(ev, "ses_parent", children)).toBe(false);
  });
});

// ===== isAssistantTurnInProgress =====
//
// Regression: a session whose last assistant turn wedged (stuck mid-tool-
// call — opencode never emitted idle) looked IDLE on panel mount because
// the initial load never derived `running` from the transcript. With no
// spinner there was no abort affordance; new prompts queued silently
// behind the dead turn. This helper drives `running` true at mount so the
// abort button appears.

describe("isAssistantTurnInProgress", () => {
  it("is false for empty / nullish transcript (nothing to abort)", () => {
    expect(isAssistantTurnInProgress([])).toBe(false);
    expect(isAssistantTurnInProgress(null)).toBe(false);
    expect(isAssistantTurnInProgress(undefined)).toBe(false);
  });

  it("is true when the last assistant message has no completion stamp (running or wedged)", () => {
    const msgs = [
      { info: { role: "user" } },
      { info: { role: "assistant", time: { created: 1000 } } },
    ];
    expect(isAssistantTurnInProgress(msgs)).toBe(true);
  });

  it("is true when time is entirely absent on the last assistant message", () => {
    expect(isAssistantTurnInProgress([{ info: { role: "assistant" } }])).toBe(
      true,
    );
  });

  it("is false when the last assistant message is completed", () => {
    const msgs = [
      { info: { role: "user" } },
      { info: { role: "assistant", time: { created: 1000, completed: 1234 } } },
    ];
    expect(isAssistantTurnInProgress(msgs)).toBe(false);
  });

  it("is false when the last message is a user message (queued prompt, no turn started)", () => {
    // A trailing user message means opencode has not begun an assistant
    // turn — there is nothing to abort yet.
    const msgs = [
      { info: { role: "assistant", time: { completed: 1000 } } },
      { info: { role: "user" } },
    ];
    expect(isAssistantTurnInProgress(msgs)).toBe(false);
  });

  it("treats completed:0 as in progress (defensive against falsy stamp)", () => {
    expect(
      isAssistantTurnInProgress([
        { info: { role: "assistant", time: { completed: 0 } } },
      ]),
    ).toBe(true);
  });

  it("is the strict inverse of isAssistantTurnComplete for assistant-tailed transcripts", () => {
    const wedged = [{ info: { role: "assistant", time: { created: 1 } } }];
    const done = [{ info: { role: "assistant", time: { completed: 2 } } }];
    expect(isAssistantTurnInProgress(wedged)).toBe(!isAssistantTurnComplete(wedged));
    expect(isAssistantTurnInProgress(done)).toBe(!isAssistantTurnComplete(done));
  });
});

// ===== distFromBottom =====

describe("distFromBottom", () => {
  it("returns 0 when scrolled all the way to the bottom", () => {
    expect(distFromBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(0);
  });

  it("returns the gap between viewport bottom and content bottom", () => {
    expect(distFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })).toBe(300);
  });

  it("clamps negative distances (overscroll) to 0", () => {
    // Some browsers/momentum-scroll briefly report scrollTop + clientHeight > scrollHeight.
    expect(distFromBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 200 })).toBe(0);
  });

  it("returns full distance for an empty/short transcript", () => {
    expect(distFromBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 200 })).toBe(0);
  });
});

// ===== classifyScrollForPin (single symmetric threshold) =====

describe("classifyScrollForPin", () => {
  const metricsAtDist = (dist: number) => ({
    scrollHeight: 2000,
    scrollTop: 2000 - 500 - dist,
    clientHeight: 500,
  });

  it("pins when at the bottom", () => {
    expect(classifyScrollForPin(metricsAtDist(0))).toBe(true);
  });

  it("pins at or within the threshold", () => {
    expect(classifyScrollForPin(metricsAtDist(SCROLL_REPIN_PX))).toBe(true);
    expect(classifyScrollForPin(metricsAtDist(SCROLL_REPIN_PX - 1))).toBe(true);
  });

  it("unpins beyond the threshold", () => {
    expect(classifyScrollForPin(metricsAtDist(SCROLL_REPIN_PX + 1))).toBe(false);
    expect(classifyScrollForPin(metricsAtDist(30))).toBe(false);
    expect(classifyScrollForPin(metricsAtDist(500))).toBe(false);
  });

  it("treats overscroll as pinned (dist clamped to 0)", () => {
    expect(
      classifyScrollForPin({ scrollHeight: 1000, scrollTop: 900, clientHeight: 200 }),
    ).toBe(true);
  });

  it("REGRESSION: a 30px scroll-up un-pins so the next delta does NOT snap", () => {
    // This is the v1 bug (80px symmetric threshold) AND a v3-draft bug
    // (asymmetric hysteresis with dead-zone "no change" return). With a
    // single 8px threshold, any non-trivial scroll-up flips pin to false
    // and the next delta is left alone.
    expect(classifyScrollForPin(metricsAtDist(30))).toBe(false);
  });

  it("REGRESSION: drag-up via scrollbar handle past the threshold un-pins", () => {
    // The v2 bug: previous onScroll handler only RE-pinned, never UN-pinned.
    // Scrollbar-handle drag fires only `scroll` events (no wheel/touch/key),
    // so a drag from `dist=0` to `dist=200` left `pinned == true` and the
    // next streaming delta snapped the viewport back to the tail.
    expect(classifyScrollForPin(metricsAtDist(200))).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(classifyScrollForPin(metricsAtDist(20), 32)).toBe(true);
    expect(classifyScrollForPin(metricsAtDist(33), 32)).toBe(false);
  });
});

// ===== wasAtBottomBeforeCommit (v4 — pre-commit pin derivation) =====

describe("wasAtBottomBeforeCommit", () => {
  it("returns true when previous layout had the user pinned at the bottom", () => {
    // prevScrollHeight=1000, clientHeight=200 → bottom is scrollTop=800.
    // scrollTop is unchanged by appending content, so a still-at-bottom
    // reader has scrollTop=800 even after scrollHeight grows.
    expect(wasAtBottomBeforeCommit(1000, 800, 200)).toBe(true);
  });

  it("returns true within the 8px threshold", () => {
    expect(wasAtBottomBeforeCommit(1000, 800 - SCROLL_REPIN_PX, 200)).toBe(true);
    expect(wasAtBottomBeforeCommit(1000, 800 - SCROLL_REPIN_PX + 1, 200)).toBe(true);
  });

  it("returns false when the user scrolled up past the threshold", () => {
    expect(wasAtBottomBeforeCommit(1000, 800 - SCROLL_REPIN_PX - 1, 200)).toBe(false);
    expect(wasAtBottomBeforeCommit(1000, 500, 200)).toBe(false);
  });

  it("returns true on first commit (prevScrollHeight=0) so initial render pins", () => {
    expect(wasAtBottomBeforeCommit(0, 0, 200)).toBe(true);
  });

  it("REGRESSION (v3 streaming snap-back): if user wheeled up 50px right before a delta lands, the post-commit effect must NOT stick", () => {
    // Sequence:
    //   - Before user input: scrollHeight=1000, scrollTop=800 (at bottom).
    //   - User wheels up 50px. Browser updates scrollTop=750 synchronously.
    //   - Before the browser dispatches the scroll event, a streaming
    //     delta lands and React commits. scrollHeight now = 1100 (delta
    //     added 100px of content). clientHeight unchanged at 200.
    //     scrollTop is preserved by the browser at 750.
    //   - The post-commit layout effect reads (prevScrollHeight=1000,
    //     scrollTop=750, clientHeight=200) → prevDist = 1000 - 750 - 200
    //     = 50 → above threshold → DON'T stick.
    expect(wasAtBottomBeforeCommit(1000, 750, 200)).toBe(false);
  });

  it("REGRESSION (v3 streaming snap-back): if user did NOT scroll, post-commit effect still sticks even though new scrollHeight is larger", () => {
    // Same setup minus the wheel: scrollTop stays at 800 (the pre-commit
    // bottom). New scrollHeight is 1100, but we evaluate against the
    // prevScrollHeight (1000) → prevDist = 0 → stick.
    expect(wasAtBottomBeforeCommit(1000, 800, 200)).toBe(true);
  });

  it("respects custom threshold", () => {
    // prevScrollHeight=1000, clientHeight=200 → bottom=800. scrollTop=775
    // → prevDist=25.
    expect(wasAtBottomBeforeCommit(1000, 775, 200, 32)).toBe(true);
    expect(wasAtBottomBeforeCommit(1000, 760, 200, 32)).toBe(false);
  });
});

describe("shouldAbortForQueuedDrain", () => {
  it("aborts at a step boundary when a prompt is queued and not already draining", () => {
    expect(shouldAbortForQueuedDrain(1, false)).toBe(true);
    expect(shouldAbortForQueuedDrain(3, false)).toBe(true);
  });

  it("does nothing when the queue is empty", () => {
    expect(shouldAbortForQueuedDrain(0, false)).toBe(false);
  });

  it("does not re-fire while a drain-abort is already in flight (re-entrancy guard)", () => {
    // Several session.next.step.ended events can arrive before the abort POST
    // lands; only the first should issue the abort.
    expect(shouldAbortForQueuedDrain(1, true)).toBe(false);
    expect(shouldAbortForQueuedDrain(5, true)).toBe(false);
  });
});

describe("isToolStepBoundary", () => {
  it("is true for a completed tool part (the real mid-turn step boundary)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "completed" } })).toBe(true);
  });

  it("is true for an errored tool part (turn is about to recover/continue)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "error" } })).toBe(true);
  });

  it("is false for a tool part still pending/running (not a boundary yet)", () => {
    expect(isToolStepBoundary({ type: "tool", state: { status: "pending" } })).toBe(false);
    expect(isToolStepBoundary({ type: "tool", state: { status: "running" } })).toBe(false);
  });

  it("is false for non-tool parts (text/reasoning stream mid-step)", () => {
    expect(isToolStepBoundary({ type: "text", state: { status: "completed" } })).toBe(false);
    expect(isToolStepBoundary({ type: "reasoning", state: { status: "completed" } })).toBe(false);
  });

  it("is false for malformed / missing input", () => {
    expect(isToolStepBoundary(null)).toBe(false);
    expect(isToolStepBoundary(undefined)).toBe(false);
    expect(isToolStepBoundary({})).toBe(false);
    expect(isToolStepBoundary({ type: "tool" })).toBe(false);
    expect(isToolStepBoundary("tool")).toBe(false);
  });
});

describe("isDrainAbortError", () => {
  it("swallows the MessageAbortedError produced by our own drain-abort", () => {
    expect(isDrainAbortError("MessageAbortedError", true)).toBe(true);
  });

  it("does NOT swallow a manual abort (draining=false) — that error is real to the user", () => {
    expect(isDrainAbortError("MessageAbortedError", false)).toBe(false);
  });

  it("never swallows other error names even while draining", () => {
    expect(isDrainAbortError("ProviderAuthError", true)).toBe(false);
    expect(isDrainAbortError("ContextOverflowError", true)).toBe(false);
    expect(isDrainAbortError(undefined, true)).toBe(false);
  });
});

describe("shouldAutoRename", () => {
  it("fires on every Nth user turn (1-indexed)", () => {
    expect(shouldAutoRename(5, 5)).toBe(true);
    expect(shouldAutoRename(10, 5)).toBe(true);
    expect(shouldAutoRename(15, 5)).toBe(true);
  });

  it("does not fire on non-multiple turns", () => {
    expect(shouldAutoRename(1, 5)).toBe(false);
    expect(shouldAutoRename(4, 5)).toBe(false);
    expect(shouldAutoRename(6, 5)).toBe(false);
  });

  it("never fires at turn 0", () => {
    expect(shouldAutoRename(0, 5)).toBe(false);
  });

  it("guards against a non-positive cadence", () => {
    expect(shouldAutoRename(5, 0)).toBe(false);
    expect(shouldAutoRename(5, -1)).toBe(false);
  });

  it("defaults to AUTO_RENAME_EVERY_N_TURNS", () => {
    expect(shouldAutoRename(AUTO_RENAME_EVERY_N_TURNS)).toBe(true);
    expect(shouldAutoRename(AUTO_RENAME_EVERY_N_TURNS - 1)).toBe(false);
  });
});

describe("countUserTurns", () => {
  const userMsg = (text: string, extra: Record<string, unknown> = {}) => ({
    info: { role: "user" },
    parts: [{ type: "text", text, ...extra }],
  });
  const asst = (text: string) => ({
    info: { role: "assistant" },
    parts: [{ type: "text", text }],
  });

  it("counts only user messages with real text", () => {
    expect(
      countUserTurns([userMsg("fix bug"), asst("ok"), userMsg("now tests")]),
    ).toBe(2);
  });

  it("ignores synthetic / ignored / empty user parts", () => {
    expect(
      countUserTurns([
        userMsg("real"),
        userMsg("expanded", { synthetic: true }),
        userMsg("dropped", { ignored: true }),
        userMsg("   "),
      ]),
    ).toBe(1);
  });

  it("returns 0 for null", () => {
    expect(countUserTurns(null)).toBe(0);
  });
});

describe("buildTitlePromptInput", () => {
  it("joins user+assistant text labeled by role", () => {
    const out = buildTitlePromptInput([
      { info: { role: "user" }, parts: [{ type: "text", text: "fix login" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ]);
    expect(out).toBe("User: fix login\nAssistant: done");
  });

  it("skips synthetic/ignored/non-text parts", () => {
    const out = buildTitlePromptInput([
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "keep", synthetic: false },
          { type: "text", text: "drop", synthetic: true },
          { type: "tool", text: "nope" } as never,
        ],
      },
    ]);
    expect(out).toBe("User: keep");
  });

  it("keeps the TAIL when truncating (latest work wins)", () => {
    const long = "x".repeat(5000);
    const out = buildTitlePromptInput([
      { info: { role: "user" }, parts: [{ type: "text", text: long }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "RECENT_MARKER" }],
      },
    ]);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.endsWith("RECENT_MARKER")).toBe(true);
  });

  it("returns empty string for null / no text", () => {
    expect(buildTitlePromptInput(null)).toBe("");
    expect(
      buildTitlePromptInput([{ info: { role: "user" }, parts: [] }]),
    ).toBe("");
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("lowercases and keeps at most two words", () => {
    expect(sanitizeGeneratedTitle("JWT Expiry Fix Now")).toBe("jwt expiry");
  });

  it("strips quotes, markdown, and trailing punctuation", () => {
    expect(sanitizeGeneratedTitle('"**Login Bug.**"')).toBe("login bug");
    expect(sanitizeGeneratedTitle("`auth`")).toBe("auth");
    expect(sanitizeGeneratedTitle("“dark mode”")).toBe("dark mode");
  });

  it("drops a Title:/Name: preamble", () => {
    expect(sanitizeGeneratedTitle("Title: refactor store")).toBe(
      "refactor store",
    );
    expect(sanitizeGeneratedTitle("Name - cache fix")).toBe("cache fix");
  });

  it("uses only the first line of a chatty model", () => {
    expect(sanitizeGeneratedTitle("api docs\nHere's why...")).toBe("api docs");
  });

  it("clamps overly long output", () => {
    const out = sanitizeGeneratedTitle("supercalifragilisticexpialidocious");
    expect(out.length).toBeLessThanOrEqual(24);
  });

  it("returns empty for null/blank (caller must skip the rename)", () => {
    expect(sanitizeGeneratedTitle(null)).toBe("");
    expect(sanitizeGeneratedTitle("   ")).toBe("");
    expect(sanitizeGeneratedTitle("***")).toBe("");
  });
});

describe("describeCron", () => {
  it("every-N-minutes", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5 min");
    expect(describeCron("*/15 * * * *")).toBe("every 15 min");
  });
  it("hourly", () => {
    expect(describeCron("0 * * * *")).toBe("hourly");
    expect(describeCron("7 * * * *")).toBe("hourly at :07");
  });
  it("every-N-hours", () => {
    expect(describeCron("0 */2 * * *")).toBe("every 2h");
  });
  it("daily at time", () => {
    expect(describeCron("0 9 * * *")).toBe("daily 9:00");
    expect(describeCron("30 14 * * *")).toBe("daily 14:30");
  });
  it("one-shot daily renders 'once at'", () => {
    expect(describeCron("0 15 * * *", false)).toBe("once at 15:00");
  });
  it("weekdays", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("weekdays 9:00");
  });
  it("specific weekday", () => {
    expect(describeCron("0 9 * * 1")).toBe("Mon 9:00");
    expect(describeCron("0 9 * * 0")).toBe("Sun 9:00");
    expect(describeCron("0 9 * * 7")).toBe("Sun 9:00");
  });
  it("monthly on day", () => {
    expect(describeCron("30 14 15 * *")).toBe("monthly on the 15th at 14:30");
    expect(describeCron("0 0 1 * *")).toBe("monthly on the 1st at 0:00");
  });
  it("falls back to raw for unrecognized / invalid", () => {
    expect(describeCron("30 14 15 3 *")).toBe("30 14 15 3 *"); // specific month → raw
    expect(describeCron("garbage")).toBe("garbage");
    expect(describeCron("")).toBe("(invalid)");
  });
  it("never throws", () => {
    expect(() => describeCron(null as unknown as string)).not.toThrow();
  });
});

describe("nextCronRun", () => {
  // Fixed local reference: Mon 2026-01-05 10:30:00 local.
  const FROM = new Date(2026, 0, 5, 10, 30, 0).getTime();

  it("returns null for invalid expressions", () => {
    expect(nextCronRun("garbage", FROM)).toBeNull();
    expect(nextCronRun("", FROM)).toBeNull();
    expect(nextCronRun("60 0 * * *", FROM)).toBeNull(); // minute out of range
    expect(nextCronRun("0 0 * *", FROM)).toBeNull(); // only 4 fields
  });

  it("every-5-min lands on the next 5-minute boundary after now", () => {
    const next = nextCronRun("*/5 * * * *", FROM)!;
    expect(new Date(next).getMinutes()).toBe(35); // 10:30 → next */5 is 10:35
    expect(next).toBe(new Date(2026, 0, 5, 10, 35, 0).getTime());
  });

  it("daily at a later time today returns today's time", () => {
    const next = nextCronRun("0 14 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 5, 14, 0, 0).getTime());
  });

  it("daily at an earlier time rolls to tomorrow", () => {
    const next = nextCronRun("0 9 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 6, 9, 0, 0).getTime());
  });

  it("weekday cron skips the weekend (FROM is Monday)", () => {
    // Next Tuesday 9:00 from Monday 10:30.
    const next = nextCronRun("0 9 * * 2", FROM)!;
    expect(new Date(next).getDay()).toBe(2);
    expect(next).toBe(new Date(2026, 0, 6, 9, 0, 0).getTime());
  });

  it("does not return the current minute even if it matches", () => {
    // FROM is exactly 10:30; "30 10 * * *" matches now but next must be > now.
    const next = nextCronRun("30 10 * * *", FROM)!;
    expect(next).toBe(new Date(2026, 0, 6, 10, 30, 0).getTime()); // tomorrow
  });
});

describe("describeNextRun", () => {
  const FROM = new Date(2026, 0, 5, 10, 30, 0).getTime();

  it("returns empty for invalid cron", () => {
    expect(describeNextRun("garbage", true, FROM)).toBe("");
  });

  it("uses relative minutes for soon runs", () => {
    expect(describeNextRun("*/5 * * * *", true, FROM)).toBe("in 5m");
  });

  it("uses relative hours within 6h", () => {
    expect(describeNextRun("30 13 * * *", true, FROM)).toBe("in 3h");
  });

  it("uses 'today HH:MM' for same-day runs beyond 6h", () => {
    expect(describeNextRun("0 23 * * *", true, FROM)).toBe("today 23:00");
  });

  it("uses 'tomorrow HH:MM' for next-day runs", () => {
    expect(describeNextRun("0 9 * * *", true, FROM)).toBe("tomorrow 09:00");
  });

  it("never throws on bad input", () => {
    expect(() => describeNextRun(null as unknown as string, true, FROM)).not.toThrow();
  });
});

describe("resolveToolOutput", () => {
  it("returns the final output when status is completed", () => {
    expect(
      resolveToolOutput({ output: "done-line-1\ndone-line-2" }),
    ).toBe("done-line-1\ndone-line-2");
  });

  it("falls back to metadata.output while running (no output field)", () => {
    expect(
      resolveToolOutput({ metadata: { output: "line-1\nline-2\n" } }),
    ).toBe("line-1\nline-2\n");
  });

  it("prefers final output over metadata.output once both exist", () => {
    // On completion opencode sets both; the final string is canonical.
    expect(
      resolveToolOutput({
        output: "final",
        metadata: { output: "partial" },
      }),
    ).toBe("final");
  });

  it("treats an empty-string output as absent and uses metadata.output", () => {
    // Running parts can carry output:"" briefly; don't render a blank body
    // when live progress is available.
    expect(
      resolveToolOutput({ output: "", metadata: { output: "tick-1\n" } }),
    ).toBe("tick-1\n");
  });

  it("returns '' when neither output nor metadata.output is present", () => {
    expect(resolveToolOutput({})).toBe("");
    expect(resolveToolOutput({ metadata: {} })).toBe("");
  });

  it("ignores non-string metadata.output", () => {
    expect(
      resolveToolOutput({ metadata: { output: 42 as unknown as string } }),
    ).toBe("");
  });

  it("never throws on null/undefined state", () => {
    expect(resolveToolOutput(null)).toBe("");
    expect(resolveToolOutput(undefined)).toBe("");
  });
});

// ===== reconcileOptimisticUser =====

describe("reconcileOptimisticUser", () => {
  type Msg = { info: { id: string; role: string; time?: { created?: number } } };

  const userMsg = (id: string, text?: string): Msg => ({
    info: { id, role: "user", time: text ? { created: 1000 } : undefined },
  });
  const assistantMsg = (id: string): Msg => ({
    info: { id, role: "assistant", time: { created: 500 } },
  });

  it("returns prev unchanged when incoming is not a user message", () => {
    const prev: Msg[] = [
      userMsg("optimistic-user-1"),
      assistantMsg("msg_1"),
    ];
    const incoming: Msg = {
      info: { id: "msg_assistant_real", role: "assistant", time: { created: 2000 } },
    };
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("returns prev unchanged when there is no optimistic entry", () => {
    const prev: Msg[] = [assistantMsg("msg_1"), userMsg("msg_user_real")];
    const incoming: Msg = userMsg("msg_user_real_2");
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("drops optimistic-user-* entry when real user message arrives", () => {
    const optimistic = userMsg("optimistic-user-1234");
    const prev: Msg[] = [assistantMsg("msg_0"), optimistic];
    const incoming: Msg = userMsg("msg_real_user");
    const result = reconcileOptimisticUser(prev, incoming);
    expect(result).not.toBe(prev); // new reference
    expect(result).toHaveLength(1);
    expect(result![0].info.id).toBe("msg_0");
  });

  it("drops optimistic entry even when it is not the last message", () => {
    const optimistic = userMsg("optimistic-user-999");
    const prev: Msg[] = [optimistic, assistantMsg("msg_1")];
    const incoming: Msg = userMsg("msg_real_user");
    const result = reconcileOptimisticUser(prev, incoming);
    expect(result).toHaveLength(1);
    expect(result![0].info.id).toBe("msg_1");
  });

  it("handles null/undefined prev gracefully", () => {
    const incoming: Msg = userMsg("msg_real");
    expect(reconcileOptimisticUser(null, incoming)).toBeNull();
    expect(reconcileOptimisticUser(undefined, incoming)).toBeUndefined();
  });

  it("handles empty prev array", () => {
    const incoming: Msg = userMsg("msg_real");
    expect(reconcileOptimisticUser([], incoming)).toEqual([]);
  });

  it("returns prev unchanged when no optimistic entry exists (same reference)", () => {
    const prev: Msg[] = [assistantMsg("msg_0"), userMsg("msg_user_1")];
    const incoming: Msg = userMsg("msg_user_2");
    // No optimistic entries → should return the same reference.
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });

  it("is a no-op for assistant messages even with optimistic entries present", () => {
    const optimistic = userMsg("optimistic-user-1");
    const prev: Msg[] = [optimistic, assistantMsg("msg_0")];
    const incoming: Msg = assistantMsg("msg_real");
    // Assistant incoming → never reconciles, even if optimistic is present.
    expect(reconcileOptimisticUser(prev, incoming)).toBe(prev);
  });
});
