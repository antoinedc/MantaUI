// @vitest-environment jsdom
//
// Component tests for the Checkbox chrome primitive (BET-589, stage 3 of 4).
//
// As with the other primitives, Checkbox's "tokens" are class names that map
// through tailwind.config.js to the design tokens (w-4 → 16px, rounded-xs →
// --r-xs 4px, border-border-strong → --border-strong, bg-bg → --canvas,
// bg-accent-solid → --accent-solid, text-on-accent → --on-accent,
// outline-accent → --accent). jsdom loads no stylesheet, so the contract is
// asserted on the exact class strings — a retune of Checkbox's chrome fails
// here immediately.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Checkbox } from "./Checkbox";

function checkboxEl(h: Harness): HTMLInputElement {
  const el = h.container.querySelector("input") as HTMLInputElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Checkbox", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("keeps a real hidden input and drives the check glyph from the checked prop", () => {
    h = mount(<Checkbox checked={false} onChange={() => {}} ariaLabel="toggle" />);
    const el = checkboxEl(h);
    expect(el.type).toBe("checkbox");
    expect(el.checked).toBe(false);
    // Glyph stays out of the DOM when unchecked.
    expect(h.container.querySelector("svg")).toBeNull();
    expect(el.className).toContain("sr-only");
    expect(el.className).toContain("peer");
  });

  it("renders the 16px box, --border-strong border, --r-xs radius and canvas fill per the contract", () => {
    h = mount(<Checkbox checked={false} onChange={() => {}} ariaLabel="toggle" />);
    const box = h.container.querySelector("label > span") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.className).toContain("w-4");
    expect(box.className).toContain("h-4");
    expect(box.className).toContain("rounded-xs");
    expect(box.className).toContain("border-border-strong");
    expect(box.className).toContain("bg-bg");
    expect(box.className).toContain("peer-focus-visible:outline-accent");
  });

  it("fills with --accent-solid and shows the 12px check glyph in --on-accent when checked", () => {
    h = mount(<Checkbox checked onChange={() => {}} ariaLabel="toggle" />);
    const box = h.container.querySelector("label > span") as HTMLElement;
    expect(box.className).toContain("bg-accent-solid");
    expect(box.className).toContain("text-on-accent");
    expect(h.container.querySelector("svg")).not.toBeNull();
    // REGRESSION: the canvas fill must be GONE when checked. Both are
    // backgroundColor utilities of equal specificity, and Tailwind emits
    // `.bg-bg` after `.bg-accent-solid`, so keeping both left the box on the
    // canvas fill with an --on-accent glyph on it — an invisible checkmark.
    expect(box.className).not.toContain("bg-bg");
  });

  it("renders the label prop as text after the box and propagates it as the accessible name", () => {
    h = mount(<Checkbox checked={false} onChange={() => {}} label="worktree" />);
    expect(h.container.textContent).toContain("worktree");
    expect(checkboxEl(h).getAttribute("aria-label")).toBeNull();
  });

  it("requires ariaLabel when the call site supplies its own text (no label prop)", () => {
    h = mount(<Checkbox checked={false} onChange={() => {}} ariaLabel="Main availability" />);
    expect(h.container.textContent ?? "").toBe("");
    expect(checkboxEl(h).getAttribute("aria-label")).toBe("Main availability");
  });

  it("reports the new checked state and renders the disabled attributes + not-allowed cursor when disabled", () => {
    let last: boolean | null = null;
    h = mount(<Checkbox checked={false} onChange={(v) => (last = v)} ariaLabel="toggle" />);
    const el = checkboxEl(h);
    el.click();
    expect(last).toBe(true);
    h.rerender(<Checkbox checked disabled onChange={() => {}} ariaLabel="toggle" />);
    const el2 = checkboxEl(h);
    expect(el2.disabled).toBe(true);
    const label = h.container.querySelector("label") as HTMLElement;
    expect(label.className).toContain("cursor-not-allowed");
    expect(label.className).toContain("opacity-50");
  });

  it("uses a pointer cursor by default (enabled)", () => {
    h = mount(<Checkbox checked={false} onChange={() => {}} ariaLabel="toggle" />);
    const label = h.container.querySelector("label") as HTMLElement;
    expect(label.className).toContain("cursor-pointer");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Checkbox ever grew a className prop this directive becomes unused
    // and typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Checkbox must NOT accept className (M527 decision 3)
    void <Checkbox checked={false} onChange={() => {}} ariaLabel="x" className="bg-red-500" />;
    expect(true).toBe(true);
  });
});
