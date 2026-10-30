// Cold-cache handoff (spec Part B): who writes the text, the condensed path, Rewrite,
// attempts, the owned operation lock, sticky retry and boot recovery — over the
// fake world (no model, no disk, no clock).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FULL_BODY, SUMMARY_MODEL, coldWorld, settle, transcriptAt, standardWorld, readyRecord } from "./testWorld.mjs";

const COLD_COST = (18.75 * 120_000 + 75 * 2_000) / 1e6;

/** A cold user-triggered handoff, settled. */
async function coldCard(w, over = {}) {
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user", goal: "auth", ...over });
  await settle();
  return rec.id;
}
const rawRec = (w, id) => w.engine._state.records[id];
const lockFree = (w) => {
  const t = w.engine.acquireOperation("ses_p", "probe");
  if (t) w.engine.releaseOperation("ses_p", t);
  return Boolean(t);
};
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

test("cold card: the Summary model writes from a condensed transcript — never oc.generate; the facts get the transcript that was already read", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  const rec = w.engine.get(id);
  assert.equal(rec.state, "ready");
  assert.equal(w.generateCalls.length, 0, "the session's own model is never asked");
  assert.equal(w.cheapCalls.length, 1);
  assert.deepEqual(w.cheapCalls[0].model, { providerID: "deepseek", modelID: "deepseek-chat" });
  assert.match(w.cheapCalls[0].instruction, /<transcript>[\s\S]*npm test[\s\S]*<\/transcript>/);
  assert.ok(!w.cheapCalls[0].instruction.includes("x".repeat(200)), "tool output is dropped");
  assert.match(w.cheapCalls[0].instruction, /focus on: auth/);
  assert.ok(w.cheapCalls[0].opts.signal instanceof AbortSignal);
  assert.equal(rec.writer.path, "condensed");
  assert.equal(rec.writer.providerID, "deepseek");
  assert.equal(typeof rec.writer.inputTokens, "number");
  assert.deepEqual(rec.rewriteEstimate, { providerID: "anthropic", modelID: "claude-opus-4-8", estTokens: 120_000, estCostUsd: COLD_COST, subscription: false });
  assert.equal(rec.canRewrite, true);
  assert.equal(w.transcriptReads, 1, "the transcript is read ONCE");
  assert.equal(w.factsArgs[0].messages, w.transcript, "…and handed to the fact gatherer");
  assert.match(w.logs.at(-1), /^\[handoff\] writer=condensed reason=cold ctx=120000 idle=\d+s ttl=300s model=deepseek\/deepseek-chat in=\d+ outcome=ready$/);
});

test("warm cache, small context, no Summary model: the session writes (oc.generate), nothing is condensed, no Rewrite is offered", async () => {
  for (const [label, tweak, reason] of [
    ["warm", (w) => (w.transcript = transcriptAt(w.clock - 1000)), "warm"],
    ["small", (w) => (w.measure = { ...w.measure, tokens: 20_000 }), "small"],
    ["no summary model", (w) => (w.summary = null), "no-summary-model"],
  ]) {
    const w = coldWorld();
    tweak(w);
    const id = await coldCard(w);
    const rec = w.engine.get(id);
    assert.equal(rec.state, "ready", label);
    assert.equal(w.generateCalls.length, 1, label);
    assert.equal(w.cheapCalls.length, 0, `${label}: never a cheap model nobody chose`);
    assert.deepEqual(rec.writer, { path: "session" }, label);
    assert.equal(rec.canRewrite, false, label);
    assert.equal(rec.rewriteEstimate, undefined, label);
    assert.match(w.logs.at(-1), new RegExp(`writer=session reason=${reason} `), label);
  }
});

test("a planned send is never condensed (the new session starts on it at once)", async () => {
  const w = coldWorld({ mode: "auto" });
  const card = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: "thin" });
  assert.equal(card.state, "requested");
  await w.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(w.cheapCalls.length, 0);
  assert.equal(w.generateCalls.length, 1);
  assert.equal(w.engine.get(card.id).state, "committed");
  assert.match(w.logs[0], /writer=session reason=unseen-send/);
});

