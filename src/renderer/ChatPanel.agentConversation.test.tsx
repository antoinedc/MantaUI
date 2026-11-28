// @vitest-environment jsdom
//
// An agent's conversation inside the real <ChatPanel> (profile v5): it is the ordinary chat with what doesn't apply taken away —
// no branch chip, Explorer, fork, delete, plan mode, trust toggle or schedules / secrets / webhooks buttons — and the MODEL PICKER
// kept, starting on the agent's own model and free to be changed for this conversation. Clear conversation starts a new session for
// the agent through its own channel (the generic /clear would drop the agent).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { resetPackageAgentsForTest } from "./packageAgents";
import { resetAgentSessionsForTest } from "./useAgentChats";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";
import { useStore } from "./store";

const DEV = { slug: "dev", name: "Dev", description: "Writes code.", isolation: "worktree", model: "openai/gpt-6-sol", color: null, builtIn: true, role: "specialist", useWhen: null, notFor: null, notice: null };
const MODELS = [
  { id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol", limit: { context: 200000, output: 8000 } },
  { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5", limit: { context: 200000, output: 8000 } },
];

describe("ChatPanel — an agent's conversation", () => {
  let h: Harness | null = null;
  let api: MockApi;
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
    ({ api } = installMockApi({
      agentsList: () => Promise.resolve([DEV]),
      agentsChats: () => Promise.resolve({ dev: "ses_dev" }),
      opencodeModels: () => Promise.resolve(MODELS),
      opencodeMessages: () => Promise.resolve([]),
      agentsClearChat: () => Promise.resolve({ sessionId: "ses_new", windowIndex: 0 }),
      opencodeClearSession: () => Promise.resolve({ newSessionId: "ses_generic", projects: [] }),
      ...opts.over,
    }));
    resetStore();
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
});
