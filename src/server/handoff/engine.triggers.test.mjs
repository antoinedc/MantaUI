import { test } from "node:test";
import assert from "node:assert/strict";
import { COOLDOWN_MS } from "./policy.mjs";
import { createWorld, settle, standardWorld } from "./testWorld.mjs";

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

test("auto mode: a successful turn over budget starts an armed replacement — nothing runs in the successor yet", async () => {
  const w = standardWorld();
  await turn(w.engine, "ses_p");
  const [rec] = records(w);
  assert.equal(rec.trigger, "auto");
  assert.equal(rec.kind, "auto");
  assert.equal(rec.state, "committed");
  assert.equal(rec.how, "clear");
  assert.equal(rec.disposition, "armed");
  assert.equal(w.generateCalls.length, 1);
  assert.equal(w.accepted(rec.successorId).length, 0);
  assert.equal(w.windows[0].sid, rec.successorId);
  assert.ok(w.engine._state.continuations[rec.successorId].preamble);
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

test("a running background job's own session: auto never replaces it (its turn end is its completion); suggest still offers a card", async () => {
  const a = standardWorld();
  a.engine = a.build({ isJobSession: async () => true });
  await turn(a.engine, "ses_p");
  assert.equal(records(a).length, 0);
  const s = standardWorld({ mode: "suggest" });
  s.engine = s.build({ isJobSession: async () => true });
  await turn(s.engine, "ses_p");
  assert.equal(records(s)[0]?.state, "ready");
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

test("no second record while one is in flight or waiting as a card; a failed automatic attempt is not retried every turn", async () => {
  const w = standardWorld({ mode: "suggest" });
  await turn(w.engine, "ses_p");
  await turn(w.engine, "ses_p");
  assert.equal(records(w).length, 1, "the unanswered card is enough");
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

test("small models get the smaller budget: 120k of context is over for haiku, under for opus", async () => {
  const small = standardWorld();
  await turn(small.engine, "ses_p", { ctx: 120_000, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } });
  assert.equal(records(small).length, 1);
  const big = standardWorld();
  await turn(big.engine, "ses_p", { ctx: 120_000 });
  assert.equal(records(big).length, 0);
});

test("the armed preamble carries the labelled facts; the card text never goes into model context via the tool path", async () => {
  const w = standardWorld();
  w.engine = w.build({ gather: { facts: async () => ({ predecessor: { id: "ses_p", title: "T" }, editedFiles: ["/proj/x.ts"], constraints: { items: ["no emojis"], at: 5 } }), measureContext: async () => null } });
  await turn(w.engine, "ses_p");
  const succ = records(w)[0].successorId;
  const pre = w.engine._state.continuations[succ].preamble;
  assert.match(pre, /- \(observed\) files this session edited: 1/);
  assert.match(pre, /- \(inferred\) standing instructions/);
});

test("policyFor: authoritative per session — measurement, budget, time and mode; null when this session was never measured", async () => {
  const w = standardWorld();
  assert.equal(await w.engine.policyFor("ses_p"), null);
  await turn(w.engine, "ses_p", { ctx: 120_000 });
  const p = await w.engine.policyFor("ses_p");
  assert.equal(p.contextTokens, 120_000);
  assert.equal(p.budget, 200_000);
  assert.equal(p.mode, "auto");
  assert.equal(typeof p.measuredAt, "number");
  assert.equal(await w.engine.policyFor("ses_other"), null, "never another session's numbers");
  w.mode = "off";
  assert.equal((await w.engine.policyFor("ses_p")).mode, "off");
});
