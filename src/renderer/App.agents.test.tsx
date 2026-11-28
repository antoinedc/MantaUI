// @vitest-environment jsdom
//
// App-level wiring of the agent pages (agent screens spec §1.1, §2.5): the sidebar's Needs you / Fleet / agent rows open the
// Fleet page and a profile in the main pane, one full-pane view at a time (like CTO and Routines), selecting a session or
// starting a chat closes them, and the task side panel mounts beside the chat pane when it owns the right slot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import { resetPackageAgentsForTest } from "./packageAgents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();

// The panes are stubs: this file is about how App routes to them.
vi.mock("./ChatPanel", () => ({ ChatPanel: (p: { sessionId: string }) => <div data-testid={`chat-${p.sessionId}`} /> }));
vi.mock("./Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("./CtoPanel", () => ({ CtoPanel: () => <div data-testid="cto" /> }));
vi.mock("./RoutinesRoot", () => ({ RoutinesRoot: () => <div data-testid="routines" /> }));
vi.mock("./ArtifactsPanel", () => ({ ArtifactsPanel: () => <aside data-testid="artifacts" /> }));
vi.mock("./TaskSidePanel", () => ({ TaskSidePanel: (p: { sessionId: string }) => <aside data-testid="task-panel" data-session={p.sessionId} /> }));
vi.mock("./agents/AgentsRoot", () => ({
  AgentsRoot: (p: { view: { page: string; slug?: string }; setView: (v: unknown) => void; needs: { data: { count: number } | null }; tasks: { data: { running: unknown[] } | null } }) => (
    <div data-testid="agents-root" data-page={p.view.page} data-slug={p.view.slug ?? ""} data-needs={String(p.needs.data?.count ?? "none")} data-tasks={String(p.tasks.data?.running.length ?? "none")}>
      <button type="button" data-testid="open-profile" onClick={() => p.setView({ page: "profile", slug: "seo" })} />
    </div>
  ),
}));

const { App } = await import("./App");
const explorerStore = await import("./explorer/explorerStore");

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";
const DEV = { slug: "dev", name: "Dev", description: "Writes code", isolation: "worktree", model: null, color: null, builtIn: true, role: "specialist", useWhen: null, notFor: null, notice: null };

const PROJECTS = [
  {
    tmuxSession: "p",
    defaultCwd: "/home/u/proj",
    attached: false,
    windows: [
      { index: 0, name: "w0", active: true, paneCurrentPath: "/home/u/proj", opencodeSessionId: "ses_a" },
      { index: 1, name: "w1", active: false, paneCurrentPath: "/home/u/proj", opencodeSessionId: "ses_b" },
    ],
  },
];

let h: Harness | null = null;
const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
const agentsRoot = () => q('[data-testid="agents-root"]');

function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function mountApp(overrides: Record<string, unknown> = {}) {
  installMockApi({
    agentsList: () => Promise.resolve([DEV]),
    agentsNeedsYou: () => Promise.resolve({ questions: [], changes: [{ id: "c1" }, { id: "c2" }], reviews: [{ jobId: "r1", endedBlocked: true }, { jobId: "old", endedBlocked: false }], count: 5 }),
    agentsTasks: () => Promise.resolve({ asOf: 1, running: [{ jobId: "a", status: "in-progress" }, { jobId: "b", status: "in-progress" }, { jobId: "c", status: "paused-by-you" }], ended: [], cap: 10, full: false }),
    ...overrides,
  });
  resetPackageAgentsForTest();
  act(() => {
    useStore.setState({
      loaded: true,
      onboardingForced: false,
      serverUrl: `https://${VALID_BOX}.boxes.mantaui.com`,
      boxId: VALID_BOX,
      boxToken: VALID_BOX,
      projects: PROJECTS as never,
      activeProjectName: "p",
      activeWindowByProject: { p: 0 },
      status: {},
      liveRunning: {},
      drafts: [],
      activeDraftId: null,
    });
  });
  h = mount(<App />);
  await h.flush();
  await h.flush();
}

beforeEach(() => {
  localStorage.clear();
  explorerStore.resetExplorerStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__mantaPreload = null;
  resetStore();
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

describe("agent pages in the main pane", () => {
  it("nothing is open until a sidebar row is pressed; Needs you shows decisions only (a branch review from an older box is not one), Fleet the tasks in progress", async () => {
    await mountApp();
    expect(agentsRoot()).toBeNull();
    expect(q('[data-testid="agents-nav-needs"] [data-testid="agents-needs-badge"]')?.textContent).toBe("3"); // 2 changes + 1 decision review
    expect(q('[data-testid="agents-nav-fleet"] [data-testid="agents-fleet-count"]')?.textContent).toBe("2"); // the paused one is not in progress
  });

  it("only open questions: a blue dot, no number", async () => {
    await mountApp({ agentsNeedsYou: () => Promise.resolve({ questions: [{ id: "q" }], changes: [], reviews: [], count: 1 }) });
    expect(q('[data-testid="agents-needs-badge"]')).toBeNull();
    expect(q('[data-testid="agents-needs-dot"]')).toBeTruthy();
  });

  it("Needs you opens its own page, handing it the same read the badge shows", async () => {
    await mountApp();
    click(q('[data-testid="agents-nav-needs"]'));
    expect(agentsRoot()?.dataset.page).toBe("needs");
    expect(agentsRoot()?.dataset.needs).toBe("5");
    expect(q('[data-testid="agents-nav-needs"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("Fleet opens the Fleet page, handing it the tasks read the sidebar's count comes from", async () => {
    await mountApp();
    click(q('[data-testid="agents-nav-fleet"]'));
    expect(agentsRoot()?.dataset.page).toBe("fleet");
    expect(agentsRoot()?.dataset.tasks).toBe("3");
    expect(q('[data-testid="agents-nav-fleet"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("an agent row opens its profile (no chat window is opened), and the page can move on to another profile", async () => {
    await mountApp({ agentsOpenChat: () => Promise.reject(new Error("must not be called")) });
    click(q('[data-testid="agent-row"][data-slug="dev"]'));
    expect(agentsRoot()?.dataset.page).toBe("profile");
    expect(agentsRoot()?.dataset.slug).toBe("dev");
    expect(q('[data-testid="agent-row"][data-slug="dev"]')?.getAttribute("aria-current")).toBe("page");
    click(q('[data-testid="open-profile"]'));
    expect(agentsRoot()?.dataset.slug).toBe("seo");
  });

  it("the agent conversation's Profile button (a window event) opens that agent's profile", async () => {
    await mountApp();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("manta-open-agent-profile", { detail: { slug: "dev" } }));
    });
    expect(agentsRoot()?.dataset.page).toBe("profile");
    expect(agentsRoot()?.dataset.slug).toBe("dev");
  });

  it("the chat pane steps aside while an agent page is open", async () => {
    await mountApp();
    // PanelShell hides a pane with display:none on its own wrapper
    const display = () => {
      let el: HTMLElement | null = q('[data-testid="chat-ses_a"]');
      while (el && !(el.classList.contains("absolute") && el.classList.contains("inset-0") && el.style.display)) el = el.parentElement;
      return el?.style.display;
    };
    expect(display()).toBe("block");
    click(q('[data-testid="agents-nav-fleet"]'));
    expect(display()).toBe("none");
  });

  it("selecting a session closes the page", async () => {
    await mountApp();
    click(q('[data-testid="agents-nav-fleet"]'));
    expect(agentsRoot()).not.toBeNull();
    act(() => useStore.getState().setActive("p", 1));
    expect(agentsRoot()).toBeNull();
  });

  it("New agent opens a chat draft and closes the page", async () => {
    await mountApp();
    click(q('[data-testid="agents-nav-fleet"]'));
    const button = [...h!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New agent");
    click(button!);
    expect(agentsRoot()).toBeNull();
    expect(useStore.getState().drafts.at(-1)?.input).toBe("Create an agent that ");
  });

  it("one full-pane view at a time: Routines and the CTO close an open agent page", async () => {
    await mountApp();
    click(q('[data-testid="agents-nav-fleet"]'));
    click(q("button.manta-routines-nav"));
    expect(agentsRoot()).toBeNull();
    expect(q('[data-testid="routines"]')).not.toBeNull();
    click(q('[data-testid="agents-nav-fleet"]'));
    expect(agentsRoot()).not.toBeNull();
    expect(q('[data-testid="routines"]')).toBeNull();
  });

  it("an older box with no needs-you or tasks channel shows no badge or count and the rows still open the pages", async () => {
    await mountApp({ agentsNeedsYou: () => Promise.reject(new Error("unknown rpc channel: agents:needs-you")), agentsTasks: () => Promise.reject(new Error("unknown rpc channel: agents:tasks")) });
    expect(q('[data-testid="agents-needs-badge"]')).toBeNull();
    expect(q('[data-testid="agents-fleet-count"]')).toBeNull();
    click(q('[data-testid="agents-nav-needs"]'));
    expect(agentsRoot()?.dataset.needs).toBe("none");
    expect(agentsRoot()?.dataset.tasks).toBe("none");
  });
});

describe("the task side panel", () => {
  it("mounts beside the chat pane when it owns the right slot, and not otherwise", async () => {
    await mountApp();
    expect(q('[data-testid="task-panel"]')).toBeNull();
    act(() => explorerStore.openTaskPanel("ses_a", "job1"));
    expect(q('[data-testid="task-panel"]')?.dataset.session).toBe("ses_a");
    click(q('[data-testid="agents-nav-fleet"]'));
    expect(q('[data-testid="task-panel"]')).toBeNull();
  });
});

