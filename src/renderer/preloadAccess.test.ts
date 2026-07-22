// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getMantaPreload } from "./preloadAccess";
import type { MantaPreload } from "./preloadAccess";

// Simulate mobile/web: no preload, no __mantaPreload.
function mockMobileWeb(): void {
  const w = window as unknown as { __mantaPreload: MantaPreload | null };
  w.__mantaPreload = null;
}

// Build a fake preload with spy callbacks so we can verify forwarding.
function makeFakePreload(): MantaPreload {
  return {
    onScreenshotDetected: vi.fn((cb: (ev: unknown) => void) => {
      cb({ source: "clipboard" });
      return vi.fn();
    }),
    // BET-240: deep-link pairing bridge. Matches the MantaPreload shape in
    // src/renderer/preloadAccess.ts; we don't exercise its buffering here —
    // that's tested implicitly by App.tsx's wiring + PairStep's prefill.
    onPairLink: vi.fn((_cb: (url: string) => void) => vi.fn()),
    clipboardWriteText: vi.fn(async () => {}),
    clipboardReadImage: vi.fn(async () => null),
    readLocalFile: vi.fn(async () => new ArrayBuffer(0)),
    openExternal: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    getPathForFile: vi.fn((f: File) => f.name),
    onDesktopNotify: vi.fn((cb: (p: unknown) => void) => {
      cb({ kind: "test" });
      return vi.fn();
    }),
    peekRemoteFile: vi.fn(async () => {}),
    pluginsGetEnabled: vi.fn(async () => false),
    pluginsSetEnabled: vi.fn(async () => {}),
    // BET-225 stage 3: client version + server-update available. The fake
    // matches the MantaPreload shape added in src/renderer/preloadAccess.ts;
    // we only care about getMantaPreload's contract here, not the methods
    // themselves, so minimal vi.fn stubs suffice.
    clientVersion: vi.fn(async () => ({ version: "test-client" })),
    onServerUpdateAvailable: vi.fn((cb: (p: unknown) => void) => {
      cb({ version: "test-server", notesUrl: null });
      return vi.fn();
    }),
  };
}

describe("getMantaPreload", () => {
  beforeEach(() => {
    mockMobileWeb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null on mobile/web (no preload)", () => {
    expect(getMantaPreload()).toBeNull();
  });

  it("returns the real preload when __mantaPreload is set (Electron)", () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    expect(getMantaPreload()).toBe(fake);
  });

  it("forwards onScreenshotDetected to the callback", () => {
    const cb = vi.fn();
    let storedOff: (() => void) | null = null;
    const fake = makeFakePreload();
    fake.onScreenshotDetected = vi.fn((_fn: (ev: unknown) => void) => {
      storedOff = () => {};
      return storedOff;
    }) as unknown as MantaPreload["onScreenshotDetected"];
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    const preload = getMantaPreload();
    expect(preload).not.toBeNull();
    const off = preload!.onScreenshotDetected(cb);
    expect(off).toBe(storedOff);
    expect(typeof off).toBe("function");
  });

  it("forwards clipboardWriteText to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    const preload = getMantaPreload();
    expect(preload).not.toBeNull();
    await preload!.clipboardWriteText("hello");
    expect(fake.clipboardWriteText).toHaveBeenCalledWith("hello");
  });

  it("forwards openExternal to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    const preload = getMantaPreload();
    expect(preload).not.toBeNull();
    await preload!.openExternal("https://example.com");
    expect(fake.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("forwards revealInFolder to the preload", async () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    const preload = getMantaPreload();
    expect(preload).not.toBeNull();
    await preload!.revealInFolder("/tmp/foo");
    expect(fake.revealInFolder).toHaveBeenCalledWith("/tmp/foo");
  });

  it("forwards getPathForFile to the preload", () => {
    const fake = makeFakePreload();
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = fake;

    const preload = getMantaPreload();
    expect(preload).not.toBeNull();
    const file = new File(["x"], "test.txt");
    const result = preload!.getPathForFile(file);
    expect(fake.getPathForFile).toHaveBeenCalledWith(file);
    expect(result).toBe("test.txt");
  });

  it("returns null when __mantaPreload is not set (true mobile/web)", () => {
    // Ensure __mantaPreload is null (simulating mobile/web where no preload ran).
    const w = window as unknown as { __mantaPreload: MantaPreload | null };
    w.__mantaPreload = null;
    expect(getMantaPreload()).toBeNull();
  });
});
