// A background result opencode posts to a RETIRED (handed-off) session is re-admitted at the live end, and the
// retired session is kept from acting on it. Spec: 2026-11-08-background-results-and-viewer-windows.md §B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorld, readyRecord, settle } from "./testWorld.mjs";

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
  w.emit = (e) => w.engine.observeRaw(e); // opencode's raw stream reaches the engine (the cancel evidence comes through it)
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
  w.engine.observeRaw(enqueued(OLD, { inboxID: "msg_0002other" }));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 2);
  assert.notEqual(synthPosts(w, NEW)[1].id, synthPosts(w, NEW)[0].id);
});

test("a restart between the event and the backstop posts nothing more and wakes nothing: the relay state is durable", async () => {
  const w = world();
  w.timelines.set(OLD, [idle(), result()]);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1);
  assert.deepEqual(w.interrupted, []);
  const id = synthPosts(w, NEW)[0].id;
  const saved = JSON.parse(w.disk.json).relays[id];
  assert.equal(saved.admitted, true);
  assert.equal(saved.suppressed, "idle", "the retired session was not running: settled");

  const reborn = w.build();
  assert.deepEqual(await reborn.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: true, reason: "already" });
  reborn.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1, "zero additional POSTs");
  assert.deepEqual(w.interrupted, []);
  assert.deepEqual(w.cancelled, []);
});

test("a crash between the POST and the save: the restarted engine finds the id at the destination and does not post again", async () => {
  const w = world();
  w.timelines.set(OLD, [idle(), result()]);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const posted = synthPosts(w, NEW).length;
  assert.equal(posted, 1);
  const disk = JSON.parse(w.disk.json);
  disk.relays = {}; // the save never happened
  w.disk.json = JSON.stringify(disk);
  const reborn = w.build();
  assert.deepEqual(await reborn.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: true });
  assert.equal(synthPosts(w, NEW).length, 1, "reconciled by id: present, so not posted");
  assert.equal(reborn._state.relays[synthPosts(w, NEW)[0].id].admitted, true, "and recorded as admitted again");
});

test("relay entries are bounded: older than 7 days are pruned (at the next sweep), the rest stay", async () => {
  const w = world();
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const id = Object.keys(w.engine._state.relays)[0];
  w.engine._state.relays.msg_stale = { admitted: true, suppressed: "idle", at: w.clock - 8 * 24 * 3600_000 };
  await w.engine.sweep();
  assert.ok(w.engine._state.relays[id]);
  assert.equal(w.engine._state.relays.msg_stale, undefined);
  w.clock += 8 * 24 * 3600_000;
  await w.engine.sweep();
  assert.deepEqual(Object.keys(w.engine._state.relays), []);
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
  assert.equal(w.engine._state.relays[synthPosts(w, NEW)[0].id].suppressed, "cancelled");
});

test("cancel is not proof: the item was listed, then delivered before the cancel — the execution check decides, not the cancel", async () => {
  const w = world();
  w.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  w.active.add(OLD);
  w.timelines.set(OLD, [idle(), result()]);
  w.onCancel = async (sid, inboxId) => {
    // delivered between the list and the cancel: the DELETE is a 204 no-op, the item is no longer pending
    w.inbox.set(sid, []);
    w.messages.set(sid, new Map([[inboxId, { id: inboxId }]]));
    w.emit({ type: "session.inbox.delivered", data: { sessionID: sid, inboxID: inboxId } });
  };
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(w.cancelled, [[OLD, INBOX]]);
  assert.deepEqual(w.interrupted, [OLD], "it had woken the session");
  assert.equal(w.engine._state.relays[synthPosts(w, NEW)[0].id].suppressed, "interrupted");
});

test("cancel is not proof: absent afterwards without a cancelled event or a delivery is 'unknown' — nothing is interrupted, the relay is not reposted, a later detection settles it", async () => {
  const w = world();
  w.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  w.active.add(OLD);
  w.timelines.set(OLD, [idle()]); // the result is not in the timeline: not delivered (yet)
  w.onCancel = async () => {}; // a 204 that proves nothing
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const id = synthPosts(w, NEW)[0].id;
  assert.deepEqual(w.interrupted, []);
  assert.deepEqual(w.engine._state.relays[id], { ...w.engine._state.relays[id], admitted: true, suppressed: null }, "admitted, suppression still open");
  // the backstop: the item is gone from the inbox now and the session is still running the wake
  w.onCancel = null;
  w.inbox.set(OLD, []);
  w.timelines.set(OLD, [idle(), result()]); // it was delivered after all, and woke the session
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: true });
  assert.equal(synthPosts(w, NEW).length, 1, "suppression was retried WITHOUT reposting");
  assert.deepEqual(w.interrupted, [OLD]);
  assert.equal(w.engine._state.relays[id].suppressed, "interrupted");
});

