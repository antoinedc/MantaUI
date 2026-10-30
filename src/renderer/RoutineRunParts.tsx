// ===== Routine run — pieces drawn inside the chat transcript (R3 / R5) =====
//
// A routine run is an ordinary ChatPanel; these are the only additions:
//   - `RoutineHeaderChrome`: the header's crumb, read-only/branch tag and the
//     "Keep in sidebar" button (SessionHeader's `routineChrome` slot)
//   - `RoutineRunBar`: the strip under the header (trigger · start · duration ·
//     tokens, prev / next run)
//   - `RoutinePromptBlock`: the routine's instructions as the first user turn
//   - `RoutineReportCard`: the closing report
//   - `RoutineToolCard`: a completed `routine_report` / `routine_create` /
//     `routine_update` tool call drawn as a card (R5)
// All of them read the run through `RoutineRunContext`, so nothing is threaded
// through the transcript's memo chain.

import { useContext, useEffect, useState } from "react";
import { Bell, CalendarClock, Clock, Eye, GitBranch, PanelLeftOpen, Play, X } from "lucide-react";
import { Button } from "./Button";
import { Eyebrow } from "./Eyebrow";
import { IconButton } from "./IconButton";
import { MarkdownBody } from "./MarkdownBody";
import { MessageBubble } from "./MessageBubble";
import { OutputWell } from "./OutputWell";
import { Tag } from "./Tag";
import { CrumbLink, CrumbSep, ShowMore } from "./RoutinesParts";
import { hasReportView, routinesToast, runAction } from "./routinesData";
import { RoutineRunContext, type RoutineRunBinding } from "./routineRunContext";
import { routineIdOfToolPart, routineToolKind } from "./routineToolParts";
import {
  cadenceText,
  clockHM,
  memoryLineCount,
  nextDayWord,
  routineIcon,
  runCrumbLabel,
  runDuration,
  splitInstructions,
  tellMeLabel,
  tildePath,
  triggerLabel,
} from "./routinesView";
import { formatTokenCount } from "../shared/formatTokens.mjs";
import { nowMs } from "./clock";
import { nextCronRun } from "./chatUtils";
import type { Routine, RoutineRun } from "../shared/routines";


/** The SessionHeader slots of a routine run: crumb, tag, the Keep-in-sidebar button and Close (back to the list). */
export function routineHeaderChrome(b: RoutineRunBinding) {
  const when = runCrumbLabel(b.run.startedAt ?? b.run.queuedAt);
  return {
    crumb: (
      <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-label text-text-faint" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <CrumbLink onClick={b.onBack}>Routines</CrumbLink>
        <CrumbSep />
        <CrumbLink onClick={b.onOpenRoutine}>{b.routine.name}</CrumbLink>
        <CrumbSep />
        <span className="text-text">{when}</span>
      </span>
    ),
    tag:
      b.run.worktree ? (
        <Tag size="sm" icon={<GitBranch size={11} aria-hidden className="shrink-0" />}>
          {b.run.worktree.branch}
        </Tag>
      ) : (
        <Tag size="sm" icon={<Eye size={11} aria-hidden className="shrink-0" />}>
          read-only
        </Tag>
      ),
    lead: (
      <span className="flex items-center gap-2">
        <Button tone="default" onClick={b.onKeep}>
          <PanelLeftOpen size={14} aria-hidden />
          Keep in sidebar
        </Button>
        <IconButton label="Close run" title="Close and go back to Routines" size="xl" icon={<X />} onClick={b.onBack} />
      </span>
    ),
  };
}

