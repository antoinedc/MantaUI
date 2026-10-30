// ===== Routines — pure view helpers =====
//
// Everything the Routines screens decide, with no React and no I/O: relative /
// absolute time labels, the outcome → Pill map, cadence wording, the editor's
// schedule ⇄ cron round trip (spec §7), and small formatters. The components
// (RoutinesPane, RoutineDetail, RoutineRunView, RoutineEditor, …) only wire
// these to the DOM and the box. Every function takes `now` explicitly so a test
// (and the demo's pinned clock) controls it. Times are box-local; the renderer
// formats with the local Date, which is the same zone the box cron runs in.

import {
  Bug,
  BookOpen,
  CalendarClock,
  ChartLine,
  Package,
  Shield,
  Tag as TagIcon,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  Routine,
  RoutineIcon,
  RoutineInput,
  RoutineNotify,
  RoutineRun,
  RunStatus,
  RunTrigger,
} from "../shared/routines";
import { describeCron, nextCronRun } from "./chatUtils";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export const ROUTINE_ICONS: Record<RoutineIcon, LucideIcon> = {
  "calendar-clock": CalendarClock,
  chart: ChartLine,
  bug: Bug,
  alert: TriangleAlert,
  package: Package,
  book: BookOpen,
  tag: TagIcon,
  shield: Shield,
};

/** The glyph for a routine icon name; an unknown name falls back to the default. */
export function routineIcon(name: string | null | undefined): LucideIcon {
  return (name && (ROUTINE_ICONS as Record<string, LucideIcon>)[name]) || CalendarClock;
}

// ---------------------------------------------------------------------------
// Time labels
// ---------------------------------------------------------------------------

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DOW_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;
const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** "9:04", "14:09" — 24h, hour unpadded (the mockup's clock style). */
export function clockHM(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `now`'s day to `ms`'s day (negative = past). */
export function calendarDaysFrom(now: number, ms: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
}

/**
 * The "Next" column: same day → `H:MM`; tomorrow → `Tomorrow H:MM`; within the
 * next 6 days → `Ddd H:MM`; later → `Ddd D Mmm`. null → "—".
 */
export function nextLabel(ms: number | null | undefined, now: number): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const days = calendarDaysFrom(now, ms);
  if (days <= 0) return clockHM(ms);
  if (days === 1) return `Tomorrow ${clockHM(ms)}`;
  if (days <= 6) return `${DOW_SHORT[d.getDay()]} ${clockHM(ms)}`;
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
}

/** The hero's "Next run" phrase: "today at 11:00", "tomorrow at 9:00", "Fri 7 Nov at 9:00". */
export function nextRunPhrase(ms: number | null | undefined, now: number): string {
  if (ms == null) return "not scheduled";
  const days = calendarDaysFrom(now, ms);
  if (days <= 0) return `today at ${clockHM(ms)}`;
  if (days === 1) return `tomorrow at ${clockHM(ms)}`;
  const d = new Date(ms);
  if (days <= 6) return `${DOW_SHORT[d.getDay()]} at ${clockHM(ms)}`;
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]} at ${clockHM(ms)}`;
}

/** "Today 9:04" when `ms` is today, else "Fri 14:09" (weekday within a week), else "24 Oct". */
export function whenLabel(ms: number, now: number): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return `Today ${clockHM(ms)}`;
  const days = -calendarDaysFrom(now, ms);
  if (days > 0 && days <= 6) return `${DOW_SHORT[d.getDay()]} ${clockHM(ms)}`;
  return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
}

/** The time column of a findings row: `9:04` today, `Fri` this week, `24 Oct` older. */
export function inboxTimeLabel(ms: number, now: number): string {
  const d = new Date(ms);
  if (sameDay(d, new Date(now))) return clockHM(ms);
  const days = -calendarDaysFrom(now, ms);
  if (days > 0 && days <= 6) return DOW_SHORT[d.getDay()];
  return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
}

/** The run row's two-line date: `{day:"Thu 30", time:"9:02"}`. */
export function runDateParts(ms: number): { day: string; time: string } {
  const d = new Date(ms);
  return { day: `${DOW_SHORT[d.getDay()]} ${d.getDate()}`, time: clockHM(ms) };
}

/** The run view's crumb: "Thu 30 Oct · 9:02". */
export function runCrumbLabel(ms: number): string {
  const d = new Date(ms);
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]} · ${clockHM(ms)}`;
}

