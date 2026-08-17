// screenshot.mjs — pure helpers for detecting macOS screenshot files.
//
// No electron, no child_process — pure functions only. The screen-capture
// detector (src/main/screenshotDetector.ts) uses these to gate its file
// watcher cheaply before spawning an `xattr` probe per candidate.
//
// macOS names screenshot files in an unreliable way across five independent
// axes (clock format 12h/24h, macOS version, the include-date setting, the
// user-settable name prefix, and locale), so a filename pattern can never be
// the source of truth. These helpers only answer two cheap, stable questions:
// "is the extension one the screen-capture `type` setting accepts?" and
// "where does macOS actually save screenshots?" — the authoritative
// is-it-a-screenshot decision lives in the marker probe, keyed on macOS's own
// extended attribute, not here.

import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./paths.mjs";

// The formats `defaults write com.apple.screencapture type` accepts. A file
// with any other extension is not a screenshot candidate and is not worth
// spawning a probe for.
export const SCREENSHOT_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "tiff", "pdf", "heic"];

/**
 * True iff `filename` is a non-empty string whose extension (text after the
 * LAST `.`, lowercased) is in `SCREENSHOT_EXTENSIONS`. False for anything
 * else, including a non-string, an empty string, and a name with no `.`.
 */
export function isScreenshotCandidate(filename) {
  if (typeof filename !== "string" || filename === "") return false;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return SCREENSHOT_EXTENSIONS.includes(filename.slice(dot + 1).toLowerCase());
}

/**
 * `rawLocation` is the raw stdout of `defaults read com.apple.screencapture location`,
 * which may be an empty string (key unset), may have a trailing newline, and
 * may start with `~`. Returns the absolute screenshot directory.
 *
 * Rules applied in this order:
 * 1. If not a string, treat as `""`.
 * 2. Trim leading/trailing whitespace.
 * 3. If the result is empty -> `join(homedir(), "Desktop")`.
 * 4. Otherwise `expandTilde(...)` it, then strip any trailing `/`, and return.
 */
export function resolveScreenshotDir(rawLocation) {
  let s = typeof rawLocation === "string" ? rawLocation : "";
  s = s.trim();
  if (s === "") return join(homedir(), "Desktop");
  return expandTilde(s).replace(/\/+$/, "");
}
