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
  tmuxRestampSessionId,
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
  listMessages as opencodeListMessages,
  subscribeEvents as opencodeSubscribeEvents,
  sendPrompt as opencodeSendPrompt,
  abortSession as opencodeAbortSession,
  listPermissions as opencodeListPermissions,
  replyPermission as opencodeReplyPermission,
  invalidateForward as invalidateOpencodeForward,
  teardownForward as teardownOpencodeForward,
  listModels as opencodeListModels,
  getDefaultModel as opencodeGetDefaultModel,
  listSessions as opencodeListSessions,
  forkSession as opencodeForkSession,
  compactSession as opencodeCompactSession,
  deleteSession as opencodeDeleteSession,
  listCommands as opencodeListCommands,
  listAgents as opencodeListAgents,
  findFiles as opencodeFindFiles,
  runCommand as opencodeRunCommand,
  createSession as opencodeCreateSession,
  type PromptModel,
  type PromptAttachment,
  type PromptAgentMention,
} from "./opencode.js";
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

// Long-lived opencode SSE bus, owned by main. Forwards every event from the
// remote opencode server to the renderer; renderer filters by sessionID per
// component (ChatPanel). Reconnects with backoff on stream end / errors.
// Only relevant for chat-mode windows but cheap to keep up even when none
// exist (opencode just emits no events).
let opencodeBusStopped = true;
let opencodeBusDispose: (() => void) | null = null;

function startOpencodeBus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!config.host) {
    stopOpencodeBus();
    return;
  }
  opencodeBusStopped = false;
  void opencodeBusLoop();
}

function stopOpencodeBus(): void {
  opencodeBusStopped = true;
  if (opencodeBusDispose) {
    try { opencodeBusDispose(); } catch { /* ignore */ }
    opencodeBusDispose = null;
  }
}

