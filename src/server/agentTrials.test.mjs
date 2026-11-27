// Architect v2 Stage 1 (docs/superpowers/specs/2026-11-27-architect-v2.md §3.3): trial runs. A real temp folder stands in for
// ~/.manta/agents; opencode, git, the config writer and the budget are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTrials, draftHash, differingFiles, TRIAL_AUTO_ANSWER, CASE_TIMEOUT_MS } from "./agentTrials.mjs";
import { MODES } from "../shared/autonomyShared.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const HOME = "/home/test";
const AGENT_MD = "---\nname: SEO Reviewer\ndescription: Reviews SEO.\nisolation: none\n---\nYou review SEO.\n";

const planFor = (over = {}) => {
  const bundle = { "agent.md": AGENT_MD };
  return {
    kind: "create",
    slug: "seo-reviewer",
    name: "SEO Reviewer",
    bundle,
    files: Object.fromEntries(Object.entries(bundle).map(([k]) => [k, `hash-of-${k}`])),
    meta: { name: "SEO Reviewer", description: "Reviews SEO.", isolation: "none", model: null, role: "specialist" },
    body: "You review SEO.",
    needsTrial: true,
    compiled: "You review SEO.\n",
    seats: [],
    block: { mode: "all", description: "Reviews SEO.", prompt: "{file:/dir/.compiled.md}", permission: { external_directory: { "/dir/**": "allow" } } },
    ...over,
  };
};

const msgs = (final = "The page has no title tag.") => [
  { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "Review the home page." }] },
  { info: { id: "m2", role: "assistant", cost: 0.01, tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } }, providerID: "p", modelID: "m" }, parts: [
    { type: "tool", tool: "read", state: { status: "completed", input: { path: "index.html" }, output: "<html></html>" } },
    { type: "tool", tool: "bash", state: { status: "error", input: { command: "git push" }, error: "Permission denied: shell" } },
    { type: "tool", tool: "question", state: { status: "completed", input: { questions: [{ question: "Which page?" }] }, output: "ok" } },
    { type: "text", text: final },
  ] },
];

