import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoffError, applyPreamble, shiftOffsets } from "./engine.mjs";
import { FULL_BODY, createWorld, httpError, readyRecord, settle, standardWorld } from "./testWorld.mjs";

const START_SEND = { how: "clear", disposition: "send" };
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
/** An engine whose start parks at the named step until released — the window in which admissions are fenced. */
function pausedAt(w, name) {
  const g = gate();
  const reached = gate();
  const engine = w.build({
    hooks: {
      step: async (n) => {
        if (n === name) {
          reached.open();
          await g.p;
        }
      },
    },
  });
  return { engine, release: g.open, reached: reached.p };
}

// ---- happy paths --------------------------------------------------------------

test("replacement + send: the successor is created with the predecessor's settings and receives the handoff as its first turn", async () => {
  const w = createWorld();
  w.addSession("ses_p", { parentID: "ses_root", agent: "plan" });
  w.addWindow("proj", 3, "work", "ses_p");
  const engine = w.build();
  const r = await readyRecord(w, { engine });
  const out = await engine.start(r.id, START_SEND);

  assert.equal(out.state, "committed");
  assert.equal(out.how, "clear");
  assert.equal(out.disposition, "send");
  const succ = out.successorId;
  assert.match(succ, /^ses_/);
  assert.equal(w.created.length, 1);
  const c = w.created[0];
  assert.equal(c.id, succ, "the caller-minted id");
  assert.equal(c.directory, "/proj");
  assert.equal(c.parentID, "ses_root", "a child conversation stays a child");
  assert.equal(c.agent, "plan");
  assert.deepEqual(c.model, { providerID: "anthropic", modelID: "claude-opus-4-8", variant: "high" });
  assert.deepEqual(c.permissions, [{ action: "shell", resource: "*", effect: "allow" }]);

  assert.deepEqual(w.acceptedIds(succ), [out.messageId]);
  assert.match(w.accepted(succ)[0].text, /## Goal/);
  assert.equal(w.accepted(succ)[0].args.agent, "plan", "the send names the copied agent so V2 does not flip plan to build");
  assert.equal(w.windows[0].sid, succ, "the window now belongs to the successor");
  assert.deepEqual(w.repointed, [["ses_p", succ]]);
  assert.deepEqual(engine.resolveAdmissionTarget("ses_p"), { target: succ, fenced: false });
  assert.equal(engine._state.fences.ses_p, undefined, "the fence became the permanent link");
  assert.deepEqual(engine.list({ sessionId: succ }).links.ses_p, { replacedBy: succ, branches: [] });
  assert.ok(w.published.some((e) => e.kind === "handoff" && e.payload.state === "committed" && e.payload.successorId === succ));
});

test("branch + draft: a new window next to the original, ancestry link, no redirect, the original untouched", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "new-session", disposition: "draft", text: "edited by the user" });
  assert.equal(out.state, "committed");
  const succ = out.successorId;
  assert.equal(w.windows.length, 2);
  const win = w.windows.find((x) => x.sid === succ);
  assert.equal(win.name, "work ↪", "created under the temporary name, then renamed");
  assert.equal(w.windows[0].sid, "ses_p");
  assert.deepEqual(w.repointed, [], "a branch re-points nothing");
  assert.deepEqual(w.engine.resolveAdmissionTarget("ses_p"), { target: "ses_p", fenced: false }, "ancestry never redirects");
  const l = w.engine.list({ sessionId: "ses_p" }).links;
  assert.deepEqual(l.ses_p.branches, [succ]);
  const cont = w.engine.list({ sessionId: succ }).continuation;
  assert.equal(cont.draft, "edited by the user");
  assert.equal(cont.draftRevision, 1);
  assert.equal(cont.draftConsumed, false);
  assert.deepEqual(w.accepted(succ), [], "a draft sends nothing");
});

test("draft-consumed is idempotent and only honours the current revision", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "draft" });
  await w.engine.draftConsumed(r.id, 99);
  assert.equal(w.engine.list({ sessionId: out.successorId }).continuation.draftConsumed, false);
  await w.engine.draftConsumed(r.id, 1);
  await w.engine.draftConsumed(r.id, 1);
  assert.equal(w.engine.list({ sessionId: out.successorId }).continuation.draftConsumed, true);
  await assert.rejects(w.engine.draftConsumed("hof_nope", 1), (e) => e.code === "expired");
});

