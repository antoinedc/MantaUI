// V2 twin of docs/opencode-tools/cto.ts → cto. Thin registrar: POSTs
// `{tool, args}` to manta-server's /api/cto, which owns the engine
// (src/server/cto.mjs). Unlike the other tools, a failed call does NOT throw:
// it returns the structured failure as JSON (code + retrySafe survive, so the
// model does not blindly redispatch a possibly accepted side effect).

import { authHeaders, serverUrl } from "../lib/server.ts";
import { input, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

// All the deterministic read tools this belt exposes. Keep in sync with
// src/server/cto.mjs's registry (listTools).
const CTO_TOOLS =
  "list_sessions, list_projects, read_transcript, search_messages, git_status, " +
  "git_branch, git_log, list_models, get_usage, usable_models, usage_stopped, session_usage, " +
  "context_state, session_plan_mode, get_config, read_rollups, read_ledger, read_inbox, watch, unwatch, " +
  "list_watches, read_facts, read_profile, read_toolregistry, " +
  "context_projects, context_search, context_around, describe_tools, " +
  "projects_list, projects_inspect, projects_create, projects_update, projects_archive, projects_remove, " +
  "sessions_list, sessions_inspect, sessions_usage, sessions_create, sessions_configure, sessions_fork, sessions_compact, sessions_archive, sessions_remove, " +
  "work_list, work_inspect, work_evidence, work_capacity, work_create, work_revise, work_prioritize, work_dispatch, " +
  "work_pause, work_resume, work_cancel, work_retry, work_answer_decision, work_handoff, work_review, work_merge, work_release, work_verify, work_complete, work_archive, work_cleanup, work_rollback";

export const tools: ToolDef[] = [
  {
    name: "cto",
    description: [
      "This gateway includes reads AND mutations. Reads are available to all sessions. Project/session/work mutations require an active execution turn in the bound CTO conversation; they are denied in plan mode.",
      "CTO orchestration gateway. Use describe_tools {prefix:'work_'} (or projects_, sessions_, context_) for LIVE argument contracts.",
      "For project execution: resolve projects_list/projects_inspect, create tracked work with work_create, then work_dispatch into that explicit project.",
      "Use work_inspect for progress and the work review/release/verify operations for delivery. Keep implementation in workers, not the CTO conversation.",
      "Deterministic on-call CTO tools: inspect what's running on this box,",
      "read chat transcripts, search messages, git state, models, plan usage,",
      "stopped conversations, per-session cost/context/plan-mode, config, and the",
      "CTO inbox (read_inbox — the notes any session sent via send_to_cto). Reads",
      "never mutate anything. The watch/unwatch/list_watches",
      "tools register watchers (watch is a confirm-mode action).",
      "The Adaptive CTO's own state is readable too (read verbs, all read-only):",
      "read_facts {project, asOf?} returns a project's Blackboard facts (kind,",
      "statement, refs, confidence, sender, age) plus the superseded chain —",
      "asOf (unix ms) reconstructs the live set at that time; omit project to",
      "list projects. read_profile returns the editable user profile (§8).",
      "read_toolregistry returns the external-tool registry (§7): status,",
      "engagement/vitality, derived role, the secret key that grants access,",
      "probe cadence + last result.",
      "The passive project-context verbs (§4.2) read opencode's OWN store:",
      "context_projects lists ALL historical sessions (closed/archived/child",
      "included) with observed source ids; context_search returns bounded",
      "newest-first hits (direct source reads, no FTS/ranking index) and",
      "context_around the message neighborhood, both with stable",
      "session/message/part ids. Each returns a {status, coverage, observedAt,",
      "nextCursor, truncated} envelope — status distinguishes ok / invalid_input",
      "/ unsupported / source_unavailable / reference_expired. Filters take",
      "OBSERVED projectId/directory/sessionId (a Manta workspace key is rejected;",
      "project mapping is unmapped). These context operations are read-only.",
      `Pick \`tool\` from: ${CTO_TOOLS}.`,
      "Pass that tool's arguments as a free-form object in \`args\`",
      '(e.g. {tool:"read_transcript", args:{sessionID:"ses_..."}}).',
      "If the call returns needConfirmation for a confirm-mode tool, surface",
      '"I need your go-ahead: <preview>" to the user; when they reply "go ahead",',
      "re-invoke the SAME tool+args with \`approve: <id>\` (the id from the",
      'needConfirmation result). Reply "no" to abort (reject).',
    ].join(" "),
    input: input(
      {
        tool: str(`The cto tool to run. One of: ${CTO_TOOLS}.`),
        args: {
          // z.object({}).passthrough() — any keys allowed.
          type: "object",
          properties: {},
          additionalProperties: true,
          description: "Free-form arguments for the chosen tool (depends on the tool).",
        },
        approve: str(
          'When re-dispatching a confirm-mode tool after the user said "go ahead", pass ' +
            "the id from the earlier needConfirmation result to authorize it.",
        ),
      },
      ["approve"],
    ),
    async execute(args, context) {
      const res = await fetch(`${serverUrl()}/api/cto`, {
        method: "POST",
        headers: authHeaders(args),
        body: JSON.stringify({
          tool: args.tool,
          args: args.args ?? {},
          approve: args.approve,
          sessionID: context?.sessionID,
          directory: context?.directory,
        }),
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { ok: false, error: text };
      }
      if (!res.ok || json?.ok === false) {
        // Preserve structured control failures (code + retrySafe); losing them
        // invites blind redispatch of a possibly accepted side effect.
        return JSON.stringify({ ...json, ok: false, error: json?.error || `manta-server ${res.status}` });
      }
      return JSON.stringify(json?.data ?? json);
    },
  },
];
