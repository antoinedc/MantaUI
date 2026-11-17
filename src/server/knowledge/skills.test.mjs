import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSkills,
  slugifySkill,
  commandWasExecuted,
  parseDetection,
  normalizeCandidate,
  buildSkillMd,
  SKILL_MARKER,
  RETIRE_UNUSED_MS,
} from "./skills.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const S1 = "ses_aaaa1111";
const S2 = "ses_bbbb2222";
const GOOD_REPORT = "STEP 1: VALID - ok\nSTEP 2: VALID - ok\nVERDICT: PASS";

const candidate = (over = {}) => ({
  name: "Run the e2e suite",
  title: "Run e2e",
  description: "Run the e2e suite locally",
  steps: [
    { command: "npm run build", purpose: "Build" },
    { command: "npm run e2e", purpose: "Run it" },
  ],
  sessions: [S1, S2],
  requests: [
    { sessionID: S1, messageID: "msg_user1", quote: "please run the e2e suite" },
    { sessionID: S2, messageID: "msg_user2", quote: "run the e2e suite again" },
  ],
  ...over,
});

async function rig(over = {}) {
  const state = await memState();
  const skillsDir = join(await tmpDir("skills-"), "skills");
  await mkdir(skillsDir, { recursive: true });
  const cfg = { enabled: true, observeOnly: false, sharing: { "proj-a-0123456789": "share-and-read", "proj-b-0123456789": "share-and-read" }, capOk: true, ...(over.cfg ?? {}) };
  const toolCalls = over.toolCalls ?? {
    [S1]: [{ tool: "bash", command: "cd app && npm run build" }, { tool: "bash", command: "npm run e2e" }, { tool: "read", command: "ignored" }],
    [S2]: [{ tool: "bash", command: "npm  run   build" }],
  };
  const messages = over.messages ?? {
    [`${S1}/msg_user1`]: { role: "user", text: "ok please run the e2e suite now" },
    [`${S2}/msg_user2`]: { role: "user", text: "can you run the e2e suite again" },
  };
  const userAuthored = over.userAuthored ?? new Set(["msg_user1", "msg_user2"]);
  const mapping = over.mapping ?? { [S1]: "proj-a-0123456789", [S2]: "proj-b-0123456789" };
  const counts = { detect: 0, grade: 0, trial: 0, trialArgs: [] };
  const changes = [];
  const trialResult = over.trialResult ?? (() => ({ status: "completed", report: GOOD_REPORT, parsed: undefined, usd: 0.1 }));
  const rigCtx = {
    state,
    skillsDir,
    settings: { get: async () => ({ enabled: cfg.enabled, observeOnly: cfg.observeOnly }), effective: async (slug) => ({ sharing: cfg.sharing[slug] ?? "private" }) },
    sessionMap: { get: (sid) => (mapping[sid] ? { slug: mapping[sid] } : null) },
    scanner: { scan: async (t) => (over.secret && String(t).includes(over.secret) ? { clean: false, unavailable: false } : { clean: true, unavailable: false }) },
    trial: over.noTrial ? null : { run: async (a) => { counts.trial++; counts.trialArgs.push(a); return trialResult(a); } },
    runEphemeral: async (a) => {
      if (a.operation === "detect-skills") {
        counts.detect++;
        if (over.detectFail) return { ok: false, code: "no-qualifying-model" };
        return { text: `\`\`\`json\n${JSON.stringify({ skills: over.candidates ?? [candidate()] })}\n\`\`\`` };
      }
      counts.grade++;
      return { text: JSON.stringify({ verdict: over.grade ?? "pass", reason: "fine" }) };
    },
    budget: { canSpend: async () => ({ ok: cfg.capOk }) },
    loadEvidence: async () => ({
      notes: [1, 2, 3].map((i) => ({ id: `n_${i}`, slug: "proj-a-0123456789", sessionID: i === 3 ? S2 : S1, text: "Run npm run build then npm run e2e" })),
      runbooks: [],
    }),
    listUserRequests: async (sid) => Object.entries(messages).filter(([k]) => k.startsWith(`${sid}/`)).map(([k, m]) => ({ id: k.split("/")[1], text: m.text })),
    readToolCalls: async (sid) => toolCalls[sid] ?? [],
    readMessage: async ({ sessionID, messageID }) => messages[`${sessionID}/${messageID}`] ?? null,
    isUserAuthored: async (mid) => userAuthored.has(mid),
    lastLoads: over.lastLoads === null ? undefined : async () => over.lastLoads ?? {},
    isTombstoned: over.tombstoned ? async () => true : undefined,
    changesLog: { add: (c) => (changes.push(c), `c_${changes.length}`) },
    log: () => {},
    now: over.now ?? Date.now,
  };
  const skills = createSkills(rigCtx);
  return { skills, state, skillsDir, cfg, counts, changes, rigCtx };
}

