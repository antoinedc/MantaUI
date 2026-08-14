import { create } from "zustand";
import type {
  AgentFileReady,
  AppConfig,
  DelegateJob,
  OpencodeMessage,
  Project,
  TmuxWindow,
  UsageSnapshot,
  WindowStatus,
} from "../shared/types";
import type { ConnectionState } from "../shared/net/state.js";
import type { SyncPayload } from "../shared/api.js";
import { clientToken } from "./api/httpApi";
import { isAssistantTurnInProgress, runWithConcurrency } from "./chatUtils";
import { applyTheme, type ThemePref } from "./theme";
import type { ToastItem } from "./Toast";
import {
  type ModelSelection,
  readSavedActiveSession,
  writeSavedActiveSession,
} from "./chatShared";

// Background-delegation jobs, keyed by the job's child opencode session id.
// The renderer learns which sidebar windows are jobs (and their per-row
// activity summary) from this slice, and ChatPanel derives whether the panel
// it is viewing is a background job's read-only child. It is fed by a single
// app-level 30s poll in App.tsx / MobileApp.tsx that calls
// window.api.delegateList() (no-arg = all jobs) — exactly one poll, shared by
// desktop and mobile — PLUS an immediate refetch on every `delegate.updated`
// bus event (BET-414) so a new job nests under its parent within ~1s instead
// of waiting for the poll. The renderer never computes the activity text; it
// renders the `activity` field verbatim. The FULL DelegateJob is retained (not
// a reduced {name,status,activity} row) because ChatPanel's ReadOnlyJobBar
// renders a job's branch/files-changed summary and Stop needs its id.

// Cap on simultaneous in-flight requests for the startup opencode fan-outs
// (`replayChatAttention`, `backfillLastMessageTimes`) — see BET-135.
const OPENCODE_FANOUT_CONCURRENCY = 4;

// Monotonic id source for new-session drafts. A plain counter (not
// crypto.randomUUID) keeps store tests deterministic and needs no crypto stub.
let draftSeq = 0;
function newDraftId() {
  return `draft-${++draftSeq}`;
}

// Monotonic id source for app toasts (the global ToastStack). A plain counter
// (not crypto.randomUUID) keeps store tests deterministic, mirroring draftSeq.
let appToastSeq = 0;

// Overlay the desktop-local pairing secrets (serverUrl/boxToken) onto a config
// snapshot. In http mode window.api.configGet() returns the manta-server's config,
// which never carries these — they live only on this desktop, mirrored into
// localStorage by main.tsx (manta_server/manta_token) at boot. Reading them here
// keeps resolveTransportMode() from seeing an empty boxToken and forcing
// onboarding on an already-paired install. A missing/blank local value leaves
// the incoming config field untouched, so this is a no-op on mobile/web and on
// a genuinely-unpaired fresh install.
function mergeLocalPairing(cfg: AppConfig): AppConfig {
  let serverUrl = "";
  try {
    serverUrl = localStorage.getItem("manta_server") ?? "";
  } catch {
    /* localStorage unavailable (private mode / SSR) — treat as no override */
  }
  const boxToken = clientToken() ?? "";
  return {
    ...cfg,
    serverUrl: serverUrl || cfg.serverUrl,
    boxToken: boxToken || cfg.boxToken,
  };
}

// BET-678: persisted local snapshot of the last known sync state, so the
// renderer paints instantly from it on cold boot (zero round trips), then
// syncs via the server's cursor protocol (`syncSnapshot` with the stored
// cursor) and applies live `sync` deltas / reconnect markers.
//
// The payload ALSO persists `stale` (the box-reported unreachability flag)
// so the amber "last known state" indicator survives a cold boot: without it,
// the restored cursor would be sent to the box, which — still being in the
// same stale state — would withhold `stale` (versions.stale === sinceSeq, not
// `> sinceSeq`) and the client would come back looking healthy with no warning.
// Persisting + replaying the flag keeps step 8 honest across restarts.
//
// The cache is scoped by `boxId` so a re-pair to a DIFFERENT box never replays
// the previous box's project list/config on first paint (the cursor protocol
// would self-correct within one round trip, but the surprise paint is worth
// preventing).
//
// `lastRaw*` hold the last RAW payload values so the debounced write
// serializes exactly what was applied. config is stored PRE local-pairing
// overlay (the device-local serverUrl/boxToken are re-derived on load via
// applyConfig→mergeLocalPairing, never baked into the cache).
const SNAPSHOT_KEY = "manta:sync:snapshot";
let lastRawProjects: Project[] = [];
let lastRawConfig: AppConfig | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
// The boxId the snapshot is scoped to. This is the DESKTOP-LOCAL boxId (from
// the pairing config), NOT store.boxId — in http mode the box's own config has
// no boxId (it's a desktop-local field), so store.boxId is "" in normal paired
// operation. Seeded by loadPersistedSnapshot(currentBoxId) at boot; the persist
// path stamps it so the cross-box guard in loadPersistedSnapshot has a real
// value to compare against.
let snapshotBoxId = "";

// Debounced 1s after each applySyncPayload — coalesces a burst of deltas (a
// reconnect re-pull + a follow-up live delta) into one write rather than
// hammering localStorage per envelope.
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { syncGen, syncSeq, boxStale } = useStore.getState();
    if (syncGen == null || syncSeq == null) return;
    const snapshot = {
      gen: syncGen,
      seq: syncSeq,
      boxId: snapshotBoxId,
      projects: lastRawProjects,
      config: lastRawConfig,
      stale: boxStale,
    };
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      /* localStorage unavailable (private mode / SSR) — cache is best-effort */
    }
  }, 1000);
}

// Cold-boot restore: parse the persisted snapshot and apply it through
// applySyncPayload so the cursor + projects/config/boxStale all come up in
// one shot, then the box takes over via the cursor RPC. Any parse/shape error
// drops the key and returns null (fall back to a normal server boot). A
// snapshot stamped for a DIFFERENT boxId is dropped too (re-pair — see above).
// Called from main.tsx BEFORE the React root renders, only on the paired/http
// path, passing the paired box's desktop-local boxId. On a subsequent launch
// after a re-pair, main.tsx passes the NEW box's boxId, so any snapshot stamped
// for the previous box is dropped by the guard below.
export function loadPersistedSnapshot(currentBoxId?: string): void {
  // Record the box the CURRENT boot is scoped to — used by schedulePersist to
  // stamp the write, and by the guard below to detect a re-pair. Must be set
  // even when there's nothing to restore, so a later persist uses the right id.
  snapshotBoxId = currentBoxId ?? "";
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SNAPSHOT_KEY);
  } catch {
    return; // localStorage unavailable — nothing to restore
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
    return;
  }
  const s = parsed as {
    gen?: unknown;
    seq?: unknown;
    projects?: unknown;
    config?: unknown;
    boxId?: unknown;
    stale?: unknown;
  };
  if (
    typeof s?.gen !== "string" ||
    typeof s?.seq !== "number" ||
    !Array.isArray(s.projects) ||
    typeof s.config !== "object" ||
    s.config === null
  ) {
    // Corrupt/incomplete shape — drop it and fall back to a server boot.
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
    return;
  }
  // Cross-box bleed guard: a snapshot owned by a different box must not
  // briefly show that box's sessions/config. Drop it (no restore).
  if (
    typeof s.boxId === "string" &&
    s.boxId !== "" &&
    snapshotBoxId !== "" &&
    s.boxId !== snapshotBoxId
  ) {
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
    return;
  }
  useStore.getState().applySyncPayload({
    gen: s.gen,
    seq: s.seq,
    changed: {
      projects: s.projects as Project[],
      config: s.config as AppConfig,
      stale: typeof s.stale === "boolean" ? s.stale : false,
    },
  });
}

// "Active session" in our UI = (projectName, windowIndex) tuple
export type ActiveSession = {
  projectName: string;
  windowIndex: number;
};

// A pre-commit "new session" draft: an in-memory composer that owns the typed
// prompt + folder/model/worktree choices BEFORE any tmux window or opencode
// session exists. It lives in the store (not component state) so navigating
// away from it and back loses nothing. `mode` decides what commit creates:
// "new-project" = a new tmux session (project); { projectName } = a window in
// an existing project. The ACTIVE view is either a real session
// (activeProjectName / activeWindowByProject) or a draft (activeDraftId).
export type NewSessionDraft = {
  id: string;
  mode: "new-project" | { projectName: string };
  cwd: string;
  wantWorktree: boolean;
  worktreeBranch: string;
  // null = auto / not explicitly picked (presentational only until submit).
  model: ModelSelection | null;
  modelTouched: boolean;
  input: string;
};

