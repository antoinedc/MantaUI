// Resolves {sessionID, messageID, directory} for a tool call.
//
// DIRECTORY RESOLUTION — proven empirically on opencode v2.0.30 (see
// scripts/opencode-v2/plugin-pack.e2e.mjs, "directory resolution" assertions):
//
//   V2 does not put `directory` in the tool execute context (keys seen:
//   sessionID, agent, messageID, id, progress, signal). BUT plugins are
//   instantiated PER LOCATION: `setup(ctx)` runs once for every distinct session
//   directory, and the tool registry a session uses is that location's. So the
//   `ctx.location.directory` captured by the tool closure IS the calling
//   session's directory — verified with sessions created in two different
//   directories (each call saw its own), and in a git repo SUBDIRECTORY
//   (location.directory is the exact cwd the session was created with, not the
//   repo root; `ctx.location.project.*` carries the root).
//
//   Fallback (not hit today; kept for a location-less plugin context): the
//   session record itself, `ctx.session.get({sessionID}).location.directory`,
//   which was verified to return the same value. No manta-server round trip is
//   needed, so the planned `GET /api/session-directory` fallback is NOT used.

import type { ToolContext } from "./types.ts";

/** The slice of the V2 plugin context this module touches. */
export interface PluginContextLike {
  location?: { directory?: string };
  session?: { get?(input: { sessionID: string }): Promise<{ location?: { directory?: string } }> };
}

/** The slice of the V2 tool execute context this module touches. */
export interface ExecuteContextLike {
  sessionID: string;
  messageID?: string;
}

export async function resolveToolContext(
  pluginCtx: PluginContextLike,
  exec: ExecuteContextLike,
): Promise<ToolContext> {
  let directory = pluginCtx.location?.directory;
  if (!directory && pluginCtx.session?.get) {
    try {
      directory = (await pluginCtx.session.get({ sessionID: exec.sessionID }))?.location?.directory;
    } catch {
      directory = undefined; // directory is advisory for every tool that reads it
    }
  }
  return { sessionID: exec.sessionID, messageID: exec.messageID, directory };
}
