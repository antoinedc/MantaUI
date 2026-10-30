import { test } from "node:test";
import assert from "node:assert/strict";
import { COOLDOWN_MS } from "./policy.mjs";
import { FULL_BODY, createWorld, settle, standardWorld } from "./testWorld.mjs";

const OPUS = { providerID: "anthropic", modelID: "claude-opus-4-8" };

/** Replay the lifecycle events of one turn: busy → a step that ends with `ctx` tokens → (error) → idle. */
async function turn(engine, sid, { ctx = 250_000, outcome = "ok", model = OPUS, steps = true } = {}) {
  const ev = (type, properties) => engine.observeEvent({ type, properties: { sessionID: sid, ...properties } });
  ev("session.status", { status: { type: "busy" } });
  if (steps) ev("session.next.step.ended", { tokens: { input: ctx, cache: { read: 0, write: 0 } }, ...model });
  if (outcome === "aborted") ev("session.error", { error: { name: "MessageAbortedError" } });
  if (outcome === "failed") ev("session.error", { error: { name: "ApiError" } });
  ev("session.status", { status: { type: "idle" } });
  ev("session.idle", {});
  await settle(10);
}
const records = (w, sid = "ses_p") => Object.values(w.engine._state.records).filter((r) => r.fromSessionId === sid);

test("auto mode: a successful turn over budget starts a replacement and sends the handoff — the work continues with no message from the user", async () => {
  const w = standardWorld();
  await turn(w.engine, "ses_p");
  const [rec] = records(w);
  assert.equal(rec.trigger, "auto");
  assert.equal(rec.kind, "auto");
  assert.equal(rec.state, "committed");
  assert.equal(rec.how, "clear");
  assert.equal(rec.disposition, "send");
  assert.equal(w.generateCalls.length, 1);
  const sent = w.accepted(rec.successorId);
  assert.equal(sent.length, 1, "the handoff itself is the successor's first message");
  assert.ok(sent[0].text.includes("## Goal"));
  assert.equal(w.windows[0].sid, rec.successorId);
  assert.equal(w.engine._state.continuations[rec.successorId].preamble, undefined, "nothing is held for a later message");
});

test("no trigger: under budget, aborted turn, errored turn, drain-abort", async () => {
  for (const [label, opts] of [["under budget", { ctx: 150_000 }], ["aborted", { outcome: "aborted" }], ["errored", { outcome: "failed" }]]) {
    const w = standardWorld();
    await turn(w.engine, "ses_p", opts);
    assert.equal(records(w).length, 0, label);
  }
});

test("a turn's end fires once even though opencode reports idle twice; an idle with no busy before it is ignored", async () => {
  const w = standardWorld();
  await turn(w.engine, "ses_p");
  w.engine.observeEvent({ type: "session.idle", properties: { sessionID: "ses_p" } });
  await settle();
  assert.equal(records(w).length, 1);
  const w2 = standardWorld();
  w2.engine.observeEvent({ type: "session.idle", properties: { sessionID: "ses_p" } });
  await settle();
  assert.equal(records(w2).length, 0);
});

test("suggest mode makes a ready card and never starts; off mode does nothing", async () => {
  const s = standardWorld({ mode: "suggest" });
  await turn(s.engine, "ses_p");
  const [rec] = records(s);
  assert.equal(rec.state, "ready");
  assert.equal(rec.kind, "suggest");
  assert.equal(rec.trigger, "auto");
  assert.equal(s.created.length, 0);
  const o = standardWorld({ mode: "off" });
  await turn(o.engine, "ses_p");
  assert.equal(records(o).length, 0);
  assert.equal(o.generateCalls.length, 0);
});

test("a window is required to take over in auto mode; a CTO conversation is never handed off", async () => {
  const w = createWorld();
  w.addSession("ses_p");
  w.engine = w.build();
  await turn(w.engine, "ses_p");
  assert.equal(records(w).length, 0, "no window → nothing to take over");
  const x = standardWorld();
  x.engine = x.build({ isExcluded: async () => true });
  await turn(x.engine, "ses_p");
  assert.equal(records(x).length, 0);
});

