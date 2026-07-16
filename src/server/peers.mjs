// peers.mjs — peer-session awareness for the mobile server.
//
// Lets an opencode session see what OTHER sessions in the SAME workspace are
// doing. A "workspace" is a tmux session (bui project); each window is an
// app-session. Sibling windows = peers. The crux is the `@manta-session-id`
// tmux user-option, surfaced by tmux.listProjects() as window.opencodeSessionId.
//
// The remote AI calls the global opencode `peers_list` / `peers_inspect` tools
// (docs/opencode-tools/peers.ts), which GET bui-server's /api/peers. Use case:
// an agent notices git status / files changing and wants to know which other
// agent is doing it, and what they're working on.
//
// Per-peer data sources:
//   - chat-mode peer (opencodeSessionId set): opencode transcript + pending
//     permissions/questions.
//   - claude-TUI peer (opencodeSessionId null): tmux capture-pane + BUSY_RE.
//   - git state (both): `git -C <cwd> status --porcelain` + getVcsBranch.
//
// Pure helpers (resolveWorkspace, selectPeers, parseGitStatus,
// summarizeTranscript, classifyChatStatus, recentTurns) are exported and
// unit-tested in peers.test.mjs.

import { run } from "./tmux.mjs";
import * as tmux from "./tmux.mjs";
import * as oc from "./opencode.mjs";

// Claude TUI busy detector — same heuristic as status.mjs (spinner glyph at
// column 0 + verb + Unicode ellipsis + parenthesised "(…·…)"). Duplicated here
// rather than imported so peers.mjs has no coupling to the status poller.
const BUSY_RE = /^[✻✳✶✽✢·*]\s+\S+…[^\n]*\([^)\n]+·[^)\n]*\)/mu;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Find the caller's window + project from the full projects list.
// Resolution order: (1) window whose opencodeSessionId === sessionID,
// (2) window whose paneCurrentPath === directory (fallback for sessions whose
// window isn't stamped, e.g. subagent children). Returns null if not found.
export function resolveWorkspace(projects, sessionID, directory) {
  if (!Array.isArray(projects)) return null;
  if (sessionID) {
    for (const p of projects) {
      const w = (p.windows || []).find((w) => w.opencodeSessionId === sessionID);
      if (w) return { project: p, self: w, matchedBy: "session" };
    }
  }
  if (directory) {
    for (const p of projects) {
      const w = (p.windows || []).find((w) => w.paneCurrentPath === directory);
      if (w) return { project: p, self: w, matchedBy: "directory" };
    }
  }
  return null;
}

// All sibling windows in the same project except the caller's own window.
export function selectPeers(project, self) {
  const wins = project?.windows || [];
  return wins.filter((w) => {
    if (w === self) return false;
    // Also exclude any window sharing the caller's opencode session id.
    if (self?.opencodeSessionId && w.opencodeSessionId === self.opencodeSessionId) return false;
    return true;
  });
}

// Parse `git status --porcelain` output into a structured summary.
export function parseGitStatus(porcelain) {
  const lines = (porcelain || "").split("\n").filter((l) => l.length > 0);
  const files = lines.map((l) => ({
    status: l.slice(0, 2).trim(),
    path: l.slice(3),
  }));
  return { count: files.length, files };
}

// Walk an opencode transcript and pull out the bits useful for a peek:
// last user text, last assistant text, active todos, and the recent tool names.
export function summarizeTranscript(messages) {
  let lastUser = null;
  let lastAssistant = null;
  let todos = [];
  const recentTools = [];
  for (const m of messages || []) {
    const role = m?.info?.role;
    const parts = m?.parts || [];
    let text = "";
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") {
        text += p.text;
      } else if (p?.type === "tool") {
        const name = p.tool || p.name;
        if (name) recentTools.push(name);
        const input = p?.state?.input;
        if ((name === "todowrite" || name === "TodoWrite") && Array.isArray(input?.todos)) {
          todos = input.todos;
        }
      }
    }
    text = text.trim();
    if (role === "user" && text) lastUser = text;
    if (role === "assistant" && text) lastAssistant = text;
  }
  return { lastUser, lastAssistant, todos, lastToolNames: recentTools.slice(-5) };
}

