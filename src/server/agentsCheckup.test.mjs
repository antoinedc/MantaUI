// Architect v2 PR D (spec §5.2): the weekly team check-up in the agents engine — its routine is provisioned once (and not again after the
// user deleted it), its fact sheet is read from the server's own records, and its Architect round is a routine round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine, AGENTS_TMUX_SESSION, AGENT_CHANGE_OFF } from "./agents.mjs";
import { renderSourceMd } from "./agentSkills.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";
import { MODES } from "../shared/autonomyShared.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const T0 = Date.parse("2026-11-30T09:00:00Z");
const H = 3_600_000;
const D = 24 * H;
const A40 = "a".repeat(40);
const B40 = "b".repeat(40);

async function fixture({ templates = ["dev", "manta", "architect"], level = "auto", extra = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-checkup-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of templates) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const w = {
    clock: T0,
    level,
    jobs: [],
    startJobs: [],
    newSessions: [],
    tmuxProjects: [],
    routines: new Map(),
    routineSeq: 0,
    routineCalls: [],
    branches: {},
    library: [],
    trials: {},
    upstream: {},
    checkupPrompt: null,
  };
  const make = (over = {}) =>
    createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      now: () => w.clock,
      isGitRepo: async () => true,
      branchState: async (i) => w.branches[i.branch] ?? "unmerged",
      editConfig: fakeConfigWriter({ cfg: { agent: {} }, edits: [], reloads: 0 }),
      reload: async () => ({ ok: true, reloaded: true }),
      log: { warn: () => {} },
      retryDelayMs: 0,
      autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: w.level }),
      publish: () => {},
      oc: { listMessages: async () => [] },
      delegate: { startJob: async (i) => (w.startJobs.push(i), { ok: true, job: { id: "job_check" } }), loadRecords: async () => w.jobs, loadRecordsStrict: async () => w.jobs },
      tmux: {
        listProjects: async () => w.tmuxProjects,
        newSession: async (i) => (w.newSessions.push(i), (w.tmuxProjects = [{ tmuxSession: i.name, windows: [] }]), { windowIndex: 0 }),
      },
      registry: { identify: async (dir) => (dir === "/repo/site" ? { slug: "site" } : null), list: async () => w.projectList ?? [] },
      library: { lookup: async ({ refs }) => refs.map((ref) => ({ ref, entry: w.library.find((e) => e.id === ref || e.topic === ref) ?? null })) },
      trials: { list: (slug) => w.trials[slug] ?? [], activeTrialKeys: () => new Set() },
      lsRemote: async (repo) => w.upstream[repo] ?? null,
      routines: {
        createInternal: async (input) => {
          w.routineCalls.push(["create", input]);
          const id = `rt${++w.routineSeq}`;
          w.routines.set(id, { id, enabled: true, ...input });
          return w.routines.get(id);
        },
        update: async (id, patch) => (w.routineCalls.push(["update", id, patch]), Object.assign(w.routines.get(id) ?? {}, patch)),
        remove: async (id) => (w.routineCalls.push(["remove", id]), { deleted: w.routines.delete(id) }),
        get: async (id) => {
          if (!w.routines.has(id)) throw Object.assign(new Error("That routine no longer exists."), { rpcStatus: 404 });
          return { routine: w.routines.get(id), memory: "", runs: [] };
        },
      },
      loadSecretsStrict: async () => [],
      createScanner: () => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) }),
      ...extra,
      ...over,
    });
  return { base, root, w, make, engine: make(), putChanges: async (changes) => {
      const kept = JSON.parse(await readFile(join(root, ".changes.json"), "utf-8").catch(() => '{"changes":[]}')).changes;
      await writeFile(join(root, ".changes.json"), JSON.stringify({ version: 2, changes: [...kept, ...changes], proposalSlots: {} }));
    }, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const task = (over = {}) => ({ id: "j1", rootJobId: "j1", specialist: true, agent: "agent-dev", status: "done", createdAt: T0 - 2 * D, startedAt: T0 - 2 * D, finishedAt: T0 - 2 * D + 10 * 60_000, parentDirectory: "/repo/site", name: "fix the build", isolation: "worktree", ...over });
const checkups = (f) => f.w.routineCalls.filter((c) => c[0] === "create" && c[1].kind === "fleet-checkup");

test("provisioning: the check-up routine is made once, on the Architect's home, weekly on Monday at 9; not again, even after the user deleted it", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    assert.equal(checkups(f).length, 1);
    const input = checkups(f)[0][1];
    assert.deepEqual({ kind: input.kind, agentSlug: input.agentSlug, name: input.name, cron: input.cron, enabled: input.enabled, rollUp: input.rollUp, access: input.access, directory: input.directory }, { kind: "fleet-checkup", agentSlug: undefined, name: "Team check-up", cron: "0 9 * * 1", enabled: true, rollUp: true, access: "read", directory: join(f.root, "architect", "home") });
    const fleet = JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8"));
    assert.equal(fleet.checkup, "rt2" === fleet.checkup ? "rt2" : fleet.checkup);
    assert.match(fleet.checkup, /^rt\d+$/);
    await f.engine.sync();
    await f.engine.list();
    assert.equal(checkups(f).length, 1, "idempotent");
    // deleted on the Routines page: it stays deleted (a tombstone), nobody remakes it
    f.w.routines.delete(fleet.checkup);
    await f.engine.sync();
    assert.equal(checkups(f).length, 1);
    // refresh routines still follow their own rules
    assert.equal(f.w.routineCalls.filter((c) => c[0] === "create" && c[1].kind === "agent-refresh").length, 1);
    // the check-up routine is no agent's refresh routine and is never removed with an agent
    assert.deepEqual(f.w.routineCalls.filter((c) => c[0] === "remove"), []);
  } finally {
    await f.cleanup();
  }
});

