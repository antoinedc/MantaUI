import { describe, it, expect } from "vitest";
import {
  classifyScanOutcome,
  useQrScanner,
  type ScanPermissionState,
  type ScanRawResult,
} from "./useQrScanner.js";

// ---------------------------------------------------------------------------
// classifyScanOutcome — pure (rawResult, permissionState) → typed outcome
// ---------------------------------------------------------------------------

const GRANTED: ScanPermissionState = { granted: true };
const DENIED: ScanPermissionState = { denied: true, granted: false };

describe("classifyScanOutcome", () => {
  it("passes a valid decoded string through on granted permission", () => {
    const raw: ScanRawResult = {
      hasContent: true,
      content: "bui://pair?server=http://box:8787&code=123456",
    };
    expect(classifyScanOutcome(raw, GRANTED)).toEqual({
      ok: true,
      value: "bui://pair?server=http://box:8787&code=123456",
    });
  });

  it("trims surrounding whitespace on the decoded string", () => {
    const raw: ScanRawResult = { hasContent: true, content: "  scanned  " };
    expect(classifyScanOutcome(raw, GRANTED)).toEqual({ ok: true, value: "scanned" });
  });

  it("maps a denied permission to reason 'denied'", () => {
    const raw: ScanRawResult = { hasContent: true, content: "whatever" };
    expect(classifyScanOutcome(raw, DENIED)).toEqual({ ok: false, reason: "denied" });
  });

  it("treats an absent/never-asked permission as 'denied'", () => {
    const raw: ScanRawResult = { hasContent: true, content: "whatever" };
    expect(classifyScanOutcome(raw, null)).toEqual({ ok: false, reason: "denied" });
    expect(classifyScanOutcome(raw, { neverAsked: true })).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("maps granted-but-no-content (user backed out) to 'cancelled'", () => {
    expect(classifyScanOutcome({ hasContent: false }, GRANTED)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(classifyScanOutcome(null, GRANTED)).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });

  it("maps granted + hasContent but empty string to 'cancelled'", () => {
    expect(classifyScanOutcome({ hasContent: true, content: "   " }, GRANTED)).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });
});

// ---------------------------------------------------------------------------
// useQrScanner — graceful degradation when no native plugin is present
// ---------------------------------------------------------------------------

describe("useQrScanner", () => {
  it("returns 'unavailable' in a plain browser (no Capacitor plugin)", async () => {
    // jsdom/node: globalThis.Capacitor is undefined → plugin unreachable.
    expect((globalThis as { Capacitor?: unknown }).Capacitor).toBeUndefined();
    await expect(useQrScanner()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
