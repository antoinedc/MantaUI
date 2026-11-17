import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageEdit, checkBudgets, commandExecuted, containsQuote, createDecisionValidator, extractCommands, isBriefingEcho, newCommandLines, normalizeDecision, parseDecisionOutput, removedUserLines } from "./decisions.mjs";
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
  assert.equal(commandExecuted("npm   test", ["cd /x &&  npm test -- --watch"]), true);
  assert.equal(commandExecuted("rm -rf /", ["npm test"]), false);
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
const rule = (evidence, extra = {}) => ({ type: "rule.add", target: { area: "project" }, content: "Use pnpm, never npm", reason: "Repeated correction", evidence, ...extra });

test("rules: three verified corrections pass; the quote must be in the user's message; the message must be user-authored", async () => {
  const msgs = [u("ses_a", "msg_1", "no, use pnpm not npm"), u("ses_a", "msg_2", "I said use pnpm"), u("ses_a", "msg_3", "again: use pnpm please")];
  const v = ruleRig(msgs);
  const ok = await v.validate(rule(msgs.map((m) => ({ ref: m.ref, quote: m.text.slice(0, 12) }))), vctx());
  assert.equal(ok.ok, true);
  assert.equal(ok.decision.evidence.length, 3);
  assert.equal(ok.kind, "rule");

  const wrongQuote = await v.validate(rule(msgs.map((m) => ({ ref: m.ref, quote: "words that are not there" }))), vctx());
  assert.deepEqual([wrongQuote.ok, wrongQuote.kind], [false, "skipped"]);
  assert.match(wrongQuote.reason, /Not enough evidence/);

  const notUser = validatorRig({ user: new Set(), messages: { ses_a: { msg_1: { role: "user", text: "use pnpm" } } } });
  const r2 = await notUser.validate(rule([{ ref: "msg:ses_a/msg_1", quote: "use pnpm" }]), vctx());
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not a message you wrote/);
});

test("rules: two corrections in one session fail; the same correction in two sessions passes; short quotes don't count", async () => {
  const same = [u("ses_a", "msg_1", "use pnpm not npm"), u("ses_a", "msg_2", "use pnpm not npm!")];
  assert.equal((await ruleRig(same).validate(rule(same.map((m) => ({ ref: m.ref, quote: "use pnpm not npm" }))), vctx())).ok, false);
  const two = [u("ses_a", "msg_1", "use pnpm not npm"), u("ses_b", "msg_1", "please use pnpm not npm")];
  assert.equal((await ruleRig(two).validate(rule(two.map((m) => ({ ref: m.ref, quote: "use pnpm not npm" }))), vctx())).ok, true);
  assert.equal((await ruleRig(two).validate(rule(two.map((m) => ({ ref: m.ref, quote: "pnpm" }))), vctx())).ok, false);
});

test("a rule or preference citing only derived (assistant/part) refs can never pass", async () => {
  const v = validatorRig({ user: new Set(), messages: {} });
  for (const type of ["rule.add", "preference.set"]) {
    const r = await v.validate({ type, target: {}, content: "Always rebase", reason: "x", evidence: [{ ref: "part:ses_a/prt_1", quote: "always rebase please" }, { ref: "msg:ses_b/msg_1", quote: "always rebase please" }] }, vctx());
    assert.equal(r.ok, false);
  }
});

test("a cluster from the detector grounds a rule (its evidence replaces the model's), but each quote is still verified", async () => {
  const msgs = [u("ses_a", "msg_1", "do not mock the database"), u("ses_b", "msg_1", "stop mocking the database")];
  const v = ruleRig(msgs);
  const cluster = { clusterId: "cl1", kind: "correction", lesson: "x", slug: SLUG, sessions: 2, count: 2, evidence: msgs.map((m) => ({ ref: m.ref, quote: m.text, sessionID: m.ref.split(/[:/]/)[1] })) };
  const r = await v.validate({ type: "rule.add", target: {}, content: "Don't mock the database", reason: "x", evidence: [], clusterId: "cl1" }, vctx({ clusters: new Map([["cl1", cluster]]) }));
  assert.equal(r.ok, true);
  assert.equal(r.decision.clusterId, "cl1");
  const bad = await ruleRig([]).validate({ type: "rule.add", target: {}, content: "Don't mock the database", reason: "x", evidence: [], clusterId: "cl1" }, vctx({ clusters: new Map([["cl1", cluster]]) }));
  assert.equal(bad.ok, false);
});

