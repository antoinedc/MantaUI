// ===== The cards of a task an agent started from its OWN conversation =====
//
// Spec docs/superpowers/specs/2026-11-28-agent-chat-tasks.md §7; design docs/screens/agents/chat-tasks.html + chat-tasks-decisions.md §1.
// ONE card family on the existing cards: the running card (`RunCard`) and the finished card (`BackgroundResultCard`) hand their job
// over here when it started from an agent's conversation; the `agent_start_task` tool part is the "starting" card (while the call
// runs) or a quiet "Not started" row (when it was refused). The words come from chatTask.ts (Fleet's words, never the slug).
//
// Markup: a content card — the title is a heading, the project a plain-text chip, Details and Open session are separate native
// buttons named after their task (one conversation holds several cards). Below 520 px the title wraps and the buttons move to
// the card's last row (a container query on the card's own column).

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import type { DelegateJob, OpencodePart } from "../shared/types";
import { openTaskPanel } from "./explorer/explorerStore";
import { ClampedMarkdown } from "./ClampedMarkdown";
import { agentSlugOf } from "./agentDispatch";
import {
  chatTaskStatus,
  cleanResultText,
  friendlyRefusal,
  modelLine,
  projectWords,
  refusalOf,
  startInputOf,
  taskBranchLine,
  type ChatTaskStatus,
  type ChatTaskTone,
} from "./chatTask";
import type { BackgroundCard, BackgroundResultPart } from "./backgroundRun";
import type { RunCardView } from "./jobProgress";

/** Is a delegate approval card waiting in this conversation? (ChatPanel provides it; the "starting" card then says so.) */
export const PendingApprovalContext = createContext<boolean>(false);

const DOT: Record<ChatTaskTone, string> = { run: "bg-accent", ok: "bg-ok", bad: "bg-danger", warn: "bg-warn", "": "bg-text-faint" };
const STAT: Record<ChatTaskTone, string> = { run: "text-text-muted", ok: "text-ok", bad: "text-danger", warn: "text-warn", "": "text-text-muted" };
const WIDE = "[@container(min-width:520px)]";

