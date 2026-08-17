import {
  cloneElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type { ReactElement } from "react";
import { ChevronRight, ChevronDown, Plus, X, Pin, Search, CirclePause } from "lucide-react";
import { useStore, flatSessions, type WindowStatusUI, type NewSessionDraft } from "./store";
import { nowMs, useAgeTick } from "./clock";
import { PaletteShell, useSelectedIntoView } from "./PaletteShell";
import { InboxPalette } from "./InboxPalette";
import type { Project, TmuxWindow } from "../shared/types";
import {
  classifyCacheAge,
  computeJobNesting,
  formatAge,
  fuzzySessionScore,
  isJobRow,
  resolvePin,
  projectForNavKey,
  selectCacheTtlMs,
  windowPinId,
  describeProjectClose,
  describeSessionClose,
} from "./chatUtils";
import { IS_WINDOWS, MOD_KEY } from "./platform";
import { SessionRow as RailSessionRow, type SessionStatus } from "./SessionRow";
import { useRailGlide } from "./RailGlide";
import { ConfirmModal } from "./ConfirmModal";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Pill } from "./Pill";
import { shouldShowStoppedMarker, unarmedStoppedCount } from "./usageResume";

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
  // BET-1049: open the "resume after limit reset" modal from the sidebar
  // header pill (the durable indicator of stopped conversations).
  onOpenResumeModal: () => void;
};

