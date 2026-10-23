// The K3/K4 pending-user-message list: the interpreter's snapshot state machine
// (hydration, window log, rev/epoch) and the authoritative cancel outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInboxOp, createStreamInterpreter, inboxItemFromV2, inboxOpFromEvent } from "./streamInterp.mjs";

const SID = "ses_main";
let n = 0;
const ev = (type, data = {}, extra = {}) => ({ id: `evt_${++n}`, type, created: 7000, data: { sessionID: SID, ...data }, ...extra });
const enq = (id, text = id, delivery = "steer", type = "user") =>
  ev("session.inbox.enqueued", { inboxID: id, item: { type, payload: { text }, delivery } });
const delivered = (id) => ev("session.inbox.delivered", { inboxID: id });
const cancelled = (id) => ev("session.inbox.cancelled", { inboxID: id });
const changed = (id, delivery) => ev("session.inbox.delivery.changed", { inboxID: id, delivery });
const rawItem = (id, text = id, delivery = "steer", created = 100, files) => ({
  id, sessionID: SID, type: "user", delivery, time: { created }, payload: { text, ...(files ? { files } : {}) },
});

const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function make({ listInbox, epoch = "epoch-1" } = {}) {
  const events = [];
  const calls = [];
  let clock = 1_000_000;
  const timers = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => clock,
    epoch,
    listInbox: listInbox
      ? (sid) => {
          calls.push(sid);
          return listInbox(sid);
        }
      : null,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.dead = true; },
  });
  const advance = (ms) => {
    clock += ms;
    for (const t of timers.filter((x) => !x.dead && x.at <= clock)) {
      t.dead = true;
      t.fn();
    }
  };
  const frames = () => events.filter((e) => e.sub === "inbox").map((e) => e.payload);
  return { interp, events, calls, frames, advance };
}

// ---- pure core ----------------------------------------------------------------

test("inboxItemFromV2 keeps only user items and maps the K2 shape", () => {
  assert.deepEqual(inboxItemFromV2(rawItem("msg_1", "hi", "queue", 55, [{}, {}])), { id: "msg_1", text: "hi", delivery: "queue", createdAt: 55, attachmentCount: 2 });
  assert.equal(inboxItemFromV2({ ...rawItem("msg_1"), type: "synthetic" }), null);
  assert.equal(inboxItemFromV2({ ...rawItem("msg_1"), type: "compaction" }), null);
  assert.equal(inboxItemFromV2(null), null);
  // an event's item has no id/time of its own
  assert.deepEqual(inboxItemFromV2({ type: "user", payload: { text: "x" } }, { id: "msg_e", created: 9 }), { id: "msg_e", text: "x", delivery: "steer", createdAt: 9, attachmentCount: 0 });
});

test("inboxOpFromEvent reads the V2 event fields (inboxID / item / delivery)", () => {
  assert.deepEqual(inboxOpFromEvent(enq("msg_1", "hi", "queue")), { op: "add", item: { id: "msg_1", text: "hi", delivery: "queue", createdAt: 7000, attachmentCount: 0 } });
  assert.equal(inboxOpFromEvent(enq("msg_s", "x", "steer", "synthetic")), null);
  assert.deepEqual(inboxOpFromEvent(delivered("msg_1")), { op: "remove", id: "msg_1" });
  assert.deepEqual(inboxOpFromEvent(cancelled("msg_1")), { op: "remove", id: "msg_1" });
  assert.deepEqual(inboxOpFromEvent(changed("msg_1", "steer")), { op: "delivery", id: "msg_1", delivery: "steer" });
  assert.equal(inboxOpFromEvent(changed("msg_1", "bogus")), null);
  assert.equal(inboxOpFromEvent(ev("session.inbox.delivered", {})), null);
});

test("applyInboxOp is idempotent", () => {
  const a = { id: "a", text: "a", delivery: "queue", createdAt: 1, attachmentCount: 0 };
  let r = applyInboxOp([], { op: "add", item: a });
  assert.equal(r.changed, true);
  assert.equal(applyInboxOp(r.items, { op: "add", item: a }).changed, false, "an enqueue of a present id is ignored");
  assert.equal(applyInboxOp(r.items, { op: "remove", id: "zzz" }).changed, false, "removing an absent id is a no-op");
  r = applyInboxOp(r.items, { op: "delivery", id: "a", delivery: "steer" });
  assert.equal(r.items[0].delivery, "steer");
  assert.equal(applyInboxOp(r.items, { op: "delivery", id: "a", delivery: "steer" }).changed, false);
  assert.equal(applyInboxOp(r.items, { op: "delivery", id: "nope", delivery: "queue" }).changed, false);
});

