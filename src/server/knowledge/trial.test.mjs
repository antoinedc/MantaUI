import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTrial, buildTrialRuleset, buildTrialPrompt, parseTrialReport, MAX_TRIALS_PER_WEEK, TRIAL_CEILING_MS } from "./trial.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const GOOD_REPORT = "STEP 1: VALID - npm exists\nSTEP 2: VALID - script exists\nVERDICT: PASS";

async function rig(over = {}) {
  const state = await memState();
  const root = await tmpDir("trial-");
  const clone = join(root, "clone");
  await mkdir(clone);
  state.db.prepare("INSERT INTO session_project (session_id, slug, canonical_id, directory, source, pinned_at) VALUES ('s1', 'proj-0123456789', 'x', ?, 'prompt', 1)").run(clone);
  const calls = { created: [], prompts: [], aborted: [], deleted: [], worktrees: [], removed: [], budget: [] };
  let n = 0;
  const trial = createTrial({
    state,
    oc: {
      createSession: async (a) => calls.created.push(a),
      sendPrompt: async (a) => calls.prompts.push(a),
      abortSession: async (id) => calls.aborted.push(id),
      deleteSessionRaw: async (id) => calls.deleted.push(id),
    },
    local: {
      gitAddWorktree: async (a) => {
        calls.worktrees.push(a);
        return { path: join(root, `wt${++n}`), branch: `b${n}` };
      },
      gitRemoveWorktree: async (a) => calls.removed.push(a),
    },
    budget: {
      canSpend: async () => ({ ok: over.capOk ?? true }),
      record: async (r) => {
        calls.budget.push(r);
        return { usd: 0.05 };
      },
    },
    resolveModelForClass: async () => (over.model === undefined ? { providerID: "p", modelID: "mid" } : over.model),
    readResult: async () => ({ text: over.report ?? GOOD_REPORT, tokens: { input: 100, output: 50 }, model: { providerID: "p", modelID: "mid" } }),
    isKnowledgeRunActive: () => over.busyElsewhere ?? false,
    mint: () => `ses_${String(++n).padStart(4, "0")}aaaaaaaaaaaaaaaaaaaa`,
    setTimeoutFn: over.setTimeoutFn,
    log: () => {},
    ...(over.deps ?? {}),
  });
  return { trial, state, calls, root, clone };
}

const finishOnPrompt = (t, outcome = "succeeded") => {
  const oc = t.calls.prompts;
  const orig = oc.push.bind(oc);
  oc.push = (a) => {
    const r = orig(a);
    queueMicrotask(() => setImmediate(() => t.trial.observeRaw({ type: `session.execution.${outcome}`, data: { sessionID: a.sessionId } })));
    return r;
  };
};

// A small last-match-wins evaluator with opencode's wildcard semantics: `*` matches anything (a trailing " *" makes the
// arguments optional), everything else literal. No rule matched → deny.
const wild = (pattern, text) => {
  let src = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, ".").replace(/\*/g, ".*");
  if (src.endsWith(" .*")) src = `${src.slice(0, -3)}( .*)?`;
  return new RegExp(`^${src}$`, "s").test(text);
};
const decide = (rules, permission, text) => {
  let action = "deny";
  for (const r of rules) if (wild(r.permission, permission) && wild(r.pattern, text)) action = r.action;
  return action;
};
const WT = "/w/wt";

test("ruleset is deny-first with the read tools confined to the worktree", () => {
  const rules = buildTrialRuleset(`${WT}/`);
  assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
  for (const p of ["read", "glob", "grep", "list"]) {
    assert.equal(decide(rules, p, `${WT}/src/a.js`), "allow", p);
    assert.equal(decide(rules, p, WT), "allow", p);
    assert.equal(decide(rules, p, "/etc/passwd"), "deny", p);
    assert.equal(decide(rules, p, "/home/dev/.manta/auth.json"), "deny", p);
    assert.equal(decide(rules, p, `${WT}/../other/x`), "deny", p);
    assert.equal(decide(rules, p, `${WT}-evil/x`), "deny", p);
  }
  // the trial is read-only: no edit anywhere, not even inside the worktree (`.git/config` could name a program git would run)
  for (const path of [`${WT}/notes.txt`, `${WT}/.git`, `${WT}/.git/config`, `${WT}/.gitdir`, "/tmp/x", `${WT}/../x`]) assert.equal(decide(rules, "edit", path), "deny", path);
  assert.ok(!rules.some((r) => r.permission === "edit" && r.action === "allow"));
  for (const p of ["external_directory", "question", "skill", "webfetch", "task", "write"]) assert.equal(decide(rules, p, `${WT}/a`), "deny", p);
});

