import type {
  AgentFileReady,
  AppConfig,
  AuthClaimInput,
  AuthPairResult,
  DelegateJob,
  DelegateApproval,
  DelegateApprovalTool,
  DesktopNotifyPayload,
  OpencodeAgent,
  OpencodeCommand,
  OpencodeEvent,
  OpencodeMessage,
  OpencodeReference,
  OpencodeReferenceUpsert,
  StreamEnvelope,
  OpencodeModel,
  OpencodeProviderAuthRequest,
  OpencodeProviderAuthResult,
  OpencodeSessionListItem,
  PermissionRequest,
  QuestionRequest,
  Project,
  TmuxCreateResult,
  ScheduledJob,
  UsageSnapshot,
  StoppedListResult,
  ModelPrefsState,
  ModelPrefsSetInput,
  ModelPrefsSeedInput,
  ProgressRecord,
  SecretMeta,
  SecretInput,
  ServerUpdateAvailablePayload,
  ServerUpdateCheck,
  DesktopUpdateCheck,
  ServedPageMeta,
  OutboxFile,
  WebhookMeta,
  SpawnOptions,
  PtyEvent,
  AvailableLauncher,
  TmuxConfigStatus,
  VoiceTranscribeInput,
  VoiceTranscribeResult,
  VoiceNoteRecord,
  VoiceUploadNoteInput,
  VoiceUploadNoteResult,
  VoiceRetryResult,
  WindowStatus,
  DirListing,
  WorktreeInfo,
  ForgeProbeResult,
  ForgeStatusResult,
  ForgePullRequestResult,
  ForgeRefTarget,
  ForgeDiffResult,
  ForgeDisconnectResult,
  ForgeRuleRow,
  ForgeInboxResult,
  DelegateStartInput,
  DelegateStartResult,
  ForgeShipInput,
  ForgeShipResult,
  ForgeShipPreviewInput,
  ForgeShipPreviewResult,
  ForgeMergeInput,
  ForgeMergeResult,
  ForgeDraftGetResult,
  ForgeDraftCommentInput,
  ForgeDraftCommentResult,
  ForgeDraftSubmitInput,
  ForgeDraftSubmitResult,
  ForgeThreadReplyInput,
  ForgeThreadReplyResult,
  ForgeDeviceStartResult,
  ForgeDevicePollResult,
  ForgeRepoListResult,
  ForgeCloneStatus,
  ProviderEndpoint,
  DiscoverResult,
  ProviderInput,
  SubagentDef,
  SubagentInput,
  PluginRegistryRow,
  TranscriptHit,
  LedgerSummary,
  AppControlPayload,
  MediaEventPayload,
} from "./types.js";
import type { ClaimOutcome } from "./claim.mjs";

type PromptModel = { providerID: string; modelID: string; variant?: string };
// BET-1225: the server-side main-conversation routing decision, returned by
// opencodeModelRoute. `model` is the router's chosen model to apply to the
// next prompt; `reason` is why (shown on the routed pill); `incumbent` is the
// model it replaced (what undo reverts to); `changed` is whether a substitution
// actually happened (false on routing-off / failure / no-op).
type ModelRouteDecision = {
  model: PromptModel | null;
  reason: string;
  incumbent: PromptModel | null;
  changed: boolean;
};
// BET-1244: the generic, read-only routing decision (`routing:choose`) — the
// sibling of ModelRouteDecision that carries no `incumbent` but adds
// `alternatives` (the next-best candidates a surface can offer). `model` stays
// null on routing-off / no-survivors / failure; `changed` is false whenever no
// substitution is offered. Never throws: on an internal failure the server
// returns the incumbent unchanged with reason "routing unavailable".
type RoutingChooseDecision = {
  model: PromptModel | null;
  reason: string;
  alternatives: PromptModel[];
  changed: boolean;
};
// BET-1249: a provider-agnostic catalogue entry as served by
// `opencode:model-catalog` (models.dev view). Consumed by the renderer's
// "Models we couldn't identify" block for identity + typeahead.
export type ModelCatalogEntry = {
  id?: string;
  name?: string;
  family?: string;
  description?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
};
type PromptAttachment = { remotePath: string; mime: string; filename?: string };
type PromptAgentMention = {
  name: string;
  source: { value: string; start: number; end: number };
};

// BET-675/678: the sync cursor/delta payload a client exchanges with the box.
// `syncSnapshot({sinceSeq, sinceGen})` returns this; `sync` bus envelopes on
// the events stream carry the same shape. `changed` holds only the fields
// newer than the client's cursor (or a full snapshot when the cursor is
// absent / a different server generation).
export type SyncPayload = {
  gen: string;
  seq: number;
  changed: {
    projects?: Project[];
    config?: AppConfig;
    stale?: boolean;
  };
};

