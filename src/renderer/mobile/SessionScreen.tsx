import { useEffect, useState } from "react";
import { useStore, resolveSessionOwner } from "../store";
import { ChatPanel } from "../ChatPanel";
import { Terminal } from "../Terminal";
import { KeyboardBar } from "./KeyboardBar";
import {
  type SessionMode,
  readSavedMode,
  writeSavedMode,
  resolveLauncherFlags,
} from "../chatShared";
import type { AvailableLauncher } from "../../shared/types";

type Props = {
  projectName: string;
  windowIndex: number;
  onBack: () => void;
};

export function SessionScreen({ projectName, windowIndex, onBack }: Props) {
  const projects = useStore((s) => s.projects);
  const refresh = useStore((s) => s.refresh);
  const launcherFlags = useStore((s) => s.launcherFlags);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Inline rename state — when set, the sheet replaces its action buttons with
  // a name input + Save / Cancel. Mobile keyboards make a separate modal
  // gratuitous; the sheet IS the modal.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // Live schedules count for the ⋯ sheet label — the footer toolbar (which
  // used to surface it) is hidden on mobile (BET-258), so the sheet carries
  // it instead. Count is omitted entirely on 0 or fetch failure.
  const [scheduleCount, setScheduleCount] = useState(0);

  const project = projects.find((p) => p.tmuxSession === projectName);
  const win = project?.windows.find((w) => w.index === windowIndex);

  // Pop back to the list if the window vanished (killed remotely / status
  // poller dropped it) instead of rendering a dead body.
  useEffect(() => {
    if (projects.length > 0 && !win) onBack();
  }, [projects.length, win, onBack]);

  // `win` may still be undefined here (early-returned below) — every hook
  // in this component must run unconditionally on every render, so `sid` is
  // read via optional chaining rather than after the early return.
  const sid = win?.opencodeSessionId ?? null;
  const owner = sid ? resolveSessionOwner(projects, sid) : null;

  // Session-mode toggle (BET-138): Chat / Terminal / an AI CLI TUI launcher.
  // `sid` is set for every manta-created session, so mode only matters when
  // it's present; the `!sid` branches below are the legacy foreign-window
  // fallback (manta never creates those anymore).
  const [mode, setModeState] = useState<SessionMode>(() =>
    sid ? readSavedMode(sid) : "chat",
  );
  const [availableLaunchers, setAvailableLaunchers] = useState<AvailableLauncher[]>([]);

  useEffect(() => {
    window.api
      .launchersList()
      .then(setAvailableLaunchers)
      .catch(() => setAvailableLaunchers([]));
  }, [sid]);

  // Fetch the schedules count when the ⋯ sheet opens so the live count
  // shows on the sheet label (the footer toolbar that used to carry it
  // is hidden on mobile). Guarded with a cancelled flag so a fast
  // open/close can't land setState on an unmounted render.
  useEffect(() => {
    if (!sheetOpen || !sid) return;
    let cancelled = false;
    window.api
      .scheduleList(sid)
      .then((jobs) => {
        if (cancelled) return;
        setScheduleCount(Array.isArray(jobs) ? jobs.length : 0);
      })
      .catch(() => {
        if (cancelled) return;
        setScheduleCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetOpen, sid]);

  useEffect(() => {
    setModeState(sid ? readSavedMode(sid, availableLaunchers) : "chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const setMode = (m: SessionMode) => {
    if (sid) writeSavedMode(sid, m);
    setModeState(m);
  };

  // "chat" only makes sense when sid is set (guarded in the render switch
  // below); for a legacy foreign window (no sid — manta never creates these
  // anymore) mode is always effectively "terminal", so modeId falls back to
  // "terminal" rather than mis-parsing "chat" as a launcher id.
  const modeId = mode.startsWith("tui:") ? mode.slice("tui:".length) : "terminal";
  const launcherDef = mode.startsWith("tui:")
    ? availableLaunchers.find((l) => l.id === modeId)
    : undefined;
  const launcher = launcherDef
    ? { id: launcherDef.id, flags: resolveLauncherFlags(launcherDef.flags, launcherFlags[launcherDef.id]) }
    : undefined;

  if (!project || !win) return null;

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
        cwd: owner?.cwd ?? "",
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

  // Rename uses tmux:rename-window — it renames the underlying tmux window
  // (the unit the user sees as a "session" in mobile UI). Works for BOTH
  // chat windows and terminal windows because both ARE tmux windows; the
  // chat-mode distinction is the @manta-session-id user-option, not the
  // window kind. Same channel desktop's Sidebar.tsx commitRename uses.
  const startRename = () => {
    setRenameValue(win.name);
    setRenameError(null);
    setRenaming(true);
  };
  const closeSheet = () => {
    setSheetOpen(false);
    setRenaming(false);
    setRenameError(null);
  };
  const commitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === win.name) {
      closeSheet();
      return;
    }
    try {
      await window.api.tmuxRenameWindow({
        sessionName: projectName,
        windowIndex: win.index,
        newName: trimmed,
      });
      await refresh();
      closeSheet();
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    }
  };

  // Esc / stop — interrupt the running agent. Mobile soft keyboards rarely
  // expose an Esc key, so terminal / AI CLI TUI windows keep an explicit
  // header button that writes \x1b to the mode's shell PTY. Chat mode's
  // interrupt lives in the KeyboardBar (which dispatches a synthetic Escape
  // keydown to the textarea → ChatPanel's existing onKeyDown → abort()).
  // Always available (not gated on a "running" flag): a stuck agent is
  // exactly the case where the running indicator may be stale, so the stop
  // must work regardless. Writing \x1b to an idle PTY is a harmless no-op.
  // Select the tmux window first: mobile navigation doesn't select-window
  // on open, and the legacy fallback path's PTY follows the active tmux
  // window, so without this ESC could land on a different window than the
  // one shown.
  const sendEsc = () => {
    window.api
      .tmuxSelectWindow({ sessionName: projectName, windowIndex: win.index })
      .catch(() => {})
      .finally(() => {
        window.api.ptyWrite(`${projectName}:${modeId}`, "\x1b").catch(() => {});
      });
  };

  // Kill is available for terminal windows too — for chat windows the
  // existing "Delete session" path already covers it (also deletes the
  // opencode session). Terminal-only path uses tmux:kill-window directly.
  const killWindow = async () => {
    try {
      await window.api.tmuxKillWindow({
        sessionName: projectName,
        windowIndex: win.index,
      });
      await refresh();
      closeSheet();
      onBack();
    } catch (e) {
      // Surface but keep sheet open so the user sees the error and can decide.
      setRenameError(e instanceof Error ? e.message : String(e));
    }
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
          {sid ? (
            <select
              className="mobile-tap text-text-faint text-xs bg-transparent"
              style={{ colorScheme: "dark" }}
              value={mode}
              onChange={(e) => setMode(e.target.value as SessionMode)}
            >
              <option value="chat">{projectName} · chat</option>
              <option value="terminal">{projectName} · terminal</option>
              {availableLaunchers.map((l) => (
                <option key={l.id} value={`tui:${l.id}`}>
                  {projectName} · {l.label}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-text-faint text-xs truncate">
              {projectName} · terminal
            </div>
          )}
        </div>
        {/* Esc / stop — interrupts the running agent the way pressing Esc
            would on desktop. Shown ONLY in terminal / AI CLI TUI mode; chat
            mode's interrupt lives in the KeyboardBar (esc key → synthetic
            keydown → textarea handler → abort). Always available rather than
            gated on a running flag: a stuck agent is exactly the case where
            the running indicator may be stale, so the stop must work
            regardless. */}
        {!(sid && mode === "chat") && (
          <button
            className="mobile-tap text-text-muted text-xs font-semibold px-2 border border-border rounded"
            onClick={sendEsc}
            aria-label="Send Esc to stop the agent"
            title="Esc"
          >
            Esc
          </button>
        )}
        {/* Action sheet is available for both chat and terminal windows now —
            terminal windows get rename + kill; chat windows additionally get
            fork / compact / delete. */}
        <button
          className="mobile-tap text-text-muted text-xl"
          onClick={() => setSheetOpen(true)}
          aria-label="Session actions"
        >
          ⋯
        </button>
      </div>

      <div className="mobile-body">
        {sid && mode === "chat" ? (
          <ChatPanel
            sessionId={sid}
            tmuxSession={owner?.tmuxSession ?? null}
            windowIndex={owner?.windowIndex ?? null}
            cwd={owner?.cwd ?? ""}
            isActive={true}
          />
        ) : (
          <Terminal
            sessionKey={`${sid ?? projectName}:${modeId}`}
            cwd={owner?.cwd ?? ""}
            launcher={launcher}
            active={true}
          />
        )}
      </div>

      {/* Keyboard accessory bar — chat mode only (BET-259). Rendered as the
          last child of the .mobile-screen flex column so normal flow docks
          it directly above the composer / on-screen keyboard on hosts that
          resize the viewport (Capacitor). iOS Safari's overlay-keyboard
          host uses an explicit translateY(-inset) computed from
          window.visualViewport (see KeyboardBar.tsx). */}
      {sid && mode === "chat" && (
        <KeyboardBar
          sessionId={sid}
          projectName={projectName}
          windowIndex={win.index}
        />
      )}

      {sheetOpen && (
        <div className="mobile-sheet-backdrop" onClick={closeSheet}>
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            {renaming ? (
              <div className="space-y-3 p-2">
                <div className="text-text font-semibold text-sm">
                  Rename session
                </div>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") closeSheet();
                  }}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                />
                {renameError && (
                  <div className="text-xs text-red-400">{renameError}</div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={commitRename}
                    className="flex-1 px-3 py-2 bg-accent text-bg rounded font-semibold"
                    style={{ textAlign: "center" }}
                  >
                    Save
                  </button>
                  <button
                    onClick={closeSheet}
                    className="flex-1 px-3 py-2 text-text-faint"
                    style={{ textAlign: "center" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button onClick={startRename}>Rename</button>
                {sid && (
                  <>
                    <button onClick={forkSession}>Fork session</button>
                    <button onClick={compactSession}>Compact context</button>
                    <button
                      onClick={() => {
                        // Open the ScheduledTasksCard inside ChatPanel via the
                        // window CustomEvent bridge (the sheet is outside it).
                        window.dispatchEvent(
                          new CustomEvent("manta-open-schedules", {
                            detail: { sessionId: sid },
                          }),
                        );
                        closeSheet();
                      }}
                    >
                      {scheduleCount > 0
                        ? `Scheduled tasks · ${scheduleCount}`
                        : "Scheduled tasks"}
                    </button>
                    <button
                      onClick={() => {
                        // Open the SecretsCard inside ChatPanel via the window
                        // CustomEvent bridge (mirror of manta-open-schedules).
                        window.dispatchEvent(
                          new CustomEvent("manta-open-secrets", {
                            detail: { sessionId: sid },
                          }),
                        );
                        closeSheet();
                      }}
                    >
                      Secrets
                    </button>
                    <button
                      onClick={() => {
                        // Open the WebhooksCard inside ChatPanel via the window
                        // CustomEvent bridge (mirror of manta-open-schedules).
                        window.dispatchEvent(
                          new CustomEvent("manta-open-webhooks", {
                            detail: { sessionId: sid },
                          }),
                        );
                        closeSheet();
                      }}
                    >
                      Webhooks
                    </button>
                    <button className="danger" onClick={deleteSession}>
                      Delete session
                    </button>
                  </>
                )}
                {!sid && (
                  <button className="danger" onClick={killWindow}>
                    Kill window
                  </button>
                )}
                <button onClick={closeSheet}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
