import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { curatorRig } from "./curatorRig.mjs";

const page = (slug, file, content, extra = {}) => ({ type: "page.edit", target: { area: "project", path: `projects/${slug}/${file}`, ...(extra.section ? { section: extra.section } : {}) }, content, reason: extra.reason ?? "Seen in the notes", evidence: extra.evidence ?? [{ ref: "msg:ses_one/msg_1" }] });
const changesOf = async (engine) => (await engine.changes({ limit: 100 })).items;
const exists = (p) => access(p).then(() => true, () => false);

async function rigWith(over = {}) {
  const holder = {};
  holder.rig = await curatorRig({ ...over, runner: over.runner ? (a, c) => over.runner(a, c, holder.rig) : undefined });
  return holder.rig;
}

test("triggers: nothing under 5 fresh notes; 5 notes run at once; 30 minutes after the last note runs the rest", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([]) });
  const slug = await r.slugOf("ses_one");
  for (let i = 0; i < 4; i++) await r.note(slug, "ses_one", "howto", `fact number ${i}`, [`msg:ses_one/msg_${i + 1}`]);
  await r.engine.layer.curator.tick();
  assert.equal(r.calls.length, 0);
  await r.note(slug, "ses_one", "howto", "fact number 4", ["msg:ses_one/msg_5"]);
  const t1 = await r.engine.layer.curator.tick();
  assert.equal(t1.ran[0].status, "ran");
  assert.equal(r.calls.length, 1);
  assert.equal((await r.engine.queue.list(slug)).length, 0);
  await r.note(slug, "ses_one", "howto", "a lone fact", ["msg:ses_one/msg_6"]);
  await r.engine.layer.curator.tick();
  assert.equal(r.calls.length, 1);
  r.clock.t += 31 * 60_000;
  await r.engine.layer.curator.tick();
  assert.equal(r.calls.length, 2);
  await r.engine.stop();
});

test("a batch applies each page decision as its own commit with the decision/batch trailers, records changes, consumes notes and spends budget", async () => {
  const r = await rigWith({
    runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", "- The cache needs a warm-up.\n"), page(rig.slug, "run-and-test.md", "Run `npm test`.\n"), { type: "drop", reason: "idle chatter", evidence: [] }]),
  });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "The cache needs a warm-up");
  await r.note(r.slug, "ses_one", "howto", "Run npm test", ["msg:ses_one/msg_2"]);
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.deepEqual([out.status, out.applied, out.dropped], ["ran", 2, 1]);
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8"), /warm-up/);
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8"), /sources:\n {2}- msg:ses_one\/msg_1/);
  const log = (await r.engine.store.log({ limit: 5 })).filter((c) => c.trailers["Manta-Decision"]);
  assert.equal(log.length, 2);
  assert.equal(new Set(log.map((c) => c.trailers["Manta-Batch"])).size, 1);
  assert.equal(log[0].author, "Manta curator");
  const items = await changesOf(r.engine);
  assert.equal(items.filter((i) => i.kind === "applied" && i.undoable).length, 2);
  assert.equal(items.filter((i) => i.kind === "dropped").length, 1);
  assert.equal((await r.engine.queue.list(r.slug)).length, 0);
  assert.ok(r.engine.budget.spentToday() > 0);
  assert.equal(r.calls[0].taskClass, "curator-notes");
  assert.match(r.calls[0].text, /untrusted data/);
  assert.match(r.calls[0].text, /The cache needs a warm-up/);
  await r.engine.stop();
});

test("the user's uncommitted hand edit is committed as theirs first; a decision that would drop one of their lines is skipped", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", "- Something else entirely.\n")]) });
  r.slug = await r.slugOf("ses_one");
  await r.writeStore(`projects/${r.slug}/gotchas.md`, "# Gotchas\n\n- never touch the lockfile\n");
  await r.note(r.slug, "ses_one", "gotcha", "something else");
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.skipped, 1);
  const log = await r.engine.store.log({ limit: 5 });
  assert.ok(log.some((c) => /^User edits/.test(c.subject) && c.author !== "Manta curator"));
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8"), /never touch the lockfile/);
  assert.match((await changesOf(r.engine)).find((i) => i.kind === "skipped").reason, /line you wrote/);
  await r.engine.stop();
});