// The synthetic resync marker httpApi fires on every events-stream reconnect
// (mirror of fireResync's `server.connected` for opencode). `{ resync: true }`
// tells the app layer to re-pull its snapshot from its cursor.
export type SyncDelta =
  | SyncPayload
  | { resync: true };

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
 * itself (exposed under `window.__mantaPreload`, see `src/preload/index.ts` and
 * `src/renderer/preloadAccess.ts`); everything else here is httpApi-only.
 *
 * Do NOT change any method signature here without also updating `httpApi`
 * (which implements this interface completely, typecheck-enforced).
 */
export interface Api {
  configGet(): Promise<AppConfig>;
  configUpdate(patch: Partial<AppConfig>): Promise<AppConfig>;

  // BET-678: cursor snapshot/delta — the single bootstrap + resync RPC.
  // Pass the client's last-seen { sinceSeq, sinceGen }; the box returns only
  // the fields newer than the cursor (or a full snapshot when the cursor is
  // absent / stale generation). Same 15s fail-fast timeout as configGet.
  syncSnapshot(args: { sinceSeq?: number; sinceGen?: string }): Promise<SyncPayload>;
  // Live `sync` bus envelopes {@link SyncPayload} as state changes on the box,
  // plus a synthetic `{ resync: true }` marker on events-stream reconnect so
  // the app layer re-pulls from its cursor.
  onSyncDelta(cb: (delta: SyncDelta) => void): () => void;

  projectMetaDelete(tmuxSession: string): Promise<AppConfig>;

  // tmux operations on the remote
  // The create RPCs return the newly-created window's identity (sessionId +
  // windowIndex) alongside the refreshed projects list, so callers can
  // navigate + send the first prompt to the RIGHT session instead of
  // re-locating it by name (which mixed new sessions up with existing ones
  // on name collisions).
  tmuxNewSession(input: {
    name: string;
    cwd: string;
    windowName?: string;
    chatMode?: boolean;
    createDir?: boolean;
    // When set, reuse this opencode session id (already created optimistically
    // by the draft flow) instead of creating a new one, and stamp it on the
    // new tmux window.
    existingSessionId?: string;
    // BET-871: when the session is started from an inbox ISSUE, the box stamps
    // the originating issue on the `@manta-forge-issue` window option so
    // shipping a PR from it carries a "Closes #N" line. Omitted for PR-kind
    // items and any other session start — no stamp.
    forgeIssue?: { repoKey: string; number: number };
  }): Promise<TmuxCreateResult>;
  tmuxNewWindow(input: {
    sessionName: string;
    windowName: string;
    cwd?: string;
    chatMode?: boolean;
    // BET-246: when set, the new tmux window also stamps the worktree path
    // on `@manta-worktree-path` so clean-on-close knows it owns this
    // worktree. Optional — omitted for non-worktree windows.
    worktreePath?: string;
    // As above: reuse an optimistically-created opencode session id and stamp
    // it on the new window.
    existingSessionId?: string;
  }): Promise<TmuxCreateResult>;
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
  // BET-246: create a sibling git worktree next to `cwd`'s repo root, named
  // after `name` (slugified). Returns the new { path, branch }. Errors
  // propagate so the renderer can fail-closed (no silent fallback to the
  // shared dir).
  gitAddWorktree(input: { cwd: string; name: string }): Promise<{ path: string; branch: string }>;
  // BET-246: remove a worktree MantaUI created. `force:false` returns
  // { removed:false, reason:"dirty" } on a dirty checkout so the renderer
  // can confirm before the retry. Any other failure throws.
  gitRemoveWorktree(input: { path: string; force: boolean }): Promise<{ removed: boolean; reason?: "dirty" | "other" }>;

  fsListDirs(partial: string): Promise<DirListing>;

  // BET-1091: create an empty, git-initialised scratch project directory
  // under `root`, returning the real absolute path. The renderer (stage 4)
  // feeds `path` into the existing session-creation call.
  projectCreateScratch(input: { root: string; name: string }): Promise<{ path: string; name: string }>;

  // BET-786: probe the box for git repos + read origins + detect the gh CLI.
  // Server-side only; the box caches the result in memory for 60s.
  forgeProbe(): Promise<ForgeProbeResult>;

  // BET-788: forge read path (box-side only — a token never leaves the box).
  // forgeStatus reports connected/login; forgePullRequest takes a session cwd
  // and the server resolves cwd → origin → repo.
  forgeStatus(opts?: { validate?: boolean }): Promise<ForgeStatusResult>;
  forgePullRequest(input: { cwd: string }): Promise<ForgePullRequestResult>;
  forgeDiff(input: ForgeRefTarget): Promise<ForgeDiffResult>;
  // BET-795: the work inbox. Box-side only — three cross-repo SEARCH queries,
  // never per-repo iteration, cached a full 60s on the search bucket.
  forgeInbox(): Promise<ForgeInboxResult>;

  // BET-794: forge write path (box-side only — a token never leaves the box).
  // forgeShip pushes the current branch then opens a PR — this is called ONLY
  // after the renderer's human confirm card (never auto-submitted). forgeMerge
  // merges the PR with the head SHA the user approved, surfacing the
  // distinguished failure kind.
  forgeShip(input: ForgeShipInput): Promise<ForgeShipResult>;
  forgeShipPreview(input: ForgeShipPreviewInput): Promise<ForgeShipPreviewResult>;
  forgeMerge(input: ForgeMergeInput): Promise<ForgeMergeResult>;

