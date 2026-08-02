// @vitest-environment jsdom
//
// Component tests for the Eyebrow chrome primitive (BET-614, stage 4 of M527).
//
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// string — a retune of Eyebrow's chrome fails here immediately. The adopter
// (Settings.tsx, the GroupCard section label) is migrated through the real
// exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Eyebrow } from "./Eyebrow";

const EYEBROW =
  "block font-semibold text-[11px] leading-none tracking-[.1em] uppercase text-accent-tx mb-3";

function browEl(h: Harness): HTMLElement {
  const el = h.container.firstElementChild as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Eyebrow", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the exact eyebrow chrome", () => {
    h = mount(<Eyebrow>AI</Eyebrow>);
    expect(browEl(h).className).toBe(EYEBROW);
  });

  it("renders the label text", () => {
    h = mount(<Eyebrow>AI providers</Eyebrow>);
    expect(browEl(h).textContent).toBe("AI providers");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — Eyebrow must NOT accept className (M527 decision 3)
    void <Eyebrow className="text-red-500">x</Eyebrow>;
    expect(true).toBe(true);
  });
});
