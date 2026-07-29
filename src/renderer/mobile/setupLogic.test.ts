import { describe, it, expect } from "vitest";
import {
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
  resolveConnectRoute,
  normalizeServerUrl,
  prefillFromPairLink,
} from "./setupLogic";
import { boxDirectUrl } from "../../shared/transport.mjs";
import { CHANNELS, CHANNEL_IDS } from "../../shared/channel.mjs";

// BET-373 (review cycle 1): every channel's scheme, derived from the table
// (not hardcoded) so a fourth channel automatically extends this coverage —
// same pattern pairPayload.test.ts uses for the parser/builder themselves.
const SCHEMES = CHANNEL_IDS.map((id) => CHANNELS[id].urlScheme);

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2"; // 32 hex
const BAD_BOX = "not-a-box";
const TAILNET = "http://100.64.1.5:8787";

describe("canConnectSetup", () => {
  const base = { submitting: false };

  it("requires a valid box id AND 6-digit code", () => {
    expect(canConnectSetup({ ...base, boxId: VALID_BOX, code: "123456" })).toBe(true);
  });

  it("rejects a bad box id", () => {
    expect(canConnectSetup({ ...base, boxId: BAD_BOX, code: "123456" })).toBe(false);
  });

  it("rejects a short code", () => {
    expect(canConnectSetup({ ...base, boxId: VALID_BOX, code: "123" })).toBe(false);
  });

  it("never while submitting", () => {
    expect(
      canConnectSetup({ boxId: VALID_BOX, code: "123456", submitting: true }),
    ).toBe(false);
  });

  it("trims the box id before validating", () => {
    expect(
      canConnectSetup({ ...base, boxId: `  ${VALID_BOX}  `, code: "123456" }),
    ).toBe(true);
  });

  it("accepts an absent serverUrl (default path)", () => {
    expect(canConnectSetup({ ...base, boxId: VALID_BOX, code: "123456" })).toBe(true);
  });

  it("accepts an empty-string serverUrl (default path)", () => {
    expect(
      canConnectSetup({ ...base, boxId: VALID_BOX, code: "123456", serverUrl: "" }),
    ).toBe(true);
  });

  it("accepts a valid http(s) serverUrl (Advanced override)", () => {
    expect(
      canConnectSetup({
        ...base,
        boxId: VALID_BOX,
        code: "123456",
        serverUrl: TAILNET,
      }),
    ).toBe(true);
  });

  it("blocks submit when an explicit serverUrl is invalid", () => {
    expect(
      canConnectSetup({
        ...base,
        boxId: VALID_BOX,
        code: "123456",
        serverUrl: "ftp://100.x.y.z",
      }),
    ).toBe(false);
    expect(
      canConnectSetup({
        ...base,
        boxId: VALID_BOX,
        code: "123456",
        serverUrl: "100.64.1.5:8787",
      }),
    ).toBe(false);
  });
});

describe("buildSetupClaimInput", () => {
  it("emits boxDirectUrl(boxId) as the serverUrl + the raw code", () => {
    expect(buildSetupClaimInput({ boxId: VALID_BOX, code: "123456" })).toEqual({
      serverUrl: boxDirectUrl(VALID_BOX),
      code: "123456",
    });
  });

  it("trims the box id before building the URL", () => {
    expect(buildSetupClaimInput({ boxId: `  ${VALID_BOX}  `, code: "123456" })).toEqual({
      serverUrl: boxDirectUrl(VALID_BOX),
      code: "123456",
    });
  });

  it("uses the explicit serverUrl verbatim (Advanced, BET-268)", () => {
    expect(
      buildSetupClaimInput({ boxId: VALID_BOX, code: "123456", serverUrl: TAILNET }),
    ).toEqual({ serverUrl: TAILNET, code: "123456" });
  });

  it("normalizes trailing slashes on an explicit serverUrl", () => {
    expect(
      buildSetupClaimInput({
        boxId: VALID_BOX,
        code: "123456",
        serverUrl: "http://100.64.1.5:8787/",
      }),
    ).toEqual({ serverUrl: TAILNET, code: "123456" });
  });

  it("ignores an empty/absent serverUrl (falls back to boxDirectUrl)", () => {
    expect(
      buildSetupClaimInput({ boxId: VALID_BOX, code: "123456", serverUrl: "" }),
    ).toEqual({ serverUrl: boxDirectUrl(VALID_BOX), code: "123456" });
    expect(
      buildSetupClaimInput({ boxId: VALID_BOX, code: "123456" }),
    ).toEqual({ serverUrl: boxDirectUrl(VALID_BOX), code: "123456" });
  });
});

