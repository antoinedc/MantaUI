// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { SidebarToggle } from "./SidebarToggle";

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});

describe("SidebarToggle", () => {
  it("is a labelled button that restores / hides and reports its state in its name", () => {
    const onToggle = vi.fn();
    h = mount(<SidebarToggle hidden={false} onToggle={onToggle} />);
    const btn = h.container.querySelector<HTMLButtonElement>(".manta-sidebar-toggle")!;
    expect(btn.getAttribute("aria-label")).toBe("Hide sidebar");
    act(() => btn.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    h.rerender(<SidebarToggle hidden onToggle={onToggle} />);
    expect(h.container.querySelector(".manta-sidebar-toggle")!.getAttribute("aria-label")).toBe("Show sidebar");
    expect(h.container.querySelector(".manta-sidebar-toggle")!.getAttribute("title")).toMatch(/Show sidebar \(.*B\)/);
  });

  it("sits right of the macOS traffic lights, at the edge elsewhere, and is not a drag region", () => {
    h = mount(<SidebarToggle hidden onToggle={() => {}} isMac />);
    let wrap = h.container.firstElementChild as HTMLElement;
    expect(wrap.style.left).toBe("76px");
    expect(wrap.style.top).toBe("10px");
    expect(wrap.className).toContain("titlebar-no-drag");
    h.rerender(<SidebarToggle hidden onToggle={() => {}} isMac={false} />);
    wrap = h.container.firstElementChild as HTMLElement;
    expect(wrap.style.left).toBe("8px");
  });
});
