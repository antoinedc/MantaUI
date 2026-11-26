// ===== Needs you (agent screens spec §2.1) =====
//
// What waits for the user, box-wide: open questions from agent tasks, agent changes waiting for a click, and finished
// tasks that ended needing a decision, or that the user asked for and left a branch that has not landed. Each item is the EXISTING card it belongs to (QuestionCard,
// AgentChangeView, BackgroundResultCard) under one context line — the only new markup here. Every press ends visibly: a
// refusal is a role="alert" line in the item's context row, a success is the next read taking the card away (a change keeps
// its card, in its new state, for as long as the page is open, so "Applied" can be read).

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentChange, AgentInfo, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { AgentChangeView } from "../AgentChangeCard";
import { agentChangeTitle } from "../agentChange";
import { leadAgent, resolveTaskJob, taskQuestionRequest } from "../agentDispatch";
import { BackgroundResultCard } from "../BackgroundCards";
import { Button } from "../Button";
import { QuestionCard } from "../Cards";
import { AGE_TICK_MS, nowMs, useClockTick } from "../clock";
import { relativeAgo } from "../jobProgress";
import { useStore } from "../store";
import { errText, reviewPart } from "./agentsView";

type Project = { slug: string; name: string };

const CTX = "manta-agents-ny-ctx flex min-w-0 items-center gap-2 text-meta text-text-faint";

const badgeFor = (info: AgentInfo | undefined, name: string, slug: string) => ({ name: info?.name || name || slug, slug: slug || name, color: info?.color ?? null });

function Item({
  kind,
  context,
  error,
  children,
}: {
  kind: "question" | "change" | "review";
  context: ReactNode;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <li data-testid="needs-you-item" data-kind={kind} className="manta-agents-ny flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <div className={CTX}>{context}</div>
        {error && (
          <div role="alert" className="break-words text-meta text-danger" data-testid="needs-you-error">
            {error}
          </div>
        )}
      </div>
      {children}
    </li>
  );
}

const Who = ({ children }: { children: ReactNode }) => <span className="shrink-0 font-semibold text-text-muted">{children}</span>;
const Part = ({ children }: { children: ReactNode }) => <span className="truncate">· {children}</span>;

function QuestionItem({ q, info, projectName, onChanged }: { q: TaskQuestion; info: AgentInfo | undefined; projectName: string | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const request = useMemo(() => taskQuestionRequest(q), [q]);
  const working = useStore((s) => resolveTaskJob(s.jobs, q.rootJobId)?.status === "running");
  const ago = relativeAgo(nowMs() - q.askedAt);

  // The card is synchronous and has no busy state: ignore a second press while the first is out, and say what happened.
  const run = async (call: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errText(e));
    } finally {
      busy.current = false;
    }
    onChanged();
  };

  return (
    <Item
      kind="question"
      error={error ?? q.error}
      context={
        <>
          <AgentBadge size="sm" agent={badgeFor(info, q.agentName, q.agentSlug ?? "")} />
          <Who>{q.agentName || info?.name || "An agent"}</Who>
          {projectName && <Part>{projectName}</Part>}
          {q.taskName && <Part>{q.taskName}</Part>}
          <Part>asked {ago}</Part>
          {working && <span className="shrink-0">· still working on the rest</span>}
        </>
      }
    >
      <QuestionCard
        request={request}
        onReply={(answers) => void run(() => window.api.agentsQuestionAnswer({ id: q.id, answers }))}
        onReject={() => void run(() => window.api.agentsQuestionDismiss({ id: q.id }))}
      />
    </Item>
  );
}

