import { test } from "node:test";
import assert from "node:assert/strict";
import { curatorRig } from "./curatorRig.mjs";
import { PREFERENCES_PATH } from "./globalBlock.mjs";
import { replaceBullets, similarity } from "./tidy.mjs";

const changesOf = async (engine) => (await engine.changes({ limit: 200 })).items;
const SENT = "Deploy by tagging the release and pushing the tag, then wait for the pipeline to finish before you verify that the site responds with the new version number. ";
const body = `${SENT.repeat(4)}\n`;

async function rigWith(over) {
  const h = {};
  h.r = await curatorRig({ ...over, runner: over.runner ? (a, c) => over.runner(a, c, h.r) : undefined });
  return h.r;
}
const stamp = (r, rel, content, author) => r.engine.store.commit({ path: rel, content, message: `add ${rel}`, ...(author ? { author } : {}) });

test("similarity: identical and near-identical texts score high, unrelated ones low", () => {
  assert.equal(similarity(body, body), 1);
  assert.ok(similarity(body, `${body}One more sentence.`) > 0.9);
  assert.ok(similarity(body, "Completely different words about databases and migrations in the staging cluster today.") < 0.2);
});

test("replaceBullets swaps the bullets and keeps every other line", () => {
  assert.equal(replaceBullets("---\ntitle: R\n---\n# R\n\nintro\n\n- a\n- b\n", ["b", "c"]), "---\ntitle: R\n---\n# R\n\nintro\n\n- b\n- c\n");
  assert.match(replaceBullets(null, ["x"]), /# Rules\n\n- x\n$/);
});

test("the weekly tidy runs once a week from the timer, not before, and says nothing when nothing changed", async () => {
  const r = await rigWith({});
  await r.slugOf("ses_one");
  assert.equal((await r.engine.layer.tidy.tickWeekly()).status, "ran");
  assert.equal(await r.engine.layer.tidy.tickWeekly(), null);
  r.clock.t += 6 * 24 * 3600_000;
  assert.equal(await r.engine.layer.tidy.tickWeekly(), null);
  r.clock.t += 2 * 24 * 3600_000;
  assert.equal((await r.engine.layer.tidy.tickWeekly()).status, "ran");
  assert.equal(r.notes.filter((n) => n.tag === "knowledge-weekly").length, 0);
  assert.ok((await r.engine.status()).lastTidy);
  await r.engine.stop();
});

test("duplicate pages are merged (sources kept); a duplicate holding the user's own lines is left alone", async () => {
  const r = await rigWith({});
  const slug = await r.slugOf("ses_one");
  const fm = (src) => `---\ntitle: Deploy\nsources:\n  - ${src}\n---\n${body}`;
  await stamp(r, `projects/${slug}/runbooks/deploy.md`, fm("msg:ses_one/msg_1"));
  await stamp(r, `projects/${slug}/runbooks/release.md`, fm("msg:ses_one/msg_2"));
  const rep = await r.engine.layer.tidy.run();
  assert.deepEqual([rep.duplicates, rep.errors], [1, []]);
  const kept = (await r.engine.store.listPages()).filter((p) => p.includes("/runbooks/"));
  assert.equal(kept.length, 1);
  const src = await r.engine.store.read(kept[0]);
  assert.match(src, /msg:ses_one\/msg_1/);
  assert.match(src, /msg:ses_one\/msg_2/);
  const ch = (await changesOf(r.engine)).find((i) => /Merged/.test(i.summary));
  assert.equal(ch.undoable, true);
  assert.deepEqual(await r.engine.undo({ id: ch.id }), { ok: true });
  assert.equal((await r.engine.store.listPages()).filter((p) => p.includes("/runbooks/")).length, 2);

  // the user's own copy is never merged away
  await r.writeStore(`projects/${slug}/runbooks/release.md`, `${fm("msg:ses_one/msg_2")}`.replace("verify that the site responds with the new version number", "verify the site"));
  await r.engine.store.commitDirtyAsUser();
  const again = await r.engine.layer.tidy.run();
  assert.equal(again.duplicates, 0);
  assert.equal((await r.engine.store.listPages()).filter((p) => p.includes("/runbooks/")).length, 2);
  await r.engine.stop();
});

test("re-verification: pages unverified for 90 days lose dead refs, are removed when nothing resolves, and are re-stamped when everything holds", async () => {
  const messages = { ses_one: { msg_1: { role: "user", text: "hello" } } };
  const r = await rigWith({ messages });
  const slug = await r.slugOf("ses_one");
  const page = (title, refs, verified = "2026-01-01") => `---\ntitle: ${title}\nverified: ${verified}\nsources:\n${refs.map((x) => `  - ${x}`).join("\n")}\n---\nFact about ${title}.\n`;
  await stamp(r, `projects/${slug}/gotchas.md`, page("Mixed", ["msg:ses_one/msg_1", "msg:ses_one/msg_9"]));
  await stamp(r, `projects/${slug}/runbooks/dead.md`, page("Dead", ["msg:ses_one/msg_8"]));
  await stamp(r, `projects/${slug}/runbooks/fine.md`, page("Fine", ["msg:ses_one/msg_1", "commit:abcdef1"]));
  await stamp(r, `projects/${slug}/runbooks/fresh.md`, page("Fresh", ["msg:ses_one/msg_7"], "2026-11-10"));
  await stamp(r, `projects/${slug}/access.md`, "---\ntitle: Access\n---\nNo sources, hand written.\n");
  const rep = await r.engine.layer.tidy.run();
  assert.deepEqual([rep.reverified, rep.removed, rep.errors], [2, 1, []]);
  const mixed = await r.engine.store.read(`projects/${slug}/gotchas.md`);
  assert.match(mixed, /msg:ses_one\/msg_1/);
  assert.doesNotMatch(mixed, /msg_9/);
  assert.equal(await r.engine.store.read(`projects/${slug}/runbooks/dead.md`), null);
  assert.match(await r.engine.store.read(`projects/${slug}/runbooks/fine.md`), /verified: 2026-11-17/);
  assert.match(await r.engine.store.read(`projects/${slug}/runbooks/fresh.md`), /msg_7/);
  assert.match(await r.engine.store.read(`projects/${slug}/access.md`), /hand written/);
  await r.engine.stop();
});

test("re-verification never removes a page that holds the user's own lines", async () => {
  const r = await rigWith({ messages: {} });
  const slug = await r.slugOf("ses_one");
  await r.writeStore(`projects/${slug}/gotchas.md`, "---\ntitle: G\nverified: 2026-01-01\nsources:\n  - msg:ses_one/msg_9\n---\nthe user wrote this\n");
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.removed, 0);
  assert.match(await r.engine.store.read(`projects/${slug}/gotchas.md`), /the user wrote this/);
  assert.ok((await changesOf(r.engine)).some((i) => i.kind === "skipped" && /Kept/.test(i.summary)));
  await r.engine.stop();
});

