// @vitest-environment jsdom
//
// Component tests for WorkingIndicator (BET-694). The row is a real status
// line while a turn runs — loader + present-tense verb + live elapsed + token
// count — and it mounts/unmounts (animated by CardMount) instead of reserving
// a permanent slot, so idle renders NO row. We assert the rendered text, not
// pixels.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { WorkingIndicator } from "./Transcript";
import { presentVerbFor } from "./chatShared";
import type { LiveTurn } from "./chatUtils";
import { pinDemoClock } from "./clock";
import { useStore } from "./store";

// A fixed clock anchor; the elapsed label is a function of this, not the wall
// clock. startedAt is 103s before the anchor so formatDuration renders "1m43s".
const T0 = 1_700_000_000_000;

function makeLiveTurn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return { startedAt: T0 - 103_000, tokens: 432, verbSeedId: "msg_1", ...overrides };
}

describe("WorkingIndicator", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ videoRenderNow: null });
  });

  it("renders the present verb, live elapsed, and token count while running", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn();
    h = mount(<WorkingIndicator running liveTurn={liveTurn} />);
    const expected = `${presentVerbFor(liveTurn.verbSeedId)}… · 1m43s · 432 tokens`;
    // Collapse whitespace: the row interleaves segments as separate text
    // nodes within a flex span, so text() joins without the " · " separators
    // except where they are literal strings. Match on a normalized form.
    expect(h!.text().replace(/\s+/g, " ").trim()).toContain(expected);
    // The loader is still there (existing assertion).
    expect(h!.container.querySelector("svg")).toBeTruthy();
  });

  it("renders NO token segment when tokens is 0", () => {
    pinDemoClock(T0);
    const liveTurn = makeLiveTurn({ tokens: 0 });
    h = mount(<WorkingIndicator running liveTurn={liveTurn} />);
    const text = h!.text();
    expect(text).toContain(`${presentVerbFor(liveTurn.verbSeedId)}… · 1m43s`);
    expect(text).not.toContain("tokens");
  });

  it("falls back to the loader + label when running but liveTurn is null", () => {
    h = mount(<WorkingIndicator running liveTurn={null} />);
    expect(h!.text()).toContain("Working…");
    expect(h!.container.querySelector("svg")).toBeTruthy();
    expect(h!.text()).not.toContain("NaN");
    expect(h!.text()).not.toContain("undefined");
  });

  it("renders no row when idle — no reserved slot above the composer", () => {
    h = mount(<WorkingIndicator running={false} liveTurn={null} />);
    expect(h!.container.querySelector(".manta-working-indicator")).toBeNull();
  });

  it("owns no vertical margin — the tail container's gap does the spacing", () => {
    h = mount(<WorkingIndicator running liveTurn={makeLiveTurn()} />);
    const row = h!.container.querySelector(".manta-working-indicator") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.marginTop).toBe("");
    expect(row.style.marginBottom).toBe("");
  });
});
