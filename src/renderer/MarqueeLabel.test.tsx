// @vitest-environment jsdom
//
// MarqueeLabel — the invariant under test is GEOMETRY, not motion: a label must
// occupy exactly the same box whether or not its text is truncated and whether
// or not the pointer is over it. BET-1172 shipped the resting copy and the
// sliding copy as two in-flow siblings (the sliding one merely
// `visibility:hidden`), which reserves a second line and made every truncated
// sidebar row double height. These tests pin the fix: the sliding copy is
// absolutely positioned (out of flow), and the hover swap is a visibility flip
// on both copies — never `display`, which would collapse the box on hover.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, type Harness } from "./testHarness";
import { MarqueeLabel } from "./MarqueeLabel";

// jsdom performs no layout, so `over` can never become true on its own. Stub
// the two metrics `measure` reads so a test can choose "truncated" or not.
function stubLayout(scrollWidth: number, clientWidth: number): () => void {
  const proto = HTMLElement.prototype;
  const prev = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, "scrollWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  };
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => clientWidth });
  return () => {
    for (const k of ["scrollWidth", "clientWidth"] as const) {
      const d = prev[k];
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

describe("MarqueeLabel — the box never changes", () => {
  let h: Harness | null = null;
  let restore: (() => void) | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    restore?.();
    restore = null;
  });

  it("not truncated: one in-flow ellipsized copy, no marquee, no overlay", () => {
    restore = stubLayout(100, 100);
    h = mount(<MarqueeLabel>Add CSV export</MarqueeLabel>);
    const clip = h.container.firstElementChild as HTMLElement;
    expect(clip.className).not.toContain("manta-marquee ");
    expect(clip.children).toHaveLength(1);
    const rest = clip.firstElementChild as HTMLElement;
    expect(rest.className).toContain("manta-marquee-rest");
    expect(rest.className).toContain("truncate");
    expect(clip.textContent).toBe("Add CSV export");
  });

  it("truncated: the sliding copy is OUT OF FLOW so the label keeps one line", () => {
    restore = stubLayout(300, 200);
    h = mount(<MarqueeLabel>Add CSV export</MarqueeLabel>);
    const clip = h.container.firstElementChild as HTMLElement;
    expect(clip.className).toContain("manta-marquee");
    expect(clip.className).toContain("relative"); // containing block for the overlay
    expect(clip.getAttribute("style")).toContain("--marquee-shift: 100px");

    // Exactly two copies, and only the resting one is in flow.
    expect(clip.children).toHaveLength(2);
    const rest = clip.children[0] as HTMLElement;
    const inner = clip.children[1] as HTMLElement;
    expect(rest.className).toContain("manta-marquee-rest");
    expect(rest.className).not.toContain("absolute");
    expect(inner.className).toContain("manta-marquee-inner");
    // THE regression guard: an in-flow second copy is what doubled row height.
    expect(inner.className).toContain("absolute");
    expect(inner.className).toContain("whitespace-nowrap");
    // ...and it must not re-introduce the BET-1154 width mutation either.
    expect(inner.className).not.toContain("max-w-full");
    expect(inner.className).not.toContain("text-ellipsis");
  });

  it("measures the resting copy, so hovering the overlay cannot re-trigger it", () => {
    restore = stubLayout(260, 200);
    h = mount(<MarqueeLabel title="Add CSV export">Add CSV export</MarqueeLabel>);
    const clip = h.container.firstElementChild as HTMLElement;
    expect(clip.getAttribute("title")).toBe("Add CSV export");
    expect(clip.getAttribute("style")).toContain("--marquee-shift: 60px");
  });

  it("the hover swap is visibility-only — `display:none` would collapse the box", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/index.css"), "utf8");
    const hoverRest = css.match(/\.manta-marquee:hover \.manta-marquee-rest \{([^}]*)\}/);
    expect(hoverRest).not.toBeNull();
    expect(hoverRest![1]).toContain("visibility");
    // With the sliding copy out of flow, `display:none` on the resting copy
    // leaves the label with no in-flow content — it collapses to zero height
    // the instant the pointer arrives.
    expect(hoverRest![1]).not.toContain("display");
  });
});