/** "12m", "3m", "52s", "2h" — the compact age, no "ago". */
export function agoText(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "2m 14s", "0m 52s" — elapsed / duration with a padded seconds field. */
export function runDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${pad2(s)}s`;
}

/** Elapsed since a run started (live while running); null before it started. */
export function runElapsed(run: Pick<RoutineRun, "startedAt" | "endedAt">, now: number): string | null {
  if (run.startedAt == null) return null;
  return runDuration((run.endedAt ?? now) - run.startedAt);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** The project label of a routine / run: the box's `projectName`, else the folder's basename. */
export function projectLabel(r: { projectName: string | null; directory?: string }): string {
  return r.projectName ?? (r.directory ? basename(r.directory) : "");
}

/** "~/projects/ronda" for an absolute path under `home`; otherwise the path unchanged. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

// ---------------------------------------------------------------------------
// Outcome pill
// ---------------------------------------------------------------------------

export type PillTone = "neutral" | "accent" | "warn" | "ok" | "danger";
export type DotTone = "ok" | "running" | "error" | "warn" | "idle" | "accent";

export interface OutcomeView {
  tone: PillTone;
  border: boolean;
  dot: DotTone | null;
  label: string;
}

/** Contract R1.4 outcome map. `waitingPos` is the 1-based place in line of a queued run. */
export function outcomeView(run: Pick<RoutineRun, "status" | "report">, waitingPos?: number | null): OutcomeView {
  switch (run.status) {
    case "done":
      return run.report?.outcome === "nothing"
        ? { tone: "neutral", border: true, dot: null, label: "Nothing new" }
        : run.report
          ? { tone: "accent", border: false, dot: "accent", label: "Findings" }
          : { tone: "neutral", border: true, dot: null, label: "Done" };
    case "running":
      return { tone: "accent", border: false, dot: "running", label: "Running" };
    case "queued":
      return { tone: "warn", border: false, dot: "warn", label: waitingPos ? `Queued · #${waitingPos}` : "Queued" };
    case "needs_input":
      return { tone: "danger", border: false, dot: "error", label: "Needs you" };
    case "failed":
      return { tone: "danger", border: false, dot: "error", label: "Failed" };
    case "timed_out":
      return { tone: "neutral", border: true, dot: null, label: "Timed out" };
    case "cancelled":
      return { tone: "neutral", border: true, dot: null, label: "Stopped" };
    case "skipped":
    default:
      return { tone: "neutral", border: true, dot: null, label: "Skipped" };
  }
}

/** The "In a chat" pill the routines table shows for a routine moved into a chat. */
export const IN_A_CHAT: OutcomeView = { tone: "neutral", border: true, dot: null, label: "In a chat" };

export function isTerminal(status: RunStatus): boolean {
  return status === "done" || status === "failed" || status === "timed_out" || status === "cancelled" || status === "skipped";
}

/** The sub-line under the outcome pill in the routines table. */
export function lastRunDetail(run: RoutineRun, now: number): string {
  const at = run.endedAt ?? run.startedAt ?? run.queuedAt;
  switch (run.status) {
    case "needs_input":
      return `Waiting for your answer · ${agoText(run.startedAt ?? run.queuedAt, now)}`;
    case "running": {
      const ago = agoText(run.startedAt ?? run.queuedAt, now);
      return run.trigger === "manual" ? `You pressed Run now · ${ago} ago` : `Started ${ago} ago`;
    }
    case "queued":
      return run.trigger === "manual"
        ? `You pressed Run now · queued ${clockHM(run.queuedAt)}`
        : `Waiting since ${clockHM(run.queuedAt)}`;
    case "failed":
    case "timed_out":
      return [whenLabel(at, now), run.error].filter(Boolean).join(" · ");
    case "cancelled":
    case "skipped":
      return whenLabel(at, now);
    default: {
      const dur = run.startedAt != null && run.endedAt != null ? runDuration(run.endedAt - run.startedAt) : null;
      // A catch-up run says so instead of its duration (the run row carries the full note).
      return run.trigger === "catch_up" ? `${whenLabel(at, now)} · caught up` : [whenLabel(at, now), dur].filter(Boolean).join(" · ");
    }
  }
}

