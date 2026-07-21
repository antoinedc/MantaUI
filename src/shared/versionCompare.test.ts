import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isUpdateAvailable,
  isClientTooOld,
} from "./versionCompare.mjs";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
  });

  it("returns -1 when a < b (older)", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.3", "2.0.0")).toBe(-1);
    expect(compareVersions("0.0.0", "0.0.1")).toBe(-1);
  });

  it("returns 1 when a > b (newer)", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("0.0.1", "0.0.0")).toBe(1);
  });

  it("compares multi-digit segments numerically (1.10.0 > 1.9.0)", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.2.9", "1.2.10")).toBe(-1);
  });

  it("strips pre-release suffix and ignores it", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.4")).toBe(-1);
  });

  it("treats missing/empty input as 0.0.0", () => {
    expect(compareVersions("", "0.0.0")).toBe(0);
    expect(compareVersions("0.0.0", "")).toBe(0);
    expect(compareVersions(null, "0.0.0")).toBe(0);
    expect(compareVersions(undefined, "0.0.0")).toBe(0);
    expect(compareVersions(null, null)).toBe(0);
  });

  it("treats malformed (non-numeric segment) as 0.0.0", () => {
    expect(compareVersions("abc", "0.0.0")).toBe(0);
    expect(compareVersions("1.x.3", "1.0.0")).toBe(-1);
    expect(compareVersions("not.a.version", "0.0.1")).toBe(-1);
  });

  it("pads shorter versions with zeros", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });

  it("truncates longer versions to 3 segments", () => {
    expect(compareVersions("1.2.3.4", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3.4", "1.2.4")).toBe(-1);
  });
});

describe("isUpdateAvailable", () => {
  it("true when latest is strictly newer", () => {
    expect(isUpdateAvailable("1.2.3", "1.2.4")).toBe(true);
    expect(isUpdateAvailable("0.0.0", "0.0.1")).toBe(true);
    expect(isUpdateAvailable("", "0.0.1")).toBe(true);
  });

  it("false when latest equals current", () => {
    expect(isUpdateAvailable("1.2.3", "1.2.3")).toBe(false);
  });

  it("false when latest is older than current", () => {
    expect(isUpdateAvailable("2.0.0", "1.2.3")).toBe(false);
    expect(isUpdateAvailable("1.2.3", "1.2.3-beta")).toBe(false);
  });
});

describe("isClientTooOld", () => {
  it("true when client is strictly older than minClient", () => {
    expect(isClientTooOld("0.9.0", "1.0.0")).toBe(true);
    expect(isClientTooOld("", "0.0.1")).toBe(true);
  });

  it("false when client equals minClient", () => {
    expect(isClientTooOld("1.0.0", "1.0.0")).toBe(false);
  });

  it("false when client is newer than minClient", () => {
    expect(isClientTooOld("1.2.3", "1.0.0")).toBe(false);
  });
});
