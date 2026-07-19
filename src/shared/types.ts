// ----- Local app config -----
// Source of truth for sessions/windows is tmux on the remote. We only persist
// per-project UI metadata locally (defaultCwd, eventually color/sort/etc).

export type ProjectMeta = {
  tmuxSession: string; // == project name (and the tmux session name on the remote)
  defaultCwd: string;
};

export type AppConfig = {
  projects: ProjectMeta[];
  // ----- HTTP/relay transport (M6 onboarding, BET-49) -----
  // Base URL of the bui-server the desktop pairs with, e.g.
  // "http://box.example:8787" (or a relay URL later). Set during onboarding
  // step 1 (pairing) alongside boxId/boxToken. Presence of boxToken — NOT this
  // — is what flips transport mode to HTTP; this is where to reach the box.
  // Absent/empty on legacy SSH configs.
  serverUrl?: string;
  // 32-hex (128-bit) opaque box pseudonym returned by POST /auth/claim.
  // Displayed in QR/UI; maps to nothing human. Absent/empty pre-pairing.
  boxId?: string;
  // 32-hex (128-bit) bearer secret returned by POST /auth/claim. Sent as
  // `Authorization: Bearer <boxToken>` on every HTTP-mode request. Stored
  // plaintext like other bui credentials. When set, transport mode is "http".
  // Absent/empty on legacy SSH configs (which keep using `host`).
  boxToken?: string;
  // True once the user explicitly skipped the onboarding flow, so it doesn't
  // re-trigger on every launch of an otherwise-empty config (no host, no
  // boxToken, no projects). Re-runnable from Settings ("Run setup again").
  // Default false / absent.
  onboardingSkipped?: boolean;
  // ----- Agent → laptop file push (outbox) -----
  // The reverse of drag-and-drop upload: the remote AI drops a file into
  // `~/.manta-outbox/` and bui scp-pulls it to the Mac. An outbox poller in
  // main watches that dir over the warm ControlMaster.
  //
  // Trust flag, analogous to chatAutoAllow. When true, detected outbox files
  // are pulled to `downloadsDir` immediately and the toast is informational
  // ("AI sent you X · Reveal"). When false (default), the toast asks the user
  // to confirm before the pull happens. Off by default — a remote process
  // writing files straight into the user's Downloads is sensitive.
  allowAgentPush?: boolean;
  // Destination directory for agent-pushed files. Absolute path on the Mac.
  // Absent → app.getPath("downloads") (~/Downloads). A leading "~" is NOT
  // expanded here; pass an absolute path or leave empty for the default.
  downloadsDir?: string;
  /**
   * Per-launcher CLI flag values for TUI launch modes (BET-138 refinement).
   * Keyed by launcher id (see src/server/launcherRegistry.mjs), then flag key.
   * Missing keys fall back to each flag's registry `default`. Example:
   *   { claude: { skipPermissions: true } }
   */
  launcherFlags?: Record<string, Record<string, boolean>>;
  // Local port forwarded to the remote `opencode serve` instance for chat-mode
  // windows. Defaults to 14096 to avoid colliding with a user's local opencode
  // running on 4096.
  opencodePort?: number;
  // "Trust" / auto-allow mode for chat-mode windows. When true, the main
  // process auto-replies "always" to every opencode permission.asked event,
  // so tool calls run without prompting. Closest analog to Claude Code's
  // --dangerously-skip-permissions. Off by default.
  chatAutoAllow?: boolean;
  // Auto-rename chat-mode tmux windows from the conversation. When true,
  // ChatPanel periodically (every Nth user turn) asks opencode to summarize
  // the recent transcript into a 1-2 word title and renames the window via
  // tmuxRenameWindow. Uses a throwaway opencode session (the user's own model;
  // no Groq key needed). ALWAYS overwrites the current name, including names
  // set by hand — so it's OFF by default and opt-in via Settings. See the
  // "Auto-rename" notes in AGENTS.md.
  autoRenameSessions?: boolean;
  // Global default model for all new and cleared chat sessions. Stored as
  // { providerID, modelID } so the per-session localStorage override and
  // this setting use the same shape. When absent, opencode picks its own
  // default (the first connected provider's default model).
  defaultModel?: { providerID: string; modelID: string };
  // Extra skill registry URLs written to the remote opencode.jsonc as
  // skills.urls. The default registry (https://antoinedc.github.io/bui-skills)
  // is always prepended by the binary once the upstream PR lands; these are
  // user-added extras. Empty array = no user-added registries.
  skillRegistryUrls?: string[];
  // BET-123: models the user has explicitly deactivated from the "every
  // model is auto-registered as a subagent" reconciliation. Entries are
  // "providerID/modelID" strings. A model in this set never gets an
  // opencode.jsonc `agent` block written for it (and any existing block is
  // removed on the next sync) — deactivation is bui-side state, NOT opencode
  // config, so a deactivated model isn't silently re-added on the next
  // reconcile. Reuses the plain configGet/configUpdate channels like every
  // other AppConfig field — no dedicated IPC channel needed. Absent/empty =
  // every known model is registered.
  deactivatedSubagents?: string[];
  // Anthropic prompt cache TTL used by opencode. Used ONLY to predict when
  // a chat session has gone stale (cache expired → the next user turn
  // would re-bill the entire cached prefix as cache_creation_input_tokens
  // at full rate + surcharge). bui does NOT itself set
  // `cache_control.ttl` — opencode does. This setting must match what
  // opencode is configured to send, otherwise the "/clear to save Nk
  // tokens" pill will fire either too eagerly (configured 1h, opencode
  // sending 5m) or too late (vice versa). Anthropic supports two values:
  //   - "5m" → default sliding 5-minute TTL, 1.25× write cost
  //   - "1h" → opt-in 1-hour TTL via `cache_control.ttl: "1h"`, 2× write
  //            cost. Best fit for bui's "step away to read code / run a
  //            build / take a meeting" usage pattern.
  // Defaults to "1h" because that matches bui's typical multi-minute idle
  // pattern; cost-sensitive users can switch to "5m" in Settings.
  cacheTtl?: "5m" | "1h";
  // ----- Voice / speech-to-text (Groq) -----
  // API key for api.groq.com. Stored plaintext in config.json, same as other
  // bui credentials (ssh identity path, opencode auth). Settings UI shows
  // a masked password input. Absent → mic button is hidden in the UI.
  groqApiKey?: string;
  // Whisper-family transcription model. Default
  // "whisper-large-v3-turbo" balances latency (~200-500ms for short clips)
  // and accuracy. Override only if you have a reason (e.g. larger-v3 for
  // non-English content where turbo regresses).
  voiceTranscriptionModel?: string;
  // Small instruct model used as a LAST-RESORT classifier when the rules
  // classifier in chatUtils.ts can't match a command-mode utterance. Default
  // "llama-3.1-8b-instant" — JSON-mode capable, ~$0.0001/call, ~300ms.
  voiceCommandModel?: string;
};

