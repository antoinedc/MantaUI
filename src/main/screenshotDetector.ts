// ===== Screenshot detector =====
//
// Two parallel detection paths — together they cover all four macOS screenshot
// shortcuts without any native module:
//
// 1. Clipboard poller (500ms): catches ⌘⇧Control+3/4 (clipboard-only shots).
//    Tracks clipboard "generation" by hashing availableFormats() + image size;
//    when a new image appears it pushes screenshotDetected to the renderer.
//    We intentionally do NOT read the full pixel buffer every tick — only
//    formats + size, so the poll is cheap. The renderer calls uploadBuffer
//    which reads the clipboard once via a separate IPC.
//
// 2. File watcher: catches ⌘⇧3/4 (file-only shots) no matter where they're
//    saved. We key off macOS's own marker rather than the filename: macOS
//    stamps every screenshot it writes with the extended attribute
//    com.apple.metadata:kMDItemIsScreenCapture, which survives renaming,
//    moving, locale and clock format — the filename is unreliable along five
//    independent axes (12h/24h clock, macOS version, include-date setting,
//    user-set name prefix, locale). The watch directory is read from
//    `defaults read com.apple.screencapture location` (it's configurable),
//    defaulting to ~/Desktop when unset.
//
// Both paths are no-ops when no mainWindow exists. The file watcher is
// started once at app-ready and never restarted. The clipboard poller is
// the same.

import { clipboard } from "electron";
import { basename, join } from "node:path";
import { watch as fsWatch } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IPC } from "../shared/types.js";
import { isScreenshotCandidate, resolveScreenshotDir } from "../shared/screenshot.mjs";

const execFileAsync = promisify(execFile);

let screenshotClipboardTimer: ReturnType<typeof setInterval> | null = null;
let screenshotDesktopWatcher: ReturnType<typeof fsWatch> | null = null;

// macOS stamps every screenshot it writes with this extended attribute. It is
// set by the OS at creation and survives renaming, moving and any locale — it
// is the only reliable signal that a file is a screenshot. `xattr` reads the
// file directly; `mdls` would ask Spotlight, which can be disabled per volume.
// exit 0 = attribute present. Any error (missing attr, missing file,
// permission) = not a screenshot. Must never throw.
async function isScreenshotFile(path: string): Promise<boolean> {
  try {
    await execFileAsync("xattr", [
      "-p",
      "com.apple.metadata:kMDItemIsScreenCapture",
      path,
    ]);
    return true;
  } catch {
    return false;
  }
}

// Cheap fingerprint: join of available formats + "<w>x<h>". We don't hash
// pixel data — just enough to detect "something new appeared".
function clipboardImageFingerprint(): string {
  const fmts = clipboard.availableFormats().join(",");
  if (!fmts.includes("image")) return "";
  const img = clipboard.readImage();
  if (img.isEmpty()) return "";
  const { width, height } = img.getSize();
  return `${fmts}|${width}x${height}`;
}

// Resolve the screenshot destination and watch it. The `defaults` read is
// async, hence the watcher setup lives here rather than inline in
// `startScreenshotDetector` (which must keep returning `void`).
async function initFileWatcher(send: (channel: string, payload: unknown) => void): Promise<void> {
  let rawLocation = "";
  try {
    const { stdout } = await execFileAsync("defaults", [
      "read",
      "com.apple.screencapture",
      "location",
    ]);
    rawLocation = stdout;
  } catch {
    // Key unset — normal. rawLocation stays "" so resolveScreenshotDir returns
    // the ~/Desktop default. Not an error, must not be logged as one.
  }
  const dir = resolveScreenshotDir(rawLocation);
  try {
    screenshotDesktopWatcher = fsWatch(dir, (event, filename) => {
      if (event !== "rename" || !filename) return;
      if (!isScreenshotCandidate(basename(filename))) return;
      const fullPath = join(dir, filename);
      // Small delay — fs.watch fires on the rename (inode creation) before
      // the file is fully written. 300ms is enough for a PNG flush, and the
      // marker probe below needs the file to exist on disk.
      setTimeout(() => {
        void isScreenshotFile(fullPath).then((isShot) => {
          if (!isShot) return;
          send(IPC.screenshotDetected, { source: "file", path: fullPath });
        });
      }, 300);
    });
  } catch {
    // Directory might not exist or be accessible. Silently skip — clipboard
    // poller still works.
  }
}

export function startScreenshotDetector(
  send: (channel: string, payload: unknown) => void,
): void {
  // macOS-only: the clipboard fingerprint relies on Mac's screencapture
  // populating the clipboard on ⌘⇧^3/4, and the file watcher targets Mac's
  // screen-capture destination. On Linux/Windows both paths would no-op at
  // best and burn CPU on the 500ms clipboard poller at worst.
  if (process.platform !== "darwin") return;

  // --- Clipboard poller ---
  let lastFingerprint = clipboardImageFingerprint();
  screenshotClipboardTimer = setInterval(() => {
    const fp = clipboardImageFingerprint();
    if (fp && fp !== lastFingerprint) {
      lastFingerprint = fp;
      send(IPC.screenshotDetected, { source: "clipboard" });
    }
  }, 500);

  // --- File watcher ---
  void initFileWatcher(send);
}

export function stopScreenshotDetector(): void {
  if (screenshotClipboardTimer) {
    clearInterval(screenshotClipboardTimer);
    screenshotClipboardTimer = null;
  }
  if (screenshotDesktopWatcher) {
    screenshotDesktopWatcher.close();
    screenshotDesktopWatcher = null;
  }
}

// IPC: renderer calls this to read the current clipboard image as PNG bytes.
// Separate from the poller so we only read full pixel data on demand.
export function readClipboardImageBuffer(): Buffer | null {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toPNG();
}
