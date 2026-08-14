// Tests for appControl.mjs pure logic — no live tmux/opencode/git.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSessionName,
  compactSession,
  switchModel,
  renameSession,
  listSessions,
  dispatch,
} from "./appControl.mjs";

const PROJECTS = [
  {
    tmuxSession: "alpha",
    windows: [
      { index: 0, name: "main", opencodeSessionId: "ses_a0", paneCurrentPath: "/work/alpha" },
      { index: 1, name: "tui", opencodeSessionId: null, paneCurrentPath: "/work/alpha" },
      { index: 2, name: "helper", opencodeSessionId: "ses_a2", paneCurrentPath: "/work/alpha" },
    ],
  },
  {
    tmuxSession: "beta",
    windows: [
      { index: 0, name: "b0", opencodeSessionId: "ses_b0", paneCurrentPath: "/work/beta" },
    ],
  },
];

const MODELS = [
  { providerID: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
  { providerID: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { providerID: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { providerID: "openai", id: "gpt-4o", name: "GPT-4o" },
];

function harness(extra = {}) {
  const published = [];
  const calls = { compact: [], rename: [], branch: 0 };
  const deps = {
    listProjects: async () => PROJECTS,
    listModels: async () => MODELS,
    publish: (payload) => published.push(payload),
    compactSession: async (sid) => calls.compact.push(sid),
    renameWindow: async (args) => calls.rename.push(args),
    getVcsBranch: async () => {
      calls.branch += 1;
      return "main";
    },
    ...extra,
  };
  return { published, calls, deps };
}

// ---------------------------------------------------------------------------
// validateSessionName
// ---------------------------------------------------------------------------

test("validateSessionName accepts a normal 1–40 char name", () => {
  const r = validateSessionName("My Session");
  assert.equal(r.ok, true);
  assert.equal(r.name, "My Session");
});

test("validateSessionName trims surrounding whitespace", () => {
  assert.equal(validateSessionName("  clear  ").name, "clear");
});

test("validateSessionName rejects empty, too-short, and over-40-char names", () => {
  assert.equal(validateSessionName("").ok, false);
  assert.equal(validateSessionName("   ").ok, false);
  assert.equal(validateSessionName("a".repeat(41)).ok, false);
  assert.equal(validateSessionName(null).ok, false);
  assert.equal(validateSessionName(undefined).ok, false);
});

test("validateSessionName rejects ':' and control characters", () => {
  assert.equal(validateSessionName("a:b").ok, false);
  assert.equal(validateSessionName("line\nbreak").ok, false);
  assert.equal(validateSessionName("bad\u0000").ok, false);
});

// ---------------------------------------------------------------------------
// compactSession — session resolution by id and by directory fallback
// ---------------------------------------------------------------------------

test("compactSession resolves by sessionID and compacts that session", async () => {
  const { calls, deps } = harness();
  const r = await compactSession({ sessionID: "ses_a2" }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.compact, ["ses_a2"]);
});

test("compactSession falls back to resolving by directory", async () => {
  const { calls, deps } = harness();
  const r = await compactSession({ sessionID: "ses_unknown", directory: "/work/beta" }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.compact, ["ses_b0"]);
});

test("compactSession errors when the caller's workspace can't be resolved", async () => {
  const { calls, deps } = harness();
  const r = await compactSession({ sessionID: "ses_x", directory: "/nope" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not locate your session/);
  assert.equal(calls.compact.length, 0);
});

// ---------------------------------------------------------------------------
// switchModel — fuzzy match + no-match error listing candidates + bus payload
// ---------------------------------------------------------------------------

test("switchModel matches a fuzzy query and publishes the switch-model payload", async () => {
  const { published, deps } = harness();
  const r = await switchModel({ sessionID: "ses_a0", query: "opus" }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.model, { providerID: "anthropic", modelID: "claude-opus-4-7", name: "Claude Opus 4.7" });
  assert.deepEqual(published, [
    { action: "switch-model", sessionId: "ses_a0", providerID: "anthropic", modelID: "claude-opus-4-7" },
  ]);
});

test("switchModel resolves a multi-token query against a model name", async () => {
  const { deps } = harness();
  const r = await switchModel({ sessionID: "ses_a0", query: "gpt 4o" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.model.modelID, "gpt-4o");
});

test("switchModel no-match error names the closest candidate(s)", async () => {
  const { published, deps } = harness();
  // "claude 32b": the token "claude" hits every id, so suggestModels lists
  // candidates, but no single model contains every token → no match.
  const miss = await switchModel({ sessionID: "ses_a0", query: "claude 32b" }, deps);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /No model matched "claude 32b"/);
  assert.match(miss.error, /Closest models:/);
  assert.equal(published.length, 0);
});

test("switchModel errors without a query and when unresolvable", async () => {
  const { published, deps } = harness();
  const noQ = await switchModel({ sessionID: "ses_a0", query: "  " }, deps);
  assert.equal(noQ.ok, false);
  assert.match(noQ.error, /query is required/);
  const unresolvable = await switchModel({ sessionID: "ses_x", directory: "/nope", query: "opus" }, deps);
  assert.equal(unresolvable.ok, false);
  assert.match(unresolvable.error, /Could not locate your session/);
  assert.equal(published.length, 0);
});

// ---------------------------------------------------------------------------
// renameSession — validation + tmux call + bus payload
// ---------------------------------------------------------------------------

test("renameSession renames the caller's window and publishes the rename payload", async () => {
  const { published, calls, deps } = harness();
  const r = await renameSession({ sessionID: "ses_a0", name: "Fresh Name" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.name, "Fresh Name");
  assert.deepEqual(calls.rename, [{ sessionName: "alpha", windowIndex: 0, newName: "Fresh Name" }]);
  assert.deepEqual(published, [{ action: "rename-session", sessionId: "ses_a0", name: "Fresh Name" }]);
});

test("renameSession rejects an invalid name without calling tmux", async () => {
  const { calls, deps } = harness();
  const r = await renameSession({ sessionID: "ses_a0", name: "has:colon" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot contain ':'/);
  assert.equal(calls.rename.length, 0);
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

test("listSessions returns the caller's workspace windows with flags", async () => {
  const { deps } = harness();
  const r = await listSessions({ sessionID: "ses_a0" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.workspace, "alpha");
  assert.equal(r.self, "main");
  assert.equal(r.sessions.length, 3);
  assert.deepEqual(r.sessions[0], { name: "main", index: 0, chat: true, branch: "main", caller: true });
  assert.deepEqual(r.sessions[1], { name: "tui", index: 1, chat: false, branch: "main", caller: false });
  assert.deepEqual(r.sessions[2], { name: "helper", index: 2, chat: true, branch: "main", caller: false });
});

test("listSessions falls back to resolving by directory", async () => {
  const { deps } = harness();
  const r = await listSessions({ sessionID: "ses_x", directory: "/work/beta" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.workspace, "beta");
  assert.equal(r.self, "b0");
});

test("listSessions errors when unresolvable", async () => {
  const { deps } = harness();
  const r = await listSessions({ sessionID: "ses_x", directory: "/nope" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not locate your session/);
});

// ---------------------------------------------------------------------------
// dispatch — unknown action rejected by name, known actions routed
// ---------------------------------------------------------------------------

test("dispatch rejects an unknown action by name", async () => {
  const { deps } = harness();
  const r = await dispatch("explode-everything", {}, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown action "explode-everything"/);
  assert.match(r.error, /Supported actions:/);
});

test("dispatch routes known actions to their handlers", async () => {
  const { deps } = harness();
  const switchR = await dispatch("switch-model", { sessionID: "ses_a0", query: "haiku" }, deps);
  assert.equal(switchR.ok, true);
  const renameR = await dispatch("rename-session", { sessionID: "ses_a0", name: "Renamed" }, deps);
  assert.equal(renameR.ok, true);
  const compactR = await dispatch("compact-session", { sessionID: "ses_b0" }, deps);
  assert.equal(compactR.ok, true);
  const listR = await dispatch("list-sessions", { sessionID: "ses_a0" }, deps);
  assert.equal(listR.ok, true);
});

test("dispatch with no action reports an unknown action", async () => {
  const { deps } = harness();
  const r = await dispatch(undefined, {}, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown action "undefined"/);
});
