// Review round 3: the engine's background maintenance under pause, the repair's revalidation at the mutation point, the chain
// lock across a split, a pre-watcher store, and the bounded draining of arrivals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWorld, settle } from "./testWorld.mjs";

const T0 = 10_000_000;
const link = (replaces, replacedBy) => ({ ...(replaces ? { replaces } : {}), ...(replacedBy ? { replacedBy } : {}), branches: [] });
const rec = (id, from, to, state = "committed") => ({ id, fromSessionId: from, successorId: to, kind: "replace", trigger: "agent", state, text: "", createdAt: 1, updatedAt: 1, internal: { successorCreatedAt: T0 } });
const userAt = (w, sid, created) => w.timelines.set(sid, [...(w.timelines.get(sid) ?? []), { id: `msg_u_${sid}_${created}`, type: "user", time: { created } }]);
const disk = (w, extra) => {
  w.disk.json = JSON.stringify({ version: 1, records: {}, links: {}, continuations: {}, fences: {}, held: {}, ...extra });
};
const synthPosts = (w, target) => w.posts.filter((p) => p.kind === "synthetic" && p.target === target);
const arrival = (id, child = "ses_c") => ({ id, text: `<subagent sessionID="${child}" state="completed">\nok\n</subagent>`, metadata: { source: "subagent", childID: child, state: "completed" }, at: 1 });
const relayId = (sid, original) => `msg_${createHash("sha256").update(`${sid}\n${original}`).digest("hex").slice(0, 32)}`;
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

// ---- pause ---------------------------------------------------------------------------------------------

/** Everything the background work could mutate: a deferred relay, an arrival whose link exists, a watched link with evidence. */
function pausedWorld({ withMarker }) {
  const w = createWorld({ mode: "off" });
  w.addSession("Q", { parentID: "ses_root" });
  w.addSession("Q1", { time: { created: T0 } });
  userAt(w, "Q", T0 + 100_000); // the parent resumed Q
  w.inbox.set("OLD", [{ id: "msg_pending", type: "synthetic" }]);
  w.active.add("OLD");
  disk(w, {
    records: { hof_q: rec("hof_q", "Q", "Q1") },
    links: { Q: link(null, "Q1"), Q1: link("Q", null), OLD: link(null, "NEW"), NEW: link("OLD", null) },
    arrivals: { OLD: [arrival("msg_arrived")] },
    relays: { msg_deferred: { admitted: false, suppressed: null, at: 1, from: "OLD", original: "msg_d", rec: { id: "msg_d", text: "t", metadata: { source: "subagent", childID: "ses_d" } }, tries: 1, nextAt: 0 } },
    repairs: withMarker ? { "taskChildLinks@2": "2026-11-08T00:00:00.000Z", pendingTaskLinks: { Q: { succ: "Q1", since: 1 } } } : {},
  });
  w.clock = 100;
  return w;
}
const mutations = (w) => ({ posts: w.posts.length, cancelled: w.cancelled.length, interrupted: w.interrupted.length });

test("paused before recovery completes: no post, cancel, interrupt or link cut happens until resume (watched links)", async () => {
  const w = pausedWorld({ withMarker: true });
  w.engine = w.build();
  w.engine.setPaused(true);
  await w.engine.recover();
  await settle(12);
  await w.engine.maintain();
  await w.engine.repairTaskChildLinks();
  assert.deepEqual(mutations(w), { posts: 0, cancelled: 0, interrupted: 0 }, "nothing was sent to opencode");
  assert.deepEqual(w.engine._state.links.Q, link(null, "Q1"), "no link was cut");
  assert.ok(w.engine._state.repairs.pendingTaskLinks.Q, "still watched");
  assert.equal(w.engine._state.arrivals.OLD.length, 1, "the arrival is still queued");
  assert.equal(w.engine._state.relays.msg_deferred.admitted, false);

  // a result arriving while paused is recorded durably (nothing posted), not lost
  w.engine.observeRaw({ type: "session.inbox.enqueued", data: { sessionID: "OLD", inboxID: "msg_new", item: { type: "synthetic", payload: { text: "t", metadata: { source: "subagent", childID: "ses_n" } } } } });
  await settle(10);
  assert.equal(w.posts.length, 0);
  const recorded = Object.values(w.engine._state.relays).find((r) => r.original === "msg_new");
  assert.equal(recorded.admitted, false);
  assert.equal(recorded.nextAt, 0, "a pause is not a failed attempt: no backoff");

  w.engine.setPaused(false); // resume runs the deferred work
  await settle(20);
  assert.ok(w.posts.length >= 2, "the deferred relays and the arrival went out");
  assert.equal(w.engine._state.links.Q, undefined, "the watched link was cut after the resume");
  assert.equal(w.engine._state.arrivals.OLD, undefined);
});