test("provisioning: without an Architect on the box there is nothing to check with, so nothing is made and nothing is recorded (it is made once the Architect exists)", async () => {
  const f = await fixture({ templates: ["dev", "manta"] });
  try {
    await f.engine.init();
    assert.equal(checkups(f).length, 0);
    assert.equal(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).checkup, undefined);
  } finally {
    await f.cleanup();
  }
});

test("the fact sheet: how tasks ended, undone changes, learned rules, idle agents — over the server's own records, per team agent (not the lead, not the Architect)", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "scout", "home"), { recursive: true });
    await writeFile(join(f.root, "scout", "agent.md"), "---\nname: Scout\ndescription: Looks things up.\nisolation: none\n---\nScout.\n");
    f.w.jobs = [
      task({ id: "a", rootJobId: "a", createdAt: T0 - 1 * D }),
      task({ id: "b", rootJobId: "b", status: "failed", error: "boom", createdAt: T0 - 2 * D }),
      task({ id: "c", rootJobId: "c", createdAt: T0 - 20 * D, startedAt: T0 - 20 * D, finishedAt: T0 - 20 * D + 30 * 60_000 }),
      task({ id: "arch", rootJobId: "arch", agent: "agent-architect" }),
    ];
    await f.engine.learnedWrite({ slug: "dev", scope: "site", rule: { rule: "Keep PRs small.", why: "w", whyIsInferred: false, quote: "keep the pull requests small", sourceJobId: "a" } });
    await f.putChanges([
      { id: "ach_u", kind: "update", slug: "dev", agentName: "Dev", sessionID: "s", messageID: "", callID: "", state: "undone", needsClick: false, reason: null, before: "x", after: "y", createdAt: T0 - 3 * D, decidedAt: T0 - 2 * D, error: null, origin: { kind: "job", jobId: "j9", rootJobId: "j9", attempt: 1 } },
    ]);
    const sheet = await f.engine.factSheet();
    assert.deepEqual(sheet.agents.map((a) => a.slug), ["dev", "scout"], "specialists only");
    const dev = sheet.agents[0];
    assert.deepEqual(dev.tasks.d7, { run: 2, finished: 1, failed: 1, stalled: 0, cutOff: 0, needsDecision: 0 });
    assert.equal(dev.tasks.d30.run, 3);
    assert.equal(dev.tasks.medianMinutes30, 20, "the median of the 10 and the 30 minutes of the two finished tasks");
    assert.equal(dev.changesUndone.d30, 1);
    assert.equal(dev.learned.active, 1);
    assert.equal(dev.learned.added30, 1);
    assert.equal(dev.learned.rules[0].rule, "Keep PRs small.");
    assert.equal(dev.idle, false);
    assert.equal(typeof dev.instructionChars, "number");
    const scout = sheet.agents[1];
    assert.equal(scout.idle, true);
    assert.equal(scout.tasks.d30.run, 0);
  } finally {
    await f.cleanup();
  }
});

