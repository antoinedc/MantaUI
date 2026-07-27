import { describe, it, expect } from "vitest";
import { titleBarOptions } from "./windowChrome";

describe("titleBarOptions", () => {
  it("darwin returns hiddenInset + traffic-light inset and no overlay", () => {
    const opts = titleBarOptions("darwin");
    expect(opts).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
    });
    expect(opts).not.toHaveProperty("titleBarOverlay");
  });

  it("win32 returns hidden + a 40px overlay in the theme colours", () => {
    const opts = titleBarOptions("win32");
    expect(opts.titleBarStyle).toBe("hidden");
    expect(opts).not.toHaveProperty("trafficLightPosition");
    const overlay = opts.titleBarOverlay as {
      color: string;
      symbolColor: string;
      height: number;
    };
    expect(overlay.height).toBe(40);
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