test("paused before recovery completes: the boot repair defers (marker unset) and the resume runs it", async () => {
  const w = pausedWorld({ withMarker: false });
  w.engine = w.build();
  w.engine.setPaused(true);
  await w.engine.recover();
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { paused: true, split: 0, failed: 0 });
  assert.equal(w.engine._state.repairs["taskChildLinks@2"], undefined);
  assert.deepEqual(w.engine._state.links.Q, link(null, "Q1"));
  w.engine.setPaused(false);
  await settle(20);
  assert.equal(w.engine._state.links.Q, undefined);
  assert.ok(w.engine._state.repairs["taskChildLinks@2"]);
});

test("an injected isPaused() has the same effect, and suppression waits too: no cancel / interrupt while paused", async () => {
  let pausedNow = true;
  const w = createWorld({ mode: "off" });
  disk(w, { links: { OLD: link(null, "NEW"), NEW: link("OLD", null) } });
  w.engine = w.build({ isPaused: () => pausedNow });
  w.emit = (e) => w.engine.observeRaw(e);
  w.inbox.set("OLD", [{ id: "msg_pending", type: "synthetic" }]);
  w.active.add("OLD");
  w.timelines.set("OLD", [{ id: "msg_i", type: "idle", time: { created: 1 } }, { id: "msg_pending", type: "synthetic", metadata: { source: "subagent", childID: "ses_c" }, time: { created: 2 } }]);
  w.engine.observeRaw({ type: "session.inbox.enqueued", data: { sessionID: "OLD", inboxID: "msg_pending", item: { type: "synthetic", payload: { text: "t", metadata: { source: "subagent", childID: "ses_c" } } } } });
  await settle(10);
  assert.deepEqual(mutations(w), { posts: 0, cancelled: 0, interrupted: 0 });
  pausedNow = false;
  await w.engine.maintain();
  assert.equal(w.posts.length, 1, "admitted after the pause");
  assert.ok(w.cancelled.length + w.interrupted.length >= 1, "and the retired session was kept quiet");
});

test("a pause that begins mid-relay stops it before the post, the cancel and the interrupt", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, { links: { OLD: link(null, "NEW"), NEW: link("OLD", null) }, relays: { [relayId("OLD", "msg_pending")]: { admitted: true, suppressed: null, at: 1, from: "OLD", original: "msg_pending" } } });
  w.clock = 10;
  w.engine = w.build();
  w.inbox.set("OLD", [{ id: "msg_pending", type: "synthetic" }]);
  w.beforeInbox = async (sid) => {
    if (sid === "OLD") w.engine.setPaused(true); // the upgrade starts while we are inspecting the retired session
  };
  await w.engine.maintain();
  assert.deepEqual(mutations(w), { posts: 0, cancelled: 0, interrupted: 0 });
  assert.equal(w.engine._state.relays[relayId("OLD", "msg_pending")].suppressed, null, "unsettled, not guessed");
});

// ---- repair revalidation at the mutation point ----------------------------------------------------------------

function watchWorld() {
  const w = createWorld({ mode: "off" });
  w.addSession("X", { parentID: "ses_root" });
  w.addSession("X1", { time: { created: T0 } });
  userAt(w, "X", T0 + 100_000);
  disk(w, {
    records: { hof_x: rec("hof_x", "X", "X1"), hof_ready: { ...rec("hof_ready", "X1", null, "ready"), successorId: undefined } },
    links: { X: link(null, "X1"), X1: link("X", null) },
    repairs: { "taskChildLinks@2": "2026-11-08T00:00:00.000Z", pendingTaskLinks: { X: { succ: "X1", since: 1 } } },
  });
  w.engine = w.build();
  return w;
}

test("a successor's ready handoff becomes `starting` DURING the evidence reads: nothing is cut; once it ends the next pass cuts", async () => {
  const w = watchWorld();
  const card = w.engine._state.records.hof_ready;
  w.beforeTimeline = async (sid, opts) => {
    if (sid === "X" && opts.type === "user") card.state = "starting"; // started between the chain check and the mutation
  };
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.X, link(null, "X1"), "not cut");
  assert.ok(w.engine._state.repairs.pendingTaskLinks.X, "still watched");
  w.beforeTimeline = null;
  card.state = "failed";
  await w.engine.maintain();
  assert.equal(w.engine._state.links.X, undefined);
});

