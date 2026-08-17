// Tests for src/shared/screenshot.mjs — the pure detection helpers used by the
// macOS screen-capture detector (BET-1077).
//
// The regression this pins: macOS on a 12-hour clock names a screenshot with a
// single-digit hour ("Screenshot 2026-08-17 at 2.34.56 PM.png"), which the old
// `\d{2}` filename regex never matched — so detection only ever fired during
// the 10, 11 and 12 o'clock hours. Filenames are unreliable along five axes
// (clock format, macOS version, include-date, name prefix, locale), so the
// detector now keys off macOS's own extended attribute instead; these two
// helpers gate it cheaply.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isScreenshotCandidate,
  resolveScreenshotDir,
  SCREENSHOT_EXTENSIONS,
} from "./screenshot.mjs";

describe("screenshot — isScreenshotCandidate", () => {
  // Extension gate only. Filename contents are deliberately ignored — the
  // is-it-a-screenshot decision happens in the marker probe, not here.
  it("accepts the 12-hour single-digit-hour name (the reported bug)", () => {
    expect(isScreenshotCandidate("Screenshot 2026-08-17 at 2.34.56 PM.png")).toBe(true);
  });

  it("accepts a name with no date at all (include-date off)", () => {
    expect(isScreenshotCandidate("Screenshot 1.png")).toBe(true);
  });

  it("accepts non-English (German) screenshot names", () => {
    expect(isScreenshotCandidate("Bildschirmfoto 2026-08-17 um 14.02.11.png")).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(isScreenshotCandidate("shot.PNG")).toBe(true);
  });

  it("accepts heic captures", () => {
    expect(isScreenshotCandidate("capture.heic")).toBe(true);
  });

  it("rejects a non-screenshot text file", () => {
    expect(isScreenshotCandidate("notes.txt")).toBe(false);
  });

  it("rejects a name with no extension", () => {
    expect(isScreenshotCandidate("no-extension")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isScreenshotCandidate("")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isScreenshotCandidate(undefined)).toBe(false);
  });

  it("lists the screencapture type formats as the single source of truth", () => {
    expect(SCREENSHOT_EXTENSIONS).toEqual([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "tiff",
      "pdf",
      "heic",
    ]);
  });
});

describe("screenshot — resolveScreenshotDir", () => {
  it("falls back to ~/Desktop when the key is unset (empty string)", () => {
    expect(resolveScreenshotDir("")).toBe(join(homedir(), "Desktop"));
  });

  it("falls back to ~/Desktop on whitespace-only stdout", () => {
    expect(resolveScreenshotDir("   \n")).toBe(join(homedir(), "Desktop"));
  });

  it("falls back to ~/Desktop on a non-string", () => {
    expect(resolveScreenshotDir(undefined)).toBe(join(homedir(), "Desktop"));
  });

  it("trims a trailing newline from `defaults read` stdout", () => {
    expect(resolveScreenshotDir("/Users/x/Pictures\n")).toBe("/Users/x/Pictures");
  });

  it("expands a leading ~ against the homedir", () => {
    expect(resolveScreenshotDir("~/Shots")).toBe(join(homedir(), "Shots"));
  });

  it("strips trailing slash(es)", () => {
    expect(resolveScreenshotDir("/Users/x/Shots/")).toBe("/Users/x/Shots");
  });
});
