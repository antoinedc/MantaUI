import { useEffect, useRef, useState } from "react";
import { Sidebar, type SidebarHandle } from "./Sidebar";
import { Terminal } from "./Terminal";
import { ChatPanel } from "./ChatPanel";
import { Settings } from "./Settings";
import { useStore, flatSessions } from "./store";

export function App() {
  const {
    loaded,
    host,
    user,
    projects,
    activeProjectName,
    activeWindowByProject,
    setActive,
    refresh,
    applyStatusBatch,
  } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sidebarRef = useRef<SidebarHandle>(null);

  // Track which projects we've ever activated — so we mount Terminal lazily
  // and keep them mounted (each holds an SSH PTY).
  const visited = useRef<Set<string>>(new Set());
  if (activeProjectName) visited.current.add(activeProjectName);

  // Same pattern for chat-mode windows: mount a ChatPanel for each opencode
  // session we've ever opened, keep it mounted so scroll position + in-flight
  // streaming state are preserved when switching back.
  const visitedChats = useRef<Set<string>>(new Set());
  // Active chat session id (set if active window is chat-mode, else null).
  const activeWin = activeProjectName
    ? projects
        .find((p) => p.tmuxSession === activeProjectName)
        ?.windows.find((w) => w.index === activeWindowByProject[activeProjectName])
    : null;
  const activeChatSessionId = activeWin?.opencodeSessionId ?? null;
  if (activeChatSessionId) visitedChats.current.add(activeChatSessionId);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.api.onStatusEvent) return;
    const off = window.api.onStatusEvent(applyStatusBatch);
    return off;
  }, [applyStatusBatch]);

  // Screenshot detection — subscribe ONCE at the app level. Every ChatPanel
  // used to register its own listener, so a single detection fanned out into
  // N toasts (one per mounted chat). Now the toast lives in the store, the
  // active ChatPanel renders it, and accept/dismiss clear it globally.
  useEffect(() => {
    const off = window.api.onScreenshotDetected((ev) => {
      useStore.getState().setScreenshotToast(ev);
    });
    return off;
  }, []);

  // Without this, dropping a file anywhere outside the terminal area causes
  // Chromium to navigate the renderer to the file:// URL.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files"))
        e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  useEffect(() => {
    if (loaded && !host) setSettingsOpen(true);
  }, [loaded, host]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === "," && !e.shiftKey && !e.altKey) {
        setSettingsOpen(true);
        e.preventDefault();
        return;
      }
      // Option+Cmd+Up/Down = step through (project, window) tuples in sidebar
      // order, wrapping around at both ends.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const flat = flatSessions(projects);
        if (flat.length === 0) return;
        const curIdx = activeProjectName
          ? flat.findIndex(
              (f) =>
                f.project.tmuxSession === activeProjectName &&
                f.window.index === activeWindowByProject[activeProjectName],
            )
          : -1;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx =
          curIdx < 0
            ? dir === 1 ? 0 : flat.length - 1
            : (curIdx + dir + flat.length) % flat.length;
        const target = flat[nextIdx];
        if (target && nextIdx !== curIdx) {
          setActive(target.project.tmuxSession, target.window.index);
          window.api
            .tmuxSelectWindow({
              sessionName: target.project.tmuxSession,
              windowIndex: target.window.index,
            })
            .catch(() => {});
        }
        e.preventDefault();
        return;
      }
      // Cmd+N = new workspace (project)
      if ((e.key === "n" || e.key === "N") && !e.shiftKey && !e.altKey) {
        sidebarRef.current?.openNewProject();
        e.preventDefault();
        return;
      }
      // Cmd+T = new session in active project
      if ((e.key === "t" || e.key === "T") && !e.shiftKey && !e.altKey) {
        sidebarRef.current?.openNewSessionInActive();
        e.preventDefault();
        return;
      }
      // Cmd+1..9 = jump to nth (project, window) tuple in sidebar order
      if (/^[1-9]$/.test(e.key) && !e.altKey) {
        const idx = parseInt(e.key, 10) - 1;
        const flat = flatSessions(projects);
        const target = flat[idx];
        if (target) {
          setActive(target.project.tmuxSession, target.window.index);
          // Also tell tmux to switch the window so the PTY follows.
          window.api
            .tmuxSelectWindow({
              sessionName: target.project.tmuxSession,
              windowIndex: target.window.index,
            })
            .catch(() => {});
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [projects, activeProjectName, activeWindowByProject, setActive]);

  const activeProject = activeProjectName
    ? projects.find((p) => p.tmuxSession === activeProjectName) ?? null
    : null;
  const activeWinName = activeProject?.windows.find(
    (w) => w.index === activeWindowByProject[activeProjectName!],
  )?.name ?? null;
  // CWD for the active (project, window). tmux's `paneCurrentPath` is always
  // absolute and follows shell-side `cd`s, so prefer it; fall back to the
  // project's configured `defaultCwd` for chat-mode holder panes that haven't
  // emitted a path yet. Compact `/home/<user>/...` to `~/...` for display —
  // matches the convention used everywhere else in the UI.
  const activeCwdRaw = activeWin?.paneCurrentPath || activeProject?.defaultCwd || "";
  const activeCwd = (() => {
    if (!activeCwdRaw) return "";
    if (user && activeCwdRaw.startsWith(`/home/${user}/`)) {
      return `~/${activeCwdRaw.slice(`/home/${user}/`.length)}`;
    }
    if (user && activeCwdRaw === `/home/${user}`) return "~";
    return activeCwdRaw;
  })();

  return (
    <div className="h-full w-full flex bg-bg text-text">
      <Sidebar ref={sidebarRef} onOpenSettings={() => setSettingsOpen(true)} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="titlebar-drag h-10 border-b border-border flex items-center px-3 gap-2 min-w-0">
          <div className="text-xs text-text-muted flex items-center gap-2 min-w-0">
            <span className="shrink-0">{host ? host : "Not configured"}</span>
            {activeProjectName && (
              <span className="text-text-faint shrink-0">
                · {activeProjectName}
                {activeWinName && ` / ${activeWinName}`}
              </span>
            )}
            {/* Active cwd — last segment in the chain so it can shrink and */}
            {/* truncate when the title bar is narrow. `direction:rtl` keeps */}
            {/* the *tail* of the path visible (the meaningful subdir name) */}
            {/* when truncation hits, instead of cutting it off mid-name. */}
            {/* The `·` separator lives OUTSIDE the rtl span so it renders */}
            {/* before the path (rtl would otherwise flip it to the right */}
            {/* side, leaving an orphan dot trailing the cwd). */}
            {activeCwd && (
              <>
                <span className="text-text-faint shrink-0">·</span>
                <span
                  className="text-text-faint min-w-0 truncate"
                  style={{ direction: "rtl", textAlign: "left" }}
                  title={activeCwdRaw}
                >
                  <bdi style={{ direction: "ltr" }}>{activeCwd}</bdi>
                </span>
              </>
            )}
          </div>

        </div>
        <div className="flex-1 relative">
          {projects.length === 0 ? (
            <div className="h-full flex items-center justify-center text-text-faint text-sm">
              {host
                ? "Create a project (⌘N) to start."
                : "Open Settings to configure your remote host."}
            </div>
          ) : (
            <>
              {/* Terminals (claude-TUI windows): one per visited project, kept */}
              {/* mounted. Hidden when the active window is chat-mode. */}
              {[...visited.current].map((projName) => {
                const projectActive = projName === activeProjectName;
                const visible = projectActive && !activeChatSessionId;
                return (
                  <div
                    key={`pty:${projName}`}
                    className="absolute inset-0"
                    style={{ display: visible ? "block" : "none" }}
                  >
                    <Terminal projectName={projName} active={projectActive} />
                  </div>
                );
              })}
              {/* Chat panels (opencode chat-mode windows): one per visited */}
              {/* session id, only the active one is visible. */}
              {[...visitedChats.current].map((sid) => {
                // Find the tmux window that owns this session id. May be null
                // if the window was killed remotely but bui still has the
                // panel mounted — fork/delete buttons gracefully no-op then.
                // Prefer paneCurrentPath (always absolute, from tmux) over
                // p.defaultCwd (might be a literal "~/..." that opencode's
                // /find/file etc don't expand).
                let owner: { tmuxSession: string; windowIndex: number; cwd: string } | null = null;
                for (const p of projects) {
                  const w = p.windows.find((x) => x.opencodeSessionId === sid);
                  if (w) {
                    owner = {
                      tmuxSession: p.tmuxSession,
                      windowIndex: w.index,
                      cwd: w.paneCurrentPath || p.defaultCwd,
                    };
                    break;
                  }
                }
                return (
                  <div
                    key={`chat:${sid}`}
                    className="absolute inset-0"
                    style={{ display: sid === activeChatSessionId ? "block" : "none" }}
                  >
                    <ChatPanel
                      sessionId={sid}
                      tmuxSession={owner?.tmuxSession ?? null}
                      windowIndex={owner?.windowIndex ?? null}
                      cwd={owner?.cwd ?? ""}
                      isActive={sid === activeChatSessionId}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
