// ===== Routines page (R1) =====
//
// The page behind the single "Routines" sidebar row: what is blocked on the
// user, unread reports, the run queue and every routine. Follow-ups that run
// inside a chat are managed from that chat's ⏰ card, not here. Sections with
// nothing to show are omitted (except "Your routines", which shows its empty
// state). The summary comes from App's single subscription; this component only
// renders it and routes the user's gestures (open a routine / a run, answer, run).

import { useState } from "react";
import { CalendarClock, Check, CircleHelp, Plus, Shield } from "lucide-react";
import type { Routine, RoutineRun, RoutinesSummary } from "../shared/routines";
import { Button } from "./Button";
import { Card } from "./Card";
import { Eyebrow } from "./Eyebrow";
import { Pill } from "./Pill";
import { StatusDot } from "./StatusDot";
import { Toggle } from "./Toggle";
import {
  Box,
  OutcomePill,
  PageColumn,
  RoutineGlyph,
  RoutinesHeader,
  SectionHead,
  TextLink,
  useNowMs,
} from "./RoutinesParts";
import { routinesToast, runAction } from "./routinesData";
import {
  IN_A_CHAT,
  accessLine,
  agoText,
  cadenceText,
  clockHM,
  inboxTimeLabel,
  lastRunDetail,
  nextLabel,
  outcomeView,
  projectLabel,
  routineIcon,
  runElapsed,
} from "./routinesView";

const TABLE_GRID =
  "grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1.2fr)_96px_40px] items-center gap-3 px-4";
const FINDINGS_COLLAPSED = 5;

function onActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      fn();
    }
  };
}

export function RoutinesPane({
  summary,
  error,
  reload,
  onOpenRoutine,
  onOpenRun,
  onOpenTranscript,
  onNewRoutine,
}: {
  summary: RoutinesSummary | null;
  error: string | null;
  reload: () => Promise<void>;
  onOpenRoutine: (id: string) => void;
  /** An unread run: opens in its routine's page with the run selected. */
  onOpenRun: (runId: string, run: RoutineRun) => void;
  /** Straight to a run's transcript (Answer on a run that needs you). */
  onOpenTranscript: (runId: string) => void;
  onNewRoutine: () => void;
}) {
  const now = useNowMs();
  const [showAllFindings, setShowAllFindings] = useState(false);

  return (
    <div
      className="manta-routines-pane flex h-full w-full flex-col bg-bg"
      data-screen="routines"
    >
      <RoutinesHeader>Routines</RoutinesHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageColumn>
          <div className="flex items-end gap-4">
            <div>
              <h1 className="text-display font-semibold text-text">Routines</h1>
              <p className="mt-1 text-body text-text-faint">
                Recurring work that starts a fresh session each time it runs. Results land here and stay out of the sidebar.
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button tone="primary" onClick={onNewRoutine}>
                <Plus size={14} aria-hidden />
                New routine
              </Button>
            </div>
          </div>

          {!summary ? (
            <div className="mt-8 text-body text-text-faint">
              {error ? `Couldn't load routines — ${error}` : "Loading routines…"}
            </div>
          ) : (
            <PaneSections
              summary={summary}
              now={now}
              showAllFindings={showAllFindings}
              setShowAllFindings={setShowAllFindings}
              reload={reload}
              onOpenRoutine={onOpenRoutine}
              onOpenRun={onOpenRun}
              onOpenTranscript={onOpenTranscript}
              onNewRoutine={onNewRoutine}
            />
          )}
        </PageColumn>
      </div>
    </div>
  );
}

