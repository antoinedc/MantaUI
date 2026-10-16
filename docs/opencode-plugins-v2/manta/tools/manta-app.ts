// V2 twin of docs/opencode-tools/manta-app.ts → manta_compact_session /
// manta_switch_model / manta_rename_session / manta_list_sessions. Each POSTs
// /api/app-control {action, sessionID, directory, ...args}; effects are applied
// by manta-server (src/server/appControl.mjs). No interrupt / permission
// approval is exposed here by design.

import { call } from "../lib/server.ts";
import { input, noInput, str } from "../lib/schema.ts";
import type { ToolContext, ToolDef } from "../lib/types.ts";

async function appControl<T>(
  action: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<T> {
  return (await call("POST", "/api/app-control", {
    action,
    sessionID: context?.sessionID,
    directory: context?.directory,
    ...args,
  })) as T;
}

export const tools: ToolDef[] = [
  {
    name: "manta_compact_session",
    description: [
      "Compact THIS chat session now to free context (the same as the /compact command).",
      "The effect is immediate and visible in the transcript.",
      "Act rather than ask when the user's intent is clear — just do it and confirm",
      "tersely; you do not need the user to approve the mechanical act.",
    ].join(" "),
    input: noInput(),
    async execute(_args, context) {
      const result = await appControl<{ ok: boolean }>("compact-session", {}, context);
      if (!result.ok) throw new Error("compact failed");
      return "Compacted this session. It now has a shorter context to continue from.";
    },
  },
  {
    name: "manta_switch_model",
    description: [
      "Switch THIS chat session to the model the user asked for, matched on a spoken",
      'or typed name (e.g. "opus", "sonnet 4"). The change is immediate and',
      "visible in the composer's model pill, but it applies to SUBSEQUENT turns —",
      "the current reply has already started on the old model and does not switch.",
      "So do not claim the current response is on the new model.",
      "Act rather than ask when the user's intent is clear — just switch and confirm",
      "which model it picked.",
    ].join(" "),
    input: input({
      query: str('The model name to switch to, as the user said it, e.g. "opus" or "sonnet 4".'),
    }),
    async execute(args, context) {
      const result = await appControl<{
        ok: boolean;
        model?: { modelID: string; name?: string | null };
        error?: string;
      }>("switch-model", { query: args.query }, context);
      if (!result.ok) throw new Error(result.error || "switch failed");
      const m = result.model;
      return `Switched this session to ${m?.modelID}. It will apply from the next turn onward.`;
    },
  },
  {
    name: "manta_rename_session",
    description: [
      "Rename THIS chat session / window to the name the user asked for (visible in",
      "the sidebar). The effect is immediate and visible to the user — the sidebar",
      "refreshes on its own, no manual refresh needed.",
      "Act rather than ask when the user's intent is clear — just rename and confirm.",
    ].join(" "),
    input: input({
      name: str("The new session name (1–40 characters; no ':' or control characters)."),
    }),
    async execute(args, context) {
      const result = await appControl<{ ok: boolean; name?: string; error?: string }>(
        "rename-session",
        { name: args.name },
        context,
      );
      if (!result.ok) throw new Error(result.error || "rename failed");
      return `Renamed this session to "${result.name}".`;
    },
  },
  {
    name: "manta_list_sessions",
    description: [
      "List the sessions (tmux windows) in THIS workspace, with each one's name,",
      "index, whether it's a chat window, its git branch, and whether it is the",
      "current session. Read-only and cheap — use it to understand the workspace",
      "(e.g. before switching windows) or to report what is open.",
    ].join(" "),
    input: noInput(),
    async execute(_args, context) {
      const result = await appControl<{
        ok: boolean;
        workspace?: string;
        self?: string;
        sessions?: Array<{
          name: string;
          index: number;
          chat: boolean;
          branch: string | null;
          caller: boolean;
        }>;
        error?: string;
      }>("list-sessions", {}, context);
      if (!result.ok) throw new Error(result.error || "list failed");
      const rows = (result.sessions ?? []).map(
        (s) =>
          `• window ${s.index} [${s.name}] (${s.chat ? "chat" : "terminal"})${s.branch ? ` ⎇${s.branch}` : ""}${s.caller ? " ← you" : ""}`,
      );
      return `Workspace "${result.workspace}" — ${rows.length} session(s):\n${rows.join("\n")}`;
    },
  },
];
