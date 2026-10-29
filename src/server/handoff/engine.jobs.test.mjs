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
        moveStatus(w, pred, succ);
      },
    },
    ...extra,
  });
  return w;
}

/** The delegate's records: a stop ends the record (`stopped`), a pause parks it; the commit's re-point carries either to the successor. */
const moveStatus = (w, pred, succ) => {
  if (w.statuses.has(pred)) {
    w.statuses.set(succ, w.statuses.get(pred));
    w.statuses.delete(pred);
  }
};
const endJob = (w, sid, status = "stopped") => {
  w.jobs.delete(sid);
  w.statuses.set(sid, status);
};

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
    assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "auto", isDefault: true, source: "job", unattended: true }, `box ${box}`);
    assert.equal(await w.engine.modeFor("ses_p"), "auto");
  }
});

test("resolveMode: the session's own mode wins and the job lookup is not even made", async () => {
  const w = jobWorld({ mode: "suggest" });
  await w.engine.setMode("ses_p", "off");
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "off", isDefault: false, source: "own", unattended: false });
  await w.engine.setMode("ses_p", "suggest");
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "suggest", isDefault: false, source: "own", unattended: false });
  assert.deepEqual(w.lookups, [], "an own suggest/off is an explicit choice: no job lookup");
});

test("resolveMode: an opencode-owned, non-job, paused or finished session gets the box default", async () => {
  const adopted = jobWorld({ mode: "suggest", owner: "opencode" });
  assert.deepEqual(await adopted.engine.resolveMode("ses_p"), { mode: "suggest", isDefault: true, source: "box", unattended: false });
  const plain = jobWorld({ mode: "off", owner: null });
  assert.deepEqual(await plain.engine.resolveMode("ses_p"), { mode: "off", isDefault: true, source: "box", unattended: false });
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
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "suggest", isDefault: true, source: "box", unattended: false });
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

// ---- stop / pause at EVERY window of a start (before creation, during, before the send, ready-with-plan) ----

/**
 * A job world whose engine runs `act` at the hook step `at`. `how` is what the user did: a stop ends the job record,
 * a pause leaves it `running` (it only parks at its next tool boundary) — the cancel itself is the same call.
 */
function windowWorld(at, how) {
  const w = jobWorld({ mode: "suggest" });
  const act = async () => {
    await w.engine.cancelPendingSends("ses_p");
    if (how === "stop") w.jobs.delete("ses_p");
  };
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    ownership: { repoint: async (pred, succ) => void w.repointed.push([pred, succ]) },
    hooks: { step: async (name) => name === at && (await act()) },
  });
  return w;
}
const expectUndone = (w, rec, { created }) => {
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "cancelled");
  assert.equal(w.repointed.length, 0, "the job is NOT re-pointed");
  assert.equal(w.windows[0].sid, "ses_p", "the window keeps the original session");
  assert.deepEqual(w.posts, [], "no handoff prompt was sent");
  assert.equal(w.engine._state.fences.ses_p, undefined, "fence released");
  assert.equal(w.engine._runtime.ops.has("ses_p"), false, "operation released");
  assert.deepEqual(w.engine._state.continuations, {});
  assert.equal(w.engine.hasPendingSend("ses_p"), false);
  assert.ok(w.cleared.includes("ses_p"), "the settler is told");
  assert.equal(w.engine._state.links.ses_p?.replacedBy, undefined);
  assert.equal(w.deleted.length, 1, "the delete of the pre-minted successor is always attempted");
  if (created) assert.deepEqual(w.deleted, w.created.map((c) => c.id), "the successor session that was made was deleted");
  else assert.deepEqual(w.created, [], "nothing was created");
};

