import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT_CHARS, buildCaptureInput, createCapture, createCaptureMessageSource, extractJson, makeReportCost, parseCaptureNotes } from "./capture.mjs";
import { createQueue } from "./queue.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const SLUG = "alpha-0123456789";
const MIN = 60_000;
const scanner = { redact: async (t) => ({ text: t.replace(/SECRETVALUE/g, "[REDACTED]"), redacted: /SECRETVALUE/.test(t) ? 1 : 0, unavailable: false }) };

const msg = (id, role, at, text, extra = []) => ({ id, role, at, parts: [...(text ? [{ id: `${id}:text:0`, type: "text", text }] : []), ...extra] });
const tool = (command, output = "ok") => ({ id: "x", type: "tool", tool: "bash", command, output });

async function rig({ messages = [], session = { title: "fix the build" }, userAuthored = ["msg_u1", "msg_u2", "msg_u3", "msg_u4"], answer, over = {} } = {}) {
  const state = await memState();
  const root = await tmpDir("knowledge-capture-");
  let t = 10_000_000;
  const now = () => t;
  const queue = createQueue({ state, scanner, root, now });
  const marked = [];
  const mapped = { ses_1: { slug: SLUG } };
  const runs = [];
  const costs = [];
  let budgetOk = true;
  const store = { messages, answer };
  const seenPrompts = [];
  const cap = createCapture({
    state,
    queue,
    now,
    log: () => {},
    sessionMap: { get: (id) => mapped[id] ?? null, markCaptured: (id) => marked.push(id) },
    budget: { canSpend: async () => ({ ok: budgetOk }), record: async (r) => costs.push(r) },
    settings: { get: async () => store.settings ?? { enabled: true, observeOnly: false } },
    runEphemeral: async (args) => {
      runs.push(args);
      seenPrompts.push(args.context[0].text);
      await args.deps.reportCost({ taskClass: args.taskClass, model: { providerID: "p", modelID: "m" }, tokens: 1000 });
      if (store.fail) return store.fail;
      return { text: typeof store.answer === "function" ? store.answer(args) : store.answer, model: { providerID: "p", modelID: "m" } };
    },
    scanner: store.scanner ?? scanner,
    readSince: async ({ after }) => store.messages.filter((m) => !after || m.at > after.at || (m.at === after.at && m.id > after.id)),
    isUserAuthored: (id) => userAuthored.includes(id),
    getSession: async () => session,
    isCtoSession: async (id) => id === "ses_cto",
    ...over,
  });
  return { cap, state, queue, marked, runs, costs, store, mapped, seenPrompts, advance: (ms) => (t += ms), setBudget: (v) => (budgetOk = v) };
}
const ev = (type, sessionID = "ses_1", extra = {}) => ({ type, data: { sessionID, ...extra } });
const four = () => [
  msg("msg_u1", "user", 1, "we always run npm test before pushing"),
  msg("msg_a1", "assistant", 2, "Running tests", [tool("npm test")]),
  msg("msg_u2", "user", 3, "no, use pnpm not npm"),
  msg("msg_a2", "assistant", 4, "ok pnpm"),
  msg("msg_u3", "user", 5, "also never touch the lockfile"),
  msg("msg_u4", "user", 6, "thanks"),
];
const ANSWER = JSON.stringify({ notes: [{ kind: "preference", text: "Use pnpm, never npm.", refs: ["m3"] }, { kind: "howto", text: "Run the tests with pnpm test.", refs: ["m2", "m1"] }] });

test("extractJson reads bare JSON, fenced JSON and rejects prose", () => {
  assert.deepEqual(extractJson('{"notes":[]}'), { notes: [] });
  assert.deepEqual(extractJson('Sure!\n```json\n{"notes":[1]}\n```'), { notes: [1] });
  assert.deepEqual(extractJson("here {\"a\":1} bye"), { a: 1 });
  assert.equal(extractJson("no json"), null);
});

