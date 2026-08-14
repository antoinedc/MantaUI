// manta-native `app-control` tools — global opencode custom tools.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/manta-app.ts ~/.config/opencode/tools/manta-app.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// A copy, never a symlink — opencode resolves a tool's imports relative to the
// file's REAL path, so a symlink back into the repo (no node_modules) fails
// with `Cannot find module '@opencode-ai/plugin'` and the tool silently never
// registers.
//
// These tools let THIS session drive the app the user is looking at: switch
// the model for this chat session, rename the session in the sidebar, compact
// it, or list the sessions in this workspace. They are THIN registrars: each
// `fetch`es manta-server (127.0.0.1:8787/api/app-control, same box, no SSH
// hop) and returns promptly — no long-running work, no sleeping. Effects are
// immediate and visible to the user (or — for switch-model — apply from the
// next turn on). See src/server/appControl.mjs.

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

async function appControl<T>(action: string, args: Record<string, unknown>, context: any): Promise<T> {
  const res = await fetch(`${MANTA_SERVER}/api/app-control`, {
    method: "POST",
    headers: authHeaders(args),
    body: JSON.stringify({
      action,
      sessionID: context?.sessionID,
      directory: context?.directory,
      ...args,
    }),
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
  return json as T;
}

export const manta_compact_session = tool({
  description: [
    "Compact THIS chat session now to free context (the same as the /compact command).",
    "The effect is immediate and visible in the transcript.",
    "Act rather than ask when the user's intent is clear — just do it and confirm",
    "tersely; you do not need the user to approve the mechanical act.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const result = await appControl<{ ok: boolean }>("compact-session", {}, context);
    if (!result.ok) throw new Error("compact failed");
    return "Compacted this session. It now has a shorter context to continue from.";
  },
});

export const manta_switch_model = tool({
  description: [
    "Switch THIS chat session to the model the user asked for, matched on a spoken",
    "or typed name (e.g. \"opus\", \"sonnet 4\"). The change is immediate and",
    "visible in the composer's model pill, but it applies to SUBSEQUENT turns —",
    "the current reply has already started on the old model and does not switch.",
    "So do not claim the current response is on the new model.",
    "Act rather than ask when the user's intent is clear — just switch and confirm",
    "which model it picked.",
  ].join(" "),
  args: {
    query: tool.schema
      .string()
      .describe("The model name to switch to, as the user said it, e.g. \"opus\" or \"sonnet 4\"."),
  },
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
});

export const manta_rename_session = tool({
  description: [
    "Rename THIS chat session / window to the name the user asked for (visible in",
    "the sidebar). The effect is immediate and visible to the user — the sidebar",
    "refreshes on its own, no manual refresh needed.",
    "Act rather than ask when the user's intent is clear — just rename and confirm.",
  ].join(" "),
  args: {
    name: tool.schema
      .string()
      .describe("The new session name (1–40 characters; no ':' or control characters)."),
  },
  async execute(args, context) {
    const result = await appControl<{ ok: boolean; name?: string; error?: string }>(
      "rename-session",
      { name: args.name },
      context,
    );
    if (!result.ok) throw new Error(result.error || "rename failed");
    return `Renamed this session to "${result.name}".`;
  },
});

export const manta_list_sessions = tool({
  description: [
    "List the sessions (tmux windows) in THIS workspace, with each one's name,",
    "index, whether it's a chat window, its git branch, and whether it is the",
    "current session. Read-only and cheap — use it to understand the workspace",
    "(e.g. before switching windows) or to report what is open.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const result = await appControl<{
      ok: boolean;
      workspace?: string;
      self?: string;
      sessions?: Array<{ name: string; index: number; chat: boolean; branch: string | null; caller: boolean }>;
      error?: string;
    }>("list-sessions", {}, context);
    if (!result.ok) throw new Error(result.error || "list failed");
    const rows = (result.sessions ?? []).map(
      (s) =>
        `• window ${s.index} [${s.name}] (${s.chat ? "chat" : "terminal"})${s.branch ? ` ⎇${s.branch}` : ""}${s.caller ? " ← you" : ""}`,
    );
    return `Workspace "${result.workspace}" — ${rows.length} session(s):\n${rows.join("\n")}`;
  },
});
