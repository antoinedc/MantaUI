import { describe, it, expect } from "vitest";
import {
  normalizeServerUrl,
  isValidServerUrl,
  canConnect,
} from "./pairStepLogic";

const CODE = "847291";

describe("normalizeServerUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl("  http://box:8787/  ")).toBe("http://box:8787");
    expect(normalizeServerUrl("http://box:8787///")).toBe("http://box:8787");
    expect(normalizeServerUrl("http://box:8787")).toBe("http://box:8787");
  });

  it("tolerates nullish", () => {
    expect(normalizeServerUrl(undefined as unknown as string)).toBe("");
    expect(normalizeServerUrl("")).toBe("");
  });
});

describe("isValidServerUrl", () => {
  it("accepts http(s) URLs with a host", () => {
    expect(isValidServerUrl("http://box:8787")).toBe(true);
    expect(isValidServerUrl("https://box-direct.example.com")).toBe(true);
    expect(isValidServerUrl("  http://192.168.1.10:8787/ ")).toBe(true);
  });

  it("rejects scheme-less / empty / non-http URLs", () => {
    expect(isValidServerUrl("")).toBe(false);
    expect(isValidServerUrl("box:8787")).toBe(false);
    expect(isValidServerUrl("ftp://box")).toBe(false);
    expect(isValidServerUrl("http://")).toBe(false);
  });
});

describe("canConnect", () => {
  it("true only with valid URL + 6-digit code + not submitting", () => {
    expect(
      canConnect({ serverUrl: "http://box:8787", code: CODE, submitting: false }),
    ).toBe(true);
  });

  it("false while submitting", () => {
    expect(
      canConnect({ serverUrl: "http://box:8787", code: CODE, submitting: true }),
    ).toBe(false);
  });

  it("false with a bad URL", () => {
    expect(
      canConnect({ serverUrl: "box:8787", code: CODE, submitting: false }),
    ).toBe(false);
    expect(
      canConnect({ serverUrl: "", code: CODE, submitting: false }),
    ).toBe(false);
  });

  it("false with an incomplete code", () => {
    expect(
      canConnect({ serverUrl: "http://box:8787", code: "1234", submitting: false }),
    ).toBe(false);
  });
});
