// @vitest-environment jsdom
//
// An agent's conversation inside the real <ChatPanel> (profile v5): it is the ordinary chat with what doesn't apply taken away —
// no branch chip, Explorer, fork, delete, plan mode, trust toggle or schedules / secrets / webhooks buttons — and the MODEL PICKER
// kept, starting on the agent's own model and free to be changed for this conversation. Clear conversation starts a new session for
// the agent through its own channel (the generic /clear would drop the agent).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { resetPackageAgentsForTest } from "./packageAgents";
import { resetAgentSessionsForTest } from "./useAgentChats";
import { emitStreamAndFlush, installDialogPolyfill, installMockApi, mount, resetStore, type Harness, type MockApi, type MockEventBus } from "./testHarness";
import { useStore } from "./store";

const DEV = { slug: "dev", name: "Dev", description: "Writes code.", isolation: "worktree", model: "openai/gpt-6-sol", color: null, builtIn: true, role: "specialist", useWhen: null, notFor: null, notice: null };
const MODELS = [
  { id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol", limit: { context: 200000, output: 8000 } },
  { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5", limit: { context: 200000, output: 8000 } },
];

describe("ChatPanel — an agent's conversation", () => {
  beforeAll(installDialogPolyfill);
  let h: Harness | null = null;
  let api: MockApi;
  let bus: MockEventBus;
  beforeEach(() => {
    resetPackageAgentsForTest();
    resetAgentSessionsForTest();
    localStorage.clear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });

  async function open(opts: { tmux?: string; session?: string; over?: Record<string, unknown> } = {}) {
    const tmux = opts.tmux ?? "manta-agents";
    const session = opts.session ?? "ses_dev";
    ({ api, bus } = installMockApi({
      agentsList: () => Promise.resolve([DEV]),
      agentsChats: () => Promise.resolve({ dev: "ses_dev" }),
      opencodeModels: () => Promise.resolve(MODELS),
      opencodeMessages: () => Promise.resolve([]),
      agentsClearChat: () => Promise.resolve({ sessionId: "ses_new", windowIndex: 0 }),
      opencodeClearSession: () => Promise.resolve({ newSessionId: "ses_generic", projects: [] }),
      ...opts.over,
    }));
    resetStore({ jobs: {}, jobSkew: {} } as never);
    act(() => {
      useStore.setState({ projects: [{ tmuxSession: tmux, defaultCwd: "/a/dev/home", attached: false, windows: [{ index: 0, name: "Dev", active: true, paneCurrentPath: "/a/dev/home", opencodeSessionId: session }] }] as never });
    });
    h = mount(<ChatPanel sessionId={session} tmuxSession={tmux} windowIndex={0} cwd="/a/dev/home" isActive projectName={tmux} winName="Dev" artifactsOpen={false} onToggleArtifacts={() => {}} />);
    await h.flush();
    await h.flush();
    await h.flush();
  }
  const labels = () => [...h!.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? "");
  /** The header menu's Clear conversation… and its confirmation. */
  async function clearFromMenu() {
    await act(async () => h!.container.querySelector<HTMLElement>('[aria-label="Session actions"]')!.click());
    await act(async () => byText("Clear conversation…")!.click());
    await act(async () => byText("Clear conversation")!.click());
    await h!.flush();
  }
  const byText = (text: string) => [...document.body.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find((b) => (b.textContent ?? "").trim() === text);

  it("the header reads Team / Dev and offers the profile", async () => {
    await open();
    expect(h!.container.textContent).toContain("Team / Dev");
    const events: Array<{ slug?: string }> = [];
    const on = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("manta-open-agent-profile", on);
    await act(async () => byText("Profile")!.click());
    window.removeEventListener("manta-open-agent-profile", on);
    expect(events).toEqual([{ slug: "dev" }]);
  });

  it("hides what doesn't apply: Explorer, plan chip, trust toggle, schedules / secrets / webhooks", async () => {
    await open();
    expect(labels()).not.toContain("Show file explorer");
    expect(h!.container.querySelector(".manta-plan-toggle")).toBeNull();
    expect(h!.container.textContent).not.toMatch(/Permissions on|Bypassing permissions/);
    for (const l of ["schedules", "secrets", "webhooks"]) expect(labels()).not.toContain(l);
  });

  it("keeps the model picker, the usage dial's place, attach and the composer", async () => {
    await open();
    expect(h!.container.querySelector(".manta-model-picker-btn")).toBeTruthy();
    expect(labels()).toContain("Attach files");
    expect(h!.container.querySelector("textarea")).toBeTruthy();
  });

  it("the picker starts on the agent's own model", async () => {
    await open();
    expect(h!.container.querySelector(".manta-model-picker-btn")!.textContent).toContain("GPT-6 Sol");
  });

  it("a plain session in a project keeps everything an agent's conversation hides", async () => {
    await open({ tmux: "proj", session: "ses_plain" });
    expect(h!.container.textContent).toContain("proj / Dev");
    expect(h!.container.textContent).toMatch(/Permissions on|Bypassing permissions/);
    expect(labels()).toEqual(expect.arrayContaining(["schedules", "secrets", "webhooks"]));
  });

  it("a window of the agents' tmux session that is not an agent's chat is an ordinary session", async () => {
    await open({ session: "ses_task", over: { agentsChats: () => Promise.resolve({ dev: "ses_dev" }) } });
    expect(h!.container.textContent).not.toContain("Team /");
  });

  it("Clear conversation starts a new session for the agent through its own channel, never the generic /clear", async () => {
    await open();
    await clearFromMenu();
    expect(api.calls.agentsClearChat).toEqual([[{ slug: "dev" }]]);
    expect(api.calls.opencodeClearSession).toBeUndefined();
  });

  it("a refused Clear says why in the panel", async () => {
    await open({ over: { agentsClearChat: () => Promise.reject(new Error("OpenCode didn't start a chat for this agent")) } });
    await clearFromMenu();
    expect(h!.container.textContent).toContain("OpenCode didn't start a chat for this agent");
  });

  it("the profile button's event opens the agent's profile page in App", async () => {
    // the bridge itself lives in App (App.agents.test.tsx); here the event is what the button sends
    await open();
    const seen: string[] = [];
    const on = (e: Event) => seen.push(String((e as CustomEvent).detail.slug));
    window.addEventListener("manta-open-agent-profile", on);
    await act(async () => byText("Profile")!.click());
    window.removeEventListener("manta-open-agent-profile", on);
    expect(seen).toEqual(["dev"]);
  });
  // ---- Clear is refused while tasks started from this conversation run (agent chat tasks FR-012) ----

  const chatJob = (over: Record<string, unknown> = {}) => ({ id: "jc", name: "fix-it", title: "Fix the flaky upload test", parentSessionID: "ses_dev", status: "running", startedFrom: "agent-chat", project: { slug: "ronda-0f9e8d7c6b", name: "Ronda" }, createdAt: 1, agent: "agent-dev", ...over });
  const alertText = () => document.body.querySelector('[role="alert"]')?.textContent ?? null;
  async function openClear() {
    await act(async () => h!.container.querySelector<HTMLElement>('[aria-label="Session actions"]')!.click());
    await act(async () => byText("Clear conversation…")!.click());
  }

  it("a task running from this conversation: the dialog opens already refused, lists it, and nothing is cleared", async () => {
    await open();
    act(() => useStore.setState({ jobs: { ses_jc: chatJob() } as never }));
    await openClear();
    expect(alertText()).toBe("Dev has 1 task running from this conversation; wait for it or stop it first.");
    expect(document.body.textContent).toContain("Fix the flaky upload test · Ronda · In progress");
    expect(byText("Clear conversation")).toBeUndefined();
    expect(api.calls.agentsClearChat).toBeUndefined();
  });

  it("a start still waiting (the agent_start_task call is running) counts too: 'Starting…'", async () => {
    await open({
      over: {
        opencodeMessages: () =>
          Promise.resolve([
            { info: { id: "m1", role: "assistant", sessionID: "ses_dev", time: { created: 1 } }, parts: [{ id: "p1", type: "tool", tool: "agent_start_task", callID: "c1", state: { status: "running", input: { project: "ronda-0f9e8d7c6b", title: "Fix the billing page totals", brief: "b" } } }] },
          ]),
      },
    });
    await h!.flush();
    await emitStreamAndFlush(bus, h!, { sub: "running", sessionId: "ses_dev", payload: { running: true } }); // the agent is mid-turn: its call is live
    await openClear();
    expect(alertText()).toBe("Dev has 1 task running from this conversation; wait for it or stop it first.");
    expect(document.body.textContent).toContain("Fix the billing page totals");
    expect(document.body.textContent).toContain("Starting…");
  });

  it("a refusal from the box after the press (a task started in between): the same refused dialog with the box's sentence, not a stray banner; Close forgets it", async () => {
    await open({ over: { agentsClearChat: () => Promise.reject(new Error("Dev has 2 tasks running from this conversation; wait for them or stop them first")) } });
    await clearFromMenu();
    expect(alertText()).toBe("Dev has 2 tasks running from this conversation; wait for them or stop them first.");
    expect(byText("Close")).toBeTruthy();
    expect(byText("Open Fleet")).toBeTruthy();
    // the box's sentence is in the dialog only: no stray banner in the panel itself
    const panel = h!.container.cloneNode(true) as HTMLElement;
    panel.querySelectorAll("dialog").forEach((d) => d.remove());
    expect(panel.textContent).not.toContain("running from this conversation");
    await act(async () => byText("Close")!.click());
    await h!.flush();
    await openClear();
    await h!.flush();
    expect(alertText()).toBeNull();
    expect(byText("Clear conversation")).toBeTruthy();
  });

  it("Open Fleet from the refused dialog asks the app to open the Fleet page", async () => {
    await open();
    act(() => useStore.setState({ jobs: { ses_jc: chatJob() } as never }));
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("manta-open-agents-page", on);
    await openClear();
    await act(async () => byText("Open Fleet")!.click());
    window.removeEventListener("manta-open-agents-page", on);
    expect(seen).toEqual([{ page: "fleet" }]);
  });
});
