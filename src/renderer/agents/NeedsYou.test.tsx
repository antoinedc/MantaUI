// @vitest-environment jsdom
//
// Needs you (agent screens spec §2.1): each item is the existing card under one context line; every press ends visibly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentChange, AgentInfo, DelegateJob, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import { resetPackageAgentsForTest } from "../packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import { NeedsYouList } from "./NeedsYou";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug: "sales",
  name: "Sales",
  description: "Sells",
  isolation: "none",
  model: null,
  color: "#aa5500",
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const AGENTS = [
  info(),
  info({ slug: "dev", name: "Dev", isolation: "worktree" }),
  info({ slug: "architect", name: "Architect", role: "architect", color: null }),
  info({ slug: "manta", name: "Manta", role: "lead" }),
];

const tq = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: "tq_1",
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: "ses_p",
  agentSlug: "sales",
  agentName: "Sales",
  project: "tenanture",
  taskName: "Lead research",
  questions: [{ question: "Which segment first?", options: [{ label: "Small landlords (Recommended)", description: "" }, { label: "Property managers", description: "" }], multiple: false }],
  state: "open",
  askedAt: NOW - 3 * 60 * MIN,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

const change = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "chg1",
  kind: "create",
  slug: "pricing-cta",
  agentName: "Pricing CTA Copy",
  sessionID: "ses_p",
  messageID: "m",
  callID: "c",
  state: "pending",
  needsClick: true,
  reason: "plan",
  before: null,
  after: "---\nname: Pricing CTA Copy\ndescription: Writes CTA text\nisolation: none\n---\nDo it.",
  createdAt: NOW - 20 * MIN,
  decidedAt: null,
  error: null,
  origin: { kind: "job", jobId: "job2", rootJobId: "job2", attempt: 1 },
  mode: "build",
  releasedAt: NOW - 20 * MIN,
  decidedBy: null,
  summary: "A dedicated agent for the pricing CTA.",
  evidence: [],
  admission: [],
  ...over,
});

const review = (over: Partial<NeedsYouReview> = {}): NeedsYouReview => ({
  jobId: "job9",
  agentSlug: "dev",
  project: "manta",
  name: "Fix the 0-byte crash",
  finishedAt: NOW - 10 * MIN,
  filesChanged: 3,
  branch: "agent/dev/x",
  resultText: "Fixed the crash.",
  ...over,
});

const data = (over: Partial<NeedsYou> = {}): NeedsYou => ({ questions: [], changes: [], reviews: [], count: 0, ...over });
const PROJECTS = [
  { slug: "tenanture", name: "Tenanture" },
  { slug: "manta", name: "Manta" },
];

