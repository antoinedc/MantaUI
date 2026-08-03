// @vitest-environment jsdom
//
// Component tests for the IconCard chrome primitive (BET-614, stage 4 of M527).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of IconCard's chrome fails here immediately. Registered
// for the enforce net; no web adopter exists in the currently-named files
// (Settings.tsx / NewSessionScreen.tsx have no icon-above-label tile, reported
// in BET-618), so there is no call-site migration to assert.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { IconCard } from "./IconCard";

const ICARD =
  "flex flex-col items-center gap-2 rounded-md border border-border-subtle " +
  "bg-bg-elev px-2 py-3 text-text-muted";
const ICARD_LABEL = "font-mono text-[10.5px] leading-none font-medium text-text-faint";

function cardEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("IconCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the exact tile + label chrome", () => {
    h = mount(<IconCard icon={<svg />} label="New chat" />);
    expect(cardEl(h).className).toBe(ICARD);
    const label = h.container.querySelector("span") as HTMLElement;
    expect(label.className).toBe(ICARD_LABEL);
  });

  it("renders the icon slot and the label", () => {
    h = mount(<IconCard icon={<svg data-testid="ico" />} label="New chat" />);
    expect(cardEl(h).textContent).toBe("New chat");
    expect(h.container.querySelector('[data-testid="ico"]')).toBeTruthy();
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — IconCard must NOT accept className (M527 decision 3)
    void <IconCard icon={<svg />} label="x" className="bg-red-500">y</IconCard>;
    expect(true).toBe(true);
  });
});
