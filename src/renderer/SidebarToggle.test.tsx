// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { SidebarRevealButton, SidebarToggleButton } from "./SidebarToggle";
import { getAppState, resetExplorerStore, setSidebarHidden } from "./explorer/explorerStore";

let h: Harness | null = null;
beforeEach(() => {
  localStorage.clear();
  resetExplorerStore();
});
afterEach(() => {
  h?.unmount();
  h = null;
});

describe("SidebarToggleButton", () => {
  it("is a labelled button that flips the sidebar and reports its state in its name", () => {
    h = mount(<SidebarToggleButton hidden={false} />);
    const btn = () => h!.container.querySelector<HTMLButtonElement>(".manta-sidebar-toggle")!;
    expect(btn().getAttribute("aria-label")).toBe("Hide sidebar");
    expect(btn().getAttribute("title")).toMatch(/Hide sidebar \(.*B\)/);
    act(() => btn().click());
    expect(getAppState().sidebarHidden).toBe(true);
    expect(localStorage.getItem("manta:sidebarHidden")).toBe("1");

    h.rerender(<SidebarToggleButton hidden />);
    expect(btn().getAttribute("aria-label")).toBe("Show sidebar");
    expect(btn().getAttribute("title")).toMatch(/Show sidebar \(.*B\)/);
    act(() => btn().click());
    expect(getAppState().sidebarHidden).toBe(false);
  });
});

describe("SidebarRevealButton", () => {
  it("renders nothing while the sidebar is visible", () => {
    h = mount(<SidebarRevealButton />);
    expect(h.container.innerHTML).toBe("");
  });

  it("appears while the sidebar is hidden, restores it on press, and is not a drag region", () => {
    h = mount(<SidebarRevealButton />);
    act(() => setSidebarHidden(true));
    const btn = h.container.querySelector<HTMLButtonElement>(".manta-sidebar-toggle")!;
    expect(btn.getAttribute("aria-label")).toBe("Show sidebar");
    expect((h.container.firstElementChild as HTMLElement).className).toContain("titlebar-no-drag");
    act(() => btn.click());
    expect(getAppState().sidebarHidden).toBe(false);
    expect(h.container.innerHTML).toBe("");
  });
});
