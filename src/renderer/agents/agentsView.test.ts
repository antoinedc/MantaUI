// Pure logic of the agent screens' pages (agent screens spec §2.1, §2.2, §5.2).

import { describe, expect, it } from "vitest";
import type { AgentChange, AgentProfile, FleetCell, NeedsYouReview, UsageSnapshot } from "../../shared/types";
import {
  canRestore,
  cellView,
  currentSnapshot,
  errText,
  factsLine,
  firstLine,
  historyOutcome,
  historyWho,
  isUnknownChannel,
  memoryLabel,
  nextTab,
  planUsagePercent,
  PROFILE_TABS,
  recapLead,
  reviewPart,
  seatNotesLabel,
  weekPill,
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

describe("planUsagePercent", () => {
  const snap = (windows: Array<{ pct: number; active?: boolean }>): UsageSnapshot =>
    ({ provider: "claude", providerIDs: [], fetchedAt: 1, windows: windows.map((w, i) => ({ kind: i ? "weekly" : "session", label: "x", ...w })) }) as UsageSnapshot;
  it("is the highest percentage of the current windows, rounded", () => {
    expect(planUsagePercent([snap([{ pct: 12.4 }, { pct: 37.6 }]), snap([{ pct: 20 }])])).toBe(38);
  });
  it("ignores windows the provider says are not in force, and says nothing when unknown", () => {
    expect(planUsagePercent([snap([{ pct: 90, active: false }, { pct: 10 }])])).toBe(10);
    expect(planUsagePercent([])).toBeNull();
    expect(planUsagePercent([snap([])])).toBeNull();
    expect(planUsagePercent(null)).toBeNull();
  });
});

describe("weekPill", () => {
  it("says the tasks and, when known, the plan usage; never a dollar amount", () => {
    expect(weekPill(41, 38)).toBe("This week: 41 tasks · plan usage 38%");
    expect(weekPill(1, null)).toBe("This week: 1 task");
    expect(weekPill(0, null)).toBe("This week: 0 tasks");
    expect(weekPill(5, 38)).not.toMatch(/\$/);
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
  const r: NeedsYouReview = { jobId: "job9", agentSlug: "dev", project: "manta", name: "Fix the crash", finishedAt: 5, filesChanged: 3, branch: "agent/dev/x", resultText: "Fixed it." };
  it("builds the finished-card part from the review item, with no chat to open a panel in", () => {
    const p = reviewPart(r);
    expect(p).toMatchObject({ type: "background-result", jobId: "job9", state: "done", name: "Fix the crash", agent: "agent-dev", text: "Fixed it." });
    expect(p.sessionID).toBeUndefined();
    expect(p.childSessionId).toBe("job9");
  });
});

describe("tabs", () => {
  it("lists Overview, Research, Seats, History", () => {
    expect(PROFILE_TABS.map((t) => t.id)).toEqual(["overview", "research", "seats", "history"]);
  });
  it("arrows move with wrap, Home and End jump, anything else is not a tab key", () => {
    const ids = PROFILE_TABS.map((t) => t.id);
    expect(nextTab("overview", "ArrowRight", ids)).toBe("research");
    expect(nextTab("history", "ArrowRight", ids)).toBe("overview");
    expect(nextTab("overview", "ArrowLeft", ids)).toBe("history");
    expect(nextTab("seats", "Home", ids)).toBe("overview");
    expect(nextTab("seats", "End", ids)).toBe("history");
    expect(nextTab("seats", "Enter", ids)).toBeNull();
  });
});

describe("factsLine / firstLine", () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile =>
    ({
      info: { slug: "seo", name: "SEO", description: "d", isolation: "none", model: "anthropic/sonnet", color: null, builtIn: false, role: "specialist", useWhen: null, notFor: null, notice: null },
      seats: [],
      lastChangedAt: Date.UTC(2026, 10, 12, 12),
      builtBy: "architect",
      refresh: { enabled: true, routineId: null },
      research: [],
      ...over,
    }) as AgentProfile;
  it("built by / last changed / model / isolation", () => {
    expect(factsLine(profile())).toEqual(["built by Architect", "last changed 12 Nov", "model: anthropic/sonnet", "read-only"]);
  });
  it("Auto when no model, its own branch for a worktree agent, built in / you / Manta, no change date when never changed", () => {
    const p = profile({ lastChangedAt: null, builtBy: "built-in" });
    p.info = { ...p.info, model: null, isolation: "worktree" };
    expect(factsLine(p)).toEqual(["built in", "model: Auto", "edits code on its own branch"]);
    expect(factsLine(profile({ builtBy: "user" }))[0]).toBe("built by you");
    expect(factsLine(profile({ builtBy: "manta" }))[0]).toBe("built by Manta");
  });
  it("firstLine takes the first non-empty line", () => {
    expect(firstLine("\n\n  Hello there  \nsecond")).toBe("Hello there");
    expect(firstLine("")).toBe("");
  });
});

describe("history rows", () => {
  it("who: Manta for you (chat), Architect (job), You (restore)", () => {
    expect(historyWho(change({ origin: { kind: "chat" } }))).toBe("Manta · for you");
    expect(historyWho(change({ origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 } }))).toBe("Architect");
    expect(historyWho(change({ origin: { kind: "restore", fromChangeId: "x" } }))).toBe("You");
  });
  it("the outcome line follows every state; an undone row says Undone and by whom", () => {
    expect(historyOutcome(change({ state: "applied", decidedBy: "click" }))).toBe("Live (you approved it)");
    expect(historyOutcome(change({ state: "applied", decidedBy: "auto" }))).toBe("Live (applied automatically)");
    expect(historyOutcome(change({ state: "undone", decidedBy: "click" }))).toBe("Undone by you");
    expect(historyOutcome(change({ state: "undone", decidedBy: null }))).toBe("Undone");
    expect(historyOutcome(change({ state: "pending" }))).toBe("Waiting for your click");
    expect(historyOutcome(change({ state: "discarded" }))).toBe("Discarded");
    expect(historyOutcome(change({ state: "expired" }))).toBe("Expired");
    expect(historyOutcome(change({ state: "conflict", error: "File changed since" }))).toBe("Not applied: File changed since");
    expect(historyOutcome(change({ state: "failed", error: null }))).toBe("Not activated");
    expect(historyOutcome(change({ state: "held" }))).toBe("Waiting for the Architect to finish");
    expect(historyOutcome(change({ state: "applying" }))).toBe("Applying…");
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
    expect(memoryLabel("read")).toBe("read-only");
    expect(memoryLabel("read-write")).toBe("read + write");
    expect(memoryLabel("none")).toBe("no access");
  });
});

describe("recapLead", () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
  it("today, yesterday, an older day; and the last day when there is no earlier visit", () => {
    const now = at(26, 12, 0);
    expect(recapLead(at(26, 9, 5), now)).toBe("Since today 09:05:");
    expect(recapLead(at(25, 18, 40), now)).toBe("Since yesterday 18:40:");
    expect(recapLead(at(12, 7, 0), now)).toBe("Since 12 Nov 07:00:");
    expect(recapLead(null, now)).toBe("In the last 24 hours:");
  });
});
