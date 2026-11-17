import { test } from "node:test";
import assert from "node:assert/strict";
import { curatorRig } from "./curatorRig.mjs";
import { PREFERENCES_PATH } from "./globalBlock.mjs";
import { replaceBullets, similarity } from "./tidy.mjs";
import { createCorrectionDetector } from "./corrections.mjs";
import { memState } from "./testHelpers.mjs";

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

const UEV = { ses_one: { msg_1: { role: "user", text: "no, use pnpm for installing packages here, not npm" }, msg_2: { role: "user", text: "I told you before: pnpm is what installs packages in this repo" } }, ses_two: { msg_1: { role: "user", text: "again: always use pnpm for installing packages please" } } };
const USER = () => new Set(["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
const mkCluster = (slug, over = {}) => ({ clusterId: "cl1", kind: "correction", lesson: "Use pnpm for installing packages, not npm", slug, sessions: 2, count: 3, evidence: [{ ref: "msg:ses_one/msg_1", quote: "use pnpm for installing packages", sessionID: "ses_one" }, { ref: "msg:ses_one/msg_2", quote: "use pnpm", sessionID: "ses_one" }, { ref: "msg:ses_two/msg_1", quote: "use pnpm for installing packages", sessionID: "ses_two" }], ...over });

function clusterRig(state, over = {}) {
  const corrections = { runWeekly: async () => state.clusters, recurrenceSince: async (id) => state.recurrence[id] ?? 0 };
  return rigWith({
    messages: UEV,
    userRefs: USER(),
    sessions: { ses_one: "widget", ses_two: "widget" },
    corrections,
    runner: (a, _c, rig) => {
      const t = a.context[0].text;
      if (/stop a mistake/.test(t)) return rig.decide([{ type: "rule.change", replaces: "Use pnpm for installing packages, never npm", content: "Always use pnpm for installs and scripts; never run npm", reason: "Clearer wording" }]);
      if (/detector found corrections/.test(t)) {
        // answer from what the PROMPT showed (its clusters, with the lessons it was given)
        const shown = JSON.parse(a.context.find((b) => b.text.startsWith("clusters:\n")).text.slice("clusters:\n".length));
        return rig.decide(shown.map((c) => ({ type: c.kind === "preference" ? "preference.set" : "rule.add", clusterId: c.clusterId, content: c.clusterId === "cl1" ? "Use pnpm for installing packages, never npm" : c.lesson, reason: "Repeated correction" })));
      }
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
  assert.match(await r.engine.store.read(`projects/${slug}/rules.md`), /- Use pnpm for installing packages, never npm/);
  assert.equal(r.calls.filter((c) => /detector found corrections/.test(c.text)).length, 1);
  assert.doesNotMatch(r.calls.find((c) => /detector found/.test(c.text)).text, /Weak/);
  assert.equal(r.engine.layer.rules.trackedFor(slug, "Use pnpm for installing packages, never npm").cluster_id, "cl1");
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
  assert.doesNotMatch(rules, /Use pnpm for installing packages, never npm/);
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
  const members = (lesson) => [
    { ref: "msg:ses_one/msg_1", quote: "use pnpm for installing packages", sessionID: "ses_one", at: 1, lesson },
    { ref: "msg:ses_two/msg_1", quote: "use pnpm for installing packages", sessionID: "ses_two", at: 2, lesson },
  ];
  state.clusters = [mkCluster(null, { clusterId: "pref1", kind: "preference", lesson: "Use pnpm for installing packages", evidence: members("Use pnpm for installing packages") })];
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.clustersApplied, 1);
  assert.match(await r.engine.store.read(PREFERENCES_PATH), /Use pnpm for installing packages/);

  const priv = await clusterRig(state, { stored: { sharing: "private" } });
  await priv.slugOf("ses_one");
  await priv.slugOf("ses_two");
  const rep2 = await priv.engine.layer.tidy.run();
  assert.equal(rep2.clustersApplied, 0);
  assert.equal(await priv.engine.store.read(PREFERENCES_PATH), null);
  await r.engine.stop();
  await priv.engine.stop();
});

test("a cluster's lesson reaching the user wiki comes from a member in a SHARING project (earliest sharing member); a private member's text never reaches the model", async () => {
  const state = { clusters: [], recurrence: {} };
  const r = await clusterRig(state, { projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" }, sessions: { ses_one: "widget", ses_two: "widget", ses_g: "gadget" } });
  await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  const g = await r.slugOf("ses_g");
  await r.engine.settingsSet({ projects: { [g]: { sharing: "private" } } });
  const ev = (sid, at, lesson, quote = "use pnpm for installing packages") => ({ ref: `msg:${sid}/msg_1`, quote, sessionID: sid, at, lesson });
  state.clusters = [
    mkCluster(null, { clusterId: "pref1", kind: "preference", lesson: "Private gadget deploy credentials lesson", evidence: [ev("ses_g", 1, "Private gadget deploy credentials lesson", "private gadget deploy credentials"), ev("ses_two", 3, "Use pnpm for installing packages, please"), ev("ses_one", 2, "Use pnpm for installing packages")] }),
    // only a private member and no member lesson: nothing sharing can vouch for it
    mkCluster(null, { clusterId: "pref2", kind: "preference", lesson: "Private only secret thing", sessions: 2, count: 2, evidence: [ev("ses_g", 1, "Private only secret thing", "private only secret thing"), ev("ses_g", 2, "Private only secret thing", "private only secret thing")] }),
  ];
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.clustersApplied, 1);
  const prompt = r.calls.find((c) => /detector found corrections/.test(c.text)).text;
  assert.doesNotMatch(prompt, /gadget|Private|credentials/i);
  assert.match(prompt, /"lesson": "Use pnpm for installing packages"/); // the earliest SHARING member's, not the cluster-wide one
  assert.match(await r.engine.store.read(PREFERENCES_PATH), /Use pnpm for installing packages/);
  assert.doesNotMatch(await r.engine.store.read(PREFERENCES_PATH), /Private|gadget/i);
  await r.engine.stop();
});

test("seam: a REAL detector's clusters (private + sharing members) → tidy → the model: the private member's wording never leaves the box", async () => {
  let det;
  const corrections = { runWeekly: () => det.runWeekly(), recurrenceSince: async () => 0 };
  const r = await clusterRig({}, {
    corrections,
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_one: "widget", ses_two: "widget", ses_g: "gadget" },
    messages: { ses_one: { msg_a: { role: "user", text: UEV.ses_one.msg_1.text } }, ses_two: { msg_b: { role: "user", text: UEV.ses_two.msg_1.text } } },
    userRefs: new Set(["msg:ses_one/msg_a", "msg:ses_two/msg_b"]),
  });
  await r.slugOf("ses_one");
  await r.slugOf("ses_two");
  const g = await r.slugOf("ses_g");
  await r.engine.settingsSet({ projects: { [g]: { sharing: "private" } } });
  const T = r.clock.t;
  const msgs = [
    { id: "msg_g", sessionID: "ses_g", at: T - 3 * 86_400_000, text: "always use pnpm for installing packages, gadget credentials hunter2", afterAssistant: true },
    { id: "msg_a", sessionID: "ses_one", at: T - 2 * 86_400_000, text: UEV.ses_one.msg_1.text, afterAssistant: true },
    { id: "msg_b", sessionID: "ses_two", at: T - 86_400_000, text: UEV.ses_two.msg_1.text, afterAssistant: true },
  ];
  const lessons = [["gadget", "Use pnpm for installing packages with gadget credentials"], ["here, not npm", "Use pnpm for installing packages"], ["please", "Use pnpm for installing packages"]];
  const detectorRunner = async (args) => {
    const prompt = args.context[0].text;
    if (prompt.includes("NEW LESSONS:")) return { text: JSON.stringify({ assignments: [{ i: 1, cluster: null, same_as: null }, { i: 2, cluster: null, same_as: 1 }, { i: 3, cluster: null, same_as: 1 }] }), model: { providerID: "p", modelID: "small" } };
    const results = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map(([, i, text]) => ({ i: Number(i), label: "preference", lesson: lessons.find(([k]) => text.includes(k))[1] }));
    return { text: JSON.stringify({ results }), model: { providerID: "p", modelID: "small" } };
  };
  det = createCorrectionDetector({
    state: await memState(),
    now: () => r.clock.t,
    log: () => {},
    sessionMap: r.engine.sessionMap,
    budget: { canSpend: async () => ({ ok: true }), record: async () => {} },
    settings: { get: async () => ({ enabled: true }) },
    runEphemeral: detectorRunner,
    readUserMessages: async ({ skip, limit }) => msgs.filter((m) => !skip(m.id)).slice(0, limit),
    isUserAuthored: () => true,
    scanner: { redact: async (t) => ({ text: t, redacted: 0, unavailable: false }) },
  });
  const clusters = await det.runWeekly();
  assert.equal(clusters.length, 1);
  assert.match(clusters[0].lesson, /gadget/); // the cluster-wide lesson IS the private member's (it was first)
  assert.ok(clusters[0].evidence.every((e) => typeof e.lesson === "string" && Number.isFinite(e.at)));
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.clustersApplied, 1);
  for (const c of r.calls) assert.doesNotMatch(c.text, /gadget|credentials|hunter2/i);
  assert.match(await r.engine.store.read(PREFERENCES_PATH), /Use pnpm for installing packages/);
  assert.doesNotMatch(await r.engine.store.read(PREFERENCES_PATH), /gadget|credentials/i);
  await r.engine.stop();
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
    runner: (a, _c, rig) => /contradicts, reverses/.test(a.context[0].text) ? { text: "NO" } : rig.decide([{ type: "rule.add", target: { area: "project" }, content: "Use pnpm for installing packages, never npm", reason: "Said three times", evidence: [{ ref: "msg:ses_one/msg_1", quote: "use pnpm for installing packages" }, { ref: "msg:ses_one/msg_2", quote: "pnpm is what installs packages" }, { ref: "msg:ses_two/msg_1", quote: "use pnpm for installing packages" }] }]),
  });
  const slug = await r.slugOf("ses_one");
  await r.note(slug, "ses_one", "preference", "pnpm", ["msg:ses_one/msg_1", "msg:ses_one/msg_2", "msg:ses_two/msg_1"]);
  await r.engine.runCurator(slug, { force: true });
  assert.equal(r.engine.layer.rules.viaBriefing(slug), true);

  // hand edit: the user adds a line and keeps ours
  sync.value = { handEdit: "- Use pnpm for installing packages, never npm — Said three times\n- Never commit .env files\n", prState: "open" };
  await r.engine.layer.tidy.run();
  const rules = await r.engine.store.read(`projects/${slug}/rules.md`);
  assert.match(rules, /- Use pnpm for installing packages, never npm\n/);
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
  r.engine.layer.rules.untrack(slug, "Use pnpm for installing packages, never npm");
  await r.engine.store.commit({ path: `projects/${slug}/rules.md`, content: "---\ntitle: Rules\n---\n# Rules\n\n- Never commit .env files\n", message: "reset" });
  await r.engine.runCurator(slug, { force: true });
  assert.match(await r.engine.store.read(`projects/${slug}/rules.md`), /Use pnpm for installing packages, never npm/);
  sync.value = { handEdit: null, prState: "closed" };
  await r.engine.layer.tidy.run();
  assert.doesNotMatch(await r.engine.store.read(`projects/${slug}/rules.md`), /Use pnpm for installing packages, never npm/);
  const items = await changesOf(r.engine);
  assert.ok(items.some((i) => i.kind === "undo" && /pull request was closed/.test(i.summary)));
  await r.engine.stop();
});

