import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BACKLOG_WINDOWS_PER_DAY, MAX_INPUT_CHARS, SUMMARY_CLIP, buildCaptureInput, createCapture, createCaptureMessageSource, dropDeliveredPreamble, extractJson, makeReportCost, parseCaptureNotes, planCatchup, splitWindows } from "./capture.mjs";
import { applyPreamble } from "../handoff/engine.mjs";
import { createQueue } from "./queue.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const SLUG = "alpha-0123456789";
const MIN = 60_000;
const scanner = { redact: async (t) => ({ text: t.replace(/SECRETVALUE/g, "[REDACTED]"), redacted: /SECRETVALUE/.test(t) ? 1 : 0, unavailable: false }) };

const msg = (id, role, at, text, extra = []) => ({ id, role, at, parts: [...(text ? [{ id: `${id}:text:0`, type: "text", text }] : []), ...extra] });
const tool = (command, output = "ok") => ({ id: "x", type: "tool", tool: "bash", command, output });

async function rig({ messages = [], session = { title: "fix the build" }, userAuthored = ["msg_u1", "msg_u2", "msg_u3", "msg_u4"], answer, over = {} } = {}) {
  const state = over.state ?? (await memState());
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

// ---- catching up on a long span (spec 2026-11-17-background-budget-followups §5) ----------------------------

const DAY = 24 * 60 * MIN;
const big = (n) => "w".repeat(n);
/** `n` user/assistant pairs, each message `size` chars, oldest first, at 1..2n. */
const longSpan = (n, size = 2_000, tag = "") =>
  Array.from({ length: n }, (_, i) => [msg(`msg_${tag}u${String(i).padStart(3, "0")}`, "user", i * 2 + 1, `user ${tag}${i} ${big(size)}`), msg(`msg_${tag}a${String(i).padStart(3, "0")}`, "assistant", i * 2 + 2, `answer ${tag}${i} ${big(size)}`)]).flat();
const cursorOf = (r, id = "ses_1") => {
  const row = r.state.db.prepare("SELECT * FROM capture_session WHERE session_id = ?").get(id);
  return row;
};
/** A capture the budget refuses while content waits — the only way a session enters catch-up. */
async function holdBack(r, id = "ses_1", setOk = (v) => r.setBudget(v)) {
  r.cap.observeRaw(ev("session.execution.started", id));
  r.advance(11 * MIN);
  setOk(false);
  const out = await r.cap.captureSession(id);
  setOk(true);
  assert.equal(out.skipped, "budget");
  assert.ok(cursorOf(r, id).backlog_since > 0, `${id} is in catch-up`);
}
const forward = (store) => async ({ sessionID, after }) => (store.bySession?.[sessionID] ?? store.messages).filter((m) => !after || m.at > after.at || (m.at === after.at && m.id > after.id));

test("createCaptureMessageSource: with a bookmark and a forward reader it reads the OLDEST max after it when asked to read forward; otherwise it keeps the newest-N path", async () => {
  const calls = [];
  const timeline = [
    { info: { id: "msg_c", role: "assistant", time: { created: 9 }, summary: true }, parts: [{ id: "x", type: "text", text: "the summary" }] },
    { info: { id: "msg_d", role: "assistant", time: { created: 10 } }, parts: [{ id: "t", type: "tool", tool: "bash", state: { status: "error", input: { command: "make" }, error: "boom", metadata: { exit: 2 } } }] },
  ];
  const read = createCaptureMessageSource({
    listMessages: async () => [],
    listMessagesSince: async (sid, opts) => (calls.push([sid, opts]), { messages: timeline, hasMore: true, olderNotRead: false }),
  });
  const out = await read({ sessionID: "s", after: { at: 5, id: "msg_a" }, limit: 2000, forward: true });
  assert.deepEqual(calls, [["s", { after: { at: 5, id: "msg_a" }, max: 2000 }]]);
  assert.equal(out.hasMore, true);
  assert.equal(out.messages[0].summary, true, "a completed compaction keeps its flag");
  assert.deepEqual([out.messages[1].parts[0].output, out.messages[1].parts[0].exit, out.messages[1].parts[0].status], ["boom", 2, "error"]);
  const legacy = await read({ sessionID: "s", after: null, limit: 400 });
  assert.ok(Array.isArray(legacy));
  assert.equal(calls.length, 1, "no bookmark: the forward reader is not used");
  const ordinary = await read({ sessionID: "s", after: { at: 5, id: "msg_a" }, limit: 400 });
  assert.ok(Array.isArray(ordinary));
  assert.equal(calls.length, 1, "not in catch-up (forward not asked for): the newest-N path even with a bookmark");
});

test("buildCaptureInput: a summary message is one block with its own larger clip and a summary role; note parts render as DID lines; a cite overrides the ref", () => {
  const summary = { id: "msg_s", role: "summary", at: 1, cite: { sessionID: "ses_succ", messageID: "msg_sent" }, parts: [{ type: "text", text: "S".repeat(5_000) }], srcIndex: 0 };
  const m2 = msg("msg_a1", "assistant", 2, "", [{ type: "note", text: "read 3 files in src" }]);
  const { text, aliases } = buildCaptureInput([summary, m2], { sessionID: "ses_1" });
  assert.match(text, /\[m1\] SUMMARY OF EARLIER WORK:\nS{5000}/);
  assert.match(text, /\[m2\] DID: read 3 files in src/);
  assert.deepEqual(aliases.get("m1"), { ref: "msg:ses_succ/msg_sent", kind: "msg", messageID: "msg_sent", role: "summary" });
  assert.equal(aliases.get("m2").ref, "msg:ses_1/msg_a1");
  assert.ok(SUMMARY_CLIP >= 8_000);
});

test("dropDeliveredPreamble: send skips the carrying message, armed strips the prefix (user's text stays), draft skips an exact match only", () => {
  const preamble = "## Goal\nship it";
  const own = msg("msg_u2", "user", 3, "my own question");
  const sent = msg("msg_sent", "user", 1, preamble);
  assert.deepEqual(dropDeliveredPreamble([sent, own], { text: preamble, disposition: "send", messageId: "msg_sent" }).map((m) => m.id), ["msg_u2"]);

  // the armed text is built by the engine itself: this pins the separator
  const armedText = applyPreamble("prompt", { text: "and now do X" }, preamble).text;
  const armed = msg("msg_arm", "user", 1, armedText);
  const out = dropDeliveredPreamble([armed, own], { text: preamble, disposition: "armed" });
  assert.equal(out[0].parts[0].text, "and now do X");
  assert.equal(out[1].parts[0].text, "my own question");
  const onlyPreamble = dropDeliveredPreamble([msg("msg_arm", "user", 1, `${preamble}\n\n---\n\n`)], { text: preamble, disposition: "armed" });
  assert.deepEqual(onlyPreamble[0].parts, [], "nothing of the user's own is left");

  const drafted = dropDeliveredPreamble([msg("msg_d", "user", 1, preamble), msg("msg_e", "user", 2, `${preamble} (edited)`)], { text: preamble, disposition: "draft" });
  assert.deepEqual(drafted.map((m) => m.id), ["msg_e"]);
  assert.deepEqual(dropDeliveredPreamble([own], null), [own]);
  assert.deepEqual(dropDeliveredPreamble([own], { text: "  ", disposition: "send", messageId: "msg_u2" }), [own]);
});

test("splitWindows: consecutive windows within the limit; one over-long message gets its own", () => {
  const ms = [msg("a", "user", 1, big(9_000)), msg("b", "user", 2, big(9_000)), msg("c", "user", 3, big(9_000)), msg("d", "user", 4, big(1_000))];
  const w = splitWindows(ms, 20_000);
  assert.deepEqual(w.map((g) => g.map((m) => m.id)), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(splitWindows([msg("x", "user", 1, big(30_000))], 20_000).map((g) => g.length), [1]);
  assert.deepEqual(splitWindows([]), []);
});

test("planCatchup: a span that fits raw is one raw window and summary messages are skipped", () => {
  const span = [msg("u1", "user", 1, "hi"), { ...msg("c1", "assistant", 2, "old summary text"), summary: true }, msg("u2", "user", 3, "there")];
  const plan = planCatchup(span, { sessionID: "ses_1" });
  assert.equal(plan.windows.length, 1);
  assert.deepEqual(plan.windows[0].messages.map((m) => m.id), ["u1", "u2"]);
  assert.deepEqual(plan.windows[0].advanceTo, { at: 3, id: "u2" });
  assert.deepEqual([plan.backlog, plan.condensed, plan.summary], [false, false, null]);
});

test("planCatchup: when only the condensed span fits, condensed is used and summaries are still skipped", () => {
  const reads = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, type: "tool", tool: "read", command: `/repo/src/f${i}.mjs`, output: big(1_000), status: "completed" }));
  const span = [msg("u1", "user", 1, "look around"), msg("a1", "assistant", 2, "", reads), msg("a2", "assistant", 3, "found it"), { ...msg("c1", "assistant", 4, "compaction summary"), summary: true }];
  const plan = planCatchup(span, { sessionID: "ses_1", predecessors: [{ createdAt: 3, text: "handoff text", successorId: "ses_2", disposition: "send", messageId: "msg_x" }], bookmark: { at: 0, id: "" } });
  assert.equal(plan.windows.length, 1);
  assert.deepEqual([plan.condensed, plan.summary, plan.backlog], [true, null, false]);
  assert.ok(plan.windows[0].messages.some((m) => m.parts.some((p) => p.type === "note" && /read 120 files/.test(p.text))));
  assert.equal(plan.windows[0].messages.some((m) => m.role === "summary"), false);
  assert.deepEqual(plan.windows[0].advanceTo, { at: 4, id: "c1" }, "the whole span is consumed, summary message included");
});

