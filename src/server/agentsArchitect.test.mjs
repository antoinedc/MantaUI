// Agents Phase 5A (docs/superpowers/specs/2026-11-24-agents-phase5-builder.md): the Architect — role, safe snapshot,
// compiled ceiling, extra sources in agent.md. A real temp folder stands in for ~/.manta/agents; the rest are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentsEngine,
  parseAgentMd,
  buildAgentBlock,
  isArchitect,
  buildArchitectContext,
  ARCHITECT_BLOCK_PERMISSION,
  describeProposalOutcome,
} from "./agents.mjs";
import { ARCHITECT_SLUG, isTeamAgent } from "../shared/agentsShared.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const SPECIALIST = "---\nname: Scout\ndescription: Looks things up.\nisolation: none\n---\nYou are Scout.\n";

export async function archFixture({ extra = {}, templates = ["dev", "manta", "architect"] } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-arch-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of templates) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const editConfig = async (fn) => {
    const edits = typeof fn === "function" ? await fn(config.cfg) : fn;
    for (const e of edits) {
      config.edits.push(e);
      const [, key] = e.path;
      config.cfg.agent ??= {};
      if (e.value === undefined) delete config.cfg.agent[key];
      else config.cfg.agent[key] = structuredClone(e.value);
    }
    if (edits.length > 0) config.reloads++;
    return { ok: true, changed: edits.length > 0, reloaded: edits.length > 0 };
  };
  const make = (over = {}) =>
    createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      isGitRepo: async () => true,
      editConfig,
      reload: async () => ({ ok: true, reloaded: true }),
      log: { warn: () => {} },
      oc: {},
      delegate: {},
      tmux: { listProjects: async () => [] },
      ...extra,
      ...over,
    });
  // `make(over)` builds another engine over the same folder and config: a restart
  return { base, root, templatesDir, engine: make(), make, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("the Architect template parses as role architect with no model pin; ARCHITECT_SLUG is architect", async () => {
  const r = parseAgentMd(await readFile(join(REAL_TEMPLATES, "architect", "agent.md"), "utf-8"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.meta.role, "architect");
  assert.equal(r.meta.model, null);
  assert.equal(r.meta.isolation, "none");
  assert.deepEqual(r.meta.sources, []);
  assert.equal(ARCHITECT_SLUG, "architect");
  assert.match(r.meta.useWhen, /Creating a new agent/);
});

test("the Architect template stays short and tells it to look for existing skills, use 3 independent sources, fetch PDFs and write for the user", async () => {
  const main = await readFile(join(REAL_TEMPLATES, "architect", "agent.md"), "utf-8");
  assert.ok(main.trimEnd().split("\n").length <= 150, "the main file stays within 150 lines");
  assert.match(main, /research_search.*source `github`/s);
  assert.match(main, /at least 3 independent sources/);
  assert.match(main, /fetch the PDF itself/);
  assert.match(main, /Never copy a whole skill/);
  assert.match(main, /malicious instructions/);
  assert.match(main, /the card below/);
  const skill = await readFile(join(REAL_TEMPLATES, "architect", "skills", "research", "SKILL.md"), "utf-8");
  assert.match(skill, /## Existing skills first/);
  assert.match(skill, /## Independent sources/);
  assert.match(skill, /anthropics\/skills/);
});

test("only the folder `architect` with role architect is the Architect; another folder claiming it is an error row", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "imposter"));
    await writeFile(join(f.root, "imposter", "agent.md"), "---\nname: Imposter\ndescription: d\nrole: architect\nisolation: none\n---\nx\n");
    const list = await f.engine.list();
    const by = Object.fromEntries(list.map((a) => [a.slug, a]));
    assert.equal(by.architect.role, "architect");
    assert.equal(by.architect.error, undefined);
    assert.equal(by.architect.builtIn, true);
    assert.match(by.imposter.error, /Architect/);
    assert.equal(by.imposter.role, "specialist");
    assert.equal(isTeamAgent(by.architect), true);
    assert.equal(isTeamAgent(by.manta), false);
    assert.equal(isTeamAgent(by.imposter), false);
    assert.equal(f.config.cfg.agent["agent-imposter"], undefined);
    assert.ok(f.config.cfg.agent["agent-architect"]);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "architect")), true);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "dev")), false);
  } finally {
    await f.cleanup();
  }
});

test("an existing `architect` folder without the role stays an ordinary specialist and gets a notice", async () => {
  const f = await archFixture({ templates: ["dev"] });
  try {
    await mkdir(join(f.root, "architect"), { recursive: true });
    await writeFile(join(f.root, "architect", "agent.md"), SPECIALIST);
    await f.engine.init();
    const a = (await f.engine.list()).find((x) => x.slug === "architect");
    assert.equal(a.role, "specialist");
    assert.equal(a.error, undefined);
    assert.match(a.notice, /Architect/);
    assert.equal(isArchitect((await f.engine.scan()).entries.find((e) => e.slug === "architect")), false);
  } finally {
    await f.cleanup();
  }
});

test("the compiled Architect block denies everything first, then allows only the research tools; others keep the old block", () => {
  const dir = "/h/.manta/agents/architect";
  const block = buildAgentBlock({ dir, meta: { description: "D", model: null, role: "architect" }, home: "/h", slug: "architect" });
  const keys = Object.keys(block.permission);
  assert.equal(keys[0], "*");
  assert.equal(block.permission["*"], "deny");
  for (const k of ["read", "glob", "grep", "list", "websearch", "todowrite", "progress_report", "research_fetch", "research_read", "research_search", "agent_propose"]) {
    assert.equal(block.permission[k], "allow", k);
  }
  for (const k of ["bash", "edit", "write", "webfetch", "patch"]) assert.ok(!keys.includes(k) || block.permission[k] === "deny", k);
  assert.deepEqual(Object.keys(block.permission.external_directory), [`${dir}/**`, "/h/.local/share/opencode/tool-output/*"]);
  assert.deepEqual(ARCHITECT_BLOCK_PERMISSION("/x", "/h")["*"], "deny");
  // an ordinary agent is unchanged
  assert.deepEqual(buildAgentBlock({ dir, meta: { description: "D", model: null, role: "specialist" } }).permission, { external_directory: { [`${dir}/**`]: "allow" } });
});

test("sync rewrites a block whose permission rules are only reordered (rule order is meaning)", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const block = structuredClone(f.config.cfg.agent["agent-architect"]);
    const { "*": star, ...rest } = block.permission;
    f.config.cfg.agent["agent-architect"] = { ...block, permission: { ...rest, "*": star } }; // same rules, catch-all moved last
    const before = f.config.edits.length;
    await f.engine.sync();
    assert.equal(f.config.edits.length, before + 1, "rewritten");
    assert.equal(Object.keys(f.config.cfg.agent["agent-architect"].permission)[0], "*");
    // but a different key order OUTSIDE permission is still the same block
    const again = structuredClone(f.config.cfg.agent["agent-architect"]);
    f.config.cfg.agent["agent-architect"] = Object.fromEntries(Object.entries(again).reverse());
    const n = f.config.edits.length;
    await f.engine.sync();
    assert.equal(f.config.edits.length, n, "not rewritten");
  } finally {
    await f.cleanup();
  }
});

