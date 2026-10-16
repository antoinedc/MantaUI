// Pure helpers that map the box-interpreted stream frames onto renderer state
// (OpenCode V2 slice A2). The hook-level behaviour is covered in
// hooks/useSseBusFrames.test.tsx; this file pins the pieces that carry logic.

import { describe, expect, it } from "vitest";
import { createSidebarFrameHandler, describeSessionError, stepTokensFromFrame } from "./chatUtils";
import type { StreamEnvelope } from "../shared/types";

describe("stepTokensFromFrame", () => {
  it("maps tokens + cost into the live stepTokens snapshot", () => {
    expect(
      stepTokensFromFrame({
        tokens: { input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 } },
        cost: 0.5,
      }),
    ).toEqual({ input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 }, cost: 0.5 });
  });

  it("defaults a missing cost to 0 (the raw handler did the same)", () => {
    expect(stepTokensFromFrame({ tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })?.cost).toBe(0);
  });

  it("returns null for an all-zero frame — a step.ended with no usage must not blank the context pill", () => {
    expect(stepTokensFromFrame({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })).toBeNull();
    expect(stepTokensFromFrame({})).toBeNull();
  });
});

describe("describeSessionError", () => {
  it("auth failures on a subscription provider become the single reconnect nudge", () => {
    const d = describeSessionError({ name: "ProviderAuthError", message: "x" }, "anthropic");
    expect(d.message).toMatch(/needs to be reconnected\.$/);
    expect(d.auth?.providerID).toBe("anthropic");
    expect(d.aborted).toBe(false);
  });

  it("classifies against the RAW provider message when the box humanized it (BET-1131)", () => {
    // Humanized: "Your session is no longer valid" matches none of the auth keywords;
    // the original body names `authentication_error`.
    const humanized = "Your session is no longer valid";
    const raw = `Unauthorized: {"error":{"type":"authentication_error","message":"${humanized}"}}`;
    expect(describeSessionError({ name: "ApiError", message: humanized }, "anthropic").auth).toBeNull();
    expect(describeSessionError({ name: "ApiError", message: humanized, rawMessage: raw }, "anthropic").auth).not.toBeNull();
  });

  it("no provider → no auth banner, falls through to the typed message", () => {
    const d = describeSessionError({ name: "ApiError", message: "invalid api key" }, null);
    expect(d.auth).toBeNull();
    expect(d.message).toBe("API error: invalid api key");
  });

  it("typed prefixes", () => {
    expect(describeSessionError({ name: "ContextOverflowError", message: "too big" }, "x").message).toBe("Context full — try /compact: too big");
    expect(describeSessionError({ name: "MessageOutputLengthError", message: "ignored" }, "x").message).toBe("Response truncated (hit output limit)");
    expect(describeSessionError({ name: "StructuredOutputError", message: "bad" }, "x").message).toBe("Structured output failed: bad");
    expect(describeSessionError({ name: "Whatever", message: "plain" }, "x").message).toBe("plain");
    expect(describeSessionError({ name: null, message: "plain" }, "x").message).toBe("plain");
  });

  it("flags an abort so a later busy/retry can clear the banner", () => {
    expect(describeSessionError({ name: "MessageAbortedError", message: "Aborted" }, "x").aborted).toBe(true);
    expect(describeSessionError({ name: "ApiError", message: "boom" }, "x").aborted).toBe(false);
  });
});

describe("createSidebarFrameHandler", () => {
  const frame = (sub: string, sessionId: string, payload: unknown): StreamEnvelope =>
    ({ sub, sessionId, payload }) as StreamEnvelope;

  const make = () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const handle = createSidebarFrameHandler({
      setChatRunning: (...a) => calls.push(["running", ...a]),
      setChatAttention: (...a) => calls.push(["attention", ...a]),
      setSessionParent: (...a) => calls.push(["parent", ...a]),
    });
    return { h: { handle }, calls };
  };

  it("running frames drive the rail dot, for any session", () => {
    const { h, calls } = make();
    h.handle(frame("running", "ses_a", { running: true, type: "busy" }));
    h.handle(frame("running", "ses_b", { running: false, type: "idle" }));
    expect(calls).toEqual([["running", "ses_a", true], ["running", "ses_b", false]]);
  });

  it("a session error stops the dot; turnComplete does NOT (it fires mid-turn)", () => {
    const { h, calls } = make();
    h.handle(frame("turnComplete", "ses_a", { complete: true, running: false }));
    expect(calls).toEqual([]);
    h.handle(frame("sessionError", "ses_a", { name: "ApiError", message: "x" }));
    expect(calls).toEqual([["running", "ses_a", false]]);
  });

  it("childSession (published under the parent) links child → parent", () => {
    const { h, calls } = make();
    h.handle(frame("childSession", "ses_parent", { childSessionId: "ses_child", parentSessionId: "ses_parent" }));
    expect(calls).toEqual([["parent", "ses_child", "ses_parent"]]);
  });

  it("attention latches question/permission and clears with null", () => {
    const { h, calls } = make();
    h.handle(frame("attention", "ses_a", { kind: "question" }));
    h.handle(frame("attention", "ses_a", { kind: "permission" }));
    h.handle(frame("attention", "ses_a", { kind: null }));
    expect(calls).toEqual([["attention", "ses_a", "question"], ["attention", "ses_a", "permission"], ["attention", "ses_a", null]]);
  });

  it("ignores frames with no session id and unrelated subs", () => {
    const { h, calls } = make();
    h.handle(frame("running", "", { running: true }));
    h.handle(frame("flush", "ses_a", { text: "x" }));
    expect(calls).toEqual([]);
  });
});
