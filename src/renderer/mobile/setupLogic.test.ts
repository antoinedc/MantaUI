import { describe, it, expect } from "vitest";
import {
  DEFAULT_SERVER_URL,
  isRelayServer,
  canConnectSetup,
  buildSetupClaimInput,
  resolveSetupServerUrl,
} from "./setupLogic";

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2"; // 32 hex
const BAD_BOX = "not-a-box";

describe("isRelayServer", () => {
  it("true for the default relay URL", () => {
    expect(isRelayServer(DEFAULT_SERVER_URL)).toBe(true);
  });
  it("ignores trailing slash / whitespace", () => {
    expect(isRelayServer(" https://relay.mantaui.com/ ")).toBe(true);
  });
  it("false for a custom server URL", () => {
    expect(isRelayServer("https://box.example.com")).toBe(false);
  });
});

describe("canConnectSetup — relay mode", () => {
  const base = { serverUrl: DEFAULT_SERVER_URL, submitting: false };
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
      canConnectSetup({ ...base, boxId: VALID_BOX, code: "123456", submitting: true }),
    ).toBe(false);
  });
});

describe("canConnectSetup — custom mode", () => {
  it("requires only a valid URL + code (box id irrelevant)", () => {
    expect(
      canConnectSetup({
        serverUrl: "https://box.example.com",
        boxId: "",
        code: "123456",
        submitting: false,
      }),
    ).toBe(true);
  });
  it("rejects an invalid URL", () => {
    expect(
      canConnectSetup({
        serverUrl: "box.example.com",
        boxId: "",
        code: "123456",
        submitting: false,
      }),
    ).toBe(false);
  });
});

describe("buildSetupClaimInput", () => {
  it("relay mode → empty serverUrl + boxId", () => {
    expect(
      buildSetupClaimInput({ serverUrl: DEFAULT_SERVER_URL, boxId: VALID_BOX, code: "123456" }),
    ).toEqual({ serverUrl: "", boxId: VALID_BOX, code: "123456" });
  });
  it("relay mode trims the box id", () => {
    expect(
      buildSetupClaimInput({ serverUrl: DEFAULT_SERVER_URL, boxId: `  ${VALID_BOX}  `, code: "123456" }),
    ).toEqual({ serverUrl: "", boxId: VALID_BOX, code: "123456" });
  });
  it("custom mode → normalized serverUrl, no boxId", () => {
    expect(
      buildSetupClaimInput({ serverUrl: "https://box.example.com/", boxId: "ignored", code: "123456" }),
    ).toEqual({ serverUrl: "https://box.example.com", code: "123456" });
  });
});

describe("resolveSetupServerUrl", () => {
  it("relay mode → per-box relay proxy URL", () => {
    expect(resolveSetupServerUrl({ serverUrl: DEFAULT_SERVER_URL, boxId: VALID_BOX })).toBe(
      `https://relay.mantaui.com/box/${VALID_BOX}`,
    );
  });
  it("custom mode → normalized typed URL", () => {
    expect(resolveSetupServerUrl({ serverUrl: "https://box.example.com/", boxId: "" })).toBe(
      "https://box.example.com",
    );
  });
});
