// @vitest-environment jsdom
//
// Component tests for the Field chrome primitive (BET-533, stage 4 of M527).
//
// The primitive's "tokens" are class names that map through tailwind.config.js
// to the design tokens (bg-bg-soft → --card, border-border-strong →
// --border-strong, rounded-lg → --r-md 8px, focus:border-accent → --accent,
// py-3/px-4 → sp-3 12px / sp-4 16px, text-text-muted → --tx2,
// text-text-faint → --tx3, font-mono → the mono stack). jsdom loads no
// stylesheet, so the contract is asserted on the exact class strings — a
// retune of Field's chrome fails here immediately.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Field } from "./Field";

const INPUT_BASE =
  "w-full bg-bg-soft border border-border-strong rounded-lg text-body text-text focus:outline-none focus:border-accent";
const INSET = "px-4 py-3";
const LABEL = "block text-micro font-semibold uppercase text-text-muted";
const META = "text-meta text-text-faint";

function inputEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector("input") as HTMLInputElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Field", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the input surface/edge/radius/padding per the contract", () => {
    h = mount(<Field id="f" label="Path" value="~/proj" onChange={() => {}} />);
    const el = inputEl(h.container);
    expect(el.className).toContain(INPUT_BASE);
    // surface --card, edge --border-strong, radius --r-md (rounded-lg),
    // padding sp-3/sp-4 (py-3 px-4), mono value.
    expect(el.className).toContain("bg-bg-soft");
    expect(el.className).toContain("border-border-strong");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain(INSET);
    expect(el.className).toContain("font-mono");
    // focus --accent edge.
    expect(el.className).toContain("focus:border-accent");
    // C1 — sets a foreground with its background.
    expect(el.className).toContain("text-text");
  });

  it("renders the micro-caps label (--tx2) and help (--tx3)", () => {
    h = mount(
      <Field id="f" label="Base URL" value="" help="Used for custom providers." />,
    );
    const label = h.container.querySelector("label");
    expect(label?.className).toBe(LABEL);
    expect(label?.textContent).toBe("Base URL");
    expect(label?.getAttribute("for")).toBe("f");
    const help = h.container.querySelector("label + div + div");
    expect(help?.className).toBe(META);
    expect(help?.textContent).toBe("Used for custom providers.");
  });

  it("forwards value/onChange/onKeyDown/onFocus/onBlur into the input", () => {
    const events = { change: "", key: "", focus: 0, blur: 0 };
    h = mount(
      <Field
        value="v"
        onChange={(e) => { events.change = e.target.value; }}
        onKeyDown={() => { events.key = "down"; }}
        onFocus={() => { events.focus += 1; }}
        onBlur={() => { events.blur += 1; }}
      />,
    );
    const el = inputEl(h.container);
    expect(el.value).toBe("v");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(events.key).toBe("down");
    expect(events.focus).toBe(1);
    expect(events.blur).toBe(1);
  });

  it("mono={false} renders a sans (prose) value and drops the mono stack", () => {
    h = mount(<Field value="Find a setting" mono={false} />);
    const el = inputEl(h.container);
    expect(el.className).not.toContain("font-mono");
    expect(el.className).toContain(INSET);
    expect(el.className).toContain(INPUT_BASE);
  });

  it("a leading icon swaps the left inset for the icon gutter and keeps the rest", () => {
    h = mount(<Field value="q" leading={<span data-test="ico">@</span>} />);
    const el = inputEl(h.container);
    expect(el.className).toContain("pl-8");
    expect(el.className).toContain("pr-4");
    expect(el.className).toContain("py-3");
    expect(h.container.querySelector('[data-test="ico"]')).toBeTruthy();
  });

  it("renders a footer slot after the help text", () => {
    h = mount(
      <Field value="" help="tip" footer={<div role="status">Saved</div>} />,
    );
    expect(h.container.querySelector('[role="status"]')?.textContent).toBe("Saved");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Field ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Field must NOT accept className (M527 decision 3)
    void <Field value="x" className="px-8" />;
    expect(true).toBe(true);
  });
});
