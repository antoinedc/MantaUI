// ===== One routine (R2) — the run inbox =====
//
// A split view (spec §7 "Run inbox"): the run list on the left (with an
// "About this routine" item on top), the selected run's report on the right.
// About shows what the old page showed: the hero (what it is, when it runs
// next), what it remembers (editable), its instructions and its settings.
// Edit / Pause / Run now sit in the header. A routine moved into a chat shows
// its frozen history and offers "Move back to Routines" instead of Pause / Run now.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  Clock,
  Eye,
  Folder,
  MessageSquareText,
  NotebookText,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Sparkles,
} from "lucide-react";
import type { FollowupRow, Routine, RoutineDetail as DetailData, RoutineRun, RoutinesSummary } from "../shared/routines";
import type { OpencodeModel } from "../shared/types";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Chip } from "./Chip";
import { Field } from "./Field";
import { IconButton } from "./IconButton";
import { Dropdown } from "./MenuItem";
import { MenuOption } from "./MenuOption";
import { OutputWell } from "./OutputWell";
import { MemoryUpdatedLine, NotifiedLine, ReportCard } from "./RoutineRunParts";
import {
  Box,
  CrumbLink,
  CrumbSep,
  OutcomePill,
  PageColumn,
  RoutineGlyph,
  RoutinesHeader,
  ShowMore,
  SectionHead,
  TextLink,
  useNowMs,
} from "./RoutinesParts";
import { errMessage, hasReportView, keepRunInSidebar, routinesToast, runAction, useRoutinesRefetch } from "./routinesData";
import {
  ABOUT_ITEM,
  cadenceText,
  clockHM,
  defaultRunSelection,
  isTerminal,
  isUnreadRun,
  memoryLines,
  nextRunPhrase,
  notifyLabel,
  outcomeView,
  runDateParts,
  runDuration,
  runElapsed,
  runListTitle,
  runSentence,
  splitInstructions,
  tildePath,
  triggerLabel,
} from "./routinesView";
import { formatTokenCount } from "../shared/formatTokens.mjs";

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function modelText(model: Routine["model"], models: OpencodeModel[] | null): string {
  if (!model) return "Default model";
  const name = models?.find((m) => m.providerID === model.providerID && m.id === model.modelID)?.name ?? model.modelID;
  const variant = model.variant ? ` · ${model.variant.charAt(0).toUpperCase()}${model.variant.slice(1)}` : "";
  return `${name}${variant}`;
}

