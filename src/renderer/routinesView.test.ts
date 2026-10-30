import { describe, it, expect } from "vitest";
import type { RoutineRun } from "../shared/routines";
import {
  agoText,
  cadenceText,
  canSaveDraft,
  cronToSchedule,
  draftErrors,
  draftToInput,
  emptyDraft,
  inboxTimeLabel,
  lastRunDetail,
  memoryLines,
  nextLabel,
  nextRunPhrase,
  outcomeView,
  parseTimeInput,
  routineIcon,
  runDateParts,
  runDuration,
  runTitle,
  scheduleToCron,
  splitInstructions,
  whenLabel,
  accessLine,
} from "./routinesView";
import { CalendarClock, ChartLine } from "lucide-react";
import { routineIdOfToolPart, routineToolKind } from "./routineToolParts";

// Thu 30 Oct 2025 10:01 local — the demo's pinned clock.
const NOW = new Date(2025, 9, 30, 10, 1).getTime();
const at = (m: number, d: number, h: number, min: number) => new Date(2025, m - 1, d, h, min).getTime();

function run(over: Partial<RoutineRun>): RoutineRun {
  return {
    id: "r1",
    routineName: "x",
    projectName: null,
    routineId: "abcd1234",
    seq: 1,
    trigger: "scheduled",
    status: "done",
    queuedAt: at(10, 30, 9, 0),
    startedAt: at(10, 30, 9, 2),
    endedAt: at(10, 30, 9, 4) + 14_000,
    sessionID: "ses_1",
    worktree: null,
    report: null,
    error: null,
    notes: [],
    readAt: null,
    notifiedAt: null,
    keptInSidebar: false,
    memoryDiff: null,
    tokens: null,
    question: null,
    reprompted: false,
    reportCount: 0,
    memoryAtStart: "",
    ...over,
  };
}

describe("nextLabel — same day H:MM, Tomorrow, Ddd H:MM within 6 days, Ddd D Mmm later", () => {
  it("same day", () => expect(nextLabel(at(10, 30, 11, 0), NOW)).toBe("11:00"));
  it("tomorrow", () => {
    expect(nextLabel(at(10, 31, 9, 0), NOW)).toBe("Tomorrow 9:00");
    expect(nextLabel(at(10, 31, 7, 0), NOW)).toBe("Tomorrow 7:00");
  });
  it("within the next 6 days", () => {
    expect(nextLabel(at(11, 5, 8, 30), NOW)).toBe("Wed 8:30");
    expect(nextLabel(at(11, 1, 14, 0), NOW)).toBe("Sat 14:00");
  });
  it("later", () => expect(nextLabel(at(11, 6, 10, 0), NOW)).toBe("Thu 6 Nov"));
  it("null is a dash", () => expect(nextLabel(null, NOW)).toBe("—"));
  it("hero phrase", () => {
    expect(nextRunPhrase(at(10, 31, 9, 0), NOW)).toBe("tomorrow at 9:00");
    expect(nextRunPhrase(at(10, 30, 11, 0), NOW)).toBe("today at 11:00");
  });
});

describe("time labels", () => {
  it("whenLabel / inbox / run date", () => {
    expect(whenLabel(at(10, 30, 9, 4), NOW)).toBe("Today 9:04");
    expect(whenLabel(at(10, 24, 16, 0), NOW)).toBe("Fri 16:00");
    expect(inboxTimeLabel(at(10, 30, 9, 4), NOW)).toBe("9:04");
    expect(inboxTimeLabel(at(10, 24, 9, 4), NOW)).toBe("Fri");
    expect(inboxTimeLabel(at(10, 1, 9, 4), NOW)).toBe("1 Oct");
    expect(runDateParts(at(10, 30, 9, 2))).toEqual({ day: "Thu 30", time: "9:02" });
  });
  it("durations and ages", () => {
    expect(runDuration(134_000)).toBe("2m 14s");
    expect(runDuration(18_000)).toBe("0m 18s");
    expect(agoText(NOW - 52_000, NOW)).toBe("52s");
    expect(agoText(NOW - 12 * 60_000, NOW)).toBe("12m");
  });
});

