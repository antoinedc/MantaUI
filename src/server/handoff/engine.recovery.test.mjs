// Crash recovery (spec §5.5): the process dies right after an effect and BEFORE
// its persist; a second engine is built on the same disk + the same world and
// must finish (or roll back) the start with no duplicate session, window or
// message. "The world" outlives the crash exactly as opencode and tmux do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Crash, createWorld, readyRecord, settle, FULL_BODY } from "./testWorld.mjs";

/** A world + a first engine that will crash at `w.crashAt`, with an optional held admission injected while fenced. */
async function boot({ withHeld }) {
  const w = createWorld();
  w.addSession("ses_p");
  w.addWindow("proj", 3, "work", "ses_p");
  let injected = false;
  const e1 = w.build({
    hooks: {
      step: async (n) => {
        // the first step hook of a replacement is "fence": the window in which admissions are held
        if (withHeld && !injected) {
          injected = true;
          await e1.admitPrompt({ sessionId: "ses_p", text: "typed during the handoff", messageID: "msg_held" });
        }
        if (w.crashAt === n) throw new Crash(n);
      },
    },
  });
  const r = await readyRecord(w, { engine: e1 });
  return { w, e1, r };
}

function assertFinished(w, e2, r, { how, disposition, withHeld }) {
  const rec = e2.get(r.id);
  assert.equal(rec.state, "committed", `record committed (was ${rec.state})`);
  const succ = rec.successorId;
  assert.equal(w.created.filter((c) => c.id === succ).length, 1, "exactly one successor session was created");
  assert.equal(w.deleted.length, 0, "nothing was rolled back");
  assert.deepEqual(e2._state.fences, {}, "no fence left");
  assert.deepEqual(e2._state.held, {}, "no held admissions left");
  assert.equal(e2._runtime.releasing.size, 0);
  assert.equal(w.windows.filter((x) => x.sid === succ).length, 1, "exactly one window carries the successor");
  assert.equal(w.windows.filter((x) => x.name.startsWith("handoff-")).length, 0, "no half-made branch window is left behind");
  if (how === "clear") {
    assert.equal(w.windows.length, 1);
    assert.equal(w.windows[0].sid, succ);
    assert.equal(e2.resolveAdmissionTarget("ses_p").target, succ);
    assert.ok(w.repointed.some(([a, b]) => a === "ses_p" && b === succ), "ownership re-pointed");
  } else {
    assert.equal(w.windows.length, 2);
    assert.equal(w.windows.find((x) => x.sid === succ).name, "work ↪");
    assert.equal(e2.resolveAdmissionTarget("ses_p").target, "ses_p");
    assert.deepEqual(e2.list({ sessionId: succ }).links[succ].branchedFrom, "ses_p");
  }
  const ids = w.acceptedIds(succ);
  if (disposition === "send") {
    assert.equal(ids.filter((i) => i === rec.messageId).length, 1, "the handoff was sent exactly once");
    assert.equal(ids[0], rec.messageId);
  } else {
    assert.ok(!ids.includes(rec.messageId ?? "none"));
  }
  if (withHeld) {
    assert.equal(ids.filter((i) => i === "msg_held").length, 1, "the held message was delivered exactly once, to the successor");
    assert.equal(w.acceptedIds("ses_p").length, 0);
  }
  if (disposition === "armed") assert.ok(e2._state.continuations[succ].preamble, "the preamble is waiting for the first admission");
  if (disposition === "draft") assert.ok(e2.list({ sessionId: succ }).continuation.draft);
}

const SCENARIOS = [
  { how: "clear", disposition: "send", withHeld: true, points: ["fence", "create", "prepare", "send-attempt", "send", "attach", "link", "ownership", "committed", "release-post"] },
  { how: "clear", disposition: "armed", withHeld: false, points: ["fence", "create", "prepare", "attach", "link", "ownership", "committed"] },
  { how: "clear", disposition: "draft", withHeld: true, points: ["create", "prepare", "link", "committed", "release-post"] },
  { how: "new-session", disposition: "send", withHeld: false, points: ["create", "prepare", "send-attempt", "send", "attach", "link", "committed"] },
  { how: "new-session", disposition: "draft", withHeld: false, points: ["create", "prepare", "attach", "link", "committed"] },
];

for (const sc of SCENARIOS) {
  for (const point of sc.points) {
    test(`crash after "${point}" (${sc.how} + ${sc.disposition}${sc.withHeld ? ", with a held message" : ""}) → recovery finishes with no duplicates`, async () => {
      const { w, e1, r } = await boot(sc);
      w.crashAt = point;
      await assert.rejects(e1.start(r.id, { how: sc.how, disposition: sc.disposition, origin: "auto" }), (e) => e.crash === true && e.at === point);
      // …the process is gone; a new one reads the disk.
      w.crashAt = null;
      const e2 = w.build();
      await e2.recover();
      await settle();
      assertFinished(w, e2, r, sc);
      // recovery is idempotent
      const snapshot = w.disk.json;
      await e2.recover();
      await settle();
      assert.equal(w.disk.json, snapshot, "a second recovery changes nothing");
    });
  }
}

