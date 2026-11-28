// ===== Fleet's Details (the task side panel, trimmed — mockup v10) =====
//
// The technical record of one task, one click from its row: status, agent, project, who asked, what it is doing now, when it
// started, its branch, its checklist (live: it comes from the chat store's job, which the box's updates keep current), and the
// two actions that belong to the task: Open session, and Stop (behind a confirmation) or Resume. An ended task shows its outcome,
// its one sentence and the technical record. Esc closes it; below 720 px of page body it takes the list's place.

import { X } from "lucide-react";
import type { AgentInfo, DelegateJob, FleetEnded, FleetTask } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { formatClockTime } from "../chatUtils";
import { IconButton } from "../IconButton";
import { boxNow, relativeAgo } from "../jobProgress";
import { askedByWho, endedBadge, statusView, UNREACHABLE_TITLE } from "./fleetView";

const DL = "mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-label";
const H3 = "m-0 mb-[6px] mt-5 text-meta font-semibold text-text-muted";
const BTN = "inline-flex h-8 items-center rounded-md border px-[14px] text-[12.5px] font-medium leading-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

function Row({ k, children, mono = false }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-text-muted">{k}</dt>
      <dd className={`m-0 break-words [overflow-wrap:anywhere] ${mono ? "font-mono text-meta" : ""}`}>{children}</dd>
    </>
  );
}

export type DetailsItem = { kind: "running"; task: FleetTask } | { kind: "ended"; task: FleetEnded };

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
  actionBusy,
  error,
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
  actionBusy: boolean;
  error: { kind: "stop" | "resume"; text: string } | null;
  onClose: () => void;
  onOpen: (jobId: string) => void;
  onStop: (task: FleetTask) => void;
  onResume: (task: FleetTask) => void;
}) {
  const task = item.task;
  const agentName = info?.name || task.agentSlug;
  const off = offline ? UNREACHABLE_TITLE : undefined;
  const view = storeJob?.view;
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
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => onOpen(e.jobId)} disabled={offline || openBusy} title={off} className={`${BTN} border-accent-solid bg-accent-solid text-on-accent`}>
              {openBusy ? "Opening…" : "Open session"}
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const t = item.task;
  const status = statusView(t, now);
  const paused = t.status === "paused-by-you";
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
          {!paused && view?.headline && <Row k="Now">{view.headline}</Row>}
          {!paused && t.startedAt > 0 && (
            <Row k="Started">
              {formatClockTime(t.startedAt)} · {relativeAgo(box - t.startedAt)}
            </Row>
          )}
          <Row k="Branch" mono>
            {t.branch ?? "—"}
          </Row>
        </dl>
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
        {error && (
          <p role="alert" data-testid="fleet-details-error" className="m-0 mt-[10px] break-words rounded-sm bg-danger-bg px-[10px] py-2">
            <b className="font-semibold text-danger">{error.kind === "stop" ? "Couldn’t stop it." : "Couldn’t resume it."}</b> {error.text}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => onOpen(t.jobId)} disabled={offline || openBusy} title={off} className={`${BTN} border-accent-solid bg-accent-solid text-on-accent`}>
            {openBusy ? "Opening…" : "Open session"}
          </button>
          {paused ? (
            <button type="button" onClick={() => onResume(t)} disabled={offline || actionBusy || resumeBlocked != null} title={off ?? resumeBlocked ?? undefined} className={`${BTN} border-border bg-bg text-text`}>
              {actionBusy ? "Resuming…" : "Resume"}
            </button>
          ) : (
            <button type="button" onClick={() => onStop(t)} disabled={offline || actionBusy} title={off} className={`${BTN} border-transparent bg-transparent text-danger hover:bg-danger-bg`}>
              {error?.kind === "stop" ? "Try stopping again" : "Stop task"}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
