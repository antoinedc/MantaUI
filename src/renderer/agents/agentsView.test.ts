// Pure logic of the agent screens' pages (agent screens spec §2.1, §2.2, §5.2).

import { describe, expect, it } from "vitest";
import type { AgentChange, AgentProfile, FleetCell, NeedsYouReview } from "../../shared/types";
import {
  appliedHistory,
  canRestore,
  historyHow,
  type ProfileTab,
  cellView,
  currentSnapshot,
  errText,
  factsLine,
  firstLine,
  historyStatus,
  historyWho,
  latestLiveId,
  isUnknownChannel,
  memoryLabel,
  nextTab,
  profileTabs,
  researchHealth,
  reviewPart,
  seatFolder,
  seatNotesLabel,
} from "./agentsView";

const change = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "c1",
  kind: "update",
  slug: "seo",
  agentName: "SEO",
  sessionID: "ses",
  messageID: "m",
  callID: "c",
  state: "applied",
  needsClick: false,
  reason: null,
  before: "BEFORE",
  after: "AFTER",
  createdAt: 100,
  decidedAt: 200,
  error: null,
  origin: { kind: "chat" },
  mode: null,
  releasedAt: 100,
  decidedBy: "auto",
  summary: null,
  evidence: [],
  admission: [],
  ...over,
});

describe("isUnknownChannel / errText", () => {
  it("recognises the sentence an older box answers for a channel it doesn't have", () => {
    expect(isUnknownChannel(new Error("unknown rpc channel: agents:fleet"))).toBe(true);
    expect(isUnknownChannel(new Error("HTTP 500"))).toBe(false);
    expect(isUnknownChannel("nope")).toBe(false);
  });
  it("errText gives the message, else a fallback", () => {
    expect(errText(new Error(" boom "), "x")).toBe("boom");
    expect(errText(undefined, "Something went wrong.")).toBe("Something went wrong.");
  });
});

describe("cellView", () => {
  const cell = (over: Partial<FleetCell> = {}): FleetCell => ({ jobId: "j1", title: "Weekly audit", at: 1, state: "done", detail: "11 issues", ...over });
  it("no seat reads as a dash", () => {
    expect(cellView(null)).toEqual({ kind: "none" });
  });
  it("each state has a label, a dot tone and the box's own detail", () => {
    expect(cellView(cell({ state: "working", detail: "4/7 · 1 question" }))).toMatchObject({ kind: "cell", title: "Weekly audit", line: "Working · 4/7 · 1 question", tone: "running", openable: true });
    expect(cellView(cell({ state: "needs-you", detail: "" }))).toMatchObject({ line: "Needs you", tone: "warn" });
    expect(cellView(cell({ state: "done" }))).toMatchObject({ line: "Done · 11 issues", tone: "ok" });
    expect(cellView(cell({ state: "failed", detail: "Gmail token" }))).toMatchObject({ line: "Failed · Gmail token", tone: "error" });
  });
  it("an idle cell has no task to open", () => {
    expect(cellView(cell({ state: "idle", jobId: "", title: "Idle", detail: "last task 3d ago" }))).toMatchObject({ line: "last task 3d ago", tone: "idle", openable: false });
    expect(cellView(cell({ state: "idle", detail: "" }))).toMatchObject({ line: "Idle", openable: false });
  });
});

describe("reviewPart", () => {
  const r: NeedsYouReview = { jobId: "job9", agentSlug: "dev", project: "manta", name: "Fix the crash", finishedAt: 5, filesChanged: 3, branch: "agent/dev/x", resultText: "Fixed it.", reason: "Branch ready to merge · 3 files" };
  it("builds the finished-card part from the review item, with no chat to open a panel in", () => {
    const p = reviewPart(r);
    expect(p).toMatchObject({ type: "background-result", jobId: "job9", state: "done", name: "Fix the crash", agent: "agent-dev", text: "Fixed it." });
    expect(p.sessionID).toBeUndefined();
    expect(p.childSessionId).toBe("job9");
    expect(p.endedBlocked).toBeUndefined();
  });
  it("carries the decision case onto the card, so it reads 'Needs a decision'", () => {
    expect(reviewPart({ ...r, reason: "Needs a decision", endedBlocked: true }).endedBlocked).toBe(true);
  });
});

