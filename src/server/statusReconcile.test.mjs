import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamInterpreter } from "./streamInterp.mjs";
import { createStatusReconciler } from "./statusReconcile.mjs";
import { permissionFromV2, questionFromForm } from "../shared/opencodeV2.mjs";

const MID = "msg_a1";
const perm = (sid, id = "per_1") => ({ id, sessionID: sid, action: "shell", resources: ["echo hi"], save: [], source: { type: "tool", messageID: MID, id: "toolu_p" } });
const form = (sid, id = "frm_1") => ({
  id,
  sessionID: sid,
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: MID, id: "toolu_q" } },
  fields: [{ key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red" }], custom: true }],
});
const ev = (sid, type, data = {}) => ({ id: `evt_${Math.random()}`, type, data: { sessionID: sid, ...data } });

/** A reconciler over a REAL interpreter with a fake opencode (`world`). */
function harness({ world = {}, autoAllow = false, owned = new Set(), answered = new Set() } = {}) {
  const frames = [];
  const interp = createStreamInterpreter({ publish: (e) => frames.push(e), now: () => 1_000 });
  const w = { active: [], perms: {}, forms: {}, activeFails: false, askFails: new Set(), reads: [], ...world };
  const reconciler = createStatusReconciler({
    listActiveSessionIds: async () => {
      w.reads.push("active");
      if (w.activeFails) throw new Error("down");
      return w.active;
    },
    listPermissions: async (sid) => {
      w.reads.push(`perm:${sid}`);
      if (w.askFails.has(sid)) throw new Error("boom");
      return (w.perms[sid] ?? []).map((p) => permissionFromV2(p));
    },
    listQuestions: async (sid) => {
      w.reads.push(`form:${sid}`);
      if (w.askFails.has(sid)) throw new Error("boom");
      return (w.forms[sid] ?? []).map((f) => questionFromForm(f));
    },
    interp,
    autoAllow: async () => autoAllow,
    ownsSession: (sid) => owned.has(sid),
    isAutoAnswered: (id) => answered.has(id),
  });
  return { interp, frames, w, reconciler };
}
const subs = (frames, sub) => frames.filter((f) => f.sub === sub);

test("first connect seeds running turns and pending asks from opencode into an empty interpreter (S1)", async () => {
  const h = harness({ world: { active: ["ses_a", "ses_b"], perms: { ses_a: [perm("ses_a")] }, forms: { ses_b: [form("ses_b")] } } });
  assert.deepEqual(h.interp.knownSessionIds(), []);
  const r = await h.reconciler.run({ reason: "connect" });
  assert.deepEqual({ skipped: r.skipped, changed: r.changed }, { skipped: false, changed: 2 });
  const snap = h.interp.snapshotState();
  assert.deepEqual(snap[0].payload.sessions.map((s) => s.sessionId).sort(), ["ses_a", "ses_b"]);
  assert.deepEqual(snap.filter((f) => f.sub === "attention").map((f) => `${f.sessionId}:${f.payload.kind}`).sort(), ["ses_a:permission", "ses_b:question"]);
});

test("a quiet pass publishes nothing (S2: no publish when nothing changed)", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } } });
  await h.reconciler.run({ reason: "connect" });
  h.frames.length = 0;
  const r = await h.reconciler.run({ reason: "periodic" });
  assert.equal(r.changed, 0);
  assert.equal(h.frames.length, 0);
});

test("a turn that ended and an ask that was answered while events were missed are corrected (S2)", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } } });
  await h.reconciler.run({ reason: "connect" });
  h.frames.length = 0;
  h.w.active = [];
  h.w.perms = {};
  const r = await h.reconciler.run({ reason: "periodic" });
  assert.equal(r.changed, 1);
  assert.equal(subs(h.frames, "running")[0].payload.running, false);
  assert.deepEqual(subs(h.frames, "permissions")[0].payload.permissions, []);
  assert.deepEqual(subs(h.frames, "attention").map((f) => f.payload.kind), [null]);
  // A session that holds an ask but is no longer active is still read, so its ask is dropped.
  assert.ok(h.w.reads.includes("perm:ses_a"));
});

test("an opencode read failure skips the tick and never clears state (S2)", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } } });
  await h.reconciler.run({ reason: "connect" });
  h.frames.length = 0;
  h.w.activeFails = true;
  const r = await h.reconciler.run({ reason: "periodic" });
  assert.equal(r.skipped, true);
  assert.equal(h.frames.length, 0);
  assert.equal(h.interp.getState("ses_a").running, true);
  assert.equal(h.interp.getState("ses_a").permissions.length, 1);
  // A per-session ask read failing leaves that session's asks alone (the running state still reconciles).
  h.w.activeFails = false;
  h.w.perms = {};
  h.w.askFails.add("ses_a");
  await h.reconciler.run({ reason: "periodic" });
  assert.equal(h.interp.getState("ses_a").permissions.length, 1, "asks kept when their read failed");
  h.w.askFails.clear();
  await h.reconciler.run({ reason: "periodic" });
  assert.equal(h.interp.getState("ses_a").permissions.length, 0);
});

