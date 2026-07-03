// scanWiring.test.ts — QR-payload → claim wiring decision (pure):
// valid payload → {serverUrl, code}; invalid → error branch. Reuses the ported
// BET-73 parser via decideScan. Also covers camera-availability classification.

import { describe, expect, it } from "vitest";

import { buildPairPayload } from "../pairPayload";
import { classifyCameraAvailability, decideScan } from "../scanWiring";

describe("decideScan", () => {
  it("valid bui://pair QR → pair with {serverUrl, code}", () => {
    const raw = buildPairPayload({ serverUrl: "http://192.168.1.10:8787", code: "482913" });
    const d = decideScan(raw);
    expect(d.kind).toBe("pair");
    if (d.kind === "pair") {
      expect(d.payload).toEqual({ serverUrl: "http://192.168.1.10:8787", code: "482913" });
    }
  });

  it("accepts the https deferred-deeplink form", () => {
    const d = decideScan("https://links.example.com/m/abc?server=http://box:8787&code=100200");
    expect(d.kind).toBe("pair");
    if (d.kind === "pair") {
      expect(d.payload.code).toBe("100200");
      expect(d.payload.serverUrl).toBe("http://box:8787");
    }
  });

  it("accepts the id/token alias spelling", () => {
    const d = decideScan("bui://pair?id=http://box:8787&token=654321");
    expect(d.kind).toBe("pair");
    if (d.kind === "pair") expect(d.payload.code).toBe("654321");
  });

  it("a foreign QR (plain website) → invalid with a message", () => {
    const d = decideScan("https://example.com/hello");
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.message.length).toBeGreaterThan(0);
  });

  it("a bui pair URL missing the code → invalid", () => {
    const d = decideScan("bui://pair?server=http://box:8787");
    expect(d.kind).toBe("invalid");
  });

  it("a 5-digit (too short) code → invalid", () => {
    const d = decideScan("bui://pair?server=http://box:8787&code=12345");
    expect(d.kind).toBe("invalid");
  });

  it("garbage / non-URL input → invalid, never throws", () => {
    for (const raw of ["", "   ", "not a url", "12345678"]) {
      expect(() => decideScan(raw)).not.toThrow();
      expect(decideScan(raw).kind).toBe("invalid");
    }
  });
});

describe("classifyCameraAvailability", () => {
  it("null (no camera module — simulator) → unavailable", () => {
    expect(classifyCameraAvailability(null)).toBe("unavailable");
    expect(classifyCameraAvailability(undefined)).toBe("unavailable");
  });
  it("granted → ready", () => {
    expect(classifyCameraAvailability({ granted: true })).toBe("ready");
  });
  it("undetermined → prompt", () => {
    expect(
      classifyCameraAvailability({ granted: false, status: "undetermined", canAskAgain: true }),
    ).toBe("prompt");
  });
  it("denied but can ask again → prompt", () => {
    expect(
      classifyCameraAvailability({ granted: false, status: "denied", canAskAgain: true }),
    ).toBe("prompt");
  });
  it("denied and cannot ask again → denied", () => {
    expect(
      classifyCameraAvailability({ granted: false, status: "denied", canAskAgain: false }),
    ).toBe("denied");
  });
});