async function opencodeBusLoop(): Promise<void> {
  let backoffMs = 500;
  while (!opencodeBusStopped) {
    if (!config.host) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      const stream = await opencodeSubscribeEvents(config);
      opencodeBusDispose = stream.dispose;
      backoffMs = 500;
      for await (const ev of stream.iter) {
        if (opencodeBusStopped) break;

        // Trust mode: auto-reply "always" to every permission.asked. The card
        // never reaches the renderer, so tools execute without prompting —
        // closest analog to Claude Code's --dangerously-skip-permissions.
        if (ev.type === "permission.asked" && config.chatAutoAllow) {
          const perm = ev.properties as { id?: string } | undefined;
          if (perm?.id) {
            void opencodeReplyPermission(config, perm.id, "always").catch(
              (e) => console.warn("[opencode-bus] auto-allow failed:", (e as Error).message),
            );
          }
          // Suppress forwarding — the renderer doesn't need to render the
          // card. The subsequent permission.replied event still flows through.
          continue;
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.opencodeEvent, ev);
        }
      }
    } catch (e) {
      // Server might not be up yet — fine, retry. We don't proactively
      // start opencode serve here; that happens on first chat-mode window
      // creation (in pty.ts → maybeCreateChatSession → ensureRunning).
      console.warn("[opencode-bus] SSE loop:", (e as Error).message);
    } finally {
      opencodeBusDispose = null;
    }
    if (opencodeBusStopped) break;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 8000);
  }
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
    startOpencodeBus();
    scheduleUploadCleanup();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopStatusPoller();
  stopOpencodeBus();
  if (cleanupTimer) clearInterval(cleanupTimer);
  killAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopStatusPoller();
  stopOpencodeBus();
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (config.host) void teardownOpencodeForward(config).catch(() => {});
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
    // Host or identity change → re-detect transport, drop the cached "forward
    // is up" flag, restart pollers/bus against the new target.
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      invalidateTransport();
      invalidateOpencodeForward();
    }
    const next = commit(patch);
    if ("host" in patch || "user" in patch || "identityFile" in patch) {
      startPollerIfReady();
      stopOpencodeBus();
      startOpencodeBus();
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
    async (_e, input: { name: string; cwd: string; windowName?: string; chatMode?: boolean }) => {
      if (!input.name.trim()) throw new Error("Project name is required");
      const cwd = input.cwd.trim() || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewSession(config, input.name.trim(), cwd, input.windowName, input.chatMode === true);
      // Persist defaultCwd locally so future sessions in this project get the same.
      upsertProjectMeta({ tmuxSession: input.name.trim(), defaultCwd: cwd });
      return listProjects();
    },
  );

  ipcMain.handle(
    IPC.tmuxNewWindow,
    async (
      _e,
      input: { sessionName: string; windowName: string; cwd?: string; chatMode?: boolean },
    ) => {
      const project = config.projects.find((p) => p.tmuxSession === input.sessionName);
      const cwd = input.cwd?.trim() || project?.defaultCwd || "~";
      if (!(await remoteDirExists(config, cwd))) {
        throw new Error(
          `Directory does not exist on ${config.host}: ${cwd}\n\nCheck the path — tmux silently falls back to $HOME otherwise.`,
        );
      }
      await tmuxNewWindow(
        config,
        input.sessionName,
        input.windowName.trim() || "session",
        cwd,
        input.chatMode === true,
      );
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

  // Phase 1 chat-mode: one-shot fetch of a session's transcript. Live updates
  // arrive separately via the opencodeEvent stream forwarded by startOpencodeBus.
  ipcMain.handle(IPC.opencodeMessages, (_e, sessionId: string) =>
    opencodeListMessages(config, sessionId),
  );

  // Phase 2: send user message + abort generation. Optional `model` overrides
  // the server default for this prompt only (opencode has no session-level
  // model setting). `attachments` and `mentions` are inlined as FileParts /
  // AgentParts in the prompt body.
  ipcMain.handle(
    IPC.opencodePrompt,
    (
      _e,
      input: {
        sessionId: string;
        text: string;
        model?: PromptModel;
        attachments?: PromptAttachment[];
        mentions?: PromptAgentMention[];
      },
    ) =>
      opencodeSendPrompt(
        config,
        input.sessionId,
        input.text,
        input.model,
        input.attachments,
        input.mentions,
      ),
  );
  ipcMain.handle(IPC.opencodeAbort, (_e, sessionId: string) =>
    opencodeAbortSession(config, sessionId),
  );

  // Permission approval. Returns the full list; renderer filters by sessionID.
  ipcMain.handle(IPC.opencodePermissions, () =>
    opencodeListPermissions(config),
  );
  ipcMain.handle(
    IPC.opencodePermissionReply,
    (_e, input: { requestId: string; reply: "once" | "always" | "reject" }) =>
      opencodeReplyPermission(config, input.requestId, input.reply),
  );

  // Model picker. Strip-and-forward — opencode embeds apiKey in the wire
  // response; opencode.listModels redacts before this leaves main.
  ipcMain.handle(IPC.opencodeModels, () => opencodeListModels(config));
  ipcMain.handle(IPC.opencodeDefaultModel, () => opencodeGetDefaultModel(config));

  // Session management: list/fork/compact/delete. Fork additionally creates a
  // bui tmux window pointing at the new session so the user sees it appear.
  ipcMain.handle(IPC.opencodeListSessions, (_e, directory?: string) =>
    opencodeListSessions(config, directory),
  );
  ipcMain.handle(
    IPC.opencodeForkSession,
    async (
      _e,
      input: {
        sessionId: string;
        sessionName: string;     // tmux session (bui project)
        windowName: string;      // tmux window label for the new fork
        cwd: string;
        messageID?: string;
      },
    ) => {
      const forked = await opencodeForkSession(config, input.sessionId, input.messageID);
      await tmuxNewWindow(
        config,
        input.sessionName,
        input.windowName,
        input.cwd,
        true,                    // chatMode
        forked.id,
      );
      return { newSessionId: forked.id, projects: await listProjects() };
    },
  );
  ipcMain.handle(IPC.opencodeCompactSession, (_e, sessionId: string) =>
    opencodeCompactSession(config, sessionId),
  );
  // Delete: also tear down the matching tmux window (caller passes both since
  // the renderer knows which window owns the session).
  ipcMain.handle(
    IPC.opencodeDeleteSession,
    async (
      _e,
      input: { sessionId: string; sessionName: string; windowIndex: number },
    ) => {
      await opencodeDeleteSession(config, input.sessionId);
      await tmuxKillWindow(config, input.sessionName, input.windowIndex).catch(() => {});
      return listProjects();
    },
  );

  // Typeahead sources for @ and / mentions.
  ipcMain.handle(IPC.opencodeCommands, () => opencodeListCommands(config));
  ipcMain.handle(IPC.opencodeAgents, () => opencodeListAgents(config));
  ipcMain.handle(
    IPC.opencodeFindFiles,
    (_e, input: { query: string; directory: string }) =>
      opencodeFindFiles(config, input.query, input.directory),
  );

  // Slash-command execution. Body shape mirrors prompt_async with `command`
  // and `arguments` instead of a free-form text part.
  ipcMain.handle(
    IPC.opencodeRunCommand,
    (
      _e,
      input: {
        sessionId: string;
        command: string;
        arguments: string;
        model?: PromptModel;
        attachments?: PromptAttachment[];
      },
    ) =>
      opencodeRunCommand(
        config,
        input.sessionId,
        input.command,
        input.arguments,
        input.attachments,
        input.model,
      ),
  );

  // /clear flow: create a new opencode session in the same directory, then
  // re-stamp the tmux window's @bui-session-id to the new id. Returns the
  // new session id + refreshed project list so the renderer can swap.
  ipcMain.handle(
    IPC.opencodeClearSession,
    async (
      _e,
      input: {
        sessionName: string;
        windowIndex: number;
        cwd: string;
        title: string;
      },
    ) => {
      const sess = await opencodeCreateSession(
        config,
        input.cwd,
        input.title,
      );
      await tmuxRestampSessionId(
        config,
        input.sessionName,
        input.windowIndex,
        sess.id,
      );
      return { newSessionId: sess.id, projects: await listProjects() };
    },
  );

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
