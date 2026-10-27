// manta-native `delegate` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/delegate.ts ~/.config/opencode/tools/delegate.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It POSTs the request to manta-server
// (127.0.0.1:8787, same box — no SSH hop), which owns the background job
// engine (`src/server/delegate.mjs`): it creates a git worktree + a new
// chat-mode tmux window + opencode session, injects the prompt, detects
// completion from the opencode event stream, and delivers the result back to
// THIS (parent) session as a later message — WITHOUT blocking the current
// reply. execute() returns promptly; manta-server owns the lifecycle.
//
// This file is a COPY, never a symlink: opencode resolves a tool's imports
// relative to the file's REAL path, so a symlink back into the repo (no
// node_modules there) fails to resolve `@opencode-ai/plugin` and the tool
// silently never registers. Copy it into ~/.config/opencode/tools/.
//
// See docs/opencode-tools/AGENTS.md (## MantaUI background delegation) for the
// background-vs-blocking rule and the general "manta tools" pattern
// (docs/manta-tools-scheduler.md).

import { tool } from "@opencode-ai/plugin";
import { join } from "node:path";
import { boxToken, authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. MANTA_BOX_TOKEN env overrides for tests/dev.

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

export const delegate = tool({
  description: [
    "Run a piece of work in the background — in its own session, git worktree and",
    "branch — and get its result back automatically as a later message. This is",
    "THE way to hand work to another agent on this box: the user sees every job as",
    "a row in the sidebar and can open or stop it. Use it whenever the work",
    "doesn't block what you do next and it edits files: implementing a feature or",
    "fix, a refactor, a test-suite run-and-fix, an investigation that must not",
    "touch your checkout. Split independent pieces into parallel jobs (up to five",
    "at once); each one is a full model session, so don't start jobs whose result",
    "you won't use. Prefer it over driving opencode sessions yourself (scripts",
    "calling opencode's HTTP API, wait-for-idle scripts, sleep/poll loops, tmux):",
    "that work has no managed launch (no worktree, no permission scoping) and its",
    "result is never delivered to you — Manta can only show it. Use the built-in",
    "`task` tool instead when you need the",
    "answer before you can continue (foreground), or for read-only research",
    "(`background: true`). The job starts with NO knowledge of this conversation:",
    "put the goal, paths, constraints and what \"done\" looks like in the prompt.",
    "When a job of yours has finished and you want another round from the same",
    "worker (a fix round after review, the next milestone), use `delegate_send`",
    "with its id — it keeps the job's context, worktree and branch. This call",
    "returns IMMEDIATELY and you do NOT have the result yet — it arrives on its",
    "own; do not report or guess it before then, and do not poll. A background job",
    "cannot start background jobs of its own.",
  ].join(" "),
  args: {
    prompt: z
      .string()
      .describe(
        "The full task prompt for the background job. The job's session has no " +
          "knowledge of this conversation, so include everything it needs: the " +
          "goal, the relevant files/paths, constraints, and what 'done' looks like.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Optional model id for the job's session, as free text.\u200b " +
          "Naming a model is the OFF switch for automatic routing: the job " +
          "runs on EXACTLY this model and Auto never overrides it. It must be " +
          "a model you approved (ticked) for subagents on this box — an " +
          "unapproved / unknown value fails loudly naming the closest " +
          "candidates rather than silently picking a different model. " +
          "Omit to let Auto route the subagent on its own intent. " +
          "Not validated client-side.",
      ),
    subagent_type: z
      .string()
      .optional()
      .describe(
        "The subagent type / role for this background job, passed to the " +
          "router as the job's intent ('general', 'explore', 'build', 'plan', " +
          "or a custom named agent). Auto applies that agent's tier floor. " +
          "Omit to default to 'general'.",
      ),
    tools: z
      .array(
        z.object({
          permission: z
            .string()
            .describe(
              'The opencode permission category the job needs, e.g. "bash", ' +
                '"edit" (covers write/edit/apply_patch), "read" (covers ' +
                'read/glob/grep), "webfetch". A bash/edit/read grant with pattern ' +
                '"**" also lets the job reach files outside its worktree.',
            ),
          pattern: z
            .string()
            .describe(
              'A glob pattern scoping the grant, e.g. "pytest *", "**/*.ts", ' +
                '"/tmp/*". Matches the `patterns` field on a PermissionRequest.',
            ),
        }),
      )
      .optional()
      .describe(
        "The access the job needs, declared up front. When trust mode is OFF, " +
          "the user sees ONE approval card before the job starts (Start / Edit " +
          "access / Not now) listing exactly what it will be allowed to do; the " +
          "job then NEVER asks again. A catch-all deny is appended automatically " +
          "so any tool you did NOT declare is refused (not prompted). Declare " +
          "the minimum set: a job lacking a tool it needs FAILS its first " +
          "command instead of hanging. Omit when the job needs no tool access.",
      ),
  },
  async execute(args, context) {
    const res = await call("POST", "/api/delegate", {
      prompt: args.prompt,
      model: args.model,
      subagent_type: args.subagent_type,
      tools: args.tools,
      sessionID: context.sessionID,
      directory: context.directory,
    });
    const name = res?.job?.name ?? res?.name ?? "background";
    const id = res?.job?.id ?? res?.id ?? "";
    if (res && res.ok === false) {
      // The job was declined (user picked "Not now") or the approval timed out.
      // Surface the reason so the model does not retry blindly.
      return `Background job "${name}" was not started: ${res?.error ?? "declined"}.`;
    }
    return (
      `Started background job "${name}" (id ${id}). It runs in its own session and\n` +
      "worktree; the main conversation is not blocked. You do NOT have its results yet\n" +
      "— they will arrive as a separate message when it finishes. Do not report or\n" +
      "guess its findings before then."
    );
  },
});

export const delegate_list = tool({
  description: [
    "List the background jobs belonging to THIS session (jobs it started, plus any",
    "still running). Use this to answer a user's \"what's running?\" / \"what",
    "background jobs did I start?\" question — NOT to wait for a job to finish.",
    "Completion arrives on its own as a separate later message, so do not call this",
    "in a poll loop. Each entry has id, name, status (running/done/failed/stopped),",
    "branch, worktree, activity, and timestamps. To see what a running job is",
    "actually doing, use `peers_inspect` on that session.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const res = await call(
      "GET",
      `/api/delegate?sessionID=${encodeURIComponent(context.sessionID ?? "")}`,
    );
    const jobs = (Array.isArray(res?.jobs) ? res.jobs : []).filter((j: any) => !j?.supersededBy);
    if (jobs.length === 0) return "No background jobs for this session.";
    const lines = jobs.map((j: any) => {
      const parts = [`${j?.id ?? ""}`, `"${j?.name ?? ""}"`, j?.status ?? "?"];
      if (j?.branch) parts.push(`branch=${j.branch}`);
      if (j?.worktree) parts.push(`worktree`);
      if (Number(j?.attempt) > 1) parts.push(`round ${j.attempt}`);
      return parts.join(" ");
    });
    return `Background jobs (${jobs.length}):\n` + lines.join("\n");
  },
});

