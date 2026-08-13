// @vitest-environment jsdom
//
// Component tests for the Callout chrome primitive (BET-614, stage 3 of M527).
//
// The "tokens" are class names mapped through tailwind.config.js to the design
// tokens (border-l-[3px] → the 3px accent bar, bg-accent-bg → --accent-bg,
// text-text-muted → --tx2). jsdom loads no stylesheet, so the contract is
// asserted on the exact class strings — a retune of Callout's chrome fails
// here immediately. The two adopters (Onboarding.tsx + ConnectProvider.tsx)
// are migrated through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Callout } from "./Callout";

const BASE =
  "border-l-[3px] rounded-r-[var(--r-md)] px-4 py-3 my-4 max-w-[78ch] text-body text-text-muted";

const TONE = {
  info: "border-l-accent bg-accent-bg",
  ok: "border-l-ok bg-ok-bg",
  warn: "border-l-warn bg-warn-bg",
  danger: "border-l-danger bg-danger-bg",
} as const;

function calloutEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Callout", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the base chrome plus the required tone classes for each tone", () => {
    (Object.keys(TONE) as (keyof typeof TONE)[]).forEach((tone) => {
      h?.unmount();
      h = mount(<Callout tone={tone}>Body</Callout>);
      expect(calloutEl(h).className).toBe(`${BASE} ${TONE[tone]}`);
    });
  });

  it("renders children", () => {
    h = mount(<Callout tone="warn">Watch out</Callout>);
    expect(calloutEl(h).textContent).toBe("Watch out");
  });

  it("renders the smaller note geometry when size='note' (the review pane's inline diff note)", () => {
    const NOTE =
      "border-l-2 rounded-r-[var(--r-sm)] px-[11px] py-2 my-[6px] max-w-[62ch] text-meta text-text-muted border-l-accent bg-accent-bg";
    h = mount(
      <Callout tone="info" size="note">
        Draft
      </Callout>,
    );
    expect(calloutEl(h).className).toBe(NOTE);
  });

  it("has no tone default — tone is required (compile-time)", () => {
    // If Callout ever gained a default tone this directive becomes unused and
    // typecheck fails — the C4 required-no-default guard lives in the types.
    // @ts-expect-error — Callout must NOT omit tone (BET-614, C4)
    void <Callout>Body</Callout>;
    expect(true).toBe(true);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — Callout must NOT accept className (M527 decision 3)
    void <Callout tone="info" className="bg-red-500">x</Callout>;
    expect(true).toBe(true);
  });
});
