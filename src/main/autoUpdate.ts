// autoUpdate.ts — auto-update checks for the Manta UI desktop app.
//
// Uses electron-updater's autoUpdater to:
//   1. Check for updates on app launch (after a short delay to avoid blocking startup)
//   2. Download updates silently in the background
//   3. Notify the renderer when an update is ready to install (via IPC)
//   4. Restart the app after the user confirms installation
//
// Update server: `https://mantaui.com/updates/` (electron-updater "generic"
// provider, configured in electron-builder.yml → `publish.url`). electron-
// updater reads the feed URL from `app-update.yml` baked at build time —
// no override here on purpose.
// In production, this is seamless. In dev (unpacked app), checks are skipped
// because there's no signed artifact to verify against.

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../shared/types.js";
import type { DesktopUpdateCheck } from "../shared/types.js";
import { shouldSurfaceUpdateError, describeUpdateError } from "../shared/updateError.mjs";

// Disable auto-download so we can prompt the user before installing.
// This gives us a chance to show a "Restart to update" dialog.
autoUpdater.autoDownload = false;

// Disable auto-install on download complete (we want user confirmation).
autoUpdater.autoInstallOnAppQuit = false;

// Log update events for debugging.
autoUpdater.on("checking-for-update", () => {
  console.log("[auto-update] Checking for updates...");
});

autoUpdater.on("update-available", (info) => {
  console.log(`[auto-update] Update available: ${info.version}`);
  notifyRenderer("updateAvailable", info);
});

autoUpdater.on("update-not-available", () => {
  console.log("[auto-update] No updates available.");
});

autoUpdater.on("update-downloaded", (info) => {
  console.log(`[auto-update] Update downloaded: ${info.version}`);
  // Tell the renderer to show the "Restart to update" prompt.
  notifyRenderer("updateDownloaded", info);
});

// Download progress. autoDownload is off, so a download only ever runs because
// the user pressed a button — and a 100MB DMG/ZIP over a slow link takes long
// enough that an un-progressed button is indistinguishable from a broken one.
autoUpdater.on("download-progress", (p) => {
  const percent = typeof p?.percent === "number" ? Math.max(0, Math.min(100, p.percent)) : 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.autoUpdateProgress, { percent });
  }
});

autoUpdater.on("error", (err) => {
  console.warn("[auto-update] Update error:", err.message);
  // A transient error (offline, DNS, timeout) fixes itself and must not nag.
  // A TERMINAL one (checksum/signature mismatch, can't replace the bundle)
  // means this install will never update again on its own — the user has to
  // act, so they have to be told. Swallowing these into the console above is
  // how 0.0.13 and 0.0.14 both shipped with a broken update feed unnoticed:
  // every launch failed verification in silence and the app just never
  // updated. See src/shared/updateError.mjs.
  if (!shouldSurfaceUpdateError(err.message)) return;
  notifyUpdateError(describeUpdateError(err.message), err.message);
});

/**
 * Push a terminal update failure to every open window. Separate from
 * notifyRenderer() because it carries both the human-facing copy and the raw
 * message (useful in logs / a support paste) rather than an UpdateInfo.
 */
function notifyUpdateError(message: string, raw: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.autoUpdateError, { message, raw });
    }
  }
}

/**
 * Send an update event to the renderer via IPC.
 * Safe to call before mainWindow exists — the event is simply dropped.
 */
function notifyRenderer(event: string, info: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      const channel = event === "updateAvailable"
        ? IPC.autoUpdateAvailable
        : IPC.autoUpdateDownloaded;
      win.webContents.send(channel, info);
    }
  }
}

// IPC handlers: renderer calls these to trigger download / quit-and-install.
// Both RETURN the underlying promise (rather than `() => { … }` bodies that
// resolve `undefined` immediately), so a failure REJECTS the renderer's
// `invoke` instead of being dropped. Without this the renderer cannot tell a
// transient download failure from success and leaves its "Downloading…" state
// stuck forever on a version that will never finish.
ipcMain.handle(IPC.autoUpdateDownload, () => autoUpdater.downloadUpdate());

ipcMain.handle(IPC.autoUpdateInstall, () => {
  autoUpdater.quitAndInstall();
});

/**
 * Run a check NOW and resolve with the verdict — the Settings → About button.
 *
 * Deliberately awaits electron-updater's own promise instead of listening for
 * `update-available` / `update-not-available`: `checkForUpdates()` resolves with
 * `{isUpdateAvailable, updateInfo}`, which is a definite answer, whereas the
 * events cannot express "up to date" to a specific caller (the not-available
 * event was log-only) and would force a timeout-and-guess.
 *
 * Never rejects. A button that throws leaves a spinner spinning; a failed check
 * resolves with `error` so the panel can say why. The `error` event handler
 * above still runs for the same failure — that is intended, since a terminal
 * failure deserves the persistent banner as well as the inline result.
 */
export async function runUpdateCheck(): Promise<DesktopUpdateCheck> {
  // An unpacked dev build has no updater (electron-updater refuses to verify an
  // unsigned tree). Report "not supported" rather than "up to date": claiming a
  // dev build is current is how a genuinely broken updater looks healthy.
  if (!app.isPackaged) {
    return { supported: false, available: false, version: null };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    // null when the updater declined to run at all (isUpdaterActive() false).
    if (!result) return { supported: false, available: false, version: null };
    const version = result.updateInfo?.version ?? null;
    return {
      supported: true,
      available: Boolean(result.isUpdateAvailable),
      version,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.warn("[auto-update] Manual check failed:", raw);
    return {
      supported: true,
      available: false,
      version: null,
      error: describeUpdateError(raw),
    };
  }
}

ipcMain.handle(IPC.autoUpdateCheck, () => runUpdateCheck());

/**
 * Check for updates. Safe to call in dev (unpacked app) — electron-updater
 * will skip the check gracefully.
 */
export function checkForUpdates(): void {
  // Only check for updates in packaged apps. In dev, electron-updater can't
  // verify the unsigned dev build against a signed release, so skip it.
  if (!app.isPackaged) {
    console.log("[auto-update] Skipping check in dev mode.");
    return;
  }

  void autoUpdater.checkForUpdates();
}
