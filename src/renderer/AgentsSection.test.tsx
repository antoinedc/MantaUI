// @vitest-environment jsdom
//
// The sidebar Agents section (Agents Phase 1): rows, opening a direct chat, and
// the create dialog. Every press ends visibly: a window opens, a toast or an
// inline alert says why not.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, StrictMode } from "react";
import { AgentsSection } from "./AgentsSection";
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
};
const BAD = { ...DEV, slug: "bad", name: "Bad", color: null, builtIn: false, error: "agent.md has no description" };

beforeAll(() => {
  // jsdom has no <dialog> behaviour; the real thing is Chromium's.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = window.HTMLDialogElement.prototype as any;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    // Chromium queues the close event as a task; it does not fire synchronously.
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
});

describe("AgentsSection", () => {
  let h: Harness | null = null;
  const onOpenWindow = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    resetStore();
    onOpenWindow.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function setup(extra: Record<string, unknown> = {}, strict = false) {
    const { api } = installMockApi({
      agentsList: () => Promise.resolve([DEV, BAD]),
      agentsOpenChat: () => Promise.resolve({ tmuxSession: "manta-agents", windowIndex: 0 }),
      ...extra,
    });
    resetPackageAgentsForTest();
    const section = <AgentsSection onOpenWindow={onOpenWindow} />;
    h = mount(strict ? <StrictMode>{section}</StrictMode> : section);
    await h.flush();
    await h.flush();
    // Boxed: the mock api is a Proxy that answers `then`, so returning it directly hangs.
    return { api };
  }

  const rows = () => Array.from(h!.container.querySelectorAll<HTMLButtonElement>('[data-testid="agent-row"]'));
  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await h!.flush();
  };
  const setValue = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("renders nothing when the box has no agents (older box / demo)", async () => {
    await setup({ agentsList: () => Promise.resolve(null) });
    expect(h!.container.querySelector('[data-testid="agents-section"]')).toBeNull();
  });

  it("lists agents; an invalid one is disabled with its error as the tooltip", async () => {
    await setup();
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("Dev"), expect.stringContaining("Bad")]);
    expect(rows()[0].title).toBe("Writes and fixes code");
    expect(rows()[1].disabled).toBe(true);
    expect(rows()[1].title).toContain("agent.md has no description");
  });

  it("clicking an agent opens its chat window", async () => {
    const { api } = await setup();
    await click(rows()[0]);
    expect(api.calls.agentsOpenChat[0][0]).toEqual({ slug: "dev" });
    expect(onOpenWindow).toHaveBeenCalledWith("manta-agents", 0);
  });

  it("a failed open is an error toast, not silence", async () => {
    await setup({ agentsOpenChat: () => Promise.reject(new Error("opencode is not running")) });
    await click(rows()[0]);
    expect(onOpenWindow).not.toHaveBeenCalled();
    const toasts = useStore.getState().appToasts;
    expect(toasts.at(-1)?.message).toContain("opencode is not running");
  });

  it("+ opens the create dialog; Create sends the form and closes it", async () => {
    const { api } = await setup({
      agentsCreate: (input: { name: string }) => Promise.resolve({ ...DEV, slug: "reviewer", name: input.name, builtIn: false }),
    });
    await click(h!.container.querySelector('button[aria-label="New agent"]')!);
    const dialog = h!.container.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("new-agent-title");
    await setValue(h!.container.querySelector<HTMLInputElement>("#new-agent-name")!, "Reviewer");
    await setValue(h!.container.querySelector<HTMLInputElement>("#new-agent-description")!, "Reviews PRs");
    await click(h!.container.querySelector('input[type="checkbox"]')!);
    await act(async () => {
      h!.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await h!.flush();
    expect(api.calls.agentsCreate[0][0]).toEqual({ name: "Reviewer", description: "Reviews PRs", isolation: "worktree" });
    expect(h!.container.querySelector("dialog")).toBeNull();
  });

  it("+ keeps the dialog open under StrictMode (double-run effects)", async () => {
    await setup({}, true);
    await click(h!.container.querySelector('button[aria-label="New agent"]')!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await h!.flush();
    expect(h!.container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  });

  it("a refused create stays open with the reason inline", async () => {
    await setup({ agentsCreate: () => Promise.reject(new Error("An agent named Dev already exists")) });
    await click(h!.container.querySelector('button[aria-label="New agent"]')!);
    await setValue(h!.container.querySelector<HTMLInputElement>("#new-agent-name")!, "Dev");
    await setValue(h!.container.querySelector<HTMLInputElement>("#new-agent-description")!, "x");
    await act(async () => {
      h!.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await h!.flush();
    expect(h!.container.querySelector("dialog")).not.toBeNull();
    expect(h!.container.querySelector('[data-testid="new-agent-error"]')?.textContent).toContain("already exists");
  });

  it("Cancel closes the dialog without creating", async () => {
    const { api } = await setup();
    await click(h!.container.querySelector('button[aria-label="New agent"]')!);
    const cancel = Array.from(h!.container.querySelectorAll("dialog button")).find((b) => b.textContent === "Cancel")!;
    await click(cancel);
    expect(h!.container.querySelector("dialog")).toBeNull();
    expect(api.calls.agentsCreate ?? []).toHaveLength(0);
  });
});