// ----- Live tmux state -----
// Returned from the remote on demand; never persisted.

export type TmuxWindow = {
  index: number;
  name: string;
  active: boolean;
  paneCurrentPath: string;
  // For chat-mode windows: the opencode session id stamped on the tmux window
  // as user-option `@manta-session-id`. Null for claude-TUI windows (the default).
  // Presence of this id is THE signal that the renderer should show ChatPanel
  // instead of Terminal for this window.
  opencodeSessionId: string | null;
};

export type TmuxSession = {
  name: string;
  attached: boolean;
  windows: TmuxWindow[];
};

// ----- Derived view used by the UI -----

export type Project = {
  tmuxSession: string;        // also the display name
  defaultCwd: string;         // from local meta, or "~" if unknown
  windows: TmuxWindow[];
  attached: boolean;
};

export type TmuxConfigStatus = {
  mantaManaged: boolean;   // ~/.tmux.conf currently has bui's config
  backupExists: boolean; // ~/.tmux.conf.pre-manta exists (restore is possible)
};

// One entry per `git worktree list --porcelain` block, run from the user's
// chosen project cwd. Empty array if the cwd isn't inside a git repo.
export type WorktreeInfo = {
  path: string;            // absolute path on the remote
  head: string;            // commit sha
  branch: string | null;   // short ref name (e.g. "main", "feature/foo"); null if detached/bare
  bare: boolean;
  detached: boolean;
};

// ----- IPC inputs -----

// BET-138: the pty is a shell-in-cwd (or, for a launcher mode, an AI CLI TUI
// like `claude`) spawned directly in a chat session's working directory — NOT
// a tmux attach. `sessionKey` is the caller-composed
// `${opencodeSessionId}:${modeId}` (modeId = "terminal" or a launcher id from
// src/server/launcherRegistry.mjs) so Terminal mode and each TUI launcher
// mode of the same chat session get independent, kept-warm PTYs.
export type SpawnOptions = {
  sessionKey: string; // stable per-session-mode id: see comment above
  cwd: string;        // working dir for the shell/CLI (may be tilde-prefixed)
  cols: number;
  rows: number;
  // Present only for a TUI launch mode (absent = plain login shell).
  launcher?: { id: string; flags: Record<string, boolean> };
};

export type PtyEvent =
  | { kind: "data"; sessionKey: string; data: string }
  | { kind: "exit"; sessionKey: string; code: number | null };

// One AI CLI TUI launcher available on this box (see src/server/launcherRegistry.mjs
// for the full registry; this is the availability-filtered subset the server
// reports via IPC.launchersList). `flags` is the schema only — the CLI-flag
// mapping (`arg`) stays server-side and never crosses to the renderer.
export type LauncherFlagSchema = {
  key: string;
  label: string;
  type: "boolean";
  default: boolean;
};