test("a fence appears on a chain member during the reads: nothing is cut", async () => {
  const w = watchWorld();
  w.beforeTimeline = async (sid, opts) => {
    if (sid === "X" && opts.type === "user") w.engine._state.fences.X1 = { successorId: "X2", recordId: "hof_other" };
  };
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.X, link(null, "X1"));
  delete w.engine._state.fences.X1;
  w.beforeTimeline = null;
  await w.engine.maintain();
  assert.equal(w.engine._state.links.X, undefined);
});

test("a Manta-owned job record appears during the reads: the fresh ownership read at the mutation point keeps the link", async () => {
  const w = watchWorld();
  w.beforeTimeline = async (sid, opts) => {
    if (sid === "X" && opts.type === "user") w.jobs = [{ childSessionID: "X1", completionOwner: "manta" }]; // a repoint landed after the cached read
  };
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.X, link(null, "X1"), "kept");
  assert.equal(w.engine._state.repairs.pendingTaskLinks, undefined, "and no longer a candidate (criterion c now fails)");
});

test("an unreadable job store at the mutation point is no permission to cut", async () => {
  const w = watchWorld();
  let reads = 0;
  w.engine = w.build({ loadJobsStrict: async () => { if (++reads >= 2) throw new Error("jobs.json unreadable"); return []; } }); // the verdict's read works, the fresh one doesn't
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.X, link(null, "X1"));
  assert.ok(w.engine._state.repairs.pendingTaskLinks.X, "stays watched");
});

// ---- the lock key across a split --------------------------------------------------------------------------------

test("a chain split with waiters already queued: their callbacks and a later caller for the new chain never overlap", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, { links: { A: link(null, "B"), B: link("A", "C"), C: link("B", null) } });
  const engine = w.build();
  let active = 0;
  let peak = 0;
  const order = [];
  const work = (name) => async () => {
    peak = Math.max(peak, ++active);
    order.push(`start ${name}`);
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    order.push(`end ${name}`);
    active--;
  };
  const hold = gate();
  const holdA = engine.withChainExclusive("A", async () => {
    await hold.p;
    delete engine._state.links.A.replacedBy; // the split: A | B → C
    delete engine._state.links.B.replaces;
  });
  const b1 = engine.withChainExclusive("B", work("b1")); // queued while B belonged to A's chain
  const b2 = engine.withChainExclusive("B", work("b2"));
  await settle();
  hold.open();
  await holdA;
  const b3 = engine.withChainExclusive("B", work("b3")); // keyed by B's own chain from the start
  await Promise.all([b1, b2, b3]);
  assert.equal(peak, 1, `callbacks for the same chain overlapped: ${order.join(", ")}`);
  assert.equal(order.length, 6);
});

test("the chain lock still serializes an unsplit chain, and returns the callback's value", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, { links: { A: link(null, "B"), B: link("A", null) } });
  const engine = w.build();
  let active = 0;
  let peak = 0;
  const go = (v) => engine.withChainExclusive(v, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setImmediate(r));
    active--;
    return v;
  });
  assert.deepEqual(await Promise.all([go("A"), go("B"), go("A")]), ["A", "B", "A"]);
  assert.equal(peak, 1);
});

// ---- a store written by the previous build of the repair ---------------------------------------------------------

test("a store carrying only the old `taskChildLinks` marker is scanned once more under the current rules (and gets a watch list)", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession("P", { parentID: "ses_root" });
  w.addSession("P1", { time: { created: T0 } });
  w.addSession("R", { parentID: "ses_root" });
  w.addSession("R1", { time: { created: T0 } });
  userAt(w, "P", T0 + 100_000); // resumed after the handoff: cut
  disk(w, {
    records: { hof_p: rec("hof_p", "P", "P1"), hof_r: rec("hof_r", "R", "R1") },
    links: { P: link(null, "P1"), P1: link("P", null), R: link(null, "R1"), R1: link("R", null) },
    repairs: { taskChildLinks: "2026-11-08T10:00:00.000Z" }, // what the first build of this PR left on a dev box
  });
  w.engine = w.build();
  const out = await w.engine.repairTaskChildLinks();
  assert.equal(out.skipped, undefined, "not skipped forever");
  assert.deepEqual(out, { split: 1, failed: 0 });
  assert.equal(w.engine._state.links.P, undefined);
  assert.deepEqual(Object.keys(w.engine._state.repairs.pendingTaskLinks), ["R"], "R is watched for a later resume");
  assert.ok(w.engine._state.repairs["taskChildLinks@2"]);
  assert.equal(w.engine._state.repairs.taskChildLinks, "2026-11-08T10:00:00.000Z", "the old marker is left as it was");
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { skipped: true, split: 0, failed: 0 }, "and now it is done");
});