const exists = (p) => stat(p).then(() => true, () => false);

test("pure helpers: slug, executed-command match, detection parsing, SKILL.md shape", () => {
  assert.equal(slugifySkill("Run the E2E suite!"), "run-the-e2e-suite");
  assert.equal(slugifySkill("learned-foo-bar"), "foo-bar");
  assert.equal(slugifySkill("a"), null);
  assert.equal(slugifySkill("../../etc"), "etc");
  assert.equal(commandWasExecuted("npm run build", ["cd app && npm run build"]), true);
  assert.equal(commandWasExecuted("npm run build", ["npm  run   build"]), true);
  assert.equal(commandWasExecuted("npm run build", ["npm run build:prod"]), false);
  assert.equal(commandWasExecuted("rm", ["rm -rf /"]), false);
  assert.equal(commandWasExecuted("", ["x"]), false);
  assert.equal(parseDetection("nonsense").skills.length, 0);
  assert.equal(parseDetection(JSON.stringify({ skills: [candidate(), { name: "x" }] })).skills.length, 1);
  assert.equal(normalizeCandidate({ ...candidate(), steps: [{ command: "echo ```" }] }), null);
  assert.equal(normalizeCandidate({ ...candidate(), steps: [] }), null);
  const md = buildSkillMd({ name: "e2e", title: "E2E", description: 'Run: "e2e"', steps: [{ command: "npm run e2e", purpose: "Go" }], sourceCount: 2 });
  assert.match(md, /^---\nname: learned-e2e\ndescription: "Run: \\"e2e\\""\n---\n/);
  assert.ok(md.includes(SKILL_MARKER));
  assert.match(md, /```sh\nnpm run e2e\n```/);
});

test("happy path: evidence passes, trial passes, queued for the daily batch, installed by flush", async () => {
  const t = await rig();
  assert.equal(await t.skills.detect(), 1);
  assert.equal(t.counts.trial, 1);
  assert.equal(t.counts.grade, 1);
  assert.deepEqual(t.skills.pendingWrites().map((w) => [w.op, w.name]), [["install", "learned-run-the-e2e-suite"]]);
  assert.equal(await exists(join(t.skillsDir, "learned-run-the-e2e-suite")), false); // not before the batch
  assert.deepEqual(t.skills.sourceProjects("learned-run-the-e2e-suite"), ["proj-a-0123456789", "proj-b-0123456789"]);
  assert.match(t.counts.trialArgs[0].request, /e2e suite/);
  assert.deepEqual(t.counts.trialArgs[0].slugs, ["proj-a-0123456789", "proj-b-0123456789"]);

  const out = await t.skills.flush();
  assert.deepEqual(out.installed, ["learned-run-the-e2e-suite"]);
  const md = await readFile(join(t.skillsDir, "learned-run-the-e2e-suite", "SKILL.md"), "utf8");
  assert.match(md, /^---\nname: learned-run-the-e2e-suite\ndescription: /);
  assert.ok(md.includes(SKILL_MARKER));
  assert.ok(md.includes("npm run build") && md.includes("npm run e2e"));
  const ch = t.changes.find((c) => c.kind === "applied");
  assert.equal(ch.undoable, true);
  assert.deepEqual(ch.data, { skill: "learned-run-the-e2e-suite", skillSlug: "learned-run-the-e2e-suite", action: "install", projects: ["proj-a-0123456789", "proj-b-0123456789"], sessions: ["ses_aaaa1111", "ses_bbbb2222"] });
  assert.deepEqual(t.skills.pendingWrites(), []);
  // the same procedure isn't proposed twice
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 1);
});

