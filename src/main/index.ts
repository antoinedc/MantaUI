import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join, basename } from "node:path";
import { watch as fsWatch } from "node:fs";
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
  initSharedConfigSync,
  pushSharedConfig,
  pullSharedConfig,
} from "./sharedConfigSync.js";
import {
  initScheduleClient,
  listSchedules,
  deleteSchedule,
} from "./schedule.js";
import {
  initSecretsClient,
  listSecrets as listSecretsStore,
  setSecret as setSecretStore,
  deleteSecret as deleteSecretStore,
} from "./secrets.js";
import {
  initWebhookClient,
  listWebhooks,
  deleteWebhook,
} from "./webhook.js";
import { checkForUpdates } from "./autoUpdate.js";
// Plain-JS modules shared with the mobile server (src/server/*.mjs). The
// bundler resolves .mjs imports here; main.process never sees them as TS.
// Types live in groq.d.mts. Keep them dep-free so they stay portable across
// both transports.
import { transcribeAudio, classifyVoiceCommand } from "../shared/groq.mjs";
import { patchTouchesSharedConfig } from "../shared/sharedConfig.mjs";
import {
  IPC,
  type AppConfig,
  type AuthClaimInput,
  type ProjectMeta,
} from "../shared/types.js";

// Parse a non-2xx /auth/pair response body into a user-facing error string.
// The server returns { error: "..." } for 403 (not loopback), 429 (rate limit),
// and 5xx (server error). We extract the `error` field if present, otherwise
// fall back to a generic message.
function tryParsePairError(raw: string): string | null {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { projects: [] };

function commit(next: Partial<AppConfig>): AppConfig {
  config = { ...config, ...next };
  saveConfig(config);
  return config;
}

function upsertProjectMeta(meta: ProjectMeta): void {
  const others = config.projects.filter((p) => p.tmuxSession !== meta.tmuxSession);
  commit({ projects: [...others, meta] });
}

function deleteProjectMeta(tmuxSession: string): void {
  commit({ projects: config.projects.filter((p) => p.tmuxSession !== tmuxSession) });
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
    backgroundColor: "#0e0f12",
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
app.setName("Better UI");
app.setAppUserModelId("com.betterui.app");

app.whenReady().then(() => {
  config = loadConfig();
  // Cross-device shared-settings sync: read the live config, and when a newer
  // snapshot is pulled from the mobile server, commit it + tell the renderer.
  initSharedConfigSync({
    getConfig: () => config,
    applyPulled: (snap) => {
      const next = commit(snap as Partial<AppConfig>);
      mainWindow?.webContents.send(IPC.configChanged, next);
    },
  });
  // Scheduled-prompt management client (reaches the box's /api/schedule over
  // HTTPS). Jobs are server-owned; this only lists/deletes.
  initScheduleClient({ getConfig: () => config });
  // Secret store client (reaches the box's /api/secrets over HTTPS). Store is
  // server-owned; this only lists/sets/deletes for the UI.
  initSecretsClient({ getConfig: () => config });
  // Webhook registry client (reaches the box's /api/webhook over HTTPS). Hooks
  // are server-owned; this only lists/deletes for the UI.
  initWebhookClient({ getConfig: () => config });
  registerHandlers();
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
    // Pull any newer shared settings made on mobile while desktop was closed.
    void pullSharedConfig().catch(() => {});
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
});

function registerHandlers(): void {
  ipcMain.handle(IPC.configGet, () => config);

  ipcMain.handle(IPC.configUpdate, async (_e, patch: Partial<AppConfig>) => {
    // If this patch touches a SHAREABLE field, stamp configUpdatedAt so the
    // cross-device sync treats this as the newer snapshot (LWW). Mutating
    // `patch` here means commit() persists the timestamp too. Device-local
    // edits (host/projects/ports/…) do NOT bump the clock.
    const touchesShared = patchTouchesSharedConfig(patch);
    if (touchesShared) {
      (patch as AppConfig).configUpdatedAt = Date.now();
    }
    const next = commit(patch);
    // Push the shareable subset to the mobile server so the other device picks
    // it up (e.g. set the Groq STT key on desktop, get it on mobile). Fire-and-
    // forget over HTTPS; the POST response is the
    // post-merge snapshot, so a racing mobile edit is pulled back in.
    if (touchesShared) void pushSharedConfig().catch(() => {});
    return next;
  });

  ipcMain.handle(IPC.projectMetaUpsert, (_e, meta: ProjectMeta) => {
    upsertProjectMeta(meta);
    return config;
  });

  ipcMain.handle(IPC.projectMetaDelete, (_e, tmuxSession: string) => {
    deleteProjectMeta(tmuxSession);
    return config;
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

  // Reveal a local file in Finder / the OS file manager.
  ipcMain.handle(IPC.revealInFolder, (_e, localPath: string) => {
    if (localPath) shell.showItemInFolder(localPath);
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

  // Mobile pairing code mint (BET-80): GET /auth/pair over HTTPS.
  // Returns { pairingCode, boxId, expiresAt } for the desktop to render as a
  // QR. The /auth/pair endpoint is exempt from the auth gate, so no Bearer
  // token is needed.
  ipcMain.handle(IPC.authPair, async () => {
    const cfg = config;
    if (!cfg.serverUrl) return { ok: false as const, error: "not connected" };
    try {
      const url = `${cfg.serverUrl.replace(/\/+$/, "")}/auth/pair`;
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(4000),
      });
      let raw = "";
      try { raw = await res.text(); } catch { /* bodyless */ }
      if (!res.ok) {
        const msg = tryParsePairError(raw);
        return { ok: false, error: msg || `server ${res.status}` };
      }
      try {
        const body = JSON.parse(raw) as {
          pairing_code?: string;
          box_id?: string;
          expiresAt?: string;
        };
        if (
          typeof body.pairing_code === "string" &&
          typeof body.box_id === "string" &&
          typeof body.expiresAt === "string"
        ) {
          return {
            ok: true,
            pairingCode: body.pairing_code,
            boxId: body.box_id,
            expiresAt: body.expiresAt,
          };
        }
        return { ok: false, error: "unexpected response shape" };
      } catch {
        return { ok: false, error: "bad JSON from server" };
      }
    } catch {
      return { ok: false, error: "server unreachable" };
    }
  });

  // Voice / speech-to-text via Groq. Audio bytes are captured by the
  // renderer (MediaRecorder) and shipped here so the API key never lives
  // in the renderer process. See src/shared/groq.mjs for the HTTP layer
  // and src/shared/voiceClassifier.mjs for the rules classifier.
  ipcMain.handle(
    IPC.voiceTranscribe,
    async (_e, input: { buffer: ArrayBuffer; mime: string }) => {
      const apiKey = config.groqApiKey;
      const model = config.voiceTranscriptionModel;
      return transcribeAudio({
        buffer: input.buffer,
        mime: input.mime,
        apiKey: apiKey ?? "",
        model,
      });
    },
  );

  ipcMain.handle(
    IPC.voiceClassifyCommand,
    async (_e, input: { transcript: string; useLlmFallback?: boolean }) => {
      const apiKey = config.groqApiKey;
      const model = config.voiceCommandModel;
      return classifyVoiceCommand({
        transcript: input.transcript,
        apiKey: apiKey ?? "",
        model,
        useLlmFallback: input.useLlmFallback,
      });
    },
  );

  // Scheduled prompts (bui-server owned; reached over HTTPS).
  ipcMain.handle(IPC.scheduleList, (_e, sessionId?: string) =>
    listSchedules(sessionId),
  );
  ipcMain.handle(IPC.scheduleDelete, (_e, id: string) => deleteSchedule(id));

  // Secrets (bui-server owned; reached over HTTPS). list yields
  // metadata only; set carries the value Mac → box (never through the AI).
  ipcMain.handle(IPC.secretsList, (_e, sessionId?: string, all?: boolean) =>
    listSecretsStore(sessionId, all),
  );
  ipcMain.handle(IPC.secretsSet, (_e, input) => setSecretStore(input));
  ipcMain.handle(IPC.secretsDelete, (_e, id: string) => deleteSecretStore(id));

  // Inbound webhooks (bui-server owned; reached over HTTPS).
  // list yields metadata only (no signing secret); creation is the AI's job.
  ipcMain.handle(IPC.webhookList, (_e, sessionId?: string) => listWebhooks(sessionId));
  ipcMain.handle(IPC.webhookDelete, (_e, id: string) => deleteWebhook(id));
}
