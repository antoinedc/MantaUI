// ===== Background-run cards (v2-next Stage B, N4 + N5) =====
//
// Two surfaces, one visual language (the "background commands" mockup under
// docs/superpowers/specs/2026-10-23-opencode-v2-next/):
//
//   - BackgroundRunCards: the running / uncertain / failed cards under the
//     transcript, driven by the box's job store (N5). A job's card is REPLACED
//     by its finished card once the result is in the transcript, so it never
//     shows twice (the pairing lives in backgroundRun.deriveBackgroundCards).
//   - BackgroundResultCard: the finished card for a `background-result` part
//     (N4): the result text, its state and "Open session →". The same card
//     renders V2-native background commands and background `task` subagents.
//
// Agent screens: a task for a package agent shows "· N questions" while it waits on the user, says when its dispatch
// seated the agent in the project, and its Details open the task side panel (TaskSidePanel) instead of expanding inline.
//
// "Open session" is an action, so both outcomes are shown on the card itself:
// the window is selected on success, and a refusal / failure leaves a visible
// error under the card (AGENTS.md: never stub a control).

import { createContext, memo, useCallback, useContext, useId, useState } from "react";
import { useStore } from "./store";
import { usePackageAgents } from "./packageAgents";
import { ARCHITECT_AGENT_KEY, agentSlugOf, isAgentTask, leadDisplayName, packageAgentDisplayName, rootJobOf } from "./agentDispatch";
import { openTaskPanel } from "./explorer/explorerStore";
import { useTaskModelLabel } from "./taskModel";
import { ArchitectChanges } from "./ArchitectChanges";
import { ClampedMarkdown } from "./ClampedMarkdown";
import { nowMs, useClockTick, AGE_TICK_MS, WORKING_TICK_MS } from "./clock";
import {
  boxNow,
  detailsModel,
  findJobById,
  isRunningView,
  runCardView,
  type JobView,
} from "./jobProgress";
import {
  backgroundApi,
  NEEDS_DECISION_LABEL,
  openJobSession,
  describeBlockedActions,
  describeExceededActions,
  describeToldActions,
  resultStateLabel,
  resultTitleFor,
  resultTone,
  type BackgroundCard,
  type BackgroundResultPart,
  type ResultTone,
} from "./backgroundRun";

/** The "Open session" action for a job, with its own in-flight + error state. */
function useOpenSession(jobId: string | null | undefined) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(async () => {
    if (!jobId || busy) return;
    setBusy(true);
    setError(null);
    const r = await openJobSession(jobId, {
      open: (input) => backgroundApi().delegateOpenSession(input),
      // Same selection every sidebar row uses; the window may be one the box
      // just re-created, so re-list the tree first.
      select: async (tmuxSession, windowIndex) => {
        const st = useStore.getState();
        await st.refresh();
        await st.activateWindow(tmuxSession, windowIndex);
      },
    });
    setBusy(false);
    if (!r.ok) setError(r.error);
  }, [jobId, busy]);
  return { open, busy, error };
}

function OpenSessionButton({
  onOpen,
  busy,
  arrow = false,
  className = "",
}: {
  onOpen: () => void;
  busy: boolean;
  arrow?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      className={`shrink-0 whitespace-nowrap text-accent-tx hover:underline disabled:opacity-50 ${className}`}
      title="Open the background session"
      data-testid="background-open-session"
    >
      {busy ? "Opening…" : arrow ? "Open session →" : "Open session"}
    </button>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-1 text-meta text-danger break-words" data-testid="background-open-error">
      {message}
    </div>
  );
}

const TONE_DOT: Record<ResultTone, string> = {
  ok: "bg-ok",
  danger: "bg-danger",
  neutral: "bg-text-faint",
  warn: "bg-warn",
};

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="w-2.5 h-2.5 shrink-0 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none"
    />
  );
}

/**
 * The box's progress `view` for a card's job, with the client clock (spec
 * 2026-11-14 §5.3): `box` is the box's "now" as of this render, ticking once a
 * second while the job runs. Only a running / paused / settling card carries
 * content; an uncertain or failed-to-start card never does. No `view` (an older
 * box) → `view` is undefined and the card renders exactly as it always did.
 */
function useJobView(card: BackgroundCard): { view: JobView | undefined; box: number } {
  const job = useStore((s) => findJobById(s.jobs, card.jobId));
  const skew = useStore((s) => s.jobSkew[card.jobId]);
  const view = card.kind === "running" || card.kind === "settling" ? job?.view : undefined;
  useClockTick(view && isRunningView(view) ? WORKING_TICK_MS : AGE_TICK_MS);
  return { view, box: boxNow(nowMs(), skew) };
}