test("a start that finds nothing to place the branch next to is refused up front", async () => {
  const w = createWorld();
  w.addSession("ses_p");
  const engine = w.build();
  const r = await readyRecord(w, { engine });
  await assert.rejects(engine.start(r.id, { how: "new-session", disposition: "send" }), (e) => e.code === "no_window");
  assert.equal(engine.get(r.id).state, "ready");
});

// ---- §5.6 idempotency / validation --------------------------------------------------

test("concurrent starts: exactly one proceeds, the other gets already_started with the record; one successor exists", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const results = await Promise.allSettled([w.engine.start(r.id, START_SEND), w.engine.start(r.id, START_SEND), w.engine.start(r.id, { how: "new-session", disposition: "send" })]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = results.filter((x) => x.status === "rejected").map((x) => x.reason);
  assert.equal(rejected.length, 2);
  for (const e of rejected) {
    assert.ok(e instanceof HandoffError);
    assert.equal(e.code, "already_started");
    assert.equal(e.handoff.id, r.id);
  }
  assert.equal(w.created.length, 1);
  assert.equal(w.accepted(results.find((x) => x.status === "fulfilled").value.successorId).length, 1);
  await assert.rejects(w.engine.start(r.id, START_SEND), (e) => e.code === "already_started");
});

test("start validation: not ready → not_ready, unknown id → expired, bad enums → invalid_input, armed is internal only", async () => {
  const w = standardWorld();
  const pending = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: "no headings" });
  assert.equal(pending.state, "requested");
  await assert.rejects(w.engine.start(pending.id, START_SEND), (e) => e.code === "not_ready");
  await assert.rejects(w.engine.start("hof_missing", START_SEND), (e) => e.code === "expired");
  const r = await readyRecord(w);
  await assert.rejects(w.engine.start(r.id, { how: "sideways", disposition: "send" }), (e) => e.code === "invalid_input");
  await assert.rejects(w.engine.start(r.id, { how: "clear", disposition: "armed" }), (e) => e.code === "invalid_input", "a user cannot ask for armed");
  assert.equal(w.engine.get(r.id).state, "ready");
});

test("retry: a failed handoff returns to ready; only failed records can be retried", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.failures.create.push({ status: 400 });
  const failed = await w.engine.start(r.id, START_SEND);
  assert.equal(failed.state, "failed");
  assert.equal(failed.successorId, undefined, "the unused successor id is forgotten");
  assert.ok(failed.reason);
  const again = await w.engine.retry(r.id);
  assert.equal(again.state, "ready");
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "committed");
  await assert.rejects(w.engine.retry(r.id), (e) => e.code === "not_ready");
});

// ---- §5.3 step 1: the fence --------------------------------------------------------

test("fence: an admission in flight at the fence aborts the auto-start to ready ('you kept working') and releases nothing wrongly", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const parked = gate();
  const sending = w.engine.admitPrompt({ sessionId: "ses_p", text: "typing…", park: parked.p });
  assert.equal(w.engine._runtime.reservations.get("ses_p"), 1, "reserved synchronously, before the first await");
  await assert.rejects(w.engine.start(r.id, START_SEND), (e) => e.code === "busy" && /changed/.test(e.message));
  const rec = w.engine.get(r.id);
  assert.equal(rec.state, "ready");
  assert.equal(rec.reason, "you kept working");
  assert.equal(w.engine._state.fences.ses_p, undefined);
  assert.equal(w.created.length, 0, "nothing was created");
  parked.open();
  assert.deepEqual(await sending, { deliveredTo: "ses_p" });
  assert.equal(w.engine._runtime.reservations.get("ses_p"), 0, "released when sendPrompt settles");
});

test("fence: a user message accepted since generation began aborts an automatic start (userRevision)", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  await w.engine.admitPrompt({ sessionId: "ses_p", text: "one more thing" });
  await assert.rejects(w.engine.start(r.id, { ...START_SEND, origin: "auto" }), (e) => e.code === "busy");
  assert.equal(w.engine.get(r.id).reason, "you kept working");
  // …while an explicit press only looks at what is in flight now.
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "committed");
});