// ---- hydration + window log ----------------------------------------------------

test("the first inbox event for an unknown session triggers ONE hydration; the result + replayed window log is emitted with rev 1", async () => {
  const d = deferred();
  const { interp, calls, frames } = make({ listInbox: () => d.promise });
  interp.interpret(enq("msg_2", "second"));
  interp.interpret(enq("msg_3", "third", "queue"));
  assert.equal(calls.length, 1, "one hydration in flight per session");
  assert.deepEqual(frames(), [], "nothing is emitted while the snapshot is unknown");
  d.resolve([rawItem("msg_1", "first", "steer", 10), rawItem("msg_2", "second", "steer", 20)]);
  await tick();
  const [f] = frames();
  assert.equal(frames().length, 1);
  assert.equal(f.epoch, "epoch-1");
  assert.equal(f.rev, 1);
  assert.deepEqual(f.items.map((i) => i.id), ["msg_1", "msg_2", "msg_3"], "GET order first, then the window log appended; msg_2 not duplicated");
  assert.equal(f.items[2].delivery, "queue");
});

test("window-log replay applies delivered/cancelled/delivery.changed in arrival order", async () => {
  const d = deferred();
  const { interp, frames } = make({ listInbox: () => d.promise });
  interp.interpret(enq("msg_a"));
  interp.interpret(changed("msg_a", "queue"));
  interp.interpret(enq("msg_b"));
  interp.interpret(delivered("msg_b"));
  interp.interpret(cancelled("msg_gone")); // never in the GET: no-op
  d.resolve([rawItem("msg_old", "old"), rawItem("msg_a", "msg_a", "steer")]);
  await tick();
  assert.deepEqual(frames()[0].items.map((i) => [i.id, i.delivery]), [["msg_old", "steer"], ["msg_a", "queue"]]);
});

test("a GET that already reflects a delivered item, replayed with its delivered event, stays correct", async () => {
  const d = deferred();
  const { interp, frames } = make({ listInbox: () => d.promise });
  interp.interpret(enq("msg_x"));
  interp.interpret(delivered("msg_x"));
  d.resolve([]); // x was delivered before the GET ran
  await tick();
  assert.deepEqual(frames()[0].items, []);
});

test("once known: enqueue appends, delivered/cancelled remove, delivery.changed sets — each rev++ and emits; no-ops emit nothing", async () => {
  const { interp, frames } = make({ listInbox: async () => [] });
  await interp.getInbox(SID);
  assert.equal(frames().length, 1);
  assert.equal(frames()[0].rev, 1, "hydration emitted the (empty) known list");
  interp.interpret(enq("msg_1", "one", "queue"));
  interp.interpret(enq("msg_2", "two"));
  interp.interpret(changed("msg_1", "steer"));
  interp.interpret(delivered("msg_1"));
  interp.interpret(cancelled("msg_2"));
  assert.deepEqual(frames().map((f) => [f.rev, f.items.map((i) => i.id).join()]), [[1, ""], [2, "msg_1"], [3, "msg_1,msg_2"], [4, "msg_1,msg_2"], [5, "msg_2"], [6, ""]]);
  assert.equal(frames()[3].items[0].delivery, "steer");
  const before = frames().length;
  interp.interpret(enq("msg_s", "x", "steer", "synthetic")); // never surfaced
  interp.interpret(delivered("msg_s")); // absent id
  interp.interpret(ev("session.inbox.enqueued", { inboxID: "msg_dup", item: { type: "user", payload: { text: "d" }, delivery: "steer" } }, { id: "evt_dupe" }));
  interp.interpret(ev("session.inbox.enqueued", { inboxID: "msg_dup", item: { type: "user", payload: { text: "d" }, delivery: "steer" } }, { id: "evt_dupe" }));
  assert.equal(frames().length, before + 1, "a re-delivered event id is dropped by the seen-id filter");
});

