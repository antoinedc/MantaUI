// ===== Fleet rows (docs/superpowers/specs/2026-11-28-fleet-redesign.md §3, mockup v10) =====
//
// A running row is `title | agent (Projects view) or project (Agents view) | status | Open session`; an Ended today row is
// `title + agent · project · when + one sentence | outcome badge | Open session`, with the badge in the SAME column as the running
// rows' status so the two sections line up. The columns come from the list's own width (container queries on the page column:
// stacked under 560 px, three columns from 560, four from 850), never from the window.
//
// Every class below is written out in full: Tailwind only generates what it can read.

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentInfo, FleetEnded, FleetTask } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { relativeAgo } from "../jobProgress";
import { endedBadge, groupSummary, statusView, UNREACHABLE_TITLE, type BadgeTone, type FleetBy, type TaskGroup } from "./fleetView";

/** A running row: three areas in a stack, three columns from 560 px, four from 850 px. */
const TASK_ROW =
  "grid items-center gap-x-3 gap-y-1 border-b border-border-subtle py-3 " +
  "[grid-template-columns:minmax(0,1fr)_auto] [grid-template-areas:'tt_tt'_'who_who'_'stat_acts'] " +
  "[@container(min-width:560px)]:items-start [@container(min-width:560px)]:gap-x-4 " +
  "[@container(min-width:560px)]:[grid-template-columns:minmax(0,1fr)_190px_200px] [@container(min-width:560px)]:[grid-template-areas:'tt_stat_acts'_'who_stat_acts'] " +
  "[@container(min-width:850px)]:gap-x-5 " +
  "[@container(min-width:850px)]:[grid-template-columns:minmax(0,1fr)_160px_230px_200px] [@container(min-width:850px)]:[grid-template-areas:'tt_who_stat_acts']";

/** An Ended today row: its badge sits where the running rows' status sits. */
const ENDED_ROW =
  "grid items-center gap-x-3 gap-y-1 border-b border-border-subtle py-3 " +
  "[grid-template-columns:minmax(0,1fr)_auto] [grid-template-areas:'body_body'_'badge_acts'] " +
  "[@container(min-width:560px)]:items-start [@container(min-width:560px)]:gap-x-4 " +
  "[@container(min-width:560px)]:[grid-template-columns:minmax(0,1fr)_190px_200px] [@container(min-width:560px)]:[grid-template-areas:'body_badge_acts'] " +
  "[@container(min-width:850px)]:gap-x-5 " +
  "[@container(min-width:850px)]:[grid-template-columns:minmax(0,1fr)_160px_230px_200px] [@container(min-width:850px)]:[grid-template-areas:'body_body_badge_acts']";

const TITLE_BTN =
  "m-0 flex min-h-6 max-w-full items-center rounded-xs border-0 bg-transparent p-0 text-left text-body font-medium text-text hover:underline hover:decoration-border-strong hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const BADGE_TONE: Record<BadgeTone, string> = {
  ok: "bg-ok-bg text-ok shadow-[inset_0_0_0_1px_var(--ok)]",
  bad: "bg-danger-bg text-danger shadow-[inset_0_0_0_1px_var(--danger)]",
  cut: "bg-warn-bg text-warn shadow-[inset_0_0_0_1px_var(--warn)]",
  neutral: "bg-fill-active text-text-muted shadow-[inset_0_0_0_1px_var(--border-strong)]",
};

/** The agent's name beside its badge (the Projects view's second column). */
export const AgentWho = ({ info, slug }: { info: AgentInfo | undefined; slug: string }) => (
  <span className="flex min-w-0 items-center gap-2">
    <AgentBadge size="sm" agent={{ name: info?.name || slug, slug, color: info?.color ?? null }} />
    <span className="truncate">{info?.name || slug}</span>
  </span>
);

