import { describe, it, expect } from "vitest";
import {
  dotTone,
  badgeLabel,
  digestBusy,
  type CtoState,
} from "./ctoView";

const base: CtoState = {
  enabled: true,
  dot: "active",
  needsYouCount: 0,
  generationInFlight: false,
  tonightCount: 0,
};

describe("dotTone (§10.1 state dot)", () => {
  it("maps active → ok", () => {
    expect(dotTone("active")).toBe("ok");
  });
  it("maps thrifty → warn", () => {
    expect(dotTone("thrifty")).toBe("warn");
  });
  it("maps paused → danger (error)", () => {
    expect(dotTone("paused")).toBe("error");
  });
  it("maps disabled → idle (tx4 grey)", () => {
    expect(dotTone("disabled")).toBe("idle");
  });
  it("defaults an unknown/undefined dot to idle", () => {
    expect(dotTone(undefined)).toBe("idle");
  });
});

describe("badgeLabel (§10.1 needs-you badge)", () => {
  it("hides at zero", () => {
    expect(badgeLabel(base)).toBeNull();
  });
  it("shows the count when open needs-you items exist", () => {
    expect(badgeLabel({ ...base, needsYouCount: 3 })).toBe(3);
  });
  it("treats a null state as zero (hidden)", () => {
    expect(badgeLabel(null)).toBeNull();
  });
  it("never shows zero even when the count is negative", () => {
    expect(badgeLabel({ ...base, needsYouCount: -1 })).toBeNull();
  });
});

describe("digestBusy (§10.2 Digest-now single-flight spinner)", () => {
  it("is idle when the server is not generating", () => {
    expect(digestBusy(base)).toBe(false);
  });
  it("is busy while the server generation is in flight", () => {
    expect(digestBusy({ ...base, generationInFlight: true })).toBe(true);
  });
  it("treats null state as idle", () => {
    expect(digestBusy(null)).toBe(false);
  });
});