/** The title of a run row: the report's title, else the failure / status sentence. */
export function runTitle(run: RoutineRun): string {
  if (run.report?.title) return run.report.title;
  if (run.error) return run.error;
  if (run.status === "needs_input" && run.question) return run.question;
  return outcomeView(run).label;
}

/** The note under a run title: the report summary line is for findings; notes carry waits / catch-ups. */
export function runNote(run: RoutineRun): string {
  if (run.notes.length > 0) return run.notes.join(" · ");
  if (run.report?.outcome === "findings" && run.report.summary) return run.report.summary;
  return "";
}

export function triggerLabel(t: RunTrigger): string {
  switch (t) {
    case "manual":
      return "Manual run";
    case "catch_up":
      return "Catch-up run";
    case "ai":
      return "Webhook run";
    default:
      return "Scheduled run";
  }
}

export function notifyLabel(n: RoutineNotify): string {
  switch (n) {
    case "always":
      return "Notify on every run";
    case "failures":
      return "Notify only on failure";
    case "never":
      return "Never notify";
    default:
      return "Notify on findings";
  }
}

export const NOTIFY_OPTIONS: { value: RoutineNotify; label: string }[] = [
  { value: "findings", label: "When it finds something" },
  { value: "always", label: "Every run" },
  { value: "failures", label: "Only if it fails" },
  { value: "never", label: "Never" },
];

export function tellMeLabel(n: RoutineNotify): string {
  return NOTIFY_OPTIONS.find((o) => o.value === n)?.label ?? "When it finds something";
}

/** The access line under the cadence in the table. */
export function accessLine(r: Pick<Routine, "access" | "notify">): string {
  const base = r.access === "edit" ? "Can make changes · own branch" : "Read-only";
  const notify =
    r.notify === "failures"
      ? "tells you only on failure"
      : r.notify === "always"
        ? "tells you on every run"
        : r.notify === "never"
          ? "never tells you"
          : null;
  return notify ? `${base} · ${notify}` : base;
}

/** "N lines" of a memory text (blank lines don't count). */
export function memoryLineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

// ---------------------------------------------------------------------------
// Schedule (editor) ⇄ cron  — spec §7
// ---------------------------------------------------------------------------

export type ScheduleKind = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface Schedule {
  kind: ScheduleKind;
  minute: number;
  hour: number;
  /** Weekly: days of the week, Sunday = 0. */
  days: number[];
  /** Monthly: day of the month. */
  dom: number;
  /** Custom: the raw 5-field cron. */
  cron: string;
}

export const SCHEDULE_KINDS: { value: ScheduleKind; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

/** Weekly day toggles in display order (Mon..Sun) with their cron number. */
export const WEEK_DAYS: { label: string; n: number }[] = [
  { label: "Mon", n: 1 },
  { label: "Tue", n: 2 },
  { label: "Wed", n: 3 },
  { label: "Thu", n: 4 },
  { label: "Fri", n: 5 },
  { label: "Sat", n: 6 },
  { label: "Sun", n: 0 },
];

export const DEFAULT_SCHEDULE: Schedule = { kind: "daily", minute: 0, hour: 9, days: [1], dom: 1, cron: "0 9 * * *" };

/** The cron a schedule means. `custom` returns its raw text untouched. */
export function scheduleToCron(s: Schedule): string {
  const days = [...new Set(s.days)].sort((a, b) => a - b).join(",");
  switch (s.kind) {
    case "hourly":
      return `${s.minute} * * * *`;
    case "daily":
      return `${s.minute} ${s.hour} * * *`;
    case "weekdays":
      return `${s.minute} ${s.hour} * * 1-5`;
    case "weekly":
      return `${s.minute} ${s.hour} * * ${days}`;
    case "monthly":
      return `${s.minute} ${s.hour} ${s.dom} * *`;
    default:
      return s.cron.trim();
  }
}

const canonNum = (s: string, lo: number, hi: number): number | null => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return String(n) === s && n >= lo && n <= hi ? n : null;
};