for (const how of ["stop", "pause"]) {
  for (const [at, created] of [["fence", false], ["create", true], ["prepare", true]]) {
    test(`${how} at "${at}" (${created ? "after" : "before"} the successor exists${at === "prepare" ? ", before the send" : ""}): the start is undone`, async () => {
      const w = windowWorld(at, how);
      const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
      await w.engine.onTurnEnd("ses_p", { success: true });
      expectUndone(w, rec, { created });
    });
  }

  test(`${how} while the record is ready with a planned send (between ready and starting): it never takes the fence`, async () => {
    const w = jobWorld({ mode: "suggest" });
    let fired = false;
    w.engine = w.build({
      runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
      // the save right after the record became `ready` (inside produceText) is the ready→starting gap
      save: async (snap) => {
        w.disk.json = JSON.stringify(snap);
        if (!fired && Object.values(snap.records).some((r) => r.state === "ready" && r.internal.plan?.disposition === "send")) {
          fired = true;
          void w.engine.cancelPendingSends("ses_p"); // the flag is set synchronously
          if (how === "stop") w.jobs.delete("ses_p");
        }
      },
    });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
    await w.engine.onTurnEnd("ses_p", { success: true });
    await settle();
    assert.equal(fired, true);
    assert.equal(w.engine.get(rec.id).state, "cancelled");
    assert.deepEqual(w.created, []);
    assert.equal(w.repointed.length, 0);
    assert.equal(w.engine._state.fences.ses_p, undefined);
    assert.equal(w.engine.hasPendingSend("ses_p"), false);
  });
}

// ---- after the first message: the handoff commits, the successor's turn is interrupted --------------------

/** Stop (the job record ends) or pause (it keeps running with its pause flag) at the hook step `at`, with the cancel step run or not. */
function afterSendWorld(how, { cancelStep = true, at = "send" } = {}) {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    ownership: {
      repoint: async (pred, succ) => {
        w.repointed.push([pred, succ]);
        if (w.jobs.has(pred)) {
          w.jobs.set(succ, w.jobs.get(pred));
          w.jobs.delete(pred);
        }
        moveStatus(w, pred, succ);
      },
    },
    hooks: {
      step: async (name) => {
        if (name !== at) return;
        if (cancelStep) await w.engine.cancelPendingSends("ses_p");
        if (how === "stop") endJob(w, "ses_p");
        if (how === "pause") endJob(w, "ses_p", "paused");
      },
    },
  });
  return w;
}

for (const how of ["stop", "pause"]) {
  test(`${how} after the first message was sent: the handoff commits, the job stays on the successor, and the successor's turn is interrupted once`, async () => {
    const w = afterSendWorld(how);
    // the interrupt runs while the successor is still a handoff successor, so the adoption reconciler skips it (no rail row)
    const seen = [];
    w.onInterrupt = (id) => void seen.push({ id, isSuccessor: w.engine.isSuccessor(id) });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
    await w.engine.onTurnEnd("ses_p", { success: true });
    const done = w.engine.get(rec.id);
    assert.equal(done.state, "committed");
    assert.deepEqual(w.repointed, [["ses_p", done.successorId]], "the job record follows the successor");
    assert.deepEqual(w.interrupted, [done.successorId]);
    assert.deepEqual(seen, [{ id: done.successorId, isSuccessor: true }], "interrupted while still a handoff successor");
    assert.equal(w.accepted(done.successorId).length, 1, "the handoff was sent; the commit was not undone");
    assert.equal(w.engine._state.records[rec.id].internal.stopAfterCommit, true);
  });
}

test("a stop whose cancel step ran BEFORE the handoff record existed is caught at commit by the 'job no longer runs' check", async () => {
  const w = afterSendWorld("stop", { cancelStep: false });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.equal(w.engine._state.records[rec.id].internal.stopAfterCommit, undefined, "no flag: nobody cancelled it");
  assert.deepEqual(w.interrupted, [done.successorId]);
});

test("an uncertain first POST: a stop landing before the retry confirms still interrupts after the eventual commit", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null });
  w.failures.send.push({}, { status: 409 }, { status: 409 }, { status: 409 }); // first POST uncertain, every re-post refused → pending
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "starting");
  assert.deepEqual(w.interrupted, []);
  assert.equal(await w.engine.cancelPendingSends("ses_p"), true, "past the point of no return: flagged, not cancelled");
  endJob(w, "ses_p"); // stopJob wrote `stopped`
  await w.runTimers();
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.deepEqual(w.interrupted, [done.successorId]);
});

test("recovery: a persisted start flagged stopAfterCommit finishes its commit and then interrupts the successor", async () => {
  const w = jobWorld({ mode: "suggest" });
  const { Crash } = await import("./testWorld.mjs");
  w.crashAt = "link";
  const e1 = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null, hooks: { step: async (n) => { if (w.crashAt === n) throw new Crash(n); } } });
  const rec = await e1.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await e1.onTurnEnd("ses_p", { success: true }).catch(() => {});
  await settle();
  const disk = JSON.parse(w.disk.json);
  assert.equal(disk.records[rec.id].state, "starting");
  assert.ok(disk.records[rec.id].internal.commit, "mid-commit");
  disk.records[rec.id].internal.stopAfterCommit = true;
  w.disk.json = JSON.stringify(disk);
  w.crashAt = null;
  w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null });
  await w.engine.recover();
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.deepEqual(w.interrupted, [done.successorId]);
});