export const Sidebar = forwardRef<SidebarHandle, Props>(function Sidebar(
  { onOpenSettings, onNewProject, onNewSessionInProject, onOpenResumeModal },
  ref,
) {
  // BET-730: per-field selectors, never a bare useStore() — a no-selector
  // destructure re-renders the whole sidebar tree (and the App render that
  // hosts it) on EVERY store write, incl. each streaming transcript splice.
  const projects = useStore((s) => s.projects);
  const activeProjectName = useStore((s) => s.activeProjectName);
  const activeWindowByProject = useStore((s) => s.activeWindowByProject);
  const status = useStore((s) => s.status);
  const jobs = useStore((s) => s.jobs);
  const usageStopped = useStore((s) => s.usageStopped);
  // BET-1049: the conversations currently stopped by a provider limit (the
  // box-side record). Conversation ids → the set for O(1) row-marker lookups;
  // the pill counts only the ones still asking for a decision (not armed).
  const stoppedConversations = useMemo(
    () => new Set(usageStopped.map((r) => r.conversation)),
    [usageStopped],
  );
  const unarmedStoppedCountVal = useMemo(() => unarmedStoppedCount(usageStopped), [usageStopped]);
  const setActive = useStore((s) => s.setActive);
  const storeActivateWindow = useStore((s) => s.activateWindow);
  const refresh = useStore((s) => s.refresh);
  const backgroundSyncing = useStore((s) => s.backgroundSyncing);
  const pinnedWindows = useStore((s) => s.pinnedWindows);
  const recentWindows = useStore((s) => s.recentWindows);
  const togglePin = useStore((s) => s.togglePin);
  const worktreeCleanOnClose = useStore((s) => s.worktreeCleanOnClose);
  const drafts = useStore((s) => s.drafts);
  const activeDraftId = useStore((s) => s.activeDraftId);
  const setActiveDraft = useStore((s) => s.setActiveDraft);
  const dismissDraft = useStore((s) => s.dismissDraft);
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
  // BET-795: the work inbox (⌘K → Inbox). Rendered as a PaletteShell sibling
  // of the command palette; opened from the command palette's Inbox entry.
  const [inboxOpen, setInboxOpen] = useState(false);

  // BET-414: keyboard tree-nav focus (roving tabindex). `focusedKey` is the
  // row that currently holds tabIndex=0; ArrowUp/Down moves it along the
  // computed nav order. Keys: `pin:<id>` | `group:<session>` | `win:<session>:<idx>`
  // | `job:<session>:<idx>`.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const railGlide = useRailGlide();

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);

  useImperativeHandle(ref, () => ({
    openNewProject: () => onNewProject(),
    openNewSessionInActive: () => {
      // ⌘T follows rail focus first (BET-937): the project the user is
      // actually looking at, then the active project, else nothing. A pin
      // resolves via resolvePin; win/job/group keys name their session
      // directly.
      let target: string | null = projectForNavKey(focusedKey);
      if (!target && focusedKey?.startsWith("pin:")) {
        target = resolvePin(projects, focusedKey.slice("pin:".length))?.project.tmuxSession ?? null;
      }
      target ??= activeProjectName;
      if (target) {
        onNewSessionInProject(target);
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(target);
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
    // Preserve this site's existing guard: only tell the box to select the
    // window when the project is ALREADY active (its PTY is mounted). When
    // switching into a different project, setActive alone lands the store
    // view; the box PTY is (re)spawned on project switch.
    if (proj.tmuxSession === activeProjectName) {
      try {
        await storeActivateWindow(proj.tmuxSession, idx);
      } catch (e) {
        showError(e);
      }
    } else {
      setActive(proj.tmuxSession, idx);
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
    // BET-937 Task 2A: honour worktreeCleanOnClose when destroying a project.
    // Remove every clean worktree the project's sessions owned; a dirty one
    // is kept (never force-removed, no per-worktree confirm). Do this BEFORE
    // the tmux kill so a worktree can't be half-destroyed mid-close, but a
    // failure here must never abort the kill — killing the tmux session is
    // the user's actual intent and always happens.
    const proj = projects.find((p) => p.tmuxSession === project);
    const skipped: string[] = [];
    if (worktreeCleanOnClose && proj) {
      const wtPaths = proj.windows
        .map((w) => w.worktreePath)
        .filter((p): p is string => p != null);
      for (const path of wtPaths) {
        try {
          const res = await window.api.gitRemoveWorktree({ path, force: false });
          if (res && res.removed === false && res.reason === "dirty") {
            skipped.push(path);
          }
        } catch (e) {
          showError(e);
        }
      }
    }
    try {
      await window.api.tmuxKillSession(project);
      try {
        // BET-937 Task 2C: drop the project's stored metadata (defaultCwd)
        // so a later project of the same name can't inherit a stale path.
        // A failure must not block the refresh — the tmux session is already
        // gone and a stale config entry is far less bad than a stale rail.
        await window.api.projectMetaDelete(project);
      } catch (e) {
        showError(e);
      }
      await refresh();
    } catch (e) {
      showError(e);
    }
    if (skipped.length === 1) {
      showNotice(`Kept worktree at ${skipped[0]} — it has uncommitted changes.`);
    } else if (skipped.length > 1) {
      showNotice(`Kept ${skipped.length} worktrees with uncommitted changes.`);
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
      m.set(p.tmuxSession, computeJobNesting(p, jobs));
    }
    return m;
  }, [projects, jobs]);

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

  // Resolve the (project, window) pair backing a `pin:`/`win:`/`job:` nav key
  // — shared by activate/rename/delete below so the three keyboard paths
  // (BET-726 Task 2) don't each re-derive the same lookup.
  const resolveFocusedWindow = (): { project: Project; window: TmuxWindow } | null => {
    if (!focusedKey) return null;
    const [kind, ...rest] = focusedKey.split(":");
    if (kind === "pin") return resolvePin(projects, rest.join(":"));
    if (kind === "win" || kind === "job") {
      const session = rest[0];
      const idx = Number(rest[1]);
      const proj = projects.find((p) => p.tmuxSession === session);
      const win = proj?.windows.find((w) => w.index === idx);
      return proj && win ? { project: proj, window: win } : null;
    }
    return null;
  };

  const activateFocused = () => {
    if (!focusedKey) return;
    if (focusedKey.startsWith("group:")) {
      toggleCollapse(focusedKey.slice("group:".length));
      return;
    }
    const r = resolveFocusedWindow();
    if (r) void activateWindow(r.project, r.window.index);
  };

  // F2 → the same rename entry point the row's double-click already uses
  // (BET-726 Task 2.1). Project groups and windows are renameable; job rows
  // never were (JobChildRow has no onRename / RenameInput), so they're an
  // explicit no-op here too — `resolveFocusedWindow` resolves a `job:` key
  // to the same live window `win:` would, so without this guard F2 on a job
  // row would set `renameTarget` to that window's index with nothing on
  // screen listening for it (BET-726 review cycle 1 nit).
  const renameFocused = () => {
    if (!focusedKey || focusedKey.startsWith("job:")) return;
    if (focusedKey.startsWith("group:")) {
      const session = focusedKey.slice("group:".length);
      startRename({ kind: "project", old: session }, session);
      return;
    }
    const r = resolveFocusedWindow();
    if (r) {
      startRename(
        { kind: "window", project: r.project.tmuxSession, index: r.window.index, old: r.window.name },
        r.window.name,
      );
    }
  };

  // Delete / ContextMenu → the same confirm the right-click path already
  // opens (BET-726 Task 2.1) — right-click's onContextMenu just calls this
  // same setConfirmDeleteFor shape, so there is no separate "menu" to build
  // for the ContextMenu key either.
  const requestDeleteFocused = () => {
    if (!focusedKey) return;
    if (focusedKey.startsWith("group:")) {
      setConfirmDeleteFor({ kind: "project", project: focusedKey.slice("group:".length) });
      return;
    }
    const r = resolveFocusedWindow();
    if (r) {
      setConfirmDeleteFor({
        kind: "session",
        project: r.project.tmuxSession,
        index: r.window.index,
        name: r.window.name,
      });
    }
  };

  const onRailKeyDown = (e: React.KeyboardEvent) => {
    // BET-726 review cycle 1, Block (fix-here): the hover-revealed pin /
    // GroupHeader +/X / draft-dismiss buttons became Tab-reachable (Task
    // 2.3, `tabIndex={-1}` removed), but they're still DOM descendants of
    // this tree container — their keydowns were bubbling into this handler
    // with no target check, so Enter/Space fired `activateFocused()` for
    // whatever row `focusedKey` last pointed at (not the button under focus)
    // and Delete/Backspace opened the confirm for that same possibly-
    // unrelated row. Rows are `<div role="treeitem">`, never `<button>`, so
    // bailing out for any button-descendant target leaves the row's own
    // arrow/Enter/F2/Delete handling untouched and lets the button run its
    // own click/keyboard behavior instead of having it hijacked.
    if ((e.target as HTMLElement).closest("button")) return;
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
      // Space activates alongside Enter (SessionRow is a treeitem, not a
      // <button>, so native Space-click doesn't happen for free).
      case "Enter":
      case " ":
        e.preventDefault();
        activateFocused();
        break;
      case "F2":
        e.preventDefault();
        renameFocused();
        break;
      // Home / End jump to the first / last rail row (WAI-ARIA Tree View).
      case "Home":
        e.preventDefault();
        if (navKeys.length) setFocusedKey(navKeys[0]);
        break;
      case "End":
        e.preventDefault();
        if (navKeys.length) setFocusedKey(navKeys[navKeys.length - 1]);
        break;
      // Delete / Backspace are destructive — they require a modifier (⌘ or
      // Ctrl) to guard against the most reflexive key on the board (BET-937).
      // Bare Backspace/Delete does nothing at all: no preventDefault, no
      // confirm. A focused RenameInput stops propagation on its own keydown,
      // so this never fires mid-rename.
      case "Delete":
      case "Backspace":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          requestDeleteFocused();
        }
        break;
      case "ContextMenu":
        e.preventDefault();
        requestDeleteFocused();
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
          {unarmedStoppedCountVal > 0 && (
            <button
              type="button"
              className="p-0 border-0 bg-transparent cursor-pointer"
              onClick={onOpenResumeModal}
              title={`${unarmedStoppedCountVal} conversation${unarmedStoppedCountVal === 1 ? "" : "s"} stopped by a provider limit`}
            >
              <Pill tone="warn" size="meta" border icon={<CirclePause size={13} />}>
                {unarmedStoppedCountVal}
              </Pill>
            </button>
          )}
          <IconButton
            icon={<Search />}
            label="Search sessions"
            title={`Search sessions (${MOD_KEY}K)`}
            onClick={() => setPaletteOpen(true)}
          />
        </div>
      </div>

      <div
        className="relative flex-1 overflow-y-auto px-2 pb-2 outline-none"
        role="tree"
        aria-label="Sessions"
        tabIndex={-1}
        data-density="comfortable"
        onKeyDown={onRailKeyDown}
        {...railGlide.containerProps}
      >
        {railGlide.glide}
        <RailCreateRow label="New workspace" shortcut={`${MOD_KEY}N`} onClick={onNewProject} />
        {/* New-session drafts whose mode is "new-project" live directly beneath
            the New workspace row that created them — they belong to no project.
            Project-scoped drafts ({ projectName }) render inside their project's
            window list below instead (see the projects.map below). A draft is a
            bare "new session" until it commits; clicking one makes it the active
            view (renders the composer); the X abandons it (dismisses, prompt not
            yet sent). */}
        {drafts.filter((d) => d.mode === "new-project").length > 0 && (
          <div className="mb-3 space-y-px">
            {drafts
              .filter((d) => d.mode === "new-project")
              .map((d) => (
                <DraftRow
                  key={d.id}
                  draft={d}
                  isActive={activeDraftId === d.id}
                  onActivate={() => setActiveDraft(d.id)}
                  onDismiss={() => dismissDraft(d.id)}
                />
              ))}
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
                    activeProjectName === r.project.tmuxSession &&
                    activeWindowByProject[r.project.tmuxSession] === r.window.index
                  }
                  status={statusFor(r.project.tmuxSession, r.window.index)}
                  pinned
                  halted={r.window.opencodeSessionId ? stoppedConversations.has(r.window.opencodeSessionId) : false}
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
                />
              ))}
            </div>
          </div>
        )}

        {projects.map((p) => {
          const isCollapsed = collapsed.has(p.tmuxSession);
          const activeWinIdx = activeWindowByProject[p.tmuxSession];
          const isProjectActive = activeProjectName === p.tmuxSession;
          // Project-scoped drafts render as the LAST child of this project's
          // window list, and replace its "New session" create row (never stack
          // with it). A project may hold more than one draft; render them all
          // and still suppress the create row.
          const projectDrafts = drafts.filter(
            (d) => d.mode !== "new-project" && d.mode.projectName === p.tmuxSession,
          );
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
                          halted={w.opencodeSessionId ? stoppedConversations.has(w.opencodeSessionId) : false}
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
                        />
                        {kids.map((childIdx, i) => {
                          const childWin = p.windows.find((x) => x.index === childIdx);
                          if (!childWin) return null;
                          const childActive = isProjectActive && activeWinIdx === childIdx;
                          return (
                            <JobChildRow
                              key={`job:${p.tmuxSession}:${childIdx}`}
                              window={childWin}
                              isActive={childActive}
                              status={statusFor(p.tmuxSession, childIdx)}
                              focused={focusedKey === `job:${p.tmuxSession}:${childIdx}`}
                              lastChild={i === kids.length - 1}
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
                            />
                          );
                        })}
                      </div>
                    );
                  })}

                  {projectDrafts.length > 0 ? (
                    projectDrafts.map((d) => (
                      <DraftRow
                        key={d.id}
                        draft={d}
                        isActive={activeDraftId === d.id}
                        onActivate={() => setActiveDraft(d.id)}
                        onDismiss={() => dismissDraft(d.id)}
                      />
                    ))
                  ) : (
                    <RailCreateRow
                      label="New session"
                      shortcut={`${MOD_KEY}T`}
                      onClick={() => onNewSessionInProject(p.tmuxSession)}
                    />
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
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-accent"
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
          onOpenInbox={() => {
            setPaletteOpen(false);
            setInboxOpen(true);
          }}
        />
      )}

      {inboxOpen && <InboxPalette onClose={() => setInboxOpen(false)} />}

      {/*
        Destructive-confirm surfaces (BET-935). Both sit at the Sidebar root,
        as siblings of the palettes and OUTSIDE the scroll container, so no row
        ever shifts when one opens. D1 is the two-way ConfirmModal (session /
        project close); D2 is the three-way dirty-worktree modal built on the
        raw Modal primitive (ConfirmModal renders exactly Cancel + one confirm,
        and the dirty case has three outcomes).
      */}
      {(() => {
        const c = confirmDeleteFor;
        if (!c || c.kind === "worktree-dirty") {
          // Keep the modal MOUNTED with open={false} so its exit animation plays.
          return (
            <ConfirmModal
              open={false}
              title=""
              body=""
              confirmLabel=""
              onConfirm={() => {}}
              onCancel={() => setConfirmDeleteFor(null)}
            />
          );
        }
        const proj = projects.find((p) => p.tmuxSession === c.project);
        const copy =
          c.kind === "session"
            ? describeSessionClose({
                name: c.name,
                running: statusFor(c.project, c.index)?.running ?? false,
                worktreePath: worktreeCleanOnClose
                  ? (proj?.windows.find((w) => w.index === c.index)?.worktreePath ?? null)
                  : null,
              })
            : describeProjectClose({
                name: c.project,
                sessionCount: proj?.windows.length ?? 0,
                runningCount:
                  proj?.windows.filter((w) => statusFor(c.project, w.index)?.running).length ?? 0,
                // BET-937 Task 2B: the real number of worktrees project close
                // will remove — every window with a worktree, or 0 when
                // worktreeCleanOnClose is off.
                worktreeCount: worktreeCleanOnClose
                  ? (proj?.windows.filter((w) => w.worktreePath != null).length ?? 0)
                  : 0,
              });
        return (
          <ConfirmModal
            open
            title={copy.title}
            body={copy.body}
            confirmLabel={copy.confirmLabel}
            onConfirm={() => {
              if (c.kind === "session") void killWindow(c.project, c.index);
              else void killProject(c.project);
            }}
            onCancel={() => setConfirmDeleteFor(null)}
          />
        );
      })()}

      <Modal
        size="sm"
        open={confirmDeleteFor?.kind === "worktree-dirty"}
        onDismiss={() => setConfirmDeleteFor(null)}
        label="Uncommitted changes in this worktree"
      >
        <div className="space-y-4">
          <h3 className="text-title font-semibold">Uncommitted changes in this worktree</h3>
          <div className="text-body text-text-faint">
            <code className="break-all">
              {confirmDeleteFor?.kind === "worktree-dirty" ? confirmDeleteFor.worktreePath : ""}
            </code>{" "}
            has uncommitted changes. Removing the worktree will permanently delete that work.
          </div>
          <div className="flex justify-end gap-2">
            <Button tone="ghost" onClick={() => setConfirmDeleteFor(null)}>
              Cancel
            </Button>
            <Button
              tone="default"
              onClick={() => {
                if (confirmDeleteFor?.kind === "worktree-dirty") {
                  void killWorktreeDirtyAndClose(
                    confirmDeleteFor.project,
                    confirmDeleteFor.index,
                    confirmDeleteFor.worktreePath,
                    false,
                  );
                }
              }}
            >
              Keep worktree
            </Button>
            <Button
              tone="danger"
              onClick={() => {
                if (confirmDeleteFor?.kind === "worktree-dirty") {
                  void killWorktreeDirtyAndClose(
                    confirmDeleteFor.project,
                    confirmDeleteFor.index,
                    confirmDeleteFor.worktreePath,
                    true,
                  );
                }
              }}
            >
              Remove worktree
            </Button>
          </div>
        </div>
      </Modal>
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
    status.attention && (kind === "question" || kind === "permission" || kind === "blocked");
  if (isBlocking) {
    return {
      variant: "att",
      title:
        kind === "question"
          ? "Waiting on a question — click to answer"
          : kind === "blocked"
            ? "Blocked — needs a decision — click to view"
            : "Waiting on permission — click to approve or deny",
    };
  }
  if (status.attention && !status.running) {
    // A finished-but-unseen window is a SUCCESS state, so it takes the `--ok`
    // green dot. It used to take amber `--warn`, which in light mode
    // (`#6E6200`) reads as almost the same muted olive-grey as the at-rest
    // `--tx4` dot (`#8A8275`) — the two states were indistinguishable at 7px.
    return { variant: "ok", title: "Done — click to view" };
  }
  if (status.running) {
    // BET-791: the model-authored progress label (when a working turn names
    // its step) rides the same title tooltip the subagent count already uses
    // for the same "say more about a running window" reason — no new slot.
    const label = status.progressLabel?.trim() ? ` · ${status.progressLabel}` : "";
    const subs =
      status.subagents > 0
        ? ` · ${status.subagents} subagent${status.subagents === 1 ? "" : "s"}`
        : "";
    return { variant: "run", title: `Running${label}${subs}` };
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
      className="w-[18px] h-[18px] flex items-center justify-center shrink-0 text-text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--accent-tx)] transition-colors"
      title={pinned ? "Unpin" : "Pin"}
      aria-label={pinned ? "Unpin" : "Pin"}
    >
      <Pin size={12} className={pinned ? "fill-current" : ""} aria-hidden="true" />
    </button>
  );
}

