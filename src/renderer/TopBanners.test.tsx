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

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { mount, mountSessionHeader, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import { UpdateBar } from "./UpdateBar";
import { ReconnectingBanner } from "./ReconnectingBanner";
import {
  resetExplorerStore,
  setRightPanel,
  setExpanded,
  setSidebarHidden,
} from "./explorer/explorerStore";

const INSET = "pr-[calc(var(--sp-3)+var(--titlebar-inset-right))]";
// The window's top-left corner: a banner that is the top edge owns the
// traffic-light clearance (`--banner-inset-x`), never the pane header below it.
const BANNER_PAD = "max(var(--sp-3), var(--banner-inset-x, 0px))";

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
    expect(el.style.paddingLeft).toBe(BANNER_PAD);
    // A symmetric px-3 is what put the buttons under the caption controls.
    expect(el.className).not.toContain("px-3");
    // As the window's top edge it drags the window; its buttons stay clickable.
    expect(el.className).toContain("titlebar-drag");
    for (const b of el.querySelectorAll("button")) expect(b.className).toContain("titlebar-no-drag");
    expect(el.querySelectorAll("button").length).toBeGreaterThan(0);
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
    expect(el.style.paddingLeft).toBe(BANNER_PAD);
    expect(el.className).not.toContain("px-3");
    expect(el.className).toContain("titlebar-drag");
    for (const b of el.querySelectorAll("button")) expect(b.className).toContain("titlebar-no-drag");
    expect(el.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("SessionHeader reserves the caption strip too (it top-mosts when a chat pane hides the titlebar)", () => {
    h = mountSessionHeader();
    const el = h.container.firstElementChild as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain(INSET);
    // The left pad is `max(<own pad>, pane inset)` (inline style), not `pl-3`.
    expect(el.style.paddingLeft).toBe("max(var(--sp-3), var(--pane-inset-x, 0px))");
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

// Exactly one header per column stack reserves the Windows caption strip: the
// one touching the window's right edge. SessionHeader gives it back while a
// right-hand panel (Explorer / Artifacts) is that edge.
describe("SessionHeader hands the caption strip to the right-hand panel", () => {
  let h: Harness | null = null;
  const SID = "ses_a";
  const headerOf = () => h!.container.querySelector<HTMLElement>(".manta-session-header")!;
  const mountHeader = (over: Parameters<typeof mountSessionHeader>[0] = {}) =>
    mountSessionHeader({ sessionId: SID, onToggleArtifacts: () => {}, ...over });

  beforeEach(() => {
    localStorage.clear();
    resetExplorerStore();
    resetStore();
    act(() => {
      useStore.setState({
        projects: [
          {
            tmuxSession: "p",
            defaultCwd: "/x",
            attached: false,
            windows: [{ index: 0, name: "w", active: true, paneCurrentPath: "/x", opencodeSessionId: SID }],
          },
        ] as never,
      });
    });
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("reserves it with no right panel", () => {
    h = mountHeader();
    expect(headerOf().className).toContain(INSET);
  });

  it.each(["explorer", "artifacts"] as const)("drops it while the %s is shown, and takes it back when closed", (which) => {
    h = mountHeader();
    act(() => setRightPanel(SID, which));
    expect(headerOf().className).not.toContain("titlebar-inset-right");
    expect(headerOf().className).toContain("pr-3");
    act(() => setRightPanel(SID, "none"));
    expect(headerOf().className).toContain(INSET);
  });

  it("keeps it when the host has no panel toggle (the panel can't be shown there)", () => {
    h = mountHeader({ onToggleArtifacts: undefined });
    act(() => setRightPanel(SID, "artifacts"));
    expect(headerOf().className).toContain(INSET);
  });

  it("keeps it when the Explorer is open but its window is gone (nothing renders there)", () => {
    act(() => useStore.setState({ projects: [] }));
    h = mountHeader();
    act(() => setRightPanel(SID, "explorer"));
    expect(headerOf().className).toContain(INSET);
  });

  it("carries the sidebar restore button first — but not while its Explorer is Expanded (the Explorer top bar has it)", () => {
    act(() => setSidebarHidden(true));
    h = mountHeader();
    const first = () => headerOf().firstElementChild as HTMLElement;
    expect(first().querySelector(".manta-sidebar-toggle")).not.toBeNull();
    expect(headerOf().querySelectorAll(".manta-sidebar-toggle")).toHaveLength(1);

    act(() => setRightPanel(SID, "explorer"));
    expect(headerOf().querySelectorAll(".manta-sidebar-toggle")).toHaveLength(1);
    act(() => setExpanded(SID, true));
    expect(headerOf().querySelectorAll(".manta-sidebar-toggle")).toHaveLength(0);

    act(() => setSidebarHidden(false));
    act(() => setExpanded(SID, false));
    expect(headerOf().querySelectorAll(".manta-sidebar-toggle")).toHaveLength(0);
  });
});
