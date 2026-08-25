// Type-only, erased at compile time (preloadAccess.ts does the same).
import type { PreflightResult, PreflightFailure } from "../main/installer/preflight.js";
import type { HostFingerprint } from "../main/installer/fingerprint.js";
import type { SshTarget } from "./sshTarget.js";

// ----- Local app config -----
// Source of truth for sessions/windows is tmux on the remote. We only persist
// per-project UI metadata locally (defaultCwd, eventually color/sort/etc).

export type ProjectMeta = {
  tmuxSession: string; // == project name (and the tmux session name on the remote)
  defaultCwd: string;
};

// A forge object reference — the minimal "what is this session about" pointer
// used by the session-link field. `repoKey` is the canonical `host/owner/repo`
// join key from src/shared/forge.mjs (`repoKey()`); `number` is GitHub
// `number` / GitLab `iid`.
export type SessionLinkRef = {
  repoKey: string;
  number: number;
};

// The link field on a session record. Either slot may be absent.
export type SessionLink = {
  issue?: SessionLinkRef;
  pr?: SessionLinkRef;
};

export type AppConfig = {
  projects: ProjectMeta[];
  // ----- HTTP/relay transport (M6 onboarding, BET-49) -----
  // Base URL of the manta-server the desktop pairs with, e.g.
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
  // plaintext like other manta credentials. When set, transport mode is "http".
  // Absent/empty on legacy SSH configs (which keep using `host`).
  boxToken?: string;
  // True once the user explicitly skipped the onboarding flow, so it doesn't
  // re-trigger on every launch of an otherwise-empty config (no host, no
  // boxToken, no projects). Re-runnable from Settings ("Run setup again").
  // Default false / absent.
  onboardingSkipped?: boolean;
  // ----- Agent → laptop file push (outbox) -----
  // The reverse of drag-and-drop upload: the remote AI drops a file into
  // `~/.manta-outbox/` and the desktop downloads it to the Mac over the direct
  // HTTPS connection (BET-1156 — the download runs through /api/download in
  // main, writing to downloadsDir; the old ssh/scp pull model is gone).
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
  // BET-427: hours a dragged-in upload's per-batch dir survives on the box
  // before the hourly server-side sweep deletes it. Box-server config key
  // (the box is a persistent systemd service; the desktop is often offline,
  // so the cleanup poller runs on the box and reads box config). Rides the
  // generic configGet/configUpdate channel like every other AppConfig field.
  // `0` disables cleanup (keep everything). Default 24. See
  // src/server/uploads.mjs `startUploadCleanupPoller`.
  uploadCleanupHours?: number;
  // BET-834: hours a voice note's AUDIO survives on the box before the sweep
  // (voiceNotes.mjs `startVoiceSweep`) deletes the file. The transcript and
  // waveform outlive the audio — after expiry the record stays with
  // `audioAvailable:false`. `0` keeps the audio forever. Default 168 (7 days).
  // Rides the same generic configGet/configUpdate channel as other fields.
  voiceNoteTtlHours?: number;
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
  // BET-246: when true, every new chat session (window) auto-creates a
  // sibling git worktree next to the project's repo root, named after the
  // session. The window's `cwd` is set to the new worktree so the AI
  // starts on its own branch. Per-session override available in the
  // new-session dialog (defaults to this value). Only honored when the
  // project's cwd is inside a git repo — otherwise the override is
  // disabled and ignored. Settings-only — no IPC channel of its own,
  // rides the generic configUpdate path.
  worktreePerSession?: boolean;
  // BET-246: when true, closing a chat session that has a MantaUI-created
  // worktree removes the worktree (and best-effort deletes its branch)
  // first. Safe-by-default: a dirty checkout prompts the user before
  // `--force`. Global only (no per-session override). Tracked per-window
  // via the `@manta-worktree-path` tmux user-option — never cleans
  // pre-existing worktrees or the main checkout. Settings-only — rides
  // the generic configUpdate path.
  worktreeCleanOnClose?: boolean;
  // Auto-rename chat-mode tmux windows from the conversation. When true,
  // ChatPanel periodically (every Nth user turn) asks opencode to summarize
  // the recent transcript into a 1-2 word title and renames the window via
  // tmuxRenameWindow. Uses a throwaway opencode session (the user's own model;
  // no Groq key needed). ALWAYS overwrites the current name, including names
  // set by hand — so it's OFF by default and opt-in via Settings. See the
  // "Auto-rename" notes in AGENTS.md.
  autoRenameSessions?: boolean;
  // BET-738: show the composer's usage dial even when every window is under
  // the dial's normal 70% threshold. Off by default — the dial's whole point
  // is to be absent unless it matters; this is the opt-out for someone who
  // wants the ambient meter anyway. Settings-only, rides configUpdate.
  alwaysShowUsage?: boolean;
  // BET-782: ids of session-header status items the user has permanently
  // hidden. An id in this array is never rendered, in the header bar or its
  // overflow dropdown. Absent/empty = every registry item is shown. No
  // Settings UI in BET-782 — the field being respected is the deliverable;
  // later issues add the toggle. Rides the generic configGet/configUpdate
  // channel like every other AppConfig field.
  hiddenStatusItems?: string[];
  // BET-789: the one-line "Connect GitHub…" offer under the session header
  // has been permanently dismissed. Per-box boolean; absent = never shown yet
  // (offer appears while the forge is disconnected in a forge-origin session).
  // Rides the generic configGet/configUpdate channel like every other
  // AppConfig field.
  forgeConnectOfferDismissed?: boolean;
  // BET-942: set by Settings → Forge → Disconnect. While true the box's forge
  // credential ladder resolves nothing, even if the gh CLI / env var / stored
  // secret would match. Cleared by a successful device sign-in. Rides the
  // generic configGet/configUpdate channel like the field above.
  forgeDisconnected?: boolean;
  // Global default model for all new and cleared chat sessions. Stored as
  // { providerID, modelID } so the per-session localStorage override and
  // this setting use the same shape. When absent, opencode picks its own
  // default (the first connected provider's default model).
  defaultModel?: { providerID: string; modelID: string };
  // Per-model display overrides (name / description / context size), keyed by
  // "providerID/modelID". Drafted in Settings → Models → edit and applied
  // server-side by listModels() when models are fetched, so the settings
  // table AND the composer model picker both reflect a change on the next
  // load. Stored in config.json like every other AppConfig field. Absent = no
  // display overrides.
  modelOverrides?: Record<string, ModelOverride>;
  // Extra skill registry URLs written to the remote opencode.jsonc as
  // skills.urls. The default registry (https://antoinedc.github.io/manta-skills)
  // is always prepended by the binary once the upstream PR lands; these are
  // user-added extras. Empty array = no user-added registries.
  skillRegistryUrls?: string[];
  // BET-123: models the user has explicitly deactivated from the "every
  // model is auto-registered as a subagent" reconciliation. Entries are
  // "providerID/modelID" strings. A model in this set never gets an
  // opencode.jsonc `agent` block written for it (and any existing block is
  // removed on the next sync) — deactivation is manta-side state, NOT opencode
  // config, so a deactivated model isn't silently re-added on the next
  // reconcile. Reuses the plain configGet/configUpdate channels like every
  // other AppConfig field — no dedicated IPC channel needed. Absent/empty =
  // every known model is registered.
  deactivatedSubagents?: string[];
  // BET-215: models the user has explicitly hidden from the chat main-agent
  // picker. Same shape and opt-out semantics as `deactivatedSubagents` — a
  // model whose "providerID/modelID" key is in this set is filtered out of
  // `ModelPicker`'s groups chokepoint. Unlike subagents, main-availability
  // is purely renderer-side state (there is no opencode.jsonc write) — no
  // reconcile flow. The Default radio in the Settings → AI → Models table
  // disables itself for any row whose Main toggle is off, and turning Main
  // off on the current defaultModel clears defaultModel in the same save
  // (a default must be Main-available). Absent/empty = every known model
  // is selectable as the chat main agent.
  deactivatedMainModels?: string[];
  // BET-1139: models the user has EXPLICITLY opted back in to despite being
  // deprecated (status === "deprecated"). Same shape as `deactivatedMainModels`
  // — "providerID/modelID" strings. A deprecated model is disabled by default
  // in the main picker and skipped by subagent auto-registration; the user's
  // opt-in (persisted here via the generic configGet/configUpdate channels,
  // no new IPC/plumbing) flips both back on for THAT model. Absent/empty =
  // every deprecated model stays disabled. Do NOT conflate with the
  // deactivated sets — those hide/remove; this ENABLES a deprecated default.
  optInModels?: string[];
  // Anthropic prompt cache TTL. Used ONLY to predict when a chat session has
  // gone stale (cache expired → the next user turn re-bills the entire cached
  // prefix as cache_creation_input_tokens at full rate + surcharge). manta
  // does NOT set `cache_control.ttl` on any request.
  //
  // DEFAULT IS "5m" BECAUSE THAT IS WHAT OPENCODE ACTUALLY SENDS, MEASURED —
  // not a preference. opencode's applyCaching() stamps its cache breakpoints
  // `{type:"ephemeral"}` with NO ttl field, so Anthropic applies its default
  // 5-minute TTL. Verified on the wire against /v1/messages (1.18.22): the
  // response's `usage.cache_creation` put every created token in
  // `ephemeral_5m_input_tokens`, with `ephemeral_1h_input_tokens` at 0.
  // The previous "1h" default was a guess, and it silently under-warned for
  // every idle gap between 5 and 60 minutes: the pill read "warm" while the
  // user was in fact paying a full cache re-write on their next message.
  //
  // "1h" remains selectable for a box whose requests are rewritten in front
  // of opencode (a proxy or a future opencode that exposes a TTL knob) — it
  // makes the prediction match that setup. On a stock box it is wrong; see
  // AGENTS.md "Stale prompt-cache" for the upstream gap and the one config
  // path that does change the wire TTL (and why it is not wired to this).
  cacheTtl?: "5m" | "1h";
  // Internal marker (NOT a Settings entry): set once the box has rewritten a
  // persisted `cacheTtl: "1h"` — the old, never-true default — to "5m". Its
  // whole job is to make that correction one-time, so a user who deliberately
  // re-selects "1h" afterwards keeps it. See migrateCacheTtlDefault in
  // shared/configMigration.mjs.
  cacheTtlDefaultMigrated?: boolean;
  // ----- Voice / speech-to-text (Groq) -----
  // API key for api.groq.com. Stored plaintext in config.json, same as other
  // manta credentials (ssh identity path, opencode auth). Settings UI shows
  // a masked password input. Absent → mic button is hidden in the UI.
  groqApiKey?: string;
  // ----- On-call CTO (BET-1166) -----
  // OpenAI API key for the Realtime voice transport. Stored on the box (like
  // groqApiKey) and never reaches the renderer — the call window relays audio
  // through the box's /call WS. Absent → the call window can't start a call.
  openaiApiKey?: string;
  // ----- Analytics (BET-217) -----
  // When true (the default), this instance ships console.* output + a handful
  // of structured events to Axiom for remote debugging. When false, the
  // desktop renderer AND the server ship nothing (resolveAxiomConfig returns
  // null). Credentials are build-time / env only — no longer user config.
  // Mobile always ships regardless of this flag. Absent → treated as true.
  shareAnalytics?: boolean;
  // Whisper-family transcription model. Default
  // "whisper-large-v3-turbo" balances latency (~200-500ms for short clips)
  // and accuracy. Override only if you have a reason (e.g. larger-v3 for
  // non-English content where turbo regresses).
  voiceTranscriptionModel?: string;
  // ----- Plugins (BET-183 / BET-185 / BET-190) -----
  // Master switch for the Mac-side plugin executor (capExecutor.ts). When
  // true, this Mac subscribes to manta-server's SSE bus and runs the YAML
  // plugins it finds under ~/.manta/plugins/. Default false (OFF) — toggling
  // takes effect on next app launch. Trust boundary: plugins are user-
  // authored YAML files; each step runs an arbitrary shell command with the
  // user's UID, so the user MUST vet every plugin they install.
  pluginsEnabled?: boolean;
  // ----- Forge rules (BET-797) -----
  // Master switch for the box-side forge event loop. When true, the box can
  // register per-repo webhooks (under ~/.manta/forge-rules/) and ingest forge
  // deliveries. Default false (OFF) — a stale or whimsical toggle change must
  // never quietly voice an agent. Same posture as `pluginsEnabled` and sits
  // alongside it in Settings. With it off the subsystem is dormant: no
  // registration, no ingest routing, no dispatch.
  forgeRulesEnabled?: boolean;
  // BET-409: colour theme. "system" (default) follows the OS prefers-color-scheme
  // media query and re-themes live when it changes; "light"/"dark" pin the theme.
  // Resolved in src/renderer/main.tsx (data-theme on <html>) and live-managed by
  // src/renderer/theme.ts. Settings → General exposes the three options; sub-issue
  // 14 relocates the control. Rides the generic configGet/configUpdate path — no
  // dedicated IPC channel. Absent → "system".
  theme?: "system" | "light" | "dark";
  // BET-414: sidebar pinned windows. Each entry is a stable window id of the
  // form `<tmuxSession>/<windowIndex>` (see windowPinId in chatUtils.ts). The
  // pinned section at the top of the rail renders these rows above the
  // workspace groups; the same row is excluded from its workspace group so it
  // isn't shown twice. Unlimited; stale ids (window killed) are pruned at
  // render. Rides the generic configGet/configUpdate path — no dedicated IPC
  // channel. Absent/empty = no pins.
  pinnedWindows?: string[];
  // ----- On-call CTO (BET-1164) -----
  // The "on-call CTO" feature: a deterministic read-only tool belt (the `cto`
  // engine's dispatch surface) surfaced as an opencode agent + voice window.
  // This issue (1/3) wires ONLY `enabled`; the rest of the shape is defined
  // now (with the engine/store) so the later issues (2 = inbound feed, 3 =
  // call window + voice) just plumb through fields already agreed. Absent =
  // the whole feature off.
  cto?: {
    // Master switch. False (the default) until the feature is shipped — with
    // it off the box never registers the `cto` agent nor wires the engine.
    enabled?: boolean;
    // Transport for voice narration of tool boundaries (Issue 3). "realtime"
    // (default) = the eventual walkie-talkie transport; "groq" = TTS via Groq.
    transport?: "realtime" | "groq";
    // The model the `cto` agent runs on (Issue 3). Absent → opencode default.
    model?: string;
    // Voice/narration model id (Issue 3).
    voice?: string;
    // Tool names the user has allowed to run without narration/confirm
    // (Issue 2, the inbound feed's trusted set). Absent/empty = none trusted.
    trustedActions?: string[];
    // Whether the call window listens continuously (Issue 3). Default false.
    alwaysListening?: boolean;
  };
  // ----- Manta Optimizer (BET-1342 / Phase 2) -----
  // Master switch for the optimizer. DEFAULT FALSE. Opt-in: with it OFF the
  // optimizer changes nothing. It does NOT gate Automatic Manta Routing —
  // routing is gated per-conversation by the composer's model picker
  // (modelRouting.preset stays pinned at "balanced" regardless of this flag).
  // The switch being ON changes NO behaviour until the actuation stages land.
  optimizerEnabled?: boolean;
  // ----- Model routing (BET-1215) -----
  // Manta picks the model for a conversation while Auto is on (the per-session
  // gate). Config carries the balance dial; the Auto on/off switch is the
  // composer's model picker, never this block.
  modelRouting?: {
    // Three-way balance dial. Default "balanced".
    preset: "economy" | "balanced" | "performance";
    // Per-agent tier override (config-only — no UI builds this). Absent /
    // partial = fall back to the preset's tier table.
    perAgent?: Record<string, "fast" | "balanced" | "deep">;
    // Per-endpoint identity + price declared by the user. Key: "providerID/modelID".
    declaredModels?: Record<
      string,
      {
        catalogId?: string;
        price?: { input: number; output: number } | "free";
        caches?: false | { read?: boolean; write?: boolean };
      }
    >;
  };
  // Position/size of the floating on-call CTO window (BET-1166). Persisted so
  // the window remembers where the user parked it across runs.
  callWindowBounds?: { x?: number; y?: number; width: number; height: number };
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
  // BET-246: absolute path of the worktree MantaUI auto-created for this
  // window (stamped as `@manta-worktree-path`). Null when the window has no
  // manta-owned worktree (e.g. a legacy window, or one created without the
  // checkbox). Clean-on-close gates on this field being set + non-null —
  // a pre-existing worktree is never identified by this stamp, so the
  // renderer can safely remove ONLY what manta created.
  worktreePath?: string | null;
};