test("readAgentSnapshot: bytes + a 12-hex hash from one handle; a symlinked file or folder is never read", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const snap = await f.engine.readAgentSnapshot("dev");
    assert.equal(snap.text, await readFile(join(f.root, "dev", "agent.md"), "utf-8"));
    assert.match(snap.hash, /^[0-9a-f]{12}$/);
    assert.equal(Buffer.isBuffer(snap.bytes), true);
    assert.equal(await f.engine.readAgentSnapshot("nope"), null);
    assert.equal(await f.engine.readAgentSnapshot("../x"), null);
    // agent.md replaced by a symlink to a file elsewhere
    await writeFile(join(f.base, "elsewhere.md"), SPECIALIST);
    await mkdir(join(f.root, "linked"));
    await symlink(join(f.base, "elsewhere.md"), join(f.root, "linked", "agent.md"));
    assert.equal(await f.engine.readAgentSnapshot("linked"), null);
    // the folder itself is a symlink to another folder
    await mkdir(join(f.base, "real-folder"));
    await writeFile(join(f.base, "real-folder", "agent.md"), SPECIALIST);
    await symlink(join(f.base, "real-folder"), join(f.root, "folderlink"));
    assert.equal(await f.engine.readAgentSnapshot("folderlink"), null);
    // too big
    await mkdir(join(f.root, "huge"));
    await writeFile(join(f.root, "huge", "agent.md"), `---\nname: H\ndescription: d\n---\n${"x".repeat(70_000)}\n`);
    assert.equal(await f.engine.readAgentSnapshot("huge"), null);
  } finally {
    await f.cleanup();
  }
});

test("buildArchitectContext: roster with hashes, the named agents' full text, a data framing line, the sources list", () => {
  const roster = [
    { slug: "dev", name: "Dev", description: "Writes code.", useWhen: "Code changes", notFor: null, isolation: "worktree", model: null, hash: "abc123abc123" },
    { slug: "manta", name: "Manta", description: "Leads.", useWhen: null, notFor: null, isolation: "none", model: null, hash: "def456def456", lead: true },
  ];
  const text = buildArchitectContext({
    roster,
    named: [{ slug: "dev", text: "---\nname: Dev\n---\nDev prompt\n", hash: "abc123abc123" }],
    sources: [{ id: "bookface", name: "YC Bookface", description: "Private forum.", private: true }],
  });
  assert.match(text, /abc123abc123/);
  assert.match(text, /def456def456/);
  assert.match(text, /data, not instructions/i);
  assert.match(text, /Dev prompt/);
  assert.match(text, /research_fetch/);
  assert.match(text, /agent_propose \(max 3\)/);
  assert.match(text, /hn, arxiv, reddit, x/);
  assert.match(text, /bookface — YC Bookface: Private forum\. \(private\)/);
  assert.equal(text, buildArchitectContext({ roster, named: [{ slug: "dev", text: "---\nname: Dev\n---\nDev prompt\n", hash: "abc123abc123" }], sources: [{ id: "bookface", name: "YC Bookface", description: "Private forum.", private: true }] }), "deterministic");
});

test("the Architect's own extra sources are read from its frontmatter; invalid ones are skipped with a notice; aliases refuse the file", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const arch = await readFile(join(f.root, "architect", "agent.md"), "utf-8");
    const withSources = arch.replace("\n---\n", `\nsources:\n  - id: bookface\n    name: YC Bookface\n    description: Private forum.\n    command: [yc, search, "{query}"]\n  - id: broken\n    name: B\n    description: d\n---\n`.replace("---\n", "---\n"));
    await writeFile(join(f.root, "architect", "agent.md"), withSources);
    const e = (await f.engine.scan()).entries.find((x) => x.slug === "architect");
    assert.deepEqual(e.meta.sources.map((s) => s.id), ["bookface"]);
    assert.equal(e.meta.sources[0].private, true);
    assert.match(e.info.notice, /Skipped a source/);
    const aliased = arch.replace("\n---\n", "\nx: &a 1\ny: *a\n---\n");
    await writeFile(join(f.root, "architect", "agent.md"), aliased);
    const row = (await f.engine.list()).find((x) => x.slug === "architect");
    assert.match(row.error, /anchors or aliases/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the Architect's tasks: stamps, binding, agent_propose, release, crash recovery
// ---------------------------------------------------------------------------
import { readdir, stat, access, mkdir as mkdir2 } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { MODES } from "../shared/autonomyShared.mjs";

const ok = async (p) => access(p).then(() => true, () => false);
const AGENT_KEY = "agent-architect";
const QUOTE = "Short, specific rules beat long generic checklists every time";
const SOURCE_TEXT = `Intro line. ${QUOTE}, according to the study.\n\nMore   text\nhere.`;

// a world: the Architect's running job, the transcript of its running tool call, stored sources, the jobs store, the policy
async function proposeFixture({ level = "auto", extra = {}, templates } = {}) {
  const w = {
    level,
    policyThrows: false,
    jobs: [{ id: "job1", childSessionID: "ses_child", parentSessionID: "ses_chat", status: "running", attempt: 1, architect: { rootJobId: "job1", attempt: 1, mode: "build" } }],
    jobsThrow: false,
    messages: [],
    agent: AGENT_KEY,
    clock: 1_700_000_000_000,
    pubs: [],
    sources: { "ses_child:src_a": { text: SOURCE_TEXT, url: "https://example.com/a", finalUrl: "https://example.com/a?x=1", private: false }, "ses_child:src_priv": { text: SOURCE_TEXT, url: null, private: true } },
    approved: ["anthropic/claude-sonnet-5-5"],
  };
  const f = await archFixture({
    templates,
    extra: {
      retryDelayMs: 0,
      now: () => w.clock,
      autonomyPolicy: async () => {
        if (w.policyThrows) throw new Error("config.json unreadable");
        return { ...MODES.balanced, agent_change: w.level };
      },
      listApprovedModels: async () => w.approved,
      publish: (p) => w.pubs.push(p),
      oc: { listMessages: async () => w.messages },
      delegate: {
        loadRecordsStrict: async () => {
          if (w.jobsThrow) throw new Error("jobs store unreadable");
          return w.jobs;
        },
      },
      research: { getSource: async (child, id) => w.sources[`${child}:${id}`] ?? null },
      loadSecretsStrict: async () => [],
      createScanner: () => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) }),
      ...extra,
    },
  });
  await f.engine.init();
  return { ...f, w };
}

let seq = 0;
const DRAFT_UPDATE = { instructions: "You write code.\nYou always run the tests." };
const proposeBody = (over = {}) => {
  const n = ++seq;
  return {
    sessionID: "ses_child",
    messageID: `msg_p${n}`,
    callID: `call_p${n}`,
    action: "update",
    agent: "dev",
    draft: { ...DRAFT_UPDATE },
    summary: "Tighten Dev's rules.",
    evidence: [{ sourceId: "src_a", quote: QUOTE, claim: "Short specific rules help" }],
    admission: [{ rule: "Run the tests", verdict: "general", why: "Backed by the study" }],
    baseHash: "SET",
    ...over,
  };
};
const proposeTranscript = (b, { agent = AGENT_KEY, status = "running", input } = {}) => {
  const given = input ?? Object.fromEntries(["action", "draft", "summary", "evidence", "admission", "agent", "baseHash"].filter((k) => Object.hasOwn(b, k)).map((k) => [k, b[k]]));
  return [
    { info: { id: "msg_user", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user", ...(agent === null ? {} : { agent }) }, parts: [{ type: "tool", tool: "agent_propose", callID: b.callID, state: { status, input: given } }] },
  ];
};
const propose = async (f, over = {}, tOver) => {
  const hash = (await f.engine.readAgentSnapshot("dev")).hash;
  const b = proposeBody({ ...over, ...(over.baseHash === undefined || over.baseHash === "SET" ? { baseHash: hash } : {}) });
  if (over.baseHash === null) delete b.baseHash;
  f.w.messages = proposeTranscript(b, tOver);
  return f.engine.propose(b);
};
const store = async (f) => JSON.parse(await readFile(join(f.root, ".changes.json"), "utf-8"));

test("a handoff to the Architect stamps the job with its round mode; mention = unknown; a specialist named architect gets no stamp", async () => {
  const calls = [];
  const f = await archFixture({
    extra: {
      retryDelayMs: 0,
      oc: {
        readSession: async () => ({ state: "found", session: { id: "ses_chat", directory: "/repo" } }),
        listMessages: async () => msgs,
      },
      delegate: { startJob: async (i) => (calls.push(i), { ok: true, job: { id: `j${calls.length}` } }), startJobWithApproval: async (i) => (calls.push(i), { ok: true, job: { id: "jw" } }), loadRecordsStrict: async () => [] },
      isManagedSession: async () => false,
      isCtoSessionStrict: async () => false,
      isCtoSession: async () => false,
      delegateView: { assertWritable: async () => {} },
    },
  });
  let msgs = [];
  try {
    await f.engine.init();
    const hand = (agentName, n) => {
      const b = { sessionID: "ses_chat", messageID: `msg_h${n}`, callID: `call_h${n}`, agent: "architect", title: "Build an SEO agent", brief: "Make an SEO agent. Charter: reads, never edits. @dev exists." };
      msgs = [
        { info: { id: "msg_user", role: "user" }, parts: [] },
        { info: { id: b.messageID, role: "assistant", parentID: "msg_user", ...(agentName === null ? {} : { agent: agentName }) }, parts: [{ type: "tool", tool: "agent_handoff", callID: b.callID, state: { status: "running", input: { agent: b.agent, title: b.title, brief: b.brief } } }] },
      ];
      return f.engine.handoff(b);
    };
    assert.equal((await hand("build", 1)).ok, true);
    assert.deepEqual(calls[0].architect, { mode: "build" });
    assert.match(calls[0].prompt, /BEGIN TEAM DATA/);
    assert.match(calls[0].prompt, /Current file of @dev/);
    assert.equal(calls[0].agent, AGENT_KEY);
    assert.equal(calls[0].isolation, "none");
    assert.equal((await hand("manta-plan", 2)).ok, true);
    assert.deepEqual(calls[1].architect, { mode: "plan" });
    assert.equal((await hand(null, 3)).ok, true);
    assert.deepEqual(calls[2].architect, { mode: "unknown" });
    // a user's @mention is never a build hand-off
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "architect", text: "@architect make an agent" });
    assert.deepEqual(calls[3].architect, { mode: "unknown" });
    // a specialist that merely lives in a folder named architect (no role) gets no stamp
    await writeFile(join(f.root, "architect", "agent.md"), SPECIALIST);
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "architect", text: "@architect do it" });
    assert.equal(Object.hasOwn(calls[4], "architect"), false);
    // dev gets none either
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/repo", slug: "dev", text: "@dev fix it" });
    assert.equal(Object.hasOwn(calls[5], "architect"), false);
  } finally {
    await f.cleanup();
  }
});

