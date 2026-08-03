// @vitest-environment jsdom
//
// Component tests for the Button chrome primitive (BET-614, stage 1 of M527).
//
// As with the other primitives, the "tokens" are class names that map through
// tailwind.config.js to the design tokens (rounded-md → --r-md, px-[14px] →
// 14px, h-8 → 32px, text-accent → --accent). jsdom loads no stylesheet, so the
// contract is asserted on the exact class strings — a retune of Button's chrome
// fails here immediately. The two adopters (Settings.tsx + FolderPickerModal.tsx)
// are migrated below through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Button } from "./Button";

const CHROME =
  "inline-flex items-center gap-[6px] h-8 px-[14px] rounded-md border text-[12.5px] font-medium leading-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed";

const TONE = {
  default: "border-border bg-bg text-text hover:bg-raised hover:border-border-strong",
  primary: "border-accent-solid bg-accent-solid text-on-accent hover:brightness-110",
  ghost: "border-transparent bg-transparent text-text-faint hover:bg-fill-hover hover:text-text",
  danger: "border-transparent bg-transparent text-danger hover:bg-danger-bg",
} as const;

function buttonEl(h: Harness): HTMLButtonElement {
  const el = h.container.querySelector("button") as HTMLButtonElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Button", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the base chrome plus the required tone classes for each of the four tones", () => {
    (Object.keys(TONE) as (keyof typeof TONE)[]).forEach((tone) => {
      h?.unmount();
      h = mount(<Button tone={tone}>Save</Button>);
      expect(buttonEl(h).className).toBe(`${CHROME} ${TONE[tone]}`);
    });
  });

  it("has no size prop — one size only (the spec has no .btn.sm rule)", () => {
    // If Button ever grew a `size` prop this directive becomes unused and
    // typecheck fails.
    // @ts-expect-error — Button must NOT accept a size prop (BET-614, C4)
    void <Button tone="default" size="sm">x</Button>;
    expect(true).toBe(true);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Button ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Button must NOT accept className (M527 decision 3)
    void <Button tone="default" className="bg-red-500">x</Button>;
    expect(true).toBe(true);
  });

  it("renders the label as children", () => {
    h = mount(<Button tone="primary">Select folder</Button>);
    expect(buttonEl(h).textContent).toBe("Select folder");
  });

  it("passes onClick through", () => {
    let clicked = 0;
    h = mount(<Button tone="default" onClick={() => clicked++}>Go</Button>);
    buttonEl(h).click();
    expect(clicked).toBe(1);
  });

  it("wires the native disabled attribute", () => {
    h = mount(<Button tone="default" disabled>Go</Button>);
    expect(buttonEl(h).disabled).toBe(true);
  });

  it("defaults type to button and passes an explicit type through", () => {
    h = mount(<Button tone="default">Go</Button>);
    expect(buttonEl(h).getAttribute("type")).toBe("button");
    h.rerender(<Button tone="default" type="submit">Go</Button>);
    expect(buttonEl(h).getAttribute("type")).toBe("submit");
  });

  it("passes title through as the native tooltip", () => {
    h = mount(<Button tone="default" title="Save changes">Save</Button>);
    expect(buttonEl(h).getAttribute("title")).toBe("Save changes");
  });

  it("prepends a manta-* hook class when provided", () => {
    h = mount(<Button tone="default" hook="manta-folder-confirm">Save</Button>);
    expect(buttonEl(h).className).toBe(`manta-folder-confirm ${CHROME} ${TONE.default}`);
  });
});
