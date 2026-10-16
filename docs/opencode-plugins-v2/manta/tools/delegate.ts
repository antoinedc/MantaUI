// V2 twin of docs/opencode-tools/delegate.ts → delegate / delegate_list /
// delegate_stop. manta-server owns the background job engine
// (src/server/delegate.mjs). The "you do NOT have the result yet" return string
// is load-bearing — do not soften it.

import { call } from "../lib/server.ts";
import { arr, input, noInput, obj, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "delegate",
    description: [
      "Start a long-running task as a BACKGROUND job in its own opencode session and",
      "git worktree, so the main conversation is NOT blocked. Use this when the work",
      "is long-running, independent, and you do NOT need its answer to continue your",
      "current reply — research, a broad refactor, an investigation, or a test-suite",
      "run-and-fix. The built-in `task` tool is the right choice when you need the",
      "answer before you can carry on (its foreground default) or for long independent",
      "work that will not edit files (`background: true`); use this `delegate` tool for",
      "work that WILL edit files — it is the only one that gets its own git worktree and",
      "branch. Every background job costs a full extra model session;",
      "do not fan out speculatively. The job starts with NO knowledge of this",
      "conversation — put everything it needs in the prompt. It works in its own git",
      "worktree and commits to its own branch; it never pushes, merges, or touches",
      "this checkout. This tool returns IMMEDIATELY and you do NOT have its result",
      "yet — completion arrives on its own as a separate later message; do not",
      "report or guess the job's findings before then, and do not poll. To see what a",
      "running job is doing, use `peers_inspect`, not a list call in a loop. At most",
      "five background jobs may run at once. Do not start a background job from inside",
      "another background job.",
    ].join(" "),
    input: input(
      {
        prompt: str(
          "The full task prompt for the background job. The job's session has no " +
            "knowledge of this conversation, so include everything it needs: the " +
            "goal, the relevant files/paths, constraints, and what 'done' looks like.",
        ),
        model: str(
          "Optional model id for the job's session, as free text.\u200b " +
            "Naming a model is the OFF switch for automatic routing: the job " +
            "runs on EXACTLY this model and Auto never overrides it. It must be " +
            "a model you approved (ticked) for subagents on this box — an " +
            "unapproved / unknown value fails loudly naming the closest " +
            "candidates rather than silently picking a different model. " +
            "Omit to let Auto route the subagent on its own intent. " +
            "Not validated client-side.",
        ),
        subagent_type: str(
          "The subagent type / role for this background job, passed to the " +
            "router as the job's intent ('general', 'explore', 'build', 'plan', " +
            "or a custom named agent). Auto applies that agent's tier floor. " +
            "Omit to default to 'general'.",
        ),
        tools: arr(
          obj(
            {
              permission: str(
                'The opencode permission category the job needs, e.g. "bash", ' +
                  '"edit" (covers write/edit/apply_patch), "read" (covers ' +
                  'read/glob/grep), "webfetch". A bash/edit/read grant with pattern ' +
                  '"**" also lets the job reach files outside its worktree.',
              ),
              pattern: str(
                'A glob pattern scoping the grant, e.g. "pytest *", "**/*.ts", ' +
                  '"/tmp/*". Matches the `patterns` field on a PermissionRequest.',
              ),
            },
            ["permission", "pattern"],
          ),
          "The access the job needs, declared up front. When trust mode is OFF, " +
            "the user sees ONE approval card before the job starts (Start / Edit " +
            "access / Not now) listing exactly what it will be allowed to do; the " +
            "job then NEVER asks again. A catch-all deny is appended automatically " +
            "so any tool you did NOT declare is refused (not prompted). Declare " +
            "the minimum set: a job lacking a tool it needs FAILS its first " +
            "command instead of hanging. Omit when the job needs no tool access.",
        ),
      },
      ["model", "subagent_type", "tools"],
    ),
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
  },
  {
    name: "delegate_list",
    description: [
      "List the background jobs belonging to THIS session (jobs it started, plus any",
      'still running). Use this to answer a user\'s "what\'s running?" / "what',
      'background jobs did I start?" question — NOT to wait for a job to finish.',
      "Completion arrives on its own as a separate later message, so do not call this",
      "in a poll loop. Each entry has id, name, status (running/done/failed/stopped),",
      "branch, worktree, activity, and timestamps. To see what a running job is",
      "actually doing, use `peers_inspect` on that session.",
    ].join(" "),
    input: noInput(),
    async execute(_args, context) {
      const res = await call(
        "GET",
        `/api/delegate?sessionID=${encodeURIComponent(context.sessionID ?? "")}`,
      );
      const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
      if (jobs.length === 0) return "No background jobs for this session.";
      const lines = jobs.map((j: any) => {
        const parts = [`${j?.id ?? ""}`, `"${j?.name ?? ""}"`, j?.status ?? "?"];
        if (j?.branch) parts.push(`branch=${j.branch}`);
        if (j?.worktree) parts.push(`worktree`);
        return parts.join(" ");
      });
      return `Background jobs (${jobs.length}):\n` + lines.join("\n");
    },
  },
  {
    name: "delegate_stop",
    description: [
      "Stop a running background job by id. Aborts the job's opencode session, marks",
      "it `stopped`, and delivers a short completion notice to this session. The job's",
      "tmux window and git worktree are kept (use the UI to delete them). Only stops",
      "jobs that are currently `running`. Find the id with `delegate_list`.",
    ].join(" "),
    input: input({
      id: str("The background job id (8-char hex) to stop, from `delegate_list`."),
    }),
    async execute(args) {
      await call("POST", `/api/delegate/${encodeURIComponent(args.id)}/stop`);
      return `Stopped background job "${args.id}".`;
    },
  },
];
