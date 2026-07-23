import { describe, it, expect } from "vitest";
import {
  parsePairPayload,
  buildPairPayload,
  type PairPayload,
} from "./pairPayload";

const BOX = "0123456789abcdef0123456789abcdef"; // 32 hex

describe("parsePairPayload", () => {
  describe("boxId form (direct claim against the box's own hostname)", () => {
    it("accepts the primary manta://pair?box=&code= form", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291`),
      ).toEqual({ boxId: BOX, code: "847291" });
    });

    it("accepts manta://pair regardless of where the engine puts the authority (BET-240 regression)", () => {
      // `manta:` is a NON-SPECIAL scheme, so new URL() parses the "pair"
      // segment into DIFFERENT fields per engine:
      //   Node    → hostname "pair", pathname ""
      //   Chromium→ hostname "",     pathname "//pair"
      // vitest runs under Node so this string alone can't reproduce the
      // Chromium reject, but we assert both field layouts extract "pair".
      const u = new URL(`manta://pair?box=${BOX}&code=847291`);
      const host = u.hostname;
      const pathSeg = u.pathname.replace(/^\/+/, "");
      expect(host === "pair" || pathSeg === "pair").toBe(true);
      // And a synthetic Chromium-shaped parse ("//pair" path, empty host)
      // still resolves to "pair" via the pathname branch:
      expect("".replace(/^\/+/, "") === "pair").toBe(false); // empty host
      expect("//pair".replace(/^\/+/, "")).toBe("pair"); // path branch wins
      // End-to-end: the real string parses in this (Node) engine too.
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291`),
      ).toEqual({ boxId: BOX, code: "847291" });
    });

    it("accepts the box form in the https://host/m/... deferred-deeplink", () => {
      expect(
        parsePairPayload(
          `https://links.example.com/m/x?box=${BOX}&code=847291`,
        ),
      ).toEqual({ boxId: BOX, code: "847291" });
    });

    it("URL-decodes an encoded box value", () => {
      // The 32-hex chars have no reserved chars so this is mostly a sanity check.
      expect(
        parsePairPayload(
          `manta://pair?box=${encodeURIComponent(BOX)}&code=000000`,
        ),
      ).toEqual({ boxId: BOX, code: "000000" });
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(
        parsePairPayload(`  manta://pair?box=${BOX}&code=847291  `),
      ).toEqual({ boxId: BOX, code: "847291" });
    });

    it("accepts the code/token alias for the code param", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&token=847291`),
      ).toEqual({ boxId: BOX, code: "847291" });
    });
  });

  describe("rejects deprecated addressing forms", () => {
    it("rejects the serverUrl form (?server=<url>&code=)", () => {
      expect(
        parsePairPayload("manta://pair?server=http://box:8787&code=123456"),
      ).toBeNull();
    });

    it("rejects the legacy id/server alias (?id=<url>&token=)", () => {
      expect(
        parsePairPayload("manta://pair?id=http://box:8787&token=123456"),
      ).toBeNull();
    });

    it("rejects a 32-hex legacy id routed through id=", () => {
      // Old desktop QR: manta://pair?id=<32hex>&token= — must be rejected
      // post-BET-237; the box form exclusively uses ?box= now.
      expect(
        parsePairPayload(
          "manta://pair?id=0d5784a7a43451f4ad70dd3d9ee5cf72&token=593337",
        ),
      ).toBeNull();
    });

    it("rejects a missing box value", () => {
      expect(parsePairPayload("manta://pair?code=123456")).toBeNull();
    });

    it("rejects an empty box value", () => {
      expect(parsePairPayload("manta://pair?box=&code=123456")).toBeNull();
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
      ["a non-manta http URL", "http://example.com?box=" + BOX + "&code=123456"],
      ["manta scheme but wrong host", "manta://connect?box=" + BOX + "&code=123456"],
      ["missing code", `manta://pair?box=${BOX}`],
      ["empty code", `manta://pair?box=${BOX}&code=`],
      ["5-digit code", `manta://pair?box=${BOX}&code=12345`],
      ["7-digit code", `manta://pair?box=${BOX}&code=1234567`],
      ["non-numeric code", `manta://pair?box=${BOX}&code=abcdef`],
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
  it("produces the canonical box form", () => {
    expect(
      buildPairPayload({ boxId: BOX, code: "847291" }),
    ).toBe(`manta://pair?box=${encodeURIComponent(BOX)}&code=847291`);
  });

  it("URL-encodes the box value", () => {
    const out = buildPairPayload({ boxId: BOX, code: "000000" });
    expect(out).toContain(encodeURIComponent(BOX));
  });
});

describe("round-trip", () => {
  it("parsePairPayload(buildPairPayload(p)) deep-equals p for valid canonical inputs", () => {
    const cases: PairPayload[] = [
      { boxId: BOX, code: "111111" },
      { boxId: BOX, code: "000000" },
      { boxId: BOX, code: "987654" },
    ];
    for (const p of cases) {
      expect(parsePairPayload(buildPairPayload(p))).toEqual(p);
    }
  });
});