test("an execution the result itself started is interrupted — and only that one", async () => {
  // the result arrived on an idle session and nothing has ended since: it woke the session
  const woken = world();
  woken.active.add(OLD);
  woken.timelines.set(OLD, [{ id: "msg_u", type: "user", time: { created: 1 } }, idle(), result()]);
  woken.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(woken.interrupted, [OLD]);
  assert.deepEqual(woken.timelineReads.filter(([sid]) => sid === OLD).map(([, o]) => o.maxPages), [1, 1], "the newest page only, read twice (the second read is the one right before the interrupt)");

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
  broken.beforeTimeline = async (sid) => {
    if (sid === OLD) throw new Error("timeline unreadable"); // only the retired session's reads fail: the destination can be asked
  };
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

// ---- never interrupt a later execution --------------------------------------------------------------------

test("execution turnover between the first evidence read and the interrupt: the second read sees the newer idle — no interrupt", async () => {
  const w = world();
  w.active.add(OLD);
  w.timelines.set(OLD, [idle(), result()]);
  let oldReads = 0;
  w.beforeTimeline = async (sid) => {
    if (sid !== OLD) return;
    // the woken execution ends and somebody starts a new one right after our first read
    if (++oldReads === 2) w.timelines.set(OLD, [idle(), result(), idle("msg_idle2"), { id: "msg_u2", type: "user", time: { created: 300 } }]);
  };
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(oldReads, 2, "the evidence was re-read before acting");
  assert.deepEqual(w.interrupted, []);
  assert.equal(w.engine._state.relays[synthPosts(w, NEW)[0].id].suppressed, "left");
});

test("…and when the session went idle between the two reads, nothing is interrupted either", async () => {
  const w = world();
  w.active.add(OLD);
  w.timelines.set(OLD, [idle(), result()]);
  let oldReads = 0;
  w.beforeTimeline = async (sid) => {
    if (sid === OLD && ++oldReads === 1) w.active.delete(OLD); // the second active check answers "not running"
  };
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(w.interrupted, []);
  assert.equal(w.engine._state.relays[synthPosts(w, NEW)[0].id].suppressed, "idle");
});

// ---- results that land during a handoff transition ---------------------------------------------------------

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
/** ses_p with a window; an engine whose start parks inside the fence (after the successor is created, before the commit). */
function fencedWorld() {
  const w = createWorld({ mode: "off" });
  w.addSession("ses_p");
  w.addWindow("proj", 3, "work", "ses_p");
  const release = gate();
  const reached = gate();
  w.engine = w.build({ hooks: { step: async (n) => { if (n === "create") { reached.open(); await release.p; } } } });
  w.emit = (e) => w.engine.observeRaw(e);
  return { w, release: release.open, reached: reached.p };
}

test("a result that lands on the predecessor during the fence — and whose job settles before the commit — reaches the successor exactly once, after the commit", async () => {
  const { w, release, reached } = fencedWorld();
  const r = await readyRecord(w);
  const started = w.engine.start(r.id, { how: "clear", disposition: "send" });
  await reached;
  assert.ok(w.engine._state.fences.ses_p, "the fence is up");

  w.engine.observeRaw(enqueued("ses_p"));
  await settle();
  assert.equal(w.engine._state.arrivals.ses_p.length, 1, "recorded");
  assert.equal(JSON.parse(w.disk.json).arrivals.ses_p[0].id, INBOX, "and persisted");
  // the delegate engine's backstop runs when the child's record settles — before the commit there is no link: it records the
  // result through the same arrival path (the same id as the event's record, so it is still ONE arrival)
  w.timelines.set("ses_p", [idle(), result()]);
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: false, reason: "fenced" });
  assert.equal(w.engine._state.arrivals.ses_p.length, 1);
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 0);

  release();
  const out = await started;
  await settle();
  assert.equal(out.state, "committed");
  const posts = synthPosts(w, out.successorId);
  assert.equal(posts.length, 1, "relayed to the successor");
  assert.equal(posts[0].args.metadata.relayedFrom, "ses_p");
  assert.equal(posts[0].args.metadata.relayedMessageId, INBOX);
  assert.equal(w.engine._state.arrivals.ses_p, undefined, "the recorded arrival is consumed");
  // the backstop later: still exactly once
  w.timelines.set("ses_p", [idle(), result()]);
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: true, reason: "already" });
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 1);
});

