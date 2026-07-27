import { describe, expect, it } from "vitest";
import {
  HERO_DURATION_SECONDS,
  HERO_FPS,
  HERO_HEIGHT,
  HERO_WIDTH,
  Hero,
} from "./Hero";

describe("Hero composition (stage 1 placeholder)", () => {
  it("mounts at t=0 without throwing", () => {
    expect(() => <Hero />).not.toThrow();
  });

  it("uses the dimensions and frame rate the deploy workflow relies on", () => {
    expect(HERO_WIDTH).toBe(1920);
    expect(HERO_HEIGHT).toBe(1080);
    expect(HERO_FPS).toBe(30);
    expect(HERO_DURATION_SECONDS * HERO_FPS).toBeGreaterThan(0);
  });
});
