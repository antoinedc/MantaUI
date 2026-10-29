// Background jobs hand off on their own (docs/superpowers/specs/2026-10-29-handoff-jobs-auto.md):
// the mode resolver, the unattended entry plan, successor inheritance, the failed-turn rule and
// the stop / pause / finished-job cancellation. The delegate side is a map the test owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FULL_BODY, settle, standardWorld } from "./testWorld.mjs";

const OPUS = { providerID: "anthropic", modelID: "claude-opus-4-8" };

/** A world whose delegate store is `jobs` (session -> "manta" | "opencode"); a commit re-points it like the real engine. */
function jobWorld({ mode = "suggest", owner = "manta", extra = {} } = {}) {
  const w = standardWorld({ mode });
  const jobs = new Map(owner ? [["ses_p", owner]] : []);
  const lookups = [];
  w.jobs = jobs;
  w.lookups = lookups;
  w.engine = w.build({
    runningJobOwner: async (sid) => (lookups.push(sid), jobs.get(sid) ?? null),
    ownership: {
      repoint: async (pred, succ) => {
        w.repointed.push([pred, succ]);
        if (jobs.has(pred)) {
          jobs.set(succ, jobs.get(pred));
          jobs.delete(pred);
        }
      },
    },
    ...extra,
  });
  return w;
}

async function turn(engine, sid, { ctx = 250_000, outcome = "ok" } = {}) {
  const ev = (type, properties) => engine.observeEvent({ type, properties: { sessionID: sid, ...properties } });
  ev("session.status", { status: { type: "busy" } });
  ev("session.next.step.ended", { tokens: { input: ctx, cache: { read: 0, write: 0 } }, ...OPUS });
  if (outcome === "failed") ev("session.error", { error: { name: "ApiError" } });
  ev("session.status", { status: { type: "idle" } });
  ev("session.idle", {});
  await settle(10);
}
const records = (w, sid = "ses_p") => Object.values(w.engine._state.records).filter((r) => r.fromSessionId === sid);

// ---- the resolver ---------------------------------------------------------------------------------

test("resolveMode: a manta-owned running job is auto whatever the box default is", async () => {
  for (const box of ["suggest", "off", "auto"]) {
    const w = jobWorld({ mode: box });
    assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "auto", isDefault: true, source: "job" }, `box ${box}`);
    assert.equal(await w.engine.modeFor("ses_p"), "auto");
  }
});

test("resolveMode: the session's own mode wins and the job lookup is not even made", async () => {
  const w = jobWorld({ mode: "suggest" });
  await w.engine.setMode("ses_p", "off");
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "off", isDefault: false, source: "own" });
  assert.deepEqual(w.lookups, []);
});

test("resolveMode: an opencode-owned, non-job, paused or finished session gets the box default", async () => {
  const adopted = jobWorld({ mode: "suggest", owner: "opencode" });
  assert.deepEqual(await adopted.engine.resolveMode("ses_p"), { mode: "suggest", isDefault: true, source: "box" });
  const plain = jobWorld({ mode: "off", owner: null });
  assert.deepEqual(await plain.engine.resolveMode("ses_p"), { mode: "off", isDefault: true, source: "box" });
  // a paused or finished job is no longer a running record: the delegate lookup answers null
  const finished = jobWorld({ mode: "suggest" });
  finished.jobs.delete("ses_p");
  assert.equal((await finished.engine.resolveMode("ses_p")).source, "box");
});

test("resolveMode: a failed lookup is 'not a job' — the box default, never an error", async () => {
  const w = standardWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async () => {
      throw new Error("store unreadable");
    },
  });
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "suggest", isDefault: true, source: "box" });
  const list = await w.engine.list({ sessionId: "ses_p" });
  assert.equal(list.mode, "suggest");
});

test("list(): a manta job with no own mode reports auto, marked as the default; an explicit mode is not", async () => {
  const w = jobWorld({ mode: "suggest" });
  const l = await w.engine.list({ sessionId: "ses_p" });
  assert.equal(l.mode, "auto");
  assert.equal(l.modeIsDefault, true);
  await w.engine.setMode("ses_p", "suggest");
  const own = await w.engine.list({ sessionId: "ses_p" });
  assert.equal(own.mode, "suggest");
  assert.equal(own.modeIsDefault, false);
});

// ---- other callers of the effective mode ----------------------------------------------------------

test("the optimizer's budget note reaches a running job even when the box default is off; compaction treats it as handled", async () => {
  const w = jobWorld({ mode: "off" });
  w.engine.observeEvent({ type: "session.next.step.ended", properties: { sessionID: "ses_p", tokens: { input: 150_000, cache: { read: 0, write: 0 } }, ...OPUS } });
  assert.equal((await w.engine.policyFor("ses_p")).mode, "auto");
  // compaction's eligibility is `modeFor === "off"`: a running job is never eligible
  assert.notEqual(await w.engine.modeFor("ses_p"), "off");
  const plain = standardWorld({ mode: "off" });
  assert.equal(await plain.engine.modeFor("ses_p"), "off");
});

// ---- the agent's suggest starts a handoff in an unattended session ---------------------------------