test("a running background job's own session: the armed trigger never applies to a manta-owned job (even with box default suggest); an opencode-owned one keeps today's rules", async () => {
  const a = standardWorld();
  a.engine = a.build({ isJobSession: async () => true });
  await turn(a.engine, "ses_p");
  assert.equal(records(a).length, 0, "auto: skipped for any running job");
  const s = standardWorld({ mode: "suggest" });
  s.engine = s.build({ runningJobOwner: async () => "manta" });
  await turn(s.engine, "ses_p");
  assert.equal(records(s).length, 0, "the job rule makes it auto, and the armed trigger never applies to a manta job");
  assert.equal(s.generateCalls.length, 0);
  const adopted = standardWorld({ mode: "suggest" });
  adopted.engine = adopted.build({ runningJobOwner: async () => "opencode" });
  await turn(adopted.engine, "ses_p");
  assert.equal(records(adopted)[0]?.state, "ready", "an adopted (opencode-owned) session: suggest still offers a card");
});

test("a routine run's session (metadata manta.routineId) never auto-hands off, even over budget in auto mode", async () => {
  const w = createWorld();
  w.addSession("ses_p", { metadata: { manta: { internal: true, routineId: "ab12cd34", runId: "0123456789" } } });
  w.addWindow("proj", 3, "work", "ses_p");
  w.engine = w.build();
  await turn(w.engine, "ses_p");
  assert.equal(records(w).length, 0);
  assert.equal(w.generateCalls.length, 0, "no full-history generation was paid for");
  // an ordinary session next to it still hands off
  const x = standardWorld();
  x.addSession("ses_q", { metadata: { manta: { internal: true } } });
  await turn(x.engine, "ses_p");
  assert.equal(records(x).length, 1);
});

test("cooldown: a session created by a handoff is not handed off again for 30 minutes", async () => {
  const w = standardWorld();
  await turn(w.engine, "ses_p");
  const succ = records(w)[0].successorId;
  w.addSession(succ);
  await turn(w.engine, succ, { ctx: 260_000 });
  assert.equal(records(w, succ).length, 0, "inside the cooldown");
  w.clock += COOLDOWN_MS + 1;
  await turn(w.engine, succ, { ctx: 260_000 });
  assert.equal(records(w, succ).length, 1, "after it");
});

test("only in-flight records (requested / generating / starting) block a new automatic attempt", async () => {
  for (const state of ["requested", "generating", "starting"]) {
    const w = standardWorld();
    const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: "## Goal\nthin" });
    w.engine._state.records[rec.id].state = state;
    await turn(w.engine, "ses_p");
    assert.equal(records(w).length, 1, `${state} blocks a second automatic record`);
    assert.ok(records(w).every((r) => r.trigger === "agent"));
  }
});

test("an auto-degraded ready card does not wedge auto mode: the next qualifying turn hands off and the old card is cancelled", async () => {
  const w = standardWorld();
  let release;
  const parked = new Promise((r) => (release = r));
  const body = w.generateText;
  w.generateText = async () => {
    await parked;
    return body;
  };
  await turn(w.engine, "ses_p");
  await w.engine.admitPrompt({ sessionId: "ses_p", text: "one more thing" });
  release();
  await settle(10);
  const [old] = records(w);
  assert.equal(old.state, "ready");
  assert.equal(old.reason, "you kept working");
  w.generateText = body;
  w.clock += 1; // (no successor yet, so no cooldown applies)
  await turn(w.engine, "ses_p");
  const after = records(w);
  assert.equal(after.length, 2);
  assert.equal(w.engine.get(old.id).state, "cancelled");
  const fresh = after.find((r) => r.id !== old.id);
  assert.equal(fresh.state, "committed");
  assert.ok(w.published.some((e) => e.payload.id === old.id && e.payload.state === "cancelled"), "the bus told clients to drop the card");
  assert.equal(JSON.parse(w.disk.json).records[old.id].state, "cancelled", "persisted");
});

test("a user / button / agent ready card never blocks auto and is left alone", async () => {
  for (const trigger of ["user", "agent"]) {
    const w = standardWorld();
    const card = trigger === "agent"
      ? await w.engine.create({ sessionId: "ses_p", trigger, action: "suggest", body: FULL_BODY })
      : await w.engine.create({ sessionId: "ses_p", trigger });
    await settle();
    assert.equal(w.engine.get(card.id).state, "ready");
    w.generateCalls.length = 0;
    await turn(w.engine, "ses_p");
    assert.equal(w.engine.get(card.id).state, "ready", `${trigger} card stays`);
    const auto = records(w).find((r) => r.trigger === "auto");
    assert.equal(auto.state, "committed");
  }
});

