import { describe, expect, it } from "vitest";
import type { StoppedRecord } from "../shared/types";
import { reconcileResumeSelection, shouldShowStoppedMarker, unarmedStoppedCount } from "./usageResume";

const rec = (partial: Partial<StoppedRecord> = {}): StoppedRecord => ({
  workspace: "manta",
  conversation: "ses_a",
  provider: "claude",
  model: "claude-sonnet-4-6",
  window: "weekly",
  stoppedAt: 1000,
  cachedTokens: 50000,
  armed: false,
  attempts: 1,
  ...partial,
});

describe("unarmedStoppedCount", () => {
  it("counts only conversations still waiting on a decision", () => {
    expect(unarmedStoppedCount([])).toBe(0);
    expect(unarmedStoppedCount([rec(), rec({ conversation: "b", armed: true }), rec({ conversation: "c" })])).toBe(2);
  });
});

describe("shouldShowStoppedMarker", () => {
  it("a pending question or permission outranks the stopped marker", () => {
    expect(shouldShowStoppedMarker(true, false)).toBe(true);
    expect(shouldShowStoppedMarker(true, true)).toBe(false);
    expect(shouldShowStoppedMarker(false, false)).toBe(false);
  });
});

describe("reconcileResumeSelection", () => {
  const set = (...ids: string[]) => new Set(ids);

  it("pristine → the armed rows (the default selection on open)", () => {
    expect([...reconcileResumeSelection({ selected: set("x"), pristine: true, viewIds: set("a", "b"), armedIds: set("a") })]).toEqual(["a"]);
  });

  it("after the user touched anything: vanished rows leave, the user's other choices stay, new rows are not auto-selected", () => {
    const next = reconcileResumeSelection({ selected: set("a", "gone", "c"), pristine: false, viewIds: set("a", "c", "new"), armedIds: set("a", "new") });
    expect([...next].sort()).toEqual(["a", "c"]);
  });

  it("an emptied selection stays empty (unchecking everything is a choice)", () => {
    expect(reconcileResumeSelection({ selected: set(), pristine: false, viewIds: set("a"), armedIds: set("a") }).size).toBe(0);
  });
});