export type TmuxSession = {
  name: string;
  attached: boolean;
  windows: TmuxWindow[];
  // BET-348: true iff this session was created by Manta (recorded in the
  // `~/.manta/tmux-sessions.json` sidecar). When false, the session pre-
  // existed on the box (the user started it in their own terminal before
  // opening Manta), and the renderer's Terminal layer attaches via
  // `tmux attach-session -t <session>:<windowIndex>` instead of spawning
  // a fresh shell. Absent / undefined → unknown / pre-sidecar build —
  // treated as false by the renderer (safe default: pre-existing window
  // can be attached; a brand-new session won't be misclassified since
  // the renderer never sees a project before the sidecar entry exists).
  mantaOwned?: boolean;
};

// ----- Derived view used by the UI -----

export type Project = {
  tmuxSession: string;        // also the display name
  defaultCwd: string;         // from local meta, or "~" if unknown
  windows: TmuxWindow[];
  attached: boolean;
  // BET-348: mirror of TmuxSession.mantaOwned. See TmuxSession for the
  // contract — same field, propagated through the server→renderer
  // listing so the renderer can decide between `ptySpawn` with a
  // tmuxTarget (pre-existing tmux window) and without (Manta-created
  // window, spawn a fresh shell/launcher). False / absent means
  // "not Manta-owned" — safe because the renderer treats both the
  // unknown and the known-false cases the same way.
  mantaOwned?: boolean;
};

// Return shape of the tmux:new-session / tmux:new-window RPCs. Carries the
// newly-created window's identity (sessionId + windowIndex) so the caller can
// navigate + send the first prompt to the RIGHT window — instead of
// re-locating it by name, which mixed new sessions up with existing ones on
// name collisions. `projects` is the refreshed listing.
export type TmuxCreateResult = {
  sessionId: string | null;
  windowIndex: number;
  projects: Project[];
};

export type TmuxConfigStatus = {
  mantaManaged: boolean;   // ~/.tmux.conf currently has manta's config
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

// One entry in a directory listing from fsListDirs. All paths are absolute —
// no tilde ever crosses the RPC boundary in either direction (BET-1072).
export type DirEntry = {
  /** Directory basename, e.g. "projects". */
  name: string;
  /** Absolute path, e.g. "/home/dev/projects". */
  path: string;
  /** True when `name` starts with "." — the renderer filters on this. */
  hidden: boolean;
};

export type DirListing = {
  /** The absolute directory that was actually listed (input, tilde-expanded). */
  dir: string;
  /** Every subdirectory of `dir`, sorted by name. Never truncated. */
  entries: DirEntry[];
};

// BET-786: one entry in a repo-probe result. `forge` is the normalised forge
// kind ("github" | "gitlab") from detectForge, null when there is no origin or
// the host is unrecognised; `repoKey` is the canonical `host/owner/repo` key.
export type RepoHit = {
  path: string;                 // absolute path of the repo dir on the box
  name: string;                 // basename of the repo dir
  branch: string | null;        // current branch (null if detached / non-branch)
  originUrl: string | null;     // `git remote get-url origin`, null if none
  forge: string | null;         // "github" | "gitlab" | null
  repoKey: string | null;       // `host/owner/repo` join key | null
  lastCommitAt: number | null;  // mtime ms of .git/HEAD (approximate, for sort)
};

// BET-786: the gh CLI status probed from the box. Presence + identity only —
// never a token.
export type ForgeCliStatus = {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
};

// BET-786: the forge:probe RPC result. `partial` is true when the scan hit its
// time-box or result cap, so the renderer knows it may be showing an
// incomplete list.
export type ForgeProbeResult = {
  repos: RepoHit[];
  cli: ForgeCliStatus;
  partial: boolean;
  // The box's $HOME, so the renderer can render a repo under it as `~/...`
  // instead of the absolute path. null when not provided (renderer degrades
  // to the absolute path).
  homeDir: string | null;
};

// ----- Forge clone flow (BET-796) -----

// A normalised repo the clone picker ([S6]) can push to, from the adapter's
// listMyRepos. `pushedAt` is a millis timestamp (most-recently-pushed first).
// NO credential fields ever ride this shape — the renderer only needs the
// clone URL, which git uses box-side.
export type ForgeRepo = {
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  pushedAt: number | null;
  defaultBranch: string;
  cloneUrl: string;
  url: string;
};

// The GitHub device grant ([S5]) — RENDERER-SAFE by construction: `device_code`
// is the one field that is deliberately ABSENT. `user_code` is what the user
// enters on github.com/login/device; `grantId` is an opaque server-side handle
// the renderer echoes back to poll/cancel. Values are in seconds.
export type ForgeDeviceGrant = {
  grantId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  pollInterval: number;
};

export type ForgeDeviceStartResult =
  | { connected: true; grant: null }
  | { connected: false; grant: ForgeDeviceGrant; error: null }
  // The box's DEVICE_CLIENT_ID is a placeholder/unset (BET-849) — the device
  // flow would dead-end at GitHub, so the renderer shows a clear "not
  // configured" state instead of launching a guaranteed-failing screen.
  | { connected: false; notConfigured: true; grant: null };

export type ForgeDevicePollResult =
  | { status: "pending"; pollInterval: number }
  | { status: "done" }
  | { status: "expired" }
  | { status: "error"; error: string };

export type ForgeRepoListResult = {
  repos: ForgeRepo[];
  stale: boolean;
  error: string | null;
};

export type ForgeCloneStatus = {
  id: string;
  name: string;
  url: string;
  dest: string;
  percent: number;
  bytes: number;
  done: boolean;
  ok: boolean;
  error: string | null;
  cancelled: boolean;
};

// ----- Forge read path (BET-788) -----

// The normalised CI traffic-light — the same tri-state the shared
// forge.mjs `rollupChecks` produces ("green" | "yellow" | "red" | "none").
// Drives logic (can I merge); the raw per-check list is kept separately for
// display.
export type CheckRollup = "green" | "yellow" | "red" | "none";

// A normalised pull-request, reconciled from a raw forge payload at the
// adapter boundary. `mergeable` is null while the forge is still computing
// it (caller retries — GitHub's `mergeable` is exactly that tri-state).
// `mergeBlockedReason` is a short human string ("checks failing", "conflicts",
// "review required", "draft") or null. `state` is the normalised four-value
// enum: "draft" | "open" | "merged" | "closed".
export type PullRequest = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  author: string;
  reviewers: string[];
  mergeable: true | false | null;
  mergeBlockedReason: string | null;
  unresolvedThreads: number;
};

// A normalised check run (GitHub `check-runs`) or legacy commit status,
// merged into one display-friendly array by the adapter. `conclusion` absent
// (undefined) = still running / pending; `status` is the raw GitHub
// status field for check-runs ("queued" | "in_progress" | "completed").
export type ForgeCheckRun = {
  name: string;
  status?: string;
  conclusion?: string;
  url?: string;
};

// forge:status result — presence + identity ONLY, never a token. `connected`
// is true when the box can resolve a forge token (gh CLI or a stored secret);
// `login` is the non-secret gh login when available; `kind` is the forge the
// resolved token authenticates to ("github" — the only adapter today);
// `source` is the §3.3 ladder rung the box's credential came from
// ("cli" | "env" | "stored") so Settings can say where the token came from.
export type ForgeStatusResult =
  | {
      connected: true;
      login: string | null;
      kind: "github";
      source: "cli" | "env" | "stored" | null;
      /** null = not probed; true = probed and accepted; false = probed and
       *  rejected (only reachable for a `gh` CLI / env credential — a rejected
       *  stored credential is cleared, so it reports `connected: false`). */
      valid: boolean | null;
    }
  | { connected: false };

// forge:rules-list result — one row per repo with a box-side rules file,
// INCLUDING invalid ones (a rules file that silently fails to load is worse
// than one that loudly refuses). `error` is the validator's message verbatim.
export type ForgeRuleRow = {
  repoKey: string;
  valid: boolean;
  error?: string;
  ruleCount?: number;
};

// forge:disconnect result — clears the box-side forge credential cache.
export type ForgeDisconnectResult = { ok: boolean };

// forge:pull-request result — the normalised PR + its CI for a session cwd.
// `pr` is null (not an error) when the repo has no open PR. `rollup` is the
// traffic-light over `checks`. `stale` is true when any part was served from
// last-known state because the forge was unreachable / rate-limited while the
// box honours its cooling period. `error` distinguishes a repo that isn't a
// known forge ("no_forge") from one the box isn't authenticated to
// ("not_connected") from a plain "no PR" (`error: null`, `pr: null`).
export type ForgePullRequestResult = {
  pr: PullRequest | null;
  checks: ForgeCheckRun[];
  rollup: CheckRollup;
  stale: boolean;
  error: "no_forge" | "not_connected" | null;
  // Branch state for the ship gate (BET-892), so the forge surface can decide
  // whether a "Create pull request" action even makes sense BEFORE anything is
  // clicked. `base` is the repo default branch (resolved box-side), `aheadCount`
  // is commits ahead of `origin/<base>` (null when unknown / not fetched).
  branch: string | null;
  base: string | null;
  aheadCount: number | null;
};

// A normalised forge review thread (the review pane's "incoming thread").
// Position anchor is forge-neutral — `path`/`line`/`side`, plus `startLine` for
// a multi-line comment. `side` is the forge's word ("LEFT"/"RIGHT" on GitHub);
// the renderer maps it onto the old/new line it renders. `resolved` is read
// (never written — GitHub resolving is GraphQL-only). `comments` is the
// top-level comment followed by its replies, in posting order.
export type ForgeThread = {
  id: string;
  path: string | null;
  line: number | null;
  side: string | null;
  startLine?: number | null;
  resolved: boolean;
  comments: { author: string; body: string; createdAt: string | null }[];
};

// The target of a forge read/write. Either the session's `cwd` (resolved
// box-side to the open PR on the current branch) or an explicit cross-repo
// inbox PR — `repoKey` (host/owner/repo) + `number` (BET-850). The inbox
// "Open review" row action addresses the review pane this way when the PR is
// not the current session's (it may live in a repo the box has not cloned).
export type ForgeRefTarget =
  | { cwd: string }
  | { repoKey: string; number: number };