test("rule.remove needs one verified user quote; preference.set goes to user/ only for a sharing project", async () => {
  const msgs = [u("ses_a", "msg_1", "drop the rule about pnpm"), u("ses_b", "msg_1", "use tabs, not spaces"), u("ses_c", "msg_1", "tabs please, always tabs")];
  const v = ruleRig(msgs);
  assert.equal((await v.validate({ type: "rule.remove", target: {}, content: "Use pnpm", reason: "user said so", evidence: [{ ref: msgs[0].ref, quote: "drop the rule" }] }, vctx())).ok, true);
  assert.equal((await v.validate({ type: "rule.remove", target: {}, content: "Use pnpm", reason: "x", evidence: [] }, vctx())).ok, false);
  const pref = { type: "preference.set", target: { area: "user" }, content: "Indent with tabs", reason: "x", evidence: msgs.slice(1).map((m) => ({ ref: m.ref, quote: m.text.slice(0, 9) })) };
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
  assert.equal((await v.validate({ ...base, target: { path: "../etc/passwd" } }, vctx())).ok, false);
  const inv = await v.validate({ ...base, target: { path: `projects/${SLUG}/gotchas.md` } }, vctx({ allowedRefs: new Set(["msg:ses_a/zzz"]) }));
  assert.equal(inv.ok, false);
  assert.match(inv.reason, /wasn't in the notes/);
});

test("tombstones: an undone claim, an undone cluster and an undone skill source set are all dropped", async () => {
  const msgs = [u("ses_a", "msg_1", "use pnpm not npm"), u("ses_b", "msg_1", "use pnpm not npm please")];
  const ev = msgs.map((m) => ({ ref: m.ref, quote: "use pnpm not npm" }));
  const files = { [`projects/${SLUG}/gotchas.md`]: "" };
  const tombRule = { key: "", kind: "rule", target: `project:${SLUG}::`, claim: "Use pnpm, never npm", at: 1 };
  tombRule.key = decisionKey({ kind: "rule", target: `project:${SLUG}::`, claim: "Use pnpm, never npm" });
  const byClaim = await ruleRig(msgs).validate(rule(ev), vctx());
  assert.equal(byClaim.ok, true);
  const v1 = validatorRig({ user: new Set(msgs.map((m) => m.ref)), messages: { ses_a: { msg_1: { role: "user", text: msgs[0].text } }, ses_b: { msg_1: { role: "user", text: msgs[1].text } } }, tomb: [tombRule], files });
  const dropped = await v1.validate(rule(ev), vctx());
  assert.deepEqual([dropped.ok, dropped.kind, dropped.tombstoned], [false, "dropped", true]);
  const v2 = validatorRig({ user: new Set(msgs.map((m) => m.ref)), messages: { ses_a: { msg_1: { role: "user", text: msgs[0].text } }, ses_b: { msg_1: { role: "user", text: msgs[1].text } } }, tomb: [{ key: "k", kind: "rule", target: "project:x::", claim: "different wording", clusterId: "cl9", at: 1 }] });
  const cl = { clusterId: "cl9", kind: "correction", lesson: "x", slug: SLUG, sessions: 2, count: 2, evidence: msgs.map((m) => ({ ref: m.ref, quote: "use pnpm not npm", sessionID: "s" })) };
  assert.equal((await v2.validate(rule([], { clusterId: "cl9" }), vctx({ clusters: new Map([["cl9", cl]]) }))).tombstoned, true);
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