// Per-window UI status: live `running`/`subagents` from the poller, plus an
// `attention` flag we set locally on the running→idle transition and clear
// when the user opens the window.
//
// `attentionKind` discriminates WHY the window is asking for attention so
// the sidebar can render distinct affordances:
//   - "idle"       → claude finished, user hasn't visited the window yet
//                    (amber dot, no urgency)
//   - "question"   → opencode's Question tool fired — AI is BLOCKED waiting
//                    on the user (red dot + `?` label)
//   - "permission" → opencode's permission.asked fired — AI is BLOCKED
//                    waiting on permission approval (red dot + `!` label)
// `attention` (boolean) remains the gate; `attentionKind` is meaningful
// only when `attention === true`. Defaults to "idle" when unset for
// backward compat with the existing poller-driven flow.
export type AttentionKind = "idle" | "question" | "permission" | "blocked";
// `lastMessageAt` (unix ms, BET-119) is stamped whenever a chat-mode
// session's `running` value CHANGES (either direction — idle→running marks
// a new user message, running→idle marks the assistant completion) by
// `setChatRunning`, and backfilled on cold start by
// `backfillLastMessageTimes()`. Drives the sidebar/mobile elapsed-time label
// colored by prompt-cache TTL freshness (`classifyCacheAge`). Undefined for
// TUI (non-chat) windows — the TTL concept only applies to opencode chat
// sessions, and the sidebar gates the label on this field being set.
export type WindowStatusUI = {
  running: boolean;
  subagents: number;
  attention: boolean;
  attentionKind?: AttentionKind;
  lastMessageAt?: number;
  /** BET-791: the model-authored progress label for a working turn, surfaced
   *  in the rail row's title tooltip (the subagent count's home). Pushed by
   *  the owning ChatPanel via setChatProgressLabel; null/absent = no label. */
  progressLabel?: string;
};

// A screenshot the OS-level detector saw, waiting for the user to attach or
// discard it. App.tsx owns the single detection listener and READS THE BYTES
// THERE, once, so this record is self-contained: nothing downstream has to go
// back to the clipboard or the disk (the clipboard can have changed by then —
// that was a real race in the old accept path).
export type PendingScreenshot = {
  id: string;
  filename: string;
  // The PNG bytes, read at detection time. Uploaded verbatim on accept.
  bytes: ArrayBuffer;
  // Object URL over `bytes`, for the strip's <img>. Created in App.tsx when
  // the record is made, revoked by removePendingScreenshots when it is
  // dropped — so creation and revocation are each in exactly one place.
  previewUrl: string;
};

