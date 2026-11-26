// The ink an agent's initials are drawn in: whichever of white or near-black reads better on the agent's own colour.

import { describe, expect, it } from "vitest";
import { AGENT_INK_DARK, AGENT_INK_LIGHT, agentInk, colorLuminance, inkContrast } from "./agentInk";

describe("colorLuminance", () => {
  it("reads hex (3 and 6 digits), rgb() and oklch()", () => {
    expect(colorLuminance("#000000")).toBeCloseTo(0, 3);
    expect(colorLuminance("#fff")).toBeCloseTo(1, 3);
    expect(colorLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 3);
    expect(colorLuminance("#336699")).toBeCloseTo(0.1329, 3);
    expect(colorLuminance("oklch(100% 0 0)")).toBeCloseTo(1, 2);
    expect(colorLuminance("oklch(0% 0 0)")).toBeCloseTo(0, 2);
    expect(colorLuminance("oklch(62% 0.14 160)")).toBeGreaterThan(0.2); // the demo SEO green: mid-light
  });
  it("is null for what it can't read", () => {
    expect(colorLuminance("")).toBeNull();
    expect(colorLuminance("banana")).toBeNull();
    expect(colorLuminance("var(--accent)")).toBeNull();
  });
});

describe("agentInk", () => {
  it("is dark on a mid-light colour where white would fail (the demo green is 3.2:1 under white)", () => {
    const green = "oklch(62% 0.14 160)";
    expect(inkContrast(green, AGENT_INK_LIGHT)).toBeLessThan(4.5);
    expect(agentInk(green)).toBe(AGENT_INK_DARK);
    expect(inkContrast(green, AGENT_INK_DARK)).toBeGreaterThanOrEqual(4.5);
  });
  it("is white on a deep colour", () => {
    expect(agentInk("#1f2a5a")).toBe(AGENT_INK_LIGHT);
    expect(agentInk("oklch(35% 0.1 260)")).toBe(AGENT_INK_LIGHT);
  });
  it("always picks the better of the two", () => {
    for (const c of ["#16a36b", "#e11d48", "#336699", "#facc15", "oklch(62% 0.14 250)", "oklch(66% 0.14 25)", "oklch(64% 0.13 60)", "oklch(58% 0.12 320)", "rgb(10, 10, 10)"]) {
      const ink = agentInk(c)!;
      const other = ink === AGENT_INK_DARK ? AGENT_INK_LIGHT : AGENT_INK_DARK;
      expect(inkContrast(c, ink)).toBeGreaterThanOrEqual(inkContrast(c, other));
    }
  });
  it("leaves the theme's own ink alone for a colour it can't read", () => {
    expect(agentInk("banana")).toBeNull();
    expect(agentInk(null)).toBeNull();
  });
});
