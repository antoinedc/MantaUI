import { describe, it, expect } from "vitest";
import { computeKeyboardInset } from "./keyboardInset";

describe("computeKeyboardInset", () => {
  it("returns 0 when the keyboard is closed (innerHeight === vvHeight)", () => {
    expect(computeKeyboardInset(800, 800, 0)).toBe(0);
  });

  it("returns the keyboard height when the visual viewport has shrunk", () => {
    // iOS Safari overlay: layout 800, visual 400, no offset → 400px keyboard.
    expect(computeKeyboardInset(800, 400, 0)).toBe(400);
  });

  it("subtracts the visual-viewport offset (scrolled visual viewport)", () => {
    // After Safari's form-zoom scroll, the visual viewport is offset 60px
    // from the layout origin; the keyboard is only 300px tall (800 - 500).
    expect(computeKeyboardInset(800, 500, 60)).toBe(300 - 60);
  });

  it("clamps negative values to 0 (Capacitor resizes the layout viewport instead)", () => {
    // Capacitor resizes the WebView to innerHeight 400, vvHeight 400 (already
    // 0 inset), but a stale offsetTop of 50 would otherwise yield a negative
    // result. Clamp to 0 — the bar uses no transform, normal flow applies.
    expect(computeKeyboardInset(400, 400, 50)).toBe(0);
  });
});
