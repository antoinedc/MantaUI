// @vitest-environment jsdom
//
// The rail's gliding hover highlight (src/renderer/RailGlide.tsx). jsdom does
// no layout, so every rect is 0×0 — these tests pin the STATE MACHINE (does
// the highlight show, hide, and snap on first appearance), not the geometry.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { useRailGlide } from "./RailGlide";

function Rail() {
  const glide = useRailGlide();
  return (
    <div {...glide.containerProps} data-testid="rail">
      {glide.glide}
      <div data-rail-row="" data-testid="row-a">
        <span data-testid="row-a-child">a</span>
      </div>
      <div data-rail-row="" data-testid="row-b">b</div>
      <div data-testid="not-a-row">header</div>
    </div>
  );
}

function fire(el: Element, type: "mouseover" | "mouseleave") {
  el.dispatchEvent(new MouseEvent(type, { bubbles: type === "mouseover" }));
}

describe("useRailGlide", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function glideEl(): HTMLElement {
    const el = h!.container.querySelector("span.rail-glide") as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it("renders one hidden, aria-hidden highlight at rest", () => {
    h = mount(<Rail />);
    expect(h.container.querySelectorAll("span.rail-glide").length).toBe(1);
    expect(glideEl().getAttribute("data-shown")).toBe("false");
    expect(glideEl().getAttribute("aria-hidden")).toBe("true");
  });

  it("shows on a row, including when the event starts on a row descendant", async () => {
    h = mount(<Rail />);
    fire(h.container.querySelector('[data-testid="row-a-child"]')!, "mouseover");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("true");
  });

  it("snaps into place on first appearance, then glides", async () => {
    h = mount(<Rail />);
    fire(h.container.querySelector('[data-testid="row-a"]')!, "mouseover");
    await h.flush();
    // The snap flag clears on the next animation frame; after flush the
    // highlight must be free to animate to the next row.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await h.flush();
    expect(glideEl().getAttribute("data-snap")).toBe("false");
    fire(h.container.querySelector('[data-testid="row-b"]')!, "mouseover");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("true");
    expect(glideEl().getAttribute("data-snap")).toBe("false");
  });

  it("hides over a non-row area and when the pointer leaves the rail", async () => {
    h = mount(<Rail />);
    fire(h.container.querySelector('[data-testid="row-a"]')!, "mouseover");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("true");

    fire(h.container.querySelector('[data-testid="not-a-row"]')!, "mouseover");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("false");

    fire(h.container.querySelector('[data-testid="row-a"]')!, "mouseover");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("true");

    fire(h.container.querySelector('[data-testid="rail"]')!, "mouseleave");
    await h.flush();
    expect(glideEl().getAttribute("data-shown")).toBe("false");
  });
});