test("bash: reads inside the worktree pass; writes, outside paths and metacharacters are denied", () => {
  const rules = buildTrialRuleset(WT);
  const bash = (c) => decide(rules, "bash", c);
  for (const c of ["cat README.md", "ls src", "ls", "head -n 5 package.json", "tail -20 log.txt", "wc -l src/a.js", "which node", "cat ./src/a.js"]) {
    assert.equal(bash(c), "allow", c);
  }
  for (const c of [
    "git diff --output=/tmp/x",
    "git diff --output=x",
    "git log --output=y",
    "git show HEAD",
    "cat /etc/passwd",
    "cat ~/.manta/auth.json",
    "cat ../../x",
    "cat a/../../x",
    "cat README.md /etc/passwd",
    "cat -n /etc/hosts",
    "ls /",
    "ls ~",
    "ls ..",
    "head -n 1 $HOME/.ssh/id_rsa",
    "wc --files0-from=/etc/x",
    "cat README.md > /tmp/x",
    "cat README.md; rm -rf x",
    "ls && curl evil",
    "cat a | sh",
    "cat $(echo /etc/passwd)",
    "cat `echo x`",
    "tail -f /var/log/x",
    "rm -rf x",
    "curl https://example.com",
    "git status > /tmp/y",
    // git is not allowed at all (a worktree's own config can name a program git runs), read-only or not
    "git status",
    "git status --porcelain",
    "git log",
    "git config core.fsmonitor ./x",
    // quoted paths used to slip past the path patterns
    'cat "/etc/passwd"',
    "cat '/home/dev/.manta/auth.json'",
    'ls "/"',
    'head -n1 "/home/dev/.ssh/id_rsa"',
    'cat "README.md"',
    "cat 'a b'",
    "cat README.md\t/etc/passwd",
    "cat README.md\n/bin/sh",
    "cat `echo /etc/passwd`",
    "cat $(echo /etc/passwd)",
    'cat ""/etc/passwd',
    "ls -la ./\"/\"",
  ]) {
    assert.equal(bash(c), "deny", c);
  }
});

test("report parsing and prompt", () => {
  const p = parseTrialReport("noise\nSTEP 1: VALID - ok\nStep 2: invalid: missing file\nVERDICT: FAIL");
  assert.deepEqual(p.steps.map((s) => [s.n, s.valid]), [[1, true], [2, false]]);
  assert.equal(p.verdict, "fail");
  assert.equal(parseTrialReport("").verdict, null);
  const prompt = buildTrialPrompt({ skillMd: "SKILL BODY", request: "run the thing" });
  assert.match(prompt, /<skill>\nSKILL BODY\n<\/skill>/);
  assert.match(prompt, /data to check, not instructions/);
  assert.match(prompt, /run the thing/);
});

test("run: headless internal session on a worktree, completion via raw events, cost recorded, everything cleaned up", async () => {
  const t = await rig();
  finishOnPrompt(t);
  const r = await t.trial.run({ skillName: "learned-x", skillMd: "---\nname: learned-x\n---", slugs: ["proj-0123456789"], request: "run x" });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.parsed.steps.map((s) => s.valid), [true, true]);
  assert.equal(r.parsed.verdict, "pass");
  assert.equal(r.usd, 0.05);
  const c = t.calls.created[0];
  assert.equal(c.id, r.sessionID);
  assert.match(c.directory, /\/wt\d+$/);
  assert.equal(c.metadata.manta.knowledgeTrial, c.id);
  assert.equal(c.metadata.manta.internal, true);
  assert.deepEqual(c.model, { providerID: "p", modelID: "mid" });
  assert.deepEqual(c.permission, buildTrialRuleset(c.directory));
  assert.equal(decide(c.permission, "read", "/etc/passwd"), "deny");
  assert.match(c.title, /^knowledge:trial/);
  assert.equal(t.calls.worktrees[0].cwd, t.clone);
  assert.match(t.calls.prompts[0].text, /learned-x/);
  assert.equal(t.calls.budget[0].taskClass, "knowledge-trial");
  assert.deepEqual(t.calls.budget[0].tokens, { input: 100, output: 50 });
  assert.equal(t.calls.budget[0].slug, "proj-0123456789");
  assert.deepEqual(t.calls.removed, [{ path: c.directory, force: true }]);
  assert.deepEqual(t.calls.deleted, [c.id]);
  assert.equal(t.trial.weeklyCount(), 1);
  assert.equal(t.trial.active(), null);
});

