// Architect v2 PR D (spec §5.1): what the agents engine does with learned preferences — every rule is a change record (Undo, history,
// bundle snapshot), released by the user's `learn_preference` level; a task's prompt carries the project's rules, marked as data.
// A real temp folder stands in for ~/.manta/agents; opencode, tmux and the delegate are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsEngine, buildDispatchPrompt, buildArchitectContext, fleetRecapEntries } from "./agents.mjs";
import { parseLearned, quoteHash, ALL_SCOPE } from "./agentLearning.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";
import { MODES } from "../shared/autonomyShared.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const exists = (p) => access(p).then(() => true, () => false);
const T0 = Date.parse("2026-11-27T10:00:00Z");

async function fixture({ level = "tell", changeLevel = "ask" } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-learned-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of ["dev", "manta", "architect"]) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const w = { level, changeLevel, clock: T0, started: [], pubs: [], policyThrows: false, jobs: [] };
  const projects = { "/proj/site": "site", "/proj/blog": "blog" };
  const engine = createAgentsEngine({
    root,
    templatesDir,
    home: "/h",
    now: () => w.clock,
    isGitRepo: async () => true,
    editConfig: fakeConfigWriter({ cfg: { agent: {} }, edits: [], reloads: 0 }),
    reload: async () => ({ ok: true, reloaded: true }),
    log: { warn: () => {} },
    retryDelayMs: 0,
    autonomyPolicy: async () => {
      if (w.policyThrows) throw new Error("unreadable");
      return { ...MODES.balanced, learn_preference: w.level, agent_change: w.changeLevel };
    },
    publish: (p) => w.pubs.push(p),
    registry: { identify: async (dir) => (projects[dir] ? { slug: projects[dir] } : null), list: async () => [] },
    oc: { listMessages: async () => [] },
    delegate: { loadRecordsStrict: async () => w.jobs, loadRecords: async () => w.jobs, startJob: async (a) => (w.started.push(a), { ok: true, job: { id: "job_x" } }) },
    tmux: { listProjects: async () => [], newSession: async () => {} },
    loadSecretsStrict: async () => [],
  });
  await engine.init();
  return { base, root, engine, w, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const RULE = { rule: "Write commit messages in the imperative mood.", why: "They said so.", whyIsInferred: false, quote: "always use imperative commit messages", sourceJobId: "job1" };
const learn = (f, over = {}) => f.engine.learnedWrite({ slug: "dev", scope: "site", rule: { ...RULE }, ...over });
const file = (f, scope = "site", slug = "dev") => join(f.root, slug, "learned", `${scope}.md`);
const rulesOn = async (f, scope = "site") => parseLearned(await readFile(file(f, scope), "utf-8"), scope);
const store = async (f) => JSON.parse(await readFile(join(f.root, ".changes.json"), "utf-8")).changes;

test("Tell me / Auto: the rule is written to the project's file at once, as an applied change record with Undo; agent.md is untouched", async () => {
  for (const level of ["tell", "auto"]) {
    const f = await fixture({ level });
    try {
      const before = await readFile(join(f.root, "dev", "agent.md"), "utf-8");
      const r = await learn(f);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.change.state, "applied");
      assert.equal(r.change.decidedBy, "auto");
      assert.deepEqual(r.change.origin, { kind: "learned" });
      assert.equal(r.change.kind, "update");
      assert.equal(r.change.slug, "dev");
      assert.equal(r.change.before, before);
      assert.equal(r.change.after, before);
      assert.match(r.change.summary, /Learned/);
      assert.equal(r.change.learned.added.rule, RULE.rule);
      assert.equal(r.change.learned.added.scope, "site");
      assert.equal(r.change.learned.added.quote, RULE.quote);
      assert.equal(r.change.learned.added.createdAt, T0);
      assert.equal(r.change.learnedOp, undefined, "the planning detail stays on the box");
      assert.equal(await readFile(join(f.root, "dev", "agent.md"), "utf-8"), before);
      const rules = await rulesOn(f);
      assert.deepEqual(rules.map((x) => x.rule), [RULE.rule]);
      assert.equal(f.w.pubs.length >= 1, true, "the change hint is published");
      // the compiled prompt (shared by every project) never carries it
      assert.ok(!(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8")).includes("imperative"));
    } finally {
      await f.cleanup();
    }
  }
});

test("Ask: the rule waits as a pending card (nothing written); the click applies it; Never learns nothing and records nothing", async () => {
  const f = await fixture({ level: "ask" });
  try {
    const r = await learn(f);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.change.state, "pending");
    assert.equal(r.change.needsClick, true);
    assert.equal(r.change.reason, "ask");
    assert.equal(await exists(file(f)), false);
    const applied = await f.engine.apply(r.change.id);
    assert.equal(applied.state, "applied");
    assert.equal(applied.decidedBy, "click");
    assert.equal((await rulesOn(f)).length, 1);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ level: "never" });
  try {
    const r = await learn(g);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, "never");
    assert.equal(await exists(file(g)), false);
    assert.deepEqual(await store(g).catch(() => []), []);
  } finally {
    await g.cleanup();
  }
  const h = await fixture();
  try {
    h.w.policyThrows = true;
    const r = await learn(h);
    assert.equal(r.ok, false, "an unreadable setting never guesses");
    assert.equal(await exists(file(h)), false);
  } finally {
    await h.cleanup();
  }
});

