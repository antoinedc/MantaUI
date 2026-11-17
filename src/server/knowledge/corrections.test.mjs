import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_SIZE, MAX_MESSAGES_PER_RUN, WINDOW_MS, createCorrectionDetector, createUserMessageReader, isoWeek, jaccard, lessonTokens } from "./corrections.mjs";
import { memState } from "./testHelpers.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "../fixtures/opencodeV2DbFixture.mjs";
import { _setOffloadMode, _shutdownOffload, runDbTask } from "../dbOffload.mjs";

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 17, 12); // Tue 2026-11-17

/** A classifier fake driven by a text → {label, lesson} table; clustering answers from `clusterAnswer`. */
function fakeRunner(table, { clusterAnswer } = {}) {
  const calls = [];
  const fn = async (args) => {
    const prompt = args.context[0].text;
    calls.push(prompt);
    await args.deps.reportCost?.({ taskClass: args.taskClass, model: { providerID: "p", modelID: "small" }, tokens: 100 });
    if (fn.fail) return fn.fail;
    if (prompt.includes("NEW LESSONS:")) {
      return { text: JSON.stringify({ assignments: clusterAnswer ? clusterAnswer(prompt) : [] }), model: { providerID: "p", modelID: "small" } };
    }
    const results = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map(([, i, text]) => {
      const hit = Object.entries(table).find(([k]) => text.includes(k));
      return { i: Number(i), label: hit ? hit[1].label : "other", lesson: hit ? hit[1].lesson : "" };
    });
    return { text: `\`\`\`json\n${JSON.stringify({ results })}\n\`\`\``, model: fn.model ?? { providerID: "p", modelID: "small" } };
  };
  fn.calls = calls;
  return fn;
}

async function rig({ messages = [], table = {}, authored, mapped = (id) => ({ slug: "alpha-0123456789" }), over = {}, clusterAnswer } = {}) {
  const state = await memState();
  let t = T0;
  const costs = [];
  let budgetOk = true;
  const runEphemeral = fakeRunner(table, { clusterAnswer });
  const det = createCorrectionDetector({
    state,
    now: () => t,
    log: () => {},
    sessionMap: { get: (sid) => mapped(sid) },
    budget: { canSpend: async () => ({ ok: budgetOk }), record: async (r) => costs.push(r) },
    settings: { get: async () => ({ enabled: true }) },
    runEphemeral,
    readUserMessages: async ({ skip, limit }) => messages.filter((m) => !skip(m.id)).slice(0, limit),
    isUserAuthored: (id) => (authored ? authored.has(id) : true),
    ...over,
  });
  return { det, state, runEphemeral, costs, advance: (ms) => (t += ms), setBudget: (v) => (budgetOk = v), set: (m) => messages.splice(0, messages.length, ...m) };
}
let n = 0;
const um = (text, sid, ageDays = 1, extra = {}) => ({ id: `msg_${++n}`, sessionID: sid, at: T0 - ageDays * DAY, text, afterAssistant: true, ...extra });
const PNPM = { label: "correction", lesson: "Use pnpm, never npm." };

test("isoWeek and word-overlap helpers", () => {
  assert.equal(isoWeek(Date.UTC(2026, 10, 17, 12)), "2026-W47");
  assert.equal(isoWeek(Date.UTC(2026, 0, 1, 12)), "2026-W01");
  assert.equal(isoWeek(Date.UTC(2025, 11, 29, 12)), "2026-W01");
  assert.ok(jaccard(lessonTokens("Use pnpm, never npm."), lessonTokens("Always use pnpm and never npm")) >= 0.6);
  assert.ok(jaccard(lessonTokens("Use pnpm"), lessonTokens("Write tests first")) < 0.2);
});

test("classifies batches of 40, once: a second weekly pass makes no model call for the same messages", async () => {
  const msgs = Array.from({ length: 95 }, (_, i) => um(`message ${i}`, `ses_${i % 7}`, 2));
  const r = await rig({ messages: msgs });
  await r.det.runWeekly();
  assert.equal(r.runEphemeral.calls.length, 3); // 40 + 40 + 15
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, 95);
  r.advance(7 * DAY);
  await r.det.runWeekly();
  assert.equal(r.runEphemeral.calls.length, 3); // nothing new → no calls
  assert.equal(BATCH_SIZE, 40);
});

