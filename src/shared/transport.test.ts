import { describe, it, expect } from "vitest";
import {
  isValidBoxToken,
  BOXES_DOMAIN,
  boxDirectUrl,
  resolveTransportMode,
  parseClaimResponse,
  selectDesktopTransport,
  desktopHttpClientSeed,
} from "./transport.mjs";

// A well-formed 32-lowercase-hex token (128 bits).
const HEX32 = "0123456789abcdef0123456789abcdef";
const HEX32_B = "fedcba9876543210fedcba9876543210";

describe("isValidBoxToken", () => {
  it("accepts exactly 32 lowercase hex chars", () => {
    expect(isValidBoxToken(HEX32)).toBe(true);
    expect(isValidBoxToken(HEX32_B)).toBe(true);
  });
  it("rejects wrong length", () => {
    expect(isValidBoxToken("abcdef")).toBe(false);
    expect(isValidBoxToken(HEX32 + "a")).toBe(false);
    expect(isValidBoxToken(HEX32.slice(0, 31))).toBe(false);
    expect(isValidBoxToken("")).toBe(false);
  });
  it("rejects uppercase and non-hex chars", () => {
    expect(isValidBoxToken(HEX32.toUpperCase())).toBe(false);
    expect(isValidBoxToken("g123456789abcdef0123456789abcdef")).toBe(false);
    expect(isValidBoxToken("0123456789abcdef0123456789abcde ")).toBe(false);
  });
  it("rejects non-string input", () => {
    expect(isValidBoxToken(null as never)).toBe(false);
    expect(isValidBoxToken(undefined as never)).toBe(false);
    expect(isValidBoxToken(123 as never)).toBe(false);
    expect(isValidBoxToken({} as never)).toBe(false);
  });
});

describe("BOXES_DOMAIN (BET-198)", () => {
  it("is the literal boxes.mantaui.com suffix", () => {
    expect(BOXES_DOMAIN).toBe("boxes.mantaui.com");
  });
});

describe("boxDirectUrl (BET-198)", () => {
  it("builds the canonical https://<boxId>.boxes.mantaui.com URL", () => {
    expect(boxDirectUrl(HEX32)).toBe(`https://${HEX32}.boxes.mantaui.com`);
    expect(boxDirectUrl(HEX32_B)).toBe(`https://${HEX32_B}.boxes.mantaui.com`);
  });
  it("embeds the boxId as a subdomain (no /box/<id> suffix)", () => {
    const url = boxDirectUrl(HEX32);
    expect(url.startsWith(`https://${HEX32}.`)).toBe(true);
    expect(url).not.toContain("/box/");
  });
  it("throws on a wrong-length boxId", () => {
    expect(() => boxDirectUrl("abcdef")).toThrow(/32-hex/);
    expect(() => boxDirectUrl(HEX32 + "a")).toThrow(/32-hex/);
    expect(() => boxDirectUrl(HEX32.slice(0, 31))).toThrow(/32-hex/);
    expect(() => boxDirectUrl("")).toThrow(/32-hex/);
  });
  it("throws on uppercase or non-hex chars (lowercase-only — mirrors isValidBoxToken)", () => {
    expect(() => boxDirectUrl(HEX32.toUpperCase())).toThrow(/32-hex/);
    expect(() => boxDirectUrl("g123456789abcdef0123456789abcdef")).toThrow(/32-hex/);
    expect(() => boxDirectUrl("0123456789abcdef0123456789abcde ")).toThrow(/32-hex/);
  });
  it("throws on non-string input", () => {
    expect(() => boxDirectUrl(null as never)).toThrow(/32-hex/);
    expect(() => boxDirectUrl(undefined as never)).toThrow(/32-hex/);
    expect(() => boxDirectUrl(123 as never)).toThrow(/32-hex/);
  });
});

describe("resolveTransportMode", () => {
  it("http when a valid boxToken is set", () => {
    expect(resolveTransportMode({ boxToken: HEX32 })).toBe("http");
  });

  it("onboarding when boxToken is missing", () => {
    expect(resolveTransportMode({})).toBe("onboarding");
    expect(resolveTransportMode({ projects: [] })).toBe("onboarding");
    // onboardingSkipped no longer influences the result.
    expect(resolveTransportMode({ onboardingSkipped: true })).toBe("onboarding");
    expect(resolveTransportMode({ onboardingSkipped: false })).toBe("onboarding");
  });

  it("onboarding for a malformed boxToken (must NOT flip to http)", () => {
    expect(resolveTransportMode({ boxToken: "not-a-token" })).toBe("onboarding");
    expect(resolveTransportMode({ boxToken: "short" })).toBe("onboarding");
    expect(resolveTransportMode({ boxToken: HEX32.toUpperCase() })).toBe("onboarding");
  });

  it("onboarding for null / non-object input", () => {
    expect(resolveTransportMode(null)).toBe("onboarding");
    expect(resolveTransportMode(undefined)).toBe("onboarding");
    expect(resolveTransportMode("nope" as never)).toBe("onboarding");
  });
});