  // BET-798: the box-side rules registry + disconnect (Settings [G1]). A forge
  // token never reaches the renderer — the rules list is source + validity
  // only; disconnect clears the box-side credential cache.
  forgeRulesList(): Promise<ForgeRuleRow[]>;
  forgeDisconnect(): Promise<ForgeDisconnectResult>;

  // BET-793: box-buffered draft review (box-side only — a forge token never
  // reaches the renderer; the box owns the draft, spec §3.4①). draftGet reads
  // the current draft; draftComment mutates a comment (add/edit/delete) or sets
  // the verdict; draftSubmit flushes the whole draft as ONE review, clearing it
  // only on success.
  forgeDraftGet(input: ForgeRefTarget): Promise<ForgeDraftGetResult>;
  forgeDraftComment(input: ForgeDraftCommentInput): Promise<ForgeDraftCommentResult>;
  forgeDraftSubmit(input: ForgeDraftSubmitInput): Promise<ForgeDraftSubmitResult>;
  forgeThreadReply(input: ForgeThreadReplyInput): Promise<ForgeThreadReplyResult>;

  // BET-796: fresh-box clone flow (box-side only — a forge token never leaves
  // the box). deviceStart mints the GitHub device grant (RENDERER-SAFE: no
  // device_code); devicePoll drives the countdown ([S5]); deviceCancel backs
  // out to [S4]. repos lists the clone picker's push-to repos ([S6]);
  // cloneStart starts a clone and returns an id to cloneStatus (determinate
  // progress, [S7]) / cloneCancel.
  forgeDeviceStart(): Promise<ForgeDeviceStartResult>;
  forgeDevicePoll(input: { grantId: string }): Promise<ForgeDevicePollResult>;
  forgeDeviceCancel(input: { grantId: string }): Promise<{ ok: boolean }>;
  forgeRepos(): Promise<ForgeRepoListResult>;
  forgeCloneStart(input: { url: string; dest: string; name: string }): Promise<{ id?: string; error?: string; message?: string }>;
  forgeCloneStatus(input: { id: string }): Promise<ForgeCloneStatus | null>;
  forgeCloneCancel(input: { id: string }): Promise<{ cancelled: boolean }>;

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

  // Voice (Groq STT). Main owns the API key; renderer only ships audio bytes.
  voiceTranscribe(input: VoiceTranscribeInput): Promise<VoiceTranscribeResult>;

  // Voice notes (BET-830/BET-837). One POST stores the clip AND transcribes it
  // (409 = stored but transcription failed, retry against the returned id).
  // Audio is fetched to a Blob (never a `?token=` URL — box token must not
  // leak into a URL), metadata lists over /rpc.
  voiceUploadNote(input: VoiceUploadNoteInput): Promise<VoiceUploadNoteResult>;
  voiceListNotes(sessionId: string): Promise<VoiceNoteRecord[]>;
  voiceRetryNote(id: string): Promise<VoiceRetryResult>;
  voiceFetchNote(id: string): Promise<Blob>;

  clipboardWriteText(text: string): Promise<void>;
  clipboardReadImage(): Promise<ArrayBuffer | null>;

  onScreenshotDetected(
    cb: (ev: { source: "clipboard" | "file" | "unavailable"; path?: string; reason?: string }) => void,
  ): () => void;

  // manta-server's notification router decided the desktop should show an OS
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
  // appears in the remote ~/.manta-outbox/. `agentPullFile` pulls it to the
  // downloads dir (used by the require-confirm toast's Save button); returns
  // the saved local path. `revealInFolder` opens Finder at the saved file.
  onAgentFileReady(cb: (ev: AgentFileReady) => void): () => void;
  agentPullFile(remotePath: string): Promise<string>;
  revealInFolder(localPath: string): Promise<void>;

