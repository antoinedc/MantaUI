import { describe, expect, it } from "vitest";
import type { AgentChange, TrialCaseResult } from "../shared/types";
import { caseEnded, caseStateLabel, expectLabel, isTemplateConflict, isTemplateUpdate, sizeLine, trialCountLine, trialRows, trialVerdictOf, verdictsFor } from "./agentTrial";

const kase = (name: string, over: Partial<TrialCaseResult> = {}): TrialCaseResult => ({
  name,
  expect: "does",
  state: "done",
  finalAnswer: null,
  tools: [],
  filesChanged: 0,
  refused: [],
  wouldAsk: [],
  durationMs: 1000,
  ...over,
});
const verdict = (c: string, pass = true) => ({ case: c, pass, quote: `quote of ${c}`, note: `note of ${c}` });

describe("trialRows", () => {
  it("keeps the trial's case order and joins each case's verdict", () => {
    const rows = trialRows([kase("a"), kase("b", { expect: "declines", state: "timed-out" })], [verdict("b", false), verdict("a")]);
    expect(rows).toEqual([
      { name: "a", expect: "does", state: "done", verdict: { pass: true, quote: "quote of a", note: "note of a" } },
      { name: "b", expect: "declines", state: "timed-out", verdict: { pass: false, quote: "quote of b", note: "note of b" } },
    ]);
  });
  it("without the trial (gone, or not read yet) shows the verdicts alone; a case without a verdict has none", () => {
    expect(trialRows(null, [verdict("a")])).toEqual([{ name: "a", expect: null, state: null, verdict: { pass: true, quote: "quote of a", note: "note of a" } }]);
    expect(trialRows([kase("a")], undefined)[0].verdict).toBeNull();
    expect(trialRows([kase("a")], [verdict("gone")]).map((r) => r.name)).toEqual(["a", "gone"]);
  });
});

describe("words", () => {
  it("names what a case was expected to do and how it ended", () => {
    expect(expectLabel("does")).toBe("should do it");
    expect(expectLabel("declines")).toBe("should decline");
    expect(caseStateLabel("timed-out")).toBe("Timed out");
    expect(caseStateLabel("aborted")).toBe("Stopped");
    expect(caseEnded("running")).toBe(false);
    expect(caseEnded("queued")).toBe(false);
    expect(caseEnded(null)).toBe(false);
    expect(caseEnded("failed")).toBe(true);
  });
  it("counts the cases, and how many ended while some still run", () => {
    expect(trialCountLine([kase("a")])).toBe("1 case");
    expect(trialCountLine([kase("a"), kase("b")])).toBe("2 cases");
    expect(trialCountLine([kase("a"), kase("b", { state: "running" }), kase("c", { state: "queued" })])).toBe("1 of 3 cases finished");
  });
});

describe("a trial's verdict from the records", () => {
  const rec = (id: string, pass: boolean[]) => ({ trial: { id, verdicts: pass.map((p, i) => verdict(`c${i}`, p)) } });
  it("passed when every verdict passed, failed when one didn't, null when no proposal used it", () => {
    expect(trialVerdictOf({ id: "tr_1" }, [rec("tr_1", [true, true])])).toBe("passed");
    expect(trialVerdictOf({ id: "tr_1" }, [rec("tr_1", [true, false])])).toBe("failed");
    expect(trialVerdictOf({ id: "tr_2" }, [rec("tr_1", [true])])).toBeNull();
    expect(trialVerdictOf({ id: "tr_2" }, null)).toBeNull();
    expect(verdictsFor("tr_1", [{}, rec("tr_1", [true])])).toHaveLength(1);
    expect(verdictsFor("tr_3", [rec("tr_1", [true])])).toEqual([]);
  });
});

describe("sizeLine", () => {
  it("before → after with the difference; a new agent shows its size; an older record says nothing", () => {
    expect(sizeLine({ sizeBefore: 1240, sizeAfter: 980 })).toBe("Instructions: 1,240 → 980 characters (−260)");
    expect(sizeLine({ sizeBefore: 100, sizeAfter: 150 })).toBe("Instructions: 100 → 150 characters (+50)");
    expect(sizeLine({ sizeBefore: 100, sizeAfter: 100 })).toBe("Instructions: 100 → 100 characters (no change)");
    expect(sizeLine({ sizeBefore: null, sizeAfter: 980 })).toBe("Instructions: 980 characters");
    expect(sizeLine({})).toBeNull();
  });
});

describe("built-in updates", () => {
  const base = { origin: { kind: "template-update", templateHash: "h" }, state: "pending", needsClick: true, error: null } as Pick<AgentChange, "origin" | "state" | "needsClick" | "error">;
  it("a template update is a built-in update; it is a conflict while it waits for a click with no write error", () => {
    expect(isTemplateUpdate(base)).toBe(true);
    expect(isTemplateUpdate({ origin: { kind: "chat" } })).toBe(false);
    expect(isTemplateConflict(base)).toBe(true);
    expect(isTemplateConflict({ ...base, error: "disk full" })).toBe(false);
    expect(isTemplateConflict({ ...base, state: "applied", needsClick: false })).toBe(false);
    expect(isTemplateConflict({ ...base, origin: { kind: "chat" } })).toBe(false);
  });
});
