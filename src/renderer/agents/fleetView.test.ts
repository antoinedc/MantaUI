// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentChange, FleetTask, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import {
  askedByText,
  askedByWho,
  changeRecommendation,
  changeTodo,
  decisionReviews,
  endedBadge,
  fleetHeaderCounts,
  groupNeedsByProject,
  groupSummary,
  groupTasks,
  inProgressCount,
  lastUpdateLabel,
  needsCounts,
  needsTop,
  questionAssumption,
  readBanner,
  readFleetBy,
  resumeBlockedReason,
  saveFleetBy,
  sidebarNeeds,
  statusView,
} from "./fleetView";

const task = (over: Partial<FleetTask> = {}): FleetTask => ({
  jobId: "j1",
  rootJobId: "j1",
  title: "Fix the build",
  agentSlug: "dev",
  project: "site",
  projectName: "Site",
  startedAt: 1,
  branch: null,
  askedBy: { by: "you" },
  status: "in-progress",
  pausedAt: null,
  ...over,
});

const review = (over: Partial<NeedsYouReview> = {}): NeedsYouReview => ({
  jobId: "r1",
  agentSlug: "dev",
  project: "site",
  name: "Test exports",
  finishedAt: 5,
  filesChanged: 0,
  branch: null,
  resultText: "",
  reason: "Needs a decision",
  endedBlocked: true,
  ...over,
});

const question = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: "tq_1",
  rootJobId: "j1",
  jobId: "j1",
  parentSessionID: "ses",
  agentSlug: "dev",
  agentName: "Dev",
  project: "site",
  taskName: "Upgrade the tree",
  questions: [{ question: "Rebuild search?", options: [{ label: "Rebuild it (Recommended)", description: "" }, { label: "Skip", description: "" }], multiple: false }],
  state: "open",
  askedAt: 1,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

const change = (over: Partial<AgentChange> = {}): AgentChange =>
  ({ id: "c1", kind: "update", slug: "dev", agentName: "Dev", state: "pending", origin: { kind: "job" }, createdAt: 1, ...over }) as AgentChange;

const needs = (over: Partial<NeedsYou> = {}): NeedsYou => ({ questions: [], changes: [], reviews: [], count: 0, ...over });

describe("which view: remembered per device", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to Projects and remembers the last choice", () => {
    expect(readFleetBy()).toBe("projects");
    saveFleetBy("agents");
    expect(readFleetBy()).toBe("agents");
    localStorage.setItem("manta:fleet:view", "nonsense");
    expect(readFleetBy()).toBe("projects");
  });
});

describe("groupTasks", () => {
  const names = (slug: string) => ({ dev: "Dev", pd: "Product Designer" })[slug] ?? slug;
  const tasks = [
    task({ jobId: "a", project: "capo", projectName: "Capo", status: "paused-by-you", pausedAt: 1 }),
    task({ jobId: "b", project: "site", projectName: "Site" }),
    task({ jobId: "c", project: "capo", projectName: "Capo", agentSlug: "pd" }),
    task({ jobId: "d", project: null, projectName: null, agentSlug: "pd" }),
  ];
  it("by project: groups with something in progress come first, then paused-only ones; in-progress rows first inside a group", () => {
    const g = groupTasks(tasks, "projects", names);
    expect(g.map((x) => [x.label, x.tasks.map((t) => t.jobId)])).toEqual([
      ["Capo", ["c", "a"]],
      ["Site", ["b"]],
      ["No project", ["d"]],
    ]);
  });
  it("by agent: one group per agent, named by the team", () => {
    const g = groupTasks(tasks, "agents", names);
    expect(g.map((x) => [x.label, x.key, x.tasks.map((t) => t.jobId)])).toEqual([
      ["Dev", "dev", ["b", "a"]],
      ["Product Designer", "pd", ["c", "d"]],
    ]);
  });
  it("a group that is only paused goes last", () => {
    const g = groupTasks([task({ jobId: "p", project: "z", projectName: "Z", status: "paused-by-you" }), task({ jobId: "r" })], "projects", names);
    expect(g.map((x) => x.label)).toEqual(["Site", "Z"]);
  });
});

