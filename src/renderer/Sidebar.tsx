import {
  cloneElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { ChevronRight, ChevronDown, X, Pin, Search } from "lucide-react";
import { useStore, flatSessions, type WindowStatusUI } from "./store";
import { nowMs, useAgeTick } from "./clock";
import { PaletteShell, useSelectedIntoView } from "./PaletteShell";
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
import { IS_WINDOWS, MOD_KEY } from "./platform";
import { SessionRow as RailSessionRow, type SessionStatus } from "./SessionRow";

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
    drafts,
    activeDraftId,
    setActiveDraft,
    dismissDraft,
  } = useStore();
  // Downloaded desktop auto-update (BET-416 §E): signalled as a dot on the
  // Settings entry, not a full-width bar.
  const updateAvailable = useStore((s) => s.updatePrompt != null);
  // BET-723: sidebar errors/notices surface as global toasts, not native alert().
  const pushAppToast = useStore((s) => s.pushAppToast);

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    pushAppToast({ tone: "error", message: msg });
  };

  const showNotice = (msg: string) => {
    pushAppToast({ tone: "info", message: msg });
  };

  // When a new-session DRAFT is the foreground view, no real session should
  // read as "active" in the rail — the draft row is the highlighted one
  // (e.g. creating a session over a chat must not leave the old chat lit up).
  const draftForeground = activeDraftId != null;

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
      {/* Top drag strip. On macOS this is dead space the traffic-lights
          overlay (top-left, over the sidebar) — keep it. On Windows the
          caption buttons are top-right (over the main area), so the sidebar's
          top-left corner is free: drop the empty strip and let the Workspace
          header below sit flush against the top edge instead. The header row
          becomes the drag region there so the frameless window still moves. */}
      {IS_WINDOWS ? null : <div className="titlebar-drag h-12 shrink-0" />}
      <div
        className={
          "px-3 pb-2 flex items-center justify-between" +
          (IS_WINDOWS ? " titlebar-drag" : "")
        }
      >
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
        <div
          className={
            "flex items-center gap-1" + (IS_WINDOWS ? " titlebar-no-drag" : "")
          }
        >
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
        data-density="comfortable"
        onKeyDown={onRailKeyDown}
      >
        {/* New-session drafts (BET draft model): in-memory composers for
            sessions that don't exist yet. Shown at the TOP of the rail, not
            nested under any project — a draft is a bare "new session" until it
            commits. Clicking one makes it the active view (renders the
            composer); the X abandons it (dismisses, prompt not yet sent). */}
        {drafts.length > 0 && (
          <div className="mb-3 space-y-px">
            {drafts.map((d) => {
              const isActive = activeDraftId === d.id;
              const target =
                d.mode === "new-project"
                  ? "will create a new project"
                  : `will open in "${d.mode.projectName}"`;
              const hint = d.input.trim()
                ? `"${d.input.trim().slice(0, 40)}" · ${target}`
                : target;
              return (
                <RailSessionRow
                  key={d.id}
                  // A draft is never running/blocking — the at-rest "default"
                  // dot keeps the row chrome identical to a resting session.
                  status="default"
                  selected={isActive}
                  name={<span className="italic">new session</span>}
                  title={`New session — ${hint}`}
                  ariaSelected={isActive}
                  onClick={() => setActiveDraft(d.id)}
                  trailing={
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissDraft(d.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-danger leading-none inline-flex items-center"
                      aria-label="Discard this new session"
                      tabIndex={-1}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  }
                />
              );
            })}
          </div>
        )}

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
                    !draftForeground &&
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
          const isProjectActive = !draftForeground && activeProjectName === p.tmuxSession;
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
          onClose={() => setPaletteOpen(false)}
          onActivate={(proj, idx) => {
            void activateWindow(proj, idx);
          }}
        />
      )}
    </aside>
  );
});

// ---- BET-414 row primitives ----

