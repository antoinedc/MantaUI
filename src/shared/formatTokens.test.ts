import { describe, it, expect } from "vitest";
import { formatTokenCount, formatTokens } from "./formatTokens.mjs";

describe("formatTokenCount", () => {
  it("formats the compact figure with no unit", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12_340)).toBe("12.3k");
    expect(formatTokenCount(99_999)).toBe("100k");
    expect(formatTokenCount(128_000)).toBe("128k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("formatTokens", () => {
  it("keeps the historical output byte for byte", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
    expect(formatTokens(1000)).toBe("1k tokens");
    expect(formatTokens(12_340)).toBe("12.3k tokens");
    expect(formatTokens(128_000)).toBe("128k tokens");
    expect(formatTokens(1_200_000)).toBe("1200k tokens");
  });
});
