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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
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

  it("renders children while open (default true)", () => {
    h = mount(<Modal label="L">content</Modal>);
    expect(h.text()).toContain("content");
  });

  it("renders nothing when open is false", () => {
    h = mount(<Modal open={false} label="L">content</Modal>);
    expect(h.text()).not.toContain("content");
    expect(h.container.querySelector('div[role="dialog"]')).toBeNull();
  });

  it("removes the dialog from the DOM after close + exit animation", async () => {
    // Modal stays MOUNTED while open; when `open` flips false, the exit
    // animation runs and AnimatePresence removes the chrome only afterwards.
    h = mount(<Modal label="L">content</Modal>);
    expect(h.text()).toContain("content");
    h.rerender(<Modal open={false} label="L">content</Modal>);
    // Let the 0.18s exit run to completion; 400ms comfortably exceeds it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(h.text()).not.toContain("content");
    expect(h.container.querySelector('div[role="dialog"]')).toBeNull();
  });
});

// ===== Escape + focus trap + restore (BET-724) =====
describe("Modal — Escape + focus trap + restore (BET-724)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("calls onDismiss on Escape, regardless of which inner element has focus", () => {
    let dismissed = 0;
    h = mount(
      <Modal label="L" onDismiss={() => dismissed++}>
        <button>ok</button>
      </Modal>,
    );
    const btn = h.container.querySelector("button")!;
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dismissed).toBe(1);
  });

  it("does nothing on Escape when onDismiss is omitted", () => {
    h = mount(
      <Modal label="L">
        <button>ok</button>
      </Modal>,
    );
    const btn = h.container.querySelector("button")!;
    expect(() => {
      act(() => {
        btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }).not.toThrow();
    expect(h.text()).toContain("ok");
    expect(h.container.querySelector('div[role="dialog"]')).toBeTruthy();
  });

  it("focuses the first focusable element inside the panel on open", () => {
    h = mount(
      <Modal label="L">
        <div>
          <span>not focusable</span>
          <button>first</button>
          <button>second</button>
        </div>
      </Modal>,
    );
    const buttons = h.container.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("falls back to focusing the panel itself (tabIndex=-1) when nothing inside is focusable", () => {
    h = mount(<Modal label="L">plain text</Modal>);
    const panel = h.container.querySelector('div[role="dialog"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("tabindex")).toBe("-1");
  });

  it("traps Tab within the panel (wraps last → first)", () => {
    h = mount(
      <Modal label="L">
        <button>first</button>
        <button>second</button>
      </Modal>,
    );
    const buttons = [...h.container.querySelectorAll("button")] as HTMLButtonElement[];
    buttons[1].focus();
    act(() => {
      buttons[1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("restores focus to the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    h = mount(
      <Modal label="L">
        <button>inside</button>
      </Modal>,
    );
    expect(document.activeElement).not.toBe(opener);

    h.unmount();
    h = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // BET-724 review cycle 1 Block: the trap used to force-focus the first
  // focusable element from a passive effect, which runs AFTER React applies
  // `autoFocus` during commit — so it clobbered `autoFocus` (stealing focus
  // onto e.g. a Close button rendered before the autofocused field) and, by
  // reading `document.activeElement` too late, captured the panel's OWN
  // autofocused child as the "opener" instead of the real one, so
  // focus-restore silently no-op'd. Regression-guards both halves.
  it("respects a child's autoFocus instead of stealing it, and still restores the real opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    h = mount(
      <Modal label="L">
        <button aria-label="Close">x</button>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus placeholder="path" />
      </Modal>,
    );
    const input = h.container.querySelector("input")!;
    // Focus stayed on the autofocused input, NOT the earlier Close button.
    expect(document.activeElement).toBe(input);

    h.unmount();
    h = null;
    // Restored to the REAL pre-open opener, not the autofocused input.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

// BET-884: no stylesheet under src/renderer may declare CSS containment.
// `container-type: inline-size` (and any `container:` / `contain:`) applies
// layout containment, which makes the element the containing block for every
// `position: fixed` descendant AND traps its z-index in a new stacking
// context — silently breaking every dialog rendered beneath it (the
// session-header confirm dialogs were rendered inside the 44px header, their
// panels clipped above the window and their buttons dead). Files are read
// from disk so the rule fires even if a sheet is no longer imported
// anywhere. Mirrors the source-reading style of primitives.test.ts.
describe("no CSS containment in renderer stylesheets (BET-884)", () => {
  const SHEETS = [resolve("src/renderer", "index.css"), resolve("src/renderer", "tokens.css")];
  const CONT_CONTAINMENT = /(?:container-type\s*:|container\s*:|contain\s*:)/;

  for (const file of SHEETS) {
    it(`${file} has no containment declaration`, () => {
      const css = readFileSync(file, "utf8");
      const offenders = css
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => CONT_CONTAINMENT.test(line))
        .map((o) => `${o.n}: ${o.line}`);
      expect(
        offenders,
        `${file} must not declare CSS containment — containment makes an ` +
          `element the containing block / stacking context for Modal's ` +
          `position:fixed overlay, silently breaking every dialog rendered ` +
          `beneath it (BET-884). Offending line(s): ` +
          (offenders.join(" | ") || "none"),
      ).toEqual([]);
    });
  }
});
