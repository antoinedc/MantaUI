// @vitest-environment jsdom
//
// The session header of an AGENT's conversation (profile v5): "Team / Dev", no branch chip or Explorer, a Profile button, and a
// menu that holds only "Summarize earlier messages now" and "Clear conversation…" (with a confirmation that says what is kept).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockApi, mountSessionHeader, resetStore, type Harness } from "./testHarness";
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
});