test("openChat refuses the Architect; routineAgent answers with a refusal sentence, never a fallback", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await assert.rejects(f.engine.openChat({ slug: "architect" }), /The Architect works through tasks; ask Manta/);
    const r = await f.engine.routineAgent("architect", "/repo");
    assert.equal(r.refused, "The Architect can't run routines yet");
    assert.equal(r.key, undefined);
    assert.ok((await f.engine.routineAgent("dev", "")).key);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose: a valid update is held — nothing written; slot, origin, evidence and the invocation saved together", async () => {
  const f = await proposeFixture();
  try {
    const devBefore = await readFile(join(f.root, "dev", "agent.md"), "utf-8");
    const r = await propose(f);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.used, 1);
    const c = r.change;
    assert.equal(c.state, "held");
    assert.equal(c.kind, "update");
    assert.equal(c.slug, "dev");
    assert.equal(c.sessionID, "ses_chat", "the job's parent chat");
    assert.equal(c.messageID, "");
    assert.deepEqual(c.origin, { kind: "job", jobId: "job1", rootJobId: "job1", attempt: 1 });
    assert.equal(c.mode, "build");
    assert.equal(c.summary, "Tighten Dev's rules.");
    assert.deepEqual(c.evidence, [{ claim: "Short specific rules help", quote: QUOTE, url: "https://example.com/a?x=1", private: false }]);
    assert.equal(c.admission[0].verdict, "general");
    assert.equal(c.needsClick, false);
    assert.equal(c.before, devBefore);
    assert.match(c.after, /always run the tests/);
    assert.equal(Object.hasOwn(c, "invocation"), false, "journal bookkeeping stays on the box");
    assert.equal(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), devBefore, "held = nothing written");
    const doc = await store(f);
    assert.deepEqual(doc.proposalSlots, { job1: 1 });
    assert.equal(doc.changes.length, 1);
    assert.equal(doc.changes[0].invocation.childSessionID, "ses_child");
    assert.deepEqual(f.w.pubs.at(-1).origin, { kind: "job", jobId: "job1", rootJobId: "job1", attempt: 1 });
    assert.deepEqual((await f.engine.changesForJob("job1")).map((x) => x.id), [c.id]);
    assert.deepEqual(await f.engine.changesForJob("nope"), []);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose binding: wrong agent, unstamped job, terminal job, another session, changed arguments, replay — all refused before any record", async () => {
  const f = await proposeFixture();
  try {
    const refusedWith = async (re, over, t) => {
      const r = await propose(f, over, t);
      assert.equal(r.ok, false);
      assert.match(r.error, re);
    };
    await refusedWith(/Only the Architect/, {}, { agent: "build" }); // the model isn't the Architect
    await refusedWith(/Only the Architect/, {}, { agent: null });
    await refusedWith(/Only the Architect/, {}, { status: "completed" }); // not the live call
    await refusedWith(/Only the Architect/, {}, { input: { action: "update", agent: "dev" } }); // arguments differ from what was posted
    f.w.jobs = [{ ...f.w.jobs[0], architect: undefined }]; // an unstamped job
    await refusedWith(/Only the Architect/);
    f.w.jobs = [{ ...f.w.jobs[0], architect: { rootJobId: "job1", attempt: 1, mode: "build" }, status: "done" }]; // a terminal job
    await refusedWith(/Only the Architect/);
    f.w.jobs = [{ id: "job1", childSessionID: "ses_other", parentSessionID: "ses_chat", status: "running", attempt: 1, architect: { rootJobId: "job1", attempt: 1, mode: "build" } }];
    await refusedWith(/Only the Architect/); // the calling session is not that job's child
    f.w.jobsThrow = true;
    await refusedWith(/Couldn't check this task/);
    f.w.jobsThrow = false;
    assert.deepEqual((await store(f).catch(() => ({ changes: [] }))).changes, []);
    // a replay of one live call: the first works, the second (same message and call) returns the original without a new slot
    f.w.jobs = [{ id: "job1", childSessionID: "ses_child", parentSessionID: "ses_chat", status: "running", attempt: 1, architect: { rootJobId: "job1", attempt: 1, mode: "build" } }];
    const hash = (await f.engine.readAgentSnapshot("dev")).hash;
    const b = proposeBody({ baseHash: hash });
    f.w.messages = proposeTranscript(b);
    const first = await f.engine.propose(b);
    assert.equal(first.ok, true, first.error);
    const again = await f.engine.propose(b);
    assert.equal(again.ok, true);
    assert.equal(again.replay, true);
    assert.equal(again.change.id, first.change.id);
    assert.deepEqual((await store(f)).proposalSlots, { job1: 1 });
    // the same invocation with other arguments is refused, not answered with the record
    const other = await f.engine.propose({ ...b, summary: "different" });
    assert.equal(other.ok, false);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose evidence: none, too short, a quote that isn't in its source, a source from another session; whitespace is ignored, case is not", async () => {
  const f = await proposeFixture();
  try {
    const bad = async (over, re) => {
      const r = await propose(f, over);
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.match(r.error, re);
    };
    await bad({ evidence: [] }, /1 to 12 evidence/);
    await bad({ evidence: [{ sourceId: "src_a", quote: "too short", claim: "c" }] }, /20 to 300/);
    await bad({ evidence: [{ sourceId: "src_a", quote: "This sentence is definitely not in the page", claim: "c" }] }, /doesn't occur/);
    await bad({ evidence: [{ sourceId: "src_other", quote: QUOTE, claim: "c" }] }, /wasn't fetched in this task/);
    await bad({ evidence: [{ sourceId: "src_a", quote: QUOTE.toUpperCase(), claim: "c" }] }, /doesn't occur/);
    await bad({ summary: "" }, /summary/);
    await bad({ admission: [{ rule: "r", verdict: "maybe", why: "w" }] }, /verdict/);
    const spaced = await propose(f, { evidence: [{ sourceId: "src_a", quote: `Short,   specific rules beat long\n generic checklists every time`, claim: "ws" }] });
    assert.equal(spaced.ok, true, spaced.error);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose: a private source's quote and URL are never stored — only the claim", async () => {
  const f = await proposeFixture();
  try {
    const r = await propose(f, { evidence: [{ sourceId: "src_priv", quote: QUOTE, claim: "A founder said short rules win" }] });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.change.evidence, [{ claim: "A founder said short rules win", quote: null, url: null, private: true }]);
    const raw = await readFile(join(f.root, ".changes.json"), "utf-8");
    assert.ok(!raw.includes(QUOTE), "the quote is nowhere in the store");
  } finally {
    await f.cleanup();
  }
});

test("agent_propose: three per root task, counted across continuations; a fourth is refused; slots survive in the store", async () => {
  const f = await proposeFixture();
  try {
    for (let i = 0; i < 3; i++) {
      // each proposal is a different edit; the second and third come from a CONTINUATION (a new job id, same root)
      if (i === 1) f.w.jobs = [{ id: "job2", childSessionID: "ses_child", parentSessionID: "ses_chat", status: "running", attempt: 2, continues: "job1", architect: { rootJobId: "job1", attempt: 2, mode: "build" } }];
      const r = await propose(f, { draft: { instructions: `Version ${i}.\nAlways test.` } });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.used, i + 1);
    }
    const fourth = await propose(f, { draft: { instructions: "Version 4." } });
    assert.equal(fourth.ok, false);
    assert.match(fourth.error, /3 proposals/);
    assert.deepEqual((await store(f)).proposalSlots, { job1: 3 });
    assert.equal((await store(f)).changes.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose: an update needs the baseHash; a stale one is refused with the CURRENT text and hash from the safe snapshot", async () => {
  const f = await proposeFixture();
  try {
    const snap = await f.engine.readAgentSnapshot("dev");
    const missing = await propose(f, { baseHash: null });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /baseHash/);
    const stale = await propose(f, { baseHash: "000000000000" });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /changed since you read it/);
    assert.deepEqual(stale.current, { text: snap.text, hash: snap.hash });
    assert.equal((await store(f).catch(() => ({ proposalSlots: {} }))).proposalSlots?.job1 ?? 0, 0, "no slot used by a refusal");
  } finally {
    await f.cleanup();
  }
});

test("agent_propose create: held, kind create, the same checks as agent_change (reserved name, unapproved model)", async () => {
  const f = await proposeFixture();
  try {
    const draft = { name: "SEO Reviewer", description: "Reviews SEO.", isolation: "none", instructions: "You review SEO.\nYou never edit." };
    const r = await propose(f, { action: "create", draft, agent: undefined, baseHash: null });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.change.kind, "create");
    assert.equal(r.change.slug, null);
    assert.equal(r.change.before, null);
    const reserved = await propose(f, { action: "create", draft: { ...draft, name: "Build" }, agent: undefined, baseHash: null });
    assert.match(reserved.error, /reserved/);
    const model = await propose(f, { action: "create", draft: { ...draft, name: "Other", model: "x/y" }, agent: undefined, baseHash: null });
    assert.match(model.error, /approved model/);
  } finally {
    await f.cleanup();
  }
});

test("agent_propose refuses `sources`; agent_change accepts them only on an update of the Architect (and then it needs a click)", async () => {
  const f = await proposeFixture();
  try {
    const src = { id: "bookface", name: "YC Bookface", description: "Private forum.", command: ["yc", "search", "{query}"] };
    const r = await propose(f, { draft: { instructions: "x", sources: [src] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /can't change the Architect's sources/);
    const archHash = (await f.engine.readAgentSnapshot("architect")).hash;
    const r2 = await propose(f, { agent: "architect", baseHash: archHash, draft: { sources: [src] } });
    assert.match(r2.error, /sources/);
  } finally {
    await f.cleanup();
  }
});

// ---- release ----

const heldFor = async (f, over = {}) => {
  const r = await propose(f, over);
  assert.equal(r.ok, true, r.error);
  return r.change.id;
};
const rec = async (f, id) => (await store(f)).changes.find((r) => r.id === id);
const endJob = (f, over) => {
  f.w.jobs = [{ ...f.w.jobs[0], ...over }];
};

test("release precedence 1–2: a running or paused round of the same attempt stays held; an unreadable jobs store or policy stays held", async () => {
  const f = await proposeFixture();
  try {
    const id = await heldFor(f);
    for (const status of ["running", "paused"]) {
      endJob(f, { status });
      await f.engine.reconcile();
      assert.equal((await rec(f, id)).state, "held", status);
    }
    endJob(f, { status: "done" });
    f.w.jobsThrow = true;
    await f.engine.reconcile();
    assert.equal((await rec(f, id)).state, "held", "unreadable jobs store");
    f.w.jobsThrow = false;
    f.w.policyThrows = true;
    await f.engine.reconcile();
    assert.equal((await rec(f, id)).state, "held", "unreadable policy");
    f.w.policyThrows = false;
    await f.engine.reconcile();
    assert.equal((await rec(f, id)).state, "applied");
  } finally {
    await f.cleanup();
  }
});

test("release precedence 3–4: Never discards (even an unfinished round); a round that didn't end cleanly waits for a click", async () => {
  for (const [name, over, want] of [
    ["failed", { status: "failed" }, "unfinished"],
    ["stopped", { status: "stopped" }, "unfinished"],
    ["done but asking a question", { status: "done", endedBlocked: true }, "unfinished"],
    ["a later round replaced it (resume), even though that one succeeded", { status: "done", attempt: 2 }, "unfinished"],
    ["a later round is running", { status: "running", attempt: 2 }, "unfinished"],
  ]) {
    const f = await proposeFixture();
    try {
      const id = await heldFor(f);
      endJob(f, over);
      await f.engine.reconcile();
      const r = await rec(f, id);
      assert.equal(r.state, "pending", name);
      assert.equal(r.reason, want, name);
      assert.equal(r.needsClick, true);
      assert.equal(r.releasedAt, f.w.clock, "the click window starts at release");
    } finally {
      await f.cleanup();
    }
  }
  // a job missing from a READABLE store → unfinished; Never beats it
  const f = await proposeFixture();
  try {
    const id = await heldFor(f);
    f.w.jobs = [];
    await f.engine.reconcile();
    assert.equal((await rec(f, id)).reason, "unfinished");
  } finally {
    await f.cleanup();
  }
  const g = await proposeFixture({ level: "never" });
  try {
    const id = await heldFor(g);
    endJob(g, { status: "failed" });
    await g.engine.reconcile();
    const r = await rec(g, id);
    assert.equal(r.state, "discarded");
    assert.match(r.error, /turned off in your autonomy settings/);
  } finally {
    await g.cleanup();
  }
});

test("release precedence 5–7: plan / unknown rounds, power changes and Ask wait for a click, each with its reason", async () => {
  const cases = [
    ["plan mode", { stamp: { mode: "plan" } }, "plan"],
    ["unknown mode", { stamp: { mode: "unknown" } }, "plan"],
    ["Ask", { level: "ask" }, "ask"],
  ];
  for (const [name, o, want] of cases) {
    const f = await proposeFixture({ level: o.level ?? "auto" });
    try {
      if (o.stamp) f.w.jobs = [{ ...f.w.jobs[0], architect: { rootJobId: "job1", attempt: 1, ...o.stamp } }];
      const id = await heldFor(f);
      endJob(f, { status: "done" });
      await f.engine.reconcile();
      const r = await rec(f, id);
      assert.equal(r.state, "pending", name);
      assert.equal(r.reason, want, name);
    } finally {
      await f.cleanup();
    }
  }
  // the lead / the Architect itself / an agent turned into one that edits code
  const f = await proposeFixture();
  try {
    const archHash = (await f.engine.readAgentSnapshot("architect")).hash;
    const core = await propose(f, { agent: "architect", baseHash: archHash, draft: { description: "Builds agents from research, carefully." } });
    assert.equal(core.ok, true, core.error);
    const lead = await propose(f, { agent: "manta", baseHash: (await f.engine.readAgentSnapshot("manta")).hash, draft: { description: "Leads the chat, well." } });
    assert.equal(lead.ok, true, lead.error);
    // Scout is read-only; make it edit code
    await mkdir(join(f.root, "scout"));
    await writeFile(join(f.root, "scout", "agent.md"), SPECIALIST);
    await f.engine.sync();
    const iso = await propose(f, { agent: "scout", baseHash: (await f.engine.readAgentSnapshot("scout")).hash, draft: { isolation: "worktree" } });
    assert.equal(iso.ok, true, iso.error);
    endJob(f, { status: "done" });
    await f.engine.reconcile();
    assert.equal((await rec(f, core.change.id)).reason, "core");
    assert.equal((await rec(f, lead.change.id)).reason, "lead");
    assert.equal((await rec(f, iso.change.id)).reason, "isolation");
  } finally {
    await f.cleanup();
  }
});

test("release precedence 8: Auto and Tell me apply — the file, the config, decidedBy auto, the proposal's hint; a second release is a no-op", async () => {
  for (const level of ["auto", "tell"]) {
    const f = await proposeFixture({ level });
    try {
      const id = await heldFor(f);
      endJob(f, { status: "done" });
      await f.engine.reconcile();
      const r = await rec(f, id);
      assert.equal(r.state, "applied", r.error);
      assert.equal(r.decidedBy, "auto");
      assert.match(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), /always run the tests/);
      const published = f.w.pubs.filter((p) => p.id === id).length;
      await f.engine.reconcile();
      assert.equal(f.w.pubs.filter((p) => p.id === id).length, published, "idempotent: nothing new");
      assert.deepEqual((await store(f)).proposalSlots, { job1: 1 }, "kept while the jobs store still holds the root");
      f.w.jobs = [];
      await f.engine.reconcile();
      assert.deepEqual((await store(f)).proposalSlots, {}, "dropped once the jobs store holds no record carrying the root");
    } finally {
      await f.cleanup();
    }
  }
});

test("Outcome line: applied automatically says it is live with the user's setting and that undo is on the card", async () => {
  for (const [level, title] of [["auto", "Auto"], ["tell", "Tell me"]]) {
    const f = await proposeFixture({ level });
    try {
      await heldFor(f);
      endJob(f, { status: "done" });
      await f.engine.reconcile();
      const lines = await f.engine.outcomeLinesForJob("job1");
      assert.deepEqual(lines, [`Outcome: @dev was updated and is live (your setting: ${title}). Undo is on the card.`]);
    } finally {
      await f.cleanup();
    }
  }
});

test("Outcome line: a create names the new agent; pending says it waits for a click and why; Never says it was discarded", async () => {
  const f = await proposeFixture({ level: "ask" });
  try {
    await heldFor(f);
    endJob(f, { status: "done" });
    await f.engine.reconcile();
    assert.deepEqual(await f.engine.outcomeLinesForJob("job1"), ["Outcome: @dev is waiting for your click on the card (reason: your setting for changing agents is Ask)."]);
  } finally {
    await f.cleanup();
  }
  const g = await proposeFixture();
  try {
    await heldFor(g);
    endJob(g, { status: "failed" });
    await g.engine.reconcile();
    assert.deepEqual(await g.engine.outcomeLinesForJob("job1"), ["Outcome: @dev is waiting for your click on the card (reason: the task didn't finish cleanly)."]);
  } finally {
    await g.cleanup();
  }
  const h = await proposeFixture({ level: "never" });
  try {
    await heldFor(h);
    endJob(h, { status: "done" });
    await h.engine.reconcile();
    assert.deepEqual(await h.engine.outcomeLinesForJob("job1"), ["Outcome: @dev was discarded — changing agents is turned off."]);
  } finally {
    await h.cleanup();
  }
  const i = await proposeFixture();
  try {
    await heldFor(i);
    assert.deepEqual(await i.engine.outcomeLinesForJob("job1"), ["Outcome: @dev has not been released yet; trust the card, not this message."], "still held");
    assert.deepEqual(await i.engine.outcomeLinesForJob("nope"), []);
  } finally {
    await i.cleanup();
  }
});

test("describeProposalOutcome: every pending reason, a failed write, a create, a click-applied change", () => {
  const base = { slug: "cro", kind: "update", state: "pending", reason: "ask", error: null, decidedBy: null };
  const d = (over, level = "tell") => describeProposalOutcome({ ...base, ...over }, level);
  assert.match(d({ reason: "plan" }), /waiting for your click on the card \(reason: it was proposed in plan mode\)/);
  assert.match(d({ reason: "lead" }), /reason: it changes the lead agent/);
  assert.match(d({ reason: "core" }), /reason: it changes the Architect itself/);
  assert.match(d({ reason: "isolation" }), /reason: it widens what the agent may touch/);
  assert.match(d({ reason: "ask", error: "disk full" }), /couldn't be written \(disk full\); retry it from the card/);
  assert.equal(d({ state: "applied", kind: "create", slug: "cro", decidedBy: "auto" }), "Outcome: @cro was created and is live (your setting: Tell me). Undo is on the card.");
  assert.equal(d({ state: "applied", decidedBy: "click" }), "Outcome: @cro was updated and is live (you approved it). Undo is on the card.");
  assert.equal(d({ state: "undone" }), "Outcome: @cro was undone.");
  assert.equal(d({ state: "expired" }), "Outcome: @cro expired before anyone clicked; it was not applied.");
  assert.match(d({ kind: "create", slug: null, agentName: "CRO Helper", state: "discarded" }), /^Outcome: CRO Helper was discarded/);
});

test("release: a click on a pending proposal applies it as `click`; the window runs from release, not creation", async () => {
  const f = await proposeFixture({ level: "ask" });
  try {
    const id = await heldFor(f);
    f.w.clock += 5 * 60 * 60 * 1000; // the task ran for hours
    endJob(f, { status: "done" });
    await f.engine.reconcile();
    f.w.clock += 23 * 60 * 60 * 1000; // 23 h after release, 28 h after creation: still clickable
    const applied = await f.engine.apply(id);
    assert.equal(applied.state, "applied", applied.error);
    assert.equal(applied.decidedBy, "click");
    f.w.clock += 2 * 24 * 60 * 60 * 1000;
    assert.equal((await f.engine.apply(id)).state, "applied", "a second click changes nothing");
  } finally {
    await f.cleanup();
  }
});

test("a held record is not applied, discarded or expired by a click or by time", async () => {
  const f = await proposeFixture();
  try {
    const id = await heldFor(f);
    f.w.clock += 3 * 24 * 60 * 60 * 1000;
    assert.equal((await f.engine.apply(id)).state, "held");
    assert.equal((await f.engine.discard(id)).state, "held");
    assert.equal((await rec(f, id)).state, "held");
  } finally {
    await f.cleanup();
  }
});

test("held and applying records are never evicted by the store cap", async () => {
  const f = await proposeFixture();
  try {
    const id = await heldFor(f);
    const doc = await store(f);
    const filler = Array.from({ length: 260 }, (_, i) => ({ ...doc.changes[0], id: `fill${i}`, state: "pending", invocation: undefined, createdAt: f.w.clock - 1000 + i, releasedAt: f.w.clock }));
    filler.push({ ...doc.changes[0], id: "applying1", state: "applying", invocation: undefined, createdAt: 1 });
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes: [...doc.changes, ...filler], proposalSlots: doc.proposalSlots }));
    await f.engine.discard("fill0"); // any save prunes
    const after = (await store(f)).changes;
    assert.ok(after.some((r) => r.id === id && r.state === "held"));
    assert.ok(after.some((r) => r.id === "applying1" && r.state === "applying"));
    assert.ok(after.length <= 262);
  } finally {
    await f.cleanup();
  }
});

