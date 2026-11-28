// @vitest-environment jsdom
//
// The task side panel (agent screens spec §2.5): an agent task's top bar, what happened (JobDetails), the research it
// relied on, the brief. It lives in the chat's right slot and follows the task across rounds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentResearchEntry, DelegateJob, DelegateJobProgressView, TaskQuestion } from "../shared/types";
import { TaskSidePanel } from "./TaskSidePanel";
import { openTaskPanel, resetExplorerStore, setRightPanel, shownRightPanel } from "./explorer/explorerStore";
import { resetPackageAgentsForTest } from "./packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const view = (over: Partial<DelegateJobProgressView> = {}): DelegateJobProgressView => ({
  rev: { epoch: 1, n: 1 },
  asOf: T0,
  state: "working",
  headline: "Researching CTA label evidence",
  headlineSource: "model",
  steps: {
    done: 1,
    total: 3,
    current: "Research",
    items: [
      { text: "Read the request", status: "done" },
      { text: "Research", status: "current" },
      { text: "Propose", status: "pending" },
    ],
    source: "checklist",
    planRevision: 1,
    grewAt: null,
  },
  bar: 1 / 3,
  live: null,
  startedAt: T0 - 6 * MIN,
  endedAt: null,
  lastProgressAt: T0 - MIN,
  ceilingAt: T0 + 4 * 60 * MIN,
  milestones: [{ at: T0 - 5 * MIN, text: "Asked you: separate agent or extend @conversion-cro?" }],
  files: null,
  usage: null,
  model: null,
  ...over,
});

const job = (over: Record<string, unknown> = {}): DelegateJob =>
  ({
    id: "job1",
    rootJobId: "job1",
    name: "New agent: Pricing CTA Copy",
    prompt: "Create an agent that rewrites CTA text.\n\n---\nYour brief for this project:\nSEAT-BRIEF-TEXT\n\n---\nRecent conversation in the chat that asked you (oldest first), for context:\nEXCERPT-TEXT",
    request: "Create an agent that rewrites CTA text.",
    agent: "agent-architect",
    agentName: "Architect",
    model: null,
    parentSessionID: "ses_p",
    parentDirectory: "/x",
    childSessionID: "ses_c1",
    tmuxSession: "proj",
    windowIndex: 4,
    worktree: null,
    branch: null,
    baseSha: null,
    status: "running",
    activity: null,
    createdAt: 1,
    view: view(),
    ...over,
  }) as unknown as DelegateJob;

const tq = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: "tq_1",
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: "ses_p",
  agentSlug: "architect",
  agentName: "Architect",
  project: null,
  taskName: "New agent",
  questions: [{ question: "Separate agent?", options: [], multiple: false }],
  state: "open",
  askedAt: 1,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

const research = (over: Partial<AgentResearchEntry> = {}): AgentResearchEntry => ({
  id: "r1",
  topic: "CTA label evidence",
  sourceCount: 5,
  ageDays: 0,
  status: "fresh",
  thin: false,
  ...over,
});

let h: Harness | null = null;
let api: MockApi;

async function open(
  jobs: Record<string, DelegateJob>,
  { apiOver = {}, jobId = "job1" }: { apiOver?: Record<string, unknown>; jobId?: string | null } = {},
) {
  ({ api } = installMockApi({
    agentsList: () => Promise.resolve([{ slug: "architect", name: "Architect", description: "", isolation: "none", model: null, color: "#336699", builtIn: true, role: "architect", useWhen: null, notFor: null, notice: null }]),
    agentsQuestions: () => Promise.resolve([]),
    agentsTaskResearch: () => Promise.resolve([research()]),
    ...apiOver,
  }));
  resetPackageAgentsForTest();
  resetStore({ jobs, jobSkew: {} });
  if (jobId) openTaskPanel("ses_p", jobId);
  h = mount(<TaskSidePanel sessionId="ses_p" />);
  await h.flush();
  await h.flush();
}
const q = <E extends HTMLElement = HTMLElement>(sel: string): E | null => h!.container.querySelector<E>(sel);
const byText = (text: string) =>
  [...h!.container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setInterval", "clearInterval"] });
  resetExplorerStore();
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  resetExplorerStore();
  resetStore({ jobs: {}, jobSkew: {} });
});