const UEV = { ses_one: { msg_1: { role: "user", text: "no, use pnpm not npm" }, msg_2: { role: "user", text: "I told you before: use pnpm" } }, ses_two: { msg_1: { role: "user", text: "pnpm please, never npm" } } };
const USER = () => new Set(["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
const mkCluster = (slug, over = {}) => ({ clusterId: "cl1", kind: "correction", lesson: "Use pnpm, not npm", slug, sessions: 2, count: 3, evidence: [{ ref: "msg:ses_one/msg_1", quote: "use pnpm not npm", sessionID: "ses_one" }, { ref: "msg:ses_one/msg_2", quote: "use pnpm", sessionID: "ses_one" }, { ref: "msg:ses_two/msg_1", quote: "pnpm please", sessionID: "ses_two" }], ...over });

function clusterRig(state, over = {}) {
  const corrections = { runWeekly: async () => state.clusters, recurrenceSince: async (id) => state.recurrence[id] ?? 0 };
  return rigWith({
    messages: UEV,
    userRefs: USER(),
    sessions: { ses_one: "widget", ses_two: "widget" },
    corrections,
    runner: (a, _c, rig) => {
      const t = a.context[0].text;
      if (/stop a mistake/.test(t)) return rig.decide([{ type: "rule.change", replaces: "Use pnpm, never npm", content: "Always use pnpm for installs and scripts; never run npm", reason: "Clearer wording" }]);
      if (/detector found corrections/.test(t)) return rig.decide(state.clusters.filter((c) => c.sessions >= 2 || c.count >= 3).map((c) => ({ type: c.kind === "preference" ? "preference.set" : "rule.add", clusterId: c.clusterId, content: c.clusterId === "cl1" ? "Use pnpm, never npm" : c.lesson, reason: "Repeated correction" })));
      return rig.decide([]);
    },
    ...over,
  });
}

test("clusters from the detector become rules through the same bars; below-threshold clusters are ignored", async () => {
  const state = { clusters: [], recurrence: {} };
  const r = await clusterRig(state);
  const slug = await r.slugOf("ses_one");
  state.clusters = [mkCluster(slug), mkCluster(slug, { clusterId: "weak", lesson: "Weak", sessions: 1, count: 1 }), mkCluster(null, { clusterId: "nullcorr", lesson: "No project", slug: null })];
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.clustersApplied, 1);
  assert.match(await r.engine.store.read(`projects/${slug}/rules.md`), /- Use pnpm, never npm/);
  assert.equal(r.calls.filter((c) => /detector found corrections/.test(c.text)).length, 1);
  assert.doesNotMatch(r.calls.find((c) => /detector found/.test(c.text)).text, /Weak/);
  assert.equal(r.engine.layer.rules.trackedFor(slug, "Use pnpm, never npm").cluster_id, "cl1");
  // already tracked → not proposed again
  await r.engine.layer.tidy.run();
  assert.equal(r.calls.filter((c) => /detector found corrections/.test(c.text)).length, 1);
  await r.engine.stop();
});

test("rule tracking: a recurring mistake rewrites the rule once, and removes it if it recurs again (and the cluster is not re-proposed)", async () => {
  const state = { clusters: [], recurrence: {} };
  const r = await clusterRig(state);
  const slug = await r.slugOf("ses_one");
  state.clusters = [mkCluster(slug)];
  await r.engine.layer.tidy.run();
  r.clock.t += 24 * 3600_000;
  state.recurrence.cl1 = 1;
  assert.equal((await r.engine.layer.tidy.run()).rulesRewritten, 0);
  state.recurrence.cl1 = 2;
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.rulesRewritten, 1);
  const rules = await r.engine.store.read(`projects/${slug}/rules.md`);
  assert.match(rules, /Always use pnpm for installs/);
  assert.doesNotMatch(rules, /Use pnpm, never npm/);
  assert.equal(r.engine.layer.rules.tracked(slug)[0].rewrites, 1);
  r.clock.t += 24 * 3600_000;
  const rep2 = await r.engine.layer.tidy.run();
  assert.equal(rep2.rulesRemoved, 1);
  assert.doesNotMatch((await r.engine.store.read(`projects/${slug}/rules.md`)) ?? "", /pnpm/);
  assert.equal(r.engine.layer.rules.tracked(slug).length, 0);
  const before = r.calls.length;
  await r.engine.layer.tidy.run();
  assert.equal(r.calls.filter((c) => /detector found corrections/.test(c.text)).length, 1, "the retired cluster isn't proposed again");
  assert.ok(r.calls.length >= before);
  await r.engine.stop();
});