describe("counts and summaries", () => {
  it("summarises a group: n in progress · n paused (the words of the mockup)", () => {
    expect(groupSummary([task(), task({ jobId: "2" }), task({ jobId: "3", status: "paused-by-you" })])).toBe("2 in progress · 1 paused");
    expect(groupSummary([task()])).toBe("1 in progress");
    expect(groupSummary([task({ status: "paused-by-you" })])).toBe("1 paused");
  });
  it("the header and the sidebar count the same thing: tasks in progress", () => {
    const t = [task(), task({ jobId: "2", status: "paused-by-you" })];
    expect(inProgressCount(t)).toBe(1);
    expect(fleetHeaderCounts(t)).toBe("1 in progress · 1 paused");
    expect(fleetHeaderCounts([])).toBe("");
  });
});

describe("statusView: only what the box records", () => {
  it("In progress, or Paused by you with how long ago", () => {
    expect(statusView(task(), 100)).toEqual({ label: "In progress", tone: "ok", sub: null });
    expect(statusView(task({ status: "paused-by-you", pausedAt: 100 - 3 * 3_600_000 }), 100)).toEqual({ label: "Paused by you", tone: "idle", sub: "3h ago" });
    expect(statusView(task({ status: "paused-by-you", pausedAt: null }), 100).sub).toBeNull();
  });
  it("the four outcome badges", () => {
    expect(endedBadge("done")).toEqual({ label: "Done", tone: "ok" });
    expect(endedBadge("didnt-finish")).toEqual({ label: "Didn’t finish", tone: "bad" });
    expect(endedBadge("interrupted")).toEqual({ label: "Interrupted", tone: "cut" });
    expect(endedBadge("stopped")).toEqual({ label: "Stopped by you", tone: "neutral" });
  });
  it("Resume says why it can't while the box is full", () => {
    expect(resumeBlockedReason(false, 10)).toBeNull();
    expect(resumeBlockedReason(true, 10)).toBe("Can’t resume yet: 10 tasks are already running. It can start when one finishes.");
  });
  it("who asked", () => {
    expect(askedByText({ by: "you" }, null)).toBe("asked by you");
    expect(askedByText({ by: "manta", sessionId: "s" }, "Limits cleanup")).toBe("asked by Manta in Limits cleanup");
    expect(askedByText({ by: "manta", sessionId: null }, null)).toBe("asked by Manta");
    expect(askedByText({ by: "routine" }, null)).toBe("a routine");
    expect(askedByWho({ by: "you" }, null)).toBe("You");
    expect(askedByWho({ by: "manta", sessionId: "s" }, "Limits cleanup")).toBe("Manta in Limits cleanup");
    expect(askedByWho({ by: "manta", sessionId: null }, null)).toBe("Manta");
    expect(askedByWho({ by: "routine" }, null)).toBe("A routine");
  });
});

describe("Needs you counts: decisions block, questions never do", () => {
  it("decisions = pending changes + reviews that ended on a decision; a branch review from an older box is dropped", () => {
    const d = needs({ changes: [change()], reviews: [review(), review({ jobId: "old", endedBlocked: false, reason: "Branch ready to merge · 3 files" }), review({ jobId: "old2", endedBlocked: undefined })], questions: [question()] });
    expect(decisionReviews(d).map((r) => r.jobId)).toEqual(["r1"]);
    expect(needsCounts(d)).toEqual({ decisions: 2, questions: 1 });
    expect(needsCounts(null)).toEqual({ decisions: 0, questions: 0 });
  });
  it("sidebar: a red number for decisions only; a blue dot when only questions are open; nothing when empty or unread", () => {
    expect(sidebarNeeds(needs({ changes: [change()], questions: [question()] }))).toEqual({ decisions: 1, questionDot: false });
    expect(sidebarNeeds(needs({ questions: [question()] }))).toEqual({ decisions: 0, questionDot: true });
    expect(sidebarNeeds(needs())).toEqual({ decisions: 0, questionDot: false });
    expect(sidebarNeeds(null)).toEqual({ decisions: 0, questionDot: false });
  });
  it("the top of Fleet: a card for decisions with the first one named; no line for optional questions", () => {
    const name = (slug: string) => (slug === "architect" ? "Architect" : slug);
    expect(needsTop(needs({ questions: [question()] }), name)).toBeNull();
    expect(needsTop(needs(), name)).toBeNull();
    const one = needsTop(needs({ changes: [change({ slug: "dev", agentName: "Dev" })] }), name);
    expect(one?.heading).toBe("1 decision is waiting for you");
    expect(one?.detail).toMatch(/^Approve the change to Dev/);
    const many = needsTop(needs({ changes: [change()], reviews: [review()] }), name);
    expect(many?.heading).toBe("2 decisions are waiting for you");
    expect(many?.detail).toMatch(/and 1 other$/);
  });
});