  // BET-1156: the ONE desktop download-to-downloads path. Main fetches
  // `/api/download?path=<remotePath>` with the box token and writes the bytes
  // to `downloadsDir` (default `~/Downloads`), deduping a name collision.
  // Returns the saved local absolute path on success, "" on failure. On desktop
  // every download (outbox toast Save, inline-media preview + hover overlay,
  // artifacts panel) funnels through this; `agentPullFile` delegates to it on
  // desktop and keeps the browser blob fallback for mobile/web (no preload).
  downloadFileToDownloads(remotePath: string, filename: string): Promise<string>;

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
  // opts.limit — return only the most recent N messages (opencode returns the
  //   chronological TAIL). Omit (or pass {}) for the whole history. The
  //   desktop passes {limit: 100} for the tail-first mount and {} for
  //   "Load earlier". Duplicate tool stdout is stripped server-side always.
  opencodeMessages(sessionId: string, opts?: { limit?: number }): Promise<OpencodeMessage[]>;
  // Single-message fetch — returns null on miss so callers can fall back.
  opencodeMessage(sessionId: string, messageId: string): Promise<OpencodeMessage | null>;
  // Open/close the scoped SSE stream for a session. ChatPanel calls open on
  // mount and close on unmount so the main process only streams open
  // sessions.
  opencodeOpenStream(sessionId: string): Promise<void>;
  opencodeCloseStream(sessionId: string): Promise<void>;
  onOpencodeEvent(cb: (ev: OpencodeEvent) => void): () => void;
  // Box-side interpreted stream events (BET-551 / §17). The box publishes
  // derived `stream.*` events on the same /events bus; this subscription
  // receives each `StreamEnvelope` for the transport-routed `stream` kind.
  onStreamEvent(cb: (ev: StreamEnvelope) => void): () => void;
  opencodePrompt(
    sessionId: string,
    text: string,
    model?: PromptModel,
    attachments?: PromptAttachment[],
    mentions?: PromptAgentMention[],
    agent?: string,
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
  // BET-1225: fetch the server's main-conversation routing decision for the
  // session at start, so the renderer can apply the routed model and render
  // the undoable routed pill. `incumbent` is the model the session would use
  // without routing (the user's per-session pick or the persisted default).
  // Returns null on the demo/no-op transport (routing is never exercised).
  opencodeModelRoute(
    incumbent: PromptModel | null,
    agent?: string,
  ): Promise<ModelRouteDecision | null>;
  // BET-1244: the read-only, side-effect-free routing decision for either
  // surface ("main" | "sub"), resolved by the SAME decision core the subagent
  // path uses. No state is written and no prompt is sent. Never throws — on
  // any internal failure it returns the incumbent unchanged with reason
  // "routing unavailable", alternatives empty, changed false.
  routingChoose(input: {
    sessionId: string;
    directory: string;
    agent: string;
    surface: "main" | "sub";
    contextTokens: number;
    needs?: { tools?: boolean; image?: boolean; pdf?: boolean };
    incumbent: PromptModel | null;
  }): Promise<RoutingChooseDecision>;
  // BET-1244: the Accounts "Try again" action — clears the out-of-credit
  // evidence-only flag for a provider, delegated to server-side provider
  // health (supported providers re-read their meter; custom providers clear
  // optimistically with no traffic). `message` is a factual row string and is
  // NEVER empty — the button reports both outcomes.
  accountsRetry(providerID: string): Promise<{
    ok: boolean;
    state: string;
    message: string;
  }>;
  // BET-1250: the Accounts list's per-provider health snapshot, keyed by
  // opencode providerID. `retryInMs` is present only while the provider is
  // rate-limited (its cooldown remaining). Never throws; {} when health isn't
  // wired on the box (routing inert).
  accountHealth(): Promise<
    Record<string, { state: string; retryInMs?: number | null }>
  >;
  // BET-1249: the provider-agnostic model catalogue for the "Models we
  // couldn't identify" block — resolve opaque endpoint ids and typeahead over
  // every known model. `supported:false` when the box has no catalogue yet
  // (never thrown). Entries are the same shape modelIdentity consumes.
  opencodeModelCatalog(): Promise<{
    supported: boolean;
    size: number;
    entries: ModelCatalogEntry[];
  }>;
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
  // BET-949: the session's active agent (e.g. "plan"), or null when absent /
  // unknown. Seeds the plan-mode toggle before the honesty sync's first event.
  opencodeSessionAgent(sessionId: string): Promise<string | null>;
  // BET-123: reconcile configured agent blocks against the model list +
  // deactivated set; returns the resulting SubagentDef[].
  opencodeSyncSubagents(input: {
    models: OpencodeModel[];
    deactivated: string[];
    // BET-1139: "providerID/modelID" deprecated-model opt-ins — a deprecated
    // model is only auto-registered as a subagent when present here.
    optIn?: string[];
  }): Promise<SubagentDef[]>;
  opencodeRestart(): Promise<void>;
  opencodeVcsBranch(directory?: string): Promise<string | null>;

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
  // BET-421: bare session lifecycle for the ephemeral onboarding verifier.
  // create makes a fresh opencode session in `directory` (no tmux window,
  // no project); deleteRaw drops it by id alone. Together they let the
  // verifier probe the box and leave nothing behind.
  opencodeCreateEphemeralSession(input: {
    directory: string;
    title?: string;
  }): Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  opencodeDeleteSessionRaw(sessionId: string): Promise<{ ok: boolean }>;

  // Scheduled prompts (manta-server owned; desktop reaches it over -L 18787).
  scheduleList(sessionId?: string): Promise<ScheduledJob[]>;
  scheduleDelete(id: string): Promise<{ deleted: boolean }>;
  // BET-739: create a one-shot job from the renderer (the usage "remind me /
  // keep going at reset" actions). Same store/poller as the AI `schedule` tool.
  // The renderer hands over the ABSOLUTE instant (`fireAt`, epoch ms) and the
  // box renders the cron itself — so the schedule fires in the user's real
  // time, in the box's timezone, with no timezone crossing the wire.
  scheduleCreate(input: {
    fireAt: number;
    prompt: string;
    recurring?: boolean;
    label?: string;
    sessionID: string;
    directory?: string;
    kind?: "prompt" | "notify";
  }): Promise<{ ok: boolean; job?: ScheduledJob; error?: string }>;

  // Subscription plan usage (manta-server owned; BET-737). Read-only —
  // snapshots are produced by the box's usage poller (src/server/usage.mjs),
  // never written through this channel. NOT the context-window indicator.
  usageList(): Promise<UsageSnapshot[]>;
  // Usage-limit stopped conversations (BET-1047). list reads the durable
  // box-side record; arm/disarm mark a conversation for (or against) resume;
  // stampLastLooked records when the modal was last closed so "new" badges
  // clear. All mutate the SAME record the indicator + markers read, so they
  // refresh immediately without caching in renderer state.
  usageStoppedList(): Promise<StoppedListResult>;
  usageStoppedArm(conversation: string): Promise<void>;
  usageStoppedDisarm(conversation: string): Promise<void>;
  usageStoppedStampLastLooked(): Promise<void>;

  // Session progress (manta-server owned, BET-790). Reads the durable
  // "where are we right now" record for a session, written by the AI's
  // `progress_report` opencode tool. The renderer's job card also gets the
  // child's progress on the delegate job object.
  progressGet(sessionId?: string): Promise<ProgressRecord | null>;
  // BET-791: the box publishes a `progress.updated` hint ({sessionID}) on the
  // /events bus whenever a session's record is written or cleared. Subscribers
  // refetch progressGet() — the payload carries no record. No-op on the
  // preload bridge and on demoApi (Proxy fallback returns a no-op
  // unsubscribe).
  onProgressUpdated(cb: (payload: { sessionID?: string }) => void): () => void;
  // BET-738: the box publishes a `usage.updated` bus event whenever the
  // poller's serialized snapshot set actually changes. Unlike
  // onDelegateUpdated's hint-only payload, this one carries the FULL current
  // UsageSnapshot[] — subscribers apply it straight to the store, no
  // refetch. No-op on the preload bridge and on demoApi (Proxy fallback
  // returns a no-op unsubscribe).
  onUsageUpdated(cb: (payload: { snapshots: UsageSnapshot[] }) => void): () => void;
  // BET-1047: the box publishes `usage-stopped.updated` ({conversation}) on
  // the /events bus whenever the stopped record changes (enrol / arm / disarm
  // / ran / last-looked). Subscribers refetch usageStoppedList() — the payload
  // is a hint, not the record. No-op on the preload bridge and on demoApi.
  onUsageStoppedUpdated(cb: (payload: { conversation?: string }) => void): () => void;

  // Per-session model prefs (BET-1279). Durable box-side record of the
  // per-conversation model selection + recent choices. get reads the whole
  // { sessions, recents }; set upserts/deletes a session's selection and/or
  // replaces recents; seed is the one-shot non-destructive migration. All
  // mutate the SAME store the composer reads, so every device agrees.
  modelPrefsGet(): Promise<ModelPrefsState>;
  modelPrefsSet(input: ModelPrefsSetInput): Promise<void>;
  modelPrefsSeed(input: ModelPrefsSeedInput): Promise<void>;
  // BET-1279: the box publishes `model-prefs.updated` ({sessionId}) on the
  // /events bus whenever the store changes. The payload is a hint only —
  // subscribers refetch modelPrefsGet(). No-op on the preload bridge and on
  // demoApi (Proxy fallback returns a no-op unsubscribe).
  onModelPrefsUpdated(cb: (payload: { sessionId?: string }) => void): () => void;

  // App-control (BET-840/841). The box publishes ONE `appControl` bus kind
  // with an `action` discriminator (switch-model / rename-session /
  // compact-session); the desktop subscribes here once and switches on
  // `action`. No-op on the preload bridge and on demoApi (Proxy fallback
  // returns a no-op unsubscribe).
  onAppControl(cb: (payload: AppControlPayload) => void): () => void;

  // Inline media (BET-1148). The box publishes ONE `media` bus kind with an
  // `action` discriminator (begin / show / fail); the desktop subscribes once
  // and switches on `action`. No-op on the preload bridge and on demoApi
  // (Proxy fallback returns a no-op unsubscribe).
  onMedia(cb: (payload: MediaEventPayload) => void): () => void;

  // Secrets (manta-server owned; desktop reaches it over -L 18787). list returns
  // METADATA ONLY (never values). set carries the value renderer → box (never
  // through the AI). Agents read secrets via opencode tools, not these
  // channels.
  secretsList(sessionId?: string, all?: boolean): Promise<SecretMeta[]>;
  secretsSet(input: SecretInput): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }>;
  secretsDelete(id: string): Promise<{ deleted: boolean }>;

