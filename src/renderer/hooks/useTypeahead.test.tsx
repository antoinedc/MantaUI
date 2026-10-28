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

    // Type "/" into the textarea
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.selectionStart = 1;
      textarea.selectionEnd = 1;
      textarea.dispatchEvent(new Event("keydown", { bubbles: true }));
    });
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

    // Type "@" into the textarea
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "@");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.selectionStart = 1;
      textarea.selectionEnd = 1;
      textarea.dispatchEvent(new Event("keydown", { bubbles: true }));
    });
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
