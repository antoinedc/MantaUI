import { describe, it, expect } from "vitest";
import {
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
  resolveConnectRoute,
} from "./setupLogic";
import { boxDirectUrl } from "../../shared/transport.mjs";

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2"; // 32 hex
const BAD_BOX = "not-a-box";

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
