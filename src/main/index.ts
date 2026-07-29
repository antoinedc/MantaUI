import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { basename, join } from "node:path";
import { existsSync, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { claimPairing } from "./auth.js";
import { unpairBox } from "./unpair.js";
import {
  startDesktopPresence,
  stopDesktopPresence,
} from "./desktopPresence.js";
import {
  startDesktopNotifications,
  stopDesktopNotifications,
} from "./desktopNotify.js";
import {
  startServerUpdateForwarder,
  stopServerUpdateForwarder,
} from "./serverUpdateForwarder.js";
import {
  startCapExecutor,
  stopCapExecutor,
} from "./capExecutor.js";
import { checkForUpdates } from "./autoUpdate.js";
import { titleBarOptions } from "./windowChrome.js";
import { registerInstallerHandlers } from "./installer/handlers.js";
import {
  resolveChannel,
  channelConfig,
} from "../shared/channel.mjs";
import { IPC, type AppConfig, type AuthClaimInput } from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Build-channel plumbing (BET-370). The baked value comes from electron-vite's
// `define` (electron.vite.config.ts) — the ambient declaration lives in
// src/main/buildDefines.d.ts. `resolveChannel` enforces the rule:
//   isPackaged === false → "dev"  (npm run dev has no notion of release)
//   otherwise             → bakedChannel if valid, else "prod" (never throws)
// All per-channel values (userDataDir, appName, urlScheme, ...) flow through
// `channelConfig(CHANNEL)` — there is no per-channel branch anywhere in this
// file.
const BAKED_CHANNEL =
  typeof __MANTA_CHANNEL__ === "string" ? __MANTA_CHANNEL__ : "prod";
const CHANNEL = resolveChannel(app.isPackaged, BAKED_CHANNEL);
const CHANNEL_CONFIG = channelConfig(CHANNEL);
// URL prefix used to recognise this channel's deep-link at every entry point
// (warm open-url, second-instance argv, cold-start process.argv). Built from
// the channel config — never a literal — so a future channel inherits the
// pattern without touching this file.
const PAIR_PREFIX = `${CHANNEL_CONFIG.urlScheme}://`;

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
    ...titleBarOptions(process.platform),
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

// Pin userData to a stable directory BEFORE setName() (Electron otherwise
// derives it from the app name, which would repoint it whenever the name
// changes). Per-channel: dev uses `manta-dev`, staging uses `manta-staging`,
// prod uses `manta` — so each channel's install runs fully isolated from
// the others (its own config.json, pairing, sessions, settings).
app.setPath("userData", join(app.getPath("appData"), CHANNEL_CONFIG.userDataDir));

// ---------------------------------------------------------------------------
// <scheme>:// deep-link pairing (protocol handler). The scheme name comes
// from the build channel — prod registers `manta`, staging `manta-staging`,
// dev `manta-dev` — so an OS can hand the same URL prefix to whichever
// channel owns it.
//
// Registration + capture live in main; parsing/validation happens renderer-
// side with the same parsePairPayload the PairStep paste field uses, so
// there is exactly ONE parser for the wire format.
//
// All three channels register. Dev's `manta-dev://` registration is
// best-effort and warm-only (rule 6): npm run dev reuses the shared
// node_modules/electron bundle, so the scheme resolves to generic Electron
// and `npm install` clobbers it. Register anyway — warm delivery to a
// running dev instance works, and the registration is harmless.
// ---------------------------------------------------------------------------
app.setAsDefaultProtocolClient(CHANNEL_CONFIG.urlScheme);

let pendingPairUrl: string | null = null;

function deliverPairLink(url: string): void {
  if (typeof url !== "string" || !url.startsWith(PAIR_PREFIX)) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(IPC.pairLinkReceived, url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    // window not up yet (cold start) — flushed from the did-finish-load hook
    pendingPairUrl = url;
  }
}

// macOS delivers protocol URLs via open-url (warm AND cold start — cold-start
// delivery arrives before ready, which is why pendingPairUrl exists).
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverPairLink(url);
});

// Windows/Linux deliver protocol URLs as argv of a SECOND instance; the lock
// forwards them to the running one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find((a) => a.startsWith(PAIR_PREFIX));
    if (url) deliverPairLink(url);
  });
}

