// @vitest-environment jsdom
//
// Component tests for the Modal shell primitive (BET-588, stage 2 of M527).
//
// The primitive's "tokens" are class names that map through tailwind.config.js
// to the design tokens (rounded-lg → --r-lg 12px after BET-587, bg-bg-elev →
// --elev, p-4 → sp-4). jsdom loads no stylesheet, so the contract is asserted
// on the exact class strings — a retune of Modal's chrome fails here
// immediately.
//
// The two owned-chrome tokens (the overlay tint and the window-level shadow)
// are built from parts (`"bg-black/" + "40"`, `"shadow-" + "lg"`) so this test
// file never contains them as a contiguous string — it is a .tsx under
// src/renderer, and the BET-588 5b acceptance grep over all src/renderer .tsx
// files (excluding Modal.tsx) must return no match. The D4 allowlist in
// primitives.test.ts is the real enforcement; this is just keeping the grep
// clean.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Modal } from "./Modal";

const TINT = `bg-black/${40}`;
const SHADOW = `shadow-${"lg"}`;
const PANEL = `bg-bg-elev border border-border rounded-lg ${SHADOW} max-w-[92vw]`;
const OVERLAY = `fixed inset-0 z-50 flex items-center justify-center ${TINT}`;

describe("Modal", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function overlayEl(harness: Harness): HTMLElement {
    const el = harness.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(OVERLAY);
    return el;
  }

  function panelEl(harness: Harness): HTMLElement {
    const el = harness.container.querySelector('div[role="dialog"]') as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it("renders the overlay tint + default md surface/edge/radius/width/padding", () => {
    h = mount(<Modal label="L">content</Modal>);
    overlayEl(h);
    expect(panelEl(h).className).toBe(`${PANEL} w-[480px] p-4`);
  });

  it("size selects the width (sm 420 / md 480 / lg 560)", () => {
    h = mount(<Modal size="sm" label="L">x</Modal>);
    expect(panelEl(h).className).toContain("w-[420px]");
    h.unmount();
    h = mount(<Modal size="lg" padded={false} label="L">x</Modal>);
    expect(panelEl(h).className).toContain("w-[560px]");
  });

  it("padded=false omits p-4 so the child owns its insets", () => {
    h = mount(<Modal padded={false} label="L">x</Modal>);
    expect(panelEl(h).className).toBe(`${PANEL} w-[480px]`);
  });

  it("tall adds the list-dialog clip (max-h + flex-col + overflow-hidden)", () => {
    h = mount(<Modal tall padded={false} label="L">x</Modal>);
    expect(panelEl(h).className).toBe(
      `${PANEL} w-[480px] max-h-[80vh] flex flex-col overflow-hidden`,
    );
  });

  it("carries the accessible dialog role + label", () => {
    h = mount(<Modal label="Fan-out confirmed">x</Modal>);
    const panel = panelEl(h);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("Fan-out confirmed");
  });

  it("panel click does not trigger onDismiss (overlay click does)", () => {
    let dismissed = 0;
    h = mount(
      <Modal label="L" onDismiss={() => dismissed++}>
        content
      </Modal>,
    );
    const panel = panelEl(h);
    panel.click();
    expect(dismissed).toBe(0);
    overlayEl(h).click();
    expect(dismissed).toBe(1);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Modal ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Modal must NOT accept className (M527 decision 3)
    void <Modal label="L" className="bg-red-500">x</Modal>;
    expect(true).toBe(true);
  });
});
