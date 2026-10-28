// @vitest-environment jsdom
// Edges that are awkward to reach through the UI; the user-visible outcomes and
// copy are asserted authoritatively in ChatPanel.delegateApproval.test.tsx.

import { describe, it, expect } from "vitest";
import {
  classifyApprovalReply,
  nextPendingApproval,
  type ApprovalDecisionState,
} from "./delegateApprovalFeedback";

const ap = (id: string, tools = [{ permission: "bash", pattern: "ls" }]) => ({
  id, parentSessionID: "s", name: "n", prompt: "p", tools, createdAt: 1,
});

describe("classifyApprovalReply", () => {
  it.each([
    [{ ok: true }, "done"],
    [{ ok: false }, "unavailable"],
    [undefined, "unconfirmed"],
    [null, "unconfirmed"],
    [{}, "unconfirmed"],
    [{ ok: "yes" }, "unconfirmed"],
    ["ok", "unconfirmed"],
  ])("%j → %s", (reply, want) => {
    expect(classifyApprovalReply(reply)).toBe(want);
  });
});

describe("nextPendingApproval", () => {
  const none = new Map<string, ApprovalDecisionState>();
  it("empty list clears the card", () => {
    expect(nextPendingApproval({ current: ap("a"), polled: [], decisions: none })).toBeNull();
  });
  it("skips an in-flight approval", () => {
    const decisions = new Map<string, ApprovalDecisionState>([["a", { state: "inflight" }]]);
    expect(nextPendingApproval({ current: null, polled: [ap("a")], decisions })).toBeNull();
    expect(nextPendingApproval({ current: null, polled: [ap("a"), ap("b")], decisions })?.id).toBe("b");
  });
  it("a retry snapshot beats the box's tools, as a copy", () => {
    const snap = [{ permission: "edit", pattern: "**" }];
    const decisions = new Map<string, ApprovalDecisionState>([["a", { state: "retry", tools: snap }]]);
    const out = nextPendingApproval({ current: null, polled: [ap("a")], decisions })!;
    expect(out.tools).toEqual(snap);
    expect(out.tools).not.toBe(snap);
  });
  it("keeps the same object for the same id so local card edits survive", () => {
    const current = ap("a");
    expect(nextPendingApproval({ current, polled: [ap("a")], decisions: none })).toBe(current);
  });
});