// Best-effort live status of a chat-mode peer. Blocked beats working beats idle.
// "working" heuristic: the last message is an assistant turn with no completion
// timestamp (still streaming). This is best-effort — the server keeps no live
// per-session running flag (that lives in the renderer's SSE handler).
export function classifyChatStatus(messages, permissions, questions) {
  if ((questions?.length || 0) > 0) return "blocked-question";
  if ((permissions?.length || 0) > 0) return "blocked-permission";
  const msgs = messages || [];
  const last = msgs[msgs.length - 1];
  if (last?.info?.role === "assistant" && !last?.info?.time?.completed) return "working";
  return "idle";
}

// A short human description of what a chat peer is doing: prefer the in-progress
// todo, else the tail of the last assistant message, else recent tool names.
export function describeChatActivity(summary) {
  const inProgress = (summary.todos || []).find((t) => t.status === "in_progress");
  if (inProgress?.content) return `todo: ${inProgress.content}`;
  if (summary.lastAssistant) return truncate(summary.lastAssistant, 160);
  if (summary.lastToolNames.length) return `recent tools: ${summary.lastToolNames.join(", ")}`;
  return "(no recent activity)";
}

// Wrap a peer-to-peer message with provenance context so the RECEIVING
// session knows the turn came from another agent (not its user) and who/where
// it came from. The receiving model treats this as an ordinary user turn, so
// the framing must make the cross-session origin explicit and tell it how to
// reply (the peers_message tool, targeting the sender's window name).
export function formatPeerMessage({ fromName, fromWorkspace, text }) {
  const from = fromName || "unknown";
  const ws = fromWorkspace ? ` in workspace "${fromWorkspace}"` : "";
  return [
    `[Message from peer agent session "${from}"${ws}]`,
    "",
    String(text ?? "").trim(),
    "",
    `(This was sent by another agent working alongside you in the same ` +
      `workspace — not by your user. To reply, use the peers_message tool ` +
      `with target "${from}".)`,
  ].join("\n");
}

// Recent transcript turns for the detailed inspect view.
export function recentTurns(messages, limit = 6) {
  const turns = [];
  for (const m of messages || []) {
    const role = m?.info?.role;
    const parts = m?.parts || [];
    let text = "";
    const tools = [];
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") text += p.text;
      else if (p?.type === "tool") {
        const name = p.tool || p.name;
        if (name) tools.push(name);
      }
    }
    text = text.trim();
    if (text || tools.length) turns.push({ role, text: truncate(text, 400), tools });
  }
  return turns.slice(-limit);
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function gitStatus(dir) {
  if (!dir) return null;
  try {
    const { stdout } = await run("git", ["-C", dir, "status", "--porcelain"]);
    return parseGitStatus(stdout);
  } catch {
    return null; // non-git dir or git missing
  }
}

async function captureTuiActivity(session, windowIndex) {
  try {
    const { stdout } = await run("tmux", [
      "capture-pane",
      "-t",
      `${session}:${windowIndex}`,
      "-p",
      "-S",
      "-40",
    ]);
    const busy = BUSY_RE.test(stdout);
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    return { busy, tail: lines.slice(-3).join(" | "), full: lines.slice(-40).join("\n") };
  } catch {
    return { busy: false, tail: "", full: "" };
  }
}

// ---------------------------------------------------------------------------
// Public API — list + inspect
// ---------------------------------------------------------------------------

export async function listPeers({ sessionID, directory }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return {
      ok: false,
      error: "Could not locate your session in any tmux workspace.",
    };
  }
  const peerWins = selectPeers(loc.project, loc.self);

  const peers = await Promise.all(
    peerWins.map(async (w) => {
      const dir = w.paneCurrentPath;
      const [git, branch] = await Promise.all([
        gitStatus(dir),
        oc.getVcsBranch(dir).catch(() => null),
      ]);
      const base = {
        name: w.name,
        windowIndex: w.index,
        cwd: dir,
        branch: branch || null,
        type: w.opencodeSessionId ? "chat" : "tui",
        gitChanges: git?.count ?? 0,
      };
      if (w.opencodeSessionId) {
        const [msgs, perms, qs] = await Promise.all([
          oc.listMessages(w.opencodeSessionId).catch(() => []),
          oc.listPermissions(w.opencodeSessionId).catch(() => []),
          oc.listQuestions(w.opencodeSessionId).catch(() => []),
        ]);
        const sum = summarizeTranscript(msgs);
        return {
          ...base,
          status: classifyChatStatus(msgs, perms, qs),
          activity: describeChatActivity(sum),
        };
      }
      const act = await captureTuiActivity(loc.project.tmuxSession, w.index);
      return {
        ...base,
        status: act.busy ? "working" : "idle",
        activity: act.tail || "(idle)",
      };
    }),
  );

  return {
    ok: true,
    workspace: loc.project.tmuxSession,
    self: loc.self.name,
    matchedBy: loc.matchedBy,
    peers,
  };
}

