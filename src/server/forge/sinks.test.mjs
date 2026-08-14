// src/server/forge/sinks.test.mjs — the forge + push progress sinks (BET-798).
// Pure / injected only — no live tmux, opencode or network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ensureCommentByTopic,
  planForgeComment,
  forgeCommentBody,
  isForgeComment,
  pushSinkAction,
  FORGE_TOPIC_PREFIX,
} from "./sinks.mjs";

const repo = { owner: "anomalyco", repo: "manta" };
const topic = "job-1";

// ---------------------------------------------------------------------------
// ensure-comment-by-topic (the forge sink — "two reports produce one comment")
// ---------------------------------------------------------------------------

test("forge sink: two reports produce one comment id (update, not append)", async () => {
  let created = null;
  let updated = null;
  const comments = [];
  const deps = (body) => ({
    repo,
    number: 12,
    topic,
    text: body,
    listComments: async () => ({ data: [...comments] }),
    createComment: async (_r, _n, b) => {
      created = { id: 41, body: b };
      comments.push(created);
      return { data: { id: 41 } };
    },
    updateComment: async (_r, _n, id, b) => {
      updated = { id, body: b };
      const ix = comments.findIndex((c) => c.id === id);
      if (ix >= 0) comments[ix] = { ...comments[ix], body: b };
    },
  });

  // First report: creates the single comment.
  const first = await ensureCommentByTopic(deps("step 1"));
  assert.equal(first.ok, true);
  assert.equal(first.updated, false);
  assert.equal(first.id, 41);
  assert.equal(comments.length, 1);

  // Second report: updates in place — still ONE comment, same id.
  const second = await ensureCommentByTopic(deps("step 2"));
  assert.equal(second.ok, true);
  assert.equal(second.updated, true);
  assert.equal(second.id, 41);
  assert.equal(comments.length, 1);
  assert.ok(isForgeComment(updated.body, topic));
});

test("forge sink: a different topic creates its own comment", async () => {
  const calls = [];
  const comments = [];
  await ensureCommentByTopic({
    repo,
    number: 1,
    topic: "job-a",
    text: "x",
    listComments: async () => ({ data: [...comments] }),
    createComment: async (_r, _n, b) => {
      const id = calls.length;
      calls.push(id);
      comments.push({ id, body: b });
      return { data: { id } };
    },
    updateComment: async () => {},
  });
  await ensureCommentByTopic({
    repo,
    number: 1,
    topic: "job-b",
    text: "y",
    listComments: async () => ({ data: [...comments] }),
    createComment: async (_r, _n, b) => {
      const id = calls.length;
      calls.push(id);
      comments.push({ id, body: b });
      return { data: { id } };
    },
    updateComment: async () => {},
  });
  assert.equal(calls.length, 2); // two distinct topics → two comments
});

test("planForgeComment appends the hidden topic marker and finds it again", () => {
  const plan = planForgeComment([{ id: 1, body: "plain" }], { topic, text: "hello" });
  assert.equal(plan.kind, "create");
  assert.ok(plan.body.includes(FORGE_TOPIC_PREFIX));
  // Once a marker exists, the same topic resolves to update.
  const again = planForgeComment([{ id: 1, body: plan.body }], { topic, text: "world" });
  assert.equal(again.kind, "update");
  assert.equal(again.id, 1);
});

// ---------------------------------------------------------------------------
// push sink — working silent; blocked/failed immediate; done informational
// ---------------------------------------------------------------------------

test("push sink: working produces nothing", () => {
  assert.equal(pushSinkAction({ state: "working", label: "Doing", sessionID: "s" }), null);
});

test("push sink: blocked is an urgent, immediate notification", () => {
  const a = pushSinkAction({ state: "blocked", label: "Need a decision", sessionID: "s" });
  assert.equal(a.urgent, true);
  assert.equal(a.message, "Need a decision");
  assert.equal(a.sessionID, "s");
});

test("push sink: failed is an urgent, immediate notification", () => {
  const a = pushSinkAction({ state: "failed", label: "Build broke", sessionID: "s" });
  assert.equal(a.urgent, true);
});

test("push sink: done is an informational (non-urgent) notification", () => {
  const a = pushSinkAction({ state: "done", label: "All tests pass", sessionID: "s" });
  assert.equal(a.urgent, false);
  assert.equal(a.message, "All tests pass");
});
