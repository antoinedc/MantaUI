// The research library, agents side (docs/superpowers/specs/2026-11-24-research-library.md): who may call the research and
// library tools (`bindResearcher`) and the guidance every agent task prompt gets. A temp folder stands in for ~/.manta/agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine } from "./agents.mjs";
import { createResearchSources } from "./researchSources.mjs";
import { RESEARCH_GUIDANCE } from "./researchLibrary.mjs";
import { BASE_MARKER } from "./researchBlock.mjs";
import { BUILTIN_SOURCES } from "../shared/researchSources.mjs";

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
    assert.match((await f.engine.bindResearcher(b2, "research_search")).refused, /Only Manta and its agents can use this tool/);
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

test("AC-3.3: a task's opening prompt no longer carries a copy of the research guidance (it lives once, in the base block of the agent's prompt): @mention, handoff and the Architect's", async () => {
  const f = await promptFixture();
  try {
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "dev", text: "@dev fix the bug" });
    assert.equal(f.calls[0].prompt.startsWith("@dev fix the bug"), true);
    assert.ok(!f.calls[0].prompt.includes(RESEARCH_GUIDANCE.trim()));
    const h = await f.hand("dev", 1);
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.ok(f.calls[1].prompt.startsWith("Please look into it."));
    assert.ok(!f.calls[1].prompt.includes(RESEARCH_GUIDANCE.trim()));
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "architect", text: "@architect make an agent" });
    assert.ok(!f.calls[2].prompt.includes(RESEARCH_GUIDANCE.trim()));
    assert.ok(f.calls[2].prompt.includes("BEGIN TEAM DATA"), "the Architect's own context is still there");
    assert.ok(!/Extra sources/.test(f.calls[2].prompt), "the Architect's context drops its separate sources line (the base block has the list)");
  } finally {
    await f.cleanup();
  }
});

test("the binding names the task's root (the first round's id) so what the task relied on can be recorded; older records resolve it too", async () => {
  const base = { childSessionID: "ses_c", parentSessionID: "ses_chat", parentDirectory: "/repo/site", status: "running", specialist: true, agent: "agent-seo" };
  const cases = [
    [{ id: "job2", rootJobId: "job1" }, "job1"], // a continuation carries its task's root
    [{ id: "job1" }, "job1"], // an older record: its own id
    [{ id: "job3", architect: { rootJobId: "job0", attempt: 2, mode: "build" }, agent: "agent-seo" }, "job0"], // an older Architect round
  ];
  for (const [over, want] of cases) {
    const f = await world({ jobs: [{ ...base, ...over }] });
    try {
      const b = call(f.w, "research_library_find", sample.research_library_find);
      assert.equal((await f.engine.bindResearcher(b, "research_library_find")).rootJobId, want);
    } finally {
      await f.cleanup();
    }
  }
});

// ---- the base block in every compiled prompt (AC-3.1, AC-3.2), recompiled when the sources change ----

const ROWS = BUILTIN_SOURCES.map((b) => ({ id: b.id, builtin: true, kind: "builtin", enabled: true, private: false, name: b.name, description: b.description }));
const MINE = { id: "bookface", builtin: false, kind: "command", enabled: true, private: true, name: "Bookface (YC) search", description: "YC's private founder forum." };