test("planCatchup: a handoff summary replaces the span up to its request time; the bookmark advances to the last replaced message; send cites the successor's message", () => {
  const span = longSpan(20, 2_500); // far more than one window; message times 1..40
  const plan = planCatchup(span, { sessionID: "ses_1", bookmark: { at: 0, id: "" }, predecessors: [{ recordId: "h1", createdAt: 30, text: "HANDOFF: what we did", successorId: "ses_next", disposition: "send", messageId: "msg_sent01" }] });
  assert.equal(plan.summary, "handoff");
  const first = plan.windows[0].messages[0];
  assert.deepEqual([first.role, first.cite, first.srcIndex], ["summary", { sessionID: "ses_next", messageID: "msg_sent01" }, 29]);
  assert.ok(plan.windows.flatMap((w) => w.messages).every((m) => m === first || m.srcIndex > 29), "everything before the request is replaced");
  assert.equal(plan.windows.at(-1).advanceTo.at, 40);
  // not a send: the predecessor's own last message at or before the request is cited
  const draft = planCatchup(span, { sessionID: "ses_1", bookmark: { at: 0, id: "" }, predecessors: [{ createdAt: 30, text: "HANDOFF", successorId: "ses_next", disposition: "draft" }] });
  assert.deepEqual(draft.windows[0].messages[0].cite, { sessionID: "ses_1", messageID: span[29].id });
});

