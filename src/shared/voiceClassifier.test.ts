import { describe, it, expect } from "vitest";
import {
  normalizeTranscript,
  classifyByRules,
  coerceLlmAction,
  buildClassifierPrompt,
} from "./voiceClassifier.mjs";

describe("normalizeTranscript", () => {
  it("lowercases and trims", () => {
    expect(normalizeTranscript("  Clear ")).toBe("clear");
  });
  it("strips trailing Whisper punctuation noise", () => {
    expect(normalizeTranscript("Send.")).toBe("send");
    expect(normalizeTranscript("Compact!")).toBe("compact");
    expect(normalizeTranscript('"clear",')).toBe("clear");
  });
  it("collapses internal whitespace runs", () => {
    expect(normalizeTranscript("allow   always")).toBe("allow always");
  });
  it("preserves contractions", () => {
    expect(normalizeTranscript("don't allow")).toBe("don't allow");
  });
  it("returns empty for non-string", () => {
    expect(normalizeTranscript(undefined as unknown as string)).toBe("");
  });
});

describe("classifyByRules — dispatch verbs", () => {
  it("matches /clear variants", () => {
    expect(classifyByRules("clear")).toEqual({ kind: "clear" });
    expect(classifyByRules("Clear the session.")).toEqual({ kind: "clear" });
    expect(classifyByRules("start over")).toEqual({ kind: "clear" });
    expect(classifyByRules("new chat")).toEqual({ kind: "clear" });
  });
  it("matches /compact only as a destination verb (not 'compact the response')", () => {
    expect(classifyByRules("compact")).toEqual({ kind: "compact" });
    expect(classifyByRules("compact this session")).toEqual({ kind: "compact" });
    // Free-form "compact" inside a sentence should NOT auto-fire.
    expect(classifyByRules("can you compact the response")).toBeNull();
  });
  it("matches abort family", () => {
    for (const t of ["abort", "stop", "cancel", "halt", "hold on", "nevermind", "escape", "interrupt"]) {
      expect(classifyByRules(t)).toEqual({ kind: "abort" });
    }
  });
  it("matches fork", () => {
    expect(classifyByRules("fork")).toEqual({ kind: "fork" });
    expect(classifyByRules("fork the session")).toEqual({ kind: "fork" });
  });
  it("matches help / settings / trust toggle", () => {
    expect(classifyByRules("help")).toEqual({ kind: "help" });
    expect(classifyByRules("what can I say")).toEqual({ kind: "help" });
    expect(classifyByRules("settings")).toEqual({ kind: "open-settings" });
    expect(classifyByRules("Open settings")).toEqual({ kind: "open-settings" });
    expect(classifyByRules("toggle trust")).toEqual({ kind: "toggle-trust" });
    expect(classifyByRules("trust mode")).toEqual({ kind: "toggle-trust" });
  });
});

describe("classifyByRules — permissions", () => {
  it("matches allow once / always / reject", () => {
    expect(classifyByRules("allow once")).toEqual({ kind: "allow-once" });
    expect(classifyByRules("just this time")).toEqual({ kind: "allow-once" });
    expect(classifyByRules("allow always")).toEqual({ kind: "allow-always" });
    expect(classifyByRules("always allow")).toEqual({ kind: "allow-always" });
    expect(classifyByRules("reject")).toEqual({ kind: "reject" });
    expect(classifyByRules("deny")).toEqual({ kind: "reject" });
    expect(classifyByRules("don't allow")).toEqual({ kind: "reject" });
  });
});

describe("classifyByRules — question answers", () => {
  it("matches explicit option prefixes", () => {
    expect(classifyByRules("option 2")).toEqual({ kind: "answer", choice: "2" });
    expect(classifyByRules("answer three")).toEqual({ kind: "answer", choice: "3" });
    expect(classifyByRules("pick yes")).toEqual({ kind: "answer", choice: "yes" });
    expect(classifyByRules("choose mango")).toEqual({ kind: "answer", choice: "mango" });
  });
  it("maps bare yes/no/confirm to a yes/no answer", () => {
    expect(classifyByRules("yes")).toEqual({ kind: "answer", choice: "yes" });
    expect(classifyByRules("yeah")).toEqual({ kind: "answer", choice: "yes" });
    expect(classifyByRules("go ahead")).toEqual({ kind: "answer", choice: "yes" });
    expect(classifyByRules("no")).toEqual({ kind: "answer", choice: "no" });
    expect(classifyByRules("nope")).toEqual({ kind: "answer", choice: "no" });
  });
});

