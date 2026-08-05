// @vitest-environment jsdom
//
// Windows caption-button clearance for the surfaces that render at the very
// TOP of the window, above the titlebar row: UpdateBar, ReconnectingBanner and
// (when a chat pane is active, which hides the app titlebar) SessionHeader.
//
// THE BUG THIS LOCKS IN: on Windows the app uses `titleBarOverlay`, so the OS
// paints minimize/maximize/close over the top-right of the window. Both bars
// put their controls on the right ("Update & restart" + ×, "Retry now"), and
// both used a symmetric `px-3` — so the caption buttons sat directly on top of
// them and they could not be clicked at all. SessionHeader had the same
// defect, invisible on macOS because the titlebar is never hidden there.
//
// The titlebar row already reserves that strip (`.titlebar-inset-right`, fed by
// `--titlebar-inset-right`); these surfaces must reserve it too. The variable is
// derived from the `titlebar-area-*` env vars, which only Windows defines, so
// it evaluates to 0 on macOS/Linux and the padding stays exactly `px-3` there —
// no platform branch in JS, and nothing to regress per-OS.
//
// jsdom loads no stylesheet and does not implement `env()`, so — as with
// SessionRow — the contract is asserted on the exact class string.

import { describe, it, expect, afterEach } from "vitest";
import { mount, mountSessionHeader, type Harness } from "./testHarness";
import { UpdateBar } from "./UpdateBar";
import { ReconnectingBanner } from "./ReconnectingBanner";

const INSET = "pr-[calc(var(--sp-3)+var(--titlebar-inset-right))]";

describe("top-of-window bars clear the Windows caption buttons", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("UpdateBar reserves the caption strip instead of padding symmetrically", () => {
    h = mount(
      <UpdateBar
        text="Server update available: 0.0.20"
        actionLabel="Update & restart"
        onAction={() => {}}
        onDismiss={() => {}}
      />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain(INSET);
    expect(el.className).toContain("pl-3");
    // A symmetric px-3 is what put the buttons under the caption controls.
    expect(el.className).not.toContain("px-3");
  });

  it("ReconnectingBanner does the same — its 'Retry now' button was covered too", () => {
    h = mount(
      <ReconnectingBanner
        state={{ state: "reconnecting", attempt: 2, backoffMs: 5_000 }}
        onRetryNow={() => {}}
      />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain(INSET);
    expect(el.className).toContain("pl-3");
    expect(el.className).not.toContain("px-3");
  });

  it("SessionHeader reserves the caption strip too (it top-mosts when a chat pane hides the titlebar)", () => {
    h = mountSessionHeader();
    const el = h.container.firstElementChild as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain(INSET);
    expect(el.className).toContain("pl-3");
    // A symmetric px-3 is what put the session menu under the caption controls.
    expect(el.className).not.toContain("px-3");
    // Reservation must be token-driven, not a hardcoded Windows width.
    expect(el.className).not.toMatch(/pr-\[\d+px\]/);
  });

  it("the reservation is token-driven, so macOS/Linux collapse it to zero", () => {
    // --titlebar-inset-right is `100vw - titlebar-area-x - titlebar-area-width`
    // with fallbacks of 0px/100vw, so a platform that defines neither env var
    // yields 0 and the bar keeps a plain 12px right pad. Asserting the class
    // references the VARIABLE (not a hardcoded Windows width) is what keeps
    // that true.
    h = mount(
      <UpdateBar text="x" actionLabel="Go" onAction={() => {}} onDismiss={() => {}} />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("var(--titlebar-inset-right)");
    expect(el.className).not.toMatch(/pr-\[\d+px\]/);
  });
});