test("a rolled-back handoff drops what arrived during its fence: the predecessor stays live and already has it", async () => {
  const { w, release, reached } = fencedWorld();
  const r = await readyRecord(w);
  w.failures.send.push({ status: 400 }); // the successor refuses the first message: the start rolls back
  const started = w.engine.start(r.id, { how: "clear", disposition: "send" });
  await reached;
  w.engine.observeRaw(enqueued("ses_p"));
  await settle();
  assert.equal(w.engine._state.arrivals.ses_p.length, 1);
  release();
  await started;
  await settle();
  assert.equal(w.engine._state.records[r.id].state, "failed");
  assert.equal(w.engine._state.arrivals.ses_p, undefined);
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 0, "nothing was relayed anywhere");
  assert.equal(w.engine.successorOf("ses_p"), null);
});

test("boot recovery: an arrival whose link now exists is relayed; one whose handoff never committed is dropped", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession(OLD);
  w.addSession(NEW);
  w.addSession("ses_live");
  const arrival = { id: INBOX, text: "t", metadata: { source: "subagent", childID: CHILD }, at: 1 };
  w.disk.json = JSON.stringify({
    version: 1,
    records: {},
    links: { [OLD]: link(null, NEW), [NEW]: link(OLD, null) },
    arrivals: { [OLD]: [arrival], ses_live: [{ ...arrival, id: "msg_other" }] },
  });
  w.engine = w.build();
  await w.engine.recover();
  await settle(10); // the paced maintenance pass recovery starts
  assert.equal(synthPosts(w, NEW).length, 1, "the committed one is relayed");
  assert.equal(synthPosts(w, "ses_live").length, 0);
  assert.deepEqual(w.engine._state.arrivals, {}, "consumed / dropped");
});

// ---- the backstop during a fence (a missed enqueue event) -------------------------------------------------

test("the enqueue event was MISSED: the child settles during the fence, the backstop records the result, the commit relays it exactly once", async () => {
  const { w, release, reached } = fencedWorld();
  const r = await readyRecord(w);
  const started = w.engine.start(r.id, { how: "clear", disposition: "send" });
  await reached;
  // no observeRaw at all: opencode's stream missed the enqueue. The result sits in the predecessor's timeline.
  w.timelines.set("ses_p", [idle(), result()]);
  assert.equal(w.engine._state.arrivals.ses_p, undefined);
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: false, reason: "fenced" });
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: false, reason: "fenced" }, "asking again records nothing new");
  assert.equal(w.engine._state.arrivals.ses_p.length, 1);
  assert.equal(JSON.parse(w.disk.json).arrivals.ses_p[0].id, INBOX, "persisted");
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 0);

  release();
  const out = await started;
  await settle();
  assert.equal(out.state, "committed");
  assert.equal(synthPosts(w, out.successorId).length, 1, "the successor received it");
  assert.equal(synthPosts(w, out.successorId)[0].args.metadata.relayedMessageId, INBOX);
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: true, reason: "already" });
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 1, "exactly once");
});

test("the fenced backstop: a rolled-back handoff drops what it recorded; nothing for a child with no result", async () => {
  const { w, release, reached } = fencedWorld();
  const r = await readyRecord(w);
  w.failures.send.push({ status: 400 });
  const started = w.engine.start(r.id, { how: "clear", disposition: "send" });
  await reached;
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD }), { relayed: false, reason: "none" });
  w.timelines.set("ses_p", [idle(), result()]);
  await w.engine.relayBackgroundResult({ sessionId: "ses_p", childSessionId: CHILD });
  assert.equal(w.engine._state.arrivals.ses_p.length, 1);
  release();
  await started;
  await settle();
  assert.equal(w.engine._state.arrivals.ses_p, undefined);
  assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, 0);
});

// ---- unknown presence never authorizes a POST --------------------------------------------------------------