test("old records (before 5A) read as chat-origin, mode null, released at creation, no summary; an unreadable store refuses every mutation and touches nothing", async () => {
  const f = await proposeFixture();
  try {
    const old = { id: "ach_old", kind: "update", slug: "dev", agentName: "Dev", sessionID: "ses_chat", messageID: "m", callID: "c", state: "pending", needsClick: true, reason: "ask", before: "a", after: "b", createdAt: f.w.clock, decidedAt: null, error: null };
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 1, changes: [old] }));
    const got = await f.engine.forCall({ sessionID: "ses_chat", messageID: "m", callID: "c" });
    assert.deepEqual(got.origin, { kind: "chat" });
    assert.equal(got.mode, null);
    assert.equal(got.releasedAt, f.w.clock);
    assert.equal(got.summary, null);
    assert.deepEqual(got.evidence, []);
    assert.deepEqual(got.admission, []);
    // now corrupt it
    await writeFile(join(f.root, ".changes.json"), "{ not json");
    await assert.rejects(f.engine.discard("ach_old"), /Couldn't read the saved agent changes/);
    const r = await propose(f);
    assert.equal(r.ok, false);
    assert.match(r.error, /Couldn't read the saved agent changes/);
    assert.equal(await readFile(join(f.root, ".changes.json"), "utf-8"), "{ not json", "nothing was written over it");
    await f.engine.recover();
    await f.engine.reconcile();
    assert.equal(await readFile(join(f.root, ".changes.json"), "utf-8"), "{ not json");
  } finally {
    await f.cleanup();
  }
});

