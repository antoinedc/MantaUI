// The research library, agents side (docs/superpowers/specs/2026-11-24-research-library.md): who may call the research and
// library tools (`bindResearcher`) and the guidance every agent task prompt gets. A temp folder stands in for ~/.manta/agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine } from "./agents.mjs";
import { RESEARCH_GUIDANCE } from "./researchLibrary.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));

// ---- the binding ----

const KEYS = { research_fetch: ["url"], research_read: ["sourceId", "offset"], research_search: ["source", "query"], research_library_find: ["query"], research_library_save: ["topic", "summary", "findings", "shelfLifeDays", "shelfLifeWhy", "shelfLifeVerified", "scope", "keep"] };

let n = 0;
async function world({ jobs, registry } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-research-"));
  const w = { messages: [], jobs: jobs ?? [{ id: "job1", childSessionID: "ses_c", parentSessionID: "ses_chat", parentDirectory: "/repo/site", status: "running", specialist: true, agent: "agent-seo" }] };
  const engine = createAgentsEngine({
    root: join(base, "agents"),
    templatesDir: join(base, "templates"),
    home: "/h",
    retryDelayMs: 0,
    log: { warn: () => {} },
    editConfig: async () => ({ ok: true }),
    reload: async () => ({ ok: true }),
    oc: { listMessages: async () => w.messages },
    delegate: { loadRecordsStrict: async () => w.jobs },
    tmux: { listProjects: async () => [] },
    ...(registry === undefined ? { registry: { identify: async (dir) => (dir === "/repo/site" ? { slug: "site" } : null) } } : { registry }),
  });
  return { w, engine, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// a running tool call of `agent` in `ses_c`, posting `args`; returns the body the tool would post
function call(w, tool, args, { agent = "agent-seo", status = "running", input } = {}) {
  const k = ++n;
  const b = { sessionID: "ses_c", messageID: `msg_${k}`, callID: `call_${k}`, raw: { ...args } }; // the shape the engines bind
  w.messages = [
    { info: { id: "msg_user", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent }, parts: [{ type: "tool", tool, callID: b.callID, state: { status, input: input ?? args } }] },
  ];
  return b;
}

const sample = { research_fetch: { url: "https://example.com/" }, research_read: { sourceId: "src_0123456789abcdef" }, research_search: { source: "hn", query: "agents" }, research_library_find: { query: "pricing" }, research_library_save: { topic: "A topic", summary: "s", findings: [{ claim: "c" }], shelfLifeDays: 30, shelfLifeWhy: "w", shelfLifeVerified: true, scope: "global" } };

test("a specialist's running task may call every research and library tool; the answer names the agent, the project and that it is not the Architect", async () => {
  const f = await world();
  try {
    for (const tool of Object.keys(KEYS)) {
      const b = call(f.w, tool, sample[tool]);
      const r = await f.engine.bindResearcher(b, tool);
      assert.equal(r.refused, undefined, `${tool}: ${r.refused}`);
      assert.equal(r.childSessionID, "ses_c");
      assert.equal(r.agent, "seo");
      assert.equal(r.architect, false);
      assert.equal(r.project, "site");
    }
  } finally {
    await f.cleanup();
  }
});

test("the project is the registry project owning the task's folder, else the folder itself", async () => {
  const f = await world({ registry: { identify: async () => null } });
  try {
    const b = call(f.w, "research_library_find", sample.research_library_find);
    assert.equal((await f.engine.bindResearcher(b, "research_library_find")).project, "dir:/repo/site");
  } finally {
    await f.cleanup();
  }
  const g = await world({ registry: null });
  try {
    const b = call(g.w, "research_library_find", sample.research_library_find);
    assert.equal((await g.engine.bindResearcher(b, "research_library_find")).project, "dir:/repo/site");
  } finally {
    await g.cleanup();
  }
});

test("the Architect (carrying its stamp) is a researcher too, flagged so its extra sources open; without the stamp it is refused", async () => {
  const f = await world({ jobs: [{ id: "job1", childSessionID: "ses_c", parentSessionID: "ses_chat", parentDirectory: "/repo/site", status: "running", specialist: true, agent: "agent-architect", architect: { rootJobId: "job1", attempt: 1, mode: "build" } }] });
  try {
    const b = call(f.w, "research_search", sample.research_search, { agent: "agent-architect" });
    const r = await f.engine.bindResearcher(b, "research_search");
    assert.equal(r.architect, true);
    assert.equal(r.agent, "architect");
    f.w.jobs[0].architect = undefined;
    const b2 = call(f.w, "research_search", sample.research_search, { agent: "agent-architect" });
    assert.match((await f.engine.bindResearcher(b2, "research_search")).refused, /task from Manta/);
  } finally {
    await f.cleanup();
  }
});

test("refusals: a caller that is not an agent package, a job that is not running or not a specialist's, another agent's job, no job, an unknown tool, agent_propose", async () => {
  const f = await world();
  try {
    const refused = async (tool, args, opts, mutate) => {
      const b = call(f.w, tool, args, opts);
      mutate?.();
      const r = await f.engine.bindResearcher(b, tool);
      assert.ok(r.refused, `${tool} ${JSON.stringify(opts ?? {})} should be refused`);
      assert.equal(r.childSessionID, undefined);
      return r.refused;
    };
    const job = f.w.jobs[0];
    await refused("research_fetch", sample.research_fetch, { agent: "build" }); // the default agent
    await refused("research_fetch", sample.research_fetch, { agent: "" });
    await refused("research_fetch", sample.research_fetch, { agent: "agent-dev" }); // the job belongs to agent-seo
    await refused("research_fetch", sample.research_fetch, {}, () => (job.status = "done"));
    job.status = "running";
    await refused("research_fetch", sample.research_fetch, {}, () => (job.specialist = false));
    job.specialist = true;
    await refused("research_fetch", sample.research_fetch, {}, () => (f.w.jobs = []));
    f.w.jobs = [job];
    await refused("agent_propose", { action: "create" });
    await refused("research_nope", {});
    await refused("research_fetch", sample.research_fetch, { status: "completed" }); // not the live call
    await refused("research_fetch", { url: "https://other.example/" }, { input: { url: "https://example.com/" } }); // what the tool posted differs from the running call
    // an unreadable jobs store refuses with a try-again sentence
    const b = call(f.w, "research_fetch", sample.research_fetch);
    f.w.jobs = null;
    assert.match((await f.engine.bindResearcher(b, "research_fetch")).refused, /try again/i);
  } finally {
    await f.cleanup();
  }
});

test("a call can be used once: replaying the same message and call is refused", async () => {
  const f = await world();
  try {
    const b = call(f.w, "research_library_find", sample.research_library_find);
    assert.equal((await f.engine.bindResearcher(b, "research_library_find")).refused, undefined);
    assert.ok((await f.engine.bindResearcher(b, "research_library_find")).refused);
  } finally {
    await f.cleanup();
  }
});

test("the Architect's own binding stays Architect-only: a specialist is refused by bindArchitect", async () => {
  const f = await world();
  try {
    const b = call(f.w, "research_fetch", sample.research_fetch);
    assert.ok((await f.engine.bindArchitect(b, "research_fetch")).refused);
  } finally {
    await f.cleanup();
  }
});

// ---- the guidance in every task prompt ----

async function promptFixture() {
  const base = await mkdtemp(join(tmpdir(), "agents-guidance-"));
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const calls = [];
  let msgs = [];
  const engine = createAgentsEngine({
    root: join(base, "agents"),
    templatesDir,
    home: "/h",
    retryDelayMs: 0,
    isGitRepo: async () => true,
    log: { warn: () => {} },
    editConfig: async () => ({ ok: true, changed: false }),
    reload: async () => ({ ok: true }),
    oc: { readSession: async () => ({ state: "found", session: { id: "ses_chat", directory: "/repo" } }), listMessages: async () => msgs },
    delegate: { startJob: async (i) => (calls.push(i), { ok: true, job: { id: `j${calls.length}` } }), startJobWithApproval: async (i) => (calls.push(i), { ok: true, job: { id: "jw" } }), loadRecordsStrict: async () => [] },
    tmux: { listProjects: async () => [] },
    isManagedSession: async () => false,
    isCtoSessionStrict: async () => false,
    isCtoSession: async () => false,
    delegateView: { assertWritable: async () => {} },
  });
  await engine.init();
  const hand = (agent, k) => {
    const b = { sessionID: "ses_chat", messageID: `msg_h${k}`, callID: `call_h${k}`, agent, title: "Look into it", brief: "Please look into it." };
    msgs = [
      { info: { id: "msg_user", role: "user" }, parts: [] },
      { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent: "build" }, parts: [{ type: "tool", tool: "agent_handoff", callID: b.callID, state: { status: "running", input: { agent: b.agent, title: b.title, brief: b.brief } } }] },
    ];
    return engine.handoff(b);
  };
  return { engine, calls, hand, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("every agent task prompt ends with the research guidance: @mention, handoff, and the Architect's too; the user's request stays first", async () => {
  const f = await promptFixture();
  try {
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "dev", text: "@dev fix the bug" });
    assert.ok(f.calls[0].prompt.startsWith("@dev fix the bug"));
    assert.ok(f.calls[0].prompt.includes(RESEARCH_GUIDANCE.trim()));
    assert.equal(f.calls[0].prompt.split(RESEARCH_GUIDANCE.trim()).length, 2, "exactly once");
    const h = await f.hand("dev", 1);
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.ok(f.calls[1].prompt.startsWith("Please look into it."));
    assert.ok(f.calls[1].prompt.includes(RESEARCH_GUIDANCE.trim()));
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "architect", text: "@architect make an agent" });
    assert.ok(f.calls[2].prompt.includes(RESEARCH_GUIDANCE.trim()));
    assert.ok(f.calls[2].prompt.includes("BEGIN TEAM DATA"), "the Architect's own context is still there");
  } finally {
    await f.cleanup();
  }
});
