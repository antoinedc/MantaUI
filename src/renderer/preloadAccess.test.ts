// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getBuiPreload } from "./preloadAccess";
import type { BuiPreload } from "./preloadAccess";

// Simulate mobile/web: no preload, no __buiPreload.
function mockMobileWeb(): void {
  const w = window as unknown as { __buiPreload: BuiPreload | null };
  w.__buiPreload = null;
}

// Build a fake preload with spy callbacks so we can verify forwarding.
function makeFakePreload(): BuiPreload {
  return {
    onScreenshotDetected: vi.fn((cb: (ev: unknown) => void) => {
      cb({ source: "clipboard" });
      return vi.fn();
    }),
    clipboardWriteText: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    getPathForFile: vi.fn((f: File) => f.name),
    onDesktopNotify: vi.fn((cb: (p: unknown) => void) => {
      cb({ kind: "test" });
      return vi.fn();
    }),
  };
}

describe("getBuiPreload", () => {
  beforeEach(() => {
    mockMobileWeb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null on mobile/web (no preload)", () => {
    expect(getBuiPreload()).toBeNull();
  });

  it("returns the real preload when __buiPreload is set (Electron)", () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    expect(getBuiPreload()).toBe(fake);
  });

  it("forwards onScreenshotDetected to the callback", () => {
    const cb = vi.fn();
    let storedOff: (() => void) | null = null;
    const fake = makeFakePreload();
    fake.onScreenshotDetected = vi.fn((_fn: (ev: unknown) => void) => {
      storedOff = () => {};
      return storedOff;
    }) as unknown as BuiPreload["onScreenshotDetected"];
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    const preload = getBuiPreload();
    expect(preload).not.toBeNull();
    const off = preload!.onScreenshotDetected(cb);
    expect(off).toBe(storedOff);
    expect(typeof off).toBe("function");
  });

  it("forwards clipboardWriteText to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    const preload = getBuiPreload();
    expect(preload).not.toBeNull();
    await preload!.clipboardWriteText("hello");
    expect(fake.clipboardWriteText).toHaveBeenCalledWith("hello");
  });

  it("forwards openExternal to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    const preload = getBuiPreload();
    expect(preload).not.toBeNull();
    await preload!.openExternal("https://example.com");
    expect(fake.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("forwards revealInFolder to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    const preload = getBuiPreload();
    expect(preload).not.toBeNull();
    await preload!.revealInFolder("/tmp/foo");
    expect(fake.revealInFolder).toHaveBeenCalledWith("/tmp/foo");
  });

  it("forwards getPathForFile to the preload", () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = fake;

    const preload = getBuiPreload();
    expect(preload).not.toBeNull();
    const file = new File(["x"], "test.txt");
    const result = preload!.getPathForFile(file);
    expect(fake.getPathForFile).toHaveBeenCalledWith(file);
    expect(result).toBe("test.txt");
  });

  it("returns null when __buiPreload is not set (true mobile/web)", () => {
    // Ensure __buiPreload is null (simulating mobile/web where no preload ran).
    const w = window as unknown as { __buiPreload: BuiPreload | null };
    w.__buiPreload = null;
    expect(getBuiPreload()).toBeNull();
  });
});