/** Map a cron back to the richest preset that reproduces it EXACTLY, else Custom. */
export function cronToSchedule(cron: string): Schedule {
  const raw = (cron ?? "").trim();
  const custom: Schedule = { ...DEFAULT_SCHEDULE, kind: "custom", cron: raw };
  const f = raw.split(/\s+/);
  if (f.length !== 5) return custom;
  const [mi, ho, dom, mon, dow] = f;
  const minute = canonNum(mi, 0, 59);
  if (minute == null || mon !== "*") return custom;
  if (ho === "*" && dom === "*" && dow === "*") return { ...DEFAULT_SCHEDULE, kind: "hourly", minute, cron: raw };
  const hour = canonNum(ho, 0, 23);
  if (hour == null) return custom;
  const base = { ...DEFAULT_SCHEDULE, minute, hour, cron: raw };
  if (dom === "*" && dow === "*") return { ...base, kind: "daily" };
  if (dom === "*" && dow === "1-5") return { ...base, kind: "weekdays" };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(",").map(Number);
    const canonical = days.every((d, i) => i === 0 || d > days[i - 1]);
    if (canonical) return { ...base, kind: "weekly", days };
  }
  if (dow === "*") {
    const d = canonNum(dom, 1, 31);
    if (d != null) return { ...base, kind: "monthly", dom: d };
  }
  return custom;
}

/** "9:05" / "09:05" → {hour, minute}; null when it is not a valid time. */
export function parseTimeInput(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function formatTimeInput(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** A validation sentence for a schedule, or null when it is fine. */
export function scheduleError(s: Schedule): string | null {
  switch (s.kind) {
    case "hourly":
      return s.minute >= 0 && s.minute <= 59 ? null : "Minute must be 0–59";
    case "weekly":
      return s.days.length === 0 ? "Pick at least one day" : null;
    case "monthly":
      return s.dom >= 1 && s.dom <= 31 ? null : "Day of month must be 1–31";
    case "custom": {
      const f = s.cron.trim().split(/\s+/);
      if (f.length !== 5) return "A cron has five fields: minute hour day month weekday";
      return nextCronRun(s.cron) == null ? "That cron never fires" : null;
    }
    default:
      return null;
  }
}

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = ["th", "st", "nd", "rd"];
  return suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0];
}

/**
 * Cadence wording. `style: "dot"` → "Weekdays · 9:00" (tables, cards);
 * `style: "at"` → "Weekdays at 9:00" (hero chip). Presets are worded from the
 * schedule model; anything else falls back to the existing `describeCron`.
 */
export function cadenceText(cron: string, style: "dot" | "at" = "dot"): string {
  const s = cronToSchedule(cron);
  const sep = style === "dot" ? " · " : " at ";
  const t = `${s.hour}:${pad2(s.minute)}`;
  switch (s.kind) {
    case "hourly":
      return s.minute === 0 ? "Hourly" : `Hourly at :${pad2(s.minute)}`;
    case "daily":
      return `Daily${sep}${t}`;
    case "weekdays":
      return `Weekdays${sep}${t}`;
    case "weekly": {
      const names =
        s.days.length === 1
          ? DOW_PLURAL[s.days[0]]
          : [...s.days]
              .sort((a, b) => (a || 7) - (b || 7))
              .map((d) => DOW_SHORT[d])
              .join(", ");
      return `${names}${sep}${t}`;
    }
    case "monthly":
      return `Monthly on the ${s.dom}${ordinal(s.dom)}${sep}${t}`;
    default:
      return describeCron(cron);
  }
}

/** "box time · Europe/Paris · first run Mon 3 Nov" — the editor's help line. */
export function scheduleHelp(cron: string, tz: string, now: number): string {
  const next = nextCronRun(cron, now);
  const first = next == null ? "" : ` · first run ${nextLabelLong(next, now)}`;
  return `box time · ${tz}${first}`;
}

