import { describe, it, expect } from "vitest";
import {
  isValidBoxToken,
  BOXES_DOMAIN,
  boxDirectUrl,
  resolveTransportMode,
  parseClaimResponse,
  selectDesktopTransport,
  desktopHttpClientSeed,
  isPrivateServerUrl,
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

describe("isPrivateServerUrl (BET-336 — Tailscale pair-link gate)", () => {
  // Accepted host families (the rule lives in transport.mjs — these tests
  // PIN the wire shape, not the algorithm). Every accepted case MUST come
  // from one of the named ranges; any drift here is a security regression
  // because the gate protects a user from a crafted pair link pointing the
  // app at an attacker's server.
  describe("accepts private / tailnet hosts", () => {
    it("localhost (http + https)", () => {
      expect(isPrivateServerUrl("http://localhost")).toBe(true);
      expect(isPrivateServerUrl("http://localhost:8787")).toBe(true);
      expect(isPrivateServerUrl("https://localhost")).toBe(true);
    });
    it("RFC 1918: 10.0.0.0/8", () => {
      expect(isPrivateServerUrl("http://10.0.0.0")).toBe(true);
      expect(isPrivateServerUrl("http://10.255.255.255")).toBe(true);
      expect(isPrivateServerUrl("https://10.1.2.3:8787")).toBe(true);
    });
    it("RFC 1918: 172.16.0.0/12 (172.16 – 172.31)", () => {
      expect(isPrivateServerUrl("http://172.16.0.1")).toBe(true);
      expect(isPrivateServerUrl("http://172.31.255.255")).toBe(true);
      expect(isPrivateServerUrl("https://172.20.10.5:8787")).toBe(true);
    });
    it("RFC 1918: 192.168.0.0/16", () => {
      expect(isPrivateServerUrl("http://192.168.0.1")).toBe(true);
      expect(isPrivateServerUrl("http://192.168.255.255")).toBe(true);
      expect(isPrivateServerUrl("https://192.168.1.10:8787")).toBe(true);
    });
    it("CGNAT / Tailscale: 100.64.0.0/10 (100.64 – 100.127)", () => {
      expect(isPrivateServerUrl("http://100.64.0.0")).toBe(true);
      expect(isPrivateServerUrl("http://100.127.255.255")).toBe(true);
      expect(isPrivateServerUrl("https://100.100.100.100:8787")).toBe(true);
    });
    it("loopback: 127.0.0.0/8", () => {
      expect(isPrivateServerUrl("http://127.0.0.1")).toBe(true);
      expect(isPrivateServerUrl("http://127.255.255.254")).toBe(true);
      expect(isPrivateServerUrl("https://127.0.0.1:8787")).toBe(true);
    });
    it("Tailscale MagicDNS (.ts.net)", () => {
      expect(isPrivateServerUrl("https://box.tail-net.ts.net")).toBe(true);
      expect(isPrivateServerUrl("http://mybox.ts.net:8787")).toBe(true);
    });
  });

  describe("rejects everything outside the accepted set", () => {
    it("rejects a public IPv4 (must NOT be accepted — the link-supplied override is for tailnet only)", () => {
      expect(isPrivateServerUrl("http://8.8.8.8")).toBe(false);
      expect(isPrivateServerUrl("https://1.1.1.1")).toBe(false);
      expect(isPrivateServerUrl("http://93.184.216.34:8787")).toBe(false);
    });
    it("rejects a public hostname", () => {
      expect(isPrivateServerUrl("https://example.com")).toBe(false);
      expect(isPrivateServerUrl("https://google.com:8787")).toBe(false);
      expect(isPrivateServerUrl("https://boxes.mantaui.com")).toBe(false);
    });
    it("rejects all IPv6 literals (out of scope — rejecting them is the intended behaviour)", () => {
      expect(isPrivateServerUrl("http://[::1]")).toBe(false);
      expect(isPrivateServerUrl("https://[fe80::1]:8787")).toBe(false);
      expect(isPrivateServerUrl("https://[2001:db8::1]")).toBe(false);
    });
    it("rejects a bare host with no scheme (not parseable as http(s) URL)", () => {
      expect(isPrivateServerUrl("100.64.1.5:8787")).toBe(false);
      expect(isPrivateServerUrl("box.ts.net")).toBe(false);
      expect(isPrivateServerUrl("192.168.1.1")).toBe(false);
    });
    it("rejects non-http(s) schemes", () => {
      expect(isPrivateServerUrl("ftp://192.168.1.1")).toBe(false);
      expect(isPrivateServerUrl("file:///etc/passwd")).toBe(false);
      expect(isPrivateServerUrl("ws://192.168.1.1:8787")).toBe(false);
      expect(isPrivateServerUrl("javascript:alert(1)")).toBe(false);
      expect(isPrivateServerUrl("manta://pair?server=100.64.1.5")).toBe(false);
    });
    it("rejects 172.15.x / 172.32.x (just outside /12)", () => {
      expect(isPrivateServerUrl("http://172.15.255.255")).toBe(false);
      expect(isPrivateServerUrl("http://172.32.0.0")).toBe(false);
    });
    it("rejects 100.63.x / 100.128.x (just outside /10)", () => {
      expect(isPrivateServerUrl("http://100.63.255.255")).toBe(false);
      expect(isPrivateServerUrl("http://100.128.0.0")).toBe(false);
    });
    it("rejects malformed / out-of-range octets in otherwise plausible hosts", () => {
      // These are all rejected at URL-parse time (WHATWG URL parser refuses
      // to construct them) so the function returns false without ever
      // inspecting the hostname.
      expect(isPrivateServerUrl("http://10.300.1.1")).toBe(false);
      expect(isPrivateServerUrl("http://10.1.1.256")).toBe(false);
      expect(isPrivateServerUrl("http://10.1.1.1.1")).toBe(false); // 5 octets
      expect(isPrivateServerUrl("http://10..0.1")).toBe(false); // empty octet
    });
    it("rejects a URL whose IPv4 octet uses a leading zero (octal-bypass guard)", () => {
      // The WHATWG URL parser NORMALIZES leading-zero IPv4 octets as
      // octal — `010` becomes the integer `8` and `http://010.0.0.1`
      // resolves to the public host `http://8.0.0.1`. The function must
      // reject this — the host `8.0.0.1` is not in any accepted range,
      // so a public address sneaks past our private gate. Pin the guard.
      expect(isPrivateServerUrl("http://010.0.0.1")).toBe(false);
    });
    it("accepts 127.0.0.1/8 — including the URL-parse-normalized octal form (127/8 is a loopback range, in scope)", () => {
      // Documented quirk: `http://0177.0.0.1` is normalized by the URL
      // parser to `http://127.0.0.1` (octal 177 → 127), which IS in the
      // loopback range and intentionally accepted (127.0.0.0/8 is one
      // of the families we accept, so the box-on-localhost path stays
      // one-click).
      expect(isPrivateServerUrl("http://0177.0.0.1")).toBe(true);
    });
    it("rejects unparseable input", () => {
      expect(isPrivateServerUrl("::::not a url::::")).toBe(false);
      expect(isPrivateServerUrl("hello world")).toBe(false);
    });
    it("rejects non-string input", () => {
      expect(isPrivateServerUrl(null as never)).toBe(false);
      expect(isPrivateServerUrl(undefined as never)).toBe(false);
      expect(isPrivateServerUrl(123 as never)).toBe(false);
      expect(isPrivateServerUrl({} as never)).toBe(false);
      expect(isPrivateServerUrl([] as never)).toBe(false);
      expect(isPrivateServerUrl("" as string)).toBe(false);
    });
  });
});
