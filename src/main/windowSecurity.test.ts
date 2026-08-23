import { describe, it, expect } from "vitest";
import {
  shouldAllowNavigation,
  externalUrlOrNull,
} from "./windowSecurity";

describe("shouldAllowNavigation", () => {
  it("allows navigating to the app's own URL (reload)", () => {
    expect(shouldAllowNavigation("file:///app/index.html", "file:///app/index.html")).toBe(true);
  });

  it("allows a same-URL reload in dev (http origin)", () => {
    expect(shouldAllowNavigation("http://localhost:5173/", "http://localhost:5173/")).toBe(true);
  });

  it("denies navigation to a foreign https origin", () => {
    expect(shouldAllowNavigation("file:///app/index.html", "https://evil.example")).toBe(false);
  });

  it("denies navigation to a file path", () => {
    expect(shouldAllowNavigation("file:///app/index.html", "file:///etc/passwd")).toBe(false);
  });

  it("denies a different same-origin path", () => {
    expect(shouldAllowNavigation("file:///app/index.html", "file:///app/other.html")).toBe(false);
  });

  it("denies when either side is unparseable (fail closed)", () => {
    expect(shouldAllowNavigation("file:///app/index.html", "not a url")).toBe(false);
    expect(shouldAllowNavigation("not a url", "file:///app/index.html")).toBe(false);
  });
});

describe("externalUrlOrNull", () => {
  it("returns the URL for http", () => {
    const url = externalUrlOrNull("http://example.com/path");
    expect(url).toBeInstanceOf(URL);
    expect(url?.href).toBe("http://example.com/path");
  });

  it("returns the URL for https", () => {
    const url = externalUrlOrNull("https://example.com/path");
    expect(url).toBeInstanceOf(URL);
    expect(url?.href).toBe("https://example.com/path");
  });

  it("returns null for file:", () => {
    expect(externalUrlOrNull("file:///etc/passwd")).toBeNull();
  });

  it("returns null for smb:", () => {
    expect(externalUrlOrNull("smb://server/share")).toBeNull();
  });

  it("returns null for javascript:", () => {
    expect(externalUrlOrNull("javascript:alert(1)")).toBeNull();
  });

  it("returns null for a custom scheme", () => {
    expect(externalUrlOrNull("manta://pair?box=abc&code=123456")).toBeNull();
  });

  it("returns null for unparseable garbage", () => {
    expect(externalUrlOrNull("not a url at all")).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(externalUrlOrNull(undefined as unknown as string)).toBeNull();
  });
});
