// interaction.test.ts — pure permission + question card logic ported from the
// desktop chatUtils/Cards: answer-building, submittability, reply mapping,
// event upsert/clear, and hydration.

import { describe, expect, it } from "vitest";

import {
  applyPermissionEvent,
  applyQuestionEvent,
  buildQuestionAnswers,
  canSubmitQuestion,
  hydratePermission,
  hydrateQuestion,
  permissionReplyValue,
  toggleQuestionOption,
  type PermissionVM,
  type QuestionVM,
} from "../interaction";

// ---- Permission reply mapping ----

describe("permissionReplyValue", () => {
  it("maps each card action to the correct API reply enum", () => {
    expect(permissionReplyValue("once")).toBe("once");
    expect(permissionReplyValue("always")).toBe("always");
    expect(permissionReplyValue("reject")).toBe("reject");
  });
});

describe("hydratePermission", () => {
  it("keys on tool.callID and keeps per_ as requestId; pulls filepath detail", () => {
    const vm = hydratePermission({
      id: "per_1",
      sessionID: "s1",
      permission: "external_directory",
      always: ["/tmp/*"],
      metadata: { filepath: "/tmp/x.txt" },
      tool: { messageID: "m1", callID: "call_9" },
    });
    expect(vm).toEqual({
      id: "call_9",
      requestId: "per_1",
      sessionID: "s1",
      permission: "external_directory",
      detail: "/tmp/x.txt",
      alwaysScope: "/tmp/*",
    });
  });

  it("falls back to per_ id, command detail, and no alwaysScope", () => {
    const vm = hydratePermission({
      id: "per_2",
      sessionID: "s1",
      permission: "bash",
      metadata: { command: "rm -rf /" },
    });
    expect(vm?.id).toBe("per_2");
    expect(vm?.requestId).toBe("per_2");
    expect(vm?.detail).toBe("rm -rf /");
    expect(vm?.alwaysScope).toBeUndefined();
  });

  it("returns null when there is no id", () => {
    expect(hydratePermission({ sessionID: "s1", permission: "bash" })).toBeNull();
  });
});

describe("applyPermissionEvent", () => {
  const base: PermissionVM[] = [];

  it("upserts on permission.asked for the viewed session", () => {
    const next = applyPermissionEvent(
      base,
      "permission.asked",
      { id: "per_1", sessionID: "s1", permission: "bash", metadata: {} },
      "s1",
    );
    expect(next).toHaveLength(1);
    expect(next[0].requestId).toBe("per_1");
  });

  it("ignores permission.asked for a different session", () => {
    const next = applyPermissionEvent(
      base,
      "permission.asked",
      { id: "per_1", sessionID: "other", permission: "bash" },
      "s1",
    );
    expect(next).toBe(base);
  });

  it("dedupes a re-ask by id", () => {
    const one = applyPermissionEvent(
      base,
      "permission.asked",
      { id: "per_1", sessionID: "s1", permission: "bash", tool: { callID: "c1" } },
      "s1",
    );
    const two = applyPermissionEvent(
      one,
      "permission.asked",
      { id: "per_1", sessionID: "s1", permission: "bash", tool: { callID: "c1" } },
      "s1",
    );
    expect(two).toHaveLength(1);
  });

  it("clears on permission.replied matching id or requestId", () => {
    const seeded: PermissionVM[] = [
      { id: "c1", requestId: "per_1", sessionID: "s1", permission: "bash" },
    ];
    expect(applyPermissionEvent(seeded, "permission.replied", { id: "per_1" }, "s1")).toHaveLength(0);
    expect(
      applyPermissionEvent(seeded, "permission.rejected", { tool: { callID: "c1" } }, "s1"),
    ).toHaveLength(0);
  });

  it("returns same reference when a clear matches nothing", () => {
    const seeded: PermissionVM[] = [
      { id: "c1", requestId: "per_1", sessionID: "s1", permission: "bash" },
    ];
    expect(applyPermissionEvent(seeded, "permission.replied", { id: "nope" }, "s1")).toBe(seeded);
  });
});

// ---- Question hydration + events ----

describe("hydrateQuestion", () => {
  it("keys on callID, keeps que_ as requestId, normalizes options + multiple", () => {
    const vm = hydrateQuestion({
      id: "que_1",
      sessionID: "s1",
      tool: { messageID: "m1", callID: "c1" },
      questions: [
        {
          header: "H",
          question: "Q?",
          multiple: true,
          options: [
            { label: "a", description: "A" },
            { label: "b" },
            { bogus: true },
          ],
        },
      ],
    });
    expect(vm?.id).toBe("c1");
    expect(vm?.requestId).toBe("que_1");
    expect(vm?.questions[0].multiple).toBe(true);
    expect(vm?.questions[0].options).toEqual([
      { label: "a", description: "A" },
      { label: "b", description: undefined },
    ]);
  });

  it("returns null with no id or no questions", () => {
    expect(hydrateQuestion({ sessionID: "s1", questions: [{ header: "h" }] })).toBeNull();
    expect(hydrateQuestion({ id: "que_1", sessionID: "s1", questions: [] })).toBeNull();
  });
});

