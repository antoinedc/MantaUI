import { describe, it, expect } from "vitest";
import {
  parsePairPayload,
  buildPairPayload,
  type PairPayload,
} from "./pairPayload";
import { CHANNELS, CHANNEL_IDS } from "../../shared/channel.mjs";
// BET-386: install-lib.mjs's buildPairLink is the OTHER emitter of this
// wire shape (install.sh's pairing block, via scripts/manta-pair.mjs) —
// plain .mjs, no Electron/DOM dependency, importable straight into vitest's
// node environment (same as the CHANNELS import above). Cross-importing it
// here lets us round-trip the install-lib emitter against THIS module's
// parser in one place, rather than re-implementing the wire shape as a
// literal string in scripts/install.test.mjs (which is plain Node and
// can't load this .ts parser directly).
import { buildPairLink } from "../../../scripts/install-lib.mjs";

const BOX = "0123456789abcdef0123456789abcdef"; // 32 hex

// Every channel in the table — drives the per-channel test loops below so
// adding a fourth channel automatically extends coverage. The pairing wire
// format only depends on urlScheme, but looping the table makes a future
// PR that drops `manta` or adds a fourth scheme (e.g. "qa") impossible
// without updating the test.
const SCHEMES = CHANNEL_IDS.map((id) => CHANNELS[id].urlScheme);

