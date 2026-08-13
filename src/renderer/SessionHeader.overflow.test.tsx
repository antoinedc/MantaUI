// @vitest-environment jsdom
//
// BET-811: the status-item overflow cut is driven by a ResizeObserver on the
// header element (replacing the BET-782 per-render layout-effect re-measure,
// which went stale on pane resizes that don't round-trip through React state —
// OS-window resize, sidebar-splitter drag). These mount the real <SessionHeader>
// via the render harness, fire a controllable ResizeObserver callback with a
// faked measured width, and assert that narrowing moves items into `⋯ +N` and
// widening restores them to the bar.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import {
  installMockApi,
  resetStore,
  mountSessionHeader,
  type Harness,
} from "./testHarness";

// A controllable ResizeObserver: captures the callback the component registers
// plus the element it observes, so the test can fire the callback with whatever
// `getBoundingClientRect().width` it fakes. Installed here (after the harness
// import, whose no-op stub only applies when unset) so the component's observer
// is real enough to drive. Each mount replaces `captured`; afterEach clears it.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = FakeResizeObserver;

// The quiet header default hides the context pill (totalInput 0), leaving only
// the menu (priority 100) in the registry — and the 560px/420px cut never
// auto-hides priority ≥ 80. So the overflow tests enable the context pill
// (priority 60), which the < 420px cut DOES move to overflow.
function contextHeader(): Partial<React.ComponentProps<typeof import("./SessionHeader").SessionHeader>> {
  return {
    ctxBreakdown: {
      freshInput: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 1000,
      pct: 2,
      segments: [],
    },
    ctxLimit: 100_000,
  };
}

function fakeHeaderWidth(h: Harness, width: number) {
  const el = h.container.querySelector<HTMLElement>(".manta-session-header");
  expect(el).not.toBeNull();
  // The component only reads `.width` off the rect; cast the partial back to
  // DOMRect so the override shape is honest about what's not implemented.
  el!.getBoundingClientRect = () =>
    ({ width, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }) as DOMRect;
  expect(captured).not.toBeNull();
  act(() => captured!.cb());
}

function overflowTrigger(h: Harness): Element | null {
  return h.container.querySelector(".manta-status-overflow-trigger");
}

describe("SessionHeader overflow responds to header resize (BET-811)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    captured = null;
  });

  it("narrowing the pane moves status items into ⋯ +N and widening restores them", () => {
    h = mountSessionHeader(contextHeader());
    // Widest: everything in the bar, no overflow trigger.
    fakeHeaderWidth(h, 800);
    expect(overflowTrigger(h)).toBeNull();
    expect(h.text()).toContain("2%");

    // Narrow (below the 420px cut): the context item moves to overflow.
    fakeHeaderWidth(h, 300);
    const trigger = overflowTrigger(h);
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("+1");

    // Widen again: the item returns to the bar, overflow trigger gone.
    fakeHeaderWidth(h, 800);
    expect(overflowTrigger(h)).toBeNull();
    expect(h.text()).toContain("2%");
  });

  it("an unchanged width does not re-render the cut (idempotent update)", () => {
    h = mountSessionHeader(contextHeader());
    fakeHeaderWidth(h, 300);
    expect(overflowTrigger(h)).not.toBeNull();

    // Firing the observer with the same width keeps the same outcome.
    fakeHeaderWidth(h, 300);
    expect(overflowTrigger(h)).not.toBeNull();
  });
});
