// @vitest-environment jsdom
//
// The Fleet page (docs/superpowers/specs/2026-11-28-fleet-redesign.md, mockup v10): Projects / Agents rows with the statuses the
// box records, the top card for decisions, Ended today, Details with Stop (behind a native dialog) and Resume, and every state —
// loading, load error, box unreachable, failed action, many items, an older box.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentInfo, DelegateJob, FleetEnded, FleetTask, FleetTasks, NeedsYou } from "../../shared/types";
import { refreshModelCatalog } from "../modelCatalog";
import { resetPackageAgentsForTest } from "../packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import type { AgentsRead } from "./useAgentsRead";
import { FleetPage } from "./FleetPage";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event("close"));
  };
  Element.prototype.scrollIntoView = () => {};
});

const agent = (slug: string, name: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name,
  description: `${name} agent`,
  isolation: "none",
  model: null,
  color: "#336699",
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const AGENTS = [agent("dev", "Dev"), agent("pd", "Product Designer")];

const task = (over: Partial<FleetTask> = {}): FleetTask => ({
  jobId: "j1",
  rootJobId: "j1",
  title: "Let Manta hand work to agents more than once per request",
  agentSlug: "dev",
  project: "mantaui",
  projectName: "mantaui",
  startedAt: NOW - 18 * MIN,
  branch: "agent/dev/handoff-limit",
  askedBy: { by: "manta", sessionId: "ses_chat" },
  status: "in-progress",
  pausedAt: null,
  ...over,
});
const ended = (over: Partial<FleetEnded> = {}): FleetEnded => ({
  jobId: "e1",
  rootJobId: "e1",
  title: "Give skill trials more disk space",
  agentSlug: "dev",
  project: "mantaui",
  projectName: "mantaui",
  startedAt: NOW - 2 * 3_600_000,
  branch: "agent/dev/trial-volume",
  askedBy: { by: "you" },
  endedAt: NOW - 40 * MIN,
  outcome: "done",
  sentence: "Its changes are in the project.",
  facts: "6 files changed · branch agent/dev/trial-volume (in the project)",
  ...over,
});

const tasksData = (over: Partial<FleetTasks> = {}): FleetTasks => ({
  asOf: NOW,
  running: [
    task(),
    task({ jobId: "j2", title: "Mock up a simpler agent profile page", agentSlug: "pd", askedBy: { by: "you" } }),
    task({ jobId: "j3", title: "Upgrade the file tree", project: "ethernal", projectName: "ethernal" }),
    task({ jobId: "j4", title: "Add speaker names to transcript exports", project: "capo", projectName: "capo", status: "paused-by-you", pausedAt: NOW - 3 * 3_600_000 }),
  ],
  ended: [ended(), ended({ jobId: "e2", title: "Write the release notes", outcome: "didnt-finish", sentence: "It ran out of time.", endedAt: NOW - 60 * MIN }), ended({ jobId: "e3", title: "Refresh the notes", outcome: "interrupted", sentence: "It was cut off when the box restarted.", agentSlug: "pd" }), ended({ jobId: "e4", title: "Stopped thing", outcome: "stopped", sentence: "You stopped it. What it had done so far is kept." })],
  cap: 10,
  full: false,
  ...over,
});

const read = <T,>(data: T | null, over: Partial<AgentsRead<T>> = {}): AgentsRead<T> => ({
  data,
  error: null,
  refreshError: null,
  updatedAt: NOW,
  unsupported: false,
  loading: false,
  reload: () => Promise.resolve(),
  ...over,
});
const needs = (over: Partial<NeedsYou> = {}): NeedsYou => ({ questions: [], changes: [], reviews: [], count: 0, ...over });

const storeJob = (over: Partial<DelegateJob> = {}): DelegateJob =>
  ({
    id: "j1",
    agent: "agent-dev",
    name: "x",
    status: "running",
    childSessionID: "ses_child1",
    parentSessionID: "ses_chat",
    view: {
      rev: { epoch: 1, n: 1 },
      asOf: NOW,
      state: "working",
      headline: "running the delegate tests",
      headlineSource: "checklist",
      steps: {
        done: 1,
        total: 3,
        current: "Remove the cap",
        items: [
          { text: "Find where the limit is enforced", status: "done" },
          { text: "Remove the cap", status: "current" },
          { text: "Run the tests", status: "pending" },
        ],
        source: "checklist",
        planRevision: 1,
        grewAt: null,
      },
      bar: 0.4,
      live: null,
      startedAt: NOW - 18 * MIN,
      endedAt: null,
      lastProgressAt: NOW,
      ceilingAt: null,
      milestones: [],
      files: null,
      usage: null,
      model: null,
    },
    ...over,
  }) as unknown as DelegateJob;

describe("FleetPage", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onOpenNeeds = vi.fn();
  const reload = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    localStorage.clear();
    resetStore({ usage: [], jobs: {}, jobSkew: {}, drafts: [], connectionState: { state: "connected" } } as never);
    resetPackageAgentsForTest();
    onOpenNeeds.mockClear();
    reload.mockClear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function open(props: { tasks?: AgentsRead<FleetTasks>; needs?: AgentsRead<NeedsYou> } = {}, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({
      agentsList: () => Promise.resolve(AGENTS),
      delegateOpenSession: () => Promise.resolve({ ok: true, tmuxSession: "manta", windowIndex: 2 }),
      delegateStop: () => Promise.resolve({ ok: true }),
      delegateResume: () => Promise.resolve({ ok: true }),
      ...overrides,
    }));
    h = mount(<FleetPage tasks={props.tasks ?? read(tasksData(), { reload })} needs={props.needs ?? read(needs())} onOpenNeeds={onOpenNeeds} />);
    await h.flush();
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...h!.container.querySelectorAll<HTMLElement>(sel)];
  const text = () => h!.container.textContent ?? "";
  const byLabel = (label: string) => h!.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const byText = (t: string) => [...h!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t);
  async function click(el: Element | null | undefined) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("Projects is the default: a group per project, rows with title, agent and status in columns, and no 'asked by' on a row", async () => {
    await open();
    expect(qa('[data-testid="fleet-group"]').map((g) => g.dataset.group)).toEqual(["mantaui", "ethernal", "capo"]);
    const row = q('[data-job="j1"]')!;
    expect(row.textContent).toContain("Let Manta hand work to agents more than once per request");
    expect(q('[data-job="j1"] [data-testid="fleet-task-who"]')?.textContent).toContain("Dev");
    expect(q('[data-job="j1"] [data-testid="fleet-task-who"] .truncate')?.textContent).toBe("Dev");
    expect(q('[data-job="j1"] [data-testid="fleet-task-status"]')?.textContent).toBe("In progress");
    expect(text()).not.toMatch(/asked by/i);
    // the group summary says what is in it
    expect(q('[data-group="capo"]')?.textContent).toContain("1 paused");
    expect(q('[data-group="mantaui"]')?.textContent).toContain("2 in progress");
  });

  it("the Agents view groups by agent and shows the project in the second column; the choice is remembered", async () => {
    await open();
    await click(byText("Agents"));
    expect(qa('[data-testid="fleet-group"]').map((g) => g.dataset.group)).toEqual(["dev", "pd"]);
    expect(q('[data-job="j1"] [data-testid="fleet-task-who"]')?.textContent).toBe("mantaui");
    expect(localStorage.getItem("manta:fleet:view")).toBe("agents");
    h!.unmount();
    await open();
    expect(qa('[data-testid="fleet-group"]').map((g) => g.dataset.group)).toEqual(["dev", "pd"]);
  });

  it("the Projects / Agents switch is outside the window's drag region, so a click on it reaches the app", async () => {
    // The header bar is a window drag region (`titlebar-drag`); Electron swallows clicks inside one, so every control in it
    // needs a `titlebar-no-drag` ancestor closer than the drag region. jsdom cannot show this: the click above passes anyway.
    await open();
    const header = q(".manta-agents-header")!;
    expect(header.className).toContain("titlebar-drag");
    for (const b of header.querySelectorAll<HTMLElement>("button")) {
      const owner = b.closest(".titlebar-no-drag, .titlebar-drag");
      expect(owner?.className, `${b.textContent} is in a drag region`).toContain("titlebar-no-drag");
    }
    expect(header.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
  });

  it("the header counts the work: n in progress · n paused", async () => {
    await open();
    expect(q('[data-testid="fleet-header-counts"]')?.textContent).toBe("3 in progress · 1 paused");
  });

  it("a paused task says Paused by you, how long ago, and offers Resume", async () => {
    await open();
    const st = q('[data-job="j4"] [data-testid="fleet-task-status"]')!;
    expect(st.textContent).toContain("Paused by you");
    expect(st.textContent).toContain("3h ago");
    expect(byLabel("Resume: Add speaker names to transcript exports")).toBeTruthy();
    expect(byLabel("Resume: Upgrade the file tree")).toBeNull();
  });

  it("Resume calls the box with the task, announces it and reads again", async () => {
    await open();
    await click(byLabel("Resume: Add speaker names to transcript exports"));
    expect(api.calls.delegateResume).toEqual([["j4"]]);
    expect(reload).toHaveBeenCalled();
    expect(q('[role="status"].sr-only')?.textContent).toContain("Resumed: Add speaker names to transcript exports");
  });

  it("a refused Resume says why under the row; nothing is silent", async () => {
    await open({}, { delegateResume: () => Promise.resolve({ ok: false, error: "too many jobs are running" }) });
    await click(byLabel("Resume: Add speaker names to transcript exports"));
    expect(q('[data-job="j4"] [data-testid="fleet-task-error"]')?.textContent).toContain("Couldn’t resume it. too many jobs are running");
    await open({}, { delegateResume: () => Promise.reject(new Error("The box didn't answer")) });
    await click(byLabel("Resume: Add speaker names to transcript exports"));
    expect(q('[data-job="j4"] [data-testid="fleet-task-error"]')?.textContent).toContain("The box didn't answer");
  });

  it("with the box full, Resume is disabled and its title says why", async () => {
    await open({ tasks: read(tasksData({ full: true, cap: 10 })) });
    const b = byLabel("Resume: Add speaker names to transcript exports")!;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe("Can’t resume yet: 10 tasks are already running. It can start when one finishes.");
  });

  it("top of Fleet: a card for decisions that block, with Review → to Needs you; optional questions are not mentioned", async () => {
    await open({ needs: read(needs({ changes: [{ id: "c1", slug: "pd", agentName: "Product Designer", kind: "update", state: "pending" } as never], questions: [{ id: "q", questions: [] } as never] })) });
    const card = q('[data-testid="fleet-needs-card"]')!;
    expect(card.textContent).toContain("1 decision is waiting for you");
    expect(card.textContent).toContain("Approve the change to Product Designer");
    expect(card.textContent).toContain("Review");
    expect(q('[data-testid="fleet-calm"]')).toBeNull();
    await click(card);
    expect(onOpenNeeds).toHaveBeenCalledTimes(1);
  });

  it("with nothing to decide, a calm line — also when only optional questions are open", async () => {
    await open();
    expect(q('[data-testid="fleet-calm"]')?.textContent).toBe("Nothing needs you right now.");
    h!.unmount();
    await open({ needs: read(needs({ questions: [{ id: "q", questions: [] } as never] })) });
    expect(q('[data-testid="fleet-calm"]')?.textContent).toBe("Nothing needs you right now.");
    expect(text()).not.toMatch(/question/i);
  });

  it("Ended today: title, agent · project · when, the sentence, the badge in the status column, Open session — and no New badge, no Undo", async () => {
    await open();
    const rows = qa('[data-testid="fleet-ended-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("Give skill trials more disk space");
    expect(rows[0].textContent).toContain("Dev");
    expect(rows[0].textContent).toContain("mantaui · 40m ago");
    expect(rows[0].textContent).toContain("Its changes are in the project.");
    expect(rows.map((r) => q(`[data-job="${r.dataset.job}"] [data-testid="fleet-ended-badge"]`)?.textContent)).toEqual(["Done", "Didn’t finish", "Interrupted", "Stopped by you"]);
    expect(byLabel("Open session: Give skill trials more disk space")).toBeTruthy();
    expect(text()).not.toMatch(/\bNew\b/);
    expect(text()).not.toMatch(/Undo|Earlier days|Should have asked/);
    expect(q('[data-testid="fleet-ended"]')?.textContent).toContain("4 tasks");
  });

  it("Ended today shows the first four and the rest behind a native <details> 'Show N more'", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ended({ jobId: `m${i}`, title: `Task ${i}` }));
    await open({ tasks: read(tasksData({ ended: many })) });
    const more = q('[data-testid="fleet-ended-more"]') as HTMLDetailsElement;
    expect(more.tagName).toBe("DETAILS");
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")?.textContent).toContain("Show 3 more");
    expect(qa('[data-testid="fleet-ended-row"]')).toHaveLength(7);
  });

  it("Open session opens the task's session; a refusal is said on the page", async () => {
    await open();
    await click(byLabel("Open session: Upgrade the file tree"));
    expect(api.calls.delegateOpenSession).toEqual([[{ jobId: "j3" }]]);
    h!.unmount();
    await open({}, { delegateOpenSession: () => Promise.resolve({ ok: false, error: "That task has no window any more" }) });
    await click(byLabel("Open session: Upgrade the file tree"));
    expect(q('[data-testid="fleet-open-error"]')?.textContent).toContain("That task has no window any more");
    expect(q('[data-testid="fleet-open-error"]')?.getAttribute("role")).toBe("alert");
  });

  it("Details: the technical record — who asked, now, started, branch, a live checklist — and Esc closes it", async () => {
    resetStore({ jobs: { ses_child1: storeJob() }, jobSkew: {}, connectionState: { state: "connected" }, projects: [{ tmuxSession: "m", defaultCwd: "/m", windows: [{ index: 0, name: "Limits cleanup", opencodeSessionId: "ses_chat" }] }] } as never);
    await open();
    await click(byLabel("Details: Let Manta hand work to agents more than once per request"));
    const d = q('[data-testid="fleet-details"]')!;
    expect(d.textContent).toContain("Manta in Limits cleanup");
    expect(d.textContent).toContain("running the delegate tests");
    expect(d.textContent).toContain("agent/dev/handoff-limit");
    expect(d.textContent).toContain("Checklist · 1 of 3 done");
    expect([...d.querySelectorAll("li")].map((li) => li.textContent?.replace(/ \((done|current step|to do)\)/, "").replace(/^✓/, ""))).toEqual(["Find where the limit is enforced", "Remove the cap", "Run the tests"]);
    expect(d.getAttribute("aria-labelledby")).toBe("fleet-details-title");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q('[data-testid="fleet-details"]')).toBeNull();
  });

  it("Details name the model the task ran on, in the catalog's words — a running task and an ended one; none recorded, no row", async () => {
    const models = [{ id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol" }];
    const data = tasksData({
      running: [task({ model: "openai/gpt-6-sol" }), task({ jobId: "j3", title: "Upgrade the file tree" })],
      ended: [ended({ model: "openai/gpt-6-sol" }), ended({ jobId: "e2", title: "Write the release notes" })],
    });
    await open({ tasks: read(data) }, { opencodeModels: () => Promise.resolve(models) });
    refreshModelCatalog();
    await h!.flush();
    await h!.flush();
    const modelRow = () => q('[data-testid="fleet-details"] [data-testid="fleet-details-model"]')?.textContent ?? null;
    await click(byLabel("Details: Let Manta hand work to agents more than once per request"));
    expect(modelRow()).toBe("GPT-6 Sol");
    await click(byLabel("Details: Upgrade the file tree"));
    expect(modelRow()).toBeNull();
    await click(byLabel("Details: Give skill trials more disk space"));
    expect(modelRow()).toBe("GPT-6 Sol");
    await click(byLabel("Details: Write the release notes"));
    expect(modelRow()).toBeNull();
  });

  it("Details without a checklist says the agent hasn't written one", async () => {
    await open();
    await click(byLabel("Details: Upgrade the file tree"));
    expect(q('[data-testid="fleet-details"]')?.textContent).toContain("hasn’t written its checklist yet");
  });

  it("an ended task's Details: its outcome, the sentence and the technical record", async () => {
    await open();
    await click(byLabel("Details: Write the release notes"));
    const d = q('[data-testid="fleet-details"]')!;
    expect(d.dataset.kind).toBe("ended");
    expect(d.textContent).toContain("Didn’t finish.");
    expect(d.textContent).toContain("It ran out of time.");
    expect(d.textContent).toContain("Technical record");
    expect(d.textContent).toContain("6 files changed");
  });

  it("Stop asks first, in a native dialog with 'Keep running' focused; keeping leaves the task alone", async () => {
    await open();
    await click(byLabel("Details: Upgrade the file tree"));
    await click(byText("Stop task"));
    const dlg = q("dialog")!;
    expect(dlg.hasAttribute("open")).toBe(true);
    expect(dlg.textContent).toContain("Upgrade the file tree");
    await click([...dlg.querySelectorAll("button")].find((b) => b.textContent === "Keep running"));
    expect(api.calls.delegateStop ?? []).toHaveLength(0);
    expect(dlg.hasAttribute("open")).toBe(false);
  });

  it("Stop task stops it, says so, reads again and closes Details; a failure keeps the task running and offers Try again", async () => {
    await open();
    await click(byLabel("Details: Upgrade the file tree"));
    await click(byText("Stop task"));
    await click([...q("dialog")!.querySelectorAll("button")].find((b) => b.textContent === "Stop task"));
    expect(api.calls.delegateStop).toEqual([["j3"]]);
    expect(reload).toHaveBeenCalled();
    expect(q('[role="status"].sr-only')?.textContent).toContain("Stopped: Upgrade the file tree");
    h!.unmount();

    await open({}, { delegateStop: () => Promise.resolve({ ok: false, error: "The box didn't answer" }) });
    await click(byLabel("Details: Upgrade the file tree"));
    await click(byText("Stop task"));
    await click([...q("dialog")!.querySelectorAll("button")].find((b) => b.textContent === "Stop task"));
    expect(q('[data-job="j3"] [data-testid="fleet-task-error"]')?.textContent).toContain("Couldn’t stop it. The box didn't answer");
    expect(q('[data-testid="fleet-details-error"]')?.textContent).toContain("The box didn't answer");
    expect(q('[data-job="j3"]')).toBeTruthy(); // still listed
    await click(byLabel("Try stopping again: Upgrade the file tree"));
    expect(q("dialog")!.hasAttribute("open")).toBe(true);
  });

  it("loading: nothing for 150 ms, then a skeleton", async () => {
    await open({ tasks: read<FleetTasks>(null, { loading: true }) });
    expect(q('[data-testid="fleet-skeleton"]')).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(q('[data-testid="fleet-skeleton"]')).toBeTruthy();
  });

  it("a first read that failed: a banner with the sentence and Try again, which reads again", async () => {
    await open({ tasks: read<FleetTasks>(null, { error: "The box is busy", updatedAt: null, reload }) });
    const b = q('[data-testid="fleet-banner"]')!;
    expect(b.textContent).toContain("Couldn’t load Fleet.");
    expect(b.textContent).toContain("The box is busy");
    await click(byText("Try again"));
    expect(reload).toHaveBeenCalled();
  });

  it("a refresh that failed keeps the earlier data under a banner that names the last update", async () => {
    const at = new Date(2026, 10, 28, 14, 2).getTime();
    await open({ tasks: read(tasksData(), { refreshError: "busy", updatedAt: at, reload }) });
    expect(q('[data-testid="fleet-banner"]')?.textContent).toContain("Couldn’t refresh Fleet.");
    expect(q('[data-testid="fleet-banner"]')?.textContent).toContain("14:02");
    expect(q('[data-testid="fleet-banner"]')?.getAttribute("role")).toBe("alert");
    expect(qa('[data-testid="fleet-task-row"]')).toHaveLength(4);
  });

  it("box unreachable: a banner with the last report time; every action is disabled with the reason; the data stays", async () => {
    resetStore({ connectionState: { state: "reconnecting", attempt: 2, backoffMs: 1000 } } as never);
    const at = new Date(2026, 10, 28, 14, 2).getTime();
    await open({ tasks: read(tasksData(), { updatedAt: at }) });
    const b = q('[data-testid="fleet-banner"]')!;
    expect(b.textContent).toContain("Can’t reach your box right now.");
    expect(b.textContent).toContain("14:02");
    expect(b.getAttribute("role")).toBe("status");
    for (const label of ["Open session: Upgrade the file tree", "Resume: Add speaker names to transcript exports"]) {
      expect(byLabel(label)!.disabled).toBe(true);
      expect(byLabel(label)!.title).toBe("Unavailable until the box is reachable");
    }
    expect(qa('[data-testid="fleet-task-row"]')).toHaveLength(4);
  });

  it("nothing in progress: an empty state that says what to do; Ended today still shows", async () => {
    await open({ tasks: read(tasksData({ running: [] })) });
    expect(q('[data-testid="fleet-empty"]')?.textContent).toContain("Nothing is being worked on");
    expect(q('[data-testid="fleet-calm"]')).toBeNull();
    expect(qa('[data-testid="fleet-ended-row"]')).toHaveLength(4);
  });

  it("an older box (no such channel) is told to update, not shown an error", async () => {
    await open({ tasks: read<FleetTasks>(null, { unsupported: true }) });
    expect(q('[data-testid="fleet-unsupported"]')?.textContent).toContain("Update the box to see the fleet");
  });

  it("the page's rows sit in a container the columns respond to, not the window", async () => {
    await open();
    const col = q('[data-testid="fleet-column"]')!;
    expect(col.className).toContain("[container-type:inline-size]");
    expect(q('[data-job="j1"]')!.className).toContain("@container(min-width:560px)");
    expect(q('[data-job="j1"]')!.className).toContain("@container(min-width:850px)");
  });

  describe("rows are sessions (spec §5b)", () => {
    const chat = (over: Partial<FleetTask> = {}): FleetTask => ({
      jobId: "",
      rootJobId: "",
      key: "ses_chat",
      kind: "chat",
      sessionId: "ses_chat",
      window: { tmuxSession: "manta", index: 3 },
      title: "Fleet: one row per session",
      oneLiner: "Writing the failing tests for the one-liner",
      agentSlug: "manta",
      project: "mantaui",
      projectName: "mantaui",
      startedAt: NOW - 18 * MIN,
      branch: null,
      askedBy: { by: "you" },
      status: "in-progress",
      pausedAt: null,
      subs: [
        { key: "j1", title: "Build the Fleet fixes", status: "in-progress", jobId: "j1", agentSlug: "dev" },
        { key: "j9", title: "Review the wording", status: "paused-by-you", jobId: "j9", agentSlug: "pd" },
        { key: "ses_sub", title: "Find the pump code", status: "finished", jobId: null, agentSlug: null },
      ],
      ...over,
    });
    const data = () => tasksData({ running: [chat()], ended: [] });

    it("a row draws the session's title and the one-liner under it; the agent is Manta for a plain chat", async () => {
      await open({ tasks: read(data()) });
      const row = q('[data-row="ses_chat"]')!;
      expect(row.textContent).toContain("Fleet: one row per session");
      expect(q('[data-row="ses_chat"] [data-testid="fleet-task-line"]')?.textContent).toBe("Writing the failing tests for the one-liner");
      expect(q('[data-row="ses_chat"] [data-testid="fleet-task-who"]')?.textContent).toContain("Manta");
    });

    it("a row without a one-liner draws none", async () => {
      await open({ tasks: read(tasksData({ running: [chat({ oneLiner: "" })], ended: [] })) });
      expect(q('[data-testid="fleet-task-line"]')).toBeNull();
    });

    it("Details lists what runs beneath it as title + status — no Stop on a chat row, Resume on a paused job", async () => {
      await open({ tasks: read(data()) });
      await click(byLabel("Details: Fleet: one row per session"));
      const subs = qa('[data-testid="fleet-details-sub"]');
      expect(subs.map((s) => s.textContent)).toEqual([
        expect.stringContaining("Build the Fleet fixes"),
        expect.stringContaining("Review the wording"),
        expect.stringContaining("Find the pump code"),
      ]);
      expect(subs[0].textContent).toContain("In progress");
      expect(subs[1].textContent).toContain("Paused by you");
      expect(subs[2].textContent).toContain("Finished");
      expect([...q('[data-testid="fleet-details"]')!.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain("Stop task");
      await click(byLabel("Resume: Review the wording"));
      expect(api.calls.delegateResume).toEqual([["j9"]]);
    });

    it("Open session on a chat row selects its window; it never asks the box to open a job", async () => {
      const activate = vi.fn(() => Promise.resolve());
      const refresh = vi.fn(() => Promise.resolve());
      resetStore({ usage: [], jobs: {}, jobSkew: {}, drafts: [], connectionState: { state: "connected" }, activateWindow: activate, refresh } as never);
      await open({ tasks: read(data()) });
      await click(byLabel("Open session: Fleet: one row per session"));
      expect(activate).toHaveBeenCalledWith("manta", 3);
      expect(api.calls.delegateOpenSession ?? []).toEqual([]);
    });

    it("a chat row has no row-level Resume or Stop, even when paused (its paused jobs carry the Resume)", async () => {
      await open({ tasks: read(tasksData({ running: [chat({ status: "paused-by-you", pausedAt: NOW - 3_600_000 })], ended: [] })) });
      expect(byLabel("Resume: Fleet: one row per session")).toBeNull();
    });

    it("an Ended row is one per session: the session's title, and Details lists the jobs that ended in it", async () => {
      const e = ended({ jobId: "e1", key: "ses_chat", kind: "chat", sessionId: "ses_chat", window: { tmuxSession: "manta", index: 3 }, title: "Fleet: one row per session", subs: [{ key: "e1", title: "Fix the footer", status: "didnt-finish", jobId: "e1", agentSlug: "dev" }, { key: "e0", title: "Audit the pricing page", status: "finished", jobId: "e0", agentSlug: "dev" }] });
      await open({ tasks: read(tasksData({ running: [], ended: [e] })) });
      await click(byLabel("Details: Fleet: one row per session"));
      expect(qa('[data-testid="fleet-details-sub"]').map((s) => s.textContent)).toEqual([expect.stringContaining("Fix the footer"), expect.stringContaining("Audit the pricing page")]);
      expect(qa('[data-testid="fleet-details-sub"]')[0].textContent).toContain("Didn’t finish");
    });
  });
});