test("planCatchup: a compaction summary replaces the raw span before it (the newest one); windows advance oldest first", () => {
  const span = [...longSpan(6, 2_500, "x"), { ...msg("msg_comp", "assistant", 50, "SUMMARY of 12 messages"), summary: true }, ...longSpan(12, 2_500, "y").map((m) => ({ ...m, at: m.at + 100 }))];
  const plan = planCatchup(span, { sessionID: "ses_1", bookmark: { at: 0, id: "" } });
  assert.equal(plan.summary, "compaction");
  const first = plan.windows[0].messages[0];
  assert.deepEqual([first.role, first.cite, first.parts[0].text], ["summary", { sessionID: "ses_1", messageID: "msg_comp" }, "SUMMARY of 12 messages"]);
  assert.ok(plan.backlog && plan.windows.length > 1);
  // each non-final window advances to just before the next one; the last to the end of the span
  const ids = span.map((m) => m.id);
  plan.windows.forEach((w, k) => {
    if (k === plan.windows.length - 1) return assert.equal(w.advanceTo.id, ids.at(-1));
    const nextFirst = plan.windows[k + 1].messages[0];
    assert.equal(w.advanceTo.id, ids[nextFirst.srcIndex - 1]);
  });
  assert.ok(plan.windows[0].advanceTo.id >= "msg_comp" || plan.windows[0].advanceTo.id === "msg_comp");
});

test("planCatchup: a span with more messages behind it (hasMore) is always backlog", () => {
  const p = planCatchup(longSpan(3, 100), { sessionID: "ses_1", hasMore: true });
  assert.equal(p.backlog, true);
});

test("catch-up: a long span is captured window by window, oldest first, the bookmark advancing per window; the last one clears the backlog", async () => {
  const messages = longSpan(30, 2_500); // ≈ 300k chars → many windows
  const r = await rig({ messages, answer: JSON.stringify({ notes: [] }), userAuthored: [] });
  await holdBack(r);
  const first = await r.cap.captureSession("ses_1");
  assert.equal(first.captured, true);
  assert.equal(first.backlog, true);
  let row = cursorOf(r);
  assert.ok(row.backlog_since > 0);
  assert.equal(row.backlog_windows, 1);
  assert.match(r.seenPrompts[0], /user 0 /);
  assert.doesNotMatch(r.seenPrompts[0], /user 29 /);
  const afterFirst = row.cursor_at;
  assert.ok(afterFirst > 0 && afterFirst < 60);

  let guard = 0;
  while (cursorOf(r).backlog_since != null && guard++ < 20) {
    r.cap.observeRaw(ev("session.execution.started")); // new activity is not needed: the bookmark does the work
    const out = await r.cap.captureSession("ses_1", { reason: "idle", backlogStep: true });
    assert.equal(out.captured, true, JSON.stringify(out));
  }
  row = cursorOf(r);
  assert.equal(row.backlog_since, null);
  assert.equal(row.cursor_at, 60, "the bookmark reached the end of the span");
  // windows were read oldest first and none repeated a message
  const idxs = r.seenPrompts.map((p) => Number(/user (\d+) /.exec(p)[1]));
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
  assert.equal(new Set(idxs).size, idxs.length);
  assert.ok(r.runs.length >= 4 && r.runs.length <= MAX_BACKLOG_WINDOWS_PER_DAY);
  assert.match(r.seenPrompts[0], /condensed/i);
});

