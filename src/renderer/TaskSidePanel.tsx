// ===== The task side panel (agent screens spec §2.5) =====
//
// Opened by an agent task card's Details (the run card's toggle and the result card's button, both through
// `openTaskPanel`). One panel per chat, in the session's right slot — the slot Explorer and Artifacts share, so opening
// one closes the other (explorerStore.setRightPanel is the only writer). Top to bottom: a top bar (who, which task, its
// state, Close), What happened (the job's own `JobDetails`), the research it relied on, and the brief, collapsed.
//
// The panel shows whatever the agent reported — there are no fixed step names. It follows the task across rounds: the job
// id it is given resolves to the newest record of the same task (`resolveTaskJob`).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { AgentResearchEntry, DelegateJob } from "../shared/types";
import { AgentBadge } from "./AgentBadge";
import { JobDetails } from "./BackgroundCards";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { ResearchRows } from "./ResearchRows";
import { agentSlugOf, resolveTaskJob, rootJobOf, taskBriefOf } from "./agentDispatch";
import { AGE_TICK_MS, WORKING_TICK_MS, nowMs, useClockTick } from "./clock";
import { setRightPanel, useTaskPanelJobId } from "./explorer/explorerStore";
import { useTaskQuestions } from "./hooks/useTaskQuestions";
import { boxNow, elapsedMs, isRunningView } from "./jobProgress";
import { usePackageAgents } from "./packageAgents";
import { useStore } from "./store";

/** Width of the panel (the Artifacts panel is 340; this one carries step text). */
export const TASK_PANEL_WIDTH_PX = 440;

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

function doneAfter(ms: number | null): string | null {
  if (ms == null) return null;
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "Working · 1 question" / "Done · 6 min" / "Failed" — the state of the shown round, plus the task's open questions. */
export function taskStateText(job: Pick<DelegateJob, "status" | "view">, box: number, openQuestions: number): string {
  let text: string;
  switch (job.status) {
    case "running":
      text = "Working";
      break;
    case "paused":
      text = "Paused";
      break;
    case "done": {
      const took = doneAfter(job.view ? elapsedMs(job.view, box) : null);
      text = took ? `Done · ${took}` : "Done";
      break;
    }
    case "failed":
      text = "Failed";
      break;
    case "stopped":
      text = "Stopped";
      break;
    default:
      text = String(job.status);
  }
  return openQuestions > 0 ? `${text} · ${openQuestions} ${openQuestions === 1 ? "question" : "questions"}` : text;
}

const H3 = "m-0 mb-2 text-meta font-semibold uppercase tracking-wider text-text-faint";

function ResearchBlock({ jobId }: { jobId: string }) {
  const [entries, setEntries] = useState<AgentResearchEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tickets = useRef({ issued: 0, applied: 0 });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const ticket = ++tickets.current.issued;
    try {
      const list = await window.api.agentsTaskResearch({ jobId });
      if (!alive.current || ticket < tickets.current.applied) return;
      tickets.current.applied = ticket;
      setEntries(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      if (alive.current && ticket >= tickets.current.applied) setError(errText(e));
    }
  }, [jobId]);
  useEffect(() => {
    setEntries(null);
    setError(null);
    void load();
  }, [load]);

  return (
    <section data-testid="task-panel-research">
      <h3 className={H3}>Research it relied on</h3>
      {error && !entries ? (
        <div className="flex flex-wrap items-center gap-2 text-meta">
          <span role="alert" className="break-words text-danger">
            Couldn't load the research: {error}
          </span>
          <Button tone="default" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : entries ? (
        <ResearchRows entries={entries} />
      ) : (
        <p className="m-0 text-label text-text-faint">Loading…</p>
      )}
    </section>
  );
}

function PanelBody({ sessionId, jobId }: { sessionId: string; jobId: string }) {
  const job = useStore((s) => resolveTaskJob(s.jobs, jobId));
  const skew = useStore((s) => (job ? s.jobSkew[job.id] : undefined));
  const { questions } = useTaskQuestions(sessionId);
  const { agents } = usePackageAgents();
  const detailsId = useId();
  const view = job?.view;
  useClockTick(view && isRunningView(view) ? WORKING_TICK_MS : AGE_TICK_MS);
  const box = boxNow(nowMs(), skew);

  const slug = agentSlugOf(job?.agent) ?? "";
  const info = agents?.find((a) => a.slug === slug);
  const agentName = info?.name || job?.agentName || slug || "Agent";
  const taskTitle = job?.title?.trim() || job?.name || "";
  const badge = { name: agentName, slug: slug || agentName, color: info?.color ?? null };
  const root = job ? rootJobOf(job) : jobId;
  const open = questions.filter((q) => q.rootJobId === root).length;
  const brief = job ? taskBriefOf(job) : "";

  return (
    <aside
      aria-label="Agent task"
      data-testid="task-panel"
      className="manta-agents-task-panel flex shrink-0 flex-col border-l border-border bg-bg-elev min-w-0"
      style={{ width: TASK_PANEL_WIDTH_PX }}
    >
      <div className="h-11 shrink-0 border-b border-border px-4">
        <div className="flex h-full items-center gap-2 pr-[var(--titlebar-inset-right)]">
          <AgentBadge agent={badge} size="sm" />
          <span className="min-w-0 flex-1 truncate text-label font-semibold text-text" data-testid="task-panel-title" title={job ? `${agentName} · ${taskTitle}` : agentName}>
            {job ? `${agentName} · ${taskTitle}` : "Agent task"}
          </span>
          {job && (
            <span className="shrink-0 whitespace-nowrap text-meta text-text-faint" data-testid="task-panel-state">
              {taskStateText(job, box, open)}
            </span>
          )}
          <IconButton label="Close" icon={<X />} onClick={() => setRightPanel(sessionId, "none")} />
        </div>
      </div>
      <div className="flex flex-col gap-6 overflow-auto px-4 pb-6 pt-4">
        {!job ? (
          <p className="m-0 text-label text-text-muted" data-testid="task-panel-gone">
            This task is no longer on the box.
          </p>
        ) : (
          <>
            <section>
              <h3 className={H3}>What happened</h3>
              {view ? <JobDetails id={detailsId} view={view} box={box} /> : <p className="m-0 text-label text-text-faint">No progress reported yet.</p>}
            </section>
            <ResearchBlock jobId={job.id} />
            {brief && (
              <details data-testid="task-panel-brief" className="group border-t border-border-subtle pt-3">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-label font-semibold text-text [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={12} aria-hidden="true" className="text-text-faint transition-transform group-open:rotate-90" />
                  Brief <span className="font-normal tracking-normal text-text-faint">written by Manta from your request</span>
                </summary>
                <p className="m-0 mt-2 whitespace-pre-wrap break-words text-label text-text-muted">{brief}</p>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** The right-slot panel for this chat's task; renders nothing unless the slot is on it. */
export function TaskSidePanel({ sessionId }: { sessionId: string }): JSX.Element | null {
  const jobId = useTaskPanelJobId(sessionId);
  if (!jobId) return null;
  return <PanelBody sessionId={sessionId} jobId={jobId} />;
}
