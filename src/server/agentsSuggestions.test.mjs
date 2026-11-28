// The seam between `agents.handoff` / `agent_start_task` and the suggestion counter (AC-4.2b, AC-4.7, AC-4.8): which tasks are counted, that
// counting never delays or fails a handoff, and the whole path from three handoffs to one offer. Fakes for opencode, the delegate and the
// model; the engine of agentSuggestions.mjs is the real one over in-memory stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine } from "./agents.mjs";
import { createAgentSuggestions } from "./agentSuggestions.mjs";
import { baseEngineDeps } from "./fixtures/agentEngineDeps.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const AGENT = (name, isolation) => `---\nname: ${name}\ndescription: Does ${name} things.\nisolation: ${isolation}\n---\nYou are ${name}.\n`;
const CHAT = "ses_chat";

async function world({ labelGate = null, suggestions = "real" } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-suggestions-"));
  const templatesDir = join(base, "templates");
  for (const [slug, iso] of [["dev", "worktree"], ["scout", "none"]]) {
    await mkdir(join(templatesDir, slug), { recursive: true });
    await writeFile(join(templatesDir, slug, "agent.md"), AGENT(slug === "dev" ? "Dev" : "Scout", iso));
  }
  await mkdir(join(templatesDir, "manta"), { recursive: true });
  await copyFile(join(REAL_TEMPLATES, "manta", "agent.md"), join(templatesDir, "manta", "agent.md"));
  const w = { clock: Date.parse("2026-11-28T10:00:00Z"), pubs: [], level: "auto", messages: [], started: [], labelCalls: [], offerCalls: [], docs: { sugg: null, supp: null }, jobs: {}, n: 0 };
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const sugg = createAgentSuggestions({
    store: { load: async () => clone(w.docs.sugg), save: async (d) => void (w.docs.sugg = clone(d)) },
    suppressStore: { load: async () => clone(w.docs.supp), save: async (d) => void (w.docs.supp = clone(d)) },
    generate: async ({ instruction }) => {
      if (/Answer with the label only/.test(instruction)) {
        w.labelCalls.push(instruction);
        if (labelGate) await labelGate;
        return "write release notes";
      }
      w.offerCalls.push(instruction);
      return JSON.stringify({ label: "weekly release notes", verdict: "agent", why: "Own tone." });
    },
    readJobs: async (ids) => Object.fromEntries(ids.filter((id) => w.jobs[id]).map((id) => [id, w.jobs[id]])),
    oc: { readMessageStrict: async () => ({ state: "missing" }), sendPrompt: async () => ({ ok: true }), listActiveSessionIds: async () => [] },
    enabled: async () => true,
    publish: (e) => w.pubs.push(e),
    now: () => w.clock,
    log: { warn: () => {} },
  });
  const config = { cfg: { agent: {} }, edits: [], reloads: 0, failEdit: null, failReload: null };
  const engine = createAgentsEngine({
    ...baseEngineDeps({ root: join(base, "agents"), templatesDir, config, w }),
    ...(suggestions === "none" ? {} : { suggestions: suggestions === "real" ? sugg : suggestions }),
    oc: {
      readSession: async () => ({ state: "found", session: { id: CHAT, directory: "/repo" } }),
      listMessages: async () => w.messages,
      createSession: async () => ({ id: "ses_x" }),
      sessionExists: async () => false,
    },
    delegate: {
      startJob: async (i) => start(i),
      startJobWithApproval: async (i) => start(i),
      continueJob: async (id, i) => ({ ok: true, job: { id: `cont_${id}`, parentSessionID: i.sessionID, status: "running" } }),
      loadRecordsStrict: async () => w.records ?? [],
    },
    isManagedSession: async () => false,
    isCtoSessionStrict: async () => false,
    configGet: async () => ({ chatAutoAllow: true }),
    registry: { identify: async () => ({ slug: "proj-0123456789" }) },
  });
  function start(i) {
    const job = { id: `job${++w.n}`, parentSessionID: i.parentSessionID, status: "running", title: i.title };
    w.started.push(i);
    w.jobs[job.id] = { title: i.title, prompt: i.prompt };
    return { ok: true, job };
  }
  await engine.init();
  return { w, engine, sugg, cleanup: () => rm(base, { recursive: true, force: true }) };
}

