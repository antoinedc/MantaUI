// demoLayout.test.ts — pins the demo-mode shell override (BET-302 review).
//
// The override exists so `?demo` in a browser can render the desktop shell
// (BET-303's primary capture) instead of always falling through to mobile.
// `pickDemoLayout` is a pure function so the override can be exercised
// without booting React or stubbing window.location — three URL shapes plus
// the conflict + edge cases the PR review specifically asked us to cover.

import { describe, it, expect } from "vitest";
import { pickDemoLayout, pickDemoDataset } from "./demoLayout";

describe("pickDemoLayout — demo-mode URL override", () => {
  it("forces <App/> (desktop) with ?demo&desktop, independent of preload presence", () => {
    expect(pickDemoLayout(new URLSearchParams("demo&desktop"))).toBe("desktop");
  });

  it("forces <MobileApp/> with ?demo&mobile", () => {
    expect(pickDemoLayout(new URLSearchParams("demo&mobile"))).toBe("mobile");
  });

  it("returns null with ?demo alone so the caller falls back to isMobile (production behaviour)", () => {
    // No override — caller resolves to `isMobile`. In a browser that means
    // mobile (preload absent); in Electron that means desktop. This is the
    // exact pre-fix behaviour and we preserve it.
    expect(pickDemoLayout(new URLSearchParams("demo"))).toBeNull();
  });

  it("treats ?demo&desktop&mobile as desktop (desktop wins on conflict)", () => {
    expect(pickDemoLayout(new URLSearchParams("demo&desktop&mobile"))).toBe(
      "desktop",
    );
  });

  it("returns null when no override is present (the helper is demo-mode-only)", () => {
    expect(pickDemoLayout(new URLSearchParams(""))).toBeNull();
    expect(pickDemoLayout(new URLSearchParams("foo=bar"))).toBeNull();
  });
});

describe("pickDemoDataset", () => {
  it("defaults to the full fixture", () => {
    expect(pickDemoDataset(new URLSearchParams(""))).toBe("full");
    expect(pickDemoDataset(new URLSearchParams("demo&desktop"))).toBe("full");
  });

  it("serves the empty box when ?empty is present", () => {
    expect(pickDemoDataset(new URLSearchParams("demo&desktop&empty"))).toBe("empty");
  });

  it("ignores the flag's value — presence is the signal", () => {
    expect(pickDemoDataset(new URLSearchParams("empty=0"))).toBe("empty");
  });
});
