// @vitest-environment jsdom
//
// The usage rings / popover rows take their colour from the BOX's `window.tone`
// (WS09 SF-M18). A window with no tone (an older box) renders neutral — the
// renderer invents no colour band.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { UsageWindowRow, SeatMiniBars } from "./UsageDial";
import type { UsageWindow } from "../shared/types";

const fill = (h: Harness) => h.container.querySelector<HTMLElement>("span.block.h-full")!.style.backgroundColor;
const win = (over: Partial<UsageWindow>): UsageWindow => ({ kind: "session", label: "5h", pct: 50, ...over });

describe("usage window colours come from the box", () => {
  let h: Harness | null = null;
  afterEach(() => h?.unmount());

  it("popover row: danger / warn / under tones map to distinct fills; the SAME pct with a different tone follows the tone", () => {
    const colours = (["danger", "warn", "under"] as const).map((tone) => {
      h?.unmount();
      h = mount(<UsageWindowRow usageWindow={win({ pct: 50, tone })} nowMs={0} />);
      return fill(h);
    });
    expect(new Set(colours).size).toBe(3);
  });

  it("popover row: no tone → the neutral track colour, not a band", () => {
    h = mount(<UsageWindowRow usageWindow={win({ pct: 95 })} nowMs={0} />);
    const neutral = fill(h);
    h.unmount();
    h = mount(<UsageWindowRow usageWindow={win({ pct: 95, tone: "danger" })} nowMs={0} />);
    expect(neutral).not.toBe(fill(h));
  });

  it("an inactive or awaiting-reset window is drawn in the quiet tone regardless of its numbers", () => {
    h = mount(<UsageWindowRow usageWindow={win({ pct: 99, tone: "danger", stale: true })} nowMs={0} />);
    const awaiting = fill(h);
    h.unmount();
    h = mount(<UsageWindowRow usageWindow={win({ pct: 1, tone: "under" })} nowMs={0} />);
    expect(awaiting).toBe(fill(h));
  });

  it("seat mini bars use the box's tone too", () => {
    const seat = { id: "s", windows: [win({ pct: 80, tone: "warn" })] } as never;
    h = mount(<SeatMiniBars seat={seat} nowMs={0} />);
    expect(h.container.querySelector<HTMLElement>("[data-window-kind] span.block")!.style.backgroundColor).not.toBe("");
  });
});
