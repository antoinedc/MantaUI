import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AgentFileReady,
  type AppConfig,
  type AuthClaimInput,
  type AuthPairResult,
  type DesktopNotifyPayload,
  type OpencodeAgent,
  type OpencodeCommand,
  type OpencodeEvent,
  type OpencodeMessage,
  type OpencodeModel,
  type OpencodeSessionListItem,
  type PermissionRequest,
  type QuestionRequest,
  type Project,
  type ProjectMeta,
  type ScheduledJob,
  type SecretMeta,
  type SecretInput,
  type WebhookMeta,
  type SpawnOptions,
  type PtyEvent,
  type TmuxConfigStatus,
  type VoiceClassifyInput,
  type VoiceClassifyResult,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
  type WindowStatus,
  type WorktreeInfo,
  type ProviderEndpoint,
  type DiscoverResult,
  type ProviderInput,
} from "../shared/types.js";
import type { ClaimOutcome } from "../shared/claim.mjs";

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

  // tmux operations on the remote
  tmuxList: (): Promise<Project[]> => ipcRenderer.invoke(IPC.tmuxList),
  tmuxNewSession: (input: { name: string; cwd: string; windowName?: string; chatMode?: boolean; createDir?: boolean }): Promise<Project[]> =>
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

  // Onboarding pairing (BET-49): exchange a 6-digit code for the box's tokens
  // via POST <serverUrl>/auth/claim. On success main persists
  // { serverUrl, boxId, boxToken } to config (flipping transport to "http").
  // Resolves to a classified ClaimOutcome — a wrong/expired code is a normal
  // { ok:false } result, NOT a rejected promise.
  authClaim: (input: AuthClaimInput): Promise<ClaimOutcome> =>
    ipcRenderer.invoke(IPC.authClaim, input),

  // Mobile pairing code mint (BET-80): GET /auth/pair over the SSH tunnel.
  // Returns { pairingCode, boxId, expiresAt } for the desktop to render as a
  // QR. Resolves to an AuthPairResult — a failure is { ok:false, error }, NOT
  // a rejected promise.
  authPair: (): Promise<AuthPairResult> =>
    ipcRenderer.invoke(IPC.authPair),

  // Voice (Groq STT + lightweight classifier). Main owns the API key;
  // renderer only ships audio bytes / transcripts.
  // See src/shared/voiceClassifier.mjs and src/shared/groq.mjs.
  voiceTranscribe: (input: VoiceTranscribeInput): Promise<VoiceTranscribeResult> =>
    ipcRenderer.invoke(IPC.voiceTranscribe, input),
  voiceClassifyCommand: (input: VoiceClassifyInput): Promise<VoiceClassifyResult> =>
    ipcRenderer.invoke(IPC.voiceClassifyCommand, input),

  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.clipboardWriteText, text),
  clipboardReadImage: (): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke(IPC.clipboardReadImage),

  onScreenshotDetected: (
    cb: (ev: { source: "clipboard" | "file"; path?: string }) => void,
  ): (() => void) => {
    const listener = (_: unknown, ev: { source: "clipboard" | "file"; path?: string }) => cb(ev);
    ipcRenderer.on(IPC.screenshotDetected, listener);
    return () => ipcRenderer.removeListener(IPC.screenshotDetected, listener);
  },

  // Cross-device shared-config sync pulled a newer snapshot from mobile into
  // desktop config; the store re-applies it so Settings reflects the change.
  onConfigChanged: (cb: (cfg: AppConfig) => void): (() => void) => {
    const listener = (_: unknown, cfg: AppConfig) => cb(cfg);
    ipcRenderer.on(IPC.configChanged, listener);
    return () => ipcRenderer.removeListener(IPC.configChanged, listener);
  },

  // bui-server's notification router decided the desktop should show an OS
  // notification (relayed over the -L 18787 forward). The renderer shows it
  // via the Notification API after a local "am I viewing this?" check.
  onDesktopNotify: (cb: (payload: DesktopNotifyPayload) => void): (() => void) => {
    const listener = (_: unknown, payload: DesktopNotifyPayload) => cb(payload);
    ipcRenderer.on(IPC.desktopNotify, listener);
    return () => ipcRenderer.removeListener(IPC.desktopNotify, listener);
  },

  uploadFiles: (input: { projectName: string; localPaths: string[] }): Promise<string[]> =>
    ipcRenderer.invoke(IPC.uploadFiles, input),
  uploadBuffer: (input: { projectName: string; filename: string; buffer: ArrayBuffer }): Promise<string> =>
    ipcRenderer.invoke(IPC.uploadBuffer, input),
  // Electron 31+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns "" for files that don't have an OS path (e.g. dragged from a webpage).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  peekRemoteFile: (remotePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.peekRemoteFile, remotePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),

  // Agent → laptop file push (outbox). `onAgentFileReady` fires when a file
  // appears in the remote ~/.bui-outbox/. `agentPullFile` pulls it to the
  // downloads dir (used by the require-confirm toast's Save button); returns
  // the saved local path. `revealInFolder` opens Finder at the saved file.
  onAgentFileReady: (cb: (ev: AgentFileReady) => void): (() => void) => {
    const listener = (_: unknown, ev: AgentFileReady) => cb(ev);
    ipcRenderer.on(IPC.agentFileReady, listener);
    return () => ipcRenderer.removeListener(IPC.agentFileReady, listener);
  },
  agentPullFile: (remotePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.agentPullFile, remotePath),
  revealInFolder: (localPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.revealInFolder, localPath),

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
  opencodeMessagesCached: (
    sessionId: string,
  ): Promise<OpencodeMessage[] | null> =>
    ipcRenderer.invoke(IPC.opencodeMessagesCached, sessionId),
  // Tail-merge reconcile (fast) — returns the merged full transcript.
  opencodeMessagesReconcile: (
    sessionId: string,
  ): Promise<OpencodeMessage[]> =>
    ipcRenderer.invoke(IPC.opencodeMessagesReconcile, sessionId),
  // Single-message fetch — returns null on miss so callers can fall back.
  opencodeMessage: (
    sessionId: string,
    messageId: string,
  ): Promise<OpencodeMessage | null> =>
    ipcRenderer.invoke(IPC.opencodeMessage, sessionId, messageId),
  // Open/close the scoped SSE stream for a session. ChatPanel calls open on
  // mount and close on unmount so the main process only streams open sessions.
  opencodeOpenStream: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeOpenStream, sessionId),
  opencodeCloseStream: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeCloseStream, sessionId),
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
  // `sessionId` scopes the list to the session's workspace directory —
  // without it the server returns [] for sessions outside the default
  // workspace (see listPermissions in opencode.ts).
  opencodePermissions: (sessionId?: string): Promise<PermissionRequest[]> =>
    ipcRenderer.invoke(IPC.opencodePermissions, sessionId),
  opencodePermissionReply: (
    requestId: string,
    reply: "once" | "always" | "reject",
    sessionId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodePermissionReply, {
      requestId,
      reply,
      sessionId,
    }),

  // Question tool — v2 API only. `sessionId` scopes the list the same way
  // permissions are scoped (see opencodePermissions above).
  opencodeQuestions: (sessionId?: string): Promise<QuestionRequest[]> =>
    ipcRenderer.invoke(IPC.opencodeQuestions, sessionId),
  opencodeQuestionReply: (
    requestId: string,
    answers: string[][],
    sessionId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeQuestionReply, {
      requestId,
      answers,
      sessionId,
    }),
  opencodeQuestionReject: (
    requestId: string,
    sessionId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.opencodeQuestionReject, { requestId, sessionId }),

  // Model picker.
  opencodeModels: (): Promise<OpencodeModel[]> =>
    ipcRenderer.invoke(IPC.opencodeModels),
  opencodeDefaultModel: (): Promise<{ providerID: string; modelID: string } | null> =>
    ipcRenderer.invoke(IPC.opencodeDefaultModel),
  opencodeGetProviders: (): Promise<ProviderEndpoint[]> =>
    ipcRenderer.invoke(IPC.opencodeGetProviders),
  opencodeSetProviders: (
    ops: { upsert?: ProviderInput[]; remove?: string[] },
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.opencodeSetProviders, ops),
  opencodeDiscoverModels: (baseURL: string, apiKey: string): Promise<DiscoverResult> =>
    ipcRenderer.invoke(IPC.opencodeDiscoverModels, baseURL, apiKey),
  opencodeRestart: (): Promise<void> => ipcRenderer.invoke(IPC.opencodeRestart),
  opencodeVcsBranch: (directory?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.opencodeVcsBranch, directory),

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

  // Scheduled prompts (bui-server owned; desktop reaches it over -L 18787).
  scheduleList: (sessionId?: string): Promise<ScheduledJob[]> =>
    ipcRenderer.invoke(IPC.scheduleList, sessionId),
  scheduleDelete: (id: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC.scheduleDelete, id),

  // Secrets (bui-server owned; desktop reaches it over -L 18787). list returns
  // METADATA ONLY (never values). set carries the value renderer → box (never
  // through the AI). Agents read secrets via opencode tools, not these channels.
  secretsList: (sessionId?: string, all?: boolean): Promise<SecretMeta[]> =>
    ipcRenderer.invoke(IPC.secretsList, sessionId, all),
  secretsSet: (input: SecretInput): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }> =>
    ipcRenderer.invoke(IPC.secretsSet, input),
  secretsDelete: (id: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC.secretsDelete, id),

  // Inbound webhooks (bui-server owned; desktop reaches it over -L 18787). list
  // returns METADATA ONLY (no signing secret). Creation is the AI's job via the
  // global `webhook` opencode tool, not a UI channel.
  webhookList: (sessionId?: string): Promise<WebhookMeta[]> =>
    ipcRenderer.invoke(IPC.webhookList, sessionId),
  webhookDelete: (id: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC.webhookDelete, id),

  // Auto-update (desktop-only). Main checks for updates on launch and pushes
  // updateAvailable / updateDownloaded events to the renderer. The renderer
  // calls autoUpdateDownload to trigger a manual download, or autoUpdateInstall
  // to restart and install a downloaded update.
  autoUpdateDownload: (): Promise<void> =>
    ipcRenderer.invoke(IPC.autoUpdateDownload),
  autoUpdateInstall: (): Promise<void> =>
    ipcRenderer.invoke(IPC.autoUpdateInstall),
  onAutoUpdateAvailable: (
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): (() => void) => {
    const listener = (_: unknown, info: { version: string; releaseName?: string; releaseNotes?: string }) => cb(info);
    ipcRenderer.on(IPC.autoUpdateAvailable, listener);
    return () => ipcRenderer.removeListener(IPC.autoUpdateAvailable, listener);
  },
  onAutoUpdateDownloaded: (
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): (() => void) => {
    const listener = (_: unknown, info: { version: string; releaseName?: string; releaseNotes?: string }) => cb(info);
    ipcRenderer.on(IPC.autoUpdateDownloaded, listener);
    return () => ipcRenderer.removeListener(IPC.autoUpdateDownloaded, listener);
  },

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

  // Auto-rename: generate a short title via a throwaway opencode session.
  // Returns the RAW model reply ("" on timeout/failure); caller sanitizes.
  opencodeGenerateTitle: (input: {
    directory: string;
    instruction: string;
  }): Promise<string> =>
    ipcRenderer.invoke(IPC.opencodeGenerateTitle, input),
};

// Expose the real preload bridge under a STABLE, dedicated name — NOT "api".
// contextBridge.exposeInMainWorld makes the property read-only + non-
// configurable, so whatever name it's given can never be reassigned. The
// renderer entry (main.tsx) needs to install `window.api` itself and, in
// http/paired mode, SWAP it for the httpApi client — a swap that throws
// "Cannot assign to read only property 'api'" if `api` is the contextBridge
// property. So we bridge under `__buiPreload` (immutable, always the genuine
// Electron preload) and let main.tsx define a writable `window.api` from it.
contextBridge.exposeInMainWorld("__buiPreload", api);

export type Api = typeof api;