test("trigger: idle for 10 minutes after ≥3 new user messages captures; earlier than that does not", async () => {
  const r = await rig({ messages: four(), answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.cap.observeRaw(ev("session.execution.succeeded"));
  r.advance(9 * MIN);
  assert.deepEqual((await r.cap.tick()).captured, 0);
  assert.equal(r.runs.length, 0);
  r.advance(2 * MIN);
  const out = await r.cap.tick();
  assert.equal(out.captured, 1);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].taskClass, "knowledge-capture");
  assert.deepEqual(r.marked, ["ses_1"]);
  const notes = await r.queue.list(SLUG);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => n.origin === "capture" && n.sessionID === "ses_1"));
  // a second tick does not capture again until new activity arrives
  r.advance(30 * MIN);
  assert.equal((await r.cap.tick()).checked, 0);
});

test("fewer than 3 new user messages: nothing is captured and no model call is made; the cursor keeps counting", async () => {
  const messages = four().slice(0, 3); // 2 user messages
  const r = await rig({ messages, answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.tick()).captured, 0);
  assert.equal(r.runs.length, 0);
  // more user messages arrive; now it qualifies
  r.store.messages = four();
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.tick()).captured, 1);
});

test("only messages after the capture cursor are read next time", async () => {
  const r = await rig({ messages: four(), answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  await r.cap.tick();
  r.store.messages = [...four(), msg("msg_u5", "user", 7, "one more thing"), msg("msg_u6", "user", 8, "and another")];
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  const out = await r.cap.tick();
  assert.equal(out.captured, 0); // only 2 new user messages since the cursor
  assert.equal(r.runs.length, 1);
});

test("compaction start captures at once with ≥ 1 new user message", async () => {
  const r = await rig({ messages: four().slice(0, 1), answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.cap.observeRaw(ev("session.compaction.started"));
  for (let i = 0; i < 200 && (r.marked.length === 0); i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.runs.length, 1);
  assert.equal((await r.queue.list(SLUG)).length >= 1, true);
});

test("exclusions: unmapped, CTO conversation, internal marker, routine, curator and knowledge:-titled sessions are never captured", async () => {
  const cases = [
    ["ses_unmapped", { title: "x" }],
    ["ses_cto", { title: "x" }],
    ["ses_1", { title: "x", metadata: { manta: { internal: true } } }],
    ["ses_1", { title: "x", metadata: { manta: { routineId: "r1" } } }],
    ["ses_1", { title: "x", metadata: { manta: { knowledgeTrial: "t1" } } }],
    ["ses_1", { title: "knowledge:curator-notes" }],
    ["ses_1", { title: "cto:digest-compose" }],
  ];
  for (const [id, session] of cases) {
    const r = await rig({ messages: four(), answer: ANSWER, session });
    r.mapped.ses_cto = { slug: SLUG };
    r.mapped.ses_unmapped = undefined;
    r.cap.observeRaw(ev("session.execution.started", id));
    r.advance(11 * MIN);
    await r.cap.tick();
    assert.equal(r.runs.length, 0, JSON.stringify([id, session]));
    assert.equal((await r.queue.list(SLUG)).length, 0);
  }
});

test("off when the master switch is off; still runs in observeOnly; stops at the daily cap", async () => {
  const off = await rig({ messages: four(), answer: ANSWER });
  off.store.settings = { enabled: false };
  off.cap.observeRaw(ev("session.execution.started"));
  off.advance(11 * MIN);
  await off.cap.tick();
  assert.equal(off.runs.length, 0);

  const obs = await rig({ messages: four(), answer: ANSWER });
  obs.store.settings = { enabled: true, observeOnly: true };
  obs.cap.observeRaw(ev("session.execution.started"));
  obs.advance(11 * MIN);
  assert.equal((await obs.cap.tick()).captured, 1);

  const capped = await rig({ messages: four(), answer: ANSWER });
  capped.setBudget(false);
  capped.cap.observeRaw(ev("session.execution.started"));
  capped.advance(11 * MIN);
  assert.equal((await capped.cap.tick()).captured, 0);
  assert.equal(capped.runs.length, 0);
  // the work stays pending and runs once the budget is back
  capped.setBudget(true);
  assert.equal((await capped.cap.tick()).captured, 1);
});

test("the early gate is asked for capture's work type; a runner refusal (code budget) is a budget skip, not a failure: no backoff, the next tick retries", async () => {
  const asked = [];
  const r = await rig({ messages: four(), answer: ANSWER, over: { budget: { canSpend: async (a) => (asked.push(a), { ok: true }), record: async () => {} } } });
  r.store.fail = { ok: false, code: "budget", reason: "window-busy" };
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  const t = await r.cap.tick();
  assert.equal(t.captured, 0);
  assert.deepEqual(asked, [{ workType: "knowledge-capture" }]);
  assert.equal(r.runs.length, 1);
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "budget");
  // no 30-minute backoff: with the budget back the very next tick captures
  r.store.fail = null;
  assert.equal((await r.cap.tick()).captured, 1);
});

test("a runner failure (no qualifying model) keeps the session pending and backs off 30 minutes", async () => {
  const r = await rig({ messages: four(), answer: ANSWER });
  r.store.fail = { ok: false, code: "no-qualifying-model" };
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.tick()).captured, 0);
  assert.equal(r.runs.length, 1);
  r.advance(5 * MIN);
  await r.cap.tick();
  assert.equal(r.runs.length, 1); // backoff
  assert.equal(r.marked.length, 0);
  r.store.fail = null;
  r.advance(30 * MIN);
  assert.equal((await r.cap.tick()).captured, 1);
});

test("cost is reported through the runner's reportCost into the budget, tagged with the project", async () => {
  const r = await rig({ messages: four(), answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  await r.cap.tick();
  assert.equal(r.costs.length, 1);
  assert.equal(r.costs[0].slug, SLUG);
  assert.equal(r.costs[0].taskClass, "knowledge-capture");
  assert.deepEqual(r.costs[0].tokens, { input: 900, output: 100 });
  const c = [];
  const rc = makeReportCost({ record: async (x) => c.push(x) }, "s1");
  await rc({ taskClass: "k", tokens: { input: 5, output: 2, reasoning: 3, cacheRead: 7, cacheWrite: 1 } });
  assert.deepEqual(c[0].tokens, { input: 5, output: 2, reasoning: 3, cacheRead: 7, cacheWrite: 1 }); // real usage as given
  await rc({ taskClass: "k", usd: 0.25, tokens: { input: 5 } });
  assert.equal(c[1].usd, 0.25);
  assert.equal(c[1].tokens, undefined);
  await rc({ taskClass: "k", tokens: 100 }); // a bare total is split 90/10
  assert.deepEqual(c[2].tokens, { input: 90, output: 10 });
  assert.equal(c[2].slug, "s1");
});

test("restart resumes: dirty sessions are reloaded from state.sqlite", async () => {
  const state = await memState();
  const root = await tmpDir("knowledge-capture-");
  let t = 5_000_000;
  const common = (over = {}) => ({
    state,
    queue: createQueue({ state, scanner, root, now: () => t }),
    now: () => t,
    log: () => {},
    sessionMap: { get: () => ({ slug: SLUG }), markCaptured() {} },
    budget: { canSpend: async () => ({ ok: true }), record: async () => {} },
    settings: { get: async () => ({ enabled: true }) },
    runEphemeral: async () => ({ text: ANSWER }),
    readSince: async () => four(),
    scanner,
    isUserAuthored: () => true,
    getSession: async () => ({}),
    ...over,
  });
  const a = createCapture(common());
  a.observeRaw(ev("session.execution.started"));
  a.observeRaw(ev("session.execution.succeeded"));
  const b = createCapture(common()); // a "restarted" engine with empty memory
  t += 11 * MIN;
  assert.equal((await b.tick()).captured, 1);
});

test("buildCaptureInput: ≤24k chars, user messages whole first, nearest assistant text next, aliases only for what the model sees", () => {
  const big = "x".repeat(900);
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push(msg(`msg_u${i}`, "user", i * 2, `user ${i} ${big}`));
    messages.push(msg(`msg_a${i}`, "assistant", i * 2 + 1, `assistant ${i} ${"y".repeat(1100)}`, [tool(`cmd ${i}`, "out".repeat(300))]));
  }
  const { text, aliases, userMessages } = buildCaptureInput(messages, { sessionID: "ses_1" });
  assert.ok(text.length <= MAX_INPUT_CHARS);
  assert.equal(userMessages, 20);
  assert.ok(text.includes("[m1] USER:") && text.includes("[m39] USER:"));
  assert.equal(aliases.get("m1").ref, "msg:ses_1/msg_u0");
  // a message that did not fit is not citable
  assert.ok(aliases.size < 40); // the assistant text that did not fit is not citable
  for (const a of aliases.keys()) assert.ok(text.includes(`[${a}]`) || text.includes(`[${a.split(".")[0]}]`), a);
});

test("buildCaptureInput: when user messages alone overflow, the newest are kept and the oldest dropped", () => {
  const messages = Array.from({ length: 6 }, (_, i) => msg(`msg_u${i}`, "user", i, `${i}${"z".repeat(7000)}`));
  const { text, aliases } = buildCaptureInput(messages, { sessionID: "ses_1" });
  assert.ok(text.length <= MAX_INPUT_CHARS);
  assert.ok(text.includes("[m6]") && !text.includes("[m1]"));
  assert.equal(aliases.has("m1"), false);
});

test("parseCaptureNotes: ≤5 notes, validated refs only, derived unless every ref is a user-authored user message", async () => {
  const messages = four();
  const { aliases } = buildCaptureInput(messages, { sessionID: "ses_1" });
  const isUserAuthored = (id) => id === "msg_u2" || id === "msg_u3";
  const answer = JSON.stringify({
    notes: [
      { kind: "preference", text: "Use pnpm.", refs: ["m3"] }, // user-authored user msg → not derived
      { kind: "howto", text: "Run tests with pnpm test", refs: ["m3", "m2"] }, // m2 is assistant → derived
      { kind: "gotcha", text: "Fake ref only", refs: ["m99"] }, // dropped: ref not in input
      { kind: "gotcha", text: "Mixed", refs: ["m99", "msg:ses_1/msg_u3"] }, // full ref accepted, bad dropped
      { kind: "nonsense", text: "bad kind", refs: ["m3"] },
      { kind: "decision", text: "No refs", refs: [] },
      { kind: "status", text: "Not user authored", refs: ["m1"] }, // msg_u1 has no user origin → derived
      { kind: "status", text: "a", refs: ["m3"] },
      { kind: "status", text: "b", refs: ["m3"] },
      { kind: "status", text: "c", refs: ["m3"] },
    ],
  });
  const out = await parseCaptureNotes(answer, aliases, { sessionID: "ses_1", isUserAuthored });
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((n) => n.derived), [false, true, false, true, false]);
  assert.deepEqual(out[2].refs, ["msg:ses_1/msg_u3"]);
  assert.ok(out.every((n) => n.refs.every((r) => /^msg:ses_1\/msg_/.test(r))));
  assert.deepEqual(await parseCaptureNotes("not json", aliases, {}), []);
});

test("notes are redacted and deduplicated by the queue; derived flag reaches the queue file", async () => {
  const answer = JSON.stringify({ notes: [{ kind: "howto", text: "Token is SECRETVALUE keep it", refs: ["m2"] }, { kind: "howto", text: "Token is  SECRETVALUE keep it", refs: ["m2"] }] });
  const r = await rig({ messages: four(), answer });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  await r.cap.tick();
  const notes = await r.queue.list(SLUG);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /\[REDACTED\]/);
  assert.equal(notes[0].derived, true); // m2 = assistant message
});