export function RoutineDetail({
  routineId,
  summary,
  runId,
  onBack,
  onSelectRun,
  onOpenTranscript,
  onClosePane,
  onEdit,
  onMoveToChat,
  onChanged,
}: {
  routineId: string;
  summary: RoutinesSummary | null;
  /** The selected run ("about" = the About item); absent = the default selection. */
  runId?: string;
  onBack: () => void;
  /** The selection changed (kept in the pane's view so a transcript's × comes back to it). */
  onSelectRun: (runId: string) => void;
  onOpenTranscript: (runId: string) => void;
  /** Leave the Routines pane (after Follow up). */
  onClosePane: () => void;
  onEdit: (routine: Routine, memory: string) => void;
  onMoveToChat: (routine: Routine, ctx: { runCount: number; memory: string }) => void;
  /** A change the pane's summary should pick up. */
  onChanged: () => void;
}) {
  const now = useNowMs();
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [extraRuns, setExtraRuns] = useState<RoutineRun[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quietHidden, setQuietHidden] = useState(false);
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [memEdit, setMemEdit] = useState<string | null>(null);
  const [memSaving, setMemSaving] = useState(false);
  const [waitingNote, setWaitingNote] = useState(false);
  const [destOpen, setDestOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(runId ?? null);
  const [fetchedRun, setFetchedRun] = useState<RoutineRun | null>(null);
  const destRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const marked = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await window.api.routinesGet(routineId, { findingsOnly: quietHidden });
      if (!alive.current || !d) return;
      setDetail(d);
      setHasMore(d.hasMore);
      setExtraRuns([]);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errMessage(e));
    }
  }, [routineId, quietHidden]);
  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);
  useRoutinesRefetch(() => void load(), 30_000);
  useEffect(() => {
    let live = true;
    window.api
      .opencodeModels?.()
      .then((m) => live && setModels(m ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const runs = detail ? [...detail.runs, ...extraRuns] : [];

  const select = useCallback(
    (id: string) => {
      setSel(id);
      onSelectRun(id);
    },
    [onSelectRun],
  );

  // A different run requested from outside (a notification for this same routine).
  useEffect(() => {
    if (runId && runId !== sel) setSel(runId);
    // Only the request is watched; the local selection changes through `select`, which reports it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // The first load decides the default and keeps it: reading the newest unread run must not move the selection.
  useEffect(() => {
    if (!detail || sel != null) return;
    select(defaultRunSelection(runs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, sel]);

  const selectedInList = sel && sel !== ABOUT_ITEM ? runs.find((r) => r.id === sel) : undefined;
  // A run older than the loaded page (back from its transcript, or a notification): fetch it on its own.
  useEffect(() => {
    if (!detail || !sel || sel === ABOUT_ITEM || selectedInList) return;
    let live = true;
    window.api
      .routinesRunGet(sel)
      .then((r) => {
        if (!live || !r) return;
        if (r.run.routineId === routineId) setFetchedRun(r.run);
        else select(defaultRunSelection(runs));
      })
      .catch((e: unknown) => {
        if (!live) return;
        routinesToast("error", `Couldn't open that run — ${errMessage(e)}`);
        select(defaultRunSelection(runs));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, sel, selectedInList, routineId]);
  const selectedRun = selectedInList ?? (sel && sel !== ABOUT_ITEM && fetchedRun?.id === sel ? fetchedRun : undefined);

  // Selecting a finished run reads it (spec §6.4), same as opening its transcript.
  useEffect(() => {
    const run = selectedRun;
    if (!run || run.readAt != null || !isTerminal(run.status) || marked.current === run.id) return;
    marked.current = run.id;
    void window.api
      .routinesMarkRead([run.id])
      .then(() => {
        onChanged();
        void load();
      })
      .catch(() => {
        marked.current = null;
      });
  }, [selectedRun, onChanged, load]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  const showOlder = async () => {
    const last = runs[runs.length - 1];
    if (!last) return;
    const more = await runAction("load older runs", () => window.api.routinesGet(routineId, { beforeSeq: last.seq, findingsOnly: quietHidden }));
    if (more && alive.current) {
      setExtraRuns((prev) => [...prev, ...more.runs]);
      setHasMore(more.hasMore);
    }
  };

  if (!detail) {
    return (
      <div className="manta-routines-detail flex h-full w-full flex-col bg-bg">
        <RoutinesHeader>
          <CrumbLink onClick={onBack}>Routines</CrumbLink>
        </RoutinesHeader>
        <PageColumn>
          <div className="text-body text-text-faint">{error ? `Couldn't load the routine — ${error}` : "Loading…"}</div>
        </PageColumn>
      </div>
    );
  }

  const { routine, memory, stats } = detail;
  const inChat = routine.destination.type === "session";
  const followup: FollowupRow | undefined = summary?.followups.find((f) => f.routineId === routine.id);
  const chatName = followup?.sessionName ?? "a chat";
  const memRun = routine.memoryUpdatedByRunId ? runs.find((r) => r.id === routine.memoryUpdatedByRunId) : undefined;
  const memRunLabel = memRun ? `${WEEKDAY_FULL[new Date(memRun.startedAt ?? memRun.queuedAt).getDay()]}'s run` : routine.memoryUpdatedByRunId ? "a recent run" : null;
  const waitingPosOf = (id: string) => (summary ? summary.waiting.findIndex((w) => w.id === id) + 1 || null : null);

  const runNow = async () => {
    const r = await runAction("start the run", () => window.api.routinesRunNow(routine.id));
    if (!r) return;
    if (r.alreadyQueued) {
      setWaitingNote(true);
      setTimeout(() => alive.current && setWaitingNote(false), 4000);
    } else {
      routinesToast("info", `${routine.name} is queued`);
    }
    onChanged();
    void load();
  };
  const togglePause = async () => {
    const r = await runAction(routine.enabled ? "pause the routine" : "resume the routine", () =>
      window.api.routinesUpdate(routine.id, { enabled: !routine.enabled }),
    );
    if (r) {
      onChanged();
      void load();
    }
  };
  const moveBack = async () => {
    const r = await runAction("move the routine back", () => window.api.routinesMoveBack(routine.id));
    if (r) {
      routinesToast("info", `${routine.name} is back in Routines`);
      onChanged();
      void load();
    }
  };
  const saveMemory = async () => {
    if (memEdit == null) return;
    setMemSaving(true);
    const r = await runAction("save the memory", () => window.api.routinesMemorySet(routine.id, memEdit));
    setMemSaving(false);
    if (r) {
      routinesToast("info", "Memory saved");
      setMemEdit(null);
      void load();
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const ids = [ABOUT_ITEM, ...runs.map((r) => r.id)];
    const next = ids[Math.min(ids.length - 1, Math.max(0, ids.indexOf(sel ?? ABOUT_ITEM) + dir))];
    if (next !== sel) select(next);
  };

  const edit = () => onEdit(routine, memory);
  const factChip = (icon: React.ReactNode, text: string, mono = false) => (
    <Chip onClick={edit} title="Change in Edit">
      {icon}
      <span className={mono ? "font-mono" : undefined}>{text}</span>
    </Chip>
  );

  const aboutSelected = sel === ABOUT_ITEM;
  const aboutSub = inChat ? "in a chat" : routine.enabled ? `next ${nextRunPhrase(routine.nextRunAt, now)}` : "paused";

  const about = (
    <>
      <div className="flex items-start gap-4">
        <RoutineGlyph icon={routine.icon} size="lg" />
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-text">{routine.name}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            {factChip(<Clock size={13} aria-hidden />, cadenceText(routine.cron, "at"))}
            {factChip(<Folder size={13} aria-hidden />, tildePath(routine.directory), true)}
            {factChip(
              routine.access === "edit" ? <Pencil size={13} aria-hidden /> : <Eye size={13} aria-hidden />,
              routine.access === "edit" ? "Can make changes" : "Read-only",
            )}
            {factChip(<Sparkles size={13} aria-hidden />, modelText(routine.model, models))}
            {factChip(<Bell size={13} aria-hidden />, notifyLabel(routine.notify))}
            <span ref={destRef} className="inline-flex">
              <Chip on onClick={() => setDestOpen((v) => !v)} title="Change where it runs">
                <CalendarClock size={13} aria-hidden />
                {inChat ? `Inside ${chatName}` : "New session each run"}
                <ChevronDown size={13} aria-hidden />
              </Chip>
            </span>
            <Dropdown open={destOpen} onClose={() => setDestOpen(false)} anchorRef={destRef} align="start" role="listbox" width="wide">
              <MenuOption
                selected={!inChat}
                label="New session each run"
                sub="Each run starts fresh and lands on the Routines page"
                onSelect={() => {
                  setDestOpen(false);
                  if (inChat) void moveBack();
                }}
              />
              <MenuOption
                selected={inChat}
                label="Inside a chat…"
                sub="Runs post into an existing or new chat"
                onSelect={() => {
                  setDestOpen(false);
                  if (!inChat) onMoveToChat(routine, { runCount: stats.runCount, memory });
                }}
              />
            </Dropdown>
          </div>
          {inChat && (
            <div className="mt-3">
              <Callout tone="info" size="note">
                Runs inside {chatName} every {cadenceText(routine.cron)}.
              </Callout>
            </div>
          )}
          <div className="mt-3 text-label text-text-faint">
            {inChat || !routine.enabled ? null : (
              <>
                Next run <b className="font-semibold text-text">{nextRunPhrase(routine.nextRunAt, now)}</b> ·{" "}
              </>
            )}
            {stats.runCount} {stats.runCount === 1 ? "run" : "runs"}
            {stats.firstRunAt != null && <> since {new Date(stats.firstRunAt).getDate()} {new Date(stats.firstRunAt).toLocaleString("en", { month: "short" })}</>}
            {stats.avgTokens != null && <> · about {formatTokenCount(Math.round(stats.avgTokens))} tokens a run</>}
          </div>
        </div>
      </div>

      <div className="manta-routines-memory">
        <Box>
          <div className="flex items-center gap-2 px-4 pt-3">
            <NotebookText size={14} className="text-text-faint" aria-hidden />
            <h4 className="text-label font-semibold text-text">What it remembers</h4>
            <span className="ml-auto">
              <IconButton icon={<Pencil />} label="Edit memory" onClick={() => setMemEdit(memEdit == null ? memory : null)} />
            </span>
          </div>
          <div className="px-4 pt-1 text-meta text-text-quiet">
            Every run reads this first and updates it at the end.{memRunLabel ? ` Last changed by ${memRunLabel}.` : ""}
          </div>
          <div className="mx-4 mb-4 mt-3">
            {memEdit != null ? (
              <div className="flex flex-col gap-2">
                <Field multiline rows={12} ariaLabel="Memory" value={memEdit} onChange={(e) => setMemEdit(e.target.value)} />
                <div className="flex items-center gap-2">
                  <Button tone="danger" onClick={() => setMemEdit("")}>
                    Clear
                  </Button>
                  <span className="ml-auto" />
                  <Button tone="ghost" onClick={() => setMemEdit(null)}>
                    Cancel
                  </Button>
                  <Button tone="primary" loading={memSaving} onClick={() => void saveMemory()}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <OutputWell variant="standalone">
                <ShowMore lines={6} className="whitespace-pre-wrap text-meta leading-relaxed">
                  {memory.trim() === ""
                    ? "(nothing yet — the first run will write it)"
                    : memoryLines(memory, memRun?.memoryDiff?.added).map((l, i, all) => (
                        <span key={i}>
                          {l.kind === "heading" ? (
                            <span className="font-semibold text-text">{l.text}</span>
                          ) : l.kind === "added" ? (
                            <span className="rounded-xs bg-[var(--diff-add)]">{l.text}</span>
                          ) : (
                            l.text
                          )}
                          {i < all.length - 1 ? "\n" : ""}
                        </span>
                      ))}
                </ShowMore>
              </OutputWell>
            )}
          </div>
        </Box>
      </div>

      <Box>
        <div className="flex items-center gap-2 px-4 pt-3">
          <MessageCircle size={14} className="text-text-faint" aria-hidden />
          <h4 className="text-label font-semibold text-text">Instructions</h4>
          <span className="ml-auto">
            <IconButton icon={<Pencil />} label="Edit instructions" onClick={edit} />
          </span>
        </div>
        <div className="mx-4 mb-4 mt-3">
          <ShowMore lines={5} className="whitespace-pre-wrap text-label text-text-muted">
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
        </div>
      </Box>

      <Box>
        <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 px-4 pb-4 pt-3 text-meta">
          <dt className="text-text-quiet">Triggers</dt>
          <dd className="text-text-muted">{inChat ? "Inside a chat" : "Schedule · Run now"}</dd>
          <dt className="text-text-quiet">Missed runs</dt>
          <dd className="text-text-muted">
            {routine.catchUpHours > 0 ? `Run once on catch-up, up to ${routine.catchUpHours}h late` : "Never catch up"}
          </dd>
          <dt className="text-text-quiet">Keeps</dt>
          <dd className="text-text-muted">30 days of runs; unread runs are never deleted</dd>
        </dl>
      </Box>
    </>
  );

  return (
    <div className="manta-routines-detail flex h-full w-full flex-col bg-bg" data-screen="routines">
      <RoutinesHeader
        right={
          <>
            {waitingNote && <span className="text-meta text-text-faint">Already waiting in line</span>}
            <Button tone="default" onClick={edit}>
              <Pencil size={14} aria-hidden />
              Edit
            </Button>
            {inChat ? (
              <Button tone="default" onClick={() => void moveBack()}>
                Move back to Routines
              </Button>
            ) : (
              <>
                <Button tone="default" onClick={() => void togglePause()}>
                  {routine.enabled ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                  {routine.enabled ? "Pause" : "Resume"}
                </Button>
                <Button tone="primary" onClick={() => void runNow()}>
                  <Play size={14} aria-hidden />
                  Run now
                </Button>
              </>
            )}
          </>
        }
      >
        <CrumbLink onClick={onBack}>Routines</CrumbLink>
        <CrumbSep />
        {routine.name}
      </RoutinesHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)]">
        <div
          ref={listRef}
          role="listbox"
          aria-label="Runs"
          tabIndex={0}
          onKeyDown={onListKey}
          className="manta-routines-runlist min-h-0 overflow-y-auto border-r border-border-subtle bg-bg-elev"
        >
          <ListItem selected={aboutSelected} onSelect={() => select(ABOUT_ITEM)}>
            <RoutineGlyph icon={routine.icon} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-semibold text-text">About this routine</span>
              <span className="block truncate text-meta text-text-quiet">
                {cadenceText(routine.cron)} · {aboutSub}
              </span>
            </span>
          </ListItem>
          <div role="presentation" className="px-4 pt-4">
            <SectionHead
              title="Runs"
              count={stats.runCount}
              right={
                <TextLink pressed={quietHidden} onClick={() => setQuietHidden((v) => !v)}>
                  {quietHidden ? "Show all" : "Hide quiet runs"}
                </TextLink>
              }
            />
          </div>
          {runs.length === 0 ? (
            <div role="presentation" className="px-4 py-3 text-label text-text-faint">
              {quietHidden ? "No runs to show." : "No runs yet."}
            </div>
          ) : (
            runs.map((run) => <RunItem key={run.id} run={run} selected={run.id === sel} waitingPos={waitingPosOf(run.id)} onSelect={() => select(run.id)} />)
          )}
          {hasMore && (
            <div role="presentation" className="px-4 py-2">
              <TextLink onClick={() => void showOlder()}>Show older</TextLink>
            </div>
          )}
        </div>

        <div className="manta-routines-reading min-h-0 overflow-y-auto px-8 py-6">
          <div className="flex flex-col gap-4" style={{ maxWidth: "var(--measure)" }}>
            {aboutSelected ? (
              about
            ) : selectedRun ? (
              <RunReading
                run={selectedRun}
                routine={routine}
                waitingPos={waitingPosOf(selectedRun.id)}
                now={now}
                onSeeTranscript={() => onOpenTranscript(selectedRun.id)}
                onFollowUp={() => void keepRunInSidebar(selectedRun.id, { onClosePane, onChanged, what: "open the run as a session" })}
              />
            ) : (
              <div className="text-body text-text-faint">Loading…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const ITEM_BASE = "flex cursor-pointer items-start gap-3 border-b border-border-subtle px-4 py-3 hover:bg-fill";
const SELECTED_EDGE = { boxShadow: "inset var(--need-edge-w) 0 0 var(--accent)" } as const;

function ListItem({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <div role="option" aria-selected={selected} onClick={onSelect} className={`${ITEM_BASE} ${selected ? "bg-raised" : ""}`} style={selected ? SELECTED_EDGE : undefined}>
      {children}
    </div>
  );
}

function RunItem({ run, selected, waitingPos, onSelect }: { run: RoutineRun; selected: boolean; waitingPos: number | null; onSelect: () => void }) {
  const { day, time } = runDateParts(run.startedAt ?? run.queuedAt);
  const unread = isUnreadRun(run);
  const quiet = run.report?.outcome === "nothing";
  const view = outcomeView(run, waitingPos);
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`${ITEM_BASE} grid grid-cols-[8px_minmax(0,1fr)_auto] ${selected ? "bg-raised" : ""}`}
      style={selected ? SELECTED_EDGE : undefined}
    >
      <span className={`mt-1 h-2 w-2 rounded-full bg-accent ${unread ? "" : "invisible"}`} />
      <div className="min-w-0">
        <div className="text-micro font-mono text-text-quiet">
          {day} · {time}
        </div>
        <div className={`mt-1 line-clamp-2 text-label ${unread ? "font-semibold text-text" : quiet ? "font-normal text-text-faint" : "font-medium text-text"}`}>
          {runListTitle(run)}
        </div>
      </div>
      {view && (
        <span className="mt-1">
          <OutcomePill view={view} />
        </span>
      )}
    </div>
  );
}

/** The right pane for one run: its report with the actions above it, or one line for what the run is doing. */
function RunReading({
  run,
  routine,
  waitingPos,
  now,
  onSeeTranscript,
  onFollowUp,
}: {
  run: RoutineRun;
  routine: Routine;
  waitingPos: number | null;
  now: number;
  onSeeTranscript: () => void;
  onFollowUp: () => void;
}) {
  const hasSession = run.sessionID != null;
  const transcriptButton = (label: string, tone: "default" | "primary" = "default") =>
    hasSession && (
      <Button tone={tone} onClick={onSeeTranscript}>
        <MessageSquareText size={14} aria-hidden />
        {label}
      </Button>
    );

  if (hasReportView(run)) {
    const dur = run.startedAt != null && run.endedAt != null ? runDuration(run.endedAt - run.startedAt) : null;
    const parts = [
      triggerLabel(run.trigger),
      run.startedAt != null ? `started ${clockHM(run.startedAt)}` : null,
      dur,
      run.tokens != null ? `${formatTokenCount(run.tokens)} tokens` : null,
    ].filter(Boolean);
    const added = run.memoryDiff?.added ?? [];
    return (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-text-faint">
          <span className="flex items-center gap-2">
            {parts.join(" · ")}
            <span className="text-text-quiet">·</span>
            <NotifiedLine run={run} />
          </span>
          {hasSession && (
            <span className="ml-auto flex gap-2">
              {transcriptButton("See transcript")}
              <Button tone="primary" onClick={onFollowUp}>
                Follow up
              </Button>
            </span>
          )}
        </div>
        <ReportCard run={run} routine={routine} footer={false} />
        {added.length > 0 && <MemoryUpdatedLine added={added} />}
      </>
    );
  }

  if (run.status === "running") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-body text-text-muted">
          Running for {runElapsed(run, now) ?? "0m 00s"}
          {run.startedAt != null && <> · started {clockHM(run.startedAt)}</>}
        </span>
        <span className="ml-auto flex gap-2">{transcriptButton("Watch transcript")}</span>
      </div>
    );
  }
  if (run.status === "needs_input") {
    return (
      <>
        <div className="text-body font-semibold text-text">{run.question ?? "This run is waiting for your answer."}</div>
        {hasSession && (
          <div className="flex">
            <Button tone="primary" onClick={onSeeTranscript}>
              Answer
            </Button>
          </div>
        )}
      </>
    );
  }
  if (run.status === "queued") {
    return <div className="text-body text-text-muted">Waiting in line{waitingPos ? ` — #${waitingPos}` : ""}</div>;
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-body text-text-muted">{runSentence(run)}</span>
      <span className="ml-auto flex gap-2">{transcriptButton("See transcript")}</span>
    </div>
  );
}