// ---- the crash-safe write ----

const NEW_AGENT = "---\nname: SEO Reviewer\ndescription: Reviews SEO.\nisolation: none\n---\nYou review SEO.\nYou never edit.\n";
const applyingCreate = (over = {}) => ({
  id: "ach_c1",
  kind: "create",
  slug: null,
  intendedSlug: "seo-reviewer",
  agentName: "SEO Reviewer",
  sessionID: "ses_chat",
  messageID: "m",
  callID: "c",
  state: "applying",
  needsClick: true,
  reason: "ask",
  before: null,
  after: NEW_AGENT,
  createdAt: 1_700_000_000_000,
  decidedAt: null,
  error: null,
  decidedBy: "click",
  prior: { state: "pending", needsClick: true, reason: "ask" },
  ...over,
});
const putStore = (f, changes) => writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes, proposalSlots: {} }));
const restart = async (f, extra) => {
  const engine = f.make({ now: () => 1_700_000_000_000 + 1000, ...extra });
  await engine.init();
  return engine;
};
const state = async (f, id) => (await store(f)).changes.find((r) => r.id === id);

test("recovery, create: the record was saved `applying` but no folder exists → back to the prior state, nothing created", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await putStore(f, [applyingCreate()]);
    await restart(f);
    const r = await state(f, "ach_c1");
    assert.equal(r.state, "pending");
    assert.equal(r.needsClick, true);
    assert.equal(await ok(join(f.root, "seo-reviewer")), false);
  } finally {
    await f.cleanup();
  }
});

