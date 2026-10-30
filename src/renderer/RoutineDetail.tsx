// ===== One routine (R2) =====
//
// Hero (what it is, when it runs next, Edit / Pause / Run now), the run
// history, and the three side boxes: what it remembers (editable), its
// instructions, and its settings. A routine moved into a chat shows its frozen
// history and offers "Move back to Routines" instead of Pause / Run now.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  Clock,
  Eye,
  Folder,
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
import {
  Box,
  CrumbLink,
  CrumbSep,
  OutcomePill,
  PageColumn,
  RoutineGlyph,
  RoutinesHeader,
  SectionHead,
  TextLink,
  useNowMs,
} from "./RoutinesParts";
import { routinesToast, runAction, useRoutinesRefetch } from "./routinesData";
import {
  cadenceText,
  isTerminal,
  memoryLines,
  nextRunPhrase,
  notifyLabel,
  outcomeView,
  runDateParts,
  runDuration,
  runNote,
  runTitle,
  splitInstructions,
  tildePath,
} from "./routinesView";
import { formatTokenCount } from "../shared/formatTokens.mjs";

const RUN_GRID = "grid grid-cols-[80px_112px_minmax(0,1fr)_64px] items-center gap-3 px-4";
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
  onBack,
  onOpenRun,
  onEdit,
  onMoveToChat,
  onChanged,
}: {
  routineId: string;
  summary: RoutinesSummary | null;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
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
  const [findingsOnly, setFindingsOnly] = useState(false);
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [memEdit, setMemEdit] = useState<string | null>(null);
  const [memSaving, setMemSaving] = useState(false);
  const [waitingNote, setWaitingNote] = useState(false);
  const [destOpen, setDestOpen] = useState(false);
  const destRef = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await window.api.routinesGet(routineId, { findingsOnly });
      if (!alive.current || !d) return;
      setDetail(d);
      setHasMore(d.hasMore);
      setExtraRuns([]);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [routineId, findingsOnly]);
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

  const showOlder = async () => {
    const last = runs[runs.length - 1];
    if (!last) return;
    const more = await runAction("load older runs", () => window.api.routinesGet(routineId, { beforeSeq: last.seq, findingsOnly }));
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

  const edit = () => onEdit(routine, memory);
  const factChip = (icon: React.ReactNode, text: string, mono = false) => (
    <Chip onClick={edit} title="Change in Edit">
      {icon}
      <span className={mono ? "font-mono" : undefined}>{text}</span>
    </Chip>
  );

  return (
    <div className="manta-routines-detail flex h-full w-full flex-col bg-bg" data-screen="routines">
      <RoutinesHeader>
        <CrumbLink onClick={onBack}>Routines</CrumbLink>
        <CrumbSep />
        {routine.name}
      </RoutinesHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageColumn>
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
            <div className="ml-auto flex shrink-0 items-center gap-2">
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
            </div>
          </div>

          <div className="mt-8 grid grid-cols-[minmax(0,1fr)_320px] items-start gap-6">
            <div>
              <SectionHead
                title="Runs"
                count={stats.runCount}
                right={
                  <TextLink pressed={findingsOnly} onClick={() => setFindingsOnly((v) => !v)}>
                    {findingsOnly ? "Show all" : "Findings only"}
                  </TextLink>
                }
              />
              <Box>
                {runs.length === 0 ? (
                  <div className="px-4 py-3 text-label text-text-faint">
                    {findingsOnly ? "No runs with findings yet." : "No runs yet."}
                  </div>
                ) : (
                  runs.map((run) => (
                    <RunRow key={run.id} run={run} waitingPos={summary ? summary.waiting.findIndex((w) => w.id === run.id) + 1 || null : null} now={now} onOpen={() => onOpenRun(run.id)} />
                  ))
                )}
              </Box>
              {hasMore && (
                <div className="mt-2">
                  <TextLink onClick={() => void showOlder()}>Show older</TextLink>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
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
                        <div className="whitespace-pre-wrap text-meta leading-relaxed">
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
                        </div>
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
                <div className="mx-4 mb-4 mt-3 whitespace-pre-wrap text-label text-text-muted">
                  {splitInstructions(routine.prompt).map((p, i) =>
                    p.kind === "skill" ? (
                      <span key={i} className="inline-flex rounded-full bg-accent-bg px-2 font-mono text-meta text-accent-tx">
                        {p.text}
                      </span>
                    ) : (
                      <span key={i}>{p.text}</span>
                    ),
                  )}
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
            </div>
          </div>
        </PageColumn>
      </div>
    </div>
  );
}

function RunRow({ run, waitingPos, now, onOpen }: { run: RoutineRun; waitingPos: number | null; now: number; onOpen: () => void }) {
  const { day, time } = runDateParts(run.startedAt ?? run.queuedAt);
  const unread = run.readAt == null && isTerminal(run.status) && (run.report?.outcome === "findings" || run.status === "failed" || run.status === "timed_out");
  const quiet = run.report?.outcome === "nothing";
  const note = runNote(run);
  const dur = run.startedAt != null && run.endedAt != null ? runDuration(run.endedAt - run.startedAt) : "";
  void now;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`${RUN_GRID} cursor-pointer border-t border-border-subtle py-3 first:border-t-0 hover:bg-fill`}
    >
      <div className="text-meta font-mono text-text-faint">
        {day}
        <span className="block text-micro text-text-quiet">{time}</span>
      </div>
      <div>
        <OutcomePill view={outcomeView(run, waitingPos)} />
      </div>
      <div className={`truncate text-label ${unread ? "font-semibold text-text" : quiet ? "font-normal text-text-faint" : "font-medium text-text"}`}>
        {runTitle(run)}
        {note && <span className="block truncate text-meta font-normal text-text-quiet">{note}</span>}
      </div>
      <div className="text-right text-micro font-mono text-text-quiet">{dur}</div>
    </div>
  );
}