// Set the app name as early as possible (before `ready`). This drives the
// product name shown in the macOS menu bar, the dock, AND — for packaged
// builds — the source name on OS notifications (otherwise the renderer's
// Web Notification API attributes them to the bundle, i.e. "Electron" in dev).
// `appUserModelId` does the equivalent for Windows toast attribution.
app.setName(CHANNEL_CONFIG.appName);
// Windows toast attribution: per-channel AUMID so a prod and a staging install
// on the same Windows box don't share a single taskbar group / notification
// source. Dev falls back to the prod id because the spec marks dev's
// electron-builder appId "n/a" (dev never builds), which leaves no value to
// source from the table — same effective behaviour as before this PR.
app.setAppUserModelId(
  CHANNEL_CONFIG.electronBuilderAppId ?? "com.antoinedc.mantaui",
);

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
    // Deep-link cold start: macOS parked the URL in pendingPairUrl (open-url
    // fires pre-ready); Windows/Linux pass it in this process's argv.
    const argvPairUrl = process.argv.find((a) => a.startsWith(PAIR_PREFIX)) ?? null;
    const coldPairUrl = pendingPairUrl ?? argvPairUrl;
    pendingPairUrl = null;
    if (coldPairUrl) {
      mainWindow?.webContents.send(IPC.pairLinkReceived, coldPairUrl);
    }
    startScreenshotDetector();
    // Report desktop focus to the mobile server so it suppresses redundant
    // mobile "done" pushes while the user is active on desktop.
    startDesktopPresence(() => config);
    // Receive desktop OS-notification directives from manta-server's router
    // (over direct HTTPS) and forward them to the renderer.
    startDesktopNotifications(
      () => config,
      (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.desktopNotify, payload);
        }
      },
    );
    // Server-update available (BET-225 stage 3): the box polls its
    // /updates/server.json manifest, publishes a `serverUpdateAvailable`
    // bus event when a newer version appears, and the desktop renderer
    // shows a "Server update available" bar. Same SSE→IPC relay pattern
    // as startDesktopNotifications (one-kind filter on the busConsumer).
    startServerUpdateForwarder(
      () => config,
      (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.serverUpdateAvailable, payload);
        }
      },
    );
    // Capability executor (BET-183 / BET-185 / BET-190): when enabled in
    // Settings, this Mac subscribes to manta-server's bus and runs the YAML
    // plugins it finds under ~/.manta/plugins/. startCapExecutor is a
    // no-op when pluginsEnabled is off.
    startCapExecutor(() => config);
    // Defer update check until after the renderer is ready (avoids blocking startup).
    // electron-updater skips the check in dev mode (unpacked app).
    setTimeout(() => checkForUpdates(), 5000);
    // BET-225 stage 3 (Part B): also re-check for updates every 6 hours
    // so a long-lived install learns about new versions without restarting.
    // Plain setInterval with .unref() — same pattern as the other periodic
    // tasks in this file (screenshotClipboardTimer). No config flag —
    // always on. Dev-mode checkForUpdates() is a no-op so the timer costs
    // ~nothing in development.
    const sixHourTimer = setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000);
    sixHourTimer.unref();
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
  stopServerUpdateForwarder();
  stopCapExecutor();
});

function registerHandlers(): void {
  // Read ONLY by main.tsx's boot sequence (`chooseDesktopTransport`), before
  // httpApi is installed as `window.api` — used to seed httpApi's
  // localStorage credentials from the desktop's local config.json (pairing
  // triple). Called directly on `window.__mantaPreload`, never through
  // `window.api` (which is httpApi post-boot and reaches config over
  // /rpc/config:get instead). See src/preload/index.ts and src/renderer/main.tsx.
  ipcMain.handle(IPC.configGet, () => config);

  // BET-225 stage 3 (Part C): returns the desktop app's own version via
  // Electron's `app.getVersion()` (reads the same package.json the server
  // uses for `server:version`). Renderer combines this with `minClient`
  // from getServerVersion via isClientTooOld to decide whether to render
  // the non-dismissible skew banner. Renderer-only — no equivalent on the
  // box server (it has its own version endpoint already).
  ipcMain.handle(IPC.clientVersion, () => ({ version: app.getVersion() }));

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

  // BET-357 §2: "Remove this box from the device that holds the current
  // box_token". Reads the live { serverUrl, boxToken } from config (so the
  // renderer never holds a stale copy), DELETEs <serverUrl>/auth/revoke, and
  // — REGARDLESS of the remote outcome — clears the local config entry.
  // The unreachable-box path still succeeds locally per the spec; the
  // returned UnpairOutcome lets the renderer's Settings panel surface a
  // structured note when the remote revocation didn't happen.
  ipcMain.handle(IPC.authUnpair, async () => {
    const serverUrl = config.serverUrl ?? "";
    const boxToken = config.boxToken ?? "";
    const outcome = await unpairBox({ serverUrl, boxToken });
    // ALWAYS clear locally: config.ts is the single token writer (BET-355 §4).
    // Empty strings (not delete) so the field shape on disk stays stable
    // across saves — the schema migration in loadConfig doesn't need to
    // chase removed keys.
    commit({
      serverUrl: "",
      boxId: "",
      boxToken: "",
      projects: [],
    });
    return outcome;
  });

  // BET-355 (Stage 4): SSH installer flow. The channels exposed by
  // registerInstallerHandlers are the renderer's ONLY handle on the
  // installer module — main owns the SSH connection from start to
  // pairing-success, and the connection dies at pairing time. The
  // renderer never touches ssh itself (no preload API for it).
  // BET-372: pass main's `commit` so the auto-pair path persists via
  // the SAME writer as the manual claim path above (no circular
  // require, no second config writer).
  registerInstallerHandlers(() => mainWindow, commit);

}