function PaneSections({
  summary,
  now,
  showAllFindings,
  setShowAllFindings,
  reload,
  onOpenRoutine,
  onOpenRun,
  onOpenTranscript,
  onNewRoutine,
}: {
  summary: RoutinesSummary;
  now: number;
  showAllFindings: boolean;
  setShowAllFindings: (v: boolean) => void;
  reload: () => Promise<void>;
  onOpenRoutine: (id: string) => void;
  onOpenRun: (runId: string, run: RoutineRun) => void;
  onOpenTranscript: (runId: string) => void;
  onNewRoutine: () => void;
}) {
  const needsCount = summary.needs.length + summary.orphaned.length;
  const findings = showAllFindings ? summary.findings : summary.findings.slice(0, FINDINGS_COLLAPSED);

  const markAllRead = async () => {
    const r = await runAction("mark the reports read", () => window.api.routinesMarkRead("all"));
    if (r) {
      routinesToast("info", `Marked ${r.updated} ${r.updated === 1 ? "report" : "reports"} read`);
      await reload();
    }
  };
  const markRead = async (id: string) => {
    if (await runAction("mark the report read", () => window.api.routinesMarkRead([id]))) await reload();
  };

  return (
    <>
      {needsCount > 0 && (
        <div className="manta-routines-needs mt-8">
          <SectionHead title="Needs you" count={needsCount} />
          <div className="flex flex-col gap-2">
            {summary.needs.map((run) => (
              <NeedsCard key={run.id} run={run} now={now} onAnswer={() => onOpenTranscript(run.id)} />
            ))}
            {summary.orphaned.map((r) => (
              <OrphanCard key={r.id} routine={r} reload={reload} />
            ))}
          </div>
        </div>
      )}

      {summary.findings.length > 0 && (
        <div className="manta-routines-findings mt-8">
          <SectionHead
            title="Unread"
            count={summary.unread}
            right={
              <>
                {summary.findings.length > FINDINGS_COLLAPSED && (
                  <TextLink onClick={() => setShowAllFindings(!showAllFindings)}>
                    {showAllFindings ? "Show fewer" : `Show all ${summary.findings.length}`}
                  </TextLink>
                )}
                <TextLink onClick={() => void markAllRead()}>Mark all read</TextLink>
              </>
            }
          />
          <Box>
            {findings.map((run) => (
              <FindingRow
                key={run.id}
                run={run}
                routine={summary.routines.find((r) => r.id === run.routineId)}
                now={now}
                onOpen={() => onOpenRun(run.id, run)}
                onMarkRead={() => void markRead(run.id)}
              />
            ))}
          </Box>
        </div>
      )}

      {(summary.running.length > 0 || summary.waiting.length > 0) && (
        <div className="manta-routines-queue mt-8">
          <SectionHead title="Running now" hint={`${summary.concurrency} at a time; the rest wait their turn`} />
          <Box>
            <div className="grid grid-cols-[320px_1fr]">
              <div className="flex flex-col gap-2 border-r border-border-subtle px-4 py-3">
                <Eyebrow>Running</Eyebrow>
                {summary.running.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center gap-2 rounded-md bg-accent-bg px-3 py-2 text-label font-medium text-text"
                  >
                    <StatusDot tone="running" />
                    {run.routineName}
                    <span className="ml-auto text-micro font-mono tabular-nums text-accent-tx">{runElapsed(run, now) ?? "0m 00s"}</span>
                  </div>
                ))}
                {Array.from({ length: Math.max(0, summary.concurrency - summary.running.length) }).map((_, i) => (
                  <div key={i} className="rounded-md border border-dashed border-border px-3 py-2 text-label text-text-quiet">
                    Free
                  </div>
                ))}
              </div>
              <div className="px-4 py-3">
                <Eyebrow>Waiting</Eyebrow>
                {summary.waiting.length === 0 ? (
                  <div className="text-meta text-text-quiet">Nothing waiting</div>
                ) : (
                  summary.waiting.map((run, i) => (
                    <div key={run.id} className="flex items-center gap-2 py-1 text-label font-medium text-text-muted">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-fill-active text-micro font-mono font-semibold text-text-muted">
                        {i + 1}
                      </span>
                      {run.routineName}
                      {run.trigger === "manual" && (
                        <Pill tone="neutral" border size="meta">
                          you pressed Run now
                        </Pill>
                      )}
                      {run.trigger === "catch_up" && (
                        <Pill tone="neutral" border size="meta">
                          caught up
                        </Pill>
                      )}
                      <span className="ml-auto text-micro font-mono text-text-quiet">queued {clockHM(run.queuedAt)}</span>
                    </div>
                  ))
                )}
                <div className="mt-2 text-meta text-text-quiet">
                  A run is never skipped because the box is busy; it waits here. A routine that's already waiting isn't queued
                  twice. A run waiting on your answer gives up its slot.
                </div>
              </div>
            </div>
          </Box>
        </div>
      )}

      <div className="manta-routines-table mt-8">
        <SectionHead title="Your routines" count={summary.routines.length} />
        {summary.routines.length === 0 ? (
          <Card
            header={
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent-bg text-accent-tx">
                <CalendarClock size={16} aria-hidden />
              </span>
            }
            actions={
              <Button tone="primary" onClick={onNewRoutine}>
                New routine
              </Button>
            }
          >
            <div className="text-body font-semibold text-text">No routines yet</div>
            <div className="text-label text-text-faint">
              Ask in any chat — “every weekday at 9, summarize yesterday's analytics” — or create one here.
            </div>
          </Card>
        ) : (
          <Box>
            <div className={`${TABLE_GRID} py-2`}>
              <Eyebrow>Routine</Eyebrow>
              <Eyebrow>When</Eyebrow>
              <Eyebrow>Last run</Eyebrow>
              <Eyebrow>Next</Eyebrow>
              <span />
            </div>
            {summary.routines.map((r) => (
              <RoutineRow
                key={r.id}
                routine={r}
                lastRun={summary.lastRuns[r.id] ?? null}
                waitingPos={summary.waiting.findIndex((w) => w.routineId === r.id) + 1 || null}
                now={now}
                onOpen={() => onOpenRoutine(r.id)}
                reload={reload}
              />
            ))}
          </Box>
        )}
      </div>

    </>
  );
}

