// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { applyTheme, getResolvedTheme } from "./theme";
import { cssColorToHex, readOverlayColors, useTitleBarOverlaySync } from "./titleBarOverlay";
import type { RightPanel } from "./explorer/explorerStore";

describe("cssColorToHex", () => {
  it("normalises hex and rgb() to #RRGGBB, refuses the rest", () => {
    expect(cssColorToHex(" #0f1526 ")).toBe("#0F1526");
    expect(cssColorToHex("#abc")).toBe("#AABBCC");
    expect(cssColorToHex("rgb(15 21 38)")).toBe("#0F1526");
    expect(cssColorToHex("rgb(15, 21, 38)")).toBe("#0F1526");
    expect(cssColorToHex("rgba(15, 21, 38, 0.5)")).toBe("#0F1526");
    expect(cssColorToHex("rgb(300 0 0)")).toBeNull();
    expect(cssColorToHex("")).toBeNull();
    expect(cssColorToHex("var(--panel)")).toBeNull();
    expect(cssColorToHex("red")).toBeNull();
  });
});

function setTokens(t: { canvas: string; panel: string; tx2: string }) {
  const s = document.documentElement.style;
  s.setProperty("--canvas", t.canvas);
  s.setProperty("--panel", t.panel);
  s.setProperty("--tx2", t.tx2);
}

describe("readOverlayColors", () => {
  afterEach(() => document.documentElement.removeAttribute("style"));

  it("reads the live tokens: canvas normally, the panel surface under an Explorer / Artifacts column", () => {
    setTokens({ canvas: "#0B1020", panel: "#0F1526", tx2: "#BDC7DB" });
    expect(readOverlayColors(false)).toEqual({ color: "#0B1020", symbolColor: "#BDC7DB" });
    expect(readOverlayColors(true)).toEqual({ color: "#0F1526", symbolColor: "#BDC7DB" });
  });

  it("sends nothing when a token is missing or unparseable (never a hardcoded fallback)", () => {
    expect(readOverlayColors(false)).toBeNull();
    setTokens({ canvas: "oklch(0.2 0 0)", panel: "#0F1526", tx2: "#BDC7DB" });
    expect(readOverlayColors(false)).toBeNull();
  });
});

describe("useTitleBarOverlaySync", () => {
  let h: Harness | null = null;
  const setTitleBarOverlay = vi.fn(async () => {});
  beforeEach(() => {
    setTitleBarOverlay.mockClear();
    setTokens({ canvas: "#0B1020", panel: "#0F1526", tx2: "#BDC7DB" });
    (window as unknown as { __mantaPreload: unknown }).__mantaPreload = { setTitleBarOverlay };
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    (window as unknown as { __mantaPreload: unknown }).__mantaPreload = null;
    document.documentElement.removeAttribute("style");
  });

  function Probe({ panel }: { panel: RightPanel }) {
    useTitleBarOverlaySync(panel);
    return null;
  }

  it("sends on mount, on a right-panel change and on a theme change — not on an unrelated re-render", () => {
    h = mount(<Probe panel="none" />);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#0B1020", symbolColor: "#BDC7DB" });
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(1);

    h.rerender(<Probe panel="none" />);
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(1);

    h.rerender(<Probe panel="explorer" />);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#0F1526", symbolColor: "#BDC7DB" });
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(2);

    setTokens({ canvas: "#FAF9F7", panel: "#F2F0EC", tx2: "#48433C" });
    act(() => applyTheme(getResolvedTheme() === "light" ? "dark" : "light"));
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(3);
    expect(setTitleBarOverlay).toHaveBeenLastCalledWith({ color: "#F2F0EC", symbolColor: "#48433C" });
  });

  it("does nothing without the preload bridge (web / mobile)", () => {
    (window as unknown as { __mantaPreload: unknown }).__mantaPreload = null;
    h = mount(<Probe panel="none" />);
    expect(setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