function nextLabelLong(ms: number, now: number): string {
  const d = new Date(ms);
  const days = calendarDaysFrom(now, ms);
  if (days <= 0) return `today ${clockHM(ms)}`;
  if (days === 1) return `tomorrow ${clockHM(ms)}`;
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
}

// ---------------------------------------------------------------------------
// Editor draft
// ---------------------------------------------------------------------------

export interface RoutineDraft {
  name: string;
  prompt: string;
  icon: RoutineIcon;
  directory: string;
  model: Routine["model"];
  schedule: Schedule;
  access: Routine["access"];
  notify: RoutineNotify;
}

export function emptyDraft(directory = ""): RoutineDraft {
  return {
    name: "",
    prompt: "",
    icon: "calendar-clock",
    directory,
    model: null,
    schedule: { ...DEFAULT_SCHEDULE },
    access: "read",
    notify: "findings",
  };
}

export function draftFromRoutine(r: Routine): RoutineDraft {
  return {
    name: r.name,
    prompt: r.prompt,
    icon: r.icon,
    directory: r.directory,
    model: r.model,
    schedule: cronToSchedule(r.cron),
    access: r.access,
    notify: r.notify,
  };
}

export type DraftErrors = Partial<Record<"name" | "prompt" | "directory" | "schedule", string>>;

export function draftErrors(d: RoutineDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = "Give it a name";
  else if (d.name.trim().length > 80) e.name = "At most 80 characters";
  if (!d.prompt.trim()) e.prompt = "Say what it should do each time";
  else if (d.prompt.trim().length > 8000) e.prompt = "At most 8000 characters";
  if (!d.directory.trim()) e.directory = "Pick a folder";
  const se = scheduleError(d.schedule);
  if (se) e.schedule = se;
  return e;
}

/** Create / Save are enabled only when every field is valid. */
export function canSaveDraft(d: RoutineDraft): boolean {
  return Object.keys(draftErrors(d)).length === 0;
}

export function draftToInput(d: RoutineDraft): RoutineInput {
  return {
    name: d.name.trim(),
    prompt: d.prompt.trim(),
    icon: d.icon,
    directory: d.directory.trim(),
    cron: scheduleToCron(d.schedule),
    access: d.access,
    model: d.model,
    notify: d.notify,
  };
}

// ---------------------------------------------------------------------------
// Memory + instruction rendering
// ---------------------------------------------------------------------------

export interface MemoryLine {
  text: string;
  kind: "heading" | "added" | "plain";
}

/** Split a memory note into lines tagged heading / added-by-the-last-run / plain. */
export function memoryLines(memory: string, added: readonly string[] | null | undefined): MemoryLine[] {
  const addedSet = new Set((added ?? []).map((l) => l.trim()).filter(Boolean));
  return memory.split("\n").map((text) => ({
    text,
    kind: text.startsWith("## ") ? "heading" : addedSet.has(text.trim()) ? "added" : "plain",
  }));
}

export type InstructionPart = { kind: "text"; text: string } | { kind: "skill"; text: string };

/** Split instructions into plain text and `$skill` tokens (rendered as chips). */
export function splitInstructions(text: string): InstructionPart[] {
  const out: InstructionPart[] = [];
  const re = /\$[A-Za-z][\w-]*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: text.slice(last, i) });
    out.push({ kind: "skill", text: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** The seed for "Fix it in a new session" (spec §6.5). */
export function fixItSeed(routineName: string, run: RoutineRun): string {
  const when = run.startedAt ?? run.queuedAt;
  const d = new Date(when);
  const date = `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
  const r = run.report;
  return `Follow up on routine "${routineName}" run of ${date}:\n\n${r?.title ?? ""}\n${r?.body ?? ""}`.trimEnd();
}

/** "today" / "tomorrow" / "Fri 7 Nov" — the day word of an instant (created-card "first run …"). */
export function nextDayWord(ms: number | null | undefined, now: number): string {
  if (ms == null) return "not scheduled";
  const days = calendarDaysFrom(now, ms);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  const d = new Date(ms);
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
}