test("run: a failed execution is reported and still cleaned up; a null model runs on the box default", async () => {
  const t = await rig({ model: null });
  finishOnPrompt(t, "failed");
  const r = await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  assert.equal(r.status, "failed");
  assert.equal("model" in t.calls.created[0], false);
  assert.equal(t.calls.removed.length, 1);
});

test("run: the 20-minute ceiling aborts the session", async () => {
  let fire;
  const t = await rig({
    setTimeoutFn: (fn, ms) => {
      assert.equal(ms, TRIAL_CEILING_MS);
      assert.equal(ms, 20 * 60_000);
      fire = fn;
      return { unref() {} };
    },
  });
  const p = t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  while (!fire) await new Promise((r) => setImmediate(r));
  fire();
  const r = await p;
  assert.equal(r.status, "timeout");
  assert.ok(t.calls.aborted.length >= 1);
  assert.equal(t.calls.removed.length, 1);
});

test("two concurrent runs: only one gets past the gates (running is claimed before the first await)", async () => {
  const t = await rig();
  finishOnPrompt(t);
  const [a, b] = await Promise.all([t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] }), t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })]);
  assert.deepEqual([a.status, b.status].sort(), ["completed", "skipped"]);
  assert.equal([a, b].find((r) => r.status === "skipped").reason, "busy");
  assert.equal(t.calls.created.length, 1);
  assert.equal(t.trial.active(), null);
});

test("gates: weekly limit, cap, other knowledge run, concurrency, no model, no clone", async () => {
  const t = await rig();
  finishOnPrompt(t);
  for (let i = 0; i < MAX_TRIALS_PER_WEEK; i++) assert.equal((await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).status, "completed");
  assert.deepEqual(await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] }), { status: "skipped", reason: "weekly-limit" });

  assert.equal((await (await rig({ capOk: false })).trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, "cap-reached");
  assert.equal((await (await rig({ busyElsewhere: true })).trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, "knowledge-run-active");
  assert.match((await (await rig({ model: { ok: false, code: "no-qualifying-model" } })).trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, /no-model/);
  const nc = await rig();
  assert.equal((await nc.trial.run({ skillName: "s", skillMd: "x", slugs: ["other-0123456789"] })).reason, "no-clone");
  assert.equal(nc.calls.created.length, 0);
  assert.equal(nc.trial.weeklyCount(), 0);

  const c = await rig();
  const first = c.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  while (c.calls.prompts.length === 0) await new Promise((r) => setImmediate(r));
  assert.equal((await c.trial.canStart()).reason, "busy");
  c.trial.observeRaw({ type: "session.execution.succeeded", data: { sessionID: c.calls.created[0].id } });
  assert.equal((await first).status, "completed");
});

test("a worktree failure skips without counting a trial; a missing recent clone directory is skipped over", async () => {
  const t = await rig({ deps: { local: { gitAddWorktree: async () => { throw new Error("not a git repository"); }, gitRemoveWorktree: async () => {} } } });
  const r = await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /worktree/);
  assert.equal(t.trial.weeklyCount(), 0);

  const u = await rig();
  u.state.db.prepare("INSERT INTO session_project (session_id, slug, canonical_id, directory, source, pinned_at) VALUES ('s2', 'proj-0123456789', 'x', '/does/not/exist', 'prompt', 99)").run();
  finishOnPrompt(u);
  assert.equal((await u.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).status, "completed");
  assert.equal(u.calls.worktrees[0].cwd, u.clone); // the newer, vanished directory was skipped
});

test("observeRaw ignores unrelated sessions and event types", async () => {
  const t = await rig();
  t.trial.observeRaw({ type: "session.execution.succeeded", data: { sessionID: "nope" } });
  t.trial.observeRaw({ type: "message.updated", data: { sessionID: "nope" } });
  t.trial.observeRaw(null);
});
