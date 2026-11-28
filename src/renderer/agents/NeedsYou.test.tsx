// @vitest-environment jsdom
//
// The Needs you page (docs/superpowers/specs/2026-11-28-fleet-redesign.md, mockup v10): items under project headings, decisions
// ("Waiting on you", red) before open questions (blue, "keeps working"); a change shows "Manta recommends …" with Apply / Discard;
// a question has the recommended option selected and the line about what happens if no one answers; every press ends visibly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentChange, AgentInfo, FleetTasks, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import { resetPackageAgentsForTest } from "../packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import type { AgentsRead } from "./useAgentsRead";
import { NeedsYouPage } from "./NeedsYou";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug: "dev",
  name: "Dev",
  description: "Dev",
  isolation: "worktree",
  model: null,
  color: "#aa5500",
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const AGENTS = [info(), info({ slug: "architect", name: "Architect", role: "architect", color: null }), info({ slug: "manta", name: "Manta", role: "lead" })];
const PROJECTS = [
  { slug: "ethernal", name: "Ethernal" },
  { slug: "mantaui", name: "MantaUI" },
  { slug: "capo", name: "Capo" },
];

const tq = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id: "tq_1",
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: "ses_p",
  agentSlug: "dev",
  agentName: "Dev",
  project: "ethernal",
  taskName: "Upgrade the file tree",
  questions: [{ question: "Should Dev rebuild search-as-you-type?", options: [{ label: "Rebuild it (Recommended)", description: "" }, { label: "Skip it", description: "" }], multiple: false }],
  state: "open",
  askedAt: NOW - 6 * MIN,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  ...over,
});

const change = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "chg1",
  kind: "update",
  slug: "pd",
  agentName: "Product Designer",
  sessionID: "ses_p",
  messageID: "m",
  callID: "c",
  state: "pending",
  needsClick: true,
  reason: "ask",
  before: "---\nname: Product Designer\ndescription: Designs\nisolation: none\n---\nDesign.",
  after: "---\nname: Product Designer\ndescription: Designs\nisolation: none\n---\nDesign. Use the impeccable skill.",
  createdAt: NOW - 10 * 3_600_000,
  decidedAt: null,
  error: null,
  origin: { kind: "job", jobId: "jobA", rootJobId: "jobA", attempt: 1 },
  mode: "build",
  releasedAt: NOW - 10 * 3_600_000,
  decidedBy: null,
  summary: "Product Designer would use the impeccable skill when reviewing designs.",
  evidence: [],
  admission: [],
  ...over,
});

const review = (over: Partial<NeedsYouReview> = {}): NeedsYouReview => ({
  jobId: "job9",
  agentSlug: "dev",
  project: "capo",
  name: "Test transcript exports with real audio",
  finishedAt: NOW - 2 * 3_600_000,
  filesChanged: 1,
  branch: null,
  resultText: "I ran out of time while transcribing the sample audio.",
  reason: "Needs a decision",
  endedBlocked: true,
  ...over,
});

const data = (over: Partial<NeedsYou> = {}): NeedsYou => ({ questions: [], changes: [], reviews: [], count: 0, ...over });
const read = <T,>(d: T | null, over: Partial<AgentsRead<T>> = {}): AgentsRead<T> => ({ data: d, error: null, refreshError: null, updatedAt: NOW, unsupported: false, loading: false, reload: () => Promise.resolve(), ...over });
const tasks = (ended = 0): FleetTasks => ({ asOf: NOW, running: [], ended: Array.from({ length: ended }, (_, i) => ({ jobId: `e${i}` }) as never), cap: 10, full: false });

