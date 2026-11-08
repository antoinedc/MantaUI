// A background result opencode posts to a RETIRED (handed-off) session is re-admitted at the live end, and the
// retired session is kept from acting on it. Spec: 2026-11-08-background-results-and-viewer-windows.md §B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld, settle } from "./testWorld.mjs";

const OLD = "ses_old";
const NEW = "ses_new";
const CHILD = "ses_child";
const INBOX = "msg_0001result";
const RELAY_ID = /^msg_[0-9a-f]{32}$/;

const link = (replaces, replacedBy) => ({ ...(replaces ? { replaces } : {}), ...(replacedBy ? { replacedBy } : {}), branches: [] });
const result = (id = INBOX, child = CHILD) => ({ id, type: "synthetic", time: { created: 100 }, text: `<subagent sessionID="${child}" state="completed" description="d">\nok\n</subagent>`, description: "d", metadata: { source: "subagent", childID: child, agent: "build", state: "completed" } });
const idle = (id = "msg_idle") => ({ id, type: "idle", outcome: "succeeded", time: { created: 50 } });

/** OLD was handed off to NEW. */
function world() {
  const w = createWorld({ mode: "off" });
  w.addSession(OLD);
  w.addSession(NEW);
  w.disk.json = JSON.stringify({ version: 1, records: {}, links: { [OLD]: link(null, NEW), [NEW]: link(OLD, null) } });
  w.engine = w.build();
  return w;
}
const enqueued = (sid, { inboxID = INBOX, type = "synthetic", metadata = { source: "subagent", childID: CHILD, state: "completed" } } = {}) => ({
  type: "session.inbox.enqueued",
  data: { sessionID: sid, inboxID, item: { type, payload: { text: "<subagent>ok</subagent>", description: "d", metadata }, delivery: "steer" } },
});
const synthPosts = (w, target) => w.posts.filter((p) => p.kind === "synthetic" && p.target === target);

test("a background result arriving on a retired session is admitted at the live end with a deterministic id and the original metadata", async () => {
  const w = world();
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const posts = synthPosts(w, NEW);
  assert.equal(posts.length, 1);
  assert.match(posts[0].id, RELAY_ID);
  assert.equal(posts[0].text, "<subagent>ok</subagent>");
  assert.equal(posts[0].args.description, "d");
  assert.equal(posts[0].args.delivery, "queue");
  assert.equal(posts[0].args.resume, true);
  assert.deepEqual(posts[0].args.metadata, { source: "subagent", childID: CHILD, state: "completed", relayedFrom: OLD, relayedMessageId: INBOX });
  assert.equal(synthPosts(w, OLD).length, 0, "nothing is posted back to the retired session");
});

test("the id depends only on (retired session, original id): a second detection admits nothing more; different results get different ids", async () => {
  const w = world();
  w.engine.observeRaw(enqueued(OLD));
  w.engine.observeRaw(enqueued(OLD)); // the same event twice, concurrently
  await settle();
  w.engine.observeRaw(enqueued(OLD)); // and again after the first finished
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1);
  const first = synthPosts(w, NEW)[0].id;
  // a restarted server (empty in-memory record) re-derives the same id, so opencode admits once
  const reborn = w.build();
  reborn.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(synthPosts(w, NEW).map((p) => p.id), [first, first]);
  w.engine.observeRaw(enqueued(OLD, { inboxID: "msg_0002other" }));
  await settle();
  assert.notEqual(synthPosts(w, NEW).at(-1).id, first);
});

test("a live session, a non-background synthetic and a user item are all ignored", async () => {
  const w = world();
  w.engine.observeRaw(enqueued(NEW)); // the live end takes its own results
  w.engine.observeRaw(enqueued(OLD, { metadata: { source: "something-else" } }));
  w.engine.observeRaw(enqueued(OLD, { type: "user" }));
  w.engine.observeRaw({ type: "session.inbox.delivered", data: { sessionID: OLD, inboxID: INBOX } });
  w.engine.observeRaw(null);
  w.engine.observeRaw({ type: "session.inbox.enqueued", data: {} });
  await settle();
  assert.equal(w.posts.length, 0);
});

test("it reads the real V2 event recorded from the pinned binary (fixture)", async () => {
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/opencodeV2Events/10-background-arrival.events.json", import.meta.url)), "utf8"));
  const w = createWorld({ mode: "off" });
  w.addSession(fx.parentSessionID);
  w.addSession(NEW);
  w.disk.json = JSON.stringify({ version: 1, records: {}, links: { [fx.parentSessionID]: link(null, NEW), [NEW]: link(fx.parentSessionID, null) } });
  w.engine = w.build();
  for (const ev of fx.events) w.engine.observeRaw(ev);
  await settle();
  const posts = synthPosts(w, NEW);
  assert.equal(posts.length, 1, "only the enqueue announces it");
  const original = fx.timeline.find((r) => r.type === "synthetic");
  assert.equal(posts[0].args.metadata.relayedMessageId, original.id, "the inbox id is the timeline record's id");
  assert.equal(posts[0].args.metadata.childID, original.metadata.childID);
  assert.equal(posts[0].text, original.text);
});

