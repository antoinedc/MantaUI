// multica.test.mjs — thin read wrapper over the `multica` CLI (BET-1164).
// Pure logic + injected runCli; no live workspace, no CLI required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { queryMultica, summarizeIssue, workspaceEnv } from "./multica.mjs";

// A fake CLI runner mapping an argv-joined key to a canned JSON stdout. Any
// invocation not in the map throws, so we can pin that a failed subcommand
// degrades rather than failing the whole read.
function fakeCli(map) {
  return async (args) => {
    const key = args.join(" ");
    if (!(key in map)) throw new Error(`no canned response for: ${key}`);
    return map[key];
  };
}

test("queryMultica returns a board overview grouped by status", async () => {
  const runCli = fakeCli({
    "issue list --output json --limit 50": JSON.stringify({
      issues: [
        { identifier: "BET-1", title: "one", status: "todo", status_category: "todo", priority: "high", updated_at: "2026-08-18T00:00:00Z" },
        { identifier: "BET-2", title: "two", status: "done", status_category: "done", priority: "medium" },
        { identifier: "BET-3", title: "three", status: "todo", status_category: "todo" },
      ],
    }),
  });
  const res = await queryMultica({}, { runCli });
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.equal(res.issues.length, 3);
  assert.equal(res.byStatus.todo.length, 2);
  assert.equal(res.byStatus.done.length, 1);
  assert.equal(res.issues[0].identifier, "BET-1");
  assert.equal(res.issues[0].title, "one");
});

test("queryMultica tolerates a plain-array list and a failing CLI (quiet board)", async () => {
  const runCli = fakeCli({
    "issue list --output json --limit 50": JSON.stringify([
      { identifier: "BET-9", status: "todo" },
    ]),
  });
  const res = await queryMultica({}, { runCli });
  assert.equal(res.count, 1);

  // A completely failing CLI → empty board, never throws.
  const failing = async () => {
    throw new Error("multica not installed");
  };
  const res2 = await queryMultica({}, { runCli: failing });
  assert.equal(res2.ok, true);
  assert.equal(res2.count, 0);
  assert.deepEqual(res2.byStatus, {});
});

test("queryMultica with an issue key resolves detail + runs + PRs + children", async () => {
  const runCli = fakeCli({
    "issue get BET-42 --output json": JSON.stringify({ identifier: "BET-42", title: "the thing", status: "in_progress" }),
    "issue runs BET-42 --output json": JSON.stringify([{ id: "run-1", status: "done" }]),
    "issue pull-requests BET-42 --output json": JSON.stringify([{ number: 12, state: "open" }]),
    "issue children BET-42 --output json": JSON.stringify([{ identifier: "BET-43" }]),
  });
  const res = await queryMultica({ issue: "BET-42", query: "what's this" }, { runCli });
  assert.equal(res.ok, true);
  assert.equal(res.issue, "BET-42");
  assert.equal(res.detail.identifier, "BET-42");
  assert.equal(res.detail.title, "the thing");
  assert.equal(res.taskRuns.length, 1);
  assert.equal(res.pullRequests.length, 1);
  assert.equal(res.children.length, 1);
});

test("a failing per-issue subcommand degrades to null, not a failure", async () => {
  // Only `issue get` succeeds; runs/PRs/children throw.
  const runCli = fakeCli({
    "issue get BET-7 --output json": JSON.stringify({ identifier: "BET-7" }),
  });
  const res = await queryMultica({ issue: "BET-7" }, { runCli });
  assert.equal(res.ok, true);
  assert.equal(res.detail.identifier, "BET-7");
  assert.equal(res.taskRuns, null);
  assert.equal(res.pullRequests, null);
  assert.equal(res.children, null);
});

test("summarizeIssue caps description and keeps only safe fields", () => {
  const issue = {
    identifier: "BET-1",
    title: "t",
    status: "done",
    status_category: "done",
    priority: "high",
    assignee_id: "agent-1",
    updated_at: "z",
    labels: ["a"],
    description: "x".repeat(2000),
    pr_url: "https://pr",
    secretKey: "should-be-dropped",
  };
  const s = summarizeIssue(issue);
  assert.equal(s.identifier, "BET-1");
  assert.equal(s.secretKey, undefined);
  assert.equal(s.pr_url, "https://pr");
  assert.equal(s.description.length, 400);
  assert.equal(summarizeIssue(null), null);
});

test("workspaceEnv injects MULTICA_WORKSPACE_ID and preserves the base env", () => {
  const env = workspaceEnv("ws-123", { PATH: "/bin" });
  assert.equal(env.MULTICA_WORKSPACE_ID, "ws-123");
  assert.equal(env.PATH, "/bin");
  // No workspace id → env unchanged.
  const env2 = workspaceEnv(undefined, { PATH: "/bin" });
  assert.equal(env2.MULTICA_WORKSPACE_ID, undefined);
});
