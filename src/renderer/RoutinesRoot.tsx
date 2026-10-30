// ===== Routines — the pane's router =====
//
// Owns which Routines page is showing (list / one routine with its runs / one
// run's transcript) and the two modals that open over them (editor R4,
// move-to-chat R7). The convert modal (R6) opens from a chat's ⏰ card instead
// (ChatPanel).
// The summary comes from App (it also feeds the sidebar badge), so there is
// one subscription, not one per page.

import { useCallback, useEffect, useState } from "react";
import type { Routine, RoutineRun, RoutinesSummary } from "../shared/routines";
import { MoveToChatModal } from "./MoveToChatModal";
import { RoutineDetail } from "./RoutineDetail";
import { RoutineEditor } from "./RoutineEditor";
import { RoutineRunView } from "./RoutineRunView";
import { RoutinesPane } from "./RoutinesPane";
import { CrumbLink, PageColumn, RoutinesHeader } from "./RoutinesParts";
import { errMessage, routinesToast, useRoutinesRefetch } from "./routinesData";

// `routine.runId` = the run selected in the routine page's run list ("about" = the
// About item). `open-run` is transient: a run known only by its id (a notification)
// is resolved to its routine, then replaced by the `routine` page with it selected.
export type RoutinesView =
  | null
  | { page: "list" }
  | { page: "routine"; id: string; runId?: string }
  | { page: "run"; runId: string }
  | { page: "open-run"; runId: string };

function OpenRun({ runId, setView }: { runId: string; setView: (v: RoutinesView) => void }) {
  useEffect(() => {
    let live = true;
    window.api
      .routinesRunGet(runId)
      .then((r) => {
        if (live && r) setView({ page: "routine", id: r.run.routineId, runId });
      })
      .catch((e: unknown) => {
        if (!live) return;
        routinesToast("error", `Couldn't open the run — ${errMessage(e)}`);
        setView({ page: "list" });
      });
    return () => {
      live = false;
    };
  }, [runId, setView]);
  return (
    <div className="manta-routines-pane flex h-full w-full flex-col bg-bg" data-screen="routines">
      <RoutinesHeader>
        <CrumbLink onClick={() => setView({ page: "list" })}>Routines</CrumbLink>
      </RoutinesHeader>
      <PageColumn>
        <div className="text-body text-text-faint">Opening the run…</div>
      </PageColumn>
    </div>
  );
}

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
  // A run from the list opens in its routine's page with that run selected.
  const openRun = (runId: string, run: RoutineRun) => setView({ page: "routine", id: run.routineId, runId });
  const openRoutine = (id: string, runId?: string) => setView({ page: "routine", id, ...(runId ? { runId } : {}) });
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
          onOpenTranscript={openTranscript}
          onNewRoutine={() => setEditor({ routine: null, memory: "" })}
        />
      )}
      {view.page === "routine" && (
        <RoutineDetail
          key={`${view.id}:${detailVersion}`}
          routineId={view.id}
          summary={summary}
          runId={view.runId}
          onBack={list}
          onSelectRun={(runId) => openRoutine(view.id, runId)}
          onOpenTranscript={openTranscript}
          onClosePane={close}
          onEdit={(routine, memory) => setEditor({ routine, memory })}
          onMoveToChat={(routine, ctx) => setToChat({ routine, ...ctx })}
          onChanged={() => void reload()}
        />
      )}
      {view.page === "open-run" && <OpenRun key={view.runId} runId={view.runId} setView={setView} />}
      {view.page === "run" && (
        <RoutineRunView
          key={view.runId}
          runId={view.runId}
          onBack={list}
          onOpenRoutine={openRoutine}
          onOpenRun={openTranscript}
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
          openTranscript(runId);
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
