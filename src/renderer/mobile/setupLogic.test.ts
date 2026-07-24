import { describe, it, expect } from "vitest";
import {
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
  resolveConnectRoute,
  normalizeServerUrl,
} from "./setupLogic";
import { boxDirectUrl } from "../../shared/transport.mjs";

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
