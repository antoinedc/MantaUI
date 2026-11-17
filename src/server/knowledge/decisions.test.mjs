import { test } from "node:test";
import assert from "node:assert/strict";
import { claimSupported, quoteSupports } from "./support.mjs";
import { createMessageCache, buildPageEdit, checkBudgets, commandExecuted, containsQuote, createDecisionValidator, extractCommands, isBriefingEcho, newCommandLines, normalizeDecision, parseDecisionOutput, removedUserLines } from "./decisions.mjs";
import { createTombstones, decisionKey } from "./tombstones.mjs";

test("parseDecisionOutput accepts an object, a bare array, a ```json fence and prose around it; rejects garbage", () => {
  const d = [{ type: "drop" }];
  assert.deepEqual(parseDecisionOutput(JSON.stringify({ decisions: d })).decisions, d);
  assert.deepEqual(parseDecisionOutput(JSON.stringify(d)).decisions, d);
  assert.deepEqual(parseDecisionOutput(`Sure!\n\`\`\`json\n${JSON.stringify({ decisions: d })}\n\`\`\`\nDone.`).decisions, d);
  assert.deepEqual(parseDecisionOutput(`Here: ${JSON.stringify({ decisions: d })} ok`).decisions, d);
  assert.equal(parseDecisionOutput("no json").ok, false);
  assert.equal(parseDecisionOutput("{}").ok, false);
});

test("normalizeDecision keeps the pinned shape, mints its own id and drops fields the model must not set", () => {
  const d = normalizeDecision({ id: "d_FAKE", type: "rule.add", target: { area: "project", slug: "x", evil: 1 }, content: "Use pnpm", reason: "r".repeat(500), evidence: [{ ref: "msg:a/b", quote: "use pnpm" }, "junk"], internal: true, rewrite: true, cluster: { count: 99 } }, { now: () => 1 });
  assert.match(d.id, /^d_[0-9A-Z]{26}$/);
  assert.equal(d.reason.length, 300);
  assert.deepEqual(d.target, { area: "project", slug: "x" });
  assert.equal(d.internal, undefined);
  assert.equal(d.rewrite, undefined);
  assert.equal(d.cluster, undefined);
  assert.equal(d.evidence.length, 1);
  assert.equal(normalizeDecision({ type: "nope" }), null);
  assert.equal(normalizeDecision(null), null);
});

test("extractCommands: shell blocks line by line, continuations joined, prompts and comments handled, other blocks ignored", () => {
  const md = ["```bash", "# build", "npm ci", "npm run build \\", "  --prod", "```", "", "```json", '{"a": 1}', "```", "```", "$ git status", "```", "```", "just text", "```", "```console", "$ ls -la", "total 0", "```"].join("\n");
  assert.deepEqual(extractCommands(md), ["npm ci", "npm run build --prod", "git status", "ls -la"]);
  assert.deepEqual(newCommandLines("```bash\nnpm ci\n```", "```bash\nnpm ci\nnpm test\n```"), ["npm test"]);
  assert.equal(commandExecuted("npm   test", ["cd /x &&  npm test"]), true);
  assert.equal(commandExecuted("npm test", ["cd /x; npm test\nnpm run lint"]), true);
  assert.equal(commandExecuted("npm test", ["npm test -- --watch"]), false);
  assert.equal(commandExecuted("rm -rf /", ["npm test"]), false);
});

test("commandExecuted matches a whole command or a whole segment, never a substring or a quoted look-alike", () => {
  assert.equal(commandExecuted("git push", ['echo "git push"']), false);
  assert.equal(commandExecuted("git push", ["echo 'x; git push; y'"]), false);
  assert.equal(commandExecuted("git push", ['echo "a && git push"']), false);
  assert.equal(commandExecuted("git push", ["git push origin main"]), false);
  assert.equal(commandExecuted("git push", ["git status && git push"]), true);
  assert.equal(commandExecuted("git push", ["make build || git push"]), true);
  assert.equal(commandExecuted("echo hi", ['echo hi && echo "git push"']), true);
});

