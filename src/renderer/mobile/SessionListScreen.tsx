import { useStore } from "../store";
import type { Project, TmuxWindow } from "../../shared/types";

type Props = {
  onOpenSession: (projectName: string, windowIndex: number) => void;
  onCreate: () => void;
};

function dotColor(running: boolean, attention: boolean): string {
  if (attention) return "#f59e0b";
  if (running) return "#22c55e";
  return "#6b7280";
}

function typeLabel(w: TmuxWindow, running: boolean, attention: boolean): string {
  const kind = w.opencodeSessionId ? "chat" : "terminal";
  if (w.opencodeSessionId && attention) return `${kind} · needs you`;
  if (w.opencodeSessionId && running) return `${kind} · running`;
  return kind;
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
  const running = status?.running ?? false;
  const attention = status?.attention ?? false;
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
        </span>
      </span>
      <span className="text-text-faint text-lg leading-none">›</span>
    </button>
  );
}

export function SessionListScreen({ onOpenSession, onCreate }: Props) {
  const projects = useStore((s) => s.projects);
  const host = useStore((s) => s.host);

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <div className="flex-1 text-text font-bold text-base px-1">Sessions</div>
        <button
          className="mobile-tap rounded-lg bg-accent-soft text-white text-xl"
          onClick={onCreate}
          aria-label="New session"
        >
          +
        </button>
      </div>
      <div className="flex-1 overflow-auto py-2">
        {projects.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-faint text-sm px-8 text-center">
            {host
              ? "No sessions yet. Tap + to create one."
              : "Server not configured."}
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.tmuxSession}>
              <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wide text-text-faint">
                {p.tmuxSession}
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
    </div>
  );
}
