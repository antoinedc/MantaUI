// bui-native `schedule` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   ln -sf <repo>/docs/opencode-tools/schedule.ts ~/.config/opencode/tools/schedule.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/
// (NOT a `bui-opencode` tmux session — that reference elsewhere is stale).
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which owns the durable
// store and the firing loop (src/server/schedule.mjs). The tool does NOT sleep
// or run the prompt itself — execute() must return promptly.
//
// When a job is due, manta-server re-submits `prompt` into THIS session via
// opencode, so the scheduled work streams back into the user's open bui chat as
// a new turn. See docs/bui-tools-scheduler.md for the full design.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. MANTA_BOX_TOKEN env overrides for tests/dev.
function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8");
    const tok = JSON.parse(raw)?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null; // no store yet (auth disabled / first run) → send no header
  }
}

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MANTA_SERVER}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `manta-server ${res.status}`);
  }
  return json;
}

export const create = tool({
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
  args: {
    cron: z
      .string()
      .describe(
        "5-field cron expression in LOCAL time: 'minute hour day-of-month month day-of-week'. " +
          "Examples: '*/5 * * * *' = every 5 min; '0 9 * * 1-5' = weekdays 9am; " +
          "'30 14 15 3 *' = March 15 2:30pm. Supports * / ranges (1-5) and lists (0,15,30). " +
          "Sunday is 0 or 7.",
      ),
    prompt: z.string().describe("The prompt to run when the schedule fires."),
    recurring: z
      .boolean()
      .describe("true = repeat on the cron schedule; false = fire once then delete."),
    label: z
      .string()
      .optional()
      .describe("Short human label shown in the user's schedule list, e.g. 'deploy check'."),
  },
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
});

export const list = tool({
  description:
    "List the scheduled tasks for THIS chat session (id, cron, prompt, recurring). " +
    "Use when the user asks 'what's scheduled?' or before cancelling one.",
  args: {},
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
});

export const cancel = tool({
  description:
    "Cancel a scheduled task by its job id. Get ids from the schedule_list tool " +
    "or the id returned when the task was created.",
  args: {
    id: z.string().describe("The 8-character job id to cancel."),
  },
  async execute(args) {
    const result = await call("DELETE", `/api/schedule?id=${encodeURIComponent(args.id)}`);
    return result.deleted ? `Cancelled scheduled task ${args.id}.` : `No task with id ${args.id}.`;
  },
});
