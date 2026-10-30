// Routines — recurring work whose every run starts a fresh headless session
// (docs/superpowers/specs/2026-10-30-routines-design.md §5.3). Thin registrars:
// manta-server owns the durable store, the queue and the runs (src/server/routines.mjs);
// execute() returns promptly. `routine_report` is only meaningful inside a routine run.

import { call } from "../lib/server.ts";
import { bool, input, noInput, oneOf, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

const ICONS = ["calendar-clock", "chart", "bug", "alert", "package", "book", "tag", "shield"];

const when = (ms: unknown): string =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toLocaleString() : "not scheduled";

export const tools: ToolDef[] = [
  {
    name: "routine_create",
    description: [
      "Create a ROUTINE: recurring work that starts a brand-new, independent session each time it",
      "runs and reports back (daily reports, weekly triage, 'every weekday at 9 summarize analytics').",
      "Use it when the user wants recurring work whose runs should NOT depend on this conversation.",
      "Use `schedule_create` instead for check-ins that must continue THIS conversation (deploy",
      "polling, reminders). Convert the user's timing into a 5-field cron expression in the box's",
      "LOCAL time (minute hour day-of-month month day-of-week). The minimum interval is 15 minutes;",
      "faster checks belong in a follow-up (`schedule_create`). Write `prompt` for someone starting",
      "fresh each time: spell out what to look at and what to report. `memory` is what this",
      "conversation already established (baselines, names, conventions) so the first run starts",
      "informed; every run reads the routine's memory and updates it. access 'read' (default) blocks",
      "file edits; 'edit' lets each run work on its own git branch.",
    ].join(" "),
    input: input(
      {
        name: str("Short name, up to 80 characters, e.g. 'Daily analytics digest'."),
        prompt: str("What to do on every run, written to stand alone (a fresh session cannot see this chat)."),
        cron: str(
          "5-field cron in the box's LOCAL time, e.g. '0 9 * * 1-5' = weekdays 9am. At most one run every 15 minutes.",
        ),
        access: oneOf(["read", "edit"], "read (default): file edits blocked. edit: works on its own git branch each run."),
        notify: oneOf(
          ["findings", "always", "failures", "never"],
          "When to notify the user: findings (default), always, failures, never.",
        ),
        icon: oneOf(ICONS, "Glyph shown on the Routines page (default calendar-clock)."),
        memory: str("Facts from this conversation the first run should start knowing (baselines, conventions). Under 60 lines."),
      },
      ["access", "notify", "icon", "memory"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/routines", {
        name: args.name,
        prompt: args.prompt,
        cron: args.cron,
        ...(args.access ? { access: args.access } : {}),
        ...(args.notify ? { notify: args.notify } : {}),
        ...(args.icon ? { icon: args.icon } : {}),
        ...(args.memory ? { memory: args.memory } : {}),
        sessionID: context.sessionID,
        directory: context.directory,
      });
      const r = result.routine;
      return `Routine "${r.name}" created. Id ${r.id}. Runs ${r.cron} (box time). Next run: ${when(r.nextRunAt)}. It starts a fresh session each time; results appear on the Routines page.`;
    },
  },
  {
    name: "routine_list",
    description: "List the user's routines (id, name, schedule, enabled, next run, last result).",
    input: noInput(),
    async execute() {
      const result = await call("GET", "/api/routines");
      const rows = result.routines ?? [];
      if (rows.length === 0) return "No routines yet.";
      return rows
        .map((r: any) => {
          const last = r.lastRun ? `${r.lastRun.status}${r.lastRun.title ? ` — ${r.lastRun.title}` : ""}` : "never run";
          return `• [${r.id}] ${r.name} — ${r.cron}${r.enabled ? "" : " (paused)"} · next ${when(r.nextRunAt)} · last: ${last}`;
        })
        .join("\n");
    },
  },
  {
    name: "routine_update",
    description:
      "Change a routine (name, prompt, schedule, access, notification policy, icon) or pause/resume it with " +
      "enabled. Get the id from routine_list or from routine_create.",
    input: input(
      {
        id: str("The routine id (8 hex characters)."),
        name: str("New name."),
        prompt: str("New instructions."),
        cron: str("New 5-field cron in the box's LOCAL time (at most one run every 15 minutes)."),
        access: oneOf(["read", "edit"], "read or edit."),
        notify: oneOf(["findings", "always", "failures", "never"], "When to notify the user."),
        icon: oneOf(ICONS, "Glyph shown on the Routines page."),
        enabled: bool("false pauses the routine, true resumes it."),
      },
      ["name", "prompt", "cron", "access", "notify", "icon", "enabled"],
    ),
    async execute(args) {
      const { id, ...patch } = args;
      const result = await call("PATCH", `/api/routines/${encodeURIComponent(id)}`, patch);
      const r = result.routine;
      return `Routine "${r.name}" updated. ${r.enabled ? `Runs ${r.cron} (box time); next run ${when(r.nextRunAt)}.` : "It is paused."}`;
    },
  },
  {
    name: "routine_run",
    description:
      "Run a routine now (it joins the queue and starts when a slot is free). If one is already waiting it is not queued twice.",
    input: input({ id: str("The routine id.") }),
    async execute(args) {
      const result = await call("POST", `/api/routines/${encodeURIComponent(args.id)}/run`);
      return result.alreadyQueued
        ? "That routine is already waiting in line."
        : `Run #${result.run?.seq ?? "?"} ${result.run?.status === "running" ? "started" : "queued"}. Its result will appear on the Routines page.`;
    },
  },
  {
    name: "routine_delete",
    description: "Delete a routine and its run history. Ask the user first unless they clearly asked for it.",
    input: input({ id: str("The routine id.") }),
    async execute(args) {
      const result = await call("DELETE", `/api/routines/${encodeURIComponent(args.id)}`);
      return result.deleted ? `Deleted routine ${args.id}.` : `No routine with id ${args.id}.`;
    },
  },
  {
    name: "routine_report",
    description:
      "ONLY inside a routine run: file the run's result. Call it exactly once, as your last action. " +
      "outcome 'findings' when something deserves the user's attention, otherwise 'nothing'. " +
      "`memory` is the COMPLETE updated notes for the next run (baselines, what you are watching, " +
      "what to ignore; under 60 lines); omit it to keep the notes unchanged.",
    input: input(
      {
        outcome: oneOf(["findings", "nothing"], "findings if anything deserves the user's attention, otherwise nothing."),
        title: str("One line, at most 160 characters."),
        summary: str("One or two sentences, at most 400 characters."),
        body: str("Optional markdown bullets with the details."),
        memory: str("The complete updated notes for the next run. Omit to keep them unchanged."),
      },
      ["body", "memory"],
    ),
    async execute(args, context) {
      await call("POST", "/api/routines/report", {
        sessionID: context.sessionID,
        outcome: args.outcome,
        title: args.title,
        summary: args.summary,
        ...(args.body ? { body: args.body } : {}),
        ...(typeof args.memory === "string" ? { memory: args.memory } : {}),
      });
      return "Report filed.";
    },
  },
];