test("catch-up: the user-message gate is judged once on the whole span; a window with no user message of its own still runs once in backlog", async () => {
  // 3 user messages at the very start, then a tail of assistant messages whose failed commands survive condensing
  const failing = (n) => Array.from({ length: 10 }, (_, k) => ({ id: `t${n}_${k}`, type: "tool", tool: "bash", command: `make step-${n}-${k} ${big(300)}`, output: `error ${big(150)}`, status: "error" }));
  const messages = [
    msg("msg_u1", "user", 1, "we use pnpm"),
    msg("msg_u2", "user", 2, "never npm"),
    msg("msg_u3", "user", 3, "run tests first"),
    ...Array.from({ length: 12 }, (_, n) => msg(`msg_a${String(n).padStart(2, "0")}`, "assistant", 10 + n, "", failing(n))),
  ];
  const r = await rig({ messages, answer: JSON.stringify({ notes: [] }) });
  await holdBack(r);
  assert.equal((await r.cap.captureSession("ses_1")).captured, true, "the gate was passed when the session was held back");
  assert.match(r.seenPrompts[0], /USER:/);
  const out = await r.cap.captureSession("ses_1", { reason: "idle", backlogStep: true });
  assert.equal(out.captured, true, "the next window has no user message at all and still runs");
  assert.doesNotMatch(r.seenPrompts[1], /USER:/);
});

test("catch-up: a session below the gate is NOT caught up (too-few-messages), whatever the span's size", async () => {
  const messages = [msg("msg_u1", "user", 1, "one"), ...Array.from({ length: 40 }, (_, i) => msg(`msg_a${String(i).padStart(2, "0")}`, "assistant", 10 + i, big(1_100)))];
  const r = await rig({ messages, answer: JSON.stringify({ notes: [] }) });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "too-few-messages");
  assert.equal(r.runs.length, 0);
  assert.equal(cursorOf(r)?.backlog_since ?? null, null);
});

test("catch-up resumes after a refusal or failure: what was captured is kept, the next try starts at the bookmark", async () => {
  const messages = longSpan(30, 2_500);
  const r = await rig({ messages, answer: JSON.stringify({ notes: [] }) });
  await holdBack(r);
  await r.cap.captureSession("ses_1");
  const bookmark = cursorOf(r).cursor_at;
  r.setBudget(false);
  assert.equal((await r.cap.captureSession("ses_1", { backlogStep: true })).skipped, "budget-backlog");
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "budget", "an ordinary capture keeps the plain budget code");
  r.setBudget(true);
  r.store.fail = { ok: false, code: "no-qualifying-model" };
  assert.equal((await r.cap.captureSession("ses_1", { backlogStep: true })).captured, false);
  assert.equal(cursorOf(r).cursor_at, bookmark, "a failed window moves nothing");
  r.store.fail = null;
  r.advance(31 * MIN); // past the backoff
  assert.equal((await r.cap.captureSession("ses_1", { backlogStep: true })).captured, true);
  assert.ok(cursorOf(r).cursor_at > bookmark);
});

test("catch-up: at most 8 windows per session per local day; the rest waits for tomorrow", async () => {
  const messages = longSpan(120, 2_500); // far more than 8 windows
  const r = await rig({ messages, answer: JSON.stringify({ notes: [] }) });
  await holdBack(r);
  await r.cap.captureSession("ses_1");
  for (let i = 1; i < MAX_BACKLOG_WINDOWS_PER_DAY; i++) assert.equal((await r.cap.captureSession("ses_1", { backlogStep: true })).captured, true, `window ${i + 1}`);
  assert.equal(cursorOf(r).backlog_windows, MAX_BACKLOG_WINDOWS_PER_DAY);
  assert.equal((await r.cap.captureSession("ses_1", { backlogStep: true })).skipped, "backlog-daily-cap");
  assert.equal(r.runs.length, MAX_BACKLOG_WINDOWS_PER_DAY);
  r.advance(DAY);
  const next = await r.cap.captureSession("ses_1", { backlogStep: true });
  assert.equal(next.captured, true);
  assert.equal(cursorOf(r).backlog_windows, 1, "a new day counts from one");
});

