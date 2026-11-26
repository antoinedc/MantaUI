// @vitest-environment jsdom
//
// The sidebar Agents section (agent screens spec §1.1): the Needs you and Fleet rows, one row per agent that opens its PROFILE
// (the direct chat is the profile's Chat button), and New agent, which opens a chat with Manta (no dialog). Every press ends
// visibly: a page opens, a draft opens.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { AgentsSection } from "./AgentsSection";
import type { AgentsView } from "./agents/agentsView";
import { resetPackageAgentsForTest } from "./packageAgents";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";

const DEV = {
  slug: "dev",
  name: "Dev",
  description: "Writes and fixes code",
  isolation: "worktree" as const,
  model: null,
  color: "#5A88FF",
  builtIn: true,
  role: "specialist" as const,
  useWhen: null,
  notFor: null,
  notice: null,
};
const MANTA = {
  ...DEV,
  slug: "manta",
  name: "Manta",
  description: "Leads the chat",
  isolation: "none" as const,
  color: "#7C5CFF",
  role: "lead" as const,
};
const BAD = { ...DEV, slug: "bad", name: "Bad", color: null, builtIn: false, error: "agent.md has no description" };

describe("AgentsSection", () => {
  let h: Harness | null = null;
  const onOpenView = vi.fn<(v: AgentsView) => void>();

  beforeEach(() => {
    resetStore({ drafts: [], projects: [], activeProjectName: null });
    onOpenView.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function setup(extra: Record<string, unknown> = {}, props: { view?: AgentsView; needsCount?: number } = {}) {
    const { api } = installMockApi({ agentsList: () => Promise.resolve([DEV, BAD]), ...extra });
    resetPackageAgentsForTest();
    h = mount(<AgentsSection view={props.view ?? null} needsCount={props.needsCount ?? 0} onOpenView={onOpenView} />);
    await h.flush();
    await h.flush();
    // Boxed: the mock api is a Proxy that answers `then`, so returning it directly hangs.
    return { api };
  }

  const rows = () => Array.from(h!.container.querySelectorAll<HTMLElement>('[data-testid="agent-row"]'));
  const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await h!.flush();
  };
  const nav = (name: string) => h!.container.querySelector<HTMLButtonElement>(`[data-testid="agents-nav-${name}"]`);

  it("renders nothing when the box has no agents (older box / demo)", async () => {
    await setup({ agentsList: () => Promise.resolve(null) });
    expect(h!.container.querySelector('[data-testid="agents-section"]')).toBeNull();
  });

  it("lists agents; an invalid one is marked and carries its error as the tooltip, but still opens (its profile shows the error)", async () => {
    await setup();
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("Dev"), expect.stringContaining("Bad")]);
    expect(rows()[0].title).toBe("Writes and fixes code");
    expect(rows()[1].title).toContain("agent.md has no description");
    expect(rows()[1].textContent).toContain("invalid");
    await click(rows()[1]);
    expect(onOpenView).toHaveBeenCalledWith({ page: "profile", slug: "bad" });
  });

  it("the valid lead is listed first with a lead tag, whatever the box's order; other rows have none", async () => {
    await setup({ agentsList: () => Promise.resolve([DEV, MANTA, BAD]) });
    expect(rows().map((r) => r.dataset.slug)).toEqual(["manta", "dev", "bad"]);
    expect(rows()[0].textContent).toContain("lead");
    expect(rows()[1].textContent).not.toContain("lead");
  });

  it("the Architect is listed with a via-Manta tag and opens its profile like any other agent", async () => {
    const ARCH = { ...DEV, slug: "architect", name: "Architect", description: "Builds agents", isolation: "none" as const, role: "architect" as const };
    await setup({ agentsList: () => Promise.resolve([DEV, ARCH]) });
    expect(rows().map((r) => r.dataset.slug)).toEqual(["dev", "architect"]);
    expect(rows()[1].textContent).toContain("via Manta");
    await click(rows()[1]);
    expect(onOpenView).toHaveBeenCalledWith({ page: "profile", slug: "architect" });
  });

  it("clicking an agent opens its profile — not its chat", async () => {
    const { api } = await setup({ agentsList: () => Promise.resolve([DEV, MANTA]) });
    await click(rows()[1]);
    expect(onOpenView).toHaveBeenCalledWith({ page: "profile", slug: "dev" });
    await click(rows()[0]);
    expect(onOpenView).toHaveBeenCalledWith({ page: "profile", slug: "manta" });
    expect(api.calls.agentsOpenChat).toBeUndefined();
  });

  it("the row of the open profile is the selected one", async () => {
    await setup({}, { view: { page: "profile", slug: "dev" } });
    expect(rows()[0].getAttribute("aria-current")).toBe("page");
    expect(rows()[1].getAttribute("aria-current")).toBeNull();
  });

  it("a notice shows as a muted hint under its row, not as an error", async () => {
    const legacy = { ...DEV, slug: "manta", name: "Manta", notice: "Rename this folder to enable the Manta lead" };
    await setup({ agentsList: () => Promise.resolve([legacy, DEV]) });
    const hint = h!.container.querySelector('[data-testid="agent-notice"]')!;
    expect(hint.textContent).toBe("Rename this folder to enable the Manta lead");
    expect(hint.className).not.toContain("danger");
    expect(rows()[0].getAttribute("aria-describedby")).toBe(hint.id);
  });

  describe("Needs you and Fleet", () => {
    it("two rows above the agents: Needs you with its count, then Fleet", async () => {
      await setup({}, { needsCount: 3 });
      const section = h!.container.querySelector('[data-testid="agents-section"]')!;
      const order = [...section.querySelectorAll('[data-testid^="agents-nav-"], [data-testid="agent-row"]')].map((e) => e.getAttribute("data-testid"));
      expect(order).toEqual(["agents-nav-needs", "agents-nav-fleet", "agent-row", "agent-row"]);
      expect(nav("needs")?.textContent).toContain("Needs you");
      expect(nav("needs")?.querySelector('[data-testid="agents-needs-badge"]')?.textContent).toBe("3");
      expect(nav("needs")?.getAttribute("aria-label")).toBe("Needs you, 3 waiting");
    });

    it("no badge at zero", async () => {
      await setup({}, { needsCount: 0 });
      expect(nav("needs")?.querySelector('[data-testid="agents-needs-badge"]')).toBeNull();
      expect(nav("needs")?.getAttribute("aria-label")).toBe("Needs you");
    });

    it("Needs you opens the Fleet page at its first section (a fresh request each press); Fleet opens it plain", async () => {
      await setup({}, { needsCount: 1 });
      await click(nav("needs"));
      await click(nav("needs"));
      const calls = onOpenView.mock.calls.map((c) => c[0]);
      expect(calls[0]).toMatchObject({ page: "fleet", focus: "needs" });
      expect(calls[1]).toMatchObject({ page: "fleet", focus: "needs" });
      expect((calls[0] as { nonce: number }).nonce).not.toBe((calls[1] as { nonce: number }).nonce);
      await click(nav("fleet"));
      expect(onOpenView).toHaveBeenLastCalledWith({ page: "fleet" });
    });

    it("the open page's row is selected", async () => {
      await setup({}, { view: { page: "fleet" } });
      expect(nav("fleet")?.getAttribute("aria-current")).toBe("page");
      expect(nav("needs")?.getAttribute("aria-current")).toBeNull();
      h!.unmount();
      await setup({}, { view: { page: "fleet", focus: "needs", nonce: 1 } });
      expect(nav("needs")?.getAttribute("aria-current")).toBe("page");
      expect(nav("fleet")?.getAttribute("aria-current")).toBeNull();
    });
  });

  describe("New agent", () => {
    it("is a button that opens a chat with Manta, 'Create an agent that ' typed, in the active project — and no dialog", async () => {
      resetStore({ drafts: [], projects: [{ tmuxSession: "manta", defaultCwd: "/work/manta", windows: [] } as never], activeProjectName: "manta" });
      await setup();
      const button = [...h!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New agent");
      expect(h!.container.textContent).toContain("opens a chat with Manta to describe it");
      await click(button);
      const draft = useStore.getState().drafts.at(-1)!;
      expect(draft.input).toBe("Create an agent that ");
      expect(draft.mode).toEqual({ projectName: "manta" });
      expect(h!.container.querySelector("dialog")).toBeNull();
    });
  });
});
