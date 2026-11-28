// ===== Needs you (docs/superpowers/specs/2026-11-28-fleet-redesign.md, mockup v10) =====
//
// What waits for the user, box-wide, under project headings. Two kinds, told apart by an edge and a label on its own line:
//  - DECISIONS block something — "Waiting on you", solid red: an agent change waiting for a click, a task that ended needing a
//    decision. A change shows "Manta recommends …" with Apply / Discard; a finished task shows its result card and Done.
//  - OPEN QUESTIONS don't — "Open question · keeps working", blue: the task carries on, and if no one answers it goes with the
//    recommended option.
// A finished branch nobody merged is NOT an item (it is a sentence in Fleet's Ended today). Each item is the EXISTING card it
// belongs to (QuestionCard, AgentChangeView, BackgroundResultCard) under a title and who-line — the only new markup here.
// Every press ends visibly: a refusal is a role="alert" line in the item, a success is a status line that stays until the page is
// left (an applied change keeps its own card, in its new state, with the card's Undo).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, HelpCircle } from "lucide-react";
import type { AgentChange, AgentInfo, FleetTasks, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { AgentChangeView } from "../AgentChangeCard";
import { leadAgent, taskQuestionRequest } from "../agentDispatch";
import { BackgroundResultCard } from "../BackgroundCards";
import { QuestionCard } from "../Cards";
import { AGE_TICK_MS, nowMs, useClockTick } from "../clock";
import { relativeAgo } from "../jobProgress";
import { usePackageAgents } from "../packageAgents";
import { AgentsHeader } from "./AgentsParts";
import { ReadBannerView, Skeleton, useBoxOffline } from "./FleetPage";
import { errText, reviewPart } from "./agentsView";
import { changeRecommendation, changeTodo, decisionReviews, groupNeedsByProject, needsCounts, questionAssumption, readBanner, UNREACHABLE_TITLE, type NeedsUrgency } from "./fleetView";
import { useAfter, type AgentsRead } from "./useAgentsRead";
import { useOpenTask } from "./useOpenTask";

const SKELETON_DELAY_MS = 150;

type Base = { id: string; urgency: NeedsUrgency; project: string | null; at: number };
type Item =
  | (Base & { kind: "change"; change: AgentChange })
  | (Base & { kind: "review"; review: NeedsYouReview })
  | (Base & { kind: "question"; q: TaskQuestion })
  | (Base & { kind: "done"; text: string; was: "change" | "review" | "question" });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stripRecommended = (label: string) => label.replace(/\s*\(Recommended\)\s*$/i, "");

const badgeFor = (info: AgentInfo | undefined, name: string, slug: string) => ({ name: info?.name || name || slug, slug: slug || name, color: info?.color ?? null });

const OpenSession = ({ jobId, label, busy, offline, onOpen }: { jobId: string; label: string; busy: boolean; offline: boolean; onOpen: (jobId: string) => void }) => (
  <button
    type="button"
    onClick={() => onOpen(jobId)}
    disabled={offline || busy}
    title={offline ? UNREACHABLE_TITLE : undefined}
    aria-label={`Open session: ${label}`}
    className="inline-flex min-h-7 items-center whitespace-nowrap rounded-sm border-0 bg-transparent px-2 text-label font-medium text-accent-tx hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
  >
    {busy ? "Opening…" : "Open session"}
  </button>
);

/** One item: the label on its own line (with its age), the title, who, an optional sentence, then the card. */
function ItemShell({ item, agentBadge, agentName, aside, title, titleId, lead, children, error }: { item: Base & { kind: string }; agentBadge: ReactNode; agentName: string; aside?: string | null; title: string; titleId: string; lead?: string | null; children: ReactNode; error: string | null }) {
  const decision = item.urgency === "decision";
  return (
    <li
      data-testid="needs-you-item"
      data-kind={item.kind}
      data-urgency={item.urgency}
      className={`flex flex-col border-l-[length:var(--need-edge-w)] pl-4 ${decision ? "border-l-danger" : "border-l-accent"}`}
    >
      <div className="flex min-h-6 items-center gap-2">
        <span
          data-testid="needs-you-label"
          className={`inline-flex items-center gap-[6px] whitespace-nowrap rounded-xs px-2 py-[2px] text-meta font-semibold ${decision ? "bg-danger text-bg" : "bg-accent-bg text-accent-tx"}`}
        >
          {decision ? <AlertCircle size={13} aria-hidden="true" /> : <HelpCircle size={13} aria-hidden="true" />}
          {decision ? "Waiting on you" : "Open question · keeps working"}
        </span>
        <span className="ml-auto whitespace-nowrap text-meta text-text-muted">{relativeAgo(nowMs() - item.at)}</span>
      </div>
      <h3 id={titleId} className="m-0 mt-2 break-words text-prose font-semibold leading-snug tracking-[-0.005em] text-text">
        {title}
      </h3>
      <div className="mt-1 flex flex-wrap items-center gap-x-[6px] gap-y-1 text-meta text-text-muted">
        {agentBadge}
        <b className="font-semibold text-text">{agentName}</b>
        {aside && <span>{aside}</span>}
      </div>
      {lead && <p className="m-0 mb-3 mt-2 break-words text-body leading-normal text-text-muted">{lead}</p>}
      {error && (
        <div role="alert" data-testid="needs-you-error" className="mt-2 break-words text-meta text-danger">
          {error}
        </div>
      )}
      <div className="mt-3">{children}</div>
    </li>
  );
}

const DoneRow = ({ text }: { text: string }) => (
  <li data-testid="needs-you-done" role="status" className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] rounded-md border border-border-subtle bg-fill px-3 py-[10px] text-label leading-snug">
    <span aria-hidden="true" className="text-ok">
      ✓
    </span>
    <span className="min-w-[12rem] flex-1 break-words">{text}</span>
  </li>
);