export const delegate_send = tool({
  description: [
    "Start another round of work in one of YOUR background jobs that has finished —",
    "a fix round after a review, the next milestone, a follow-up question. The job",
    "keeps its session, context, worktree and branch, so this is cheaper and",
    "better than starting a new job for the same work. Only works once the job's",
    "previous result has reached you (while it is still working, wait for that",
    "result). The new round's result comes back to you automatically as a later",
    "message — do not poll. Returns immediately; you do NOT have the result yet.",
  ].join(" "),
  args: {
    id: z
      .string()
      .describe("The id of the finished background job to continue, from `delegate_list`."),
    prompt: z
      .string()
      .describe(
        "What the job should do in this round. The job keeps its earlier context, " +
          "but state the new task, paths and constraints explicitly.",
      ),
  },
  async execute(args, context) {
    let res: any;
    try {
      res = await call("POST", `/api/delegate/${encodeURIComponent(args.id)}/send`, {
        prompt: args.prompt,
        sessionID: context.sessionID,
      });
    } catch (e: any) {
      return `Could not send to background job "${args.id}": ${e?.message ?? e}.`;
    }
    const name = res?.job?.name ?? args.id;
    const id = res?.job?.id ?? "";
    return (
      `Sent another round to background job "${name}" (id ${id}). You do NOT have its\n` +
      "result yet — it will arrive as a separate message when this round finishes. Do\n" +
      "not report or guess it before then."
    );
  },
});

export const delegate_stop = tool({
  description: [
    "Stop a running background job by id. Aborts the job's opencode session, marks",
    "it `stopped`, and delivers a short completion notice to this session. The job's",
    "tmux window and git worktree are kept (use the UI to delete them). Only stops",
    "jobs that are currently `running`. Find the id with `delegate_list`.",
  ].join(" "),
  args: {
    id: z
      .string()
      .describe("The background job id (8-char hex) to stop, from `delegate_list`."),
  },
  async execute(args) {
    await call("POST", `/api/delegate/${encodeURIComponent(args.id)}/stop`);
    return `Stopped background job "${args.id}".`;
  },
});
