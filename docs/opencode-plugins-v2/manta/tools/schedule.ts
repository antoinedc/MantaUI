// V2 twin of docs/opencode-tools/schedule.ts → schedule_create / schedule_list /
// schedule_cancel. Thin registrars: manta-server owns the durable store + the
// firing loop (src/server/schedule.mjs); execute() returns promptly.

import { call } from "../lib/server.ts";
import { bool, input, noInput, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "schedule_create",
    description: [
      "Schedule a prompt to run later in THIS chat session — once or on a",
      "recurring interval. Use when the user asks you to do something later or",
      "repeatedly, e.g. 'check the deploy every 5 minutes', 'remind me in 45",
      "minutes to push', 'every weekday at 9am summarize open PRs'. Convert the",
      "user's natural-language timing into a standard 5-field cron expression",
      "yourself (minute hour day-of-month month day-of-week, local time). When",
      "the scheduled time arrives, your prompt runs as a fresh turn in this same",
      "session automatically. Set recurring=false for a one-time reminder.",
    ].join(" "),
    input: input(
      {
        cron: str(
          "5-field cron expression in LOCAL time: 'minute hour day-of-month month day-of-week'. " +
            "Examples: '*/5 * * * *' = every 5 min; '0 9 * * 1-5' = weekdays 9am; " +
            "'30 14 15 3 *' = March 15 2:30pm. Supports * / ranges (1-5) and lists (0,15,30). " +
            "Sunday is 0 or 7.",
        ),
        prompt: str("The prompt to run when the schedule fires."),
        recurring: bool("true = repeat on the cron schedule; false = fire once then delete."),
        label: str("Short human label shown in the user's schedule list, e.g. 'deploy check'."),
      },
      ["label"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/schedule", {
        cron: args.cron,
        prompt: args.prompt,
        recurring: args.recurring,
        label: args.label ?? "",
        sessionID: context.sessionID,
        directory: context.directory,
      });
      const when = args.recurring ? `recurring (${args.cron})` : `once (${args.cron})`;
      return `Scheduled ${when}. Job id ${result.id}. It will run in this session automatically.`;
    },
  },
  {
    name: "schedule_list",
    description:
      "List the scheduled tasks for THIS chat session (id, cron, prompt, recurring). " +
      "Use when the user asks 'what's scheduled?' or before cancelling one.",
    input: noInput(),
    async execute(_args, context) {
      const result = await call(
        "GET",
        `/api/schedule?sessionID=${encodeURIComponent(context.sessionID)}`,
      );
      const jobs = result.jobs ?? [];
      if (jobs.length === 0) return "No scheduled tasks in this session.";
      return jobs
        .map(
          (j: any) =>
            `• [${j.id}] ${j.label || j.prompt} — ${j.cron}${j.recurring ? " (recurring)" : " (once)"}`,
        )
        .join("\n");
    },
  },
  {
    name: "schedule_cancel",
    description:
      "Cancel a scheduled task by its job id. Get ids from the schedule_list tool " +
      "or the id returned when the task was created.",
    input: input({ id: str("The 8-character job id to cancel.") }),
    async execute(args) {
      const result = await call("DELETE", `/api/schedule?id=${encodeURIComponent(args.id)}`);
      return result.deleted ? `Cancelled scheduled task ${args.id}.` : `No task with id ${args.id}.`;
    },
  },
];