// One composed session row: the SessionRow primitive PLUS the session delete
// affordance. Right-clicking a row requests the delete confirm (BET-935 routes
// the confirm into the shared root modal rather than rendering it inline
// below the row). Both the top-level window rows and the nested job rows
// render through this, so the delete-on-context-menu handler lives in exactly
// ONE place — without it the SessionRow migration would reintroduce the
// 17-line clone between WindowRow/JobChildRow that BET-536 is supposed to
// remove.
function DeletableSessionRow({
  row,
  onRequestDelete,
}: {
  /** The SessionRow element; its onContextMenu is overridden to request the delete. */
  row: ReactElement;
  onRequestDelete: () => void;
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
  halted,
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
}: {
  project: Project;
  window: TmuxWindow;
  isActive: boolean;
  status: WindowStatusUI | undefined;
  pinned: boolean;
  focused: boolean;
  /** BET-1049: this conversation is in the box's stopped-by-provider-limit
   *  record. The marker is suppressed when a pending question/permission
   *  blocks the row (precedence — see shouldShowStoppedMarker). */
  halted?: boolean;
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
}) {
  const isRenaming =
    renameTarget?.kind === "window" &&
    renameTarget.project === project.tmuxSession &&
    renameTarget.index === w.index;
  const dot = dotFor(status);
  // A pending question/permission (the "att" dot) outranks the stopped
  // marker — it blocks on the user now; a stopped conversation waits on a clock.
  const showHalted = shouldShowStoppedMarker(!!halted, dot.variant === "att");
  const age = useAge(status);
  return (
    <DeletableSessionRow
      row={
        <RailSessionRow
          status={showHalted ? "halted" : dot.variant}
          statusTitle={showHalted ? "Stopped by a provider limit" : dot.title}
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
      onRequestDelete={onClose}
    />
  );
}

// A nested job child row: same four slots, indented 26px, with a 1px border
// tree connector. Only running jobs (or the currently-viewed terminal job)
// reach this component — the parent filters the rest.
function JobChildRow({
  window: w,
  isActive,
  status,
  focused,
  lastChild,
  onActivate,
  onClose,
  title,
}: {
  window: TmuxWindow;
  isActive: boolean;
  status: WindowStatusUI | undefined;
  focused: boolean;
  lastChild: boolean;
  onActivate: () => void;
  onClose: () => void;
  title: string;
}) {
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
          lastChild={lastChild}
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
      onRequestDelete={onClose}
    />
  );
}

