import { create } from "zustand";
import type {
  AgentFileReady,
  AppConfig,
  Project,
  TmuxConfigStatus,
  TmuxWindow,
  TransportInfo,
  WindowStatus,
} from "../shared/types";

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
export type WindowStatusUI = {
  running: boolean;
  subagents: number;
  attention: boolean;
  attentionKind?: AttentionKind;
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
  host: string;
  user?: string;
  identityFile?: string;
  transportPreference: "auto" | "mosh" | "ssh";
  uploadCleanupHours: number;
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
  transport: TransportInfo | null;
  tmuxConfig: TmuxConfigStatus | null;
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
  // ----- derived selectors -----
  activeSession: () => ActiveSession | null;
  // ----- mutations -----
  setActive: (projectName: string, windowIndex?: number) => void;
  refresh: () => Promise<void>;
  applyProjects: (projects: Project[]) => void;
  applyConfig: (c: AppConfig) => void;
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
  setChatAutoAllow: (v: boolean) => Promise<void>;
  setAutoRenameSessions: (v: boolean) => Promise<void>;
  setScreenshotToast: (t: ScreenshotToast | null) => void;
  setAgentFileToast: (t: AgentFileReady | null) => void;
};

export const useStore = create<State>((set, get) => ({
  loaded: false,
  host: "",
  user: undefined,
  identityFile: undefined,
  transportPreference: "auto",
  uploadCleanupHours: 1,
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
  transport: null,
  tmuxConfig: null,
  projects: [],
  activeProjectName: null,
  activeWindowByProject: {},
  status: {},
  screenshotToast: null,
  agentFileToast: null,

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
    get().applyConfig(cfg);
    if (cfg.host) {
      // Drop-in approach: never auto-modify the user's tmux config. Status is
      // surfaced read-only in Settings; a future "Set up tmux for bui" action
      // can opt them in explicitly if they want our overrides.
      const [projects, transport, tmuxConfig] = await Promise.all([
        window.api.tmuxList(),
        window.api.transportInfo().catch(() => null),
        window.api.tmuxConfigStatus().catch(() => null),
      ]);
      get().applyProjects(projects);
      set({ transport, tmuxConfig });
    }
  },

  applyConfig: (c) =>
    set({
      loaded: true,
      host: c.host,
      user: c.user,
      identityFile: c.identityFile,
      transportPreference: c.transport ?? "auto",
      uploadCleanupHours: c.uploadCleanupHours ?? 1,
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
      const attention =
        attentionNow || (wasRunning && !running && !isActiveHere);
      // Preserve a more-urgent kind ("question"/"permission") if one is
      // already latched; otherwise default to "idle" on the
      // running→idle latch.
      const attentionKind: AttentionKind | undefined =
        attentionKindNow && attentionKindNow !== "idle"
          ? attentionKindNow
          : attention
            ? "idle"
            : undefined;
      const nextWin: WindowStatusUI = {
        running,
        subagents: old?.subagents ?? 0,
        attention,
        attentionKind,
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
  if (!cur?.attention) return status;
  return {
    ...status,
    [session]: { ...status[session], [windowIndex]: { ...cur, attention: false } },
  };
}