const ActionButton = ({ onClick, disabled, title, label, children, accent = true }: { onClick: () => void; disabled?: boolean; title?: string; label: string; children: ReactNode; accent?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={label}
    className={`inline-flex min-h-7 items-center whitespace-nowrap rounded-sm border-0 bg-transparent px-2 text-label font-medium hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${accent ? "text-accent-tx" : "text-text-muted hover:text-text"}`}
  >
    {children}
  </button>
);

export function TaskRow({
  task,
  by,
  info,
  now,
  offline,
  resumeBlocked,
  openBusy,
  actionBusy,
  error,
  onDetails,
  onOpen,
  onResume,
  onRetryStop,
}: {
  task: FleetTask;
  by: FleetBy;
  info: AgentInfo | undefined;
  now: number;
  offline: boolean;
  resumeBlocked: string | null;
  openBusy: boolean;
  actionBusy: boolean;
  error: { kind: "stop" | "resume"; text: string } | null;
  onDetails: (jobId: string) => void;
  onOpen: (jobId: string) => void;
  onResume: (task: FleetTask) => void;
  onRetryStop: (task: FleetTask) => void;
}) {
  const status = statusView(task, now);
  const off = offline ? UNREACHABLE_TITLE : undefined;
  const paused = task.status === "paused-by-you";
  return (
    <li data-testid="fleet-task-row" data-job={task.jobId} data-status={task.status} className={TASK_ROW}>
      <div className="min-w-0 [grid-area:tt]">
        <button type="button" onClick={() => onDetails(task.jobId)} title={task.title} aria-label={`Details: ${task.title}`} className={TITLE_BTN}>
          <span className="line-clamp-2 overflow-hidden break-words">{task.title}</span>
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-label text-text-muted [grid-area:who] [@container(min-width:850px)]:pt-[3px]" data-testid="fleet-task-who">
        {by === "projects" ? <AgentWho info={info} slug={task.agentSlug} /> : <span className="truncate">{task.projectName ?? "No project"}</span>}
      </div>
      <div className="mt-1 flex min-w-0 items-start gap-2 text-label [grid-area:stat] [@container(min-width:560px)]:mt-[2px]" data-testid="fleet-task-status">
        <span aria-hidden="true" className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${status.tone === "ok" ? "bg-ok" : "bg-text-faint"}`} />
        <span className="min-w-0">
          <span className="block text-text">{status.label}</span>
          {status.sub && <span className="block text-meta text-text-muted">{status.sub}</span>}
        </span>
      </div>
      <div className="flex flex-nowrap items-center justify-end gap-[2px] [grid-area:acts]">
        {paused && (
          <button
            type="button"
            onClick={() => onResume(task)}
            disabled={offline || actionBusy || resumeBlocked != null}
            title={off ?? resumeBlocked ?? undefined}
            aria-label={`Resume: ${task.title}`}
            className="inline-flex h-[30px] items-center rounded-sm border border-border bg-bg-soft px-3 text-label font-medium text-text shadow-sm hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionBusy ? "Resuming…" : "Resume"}
          </button>
        )}
        <ActionButton label={`Open session: ${task.title}`} onClick={() => onOpen(task.jobId)} disabled={offline || openBusy} title={off}>
          {openBusy ? "Opening…" : "Open session"}
        </ActionButton>
      </div>
      {error && (
        <div role="alert" data-testid="fleet-task-error" className="mt-1 flex flex-wrap items-start gap-2 rounded-sm bg-danger-bg px-2 py-1 text-meta text-text [grid-column:1/-1]">
          <span className="min-w-[10rem] flex-1 break-words">
            <b className="font-semibold text-danger">{error.kind === "stop" ? "Couldn’t stop it." : "Couldn’t resume it."}</b> {error.text}
          </span>
          {error.kind === "stop" && (
            <ActionButton label={`Try stopping again: ${task.title}`} onClick={() => onRetryStop(task)} disabled={offline} title={off}>
              Try again
            </ActionButton>
          )}
        </div>
      )}
    </li>
  );
}

export function EndedRow({
  task,
  info,
  now,
  offline,
  openBusy,
  onDetails,
  onOpen,
}: {
  task: FleetEnded;
  info: AgentInfo | undefined;
  now: number;
  offline: boolean;
  openBusy: boolean;
  onDetails: (jobId: string) => void;
  onOpen: (jobId: string) => void;
}) {
  const badge = endedBadge(task.outcome);
  const off = offline ? UNREACHABLE_TITLE : undefined;
  return (
    <li data-testid="fleet-ended-row" data-job={task.jobId} data-outcome={task.outcome} className={ENDED_ROW}>
      <div className="min-w-0 [grid-area:body]">
        <button type="button" onClick={() => onDetails(task.jobId)} title={task.title} aria-label={`Details: ${task.title}`} className={TITLE_BTN}>
          <span className="line-clamp-2 overflow-hidden break-words">{task.title}</span>
        </button>
        <div className="mt-[2px] break-words text-meta leading-[1.6] text-text-muted">
          <span className="inline-flex items-center gap-2 align-middle font-medium text-text">
            <AgentBadge size="sm" agent={{ name: info?.name || task.agentSlug, slug: task.agentSlug, color: info?.color ?? null }} />
            {info?.name || task.agentSlug}
          </span>
          <span>
            {" "}
            · {task.projectName ?? "No project"} · {relativeAgo(now - task.endedAt)}
          </span>
        </div>
        <div className="mt-[2px] text-label leading-normal text-text-muted">{task.sentence}</div>
      </div>
      <div className="[grid-area:badge]">
        <span data-testid="fleet-ended-badge" className={`inline-flex min-h-[22px] items-center whitespace-nowrap rounded-full px-2 py-px text-meta font-semibold ${BADGE_TONE[badge.tone]}`}>
          {badge.label}
        </span>
      </div>
      <div className="flex flex-nowrap items-center justify-end [grid-area:acts]">
        <ActionButton label={`Open session: ${task.title}`} onClick={() => onOpen(task.jobId)} disabled={offline || openBusy} title={off}>
          {openBusy ? "Opening…" : "Open session"}
        </ActionButton>
      </div>
    </li>
  );
}

/** One project's (or agent's) running rows under their heading and summary. */
export function TaskGroupView({ group, id, heading, children }: { group: TaskGroup; id: string; heading: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} data-testid="fleet-group" data-group={group.key} className="[&+&]:mt-8">
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
        <h2 id={id} className="m-0 flex items-center gap-2 break-words text-body font-semibold tracking-[-0.01em] text-text [overflow-wrap:anywhere]">
          {heading}
        </h2>
        <span className="text-label text-text-muted">{groupSummary(group.tasks)}</span>
      </div>
      <ul className="m-0 list-none border-t border-border-subtle p-0">{children}</ul>
    </section>
  );
}

/** Ended today: the first few rows, the rest behind a native <details> ("Show N more"). */
export function EndedSection({ ended, shown = 4, renderRow }: { ended: ReadonlyArray<FleetEnded>; shown?: number; renderRow: (e: FleetEnded) => ReactNode }) {
  if (ended.length === 0) return null;
  const first = ended.slice(0, shown);
  const rest = ended.slice(shown);
  return (
    <section aria-labelledby="fleet-ended-h" data-testid="fleet-ended" className="mt-10">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-[10px]">
        <h2 id="fleet-ended-h" className="m-0 text-body font-semibold tracking-[-0.01em] text-text">
          Ended today
        </h2>
        <span className="text-label text-text-muted">
          {ended.length} {ended.length === 1 ? "task" : "tasks"}
        </span>
      </div>
      <ul className="m-0 list-none border-t border-border-subtle p-0">{first.map(renderRow)}</ul>
      {rest.length > 0 && (
        <details className="group" data-testid="fleet-ended-more">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-[6px] py-[6px] text-label font-medium text-text-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Show {rest.length} more
          </summary>
          <ul className="m-0 list-none p-0">{rest.map(renderRow)}</ul>
        </details>
      )}
    </section>
  );
}
