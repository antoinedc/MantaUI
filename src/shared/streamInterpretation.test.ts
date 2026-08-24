import { describe, it, expect } from "vitest";
// Moved from src/renderer/chatUtils.test.ts alongside the logic (BET-551).
// Tests are unchanged; only the module path differs.
import {
  ASSUMED_CONTEXT_TOKENS,
  AUTO_RENAME_EVERY_N_TURNS,
  STALE_CACHE_MIN_TOKENS,
  VISIBLE_TODOS_CAP,
  allTodosTerminal,
  applyPermissionEvent,
  applyQuestionEvent,
  buildTitlePromptInput,
  classifyCacheAge,
  classifyFinish,
  collectChildSessionIds,
  computeContextBreakdown,
  computeStaleCache,
  countRunningSubagents,
  countUserTurns,
  describeTruncation,
  extractSubagentInfo,
  findFlushBoundary,
  isSafeCut,
  hydrateQuestion,
  isAssistantTurnComplete,
  isAssistantTurnInProgress,
  isSelfFilteringLifecycleEvent,
  isTerminalTodo,
  mergeBufferedDeltas,
  registerChildSessionFromCreated,
  resolveContextLimit,
  sanitizeGeneratedTitle,
  selectActiveTodos,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  selectLatestTokenUsage,
  selectVisibleTodos,
  shouldAutoRename,
  shouldDropEventForSessionFilter,
  summarizeChildSession,
  humanizeProviderError,
  providerErrorStatus,
  enrichProviderError,
} from "./streamInterpretation.mjs";


