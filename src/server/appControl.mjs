// appControl.mjs — app-control tools for the mobile server.
//
// Lets an opencode session drive the app the user is looking at: switch the
// model for its chat session, rename the session in the sidebar, compact it,
// or list the sessions in the caller's workspace. The remote AI calls the
// global opencode `manta_*` tools (docs/opencode-tools/manta-app.ts), which
// POST to manta-server's /api/app-control; this module is the dispatch target.
//
// Mirrors src/server/peers.mjs: pure logic with injected I/O, live reads, no
// durable store. Every action resolves the caller's session the way peers.mjs
// does — by sessionID first, falling back to matching `directory` against a
// window's pane path — via the shared resolveWorkspace.
//
// Client-visible effects are published on the bus as ONE kind, `appControl`,
// with an `action` discriminator. The bus envelope ({ kind:"appControl",
// payload }) is added by index.mjs; each function here calls its injected
// `publish` with the bare payload ({ action, ... }). The desktop renderer
// subscribes once (the sibling ticket) and switches on `payload.action`.

import * as tmux from "./tmux.mjs";
import * as oc from "./opencode.mjs";
import { resolveWorkspace } from "./peers.mjs";
import { fuzzyMatchModel, suggestModels } from "../shared/modelGuide.mjs";

// Window names tmux tolerates: anything except the `:` target separator and
// control characters (a newline in a window name would corrupt the tab- and
// newline-delimited -F listing). We reject rather than sanitise — the caller
// (the model) gets a clear message and can retry with a different name.
export function validateSessionName(name) {
  if (typeof name !== "string") return { ok: false, error: "A session name is required." };
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    return { ok: false, error: "Session name must be 1–40 characters." };
  }
  if (/[:]/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return {
      ok: false,
      error: "Session name cannot contain ':' or control characters.",
    };
  }
  return { ok: true, name: trimmed };
}

// Compact the caller's session. opencode already emits `session.compacted`
// and the renderer already reacts to it, so no bus event is needed here.
export async function compactSession({ sessionID, directory }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const compact = deps.compactSession || oc.compactSession;
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  await compact(loc.self.opencodeSessionId);
  return { ok: true };
}

// Switch the caller's chat session to the model matching `query` (e.g.
// "opus", "sonnet 4"). Resolves against oc.listModels() via the shared fuzzy
// matcher; on a hit, publishes an `appControl` bus event.
//
// The model override is RENDERER state (localStorage, keyed per session), so
// the server cannot apply it directly — the bus event is how it lands on the
// open ChatPanel. That is the whole point of publishing here.
export async function switchModel({ sessionID, directory, query }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const listModels = deps.listModels || oc.listModels;
  const publish = deps.publish || (() => {});
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  if (!query || !String(query).trim()) {
    return {
      ok: false,
      error: 'query is required — say which model, e.g. "opus" or "sonnet 4".',
    };
  }
  const models = await listModels();
  const resolved = fuzzyMatchModel(query, models);
  if (!resolved) {
    const suggestions = suggestModels(query, models, 3);
    const hint = suggestions.length
      ? ` Closest models: ${suggestions.map((s) => `${s.providerID}/${s.id}`).join(", ")}.`
      : " No models are currently available on this box.";
    return { ok: false, error: `No model matched "${query}".${hint}` };
  }
  publish({
    action: "switch-model",
    sessionId: loc.self.opencodeSessionId,
    providerID: resolved.providerID,
    modelID: resolved.id,
  });
  return {
    ok: true,
    model: {
      providerID: resolved.providerID,
      modelID: resolved.id,
      name: resolved.name ?? null,
    },
  };
}

// Rename the caller's own window (session). Validates the name, calls the
// tmux rename-window path through src/server/tmux.mjs (which owns every tmux
// invocation, including its locale-safe spawn environment), and publishes an
// `appControl` event so sidebars refresh without waiting for a poll.
export async function renameSession({ sessionID, directory, name }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const renameWindow = deps.renameWindow || tmux.renameWindow;
  const publish = deps.publish || (() => {});
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  const valid = validateSessionName(name);
  if (!valid.ok) return valid;
  await renameWindow({
    sessionName: loc.project.tmuxSession,
    windowIndex: loc.self.index,
    newName: valid.name,
  });
  publish({
    action: "rename-session",
    sessionId: loc.self.opencodeSessionId,
    name: valid.name,
  });
  return { ok: true, name: valid.name };
}

// List the windows (sessions) in the caller's workspace: name, index, whether
// it is a chat-mode window, its current branch, and whether it is the caller.
// Read-only — no bus event. Branch is best-effort (non-git cwd → null).
export async function listSessions({ sessionID, directory }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const getVcsBranch = deps.getVcsBranch || oc.getVcsBranch;
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  const wins = loc.project.windows || [];
  const sessions = await Promise.all(
    wins.map(async (w) => {
      const branch = await getVcsBranch(w.paneCurrentPath).catch(() => null);
      const caller =
        w === loc.self ||
        (!!loc.self?.opencodeSessionId &&
          !!w.opencodeSessionId &&
          w.opencodeSessionId === loc.self.opencodeSessionId);
      return {
        name: w.name,
        index: w.index,
        chat: !!w.opencodeSessionId,
        branch: branch || null,
        caller,
      };
    }),
  );
  return {
    ok: true,
    workspace: loc.project.tmuxSession,
    self: loc.self.name,
    sessions,
  };
}

// Dispatch an /api/app-control request on its `action`. Rejects unknown
// actions by name so the caller can reply with a message the model can act on.
// `args` carries { action, sessionID, directory, ...action-specific }. `deps`
// is the injected-I/O bag passed through to each handler (listProjects,
// listModels, publish, ...). Returns `{ ok: true, ... }` or `{ ok: false,
// error }`.
export async function dispatch(action, args = {}, deps = {}) {
  const base = { sessionID: args.sessionID, directory: args.directory };
  switch (action) {
    case "compact-session":
      return compactSession(base, deps);
    case "switch-model":
      return switchModel({ ...base, query: args.query }, deps);
    case "rename-session":
      return renameSession({ ...base, name: args.name }, deps);
    case "list-sessions":
      return listSessions(base, deps);
    default:
      return {
        ok: false,
        error: `unknown action "${action}". Supported actions: compact-session, switch-model, rename-session, list-sessions.`,
      };
  }
}