type State = {
  loaded: boolean;
  // BET-678: the sync cursor + stale flag. `syncGen`/`syncSeq` are the client's
  // last-confirmed cursor, sent back to the box on every syncSnapshot call so
  // it returns only the deltas we missed. `boxStale` is true when the box's
  // last refresh tick couldn't reach tmux — the sidebar shows an amber "last
  // known state" indicator and keeps serving the last good list.
  syncGen: string | null;
  syncSeq: number | null;
  boxStale: boolean;
  // ----- HTTP transport + onboarding (M6, BET-49) -----
  // Mirrored from AppConfig so App.tsx can resolve the transport mode
  // (resolveTransportMode) and the onboarding shell can resume. `boxToken`
  // presence flips transport to HTTP; `onboardingSkipped` suppresses the
  // onboarding flow on an otherwise-empty config.
  serverUrl: string;
  boxId: string;
  boxToken: string;
  onboardingSkipped: boolean;
  // True when the user explicitly re-launched onboarding from Settings
  // ("Run setup again"). This FORCES the onboarding shell even for a config
  // that would otherwise resolve to "http" mode (e.g. an already-paired
  // box). Cleared when the flow completes or is skipped. Not persisted.
  onboardingForced: boolean;
  // Deep-link pairing (BET-240): the raw manta://pair?… URL delivered by the
  // OS protocol handler. Set in App.tsx when the preload pushes a URL, read
  // by Onboarding (to force step 1) and PairStep (to prefill the paste field).
  // Cleared once consumed. Not persisted — purely transient routing state.
  pendingPairLink: string | null;
  // Deep-link pairing: why the last auto-claim failed, surfaced inline by
  // PairStep. The auto-claim runs with no visible UI, so without this the
  // failure reason (wrong/expired code, unreachable box, malformed link) was
  // computed and then discarded — the user saw a blank form and no cause.
  pairLinkError: string | null;
  chatAutoAllow: boolean;
  // Auto-rename chat-mode windows from the conversation (opt-in). See
  // AppConfig.autoRenameSessions.
  autoRenameSessions: boolean;
  // BET-738: show the composer usage dial even when every window is under
  // 70% (the dial's normal "quiet unless it matters" threshold). Settings-
  // only — rides the generic configUpdate path. See AppConfig.alwaysShowUsage.
  alwaysShowUsage: boolean;
  // BET-782: ids of session-header status items the user has permanently
  // hidden (never rendered in the bar or the overflow dropdown). Mirror of
  // AppConfig.hiddenStatusItems; read by SessionHeader's registry.
  hiddenStatusItems: string[];
  // BET-789: the one-line "Connect GitHub…" offer under the session header
  // has been permanently dismissed. Mirror of AppConfig.forgeConnectOfferDismissed;
  // read by SessionHeader to decide whether to surface the offer.
  forgeConnectOfferDismissed: boolean;
  // Agent → laptop push trust flag. When true, files the AI drops in its
  // remote outbox are pulled to the downloads dir without confirmation.
  allowAgentPush: boolean;
  // BET-246: per-session git-worktree creation default (Settings → Files
  // tab). Mirrors AppConfig.worktreePerSession. The new-session dialog
  // seeds its checkbox from this value and lets the user override for
  // one window. Settings-only — rides the generic configUpdate channel.
  worktreePerSession: boolean;
  // BET-246: when true, closing a session whose @manta-worktree-path
  // user-option is set removes the worktree (and best-effort deletes its
  // branch) first. Global only — no per-session override.
  worktreeCleanOnClose: boolean;
  // BET-427: hours a dragged-in upload's batch dir survives on the box before
  // the hourly server-side sweep deletes it. 0 disables cleanup. Box-server
  // config key — applies to uploads from both desktop and mobile. Default 24.
  uploadCleanupHours: number;
  // BET-834: hours a voice note's audio survives before the sweep deletes it
  // (voiceNotes.mjs). 0 = keep forever. Default 168. Transcript/peaks kept.
  voiceNoteTtlHours: number;
  // Override destination for agent-pushed files. "" = main's default (~/Downloads).
  downloadsDir: string;
  // Global default model for new/cleared sessions. Set in Settings, persisted
  // to config.json. null = let opencode pick its default.
  defaultModel: { providerID: string; modelID: string } | null;
  // Models the user has hidden from the chat main-agent picker (BET-215).
  // "providerID/modelID" strings; absent/empty = every model is Main-available.
  // Mirror of AppConfig.deactivatedMainModels; read by ModelPicker.
  deactivatedMainModels: string[];
  // User-added skill registry URLs (written to remote opencode.jsonc on save).
  skillRegistryUrls: string[];
  // Anthropic prompt cache TTL — drives the "/clear to save Nk tokens"
  // pill in ChatPanel's footer. Display-only (manta doesn't set the actual
  // cache_control.ttl on requests — opencode does); must match opencode's
  // setting. Defaults to "1h".
  cacheTtl: "5m" | "1h";
  // Per-launcher CLI flag overrides for AI CLI TUI launch modes (BET-138
  // refinement). Keyed by launcher id, then flag key; missing keys fall back
  // to the launcher's registry default (see resolveLauncherFlags). Empty
  // object = no user overrides for any launcher.
  launcherFlags: Record<string, Record<string, boolean>>;
  // Voice / Groq STT. `groqApiKey` is the gating signal — empty string
  // means voice features are unavailable and the mic button stays hidden.
  // The transcription model defaults to "" so the main/server picks the
  // built-in default (whisper-large-v3-turbo).
  groqApiKey: string;
  voiceTranscriptionModel: string;
  // Analytics opt-out (BET-217). Default true; false = this instance ships
  // nothing to Axiom (desktop renderer + server). Mobile always ships
  // regardless. Mirror of AppConfig.shareAnalytics.
  shareAnalytics: boolean;
  // BET-409: colour theme preference. "system" follows the OS and re-themes
  // live; "light"/"dark" pin. Mirror of AppConfig.theme. applyConfig pushes
  // the resolved value to <html data-theme> via applyTheme so every config
  // load (desktop refresh, mobile pairing, Settings save) keeps the DOM in
  // sync — not just the initial boot application in main.tsx.
  theme: ThemePref;
  // BET-414: sidebar pinned window ids (`<tmuxSession>/<windowIndex>`). Mirror
  // of AppConfig.pinnedWindows. The sidebar's pinned section renders these at
  // the top of the rail; pinned windows are excluded from their workspace
  // group. togglePin optimistic-updates + persists via configUpdate.
  pinnedWindows: string[];
  // BET-414: ⌘K palette recency. Most-recently-activated-first list of
  // `<tmuxSession>/<windowIndex>` ids, updated on every setActive(). Drives
  // the empty-query palette ordering ("recent sessions" per spec). In-memory
  // only (not persisted) — session-level recency is sufficient for the
  // palette; persistence would need a config schema change out of scope here.
  // Windows never activated fall through to flatSessions order after the
  // recent ones.
  recentWindows: string[];
  projects: Project[];
  activeProjectName: string | null;
  activeWindowByProject: Record<string, number>; // projectName -> windowIndex
  // ACTIVE new-session draft id (see NewSessionDraft), or null when the active
  // view is a real session. Mutually exclusive with the session active state in
  // the sense that navigating to a real session (setActive) clears it.
  activeDraftId: string | null;
  drafts: NewSessionDraft[];
  // A one-shot prompt for a freshly-created chat session to auto-submit on its
  // first mount (draft → new-session flow). Consumed (cleared) by the panel
  // once it fires, so re-navigating to the session never re-sends it.
  autoSubmitPrompt: { sid: string; text: string; model?: ModelSelection } | null;
  // BET-795: a one-shot composer SEED — the inbox's "Start a session" lands in
  // a chat session with the prompt seeded into the composer but NOT submitted
  // (the user reviews + hits Enter). Delivered to the session's ChatPanel like
  // autoSubmitPrompt, but the panel only fills the input — no submit().
  seedPrompt: { sid: string; text: string } | null;
  // sessionName -> windowIndex -> status
  status: Record<string, Record<number, WindowStatusUI>>;
  // Background-delegation jobs keyed by childSessionID (BET-381). Drives the
  // sidebar's per-row activity second line (desktop + mobile). Fed by the
  // single app-level 10s poll — see JobRow comment above.
  jobs: Record<string, DelegateJob>;
  // BET-738: subscription plan usage snapshots (one per connected provider),
  // fed by the composer's UsageDial. Primed once with window.api.usageList()
  // on mount and kept live by the `usage.updated` bus event — App.tsx does
  // NOT poll this; the box's usage poller (src/server/usage.mjs) is the only
  // timer. Empty array = no snapshots yet (or no provider connected).
  usage: UsageSnapshot[];
  // BET-659: per-session live transcript, lifted from each ChatPanel so the
  // Artifacts panel (mounted as a sibling of <main> in App.tsx) can derive
  // artifacts WITHOUT a second opencodeMessages fetch. Keyed by sessionId,
  // written by ChatPanel when its own transcript state changes.
  chatMessages: Record<string, OpencodeMessage[]>;
  // Screenshots waiting to be attached — see PendingScreenshot. A LIST, not a
  // slot: taking three screenshots in a row must show three, and it never
  // expires on its own.
  pendingScreenshots: PendingScreenshot[];
  // Single global agent-file toast: a file the remote AI pushed to its outbox.
  // Single-instance pattern — App.tsx owns the one ipcRenderer listener, the
  // active ChatPanel renders the toast, accept / dismiss clear it globally. In
  // auto-pull (trust) mode it's informational (autoPulled:true, localPath set);
  // otherwise it's a Save/dismiss prompt.
  agentFileToast: AgentFileReady | null;
  // Transient app-level notices (errors + info) shown by the global ToastStack
  // (BET-723). Replaces every native alert() in the renderer. Capped at 5;
  // each has its own id, dismissible via dismissAppToast.
  appToasts: ToastItem[];
  pushAppToast: (t: Omit<ToastItem, "id"> & { id?: string }) => void;
  dismissAppToast: (id: string) => void;
  // Ephemeral user-invoked system notice (/help reference text) shown by the
  // global ToastStack. Moved up from ChatPanel to the store so the App-level
  // toast host can render it over every pane type.
  systemNotice: string | null;
  setSystemNotice: (t: string | null) => void;
  // Single global auto-update prompt. Set when main pushes an
  // updateDownloaded event (electron-updater finished downloading a new
  // version). The renderer shows a "Restart to update" bar; clicking it
  // calls autoUpdateInstall which quits + reinstalls. Dismissed by the ×
  // button (clears the state — the bar won't reappear until the next
  // updateDownloaded event). Guarded — the mobile httpApi shim's
  // onAutoUpdate* are no-ops, so this is desktop-only.
  updatePrompt: { version: string; releaseName?: string } | null;
  // A TERMINAL auto-update failure (integrity / permission). Set from main's
  // autoUpdate:error IPC, which only fires for failures the user must act on
  // — transient network errors are filtered server-side of the bridge.
  //
  // This exists because updater errors were previously swallowed into a
  // console.warn. When the published update feed's checksum stopped matching
  // the published binary, every launch failed verification in silence and the
  // app simply never updated — across two releases, diagnosed only when a
  // shipped fix was reported as missing.
  updateError: { message: string; raw: string } | null;
  // BET-640: a box that doesn't implement a channel the renderer polls (the
  // background-jobs endpoint on a box that predates delegation) surfaces as a
  // persistent empty sidebar, indistinguishable from "no jobs running". When
  // the job poll's error says "unknown rpc channel", flip this flag ONCE to
  // show the existing incompatible banner instead of rendering nothing.
  boxIncompatible: boolean;
  // Single global server-update prompt (BET-225 stage 3). Set when the box's
  // server-update poller (src/server/serverUpdate.mjs) publishes a
  // `serverUpdateAvailable` bus event after polling its version manifest.
  // The renderer shows a "Server update available: {version}" bar; clicking
  // the button calls serverUpdateApply which runs `scripts/self-update.sh`
  // on the box (git fetch + reset --hard origin/main + npm ci --omit=dev
  // + systemctl --user restart manta-server). Dismissed by the × button
  // (clears the state — the bar won't reappear until the bus fires again
  // for a STRICTLY newer version; the server-side dedup gate mirrors this
  // exactly, see src/server/serverUpdate.mjs).
  serverUpdatePrompt: { version: string; notesUrl?: string | null } | null;
  // Live progress of an in-flight box self-update. Set from the box's
  // `serverUpdateProgress` bus events (one per MANTA_PROGRESS marker the
  // self-update script emits). null when no update is running; drives the
  // UpdateBar's determinate progress bar. Mirrors the serverUpdatePrompt
  // shape/lifecycle (a plain state + setter pair).
  serverUpdateProgress: { step: number; total: number; label: string } | null;
  // Live events-WebSocket connection state (from the shared
  // ConnectionState machine). Surface to the UI so a title-bar pill can
  // show "reconnecting…" when the link is down. Updated by the httpApi
  // reconnect controller via setConnectionState; read by App.tsx.
  connectionState: ConnectionState;
  // True while the startup opencode fan-out (`runBackgroundSync`) is running
  // — surfaced as a subtle "Syncing…" indicator in the sidebar so a momentary
  // slowdown from bounded-concurrency fetches reads as "syncing", not
  // "frozen" (BET-135). False the rest of the time.
  backgroundSyncing: boolean;
  // Deterministic clock for elapsed-time labels (Sidebar's session-age
  // chip, ChatPanel's running-indicator "X minutes ago"). When the demo
  // mode hero video renders (BET-322), this is set per-frame from
  // `DEMO_T0 - t*1000` so two consecutive renders are byte-comparable
  // (no `Date.now()` leakage in labels). Real apps leave it null and
  // `nowMs()` in src/renderer/clock.ts falls back to `Date.now()`.
  videoRenderNow: number | null;
  // BET-420: raised by Settings cards whose changes need an opencode restart
  // to take effect (subagent toggles, endpoint add/remove/toggle). The
  // Settings panel renders ONE restart banner from this flag — replacing the
  // three per-card restart prompts that used to live in ModelsCard,
  // ProvidersCard and ConnectProvider. Cleared by the banner's restart button
  // (and by any other path that restarts opencode, e.g. ConnectProvider's
  // connect-completion restart). Desktop-only concept; mobile keeps its own
  // inline restart prompt inside ProvidersCard.
  opencodeRestartNeeded: boolean;
  setOpencodeRestartNeeded: (v: boolean) => void;
  // ----- derived selectors -----
  activeSession: () => ActiveSession | null;
  // A minimal AppConfig-shaped snapshot of the onboarding-relevant fields,
  // for the pure helpers in shared/transport (resolveTransportMode) and
  // onboardingUtils (resolveInitialStep). Avoids threading the raw config
  // object through the store just for onboarding.
  configSnapshot: () => Partial<AppConfig>;
  // ----- mutations -----
  setActive: (projectName: string, windowIndex?: number) => void;
  // Activate a tmux window locally AND on the box (so the PTY follows). Shared
  // by the sidebar, the ⌥⌘↑↓ / ⌘1..9 / voice-switch / ⌘F jump, the new-session
  // flow, and the fan-out flow — every call site used to repeat this
  // setActive + tmuxSelectWindow pair. `setActive` updates the store; the box
  // select focuses the window (making the PTY follow). Returns the
  // tmuxSelectWindow promise so each caller keeps its own error handling (they
  // differ). Call sites with extra behavior (e.g. Sidebar's only-select-when-
  // already-active guard) keep it around the call, not here.
  activateWindow: (projectName: string, windowIndex: number) => Promise<void>;
  // New-session draft lifecycle (see NewSessionDraft). createDraft makes +
  // activates a fresh draft; updateDraft patches one (typed prompt, folder,
  // model…); dismissDraft abandons it (committed or cancelled) and re-points
  // the active view; setActiveDraft brings a draft to the foreground. Note
  // setActive (below) exits any draft view by clearing activeDraftId.
  createDraft: (mode: NewSessionDraft["mode"]) => string;
  updateDraft: (id: string, patch: Partial<NewSessionDraft>) => void;
  dismissDraft: (id: string) => void;
  setActiveDraft: (id: string) => void;
  setAutoSubmitPrompt: (
    p: { sid: string; text: string; model?: ModelSelection } | null,
  ) => void;
  setSeedPrompt: (p: { sid: string; text: string } | null) => void;
  refresh: () => Promise<void>;
  // Onboarding lifecycle. `skipOnboarding` persists onboardingSkipped (so the
  // flow doesn't re-trigger) and clears the forced flag. `relaunchOnboarding`
  // clears onboardingSkipped and sets the forced flag so App re-renders the
  // shell ("Run setup again" in Settings). `finishOnboarding` clears the
  // forced flag + re-reads config so the app drops to the normal shell
  // without a restart.
  skipOnboarding: () => Promise<void>;
  relaunchOnboarding: () => Promise<void>;
  finishOnboarding: () => Promise<void>;
  // Persist the global default model (onboarding Step 3 + Settings share this
  // config field). Optimistic set + configUpdate + reconcile, matching the
  // other config setters. New/cleared sessions inherit it (see ChatPanel's
  // configDefaultModel), so it must survive restart — hence the config write.
  setDefaultModel: (model: { providerID: string; modelID: string }) => Promise<void>;
  applyProjects: (projects: Project[]) => void;
  applyConfig: (c: AppConfig) => void;
  // BET-678: apply one sync payload — routes each changed field to the right
  // applier, advances the cursor, and schedules the persisted snapshot write.
  // Owns the stale-envelope guard: envelopes at the same generation with a
  // lower/equal seq are ignored (already applied, or superseded by a newer
  // snapshot).
  applySyncPayload: (p: SyncPayload) => void;
  // Reflect a successful onboarding claim (BET-49-T2) into store state so
  // resolveTransportMode reads "http" immediately. main already persisted these
  // to config.json via the auth:claim handler; this just mirrors them so the
  // onboarding shell can advance without a full config re-read.
  applyPairing: (p: { serverUrl: string; boxId: string; boxToken: string }) => void;
  applyStatusBatch: (batch: WindowStatus[]) => void;
  // Replace the jobs slice from an app-level poll (BET-381). Accepts the raw
  // DelegateJob[] from delegateList() and keys the full objects by
  // childSessionID (ChatPanel + the sidebar both read the full job).
  setJobs: (jobs: DelegateJob[]) => void;
  // Replace the usage slice (BET-738) from window.api.usageList() or the
  // `usage.updated` bus payload. Both hand over the full current array —
  // this is a straight replace, not a merge (the poller's contract is "the
  // current cache", not a diff).
  setUsage: (usage: UsageSnapshot[]) => void;
  // Chat-mode running state driven by opencode SSE (session.status /
  // session.idle / session.error). The PTY-pane poller can't see chat
  // windows' state — the holder runs `sleep infinity`, not claude — so
  // without this the sidebar dot would always be off for chat-mode
  // even mid-generation. Same store map (status[session][windowIndex]),
  // same UI; just a different update path. Owning window is resolved
  // from `sessionId` via the active projects tree.
  setChatRunning: (sessionId: string, running: boolean) => void;
  // Chat-mode attention signals driven by opencode SSE. `question.asked`
  // (AI is blocked waiting for the user to pick an answer) and
  // `permission.asked` (AI is blocked waiting for tool-use approval)
  // both flip `attention:true` with a distinct `attentionKind`. Cleared
  // by `setActive` when the user opens the window (existing behavior)
  // OR by the matching `*.replied` / `*.rejected` event flowing through
  // this action with kind="idle" — the kind transition tracks whether
  // any of the higher-urgency signals is still pending.
  setChatAttention: (
    sessionId: string,
    kind: AttentionKind | null,
  ) => void;
  // Chat-mode subagent count driven by ChatPanel's task-tool inspection
  // (`countRunningSubagents` over the live transcript + child status). The
  // PTY poller's regex (`● Task(...)` + `⎿ Running…`) can't see chat-mode
  // windows because their pane runs `sleep infinity` — without this update
  // path the sidebar `·N` indicator would always be 0 for chat windows.
  // Owning window is resolved from `sessionId` via `resolveSessionOwner`.
  setChatSubagents: (sessionId: string, count: number) => void;
  // BET-791: reflect a chat-mode window's model-authored progress label into
  // the store so the rail row's title tooltip (the subagent count's home) can
  // carry it. Owning window resolved from `sessionId`; label null clears.
  setChatProgressLabel: (sessionId: string, label: string | null) => void;
  // BET-659: reflect a chat-mode window's live transcript into the store so
  // the Artifacts panel can derive artifacts from it. No-op when unchanged
  // (same guard as setChatSubagents) so keystroke re-renders of ChatPanel —
  // which leave the `messages` reference stable — don't re-emit the whole
  // array to every store subscriber.
  setChatMessages: (sessionId: string, messages: OpencodeMessage[]) => void;
  // One-shot startup replay of chat-mode attention. opencode's SSE stream is
  // forward-only — it does NOT re-emit `question.asked` / `permission.asked`
  // for requests that were already pending when the app (re)connected. So on
  // restart a window blocked on a question/permission shows no sidebar dot
  // until the user manually focuses the window. This action queries the live
  // pending state per chat-window (the /question + /permission lists are
  // `?directory=`-scoped, so we MUST query per-session, not globally) and
  // latches the attention indicator for any still-pending request. Safe to
  // call repeatedly; it only ever sets attention for genuinely-pending asks.
  replayChatAttention: () => Promise<void>;
  // Cold-start backfill for `lastMessageAt` (BET-119). Live updates come
  // from `setChatRunning` via opencode SSE, but a freshly (re)connected app
  // has seen no SSE transitions yet, so every chat window would show no age
  // label until its next busy/idle flip. Queries each chat-mode window's
  // owning directory via opencodeListSessions and stamps `lastMessageAt`
  // from `time.updated` — ONLY for windows that don't already have a live
  // stamp, so this can never stomp a real SSE-driven value. Called from the
  // same App.tsx/MobileApp.tsx effect as `replayChatAttention` (keyed on the
  // chat-session set). Safe to call repeatedly.
  backfillLastMessageTimes: () => Promise<void>;
  // Runs `replayChatAttention` + `backfillLastMessageTimes` together (as
  // App.tsx/MobileApp.tsx already did — both fire-and-forget in parallel)
  // while toggling `backgroundSyncing` around the pair, so the sidebar can
  // show a "Syncing…" indicator for the duration. Behavior of the two
  // fan-outs themselves is unchanged; this is scheduling + a flag only.
  runBackgroundSync: () => Promise<void>;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  setAutoRenameSessions: (v: boolean) => Promise<void>;
  // BET-414: toggle a window's pin. Optimistic set + configUpdate + reconcile.
  // The id is `<tmuxSession>/<windowIndex>` (see windowPinId in chatUtils.ts).
  togglePin: (pinId: string) => Promise<void>;
  addPendingScreenshot: (s: PendingScreenshot) => void;
  // Removes by id and revokes each removed record's previewUrl. Takes an
  // ARRAY so "discard one", "accept one" and "accept all" are one code path.
  removePendingScreenshots: (ids: string[]) => void;
  setAgentFileToast: (t: AgentFileReady | null) => void;
  setUpdatePrompt: (p: { version: string; releaseName?: string } | null) => void;
  setUpdateError: (p: { message: string; raw: string } | null) => void;
  setBoxIncompatible: (b: boolean) => void;
  setServerUpdatePrompt: (
    p: { version: string; notesUrl?: string | null } | null,
  ) => void;
  setServerUpdateProgress: (
    p: { step: number; total: number; label: string } | null,
  ) => void;
  // Deep-link pairing (BET-240): write/clear the pending pair link. Pass
  // null to consume (PairStep clears on use); App.tsx writes the URL when
  // the preload's pair:link-received IPC fires.
  setPendingPairLink: (url: string | null) => void;
  setPairLinkError: (message: string | null) => void;
  setConnectionState: (s: ConnectionState) => void;
};

