// @vitest-environment jsdom
//
// BET-467: the AI-CLI launcher entry point (removed by BET-459's header
// collapse) lives in the session ⋯ menu. These mount the real <ChatPanel> via
// the render harness, open the session menu, and assert that the launcher
// entries (a) render and (b) switching one calls onModeChange("tui:<id>").

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  mountSessionHeader,
  type Harness,
} from "./testHarness";
import type { AvailableLauncher } from "../shared/types";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
  projectName: "proj",
  winName: "chat-1",
  mode: "chat" as const,
  availableLaunchers: [
    { id: "claude", label: "Claude", flags: [] },
    { id: "opencode", label: "Opencode", flags: [] },
  ] as AvailableLauncher[],
};

function openMenu(h: Harness) {
  const trigger = h.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Session actions"]',
  );
  expect(trigger).not.toBeNull();
  act(() => trigger!.click());
  return trigger!;
}

// The menu is portalled to <body> by Popover, so content/assertions that used
// to read the harness container now read the whole body (container ⊂ body).
const bodyText = () => document.body.textContent ?? "";

// The launcher button whose text begins with `label` (the icon renders no
// text, the label text starts the button's text content). The menu (and its
// buttons) are portalled to <body> by Popover, so this searches document.body.
function launcherButton(label: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim()?.startsWith(label),
  );
  expect(btn, `expected a "${label}" menu button`).not.toBeUndefined();
  return btn!;
}

describe("SessionHeader session menu launcher entries (BET-467)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("shows Chat / Terminal / each launcher when a session is active", async () => {
    h = mount(<ChatPanel {...PROPS} onModeChange={() => {}} />);
    await h!.flush();
    openMenu(h!);

    const text = bodyText();
    expect(text).toContain("Mode");
    expect(text).toContain("Chat");
    expect(text).toContain("Terminal");
    expect(text).toContain("AI-CLI");
    expect(text).toContain("Claude");
    expect(text).toContain("Opencode");
  });

  it("switching a launcher calls onModeChange with the tui:<id> mode", async () => {
    let changed: unknown = null;
    h = mount(
      <ChatPanel
        {...PROPS}
        onModeChange={(m) => {
          changed = m;
        }}
      />,
    );
    await h!.flush();
    openMenu(h!);

    act(() => launcherButton("Claude").click());
    expect(changed).toBe("tui:claude");
  });

  it("marks the currently active mode in the menu", async () => {
    h = mount(<ChatPanel {...PROPS} mode="tui:claude" onModeChange={() => {}} />);
    await h!.flush();
    openMenu(h!);

    const active = launcherButton("Claude");
    expect(active.textContent).toContain("✓");
  });

  it("omits the mode section when the caller owns mode elsewhere (mobile)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h!.flush();
    openMenu(h!);

    // No onModeChange → no Mode group, no launcher entries; the session
    // actions still render.
    expect(bodyText()).not.toContain("AI-CLI");
    expect(bodyText()).not.toContain("Claude");
    expect(bodyText()).toContain("Fork session");
  });
});

// BET-741: the ⋯ menu adopts the standard WAI-ARIA menu-button focus pattern
// (real DOM focus, roving tabIndex) in place of the BET-726
// aria-activedescendant stand-in on the trigger.
describe("SessionHeader session menu — WAI-ARIA focus (BET-741)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("moves focus into the menu surface on open", async () => {
    h = mount(<ChatPanel {...PROPS} onModeChange={() => {}} />);
    await h!.flush();
    openMenu(h!);

    // The surface is portalled to <body> by Popover.
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement | null;
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("returns focus to the trigger on Escape", async () => {
    h = mount(<ChatPanel {...PROPS} onModeChange={() => {}} />);
    await h!.flush();
    const trigger = openMenu(h!);

    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(menu);
    act(() => {
      // Escape is handled document-wide by Popover (it also restores focus).
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

// BET-968: the stale-cache "Clear session" button in the context pill's
// popover used to call onClear() immediately, with no confirmation — while the
// ⋯ menu confirmed first. Both now share ONE hoisted ConfirmModal, so this
// regression test drives the POPOVER path: clicking "Clear session" must open
// the confirm dialog, not call onClear; confirming then fires onClear exactly
// once.
describe("Context pill stale-cache Clear confirms (BET-968)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function openPopover() {
    const trigger = h!.container.querySelector<HTMLButtonElement>(
      "button.manta-ctx-pill",
    );
    expect(trigger).toBeTruthy();
    act(() => trigger!.click());
    // The popover is portalled to <body> by Popover.
    expect(h!.docText()).toContain("Cache went stale");
  }

  // The confirm's action button lives inside the Modal's dialog panel
  // (portalled to document.body) — searched by exact text.
  function confirmButtonByText(text: string): HTMLButtonElement {
    const dialog = h!.docQuery('div[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    const el = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    ) as HTMLButtonElement | undefined;
    expect(el, `expected a "${text}" confirm button`).toBeTruthy();
    return el!;
  }

  it("popover Clear opens the confirm instead of calling onClear immediately", () => {
    let cleared = 0;
    h = mountSessionHeader({
      ctxBreakdown: {
        freshInput: 1,
        cacheRead: 1,
        cacheWrite: 1,
        totalInput: 100,
        pct: 12,
        segments: [],
      },
      ctxLimit: 200000,
      staleCache: {
        isStale: true,
        idleMs: 3_600_000,
        staleTokens: 344_000,
        ttlMs: 3_600_000,
      },
      onClear: () => cleared++,
    });
    openPopover();

    // The popover's stale-block "Clear session" button.
    const clearBtn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Clear session",
    );
    expect(clearBtn, "expected the popover Clear session button").toBeTruthy();
    act(() => clearBtn!.click());

    // Regression: confirming must NOT have fired yet; the dialog is present.
    expect(cleared).toBe(0);
    expect(h!.docText()).toContain("Clear this conversation?");
  });

  it("confirming the popover Clear calls onClear exactly once", () => {
    let cleared = 0;
    h = mountSessionHeader({
      ctxBreakdown: {
        freshInput: 1,
        cacheRead: 1,
        cacheWrite: 1,
        totalInput: 100,
        pct: 12,
        segments: [],
      },
      ctxLimit: 200000,
      staleCache: {
        isStale: true,
        idleMs: 3_600_000,
        staleTokens: 344_000,
        ttlMs: 3_600_000,
      },
      onClear: () => cleared++,
    });
    openPopover();

    const clearBtn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Clear session",
    );
    act(() => clearBtn!.click());
    act(() => confirmButtonByText("Clear").click());

    expect(cleared).toBe(1);
  });
});