test("a new section on a hand-edited page keeps the user's lines", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", "- fresh cache gotcha\n", { section: "Cache" })]) });
  r.slug = await r.slugOf("ses_one");
  await r.writeStore(`projects/${r.slug}/gotchas.md`, "# Gotchas\n\n- user line\n");
  await r.note(r.slug, "ses_one", "gotcha", "cache gotcha");
  assert.equal((await r.engine.runCurator(r.slug, { force: true })).applied, 1);
  const txt = await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8");
  assert.match(txt, /- user line/);
  assert.match(txt, /## Cache\n\n- fresh cache gotcha/);
  // a section the user wrote may not be replaced
  await r.writeStore(`projects/${r.slug}/gotchas.md`, `${txt}\n## Cache notes\n\n- hand-written\n`);
  await r.engine.stop();
});

test("base-commit check: a page that changed during the model call is re-asked once with the new content, then dropped if it changes again", async () => {
  let n = 0;
  const r = await rigWith({
    runner: async (_a, _c, rig) => {
      n++;
      if (n !== 2) await rig.engine.store.commit({ path: `projects/${rig.slug}/gotchas.md`, content: `# Gotchas\n\n- edited meanwhile ${n}\n`, message: "someone else" });
      return rig.decide([page(rig.slug, "gotchas.md", `- from the curator, ask ${n}\n`, { section: "Cache" })]);
    },
  });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "a gotcha");
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1].text, /A page changed while you were working/);
  assert.match(r.calls[1].text, /edited meanwhile 1/);
  assert.equal(out.applied, 1);

  // second case: it changes again during the re-ask
  n = 10;
  const r2 = await rigWith({
    runner: async (_a, _c, rig) => {
      await rig.engine.store.commit({ path: `projects/${rig.slug}/gotchas.md`, content: `# Gotchas\n\n- edit ${Math.random()}\n`, message: "someone else" });
      return rig.decide([page(rig.slug, "gotchas.md", "- from the curator\n", { section: "Cache" })]);
    },
  });
  r2.slug = await r2.slugOf("ses_one");
  await r2.note(r2.slug, "ses_one", "gotcha", "a gotcha");
  const out2 = await r2.engine.runCurator(r2.slug, { force: true });
  assert.equal(r2.calls.length, 2);
  assert.deepEqual([out2.applied, out2.dropped], [0, 1]);
  assert.match((await changesOf(r2.engine)).find((i) => i.kind === "dropped").reason, /changed again/);
  await r.engine.stop();
  await r2.engine.stop();
});

const UEV = { ses_one: { msg_1: { role: "user", text: "no, use pnpm not npm" }, msg_2: { role: "user", text: "I told you before: use pnpm" } }, ses_two: { msg_1: { role: "user", text: "pnpm please, never npm" } } };
const userRefs = () => new Set(["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
const ruleDecision = (quotes, extra = {}) => ({ type: "rule.add", target: { area: "project" }, content: "Use pnpm, never npm", reason: "The same correction three times", evidence: quotes.map(([ref, quote]) => ({ ref, quote })), ...extra });
const threeQuotes = [["msg:ses_one/msg_1", "use pnpm not npm"], ["msg:ses_one/msg_2", "use pnpm"], ["msg:ses_two/msg_1", "pnpm please"]];

async function ruleRig(over = {}) {
  const r = await rigWith({ messages: UEV, userRefs: userRefs(), projects: { widget: "https://github.com/acme/widget.git" }, sessions: { ses_one: "widget", ses_two: "widget" }, ...over });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "preference", "Use pnpm instead of npm", ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  return r;
}

test("rules: verified user evidence becomes a rule in rules.md (curator-rules), reaches the briefing, and is tracked", async () => {
  const r = await ruleRig({ runner: (_a, _c, rig) => rig.decide([ruleDecision(threeQuotes)]) });
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 1);
  assert.equal(r.calls[0].taskClass, "curator-rules");
  assert.match(r.calls[0].text, /user_messages/);
  assert.match(r.calls[0].text, /no, use pnpm not npm/);
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8"), /- Use pnpm, never npm/);
  assert.equal(r.engine.layer.rules.tracked(r.slug).length, 1);
  await r.engine.refreshDerived();
  const b = await r.engine.briefing({ sessionID: "ses_one", assistantMessages: 0 });
  assert.match(b.text, /Standing rules from the user for this project:\n- Use pnpm, never npm/);
  await r.engine.stop();
});

test("rules: a quote that isn't in the user's message, or too little evidence, is skipped and shown — nothing is written", async () => {
  const r = await ruleRig({ runner: (_a, _c, rig) => rig.decide([ruleDecision([["msg:ses_one/msg_1", "words nobody said at all"], ["msg:ses_one/msg_2", "use pnpm"], ["msg:ses_two/msg_1", "pnpm please"]]), ruleDecision([["msg:ses_one/msg_1", "use pnpm not npm"]], { content: "Another rule" })]) });
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.deepEqual([out.applied, out.skipped], [1, 1]); // the first still has 2 verified quotes in 2 sessions; the second has 1
  const skipped = (await changesOf(r.engine)).filter((i) => i.kind === "skipped");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Not enough evidence/);
  await r.engine.stop();
});