describe("classifyByRules — model switch", () => {
  it("captures spoken model name", () => {
    expect(classifyByRules("use opus")).toEqual({ kind: "model", query: "opus" });
    expect(classifyByRules("switch to sonnet 4")).toEqual({ kind: "model", query: "sonnet 4" });
    expect(classifyByRules("change to gpt 5")).toEqual({ kind: "model", query: "gpt 5" });
    expect(classifyByRules("model haiku")).toEqual({ kind: "model", query: "haiku" });
  });
});

describe("classifyByRules — window switch", () => {
  it("matches numeric and worded indices in 1-9", () => {
    expect(classifyByRules("window 3")).toEqual({ kind: "switch-window", index: 3 });
    expect(classifyByRules("session two")).toEqual({ kind: "switch-window", index: 2 });
    expect(classifyByRules("go to window 5")).toEqual({ kind: "switch-window", index: 5 });
    expect(classifyByRules("open tab 9")).toEqual({ kind: "switch-window", index: 9 });
  });
  it("rejects out-of-range indices", () => {
    expect(classifyByRules("window 10")).toBeNull();
    expect(classifyByRules("session 0")).toBeNull();
  });
});

describe("classifyByRules — dictation / submit", () => {
  it("dictation prefix → append (no submit)", () => {
    expect(classifyByRules("type hello world")).toEqual({
      kind: "append",
      text: "hello world",
    });
    expect(classifyByRules("insert a paragraph here")).toEqual({
      kind: "append",
      text: "a paragraph here",
    });
  });
  it("submit prefix → submit with body", () => {
    expect(classifyByRules("send what is the time")).toEqual({
      kind: "submit",
      text: "what is the time",
    });
    expect(classifyByRules("ask claude to refactor this")).toEqual({
      kind: "submit",
      text: "claude to refactor this",
    });
  });
});

describe("classifyByRules — fallthrough", () => {
  it("returns null for free-form prose so the LLM fallback decides", () => {
    expect(classifyByRules("the quick brown fox")).toBeNull();
    expect(classifyByRules("can you explain async iterators")).toBeNull();
    // Sub-word "act" inside "context" must NOT fire compact.
    expect(classifyByRules("explain the context to me")).toBeNull();
  });
});

describe("buildClassifierPrompt", () => {
  it("escapes the transcript with JSON.stringify", () => {
    const { user } = buildClassifierPrompt('say "hi"\nbye');
    expect(user).toBe('Transcript: "say \\"hi\\"\\nbye"');
  });
  it("system prompt lists allowed shapes", () => {
    const { system } = buildClassifierPrompt("");
    expect(system).toContain('{"kind":"submit"');
    expect(system).toContain('{"kind":"unknown"');
  });
});

describe("coerceLlmAction", () => {
  it("accepts well-formed shapes", () => {
    expect(coerceLlmAction({ kind: "submit", text: "hello" })).toEqual({
      kind: "submit",
      text: "hello",
    });
    expect(coerceLlmAction({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(coerceLlmAction({ kind: "answer", choice: "yes" })).toEqual({
      kind: "answer",
      choice: "yes",
    });
    expect(coerceLlmAction({ kind: "switch-window", index: 3 })).toEqual({
      kind: "switch-window",
      index: 3,
    });
    expect(coerceLlmAction({ kind: "model", query: "opus" })).toEqual({
      kind: "model",
      query: "opus",
    });
  });
  it("trims text on submit/append", () => {
    expect(coerceLlmAction({ kind: "submit", text: "  hi  " })).toEqual({
      kind: "submit",
      text: "hi",
    });
  });
  it("rejects malformed shapes", () => {
    expect(coerceLlmAction(null)).toBeNull();
    expect(coerceLlmAction("clear")).toBeNull();
    expect(coerceLlmAction({})).toBeNull();
    expect(coerceLlmAction({ kind: "submit" })).toBeNull(); // missing text
    expect(coerceLlmAction({ kind: "submit", text: "   " })).toBeNull(); // blank text
    expect(coerceLlmAction({ kind: "switch-window", index: 0 })).toBeNull();
    expect(coerceLlmAction({ kind: "switch-window", index: 10 })).toBeNull();
    expect(coerceLlmAction({ kind: "switch-window", index: "3" })).toBeNull();
    expect(coerceLlmAction({ kind: "answer" })).toBeNull();
    expect(coerceLlmAction({ kind: "totally-bogus" })).toBeNull();
  });
  it("unknown carries the transcript through", () => {
    expect(coerceLlmAction({ kind: "unknown", transcript: "foo bar" })).toEqual({
      kind: "unknown",
      transcript: "foo bar",
    });
    expect(coerceLlmAction({ kind: "unknown" })).toEqual({
      kind: "unknown",
      transcript: "",
    });
  });
});
