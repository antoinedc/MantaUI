// autoUpdate.ts — auto-update checks for the Better UI desktop app.
//
// Uses electron-updater's autoUpdater to:
//   1. Check for updates on app launch (after a short delay to avoid blocking startup)
//   2. Download updates silently in the background
//   3. Notify the renderer when an update is ready to install (via IPC)
//   4. Restart the app after the user confirms installation
//
// Update server: GitHub Releases (configured in electron-builder.yml).
// In production, this is seamless. In dev (unpacked app), checks are skipped
// because there's no signed artifact to verify against.

import { autoUpdater } from "electron-updater";
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../shared/types.js";

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

autoUpdater.on("error", (err) => {
  console.warn("[auto-update] Update error:", err.message);
});

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
ipcMain.handle(IPC.autoUpdateDownload, () => {
  autoUpdater.downloadUpdate();
});

ipcMain.handle(IPC.autoUpdateInstall, () => {
  autoUpdater.quitAndInstall();
});

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
