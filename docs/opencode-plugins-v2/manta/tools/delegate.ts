// V2 twin of docs/opencode-tools/delegate.ts → delegate / delegate_list /
// delegate_send / delegate_stop. manta-server owns the background job engine
// (src/server/delegate.mjs). The "you do NOT have the result yet" return string
// is load-bearing — do not soften it.

import { call } from "../lib/server.ts";
import { arr, input, noInput, obj, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "delegate",
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
  },
  {
    name: "delegate_send",
    description: [
      "Start another round of work in one of YOUR background jobs that has finished —",
      "a fix round after a review, the next milestone, a follow-up question. The job",
      "keeps its session, context, worktree and branch, so this is cheaper and",
      "better than starting a new job for the same work. Only works once the job's",
      "previous result has reached you (while it is still working, wait for that",
      "result). The new round's result comes back to you automatically as a later",
      "message — do not poll. Returns immediately; you do NOT have the result yet.",
    ].join(" "),
    input: input({
      id: str("The id of the finished background job to continue, from `delegate_list`."),
      prompt: str(
        "What the job should do in this round. The job keeps its earlier context, " +
          "but state the new task, paths and constraints explicitly.",
      ),
    }),
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