test("recovery, create: an EMPTY folder without our claim (a crash between mkdir and claim, or someone else's) is left untouched; another slug is used", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "seo-reviewer"));
    await putStore(f, [applyingCreate()]);
    await restart(f);
    const r = await state(f, "ach_c1");
    assert.equal(r.state, "applied", r.error);
    assert.equal(r.slug, "seo-reviewer-2");
    assert.deepEqual(await readdir(join(f.root, "seo-reviewer")), [], "the other folder is exactly as it was");
    assert.equal(await readFile(join(f.root, "seo-reviewer-2", "agent.md"), "utf-8"), NEW_AGENT);
    assert.equal(await ok(join(f.root, "seo-reviewer-2", ".claim")), false);
    assert.ok(f.config.cfg.agent["agent-seo-reviewer-2"], "activated in the OpenCode config");
  } finally {
    await f.cleanup();
  }
});

test("recovery, create: after the claim only (no agent.md, no home) → both are written and the agent is activated", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "seo-reviewer"));
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c1");
    await putStore(f, [applyingCreate()]);
    await restart(f);
    const r = await state(f, "ach_c1");
    assert.equal(r.state, "applied", r.error);
    assert.equal(r.slug, "seo-reviewer");
    assert.equal(r.decidedBy, "click");
    assert.ok((await stat(join(f.root, "seo-reviewer", "home"))).isDirectory());
    assert.equal(await ok(join(f.root, "seo-reviewer", ".claim")), false);
    assert.ok(f.config.cfg.agent["agent-seo-reviewer"]);
  } finally {
    await f.cleanup();
  }
});

test("recovery, create: between agent.md and home/ → home/ is created, nothing rewritten, activated", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "seo-reviewer"));
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c1");
    await writeFile(join(f.root, "seo-reviewer", "agent.md"), NEW_AGENT);
    await putStore(f, [applyingCreate()]);
    await restart(f);
    assert.equal((await state(f, "ach_c1")).state, "applied");
    assert.ok((await stat(join(f.root, "seo-reviewer", "home"))).isDirectory());
  } finally {
    await f.cleanup();
  }
});

test("recovery, create: after activation but before the claim was removed → the claim goes, the record is applied, the config keeps the agent", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "seo-reviewer", "home"), { recursive: true });
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c1");
    await writeFile(join(f.root, "seo-reviewer", "agent.md"), NEW_AGENT);
    await putStore(f, [applyingCreate()]);
    await restart(f);
    assert.equal((await state(f, "ach_c1")).state, "applied");
    assert.equal(await ok(join(f.root, "seo-reviewer", ".claim")), false);
    assert.ok(f.config.cfg.agent["agent-seo-reviewer"]);
    // and an `applied` record whose claim survived (the removal itself crashed) is cleaned at the next boot
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c1");
    await restart(f);
    assert.equal(await ok(join(f.root, "seo-reviewer", ".claim")), false);
  } finally {
    await f.cleanup();
  }
});

test("recovery, create: a user edit to agent.md in a claimed folder is a conflict naming the folder — nothing overwritten", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "seo-reviewer"));
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c1");
    await writeFile(join(f.root, "seo-reviewer", "agent.md"), NEW_AGENT.replace("never edit", "edit freely"));
    await putStore(f, [applyingCreate()]);
    await restart(f);
    const r = await state(f, "ach_c1");
    assert.equal(r.state, "conflict");
    assert.match(r.error, new RegExp(join(f.root, "seo-reviewer").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(r.error, /delete its \.claim/);
    assert.match(await readFile(join(f.root, "seo-reviewer", "agent.md"), "utf-8"), /edit freely/);
    assert.equal(f.config.cfg.agent["agent-seo-reviewer"], undefined);
    // a component of the wrong type is a conflict too, with nothing written
    await rm(join(f.root, "seo-reviewer"), { recursive: true });
    await mkdir(join(f.root, "seo-reviewer"));
    await writeFile(join(f.root, "seo-reviewer", ".claim"), "ach_c2");
    await writeFile(join(f.root, "seo-reviewer", "home"), "a file, not a folder");
    await putStore(f, [applyingCreate({ id: "ach_c2" })]);
    await restart(f);
    assert.equal((await state(f, "ach_c2")).state, "conflict");
    assert.equal(await ok(join(f.root, "seo-reviewer", "agent.md")), false);
  } finally {
    await f.cleanup();
  }
});

