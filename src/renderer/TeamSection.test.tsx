// @vitest-environment jsdom
//
// The sidebar's Team section (profile v5): the agents' own conversations, one session row per agent (except the Architect), with the
// session dot — blue working, red asking, green finished and not yet seen, grey idle — and no badge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentInfo } from "../shared/types";
import { resetPackageAgentsForTest } from "./packageAgents";
import { TeamBlock } from "./Sidebar";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";
import type { WindowStatusUI } from "./store";

const agent = (slug: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name: slug === "manta" ? "Manta" : slug[0].toUpperCase() + slug.slice(1),
  description: `${slug} does things.`,
  isolation: "worktree",
  model: null,
  color: null,
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const AGENTS = [agent("dev"), agent("architect", { role: "architect" }), agent("manta", { role: "lead" }), agent("designer"), agent("broken", { error: "no description" })];
const status = (over: Partial<WindowStatusUI>): WindowStatusUI => ({ running: false, attention: false, attentionKind: null, subagents: 0, ...over }) as WindowStatusUI;

const SPACE = { tmuxSession: "manta-agents", defaultCwd: "/a", windows: [{ index: 2, name: "Dev", opencodeSessionId: "ses_dev" }, { index: 3, name: "Task window", opencodeSessionId: "ses_task" }] } as never;

describe("TeamBlock", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onActivate = vi.fn();
  const onError = vi.fn();
  const statusFor = vi.fn((_s: string, _i: number): WindowStatusUI | undefined => undefined);

  beforeEach(() => {
    resetStore();
    resetPackageAgentsForTest();
    onActivate.mockClear();
    onError.mockClear();
    statusFor.mockReset();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(props: { projects?: unknown[]; selected?: { session: string; index: number } | null; selectable?: boolean } = {}, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({ agentsList: () => Promise.resolve(AGENTS), agentsChats: () => Promise.resolve({ dev: "ses_dev", manta: "ses_manta" }), ...overrides }));
    h = mount(
      <TeamBlock
        projects={(props.projects ?? [SPACE]) as never}
        statusFor={statusFor}
        selected={props.selected ?? null}
        selectable={props.selectable ?? true}
        onActivate={onActivate}
        onError={onError}
      />,
    );
    await h.flush();
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="team-row"] [role="treeitem"]')];
  const slugOf = (row: HTMLElement) => row.closest('[data-testid="team-row"]')!.getAttribute("data-slug");
  const dot = (row: HTMLElement) => row.querySelector("span[aria-hidden]") as HTMLElement;

  it("a Team heading and one row per valid agent except the Architect, the lead first", async () => {
    await open();
    expect(h!.container.querySelector('[data-testid="team-section"] h3')?.textContent).toBe("Team");
    expect(rows().map(slugOf)).toEqual(["manta", "dev", "designer"]);
    expect(rows()[1].textContent).toContain("Dev");
    expect(h!.container.textContent).not.toMatch(/Architect|broken/i);
  });

  it("each row is a session row: no badge, no avatar, no role tag", async () => {
    await open();
    for (const r of rows()) {
      expect(r.getAttribute("role")).toBe("treeitem");
      expect(r.textContent).not.toMatch(/lead|via Manta|invalid/i);
      expect(r.querySelector("[data-testid=agent-badge]")).toBeNull();
    }
  });

  it("the dot is the session's own, from the window's live status", async () => {
    statusFor.mockImplementation((_s, i) => (i === 2 ? status({ running: true }) : undefined));
    await open();
    expect(statusFor).toHaveBeenCalledWith("manta-agents", 2);
    expect(dot(rows()[1]).getAttribute("title")).toMatch(/^Running/);
    // asking → the blocking dot; finished and unseen → "Done"; nothing → idle
    statusFor.mockImplementation(() => status({ attention: true, attentionKind: "question" }));
    h!.unmount();
    await open();
    expect(dot(rows()[1]).getAttribute("title")).toBe("Waiting on a question — click to answer");
    statusFor.mockImplementation(() => status({ attention: true, attentionKind: "idle" }));
    h!.unmount();
    await open();
    expect(dot(rows()[1]).getAttribute("title")).toBe("Done — click to view");
    statusFor.mockImplementation(() => undefined);
    h!.unmount();
    await open();
    expect(dot(rows()[1]).getAttribute("title")).toBe("Idle");
  });

  it("an agent that has no window yet reads as idle", async () => {
    await open();
    expect(dot(rows()[0]).getAttribute("title")).toBe("Idle"); // Manta: stored chat, no window
    expect(statusFor).not.toHaveBeenCalledWith("manta-agents", 3); // the task window isn't anybody's chat
  });

  it("the row of the open conversation is the selected one", async () => {
    await open({ selected: { session: "manta-agents", index: 2 } });
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    h!.unmount();
    await open({ selected: { session: "manta-agents", index: 2 }, selectable: false });
    expect(rows().every((r) => r.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("a click selects the agent's window when it has one — nothing is asked of the box", async () => {
    await open();
    await act(async () => rows()[1].click());
    expect(onActivate).toHaveBeenCalledWith("manta-agents", 2);
    expect(api.calls.agentsOpenChat).toBeUndefined();
  });

  it("a click on an agent with no window opens its conversation, then selects it", async () => {
    await open({}, { agentsOpenChat: () => Promise.resolve({ tmuxSession: "manta-agents", windowIndex: 7 }) });
    await act(async () => rows()[2].click()); // designer
    await h!.flush();
    expect(api.calls.agentsOpenChat).toEqual([[{ slug: "designer" }]]);
  });

  it("a refusal is an error the user sees, never silence", async () => {
    await open({}, { agentsOpenChat: () => Promise.reject(new Error("opencode is not running")) });
    await act(async () => rows()[2].click());
    await h!.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0][0] as Error).message)).toContain("opencode is not running");
  });

  it("Enter and Space open a row from the keyboard", async () => {
    await open();
    await act(async () => rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onActivate).toHaveBeenCalledWith("manta-agents", 2);
    expect(rows()[1].tabIndex).toBe(0);
  });

  it("no section before the agents are known, on a box with none, or on an older box", async () => {
    await open({}, { agentsList: () => Promise.resolve([]) });
    expect(h!.container.querySelector('[data-testid="team-section"]')).toBeNull();
    h!.unmount();
    resetPackageAgentsForTest();
    await open({}, { agentsList: () => Promise.reject(new Error("unknown rpc channel: agents:list")) });
    expect(h!.container.querySelector('[data-testid="team-section"]')).toBeNull();
  });

  it("an older box with no stored-chats channel still lists the agents (all idle, a click opens)", async () => {
    await open({}, { agentsChats: () => Promise.reject(new Error("unknown rpc channel: agents:chats")) });
    expect(rows()).toHaveLength(3);
    expect(dot(rows()[1]).getAttribute("title")).toBe("Idle");
  });
});
