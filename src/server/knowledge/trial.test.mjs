import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTrial, buildTrialRuleset, buildTrialPrompt, parseTrialReport, scanSymlinks, MAX_TRIALS_PER_WEEK, TRIAL_CEILING_MS } from "./trial.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const GOOD_REPORT = "STEP 1: VALID - npm exists\nSTEP 2: VALID - script exists\nVERDICT: PASS";

async function rig(over = {}) {
  const state = await memState();
  const root = await tmpDir("trial-");
  const clone = join(root, "clone");
  await mkdir(clone);
  state.db.prepare("INSERT INTO session_project (session_id, slug, canonical_id, directory, source, pinned_at) VALUES ('s1', 'proj-0123456789', 'x', ?, 'prompt', 1)").run(clone);
  const calls = { created: [], prompts: [], aborted: [], deleted: [], worktrees: [], removed: [], budget: [], canSpend: [], good: [], book: [] };
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
      canSpend: async (a) => (calls.canSpend.push(a), { ok: over.capOk ?? true }),
      ...(over.noGoodMoment ? {} : { goodMomentForBatch: async (a) => (calls.good.push(a), over.good === false ? { ok: false, rule: null, reason: "waiting-for-quiet" } : { ok: true, rule: "away", reason: null }) }),
      book: async (a) => calls.book.push(a),
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
    scanSymlinks: () => ({ ok: true }),
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

// ---- a faithful model of opencode 2.0.30's permission evaluation (read from the pinned binary) ----------------------
// Manta's ruleset is sent as V2 `{action, resource, effect}` (bash→shell, pattern `**`→`*`). A request is checked with
// `findLast` (last match wins) where `\` becomes `/` in pattern and text, `*` matches anything (slashes included), `?` one
// character, and a trailing " *" makes the arguments optional. NO matching rule means "ask" — a headless session would hang.
import { homedir } from "node:os";
import { posix } from "node:path";
const nb = (text, pattern) => {
  const t = String(text).replaceAll("\\", "/");
  let i = String(pattern).replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (i.endsWith(" .*")) i = `${i.slice(0, -3)}( .*)?`;
  return new RegExp(`^${i}$`, "s").test(t);
};
const toV2 = (rules) => rules.map((r) => ({ action: r.permission === "bash" ? "shell" : r.permission, resource: r.pattern === "**" ? "*" : r.pattern, effect: r.action }));
const effectOf = (v2, action, resource) => v2.findLast((r) => nb(action, r.action) && nb(resource, r.resource))?.effect ?? "ask";
/** One permission check: every resource must come out `allow` (deny OR ask fails). */
const assertAllowed = (v2, action, resources) => resources.every((res) => effectOf(v2, action, res) === "allow");

const WT = "/w/wt";
const PROJECT = "/w/main"; // the repository the worktree belongs to (opencode's project directory)
const contains = (dir, p) => p === dir || p.startsWith(`${dir}/`);
/** FileAccess.resolve: `~` expansion, resolve against the session directory, inside → relative resource, else external. */
function resolveAccess(p, { dir = WT, project = PROJECT } = {}) {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? posix.join(homedir(), p.slice(2)) : p;
  const abs = posix.resolve(dir, expanded);
  if (contains(dir, abs) || (project !== "/" && contains(project, abs))) return { abs, resource: posix.relative(dir, abs) || "." };
  return { abs, resource: abs, external: { resource: posix.join(posix.dirname(abs), "*") } };
}
/** The three tools the trial may use, with the permission checks opencode runs for them. */
const tools = (rules, opts) => {
  const v2 = toV2(rules);
  const external = (acc) => !acc.external || assertAllowed(v2, "external_directory", [acc.external.resource]);
  return {
    read: (path) => {
      const acc = resolveAccess(path, opts);
      return external(acc) && assertAllowed(v2, "read", [acc.resource]);
    },
    grep: (pattern, path = ".") => external(resolveAccess(path, opts)) && assertAllowed(v2, "grep", [pattern]),
    glob: (pattern, path = ".") => external(resolveAccess(path, opts)) && assertAllowed(v2, "glob", [pattern]),
    shell: (command, cwd = ".") => external(resolveAccess(cwd, opts)) && assertAllowed(v2, "shell", [command]),
    edit: (path) => assertAllowed(v2, "edit", [resolveAccess(path, opts).resource]),
    any: (action, resource = "x") => effectOf(v2, action, resource),
  };
};

test("ruleset: catch-all deny first, then read/grep/glob only; no shell, no edit, no allow for anything else", () => {
  const rules = buildTrialRuleset();
  assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
  assert.deepEqual([...new Set(rules.filter((r) => r.action === "allow").map((r) => r.permission))].sort(), ["glob", "grep", "read"]);
  assert.ok(!rules.some((r) => ["bash", "shell", "edit", "write", "list"].includes(r.permission)));
  assert.deepEqual(rules.at(-1), { permission: "external_directory", pattern: "*", action: "deny" });
});

test("read: nested files, the directory itself and absolute paths INSIDE the worktree are allowed (resources are relative)", () => {
  const t = tools(buildTrialRuleset());
  for (const p of ["README.md", "src/a/b/c.js", "./src/x.js", ".", "src", ".github/workflows/ci.yml", `${WT}/src/a.js`, `${WT}/package.json`, `${WT}`, "dir/sub/"]) {
    assert.equal(t.read(p), true, p);
  }
});

test("read: parent paths, absolute paths and ~ are denied (with and without the project directory around the worktree)", () => {
  for (const opts of [{}, { project: "/" }, { project: "/w" }]) {
    const t = tools(buildTrialRuleset(), opts);
    for (const p of ["../x", "../../x", "src/../../x", "a/../../../etc/passwd", `${WT}/../x`, `${WT}-evil/x`, "/etc/passwd", "/", "~", "~/.manta/auth.json", "~/.ssh/id_rsa", "/home/dev/.manta/auth.json", `${PROJECT}/src/x.js`, "/w/other/y"]) {
      assert.equal(t.read(p), false, `${p} ${JSON.stringify(opts)}`);
    }
  }
});

test("read: backslash spellings are treated like slashes (as opencode does) and still denied", () => {
  const t = tools(buildTrialRuleset());
  for (const p of ["..\\x", "src\\..\\..\\x", "\\etc\\passwd"]) assert.equal(t.read(p), false, p);
});

test("grep and glob: allowed inside the worktree, denied when the pattern or the path reaches out", () => {
  const t = tools(buildTrialRuleset());
  for (const [p, path] of [["TODO", "."], ["export function", "src"], ["foo.*bar", "."], ["scripts", `${WT}/src`]]) assert.equal(t.grep(p, path), true, `${p} in ${path}`);
  for (const [p, path] of [["**/*.js", "."], ["src/**/*.ts", "."], ["*.md", "docs"], ["package.json", "."]]) assert.equal(t.glob(p, path), true, `${p} in ${path}`);
  // the search path goes through external_directory
  for (const path of ["/etc", "/", "~", "~/.ssh", "../..", "/home/dev", `${WT}-evil`]) {
    assert.equal(t.grep("password", path), false, `grep in ${path}`);
    assert.equal(t.glob("*", path), false, `glob in ${path}`);
  }
  // the glob pattern itself can climb out of its cwd
  for (const p of ["../**", "../../etc/*", "src/../../x/*", "..", "/etc/*", "/**"]) assert.equal(t.glob(p), false, `glob ${p}`);
  assert.equal(t.grep("a/../b"), false);
});

test("shell of any kind is denied — including cd chains that escape through the shell's own cwd", () => {
  const t = tools(buildTrialRuleset());
  for (const c of ["cat README.md", "ls", "ls src", "which node", "git status", "cd && cat .manta/auth.json", "cd .. && cat x", "pushd / ; cat etc/passwd", "cd {.,}. && ls", "echo hi", "true"]) {
    assert.equal(t.shell(c), false, c);
  }
  assert.equal(t.shell("ls", "/etc"), false);
  assert.equal(t.shell("ls", "."), false);
  assert.equal(t.any("shell", "cat README.md"), "deny"); // refused outright, not left to ask
});

test("edit, write, patch and every other tool are denied — outright, never left to ask", () => {
  const rules = buildTrialRuleset();
  const t = tools(rules);
  for (const p of ["notes.txt", "src/a.js", ".git/config", ".git", ".gitdir", "../x", "/tmp/x", "~/.bashrc"]) assert.equal(t.edit(p), false, p);
  for (const action of ["edit", "write", "patch", "shell", "bash", "list", "lsp", "webfetch", "websearch", "subagent", "task", "skill", "question", "todo_write", "doom_loop", "external_directory", "mcp_anything", "unknown"]) {
    assert.equal(t.any(action, "src/a.js"), "deny", action);
    assert.equal(t.any(action, "/etc/passwd"), "deny", `${action} abs`);
  }
});

test("a session-level agent rule can't loosen it: ours come last, so the catch-all wins over e.g. external_directory allow", () => {
  const agent = [{ action: "external_directory", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }];
  const v2 = [...agent, ...toV2(buildTrialRuleset())];
  assert.equal(effectOf(v2, "external_directory", "/etc/*"), "deny");
  assert.equal(effectOf(v2, "shell", "cat x"), "deny");
  assert.equal(effectOf(v2, "edit", "x"), "deny");
  assert.equal(effectOf(v2, "read", "src/a.js"), "allow");
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
  // inspect-only: read/grep/glob, no shell, never claims to have run anything; validity = defined in the repo
  assert.match(prompt, /read, grep and glob/);
  assert.match(prompt, /no shell/);
  assert.match(prompt, /never claim to have run anything/);
  assert.match(prompt, /package\.json script, a Makefile target/);
  assert.ok(!/\bls\b|\bcat\b|which/.test(prompt.split("<skill>")[0]));
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
  assert.deepEqual(c.permission, buildTrialRuleset());
  assert.equal(tools(c.permission, { dir: c.directory }).read("/etc/passwd"), false);
  assert.equal(tools(c.permission, { dir: c.directory }).read("src/a.js"), true);
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

test("budget: the gate is asked for the trial's work type with the model it resolved, after the model; a trial is batch work that starts only at a good moment", async () => {
  const t = await rig();
  finishOnPrompt(t);
  const r = await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"], dueSince: 123 });
  assert.equal(r.status, "completed");
  assert.deepEqual(t.calls.canSpend, [{ workType: "knowledge-trial", modelClass: "knowledge-trial", model: { providerID: "p", modelID: "mid" } }]);
  assert.deepEqual(t.calls.good, [{ workType: "knowledge-trial", modelClass: "knowledge-trial", model: { providerID: "p", modelID: "mid" }, dueSince: 123 }]);

  // no model → the budget is not even asked (the model verdict comes first)
  const nm = await rig({ model: { ok: false, code: "no-qualifying-model" } });
  assert.match((await nm.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, /no-model/);
  assert.equal(nm.calls.canSpend.length, 0);

  // a budget refusal: cap-reached, and the good-moment question (which logs a start) is not asked
  const capped = await rig({ capOk: false });
  assert.equal((await capped.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, "cap-reached");
  assert.equal(capped.calls.good.length, 0);

  // not a good moment: skipped, no session, no worktree, the trial is not counted — the candidate stays pending upstream
  const quiet = await rig({ good: false });
  assert.deepEqual(await quiet.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] }), { status: "skipped", reason: "waiting-for-quiet" });
  assert.equal(quiet.calls.created.length, 0);
  assert.equal(quiet.calls.worktrees.length, 0);
  assert.equal(quiet.trial.weeklyCount(), 0);
  // a missing dueSince counts from now
  assert.equal(typeof quiet.calls.good[0].dueSince, "number");
});

test("budget: the trial's real usage is booked on the shared budget (its session is deleted, so the ledger never sees it)", async () => {
  const t = await rig();
  finishOnPrompt(t);
  await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  assert.deepEqual(t.calls.book, [{ workType: "knowledge-trial", model: { providerID: "p", modelID: "mid" }, usage: { input: 100, output: 50 }, usd: undefined, inLedger: false }]);
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

test("scanSymlinks: links that stay inside (and dangling ones) pass; a link resolving outside is found", async () => {
  const root = await tmpDir("trial-links-");
  const wt = join(root, "wt");
  const outside = join(root, "outside");
  await mkdir(join(wt, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "s");
  await writeFile(join(wt, "AGENTS.md"), "a");
  await symlink("AGENTS.md", join(wt, "CLAUDE.md")); // relative, inside
  await symlink(join(wt, "src"), join(wt, "srclink")); // absolute, inside
  await symlink("nowhere", join(wt, "dangling"));
  await mkdir(join(wt, ".git"));
  await symlink(outside, join(wt, ".git", "ignored")); // .git is skipped
  assert.deepEqual(scanSymlinks(wt), { ok: true });

  await symlink(join("..", "..", "outside", "secret.txt"), join(wt, "src", "leak.txt"));
  assert.deepEqual(scanSymlinks(wt), { ok: false, outside: join("src", "leak.txt") });

  const dir = await tmpDir("trial-links-dir-");
  await mkdir(join(dir, "wt"));
  await symlink(outside, join(dir, "wt", "dirlink"));
  assert.equal(scanSymlinks(join(dir, "wt")).outside, "dirlink");
  assert.equal(scanSymlinks(join(dir, "missing")).reason, "unreadable");
});

test("run: a worktree with a symlink pointing out is skipped ('symlink') before any session exists, and the worktree is removed", async () => {
  const t = await rig({ deps: { scanSymlinks: () => ({ ok: false, outside: "docs/leak" }) } });
  const r = await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  assert.deepEqual([r.status, r.reason], ["skipped", "symlink"]);
  assert.equal(t.calls.created.length, 0);
  assert.equal(t.calls.prompts.length, 0);
  assert.equal(t.calls.removed.length, 1);
  assert.equal(t.trial.weeklyCount(), 0);
  assert.equal(t.trial.active(), null);

  const u = await rig({ deps: { scanSymlinks: () => ({ ok: false, reason: "scan-limit" }) } });
  assert.equal((await u.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] })).reason, "symlink-scan: scan-limit");
  assert.equal(u.calls.created.length, 0);
});

test("run: the default symlink scan runs on the real worktree directory", async () => {
  const t = await rig({ deps: { scanSymlinks: undefined } });
  // the fake worktree path doesn't exist on disk, so the real scan can't read it: skipped, never run blind
  const r = await t.trial.run({ skillName: "s", skillMd: "x", slugs: ["proj-0123456789"] });
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /symlink-scan: unreadable/);
});