test("catch-up: a handoff summary is used only when the span doesn't fit; citations point at the delivered message and notes are derived", async () => {
  const messages = longSpan(20, 2_500); // times 1..40
  const handoff = { asPredecessor: [{ recordId: "h1", createdAt: 30, text: "HANDOFF SUMMARY: pnpm only", successorId: "ses_next", disposition: "send", messageId: "msg_sent01" }], asSuccessor: null };
  const answer = JSON.stringify({ notes: [{ kind: "howto", text: "Use pnpm only.", refs: ["m1"] }] });
  const r = await rig({ messages, answer, userAuthored: ["msg_u000"], over: { summariesFor: () => handoff } });
  await holdBack(r);
  assert.equal((await r.cap.captureSession("ses_1")).captured, true);
  assert.match(r.seenPrompts[0], /\[m1\] SUMMARY OF EARLIER WORK:\nHANDOFF SUMMARY: pnpm only/);
  assert.doesNotMatch(r.seenPrompts[0], /user 0 /, "the replaced span is not read raw");
  const [n] = await r.queue.list(SLUG);
  assert.deepEqual(n.refs, ["msg:ses_next/msg_sent01"]);
  assert.equal(n.derived, true, "a summary is never user-authored evidence");
  assert.ok(cursorOf(r).cursor_at >= 30, "the bookmark moved past the replaced span");

  // a span that fits one input ignores the summary entirely
  const small = await rig({ messages: four(), answer: ANSWER, over: { summariesFor: () => handoff } });
  small.cap.observeRaw(ev("session.execution.started"));
  small.advance(11 * MIN);
  await small.cap.captureSession("ses_1");
  assert.doesNotMatch(small.seenPrompts[0], /SUMMARY OF EARLIER WORK/);
});

test("catch-up: a compaction summary replaces the raw span before it; a failing summariesFor changes nothing but the summaries", async () => {
  const messages = [...longSpan(10, 2_500, "x"), { ...msg("msg_comp", "assistant", 50, "COMPACTED: we built the importer"), summary: true }, ...longSpan(3, 200, "y").map((m) => ({ ...m, at: m.at + 100 }))];
  const r = await rig({ messages, answer: JSON.stringify({ notes: [{ kind: "status", text: "Importer built.", refs: ["m1"] }] }), over: { summariesFor: () => { throw new Error("down"); } } });
  await holdBack(r);
  assert.equal((await r.cap.captureSession("ses_1")).captured, true);
  assert.match(r.seenPrompts[0], /COMPACTED: we built the importer/);
  assert.doesNotMatch(r.seenPrompts[0], /user x0 /);
  const [n] = await r.queue.list(SLUG);
  assert.deepEqual(n.refs, ["msg:ses_1/msg_comp"]);
  assert.equal(n.derived, true);
});

test("catch-up: the delivered preamble is never read as the user's own words (send, armed and draft successors)", async () => {
  const preamble = "## Goal\nSECRETPLAN ship the importer";
  const mk = (disposition, firstText, id = "msg_first") => [
    msg(id, "user", 1, firstText),
    msg("msg_u2", "user", 3, "we always use pnpm"),
    msg("msg_u3", "user", 4, "never touch the lockfile"),
    msg("msg_u4", "user", 5, "run the tests before pushing"),
  ];
  const cases = [
    ["send", mk("send", preamble, "msg_sent01"), { text: preamble, disposition: "send", messageId: "msg_sent01" }],
    ["armed", mk("armed", applyPreamble("prompt", { text: "keep going" }, preamble).text), { text: preamble, disposition: "armed" }],
    ["draft", mk("draft", preamble), { text: preamble, disposition: "draft" }],
  ];
  for (const [name, messages, asSuccessor] of cases) {
    const r = await rig({ messages, answer: ANSWER, over: { summariesFor: () => ({ asPredecessor: [], asSuccessor }) } });
    r.cap.observeRaw(ev("session.execution.started"));
    r.advance(11 * MIN);
    assert.equal((await r.cap.captureSession("ses_1")).captured, true, name);
    assert.doesNotMatch(r.seenPrompts[0], /SECRETPLAN/, name);
    if (name === "armed") assert.match(r.seenPrompts[0], /keep going/);
  }
});

test("a delivered preamble does not count toward the user-message gate", async () => {
  const preamble = "## Goal\nx";
  const messages = [msg("msg_sent01", "user", 1, preamble), msg("msg_u2", "user", 2, "one"), msg("msg_u3", "user", 3, "two")];
  const r = await rig({ messages, answer: ANSWER, over: { summariesFor: () => ({ asPredecessor: [], asSuccessor: { text: preamble, disposition: "send", messageId: "msg_sent01" } }) } });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "too-few-messages");
});

