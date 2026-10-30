// ===== One run (R3) =====
//
// A routine run's transcript IS the ordinary ChatPanel mounted on the run's
// session id; this wrapper only loads the run, marks it read, and hands
// ChatPanel the `routineRun` binding (header crumb, run bar, instruction
// block, report card). A run still waiting in line has no session yet and
// shows a placeholder instead.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Routine, RoutineRun } from "../shared/routines";
import { X } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { IconButton } from "./IconButton";
import { RoutinesHeader, CrumbLink, CrumbSep, PageColumn } from "./RoutinesParts";
import { errMessage, keepRunInSidebar, useRoutinesRefetch } from "./routinesData";
import { basename, isTerminal, runCrumbLabel } from "./routinesView";
import { readSessionAuto, sessionBoxSelection, setSessionChoice } from "./modelPrefs";
import type { RoutineRunBinding } from "./routineRunContext";

interface Loaded {
  run: RoutineRun;
  routine: Routine;
  prevRunId: string | null;
  nextRunId: string | null;
}

export function RoutineRunView({
  runId,
  onBack,
  onOpenRoutine,
  onOpenRun,
  onClosePane,
  onChanged,
}: {
  runId: string;
  onBack: () => void;
  /** Back to the routine's page with this run selected. */
  onOpenRoutine: (routineId: string, runId: string) => void;
  /** Previous / next run: stays in the transcript view. */
  onOpenRun: (runId: string) => void;
  /** Leave the Routines pane (after Keep in sidebar / Follow up). */
  onClosePane: () => void;
  /** Something the summary / badge should pick up (a run got marked read). */
  onChanged: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const marked = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await window.api.routinesRunGet(runId);
      if (!alive.current || !r) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errMessage(e));
    }
  }, [runId]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  // The run changes while it is open (queued → running → done): refetch on the box's hint.
  useRoutinesRefetch(() => void load(), 15_000);

  // Opening a finished run reads it (spec §6.4); a run still in progress is read when it is opened after it ends.
  useEffect(() => {
    const run = data?.run;
    if (!run || run.readAt != null || !isTerminal(run.status) || marked.current === run.id) return;
    marked.current = run.id;
    void window.api
      .routinesMarkRead([run.id])
      .then(onChanged)
      .catch(() => {
        marked.current = null;
      });
  }, [data, onChanged]);

  // Replies from the composer default to the routine's own model: seed the run session's
  // per-session model choice once, only when it has none (the user's own pick always wins).
  const seededFor = useRef<string | null>(null);
  const seedSession = data?.run.sessionID ?? null;
  const seedModel = data?.routine.model ?? null;
  useEffect(() => {
    if (!seedSession || !seedModel || seededFor.current === seedSession) return;
    seededFor.current = seedSession;
    void window.api
      .modelPrefsGet?.()
      .then((prefs) => {
        const has = prefs?.sessions?.[seedSession] || sessionBoxSelection(seedSession) || readSessionAuto(seedSession);
        if (has) return;
        const { providerID, modelID, variant } = seedModel;
        setSessionChoice(seedSession, { kind: "model", model: { providerID, modelID, ...(variant ? { variant } : {}) } });
      })
      .catch(() => {
        /* no saved choice could be read: the composer keeps the server default */
      });
  }, [seedSession, seedModel]);

  const runId_ = data?.run.id ?? null;
  const keepInSidebar = useCallback(
    (what?: string) => {
      if (!runId_) return;
      void keepRunInSidebar(runId_, { onClosePane, onChanged, what });
    },
    [runId_, onClosePane, onChanged],
  );

  if (!data) {
    return (
      <div className="manta-routines-run flex h-full w-full flex-col bg-bg" data-screen="routines">
        <RoutinesHeader right={<IconButton label="Close run" title="Close and go back to Routines" size="xl" icon={<X />} onClick={onBack} />}>
          <CrumbLink onClick={onBack}>Routines</CrumbLink>
        </RoutinesHeader>
        <PageColumn>
          <div className="text-body text-text-faint">{error ? `Couldn't load the run — ${error}` : "Loading…"}</div>
        </PageColumn>
      </div>
    );
  }

  const { run, routine, prevRunId, nextRunId } = data;
  if (!run.sessionID || run.status === "queued") {
    return (
      <div className="manta-routines-run flex h-full w-full flex-col bg-bg" data-screen="routines">
        <RoutinesHeader right={<IconButton label="Close run" title="Close and go back to the routine" size="xl" icon={<X />} onClick={() => onOpenRoutine(routine.id, run.id)} />}>
          <CrumbLink onClick={onBack}>Routines</CrumbLink>
          <CrumbSep />
          <CrumbLink onClick={() => onOpenRoutine(routine.id, run.id)}>{routine.name}</CrumbLink>
          <CrumbSep />
          {runCrumbLabel(run.queuedAt)}
        </RoutinesHeader>
        <PageColumn>
          <div className="text-body text-text-faint">
            {run.status === "queued" ? "This run is waiting in line. Its session starts as soon as a slot is free." : run.error ?? "This run never started a session."}
          </div>
        </PageColumn>
      </div>
    );
  }

  const binding: RoutineRunBinding = {
    run,
    routine,
    prevRunId,
    nextRunId,
    onNavigate: onOpenRun,
    onKeep: () => keepInSidebar(),
    onBack,
    onOpenRoutine: () => onOpenRoutine(routine.id, run.id),
    onFollowUp: () => keepInSidebar("open the run as a session"),
  };

  return (
    <div className="manta-routines-run h-full w-full" data-screen="routines">
      <ChatPanel
        key={run.sessionID}
        sessionId={run.sessionID}
        tmuxSession={null}
        windowIndex={null}
        cwd={routine.directory}
        isActive
        projectName={routine.projectName ?? basename(routine.directory)}
        winName={routine.name}
        routineRun={binding}
      />
    </div>
  );
}