export type AvailableLauncher = {
  id: string;
  label: string;
  flags: LauncherFlagSchema[];
};

// Per-window activity status, derived from periodically capturing pane buffers
// on the remote and looking for claude's busy markers. One entry per existing
// tmux window; absence means "no data yet for this window".
export type WindowStatus = {
  session: string;
  windowIndex: number;
  running: boolean;
  subagents: number;
};

// A desktop OS-notification directive, relayed from bui-server's notification
// router (push.mjs) to the desktop renderer over the -L 18787 forward + IPC.
// The renderer does the final "am I viewing this session right now?"
// suppression and shows it via the Notification API. See docs/bui-tools-notify.md.
export type DesktopNotifyPayload = {
  kind: string; // "permission" | "question" | "error" | "done" | "notify"
  title: string;
  body: string;
  sessionId: string | null;
  tag: string;
  urgent?: boolean;
};

export const IPC = {
  configGet: "config:get",
  configUpdate: "config:update",

  // Project metadata (local-only)
  projectMetaUpsert: "project:meta:upsert",
  projectMetaDelete: "project:meta:delete",

  // tmux operations on the remote
  tmuxList: "tmux:list",
  tmuxNewSession: "tmux:new-session",         // creates tmux session + first window
  tmuxNewWindow: "tmux:new-window",
  tmuxRenameSession: "tmux:rename-session",
  tmuxRenameWindow: "tmux:rename-window",
  tmuxKillSession: "tmux:kill-session",
  tmuxKillWindow: "tmux:kill-window",
  tmuxSelectWindow: "tmux:select-window",

  // Git: detect worktrees under a cwd (for auto-populating sessions on project create)
  gitListWorktrees: "git:list-worktrees",

  // Directory autocomplete: given a partial path, list matching subdirectories
  fsListDirs: "fs:list-dirs",

  // Remote tmux config management
  tmuxConfigStatus: "tmux:config-status",
  tmuxSetupConfig: "tmux:setup-config",     // backup user config, install bui's
  tmuxRestoreConfig: "tmux:restore-config", // restore user's backup

  // Clipboard (OSC 52 from remote → Mac system clipboard via Electron main)
  clipboardWriteText: "clipboard:write-text",
  // Read the current clipboard image as PNG ArrayBuffer (null if no image).
  // Called on demand after a screenshotDetected event — not polled.
  clipboardReadImage: "clipboard:read-image",
  // Read an arbitrary local (Mac) file's raw bytes. Only main can touch the
  // OS filesystem — this is how the renderer gets bytes for a Desktop
  // screenshot detection (screenshotDetected source:"file") so it can then
  // upload them via uploadBuffer. NOT for remote/box files (see peekRemoteFile).
  readLocalFile: "fs:read-local-file",

  // Drag-and-drop file upload to a per-session remote tmp dir
  uploadFiles: "upload:files",
  // Clipboard-paste upload: send raw bytes from the renderer (e.g. a PNG from
  // the system clipboard) → main writes a temp file → scp to remote.
  uploadBuffer: "upload:buffer",

  // Click-to-peek: pull a remote file local + open in default app
  peekRemoteFile: "peek:remote-file",
  // Open a URL in the user's default browser
  openExternal: "shell:open-external",

  // ---- Agent → laptop file push (outbox) ----
  // Pull a remote outbox file to the local downloads dir. Returns the saved
  // local absolute path. Deletes the remote source on success (one-shot mailbox).
  agentPullFile: "agent:pull-file",
  // Reveal a local file in Finder / the OS file manager.
  revealInFolder: "shell:reveal-in-folder",
  // main → renderer push: a new file appeared in the remote ~/.manta-outbox/.
  // Payload: { remotePath, name, size, sessionName?, autoPulled, localPath? }.
  // When config.allowAgentPush is on, main pulls first and sets autoPulled:true
  // + localPath; otherwise it's a confirm prompt (autoPulled:false).
  agentFileReady: "agent:file-ready",

  // ---- opencode chat-mode ----
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyEvent: "pty:event",

  // Which AI CLI TUI launchers (Claude Code, ...) are available on this box
  // right now — binary on PATH AND its opencode provider connected. Drives
  // the session-mode dropdown's launcher options (BET-138 refinement).
  launchersList: "launchers:list",

  // Per-window activity status, pushed every ~2s from a remote pane-capture poll
  statusEvent: "status:event",

  // Screenshot detection: main → renderer push when a new screenshot is
  // detected (clipboard image or new file on Desktop). Renderer shows a
  // "Add to chat?" toast. Payload: { source: "clipboard"|"file", path?: string }
  // path is only set for file-based detections (Desktop watcher).
  screenshotDetected: "screenshot:detected",

  // main → renderer push: the bui-server notification router decided the
  // desktop should show an OS notification. Relayed from the server's
  // `desktopNotify` bus event. Payload:
  // DesktopNotifyPayload. The renderer suppresses it if it's already viewing
  // that session, else shows it via the Notification API + deep-links on click.
  desktopNotify: "desktop:notify",

  // ---- opencode chat-mode ----
  // Fetch full transcript for a session id (one-shot HTTP call on the remote).
  opencodeMessages: "opencode:messages",
  // Synchronous-ish cached transcript lookup. Returns the last successful
  // `opencodeMessages` payload from disk (or null on miss). Used by the
  // renderer to paint the chat panel instantly while the slow fresh fetch
  // runs in the background.
  opencodeMessagesCached: "opencode:messages-cached",
  // Fetch a single message by id (GET /session/{id}/message/{messageID}, ~20–80ms).
  // Used to splice a finalized/changed message into the renderer's transcript
  // during a live turn instead of re-pulling the whole (up to 3 MB) transcript.
  // Returns null on miss/error so the caller can fall back to a full refetch.
  opencodeMessage: "opencode:message",
  // Reconcile a session's transcript against the renderer's known message ids
  // by fetching only the recent tail (GET .../message?limit=N) and merging it
  // into the cached array. Returns the merged full transcript. Falls back to a
  // full pull when the tail doesn't overlap the cache (a gap), so history is
  // never truncated. Replaces the full refetch on session-switch/reconnect.
  opencodeMessagesReconcile: "opencode:messages-reconcile",
  // Live SSE stream from opencode, forwarded raw to the renderer. Renderer
  // filters by sessionID in the event payload.
  opencodeEvent: "opencode:event",
  // Stream lifecycle. The renderer opens a scoped `/event?directory=` stream
  // when a ChatPanel mounts for a session and releases it on unmount. The main
  // process refcounts per directory and tears the stream down when the last
  // open panel for that dir goes away. This is what bounds concurrent streams
  // to the handful of sessions the user actually has open — without it, the
  // bus opened a persistent stream for EVERY directory opencode knows about
  // (on a Multica box, ~100 workspace dirs → hundreds of leaked CLOSE-WAIT
  // sockets that drown opencode serve and make every request crawl).
  opencodeOpenStream: "opencode:open-stream",
  opencodeCloseStream: "opencode:close-stream",
  // Send a user prompt to a session. Returns when the server has accepted
  // the message (immediate); the assistant response streams via opencodeEvent.
  opencodePrompt: "opencode:prompt",
  // Interrupt the running generation for a session.
  opencodeAbort: "opencode:abort",
  // Permission approval flow — tools like Write/Edit/Bash pause until a reply.
  opencodePermissions: "opencode:permissions",
  opencodePermissionReply: "opencode:permission-reply",
  // Question tool flow — Claude asks structured multiple-choice questions.
  // v2 API only: GET /question, POST /question/{id}/reply, POST /question/{id}/reject.
  opencodeQuestions: "opencode:questions",
  opencodeQuestionReply: "opencode:question-reply",
  opencodeQuestionReject: "opencode:question-reject",
  // Model picker: list available models on the remote opencode server (with
  // provider secrets stripped before forwarding).
  opencodeModels: "opencode:models",
  // Provider management: list/set custom providers + discover models.
  opencodeGetProviders: "opencode:get-providers",
  opencodeSetProviders: "opencode:set-providers",
  opencodeDiscoverModels: "opencode:discover-models",
  // Subagent management: list/set named subagent blocks in opencode.jsonc.
  opencodeGetSubagents: "opencode:get-subagents",
  opencodeSetSubagents: "opencode:set-subagents",
  // BET-123: reconcile the full model list against configured agent blocks +
  // AppConfig.deactivatedSubagents, applying only the diff. Returns the
  // resulting SubagentDef[]. Idempotent — safe to call on every card open.
  opencodeSyncSubagents: "opencode:sync-subagents",
  // Restarts the box's opencode systemd --user service so a subagent/
  // provider config write takes effect (opencode only re-reads `agent`/
  // `provider` blocks at startup). Destructive: drops every in-flight
  // opencode turn across all chat-mode windows. Callers must confirm with
  // the user before invoking this — see SubagentsCard's restart button.
  opencodeRestart: "opencode:restart",
  // What opencode would use if prompt_async were called without a model.
  opencodeDefaultModel: "opencode:default-model",
  // Current VCS branch for a working directory. SSE `vcs.branch.updated`
  // only fires on change, so the chat footer fetches the initial value on
  // mount via this channel.
  opencodeVcsBranch: "opencode:vcs-branch",
  // Re-mint expired Claude OAuth credentials (spawns `claude` server-side)
  // and report the outcome. Triggered by the renderer's ProviderAuthError
  // handler — see the session.error switch in useSseBus.ts.
  opencodeRefreshCredentials: "opencode:refresh-credentials",
  // Session management: list/fork/compact/delete.
  opencodeListSessions: "opencode:list-sessions",
  opencodeForkSession: "opencode:fork-session",     // returns new sessionId
  opencodeCompactSession: "opencode:compact-session",
  opencodeDeleteSession: "opencode:delete-session",
  // Typeahead sources for the input area (@-mention files/agents, /-commands).
  opencodeCommands: "opencode:commands",
  opencodeAgents: "opencode:agents",
  opencodeFindFiles: "opencode:find-files",
  // Slash-command execution: invokes POST /session/{id}/command. Distinct
  // from opencode:prompt — the server treats commands specially (templates,
  // configured agent/model, etc.).
  opencodeRunCommand: "opencode:run-command",
  // /clear: drop the current session's history by creating a fresh opencode
  // session in the same directory, then re-stamping the tmux window's
  // @manta-session-id user-option. The renderer notices the new id and
  // unmounts/remounts ChatPanel.
  opencodeClearSession: "opencode:clear-session",
  // Auto-rename: generate a short 1-2 word title for a session by spawning a
  // throwaway opencode session, prompting it to summarize the conversation,
  // then deleting it. Returns the RAW model reply (renderer sanitizes). Used
  // by ChatPanel when AppConfig.autoRenameSessions is enabled.
  opencodeGenerateTitle: "opencode:generate-title",

  // ---- voice (Groq STT + lightweight classifier) ----
  // Renderer captures audio via MediaRecorder, ships the ArrayBuffer to
  // main/server, which posts multipart to api.groq.com so the API key never
  // touches the renderer process. Same channel + shape on desktop and
  // mobile transports. `mode:"dictate"` returns the raw transcript.
  // `mode:"command"` ALSO routes through the local rules classifier and
  // (on no match) a Groq llama call returning { kind:"action", action, args }
  // — see chatUtils.ts classifyVoiceCommand.
  voiceTranscribe: "voice:transcribe",
  voiceClassifyCommand: "voice:classify-command",

  // ---- onboarding pairing (BET-49) ----
  // Exchange a 6-digit pairing code for the box's { boxToken, boxId } via
  // POST <serverUrl>/auth/claim, and on success persist { serverUrl, boxId,
  // boxToken } to config (which flips transport mode to "http"). Distinct from
  // the mobile client's own claim (renderer/api/httpApi submitPairingCode →
  // localStorage): desktop main owns the fetch so it can write config.json.
  // Input: { serverUrl, code }. Result: the classified ClaimOutcome
  // (src/shared/claim.mjs) — never throws for a normal auth failure.
  authClaim: "auth:claim",
  // Mint a one-time pairing code for mobile device pairing (BET-80).
  // GET <serverUrl>/auth/pair → { pairing_code, box_id, expiresAt }
  // The desktop renders the code in a QR (manta://pair?id=<boxId>&token=<code>)
  // and lets the mobile app scan it. Main owns the fetch over the SSH tunnel.
  // Result: { pairingCode, boxId, expiresAt } or { error }.
  authPair: "auth:pair",

  // ---- scheduled prompts (bui-server owned) ----
  // Schedules are a bui-SERVER concept (durable jobs fired by the always-on
  // box process), NOT an opencode concept — so they get their own channels
  // that hit bui-server's /api/schedule rather than routing through the
  // opencode client. Created by the remote AI's global `schedule` opencode
  // tool; listed/deleted by the ScheduledTasksCard UI. Desktop reaches the
  // server store over its existing SSH -L 18787 forward (src/main/schedule.ts);
  // mobile is in-process (src/server/rpc.mjs → schedule.mjs).
  scheduleList: "schedule:list", // (sessionId?) → ScheduledJob[]
  scheduleDelete: "schedule:delete", // (id) → { deleted: boolean }

  // ---- secrets (bui-server owned) ----
  // A secure key→value store on the box. The user adds/edits secrets in the
  // SecretsCard UI; the VALUE never leaves the box and is never returned here
  // (list yields metadata only). The remote AI reads secrets through its global
  // `secret_list` / `secret_provide` opencode tools (POST /api/secrets/provide,
  // which materializes the value to a 0600 file and returns only the path) —
  // NOT through these UI channels. Desktop reaches the server store over its
  // SSH -L 18787 forward (src/main/secrets.ts); mobile is in-process
  // (src/server/rpc.mjs → secrets.mjs).
  secretsList: "secrets:list", // (sessionId?, all?) → SecretMeta[]
  secretsSet: "secrets:set", // (SecretInput) → { ok, meta? , error? }
  secretsDelete: "secrets:delete", // (id) → { deleted: boolean }

  // ---- inbound webhooks (bui-server owned) ----
  // External actors POST to a public /hook/<token> route to wake a chat session
  // with an event (the push counterpart to scheduled polling). CREATED by the
  // remote AI's global `webhook` opencode tool (which gets the URL + signing
  // secret); the UI only LISTS + REVOKES (the secret is shown once at create,
  // never re-exposed). Desktop reaches the server store over its SSH -L 18787
  // forward (src/main/webhook.ts); mobile is in-process (rpc.mjs → webhooks.mjs).
  webhookList: "webhook:list", // (sessionId?) → WebhookMeta[]
  webhookDelete: "webhook:delete", // (id) → { deleted: boolean }

  // ---- auto-update (electron-updater) ----
  // Desktop-only. Main checks for updates on launch, downloads silently in the
  // background, then pushes updateAvailable / updateDownloaded events to the
  // renderer. The renderer shows a "Restart to update" prompt when the download
  // completes. The renderer calls autoUpdateDownload / autoUpdateInstall to
  // trigger the download and the restart, respectively.
  autoUpdateDownload: "autoUpdate:download",          // renderer → main: trigger download
  autoUpdateInstall: "autoUpdate:install",            // renderer → main: trigger restart+install
  autoUpdateAvailable: "autoUpdate:available",        // main → renderer: an update is available
  autoUpdateDownloaded: "autoUpdate:downloaded",      // main → renderer: update is ready to install

  // ---- server version (BET-180) ----
  // Returns the bui-server's package.json version (read once at server startup,
  // served by GET /api/version for non-renderer clients AND by this in-process
  // RPC channel for the renderer — single source of truth on the box, never
  // drifts between surfaces). Display-only foundation for client/server skew
  // detection; gating / banner / force-update logic lands in a later phase.
  getServerVersion: "server:version",                 // () → { version: string }
} as const;

