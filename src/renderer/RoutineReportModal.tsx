// ===== A run, report first =====
//
// Opening a finished run shows its report on its own — what most people open a
// run for — with "See full transcript" for everything else (RoutineRunView). A run
// with nothing to report (running, waiting on an answer, stopped) skips the modal
// and goes straight to the transcript.

import { useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import type { Routine, RoutineRun } from "../shared/routines";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { NotifiedLine, ReportCard } from "./RoutineRunParts";
import { RoutineModalFooter, RoutineModalHeader } from "./RoutinesParts";
import { errMessage, hasReportView, startFixIt } from "./routinesData";
import { isTerminal, runCrumbLabel } from "./routinesView";

export function RoutineReportModal({
  runId,
  onClose,
  onSeeTranscript,
  onClosePane,
  onChanged,
}: {
  runId: string;
  onClose: () => void;
  /** Open the run's full transcript (also taken when the run has no report to show). */
  onSeeTranscript: () => void;
  /** Leave the Routines pane (after Fix it). */
  onClosePane: () => void;
  /** The summary / badge should refetch (the run got marked read). */
  onChanged: () => void;
}) {
  const [data, setData] = useState<{ run: RoutineRun; routine: Routine } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const marked = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    window.api
      .routinesRunGet(runId)
      .then((r) => {
        if (!live || !r) return;
        if (!hasReportView(r.run)) {
          onSeeTranscript();
          return;
        }
        setData({ run: r.run, routine: r.routine });
      })
      .catch((e: unknown) => live && setError(errMessage(e)));
    return () => {
      live = false;
    };
    // Load once per run; the callbacks are not part of what is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Reading the report reads the run (spec §6.4), same as opening its transcript.
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

  // Nothing to draw until we know the run has a report (else it redirects). A load
  // failure still opens, so the error is said rather than the click looking dead.
  if (!data && !error) return null;

  const title = data ? `${data.routine.name} · ${runCrumbLabel(data.run.startedAt ?? data.run.queuedAt)}` : "Run report";
  return (
    <Modal size="lg" tall padded={false} open onDismiss={onClose} label="Run report">
      <div className="manta-routines-report-modal flex min-h-0 flex-1 flex-col">
        <RoutineModalHeader title={title} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {data ? (
            <ReportCard run={data.run} routine={data.routine} chrome={false} />
          ) : (
            <div className="px-5 py-4 text-body text-text-faint">Couldn't load the run — {error}</div>
          )}
        </div>
        <RoutineModalFooter>
          <span className="flex min-w-0 items-center gap-2 text-meta text-text-faint">{data && <NotifiedLine run={data.run} />}</span>
          <span className="ml-auto" />
          <Button tone="default" onClick={onSeeTranscript}>
            <MessageSquareText size={14} aria-hidden />
            See full transcript
          </Button>
          {data && data.run.report?.outcome !== "nothing" && (
            <Button
              tone="primary"
              onClick={() => {
                startFixIt(data.routine, data.run);
                onClosePane();
              }}
            >
              Fix it in a new session
            </Button>
          )}
        </RoutineModalFooter>
      </div>
    </Modal>
  );
}