test("fence: an active predecessor, or one with queued input, is never replaced; held messages go back to it", async () => {
  for (const arm of [(w) => w.active.add("ses_p"), (w) => w.inbox.set("ses_p", [{ id: "msg_q" }])]) {
    const w = standardWorld();
    const r = await readyRecord(w);
    arm(w);
    await assert.rejects(w.engine.start(r.id, START_SEND), (e) => e.code === "busy");
    assert.equal(w.engine._state.fences.ses_p, undefined, "the fence was removed again");
    assert.equal(w.engine.get(r.id).state, "ready");
    assert.equal(w.created.length, 0);
  }
});

test("fence check-and-set is atomic with the admission reservation: an admission that begins after the fence is held, one that began before blocks it", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "fence");
  const start = p.engine.start(r.id, START_SEND);
  await p.reached; // the fence is installed in memory, persistence not yet done
  assert.equal(p.engine.resolveAdmissionTarget("ses_p").fenced, true);
  const res = await p.engine.admitPrompt({ sessionId: "ses_p", text: "during" });
  assert.equal(res.held, true);
  assert.equal(w.posts.length, 0, "held in manta, not posted");
  p.release();
  await start;
});

// ---- held admissions: order and target -----------------------------------------------

test("held while fenced → released IN ORDER to the successor after the accepted send (commit)", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "create");
  const start = p.engine.start(r.id, START_SEND);
  await p.reached;
  const a = await p.engine.admitPrompt({ sessionId: "ses_p", text: "first", messageID: "msg_h1" });
  const b = await p.engine.admitSynthetic("ses_p", { id: "msg_h2", text: "a job finished" });
  const c = await p.engine.admitPrompt({ sessionId: "ses_p", text: "third", messageID: "msg_h3" });
  for (const x of [a, b, c]) {
    assert.equal(x.held, true);
    assert.equal(x.deliveredTo, p.engine.get(r.id).successorId, "the caller is told where it will land");
  }
  assert.equal(JSON.parse(w.disk.json).held.ses_p.length, 3, "journalled before the call returned");
  p.release();
  const out = await start;
  const succ = out.successorId;
  assert.deepEqual(w.acceptedIds(succ), [out.messageId, "msg_h1", "msg_h2", "msg_h3"]);
  assert.deepEqual(w.posts.filter((x) => x.target === succ).map((x) => x.kind), ["prompt", "prompt", "synthetic", "prompt"]);
  assert.equal(w.accepted("ses_p").length, 0, "nothing reached the predecessor");
  assert.deepEqual(p.engine._state.held, {}, "journal drained");
  assert.equal(p.engine._runtime.releasing.size, 0);
});

test("held while fenced → released IN ORDER to the PREDECESSOR on rollback; the record fails with Retry", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "fence");
  w.failures.create.push({ status: 400 });
  const start = p.engine.start(r.id, START_SEND);
  await p.reached;
  await p.engine.admitPrompt({ sessionId: "ses_p", text: "first", messageID: "msg_h1" });
  await p.engine.admitPrompt({ sessionId: "ses_p", text: "second", messageID: "msg_h2" });
  p.release();
  const out = await start;
  await settle();
  assert.equal(out.state, "failed");
  assert.deepEqual(w.acceptedIds("ses_p"), ["msg_h1", "msg_h2"]);
  assert.equal(p.engine._state.fences.ses_p, undefined);
  assert.deepEqual(w.cleared, ["ses_p"], "a send handoff that did not commit tells the job settler to stop waiting");
  assert.equal(w.windows[0].sid, "ses_p", "the window never moved");
  assert.deepEqual(p.engine._state.held, {});
});

test("during commit and release, a new admission to the successor joins the END of the held queue (nothing overtakes)", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "attach");
  const start = p.engine.start(r.id, START_SEND);
  await p.reached; // send accepted, commit begun, window not yet restamped
  // A client that already learned the successor id (e.g. after a refetch) sends to it directly:
  const early = await p.engine.admitPrompt({ sessionId: p.engine.get(r.id).successorId, text: "early", messageID: "msg_early" });
  assert.equal(early.held, true);
  const first = await p.engine.admitPrompt({ sessionId: "ses_p", text: "first", messageID: "msg_first" });
  assert.equal(first.held, true);
  p.release();
  const out = await start;
  // Everything the fence held (older, by construction) goes first; what joined the
  // successor's queue since step 4 began goes behind it — nothing overtakes a held message.
  assert.deepEqual(w.acceptedIds(out.successorId), [out.messageId, "msg_first", "msg_early"]);
});

