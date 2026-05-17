import { create } from "zustand";
import type {
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
export type WindowStatusUI = {
  running: boolean;
  subagents: number;
  attention: boolean;
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
  // Global default model for new/cleared sessions. Set in Settings, persisted
  // to config.json. null = let opencode pick its default.
  defaultModel: { providerID: string; modelID: string } | null;
  transport: TransportInfo | null;
  tmuxConfig: TmuxConfigStatus | null;
  projects: Project[];
  activeProjectName: string | null;
  activeWindowByProject: Record<string, number>; // projectName -> windowIndex
  // sessionName -> windowIndex -> status
  status: Record<string, Record<number, WindowStatusUI>>;
  // Single global screenshot toast — see ScreenshotToast type comment.
  screenshotToast: ScreenshotToast | null;
  // ----- derived selectors -----
  activeSession: () => ActiveSession | null;
  // ----- mutations -----
  setActive: (projectName: string, windowIndex?: number) => void;
  refresh: () => Promise<void>;
  applyProjects: (projects: Project[]) => void;
  applyConfig: (c: AppConfig) => void;
  applyStatusBatch: (batch: WindowStatus[]) => void;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  setScreenshotToast: (t: ScreenshotToast | null) => void;
};

export const useStore = create<State>((set, get) => ({
  loaded: false,
  host: "",
  user: undefined,
  identityFile: undefined,
  transportPreference: "auto",
  uploadCleanupHours: 1,
  chatAutoAllow: false,
  defaultModel: null,
  transport: null,
  tmuxConfig: null,
  projects: [],
  activeProjectName: null,
  activeWindowByProject: {},
  status: {},
  screenshotToast: null,

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
      defaultModel: c.defaultModel ?? null,
    }),

  setChatAutoAllow: async (v) => {
    set({ chatAutoAllow: v });
    const next = await window.api.configUpdate({ chatAutoAllow: v });
    // Reconcile with what main actually saved (handles error/reject paths).
    set({ chatAutoAllow: next.chatAutoAllow ?? false });
  },

  setScreenshotToast: (t) => set({ screenshotToast: t }),

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
      return { status: next };
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
