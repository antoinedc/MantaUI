import type {
  AgentFileReady,
  AppConfig,
  AuthClaimInput,
  AuthPairResult,
  DesktopNotifyPayload,
  OpencodeAgent,
  OpencodeCommand,
  OpencodeEvent,
  OpencodeMessage,
  OpencodeModel,
  OpencodeSessionListItem,
  PermissionRequest,
  QuestionRequest,
  Project,
  ProjectMeta,
  ScheduledJob,
  SecretMeta,
  SecretInput,
  WebhookMeta,
  SpawnOptions,
  PtyEvent,
  AvailableLauncher,
  TmuxConfigStatus,
  VoiceClassifyInput,
  VoiceClassifyResult,
  VoiceTranscribeInput,
  VoiceTranscribeResult,
  WindowStatus,
  WorktreeInfo,
  ProviderEndpoint,
  DiscoverResult,
  ProviderInput,
  SubagentDef,
  SubagentInput,
} from "./types.js";
import type { ClaimOutcome } from "./claim.mjs";

type PromptModel = { providerID: string; modelID: string; variant?: string };
type PromptAttachment = { remotePath: string; mime: string; filename?: string };
type PromptAgentMention = {
  name: string;
  source: { value: string; start: number; end: number };
};

/**
 * The full `window.api` contract.
 *
 * This is the SAME shape the Electron preload used to declare implicitly as
 * `export type Api = typeof api` (`src/preload/index.ts`). It is extracted to
 * a standalone interface here because `httpApi` (`src/renderer/api/httpApi.ts`)
 * is the implementation that actually backs `window.api` at runtime — the
 * preload's own `api` object only ever backed `window.api` in the retired
 * SSH-main path (BET-82: "SSH main path gone"). Only a small OS-bridge +
 * pairing subset of these methods is still implemented by the preload runtime
 * itself (exposed under `window.__buiPreload`, see `src/preload/index.ts` and
 * `src/renderer/preloadAccess.ts`); everything else here is httpApi-only.
 *
 * Do NOT change any method signature here without also updating `httpApi`
 * (which implements this interface completely, typecheck-enforced).
 */
export interface Api {
  configGet(): Promise<AppConfig>;
  configUpdate(patch: Partial<AppConfig>): Promise<AppConfig>;

  projectMetaUpsert(meta: ProjectMeta): Promise<AppConfig>;
  projectMetaDelete(tmuxSession: string): Promise<AppConfig>;

  // tmux operations on the remote
  tmuxList(): Promise<Project[]>;
  tmuxNewSession(input: {
    name: string;
    cwd: string;
    windowName?: string;
    chatMode?: boolean;
    createDir?: boolean;
  }): Promise<Project[]>;
  tmuxNewWindow(input: {
    sessionName: string;
    windowName: string;
    cwd?: string;
    chatMode?: boolean;
  }): Promise<Project[]>;
  tmuxRenameSession(input: { oldName: string; newName: string }): Promise<Project[]>;
  tmuxRenameWindow(input: {
    sessionName: string;
    windowIndex: number;
    newName: string;
  }): Promise<Project[]>;
  tmuxKillSession(sessionName: string): Promise<Project[]>;
  tmuxKillWindow(input: { sessionName: string; windowIndex: number }): Promise<Project[]>;
  tmuxSelectWindow(input: { sessionName: string; windowIndex: number }): Promise<void>;

  gitListWorktrees(cwd: string): Promise<WorktreeInfo[]>;

  fsListDirs(partial: string): Promise<string[]>;

  tmuxConfigStatus(): Promise<TmuxConfigStatus>;
  tmuxSetupConfig(): Promise<TmuxConfigStatus>;
  tmuxRestoreConfig(): Promise<TmuxConfigStatus>;

  // Onboarding pairing (BET-49): exchange a 6-digit code for the box's tokens
  // via POST <serverUrl>/auth/claim. Resolves to a classified ClaimOutcome —
  // a wrong/expired code is a normal { ok:false } result, NOT a rejected
  // promise.
  authClaim(input: AuthClaimInput): Promise<ClaimOutcome>;

  // Mobile pairing code mint (BET-80): GET /auth/pair over the SSH tunnel.
  // Returns { pairingCode, boxId, expiresAt } for the desktop to render as a
  // QR. Resolves to an AuthPairResult — a failure is { ok:false, error }, NOT
  // a rejected promise.
  authPair(): Promise<AuthPairResult>;