function QuestionItem({ item, info, offline, busyOpen, onOpen, onDone, onChanged }: { item: Base & { kind: "question"; q: TaskQuestion }; info: AgentInfo | undefined; offline: boolean; busyOpen: boolean; onOpen: (jobId: string) => void; onDone: (item: Item) => void; onChanged: () => void }) {
  const q = item.q;
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const request = useMemo(() => taskQuestionRequest(q), [q]);
  const name = q.agentName || info?.name || "The agent";
  const note = questionAssumption(q, name);

  // the card is synchronous and has no busy state: ignore a second press while the first is out, and say what happened
  const run = async (call: () => Promise<unknown>, doneText: string) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errText(e));
      busy.current = false;
      return;
    }
    busy.current = false;
    onDone({ id: item.id, urgency: item.urgency, project: item.project, at: item.at, kind: "done", was: "question", text: doneText });
    onChanged();
  };

  return (
    <ItemShell
      item={item}
      title={q.questions[0]?.question || "A question for you"}
      titleId={`todo-${q.id}`}
      agentBadge={<AgentBadge size="sm" agent={badgeFor(info, q.agentName, q.agentSlug ?? "")} />}
      agentName={name}
      aside={q.taskName ? `on “${q.taskName}”` : null}
      error={error ?? q.error}
    >
      <fieldset disabled={offline} title={offline ? UNREACHABLE_TITLE : undefined} className="m-0 min-w-0 border-0 p-0">
        <QuestionCard
          request={request}
          failed={!!(error ?? q.error)}
          note={note ? <p className="m-0 mt-[10px] text-label leading-snug text-text-muted">{note}</p> : undefined}
          onReply={(answers) => {
            const chosen = answers.flat().map(stripRecommended).filter(Boolean).join(", ");
            void run(() => window.api.agentsQuestionAnswer({ id: q.id, answers }), `Answer sent to ${name}${chosen ? `: “${chosen}”` : ""}.`);
          }}
          onReject={() => void run(() => window.api.agentsQuestionDismiss({ id: q.id }), `Dismissed the question from ${name}.`)}
        />
      </fieldset>
      <div className="mt-1 flex justify-end">
        <OpenSession jobId={q.jobId} label={q.taskName || q.questions[0]?.question || "task"} busy={busyOpen} offline={offline} onOpen={onOpen} />
      </div>
    </ItemShell>
  );
}

function ChangeItem({ item, agents, offline, busyOpen, onOpen, onSettled }: { item: Base & { kind: "change"; change: AgentChange }; agents: ReadonlyArray<AgentInfo> | null; offline: boolean; busyOpen: boolean; onOpen: (jobId: string) => void; onSettled: (next: AgentChange) => void }) {
  const change = item.change;
  const architect = agents?.find((a) => a.role === "architect");
  const lead = leadAgent(agents);
  const origin = change.origin.kind;
  const who =
    origin === "job"
      ? { name: "Architect", info: architect, slug: "architect" }
      : origin === "restore" || origin === "settings"
        ? { name: "You", info: undefined, slug: change.slug ?? "you" }
        : { name: lead?.name || "Manta", info: lead ?? undefined, slug: lead?.slug ?? "manta" };
  const pending = change.state === "pending";
  const jobId = change.origin.kind === "job" ? change.origin.jobId : null;
  return (
    <ItemShell item={item} title={changeTodo(change)} titleId={`todo-${change.id}`} agentBadge={<AgentBadge size="sm" agent={badgeFor(who.info, who.name, who.slug)} />} agentName={who.name} error={null}>
      <fieldset disabled={offline} title={offline ? UNREACHABLE_TITLE : undefined} className="m-0 min-w-0 border-0 p-0">
        <AgentChangeView change={change} onChange={onSettled} note={pending ? <p className="m-0 text-label leading-snug text-text-muted">{changeRecommendation(change)}</p> : undefined} />
      </fieldset>
      {jobId && (
        <div className="mt-1 flex justify-end">
          <OpenSession jobId={jobId} label={changeTodo(change)} busy={busyOpen} offline={offline} onOpen={onOpen} />
        </div>
      )}
    </ItemShell>
  );
}

