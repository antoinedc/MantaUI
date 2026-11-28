// The monthly refresh end to end, over the REAL agents engine and the REAL routines engine (only opencode, tmux and the delegate
// are fakes): provisioning → the run → the agents engine's task → the proposals waiting for a click → the end-of-task hook
// settles the run with the server-written Outcome lines. This is the seam index.mjs wires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "../shared/autonomyShared.mjs";
import { createAgentsEngine } from "./agents.mjs";
import { createRoutinesEngine } from "./routines.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const T0 = Date.parse("2026-11-25T12:00:00Z");

test("refresh flow: the routine's run starts the Architect's task, its proposals follow the user's level (here Ask: they wait for a click), and the task's end settles the run with the Outcome lines", async () => {
  const base = await mkdtemp(join(tmpdir(), "agents-flow-"));
  try {
    const root = join(base, "agents");
    const templatesDir = join(base, "templates");
    await mkdir(templatesDir, { recursive: true });
    for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
    const w = { jobs: [], startJobs: [], sessions: new Map(), prompts: [], store: null, notes: [], clock: T0 };
    let agents; // the routines engine reads the agents engine at call time, as index.mjs does
    const routines = createRoutinesEngine({
      load: async () => (w.store ? JSON.parse(JSON.stringify(w.store)) : null),
      save: async (s) => void (w.store = JSON.parse(JSON.stringify(s))),
      readMemory: async () => "",
      writeMemory: async () => {},
      now: () => w.clock,
      oc: {
        createSession: async (i) => (w.sessions.set(i.id, i), { id: i.id }),
        sendPrompt: async (a) => void w.prompts.push(a),
        readSession: async (id) => (w.sessions.has(id) ? { state: "found", session: { id } } : { state: "missing" }),
        listActiveSessionIds: async () => [],
        abortSession: async () => {},
        deleteSessionRaw: async () => {},
        listMessages: async () => [],
        listRawTimeline: async () => [],
      },
      tmux: { listProjects: async () => [] },
      local: { isDirectory: () => true },
      push: { fireNotify: async (a) => void w.notes.push(a) },
      agents: {
        routineAgent: (slug, dir) => agents.routineAgent(slug, dir),
        refresh: (slug, ctx) => agents.refresh(slug, ctx),
        changesForJob: (id) => agents.changesForJob(id),
        outcomeLinesForJob: (id) => agents.outcomeLinesForJob(id),
      },
      getJob: async (id) => w.jobs.find((j) => j.id === id) ?? null,
      log: () => {},
      mint: (() => {
        let n = 0;
        return () => `ses_run${++n}`;
      })(),
      setTimer: () => {},
    });
    agents = createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      now: () => w.clock,
      isGitRepo: async () => true,
      editConfig: fakeConfigWriter({ cfg: { agent: {} }, edits: [], reloads: 0 }),
      reload: async () => ({ ok: true }),
      log: { warn: () => {} },
      retryDelayMs: 0,
      autonomyPolicy: async () => ({ ...MODES.autonomous, agent_change: "ask" }), // a refresh is a routine round: it releases by the user's level, and at Ask it waits
      // the independent change review a routine round's change goes through (security review H4): clean here
      oc: { listMessages: async () => [], runSynchronousSession: async () => ({ ok: true, text: '{"verdict":"clean","reasons":[]}' }) },
      delegate: {
        startJob: async (i) => {
          w.startJobs.push(i);
          const job = { id: "job_refresh", rootJobId: "job_refresh", status: "running", attempt: 1, specialist: true, agent: i.agent, architect: { rootJobId: "job_refresh", attempt: 1, mode: "routine" }, result: null, error: null };
          w.jobs.push(job);
          return { ok: true, job };
        },
        loadRecords: async () => w.jobs,
        loadRecordsStrict: async () => w.jobs,
      },
      tmux: { listProjects: async () => [{ tmuxSession: "manta-agents", windows: [] }] },
      routines,
      loadSecretsStrict: async () => [],
    });
    await agents.init();

    // provisioned on sync: one routine for Dev, none for Manta or the Architect
    const list = (await routines.summary()).routines ?? w.store.routines;
    const mine = w.store.routines.filter((r) => r.kind === "agent-refresh");
    assert.deepEqual(mine.map((r) => r.agentSlug), ["dev"]);
    assert.equal(list.length >= 1, true);

    // the run: a headless session that is never prompted, and the Architect's task under it
    const { run } = await routines.runNow(mine[0].id);
    await routines.drain();
    const started = w.store.runs.find((r) => r.id === run.id);
    assert.equal(started.status, "running");
    assert.equal(started.jobId, "job_refresh");
    assert.deepEqual(w.prompts, []);
    assert.equal(w.startJobs.length, 1);
    assert.equal(w.startJobs[0].parentSessionID, started.sessionID);
    assert.equal(w.startJobs[0].deliverResult, false);
    assert.match(w.startJobs[0].prompt, /Refresh @dev/);

    // the Architect proposed a change: held until the task ends
    await writeFile(
      join(root, ".changes.json"),
      JSON.stringify({
        version: 2,
        changes: [{ id: "ach_1", kind: "update", slug: "dev", agentName: "Dev", sessionID: started.sessionID, messageID: "", callID: "", state: "held", needsClick: false, reason: null, before: "x", after: "y", createdAt: T0, decidedAt: null, error: null, origin: { kind: "job", jobId: "job_refresh", rootJobId: "job_refresh", attempt: 1 }, mode: "routine", releasedAt: null, decidedBy: null, target: null }],
        proposalSlots: { job_refresh: 1 },
      }),
    );

    // the task ends: the delegate's hook releases the proposals, then settles the run (what index.mjs's afterJobEnded does)
    Object.assign(w.jobs[0], { status: "done", result: "I checked the research it rests on." });
    await agents.reconcile();
    await agents.settleScriptReviews(); // the change review's verdict is in, and the release it allows has been tried
    await routines.settleFromJob(w.jobs[0]);
    const done = w.store.runs.find((r) => r.id === run.id);
    assert.equal(done.status, "done");
    assert.equal(done.report.outcome, "findings", "a proposal is waiting for a click");
    assert.match(done.report.body, /I checked the research it rests on\./);
    assert.match(done.report.body, /Outcome: @dev is waiting for your click on the card \(reason: your setting for changing agents is Ask\)/);
    assert.equal(w.prompts.length, 0, "nothing ever prompted the headless session");
    assert.equal(w.notes.length, 1, "the user is told once");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