test("recovery, update: the file equals `after` → activated and applied; equals `before` → back to the prior state; anything else → conflict", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    const before = await readFile(join(f.root, "dev", "agent.md"), "utf-8");
    const after = `${before}- Always say what you tightened.\n`;
    const upd = (id, over = {}) => ({
      id,
      kind: "update",
      slug: "dev",
      agentName: "Dev",
      sessionID: "ses_chat",
      messageID: id,
      callID: id,
      state: "applying",
      needsClick: false,
      reason: null,
      before,
      after,
      createdAt: 1_700_000_000_000,
      decidedAt: null,
      error: null,
      decidedBy: "auto",
      prior: { state: "pending", needsClick: false, reason: null },
      ...over,
    });
    await writeFile(join(f.root, "dev", "agent.md"), after);
    await putStore(f, [upd("u1")]);
    await restart(f);
    assert.equal((await state(f, "u1")).state, "applied");
    assert.match(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), /tightened/);
    await writeFile(join(f.root, "dev", "agent.md"), before);
    await putStore(f, [upd("u2", { needsClick: true, reason: "ask" })].map((r) => ({ ...r, prior: { state: "pending", needsClick: true, reason: "ask" } })));
    await restart(f);
    const r2 = await state(f, "u2");
    assert.equal(r2.state, "pending");
    assert.equal(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), before);
    await writeFile(join(f.root, "dev", "agent.md"), before + "\nhand edit\n");
    await putStore(f, [upd("u3")]);
    await restart(f);
    assert.equal((await state(f, "u3")).state, "conflict");
    assert.match(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), /hand edit/);
  } finally {
    await f.cleanup();
  }
});

test("recovery: a claimed folder with no record in a readable store is skipped by scans and reported on the list; ordinary scans never admit it", async () => {
  const f = await archFixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "left-over", "home"), { recursive: true });
    await writeFile(join(f.root, "left-over", ".claim"), "ach_gone");
    await writeFile(join(f.root, "left-over", "agent.md"), NEW_AGENT);
    const engine = await restart(f);
    const row = (await engine.list()).find((a) => a.slug === "left-over");
    assert.match(row.error, /An interrupted create left this folder; check it and delete \.claim/);
    assert.equal(f.config.cfg.agent["agent-left-over"], undefined, "never activated");
    assert.equal((await engine.scan()).entries.some((e) => e.slug === "left-over"), false);
    assert.equal(await ok(join(f.root, "left-over", ".claim")), true, "left for the user");
  } finally {
    await f.cleanup();
  }
});

test("a create through Apply: the claim exists until activation; the record applied before it is removed; the folder ends clean", async () => {
  const f = await proposeFixture({ level: "ask" });
  try {
    const seen = [];
    const wrapped = f.make({
      retryDelayMs: 0,
      now: () => f.w.clock,
      autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: "ask" }),
      editConfig: async (fn) => {
        const edits = typeof fn === "function" ? await fn(f.config.cfg) : fn;
        seen.push({ claim: await ok(join(f.root, "seo-reviewer", ".claim")), file: await ok(join(f.root, "seo-reviewer", "agent.md")) });
        for (const e of edits) f.config.cfg.agent[e.path[1]] = structuredClone(e.value);
        return { ok: true, changed: edits.length > 0 };
      },
    });
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes: [applyingCreate({ state: "pending", prior: undefined, decidedBy: null, intendedSlug: undefined })], proposalSlots: {} }));
    const done = await wrapped.apply("ach_c1");
    assert.equal(done.state, "applied", done.error);
    assert.equal(done.slug, "seo-reviewer");
    assert.equal(done.decidedBy, "click");
    assert.ok(seen.some((s) => s.claim && s.file), "activation ran while the folder was claimed");
    assert.deepEqual((await readdir(join(f.root, "seo-reviewer"))).sort(), [".compiled.md", "agent.md", "home"]);
    // an Undo of the created agent works (the Phase 4 rule is unchanged)
    const undone = await wrapped.undo("ach_c1");
    assert.equal(undone.state, "undone", undone.error);
  } finally {
    await f.cleanup();
  }
});

test("a create whose chosen slug is taken in the instant before the mkdir takes the next free one; the other folder is untouched", async () => {
  const f = await proposeFixture({ level: "ask" });
  try {
    let raced = false;
    const racing = {
      ...fsPromises,
      mkdir: async (p, o) => {
        if (!raced && String(p).endsWith("/seo-reviewer")) {
          raced = true;
          await fsPromises.mkdir(p); // someone else wins the folder, with their own file in it
          await fsPromises.writeFile(join(p, "theirs.txt"), "theirs");
        }
        return fsPromises.mkdir(p, o);
      },
    };
    const engine = f.make({ fs: racing, now: () => f.w.clock, autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: "ask" }) });
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes: [applyingCreate({ state: "pending", prior: undefined, decidedBy: null, intendedSlug: undefined })], proposalSlots: {} }));
    const done = await engine.apply("ach_c1");
    assert.equal(done.state, "applied", done.error);
    assert.equal(done.slug, "seo-reviewer-2");
    assert.equal(await readFile(join(f.root, "seo-reviewer", "theirs.txt"), "utf-8"), "theirs");
    assert.equal(await ok(join(f.root, "seo-reviewer", "agent.md")), false);
  } finally {
    await f.cleanup();
  }
});

test("an activation failure keeps the folder claimed (state failed, protected from eviction); Retry passes the claim through and reloads", async () => {
  const f = await proposeFixture({ level: "ask" });
  try {
    let fail = true;
    let reloads = 0;
    const engine = f.make({
      now: () => f.w.clock,
      autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: "ask" }),
      editConfig: async (fn) => {
        if (fail) return { ok: false, changed: false, error: "config locked" };
        const edits = typeof fn === "function" ? await fn(f.config.cfg) : fn;
        for (const e of edits) f.config.cfg.agent[e.path[1]] = structuredClone(e.value);
        return { ok: true, changed: edits.length > 0 };
      },
      reload: async () => (reloads++, { ok: true }),
    });
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes: [applyingCreate({ state: "pending", prior: undefined, decidedBy: null, intendedSlug: undefined })], proposalSlots: {} }));
    const failed = await engine.apply("ach_c1");
    assert.equal(failed.state, "failed");
    assert.equal(await ok(join(f.root, "seo-reviewer", ".claim")), true, "still claimed");
    // protected: even 300 newer pending records can't evict it
    const doc = await store(f);
    const filler = Array.from({ length: 300 }, (_, i) => ({ ...doc.changes[0], id: `fill${i}`, state: "pending", kind: "update", createdAt: f.w.clock + i, releasedAt: f.w.clock + i, claimed: false }));
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ ...doc, changes: [...doc.changes, ...filler] }));
    await engine.discard("fill0");
    assert.ok((await store(f)).changes.some((r) => r.id === "ach_c1" && r.state === "failed"));
    fail = false;
    const retried = await engine.apply("ach_c1");
    assert.equal(retried.state, "applied", retried.error);
    assert.ok(f.config.cfg.agent["agent-seo-reviewer"]);
    assert.equal(await ok(join(f.root, "seo-reviewer", ".claim")), false);
    // a hand edit between attempts is a conflict naming the folder
    await writeFile(join(f.root, ".changes.json"), JSON.stringify({ version: 2, changes: [], proposalSlots: {} }));
  } finally {
    await f.cleanup();
  }
});

// ---- extra sources through agent_change ----

async function sourcesFixture({ scanner, secretsStore = [] } = {}) {
  const w = { messages: [], clock: 1_700_000_000_000, pubs: [] };
  const f = await archFixture({
    extra: {
      retryDelayMs: 0,
      now: () => w.clock,
      autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: "auto" }),
      publish: (p) => w.pubs.push(p),
      oc: { readSession: async () => ({ state: "found", session: { id: "ses_chat", directory: "/repo" } }), listMessages: async () => w.messages },
      delegate: { loadRecordsStrict: async () => [] },
      isManagedSession: async () => false,
      isCtoSessionStrict: async () => false,
      loadSecretsStrict: async () => {
        if (secretsStore === "throw") throw new Error("unreadable");
        return secretsStore;
      },
      createScanner: scanner ?? (() => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) })),
    },
  });
  await f.engine.init();
  let n = 0;
  const change = async (draft, { action = "update", agent = "architect" } = {}) => {
    n++;
    const b = { sessionID: "ses_chat", messageID: `msg_s${n}`, callID: `call_s${n}`, action, ...(agent ? { agent } : {}), draft };
    f.w = w;
    w.messages = [
      { info: { id: "msg_user", role: "user" }, parts: [] },
      { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent: "build" }, parts: [{ type: "tool", tool: "agent_change", callID: b.callID, state: { status: "running", input: { action: b.action, ...(agent ? { agent } : {}), draft } } }] },
    ];
    return f.engine.change(b);
  };
  return { ...f, w, change };
}
const BOOKFACE = { id: "bookface", name: "YC Bookface", description: "Private YC founder forum.", command: ["yc", "search", "{query}", "--type", "posts"], env: { YC_TOKEN: "{secret:YC_TOKEN}" } };
const storeIds = async (f) => (await store(f).catch(() => ({ changes: [] }))).changes.length;

