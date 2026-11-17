// Unit tests for the small adapters in wiring.mjs, readers.mjs and integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthedGit, forgeBasicAuth } from "./wiring.mjs";
import { createIsManagedSession, createKnowledgeRunner, forwardListMessages, knowledgeConfigDir, knowledgePaths } from "./integration.mjs";
import { createCaptureMessageSource } from "./capture.mjs";
import { curatorRig } from "./curatorRig.mjs";
import { fakeBackgroundBudget } from "./testHelpers.mjs";
import { readFile } from "node:fs/promises";
import { createShellCommandReader, createSkillLoadReader, createToolCallReader, createTrialResultReader, createUserRequestLister, createSingleMessageReader } from "./readers.mjs";

const tool = (command, name = "bash") => ({ type: "tool", tool: name, state: { input: { command }, output: "ok" } });
const m = (id, role, text, parts = []) => ({ info: { id, role, time: { created: 1 } }, parts: [{ type: "text", text }, ...parts] });

test("authed git: network commands carry the credential in the ENVIRONMENT (never argv); others and unknown hosts pass through", async () => {
  const seen = [];
  const git = { run: async (args, o) => (seen.push({ args, env: o?.env, cwd: o?.cwd }), args[0] === "remote" ? "https://github.com/acme/widget.git\n" : "") };
  const authed = createAuthedGit(git, async (host) => (host === "github.com" ? { token: "tok-SECRET" } : null));
  await authed.run(["clone", "--quiet", "--", "https://github.com/acme/widget.git", "/x"], {});
  await authed.run(["fetch", "--prune", "origin"], { cwd: "/x", env: { LC_ALL: "C" } });
  await authed.run(["status"], { cwd: "/x" });
  await authed.run(["clone", "https://gitlab.example.com/a/b.git", "/y"], {});
  const value = `Authorization: Basic ${forgeBasicAuth("github.com", "tok-SECRET")}`;
  const net = seen.filter((c) => c.env?.GIT_CONFIG_COUNT);
  assert.equal(net.length, 2);
  for (const c of net) {
    assert.deepEqual([c.env.GIT_CONFIG_COUNT, c.env.GIT_CONFIG_KEY_0, c.env.GIT_CONFIG_VALUE_0], ["1", "http.extraheader", value]);
  }
  assert.equal(net[1].env.LC_ALL, "C"); // the caller's own env survives
  assert.equal(net[1].cwd, "/x");
  // the token (raw or its base64 header) is on no argv, and no `-c` option is used
  const tok = forgeBasicAuth("github.com", "tok-SECRET");
  for (const c of seen) assert.ok(!c.args.some((a) => a === "-c" || a.includes("tok-SECRET") || a.includes(tok)), c.args.join(" "));
  assert.ok(seen.some((c) => c.args[0] === "status" && !c.env));
  assert.ok(seen.some((c) => c.args[0] === "clone" && c.args[1] === "https://gitlab.example.com/a/b.git" && !c.env), "no credential for an unknown host");
  assert.equal(Buffer.from(forgeBasicAuth("gitlab.com", "t"), "base64").toString(), "oauth2:t");
  assert.equal(Buffer.from(forgeBasicAuth("github.com", "t"), "base64").toString(), "x-access-token:t");
});

test("authed git: an existing GIT_CONFIG_COUNT is extended, not clobbered", async () => {
  let env;
  const authed = createAuthedGit({ run: async (_a, o) => (env = o.env, "") }, async () => "tok");
  await authed.run(["fetch", "https://github.com/a/b.git"], { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x.y", GIT_CONFIG_VALUE_0: "z" } });
  assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1], ["2", "x.y", "http.extraheader"]);
});

