import { useEffect, useState } from "react";
import { useStore, resolveSessionOwner } from "../store";
import { ChatPanel } from "../ChatPanel";
import { Terminal } from "../Terminal";

type Props = {
  projectName: string;
  windowIndex: number;
  onBack: () => void;
};

export function SessionScreen({ projectName, windowIndex, onBack }: Props) {
  const projects = useStore((s) => s.projects);
  const [sheetOpen, setSheetOpen] = useState(false);

  const project = projects.find((p) => p.tmuxSession === projectName);
  const win = project?.windows.find((w) => w.index === windowIndex);

  // Pop back to the list if the window vanished (killed remotely / status
  // poller dropped it) instead of rendering a dead body.
  useEffect(() => {
    if (projects.length > 0 && !win) onBack();
  }, [projects.length, win, onBack]);

  if (!project || !win) return null;

  const sid = win.opencodeSessionId;
  const owner = sid ? resolveSessionOwner(projects, sid) : null;

  const forkSession = () => {
    if (!sid) return;
    const baseName =
      owner?.windowIndex != null ? `fork-${owner.windowIndex}` : "fork";
    const windowName = `${baseName}-${Date.now().toString(36).slice(-4)}`;
    window.api
      .opencodeForkSession({
        sessionId: sid,
        sessionName: owner?.tmuxSession ?? projectName,
        windowName,
        cwd: owner?.cwd || "~",
      })
      .catch(() => {});
    setSheetOpen(false);
  };

  const compactSession = () => {
    if (!sid) return;
    window.api.opencodeCompactSession(sid).catch(() => {});
    setSheetOpen(false);
  };

  const deleteSession = () => {
    if (!sid) return;
    window.api
      .opencodeDeleteSession({
        sessionId: sid,
        sessionName: owner?.tmuxSession ?? projectName,
        windowIndex: owner?.windowIndex ?? win.index,
      })
      .catch(() => {});
    setSheetOpen(false);
    onBack();
  };

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <button
          className="mobile-tap text-accent text-2xl leading-none"
          onClick={onBack}
          aria-label="Back to sessions"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-text font-bold text-sm truncate">{win.name}</div>
          <div className="text-text-faint text-xs truncate">
            {projectName}
            {sid ? " · chat" : " · terminal"}
          </div>
        </div>
        {sid && (
          <button
            className="mobile-tap text-text-muted text-xl"
            onClick={() => setSheetOpen(true)}
            aria-label="Session actions"
          >
            ⋯
          </button>
        )}
      </div>

      <div className="mobile-body">
        {sid ? (
          <ChatPanel
            sessionId={sid}
            tmuxSession={owner?.tmuxSession ?? null}
            windowIndex={owner?.windowIndex ?? null}
            cwd={owner?.cwd ?? ""}
            isActive={true}
          />
        ) : (
          <Terminal projectName={projectName} active={true} />
        )}
      </div>

      {sheetOpen && sid && (
        <div
          className="mobile-sheet-backdrop"
          onClick={() => setSheetOpen(false)}
        >
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <button onClick={forkSession}>Fork session</button>
            <button onClick={compactSession}>Compact context</button>
            <button className="danger" onClick={deleteSession}>
              Delete session
            </button>
            <button onClick={() => setSheetOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