// A secret's METADATA — what the UI and `secret_list` see. NEVER carries the
// value (bui-server strips it; only secret_provide materializes the value, to a
// 0600 file on the box). Store: ~/.manta/secrets.json.
export type SecretScope = "shared" | "session" | "project";
export type SecretMeta = {
  id: string; // 8-char hex store id (used for delete)
  key: string; // env-var-style name, e.g. "GITHUB_PAT"
  scope: SecretScope; // shared = every session; session = one sessionID; project = one workspace
  sessionID: string | null; // set when scope === "session"
  project: string | null; // set when scope === "project" (bui/tmux workspace name)
  hint: string; // optional human usage note (safe to show the agent)
  hasValue: boolean; // a value is stored (always true for persisted secrets)
  createdAt: number | null;
  updatedAt: number | null;
};

// Input shape for secretsSet (UI → store). The value travels renderer → IPC →
// box, never through the AI transcript. For scope === "project", the server
// resolves the project name from sessionID when `project` is omitted.
export type SecretInput = {
  key: string;
  value: string;
  scope: SecretScope;
  sessionID?: string | null;
  project?: string | null;
  hint?: string;
};

// An inbound webhook's METADATA — what the UI and `webhook_list` see. NEVER
// carries the signing secret (returned once at create, then stripped). Store:
// ~/.manta/webhooks.json.
export type WebhookMeta = {
  id: string; // 8-char hex store id (used for delete)
  label: string; // human label, e.g. "multica CAPO-123 done"
  url: string | null; // public delivery URL (https://app.mantaui.com/hook/<token>)
  unsigned: boolean; // true = no HMAC signature required (discouraged)
  sessionID: string | null; // the session this hook wakes
  instructions: string; // standing directive prepended to each delivery
  createdAt: number | null;
  lastDeliveredAt: number | null; // ms epoch of the last successful delivery
  deliveries: number; // total deliveries
};

