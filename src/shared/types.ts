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
} as const;
