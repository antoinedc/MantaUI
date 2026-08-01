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

// The launcher button whose text begins with `label` (the icon renders no
// text, the label text starts the button's text content).
function launcherButton(h: Harness, label: string): HTMLButtonElement {
  const btn = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
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

    const text = h!.text();
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

    act(() => launcherButton(h!, "Claude").click());
    expect(changed).toBe("tui:claude");
  });

  it("marks the currently active mode in the menu", async () => {
    h = mount(<ChatPanel {...PROPS} mode="tui:claude" onModeChange={() => {}} />);
    await h!.flush();
    openMenu(h!);

    const active = launcherButton(h!, "Claude");
    expect(active.textContent).toContain("✓");
  });

  it("omits the mode section when the caller owns mode elsewhere (mobile)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h!.flush();
    openMenu(h!);

    // No onModeChange → no Mode group, no launcher entries; the session
    // actions still render.
    expect(h!.text()).not.toContain("AI-CLI");
    expect(h!.text()).not.toContain("Claude");
    expect(h!.text()).toContain("Fork session");
  });
});