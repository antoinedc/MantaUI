// ===== New / edit routine (R4) =====
//
// One short form. Memory is not a field here (the form only explains it). The
// schedule is a preset model (Hourly … Custom) that round-trips to the 5-field
// cron the box stores (`routinesView.ts`). "Test run now" saves the routine
// PAUSED (new) or as edited (existing) and queues one run, then hands the run
// id to the caller, which opens it.

import { useMemo, useRef, useState } from "react";
import { Folder, NotebookText, Play, Sparkles } from "lucide-react";
import type { Routine } from "../shared/routines";
import type { OpencodeModel } from "../shared/types";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Chip, ChipGroup } from "./Chip";
import { Field } from "./Field";
import { FolderPickerModal } from "./FolderPickerModal";
import { ModelMenu } from "./ModelMenu";
import { Modal } from "./Modal";
import {
  LabelledBlock,
  PickerButton,
  RadioCard,
  RoutineModalBody,
  RoutineModalFooter,
  RoutineModalHeader,
} from "./RoutinesParts";
import { routinesToast, runAction } from "./routinesData";
import {
  SCHEDULE_KINDS,
  WEEK_DAYS,
  canSaveDraft,
  cadenceText,
  cronToSchedule,
  draftErrors,
  draftFromRoutine,
  draftToInput,
  emptyDraft,
  formatTimeInput,
  parseTimeInput,
  scheduleHelp,
  scheduleToCron,
  tildePath,
  NOTIFY_OPTIONS,
  type RoutineDraft,
  type Schedule,
  type ScheduleKind,
} from "./routinesView";
import { nowMs } from "./clock";
import { useStore } from "./store";

function groupModels(models: OpencodeModel[] | null): Array<[string, OpencodeModel[]]> | null {
  if (!models) return null;
  const by = new Map<string, OpencodeModel[]>();
  for (const m of models) {
    if (m.enabled === false) continue;
    const list = by.get(m.providerID) ?? [];
    list.push(m);
    by.set(m.providerID, list);
  }
  return [...by.entries()];
}

export function modelLabel(model: Routine["model"], models: OpencodeModel[] | null): string {
  if (!model) return "Default";
  const name = models?.find((m) => m.providerID === model.providerID && m.id === model.modelID)?.name ?? model.modelID;
  return model.variant ? `${name} · ${model.variant}` : name;
}

export interface RoutineEditorProps {
  open: boolean;
  /** Editing an existing routine; null → creating. */
  routine: Routine | null;
  /** The routine's current memory (edit only), kept as it is. */
  memory?: string;
  /** Box time zone, for the schedule help line. */
  tz: string;
  onClose: () => void;
  onSaved: (routine: Routine) => void;
  /** A test run was queued (the routine was saved first). */
  onTestRun: (routine: Routine, runId: string) => void;
}