function NeedsCard({ run, now, onAnswer }: { run: RoutineRun; now: number; onAnswer: () => void }) {
  const q = run.question ?? "This run is waiting for your answer.";
  const permission = /^Allow /.test(q);
  const Badge = permission ? Shield : CircleHelp;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-border bg-bg-soft px-4 py-3 shadow-sm"
      style={{ borderLeftWidth: "var(--need-edge-w)", borderLeftColor: "var(--danger)" }}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-danger-bg text-danger">
        <Badge size={16} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-meta text-text-faint">
          {run.routineName}
          {run.projectName ? ` · ${run.projectName}` : ""} · asked {agoText(run.startedAt ?? run.queuedAt, now)} ago · paused until you
          answer
        </div>
        <div className="mt-1 text-body font-semibold text-text">{permission ? q : `“${q}”`}</div>
      </div>
      <div className="flex gap-2 self-center">
        <Button tone="primary" onClick={onAnswer}>
          Answer
        </Button>
      </div>
    </div>
  );
}

function OrphanCard({ routine, reload }: { routine: Routine; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-border bg-bg-soft px-4 py-3 shadow-sm"
      style={{ borderLeftWidth: "var(--need-edge-w)", borderLeftColor: "var(--danger)" }}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-danger-bg text-danger">
        <CircleHelp size={16} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-meta text-text-faint">
          {routine.name} · {projectLabel(routine)}
        </div>
        <div className="mt-1 text-body font-semibold text-text">{routine.name} lost its chat. Move it back to Routines?</div>
      </div>
      <div className="flex gap-2 self-center">
        <Button
          tone="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            const r = await runAction("move the routine back", () => window.api.routinesMoveBack(routine.id));
            setBusy(false);
            if (r) {
              routinesToast("info", `${routine.name} is back in Routines`);
              await reload();
            }
          }}
        >
          Move back
        </Button>
      </div>
    </div>
  );
}