describe("TaskSidePanel", () => {
  it("renders nothing while the slot is not on the task panel", async () => {
    await open({ ses_c1: job() }, { jobId: null });
    expect(q('[data-testid="task-panel"]')).toBeNull();
    expect(h!.container.textContent).toBe("");
  });

  it("the top bar names the agent and task, and says what state it is in (working, with the open questions)", async () => {
    await open({ ses_c1: job() }, { apiOver: { agentsQuestions: () => Promise.resolve([tq()]) } });
    expect(q('[data-testid="task-panel-title"]')?.textContent).toBe("Architect · New agent: Pricing CTA Copy");
    expect(q('[data-testid="task-panel-state"]')?.textContent).toBe("Working · 1 question");
    expect(api.calls.agentsQuestions).toEqual([[{ sessionID: "ses_p" }]]);
  });

  it("counts only this task's questions, and says 'questions' for more than one", async () => {
    await open(
      { ses_c1: job() },
      { apiOver: { agentsQuestions: () => Promise.resolve([tq(), tq({ id: "tq_2" }), tq({ id: "tq_3", rootJobId: "other" })]) } },
    );
    expect(q('[data-testid="task-panel-state"]')?.textContent).toBe("Working · 2 questions");
  });

  it("a finished task reads Done with how long it took; a failed one reads Failed", async () => {
    await open({ ses_c1: job({ status: "done", view: view({ state: "done", endedAt: T0, startedAt: T0 - 6 * MIN }) }) });
    expect(q('[data-testid="task-panel-state"]')?.textContent).toBe("Done · 6 min");
    h!.unmount();
    await open({ ses_c1: job({ status: "failed", error: "boom", view: view({ state: "failed", endedAt: T0 }) }) });
    expect(q('[data-testid="task-panel-state"]')?.textContent).toBe("Failed");
  });

  it("What happened is the job's own details (checklist, milestones), unchanged", async () => {
    await open({ ses_c1: job() });
    const details = q('[data-testid="background-details"]');
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain("Read the request");
    expect(details!.textContent).toContain("Asked you: separate agent or extend @conversion-cro?");
  });

  it("a task without a progress view says there is nothing to show yet", async () => {
    await open({ ses_c1: job({ view: undefined }) });
    expect(q('[data-testid="background-details"]')).toBeNull();
    expect(h!.text()).toContain("No progress reported yet");
  });

  it("lists the research it relied on, read by the task's job id", async () => {
    await open({ ses_c1: job() });
    expect(api.calls.agentsTaskResearch).toEqual([[{ jobId: "job1" }]]);
    expect(q('[data-testid="research-row"]')?.textContent).toContain("CTA label evidence");
  });

  it("says None yet while the research list is empty, and why when it can't be read", async () => {
    await open({ ses_c1: job() }, { apiOver: { agentsTaskResearch: () => Promise.resolve([]) } });
    expect(h!.text()).toContain("None yet");
    h!.unmount();
    await open({ ses_c1: job() }, { apiOver: { agentsTaskResearch: () => Promise.reject(new Error("Couldn't read the library")) } });
    const alert = q('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't read the library");
  });

  it("the brief is the request as Manta wrote it, collapsed, without the seat brief or the chat excerpt", async () => {
    await open({ ses_c1: job() });
    const brief = q<HTMLDetailsElement>('[data-testid="task-panel-brief"]');
    expect(brief).not.toBeNull();
    expect(brief!.open).toBe(false);
    expect(brief!.textContent).toContain("Create an agent that rewrites CTA text.");
    expect(brief!.textContent).not.toContain("SEAT-BRIEF-TEXT");
    expect(brief!.textContent).not.toContain("EXCERPT-TEXT");
  });

  it("the top bar uses the task's plain-language title, not the slug", async () => {
    await open({ ses_c1: job({ name: "new-agent-pricing-cta-copy", title: "Create a pricing CTA copywriter" }) });
    expect(q('[data-testid="task-panel-title"]')?.textContent).toBe("Architect · Create a pricing CTA copywriter");
  });

  it("follows the task across rounds: the newest record with the same root", async () => {
    const round1 = job({ id: "job1", childSessionID: "ses_c1", supersededBy: "job2", name: "Round one" });
    const round2 = job({ id: "job2", rootJobId: "job1", childSessionID: "ses_c2", name: "Round two", createdAt: 5, attempt: 2 });
    await open({ ses_c1: round1, ses_c2: round2 });
    expect(q('[data-testid="task-panel-title"]')?.textContent).toBe("Architect · Round two");
    expect(api.calls.agentsTaskResearch?.[0]).toEqual([{ jobId: "job2" }]); // the round that is shown (the box resolves its root)
  });

  it("a task that is gone says so, and Close still works", async () => {
    await open({});
    expect(h!.text()).toContain("This task is no longer on the box");
    await act(async () => byText("Close")!.click());
    expect(shownRightPanel("ses_p")).toBe("none");
    expect(q('[data-testid="task-panel"]')).toBeNull();
  });

  it("Close closes the panel and the slot", async () => {
    await open({ ses_c1: job() });
    await act(async () => byText("Close")!.click());
    expect(shownRightPanel("ses_p")).toBe("none");
    expect(h!.container.textContent).toBe("");
  });

  it("closes itself when the slot is taken by another panel", async () => {
    await open({ ses_c1: job() });
    act(() => setRightPanel("ses_p", "artifacts"));
    expect(q('[data-testid="task-panel"]')).toBeNull();
  });
});