test("authed git: the real git runner passes the env config through to git (credential reaches the process)", async (t) => {
  const { createGitRunner } = await import("./gitRunner.mjs");
  try {
    await import("simple-git");
  } catch {
    return t.skip("simple-git isn't installed here");
  }
  const authed = createAuthedGit(createGitRunner({ defaultCwd: process.cwd() }), async () => "tok-ENV");
  const out = await authed.run(["ls-remote", "https://github.com/a/b.git"], { env: { GIT_CONFIG_NOSYSTEM: "1" } }).catch((e) => String(e.stderr ?? e.message));
  assert.ok(!/unsafe|not allowed|allowUnsafe/i.test(out), out); // simple-git's env guard didn't refuse the GIT_CONFIG_* names
});

test("the runner wrapper merges its own collaborators under the caller's deps", async () => {
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: { runEphemeralSession: 1 }, configGet: () => 2, backgroundBudget: fakeBackgroundBudget() });
  const validate = () => true;
  await run({ taskClass: "curator-notes", deps: { reportCost: async () => {}, validate } });
  assert.deepEqual(Object.keys(got.deps).sort(), ["configGet", "oc", "preflight", "reportCost", "validate"]);
  await run({ taskClass: "x" });
  assert.deepEqual(Object.keys(got.deps).sort(), ["configGet", "oc", "preflight", "reportCost"]); // the budget hooks are always there
  await run({ taskClass: "x", deps: { configGet: "mine" } });
  assert.equal(got.deps.configGet, "mine");
});

test("runner wrapper: the preflight asks the shared budget with the work type and the model the runner resolved; a caller cannot replace it", async () => {
  const bb = fakeBackgroundBudget();
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: {}, configGet: () => ({}), backgroundBudget: bb });
  await run({ taskClass: "knowledge-capture", deps: { preflight: async () => ({ ok: true }) } });
  const model = { providerID: "p", modelID: "m" };
  assert.deepEqual(await got.deps.preflight({ taskClass: "knowledge-capture", tier: "nano", model }), { ok: true });
  assert.deepEqual(bb.calls.check, [{ workType: "knowledge-capture", model }], "the caller's own preflight did not win");
  // a null model (the box default) goes through as null; a refusal carries its reason
  bb.refuse = "window-busy";
  assert.deepEqual(await got.deps.preflight({ taskClass: "knowledge-capture", tier: "nano", model: null }), { ok: false, reason: "window-busy" });
  assert.equal(bb.calls.check[1].model, null);
  // `workType` is the budget's work type for a call that runs as another task class (the weekly tidy-up) and is not forwarded
  await run({ taskClass: "curator-rules", workType: "knowledge-tidy" });
  assert.ok(!("workType" in got));
  bb.refuse = null;
  await got.deps.preflight({ model });
  assert.equal(bb.calls.check.at(-1).workType, "knowledge-tidy");
});

test("runner wrapper: without a shared budget every run is refused (fail closed)", async () => {
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: {}, configGet: () => ({}) });
  await run({ taskClass: "knowledge-capture" });
  assert.deepEqual(await got.deps.preflight({ model: null }), { ok: false, reason: "unavailable" });
  await got.deps.reportCost({ taskClass: "knowledge-capture", tokens: 10 }); // and a cost report with nothing to book on does not throw
});

test("runner wrapper: real usage is booked on the shared budget (inLedger:false), an estimate is booked as its estimate, then the caller's own hook runs", async () => {
  const bb = fakeBackgroundBudget();
  const order = [];
  const real = bb.record;
  bb.record = async (a) => (order.push("shared"), real(a));
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: {}, configGet: () => ({}), backgroundBudget: bb });
  const model = { providerID: "p", modelID: "m" };
  const seen = [];
  await run({ taskClass: "curator-rules", workType: "knowledge-tidy", deps: { reportCost: async (c) => (order.push("caller"), seen.push(c)) } });
  const usage = { input: 100, output: 20, reasoning: 0, cacheRead: 5, cacheWrite: 1 };
  await got.deps.reportCost({ taskClass: "curator-rules", tier: "deep", model, tokens: 999, estimated: false, usage, usd: 0.01 });
  assert.deepEqual(order, ["shared", "caller"]);
  assert.deepEqual(bb.calls.record[0], { workType: "knowledge-tidy", model, usage, usd: 0.01, inLedger: false });
  assert.deepEqual(seen[0].tokens, usage, "the caller prices per component from the usage object");
  await got.deps.reportCost({ taskClass: "curator-rules", tier: "deep", model, tokens: 1234, estimated: true });
  assert.deepEqual(bb.calls.record[1], { workType: "knowledge-tidy", model, usage: 1234, inLedger: false }, "no real usage: the size estimate is what gets booked");
  assert.equal(seen[1].tokens, 1234);
});

