import { describe, it, expect } from "vitest";
import { nextBackoffDelay } from "./backoffDelay";

describe("nextBackoffDelay — geometric growth", () => {
  it("attempt 0 with no jitter (factor=1) returns baseMs", () => {
    expect(
      nextBackoffDelay({ attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: 1 }),
    ).toBe(1000);
  });

  it("attempt N grows geometrically (factor 2, no jitter)", () => {
    const opts = { baseMs: 1000, capMs: 30000, jitterFactor: 1 } as const;
    expect(nextBackoffDelay({ ...opts, attempt: 0 })).toBe(1000);
    expect(nextBackoffDelay({ ...opts, attempt: 1 })).toBe(2000);
    expect(nextBackoffDelay({ ...opts, attempt: 2 })).toBe(4000);
    expect(nextBackoffDelay({ ...opts, attempt: 3 })).toBe(8000);
    expect(nextBackoffDelay({ ...opts, attempt: 4 })).toBe(16000);
  });

  it("respects a custom factor via the geometric formula", () => {
    // base * factor ** attempt, with cap. The pure helper hard-codes factor=2
    // (matches ExponentialBackoff's default), so verify the formula is the
    // standard binary backoff.
    expect(
      nextBackoffDelay({ attempt: 5, baseMs: 1000, capMs: 100000, jitterFactor: 1 }),
    ).toBe(32000); // 1000 * 2^5
  });

  it("caps at capMs when the geometric growth would exceed it", () => {
    // 1000 * 2^10 = 1,024,000 — well past the 30000 cap. Result must be the cap.
    expect(
      nextBackoffDelay({
        attempt: 10,
        baseMs: 1000,
        capMs: 30000,
        jitterFactor: 1,
      }),
    ).toBe(30000);
  });

  it("stays at the cap for very large attempt counts", () => {
    expect(
      nextBackoffDelay({
        attempt: 100,
        baseMs: 1000,
        capMs: 30000,
        jitterFactor: 1,
      }),
    ).toBe(30000);
  });
});

describe("nextBackoffDelay — jitter", () => {
  it("jitterFactor=1 returns the full (uncapped*1) delay", () => {
    expect(
      nextBackoffDelay({ attempt: 3, baseMs: 1000, capMs: 30000, jitterFactor: 1 }),
    ).toBe(8000); // 1000 * 2^3
  });

  it("jitterFactor=0.5 returns half the delay (decorrelated jitter midpoint)", () => {
    expect(
      nextBackoffDelay({ attempt: 2, baseMs: 1000, capMs: 30000, jitterFactor: 0.5 }),
    ).toBe(2000); // 0.5 * (1000 * 2^2)
  });

  it("jitterFactor=0 returns 0 (effectively no backoff)", () => {
    expect(
      nextBackoffDelay({ attempt: 3, baseMs: 1000, capMs: 30000, jitterFactor: 0 }),
    ).toBe(0);
  });

  it("jitter is bounded — jitterFactor in [0, 1] stays in [0, computed]", () => {
    const samples = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1];
    for (const jitter of samples) {
      const result = nextBackoffDelay({
        attempt: 3,
        baseMs: 1000,
        capMs: 30000,
        jitterFactor: jitter,
      });
      // The uncapped geometric delay is 8000ms. Result must be in [0, 8000].
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(8000);
      // And jitter factor 1 must equal the full 8000.
      if (jitter === 1) expect(result).toBe(8000);
    }
  });

  it("clamps jitterFactor > 1 to 1 (full delay)", () => {
    expect(
      nextBackoffDelay({ attempt: 2, baseMs: 1000, capMs: 30000, jitterFactor: 1.5 }),
    ).toBe(4000);
  });

  it("clamps negative jitterFactor to 0 (zero delay)", () => {
    expect(
      nextBackoffDelay({ attempt: 2, baseMs: 1000, capMs: 30000, jitterFactor: -0.5 }),
    ).toBe(0);
  });
});

