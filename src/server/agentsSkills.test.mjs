// Architect v2 Stage 2 (docs/superpowers/specs/2026-11-27-architect-v2.md §4): the Architect proposes skills for an agent.
// What the server checks are facts only — limits, that copied text really occurs in a page this task fetched, that the licence
// allows copying, that the searches and candidates the proposal names were really made and returned — never whether a skill is good.
// A real temp folder stands in for ~/.manta/agents; opencode, the jobs store, the research store and the trials are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine, checkDraft } from "./agents.mjs";
import { draftHash } from "./agentTrials.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";
import { MODES } from "../shared/autonomyShared.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const ok = (p) => access(p).then(() => true, () => false);
const AGENT_KEY = "agent-architect";
const QUOTE = "Short, specific rules beat long generic checklists every time";
const USER_PROMPT = "Make an agent that reviews landing pages for conversion problems. Charter: reads, never edits.";

const SKILL_MD = "---\nname: landing-audit\ndescription: Audits a landing page for conversion problems.\n---\n# Landing audit\n\nCheck the headline first.\nThen the call to action.\n";
const CHECKLIST = "# Checklist\n\n- one clear promise above the fold\n- one primary button\n";
const SCRIPT = "#!/bin/sh\necho checking the page\n";
const SOURCE_TEXT = `Upstream page.\n${SKILL_MD}\n--- checklist.md ---\n${CHECKLIST}\n--- scripts/check.sh ---\n${SCRIPT}\nend of page.`;
const MIT_TEXT = "MIT License\n\nCopyright (c) 2026 Acme\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software";
const SKILL_URL = "https://github.com/acme/cro-skills/blob/abc123/landing-audit/SKILL.md";
const PROV = { url: SKILL_URL, sourceId: "src_skill", repo: "acme/cro-skills", ref: "abc123", licence: "MIT", licenseSourceId: "src_lic", taken: "whole", registry: { installs: 12500, stars: null } };
const SKILL_SEARCH = {
  queries: [{ source: "skills", query: "landing pages" }],
  candidates: [{ ref: "acme/cro-skills@landing-audit", installs: 12500, stars: null, licence: "MIT", verdict: "used-whole", why: "most installed and it fits" }],
};
const FIT_CHECK = { researchSays: "Entry 'agent design' (2 days old) says what it says about requests of this kind.", matches: true, why: "The request is the kind the entry covers.", basis: ["rl_subject", "How an agent fits the team"] };
const PROBLEM = {
  userWords: "reviews landing pages for conversion problems",
  statement: "Landing pages ship with conversion problems nobody checks for.",
  shapes: [
    { shape: "a new reviewer agent", wouldBuild: "@cro reviews pages before launch" },
    { shape: "change Dev", wouldBuild: "Dev reviews pages as well as writing code" },
  ],
  chosen: 0,
  why: "Reviewing is a separate job from writing code.",
};

const writtenOp = (over = {}) => ({ name: "landing-audit", op: "add", files: [{ path: "SKILL.md", content: SKILL_MD, origin: "written" }], ...over });
const copiedOp = (over = {}) => ({
  name: "landing-audit",
  op: "add",
  files: [
    { path: "SKILL.md", content: SKILL_MD, origin: "copied", sourceId: "src_skill" },
    { path: "checklist.md", content: CHECKLIST, origin: "copied", sourceId: "src_skill" },
  ],
  provenance: { ...PROV },
  ...over,
});