test("the tidy-up sends no notification of its own (the weekly notice is weeklyNotice.mjs's)", async () => {
  const r = await rigWith({ runner: (_a, _c, rig) => rig.decide([{ type: "page.edit", target: { area: "project", path: `projects/${rig.slug}/gotchas.md` }, content: "- a gotcha\n", reason: "r", evidence: [{ ref: "msg:ses_one/msg_1" }] }]) });
  r.slug = await r.slugOf("ses_one");
  await r.note(r.slug, "ses_one", "gotcha", "a gotcha");
  await r.engine.runCurator(r.slug, { force: true });
  await r.engine.layer.tidy.run();
  assert.equal(r.notes.filter((n) => n.tag === "knowledge-weekly").length, 0);
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

test("repository sync is per project: one project's failure is reported in Recent changes and doesn't stop the others", async () => {
  const seen = [];
  let boomFor = null;
  const repoWriter = { applyRules: async () => ({ ok: true, mode: "direct" }), sync: async (slug) => (seen.push(slug), slug === boomFor ? Promise.reject(new Error("git exploded")) : { handEdit: null, prState: "none" }), revert: async () => ({ ok: true }) };
  const r = await rigWith({
    stored: { repoRules: "pull-request" },
    over: outward,
    repoWriter,
    projects: { widget: "https://github.com/acme/widget.git", gadget: "https://github.com/acme/gadget.git" },
    sessions: { ses_w: "widget", ses_g: "gadget" },
  });
  const w = await r.slugOf("ses_w");
  const g = await r.slugOf("ses_g");
  const order = (await r.engine.registry.list()).map((p) => p.slug);
  boomFor = order[0];
  const rep = await r.engine.layer.tidy.run();
  assert.deepEqual(new Set(seen), new Set([w, g]));
  assert.equal(rep.synced, 1);
  assert.match(rep.errors.join(" "), /git exploded/);
  const e = (await changesOf(r.engine)).find((i) => /Couldn't check .*repository rules/.test(i.summary));
  assert.ok(e);
  assert.match(e.reason, /git exploded/);
  await r.engine.stop();
});

test("a rule whose bullet is gone stops being tracked (no rewrite is attempted for it)", async () => {
  const state = { clusters: [], recurrence: { cl1: 5 } };
  const r = await clusterRig(state);
  const slug = await r.slugOf("ses_one");
  state.clusters = [mkCluster(slug)];
  await r.engine.layer.tidy.run();
  assert.equal(r.engine.layer.rules.tracked(slug).length, 1);
  // the user deletes the line by hand
  await r.writeStore(`projects/${slug}/rules.md`, "---\ntitle: Rules\n---\n# Rules\n\n");
  const before = r.calls.length;
  r.clock.t += 8 * 24 * 3600_000;
  const rep = await r.engine.layer.tidy.run();
  assert.equal(r.engine.layer.rules.tracked(slug).length, 0);
  assert.equal(rep.rulesRewritten + rep.rulesRemoved, 0);
  assert.equal(r.calls.slice(before).filter((c) => /stop a mistake/.test(c.text)).length, 0);
  await r.engine.stop();
});

test("re-verification re-stamps only when at least one reference actually resolved; refs that can't be checked prove nothing", async () => {
  const messages = { ses_one: { msg_1: { role: "user", text: "hello" } } };
  const r = await rigWith({ messages });
  const slug = await r.slugOf("ses_one");
  const page = (title, refs) => `---\ntitle: ${title}\nverified: 2026-01-01\nsources:\n${refs.map((x) => `  - ${x}`).join("\n")}\n---\nFact about ${title}.\n`;
  await stamp(r, `projects/${slug}/runbooks/unknowable.md`, page("Unknowable", ["commit:abcdef1", "url:https://example.com/x"]));
  await stamp(r, `projects/${slug}/runbooks/resolved.md`, page("Resolved", ["msg:ses_one/msg_1", "commit:abcdef1"]));
  const rep = await r.engine.layer.tidy.run();
  assert.deepEqual([rep.reverified, rep.removed, rep.errors], [1, 0, []]);
  assert.match(await r.engine.store.read(`projects/${slug}/runbooks/unknowable.md`), /verified: 2026-01-01/);
  assert.match(await r.engine.store.read(`projects/${slug}/runbooks/resolved.md`), /verified: 2026-11-17/);
  await r.engine.stop();

  // a reader that fails answers "unknown", never "missing" and never "holds"
  const down = await rigWith({ over: { readMessages: async () => { throw new Error("reader down"); } } });
  const s2 = await down.slugOf("ses_one");
  await stamp(down, `projects/${s2}/runbooks/x.md`, page("X", ["msg:ses_one/msg_1"]));
  const rep2 = await down.engine.layer.tidy.run();
  assert.deepEqual([rep2.reverified, rep2.removed], [0, 0]);
  assert.ok(await down.engine.store.read(`projects/${s2}/runbooks/x.md`));
  await down.engine.stop();
});

test("re-verification reads each session once per run (one cache), not once per reference", async () => {
  const reads = [];
  const session = Array.from({ length: 12 }, (_, i) => ({ id: `msg_${i + 1}`, role: "user", text: `m${i + 1}` }));
  const r = await rigWith({ over: { readMessages: async ({ sessionID, messageIDs }) => (reads.push([sessionID, messageIDs]), session) } });
  const slug = await r.slugOf("ses_one");
  for (let i = 1; i <= 12; i++) await stamp(r, `projects/${slug}/runbooks/p${i}.md`, `---\ntitle: P${i}\nverified: 2026-01-01\nsources:\n  - msg:ses_one/msg_${i}\n---\nDistinct body number ${i} about ${"thing".repeat(i)} entirely.\n`);
  const rep = await r.engine.layer.tidy.run();
  assert.equal(rep.reverified, 12);
  assert.equal(reads.length, 1, "twelve references in one session cost one read");
  await r.engine.stop();
});
