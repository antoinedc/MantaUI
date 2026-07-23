// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted to the top of the file, so any variable the
// factory references must also be hoisted. vi.hoisted gives us a value that
// exists at hoist-time AND is reachable from inside the factory and the tests.
const { httpApiSentinel } = vi.hoisted(() => ({
  httpApiSentinel: { __sentinel: "httpApi" } as { __sentinel: string },
}));

// Mock httpApi so importing transportInstall doesn't pull the heavy httpApi
// dependency graph (rpc, ws, store, log, …). The sentinel object is what
// `installHttpTransport` assigns to window.api, so equality-based assertions
// are exact.
vi.mock("./api/httpApi", () => ({ httpApi: httpApiSentinel }));

import { installHttpTransport, setWindowApi } from "./transportInstall";

describe("installHttpTransport", () => {
  beforeEach(() => {
    // Reset window.api between tests so each test starts on a clean slate.
    delete (window as unknown as { api?: unknown }).api;
  });

  it("seeds both localStorage keys and swaps window.api to httpApi", () => {
    // Seed an unrelated value to confirm it isn't clobbered by anything else.
    localStorage.setItem("unrelated", "keep-me");

    const result = installHttpTransport({
      manta_server: "https://x.boxes.mantaui.com",
      manta_token: "y",
    });

    expect(result).toBe(true);
    expect(localStorage.getItem("manta_server")).toBe(
      "https://x.boxes.mantaui.com",
    );
    expect(localStorage.getItem("manta_token")).toBe("y");
    expect(window.api).toBe(httpApiSentinel);
    // Unrelated keys are not touched.
    expect(localStorage.getItem("unrelated")).toBe("keep-me");
  });

  it("returns false and does NOT swap window.api when localStorage throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Simulate a private-mode / disabled-storage environment by stubbing the
    // prototype — vi.spyOn(localStorage, "setItem") doesn't intercept jsdom's
    // own setItem (it's defined on the Storage prototype in a way that
    // vi.spyOn at the instance level does not see).
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const result = installHttpTransport({
      manta_server: "https://x.boxes.mantaui.com",
      manta_token: "y",
    });

    expect(result).toBe(false);
    // installHttpTransport must NOT swap window.api when storage fails —
    // fallback is "keep whatever was there" (the preload bridge).
    expect(window.api).not.toBe(httpApiSentinel);
    expect(setItemSpy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    setItemSpy.mockRestore();
    warn.mockRestore();
  });
});

describe("setWindowApi", () => {
  it("overwrites window.api with a writable, configurable value", () => {
    const first = { tag: "first" };
    const second = { tag: "second" };
    setWindowApi(first);
    expect(window.api).toBe(first);
    setWindowApi(second);
    expect(window.api).toBe(second);
    // Must remain writable so a later boot path / pairing can swap it again.
    (window as unknown as { api: unknown }).api = { tag: "third" };
    expect(window.api).toEqual({ tag: "third" });
  });
});