export async function inspectPeer({ sessionID, directory, target }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  const peerWins = selectPeers(loc.project, loc.self);
  if (!target) {
    return { ok: false, error: "target is required (window name, index, or session id)" };
  }
  const t = String(target).toLowerCase();
  const w = peerWins.find(
    (w) =>
      w.name?.toLowerCase() === t ||
      String(w.index) === t ||
      w.opencodeSessionId === target,
  );
  if (!w) {
    return {
      ok: false,
      error: `No peer matching "${target}". Peers: ${peerWins.map((w) => w.name).join(", ") || "(none)"}`,
    };
  }

  const dir = w.paneCurrentPath;
  const [git, branch] = await Promise.all([
    gitStatus(dir),
    oc.getVcsBranch(dir).catch(() => null),
  ]);
  const base = {
    name: w.name,
    windowIndex: w.index,
    cwd: dir,
    branch: branch || null,
    type: w.opencodeSessionId ? "chat" : "tui",
    git: git || { count: 0, files: [] },
  };

  if (w.opencodeSessionId) {
    const [msgs, perms, qs] = await Promise.all([
      oc.listMessages(w.opencodeSessionId).catch(() => []),
      oc.listPermissions(w.opencodeSessionId).catch(() => []),
      oc.listQuestions(w.opencodeSessionId).catch(() => []),
    ]);
    const sum = summarizeTranscript(msgs);
    return {
      ok: true,
      workspace: loc.project.tmuxSession,
      peer: {
        ...base,
        status: classifyChatStatus(msgs, perms, qs),
        todos: sum.todos,
        turns: recentTurns(msgs, 6),
      },
    };
  }

  const act = await captureTuiActivity(loc.project.tmuxSession, w.index);
  return {
    ok: true,
    workspace: loc.project.tmuxSession,
    peer: {
      ...base,
      status: act.busy ? "working" : "idle",
      pane: act.full,
    },
  };
}

// Send a message into a peer chat-mode session. Resolves the caller's
// workspace, finds the target sibling window, and injects the message as a new
// user turn into that peer's opencode session via sendPrompt — wrapped with
// provenance context (formatPeerMessage) so the receiver knows it came from a
// peer agent. Only chat-mode peers (opencodeSessionId set) can receive a
// message; a claude-TUI peer has no opencode session to inject into.
//
// deps.listProjects / deps.sendPrompt are injectable for tests; they default
// to the live tmux + opencode implementations.
export async function sendPeerMessage({ sessionID, directory, target, message }, deps = {}) {
  const listProjects = deps.listProjects || tmux.listProjects;
  const sendPrompt = deps.sendPrompt || oc.sendPrompt;
  if (!target) {
    return { ok: false, error: "target is required (peer window name, index, or session id)" };
  }
  if (!message || !String(message).trim()) {
    return { ok: false, error: "message is required" };
  }
  const projects = await listProjects();
  const loc = resolveWorkspace(projects, sessionID, directory);
  if (!loc) {
    return { ok: false, error: "Could not locate your session in any tmux workspace." };
  }
  const peerWins = selectPeers(loc.project, loc.self);
  const t = String(target).toLowerCase();
  const w = peerWins.find(
    (w) =>
      w.name?.toLowerCase() === t ||
      String(w.index) === t ||
      w.opencodeSessionId === target,
  );
  if (!w) {
    return {
      ok: false,
      error: `No peer matching "${target}". Peers: ${peerWins.map((w) => w.name).join(", ") || "(none)"}`,
    };
  }
  if (!w.opencodeSessionId) {
    return {
      ok: false,
      error: `Peer "${w.name}" is a terminal (claude-TUI) session — only chat-mode peers can receive a message.`,
    };
  }
  const text = formatPeerMessage({
    fromName: loc.self.name,
    fromWorkspace: loc.project.tmuxSession,
    text: String(message),
  });
  await sendPrompt({ sessionId: w.opencodeSessionId, text });
  return {
    ok: true,
    workspace: loc.project.tmuxSession,
    from: loc.self.name,
    to: w.name,
    targetSessionId: w.opencodeSessionId,
  };
}