// ---- keeping the retired session from acting ---------------------------------------------------------

test("a result still pending in the retired session's inbox is cancelled (and nothing is interrupted)", async () => {
  const w = world();
  w.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  w.active.add(OLD);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(w.cancelled, [[OLD, INBOX]]);
  assert.deepEqual(w.interrupted, []);
});

test("an execution the result itself started is interrupted — and only that one", async () => {
  // the result arrived on an idle session and nothing has ended since: it woke the session
  const woken = world();
  woken.active.add(OLD);
  woken.timelines.set(OLD, [{ id: "msg_u", type: "user", time: { created: 1 } }, idle(), result()]);
  woken.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(woken.interrupted, [OLD]);
  assert.deepEqual(woken.timelineReads.map(([, o]) => o.maxPages), [1], "the newest page only");

  // two results joined the same wake: still that wake
  const joined = world();
  joined.active.add(OLD);
  joined.timelines.set(OLD, [idle(), result("msg_a"), result("msg_b")]);
  joined.engine.observeRaw(enqueued(OLD, { inboxID: "msg_b" }));
  await settle();
  assert.deepEqual(joined.interrupted, [OLD]);

  // someone else was driving the session when the result arrived (a turn in progress before it)
  const driven = world();
  driven.active.add(OLD);
  driven.timelines.set(OLD, [idle(), { id: "msg_u", type: "user", time: { created: 1 } }, { id: "msg_a", type: "assistant", time: { created: 2 } }, result()]);
  driven.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(driven.interrupted, [], "an execution that started before the result arrived is never interrupted");

  // the wake the result caused already ended; what is running now is a different execution
  const later = world();
  later.active.add(OLD);
  later.timelines.set(OLD, [idle(), result(), idle("msg_idle2"), { id: "msg_u2", type: "user", time: { created: 200 } }]);
  later.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(later.interrupted, []);

  // the retired session is not running: nothing to stop
  const quiet = world();
  quiet.timelines.set(OLD, [idle(), result()]);
  quiet.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(quiet.interrupted, []);
  assert.equal(synthPosts(quiet, NEW).length, 1, "it was still relayed");

  // the result isn't in the newest page (or the timeline can't be read): not provably the cause, so left alone
  const unknown = world();
  unknown.active.add(OLD);
  unknown.timelines.set(OLD, [idle(), { id: "msg_x", type: "assistant", time: { created: 1 } }]);
  unknown.engine.observeRaw(enqueued(OLD));
  const broken = world();
  broken.active.add(OLD);
  broken.failures.timeline = true;
  broken.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(unknown.interrupted, []);
  assert.deepEqual(broken.interrupted, []);
  assert.equal(synthPosts(broken, NEW).length, 1, "a failure keeping the old session quiet never undoes the relay");
});

test("when the relay fails the retired session keeps its copy (it is not cancelled or interrupted)", async () => {
  const w = world();
  w.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  w.active.add(OLD);
  w.timelines.set(OLD, [idle(), result()]);
  w.failures.send.push({ status: 400 });
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(w.cancelled, []);
  assert.deepEqual(w.interrupted, []);
  // …and a later attempt (the backstop) can still relay it
  w.timelines.set(OLD, [idle(), result()]);
  w.inbox.set(OLD, []);
  const out = await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD });
  assert.deepEqual(out, { relayed: true });
  assert.equal(synthPosts(w, NEW).length, 2, "the failed post and the retry");
});

// ---- the backstop -------------------------------------------------------------------------------------

test("relayBackgroundResult: relays the newest result for the child; no-op for a live session; reasons for the rest", async () => {
  const w = world();
  w.timelines.set(OLD, [idle(), result("msg_old1"), result("msg_other", "ses_other"), result("msg_new1")]);
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: NEW, childSessionId: CHILD }), { relayed: false, reason: "live" });
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_unknown", childSessionId: CHILD }), { relayed: false, reason: "live" });
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD }), { relayed: false, reason: "invalid" });
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: "ses_nothing" }), { relayed: false, reason: "none" });
  assert.equal(w.posts.length, 0);

  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: true });
  const posts = synthPosts(w, NEW);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].args.metadata.relayedMessageId, "msg_new1", "the newest record for that child");
  assert.deepEqual(w.timelineReads[0], [OLD, { type: "synthetic" }]);

  // calling it again — or after the event path saw the same result — admits nothing more
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: true, reason: "already" });
  w.engine.observeRaw(enqueued(OLD, { inboxID: "msg_new1" }));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1);

  w.failures.timeline = true;
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: "ses_third" }), { relayed: false, reason: "unreadable" });
});

test("a relay during a handoff transition is held for the successor, in order, like any other admission", async () => {
  const w = world();
  w.engine._state.fences[NEW] = { successorId: "ses_next", recordId: "hof_x" };
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 0, "not posted while NEW is fenced");
  assert.equal(w.engine._state.held[NEW]?.length, 1);
  assert.match(w.engine._state.held[NEW][0].id, RELAY_ID);
});
