import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, ChevronDown, X, Pin, Search } from "lucide-react";
import { useStore, flatSessions, type WindowStatusUI } from "./store";
import { nowMs } from "./clock";
import type { Project, TmuxWindow } from "../shared/types";
import {
  classifyCacheAge,
  computeJobNesting,
  formatAge,
  fuzzySessionScore,
  isJobRow,
  resolvePin,
  selectCacheTtlMs,
  windowPinId,
} from "./chatUtils";
import { MOD_KEY } from "./platform";

const COLLAPSE_KEY = "manta:collapsed-projects";

// Shared confirm-delete union (BET-414: extracted to kill the jscpd clone that
// appeared in WindowRow + JobChildRow prop types).
type ConfirmDeleteFor =
  | { kind: "session"; project: string; index: number; name: string }
  | { kind: "project"; project: string }
  | { kind: "worktree-dirty"; project: string; index: number; name: string; worktreePath: string }
  | null;

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
  openPalette: () => void;
};

type Props = {
  onOpenSettings: () => void;
  // BET-417: the rail + / + per-project + open the NewSessionScreen instead
  // of an inline form. null = new-project mode; a string = new-session mode.
  onNewProject: () => void;
  onNewSessionInProject: (projectName: string) => void;
};

export const Sidebar = forwardRef<SidebarHandle, Props>(function Sidebar(
  { onOpenSettings, onNewProject, onNewSessionInProject },
  ref,
) {
  const {
    projects,
    activeProjectName,
    activeWindowByProject,
    status,
    jobs,
    setActive,
    refresh,
    backgroundSyncing,
    pinnedWindows,
    recentWindows,
    togglePin,
    worktreeCleanOnClose,
  } = useStore();
  // Downloaded desktop auto-update (BET-416 §E): signalled as a dot on the
  // Settings entry, not a full-width bar.
  const updateAvailable = useStore((s) => s.updatePrompt != null);

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    alert(msg);
  };

  const showNotice = (msg: string) => {
    alert(msg);
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const [confirmDeleteFor, setConfirmDeleteFor] = useState<ConfirmDeleteFor>(null);

  const [renameTarget, setRenameTarget] = useState<
    { kind: "project"; old: string } | { kind: "window"; project: string; index: number; old: string } | null
  >(null);
  const [renameValue, setRenameValue] = useState("");

  // BET-414: ⌘K session palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSel, setPaletteSel] = useState(0);

  // BET-414: keyboard tree-nav focus (roving tabindex). `focusedKey` is the
  // row that currently holds tabIndex=0; ArrowUp/Down moves it along the
  // computed nav order. Keys: `pin:<id>` | `group:<session>` | `win:<session>:<idx>`
  // | `job:<session>:<idx>`.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  useImperativeHandle(ref, () => ({
    openNewProject: () => onNewProject(),
    openNewSessionInActive: () => {
      if (activeProjectName) {
        onNewSessionInProject(activeProjectName);
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(activeProjectName);
          return next;
        });
      }
    },
    openPalette: () => {
      setPaletteOpen(true);
      setPaletteQuery("");
      setPaletteSel(0);
    },
  }));

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const activateWindow = async (proj: Project, idx: number) => {
    setActive(proj.tmuxSession, idx);
    if (proj.tmuxSession === activeProjectName) {
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
    const proj = projects.find((p) => p.tmuxSession === project);
    const w = proj?.windows.find((x) => x.index === index);
    const wtPath = w?.worktreePath ?? null;
    if (worktreeCleanOnClose && wtPath) {
      try {
        const res = await window.api.gitRemoveWorktree({ path: wtPath, force: false });
        if (res && res.removed === false && res.reason === "dirty") {
          setConfirmDeleteFor({
            kind: "worktree-dirty",
            project,
            index,
            name: w?.name ?? "",
            worktreePath: wtPath,
          });
          return;
        }
      } catch (e) {
        showError(e);
      }
    }
    setConfirmDeleteFor(null);
    try {
      await window.api.tmuxKillWindow({ sessionName: project, windowIndex: index });
      await refresh();
    } catch (e) {
      showError(e);
    }
  };

  const killWorktreeDirtyAndClose = async (
    project: string,
    index: number,
    wtPath: string,
    force: boolean,
  ) => {
    setConfirmDeleteFor(null);
    if (force) {
      try {
        await window.api.gitRemoveWorktree({ path: wtPath, force: true });
      } catch (e) {
        showError(e);
      }
    } else {
      showNotice(`Kept worktree at ${wtPath}`);
    }
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

  // ---- BET-414: pinned section + job nesting (pure compute) ----

  // Resolve pinned ids to live (project, window) pairs; drop stale pins.
  const pinnedRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: { project: Project; window: TmuxWindow; pinId: string }[] = [];
    for (const pinId of pinnedWindows) {
      if (seen.has(pinId)) continue;
      seen.add(pinId);
      const r = resolvePin(projects, pinId);
      if (r) rows.push({ ...r, pinId });
    }
    return rows;
  }, [pinnedWindows, projects]);

  // Pinned window ids as a set, for excluding from workspace groups.
  const pinnedIds = useMemo(
    () => new Set(pinnedRows.map((r) => r.pinId)),
    [pinnedRows],
  );

  // Per-project job nesting. Keyed by tmuxSession.
  const nesting = useMemo(() => {
    const m = new Map<string, ReturnType<typeof computeJobNesting>>();
    for (const p of projects) {
      const activeIdx = activeWindowByProject[p.tmuxSession];
      m.set(p.tmuxSession, computeJobNesting(p, jobs, activeIdx));
    }
    return m;
  }, [projects, jobs, activeWindowByProject]);

  // Flat nav-order keys for keyboard tree nav (roving tabindex).
  const navKeys = useMemo(() => {
    const keys: string[] = [];
    for (const r of pinnedRows) keys.push(`pin:${r.pinId}`);
    for (const p of projects) {
      keys.push(`group:${p.tmuxSession}`);
      if (collapsed.has(p.tmuxSession)) continue;
      const n = nesting.get(p.tmuxSession)!;
      for (const w of p.windows) {
        if (pinnedIds.has(windowPinId(p.tmuxSession, w.index))) continue;
        if (n.hidden.has(w.index)) continue;
        keys.push(`win:${p.tmuxSession}:${w.index}`);
        const kids = n.children.get(w.index);
        if (kids) for (const k of kids) keys.push(`job:${p.tmuxSession}:${k}`);
      }
    }
    return keys;
  }, [pinnedRows, pinnedIds, projects, collapsed, nesting]);

  // Reset focus if it falls off the list.
  useEffect(() => {
    if (focusedKey && !navKeys.includes(focusedKey)) setFocusedKey(null);
  }, [navKeys, focusedKey]);

  const focusIndex = focusedKey ? navKeys.indexOf(focusedKey) : -1;

  const moveFocus = (dir: 1 | -1) => {
    if (navKeys.length === 0) return;
    const next =
      focusIndex < 0
        ? dir === 1
          ? 0
          : navKeys.length - 1
        : (focusIndex + dir + navKeys.length) % navKeys.length;
    setFocusedKey(navKeys[next]);
  };

  const activateFocused = () => {
    if (!focusedKey) return;
    const [kind, ...rest] = focusedKey.split(":");
    if (kind === "group") {
      toggleCollapse(rest.join(":"));
      return;
    }
    if (kind === "pin") {
      const r = resolvePin(projects, rest.join(":"));
      if (r) void activateWindow(r.project, r.window.index);
      return;
    }
    // win:<session>:<idx> | job:<session>:<idx>
    const session = rest[0];
    const idx = Number(rest[1]);
    const proj = projects.find((p) => p.tmuxSession === session);
    const win = proj?.windows.find((w) => w.index === idx);
    if (proj && win) void activateWindow(proj, idx);
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight": {
        if (!focusedKey) break;
        if (focusedKey.startsWith("group:")) {
          const id = focusedKey.slice("group:".length);
          setCollapsed((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        break;
      }
      case "ArrowLeft": {
        if (!focusedKey) break;
        if (focusedKey.startsWith("group:")) {
          const id = focusedKey.slice("group:".length);
          setCollapsed((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        activateFocused();
        break;
    }
  };

  // ---- ⌘K palette candidates ----
  // Reuses flatSessions(projects) for the base list — no second flattener.
  // Empty query: sorted by recency (recentWindows, most-recently-activated
  // first), falling back to flatSessions order for never-activated windows.
  // Non-empty query: fuzzy match + score sort.
  const paletteCandidates = useMemo(() => flatSessions(projects), [projects]);
  const paletteResults = useMemo(() => {
    const q = paletteQuery.trim();
    if (!q) {
      // Recency ordering: recentWindows is most-recent-first pinId list.
      const recencyRank = new Map<string, number>();
      recentWindows.forEach((id, i) => recencyRank.set(id, i));
      return paletteCandidates
        .map((c) => ({
          ...c,
          score: 1,
          recency: recencyRank.get(`${c.project.tmuxSession}/${c.window.index}`) ?? Infinity,
        }))
        .sort((a, b) => a.recency - b.recency);
    }
    return paletteCandidates
      .map((c) => ({
        ...c,
        score: fuzzySessionScore(q, c.window.name, c.project.tmuxSession),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [paletteCandidates, paletteQuery, recentWindows]);

  useEffect(() => {
    if (paletteSel >= paletteResults.length) setPaletteSel(0);
  }, [paletteResults.length, paletteSel]);

  const onPaletteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setPaletteOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setPaletteSel((s) =>
        paletteResults.length === 0 ? 0 : (s + 1) % paletteResults.length,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPaletteSel((s) =>
        paletteResults.length === 0 ? 0 : (s - 1 + paletteResults.length) % paletteResults.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = paletteResults[paletteSel];
      if (target) {
        void activateWindow(target.project, target.window.index);
        setPaletteOpen(false);
      }
    }
  };

  // Row-indexed status lookup helper.
  const statusFor = (session: string, idx: number): WindowStatusUI | undefined =>
    status[session]?.[idx];

  // Title tooltip for a window row: rename hint + job activity (the activity
  // formerly rendered as a second line now lives here, per BET-414 one-line rule).
  const rowTitle = (w: TmuxWindow): string => {
    const parts = ["Double-click to rename"];
    if (isJobRow(jobs, w.opencodeSessionId)) {
      const job = w.opencodeSessionId ? jobs[w.opencodeSessionId] : undefined;
      if (job?.activity) parts.push(job.activity);
    }
    return parts.join(" · ");
  };

  return (
    <aside className="w-64 shrink-0 border-r border-border bg-bg-elev flex flex-col">
      <div className="titlebar-drag h-12 shrink-0" />
      <div className="px-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-meta font-semibold uppercase tracking-wider text-text-muted">
            Workspace
          </h2>
          {backgroundSyncing && (
            <span
              className="flex items-center gap-2 text-label text-text-faint"
              title="Syncing session state…"
            >
              <span
                className="h-3 w-3 rounded-full border-2 border-text-faint border-t-transparent animate-spin"
                aria-hidden
              />
              Syncing…
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaletteOpen(true)}
            className="text-text-muted hover:text-text text-base leading-none"
            title={`Search sessions (${MOD_KEY}K)`}
            aria-label="Search sessions"
          >
            <Search size={15} aria-hidden="true" />
          </button>
          <button
            onClick={onNewProject}
            className="text-text-muted hover:text-text text-lg leading-none"
            title={`New project (${MOD_KEY}N)`}
          >
            +
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 outline-none"
        role="tree"
        aria-label="Sessions"
        tabIndex={-1}
        onKeyDown={onRailKeyDown}
      >
        {projects.length === 0 && (
          <div className="px-2 py-3 text-meta text-text-faint">
            No projects yet. Click + or press {MOD_KEY}N.
          </div>
        )}

        {/* Pinned section — above the workspace groups. */}
        {pinnedRows.length > 0 && (
          <div className="mb-3">
            <div className="px-1 py-1 text-micro font-semibold uppercase tracking-wider text-text-quiet">
              Pinned
            </div>
            <div className="space-y-px">
              {pinnedRows.map((r) => (
                <WindowRow
                  key={`pin:${r.pinId}`}
                  project={r.project}
                  window={r.window}
                  isActive={
                    activeProjectName === r.project.tmuxSession &&
                    activeWindowByProject[r.project.tmuxSession] === r.window.index
                  }
                  status={statusFor(r.project.tmuxSession, r.window.index)}
                  pinned
                  focused={focusedKey === `pin:${r.pinId}`}
                  onActivate={() => activateWindow(r.project, r.window.index)}
                  onTogglePin={() => void togglePin(r.pinId)}
                  onClose={() =>
                    setConfirmDeleteFor({
                      kind: "session",
                      project: r.project.tmuxSession,
                      index: r.window.index,
                      name: r.window.name,
                    })
                  }
                  onRename={() =>
                    startRename(
                      {
                        kind: "window",
                        project: r.project.tmuxSession,
                        index: r.window.index,
                        old: r.window.name,
                      },
                      r.window.name,
                    )
                  }
                  renameTarget={renameTarget}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  commitRename={commitRename}
                  cancelRename={() => setRenameTarget(null)}
                  title={rowTitle(r.window)}
                  confirmDeleteFor={confirmDeleteFor}
                  setConfirmDeleteFor={setConfirmDeleteFor}
                  onKillWindow={() => killWindow(r.project.tmuxSession, r.window.index)}
                  onKillWorktreeDirty={(wtPath, force) =>
                    killWorktreeDirtyAndClose(r.project.tmuxSession, r.window.index, wtPath, force)
                  }
                />
              ))}
            </div>
          </div>
        )}

        {projects.map((p) => {
          const isCollapsed = collapsed.has(p.tmuxSession);
          const activeWinIdx = activeWindowByProject[p.tmuxSession];
          const isProjectActive = activeProjectName === p.tmuxSession;
          const n = nesting.get(p.tmuxSession)!;
          const topWindows = p.windows.filter(
            (w) =>
              !pinnedIds.has(windowPinId(p.tmuxSession, w.index)) &&
              !n.hidden.has(w.index),
          );
          return (
            <div key={p.tmuxSession} className="mb-4">
              <GroupHeader
                project={p}
                isCollapsed={isCollapsed}
                isProjectActive={isProjectActive}
                focused={focusedKey === `group:${p.tmuxSession}`}
                onToggle={() => toggleCollapse(p.tmuxSession)}
                onNewSession={() => onNewSessionInProject(p.tmuxSession)}
                onClose={() => setConfirmDeleteFor({ kind: "project", project: p.tmuxSession })}
                renameTarget={renameTarget}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                commitRename={commitRename}
                cancelRename={() => setRenameTarget(null)}
                startRename={() =>
                  startRename({ kind: "project", old: p.tmuxSession }, p.tmuxSession)
                }
              />

              {confirmDeleteFor?.kind === "project" &&
                confirmDeleteFor.project === p.tmuxSession && (
                  <ConfirmDelete
                    label={`project "${p.tmuxSession}"`}
                    onKill={() => killProject(p.tmuxSession)}
                    onCancel={() => setConfirmDeleteFor(null)}
                  />
                )}

              {!isCollapsed && (
                <div className="pl-2 space-y-px mt-px">
                  {topWindows.map((w) => {
                    const isActive = isProjectActive && activeWinIdx === w.index;
                    const kids = n.children.get(w.index) ?? [];
                    return (
                      <div key={w.index}>
                        <WindowRow
                          project={p}
                          window={w}
                          isActive={isActive}
                          status={statusFor(p.tmuxSession, w.index)}
                          pinned={pinnedIds.has(windowPinId(p.tmuxSession, w.index))}
                          focused={focusedKey === `win:${p.tmuxSession}:${w.index}`}
                          onActivate={() => activateWindow(p, w.index)}
                          onTogglePin={() => void togglePin(windowPinId(p.tmuxSession, w.index))}
                          onClose={() =>
                            setConfirmDeleteFor({
                              kind: "session",
                              project: p.tmuxSession,
                              index: w.index,
                              name: w.name,
                            })
                          }
                          onRename={() =>
                            startRename(
                              {
                                kind: "window",
                                project: p.tmuxSession,
                                index: w.index,
                                old: w.name,
                              },
                              w.name,
                            )
                          }
                          renameTarget={renameTarget}
                          renameValue={renameValue}
                          setRenameValue={setRenameValue}
                          commitRename={commitRename}
                          cancelRename={() => setRenameTarget(null)}
                          title={rowTitle(w)}
                          confirmDeleteFor={confirmDeleteFor}
                          setConfirmDeleteFor={setConfirmDeleteFor}
                          onKillWindow={() => killWindow(p.tmuxSession, w.index)}
                          onKillWorktreeDirty={(wtPath, force) =>
                            killWorktreeDirtyAndClose(p.tmuxSession, w.index, wtPath, force)
                          }
                        />
                        {kids.map((childIdx) => {
                          const childWin = p.windows.find((x) => x.index === childIdx);
                          if (!childWin) return null;
                          const childActive = isProjectActive && activeWinIdx === childIdx;
                          return (
                            <JobChildRow
                              key={`job:${p.tmuxSession}:${childIdx}`}
                              project={p}
                              window={childWin}
                              isActive={childActive}
                              status={statusFor(p.tmuxSession, childIdx)}
                              focused={focusedKey === `job:${p.tmuxSession}:${childIdx}`}
                              onActivate={() => activateWindow(p, childIdx)}
                              onClose={() =>
                                setConfirmDeleteFor({
                                  kind: "session",
                                  project: p.tmuxSession,
                                  index: childIdx,
                                  name: childWin.name,
                                })
                              }
                              title={rowTitle(childWin)}
                              confirmDeleteFor={confirmDeleteFor}
                              setConfirmDeleteFor={setConfirmDeleteFor}
                              onKillWindow={() => killWindow(p.tmuxSession, childIdx)}
                            />
                          );
                        })}
                      </div>
                    );
                  })}

                  {p.windows.length === 0 && (
                    <button
                      onClick={() => onNewSessionInProject(p.tmuxSession)}
                      className="block w-full text-left px-2 py-px text-meta text-text-faint hover:text-text"
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
          className="w-full text-left px-2 py-1 text-meta text-text-muted hover:text-text flex items-center gap-2"
        >
          {/* Update-available dot (BET-416 §E): "Update available" is no
              longer a full-width bar; a downloaded desktop auto-update is
              signalled by a small --accent dot on the Settings entry, with
              the details in Settings → General → About. The bar is reserved
              for blocking states only. */}
          {updateAvailable && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: "var(--accent)" }}
              title="An update is ready to install — see Settings → General → About"
              aria-label="Update available"
            />
          )}
          <span className="flex-1">Settings…</span>
        </button>
      </div>

      {paletteOpen && (
        <CommandPalette
          query={paletteQuery}
          setQuery={(v) => {
            setPaletteQuery(v);
            setPaletteSel(0);
          }}
          results={paletteResults}
          sel={paletteSel}
          setSel={setPaletteSel}
          onKeyDown={onPaletteKeyDown}
          onClose={() => setPaletteOpen(false)}
          onActivate={(proj, idx) => {
            void activateWindow(proj, idx);
            setPaletteOpen(false);
          }}
        />
      )}
    </aside>
  );
});

// ---- BET-414 row primitives ----

// One 7px status dot carrying every state. No trailing glyphs/counts — the
// subagent count is folded into the dot's title tooltip only.
function StatusDot({ status }: { status: WindowStatusUI | undefined }) {
  if (!status) return <span className="w-[10px] h-[7px] shrink-0" aria-hidden />;
  const kind = status.attentionKind ?? "idle";
  const isBlocking =
    status.attention && (kind === "question" || kind === "permission");
  if (isBlocking) {
    const tooltip =
      kind === "question"
        ? "Waiting on a question — click to answer"
        : "Waiting on permission — click to approve or deny";
    return (
      <span className="w-[10px] flex items-center justify-center shrink-0" title={tooltip}>
        <span className="w-[7px] h-[7px] rounded-full bg-danger animate-pulse" />
      </span>
    );
  }
  if (status.attention && !status.running) {
    return (
      <span className="w-[10px] flex items-center justify-center shrink-0" title="Finished — click to view">
        <span className="w-[7px] h-[7px] rounded-full bg-warn" />
      </span>
    );
  }
  if (status.running) {
    const tooltip =
      status.subagents > 0
        ? `Running · ${status.subagents} subagent${status.subagents === 1 ? "" : "s"}`
        : "Running";
    return (
      <span className="w-[10px] flex items-center justify-center shrink-0" title={tooltip}>
        <span className="w-[7px] h-[7px] rounded-full bg-accent animate-pulse" />
      </span>
    );
  }
  return <span className="w-[10px] flex items-center justify-center shrink-0" title="Idle"><span className="w-[7px] h-[7px] rounded-full" style={{ backgroundColor: "var(--tx4)" }} /></span>;
}

// Trailing timer slot. Mono, tabular figures, right-aligned, min-width 20px.
// Visible under the staleness TTL; past it `visibility:hidden` (NOT display:none)
// so the slot is preserved and revealing it on hover never shifts the pin.
function Timer({ status }: { status: WindowStatusUI | undefined }) {
  const cacheTtl = useStore((s) => s.cacheTtl);
  const showAge =
    status?.lastMessageAt != null && !status.running && !status.attention;
  if (!showAge) {
    return <span className="min-w-[20px] shrink-0" aria-hidden />;
  }
  const now = nowMs();
  const ttl = selectCacheTtlMs(cacheTtl);
  const cls = classifyCacheAge(status.lastMessageAt!, now, ttl);
  const stale = cls === "stale";
  // Stale timers: `invisible` at rest, `group-hover:visible` so the row's
  // hover reveals it. Tailwind classes (NOT inline style) — inline
  // `visibility:hidden` would beat the `group-hover:visible` class and the
  // timer would never reveal (Verify §2). Fresh timers render `visible`.
  const visibilityClass = stale ? "invisible group-hover:visible" : "visible";
  return (
    <span
      className={`min-w-[20px] shrink-0 text-right font-mono tabular-nums text-meta ${visibilityClass}`}
      style={{ color: "var(--tx4)" }}
    >
      {formatAge(now - status.lastMessageAt!)}
    </span>
  );
}

// Permanently 18px pin slot. Empty at rest; on row hover reveals an outline
// Pin (unpinned) or filled Pin (pinned). Brightens to --accent-tx on hover of
// the pin itself. Clicking toggles the pin via configUpdate.
function PinSlot({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="w-[18px] h-[18px] flex items-center justify-center shrink-0 text-text-faint opacity-0 group-hover:opacity-100 hover:text-[var(--accent-tx)] transition-colors"
      title={pinned ? "Unpin" : "Pin"}
      aria-label={pinned ? "Unpin" : "Pin"}
      tabIndex={-1}
    >
      <Pin size={12} className={pinned ? "fill-current" : ""} aria-hidden="true" />
    </button>
  );
}

// The four-slot session row: [status dot] [name] [pin slot] [timer]. One line,
// nothing else. The close (X) is a hover-revealed overlay in the trailing
// timer slot so the at-rest layout is exactly four slots and hover shifts
// nothing. Rename via double-click on the name.
function WindowRow({
  project,
  window: w,
  isActive,
  status,
  pinned,
  focused,
  onActivate,
  onTogglePin,
  onClose,
  onRename,
  renameTarget,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
  title,
  confirmDeleteFor,
  setConfirmDeleteFor,
  onKillWindow,
  onKillWorktreeDirty,
}: {
  project: Project;
  window: TmuxWindow;
  isActive: boolean;
  status: WindowStatusUI | undefined;
  pinned: boolean;
  focused: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
  onClose: () => void;
  onRename: () => void;
  renameTarget:
    | { kind: "project"; old: string }
    | { kind: "window"; project: string; index: number; old: string }
    | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  title: string;
  confirmDeleteFor: ConfirmDeleteFor;
  setConfirmDeleteFor: (v: ConfirmDeleteFor) => void;
  onKillWindow: () => void;
  onKillWorktreeDirty: (wtPath: string, force: boolean) => void;
}) {
  const isRenaming =
    renameTarget?.kind === "window" &&
    renameTarget.project === project.tmuxSession &&
    renameTarget.index === w.index;
  const showConfirm =
    confirmDeleteFor?.kind === "session" &&
    confirmDeleteFor.project === project.tmuxSession &&
    confirmDeleteFor.index === w.index;
  const showWorktreeConfirm =
    confirmDeleteFor?.kind === "worktree-dirty" &&
    confirmDeleteFor.project === project.tmuxSession &&
    confirmDeleteFor.index === w.index;
  return (
    <div>
      <div
        role="treeitem"
        aria-selected={isActive}
        tabIndex={focused ? 0 : -1}
        className={`group flex items-center gap-2 px-2 py-2 min-h-8 rounded text-meta cursor-pointer transition outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
          isActive
            ? "bg-bg-soft text-text"
            : "text-text-muted hover:bg-bg-soft hover:text-text"
        }`}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        title={title}
      >
        <StatusDot status={status} />
        {isRenaming ? (
          <RenameInput
            value={renameValue}
            onChange={setRenameValue}
            onCommit={commitRename}
            onCancel={cancelRename}
            size="window"
          />
        ) : (
          <span
            className="flex-1 min-w-0 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            {w.name}
          </span>
        )}
        <PinSlot pinned={pinned} onToggle={onTogglePin} />
        {/* Timer is the ONLY trailing element. min-width 20px per spec;
            visibility:hidden preserves the slot so hover-reveal shifts
            nothing. Close lives on the context menu (right-click). */}
        <Timer status={status} />
      </div>
      {showConfirm && (
        <ConfirmDelete
          label={`session "${w.name}"`}
          onKill={onKillWindow}
          onCancel={() => setConfirmDeleteFor(null)}
        />
      )}
      {showWorktreeConfirm && confirmDeleteFor?.kind === "worktree-dirty" && (
        <ConfirmWorktreeDirty
          worktreePath={confirmDeleteFor.worktreePath}
          onRemove={() => onKillWorktreeDirty(confirmDeleteFor.worktreePath, true)}
          onKeep={() => onKillWorktreeDirty(confirmDeleteFor.worktreePath, false)}
        />
      )}
    </div>
  );
}

// A nested job child row: same four slots, indented 26px, with a 1px border
// tree connector. Only running jobs (or the currently-viewed terminal job)
// reach this component — the parent filters the rest.
function JobChildRow({
  project,
  window: w,
  isActive,
  status,
  focused,
  onActivate,
  onClose,
  title,
  confirmDeleteFor,
  setConfirmDeleteFor,
  onKillWindow,
}: {
  project: Project;
  window: TmuxWindow;
  isActive: boolean;
  status: WindowStatusUI | undefined;
  focused: boolean;
  onActivate: () => void;
  onClose: () => void;
  title: string;
  confirmDeleteFor: ConfirmDeleteFor;
  setConfirmDeleteFor: (v: ConfirmDeleteFor) => void;
  onKillWindow: () => void;
}) {
  const showConfirm =
    confirmDeleteFor?.kind === "session" &&
    confirmDeleteFor.project === project.tmuxSession &&
    confirmDeleteFor.index === w.index;
  return (
    <div>
      <div
        role="treeitem"
        aria-level={2}
        aria-selected={isActive}
        tabIndex={focused ? 0 : -1}
        className={`group flex items-center gap-2 pl-[26px] pr-2 py-2 min-h-8 rounded text-meta cursor-pointer transition outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 border-l border-border ml-3 ${
          isActive
            ? "bg-bg-soft text-text"
            : "text-text-muted hover:bg-bg-soft hover:text-text"
        }`}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        title={title}
      >
        <StatusDot status={status} />
        <span className="flex-1 min-w-0 truncate">{w.name}</span>
        {/* Timer is the only trailing element. Close via context menu. */}
        <Timer status={status} />
      </div>
      {showConfirm && (
        <ConfirmDelete
          label={`session "${w.name}"`}
          onKill={onKillWindow}
          onCancel={() => setConfirmDeleteFor(null)}
        />
      )}
    </div>
  );
}

// Workspace group header: chevron + name + collapse state. No colour dot, no
// count. Project-level new-session (+) and close (X) are hover actions on the
// header (NOT session rows, so the four-slot rule doesn't apply).
function GroupHeader({
  project: p,
  isCollapsed,
  isProjectActive,
  focused,
  onToggle,
  onNewSession,
  onClose,
  renameTarget,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
  startRename,
}: {
  project: Project;
  isCollapsed: boolean;
  isProjectActive: boolean;
  focused: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onClose: () => void;
  renameTarget:
    | { kind: "project"; old: string }
    | { kind: "window"; project: string; index: number; old: string }
    | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  startRename: () => void;
}) {
  const isRenaming = renameTarget?.kind === "project" && renameTarget.old === p.tmuxSession;
  return (
    <div
      role="treeitem"
      aria-expanded={!isCollapsed}
      tabIndex={focused ? 0 : -1}
      className="group flex items-center gap-1 px-1 py-1 rounded text-micro font-semibold uppercase text-text-muted hover:text-text cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
      onClick={onToggle}
    >
      <span className="w-3 flex items-center justify-center text-text-quiet">
        {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </span>
      {isRenaming ? (
        <RenameInput
          value={renameValue}
          onChange={setRenameValue}
          onCommit={commitRename}
          onCancel={cancelRename}
          size="project"
        />
      ) : (
        <span
          className={`flex-1 truncate font-semibold ${isProjectActive ? "text-text" : ""}`}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
          title="Double-click to rename"
        >
          {p.tmuxSession}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNewSession();
        }}
        className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-text leading-none"
        title="New session in this project"
        tabIndex={-1}
      >
        +
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-danger leading-none inline-flex items-center"
        title="Close project"
        aria-label="Close project"
        tabIndex={-1}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// ⌘K session palette. Fuzzy match on session + workspace name; Enter activates,
// Esc closes, arrows move. Reuses flatSessions(projects) for ordering — no
// second flattener. Empty query shows the full list; no match shows a plain
// "No sessions match" row.
function CommandPalette({
  query,
  setQuery,
  results,
  sel,
  setSel,
  onKeyDown,
  onClose,
  onActivate,
}: {
  query: string;
  setQuery: (v: string) => void;
  results: Array<{ project: Project; window: TmuxWindow; score: number }>;
  sel: number;
  setSel: (n: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onClose: () => void;
  onActivate: (project: Project, windowIndex: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[90vw] bg-bg-elev border border-border rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search size={14} className="text-text-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-meta outline-none placeholder:text-text-faint"
          />
          <button
            onClick={onClose}
            className="text-text-faint hover:text-text text-meta"
            title="Close (Esc)"
          >
            Esc
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-meta text-text-faint">No sessions match</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.project.tmuxSession}/${r.window.index}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => onActivate(r.project, r.window.index)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-meta ${
                  i === sel ? "bg-bg-soft text-text" : "text-text-muted hover:bg-bg-soft"
                }`}
              >
                <StatusDot status={undefined} />
                <span className="flex-1 min-w-0 truncate">{r.window.name}</span>
                <span className="text-text-faint truncate">{r.project.tmuxSession}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  size,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  size: "project" | "window";
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCommit}
      className={`flex-1 bg-bg border border-accent px-1 py-0 text-meta rounded focus:outline-none ${
        size === "project" ? "font-semibold normal-case tracking-normal" : ""
      }`}
    />
  );
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
    <div className="ml-2 mt-1 mb-1 px-2 py-2 rounded bg-bg-soft border border-border space-y-2">
      <div className="text-meta text-text-muted">Close {label}?</div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="text-meta px-2 py-px rounded bg-danger-bg text-danger hover:bg-danger-bg"
          title="kill the tmux session/window on the remote"
        >
          Kill on server
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          className="text-meta px-2 py-px text-text-faint hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmWorktreeDirty({
  worktreePath,
  onRemove,
  onKeep,
}: {
  worktreePath: string;
  onRemove: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="ml-2 mt-1 mb-1 px-2 py-2 rounded bg-bg-soft border border-border space-y-2">
      <div className="text-meta text-text-muted">
        <code className="break-all">{worktreePath}</code> has uncommitted
        changes. Removing the worktree will permanently delete that work.
        Remove anyway?
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="text-meta px-2 py-px rounded bg-danger-bg text-danger hover:bg-danger-bg"
          title="git worktree remove --force (discards uncommitted changes)"
        >
          Remove
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKeep();
          }}
          className="text-meta px-2 py-px text-text-faint hover:text-text"
          title="leave the worktree + branch on disk; just close the session"
        >
          Keep worktree
        </button>
      </div>
    </div>
  );
}
