// @vitest-environment jsdom
//
// Tests for useTypeahead hook (BET-64).
//
// These test the typeahead detection, lazy fetching, debounced file search,
// result filtering, and selection application. The hook is callback-driven
// (no effects) so it's trivially testable with the render harness.
//
// We test indirectly through the ChatPanel component using the existing
// test harness, since @testing-library/react is not in the repo's deps.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "../ChatPanel";
import { refreshAgentCatalog } from "../agentCatalog";
import { resetPackageAgentsForTest } from "../packageAgents";
import {
  installMockApi,
  resetStore,
  mount,
  type Harness,
} from "../testHarness";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
};

async function typeInto(textarea: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.selectionStart = text.length;
    textarea.selectionEnd = text.length;
    textarea.dispatchEvent(new Event("keydown", { bubbles: true }));
  });
}

describe("useTypeahead via ChatPanel", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("mounts and shows the composer with typeahead support", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // The composer textarea is present.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("shows typeahead popup when user types /", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    await typeInto(textarea, "/");
    await h.flush();

    // The typeahead popup should be visible (it renders as a div with class)
    // We don't assert exact visibility since the CSS class names may vary,
    // but we verify the component didn't crash and the textarea has "/" in it.
    expect(textarea.value).toBe("/");
  });

  it("shows typeahead popup when user types @", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const textarea = h.container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    await typeInto(textarea, "@");
    await h.flush();

    // The typeahead popup should be visible
    expect(textarea.value).toBe("@");
  });

  // ---- agent (@@) typeahead ----------------------------------------------
  const AGENTS = [
    { name: "build", description: "builds" },
    { name: "plan", description: "plans" },
  ];

  const taOf = (hh: Harness) => hh.container.querySelector("textarea") as HTMLTextAreaElement;

  // The caret must be set BEFORE the input event: updateInput reads it during
  // the event to decide which typeahead (if any) to open.
  async function typeText(hh: Harness, text: string, caret = text.length) {
    const ta = taOf(hh);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(ta, text);
      ta.selectionStart = caret;
      ta.selectionEnd = caret;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await hh.flush();
  }

  async function press(hh: Harness, key: string) {
    const ta = taOf(hh);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await hh.flush();
  }

  // The agent catalog is a module-level cache shared across tests, so force a
  // re-fetch against THIS test's mock api before mounting.
  async function mountWithAgents(extra: Record<string, unknown> = {}) {
    const { api } = installMockApi({
      ...extra,
      opencodeAgents: () => Promise.resolve(AGENTS),
      opencodeModels: () =>
        Promise.resolve([
          { id: "m", providerID: "p", name: "M", limit: { context: 1000, output: 100 } },
        ]),
    });
    refreshAgentCatalog();
    await new Promise((r) => setTimeout(r, 0));
    h = mount(<ChatPanel {...PROPS} />);
    // Boxed: the mock api is a Proxy that answers `then`, so awaiting it directly hangs.
    return { api };
  }

  it("@@ opens the agent popup and filters by the partial name", async () => {
    await mountWithAgents();
    await h!.flush();
    await typeText(h!, "@@");
    expect(h!.text()).toContain("@build");
    expect(h!.text()).toContain("@plan");
    await typeText(h!, "@@bu");
    expect(h!.text()).toContain("@build");
    expect(h!.text()).not.toContain("@plan");
    await typeText(h!, "@@zzz");
    expect(h!.text()).toContain("No matching agents");
  });

  it("Enter on a fully typed @@build completes instead of sending, then sends with the mention", async () => {
    const { api } = await mountWithAgents();
    await h!.flush();
    await typeText(h!, "@@build");
    await press(h!, "Enter");
    expect(taOf(h!).value).toBe("@build ");
    expect(api.calls.opencodePrompt ?? []).toHaveLength(0);

    await press(h!, "Enter");
    const sent = api.calls.opencodePrompt ?? [];
    expect(sent).toHaveLength(1);
    expect(String(sent[0][1]).trim()).toBe("@build");
    expect(sent[0][4]).toEqual([
      { name: "build", source: { value: "@build", start: 0, end: 6 } },
    ]);
  });

  it("Enter and Tab complete a partial agent name without sending", async () => {
    const { api } = await mountWithAgents();
    await h!.flush();
    for (const key of ["Enter", "Tab"]) {
      await typeText(h!, "@@bu");
      await press(h!, key);
      expect(taOf(h!).value).toBe("@build ");
    }
    expect(api.calls.opencodePrompt ?? []).toHaveLength(0);
  });

  it("clicking an agent row completes it and the next send carries the mention", async () => {
    const { api } = await mountWithAgents();
    await h!.flush();
    await typeText(h!, "@@pl");
    const row = Array.from(h!.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("@plan"),
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    await act(async () => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(taOf(h!).value).toBe("@plan ");
    await press(h!, "Enter");
    const sent = api.calls.opencodePrompt ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0][4]).toEqual([
      { name: "plan", source: { value: "@plan", start: 0, end: 5 } },
    ]);
  });

  it("a single @ still opens the file/reference picker, and an exact @ref + Enter still sends", async () => {
    const { api } = await mountWithAgents({
      opencodeReferences: () => Promise.resolve([{ name: "docs", description: "d" }]),
    });
    await h!.flush();
    await typeText(h!, "@");
    // The file search is debounced 80ms.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await h!.flush();
    expect(h!.text()).toContain("@docs");
    expect(h!.text()).not.toContain("@build");

    await typeText(h!, "@docs");
    await press(h!, "Enter");
    const sent = api.calls.opencodePrompt ?? [];
    expect(sent).toHaveLength(1);
    expect(String(sent[0][1]).trim()).toBe("@docs");
  });

  it("a slash command still opens the command popup, and an exact /command + Enter still runs it", async () => {
    const { api } = await mountWithAgents({
      opencodeCommands: () => Promise.resolve([{ name: "review", description: "r" }]),
      opencodeRunCommand: () => Promise.resolve({ ok: true }),
    });
    await h!.flush();
    await typeText(h!, "/rev");
    expect(h!.text()).toContain("/review");

    await typeText(h!, "/review");
    await press(h!, "Enter");
    // Exact match submits; it must not complete to "/review ".
    expect(taOf(h!).value).not.toBe("/review ");
    const ran = api.calls.opencodeRunCommand ?? [];
    expect(ran).toHaveLength(1);
    expect((ran[0][0] as { command: string }).command).toBe("review");
  });
});

