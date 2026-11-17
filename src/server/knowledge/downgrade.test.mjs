import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { curatorRig } from "./curatorRig.mjs";
import { PREFERENCES_PATH } from "./globalBlock.mjs";
import { tmpDir } from "./testHelpers.mjs";

const changesOf = async (engine) => (await engine.changes({ limit: 200 })).items;
const pageWith = (title, refs) => `---\ntitle: ${title}\nsources:\n${refs.map((x) => `  - ${x}`).join("\n")}\n---\nGeneric advice about ${title}.\n`;

async function setup() {
  const dir = await tmpDir("downgrade-");
  const globalPath = join(dir, "AGENTS.md");
  const removed = [];
  const sources = { "learned-a": [], "learned-b": [] };
  const skills = { detect: async () => 0, retire: async () => 0, remove: async (s) => (removed.push(s), { ok: true }), sourceProjects: (s) => sources[s] };
  const r = await curatorRig({
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
    skills,
    globalPath,
  });
  const w = await r.slugOf("ses_w");
  const g = await r.slugOf("ses_g");
  sources["learned-a"] = [w];
  sources["learned-b"] = [g];
  const put = (rel, content) => r.engine.store.commit({ path: rel, content, message: `add ${rel}` });
  await put("commons/howto/only-w.md", pageWith("Only W", ["msg:ses_w/msg_1"]));
  await put("commons/howto/mixed.md", pageWith("Mixed", ["msg:ses_w/msg_1", "msg:ses_g/msg_1"]));
  await put("commons/howto/commit.md", pageWith("Commit", ["msg:ses_w/msg_1", "commit:abcdef1"]));
  await put("user/how-i-work.md", pageWith("How I work", ["msg:ses_w/msg_2"]));
  await put(PREFERENCES_PATH, "---\ntitle: Preferences\n---\n# Preferences\n\n- Pref W\n- Pref both\n- Pref hand\n");
  const rules = r.engine.layer.rules;
  rules.noteBullet({ path: PREFERENCES_PATH, text: "Pref W", slug: w });
  rules.noteBullet({ path: PREFERENCES_PATH, text: "Pref both", slug: w });
  rules.noteBullet({ path: PREFERENCES_PATH, text: "Pref both", slug: g });
  await r.engine.layer.globalBlock.apply({ reason: "setup" });
  r.engine.changesLog.add({ kind: "applied", summary: "Installed learned-a", undoable: true, data: { skillSlug: "learned-a" } });
  r.engine.changesLog.add({ kind: "applied", summary: "Installed learned-b", undoable: true, data: { skillSlug: "learned-b" } });
  return { r, w, g, globalPath, removed };
}

test("a project that stops sharing: pages only it fed are removed, mixed ones lose its references, preferences move home, skills go, and the global file is rewritten at once", async () => {
  const { r, w, globalPath, removed } = await setup();
  const commitsBefore = (await r.engine.store.log({ limit: 100 })).length;
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const { store } = r.engine;
  assert.equal(await store.read("commons/howto/only-w.md"), null);
  assert.equal(await store.read("user/how-i-work.md"), null);
  const mixed = await store.read("commons/howto/mixed.md");
  assert.match(mixed, /msg:ses_g\/msg_1/);
  assert.doesNotMatch(mixed, /ses_w/);
  const commit = await store.read("commons/howto/commit.md");
  assert.match(commit, /commit:abcdef1/);
  assert.doesNotMatch(commit, /ses_w/);
  const prefs = await store.read(PREFERENCES_PATH);
  assert.doesNotMatch(prefs, /Pref W/);
  assert.match(prefs, /Pref both/);
  assert.match(prefs, /Pref hand/);
  assert.match(await store.read(`projects/${w}/how-the-user-works-here.md`), /- Pref W/);
  const global = await readFile(globalPath, "utf8");
  assert.doesNotMatch(global, /Pref W/);
  assert.match(global, /Pref both/);
  assert.deepEqual(removed, ["learned-a"]);
  // one commit per removal, all listed in Recent changes
  const commits = (await store.log({ limit: 100 })).length - commitsBefore;
  const items = (await changesOf(r.engine)).filter((i) => i.kind === "applied" && !/Installed/.test(i.summary));
  assert.equal(items.length, 6); // two pages removed, two stripped, one preference moved, one skill removed
  assert.ok(items.some((i) => /Removed the skill learned-a/.test(i.summary)));
  assert.ok(commits >= 5);
  assert.equal(items.filter((i) => i.undoable).length, 5);
  await r.engine.stop();
});

test("changing the global default away from sharing cleans up every project; moving to read-only is also a downgrade; an upgrade cleans nothing", async () => {
  const { r, w, removed } = await setup();
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const n = (await changesOf(r.engine)).length;
  await r.engine.settingsSet({ projects: { [w]: { sharing: "share-and-read" } } });
  assert.equal((await changesOf(r.engine)).length, n, "an upgrade changes nothing");
  await r.engine.settingsSet({ sharing: "read-only" });
  assert.equal(await r.engine.store.read("commons/howto/mixed.md").then((x) => /ses_g/.test(x)), false, "the gadget's reference is gone too");
  assert.deepEqual(removed.sort(), ["learned-a", "learned-b"]);
  await r.engine.stop();
});

test("a page with only the downgraded project's evidence but the user's own lines is kept (references removed), not deleted", async () => {
  const { r, w } = await setup();
  await r.writeStore("commons/howto/hand.md", "---\ntitle: Hand\nsources:\n  - msg:ses_w/msg_1\n---\nthe user wrote this line\n");
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const kept = await r.engine.store.read("commons/howto/hand.md");
  assert.match(kept, /the user wrote this line/);
  assert.doesNotMatch(kept, /ses_w/);
  await r.engine.stop();
});