test("the fact sheet: finished branches that waited more than a day without landing — Manta-handed ones too — and not the landed or the recent ones", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const finished = (id, hoursAgo, extra = {}) => task({ id, rootJobId: id, branch: `agent/dev/${id}`, filesChanged: 3, createdAt: T0 - hoursAgo * H - 600_000, startedAt: T0 - hoursAgo * H - 600_000, finishedAt: T0 - hoursAgo * H, ...extra });
    f.w.jobs = [finished("old", 52), finished("handed", 30, { requestedBy: "manta", name: "handed work" }), finished("landed", 60), finished("recent", 3), finished("nofiles", 70, { filesChanged: 0 }), finished("failed", 70, { status: "failed" })];
    f.w.branches = { "agent/dev/landed": "landed" };
    const sheet = await f.engine.factSheet();
    assert.deepEqual(sheet.unmergedBranches.map((b) => b.branch).sort(), ["agent/dev/handed", "agent/dev/old"]);
    const old = sheet.unmergedBranches.find((b) => b.branch === "agent/dev/old");
    assert.deepEqual({ agent: old.agent, task: old.task, files: old.files, hours: old.hoursSinceFinished, project: old.project }, { agent: "dev", task: "fix the build", files: 3, hours: 52, project: "site" });
  } finally {
    await f.cleanup();
  }
});

test("the fact sheet: sentences repeated across 3 agents, references that no longer resolve, research gone stale, failed trials, skills whose upstream moved", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const shared = "Always run the full test suite before you report that the work is finished.";
    for (const slug of ["scout", "writer"]) {
      await mkdir(join(f.root, slug, "home"), { recursive: true });
      // a missing file in a project and in the agent's own folder is reported; anything elsewhere on the box is never probed (L2)
      await writeFile(join(f.root, slug, "agent.md"), `---\nname: ${slug}\ndescription: Does ${slug}.\nisolation: none\n---\n${shared}\nAsk @ghost when unsure, read /opt/gone-for-good/guide.md and ~/site/gone.md first, and keep notes in ~/agents/${slug}/home/notes.md, never ~/site/../outside.md.\n`);
    }
    const devFile = join(f.root, "dev", "agent.md");
    await writeFile(devFile, `${await readFile(devFile, "utf-8")}\n${shared}\n`);
    // a copied skill, taken at a commit the upstream has moved past
    await mkdir(join(f.root, "dev", "skills", "audit"), { recursive: true });
    await writeFile(join(f.root, "dev", "skills", "audit", "SKILL.md"), "---\nname: audit\ndescription: Audits.\n---\nBody\n");
    await writeFile(join(f.root, "dev", "skills", "audit", "SOURCE.md"), renderSourceMd({ url: `https://github.com/acme/skills/blob/${A40}/audit/SKILL.md`, sourceId: "s", repo: "acme/skills", ref: A40, licence: "MIT", taken: "whole" }, { copied: ["SKILL.md"] }));
    f.w.upstream = { "acme/skills": { head: B40 } };
    // research an applied change rested on, now stale
    f.w.library = [{ id: "rl_1", topic: "CRO copywriting", status: "stale", thin: false, ageDays: 120, shelfLifeDays: 90, sourceCount: 4 }];
    await f.putChanges([{ id: "ach_r", kind: "update", slug: "writer", agentName: "writer", sessionID: "s", messageID: "", callID: "", state: "applied", needsClick: false, reason: null, before: "x", after: "y", createdAt: T0 - 5 * D, decidedAt: T0 - 5 * D, error: null, origin: { kind: "job", jobId: "j9", rootJobId: "j9", attempt: 1 }, basis: [{ id: "rl_1", topic: "CRO copywriting", sourceCount: 4, ageDays: 2 }] }]);
    f.w.trials = { scout: [{ id: "tr_1", createdAt: T0 - 2 * D, cases: [{ name: "a", state: "failed" }, { name: "b", state: "done" }] }, { id: "tr_old", createdAt: T0 - 90 * D, cases: [{ name: "a", state: "failed" }] }] };
    await mkdir(join(f.base, "site"), { recursive: true });
    f.w.projectList = [{ slug: "site", paths: [join(f.base, "site")] }];
    const sheet = await f.make({ home: f.base }).factSheet(); // the box's home is the temp folder: ~/agents is the agents' root

    assert.equal(sheet.team.repeatedSentences.length, 1);
    assert.deepEqual(sheet.team.repeatedSentences[0].agents, ["dev", "scout", "writer"]);
    const by = Object.fromEntries(sheet.agents.map((a) => [a.slug, a]));
    assert.deepEqual(by.scout.brokenReferences.sort(), ["@ghost", "~/agents/scout/home/notes.md", "~/site/gone.md"]);
    assert.deepEqual(by.dev.brokenReferences, []);
    assert.deepEqual(by.writer.research.stale, ["CRO copywriting"]);
    assert.equal(by.scout.trialsFailed30, 1, "only trials of the last 30 days");
    assert.deepEqual(by.dev.skillUpdates.map((u) => [u.skill, u.repo]), [["audit", "acme/skills"]]);
  } finally {
    await f.cleanup();
  }
});