async function rig(over = {}) {
  const base = await mkdtemp(join(tmpdir(), "agent-trials-"));
  const root = join(base, "agents");
  const scratchRoot = join(base, "scratch");
  await mkdir(root, { recursive: true });
  const w = {
    plan: planFor(),
    refused: null,
    planError: null,
    sessions: { ses_9: ["job9", "job9"], ses_2: ["job2", "job2"] }, // the Architect session → [round job, task root]; any other is job1
    created: [],
    prompts: [],
    aborted: [],
    deleted: [],
    replies: [],
    worktrees: [],
    removed: [],
    git: [],
    booked: [],
    canSpend: [],
    messages: msgs(),
    canSpendOk: true,
    symlinkOk: true,
    projectDirs: { shop: "/repo/shop" },
    status: " M a.txt\n?? b.txt\n",
    config: { cfg: { agent: {} }, edits: [], reloads: 0 },
    scanLeak: false,
    outcome: "succeeded", // how a session ends; "hang" never ends
    clock: 1_700_000_000_000,
    timers: [],
  };
  const trialsRoot = () => join(root, ".trials");
  let n = 0;
  const make = (extra = {}) => {
    let t;
    const oc = {
      createSession: async (i) => (w.created.push(i), { id: i.id }),
      sendPrompt: async (i) => {
        w.prompts.push(i);
        if (w.outcome !== "hang") queueMicrotask(() => t.observeRaw({ type: `session.execution.${w.outcome}`, data: { sessionID: i.sessionId } }));
      },
      abortSession: async (id) => {
        w.aborted.push(id);
        queueMicrotask(() => t.observeRaw({ type: "session.execution.interrupted", data: { sessionID: id } }));
      },
      deleteSessionRaw: async (id) => w.deleted.push(id),
      listMessages: async () => w.messages,
      replyQuestion: async (a) => w.replies.push(a),
    };
    t = createAgentTrials({
      root,
      home: HOME,
      scratchRoot,
      agents: () => ({
        bindArchitect: async (b, tool) => {
          const [jobId, rootJobId] = w.sessions[b.sessionID] ?? ["job1", "job1"];
          return w.refused ? { refused: w.refused } : { job: { id: jobId, childSessionID: b.sessionID }, stamp: { rootJobId }, childSessionID: b.sessionID, tool };
        },
        trialPlan: async (input, { dir }) => (w.planError ? { error: w.planError } : input.action !== "create" && input.action !== "update" ? { error: 'action must be "create" or "update"' } : { ...w.plan, dir }),
      }),
      oc,
      local: {
        gitAddWorktree: async ({ cwd, name }) => (w.worktrees.push({ cwd, name }), { path: `/wt/${name}`, branch: name }),
        gitRemoveWorktree: async (a) => (w.removed.push(a), { removed: true }),
      },
      gitRun: async (args) => {
        w.git.push(args);
        if (args.includes("status")) return { stdout: w.status };
        return { stdout: "" };
      },
      editConfig: fakeConfigWriter(w.config),
      budget: { canSpend: async (a) => (w.canSpend.push(a), { ok: w.canSpendOk, reason: "usd-cap" }), book: async (a) => w.booked.push(a) },
      policy: async () => ({ ...MODES.balanced, agent_change: "tell" }),
      projectDirectory: async (slug) => w.projectDirs[slug] ?? null,
      scanSymlinks: () => (w.symlinkOk ? { ok: true } : { ok: false, outside: "evil" }),
      redact: async (text) => ({ text: w.scanLeak ? text.replaceAll("SECRET-TOKEN", "[redacted]") : text, unavailable: false }),
      mint: () => `tr_${(++n).toString(16).padStart(8, "0")}`,
      mintSession: () => `ses_trial${++n}`,
      now: () => w.clock,
      log: { warn: () => {} },
      ...extra,
    });
    return t;
  };
  const caseOf = (name, over = {}) => ({ name, task: `Do the ${name} thing.`, expect: "does", checks: "It does it.", ...over });
  const input = (over = {}) => ({ sessionID: "ses_child", messageID: "msg_1", callID: "call_1", action: "create", draft: { name: "SEO Reviewer" }, cases: [caseOf("main")], ...over });
  return { base, root, w, make, caseOf, input, trialsRoot, t: make(), cleanup: () => rm(base, { recursive: true, force: true }) };
}

const settle = async (t, id, ms = 50) => {
  const r = await t.wait({ sessionID: "ses_child", messageID: `msg_w${id}`, callID: `call_w${id}`, trialId: id });
  return r;
};

test("draftHash is canonical over the sorted [path, text] pairs; differingFiles names what differs", () => {
  assert.equal(draftHash({ b: "2", a: "1" }), draftHash({ a: "1", b: "2" }));
  assert.deepEqual(differingFiles({ a: "1", b: "2", c: "3" }, { a: "1", b: "x", d: "4" }), ["b", "c", "d"]);
});

test("create: binds the call, plans the draft, writes its files and a temporary block, and answers at once with the hash", async () => {
  const f = await rig();
  try {
    const r = await f.t.create(f.input());
    assert.equal(r.ok, true, r.error);
    assert.match(r.trialId, /^tr_[0-9a-f]+$/);
    assert.equal(r.draftHash, draftHash(f.w.plan.bundle));
    const dir = join(f.trialsRoot(), r.trialId);
    assert.equal(await readFile(join(dir, "agent.md"), "utf-8"), AGENT_MD);
    assert.equal(await readFile(join(dir, ".compiled.md"), "utf-8"), "You review SEO.\n");
    const key = `agent-trial-${r.trialId}`;
    assert.ok(f.w.config.cfg.agent[key], "the block exists");
    assert.ok(f.t.activeTrialKeys().has(key), "and is kept by syncLocked while the trial lives");
    assert.equal(f.t.get(r.trialId).rootJobId, "job1");
    assert.equal(f.t.get(r.trialId).agentSlug, "seo-reviewer");
    await settle(f.t, r.trialId); // (the run is in the background: let it end before the folder goes)
  } finally {
    await f.cleanup();
  }
});