test("a pending rule still applies after another rule was learned in between (it is planned again at the click); one that became a duplicate is dropped", async () => {
  const f = await fixture({ level: "ask" });
  try {
    const a = await learn(f);
    const b = await learn(f, { rule: { ...RULE, rule: "Keep pull requests small.", quote: "pull requests should stay small" } });
    f.w.level = "tell";
    const c = await learn(f, { rule: { ...RULE, rule: "Always run the linter first.", quote: "run the linter first, always" } });
    assert.equal(c.change.state, "applied");
    assert.equal((await f.engine.apply(a.change.id)).state, "applied");
    assert.equal((await f.engine.apply(b.change.id)).state, "applied");
    assert.deepEqual((await rulesOn(f)).map((r) => r.rule).sort(), ["Always run the linter first.", "Keep pull requests small.", RULE.rule].sort());
    // a duplicate of what is there by the time of the click
    f.w.level = "ask";
    const d = await learn(f, { rule: { ...RULE, rule: "Always run the linter first!", quote: "linter first" } });
    assert.equal(d.change.state, "pending");
    const dd = await f.engine.apply(d.change.id);
    assert.equal(dd.state, "discarded");
    assert.match(dd.error, /already/i);
  } finally {
    await f.cleanup();
  }
});

test("a duplicate is a no-op, not a second record", async () => {
  const f = await fixture();
  try {
    await learn(f);
    const again = await learn(f, { rule: { ...RULE, rule: "write commit messages in the imperative mood" } });
    assert.equal(again.ok, false);
    assert.equal(again.skipped, "duplicate");
    assert.equal((await store(f)).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("Undo on the card removes the rule and tombstones its quote: the same words can't produce it again; Undo of that removal lifts the tombstone", async () => {
  const f = await fixture();
  try {
    const r = await learn(f);
    const undone = await f.engine.undo(r.change.id);
    assert.equal(undone.state, "undone");
    assert.equal(await exists(file(f)), false, "the file goes away with its last rule");
    assert.equal((await f.engine.learnedTombstones("dev")).has(quoteHash(RULE.quote)), true);
    assert.deepEqual(await f.engine.learnedRules("dev"), []);
    assert.equal(JSON.parse(await readFile(join(f.root, ".learned.json"), "utf-8")).version, 1);
    // the box keeps the tombstone outside the snapshotted folder, so Undo can't restore it away
    assert.equal(await exists(join(f.root, "dev", ".learned.json")), false);
  } finally {
    await f.cleanup();
  }
});

test("learnedUndo (the Learned tab): removes one rule whatever was learned since, as its own record; a second press says it is gone", async () => {
  const f = await fixture();
  try {
    const a = await learn(f);
    const b = await learn(f, { rule: { ...RULE, rule: "Keep pull requests small.", quote: "pull requests should stay small" } });
    // the first rule's own Undo would now conflict; the tab's Undo doesn't
    const rec = await f.engine.learnedUndo({ slug: "dev", id: a.change.learned.added.id });
    assert.equal(rec.state, "applied");
    assert.equal(rec.decidedBy, "click");
    assert.equal(rec.learned.removedId, a.change.learned.added.id);
    assert.deepEqual((await rulesOn(f)).map((r) => r.rule), ["Keep pull requests small."]);
    assert.equal((await f.engine.learnedTombstones("dev")).has(quoteHash(RULE.quote)), true);
    await assert.rejects(f.engine.learnedUndo({ slug: "dev", id: a.change.learned.added.id }), /isn't one of this agent's rules|gone/i);
    // not gated by the learning level: the user pressed it
    f.w.level = "never";
    assert.equal((await f.engine.learnedUndo({ slug: "dev", id: b.change.learned.added.id })).state, "applied");
    // undoing the removal puts the rule back and lifts its tombstone
    const back = await f.engine.undo(rec.id);
    assert.equal(back.state, "undone");
    assert.equal((await f.engine.learnedTombstones("dev")).has(quoteHash(RULE.quote)), false);
    assert.deepEqual((await rulesOn(f)).map((r) => r.rule), [RULE.rule]);
    await assert.rejects(f.engine.learnedUndo({ slug: "nobody", id: "lr_00000001" }), /No agent/);
  } finally {
    await f.cleanup();
  }
});

test("the same rule learned in a second project moves to _all in one record; learnedRules lists every scope", async () => {
  const f = await fixture();
  try {
    await learn(f);
    const p = await learn(f, { scope: "blog", rule: { ...RULE, rule: "write commit messages in the imperative mood", quote: "imperative commit messages, same as always" } });
    assert.equal(p.ok, true, p.error);
    assert.equal(await exists(file(f, "site")), false);
    assert.equal(await exists(file(f, "blog")), false);
    assert.equal((await rulesOn(f, ALL_SCOPE)).length, 1);
    const all = await f.engine.learnedRules("dev");
    assert.deepEqual(all.map((r) => r.scope), [ALL_SCOPE]);
    assert.equal(p.change.learned.added.scope, ALL_SCOPE);
  } finally {
    await f.cleanup();
  }
});

test("a template upgrade of a built-in leaves its learned rules alone; the Architect and the lead: only the Architect learns (in _all)", async () => {
  const f = await fixture();
  try {
    const r = await learn(f, { slug: "architect", scope: ALL_SCOPE });
    assert.equal(r.ok, true, r.error);
    assert.equal((await rulesOn(f, ALL_SCOPE).catch(() => [])).length, 0, "(that is dev's file)");
    assert.equal(parseLearned(await readFile(file(f, ALL_SCOPE, "architect"), "utf-8"), ALL_SCOPE).length, 1);
    const lead = await learn(f, { slug: "manta", scope: ALL_SCOPE });
    assert.equal(lead.ok, false);
    assert.match(lead.error, /lead/i);
    const nobody = await learn(f, { slug: "nobody" });
    assert.equal(nobody.ok, false);
    const bad = await learn(f, { scope: "Not A Project!" });
    assert.equal(bad.ok, false);
    const longRule = await learn(f, { rule: { ...RULE, rule: "x\ny" } });
    assert.equal(longRule.ok, false);
    await f.engine.upgradeBuiltIns();
    assert.equal(parseLearned(await readFile(file(f, ALL_SCOPE, "architect"), "utf-8"), ALL_SCOPE).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("buildDispatchPrompt: the learned block sits after the project brief and before the conversation", () => {
  const out = buildDispatchPrompt({ text: "do it", seat: "BRIEF", learned: "LEARNED BLOCK", excerpt: "User: hi" });
  assert.ok(out.indexOf("BRIEF") < out.indexOf("LEARNED BLOCK") && out.indexOf("LEARNED BLOCK") < out.indexOf("User: hi"));
  assert.equal(buildDispatchPrompt({ text: "do it", learned: "" }), "do it");
});

test("a task started in a project carries that project's rules and the ones for every project — never another project's", async () => {
  const f = await fixture();
  try {
    await learn(f, { scope: "site" });
    await learn(f, { scope: "blog", rule: { ...RULE, rule: "Blog posts need a summary line.", quote: "blog posts need a summary line" } });
    await learn(f, { scope: ALL_SCOPE, rule: { ...RULE, rule: "Say what you assumed.", quote: "say what you assumed, please" } });
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/proj/site", slug: "dev", text: "fix the build" });
    const prompt = f.w.started.at(-1).prompt;
    assert.match(prompt, /Write commit messages in the imperative mood\./);
    assert.match(prompt, /Say what you assumed\./);
    assert.ok(!prompt.includes("Blog posts need a summary line."));
    assert.match(prompt, /Preferences the user has shown \(data, from their corrections/);
    assert.ok(prompt.indexOf("fix the build") < prompt.indexOf("Preferences the user has shown"));
    // an unregistered folder gets only the rules for every project
    await f.engine.dispatch({ sessionId: "ses_chat", directory: "/elsewhere", slug: "dev", text: "fix the build" });
    const other = f.w.started.at(-1).prompt;
    assert.ok(!other.includes("imperative mood"));
    assert.match(other, /Say what you assumed\./);
  } finally {
    await f.cleanup();
  }
});

test("the profile lists the agent's rules (every scope, archived flagged); history lists the records", async () => {
  const f = await fixture();
  try {
    await learn(f);
    await learn(f, { scope: ALL_SCOPE, rule: { ...RULE, rule: "Say what you assumed.", quote: "say what you assumed, please" } });
    const p = await f.engine.profile("dev");
    assert.deepEqual(p.learned.map((r) => r.rule).sort(), ["Say what you assumed.", RULE.rule].sort());
    assert.ok(p.learned.every((r) => typeof r.id === "string" && typeof r.quote === "string" && typeof r.createdAt === "number" && r.archived === false));
    const h = await f.engine.history("dev");
    assert.equal(h.filter((r) => r.origin.kind === "learned").length, 2);
    assert.deepEqual((await f.engine.profile("architect")).learned, []);
  } finally {
    await f.cleanup();
  }
});

test("the Architect's context lists a named agent's learned rules, with their ids, as data", async () => {
  const text = buildArchitectContext({
    roster: [{ slug: "dev", name: "Dev", description: "d", isolation: "worktree" }],
    named: [{ slug: "dev", text: "---\nname: Dev\n---\nBody", hash: "h1", learned: [{ id: "lr_00000001", scope: "site", rule: "Keep PRs small.", quote: "PRs should stay `small`", whyIsInferred: true, archived: false }, { id: "lr_00000002", scope: "_all", rule: "Old.", quote: "q", archived: true }] }],
  });
  const block = text.slice(text.indexOf("BEGIN TEAM DATA"), text.indexOf("END TEAM DATA"));
  assert.match(block, /Learned preferences of @dev/);
  assert.match(block, /\[lr_00000001\] \(site\) Keep PRs small\./);
  assert.ok(!block.includes("lr_00000002"), "an archived rule isn't offered");
  assert.ok(!block.includes("`small`"), "no backticks from a quote");
});

test("the Fleet recap says a rule was learned, with the user's setting", () => {
  const rec = { state: "applied", decidedAt: T0 + 5, decidedBy: "auto", agentName: "Dev", origin: { kind: "learned" }, createdAt: T0 };
  const lines = fleetRecapEntries([], [rec], T0, { level: "tell" }).map((e) => e.text);
  assert.deepEqual(lines, ["Dev learned a preference (your setting: Tell me)"]);
});