test("a fence that was persisted is in force from the first admission after a restart — before recover() has run", async () => {
  const { w, e1, r } = await boot({ withHeld: true });
  w.crashAt = "prepare";
  await assert.rejects(e1.start(r.id, { how: "clear", disposition: "send" }), (e) => e.crash);
  w.crashAt = null;
  const e2 = w.build();
  assert.equal(e2.resolveAdmissionTarget("ses_p").fenced, true);
  const res = await e2.admitPrompt({ sessionId: "ses_p", text: "right after the restart", messageID: "msg_after" });
  assert.equal(res.held, true, "held, not posted to the predecessor");
  assert.equal(w.acceptedIds("ses_p").length, 0);
  await e2.recover();
  await settle();
  const succ = e2.get(r.id).successorId;
  assert.deepEqual(w.acceptedIds(succ), [e2.get(r.id).messageId, "msg_held", "msg_after"], "send first, then held messages in arrival order");
});

test("armed claim persisted, process died before the post: recovery reconciles by id and re-posts once", async () => {
  const { w, e1, r } = await boot({ withHeld: false });
  const out = await e1.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  const succ = out.successorId;
  w.crashAt = "claim";
  void e1.admitPrompt({ sessionId: succ, text: "first message", messageID: "msg_a" }); // dies inside; never settles
  await settle();
  assert.equal(w.accepted(succ).length, 0, "died before the post");
  assert.ok(JSON.parse(w.disk.json).continuations[succ].claim, "the claim is durable");
  w.crashAt = null;
  const e2 = w.build();
  await e2.recover();
  await settle();
  assert.deepEqual(w.acceptedIds(succ), ["msg_a"]);
  assert.ok(w.accepted(succ)[0].text.includes("## Goal"), "carried the preamble");
  assert.equal(e2._state.continuations[succ].preamble, undefined);
  assert.equal(e2._state.continuations[succ].claim, undefined);
});

test("armed claim that DID land before the crash: recovery finds it by id and does not post a second copy", async () => {
  const { w, e1, r } = await boot({ withHeld: false });
  const out = await e1.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  const succ = out.successorId;
  w.crashAt = "release-post"; // after the post was accepted and the item shifted, before that was persisted
  void e1.admitPrompt({ sessionId: succ, text: "first message", messageID: "msg_a" });
  await settle();
  assert.equal(w.accepted(succ).length, 1, "it landed");
  w.crashAt = null;
  const e2 = w.build();
  await e2.recover();
  await settle();
  assert.deepEqual(w.acceptedIds(succ), ["msg_a"]);
  assert.equal(w.posts.filter((p) => p.target === succ).length, 1, "reconciled by id, not re-posted");
  assert.equal(e2._state.continuations[succ].preamble, undefined, "the preamble is consumed");
});

test("boot: a record that was still generating becomes failed (Retry); a requested one is processed as a card", async () => {
  const w = createWorld();
  w.addSession("ses_p");
  w.addWindow("proj", 3, "work", "ses_p");
  const e1 = w.build();
  const gen = await e1.create({ sessionId: "ses_p", trigger: "user" });
  assert.equal(gen.state, "generating");
  await settle();
  const req = await e1.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  // forge the interrupted state directly in the persisted snapshot
  const snap = JSON.parse(w.disk.json);
  snap.records[gen.id].state = "generating";
  w.disk.json = JSON.stringify(snap);
  const e2 = w.build();
  await e2.recover();
  await settle();
  assert.equal(e2.get(gen.id).state, "failed");
  assert.equal(e2.get(gen.id).reason, "interrupted by a restart");
  assert.equal(e2.get(req.id).state, "ready", "its turn can never end now: a card, never an unattended replacement");
  assert.equal(w.created.length, 0);
});

test("recovery rolls back a start that cannot complete before any delivery was attempted (the predecessor vanished)", async () => {
  const { w, e1, r } = await boot({ withHeld: true });
  w.crashAt = "fence";
  await assert.rejects(e1.start(r.id, { how: "clear", disposition: "send" }), (e) => e.crash);
  w.crashAt = null;
  w.sessions.delete("ses_p"); // gone while we were down
  const e2 = w.build();
  await e2.recover();
  await settle();
  assert.equal(e2.get(r.id).state, "failed");
  assert.deepEqual(e2._state.fences, {});
  assert.equal(w.created.length, 0);
});

test("recovery with opencode not up yet retries the (still reversible) start instead of rolling it back", async () => {
  const { w, e1, r } = await boot({ withHeld: false });
  w.crashAt = "fence";
  await assert.rejects(e1.start(r.id, { how: "clear", disposition: "send" }), (e) => e.crash);
  w.crashAt = null;
  let up = false;
  const realCreate = w.build; // keep the world's oc, but make reads fail until "up"
  const e2 = realCreate({
    oc: {
      readSession: async () => { if (!up) throw new Error("fetch failed"); return { state: "found", session: { ...w.sessions.get("ses_p"), location: { directory: "/proj" } } }; },
      createSession: async (i) => { w.sessions.set(i.id, { id: i.id, ...i }); w.created.push(i); },
      deleteSession: async (id) => void w.deleted.push(id),
      sendPrompt: async (a) => void w.acceptedIds(a.sessionId) && w.messages.get(a.sessionId)?.set?.(a.messageID, { id: a.messageID, text: a.text }),
      postSynthetic: async () => {},
      listInbox: async () => [],
      getMessage: async (sid, id) => w.messages.get(sid)?.get(id) ?? null,
      listActive: async () => [],
      generate: async () => FULL_BODY,
    },
  });
  await e2.recover();
  await settle();
  assert.equal(e2.get(r.id).state, "starting", "not rolled back while opencode is unreachable");
  assert.equal(w.timers.length, 1);
  up = true;
  await w.runTimers();
  assert.equal(e2.get(r.id).state, "committed");
});
