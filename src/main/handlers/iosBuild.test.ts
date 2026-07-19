// Tests for the `pickSimulator` pure function — the ONLY iOS-specific
// algorithm in MantaUI's plugin system. Every test case is named in
// docs/mantuani-plugins.md §"ios.build handler" so adding a capability #2
// doesn't need to touch this file.

import { describe, it, expect } from "vitest";
import { pickSimulator, type SimDevice } from "./iosBuild.js";

function dev(
  name: string,
  state: string,
  extras: Partial<SimDevice> = {},
): SimDevice {
  return { udid: `udid-${name}`, name, state, isAvailable: true, ...extras };
}

describe("pickSimulator", () => {
  it("returns the preferred simulator when an exact name match exists", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 14", "Shutdown"),
          dev("iPhone 15", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices, "iPhone 15");
    expect(r).toEqual({ ok: true, udid: "udid-iPhone 15", name: "iPhone 15" });
  });

  it("returns the Booted simulator when preferred name is set and that one is Booted", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 15", "Shutdown"),
          dev("iPhone 15 Pro", "Booted"),
        ],
      },
    };
    const r = pickSimulator(devices, "iPhone 15 Pro");
    expect(r.ok).toBe(true);
    expect((r as { name: string }).name).toBe("iPhone 15 Pro");
  });

  it("returns an error listing available names when preferred name is not found", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 14", "Shutdown"),
          dev("iPhone 15", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices, "iPhone 99");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("iPhone 99");
    expect((r as { error: string }).error).toContain("iPhone 14");
    expect((r as { error: string }).error).toContain("iPhone 15");
  });

  it("falls back to the highest-runtime iPhone when no preferred name is set", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [
          dev("iPhone SE", "Shutdown"),
          dev("iPhone 14", "Shutdown"),
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 14", "Shutdown"),
          dev("iPhone 15", "Shutdown"),
          dev("iPad Pro", "Shutdown"),
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          dev("iPhone 16", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(true);
    expect((r as { name: string }).name).toBe("iPhone 16");
  });

  it("prefers a Booted simulator over runtime-version sort", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 15", "Shutdown"),
          dev("iPhone 14", "Booted"),
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          dev("iPhone 16", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(true);
    expect((r as { name: string }).name).toBe("iPhone 14");
  });

  it("returns an actionable error when no iOS simulators are installed", () => {
    const r = pickSimulator({ devices: {} });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/no iOS simulators/i);
  });

  it("returns an actionable error when no iOS simulators match (other runtimes present)", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.tvOS-17-0": [dev("Apple TV", "Shutdown")],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/no iOS simulators/i);
  });

  it("excludes devices with isAvailable === false", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPhone 15", "Shutdown", { isAvailable: false }),
          dev("iPhone 14", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(true);
    expect((r as { name: string }).name).toBe("iPhone 14");
  });

  it("ignores non-iOS runtime keys entirely", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.watchOS-10-0": [
          dev("Apple Watch", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(false);
  });

  it("handles a null/undefined devicesJson gracefully", () => {
    expect(pickSimulator(null).ok).toBe(false);
    expect(pickSimulator(undefined).ok).toBe(false);
  });

  it("falls back to the first candidate when no Booted and no iPhone-named device exists", () => {
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          dev("iPad Pro", "Shutdown"),
          dev("iPad Mini", "Shutdown"),
        ],
      },
    };
    const r = pickSimulator(devices);
    expect(r.ok).toBe(true);
    expect((r as { name: string }).name).toBe("iPad Pro");
  });
});
