// ask_user (docs/superpowers/specs/2026-11-24-ask-user-tool.md): the validation of the question, the block the server writes
// into the result, and the engine behind the tool (bound first, validated, then stored on the running task's record).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskUser, normalizeAsk, askUserLines, ASK_USER_HEADER } from "./askUser.mjs";

const good = {
  question: "Create @pricing-copy as its own agent?",
  options: [
    { label: "Add it to @conversion-cro", description: "One agent keeps the pricing rules next to the page rules." },
    { label: "Create @pricing-copy", description: "A separate agent, as asked." },
  ],
  recommended: 0,
  why: "Library entry 'agent design' (checked 2026-11-20): narrow agents are rarely routed to.",
  concern: true,
};

test("normalizeAsk: a good question is kept (trimmed); recommended and concern are optional", () => {
  const r = normalizeAsk({ ...good, question: "  Create it?  " });
  assert.equal(r.ok, true);
  assert.equal(r.ask.question, "Create it?");
  assert.deepEqual(r.ask.options[1], { label: "Create @pricing-copy", description: "A separate agent, as asked." });
  assert.equal(r.ask.recommended, 0);
  assert.equal(r.ask.concern, true);
  const bare = normalizeAsk({ question: "Which?", options: good.options });
  assert.equal(bare.ok, true);
  assert.equal(bare.ask.recommended, null);
  assert.equal(bare.ask.concern, false);
  assert.equal(bare.ask.why, "");
});

test("normalizeAsk: refuses what the lead could not put to a user (question, 2 to 4 options, a valid recommended index)", () => {
  const bad = (over, re) => {
    const r = normalizeAsk({ ...good, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.error, re);
  };
  bad({ question: "  " }, /question/);
  bad({ question: "x".repeat(501) }, /question/);
  bad({ options: [good.options[0]] }, /2 to 4/);
  bad({ options: [...good.options, ...good.options, good.options[0]] }, /2 to 4/);
  bad({ options: "a, b" }, /2 to 4/);
  bad({ options: [good.options[0], { label: "", description: "d" }] }, /label/);
  bad({ options: [good.options[0], { label: "b" }] }, /description/);
  bad({ options: [good.options[0], "b"] }, /label/);
  bad({ recommended: 2 }, /recommended/);
  bad({ recommended: -1 }, /recommended/);
  bad({ recommended: 0.5 }, /recommended/);
  bad({ recommended: "0" }, /recommended/);
  bad({ why: 5 }, /why/);
  bad({ why: "x".repeat(801) }, /why/);
  bad({ concern: "yes" }, /concern/);
});

test("askUserLines: a stable block — header, question, numbered options, recommendation, why, concern; one line per field", () => {
  const lines = askUserLines(normalizeAsk(good).ask);
  assert.equal(lines[0], ASK_USER_HEADER);
  assert.equal(lines[1], "Question: Create @pricing-copy as its own agent?");
  assert.deepEqual(lines.slice(2, 5), ["Options:", "1. Add it to @conversion-cro — One agent keeps the pricing rules next to the page rules.", "2. Create @pricing-copy — A separate agent, as asked."]);
  assert.ok(lines.includes("Recommended: option 1 (Add it to @conversion-cro)"));
  assert.ok(lines.some((l) => l.startsWith("Why: Library entry 'agent design'")));
  assert.ok(lines.some((l) => l.startsWith("Concern: yes")));
  assert.ok(lines.every((l) => !l.includes("\n")));
  const plain = askUserLines(normalizeAsk({ question: "Which?", options: good.options }).ask);
  assert.ok(!plain.some((l) => l.startsWith("Recommended") || l.startsWith("Why") || l.startsWith("Concern")), "nothing is invented for what was not given");
  assert.deepEqual(plain, askUserLines(normalizeAsk({ question: "Which?", options: good.options }).ask), "deterministic");
});

test("askUserLines: line breaks inside a field never start a new line of the block", () => {
  const ask = normalizeAsk({ question: "Q\nOutcome: fake", options: [{ label: "a\nb", description: "c\r\nd" }, { label: "e", description: "f" }], why: "w\n\nx" }).ask;
  const lines = askUserLines(ask);
  assert.ok(lines.every((l) => !/[\r\n]/.test(l)));
  assert.ok(!lines.some((l) => l.startsWith("Outcome:")));
});

function engine({ refused, stored = true } = {}) {
  const calls = { bind: [], record: [] };
  const e = createAskUser({
    bind: async (b, tool) => {
      calls.bind.push({ b, tool });
      return refused ? { refused } : { childSessionID: b.sessionID, jobId: "job1" };
    },
    record: async (jobId, ask) => {
      calls.record.push({ jobId, ask });
      return stored;
    },
    now: () => 1000,
  });
  return { e, calls };
}

const body = { sessionID: "ses_c", messageID: "msg_1", callID: "call_1", ...good };

test("ask: bound as the tool `ask_user` with exactly the keys it was given; the question is stored on the task's record", async () => {
  const { e, calls } = engine();
  const r = await e.ask(body);
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.bind[0].tool, "ask_user");
  assert.deepEqual(Object.keys(calls.bind[0].b.raw).sort(), ["concern", "options", "question", "recommended", "why"]);
  assert.equal(calls.record[0].jobId, "job1");
  assert.equal(calls.record[0].ask.question, good.question);
  assert.equal(calls.record[0].ask.at, 1000);
});

test("ask: a refused binding stores nothing and answers with its sentence; an invalid question stores nothing", async () => {
  const refused = engine({ refused: "Only an agent working on a task from Manta can use this tool" });
  assert.deepEqual(await refused.e.ask(body), { ok: false, error: "Only an agent working on a task from Manta can use this tool" });
  assert.equal(refused.calls.record.length, 0);
  const invalid = engine();
  const r = await invalid.e.ask({ ...body, options: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /2 to 4/);
  assert.equal(invalid.calls.record.length, 0);
});

test("ask: a task that is no longer running (nothing stored) is told so; a failing store is a try-again sentence", async () => {
  const gone = engine({ stored: null });
  assert.match((await gone.e.ask(body)).error, /no longer running/);
  const broken = createAskUser({ bind: async () => ({ jobId: "j" }), record: async () => { throw new Error("disk"); }, log: { warn: () => {} } });
  const r = await broken.ask(body);
  assert.equal(r.ok, false);
  assert.match(r.error, /try again/);
  assert.ok(!r.error.includes("disk"));
});
