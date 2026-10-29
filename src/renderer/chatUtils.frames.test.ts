// Pure helpers that map the box-interpreted stream frames onto renderer state
// (OpenCode V2 slice A2). The hook-level behaviour is covered in
// hooks/useSseBusFrames.test.tsx; this file pins the pieces that carry logic.

import { describe, expect, it } from "vitest";
import { createSidebarFrameHandler, stepTokensFromFrame } from "./chatUtils";
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

describe("createSidebarFrameHandler", () => {
  const frame = (sub: string, sessionId: string, payload: unknown): StreamEnvelope =>
    ({ sub, sessionId, payload }) as StreamEnvelope;

  const make = () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const handle = createSidebarFrameHandler({
      setChatRunning: (...a) => calls.push(["running", ...a]),
      setChatAttention: (...a) => calls.push(["attention", ...a]),
      setWindowStatus: (...a) => calls.push(["windowStatus", ...a]),
    });
    return { h: { handle }, calls };
  };

  it("running frames drive the rail dot, for any session", () => {
    const { h, calls } = make();
    h.handle(frame("running", "ses_a", { running: true, type: "busy" }));
    h.handle(frame("running", "ses_b", { running: false, type: "idle" }));
    expect(calls).toEqual([["running", "ses_a", true], ["running", "ses_b", false]]);
  });

  it("a user Stop (aborted frame) stops the dot", () => {
    const { h, calls } = make();
    h.handle(frame("aborted", "ses_a", {}));
    expect(calls).toEqual([["running", "ses_a", false]]);
  });

  it("a session error stops the dot; turnComplete does NOT (it fires mid-turn)", () => {
    const { h, calls } = make();
    h.handle(frame("turnComplete", "ses_a", { complete: true, running: false }));
    expect(calls).toEqual([]);
    h.handle(frame("sessionError", "ses_a", { name: "ApiError", message: "x" }));
    expect(calls).toEqual([["running", "ses_a", false]]);
  });

  it("windowStatus frames carry the box's rollup into the store", () => {
    const { h, calls } = make();
    const payload = { running: false, busy: true, startedAt: null, attention: null, subagents: 1, stopped: false };
    h.handle(frame("windowStatus", "ses_parent", payload));
    h.handle(frame("windowStatus", "", payload));
    expect(calls).toEqual([["windowStatus", "ses_parent", payload]]);
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