function Lead({ tone, spinning }: { tone: ChatTaskTone; spinning: boolean }) {
  return spinning ? (
    <span
      aria-hidden="true"
      data-testid="chat-task-spinner"
      className="col-start-1 mt-1 h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-accent/35 border-t-accent-tx motion-reduce:animate-none"
    />
  ) : (
    <span aria-hidden="true" className={`col-start-1 mt-2 h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
  );
}

type CardProps = {
  kind: "starting" | "running" | "uncertain" | "failed" | "settling" | "ended";
  title: string;
  project: string | null;
  status: ChatTaskStatus;
  spinning?: boolean;
  steps?: string | null;
  questions?: number;
  branch?: { kind: "branch" | "read-only"; text: string } | null;
  model?: string | null;
  headline?: string;
  headlineWarn?: boolean;
  bar?: number | null;
  seat?: string | null;
  failure?: string | null;
  /** The task's own buttons; absent while it is still starting (nothing to open yet). */
  onDetails?: () => void;
  onOpen?: () => void;
  openBusy?: boolean;
  openArrow?: boolean;
  openError?: string | null;
  jobId?: string;
  children?: ReactNode;
};

function ChatTaskCard(p: CardProps) {
  const id = useId();
  const meta: ReactNode[] = [];
  if (p.project) meta.push(<span key="p" data-testid="chat-task-project" className="inline-flex max-w-full items-center truncate rounded-full bg-fill-active px-2 font-medium text-text-muted">{p.project}</span>);
  meta.push(
    <span key="s" data-testid="chat-task-status" className={STAT[p.status.tone]}>
      {p.status.label}
    </span>,
  );
  if (p.steps) meta.push(<span key="n" data-testid="chat-task-steps" className="font-mono tabular-nums text-text-faint" title="Steps done of the plan · time so far">{p.steps}</span>);
  if (p.questions && p.questions > 0) {
    meta.push(
      <span key="q" data-testid="chat-task-questions" className="font-medium text-warn">
        {p.questions} {p.questions === 1 ? "question" : "questions"}
      </span>,
    );
  }
  if (p.branch) {
    meta.push(
      <span key="b" data-testid="chat-task-branch" className={`min-w-0 break-all ${p.branch.kind === "branch" ? "font-mono" : ""}`} title={p.branch.kind === "branch" ? "The branch this task works on" : "This task only reads: it won't change any files"}>
        {p.branch.text}
      </span>,
    );
  }
  if (p.model) meta.push(<span key="m" data-testid="chat-task-model" title="The model this task runs on">{p.model}</span>);
  const live = p.kind !== "ended";
  return (
    <div className="[container-type:inline-size]">
      <article
        aria-labelledby={id}
        data-testid="chat-task-card"
        data-kind={p.kind}
        data-job-id={p.jobId || undefined}
        className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border bg-bg-soft px-3 py-2 text-meta ${WIDE}:grid-cols-[auto_minmax(0,1fr)_auto] ${p.kind === "uncertain" || p.kind === "failed" ? "border-danger/40" : live ? "border-accent/35" : "border-border-subtle"}`}
      >
        <Lead tone={p.status.tone} spinning={!!p.spinning} />
        <h4 id={id} title={p.title} className={`m-0 col-start-2 min-w-0 break-words text-label font-semibold leading-snug text-text ${WIDE}:truncate`}>
          {p.title}
        </h4>
        {(p.onDetails || p.onOpen) && (
          <div className={`col-start-2 mt-1 flex items-center gap-1 [grid-row:20] ${WIDE}:col-start-3 ${WIDE}:mt-0 ${WIDE}:[grid-row:1]`}>
            {p.onDetails && (
              <button type="button" onClick={p.onDetails} aria-label={`Details: ${p.title}`} title="Open this task's details" data-testid="chat-task-details" className="inline-flex min-h-6 items-center whitespace-nowrap rounded-xs border-0 bg-transparent px-2 font-medium text-text-muted hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent">
                Details
              </button>
            )}
            {p.onOpen && (
              <button type="button" onClick={p.onOpen} disabled={p.openBusy} aria-label={`Open session: ${p.title}`} title="Open the background session" data-testid="background-open-session" className="inline-flex min-h-6 items-center whitespace-nowrap rounded-xs border-0 bg-transparent px-2 font-medium text-accent-tx hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
                {p.openBusy ? "Opening…" : p.openArrow ? "Open session →" : "Open session"}
              </button>
            )}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-faint [grid-column:2/-1]">
          {meta.map((m, i) => (
            <span key={i} className="contents">
              {i > 0 && (
                <span aria-hidden="true" className="text-text-faint">
                  ·
                </span>
              )}
              {m}
            </span>
          ))}
        </div>
        {p.headline != null && p.headline !== "" && (
          <div data-testid="chat-task-headline" title={p.headline} className={`mt-2 truncate [grid-column:2/-1] ${p.headlineWarn ? "text-warn" : "text-text"}`}>
            {p.headline}
          </div>
        )}
        {p.bar != null && (
          <div role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.bar * 100)} data-testid="chat-task-bar" className="mt-2 h-0.5 overflow-hidden rounded-full bg-border [grid-column:2/-1]">
            <div className="h-full bg-accent" style={{ width: `${Math.round(p.bar * 100)}%` }} />
          </div>
        )}
        {p.seat && (
          <div data-testid="chat-task-seat" className="mt-2 truncate text-text-faint [grid-column:2/-1]">
            {p.seat}
          </div>
        )}
        {p.failure && (
          <div data-testid="background-failure" className="mt-2 break-words text-danger [grid-column:2/-1]">
            {p.failure}
          </div>
        )}
        {p.children && <div className="mt-2 [grid-column:2/-1]">{p.children}</div>}
        {p.openError && (
          <div role="alert" data-testid="background-open-error" className="mt-1 break-words text-danger [grid-column:2/-1]">
            {p.openError}
          </div>
        )}
      </article>
    </div>
  );
}

const seatLine = (job: Pick<DelegateJob, "seatAdded" | "agent">): string | null => {
  const slug = agentSlugOf(job.agent);
  return job.seatAdded && slug ? `Added @${slug} to ${job.seatAdded.projectName}` : null;
};

/** The running / uncertain / failed / settling card of a chat task (RunCard hands its job over). */
export function ChatTaskRunCard({
  card,
  job,
  content,
  headline,
  questions,
  open,
  busy,
  error,
}: {
  card: BackgroundCard;
  job: DelegateJob;
  content: RunCardView | null;
  headline: string;
  questions: number;
  open: () => void;
  busy: boolean;
  error: string | null;
}) {
  const status = chatTaskStatus(card.kind === "running" ? { kind: "running", paused: card.paused } : { kind: card.kind });
  const title = job.title?.trim() || card.name;
  const failed = card.kind === "failed";
  return (
    <ChatTaskCard
      kind={card.kind}
      jobId={job.id}
      title={title}
      project={job.project?.name ?? null}
      status={status}
      spinning={card.kind === "running" && !card.paused}
      steps={content ? [content.chip, content.elapsed].filter(Boolean).join(" · ") || null : null}
      questions={questions}
      branch={card.kind === "uncertain" || failed ? null : taskBranchLine(job)}
      model={modelLine(job)}
      headline={content ? headline : ""}
      headlineWarn={content?.needsDecision}
      bar={content?.bar ?? null}
      seat={seatLine(job)}
      failure={failed ? card.error : null}
      onDetails={failed ? undefined : () => openTaskPanel(job.parentSessionID, job.id)}
      onOpen={failed ? undefined : open}
      openBusy={busy}
      openError={error}
    />
  );
}

