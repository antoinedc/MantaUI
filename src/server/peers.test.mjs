// Tests for peers.mjs pure logic — no live tmux/opencode/git.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkspace,
  selectPeers,
  parseGitStatus,
  summarizeTranscript,
  classifyChatStatus,
  describeChatActivity,
  recentTurns,
  formatPeerMessage,
  sendPeerMessage,
} from "./peers.mjs";

// ---------------------------------------------------------------------------
// resolveWorkspace
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    tmuxSession: "alpha",
    windows: [
      { index: 0, name: "main", opencodeSessionId: "ses_a0", paneCurrentPath: "/work/alpha" },
      { index: 1, name: "tui", opencodeSessionId: null, paneCurrentPath: "/work/alpha" },
    ],
  },
  {
    tmuxSession: "beta",
    windows: [
      { index: 0, name: "b0", opencodeSessionId: "ses_b0", paneCurrentPath: "/work/beta" },
    ],
  },
];

test("resolveWorkspace finds the owning window by sessionID", () => {
  const loc = resolveWorkspace(PROJECTS, "ses_a0", "/whatever");
  assert.equal(loc.project.tmuxSession, "alpha");
  assert.equal(loc.self.name, "main");
  assert.equal(loc.matchedBy, "session");
});

test("resolveWorkspace falls back to directory match", () => {
  const loc = resolveWorkspace(PROJECTS, "ses_unknown", "/work/beta");
  assert.equal(loc.project.tmuxSession, "beta");
  assert.equal(loc.matchedBy, "directory");
});

test("resolveWorkspace returns null when nothing matches", () => {
  assert.equal(resolveWorkspace(PROJECTS, "ses_x", "/nope"), null);
  assert.equal(resolveWorkspace(null, "ses_a0"), null);
});

// ---------------------------------------------------------------------------
// selectPeers
// ---------------------------------------------------------------------------

test("selectPeers excludes the caller's own window", () => {
  const loc = resolveWorkspace(PROJECTS, "ses_a0");
  const peers = selectPeers(loc.project, loc.self);
  assert.deepEqual(peers.map((w) => w.name), ["tui"]);
});

test("selectPeers excludes windows sharing the caller's session id", () => {
  const project = {
    tmuxSession: "x",
    windows: [
      { index: 0, name: "a", opencodeSessionId: "ses_dup" },
      { index: 1, name: "b", opencodeSessionId: "ses_dup" },
      { index: 2, name: "c", opencodeSessionId: "ses_other" },
    ],
  };
  const self = project.windows[0];
  const peers = selectPeers(project, self);
  assert.deepEqual(peers.map((w) => w.name), ["c"]);
});

// ---------------------------------------------------------------------------
// parseGitStatus
// ---------------------------------------------------------------------------

test("parseGitStatus parses porcelain output", () => {
  const out = " M src/a.ts\n?? new.txt\nA  staged.js\n";
  const r = parseGitStatus(out);
  assert.equal(r.count, 3);
  assert.deepEqual(r.files[0], { status: "M", path: "src/a.ts" });
  assert.deepEqual(r.files[1], { status: "??", path: "new.txt" });
  assert.deepEqual(r.files[2], { status: "A", path: "staged.js" });
});

test("parseGitStatus handles empty/clean output", () => {
  assert.deepEqual(parseGitStatus(""), { count: 0, files: [] });
  assert.deepEqual(parseGitStatus(null), { count: 0, files: [] });
});

// ---------------------------------------------------------------------------
// summarizeTranscript
// ---------------------------------------------------------------------------

const TRANSCRIPT = [
  { info: { role: "user" }, parts: [{ type: "text", text: "do the thing" }] },
  {
    info: { role: "assistant" },
    parts: [
      { type: "text", text: "on it" },
      { type: "tool", tool: "TodoWrite", state: { input: { todos: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "in_progress" },
      ] } } },
      { type: "tool", tool: "bash" },
    ],
  },
];

test("summarizeTranscript pulls last user/assistant text, todos, tools", () => {
  const s = summarizeTranscript(TRANSCRIPT);
  assert.equal(s.lastUser, "do the thing");
  assert.equal(s.lastAssistant, "on it");
  assert.equal(s.todos.length, 2);
  assert.deepEqual(s.lastToolNames, ["TodoWrite", "bash"]);
});

test("summarizeTranscript tolerates empty input", () => {
  assert.deepEqual(summarizeTranscript([]), {
    lastUser: null,
    lastAssistant: null,
    todos: [],
    lastToolNames: [],
  });
});

// ---------------------------------------------------------------------------
// classifyChatStatus
// ---------------------------------------------------------------------------

test("classifyChatStatus prioritizes blocked states", () => {
  assert.equal(classifyChatStatus([], [], [{ id: "q1" }]), "blocked-question");
  assert.equal(classifyChatStatus([], [{ id: "p1" }], []), "blocked-permission");
});