test("a POST landed but its receipt wasn't saved; after a restart the destination can't be read — no POST; once readable and present the receipt completes without a POST", async () => {
  const w = world();
  w.timelines.set(OLD, [idle(), result()]);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1);
  const disk = JSON.parse(w.disk.json);
  disk.relays = {}; // the receipt was never saved
  w.disk.json = JSON.stringify(disk);
  const reborn = w.build();
  w.failReads.add(NEW); // opencode answers nothing for the destination right now
  assert.deepEqual(await reborn.relayBackgroundResult({ sessionId: OLD, childSessionId: CHILD }), { relayed: false, reason: "deferred" });
  assert.equal(synthPosts(w, NEW).length, 1, "unknown presence never posts");
  const id = Object.keys(reborn._state.relays)[0];
  assert.equal(reborn._state.relays[id].admitted, false, "deferred, durably");
  assert.equal(JSON.parse(w.disk.json).relays[id].admitted, false);
  assert.ok(reborn._state.relays[id].rec, "with what it takes to retry it");

  w.failReads.delete(NEW);
  await reborn.maintain();
  assert.equal(reborn._state.relays[id].admitted, false, "(before the backoff is over nothing is retried)");
  w.clock += 10 * 60_000;
  await reborn.maintain();
  assert.equal(synthPosts(w, NEW).length, 1, "present: the receipt is completed WITHOUT a POST");
  assert.equal(reborn._state.relays[id].admitted, true);
});

test("an unreadable destination defers, an absent one posts: the strict read decides (a lenient null is not 'absent')", async () => {
  const w = world();
  w.failReads.add(NEW);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 0);
  w.failReads.delete(NEW);
  w.clock += 10 * 60_000;
  await w.engine.maintain();
  assert.equal(synthPosts(w, NEW).length, 1, "now absent for sure: one post");
});

test("a failed POST is retried by presence check — it may have landed — never blindly", async () => {
  const w = world();
  w.failures.send.push({ land: true }); // the connection reset after the message was accepted
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(w, NEW).length, 1);
  const id = Object.keys(w.engine._state.relays)[0];
  assert.equal(w.engine._state.relays[id].admitted, false);
  w.clock += 10 * 60_000;
  await w.engine.maintain();
  assert.equal(synthPosts(w, NEW).length, 1, "found at the destination: recorded, not posted again");
  assert.equal(w.engine._state.relays[id].admitted, true);
});

test("uncertain held-message retries share the rule: reads that fail never authorize a re-post; a readable 'missing' does", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession("ses_t");
  w.disk.json = JSON.stringify({ version: 1, records: {}, links: {}, held: { ses_t: [{ id: "msg_held", kind: "synthetic", args: { id: "msg_held", text: "x" }, at: 1, attempted: true }] } });
  w.engine = w.build();
  w.failReads.add("ses_t");
  await w.engine._drainHeld("ses_t");
  assert.equal(w.posts.length, 0, "the earlier attempt may have landed: no blind post");
  assert.equal(w.engine._state.held.ses_t.length, 1, "still held");
  w.failReads.delete("ses_t");
  await w.runTimers();
  assert.equal(w.posts.length, 1, "readable and absent: posted");
  assert.equal(w.engine._state.held.ses_t, undefined);
});

// ---- the retry driver --------------------------------------------------------------------------------------

test("cancel unknown: a later maintenance pass confirms and suppresses with zero POSTs, after the backoff", async () => {
  const w = world();
  w.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  w.active.add(OLD);
  w.timelines.set(OLD, [idle()]);
  w.onCancel = async () => {}; // proves nothing
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const id = Object.keys(w.engine._state.relays)[0];
  assert.equal(w.engine._state.relays[id].suppressed, null);
  assert.ok(w.engine._state.relays[id].nextAt > w.clock, "backed off");
  // it turned out to be delivered, and woke the session
  w.onCancel = null;
  w.inbox.set(OLD, []);
  w.timelines.set(OLD, [idle(), result()]);
  await w.engine.maintain();
  assert.equal(w.engine._state.relays[id].suppressed, null, "not before the backoff is over");
  assert.deepEqual(w.interrupted, []);
  w.clock += 10 * 60_000;
  await w.engine.maintain();
  assert.deepEqual(w.interrupted, [OLD]);
  assert.equal(w.engine._state.relays[id].suppressed, "interrupted");
  assert.equal(w.engine._state.relays[id].nextAt, undefined);
  assert.equal(synthPosts(w, NEW).length, 1, "zero additional POSTs");
});

test("boot recovery starts the retry too; a pass is bounded and each entry backs off", async () => {
  const w = world();
  w.failReads.add(NEW);
  for (let i = 0; i < 6; i++) w.engine.observeRaw(enqueued(OLD, { inboxID: `msg_000${i}` }));
  await settle();
  assert.equal(Object.keys(w.engine._state.relays).length, 6);
  assert.ok(Object.values(w.engine._state.relays).every((e) => !e.admitted && e.tries === 1));
  w.clock += 10 * 60_000;
  await w.engine.maintain({ limit: 4 });
  const tries = Object.values(w.engine._state.relays).map((e) => e.tries).sort();
  assert.deepEqual(tries, [1, 1, 2, 2, 2, 2], "four entries were attempted in that pass");
  w.failReads.delete(NEW);
  w.clock += 60 * 60_000;
  const reborn = w.build();
  await reborn.recover();
  await settle(12);
  assert.ok(Object.values(reborn._state.relays).every((e) => e.admitted), "recovery finished them");
  assert.equal(synthPosts(w, NEW).length, 6);
});