  // Inbound webhooks (manta-server owned; desktop reaches it over -L 18787).
  // list returns METADATA ONLY (no signing secret). Creation is the AI's job
  // via the global `webhook` opencode tool, not a UI channel.
  webhookList(sessionId?: string): Promise<WebhookMeta[]>;
  webhookDelete(id: string): Promise<{ deleted: boolean }>;

  // Published serve-page registry (manta-server owned; same box, read-only).
  // Returns the box's published pages (subdomain, public url, expiry, created,
  // originating session) so the artifacts panel can render them. Pages are
  // published/stopped by the AI's `serve_page`/`stop_page` opencode tools, not
  // through any UI channel.
  servePageList(): Promise<ServedPageMeta[]>;

  // Returns the box's outbox (~/.manta-outbox) entries — files the AI dropped
  // for the user to retrieve — so the artifacts panel's Files tab can show
  // agent-pushed files alongside user uploads, scoped to `sessionId` (the
  // workspace). Read-only; entries carry an `expiresAt` TTL and are only
  // removed by the box's expiry sweep, never by a download.
  outboxList(sessionId?: string): Promise<OutboxFile[]>;

  // Background delegation jobs (manta-server owned). list returns the full
  // job records (filtered by parent session when sessionId is passed; all
  // jobs when omitted — the app-level sidebar poll uses the no-arg form).
  // stop aborts the child session and marks the job `stopped`. delete removes
  // the tmux window + worktree (force:false) and drops the record; a dirty
  // worktree is refused with {ok:false, reason:"dirty"} and the record kept.
  // No create channel — jobs are started by the AI's `delegate` opencode tool.
  delegateList(sessionId?: string): Promise<DelegateJob[]>;
  delegateStart(input: DelegateStartInput): Promise<DelegateStartResult>;
  delegateStop(id: string): Promise<{ ok: boolean; error?: string; reason?: string }>;
  delegateDelete(id: string): Promise<{ ok: boolean; error?: string; reason?: string }>;
  // BET-418 §A pre-flight approval: the renderer polls pending approvals for
  // the viewed parent session and shows ONE approval card before the job is
  // created. approve carries optional edited tools; decline cancels.
  delegatePendingApprovals(sessionId?: string): Promise<DelegateApproval[]>;
  delegateApprove(id: string, tools?: DelegateApprovalTool[]): Promise<{ ok: boolean }>;
  delegateDecline(id: string): Promise<{ ok: boolean }>;
  // BET-414: the box publishes a `delegate.updated` bus event whenever a job's
  // status/activity changes (created, running, finished, stopped, deleted). The
  // sidebar subscribes so a new job nests under its parent within ~1s instead
  // of waiting for the 30s jobs poll. The payload mirrors the bus event
  // ({ id, status, activity? }); subscribers typically just refetch
  // delegateList() — the payload is a hint, not the full record. No-op on the
  // preload bridge (used only pre-pairing, when no jobs exist) and on demoApi
  // (Proxy fallback returns a no-op unsubscribe).
  onDelegateUpdated(
    cb: (payload: { id: string; status: string; activity?: string }) => void,
  ): () => void;

