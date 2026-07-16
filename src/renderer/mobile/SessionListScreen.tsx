import { useState } from "react";
import { useStore } from "../store";
import type { Project, TmuxWindow } from "../../shared/types";
import { MobileCreateSheet } from "./MobileCreateSheet";
import { classifyCacheAge, formatAge, selectCacheTtlMs } from "../chatUtils";

type Props = {
  onOpenSession: (projectName: string, windowIndex: number) => void;
  // Called when the user wants to refresh the session list (pull-to-refresh
  // replacement). The create flow no longer reuses this — it has its own
  // sheet that calls refresh internally on success.
  onRefresh: () => void;
  onOpenSettings: () => void;
};

function dotColor(running: boolean, attention: boolean): string {
  if (attention) return "#F0A934";
  if (running) return "#22C79A";
  return "#5C6578";
}

function typeLabel(w: TmuxWindow, running: boolean, attention: boolean): string {
  const kind = w.opencodeSessionId ? "chat" : "terminal";
  if (w.opencodeSessionId && attention) return `${kind} · needs you`;
  if (w.opencodeSessionId && running) return `${kind} · running`;
  return kind;
}

// BET-119: same color mapping as the desktop Sidebar's StatusIndicator —
// keep the class strings in sync if either changes.
function ageColorClass(cls: "fresh" | "aging" | "stale"): string {
  if (cls === "fresh") return "text-emerald-400/70";
  if (cls === "aging") return "text-amber-400/80";
  return "text-red-400/80";
}

function SessionRow({
  project,
  window: w,
  onOpen,
}: {
  project: Project;
  window: TmuxWindow;
  onOpen: () => void;
}) {
  const status = useStore((s) => s.status[project.tmuxSession]?.[w.index]);
  const cacheTtl = useStore((s) => s.cacheTtl);
  const running = status?.running ?? false;
  const attention = status?.attention ?? false;
  const isBlockingAttention =
    attention && (status?.attentionKind === "question" || status?.attentionKind === "permission");
  // Same gating as the desktop label: chat-mode window, idle (not running),
  // not blocked on a question/permission (that state already surfaces as
  // "needs you" in the type label above).
  const showAge =
    status?.lastMessageAt != null && !running && !isBlockingAttention;
  return (
    <button
      className="mobile-row w-full text-left"
      onClick={onOpen}
      aria-label={`Open ${project.tmuxSession} / ${w.name}`}
    >
      <span
        className="mobile-dot"
        style={{ background: dotColor(running, attention) }}
      />
      <span className="flex-1 min-w-0">
        <span className="block text-text text-sm font-semibold truncate">
          {w.name}
        </span>
        <span className="block text-text-muted text-xs truncate">
          {typeLabel(w, running, attention)}
          {showAge && (
            <span
              className={`tabular-nums ${ageColorClass(classifyCacheAge(status!.lastMessageAt!, Date.now(), selectCacheTtlMs(cacheTtl)))}`}
            >
              {" "}
              · {formatAge(Date.now() - status!.lastMessageAt!)}
            </span>
          )}
        </span>
      </span>
      <span className="text-text-faint text-lg leading-none">›</span>
    </button>
  );
}

// Sheet state: which create flow is open (or null = none). We track this in
// the list screen rather than MobileApp so the sheet animates over the list,
// not over the entire app shell — the desktop equivalent is the inline
// new-project form expanding inside the sidebar.
type CreateState =
  | null
  | { kind: "new-project" }
  | { kind: "new-session"; projectName: string }
  // The "+" action sheet that lets the user pick "new project" vs "new
  // session in <project>" (only when there's at least one project).
  | { kind: "menu" };

export function SessionListScreen({
  onOpenSession,
  onRefresh,
  onOpenSettings,
}: Props) {
  const projects = useStore((s) => s.projects);
  const serverUrl = useStore((s) => s.serverUrl);
  const boxId = useStore((s) => s.boxId);
  const activeProjectName = useStore((s) => s.activeProjectName);
  const backgroundSyncing = useStore((s) => s.backgroundSyncing);

  const [createState, setCreateState] = useState<CreateState>(null);

  // "+" tap:
  //   - 0 projects: open new-project directly (only option that makes sense).
  //   - 1+ projects: open a small action sheet so the user can choose
  //     "new project" or "new session in <active project>". Hold-press could
  //     bypass the menu, but touch hold-press UX is fiddly — explicit menu
  //     is clearer.
  const onPlus = () => {
    if (projects.length === 0) setCreateState({ kind: "new-project" });
    else setCreateState({ kind: "menu" });
  };

  // Default project to add a session into when the user picks "new session"
  // from the menu — active project if any, otherwise the first one.
  const defaultSessionProject = activeProjectName ?? projects[0]?.tmuxSession;

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <div className="flex-1 flex items-center gap-2 min-w-0 px-1">
          <span className="text-text font-bold text-base">Sessions</span>
          {backgroundSyncing && (
            <span
              className="flex items-center gap-1.5 text-[11px] text-text-faint"
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
        <button
          className="mobile-tap text-text-muted text-xl leading-none"
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh"
        >
          ↻
        </button>
        <button
          className="mobile-tap text-text-muted text-xl leading-none"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
        <button
          className="mobile-tap rounded-lg bg-accent-soft text-white text-xl"
          onClick={onPlus}
          aria-label="New"
        >
          +
        </button>
      </div>
      <div className="flex-1 overflow-auto py-2">
        {projects.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-faint text-sm px-8 text-center">
            {serverUrl || boxId
              ? "No sessions yet. Tap + to create one."
              : "Server not configured."}
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.tmuxSession}>
              <div className="px-4 pt-3 pb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-text-faint">
                <span className="truncate">{p.tmuxSession}</span>
                <button
                  className="mobile-tap text-text-faint -my-2"
                  onClick={() =>
                    setCreateState({
                      kind: "new-session",
                      projectName: p.tmuxSession,
                    })
                  }
                  aria-label={`New session in ${p.tmuxSession}`}
                  title="New session in this project"
                >
                  +
                </button>
              </div>
              {p.windows.map((w) => (
                <SessionRow
                  key={w.index}
                  project={p}
                  window={w}
                  onOpen={() => onOpenSession(p.tmuxSession, w.index)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* "+" action sheet: only shown when there's at least one project so
          the user can choose between new-project and new-session. */}
      {createState?.kind === "menu" && (
        <div
          className="mobile-sheet-backdrop"
          onClick={() => setCreateState(null)}
        >
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setCreateState({ kind: "new-project" })}>
              New project
            </button>
            {defaultSessionProject && (
              <button
                onClick={() =>
                  setCreateState({
                    kind: "new-session",
                    projectName: defaultSessionProject,
                  })
                }
              >
                New session in "{defaultSessionProject}"
              </button>
            )}
            <button onClick={() => setCreateState(null)}>Cancel</button>
          </div>
        </div>
      )}

      {(createState?.kind === "new-project" ||
        createState?.kind === "new-session") && (
        <MobileCreateSheet
          mode={createState}
          onClose={() => setCreateState(null)}
          onCreated={(projectName, windowIndex) => {
            setCreateState(null);
            // For new-session we navigate straight into the new window so the
            // user sees their freshly created chat. For new-project we stay
            // on the list — the project may have several worktree windows
            // and we don't presume which one to open.
            if (windowIndex != null) onOpenSession(projectName, windowIndex);
          }}
        />
      )}
    </div>
  );
}