/**
 * How many open questions each task has, keyed by its root job id. ChatPanel provides it around the transcript (the cards
 * are rendered inside Transcript, which doesn't pass props through); `BackgroundRunCards`' own prop wins when given.
 */
export const OpenQuestionsByJobContext = createContext<ReadonlyMap<string, number> | null>(null);

const RunCard = memo(function RunCard({
  card,
  openQuestionsByJob,
}: {
  card: BackgroundCard;
  openQuestionsByJob: ReadonlyMap<string, number> | null;
}) {
  const { open, busy, error } = useOpenSession(card.jobId);
  const { view, box } = useJobView(card);
  const job = useStore((s) => findJobById(s.jobs, card.jobId));
  const agentTask = isAgentTask(job);
  const questions = job ? (openQuestionsByJob?.get(rootJobOf(job)) ?? 0) : 0;
  const seatAdded = job?.seatAdded;
  const seatSlug = agentSlugOf(job?.agent);
  const modelLabel = useTaskModelLabel(agentTask ? job?.modelUsed : null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const { agents: packageAgents } = usePackageAgents();
  const failed = card.kind === "failed";
  const spinning = card.kind === "starting" || (card.kind === "running" && !card.paused);
  // A task for a named agent reads "<Agent> · <task>" with the request quoted
  // beneath; the state words stay for the non-running cards.
  const agentLabel = card.agentName ?? null;
  const text =
    card.kind === "starting"
      ? (agentLabel ?? "Starting")
      : card.kind === "uncertain"
      ? "Couldn't confirm this started — open the session to check"
      : card.kind === "failed"
        ? "Failed to start"
        : card.kind === "settling"
          ? "Finished in background"
          : card.paused
            ? "Paused in background"
            : agentLabel
              ? agentLabel
              : "Running in background";
  const content = view ? runCardView(view, box) : null;
  const headline = content
    ? content.needsDecision
      ? content.headline
        ? `${NEEDS_DECISION_LABEL}: ${content.headline}`
        : NEEDS_DECISION_LABEL
      : content.headline
    : "";
  return (
    <div
      className={
        "rounded-lg border bg-bg-soft px-3 py-2 text-meta " +
        (failed ? "border-danger/40" : "border-accent/35")
      }
      data-testid="background-card"
      data-kind={card.kind}
      data-job-id={card.jobId}
    >
      <div className="flex items-center gap-2 min-w-0">
        {spinning ? (
          <Spinner />
        ) : (
          <span
            aria-hidden="true"
            className={`w-2 h-2 shrink-0 rounded-full ${failed ? "bg-danger" : card.kind === "uncertain" ? "bg-warn" : "bg-text-faint"}`}
          />
        )}
        <span className="text-text-muted shrink-0">
          {text}
          {card.kind === "uncertain" ? "" : agentLabel && spinning ? " ·" : ":"}
        </span>
        {card.kind !== "uncertain" && (
          <span className="font-mono text-accent-tx truncate min-w-0" title={card.name}>
            {card.name}
          </span>
        )}
        {card.kind === "settling" && !content && (
          <span className="text-text-faint truncate min-w-0">— the result arrives when this turn ends</span>
        )}
        {content?.chip && (
          <span
            className="shrink-0 font-mono tabular-nums text-text-muted"
            title={content.chipTitle}
            data-testid="background-steps"
          >
            {content.chip}
          </span>
        )}
        {content?.elapsed && (
          <span className="shrink-0 font-mono tabular-nums text-text-faint" data-testid="background-elapsed">
            {content.elapsed}
          </span>
        )}
        <span className="text-text-faint shrink-0">·</span>
        {questions > 0 && (
          <span className="shrink-0 whitespace-nowrap text-warn" data-testid="background-questions">
            · {questions} {questions === 1 ? "question" : "questions"}
          </span>
        )}
        {(view || agentTask) && (
          <button
            type="button"
            onClick={() => (agentTask && job ? openTaskPanel(job.parentSessionID, job.id) : setDetailsOpen((o) => !o))}
            // An agent task's details open in the chat's side panel, so there is no inline region to expand or control.
            {...(agentTask ? { title: "Open this task's details" } : { "aria-expanded": detailsOpen, "aria-controls": detailsOpen ? detailsId : undefined })}
            className="shrink-0 whitespace-nowrap text-text-muted hover:text-text hover:underline"
            data-testid="background-details-toggle"
          >
            Details
          </button>
        )}
        {card.kind !== "starting" && <OpenSessionButton onOpen={() => void open()} busy={busy} />}
      </div>
      {card.request && (
        <div className="mt-1 truncate text-text-muted" title={card.request} data-testid="background-request">
          {card.requestedBy === "manta" ? `${leadDisplayName(packageAgents)} asked: ${card.request}` : `“${card.request}”`}
        </div>
      )}
      {modelLabel && (
        <div className="mt-1 truncate text-text-faint" data-testid="background-model">
          Model · {modelLabel}
        </div>
      )}
      {seatAdded && seatSlug && (
        <div className="mt-1 truncate text-text-faint" data-testid="background-seat-added">
          Added @{seatSlug} to {seatAdded.projectName}
        </div>
      )}
      {content && (
        <>
          <div
            className={
              "mt-1 truncate " + (content.needsDecision ? "text-warn" : "text-text") + (headline ? "" : " invisible")
            }
            title={headline}
            data-testid="background-headline"
          >
            {headline || "\u00a0"}
          </div>
          <div
            className={"mt-1 h-0.5 overflow-hidden rounded-full bg-border" + (content.bar == null ? " invisible" : "")}
            {...(content.bar == null
              ? { "aria-hidden": true as const }
              : {
                  role: "progressbar",
                  "aria-label": "Plan progress",
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-valuenow": Math.round(content.bar * 100),
                })}
            data-testid="background-bar"
          >
            <div className="h-full bg-accent" style={{ width: `${Math.round((content.bar ?? 0) * 100)}%` }} />
          </div>
        </>
      )}
      {view && detailsOpen && !agentTask && <JobDetails id={detailsId} view={view} box={box} />}
      {card.kind === "failed" && (
        <div className="mt-1 text-danger break-words" data-testid="background-failure">
          {card.error}
        </div>
      )}
      {error && <ErrorLine message={error} />}
    </div>
  );
});

// The "Details" disclosure: checklist, milestones, live tool, quiet time, files, spend, time left. Every
// model-written string is a plain single line (jobProgress.plainLine) in a text node — never markup.
function JobDetails({ id, view, box }: { id: string; view: JobView; box: number }) {
  const m = detailsModel(view, box);
  const stats: Array<[string, string]> = [];
  if (m.tool) stats.push(["tool", `${m.tool.label} · running ${m.tool.age}`]);
  if (m.quiet) stats.push(["quiet", m.quiet]);
  if (m.files) stats.push(["files", m.files]);
  if (m.usage) stats.push(["usage", m.usage]);
  if (m.timeLeft) stats.push(["time-left", m.timeLeft]);
  return (
    <div id={id} className="mt-2 border-t border-border-subtle pt-2 space-y-2" data-testid="background-details">
      {m.planGrew && (
        <div className="text-warn" data-testid="background-plan-grew">
          Plan grew
        </div>
      )}
      {m.items.length > 0 && (
        <ul className="m-0 max-h-40 list-none space-y-1 overflow-y-auto p-0" data-testid="background-checklist">
          {m.items.map((i, n) => (
            <li
              key={n}
              data-status={i.status}
              className={"flex items-baseline gap-2 min-w-0 " + (i.status === "pending" ? "text-text-faint" : "text-text")}
            >
              <span aria-hidden="true" className="shrink-0 w-3 text-center">
                {i.mark}
              </span>
              <span className="sr-only">{i.status}: </span>
              <span className="truncate min-w-0" title={i.text}>
                {i.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {m.reportedLine && <div className="text-text-muted">{m.reportedLine}</div>}
      {m.milestones.length > 0 && (
        <div data-testid="background-milestones">
          <div className="text-text-faint">Milestones</div>
          <ul className="m-0 list-none space-y-1 p-0">
            {m.milestones.map((x, n) => (
              <li key={n} className="flex items-baseline gap-2 min-w-0">
                <span className="truncate min-w-0 text-text" title={x.text}>
                  {x.text}
                </span>
                <span className="shrink-0 text-text-faint">{x.ago}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stats.length > 0 && (
        <ul className="m-0 list-none space-y-1 p-0 text-text-muted">
          {stats.map(([k, v]) => (
            <li key={k} className="truncate" title={v} data-testid={`background-stat-${k}`}>
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The task side panel's "What happened" is this same disclosure, unchanged (agent screens spec §2.5).
export { JobDetails };

/** The cards under the transcript (N5). Rendered in the transcript tail. */
export const BackgroundRunCards = memo(function BackgroundRunCards({
  cards,
  openQuestionsByJob,
}: {
  cards: ReadonlyArray<BackgroundCard>;
  /** Open questions per task (root job id); defaults to what the chat provides. */
  openQuestionsByJob?: ReadonlyMap<string, number>;
}) {
  const provided = useContext(OpenQuestionsByJobContext);
  const counts = openQuestionsByJob ?? provided;
  return (
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }} data-testid="background-cards">
      {cards.map((c) => (
        <RunCard key={c.key} card={c} openQuestionsByJob={counts} />
      ))}
    </div>
  );
});

/** The finished card for a N4 `background-result` part. */
export const BackgroundResultCard = memo(function BackgroundResultCard({
  part,
}: {
  part: BackgroundResultPart;
}) {
  // Parts the box didn't stamp with a jobId (V2-native children, background
  // `task` subagents) are still tracked as job rows, keyed by their child id.
  const jobId = useStore((s) => part.jobId || s.jobs[part.childSessionId]?.id || null);
  // the result's own record of the model first (it stays in the transcript); the job store answers for an older result
  const ranOn = useStore((s) => (isAgentTask({ agent: part.agent }) ? (part.model ?? findJobById(s.jobs, jobId)?.modelUsed ?? null) : null));
  const modelLabel = useTaskModelLabel(ranOn);
  const { agents: packageAgents } = usePackageAgents();
  const agentTitle = packageAgentDisplayName(part.agent, packageAgents);
  const title = resultTitleFor(part, agentTitle);
  const { open, busy, error } = useOpenSession(jobId);
  const resultSession = typeof part.sessionID === "string" ? part.sessionID : "";
  const blocked = part.endedBlocked === true;
  const tone = resultTone(part.state, blocked);
  const text = (part.text ?? "").trim();
  const exceeded = describeExceededActions(part.exceededActions);
  const told = describeToldActions(part.toldActions);
  const blockedLine = describeBlockedActions(part.blockedActions);
  return (
    <div
      className="rounded-lg border border-border bg-bg-soft px-3 py-2"
      data-testid="background-result-card"
      data-state={part.state}
      data-blocked={blocked || undefined}
    >
      <div className="flex items-center gap-2 text-meta text-text-muted min-w-0">
        <span aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <b className="font-semibold text-text shrink-0">Background</b>
        <span className="font-mono text-accent-tx truncate min-w-0" title={title}>
          {title}
        </span>
        <span className={"shrink-0" + (blocked ? " text-warn" : "")} data-testid="background-result-state">
          · {resultStateLabel(part.state, blocked)}
        </span>
        {jobId && (
          <span className="ml-auto flex shrink-0 items-center gap-3">
            {/* An agent task's details live in the chat's side panel (agent screens §2.5) */}
            {resultSession && isAgentTask({ agent: part.agent }) && (
              <button
                type="button"
                onClick={() => openTaskPanel(resultSession, jobId)}
                className="shrink-0 whitespace-nowrap text-text-muted hover:text-text hover:underline"
                title="Open this task's details"
                data-testid="background-result-details"
              >
                Details
              </button>
            )}
            <OpenSessionButton onOpen={() => void open()} busy={busy} arrow />
          </span>
        )}
      </div>
      {modelLabel && (
        <div className="mt-1 truncate text-meta text-text-faint" data-testid="background-result-model">
          Model · {modelLabel}
        </div>
      )}
      {text && <ClampedResultText text={text} />}
      {exceeded && (
        <p className="m-0 mt-1 text-meta text-warn break-words" data-testid="background-result-exceeded">
          {exceeded}
        </p>
      )}
      {told && (
        <p className="m-0 mt-1 text-meta text-text-faint break-words" data-testid="background-result-told">
          {told}
        </p>
      )}
      {blockedLine && (
        <p className="m-0 mt-1 text-meta text-text-faint break-words" data-testid="background-result-blocked">
          {blockedLine}
        </p>
      )}
      {error && <ErrorLine message={error} />}
      {/* Phase 5A: what an Architect task proposed, as cards (by this job's id) */}
      {jobId && part.agent === ARCHITECT_AGENT_KEY && <ArchitectChanges jobId={jobId} />}
    </div>
  );
});

// A result can be a whole report: the card shows its first couple of lines and
// a Show more / Show less toggle (see ClampedMarkdown).
const ClampedResultText = ({ text }: { text: string }) => (
  <ClampedMarkdown text={text} bodyTestId="background-result-text" toggleTestId="background-result-toggle" />
);