  // Voice (Groq STT + lightweight classifier). Main owns the API key;
  // renderer only ships audio bytes / transcripts.
  voiceTranscribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult>;
  voiceClassifyCommand(input: VoiceClassifyInput): Promise<VoiceClassifyResult>;

  clipboardWriteText(text: string): Promise<void>;
  clipboardReadImage(): Promise<ArrayBuffer | null>;

  onScreenshotDetected(
    cb: (ev: { source: "clipboard" | "file"; path?: string }) => void,
  ): () => void;

  // bui-server's notification router decided the desktop should show an OS
  // notification (relayed over the -L 18787 forward). The renderer shows it
  // via the Notification API after a local "am I viewing this?" check.
  onDesktopNotify(cb: (payload: DesktopNotifyPayload) => void): () => void;

  uploadFiles(input: { projectName: string; localPaths: string[] }): Promise<string[]>;
  uploadBuffer(input: {
    projectName: string;
    filename: string;
    buffer: ArrayBuffer;
  }): Promise<string>;
  // Electron 31+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns "" for files that don't have an OS path (e.g. dragged from a
  // webpage).
  getPathForFile(file: File): string;

  peekRemoteFile(remotePath: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  // Agent → laptop file push (outbox). `onAgentFileReady` fires when a file
  // appears in the remote ~/.bui-outbox/. `agentPullFile` pulls it to the
  // downloads dir (used by the require-confirm toast's Save button); returns
  // the saved local path. `revealInFolder` opens Finder at the saved file.
  onAgentFileReady(cb: (ev: AgentFileReady) => void): () => void;
  agentPullFile(remotePath: string): Promise<string>;
  revealInFolder(localPath: string): Promise<void>;

  // Ephemeral shell-in-cwd (or AI CLI TUI) PTYs, one per session-mode
  // composite key (`${sessionId}:${modeId}`). See src/server/pty.mjs.
  ptySpawn(opts: SpawnOptions): Promise<void>;
  ptyWrite(sessionKey: string, data: string): Promise<void>;
  ptyResize(sessionKey: string, cols: number, rows: number): Promise<void>;
  ptyKill(sessionKey: string): Promise<void>;

  onPtyEvent(cb: (e: PtyEvent) => void): () => void;

  // Which AI CLI TUI launchers are available on this box right now (BET-138
  // refinement). Cheap; call on active-session change, no polling needed.
  launchersList(): Promise<AvailableLauncher[]>;

  onStatusEvent(cb: (batch: WindowStatus[]) => void): () => void;

  // opencode chat-mode bridges.
  opencodeMessages(sessionId: string): Promise<OpencodeMessage[]>;
  opencodeMessagesCached(sessionId: string): Promise<OpencodeMessage[] | null>;
  // Tail-merge reconcile (fast) — returns the merged full transcript.
  opencodeMessagesReconcile(sessionId: string): Promise<OpencodeMessage[]>;
  // Single-message fetch — returns null on miss so callers can fall back.
  opencodeMessage(sessionId: string, messageId: string): Promise<OpencodeMessage | null>;
  // Open/close the scoped SSE stream for a session. ChatPanel calls open on
  // mount and close on unmount so the main process only streams open
  // sessions.
  opencodeOpenStream(sessionId: string): Promise<void>;
  opencodeCloseStream(sessionId: string): Promise<void>;
  onOpencodeEvent(cb: (ev: OpencodeEvent) => void): () => void;
  opencodePrompt(
    sessionId: string,
    text: string,
    model?: PromptModel,
    attachments?: PromptAttachment[],
    mentions?: PromptAgentMention[],
  ): Promise<void>;
  opencodeAbort(sessionId: string): Promise<void>;
  // `sessionId` scopes the list to the session's workspace directory —
  // without it the server returns [] for sessions outside the default
  // workspace (see listPermissions in opencode.ts).
  opencodePermissions(sessionId?: string): Promise<PermissionRequest[]>;
  opencodePermissionReply(
    requestId: string,
    reply: "once" | "always" | "reject",
    sessionId?: string,
  ): Promise<void>;

  // Question tool — v2 API only. `sessionId` scopes the list the same way
  // permissions are scoped (see opencodePermissions above).
  opencodeQuestions(sessionId?: string): Promise<QuestionRequest[]>;
  opencodeQuestionReply(
    requestId: string,
    answers: string[][],
    sessionId?: string,
  ): Promise<void>;
  opencodeQuestionReject(requestId: string, sessionId?: string): Promise<void>;

  // Model picker.
  opencodeModels(): Promise<OpencodeModel[]>;
  opencodeDefaultModel(): Promise<{ providerID: string; modelID: string } | null>;
  opencodeGetProviders(): Promise<ProviderEndpoint[]>;
  opencodeSetProviders(ops: {
    upsert?: ProviderInput[];
    remove?: string[];
  }): Promise<{ ok: boolean; error?: string }>;
  opencodeDiscoverModels(baseURL: string, apiKey: string): Promise<DiscoverResult>;
  opencodeGetSubagents(): Promise<SubagentDef[]>;
  opencodeSetSubagents(ops: {
    upsert?: SubagentInput[];
    remove?: string[];
  }): Promise<{ ok: boolean; error?: string }>;
  opencodeRestart(): Promise<void>;
  opencodeVcsBranch(directory?: string): Promise<string | null>;
  opencodeRefreshCredentials(): Promise<{
    ok: boolean;
    reason?: "no-credentials" | "refresh-token-expired" | "failed";
    expiresAt?: number;
  }>;

  // Session management.
  opencodeListSessions(directory?: string): Promise<OpencodeSessionListItem[]>;
  opencodeForkSession(input: {
    sessionId: string;
    sessionName: string;
    windowName: string;
    cwd: string;
    messageID?: string;
  }): Promise<{ newSessionId: string; projects: Project[] }>;
  opencodeCompactSession(sessionId: string): Promise<void>;
  opencodeDeleteSession(input: {
    sessionId: string;
    sessionName: string;
    windowIndex: number;
  }): Promise<Project[]>;

  // Scheduled prompts (bui-server owned; desktop reaches it over -L 18787).
  scheduleList(sessionId?: string): Promise<ScheduledJob[]>;
  scheduleDelete(id: string): Promise<{ deleted: boolean }>;

  // Secrets (bui-server owned; desktop reaches it over -L 18787). list returns
  // METADATA ONLY (never values). set carries the value renderer → box (never
  // through the AI). Agents read secrets via opencode tools, not these
  // channels.
  secretsList(sessionId?: string, all?: boolean): Promise<SecretMeta[]>;
  secretsSet(input: SecretInput): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }>;
  secretsDelete(id: string): Promise<{ deleted: boolean }>;

