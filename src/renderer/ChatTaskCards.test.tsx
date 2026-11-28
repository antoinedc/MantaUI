// @vitest-environment jsdom
//
// The cards of a task an agent started from its OWN conversation (docs/superpowers/specs/2026-11-28-agent-chat-tasks.md §7 and
// docs/screens/agents/chat-tasks-decisions.md §1): the running and the result card are one variant of the existing cards (title in
// a heading, the project as a plain chip, Fleet's status words, branch or "read-only", the model once it exists, no quoted request),
// the "starting" card comes from the `agent_start_task` tool part, and a refused call is a quiet row in plain words.
// Rendered directly: the cards read the job store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { DelegateJob } from "../shared/types";
import { BackgroundResultCard, BackgroundRunCards, OpenQuestionsByJobContext } from "./BackgroundCards";
import type { BackgroundCard, BackgroundResultPart } from "./backgroundRun";
import { ToolCall } from "./ToolCall";
import { PendingApprovalContext } from "./ChatTaskCards";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { resetPackageAgentsForTest } from "./packageAgents";
import { resetExplorerStore, shownRightPanel } from "./explorer/explorerStore";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const RONDA = { slug: "ronda-0f9e8d7c6b", name: "Ronda" };
const TITLE = "Fix the flaky upload test";

const chatJob = (over: Record<string, unknown> = {}): DelegateJob =>
  ({
    id: "jc",
    name: "fix-the-flaky-upload",
    title: TITLE,
    prompt: "",
    model: null,
    parentSessionID: "ses_conv",
    parentDirectory: "/home/dev/projects/ronda",
    childSessionID: "ses_jc",
    tmuxSession: "manta-agents",
    windowIndex: 4,
    worktree: "/wt/x",
    branch: "agent/dev/fix-flaky-upload-test",
    isolation: "worktree",
    baseSha: null,
    status: "running",
    activity: null,
    createdAt: 1,
    agent: "agent-dev",
    agentName: "Dev",
    request: TITLE,
    startedFrom: "agent-chat",
    project: RONDA,
    ...over,
  }) as unknown as DelegateJob;

const runCard = (over: Record<string, unknown> = {}): BackgroundCard =>
  ({ kind: "running", key: "jc", jobId: "jc", name: TITLE, createdAt: 1, paused: false, agentName: "Dev", request: TITLE, ...over }) as BackgroundCard;

const view = (over: Record<string, unknown> = {}) => ({
  rev: { epoch: 1, n: 1 },
  asOf: T0,
  state: "working",
  headline: "Running the upload test 20 times",
  headlineSource: "model",
  steps: { done: 3, total: 7, current: "Run it", items: [{ text: "Run it", status: "current" }], source: "checklist", planRevision: 1, grewAt: null },
  bar: 3 / 7,
  live: null,
  startedAt: T0 - 4 * MIN,
  endedAt: null,
  lastProgressAt: T0 - MIN,
  ceilingAt: T0 + 4 * 60 * MIN,
  milestones: [],
  files: null,
  usage: null,
  model: null,
  ...over,
});

let h: Harness | null = null;
function show(j: DelegateJob | null, card: BackgroundCard = runCard(), questions: ReadonlyMap<string, number> | null = null) {
  resetStore({ jobs: j ? { ses_jc: j } : {}, jobSkew: {} });
  h = mount(
    <OpenQuestionsByJobContext.Provider value={questions}>
      <BackgroundRunCards cards={[card]} />
    </OpenQuestionsByJobContext.Provider>,
  );
  return h.container;
}
const q = <E extends HTMLElement = HTMLElement>(sel: string): E | null => h!.container.querySelector<E>(sel);
const text = (sel: string) => q(sel)?.textContent ?? null;

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setInterval", "clearInterval"] });
  installMockApi({ agentsList: () => Promise.resolve([]), agentsProjects: () => Promise.resolve([{ slug: RONDA.slug, name: "Ronda" }]) });
  resetPackageAgentsForTest();
  resetExplorerStore();
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  resetStore({ jobs: {}, jobSkew: {} });
});

