// @vitest-environment jsdom
//
// Component tests for WorkingIndicator (BET-677). The requirement is the
// zero-reflow contract: the row is ALWAYS rendered at a constant height and
// only toggles `visibility`, so flipping `running` on send never resizes the
// transcript. We assert the style/class, not pixels.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { WorkingIndicator } from "./Transcript";

describe("WorkingIndicator", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function row(): HTMLElement {
    const el = h!.container.querySelector(".manta-working-indicator") as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it("keeps a constant 28px height whether running or idle", () => {
    h = mount(<WorkingIndicator running />);
    expect(row().style.height).toBe("28px");
    h.unmount();
    h = mount(<WorkingIndicator running={false} />);
    expect(row().style.height).toBe("28px");
  });

  it("is visible while running", () => {
    h = mount(<WorkingIndicator running />);
    expect(row().style.visibility).toBe("visible");
  });

  it("toggles to hidden when idle, still allocated in layout", () => {
    h = mount(<WorkingIndicator running={false} />);
    expect(row().style.visibility).toBe("hidden");
    // Height stays reserved — hidden, not removed — so there is no reflow.
    expect(row().style.height).toBe("28px");
  });

  it("shows the Working… label and a loader", () => {
    h = mount(<WorkingIndicator running />);
    expect(h!.text()).toContain("Working…");
    expect(h!.container.querySelector("svg")).toBeTruthy();
  });
});