test("createCaptureMessageSource maps the box transcript shape and honours the cursor", async () => {
  const timeline = [
    { info: { id: "msg_a", role: "user", time: { created: 1 } }, parts: [{ id: "msg_a:text:0", type: "text", text: "hi" }] },
    { info: { id: "msg_b", role: "assistant", time: { created: 2 } }, parts: [{ type: "reasoning", text: "x" }, { id: "msg_b:text:0", type: "text", text: "yo" }, { id: "t1", type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "a b" } }, { type: "text", text: "syn", synthetic: true }] },
    { info: { id: "msg_c", role: "user", time: { created: 3 } }, parts: [{ type: "text", text: "next" }] },
  ];
  const limits = [];
  const read = createCaptureMessageSource({ listMessages: async (_id, opts) => (limits.push(opts?.limit), timeline) });
  const all = await read({ sessionID: "s" });
  assert.deepEqual(all.map((m) => [m.id, m.role, m.at, m.parts.length]), [["msg_a", "user", 1, 1], ["msg_b", "assistant", 2, 2], ["msg_c", "user", 3, 1]]);
  assert.equal(all[1].parts[1].command, "ls");
  assert.deepEqual((await read({ sessionID: "s", after: { at: 2, id: "msg_b" } })).map((m) => m.id), ["msg_c"]);
  assert.equal((await read({ sessionID: "s", limit: 1 })).length, 1);
  assert.deepEqual(limits, [400, 400, 1]); // the transcript read is bounded
});

