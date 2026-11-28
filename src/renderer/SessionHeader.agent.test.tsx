// @vitest-environment jsdom
//
// The session header of an AGENT's conversation (profile v5): "Team / Dev", no branch chip or Explorer, a Profile button, and a
// menu that holds only "Summarize earlier messages now" and "Clear conversation…" (with a confirmation that says what is kept).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockApi, mountSessionHeader, resetStore, sessionHeaderElement, type Harness } from "./testHarness";
import { useStore } from "./store";
import * as store from "./explorer/explorerStore";

let h: Harness | null = null;
beforeEach(() => {
  localStorage.clear();
  store.resetExplorerStore();
  installMockApi();
  resetStore();
  act(() => {
    useStore.setState({
      projects: [{ tmuxSession: "manta-agents", defaultCwd: "/a/dev/home", attached: false, windows: [{ index: 0, name: "Dev", active: true, paneCurrentPath: "/a/dev/home", opencodeSessionId: "ses_dev" }] }] as never,
    });
  });
});
afterEach(() => {
  h?.unmount();
  h = null;
  document.body.innerHTML = "";
});

const onOpenProfile = vi.fn();
const onCompact = vi.fn();
const onClear = vi.fn();
const onFork = vi.fn();
const onDelete = vi.fn();
const agent = { name: "Dev", onOpenProfile };
const mountAgent = (over: Record<string, unknown> = {}) =>
  (h = mountSessionHeader({
    sessionId: "ses_dev",
    branch: "main",
    breadcrumb: { project: "manta-agents", window: "Dev" },
    agentConversation: agent,
    artifactsOpen: false,
    onToggleArtifacts: () => {},
    onCompact,
    onClear,
    onFork,
    onDelete,
    ...over,
  } as never));