// Map a window's live status to the SessionRow dot variant + tooltip. The dot
// is the row's status signal, and the variant is REQUIRED (BET-536 C4 applies
// to the dot) — an undefined status still resolves to the bare `--tx4` dot,
// matching the rail's at-rest "Idle" state rather than disappearing.
function dotFor(status: WindowStatusUI | undefined): { variant: SessionStatus; title?: string } {
  if (!status) return { variant: "default", title: "Idle" };
  const kind = status.attentionKind ?? "idle";
  const isBlocking =
    status.attention && (kind === "question" || kind === "permission");
  if (isBlocking) {
    return {
      variant: "att",
      title:
        kind === "question"
          ? "Waiting on a question — click to answer"
          : "Waiting on permission — click to approve or deny",
    };
  }
  if (status.attention && !status.running) {
    return { variant: "idle", title: "Finished — click to view" };
  }
  if (status.running) {
    return {
      variant: "run",
      title:
        status.subagents > 0
          ? `Running · ${status.subagents} subagent${status.subagents === 1 ? "" : "s"}`
          : "Running",
    };
  }
  return { variant: "default", title: "Idle" };
}

// Age text + staleness for the SessionRow age slot. Fresh ages render
// visible; a stale age is `visibility:hidden` at rest and SessionRow reveals
// it on hover, so the reserved 20px slot never shifts the row. The slot chrome
// (mono / tabular / right / min-width) lives in SessionRow — this hook only
// produces the content.
function useAge(status: WindowStatusUI | undefined): { text: string | undefined; stale: boolean } {
  const cacheTtl = useStore((s) => s.cacheTtl);
  // Subscribe to the shared ticker so the label advances on its own (1m → 2m)
  // instead of only when an unrelated event happens to re-render the sidebar.
  // Called BEFORE the early return below — hook order must not depend on
  // whether this row currently has an age to show.
  useAgeTick();
  const last = status?.lastMessageAt;
  const showAge = last != null && !status?.running && !status?.attention;
  if (!showAge) return { text: undefined, stale: false };
  const now = nowMs();
  const ttl = selectCacheTtlMs(cacheTtl);
  const stale = classifyCacheAge(last, now, ttl) === "stale";
  return { text: formatAge(now - last), stale };
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

// One composed session row: the SessionRow primitive PLUS the session delete
// affordance. Right-clicking a row requests the delete confirm (the same
// context-menu behaviour both window and job rows share) and, when armed, the
// ConfirmDelete dialog renders below the row. Both the top-level window rows
// and the nested job rows render through this, so the delete-on-context-menu
// handler + ConfirmDelete block live in exactly ONE place — without it the
// SessionRow migration would reintroduce the 17-line clone between
// WindowRow/JobChildRow that BET-536 is supposed to remove.
function DeletableSessionRow({
  row,
  showConfirm,
  label,
  onKill,
  onCancel,
  onRequestDelete,
  children,
}: {
  /** The SessionRow element; its onContextMenu is overridden to request the delete. */
  row: ReactElement;
  showConfirm: boolean;
  /** ConfirmDelete label, e.g. `session "Deploy"`. */
  label: string;
  onKill: () => void;
  onCancel: () => void;
  onRequestDelete: () => void;
  /** Optional extra sibling confirm dialogs (e.g. the worktree-dirty prompt). */
  children?: ReactNode;
}) {
  return (
    <div>
      {cloneElement(row, {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onRequestDelete();
        },
      })}
      {showConfirm && <ConfirmDelete label={label} onKill={onKill} onCancel={onCancel} />}
      {children}
    </div>
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
  const dot = dotFor(status);
  const age = useAge(status);
  return (
    <DeletableSessionRow
      row={
        <RailSessionRow
          status={dot.variant}
          statusTitle={dot.title}
          selected={isActive}
          name={
            isRenaming ? (
              <RenameInput
                value={renameValue}
                onChange={setRenameValue}
                onCommit={commitRename}
                onCancel={cancelRename}
                size="window"
              />
            ) : (
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
              >
                {w.name}
              </span>
            )
          }
          age={age.text}
          ageStale={age.stale}
          trailing={<PinSlot pinned={pinned} onToggle={onTogglePin} />}
          title={title}
          tabIndex={focused ? 0 : -1}
          ariaSelected={isActive}
          onClick={onActivate}
        />
      }
      showConfirm={showConfirm}
      label={`session "${w.name}"`}
      onKill={onKillWindow}
      onCancel={() => setConfirmDeleteFor(null)}
      onRequestDelete={onClose}
    >
      {showWorktreeConfirm && confirmDeleteFor?.kind === "worktree-dirty" && (
        <ConfirmWorktreeDirty
          worktreePath={confirmDeleteFor.worktreePath}
          onRemove={() => onKillWorktreeDirty(confirmDeleteFor.worktreePath, true)}
          onKeep={() => onKillWorktreeDirty(confirmDeleteFor.worktreePath, false)}
        />
      )}
    </DeletableSessionRow>
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
  const dot = dotFor(status);
  const age = useAge(status);
  return (
    <DeletableSessionRow
      row={
        <RailSessionRow
          status={dot.variant}
          statusTitle={dot.title}
          selected={isActive}
          child
          name={w.name}
          age={age.text}
          ageStale={age.stale}
          title={title}
          ariaLevel={2}
          tabIndex={focused ? 0 : -1}
          ariaSelected={isActive}
          onClick={onActivate}
        />
      }
      showConfirm={showConfirm}
      label={`session "${w.name}"`}
      onKill={onKillWindow}
      onCancel={() => setConfirmDeleteFor(null)}
      onRequestDelete={onClose}
    />
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
      className="group flex items-center gap-1 px-1 py-1 rounded-xs text-micro font-semibold uppercase text-text-muted hover:text-text cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
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
// ⌘K session palette on the shared PaletteShell. Fuzzy match on session +
// workspace name; Enter/click activates, Esc closes, arrows move (wraps).
// Reuses flatSessions(projects) for ordering — no second flattener. Empty
// query shows the full list; no match shows a plain "No sessions match" row.
function CommandPalette({
  query,
  setQuery,
  results,
  sel,
  setSel,
  onClose,
  onActivate,
}: {
  query: string;
  setQuery: (v: string) => void;
  results: Array<{ project: Project; window: TmuxWindow; score: number }>;
  sel: number;
  setSel: (n: number) => void;
  onClose: () => void;
  onActivate: (project: Project, windowIndex: number) => void;
}) {
  return (
    <PaletteShell
      label="Command palette"
      placeholder="Search sessions…"
      query={query}
      setQuery={setQuery}
      itemCount={results.length}
      sel={sel}
      setSel={setSel}
      onPick={(i) => {
        const r = results[i];
        if (r) onActivate(r.project, r.window.index);
      }}
      onClose={onClose}
    >
      {(pick) =>
        results.length === 0 ? (
          <div className="px-3 py-3 text-label text-text-faint">No sessions match</div>
        ) : (
          results.map((r, i) => (
            <SessionRow
              key={`${r.project.tmuxSession}/${r.window.index}`}
              name={r.window.name}
              workspace={r.project.tmuxSession}
              selected={i === sel}
              onEnter={() => setSel(i)}
              onClick={() => pick(i)}
            />
          ))
        )
      }
    </PaletteShell>
  );
}

function SessionRow({
  name,
  workspace,
  selected,
  onEnter,
  onClick,
}: {
  name: string;
  workspace: string;
  selected: boolean;
  onEnter: () => void;
  onClick: () => void;
}) {
  const ref = useSelectedIntoView<HTMLButtonElement>(selected);
  return (
    <button
      ref={ref}
      onMouseEnter={onEnter}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-3 rounded-md text-left text-label border-l-2 ${
        selected
          ? "bg-bg-soft border-l-accent text-text"
          : "border-l-transparent text-text-muted hover:bg-bg-soft"
      }`}
    >
      <span className="flex-1 min-w-0 truncate">{name}</span>
      <span className="text-meta text-text-faint truncate">{workspace}</span>
    </button>
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
      className={`flex-1 bg-bg border border-accent px-1 py-0 text-meta rounded-xs focus:outline-none ${
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
    <div className="ml-2 mt-1 mb-1 px-2 py-2 rounded-xs bg-bg-soft border border-border space-y-2">
      <div className="text-meta text-text-muted">Close {label}?</div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="text-meta px-2 py-px rounded-xs bg-danger-bg text-danger hover:bg-danger-bg"
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
    <div className="ml-2 mt-1 mb-1 px-2 py-2 rounded-xs bg-bg-soft border border-border space-y-2">
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
          className="text-meta px-2 py-px rounded-xs bg-danger-bg text-danger hover:bg-danger-bg"
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