test("tick: ordinary due captures run first, then ONE backlog window of the most recently active session, idle or not", async () => {
  const bySession = { ses_1: longSpan(30, 2_500, "a"), ses_2: longSpan(30, 2_500, "b"), ses_3: four() };
  const r = await rig({ messages: [], answer: JSON.stringify({ notes: [] }), over: { readSince: forward({ bySession }) } });
  r.mapped.ses_2 = { slug: SLUG };
  r.mapped.ses_3 = { slug: SLUG };
  // two sessions are held back by the budget (ses_1 first, ses_2 later), then each runs one window
  for (const id of ["ses_1", "ses_2"]) {
    await holdBack(r, id);
    await r.cap.captureSession(id);
    r.advance(MIN);
  }
  const base = r.runs.length;
  // new activity on ses_3 (ordinary, idle for 10 minutes) and on ses_1 (recent, not idle)
  r.cap.observeRaw(ev("session.execution.started", "ses_3"));
  r.advance(11 * MIN);
  r.cap.observeRaw(ev("session.execution.started", "ses_1")); // most recently active, only just now
  const out = await r.cap.tick();
  assert.equal(r.runs.length, base + 2, "one ordinary capture (ses_3) + exactly one backlog window");
  assert.equal(out.captured, 2);
  assert.match(r.seenPrompts[base], /we always run npm test/, "the ordinary capture ran first (ses_3's four messages)");
  assert.ok(cursorOf(r, "ses_1").backlog_windows === 2 && cursorOf(r, "ses_2").backlog_windows === 1, "ses_1 (the most recently active) got the backlog window");
});

test("tick: a backlog budget refusal ends only the backlog pass; the next tick's ordinary captures still run first", async () => {
  const bySession = { ses_1: longSpan(30, 2_500, "a"), ses_3: four() };
  let spendOk = true;
  const r = await rig({
    messages: [],
    answer: JSON.stringify({ notes: [] }),
    over: { readSince: forward({ bySession }), budget: { canSpend: async () => ({ ok: spendOk }), record: async () => {} } },
  });
  r.mapped.ses_3 = { slug: SLUG };
  await holdBack(r, "ses_1", (v) => (spendOk = v));
  await r.cap.captureSession("ses_1");
  spendOk = false;
  const t1 = await r.cap.tick();
  assert.equal(t1.captured, 0);
  assert.equal(r.runs.length, 1);
  spendOk = true;
  // an ordinary capture is due and the budget is back: it is not blocked by the earlier backlog refusal
  r.cap.observeRaw(ev("session.execution.started", "ses_3"));
  r.advance(11 * MIN);
  const t2 = await r.cap.tick();
  assert.equal(t2.captured, 2, "ordinary ses_3 and then one backlog window");
});

test("tick: an ordinary budget refusal still stops the whole tick (no backlog window is even asked about)", async () => {
  const bySession = { ses_1: longSpan(30, 2_500, "a"), ses_3: four() };
  let spendOk = true;
  let asked = 0;
  const r = await rig({ messages: [], answer: JSON.stringify({ notes: [] }), over: { readSince: forward({ bySession }), budget: { canSpend: async () => (asked++, { ok: spendOk }), record: async () => {} } } });
  r.mapped.ses_3 = { slug: SLUG };
  await holdBack(r, "ses_1", (v) => (spendOk = v));
  await r.cap.captureSession("ses_1");
  r.cap.observeRaw(ev("session.execution.started", "ses_3"));
  r.advance(11 * MIN);
  spendOk = false;
  asked = 0;
  const out = await r.cap.tick();
  assert.equal(out.captured, 0);
  assert.equal(r.runs.length, 1);
  assert.equal(asked, 1, "the ordinary capture was refused and nothing else was tried");
});

test("capture-2 migration: a capture table from before the catch-up gains the backlog columns with its rows intact", async () => {
  const state = await memState();
  state.migrate("capture-1", `CREATE TABLE IF NOT EXISTS capture_session (
      session_id TEXT PRIMARY KEY, last_event_at INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0,
      cursor_at INTEGER NOT NULL DEFAULT 0, cursor_id TEXT NOT NULL DEFAULT '', captured_at INTEGER, notes INTEGER NOT NULL DEFAULT 0);`);
  state.db.prepare("INSERT INTO capture_session (session_id, last_event_at, dirty, cursor_at, cursor_id, notes) VALUES ('ses_old', 5, 1, 7, 'msg_7', 2)").run();
  const mk = () => rig({ over: { state } });
  await mk();
  await mk(); // the second engine on the same state: the migration is applied once
  const row = state.db.prepare("SELECT * FROM capture_session WHERE session_id = 'ses_old'").get();
  assert.deepEqual({ ...row }, { session_id: "ses_old", last_event_at: 5, dirty: 1, cursor_at: 7, cursor_id: "msg_7", captured_at: null, notes: 2, backlog_since: null, backlog_day: null, backlog_windows: 0 });
});

