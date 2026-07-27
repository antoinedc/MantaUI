import { describe, it, expect } from "vitest";
import {
  classifyUpdateError,
  shouldSurfaceUpdateError,
  describeUpdateError,
} from "./updateError.mjs";

describe("classifyUpdateError", () => {
  it("REGRESSION: the real checksum-mismatch message is integrity, not transient", () => {
    // This is the error every 0.0.13/0.0.14 install hit on every launch while
    // the published feed described the pre-staple DMG. It was swallowed into a
    // console.warn, so two releases shipped undeliverable.
    const real =
      "sha512 checksum mismatch, expected TauhvBXmsr2WBSmYBPMiYQOEYaV9AzD5SsZ4DlVV7Mz…, got HWqkMAtj/VObVh9sj4TZYIputEKuIE/9WB69j/qXkIJ…";
    expect(classifyUpdateError(real)).toBe("integrity");
    expect(shouldSurfaceUpdateError(real)).toBe(true);
  });

  it.each([
    ["checksum mismatch on download", "integrity"],
    ["Integrity check failed", "integrity"],
    ["code signature validation failed", "integrity"],
    ["The application is not signed", "integrity"],
  ])("classifies %j as %s", (msg, kind) => {
    expect(classifyUpdateError(msg)).toBe(kind);
  });

  it.each([
    ["EACCES: permission denied, rename '/Applications/Manta UI.app'", "permission"],
    ["EPERM: operation not permitted", "permission"],
    ["cannot write to read-only volume", "permission"],
  ])("classifies %j as %s", (msg, kind) => {
    expect(classifyUpdateError(msg)).toBe(kind);
  });

  it.each([
    "net::ERR_INTERNET_DISCONNECTED",
    "getaddrinfo ENOTFOUND mantaui.com",
    "connect ETIMEDOUT 91.107.196.2:443",
    "HttpError: 503 Service Unavailable",
  ])("stays quiet for the transient failure %j", (msg) => {
    expect(classifyUpdateError(msg)).toBe("transient");
    expect(shouldSurfaceUpdateError(msg)).toBe(false);
  });

  it("defaults to transient for unknown/empty input rather than nagging", () => {
    expect(classifyUpdateError("")).toBe("transient");
    expect(classifyUpdateError(null)).toBe("transient");
    expect(classifyUpdateError(undefined)).toBe("transient");
    expect(classifyUpdateError("something weird happened")).toBe("transient");
    expect(shouldSurfaceUpdateError(null)).toBe(false);
  });
});

describe("describeUpdateError", () => {
  it("tells the user to download manually on an integrity failure", () => {
    const copy = describeUpdateError("sha512 checksum mismatch");
    expect(copy).toMatch(/integrity check/i);
    expect(copy).toMatch(/manually/i);
  });

  it("tells the user about /Applications on a permission failure", () => {
    expect(describeUpdateError("EACCES: permission denied")).toMatch(/\/Applications/);
  });
});