// A durable scheduled-prompt job (manta store: ~/.manta/schedule.json).
export type ScheduledJob = {
  id: string; // 8-char hex
  cron: string; // 5-field expression (local time)
  prompt: string;
  recurring: boolean;
  label: string;
  sessionID: string;
  directory: string;
  createdAt: number;
  lastFiredMinute: string | null;
};

// ----- Agent → laptop file push (outbox) -----

// main → renderer push when a file is detected in the remote ~/.manta-outbox/.
// One per detected file. The toast (store-backed, rendered by the active
// ChatPanel) either confirms the pull (autoPulled:false) or just announces a
// completed pull (autoPulled:true, localPath set).
export type AgentFileReady = {
  // Absolute remote path of the outbox file (source of the scp pull).
  remotePath: string;
  // Basename, for display + the saved local filename.
  name: string;
  // Byte size from the remote `stat`, for display. 0 if unknown.
  size: number;
  // tmux/project session inferred from the outbox subdir (~/.manta-outbox/<session>/…),
  // or null when the file was dropped at the outbox root.
  sessionName: string | null;
  // True when allowAgentPush was on and main already pulled the file.
  autoPulled: boolean;
  // Saved local absolute path — only set when autoPulled is true.
  localPath?: string;
};

// ----- Onboarding pairing (BET-49) -----