export function RoutineEditor({ open, routine, tz, onClose, onSaved, onTestRun }: RoutineEditorProps) {
  const editing = routine != null;
  const homeDir = useStore((s) => s.projects[0]?.defaultCwd ?? "");
  const [draft, setDraft] = useState<RoutineDraft>(() => (routine ? draftFromRoutine(routine) : emptyDraft(homeDir)));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [timeText, setTimeText] = useState(() => formatTimeInput(draft.schedule.hour, draft.schedule.minute));
  const [folderOpen, setFolderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // Load the model list when the modal first opens (the picker and the label need it).
  const modelsRequested = useRef(false);
  if (open && !modelsRequested.current) {
    modelsRequested.current = true;
    window.api
      .opencodeModels?.()
      .then((m) => setModels(m ?? []))
      .catch(() => setModels([]));
  }

  const errors = draftErrors(draft);
  const valid = canSaveDraft(draft);
  const sched = draft.schedule;
  // A schedule that cannot be right (Custom cron, no weekday) says so as you type; the other fields wait for a blur or a save.
  const err = (k: keyof typeof errors) =>
    ((touched[k] || (k === "schedule" && (sched.kind === "custom" || sched.kind === "weekly"))) ? errors[k] : undefined) ?? null;
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const patch = (p: Partial<RoutineDraft>) => setDraft((d) => ({ ...d, ...p }));
  const setSched = (p: Partial<Schedule>) =>
    setDraft((d) => {
      const next = { ...d.schedule, ...p };
      return { ...d, schedule: { ...next, cron: p.kind === "custom" && d.schedule.kind !== "custom" ? scheduleToCron(d.schedule) : next.cron } };
    });
  const groups = useMemo(() => groupModels(models), [models]);
  const cron = scheduleToCron(sched);

  const setKind = (kind: ScheduleKind) => {
    if (kind === "custom") setSched({ kind, cron: scheduleToCron(sched) });
    else if (sched.kind === "custom") {
      const back = cronToSchedule(cron);
      setSched({ kind, minute: back.minute, hour: back.hour });
      setTimeText(formatTimeInput(back.hour, back.minute));
    } else setSched({ kind });
  };

  const commitTime = (text: string) => {
    setTimeText(text);
    const t = parseTimeInput(text);
    if (t) setSched({ hour: t.hour, minute: t.minute });
  };
  const timeBad = timeText !== "" && parseTimeInput(timeText) == null;

  const save = async (): Promise<Routine | undefined> => {
    setTouched({ name: true, prompt: true, directory: true, schedule: true });
    if (!valid || timeBad) return undefined;
    const input = draftToInput(draft);
    return runAction(editing ? "save the routine" : "create the routine", () =>
      editing ? window.api.routinesUpdate((routine as Routine).id, input) : window.api.routinesCreate(input),
    );
  };

  const onSave = async () => {
    setBusy("save");
    const r = await save();
    setBusy(null);
    if (r) {
      routinesToast("info", editing ? `Saved ${r.name}` : `Created ${r.name}`);
      onSaved(r);
    }
  };

  const onTest = async () => {
    setBusy("test");
    setTouched({ name: true, prompt: true, directory: true, schedule: true });
    if (!valid || timeBad) {
      setBusy(null);
      return;
    }
    const input = draftToInput(draft);
    // A new routine is saved PAUSED so the test run is the only run until the user creates it for real.
    const saved = await runAction(editing ? "save the routine" : "create the routine", () =>
      editing ? window.api.routinesUpdate((routine as Routine).id, input) : window.api.routinesCreate({ ...input, enabled: false }),
    );
    if (!saved) {
      setBusy(null);
      return;
    }
    const run = await runAction("start the test run", () => window.api.routinesRunNow(saved.id));
    setBusy(null);
    if (run) onTestRun(saved, run.run.id);
    else onSaved(saved);
  };

  const modelText = modelLabel(draft.model, models);
  const dow = (n: number) => sched.days.includes(n);
  const toggleDay = (n: number) =>
    setSched({ days: dow(n) ? sched.days.filter((d) => d !== n) : [...sched.days, n] });
  const timeField = (
    <div className="w-24">
      <Field id="routine-time" ariaLabel="Time" value={timeText} placeholder="HH:MM" onChange={(e) => commitTime(e.target.value)} />
    </div>
  );

  return (
    <Modal size="lg" tall padded={false} open={open} onDismiss={onClose} label={editing ? "Edit routine" : "New routine"}>
      <div className="manta-routines-editor flex min-h-0 flex-1 flex-col">
        <RoutineModalHeader title={editing ? "Edit routine" : "New routine"} onClose={onClose} />
        <RoutineModalBody>
          <div>
            <Field
              id="routine-name"
              label="Name"
              mono={false}
              value={draft.name}
              placeholder="Daily analytics digest"
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={() => touch("name")}
            />
            {err("name") && <div className="mt-1 text-meta text-danger">{err("name")}</div>}
          </div>
          <div>
            <Field
              id="routine-prompt"
              label="What should it do each time?"
              multiline
              rows={4}
              mono={false}
              value={draft.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              onBlur={() => touch("prompt")}
              help="Write it for someone starting fresh each time. Tip: try it once in a normal chat first."
            />
            {err("prompt") && <div className="mt-1 text-meta text-danger">{err("prompt")}</div>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LabelledBlock label="Folder" error={err("directory")}>
              <PickerButton
                icon={<Folder size={14} aria-hidden />}
                text={draft.directory ? tildePath(draft.directory) : "Choose a folder…"}
                mono
                label="Folder"
                onClick={() => setFolderOpen(true)}
              />
            </LabelledBlock>
            <LabelledBlock label="Model">
              <PickerButton
                icon={<Sparkles size={14} aria-hidden />}
                text={modelText}
                label="Model"
                buttonRef={modelBtnRef}
                onClick={() => setModelOpen((v) => !v)}
              />
            </LabelledBlock>
          </div>
          <LabelledBlock label="When" error={err("schedule")} help={scheduleHelp(cron, tz, nowMs())}>
            <div className="flex flex-col gap-3">
              <ChipGroup<ScheduleKind> label="Schedule" value={sched.kind} options={SCHEDULE_KINDS} onChange={setKind} />
              {sched.kind === "weekly" && (
                <div className="flex items-center gap-3">
                  <div className="inline-flex flex-wrap gap-2">
                    {WEEK_DAYS.map((d) => (
                      <Chip key={d.n} on={dow(d.n)} pressed={dow(d.n)} onClick={() => toggleDay(d.n)}>
                        {d.label}
                      </Chip>
                    ))}
                  </div>
                  {timeField}
                </div>
              )}
              {(sched.kind === "daily" || sched.kind === "weekdays") && <div className="flex items-center gap-3">{timeField}</div>}
              {sched.kind === "monthly" && (
                <div className="flex items-center gap-3">
                  <div className="w-24">
                    <Field
                      id="routine-dom"
                      ariaLabel="Day of month"
                      type="number"
                      min={1}
                      max={31}
                      value={String(sched.dom)}
                      onChange={(e) => setSched({ dom: Number(e.target.value) || 0 })}
                    />
                  </div>
                  {timeField}
                </div>
              )}
              {sched.kind === "hourly" && (
                <div className="flex items-center gap-2 text-label text-text-faint">
                  at :
                  <div className="w-24">
                    <Field
                      id="routine-minute"
                      ariaLabel="Minute"
                      type="number"
                      min={0}
                      max={59}
                      value={String(sched.minute)}
                      onChange={(e) => setSched({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                    />
                  </div>
                </div>
              )}
              {sched.kind === "custom" && (
                <Field
                  id="routine-cron"
                  ariaLabel="Cron"
                  value={sched.cron}
                  placeholder="0 9 * * 1-5"
                  onChange={(e) => setSched({ cron: e.target.value })}
                  help={errors.schedule ? undefined : cadenceText(sched.cron)}
                />
              )}
              {timeBad && <div className="text-meta text-danger">Time must look like 09:00</div>}
            </div>
          </LabelledBlock>
          <LabelledBlock label="What it's allowed to do">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Access">
              <RadioCard
                selected={draft.access === "read"}
                title="Read and report"
                sub="Can read files, run commands and use your connectors. Its edit tools are off; commands still run in your folder."
                onSelect={() => patch({ access: "read" })}
              />
              <RadioCard
                selected={draft.access === "edit"}
                title="Make changes"
                sub="Works on its own branch each run and can open a draft PR."
                onSelect={() => patch({ access: "edit" })}
              />
            </div>
          </LabelledBlock>
          <LabelledBlock label="Tell me">
            <ChipGroup label="Notify" value={draft.notify} options={NOTIFY_OPTIONS} onChange={(notify) => patch({ notify })} />
          </LabelledBlock>
          <Callout tone="info" size="note">
            <span className="mr-1 inline-flex align-middle">
              <NotebookText size={13} aria-hidden />
            </span>{" "}
            Each run starts fresh but reads <b className="font-semibold text-text">what the routine remembers</b> from earlier runs, then
            updates it. You can read and edit that on the routine's page.
          </Callout>
        </RoutineModalBody>
        <RoutineModalFooter>
          <Button tone="default" loading={busy === "test"} disabled={busy === "save"} onClick={() => void onTest()}>
            <Play size={14} aria-hidden />
            Test run now
          </Button>
          <span className="ml-auto" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" loading={busy === "save"} disabled={!valid || timeBad || busy === "test"} onClick={() => void onSave()}>
            {editing ? "Save" : "Create routine"}
          </Button>
        </RoutineModalFooter>
      </div>
      <FolderPickerModal
        open={folderOpen}
        initialPath={draft.directory || "~"}
        onSelect={(p) => {
          patch({ directory: p });
          touch("directory");
          setFolderOpen(false);
        }}
        onCancel={() => setFolderOpen(false)}
      />
      {modelOpen && (
        <ModelMenu
          open={modelOpen}
          anchorRef={modelBtnRef as React.RefObject<HTMLElement>}
          groups={groups}
          modelOverride={draft.model}
          defaultModel={null}
          defaultRow={{ label: "Default", sub: "Whatever opencode picks" }}
          onSelect={(m) => {
            patch({ model: m });
            setModelOpen(false);
          }}
          onClose={() => setModelOpen(false)}
        />
      )}
    </Modal>
  );
}