test("`delivered` still announces messageChanged and now also updates the list", async () => {
  const { interp, events } = make({ listInbox: async () => [rawItem("msg_u", "hi")] });
  await interp.getInbox(SID);
  interp.interpret(delivered("msg_u"));
  assert.deepEqual(events.filter((e) => e.sub === "messageChanged").map((e) => e.payload.messageID), ["msg_u"]);
  assert.deepEqual(events.filter((e) => e.sub === "inbox").at(-1).payload.items, []);
});

test("a disconnect while a hydration is in flight discards its result: the session stays unknown and emits nothing", async () => {
  const d1 = deferred();
  const d2 = deferred();
  const queue = [d1, d2];
  const { interp, calls, frames } = make({ listInbox: () => queue.shift().promise });
  interp.interpret(enq("msg_1"));
  interp.inboxDisconnected();
  d1.resolve([rawItem("msg_1")]);
  await tick();
  assert.deepEqual(frames(), []);
  // a later event starts a fresh hydration
  interp.interpret(enq("msg_2"));
  assert.equal(calls.length, 2);
  d2.resolve([rawItem("msg_1"), rawItem("msg_2")]);
  await tick();
  assert.deepEqual(frames().map((f) => f.items.map((i) => i.id)), [["msg_1", "msg_2"]]);
});

test("a failed hydration leaves the session unknown, emits nothing, and is retried on the next trigger", async () => {
  let fail = true;
  const { interp, calls, frames } = make({ listInbox: async () => { if (fail) throw new Error("boom"); return [rawItem("msg_1")]; } });
  interp.interpret(enq("msg_1"));
  await tick();
  assert.deepEqual(frames(), []);
  await assert.rejects(interp.getInbox(SID), /boom/);
  fail = false;
  interp.interpret(enq("msg_2"));
  await tick();
  assert.equal(calls.length, 3, "the first event, the RPC, then the retry");
  assert.deepEqual(frames()[0].items.map((i) => i.id), ["msg_1", "msg_2"]);
});

test("a session deleted mid-hydration emits nothing", async () => {
  const d = deferred();
  const { interp, frames } = make({ listInbox: () => d.promise });
  interp.interpret(enq("msg_1"));
  interp.interpret(ev("session.deleted"));
  d.resolve([rawItem("msg_1")]);
  await tick();
  assert.deepEqual(frames(), []);
});

test("without listInbox the frame is simply off and getInbox says so", async () => {
  const { interp, frames } = make();
  interp.interpret(enq("msg_1"));
  assert.deepEqual(frames(), []);
  await assert.rejects(interp.getInbox(SID), /not available/);
});

// ---- opencode:inbox (getInbox) ---------------------------------------------------

test("getInbox hydrates an unknown session once (shared promise) and returns {epoch, rev, items}", async () => {
  const d = deferred();
  const { interp, calls, frames } = make({ listInbox: () => d.promise });
  const a = interp.getInbox(SID);
  const b = interp.getInbox(SID);
  d.resolve([rawItem("msg_1", "hi", "queue", 5)]);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.deepEqual(ra, { epoch: "epoch-1", rev: 1, items: [{ id: "msg_1", text: "hi", delivery: "queue", createdAt: 5, attachmentCount: 0 }] });
  assert.deepEqual(rb, ra);
  assert.equal(frames().length, 1, "hydration emits once for every waiter");
  assert.deepEqual(await interp.getInbox(SID), ra, "a known session answers from the snapshot");
  assert.equal(calls.length, 1);
});

test("the snapshot returned is a copy: mutating it does not corrupt the list", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1")] });
  const snap = await interp.getInbox(SID);
  snap.items.length = 0;
  assert.equal((await interp.getInbox(SID)).items.length, 1);
});

test("resyncInbox resets to unknown, re-hydrates, and the new snapshot outranks the old rev", async () => {
  let items = [rawItem("msg_1")];
  const { interp, frames } = make({ listInbox: async () => items });
  await interp.getInbox(SID);
  interp.interpret(enq("msg_2"));
  const old = frames().at(-1);
  items = [rawItem("msg_9")]; // the world changed while the stream was down
  await interp.resyncInbox(SID);
  const fresh = frames().at(-1);
  assert.equal(fresh.epoch, old.epoch);
  assert.ok(fresh.rev > old.rev);
  assert.deepEqual(fresh.items.map((i) => i.id), ["msg_9"]);
});