test("create refusals are sentences: not the Architect's call, a draft that can't be planned, cases out of range, a bad case, an unknown project", async () => {
  const f = await rig();
  try {
    f.w.refused = "Only the Architect, working on a task from Manta, can use this tool";
    assert.deepEqual(await f.t.create(f.input()), { ok: false, error: f.w.refused });
    f.w.refused = null;
    f.w.planError = "@dev changed since you read it";
    assert.deepEqual(await f.t.create(f.input()), { ok: false, error: "@dev changed since you read it" });
    f.w.planError = null;
    const bad = async (over, re) => {
      const r = await f.t.create(f.input(over));
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.match(r.error, re);
    };
    await bad({ cases: [] }, /1 to 3 cases/);
    await bad({ cases: [1, 2, 3, 4].map((i) => f.caseOf(`c${i}`)) }, /1 to 3 cases/);
    await bad({ cases: undefined }, /1 to 3 cases/);
    await bad({ cases: [f.caseOf("a"), f.caseOf("a")] }, /twice|unique/i);
    await bad({ cases: [f.caseOf("a", { task: "" })] }, /task/);
    await bad({ cases: [f.caseOf("a", { expect: "maybe" })] }, /expect/);
    await bad({ cases: [f.caseOf("a", { name: "" })] }, /name/);
    await bad({ cases: [f.caseOf("a", { checks: "" })] }, /checks/);
    await bad({ cases: [f.caseOf("a", { project: "nowhere" })] }, /project/);
    await bad({ cases: [f.caseOf("a", { project: "Bad Slug!" })] }, /project/);
    await bad({ action: "delete" }, /action/);
    assert.deepEqual(await readdir(f.trialsRoot()).catch(() => []), [], "nothing was written for a refused call");
    assert.deepEqual(Object.keys(f.w.config.cfg.agent), [], "no block either");
  } finally {
    await f.cleanup();
  }
});

test("a case runs as a headless internal session in a throwaway scratch repo when there is no project", async () => {
  const f = await rig();
  try {
    const { trialId } = await f.t.create(f.input({ cases: [f.caseOf("main", { task: "Review the home page." })] }));
    const r = await settle(f.t, trialId);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.state, "done");
    const s = f.w.created[0];
    assert.match(s.id, /^ses_trial/);
    assert.equal(s.agent, `agent-trial-${trialId}`);
    assert.equal(s.directory.startsWith(join(f.base, "scratch")), true, "outside ~/.manta: the ruleset's protections rely on it");
    assert.equal(s.metadata.manta.internal, true);
    assert.equal(s.metadata.manta.agentTrial, trialId);
    assert.deepEqual(f.w.worktrees, [], "no project, no worktree");
    assert.ok(f.w.git.some((a) => a.includes("init")), "a scratch repo was made");
    assert.match(f.w.prompts[0].text, /Review the home page\./);
    assert.equal(f.w.prompts[0].agent, `agent-trial-${trialId}`);
    // what was recorded
    const c = r.cases[0];
    assert.equal(c.name, "main");
    assert.equal(c.expect, "does");
    assert.equal(c.state, "done");
    assert.equal(c.finalAnswer, "The page has no title tag.");
    assert.deepEqual(c.tools, ["bash", "question", "read"]);
    assert.equal(c.filesChanged, 2);
    assert.deepEqual(c.refused, ["Permission denied: shell"]);
    assert.deepEqual(c.wouldAsk, ["Which page?"]);
    assert.equal(typeof c.durationMs, "number");
    assert.equal(Object.hasOwn(c, "transcript"), false, "the transcript is read with agent_trial_read");
  } finally {
    await f.cleanup();
  }
});