  // APNs native-push registration (BET-181). The native iOS app calls this on
  // startup (after permission grant) with the device APNs token. The server
  // upserts it into the apns-tokens registry (de-dupes on token value).
  // Returns { ok, count }.
  pushRegisterApns(token: string): Promise<{ ok: boolean; count: number }>;

  // Auto-update (desktop-only). Main checks for updates on launch and pushes
  // updateAvailable / updateDownloaded events to the renderer. The renderer
  // calls autoUpdateDownload to trigger a manual download, or
  // autoUpdateInstall to restart and install a downloaded update.
  autoUpdateDownload(): Promise<void>;
  autoUpdateInstall(): Promise<void>;
  // Check on demand and RESOLVE with the verdict — the "Check for updates"
  // button in Settings → About. Distinct from the event subscriptions below
  // because a button needs to be able to say "up to date": the events can only
  // report the positive case. Never rejects; a failed check resolves with
  // `error` set so the caller renders a reason instead of a dead spinner.
  // `supported:false` on mobile/web and in an unpacked dev build.
  autoUpdateCheck(): Promise<DesktopUpdateCheck>;
  // Download progress (0-100) for a manual download. Desktop-only; the httpApi
  // shim returns a no-op unsubscribe on mobile.
  onAutoUpdateProgress(cb: (p: { percent: number }) => void): () => void;
  onAutoUpdateAvailable(
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): () => void;
  onAutoUpdateDownloaded(
    cb: (info: { version: string; releaseName?: string; releaseNotes?: string }) => void,
  ): () => void;
  // Fires only for TERMINAL update failures (integrity / permission). Transient
  // network errors are filtered out in main — see src/shared/updateError.mjs.
  // `message` is user-facing copy; `raw` is the underlying updater message.
  onAutoUpdateError(cb: (info: { message: string; raw: string }) => void): () => void;

  // BET-365 / BET-357 §1 — user-initiated reconnect. The events WebSocket
  // auto-reconnects on its own exponential backoff; this method is the manual
  // "Retry now" trigger wired into the ReconnectingBanner. Calling it resets
  // the backoff attempt counter and the total-window deadline, then opens the
  // socket immediately. Safe to call from any state (connected → no-op,
  // reconnecting → jump the queue, closed → re-arm from scratch).
  connectionRetryNow(): void;