// Input for the desktop auth:claim channel. The mobile/web client always
// supplies a non-empty `serverUrl` (direct-HTTPS pairing, BET-49). The desktop
// onboarding shell (BET-156) accepts EITHER `serverUrl` OR `boxId` (the
// relay-paired form); when `boxId` is set, `serverUrl` MUST be an empty
// string (the same field stays required so httpApi — which is mobile-only —
// sees an unchanged type signature, per BET-156's "do not modify httpApi"
// rule):
//   • serverUrl non-empty → POST <serverUrl>/auth/claim { code } (BET-49).
//   • boxId set, serverUrl "" → POST https://relay.mantaui.com/pair
//     { box_id, code } (BET-156). Persists
//     { serverUrl: "<RELAY_BASE>/box/<box_id>", boxId, boxToken } so every
//     downstream /rpc + /events + upload hits the relay's /box/:box_id/*
//     proxy with zero new data-path code (ADR-3).
// `code` is the 6-digit pairing code (either flow). The typed OUTCOME lives in
// src/shared/claim.mjs (ClaimOutcome) — imported by preload/main directly so
// types.ts stays dependency-free.
export type AuthClaimInput = {
  serverUrl: string;
  boxId?: string;
  code: string;
};

// Result of GET /auth/pair — a one-time pairing code the desktop renders as a
// QR for mobile scanning. `expiresAt` is an ISO-8601 timestamp (server-side
// clock); the desktop computes the remaining seconds for the UI countdown.
// `error` is non-null only on failure (network, 403 from a non-loopback
// address, 429 rate limit, 5xx).
export type AuthPairResult =
  | { ok: true; pairingCode: string; boxId: string; expiresAt: string }
  | { ok: false; error: string };