describe("tabs", () => {
  const ids = (p: object) => profileTabs(p).map((t) => t.id);
  it("lists Overview, Skills, Seats, Learned, History, Research, Settings — in that order", () => {
    expect(ids({ learned: [] })).toEqual(["overview", "skills", "seats", "learned", "history", "research", "settings"]);
  });
  it("Learned only when the box sends the agent's rules (even none) and never for the lead; the Architect has no Seats", () => {
    expect(ids({})).toEqual(["overview", "skills", "seats", "history", "research", "settings"]);
    expect(ids({ learned: [], info: { role: "lead" } })).toEqual(["overview", "skills", "seats", "history", "research", "settings"]);
    expect(ids({ learned: [], info: { role: "architect" } })).toEqual(["overview", "skills", "learned", "history", "research", "settings"]);
    expect(ids({ info: { role: "specialist" } })).toEqual(["overview", "skills", "seats", "history", "research", "settings"]);
  });
  it("there is no Tests tab: the trial runs are part of History", () => {
    expect(ids({ learned: [], trials: [{}] })).not.toContain("tests");
  });
  it("arrows move with wrap, Home and End jump, anything else is not a tab key", () => {
    const all = ids({ learned: [] }) as ProfileTab[];
    expect(nextTab("overview", "ArrowRight", all)).toBe("skills");
    expect(nextTab("settings", "ArrowRight", all)).toBe("overview");
    expect(nextTab("overview", "ArrowLeft", all)).toBe("settings");
    expect(nextTab("seats", "Home", all)).toBe("overview");
    expect(nextTab("seats", "End", all)).toBe("settings");
    expect(nextTab("seats", "Enter", all)).toBeNull();
  });
});

describe("factsLine / firstLine", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile =>
    ({
      info: { slug: "seo", name: "SEO", description: "d", isolation: "none", model: "anthropic/sonnet", color: null, builtIn: false, role: "specialist", useWhen: null, notFor: null, notice: null },
      seats: [{}, {}],
      lastChangedAt: Date.UTC(2026, 10, 12, 12),
      builtBy: "architect",
      refresh: { enabled: true, routineId: null },
      research: [],
      ...over,
    }) as AgentProfile;
  it("the facts line is who it is and how it works: @slug, role, what it does to code, its model", () => {
    expect(factsLine(profile())).toEqual(["@seo", "Specialist", "Read-only", "anthropic/sonnet"]);
    const edits = profile();
    edits.info = { ...edits.info, isolation: "worktree", model: null };
    expect(factsLine(edits)).toEqual(["@seo", "Specialist", "Edits code", "Auto"]);
  });
  it("Manta and the Architect work in every project", () => {
    const lead = profile();
    lead.info = { ...lead.info, slug: "manta", role: "lead", isolation: "worktree" };
    expect(factsLine(lead)).toEqual(["@manta", "Lead", "Edits code", "anthropic/sonnet", "Works in every project"]);
    const arch = profile();
    arch.info = { ...arch.info, slug: "architect", role: "architect" };
    expect(factsLine(arch).at(-1)).toBe("Works in every project");
  });
  it("firstLine takes the first non-empty line", () => {
    expect(firstLine("\n\n  Hello there  \nsecond")).toBe("Hello there");
    expect(firstLine("")).toBe("");
  });
});

