import { create } from "zustand";
import type {
  AgentFileReady,
  AppConfig,
  Project,
  TmuxWindow,
  WindowStatus,
} from "../shared/types";
import type { ConnectionState } from "../shared/net/state.js";
import { clientToken } from "./api/httpApi";
import { isAssistantTurnInProgress, runWithConcurrency } from "./chatUtils";

// Cap on simultaneous in-flight requests for the startup opencode fan-outs
// (`replayChatAttention`, `backfillLastMessageTimes`) — see BET-135.
const OPENCODE_FANOUT_CONCURRENCY = 4;

// Overlay the desktop-local pairing secrets (serverUrl/boxToken) onto a config
// snapshot. In http mode window.api.configGet() returns the bui-server's config,
// which never carries these — they live only on this desktop, mirrored into
// localStorage by main.tsx (bui_server/bui_token) at boot. Reading them here
// keeps resolveTransportMode() from seeing an empty boxToken and forcing
// onboarding on an already-paired install. A missing/blank local value leaves
// the incoming config field untouched, so this is a no-op on mobile/web and on
// a genuinely-unpaired fresh install.
function mergeLocalPairing(cfg: AppConfig): AppConfig {
  let serverUrl = "";
  try {
    serverUrl = localStorage.getItem("bui_server") ?? "";
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

// "Active session" in our UI = (projectName, windowIndex) tuple
export type ActiveSession = {
  projectName: string;
  windowIndex: number;
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
export type AttentionKind = "idle" | "question" | "permission";
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
};

// Global screenshot detection toast. Single instance app-wide — the active
// ChatPanel renders it and "Add to chat" / dismiss clear it for everyone.
// Subscription lives in App.tsx so we only register one ipcRenderer listener
// regardless of how many ChatPanels are mounted.
export type ScreenshotToast = {
  source: "clipboard" | "file";
  path?: string;
};

type State = {
  loaded: boolean;
  // ----- HTTP/relay transport + onboarding (M6, BET-49) -----
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
  chatAutoAllow: boolean;
  // Auto-rename chat-mode windows from the conversation (opt-in). See
  // AppConfig.autoRenameSessions.
  autoRenameSessions: boolean;
  // Agent → laptop push trust flag. When true, files the AI drops in its
  // remote outbox are pulled to the downloads dir without confirmation.
  allowAgentPush: boolean;
  // Override destination for agent-pushed files. "" = main's default (~/Downloads).
  downloadsDir: string;
  // Global default model for new/cleared sessions. Set in Settings, persisted
  // to config.json. null = let opencode pick its default.
  defaultModel: { providerID: string; modelID: string } | null;
  // User-added skill registry URLs (written to remote opencode.jsonc on save).
  skillRegistryUrls: string[];
  // Anthropic prompt cache TTL — drives the "/clear to save Nk tokens"
  // pill in ChatPanel's footer. Display-only (bui doesn't set the actual
  // cache_control.ttl on requests — opencode does); must match opencode's
  // setting. Defaults to "1h".
  cacheTtl: "5m" | "1h";
  // Voice / Groq STT. `groqApiKey` is the gating signal — empty string
  // means voice features are unavailable and the mic button stays hidden.
  // Other two fields default to "" so the main/server picks the built-in
  // defaults (whisper-large-v3-turbo / llama-3.1-8b-instant).
  groqApiKey: string;
  voiceTranscriptionModel: string;
  voiceCommandModel: string;
  projects: Project[];
  activeProjectName: string | null;
  activeWindowByProject: Record<string, number>; // projectName -> windowIndex
  // sessionName -> windowIndex -> status
  status: Record<string, Record<number, WindowStatusUI>>;
  // Single global screenshot toast — see ScreenshotToast type comment.
  screenshotToast: ScreenshotToast | null;
  // Single global agent-file toast: a file the remote AI pushed to its outbox.
  // Same single-instance pattern as screenshotToast — App.tsx owns the one
  // ipcRenderer listener, the active ChatPanel renders the toast, accept /
  // dismiss clear it globally. In auto-pull (trust) mode it's informational
  // (autoPulled:true, localPath set); otherwise it's a Save/dismiss prompt.
  agentFileToast: AgentFileReady | null;
  // Single global auto-update prompt. Set when main pushes an
  // updateDownloaded event (electron-updater finished downloading a new
  // version). The renderer shows a "Restart to update" bar; clicking it
  // calls autoUpdateInstall which quits + reinstalls. Dismissed by the ×
  // button (clears the state — the bar won't reappear until the next
  // updateDownloaded event). Guarded — the mobile httpApi shim's
  // onAutoUpdate* are no-ops, so this is desktop-only.
  updatePrompt: { version: string; releaseName?: string } | null;
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
  // ----- derived selectors -----
  activeSession: () => ActiveSession | null;
  // A minimal AppConfig-shaped snapshot of the onboarding-relevant fields,
  // for the pure helpers in shared/transport (resolveTransportMode) and
  // onboardingUtils (resolveInitialStep). Avoids threading the raw config
  // object through the store just for onboarding.
  configSnapshot: () => Partial<AppConfig>;
  // ----- mutations -----
  setActive: (projectName: string, windowIndex?: number) => void;
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
  // Reflect a successful onboarding claim (BET-49-T2) into store state so
  // resolveTransportMode reads "http" immediately. main already persisted these
  // to config.json via the auth:claim handler; this just mirrors them so the
  // onboarding shell can advance without a full config re-read.
  applyPairing: (p: { serverUrl: string; boxId: string; boxToken: string }) => void;
  applyStatusBatch: (batch: WindowStatus[]) => void;
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
  setScreenshotToast: (t: ScreenshotToast | null) => void;
  setAgentFileToast: (t: AgentFileReady | null) => void;
  setUpdatePrompt: (p: { version: string; releaseName?: string } | null) => void;
  setConnectionState: (s: ConnectionState) => void;
};

export const useStore = create<State>((set, get) => ({
  loaded: false,
  serverUrl: "",
  boxId: "",
  boxToken: "",
  onboardingSkipped: false,
  onboardingForced: false,
  chatAutoAllow: false,
  autoRenameSessions: false,
  allowAgentPush: false,
  downloadsDir: "",
  defaultModel: null,
  skillRegistryUrls: [],
  cacheTtl: "1h",
  groqApiKey: "",
  voiceTranscriptionModel: "",
  voiceCommandModel: "",
  projects: [],
  activeProjectName: null,
  activeWindowByProject: {},
  status: {},
  screenshotToast: null,
  agentFileToast: null,
  updatePrompt: null,
  connectionState: { state: "idle" },
  backgroundSyncing: false,

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

  setActive: (projectName, windowIndex) =>
    set((prev) => {
      const proj = prev.projects.find((p) => p.tmuxSession === projectName);
      const w =
        windowIndex ??
        prev.activeWindowByProject[projectName] ??
        proj?.windows.find((x) => x.active)?.index ??
        proj?.windows[0]?.index ??
        0;
      // Opening a window clears its "needs attention" flag.
      const status = clearAttention(prev.status, projectName, w);
      return {
        activeProjectName: projectName,
        activeWindowByProject: {
          ...prev.activeWindowByProject,
          [projectName]: w,
        },
        status,
      };
    }),

  refresh: async () => {
    const cfg = await window.api.configGet();
    // In http mode window.api.configGet() returns the bui-SERVER's config,
    // which structurally lacks the desktop-local pairing secrets
    // (serverUrl/boxId/boxToken). Those live only on this desktop — mirrored
    // into localStorage["bui_server"]/["bui_token"] by main.tsx at boot (and by
    // the pairing step via applyPairing). Overlay them so applyConfig doesn't
    // blank the pairing and flip the app back into onboarding on every refresh.
    get().applyConfig(mergeLocalPairing(cfg));
    // Un-gated: always fetch projects via httpApi (SSH main path gone, BET-82).
    const projects = await window.api.tmuxList();
    get().applyProjects(projects);
  },

  skipOnboarding: async () => {
    set({ onboardingSkipped: true, onboardingForced: false });
    const next = await window.api.configUpdate({ onboardingSkipped: true });
    // Reconcile with what main actually saved (error/reject paths).
    set({ onboardingSkipped: next.onboardingSkipped ?? false });
  },

  relaunchOnboarding: async () => {
    // Clear the persisted skip flag and force the shell open, even if the
    // config would otherwise resolve to http/ssh mode (already paired).
    set({ onboardingSkipped: false, onboardingForced: true });
    const next = await window.api.configUpdate({ onboardingSkipped: false });
    set({ onboardingSkipped: next.onboardingSkipped ?? false });
  },

  finishOnboarding: async () => {
    // Drop the force flag and re-read config so the app transitions to the
    // normal shell without an app restart (picks up boxToken/projects the
    // per-step components persisted).
    set({ onboardingForced: false });
    await get().refresh();
  },

  applyConfig: (c) =>
    set({
      loaded: true,
      serverUrl: c.serverUrl ?? "",
      boxId: c.boxId ?? "",
      boxToken: c.boxToken ?? "",
      onboardingSkipped: c.onboardingSkipped ?? false,
      chatAutoAllow: c.chatAutoAllow ?? false,
      autoRenameSessions: c.autoRenameSessions ?? false,
      allowAgentPush: c.allowAgentPush ?? false,
      downloadsDir: c.downloadsDir ?? "",
      defaultModel: c.defaultModel ?? null,
      skillRegistryUrls: c.skillRegistryUrls ?? [],
      cacheTtl: c.cacheTtl === "5m" ? "5m" : "1h",
      groqApiKey: c.groqApiKey ?? "",
      voiceTranscriptionModel: c.voiceTranscriptionModel ?? "",
      voiceCommandModel: c.voiceCommandModel ?? "",
    }),

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

  setScreenshotToast: (t) => set({ screenshotToast: t }),
  setAgentFileToast: (t) => set({ agentFileToast: t }),
  setUpdatePrompt: (p) => set({ updatePrompt: p }),
  setConnectionState: (s) => set({ connectionState: s }),

  applyStatusBatch: (batch) =>
    set((prev) => {
      // Build the next status map. For each (session, window):
      //   - if it just transitioned running → not-running and the user is not
      //     currently on that window, latch `attention = true`.
      //   - otherwise carry attention forward; it clears on setActive().
      const next: Record<string, Record<number, WindowStatusUI>> = {};
      // Seed with existing entries so windows missing from this batch keep
      // their last known state. The poller's REMOTE_CMD lists every window
      // every tick, so missing == window was killed; we'll prune below.
      const seen = new Set<string>();
      for (const s of batch) {
        const key = `${s.session}:${s.windowIndex}`;
        seen.add(key);
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
      // Drop entries the poller no longer reports (window was killed remotely).
      // Iterate prev to preserve any session-row that just temporarily missed
      // a tick due to a transient error — but in practice REMOTE_CMD failing
      // produces an empty batch (we return early in the catch), and a
      // successful run that omits a window means the window is gone.
      void seen;
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
      // Latch "question" and "permission" unconditionally — these block the
      // turn and the user MUST act, so the sidebar indicator needs to
      // persist if they navigate away mid-turn (most common case: user is
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
        kind != null && (kind === "question" || kind === "permission" || !isActiveHere);
      const nextWin: WindowStatusUI = {
        running: old?.running ?? false,
        subagents: old?.subagents ?? 0,
        attention: wantAttention,
        attentionKind: wantAttention ? kind ?? "idle" : undefined,
        lastMessageAt: old?.lastMessageAt,
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
            const messages = await window.api.opencodeMessages(sid);
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
      // Clamp activeProjectName to one that still exists; clamp window choice too.
      let activeProjectName = prev.activeProjectName;
      if (!activeProjectName || !projects.find((p) => p.tmuxSession === activeProjectName)) {
        activeProjectName = projects[0]?.tmuxSession ?? null;
      }
      const activeWindowByProject = { ...prev.activeWindowByProject };
      for (const p of projects) {
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
      return { projects, activeProjectName, activeWindowByProject };
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
