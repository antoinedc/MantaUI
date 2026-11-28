// An agent starts work in a project from its own conversation (docs/superpowers/specs/2026-11-28-agent-chat-tasks.md): the binding of
// `agent_projects` / `agent_start_task` to the agent's own conversation, the project list and its pages, the project folder check
// (realpath + the registry's identity), the memory that reaches the task, seats written only after a confirmed launch, the launch /
// Clear fence, the guidance, Needs you and Clear. Fakes for opencode, the delegate, tmux and the project registry; real folders
// (with real symlinks) for the folder checks; nothing live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, cp, realpath } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine, buildAgentChatBrief, CHAT_PROJECTS_PAGE, OWN_CHAT_ONLY, HANDOFF_BUSY } from "./agents.mjs";
import { CAP_ERROR } from "./delegate.mjs";
import { MODES } from "../shared/autonomyShared.mjs";
import { renderLearned } from "./agentLearning.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const AGENT = (name, isolation = "worktree", extra = "") => `---\nname: ${name}\ndescription: Does ${name} things.\nisolation: ${isolation}\n${extra}---\nYou are ${name}.\n`;
const BAL = MODES.balanced;

const SES = "ses_devchat"; // Dev's conversation
const RONDA = "ronda-0f9e8d7c6b";
const MANTAUI = "mantaui-1a2b3c4d5e";
const ATLAS = "atlas-2233445566";
const CONVERSATION_NOTICE = "The conversation said MANTAUI-SECRET-TEXT";

/**
 * A box: the agents root with Dev (own branch) and Scout (read-only), real project folders, a registry fake that knows which real folder
 * is which project, a recording `fs`, and a delegate fake with the real contract (`admit` runs before anything is created; an approval
 * waits on `world.gate`; `settleSeat` mirrors the real one).
 */