describe("NeedsYouPage", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onOpenFleet = vi.fn();
  const reload = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    resetStore({ jobs: {}, jobSkew: {}, connectionState: { state: "connected" } } as never);
    resetPackageAgentsForTest();
    onOpenFleet.mockClear();
    reload.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
  });

  async function open(d: NeedsYou | null, props: { needs?: Partial<AgentsRead<NeedsYou>>; tasks?: FleetTasks | null } = {}, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({ agentsList: () => Promise.resolve(AGENTS), agentsProjects: () => Promise.resolve(PROJECTS), ...overrides }));
    h = mount(<NeedsYouPage needs={read(d, { reload, ...props.needs })} tasks={read(props.tasks === undefined ? tasks() : props.tasks)} onOpenFleet={onOpenFleet} />);
    await h.flush();
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...h!.container.querySelectorAll<HTMLElement>(sel)];
  const items = () => qa('[data-testid="needs-you-item"]');
  const btn = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(text)) as HTMLButtonElement | undefined;
  async function click(el: Element | undefined | null) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("empty: says nothing needs you and offers Fleet; no items", async () => {
    await open(data(), { tasks: tasks(3) });
    expect(q('[data-testid="needs-you-empty"]')?.textContent).toContain("Nothing needs you");
    expect(items()).toHaveLength(0);
    await click(btn(q('[data-testid="needs-you-empty"]')!, "Open Fleet"));
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="needs-you-ended-note"]')?.textContent).toContain("3 tasks ended today");
  });

  it("items sit under their project headings; decisions come before open questions", async () => {
    await open(data({ questions: [tq()], changes: [change()], changeProjects: { chg1: "mantaui" }, reviews: [review()] }));
    expect(qa('[data-testid="needs-you-project"] h2').map((h2) => h2.textContent)).toEqual(["MantaUI", "Capo", "Ethernal"]);
    expect(items().map((i) => [i.dataset.kind, i.dataset.urgency])).toEqual([["change", "decision"], ["review", "decision"], ["question", "question"]]);
  });

  it("a decision is labelled 'Waiting on you' on its own line above the title; a question 'Open question · keeps working'", async () => {
    await open(data({ questions: [tq()], changes: [change()], changeProjects: { chg1: "mantaui" } }));
    const [c, qn] = items();
    const lab = (el: HTMLElement) => el.querySelector('[data-testid="needs-you-label"]')!;
    expect(lab(c).textContent).toContain("Waiting on you");
    expect(lab(qn).textContent).toContain("Open question · keeps working");
    expect(c.className).toContain("border-l-danger");
    expect(qn.className).toContain("border-l-accent");
    // the label comes before the title in document order
    const title = c.querySelector("h3")!;
    expect(lab(c).compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.textContent).toBe("Approve the change to Product Designer?");
    expect(c.textContent).toContain("10h ago");
  });

  it("a change: 'Manta recommends …', Apply and Discard only — no 'Let Manta decide', no 'Review branch'", async () => {
    await open(data({ changes: [change()], changeProjects: { chg1: "mantaui" } }));
    const it0 = items()[0];
    expect(it0.textContent).toContain("Manta recommends approving it.");
    const labels = [...it0.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(labels.filter((l) => /^(Apply|Discard)$/.test(l))).toEqual(["Apply", "Discard"]);
    expect(h!.container.textContent).not.toMatch(/Let Manta decide|Let it guess|Didn.t need me|Review branch|Branch ready/i);
  });

  it("a question: the recommended option is selected, Submit, and the line about what happens if no one answers", async () => {
    await open(data({ questions: [tq()] }));
    const it0 = items()[0];
    const radios = [...it0.querySelectorAll<HTMLInputElement>("input[type='radio']")];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(it0.textContent).toContain("If no one answers, Dev goes with the recommended option, so it’s fine to ignore this.");
    expect(btn(it0, "Submit")).toBeTruthy();
  });

  it("a question with no recommended option does not claim one", async () => {
    await open(data({ questions: [tq({ questions: [{ question: "Which?", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiple: false }] })] }));
    expect(items()[0].textContent).not.toContain("If no one answers");
  });

  it("Submit answers through the agents channel, awaited, says the answer was sent and asks for a fresh read", async () => {
    await open(data({ questions: [tq()] }), {}, { agentsQuestionAnswer: () => Promise.resolve({}) });
    await click(btn(items()[0], "Submit"));
    expect(api.calls.agentsQuestionAnswer).toEqual([[{ id: "tq_1", answers: [["Rebuild it (Recommended)"]] }]]);
    expect(reload).toHaveBeenCalled();
    const done = q('[data-testid="needs-you-done"]')!;
    expect(done.getAttribute("role")).toBe("status");
    expect(done.textContent).toContain("Answer sent to Dev");
    expect(done.textContent).toContain("Rebuild it");
  });

  it("a failed send keeps the choice and says Submit again, with the box's sentence", async () => {
    await open(data({ questions: [tq()] }), {}, { agentsQuestionAnswer: () => Promise.reject(new Error("This task is paused; resume it first, then answer.")) });
    const radios = () => [...items()[0].querySelectorAll<HTMLInputElement>("input[type='radio']")];
    await click(radios()[1]);
    await click(btn(items()[0], "Submit"));
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toContain("This task is paused; resume it first, then answer.");
    expect(btn(items()[0], "Submit again")).toBeTruthy();
    expect(radios().map((r) => r.checked)).toEqual([false, true]);
    expect(q('[data-testid="needs-you-done"]')).toBeNull();
  });

  it("Dismiss goes to the dismiss channel; a refusal is shown", async () => {
    await open(data({ questions: [tq()] }), {}, { agentsQuestionDismiss: () => Promise.reject(new Error("That question no longer exists.")) });
    await click(btn(items()[0], "Dismiss"));
    expect(api.calls.agentsQuestionDismiss).toEqual([[{ id: "tq_1" }]]);
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toContain("That question no longer exists.");
  });

  it("a question's own last refusal (the box's record) is shown too", async () => {
    await open(data({ questions: [tq({ error: "The task couldn't take your answer." })] }));
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toContain("The task couldn't take your answer.");
  });

  it("Apply keeps the change's card, in its new state (Undo is the card's own), and asks for a fresh read", async () => {
    const applied = change({ state: "applied", decidedAt: NOW, decidedBy: "click" });
    await open(data({ changes: [change()], changeProjects: { chg1: "mantaui" } }), {}, { agentsChangeApply: () => Promise.resolve(applied) });
    await click(btn(items()[0], "Apply"));
    expect(api.calls.agentsChangeApply).toEqual([["chg1"]]);
    expect(reload).toHaveBeenCalled();
    expect(items()[0].querySelector('[data-testid="agent-change-card"]')?.getAttribute("data-state")).toBe("applied");
    // it stays after the next read no longer lists it
    h!.rerender(<NeedsYouPage needs={read(data({ changeProjects: {} }))} tasks={read(tasks())} onOpenFleet={onOpenFleet} />);
    expect(items()).toHaveLength(1);
  });

  it("a failed Apply keeps the card pending and the button says Apply again", async () => {
    await open(data({ changes: [change()], changeProjects: { chg1: "mantaui" } }), {}, { agentsChangeApply: () => Promise.reject(new Error("Product Designer was edited since this was suggested.")) });
    await click(btn(items()[0], "Apply"));
    expect(items()[0].textContent).toContain("Product Designer was edited since this was suggested.");
    expect(btn(items()[0], "Apply again")).toBeTruthy();
  });

  it("a task that ended on a decision shows its result card and Done; Done says so and asks for a fresh read", async () => {
    await open(data({ reviews: [review()] }), {}, { agentsReviewDone: () => Promise.resolve({ ok: true }) });
    const it0 = items()[0];
    expect(it0.querySelector("h3")?.textContent).toBe("Test transcript exports with real audio needs your decision");
    expect(it0.querySelector('[data-testid="background-result-card"]')).toBeTruthy();
    await click(btn(it0, "Done"));
    expect(api.calls.agentsReviewDone).toEqual([[{ jobId: "job9" }]]);
    expect(reload).toHaveBeenCalled();
    expect(q('[data-testid="needs-you-done"]')?.textContent).toContain("Marked as done");
  });

  it("a refused Done is shown and nothing is reloaded", async () => {
    await open(data({ reviews: [review()] }), {}, { agentsReviewDone: () => Promise.reject(new Error("Couldn't save")) });
    await click(btn(items()[0], "Done"));
    expect(items()[0].querySelector('[role="alert"]')?.textContent).toContain("Couldn't save");
    expect(reload).not.toHaveBeenCalled();
  });

  it("an unmerged branch is never an item: an older box's 'Branch ready to merge' review is dropped", async () => {
    await open(data({ reviews: [review({ jobId: "old", endedBlocked: false, reason: "Branch ready to merge · 3 files", name: "Old branch" })] }));
    expect(items()).toHaveLength(0);
    expect(q('[data-testid="needs-you-empty"]')).toBeTruthy();
  });

  it("Open session on a question or a change opens the task's session; a refusal is said", async () => {
    await open(data({ questions: [tq()] }), {}, { delegateOpenSession: () => Promise.resolve({ ok: false, error: "That task has no window any more" }) });
    await click(h!.container.querySelector('[aria-label="Open session: Upgrade the file tree"]'));
    expect(api.calls.delegateOpenSession).toEqual([[{ jobId: "job1" }]]);
    expect(q('[data-testid="needs-you-open-error"]')?.textContent).toContain("That task has no window any more");
  });

  it("box unreachable: a banner with the last update, and every control in the cards is disabled with the reason", async () => {
    resetStore({ connectionState: { state: "stalled", since: new Date(NOW) } } as never);
    const at = new Date(2026, 10, 28, 14, 2).getTime();
    await open(data({ questions: [tq()], changes: [change()], changeProjects: { chg1: "mantaui" } }), { needs: { updatedAt: at } });
    expect(q('[data-testid="needs-banner"]')?.textContent).toContain("14:02");
    const sets = qa("fieldset[disabled]");
    expect(sets.length).toBeGreaterThanOrEqual(2);
    expect(sets[0].title).toBe("Unavailable until the box is reachable");
    expect(btn(items()[0], "Apply")!.matches(":disabled")).toBe(true);
  });

  it("states: loading skeleton after 150 ms, a failed first read with Try again, a failed refresh keeping the items, an older box", async () => {
    await open(null, { needs: { loading: true } });
    expect(q('[data-testid="needs-skeleton"]')).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(q('[data-testid="needs-skeleton"]')).toBeTruthy();
    h!.unmount();
    await open(null, { needs: { error: "No answer", updatedAt: null } });
    expect(q('[data-testid="needs-banner"]')?.textContent).toContain("Couldn’t load Needs you.");
    await click(btn(q('[data-testid="needs-banner"]')!, "Try again"));
    expect(reload).toHaveBeenCalled();
    h!.unmount();
    await open(data({ questions: [tq()] }), { needs: { refreshError: "busy" } });
    expect(q('[data-testid="needs-banner"]')?.textContent).toContain("Couldn’t refresh Needs you.");
    expect(items()).toHaveLength(1);
    h!.unmount();
    await open(null, { needs: { unsupported: true } });
    expect(q('[data-testid="needs-unsupported"]')?.textContent).toContain("Update the box");
  });

  it("the header counts decisions and optional questions", async () => {
    await open(data({ questions: [tq()], changes: [change()], reviews: [review()], changeProjects: {} }));
    expect(q('[data-testid="needs-header-counts"]')?.textContent).toBe("2 decisions · 1 optional question");
  });
  // ---- a question asked in an agent's own conversation (agent chat tasks) ----

  const cq = (over: Record<string, unknown> = {}) => ({
    id: "form_1",
    slug: "dev",
    agentName: "Dev",
    sessionId: "ses_dev",
    question: "Which project is the flaky upload test in? MantaUI and Ronda both have one.",
    options: ["Ronda (Recommended)", "MantaUI"],
    askedAt: NOW - 3 * MIN,
    ...over,
  });

  it("a conversation question is a red 'Waiting on you' item under 'Team': the question as the title, who it is from, a sentence with its options, one Open conversation button", async () => {
    await open(data({ chatQuestions: [cq()], count: 1 }));
    expect(items()).toHaveLength(1);
    const it0 = items()[0];
    expect(it0.dataset.kind).toBe("chat-question");
    expect(it0.dataset.urgency).toBe("decision");
    expect(it0.className).toContain("border-l-danger");
    expect(it0.querySelector('[data-testid="needs-you-label"]')!.textContent).toContain("Waiting on you");
    expect(it0.querySelector("h3")!.textContent).toBe("Which project is the flaky upload test in? MantaUI and Ronda both have one.");
    expect(it0.textContent).toContain("Dev");
    expect(it0.textContent).toContain("in your conversation");
    expect(it0.textContent).toContain("Dev is waiting for your answer before it starts anything. Options: Ronda (recommended), MantaUI.");
    expect(it0.textContent).toContain("3m ago");
    expect(qa('[data-testid="needs-you-project"] h2').map((h2) => h2.textContent)).toEqual(["Team"]);
    expect([...it0.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim())).toEqual(["Open conversation"]);
    // it is not answered here: no question card
    expect(it0.querySelector("input[type='radio']")).toBeNull();
  });

  it("'Team' also holds agent changes; a project's items keep their own heading", async () => {
    await open(data({ chatQuestions: [cq()], changes: [change()], reviews: [review()], count: 3 }));
    expect(qa('[data-testid="needs-you-project"] h2').map((h2) => h2.textContent)).toEqual(["Team", "Capo"]);
  });

  it("Open conversation opens the agent's conversation and selects its window", async () => {
    const activate = vi.fn(() => Promise.resolve());
    resetStore({ jobs: {}, jobSkew: {}, connectionState: { state: "connected" }, refresh: () => Promise.resolve(), activateWindow: activate, projects: [{ tmuxSession: "manta-agents", windows: [{ index: 3 }] }] } as never);
    await open(data({ chatQuestions: [cq()], count: 1 }), {}, { agentsOpenChat: () => Promise.resolve({ tmuxSession: "manta-agents", windowIndex: 3 }) });
    await click(btn(items()[0], "Open conversation"));
    expect(api.calls.agentsOpenChat).toEqual([[{ slug: "dev" }]]);
    expect(activate).toHaveBeenCalledWith("manta-agents", 3);
    expect(q('[data-testid="needs-you-chat-open-error"]')).toBeNull();
  });

  it("if the conversation can't be opened, a role=alert line under the button says so — never silence", async () => {
    await open(data({ chatQuestions: [cq()], count: 1 }), {}, { agentsOpenChat: () => Promise.reject(new Error("opencode is not running")) });
    await click(btn(items()[0], "Open conversation"));
    const alert = q('[data-testid="needs-you-chat-open-error"]')!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("Couldn’t open Dev’s conversation; try again");
  });

  it("the header counts it as a decision", async () => {
    await open(data({ chatQuestions: [cq(), cq({ id: "form_2", slug: "pd", agentName: "Product Designer" })], count: 2 }));
    expect(q('[data-testid="needs-header-counts"]')!.textContent).toBe("2 decisions");
  });
});
