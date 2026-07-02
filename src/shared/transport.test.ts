import { describe, it, expect } from "vitest";
import {
  isValidBoxToken,
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

describe("resolveTransportMode", () => {
  it("http when a valid boxToken is set (regardless of host)", () => {
    expect(resolveTransportMode({ boxToken: HEX32 })).toBe("http");
    // boxToken wins even if a legacy host is also present.
    expect(resolveTransportMode({ boxToken: HEX32, host: "box.example" })).toBe("http");
    // and even if onboardingSkipped is set.
    expect(
      resolveTransportMode({ boxToken: HEX32, onboardingSkipped: true }),
    ).toBe("http");
  });

  it("ignores a malformed boxToken and falls through to the next rule", () => {
    // A junk token must NOT flip us into a broken http mode.
    expect(resolveTransportMode({ boxToken: "not-a-token", host: "box" })).toBe("ssh");
    expect(resolveTransportMode({ boxToken: "not-a-token" })).toBe("onboarding");
    expect(
      resolveTransportMode({ boxToken: "not-a-token", onboardingSkipped: true }),
    ).toBe("ssh");
  });

  it("ssh when host is set and no boxToken (legacy config)", () => {
    expect(resolveTransportMode({ host: "box.example" })).toBe("ssh");
    // Full legacy shape (no new keys at all) → ssh. Existing users unchanged.
    expect(
      resolveTransportMode({
        host: "1.2.3.4",
        user: "dev",
        identityFile: "~/.ssh/id",
        projects: [{ tmuxSession: "p", defaultCwd: "~" }],
        transport: "auto",
      } as never),
    ).toBe("ssh");
  });

  it("treats a blank/whitespace host as unset", () => {
    expect(resolveTransportMode({ host: "" })).toBe("onboarding");
    expect(resolveTransportMode({ host: "   " })).toBe("onboarding");
    expect(resolveTransportMode({ host: "", onboardingSkipped: true })).toBe("ssh");
  });

  it("ssh when onboarding was explicitly skipped (no host, no token)", () => {
    expect(resolveTransportMode({ onboardingSkipped: true })).toBe("ssh");
    expect(
      resolveTransportMode({ onboardingSkipped: true, projects: [] }),
    ).toBe("ssh");
  });

  it("onboarding for a fresh/empty config", () => {
    expect(resolveTransportMode({})).toBe("onboarding");
    expect(resolveTransportMode({ host: "", projects: [] })).toBe("onboarding");
    // onboardingSkipped explicitly false is the same as absent.
    expect(resolveTransportMode({ onboardingSkipped: false })).toBe("onboarding");
    // A truthy-but-not-true value does not count as skipped.
    expect(resolveTransportMode({ onboardingSkipped: 1 as never })).toBe("onboarding");
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

describe("selectDesktopTransport (BET-58)", () => {
  const paired = { boxToken: HEX32, serverUrl: "http://box:8787" };
  const sshCfg = { host: "1.2.3.4", user: "dev" };

  it("returns 'http' for a paired config when preload is present", () => {
    expect(selectDesktopTransport(paired, true)).toBe("http");
  });
  it("returns 'preload' for an SSH-mode config (host set, no token)", () => {
    expect(selectDesktopTransport(sshCfg, true)).toBe("preload");
  });
  it("returns 'preload' for an onboarding config (nothing set)", () => {
    expect(selectDesktopTransport({}, true)).toBe("preload");
  });
  it("returns 'preload' for a skipped-onboarding config", () => {
    expect(selectDesktopTransport({ onboardingSkipped: true }, true)).toBe("preload");
  });
  it("SSH users are unaffected even if a stale serverUrl lingers without a token", () => {
    expect(selectDesktopTransport({ host: "1.2.3.4", serverUrl: "http://box:8787" }, true)).toBe(
      "preload",
    );
  });
  it("no preload → 'http' (mobile/web path; defensive)", () => {
    expect(selectDesktopTransport(paired, false)).toBe("http");
    expect(selectDesktopTransport({}, false)).toBe("http");
  });
});

describe("desktopHttpClientSeed (BET-58)", () => {
  it("returns the localStorage seed for a valid paired config", () => {
    expect(
      desktopHttpClientSeed({ boxToken: HEX32, serverUrl: "http://box:8787" }),
    ).toEqual({ bui_server: "http://box:8787", bui_token: HEX32 });
  });
  it("trims trailing slashes from serverUrl", () => {
    expect(
      desktopHttpClientSeed({ boxToken: HEX32, serverUrl: "http://box:8787///" }),
    ).toEqual({ bui_server: "http://box:8787", bui_token: HEX32 });
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