function ReviewItem({ item, info, offline, onDone, onChanged }: { item: Base & { kind: "review"; review: NeedsYouReview }; info: AgentInfo | undefined; offline: boolean; onDone: (item: Item) => void; onChanged: () => void }) {
  const review = item.review;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const part = useMemo(() => reviewPart(review), [review]);
  const done = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.agentsReviewDone({ jobId: review.jobId });
    } catch (e) {
      setError(errText(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    onDone({ id: item.id, urgency: item.urgency, project: item.project, at: item.at, kind: "done", was: "review", text: `Marked as done: ${review.name}.` });
    onChanged();
  };
  const name = info?.name || review.agentSlug;
  return (
    <ItemShell
      item={item}
      title={`${review.name} needs your decision`}
      titleId={`todo-${review.jobId}`}
      agentBadge={<AgentBadge size="sm" agent={badgeFor(info, name, review.agentSlug)} />}
      agentName={name}
      error={error}
    >
      <fieldset disabled={offline} title={offline ? UNREACHABLE_TITLE : undefined} className="m-0 min-w-0 border-0 p-0">
        <BackgroundResultCard part={part} />
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => void done()}
            disabled={busy}
            title="Mark this as seen: it leaves Needs you"
            className="inline-flex min-h-7 items-center rounded-sm border-0 bg-transparent px-2 text-label font-medium text-text-muted hover:bg-fill-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {busy ? "Marking done…" : "Done"}
          </button>
        </div>
      </fieldset>
    </ItemShell>
  );
}