// ---- bounded, fair arrival draining ----------------------------------------------------------------------------------

test("maintain({limit:1}) with six arrival queues relays one item per pass, and all six within six passes", async () => {
  const w = createWorld({ mode: "off" });
  const links = {};
  const arrivals = {};
  for (let i = 0; i < 6; i++) {
    links[`OLD${i}`] = link(null, `NEW${i}`);
    links[`NEW${i}`] = link(`OLD${i}`, null);
    arrivals[`OLD${i}`] = [arrival(`msg_arr${i}`, `ses_c${i}`)];
  }
  disk(w, { links, arrivals });
  w.engine = w.build();
  const seen = [];
  for (let pass = 1; pass <= 6; pass++) {
    await w.engine.maintain({ limit: 1 });
    assert.equal(w.posts.filter((p) => p.kind === "synthetic").length, pass, `pass ${pass}: exactly one more item`);
    seen.push(w.posts.at(-1).target);
  }
  assert.deepEqual([...seen].sort(), ["NEW0", "NEW1", "NEW2", "NEW3", "NEW4", "NEW5"], "every queue was served once");
  assert.deepEqual(w.engine._state.arrivals, {});
  assert.deepEqual(JSON.parse(w.disk.json).arrivals, {}, "persisted");
  await w.engine.maintain({ limit: 1 });
  assert.equal(w.posts.length, 6, "nothing left to do");
});

test("arrival draining is fair: two sessions with three items each alternate between passes, and unfinished arrivals are kept", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, {
    links: { OLDa: link(null, "NEWa"), NEWa: link("OLDa", null), OLDb: link(null, "NEWb"), NEWb: link("OLDb", null) },
    arrivals: { OLDa: [arrival("msg_a1", "ca1"), arrival("msg_a2", "ca2"), arrival("msg_a3", "ca3")], OLDb: [arrival("msg_b1", "cb1"), arrival("msg_b2", "cb2"), arrival("msg_b3", "cb3")] },
  });
  w.engine = w.build();
  const targets = [];
  for (let pass = 0; pass < 6; pass++) {
    await w.engine.maintain({ limit: 1 });
    targets.push(w.posts.at(-1).target);
    if (pass === 1) assert.deepEqual(w.engine._state.arrivals.OLDa.map((a) => a.id), ["msg_a2", "msg_a3"], "unfinished arrivals stay queued, in order");
  }
  assert.deepEqual(targets, ["NEWa", "NEWb", "NEWa", "NEWb", "NEWa", "NEWb"]);
  assert.deepEqual(w.engine._state.arrivals, {});
});

test("a fenced session's arrivals are not drained (they wait for the commit or the rollback)", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, { links: {}, fences: { OLDf: { successorId: "NEWf", recordId: "hof_f" } }, arrivals: { OLDf: [arrival("msg_f1")] } });
  w.engine = w.build();
  await w.engine.maintain({ limit: 10 });
  assert.equal(w.posts.length, 0);
  assert.equal(w.engine._state.arrivals.OLDf.length, 1);
});

test("relayBackgroundResult for a session that is neither replaced nor fenced answers `live` before any I/O", async () => {
  const w = createWorld({ mode: "off" });
  disk(w, { links: { OLD: link(null, "NEW"), NEW: link("OLD", null) } });
  w.engine = w.build();
  let touched = 0;
  w.beforeTimeline = async () => void touched++;
  w.beforeInbox = async () => void touched++;
  w.beforeRead = async () => void touched++;
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "NEW", childSessionId: "ses_c" }), { relayed: false, reason: "live" });
  assert.deepEqual(await w.engine.relayBackgroundResult({ sessionId: "ses_never_seen", childSessionId: "ses_c" }), { relayed: false, reason: "live" });
  assert.equal(touched, 0);
  assert.deepEqual(w.timelineReads, []);
});