test("resyncInbox of an unknown session is a no-op; a failed re-hydration is swallowed", async () => {
  const { interp } = make({ listInbox: async () => { throw new Error("down"); } });
  await interp.resyncInbox("ses_never_seen");
  interp.interpret(ev("session.execution.started")); // creates the session state
  await interp.resyncInbox(SID); // does not throw
});

// ---- cancel outcome (K4) ---------------------------------------------------------

test("cancel → `cancelled` iff session.inbox.cancelled is observed; the pre-cancel item comes back", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1", "fix it", "queue", 3)] });
  const r = await interp.cancelInbox(SID, "msg_1", {
    deleteItem: async () => interp.interpret(cancelled("msg_1")), // the event beats the DELETE response
    getMessage: async () => { throw new Error("must not be consulted once the event is in"); },
  });
  assert.deepEqual(r, { outcome: "cancelled", item: { id: "msg_1", text: "fix it", delivery: "queue", createdAt: 3, attachmentCount: 0 } });
});

test("cancel: the cancelled event arriving AFTER the DELETE returns (inside the wait) still counts", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1")] });
  const p = interp.cancelInbox(SID, "msg_1", { deleteItem: async () => {}, getMessage: async () => null });
  await tick();
  await tick();
  interp.interpret(cancelled("msg_1"));
  assert.equal((await p).outcome, "cancelled");
});

test("cancel → `delivered` when the delivered event is observed (no item returned)", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1")] });
  const r = await interp.cancelInbox(SID, "msg_1", { deleteItem: async () => interp.interpret(delivered("msg_1")), getMessage: async () => null });
  assert.deepEqual(r, { outcome: "delivered" });
});

test("cancel → `delivered` when the message already exists (the DELETE was a 204 no-op)", async () => {
  const { interp } = make({ listInbox: async () => [] });
  const r = await interp.cancelInbox(SID, "msg_1", { deleteItem: async () => {}, getMessage: async () => ({ info: { id: "msg_1" } }) });
  assert.deepEqual(r, { outcome: "delivered" });
});

test("cancel → `unknown` after 3 s with no evidence (absence in the list proves nothing)", async () => {
  const { interp, advance } = make({ listInbox: async () => [rawItem("msg_1")] });
  let done = null;
  const p = interp.cancelInbox(SID, "msg_1", { deleteItem: async () => {}, getMessage: async () => null }).then((r) => (done = r));
  await tick();
  await tick();
  assert.equal(done, null, "still waiting for the 3 s window");
  advance(2999);
  await tick();
  assert.equal(done, null);
  advance(1);
  await p;
  assert.deepEqual(done, { outcome: "unknown" });
});

test("cancel: a failing DELETE rejects (no fake outcome) and a throwing getMessage is not proof of anything", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1")] });
  await assert.rejects(interp.cancelInbox(SID, "msg_1", { deleteItem: async () => { throw new Error("500"); }, getMessage: async () => null }), /500/);
  const r = await interp.cancelInbox(SID, "msg_1", {
    deleteItem: async () => interp.interpret(cancelled("msg_1")),
    getMessage: async () => { throw new Error("x"); },
  });
  assert.equal(r.outcome, "cancelled");
});

test("waiters for one id don't leak into another, and are released afterwards", async () => {
  const { interp } = make({ listInbox: async () => [rawItem("msg_1"), rawItem("msg_2")] });
  const r = await interp.cancelInbox(SID, "msg_1", {
    deleteItem: async () => { interp.interpret(cancelled("msg_2")); interp.interpret(cancelled("msg_1")); },
    getMessage: async () => null,
  });
  assert.equal(r.outcome, "cancelled");
  // a later cancel of the same id with no evidence must not inherit the old result
  const { interp: i2, advance } = make({ listInbox: async () => [] });
  const p = i2.cancelInbox(SID, "msg_1", { deleteItem: async () => {}, getMessage: async () => null });
  await tick(); await tick();
  advance(3000);
  assert.equal((await p).outcome, "unknown");
});

test("emitCommandExecuted publishes the commandExecuted frame (K6)", () => {
  const { interp, events } = make();
  interp.emitCommandExecuted(SID, { messageID: "msg_c", name: "review", arguments: "HEAD~1" });
  assert.deepEqual(events, [{ kind: "stream", sub: "commandExecuted", sessionId: SID, payload: { messageID: "msg_c", name: "review", arguments: "HEAD~1" } }]);
});