// ----- opencode message + part types (subset for Phase 1) -----
//
// Mirrors the shape of `GET /session/{id}/message` on the opencode server:
// each entry is { info: Message, parts: Part[] }. We keep the type surface
// narrow on purpose — only the fields the renderer actually reads. The full
// schemas live at http://<server>/doc and have many more fields we ignore.

export type OpencodeRole = "user" | "assistant";

export type OpencodeMessageInfo = {
  id: string;             // msg_...
  sessionID: string;      // ses_...
  role: OpencodeRole;
  time?: { created?: number; completed?: number };
  // assistant-only fields surfaced here for the model/cost line in the UI:
  modelID?: string;
  providerID?: string;
};

// Generic part shape. Each part carries id/messageID/type plus arbitrary
// type-specific fields. The renderer narrows on `type` and casts to a richer
// shape in-place — there are 12 known variants in opencode today and we don't
// want to maintain a full discriminated union here.
export type OpencodePart = {
  type: string;
  id: string;
  messageID: string;
  // text-bearing variants ("text", "reasoning") have a string text field;
  // surfaced here for convenience.
  text?: string;
  // text-part specific
  synthetic?: boolean;
  ignored?: boolean;
  // anything else (tool state, file refs, diffs, ...) — caller casts.
  [k: string]: unknown;
};

export type OpencodeMessage = {
  info: OpencodeMessageInfo;
  parts: OpencodePart[];
};