describe("what a card says", () => {
  it("the question's fallback line names the agent, and only claims the recommended option when there is one", () => {
    expect(questionAssumption(question(), "Dev")).toBe("If no one answers, Dev goes with the recommended option, so it’s fine to ignore this.");
    const plain = question({ questions: [{ question: "q", options: [{ label: "A", description: "" }], multiple: false }] });
    expect(questionAssumption(plain, "Dev")).toBeNull();
    const multi = question({ questions: [{ question: "q", options: [{ label: "A (Recommended)", description: "" }], multiple: true }] });
    expect(questionAssumption(multi, "Dev")).toBeNull();
  });
  it("Manta recommends approving a clean change, and reading it first when a review or a trial flagged something", () => {
    expect(changeRecommendation(change())).toBe("Manta recommends approving it.");
    expect(changeRecommendation(change({ scriptReview: { verdict: "flagged", reasons: ["x"], model: "m", at: 1 } }))).toBe("Manta recommends reading it first: an independent check flagged a script.");
    expect(changeRecommendation(change({ contentReview: { verdict: "error", reasons: [], carried: [], model: "m", at: 1 } }))).toBe("Manta recommends reading it first: an independent check couldn’t run.");
    expect(changeRecommendation(change({ trial: { id: "t", verdicts: [{ case: "a", pass: true, quote: "", note: "" }, { case: "b", pass: false, quote: "", note: "" }] } }))).toBe("Manta recommends reading it first: 1 of 2 test cases didn’t pass.");
  });
  it("the title of a change item says what is being decided", () => {
    expect(changeTodo(change({ kind: "update", agentName: "Dev" }))).toBe("Approve the change to Dev?");
    expect(changeTodo(change({ kind: "create", agentName: "Scout" }))).toBe("Approve creating Scout?");
    expect(changeTodo(change({ origin: { kind: "template-update", templateHash: "h" } as never, agentName: "Dev" }))).toBe("Approve the built-in update to Dev?");
    expect(changeTodo(change({ origin: { kind: "learned" } as never, agentName: "Dev" }))).toBe("Approve what Dev learned?");
  });
  it("items group under their project, decisions before questions, projects in first-seen order", () => {
    const g = groupNeedsByProject(
      [
        { id: "q1", urgency: "question", project: "site" },
        { id: "d1", urgency: "decision", project: "capo" },
        { id: "d2", urgency: "decision", project: "site" },
        { id: "d3", urgency: "decision", project: null },
      ],
      (slug) => (slug ? slug.toUpperCase() : "Other"),
    );
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["CAPO", ["d1"]],
      ["SITE", ["d2", "q1"]],
      ["Other", ["d3"]],
    ]);
  });
});

describe("banners: a stale read says so, with the last update's time", () => {
  const at = new Date(2026, 10, 28, 14, 2).getTime();
  it("formats the time of the last update", () => {
    expect(lastUpdateLabel(at)).toBe("14:02");
    expect(lastUpdateLabel(null)).toBeNull();
  });
  it("nothing to say while the read is fine", () => {
    expect(readBanner({ connected: true, hasData: true, error: null, refreshError: null, updatedAt: at }, "Fleet")).toBeNull();
  });
  it("unreachable box beats a failed read: warn, last update, Try now", () => {
    expect(readBanner({ connected: false, hasData: true, error: null, refreshError: "x", updatedAt: at }, "Fleet")).toEqual({
      tone: "warn",
      title: "Can’t reach your box right now.",
      text: "This is the last update, from 14:02. It will reconnect on its own.",
      action: "Try now",
    });
  });
  it("a failed refresh keeps the data: bad banner naming the page and the last update", () => {
    expect(readBanner({ connected: true, hasData: true, error: null, refreshError: "busy", updatedAt: at }, "Needs you")).toEqual({
      tone: "bad",
      title: "Couldn’t refresh Needs you.",
      text: "Nothing was changed. Below is the last update, from 14:02.",
      action: "Try again",
    });
  });
  it("a first read that failed has nothing to show below", () => {
    expect(readBanner({ connected: true, hasData: false, error: "busy", refreshError: null, updatedAt: null }, "Fleet")).toEqual({
      tone: "bad",
      title: "Couldn’t load Fleet.",
      text: "busy",
      action: "Try again",
    });
  });
});
