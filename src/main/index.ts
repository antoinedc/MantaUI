import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { join, basename } from "node:path";
import { existsSync, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { claimPairing } from "./auth.js";
import {
  startDesktopPresence,
  stopDesktopPresence,
} from "./desktopPresence.js";
import {
  startDesktopNotifications,
  stopDesktopNotifications,
} from "./desktopNotify.js";
import {
  startCapExecutor,
  stopCapExecutor,
} from "./capExecutor.js";
import { checkForUpdates } from "./autoUpdate.js";
import { IPC, type AppConfig, type AuthClaimInput } from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { projects: [] };

function commit(next: Partial<AppConfig>): AppConfig {
  config = { ...config, ...next };
  saveConfig(config);
  return config;
}

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
// 2. Desktop folder watcher: catches ⌘⇧3/4 (file-only shots). macOS names
//    them "Screenshot YYYY-MM-DD at HH.MM.SS.png". The fs.watch callback
//    fires on the rename event (file creation) and we filter by that pattern.
//    We push the absolute path so the renderer can scp it directly via
//    uploadFiles (no extra read needed).
//
// Both paths are no-ops when no mainWindow exists. The Desktop watcher is
// started once at app-ready and never restarted (the Desktop path doesn't
// change). The clipboard poller is the same.

const SCREENSHOT_RE = /^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}.*\.png$/i;

let screenshotClipboardTimer: ReturnType<typeof setInterval> | null = null;
let screenshotDesktopWatcher: ReturnType<typeof fsWatch> | null = null;

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

function startScreenshotDetector(): void {
  // macOS-only: the clipboard fingerprint relies on Mac's screencapture
  // populating the clipboard on ⌘⇧^3/4, and the file watcher targets the
  // Mac-default `~/Desktop/Screenshot YYYY-MM-DD at HH.MM.SS.png` filename.
  // On Linux/Windows both paths would no-op at best and burn CPU on the
  // 500ms clipboard poller at worst.
  if (process.platform !== "darwin") return;

  // --- Clipboard poller ---
  let lastFingerprint = clipboardImageFingerprint();
  screenshotClipboardTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const fp = clipboardImageFingerprint();
    if (fp && fp !== lastFingerprint) {
      lastFingerprint = fp;
      mainWindow.webContents.send(IPC.screenshotDetected, { source: "clipboard" });
    }
  }, 500);

  // --- Desktop folder watcher ---
  const desktop = join(homedir(), "Desktop");
  try {
    screenshotDesktopWatcher = fsWatch(desktop, (event, filename) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (event !== "rename" || !filename) return;
      if (!SCREENSHOT_RE.test(basename(filename))) return;
      const fullPath = join(desktop, filename);
      // Small delay — fs.watch fires on the rename (inode creation) before
      // the file is fully written. 300ms is enough for a PNG flush.
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(IPC.screenshotDetected, {
          source: "file",
          path: fullPath,
        });
      }, 300);
    });
  } catch {
    // Desktop might not exist or be accessible (e.g. on Linux in dev).
    // Silently skip — clipboard poller still works.
  }
}