test("a held message the successor definitively refuses at release is reported, removed, and the queue advances", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "create");
  const start = p.engine.start(r.id, START_SEND);
  await p.reached;
  await p.engine.admitPrompt({ sessionId: "ses_p", text: "bad", messageID: "msg_bad" });
  await p.engine.admitPrompt({ sessionId: "ses_p", text: "good", messageID: "msg_good" });
  w.failures.send.push(null, { status: 400 }); // call 1 = the handoff send (ok), call 2 = the held "bad" message
  p.release();
  const out = await start;
  await settle();
  assert.equal(out.state, "committed");
  assert.deepEqual(w.heldFailures.map((f) => f.item.id), ["msg_bad"]);
  assert.ok(w.acceptedIds(out.successorId).includes("msg_good"));
  assert.ok(!w.acceptedIds(out.successorId).includes("msg_bad"));
  assert.deepEqual(p.engine._state.held, {});
});

// ---- §6.1 the resolver ----------------------------------------------------------------

test("resolver follows replacement links only, to the live end of a chain", async () => {
  const w = standardWorld();
  const r1 = await readyRecord(w);
  const o1 = await w.engine.start(r1.id, START_SEND); // ses_p → A
  w.addSession(o1.successorId);
  const r2 = await readyRecord(w, { sessionId: o1.successorId });
  const o2 = await w.engine.start(r2.id, START_SEND); // A → B
  assert.equal(w.engine.resolveAdmissionTarget("ses_p").target, o2.successorId, "two hops");
  assert.equal(w.engine.resolveAdmissionTarget(o1.successorId).target, o2.successorId);
  // a branch off B does not redirect B
  const r3 = await readyRecord(w, { sessionId: o2.successorId });
  w.addWindow("proj", 9, "b", o2.successorId);
  const o3 = await w.engine.start(r3.id, { how: "new-session", disposition: "draft" });
  assert.equal(w.engine.resolveAdmissionTarget(o2.successorId).target, o2.successorId);
  assert.equal(w.engine.resolveAdmissionTarget(o3.successorId).target, o3.successorId);
  assert.deepEqual(new Set(w.engine.chainOf("ses_p")), new Set(["ses_p", o1.successorId, o2.successorId]));
  const res = await w.engine.admitPrompt({ sessionId: "ses_p", text: "to the old id" });
  assert.equal(res.deliveredTo, o2.successorId, "the response says where it landed");
  assert.equal(w.accepted(o2.successorId).at(-1).text, "to the old id");
});

test("a slash command is refused (never held) while a handoff owns the session, and redirected afterwards", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const p = pausedAt(w, "create");
  const start = p.engine.start(r.id, START_SEND);
  await p.reached;
  assert.throws(() => p.engine.guardCommand("ses_p"), (e) => e.code === "busy");
  p.release();
  const out = await start;
  assert.equal(p.engine.guardCommand("ses_p").target, out.successorId);
});

// ---- §5.4 armed preamble ------------------------------------------------------------------

test("armed: the first admission claims the preamble exactly once; later concurrent admissions are held behind it and sent plain; mention offsets shift", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  assert.equal(out.state, "committed");
  const succ = out.successorId;
  assert.deepEqual(w.accepted(succ), [], "nothing runs in the successor until a message is admitted");
  const preamble = w.engine._state.continuations[succ].preamble;
  assert.ok(preamble.includes("## Goal"));

  const mention = { name: "reviewer", source: { value: "@reviewer", start: 4, end: 13 } };
  const skill = { id: "s1", value: "/skill", start: 0, end: 6 };
  const [a, b, c] = await Promise.all([
    w.engine.admitPrompt({ sessionId: "ses_p", text: "do @reviewer", messageID: "msg_a", mentions: [mention], skills: [skill] }),
    w.engine.admitPrompt({ sessionId: "ses_p", text: "second", messageID: "msg_b" }),
    w.engine.admitPrompt({ sessionId: succ, text: "third", messageID: "msg_c" }),
  ]);
  await settle();
  assert.equal(a.deliveredTo, succ);
  assert.equal(b.held, true);
  assert.equal(c.held, true);
  assert.deepEqual(w.acceptedIds(succ), ["msg_a", "msg_b", "msg_c"], "FIFO");
  const withPreamble = w.accepted(succ).filter((m) => m.text.includes("## Goal"));
  assert.equal(withPreamble.length, 1, "exactly one message carries the preamble");
  assert.equal(w.accepted(succ)[0].text, `${preamble}\n\n---\n\ndo @reviewer`);
  const prefix = `${preamble}\n\n---\n\n`.length;
  assert.equal(w.accepted(succ)[0].args.mentions[0].source.start, 4 + prefix);
  assert.equal(w.accepted(succ)[0].args.mentions[0].source.end, 13 + prefix);
  assert.equal(w.accepted(succ)[0].args.skills[0].start, prefix);
  assert.equal(w.accepted(succ)[1].text, "second", "later messages go plain");
  assert.equal(w.engine._state.continuations[succ].preamble, undefined, "consumed");
  assert.equal(w.engine._state.continuations[succ].claim, undefined);
  assert.deepEqual(w.engine._state.held, {});
});