// Generic SSE event envelope, mirroring opencode's `Event` union. The
// renderer switches on `type` and reads `properties` for the payload.
export type OpencodeEvent = {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

// Slash command exposed by opencode (`/init`, user-defined templates, etc.).
// `template` is the raw prompt body opencode injects as the user message when
// the command runs (with `$ARGUMENTS` / `$1` etc. substituted at run time).
// Used by ChatPanel to detect command-origin user messages retroactively
// (the live `command.executed` event only tags messages created during this
// panel's lifetime; older transcripts have no live-event provenance).
export type OpencodeCommand = {
  name: string;
  description?: string;
  source?: string;        // "command" | "project" | "global"
  argumentHint?: string;
  agent?: string;
  model?: string;
  template?: string;
};

// Agent definition exposed by opencode (build/plan/general-purpose + user
// subagents). Used for @-mention typeahead.
export type OpencodeAgent = {
  name: string;
  description?: string;
  mode?: string;          // "primary" | "subagent"
  native?: boolean;
  builtIn?: boolean;
};

// A custom provider entry as seen by the renderer (API key value is never
// forwarded — only whether one is set).
export type ProviderEndpoint = {
  id: string;            // opencode provider id, e.g. "voska"
  name: string;          // display name, e.g. "VoskaAI"
  baseURL: string;       // e.g. "https://api.voska.org/v1"
  hasApiKey: boolean;    // true if an apiKey is set; the value never leaves main
  enabledModels: string[]; // model ids present in this provider's opencode `models` map
};

// Result of probing a provider's baseURL/key for available models.
export type DiscoverResult =
  | { ok: true; models: { id: string }[] }
  | { ok: false; error: "unreachable" | "unauthorized" | "bad_response"; detail?: string };

// Input the renderer sends to set/replace a single provider. apiKey is optional:
// omitted/undefined means "keep the existing key"; empty string means "no key".
export type ProviderInput = {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  enabledModels: string[];
};

// A configured subagent block from opencode.jsonc. Projected by readAgentBlocks.
export type SubagentDef = {
  name: string;          // agent name, e.g. "fast"
  model: string;         // "providerID/modelID", e.g. "anthropic/claude-haiku-4"
  description: string;   // human description, e.g. "Fast worker for mechanical tasks"
};

// Input the renderer sends to set/replace a single subagent.
export type SubagentInput = {
  name: string;
  model: string;
  description: string;
};

// Trimmed view of an opencode model from GET /api/model. The wire format
// includes provider auth (`options.aisdk.provider.apiKey`) — opencode.ts
// strips that field before this leaves the main process.
export type OpencodeModel = {
  id: string;            // e.g. "claude-opus-4-7"
  providerID: string;    // e.g. "anthropic"
  family?: string;
  name: string;          // human-readable, e.g. "Claude Opus 4.7"
  status?: string;       // "active" / "deprecated" / ...
  enabled?: boolean;
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  variants?: Array<{ id: string }>;
};

// Trimmed session list entry from GET /session. `model` is the last model used
// on this session (per-prompt metadata, not a session setting).
export type OpencodeSessionListItem = {
  id: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  parentID?: string;
  cost?: number;
  tokens?: { input: number; output: number };
  model?: { id: string; providerID: string; variant?: string };
  time?: { created?: number; updated?: number };
};

// Pending permission request emitted when a tool (Write/Edit/Bash/etc) needs
// user approval. `tool.callID` links back to the matching ToolPart in the
// transcript. `patterns`/`always` carry the scope opencode would grant if the
// user picks "always" — usually a glob like ["/tmp/*"].
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;          // category, e.g. "external_directory", "bash"
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

// Question tool — Claude asks the user structured multiple-choice questions
// mid-task. v2 API only. Events: question.asked, question.replied, question.rejected.
export type QuestionOption = { label: string; description: string };
export type QuestionInfo = {
  question: string;   // full question text
  header: string;     // short label (max 30 chars)
  options: QuestionOption[];
  multiple?: boolean; // allow multi-select
  custom?: boolean;   // allow free-text answer
};
export type QuestionRequest = {
  // Canonical key: tool.callID when present (dedupes the live question.asked
  // event with transcript recovery). NOT the API reply key — see requestId.
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
  // The opencode `que_…` request id from the question.asked event. This is
  // the ONLY id opencode's /question/{requestID}/reply|reject accepts. Absent
  // for transcript-only recovered questions (which are thus unanswerable).
  requestId?: string;
};

// ----- Voice / speech-to-text (Groq) -----

// Input for voice:transcribe. `buffer` is the raw audio bytes captured by
// MediaRecorder on the renderer side; `mime` is the recorder's mimeType
// (e.g. "audio/webm;codecs=opus" on Chromium, "audio/mp4" on iOS Safari).
export type VoiceTranscribeInput = {
  buffer: ArrayBuffer;
  mime: string;
};

export type VoiceTranscribeResult = {
  text: string;
};

// All actions a voice command can dispatch. Renderer routes these to the
// appropriate handler — most are ChatPanel-scoped (submit/clear/compact/
// abort/model/answer-question/reply-permission), a couple are App-scoped
// (switch-window/new-session). `text` for "submit" carries the dictated body.
export type VoiceAction =
  | { kind: "submit"; text: string }
  | { kind: "append"; text: string } // insert into textarea, don't send
  | { kind: "clear" }
  | { kind: "compact" }
  | { kind: "fork" }
  | { kind: "abort" }
  | { kind: "help" }
  | { kind: "toggle-trust" }
  // Model: a fuzzy name match the renderer resolves against its model list.
  // We pass the user's spoken name and let the renderer pick the best match
  // (the classifier doesn't have the model list on hand).
  | { kind: "model"; query: string }
  // Permission/question replies — only valid when the matching card is open.
  | { kind: "allow-once" }
  | { kind: "allow-always" }
  | { kind: "reject" }
  | { kind: "answer"; choice: string }   // matches a QuestionOption.label
  // App-scoped: jump to (project, window) tuple by 1-based flat index.
  | { kind: "switch-window"; index: number }
  | { kind: "new-session" }
  | { kind: "open-settings" }
  | { kind: "unknown"; transcript: string };

// Input for voice:classify-command. Server runs the rules classifier first,
// falls back to a Groq llama call only if `useLlmFallback !== false`.
export type VoiceClassifyInput = {
  transcript: string;
  useLlmFallback?: boolean;
};

export type VoiceClassifyResult = {
  action: VoiceAction;
  // "rules" → matched the local rules classifier (zero token cost).
  // "llm"   → fell back to the Groq llama call.
  // "none"  → both paths failed; action.kind === "unknown".
  source: "rules" | "llm" | "none";
};