describe("history rows", () => {
  it("who: Manta for you (chat), Architect (job), You (restore)", () => {
    expect(historyWho(change({ origin: { kind: "chat" } }))).toBe("Manta · for you");
    expect(historyWho(change({ origin: { kind: "learned" } }))).toBe("Manta · learned from you");
    expect(historyWho(change({ origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 } }))).toBe("Architect");
    expect(historyWho(change({ origin: { kind: "restore", fromChangeId: "x" } }))).toBe("You");
    expect(historyWho(change({ origin: { kind: "settings", field: "name" } }))).toBe("You · in Settings");
  });
  it("History lists only applied changes, newest first: pending, undone, refused and held ones never appear", () => {
    const rows = [
      change({ id: "old", state: "applied", decidedAt: 100 }),
      change({ id: "p", state: "pending", decidedAt: null, createdAt: 900 }),
      change({ id: "u", state: "undone", decidedAt: 400 }),
      change({ id: "new", state: "applied", decidedAt: 300 }),
      change({ id: "d", state: "discarded" }),
      change({ id: "h", state: "held" }),
      change({ id: "x", state: "expired" }),
      change({ id: "c", state: "conflict" }),
      change({ id: "f", state: "failed" }),
    ];
    expect(appliedHistory(rows).map((r) => r.id)).toEqual(["new", "old"]);
    expect(appliedHistory([])).toEqual([]);
  });
  it("how it landed: who, then how — you approved it / applied automatically / you saved it in Settings", () => {
    expect(historyHow(change({ origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 }, decidedBy: "click" }))).toBe("Architect · you approved it");
    expect(historyHow(change({ origin: { kind: "chat" }, decidedBy: "auto" }))).toBe("Manta · for you · applied automatically");
    expect(historyHow(change({ origin: { kind: "settings", field: "model" }, decidedBy: "click" }))).toBe("You · in Settings");
    expect(historyHow(change({ origin: { kind: "restore", fromChangeId: "x" }, decidedBy: "click" }))).toBe("You · restored an earlier version");
  });
  it("the status is a label with a tone and, where there is one, the reason — live says how it went live, undone by whom", () => {
    expect(historyStatus(change({ state: "applied", decidedBy: "click" }))).toEqual({ tone: "ok", label: "Live", why: "you approved it" });
    expect(historyStatus(change({ state: "applied", decidedBy: "auto" }))).toEqual({ tone: "ok", label: "Live", why: "applied automatically" });
    expect(historyStatus(change({ state: "undone", decidedBy: "click" }))).toEqual({ tone: "faint", label: "Undone", why: "by you" });
    expect(historyStatus(change({ state: "undone", decidedBy: null }))).toEqual({ tone: "faint", label: "Undone", why: null });
    expect(historyStatus(change({ state: "pending" }))).toEqual({ tone: "accent", label: "Waiting for your click", why: null });
    expect(historyStatus(change({ state: "discarded" }))).toEqual({ tone: "faint", label: "Discarded", why: null });
    expect(historyStatus(change({ state: "expired" }))).toEqual({ tone: "faint", label: "Expired", why: null });
    expect(historyStatus(change({ state: "conflict", error: "File changed since" }))).toEqual({ tone: "warn", label: "Not applied", why: "File changed since" });
    expect(historyStatus(change({ state: "failed", error: null }))).toEqual({ tone: "warn", label: "Not activated", why: null });
    expect(historyStatus(change({ state: "held" }))).toEqual({ tone: "faint", label: "Waiting for the Architect to finish", why: null });
    expect(historyStatus(change({ state: "applying" }))).toEqual({ tone: "accent", label: "Applying…", why: null });
  });
  it("the one Undo belongs to the newest live change", () => {
    const rows = [change({ id: "p", state: "pending", decidedAt: null, createdAt: 900 }), change({ id: "a", state: "applied", decidedAt: 300 }), change({ id: "b", state: "applied", decidedAt: 200 }), change({ id: "u", state: "undone", decidedAt: 400 })];
    expect(latestLiveId(rows)).toBe("a");
    expect(latestLiveId([change({ state: "undone" })])).toBeNull();
  });
});