describe("NeedsYouList", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onChanged = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    resetStore();
    resetPackageAgentsForTest();
    onChanged.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  async function open(d: NeedsYou, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({ agentsList: () => Promise.resolve(AGENTS), ...overrides }));
    h = mount(<NeedsYouList data={d} agents={AGENTS} projects={PROJECTS} onChanged={onChanged} />);
    await h.flush();
  }
  const items = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="needs-you-item"]')];
  const btn = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(text)) as HTMLButtonElement | undefined;
  async function click(el: Element | undefined | null) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("is empty when nothing waits", async () => {
    await open(data());
    expect(h!.container.querySelector('[data-testid="needs-you-empty"]')?.textContent).toBe("Nothing needs you.");
    expect(items()).toHaveLength(0);
  });

  it("lists questions, then changes, then reviews, each under its context line", async () => {
    await open(data({ questions: [tq()], changes: [change()], reviews: [review()], count: 3 }));
    expect(items().map((i) => i.dataset.kind)).toEqual(["question", "change", "review"]);
    const [q, c, r] = items();
    const ctx = (el: HTMLElement) => el.querySelector(".manta-agents-ny-ctx")!.textContent;
    expect(ctx(q)).toContain("Sales");
    expect(ctx(q)).toContain("Tenanture");
    expect(ctx(q)).toContain("Lead research");
    expect(ctx(q)).toContain("asked 3h ago");
    expect(ctx(c)).toContain("Architect");
    expect(ctx(c)).toContain("New agent: Pricing CTA Copy");
    expect(ctx(c)).toContain("20m ago");
    expect(ctx(r)).toContain("Dev");
    expect(ctx(r)).toContain("Manta");
    expect(ctx(r)).toContain("Fix the 0-byte crash");
    // the cards themselves are the existing ones
    expect(q.textContent).toContain("Sales asks you");
    expect(c.querySelector('[data-testid="agent-change-card"]')).toBeTruthy();
    expect(r.querySelector('[data-testid="background-result-card"]')).toBeTruthy();
    expect(r.textContent).toContain("Fixed the crash.");
  });

  it("a question's context says the task is still working on the rest while it runs", async () => {
    resetStore({ jobs: { ses_c1: { id: "job1", rootJobId: "job1", agent: "agent-sales", status: "running", createdAt: 1 } as unknown as DelegateJob } });
    await open(data({ questions: [tq()], count: 1 }));
    expect(items()[0].textContent).toContain("still working on the rest");
  });

  it("Submit answers through the agents channel, awaited, then asks for a fresh read", async () => {
    await open(data({ questions: [tq()], count: 1 }), { agentsQuestionAnswer: () => Promise.resolve({}) });
    await click(btn(items()[0], "Submit"));
    expect(api.calls.agentsQuestionAnswer).toEqual([[{ id: "tq_1", answers: [["Small landlords (Recommended)"]] }]]);
    expect(onChanged).toHaveBeenCalled();
    expect(items()[0].querySelector('[role="alert"]')).toBeNull();
  });

  it("a refused answer shows its sentence in the item's context row, and the card stays", async () => {
    await open(data({ questions: [tq()], count: 1 }), { agentsQuestionAnswer: () => Promise.reject(new Error("This task is paused; resume it first, then answer.")) });
    await click(btn(items()[0], "Submit"));
    const alert = items()[0].querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("This task is paused; resume it first, then answer.");
    expect(btn(items()[0], "Submit")).toBeTruthy();
  });

  it("Dismiss goes to the dismiss channel; a refusal is shown", async () => {
    await open(data({ questions: [tq()], count: 1 }), { agentsQuestionDismiss: () => Promise.reject(new Error("That question no longer exists.")) });
    await click(btn(items()[0], "Dismiss"));
    expect(api.calls.agentsQuestionDismiss).toEqual([[{ id: "tq_1" }]]);
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toBe("That question no longer exists.");
  });

  it("a question's own last refusal (the box's record) is shown too", async () => {
    await open(data({ questions: [tq({ error: "The task couldn't take your answer." })], count: 1 }));
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toBe("The task couldn't take your answer.");
  });

  it("a change card's own button is the only Apply; pressing it keeps the card, in its new state, and asks for a fresh read", async () => {
    const applied = change({ state: "applied", decidedAt: NOW, decidedBy: "click" });
    await open(data({ changes: [change()], count: 1 }), { agentsChangeApply: () => Promise.resolve(applied) });
    const labels = [...items()[0].querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(labels.filter((l) => /^(Create|Apply)/.test(l))).toHaveLength(1); // one confirm button, no duplicate beside the card
    await click(btn(items()[0], "Create"));
    expect(api.calls.agentsChangeApply).toEqual([["chg1"]]);
    expect(onChanged).toHaveBeenCalled();
    expect(items()[0].querySelector('[data-testid="agent-change-card"]')?.getAttribute("data-state")).toBe("applied");
  });

  it("a settled change stays on the page after the next read no longer lists it", async () => {
    const applied = change({ state: "applied", decidedAt: NOW, decidedBy: "click" });
    await open(data({ changes: [change()], count: 1 }), { agentsChangeApply: () => Promise.resolve(applied) });
    await click(btn(items()[0], "Create"));
    h!.rerender(<NeedsYouList data={data()} agents={AGENTS} projects={PROJECTS} onChanged={onChanged} />);
    expect(items()).toHaveLength(1);
    expect(items()[0].querySelector('[data-testid="agent-change-card"]')?.getAttribute("data-state")).toBe("applied");
  });

  it("Done on a review dismisses it through the box, then asks for a fresh read; a refusal is shown", async () => {
    await open(data({ reviews: [review()], count: 1 }), { agentsReviewDone: () => Promise.resolve({ ok: true }) });
    await click(btn(items()[0], "Done"));
    expect(api.calls.agentsReviewDone).toEqual([[{ jobId: "job9" }]]);
    expect(onChanged).toHaveBeenCalled();
    h!.unmount();
    onChanged.mockClear();
    await open(data({ reviews: [review()], count: 1 }), { agentsReviewDone: () => Promise.reject(new Error("Couldn't save")) });
    await click(btn(items()[0], "Done"));
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toBe("Couldn't save");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a review card offers no Details (there is no chat here to open a panel in) but Open session →", async () => {
    await open(data({ reviews: [review()], count: 1 }));
    expect(items()[0].querySelector('[data-testid="background-result-details"]')).toBeNull();
    expect(items()[0].querySelector('[data-testid="background-open-session"]')?.textContent).toContain("Open session");
  });
});