test("box default suggest: a manta job's agent `suggest` starts a handoff at turn end — settlement deferred, job re-pointed, successor has NO stored mode", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.kind, "auto");
  assert.equal(rec.state, "requested");
  assert.equal(w.engine.hasPendingSend("ses_p"), true, "the job's settler waits for it");
  assert.equal(w.created.length, 0);
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.equal(done.disposition, "send");
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
  assert.equal(w.accepted(done.successorId).length, 1, "the handoff is the successor's first message");
  assert.deepEqual(w.repointed, [["ses_p", done.successorId]]);
  assert.equal(w.engine._state.sessionModes[done.successorId], undefined, "nothing stored that could outlive the job");
  assert.equal(await w.engine.modeFor(done.successorId), "auto", "still auto — through the job rule");
  w.jobs.delete(done.successorId); // the job finishes
  assert.equal(await w.engine.modeFor(done.successorId), "suggest", "back to the box default once the job is over");
});

test("a second link of the chain: the successor job's agent `suggest` starts again", async () => {
  const w = jobWorld({ mode: "suggest" });
  const first = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  const succ = w.engine.get(first.id).successorId;
  w.addSession(succ);
  const second = await w.engine.create({ sessionId: succ, trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(second.kind, "auto");
  await w.engine.onTurnEnd(succ, { success: true });
  assert.equal(w.engine.get(second.id).state, "committed");
  assert.deepEqual(w.repointed.at(-1), [succ, w.engine.get(second.id).successorId]);
});

test("an explicit own mode on the job is inherited by the successor as before; an own `suggest` job keeps cards", async () => {
  const own = jobWorld({ mode: "suggest" });
  await own.engine.setMode("ses_p", "auto");
  const r = await own.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await own.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(own.engine.get(r.id).state, "committed");
  assert.equal(own.engine._state.sessionModes[own.engine.get(r.id).successorId], "auto");
  const card = jobWorld({ mode: "auto" });
  await card.engine.setMode("ses_p", "suggest");
  for (const action of ["suggest", "handoff"]) {
    const c = await card.engine.create({ sessionId: "ses_p", trigger: "agent", action, body: FULL_BODY });
    assert.equal(c.kind, "suggest");
    assert.equal(c.state, "ready");
  }
});

test("an opencode-owned adopted session keeps today's rules: agent `suggest` with box default suggest is a card", async () => {
  const w = jobWorld({ mode: "suggest", owner: "opencode" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.kind, "suggest");
  assert.equal(rec.state, "ready");
  assert.equal(w.created.length, 0);
});

test("/handoff and the button stay cards inside a job", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user" });
  assert.equal(rec.kind, "suggest");
  await settle();
  assert.equal(w.engine.get(rec.id).state, "ready");
});

// ---- the armed trigger never applies to a manta job (§6.3) ----------------------------------------

test("maybeAuto returns early for a manta job — before any context measurement", async () => {
  let measured = 0;
  const w = jobWorld({ mode: "auto", extra: { gather: { facts: async () => null, measureContext: async () => (measured++, null) } } });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(measured, 0);
  await turn(w.engine, "ses_p");
  assert.equal(records(w).length, 0);
  assert.equal(measured, 0);
});

// ---- a failed turn is not a card in a job -----------------------------------------------------------

test("a failed turn in a job cancels the planned handoff — no card, no generation, the settler is told", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: "## Goal\nthin" });
  await w.engine.onTurnEnd("ses_p", { success: false });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "cancelled");
  assert.equal(w.generateCalls.length, 0, "no full-history generation for a card nobody sees");
  assert.equal(w.created.length, 0);
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
  assert.deepEqual(w.cleared, ["ses_p"]);
});

test("a failed turn outside a job still degrades the plan to a card", async () => {
  const w = standardWorld({ mode: "auto" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(w.engine.get(rec.id).state, "ready");
});

// ---- stop / pause / a finished job ---------------------------------------------------------------------

test("stop or pause while the handoff waits for the turn to end: the record is cancelled and no successor is made", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(await w.engine.cancelPendingSends("ses_p"), true);
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
  assert.deepEqual(w.cleared, ["ses_p"]);
  await w.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(w.created.length, 0);
  assert.equal(w.engine.get(rec.id).state, "cancelled", "nothing resurrects it");
  assert.equal(await w.engine.cancelPendingSends("ses_p"), false, "idempotent");
});

test("stop during the text generation: the late result neither makes a card nor starts a successor", async () => {
  const w = jobWorld({ mode: "suggest" });
  let release;
  const parked = new Promise((r) => (release = r));
  w.generateText = async () => {
    await parked;
    return FULL_BODY;
  };
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: "## Goal\nthin" });
  const ending = w.engine.onTurnEnd("ses_p", { success: true });
  await settle();
  assert.equal(w.engine.get(rec.id).state, "generating");
  await w.engine.cancelPendingSends("ses_p");
  release();
  await ending;
  await settle();
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.equal(w.created.length, 0);
});

test("stop during a start that has not created its successor: it cancels itself — fence released, nothing created", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    hooks: { step: async (name) => name === "fence" && (await w.engine.cancelPendingSends("ses_p")) },
  });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "cancelled");
  assert.equal(w.created.length, 0);
  assert.equal(w.engine._state.fences.ses_p, undefined);
  assert.equal(w.engine._runtime.ops.has("ses_p"), false);
  assert.ok(w.cleared.includes("ses_p"));
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
});

test("a job that finished between the turn end and the start gets no successor (the start re-checks it is still running)", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    hooks: { step: async (name) => name === "fence" && w.jobs.delete("ses_p") },
  });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.equal(w.created.length, 0);
  assert.equal(w.repointed.length, 0);
  assert.ok(w.cleared.includes("ses_p"));
});

test("a handoff NOT planned under the job rule is not cancelled by the start's job re-check", async () => {
  const w = standardWorld({ mode: "auto" });
  w.engine = w.build({ runningJobOwner: async () => null });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "committed");
});
