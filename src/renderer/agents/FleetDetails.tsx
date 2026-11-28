// ===== Fleet's Details (the task side panel, trimmed — mockup v10) =====
//
// The technical record of one task, one click from its row: status, agent, project, who asked, what it is doing now, when it
// started, its branch, its checklist (live: it comes from the chat store's job, which the box's updates keep current), and the
// two actions that belong to the task: Open session, and Stop (behind a confirmation) or Resume. An ended task shows its outcome,
// its one sentence and the technical record. Esc closes it; below 720 px of page body it takes the list's place.

import { X } from "lucide-react";
import type { AgentInfo, DelegateJob, FleetEnded, FleetSub, FleetTask } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { Button } from "../Button";
import { formatClockTime } from "../chatUtils";
import { IconButton } from "../IconButton";
import { boxNow, relativeAgo } from "../jobProgress";
import { useTaskModelLabel } from "../taskModel";
import { SECONDARY_BTN } from "./FleetRows";
import { askedByWho, endedBadge, fallbackAgentName, isTaskRow, statusView, subStatusLabel, UNREACHABLE_TITLE } from "./fleetView";

const DL = "mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-label";
const H3 = "m-0 mb-[6px] mt-5 text-meta font-semibold text-text-muted";

function Row({ k, children, mono = false }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-text-muted">{k}</dt>
      <dd className={`m-0 break-words [overflow-wrap:anywhere] ${mono ? "font-mono text-meta" : ""}`}>{children}</dd>
    </>
  );
}

export type DetailsItem = { kind: "running"; task: FleetTask } | { kind: "ended"; task: FleetEnded };

/**
 * What runs beneath a session row (spec §5b): each subagent / helper job as title + status (and its agent). A paused job has its own
 * Resume; nothing here is a row of the Fleet list.
 */