let seq = 0;
/** One lead handoff: the transcript the box would show while the call runs, then the call. */
async function handoff(f, { agent = "dev", title, brief, continueJob } = {}) {
  const n = ++seq;
  const b = { sessionID: CHAT, messageID: `msg_a${n}`, callID: `call${n}`, agent, title, brief, ...(continueJob ? { continueJob } : {}) };
  f.w.messages = [
    { info: { id: "msg_user1", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user1", agent: "build" }, parts: [{ type: "tool", tool: "agent_handoff", callID: b.callID, state: { status: "running", input: { agent, title, brief, ...(continueJob ? { continueJob } : {}) } } }] },
  ];
  return f.engine.handoff(b);
}

test("AC-4.2b: three Dev handoffs worded differently become ONE offer: 3 labelling calls + 1 offer call; a fourth adds one label call and no offer", async () => {
  const f = await world();
  try {
    const wordings = [
      ["Write this week's release notes", "Go through the PRs merged since Friday and write the notes for customers."],
      ["Draft the changelog for v2.3", "Summarise what shipped since v2.2, user-facing first."],
      ["Release notes for the mobile app 3.8", "They go in the store listing."],
    ];
    for (const [title, brief] of wordings) assert.equal((await handoff(f, { title, brief })).ok, true);
    await f.sugg.idle();
    assert.equal(f.w.labelCalls.length, 3);
    assert.equal(f.w.offerCalls.length, 1);
    const { offers } = await f.sugg.list({ sessionId: CHAT });
    assert.equal(offers.length, 1);
    assert.equal(offers[0].anchorMessageId, `msg_a${seq}`, "anchored to the Manta message that carried the third handoff");
    assert.equal((await handoff(f, { title: "Release notes 4.0", brief: "Again." })).ok, true);
    await f.sugg.idle();
    assert.equal(f.w.labelCalls.length, 4);
    assert.equal(f.w.offerCalls.length, 1);
    assert.equal((await f.sugg.list({ sessionId: CHAT })).offers.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("AC-4.8: the handoff is never delayed — it returns before the labelling call is answered", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = await world({ labelGate: gate });
  try {
    const r = await handoff(f, { title: "Release notes", brief: "Write them." });
    assert.equal(r.ok, true, "the handoff succeeded while the labelling call is still pending");
    assert.equal(f.w.docs.sugg, null, "nothing counted yet");
    release();
    await f.sugg.idle();
    assert.equal(f.w.docs.sugg.items.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("AC-4.7 / FR-013: only new tasks for Dev are counted — not another agent's, not a follow-up round, not a refused handoff", async () => {
  const f = await world();
  try {
    assert.equal((await handoff(f, { agent: "scout", title: "Look into the logs", brief: "Read them." })).ok, true);
    assert.equal((await handoff(f, { agent: "dev", title: "Write the notes", brief: "Do it.", continueJob: "abcd1234" })).ok, false, "a continuation of an unknown task is refused");
    assert.equal((await handoff(f, { agent: "dev", title: "", brief: "no title" })).ok, false);
    await f.sugg.idle();
    assert.equal(f.w.labelCalls.length, 0);
    assert.equal(f.w.docs.sugg, null);
  } finally {
    await f.cleanup();
  }
});

test("a follow-up round (continueJob) of a finished Dev task is not counted", async () => {
  const f = await world();
  try {
    const first = await handoff(f, { title: "Write the notes", brief: "Do it." });
    await f.sugg.idle();
    f.w.records = [{ id: first.jobId, status: "done", parentSessionID: CHAT, requestedBy: "manta", agent: "agent-dev", isolation: "worktree" }];
    const r = await handoff(f, { title: "Fix round", brief: "Tweak it.", continueJob: first.jobId });
    assert.equal(r.ok, true);
    await f.sugg.idle();
    assert.equal(f.w.labelCalls.length, 1, "only the first task was labelled");
  } finally {
    await f.cleanup();
  }
});

test("a counter that throws, or is absent, never fails or delays a handoff", async () => {
  const throwing = await world({ suggestions: { noteHandoff: () => { throw new Error("boom"); } } });
  const absent = await world({ suggestions: "none" });
  try {
    assert.equal((await handoff(throwing, { title: "Notes", brief: "Do it." })).ok, true);
    assert.equal((await handoff(absent, { title: "Notes", brief: "Do it." })).ok, true);
  } finally {
    await throwing.cleanup();
    await absent.cleanup();
  }
});

test("the counter is told the raw title and brief the lead wrote, the job, the chat and the anchoring message (never the dispatch prompt)", async () => {
  const noted = [];
  const f = await world({ suggestions: { noteHandoff: (i) => (noted.push(i), { pending: Promise.resolve() }) } });
  try {
    const r = await handoff(f, { title: "Write the notes", brief: "Plain brief text." });
    assert.equal(noted.length, 1);
    assert.deepEqual(
      { jobId: noted[0].jobId, title: noted[0].title, brief: noted[0].brief, chat: noted[0].chat, anchorMessageId: noted[0].anchorMessageId, lead: noted[0].lead },
      { jobId: r.jobId, title: "Write the notes", brief: "Plain brief text.", chat: CHAT, anchorMessageId: `msg_a${seq}`, lead: true },
    );
  } finally {
    await f.cleanup();
  }
});
