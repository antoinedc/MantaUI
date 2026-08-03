// @vitest-environment jsdom
//
// Component tests for the Tag chrome primitive (BET-614, stage 4 of M527).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of Tag's chrome fails here immediately. The adopter
// (SessionHeader.tsx, the branch indicator) is migrated through the real
// exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Tag } from "./Tag";

const TAG =
  "inline-flex items-center gap-[5px] h-[23px] px-2 rounded-full border border-border " +
  "font-mono text-[11.5px] leading-none font-medium bg-fill text-text-faint";

function tagEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Tag", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the exact tag chrome", () => {
    h = mount(<Tag>main</Tag>);
    expect(tagEl(h).className).toBe(TAG);
  });

  it("renders the label and an optional icon slot", () => {
    h = mount(
      <Tag icon={<svg data-testid="ico" />}>
        <span className="truncate">feature/x</span>
      </Tag>,
    );
    expect(tagEl(h).textContent).toBe("feature/x");
    expect(h.container.querySelector('[data-testid="ico"]')).toBeTruthy();
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — Tag must NOT accept className (M527 decision 3)
    void <Tag className="bg-red-500">x</Tag>;
    expect(true).toBe(true);
  });
});
