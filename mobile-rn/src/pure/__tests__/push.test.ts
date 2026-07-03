// push.test.ts — pure push-registration decision logic:
// should-register gate, backend-configured check, result classification,
// request-body shape. No expo-notifications / APNs backend required.

import { describe, expect, it } from "vitest";

import {
  buildRegisterBody,
  classifyRegistration,
  isPushBackendConfigured,
  shouldRegister,
} from "../push";

describe("shouldRegister", () => {
  it("proceeds only when permission is granted", () => {
    expect(shouldRegister("granted")).toBe(true);
    expect(shouldRegister("denied")).toBe(false);
    expect(shouldRegister("undetermined")).toBe(false);
  });
});

describe("isPushBackendConfigured", () => {
  it("is false when no endpoint is set (the default until M5)", () => {
    expect(isPushBackendConfigured(null)).toBe(false);
    expect(isPushBackendConfigured(undefined)).toBe(false);
    expect(isPushBackendConfigured({})).toBe(false);
    expect(isPushBackendConfigured({ endpoint: null })).toBe(false);
    expect(isPushBackendConfigured({ endpoint: "" })).toBe(false);
    expect(isPushBackendConfigured({ endpoint: "   " })).toBe(false);
  });

  it("is true only for a non-empty endpoint URL", () => {
    expect(isPushBackendConfigured({ endpoint: "https://relay/push" })).toBe(true);
  });
});

describe("classifyRegistration", () => {
  it("permission-denied when not granted (token ignored)", () => {
    expect(
      classifyRegistration({
        status: "denied",
        token: "tok",
        backendConfigured: true,
        posted: true,
      }),
    ).toEqual({ kind: "permission-denied" });
  });

  it("error when granted but no token was obtained", () => {
    const r = classifyRegistration({
      status: "granted",
      token: null,
      backendConfigured: false,
      posted: false,
    });
    expect(r.kind).toBe("error");
  });

  it("unconfigured when granted + token but no backend (no-op path)", () => {
    expect(
      classifyRegistration({
        status: "granted",
        token: "ExponentPushToken[abc]",
        backendConfigured: false,
        posted: false,
      }),
    ).toEqual({ kind: "unconfigured", token: "ExponentPushToken[abc]" });
  });

  it("registered when granted + token + backend + posted", () => {
    expect(
      classifyRegistration({
        status: "granted",
        token: "tok",
        backendConfigured: true,
        posted: true,
      }),
    ).toEqual({ kind: "registered", token: "tok" });
  });

  it("error when backend configured but the POST failed", () => {
    const r = classifyRegistration({
      status: "granted",
      token: "tok",
      backendConfigured: true,
      posted: false,
    });
    expect(r.kind).toBe("error");
  });
});

describe("buildRegisterBody", () => {
  it("pins the wire shape { token, boxId, platform }", () => {
    expect(
      buildRegisterBody({ token: "tok", boxId: "box123", platform: "ios" }),
    ).toEqual({ token: "tok", boxId: "box123", platform: "ios" });
  });
});