test("config paths: OPENCODE_CONFIG_DIR wins, else ~/.config/opencode; AGENTS.md and skills live in it", () => {
  assert.equal(knowledgeConfigDir({ env: { OPENCODE_CONFIG_DIR: "/c" }, home: "/h" }), "/c");
  assert.equal(knowledgeConfigDir({ env: { OPENCODE_CONFIG_DIR: "  " }, home: "/h" }), "/h/.config/opencode");
  assert.deepEqual(knowledgePaths({ env: {}, home: "/h" }), { globalAgentsPath: "/h/.config/opencode/AGENTS.md", skillsDir: "/h/.config/opencode/skills" });
});

test("transcript readers over opencode's message list", async () => {
  const all = [m("msg_1", "user", "run it"), m("msg_2", "assistant", "doing", [tool("npm run build"), tool("ls", "read")]), m("msg_3", "assistant", "STEP 1: VALID - ok", [])];
  all[2].info.cost = 0.02;
  all[2].info.tokens = { input: 10, output: 5, cache: { read: 1, write: 2 } };
  all[2].info.providerID = "p";
  all[2].info.modelID = "mm";
  const listMessages = async (sid) => (sid === "ses_ok" ? all : sid === "ses_bad" ? Promise.reject(new Error("boom")) : []);
  assert.deepEqual(await createShellCommandReader({ listMessages })("ses_ok"), ["npm run build"]);
  assert.equal(await createShellCommandReader({ listMessages })("ses_bad"), null, "an unreadable session proves nothing");
  assert.deepEqual(await createToolCallReader({ listMessages })("ses_ok"), [{ tool: "bash", command: "npm run build" }, { tool: "read", command: "ls" }]);
  assert.deepEqual(await createSingleMessageReader({ listMessages })({ sessionID: "ses_ok", messageID: "msg_1" }), { role: "user", text: "run it" });
  assert.equal(await createSingleMessageReader({ listMessages })({ sessionID: "ses_ok", messageID: "nope" }), null);
  assert.deepEqual(await createUserRequestLister({ listMessages })("ses_ok"), [{ id: "msg_1", text: "run it" }]);
  const res = await createTrialResultReader({ listMessages })("ses_ok");
  assert.equal(res.text, "STEP 1: VALID - ok");
  assert.equal(res.usd, 0.02);
  assert.deepEqual(res.tokens, { input: 10, output: 5, cache: { read: 1, write: 2 } });
  assert.deepEqual(res.model, { providerID: "p", modelID: "mm" });
  assert.deepEqual(await createTrialResultReader({ listMessages })("ses_bad"), { text: "" });
});

test("skill loads: the newest `skill` tool call per name, read through the db worker", async () => {
  const calls = [];
  const runDbTask = async (task, args) => {
    calls.push(task);
    if (task === "sessionsInRange") return [{ sid: "ses_a" }, { sid: "ses_b" }];
    assert.deepEqual(args.scope, ["ses_a", "ses_b"]);
    return {
      complete: true,
      rows: [
        { skill: "learned-a", time_created: 300 },
        { skill: "learned-a", time_created: 100 },
        { skill: "learned-b", time_created: 50 },
        { skill: "other", time_created: 999 },
      ],
    };
  };
  const lastLoads = createSkillLoadReader({ runDbTask, now: () => 1_000_000 });
  assert.deepEqual(await lastLoads(["learned-a", "learned-b", "learned-c"]), { "learned-a": 300, "learned-b": 50 });
  assert.deepEqual(calls, ["sessionsInRange", "sessionSearch"]);
  assert.deepEqual(await lastLoads([]), {});
});