describe("resolveSetupServerUrl", () => {
  it("returns boxDirectUrl(boxId) (single source of truth)", () => {
    expect(resolveSetupServerUrl({ boxId: VALID_BOX })).toBe(boxDirectUrl(VALID_BOX));
  });

  it("trims the box id before building the URL", () => {
    expect(resolveSetupServerUrl({ boxId: `  ${VALID_BOX}  ` })).toBe(
      boxDirectUrl(VALID_BOX),
    );
  });

  it("persists the explicit serverUrl verbatim (BET-268 tailnet path)", () => {
    expect(
      resolveSetupServerUrl({ boxId: VALID_BOX, serverUrl: TAILNET }),
    ).toBe(TAILNET);
  });

  it("falls back to boxDirectUrl when serverUrl is empty/absent", () => {
    expect(
      resolveSetupServerUrl({ boxId: VALID_BOX, serverUrl: "" }),
    ).toBe(boxDirectUrl(VALID_BOX));
    expect(resolveSetupServerUrl({ boxId: VALID_BOX })).toBe(
      boxDirectUrl(VALID_BOX),
    );
  });
});

describe("normalizeServerUrl", () => {
  it("returns null for undefined / null / empty / whitespace-only", () => {
    expect(normalizeServerUrl(undefined)).toBeNull();
    expect(normalizeServerUrl(null)).toBeNull();
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
  });

  it("accepts a valid http URL", () => {
    expect(normalizeServerUrl("http://100.64.1.5:8787")).toBe(TAILNET);
  });

  it("accepts a valid https URL", () => {
    expect(normalizeServerUrl("https://box.example.com")).toBe(
      "https://box.example.com",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeServerUrl(`  ${TAILNET}  `)).toBe(TAILNET);
  });

  it("strips trailing slashes", () => {
    expect(normalizeServerUrl("http://100.64.1.5:8787/")).toBe(TAILNET);
    expect(normalizeServerUrl("http://100.64.1.5:8787///")).toBe(TAILNET);
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizeServerUrl("ftp://100.64.1.5:8787")).toBeNull();
    expect(normalizeServerUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeServerUrl("ws://100.64.1.5:8787")).toBeNull();
  });

  it("rejects a bare host without scheme", () => {
    expect(normalizeServerUrl("100.64.1.5:8787")).toBeNull();
    expect(normalizeServerUrl("box.example.com")).toBeNull();
  });
});

describe("resolveConnectRoute", () => {
  it("always returns 'direct' for a configured base", () => {
    expect(resolveConnectRoute(boxDirectUrl(VALID_BOX))).toBe("direct");
    expect(resolveConnectRoute("https://box.example.com")).toBe("direct");
  });

  it("returns 'direct' for empty/unset base (fresh install)", () => {
    expect(resolveConnectRoute("")).toBe("direct");
  });
});