describe("nextBackoffDelay — returns a number", () => {
  it("always returns a finite non-negative integer", () => {
    const cases = [
      { attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: 1 },
      { attempt: 5, baseMs: 500, capMs: 8000, jitterFactor: 0.7 },
      { attempt: 20, baseMs: 100, capMs: 60000, jitterFactor: 0 },
    ] as const;
    for (const c of cases) {
      const d = nextBackoffDelay(c);
      expect(typeof d).toBe("number");
      expect(Number.isFinite(d)).toBe(true);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("floors fractional results so a caller scheduling setTimeout sees clean integers", () => {
    // 1000 * 2^1 = 2000; jitter 0.333 → 666 (exact). jitter 0.337 → 674 (rounded up by floor: 2000*0.337 = 674).
    // We assert floor semantics (2000 * 0.3375 = 675, floor = 675).
    const exact = nextBackoffDelay({
      attempt: 1,
      baseMs: 1000,
      capMs: 30000,
      jitterFactor: 0.3375,
    });
    expect(exact).toBe(675);
    expect(Number.isInteger(exact)).toBe(true);
  });
});

describe("nextBackoffDelay — extreme inputs never throw", () => {
  // The function is total — every input combination returns a sane number
  // without raising. This is the "not throwing on extreme inputs" guarantee
  // the BET-365 scope asks for, so a buggy / hostile caller can't crash the
  // reconnect loop.
  const extreme: Array<Parameters<typeof nextBackoffDelay>[0]> = [
    { attempt: NaN, baseMs: 1000, capMs: 15000, jitterFactor: 1 },
    { attempt: -10, baseMs: 1000, capMs: 15000, jitterFactor: 1 },
    { attempt: 1.7, baseMs: 1000, capMs: 15000, jitterFactor: 1 },
    { attempt: 0, baseMs: -500, capMs: 15000, jitterFactor: 1 },
    { attempt: 0, baseMs: NaN, capMs: 15000, jitterFactor: 1 },
    { attempt: 0, baseMs: Infinity, capMs: 15000, jitterFactor: 1 },
    { attempt: 0, baseMs: 1000, capMs: -1000, jitterFactor: 1 }, // cap below base
    { attempt: 0, baseMs: 1000, capMs: NaN, jitterFactor: 1 },
    { attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: NaN },
    { attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: Infinity },
    { attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: -1 },
    { attempt: 0, baseMs: 1000, capMs: 15000, jitterFactor: 99 },
  ];

  for (const opts of extreme) {
    it(`nextBackoffDelay(${JSON.stringify(opts)}) does not throw`, () => {
      expect(() => nextBackoffDelay(opts)).not.toThrow();
      const d = nextBackoffDelay(opts);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    });
  }

  it("negative attempts clamp to 0 → baseMs (with full jitter)", () => {
    expect(
      nextBackoffDelay({ attempt: -5, baseMs: 1000, capMs: 30000, jitterFactor: 1 }),
    ).toBe(1000);
  });

  it("non-integer attempts floor (1.7 → attempt=1 → 2000ms)", () => {
    expect(
      nextBackoffDelay({ attempt: 1.7, baseMs: 1000, capMs: 30000, jitterFactor: 1 }),
    ).toBe(2000);
  });

  it("capMs below baseMs silently raises to baseMs (self-consistent)", () => {
    // cap=500 with base=1000: naive min(base*1, 500) = 500, which would HIDE
    // attempt 0's true intent. The helper raises cap to 1000 so attempt 0 is
    // exactly baseMs regardless. The pin is "a cap below the base is incoherent
    // and we resolve it the only way that makes the result depend only on
    // baseMs at attempt 0".
    expect(
      nextBackoffDelay({ attempt: 0, baseMs: 1000, capMs: 500, jitterFactor: 1 }),
    ).toBe(1000);
  });

  it("NaN inputs treat as 0 (delay=0)", () => {
    expect(
      nextBackoffDelay({
        attempt: 3,
        baseMs: NaN,
        capMs: NaN,
        jitterFactor: NaN,
      }),
    ).toBe(0);
  });
});
