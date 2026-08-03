// @vitest-environment jsdom
//
// Component tests for the StatusDot chrome primitive (BET-636).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of the dot's chrome fails here immediately. The two
// adopters (ToolCard.tsx via its header, and TaskCard.tsx via the subagent
// status line) are migrated through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { StatusDot } from "./StatusDot";

const DOT = "w-[6px] h-[6px] rounded-full shrink-0";

function dot(h: Harness): HTMLElement {
  const el = h.container.querySelector("span") as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("StatusDot", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — StatusDot must NOT accept className (M527 decision 3)
    void <StatusDot tone="ok" className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("renders the 6px circle with the ok tone", () => {
    h = mount(<StatusDot tone="ok" />);
    expect(dot(h).className).toBe(`${DOT} bg-ok`);
  });

  it("switches to the running tone (accent + pulse)", () => {
    h = mount(<StatusDot tone="running" />);
    expect(dot(h).className).toBe(`${DOT} bg-accent animate-pulse`);
  });

  it("switches to the error tone", () => {
    h = mount(<StatusDot tone="error" />);
    expect(dot(h).className).toBe(`${DOT} bg-danger`);
  });

  it("switches to the idle tone", () => {
    h = mount(<StatusDot tone="idle" />);
    expect(dot(h).className).toBe(`${DOT} bg-text-quiet`);
  });
});