test("the skill-load query runs against the real V2 message schema", async (t) => {
  const { createFixtureDb, sqliteAvailable } = await import("../fixtures/opencodeV2DbFixture.mjs");
  if (!(await sqliteAvailable())) return t.skip("no node:sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const { TASKS } = await import("../dbTasks.mjs");
  const fx = await createFixtureDb({
    sessions: [{ id: "ses_a", timeCreated: 1, timeUpdated: 900 }],
    messages: [
      { id: "msg_1", sessionId: "ses_a", timeCreated: 100, data: { role: "assistant" } },
      { id: "msg_2", sessionId: "ses_a", timeCreated: 200, data: { role: "assistant" } },
    ],
    parts: [
      { id: "p1", messageId: "msg_1", sessionId: "ses_a", timeCreated: 100, data: { type: "tool", tool: "skill", state: { status: "completed", input: { name: "learned-a" }, output: "x" } } },
      { id: "p2", messageId: "msg_2", sessionId: "ses_a", timeCreated: 200, data: { type: "tool", tool: "skill", state: { status: "completed", input: { name: "learned-a" }, output: "x" } } },
      { id: "p3", messageId: "msg_2", sessionId: "ses_a", timeCreated: 200, data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "x" } } },
    ],
  });
  const db = new DatabaseSync(fx.dbPath);
  try {
    const runDbTask = async (task, args) => TASKS[task](db, args);
    const out = await createSkillLoadReader({ runDbTask, now: () => 1_000 , windowMs: 1_000 })(["learned-a"]);
    assert.deepEqual(out, { "learned-a": 200 });
  } finally {
    db.close();
    fx.close();
  }
});