test("a correction cluster appears at ≥ 2 sessions; one session with 2 corrections is not enough; 3 corrections is", async () => {
  const a = um("no, use pnpm not npm", "ses_a", 3);
  const b = um("I said pnpm!", "ses_a", 2);
  const r = await rig({ messages: [a, b], table: { pnpm: PNPM } });
  assert.deepEqual(await r.det.runWeekly(), []); // 2 corrections, 1 session
  const c = um("pnpm please, not npm", "ses_a", 1);
  r.set([a, b, c]);
  let out = await r.det.runWeekly();
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
  assert.equal(out[0].sessions, 1);

  const r2 = await rig({ messages: [um("use pnpm", "ses_a", 3), um("use pnpm", "ses_b", 2)], table: { pnpm: PNPM } });
  out = await r2.det.runWeekly();
  assert.equal(out.length, 1);
  assert.equal(out[0].sessions, 2);
  assert.equal(out[0].kind, "correction");
  assert.equal(out[0].slug, "alpha-0123456789");
  assert.match(out[0].clusterId, /^cl_[0-9a-f]{12}$/);
  assert.equal(out[0].lesson, "Use pnpm, never npm.");
  assert.equal(out[0].evidence.length, 2);
  assert.deepEqual(out[0].evidence.map((e) => e.sessionID).sort(), ["ses_a", "ses_b"]);
  assert.match(out[0].evidence[0].ref, /^msg:ses_[ab]\/msg_\d+$/);
  assert.equal(out[0].evidence[0].quote, "use pnpm");
});

test("evidence is restricted to user-authored messages; pre-upgrade / non-user messages never count", async () => {
  const x = um("use pnpm", "ses_a", 3);
  const y = um("use pnpm", "ses_b", 2);
  const z = um("use pnpm", "ses_c", 1);
  const r = await rig({ messages: [x, y, z], table: { pnpm: PNPM }, authored: new Set([x.id, y.id]) });
  const out = await r.det.runWeekly();
  assert.equal(out.length, 1);
  assert.equal(out[0].sessions, 2);
  assert.ok(out[0].evidence.every((e) => !e.ref.endsWith(z.id)));
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg WHERE message_id = ?").get(z.id).n, 0);
});

test("messages with no preceding assistant turn, unmapped sessions, and messages older than 14 days are not classified", async () => {
  const msgs = [um("use pnpm", "ses_a", 1, { afterAssistant: false }), um("use pnpm", "ses_gone", 1), um("use pnpm", "ses_a", 15), um("use pnpm", "ses_a", 1)];
  const r = await rig({ messages: msgs, table: { pnpm: PNPM }, mapped: (sid) => (sid === "ses_gone" ? null : { slug: "alpha-0123456789" }) });
  await r.det.runWeekly();
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, 1);
  assert.ok(WINDOW_MS === 14 * DAY);
});

test("bounded to 2,000 messages per run; the next run continues with the rest", async () => {
  const msgs = Array.from({ length: 2_100 }, (_, i) => um(`message ${i}`, `ses_${i % 11}`, 1 + (i % 5)));
  const r = await rig({ messages: msgs });
  await r.det.runWeekly();
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, MAX_MESSAGES_PER_RUN);
  await r.det.runWeekly();
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, 2_100);
});

test("cluster ids are stable across weeks and a reworded lesson joins the existing cluster", async () => {
  const r = await rig({ messages: [um("use pnpm", "ses_a", 3), um("use pnpm", "ses_b", 2)], table: { pnpm: PNPM, yarn: { label: "correction", lesson: "Always use pnpm and never npm." } } });
  const first = await r.det.runWeekly();
  r.advance(7 * DAY);
  r.set([um("yarn is wrong", "ses_c", 1)]);
  const second = await r.det.runWeekly();
  assert.equal(second.length, 1);
  assert.equal(second[0].clusterId, first[0].clusterId);
  assert.equal(second[0].count, 3);
  assert.equal(second[0].sessions, 3);
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_cluster").get().n, 1);
});

