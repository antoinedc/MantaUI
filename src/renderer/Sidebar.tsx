import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { useStore, type WindowStatusUI } from "./store";
import type { Project, WorktreeInfo } from "../shared/types";

const COLLAPSE_KEY = "bui:collapsed-projects";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export type SidebarHandle = {
  openNewProject: () => void;
  openNewSessionInActive: () => void;
};

type Props = {
  onOpenSettings: () => void;
};

export const Sidebar = forwardRef<SidebarHandle, Props>(function Sidebar(
  { onOpenSettings },
  ref,
) {
  const {
    projects,
    activeProjectName,
    activeWindowByProject,
    status,
    setActive,
    refresh,
  } = useStore();

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    alert(msg);
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectCwd, setNewProjectCwd] = useState("~");
  // When the user's cwd resolves to a git repo with >1 worktree, we pause
  // creation and ask whether to fan out into one session per worktree.
  const [detectedWorktrees, setDetectedWorktrees] = useState<WorktreeInfo[] | null>(null);
  const [creating, setCreating] = useState(false);

  const [newSessionFor, setNewSessionFor] = useState<string | null>(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [newSessionCwd, setNewSessionCwd] = useState("");

  const [confirmDeleteFor, setConfirmDeleteFor] = useState<
    | { kind: "session"; project: string; index: number; name: string }
    | { kind: "project"; project: string }
    | null
  >(null);

  // Inline rename state
  const [renameTarget, setRenameTarget] = useState<
    { kind: "project"; old: string } | { kind: "window"; project: string; index: number; old: string } | null
  >(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  useImperativeHandle(ref, () => ({
    openNewProject: () => setNewProjectOpen(true),
    openNewSessionInActive: () => {
      if (activeProjectName) {
        setNewSessionFor(activeProjectName);
        setNewSessionName("");
        setNewSessionCwd("");
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(activeProjectName);
          return next;
        });
      }
    },
  }));

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Window name for a worktree: branch (stripped of refs/heads/), else dir basename.
  const worktreeName = (w: WorktreeInfo): string =>
    w.branch || w.path.split("/").filter(Boolean).pop() || "wt";

  const resetNewProjectForm = () => {
    setNewProjectName("");
    setNewProjectCwd("~");
    setNewProjectOpen(false);
    setDetectedWorktrees(null);
    setCreating(false);
  };

  // mode === "auto": probe for worktrees; if >1, switch to confirm UI and bail.
  // mode === "all":  create one window per detected worktree.
  // mode === "single": create one window at the user's typed cwd.
  const createProject = async (mode: "auto" | "all" | "single" = "auto") => {
    if (creating) return;
    const name = newProjectName.trim();
    if (!name) return;
    const cwd = newProjectCwd.trim() || "~";

    if (mode === "auto") {
      setCreating(true);
      try {
        const wts = await window.api.gitListWorktrees(cwd);
        if (wts.length > 1) {
          setDetectedWorktrees(wts);
          setCreating(false);
          return;
        }
      } catch {
        // probe failure (no git, network, etc.) → fall through to single
      }
      // <=1 worktree found, just create normally
      try {
        await window.api.tmuxNewSession({ name, cwd, windowName: "default" });
        resetNewProjectForm();
        await refresh();
        setActive(name);
      } catch (e) {
        showError(e);
        setCreating(false);
      }
      return;
    }

    setCreating(true);
    try {
      if (mode === "all" && detectedWorktrees && detectedWorktrees.length > 1) {
        // First worktree → tmux session's initial window. The rest are added
        // as additional windows. Each window's cwd is the worktree's own path,
        // not the user-typed cwd, so each one starts in its own checkout.
        const [first, ...rest] = detectedWorktrees;
        await window.api.tmuxNewSession({
          name,
          cwd: first.path,
          windowName: worktreeName(first),
        });
        for (const w of rest) {
          try {
            await window.api.tmuxNewWindow({
              sessionName: name,
              windowName: worktreeName(w),
              cwd: w.path,
            });
          } catch (e) {
            // Surface but keep going — partial fan-out is better than aborting
            // with the session already created.
            showError(e);
          }
        }
      } else {
        await window.api.tmuxNewSession({ name, cwd, windowName: "default" });
      }
      resetNewProjectForm();
      await refresh();
      setActive(name);
    } catch (e) {
      showError(e);
      setCreating(false);
    }
  };

  const startNewSession = (projectName: string) => {
    setNewSessionFor(projectName);
    setNewSessionName("");
    setNewSessionCwd("");
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(projectName);
      return next;
    });
  };

  const createSession = async () => {
    if (!newSessionFor) return;
    const windowName = newSessionName.trim() || "session";
    try {
      const projects = await window.api.tmuxNewWindow({
        sessionName: newSessionFor,
        windowName,
        cwd: newSessionCwd.trim() || undefined,
      });
      setNewSessionFor(null);
      await refresh();
      // Activate the new window (it'll be at the highest index in this session)
      const proj = projects.find((p) => p.tmuxSession === newSessionFor);
      const w = proj?.windows.find((x) => x.name === windowName);
      if (w) setActive(newSessionFor, w.index);
    } catch (e) {
      showError(e);
    }
  };

  const onClickWindow = async (proj: Project, idx: number) => {
    setActive(proj.tmuxSession, idx);
    if (proj.tmuxSession === activeProjectName) {
      // Already attached to this project's tmux session — tell tmux to switch
      // its active window so the PTY's display follows.
      try {
        await window.api.tmuxSelectWindow({
          sessionName: proj.tmuxSession,
          windowIndex: idx,
        });
      } catch (e) {
        showError(e);
      }
    }
  };

  const killWindow = async (project: string, index: number) => {
    setConfirmDeleteFor(null);
    try {
      await window.api.tmuxKillWindow({ sessionName: project, windowIndex: index });
      await refresh();
    } catch (e) {
      showError(e);
    }
  };

  const killProject = async (project: string) => {
    setConfirmDeleteFor(null);
    try {
      await window.api.tmuxKillSession(project);
      await refresh();
    } catch (e) {
      showError(e);
    }
  };


  const startRename = (target: NonNullable<typeof renameTarget>, current: string) => {
    setRenameTarget(target);
    setRenameValue(current);
  };

  const commitRename = async () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.old) {
      setRenameTarget(null);
      return;
    }
    try {
      if (renameTarget.kind === "project") {
        await window.api.tmuxRenameSession({
          oldName: renameTarget.old,
          newName,
        });
        if (activeProjectName === renameTarget.old) setActive(newName);
      } else {
        await window.api.tmuxRenameWindow({
          sessionName: renameTarget.project,
          windowIndex: renameTarget.index,
          newName,
        });
      }
      setRenameTarget(null);
      await refresh();
    } catch (e) {
      showError(e);
    }
  };

  return (
    <aside className="w-64 shrink-0 border-r border-border bg-bg-elev flex flex-col">
      <div className="titlebar-drag h-10 shrink-0" />
      <div className="px-3 pb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Workspace
        </h2>
        <button
          onClick={() => setNewProjectOpen(true)}
          className="text-text-muted hover:text-text text-lg leading-none"
          title="New project (⌘N)"
        >
          +
        </button>
      </div>

      {newProjectOpen && (
        <div className="px-3 pb-3 space-y-2">
          <input
            autoFocus
            placeholder="Project name"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !detectedWorktrees) createProject("auto");
              else if (e.key === "Escape") resetNewProjectForm();
            }}
            disabled={!!detectedWorktrees || creating}
            className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded focus:outline-none focus:border-accent disabled:opacity-60"
          />
          <input
            placeholder="Default cwd (e.g. ~/code/foo)"
            value={newProjectCwd}
            onChange={(e) => setNewProjectCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !detectedWorktrees) createProject("auto");
              else if (e.key === "Escape") resetNewProjectForm();
            }}
            disabled={!!detectedWorktrees || creating}
            className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded focus:outline-none focus:border-accent disabled:opacity-60"
          />
          {detectedWorktrees ? (
            <div className="space-y-2">
              <div className="text-xs text-text-muted">
                Detected {detectedWorktrees.length} git worktrees. Open a session for each?
              </div>
              <ul className="text-[11px] text-text-faint space-y-0.5 max-h-32 overflow-y-auto">
                {detectedWorktrees.map((w) => (
                  <li key={w.path} className="truncate">
                    <span className="text-text-muted">{worktreeName(w)}</span>
                    <span className="text-text-faint"> — {w.path}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => createProject("all")}
                  disabled={creating}
                  className="text-xs px-2 py-1 bg-accent text-bg rounded hover:opacity-90 disabled:opacity-50"
                >
                  Yes, one per worktree
                </button>
                <button
                  onClick={() => createProject("single")}
                  disabled={creating}
                  className="text-xs px-2 py-1 border border-border text-text-muted hover:text-text rounded disabled:opacity-50"
                >
                  Just main
                </button>
                <button
                  onClick={resetNewProjectForm}
                  disabled={creating}
                  className="text-xs px-2 py-1 text-text-muted hover:text-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => createProject("auto")}
                disabled={creating}
                className="text-xs px-2 py-1 bg-accent text-bg rounded hover:opacity-90 disabled:opacity-50"
              >
                {creating ? "Checking…" : "Create"}
              </button>
              <button
                onClick={resetNewProjectForm}
                disabled={creating}
                className="text-xs px-2 py-1 text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {projects.length === 0 && !newProjectOpen && (
          <div className="px-2 py-3 text-xs text-text-faint">
            No projects yet. Click + or press ⌘N.
          </div>
        )}

        {projects.map((p) => {
          const isCollapsed = collapsed.has(p.tmuxSession);
          const activeWinIdx = activeWindowByProject[p.tmuxSession];
          const isProjectActive = activeProjectName === p.tmuxSession;
          return (
            <div key={p.tmuxSession} className="mb-1">
              <div
                className="group flex items-center gap-1 px-1 py-1 rounded text-xs uppercase tracking-wider text-text-muted hover:text-text cursor-pointer select-none"
                onClick={() => toggleCollapse(p.tmuxSession)}
              >
                <span className="w-3 text-center text-text-faint">
                  {isCollapsed ? "▸" : "▾"}
                </span>
                {renameTarget?.kind === "project" && renameTarget.old === p.tmuxSession ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenameTarget(null);
                    }}
                    onBlur={commitRename}
                    className="flex-1 bg-bg border border-accent px-1 py-0 text-xs rounded font-semibold normal-case tracking-normal focus:outline-none"
                  />
                ) : (
                  <span
                    className={`flex-1 truncate font-semibold ${isProjectActive ? "text-text" : ""}`}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename({ kind: "project", old: p.tmuxSession }, p.tmuxSession);
                    }}
                    title="Double-click to rename"
                  >
                    {p.tmuxSession}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startNewSession(p.tmuxSession);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-text leading-none"
                  title="New session in this project"
                >
                  +
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteFor({ kind: "project", project: p.tmuxSession });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 leading-none"
                  title="Close project"
                >
                  ×
                </button>
              </div>

              {confirmDeleteFor?.kind === "project" &&
                confirmDeleteFor.project === p.tmuxSession && (
                  <ConfirmDelete
                    label={`project "${p.tmuxSession}"`}
                    onKill={() => killProject(p.tmuxSession)}
                    onCancel={() => setConfirmDeleteFor(null)}
                  />
                )}

              {!isCollapsed && (
                <div className="pl-4 space-y-0.5 mt-0.5">
                  {p.windows.map((w) => {
                    const isActive = isProjectActive && activeWinIdx === w.index;
                    const isRenaming =
                      renameTarget?.kind === "window" &&
                      renameTarget.project === p.tmuxSession &&
                      renameTarget.index === w.index;
                    return (
                      <div key={w.index}>
                        <div
                          className={`group flex items-center gap-1 pl-2 pr-1 py-0.5 rounded text-sm cursor-pointer transition ${
                            isActive
                              ? "bg-bg-soft text-text"
                              : "text-text-muted hover:bg-bg-soft hover:text-text"
                          }`}
                          onClick={() => onClickWindow(p, w.index)}
                        >
                          {isRenaming ? (
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") commitRename();
                                else if (e.key === "Escape") setRenameTarget(null);
                              }}
                              onBlur={commitRename}
                              className="flex-1 bg-bg border border-accent px-1 py-0 text-sm rounded focus:outline-none"
                            />
                          ) : (
                            <span
                              className="flex-1 truncate"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startRename(
                                  {
                                    kind: "window",
                                    project: p.tmuxSession,
                                    index: w.index,
                                    old: w.name,
                                  },
                                  w.name,
                                );
                              }}
                              title="Double-click to rename"
                            >
                              {w.name}
                            </span>
                          )}
                          <StatusIndicator
                            status={status[p.tmuxSession]?.[w.index]}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteFor(
                                confirmDeleteFor?.kind === "session" &&
                                  confirmDeleteFor.project === p.tmuxSession &&
                                  confirmDeleteFor.index === w.index
                                  ? null
                                  : {
                                      kind: "session",
                                      project: p.tmuxSession,
                                      index: w.index,
                                      name: w.name,
                                    },
                              );
                            }}
                            className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-red-400 text-xs leading-none"
                            title="Close session"
                          >
                            ×
                          </button>
                        </div>
                        {confirmDeleteFor?.kind === "session" &&
                          confirmDeleteFor.project === p.tmuxSession &&
                          confirmDeleteFor.index === w.index && (
                            <ConfirmDelete
                              label={`session "${w.name}"`}
                              onKill={() => killWindow(p.tmuxSession, w.index)}
                              onCancel={() => setConfirmDeleteFor(null)}
                            />
                          )}
                      </div>
                    );
                  })}

                  {newSessionFor === p.tmuxSession && (
                    <div className="pl-2 pr-1 py-1 space-y-1">
                      <input
                        autoFocus
                        placeholder="Session name (optional)"
                        value={newSessionName}
                        onChange={(e) => setNewSessionName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") createSession();
                          else if (e.key === "Escape") setNewSessionFor(null);
                        }}
                        className="w-full bg-bg-soft border border-border px-2 py-0.5 text-xs rounded focus:outline-none focus:border-accent"
                      />
                      <input
                        placeholder="cwd override (optional)"
                        value={newSessionCwd}
                        onChange={(e) => setNewSessionCwd(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") createSession();
                          else if (e.key === "Escape") setNewSessionFor(null);
                        }}
                        className="w-full bg-bg-soft border border-border px-2 py-0.5 text-xs rounded focus:outline-none focus:border-accent"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={createSession}
                          className="text-xs px-2 py-0.5 bg-accent text-bg rounded hover:opacity-90"
                        >
                          Create
                        </button>
                        <button
                          onClick={() => setNewSessionFor(null)}
                          className="text-xs px-2 py-0.5 text-text-muted hover:text-text"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {p.windows.length === 0 && newSessionFor !== p.tmuxSession && (
                    <button
                      onClick={() => startNewSession(p.tmuxSession)}
                      className="block w-full text-left px-2 py-0.5 text-xs text-text-faint hover:text-text"
                    >
                      + new session
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-auto p-2 border-t border-border">
        <button
          onClick={onOpenSettings}
          className="w-full text-left px-2 py-1 text-xs text-text-muted hover:text-text"
        >
          Settings…
        </button>
      </div>
    </aside>
  );
});

// Subtle per-window indicator:
//   running       → pulsing accent dot, with `·N` if subagents > 0
//   attention     → steady amber dot (claude finished, user hasn't visited yet)
//   neither       → nothing
function StatusIndicator({ status }: { status: WindowStatusUI | undefined }) {
  if (!status) return null;
  if (status.running) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] text-accent leading-none"
        title={
          status.subagents > 0
            ? `Running · ${status.subagents} subagent${status.subagents === 1 ? "" : "s"}`
            : "Running"
        }
      >
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        {status.subagents > 0 && (
          <span className="tabular-nums">·{status.subagents}</span>
        )}
      </span>
    );
  }
  if (status.attention) {
    return (
      <span
        className="w-1.5 h-1.5 rounded-full bg-amber-400"
        title="Finished — click to view"
      />
    );
  }
  return null;
}

function ConfirmDelete({
  label,
  onKill,
  onCancel,
}: {
  label: string;
  onKill: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ml-2 mt-1 mb-1 px-2 py-1.5 rounded bg-bg-soft border border-border space-y-1.5">
      <div className="text-xs text-text-muted">Close {label}?</div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
          title="kill the tmux session/window on the remote"
        >
          Kill on server
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          className="text-xs px-2 py-0.5 text-text-faint hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