test("classifyChatStatus reports working when last assistant turn is incomplete", () => {
  const msgs = [{ info: { role: "assistant", time: { created: 1 } } }];
  assert.equal(classifyChatStatus(msgs, [], []), "working");
});

test("classifyChatStatus reports idle when last assistant turn completed", () => {
  const msgs = [{ info: { role: "assistant", time: { created: 1, completed: 2 } } }];
  assert.equal(classifyChatStatus(msgs, [], []), "idle");
});

// ---------------------------------------------------------------------------
// describeChatActivity / recentTurns
// ---------------------------------------------------------------------------

test("describeChatActivity prefers the in-progress todo", () => {
  const s = summarizeTranscript(TRANSCRIPT);
  assert.equal(describeChatActivity(s), "todo: step 2");
});

test("describeChatActivity falls back to last assistant text", () => {
  const s = { todos: [], lastAssistant: "thinking about it", lastToolNames: [] };
  assert.equal(describeChatActivity(s), "thinking about it");
});

test("recentTurns returns the last N turns with text + tools", () => {
  const turns = recentTurns(TRANSCRIPT, 6);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  assert.deepEqual(turns[1].tools, ["TodoWrite", "bash"]);
});

// ---------------------------------------------------------------------------
// formatPeerMessage
// ---------------------------------------------------------------------------

test("formatPeerMessage prefixes provenance and reply hint", () => {
  const out = formatPeerMessage({ fromName: "main", fromWorkspace: "alpha", text: "  rebase pls  " });
  assert.ok(out.startsWith('[Message from peer agent session "main" in workspace "alpha"]'));
  assert.ok(out.includes("rebase pls"));
  // body is trimmed
  assert.ok(!out.includes("  rebase pls  "));
  // reply hint names the sender as the reply target
  assert.ok(out.includes('peers_message tool with target "main"'));
});

test("formatPeerMessage tolerates missing workspace/name", () => {
  const out = formatPeerMessage({ text: "hi" });
  assert.ok(out.startsWith('[Message from peer agent session "unknown"]'));
  assert.ok(out.includes("hi"));
});

// ---------------------------------------------------------------------------
// sendPeerMessage
// ---------------------------------------------------------------------------

function harness(extra = {}) {
  const sent = [];
  const deps = {
    listProjects: async () => PROJECTS,
    sendPrompt: async (args) => {
      sent.push(args);
    },
    ...extra,
  };
  return { sent, deps };
}

test("sendPeerMessage injects a wrapped message into the target chat peer", async () => {
  const { sent, deps } = harness();
  // caller is alpha/main (ses_a0); target the sibling "tui" is TUI → use beta? no,
  // peers of alpha exclude beta. Add a second chat window to alpha for this test.
  const projects = [
    {
      tmuxSession: "alpha",
      windows: [
        { index: 0, name: "main", opencodeSessionId: "ses_a0", paneCurrentPath: "/work/alpha" },
        { index: 1, name: "helper", opencodeSessionId: "ses_a1", paneCurrentPath: "/work/alpha" },
      ],
    },
  ];
  deps.listProjects = async () => projects;
  const r = await sendPeerMessage(
    { sessionID: "ses_a0", target: "helper", message: "rebase before continuing" },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(r.from, "main");
  assert.equal(r.to, "helper");
  assert.equal(r.targetSessionId, "ses_a1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "ses_a1");
  assert.ok(sent[0].text.includes('[Message from peer agent session "main" in workspace "alpha"]'));
  assert.ok(sent[0].text.includes("rebase before continuing"));
});

test("sendPeerMessage rejects a TUI (non-chat) peer", async () => {
  const { sent, deps } = harness();
  const r = await sendPeerMessage(
    { sessionID: "ses_a0", target: "tui", message: "hello" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /terminal \(claude-TUI\) session/);
  assert.equal(sent.length, 0);
});

test("sendPeerMessage requires target and message", async () => {
  const { deps } = harness();
  assert.equal((await sendPeerMessage({ sessionID: "ses_a0", message: "x" }, deps)).ok, false);
  assert.equal((await sendPeerMessage({ sessionID: "ses_a0", target: "tui", message: "  " }, deps)).ok, false);
});

test("sendPeerMessage errors when no peer matches the target", async () => {
  const { sent, deps } = harness();
  const r = await sendPeerMessage(
    { sessionID: "ses_a0", target: "ghost", message: "hi" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /No peer matching "ghost"/);
  assert.equal(sent.length, 0);
});

test("sendPeerMessage errors when caller's workspace can't be resolved", async () => {
  const { deps } = harness();
  const r = await sendPeerMessage(
    { sessionID: "ses_nope", directory: "/nope", target: "tui", message: "hi" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not locate your session/);
});
