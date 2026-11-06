import { call } from "../lib/server.ts";
import { input, str } from "../lib/schema.ts";
import type { ToolContext, ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = (["link", "unlink"] as const).map((action) => ({
  name: `session_${action}`,
  description: action === "link"
    ? "Nest an API-driven session under THIS conversation in the sidebar. Call once per session you drive through opencode's HTTP API. Authoritative job/parent edges cannot be replaced."
    : "Remove this conversation's explicit link for a session so it appears at top level (authoritative job/parent edges still apply).",
  input: input({ sessionId: str("The session id to nest or unlink.") }),
  async execute(args: { sessionId: string }, context: ToolContext) {
    const result = await call("POST", "/api/session-links", { action, sessionID: context.sessionID, target: args.sessionId }) as { ok: boolean; error?: string };
    if (!result.ok) throw new Error(result.error || "Couldn't change the session link.");
    return action === "link" ? "Session linked under this conversation." : "Session unlinked; it is a top-level row unless a job caller or opencode parent owns its placement.";
  },
}));
