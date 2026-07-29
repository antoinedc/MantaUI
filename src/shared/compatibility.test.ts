import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPATIBILITY_MATRIX,
  isCompatible,
  majorOf,
  COMPATIBILITY_VARIANTS,
} from "./compatibility.mjs";

// Tests run against a custom matrix supporting major=1 so the "match" /
// "behind" cases can use 1.x.y versions regardless of which major the
// production default matrix happens to declare today (it tracks the
// shipping desktop's major). Pinning the matrix here keeps the test
// stable across a future major bump.
const MATRIX = Object.freeze({ supportedMajor: 1 });

describe("compatibility.mjs surface", () => {
  it("exports exactly the four documented variants (no accidental additions)", () => {
    // The renderer's UpdateBar branches on this string union — adding a
    // fifth value silently breaks the switch. Pin the set here so a
    // future PR that tries to add e.g. "warn" has to update this test
    // alongside the renderer code.
    expect(new Set(COMPATIBILITY_VARIANTS)).toEqual(
      new Set(["match", "behind", "incompatible", "unknown"]),
    );
  });

  it("freezes the default matrix so a caller can't drift the renderer's view", () => {
    expect(Object.isFrozen(DEFAULT_COMPATIBILITY_MATRIX)).toBe(true);
    expect(typeof DEFAULT_COMPATIBILITY_MATRIX.supportedMajor).toBe("number");
  });
});

describe("majorOf", () => {
  it("parses the leading numeric segment of a dotted version", () => {
    expect(majorOf("1.2.3")).toBe(1);
    expect(majorOf("0.0.17")).toBe(0);
    expect(majorOf("2.0.0-beta")).toBe(2);
  });

  it("treats missing / malformed input as 0 (mirrors versionCompare)", () => {
    expect(majorOf(null)).toBe(0);
    expect(majorOf(undefined)).toBe(0);
    expect(majorOf("")).toBe(0);
    expect(majorOf("abc")).toBe(0);
    expect(majorOf("x.2.3")).toBe(0);
  });

  it("strips pre-release tags before parsing", () => {
    expect(majorOf("1.2.3-beta.1")).toBe(1);
    expect(majorOf("0.0.17-rc.4")).toBe(0);
  });
});

describe("isCompatible — same-matrix cases (the issue's required coverage)", () => {
  it("identical versions → match", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.3",
        boxVersion: "1.2.3",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("desktop newer than box by one patch → behind (offer upgrade)", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.4",
        boxVersion: "1.2.3",
        matrix: MATRIX,
      }),
    ).toBe("behind");
  });

  it("desktop newer than box by one minor → behind", () => {
    expect(
      isCompatible({
        desktopVersion: "1.3.0",
        boxVersion: "1.2.99",
        matrix: MATRIX,
      }),
    ).toBe("behind");
  });

  it("box newer than desktop by one patch → match (box ahead is allowed)", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.3",
        boxVersion: "1.2.4",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("box newer than desktop by one minor → match", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.0",
        boxVersion: "1.3.5",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("box much newer (same matrix major but way ahead) → still match", () => {
    // Within the supported major, "box ahead" is the normal happy path
    // — the desktop uses a forward-compatible subset of the RPC contract.
    expect(
      isCompatible({
        desktopVersion: "1.0.0",
        boxVersion: "1.999.99",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("the default matrix uses the shipping desktop's current major (today: 0)", () => {
    // The renderer reads this constant at module load; pinning today's
    // value here forces an explicit PR when the next major ships.
    expect(DEFAULT_COMPATIBILITY_MATRIX.supportedMajor).toBe(0);
  });
});

describe("isCompatible — different-major cases", () => {
  it("box much newer (different major) → incompatible", () => {
    // This is the issue's explicit example: the wire-contract moved.
    expect(
      isCompatible({
        desktopVersion: "0.0.17",
        boxVersion: "1.0.0",
      }),
    ).toBe("incompatible");
  });

  it("box much older (different major) → incompatible", () => {
    expect(
      isCompatible({
        desktopVersion: "2.0.0",
        boxVersion: "1.99.99",
        matrix: { supportedMajor: 2 },
      }),
    ).toBe("incompatible");
  });

  it("desktop on a different matrix major than declared → incompatible", () => {
    // Custom matrix pin for a future major bump: only box on major 2 is
    // compatible, desktop on major 1 is rejected.
    expect(
      isCompatible({
        desktopVersion: "1.5.0",
        boxVersion: "2.0.0",
        matrix: { supportedMajor: 2 },
      }),
    ).toBe("incompatible");
  });

  it("box on a different matrix major than declared → incompatible", () => {
    expect(
      isCompatible({
        desktopVersion: "2.5.0",
        boxVersion: "1.99.99",
        matrix: { supportedMajor: 2 },
      }),
    ).toBe("incompatible");
  });
});

describe("isCompatible — pre-release tag edge cases", () => {
  it("box pre-release equals desktop stable → match (tag stripped)", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.3",
        boxVersion: "1.2.3-beta",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("desktop pre-release ahead of box stable → behind", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.4-rc.1",
        boxVersion: "1.2.3",
        matrix: MATRIX,
      }),
    ).toBe("behind");
  });

  it("box pre-release ahead of desktop stable → match", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.3",
        boxVersion: "1.2.4-beta.2",
        matrix: MATRIX,
      }),
    ).toBe("match");
  });

  it("different majors with pre-release tags still → incompatible", () => {
    expect(
      isCompatible({
        desktopVersion: "0.0.17",
        boxVersion: "1.0.0-beta",
      }),
    ).toBe("incompatible");
  });
});

