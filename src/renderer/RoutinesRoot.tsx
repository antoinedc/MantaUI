// ===== Routines — the pane's router =====
//
// Owns which Routines page is showing (list / one routine / one run) and the
// two modals that open over them (editor R4, move-to-chat R7). The convert
// modal (R6) opens from a chat's ⏰ card instead (ChatPanel).
// The summary comes from App (it also feeds the sidebar badge), so there is
// one subscription, not one per page.

import { useCallback, useState } from "react";
import type { Routine, RoutineRun, RoutinesSummary } from "../shared/routines";
import { RoutineReportModal } from "./RoutineReportModal";
import { MoveToChatModal } from "./MoveToChatModal";
import { RoutineDetail } from "./RoutineDetail";
import { RoutineEditor } from "./RoutineEditor";
import { RoutineRunView } from "./RoutineRunView";
import { RoutinesPane } from "./RoutinesPane";
import { hasReportView, useRoutinesRefetch } from "./routinesData";

// `report` = a run's report shown as a modal over the list / routine page (report-first).
export type RoutinesView =
  | null
  | { page: "list"; report?: string }
  | { page: "routine"; id: string; report?: string }
  | { page: "run"; runId: string };

export function RoutinesRoot({
  view,
  setView,
  summary,
  error,
  reload,
}: {
  view: Exclude<RoutinesView, null>;
  setView: (v: RoutinesView) => void;
  summary: RoutinesSummary | null;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ routine: Routine | null; memory: string } | null>(null);
  const [toChat, setToChat] = useState<{ routine: Routine; runCount: number; memory: string } | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const refresh = useCallback(() => {
    void reload();
    setDetailVersion((v) => v + 1);
  }, [reload]);

  // The page's own freshness while it is open: refetch on the hint and every 30 s.
  useRoutinesRefetch(() => void reload(), 30_000);

  const openTranscript = (runId: string) => setView({ page: "run", runId });
  // A finished run opens report-first (the modal over this page); anything else opens its transcript.
  const openRun = (runId: string, run?: RoutineRun) => {
    if (run && hasReportView(run) && view.page !== "run") setView({ ...view, report: runId });
    else openTranscript(runId);
  };
  const closeReport = () => {
    if (view.page !== "run") setView({ ...view, report: undefined });
  };
  const openRoutine = (id: string) => setView({ page: "routine", id });
  const list = () => setView({ page: "list" });
  const close = () => setView(null);

  const tz = summary?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      {view.page === "list" && (
        <RoutinesPane
          summary={summary}
          error={error}
          reload={reload}
          onOpenRoutine={openRoutine}
          onOpenRun={openRun}
          onNewRoutine={() => setEditor({ routine: null, memory: "" })}
        />
      )}
      {view.page === "routine" && (
        <RoutineDetail
          key={`${view.id}:${detailVersion}`}
          routineId={view.id}
          summary={summary}
          onBack={list}
          onOpenRun={openRun}
          onEdit={(routine, memory) => setEditor({ routine, memory })}
          onMoveToChat={(routine, ctx) => setToChat({ routine, ...ctx })}
          onChanged={() => void reload()}
        />
      )}
      {view.page === "run" && (
        <RoutineRunView
          key={view.runId}
          runId={view.runId}
          onBack={list}
          onOpenRoutine={openRoutine}
          onOpenRun={openRun}
          onClosePane={close}
          onChanged={() => void reload()}
        />
      )}

      {view.page !== "run" && view.report && (
        <RoutineReportModal
          key={view.report}
          runId={view.report}
          onClose={closeReport}
          onSeeTranscript={() => openTranscript(view.report as string)}
          onClosePane={close}
          onChanged={() => void reload()}
        />
      )}
      <RoutineEditor
        key={editor ? `${editor.routine?.id ?? "new"}` : "closed"}
        open={editor != null}
        routine={editor?.routine ?? null}
        memory={editor?.memory}
        tz={tz}
        onClose={() => setEditor(null)}
        onSaved={(r) => {
          const wasNew = editor?.routine == null;
          setEditor(null);
          refresh();
          if (wasNew) openRoutine(r.id);
        }}
        onTestRun={(r, runId) => {
          setEditor(null);
          refresh();
          openRun(runId);
          void r;
        }}
      />
      <MoveToChatModal
        routine={toChat?.routine ?? null}
        runCount={toChat?.runCount ?? 0}
        memory={toChat?.memory ?? ""}
        onClose={() => setToChat(null)}
        onMoved={() => {
          setToChat(null);
          refresh();
        }}
      />
    </>
  );
}
