// manta-native `cto` read tool — a global opencode custom tool (BET-1164).
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/cto.ts ~/.config/opencode/tools/cto.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// A copy, never a symlink — opencode resolves a tool's imports relative to the
// file's REAL path, so a symlink back into the repo (no node_modules) fails
// with `Cannot find module '@opencode-ai/plugin'` and the tool silently never
// registers.
//
// This is a THIN registrar: `execute` POSTs `{tool, args}` to
// manta-server's /api/cto (same box, no SSH hop) and returns the read result.
// Every read is deterministic and read-only — see src/server/cto.mjs, which
// owns the engine (it reuses tmux, opencode, usage, messageSearch, local,
// stoppedStore; nothing is reimplemented).

import { tool } from "@opencode-ai/plugin";
import { boxToken, authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// All the deterministic read tools this belt exposes. Keep in sync with
// src/server/cto.mjs's registry (listTools).
const CTO_TOOLS =
  "list_sessions, list_projects, read_transcript, search_messages, git_status, " +
  "git_branch, git_log, list_models, get_usage, usage_stopped, session_usage, " +
  "context_state, session_plan_mode, get_config, read_rollups, read_ledger, " +
  "watch, unwatch, list_watches";

export const cto = tool({
  description: [
    "Deterministic on-call CTO tools: inspect what's running on this box,",
    "read chat transcripts, search messages, git state, models, plan usage,",
    "stopped conversations, per-session cost/context/plan-mode, and config. Reads",
    "never mutate anything. The watch/unwatch/list_watches",
    "tools register watchers (watch is a confirm-mode action).",
    `Pick \`tool\` from: ${CTO_TOOLS}.`,
    "Pass that tool's arguments as a free-form object in \`args\`",
    "(e.g. {tool:\"read_transcript\", args:{sessionID:\"ses_...\"}}).",
    "If the call returns needConfirmation for a confirm-mode tool, surface",
    "\"I need your go-ahead: <preview>\" to the user; when they reply \"go ahead\",",
    "re-invoke the SAME tool+args with \`approve: <id>\` (the id from the",
    "needConfirmation result). Reply \"no\" to abort (reject).",
  ].join(" "),
  args: {
    tool: tool.schema
      .string()
      .describe(`The cto tool to run. One of: ${CTO_TOOLS}.`),
    args: tool.schema
      .object({})
      .passthrough()
      .describe("Free-form arguments for the chosen tool (depends on the tool)."),
    approve: tool.schema
      .string()
      .optional()
      .describe(
        "When re-dispatching a confirm-mode tool after the user said \"go ahead\", pass " +
          "the id from the earlier needConfirmation result to authorize it.",
      ),
  },
  async execute(args, context) {
    const res = await fetch(`${MANTA_SERVER}/api/cto`, {
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
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { ok: false, error: text };
    }
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.error || `manta-server ${res.status}`);
    }
    return JSON.stringify(json?.data ?? json);
  },
});