test("with a project (the case's, else the agent's first seat) the case runs in a worktree of its checkout, never the checkout itself", async () => {
  const f = await rig({});
  try {
    const t1 = await f.t.create(f.input({ cases: [f.caseOf("main", { project: "shop" })] }));
    await settle(f.t, t1.trialId);
    assert.deepEqual(f.w.worktrees[0].cwd, "/repo/shop");
    assert.match(f.w.created[0].directory, /^\/wt\/agent-trial-/);
    assert.ok(f.w.removed.some((a) => a.path.startsWith("/wt/agent-trial-") && a.force === true), "the worktree was removed");
    // an update of an agent with a seat: its first seat
    f.w.plan = planFor({ kind: "update", seats: ["shop"] });
    const t2 = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2", action: "update", agent: "seo-reviewer", baseHash: "x" }));
    await settle(f.t, t2.trialId);
    assert.equal(f.w.worktrees[1].cwd, "/repo/shop");
  } finally {
    await f.cleanup();
  }
});

test("a worktree holding a link that leaves it is refused: the case fails, no session is made", async () => {
  const f = await rig();
  try {
    f.w.symlinkOk = false;
    const { trialId } = await f.t.create(f.input({ cases: [f.caseOf("main", { project: "shop" })] }));
    const r = await settle(f.t, trialId);
    assert.equal(r.cases[0].state, "failed");
    assert.match(r.cases[0].error, /link/i);
    assert.deepEqual(f.w.created, []);
    assert.ok(f.w.removed.length >= 1, "the worktree is still removed");
  } finally {
    await f.cleanup();
  }
});

test("the ruleset: the agent's own task rules with no secrets, the never-kinds, the command and tool denies — all after the allows; the question tool is allowed", async () => {
  const f = await rig();
  try {
    f.w.plan = planFor({ meta: { name: "Dev", description: "d", isolation: "worktree", model: null, role: "specialist" } });
    const { trialId } = await f.t.create(f.input());
    await settle(f.t, trialId);
    const rules = f.w.created[0].permission;
    assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" }, "the catch-all deny is first");
    const last = (permission, pattern) => rules.findLast((r) => r.permission === permission && r.pattern === pattern);
    // an agent that works in a branch keeps its edit tools
    assert.equal(last("edit", "**")?.action, "allow");
    // no secrets of any kind: no handed-secret exception, every command naming the folder denied
    assert.equal(rules.some((r) => r.action === "allow" && String(r.pattern).includes(".manta-secrets")), false);
    assert.equal(last("bash", "*.manta-secrets*")?.action, "deny");
    // the kinds are never, whatever the user's settings say
    for (const p of ["fly deploy*", "npm publish*", "gh gist create*", "gh issue create*", "dropdb*"]) assert.equal(last("bash", p)?.action, "deny", p);
    // publishing, sending and network writes
    for (const p of ["git push*", "gh pr *", "gh release *", "gh issue *", "gh api *", "curl *-X*", "curl *--request*", "curl *-d*", "curl *--data*", "curl *-F*", "curl *--form*", "curl *-T*", "wget *--post*", "ssh *", "scp *", "rsync *", "nc *"]) {
      assert.equal(last("bash", p)?.action, "deny", p);
    }
    // Manta's own side-effect tools
    for (const tool of ["agent_trial", "agent_trial_wait", "agent_trial_read", "agent_trial*", "agent_propose", "agent_change", "research_library_save", "delegate", "delegate*", "agent_handoff", "routine_*", "schedule_*", "notify", "send_file", "serve_page"]) {
      assert.equal(last(tool, "*")?.action, "deny", tool);
    }
    // each of those denies comes after every allow of the same permission (last match wins)
    for (const tool of ["agent_propose", "notify", "delegate"]) assert.ok(rules.findLastIndex((r) => r.permission === tool && r.action === "deny") > rules.findLastIndex((r) => r.permission === tool && r.action === "allow"), tool);
    // the question tool is allowed and answered by the server (no trailing question deny)
    assert.equal(last("question", "*")?.action, "allow");
    assert.equal(rules.some((r) => r.permission === "question" && r.action === "deny"), false);
    // a read-only agent has no shell and no edit at all
    f.w.plan = planFor();
    const t2 = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2" }));
    await settle(f.t, t2.trialId);
    const ro = f.w.created[1].permission;
    assert.equal(ro.some((r) => r.permission === "bash" && r.pattern === "**" && r.action === "allow"), false);
    assert.equal(ro.some((r) => r.permission === "edit" && r.action === "allow"), false);
  } finally {
    await f.cleanup();
  }
});