test("seam: capture's {limit} reaches opencode through the box wrapper (forwardListMessages), and index.mjs uses no option-dropping wrapper", async () => {
  const seen = [];
  const oc = { listMessages: async (sid, opts) => (seen.push({ sid, opts }), [m("msg_1", "user", "hello")]) };
  const read = createCaptureMessageSource({ listMessages: forwardListMessages(oc) });
  await read({ sessionID: "ses_a", after: null, limit: 37 });
  assert.deepEqual(seen[0].opts, { limit: 37 });
  const src = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const knowledgeEngine = createKnowledgeEngine("), src.indexOf("const knowledgeReaper"));
  assert.ok(block.includes("forwardKnowledgeListMessages(oc)"));
  assert.doesNotMatch(block, /listMessages: \(\w+\) =>/, "a (sid) => oc.listMessages(sid) wrapper drops the options argument");
  assert.match(block, /isManagedSession: createKnowledgeIsManagedSession\(/);
  assert.match(block, /listMessagesSince: oc\.listMessagesSince/, "capture's catch-up reads forward from the bookmark");
  assert.match(block, /summariesFor: \(sessionID\) => handoffEngine\.summariesFor\(sessionID\)/, "capture reads the handoff engine's delivered summaries");
});

test("seam: every knowledge work type is one the shared budget knows; the knowledge runner over the REAL budget refuses at the pay-per-token cap and books what ran", async () => {
  const { createBackgroundBudget, WORK_CLASS } = await import("../backgroundBudget.mjs");
  for (const w of ["knowledge-capture", "knowledge-corrections", "knowledge-tidy", "knowledge-trial", "curator-notes", "curator-rules", "curator-skills"]) assert.ok(WORK_CLASS[w], w);
  // a $1/day pay-per-token budget over model p/m at $10 per million input tokens
  const budgetOver = (store) =>
    createBackgroundBudget({
      store,
      configGet: async () => ({ backgroundWork: { level: "normal", dailyCapUsd: 1 } }),
      getPrices: async () => ({ models: { "p/m": { input: 10, output: 50 } } }),
      resolveDefaultModel: async () => ({ providerID: "p", modelID: "m" }),
    });
  let saved = null;
  const bb = budgetOver({ load: async () => saved, save: async (d) => (saved = structuredClone(d)) });
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: {}, configGet: async () => ({}), backgroundBudget: bb });
  await run({ taskClass: "curator-notes" });
  assert.deepEqual(await got.deps.preflight({ model: { providerID: "p", modelID: "m" } }), { ok: true });
  // 100k input at $10/Mtok = $1: the day's cap is spent
  await got.deps.reportCost({ taskClass: "curator-notes", model: { providerID: "p", modelID: "m" }, tokens: 1, usage: { input: 100_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, estimated: false });
  assert.equal(bb.usdToday({ mode: "payg" }), 1);
  assert.deepEqual(await got.deps.preflight({ model: null }), { ok: false, reason: "usd-cap" }); // a null model is the box default
  // batch work stops earlier: tidy-up calls hit the 60 % batch ceiling first
  const bb2 = budgetOver({ load: async () => null, save: async () => {} });
  const run2 = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: {}, configGet: async () => ({}), backgroundBudget: bb2 });
  await run2({ taskClass: "curator-rules", workType: "knowledge-tidy" });
  await got.deps.reportCost({ taskClass: "curator-rules", model: { providerID: "p", modelID: "m" }, tokens: 1, usage: { input: 70_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.equal((await got.deps.preflight({ model: null })).ok, false, "tidy (batch) is over its 60 % ceiling…");
  await run2({ taskClass: "curator-rules" });
  assert.equal((await got.deps.preflight({ model: null })).ok, true, "…while continuous curation still has the last 40 %");
});

test("seam: index.mjs hands the ONE shared background budget to the knowledge runner and engine, after it is created, and writes the shared cap through the synced config path", async () => {
  const src = await readFile(new URL("../index.mjs", import.meta.url), "utf8");
  const created = src.indexOf("const backgroundBudget = createBackgroundBudget(");
  const runner = src.indexOf("const knowledgeRunner = createKnowledgeRunner(");
  const engine = src.indexOf("const knowledgeEngine = createKnowledgeEngine(");
  assert.ok(created > 0 && created < runner && runner < engine, "created before it is referenced (a const used earlier is a boot-time TDZ crash)");
  assert.match(src.slice(runner, engine), /backgroundBudget,/);
  const block = src.slice(engine, src.indexOf("const knowledgeReaper"));
  assert.match(block, /\n  backgroundBudget,/);
  assert.match(block, /syncState\.applyConfig\(next\)/);
});

test("seam: createIsManagedSession — a Manta-owned job's child session is managed; an opencode-owned subagent, an observed session or an unknown id is not; a store failure throws", async () => {
  const completionOwnerOf = (j) => j?.completionOwner ?? (j?.origin === "subagent" ? "opencode" : "manta");
  const jobs = [
    { id: "j1", childSessionID: "ses_job", origin: "delegate", status: "done" },
    { id: "j2", childSessionID: "ses_task", origin: "subagent", status: "running" },
    { id: "j3", childSessionID: "ses_seen", origin: "observed", status: "running" },
    { id: "j4", childSessionID: "ses_cmd", origin: "command", status: "running" },
  ];
  const is = createIsManagedSession({ loadJobs: async () => jobs, completionOwnerOf });
  assert.deepEqual(await Promise.all(["ses_job", "ses_task", "ses_seen", "ses_cmd", "ses_other", ""].map(is)), [true, false, false, true, false, false]);
  await assert.rejects(createIsManagedSession({ loadJobs: async () => { throw new Error("read"); }, completionOwnerOf })("ses_job"));
});

test("seam: the engine hands isManagedSession to the session map — a job child never inherits its parent's project, a task child does", async () => {
  const JOB = `ses_${"0123456789abcdef".repeat(2)}`;
  const TASK = "ses_a1b2c3d4e5f6AbCdEfGhIjKlMn";
  const r = await curatorRig({ over: { isManagedSession: async (id) => id === TASK } });
  await r.slugOf("ses_one");
  const created = (sessionID) => ({ type: "session.created", data: { sessionID, parentID: "ses_one" } });
  await r.engine.observeRaw(created(TASK));
  await r.engine.observeRaw(created(JOB));
  assert.equal(r.engine.sessionMap.get(TASK), null); // the hook says it is a job's session
  assert.ok(r.engine.sessionMap.get(JOB)); // hook present and says no → task child, whatever the id looks like
  await r.engine.stop();
});

// ---- seam: the runner's cost shape ({tokens: usage-object-or-number, usd?, estimated}) reaches the ledger intact ----

const USAGE = { input: 1000, output: 200, reasoning: 50, cacheRead: 4000, cacheWrite: 300 };
const PRICES = { models: { "p/m": { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 } } };
const USAGE_USD = (1000 * 10 + 200 * 20 + 4000 * 1 + 300 * 12 + 50 * 20) / 1e6; // every component priced, reasoning at the output rate
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
const MODEL = { providerID: "p", modelID: "m" };
const RUNNER_SHAPES = [
  ["recorded cost wins", { tokens: 5550, usage: USAGE, usd: 0.07, estimated: false }, 0.07],
  ["usage object priced per component", { tokens: 5550, usage: USAGE, estimated: false }, USAGE_USD],
  ["plain estimate number = a total", { tokens: 1000, estimated: true }, (900 * 10 + 100 * 20) / 1e6],
];

async function ledgerBudget() {
  const { memState } = await import("./testHelpers.mjs");
  const { createBudget } = await import("./budget.mjs");
  return createBudget({ state: await memState(), getPrices: async () => PRICES, bandOf: () => null });
}

test("seam: capture / corrections / skills (makeReportCost behind createKnowledgeRunner) price every runner cost shape", async () => {
  const { makeReportCost } = await import("./capture.mjs");
  for (const [name, shape, expected] of RUNNER_SHAPES) {
    const budget = await ledgerBudget();
    const run = createKnowledgeRunner({ runEphemeral: async ({ deps }) => (await deps.reportCost({ taskClass: "knowledge-capture", tier: "fast", model: MODEL, ...shape }), { text: "ok" }), oc: {}, configGet: async () => ({}) });
    await run({ taskClass: "knowledge-capture", deps: { reportCost: makeReportCost(budget, "s1") } });
    near(budget.spentToday(), expected);
    assert.ok(budget.spentToday() > 0, name);
  }
});

test("seam: the curator's reportCost prices every runner cost shape (the recorded cost wins; a usage object is priced per component)", async () => {
  for (const [name, shape, expected] of RUNNER_SHAPES) {
    const r = await curatorRig({
      over: { getPrices: async () => PRICES },
      runner: async (args, _calls) => (await args.deps.reportCost({ taskClass: args.taskClass, model: MODEL, ...shape }), { text: JSON.stringify({ decisions: [] }) }),
    });
    const slug = await r.slugOf("ses_one");
    await r.note(slug, "ses_one", "howto", "a fact worth a run");
    await r.engine.runCurator(slug, { force: true });
    const rows = r.engine.state.db.prepare("SELECT usd FROM budget_ledger ORDER BY rowid").all();
    // curator numbers are prompt-heavy (75/25); the curatorRig adds its own 4000-token record after the runner returns
    near(rows[0].usd, name.startsWith("plain") ? (750 * 10 + 250 * 20) / 1e6 : expected);
    await r.engine.stop();
  }
});

test("seam: the trial's recorded usage (opencode's nested cache shape) is priced per component, cache included; a recorded cost wins", async () => {
  const budget = await ledgerBudget();
  const nested = { input: 1000, output: 200, cache: { read: 4000, write: 300 } };
  const a = await budget.record({ taskClass: "knowledge-trial", model: MODEL, tokens: nested });
  near(a.usd, (1000 * 10 + 200 * 20 + 4000 * 1 + 300 * 12) / 1e6);
  const b = await budget.record({ taskClass: "knowledge-trial", model: MODEL, tokens: nested, usd: 0.5 });
  assert.equal(b.usd, 0.5);
});
