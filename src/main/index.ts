import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import {
  killAll,
  killPty,
  listPathCompletions,
  listWorktrees,
  remoteDirExists,
  resizePty,
  spawnPty,
  tmuxConfigStatus,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxList,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxRenameSession,
  tmuxRenameWindow,
  tmuxRestoreConfig,
  tmuxSelectWindow,
  tmuxSetupConfig,
  uploadFiles,
  cleanupUploads,
  peekRemoteFile,
  writePty,
} from "./pty.js";
import { info as transportInfo, invalidate as invalidateTransport } from "./transport.js";
import { startStatusPoller, stopStatusPoller } from "./status.js";
import {
  IPC,
  type AppConfig,
  type Project,
  type ProjectMeta,
  type SpawnOptions,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { host: "", projects: [] };

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

function startPollerIfReady(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!config.host) {
    stopStatusPoller();
    return;
  }
  startStatusPoller(mainWindow, () => config);
}

// Periodic upload cleanup. Runs once on (re)start and every hour afterward;
// each run deletes batches older than the configured threshold. Worst-case
// staleness ≈ uploadCleanupHours + 1h.
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function scheduleUploadCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (!config.host) return;
  const hours = config.uploadCleanupHours ?? 1;
  if (hours <= 0) return;
  void cleanupUploads(config, hours);
  cleanupTimer = setInterval(
    () => void cleanupUploads(config, config.uploadCleanupHours ?? 1),
    60 * 60 * 1000,
  );
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