test("a derived note (no user-authored evidence) can never become a rule", async () => {
  const r = await rigWith({
    messages: UEV,
    userRefs: new Set(),
    runner: (_a, _c, rig) => rig.decide([ruleDecision(threeQuotes)]),
  });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "preference", "Use pnpm instead of npm", ["msg:ses_one/msg_1", "msg:ses_one/msg_2"]);
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 0);
  assert.equal(await exists(join(r.dir, `projects/${r.slug}/rules.md`)), false);
  await r.engine.stop();
});

const directDeps = { getRepoAccess: async () => ({ canPush: true, isFork: false, defaultBranch: "main" }), hasForgeLogin: async () => true };

test("outward mode: rules go to the repo writer as repo-safe strings (no quotes, refs or ids), one outward change, and no notification of its own (the repo writer sends the one first-write notice)", async () => {
  const applied = [];
  const repoWriter = { applyRules: async (slug, list) => (applied.push([slug, list]), { ok: true, mode: "direct", sha: "abc1234" }), sync: async () => ({ handEdit: null, prState: "none" }), revert: async () => ({ ok: true }) };
  const r = await ruleRig({ stored: { repoRules: "direct" }, repoWriter, over: directDeps, runner: (_a, _c, rig) => rig.decide([ruleDecision(threeQuotes, { reason: 'User said "use pnpm" in msg:ses_one/msg_1 and ses_two1234' })]) });
  await r.engine.runCurator(r.slug, { force: true });
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], r.slug);
  assert.equal(applied[0][1].length, 1);
  assert.match(applied[0][1][0], /^Use pnpm, never npm — User said in and$/);
  assert.doesNotMatch(applied[0][1][0], /msg|ses_|"/);
  const outward = (await changesOf(r.engine)).filter((i) => i.kind === "outward");
  assert.equal(outward.length, 1);
  assert.equal(outward[0].undoable, true);
  assert.equal(r.notes.filter((n) => n.tag === `knowledge-outward-${r.slug}`).length, 0);
  await r.note(r.slug, "ses_one", "preference", "Another preference entirely", ["msg:ses_one/msg_1"]);
  await r.engine.runCurator(r.slug, { force: true });
  assert.equal(r.notes.filter((n) => n.tag === `knowledge-outward-${r.slug}`).length, 0);
  await r.engine.stop();
});

test("an unmerged pull request or a failed write keeps the rules in the briefing; a direct write takes them out of it", async () => {
  for (const [res, inBriefing] of [[{ ok: true, mode: "pull-request", pr: "#7" }, true], [{ ok: false, error: "boom" }, true], [{ ok: true, mode: "direct", sha: "abc1234" }, false]]) {
    const repoWriter = { applyRules: async () => res, sync: async () => ({}), revert: async () => ({ ok: true }) };
    const r = await ruleRig({ stored: { repoRules: "pull-request" }, repoWriter, over: directDeps, runner: (_a, _c, rig) => rig.decide([ruleDecision(threeQuotes)]) });
    await r.engine.runCurator(r.slug, { force: true });
    await r.engine.refreshDerived();
    const b = await r.engine.briefing({ sessionID: "ses_one", assistantMessages: 0 });
    assert.equal(/Use pnpm, never npm/.test(b.text), inBriefing, JSON.stringify(res));
    await r.engine.stop();
  }
});