test("control: a normal handoff of a running job (no stop) interrupts nothing; neither does an attended one", async () => {
  const w = afterSendWorld("pause", { at: "never" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "committed");
  assert.deepEqual(w.interrupted, []);
  const plain = standardWorld({ mode: "auto" });
  const r = await plain.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await plain.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(plain.engine.get(r.id).state, "committed");
  assert.deepEqual(plain.interrupted, []);
});

test("a failing interrupt never fails the commit", async () => {
  const w = afterSendWorld("stop");
  w.onInterrupt = () => {
    throw new Error("opencode down");
  };
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "committed");
  assert.deepEqual(w.interrupted.length, 1);
});

test("recovery: a persisted start that was flagged cancelled after its successor was created is undone — successor deleted, nothing sent", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.crashAt = "prepare";
  const e1 = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null, hooks: { step: async (n) => { if (w.crashAt === n) throw new (await import("./testWorld.mjs")).Crash(n); } } });
  const rec = await e1.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await e1.onTurnEnd("ses_p", { success: true }).catch(() => {});
  await settle();
  const disk = JSON.parse(w.disk.json);
  const persisted = disk.records[rec.id];
  assert.equal(persisted.state, "starting");
  assert.equal(persisted.internal.created, true);
  persisted.internal.cancelled = true; // the stop that landed in the dying process
  w.disk.json = JSON.stringify(disk);
  w.crashAt = null;
  w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null });
  await w.engine.recover();
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "cancelled");
  assert.deepEqual(w.deleted, [persisted.successorId]);
  assert.deepEqual(w.posts, []);
  assert.equal(w.engine._state.fences.ses_p, undefined);
  assert.equal(w.repointed.length, 0);
});

test("a flagged ready record is refused by an automatic start; a user press clears the flag but the job re-check still refuses it while the job is stopped or parked", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  w.engine._state.records[rec.id].state = "ready";
  await w.engine.cancelPendingSends("ses_p");
  assert.equal(w.engine._state.records[rec.id].internal.cancelled, true);
  const auto = await w.engine.start(rec.id, { how: "clear", disposition: "send", origin: "auto" });
  assert.equal(auto.state, "cancelled");
  // the job still runs (a pause flagged it): the user's own press is a new decision and wins
  const w2 = jobWorld({ mode: "suggest" });
  const r2 = await w2.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  w2.engine._state.records[r2.id].state = "ready";
  await w2.engine.cancelPendingSends("ses_p");
  const user = await w2.engine.start(r2.id, { how: "clear", disposition: "send" });
  assert.equal(user.state, "committed");
  // the job is stopped / parked: the press clears the flag, but the job re-check refuses it (Decision 5)
  const w3 = jobWorld({ mode: "suggest" });
  const r3 = await w3.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  w3.engine._state.records[r3.id].state = "ready";
  await w3.engine.cancelPendingSends("ses_p");
  w3.jobs.delete("ses_p");
  const refused = await w3.engine.start(r3.id, { how: "clear", disposition: "send" });
  assert.equal(refused.state, "cancelled");
  assert.deepEqual(w3.created, []);
  assert.equal(w3.repointed.length, 0);
});

test("a flagged start whose fence step fails ends cancelled, not as a ready card on the stopped job's session", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    hooks: {
      step: async (name) => {
        if (name !== "fence") return;
        await w.engine.cancelPendingSends("ses_p");
        w.active.add("ses_p"); // the conversation is not idle: the fence step gives the start up
      },
    },
  });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.equal(w.engine._state.fences.ses_p, undefined);
  assert.equal(w.engine._runtime.ops.has("ses_p"), false);
  assert.equal(w.created.length, 0);
});

