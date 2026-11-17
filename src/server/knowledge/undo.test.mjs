import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { curatorRig } from "./curatorRig.mjs";
import { tmpDir } from "./testHelpers.mjs";

const changesOf = async (engine) => (await engine.changes({ limit: 100 })).items;
const exists = (p) => access(p).then(() => true, () => false);
const page = (slug, file, content) => ({ type: "page.edit", target: { area: "project", path: `projects/${slug}/${file}` }, content, reason: "Seen", evidence: [{ ref: "msg:ses_one/msg_1" }] });
const UEV = { ses_one: { msg_1: { role: "user", text: "no, use pnpm not npm" }, msg_2: { role: "user", text: "I told you before: use pnpm" } }, ses_two: { msg_1: { role: "user", text: "pnpm please, never npm" } } };
const USER = () => new Set(["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
const quotes = [["msg:ses_one/msg_1", "use pnpm not npm"], ["msg:ses_one/msg_2", "use pnpm"], ["msg:ses_two/msg_1", "pnpm please"]].map(([ref, quote]) => ({ ref, quote }));
const access_ = { getRepoAccess: async () => ({ canPush: true, isFork: false, defaultBranch: "main" }), hasForgeLogin: async () => true };

async function rigWith(over) {
  const h = {};
  h.r = await curatorRig({ ...over, runner: over.runner ? (a, c) => over.runner(a, c, h.r) : undefined });
  return h.r;
}
async function withNotes(r, kinds = ["gotcha"]) {
  r.slug = await r.slugOf("ses_one");
  let i = 0;
  for (const k of kinds) await r.note(r.slug, "ses_one", k, `note ${i++} ${k}`, ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  return r;
}

test("undoing a page change reverts its commit, writes a tombstone and marks the change undone", async () => {
  const r = await withNotes(await rigWith({ runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", "- cache warm-up\n")]) }));
  await r.engine.runCurator(r.slug, { force: true });
  const ch = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.equal(await exists(join(r.dir, `projects/${r.slug}/gotchas.md`)), false);
  const tomb = JSON.parse(await r.engine.store.read("tombstones.json"));
  assert.equal(tomb.tombstones.length, 1);
  assert.equal(tomb.tombstones[0].kind, "page");
  assert.ok((await changesOf(r.engine)).find((i) => i.id === ch.id).undoneAt);
  assert.equal((await r.engine.undo({ id: ch.id })).reason, "That change was already undone.");
  await r.engine.stop();
});

test("a conflict with a later commit fails with an error naming it; nothing is half-applied and the error is recorded", async () => {
  let n = 0;
  const r = await withNotes(await rigWith({ runner: (_a, _c, rig) => rig.decide([page(rig.slug, "gotchas.md", `- version ${++n}\n`)]) }));
  await r.engine.runCurator(r.slug, { force: true });
  const first = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  await r.note(r.slug, "ses_one", "gotcha", "second note", ["msg:ses_one/msg_1"]);
  await r.engine.runCurator(r.slug, { force: true });
  const before = await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8");
  const res = await r.engine.undo({ id: first.id });
  assert.equal(res.ok, false);
  assert.match(res.reason, /A later change/);
  assert.match(res.reason, /Undo that one first/);
  assert.ok(res.conflictWith?.sha);
  assert.equal(await readFile(join(r.dir, `projects/${r.slug}/gotchas.md`), "utf8"), before);
  assert.equal((await r.engine.store.dirty()).length, 0);
  assert.equal((await changesOf(r.engine)).find((i) => i.id === first.id).error, res.reason);
  assert.equal(JSON.parse(await r.engine.store.read("tombstones.json")).tombstones.length, 0);
  await r.engine.stop();
});

const ruleDecision = (extra = {}) => ({ type: "rule.add", target: { area: "project" }, content: "Use pnpm, never npm", reason: "Corrected three times", evidence: quotes, ...extra });

test("undoing a rule removes it, stops tracking it, tombstones it, and the same rule is dropped next time", async () => {
  const r = await withNotes(await rigWith({ messages: UEV, userRefs: USER(), runner: (_a, _c, rig) => rig.decide([ruleDecision()]) }), ["preference"]);
  await r.engine.runCurator(r.slug, { force: true });
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8"), /Use pnpm/);
  const ch = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.doesNotMatch((await r.engine.store.read(`projects/${r.slug}/rules.md`)) ?? "", /Use pnpm/);
  assert.equal(r.engine.layer.rules.tracked(r.slug).length, 0);
  await r.note(r.slug, "ses_one", "preference", "pnpm again", ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  const out = await r.engine.runCurator(r.slug, { force: true });
  assert.equal(out.applied, 0);
  assert.match((await changesOf(r.engine)).find((i) => i.kind === "dropped" && /undid/.test(i.reason)).reason, /won't be proposed again/);
  await r.engine.stop();
});

test("undoing a rule in an outward project re-renders the repository block from the store", async () => {
  const lists = [];
  const repoWriter = { applyRules: async (slug, list) => (lists.push(list), { ok: true, mode: "direct", sha: "abc1234" }), sync: async () => ({}), revert: async () => ({ ok: true }) };
  const r = await withNotes(await rigWith({ stored: { repoRules: "direct" }, over: access_, repoWriter, messages: UEV, userRefs: USER(), runner: (_a, _c, rig) => rig.decide([ruleDecision()]) }), ["preference"]);
  await r.engine.runCurator(r.slug, { force: true });
  assert.equal(lists.length, 1);
  const ch = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[1], []);
  await r.engine.stop();
});

test("undoing a repository change calls the repo writer, then reverts the stored rule that produced it; a writer refusal comes back verbatim", async () => {
  const reverted = [];
  let answer = { ok: false, reason: "The branch moved on; revert the later commit first.", conflictWith: "abc1234" };
  const repoWriter = { applyRules: async () => ({ ok: true, mode: "direct", sha: "abc1234" }), sync: async () => ({}), revert: async (c) => (reverted.push(c), answer) };
  const r = await withNotes(await rigWith({ stored: { repoRules: "direct" }, over: access_, repoWriter, messages: UEV, userRefs: USER(), runner: (_a, _c, rig) => rig.decide([ruleDecision()]) }), ["preference"]);
  await r.engine.runCurator(r.slug, { force: true });
  const items = await changesOf(r.engine);
  const outward = items.find((i) => i.kind === "outward");
  const refused = await r.engine.undo({ id: outward.id });
  assert.deepEqual([refused.ok, refused.reason], [false, "The branch moved on; revert the later commit first."]);
  assert.match(await readFile(join(r.dir, `projects/${r.slug}/rules.md`), "utf8"), /Use pnpm/);
  answer = { ok: true };
  assert.deepEqual(await r.engine.undo({ id: outward.id }), { ok: true });
  assert.equal(reverted[1].mode, "direct");
  assert.equal(reverted[1].sha, "abc1234");
  assert.equal(reverted[1].slug, r.slug);
  assert.doesNotMatch((await r.engine.store.read(`projects/${r.slug}/rules.md`)) ?? "", /Use pnpm/);
  const after = await changesOf(r.engine);
  assert.ok(after.find((i) => i.kind === "applied").undoneAt);
  await r.engine.stop();
});

test("undoing a preference re-renders the global file immediately (no waiting for 04:00)", async () => {
  const dir = await tmpDir("undo-global-");
  const globalPath = join(dir, "AGENTS.md");
  const r = await withNotes(await rigWith({ globalPath, messages: UEV, userRefs: USER(), runner: (_a, _c, rig) => rig.decide([{ type: "preference.set", target: { area: "user" }, content: "Prefer pnpm over npm", reason: "Said so three times", evidence: quotes }]) }), ["preference"]);
  await r.engine.runCurator(r.slug, { force: true });
  assert.match(await r.engine.store.read("user/preferences.md"), /Prefer pnpm over npm/);
  assert.equal(r.engine.layer.globalBlock.isPending(), true);
  await assert.rejects(readFile(globalPath, "utf8")); // the curator's own write waits for the batch
  await r.engine.layer.globalBlock.apply({ reason: "batch" });
  assert.match(await readFile(globalPath, "utf8"), /Prefer pnpm over npm/);
  const ch = (await changesOf(r.engine)).find((i) => i.kind === "applied");
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.doesNotMatch(await readFile(globalPath, "utf8"), /Prefer pnpm over npm/);
  await r.engine.stop();
});

test("a learned skill is removed through the skills module and tombstoned by its source set; a refusal is reported", async () => {
  const removed = [];
  let ok = true;
  const skills = { detect: async () => 0, retire: async () => 0, remove: async (s) => (removed.push(s), ok ? { ok: true } : { ok: false, reason: "The skill folder is in use." }), sourceProjects: () => [] };
  const r = await rigWith({ skills });
  const id = r.engine.changesLog.add({ kind: "applied", summary: "Installed the skill learned-deploy", undoable: true, data: { skillSlug: "learned-deploy", sessions: ["ses_a", "ses_b"] } });
  ok = false;
  assert.deepEqual(await r.engine.undo({ id }), { ok: false, reason: "The skill folder is in use." });
  ok = true;
  assert.deepEqual(await r.engine.undo({ id }), { ok: true });
  assert.deepEqual(removed, ["learned-deploy", "learned-deploy"]);
  const tomb = JSON.parse(await r.engine.store.read("tombstones.json")).tombstones[0];
  assert.deepEqual([tomb.kind, tomb.sources], ["skill", ["ses_a", "ses_b"]]);
  const none = await curatorRig();
  const id2 = none.engine.changesLog.add({ kind: "applied", summary: "skill", undoable: true, data: { skillSlug: "x" } });
  assert.match((await none.engine.undo({ id: id2 })).reason, /Skills aren't available/);
  await r.engine.stop();
  await none.engine.stop();
});

test("every failing path gives a specific reason: unknown commit, no commit, no repo writer", async () => {
  const r = await curatorRig();
  const a = r.engine.changesLog.add({ kind: "applied", summary: "x", undoable: true, commitSha: "deadbee" });
  assert.match((await r.engine.undo({ id: a })).reason, /no longer in the knowledge store/);
  const b = r.engine.changesLog.add({ kind: "applied", summary: "x", undoable: true });
  assert.match((await r.engine.undo({ id: b })).reason, /no recorded commit/);
  const c = r.engine.changesLog.add({ kind: "outward", summary: "x", undoable: true, data: { outward: { slug: "x", mode: "direct" } } });
  assert.match((await r.engine.undo({ id: c })).reason, /Repository writes aren't available/);
  await r.engine.stop();
});