test("evidence bar: a step never executed in a cited session fails", async () => {
  const t = await rig({ toolCalls: { [S1]: [{ tool: "bash", command: "npm run build" }], [S2]: [] } });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
  assert.equal(t.skills.pendingWrites().length, 0);
});

test("evidence bar: non-shell tool calls don't count as executed commands", async () => {
  const t = await rig({ toolCalls: { [S1]: [{ tool: "read", command: "npm run build" }, { tool: "read", command: "npm run e2e" }], [S2]: [] } });
  assert.equal(await t.skills.detect(), 0);
});

test("evidence bar: needs ≥ 2 sessions with a user-authored, exactly-quoted request", async () => {
  // one session only
  let t = await rig({ candidates: [candidate({ requests: [candidate().requests[0]] })] });
  assert.equal(await t.skills.detect(), 0);
  // quote not an exact substring
  t = await rig({ candidates: [candidate({ requests: [candidate().requests[0], { ...candidate().requests[1], quote: "run the e2e suite AGAIN" }] })] });
  assert.equal(await t.skills.detect(), 0);
  // message not user-authored (no origin record)
  t = await rig({ userAuthored: new Set(["msg_user1"]) });
  assert.equal(await t.skills.detect(), 0);
  // an assistant message
  t = await rig({ messages: { [`${S1}/msg_user1`]: { role: "user", text: "please run the e2e suite" }, [`${S2}/msg_user2`]: { role: "assistant", text: "run the e2e suite again" } } });
  assert.equal(await t.skills.detect(), 0);
  // the same session twice is one session
  t = await rig({ candidates: [candidate({ requests: [candidate().requests[0], { ...candidate().requests[0], messageID: "msg_user1" }] })] });
  assert.equal(await t.skills.detect(), 0);
  // an unmapped session doesn't count
  t = await rig({ mapping: { [S1]: "proj-a-0123456789" } });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
});

test("outward steps keep the procedure a runbook: no trial, no install, one changes entry", async () => {
  const calls = { [S1]: [{ tool: "bash", command: "npm run build" }, { tool: "bash", command: "git push origin main" }], [S2]: [] };
  const t = await rig({ toolCalls: calls, candidates: [candidate({ steps: [{ command: "npm run build", purpose: "b" }, { command: "git push origin main", purpose: "p" }] })] });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
  assert.equal(t.skills.pendingWrites().length, 0);
  assert.equal(t.changes.filter((c) => c.kind === "skipped").length, 1);
  assert.match(t.changes[0].reason, /outside the box/);
  await t.skills.detect();
  assert.equal(t.changes.filter((c) => c.kind === "skipped").length, 1);
});

test("sharing rule: every source project must share; otherwise runbook only, and retried after a settings change", async () => {
  const t = await rig({ cfg: { sharing: { "proj-a-0123456789": "share-and-read", "proj-b-0123456789": "read-only" } } });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
  assert.equal(t.changes[0].kind, "skipped");
  t.cfg.sharing["proj-b-0123456789"] = "share-and-read";
  assert.equal(await t.skills.detect(), 1);
  assert.equal(t.counts.trial, 1);
});

test("a private source project blocks a global install even if only one session came from it", async () => {
  const t = await rig({ cfg: { sharing: { "proj-a-0123456789": "share-and-read", "proj-b-0123456789": "private" } } });
  assert.equal(await t.skills.detect(), 0);
});

test("a trial that can't run yet keeps the candidate pending and retries it first; the re-proposed duplicate isn't counted twice", async () => {
  let attempt = 0;
  const t = await rig({ trialResult: () => (++attempt === 1 ? { status: "skipped", reason: "no-clone" } : { status: "completed", report: GOOD_REPORT, usd: 0.1 }) });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.detect, 1);
  assert.equal(await t.skills.detect(), 1);
  assert.equal(t.counts.trial, 2);
  assert.equal(t.counts.grade, 1);
  assert.equal(t.skills.pendingWrites().length, 1);
});

