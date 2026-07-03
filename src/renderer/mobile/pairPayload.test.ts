import { describe, it, expect } from "vitest";
import {
  parsePairPayload,
  buildPairPayload,
  type PairPayload,
} from "./pairPayload";

describe("parsePairPayload", () => {
  it("accepts the primary bui://pair?server=&code= form", () => {
    expect(
      parsePairPayload("bui://pair?server=http://box:8787&code=123456"),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
  });

  it("accepts the id/token alias and normalizes it to server/code", () => {
    expect(
      parsePairPayload("bui://pair?id=http://box:8787&token=123456"),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
  });

  it("accepts the https://host/m/... deferred-deeplink form", () => {
    expect(
      parsePairPayload(
        "https://links.example.com/m/abc?server=http://box:8787&code=123456",
      ),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(
      parsePairPayload("  bui://pair?server=http://box:8787&code=123456  "),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
  });

  it("normalizes a bare-host server via normalizeServerUrl and strips trailing slashes", () => {
    // bare host:port (no scheme) → http:// prefixed
    expect(
      parsePairPayload("bui://pair?server=box:8787&code=123456"),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
    // trailing slashes stripped
    expect(
      parsePairPayload(
        "bui://pair?server=" +
          encodeURIComponent("http://box:8787///") +
          "&code=123456",
      ),
    ).toEqual({ serverUrl: "http://box:8787", code: "123456" });
  });

  it("URL-decodes an encoded server value", () => {
    expect(
      parsePairPayload(
        "bui://pair?server=" +
          encodeURIComponent("http://192.168.1.10:8787") +
          "&code=654321",
      ),
    ).toEqual({ serverUrl: "http://192.168.1.10:8787", code: "654321" });
  });

  describe("returns null for malformed / foreign input", () => {
    const bad: Array<[string, string]> = [
      ["empty string", ""],
      ["whitespace only", "   "],
      ["a non-bui https URL", "https://example.com"],
      ["a non-bui http URL", "http://example.com?server=http://box:8787&code=123456"],
      ["bui scheme but wrong host", "bui://connect?server=http://box:8787&code=123456"],
      ["missing code", "bui://pair?server=http://box:8787"],
      ["missing server", "bui://pair?code=123456"],
      ["empty server", "bui://pair?server=&code=123456"],
      ["empty code", "bui://pair?server=http://box:8787&code="],
      ["5-digit code", "bui://pair?server=http://box:8787&code=12345"],
      ["7-digit code", "bui://pair?server=http://box:8787&code=1234567"],
      ["non-numeric code", "bui://pair?server=http://box:8787&code=abcdef"],
      ["syntactically invalid URL", "::::not a url::::"],
      ["plain text", "hello world"],
    ];
    for (const [label, input] of bad) {
      it(label, () => {
        expect(parsePairPayload(input)).toBeNull();
      });
    }
  });
});

describe("buildPairPayload", () => {
  it("produces the canonical bui://pair?server=<enc>&code= string", () => {
    expect(
      buildPairPayload({ serverUrl: "http://box:8787", code: "123456" }),
    ).toBe(
      "bui://pair?server=" +
        encodeURIComponent("http://box:8787") +
        "&code=123456",
    );
  });

  it("URL-encodes the server value", () => {
    const out = buildPairPayload({
      serverUrl: "http://192.168.1.10:8787",
      code: "654321",
    });
    expect(out).toContain(encodeURIComponent("http://192.168.1.10:8787"));
    expect(out).not.toContain("http://192.168.1.10:8787&");
  });
});

describe("round-trip", () => {
  it("parsePairPayload(buildPairPayload(p)) deep-equals p for a valid canonical p", () => {
    const cases: PairPayload[] = [
      { serverUrl: "http://box:8787", code: "123456" },
      { serverUrl: "http://192.168.1.10:8787", code: "000000" },
      { serverUrl: "https://relay.example.com", code: "987654" },
    ];
    for (const p of cases) {
      expect(parsePairPayload(buildPairPayload(p))).toEqual(p);
    }
  });
});