describe("outcomeView", () => {
  it("maps every state", () => {
    expect(outcomeView(run({ report: { outcome: "findings", title: "", summary: "", body: "" } }))).toMatchObject({ tone: "accent", dot: "accent", label: "Findings" });
    expect(outcomeView(run({ report: { outcome: "nothing", title: "", summary: "", body: "" } }))).toMatchObject({ tone: "neutral", border: true, dot: null, label: "Nothing new" });
    expect(outcomeView(run({ status: "running" }))).toMatchObject({ tone: "accent", dot: "running" });
    expect(outcomeView(run({ status: "queued" }), 2)).toMatchObject({ tone: "warn", label: "Queued · #2" });
    expect(outcomeView(run({ status: "needs_input" }))).toMatchObject({ tone: "danger", dot: "error", label: "Needs you" });
    expect(outcomeView(run({ status: "failed" }))).toMatchObject({ tone: "danger", label: "Failed" });
    expect(outcomeView(run({ status: "cancelled" })).label).toBe("Stopped");
    expect(outcomeView(run({ status: "timed_out" })).label).toBe("Timed out");
    expect(outcomeView(run({ status: "skipped" })).label).toBe("Skipped");
  });
});

describe("lastRunDetail", () => {
  it("per status", () => {
    expect(lastRunDetail(run({}), NOW)).toBe("Today 9:04 · 2m 14s");
    expect(lastRunDetail(run({ trigger: "catch_up", endedAt: at(10, 30, 7, 2) + 60_000, startedAt: at(10, 30, 7, 2) }), NOW)).toBe("Today 7:03 · caught up");
    expect(lastRunDetail(run({ status: "needs_input", startedAt: NOW - 12 * 60_000, endedAt: null }), NOW)).toBe("Waiting for your answer · 12m");
    expect(lastRunDetail(run({ status: "running", trigger: "manual", startedAt: NOW - 3 * 60_000, endedAt: null }), NOW)).toBe("You pressed Run now · 3m ago");
    expect(lastRunDetail(run({ status: "running", startedAt: NOW - 52_000, endedAt: null }), NOW)).toBe("Started 52s ago");
    expect(lastRunDetail(run({ status: "failed", error: "GitHub token expired", endedAt: at(10, 24, 16, 0) }), NOW)).toBe("Fri 16:00 · GitHub token expired");
  });
});

describe("schedule ⇄ cron round trip", () => {
  const exact = ["15 * * * *", "0 9 * * *", "30 7 * * 1-5", "30 9 * * 4", "0 9 * * 1,3,5", "0 9 15 * *"];
  for (const cron of exact) {
    it(`${cron} maps to a preset and back`, () => {
      const s = cronToSchedule(cron);
      expect(s.kind).not.toBe("custom");
      expect(scheduleToCron(s)).toBe(cron);
    });
  }
  it("picks the richest preset", () => {
    expect(cronToSchedule("0 9 * * 1-5").kind).toBe("weekdays");
    expect(cronToSchedule("0 9 * * 4").kind).toBe("weekly");
    expect(cronToSchedule("0 * * * *")).toMatchObject({ kind: "hourly", minute: 0 });
    expect(cronToSchedule("0 9 1 * *")).toMatchObject({ kind: "monthly", dom: 1 });
  });
  it("anything that a preset cannot reproduce exactly is Custom", () => {
    for (const cron of ["*/15 * * * *", "0 9 * * 1-3", "0 9 * * 3,1", "00 9 * * *", "0 9 * 6 *", "0 9,17 * * *", "not a cron", "0 9 1 * 1"]) {
      const s = cronToSchedule(cron);
      expect(s.kind, cron).toBe("custom");
      expect(scheduleToCron(s), cron).toBe(cron);
    }
  });
  it("weekly days canonicalise ascending, Sunday first", () => {
    expect(scheduleToCron({ ...cronToSchedule("0 9 * * 1"), kind: "weekly", days: [6, 0, 1] })).toBe("0 9 * * 0,1,6");
  });
  it("parses and validates times", () => {
    expect(parseTimeInput("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("9:5")).toBeNull();
  });
});

describe("cadenceText", () => {
  it("dot style reproduces the mockup labels", () => {
    expect(cadenceText("0 9 * * 1-5")).toBe("Weekdays · 9:00");
    expect(cadenceText("30 9 * * 4")).toBe("Thursdays · 9:30");
    expect(cadenceText("0 7 * * *")).toBe("Daily · 7:00");
    expect(cadenceText("30 8 * * 3")).toBe("Wednesdays · 8:30");
    expect(cadenceText("0 14 * * 5")).toBe("Fridays · 14:00");
    expect(cadenceText("0 * * * *")).toBe("Hourly");
    expect(cadenceText("0 17 * * 5")).toBe("Fridays · 17:00");
  });
  it("at style for the hero chip; custom uses describeCron", () => {
    expect(cadenceText("0 9 * * 1-5", "at")).toBe("Weekdays at 9:00");
    expect(cadenceText("*/5 * * * *")).toBe("every 5 min");
    expect(cadenceText("0 9 * * 1,3", "at")).toBe("Mon, Wed at 9:00");
  });
});

describe("editor draft", () => {
  it("Create is disabled until name, instructions, folder and a valid schedule exist", () => {
    const d = emptyDraft();
    expect(canSaveDraft(d)).toBe(false);
    expect(Object.keys(draftErrors(d)).sort()).toEqual(["directory", "name", "prompt"]);
    const ok = { ...d, name: "n", prompt: "p", directory: "/home/x" };
    expect(canSaveDraft(ok)).toBe(true);
    expect(canSaveDraft({ ...ok, schedule: { ...ok.schedule, kind: "weekly", days: [] } })).toBe(false);
    expect(canSaveDraft({ ...ok, schedule: { ...ok.schedule, kind: "custom", cron: "* *" } })).toBe(false);
    expect(draftToInput(ok)).toMatchObject({ name: "n", cron: "0 9 * * *", access: "read", notify: "findings" });
  });
});

describe("memory + instructions", () => {
  it("tags headings and the lines the last run added", () => {
    const lines = memoryLines("## Watching\n- a\n  since Tue\n- old", ["- a", "since Tue"]);
    expect(lines.map((l) => l.kind)).toEqual(["heading", "added", "added", "plain"]);
  });
  it("splits $skill tokens", () => {
    expect(splitInstructions("Use $posthog-digest for yesterday.")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "skill", text: "$posthog-digest" },
      { kind: "text", text: " for yesterday." },
    ]);
  });
  it("access line", () => {
    expect(accessLine({ access: "read", notify: "findings" })).toBe("Read-only");
    expect(accessLine({ access: "read", notify: "failures" })).toBe("Read-only · tells you only on failure");
    expect(accessLine({ access: "edit", notify: "findings" })).toBe("Can make changes · own branch");
  });
});