// ---- who gets caught up (only sessions the budget held back) ---------------------------------------------

test("an ordinary capture the budget never refused keeps the single-input behaviour: one call, newest content trimmed to one input, no catch-up state", async () => {
  const messages = longSpan(30, 2_500);
  const r = await rig({ messages, answer: ANSWER });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  const out = await r.cap.captureSession("ses_1");
  assert.deepEqual([out.captured, out.backlog], [true, undefined]);
  assert.equal(r.runs.length, 1);
  assert.ok(r.seenPrompts[0].length < MAX_INPUT_CHARS + 4_000, "one input");
  assert.doesNotMatch(r.seenPrompts[0], /condensed|SUMMARY OF EARLIER WORK|DID:/);
  assert.match(r.seenPrompts[0], /user 29 /, "user messages first, the newest win");
  const row = cursorOf(r);
  assert.deepEqual([row.backlog_since, row.backlog_windows, row.cursor_at], [null, 0, 60], "the bookmark moved to the end; nothing waits");
  // …also with a bookmark, and compaction-triggered
  r.store.messages = [...messages, ...longSpan(30, 2_500, "n").map((m) => ({ ...m, at: m.at + 100 }))];
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.captureSession("ses_1")).captured, true);
  assert.equal(r.runs.length, 2);
  assert.equal(cursorOf(r).backlog_since, null);
});

test("a capture the budget refused while content waited marks the session for catch-up (idle or runner refusal); too little content or nothing waiting does not", async () => {
  // the early gate refuses
  const a = await rig({ messages: four(), answer: ANSWER });
  await holdBack(a);
  // the runner refuses after the span was read
  const b = await rig({ messages: four(), answer: ANSWER });
  b.cap.observeRaw(ev("session.execution.started"));
  b.advance(11 * MIN);
  b.store.fail = { ok: false, code: "budget", reason: "window-busy" };
  assert.equal((await b.cap.captureSession("ses_1")).skipped, "budget");
  assert.ok(cursorOf(b).backlog_since > 0);
  // refused with fewer user messages than the gate needs: nothing to catch up, no mark, no repeated retries
  const c = await rig({ messages: four().slice(0, 3), answer: ANSWER });
  c.cap.observeRaw(ev("session.execution.started"));
  c.advance(11 * MIN);
  c.setBudget(false);
  assert.equal((await c.cap.captureSession("ses_1")).skipped, "budget");
  assert.equal(cursorOf(c)?.backlog_since ?? null, null);
  assert.equal(c.cap._tracked("ses_1").dirty, false);
  // a refusal for a session with no activity waiting
  const d = await rig({ messages: four(), answer: ANSWER });
  d.cap.observeRaw(ev("session.execution.started"));
  d.advance(11 * MIN);
  await d.cap.captureSession("ses_1");
  d.setBudget(false);
  assert.equal((await d.cap.captureSession("ses_1", { backlogStep: true })).skipped, "budget-backlog");
  assert.equal(cursorOf(d).backlog_since ?? null, null, "a backlog-pass call for a session that is not behind marks nothing");
});

test("once caught up (the last window done) a held-back session is ordinary again", async () => {
  const r = await rig({ messages: longSpan(20, 2_500), answer: JSON.stringify({ notes: [] }) });
  await holdBack(r);
  let guard = 0;
  while (cursorOf(r).backlog_since != null && guard++ < 10) await r.cap.captureSession("ses_1", { backlogStep: true });
  assert.equal(cursorOf(r).backlog_since, null);
  const before = r.runs.length;
  r.store.messages = [...r.store.messages, ...four().map((m, i) => ({ ...m, id: `${m.id}z`, at: 1_000 + i }))];
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  const out = await r.cap.captureSession("ses_1");
  assert.deepEqual([out.captured, out.backlog, r.runs.length], [true, undefined, before + 1]);
  assert.doesNotMatch(r.seenPrompts.at(-1), /condensed/);
});

