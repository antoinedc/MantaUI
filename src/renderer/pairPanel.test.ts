import { describe, it, expect } from "vitest";
import {
  isPairCodeExpired,
  shouldRefreshPairCode,
  msUntilRefresh,
  isValidManualPairCode,
  resolveQrServerOverride,
} from "./pairPanel";
import { boxDirectUrl } from "../shared/transport.mjs";

const BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2"; // 32 hex

describe("resolveQrServerOverride (BET-703)", () => {
  it("omits the override when the configured URL equals the box's public hostname", () => {
    expect(resolveQrServerOverride(BOX, boxDirectUrl(BOX))).toBeUndefined();
  });

  it("omits the override when no configured URL is present", () => {
    expect(resolveQrServerOverride(BOX, undefined)).toBeUndefined();
    expect(resolveQrServerOverride(BOX, null)).toBeUndefined();
    expect(resolveQrServerOverride(BOX, "")).toBeUndefined();
  });

  it("carries a private/tailnet URL that differs from the public hostname", () => {
    expect(resolveQrServerOverride(BOX, "http://100.64.1.5:8787")).toBe(
      "http://100.64.1.5:8787",
    );
    expect(resolveQrServerOverride(BOX, "https://mybox.ts.net")).toBe(
      "https://mybox.ts.net",
    );
  });

  it("omits a custom PUBLIC domain that differs from the public hostname", () => {
    // The iOS parser refuses non-private server= by design (crafted-link
    // guard) — the QR must not include a public override it would reject.
    expect(resolveQrServerOverride(BOX, "https://box.example.com")).toBeUndefined();
  });

  it("omits a malformed configured URL", () => {
    expect(resolveQrServerOverride(BOX, "100.64.1.5:8787")).toBeUndefined();
    expect(resolveQrServerOverride(BOX, "ftp://100.x.y.z")).toBeUndefined();
  });
});

describe("isPairCodeExpired", () => {
  it("is alive before expiry", () => {
    expect(isPairCodeExpired(1000, 999)).toBe(false);
  });
  it("expires exactly at the boundary", () => {
    expect(isPairCodeExpired(1000, 1000)).toBe(true);
  });
  it("is expired after", () => {
    expect(isPairCodeExpired(1000, 1001)).toBe(true);
  });
});

describe("shouldRefreshPairCode (auto-rotation on expiry)", () => {
  it("does not refresh well before expiry", () => {
    expect(shouldRefreshPairCode(1000, 500)).toBe(false);
  });
  it("refreshes exactly at expiry", () => {
    expect(shouldRefreshPairCode(1000, 1000)).toBe(true);
  });
  it("refreshes after expiry", () => {
    expect(shouldRefreshPairCode(1000, 1500)).toBe(true);
  });
  it("grace refreshes slightly before expiry, not before the grace window", () => {
    expect(shouldRefreshPairCode(1000, 995, 10)).toBe(true); // within grace
    expect(shouldRefreshPairCode(1000, 990, 10)).toBe(true); // at the refresh point
    expect(shouldRefreshPairCode(1000, 989, 10)).toBe(false); // before grace
    expect(shouldRefreshPairCode(1000, 601, 10)).toBe(false);
  });
});

describe("msUntilRefresh", () => {
  it("is the remaining time before refresh", () => {
    expect(msUntilRefresh(1000, 500)).toBe(500);
  });
  it("is zero at and after the refresh point", () => {
    expect(msUntilRefresh(1000, 1000)).toBe(0);
    expect(msUntilRefresh(1000, 1100)).toBe(0);
  });
  it("respects grace", () => {
    expect(msUntilRefresh(1000, 500, 50)).toBe(450);
  });
});

describe("isValidManualPairCode (manual six-digit path)", () => {
  it("accepts exactly 6 digits", () => {
    expect(isValidManualPairCode("123456")).toBe(true);
    expect(isValidManualPairCode("000001")).toBe(true);
  });
  it("rejects short / long / non-digit / empty", () => {
    expect(isValidManualPairCode("12345")).toBe(false);
    expect(isValidManualPairCode("1234567")).toBe(false);
    expect(isValidManualPairCode("12345a")).toBe(false);
    expect(isValidManualPairCode(" 123456")).toBe(false);
    expect(isValidManualPairCode("")).toBe(false);
  });
});