describe("parsePairPayload", () => {
  describe("boxId form (direct claim against the box's own hostname)", () => {
    it("accepts the primary manta://pair?box=&code= form", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291`),
      ).toEqual({ boxId: BOX, code: "847291" });
    });

    it("parses an optional &verify= four-char code (BET-514 two-sided confirm)", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291&verify=K7Q2`),
      ).toEqual({ boxId: BOX, code: "847291", verify: "K7Q2" });
      // Normalizes whitespace + case ("k7 q2" → "K7Q2").
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291&verify=k7%20q2`),
      ).toEqual({ boxId: BOX, code: "847291", verify: "K7Q2" });
    });

    it("refuses a present-but-malformed verify (BET-514, never drops to legacy)", () => {
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291&verify=`),
      ).toBeNull();
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291&verify=K7`),
      ).toBeNull();
      expect(
        parsePairPayload(`manta://pair?box=${BOX}&code=847291&verify=K7Q2Z`),
      ).toBeNull();
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

  // BET-373: every channel's scheme is a legal pair-link prefix. The
  // wire format is identical across channels — same query, same code,
  // same server= gate — only the scheme prefix differs because that's
  // what the OS uses to identify which app to deliver the link to.
  describe("BET-373: per-channel scheme acceptance", () => {
    for (const scheme of SCHEMES) {
      it(`accepts ${scheme}://pair?... when configured with scheme="${scheme}"`, () => {
        expect(
          parsePairPayload(
            `${scheme}://pair?box=${BOX}&code=847291`,
            scheme,
          ),
        ).toEqual({ boxId: BOX, code: "847291" });
      });

      it(`accepts ${scheme}://pair?... with the URL-form Chromium-layout fallback (BET-240)`, () => {
        // The "pair" segment lands in pathname (Chromium) — the parser's
        // path-branch must still recover it for the channel's scheme.
        // Pin it per-channel so a future PR that only fixes one scheme's
        // URL parser can't slip through.
        const raw = `${scheme}://pair?box=${BOX}&code=847291`;
        expect(parsePairPayload(raw, scheme)).toEqual({
          boxId: BOX,
          code: "847291",
        });
      });

      it(`rejects ${scheme}://pair?... when the parser is configured for a DIFFERENT scheme`, () => {
        // The OS shouldn't have routed a `<scheme-A>://` link to a
        // `<scheme-B>://`-registered app in the first place, but the
        // parser enforces the same boundary defensively. A wrong-scheme
        // payload is refused outright (NOT silently re-accepted under
        // the parser's own scheme — that fallback would be the very
        // mis-delivery the per-channel boundary is supposed to prevent).
        for (const otherScheme of SCHEMES) {
          if (otherScheme === scheme) continue;
          expect(
            parsePairPayload(
              `${scheme}://pair?box=${BOX}&code=847291`,
              otherScheme,
            ),
          ).toBeNull();
        }
      });
    }

    it("the three schemes from CHANNELS are pairwise distinct (no future channel silently merges)", () => {
      // Sanity check on the SCHEMES list — loop above iterates these, so
      // any drift here would silently skip a channel. A `Set` of size 3
      // is the cheap pin that catches a copy-paste typo in CHANNELS.
      expect(new Set(SCHEMES).size).toBe(SCHEMES.length);
      expect(SCHEMES.length).toBe(3);
    });
  });

  // BET-386: scripts/install-lib.mjs's buildPairLink (the emitter behind
  // install.sh's printed pairing block / `manta pair`) must produce a link
  // this parser accepts for EVERY channel — not just the prod default the
  // pre-BET-386 test only covered. A future drift where the two emitters
  // (this module's buildPairPayload and install-lib's buildPairLink)
  // disagree on the scheme literal would fail here.
  describe("BET-386: install-lib's buildPairLink round-trips for every channel", () => {
    for (const scheme of SCHEMES) {
      it(`buildPairLink(..., { scheme: "${scheme}" }) round-trips through parsePairPayload`, () => {
        const link = buildPairLink(BOX, "847291", { scheme });
        expect(link).toBe(`${scheme}://pair?box=${BOX}&code=847291`);
        expect(parsePairPayload(link, scheme)).toEqual({
          boxId: BOX,
          code: "847291",
        });
      });
    }

    it("defaults to the manta:// scheme when no scheme is passed (back-compat)", () => {
      const link = buildPairLink(BOX, "847291");
      expect(link).toBe(`manta://pair?box=${BOX}&code=847291`);
      expect(parsePairPayload(link)).toEqual({ boxId: BOX, code: "847291" });
    });

    it("composes with a Tailscale serverUrl (BET-336) under a non-prod scheme", () => {
      const link = buildPairLink(BOX, "847291", {
        scheme: "manta-staging",
        serverUrl: "http://100.64.1.5:8787",
      });
      expect(parsePairPayload(link, "manta-staging")).toEqual({
        boxId: BOX,
        code: "847291",
        serverUrl: "http://100.64.1.5:8787",
      });
      // And it must NOT be accepted under a different channel's scheme —
      // same wrong-app-routing boundary as the prod-only case above.
      expect(parsePairPayload(link, "manta")).toBeNull();
    });
  });

  describe("rejects deprecated addressing forms", () => {
    it("rejects a link with a PUBLIC serverUrl (BET-336 — crafted-link guard)", () => {
      // BET-336: a `server=` carrying a public address is the exact attack
      // vector the private-URL gate prevents — a link that points the app
      // at an attacker-controlled host. The parser refuses the WHOLE
      // payload (does not silently drop the param and fall through to the
      // public hostname).
      expect(
        parsePairPayload("manta://pair?server=http://box:8787&code=123456"),
      ).toBeNull();
      expect(
        parsePairPayload(
          "manta://pair?server=https://example.com&code=123456",
        ),
      ).toBeNull();
      // Public IPv4, not in any accepted range.
      expect(
        parsePairPayload("manta://pair?server=http://8.8.8.8:8787&code=123456"),
      ).toBeNull();
    });

    it("rejects a link with a malformed serverUrl (BET-336)", () => {
      // Non-http(s) scheme → refusal.
      expect(
        parsePairPayload(
          "manta://pair?server=ftp://192.168.1.1&code=123456",
        ),
      ).toBeNull();
      // IPv6 literal → out of scope, refusal.
      expect(
        parsePairPayload(
          "manta://pair?server=http://[::1]:8787&code=123456",
        ),
      ).toBeNull();
    });

    it("accepts a PRIVATE serverUrl (BET-336 — Tailscale pair link)", () => {
      // The link now carries the listener; the receiver claims against it.
      const r = parsePairPayload(
        "manta://pair?box=" + BOX + "&code=123456&server=http://100.64.1.5:8787",
      );
      expect(r).toEqual({
        boxId: BOX,
        code: "123456",
        serverUrl: "http://100.64.1.5:8787",
      });
      // Also for a 192.168.x and a .ts.net hostname.
      expect(
        parsePairPayload(
          "manta://pair?box=" + BOX + "&code=123456&server=http://192.168.1.10:8787",
        ),
      ).toEqual({
        boxId: BOX,
        code: "123456",
        serverUrl: "http://192.168.1.10:8787",
      });
      expect(
        parsePairPayload(
          "manta://pair?box=" + BOX + "&code=123456&server=https://mybox.ts.net:8787",
        ),
      ).toEqual({
        boxId: BOX,
        code: "123456",
        serverUrl: "https://mybox.ts.net:8787",
      });
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

  it("appends &server=<url-encoded serverUrl> when present (BET-336)", () => {
    expect(
      buildPairPayload({
        boxId: BOX,
        code: "847291",
        serverUrl: "http://100.64.1.5:8787",
      }),
    ).toBe(
      `manta://pair?box=${encodeURIComponent(BOX)}&code=847291&server=${encodeURIComponent("http://100.64.1.5:8787")}`,
    );
  });

  it("omits the server param when serverUrl is absent or empty", () => {
    // Mirrors the unchanged wire shape for the pre-BET-336 / public
    // emitter — a regression here would break the round-trip for every
    // existing emitter.
    const without = buildPairPayload({ boxId: BOX, code: "847291" });
    expect(without).not.toContain("server=");
    const empty = buildPairPayload({ boxId: BOX, code: "847291", serverUrl: "" });
    expect(empty).not.toContain("server=");
  });

  // BET-514: the four-char two-sided-confirm code round-trips through the
  // wire so a CLI / web-paired device claims WITH it → DISTINCT Stage-2
  // device. Appended only when present and well-formed; a malformed verify
  // is a hard error, never a silent drop.
  it("appends &verify=<code> when present (BET-514)", () => {
    expect(
      buildPairPayload({ boxId: BOX, code: "847291", verify: "K7Q2" }),
    ).toBe(`manta://pair?box=${encodeURIComponent(BOX)}&code=847291&verify=K7Q2`);
  });

  it("normalizes whitespace/case before appending &verify (BET-514)", () => {
    expect(
      buildPairPayload({ boxId: BOX, code: "847291", verify: "k7 q2" }),
    ).toBe(`manta://pair?box=${encodeURIComponent(BOX)}&code=847291&verify=K7Q2`);
  });

  it("appends both &verify and &server in a stable order (BET-514)", () => {
    expect(
      buildPairPayload({
        boxId: BOX,
        code: "847291",
        verify: "K7Q2",
        serverUrl: "http://100.64.1.5:8787",
      }),
    ).toBe(
      `manta://pair?box=${encodeURIComponent(BOX)}&code=847291&verify=K7Q2&server=${encodeURIComponent("http://100.64.1.5:8787")}`,
    );
  });

  it("omits &verify when absent/empty (legacy back-compat)", () => {
    expect(buildPairPayload({ boxId: BOX, code: "847291" })).not.toContain("verify=");
    expect(
      buildPairPayload({ boxId: BOX, code: "847291", verify: "" }),
    ).not.toContain("verify=");
  });

  it("throws on a malformed verify (never silently drops it, BET-514)", () => {
    expect(() =>
      buildPairPayload({ boxId: BOX, code: "847291", verify: "K7Q" }),
    ).toThrow();
  });

  // BET-373: per-channel emission. The builder picks up the caller's
  // `scheme` arg verbatim — no derivation, no fallback chain — so the
  // OS-registered scheme and the wire-format scheme can never disagree.
  describe("BET-373: per-channel emission", () => {
    for (const scheme of SCHEMES) {
      it(`emits ${scheme}://pair?... when scheme="${scheme}"`, () => {
        expect(
          buildPairPayload({ boxId: BOX, code: "847291" }, scheme),
        ).toBe(`${scheme}://pair?box=${encodeURIComponent(BOX)}&code=847291`);
      });

      it(`appends &server=<…> on the channel's scheme when scheme="${scheme}"`, () => {
        // BET-336 + BET-373 together: the Tailscale pair link carries a
        // server URL AND a channel-aware scheme prefix. Pin both ends so
        // a future PR that loses the scheme arg on the server path can't
        // quietly regress.
        expect(
          buildPairPayload(
            { boxId: BOX, code: "847291", serverUrl: "http://100.64.1.5:8787" },
            scheme,
          ),
        ).toBe(
          `${scheme}://pair?box=${encodeURIComponent(BOX)}&code=847291&server=${encodeURIComponent("http://100.64.1.5:8787")}`,
        );
      });
    }
  });
});

describe("round-trip", () => {
  it("parsePairPayload(buildPairPayload(p)) deep-equals p for valid canonical inputs", () => {
    const cases: PairPayload[] = [
      { boxId: BOX, code: "111111" },
      { boxId: BOX, code: "000000" },
      { boxId: BOX, code: "987654" },
      // BET-336: round-trip preserves the server URL through both directions.
      { boxId: BOX, code: "111111", serverUrl: "http://100.64.1.5:8787" },
      { boxId: BOX, code: "000000", serverUrl: "http://192.168.1.10:8787" },
      { boxId: BOX, code: "987654", serverUrl: "https://mybox.ts.net" },
    ];
    for (const p of cases) {
      expect(parsePairPayload(buildPairPayload(p))).toEqual(p);
    }
  });

  // BET-373: round-trip per channel. The query is scheme-agnostic — the
  // same `{boxId, code, serverUrl}` shape comes out no matter which
  // scheme the build side picked, and a parse with the matching scheme
  // recovers it.
  describe("BET-373: build → parse round-trip per channel", () => {
    for (const scheme of SCHEMES) {
      it(`parsePairPayload(buildPairPayload(p, "${scheme}"), "${scheme}") deep-equals p`, () => {
        const cases: PairPayload[] = [
          { boxId: BOX, code: "111111" },
          { boxId: BOX, code: "000000" },
          { boxId: BOX, code: "987654" },
          { boxId: BOX, code: "111111", serverUrl: "http://100.64.1.5:8787" },
          { boxId: BOX, code: "000000", serverUrl: "http://192.168.1.10:8787" },
          { boxId: BOX, code: "987654", serverUrl: "https://mybox.ts.net" },
        ];
        for (const p of cases) {
          expect(
            parsePairPayload(buildPairPayload(p, scheme), scheme),
          ).toEqual(p);
        }
      });
    }
  });
});