const STORE_SECRET = "sk-live-0123456789abcdef";
test("R3-B3: the transcript is redacted before the runner sees it (a secrets-store value never reaches the model)", async () => {
  const messages = four();
  messages[0] = msg("msg_u1", "user", 1, `we always deploy with ${STORE_SECRET} as the token`);
  const r = await rig({ messages, answer: ANSWER, over: { scanner: { redact: async (t) => ({ text: t.split(STORE_SECRET).join("[REDACTED]"), redacted: 1, unavailable: false }) } } });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.tick()).captured, 1);
  assert.equal(r.runs.length, 1);
  assert.ok(!r.seenPrompts[0].includes(STORE_SECRET));
  assert.match(r.seenPrompts[0], /\[REDACTED\] as the token/);
});

test("R3-B3: scanner unavailable (or throwing) → no model call, skipped:'scanner', the session stays pending", async () => {
  for (const sc of [{ redact: async () => ({ text: "", redacted: 0, unavailable: true }) }, { redact: async () => { throw new Error("boom"); } }]) {
    const r = await rig({ messages: four(), answer: ANSWER, over: { scanner: sc } });
    r.cap.observeRaw(ev("session.execution.started"));
    r.advance(11 * MIN);
    const out = await r.cap.captureSession("ses_1", { reason: "idle" });
    assert.equal(out.skipped, "scanner");
    assert.equal(r.runs.length, 0);
    assert.equal(r.marked.length, 0);
  }
});

test("R3-S2: a failing session lookup skips this tick (fail closed) and keeps the session pending; it is retried", async () => {
  let broken = true;
  const r = await rig({ messages: four(), answer: ANSWER, over: { getSession: async () => { if (broken) throw new Error("opencode down"); return { title: "x" }; } } });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "lookup-failed");
  assert.equal(r.runs.length, 0);
  assert.ok(r.cap._tracked("ses_1"));
  broken = false;
  assert.equal((await r.cap.tick()).captured, 1);
  // isCtoSession failing is the same
  const r2 = await rig({ messages: four(), answer: ANSWER, over: { isCtoSession: async () => { throw new Error("x"); } } });
  r2.cap.observeRaw(ev("session.execution.started"));
  r2.advance(11 * MIN);
  assert.equal((await r2.cap.captureSession("ses_1")).skipped, "lookup-failed");
  assert.equal(r2.runs.length, 0);
});