test("a preference cluster that belongs to no project goes to user/preferences.md from sharing projects only", async () => {
  const state = { clusters: [], recurrence: {} };
  const r = await clusterRig(state);
  await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  state.clusters = [mkCluster(null, { clusterId: "pref1", kind: "preference", lesson: "Prefer small commits" })];
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.clustersApplied, 1);
  assert.match(await r.engine.store.read(PREFERENCES_PATH), /Prefer small commits/);

  const priv = await clusterRig(state, { stored: { sharing: "private" } });
  await priv.slugOf("ses_one");
  await priv.slugOf("ses_two");
  const rep2 = await priv.engine.layer.tidy.run();
  assert.equal(rep2.clustersApplied, 0);
  assert.equal(await priv.engine.store.read(PREFERENCES_PATH), null);
  await r.engine.stop();
  await priv.engine.stop();
});

test("the tidy calls skills.detect then skills.retire and reports their counts; a failing step never stops the rest", async () => {
  const order = [];
  const skills = { detect: async () => (order.push("detect"), 2), retire: async () => (order.push("retire"), 1), remove: async () => ({ ok: true }), sourceProjects: () => [] };
  const corrections = { runWeekly: async () => { throw new Error("detector down"); }, recurrenceSince: async () => 0 };
  const r = await rigWith({ skills, corrections });
  await r.slugOf("ses_one");
  const rep = await r.engine.layer.tidy.run();
  assert.deepEqual(order, ["detect", "retire"]);
  assert.deepEqual([rep.skillsDetected, rep.skillsRetired], [2, 1]);
  assert.match(rep.errors[0], /corrections: detector down/);
  await r.engine.stop();
});

const outward = { getRepoAccess: async () => ({ canPush: true, isFork: false, defaultBranch: "main" }), hasForgeLogin: async () => true };