app.whenReady().then(() => {
  config = loadConfig();
  registerHandlers();
  createWindow();
  // Defer poller start until renderer is ready to receive events.
  mainWindow?.webContents.once("did-finish-load", () => {
    startPollerIfReady();
    scheduleUploadCleanup();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopStatusPoller();
  if (cleanupTimer) clearInterval(cleanupTimer);
  killAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopStatusPoller();
  if (cleanupTimer) clearInterval(cleanupTimer);
  killAll();
});

// Compose tmux state + local metadata into the Project view used by the UI.
async function listProjects(): Promise<Project[]> {
  const tmuxSessions = await tmuxList(config);
  const metaByName = new Map(config.projects.map((p) => [p.tmuxSession, p]));

  return tmuxSessions.map((s) => {
    const meta = metaByName.get(s.name);
    const defaultCwd = meta?.defaultCwd || s.windows[0]?.paneCurrentPath || "~";
    return {
      tmuxSession: s.name,
      defaultCwd,
      attached: s.attached,
      windows: s.windows,
    };
  });
}

function registerHandlers(): void {
  ipcMain.handle(IPC.configGet, () => config);

  ipcMain.handle(IPC.configUpdate, (_e, patch: Partial<AppConfig>) => {
    // Host or identity change → re-detect transport next time.
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      invalidateTransport();
    }
    const next = commit(patch);
    // Host config may have just appeared (first-run Settings save) or changed.
    // Restart the poller so it picks up the new target.
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      startPollerIfReady();
    }
    if (
      "host" in patch ||
      "user" in patch ||
      "identityFile" in patch ||
      "uploadCleanupHours" in patch
    ) {
      scheduleUploadCleanup();
    }
    return next;
  });

  ipcMain.handle(IPC.transportInfo, () => transportInfo(config));

  ipcMain.handle(IPC.projectMetaUpsert, (_e, meta: ProjectMeta) => {
    upsertProjectMeta(meta);
    return config;
  });

  ipcMain.handle(IPC.projectMetaDelete, (_e, tmuxSession: string) => {
    deleteProjectMeta(tmuxSession);
    return config;
  });

  ipcMain.handle(IPC.tmuxList, () => listProjects());

  ipcMain.handle(
    IPC.tmuxNewSession,
    async (_e, input: { name: string; cwd: string; windowName?: string }) => {
      if (!input.name.trim()) throw new Error("Project name is required");
      const cwd = input.cwd.trim() || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewSession(config, input.name.trim(), cwd, input.windowName);
      // Persist defaultCwd locally so future sessions in this project get the same.
      upsertProjectMeta({ tmuxSession: input.name.trim(), defaultCwd: cwd });
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxNewWindow,
    async (
      _e,
      input: { sessionName: string; windowName: string; cwd?: string },
    ) => {
      const project = config.projects.find((p) => p.tmuxSession === input.sessionName);
      const cwd = input.cwd?.trim() || project?.defaultCwd || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewWindow(config, input.sessionName, input.windowName.trim() || "session", cwd);
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxRenameSession,
    async (_e, input: { oldName: string; newName: string }) => {
      const newName = input.newName.trim();
      if (!newName) throw new Error("Name is required");
      if (newName === input.oldName) return listProjects();
      await tmuxRenameSession(config, input.oldName, newName);
      // Move local metadata to the new key.
      const meta = config.projects.find((p) => p.tmuxSession === input.oldName);
      if (meta) {
        deleteProjectMeta(input.oldName);
        upsertProjectMeta({ ...meta, tmuxSession: newName });
      }
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxRenameWindow,
    async (
      _e,
      input: { sessionName: string; windowIndex: number; newName: string },
    ) => {
      const newName = input.newName.trim();
      if (!newName) throw new Error("Name is required");
      await tmuxRenameWindow(config, input.sessionName, input.windowIndex, newName);
      return listProjects();
    },
  );

  ipcMain.handle(IPC.tmuxKillSession, async (_e, sessionName: string) => {
    killPty(sessionName);
    await tmuxKillSession(config, sessionName).catch(() => {});
    deleteProjectMeta(sessionName);
    return listProjects();
  });

  ipcMain.handle(
    IPC.tmuxKillWindow,
    async (_e, input: { sessionName: string; windowIndex: number }) => {
      await tmuxKillWindow(config, input.sessionName, input.windowIndex);
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxSelectWindow,
    async (_e, input: { sessionName: string; windowIndex: number }) => {
      await tmuxSelectWindow(config, input.sessionName, input.windowIndex);
    },
  );

  // Clipboard write via Electron main — bypasses renderer permission restrictions
  // that silently block navigator.clipboard.writeText for non-user-gesture writes.
  ipcMain.handle(IPC.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle(
    IPC.uploadFiles,
    (_e, input: { projectName: string; localPaths: string[] }) =>
      uploadFiles(config, input.projectName, input.localPaths),
  );

  ipcMain.handle(IPC.peekRemoteFile, (_e, remotePath: string) =>
    peekRemoteFile(config, remotePath),
  );

  ipcMain.handle(IPC.openExternal, (_e, url: string) => shell.openExternal(url));

  ipcMain.handle(IPC.gitListWorktrees, (_e, cwd: string) =>
    listWorktrees(config, cwd),
  );

  ipcMain.handle(IPC.fsListDirs, (_e, partial: string) =>
    listPathCompletions(config, partial),
  );

  // Remote tmux config management
  ipcMain.handle(IPC.tmuxConfigStatus, () => tmuxConfigStatus(config));
  ipcMain.handle(IPC.tmuxSetupConfig, async () => {
    await tmuxSetupConfig(config);
    return tmuxConfigStatus(config);
  });
  ipcMain.handle(IPC.tmuxRestoreConfig, async () => {
    await tmuxRestoreConfig(config);
    return tmuxConfigStatus(config);
  });

  ipcMain.handle(IPC.ptySpawn, async (_e, opts: SpawnOptions) => {
    if (!mainWindow) return;
    await spawnPty(mainWindow, config, opts);
  });

  ipcMain.handle(IPC.ptyWrite, (_e, projectName: string, data: string) => {
    writePty(projectName, data);
  });

  ipcMain.handle(IPC.ptyResize, (_e, projectName: string, cols: number, rows: number) => {
    resizePty(projectName, cols, rows);
  });

  ipcMain.handle(IPC.ptyKill, (_e, projectName: string) => {
    killPty(projectName);
  });
}
