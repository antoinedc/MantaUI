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

test("downgrade removals are undoable (the page comes back) and never tombstoned", async () => {
  const { r, w } = await setup();
  await r.engine.settingsSet({ projects: { [w]: { sharing: "private" } } });
  const ch = (await changesOf(r.engine)).find((i) => /Removed Only W/.test(i.summary));
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.match(await r.engine.store.read("commons/howto/only-w.md"), /Only W/);
  assert.equal(JSON.parse(await r.engine.store.read("tombstones.json")).tombstones.length, 0);
  await r.engine.stop();
});