describe("icons + routine tool parts", () => {
  it("icon lookup falls back to the default", () => {
    expect(routineIcon("chart")).toBe(ChartLine);
    expect(routineIcon("nope")).toBe(CalendarClock);
  });
  it("only a COMPLETED routine tool part becomes a card", () => {
    expect(routineToolKind({ type: "tool", tool: "routine_report", state: { status: "completed" } })).toBe("report");
    expect(routineToolKind({ type: "tool", tool: "manta_routine_create", state: { status: "completed" } })).toBe("create");
    expect(routineToolKind({ type: "tool", tool: "routine_update", state: { status: "running" } })).toBeNull();
    expect(routineToolKind({ type: "tool", tool: "bash", state: { status: "completed" } })).toBeNull();
    expect(routineToolKind({ type: "text" })).toBeNull();
  });
  it("recovers the routine id from metadata, output or input", () => {
    expect(routineIdOfToolPart({ state: { metadata: { routineId: "0a1b2c3d" } } })).toBe("0a1b2c3d");
    expect(routineIdOfToolPart({ state: { output: "Created routine \"X\" (id 4f5e6d7c). Next run: tomorrow 9:00" } })).toBe("4f5e6d7c");
    expect(routineIdOfToolPart({ state: { input: { id: "11223344" }, output: "Updated." } })).toBe("11223344");
    expect(routineIdOfToolPart({ state: { output: "no id here" } })).toBeNull();
  });
});

describe("runTitle", () => {
  it("never repeats the outcome pill: an in-progress or plain run has no title of its own", () => {
    expect(runTitle(run({ status: "running", endedAt: null }))).toBe("");
    expect(runTitle(run({ status: "queued", startedAt: null, endedAt: null }))).toBe("");
    expect(runTitle(run({ status: "done" }))).toBe("");
  });
  it("uses the report title, the error, or the question", () => {
    expect(runTitle(run({ report: { outcome: "findings", title: "Signups up", summary: "", body: "" } as never }))).toBe("Signups up");
    expect(runTitle(run({ status: "failed", error: "Session crashed" }))).toBe("Session crashed");
    expect(runTitle(run({ status: "needs_input", question: "Which env?" }))).toBe("Which env?");
  });
});