async function fixture({ level = "auto" } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-skills-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const skillRoot = join(base, "installed-skills");
  await mkdir(join(skillRoot, "dev-helper"), { recursive: true });
  await writeFile(join(skillRoot, "dev-helper", "SKILL.md"), "---\nname: dev-helper\ndescription: Helps with dev chores.\n---\nBody\n");
  const w = {
    level,
    jobs: [
      { id: "job1", childSessionID: "ses_child", parentSessionID: "ses_chat", status: "running", attempt: 1, prompt: USER_PROMPT, architect: { rootJobId: "job1", attempt: 1, mode: "build" } },
      // a later round of the same task: another child session, the same root
      { id: "job1b", childSessionID: "ses_round2", parentSessionID: "ses_chat", status: "done", attempt: 1, rootJobId: "job1", prompt: "Continue.", architect: { rootJobId: "job1", attempt: 1, mode: "build" } },
      // another task entirely
      { id: "job9", childSessionID: "ses_other", parentSessionID: "ses_chat", status: "done", attempt: 1, prompt: "Something else", architect: { rootJobId: "job9", attempt: 1, mode: "build" } },
    ],
    messages: [],
    started: [],
    trials: new Map(),
    clock: 1_700_000_000_000,
    sources: {
      "ses_child:src_skill": { text: SOURCE_TEXT, url: SKILL_URL, finalUrl: "https://raw.githubusercontent.com/acme/cro-skills/abc123/landing-audit/SKILL.md", private: false },
      "ses_child:src_lic": { text: MIT_TEXT, url: "https://github.com/acme/cro-skills/blob/abc123/LICENSE", private: false },
      "ses_child:src_priv": { text: SOURCE_TEXT, url: null, private: true },
      "ses_round2:src_r2": { text: `Round two page.\n${CHECKLIST}`, url: "https://example.com/round2", private: false },
      "ses_other:src_foreign": { text: SOURCE_TEXT, url: SKILL_URL, private: false },
      "ses_child:src_a": { text: `Intro. ${QUOTE}, says the study.`, url: "https://example.com/a", private: false },
    },
    searches: { ses_child: [{ source: "skills", query: "landing pages", refs: ["acme/cro-skills@landing-audit", "acme/cro-skills", "https://skills.sh/acme/cro-skills/landing-audit"] }], ses_round2: [{ source: "github", query: "cro", refs: ["acme/other"] }], ses_other: [{ source: "skills", query: "foreign query", refs: ["foreign/repo@x"] }] },
    library: [
      { id: "rl_subject", topic: "CRO copywriting", scope: "global", ageDays: 2, status: "fresh", shelfLifeDays: 90, sourceCount: 4, thin: false, dominant: false },
      { id: "rl_team", topic: "How an agent fits the team", scope: "global", ageDays: 5, status: "fresh", shelfLifeDays: 60, sourceCount: 3, thin: false, dominant: false },
    ],
    lsRemote: async () => null,
  };
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    home: "/h",
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter(config),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    retryDelayMs: 0,
    now: () => w.clock,
    autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: w.level }),
    listApprovedModels: async () => ["anthropic/claude-sonnet-5-5"],
    publish: () => {},
    oc: { listMessages: async () => w.messages },
    delegate: { loadRecordsStrict: async () => w.jobs, startJob: async (a) => (w.started.push(a), { ok: true, job: { id: "job_refresh" } }) },
    tmux: { listProjects: async () => [], newSession: async () => {} },
    skillRoots: [skillRoot],
    research: { getSource: async (child, id) => w.sources[`${child}:${id}`] ?? null, searchesOf: async (child) => w.searches[child] ?? [] },
    trials: { get: (id) => w.trials.get(id) ?? null, transcript: async () => "I applied the skill and it worked fine on the page.", activeTrialKeys: () => new Set() },
    library: {
      lookup: async ({ refs }) => refs.map((ref) => ({ ref, entry: w.library.find((e) => e.id === ref || e.topic.toLowerCase() === String(ref).trim().toLowerCase()) ?? null })),
    },
    lsRemote: (...a) => w.lsRemote(...a),
    loadSecretsStrict: async () => [],
    createScanner: () => ({ scan: async () => ({ clean: true, unavailable: false, hits: [] }) }),
  });
  await engine.init();
  return { base, root, engine, w, config, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const bound = (f) => ({ jobs: f.w.jobs, stamp: { rootJobId: "job1" }, childSessionID: "ses_child" });
const planFor = async (f, draft, extra = {}) => {
  const baseHash = (await f.engine.readAgentSnapshot("dev")).hash;
  return f.engine.trialPlan({ action: "update", agent: "dev", baseHash, draft, ...extra }, { dir: "/t/x", bound: bound(f) });
};
const store = async (f) => JSON.parse(await readFile(join(f.root, ".changes.json"), "utf-8"));
const storeOrEmpty = async (f) => store(f).catch((e) => (e?.code === "ENOENT" ? { changes: [], proposalSlots: {} } : Promise.reject(e)));

let seq = 0;
let trialSeq = 0;
const KEYS = ["action", "draft", "summary", "evidence", "admission", "fitCheck", "problem", "trial", "agent", "baseHash", "skillSearch"];
// a trial of exactly the proposal's draft, as the trials module would keep it
async function trialFor(f, b) {
  const plan = await f.engine.trialPlan({ action: b.action, agent: b.agent, draft: b.draft, baseHash: b.baseHash }, { dir: "/t/x", bound: bound(f) });
  if (plan.error) return undefined;
  const id = `tr_${++trialSeq}`;
  f.w.trials.set(id, { id, rootJobId: "job1", agentSlug: plan.slug, draftHash: draftHash(plan.bundle), files: plan.files, cases: [{ name: "main", expect: "does", state: "done" }] });
  return { trialId: id, verdicts: [{ case: "main", pass: true, quote: "I applied the skill and it worked", note: "fine" }] };
}
async function propose(f, over = {}, { trial } = {}) {
  const n = ++seq;
  const baseHash = (await f.engine.readAgentSnapshot("dev")).hash;
  const b = {
    problem: { ...PROBLEM },
    sessionID: "ses_child",
    messageID: `msg_p${n}`,
    callID: `call_p${n}`,
    action: "update",
    agent: "dev",
    baseHash,
    draft: { skills: [writtenOp()] },
    summary: "Give Dev a landing-page skill.",
    evidence: [{ sourceId: "src_a", quote: QUOTE, claim: "Short specific rules help" }],
    admission: [{ rule: "Audit the headline first", verdict: "general", why: "Backed by the study" }],
    fitCheck: { ...FIT_CHECK },
    skillSearch: JSON.parse(JSON.stringify(SKILL_SEARCH)),
    ...over,
  };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  if (trial === null) delete b.trial;
  else if (trial !== undefined) b.trial = trial;
  else if (!Object.hasOwn(b, "trial")) {
    const made = await trialFor(f, b);
    if (made) b.trial = made;
  }
  f.w.messages = [
    { info: { id: "msg_user", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent: AGENT_KEY }, parts: [{ type: "tool", tool: "agent_propose", callID: b.callID, state: { status: "running", input: Object.fromEntries(KEYS.filter((k) => Object.hasOwn(b, k)).map((k) => [k, b[k]])) } }] },
  ];
  return f.engine.propose(b);
}
const refused = async (f, over, re, opts) => {
  const r = await propose(f, over, opts);
  assert.equal(r.ok, false, `expected a refusal matching ${re}`);
  assert.match(r.error, re);
  assert.equal((await storeOrEmpty(f)).changes.length, 0, "a refusal makes no record");
};
// end the task and release what it held (Auto + build mode applies it)
const release = async (f) => {
  f.w.jobs[0] = { ...f.w.jobs[0], status: "done" };
  await f.engine.reconcile();
};
const lastRec = async (f) => (await store(f)).changes.at(-1);
const skillFile = (f, ...p) => join(f.root, "dev", "skills", ...p);

// ---------------------------------------------------------------------------
// limits (§4.1)
// ---------------------------------------------------------------------------

test("a skill draft is limited: name, paths, size, count — each refusal says which", async () => {
  const f = await fixture();
  try {
    const bad = async (draft, re) => {
      const r = await planFor(f, draft);
      assert.ok(r.error, `expected an error for ${JSON.stringify(draft).slice(0, 100)}`);
      assert.match(r.error, re);
    };
    const file = (path, content = "x") => ({ path, content, origin: "written" });
    await bad({ skills: [writtenOp({ name: "Bad Name" })] }, /name/i);
    await bad({ skills: [writtenOp({ name: "a".repeat(51) })] }, /name/i);
    await bad({ skills: [writtenOp({ op: "swap" })] }, /op/i);
    await bad({ skills: [writtenOp({ extra: 1 })] }, /unknown/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("../x.md")] })] }, /path/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("/etc/x.md")] })] }, /path/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("a/./b.md")] })] }, /path/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file(".hidden")] })] }, /path/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("SOURCE.md")] })] }, /SOURCE\.md/);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("LICENSE")] })] }, /LICENSE/);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("SKILL.md", "again")] })] }, /twice|duplicate/i);
    await bad({ skills: [writtenOp({ files: [file("notes.md")] })] }, /SKILL\.md/);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", "no frontmatter at all")] })] }, /frontmatter|description/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD.replace("name: landing-audit", "name: other-name"))] })] }, /name/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD.replace(/description:.*\n/, ""))] })] }, /description/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("n.md", "a\u0000b")] })] }, /text/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), ...Array.from({ length: 20 }, (_, i) => file(`f${i}.md`))] })] }, /at most 20 files/i);
    await bad({ skills: [writtenOp({ files: [file("SKILL.md", SKILL_MD), file("big.md", "x".repeat(257 * 1024))] })] }, /256 KiB/);
    await bad({ skills: Array.from({ length: 16 }, (_, i) => writtenOp({ name: `s${i}`, files: [file("SKILL.md", SKILL_MD.replace("landing-audit", `s${i}`))] })) }, /at most 15 skills/);
    await bad({ skills: Array.from({ length: 6 }, (_, i) => writtenOp({ name: `s${i}`, files: [file("SKILL.md", SKILL_MD.replace("landing-audit", `s${i}`)), file("big.md", "y".repeat(200 * 1024))] })) }, /1 MiB/);
    await bad({ skills: [writtenOp(), writtenOp()] }, /twice|once/i);
    await bad({ skills: "not a list" }, /skills/i);
    const good = await planFor(f, { skills: [writtenOp()] });
    assert.equal(good.error, undefined, good.error);
  } finally {
    await f.cleanup();
  }
});