test("armed claim: a definitive refusal fails that admission to its sender, drops the claim, and the next held admission becomes the claimer", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  const succ = out.successorId;
  w.failures.send.push({ status: 400 });
  const results = await Promise.allSettled([
    w.engine.admitPrompt({ sessionId: succ, text: "refused one", messageID: "msg_a" }),
    w.engine.admitPrompt({ sessionId: succ, text: "next claimer", messageID: "msg_b" }),
  ]);
  await settle();
  assert.equal(results[0].status, "rejected", "fails to its sender through the normal path");
  assert.equal(results[0].reason.status, 400);
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(w.acceptedIds(succ), ["msg_b"]);
  assert.ok(w.accepted(succ)[0].text.includes("## Goal"), "the next admission carried the preamble");
  assert.equal(w.engine._state.continuations[succ].preamble, undefined);
});

test("armed claim: an uncertain post is reconciled by id (landed → no duplicate) and the preamble is still consumed once", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  const succ = out.successorId;
  w.failures.send.push({ land: true });
  await w.engine.admitPrompt({ sessionId: succ, text: "hi", messageID: "msg_a" });
  assert.equal(w.posts.filter((p) => p.target === succ && p.id === "msg_a").length, 1, "found by id, not re-posted");
  assert.equal(w.engine._state.continuations[succ].preamble, undefined);
});

test("applyPreamble / shiftOffsets are pure", () => {
  const args = { text: "x", mentions: [{ name: "a", source: { value: "@a", start: 0, end: 2 } }] };
  const shifted = shiftOffsets(args, 5);
  assert.equal(shifted.mentions[0].source.start, 5);
  assert.equal(args.mentions[0].source.start, 0, "input untouched");
  assert.equal(applyPreamble("synthetic", { text: "r" }, "P").text, "P\n\n---\n\nr");
});

// ---- §5.3 step 3: delivery uncertainty ------------------------------------------------------

test("send: a lost response for a message that landed is found by id — never re-posted, never rolled back", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.failures.send.push({ land: true });
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "committed");
  assert.equal(w.posts.filter((p) => p.target === out.successorId).length, 1);
  assert.equal(w.deleted.length, 0);
});

test("send: a lost response for a message that did NOT land is re-posted with the same id", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.failures.send.push({});
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "committed");
  const posts = w.posts.filter((p) => p.target === out.successorId);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, posts[1].id);
  assert.deepEqual(w.acceptedIds(out.successorId), [out.messageId]);
});

test("send: a definitive refusal of the FIRST post rolls back — successor deleted, fence removed, record failed", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.failures.send.push({ status: 400 });
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "failed");
  assert.deepEqual(w.deleted.length, 1);
  assert.equal(w.engine._state.fences.ses_p, undefined);
  assert.deepEqual(w.engine._state.continuations, {});
  assert.equal(w.windows[0].sid, "ses_p");
  assert.deepEqual(w.engine.resolveAdmissionTarget("ses_p"), { target: "ses_p", fenced: false });
});