test("unresolved relays are never pruned as receipts, survive an arrival flush, and expire hard after 7 days with a log line", async () => {
  const w = world();
  w.failReads.add(NEW);
  w.engine.observeRaw(enqueued(OLD));
  await settle();
  const id = Object.keys(w.engine._state.relays)[0];
  // a flush of arrivals recorded for the same session leaves relay records alone
  w.engine._state.arrivals[OLD] = [{ id: "msg_other", metadata: { source: "subagent", childID: "ses_o" }, at: 1 }];
  await w.engine.maintain();
  assert.equal(w.engine._state.arrivals[OLD], undefined, "the arrivals were consumed");
  assert.ok(w.engine._state.relays[id], "the unresolved relay survived the flush");
  assert.equal(Object.keys(w.engine._state.relays).length, 2, "the flushed arrival is tracked durably too");
  // 6 days: still there
  w.clock += 6 * 24 * 3600_000;
  await w.engine.maintain();
  assert.ok(w.engine._state.relays[id]);
  // past 7 days: dropped, logged
  w.clock += 2 * 24 * 3600_000;
  await w.engine.maintain();
  assert.equal(w.engine._state.relays[id], undefined);
  assert.ok(w.logs.some((l) => /dropped unresolved relay/.test(l) && l.includes(id)), "a log line says it was dropped");
  assert.equal(JSON.parse(w.disk.json).relays[id], undefined);
});

// ---- the link cut while a relay is in flight (the original is live again) --------------------------------

/** What the repair does to the link. */
const cutLink = (w) => {
  delete w.engine._state.links[OLD];
  delete w.engine._state.links[NEW];
};

test("a cut racing a relay: before the admission nothing is posted to the now-live original; after it the receipt stays and nothing is suppressed", async () => {
  // cut while the destination is being asked
  const early = world();
  early.beforeTimeline = async (sid) => {
    if (sid === NEW) cutLink(early); // relayPresence's last read
  };
  early.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(early.posts.length, 0, "no second copy of its own result for the live original");
  assert.deepEqual(early.cancelled.concat(early.interrupted), []);

  // cut while the retired session is being inspected: the copy is admitted, the original is left alone
  const mid = world();
  mid.inbox.set(OLD, [{ id: INBOX, type: "synthetic" }]);
  mid.active.add(OLD);
  mid.timelines.set(OLD, [idle(), result()]);
  mid.beforeInbox = async (sid) => {
    if (sid === OLD) cutLink(mid);
  };
  mid.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.equal(synthPosts(mid, NEW).length, 1, "the admitted receipt stays");
  assert.deepEqual(mid.cancelled, [], "…but the now-live original is not cancelled");
  assert.deepEqual(mid.interrupted, [], "…nor interrupted");
  const entry = Object.values(mid.engine._state.relays)[0];
  assert.equal(entry.admitted, true);
  assert.equal(entry.suppressed, "left");

  // cut between the second evidence read and the interrupt
  const late = world();
  late.active.add(OLD);
  late.timelines.set(OLD, [idle(), result()]);
  let reads = 0;
  late.beforeTimeline = async (sid) => {
    if (sid === OLD && ++reads === 2) cutLink(late);
  };
  late.engine.observeRaw(enqueued(OLD));
  await settle();
  assert.deepEqual(late.interrupted, []);
  assert.equal(Object.values(late.engine._state.relays)[0].suppressed, "left");
});

test("the retry driver closes an entry whose link was cut: an admitted copy stays as a receipt, an unadmitted one is dropped", async () => {
  const w = world();
  w.failReads.add(NEW);
  w.engine.observeRaw(enqueued(OLD)); // deferred
  await settle();
  const deferred = Object.keys(w.engine._state.relays)[0];
  w.engine._state.relays.msg_admitted = { admitted: true, suppressed: null, at: w.clock, from: OLD, original: "msg_x", tries: 1, nextAt: 0 };
  cutLink(w);
  w.clock += 10 * 60_000;
  await w.engine.maintain();
  assert.equal(w.engine._state.relays[deferred], undefined, "nothing to relay for a live original");
  assert.equal(w.engine._state.relays.msg_admitted.suppressed, "left");
  assert.equal(w.posts.length, 0);
});