test("add, replace and remove must fit what the agent has: an add of an existing skill, a replace or remove of a missing one, files on a remove", async () => {
  const f = await fixture();
  try {
    assert.match((await planFor(f, { skills: [writtenOp({ op: "replace" })] })).error, /no skill named landing-audit/i);
    assert.match((await planFor(f, { skills: [{ name: "landing-audit", op: "remove" }] })).error, /no skill named landing-audit/i);
    assert.match((await planFor(f, { skills: [{ name: "landing-audit", op: "remove", files: [] }] })).error, /no skill named/i);
    // put a skill there, then add it again
    await mkdir(skillFile(f, "landing-audit"), { recursive: true });
    await writeFile(skillFile(f, "landing-audit", "SKILL.md"), SKILL_MD);
    assert.match((await planFor(f, { skills: [writtenOp()] })).error, /already has a skill named landing-audit.*replace/i);
    assert.match((await planFor(f, { skills: [{ name: "landing-audit", op: "remove", files: [{ path: "SKILL.md", content: SKILL_MD, origin: "written" }] }] })).error, /remove.*no files|no files.*remove/i);
    assert.equal((await planFor(f, { skills: [{ name: "landing-audit", op: "remove" }] })).error, undefined);
    assert.equal((await planFor(f, { skills: [writtenOp({ op: "replace" })] })).error, undefined);
  } finally {
    await f.cleanup();
  }
});

