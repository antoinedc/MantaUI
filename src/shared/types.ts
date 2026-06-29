// ----- Local app config -----
// Source of truth for sessions/windows is tmux on the remote. We only persist
// per-project UI metadata locally (defaultCwd, eventually color/sort/etc).

export type ProjectMeta = {
  tmuxSession: string; // == project name (and the tmux session name on the remote)
  defaultCwd: string;
};

export type AppConfig = {
  host: string;
  user?: string;
  identityFile?: string;
  projects: ProjectMeta[];
  // Transport selection. "auto" picks mosh if both ends have it, ssh otherwise.
  // "mosh" / "ssh" force one regardless of detection.
  transport?: "auto" | "mosh" | "ssh";
  // Auto-clean files in ~/.bui-uploads older than this many hours. 0 disables.
  uploadCleanupHours?: number;
  // ----- Agent → laptop file push (outbox) -----
  // The reverse of drag-and-drop upload: the remote AI drops a file into
  // `~/.bui-outbox/` and bui scp-pulls it to the Mac. An outbox poller in
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
  // ----- Cross-device shared-settings sync (LWW) -----
  // Epoch-ms timestamp of the last change to a SHAREABLE field (the
  // device-independent subset in src/shared/sharedConfig.mjs — voice/Groq,
  // defaultModel, chatAutoAllow, autoRenameSessions, cacheTtl). Desktop and
  // the mobile server each stamp this on a shareable change and compare it to
  // resolve "latest wins" when syncing. NOT bumped by device-local edits
  // (host/user/transport/projects/ports), so a desktop-only host change never
  // claims to be a newer shared-config snapshot. Absent = never synced.
  configUpdatedAt?: number;
};

export type TransportInfo = {
  effective: "mosh" | "ssh"; // what we'll actually use
  preference: "auto" | "mosh" | "ssh"; // user setting
  moshLocal: boolean; // mosh present on Mac
  moshRemote: boolean; // mosh-server present on remote
};

// ----- Live tmux state -----
// Returned from the remote on demand; never persisted.

export type TmuxWindow = {
  index: number;
  name: string;
  active: boolean;
  paneCurrentPath: string;
  // For chat-mode windows: the opencode session id stamped on the tmux window
  // as user-option `@bui-session-id`. Null for claude-TUI windows (the default).
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
  buiManaged: boolean;   // ~/.tmux.conf currently has bui's config
  backupExists: boolean; // ~/.tmux.conf.pre-bui exists (restore is possible)
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

export type SpawnOptions = {
  projectName: string; // tmux session to attach to
  cols: number;
  rows: number;
};

export type PtyEvent =
  | { kind: "data"; projectName: string; data: string }
  | { kind: "exit"; projectName: string; code: number | null };

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
  // main → renderer push: a new file appeared in the remote ~/.bui-outbox/.
  // Payload: { remotePath, name, size, sessionName?, autoPulled, localPath? }.
  // When config.allowAgentPush is on, main pulls first and sets autoPulled:true
  // + localPath; otherwise it's a confirm prompt (autoPulled:false).
  agentFileReady: "agent:file-ready",

  // Transport status (mosh vs ssh)
  transportInfo: "transport:info",

  // Long-lived attached PTY (one per active project)
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyEvent: "pty:event",

  // Per-window activity status, pushed every ~2s from a remote pane-capture poll
  statusEvent: "status:event",

  // Screenshot detection: main → renderer push when a new screenshot is
  // detected (clipboard image or new file on Desktop). Renderer shows a
  // "Add to chat?" toast. Payload: { source: "clipboard"|"file", path?: string }
  // path is only set for file-based detections (Desktop watcher).
  screenshotDetected: "screenshot:detected",

  // Cross-device shared-config sync pulled a newer snapshot from the mobile
  // server into desktop config. Renderer re-applies it to the store so the
  // Settings UI reflects the change without a manual refresh. Payload: the
  // full AppConfig.
  configChanged: "config:changed",

  // main → renderer push: the bui-server notification router decided the
  // desktop should show an OS notification. Relayed from the server's
  // `desktopNotify` bus event over the -L 18787 forward. Payload:
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
  opencodeRestart: "opencode:restart",
  // What opencode would use if prompt_async were called without a model.
  opencodeDefaultModel: "opencode:default-model",
  // Current VCS branch for a working directory. SSE `vcs.branch.updated`
  // only fires on change, so the chat footer fetches the initial value on
  // mount via this channel.
  opencodeVcsBranch: "opencode:vcs-branch",
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
  // @bui-session-id user-option. The renderer notices the new id and
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

  // ---- setup wizard ----
  // One-shot diagnostic over SSH: returns the status of every remote
  // prerequisite bui depends on (ssh reachable, tmux installed, opencode
  // installed, Anthropic auth wired). Used by the "Test connection"
  // button in Settings.
  setupProbe: "setup:probe",
  // Best-effort installer: runs opencode's official installer on the
  // remote and writes a minimal opencode.jsonc with the
  // opencode-claude-auth plugin. Idempotent — safe to re-run. Does NOT
  // perform Anthropic login (that requires browser flow on the remote);
  // surfaces the exact next-step command instead.
  setupBootstrap: "setup:bootstrap",

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
} as const;

// A secret's METADATA — what the UI and `secret_list` see. NEVER carries the
// value (bui-server strips it; only secret_provide materializes the value, to a
// 0600 file on the box). Store: ~/.bui-mobile/secrets.json.
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
// ~/.bui-mobile/webhooks.json.
export type WebhookMeta = {
  id: string; // 8-char hex store id (used for delete)
  label: string; // human label, e.g. "multica CAPO-123 done"
  url: string | null; // public delivery URL (https://bui.useronda.com/hook/<token>)
  unsigned: boolean; // true = no HMAC signature required (discouraged)
  sessionID: string | null; // the session this hook wakes
  instructions: string; // standing directive prepended to each delivery
  createdAt: number | null;
  lastDeliveredAt: number | null; // ms epoch of the last successful delivery
  deliveries: number; // total deliveries
};

// A durable scheduled-prompt job (bui-server store: ~/.bui-mobile/schedule.json).
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

// main → renderer push when a file is detected in the remote ~/.bui-outbox/.
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
  // tmux/project session inferred from the outbox subdir (~/.bui-outbox/<session>/…),
  // or null when the file was dropped at the outbox root.
  sessionName: string | null;
  // True when allowAgentPush was on and main already pulled the file.
  autoPulled: boolean;
  // Saved local absolute path — only set when autoPulled is true.
  localPath?: string;
};

// ----- Setup probe / bootstrap -----

// One probe check. `ok=true` means the prerequisite is satisfied;
// `detail` is a short human-readable line (version string when ok,
// failure reason or next-step hint when not).
export type ProbeCheck = {
  name: "ssh" | "tmux" | "opencode" | "opencodeAuthPlugin" | "anthropicAuth";
  ok: boolean;
  detail: string;
};

export type ProbeResult = {
  checks: ProbeCheck[];
  // Composite: true iff every check passed. Renderer uses this to flip
  // the wizard from "needs attention" to "ready".
  allOk: boolean;
};

export type BootstrapResult = {
  ok: boolean;
  // Per-step log lines, suitable for showing to the user in a <pre>.
  // Includes successes ("✓ opencode 0.9.1 installed") and failures
  // ("✗ Anthropic auth: run `opencode auth login anthropic` on the
  // remote"). Order is execution order.
  log: string[];
};

// ---- opencode message + part types (subset for Phase 1) ----
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