export const useStore = create<State>((set, get) => ({
  loaded: false,
  syncGen: null,
  syncSeq: null,
  boxStale: false,
  serverUrl: "",
  boxId: "",
  boxToken: "",
  onboardingSkipped: false,
  onboardingForced: false,
  pendingPairLink: null,
  pairLinkError: null,
  chatAutoAllow: false,
  autoRenameSessions: false,
  alwaysShowUsage: false,
  hiddenStatusItems: [],
  forgeConnectOfferDismissed: false,
  allowAgentPush: false,
  worktreePerSession: false,
  worktreeCleanOnClose: false,
  uploadCleanupHours: 24,
  voiceNoteTtlHours: 168,
  downloadsDir: "",
  defaultModel: null,
  deactivatedMainModels: [],
  skillRegistryUrls: [],
  cacheTtl: "1h",
  launcherFlags: {},
  groqApiKey: "",
  voiceTranscriptionModel: "",
  shareAnalytics: true,
  theme: "system",
  pinnedWindows: [],
  recentWindows: [],
  projects: [],
  activeProjectName: null,
  activeWindowByProject: {},
  activeDraftId: null,
  drafts: [],
  autoSubmitPrompt: null,
  seedPrompt: null,
  status: {},
  jobs: {},
  usage: [],
  chatMessages: {},
  pendingScreenshots: [],
  agentFileToast: null,
  appToasts: [],
  systemNotice: null,
  updatePrompt: null,
  updateError: null,
  boxIncompatible: false,
  serverUpdatePrompt: null,
  serverUpdateProgress: null,
  connectionState: { state: "idle" },
  backgroundSyncing: false,
  videoRenderNow: null,
  opencodeRestartNeeded: false,

  configSnapshot: () => {
    const s = get();
    return {
      serverUrl: s.serverUrl,
      boxId: s.boxId,
      boxToken: s.boxToken,
      onboardingSkipped: s.onboardingSkipped,
      defaultModel: s.defaultModel ?? undefined,
      projects: s.projects.map((p) => ({
        tmuxSession: p.tmuxSession,
        defaultCwd: p.defaultCwd,
      })),
    };
  },

  activeSession: () => {
    const s = get();
    if (!s.activeProjectName) return null;
    const proj = s.projects.find((p) => p.tmuxSession === s.activeProjectName);
    if (!proj || proj.windows.length === 0) return null;
    const idx =
      s.activeWindowByProject[s.activeProjectName] ??
      proj.windows.find((w) => w.active)?.index ??
      proj.windows[0].index;
    return { projectName: s.activeProjectName, windowIndex: idx };
  },

  setActive: (projectName, windowIndex) => {
    const prev = get();
    const proj = prev.projects.find((p) => p.tmuxSession === projectName);
    const w =
      windowIndex ??
      prev.activeWindowByProject[projectName] ??
      proj?.windows.find((x) => x.active)?.index ??
      proj?.windows[0]?.index ??
      0;
    // Remember where the user is so a refresh / relaunch can restore it
    // (applyProjects reads this when there's no valid selection yet).
    writeSavedActiveSession({ project: projectName, window: w });
    set((prev) => {
      // Opening a window clears its "needs attention" flag.
      const status = clearAttention(prev.status, projectName, w);
      // BET-414: bump this window to the front of the recency list (⌘K palette
      // empty-query ordering). Dedupe + prepend; cap to avoid unbounded growth.
      const pinId = `${projectName}/${w}`;
      const recentWindows = [pinId, ...prev.recentWindows.filter((p) => p !== pinId)].slice(0, 64);
      return {
        activeProjectName: projectName,
        activeWindowByProject: {
          ...prev.activeWindowByProject,
          [projectName]: w,
        },
        // Navigating to a real session exits any "new session" draft view.
        activeDraftId: null,
        status,
        recentWindows,
      };
    });
  },

  activateWindow: (projectName, windowIndex) => {
    get().setActive(projectName, windowIndex);
    return window.api.tmuxSelectWindow({
      sessionName: projectName,
      windowIndex,
    });
  },

  createDraft: (mode) => {
    const id = newDraftId();
    const worktreePerSession = get().worktreePerSession;
    set((prev) => ({
      drafts: [
        ...prev.drafts,
        {
          id,
          mode,
          cwd: mode === "new-project" ? "~" : "",
          wantWorktree: mode === "new-project" ? false : worktreePerSession ?? true,
          worktreeBranch: "worktree",
          model: null,
          modelTouched: false,
          input: "",
        },
      ],
      activeDraftId: id,
    }));
    return id;
  },
  updateDraft: (id, patch) =>
    set((prev) => ({
      drafts: prev.drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
  dismissDraft: (id) =>
    set((prev) => {
      const drafts = prev.drafts.filter((d) => d.id !== id);
      let activeDraftId = prev.activeDraftId;
      if (activeDraftId === id) {
        // Re-point the active view at another draft (prefer a surviving
        // new-project draft), else fall back to the session view (null).
        activeDraftId =
          drafts.find((d) => d.mode === "new-project")?.id ??
          drafts[0]?.id ??
          null;
      }
      return { drafts, activeDraftId };
    }),
  setActiveDraft: (id) => set({ activeDraftId: id }),
  setAutoSubmitPrompt: (p) => set({ autoSubmitPrompt: p }),
  setSeedPrompt: (p) => set({ seedPrompt: p }),

  refresh: async () => {
    // GUARD (fresh-install deadlock): on an UNPAIRED desktop boot main.tsx
    // never installs httpApi (desktopHttpClientSeed is null without a
    // serverUrl + valid boxToken), so `window.api` is still the Electron
    // preload OS-bridge — which has no `syncSnapshot` (httpApi-only). Calling
    // it unguarded throws, App's bootstrap classifies the TypeError as a
    // transient failure and retries every 10s forever, `applyConfig` never
    // runs, `loaded` stays false — and App's onboarding gate
    // (`loaded && …resolveTransportMode(…) === "onboarding"`) can therefore
    // NEVER fire. The user gets an infinite spinner with an empty workspace
    // list instead of the pairing wizard. `configGet` exists on BOTH
    // transports, and the local config is the only thing an unpaired app can
    // (or should) load — there is no box to sync with yet. Onboarding.tsx's
    // refreshAndInstallTransport documents the same hazard on the post-pair
    // path; this is the pre-pair half.
    if (!window.api.syncSnapshot) {
      get().applyConfig(mergeLocalPairing(await window.api.configGet()));
      return;
    }
    // BET-678: single cursor RPC. Pass the last-confirmed cursor so the box
    // returns only the deltas we missed (or a full snapshot when the cursor
    // is absent / a new server generation). ApplySyncPayload routes each
    // changed field, updates the cursor, and persists the snapshot.
    const payload = await window.api.syncSnapshot({
      sinceSeq: get().syncSeq ?? undefined,
      sinceGen: get().syncGen ?? undefined,
    });
    get().applySyncPayload(payload);
  },

  applySyncPayload: (p) => {
    // Ignore stale envelopes: the same generation at a lower/equal seq has
    // already been applied (or a newer snapshot supersedes it).
    const cur = get();
    if (p.gen === cur.syncGen && (cur.syncSeq == null || p.seq <= cur.syncSeq)) return;
    if (p.changed.config) {
      lastRawConfig = p.changed.config;
      // The box's config structurally lacks the desktop-local pairing secrets;
      // overlay them so applyConfig doesn't blank the pairing and flip the app
      // back into onboarding on every refresh. The overlay is NOT persisted
      // (lastRawConfig holds the raw value; secrets are device-local).
      get().applyConfig(mergeLocalPairing(p.changed.config));
    }
    if (p.changed.projects) {
      lastRawProjects = p.changed.projects;
      get().applyProjects(p.changed.projects);
    }
    if ("stale" in p.changed) {
      set({ boxStale: !!p.changed.stale });
    }
    set({ syncSeq: p.seq, syncGen: p.gen });
    schedulePersist();
  },

  skipOnboarding: async () => {
    set({ onboardingSkipped: true, onboardingForced: false });
    const next = await window.api.configUpdate({ onboardingSkipped: true });
    // Reconcile with what main actually saved (error/reject paths).
    set({ onboardingSkipped: next.onboardingSkipped ?? false });
  },

  relaunchOnboarding: async () => {
    // Clear the persisted skip flag and force the shell open, even if the
    // config would otherwise resolve to http/ssh mode (already paired). The
    // local `set` is what actually forces onboarding open; persisting the
    // skip flag is best-effort.
    set({ onboardingSkipped: false, onboardingForced: true });
    // GUARD: on a fresh/unpaired desktop boot window.api is still the preload
    // OS-bridge (no configUpdate — that lives only on httpApi). Calling it
    // unguarded throws "configUpdate is not a function", which — when this is
    // invoked from the deep-link onPairLink handler — aborted pairing-link
    // prefill (BET-240 regression). Skip the persist when the method is absent.
    if (!window.api.configUpdate) return;
    try {
      const next = await window.api.configUpdate({ onboardingSkipped: false });
      set({ onboardingSkipped: next.onboardingSkipped ?? false });
    } catch {
      /* config persist is best-effort; onboardingForced already forced open */
    }
  },

  setPendingPairLink: (url) => set({ pendingPairLink: url }),

  setPairLinkError: (message) => set({ pairLinkError: message }),

  finishOnboarding: async () => {
    // Drop the force flag and re-read config so the app transitions to the
    // normal shell without an app restart (picks up boxToken/projects the
    // per-step components persisted).
    set({ onboardingForced: false });
    await get().refresh();
  },

  applyConfig: (c) => {
    set({
      loaded: true,
      serverUrl: c.serverUrl ?? "",
      boxId: c.boxId ?? "",
      boxToken: c.boxToken ?? "",
      onboardingSkipped: c.onboardingSkipped ?? false,
      chatAutoAllow: c.chatAutoAllow ?? false,
      autoRenameSessions: c.autoRenameSessions ?? false,
      alwaysShowUsage: c.alwaysShowUsage ?? false,
      hiddenStatusItems: Array.isArray(c.hiddenStatusItems) ? c.hiddenStatusItems : [],
      forgeConnectOfferDismissed: c.forgeConnectOfferDismissed ?? false,
      allowAgentPush: c.allowAgentPush ?? false,
      worktreePerSession: c.worktreePerSession ?? false,
      worktreeCleanOnClose: c.worktreeCleanOnClose ?? false,
      uploadCleanupHours: typeof c.uploadCleanupHours === "number" ? c.uploadCleanupHours : 24,
      voiceNoteTtlHours: typeof c.voiceNoteTtlHours === "number" ? c.voiceNoteTtlHours : 168,
      downloadsDir: c.downloadsDir ?? "",
      defaultModel: c.defaultModel ?? null,
      deactivatedMainModels: c.deactivatedMainModels ?? [],
      skillRegistryUrls: c.skillRegistryUrls ?? [],
      cacheTtl: c.cacheTtl === "5m" ? "5m" : "1h",
      launcherFlags: c.launcherFlags ?? {},
      groqApiKey: c.groqApiKey ?? "",
      voiceTranscriptionModel: c.voiceTranscriptionModel ?? "",
      shareAnalytics: c.shareAnalytics ?? true,
      pinnedWindows: Array.isArray(c.pinnedWindows) ? c.pinnedWindows : [],
      theme:
        c.theme === "light" || c.theme === "dark" || c.theme === "system"
          ? c.theme
          : "system",
    });
    // BET-409: keep <html data-theme> in sync with every config load (desktop
    // refresh, mobile post-pairing refresh, Settings save) — not just the
    // initial boot application in main.tsx.
    applyTheme(
      c.theme === "light" || c.theme === "dark" || c.theme === "system"
        ? c.theme
        : "system",
    );
  },

  applyPairing: (p) =>
    set({ serverUrl: p.serverUrl, boxId: p.boxId, boxToken: p.boxToken }),

  setDefaultModel: async (model) => {
    set({ defaultModel: model });
    const next = await window.api.configUpdate({ defaultModel: model });
    // Reconcile with what main actually saved (handles error/reject paths).
    set({ defaultModel: next.defaultModel ?? null });
  },

  setChatAutoAllow: async (v) => {
    set({ chatAutoAllow: v });
    const next = await window.api.configUpdate({ chatAutoAllow: v });
    // Reconcile with what main actually saved (handles error/reject paths).
    set({ chatAutoAllow: next.chatAutoAllow ?? false });
  },

  setAutoRenameSessions: async (v) => {
    set({ autoRenameSessions: v });
    const next = await window.api.configUpdate({ autoRenameSessions: v });
    set({ autoRenameSessions: next.autoRenameSessions ?? false });
  },

  togglePin: async (pinId) => {
    const cur = get().pinnedWindows;
    const next = cur.includes(pinId)
      ? cur.filter((p) => p !== pinId)
      : [...cur, pinId];
    set({ pinnedWindows: next });
    const saved = await window.api.configUpdate({ pinnedWindows: next });
    set({ pinnedWindows: Array.isArray(saved.pinnedWindows) ? saved.pinnedWindows : [] });
  },

  addPendingScreenshot: (s) =>
    set((prev) => ({ pendingScreenshots: [...prev.pendingScreenshots, s] })),
  removePendingScreenshots: (ids) =>
    set((prev) => {
      const drop = new Set(ids);
      for (const s of prev.pendingScreenshots) {
        // jsdom (the test environment) implements NEITHER createObjectURL nor
        // revokeObjectURL, so an unguarded call makes every test that drops a
        // pending screenshot throw. Guard rather than leak the URL.
        if (drop.has(s.id) && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(s.previewUrl);
        }
      }
      return { pendingScreenshots: prev.pendingScreenshots.filter((s) => !drop.has(s.id)) };
    }),
  setAgentFileToast: (t) => set({ agentFileToast: t }),
  pushAppToast: (t) =>
    set((prev) => {
      const id = t.id ?? `toast-${Date.now()}-${++appToastSeq}`;
      return { appToasts: [...prev.appToasts, { ...t, id }].slice(-5) };
    }),
  dismissAppToast: (id) =>
    set((prev) => ({ appToasts: prev.appToasts.filter((t) => t.id !== id) })),
  setSystemNotice: (t) => set({ systemNotice: t }),
  setUpdatePrompt: (p) => set({ updatePrompt: p }),
  setUpdateError: (p) => set({ updateError: p }),
  setBoxIncompatible: (b) => set({ boxIncompatible: b }),
  setServerUpdatePrompt: (p) => set({ serverUpdatePrompt: p }),
  setServerUpdateProgress: (p) => set({ serverUpdateProgress: p }),
  setConnectionState: (s) => set({ connectionState: s }),
  setOpencodeRestartNeeded: (v) => set({ opencodeRestartNeeded: v }),

  applyStatusBatch: (batch) =>
    set((prev) => {
      // Build the next status map. For each (session, window):
      //   - if it just transitioned running → not-running and the user is not
      //     currently on that window, latch `attention = true`.
      //   - otherwise carry attention forward; it clears on setActive().
      const next: Record<string, Record<number, WindowStatusUI>> = {};
      for (const s of batch) {
        const old = prev.status[s.session]?.[s.windowIndex];
        const wasRunning = old?.running === true;
        const isActiveHere =
          prev.activeProjectName === s.session &&
          prev.activeWindowByProject[s.session] === s.windowIndex;
        const attention =
          (old?.attention ?? false) ||
          (wasRunning && !s.running && !isActiveHere);
        (next[s.session] ??= {})[s.windowIndex] = {
          running: s.running,
          subagents: s.subagents,
          attention,
        };
      }
      // Preserve the prior values for chat-mode windows — the PTY poller
      // can't see their state (the holder pane runs `sleep infinity`),
      // so a fresh `next` map would silently clobber whatever
      // setChatRunning / setChatAttention have set from the SSE stream.
      // Look up each chat window's prior status and copy it through.
      for (const p of prev.projects) {
        for (const w of p.windows) {
          if (!w.opencodeSessionId) continue;
          const prior = prev.status[p.tmuxSession]?.[w.index];
          if (prior) {
            (next[p.tmuxSession] ??= {})[w.index] = prior;
          }
        }
      }
      return { status: next };
    }),

  setJobs: (jobs) =>
    set(() => {
      const next: Record<string, DelegateJob> = {};
      for (const j of jobs) {
        if (!j.childSessionID) continue;
        next[j.childSessionID] = j;
      }
      return { jobs: next };
    }),

  setUsage: (usage) => set({ usage }),

  setChatRunning: (sessionId, running) =>
    set((prev) => {
      const owner = resolveSessionOwner(prev.projects, sessionId);
      if (!owner) return prev;
      const old = prev.status[owner.tmuxSession]?.[owner.windowIndex];
      const wasRunning = old?.running === true;
      const isActiveHere =
        prev.activeProjectName === owner.tmuxSession &&
        prev.activeWindowByProject[owner.tmuxSession] === owner.windowIndex;
      // Latch the same "running → idle while user isn't here" attention
      // signal the poller uses. Only fires for the idle transition; a
      // running→running tick (no-op) or fresh-start running carries
      // attention forward.
      const attentionNow = old?.attention ?? false;
      const attentionKindNow = old?.attentionKind;
      const goingIdle = wasRunning && !running;
      // Drop a stale blocking latch ("question"/"permission") on the
      // running→idle transition. opencode keeps a session BUSY for the whole
      // time it's blocked on a Question/permission tool (that's why attention
      // OUTRANKS running in the sidebar), so reaching idle PROVES the block is
      // gone. The matching question/permission.replied event normally clears
      // the red ?/!, but that event is occasionally missed (reconnect /
      // scoped-stream race), which used to strand the indicator until the user
      // opened the window. Downgrade to the normal running→idle treatment:
      // amber "go check" if the user is away, nothing if they're here.
      const staleBlocking =
        goingIdle &&
        (attentionKindNow === "question" || attentionKindNow === "permission");
      const attention = staleBlocking
        ? !isActiveHere
        : attentionNow || (goingIdle && !isActiveHere);
      // Preserve a more-urgent kind ("question"/"permission") if one is
      // already latched and NOT being cleared as stale; otherwise default to
      // "idle" on the running→idle latch.
      const attentionKind: AttentionKind | undefined =
        !staleBlocking && attentionKindNow && attentionKindNow !== "idle"
          ? attentionKindNow
          : attention
            ? "idle"
            : undefined;
      // Stamp lastMessageAt (BET-119) only on an actual running-value
      // transition — idle→running marks a new user message, running→idle
      // marks the assistant's completion. A redundant call with the same
      // value (the SSE handler fires more than the value actually changes)
      // must NOT touch the stamp, or the sidebar age label would reset on
      // every no-op event.
      const lastMessageAt =
        wasRunning !== running ? Date.now() : old?.lastMessageAt;
      const nextWin: WindowStatusUI = {
        running,
        subagents: old?.subagents ?? 0,
        attention,
        attentionKind,
        lastMessageAt,
        progressLabel: old?.progressLabel,
      };
      return {
        status: {
          ...prev.status,
          [owner.tmuxSession]: {
            ...prev.status[owner.tmuxSession],
            [owner.windowIndex]: nextWin,
          },
        },
      };
    }),

  setChatAttention: (sessionId, kind) =>
    set((prev) => {
      const owner = resolveSessionOwner(prev.projects, sessionId);
      if (!owner) return prev;
      const old = prev.status[owner.tmuxSession]?.[owner.windowIndex];
      const isActiveHere =
        prev.activeProjectName === owner.tmuxSession &&
        prev.activeWindowByProject[owner.tmuxSession] === owner.windowIndex;
      // Latch "question", "permission" and "blocked" unconditionally — these
      // block the turn and the user MUST act, so the sidebar indicator needs
      // to persist if they navigate away mid-turn (most common case: user is
      // typing a follow-up in another window when a permission fires; with
      // the previous `!isActiveHere` gate, no indicator was ever set
      // because the chat panel WAS active at that moment, and no later
      // event re-latched it). For these blocking kinds the indicator
      // auto-clears via `setActive` once the user actually focuses the
      // window, so the redundancy when they're already looking at the
      // card is cosmetic and harmless.
      //
      // "idle" (soft "go check" from running→idle while away) is still
      // gated by `!isActiveHere` — if the user IS on the window when the
      // turn finishes, there's nothing to go check.
      const wantAttention =
        kind != null &&
        (kind === "question" || kind === "permission" || kind === "blocked" || !isActiveHere);
      const nextWin: WindowStatusUI = {
        running: old?.running ?? false,
        subagents: old?.subagents ?? 0,
        attention: wantAttention,
        attentionKind: wantAttention ? kind ?? "idle" : undefined,
        lastMessageAt: old?.lastMessageAt,
        progressLabel: old?.progressLabel,
      };
      return {
        status: {
          ...prev.status,
          [owner.tmuxSession]: {
            ...prev.status[owner.tmuxSession],
            [owner.windowIndex]: nextWin,
          },
        },
      };
    }),

  setChatSubagents: (sessionId, count) =>
    set((prev) => {
      const owner = resolveSessionOwner(prev.projects, sessionId);
      if (!owner) return prev;
      const old = prev.status[owner.tmuxSession]?.[owner.windowIndex];
      const prevCount = old?.subagents ?? 0;
      // No-op when unchanged to avoid pointless re-renders of the entire
      // sidebar tree (zustand re-emits to all subscribers on every set).
      if (prevCount === count) return prev;
      const nextWin: WindowStatusUI = {
        running: old?.running ?? false,
        subagents: count,
        attention: old?.attention ?? false,
        attentionKind: old?.attentionKind,
        lastMessageAt: old?.lastMessageAt,
        progressLabel: old?.progressLabel,
      };
      return {
        status: {
          ...prev.status,
          [owner.tmuxSession]: {
            ...prev.status[owner.tmuxSession],
            [owner.windowIndex]: nextWin,
          },
        },
      };
    }),

  setChatProgressLabel: (sessionId, label) =>
    set((prev) => {
      const owner = resolveSessionOwner(prev.projects, sessionId);
      if (!owner) return prev;
      const old = prev.status[owner.tmuxSession]?.[owner.windowIndex];
      // No-op when unchanged (same guard as setChatSubagents) so the
      // frequent progress refetches don't re-emit to the whole sidebar.
      if ((old?.progressLabel ?? null) === (label ?? null)) return prev;
      const nextWin: WindowStatusUI = {
        running: old?.running ?? false,
        subagents: old?.subagents ?? 0,
        attention: old?.attention ?? false,
        attentionKind: old?.attentionKind,
        lastMessageAt: old?.lastMessageAt,
        progressLabel: label ?? undefined,
      };
      return {
        status: {
          ...prev.status,
          [owner.tmuxSession]: {
            ...prev.status[owner.tmuxSession],
            [owner.windowIndex]: nextWin,
          },
        },
      };
    }),

  setChatMessages: (sessionId, messages) =>
    set((prev) => {
      if (prev.chatMessages[sessionId] === messages) return prev;
      return { chatMessages: { ...prev.chatMessages, [sessionId]: messages } };
    }),

  replayChatAttention: async () => {
    // Collect every chat-mode window's opencode session id from the current
    // projects tree. The /question + /permission lists are `?directory=`-
    // scoped (see listQuestions/listPermissions in src/main/opencode.ts), so
    // an unscoped global fetch returns [] for any session outside the
    // server's default workspace — we MUST query per-session.
    const projects = get().projects;
    const sessionIds = new Set<string>();
    for (const p of projects) {
      for (const w of p.windows) {
        if (w.opencodeSessionId) sessionIds.add(w.opencodeSessionId);
      }
    }
    if (sessionIds.size === 0) return;
    if (!window.api.opencodeQuestions && !window.api.opencodePermissions) return;
    await runWithConcurrency(
      [...sessionIds],
      OPENCODE_FANOUT_CONCURRENCY,
      async (sid) => {
        try {
          const [questions, permissions] = await Promise.all([
            window.api.opencodeQuestions?.(sid).catch(() => []) ?? [],
            window.api.opencodePermissions?.(sid).catch(() => []) ?? [],
          ]);
          // Belt-and-braces: server-side listQuestions/listPermissions now
          // filters by sessionId, but defensively scope here too so the
          // attention latch can't leak if a caller ever bypasses the server
          // filter (e.g. a future unscoped path). Only latch if something is
          // genuinely pending for THIS session; do NOT clear — absence of a
          // pending request at startup is the normal case and must not stomp
          // live SSE-driven attention.
          const myQuestions = questions.filter((q) => q.sessionID === sid);
          const myPermissions = permissions.filter((p) => p.sessionID === sid);
          if (myQuestions.length === 0 && myPermissions.length === 0) return;

          // opencode's pending question/permission lists are cumulative and
          // never expire — a question whose turn was aborted (explicit abort,
          // queued-message drain-abort, opencode restart, app closed mid-ask)
          // stays "pending" forever unless something explicitly rejects it.
          // Trusting the list alone re-latches the red "?" glyph on every
          // launch for these orphans (BET-116). Validate against the
          // transcript BEFORE latching: fetch the tail only for sessions that
          // have something pending (rare, so the cost is acceptable) and
          // check whether the turn is actually still in flight.
          let inFlight = false;
          try {
            const messages = await window.api.opencodeMessages(sid, { limit: 20 });
            inFlight = isAssistantTurnInProgress(messages);
          } catch {
            // Transcript fetch failed — skip this session this launch rather
            // than guess; retried on the next replay.
            return;
          }

          if (myQuestions.length > 0) {
            if (inFlight) {
              get().setChatAttention(sid, "question");
            } else {
              // Orphan: reject server-side so opencode's pending map is
              // permanently cleaned and the glyph cannot recur on the next
              // launch. Fire-and-forget; skip entries with no requestId
              // (transcript-only recovered questions are unanswerable).
              for (const q of myQuestions) {
                if (!q.requestId) continue;
                void window.api.opencodeQuestionReject?.(q.requestId, sid).catch(() => {
                  /* best-effort cleanup */
                });
              }
            }
          } else if (myPermissions.length > 0 && inFlight) {
            // Stale permission entries are opencode-managed — only skip the
            // latch, do not auto-reject (unlike orphaned questions above).
            get().setChatAttention(sid, "permission");
          }
        } catch {
          // Per-session failure is non-fatal — best-effort replay.
        }
      },
    );
  },

  backfillLastMessageTimes: async () => {
    const projects = get().projects;
    // opencodeListSessions is `?directory=`-scoped (same constraint as the
    // question/permission lists above), so collect the distinct owning
    // directories of chat-mode windows and query per-directory rather than
    // per-session — one call covers every chat window sharing a cwd.
    const dirs = new Set<string>();
    for (const p of projects) {
      for (const w of p.windows) {
        if (w.opencodeSessionId) dirs.add(w.paneCurrentPath || p.defaultCwd);
      }
    }
    if (dirs.size === 0) return;
    if (!window.api.opencodeListSessions) return;
    const updatedBySessionId = new Map<string, number>();
    await runWithConcurrency(
      [...dirs],
      OPENCODE_FANOUT_CONCURRENCY,
      async (dir) => {
        try {
          const sessions = await window.api.opencodeListSessions!(dir);
          for (const s of sessions) {
            const updated = s.time?.updated;
            if (typeof updated === "number" && updated > 0) {
              updatedBySessionId.set(s.id, updated);
            }
          }
        } catch {
          // Per-directory failure is non-fatal — best-effort backfill.
        }
      },
    );
    if (updatedBySessionId.size === 0) return;
    set((prev) => {
      let changed = false;
      const next: Record<string, Record<number, WindowStatusUI>> = {
        ...prev.status,
      };
      for (const p of prev.projects) {
        for (const w of p.windows) {
          if (!w.opencodeSessionId) continue;
          const updated = updatedBySessionId.get(w.opencodeSessionId);
          if (updated == null) continue;
          const cur = next[p.tmuxSession]?.[w.index];
          // Never stomp a live SSE-driven stamp — only fill windows that
          // haven't had a setChatRunning transition yet.
          if (cur?.lastMessageAt != null) continue;
          next[p.tmuxSession] = {
            ...next[p.tmuxSession],
            [w.index]: {
              running: cur?.running ?? false,
              subagents: cur?.subagents ?? 0,
              attention: cur?.attention ?? false,
              attentionKind: cur?.attentionKind,
              lastMessageAt: updated,
            },
          };
          changed = true;
        }
      }
      return changed ? { status: next } : prev;
    });
  },

  runBackgroundSync: async () => {
    set({ backgroundSyncing: true });
    try {
      await Promise.all([
        get().replayChatAttention(),
        get().backfillLastMessageTimes(),
      ]);
    } finally {
      set({ backgroundSyncing: false });
    }
  },

  applyProjects: (projects) =>
    set((prev) => {
      // If the app had NO projects and now has some (the normal boot path:
      // loaded flips true before the first tmuxList resolves), the auto-created
      // zero-state "welcome" draft — whose NewSessionScreen overlay renders on
      // top of the restored session — is stale. Drop it so the user lands on
      // their last-used session, not the composer.
      const clearZeroStateDrafts = prev.projects.length === 0 && projects.length > 0;
      // Clamp activeProjectName to one that still exists; clamp window choice too.
      let activeProjectName = prev.activeProjectName;
      // A window to force for the actively-restored project. When we land on a
      // selection from the saved last-active session, seed this so the window
      // loop below keeps the saved window instead of picking the tmux-active one.
      let restoredWindow: number | undefined;
      if (!activeProjectName || !projects.find((p) => p.tmuxSession === activeProjectName)) {
        // No valid prior selection (fresh boot / relaunch, or the previously
        // selected project disappeared) — restore the last-used session so a
        // refresh lands on where the user left off, not the first project.
        // Falls back to the first project when the saved window no longer
        // exists (box wiped, project deleted, session list reset).
        const saved = readSavedActiveSession();
        if (saved) {
          const savedProj = projects.find((p) => p.tmuxSession === saved.project);
          if (savedProj && savedProj.windows.some((w) => w.index === saved.window)) {
            activeProjectName = saved.project;
            restoredWindow = saved.window;
          }
        }
        if (!activeProjectName) activeProjectName = projects[0]?.tmuxSession ?? null;
      }
      const activeWindowByProject = { ...prev.activeWindowByProject };
      for (const p of projects) {
        // The restored selection wins unconditionally — land the user exactly
        // on the window they last used, never the tmux-active/first one.
        if (restoredWindow !== undefined && p.tmuxSession === activeProjectName) {
          activeWindowByProject[p.tmuxSession] = restoredWindow;
          continue;
        }
        const cur = activeWindowByProject[p.tmuxSession];
        if (cur === undefined || !p.windows.find((w) => w.index === cur)) {
          const tmuxActive = p.windows.find((w) => w.active)?.index;
          activeWindowByProject[p.tmuxSession] = tmuxActive ?? p.windows[0]?.index ?? 0;
        }
      }
      // Drop entries for projects that no longer exist
      for (const k of Object.keys(activeWindowByProject)) {
        if (!projects.find((p) => p.tmuxSession === k)) delete activeWindowByProject[k];
      }
      return {
        projects,
        activeProjectName,
        activeWindowByProject,
        ...(clearZeroStateDrafts ? { activeDraftId: null, drafts: [] } : {}),
      };
    }),
}));

// Convenience hook: flat list of all (project, window) tuples for Cmd+1..9
export function flatSessions(projects: Project[]): Array<{
  project: Project;
  window: TmuxWindow;
}> {
  const out: Array<{ project: Project; window: TmuxWindow }> = [];
  for (const p of projects) for (const w of p.windows) out.push({ project: p, window: w });
  return out;
}

// (sessionId) -> the tmux window that owns it, plus the cwd ChatPanel needs.
// Prefer paneCurrentPath (always an absolute path from tmux) over the
// project's defaultCwd (may be a literal "~/..." opencode's /find/file
// cannot expand). Returns null if no window carries this session id (window
// killed remotely but a panel is still mounted) — callers no-op gracefully.
export type SessionOwner = {
  tmuxSession: string;
  windowIndex: number;
  cwd: string;
};

export function resolveSessionOwner(
  projects: Project[],
  sessionId: string,
): SessionOwner | null {
  for (const p of projects) {
    const w = p.windows.find((x) => x.opencodeSessionId === sessionId);
    if (w) {
      return {
        tmuxSession: p.tmuxSession,
        windowIndex: w.index,
        cwd: w.paneCurrentPath || p.defaultCwd,
      };
    }
  }
  return null;
}

function clearAttention(
  status: Record<string, Record<number, WindowStatusUI>>,
  session: string,
  windowIndex: number,
): Record<string, Record<number, WindowStatusUI>> {
  const cur = status[session]?.[windowIndex];
  if (!cur?.attention && cur?.attentionKind == null) return status;
  // Wipe BOTH attention and attentionKind. Leaving a stale kind ("question"/
  // "permission") around means a later running update could re-derive a red
  // ?/! glyph from the dead kind — the focused window must be fully clean.
  return {
    ...status,
    [session]: {
      ...status[session],
      [windowIndex]: { ...cur, attention: false, attentionKind: undefined },
    },
  };
}
