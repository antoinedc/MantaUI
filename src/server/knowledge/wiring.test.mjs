// Unit tests for the small adapters in wiring.mjs, readers.mjs and integration.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthedGit, forgeBasicAuth } from "./wiring.mjs";
import { createKnowledgeRunner, knowledgeConfigDir, knowledgePaths } from "./integration.mjs";
import { createShellCommandReader, createSkillLoadReader, createToolCallReader, createTrialResultReader, createUserRequestLister, createSingleMessageReader } from "./readers.mjs";

const tool = (command, name = "bash") => ({ type: "tool", tool: name, state: { input: { command }, output: "ok" } });
const m = (id, role, text, parts = []) => ({ info: { id, role, time: { created: 1 } }, parts: [{ type: "text", text }, ...parts] });

test("authed git: network commands carry a one-shot credential header; others and unknown hosts pass through", async () => {
  const seen = [];
  const git = { run: async (args, o) => (seen.push(args), args[0] === "remote" ? "https://github.com/acme/widget.git\n" : "") };
  const authed = createAuthedGit(git, async (host) => (host === "github.com" ? { token: "tok" } : null));
  await authed.run(["clone", "--quiet", "https://github.com/acme/widget.git", "/x"], {});
  await authed.run(["fetch", "--prune", "origin"], { cwd: "/x" });
  await authed.run(["status"], { cwd: "/x" });
  await authed.run(["clone", "https://gitlab.example.com/a/b.git", "/y"], {});
  const header = `http.extraheader=Authorization: Basic ${forgeBasicAuth("github.com", "tok")}`;
  assert.deepEqual(seen.filter((a) => a[0] === "-c").map((a) => a.slice(0, 2)), [["-c", header], ["-c", header]]);
  assert.ok(seen.some((a) => a[0] === "status"));
  assert.ok(seen.some((a) => a[0] === "clone" && a[1] === "https://gitlab.example.com/a/b.git"), "no credential for an unknown host");
  assert.equal(Buffer.from(forgeBasicAuth("gitlab.com", "t"), "base64").toString(), "oauth2:t");
  assert.equal(Buffer.from(forgeBasicAuth("github.com", "t"), "base64").toString(), "x-access-token:t");
});

test("the runner wrapper merges its own collaborators under the caller's deps", async () => {
  let got;
  const run = createKnowledgeRunner({ runEphemeral: async (a) => (got = a), oc: { runEphemeralSession: 1 }, configGet: () => 2 });
  const validate = () => true;
  await run({ taskClass: "curator-notes", deps: { reportCost: 3, validate } });
  assert.deepEqual(Object.keys(got.deps).sort(), ["configGet", "oc", "reportCost", "validate"]);
  await run({ taskClass: "x" });
  assert.deepEqual(Object.keys(got.deps).sort(), ["configGet", "oc"]);
  await run({ taskClass: "x", deps: { configGet: "mine" } });
  assert.equal(got.deps.configGet, "mine");
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