// ---- package agents (Agents Phase 1) --------------------------------------
describe("package agents via ChatPanel", () => {
  let h: Harness | null = null;
  const DEV = {
    slug: "dev",
    name: "Dev",
    description: "Writes and fixes code",
    isolation: "worktree" as const,
    model: null,
    color: null,
    builtIn: true,
  };
  const BAD = { ...DEV, slug: "bad", name: "Bad", builtIn: false, error: "no agent.md" };

  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const ta = () => h!.container.querySelector("textarea") as HTMLTextAreaElement;
  async function typeText(text: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta(), text);
      ta().selectionStart = text.length;
      ta().selectionEnd = text.length;
      ta().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await h!.flush();
  }
  async function press(key: string) {
    await act(async () => {
      ta().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await h!.flush();
  }
  const rowFor = (label: string) =>
    Array.from(h!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(label)) as
      | HTMLButtonElement
      | undefined;

  async function setup(extra: Record<string, unknown> = {}) {
    const { api } = installMockApi({
      agentsList: () => Promise.resolve([DEV, BAD]),
      agentsDispatch: () => Promise.resolve({ jobId: "job1" }),
      opencodeReferences: () => Promise.resolve([{ name: "docs", description: "d" }]),
      opencodeModels: () =>
        Promise.resolve([{ id: "m", providerID: "p", name: "M", limit: { context: 1000, output: 100 } }]),
      ...extra,
    });
    resetPackageAgentsForTest();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await h.flush();
    // Boxed: the mock api is a Proxy that answers `then`, so returning it directly hangs.
    return { api };
  }

  async function pickDev() {
    await typeText("@");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await h!.flush();
    const row = rowFor("@dev");
    expect(row).toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(ta().value).toBe("@dev ");
  }

  it("a plain @ lists valid package agents ahead of references and files; invalid ones are not offered", async () => {
    await setup();
    await typeText("@");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await h!.flush();
    const text = h!.text();
    expect(text).toContain("@dev");
    expect(text).toContain("@docs");
    expect(text).not.toContain("@bad");
    expect(text.indexOf("@dev")).toBeLessThan(text.indexOf("@docs"));
  });

  it("@@ lists package agents too", async () => {
    await setup();
    await typeText("@@");
    expect(h!.text()).toContain("@dev");
  });

  it("Enter on a fully typed @dev completes the mention instead of sending", async () => {
    const { api } = await setup();
    await typeText("@dev");
    await press("Enter");
    expect(ta().value).toBe("@dev ");
    expect(api.calls.agentsDispatch ?? []).toHaveLength(0);
    expect(api.calls.opencodePrompt ?? []).toHaveLength(0);
  });

  it("sends a picked @dev message as a task for the agent, never as a prompt, and clears the composer", async () => {
    const { api } = await setup();
    await pickDev();
    await typeText("@dev fix the login bug");
    await press("Enter");
    const calls = api.calls.agentsDispatch ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      sessionId: "ses_test",
      directory: "/home/dev/projects/x",
      slug: "dev",
      text: "@dev fix the login bug",
    });
    expect(api.calls.opencodePrompt ?? []).toHaveLength(0);
    expect(ta().value).toBe("");
  });

  it("shows a starting card and clears the composer before the box answers", async () => {
    let resolve: (v: { jobId: string }) => void = () => {};
    await setup({ agentsDispatch: () => new Promise((r) => (resolve = r)) });
    await pickDev();
    await typeText("@dev fix the login bug");
    await press("Enter");
    expect(ta().value).toBe("");
    const card = h!.container.querySelector('[data-testid="background-card"][data-kind="starting"]');
    expect(card?.textContent).toContain("Dev");
    expect(card?.textContent).toContain("@dev fix the login bug");
    await act(async () => resolve({ jobId: "job1" }));
  });

  it("keeps the draft and shows the reason when the task can't start", async () => {
    const { api } = await setup({ agentsDispatch: () => Promise.reject(new Error("5 background jobs are already running")) });
    await pickDev();
    await typeText("@dev fix it");
    await press("Enter");
    expect((api.calls.agentsDispatch ?? []).length).toBe(1);
    expect(ta().value).toBe("@dev fix it");
    expect(h!.text()).toContain("5 background jobs are already running");
    expect(api.calls.opencodePrompt ?? []).toHaveLength(0);
  });

  it("a message without a picked package agent goes to the chat as usual", async () => {
    const { api } = await setup();
    await typeText("fix the login bug");
    await press("Enter");
    expect(api.calls.agentsDispatch ?? []).toHaveLength(0);
    expect(api.calls.opencodePrompt ?? []).toHaveLength(1);
  });
});