test("in suggest mode an unanswered automatic card is not regenerated every turn; a failed automatic attempt is not retried every turn", async () => {
  const w = standardWorld({ mode: "suggest" });
  await turn(w.engine, "ses_p");
  await turn(w.engine, "ses_p");
  const cards = records(w);
  assert.equal(cards.length, 1, "one card, not a fresh generation per turn");
  assert.equal(cards[0].state, "ready");
  const f = standardWorld();
  f.failures.generate.push({}, {});
  await turn(f.engine, "ses_p");
  assert.equal(records(f)[0].state, "failed");
  await turn(f.engine, "ses_p");
  assert.equal(records(f).length, 1, "no retry loop: a failed generation costs a full-history call");
  f.clock += COOLDOWN_MS + 1;
  await turn(f.engine, "ses_p");
  assert.equal(records(f).length, 2);
});

test("the user kept working while the handoff was being written: the automatic start aborts to a ready card", async () => {
  const w = standardWorld();
  let release;
  const parked = new Promise((r) => (release = r));
  w.generateText = async () => {
    await parked;
    return "## Goal\nx\n## Current state\n## Decisions (and why)\n## Dead ends tried\n## Next step\n## Open questions";
  };
  await turn(w.engine, "ses_p");
  assert.equal(records(w)[0].state, "generating");
  await w.engine.admitPrompt({ sessionId: "ses_p", text: "wait, one more thing" });
  release();
  await settle(10);
  const [rec] = records(w);
  assert.equal(rec.state, "ready");
  assert.equal(rec.reason, "you kept working");
  assert.equal(w.created.length, 0);
  assert.equal(w.acceptedIds("ses_p").length, 1, "their message went to the conversation they are still in");
});

test("a compaction (or any other operation) owning the session blocks the automatic trigger", async () => {
  const w = standardWorld();
  assert.equal(w.engine.acquireOperation("ses_p", "compaction"), true);
  await turn(w.engine, "ses_p");
  assert.equal(records(w).length, 0);
});

test("context measurement falls back to the transcript when no step was seen (e.g. right after a restart)", async () => {
  const w = standardWorld();
  w.engine = w.build({ gather: { facts: async () => null, measureContext: async () => ({ tokens: 300_000, ...OPUS }) } });
  await turn(w.engine, "ses_p", { steps: false });
  assert.equal(records(w).length, 1);
});

test("with a known window the budget is 60% of it for every family; with an unknown window small models get the smaller ceiling", async () => {
  const known = standardWorld(); // window 400k → 240k
  await turn(known.engine, "ses_p", { ctx: 120_000, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } });
  assert.equal(records(known).length, 0, "no family ceiling when the window is known");
  const small = standardWorld();
  small.engine = small.build({ contextLimitFor: () => null });
  await turn(small.engine, "ses_p", { ctx: 120_000, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } });
  assert.equal(records(small).length, 1, "unknown window: haiku ceiling 100k");
  const big = standardWorld();
  big.engine = big.build({ contextLimitFor: () => null });
  await turn(big.engine, "ses_p", { ctx: 120_000 });
  assert.equal(records(big).length, 0, "unknown window: opus ceiling 200k");
});

test("the automatic handoff carries the labelled facts into the successor's first message", async () => {
  const w = standardWorld();
  w.engine = w.build({ gather: { facts: async () => ({ predecessor: { id: "ses_p", title: "T" }, editedFiles: ["/proj/x.ts"], constraints: { items: ["no emojis"], at: 5 } }), measureContext: async () => null } });
  await turn(w.engine, "ses_p");
  const succ = records(w)[0].successorId;
  const pre = w.accepted(succ)[0].text;
  assert.match(pre, /- \(observed\) files this session edited: 1/);
  assert.match(pre, /- \(inferred\) standing instructions/);
});

test("policyFor: authoritative per session — measurement, budget, time and mode; null when this session was never measured", async () => {
  const w = standardWorld();
  assert.equal(await w.engine.policyFor("ses_p"), null);
  await turn(w.engine, "ses_p", { ctx: 120_000 });
  const p = await w.engine.policyFor("ses_p");
  assert.equal(p.contextTokens, 120_000);
  assert.equal(p.budget, 240_000, "60% of the 400k window");
  assert.equal(p.mode, "auto");
  assert.equal(typeof p.measuredAt, "number");
  assert.equal(await w.engine.policyFor("ses_other"), null, "never another session's numbers");
  w.mode = "off";
  assert.equal((await w.engine.policyFor("ses_p")).mode, "off");
});