test("a flagged start cancelled before it recorded its creation still deletes the successor (a crash between the create and its persist)", async () => {
  const w = jobWorld({ mode: "suggest" });
  const { Crash } = await import("./testWorld.mjs");
  w.crashAt = "create"; // after createSession landed, before `created` is persisted
  const e1 = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null, hooks: { step: async (n) => { if (w.crashAt === n) throw new Crash(n); } } });
  const rec = await e1.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await e1.onTurnEnd("ses_p", { success: true }).catch(() => {});
  await settle();
  const disk = JSON.parse(w.disk.json);
  const persisted = disk.records[rec.id];
  assert.equal(persisted.internal.created, false, "the creation was never recorded");
  assert.ok(w.sessions.has(persisted.successorId), "…but the session exists");
  persisted.internal.cancelled = true;
  w.disk.json = JSON.stringify(disk);
  w.crashAt = null;
  w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null });
  await w.engine.recover();
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.deepEqual(w.deleted, [persisted.successorId]);
  assert.equal(w.sessions.has(persisted.successorId), false, "no empty successor is left behind");
});

// ---- item 2: the record's own flag, not a fresh lookup ---------------------------------------------------

test("a failed turn after the job was paused (lookup now null) still cancels a handoff planned under the job rule — no card, no generation", async () => {
  const w = jobWorld({ mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: "## Goal\nthin" });
  w.jobs.delete("ses_p"); // the pause interrupt parked the job before the turn-end handling ran
  await w.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(w.engine.get(rec.id).state, "cancelled");
  assert.equal(w.generateCalls.length, 0);
  assert.equal(w.created.length, 0);
});

test("commit: a lookup that answers null cannot make the job successor store the box default", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    hooks: { step: async (name) => name === "send" && endJob(w, "ses_p") }, // after the first message: past the point of no return
  });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "committed");
  assert.equal(w.engine._state.sessionModes[done.successorId], undefined, "nothing stored for the successor");
});

// ---- own `auto` on a manta job is unattended too ------------------------------------------------------------

test("own auto on a manta job: agent suggest starts, a failed turn cancels, the start re-checks the job, the successor inherits the explicit auto", async () => {
  const w = jobWorld({ mode: "suggest" });
  await w.engine.setMode("ses_p", "auto");
  assert.deepEqual(await w.engine.resolveMode("ses_p"), { mode: "auto", isDefault: false, source: "own", unattended: true });
  const start = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(start.kind, "auto");
  await w.engine.onTurnEnd("ses_p", { success: true });
  const done = w.engine.get(start.id);
  assert.equal(done.state, "committed");
  assert.equal(w.engine._state.sessionModes[done.successorId], "auto", "an explicit own mode is inherited as before");

  const failed = jobWorld({ mode: "suggest" });
  await failed.engine.setMode("ses_p", "auto");
  const f = await failed.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: "## Goal\nthin" });
  await failed.engine.onTurnEnd("ses_p", { success: false });
  assert.equal(failed.engine.get(f.id).state, "cancelled");
  assert.equal(failed.generateCalls.length, 0);

  const fin = jobWorld({ mode: "suggest" });
  await fin.engine.setMode("ses_p", "auto");
  fin.engine = fin.build({ runningJobOwner: async (sid) => fin.jobs.get(sid) ?? null, hooks: { step: async (n) => n === "fence" && fin.jobs.delete("ses_p") } });
  await fin.engine.setMode("ses_p", "auto");
  const r = await fin.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await fin.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(fin.engine.get(r.id).state, "cancelled", "the start re-check applies");
  assert.equal(fin.created.length, 0);
});

test("own auto on a session that is NOT a running job: an agent suggest is still a card; the lookup is made only for own auto / no own mode", async () => {
  const w = jobWorld({ mode: "suggest", owner: null });
  await w.engine.setMode("ses_p", "auto");
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.kind, "suggest");
  assert.deepEqual(w.lookups, ["ses_p"]);
  const off = jobWorld({ mode: "auto" });
  await off.engine.setMode("ses_p", "off");
  await off.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.deepEqual(off.lookups, []);
});

test("a pre-release job chain: a successor that inherited a stored auto is unattended while it runs (agent suggest starts)", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.addSession("ses_old_succ");
  w.jobs.set("ses_old_succ", "manta");
  w.engine._state.sessionModes.ses_old_succ = "auto"; // written by the previous release's commit
  w.addWindow("proj", 7, "chain", "ses_old_succ");
  const rec = await w.engine.create({ sessionId: "ses_old_succ", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.kind, "auto");
  await w.engine.onTurnEnd("ses_old_succ", { success: true });
  assert.equal(w.engine.get(rec.id).state, "committed");
});