function ChangeItem({ change, agents, onSettled }: { change: AgentChange; agents: ReadonlyArray<AgentInfo> | null; onSettled: (next: AgentChange) => void }) {
  const architect = agents?.find((a) => a.role === "architect");
  const lead = leadAgent(agents);
  const origin = change.origin.kind;
  const who =
    origin === "job"
      ? { name: "Architect", info: architect, slug: "architect" }
      : origin === "restore"
        ? { name: "You", info: undefined, slug: change.slug ?? "you" }
        : { name: lead?.name || "Manta", info: lead ?? undefined, slug: lead?.slug ?? "manta" };
  return (
    <Item
      kind="change"
      error={null}
      context={
        <>
          <AgentBadge size="sm" agent={badgeFor(who.info, who.name, who.slug)} />
          <Who>{who.name}</Who>
          <Part>{agentChangeTitle(change)}</Part>
          <Part>{relativeAgo(nowMs() - change.createdAt)}</Part>
        </>
      }
    >
      <AgentChangeView change={change} onChange={onSettled} />
    </Item>
  );
}

function ReviewItem({ review, info, projectName, onChanged }: { review: NeedsYouReview; info: AgentInfo | undefined; projectName: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const part = useMemo(() => reviewPart(review), [review]);
  const done = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.agentsReviewDone({ jobId: review.jobId });
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Item
      kind="review"
      error={error}
      context={
        <>
          <AgentBadge size="sm" agent={badgeFor(info, info?.name ?? "", review.agentSlug)} />
          <Who>{info?.name || review.agentSlug}</Who>
          {projectName && <Part>{projectName}</Part>}
          <Part>{review.name}</Part>
          <span className={`truncate ${review.endedBlocked ? "font-medium text-text" : ""}`}>· {review.reason}</span>
          <Part>{relativeAgo(nowMs() - review.finishedAt)}</Part>
          <span className="ml-auto shrink-0">
            <Button tone="ghost" onClick={() => void done()} loading={busy} title="Mark this as seen: it leaves Needs you">
              {busy ? "Marking done…" : "Done"}
            </Button>
          </span>
        </>
      }
    >
      <BackgroundResultCard part={part} />
    </Item>
  );
}

const newest = <T,>(list: ReadonlyArray<T>, at: (x: T) => number): T[] => [...list].sort((a, b) => at(b) - at(a));

export function NeedsYouList({
  data,
  agents,
  projects,
  onChanged,
}: {
  data: NeedsYou;
  agents: ReadonlyArray<AgentInfo> | null;
  projects: ReadonlyArray<Project>;
  onChanged: () => void;
}) {
  useClockTick(AGE_TICK_MS);
  const [settled, setSettled] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const projectName = (slug: string | null): string | null => (slug ? (projects.find((p) => p.slug === slug)?.name ?? slug) : null);
  const infoOf = (slug: string | null) => (slug ? agents?.find((a) => a.slug === slug) : undefined);

  const changes = useMemo(() => {
    const live = data.changes.map((c) => settled.get(c.id) ?? c);
    const gone = [...settled.values()].filter((s) => !data.changes.some((c) => c.id === s.id));
    return newest([...live, ...gone], (c) => c.createdAt);
  }, [data.changes, settled]);

  const settle = (next: AgentChange) => {
    setSettled((m) => new Map(m).set(next.id, next));
    onChanged();
  };

  const questions = newest(data.questions, (q) => q.askedAt);
  const reviews = newest(data.reviews, (r) => r.finishedAt);
  if (questions.length + changes.length + reviews.length === 0) {
    return (
      <p className="manta-agents-ny-empty m-0 text-label text-text-faint" data-testid="needs-you-empty">
        Nothing needs you.
      </p>
    );
  }
  return (
    <ul className="manta-agents-ny-list m-0 flex list-none flex-col gap-6 p-0" data-testid="needs-you-list">
      {questions.map((q) => (
        <QuestionItem key={q.id} q={q} info={infoOf(q.agentSlug)} projectName={projectName(q.project)} onChanged={onChanged} />
      ))}
      {changes.map((c) => (
        <ChangeItem key={c.id} change={c} agents={agents} onSettled={settle} />
      ))}
      {reviews.map((r) => (
        <ReviewItem key={r.jobId} review={r} info={infoOf(r.agentSlug)} projectName={projectName(r.project)} onChanged={onChanged} />
      ))}
    </ul>
  );
}
