import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AppConfig,
  type Project,
  type ProjectMeta,
  type SpawnOptions,
  type PtyEvent,
  type TransportInfo,
  type TmuxConfigStatus,
  type WindowStatus,
} from "../shared/types.js";

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
  tmuxNewSession: (input: { name: string; cwd: string; windowName?: string }): Promise<Project[]> =>
    ipcRenderer.invoke(IPC.tmuxNewSession, input),
  tmuxNewWindow: (input: { sessionName: string; windowName: string; cwd?: string }): Promise<Project[]> =>
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
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