test("containsQuote is exact, tolerant only of whitespace", () => {
  assert.equal(containsQuote("please always use  pnpm here", "always use pnpm"), true);
  assert.equal(containsQuote("please always use pnpm", "ALWAYS use pnpm"), false);
  assert.equal(containsQuote("x", ""), false);
});

test("isBriefingEcho: a note restating its session's briefing is an echo; a new fact is not", () => {
  const briefing = "Reference notes. Run the tests with npm test from the repo root, then deploy with the release script.";
  assert.equal(isBriefingEcho("Run the tests with npm test from the repo root", briefing), true);
  assert.equal(isBriefingEcho("Deploys need the VPN switched on first", briefing), false);
  assert.equal(isBriefingEcho("anything", ""), false);
});

test("buildPageEdit splices one section and keeps the rest byte for byte; stamps verified and merges sources", () => {
  const cur = "---\ntitle: Gotchas\nsources:\n  - commit:abc1234\n---\n# Gotchas\n\nKeep this exactly.   \n\n## Cache\n\nold\n\n## Other\n\nstays\n";
  const r = buildPageEdit(cur, { target: { path: "projects/x-0123456789/gotchas.md", section: "Cache" }, content: "new cache note" }, { today: "2026-11-17", sources: ["msg:s/m"] });
  assert.match(r.source, /Keep this exactly\.   \n/);
  assert.match(r.source, /## Cache\n\nnew cache note\n\n## Other\n\nstays\n/);
  assert.match(r.source, /verified: 2026-11-17/);
  assert.match(r.source, /commit:abc1234/);
  assert.match(r.source, /msg:s\/m/);
  assert.equal(r.scopeBefore.trim(), "old");
  const fresh = buildPageEdit(null, { target: { path: "projects/x-0123456789/run-and-test.md" }, content: "# Run and test\n\nnpm test\n" }, { today: "2026-11-17", sources: ["msg:s/m"] });
  assert.match(fresh.source, /^---\ntitle: Run And Test\n/);
});

test("removedUserLines names only the user's lines that disappear; checkBudgets enforces the briefing and rules limits", () => {
  const user = new Set(["- never touch the lockfile"]);
  assert.deepEqual(removedUserLines({ before: "- never touch the lockfile\n- other", after: "- other", userSet: user }), ["- never touch the lockfile"]);
  assert.deepEqual(removedUserLines({ before: "- never touch the lockfile", after: "- Never   touch the lockfile\n- more", userSet: user }), []);
  const long = `## Briefing\n\n${Array.from({ length: 61 }, (_, i) => `line ${i}`).join("\n")}\n`;
  assert.equal(checkBudgets("projects/x-0123456789/overview.md", long).ok, false);
  assert.equal(checkBudgets("projects/x-0123456789/overview.md", "## Briefing\n\nshort\n").ok, true);
  const rules = Array.from({ length: 121 }, (_, i) => `- rule ${i}`).join("\n");
  assert.equal(checkBudgets("projects/x-0123456789/rules.md", `# Rules\n\n${rules}\n`).ok, false);
});

// ---- the validator ------------------------------------------------------------------------

const SLUG = "widget-0123456789";
function validatorRig({ files = {}, user = new Set(), messages = {}, shell = {}, tomb = [] } = {}) {
  const store = { read: async (p) => files[p] ?? null };
  const tombstones = createTombstones({ store: { read: async () => JSON.stringify({ version: 1, tombstones: tomb }) } });
  const v = createDecisionValidator({
    store,
    tombstones,
    isUserAuthoredRef: (ref) => user.has(ref),
    readMessages: async ({ sessionID, messageIDs }) => messageIDs.map((id) => ({ id, ...(messages[sessionID]?.[id] ?? {}) })).filter((m) => m.role),
    readShellCommands: async (s) => shell[s] ?? null,
  });
  return v;
}
const vctx = (over = {}) => ({ slug: SLUG, sharing: "share-and-read", allowedRefs: null, clusters: new Map(), bases: new Map(), refSharing: () => true, ...over });
const u = (sid, mid, text) => ({ ref: `msg:${sid}/${mid}`, text });
function ruleRig(msgs) {
  const user = new Set(msgs.map((m) => m.ref));
  const messages = {};
  for (const m of msgs) {
    const [, sid, mid] = /^msg:([^/]+)\/(.+)$/.exec(m.ref);
    (messages[sid] ??= {})[mid] = { role: "user", text: m.text };
  }
  return validatorRig({ user, messages });
}
const RULE = "Use pnpm for installing packages, never npm";
const rule = (evidence, extra = {}) => ({ type: "rule.add", target: { area: "project" }, content: RULE, reason: "Repeated correction", evidence, ...extra });
const A1 = "no, use pnpm for installing packages here, not npm";
const A2 = "I told you before: pnpm is what installs packages in this repo";
const A3 = "again: always use pnpm for installing packages please";
const q = (m) => ({ ref: m.ref, quote: m.text });

test("rules: three verified corrections pass; the quote must be in the user's message; the message must be user-authored", async () => {
  const msgs = [u("ses_a", "msg_1", A1), u("ses_a", "msg_2", A2), u("ses_a", "msg_3", A3)];
  const v = ruleRig(msgs);
  const ok = await v.validate(rule(msgs.map(q)), vctx());
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.evidence.length, 3);
  assert.equal(ok.kind, "rule");

  const wrongQuote = await v.validate(rule(msgs.map((m) => ({ ref: m.ref, quote: "words that are not there at all" }))), vctx());
  assert.deepEqual([wrongQuote.ok, wrongQuote.kind], [false, "skipped"]);
  assert.match(wrongQuote.reason, /Not enough evidence/);

  const notUser = validatorRig({ user: new Set(), messages: { ses_a: { msg_1: { role: "user", text: A1 } } } });
  const r2 = await notUser.validate(rule([{ ref: "msg:ses_a/msg_1", quote: A1 }]), vctx());
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not a message you wrote/);
});

