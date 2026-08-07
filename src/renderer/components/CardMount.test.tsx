// @vitest-environment jsdom
//
// Component tests for CardMount (BET-677) — the single shared mount/unmount
// animation for composer-stack cards. The contract: it renders its children
// while `show` is true, animates out, and finally removes them from the tree
// after the exit (so no card ever lingers). The `.shrink`-free motion.div that
// wraps them must set `overflow: hidden` to keep the height animation from
// leaking.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { CardMount } from "./CardMount";

describe("CardMount", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders children while show is true", () => {
    h = mount(
      <CardMount show k="perm">
        <div>card body</div>
      </CardMount>,
    );
    expect(h.text()).toContain("card body");
  });

  it("renders nothing when show is false", () => {
    h = mount(
      <CardMount show={false} k="perm">
        <div>card body</div>
      </CardMount>,
    );
    expect(h.text()).not.toContain("card body");
  });

  it("removes children from the tree after the exit animation completes", async () => {
    h = mount(
      <CardMount show k="perm">
        <div>card body</div>
      </CardMount>,
    );
    expect(h.text()).toContain("card body");
    h.rerender(
      <CardMount show={false} k="perm">
        <div>card body</div>
      </CardMount>,
    );
    // Let the 0.22s exit animation (height/opacity → 0) run to completion, then
    // AnimatePresence drops the node. 400ms comfortably exceeds the duration.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(h.text()).not.toContain("card body");
  });

  it("wraps children in an overflow-hidden row so height animation stays contained", () => {
    h = mount(
      <CardMount show k="perm">
        <div>card body</div>
      </CardMount>,
    );
    // The only div wrapping children that this component controls carries the
    // overflow:hidden inline style that makes the 0 → auto height tween smooth
    // instead of bleeding content.
    const wrapper = h.container.querySelector("div[style]") as HTMLElement | null;
    expect(wrapper?.style.overflow).toBe("hidden");
  });
});