describe("prefillFromPairLink (BET-335 deep-link prefill)", () => {
  const validLink = `manta://pair?box=${VALID_BOX}&code=123456`;
  const validHttps = `https://box.example.com/m/?box=${VALID_BOX}&code=123456`;

  it("returns {boxId, code} for a valid box-form manta:// pair link", () => {
    expect(prefillFromPairLink(validLink)).toEqual({
      boxId: VALID_BOX,
      code: "123456",
    });
  });

  it("returns {boxId, code} for a valid https deferred-deeplink form", () => {
    expect(prefillFromPairLink(validHttps)).toEqual({
      boxId: VALID_BOX,
      code: "123456",
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(prefillFromPairLink(`  ${validLink}  `)).toEqual({
      boxId: VALID_BOX,
      code: "123456",
    });
  });

  it("returns null for null / undefined / empty / whitespace-only input", () => {
    expect(prefillFromPairLink(null)).toBeNull();
    expect(prefillFromPairLink(undefined)).toBeNull();
    expect(prefillFromPairLink("")).toBeNull();
    expect(prefillFromPairLink("   ")).toBeNull();
  });

  it("returns null for a foreign URL (not a pairing payload)", () => {
    expect(prefillFromPairLink("https://example.com/foo")).toBeNull();
    expect(prefillFromPairLink("manta://other?box=x&code=y")).toBeNull();
  });

  it("returns null for a malformed pair link (bad box / bad code)", () => {
    expect(
      prefillFromPairLink(`manta://pair?box=not-a-box&code=123456`),
    ).toBeNull();
    expect(
      prefillFromPairLink(`manta://pair?box=${VALID_BOX}&code=abc`),
    ).toBeNull();
    expect(
      prefillFromPairLink(`manta://pair?box=${VALID_BOX}&code=12345`),
    ).toBeNull();
  });

  it("returns {boxId, code, serverUrl} for a valid link carrying a private server URL (BET-336)", () => {
    // The Tailscale pair link carries a private/tailnet listener URL.
    // The renderer-side prefill must surface that URL so PairStep can
    // pre-fill the Advanced field and open it by default.
    const link = `manta://pair?box=${VALID_BOX}&code=123456&server=${encodeURIComponent("http://100.64.1.5:8787")}`;
    expect(prefillFromPairLink(link)).toEqual({
      boxId: VALID_BOX,
      code: "123456",
      serverUrl: "http://100.64.1.5:8787",
    });
  });

  it("returns null for a link carrying a PUBLIC server URL (BET-336, crafted-link guard)", () => {
    // parsePairPayload refuses the whole payload when the server URL is
    // not private; prefillFromPairLink is a thin wrapper so it must do
    // the same — the desktop can't pre-fill a listener that the parser
    // refused.
    const link = `manta://pair?box=${VALID_BOX}&code=123456&server=${encodeURIComponent("https://attacker.example.com")}`;
    expect(prefillFromPairLink(link)).toBeNull();
  });

  // BET-373 (review cycle 1): PairStep.tsx reads `pendingPairLink` from the
  // store AFTER App.tsx already accepted it under the channel's own scheme
  // (App.tsx's PAIR_PARSE_SCHEME). Regression coverage for the Block: this
  // second parse MUST be given the same scheme, or a staging/dev pair link
  // is silently dropped one step after being correctly routed by the OS.
  describe("BET-373: per-channel scheme survives the prefill step", () => {
    for (const scheme of SCHEMES) {
      it(`prefills {boxId, code} for a ${scheme}:// link when called with scheme="${scheme}"`, () => {
        const link = `${scheme}://pair?box=${VALID_BOX}&code=123456`;
        expect(prefillFromPairLink(link, scheme)).toEqual({
          boxId: VALID_BOX,
          code: "123456",
        });
      });
    }

    it("drops the payload when called with the default scheme for a non-prod link (the bug this PR fixes)", () => {
      // Documents the exact failure the reviewer found: App.tsx accepts a
      // manta-staging:// link under its channel scheme and stores the raw
      // URL; calling prefillFromPairLink WITHOUT threading that same scheme
      // through (the pre-fix call site) falls back to "manta" and returns
      // null — the staging pair form renders empty.
      const staging = `manta-staging://pair?box=${VALID_BOX}&code=123456`;
      expect(prefillFromPairLink(staging)).toBeNull();
      expect(prefillFromPairLink(staging, "manta-staging")).toEqual({
        boxId: VALID_BOX,
        code: "123456",
      });
    });

    it("rejects a link built for a DIFFERENT channel's scheme (defensive boundary)", () => {
      const link = `manta-dev://pair?box=${VALID_BOX}&code=123456`;
      expect(prefillFromPairLink(link, "manta-staging")).toBeNull();
    });
  });
});