test("no trial runner behaves like a skipped trial (never installs untested)", async () => {
  const t = await rig({ noTrial: true });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.skills.pendingWrites().length, 0);
});

test("a failed trial: invalid steps, wrong step count or a failing grade → runbook only", async () => {
  let t = await rig({ trialResult: () => ({ status: "completed", report: "STEP 1: VALID - ok\nSTEP 2: INVALID - no such script\nVERDICT: FAIL" }) });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.grade, 0); // the code bar refuses before the curator is asked
  assert.equal(t.changes[0].kind, "skipped");

  t = await rig({ trialResult: () => ({ status: "completed", report: "STEP 1: VALID - ok\nVERDICT: PASS" }) });
  assert.equal(await t.skills.detect(), 0);

  t = await rig({ grade: "fail" });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.grade, 1);
  assert.equal(t.skills.pendingWrites().length, 0);

  t = await rig({ trialResult: () => ({ status: "timeout", report: GOOD_REPORT }) });
  assert.equal(await t.skills.detect(), 0);
});

test("a trial execution failure is retried, then given up on", async () => {
  const t = await rig({ trialResult: () => ({ status: "failed", reason: "boom" }) });
  for (let i = 0; i < 4; i++) await t.skills.detect();
  assert.equal(t.counts.trial, 3);
  assert.equal(t.skills.pendingWrites().length, 0);
});

test("a secret in the draft drops it", async () => {
  const t = await rig({ secret: "AKIAFAKE", candidates: [candidate({ description: "Use AKIAFAKE1234 to run it" })] });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
  assert.equal(t.changes[0].kind, "skipped");
});

test("tombstoned candidates are never proposed again", async () => {
  const t = await rig({ tombstoned: true });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.trial, 0);
});

test("detect does nothing when off, observe-only, capped, or without a qualifying model", async () => {
  for (const cfg of [{ enabled: false }, { observeOnly: true }, { capOk: false }]) {
    const t = await rig({ cfg });
    assert.equal(await t.skills.detect(), 0);
    assert.equal(t.counts.detect, 0);
  }
  const t = await rig({ detectFail: true });
  assert.equal(await t.skills.detect(), 0);
  assert.equal(t.counts.detect, 1);
});

test("a skill proposed by a curator decision goes through the same pipeline", async () => {
  const t = await rig();
  const r = await t.skills.propose(candidate());
  assert.equal(r.status, "queued");
  assert.equal((await t.skills.propose({ name: "x" })).status, "rejected");
});

test("flush re-checks sharing at apply time and never overwrites a skill Manta didn't write", async () => {
  const t = await rig();
  await t.skills.detect();
  t.cfg.sharing["proj-a-0123456789"] = "private";
  const out = await t.skills.flush();
  assert.deepEqual(out.installed, []);
  assert.match(out.skipped[0].reason, /sharing/);
  assert.equal(await exists(join(t.skillsDir, "learned-run-the-e2e-suite")), false);

  const u = await rig();
  await mkdir(join(u.skillsDir, "learned-run-the-e2e-suite"));
  await writeFile(join(u.skillsDir, "learned-run-the-e2e-suite", "SKILL.md"), "mine");
  await u.skills.detect();
  const o = await u.skills.flush();
  assert.deepEqual(o.installed, []);
  assert.equal(await readFile(join(u.skillsDir, "learned-run-the-e2e-suite", "SKILL.md"), "utf8"), "mine");
});