/** The finished card of a chat task: the same head, the result below it (without the header lines the server writes). */
export function ChatTaskResultCard({
  part,
  job,
  title,
  open,
  busy,
  error,
}: {
  part: BackgroundResultPart;
  job: DelegateJob | null;
  title: string;
  open: () => void;
  busy: boolean;
  error: string | null;
}) {
  const sessionId = typeof part.sessionID === "string" ? part.sessionID : (job?.parentSessionID ?? "");
  const jobId = part.jobId || job?.id || "";
  const status = chatTaskStatus({ kind: "ended", job: job ?? undefined, state: part.state, endedBlocked: part.endedBlocked === true });
  const text = cleanResultText(part.text).trim();
  const branch = taskBranchLine({ branch: job?.branch ?? part.branch ?? null, isolation: job?.isolation ?? part.isolation });
  return (
    <ChatTaskCard
      kind="ended"
      jobId={jobId}
      title={title}
      project={job?.project?.name ?? part.project?.name ?? null}
      status={status}
      branch={branch}
      model={modelLine(job)}
      seat={job ? seatLine(job) : null}
      onDetails={jobId && sessionId ? () => openTaskPanel(sessionId, jobId) : undefined}
      onOpen={jobId ? open : undefined}
      openArrow
      openBusy={busy}
      openError={error}
    >
      {text && <ClampedMarkdown text={text} bodyTestId="background-result-text" toggleTestId="background-result-toggle" />}
    </ChatTaskCard>
  );
}

// ---- the `agent_start_task` tool part ----

let projectNames: Promise<ReadonlyMap<string, string>> | null = null;
/** The registry's project names by id (read once; the box may not have it, then ids are read as words). */
function loadProjectNames(): Promise<ReadonlyMap<string, string>> {
  projectNames ??= Promise.resolve(window.api.agentsProjects?.())
    .then((list) => new Map((Array.isArray(list) ? list : []).map((p) => [p.slug, p.name] as const)))
    .catch(() => new Map<string, string>());
  return projectNames;
}
/** Forget the read names (a test, or a project the box just registered). */
export const resetProjectNamesForTest = (): void => {
  projectNames = null;
};

/** The project's display name for an id the agent named: the registry's, else the id's own words (never the id). */
function useProjectName(project: string): string | null {
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void loadProjectNames().then((m) => alive && setNames(m));
    return () => {
      alive = false;
    };
  }, []);
  return project ? (names?.get(project) ?? projectWords(project)) : null;
}

function StartingCard({ part }: { part: OpencodePart }) {
  const { title, project } = startInputOf(part);
  const waiting = useContext(PendingApprovalContext);
  const projectName = useProjectName(project);
  const status: ChatTaskStatus = waiting ? { label: "Waiting for your approval", tone: "run" } : chatTaskStatus({ kind: "starting" });
  return <ChatTaskCard kind="starting" title={title || "Starting a task"} project={projectName} status={status} spinning />;
}

function RefusedRow({ part, sentence }: { part: OpencodePart; sentence: string }) {
  const { title, project } = startInputOf(part);
  return (
    <div role="note" data-testid="chat-task-refused" title={sentence} className="flex items-start gap-2 py-1 text-meta leading-snug text-text-faint">
      <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-danger" />
      <div className="min-w-0">
        <b className="font-semibold text-text-muted">Not started</b>
        {title ? ` · ${title}` : ""}
        <div className="break-words text-text-muted">{friendlyRefusal(sentence, { project })}</div>
      </div>
    </div>
  );
}

/** What the `agent_start_task` tool part shows: the starting card while it runs, the refusal in plain words, nothing once it started a task (its card takes over). */
export function ChatTaskToolPart({ part }: { part: OpencodePart }) {
  const sentence = refusalOf(part);
  if (sentence != null) return <RefusedRow part={part} sentence={sentence} />;
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (status === "pending" || status === "running") return <StartingCard part={part} />;
  return null;
}