test("repository sync: a hand edit of the block is adopted (user commit, reasons mapped back); merged PRs are done; closed PRs undo their decisions", async () => {
  const sync = { value: { handEdit: null, prState: "none" } };
  const repoWriter = { applyRules: async () => ({ ok: true, mode: "pull-request", pr: "#9" }), sync: async () => sync.value, revert: async () => ({ ok: true }) };
  const r = await rigWith({
    stored: { repoRules: "pull-request" },
    over: outward,
    repoWriter,
    messages: UEV,
    userRefs: USER(),
    runner: (_a, _c, rig) => rig.decide([{ type: "rule.add", target: { area: "project" }, content: "Use pnpm, never npm", reason: "Said three times", evidence: [{ ref: "msg:ses_one/msg_1", quote: "use pnpm not npm" }, { ref: "msg:ses_one/msg_2", quote: "use pnpm" }, { ref: "msg:ses_two/msg_1", quote: "pnpm please" }] }]),
  });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "preference", "pnpm", ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  await r.engine.runCurator(slug, { force: true });
  assert.equal(r.engine.layer.rules.viaBriefing(slug), true);

  // hand edit: the user adds a line and keeps ours
  sync.value = { handEdit: "- Use pnpm, never npm — Said three times\n- Never commit .env files\n", prState: "open" };
  await r.engine.layer.tidy.run();
  const rules = await r.engine.store.read(`projects/${slug}/rules.md`);
  assert.match(rules, /- Use pnpm, never npm\n/);
  assert.match(rules, /- Never commit \.env files/);
  const log = await r.engine.store.log({ path: `projects/${slug}/rules.md`, limit: 1 });
  assert.match(log[0].subject, /Adopt your edit/);
  assert.notEqual(log[0].author, "Manta curator");

  // merged: delivered through the repo now
  sync.value = { handEdit: null, prState: "merged" };
  await r.engine.layer.tidy.run();
  assert.equal(r.engine.layer.rules.viaBriefing(slug), false);

  // a new rule via a PR that is then closed → undone
  await r.note(slug, "ses_one", "preference", "second", ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  r.engine.layer.rules.untrack(slug, "Use pnpm, never npm");
  await r.engine.store.commit({ path: `projects/${slug}/rules.md`, content: "---\ntitle: Rules\n---\n# Rules\n\n- Never commit .env files\n", message: "reset" });
  await r.engine.runCurator(slug, { force: true });
  assert.match(await r.engine.store.read(`projects/${slug}/rules.md`), /Use pnpm, never npm/);
  sync.value = { handEdit: null, prState: "closed" };
  await r.engine.layer.tidy.run();
  assert.doesNotMatch(await r.engine.store.read(`projects/${slug}/rules.md`), /Use pnpm, never npm/);
  const items = await changesOf(r.engine);
  assert.ok(items.some((i) => i.kind === "undo" && /pull request was closed/.test(i.summary)));
  await r.engine.stop();
});

test("the weekly notification is sent once, only when something changed", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([{ type: "page.edit", target: { area: "project", path: `projects/${rig.slug}/gotchas.md` }, content: "- a gotcha\n", reason: "r", evidence: [{ ref: "msg:ses_one/msg_1" }] }]) });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "a gotcha");
  await r.engine.runCurator(r.slug, { force: true });
  await r.engine.layer.tidy.run();
  const sent = r.notes.filter((n) => n.tag === "knowledge-weekly");
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /1 change applied/);
  await r.engine.stop();
});

test("the commons pass writes a generic how-to only from runbooks of sharing projects, citing page refs", async () => {
  const r = await rigWith({
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
    runner: (a, _c, rig) => (/shared how-to library/.test(a.context[0].text) ? rig.decide([{ type: "page.edit", target: { area: "commons", path: "commons/howto/release.md" }, content: "Tag, push the tag, wait for the pipeline.\n", reason: "Both projects release this way", evidence: rig.refs.map((ref) => ({ ref })) }]) : rig.decide([])),
  });
  const w = await r.slugOf("ses_w");
  const g = await r.slugOf("ses_g");
  await stamp(r, `projects/${w}/runbooks/release.md`, `---\ntitle: Release\n---\nTag and push.\n`);
  await stamp(r, `projects/${g}/runbooks/release.md`, `---\ntitle: Release\n---\nTag and push too.\n`);
  r.refs = [`page:projects/${w}/runbooks/release.md`, `page:projects/${g}/runbooks/release.md`];
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.commons, 1);
  const txt = await r.engine.store.read("commons/howto/release.md");
  assert.match(txt, /Tag, push the tag/);
  assert.match(txt, new RegExp(`page:projects/${w}/runbooks/release.md`));

  // a project that stopped sharing contributes nothing
  const priv = await rigWith({
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
    runner: (_a, _c, rig) => rig.decide([]),
  });
  const pw = await priv.slugOf("ses_w");
  const pg = await priv.slugOf("ses_g");
  await priv.engine.settingsSet({ projects: { [pw]: { sharing: "private" } } });
  await stamp(priv, `projects/${pw}/runbooks/release.md`, `---\ntitle: Release\n---\nTag and push.\n`);
  await stamp(priv, `projects/${pg}/runbooks/release.md`, `---\ntitle: Release\n---\nTag too.\n`);
  await priv.engine.layer.tidy.run();
  assert.equal(priv.calls.length, 0, "fewer than two sharing projects → no commons pass");
  await r.engine.stop();
  await priv.engine.stop();
});