const labels = () => [...h!.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim());
const byText = (text: string) => [...document.body.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find((b) => (b.textContent ?? "").trim() === text);
async function openMenu() {
  await act(async () => h!.container.querySelector<HTMLElement>('[aria-label="Session actions"]')!.click());
}

describe("SessionHeader — an agent's conversation", () => {
  beforeEach(() => {
    [onOpenProfile, onCompact, onClear, onFork, onDelete].forEach((f) => f.mockClear());
  });

  it("names where you are as Team / <Name>, not the hidden workspace's name", () => {
    mountAgent();
    expect(h!.container.textContent).toContain("Team / Dev");
    expect(h!.container.textContent).not.toContain("manta-agents");
  });

  it("has no branch chip and no file explorer; keeps the Artifacts toggle", () => {
    mountAgent();
    expect(h!.container.textContent).not.toContain("main");
    expect(labels()).not.toContain("Show file explorer");
    expect(labels()).toContain("Show artifacts");
  });

  it("keeps the context pill", () => {
    mountAgent({ ctxBreakdown: { freshInput: 100, cacheRead: 200, cacheWrite: 50, totalInput: 350, pct: 38, hasLimit: true, segments: [] }, ctxLimit: 1000 });
    expect(h!.container.querySelector(".manta-ctx-pill")).toBeTruthy();
  });

  it("a Profile button is the way back to the agent's profile", async () => {
    mountAgent();
    const profile = [...h!.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Profile")!;
    expect(profile).toBeTruthy();
    await act(async () => profile.click());
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
  });

  it("the menu holds only 'Summarize earlier messages now' and 'Clear conversation…'", async () => {
    mountAgent();
    await openMenu();
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((e) => (e.textContent ?? "").trim());
    expect(items).toEqual(["Summarize earlier messages now", "Clear conversation…"]);
    expect(document.body.textContent).not.toMatch(/Fork|Delete session|Terminal|Mode|Previous sessions/);
  });

  it("Summarize uses the existing compact", async () => {
    mountAgent();
    await openMenu();
    await act(async () => byText("Summarize earlier messages now")!.click());
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("Clear conversation… asks first, says what is kept, and only then clears", async () => {
    mountAgent();
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    expect(onClear).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Clear your conversation with Dev?");
    expect(document.body.textContent).toContain("Starts a new conversation with Dev. What it learned from your corrections and each project's notes are kept.");
    await act(async () => byText("Clear conversation")!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("Cancel leaves the conversation alone", async () => {
    mountAgent();
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    await act(async () => byText("Cancel")!.click());
    expect(onClear).not.toHaveBeenCalled();
  });

  it("a plain session is unchanged: breadcrumb, branch, Fork and Delete are all still there", async () => {
    mountAgent({ agentConversation: undefined, breadcrumb: { project: "proj", window: "win" } });
    expect(h!.container.textContent).toContain("proj / win");
    expect(h!.container.textContent).toContain("main");
    await openMenu();
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((e) => (e.textContent ?? "").trim());
    expect(items).toContain("Fork session");
    expect(items).toContain("Delete session");
  });
  // ---- Clear is refused while tasks started from this conversation run (agent chat tasks FR-012, design §5) ----

  const onOpenFleet = vi.fn();
  const blocked = (over: Record<string, unknown> = {}) => ({ ...agent, clearBlock: { tasks: [{ key: "j1", title: "Fix the flaky upload test", project: "Ronda", status: "In progress" }], refusal: null, onOpenFleet }, ...over });
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

  it("with a task running from this conversation the dialog opens already refused: the warning, the task, the reason, Open Fleet and Close — no Clear button", async () => {
    onOpenFleet.mockClear();
    mountAgent({ agentConversation: blocked() });
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    expect(document.body.textContent).toContain("Clear your conversation with Dev?");
    const alert = document.body.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Dev has 1 task running from this conversation; wait for it or stop it first.");
    expect(document.body.textContent).toContain("Fix the flaky upload test · Ronda · In progress");
    expect(document.body.textContent).toContain("Its result comes back to this conversation, so clearing now would lose it. Stop a task from Fleet.");
    expect(byText("Clear conversation")).toBeUndefined();
    expect(byText("Open Fleet")).toBeTruthy();
    expect(byText("Close")).toBeTruthy();
    expect(document.activeElement?.textContent?.trim()).toBe("Close");
    await act(async () => byText("Open Fleet")!.click());
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("two tasks read in the plural; a start still waiting reads 'Starting…'", async () => {
    const tasks = [
      { key: "j1", title: "Fix the flaky upload test", project: "Ronda", status: "In progress" },
      { key: "start:call_1", title: "Fix the billing page totals", project: "Ronda", status: "Starting…" },
    ];
    mountAgent({ agentConversation: blocked({ clearBlock: { tasks, refusal: null, onOpenFleet } }) });
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe("Dev has 2 tasks running from this conversation; wait for them or stop them first.");
    expect(document.body.textContent).toContain("Fix the billing page totals · Ronda · Starting…");
  });

  it("Close leaves the conversation alone", async () => {
    mountAgent({ agentConversation: blocked() });
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    await act(async () => byText("Close")!.click());
    expect(onClear).not.toHaveBeenCalled();
  });

  it("with no task running the dialog is the allowed one, unchanged", async () => {
    mountAgent({ agentConversation: blocked({ clearBlock: { tasks: [], refusal: null, onOpenFleet } }) });
    await openMenu();
    await act(async () => byText("Clear conversation…")!.click());
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(byText("Clear conversation")).toBeTruthy();
    expect(byText("Cancel")).toBeTruthy();
  });

  it("a refusal from the box after Clear was pressed (a race) opens the same refused dialog with the box's sentence", async () => {
    const props = (clearBlock: unknown) => ({ sessionId: "ses_dev", breadcrumb: { project: "manta-agents", window: "Dev" }, agentConversation: { ...agent, clearBlock }, onClear, onFork, onDelete, onCompact } as never);
    mountAgent({ agentConversation: blocked({ clearBlock: { tasks: [], refusal: null, onOpenFleet } }) });
    expect(dialog()).toBeNull();
    h!.rerender(sessionHeaderElement(props({ tasks: [], refusal: "Dev has 1 task running from this conversation; wait for it or stop it first", onOpenFleet })));
    await act(async () => {});
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe("Dev has 1 task running from this conversation; wait for it or stop it first.");
    expect(byText("Clear conversation")).toBeUndefined();
  });
});
