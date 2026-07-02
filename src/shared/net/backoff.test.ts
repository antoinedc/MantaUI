import { describe, it, expect } from "vitest";
import { ExponentialBackoff } from "./backoff";

describe("ExponentialBackoff", () => {
  it("grows geometrically with jitter off", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000, jitter: false });
    expect(b.next()).toBe(1000); // 1000 * 2^0
    expect(b.next()).toBe(2000); // 1000 * 2^1
    expect(b.next()).toBe(4000); // 1000 * 2^2
    expect(b.next()).toBe(8000); // 1000 * 2^3
    expect(b.next()).toBe(16000); // 1000 * 2^4
  });

  it("caps at max", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000, jitter: false });
    // Advance well past the cap.
    for (let i = 0; i < 6; i++) b.next();
    // 1000 * 2^6 = 64000 -> capped to 30000, stays capped.
    expect(b.next()).toBe(30000);
    expect(b.next()).toBe(30000);
  });

  it("respects a custom factor", () => {
    const b = new ExponentialBackoff({ base: 100, max: 100000, factor: 3, jitter: false });
    expect(b.next()).toBe(100);
    expect(b.next()).toBe(300);
    expect(b.next()).toBe(900);
  });

  it("reset() returns the attempt counter to 0", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000, jitter: false });
    b.next();
    b.next();
    expect(b.attempt()).toBe(2);
    b.reset();
    expect(b.attempt()).toBe(0);
    expect(b.next()).toBe(1000);
  });

  it("attempt() reflects the number of next() calls", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000, jitter: false });
    expect(b.attempt()).toBe(0);
    b.next();
    expect(b.attempt()).toBe(1);
    b.next();
    expect(b.attempt()).toBe(2);
  });

  it("applies full-jitter within [0, computed] using injected RNG", () => {
    // rng returns 0.5 -> half of the computed (capped) delay.
    const b = new ExponentialBackoff({ base: 1000, max: 30000, rng: () => 0.5 });
    expect(b.next()).toBe(500); // 0.5 * 1000
    expect(b.next()).toBe(1000); // 0.5 * 2000
    expect(b.next()).toBe(2000); // 0.5 * 4000
  });

  it("full-jitter is bounded by [0, capped] for extreme RNG values", () => {
    const rngValues = [0, 0.999999, 0.5];
    let i = 0;
    const b = new ExponentialBackoff({
      base: 1000,
      max: 30000,
      rng: () => rngValues[i++ % rngValues.length],
    });
    // attempt 0: computed 1000, rng 0 -> 0
    expect(b.next()).toBe(0);
    // attempt 1: computed 2000, rng ~1 -> < 2000
    const d1 = b.next();
    expect(d1).toBeGreaterThanOrEqual(0);
    expect(d1).toBeLessThan(2000);
    // attempt 2: computed 4000, rng 0.5 -> 2000
    expect(b.next()).toBe(2000);
  });

  it("jitter never exceeds the cap", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000, rng: () => 0.999999 });
    for (let i = 0; i < 20; i++) {
      const d = b.next();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30000);
    }
  });

  it("matches the BET-46 default construction shape", () => {
    const b = new ExponentialBackoff({ base: 1000, max: 30000 });
    expect(b.attempt()).toBe(0);
    const d = b.next();
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1000);
  });
});
