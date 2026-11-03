import { describe, it, expect } from "vitest";
import { titleBarOptions, titleBarOverlayUpdate } from "./windowChrome";

describe("titleBarOptions", () => {
  it("darwin returns hiddenInset + traffic-light inset and no overlay", () => {
    const opts = titleBarOptions("darwin");
    expect(opts).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
    });
    expect(opts).not.toHaveProperty("titleBarOverlay");
  });

  it("win32 returns hidden + a 44px overlay (the h-11 headers) in the theme colours", () => {
    const opts = titleBarOptions("win32");
    expect(opts.titleBarStyle).toBe("hidden");
    expect(opts).not.toHaveProperty("trafficLightPosition");
    const overlay = opts.titleBarOverlay as {
      color: string;
      symbolColor: string;
      height: number;
    };
    expect(overlay.height).toBe(44);
    expect(overlay.color).toBe("#0B1020");
    expect(overlay.symbolColor).toBe("#A7B1C4");
  });

  it("linux returns an empty object (native title bar stays)", () => {
    // Regression guard: a non-empty return here would give Linux a frameless
    // window with no controls — the exact bug this file exists to fix on
    // Windows.
    expect(titleBarOptions("linux")).toEqual({});
  });
});

describe("titleBarOverlayUpdate", () => {
  const ok = { color: "#0F1526", symbolColor: "#BDC7DB" };

  it("win32 + two #RRGGBB values → the overlay arguments, at the header height", () => {
    expect(titleBarOverlayUpdate("win32", ok)).toEqual({ ...ok, height: 44 });
    expect(titleBarOverlayUpdate("win32", { color: "#abcdef", symbolColor: "#ABCDEF" })).not.toBeNull();
  });

  it("is a no-op off win32 — the overlay only exists there", () => {
    expect(titleBarOverlayUpdate("darwin", ok)).toBeNull();
    expect(titleBarOverlayUpdate("linux", ok)).toBeNull();
  });

  it("refuses anything that is not #RRGGBB in either field, and non-objects", () => {
    for (const bad of ["#fff", "0F1526", "#0F15261F", "rgb(1,2,3)", "red", "#GGGGGG", "", 7, null, undefined]) {
      expect(titleBarOverlayUpdate("win32", { color: bad, symbolColor: ok.symbolColor }), String(bad)).toBeNull();
      expect(titleBarOverlayUpdate("win32", { color: ok.color, symbolColor: bad }), String(bad)).toBeNull();
    }
    expect(titleBarOverlayUpdate("win32", { color: ok.color })).toBeNull();
    expect(titleBarOverlayUpdate("win32", null)).toBeNull();
    expect(titleBarOverlayUpdate("win32", "#0F1526")).toBeNull();
  });
});