test("model-assisted clustering merges differently worded lessons; unknown answers fall back to new clusters", async () => {
  const t = { alpha: { label: "correction", lesson: "Run the linter before committing." }, beta: { label: "preference", lesson: "Keep commits small and focused." } };
  const msgs = [um("alpha 1", "ses_a", 3), um("beta 1", "ses_b", 2)];
  const merged = await rig({
    messages: msgs,
    table: t,
    clusterAnswer: () => [{ i: 1, cluster: null, same_as: null }, { i: 2, cluster: null, same_as: 1 }],
  });
  await merged.det.runWeekly();
  assert.equal(merged.state.db.prepare("SELECT COUNT(DISTINCT cluster_id) AS n FROM corr_msg").get().n, 1);

  const separate = await rig({ messages: [um("alpha 1", "ses_a", 3), um("beta 1", "ses_b", 2)], table: t });
  await separate.det.runWeekly();
  assert.equal(separate.state.db.prepare("SELECT COUNT(DISTINCT cluster_id) AS n FROM corr_msg").get().n, 2);
});

test("recurrenceSince counts new corrections in a cluster after a timestamp", async () => {
  const r = await rig({ messages: [um("use pnpm", "ses_a", 5), um("use pnpm", "ses_b", 4), um("use pnpm", "ses_c", 1)], table: { pnpm: PNPM } });
  const [c] = await r.det.runWeekly();
  assert.equal(await r.det.recurrenceSince(c.clusterId, T0 - 3 * DAY), 1);
  assert.equal(await r.det.recurrenceSince(c.clusterId, T0 - 10 * DAY), 3);
  assert.equal(await r.det.recurrenceSince(c.clusterId, T0), 0);
  assert.equal(await r.det.recurrenceSince("cl_unknown", 0), 0);
});

test("weeklyStats reports user messages, corrections and the classifier model per week; a model change shows up", async () => {
  const a = um("use pnpm", "ses_a", 1);
  const b = um("thanks", "ses_a", 1);
  const r = await rig({ messages: [a, b], table: { pnpm: PNPM } });
  await r.det.runWeekly();
  const w = isoWeek(T0 - DAY);
  assert.deepEqual(r.det.weeklyStats(w), { week: w, userMessages: 2, corrections: 1, classifierModels: ["p/small"] });
  r.runEphemeral.model = { providerID: "p", modelID: "big" };
  r.set([um("again pnpm", "ses_b", 1)]);
  await r.det.runWeekly();
  assert.deepEqual(r.det.weeklyStats(w).classifierModels, ["p/big", "p/small"]);
  assert.equal(r.det.weeklyStats(T0 - DAY).userMessages, 3);
});

test("budget cap and a missing capable model stop the pass without losing or mis-classifying anything", async () => {
  const msgs = [um("use pnpm", "ses_a", 1), um("use pnpm", "ses_b", 1)];
  const r = await rig({ messages: msgs, table: { pnpm: PNPM } });
  r.setBudget(false);
  await r.det.runWeekly();
  assert.equal(r.runEphemeral.calls.length, 0);
  assert.equal(r.det.shouldRun(T0), true);
  r.setBudget(true);
  r.runEphemeral.fail = { ok: false, code: "no-qualifying-model" };
  await r.det.runWeekly();
  assert.equal(r.runEphemeral.calls.length, 1);
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, 0);
  assert.equal(r.det.shouldRun(T0), true);
  r.runEphemeral.fail = null;
  await r.det.runWeekly();
  assert.equal(r.state.db.prepare("SELECT COUNT(*) AS n FROM corr_msg").get().n, 2);
  assert.equal(r.det.shouldRun(T0), false);
  assert.equal(r.det.shouldRun(T0 + 8 * DAY), true);
});

test("cost is recorded per call through reportCost; the master switch off means no work", async () => {
  const r = await rig({ messages: [um("use pnpm", "ses_a", 1)], table: { pnpm: PNPM } });
  await r.det.runWeekly();
  assert.ok(r.costs.length >= 1);
  assert.equal(r.costs[0].taskClass, "knowledge-corrections");
  const off = await rig({ messages: [um("use pnpm", "ses_a", 1)], over: { settings: { get: async () => ({ enabled: false }) } } });
  assert.deepEqual(await off.det.runWeekly(), []);
  assert.equal(off.runEphemeral.calls.length, 0);
});

