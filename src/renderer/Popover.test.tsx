// @vitest-environment jsdom
//
// BET-865 — the portalled Popover primitive. These pin the two properties that
// the whole migration exists to guarantee:
//   - dismissal must not fire on a click INSIDE the popover (because the panel
//     is portalled to <body>, a naive click-away predicate would close the
//     popover on its own buttons — the regression this test guards),
//   - the surface is a child of <body>, so no ancestor can clip or stack-trap
//     it (the reported "renders behind the transcript" bug).

import { describe, it, expect, afterEach } from "vitest";
import { act, useRef } from "react";
import { mount, mountSessionHeader, type Harness } from "./testHarness";
import { Popover } from "./Popover";

// Renders a trigger button + a Popover whose open state is externally
// controlled by `open` / `onToggle` so the test can observe onClose calls.
function TestPopover({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        trigger
      </button>
      <Popover open={open} onClose={onClose} anchorRef={anchorRef}>
        {children}
      </Popover>
    </>
  );
}

function surface(h: Harness): HTMLElement {
  return document.body.querySelector('.manta-menu-in') as HTMLElement;
}

function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
}

describe("Popover — portalled dismissal (BET-865)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the surface as a direct child of <body> (no ancestor can clip it)", () => {
    h = mount(<TestPopover open onClose={() => {}} />);
    const el = surface(h);
    expect(el).toBeTruthy();
    // Portalled to <body>, NOT nested inside the trigger's subtree / container.
    expect(el.parentElement).toBe(document.body);
  });

  it("does NOT close when clicking a button INSIDE the popover", () => {
    let closed = 0;
    h = mount(
      <TestPopover
        open
        onClose={() => closed++}
      >
        <button type="button">Open on GitHub ↗</button>
      </TestPopover>,
    );
    const inner = [...surface(h).querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Open on GitHub"),
    )!;
    expect(inner).toBeTruthy();
    click(inner);
    expect(closed).toBe(0);
  });

  it("closes when clicking outside the anchor AND the panel", () => {
    let closed = 0;
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    h = mount(<TestPopover open onClose={() => closed++} />);
    try {
      // A click on an unrelated body node (neither the anchor nor the panel).
      click(document.body);
      expect(closed).toBe(1);
    } finally {
      anchor.remove();
    }
  });

  it("renders nothing when closed", () => {
    h = mount(<TestPopover open={false} onClose={() => {}} />);
    expect(surface(h)).toBeFalsy();
  });
});

// Criterion 5 (BET-865): the checks/context popover opened from the status
// overflow (`⋯ +N`, only present at narrow pane widths) must render full size
// over the transcript — i.e. it is portalled out of the overflow menu that used
// to clip it (`overflow-hidden` + a scrolling body).
describe("StatusOverflow — the overflow Dropdown is portalled, not clipped (BET-865)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // Drive the real header's ResizeObserver (like SessionHeader.overflow.test)
  // so the pane reads narrow and the overflow trigger + its dropdown exist.
  type Captured = { cb: () => void; el: Element | null };
  let captured: Captured | null = null;
  class FakeResizeObserver {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      captured = { cb, el: null };
    }
    observe(el: Element) {
      if (captured) captured.el = el;
    }
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error — deliberately swap the (previously stubbed) global.
  globalThis.ResizeObserver = FakeResizeObserver;

  it("renders the overflow surface on <body>, outside the scrolling menu body", () => {
    h = mountSessionHeader({
      ctxBreakdown: {
        freshInput: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        totalInput: 1000,
        pct: 2,
        segments: [],
      },
      ctxLimit: 100_000,
    });
    // Force the pane to a width below the <420px cut so the context item
    // lands in the overflow.
    const header = h.container.querySelector<HTMLElement>(".manta-session-header");
    expect(header).not.toBeNull();
    header!.getBoundingClientRect = () =>
      ({ width: 300, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }) as DOMRect;
    act(() => captured!.cb());

    // Open the overflow trigger ("⋯ +N").
    const trigger = h.container.querySelector<HTMLElement>(".manta-status-overflow-trigger");
    expect(trigger).toBeTruthy();
    act(() => trigger!.click());

    const surface = document.body.querySelector<HTMLElement>(
      ".manta-status-overflow-dropdown",
    );
    expect(surface, "overflow dropdown should render portalled onto <body>").toBeTruthy();
    // The surface is a direct child of <body> — NOT nested under any
    // overflow-hidden ancestor, so it can never be clipped to a menu row.
    expect(surface!.parentElement).toBe(document.body);
  });
});
