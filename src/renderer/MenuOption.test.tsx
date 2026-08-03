// @vitest-environment jsdom
//
// Component tests for the MenuOption row primitive (BET-644, M527).
//
// The primitive's "tokens" are class names that map through
// tailwind.config.js to the design tokens (bg-accent-bg → --accent-bg,
// text-accent-tx → --accent-tx, text-text → --tx1, text-text-faint → --tx3,
// bg-fill-hover → --fill-hover, text-label → 13px, rounded-md → --r-md). jsdom
// loads no stylesheet, so the contract is asserted on the exact class strings.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MenuOption } from "./MenuOption";

describe("MenuOption", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders a single-line 34px row by default, as role=option", () => {
    h = mount(<MenuOption label="Sonnet" />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toContain("min-h-[34px]");
    expect(el.className).not.toContain("min-h-[44px]");
    expect(el.getAttribute("role")).toBe("option");
    expect(el.textContent).toContain("Sonnet");
  });

  it("switches to the 44px density when a `sub` line is present", () => {
    h = mount(<MenuOption label="High" sub="Slower, more thorough" />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("min-h-[44px]");
    expect(el.textContent).toContain("Slower, more thorough");
    // The sub-line uses the tx3 faint tier (collision 2 substitutes --tx4).
    const sub = h.container.querySelector("span.text-\\[11\\.5px\\]");
    expect(sub?.className).toContain("text-text-faint");
  });

  it("always reserves the 16px check tick slot, revealed only when selected", () => {
    h = mount(<MenuOption label="A" />);
    const check = h.container.querySelector("svg"); // lucide Check
    expect(check).toBeTruthy();
    const slot = check!.parentElement as HTMLElement;
    expect(slot.className).toContain("opacity-0");
    expect(slot.className).toContain("opacity-");
    h.unmount();

    h = mount(<MenuOption label="A" selected />);
    const slotSelected = h.container.querySelector("svg")!.parentElement as HTMLElement;
    expect(slotSelected.className).toContain("opacity-100");
  });

  it("selected sets the accent-bg fill AND the accent-tx foreground (C1)", () => {
    h = mount(<MenuOption label="Opus" selected />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("bg-accent-bg");
    const label = h.container.querySelector("span.text-label");
    expect(label?.className).toContain("text-accent-tx");
    expect(label?.className).toContain("font-semibold");
  });

  it("an unselected row keeps the label at the base --tx1 tier", () => {
    h = mount(<MenuOption label="Opus" />);
    const label = h.container.querySelector("span.text-label");
    expect(label?.className).toContain("text-text");
    expect(label?.className).not.toContain("text-accent-tx");
  });

  it("gives pointer hover the SAME fill as the roving keyboard highlight", () => {
    // Only the keyboard half used to be implemented, so a mouse user got no
    // feedback at all on the model / effort menus.
    h = mount(<MenuOption label="A" />);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("hover:bg-fill-hover");
    h.unmount();
    h = mount(<MenuOption label="A" active />);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("bg-fill-hover");
  });

  it("keeps the accent tint on a selected row instead of the grey hover fill (C1)", () => {
    h = mount(<MenuOption label="A" selected />);
    const cls = (h.container.firstElementChild as HTMLElement).className;
    expect(cls).toContain("bg-accent-bg");
    expect(cls).not.toContain("hover:bg-fill-hover");
  });

  it("separates rows so a highlight does not touch the row below", () => {
    // 4px, the same gap the sidebar's session rows carry (SessionRow).
    h = mount(<MenuOption label="A" />);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("mb-1");
  });

  it("reflects selection via aria-selected", () => {
    h = mount(<MenuOption label="A" selected />);
    expect((h.container.firstElementChild as HTMLElement).getAttribute("aria-selected")).toBe("true");
    h.unmount();
    h = mount(<MenuOption label="A" />);
    expect((h.container.firstElementChild as HTMLElement).getAttribute("aria-selected")).toBe("false");
  });

  it("renders a trailing node (the context badge)", () => {
    h = mount(
      <MenuOption label="Opus" trailing={<span>1M</span>} />,
    );
    expect(h.container.textContent).toContain("1M");
  });

  it("invokes onSelect when clicked", () => {
    let clicked = false;
    h = mount(<MenuOption label="A" onSelect={() => (clicked = true)} />);
    (h.container.firstElementChild as HTMLElement).click();
    expect(clicked).toBe(true);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If MenuOption ever grew a className prop this directive becomes unused
    // and typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — MenuOption must NOT accept className (M527 decision 3)
    void <MenuOption label="x" className="bg-red-500" />;
    expect(true).toBe(true);
  });
});