describe("researchHealth", () => {
  const e = (over: Partial<AgentProfile["research"][number]> = {}) => ({ id: "r", topic: "t", sourceCount: 3, ageDays: 1, status: "fresh" as const, thin: false, ...over });
  it("counts stale, thin and missing entries (a missing one has no age or sources to judge)", () => {
    expect(researchHealth([e(), e({ status: "stale" }), e({ thin: true }), e({ status: "stale", thin: true }), e({ status: "missing", thin: false, sourceCount: null, ageDays: null })])).toEqual({ stale: 2, thin: 2, missing: 1 });
    expect(researchHealth([])).toEqual({ stale: 0, thin: 0, missing: 0 });
  });
});

describe("Restore before this", () => {
  const rows = [
    change({ id: "new", before: "V2", after: "V3", decidedAt: 300 }),
    change({ id: "mid", before: "V1", after: "V2", decidedAt: 200 }),
    change({ id: "old", kind: "create", before: null, after: "V1", decidedAt: 100 }),
  ];
  it("the current version is the newest applied change's after", () => {
    expect(currentSnapshot(rows)).toBe("V3");
  });
  it("an undone change puts the agent back at its before", () => {
    expect(currentSnapshot([change({ id: "u", before: "V2", after: "V3", state: "undone", decidedAt: 400 }), ...rows.slice(1)])).toBe("V2");
  });
  it("is offered on applied or undone updates whose before is not what is live now", () => {
    expect(canRestore(rows[0], "V3")).toBe(true); // V2 is not what's live (V3)
    expect(canRestore(rows[1], "V3")).toBe(true); // V1 is not what's live
    expect(canRestore(change({ state: "undone", before: "V2" }), "V3")).toBe(true);
  });
  it("is not offered where it would change nothing (the version before the change is already live)", () => {
    expect(canRestore(rows[0], "V2")).toBe(false);
    // a learned rule changes no agent file: undoing it is the Learned tab's job, not a restore of the whole folder
    expect(canRestore(change({ state: "applied", before: "V2", origin: { kind: "learned" } }), "V3")).toBe(false);
  });
  it("never on a create, a record with no before, or a state that never applied", () => {
    expect(canRestore(rows[2], "V3")).toBe(false);
    expect(canRestore(change({ state: "pending", before: "V1" }), "V3")).toBe(false);
    expect(canRestore(change({ state: "discarded", before: "V1" }), "V3")).toBe(false);
    expect(canRestore(change({ state: "applied", before: null }), "V3")).toBe(false);
  });
  it("with no known current version it is still offered (the box refuses a no-op in words)", () => {
    expect(canRestore(rows[1], null)).toBe(true);
  });
});

describe("seats", () => {
  it("notes: a count, or a dash when unknown", () => {
    expect(seatNotesLabel(23)).toBe("23 notes");
    expect(seatNotesLabel(1)).toBe("1 note");
    expect(seatNotesLabel(null)).toBe("—");
  });
  it("memory access reads as plain words", () => {
    expect(memoryLabel("read")).toBe("read");
    expect(memoryLabel("read-write")).toBe("read + write");
    expect(memoryLabel("none")).toBe("no access");
  });
});


describe("seatFolder", () => {
  const seat = { project: "manta-aaaaaaaaaa", projectName: "Manta" };
  it("the open project whose folder is the seat's project", () => {
    expect(seatFolder(seat, [{ defaultCwd: "/w/other" }, { defaultCwd: "/w/manta" }])).toBe("/w/manta");
  });
  it("none or several candidates is null (never a wrong project)", () => {
    expect(seatFolder(seat, [{ defaultCwd: "/w/other" }])).toBeNull();
    expect(seatFolder(seat, [{ defaultCwd: "/a/manta" }, { defaultCwd: "/b/manta" }])).toBeNull();
    expect(seatFolder(undefined, [{ defaultCwd: "/w/manta" }])).toBeNull();
  });
});
