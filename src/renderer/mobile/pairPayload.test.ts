import { describe, it, expect } from "vitest";
import {
  parsePairPayload,
  buildPairPayload,
  type PairPayload,
} from "./pairPayload";

const BOX = "0123456789abcdef0123456789abcdef"; // 32 hex

describe("parsePairPayload", () => {
  describe("serverUrl form (direct-HTTPS pairing)", () => {
    it("accepts the primary manta://pair?server=&code= form", () => {
      expect(
        parsePairPayload("manta://pair?server=http://box:8787&code=123456"),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });

    it("accepts the id/token alias and normalizes it to server/code", () => {
      expect(
        parsePairPayload("manta://pair?id=http://box:8787&token=123456"),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });

    it("routes a 32-hex legacy id to boxId (old desktop QR: id=<boxId>&token=)", () => {
      // Regression: an old desktop build emits manta://pair?id=<32hex>&token=.
      // The 32-hex value is a BOX ID, not a server URL — without shape-routing
      // it was http://-prefixed and mis-claimed as a bogus direct host, which
      // network-failed. Must resolve to the box form.
      expect(
        parsePairPayload(
          "manta://pair?id=0d5784a7a43451f4ad70dd3d9ee5cf72&token=593337",
        ),
      ).toEqual({
        serverUrl: null,
        boxId: "0d5784a7a43451f4ad70dd3d9ee5cf72",
        code: "593337",
      });
    });

    it("accepts the https://host/m/... deferred-deeplink form", () => {
      expect(
        parsePairPayload(
          "https://links.example.com/m/abc?server=http://box:8787&code=123456",
        ),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(
        parsePairPayload("  manta://pair?server=http://box:8787&code=123456  "),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });

    it("normalizes a bare-host server via normalizeServerUrl and strips trailing slashes", () => {
      // bare host:port (no scheme) → http:// prefixed
      expect(
        parsePairPayload("manta://pair?server=box:8787&code=123456"),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
      // trailing slashes stripped
      expect(
        parsePairPayload(
          "manta://pair?server=" +
            encodeURIComponent("http://box:8787///") +
            "&code=123456",
        ),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });

    it("URL-decodes an encoded server value", () => {
      expect(
        parsePairPayload(
          "manta://pair?server=" +
            encodeURIComponent("http://192.168.1.10:8787") +
            "&code=654321",
        ),
      ).toEqual({ serverUrl: "http://192.168.1.10:8787", boxId: null, code: "654321" });
    });
  });

  describe("boxId form (direct claim against the box's own hostname, BET-156)", () => {
    it("accepts the primary manta://pair?box=&code= form", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291`),
      ).toEqual({ serverUrl: null, boxId: BOX, code: "847291" });
    });

    it("accepts the box form in the https://host/m/... deferred-deeplink", () => {
      expect(
        parsePairPayload(
          `https://links.example.com/m/x?box=${BOX}&code=847291`,
        ),
      ).toEqual({ serverUrl: null, boxId: BOX, code: "847291" });
    });

    it("URL-decodes an encoded box value", () => {
      // The 32-hex chars have no reserved chars so this is mostly a sanity check.
      expect(
        parsePairPayload(
          `manta://pair?box=${encodeURIComponent(BOX)}&code=000000`,
        ),
      ).toEqual({ serverUrl: null, boxId: BOX, code: "000000" });
    });
  });

  describe("exactly-one-of (server OR box) — both or neither is invalid", () => {
    // Both present → invalid. Neither present → invalid. An empty value
    // counts as "not present", so `server=&box=<id>` and the inverse are
    // still VALID (one present, one empty) — they collapse to the present side.
    const both = `manta://pair?server=http://box:8787&box=${BOX}&code=123456`;
    const neither = "manta://pair?code=123456";
    for (const [label, input] of [
      ["both server and box present", both],
      ["neither server nor box present", neither],
    ]) {
      it(`rejects ${label}`, () => {
        expect(parsePairPayload(input)).toBeNull();
      });
    }
    it("treats empty server as not-present, so server=&box=<id> → valid box form", () => {
      expect(
        parsePairPayload(`manta://pair?server=&box=${BOX}&code=123456`),
      ).toEqual({ serverUrl: null, boxId: BOX, code: "123456" });
    });
    it("treats empty box as not-present, so server=<url>&box= → valid server form", () => {
      expect(
        parsePairPayload("manta://pair?server=http://box:8787&box=&code=123456"),
      ).toEqual({ serverUrl: "http://box:8787", boxId: null, code: "123456" });
    });
  });

  describe("boxId shape validation", () => {
    it("rejects a box value that is not 32 hex chars", () => {
      // Too short
      expect(
        parsePairPayload("manta://pair?box=deadbeef&code=123456"),
      ).toBeNull();
      // Non-hex
      expect(
        parsePairPayload("manta://pair?box=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz&code=123456"),
      ).toBeNull();
      // Too long
      expect(
        parsePairPayload(
          "manta://pair?box=" + "a".repeat(64) + "&code=123456",
        ),
      ).toBeNull();
    });
  });

  describe("returns null for malformed / foreign input", () => {
    const bad: Array<[string, string]> = [
      ["empty string", ""],
      ["whitespace only", "   "],
      ["a non-manta https URL", "https://example.com"],
      ["a non-manta http URL", "http://example.com?server=http://box:8787&code=123456"],
      ["manta scheme but wrong host", "manta://connect?server=http://box:8787&code=123456"],
      ["missing code", "manta://pair?server=http://box:8787"],
      ["empty server", "manta://pair?server=&code=123456"],
      ["empty code", "manta://pair?server=http://box:8787&code="],
      ["5-digit code", "manta://pair?server=http://box:8787&code=12345"],
      ["7-digit code", "manta://pair?server=http://box:8787&code=1234567"],
      ["non-numeric code", "manta://pair?server=http://box:8787&code=abcdef"],
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
  it("produces the canonical server form when serverUrl is set", () => {
    expect(
      buildPairPayload({ serverUrl: "http://box:8787", boxId: null, code: "123456" }),
    ).toBe(
      "manta://pair?server=" +
        encodeURIComponent("http://box:8787") +
        "&code=123456",
    );
  });

  it("URL-encodes the server value", () => {
    const out = buildPairPayload({
      serverUrl: "http://192.168.1.10:8787",
      boxId: null,
      code: "654321",
    });
    expect(out).toContain(encodeURIComponent("http://192.168.1.10:8787"));
    expect(out).not.toContain("http://192.168.1.10:8787&");
  });

  it("produces the canonical box form when boxId is set (BET-156)", () => {
    expect(
      buildPairPayload({ serverUrl: null, boxId: BOX, code: "847291" }),
    ).toBe(`manta://pair?box=${encodeURIComponent(BOX)}&code=847291`);
  });
});

describe("round-trip", () => {
  it("parsePairPayload(buildPairPayload(p)) deep-equals p for valid canonical inputs", () => {
    const cases: PairPayload[] = [
      { serverUrl: "http://box:8787", boxId: null, code: "123456" },
      { serverUrl: "http://192.168.1.10:8787", boxId: null, code: "000000" },
      { serverUrl: "https://box-direct.example.com", boxId: null, code: "987654" },
      { serverUrl: null, boxId: BOX, code: "111111" },
    ];
    for (const p of cases) {
      expect(parsePairPayload(buildPairPayload(p))).toEqual(p);
    }
  });
});