function Subs({ subs, agentName, offline, resumeBlocked, busyJob, errors, onResume }: { subs: ReadonlyArray<FleetSub>; agentName: (slug: string) => string; offline: boolean; resumeBlocked: string | null; busyJob: string | null; errors: Record<string, { kind: "stop" | "resume"; text: string }>; onResume: (job: { jobId: string; title: string }) => void }) {
  if (subs.length === 0) return null;
  const off = offline ? UNREACHABLE_TITLE : undefined;
  return (
    <>
      <h3 className={H3}>Subagents and jobs · {subs.length}</h3>
      <ul className="m-0 list-none p-0" data-testid="fleet-details-subs">
        {subs.map((s) => {
          const st = subStatusLabel(s.status);
          const err = s.jobId ? errors[s.jobId] : undefined;
          return (
            <li key={s.key} data-testid="fleet-details-sub" data-status={s.status} className="flex flex-wrap items-start gap-x-2 gap-y-1 border-b border-border-subtle py-[6px]">
              <span aria-hidden="true" className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${st.tone === "ok" ? "bg-ok" : st.tone === "bad" ? "bg-danger" : "bg-text-faint"}`} />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                <span className="block text-text">{s.title}</span>
                <span className="block text-meta text-text-muted">
                  {st.label}
                  {s.agentSlug ? ` · ${agentName(s.agentSlug)}` : ""}
                </span>
                {err && (
                  <span role="alert" className="mt-1 block break-words text-meta">
                    <b className="font-semibold text-danger">Couldn’t resume it.</b> {err.text}
                  </span>
                )}
              </span>
              {s.status === "paused-by-you" && s.jobId && (
                <button type="button" onClick={() => onResume({ jobId: s.jobId as string, title: s.title })} disabled={offline || busyJob != null || resumeBlocked != null} title={off ?? resumeBlocked ?? undefined} aria-label={`Resume: ${s.title}`} className={SECONDARY_BTN}>
                  {busyJob === s.jobId ? "Resuming…" : "Resume"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function FleetDetails({
  item,
  info,
  storeJob,
  skew,
  now,
  chatName,
  offline,
  resumeBlocked,
  openBusy,
  canOpen,
  actionBusy,
  busyJobId,
  error,
  errors,
  agentName: nameOf,
  onClose,
  onOpen,
  onStop,
  onResume,
}: {
  item: DetailsItem;
  info: AgentInfo | undefined;
  /** The chat store's record of the same task: the live checklist and "now". */
  storeJob: DelegateJob | undefined;
  skew: number | undefined;
  now: number;
  chatName: string | null;
  offline: boolean;
  resumeBlocked: string | null;
  openBusy: boolean;
  canOpen: boolean;
  actionBusy: boolean;
  /** The job whose Resume / Stop is in flight (any job: one at a time). */
  busyJobId: string | null;
  error: { kind: "stop" | "resume"; text: string } | null;
  /** Every failed Resume by job id (the jobs beneath a row have their own). */
  errors: Record<string, { kind: "stop" | "resume"; text: string }>;
  agentName: (slug: string) => string;
  onClose: () => void;
  onOpen: (task: FleetTask | FleetEnded) => void;
  onStop: (task: FleetTask) => void;
  onResume: (job: { jobId: string; title: string }) => void;
}) {
  const task = item.task;
  const agentName = info?.name || fallbackAgentName(task.agentSlug);
  const off = offline ? UNREACHABLE_TITLE : undefined;
  const view = storeJob?.view;
  const modelLabel = useTaskModelLabel(task.model ?? storeJob?.modelUsed);
  const steps = view?.steps ?? null;
  const box = boxNow(now, skew);

  const header = (
    <div className="flex items-start gap-2 px-4 pb-[10px] pt-[14px]">
      <h2 id="fleet-details-title" className="m-0 min-w-0 flex-1 break-words text-prose font-semibold leading-snug [overflow-wrap:anywhere]">
        {task.title}
      </h2>
      <IconButton label="Close details" icon={<X />} onClick={onClose} />
    </div>
  );

  const common = (
    <>
      <Row k="Agent">
        <span className="inline-flex items-center gap-2">
          <AgentBadge size="sm" agent={{ name: agentName, slug: task.agentSlug, color: info?.color ?? null }} />
          {agentName}
        </span>
      </Row>
      <Row k="Project">{task.projectName ?? "No project"}</Row>
      <Row k="Asked by">{askedByWho(task.askedBy, chatName)}</Row>
      {modelLabel && (
        <Row k="Model">
          <span data-testid="fleet-details-model">{modelLabel}</span>
        </Row>
      )}
    </>
  );

  if (item.kind === "ended") {
    const e = item.task;
    const badge = endedBadge(e.outcome);
    return (
      <aside aria-labelledby="fleet-details-title" data-testid="fleet-details" data-kind="ended" className="flex min-h-full min-w-0 flex-col border-l border-border bg-bg-elev">
        {header}
        <div className="px-4 pb-5 text-label leading-normal">
          <p className="m-0 text-text">
            <b className="font-semibold">{badge.label}.</b> {e.sentence}
          </p>
          <dl className={DL}>
            {common}
            <Row k="Ended">{relativeAgo(now - e.endedAt)}</Row>
          </dl>
          <h3 className={H3}>Technical record</h3>
          <p className="m-0 break-words text-text-muted">{e.facts}</p>
          {e.branch && (
            <dl className={DL}>
              <Row k="Branch" mono>
                {e.branch}
              </Row>
            </dl>
          )}
          <Subs subs={e.subs ?? []} agentName={nameOf} offline={offline} resumeBlocked={resumeBlocked} busyJob={null} errors={errors} onResume={onResume} />
          {canOpen && (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button tone="primary" onClick={() => onOpen(e)} disabled={offline || openBusy} title={off}>
                {openBusy ? "Opening…" : "Open session"}
              </Button>
            </div>
          )}
        </div>
      </aside>
    );
  }

  const t = item.task;
  const status = statusView(t, now);
  const isTask = isTaskRow(t);
  const paused = t.status === "paused-by-you" && isTask;
  // the box's own line, unless the live job record has a fresher one
  const nowLine = (isTask ? view?.headline : null) || t.oneLiner || (isTask ? "" : (view?.headline ?? ""));
  return (
    <aside aria-labelledby="fleet-details-title" data-testid="fleet-details" data-kind="running" className="flex min-h-full min-w-0 flex-col border-l border-border bg-bg-elev">
      {header}
      <div className="px-4 pb-5 text-label leading-normal">
        <div className="flex items-start gap-2">
          <span aria-hidden="true" className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${status.tone === "ok" ? "bg-ok" : "bg-text-faint"}`} />
          <span>
            {status.label}
            {status.sub && <span className="text-text-muted"> · {status.sub}</span>}
          </span>
        </div>
        <dl className={DL}>
          {common}
          {t.status !== "paused-by-you" && nowLine && <Row k="Now">{nowLine}</Row>}
          {t.status !== "paused-by-you" && t.startedAt > 0 && (
            <Row k="Started">
              {formatClockTime(t.startedAt)} · {relativeAgo(box - t.startedAt)}
            </Row>
          )}
          {isTask && (
            <Row k="Branch" mono>
              {t.branch ?? "—"}
            </Row>
          )}
        </dl>
        {isTask && (
          <>
            <h3 className={H3}>Checklist{steps && steps.total > 0 ? ` · ${steps.done} of ${steps.total} done` : ""}</h3>
            {steps && steps.items.length > 0 ? (
              <ol className="m-0 list-none p-0" data-testid="fleet-details-checklist">
                {steps.items.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 border-b border-border-subtle py-[5px]">
                    <span
                      aria-hidden="true"
                      className={`mt-[2px] inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] ${s.status === "done" ? "bg-accent-solid text-on-accent" : s.status === "current" && !paused ? "shadow-[inset_0_0_0_2px_var(--accent)]" : "shadow-[inset_0_0_0_1px_var(--border-strong)]"}`}
                    >
                      {s.status === "done" ? "✓" : ""}
                    </span>
                    <span className={`min-w-0 flex-1 ${s.status === "current" && !paused ? "font-semibold" : ""}`}>
                      {s.text}
                      <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "current" && !paused ? " (current step)" : " (to do)"}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 text-text-muted">The agent hasn’t written its checklist yet.</p>
            )}
          </>
        )}
        <Subs subs={t.subs ?? []} agentName={nameOf} offline={offline} resumeBlocked={resumeBlocked} busyJob={busyJobId} errors={errors} onResume={onResume} />
        {error && (
          <p role="alert" data-testid="fleet-details-error" className="m-0 mt-[10px] break-words rounded-sm bg-danger-bg px-[10px] py-2">
            <b className="font-semibold text-danger">{error.kind === "stop" ? "Couldn’t stop it." : "Couldn’t resume it."}</b> {error.text}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {canOpen && (
            <Button tone="primary" onClick={() => onOpen(t)} disabled={offline || openBusy} title={off}>
              {openBusy ? "Opening…" : "Open session"}
            </Button>
          )}
          {isTask &&
            (paused ? (
              <Button tone="default" onClick={() => onResume(t)} disabled={offline || actionBusy || resumeBlocked != null} title={off ?? resumeBlocked ?? undefined}>
                {actionBusy ? "Resuming…" : "Resume"}
              </Button>
            ) : (
              <Button tone="danger" onClick={() => onStop(t)} disabled={offline || actionBusy} title={off}>
                {error?.kind === "stop" ? "Try stopping again" : "Stop task"}
              </Button>
            ))}
        </div>
      </div>
    </aside>
  );
}
