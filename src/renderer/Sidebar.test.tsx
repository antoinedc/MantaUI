// @vitest-environment jsdom
//
// BET-726 review cycle 1, Block (fix-here): the sidebar tree's roving-
// tabindex keydown handler (`onRailKeyDown`) used to switch on `e.key` with
// no check of where the keydown actually came from. That was safe before
// BET-726 Task 2.3, because every focusable element inside the tree WAS a
// treeitem row. Task 2.3 made the hover-revealed pin / GroupHeader +/X /
// draft-dismiss buttons Tab-reachable (dropped their `tabIndex={-1}`), so
// their keydowns started bubbling into the same handler — Enter/Space fired
// `activateFocused()` for whatever row `focusedKey` last pointed at (never
// the button actually under focus), and Delete/Backspace opened the confirm
// for that same possibly-unrelated row. `onRailKeyDown` now bails out
// immediately when the event target is (or is inside) a `<button>`, since
// rows are `<div role="treeitem">` and never buttons themselves.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { Sidebar } from "./Sidebar";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import type { Project } from "../shared/types";

function proj(over: Partial<Project> & { tmuxSession: string }): Project {
  return {
    tmuxSession: over.tmuxSession,
    defaultCwd: over.defaultCwd ?? "~",
    attached: over.attached ?? false,
    windows: over.windows ?? [],
  };
}

describe("Sidebar — nested-control keydown guard (BET-726 review cycle 1 Block)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi({
      // togglePin() awaits configUpdate() and reads `.pinnedWindows` off the
      // result — the default mock resolves `undefined`, which would throw.
      configUpdate: (patch: Record<string, unknown>) =>
        Promise.resolve({ pinnedWindows: (patch as { pinnedWindows?: string[] }).pinnedWindows ?? [] }),
    });
    resetStore({
      projects: [
        proj({
          tmuxSession: "proj",
          windows: [
            { index: 0, name: "win", active: true, paneCurrentPath: "/x", opencodeSessionId: null },
          ],
        }),
      ],
    });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function mountSidebar(): Harness {
    h = mount(
      <Sidebar onOpenSettings={() => {}} onNewProject={() => {}} onNewSessionInProject={() => {}} />,
    );
    return h;
  }

  // Two ArrowDowns: the first lands the roving highlight on the "proj" group
  // header, the second on its one window row ("win:proj:0").
  function focusWindowRow() {
    const tree = h!.container.querySelector('[role="tree"]') as HTMLElement;
    act(() => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
  }

  function pinButton(): HTMLButtonElement {
    const btn = h!.container.querySelector<HTMLButtonElement>('button[aria-label="Pin"]');
    expect(btn, "expected the window row's Pin button").toBeTruthy();
    return btn!;
  }

  it("Enter on the pin button does not activate the roving-focused row", () => {
    mountSidebar();
    focusWindowRow();
    expect(useStore.getState().activeProjectName).toBeNull();
    const btn = pinButton();
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // Pre-fix, this used to bubble into onRailKeyDown and call
    // activateFocused() for "win:proj:0", flipping activeProjectName even
    // though nothing that looks like the row was pressed.
    expect(useStore.getState().activeProjectName).toBeNull();
  });

  it("Backspace on the pin button does not open the delete confirm for the focused row", () => {
    mountSidebar();
    focusWindowRow();
    const btn = pinButton();
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    expect(h!.text()).not.toContain("Close session");
  });

  it("clicking the pin button still toggles the pin (guard doesn't disable the button itself)", async () => {
    mountSidebar();
    const btn = pinButton();
    act(() => btn.click());
    await h!.flush();
    expect(useStore.getState().pinnedWindows).toEqual(["proj/0"]);
  });

  it("F2 on the focused row itself (not a nested button) still starts a rename", () => {
    // Sanity check the guard is scoped to button targets only — it must not
    // swallow the tree's own keyboard paths for the row.
    mountSidebar();
    focusWindowRow();
    const tree = h!.container.querySelector('[role="tree"]') as HTMLElement;
    act(() => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const renameInput = h!.container.querySelector("input");
    expect(renameInput).toBeTruthy();
    expect((renameInput as HTMLInputElement).value).toBe("win");
  });
});

describe("Sidebar — destructive-key modifier gate + Home/End (BET-937)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    // localStorage persists across tests in this file; clear it so the
    // sidebar's collapse/pin state can't leak in from an earlier test and
    // change the nav-order this block asserts on.
    localStorage.clear();
    installMockApi({
      configUpdate: (patch: Record<string, unknown>) =>
        Promise.resolve({ pinnedWindows: (patch as { pinnedWindows?: string[] }).pinnedWindows ?? [] }),
    });
    resetStore({
      // pinnedWindows must be empty: a prior test toggles a pin and zustand
      // keeps it across tests otherwise, which would change navKeys ordering.
      pinnedWindows: [],
      projects: [
        proj({
          tmuxSession: "proj",
          windows: [
            { index: 0, name: "win", active: true, paneCurrentPath: "/x", opencodeSessionId: null },
          ],
        }),
      ],
    });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function mountSidebar(): Harness {
    h = mount(
      <Sidebar onOpenSettings={() => {}} onNewProject={() => {}} onNewSessionInProject={() => {}} />,
    );
    return h;
  }

  function focusWindowRow() {
    const tree = h!.container.querySelector('[role="tree"]') as HTMLElement;
    act(() => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
  }

  function keyOnTree(key: string, init: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
    const tree = h!.container.querySelector('[role="tree"]') as HTMLElement;
    act(() => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    });
  }

  it("bare Backspace/Delete on a focused row does nothing (no confirm)", () => {
    mountSidebar();
    focusWindowRow();
    keyOnTree("Backspace");
    keyOnTree("Delete");
    // The delete confirm renders through a portal to document.body.
    expect(h!.docText()).not.toContain("Close session");
  });

  it("⌘⌫ opens the confirm for the focused row", () => {
    mountSidebar();
    focusWindowRow();
    keyOnTree("Backspace", { metaKey: true });
    expect(h!.docText()).toContain("Close session");
  });

  it("Ctrl+Delete opens the confirm for the focused row", () => {
    mountSidebar();
    focusWindowRow();
    keyOnTree("Delete", { ctrlKey: true });
    expect(h!.docText()).toContain("Close session");
  });

  it("Home and End jump to the first / last rail row", () => {
    mountSidebar();
    keyOnTree("End");
    const endItems = h!.container.querySelectorAll('[role="treeitem"]');
    const focusedEnd = [...endItems].find((el) => el.getAttribute("tabindex") === "0");
    expect(focusedEnd?.textContent).toContain("win");

    keyOnTree("Home");
    const homeItems = h!.container.querySelectorAll('[role="treeitem"]');
    const focusedHome = [...homeItems].find((el) => el.getAttribute("tabindex") === "0");
    expect(focusedHome?.textContent).toContain("proj");
  });
});