describe("isCompatible — unknown / defensive cases", () => {
  it("missing desktopVersion → unknown (mid-bootstrap)", () => {
    expect(
      isCompatible({ desktopVersion: null, boxVersion: "1.2.3", matrix: MATRIX }),
    ).toBe("unknown");
    expect(
      isCompatible({ desktopVersion: "", boxVersion: "1.2.3", matrix: MATRIX }),
    ).toBe("unknown");
    expect(
      isCompatible({
        desktopVersion: undefined,
        boxVersion: "1.2.3",
        matrix: MATRIX,
      }),
    ).toBe("unknown");
  });

  it("missing boxVersion → unknown", () => {
    expect(
      isCompatible({ desktopVersion: "1.2.3", boxVersion: null, matrix: MATRIX }),
    ).toBe("unknown");
    expect(
      isCompatible({ desktopVersion: "1.2.3", boxVersion: "", matrix: MATRIX }),
    ).toBe("unknown");
  });

  it("missing input object → unknown", () => {
    expect(isCompatible(undefined)).toBe("unknown");
    expect(isCompatible(null)).toBe("unknown");
    // Runtime: missing fields collapse to "unknown". TS won't accept an
    // empty object literal here, so cast to the wider input type.
    expect(
      isCompatible(
        {} as unknown as {
          desktopVersion: string | null | undefined;
          boxVersion: string | null | undefined;
        },
      ),
    ).toBe("unknown");
  });

  it("malformed version strings → never crash, always return a real variant", () => {
    // Garbage that happens to land inside the supported major after
    // normalization → both halves are 0.0.0 → match. The point is: no
    // crash, no "unknown" when the matrix check can resolve it.
    expect(
      isCompatible({
        desktopVersion: "1.abc",
        boxVersion: "1.def",
        matrix: MATRIX,
      }),
    ).toBe("match");
    // Garbage that lands OUTSIDE the supported major → incompatible.
    // The matrix check fires BEFORE the version comparison, so a
    // malformed desktop on a wrong major never spuriously returns
    // "behind" or "match".
    expect(
      isCompatible({
        desktopVersion: "abc",
        boxVersion: "1.99.99",
        matrix: MATRIX,
      }),
    ).toBe("incompatible");
  });

  it("invalid matrix → unknown (no destructive default)", () => {
    expect(
      isCompatible({
        desktopVersion: "1.2.3",
        boxVersion: "1.2.3",
        matrix: { supportedMajor: "two" as unknown as number },
      }),
    ).toBe("unknown");
  });
});