test("tick: a failed backlog run is the tick's one model attempt — the next backlog session is not tried", async () => {
  const bySession = { ses_1: longSpan(30, 2_500, "a"), ses_2: longSpan(30, 2_500, "b") };
  const r = await rig({ messages: [], answer: JSON.stringify({ notes: [] }), over: { readSince: forward({ bySession }) } });
  r.mapped.ses_2 = { slug: SLUG };
  await holdBack(r, "ses_1");
  await holdBack(r, "ses_2");
  r.cap._tracked("ses_1").dirty = false;
  r.cap._tracked("ses_2").dirty = false;
  r.store.fail = { ok: false, code: "no-qualifying-model" };
  const out = await r.cap.tick();
  assert.equal(r.runs.length, 1, "exactly one runner call");
  assert.equal(out.captured, 0);
  // before a model call the loop does move on: a session that is not mapped any more is skipped for the next one
  r.store.fail = null;
  r.advance(31 * MIN);
  r.mapped.ses_2 = undefined;
  r.mapped.ses_1 = undefined;
  await r.cap.tick();
  assert.equal(r.runs.length, 1, "unmapped sessions are dropped without a call");
});

test("tick: a backlog session that cannot run before a model call (in backoff) does not use up the tick's attempt", async () => {
  const bySession = { ses_1: longSpan(30, 2_500, "a"), ses_2: longSpan(30, 2_500, "b") };
  const r = await rig({ messages: [], answer: JSON.stringify({ notes: [] }), over: { readSince: forward({ bySession }) } });
  r.mapped.ses_2 = { slug: SLUG };
  await holdBack(r, "ses_2");
  await holdBack(r, "ses_1"); // the most recently active
  r.cap._tracked("ses_1").dirty = false; // only the backlog pass is in play
  r.cap._tracked("ses_2").dirty = false;
  r.store.fail = { ok: false, code: "no-qualifying-model" };
  await r.cap.tick(); // ses_1 fails and backs off for 30 minutes
  assert.equal(r.runs.length, 1);
  r.store.fail = null;
  r.advance(MIN);
  const out = await r.cap.tick();
  assert.equal(r.runs.length, 2, "ses_1 is in backoff (no model call), so ses_2 gets the attempt");
  assert.equal(out.captured, 1);
  assert.equal(cursorOf(r, "ses_2").backlog_windows, 1);
});

test("the scanner is checked BEFORE a backlog session's long span is read", async () => {
  const reads = [];
  const down = { redact: async () => ({ text: "", redacted: 0, unavailable: true }) };
  const r = await rig({ messages: [], answer: ANSWER, over: { readSince: async (a) => (reads.push(a), longSpan(30, 2_500)) } });
  await holdBack(r);
  const readsAfterMark = reads.length;
  // swap the scanner: the engine reads `deps.scanner` at construction, so build a second engine on the same state
  const r2 = await rig({ messages: [], answer: ANSWER, over: { state: r.state, scanner: down, readSince: async (a) => (reads.push(a), longSpan(30, 2_500)) } });
  const out = await r2.cap.captureSession("ses_1", { backlogStep: true });
  assert.equal(out.skipped, "scanner");
  assert.equal(reads.length, readsAfterMark, "nothing was read");
  assert.equal(r2.runs.length, 0);
});

test("a bookmark never moves backwards", async () => {
  const r = await rig({ messages: four(), answer: ANSWER });
  r.state.db.prepare("INSERT INTO capture_session (session_id, last_event_at, dirty, cursor_at, cursor_id) VALUES ('ses_1', 1, 1, 50, 'msg_zzz')").run();
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  // a reader that returns messages older than the stored bookmark
  const stale = await rig({ messages: four(), answer: ANSWER, over: { state: r.state, readSince: async () => four() } });
  const out = await stale.cap.captureSession("ses_1");
  assert.equal(out.captured, true);
  const row = cursorOf(r);
  assert.deepEqual([row.cursor_at, row.cursor_id], [50, "msg_zzz"]);
});

test("a session that used its 8 windows waits for midnight for new activity too (no retry every minute); tomorrow it goes on", async () => {
  const r = await rig({ messages: longSpan(120, 2_500), answer: JSON.stringify({ notes: [] }) });
  await holdBack(r);
  await r.cap.captureSession("ses_1");
  for (let i = 1; i < MAX_BACKLOG_WINDOWS_PER_DAY; i++) await r.cap.captureSession("ses_1", { backlogStep: true });
  r.cap.observeRaw(ev("session.execution.started"));
  r.advance(11 * MIN);
  assert.equal((await r.cap.captureSession("ses_1")).skipped, "backlog-daily-cap");
  const runs = r.runs.length;
  r.advance(30 * MIN);
  await r.cap.tick();
  assert.equal(r.runs.length, runs, "the tick does not retry before midnight");
  r.advance(DAY);
  await r.cap.tick();
  assert.equal(r.runs.length, runs + 1);
});
