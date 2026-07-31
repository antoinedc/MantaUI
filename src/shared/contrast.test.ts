import { describe, it, expect } from "vitest";
import {
  relativeLuminance,
  contrastRatio,
  parseThemeVars,
  checkContrast,
  TOKEN_PAIRS,
} from "./contrast.mjs";

describe("relativeLuminance", () => {
  it("black is 0, white is 1", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
  });
  it("matches the WCAG sample (#777777 ≈ 0.183)", () => {
    // WCAG 2.x reference: #777777 → 0.1830 (sRGB linearized).
    expect(relativeLuminance("#777777")).toBeCloseTo(0.183, 2);
  });
});

describe("contrastRatio", () => {
  it("identical colours are 1:1", () => {
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
  });
  it("black-on-white is 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
  });
  it("is order-independent", () => {
    expect(contrastRatio("#0B1020", "#F2F5FA")).toBeCloseTo(
      contrastRatio("#F2F5FA", "#0B1020"),
      5,
    );
  });
});

describe("parseThemeVars", () => {
  it("parses the dark block from the live tokens.css", () => {
    const vars = parseThemeVars("dark");
    expect(vars.canvas).toBe("#0B1020");
    expect(vars.tx3).toBe("#939FB8");
    expect(vars.tx4).toBe("#6B7690");
    expect(vars["border-strong"]).toBe("#5E6C9B");
  });
  it("parses the light block from the live tokens.css", () => {
    const vars = parseThemeVars("light");
    expect(vars.canvas).toBe("#FAF9F7");
    expect(vars.tx3).toBe("#665F55");
    expect(vars.onaccent ?? vars["on-accent"]).toBeTruthy();
  });
  it("ignores comments and non-hex values", () => {
    const css = `
      [data-theme="dark"] {
        /* a comment with #0B1020 inside */
        --canvas: #0B1020;
        --canvas-rgb: 11 16 32;
        --fill: rgba(255, 255, 255, .04);
      }
    `;
    const vars = parseThemeVars("dark", css);
    expect(vars.canvas).toBe("#0B1020");
    expect(vars["canvas-rgb"]).toBeUndefined();
    expect(vars.fill).toBeUndefined();
  });
});

describe("checkContrast — the CI gate (BET-410)", () => {
  it("covers the full required pair set", () => {
    // tx1/tx2/tx3 × 4 surfaces = 12, accent-tx × 2 = 2, on-accent × 1 = 1,
    // ok/warn/danger/info × 2 = 8, border-strong × 3 = 3, tx4 × 1 = 1 → 27.
    expect(TOKEN_PAIRS).toHaveLength(27);
  });

  it("dark theme: zero contrast failures", () => {
    const failures = checkContrast("dark");
    expect(failures).toEqual([]);
  });

  it("light theme: zero contrast failures", () => {
    const failures = checkContrast("light");
    expect(failures).toEqual([]);
  });

  it("goes red when a dark token is regressed below AA", () => {
    // Deliberately break tx3 on canvas (set tx3 to the old sub-AA #5C6578).
    const vars = { ...parseThemeVars("dark"), tx3: "#5C6578" };
    const failures = checkContrast("dark", vars);
    const tx3OnCanvas = failures.find(
      (f) => f.fg === "tx3" && f.bg === "canvas",
    );
    expect(tx3OnCanvas).toBeTruthy();
    expect(tx3OnCanvas!.ratio).toBeLessThan(4.5);
  });

  it("goes red when border-strong drops below the 3:1 control minimum", () => {
    const vars = { ...parseThemeVars("dark"), "border-strong": "#33406B" };
    const failures = checkContrast("dark", vars);
    expect(
      failures.some(
        (f) => f.fg === "border-strong" && f.bg === "canvas",
      ),
    ).toBe(true);
  });
});