describe("the running card of a task started from an agent's conversation", () => {
  it("is one RunCard variant: the title in a heading (never the slug), the project as plain text, Fleet's words, steps · elapsed, the branch", () => {
    show(chatJob({ view: view() }));
    const card = q('[data-testid="chat-task-card"]')!;
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-kind")).toBe("running");
    expect(card.getAttribute("data-job-id")).toBe("jc");
    const heading = q("h4")!;
    expect(heading.textContent).toBe(TITLE);
    expect(card.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(card.textContent).not.toContain("fix-the-flaky-upload");
    const chip = q('[data-testid="chat-task-project"]')!;
    expect(chip.textContent).toBe("Ronda");
    expect(chip.closest("a,button")).toBeNull();
    expect(text('[data-testid="chat-task-status"]')).toBe("In progress");
    expect(text('[data-testid="chat-task-steps"]')).toMatch(/^3\/7 · /);
    expect(text('[data-testid="chat-task-branch"]')).toBe("agent/dev/fix-flaky-upload-test");
    expect(text('[data-testid="chat-task-headline"]')).toBe("Running the upload test 20 times");
    expect(q('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("43");
  });

  it("does not quote the request (the title is the agent's own words) and is not the old card", () => {
    show(chatJob({ view: view() }));
    expect(q('[data-testid="background-request"]')).toBeNull();
    expect(q('[data-testid="background-card"]')).toBeNull();
  });

  it("a read-only task (isolation none, or no branch) says 'read-only' instead of a branch", () => {
    show(chatJob({ isolation: "none", branch: null, worktree: null, view: view() }));
    expect(text('[data-testid="chat-task-branch"]')).toBe("read-only");
  });

  it("the model appears only once the task carries one", () => {
    show(chatJob({ view: view() }));
    expect(q('[data-testid="chat-task-model"]')).toBeNull();
    h!.unmount();
    show(chatJob({ view: view(), model: "anthropic/claude-sonnet-5-5" }));
    expect(text('[data-testid="chat-task-model"]')).toBe("claude-sonnet-5-5");
    h!.unmount();
    show(chatJob({ view: view(), model: "anthropic/claude-sonnet-5-5", modelUsed: "openai/gpt-6-sol" }));
    expect(text('[data-testid="chat-task-model"]')).toBe("gpt-6-sol");
  });

  it("'Added @dev to Ronda' when the launch seated the agent; the open questions count in warn", () => {
    show(chatJob({ view: view(), seatAdded: { project: RONDA.slug, projectName: "Ronda" } }), runCard(), new Map([["jc", 1]]));
    expect(text('[data-testid="chat-task-seat"]')).toBe("Added @dev to Ronda");
    expect(text('[data-testid="chat-task-questions"]')).toBe("1 question");
    h!.unmount();
    show(chatJob({ view: view() }), runCard(), new Map([["jc", 2]]));
    expect(text('[data-testid="chat-task-questions"]')).toBe("2 questions");
    expect(q('[data-testid="chat-task-seat"]')).toBeNull();
  });

  it("each button is named after its task, because one conversation holds several cards", () => {
    show(chatJob({ view: view() }));
    expect(q('button[aria-label="Details: Fix the flaky upload test"]')).toBeTruthy();
    expect(q('button[aria-label="Open session: Fix the flaky upload test"]')).toBeTruthy();
  });

  it("Details opens the task's side panel in this conversation", () => {
    show(chatJob({ view: view() }));
    act(() => q<HTMLButtonElement>('button[aria-label^="Details:"]')!.click());
    expect(shownRightPanel("ses_conv")).toBe("task");
  });

  it("Open session is an action that reports: a refusal shows under the card", async () => {
    installMockApi({ delegateOpenSession: () => Promise.resolve({ ok: false, error: "That window is gone" }) });
    show(chatJob({ view: view() }));
    await act(async () => q<HTMLButtonElement>('button[aria-label^="Open session:"]')!.click());
    expect(text('[data-testid="background-open-error"]')).toMatch(/That window is gone/);
  });

  it("paused reads 'Paused by you' with a grey dot, not a spinner", () => {
    show(chatJob({ status: "paused", view: view({ state: "paused" }) }), runCard({ paused: true }));
    expect(text('[data-testid="chat-task-status"]')).toBe("Paused by you");
    expect(q('[data-testid="chat-task-spinner"]')).toBeNull();
    show(chatJob({ view: view() }));
    expect(q('[data-testid="chat-task-spinner"]')).toBeTruthy();
  });

  it("'couldn't confirm it started' keeps its words and offers Open session only", () => {
    show(chatJob({ launchState: "uncertain" }), { kind: "uncertain", key: "jc", jobId: "jc", name: TITLE, createdAt: 1 } as BackgroundCard);
    expect(text('[data-testid="chat-task-status"]')).toBe("Couldn’t confirm this started — open the session to check");
    expect(q('[data-kind="uncertain"]')).toBeTruthy();
  });

  it("a task that is NOT from an agent's conversation keeps the existing card", () => {
    show(chatJob({ startedFrom: undefined, project: undefined }), runCard({ request: "Fix it" }));
    expect(q('[data-testid="background-card"]')).toBeTruthy();
    expect(q('[data-testid="chat-task-card"]')).toBeNull();
  });
});

describe("the result card of a task started from an agent's conversation", () => {
  const part = (over: Record<string, unknown> = {}): BackgroundResultPart =>
    ({
      id: "m:bg",
      messageID: "m",
      sessionID: "ses_conv",
      type: "background-result",
      childSessionId: "ses_jc",
      jobId: "jc",
      state: "completed",
      name: TITLE,
      agent: "agent-dev",
      startedFrom: "agent-chat",
      project: RONDA,
      branch: "agent/dev/fix-flaky-upload-test",
      isolation: "worktree",
      text: '[background job "Fix the flaky upload test" done]\nProject: Ronda\n\nThe upload test shared one temp folder between runs. Each run now gets its own folder.',
      ...over,
    }) as BackgroundResultPart;
  const showResult = (p: BackgroundResultPart, j: DelegateJob | null = chatJob({ status: "done" })) => {
    resetStore({ jobs: j ? { ses_jc: j } : {}, jobSkew: {} });
    h = mount(<BackgroundResultCard part={p} />);
  };

  it("the same head: title heading, project chip, Done, branch; the result without the server's header lines; Open session →", () => {
    showResult(part());
    expect(q('[data-testid="chat-task-card"]')!.getAttribute("data-kind")).toBe("ended");
    expect(q("h4")!.textContent).toBe(TITLE);
    expect(text('[data-testid="chat-task-project"]')).toBe("Ronda");
    expect(text('[data-testid="chat-task-status"]')).toBe("Done");
    expect(text('[data-testid="chat-task-branch"]')).toBe("agent/dev/fix-flaky-upload-test");
    const body = text('[data-testid="background-result-text"]')!;
    expect(body).toContain("The upload test shared one temp folder");
    expect(body).not.toMatch(/Project: Ronda|\[background job/);
    expect(q('button[aria-label="Open session: Fix the flaky upload test"]')!.textContent).toBe("Open session →");
    expect(q('button[aria-label="Details: Fix the flaky upload test"]')).toBeTruthy();
  });

  it("works without the job in the store (the result carries the project and branch itself)", () => {
    showResult(part(), null);
    expect(text('[data-testid="chat-task-project"]')).toBe("Ronda");
    expect(text('[data-testid="chat-task-branch"]')).toBe("agent/dev/fix-flaky-upload-test");
    expect(text('[data-testid="chat-task-status"]')).toBe("Done");
  });

  it("Fleet's words for how it ended: Needs a decision, Didn't finish, Stopped by you, Interrupted", () => {
    showResult(part({ endedBlocked: true }));
    expect(text('[data-testid="chat-task-status"]')).toBe("Needs a decision");
    h!.unmount();
    showResult(part({ state: "failed" }), chatJob({ status: "failed", error: "the tests would not start" }));
    expect(text('[data-testid="chat-task-status"]')).toBe("Didn’t finish");
    h!.unmount();
    showResult(part({ state: "stopped" }), chatJob({ status: "stopped", error: "stopped by user" }));
    expect(text('[data-testid="chat-task-status"]')).toBe("Stopped by you");
    h!.unmount();
    showResult(part({ state: "failed" }), chatJob({ status: "failed", error: "interrupted by upgrade" }));
    expect(text('[data-testid="chat-task-status"]')).toBe("Interrupted");
  });

  it("a read-only task's result says read-only; the model shows once the job carries it", () => {
    showResult(part({ isolation: "none", branch: undefined }), chatJob({ status: "done", isolation: "none", branch: null, model: "openai/gpt-6-sol" }));
    expect(text('[data-testid="chat-task-branch"]')).toBe("read-only");
    expect(text('[data-testid="chat-task-model"]')).toBe("gpt-6-sol");
  });

  it("another background result keeps the existing card", () => {
    showResult(part({ startedFrom: undefined, project: undefined }), chatJob({ status: "done", startedFrom: undefined }));
    expect(q('[data-testid="background-result-card"]')).toBeTruthy();
    expect(q('[data-testid="chat-task-card"]')).toBeNull();
  });
});

describe("the agent_start_task tool part", () => {
  const toolPart = (state: Record<string, unknown>, tool = "agent_start_task") => ({ id: "p1", type: "tool", tool, callID: "call_1", state }) as never;
  const showTool = (state: Record<string, unknown>, opts: { approval?: boolean; tool?: string } = {}) => {
    resetStore({ jobs: {} });
    h = mount(
      <PendingApprovalContext.Provider value={!!opts.approval}>
        <ToolCall part={toolPart(state, opts.tool)} verbose={false} />
      </PendingApprovalContext.Provider>,
    );
  };
  const input = { project: RONDA.slug, title: TITLE, brief: "Fix it." };

  it("while the call runs: the starting card — spinner, the agent's title, the project's name, 'Starting…', no Details or Open session", async () => {
    showTool({ status: "running", input });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const card = q('[data-testid="chat-task-card"]')!;
    expect(card.getAttribute("data-kind")).toBe("starting");
    expect(q("h4")!.textContent).toBe(TITLE);
    expect(text('[data-testid="chat-task-project"]')).toBe("Ronda");
    expect(text('[data-testid="chat-task-status"]')).toBe("Starting…");
    expect(q('[data-testid="chat-task-spinner"]')).toBeTruthy();
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("while the approval card waits: 'Waiting for your approval'", () => {
    showTool({ status: "pending", input }, { approval: true });
    expect(text('[data-testid="chat-task-status"]')).toBe("Waiting for your approval");
  });

  it("a project the list doesn't know yet is read from the id, never shown as an id", () => {
    showTool({ status: "running", input: { ...input, project: "billing-service-0a1b2c3d4e" } });
    expect(text('[data-testid="chat-task-project"]')).toBe("billing service");
  });

  it("a refused call is a quiet row: 'Not started · <title>' with the reason in plain words; the agent's own sentence is in the tooltip; there is no card", () => {
    showTool({ status: "completed", input, output: "Not started: No project with that id; call agent_projects and use an id from its list" });
    expect(q('[data-testid="chat-task-card"]')).toBeNull();
    const row = q('[data-testid="chat-task-refused"]')!;
    expect(row.textContent).toContain("Not started");
    expect(row.textContent).toContain(TITLE);
    expect(row.textContent).toContain("No project called “ronda” on this box");
    expect(row.textContent).not.toMatch(/agent_projects/);
    expect(row.getAttribute("title")).toMatch(/call agent_projects/);
    expect(row.getAttribute("role")).toBe("note");
  });

  it("a call that failed outright reads the same way", () => {
    showTool({ status: "error", input, error: "the box said no" });
    expect(text('[data-testid="chat-task-refused"]')).toContain("the box said no");
  });

  it("a call that started its task renders nothing of its own: the task's card takes over", () => {
    showTool({ status: "completed", input, output: 'Started "Fix the flaky upload test" in Ronda (task jc, branch x). Its result will arrive as a later message; tell the user in one line which project you picked and stop.' });
    expect(h!.container.textContent).toBe("");
  });

  it("agent_projects stays an ordinary tool row", () => {
    showTool({ status: "completed", input: {}, output: "Projects you can work in" }, { tool: "agent_projects" });
    expect(q('[data-testid="chat-task-card"]')).toBeNull();
    expect(h!.container.textContent).toContain("AgentProjects");
  });
});