export function RoutineRunBar({ binding }: { binding: RoutineRunBinding }) {
  const { run, routine, prevRunId, nextRunId, onNavigate } = binding;
  const started = run.startedAt;
  const dur = started != null && run.endedAt != null ? runDuration(run.endedAt - started) : null;
  const parts = [
    started != null ? `started ${clockHM(started)}` : "waiting in line",
    dur,
    run.tokens != null ? `${formatTokenCount(run.tokens)} tokens` : null,
  ].filter(Boolean);
  const neighbour = (id: string | null, dir: "prev" | "next") => {
    const label = dir === "prev" ? "‹ Previous" : "Next ›";
    return (
      <Button tone="ghost" disabled={!id} onClick={() => id && onNavigate(id)}>
        {label}
      </Button>
    );
  };
  void routine;
  return (
    <div className="manta-routines-runbar flex shrink-0 items-center gap-3 border-b border-border-subtle bg-bg-elev px-6 py-2 text-meta text-text-faint">
      <CalendarClock size={14} className="text-accent-tx" aria-hidden />
      <span>
        <b className="font-semibold text-text">{triggerLabel(run.trigger)}</b>
        {parts.map((p, i) => (
          <span key={i}>
            {" "}
            <span className="text-text-quiet">·</span> {p}
          </span>
        ))}
      </span>
      <span className="ml-auto flex gap-2">
        {neighbour(prevRunId, "prev")}
        {neighbour(nextRunId, "next")}
      </span>
    </div>
  );
}

