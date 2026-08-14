// @vitest-environment jsdom
//
// Regression tests for nested-modal Escape ownership inside Settings (BET-724,
// requested by BET-736). BET-724 made the Modal primitive own Escape / focus
// trap / restore, and Settings' own dialog is built on `useDialog` (not on
// Modal), so a confirm opened INSIDE Settings (a nested Modal rendered as a
// child of Settings' dialog) must own Escape and Tab — closing only the
// confirm, never the Settings dialog around it.
//
// Test-only file. Settings is not mounted anywhere else in the suite; this
// file mounts it for the first time via the shared testHarness `mount()` and
// stubs `window.api` with the installMockApi pattern, stubbing only the calls
// Settings makes on mount (getClientVersion / getServerVersion / configGet).
//
// Test 1 uses the "Reset all settings?" confirm (confirmReset): it sits on the
// default General tab, so no tab navigation is needed to reach its trigger.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, type Harness } from "./testHarness";
import { Settings } from "./Settings";

// The confirm used for test 1. "Reset all settings?" (confirmReset) opens from
// the default General tab's Danger zone.
const CONFIRM_LABEL = "Reset all settings?";

describe("Settings — Escape + nested-confirm ownership (BET-724 regression)", () => {
  let h: Harness | null = null;

  const stubApi = () =>
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
    });

  // Settings' own full-screen dialog lives in `container`; the nested
  // ConfirmModal renders through Modal's portal to document.body — so to see
  // BOTH (and count them), query document.body (the container is its child).
  const dialogs = (): HTMLElement[] =>
    [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];

  const confirmDialog = (): HTMLElement | null =>
    h!.docQuery<HTMLElement>(`[role="dialog"][aria-label="${CONFIRM_LABEL}"]`);

  const clickResetConfirm = () => {
    const btn = [...h!.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Reset all settings…",
    );
    expect(btn, "Reset all settings… trigger button").toBeTruthy();
    act(() => (btn as HTMLButtonElement).click());
  };

  // Let a Modal's exit animation (0.18s) run to completion and drain the
  // mock-api promise microtasks.
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await h!.flush();
  };

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("Escape with the confirm open closes only the confirm — Settings stays mounted, onClose not called", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    expect(dialogs().length).toBe(1);

    clickResetConfirm();
    await h.flush();

    // Confirm is now open: Settings dialog + nested confirm dialog.
    expect(dialogs().length).toBe(2);
    const confirm = confirmDialog();
    expect(confirm, "confirm dialog should be open").toBeTruthy();

    // Focus is trapped inside the confirm; press Escape on its first focusable
    // (Cancel) — the innermost open Modal owns Escape, so only it closes.
    const confirmBtn = confirm!.querySelector<HTMLElement>("button");
    expect(confirmBtn, "confirm has a focusable control").toBeTruthy();
    act(() => {
      confirmBtn!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    // Confirm gone, Settings dialog still mounted, and onClose was NOT called.
    expect(confirmDialog()).toBeNull();
    expect(dialogs().length).toBe(1);
    expect(closeCalls.length).toBe(0);
  });

  it("Escape with no confirm open closes Settings (onClose called exactly once)", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    const search = h.container.querySelector<HTMLElement>(
      'input[placeholder="Find a setting…"]',
    );
    expect(search, "settings search field").toBeTruthy();

    act(() => {
      search!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await h.flush();

    expect(closeCalls.length).toBe(1);
  });

  it("with the confirm open, Tab stays within the confirm (Settings' trap does not fight the nested Modal's)", async () => {
    stubApi();
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();

    clickResetConfirm();
    await h.flush();

    const confirm = confirmDialog();
    expect(confirm, "confirm dialog should be open").toBeTruthy();
    const focusables = [
      ...confirm!.querySelectorAll<HTMLElement>("button"),
    ];
    expect(focusables.length).toBe(2); // Cancel + Reset

    // Tab off the LAST focusable in the confirm: the nested Modal's trap wraps
    // within the confirm, rather than Settings' outer trap claiming the Tab.
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);

    act(() => {
      last.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Wrapped to the confirm's first control (Cancel) — still inside it.
    expect(document.activeElement).toBe(focusables[0]);
    expect(confirm!.contains(document.activeElement)).toBe(true);
  });
});