test("no qualifying model: notes stay queued and are retried; after 24 hours one 'waiting' entry appears (not one per retry)", async () => {
  const r = await rigWith({ runner: async () => ({ ok: false, code: "no-qualifying-model" }) });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "howto", "a fact");
  assert.equal((await r.engine.runCurator(slug, { force: true })).status, "waiting");
  assert.equal((await r.engine.queue.list(slug)).length, 1);
  r.clock.t += 25 * 3600_000;
  await r.engine.runCurator(slug, { force: true });
  await r.engine.runCurator(slug, { force: true });
  const waiting = (await changesOf(r.engine)).filter((i) => i.kind === "waiting");
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].summary, /capable model/);
  assert.equal((await r.engine.queue.list(slug)).length, 1);
  assert.match(JSON.stringify((await r.engine.status()).queued), /1/);
  await r.engine.stop();
});

test("budget cap stops curation (one 'waiting' entry) but not the briefing or the tools", async () => {
  const r = await rigWith({ stored: { dailyCapUsd: 0 }, runner: (_a, _c, rig) => rig.decide([]) });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "howto", "a fact");
  assert.equal((await r.engine.runCurator(slug, { force: true })).status, "cap");
  await r.engine.runCurator(slug, { force: true });
  assert.equal(r.calls.length, 0);
  assert.equal((await changesOf(r.engine)).filter((i) => i.kind === "waiting").length, 1);
  assert.equal((await r.engine.status()).capReached, true);
  assert.deepEqual(await r.engine.briefing({ sessionID: "ses_one", assistantMessages: 0 }), { text: "", token: null });
  assert.equal((await r.engine.search({ sessionID: "ses_one", query: "fact", sources: ["wiki"] })).hits.length, 0);
  await r.engine.stop();
});

test("a note restating its own session's briefing never reaches the model and never refreshes a page", async () => {
  const r = await rigWith({ briefingText: async () => "Reference notes: run the tests with npm test from the repo root.", runner: (_a, _c, rig) => rig.decide([]) });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "howto", "Run the tests with npm test from the repo root");
  const out = await r.engine.runCurator(slug, { force: true });
  assert.equal(r.calls.length, 0);
  assert.equal(out.status, "ran");
  assert.equal((await r.engine.queue.list(slug)).length, 0);
  await r.engine.stop();
});

test("an undone decision is tombstoned: the same proposal is dropped next time and the model is told about it", async () => {
  let content = "- The cache needs a warm-up.\n";
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", content)]) });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "cache warm-up");
  await r.engine.runCurator(r.slug, { force: true });
  const applied = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  assert.deepEqual(await r.engine.undo({ id: applied.id }), { ok: true });
  assert.equal(await exists(join(r.dir, `projects/${r.slug}/gotchas.md`)), false);
  await r.note(r.slug, "ses_one", "gotcha", "cache warm-up again");
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 0);
  assert.match(r.calls[1].text, /undone_before/);
  assert.match(r.calls[1].text, /warm-up/);
  assert.match((await changesOf(r.engine)).find((i) => i.kind === "dropped" && /undid this before/.test(i.reason)).reason, /won't be proposed again/);
  content = "- A different claim.\n";
  await r.note(r.slug, "ses_one", "gotcha", "another");
  assert.equal((await r.engine.runCurator(r.slug, { force: true })).applied, 1);
  await r.engine.stop();
});

test("a secret in a decision drops it (shown in Recent changes); nothing is written", async () => {
  const r = await rigWith({ over: { secretValues: () => ["hunter2-super-secret-value"] }, runner: (_a, _c, rig) => rig.decide([page(rig.slug, "access.md", "The password is hunter2-super-secret-value\n")]) });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "access");
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.deepEqual([out.applied, out.dropped], [0, 1]);
  assert.equal(await exists(join(r.dir, `projects/${r.slug}/access.md`)), false);
  assert.match((await changesOf(r.engine)).find((i) => i.kind === "dropped").reason, /secret/);
  await r.engine.stop();
});

test("observeOnly and a disabled feature write nothing and never call the model", async () => {
  for (const stored of [{ observeOnly: true }, { enabled: false }]) {
    const r = await rigWith({ stored, runner: (_a, _c, rig) => rig.decide([]) });
    const slug = await r.slugOf("ses_one");
    if (slug) await r.note(slug, "ses_one", "howto", "a fact").catch(() => {});
    if (slug) assert.equal((await r.engine.layer.curator.runBatch(slug, { force: true })).status, "off");
    await r.engine.layer.curator.tick();
    assert.equal(r.calls.length, 0);
    await r.engine.stop();
  }
});