function FindingRow({
  run,
  routine,
  now,
  onOpen,
  onMarkRead,
}: {
  run: RoutineRun;
  routine: Routine | undefined;
  now: number;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  const failed = run.status !== "done";
  const title = failed ? run.error ?? outcomeView(run)?.label ?? "" : run.report?.title ?? "";
  const summary = failed ? "" : run.report?.summary ?? "";
  const Icon = routineIcon(routine?.icon);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onActivate(onOpen)}
      className="group relative grid cursor-pointer grid-cols-[8px_1fr_auto] items-start gap-3 border-t border-border-subtle px-4 py-3 first:border-t-0 hover:bg-fill"
    >
      <span className={`mt-2 h-2 w-2 rounded-full bg-accent ${run.readAt != null ? "invisible" : ""}`} />
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-meta text-text-faint">
          <Icon size={12} aria-hidden />
          {run.routineName}
          {run.projectName && (
            <>
              <span className="text-text-quiet">·</span>
              {run.projectName}
            </>
          )}
          {failed && (
            <Pill tone="danger" size="meta">
              {outcomeView(run)?.label}
            </Pill>
          )}
        </div>
        <div className="mt-1 text-body font-semibold text-text">{title}</div>
        {summary && <div className="mt-1 truncate text-label text-text-faint">{summary}</div>}
      </div>
      <div className="mt-1 text-right text-micro font-mono tabular-nums text-text-quiet group-hover:invisible">
        {inboxTimeLabel(run.endedAt ?? run.startedAt ?? run.queuedAt, now)}
      </div>
      <div
        className="absolute right-3 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <Button tone="ghost" onClick={onMarkRead}>
          <Check size={14} aria-hidden />
          Mark read
        </Button>
        <Button tone="default" onClick={onOpen}>
          Open
        </Button>
      </div>
    </div>
  );
}

function RoutineRow({
  routine,
  lastRun,
  waitingPos,
  now,
  onOpen,
  reload,
}: {
  routine: Routine;
  lastRun: RoutineRun | null;
  waitingPos: number | null;
  now: number;
  onOpen: () => void;
  reload: () => Promise<void>;
}) {
  const inChat = routine.destination.type === "session";
  const paused = !routine.enabled && !inChat;
  const dim = paused || inChat ? "text-text-quiet" : "";
  const next =
    inChat || paused || lastRun?.status === "needs_input" ? "—" : nextLabel(routine.nextRunAt, now);
  const view = inChat ? IN_A_CHAT : lastRun ? outcomeView(lastRun, waitingPos) : null;
  // A run that reported gets no pill (outcomeView is null for it): unread reports have their own section above.
  const detail = inChat ? "Runs inside a chat" : lastRun ? lastRunDetail(lastRun, now) : "Never run";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onActivate(onOpen)}
      className={`${TABLE_GRID} cursor-pointer border-t border-border-subtle py-3 first-of-type:border-t-0 hover:bg-fill`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <RoutineGlyph icon={routine.icon} />
        <span className="min-w-0">
          <span className={`block truncate text-body font-semibold ${dim || "text-text"}`}>{routine.name}</span>
          <span className="block text-meta font-mono text-text-quiet">{projectLabel(routine)}</span>
        </span>
      </div>
      <div>
        <div className={`text-label font-medium ${dim || "text-text-muted"}`}>
          {paused ? "Paused" : inChat ? "In a chat" : cadenceText(routine.cron)}
        </div>
        <div className="text-meta text-text-quiet">{paused ? `was ${cadenceText(routine.cron)}` : accessLine(routine)}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1">
        {view ? (
          <span>
            <OutcomePill view={view} />
          </span>
        ) : null}
        <span className="max-w-full truncate text-meta text-text-quiet">{detail}</span>
      </div>
      <div className="whitespace-nowrap text-meta font-mono text-text-faint">{next}</div>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Toggle
          checked={routine.enabled}
          disabled={inChat}
          ariaLabel={`Enable ${routine.name}`}
          onChange={async (enabled) => {
            const r = await runAction(`${enabled ? "enable" : "pause"} ${routine.name}`, () =>
              window.api.routinesUpdate(routine.id, { enabled }),
            );
            if (r) await reload();
          }}
        />
      </div>
    </div>
  );
}