  // Typeahead sources.
  opencodeCommands(): Promise<OpencodeCommand[]>;
  opencodeAgents(): Promise<OpencodeAgent[]>;
  opencodeFindFiles(input: { query: string; directory: string }): Promise<string[]>;
  // BET-1023: configured opencode references (GET /api/reference) + the
  // single-writer upsert for them. `remove` is rejected server-side (opencode's
  // PATCH /global/config has no delete semantics) — removal is deferred.
  opencodeReferences(): Promise<OpencodeReference[]>;
  opencodeSetReferences(ops: {
    upsert?: OpencodeReferenceUpsert[];
    remove?: string[];
  }): Promise<{ ok: boolean; error?: string }>;
  // BET-698: server-side conversation search. `sessionIds` is the search scope
  // in priority order (sessionIds[0] = the active conversation). Hit caps stay
  // server-side defaults. `supported:false` = the box can't search (needs the
  // Node 24 runtime / opencode.db).
  opencodeSearchMessages(input: {
    query: string;
    sessionIds: string[];
  }): Promise<{ supported: boolean; hits: TranscriptHit[] }>;
  // BET-1219: read-only spend/latency ledger over opencode's store.
  // `sinceMs` filters assistant rows to time_created >= sinceMs (default 0 =
  // all). Measurement only — no routing. `supported:false` = the box can't
  // read opencode.db (needs the Node 24 runtime).
  ledgerSummary(opts?: { sinceMs?: number }): Promise<LedgerSummary | { supported: false }>;