  // Inbound webhooks (bui-server owned; desktop reaches it over -L 18787).
  // list returns METADATA ONLY (no signing secret). Creation is the AI's job
  // via the global `webhook` opencode tool, not a UI channel.
  webhookList(sessionId?: string): Promise<WebhookMeta[]>;
  webhookDelete(id: string): Promise<{ deleted: boolean }>;

  // Auto-update (desktop-only). Main checks for updates on launch and pushes
  // updateAvailable / updateDownloaded events to the renderer. The renderer
  // calls autoUpdateDownload to trigger a manual download, or
  // autoUpdateInstall to restart and install a downloaded update.
  autoUpdateDownload(): Promise<void>;
  autoUpdateInstall(): Promise<void>;
  onAutoUpdateAvailable(
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): () => void;
  onAutoUpdateDownloaded(
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): () => void;

  // Typeahead sources.
  opencodeCommands(): Promise<OpencodeCommand[]>;
  opencodeAgents(): Promise<OpencodeAgent[]>;
  opencodeFindFiles(input: { query: string; directory: string }): Promise<string[]>;

  // Slash-command execution.
  opencodeRunCommand(input: {
    sessionId: string;
    command: string;
    arguments: string;
    model?: PromptModel;
    attachments?: PromptAttachment[];
  }): Promise<void>;

  // /clear: create new opencode session in same dir, re-stamp tmux window.
  opencodeClearSession(input: {
    sessionName: string;
    windowIndex: number;
    cwd: string;
    title: string;
  }): Promise<{ newSessionId: string; projects: Project[] }>;

  // Auto-rename: generate a short title via a throwaway opencode session.
  // Returns the RAW model reply ("" on timeout/failure); caller sanitizes.
  opencodeGenerateTitle(input: { directory: string; instruction: string }): Promise<string>;
}