function stopScreenshotDetector(): void {
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
function readClipboardImageBuffer(): Buffer | null {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toPNG();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0B1020",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Pin userData to the historical "better-ui" directory BEFORE setName(). Electron
// derives userData from the app name, so renaming to "Better UI" would silently
// repoint it to ".../Better UI/" — a fresh, empty dir — orphaning the existing
// config.json (host, projects) and leaving the app with no configured host.
app.setPath("userData", join(app.getPath("appData"), "better-ui"));

// Set the app name as early as possible (before `ready`). This drives the
// product name shown in the macOS menu bar, the dock, AND — for packaged
// builds — the source name on OS notifications (otherwise the renderer's
// Web Notification API attributes them to the bundle, i.e. "Electron" in dev).
// `appUserModelId` does the equivalent for Windows toast attribution.
app.setName("Manta UI");
app.setAppUserModelId("com.antoinedc.mantaui");

app.whenReady().then(() => {
  config = loadConfig();
  registerHandlers();
  // Dev-only: packaged builds get their dock icon from electron-builder
  // (assets/icon.icns). In dev the Electron binary has no icon, so the dock
  // shows the generic Electron icon + "Electron" tooltip. Set it at runtime
  // from the PNG so the dev dock matches the packaged app. app.isPackaged is
  // false in dev; app.dock only exists on macOS.
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(
      join(__dirname, "../../assets/icons/512x512.png"),
    );
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  createWindow();
  // Defer poller start until renderer is ready to receive events.
  mainWindow?.webContents.once("did-finish-load", () => {
    startScreenshotDetector();
    // Report desktop focus to the mobile server so it suppresses redundant
    // mobile "done" pushes while the user is active on desktop.
    startDesktopPresence(() => config);
    // Receive desktop OS-notification directives from bui-server's router
    // (over direct HTTPS) and relay them to the renderer.
    startDesktopNotifications(
      () => config,
      (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.desktopNotify, payload);
        }
      },
    );
    // Capability executor (BET-183 / BET-185 / BET-190): when enabled in
    // Settings, this Mac subscribes to bui-server's bus and runs the YAML
    // plugins it finds under ~/.manta/plugins/. startCapExecutor is a
    // no-op when pluginsEnabled is off.
    startCapExecutor(() => config);
    // Defer update check until after the renderer is ready (avoids blocking startup).
    // electron-updater skips the check in dev mode (unpacked app).
    setTimeout(() => checkForUpdates(), 5000);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopScreenshotDetector();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopScreenshotDetector();
  stopDesktopPresence();
  stopDesktopNotifications();
  stopCapExecutor();
});

function registerHandlers(): void {
  // Read ONLY by main.tsx's boot sequence (`chooseDesktopTransport`), before
  // httpApi is installed as `window.api` — used to seed httpApi's
  // localStorage credentials from the desktop's local config.json (pairing
  // triple). Called directly on `window.__buiPreload`, never through
  // `window.api` (which is httpApi post-boot and reaches config over
  // /rpc/config:get instead). See src/preload/index.ts and src/renderer/main.tsx.
  ipcMain.handle(IPC.configGet, () => config);

  // BET-207: `pluginsEnabled` is a Mac-machine-local toggle (controls
  // whether THIS Mac runs plugins). It MUST persist to the Mac-local
  // config the executor reads — NOT the box config that httpApi's
  // configUpdate writes. Handled here locally via commit() (same one-shot
  // pattern as configGet) so it works regardless of whether window.api is
  // the httpApi client. Renderer reaches these via the preload bridge,
  // not window.api.
  ipcMain.handle(IPC.pluginsGetEnabled, () => config.pluginsEnabled === true);
  ipcMain.handle(IPC.pluginsSetEnabled, (_e, value: boolean) => {
    commit({ pluginsEnabled: value === true });
  });

  // Clipboard write via Electron main — bypasses renderer permission restrictions
  // that silently block navigator.clipboard.writeText for non-user-gesture writes.
  ipcMain.handle(IPC.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text);
  });

  // Read the current clipboard image as PNG bytes (called on demand after a
  // screenshotDetected push — we don't read full pixel data in the poller).
  ipcMain.handle(IPC.clipboardReadImage, () => {
    const buf = readClipboardImageBuffer();
    return buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null;
  });

  // Read an arbitrary local (Mac) file's bytes. Used for Desktop screenshot
  // detection (screenshotDetected source:"file") — only main can touch the
  // OS filesystem; the renderer funnels the bytes into uploadBuffer from there.
  // `path` comes from our own fs.watch on the Desktop dir, not user input.
  ipcMain.handle(IPC.readLocalFile, async (_e, path: string) => {
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // Reveal a local file in Finder / the OS file manager. Expands a leading
  // `~/` against the user's home dir so callers can pass "shell-style" paths
  // (e.g. the Settings "Open plugins folder" button passes `~/.manta/plugins`)
  // — Electron's `shell.showItemInFolder` does NOT expand `~` itself, so
  // passing the literal string is a silent no-op. The folder's existence is
  // guarded so a stale/missing path no-ops instead of erroring to the renderer.
  ipcMain.handle(IPC.revealInFolder, (_e, localPath: string) => {
    if (!localPath) return;
    const abs = localPath.startsWith("~/")
      ? join(homedir(), localPath.slice(2))
      : localPath;
    if (!existsSync(abs)) return;
    shell.showItemInFolder(abs);
  });

  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url));

  // Onboarding pairing (BET-49): POST <serverUrl>/auth/claim, and on success
  // persist { serverUrl, boxId, boxToken } to config (via commit — which also
  // saves config.json). Presence of the valid boxToken flips transport to
  // "http" on the renderer's next config read. Returns a classified outcome;
  // an auth failure is a normal { ok:false }, not a thrown IPC error.
  ipcMain.handle(IPC.authClaim, (_e, input: AuthClaimInput) =>
    claimPairing(input, (patch) => commit(patch)),
  );

}