async function fixture(extra = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-chat-tasks-"));
  const root = join(base, "agents");
  const home = join(base, "home");
  const templatesDir = join(base, "templates");
  await mkdir(join(home, ".manta"), { recursive: true });
  await mkdir(join(templatesDir, "dev"), { recursive: true });
  await mkdir(join(templatesDir, "scout"), { recursive: true });
  await writeFile(join(templatesDir, "dev", "agent.md"), AGENT("Dev"));
  await writeFile(join(templatesDir, "scout", "agent.md"), AGENT("Scout", "none"));
  for (const t of ["manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });

  const folders = {};
  for (const [slug, dir] of [[RONDA, "ronda"], [MANTAUI, "mantaui"], [ATLAS, "atlas"]]) {
    folders[slug] = join(base, "projects", dir);
    await mkdir(folders[slug], { recursive: true });
  }
  const world = {
    // the registry: slug → { displayName, paths[] } (paths oldest first, as the real registry keeps them)
    projects: new Map([
      [RONDA, { slug: RONDA, canonicalId: "github.com/acme/ronda", displayName: "Ronda", paths: [folders[RONDA]] }],
      [MANTAUI, { slug: MANTAUI, canonicalId: "github.com/acme/mantaui", displayName: "MantaUI", paths: [folders[MANTAUI]] }],
    ]),
    dirSlug: new Map(), // real folder → the project it identifies as
    messages: {},
    sessions: { [SES]: { id: SES, directory: join(root, "dev", "home") } },
    questions: {},
    questionsFail: new Set(),
    approvedModels: ["anthropic/claude-sonnet-5-5", "openai/gpt-6-sol"],
    cfg: { chatAutoAllow: true },
    gate: null,
    approval: "approve",
    records: [],
    jobSeq: 0,
    cap: false,
    launchState: "running",
    policy: BAL,
    recordsFail: false,
    projectsList: null,
  };
  const calls = { startJob: [], startApproval: [], continueJob: [], lookup: [], identify: [], count: [], settle: [], reads: [], createSession: [], restamp: [] };
  for (const [slug, folder] of Object.entries(folders)) world.dirSlug.set(await realpath(folder), slug);

  const recordingFs = { ...fsPromises, readFile: async (p, ...a) => (calls.reads.push(String(p)), fsPromises.readFile(p, ...a)) };

  const register = async (input) => {
    if (typeof input.admit === "function") {
      const refusal = await input.admit(world.records);
      if (typeof refusal === "string" && refusal) return { ok: false, error: refusal };
    }
    if (world.cap) return { ok: false, error: CAP_ERROR };
    const job = {
      id: `job${++world.jobSeq}`,
      status: "running",
      launchState: world.launchState,
      specialist: true,
      createdAt: 1000 + world.jobSeq,
      branch: input.isolation === "worktree" ? `agent/dev/${input.name}` : null,
      worktree: input.isolation === "worktree" ? `/wt/${input.name}` : null,
      ...Object.fromEntries(["parentSessionID", "parentDirectory", "agent", "agentDir", "isolation", "model", "name", "title", "agentName", "request", "project", "startedFrom", "knowledgeProject", "seatOwed", "allowPr", "prompt"].filter((k) => input[k] !== undefined).map((k) => [k, input[k]])),
    };
    world.records.push(job);
    return { ok: true, job, ...(world.launchState === "uncertain" ? { uncertain: true } : {}) };
  };
  const delegate = {
    startJob: async (i) => (calls.startJob.push(i), register(i)),
    startJobWithApproval: async (i) => {
      calls.startApproval.push(i);
      if (world.gate) await world.gate;
      const decision = world.decide ? world.decide(i) : world.approval;
      if (decision === "declined") return { ok: false, error: "declined" };
      if (decision === "timeout") return { ok: false, error: "approval timed out" };
      return register(i);
    },
    continueJob: async (id, input) => {
      calls.continueJob.push({ id, input });
      const old = world.records.find((j) => j.id === id);
      if (world.beforeContinue) await world.beforeContinue();
      if (typeof input.admit === "function") {
        const refusal = await input.admit(world.records, old);
        if (typeof refusal === "string" && refusal) return { ok: false, error: refusal };
      }
      const job = { ...old, id: `job${++world.jobSeq}`, continues: id, status: "running", launchState: "running", prompt: input.prompt };
      delete job.seatOwed;
      world.records.push(job);
      return { ok: true, job };
    },
    loadRecords: async () => world.records.map((j) => structuredClone(j)),
    loadRecordsStrict: async () => {
      if (world.recordsFail) throw new Error("store unreadable");
      return world.records.map((j) => structuredClone(j));
    },
    settleSeat: async (id, { created }) => {
      calls.settle.push({ id, created });
      const j = world.records.find((r) => r.id === id);
      if (!j) return { ok: false };
      const { seatOwed, ...rest } = j;
      Object.keys(j).forEach((k) => delete j[k]);
      Object.assign(j, rest, created && seatOwed ? { seatAdded: seatOwed } : {});
      return { ok: true };
    },
  };

  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const engine = createAgentsEngine({
    root,
    home,
    templatesDir,
    fs: recordingFs,
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter(config),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    retryDelayMs: 0,
    oc: {
      listMessages: async (sid) => world.messages[sid] ?? [],
      readSession: async (sid) => (world.sessions[sid] ? { state: "found", session: world.sessions[sid] } : { state: "missing" }),
      createSession: async (i) => {
        calls.createSession.push(i);
        const id = `ses_new${calls.createSession.length}`;
        world.sessions[id] = { id, directory: i.directory };
        return { id };
      },
      sessionExists: async (id) => !!world.sessions[id],
      listQuestions: async (sid) => {
        if (world.questionsFail.has(sid)) throw new Error("opencode down");
        return world.questions[sid] ?? [];
      },
    },
    delegate,
    tmux: {
      listProjects: async () => [],
      newWindow: async () => ({ windowIndex: 3 }),
      newSession: async () => ({ windowIndex: 0 }),
      restampSessionId: async (...a) => void calls.restamp.push(a),
    },
    registry: {
      identify: async (d) => (calls.identify.push(d), world.dirSlug.has(d) ? { slug: world.dirSlug.get(d) } : null),
      list: async () => world.projectsList ?? [...world.projects.values()].map((p) => ({ ...p, paths: [...p.paths] })),
      get: async (slug) => (world.projects.has(slug) ? { ...world.projects.get(slug), paths: [...world.projects.get(slug).paths] } : null),
      lookup: async (d) => (calls.lookup.push(d), world.dirSlug.has(d) ? { slug: world.dirSlug.get(d) } : null),
    },
    isManagedSession: async () => false,
    isCtoSessionStrict: async () => false,
    configGet: async () => world.cfg,
    autonomyPolicy: async () => world.policy,
    listApprovedModels: async () => world.approvedModels,
    syncState: { refreshNow: async () => {} },
    ...extra,
  });
  await engine.init();
  await writeFile(join(root, "dev", ".chat.json"), JSON.stringify({ sessionId: SES }));
  return { base, root, home, folders, engine, world, calls, cleanup: () => rm(base, { recursive: true, force: true }) };
}

let seq = 0;
/** A body for a tool call of Dev's conversation, with the live tool part in the transcript. `over` changes the body, `msg` the message. */
function startCall(f, over = {}, msg = {}) {
  const n = ++seq;
  const body = { sessionID: SES, messageID: `msg_${n}`, callID: `call_${n}`, project: RONDA, title: "Fix the flaky upload test", brief: "Make the upload test pass 20 runs in a row.", ...over };
  const input = Object.fromEntries(["project", "title", "brief", "continueJob"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  put(f, body, "agent_start_task", input, msg);
  return body;
}
function projectsCall(f, over = {}, msg = {}) {
  const n = ++seq;
  const body = { sessionID: SES, messageID: `msg_${n}`, callID: `call_${n}`, ...over };
  put(f, body, "agent_projects", Object.hasOwn(body, "offset") ? { offset: body.offset } : {}, msg);
  return body;
}
function put(f, body, tool, input, { agent = "agent-dev", providerID = "anthropic", modelID = "claude-sonnet-5-5", status = "running" } = {}) {
  const list = (f.world.messages[body.sessionID] ??= []);
  list.push({
    info: { id: body.messageID, role: "assistant", agent, providerID, modelID },
    parts: [{ type: "tool", tool, callID: body.callID, state: { status, input } }],
  });
}
const refused = (r, text) => (assert.equal(r.ok, false), assert.equal(r.error, text), r);
const nothingCreated = (f) => {
  assert.equal(f.world.records.length, 0, "no job record");
  assert.equal(f.calls.startJob.length + f.calls.startApproval.length + f.calls.continueJob.length, 0, "nothing was started");
};
const seatFile = (f, project = RONDA, agent = "dev") => join(f.root, agent, "seats", `${project}.md`);
const readOr = async (p) => readFile(p, "utf-8").catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until `cond()` (the launch has reached the approval card), up to 3 s. */
const until = async (cond) => {
  for (let i = 0; i < 300 && !cond(); i++) await sleep(10);
  assert.ok(cond(), "the launch never reached the approval card");
};

// ---------------------------------------------------------------------------
// US-7: the tools work only in the agent's own conversation
// ---------------------------------------------------------------------------

test("AC-7.1 any other session — a project chat, Manta's chat, the CTO conversation, a routine run — gets the refusal and nothing is created", async () => {
  const f = await fixture();
  try {
    f.world.sessions.ses_project = { id: "ses_project", directory: f.folders[RONDA] };
    f.world.sessions.ses_manta = { id: "ses_manta", directory: join(f.root, "manta", "home") };
    await writeFile(join(f.root, "manta", ".chat.json"), JSON.stringify({ sessionId: "ses_manta" }));
    for (const sid of ["ses_project", "ses_manta", "ses_unknown"]) {
      const b = startCall(f, { sessionID: sid });
      refused(await f.engine.chatStart(b), OWN_CHAT_ONLY);
      const p = projectsCall(f, { sessionID: sid });
      refused(await f.engine.chatProjects(p), OWN_CHAT_ONLY);
    }
    nothingCreated(f);
    assert.equal(OWN_CHAT_ONLY, "Only an agent's own conversation can start tasks this way");
  } finally {
    await f.cleanup();
  }
});

test("AC-7.2 a task of the agent (a child session, a session that is not the one in .chat.json) gets the same refusal", async () => {
  const f = await fixture();
  try {
    f.world.sessions.ses_task = { id: "ses_task", parentID: SES, directory: "/wt/x" };
    refused(await f.engine.chatStart(startCall(f, { sessionID: "ses_task" })), OWN_CHAT_ONLY);
    // even the stored conversation is refused once it is a child session or marked internal
    await writeFile(join(f.root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_task" }));
    refused(await f.engine.chatStart(startCall(f, { sessionID: "ses_task" })), OWN_CHAT_ONLY);
    f.world.sessions.ses_hidden = { id: "ses_hidden", directory: "/x", metadata: { manta: { internal: true } } };
    await writeFile(join(f.root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_hidden" }));
    refused(await f.engine.chatStart(startCall(f, { sessionID: "ses_hidden" })), OWN_CHAT_ONLY);
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("AC-7.3 a call whose message was produced by another agent key (the user switched the conversation's agent) is refused", async () => {
  const f = await fixture();
  try {
    refused(await f.engine.chatStart(startCall(f, {}, { agent: "build" })), OWN_CHAT_ONLY);
    refused(await f.engine.chatProjects(projectsCall(f, {}, { agent: "agent-scout" })), OWN_CHAT_ONLY);
    refused(await f.engine.chatStart(startCall(f, {}, { agent: "" })), OWN_CHAT_ONLY);
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("AC-7.4 a body that is not a live, running call of that tool with the same input: 'Couldn't verify', or the refusal when found but not running / different / reused", async () => {
  const f = await fixture();
  try {
    const COULDNT = "Couldn't verify this call; try again";
    let b = { sessionID: SES, messageID: "msg_nope", callID: "call_nope", project: RONDA, title: "t", brief: "b" };
    refused(await f.engine.chatStart(b), COULDNT);
    refused(await f.engine.chatStart({ ...b, callID: "" }), OWN_CHAT_ONLY);
    // found but finished
    b = startCall(f, {}, { status: "completed" });
    refused(await f.engine.chatStart(b), OWN_CHAT_ONLY);
    // the running input differs from the body (a changed brief)
    b = startCall(f);
    refused(await f.engine.chatStart({ ...b, brief: "something else" }), OWN_CHAT_ONLY);
    // another tool's call with this id
    b = projectsCall(f);
    refused(await f.engine.chatStart({ ...b, project: RONDA, title: "t", brief: "b" }), COULDNT);
    // a replay
    const ok = startCall(f);
    assert.equal((await f.engine.chatStart(ok)).ok, true);
    refused(await f.engine.chatStart(ok), OWN_CHAT_ONLY);
    assert.equal(f.world.records.length, 1, "only the first one started");
  } finally {
    await f.cleanup();
  }
});

test("AC-7.5 after Clear conversation the old session is no longer bound, the new one is", async () => {
  const f = await fixture();
  try {
    const { sessionId } = await f.engine.clearChat({ slug: "dev" });
    refused(await f.engine.chatStart(startCall(f)), OWN_CHAT_ONLY);
    const b = startCall(f, { sessionID: sessionId });
    assert.equal((await f.engine.chatStart(b)).ok, true);
  } finally {
    await f.cleanup();
  }
});

test("AC-E4 an agent whose agent.md became invalid, or that was deleted after the conversation opened, is refused as not-own-conversation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "dev", "agent.md"), "no frontmatter here");
    refused(await f.engine.chatStart(startCall(f)), OWN_CHAT_ONLY);
    await rm(join(f.root, "dev"), { recursive: true, force: true });
    refused(await f.engine.chatStart(startCall(f)), OWN_CHAT_ONLY);
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("the stored conversation can't be read (an unreadable .chat.json): a sentence to retry, nothing created", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, "dev", ".chat.json"));
    await mkdir(join(f.root, "dev", ".chat.json")); // a directory: reading it fails with EISDIR, not ENOENT
    refused(await f.engine.chatStart(startCall(f)), "Couldn't check this conversation; try again");
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// agent_projects: the list, its pages, the folder check
// ---------------------------------------------------------------------------

test("agent_projects: seated first, then by name; each with its id, name, seated flag, the FIRST line of its brief (≤160), and its canonical folder", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(seatFile(f, MANTAUI), `---\nadded_at: 2026-11-01T00:00:00.000Z\nadded_by: user\n---\n${"x".repeat(300)}\nSECOND LINE with MANTAUI notes\n`);
    const r = await f.engine.chatProjects(projectsCall(f));
    assert.equal(r.ok, true);
    assert.equal(r.agent, "dev");
    assert.deepEqual(r.projects.map((p) => [p.id, p.name, p.seated]), [[MANTAUI, "MantaUI", true], [RONDA, "Ronda", false]]);
    assert.equal(r.projects[0].brief.length <= 160, true);
    assert.equal(r.projects[0].brief.startsWith("xxxx"), true);
    assert.doesNotMatch(JSON.stringify(r), /SECOND LINE|MANTAUI notes/, "never a whole brief");
    assert.equal(r.projects[1].brief, "");
    assert.equal(r.projects[0].folder, await realpath(f.folders[MANTAUI]));
    assert.deepEqual([r.total, r.offset, r.nextOffset], [2, 0, null]);
  } finally {
    await f.cleanup();
  }
});

test("AC-5.6 51 projects with usable folders: the first call gets 50, total 51, nextOffset 50; offset 50 gets the 51st; past the end is empty with the real total", async () => {
  const f = await fixture();
  try {
    const list = [];
    for (let i = 0; i < 51; i++) {
      const slug = `proj${String(i).padStart(2, "0")}-00000000${String(i).padStart(2, "0")}`;
      const dir = join(f.base, "many", `p${i}`);
      await mkdir(dir, { recursive: true });
      f.world.dirSlug.set(await realpath(dir), slug);
      list.push({ slug, canonicalId: `x/${i}`, displayName: `Project ${String(i).padStart(2, "0")}`, paths: [dir] });
    }
    f.world.projectsList = list;
    assert.equal(CHAT_PROJECTS_PAGE, 50);
    const first = await f.engine.chatProjects(projectsCall(f));
    assert.equal(first.projects.length, 50);
    assert.deepEqual([first.total, first.offset, first.nextOffset], [51, 0, 50]);
    const second = await f.engine.chatProjects(projectsCall(f, { offset: 50 }));
    assert.equal(second.projects.length, 1);
    assert.equal(second.projects[0].name, "Project 50");
    assert.deepEqual([second.total, second.offset, second.nextOffset], [51, 50, null]);
    const past = await f.engine.chatProjects(projectsCall(f, { offset: 200 }));
    assert.deepEqual([past.ok, past.projects, past.total, past.nextOffset], [true, [], 51, null]);
    refused(await f.engine.chatProjects(projectsCall(f, { offset: -1 })), "offset must be a whole number from 0");
    refused(await f.engine.chatProjects(projectsCall(f, { offset: 1.5 })), "offset must be a whole number from 0");
  } finally {
    await f.cleanup();
  }
});

test("AC-4.3 a registered path that is a symlink to ANOTHER project's checkout, or into ~/.manta, is not used: refused with nothing read and nothing created; the list omits it", async () => {
  const f = await fixture();
  try {
    // Ronda's registered path is a symlink to MantaUI's checkout; Atlas's is a symlink into ~/.manta
    const link = join(f.base, "projects", "ronda-link");
    await symlink(f.folders[MANTAUI], link);
    f.world.projects.get(RONDA).paths = [link];
    const intoManta = join(f.base, "projects", "atlas-link");
    await mkdir(join(f.home, ".manta", "somewhere"), { recursive: true });
    await symlink(join(f.home, ".manta", "somewhere"), intoManta);
    f.world.dirSlug.set(await realpath(intoManta), ATLAS); // even a registry that said so would not be believed
    f.world.projects.set(ATLAS, { slug: ATLAS, canonicalId: "x/atlas", displayName: "Atlas", paths: [intoManta] });

    const listed = await f.engine.chatProjects(projectsCall(f));
    assert.deepEqual(listed.projects.map((p) => p.id), [MANTAUI], "AC-4.3d: no usable folder → not listed");
    assert.equal(listed.projects[0].folder, await realpath(f.folders[MANTAUI]));

    f.calls.reads.length = 0;
    refused(await f.engine.chatStart(startCall(f, { project: RONDA })), "Ronda has no folder on this box"); // 4.3a
    refused(await f.engine.chatStart(startCall(f, { project: ATLAS })), "Atlas has no folder on this box"); // 4.3b
    nothingCreated(f);
    const memoryReads = f.calls.reads.filter((p) => p.includes("/seats/") || p.includes(".learned"));
    assert.deepEqual(memoryReads, [], "AC-4.3c: no seat and no learned rule was read");
    assert.equal(await readOr(seatFile(f, RONDA)), null);
  } finally {
    await f.cleanup();
  }
});

test("AC-4.3 with several registered paths the newest USABLE one wins (the last entry first), and its realpath is what runs", async () => {
  const f = await fixture();
  try {
    const old = join(f.base, "projects", "ronda-old");
    await mkdir(old, { recursive: true });
    f.world.dirSlug.set(await realpath(old), RONDA);
    const missing = join(f.base, "projects", "gone");
    f.world.projects.get(RONDA).paths = [old, f.folders[RONDA], missing];
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, true);
    assert.equal(f.world.records[0].parentDirectory, await realpath(f.folders[RONDA]), "the newest path that exists and identifies as Ronda");
  } finally {
    await f.cleanup();
  }
});

test("AC-E1 no registered project with a folder: agent_projects says so with an empty list", async () => {
  const f = await fixture();
  try {
    f.world.projects.clear();
    const r = await f.engine.chatProjects(projectsCall(f));
    assert.deepEqual([r.ok, r.projects, r.total, r.nextOffset], [true, [], 0, null]);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// agent_start_task: the happy path and what the task is given
// ---------------------------------------------------------------------------

test("AC-1.1–1.6 a start: parent, canonical folder, agent key, own branch, record fields, the answer, the fleet count", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(seatFile(f), "RONDA-BRIEF: ship small commits.\n");
    await mkdir(join(f.root, ".learned", "dev"), { recursive: true });
    await writeFile(join(f.root, ".learned", "dev", `${RONDA}.md`), renderLearned([{ id: "lr_aaaaaaaa", rule: "RONDA-RULE use pnpm", createdAt: 1 }]));
    await writeFile(join(f.root, ".learned", "dev", "_all.md"), renderLearned([{ id: "lr_bbbbbbbb", rule: "ALL-RULE keep commits small", createdAt: 1 }]));
    await writeFile(join(f.root, ".learned", "dev", `${MANTAUI}.md`), renderLearned([{ id: "lr_cccccccc", rule: "MANTAUI-RULE use npm", createdAt: 1 }]));
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(seatFile(f, MANTAUI), "MANTAUI-BRIEF only for MantaUI\n");
    // the conversation discussed MantaUI at length
    f.world.messages[SES] = [{ info: { id: "m0", role: "user" }, parts: [{ type: "text", text: CONVERSATION_NOTICE }] }];

    const b = startCall(f, { title: "Fix the flaky upload test", brief: "Make the upload test pass 20 runs in a row." }, { providerID: "openai", modelID: "gpt-6-sol" });
    const r = await f.engine.chatStart(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.project, r.seatAdded, r.isolation], [{ id: RONDA, name: "Ronda" }, false, "worktree"]);
    assert.equal(r.jobId, "job1");
    assert.match(r.branch, /^agent\/dev\//);

    assert.equal(f.calls.startJob.length + f.calls.startApproval.length, 1);
    const input = f.calls.startJob[0] ?? f.calls.startApproval[0];
    const real = await realpath(f.folders[RONDA]);
    assert.equal(input.parentSessionID, SES);
    assert.equal(input.parentDirectory, real);
    assert.equal(input.agent, "agent-dev");
    assert.equal(input.agentDir, join(f.root, "dev"));
    assert.equal(input.isolation, "worktree");
    assert.equal(input.title, "Fix the flaky upload test");
    assert.equal(input.request, "Fix the flaky upload test");
    assert.equal(input.allowPr, false);
    assert.equal("requestedBy" in input, false, "that marks the lead");
    assert.equal("targetProject" in input, false);
    assert.deepEqual(input.project, { slug: RONDA, name: "Ronda" });
    assert.equal(input.startedFrom, "agent-chat");
    assert.equal(input.knowledgeProject, RONDA);
    assert.equal(input.specialist, true);
    assert.equal(typeof input.autonomy?.load, "function");
    // AC-1.5 / AC-5.1 / AC-5.2: the brief, Ronda's seat brief and rules (+ _all); nothing of MantaUI; no conversation excerpt
    assert.ok(input.prompt.startsWith("Make the upload test pass 20 runs in a row."));
    assert.match(input.prompt, /RONDA-BRIEF/);
    assert.match(input.prompt, /RONDA-RULE/);
    assert.match(input.prompt, /ALL-RULE/);
    assert.doesNotMatch(input.prompt, /MANTAUI-BRIEF|MANTAUI-RULE|MANTAUI-SECRET-TEXT|Recent conversation/);
    // AC-1.4 the stored record, AC-1.6 the weekly count for (dev, Ronda)
    const job = f.world.records[0];
    assert.deepEqual(job.project, { slug: RONDA, name: "Ronda" });
    assert.equal(job.startedFrom, "agent-chat");
    const fleet = JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8"));
    const week = Object.values(fleet.counts)[0];
    assert.equal(week.dev[RONDA], 1);
    assert.equal(week.dev[MANTAUI], undefined);
  } finally {
    await f.cleanup();
  }
});

test("AC-1.7 model: the model of the calling message; else the agent's own; else none (the default chain)", async () => {
  const f = await fixture();
  try {
    // the user picked GPT-6 Sol in the conversation's picker: the message that made the call carries it
    assert.equal((await f.engine.chatStart(startCall(f, {}, { providerID: "openai", modelID: "gpt-6-sol" }))).ok, true);
    assert.deepEqual([...f.calls.startApproval, ...f.calls.startJob].at(-1).model, { providerID: "openai", modelID: "gpt-6-sol" });
    // no model on the calling message: the agent's own
    await writeFile(join(f.root, "dev", "agent.md"), AGENT("Dev", "worktree", "model: anthropic/claude-sonnet-5-5\n"));
    assert.equal((await f.engine.chatStart(startCall(f, {}, { providerID: null, modelID: null }))).ok, true);
    assert.deepEqual([...f.calls.startApproval, ...f.calls.startJob].at(-1).model, "anthropic/claude-sonnet-5-5");
    // neither
    await writeFile(join(f.root, "dev", "agent.md"), AGENT("Dev"));
    assert.equal((await f.engine.chatStart(startCall(f, {}, { providerID: null, modelID: null }))).ok, true);
    assert.equal("model" in [...f.calls.startApproval, ...f.calls.startJob].at(-1), false);
  } finally {
    await f.cleanup();
  }
});

test("AC-1.7 a model the box doesn't approve for tasks is refused with the sentence, and nothing is created", async () => {
  const f = await fixture();
  try {
    refused(await f.engine.chatStart(startCall(f, {}, { providerID: "deepseek", modelID: "deepseek-chat" })), "deepseek/deepseek-chat can't run tasks; pick another model in this conversation or use Auto");
    nothingCreated(f);
    f.world.approvedModels = [];
    refused(await f.engine.chatStart(startCall(f)), "Couldn't check the models; try again");
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("AC-4.1/4.2 an unknown project id: the sentence, and nothing — no record, seat or fleet count", async () => {
  const f = await fixture();
  try {
    for (const project of ["nope-0000000000", "Not A Slug", "../etc", ""]) {
      refused(await f.engine.chatStart(startCall(f, { project })), "No project with that id; call agent_projects and use an id from its list");
    }
    nothingCreated(f);
    assert.equal(await readOr(seatFile(f, "nope-0000000000")), null);
    assert.equal(await readOr(join(f.root, ".fleet.json")), null);
  } finally {
    await f.cleanup();
  }
});

test("AC-5.1 Ronda's registered path is a symlink to MantaUI's checkout: that path is skipped, never used with Ronda's name on it", async () => {
  const f = await fixture();
  try {
    const link = join(f.base, "projects", "ronda-link");
    await symlink(f.folders[MANTAUI], link);
    f.world.projects.get(RONDA).paths = [link];
    refused(await f.engine.chatStart(startCall(f, { project: RONDA })), "Ronda has no folder on this box");
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("AC-E2 an empty or whitespace title or brief; the title is cut to 80 characters", async () => {
  const f = await fixture();
  try {
    refused(await f.engine.chatStart(startCall(f, { title: "   " })), "Write a brief and a title");
    refused(await f.engine.chatStart(startCall(f, { brief: "\n " })), "Write a brief and a title");
    nothingCreated(f);
    assert.equal((await f.engine.chatStart(startCall(f, { title: "T".repeat(120) }))).ok, true);
    assert.equal(f.world.records[0].title.length, 80);
  } finally {
    await f.cleanup();
  }
});

test("AC-E3 the box-wide running cap is full: the delegate's refusal is relayed as 'wait', with no seat", async () => {
  const f = await fixture();
  try {
    f.world.cap = true;
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, false);
    assert.equal(r.error, HANDOFF_BUSY);
    assert.equal(await readOr(seatFile(f)), null);
  } finally {
    await f.cleanup();
  }
});

test("AC-E5 a read-only agent, or a non-git project folder: the task runs read-only in the folder, branch null", async () => {
  const f = await fixture();
  try {
    await f.engine.create({ name: "Scout2", description: "reads", isolation: "none" });
    await writeFile(join(f.root, "scout", ".chat.json"), JSON.stringify({ sessionId: "ses_scout" }));
    f.world.sessions.ses_scout = { id: "ses_scout", directory: join(f.root, "scout", "home") };
    const b = startCall(f, { sessionID: "ses_scout" }, { agent: "agent-scout" });
    const r = await f.engine.chatStart(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.branch, r.isolation], [null, "none"]);
    assert.equal(f.calls.startJob.length, 1, "a read-only task never asks for approval");
    assert.equal(f.calls.startApproval.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// US-8: the user's autonomy settings and the approval card
// ---------------------------------------------------------------------------

test("AC-8.1 'Hand off: Never', 'Code changes: Never' (a code-editing task) and unreadable settings refuse with their sentences; nothing is created", async () => {
  const f = await fixture();
  try {
    f.world.policy = { ...BAL, handoff: "never" };
    refused(await f.engine.chatStart(startCall(f)), "Handing off is turned off in your autonomy settings");
    f.world.policy = { ...BAL, edit_code: "never" };
    refused(await f.engine.chatStart(startCall(f)), "Code changes are turned off in your autonomy settings");
    nothingCreated(f);
    const f2 = await fixture({ autonomyPolicy: async () => { throw new Error("unreadable"); } });
    try {
      refused(await f2.engine.chatStart(startCall(f2)), "Couldn't read your autonomy settings; try again");
      nothingCreated(f2);
    } finally {
      await f2.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test("AC-8.2 a code-editing task follows the box trust setting: on starts at once with the server's grants; off waits for the approval card, declining leaves no seat", async () => {
  const f = await fixture();
  try {
    f.world.cfg = { chatAutoAllow: false };
    f.world.approval = "declined";
    refused(await f.engine.chatStart(startCall(f)), "The user declined the task");
    f.world.approval = "timeout";
    refused(await f.engine.chatStart(startCall(f)), "The user declined the task");
    assert.equal(f.calls.startApproval.length, 2);
    assert.equal(f.calls.startApproval[0].trustMode, false);
    assert.ok(f.calls.startApproval[0].tools.length > 0, "the same grants as a handoff");
    assert.equal(f.world.records.length, 0);
    assert.equal(await readOr(seatFile(f)), null, "a declined task leaves no seat");
    f.world.approval = "approve";
    assert.equal((await f.engine.chatStart(startCall(f))).ok, true);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// US-6: seats are written only after a confirmed launch
// ---------------------------------------------------------------------------

test("AC-6.1/6.2/6.3/6.5 a project without a seat: the seat file appears only once the launch is confirmed (added_by chat, empty brief), the record says seatAdded, the list shows seated:false then true", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.engine.chatProjects(projectsCall(f))).projects.find((p) => p.id === RONDA).seated, false);
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, true);
    assert.equal(r.seatAdded, true, "AC-6.3");
    const text = await readFile(seatFile(f), "utf-8");
    assert.match(text, /added_by: chat/);
    assert.equal(text.split("---\n")[2].trim(), "", "an empty brief");
    // the record: seatOwed was the claim at start, seatAdded the result
    const input = f.calls.startJob[0] ?? f.calls.startApproval[0];
    assert.deepEqual(input.seatOwed, { project: RONDA, projectName: "Ronda" });
    assert.equal("seatAdded" in input, false, "no seatAdded at start");
    assert.deepEqual(f.world.records[0].seatAdded, { project: RONDA, projectName: "Ronda" });
    assert.equal("seatOwed" in f.world.records[0], false);
    assert.equal((await f.engine.chatProjects(projectsCall(f))).projects.find((p) => p.id === RONDA).seated, true);
    // a second task in the same project owes nothing
    const again = await f.engine.chatStart(startCall(f));
    assert.equal(again.seatAdded, false);
    assert.equal("seatOwed" in (f.calls.startJob[1] ?? f.calls.startApproval[1]), false);
  } finally {
    await f.cleanup();
  }
});

test("AC-6.1/6.4 while the launch waits on the approval card NO seat file exists; a refusal at any point (declined, cap, ownership recheck, start failure) never writes one", async () => {
  const f = await fixture();
  try {
    f.world.cfg = { chatAutoAllow: false };
    let open;
    f.world.gate = new Promise((r) => (open = r));
    const pending = f.engine.chatStart(startCall(f));
    await until(() => f.calls.startApproval.length === 1);
    assert.equal(await readOr(seatFile(f)), null, "nothing is written before the launch is confirmed");
    open();
    assert.equal((await pending).ok, true);
    assert.ok(await readOr(seatFile(f)));
    // the refusals
    await rm(seatFile(f));
    f.world.gate = null;
    f.world.records.length = 0;
    f.world.cap = true;
    await f.engine.chatStart(startCall(f));
    f.world.cap = false;
    f.world.approval = "declined";
    await f.engine.chatStart(startCall(f));
    assert.equal(await readOr(seatFile(f)), null);
  } finally {
    await f.cleanup();
  }
});

test("AC-6.6 a seats folder or seat file that is a link refuses BEFORE anything is created, with the sentence; nothing is written", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.base, "elsewhere"), { recursive: true });
    await symlink(join(f.base, "elsewhere"), join(f.root, "dev", "seats"));
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, false);
    assert.match(r.error, /^Couldn't add Dev to Ronda: .+; nothing was started$/);
    nothingCreated(f);
    assert.deepEqual(await readdir(join(f.base, "elsewhere")), [], "nothing written through the link");
    // a seat FILE that is a link
    await rm(join(f.root, "dev", "seats"));
    await mkdir(join(f.root, "dev", "seats"));
    await symlink(join(f.base, "elsewhere", "x.md"), seatFile(f));
    const r2 = await f.engine.chatStart(startCall(f));
    assert.match(r2.error, /^Couldn't add Dev to Ronda: .+; nothing was started$/);
    nothingCreated(f);
  } finally {
    await f.cleanup();
  }
});

test("AC-6.6 a write that fails AFTER a confirmed launch doesn't stop the task: the record keeps seatOwed, and the next reconcile writes the seat", async () => {
  const fail = { on: true };
  const f = await fixture({
    fs: {
      ...fsPromises,
      rename: async (...a) => {
        if (fail.on && String(a[1]).includes("/seats/")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return fsPromises.rename(...a);
      },
    },
  });
  try {
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, true, "the running task is not stopped");
    assert.equal(r.seatAdded, false);
    assert.equal(await readOr(seatFile(f)), null);
    assert.deepEqual(f.world.records[0].seatOwed, { project: RONDA, projectName: "Ronda" });
    fail.on = false;
    await f.engine.reconcile();
    assert.match(await readFile(seatFile(f), "utf-8"), /added_by: chat/);
    assert.equal("seatOwed" in f.world.records[0], false);
    assert.deepEqual(f.world.records[0].seatAdded, { project: RONDA, projectName: "Ronda" });
  } finally {
    await f.cleanup();
  }
});

test("AC-6.7 two simultaneous starts for one unseated project: approved + declined (either order) → one seat, the approved task has seatAdded; both declined → none; both approved → one seat, one seatAdded", async () => {
  const run = async (decisions, { firstCall = "A" } = {}) => {
    const f = await fixture();
    f.world.cfg = { chatAutoAllow: false };
    f.world.decide = (i) => decisions[i.title];
    const a = startCall(f, { title: "A", brief: "task A" });
    const b = startCall(f, { title: "B", brief: "task B" });
    const results = await Promise.all((firstCall === "A" ? [a, b] : [b, a]).map((body) => f.engine.chatStart(body)));
    const seatCount = (await readdir(join(f.root, "dev", "seats")).catch(() => [])).filter((n) => n === `${RONDA}.md`).length;
    return { f, results, seatCount, byTitle: (t) => f.world.records.find((r) => r.title === t) };
  };
  for (const firstCall of ["A", "B"]) {
    const mixed = await run({ A: "approve", B: "declined" }, { firstCall });
    try {
      assert.equal(mixed.seatCount, 1);
      assert.deepEqual(mixed.byTitle("A").seatAdded, { project: RONDA, projectName: "Ronda" });
      assert.equal(mixed.byTitle("B"), undefined, "the declined one created nothing");
    } finally {
      await mixed.f.cleanup();
    }
    const other = await run({ A: "declined", B: "approve" }, { firstCall });
    try {
      assert.equal(other.seatCount, 1);
      assert.ok(other.byTitle("B").seatAdded);
      assert.equal(other.byTitle("A"), undefined);
    } finally {
      await other.f.cleanup();
    }
    const none = await run({ A: "declined", B: "timeout" }, { firstCall });
    try {
      assert.equal(none.seatCount, 0);
      assert.equal(none.f.world.records.length, 0);
    } finally {
      await none.f.cleanup();
    }
    const both = await run({ A: "approve", B: "approve" }, { firstCall });
    try {
      assert.equal(both.seatCount, 1);
      const added = both.f.world.records.filter((r) => r.seatAdded);
      assert.equal(added.length, 1, "exactly one record has seatAdded");
      const neither = both.f.world.records.find((r) => !r.seatAdded);
      assert.equal("seatOwed" in neither, false, "the other has neither seatAdded nor seatOwed");
    } finally {
      await both.f.cleanup();
    }
  }
});

test("§6.7 an uncertain launch is not confirmed: no seat yet; the reconcile writes it once the record says running, and never for a record that is gone", async () => {
  const f = await fixture();
  try {
    f.world.launchState = "uncertain";
    const r = await f.engine.chatStart(startCall(f));
    assert.equal(r.ok, true);
    assert.equal(r.seatAdded, false);
    assert.equal(await readOr(seatFile(f)), null);
    await f.engine.reconcile();
    assert.equal(await readOr(seatFile(f)), null, "still uncertain: wait");
    f.world.records[0].launchState = "running"; // the delegate's own reconcile confirmed it
    await f.engine.reconcile();
    assert.match(await readFile(seatFile(f), "utf-8"), /added_by: chat/);
    assert.deepEqual(f.world.records[0].seatAdded, { project: RONDA, projectName: "Ronda" });
    // a refused launch removed its record: nothing owed, nothing written
    const g = await fixture();
    try {
      await g.engine.reconcile();
      assert.equal(await readOr(seatFile(g)), null);
    } finally {
      await g.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test("AC-7.8 after the opening prompt was accepted but before the seat was written, a boot (init) reconcile writes the seat", async () => {
  const f = await fixture();
  try {
    // a confirmed running task whose seat was never written (the process died in between)
    f.world.records.push({ id: "jobX", status: "running", launchState: "running", agent: "agent-dev", startedFrom: "agent-chat", project: { slug: RONDA, name: "Ronda" }, seatOwed: { project: RONDA, projectName: "Ronda" } });
    await f.engine.init();
    assert.match(await readFile(seatFile(f), "utf-8"), /added_by: chat/);
    assert.deepEqual(f.world.records[0].seatAdded, { project: RONDA, projectName: "Ronda" });
    // an existing seat (made by someone else meanwhile): owed is cleared with no seatAdded
    await rm(seatFile(f));
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(seatFile(f), "A brief the user wrote.\n");
    f.world.records.push({ id: "jobY", status: "running", launchState: "running", agent: "agent-dev", startedFrom: "agent-chat", seatOwed: { project: RONDA, projectName: "Ronda" } });
    await f.engine.reconcile();
    assert.equal("seatOwed" in f.world.records[1], false);
    assert.equal("seatAdded" in f.world.records[1], false);
    assert.equal(await readFile(seatFile(f), "utf-8"), "A brief the user wrote.\n", "never overwritten");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the launch / Clear fence (§6.5)
// ---------------------------------------------------------------------------

const CLEAR_REFUSED = (n, name = "Dev") => `${name} has ${n} task${n === 1 ? "" : "s"} running from this conversation; wait for ${n === 1 ? "it" : "them"} or stop ${n === 1 ? "it" : "them"} first`;

test("AC-7.6 Clear while a start waits on the approval card: Clear is refused (the in-flight launch counts) and the launch completes normally on approval", async () => {
  const f = await fixture();
  try {
    f.world.cfg = { chatAutoAllow: false };
    let open;
    f.world.gate = new Promise((r) => (open = r));
    const pending = f.engine.chatStart(startCall(f));
    await until(() => f.calls.startApproval.length === 1);
    await assert.rejects(f.engine.clearChat({ slug: "dev" }), { message: CLEAR_REFUSED(1) });
    assert.equal(f.calls.createSession.length, 0, "nothing changed");
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "dev", ".chat.json"), "utf-8")), { sessionId: SES });
    open();
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(f.world.records[0].parentSessionID, SES, "the task belongs to the conversation it was started from");
  } finally {
    await f.cleanup();
  }
});

test("AC-7.7 Clear first: a start that reaches its durable start after the conversation was replaced is refused by the ownership recheck, nothing created, no seat", async () => {
  const f = await fixture();
  try {
    f.world.cfg = { chatAutoAllow: false };
    let open;
    f.world.gate = new Promise((r) => (open = r));
    const pending = f.engine.chatStart(startCall(f));
    await until(() => f.calls.startApproval.length === 1);
    // the fence stubbed: the stored conversation is replaced by hand while the card waits (a bug in the fence, a hand edit)
    await writeFile(join(f.root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_replacement" }));
    f.world.sessions.ses_replacement = { id: "ses_replacement", directory: join(f.root, "dev", "home") };
    open();
    refused(await pending, OWN_CHAT_ONLY);
    assert.equal(f.world.records.length, 0);
    assert.equal(await readOr(seatFile(f)), null);
  } finally {
    await f.cleanup();
  }
});

test("AC-10.3 Clear is refused while a task started from the conversation is running or paused (singular and plural wording); finished ones and other chats' tasks don't count; the store can't be read: a retry sentence", async () => {
  const f = await fixture();
  try {
    const mk = (id, status, extra = {}) => ({ id, status, launchState: "running", parentSessionID: SES, startedFrom: "agent-chat", agent: "agent-dev", ...extra });
    f.world.records.push(mk("a", "running"));
    await assert.rejects(f.engine.clearChat({ slug: "dev" }), { message: CLEAR_REFUSED(1) });
    f.world.records.push(mk("b", "paused"), mk("c", "done"), mk("d", "failed"), mk("e", "running", { parentSessionID: "ses_other" }), mk("f", "running", { startedFrom: undefined }));
    await assert.rejects(f.engine.clearChat({ slug: "dev" }), { message: CLEAR_REFUSED(2) });
    assert.equal(f.calls.createSession.length, 0);
    f.world.records.splice(0, f.world.records.length, mk("c", "done"));
    assert.equal((await f.engine.clearChat({ slug: "dev" })).sessionId, "ses_new1");
    f.world.recordsFail = true;
    await assert.rejects(f.engine.clearChat({ slug: "dev" }), { message: "Couldn't check this conversation's tasks; try again" });
  } finally {
    await f.cleanup();
  }
});

test("AC-7.8 a record that is running or paused counts for Clear whatever its launch state", async () => {
  const f = await fixture();
  try {
    f.world.records.push({ id: "u", status: "running", launchState: "uncertain", parentSessionID: SES, startedFrom: "agent-chat" });
    await assert.rejects(f.engine.clearChat({ slug: "dev" }), { message: CLEAR_REFUSED(1) });
  } finally {
    await f.cleanup();
  }
});

test("AC-7.8 a restart before the record was written: no job, no seat, no approval card state — Clear is allowed (the launch registry is memory only)", async () => {
  const f = await fixture();
  try {
    f.world.cfg = { chatAutoAllow: false };
    f.world.gate = new Promise(() => {}); // an approval that never comes: the process dies here
    void f.engine.chatStart(startCall(f));
    await until(() => f.calls.startApproval.length === 1);
    assert.equal(f.world.records.length, 0);
    assert.equal(await readOr(seatFile(f)), null);
    // a fresh engine over the same folders (the restart): nothing in flight, so Clear is allowed
    const restarted = createAgentsEngine({
      root: f.root,
      home: f.home,
      templatesDir: join(f.base, "templates"),
      isGitRepo: async () => true,
      editConfig: fakeConfigWriter({ cfg: { agent: {} }, edits: [], reloads: 0 }),
      reload: async () => ({ ok: true }),
      log: { warn: () => {} },
      oc: { listMessages: async () => [], createSession: async () => ({ id: "ses_after" }), sessionExists: async () => true },
      delegate: { startJob: async () => ({ ok: true, job: { id: "j" } }), loadRecords: async () => f.world.records, loadRecordsStrict: async () => f.world.records },
      tmux: { listProjects: async () => [], newWindow: async () => ({ windowIndex: 1 }), newSession: async () => ({ windowIndex: 0 }), restampSessionId: async () => {} },
      registry: { identify: async () => null, list: async () => [] },
      syncState: { refreshNow: async () => {} },
    });
    assert.equal((await restarted.clearChat({ slug: "dev" })).sessionId, "ses_after");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// US-9: continuing a finished task
// ---------------------------------------------------------------------------

test("AC-9.1/9.2 continueJob: only a finished task of THIS conversation, this agent, started from the chat; the project must match; it keeps the task's project", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.chatStart(startCall(f));
    const job = f.world.records.find((j) => j.id === first.jobId);
    const cant = "That task can't be continued from here";
    // still running
    refused(await f.engine.chatStart(startCall(f, { continueJob: job.id })), cant);
    job.status = "done";
    // wrong project
    refused(await f.engine.chatStart(startCall(f, { continueJob: job.id, project: MANTAUI })), "That task is in Ronda; continue it there or start a new task");
    // not from the chat / another agent / another conversation / an unknown id
    const other = { ...job, id: "o1", startedFrom: undefined };
    const foreign = { ...job, id: "o2", parentSessionID: "ses_other" };
    const mantas = { ...job, id: "o3", agent: "agent-scout" };
    f.world.records.push(other, foreign, mantas);
    for (const id of ["o1", "o2", "o3", "ghost"]) refused(await f.engine.chatStart(startCall(f, { continueJob: id })), cant);
    // the good one
    const before = f.world.records.length;
    const r = await f.engine.chatStart(startCall(f, { continueJob: job.id, brief: "Fix round: also cover retries." }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(f.calls.continueJob[0].id, job.id);
    assert.equal(f.calls.continueJob[0].input.prompt, "Fix round: also cover retries.");
    assert.equal(f.calls.continueJob[0].input.sessionID, SES);
    assert.equal(f.calls.continueJob[0].input.allowPr, false);
    assert.equal(f.world.records.length, before + 1);
    assert.deepEqual([r.project, r.seatAdded], [{ id: RONDA, name: "Ronda" }, false]);
    assert.equal(f.calls.startJob.length + f.calls.startApproval.length, 1, "a continuation starts no new job and reads no memory");
  } finally {
    await f.cleanup();
  }
});

test("AC-7.8/§6.2 a continuation re-checks the ownership at its durable start too", async () => {
  const f = await fixture();
  try {
    const first = await f.engine.chatStart(startCall(f));
    f.world.records[0].status = "done";
    const b = startCall(f, { continueJob: first.jobId });
    // the conversation was replaced between the binding and the durable start: the delegate's admit hook is what notices
    f.world.beforeContinue = async () => {
      await writeFile(join(f.root, "dev", ".chat.json"), JSON.stringify({ sessionId: "ses_replacement" }));
      f.world.sessions.ses_replacement = { id: "ses_replacement", directory: join(f.root, "dev", "home") };
    };
    const r = await f.engine.chatStart(b);
    refused(r, OWN_CHAT_ONLY);
    assert.equal(f.world.records.length, 1, "no continuation was written");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the guidance (FR-009), Needs you (FR-011)
// ---------------------------------------------------------------------------

test("buildAgentChatBrief: every FR-009 point is in the guidance, and the user's levels follow the settings", () => {
  const text = buildAgentChatBrief({ agentName: "Dev", policy: BAL });
  const has = (re, why) => assert.match(text, re, why);
  has(/agent_projects/, "call agent_projects");
  has(/agent_start_task/);
  has(/one question|ONE question/i, "ask with one question when it can't tell");
  has(/recommended/i, "the recommended option first");
  has(/name the project|names? the project/i, "name the project in the reply");
  has(/never.{0,40}(id|folder|path)/i, "never an id or a path");
  has(/stand(s)? alone|self-contained/i, "a standalone brief");
  has(/one line.{0,60}stop|then stop/i, "one line after starting, then stop");
  has(/never (describe or )?guess/i, "never guess the result");
  has(/continueJob/, "the decision-block flow");
  has(/Done in/, "how to report a result");
  has(/can't find|cannot find|isn't on this box|not on this box/i, "an unknown project: say so (AC-4.4)");
  has(/open (the project|it) in Manta/i, "no project with a folder (AC-E1)");
  has(/never start .{0,40}another project|instead/i, "never start in another project instead");
  has(/read-only/i, "read-only wording");
  assert.match(text, /Hand off/, "the user's Hand off level is stated");
  const ask = buildAgentChatBrief({ agentName: "Dev", policy: { ...BAL, handoff: "ask" } });
  assert.match(ask, /confirm with the user in this conversation before starting/i);
  const never = buildAgentChatBrief({ agentName: "Dev", policy: { ...BAL, handoff: "never" } });
  assert.match(never, /turned off|don't start|do not start/i);
  assert.equal(buildAgentChatBrief({ agentName: "Dev", policy: BAL }), text, "deterministic");
});

test("leadBrief for an agent's own conversation is the agent guidance; for any other chat it stays empty; unreadable settings say 'unknown'", async () => {
  const f = await fixture();
  try {
    const r = await f.engine.leadBrief(SES);
    assert.equal(r.status, "ok");
    assert.match(r.text, /agent_start_task/);
    assert.match(r.text, /Dev/);
    f.world.sessions.ses_project = { id: "ses_project", directory: f.folders[RONDA] };
    // an ordinary project chat is led by Manta (its own brief); a task's session gets nothing
    const project = await f.engine.leadBrief("ses_project");
    assert.match(project.text, /^You are Manta/);
    assert.doesNotMatch(project.text, /agent_start_task/);
    f.world.sessions.ses_child = { id: "ses_child", parentID: SES, directory: "/wt/x" };
    assert.deepEqual(await f.engine.leadBrief("ses_child"), { status: "ok", text: "" });
    // the conversation of the lead is still led by it, not given this guidance
    await writeFile(join(f.root, "manta", ".chat.json"), JSON.stringify({ sessionId: "ses_manta" }));
    f.world.sessions.ses_manta = { id: "ses_manta", directory: join(f.root, "manta", "home") };
    const lead = await f.engine.leadBrief("ses_manta");
    assert.match(lead.text, /^You are Manta/);
    assert.doesNotMatch(lead.text, /agent_start_task/);
    const g = await fixture({ autonomyPolicy: async () => { throw new Error("nope"); } });
    try {
      assert.deepEqual(await g.engine.leadBrief(SES), { status: "unknown", reason: "autonomy" });
    } finally {
      await g.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test("AC-3.3 needsYou lists an open question asked in an agent's conversation (agent, question, options, the conversation to open) and counts it; answered or dismissed ones leave; one unreadable conversation is skipped", async () => {
  const f = await fixture();
  try {
    f.world.questions[SES] = [
      { id: "form_1", sessionID: SES, questions: [{ header: "Which project?", question: "Which project is the flaky upload test in?", options: [{ label: "Ronda (Recommended)" }, { label: "MantaUI" }] }] },
    ];
    await writeFile(join(f.root, "scout", ".chat.json"), JSON.stringify({ sessionId: "ses_scout" }));
    f.world.questionsFail.add("ses_scout"); // opencode failing for one conversation
    const n = await f.engine.needsYou();
    assert.equal(n.chatQuestions.length, 1);
    const q = n.chatQuestions[0];
    assert.deepEqual([q.id, q.slug, q.agentName, q.sessionId, q.question], ["form_1", "dev", "Dev", SES, "Which project is the flaky upload test in?"]);
    assert.deepEqual(q.options, ["Ronda (Recommended)", "MantaUI"]);
    assert.equal(typeof q.askedAt, "number");
    assert.equal(n.count, n.questions.length + n.changes.length + n.reviews.length + 1, "the count includes it");
    f.world.questions[SES] = []; // answered in the conversation, or dismissed
    assert.deepEqual((await f.engine.needsYou()).chatQuestions, []);
  } finally {
    await f.cleanup();
  }
});

test("conversation questions come from every Team conversation (Manta's too), never the Architect's, and never from a conversation with no stored session", async () => {
  const f = await fixture();
  try {
    f.world.questions.ses_manta = [{ id: "f", sessionID: "ses_manta", questions: [{ question: "q" }] }];
    f.world.questions.ses_arch = [{ id: "g", sessionID: "ses_arch", questions: [{ question: "q" }] }];
    await writeFile(join(f.root, "manta", ".chat.json"), JSON.stringify({ sessionId: "ses_manta" }));
    await writeFile(join(f.root, "architect", ".chat.json"), JSON.stringify({ sessionId: "ses_arch" }));
    assert.deepEqual((await f.engine.needsYou()).chatQuestions.map((q) => q.slug), ["manta"]);
  } finally {
    await f.cleanup();
  }
});

test("SEAT added_by 'chat' reads back as 'chat' (the Seats tab shows it like 'mention')", async () => {
  const f = await fixture();
  try {
    await f.engine.chatStart(startCall(f));
    const seats = (await f.engine.profile("dev")).seats;
    assert.equal(seats.find((s) => s.project === RONDA).addedBy, "chat");
  } finally {
    await f.cleanup();
  }
});

test("AC-E6 two calls in the same turn for two projects start two tasks, each with its own project, seat check and record", async () => {
  const f = await fixture();
  try {
    const [a, b] = [startCall(f, { project: RONDA, title: "Fix Ronda", brief: "a" }), startCall(f, { project: MANTAUI, title: "Fix MantaUI", brief: "b" })];
    const out = await Promise.all([f.engine.chatStart(a), f.engine.chatStart(b)]);
    assert.deepEqual(out.map((r) => r.ok), [true, true]);
    assert.deepEqual(f.world.records.map((r) => r.project.slug).sort(), [MANTAUI, RONDA].sort());
    assert.ok(await readOr(seatFile(f, RONDA)) && (await readOr(seatFile(f, MANTAUI))), "each project's seat");
    const fleet = JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8"));
    assert.deepEqual(Object.values(fleet.counts)[0].dev, { [RONDA]: 1, [MANTAUI]: 1 });
  } finally {
    await f.cleanup();
  }
});

test("AC-10.2 Needs you's review of a chat task carries the task's own project (not the folder lookup)", async () => {
  const f = await fixture();
  try {
    f.world.records.push({ id: "jr", status: "done", specialist: true, agent: "agent-dev", launchState: "running", endedBlocked: true, finishedAt: 5, createdAt: 1, parentDirectory: "/not/identifiable", parentSessionID: SES, startedFrom: "agent-chat", project: { slug: RONDA, name: "Ronda" }, title: "Fix it", result: "Which one?" });
    const n = await f.engine.needsYou();
    assert.equal(n.reviews.length, 1);
    assert.equal(n.reviews[0].project, RONDA);
  } finally {
    await f.cleanup();
  }
});

test("a task Dev starts from its own conversation is told to the suggestion counter (counted, but never the lead's offer)", async () => {
  const noted = [];
  const f = await fixture({ suggestions: { noteHandoff: (i) => (noted.push(i), { pending: Promise.resolve() }) } });
  try {
    const b = startCall(f, { project: RONDA, title: "Fix Ronda", brief: "Make it pass." });
    const r = await f.engine.chatStart(b);
    assert.equal(r.ok, true);
    assert.equal(noted.length, 1);
    assert.deepEqual(
      { jobId: noted[0].jobId, title: noted[0].title, brief: noted[0].brief, project: noted[0].project, chat: noted[0].chat, lead: noted[0].lead },
      { jobId: r.jobId, title: "Fix Ronda", brief: "Make it pass.", project: RONDA, chat: SES, lead: false },
    );
  } finally {
    await f.cleanup();
  }
});