  // Slash-command execution.
  opencodeRunCommand(input: {
    sessionId: string;
    command: string;
    arguments: string;
    model?: PromptModel;
    agent?: string;
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

  // Subscription provider auth (BET-308 / BET-309): a single discriminated
  // channel that drives the connect/disconnect UI for Claude, Codex, and
  // Kimi. Action discriminated union; see OpencodeProviderAuthRequest in
  // src/shared/types.ts. The `key` action carries an API-key secret
  // renderer → box; the server writes it to opencode's auth store and
  // never echoes it back, not in the return value and not in any log line.
  opencodeProviderAuth(req: OpencodeProviderAuthRequest): Promise<OpencodeProviderAuthResult>;

  // BET-354: cancel an in-flight Claude login session. Drops the
  // server-side metadata; the renderer is responsible for the matching
  // ptyKill(sessionKey). Both calls together release the full session so
  // a fresh start can register under the SAME name.
  claudeLoginCancel(sessionKey: string): Promise<{ ok: boolean }>;
  // BET-421 §E: is the `claude` CLI installed on the box? The connect card
  // runs the lazy installer before sign-in when it isn't.
  opencodeClaudeCliStatus(): Promise<{ installed: boolean; path: string }>;

  // Server version (BET-180): returns the manta-server's package.json version,
  // served in-process via the `server:version` RPC channel (no HTTP round
  // trip). Used by MobileSettings to render "Server vX.Y.Z" under the URL
  // field. Display-only — gating / banner logic lands later.
  //
  // Response also carries `minClient` (BET-225 stage 2 server side): the
  // oldest desktop/mobile client version the current server RPC contract
  // still supports, exported as `MIN_CLIENT` from src/server/version.mjs.
  // The renderer's version-skew guard (BET-225 stage 3 Part C) reads both
  // fields off this single response to decide whether to render the
  // non-dismissible "outdated" banner — no parallel endpoint, no second
  // poll. The interface keeps `version` as the primary field for the
  // BET-180 callers (MobileSettings); new consumers should destructure
  // both.
  //
  // BET-428: response also carries `opencodeVersion` — the box's
  // `opencode --version` output, read once at server startup (opencode's
  // HTTP API exposes no version endpoint, so a shell-out is the only
  // source). Settings → About renders it alongside the desktop + server
  // versions in this single round-trip — no new IPC channel. Falls back to
  // "0.0.0" when opencode isn't installed.
  getServerVersion(): Promise<{ version: string; minClient: string; opencodeVersion: string }>;

  // Client version (BET-225 stage 3): returns the desktop app's own version
  // via Electron's `app.getVersion()`. Combined with the server's
  // `minClient` (also from getServerVersion → the response carries both
  // `version` and `minClient` after BET-225 stage 2) by isClientTooOld() to
  // decide whether to render the non-dismissible skew banner. On mobile/web
  // (no Electron preload) httpApi returns a baked-in fallback so the call
  // never rejects — a missing client version means no skew check, never a
  // crash.
  getClientVersion(): Promise<{ version: string }>;

  // Server-update apply (BET-225 stage 3): triggers the box's
  // `scripts/self-update.sh` (git fetch + reset --hard origin/main, or the
  // packaged-install tarball path, + npm ci --omit=dev + systemctl --user
  // restart manta-server). The server returns immediately (fire-and-forget);
  // the restart will kill the process mid-run so a caller awaiting past the
  // RPC send may never see a response. BET-640: the RPC now watches the
  // spawned updater for its early failures and resolves `{ ok:false, error }`
  // when the updater exits non-zero before reaching the restart, `{ ok:true }`
  // otherwise (still-running at the watch window = it reached the restart).
  // Mirror of the desktop `opencode:restart` action — fixed-argv execFile,
  // no injection surface, no caller-supplied input.
  serverUpdateApply(): Promise<{ ok: boolean; error?: string }>;

  // Server-update check on demand: runs the box's update poller's own tick
  // right now and resolves with its verdict. Behind Settings → About's "Check
  // for updates" button, and called once when the desktop connects so a box
  // release is noticed on app open instead of up to a poll interval later.
  // Reuses the poller's tick, so a manual check that finds an update also
  // raises the normal banner (deduped per version) and the two can never
  // report different things.
  serverUpdateCheck(): Promise<ServerUpdateCheck>;

  // Single-CLI update (BET-1162, server half; consumed by BET-1159): upgrade
  // exactly ONE installed box CLI (opencode / claude / codex / kimi) by catalog
  // id. Reuses the cached CLI detector and the shared runUpgrade spawn — no new
  // detection or upgrade mechanism. Resolves with `{ok, before?, after?,
  // changed?, error?}` and never rejects. This is the per-row action the
  // renderer's per-row split (BET-1159) calls.
  serverCliUpdate(
    cliId: string,
  ): Promise<{
    ok: boolean;
    before?: string | null;
    after?: string | null;
    changed?: boolean;
    error?: string;
  }>;

  // Server-update available subscription (BET-225 stage 3): fires when the
  // box's server-update poller sees a newer manifest version. Mirrors the
  // desktopNotify pattern — main subscribes to manta-server's /events SSE,
  // filters on kind === "serverUpdateAvailable", and forwards via IPC. The
  // renderer's UpdateBar component renders a "Server update available:
  // {version}" bar with an "Update & restart" button that calls
  // serverUpdateApply(). Desktop-only wiring (mobile has no IPC); the httpApi
  // shim returns a no-op unsubscribe on mobile.
  onServerUpdateAvailable(
    cb: (payload: ServerUpdateAvailablePayload) => void,
  ): () => void;

  // Server-update progress subscription. While `scripts/self-update.sh` runs
  // on the box, the server tails its log and republishes each `MANTA_PROGRESS
  // <step>/<total> <label>` marker as a `serverUpdateProgress` bus event. The
  // renderer's UpdateBar renders a determinate progress bar from these so the
  // user sees the update advancing instead of a frozen button.
  onServerUpdateProgress(
    cb: (p: { step: number; total: number; label: string }) => void,
  ): () => void;

  // Plugins (BET-189 / BET-190): read the current plugin registry the Mac
  // executor has published. Backed by GET /api/plugins/registry via the
  // `plugins:registry` RPC channel. Returns the rows verbatim — invalid
  // manifests come back with `valid: false` + an `error` string so the UI
  // can show the user why their YAML didn't load.
  pluginsRegistry(): Promise<PluginRegistryRow[]>;
}

/**
 * The HONEST subset of `Api` that the Electron preload runtime actually
 * implements (`src/preload/index.ts`'s `api` object literal, exposed as
 * `window.__mantaPreload`).
 *
 * This is the KEY to the "Api type lie" (BET-733 / audit L10): `main.tsx`
 * used to cast `__mantaPreload` to the FULL `Api`, letting renderer code
 * call `window.api.<method>` for methods the preload does NOT have — a
 * compile-legal call that is `undefined` at runtime until httpApi is
 * installed post-pairing (the exact class of bug behind the dead-subscription
 * P0). Typing `__mantaPreload` as `PreloadApi` makes those missing methods a
 * compile-visible absence: anything on `PreloadApi` is guaranteed implemented;
 * anything on `Api` but absent from `PreloadApi` must go through a guard.
 *
 * Enumerated from `src/preload/index.ts`'s object literal. The preload also
 * implements methods NOT in the `Api` contract (pairing / installer / some OS
 * bridges such as `authUnpair`, `readClipboardText`, `readLocalFile`,
 * `onPairLink`, `dialogShowOpenFile`, the `installer*` family) — those are
 * reached via `window.__mantaPreload` (typed `MantaPreload` in
 * `src/renderer/preloadAccess.ts`), never through `window.api`/`Api`, so they
 * don't belong here.
 *
 * Do NOT weaken `Api` — `httpApi` must still be typecheck-enforced against the
 * FULL contract. This type only narrows what the preload bridge claims.
 */
export type PreloadApi = Pick<
  Api,
  | "configGet"
  | "authClaim"
  | "clipboardWriteText"
  | "clipboardReadImage"
  | "onScreenshotDetected"
  | "onDesktopNotify"
  | "getPathForFile"
  | "peekRemoteFile"
  | "openExternal"
  | "revealInFolder"
  | "downloadFileToDownloads"
  | "onServerUpdateAvailable"
  | "autoUpdateDownload"
  | "autoUpdateInstall"
  | "onAutoUpdateAvailable"
  | "onAutoUpdateDownloaded"
  | "onAutoUpdateError"
>;
