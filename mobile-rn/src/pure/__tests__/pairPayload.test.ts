// pairPayload.test.ts — characterization tests for the ported BET-73 parser, so
// the RN copy stays behavior-equivalent to src/renderer/mobile/pairPayload.ts.

import { describe, expect, it } from "vitest";

import {
  buildPairPayload,
  isValidServerUrl,
  normalizeCode,
  normalizeServerUrl,
  parsePairPayload,
} from "../pairPayload";

describe("parsePairPayload", () => {
  it("parses the canonical bui://pair form", () => {
    expect(parsePairPayload("bui://pair?server=http://box:8787&code=123456")).toEqual({
      serverUrl: "http://box:8787",
      code: "123456",
    });
  });

  it("coerces a scheme-less bare host to http://", () => {
    expect(parsePairPayload("bui://pair?server=192.168.1.10:8787&code=123456")).toEqual({
      serverUrl: "http://192.168.1.10:8787",
      code: "123456",
    });
  });

  it("accepts the id/token alias and the https /m/ deferred form", () => {
    expect(parsePairPayload("bui://pair?id=http://box:8787&token=123456")?.code).toBe("123456");
    expect(
      parsePairPayload("https://l.example.com/m/x?server=http://box:8787&code=123456")?.serverUrl,
    ).toBe("http://box:8787");
  });

  it("rejects foreign / malformed payloads", () => {
    for (const raw of [
      "",
      "not a url",
      "https://example.com/hello", // https but not /m/
      "bui://other?server=http://box:8787&code=123456", // wrong host
      "bui://pair?code=123456", // missing server
      "bui://pair?server=http://box:8787", // missing code
      "bui://pair?server=http://box:8787&code=12345", // 5 digits
      "bui://pair?server=http://box:8787&code=1234567", // 7 digits
    ]) {
      expect(parsePairPayload(raw)).toBeNull();
    }
  });

  it("round-trips through buildPairPayload", () => {
    const p = { serverUrl: "http://192.168.1.10:8787", code: "778899" };
    expect(parsePairPayload(buildPairPayload(p))).toEqual(p);
  });
});

describe("url + code helpers", () => {
  it("normalizeServerUrl trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl("  http://box:8787///  ")).toBe("http://box:8787");
  });
  it("isValidServerUrl requires an http(s) scheme", () => {
    expect(isValidServerUrl("http://box:8787")).toBe(true);
    expect(isValidServerUrl("https://box")).toBe(true);
    expect(isValidServerUrl("box:8787")).toBe(false);
    expect(isValidServerUrl("")).toBe(false);
  });
  it("normalizeCode strips non-digits and clamps to 6", () => {
    expect(normalizeCode("12 34-56")).toBe("123456");
    expect(normalizeCode("1234567")).toBe("123456");
  });
});