test("send: a refusal of a RE-post after an uncertain first post is not proof — keep reconciling, never roll back, recover forward", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  // first POST uncertain (not landed), every re-post definitively refused…
  w.failures.send.push({}, { status: 409 }, { status: 409 }, { status: 409 });
  const out = await w.engine.start(r.id, START_SEND);
  assert.equal(out.state, "starting", "still going — not failed");
  assert.equal(w.deleted.length, 0, "the successor was NOT deleted");
  assert.ok(w.engine._state.fences.ses_p, "the predecessor stays fenced");
  assert.equal(w.timers.length, 1, "a retry is scheduled");
  // …until it can be delivered:
  await w.runTimers();
  const done = w.engine.get(r.id);
  assert.equal(done.state, "committed");
  assert.deepEqual(w.acceptedIds(done.successorId), [done.messageId]);
});

test("create: an uncertain create that did not land rolls back; one that did land is adopted", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.failures.create.push({ land: true }); // 5xx-ish, but the session exists
  const ok = await w.engine.start(r.id, START_SEND);
  assert.equal(ok.state, "committed");
  assert.equal(w.created.length, 1);
  const w2 = standardWorld();
  const r2 = await readyRecord(w2);
  w2.failures.create.push({});
  const bad = await w2.engine.start(r2.id, START_SEND);
  assert.equal(bad.state, "failed");
});

// ---- create / entry points ---------------------------------------------------------------------

test("agent suggest with a complete body is a ready card at once, with the facts appended and labelled", async () => {
  const w = standardWorld();
  const engine = w.build({
    gather: { facts: async () => ({ predecessor: { id: "ses_p", title: "t" }, editedFiles: ["/proj/a.ts"], git: { branch: "main", changes: [] } }) },
  });
  const rec = await engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.state, "ready");
  assert.equal(rec.kind, "suggest");
  assert.ok(rec.text.startsWith(FULL_BODY));
  assert.match(rec.text, /## Context from the previous session/);
  assert.match(rec.text, /- \(observed\) files this session edited: 1/);
  assert.equal(rec.internal, undefined);
  assert.equal(w.generateCalls.length, 0, "never generated inside the tool call");
});

test("agent handoff (auto): stays requested until the turn ends — a complete body is used, no generation", async () => {
  const w = standardWorld();
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  assert.equal(rec.state, "requested");
  assert.equal(rec.kind, "auto");
  assert.equal(w.engine.hasPendingSend("ses_p"), true, "a job's settler must wait for it");
  assert.equal(w.created.length, 0);
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.equal(done.disposition, "send");
  assert.equal(w.generateCalls.length, 0);
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
});

test("agent handoff with a body missing a heading is regenerated by the server after the turn", async () => {
  const w = standardWorld();
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: "## Goal\nonly this" });
  assert.equal(rec.state, "requested");
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.generateCalls.length, 1);
  assert.ok(w.generateCalls[0].prompt.startsWith("<!-- manta-handoff-generate -->"));
  assert.equal(w.engine.get(rec.id).state, "committed");
});

test("agent handoff whose turn failed or was aborted becomes a ready card instead", async () => {
  const w = standardWorld();
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(w.engine.get(rec.id).state, "ready");
  assert.equal(w.created.length, 0);
  assert.deepEqual(w.cleared, ["ses_p"]);
});

test("agent handoff in suggest mode / off mode is a card; /handoff and the button are cards in every mode", async () => {
  for (const mode of ["suggest", "off"]) {
    const w = standardWorld({ mode });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
    assert.equal(rec.state, "ready", `agent handoff in ${mode}`);
    assert.equal(rec.kind, "suggest");
  }
  for (const mode of ["auto", "suggest", "off"]) {
    const w = standardWorld({ mode });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user", goal: "focus on auth" });
    assert.equal(rec.state, "generating");
    await settle();
    assert.equal(w.engine.get(rec.id).state, "ready", `/handoff in ${mode}`);
    assert.ok(w.generateCalls[0].prompt.includes("focus on auth"));
  }
});

test("/handoff while the session is mid-turn waits for the turn to end, then makes the card", async () => {
  const w = standardWorld();
  w.active.add("ses_p");
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "button" });
  assert.equal(rec.state, "requested");
  w.active.delete("ses_p");
  await w.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(w.engine.get(rec.id).state, "ready");
});

test("generation failure: one retry, then the record fails with a reason and can be retried", async () => {
  const w = standardWorld();
  w.failures.generate.push({}, {});
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle();
  assert.equal(w.generateCalls.length, 2, "one retry");
  assert.equal(w.engine.get(rec.id).state, "failed");
  assert.ok(w.engine.get(rec.id).reason);
  w.failures.generate.push({});
  await w.engine.retry(rec.id);
  await settle();
  assert.equal(w.engine.get(rec.id).state, "ready", "the retry regenerated (first attempt failed, the retry of it worked)");
});