test("the lead's own skills can't be changed here, and agent_change never takes a skills field", async () => {
  const f = await fixture();
  try {
    const hash = (await f.engine.readAgentSnapshot("manta")).hash;
    const r = await f.engine.trialPlan({ action: "update", agent: "manta", baseHash: hash, draft: { skills: [writtenOp()] } }, { dir: "/t/x", bound: bound(f) });
    assert.match(r.error, /lead/i);
    assert.match(checkDraft({ skills: [] }, { create: false }).error, /Unknown field "skills"/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the facts about copied files and their licence (§4.1)
// ---------------------------------------------------------------------------

test("the resulting bundle holds every skill file, the server's SOURCE.md and the LICENSE it took from the fetched licence page; the model never sends those", async () => {
  const f = await fixture();
  try {
    const plan = await planFor(f, { skills: [copiedOp()] });
    assert.equal(plan.error, undefined, plan.error);
    assert.equal(plan.bundle["skills/landing-audit/SKILL.md"], SKILL_MD);
    assert.equal(plan.bundle["skills/landing-audit/checklist.md"], CHECKLIST);
    assert.equal(plan.bundle["skills/landing-audit/LICENSE"], MIT_TEXT);
    const source = plan.bundle["skills/landing-audit/SOURCE.md"];
    for (const re of [/https:\/\/github\.com\/acme\/cro-skills\/blob\/abc123\/landing-audit\/SKILL\.md/, /acme\/cro-skills/, /abc123/, /MIT/, /whole/i, /12500/, /SKILL\.md, checklist\.md/]) assert.match(source, re);
    assert.ok(plan.bundle["agent.md"].length > 0);
    assert.ok(plan.needsTrial, "a skill change needs a trial");
    // deterministic: the same draft, the same bytes (the trial's hash must equal the proposal's)
    assert.equal(draftHash((await planFor(f, { skills: [copiedOp()] })).bundle), draftHash(plan.bundle));
  } finally {
    await f.cleanup();
  }
});

test("the draft hash includes the skills: another skill text, another file or a different licence is another hash and the refusal names the files", async () => {
  const f = await fixture();
  try {
    const a = await planFor(f, { skills: [writtenOp()] });
    const b = await planFor(f, { skills: [writtenOp({ files: [{ path: "SKILL.md", content: `${SKILL_MD}Also check the footer.\n`, origin: "written" }] })] });
    assert.notEqual(draftHash(a.bundle), draftHash(b.bundle));
    // a trial that ran on the draft WITHOUT the skill doesn't cover a proposal that adds it
    const noSkill = await f.engine.trialPlan({ action: "update", agent: "dev", baseHash: (await f.engine.readAgentSnapshot("dev")).hash, draft: { instructions: "You write code.\nYou always run the tests." } }, { dir: "/t/y", bound: bound(f) });
    f.w.trials.set("tr_x", { id: "tr_x", rootJobId: "job1", draftHash: draftHash(noSkill.bundle), files: noSkill.files, cases: [{ name: "main", expect: "does", state: "done" }] });
    const r = await propose(f, { draft: { instructions: "You write code.\nYou always run the tests.", skills: [writtenOp()] } }, { trial: { trialId: "tr_x", verdicts: [{ case: "main", pass: true, quote: "I applied the skill and it worked", note: "" }] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /isn't the one the trial ran on/);
    assert.match(r.error, /skills\/landing-audit\/SKILL\.md/);
  } finally {
    await f.cleanup();
  }
});

test("a copied file needs a sourceId of a page this task fetched that really contains it; sources of the task's other rounds count, another task's and a private one never do", async () => {
  const f = await fixture();
  try {
    const one = (file, extra = {}) => ({ skills: [copiedOp({ files: [file], ...extra })] });
    const copied = (over) => ({ path: "SKILL.md", content: SKILL_MD, origin: "copied", sourceId: "src_skill", ...over });
    assert.match((await planFor(f, one({ path: "SKILL.md", content: SKILL_MD, origin: "copied" }))).error, /sourceId/);
    assert.match((await planFor(f, one(copied({ sourceId: "src_nope" })))).error, /src_nope.*wasn't fetched in this task/);
    assert.match((await planFor(f, one(copied({ sourceId: "src_foreign" })))).error, /wasn't fetched in this task/);
    assert.match((await planFor(f, one(copied({ sourceId: "src_priv" })))).error, /private/i);
    assert.match((await planFor(f, one(copied({ content: SKILL_MD.replace("headline", "footer") })))).error, /doesn't occur in source src_skill/);
    // whitespace doesn't matter, case does
    assert.equal((await planFor(f, one(copied({ content: SKILL_MD.replace("Check the headline first.\nThen", "Check  the headline first.\n\n   Then") })))).error, undefined);
    assert.match((await planFor(f, one(copied({ content: SKILL_MD.replace("Check the headline", "check the headline") })))).error, /doesn't occur in source src_skill/);
    // a page of a later round of the same task counts (copied text from it)
    const r2 = await planFor(f, { skills: [copiedOp({ files: [copied(), { path: "checklist.md", content: CHECKLIST, origin: "copied", sourceId: "src_r2" }] })] });
    assert.equal(r2.error, undefined, r2.error);
    // very short copied text proves nothing: it would occur in any page
    const tiny = await planFor(f, { skills: [copiedOp({ files: [copied(), { path: "n.md", content: "Then", origin: "copied", sourceId: "src_skill" }] })] });
    assert.match(tiny.error, /too short/);
  } finally {
    await f.cleanup();
  }
});

test("copying needs provenance whose sourceId was fetched by this task and whose url matches that page", async () => {
  const f = await fixture();
  try {
    const withProv = (p) => ({ skills: [copiedOp({ provenance: p })] });
    assert.match((await planFor(f, { skills: [copiedOp({ provenance: undefined })] })).error, /provenance/i);
    assert.match((await planFor(f, withProv({ ...PROV, sourceId: "src_nope" }))).error, /wasn't fetched in this task/);
    assert.match((await planFor(f, withProv({ ...PROV, sourceId: "src_foreign" }))).error, /wasn't fetched in this task/);
    assert.match((await planFor(f, withProv({ ...PROV, url: "https://evil.example.com/skill" }))).error, /url/i);
    assert.match((await planFor(f, withProv({ ...PROV, url: "http://github.com/acme/cro-skills" }))).error, /url|https/i);
    assert.match((await planFor(f, withProv({ ...PROV, repo: "not a repo" }))).error, /repo/i);
    assert.match((await planFor(f, withProv({ ...PROV, ref: "" }))).error, /ref/i);
    assert.match((await planFor(f, withProv({ ...PROV, taken: "most" }))).error, /taken/i);
    assert.match((await planFor(f, withProv({ ...PROV, registry: { installs: -4, stars: null } }))).error, /registry|installs/i);
    // the url may be the page's final address (after redirects)
    assert.equal((await planFor(f, withProv({ ...PROV, url: "https://raw.githubusercontent.com/acme/cro-skills/abc123/landing-audit/SKILL.md" }))).error, undefined);
    // written-only skills carry no provenance
    assert.match((await planFor(f, { skills: [writtenOp({ provenance: { ...PROV } })] })).error, /provenance/i);
  } finally {
    await f.cleanup();
  }
});

test("the licence allowlist: MIT with its notice is fine; GPL, an unknown or a missing licence refuse the copy; CC0, Unlicense and 0BSD need no notice; the rest do", async () => {
  const f = await fixture();
  try {
    const lic = (licence, extra = {}) => ({ skills: [copiedOp({ provenance: { ...PROV, licence, ...extra } })] });
    for (const l of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC-BY-4.0", "MPL-2.0"]) assert.equal((await planFor(f, lic(l))).error, undefined, l);
    for (const l of ["GPL-3.0", "AGPL-3.0-only", "Proprietary", "NOASSERTION", "", "MIT OR GPL-3.0"]) {
      const r = await planFor(f, lic(l));
      assert.match(r.error, /licen[cs]e/i, l);
      assert.match(r.error, /write your own/i, l);
    }
    const noLicence = await planFor(f, { skills: [copiedOp({ provenance: { ...PROV, licence: undefined } })] });
    assert.match(noLicence.error, /licen[cs]e/i);
    for (const l of ["CC0-1.0", "Unlicense", "0BSD"]) {
      const r = await planFor(f, lic(l, { licenseSourceId: undefined }));
      assert.equal(r.error, undefined, l);
      assert.equal(Object.hasOwn(r.bundle, "skills/landing-audit/LICENSE"), false, "no licence page given, none written");
    }
    for (const l of ["MIT", "Apache-2.0", "CC-BY-4.0"]) assert.match((await planFor(f, lic(l, { licenseSourceId: undefined }))).error, /licenseSourceId/, l);
    assert.match((await planFor(f, lic("MIT", { licenseSourceId: "src_nope" }))).error, /src_nope.*wasn't fetched in this task/);
    assert.match((await planFor(f, lic("MIT", { licenseSourceId: "src_priv" }))).error, /private/i);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// skillSearch (§4.2)
// ---------------------------------------------------------------------------

test("adding a skill needs a skillSearch whose queries were really run in this task and whose candidates were really returned (or are installed on the box)", async () => {
  const f = await fixture();
  try {
    await refused(f, { skillSearch: undefined }, /skillSearch/);
    await refused(f, { skillSearch: { queries: [], candidates: [] } }, /skillSearch.*quer/i);
    await refused(f, { skillSearch: { ...SKILL_SEARCH, queries: [{ source: "skills", query: "never asked" }] } }, /never asked.*wasn't searched|wasn't searched.*never asked/i);
    await refused(f, { skillSearch: { ...SKILL_SEARCH, queries: [{ source: "github", query: "landing pages" }] } }, /wasn't searched/i);
    await refused(f, { skillSearch: { ...SKILL_SEARCH, queries: [{ source: "skills", query: "foreign query" }] } }, /wasn't searched/i, undefined); // another task's search
    await refused(f, { skillSearch: { ...SKILL_SEARCH, candidates: [{ ...SKILL_SEARCH.candidates[0], ref: "made/up@skill" }] } }, /made\/up@skill.*(didn't|wasn't|not)/i);
    await refused(f, { skillSearch: { ...SKILL_SEARCH, candidates: [{ ...SKILL_SEARCH.candidates[0], verdict: "loved-it" }] } }, /verdict/i);
    await refused(f, { skillSearch: { ...SKILL_SEARCH, candidates: [{ ...SKILL_SEARCH.candidates[0], why: "" }] } }, /why/i);
    // a query of an earlier round of the same task counts; whitespace and case in the query don't
    const okRound = await propose(f, { skillSearch: { queries: [{ source: "github", query: " CRO " }, { source: "skills", query: "Landing  pages" }], candidates: [{ ...SKILL_SEARCH.candidates[0], ref: "acme/other", verdict: "rejected", why: "not maintained" }] } });
    assert.equal(okRound.ok, true, okRound.error);
  } finally {
    await f.cleanup();
  }
});

test("a candidate may be a skill installed on this box (skills_installed); replacing or removing a skill needs no skillSearch", async () => {
  const f = await fixture();
  try {
    const r = await propose(f, { skillSearch: { queries: [{ source: "skills", query: "landing pages" }], candidates: [{ ref: "dev-helper", installs: null, stars: null, licence: null, verdict: "rejected", why: "unrelated" }] } });
    assert.equal(r.ok, true, r.error);
    await release(f);
    assert.equal((await lastRec(f)).state, "applied");
    // now replace and remove with no search at all
    f.w.jobs[0] = { ...f.w.jobs[0], status: "running" };
    const r2 = await propose(f, { draft: { skills: [writtenOp({ op: "replace", files: [{ path: "SKILL.md", content: `${SKILL_MD}Also the footer.\n`, origin: "written" }] })] }, skillSearch: undefined });
    assert.equal(r2.ok, true, r2.error);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// applying, the card's diff, Undo, Restore and conflicts (§4.1 snapshots)
// ---------------------------------------------------------------------------

test("a held skill proposal writes nothing; released it writes skills/** through the bundle snapshot, the compiled prompt lists the skill, and the wire carries skillsDiff but no blob contents", async () => {
  const f = await fixture();
  try {
    const r = await propose(f, { draft: { skills: [copiedOp({ files: [...copiedOp().files, { path: "scripts/check.sh", content: SCRIPT, origin: "copied", sourceId: "src_skill" }] })] } });
    assert.equal(r.ok, true, r.error);
    assert.equal(await ok(skillFile(f, "landing-audit")), false, "held = nothing written");
    const diff = r.change.skillsDiff;
    assert.equal(diff.length, 1);
    assert.equal(diff[0].name, "landing-audit");
    assert.equal(diff[0].op, "add");
    assert.deepEqual(diff[0].paths, ["LICENSE", "SKILL.md", "SOURCE.md", "checklist.md", "scripts/check.sh"]);
    assert.deepEqual(diff[0].scripts, ["scripts/check.sh"], "a copied script is flagged on the card");
    assert.equal(diff[0].provenance.repo, "acme/cro-skills");
    assert.equal(diff[0].provenance.licence, "MIT");
    assert.ok(!JSON.stringify(r.change).includes("Check the headline first"), "no skill text on the wire");
    assert.equal(Object.hasOwn(r.change, "beforeBundle"), false);
    await release(f);
    const rec = await lastRec(f);
    assert.equal(rec.state, "applied");
    assert.equal(await readFile(skillFile(f, "landing-audit", "SKILL.md"), "utf-8"), SKILL_MD);
    assert.equal(await readFile(skillFile(f, "landing-audit", "LICENSE"), "utf-8"), MIT_TEXT);
    assert.match(await readFile(skillFile(f, "landing-audit", "SOURCE.md"), "utf-8"), /acme\/cro-skills/);
    assert.equal(await readFile(skillFile(f, "landing-audit", "scripts", "check.sh"), "utf-8"), SCRIPT);
    assert.match(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), /landing-audit.*Audits a landing page/s);
    assert.ok(rec.afterBundle["skills/landing-audit/SKILL.md"], "the snapshot names the skill files");
  } finally {
    await f.cleanup();
  }
});

test("a written skill: no provenance, no SOURCE.md, no script flag; the diff lists its paths", async () => {
  const f = await fixture();
  try {
    const r = await propose(f, { draft: { skills: [writtenOp({ files: [{ path: "SKILL.md", content: SKILL_MD, origin: "written" }, { path: "scripts/run.sh", content: SCRIPT, origin: "written" }] })] } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.change.skillsDiff[0].paths, ["SKILL.md", "scripts/run.sh"]);
    assert.deepEqual(r.change.skillsDiff[0].scripts, [], "only copied scripts are flagged");
    assert.equal(r.change.skillsDiff[0].provenance, null);
    await release(f);
    assert.equal(await ok(skillFile(f, "landing-audit", "SOURCE.md")), false);
  } finally {
    await f.cleanup();
  }
});

test("Undo takes the skill back with every file; Restore of the change does the same from the snapshot; a hand edit to a skill file is a conflict, never overwritten", async () => {
  const f = await fixture();
  try {
    await propose(f);
    await release(f);
    const id = (await lastRec(f)).id;
    assert.equal(await ok(skillFile(f, "landing-audit", "SKILL.md")), true);
    // a hand edit blocks the undo
    await writeFile(skillFile(f, "landing-audit", "SKILL.md"), `${SKILL_MD}by hand\n`);
    const blocked = await f.engine.undo(id);
    assert.equal(blocked.state, "conflict");
    assert.match(await readFile(skillFile(f, "landing-audit", "SKILL.md"), "utf-8"), /by hand/, "untouched");
    // put it back as it was written, then undo
    await writeFile(skillFile(f, "landing-audit", "SKILL.md"), SKILL_MD);
    // the conflicted record can't be undone again; make a fresh change to undo
    f.w.jobs[0] = { ...f.w.jobs[0], status: "running" };
    const r = await propose(f, { draft: { skills: [writtenOp({ name: "second-skill", files: [{ path: "SKILL.md", content: SKILL_MD.replace(/landing-audit/g, "second-skill"), origin: "written" }] })] } });
    assert.equal(r.ok, true, r.error);
    await release(f);
    const second = (await lastRec(f)).id;
    assert.equal((await f.engine.undo(second)).state, "undone");
    assert.equal(await ok(skillFile(f, "second-skill")), false, "the whole skill folder is gone");
    assert.equal(await ok(skillFile(f, "landing-audit", "SKILL.md")), true, "the other skill stays");
    assert.doesNotMatch(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), /second-skill/);
  } finally {
    await f.cleanup();
  }
});

test("Restore puts the agent back to before a skill was added (the snapshot keeps the files)", async () => {
  const f = await fixture();
  try {
    await propose(f);
    await release(f);
    const id = (await lastRec(f)).id;
    assert.equal(await ok(skillFile(f, "landing-audit", "SKILL.md")), true);
    const restored = await f.engine.restore(id);
    assert.equal(restored.state, "applied");
    assert.equal(await ok(skillFile(f, "landing-audit")), false);
  } finally {
    await f.cleanup();
  }
});

test("replace swaps the skill's whole folder (files it no longer has are gone; the diff lists only what changed); remove deletes it; both are undoable", async () => {
  const f = await fixture();
  try {
    const two = writtenOp({ files: [{ path: "SKILL.md", content: SKILL_MD, origin: "written" }, { path: "old.md", content: "old file", origin: "written" }] });
    await propose(f, { draft: { skills: [two] } });
    await release(f);
    f.w.jobs[0] = { ...f.w.jobs[0], status: "running" };
    const changed = writtenOp({ op: "replace", files: [{ path: "SKILL.md", content: `${SKILL_MD}Footer too.\n`, origin: "written" }, { path: "new.md", content: "new file", origin: "written" }] });
    const r = await propose(f, { draft: { skills: [changed] }, skillSearch: undefined });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.change.skillsDiff[0].paths, ["SKILL.md", "new.md", "old.md"]);
    await release(f);
    const replaceId = (await lastRec(f)).id;
    assert.equal(await ok(skillFile(f, "landing-audit", "old.md")), false);
    assert.equal(await readFile(skillFile(f, "landing-audit", "new.md"), "utf-8"), "new file");
    assert.equal((await f.engine.undo(replaceId)).state, "undone");
    assert.equal(await readFile(skillFile(f, "landing-audit", "old.md"), "utf-8"), "old file");
    assert.equal(await ok(skillFile(f, "landing-audit", "new.md")), false);
    // remove
    f.w.jobs[0] = { ...f.w.jobs[0], status: "running" };
    const rm1 = await propose(f, { draft: { skills: [{ name: "landing-audit", op: "remove" }] }, skillSearch: undefined });
    assert.equal(rm1.ok, true, rm1.error);
    assert.equal(rm1.change.skillsDiff[0].op, "remove");
    await release(f);
    assert.equal(await ok(skillFile(f, "landing-audit")), false);
  } finally {
    await f.cleanup();
  }
});

test("a skill change needs a trial: none is refused, and a description-only update still needs none", async () => {
  const f = await fixture();
  try {
    await refused(f, {}, /trial is required/i, { trial: null });
    const r = await propose(f, { draft: { description: "Writes code, carefully." }, skillSearch: undefined }, { trial: null });
    assert.equal(r.ok, true, r.error);
  } finally {
    await f.cleanup();
  }
});

test("a new agent can come with skills: the folder is made with them, Undo removes the folder", async () => {
  const f = await fixture();
  try {
    const draft = { name: "CRO Reviewer", description: "Reviews landing pages.", isolation: "none", instructions: "You review landing pages for conversion problems.", skills: [writtenOp()] };
    const r = await propose(f, { action: "create", agent: undefined, baseHash: undefined, draft });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.change.kind, "create");
    assert.equal(r.change.skillsDiff[0].op, "add");
    await release(f);
    const rec = await lastRec(f);
    assert.equal(rec.state, "applied", rec.error);
    const dir = join(f.root, rec.slug);
    assert.equal(await readFile(join(dir, "skills", "landing-audit", "SKILL.md"), "utf-8"), SKILL_MD);
    assert.match(await readFile(join(dir, ".compiled.md"), "utf-8"), /landing-audit/);
    assert.equal((await f.engine.undo(rec.id)).state, "undone");
    assert.equal(await ok(dir), false, "the whole folder is gone");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// skills_installed, the profile
// ---------------------------------------------------------------------------

const installedCall = (n = 1) => ({ sessionID: "ses_child", messageID: `msg_i${n}`, callID: `call_i${n}` });
const withInstalledTranscript = (f, b) => {
  f.w.messages = [
    { info: { id: "msg_user", role: "user" }, parts: [] },
    { info: { id: b.messageID, role: "assistant", parentID: "msg_user", agent: AGENT_KEY }, parts: [{ type: "tool", tool: "skills_installed", callID: b.callID, state: { status: "running", input: {} } }] },
  ];
};

test("skills_installed lists the skills on this box: name, description, folder and provenance when known — bound to the Architect's live call", async () => {
  const f = await fixture();
  try {
    await propose(f, { draft: { skills: [copiedOp()] } });
    await release(f);
    f.w.jobs[0] = { ...f.w.jobs[0], status: "running" };
    const b = installedCall();
    assert.equal((await f.engine.skillsInstalled(b)).ok, false, "no running tool call: refused");
    withInstalledTranscript(f, b);
    const r = await f.engine.skillsInstalled(b);
    assert.equal(r.ok, true, r.error);
    const helper = r.skills.find((s) => s.name === "dev-helper");
    assert.equal(helper.description, "Helps with dev chores.");
    assert.match(helper.folder, /installed-skills\/dev-helper$/);
    assert.equal(helper.provenance, null);
    const landing = r.skills.find((s) => s.name === "landing-audit");
    assert.match(landing.folder, /agents\/dev\/skills\/landing-audit$/);
    assert.equal(landing.owner, "dev");
    assert.equal(landing.provenance.repo, "acme/cro-skills");
    assert.equal(landing.provenance.licence, "MIT");
    assert.ok(r.skills.some((s) => s.owner === "architect" && s.name === "research"), "every team agent's skills");
    // another task's call, a changed argument and the wrong agent are refused
    const wrong = installedCall(2);
    f.w.messages = [{ info: { id: wrong.messageID, role: "assistant", parentID: "u", agent: "agent-dev" }, parts: [{ type: "tool", tool: "skills_installed", callID: wrong.callID, state: { status: "running", input: {} } }] }];
    assert.equal((await f.engine.skillsInstalled(wrong)).ok, false);
  } finally {
    await f.cleanup();
  }
});

test("the profile lists the agent's skills with their origin: name, description, files, size, provenance from SOURCE.md", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.engine.profile("dev")).skills, []);
    await propose(f, { draft: { skills: [copiedOp()] } });
    await release(f);
    const p = await f.engine.profile("dev");
    assert.equal(p.skills.length, 1);
    const s = p.skills[0];
    assert.equal(s.name, "landing-audit");
    assert.equal(s.description, "Audits a landing page for conversion problems.");
    assert.equal(s.files, 4);
    assert.ok(s.bytes > 100);
    assert.equal(s.provenance.url, SKILL_URL);
    assert.equal(s.provenance.repo, "acme/cro-skills");
    assert.equal(s.provenance.ref, "abc123");
    assert.equal(s.provenance.licence, "MIT");
    assert.equal(s.provenance.taken, "whole");
    assert.deepEqual(s.provenance.registry, { installs: 12500, stars: null });
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the refresh brief lists copied skills whose upstream moved (§4.2)
// ---------------------------------------------------------------------------

test("the refresh brief lists copied skills whose upstream commit has moved (git ls-remote, bounded, cached for a day); nothing moved, no section", async () => {
  const f = await fixture();
  try {
    await propose(f, { draft: { skills: [copiedOp({ provenance: { ...PROV, ref: "a".repeat(40) } })] } });
    await release(f);
    const calls = [];
    f.w.lsRemote = async (repo) => {
      calls.push(repo);
      return { head: "b".repeat(40) };
    };
    const moved = await f.engine.skillUpdatesFor("dev");
    assert.deepEqual(calls, ["acme/cro-skills"]);
    assert.equal(moved.length, 1);
    assert.equal(moved[0].skill, "landing-audit");
    assert.equal(moved[0].repo, "acme/cro-skills");
    assert.equal(moved[0].ref, "a".repeat(40));
    assert.equal(moved[0].upstream, "b".repeat(40));
    // cached for a day, asked again after
    await f.engine.skillUpdatesFor("dev");
    assert.equal(calls.length, 1);
    f.w.clock += 25 * 3600 * 1000;
    await f.engine.skillUpdatesFor("dev");
    assert.equal(calls.length, 2);
    // upstream still at the copied commit: nothing to say; an unreachable upstream says nothing either
    f.w.clock += 25 * 3600 * 1000;
    f.w.lsRemote = async () => ({ head: "a".repeat(40) });
    assert.deepEqual(await f.engine.skillUpdatesFor("dev"), []);
    f.w.clock += 25 * 3600 * 1000;
    f.w.lsRemote = async () => null;
    assert.deepEqual(await f.engine.skillUpdatesFor("dev"), []);
  } finally {
    await f.cleanup();
  }
});

test("the refresh task's brief carries the moved skills as data; an agent with no copied skill has none", async () => {
  const f = await fixture();
  try {
    await propose(f, { draft: { skills: [copiedOp({ provenance: { ...PROV, ref: "a".repeat(40) } })] } });
    await release(f);
    f.w.lsRemote = async () => ({ head: "b".repeat(40) });
    const brief = await f.engine.skillUpdatesBrief("dev");
    assert.match(brief, /landing-audit/);
    assert.match(brief, /acme\/cro-skills/);
    assert.match(brief, /moved/i);
    assert.match(brief, new RegExp("b".repeat(12)));
    f.w.lsRemote = async () => ({ head: "a".repeat(40) });
    f.w.clock += 25 * 3600 * 1000;
    assert.equal(await f.engine.skillUpdatesBrief("dev"), "");
  } finally {
    await f.cleanup();
  }
});

test("refresh: the Architect's task brief for @dev carries the moved skills (the refresh routine's own start)", async () => {
  const f = await fixture();
  try {
    await propose(f, { draft: { skills: [copiedOp({ provenance: { ...PROV, ref: "a".repeat(40) } })] } });
    await release(f);
    f.w.lsRemote = async () => ({ head: "b".repeat(40) });
    const r = await f.engine.refresh("dev", { runSessionId: "ses_run" });
    assert.equal(r.jobId, "job_refresh");
    const prompt = f.w.started.at(-1).prompt;
    assert.match(prompt, /Copied skills of @dev whose upstream has moved/);
    assert.match(prompt, /landing-audit \(acme\/cro-skills\)/);
    // an agent whose copied skills are all current gets a brief without the section
    f.w.lsRemote = async () => ({ head: "a".repeat(40) });
    f.w.clock += 25 * 3600 * 1000;
    await f.engine.refresh("dev", { runSessionId: "ses_run" });
    assert.doesNotMatch(f.w.started.at(-1).prompt, /upstream has moved/);
  } finally {
    await f.cleanup();
  }
});

// a create the server was writing when it stopped: saved `applying`, the folder claimed, agent.md written, nothing more
async function crashedCreate(f) {
  const draft = { name: "CRO Reviewer", description: "Reviews landing pages.", isolation: "none", instructions: "You review landing pages for conversion problems.", skills: [writtenOp()] };
  const r = await propose(f, { action: "create", agent: undefined, baseHash: undefined, draft });
  assert.equal(r.ok, true, r.error);
  const doc = await store(f);
  const rec = doc.changes.at(-1);
  Object.assign(rec, { state: "applying", prior: { state: "pending", needsClick: false, reason: null }, intendedSlug: "cro-reviewer", decidedBy: "auto" });
  await writeFile(join(f.root, ".changes.json"), JSON.stringify(doc));
  const dir = join(f.root, "cro-reviewer");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".claim"), rec.id);
  await writeFile(join(dir, "agent.md"), rec.after);
  return { rec, dir };
}

test("recovery, create with skills: a crash after agent.md leaves the skill files to write at boot", async () => {
  const f = await fixture();
  try {
    const { rec, dir } = await crashedCreate(f);
    await f.engine.recover();
    const done = (await store(f)).changes.find((r) => r.id === rec.id);
    assert.equal(done.state, "applied", done.error);
    assert.equal(await readFile(join(dir, "skills", "landing-audit", "SKILL.md"), "utf-8"), SKILL_MD);
    assert.equal(await ok(join(dir, ".claim")), false);
    assert.match(await readFile(join(dir, ".compiled.md"), "utf-8"), /landing-audit/);
  } finally {
    await f.cleanup();
  }
});

test("recovery, create with skills: a skill file in the claimed folder that isn't what was planned is a conflict naming the folder, never overwritten", async () => {
  const f = await fixture();
  try {
    const { rec, dir } = await crashedCreate(f);
    await mkdir(join(dir, "skills", "landing-audit"), { recursive: true });
    await writeFile(join(dir, "skills", "landing-audit", "SKILL.md"), "someone else's text");
    await f.engine.recover();
    const done = (await store(f)).changes.find((r) => r.id === rec.id);
    assert.equal(done.state, "conflict");
    assert.match(done.error, /cro-reviewer/);
    assert.equal(await readFile(join(dir, "skills", "landing-audit", "SKILL.md"), "utf-8"), "someone else's text");
  } finally {
    await f.cleanup();
  }
});