test("agents.checkup: starts the Architect's routine round under the run's headless session with the fact sheet, the agents with something to look at named so their files and learned rules come along; no result is posted", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    f.w.jobs = [task({ id: "a", rootJobId: "a", status: "failed", error: "boom", createdAt: T0 - D }), task({ id: "ok", rootJobId: "ok", createdAt: T0 - 3 * D })];
    await f.engine.learnedWrite({ slug: "dev", scope: "site", rule: { rule: "Keep PRs small.", why: "w", whyIsInferred: false, quote: "keep the pull requests small", sourceJobId: "a" } });
    await f.engine.learnedWrite({ slug: "architect", scope: "_all", rule: { rule: "Cite the page you read.", why: "w", whyIsInferred: false, quote: "always cite the page you read", sourceJobId: "z" } });
    const res = await f.engine.checkup({ runId: "run1", runSessionId: "ses_run" });
    assert.deepEqual(res, { jobId: "job_check" });
    assert.equal(f.w.newSessions.length, 1);
    assert.equal(f.w.newSessions[0].name, AGENTS_TMUX_SESSION);
    const input = f.w.startJobs[0];
    assert.equal(input.title, "Team check-up", "the task is titled like its routine");
    assert.equal(input.parentSessionID, "ses_run");
    assert.equal(input.parentDirectory, "/h");
    assert.equal(input.agent, "agent-architect");
    assert.equal(input.targetProject, AGENTS_TMUX_SESSION);
    assert.equal(input.deliverResult, false);
    assert.deepEqual(input.architect, { mode: "routine" });
    assert.equal(input.specialist, true);
    assert.equal(input.isolation, "none");
    assert.match(input.prompt, /Check the team: propose only changes the facts and your research support \(max 3\)/);
    assert.match(input.prompt, /BEGIN FACT SHEET/);
    assert.match(input.prompt, /"slug": "dev"/);
    assert.doesNotMatch(input.prompt, /Research library/, "the research guidance lives once, in the agent's base block, not in the task");
    assert.match(input.prompt, /Current file of @dev/, "an agent with something to look at comes with its file");
    assert.match(input.prompt, /Learned preferences of @dev[^\n]*\n- \[lr_[0-9a-f]{8}\] \(site\) Keep PRs small\./);
    assert.match(input.prompt, /Preferences the user has shown/, "the Architect's own learned rules, as in any task");
    assert.match(input.prompt, /Cite the page you read\./);
    // the highlights are kept for the routine's report
    const lines = await f.engine.checkupHighlights("job_check");
    assert.ok(lines.some((l) => /@dev: 1 of 2 tasks failed this week/.test(l)), lines.join("|"));
    assert.deepEqual(await f.engine.checkupHighlights("job_nope"), []);
    // refusals are sentences
    f.w.level = "never";
    await assert.rejects(f.engine.checkup({ runId: "r", runSessionId: "s" }), new RegExp(AGENT_CHANGE_OFF));
  } finally {
    await f.cleanup();
  }
  const noArch = await fixture({ templates: ["dev", "manta"] });
  try {
    await noArch.engine.init();
    await assert.rejects(noArch.engine.checkup({ runId: "r", runSessionId: "s" }), /The Architect isn't available/);
  } finally {
    await noArch.cleanup();
  }
});