test("maybeAuto returns early for an own-auto manta job as well, before measuring", async () => {
  let measured = 0;
  const w = jobWorld({ mode: "suggest", extra: { gather: { facts: async () => null, measureContext: async () => (measured++, null) } } });
  await w.engine.setMode("ses_p", "auto");
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(measured, 0);
});

// ---- round 3: positive signal only, confirm the interrupt, branches ----------------------------------------

test("an unreadable job store at commit (status unknown) never interrupts a running job's successor", async () => {
  for (const unknown of [null, undefined, "throw"]) {
    const w = afterSendWorld("pause", { at: "never" });
    w.engine = w.build({
      runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
      jobStatusOf: async () => {
        if (unknown === "throw") throw new Error("store unreadable");
        return unknown;
      },
    });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
    await w.engine.onTurnEnd("ses_p", { success: true });
    assert.equal(w.engine.get(rec.id).state, "committed", String(unknown));
    assert.deepEqual(w.interrupted, [], `a lookup answering ${unknown} is "can't tell": the job keeps running`);
  }
});

test("the job record on the successor exists and is paused (or failed) → interrupt; exists and running with no flag → no interrupt", async () => {
  for (const [status, want] of [["paused", 1], ["stopped", 1], ["failed", 1], ["running", 0]]) {
    const w = afterSendWorld("pause", { at: "never" });
    w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null, jobStatusOf: async () => status });
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
    await w.engine.onTurnEnd("ses_p", { success: true });
    assert.equal(w.interrupted.length, want, status);
    assert.equal(w.engine._state.records[rec.id].internal.stopAfterCommit, undefined);
  }
});

test("a pause that flagged the record keeps interrupting at commit (the user paused; parking at commit is accepted)", async () => {
  const w = afterSendWorld("pause", { at: "send" });
  w.statuses.clear();
  w.engine = w.build({
    runningJobOwner: async (sid) => w.jobs.get(sid) ?? null,
    jobStatusOf: async () => "running", // still running with pauseRequested: no record signal, only the flag
    hooks: { step: async (name) => name === "send" && (await w.engine.cancelPendingSends("ses_p")) },
  });
  await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.interrupted.length, 1);
});

test("the interrupt is confirmed once: a turn that starts just after the first interrupt gets one more; a quiet successor gets exactly one; never more than two", async () => {
  // the turn appears after the first interrupt (the prompt was still in the inbox when it landed)
  const w = afterSendWorld("stop");
  w.onInterrupt = () => {
    if (w.interrupted.length === 1) w.active.add(w.engine.get(Object.keys(w.engine._state.records)[0]).successorId);
    else w.active.delete(w.engine.get(Object.keys(w.engine._state.records)[0]).successorId);
  };
  await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.interrupted.length, 2, "re-interrupted because the turn was active");
  const quiet = afterSendWorld("stop");
  await quiet.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await quiet.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(quiet.interrupted.length, 1);
  // a successor that never stops: two attempts, then a warning — no loop
  const warns = [];
  const stuck = afterSendWorld("stop");
  stuck.engine = stuck.build({
    runningJobOwner: async (sid) => stuck.jobs.get(sid) ?? null,
    jobStatusOf: async () => "stopped",
    warn: (...a) => warns.push(a.join(" ")),
  });
  stuck.onInterrupt = (id) => void stuck.active.add(id); // the turn is always there
  await stuck.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await stuck.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(stuck.interrupted.length, 2);
  assert.ok(warns.some((m) => /still active after two interrupts/.test(m)));
});

test("a branch (new-session) handoff is never interrupted by a stop: the flag is not even set", async () => {
  const w = jobWorld({ mode: "suggest" });
  w.engine = w.build({ runningJobOwner: async (sid) => w.jobs.get(sid) ?? null, hooks: { step: async (name) => name === "send" && (await w.engine.cancelPendingSends("ses_p")) } });
  const card = await w.engine.create({ sessionId: "ses_p", trigger: "user", body: FULL_BODY });
  await settle();
  // a user-started branch with a send disposition
  const rec = w.engine._state.records[card.id];
  rec.state = "ready";
  const out = await w.engine.start(card.id, { how: "new-session", disposition: "send" });
  assert.equal(out.state, "committed");
  assert.equal(rec.internal.stopAfterCommit, undefined);
  assert.deepEqual(w.interrupted, []);
});