// forge:diff result — the review pane's read for a session cwd. `diff` is the
// RAW unified diff text consumed verbatim by UnifiedDiff; `threads` are the
// incoming forge threads; `headSha` is the PR head the diff was fetched at (so
// a draft comment keys to the reviewed revision). `error` is "no_forge" for a
// non-github repo, "not_connected" for a box with no token, "no_pr" for a repo
// with no open PR, and null on success.
export type ForgeDiffResult = {
  diff: string;
  threads: ForgeThread[];
  headSha: string;
  stale?: boolean;
  error: "no_forge" | "not_connected" | "no_pr" | null;
};

// ----- Work inbox (BET-795) -----

// Why an item is in the inbox. This is the value the row's secondary column
// largely spells out (the label mapping lives in chatUtils.inboxReasonLabel),
// and it is what the row ultimately displays.
export type InboxReason = "assigned" | "review requested" | "checks failing";

// One cross-repo work-inbox row. Three populations, one list: issues assigned
// to you, PRs awaiting your review, your own open PRs whose checks are red.
// `repoKey` is host/owner/repo (the join key). `rollup` is the CI traffic-light
// for a PR row (the checks-red population's reason to be here); "none" for an
// assigned issue. `reason` is the population that claimed it — the merge rule
// gives a PR matching two queries its more urgent reason.
export type ForgeInboxItem = {
  kind: "issue" | "pr";
  repoKey: string;
  number: number;
  title: string;
  url: string;
  state: string;
  rollup: string;
  updatedAt: number;
  reason: InboxReason;
  // The seeded first prompt for "Start a session" — built box-side from the
  // single INBOX_SEED_PROMPT constant so the renderer never constructs its own
  // "Complete {{url}}" copy (one default, not two).
  seed: string;
};

// forge:inbox result. `items` are sorted by updatedAt desc. `error` is
// "not_connected" when the box has no GitHub token (items empty) or null.
// `stale` is true when any population was served from last-known state.
export type ForgeInboxResult = {
  items: ForgeInboxItem[];
  stale: boolean;
  error: "not_connected" | null;
};

// ----- Forge write path (BET-794) -----

// forge:ship input — push the current branch then (only after the renderer's
// human confirm card) open a pull request. The PR base is the forge-resolved
// repo default branch — callers never supply one. PRs are always created as
// real (non-draft) pull requests (BET-892).
export type ForgeShipInput = {
  cwd: string;
  title: string;
  body?: string;
};

export type ForgeShipResult =
  | { ok: true; pr: PullRequest; url: string }
  | { ok: false; error: string };

// forge:ship-preview — the facts the confirm card needs BEFORE anything is
// pushed: the head branch, the base branch (PR target), a best-effort count
// of files changed on the branch, and a **resolved title + body** (design §4.5
// step 1) the confirm card displays as plain text (BET-892 — the title/body
// are edited on GitHub, not in the card). The body honours the repo's PR
// template when one exists.
//
// BET-893: when the caller supplies the session's selected `model` (and the
// calling `sessionId` for transcript context), the box generates the title +
// body with that model OUT OF BAND — a throwaway opencode session, never the
// user's own conversation. With no model, the box falls back to the
// deterministic draft (tip-commit title / template-or-files body).
export type ForgeShipPreviewInput = {
  cwd: string;
  model?: { providerID: string; modelID: string };
  sessionId?: string;
};

export type ForgeShipPreviewResult =
  | { ok: true; head: string; base: string; fileCount: number; title: string; body: string }
  | { ok: false; error: string };
// forge:merge input — ALWAYS passes the head SHA the user approved so the API
// cannot merge a commit that landed after the reviewed diff (issue §4).
export type ForgeMergeInput = {
  cwd: string;
  number: number;
  method?: string;
  sha: string;
};

// The distinguished merge-failure kind — status codes, not messages:
// `sha_mismatch` (409: the head SHA moved), `cannot_merge` (405: branch
// protection / draft / conflict), `permission` (403), or a raw `http_N`.
export type ForgeMergeFailureKind =
  | "sha_mismatch"
  | "cannot_merge"
  | "permission"
  | string;

export type ForgeMergeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; kind: ForgeMergeFailureKind | null };

// ----- Forge draft review (BET-793) -----

// A box-buffered draft review comment. The anchor is forge-neutral — the same
// `{ path, line, side }` the review pane's diff gutter uses, plus `startLine`
// for a multi-line highlight. `side` is the renderer's "new"|"old"|"both":
// adapted → new, removed → old, unchanged context line → both (the renderer's
// gutter emits "both" for a line present in both versions, so GitLab can
// position it with both `new_line` and `old_line` — BET-856). The adapter maps
// it onto the forge's word ("RIGHT"/"LEFT" on GitHub). `body` is the typed
// comment text. The old GitHub `position` field is deliberately never used.
export type ForgeDraftComment = {
  id: string;
  path: string;
  line: number;
  side: "new" | "old" | "both";
  startLine?: number | null;
  body: string;
};

// The box-buffered draft for one PR (spec §3.4①). `verdict` is the pending
// review verdict — the shared ReviewVerdict subset a draft can hold, null until
// chosen. `stale` is true when the PR head moved past the SHA the draft anchored
// to: the content is KEPT (never discarded), the renderer warns.
export type ForgeDraft = {
  key: string;
  repoKey: string;
  number: number;
  headSha: string;
  verdict: "approved" | "changes_requested" | "commented" | null;
  body: string;
  comments: ForgeDraftComment[];
  stale: boolean;
  updatedAt: number;
};

// forge:draft-get result — the current draft for a session's PR (null when none).
export type ForgeDraftGetResult = {
  draft: ForgeDraft | null;
  error: "no_forge" | "not_connected" | "no_pr" | null;
};

// forge:draft-comment input — `op` selects add / edit / delete of one comment
// or set-verdict on the draft. `comment` carries the anchor + body for
// add/edit, and the comment id for edit/delete. Fields are intentionally loose
// (optional) — which subset is required depends on `op`, and the box validates
// the payload per op rather than encoding it in the transport type.
export type ForgeDraftCommentInput = {
  op: "add" | "edit" | "delete" | "set-verdict";
  comment?: {
    id?: string;
    path?: string;
    line?: number;
    side?: "new" | "old" | "both";
    startLine?: number | null;
    body?: string;
  };
  verdict?: "approved" | "changes_requested" | "commented" | null;
  body?: string;
} & ForgeRefTarget;

export type ForgeDraftCommentResult =
  | { ok: true; draft: ForgeDraft }
  | { ok: false; error: string };

// forge:draft-submit input + result. Submitting flushes the WHOLE draft as one
// review; the draft is cleared only on success. A failed submit returns a typed
// `kind` (e.g. "http_422") and leaves the draft intact.
export type ForgeDraftSubmitInput = {
  verdict?: "approved" | "changes_requested" | "commented" | null;
  body?: string;
} & ForgeRefTarget;

export type ForgeDraftSubmitResult =
  | { ok: true }
  | { ok: false; error: string; kind?: string | null };

// forge:thread-reply input + result. A reply targets ONE existing incoming
// thread and posts immediately — it is never buffered in the draft, which
// batches new line comments only.
export type ForgeThreadReplyInput = {
  threadId: string;
  body: string;
} & ForgeRefTarget;

export type ForgeThreadReplyResult =
  | { ok: true }
  | { ok: false; error: string };


// ----- IPC inputs -----

