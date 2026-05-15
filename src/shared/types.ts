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
  // Local port forwarded to the remote `opencode serve` instance for chat-mode
  // windows. Defaults to 14096 to avoid colliding with a user's local opencode
  // running on 4096.
  opencodePort?: number;
  // "Trust" / auto-allow mode for chat-mode windows. When true, the main
  // process auto-replies "always" to every opencode permission.asked event,
  // so tool calls run without prompting. Closest analog to Claude Code's
  // --dangerously-skip-permissions. Off by default.
  chatAutoAllow?: boolean;
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

  // Drag-and-drop file upload to a per-session remote tmp dir
  uploadFiles: "upload:files",
  // Clipboard-paste upload: send raw bytes from the renderer (e.g. a PNG from
  // the system clipboard) → main writes a temp file → scp to remote.
  uploadBuffer: "upload:buffer",

  // Click-to-peek: pull a remote file local + open in default app
  peekRemoteFile: "peek:remote-file",
  // Open a URL in the user's default browser
  openExternal: "shell:open-external",

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

  // ---- opencode chat-mode ----
  // Fetch full transcript for a session id (one-shot HTTP call on the remote).
  opencodeMessages: "opencode:messages",
  // Live SSE stream from opencode, forwarded raw to the renderer. Renderer
  // filters by sessionID in the event payload.
  opencodeEvent: "opencode:event",
  // Send a user prompt to a session. Returns when the server has accepted
  // the message (immediate); the assistant response streams via opencodeEvent.
  opencodePrompt: "opencode:prompt",
  // Interrupt the running generation for a session.
  opencodeAbort: "opencode:abort",
  // Permission approval flow — tools like Write/Edit/Bash pause until a reply.
  opencodePermissions: "opencode:permissions",
  opencodePermissionReply: "opencode:permission-reply",
  // Model picker: list available models on the remote opencode server (with
  // provider secrets stripped before forwarding).
  opencodeModels: "opencode:models",
  // What opencode would use if prompt_async were called without a model.
  opencodeDefaultModel: "opencode:default-model",
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
} as const;

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
export type OpencodeCommand = {
  name: string;
  description?: string;
  source?: string;        // "command" | "project" | "global"
  argumentHint?: string;
  agent?: string;
  model?: string;
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