export function NeedsYouPage({ needs, tasks, onOpenFleet }: { needs: AgentsRead<NeedsYou>; tasks: AgentsRead<FleetTasks>; onOpenFleet: () => void }) {
  useClockTick(AGE_TICK_MS);
  const { agents } = usePackageAgents();
  const offline = useBoxOffline();
  const slow = useAfter(needs.loading, SKELETON_DELAY_MS);
  const { open: openSession, busyId, error: openError } = useOpenTask();
  const [projects, setProjects] = useState<ReadonlyArray<{ slug: string; name: string }>>([]);
  const [settled, setSettled] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const [dealt, setDealt] = useState<ReadonlyMap<string, Item>>(new Map());

  useEffect(() => {
    let alive = true;
    Promise.resolve(window.api.agentsProjects?.())
      .then((list) => {
        if (alive && Array.isArray(list)) setProjects(list);
      })
      .catch((e: unknown) => console.warn("[agents] couldn't read the project names:", e));
    return () => {
      alive = false;
    };
  }, []);

  const data = needs.data;
  const infoOf = (slug: string | null) => (slug ? agents?.find((a) => a.slug === slug) : undefined);
  const projectName = (slug: string | null) => (slug ? (projects.find((p) => p.slug === slug)?.name ?? slug) : "No project");

  const items = useMemo(() => {
    if (!data) return [] as Item[];
    const list: Item[] = [];
    const live = new Set<string>();
    for (const c0 of data.changes) {
      const c = settled.get(c0.id) ?? c0;
      live.add(c.id);
      list.push({ id: c.id, kind: "change", urgency: "decision", project: data.changeProjects?.[c.id] ?? null, at: c.createdAt, change: c });
    }
    // a change the user dealt with stays, in its new state, after the next read stops listing it
    for (const s of settled.values()) if (!live.has(s.id)) list.push({ id: s.id, kind: "change", urgency: "decision", project: data.changeProjects?.[s.id] ?? null, at: s.createdAt, change: s });
    for (const r of decisionReviews(data)) list.push({ id: r.jobId, kind: "review", urgency: "decision", project: r.project, at: r.finishedAt, review: r });
    for (const q of data.questions) list.push({ id: q.id, kind: "question", urgency: "question", project: q.project, at: q.askedAt, q });
    const out = list.map((i) => dealt.get(i.id) ?? i);
    for (const d of dealt.values()) if (!out.some((i) => i.id === d.id)) out.push(d);
    return out.sort((a, b) => a.at - b.at); // longest waiting first
  }, [data, settled, dealt]);

  const groups = groupNeedsByProject(items, projectName).map((g) => ({ ...g, label: g.key === "" && g.items.every((i) => i.kind === "change" || (i.kind === "done" && i.was === "change")) ? "Team" : g.label }));
  const counts = needsCounts(data);
  const headerCounts = [counts.decisions ? plural(counts.decisions, "decision", "decisions") : "", counts.questions ? plural(counts.questions, "optional question", "optional questions") : ""].filter(Boolean).join(" · ");

  const settle = (next: AgentChange) => {
    setSettled((m) => new Map(m).set(next.id, next));
    void needs.reload();
  };
  const deal = (d: Item) => setDealt((m) => new Map(m).set(d.id, d));

  const banner = readBanner({ connected: !offline, hasData: !!data, error: needs.error, refreshError: needs.refreshError, updatedAt: needs.updatedAt }, "Needs you");
  const endedToday = tasks.data?.ended.length ?? 0;
  const endedNote =
    endedToday > 0 ? (
      <p data-testid="needs-you-ended-note" className="m-0 mt-10 border-t border-border-subtle pt-4 text-label leading-normal text-text-muted">
        {plural(endedToday, "task", "tasks")} ended today.{" "}
        <button type="button" onClick={onOpenFleet} className="rounded-xs border-0 bg-transparent p-0 text-label text-text underline decoration-border-strong underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-accent">
          See them in Fleet
        </button>
      </p>
    ) : null;

  const render = (i: Item) => {
    if (i.kind === "done") return <DoneRow key={i.id} text={i.text} />;
    if (i.kind === "change") return <ChangeItem key={i.id} item={i} agents={agents} offline={offline} busyOpen={i.change.origin.kind === "job" && busyId === i.change.origin.jobId} onOpen={(id) => void openSession(id)} onSettled={settle} />;
    if (i.kind === "review") return <ReviewItem key={i.id} item={i} info={infoOf(i.review.agentSlug)} offline={offline} onDone={deal} onChanged={() => void needs.reload()} />;
    return <QuestionItem key={i.id} item={i} info={infoOf(i.q.agentSlug)} offline={offline} busyOpen={busyId === i.q.jobId} onOpen={(id) => void openSession(id)} onDone={deal} onChanged={() => void needs.reload()} />;
  };

  return (
    <div className="manta-agents-pane manta-agents-needs flex h-full w-full flex-col bg-bg" data-screen="agents-needs">
      <AgentsHeader
        right={
          headerCounts ? (
            <span className="whitespace-nowrap text-meta text-text-muted" data-testid="needs-header-counts">
              {headerCounts}
            </span>
          ) : undefined
        }
      >
        <h1 className="m-0 text-label font-medium text-text">Needs you</h1>
      </AgentsHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-4 pb-10 pt-6 [@container(min-width:640px)]:px-6">
          {banner && <ReadBannerView banner={banner} testId="needs-banner" onAction={() => void needs.reload()} />}
          {needs.loading ? (
            slow ? (
              <Skeleton testId="needs-skeleton" groups={1} />
            ) : null
          ) : needs.unsupported ? (
            <p className="m-0 text-label text-text-faint" data-testid="needs-unsupported">
              Update the box to see what needs you.
            </p>
          ) : data ? (
            <>
              {openError && (
                <p role="alert" data-testid="needs-you-open-error" className="m-0 mb-3 break-words text-meta text-danger">
                  {openError}
                </p>
              )}
              {items.length === 0 ? (
                <div data-testid="needs-you-empty" className="max-w-[540px] pb-2 pt-4">
                  <h2 className="m-0 mb-1 text-body font-semibold tracking-[-0.01em] text-text">Nothing needs you</h2>
                  <p className="m-0 mb-[14px] text-body leading-normal text-text-muted">Manta and your agents are handling the rest. Anything only you can decide shows up here.</p>
                  <button
                    type="button"
                    onClick={onOpenFleet}
                    className="inline-flex h-[30px] items-center rounded-sm border border-border bg-bg-soft px-3 text-label font-medium text-text shadow-sm hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Open Fleet
                  </button>
                </div>
              ) : (
                groups.map((g) => (
                  <section key={g.key} aria-labelledby={`needs-p-${g.key || "none"}`} data-testid="needs-you-project" className="[&+&]:mt-10">
                    <h2 id={`needs-p-${g.key || "none"}`} className="m-0 mb-4 break-words text-body font-semibold tracking-[-0.01em] text-text [overflow-wrap:anywhere]">
                      {g.label}
                    </h2>
                    <ul className="m-0 flex list-none flex-col gap-8 p-0">{g.items.map(render)}</ul>
                  </section>
                ))
              )}
              {(settled.size > 0 || dealt.size > 0) && (
                <p className="m-0 mt-8 text-meta leading-normal text-text-muted">Items you’ve dealt with stay here until you leave this page. They are also in each agent’s history.</p>
              )}
              {endedNote}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