// A full-width "create" row. Box metrics are copied from SessionRow's ROW_BASE
// token-for-token so it sits flush in the rail; the 7px lead slot matches the
// status dot's footprint, which is what aligns the label with session names.
// Must render inside the rail's [data-density] ancestor to resolve --row-*.
function RailCreateRow({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      data-rail-row=""
      onClick={onClick}
      title={`${label} (${shortcut})`}
      className="group relative z-[1] flex w-full items-center gap-2 rounded-md mb-1 min-h-[var(--row-h)] px-[var(--row-px)] py-[var(--row-py)] text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
    >
      <span className="flex w-[7px] shrink-0 items-center justify-center text-text-faint group-hover:text-text">
        <Plus size={11} aria-hidden="true" />
      </span>
      <span className="flex-1 min-w-0 truncate text-label font-medium text-text-faint group-hover:text-text">
        {label}
      </span>
      <span className="shrink-0 min-w-[20px] text-right font-mono tabular-nums text-micro text-text-quiet">
        {shortcut}
      </span>
    </button>
  );
}

// A rail row for an in-memory new-session DRAFT. One component reused at both
// nest sites: at the top of the rail for a new-project draft (directly beneath
// "New workspace"), and as the last row of a project's window list for a
// project-scoped draft (where it replaces the "New session" create row). It is
// a RailSessionRow with an italic name and a trailing dismiss ✕.
function DraftRow({
  draft,
  isActive,
  onActivate,
  onDismiss,
}: {
  draft: NewSessionDraft;
  isActive: boolean;
  onActivate: () => void;
  onDismiss: () => void;
}) {
  const target =
    draft.mode === "new-project"
      ? "will create a new project"
      : `will open in "${draft.mode.projectName}"`;
  const hint = draft.input.trim()
    ? `"${draft.input.trim().slice(0, 40)}" · ${target}`
    : target;
  return (
    <RailSessionRow
      // A draft is never running/blocking — the at-rest "default" dot keeps
      // the row chrome identical to a resting session.
      status="default"
      selected={isActive}
      name={<span className="italic">new session</span>}
      title={`New session — ${hint}`}
      ariaSelected={isActive}
      onClick={onActivate}
      trailing={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-text-faint hover:text-danger leading-none inline-flex items-center"
          aria-label="Discard this new session"
          title="Discard this new session"
        >
          <X size={13} aria-hidden="true" />
        </button>
      }
    />
  );
}

