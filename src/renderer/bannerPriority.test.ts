import { describe, it, expect } from "vitest";
import { pickBanner, BANNER_PRIORITY, type BannerState } from "./bannerPriority";

const off: BannerState = {
  reconnecting: false,
  incompatible: false,
  versionSkew: false,
  updateFailed: false,
  serverUpdate: false,
};

describe("pickBanner", () => {
  it("returns null when nothing is active", () => {
    expect(pickBanner(off)).toBeNull();
  });

  it("returns the only active kind", () => {
    expect(pickBanner({ ...off, serverUpdate: true })).toBe("server-update");
    expect(pickBanner({ ...off, updateFailed: true })).toBe("update-failed");
    expect(pickBanner({ ...off, versionSkew: true })).toBe("version-skew");
    expect(pickBanner({ ...off, incompatible: true })).toBe("incompatible");
    expect(pickBanner({ ...off, reconnecting: true })).toBe("reconnecting");
  });

  it("picks the highest severity when several co-occur", () => {
    // all on → reconnecting wins
    expect(pickBanner({ ...off, reconnecting: true, incompatible: true, versionSkew: true, updateFailed: true, serverUpdate: true })).toBe("reconnecting");
    // reconnecting off → incompatible wins
    expect(pickBanner({ ...off, incompatible: true, versionSkew: true, updateFailed: true, serverUpdate: true })).toBe("incompatible");
    // reconnecting + incompatible off → version-skew wins
    expect(pickBanner({ ...off, versionSkew: true, updateFailed: true, serverUpdate: true })).toBe("version-skew");
    // only the two lowest → update-failed wins over server-update
    expect(pickBanner({ ...off, updateFailed: true, serverUpdate: true })).toBe("update-failed");
  });

  it("priority order is exactly the spec severity chain", () => {
    expect(BANNER_PRIORITY).toEqual([
      "reconnecting",
      "incompatible",
      "version-skew",
      "update-failed",
      "server-update",
    ]);
  });
});