async function chatWorld({ rows = [MINE, ...ROWS], sessions = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-research-chat-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const w = {
    rows,
    messages: [],
    reloads: 0,
    sessions: {
      ses_lead: { id: "ses_lead", directory: "/repo/site" },
      ses_task: { id: "ses_task", parentID: "ses_lead", directory: "/repo/site" },
      ses_devchat: { id: "ses_devchat", directory: join(root, "dev", "home") },
      ses_routine: { id: "ses_routine", directory: "/repo/site", metadata: { manta: { internal: true } } },
      ...sessions,
    },
  };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    home: "/h",
    retryDelayMs: 0,
    isGitRepo: async () => true,
    log: { warn: () => {} },
    editConfig: async () => ({ ok: true, changed: false }),
    reload: async () => ((w.reloads += 1), { ok: true }),
    oc: { readSession: async (id) => (w.sessions[id] ? { state: "found", session: w.sessions[id] } : { state: "missing" }), listMessages: async () => w.messages },
    delegate: { loadRecordsStrict: async () => [] },
    tmux: { listProjects: async () => [] },
    isManagedSession: async (id) => id === "ses_task",
    isCtoSessionStrict: async () => false,
    isCtoSession: async () => false,
    delegateView: { assertWritable: async () => {} },
    registry: { identify: async (dir) => (dir === "/repo/site" ? { slug: "site" } : null) },
    autonomyPolicy: async () => ({}),
    researchSources: { enabledRows: async () => { if (w.fail) throw Object.assign(new Error("damaged"), { safe: true }); return w.rows.filter((r) => r.enabled); } },
  });
  await engine.init();
  await writeFile(join(root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_devchat" }));
  return { w, root, templatesDir, engine, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const asCall = (w, sessionID, tool, args, agent) => {
  const k = ++n;
  const b = { sessionID, messageID: `msg_${k}`, callID: `call_${k}`, raw: { ...args } };
  w.messages = [
    { info: { id: "msg_user", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent }, parts: [{ type: "tool", tool, callID: b.callID, state: { status: "running", input: args } }] },
  ];
  return b;
};

test("AC-3.1: every agent's compiled prompt carries the base block (marker, sources in priority order, search-first rule, library rules); Manta's agent.md is byte-identical to the template", async () => {
  const f = await chatWorld();
  try {
    for (const slug of ["dev", "architect"]) {
      const compiled = await readFile(join(f.root, slug, ".compiled.md"), "utf-8");
      assert.equal(compiled.split(BASE_MARKER).length, 2, `${slug}: the marker once`);
      assert.ok(compiled.includes(RESEARCH_GUIDANCE.trim()), `${slug}: the library rules`);
      assert.match(compiled, /Search first, then decide/);
      assert.ok(compiled.indexOf("- bookface ") > 0 && compiled.indexOf("- bookface ") < compiled.indexOf("- web (use websearch)"), `${slug}: the user's source first`);
      assert.match(compiled.split("\n").find((l) => l.startsWith("- bookface ")), /private/);
    }
    assert.equal(await readFile(join(f.root, "manta", "agent.md"), "utf-8"), await readFile(join(REAL_TEMPLATES, "manta", "agent.md"), "utf-8"), "Manta's file is not touched");
  } finally {
    await f.cleanup();
  }
});

test("AC-3.2: a user-made agent inherits the block without any research section in its own instructions", async () => {
  const f = await chatWorld();
  try {
    await mkdir(join(f.root, "seo"), { recursive: true });
    await writeFile(join(f.root, "seo", "agent.md"), "---\nname: SEO\ndescription: Improves search ranking.\nisolation: none\n---\nYou are SEO. Audit the page.\n");
    await f.engine.sync();
    const compiled = await readFile(join(f.root, "seo", ".compiled.md"), "utf-8");
    assert.ok(compiled.startsWith("You are SEO. Audit the page."));
    assert.ok(compiled.includes(BASE_MARKER) && compiled.includes(RESEARCH_GUIDANCE.trim()));
    assert.ok(!(await readFile(join(f.root, "seo", "agent.md"), "utf-8")).includes("research"));
  } finally {
    await f.cleanup();
  }
});

test("FR-008: a change to the sources recompiles every agent and reloads the config (no restart); an unchanged list writes nothing", async () => {
  const f = await chatWorld();
  try {
    const before = f.w.reloads;
    await f.engine.sync();
    assert.equal(f.w.reloads, before, "nothing changed, nothing reloaded");
    f.w.rows = [...ROWS.filter((r) => r.id !== "web" && r.id !== "hn")];
    await f.engine.sync();
    assert.ok(f.w.reloads > before);
    const compiled = await readFile(join(f.root, "dev", ".compiled.md"), "utf-8");
    assert.ok(!compiled.includes("- bookface "), "the removed source is gone");
    assert.ok(!/^- hn /m.test(compiled));
    assert.match(compiled, /websearch is turned off/);
  } finally {
    await f.cleanup();
  }
});

test("the lead's brief for a led chat ends with the base block; a chat that is not led gets nothing", async () => {
  const f = await chatWorld();
  try {
    const led = await f.engine.leadBrief("ses_lead");
    assert.equal(led.status, "ok");
    assert.ok(led.text.includes(BASE_MARKER) && led.text.includes("- bookface ") && led.text.includes(RESEARCH_GUIDANCE.trim()));
    assert.deepEqual(await f.engine.leadBrief("ses_task"), { status: "ok", text: "" });
  } finally {
    await f.cleanup();
  }
});

// ---- the binding in chats (AC-2.1 – AC-2.3) ----

test("AC-2.1: Manta leading a chat may call every research and library tool; the project is the chat folder's project", async () => {
  const f = await chatWorld();
  try {
    for (const tool of Object.keys(KEYS)) {
      const r = await f.engine.bindResearcher(asCall(f.w, "ses_lead", tool, sample[tool], "build"), tool);
      assert.equal(r.refused, undefined, `${tool}: ${r.refused}`);
      assert.equal(r.childSessionID, "ses_lead");
      assert.equal(r.agent, "manta");
      assert.equal(r.architect, false);
      assert.equal(r.project, "site");
      assert.equal(r.rootJobId ?? null, null);
    }
    // the plan agent of a led chat too
    assert.equal((await f.engine.bindResearcher(asCall(f.w, "ses_lead", "research_fetch", sample.research_fetch, "plan"), "research_fetch")).refused, undefined);
  } finally {
    await f.cleanup();
  }
});

test("AC-2.2: an agent's own conversation (Team section) may call them too, only as that agent; the Architect has no conversation and stays as it was", async () => {
  const f = await chatWorld();
  try {
    const ok = await f.engine.bindResearcher(asCall(f.w, "ses_devchat", "research_search", sample.research_search, "agent-dev"), "research_search");
    assert.equal(ok.refused, undefined, ok.refused);
    assert.equal(ok.agent, "dev");
    assert.equal(ok.childSessionID, "ses_devchat");
    assert.equal(ok.architect, false);
    // another agent's call inside Dev's conversation is refused
    assert.match((await f.engine.bindResearcher(asCall(f.w, "ses_devchat", "research_search", sample.research_search, "agent-seo"), "research_search")).refused, /Only Manta and its agents/);
    // the Architect's conversation doesn't exist: its folder's chat marker is not read as one
    await writeFile(join(f.root, "architect", ".chat.json"), JSON.stringify({ sessionId: "ses_archchat" }));
    f.w.sessions.ses_archchat = { id: "ses_archchat", directory: join(f.root, "architect", "home") };
    assert.match((await f.engine.bindResearcher(asCall(f.w, "ses_archchat", "research_search", sample.research_search, "agent-architect"), "research_search")).refused, /Only Manta and its agents/);
  } finally {
    await f.cleanup();
  }
});

test("AC-2.3: any other session — a task child that isn't a running job, a routine run, an unknown session, a chat whose state can't be read — is refused with the reworded sentence", async () => {
  const f = await chatWorld();
  try {
    for (const [id, agent] of [["ses_task", "build"], ["ses_routine", "build"], ["ses_nope", "build"], ["ses_lead", ""]]) {
      const r = await f.engine.bindResearcher(asCall(f.w, id, "research_search", sample.research_search, agent), "research_search");
      assert.equal(r.refused, id === "ses_lead" ? undefined : "Only Manta and its agents can use this tool", id);
    }
    // unreadable session state → try again, never a guess
    f.w.sessions = new Proxy({}, { get: () => { throw new Error("down"); } });
    const r = await f.engine.bindResearcher(asCall(f.w, "ses_lead", "research_search", sample.research_search, "build"), "research_search");
    assert.ok(r.refused && r.refused !== "Only Manta and its agents can use this tool", r.refused);
  } finally {
    await f.cleanup();
  }
});

// ---- the migration's two halves in the agents engine (research layer §6.2 steps 1–2) ----

const ARCH_SOURCES = 'sources:\n  - id: bookface\n    name: Bookface (YC) search\n    description: YC private forum.\n    private: false\n    command: [yc, search, "{query}"]\n    env:\n      YC_TOKEN: "{secret:YC_TOKEN}"\n  - id: packages\n    name: My packages\n    description: Our registry.\n    url: "https://reg.example.com/s?q={query}"\n';
async function withArchitectSources(f) {
  const file = join(f.root, "architect", "agent.md");
  const text = await readFile(file, "utf-8");
  await writeFile(file, text.replace(/\n---\n/, `\n${ARCH_SOURCES}---\n`));
  return { file, original: await readFile(file, "utf-8") };
}

test("readArchitectSources returns the RAW sources value (not the parsed one, so a legacy id survives); none when the key or file is missing", async () => {
  const f = await chatWorld();
  try {
    assert.deepEqual(await f.engine.readArchitectSources(), { found: false });
    await withArchitectSources(f);
    const r = await f.engine.readArchitectSources();
    assert.equal(r.found, true);
    assert.deepEqual(r.raw.map((x) => x.id), ["bookface", "packages"]);
    assert.equal(r.raw[0].private, false);
    assert.deepEqual(r.raw[0].command, ["yc", "search", "{query}"]);
    // parsed meta no longer carries sources (the parser stopped reading the key)
    assert.equal((await f.engine.scan()).entries.find((e) => e.slug === "architect").meta.sources, undefined);
    // aliases: unreadable (the file is refused, nothing is guessed)
    const file = join(f.root, "architect", "agent.md");
    await writeFile(file, (await readFile(file, "utf-8")).replace("sources:\n", "sources: &s\n"));
    assert.equal((await f.engine.readArchitectSources()).unreadable, true);
  } finally {
    await f.cleanup();
  }
});

test("stripArchitectSources removes the key as a recorded `migration` change with a snapshot; nothing else in the file moves; a second call is a no-op", async () => {
  const f = await chatWorld();
  try {
    const { file, original } = await withArchitectSources(f);
    const reloads = f.w.reloads;
    await f.engine.stripArchitectSources();
    const after = await readFile(file, "utf-8");
    assert.ok(!/^sources:/m.test(after));
    assert.equal(after, original.replace(ARCH_SOURCES, ""), "only the key is gone, byte for byte");
    const history = await f.engine.history("architect");
    const rec = history.find((r) => r.origin?.kind === "migration");
    assert.ok(rec, JSON.stringify(history.map((r) => r.origin)));
    assert.equal(rec.state, "applied");
    assert.equal(rec.before, original);
    assert.equal(rec.after, after);
    assert.match(rec.summary, /Research sources/);
    assert.ok(f.w.reloads >= reloads, "recompiled");
    const count = (await f.engine.history("architect")).length;
    await f.engine.stripArchitectSources();
    assert.equal((await f.engine.history("architect")).length, count, "no second record");
    // Restore puts the old file back (the version snapshot exists)
    const restored = await f.engine.restore(rec.id);
    assert.equal(restored.state, "applied");
    assert.equal(await readFile(file, "utf-8"), original);
  } finally {
    await f.cleanup();
  }
});

test("agent_change / agent_propose with draft.sources are refused with the Settings sentence (FR-005)", async () => {
  const f = await chatWorld();
  try {
    const refusal = "Research sources are set in Settings → Research sources";
    const r = await f.engine.trialPlan({ action: "update", agent: "dev", draft: { sources: [] }, baseHash: "x" }, { dir: "/t/x" });
    assert.equal(r.error, refusal);
    const { checkDraft } = await import("./agents.mjs");
    assert.deepEqual(checkDraft({ sources: [] }, { create: false }), { error: refusal });
    assert.deepEqual(checkDraft({ name: "N", description: "d", isolation: "none", instructions: "x", sources: [] }, { create: true }), { error: refusal });
  } finally {
    await f.cleanup();
  }
});

// ---- AC-6.1: an existing box converges on update, with no step of the user's ----

test("AC-6.1 / AC-1.1 end to end: on the first boot of this release the store is created, the Architect's sources migrate (private), its key is stripped, every compiled prompt carries them, and a second boot changes nothing", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-research-boot-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const reloads = [];
  const boot = () => {
    let engine;
    const store = createResearchSources({
      file: join(base, "research-sources.json"),
      readArchitectSources: () => engine.readArchitectSources(),
      stripArchitectSources: () => engine.stripArchitectSources(),
      loadSecrets: async () => [],
      onChange: () => engine.sync(),
      log: { warn: () => {} },
    });
    engine = createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      retryDelayMs: 0,
      isGitRepo: async () => true,
      log: { warn: () => {} },
      editConfig: async () => ({ ok: true, changed: false }),
      reload: async () => (reloads.push(1), { ok: true }),
      oc: { readSession: async () => ({ state: "missing" }), listMessages: async () => [] },
      delegate: { loadRecordsStrict: async () => [] },
      tmux: { listProjects: async () => [] },
      researchSources: store,
    });
    return { engine, store, start: async () => { await engine.init(); return store.migrate(); } };
  };
  try {
    // a box that ran the previous release: the Architect's file has its own sources, and nothing is compiled with a base block yet
    const old = boot();
    await old.engine.init();
    const file = join(root, "architect", "agent.md");
    await writeFile(file, (await readFile(file, "utf-8")).replace(/\n---\n/, `\n${ARCH_SOURCES}---\n`));
    const first = boot();
    assert.deepEqual(await first.start(), { state: "done" });
    assert.ok(!/^sources:/m.test(await readFile(file, "utf-8")), "the key is gone from the Architect's file");
    const list = await first.store.list();
    assert.deepEqual(list.sources.slice(0, 2).map((r) => [r.id, r.private, r.addedBy]), [["bookface", true, "migration"], ["packages-mine", true, "migration"]]);
    assert.equal(list.sources.length, 2 + 8);
    for (const slug of ["dev", "architect"]) {
      const compiled = await readFile(join(root, slug, ".compiled.md"), "utf-8");
      assert.ok(compiled.includes(BASE_MARKER), slug);
      assert.match(compiled.split("\n").find((l) => l.startsWith("- bookface ")), /private/, slug);
      assert.ok(compiled.includes("- packages-mine "), slug);
      assert.ok(compiled.includes("- packages (deps.dev)") || compiled.includes("- packages —"), `${slug}: the built-in packages source is there too`);
    }
    // a second boot: nothing imported twice, nothing rewritten, no new reload
    const before = { store: await readFile(join(base, "research-sources.json"), "utf-8"), compiled: await readFile(join(root, "dev", ".compiled.md"), "utf-8"), reloads: reloads.length, changes: (await first.engine.history("architect")).length };
    const second = boot();
    assert.deepEqual(await second.start(), { state: "done" });
    assert.equal(await readFile(join(base, "research-sources.json"), "utf-8"), before.store);
    assert.equal(await readFile(join(root, "dev", ".compiled.md"), "utf-8"), before.compiled);
    assert.equal(reloads.length, before.reloads);
    assert.equal((await second.engine.history("architect")).length, before.changes);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("review: when the sources store can't be read, every compiled prompt says so (not an empty or default list) and recovers when it can", async () => {
  const f = await chatWorld();
  try {
    f.w.fail = true;
    await f.engine.sync();
    for (const slug of ["dev", "architect"]) {
      const compiled = await readFile(join(f.root, slug, ".compiled.md"), "utf-8");
      assert.match(compiled, /research sources couldn't be read/i, slug);
      assert.ok(!compiled.includes("- bookface "), slug);
    }
    const lead = await f.engine.leadBrief("ses_lead");
    assert.match(lead.text, /research sources couldn't be read/i);
    f.w.fail = false;
    await f.engine.sync();
    assert.ok((await readFile(join(f.root, "dev", ".compiled.md"), "utf-8")).includes("- bookface "));
  } finally {
    await f.cleanup();
  }
});
