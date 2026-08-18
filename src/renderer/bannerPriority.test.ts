import { describe, it, expect } from "vitest";
import { pickBanner, BANNER_PRIORITY, type BannerState } from "./bannerPriority";

const off: BannerState = {
  reconnecting: false,
  incompatible: false,
  updates: false,
};

describe("pickBanner", () => {
  it("returns null when nothing is active", () => {
    expect(pickBanner(off)).toBeNull();
  });

  it("returns the only active kind", () => {
    expect(pickBanner({ ...off, updates: true })).toBe("updates");
    expect(pickBanner({ ...off, incompatible: true })).toBe("incompatible");
    expect(pickBanner({ ...off, reconnecting: true })).toBe("reconnecting");
  });

  it("picks the highest severity when several co-occur", () => {
    // all on → reconnecting wins
    expect(pickBanner({ ...off, reconnecting: true, incompatible: true, updates: true })).toBe("reconnecting");
    // reconnecting off → incompatible wins
    expect(pickBanner({ ...off, incompatible: true, updates: true })).toBe("incompatible");
    // only the low tier → updates wins
    expect(pickBanner({ ...off, updates: true })).toBe("updates");
  });

  it("priority order is exactly the spec severity chain", () => {
    expect(BANNER_PRIORITY).toEqual(["reconnecting", "incompatible", "updates"]);
  });
});