describe("computeContextBreakdown", () => {
  it("returns all zeros for null/undefined tokens", () => {
    const b = computeContextBreakdown(null, 200_000);
    expect(b.freshInput).toBe(0);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(0);
    expect(b.totalInput).toBe(0);
    expect(b.pct).toBe(0);
    expect(b.hasLimit).toBe(true);
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
    expect(b.hasLimit).toBe(true);
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

  it("signals unknown context (hasLimit false, pct null) when limit is null / non-positive", () => {
    // The token totals are still computed; only the percentage is suppressed.
    const tokens = { input: 100_000, cache: { read: 20_000, write: 0 } };
    for (const limit of [null, 0, -1, Infinity, NaN]) {
      const b = computeContextBreakdown(tokens, limit);
      expect(b.freshInput).toBe(100_000);
      expect(b.cacheRead).toBe(20_000);
      expect(b.cacheWrite).toBe(0);
      expect(b.totalInput).toBe(120_000);
      expect(b.hasLimit).toBe(false);
      expect(b.pct).toBe(null);
      expect(b.segments).toEqual([]);
    }
  });
});

describe("selectLatestTokenUsage", () => {
  const billed = (over = {}) => ({
    info: { role: "assistant", tokens: { input: 100, cache: { read: 0, write: 0 } }, ...over },
  });

  it("returns null for empty, null, and non-array input", () => {
    expect(selectLatestTokenUsage([])).toBeNull();
    expect(selectLatestTokenUsage(null)).toBeNull();
    expect(selectLatestTokenUsage(undefined)).toBeNull();
    expect(selectLatestTokenUsage({})).toBeNull();
  });

  it("returns null for a transcript with only user messages", () => {
    expect(
      selectLatestTokenUsage([{ info: { role: "user", tokens: { input: 50 } } }]),
    ).toBeNull();
  });

  it("skips an assistant message with no tokens", () => {
    const first = billed();
    const messages = [first, { info: { role: "assistant" } }];
    const found = selectLatestTokenUsage(messages);
    if (!found) throw new Error("expected a billed assistant message");
    expect(found.tokens).toBe(first.info.tokens);
  });

  it("skips a zero-billed assistant message and returns an earlier billed one", () => {
    const zero = {
      info: {
        role: "assistant",
        tokens: { input: 0, cache: { read: 0, write: 0 } },
      },
    };
    const earlier = { info: { role: "assistant", tokens: { input: 200 } } };
    const found = selectLatestTokenUsage([earlier, zero]);
    if (!found) throw new Error("expected a billed assistant message");
    expect(found.tokens).toBe(earlier.info.tokens);
  });

  it("returns the newest billed assistant message when several are billed", () => {
    const older = { info: { role: "assistant", tokens: { input: 10 } } };
    const newer = { info: { role: "assistant", tokens: { input: 30 } } };
    const found = selectLatestTokenUsage([older, newer]);
    if (!found) throw new Error("expected a billed assistant message");
    expect(found.tokens).toBe(newer.info.tokens);
  });

  it("counts cache.read alone as billed even when input is zero", () => {
    const read = {
      info: { role: "assistant", tokens: { input: 0, cache: { read: 40, write: 0 } } },
    };
    const found = selectLatestTokenUsage([read]);
    if (!found) throw new Error("expected a billed assistant message");
    expect(found.tokens).toBe(read.info.tokens);
  });

  it("surfaces providerID/modelID from the matching message, null when omitted", () => {
    const withIds = billed({ providerID: "anthropic", modelID: "claude-opus-4-7" });
    const found = selectLatestTokenUsage([withIds]);
    if (!found) throw new Error("expected a billed assistant message");
    expect(found.providerID).toBe("anthropic");
    expect(found.modelID).toBe("claude-opus-4-7");

    const bare = billed();
    const bareFound = selectLatestTokenUsage([bare]);
    if (!bareFound) throw new Error("expected a billed assistant message");
    expect(bareFound.providerID).toBeNull();
    expect(bareFound.modelID).toBeNull();
  });
});

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

  // ===== sentence boundaries (BET-649) =====
  //
  // The change that makes streamed prose arrive rather than appear: a
  // paragraph-only policy withholds a whole paragraph and commits it at once.

  it("flushes at a sentence end followed by a space", () => {
    const buf = "First sentence. Second one is still arriving";
    const idx = findFlushBoundary(buf);
    expect(buf.slice(0, idx)).toBe("First sentence. ");
    expect(buf.slice(idx)).toBe("Second one is still arriving");
  });

  it("takes the LAST sentence end when several have arrived", () => {
    const buf = "One. Two. Three is partial";
    const idx = findFlushBoundary(buf);
    expect(buf.slice(0, idx)).toBe("One. Two. ");
  });

  it("treats ! and ? as sentence ends, and carries a closing quote with them", () => {
    expect(findFlushBoundary("Stop! Now")).toBe("Stop! ".length);
    expect(findFlushBoundary("Really? Yes")).toBe("Really? ".length);
    expect(findFlushBoundary('He said "go." Then left')).toBe('He said "go." '.length);
  });

  it("does NOT flush a trailing '.' with no whitespace after it yet", () => {
    // Could be mid-number ("1.5") or mid-abbreviation — the next delta decides.
    expect(findFlushBoundary("version 1.")).toBe(-1);
    expect(findFlushBoundary("version 1.5 is out")).toBe(-1);
  });

  it("does NOT flush a sentence end inside a code block", () => {
    const buf = "intro\n\n```\nconst x = 1. Done\nmore";
    // Only the paragraph before the fence is flushable.
    expect(findFlushBoundary(buf)).toBe("intro\n\n".length);
  });

  it("does NOT cut inside an inline code span", () => {
    // Splitting here would render "`see the file." as a literal backtick.
    const buf = "run `a.b. c` next";
    expect(findFlushBoundary(buf)).toBe(-1);
  });

  it("does NOT cut inside a link or a bold run", () => {
    expect(findFlushBoundary("see [the docs. here](http://x) next")).toBe(-1);
    expect(findFlushBoundary("**bold. text** after")).toBe(-1);
  });

  it("cuts once the construct closes", () => {
    const buf = "run `a.b` first. Then more";
    const idx = findFlushBoundary(buf);
    expect(buf.slice(0, idx)).toBe("run `a.b` first. ");
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

describe("selectCacheTtlMs", () => {
  // opencode stamps its cache breakpoints `{type:"ephemeral"}` with no ttl,
  // so Anthropic applies its default 5-minute TTL (measured on the wire:
  // usage.cache_creation lands entirely in ephemeral_5m_input_tokens). Since
  // BET-1334 the pill's TTL is MEASURED server-side; `selectCacheTtlMs` is now
  // a pure passthrough with a 5-minute fallback for a missing measurement.
  it("returns the 5-minute default when passed null or undefined", () => {
    expect(selectCacheTtlMs(null)).toBe(5 * 60 * 1000);
    expect(selectCacheTtlMs(undefined)).toBe(5 * 60 * 1000);
  });

  it("passes an explicit measured value through unchanged", () => {
    expect(selectCacheTtlMs(60 * 60 * 1000)).toBe(60 * 60 * 1000);
    expect(selectCacheTtlMs(1_000)).toBe(1_000);
  });

  it("honours 0 (a real measurement) over the fallback", () => {
    expect(selectCacheTtlMs(0)).toBe(0);
  });
});

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

describe("applyPermissionEvent", () => {
  const SID = "ses_view";
  const askedProps = {
    id: "perm_1",
    sessionID: SID,
    prompt: "Allow reading ~/secrets.json?",
  };

  it("permission.asked appends the permission (whole properties object is the record)", () => {
    const next = applyPermissionEvent([], "permission.asked", askedProps, SID);
    expect(next).toHaveLength(1);
    // The stored record is the raw wire payload — the same shape
    // `opencode:permissions` returns, so iOS decodes it with PermissionRequest.
    expect(next[0]).toEqual(askedProps);
  });

  it("permission.replied removes the answered permission", () => {
    const prev = [askedProps];
    expect(
      applyPermissionEvent(prev, "permission.replied", { id: "perm_1", sessionID: SID }, SID),
    ).toEqual([]);
  });

  it("permission.rejected removes the dismissed permission", () => {
    const prev = [askedProps];
    expect(
      applyPermissionEvent(prev, "permission.rejected", { id: "perm_1", sessionID: SID }, SID),
    ).toEqual([]);
  });

  it("permission.asked for a DIFFERENT session is ignored", () => {
    const other = { ...askedProps, id: "perm_2", sessionID: "ses_other" };
    expect(applyPermissionEvent([], "permission.asked", other, SID)).toEqual([]);
  });

  it("re-asking the same id dedupes (no duplicate rows)", () => {
    const first = applyPermissionEvent([], "permission.asked", askedProps, SID);
    const second = applyPermissionEvent(first, "permission.asked", askedProps, SID);
    expect(second).toHaveLength(1);
  });

  it("preserves unrelated pending permissions when one is replied", () => {
    const p2 = { ...askedProps, id: "perm_2" };
    const prev = [askedProps, p2];
    const next = applyPermissionEvent(prev, "permission.replied", { id: "perm_1", sessionID: SID }, SID);
    expect(next).toEqual([p2]);
  });

  it("missing id is a no-op for asked / replied / rejected", () => {
    expect(applyPermissionEvent([], "permission.asked", { sessionID: SID }, SID)).toEqual([]);
    expect(applyPermissionEvent(undefined, "permission.asked", undefined, SID)).toBeUndefined();
    expect(
      applyPermissionEvent([askedProps], "permission.replied", { sessionID: SID }, SID),
    ).toEqual([askedProps]);
    expect(
      applyPermissionEvent([askedProps], "permission.rejected", {}, SID),
    ).toEqual([askedProps]);
  });
});

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
      background: false,
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

  it("background is true when stamped in metadata, false when absent", () => {
    const bg = {
      type: "tool",
      tool: "task",
      state: { status: "running", input: {}, metadata: { sessionId: "ses_x", background: true } },
    };
    expect(extractSubagentInfo(bg)?.background).toBe(true);
    const plain = {
      type: "tool",
      tool: "task",
      state: { status: "running", input: {}, metadata: { sessionId: "ses_x" } },
    };
    expect(extractSubagentInfo(plain)?.background).toBe(false);
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
  it("preserves sentence case (no lowercasing)", () => {
    expect(sanitizeGeneratedTitle("Fix SSE reconnect after sleep")).toBe(
      "Fix SSE reconnect after sleep",
    );
  });

  it("clamps to six words", () => {
    expect(
      sanitizeGeneratedTitle("one two three four five six seven"),
    ).toBe("one two three four five six");
  });

  it("clamps overly long output at a word boundary", () => {
    const out = sanitizeGeneratedTitle(
      "Refactor the enormous authentication middleware pipeline completely",
    );
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith(" ")).toBe(false);
    // Should not cut mid-word.
    expect(out).not.toMatch(/[a-zA-Z]-$/);
  });

  it("strips quotes, markdown, and trailing punctuation", () => {
    expect(sanitizeGeneratedTitle('"**Login Bug.**"')).toBe("Login Bug");
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
    expect(sanitizeGeneratedTitle("Api docs\nHere's why...")).toBe(
      "Api docs",
    );
  });

  it("preserves a contraction's apostrophe — never strips 'I'm' to 'Im' (BET-1100)", () => {
    expect(sanitizeGeneratedTitle("I'm just checking out the manta setup")).toBe(
      "I'm just checking out the manta",
    );
    expect(sanitizeGeneratedTitle("I'm FIXING IT")).toBe("I'm FIXING IT");
  });

  it("returns empty for null/blank (caller must skip the rename)", () => {
    expect(sanitizeGeneratedTitle(null)).toBe("");
    expect(sanitizeGeneratedTitle("   ")).toBe("");
    expect(sanitizeGeneratedTitle("***")).toBe("");
  });
});


// (moved from src/renderer/chatUtils.test.ts)
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

  it("returns null when model is null/undefined (no fabricated default)", () => {
    expect(resolveContextLimit(null)).toBe(null);
    expect(resolveContextLimit(undefined)).toBe(null);
  });

  it("returns null when limit or limit.context is missing", () => {
    expect(resolveContextLimit({})).toBe(null);
    expect(resolveContextLimit({ limit: {} })).toBe(null);
    expect(resolveContextLimit({ limit: { context: null } })).toBe(null);
  });

  it("rejects non-positive, non-finite, and non-numeric values", () => {
    expect(resolveContextLimit({ limit: { context: 0 } })).toBe(null);
    expect(resolveContextLimit({ limit: { context: -1 } })).toBe(null);
    expect(resolveContextLimit({ limit: { context: Infinity } })).toBe(null);
    expect(resolveContextLimit({ limit: { context: NaN } })).toBe(null);
  });
});


describe("isSafeCut", () => {
  it("accepts a prefix that closes every construct it opened", () => {
    expect(isSafeCut("plain text. ")).toBe(true);
    expect(isSafeCut("with `code` in it. ")).toBe(true);
    expect(isSafeCut("**bold** and [link](url). ")).toBe(true);
  });

  it("rejects an unclosed inline code span, link or bold run", () => {
    expect(isSafeCut("open `code. ")).toBe(false);
    expect(isSafeCut("see [text. ")).toBe(false);
    expect(isSafeCut("see [text](http://x. ")).toBe(false);
    expect(isSafeCut("**bold. ")).toBe(false);
  });

  it("ignores underscores — they are constant in paths and identifiers", () => {
    // Counting them would block almost every cut.
    expect(isSafeCut("see src/foo_bar.ts and _baz. ")).toBe(true);
  });
});

describe("humanizeProviderError", () => {
  const screenshot =
    "Bad Request: {\"detail\":\"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.\"}";

  it("unwraps the screenshot case end to end", () => {
    expect(humanizeProviderError(screenshot)).toBe(
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("unwraps the four body shapes WITH a leading reason phrase", () => {
    expect(
      humanizeProviderError(
        `Bad Request: ${JSON.stringify({ detail: "detail sentence" })}`,
      ),
    ).toBe("detail sentence");
    expect(
      humanizeProviderError(
        `Bad Request: ${JSON.stringify({
          error: { message: "openai sentence", type: "invalid_request_error", code: "model_not_found", param: null },
        })}`,
      ),
    ).toBe("openai sentence");
    expect(
      humanizeProviderError(
        `Bad Request: ${JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "anthropic sentence" },
        })}`,
      ),
    ).toBe("anthropic sentence");
    expect(
      humanizeProviderError(
        `Bad Request: ${JSON.stringify({ message: "misc sentence" })}`,
      ),
    ).toBe("misc sentence");
  });

  it("unwraps the four body shapes WITHOUT a leading reason phrase", () => {
    expect(humanizeProviderError(JSON.stringify({ detail: "detail sentence" }))).toBe(
      "detail sentence",
    );
    expect(
      humanizeProviderError(JSON.stringify({ error: { message: "openai sentence" } })),
    ).toBe("openai sentence");
    expect(
      humanizeProviderError(JSON.stringify({ type: "error", error: { type: "x", message: "anthropic sentence" } })),
    ).toBe("anthropic sentence");
    expect(humanizeProviderError(JSON.stringify({ message: "misc sentence" }))).toBe(
      "misc sentence",
    );
  });

  it("drops the reason phrase but keeps the extracted sentence", () => {
    // The extracted sentence already says everything the reason phrase did.
    expect(
      humanizeProviderError(`Bad Request: ${JSON.stringify({ message: "Too many requests, retry later." })}`),
    ).toBe("Too many requests, retry later.");
  });

  it("returns unrecognised input losslessly (fallback)", () => {
    // Plain prose with no JSON.
    expect(humanizeProviderError("The provider is down.")).toBe("The provider is down.");
    // A reason-phrase prefix over non-JSON prose is NOT treated as a body split.
    expect(humanizeProviderError("Bad Request: something happened.")).toBe(
      "Bad Request: something happened.",
    );
    // Malformed JSON.
    expect(humanizeProviderError("{nope")).toBe("{nope");
    // Valid JSON of an unrecognised shape.
    expect(humanizeProviderError(JSON.stringify({ foo: 1 }))).toBe(JSON.stringify({ foo: 1 }));
    // Empty string.
    expect(humanizeProviderError("")).toBe("");
    // A body whose `detail` is an array (FastAPI validation errors).
    expect(
      humanizeProviderError(JSON.stringify({ detail: [{ loc: ["body"], msg: "field required" }] })),
    ).toBe(JSON.stringify({ detail: [{ loc: ["body"], msg: "field required" }] }));
    // A non-string detail.
    expect(humanizeProviderError(JSON.stringify({ detail: 42 }))).toBe(JSON.stringify({ detail: 42 }));
    // Non-object JSON (number/string/array without a recognised shape).
    expect(humanizeProviderError("42")).toBe("42");
    expect(humanizeProviderError(JSON.stringify(["a", "b"]))).toBe(JSON.stringify(["a", "b"]));
  });

  it("favours error.message over a top-level message", () => {
    expect(
      humanizeProviderError(
        JSON.stringify({ error: { message: "nested wins" }, message: "top-level" }),
      ),
    ).toBe("nested wins");
  });

  it("is idempotent (humanize(humanize(x)) === humanize(x))", () => {
    const inputs = [
      screenshot,
      `Bad Request: ${JSON.stringify({ detail: "detail sentence" })}`,
      `Bad Request: ${JSON.stringify({ error: { message: "openai sentence" } })}`,
      "plain prose",
      JSON.stringify({ foo: 1 }),
      "Bad Request: something happened.",
    ];
    for (const raw of inputs) {
      const once = humanizeProviderError(raw);
      expect(humanizeProviderError(once)).toBe(once);
    }
  });

  // BET-1230 pin: the new status reader must NOT move the banner copy. These are
  // the same reason-phrase messages providerErrorStatus maps; the sentence the
  // renderer shows is unchanged from before providerErrorStatus existed.
  it("is unchanged for status-carrying messages (BET-1230 pin)", () => {
    expect(humanizeProviderError('Payment Required: {"detail":"Balance $0"}')).toBe("Balance $0");
    expect(humanizeProviderError('Too Many Requests: {"message":"slow down"}')).toBe("slow down");
    expect(humanizeProviderError('Unauthorized: {"error":{"message":"bad key"}}')).toBe("bad key");
  });
});

describe("providerErrorStatus", () => {
  it("maps the leading HTTP reason phrase to its code", () => {
    expect(providerErrorStatus('Payment Required: {"detail":"Quota exceeded"}')).toBe(402);
    expect(providerErrorStatus('Too Many Requests: {"message":"slow down"}')).toBe(429);
    expect(providerErrorStatus('Unauthorized: {"error":{"message":"bad key"}}')).toBe(401);
    expect(providerErrorStatus('Bad Request: {"message":"nope"}}')).toBe(400);
    expect(providerErrorStatus('Service Unavailable: {"detail":"down"}}')).toBe(503);
    expect(providerErrorStatus('Internal Server Error: {"detail":"boom"}}')).toBe(500);
  });

  it("is case-insensitive on the phrase", () => {
    expect(providerErrorStatus("payment required: {}")).toBe(402);
    expect(providerErrorStatus("TOO MANY REQUESTS: {}")).toBe(429);
  });

  it("returns null when there is no leading reason phrase", () => {
    expect(providerErrorStatus("some provider was unhappy")).toBe(null);
  });

  it("returns null for an unknown phrase — never a guess", () => {
    expect(providerErrorStatus("Coffee Machine is Angry: {}")).toBe(null);
  });

  it("returns null for non-string or empty input", () => {
    expect(providerErrorStatus(null)).toBe(null);
    expect(providerErrorStatus(undefined)).toBe(null);
    expect(providerErrorStatus("")).toBe(null);
    // No ": " separator.
    expect(providerErrorStatus("Payment Required")).toBe(null);
  });
});

describe("enrichProviderError", () => {
  it("attaches httpStatus parsed from the message, preserving name + data", () => {
    const err = {
      name: "ApiError",
      data: { message: 'Payment Required: {"detail":"Balance $0"}' },
    };
    const out = enrichProviderError(err);
    expect(out.httpStatus).toBe(402);
    expect(out.name).toBe("ApiError");
    expect(out.data.message).toBe('Payment Required: {"detail":"Balance $0"}');
    expect(out.retryAfterMs).toBeUndefined();
  });

  it("attaches retryAfterMs when supplied", () => {
    const err = { name: "ApiError", data: { message: "Too Many Requests: {}" } };
    const out = enrichProviderError(err, 30_000);
    expect(out.httpStatus).toBe(429);
    expect(out.retryAfterMs).toBe(30_000);
  });

  it("returns the same reference when nothing is resolvable", () => {
    const err = { name: "ApiError", data: { message: "some provider was unhappy" } };
    expect(enrichProviderError(err)).toBe(err);
  });

  it("is additive — leaves unknown fields intact", () => {
    const err = { name: "ApiError", extra: 1, data: { message: "Bad Request: {}" } };
    const out = enrichProviderError(err);
    expect(out.httpStatus).toBe(400);
    expect(out.extra).toBe(1);
    expect(out.data.message).toBe("Bad Request: {}");
  });
});