test("lessons and quotes are redacted before they are stored", async () => {
  const r = await rig({
    messages: [um("use pnpm token SECRETVALUE", "ses_a", 1)],
    table: { pnpm: { label: "correction", lesson: "Use pnpm with SECRETVALUE" } },
    over: { scanner: { redact: async (t) => ({ text: t.replace(/SECRETVALUE/g, "[REDACTED]"), unavailable: false }) } },
  });
  await r.det.runWeekly();
  const row = r.state.db.prepare("SELECT lesson, excerpt FROM corr_msg").get();
  assert.equal(row.lesson, "Use pnpm with [REDACTED]");
  assert.equal(row.excerpt, "use pnpm token [REDACTED]");
});

test("default reader: user-authored messages from prompt_origin in mapped sessions, text from opencode.db via the db task (off-thread path)", async (t) => {
  if (!(await sqliteAvailable())) return t.skip("no node:sqlite");
  const fixture = await createFixtureDb({
    sessions: [{ id: "ses_a" }, { id: "ses_b" }],
    messages: [
      { id: "msg_a1", sessionId: "ses_a", timeCreated: 100, data: { role: "assistant" } },
      { id: "msg_u1", sessionId: "ses_a", timeCreated: 200, data: { role: "user" } },
      { id: "msg_u0", sessionId: "ses_a", timeCreated: 50, data: { role: "user" } }, // first message: no assistant before it
      { id: "msg_u2", sessionId: "ses_b", timeCreated: 300, data: { role: "user" } },
      { id: "msg_u3", sessionId: "ses_a", timeCreated: 400, data: { role: "user" } }, // not user-authored
    ],
    parts: [
      { id: "p_a1", messageId: "msg_a1", sessionId: "ses_a", timeCreated: 100, data: { type: "text", text: "assistant says" } },
      { id: "p_u1", messageId: "msg_u1", sessionId: "ses_a", timeCreated: 200, data: { type: "text", text: "no, use pnpm" } },
      { id: "p_u0", messageId: "msg_u0", sessionId: "ses_a", timeCreated: 50, data: { type: "text", text: "first prompt" } },
      { id: "p_u2", messageId: "msg_u2", sessionId: "ses_b", timeCreated: 300, data: { type: "text", text: "other session" } },
      { id: "p_u3", messageId: "msg_u3", sessionId: "ses_a", timeCreated: 400, data: { type: "text", text: "from a webhook" } },
    ],
  });
  const state = await memState();
  state.db.exec("CREATE TABLE prompt_origin (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, origin TEXT NOT NULL, at INTEGER NOT NULL)");
  const ins = state.db.prepare("INSERT INTO prompt_origin VALUES (?, ?, ?, ?)");
  for (const [id, sid, origin] of [["msg_u0", "ses_a", "user"], ["msg_u1", "ses_a", "user"], ["msg_u2", "ses_b", "user"], ["msg_u3", "ses_a", "webhook"]]) ins.run(id, sid, origin, 1000);
  const sp = state.db.prepare("INSERT INTO session_project (session_id, slug, canonical_id, source, pinned_at) VALUES (?, 'alpha-0123456789', 'x', 'prompt', 0)");
  sp.run("ses_a");
  // ses_b is not mapped → its message is never read
  _setOffloadMode("inline");
  try {
    await withFixtureDb(fixture, async () => {
      const read = createUserMessageReader({ state, runDbTask, log: () => {} });
      const rows = await read({ sinceMs: 0, limit: 100 });
      assert.deepEqual(rows.map((r) => [r.id, r.text, r.afterAssistant]).sort(), [["msg_u0", "first prompt", false], ["msg_u1", "no, use pnpm", true]]);
      assert.deepEqual((await read({ sinceMs: 0, limit: 100, skip: (id) => id === "msg_u1" })).map((r) => r.id), ["msg_u0"]);
    });
  } finally {
    _setOffloadMode("worker");
    await _shutdownOffload();
    fixture.close();
  }
});

test("default reader degrades to [] without a prompt_origin table", async () => {
  const state = await memState();
  const read = createUserMessageReader({ state, runDbTask: async () => assert.fail("must not read"), log: () => {} });
  assert.deepEqual(await read({ sinceMs: 0 }), []);
});