describe("parseClaimResponse", () => {
  it("accepts a valid { box_token, box_id } body", () => {
    const r = parseClaimResponse({ ok: true, box_token: HEX32, box_id: HEX32_B });
    expect(r).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32_B });
  });

  it("ignores extra fields", () => {
    const r = parseClaimResponse({
      box_token: HEX32,
      box_id: HEX32_B,
      extra: "whatever",
    });
    expect(r).toEqual({ ok: true, boxToken: HEX32, boxId: HEX32_B });
  });

  it("rejects a missing box_token", () => {
    expect(parseClaimResponse({ box_id: HEX32 })).toEqual({
      ok: false,
      error: "invalid_response",
    });
  });

  it("rejects a missing box_id", () => {
    expect(parseClaimResponse({ box_token: HEX32 })).toEqual({
      ok: false,
      error: "invalid_response",
    });
  });

  it("rejects a malformed token shape", () => {
    expect(parseClaimResponse({ box_token: "short", box_id: HEX32 })).toEqual({
      ok: false,
      error: "invalid_response",
    });
    expect(
      parseClaimResponse({ box_token: HEX32.toUpperCase(), box_id: HEX32 }),
    ).toEqual({ ok: false, error: "invalid_response" });
  });

  it("rejects an error body (e.g. { ok:false, error })", () => {
    expect(parseClaimResponse({ ok: false, error: "pairing failed" })).toEqual({
      ok: false,
      error: "invalid_response",
    });
  });

  it("rejects null / non-object / primitive bodies", () => {
    expect(parseClaimResponse(null)).toEqual({ ok: false, error: "invalid_response" });
    expect(parseClaimResponse(undefined)).toEqual({ ok: false, error: "invalid_response" });
    expect(parseClaimResponse("string")).toEqual({ ok: false, error: "invalid_response" });
    expect(parseClaimResponse(42)).toEqual({ ok: false, error: "invalid_response" });
    expect(parseClaimResponse([])).toEqual({ ok: false, error: "invalid_response" });
  });
});

describe("selectDesktopTransport (BET-82: always http)", () => {
  const paired = { boxToken: HEX32, serverUrl: "http://box:8787" };

  it("always returns 'http' on desktop (preload present)", () => {
    expect(selectDesktopTransport(paired, true)).toBe("http");
    expect(selectDesktopTransport({}, true)).toBe("http");
    expect(selectDesktopTransport({ projects: [] }, true)).toBe("http");    expect(selectDesktopTransport({ onboardingSkipped: true }, true)).toBe("http");
  });
  it("returns 'http' when no preload (mobile/web path; defensive)", () => {
    expect(selectDesktopTransport(paired, false)).toBe("http");
    expect(selectDesktopTransport({}, false)).toBe("http");
  });
});

describe("desktopHttpClientSeed (BET-58)", () => {
  it("returns the localStorage seed for a valid paired config", () => {
    expect(
      desktopHttpClientSeed({ boxToken: HEX32, serverUrl: "http://box:8787" }),
    ).toEqual({ manta_server: "http://box:8787", manta_token: HEX32 });
  });
  it("trims trailing slashes from serverUrl", () => {
    expect(
      desktopHttpClientSeed({ boxToken: HEX32, serverUrl: "http://box:8787///" }),
    ).toEqual({ manta_server: "http://box:8787", manta_token: HEX32 });
  });
  it("returns null when boxToken is missing/invalid", () => {
    expect(desktopHttpClientSeed({ serverUrl: "http://box:8787" })).toBeNull();
    expect(desktopHttpClientSeed({ serverUrl: "http://box:8787", boxToken: "nope" })).toBeNull();
  });
  it("returns null when serverUrl is empty/missing", () => {
    expect(desktopHttpClientSeed({ boxToken: HEX32 })).toBeNull();
    expect(desktopHttpClientSeed({ boxToken: HEX32, serverUrl: "   " })).toBeNull();
  });
  it("returns null for non-object input", () => {
    expect(desktopHttpClientSeed(null)).toBeNull();
    expect(desktopHttpClientSeed("x" as never)).toBeNull();
  });
});
