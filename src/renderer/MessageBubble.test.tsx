// @vitest-environment jsdom
//
// Component tests for the MessageBubble user-message chrome primitive
// (BET-637). The "tokens" are class names mapped through tailwind.config.js
// to the design tokens (bg-fill → var(--fill), border-border-subtle →
// var(--border-subtle), rounded-lg → var(--r-lg), text-prose → 15px/1.55,
// text-text → var(--tx1)); the 88% cap and the 11px vertical padding are the
// primitive's off-grid spec values. jsdom loads no stylesheet, so the
// contract is asserted on the exact class strings. The single adopter
// (MessageRow.tsx) migrates through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MessageBubble } from "./MessageBubble";

const BUBBLE_CHROME =
  "bg-fill border border-border-subtle rounded-lg px-4 py-[11px] text-prose text-text max-w-[min(88%,var(--measure))] whitespace-pre-wrap break-words manta-bubble-in";

describe("MessageBubble", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — MessageBubble must NOT accept className (M527 decision 3)
    void <MessageBubble className="bg-red-500">x</MessageBubble>;
    expect(true).toBe(true);
  });

  it("caps the bubble against both 88% of its container and the reading measure", () => {
    // BET-646: with the transcript now uncapped, a bare 88% would stretch the
    // bubble across a wide window. The cap is the min() of the two terms.
    expect(BUBBLE_CHROME).toContain("max-w-[min(88%,var(--measure))]");
    expect(BUBBLE_CHROME).not.toContain("max-w-[88%]");
  });

  it("renders a right-aligned wrapper around the bubble chrome", () => {
    h = mount(<MessageBubble>Hello</MessageBubble>);
    const wrapper = h.container.firstElementChild as HTMLElement;
    expect(wrapper.className).toBe("flex justify-end");
    const bubble = wrapper.firstElementChild as HTMLElement;
    expect(bubble.className).toBe(BUBBLE_CHROME);
    expect(bubble.textContent).toBe("Hello");
  });
});