// BET-138: the pty is a shell-in-cwd (or, for a launcher mode, an AI CLI TUI
// like `claude`) spawned directly in a chat session's working directory — NOT
// a tmux attach. `sessionKey` is the caller-composed
// `${opencodeSessionId}:${modeId}` (modeId = "terminal" or a launcher id from
// src/server/launcherRegistry.mjs) so Terminal mode and each TUI launcher
// mode of the same chat session get independent, kept-warm PTYs.
//
// BET-346: when `tmuxTarget` is set, the server spawns `tmux attach-session
// -t <target>` instead — for a window Manta did NOT create (a pre-existing
// tmux session the user wants to view). Format is `<session>:<windowIndex>`,
// matching killWindow/selectWindow/renameWindow in src/server/tmux.mjs.
// `tmuxTarget` wins over `launcher` if both are supplied. Nothing sets this
// field yet; the renderer follow-up is a separate issue.
export type SpawnOptions = {
  sessionKey: string; // stable per-session-mode id: see comment above
  cwd: string;        // working dir for the shell/CLI (may be tilde-prefixed)
  cols: number;
  rows: number;
  // Present only for a TUI launch mode (absent = plain login shell).
  launcher?: { id: string; flags: Record<string, boolean> };
  // Present only when attaching to an existing tmux window (a window Manta
  // did not create). WINS over `launcher`. Server-only behavior today; the
  // renderer half to wire this through is the follow-up issue.
  tmuxTarget?: string;
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

// A desktop OS-notification directive, relayed from manta-server's notification
// router (push.mjs) to the desktop renderer over the -L 18787 forward + IPC.
// The renderer does the final "am I viewing this session right now?"
// suppression and shows it via the Notification API. See docs/manta-tools-notify.md.
export type DesktopNotifyPayload = {
  kind: string; // "permission" | "question" | "error" | "done" | "notify"
  title: string;
  body: string;
  sessionId: string | null;
  tag: string;
  urgent?: boolean;
};

// Payload for the server-update-available push (BET-225 stage 3). Published by
// the server-update poller (src/server/serverUpdate.mjs) on the manta-server bus
// as `{kind:"serverUpdateAvailable", payload: ServerUpdateAvailablePayload}`,
// relayed to the desktop renderer by src/main/serverUpdateForwarder.ts. The
// renderer's UpdateBar component renders a "Server update available: {version}"
// bar with an "Update & restart" button that calls `window.api.serverUpdateApply()`.
export type ServerUpdateAvailablePayload = {
  version: string;
  notesUrl: string | null;
};

// Result of an ON-DEMAND server update check (`server:update-check`). Unlike
// the push payload above this must be able to express "I looked and there is
// nothing", because it answers a button press: `available:false` with no
// version is a real, reportable answer, not a missing one.
//
// `ok` distinguishes that honest "no update" from a check that could not
// COMPLETE. The background poller deliberately swallows a manifest-fetch
// failure into `available:false` (a flaky feed must not crash the box), but
// that same value is `available:false` for "up to date" — so without `ok` the
// renderer would show the reassuring green "you're up to date" after a failed
// on-demand check. `ok:false` lets it render a failure instead. Absent on an
// old server it is treated as `true`.
export type ServerUpdateCheck = {
  available: boolean;
  version?: string;
  notesUrl?: string | null;
  ok?: boolean;
  // Box-side CLI update targets (BET-1096, stage 2 of the unified-update
  // epic). Absent on an older box that predates the CLI probe — consumers
  // must degrade to displaying just the fixed desktop + server targets.
  // `available` above keeps its EXACT original meaning (the box SERVER has an
  // update) — it is load-bearing for the existing poller, banner and push
  // dedup, and must not be redefined to include the CLIs.
  targets?: UpdateTarget[];
};

// Identity of one line in the unified update list (BET-1096). `desktop` and
// `server` are always present; the four CLIs (opencode / claude / codex / kimi)
// arrive from the box. `available` means an update exists AND we can apply it;
// `ok:false` means we could not determine the state — NEVER render that as
// "up to date". `manual` (no safe upgrade command, or a dev build with no
// updater) surfaces as a link, not a button.
export type UpdateTargetId =
  | "desktop"
  | "server"
  | "opencode"
  | "claude"
  | "codex"
  | "kimi";

export type UpdateTarget = {
  id: UpdateTargetId;
  label: string; // "Manta UI" | "The box" | "opencode" | "Claude Code" | "Codex" | "Kimi Code"
  current: string | null;
  latest: string | null;
  available: boolean; // an update exists AND we can apply it
  ok: boolean; // false = we could not determine. NEVER render as up to date.
  manual: boolean; // no safe upgrade command → link, not a button
  manualUrl?: string;
  disruption: "none" | "reconnect" | "ends-turns" | "app-restart";
};

// Result of an ON-DEMAND desktop update check (`autoUpdate:check`).
//
// `supported` is the third state that makes this honest. A dev/unpacked build
// has no updater at all (electron-updater refuses to run against an unsigned
// tree) and a mobile/web client has no desktop to update — in both cases the
// answer is "this question does not apply here", which must NOT be rendered as
// the reassuring "you are up to date". Conflating the two is how a broken
// updater passes for a healthy one.
export type DesktopUpdateCheck = {
  supported: boolean;
  available: boolean;
  version: string | null;
  /** Human-facing failure copy when the check itself could not complete. */
  error?: string;
};

// App-control bus envelope payload (BET-840/841). manta-server publishes ONE
// bus kind, `appControl`, with an `action` discriminator
// (src/server/appControl.mjs). The desktop renderer subscribes once
// (src/renderer/App.tsx) and switches on `action`. `providerID`/`modelID`
// ride the `switch-model` event; `name` rides `rename-session`. Client-
// agnostic by design so the native client can adopt the same bus kind later
// without a server change.
export type AppControlPayload = {
  action: string;
  sessionId?: string;
  providerID?: string;
  modelID?: string;
  name?: string;
};

// ── Bus routing-field casing contract (BET-1328) ─────────────────────────────
// The `media` and `widget` bus kinds both carry routing fields that key
// per-session placeholder state in the renderer: which session owns the box and
// which message produced it. Those fields use DIFFERENT casing on the wire:
//
//   media   → sessionID / messageID   (uppercase `ID`), src/server/media.mjs
//   widget  → sessionId / messageId   (lowercase `d`),  src/server/widgets.mjs
//
// The difference is real and deliberate per kind — the box spine publishes each
// kind in its own casing and the renderer reads exactly that casing. It is
// deliberately NOT normalised (a wire change would be breaking across server +
// clients), so THIS comment is the single source of truth for the routing-field
// names. Every payload type below, and every publisher / reader that emits or
// consumes routing fields, REFERENCES this contract rather than restating the
// naming. If you add a THIRD bus kind with routing fields, reference this
// contract too and type it to EXACTLY the casing the publisher emits — never
// copy the case off a sibling type, or you inherit that kind's casing by
// accident.
// ─────────────────────────────────────────────────────────────────────────────

// BET-1148: inline media bus events (src/server/media.mjs). ONE `media` bus
// kind with an `action` discriminator, published when the media tools land a
// client-visible effect:
//   begin — the model declared it will generate media (reserve the final box).
//   show  — the file exists; swap the media in (carries the box path + mime).
//   fail  — a `begin` was never followed by a `show` (orphan sweep); the
//           placeholder ends as a labelled failure.
// The renderer routes by (sessionID, messageID) and keys its per-session
// placeholder state on `messageID`. Client-agnostic so the native client can
// adopt the same bus kind later. Routing-field casing: upper `ID` per the
// shared contract above.
export type MediaEventPayload = {
  action: string;
  handle?: string | null;
  sessionID?: string | null;
  messageID?: string | null;
  kind?: "image" | "video" | null;
  width?: number | null;
  height?: number | null;
  aspectRatio?: number | null;
  count?: number | null;
  title?: string | null;
  path?: string | null;
  mime?: string | null;
  size?: number | null;
};

// Inline widgets (BET-1325) — the `widget` bus kind the renderer mirrors from
// `media`. The box spine (src/server/widgets.mjs BET-1323) publishes ONE
// `widget` kind with an `action` discriminator (today only `show`; future
// `fail`) carrying the widget's served URL plus the same reserved-box
// dimension fields the media kind uses. The renderer routes by (sessionId,
// messageId) and keys its per-session placeholder state on `messageId`.
//
// Routing-field casing: lowercase `d` (sessionId / messageId) — NOT the media
// kind's uppercase `ID`. See the shared contract above (BET-1328); this type
// mirrors exactly what src/server/widgets.mjs publishes.
export type WidgetEventPayload = {
  action: string;
  id?: string | null;
  url?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  aspectRatio?: number | null;
  sessionId?: string | null;
  messageId?: string | null;
};

// SSH installer (BET-355) — push-event shape + state snapshot. These types
// are declared in src/shared/types.ts so both the preload runtime (which
// imports them into src/preload/index.ts) AND the renderer-side accessor
// (src/renderer/preloadAccess.ts) can derive their types from a SINGLE
// source — keeps the two halves of the bridge in lock-step. Lives next to
// the IPC channel constants (above) because they're the wire contract.
export type InstallerStageSnapshotRow = {
  id:
    | "preflight"
    | "download"
    | "extract"
    | "service"
    | "pairing"
    | "done";
  label: string;
  state: "done" | "active" | "pending";
};

export type InstallerEvent =
  | { kind: "line"; handleId: string; text: string }
  | { kind: "stage"; handleId: string; stage: InstallerStageSnapshotRow["id"] }
  // Preflight (phase 1, in main) failed — no install ever started.
  | {
      kind: "preflight-failed";
      handleId: string;
      failures: PreflightFailure[];
    }
  // Preflight hit a never-seen host: ssh offered a fingerprint and bailed
  // (BatchMode=yes). The install PAUSES here — the renderer shows the
  // fingerprint + a "Trust this host" button; the user's answer comes back
  // via installerTrustHost. On trust, main writes the host key to
  // ~/.ssh/known_hosts and re-runs preflight (BET-361).
  | {
      kind: "fingerprint";
      handleId: string;
      fingerprint: HostFingerprint;
    }
  // BET-360/BET-979: a paused install is waiting for a secret the user must
  // type in — an SSH key passphrase, OR the box's sudo password. The kind is
  // carried on the event so ONE renderer card switches its copy. The user's
  // answer comes back via installerAskpassRespond. On submit, main either
  // creates an SSH_ASKPASS session (passphrase) and re-runs preflight, or
  // stages the sudo password (~/.manta-sudo-pass) and continues. A cancel /
  // timeout aborts like a declined trust prompt.
  | {
      kind: "secret";
      handleId: string;
      secretKind: "passphrase" | "sudo-password";
      prompt: string;
    }
  | {
      kind: "done";
      handleId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
      ok: boolean;
    }
  | { kind: "error"; handleId: string; message: string };

export type InstallerState = {
  active: boolean;
  stage: InstallerStageSnapshotRow["id"];
  logTail: string[];
  // Most recent preflight verdict, null before any install started — feeds
  // "Copy diagnostics" with the real values instead of a placeholder.
  preflight: PreflightResult | null;
  // True while the install is PAUSED waiting for the user to trust an
  // unknown host. The renderer re-shows the fingerprint prompt on remount
  // when this is set (BET-361).
  waitingForTrust: boolean;
  // The handle id the paused trust prompt belongs to, or null. Lets a
  // re-mounted renderer route its Trust/Cancel answer to the right install.
  trustHandleId: string | null;
  // The fingerprint being awaited, or null. Mirrors the `fingerprint` event
  // payload so a remount recovers the prompt without a re-send.
  pendingFingerprint: HostFingerprint | null;
  // BET-360/BET-979: True while the install is PAUSED waiting for the user to
  // enter a secret — an SSH key passphrase or the box's sudo password. The
  // renderer re-shows the matching prompt on remount when this is set
  // (mirrors waitingForTrust). `secretKind` tells it which card to draw.
  waitingForSecret: boolean;
  // The handle id the paused secret prompt belongs to, or null.
  secretHandleId: string | null;
  // Which secret is being awaited: "passphrase" | "sudo-password".
  secretKind: "passphrase" | "sudo-password" | null;
  // BET-705 b: the currently-active install's handle id, or null. The renderer
  // restores `activeHandle` from this on remount so Cancel still works after a
  // page refresh (previously activeHandle was never recovered).
  activeHandleId: string | null;
  // BET-705 b: the SshTarget the active install targets, or null. Retained so
  // the auto-claim after `done` resolves against the SAME host even after a
  // renderer remount reset the host picker to a different selection.
  target: SshTarget | null;
};

// Desktop auto-update (electron-updater) payloads, shared by the preload
// bridge, the httpApi delegation, and the renderer.
export type AutoUpdateInfo = {
  version: string;
  releaseName?: string;
  releaseNotes?: string;
};

// A TERMINAL update failure (integrity / permission). `message` is the
// user-facing copy from shared/updateError.mjs; `raw` is electron-updater's
// own message, kept for logs and support reports. Transient failures never
// reach the renderer — main filters them out.
export type AutoUpdateErrorInfo = {
  message: string;
  raw: string;
};

export const IPC = {
  configGet: "config:get",
  configUpdate: "config:update",

  // BET-678: sync cursor snapshot/delta RPC (the single bootstrap + resync).
  syncSnapshot: "sync:snapshot",

  // Project metadata (local-only)
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
  // BET-246: create / remove a git worktree for a new chat session. The
  // renderer stamps the new path on the tmux window so clean-on-close
  // knows it can remove the worktree later.
  gitAddWorktree: "git:add-worktree",
  gitRemoveWorktree: "git:remove-worktree",

  // Directory autocomplete: given a partial path, list matching subdirectories
  fsListDirs: "fs:list-dirs",

  // BET-1091: create an empty, git-initialised scratch project directory
  // under `root`, returning the real absolute path for the session-creation
  // flow.
  projectCreateScratch: "project:create-scratch",

  // BET-786: probe the box for git repos + read their origins + detect the gh
  // CLI. Server-side only, cached in server memory for 60s.
  forgeProbe: "forge:probe",

  // BET-788: forge read path. Both server-side only — the renderer stays
  // ignorant of forge identity; forge:pull-request takes a session cwd and the
  // server resolves cwd → origin → repo. forge:status reports connected/login
  // WITHOUT ever crossing a token.
  forgeStatus: "forge:status",
  forgePullRequest: "forge:pull-request",
  forgeDiff: "forge:diff",

  // BET-795: forge:inbox — the aggregated work inbox (assigned issues + review
  // requests + my red PRs). Box-side only; three cross-repo SEARCH queries.
  forgeInbox: "forge:inbox",

  // BET-794: forge write path. Both box-side only — the renderer never sees a
  // forge token. forge:ship pushes the current branch then opens a PR (only
  // after the renderer's human confirm). forge:merge merges with the head SHA
  // the user approved and surfaces the distinguished failure kind.
  forgeShip: "forge:ship",
  forgeShipPreview: "forge:ship-preview",
  forgeMerge: "forge:merge",

  // BET-798: rules registry + disconnect (Settings [G1]).
  forgeRulesList: "forge:rules-list",
  forgeDisconnect: "forge:disconnect",

  // BET-793: box-buffered draft review. All three are box-side only — the box
  // owns the draft (§3.4①), so a forge token never reaches the renderer.
  // forge:draft-get reads the current draft; forge:draft-comment mutates a
  // comment (add/edit/delete) or sets the verdict; forge:draft-submit flushes
  // the whole draft as ONE review, clearing it only on success.
  forgeDraftGet: "forge:draft-get",
  forgeDraftComment: "forge:draft-comment",
  forgeDraftSubmit: "forge:draft-submit",
  forgeThreadReply: "forge:thread-reply",

  // BET-796: fresh-box clone flow, all box-side (a forge token never reaches
  // the renderer). forge:device-start mints the GitHub device grant (returns a
  // renderer-safe shape, NEVER device_code); forge:device-poll drives the
  // countdown; forge:device-cancel backs out to [S4]. forge:repos lists the
  // clone picker's push-to repos; forge:clone-{start,status,cancel} run a
  // clone on the box with real progress.
  forgeDeviceStart: "forge:device-start",
  forgeDevicePoll: "forge:device-poll",
  forgeDeviceCancel: "forge:device-cancel",
  forgeRepos: "forge:repos",
  forgeCloneStart: "forge:clone-start",
  forgeCloneStatus: "forge:clone-status",
  forgeCloneCancel: "forge:clone-cancel",

  tmuxConfigStatus: "tmux:config-status",
  tmuxSetupConfig: "tmux:setup-config",     // backup user config, install manta's
  tmuxRestoreConfig: "tmux:restore-config", // restore user's backup

  // Clipboard (OSC 52 from remote → Mac system clipboard via Electron main)
  clipboardWriteText: "clipboard:write-text",
  // Read the current clipboard image as PNG ArrayBuffer (null if no image).
  // Called on demand after a screenshotDetected event — not polled.
  clipboardReadImage: "clipboard:read-image",
  // Read the current clipboard TEXT (BET-704: onboarding pair-link
  // clipboard prefill). Called on PairStep mount + window focus — never
  // polled. Only main can touch the OS clipboard.
  clipboardReadText: "clipboard:read-text",
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

  // Native file-dialog bridge (BET-387). Opens Electron's
  // dialog.showOpenDialog (single file) and returns the chosen path. Used by
  // the custom-host SSH installer panel's "Identity file" Browse button —
  // only main can spawn a native picker, so the renderer asks through this
  // channel. Mirrors peekRemoteFile / revealInFolder (OS-integration-only,
  // never part of window.api / httpApi).
  dialogShowOpenFile: "dialog:show-open-file",

  // ---- Agent → laptop file push (outbox) ----
  // Pull a remote outbox file to the local downloads dir. Returns the saved
  // local absolute path. Deletes the remote source on success (one-shot mailbox).
  agentPullFile: "agent:pull-file",
  // BET-1156: the one desktop download-to-downloads path. Main fetches
  // `/api/download?path=<remotePath>` with the box token and writes the bytes
  // to `downloadsDir` (default `app.getPath("downloads")`), deduping a name
  // collision. Returns the saved local absolute path, or "" on failure. Every
  // desktop download (toast Save, inline-media preview + hover, artifacts
  // panel) funnels through this single bridged path.
  downloadFileToDownloads: "agent:download-to-downloads",
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

  // Deep-link pairing: main → renderer push when the OS delivers a
  // manta://pair?... URL (protocol handler). Payload: the raw URL string;
  // the renderer validates it with parsePairPayload and routes it into
  // the onboarding PairStep. Invalid URLs are dropped renderer-side.
  pairLinkReceived: "pair:link-received",

  // main → renderer push: the manta-server notification router decided the
  // desktop should show an OS notification. Relayed from the server's
  // `desktopNotify` bus event. Payload:
  // DesktopNotifyPayload. The renderer suppresses it if it's already viewing
  // that session, else shows it via the Notification API + deep-links on click.
  desktopNotify: "desktop:notify",

  // ---- on-call CTO voice window (BET-1166) ----
  // Renderer → main controls for the floating call window. `show` reveals it
  // (creating it on first use), `park` hides it while keeping the window
  // alive, `hangup` destroys it. `callGetConfig` returns the {serverUrl,
  // boxToken} the call renderer needs to open its /call WS (no second
  // transport, no API key — audio + events ride the /call WS).
  callWindowShow: "call:window-show",
  callWindowPark: "call:window-park",
  callWindowHangup: "call:window-hangup",
  callGetConfig: "call:get-config",

  // ---- opencode chat-mode ----
  // Fetch a session's transcript (one-shot HTTP call on the remote).
  // args[1] is an optional {limit} — opencode returns the chronological TAIL.
  opencodeMessages: "opencode:messages",
  // Fetch a single message by id (GET /session/{id}/message/{messageID}, ~20–80ms).
  // Used to splice a finalized/changed message into the renderer's transcript
  // during a live turn instead of re-pulling the whole (up to 3 MB) transcript.
  // Returns null on miss/error so the caller can fall back to a full refetch.
  opencodeMessage: "opencode:message",
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
  // BET-1244: generic read-only routing decision for either surface (main|sub).
  routingChoose: "routing:choose",
  // BET-1244: Accounts "Try again" — clear a provider's out-of-credit flag.
  accountsRetry: "accounts:retry",
  // BET-1250: per-provider health snapshot for the merged Accounts list.
  accountsHealth: "accounts:health",
  // BET-1249: the provider-agnostic model catalogue (models.dev) for the
  // renderer's "Models we couldn't identify" block — resolve opaque endpoint
  // ids and typeahead over every known model. Read-only; entry-level data.
  opencodeModelCatalog: "opencode:model-catalog",
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
  // Session management: list/fork/compact/delete.
  opencodeListSessions: "opencode:list-sessions",
  opencodeForkSession: "opencode:fork-session",     // returns new sessionId
  opencodeCompactSession: "opencode:compact-session",
  opencodeDeleteSession: "opencode:delete-session",
  // BET-949: read a single session's `agent` field (GET /session/{id}) so the
  // plan-mode toggle can seed from a session already set to plan outside
  // MantaUI, before the honesty sync's first event. Returns the agent name or
  // null when absent/unknown.
  opencodeSessionAgent: "opencode:session-agent",
  // Typeahead sources for the input area (@-mention files/agents, /-commands).
  opencodeCommands: "opencode:commands",
  opencodeAgents: "opencode:agents",
  opencodeFindFiles: "opencode:find-files",
  // BET-1023: configured opencode references (GET /api/reference) + the
  // single-writer upsert for them (through opencode's PATCH /global/config).
  opencodeReferences: "opencode:references",
  opencodeSetReferences: "opencode:set-references",
  // BET-698: server-side conversation search over opencode's SQLite
  // (messageSearch.mjs). Returns { supported, hits }.
  opencodeSearchMessages: "opencode:search-messages",
  // BET-1219: read-only spend/latency ledger over opencode's store.
  // Returns { supported, ...LedgerSummary }.
  ledgerSummary: "ledger:summary",
  // BET-1333: the Optimizer's memoized read model over the ledger. Returns
  // { supported, ...OptimizerSummary }.
  optimizerSummary: "optimizer:summary",
  // Slash-command execution: invokes POST /session/{id}/command. Distinct
  // from opencode:prompt — the server treats commands specially (templates,
  // configured agent/model, etc.).
  opencodeRunCommand: "opencode:run-command",
  // /clear: drop the current session's history by creating a fresh opencode
  // session in the same directory, then re-stamping the tmux window's
  // @manta-session-id user-option. The renderer notices the new id and
  // unmounts/remounts ChatPanel.
  opencodeClearSession: "opencode:clear-session",
  // BET-421: bare opencode session create/delete with NO tmux window. Used
  // by the onboarding verifier to spin up an ephemeral session, send one
  // probe prompt, confirm a real assistant reply, and delete the session
  // — leaving no project and no session behind on the box. Mirrors the
  // throwaway-session pattern opencode:generate-title already uses
  // server-side, exposed here so the renderer can drive the staged UI.
  opencodeCreateEphemeralSession: "opencode:create-ephemeral-session",
  opencodeDeleteSessionRaw: "opencode:delete-session-raw",
  // Auto-rename: generate a short 1-2 word title for a session by spawning a
  // throwaway opencode session, prompting it to summarize the conversation,
  // then deleting it. Returns the RAW model reply (renderer sanitizes). Used
  // by ChatPanel when AppConfig.autoRenameSessions is enabled.
  opencodeGenerateTitle: "opencode:generate-title",
  // ---- subscription provider auth (BET-308 / BET-309) ----
  // Single discriminated channel for connecting/disconnecting the paid
  // subscription providers (Claude via the local CLI plugin, Codex via
  // opencode's native ChatGPT OAuth, Kimi via an API key). One channel,
  // not five: every action shares the same renderer→server hop and the
  // action discriminator (`status` / `start` / `code` / `key` /
  // `disconnect`) routes to the matching opencode.mjs proxy. Policy —
  // which method index to use, which UI to render — lives in
  // src/server/subscriptionProviders.mjs; this channel is purely the wire.
  // `key` carries the API-key secret renderer→box; the server writes it
  // into opencode's auth store and never echoes it back, not in the
  // return value and not in any log line.
  opencodeProviderAuth: "opencode:provider-auth",
  // BET-354: explicitly cancel an in-flight Claude login session. Called
  // from the renderer's claude connect card when the user hits ×/Cancel
  // or retries after a failure. Drops the server-side metadata; the
  // renderer is responsible for the matching pty:kill (the pty bus is
  // shared with every other terminal, so cancellation here + pty:kill
  // there = full teardown).
  claudeLoginCancel: "claude:login-cancel",
  // BET-421 §E: probe whether the `claude` CLI is installed on the box, so
  // the connect card can run the lazy installer before sign-in when it
  // isn't. Returns { installed, path }.
  opencodeClaudeCliStatus: "opencode:claude-cli-status",

  // ---- voice (Groq STT + lightweight classifier) ----
  // Renderer captures audio via MediaRecorder, ships the ArrayBuffer to
  // main/server, which posts multipart to api.groq.com so the API key never
  // touches the renderer process. Same channel + shape on desktop and
  // mobile transports. Returns the raw transcript.
  voiceTranscribe: "voice:transcribe",
  // BET-837: list a session's voice notes (metadata only — no audio bytes).
  // Audio rides the REST GET /api/voice/<id>; this channel returns the notes
  // a client renders as text-first bubbles. Same shape as voice:transcribe
  // (single round trip over /rpc, JSON only).
  voiceListNotes: "voice:list-notes",

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
  // BET-357 §2: "Remove this box from the device that holds the current
  // box_token". The desktop Settings → Connection → "Remove box" action
  // triggers this channel. Main does DELETE <serverUrl>/auth/revoke with the
  // current box_token as Bearer (see src/main/unpair.ts + src/server/auth.mjs
  // revoke), then ALWAYS clears the local config entry — including the
  // unreachable-box path, which still succeeds locally per the spec.
  // Input: none (main reads serverUrl/boxToken from the live config). Result:
  // an UnpairOutcome (src/shared/unpair.mjs) — a structured note that the
  // renderer's Settings panel surfaces as either a clean success or a
  // "remote revocation didn't happen, but local credentials are gone" note.
  authUnpair: "auth:unpair",

  // ---- scheduled prompts (manta-server owned) ----
  // Schedules are a manta-SERVER concept (durable jobs fired by the always-on
  // box process), NOT an opencode concept — so they get their own channels
  // that hit manta-server's /api/schedule rather than routing through the
  // opencode client. Created by the remote AI's global `schedule` opencode
  // tool; listed/deleted by the ScheduledTasksCard UI. Desktop reaches the
  // server store over its existing SSH -L 18787 forward (src/main/schedule.ts);
  // mobile is in-process (src/server/rpc.mjs → schedule.mjs).
  scheduleList: "schedule:list", // (sessionId?) → ScheduledJob[]
  scheduleDelete: "schedule:delete", // (id) → { deleted: boolean }
  scheduleCreate: "schedule:create", // (input) → { ok, job?, error? } (BET-739 usage reset actions)

  // ---- subscription plan usage (manta-server owned; BET-737) ----
  // Read-only: the current UsageSnapshot[] cache maintained by the usage
  // poller (src/server/usage.mjs). NOT the context-window indicator — see
  // the UsageSnapshot/UsageWindow doc comment above for that boundary.
  usageList: "usage:list", // () → UsageSnapshot[]

  // ---- usage-limit stopped conversations (manta-server owned; BET-1047) ----
  // Durable box-side record of conversations stopped by a plan-usage limit
  // (src/server/stoppedStore.mjs). list → { records, lastLooked }; arm /
  // disarm / stamp-last-looked mutate the record and publish
  // `usage-stopped.updated`. Single source for the sidebar indicator + the
  // resume modal.
  usageStoppedList: "usage-stopped:list", // () → { records, lastLooked }
  usageStoppedArm: "usage-stopped:arm", // (conversation) → void
  usageStoppedDisarm: "usage-stopped:disarm", // (conversation) → void
  usageStoppedStampLastLooked: "usage-stopped:stamp-last-looked", // () → void

  // ---- per-session model prefs (manta-server owned; BET-1279) ----
  // Durable box-side record of per-conversation model selection (provider+
  // model, variant, fast flavour) + the recent-choices list
  // (src/server/modelPrefs.mjs). get → { sessions, recents }; set upserts /
  // deletes a session's selection and/or replaces recents; seed is the
  // one-shot non-destructive migration each client runs. Mutations publish
  // `model-prefs.updated` ({sessionId} hint); clients refetch.
  modelPrefsGet: "model-prefs:get", // () → { sessions, recents }
  modelPrefsSet: "model-prefs:set", // ({ sessionId?, selection?, recents? }) → void
  modelPrefsSeed: "model-prefs:seed", // ({ sessions?, recents? }) → void

  // ---- session progress (manta-server owned; BET-790) ----
  // Read-only: the durable progress record for a session (written by the AI's
  // `progress_report` opencode tool → POST /api/progress). Desktop + mobile
  // reach it over the same /rpc surface.
  progressGet: "progress:get", // (sessionId?) → ProgressRecord | null

  // ---- secrets (manta-server owned) ----
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

  // ---- inbound webhooks (manta-server owned) ----
  // External actors POST to a public /hook/<token> route to wake a chat session
  // with an event (the push counterpart to scheduled polling). CREATED by the
  // remote AI's global `webhook` opencode tool (which gets the URL + signing
  // secret); the UI only LISTS + REVOKES (the secret is shown once at create,
  // never re-exposed). Desktop reaches the server store over its existing
  // SSH -L 18787 forward (src/main/webhook.ts); mobile is in-process
  // (rpc.mjs → webhooks.mjs).
  webhookList: "webhook:list", // (sessionId?) → WebhookMeta[]
  webhookDelete: "webhook:delete", // (id) → { deleted: boolean }

  // ---- published serve-page registry (manta-server owned) ----
  // Read-only: returns the box's published-page registry so the artifacts
  // panel can render it. Pages are published/stopped by the AI's global
  // `serve_page` / `stop_page` opencode tools (POST /api/serve-page), not by
  // a UI channel. Desktop + mobile both reach the server store over /rpc
  // (httpApi); a read has no server write counterpart.
  servePageList: "serve-page:list", // () → ServedPageMeta[]

  // Registry of the box's ~/.manta-outbox mailbox (files the AI dropped for
  // the user to retrieve). Read-only, used by the artifacts panel's Files tab
  // so agent-pushed files show up alongside user uploads. The source file is
  // removed on download (one-shot mailbox), so an entry can drop out on its
  // own. Mirrors src/shared/types.ts OutboxFile / src/server/outbox.mjs
  // listOutbox rows.
  outboxList: "outbox:list", // () → OutboxFile[]

  // ---- background delegation jobs (manta-server owned) ----
  // Background jobs are started by the AI's global `delegate` opencode tool
  // (POST /api/delegate); the UI only LISTS / STOPS / DELETES via these
  // channels (no create channel — see src/server/rpc.mjs). Each job is a real
  // chat-mode tmux window + opencode session in its own git worktree, so it
  // already appears in the sidebar; the jobs card manages the lifecycle and
  // the per-row activity summary. Desktop + mobile both reach the server
  // store over /rpc (httpApi). list returns the full job record; stop aborts
  // the child session and marks the job `stopped`; delete removes the tmux
  // window + worktree (force:false — refuses a dirty worktree with
  // {ok:false, reason:"dirty"}) and drops the record.
  delegateList: "delegate:list", // (sessionId?) → DelegateJob[]
  delegateStart: "delegate:start", // ({prompt, sessionID, directory, model?}) → { ok, error? } — BET-795 inbox Delegate in background
  delegateStop: "delegate:stop", // (id) → { ok: boolean, error?: string, reason?: string }
  delegateDelete: "delegate:delete", // (id) → { ok: boolean, error?: string, reason?: string }
  delegatePendingApprovals: "delegate:pending-approvals", // (sessionId?) → DelegateApproval[]
  delegateApprove: "delegate:approve", // ({id, tools?}) → { ok: boolean }
  delegateDecline: "delegate:decline", // (id) → { ok: boolean }

  // ---- APNs native-push registration (BET-181) ----
  // iOS Capacitor app registers its APNs device token so the server can
  // fan out native pushes alongside Web Push (VAPID). Server-side store
  // lives in src/server/push.mjs (apns-tokens.json). Same 6-site pattern
  // as schedule:* — desktop preload invokes the IPC channel, httpApi.ts
  // POSTs /rpc/push:register-apns on the mobile/web transport. Both
  // transports call the same push.addApnsToken() on the server side.
  // Renderer's window.api.pushRegisterApns(token) → Promise<{ok, count}>.
  pushRegisterApns: "push:register-apns", // (token) → { ok: boolean, count: number }

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
  // renderer → main: check NOW and RESOLVE with the verdict. Distinct from the
  // event channels above on purpose: a user who presses "Check for updates"
  // needs a definite answer including "you are up to date", and the event pair
  // can only ever report the positive case (`update-not-available` was
  // log-only). electron-updater's checkForUpdates() already resolves with
  // `{isUpdateAvailable, updateInfo}`, so the awaited round-trip is exact
  // rather than a timeout-and-guess over events.
  autoUpdateCheck: "autoUpdate:check",                // () → DesktopUpdateCheck
  // main → renderer: download progress (0-100) while a manual download runs.
  // Without it a large DMG/ZIP download looks like a dead button for minutes.
  autoUpdateProgress: "autoUpdate:progress",          // main → renderer push
  // main → renderer: an update failed TERMINALLY (integrity/permission — see
  // shared/updateError.mjs). Transient network errors are NOT forwarded. This
  // channel exists because a silent `console.warn` on updater errors let two
  // releases (0.0.13, 0.0.14) ship with an unusable update feed and nobody
  // noticed — the app simply stopped updating without ever saying so.
  autoUpdateError: "autoUpdate:error",

  // ---- server version (BET-180, BET-428) ----
  // Returns the manta-server's package.json version (read once at server startup,
  // served by GET /api/version for non-renderer clients AND by this in-process
  // RPC channel for the renderer — single source of truth on the box, never
  // drifts between surfaces). Display-only foundation for client/server skew
  // detection; gating / banner / force-update logic lands in a later phase.
  // BET-428 added `opencodeVersion` (the box's `opencode --version`, read once
  // at startup) so Settings → About can render it without a new IPC channel.
  getServerVersion: "server:version",                 // () → { version: string, minClient: string, opencodeVersion: string }

  // ---- server self-update apply (BET-225 stage 3) ----
  // Trigger the server's `scripts/self-update.sh` (git fetch + reset --hard
  // origin/main + npm ci --omit=dev + systemctl --user restart manta-server).
  // The handler is fire-and-forget — the restart will kill the process
  // mid-run, so any caller that awaits past the RPC send may never see a
  // response. Modeled on `opencode:restart` (single-purpose server action).
  serverUpdateApply: "server:update-apply",           // () → void

  // ---- server update check on demand ----
  // Runs the server-update poller's own tick immediately and returns its
  // verdict, so Settings → About's "Check for updates" button (and the
  // desktop's check-on-connect) never has to wait out the poll interval. Shares
  // the poller's tick rather than re-implementing fetch+compare, so the button
  // and the banner can never disagree.
  serverUpdateCheck: "server:update-check",           // () → ServerUpdateCheck

  // ---- single-CLI update (BET-1162, server half; consumed by BET-1159) ----
  // Upgrade exactly ONE installed box CLI (opencode / claude / codex / kimi) by
  // catalog id, reusing the cached CLI detector + the shared runUpgrade spawn.
  // Returns {ok, before?, after?, changed?, error?} — never rejects. This is
  // the per-row action behind BET-1159 (renderer per-row split).
  serverCliUpdate: "server:cli-update",               // (cliId: string) → CliUpdateResult

  // ---- client version (BET-225 stage 3) ----
  // Returns the desktop app's own version via Electron's `app.getVersion()`
  // (which reads the same package.json the server uses). Renderer combines
  // this with the server's `minClient` (from getServerVersion) via
  // isClientTooOld() to decide whether to render the non-dismissible skew
  // banner. Renderer-only — httpApi returns a baked-in fallback on
  // mobile/web where there's no Electron app to ask.
  clientVersion: "client:version",                    // () → { version: string }

  // ---- server-update available push (BET-225 stage 3) ----
  // Mirrors the desktopNotify pattern: main subscribes to manta-server's
  // /events SSE stream, filters on kind === "serverUpdateAvailable", and
  // forwards the payload to the renderer via this IPC channel. The renderer
  // subscribes through `onServerUpdateAvailable` (httpApi) and renders the
  // shared UpdateBar component (same component as the desktop
  // `autoUpdateDownloaded` prompt, just a different message + button label).
  serverUpdateAvailable: "server:update-available",   // main → renderer push

  // ---- plugins (BET-189 / BET-190) ----
  // The renderer reads the plugin registry via this channel (the Settings →
  // Plugins tab polls every 10s while open). Backed by
  // GET /api/plugins/registry on the server side; the Mac executor's PUT
  // publishes the entries. Same 6-site wiring as schedule:*
  // (types → shared/api → httpApi → rpc.mjs → server/plugins.mjs).
  // → PluginRegistryRow[]
  pluginsRegistry: "plugins:registry",
  // `pluginsEnabled` is a Mac-machine-local toggle (BET-207): it controls
  // whether THIS Mac runs plugins, so it persists to the Mac-local config
  // (read by capExecutor at start time) — NOT the box config that
  // `configGet`/`configUpdate` round-trip through httpApi. Routed via the
  // preload bridge (window.__mantaPreload.pluginsSetEnabled / pluginsGetEnabled)
  // exactly like configGet, which is also handled locally in main on
  // HTTP mode so the renderer can read Mac-local state without an httpApi
  // round-trip to the box.
  pluginsSetEnabled: "plugins:set-enabled",  // (value: boolean) → void
  pluginsGetEnabled: "plugins:get-enabled",  // () → boolean

  // ---- SSH installer (BET-355 — Stage 4) ----
  // The desktop can drive a box install over SSH — pick a host alias from
  // the user's ssh_config, watch preflight + install progress, end up paired
  // with no terminal interaction. The whole flow lives in src/main/installer/
  // (the architectural rule: SSH is installer-only, never reachable from the
  // running app). Channels are the renderer's only handle on the installer
  // module; events stream back on `installerEvent`.
  //
  // Renderer's view of the world:
  //   listHosts        → SshHostEntry[]  — populate the alias picker
  //   installStart({alias})
  //                   → { handleId }   — runs preflight (phase 1, in main)
  //                                      then the install; renderer listens
  //                                      to `installerEvent` until it exits.
  //   installCancel({handleId})
  //                   → void          — SIGTERM the in-flight install; safe
  //                                      even if the handle is already done
  //   installMintAndClaim({alias, claimUrlOverride?})
  //                   → ClaimOutcome   — runs `manta pair` over SSH on the
  //                                      already-installed box, claims the
  //                                      resulting code, and persists the
  //                                      box credentials through the
  //                                      existing claim path (single
  //                                      config writer per BET-355
  //                                      constraint #4).
  //   installState()  → { active, stage, logTail, preflight } — renderer
  //                                       queries on mount to recover state.
  //   installGetDiagnostics({preflight, stage, logTail, alias})
  //                   → string         — redacted diagnostics blob for the
  //                                      "Copy diagnostics" action.
  installerListHosts: "installer:list-hosts",
  installerStart: "installer:start",
  installerCancel: "installer:cancel",
  installerMintAndClaim: "installer:mint-and-claim",
  installerState: "installer:state",
  installerGetDiagnostics: "installer:get-diagnostics",
  // installerTrustHost (BET-361): the renderer's answer to a paused
  // `fingerprint` event — trust=true writes the host key to
  // ~/.ssh/known_hosts and resumes the install; trust=false (or a cancel)
  // aborts with a preflight-failed event.
  installerTrustHost: "installer:trust-host",
  // installerAskpassRespond (BET-360): the renderer's answer to a paused
  // `passphrase` event. passphrase=non-empty string → main creates an
  // askpass session and re-runs preflight with SSH_ASKPASS enabled;
  // passphrase=null → the user cancelled → the install aborts with a
  // preflight-failed event (same shape as a declined trust prompt).
  installerAskpassRespond: "installer:askpass-respond",
  // installerEvent is the main → renderer push channel (mirrors the
  // pairLinkReceived pattern). Payload is a discriminated union:
  //   { kind: "line", handleId, text }
  //   { kind: "stage", handleId, stage }
  //   { kind: "preflight-failed", handleId, failures }
  //   { kind: "fingerprint", handleId, fingerprint }   (BET-361 — pause for trust)
  //   { kind: "secret", handleId, secretKind, prompt } (BET-360/979 — pause for key passphrase or sudo password)
  //   { kind: "done", handleId, code, signal }
  //   { kind: "error", handleId, message }
  installerEvent: "installer:event",
} as const;

// BET-698: a ⌘F conversation search hit returned by the server-side
// messageSearch query (`opencode:search-messages`). Crosses the wire, so it
// lives in shared/types (moved verbatim from the deleted renderer
// searchTranscript — the UI is unchanged); `sessionId` is new (the server
// returns a flat list the client groups by).
export type TranscriptHit = {
  sessionId: string;
  messageId: string;
  role: "user" | "assistant";
  pre: string;
  match: string;
  post: string;
  timeCreated: number | null;
};

// BET-1219: read-only spend/latency ledger over opencode's store
// (`ledger:summary` RPC). Crosses the wire, so it lives in shared/types.
// The four cacheShare fractions sum to ~1 (±0.001): each is that bucket's
// share of the summed billed token cost proxy (input + output + cacheRead +
// cacheWrite). Arrays are sorted by cost descending. p50Ms/p90Ms are null
// below 5 timed turns. `supported:false` = the box can't read opencode.db.
export type LedgerSummary = {
  supported: boolean;
  totals: { turns: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheShare: { output: number; cacheRead: number; cacheWrite: number; input: number };
  byModel: {
    key: string; // "providerID/modelID"
    turns: number;
    cost: number;
    costPerTurn: number;
    outPerTurn: number;
    tokensPerSec: number;
    p50Ms: number | null;
    p90Ms: number | null;
  }[];
  byAgent: { agent: string | null; isChild: boolean; turns: number; cost: number; costPerTurn: number }[];
  byProject: { directory: string; turns: number; cost: number }[];
};

// BET-1333: the Manta Optimizer's P1.1 read model (`optimizer:summary` RPC).
// Crosses the wire, so it lives in shared/types. `totals`/`cacheShare` reuse
// the ledger `aggregate` shape; `dailySeries` is a zero-filled local-day
// tokensSent graph over `windowDays`, oldest→newest; `bySession` is the top 20
// sessions by cost. BET-1335 fills the `counterfactual` placeholder: each
// `dailySeries` day gains a `maskedTokens` (0 where no counterfactual) = the
// observe-mode "what manta WOULD trim" line; each top-20 `bySession` entry
// gains `savedPct`; and the `counterfactual` key itself holds the raw store
// fields. BET-1336 fills the `windows` placeholder: the quota-window usage
// list with a per-window `forecastPct` (the forecast-at-reset tick; null when
// history is too thin). `ttl` is the measured effective Anthropic prompt-cache
// TTL (BET-1340): `measuredMs` is what the ledger shows actually happened,
// `confidence` is "measured" when enough idle-gap observations exist and
// "default" otherwise, `observations` is how many pairs the measurement used,
// and `configuredMs`/`matched` compare it against what opencode is set to
// send (null when there is no readable configured TTL). The renderer shows the
// Cache-hit detail ("TTL 5m measured" / "TTL 1h measured" / "TTL 5m default")
// from `measuredMs` + `confidence` (BET-1341). `ttl` is null only when the
// summary builder has no measurement at all.
// `supported:false` = the box can't read opencode.db.
export type OptimizerSummary = {
  supported: boolean;
  windowDays: number;
  totals: { turns: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  cacheShare: { output: number; cacheRead: number; cacheWrite: number; input: number };
  dailySeries: { day: string; tokensSent: number; maskedTokens: number }[]; // "YYYY-MM-DD", oldest→newest
  bySession: { sessionID: string | null; turns: number; cost: number; tokensSent: number; savedPct: number }[];
  ttl: {
    measuredMs: number;
    confidence: "default" | "measured";
    observations: number;
    configuredMs: number | null;
    matched: boolean | null;
  } | null;
  counterfactual: {
    dailySeries: { day: string; maskedTokens: number }[];
    bySession: Record<string, { maskedTokens: number }>;
  } | null;
  windows: {
    provider: string;
    planLabel?: string;
    windowLabel: string;
    pct: number;
    resetsAt: number | null;
    forecastPct: number | null;
  }[];
  // BET-1347: the optimizer's trust surface — every parameter change it made
  // on its own, with the evidence used. Most recent first, capped at 50.
  activity: {
    entries: {
      id: string;
      ts: number;
      kind: "tune" | "eco" | "compaction" | "guardrail";
      subject: string;
      from?: string | number;
      to?: string | number;
      verdict: "kept" | "rolled-back" | "applied";
      evidence: Record<string, string | number>;
      revertedAt?: number;
    }[];
  };
};

// A secret's METADATA — what the UI and `secret_list` see. NEVER carries the
// value (manta-server strips it; only secret_provide materializes the value, to a
// 0600 file on the box). Store: ~/.manta/secrets.json.
export type SecretScope = "shared" | "session" | "project";
export type SecretMeta = {
  id: string; // 8-char hex store id (used for delete)
  key: string; // env-var-style name, e.g. "GITHUB_PAT"
  scope: SecretScope; // shared = every session; session = one sessionID; project = one workspace
  sessionID: string | null; // set when scope === "session"
  project: string | null; // set when scope === "project" (manta/tmux workspace name)
  hint: string; // optional human usage note (safe to show the agent)
  hasValue: boolean; // a value is stored (always true for persisted secrets)
  createdAt: number | null;
  updatedAt: number | null;
};

// A published serve-page registry entry — what the artifacts panel sees via
// the read-only `serve-page:list` RPC channel. `url` is "" when the box has no
// addressable base URL (publicBaseUrl() returned falsy); `sessionID` is the
// opencode session that called `serve_page`. Store: ~/.manta/serve-page.json.
export type ServedPageMeta = {
  subdomain: string;
  url: string;
  expiresAt: number | null;
  createdAt: number;
  sessionID: string | null;
};

// One entry in ~/.manta-outbox (the mailbox the AI drops files into for the
// user to retrieve, surfaced by the artifacts panel's Files tab). Mirrors
// src/server/outbox.mjs `listOutbox` rows. `sessionID` is the workspace the
// file belongs to (the subdir name = the opencode session that pushed it);
// `expiresAt` is its TTL (mtime + TTL, default 7 days) — files are NOT deleted
// on download, only swept once the TTL elapses.
export type OutboxFile = {
  path: string;
  name: string;
  size: number;
  sessionID: string | null;
  mtime: number;
  expiresAt: number | null;
  messageID: string | null;
  // true when pushed by the inline-media tools; suppress the agentFile toast
  media?: boolean;
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
  // BET-739: "prompt" (default; fires sendPrompt) or "notify" (fires a push).
  // Absent on legacy jobs — treat as "prompt".
  kind?: "prompt" | "notify";
  sessionID: string;
  directory: string;
  createdAt: number;
  lastFiredMinute: string | null;
};

// Subscription plan usage (BET-737) — the rolling 5-hour session window +
// the weekly cap for a connected AI provider (Claude Max/Pro, Codex, Kimi For
// Coding). Server-side: src/server/usage.mjs (poller) + src/server/
// usageAdapters/*.mjs (one file per provider, all routing their raw payload
// through normalizeWindow). In-memory only — the poll interval IS the cache
// TTL, there is no disk store. Read via the `usage:list` RPC channel;
// live-updated via the `usage.updated` bus event.
//
// THIS IS NOT THE CONTEXT-WINDOW INDICATOR (SessionHeader.tsx ContextPill,
// per-conversation). This is per-SUBSCRIPTION plan usage — never share code,
// colour scale, or placement with the context pill.
export type UsageWindow = {
  kind: "session" | "weekly" | string; // open set — a daily window just works
  label: string; // "5h"
  pct: number; // 0-100, ALWAYS present (derived when the provider reports only absolutes)
  used?: number; // absolute count when the provider exposes one
  limit?: number; // absolute cap when the provider exposes one
  resetsAt?: number; // epoch ms
  startedAt?: number; // epoch ms — when this window opened; absent when the
  // provider does not report one (never guess it from resetsAt minus a window length)
  binding?: boolean; // the provider says this window bites first
  // True when this reading describes a window whose reset instant has already
  // passed: the provider has not published the new window's numbers yet, so
  // `pct` still belongs to the window that just ended. Set by the poller
  // (src/server/usage.mjs), never by an adapter. Consumers must not raise an
  // alert from a stale window; the dial carries the last reading forward and
  // labels it "resetting…" rather than blanking.
  stale?: boolean;
};
export type UsageSnapshot = {
  provider: string; // adapter id: "claude" | "codex" | "kimi"
  // opencode providerIDs this snapshot covers (e.g. ["anthropic"]) — match the
  // active model's providerID against THIS, never `provider`. The adapter id
  // and opencode's providerID are different namespaces on purpose.
  providerIDs: string[];
  planLabel?: string; // "Max 20x", "Pro", "Allegretto"
  // ORDERED SHORTEST-FIRST — the session (5h) window before the weekly one.
  // The composer dial reports windows[0] as "your usage right now", so an
  // adapter that emits weekly first makes the dial lie. Every adapter in
  // src/server/usageAdapters/ upholds this.
  windows: UsageWindow[];
  extras?: { label: string; value: string }[]; // credits balance, model pools…
  balance?: number; // account credit in dollars; may be NEGATIVE (overdrawn).
  // Absent = unknown, never 0.
  overagePrice?: number; // $ per unit beyond the included allowance, when published
  exhausted?: boolean; // the provider will refuse work now
  fetchedAt: number; // epoch ms of the successful fetch
};

// One row of the durable box-side record of conversations stopped by a
// plan-usage limit (src/server/stoppedStore.mjs, BET-1047). The SINGLE source
// for the sidebar indicator, the row markers and the resume modal; it lives on
// the box so all three survive an app restart. Input to the renderer, never
// derived — the renderer only reads it, arms/disarms it, and stamps
// last-looked.
export type StoppedRecord = {
  workspace: string; // the project/workspace the conversation lives in
  conversation: string; // the opencode session id (row identity + grouping)
  provider: "claude" | "codex" | "kimi"; // the meter that gates the resume
  model?: string; // the model that was in flight (pinned on the continuation)
  window: UsageWindowKind | null; // "session" | "weekly" | "monthly", when named
  stoppedAt: number; // epoch ms — ordering + "new since you last looked"
  cachedTokens?: number; // cached-token count at that moment (cold-cache cost)
  armed?: boolean; // whether the user chose to resume it
  attempts?: number; // so a permanently-refused conversation stops looping
};
export type UsageWindowKind = "session" | "weekly" | "monthly" | string;

// The list-level read of the stopped record: the records plus the modal's
// "last looked" timestamp (stamped when the modal closes so "new" badges
// clear).
export type StoppedListResult = {
  records: StoppedRecord[];
  lastLooked: number | null;
};

// ---- per-session model prefs (BET-1279) ----
// Durable box-side record of per-conversation model selection + recent model
// choices (src/server/modelPrefs.mjs). Mirrors the on-disk store exactly:
// `variant` is OMITTED when absent (never null), a session record has no
// `fast` field, and `recents[]` DOES carry `fast` + a base `modelID` (the iOS
// ModelChoice shape). Read via `model-prefs:get`; not to be constructed by the
// renderer (declarations only this ticket).
export type ModelPrefsSelection = {
  providerID: string;
  modelID: string;
  variant?: string;
  fast?: boolean;
};
export type ModelPrefsSessionRecord = {
  providerID: string;
  modelID: string;
  variant?: string;
  updatedAt: number;
};
export type ModelPrefsState = {
  sessions: Record<string, ModelPrefsSessionRecord>;
  recents: ModelPrefsSelection[];
};
export type ModelPrefsSetInput = {
  sessionId?: string;
  selection?: ModelPrefsSelection | null;
  recents?: ModelPrefsSelection[];
};
export type ModelPrefsSeedInput = {
  sessions?: Record<string, ModelPrefsSelection>;
  recents?: ModelPrefsSelection[];
};

// A background-delegation job record (manta store: ~/.manta/delegate-jobs.json).
// Mirrors the shape persisted by src/server/delegate.mjs. The UI reads this
// via the `delegate:list` RPC channel (filtered by parent session when a
// sessionId is passed); stop/delete via `delegate:stop` / `delegate:delete`.
// `status` is "running" | "done" | "failed" | "stopped". `activity` is the
// per-row summary the server computes on a 10s poll (no model call) — the
// renderer renders it verbatim and never computes it. `worktree`/`branch` are
// null when the parent cwd was not a git repo (the job ran in the parent cwd).
export type ProgressState = "working" | "blocked" | "done" | "failed";
// Durable, session-scoped "where are we right now" status (BET-790, spec §6.1).
// One record per session, replace-never-append; `step` is monotonic. Written by
// the AI's `progress_report` opencode tool → POST /api/progress and read by the
// renderer via `progress:get` (or attached to a delegate job via its child).
export type ProgressRecord = {
  sessionID: string;
  label: string;
  step: number | null;
  total: number | null;
  state: ProgressState;
  detail: string;
  updatedAt: number; // epoch ms
};
export type DelegateJobStatus = "running" | "done" | "failed" | "stopped";
export type DelegateJob = {
  id: string; // 8-char hex
  name: string; // slug of the first 4 words of the prompt
  prompt: string;
  model: string | null;
  parentSessionID: string; // the opencode session that called delegate
  parentDirectory: string;
  childSessionID: string | null; // the job's own opencode session (null until created)
  tmuxSession: string | null;
  windowIndex: number | null;
  worktree: string | null; // absolute path, or null (not a git repo)
  branch: string | null;
  baseSha: string | null;
  status: DelegateJobStatus;
  activity: string | null; // server-computed one-line summary (running jobs only)
  createdAt: number;
  startedAt: number;
  finishedAt: number | null;
  result: string | null; // last assistant text (done only)
  error: string | null; // failure / stop / timeout reason
  filesChanged: number | null; // committed + uncommitted (done only)
  // BET-790: the child session's live progress record (null when the child
  // never reported / has no session / finished). Drives the job card's label.
  progress?: ProgressRecord | null;
  // BET-418 §A: true once the terminal cleanup removed the tmux window +
  // worktree; false when a dirty worktree kept both (record is retained so
  // the window stays recognisable as a job). Undefined for pre-§B records.
  cleanedUp?: boolean;
};

// A pre-flight approval requested by a `delegate` call when trust mode is OFF
// and the model declared `tools` (BET-418 §A). The renderer shows ONE card
// (Start / Edit access / Not now); approve/decline resolve the held delegate
// call. `tools` is the access the model declared ({permission, pattern}).
export type DelegateApprovalTool = {
  permission: string; // opencode category, e.g. "bash", "write"
  pattern: string; // glob, e.g. "pytest *", "**/*.ts"
  action?: "allow" | "deny";
};
export type DelegateApproval = {
  id: string; // 8-char hex
  parentSessionID: string;
  name: string;
  prompt: string;
  tools: DelegateApprovalTool[];
  createdAt: number;
};

// BET-795: the work inbox's "Delegate in background" starts a background job
// through the existing delegate engine. `sessionID` is the parent (active)
// chat session the job nests under; `directory` is the repo the worktree is
// created in; `prompt` is the seeded instruction. Mirrors the /api/delegate
// POST body. Result is { ok } or { ok:false, error } (e.g. no parent session,
// at the MAX_RUNNING_JOBS cap, or the caller isn't a chat session).
export type DelegateStartInput = {
  prompt: string;
  sessionID: string;
  directory: string;
  model?: { providerID?: string; modelID?: string } | null;
};
export type DelegateStartResult = { ok: boolean; error?: string };

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

// Result of the native file-dialog bridge (IPC.dialogShowOpenFile, BET-387).
// `canceled:true` covers both an explicit cancel and a no-selection close;
// otherwise `path` is the single absolute path the user picked. Mirrors the
// subset of Electron's OpenDialogReturnValue the renderer actually reads.
export type OpenFileResult =
  | { canceled: true }
  | { canceled: false; path: string };

// ----- Onboarding pairing (BET-49, BET-198 — relay dropped) -----

// Input for the desktop auth:claim channel. The mobile/web client always
// supplies a non-empty `serverUrl` (direct-HTTPS pairing, BET-49). The desktop
// onboarding shell accepts EITHER `serverUrl` OR `boxId` (the box-form pair
// URL shape; BET-198 dropped the relay proxy and replaced it with the direct
// hostname `https://<boxId>.boxes.mantaui.com`). When `boxId` is set,
// `serverUrl` is left empty so httpApi (mobile-only) sees an unchanged type
// signature; the deep-link / setup screen then resolves the boxId to a direct
// hostname AFTER a successful claim via `boxDirectUrl(boxId)` in
// src/shared/transport.mjs.
//   • serverUrl non-empty → POST <serverUrl>/auth/claim { code } (BET-49).
//   • boxId set, serverUrl "" → claims against the box's own /auth/claim,
//     then persists serverUrl = `boxDirectUrl(boxId)` (BET-198).
// `code` is the 6-digit pairing code (either flow). The typed OUTCOME lives in
// src/shared/claim.mjs (ClaimOutcome) — imported by preload/main directly so
// types.ts stays dependency-free.
//
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

// One row of the plugin registry (BET-189 / BET-190). The Mac executor
// PUTs these to the server on (re)connect + on every fs.watch burst; the
// renderer reads the same shape via the `plugins:registry` channel to
// render the installed-plugins list in Settings → Plugins. `valid:false`
// rows are intentionally surfaced so the user can SEE why their YAML
// didn't load — there's no other place this info appears.
export type PluginRegistryInputRow = {
  id: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: unknown;
  values?: string[];
};
export type PluginRegistryRow =
  | {
      name: string;
      description: string;
      inputs: PluginRegistryInputRow[];
      valid: true;
      yaml: string;
      stepCount: number;
      timeoutMs: number | null;
    }
  | {
      name: string;
      description: string;
      inputs: PluginRegistryInputRow[];
      valid: false;
      error: string;
      yaml: string;
      stepCount: number;
      timeoutMs: number | null;
    };

// ----- opencode message + part types (subset for Phase 1) -----
//
// Mirrors the shape of `GET /session/{id}/message` on the opencode server:
// each entry is { info: Message, parts: Part[] }. We keep the type surface
// narrow on purpose — only the fields the renderer actually reads. The full
// schemas live at http://<server>/doc and have many more fields we ignore.

export type OpencodeRole = "user" | "assistant";

// Token accounting surfaced by the running indicator / context bar. Lives here
// (shared, not renderer/chatShared) because it also types the `tokens` field
// on OpencodeMessageInfo below — previously the renderer read tokens off an
// explicit `as unknown as { tokens?: TokenUsage }` cast because the field
// wasn't declared; declaring it kills those casts (BET-733 / audit L10).
// `src/renderer/chatShared.tsx` re-exports this so existing renderer imports
// are unchanged.
export type TokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OpencodeMessageInfo = {
  id: string;             // msg_...
  sessionID: string;      // ses_...
  role: OpencodeRole;
  time?: { created?: number; completed?: number };
  // assistant-only fields surfaced here for the model/cost line in the UI:
  modelID?: string;
  providerID?: string;
  // AssistantMessage.tokens from the OpenAPI doc — carried on the wire for
  // assistant messages; used by the context bar / turn footers. Optional
  // because user messages (and older/streaming snapshots) don't carry it.
  tokens?: TokenUsage;
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

// ── Box-side interpreted stream events (BET-551 / §17) ──
//
// The box is now the single interpreter of the opencode session stream
// (src/server/streamInterp.mjs). It publishes derived events on the existing
// /events bus with `{ kind: "stream", sub, sessionId, payload }`, where `sub`
// names the derivative and `payload` carries its typed value. The renderer
// consumes these via `onStreamEvent` instead of re-deriving them from raw
// `opencode` events (S1b). These types mirror the emissions in streamInterp.mjs.

export type StreamFlushPayload = {
  messageID: string;
  partID: string;
  field: "text" | "reasoning";
  text: string;
};

export type StreamRunningPayload = { running: boolean };

export type StreamTurnCompletePayload = { complete: boolean; running: boolean };

export type StreamTodosPayload = {
  active: Array<Record<string, unknown>> | null;
  visible: { visible: Array<Record<string, unknown>>; hiddenPending: number; hiddenDone: number } | null;
  allTerminal: boolean;
  anyTerminal: boolean;
};

export type StreamTruncationPayload = {
  kind: string;
  label: string;
  messageID?: string;
};

export type StreamQuestionsPayload = { questions: unknown[] };

export type StreamSubagentChildPayload = { childSessionId: string };

export type StreamSubagentPayload = Record<string, unknown>;

export type StreamEnvelope = {
  sub:
    | "flush"
    | "running"
    | "turnComplete"
    | "todos"
    | "truncation"
    | "questions"
    | "subagent.child"
    | "subagent"
    | "context"
    | "cache"
    | "autoRename";
  sessionId: string;
  payload: unknown;
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

// A configured opencode reference as read back from GET /api/reference
// (BET-1023). Alias is the @-mention name; exactly one of `path` (local
// directory) or `repository` (+ optional `branch`) describes the target.
// `description` advertises the reference to the agent.
export type OpencodeReference = {
  name: string;
  path?: string;
  repository?: string;
  branch?: string;
  description?: string;
  /** hidden references are omitted from @ autocomplete (opencode semantics). */
  hidden?: boolean;
};

// The user's editable view of a reference in Settings (BET-1023). Mirrors
// OpencodeReference but flattened for the add-form; `target` is the combined
// path-or-repository field, classified into path/repository on save.
export type ManagedReference = {
  alias: string;
  target: string;
  description?: string;
};

// A reference the renderer asks the server to write, following the
// setProviders/setSubagents writer contract (ops.up to patchGlobalConfig).
// Exactly one of `path` / `repository` must be set.
export type OpencodeReferenceUpsert = {
  alias: string;
  path?: string;
  repository?: string;
  branch?: string;
  description?: string;
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
// Input modalities a model accepts/produces. Open-ended: "text" | "image" |
// "pdf" | "video" | "audio" | any provider-specific or custom value.
export type InputModality = string;

// Model capabilities. The box normalizes `capabilities.input` / `.output` to
// arrays of strings, but a client may be talking to an OLDER box (the desktop
// app and the box update on separate tracks), so both shapes reach clients —
// the provider's raw object-of-flags form and the canonical array form.
// `readModalities` (src/shared/modelGuide.mjs) is the ONLY supported way to
// read these two fields. `toolcall`/`reasoning`/`attachment` pass through as
// booleans. `toolcall` matches the upstream opencode capability name (the
// router's filterByConstraints checks `capabilities.toolcall`), so the box
// must NOT rename it to `tools` (BET-1228).
export type OpencodeModelCapabilities = {
  toolcall?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  input?: InputModality[] | Record<string, boolean>;
  output?: InputModality[] | Record<string, boolean>;
};

export type OpencodeModel = {
  id: string;            // e.g. "claude-opus-4-7"
  providerID: string;    // e.g. "anthropic"
  family?: string;
  name: string;          // human-readable, e.g. "Claude Opus 4.7"
  status?: "active" | "deprecated" | (string & {});
  enabled?: boolean;
  // `limit.context` is `number | null` where `null` = "the provider gave no
  // limit; do NOT fabricate one". `output` is only present when the provider
  // reported a positive finite value.
  limit?: { context: number | null; output?: number };
  // Price in $ per 1M tokens, as reported by the provider. Each field is
  // `number | undefined`: undefined (or a field absent from `cost`) means the
  // price is UNKNOWN, which is deliberately distinct from 0 (free) — the
  // router treats unknown as free but the distinction is load-bearing for a
  // later issue in the routing epic (BET-1228).
  cost?: {
    input?: number; // $ per 1M input tokens
    output?: number; // $ per 1M output tokens
    cacheRead?: number; // $ per 1M cached-read tokens
    cacheWrite?: number; // $ per 1M cache-write tokens
  };
  // REQUIRED after normalization (always at least `{}`).
  capabilities: OpencodeModelCapabilities;
  variants?: Array<{ id: string }>;
  // User-supplied display override (via Settings → Models → edit). Set by the
  // server at listModels() time from AppConfig.modelOverrides; absent when the
  // model has no override. Supersedes the static modelGuide blurb in the
  // settings table.
  description?: string;
};

// A per-model display override. Keyed by "providerID/modelID" in
// AppConfig.modelOverrides and applied to OpencodeModel at listModels() time,
// so BOTH the Settings model table and the composer's ModelMenu/ModelPicker
// (which source from opencodeModels()) reflect it on the next fetch. Each
// field is optional; an omitted field falls back to the provider's own value /
// the static modelGuide blurb. `context` is the context window size in tokens.
export type ModelOverride = {
  name?: string;
  description?: string;
  context?: number;
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

// ----- Voice notes (BET-830 / BET-837) -----

// A stored voice note as the RENDERER sees it. The server stores `peaks` as a
// base64 string and hands records back over JSON; the client decodes that to a
// `Uint8Array` at the transport boundary (httpApi.ts `voiceListNotes`), so the
// shared type here is already the component-friendly byte array.
export type VoiceNoteRecord = {
  id: string;
  sessionId: string;
  transcript: string;
  mime: string;
  durationMs: number;
  peaks: Uint8Array;
  createdAt: number;
  expiresAt: number | null;
  // The audio may have been swept (TTL) even though the transcript + waveform
  // survive. When false the player renders a disabled/dimmed affordance.
  audioAvailable: boolean;
};

// Input for voiceUploadNote — the raw audio bytes + the waveform/duration that
// rode back with the artifact from useVoiceRecorder.
export type VoiceUploadNoteInput = {
  sessionId: string;
  buffer: ArrayBuffer;
  mime: string;
  durationMs: number;
  peaks: Uint8Array;
};

// Result of voiceUploadNote — a 200 (stored + transcribed, note ready to
// render) or a 409 (stored but transcription failed; the pending row keeps
// its id to retry against). Other statuses (no key, invalid session) resolve
// to a non-throwing `{ ok:false }` so the caller can decide how loudly to
// fail — the pending row's error state is the intended surface.
export type VoiceUploadNoteResult =
  | { ok: true; note: VoiceNoteRecord }
  | { ok: false; status: number; id?: string; error: string };

// Result of voiceRetryNote — 200 (transcription now present) or 409 (failed
// again, keep the error state) / 404 (audio swept, regenerate the note).
export type VoiceRetryResult =
  | { ok: true; id: string; transcript: string }
  | { ok: false; status: number; error: string };

// ----- Subscription provider auth (BET-308 / BET-309) -----
//
// The connect-card UI on Settings → Providers (and Onboarding step 2) lists
// one row per supported provider from src/server/subscriptionProviders.mjs
// and lets the user connect / disconnect each. `IPC.opencodeProviderAuth`
// carries a discriminated union on `action`:
//
//   "status"      → list every provider + whether it's currently connected.
//   "start"       → begin an OAuth flow for `id`, returning either a connect
//                   shape + URL/instructions/methodIndex OR `api-key` to
//                   indicate the renderer should switch to the key form.
//   "code"        → submit the user-typed OAuth callback code.
//   "key"         → submit an API key (Kimi).
//   "disconnect"  → remove the provider's auth from opencode's store.
//
// "shape" on the `start` response is what the renderer keys the UI on:
//   "oauth-auto"  — opencode's Codex headless flow. The server fires the
//                   callback DETACHED (`POST /provider/{id}/oauth/callback`
//                   blocks until the user approves on the device page) and
//                   the renderer polls its outcome via the `oauth-status`
//                   action instead of watching `connected[]` (opencode only
//                   computes that set at startup). See rpc.mjs's `start`
//                   branch and the `oauth-status` action.
//   "oauth-code"  — same UX, but opencode returned a short code to show inline.
//   "api-key"     — render the password input (or the no-flow case).

export type SubscriptionStatus = {
  id: string;             // provider id from the registry
  label: string;          // human label, e.g. "Codex"
  plan: string;           // the plan the user is paying for, e.g. "ChatGPT Plus / Pro"
  console: string | null;  // where to mint a key (Kimi), or null
  docs: string;           // canonical setup doc URL
  connected: boolean;     // true iff opencode reports this provider connected
  // BET-1320: the credential is owned outside Manta (e.g. the Claude CLI), so
  // a Disconnect cannot be delivered — the UI shows `managedBy` instead.
  managedExternally: boolean;
  managedBy: string | null;
};

export type SubscriptionConnectShape =
  | "oauth-auto"
  | "oauth-code"
  | "api-key"
  // BET-354: Claude-only. The renderer mounts a live terminal pane for
  // `claude auth login` and feeds the Anthropic callback code back
  // through pty:write; completion is detected via the credentials file
  // mtime (see opencode.mjs pollClaudeLogin).
  | "claude-login";

// BET-354: progress object returned by the claude-status RPC action.
// "no-file"      → credentials file is missing — keep polling.
// "pre-existing" → file exists but was last modified BEFORE the card
//                  mounted. The user already had a working login and did
//                  not complete a fresh OAuth. The renderer surfaces
//                  this as a distinct failure.
// "completed"    → file modified AT or AFTER startedAt. The server has
//                  already called restartOpencode + probed connected[];
//                  `connected: true` means `anthropic` is now in
//                  opencode's provider list and the card flips to done.
export type ClaudeLoginProgress =
  | { state: "no-file" }
  | { state: "pre-existing" }
  | {
      state: "completed";
      restart: { ok: true } | { ok: false; error: string };
      connected: boolean;
      restartAttempts: number;
    };

export type OpencodeProviderAuthRequest =
  | { action: "status" }
  | { action: "start"; id: string }
  | { action: "code"; id: string; methodIndex: number; code: string }
  | { action: "key"; id: string; key: string }
  | { action: "disconnect"; id: string }
  // BET-354: Claude login completion poll. Mirrors the renderer's 1s
  // tick while in the claude-login phase. Server-side: file mtime check
  // + restartOpencode() if changed + connected[] verification. The
  // server retains startedAt across requests by keying off sessionKey.
  | { action: "claude-status"; sessionKey: string; startedAt: number }
  | { action: "oauth-status"; id: string };

export type OpencodeProviderAuthResult =
  | { action: "status"; providers: SubscriptionStatus[] }
  | {
      action: "start";
      shape: SubscriptionConnectShape;
      url?: string;
      instructions?: string;
      methodIndex?: number;
      // BET-354: when shape === "claude-login", the start response
      // carries the server-generated sessionKey + startedAt for the
      // live-terminal connect card. The renderer then mounts a Terminal
      // pane with that sessionKey (driven via pty:spawn) and polls
      // claude-status on its 1s tick.
      sessionKey?: string;
      startedAt?: number;
      cwd?: string;
    }
  | { action: "code"; ok: boolean; error?: string }
  | { action: "key"; ok: boolean; error?: string }
  | { action: "disconnect"; ok: boolean; error?: string }
  // BET-354: claude-status result. `progress.state === "no-file"` is
  // the keep-polling case; `pre-existing` is a distinct failure (the
  // user already had a working login and the connect was a no-op);
  // `completed` means restartOpencode fired + the connect[ed] probe ran.
  | { action: "claude-status"; ok: boolean; progress?: ClaudeLoginProgress; error?: string }
  | { action: "oauth-status"; state: "pending" | "ok" | "error"; error?: string };