test("create validates its input", async () => {
  const w = standardWorld();
  await assert.rejects(w.engine.create({}), (e) => e.code === "invalid_input");
  await assert.rejects(w.engine.create({ sessionId: "s", trigger: "auto" }), (e) => e.code === "invalid_input", "auto is server-internal");
  await assert.rejects(w.engine.create({ sessionId: "s", trigger: "agent", action: "x" }), (e) => e.code === "invalid_input");
  await assert.rejects(w.engine.create({ sessionId: "s", trigger: "agent", action: "suggest", body: 7 }), (e) => e.code === "invalid_input");
});

// ---- §6.2 one maintenance operation per session ------------------------------------------------

test("operation registry: a compaction (or another handoff phase) blocks generation and start; user admissions are never blocked", async () => {
  const w = standardWorld();
  assert.equal(w.engine.acquireOperation("ses_p", "compaction"), true);
  assert.equal(w.engine.acquireOperation("ses_p", "handoff-generate"), false);
  await assert.rejects(w.engine.create({ sessionId: "ses_p", trigger: "user" }), (e) => e.code === "busy");
  const r = await readyRecord(w);
  await assert.rejects(w.engine.start(r.id, START_SEND), (e) => e.code === "busy");
  assert.deepEqual(await w.engine.admitPrompt({ sessionId: "ses_p", text: "still fine" }), { deliveredTo: "ses_p" });
  w.engine.releaseOperation("ses_p", "compaction");
  assert.equal(w.engine.acquireOperation("ses_p", "handoff-generate"), true);
});

// ---- misc --------------------------------------------------------------------------------------

test("list: records where the session is from OR to, links for the whole chain, continuation for the successor", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "armed", origin: "auto" });
  const forPred = w.engine.list({ sessionId: "ses_p" });
  const forSucc = w.engine.list({ sessionId: out.successorId });
  assert.equal(forPred.records.length, 1);
  assert.equal(forSucc.records[0].id, r.id);
  assert.deepEqual(Object.keys(forSucc.links).sort(), ["ses_p", out.successorId].sort());
  assert.ok(forSucc.continuation.preamble);
  assert.equal(forPred.continuation, undefined);
  assert.throws(() => w.engine.list({}), (e) => e.code === "invalid_input");
});

test("a deleted session cancels its unfinished records", async () => {
  const w = standardWorld();
  const r = await readyRecord(w);
  w.engine.observeEvent({ type: "session.deleted", properties: { info: { id: "ses_p" } } });
  assert.equal(w.engine.get(r.id).state, "cancelled");
});

test("httpError helper sanity", () => {
  assert.equal(httpError(409).status, 409);
});

test("a second card for an already-replaced conversation cannot fork the chain (but a branch from it still can)", async () => {
  const w = standardWorld();
  const a = await readyRecord(w);
  const b = await readyRecord(w);
  const first = await w.engine.start(a.id, START_SEND);
  await assert.rejects(w.engine.start(b.id, START_SEND), (e) => e.code === "already_started" && /already handed off/.test(e.message));
  assert.equal(w.engine.get(b.id).state, "ready", "the stale card stays usable for a branch");
  assert.equal(w.engine.resolveAdmissionTarget("ses_p").target, first.successorId);
  w.addWindow("proj", 7, "x", "ses_p");
  const branch = await w.engine.start(b.id, { how: "new-session", disposition: "draft" });
  assert.equal(branch.state, "committed");
});

test("a start that cannot persist its first step gives the record and the session back", async () => {
  const w = standardWorld();
  let failNext = false;
  const flaky = w.build({ save: async (snap) => { if (failNext) throw new Error("disk full"); w.disk.json = JSON.stringify(snap); } });
  const card = await flaky.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  failNext = true;
  await assert.rejects(flaky.start(card.id, START_SEND), /disk full/);
  failNext = false;
  assert.equal(flaky.get(card.id).state, "ready");
  assert.equal(flaky._runtime.ops.has("ses_p"), false, "the operation was released");
  const out = await flaky.start(card.id, START_SEND);
  assert.equal(out.state, "committed");
});