describe("applyQuestionEvent", () => {
  it("upserts asked for the viewed session, clears on replied/rejected", () => {
    const asked = applyQuestionEvent(
      [],
      "question.asked",
      {
        id: "que_1",
        sessionID: "s1",
        tool: { callID: "c1", messageID: "m1" },
        questions: [{ header: "h", question: "q", options: [{ label: "x" }] }],
      },
      "s1",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0].id).toBe("c1");

    const cleared = applyQuestionEvent(asked, "question.replied", { id: "que_1" }, "s1");
    expect(cleared).toHaveLength(0);
  });

  it("ignores asked for another session", () => {
    const next = applyQuestionEvent(
      [],
      "question.asked",
      { id: "que_1", sessionID: "other", questions: [{ header: "h", question: "q", options: [] }] },
      "s1",
    );
    expect(next).toHaveLength(0);
  });
});

// ---- Answer building + submittability (ported contract) ----

describe("buildQuestionAnswers", () => {
  it("option-only", () => {
    expect(buildQuestionAnswers([new Set(["a"])], [""])).toEqual([["a"]]);
  });

  it("typed-only", () => {
    expect(buildQuestionAnswers([new Set()], ["hello"])).toEqual([["hello"]]);
  });

  it("option + typed (typed appended after labels)", () => {
    expect(buildQuestionAnswers([new Set(["a"])], ["extra"])).toEqual([["a", "extra"]]);
  });

  it("multi-select preserves multiple labels", () => {
    expect(buildQuestionAnswers([new Set(["a", "b"])], [""])).toEqual([["a", "b"]]);
  });

  it("trims typed text and drops a blank custom field", () => {
    expect(buildQuestionAnswers([new Set(["a"])], ["  "])).toEqual([["a"]]);
    expect(buildQuestionAnswers([new Set()], ["  typed  "])).toEqual([["typed"]]);
  });

  it("handles multiple questions independently", () => {
    expect(
      buildQuestionAnswers([new Set(["a"]), new Set()], ["", "typed"]),
    ).toEqual([["a"], ["typed"]]);
  });
});

describe("canSubmitQuestion", () => {
  it("true when each question has a selection OR typed text", () => {
    expect(canSubmitQuestion([new Set(["a"])], [""])).toBe(true);
    expect(canSubmitQuestion([new Set()], ["typed"])).toBe(true);
    expect(canSubmitQuestion([new Set(["a"]), new Set()], ["", "t"])).toBe(true);
  });

  it("false when any question is unanswered (no selection, empty/whitespace text)", () => {
    expect(canSubmitQuestion([new Set()], [""])).toBe(false);
    expect(canSubmitQuestion([new Set()], ["   "])).toBe(false);
    expect(canSubmitQuestion([new Set(["a"]), new Set()], ["", ""])).toBe(false);
  });
});

describe("toggleQuestionOption", () => {
  it("single-select replaces the selection", () => {
    const s0 = [new Set<string>()];
    const s1 = toggleQuestionOption(s0, 0, "a", false);
    expect(Array.from(s1[0])).toEqual(["a"]);
    const s2 = toggleQuestionOption(s1, 0, "b", false);
    expect(Array.from(s2[0])).toEqual(["b"]);
  });

  it("multi-select toggles membership", () => {
    let s = [new Set<string>()];
    s = toggleQuestionOption(s, 0, "a", true);
    s = toggleQuestionOption(s, 0, "b", true);
    expect(Array.from(s[0]).sort()).toEqual(["a", "b"]);
    s = toggleQuestionOption(s, 0, "a", true);
    expect(Array.from(s[0])).toEqual(["b"]);
  });

  it("never mutates the input array/sets", () => {
    const s0 = [new Set<string>(["x"])];
    const s1 = toggleQuestionOption(s0, 0, "y", true);
    expect(Array.from(s0[0])).toEqual(["x"]); // unchanged
    expect(s1).not.toBe(s0);
    expect(s1[0]).not.toBe(s0[0]);
  });

  it("out-of-range index is a no-op clone", () => {
    const s0 = [new Set<string>(["x"])];
    const s1 = toggleQuestionOption(s0, 5, "y", true);
    expect(Array.from(s1[0])).toEqual(["x"]);
  });
});

// Type-only touch so unused QuestionVM import is intentional.
const _typecheck: QuestionVM | undefined = undefined;
void _typecheck;