test("the Summary model leaves out sections: ONE reminder retry, then failed with the cause — and the Rewrite estimate is there", async () => {
  const w = coldWorld();
  w.cheapText = "just some prose";
  const id = await coldCard(w);
  const rec = w.engine.get(id);
  assert.equal(w.cheapCalls.length, 2);
  assert.match(w.cheapCalls[1].instruction, /missing these sections: ## Goal/);
  assert.equal(rec.state, "failed");
  assert.match(rec.reason, /^DeepSeek Chat couldn't write the handoff: it left out Goal/);
  assert.equal(rec.rewriteEstimate.estTokens, 120_000);
  assert.equal(rec.canRewrite, true);
  assert.equal(w.generateCalls.length, 0, "never an automatic expensive fallback");
  assert.equal(rawRec(w, id).internal.lastWriter, "condensed", "the FIRST cold failure records its writer");
  assert.match(w.logs.at(-1), /outcome=failed$/);
});

test("the reminder retry can succeed; an empty reply is reminded as empty", async () => {
  const w = coldWorld();
  const replies = ["", FULL_BODY];
  w.cheapText = () => replies.shift();
  const id = await coldCard(w);
  assert.equal(w.engine.get(id).state, "ready");
  assert.match(w.cheapCalls[1].instruction, /previous reply was empty/);
});

test("a throwing Summary model fails once, with a readable cause (rate limit / credit / timeout)", async () => {
  for (const [f, cause] of [[{ status: 429 }, "it is rate limited"], [{ status: 402 }, "it is out of credit"], [{}, "it timed out"]]) {
    const w = coldWorld();
    w.failures.cheap.push(f);
    const id = await coldCard(w);
    assert.equal(w.cheapCalls.length, 1, "a call that threw is not retried");
    assert.equal(w.engine.get(id).reason, `DeepSeek Chat couldn't write the handoff: ${cause}.`);
  }
});

test("a prompt that cannot fit the Summary model's window fails visibly (Rewrite offered), with no call", async () => {
  const w = coldWorld();
  w.summary = { ...SUMMARY_MODEL, limit: { context: 8_200 } };
  const id = await coldCard(w);
  const rec = w.engine.get(id);
  assert.equal(rec.state, "failed");
  assert.equal(rec.reason, "The conversation is too large for DeepSeek Chat.");
  assert.equal(w.cheapCalls.length, 0);
  assert.equal(rec.canRewrite, true);
});

test("rewrite: the session's own model re-reads the full history (oc.generate), the force is consumed, the lock was the rewrite's own", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  const started = await w.engine.rewrite(id);
  assert.equal(started.state, "generating");
  assert.equal(started.canRewrite, false);
  await settle();
  const rec = w.engine.get(id);
  assert.equal(rec.state, "ready");
  assert.equal(w.generateCalls.length, 1);
  assert.equal(w.cheapCalls.length, 1, "no second cheap call");
  assert.deepEqual(rec.writer, { path: "session" });
  assert.equal(rec.rewriteEstimate, undefined);
  assert.equal(rec.canRewrite, false);
  const j = rawRec(w, id).internal;
  assert.equal(j.forceWriter, undefined);
  assert.equal(j.attempt, undefined);
  assert.ok(lockFree(w));
  assert.match(w.logs.at(-1), /writer=session reason=forced .* outcome=ready$/);
});

test("rewrite refuses with the specific cause: expired (404), nothing to rewrite, already being written", async () => {
  const w = coldWorld();
  await assert.rejects(w.engine.rewrite("hof_none"), (e) => e.code === "expired");
  const plain = await readyRecord(w);
  await assert.rejects(w.engine.rewrite(plain.id), (e) => e.code === "not_ready" && /trimmed transcript/.test(e.message));
  const id = await coldCard(w);
  const g = gate();
  w.generateText = () => g.p;
  await w.engine.rewrite(id);
  await settle();
  await assert.rejects(w.engine.rewrite(id), (e) => e.code === "not_ready" && /being written right now/.test(e.message));
  g.open(FULL_BODY);
  await settle();
});

test("a Rewrite holds the session: another record's retry is busy, a compaction cannot take it, and it is released at the end", async () => {
  const w = coldWorld();
  w.cheapText = "no headings";
  const failedId = await coldCard(w);
  w.cheapText = FULL_BODY;
  const readyId = await coldCard(w);
  const g = gate();
  w.generateText = () => g.p;
  await w.engine.rewrite(readyId);
  await settle();
  await assert.rejects(w.engine.retry(failedId), (e) => e.code === "busy");
  assert.equal(w.engine.acquireOperation("ses_p", "compaction"), null);
  assert.equal(w.engine.get(failedId).state, "failed", "the refused retry changed nothing");
  g.open(FULL_BODY);
  await settle();
  assert.ok(lockFree(w));
});

test("a failed rewrite of a READY card gives the card back with every field, and says why", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  const before = w.engine.get(id);
  w.failures.generate.push({}, {});
  await w.engine.rewrite(id);
  await settle();
  const after = w.engine.get(id);
  assert.equal(after.state, "ready");
  assert.match(after.reason, /couldn't write the handoff prompt/);
  for (const k of ["text", "writer", "rewriteEstimate", "canRewrite"]) assert.deepEqual(after[k], before[k], k);
  assert.equal(rawRec(w, id).internal.attempt, undefined);
  assert.equal(rawRec(w, id).internal.textReady, true);
  assert.ok(lockFree(w));
});

test("a failed rewrite of a FAILED card stays failed with the new reason and keeps the estimate; its retry stays on the session model", async () => {
  const w = coldWorld();
  w.cheapText = "no headings";
  const id = await coldCard(w);
  w.failures.generate.push({}, {});
  await w.engine.rewrite(id);
  await settle();
  const failed = w.engine.get(id);
  assert.equal(failed.state, "failed");
  assert.match(failed.reason, /couldn't write the handoff prompt/);
  assert.ok(failed.rewriteEstimate);
  const cheapBefore = w.cheapCalls.length;
  await w.engine.retry(id);
  await settle();
  assert.equal(w.engine.get(id).state, "ready");
  assert.equal(w.cheapCalls.length, cheapBefore, "a failed Rewrite is never silently turned back into a cheap write");
});

test("retry of a condensed failure stays condensed after the cache warms; without a Summary model it fails visibly", async () => {
  const w = coldWorld();
  w.cheapText = "no headings";
  const id = await coldCard(w);
  w.cheapText = FULL_BODY;
  w.transcript = transcriptAt(w.clock); // warm now
  await w.engine.retry(id);
  await settle();
  const ok = w.engine.get(id);
  assert.equal(ok.state, "ready");
  assert.equal(ok.writer.path, "condensed");
  assert.equal(w.generateCalls.length, 0);

  const w2 = coldWorld();
  w2.cheapText = "no headings";
  const id2 = await coldCard(w2);
  w2.summary = null;
  await w2.engine.retry(id2);
  await settle();
  const bad = w2.engine.get(id2);
  assert.equal(bad.state, "failed");
  assert.equal(bad.reason, "No summary model is available.");
  assert.equal(w2.generateCalls.length, 0);
  assert.equal(bad.canRewrite, true, "Rewrite stays the way out");
});

test("a stale result is discarded when the attempt changed (and the lock still frees)", async () => {
  const w = coldWorld();
  const g = gate();
  w.cheapText = () => g.p;
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle();
  assert.equal(w.cheapCalls.length, 1);
  rawRec(w, rec.id).internal.attempt = { id: "att_newer", kind: "retry" };
  g.open(FULL_BODY);
  await settle();
  const r = w.engine.get(rec.id);
  assert.equal(r.state, "generating", "untouched");
  assert.equal(r.text, "");
  assert.ok(lockFree(w));
});

test("a complete agent body is ready (or, planned, started) with NO model call and no attempt", async () => {
  const w = coldWorld();
  const card = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(card.state, "ready");
  assert.deepEqual(card.writer, { path: "session" });
  assert.equal(rawRec(w, card.id).internal.attempt, undefined);
  assert.equal(w.generateCalls.length + w.cheapCalls.length, 0);

  const a = coldWorld({ mode: "auto" });
  const planned = await a.engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  assert.equal(planned.state, "requested");
  await a.engine.onTurnEnd("ses_p", { success: true });
  assert.equal(a.engine.get(planned.id).state, "committed");
  assert.equal(a.generateCalls.length + a.cheapCalls.length, 0);
  assert.equal(rawRec(a, planned.id).internal.attempt, undefined);
});

test("a rejected persist during create, retry or rewrite restores the record and releases the lock", async () => {
  const w = coldWorld();
  let fail = false;
  w.engine = w.build({ save: async (snap) => { if (fail) throw new Error("disk full"); w.disk.json = JSON.stringify(snap); } });

  fail = true;
  await assert.rejects(w.engine.create({ sessionId: "ses_p", trigger: "user" }), /disk full/);
  assert.equal(Object.keys(w.engine._state.records).length, 0, "the card never existed");
  assert.ok(lockFree(w));
  fail = false;

  w.cheapText = "no headings";
  const failedId = await coldCard(w);
  const failedBefore = w.engine.get(failedId);
  fail = true;
  await assert.rejects(w.engine.retry(failedId), /disk full/);
  const f = w.engine.get(failedId);
  assert.equal(f.state, "failed");
  assert.equal(f.reason, failedBefore.reason);
  assert.equal(rawRec(w, failedId).internal.attempt, undefined);
  assert.ok(lockFree(w));
  fail = false;

  w.cheapText = FULL_BODY;
  const readyId = await coldCard(w);
  const readyBefore = w.engine.get(readyId);
  fail = true;
  await assert.rejects(w.engine.rewrite(readyId), /disk full/);
  const r = w.engine.get(readyId);
  assert.equal(r.state, "ready");
  assert.equal(r.text, readyBefore.text);
  assert.equal(r.canRewrite, true);
  assert.equal(rawRec(w, readyId).internal.attempt, undefined);
  assert.equal(rawRec(w, readyId).internal.forceWriter, undefined);
  assert.ok(lockFree(w));
});

test("the estimate is never NaN: a price with no output, no price at all, the 1h rate, a subscription", async () => {
  const cases = [
    [{ listPrice: { input: 15, cacheWrite: 18.75 }, oneHour: false, subscription: false }, null, false],
    [null, null, false],
    [{ listPrice: null, oneHour: false, subscription: true }, null, true],
    [{ listPrice: { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30 }, oneHour: true, subscription: false }, (30 * 120_000 + 75 * 2_000) / 1e6, false],
    [{ listPrice: { input: 15, output: 75, cacheWrite: 18.75 }, oneHour: true, subscription: false }, null, false], // 1h claimed but no 1h rate → unknown, not NaN
    [{ listPrice: { input: 15, output: 75, cacheWrite: 18.75, tiers: [{ minPromptTokens: 100_000, input: 30, output: 150, cacheWrite: 37.5 }] }, oneHour: false, subscription: false }, (37.5 * 120_000 + 150 * 2_000) / 1e6, false],
  ];
  for (const [prices, cost, subscription] of cases) {
    const w = coldWorld();
    w.prices = prices;
    const rec = w.engine.get(await coldCard(w));
    assert.equal(rec.rewriteEstimate.estCostUsd, cost);
    assert.equal(rec.rewriteEstimate.subscription, subscription);
  }
});

test("a replacement republishes the replaced session's cards with canRewrite false, and Rewrite is refused", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  assert.equal(w.engine.get(id).canRewrite, true);
  const other = await readyRecord(w);
  await w.engine.start(other.id, { how: "clear", disposition: "draft" });
  assert.equal(w.engine.get(id).canRewrite, false);
  const last = w.published.filter((e) => e.payload.id === id).at(-1).payload;
  assert.equal(last.canRewrite, false);
  await assert.rejects(w.engine.rewrite(id), (e) => e.code === "not_ready" && /already handed off/.test(e.message));
});

test("records and events expose writer / canRewrite / rewriteEstimate", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  const ev = w.published.filter((e) => e.payload.id === id).at(-1).payload;
  assert.equal(ev.state, "ready");
  assert.equal(ev.canRewrite, true);
  assert.equal(ev.writer.path, "condensed");
  assert.equal(ev.rewriteEstimate.estTokens, 120_000);
  assert.equal(w.engine.get(id).canRewrite, true);
  assert.equal((await w.engine.list({ sessionId: "ses_p" })).records[0].canRewrite, true);
  assert.equal(w.engine.get(id).internal, undefined);
});