test("rules: two corrections in one session fail; the same correction in two sessions passes; short quotes don't count", async () => {
  const same = [u("ses_a", "msg_1", A1), u("ses_a", "msg_2", A2)];
  assert.equal((await ruleRig(same).validate(rule(same.map(q)), vctx())).ok, false);
  const two = [u("ses_a", "msg_1", A1), u("ses_b", "msg_1", A3)];
  assert.equal((await ruleRig(two).validate(rule(two.map(q)), vctx())).ok, true);
  assert.equal((await ruleRig(two).validate(rule(two.map((m) => ({ ref: m.ref, quote: "pnpm" }))), vctx())).ok, false);
});

test("support: a rule unrelated to the quoted messages is refused even though the quotes are real and enough", async () => {
  const msgs = [u("ses_a", "msg_1", A1), u("ses_a", "msg_2", A2), u("ses_b", "msg_1", A3)];
  const v = ruleRig(msgs);
  const r = await v.validate(rule(msgs.map(q), { content: "Always write database migrations in plain SQL files" }), vctx());
  assert.deepEqual([r.ok, r.kind], [false, "skipped"]);
  assert.match(r.reason, /isn't backed by what you wrote/);
  // a quote that is real but too short, or shares only one content word, doesn't back it either
  const thin = await v.validate(rule([{ ref: msgs[0].ref, quote: "use pnpm for installing" }, { ref: msgs[1].ref, quote: "pnpm is what installs" }, { ref: msgs[2].ref, quote: "again: always use pnpm" }], { content: "Prefer pnpm workspaces" }), vctx());
  assert.equal(thin.ok, false);
  // preferences too
  const pref = await v.validate({ type: "preference.set", target: {}, content: "Write commit messages in the imperative mood", reason: "x", evidence: msgs.map(q) }, vctx());
  assert.equal(pref.ok, false);
});

test("support: with a cluster, the rule must overlap the cluster's lesson (wrong cluster refused)", async () => {
  const msgs = [u("ses_a", "msg_1", A1), u("ses_b", "msg_1", A3)];
  const v = ruleRig(msgs);
  const cluster = (lesson) => ({ clusterId: "cl1", kind: "correction", lesson, slug: SLUG, sessions: 2, count: 2, evidence: msgs.map((m) => ({ ref: m.ref, quote: m.text, sessionID: m.ref.split(/[:/]/)[1] })) });
  const ask = (lesson) => v.validate(rule([], { clusterId: "cl1" }), vctx({ clusters: new Map([["cl1", cluster(lesson)]]) }));
  const wrong = await ask("Never mock the database in integration tests");
  assert.deepEqual([wrong.ok, wrong.kind], [false, "skipped"]);
  assert.match(wrong.reason, /doesn't match the repeated correction/);
  assert.equal((await ask("Use pnpm for installing packages instead of npm")).ok, true);
});

test("a rule or preference citing only derived (assistant/part) refs can never pass", async () => {
  const v = validatorRig({ user: new Set(), messages: {} });
  for (const type of ["rule.add", "preference.set"]) {
    const r = await v.validate({ type, target: {}, content: "Always rebase before merging", reason: "x", evidence: [{ ref: "part:ses_a/prt_1", quote: "always rebase before merging please" }, { ref: "msg:ses_b/msg_1", quote: "always rebase before merging please" }] }, vctx());
    assert.equal(r.ok, false);
  }
});

test("a cluster from the detector grounds a rule (its evidence replaces the model's), but each quote is still verified", async () => {
  const msgs = [u("ses_a", "msg_1", "do not mock the database in integration tests"), u("ses_b", "msg_1", "stop mocking the database in integration tests")];
  const v = ruleRig(msgs);
  const cluster = { clusterId: "cl1", kind: "correction", lesson: "Do not mock the database in integration tests", slug: SLUG, sessions: 2, count: 2, evidence: msgs.map((m) => ({ ref: m.ref, quote: m.text, sessionID: m.ref.split(/[:/]/)[1] })) };
  const ask = (vv) => vv.validate({ type: "rule.add", target: {}, content: "Don't mock the database in integration tests", reason: "x", evidence: [], clusterId: "cl1" }, vctx({ clusters: new Map([["cl1", cluster]]) }));
  const r = await ask(v);
  assert.equal(r.ok, true);
  assert.equal(r.decision.clusterId, "cl1");
  assert.equal((await ask(ruleRig([]))).ok, false);
});

test("rule.remove needs a verified user message about that rule; preference.set goes to user/ only for a sharing project", async () => {
  const msgs = [u("ses_a", "msg_1", "please drop the rule about using pnpm for installs"), u("ses_b", "msg_1", "use tabs for indentation, not spaces anywhere"), u("ses_c", "msg_1", "tabs please, always indent with tabs")];
  const v = ruleRig(msgs);
  const remove = (extra = {}) => ({ type: "rule.remove", target: {}, content: "Use pnpm for installing packages", reason: "user said so", evidence: [{ ref: msgs[0].ref, quote: "drop the rule about using pnpm" }], ...extra });
  assert.equal((await v.validate(remove(), vctx())).ok, true);
  assert.equal((await v.validate(remove({ evidence: [] }), vctx())).ok, false);
  const other = await v.validate(remove({ content: "Keep pull requests small and focused" }), vctx());
  assert.equal(other.ok, false);
  assert.match(other.reason, /None of the messages you wrote is about that rule/);
  const pref = { type: "preference.set", target: { area: "user" }, content: "Indent code with tabs, not spaces", reason: "x", evidence: msgs.slice(1).map(q) };
  assert.deepEqual((await v.validate(pref, vctx())).decision.target, { area: "user" });
  assert.deepEqual((await v.validate(pref, vctx({ sharing: "read-only" }))).decision.target, { area: "project", slug: SLUG });
});

test("page claims: need a ref; commands must have been executed in a cited session; commons only from sharing projects", async () => {
  const page = (extra = {}) => ({ type: "page.edit", target: { area: "project", path: `projects/${SLUG}/run-and-test.md` }, content: "Run:\n\n```bash\nnpm run verify\n```\n", reason: "How to test", evidence: [{ ref: "msg:ses_a/msg_1" }], ...extra });
  const none = await validatorRig().validate(page({ evidence: [] }), vctx());
  assert.deepEqual([none.ok, none.kind], [false, "skipped"]);

  const unrun = await validatorRig({ shell: { ses_a: ["npm test"] } }).validate(page(), vctx());
  assert.equal(unrun.ok, false);
  assert.match(unrun.reason, /wasn't run/);
  assert.equal((await validatorRig({ shell: { ses_a: ["cd /w && npm run verify"] } }).validate(page(), vctx())).ok, true);
  assert.equal((await validatorRig().validate(page(), vctx())).ok, false); // no reader → fail closed

  // a command already on the page is not new
  const had = validatorRig({ files: { [`projects/${SLUG}/run-and-test.md`]: "```bash\nnpm run verify\n```\n" } });
  assert.equal((await had.validate(page(), vctx())).ok, true);

  const commons = { type: "page.edit", target: { area: "commons", path: "commons/howto/ci.md" }, content: "Generic steps.", reason: "x", evidence: [{ ref: "msg:ses_a/msg_1" }] };
  assert.equal((await validatorRig().validate(commons, vctx({ sharing: "read-only" }))).ok, false);
  assert.equal((await validatorRig().validate(commons, vctx())).ok, true);
  const filtered = await validatorRig().validate({ ...commons, evidence: [{ ref: "msg:ses_a/msg_1" }, { ref: "msg:priv/msg_1" }] }, vctx({ refSharing: (r) => !r.includes("priv") }));
  assert.deepEqual(filtered.decision.evidence, [{ ref: "msg:ses_a/msg_1" }]);
  assert.equal((await validatorRig().validate(commons, vctx({ refSharing: () => false }))).ok, false);
});

test("page.edit guards: another project's page, rules.md and preferences go through their own decisions, refs must be in the notes", async () => {
  const v = validatorRig();
  const base = { type: "page.edit", content: "x", reason: "r", evidence: [{ ref: "msg:ses_a/msg_1" }] };
  assert.equal((await v.validate({ ...base, target: { path: "projects/other-0123456789/gotchas.md" } }, vctx())).ok, false);
  assert.equal((await v.validate({ ...base, target: { path: `projects/${SLUG}/rules.md` } }, vctx())).kind, "skipped");
  assert.equal((await v.validate({ ...base, target: { path: "user/preferences.md" } }, vctx())).kind, "skipped");
  assert.equal((await v.validate({ ...base, target: { path: `projects/${SLUG}/how-the-user-works-here.md` } }, vctx())).kind, "skipped");
  assert.equal((await v.validate({ ...base, target: { path: "../etc/passwd" } }, vctx())).ok, false);
  const inv = await v.validate({ ...base, target: { path: `projects/${SLUG}/gotchas.md` } }, vctx({ allowedRefs: new Set(["msg:ses_a/zzz"]) }));
  assert.equal(inv.ok, false);
  assert.match(inv.reason, /wasn't in the notes/);
});

test("tombstones: an undone claim, an undone cluster and an undone skill source set are all dropped", async () => {
  const msgs = [u("ses_a", "msg_1", A1), u("ses_b", "msg_1", A3)];
  const ev = msgs.map(q);
  const files = { [`projects/${SLUG}/gotchas.md`]: "" };
  const tombRule = { key: decisionKey({ kind: "rule", target: `project:${SLUG}::`, claim: RULE }), kind: "rule", target: `project:${SLUG}::`, claim: RULE, at: 1 };
  assert.equal((await ruleRig(msgs).validate(rule(ev), vctx())).ok, true);
  const rig = (tomb, extra = {}) => validatorRig({ user: new Set(msgs.map((m) => m.ref)), messages: { ses_a: { msg_1: { role: "user", text: msgs[0].text } }, ses_b: { msg_1: { role: "user", text: msgs[1].text } } }, tomb, files, ...extra });
  const dropped = await rig([tombRule]).validate(rule(ev), vctx());
  assert.deepEqual([dropped.ok, dropped.kind, dropped.tombstoned], [false, "dropped", true]);
  const cl = { clusterId: "cl9", kind: "correction", lesson: "Use pnpm for installing packages", slug: SLUG, sessions: 2, count: 2, evidence: msgs.map((m) => ({ ref: m.ref, quote: m.text, sessionID: "s" })) };
  const byCluster = await rig([{ key: "k", kind: "rule", target: "project:x::", claim: "different wording", clusterId: "cl9", at: 1 }]).validate(rule([], { clusterId: "cl9" }), vctx({ clusters: new Map([["cl9", cl]]) }));
  assert.equal(byCluster.tombstoned, true);
  const ts = createTombstones({ store: { read: async () => JSON.stringify({ version: 1, tombstones: [{ key: "s", kind: "skill", target: "skill:x", claim: "x", sources: ["a", "b", "c"], at: 1 }] }) } });
  assert.ok(await ts.match({ kind: "skill", target: "skill:y", claim: "y", sources: ["a", "c"] }));
  assert.equal(await ts.match({ kind: "skill", target: "skill:y", claim: "y", sources: ["a", "z"] }), null);
});

test("skill.propose is refused in the curator loop; drop passes through; unknown areas are dropped", async () => {
  const v = validatorRig();
  assert.equal((await v.validate({ type: "skill.propose", target: {}, reason: "x", evidence: [] }, vctx())).kind, "skipped");
  assert.equal((await v.validate({ type: "drop", reason: "noise", evidence: [] }, vctx())).drop, true);
  assert.equal((await v.validate({ type: "page.edit", target: { area: "elsewhere", path: "x" }, content: "x", reason: "r", evidence: [] }, vctx())).kind, "dropped");
});

test("createMessageCache: one read fills a session's neighbourhood, reads are bounded, unknown differs from missing", async () => {
  const calls = [];
  const all = ["a", "b", "c"].map((id) => ({ id, role: "user", text: id }));
  const cache = createMessageCache({ maxReads: 2, readMessages: async ({ sessionID, messageIDs, radius }) => (calls.push([sessionID, messageIDs, radius]), sessionID === "bad" ? Promise.reject(new Error("x")) : messageIDs[0] === "gone" || sessionID === "empty" ? [] : all) });
  await cache.prefetch(["msg:s1/a", "msg:s1/b", "part:s1/c"]);
  assert.equal(calls.length, 1, "the neighbours came with the first read");
  assert.deepEqual(calls[0].slice(0, 2), ["s1", ["a"]]);
  assert.equal((await cache.get("s1", "b")).id, "b");
  assert.equal(await cache.get("s1", "gone"), null); // the session answered; it isn't there
  assert.equal(calls.length, 2);
  assert.equal(await cache.get("s2", "a"), undefined); // budget spent: unknown, not "missing"
  assert.equal(await createMessageCache({ readMessages: async () => { throw new Error("x"); } }).get("s", "m"), undefined);
  assert.equal(cache.reads, 2);
});

test("support.mjs: a quote supports a claim only when it is ≥ 20 characters and shares ≥ 2 content words", () => {
  assert.equal(quoteSupports("Use pnpm for installing packages", "no, use pnpm for installing packages here"), true);
  assert.equal(quoteSupports("Use pnpm for installing packages", "pnpm is what installs everything"), false, "only one shared content word");
  assert.equal(quoteSupports("Use pnpm for installing packages", "pnpm installing"), false, "too short");
  assert.equal(quoteSupports("Write migrations in SQL", "that is what you should have done there"), false, "stop words don't count");
  assert.equal(quoteSupports("Use PNPM for   installing packages", "NO,   USE pnpm for installing  packages!!"), true, "case and whitespace don't matter");
  assert.equal(claimSupported("Use pnpm for installing packages", ["too short", "no, use pnpm for installing packages here"]), true);
  assert.equal(claimSupported("Use pnpm for installing packages", []), false);
  assert.equal(claimSupported("Use pnpm for installing packages", undefined), false);
});

test("buildPageEdit leaves unparsable front matter exactly as it was (no second front matter block)", () => {
  const broken = "---\ntitle: [unclosed\n---\n# Gotchas\n\nold\n";
  const r = buildPageEdit(broken, { target: { path: "projects/x-0123456789/gotchas.md" }, content: "# Gotchas\n\nnew\n" }, { today: "2026-11-17", sources: ["msg:s/m"] });
  assert.equal(r.source, "---\ntitle: [unclosed\n---\n# Gotchas\n\nnew\n");
});