test("agent_change: sources are accepted only on an UPDATE of the validated Architect — and then always need a click", async () => {
  const f = await sourcesFixture();
  try {
    const r = await f.change({ sources: [BOOKFACE] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.change.state, "pending");
    assert.equal(r.change.needsClick, true);
    assert.equal(r.change.reason, "core");
    const archBefore = await readFile(join(f.root, "architect", "agent.md"), "utf-8");
    assert.ok(!archBefore.includes("bookface"), "nothing written before the click");
    const applied = await f.engine.apply(r.change.id);
    assert.equal(applied.state, "applied", applied.error);
    const entry = (await f.engine.scan()).entries.find((e) => e.slug === "architect");
    assert.deepEqual(entry.meta.sources.map((s) => s.id), ["bookface"]);
    assert.equal(entry.meta.sources[0].private, true, "private defaults to true");
    assert.match(await readFile(join(f.root, "architect", "agent.md"), "utf-8"), /Private YC founder forum/);
    // clearing them is an update too
    const cleared = await f.change({ sources: null });
    assert.equal(cleared.change.needsClick, true);
    // elsewhere: a create, a specialist, the lead
    assert.match((await f.change({ name: "N", description: "d", isolation: "none", instructions: "x", sources: [BOOKFACE] }, { action: "create", agent: null })).error, /only be set on the Architect/);
    assert.match((await f.change({ sources: [BOOKFACE] }, { agent: "dev" })).error, /only be set on the Architect/);
    assert.match((await f.change({ sources: [BOOKFACE] }, { agent: "manta" })).error, /can't be changed here|only be set on the Architect/);
  } finally {
    await f.cleanup();
  }
});

test("agent_change sources: an invalid shape is refused with a sentence and no record is made", async () => {
  const f = await sourcesFixture();
  try {
    for (const [src, re] of [
      [{ ...BOOKFACE, command: ["yc", "search"] }, /exactly once/],
      [{ ...BOOKFACE, id: "hn" }, /built-in/],
      [{ ...BOOKFACE, url: "https://x.example.com/?q={query}" }, /exactly one/],
    ]) {
      const r = await f.change({ sources: [src] });
      assert.equal(r.ok, false);
      assert.match(r.error, re);
    }
    assert.equal((await f.change({ sources: Array.from({ length: 11 }, (_, i) => ({ ...BOOKFACE, id: `s${i}` })) })).ok, false);
    assert.equal(await storeIds(f), 0);
  } finally {
    await f.cleanup();
  }
});

test("agent_change sources: a literal credential is refused BEFORE a record exists and is never echoed — header, env, argv option, URL parameter, scanner hit, stored value", async () => {
  const stored = [{ key: "OLD", scope: "shared", value: "stored-secret-value-123" }];
  const scanner = ({ secretValues }) => ({
    scan: async (text) => {
      const hit = /ghp_[A-Za-z0-9]{10,}/.test(text) || secretValues().some((v) => text.includes(v));
      return { clean: !hit, unavailable: false, hits: hit ? [{}] : [] };
    },
  });
  const f = await sourcesFixture({ scanner, secretsStore: stored });
  try {
    const URLSRC = { id: "internal", name: "Internal", description: "d", url: "https://search.example.com/api?q={query}" };
    const cases = [
      ["header", { ...URLSRC, headers: { Authorization: "Bearer sk-literal-abcdef123456" } }, "sk-literal-abcdef123456"],
      ["header with extra text", { ...URLSRC, headers: { Authorization: "Bearer {secret:T} and more" } }, "and more"],
      ["env", { ...BOOKFACE, env: { YC_TOKEN: "literal-value-98765" } }, "literal-value-98765"],
      ["argv option", { ...BOOKFACE, command: ["yc", "{query}", "--token", "abc-literal-123"] }, "abc-literal-123"],
      ["argv option=", { ...BOOKFACE, command: ["yc", "{query}", "--token=abc-literal-123"] }, "abc-literal-123"],
      ["url parameter", { ...URLSRC, url: "https://search.example.com/api?q={query}&api_key=lit-key-123456" }, "lit-key-123456"],
      ["token format in argv", { ...BOOKFACE, env: undefined, command: ["yc", "{query}", "ghp_abcdefghij1234567890"] }, "ghp_abcdefghij1234567890"],
      ["token format in the url path", { ...URLSRC, url: "https://search.example.com/ghp_abcdefghij1234567890/api?q={query}" }, "ghp_abcdefghij1234567890"],
      ["a stored value in a free header", { ...URLSRC, headers: { "X-Note": "stored-secret-value-123" } }, "stored-secret-value-123"],
    ];
    for (const [name, src, secret] of cases) {
      const r = await f.change({ sources: [src] });
      assert.equal(r.ok, false, name);
      assert.match(r.error, /Secrets/, name);
      assert.ok(!JSON.stringify(r).includes(secret), `${name}: the value is never echoed`);
    }
    assert.equal(await storeIds(f), 0, "no record for any of them");
  } finally {
    await f.cleanup();
  }
});

test("agent_change sources: references and ordinary header values are accepted; an unreadable secrets store or an unavailable scanner REFUSES", async () => {
  const f = await sourcesFixture();
  try {
    const good = await f.change({
      sources: [
        { id: "a", name: "A", description: "d", url: "https://search.example.com/api?q={query}", headers: { Authorization: "Bearer {secret:A_VERY_LONG_SECRET_NAME_WITH_MANY_CHARS_0123456789}", Accept: "application/problem+json" } },
        { id: "b", name: "B", description: "d", command: ["yc", "search", "{query}", "--limit", "15"], env: { YC_TOKEN: "{secret:YC_TOKEN}" } },
      ],
    });
    assert.equal(good.ok, true, good.error);
  } finally {
    await f.cleanup();
  }
  const g = await sourcesFixture({ secretsStore: "throw" });
  try {
    const r = await g.change({ sources: [{ id: "b", name: "B", description: "d", command: ["yc", "{query}"] }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /Couldn't check the sources for credentials/);
    assert.equal(await storeIds(g), 0);
  } finally {
    await g.cleanup();
  }
  const h = await sourcesFixture({ scanner: () => ({ scan: async () => ({ clean: false, unavailable: true, hits: [] }) }) });
  try {
    const r = await h.change({ sources: [{ id: "b", name: "B", description: "d", command: ["yc", "{query}", "--type", "posts"] }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /Couldn't check the sources for credentials/);
  } finally {
    await h.cleanup();
  }
});

test("an Architect change that keeps its sources untouched leaves the YAML intact; hand-written invalid sources are skipped with a notice", async () => {
  const f = await sourcesFixture();
  try {
    const r = await f.change({ sources: [BOOKFACE] });
    await f.engine.apply(r.change.id);
    const before = await readFile(join(f.root, "architect", "agent.md"), "utf-8");
    const r2 = await f.change({ description: "Builds agents from research, with extra sources." });
    assert.equal(r2.ok, true, r2.error);
    await f.engine.apply(r2.change.id);
    const after = await readFile(join(f.root, "architect", "agent.md"), "utf-8");
    assert.ok(after.includes("Private YC founder forum"));
    assert.equal(after.split("sources:")[1], before.split("sources:")[1], "the sources block is byte-identical");
    assert.deepEqual((await f.engine.scan()).entries.find((e) => e.slug === "architect").meta.sources.map((s) => s.id), ["bookface"]);
  } finally {
    await f.cleanup();
  }
});