test("downgrade removals are undoable once the project shares again — and refused (with the reason) while it still doesn't; never tombstoned", async () => {
  const { r, w } = await setup();
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const ch = (await changesOf(r.engine)).find((i) => /Removed Only W/.test(i.summary));
  const refused = await r.engine.undo({ id: ch.id });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /still doesn't share its knowledge, so this can't be restored/);
  assert.equal(await r.engine.store.read("commons/howto/only-w.md"), null);
  await r.engine.settingsSet({ projects: { [w]: { sharing: "share-and-read" } } });
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.match(await r.engine.store.read("commons/howto/only-w.md"), /Only W/);
  assert.equal(JSON.parse(await r.engine.store.read("tombstones.json")).tombstones.length, 0);
  await r.engine.stop();
});

const rewriteRunner = (rig) => (a) => {
  const t = a.context.map((b) => b.text).join("\n\n");
  if (!/stopped sharing/.test(t)) return rig.decide([]);
  const path = /page \((?:commons|user)\) (\S+),/.exec(t)[1];
  const remaining = JSON.parse(/remaining_sources:\n(\[[\s\S]*?\n\])/.exec(t)[1]);
  return rig.decide([{ type: "page.edit", target: { area: path.split("/")[0], path }, content: "Only what the remaining projects support.\n", reason: "Removed what only the stopped project contributed", evidence: [{ ref: remaining[0].ref }] }]);
};

async function manyContributors(over = {}) {
  const h = {};
  h.r = await curatorRig({
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
    messages: { ses_g: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`msg_${i + 1}`, { role: "user", text: `gadget fact ${i + 1}` }])) },
    runner: (a) => h.runner(a),
    ...over,
  });
  const r = h.r;
  h.runner = rewriteRunner(r);
  const w = await r.slugOf("ses_w");
  const g = await r.slugOf("ses_g");
  const cur = r.engine.layer.curator;
  const vctx = await cur.vctxFor(w);
  // 25 contributions to ONE shared page: the first from widget, 24 more from gadget — a page's own `sources` keeps only the last 24
  const decisions = Array.from({ length: 25 }, (_, i) => ({ type: "page.edit", target: { area: "commons", path: "commons/howto/big.md" }, content: `Fact number ${i + 1} about releases.\n`, reason: "seen", evidence: [{ ref: i === 0 ? "msg:ses_w/msg_1" : `msg:ses_g/msg_${i}` }] }));
  const out = await cur.processDecisions(decisions, vctx, { batchId: "b_x", slug: w, taskClass: "curator-notes" });
  assert.equal(out.applied, 25);
  return { h, r, w, g };
}

test("the contributor table is uncapped: with 25 contributors the page's own sources forget the first, the table does not — and the downgrade rewrites the page without it", async () => {
  const { h, r, w, g } = await manyContributors();
  const before = await r.engine.store.read("commons/howto/big.md");
  assert.doesNotMatch(before, /ses_w/, "the 24-entry `sources` list no longer names widget");
  assert.equal(r.engine.layer.rules.contribs("commons/howto/big.md").length, 25);
  assert.equal(r.engine.layer.rules.contribs("commons/howto/big.md").filter((c) => c.slug === w).length, 1);
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const after = await r.engine.store.read("commons/howto/big.md");
  assert.match(after, /Only what the remaining projects support\./);
  assert.doesNotMatch(after, /Fact number 1 /);
  assert.doesNotMatch(after, /ses_w/);
  assert.equal(r.engine.layer.rules.contribs("commons/howto/big.md").filter((c) => c.slug === w).length, 0);
  const items = await changesOf(r.engine);
  const rewrite = items.find((i) => i.kind === "applied" && i.data === undefined && /Updated Big/.test(i.summary) && i.undoable);
  assert.ok(rewrite);
  const full = r.engine.changesLog.get(items.filter((i) => /Updated Big/.test(i.summary))[0].id);
  assert.deepEqual([full.data.kind, full.data.slugs], ["downgrade", [w]]);
  // the rewrite's own undo is refused while widget still doesn't share
  assert.equal((await r.engine.undo({ id: full.id })).ok, false);
  void g;
  void h;
  await r.engine.stop();
});

test("a mixed page that couldn't be rewritten (no capable model) keeps its references stripped, is reported as waiting, and is retried later", async () => {
  let up = false;
  const h = {};
  const r = await curatorRig({
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
    messages: { ses_g: { msg_1: { role: "user", text: "gadget fact" } } },
    runner: (a) => (up ? h.runner(a) : { ok: false, code: "no-qualifying-model" }),
  });
  h.runner = rewriteRunner(r);
  const w = await r.slugOf("ses_w");
  await r.slugOf("ses_g");
  const cur = r.engine.layer.curator;
  const vctx = await cur.vctxFor(w);
  const two = (content, ref) => ({ type: "page.edit", target: { area: "commons", path: "commons/howto/two.md" }, content, reason: "seen", evidence: [{ ref }] });
  assert.equal((await cur.processDecisions([two("Generic.\n", "msg:ses_w/msg_1"), two("Generic, extended.\n", "msg:ses_g/msg_1")], vctx, { batchId: "b_x", slug: w, taskClass: "curator-notes" })).applied, 2);
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  assert.ok((await changesOf(r.engine)).some((i) => i.kind === "waiting" && /is waiting/.test(i.summary)));
  assert.doesNotMatch(await r.engine.store.read("commons/howto/two.md"), /ses_w/);
  up = true;
  assert.equal(await r.engine.layer.downgrade.retryPending(), 1);
  assert.match(await r.engine.store.read("commons/howto/two.md"), /Only what the remaining projects support/);
  assert.equal(await r.engine.layer.downgrade.retryPending(), 0);
  await r.engine.stop();
});
