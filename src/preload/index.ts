import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AppConfig,
  type OpencodeAgent,
  type OpencodeCommand,
  type OpencodeEvent,
  type OpencodeMessage,
  type OpencodeModel,
  type OpencodeSessionListItem,
  type PermissionRequest,
  type Project,
  type ProjectMeta,
  type SpawnOptions,
  type PtyEvent,
  type TransportInfo,
  type TmuxConfigStatus,
  type WindowStatus,
  type WorktreeInfo,
} from "../shared/types.js";

type PromptModel = { providerID: string; modelID: string; variant?: string };
type PromptAttachment = { remotePath: string; mime: string; filename?: string };
type PromptAgentMention = {
  name: string;
  source: { value: string; start: number; end: number };
};

const api = {
  configGet: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),
  configUpdate: (patch: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.configUpdate, patch),

  projectMetaUpsert: (meta: ProjectMeta): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.projectMetaUpsert, meta),
  projectMetaDelete: (tmuxSession: string): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.projectMetaDelete, tmuxSession),

  transportInfo: (): Promise<TransportInfo> => ipcRenderer.invoke(IPC.transportInfo),

  // tmux operations on the remote
  tmuxList: (): Promise<Project[]> => ipcRenderer.invoke(IPC.tmuxList),
  tmuxNewSession: (input: { name: string; cwd: string; windowName?: string; chatMode?: boolean }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxNewSession, input),
  tmuxNewWindow: (input: { sessionName: string; windowName: string; cwd?: string; chatMode?: boolean }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxNewWindow, input),
  tmuxRenameSession: (input: { oldName: string; newName: string }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxRenameSession, input),
  tmuxRenameWindow: (input: { sessionName: string; windowIndex: number; newName: string }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxRenameWindow, input),
  tmuxKillSession: (sessionName: string): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxKillSession, sessionName),
  tmuxKillWindow: (input: { sessionName: string; windowIndex: number }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxKillWindow, input),
  tmuxSelectWindow: (input: { sessionName: string; windowIndex: number }): Promise<void> =>
    ipcRenderer.invoke(IPC.tmuxSelectWindow, input),

  gitListWorktrees: (cwd: string): Promise<WorktreeInfo[]> =>
    ipcRenderer.invoke(IPC.gitListWorktrees, cwd),

  fsListDirs: (partial: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.fsListDirs, partial),

  tmuxConfigStatus: (): Promise<TmuxConfigStatus> => ipcRenderer.invoke(IPC.tmuxConfigStatus),
  tmuxSetupConfig: (): Promise<TmuxConfigStatus> => ipcRenderer.invoke(IPC.tmuxSetupConfig),
  tmuxRestoreConfig: (): Promise<TmuxConfigStatus> => ipcRenderer.invoke(IPC.tmuxRestoreConfig),

  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.clipboardWriteText, text),

  uploadFiles: (input: { projectName: string; localPaths: string[] }): Promise<string[]> =>
    ipcRenderer.invoke(IPC.uploadFiles, input),
  // Electron 31+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns "" for files that don't have an OS path (e.g. dragged from a webpage).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  peekRemoteFile: (remotePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.peekRemoteFile, remotePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),

  // Long-lived attached PTYs (1 per active project)
  ptySpawn: (opts: SpawnOptions): Promise<void> => ipcRenderer.invoke(IPC.ptySpawn, opts),
  ptyWrite: (projectName: string, data: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ptyWrite, projectName, data),
  ptyResize: (projectName: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.ptyResize, projectName, cols, rows),
  ptyKill: (projectName: string): Promise<void> => ipcRenderer.invoke(IPC.ptyKill, projectName),

  onPtyEvent: (cb: (e: PtyEvent) => void) => {
    const listener = (_: unknown, e: PtyEvent) => cb(e);
    ipcRenderer.on(IPC.ptyEvent, listener);
    return () => ipcRenderer.removeListener(IPC.ptyEvent, listener);
  },

  onStatusEvent: (cb: (batch: WindowStatus[]) => void): (() => void) => {
    const listener = (_: unknown, batch: WindowStatus[]) => cb(batch);
    ipcRenderer.on(IPC.statusEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.statusEvent, listener);
    };
  },

  // opencode chat-mode bridges.
  opencodeMessages: (sessionId: string): Promise<OpencodeMessage[]> =>
    ipcRenderer.invoke(IPC.opencodeMessages, sessionId),
  onOpencodeEvent: (cb: (ev: OpencodeEvent) => void): (() => void) => {
    const listener = (_: unknown, ev: OpencodeEvent) => cb(ev);
    ipcRenderer.on(IPC.opencodeEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.opencodeEvent, listener);
    };
  },
  opencodePrompt: (
    sessionId: string,
    text: string,
    model?: PromptModel,
    attachments?: PromptAttachment[],
    mentions?: PromptAgentMention[],
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodePrompt, {
      sessionId,
      text,
      model,
      attachments,
      mentions,
    }),
  opencodeAbort: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeAbort, sessionId),
  opencodePermissions: (): Promise<PermissionRequest[]> =>
    ipcRenderer.invoke(IPC.opencodePermissions),
  opencodePermissionReply: (
    requestId: string,
    reply: "once" | "always" | "reject",
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodePermissionReply, { requestId, reply }),

  // Model picker.
  opencodeModels: (): Promise<OpencodeModel[]> =>
    ipcRenderer.invoke(IPC.opencodeModels),
  opencodeDefaultModel: (): Promise<{ providerID: string; modelID: string } | null> =>
    ipcRenderer.invoke(IPC.opencodeDefaultModel),

  // Session management.
  opencodeListSessions: (directory?: string): Promise<OpencodeSessionListItem[]> =>
    ipcRenderer.invoke(IPC.opencodeListSessions, directory),
  opencodeForkSession: (input: {
    sessionId: string;
    sessionName: string;
    windowName: string;
    cwd: string;
    messageID?: string;
  }): Promise<{ newSessionId: string; projects: Project[] }> =>
    ipcRenderer.invoke(IPC.opencodeForkSession, input),
  opencodeCompactSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeCompactSession, sessionId),
  opencodeDeleteSession: (input: {
    sessionId: string;
    sessionName: string;
    windowIndex: number;
  }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.opencodeDeleteSession, input),

  // Typeahead sources.
  opencodeCommands: (): Promise<OpencodeCommand[]> =>
    ipcRenderer.invoke(IPC.opencodeCommands),
  opencodeAgents: (): Promise<OpencodeAgent[]> =>
    ipcRenderer.invoke(IPC.opencodeAgents),
  opencodeFindFiles: (input: { query: string; directory: string }): Promise<string[]> =>
    ipcRenderer.invoke(IPC.opencodeFindFiles, input),

  // Slash-command execution.
  opencodeRunCommand: (input: {
    sessionId: string;
    command: string;
    arguments: string;
    model?: PromptModel;
    attachments?: PromptAttachment[];
  }): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeRunCommand, input),

  // /clear: create new opencode session in same dir, re-stamp tmux window.
  opencodeClearSession: (input: {
    sessionName: string;
    windowIndex: number;
    cwd: string;
    title: string;
  }): Promise<{ newSessionId: string; projects: Project[] }> =>
    ipcRenderer.invoke(IPC.opencodeClearSession, input),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