test("missing deps switch their part off, are reported in status, and never crash the loop", async () => {
  const r = await curatorRig({ over: { isUserAuthoredRef: undefined, readMessages: undefined, readShellCommands: undefined } });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "howto", "a fact");
  const parts = (await r.engine.status()).parts;
  assert.match(parts.curator, /^off/);
  assert.match(parts.userAuthorship, /^off/);
  assert.match(parts.commandCheck, /^off/);
  assert.match(parts.globalBlock, /^off/);
  assert.equal(parts.corrections, "off");
  assert.deepEqual((await r.engine.layer.curator.tick()).ran, []);
  assert.equal((await r.engine.layer.tidy.run()).status, "ran");
  await r.engine.stop();
});

test("commands on a page must have been run in a cited session", async () => {
  const mk = (shell) => rigWith({ shell, runner: (_a, _c, rig) => rig.decide([page(rig.slug, "run-and-test.md", "```bash\nnpm run verify\n```\n")]) });
  const bad = await mk({ ses_one: ["npm test"] });
  bad.slug = await bad.slugOf("ses_one");
  await bad.note(bad.slug, "ses_one", "howto", "how to test");
  const o1 = await bad.engine.runCurator(bad.slug, { force: true });
  assert.deepEqual([o1.applied, o1.skipped], [0, 1]);
  const good = await mk({ ses_one: ["cd /w && npm run verify"] });
  good.slug = await good.slugOf("ses_one");
  await good.note(good.slug, "ses_one", "howto", "how to test");
  assert.equal((await good.engine.runCurator(good.slug, { force: true })).applied, 1);
  await bad.engine.stop();
  await good.engine.stop();
});

test("a failing model answer is retried with backoff; after three bad answers the notes are dropped and the user is told", async () => {
  const r = await rigWith({ runner: async () => ({ text: "I cannot do that" }) });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "howto", "a fact");
  for (let i = 0; i < 3; i++) await r.engine.runCurator(slug, { force: true });
  assert.equal((await r.engine.queue.list(slug)).length, 0);
  assert.match((await changesOf(r.engine)).find((i) => i.kind === "dropped").summary, /couldn't process/);
  await r.engine.stop();
});

test("pages are budgeted for the model: the ones that don't fit are listed without content and may only receive a new section", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([]) });
  const slug = await r.slugOf("ses_one");
  for (let i = 0; i < 14; i++) await r.engine.store.commit({ path: `projects/${slug}/runbooks/big-${i}.md`, content: `# Big ${i}\n\n${"filler words ".repeat(400)}\n`, message: `big ${i}` });
  await r.note(slug, "ses_one", "howto", "a fact");
  await r.engine.runCurator(slug, { force: true });
  assert.match(r.calls[0].text, /content not shown/);
  assert.match(r.calls[0].text, /only add a new section/);
  assert.ok(r.calls[0].text.length < 60_000);
  await r.engine.stop();
});

test("rule changes that were applied but not yet handed to the repository survive a restart (the timer pushes them)", async () => {
  const lists = [];
  const repoWriter = { applyRules: async (slug, list) => (lists.push(list), { ok: true, mode: "direct", sha: "abc1234" }), sync: async () => ({}), revert: async () => ({ ok: true }) };
  const r = await rigWith({ stored: { repoRules: "direct" }, over: directDeps, repoWriter });
  const slug = await r.slugOf("ses_one");
  await r.engine.store.commit({ path: `projects/${slug}/rules.md`, content: "---\ntitle: Rules\n---\n# Rules\n\n- Keep PRs small\n", message: "rules" });
  r.engine.layer.rules.setJson("pending", slug, ["c_lost"]);
  await r.engine.layer.curator.tick();
  assert.deepEqual(lists, [["Keep PRs small"]]);
  assert.deepEqual(r.engine.layer.rules.getJson("pending", slug, []), []);
  await r.engine.layer.curator.tick();
  assert.equal(lists.length, 1);
  await r.engine.stop();
});

test("the engine's own timer runs the curator (independent of the CTO engine) and stop() waits for a batch in flight", async () => {
  const r = await rigWith({ over: { curatorMs: 25 }, runner: async (_a, _c, rig) => (await new Promise((res) => setTimeout(res, 60)), rig.decide([])) });
  const slug = await r.slugOf("ses_one");
  for (let i = 0; i < 5; i++) await r.note(slug, "ses_one", "howto", `timer fact ${i}`, [`msg:ses_one/msg_${i + 1}`]);
  const until = Date.now() + 3000;
  while (r.calls.length === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.calls.length, 1);
  await r.engine.stop();
});