test("the draft's model is the trial's model; no model is Auto", async () => {
  const f = await rig();
  try {
    f.w.plan = planFor({ meta: { name: "X", description: "d", isolation: "none", model: "anthropic/claude-sonnet-5-5", role: "specialist" } });
    const a = await f.t.create(f.input());
    await settle(f.t, a.trialId);
    assert.deepEqual(f.w.created[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    assert.deepEqual(f.w.prompts[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    assert.deepEqual(f.w.canSpend[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    f.w.plan = planFor();
    const b = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2" }));
    await settle(f.t, b.trialId);
    assert.equal(f.w.created[1].model, undefined);
  } finally {
    await f.cleanup();
  }
});

test("a question the agent asks is answered at once by the server, recorded as 'would ask', and never reaches a person", async () => {
  const f = await rig({});
  try {
    f.w.outcome = "hang";
    const { trialId } = await f.t.create(f.input());
    await new Promise((r) => setTimeout(r, 20));
    const sid = f.w.created[0].id;
    assert.equal(f.t.ownsSession(sid), true);
    assert.equal(f.t.ownsSession("ses_other"), false);
    const form = { id: "form_1", sessionID: sid, metadata: { kind: "question" }, fields: [{ key: "q1", title: "Page", description: "Which page should I review?", type: "select", options: [{ label: "Home" }] }] };
    assert.equal(await f.t.handleQuestion(form), true);
    assert.deepEqual(f.w.replies, [{ requestId: "form_1", answers: [[TRIAL_AUTO_ANSWER]], sessionId: sid }]);
    assert.match(TRIAL_AUTO_ANSWER, /This is a test run with no user: continue on your best assumption and say what you assumed/);
    f.w.outcome = "succeeded";
    f.t.observeRaw({ type: "session.execution.succeeded", data: { sessionID: sid } });
    const r = await settle(f.t, trialId);
    assert.ok(r.cases[0].wouldAsk.includes("Which page should I review?"));
    // a form of another session is not ours
    assert.equal(await f.t.handleQuestion({ ...form, sessionID: "ses_other" }), false);
  } finally {
    await f.cleanup();
  }
});

test("limits: at most 2 cases run at once box-wide, in order; 3 trials per agent and 6 per task", async () => {
  const f = await rig();
  try {
    f.w.outcome = "hang";
    const a = await f.t.create(f.input({ cases: [f.caseOf("a1"), f.caseOf("a2"), f.caseOf("a3")] }));
    const b = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2", cases: [f.caseOf("b1")] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.w.created.length, 2, "only two sessions run at a time");
    assert.deepEqual(f.w.prompts.map((p) => p.text.split("\n")[0]).sort(), ["Do the a1 thing.", "Do the a2 thing."], "first come, first served");
    assert.equal(f.t.get(a.trialId).cases[2].state, "queued");
    assert.equal(f.t.get(b.trialId).cases[0].state, "queued");
    // one ends: the next in line starts
    f.t.observeRaw({ type: "session.execution.succeeded", data: { sessionID: f.w.created[0].id } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.w.created.length, 3);
    assert.equal(f.w.prompts[2].text.split("\n")[0], "Do the a3 thing.");
    // the per-agent cap: a third trial of the same agent is the last
    const c = await f.t.create(f.input({ messageID: "msg_3", callID: "call_3" }));
    assert.equal(c.ok, true);
    const d = await f.t.create(f.input({ messageID: "msg_4", callID: "call_4" }));
    assert.equal(d.ok, false);
    assert.match(d.error, /3 trials/);
    // another agent in the same task: allowed until 6 in all
    for (let i = 0; i < 3; i++) {
      f.w.plan = planFor({ slug: `other-${i}` });
      const r = await f.t.create(f.input({ messageID: `msg_o${i}`, callID: `call_o${i}` }));
      assert.equal(r.ok, true, r.error);
    }
    f.w.plan = planFor({ slug: "other-9" });
    const seventh = await f.t.create(f.input({ messageID: "msg_o9", callID: "call_o9" }));
    assert.equal(seventh.ok, false);
    assert.match(seventh.error, /6 trials/);
    // another task has its own count
    const elsewhere = await f.t.create(f.input({ messageID: "msg_x", callID: "call_x", sessionID: "ses_9" }));
    assert.equal(elsewhere.ok, true, elsewhere.error);
  } finally {
    await f.cleanup();
  }
});

test("a case that runs past 15 minutes is aborted and recorded as timed out", async () => {
  const timers = [];
  const f = await rig();
  try {
    f.w.outcome = "hang";
    const t = f.make({ setTimeoutFn: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }), clearTimeoutFn: () => {} });
    const { trialId } = await t.create(f.input());
    await new Promise((r) => setTimeout(r, 20));
    const guard = timers.find((x) => x.ms === CASE_TIMEOUT_MS);
    assert.ok(guard, "a 15-minute guard was set");
    assert.equal(CASE_TIMEOUT_MS, 15 * 60_000);
    guard.fn();
    const r = await t.wait({ sessionID: "ses_child", messageID: "msg_w", callID: "call_w", trialId });
    assert.equal(r.cases[0].state, "timed-out");
    assert.deepEqual(f.w.aborted, [f.w.created[0].id]);
  } finally {
    await f.cleanup();
  }
});

test("a failed session is recorded as failed", async () => {
  const f = await rig();
  try {
    f.w.outcome = "failed";
    const { trialId } = await f.t.create(f.input());
    assert.equal((await settle(f.t, trialId)).cases[0].state, "failed");
  } finally {
    await f.cleanup();
  }
});

test("the budget is asked before a case and told what it cost; a refusal fails the case without running it", async () => {
  const f = await rig();
  try {
    const a = await f.t.create(f.input());
    await settle(f.t, a.trialId);
    assert.deepEqual(f.w.canSpend[0], { workType: "agent-trial" });
    assert.deepEqual(f.w.booked[0], { workType: "agent-trial", model: { providerID: "p", modelID: "m" }, usage: { input: 100, output: 20, cache: { read: 0, write: 0 } }, usd: 0.01, inLedger: false });
    f.w.canSpendOk = false;
    const b = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2" }));
    const r = await settle(f.t, b.trialId);
    assert.equal(r.cases[0].state, "failed");
    assert.match(r.cases[0].error, /budget|usd-cap/i);
    assert.equal(f.w.created.length, 1, "no second session");
  } finally {
    await f.cleanup();
  }
});

test("when every case has ended: result.json is written, the sessions are deleted, the workspace and the block are gone, and the files are cleaned", async () => {
  const f = await rig();
  try {
    f.w.messages = msgs("Done. SECRET-TOKEN was in the output.");
    f.w.scanLeak = true;
    const { trialId } = await f.t.create(f.input({ cases: [f.caseOf("main", { project: "shop" })] }));
    await settle(f.t, trialId);
    const dir = join(f.trialsRoot(), trialId);
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf-8"));
    assert.equal(result.id, trialId);
    assert.equal(result.rootJobId, "job1");
    assert.equal(result.agentSlug, "seo-reviewer");
    assert.equal(result.draftHash, draftHash(f.w.plan.bundle));
    assert.equal(result.cases[0].state, "done");
    assert.match(result.cases[0].transcript, /Assistant: Done\. \[redacted\] was in the output\./, "redacted before it is stored");
    assert.ok(!JSON.stringify(result).includes("SECRET-TOKEN"));
    assert.deepEqual(f.w.deleted, [f.w.created[0].id]);
    assert.equal(f.w.removed.length, 1);
    assert.equal(f.w.config.cfg.agent[`agent-trial-${trialId}`], undefined, "the temporary block is dropped");
    assert.equal(f.t.activeTrialKeys().size, 0);
    await assert.rejects(stat(join(dir, "agent.md")), "the drafted files are removed; the result stays");
    await assert.rejects(stat(join(dir, ".compiled.md")));
  } finally {
    await f.cleanup();
  }
});

test("scratch repos are removed with the case, whatever the end", async () => {
  const f = await rig();
  try {
    const { trialId } = await f.t.create(f.input());
    await settle(f.t, trialId);
    assert.deepEqual(await readdir(join(f.base, "scratch")), [], "nothing left behind");
  } finally {
    await f.cleanup();
  }
});

test("agent_trial_read pages the redacted transcript 20 000 characters at a time; unknown cases and other tasks' trials are refused", async () => {
  const f = await rig();
  try {
    f.w.messages = msgs("x".repeat(45_000));
    const { trialId } = await f.t.create(f.input());
    await settle(f.t, trialId);
    const read = (over = {}) => f.t.read({ sessionID: "ses_child", messageID: `msg_r${Math.random()}`, callID: `call_r${Math.random()}`, trialId, case: "main", ...over });
    const p1 = await read();
    assert.equal(p1.ok, true, p1.error);
    assert.equal(p1.text.length, 20_000);
    assert.equal(p1.nextOffset, 20_000);
    assert.match(p1.text, /^User: Review the home page\./);
    const p2 = await read({ offset: p1.nextOffset });
    assert.equal(p2.text.length, 20_000);
    const p3 = await read({ offset: p2.nextOffset });
    assert.equal(p3.nextOffset, null);
    assert.ok(p1.text.length + p2.text.length + p3.text.length > 45_000);
    assert.match((await read({ case: "ghost" })).error, /no case/i);
    assert.match((await read({ trialId: "tr_nope" })).error, /trial/i);
    assert.match((await read({ sessionID: "ses_9" })).error, /another task|this task/i);
    assert.equal((await read({ offset: -1 })).ok, false);
  } finally {
    await f.cleanup();
  }
});

test("wait returns after at most the wait limit with the cases as they are; a finished trial returns at once", async () => {
  const f = await rig();
  try {
    f.w.outcome = "hang";
    const t = f.make({ waitMs: 30 });
    const { trialId } = await t.create(f.input());
    const started = Date.now();
    const r = await t.wait({ sessionID: "ses_child", messageID: "msg_w", callID: "call_w", trialId });
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.state, "running");
    assert.equal(r.cases[0].state, "running");
    t.observeRaw({ type: "session.execution.succeeded", data: { sessionID: f.w.created[0].id } });
    const done = await t.wait({ sessionID: "ses_child", messageID: "msg_w2", callID: "call_w2", trialId });
    assert.equal(done.state, "done");
    assert.match((await t.wait({ sessionID: "ses_child", messageID: "msg_w3", callID: "call_w3", trialId: "tr_nope" })).error, /trial/i);
  } finally {
    await f.cleanup();
  }
});

test("when the Architect's round ends: queued cases are aborted, running ones are interrupted, everything is cleaned up; finished trials stay", async () => {
  const f = await rig();
  try {
    f.w.outcome = "hang";
    const a = await f.t.create(f.input({ cases: [f.caseOf("a1"), f.caseOf("a2"), f.caseOf("a3")] }));
    await new Promise((r) => setTimeout(r, 20));
    await f.t.abortForJob("job1");
    const trial = f.t.get(a.trialId);
    assert.deepEqual(trial.cases.map((c) => c.state), ["aborted", "aborted", "aborted"]);
    assert.equal(f.w.aborted.length, 2, "the two running sessions were interrupted");
    assert.equal(f.w.deleted.length, 2);
    assert.equal(f.t.activeTrialKeys().size, 0);
    assert.equal(f.w.config.cfg.agent[`agent-trial-${a.trialId}`], undefined);
    const result = JSON.parse(await readFile(join(f.trialsRoot(), a.trialId, "result.json"), "utf-8"));
    assert.deepEqual(result.cases.map((c) => c.state), ["aborted", "aborted", "aborted"]);
    // a trial that already finished is untouched
    f.w.outcome = "succeeded";
    const b = await f.t.create(f.input({ messageID: "msg_2", callID: "call_2" }));
    await settle(f.t, b.trialId);
    await f.t.abortForJob("job1");
    assert.equal(f.t.get(b.trialId).cases[0].state, "done");
    // another round's trials are not touched
    f.w.outcome = "hang";
    const c = await f.t.create(f.input({ messageID: "msg_3", callID: "call_3", sessionID: "ses_2" }));
    await f.t.abortForJob("job1");
    assert.notEqual(f.t.get(c.trialId).cases[0].state, "aborted");
  } finally {
    await f.cleanup();
  }
});

test("after a restart: finished trials are read back from result.json; a trial that never finished is cleaned up (session, workspace, files)", async () => {
  const f = await rig();
  try {
    const done = await f.t.create(f.input());
    await settle(f.t, done.trialId);
    // a crash left a running trial behind
    const left = join(f.trialsRoot(), "tr_deadbeef");
    await mkdir(left, { recursive: true });
    await writeFile(join(left, "agent.md"), AGENT_MD);
    await writeFile(join(left, "state.json"), JSON.stringify({ cases: [{ sessionId: "ses_orphan", worktree: "/wt/orphan", scratch: null }] }));
    const t2 = f.make();
    await t2.recover();
    assert.deepEqual(f.w.deleted.slice(-1), ["ses_orphan"]);
    assert.deepEqual(f.w.removed.at(-1), { path: "/wt/orphan", force: true });
    await assert.rejects(stat(left));
    const back = t2.get(done.trialId);
    assert.equal(back.cases[0].state, "done");
    assert.equal(back.cases[0].finalAnswer, "The page has no title tag.");
    assert.match(await t2.transcript(done.trialId, "main"), /Review the home page/);
    assert.equal(t2.get("tr_deadbeef"), null);
    assert.deepEqual(t2.list("seo-reviewer").map((x) => x.id), [done.trialId]);
  } finally {
    await f.cleanup();
  }
});

test("results are kept 30 days, then swept", async () => {
  const f = await rig();
  try {
    const { trialId } = await f.t.create(f.input());
    await settle(f.t, trialId);
    await f.t.sweep();
    await stat(join(f.trialsRoot(), trialId, "result.json"));
    f.w.clock += 31 * 24 * 3600 * 1000;
    await f.t.sweep();
    await assert.rejects(stat(join(f.trialsRoot(), trialId)));
    assert.equal(f.t.get(trialId), null);
  } finally {
    await f.cleanup();
  }
});

test("the wire view of a trial carries no transcript, task text or private plumbing", async () => {
  const f = await rig();
  try {
    const { trialId } = await f.t.create(f.input());
    await settle(f.t, trialId);
    const view = f.t.view(trialId);
    assert.deepEqual(Object.keys(view).sort(), ["agentSlug", "cases", "createdAt", "draftHash", "id", "rootJobId"]);
    assert.deepEqual(Object.keys(view.cases[0]).sort(), ["durationMs", "error", "expect", "filesChanged", "finalAnswer", "name", "refused", "state", "tools", "wouldAsk"]);
    assert.equal(f.t.view("tr_nope"), null);
  } finally {
    await f.cleanup();
  }
});