/** The routine's instructions drawn as the transcript's first user turn, with the memory the run started from. */
export function RoutinePromptBlock() {
  const ctx = useContext(RoutineRunContext);
  const [memOpen, setMemOpen] = useState(false);
  if (!ctx) return null;
  const { routine, run } = ctx;
  const lines = memoryLineCount(run.memoryAtStart);
  return (
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
      <div className="flex items-center gap-2 text-meta font-medium text-text-faint">
        <Clock size={12} className="text-accent-tx" aria-hidden />
        {cadenceText(routine.cron, "at")}
        <span className="h-px flex-1 bg-border-subtle" />
      </div>
      <MessageBubble>
        <div className="-mb-2">
          <Eyebrow>
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={12} aria-hidden />
              Routine instructions
            </span>
          </Eyebrow>
        </div>
        <ShowMore lines={5}>
          {splitInstructions(routine.prompt).map((p, i) =>
            p.kind === "skill" ? (
              <span key={i} className="inline-flex rounded-full bg-accent-bg px-2 font-mono text-meta text-accent-tx">
                {p.text}
              </span>
            ) : (
              <span key={i}>{p.text}</span>
            ),
          )}
        </ShowMore>
      </MessageBubble>
      <div className="text-meta text-text-faint">
        {lines === 0 ? (
          "Started with no memory yet"
        ) : (
          <button type="button" className="hover:text-text" aria-expanded={memOpen} onClick={() => setMemOpen((v) => !v)}>
            Started with its memory · {lines} {lines === 1 ? "line" : "lines"} {memOpen ? "▾" : "▸"}
          </button>
        )}
        {memOpen && lines > 0 && (
          <div className="mt-2">
            <OutputWell variant="standalone">
              <ShowMore lines={6} className="whitespace-pre-wrap text-meta">
                {run.memoryAtStart}
              </ShowMore>
            </OutputWell>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Memory updated · +N lines ▸": what this run added to the routine's memory, collapsed until opened. */
function MemoryUpdatedLine({ added }: { added: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="manta-routines-memory-updated text-meta text-text-faint">
      <button type="button" className="hover:text-text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Memory updated · +{added.length} {added.length === 1 ? "line" : "lines"} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="mt-2">
          <OutputWell variant="standalone">
            <div className="whitespace-pre-wrap font-mono text-meta">
              {added.map((l, i) => (
                <span key={i}>
                  <span className="rounded-xs bg-[var(--diff-add)]">{l}</span>
                  {i < added.length - 1 ? "\n" : ""}
                </span>
              ))}
            </div>
          </OutputWell>
        </div>
      )}
    </div>
  );
}

function RoutineBadgeIcon({ icon }: { icon: string }) {
  const Icon = routineIcon(icon);
  return <Icon size={16} aria-hidden />;
}

function KindLabel({ outcome, failed }: { outcome: "findings" | "nothing"; failed: boolean }) {
  if (failed) return <div className="text-micro font-semibold uppercase tracking-wider text-danger">Failed</div>;
  return outcome === "findings" ? (
    <div className="text-micro font-semibold uppercase tracking-wider text-accent-tx">Findings</div>
  ) : (
    <div className="text-micro font-semibold uppercase tracking-wider text-text-faint">Nothing new</div>
  );
}

/**
 * A run's report, drawn whole: kind, title, summary, the full markdown body, and a
 * footer (notified line + actions). Shared by the transcript's pinned tail card and
 * the report-first modal (`RoutineReportModal`). `chrome={false}` drops the card's own
 * border/shadow/footer for a host that supplies them (the modal).
 */
export function ReportCard({
  run,
  routine,
  onFollowUp,
  chrome = true,
}: {
  run: RoutineRun;
  routine: Routine;
  onFollowUp?: () => void;
  chrome?: boolean;
}) {
  const failed = run.status === "failed" || run.status === "timed_out";
  const report = run.report;
  if (!report && !failed) return null;
  const title = report?.title ?? run.error ?? "The run did not finish";
  const summary = report?.summary?.trim() ?? "";
  const body = report?.body ?? "";
  const content = (
    <div className="flex items-start gap-3 px-4 pb-3 pt-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-bg text-accent-tx">
        <RoutineBadgeIcon icon={routine.icon} />
      </span>
      <div className="min-w-0 flex-1">
        <KindLabel outcome={report?.outcome ?? "findings"} failed={failed} />
        <div className="mt-1 text-prose font-semibold text-text">{title}</div>
        {summary !== "" && summary !== body.trim() && <div className="mt-2 text-body text-text-muted">{summary}</div>}
        {body.trim() !== "" && (
          <div className="mt-2 text-body text-text-muted">
            <MarkdownBody text={body} />
          </div>
        )}
      </div>
    </div>
  );
  if (!chrome) return content;
  return (
    <div className="manta-routines-report overflow-hidden rounded-lg border border-border bg-bg-soft shadow-md">
      {content}
      <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-elev px-4 py-2 text-meta text-text-faint">
        <NotifiedLine run={run} />
        {onFollowUp && (
          <span className="ml-auto">
            <Button tone="default" onClick={onFollowUp}>
              Follow up
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}

export function NotifiedLine({ run }: { run: RoutineRun }) {
  return (
    <>
      <Bell size={14} aria-hidden />
      {run.notifiedAt != null ? `Notified you at ${clockHM(run.notifiedAt)}` : "Filed quietly"}
    </>
  );
}

/**
 * The run's report pinned at the END of its transcript (R3) — the thing most people
 * open a run for, so it is always the last block, fully shown, whatever point of the
 * turn the agent filed it at (the inline `routine_report` call is only a pointer).
 */
export function RoutineReportCard() {
  const ctx = useContext(RoutineRunContext);
  if (!ctx) return null;
  const { run, routine, onFollowUp } = ctx;
  if (!hasReportView(run)) return null;
  const added = run.memoryDiff?.added ?? [];
  return (
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
      {added.length > 0 && <MemoryUpdatedLine added={added} />}
      <ReportCard run={run} routine={routine} onFollowUp={onFollowUp} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// R5 — a completed routine tool call drawn as a card
// ---------------------------------------------------------------------------

type ToolPart = { type?: string; tool?: unknown; state?: unknown };

/** A completed routine tool part as a card; null when the part is not a routine tool. */
export function RoutineToolCard({ part }: { part: ToolPart }) {
  const kind = routineToolKind(part);
  const ctx = useContext(RoutineRunContext);
  // In a run the report is pinned at the transcript's end; the call itself is just a pointer to it.
  if (kind === "report") return ctx ? <ReportFiledLine /> : <ReportToolFallback part={part} />;
  if (kind === "create" || kind === "update") return <RoutineCreatedCard part={part} kind={kind} />;
  return null;
}

function ReportFiledLine() {
  return <div className="text-meta text-text-faint">Filed its report — it's at the end of this run ↓</div>;
}

/** A `routine_report` outside a routine run (e.g. a previous-session view) still deserves a card. */
function ReportToolFallback({ part }: { part: ToolPart }) {
  const input = ((part.state ?? {}) as { input?: Record<string, unknown> }).input ?? {};
  const title = typeof input.title === "string" ? input.title : "Report filed";
  const body = typeof input.body === "string" ? input.body : "";
  const outcome = input.outcome === "nothing" ? "nothing" : "findings";
  return (
    <div className="manta-routines-report overflow-hidden rounded-lg border border-border bg-bg-soft shadow-md">
      <div className="px-4 pb-3 pt-4">
        <KindLabel outcome={outcome} failed={false} />
        <div className="mt-1 text-prose font-semibold text-text">{title}</div>
        {body.trim() !== "" && (
          <div className="mt-2 text-body text-text-muted">
            <MarkdownBody text={body} />
          </div>
        )}
      </div>
    </div>
  );
}

function RoutineCreatedCard({ part, kind }: { part: ToolPart; kind: "create" | "update" }) {
  const state = (part.state ?? {}) as { input?: Record<string, unknown> };
  const input = state.input ?? {};
  const id = routineIdOfToolPart(part);
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let live = true;
    window.api
      .routinesGet?.(id, {})
      .then((d) => live && d && setRoutine(d.routine))
      .catch(() => {
        /* the card falls back to the tool input */
      });
    return () => {
      live = false;
    };
  }, [id]);

  const str = (k: string): string | null => (typeof input[k] === "string" && input[k] ? (input[k] as string) : null);
  const name = routine?.name ?? str("name") ?? "Routine";
  const cron = routine?.cron ?? str("cron");
  const access = routine?.access ?? (str("access") === "edit" ? "edit" : "read");
  const notify = routine?.notify ?? ((str("notify") as Routine["notify"] | null) ?? "findings");
  const directory = routine?.directory ?? null;
  const memory = str("memory");
  const memLines = memory ? memoryLineCount(memory) : 0;
  const now = nowMs();
  const next = routine?.nextRunAt ?? (cron ? nextCronRun(cron, now) : null);
  const when = cron
    ? `${cadenceText(cron, "at")}${next != null ? ` · ${kind === "create" ? "first run" : "next run"} ${nextDayWord(next, now)}` : ""}`
    : "—";

  const open = () => {
    if (!id) {
      routinesToast("error", "Couldn't open the routine — its id wasn't in the tool result");
      return;
    }
    window.dispatchEvent(new CustomEvent("manta-open-routine", { detail: { id } }));
  };
  const runNow = async () => {
    if (!id) {
      routinesToast("error", "Couldn't start the run — the routine id wasn't in the tool result");
      return;
    }
    setBusy(true);
    const r = await runAction("start the run", () => window.api.routinesRunNow(id));
    setBusy(false);
    if (r) routinesToast("info", r.alreadyQueued ? `${name} is already waiting in line` : `${name} is queued`);
  };

  return (
    <div
      className="manta-routines-created-card overflow-hidden rounded-lg border border-border bg-bg-soft shadow-sm"
      style={{ maxWidth: "var(--inline-max-w)" }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-bg text-accent-tx">
          <CalendarClock size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-meta text-text-faint">{kind === "create" ? "Routine created" : "Routine updated"}</div>
          <div className="truncate text-body font-semibold text-text">{name}</div>
        </div>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 px-4 pb-3 text-label">
        <dt className="text-text-quiet">When</dt>
        <dd className="text-text-muted">{when}</dd>
        {directory && (
          <>
            <dt className="text-text-quiet">Folder</dt>
            <dd className="text-text-muted">
              {tildePath(directory)}
              {access === "read" ? " · read-only" : ""}
            </dd>
          </>
        )}
        <dt className="text-text-quiet">Tell you</dt>
        <dd className="text-text-muted">{tellMeLabel(notify)}</dd>
        {memLines > 0 && (
          <>
            <dt className="text-text-quiet">Starts knowing</dt>
            <dd className="text-text-muted">
              The baselines from this chat ({memLines} {memLines === 1 ? "line" : "lines"})
            </dd>
          </>
        )}
      </dl>
      <div className="flex gap-2 border-t border-border-subtle bg-bg-elev px-4 py-2">
        <Button tone="default" onClick={open}>
          Open routine
        </Button>
        <Button tone="ghost" loading={busy} onClick={() => void runNow()}>
          <Play size={14} aria-hidden />
          Run now
        </Button>
      </div>
    </div>
  );
}