test("boot recovery: an interrupted rewrite gives the ready card back; every other generating record fails; flags are cleared", async () => {
  const w = coldWorld();
  const id = await coldCard(w);
  const before = w.engine.get(id);
  const g = gate();
  w.generateText = () => g.p; // the rewrite never finishes (the process dies)
  await w.engine.rewrite(id);
  w.cheapText = () => new Promise(() => {});
  const hanging = await w.engine.create({ sessionId: "ses_p", trigger: "user" }).catch((e) => e);
  assert.equal(hanging.code, "busy", "the rewrite holds the session");
  await settle();

  // a second generating record on ANOTHER session, interrupted mid-generation
  w.addSession("ses_q");
  w.addWindow("proj", 4, "other", "ses_q");
  w.generateText = () => new Promise(() => {});
  const q = await w.engine.create({ sessionId: "ses_q", trigger: "user" });
  await settle();
  assert.equal(w.engine.get(q.id).state, "generating");

  const e2 = w.build();
  assert.equal(e2.get(id).state, "generating");
  await e2.recover();
  const r = e2.get(id);
  assert.equal(r.state, "ready");
  assert.equal(r.reason, "The rewrite was interrupted by a restart.");
  for (const k of ["text", "writer", "rewriteEstimate", "canRewrite"]) assert.deepEqual(r[k], before[k], k);
  assert.equal(e2.get(q.id).state, "failed");
  assert.equal(e2.get(q.id).reason, "interrupted by a restart");
  for (const x of [id, q.id]) {
    assert.equal(e2._state.records[x].internal.attempt, undefined);
    assert.equal(e2._state.records[x].internal.forceWriter, undefined);
  }
});

test("a standard (warm, small) card is untouched by all of this: oc.generate, a session writer, no estimate", async () => {
  const w = standardWorld();
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle();
  const done = w.engine.get(rec.id);
  assert.equal(done.state, "ready");
  assert.equal(w.generateCalls.length, 1);
  assert.equal(done.canRewrite, false);
});