test("an event that lands while the reads are in flight wins over the (older) read", async () => {
  const h = harness({ world: { active: ["ses_a"] } });
  await h.reconciler.run({ reason: "connect" });
  assert.equal(h.interp.getState("ses_a").running, true);
  h.frames.length = 0;
  // opencode still lists the session as active when read, but its turn-end event is processed before the read returns.
  const origActive = h.w.active;
  h.w.active = origActive;
  const pass = h.reconciler.run({ reason: "periodic" });
  h.interp.interpret(ev("ses_a", "session.execution.succeeded"));
  await pass;
  assert.equal(h.interp.getState("ses_a").running, false, "the later event is not undone by the stale read");
  assert.equal(subs(h.frames, "running").filter((f) => f.payload.running === true).length, 0);
});

test("a background job's asks are never adopted; an auto-answered permission is ignored", async () => {
  const h = harness({
    world: { active: ["ses_job", "ses_b"], perms: { ses_job: [perm("ses_job")], ses_b: [perm("ses_b", "per_auto")] }, forms: { ses_job: [form("ses_job")] } },
    owned: new Set(["ses_job"]),
    answered: new Set(["per_auto"]),
  });
  await h.reconciler.run({ reason: "connect" });
  assert.equal(h.interp.getState("ses_job").permissions.length, 0);
  assert.equal(h.interp.getState("ses_job").questions.length, 0);
  assert.equal(h.interp.getState("ses_b").permissions.length, 0);
  assert.equal(h.interp.getState("ses_b").running, true, "the turn itself is still seeded");
});

test("under trust mode a newly seen permission is shown only if it is still pending on the next pass (no flash)", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } }, autoAllow: true });
  await h.reconciler.run({ reason: "connect" });
  assert.equal(h.interp.getState("ses_a").permissions.length, 0, "the box may be about to auto-answer it");
  await h.reconciler.run({ reason: "periodic" });
  assert.equal(h.interp.getState("ses_a").permissions.length, 1, "still pending a pass later: the user has to act");
  // One that disappears between passes (auto-answered) never appears.
  const g = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } }, autoAllow: true });
  await g.reconciler.run({ reason: "connect" });
  g.w.perms = {};
  await g.reconciler.run({ reason: "periodic" });
  assert.equal(g.interp.getState("ses_a").permissions.length, 0);
  // Questions are never gated.
  const q = harness({ world: { active: ["ses_a"], forms: { ses_a: [form("ses_a")] } }, autoAllow: true });
  await q.reconciler.run({ reason: "connect" });
  assert.equal(q.interp.getState("ses_a").questions.length, 1);
});

test("an idle session without asks costs no ask reads; concurrent run() calls share one pass", async () => {
  const h = harness({ world: { active: ["ses_a"] } });
  await h.reconciler.run({ reason: "connect" });
  h.interp.interpret(ev("ses_a", "session.execution.succeeded"));
  h.w.active = [];
  h.w.reads.length = 0;
  const [a, b] = await Promise.all([h.reconciler.run(), h.reconciler.run()]);
  assert.equal(a, b, "the second call joined the first");
  assert.deepEqual(h.w.reads, ["active"]);
});

test("afterTurnEnd drops asks opencode no longer reports, and reads nothing when none are held (S4)", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } } });
  await h.reconciler.run({ reason: "connect" });
  h.interp.interpret(ev("ses_a", "session.execution.succeeded"));
  h.w.perms = {}; // answered elsewhere; the answer event was missed
  h.w.reads.length = 0;
  h.frames.length = 0;
  assert.equal(await h.reconciler.afterTurnEnd("ses_a"), true);
  assert.deepEqual(h.interp.getState("ses_a").permissions, []);
  assert.deepEqual(subs(h.frames, "attention").map((f) => f.payload.kind), [null]);
  h.w.reads.length = 0;
  assert.equal(await h.reconciler.afterTurnEnd("ses_a"), false);
  assert.equal(await h.reconciler.afterTurnEnd("ses_unknown"), false);
  assert.equal(await h.reconciler.afterTurnEnd(undefined), false);
  assert.deepEqual(h.w.reads, [], "no ask held → nothing to re-read");
});

test("afterTurnEnd keeps an ask opencode still reports, never adds one, and leaves everything on a failed read", async () => {
  const h = harness({ world: { active: ["ses_a"], perms: { ses_a: [perm("ses_a")] } } });
  await h.reconciler.run({ reason: "connect" });
  h.w.perms = { ses_a: [perm("ses_a"), perm("ses_a", "per_new")] };
  assert.equal(await h.reconciler.afterTurnEnd("ses_a"), false);
  assert.deepEqual(h.interp.getState("ses_a").permissions.map((p) => p.id), ["per_1"]);
  h.w.askFails.add("ses_a");
  h.w.perms = {};
  assert.equal(await h.reconciler.afterTurnEnd("ses_a"), false);
  assert.equal(h.interp.getState("ses_a").permissions.length, 1);
});

test("start() runs the pass on an unref'd interval and stop() ends it", async () => {
  const h = harness({ world: { active: ["ses_a"] } });
  const { stop } = h.reconciler.start({ intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 90));
  stop();
  assert.equal(h.interp.getState("ses_a")?.running, true);
  const n = h.w.reads.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.w.reads.length, n, "stopped");
});