test("remove: immediate, only learned- skills carrying Manta's marker; cancels a queued install", async () => {
  const t = await rig();
  await t.skills.detect();
  await t.skills.flush();
  await mkdir(join(t.skillsDir, "slideshow"));
  await writeFile(join(t.skillsDir, "slideshow", "SKILL.md"), "not ours");
  await mkdir(join(t.skillsDir, "learned-handmade"));
  await writeFile(join(t.skillsDir, "learned-handmade", "SKILL.md"), "---\nname: learned-handmade\n---\nuser wrote this");

  assert.equal((await t.skills.remove("slideshow")).ok, false);
  assert.equal(await exists(join(t.skillsDir, "slideshow", "SKILL.md")), true);
  assert.equal((await t.skills.remove("../slideshow")).ok, false);
  assert.equal((await t.skills.remove("learned-handmade")).ok, false);
  assert.equal(await exists(join(t.skillsDir, "learned-handmade", "SKILL.md")), true);
  assert.equal((await t.skills.remove("learned-missing")).ok, false);

  assert.deepEqual(await t.skills.remove("learned-run-the-e2e-suite"), { ok: true });
  assert.equal(await exists(join(t.skillsDir, "learned-run-the-e2e-suite")), false);
  assert.equal(t.skills.list()[0].status, "removed");

  const u = await rig();
  await u.skills.detect();
  assert.equal((await u.skills.remove("run-the-e2e-suite")).ok, true); // cancels the queue (no files yet)
  assert.deepEqual(u.skills.pendingWrites(), []);
  assert.deepEqual((await u.skills.flush()).installed, []);
});

test("retire: 30 days without a load or 2 tied corrections queue a removal; the batch applies it", async () => {
  let clock = Date.now();
  const t = await rig({ now: () => clock, lastLoads: {} });
  await t.skills.detect();
  await t.skills.flush();
  assert.equal(await t.skills.retire(), 0);
  clock += RETIRE_UNUSED_MS + 1000;
  assert.equal(await t.skills.retire(), 1);
  assert.deepEqual(t.skills.pendingWrites().map((w) => w.op), ["remove"]);
  assert.equal(await exists(join(t.skillsDir, "learned-run-the-e2e-suite")), true); // batched
  const out = await t.skills.flush();
  assert.deepEqual(out.removed, ["learned-run-the-e2e-suite"]);
  assert.equal(await exists(join(t.skillsDir, "learned-run-the-e2e-suite")), false);

  // a recent load keeps it
  clock = Date.now() + RETIRE_UNUSED_MS + 1000;
  const loaded = await rig({ now: () => clock - RETIRE_UNUSED_MS - 1000, lastLoads: { "learned-run-the-e2e-suite": clock - 1000 } });
  await loaded.skills.detect();
  await loaded.skills.flush();
  const later = createSkills({ ...loaded.rigCtx, now: () => clock });
  assert.equal(await later.retire(), 0);

  // corrections
  const c = await rig();
  await c.skills.detect();
  await c.skills.flush();
  assert.equal(c.skills.recordCorrection("learned-run-the-e2e-suite", "corr_1"), 1);
  assert.equal(c.skills.recordCorrection("learned-run-the-e2e-suite", "corr_1"), 1);
  assert.equal(await c.skills.retire(), 0);
  assert.equal(c.skills.recordCorrection("learned-run-the-e2e-suite", "corr_2"), 2);
  assert.equal(await c.skills.retire(), 1);
});

test("retire without a load reader never retires by time", async () => {
  let clock = Date.now();
  const t = await rig({ now: () => clock, lastLoads: null });
  await t.skills.detect();
  await t.skills.flush();
  clock += RETIRE_UNUSED_MS * 2;
  assert.equal(await t.skills.retire(), 0);
});

test("removeForProject removes what a downgraded project contributed to, immediately", async () => {
  const t = await rig();
  await t.skills.detect();
  await t.skills.flush();
  assert.deepEqual(await t.skills.removeForProject("proj-other-0123456789"), []);
  assert.deepEqual(await t.skills.removeForProject("proj-b-0123456789"), ["learned-run-the-e2e-suite"]);
  assert.deepEqual(await readdir(t.skillsDir), []);
});

test("undo from the changes log: remove() wins over a queued batch and applies at once", async () => {
  const t = await rig();
  await t.skills.detect();
  await t.skills.flush();
  const r = await t.skills.remove("learned-run-the-e2e-suite");
  assert.equal(r.ok, true);
  assert.deepEqual(t.skills.sourceProjects("learned-run-the-e2e-suite"), ["proj-a-0123456789", "proj-b-0123456789"]);
});