// Workspace group header: chevron + name + collapse state. No colour dot, no
// count. Project-level close (X) is a hover action on the header (NOT a session
// row, so the four-slot rule doesn't apply).
function GroupHeader({
  project: p,
  isCollapsed,
  isProjectActive,
  focused,
  onToggle,
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
      <span
        className="opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <IconButton icon={<X />} label="Close project" onClick={onClose} />
      </span>
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
  onOpenInbox,
}: {
  query: string;
  setQuery: (v: string) => void;
  results: Array<{ project: Project; window: TmuxWindow; score: number }>;
  sel: number;
  setSel: (n: number) => void;
  onClose: () => void;
  onActivate: (project: Project, windowIndex: number) => void;
  onOpenInbox: () => void;
}) {
  // The Inbox action is a pinned row at index 0; the session rows shift by 1.
  return (
    <PaletteShell
      label="Command palette"
      placeholder="Search sessions…"
      query={query}
      setQuery={setQuery}
      itemCount={results.length + 1}
      sel={sel}
      setSel={setSel}
      onPick={(i) => {
        if (i === 0) {
          onOpenInbox();
          return;
        }
        const r = results[i - 1];
        if (r) onActivate(r.project, r.window.index);
      }}
      onClose={onClose}
    >
      {(pick) => (
        <>
          <button
            onMouseEnter={() => setSel(0)}
            onClick={() => pick(0)}
            className={`w-full flex items-center gap-3 px-3 py-3 rounded-md text-left text-label border-l-2 ${
              sel === 0
                ? "bg-bg-soft border-l-accent text-text"
                : "border-l-transparent text-text-muted hover:bg-bg-soft"
            }`}
          >
            <span className="flex-1 min-w-0 truncate">Inbox</span>
            <span className="text-meta text-text-faint truncate">assigned · reviews · red checks</span>
          </button>
          {results.length === 0 ? (
            <div className="px-3 py-3 text-label text-text-faint">No sessions match</div>
          ) : (
            results.map((r, i) => (
              <SessionRow
                key={`${r.project.tmuxSession}/${r.window.index}`}
                name={r.window.name}
                workspace={r.project.tmuxSession}
                selected={i + 1 === sel}
                onEnter={() => setSel(i + 1)}
                onClick={() => pick(i + 1)}
              />
            ))
          )}
        </>
      )}
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

