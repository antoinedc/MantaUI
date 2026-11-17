// repoWriter tests: real git against a local bare "remote"; fakes for the forge, settings and scanner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRepoWriter, PR_BRANCH } from "./repoWriter.mjs";
import { renderBlock, findBlock, parseBlockRules, START_MARKER } from "./repoBlock.mjs";
import { execGitRunner, memState, tmpDir } from "./testHelpers.mjs";

const SLUG = "widgets-0123456789";
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

async function rig({ mode = "direct", files = { "README.md": "# Widgets\n" }, allowed = true, access = { ok: true, canPush: true, isFork: false, defaultBranch: "main" }, scanFlag = null, getPullRequest = null, notifyFails = 0, createFails = false } = {}) {
  const root = await tmpDir("repowriter-");
  const remote = join(root, "remote.git");
  const g = execGitRunner(root);
  await g.run(["init", "--bare", "-q", "-b", "main", remote]);
  const seed = join(root, "seed");
  await mkdir(seed);
  const sg = execGitRunner(seed);
  await sg.run(["init", "-q", "-b", "main"]);
  for (const [n, c] of Object.entries(files)) {
    if (c && typeof c === "object" && c.link) await symlink(c.link, join(seed, n));
    else await writeFile(join(seed, n), c);
  }
  await sg.run(["add", "-A"]);
  await sg.run([...ID, "commit", "-q", "-m", "init"]);
  await sg.run(["remote", "add", "origin", `file://${remote}`]);
  await sg.run(["push", "-q", "origin", "main"]);

  const dir = join(root, "store");
  await mkdir(dir);
  const state = await memState();
  const cfg = { mode, allowed, access: { ...access } };
  const calls = { create: [], update: [], find: [], notify: [], notifyFailed: 0, repoAccess: 0 };
  const prs = []; // fake forge state
  const forge = {
    repoAccess: async () => {
      calls.repoAccess++;
      return cfg.access;
    },
    findOpenPullRequest: async (_t, head) => {
      calls.find.push(head);
      return { ok: true, pr: prs.find((p) => p.headRef === head && p.state === "open") ?? null };
    },
    createPullRequest: async (_t, input) => {
      calls.create.push(input);
      if (createFails) return { ok: false, error: "rejected", message: "GitHub refused the pull request." };
      const pr = { number: prs.length + 1, url: `https://github.com/acme/widgets/pull/${prs.length + 1}`, headRef: input.head, state: "open", body: input.body };
      prs.push(pr);
      return { ok: true, pr };
    },
    updatePullRequest: async (_t, input) => {
      calls.update.push(input);
      const pr = prs.find((p) => p.number === input.number);
      pr.body = input.body ?? pr.body;
      return { ok: true, pr };
    },
    ...(getPullRequest === "fail"
      ? { getPullRequest: async () => ({ ok: false, error: "network", message: "offline" }) }
      : getPullRequest
        ? { getPullRequest: async (_t, n) => ({ ok: true, pr: prs.find((p) => p.number === n) }) }
        : {}),
  };
  const baseGit = execGitRunner(dir);
  const hooks = { beforePush: null };
  const gitRunner = {
    run: async (args, o) => {
      if (hooks.beforePush && args.includes("push")) {
        const fn = hooks.beforePush;
        hooks.beforePush = null;
        await fn();
      }
      return baseGit.run(args, o);
    },
  };
  const writer = createRepoWriter({
    dir,
    git: gitRunner,
    recentDirectories: () => cfg.dirs ?? [],
    registry: { get: async (slug) => (slug === SLUG ? { slug, canonicalId: "github.com/acme/widgets", displayName: "widgets" } : null) },
    settings: {
      effectiveRepoRules: async () => (cfg.allowed || cfg.mode === "box-only" ? { repoRules: cfg.mode, reason: null } : { repoRules: "box-only", reason: "You can't push to this repository." }),
      outward: async () => (cfg.allowed ? { allowed: true, defaultBranch: "main" } : { allowed: false, reason: "You can't push to this repository." }),
    },
    state,
    scanner: { scan: async (t) => (scanFlag && String(t).includes(scanFlag) ? { clean: false, unavailable: false, hits: [{}] } : { clean: true, unavailable: false, hits: [] }) },
    forge,
    fireNotify: async (n) => {
      if (calls.notify.length + calls.notifyFailed < notifyFails) {
        calls.notifyFailed++;
        throw new Error("push gateway down");
      }
      calls.notify.push(n);
    },
    remoteUrlFor: () => `file://${remote}`,
    log: () => {},
  });
  // helpers on the "remote"
  const clone = join(root, "peer");
  const peer = async () => {
    if (!(await stat(join(clone, ".git")).catch(() => null))) await g.run(["clone", "-q", `file://${remote}`, clone]);
    const pg = execGitRunner(clone);
    await pg.run(["fetch", "-q", "--prune", "origin"]);
    return pg;
  };
  const remoteFile = async (ref = "main", path = "AGENTS.md") => {
    try {
      return await g.run(["--git-dir", remote, "show", `${ref}:${path}`]);
    } catch {
      return null;
    }
  };
  const remoteHas = async (ref) => {
    try {
      await g.run(["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  };
  const remoteLog = async (ref = "main") => (await g.run(["--git-dir", remote, "log", "--format=%s", ref])).trim().split("\n");
  return { root, remote, dir, state, cfg, calls, prs, writer, g, peer, clone, remoteFile, remoteHas, remoteLog, hooks, slug: SLUG };
}

const rules = (...r) => r;

test("box-only never touches the repository or even clones it", async () => {
  const t = await rig({ mode: "box-only" });
  const r = await t.writer.applyRules(SLUG, rules("Use pnpm"));
  assert.deepEqual({ ok: r.ok, mode: r.mode }, { ok: true, mode: "box-only" });
  assert.equal(await stat(join(t.dir, ".repos")).catch(() => null), null);
  assert.equal(await t.remoteFile(), null);
});

test("direct: writes the managed block, appends to an existing AGENTS.md, leaves the rest alone, pushes HEAD:default", async () => {
  const t = await rig({ files: { "README.md": "x", "AGENTS.md": "# Agents\n\nBe nice.\n" } });
  const r = await t.writer.applyRules(SLUG, rules("Use pnpm — lockfile is pnpm", "Run lint before commit"));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "direct");
  assert.equal(r.changed, true);
  const text = await t.remoteFile();
  assert.ok(text.startsWith("# Agents\n\nBe nice.\n"));
  assert.deepEqual(parseBlockRules(findBlock(text).text), ["Use pnpm — lockfile is pnpm", "Run lint before commit"]);
  assert.match((await t.remoteLog())[0], /Update Manta knowledge rules/);
  // the clone is an independent repo, not a worktree of anything
  const dotGit = await stat(join(t.dir, ".repos", SLUG, ".git"));
  assert.ok(dotGit.isDirectory());
  assert.equal((await t.g.run(["-C", join(t.dir, ".repos", SLUG), "worktree", "list"])).trim().split("\n").length, 1);
});

test("direct: creates AGENTS.md when missing; identical rules are a no-op; a changed rule set edits the block in place", async () => {
  const t = await rig();
  const a = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(a.changed, true);
  assert.ok((await t.remoteFile()).startsWith(START_MARKER));
  const before = (await t.remoteLog()).length;
  const same = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal((await t.remoteLog()).length, before);
  await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A", "B"]);
  assert.equal((await t.remoteLog()).length, before + 1);
  // no rules at all removes the block
  // no rules at all removes the block — and the AGENTS.md the curator created, since nothing else is in it
  await t.writer.applyRules(SLUG, []);
  assert.equal(await t.remoteFile(), null);
  assert.equal((await t.remoteLog())[0].match(/Update Manta/) !== null, true);
});

test("repo-facing text carries no refs, ids or quotes (commit and file)", async () => {
  const t = await rig();
  await t.writer.applyRules(SLUG, rules("Use pnpm (msg:ses_0123456789abcdef/msg_0123456789abcdef) because ses_0123456789abcdef said so", "> quoted line"));
  const text = await t.remoteFile();
  assert.ok(!/msg:|ses_|msg_|^>/m.test(text), text);
  const log = (await t.g.run(["--git-dir", t.remote, "log", "--format=%B", "main"])).toString();
  assert.ok(!/msg:|ses_|msg_/.test(log));
});

test("a secret in a rule drops the write and reports it; nothing is pushed", async () => {
  const t = await rig({ scanFlag: "AKIAFAKESECRET" });
  const r = await t.writer.applyRules(SLUG, rules("Deploy with AKIAFAKESECRET1234"));
  assert.equal(r.ok, false);
  assert.match(r.error, /secret/);
  assert.equal(await t.remoteFile(), null);
});

test("a symlinked AGENTS.md is skipped and reported", async () => {
  const t = await rig({ files: { "CLAUDE.md": "# c\n", "AGENTS.md": { link: "CLAUDE.md" } } });
  const r = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(r.ok, false);
  assert.match(r.error, /symlink/);
  assert.equal((await t.remoteLog()).length, 1);
});

test("a damaged block (start marker only) is left alone and reported", async () => {
  const t = await rig({ files: { "AGENTS.md": `# a\n${START_MARKER}\nhalf\n` } });
  const r = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(r.ok, false);
  assert.match(r.error, /damaged/);
});

test("the first outward action notifies at once, later ones don't", async () => {
  const t = await rig();
  await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(t.calls.notify.length, 1);
  assert.match(t.calls.notify[0].message, /acme\/widgets/);
  await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(t.calls.notify.length, 1);
});

test("outward conditions re-checked at write time: lost push access behaves as box-only", async () => {
  const t = await rig();
  await t.writer.applyRules(SLUG, rules("A"));
  t.cfg.access = { ok: true, canPush: false, isFork: false, defaultBranch: "main" };
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.mode, "box-only");
  assert.match(r.reason, /can't push/);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A"]);
  t.cfg.access = { ok: true, canPush: true, isFork: true, defaultBranch: "main" };
  assert.match((await t.writer.applyRules(SLUG, rules("C"))).reason, /fork/);
  t.cfg.access = { ok: false, message: "not connected" };
  assert.equal((await t.writer.applyRules(SLUG, rules("C"))).mode, "box-only");
  t.cfg.allowed = false;
  assert.equal((await t.writer.applyRules(SLUG, rules("C"))).mode, "box-only");
});

async function rejectPush(t, refPattern) {
  const hook = join(t.remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref" in ${refPattern}) echo "protected" >&2; exit 1;; esac; done\nexit 0\n`);
  await chmod(hook, 0o755);
}

test("direct: a rejected push falls back to a pull request for that change (fellBackTo)", async () => {
  const t = await rig();
  await rejectPush(t, "refs/heads/main");
  const r = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(r.ok, true);
  assert.equal(r.mode, "pull-request");
  assert.equal(r.fellBackTo, "pull-request");
  assert.equal(r.pr.number, 1);
  assert.equal(await t.remoteFile(), null);
  assert.ok(await t.remoteFile(PR_BRANCH));
  assert.equal(t.calls.create.length, 1);
  assert.equal(t.calls.create[0].base, "main");
  assert.equal(t.calls.create[0].head, PR_BRANCH);
});

test("pull-request: branch pushed, PR created ONCE, later changes stack on the same branch and refresh the body", async () => {
  const t = await rig({ mode: "pull-request" });
  const a = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(a.mode, "pull-request");
  assert.equal(a.pr.number, 1);
  assert.equal(await t.remoteFile("main"), null);
  const b = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(b.ok, true);
  assert.equal(b.pr.number, 1);
  assert.equal(t.calls.create.length, 1);
  assert.equal(t.calls.update.length, 1);
  assert.match(t.prs[0].body, /- B/);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile(PR_BRANCH)).text), ["A", "B"]);
  assert.equal((await t.remoteLog(PR_BRANCH)).filter((s) => /Update Manta/.test(s)).length, 2);
  // unchanged rules: no new commit, the PR is still ensured but not re-created
  const same = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(same.changed, false);
  assert.equal(t.calls.create.length, 1);
  assert.ok(!/msg:|ses_/.test(t.prs[0].body));
});

test("pull-request: a rejected branch push behaves as box-only, reported and shown in status", async () => {
  const t = await rig({ mode: "pull-request" });
  await rejectPush(t, `refs/heads/${PR_BRANCH}`);
  const r = await t.writer.applyRules(SLUG, rules("A"));
  assert.equal(r.ok, false);
  assert.equal(r.mode, "box-only");
  assert.match(r.error, /rejected/);
  assert.match(t.writer.status(SLUG).blocked, /rejected/);
  assert.equal(t.calls.create.length, 0);
});

test("hand edit: detected against both baselines, refused by applyRules until sync adopts it", async () => {
  const t = await rig();
  await t.writer.applyRules(SLUG, rules("A"));
  assert.deepEqual(await t.writer.sync(SLUG), { handEdit: null, prState: "none" });

  const pg = await t.peer();
  await pg.run(["checkout", "-q", "-B", "main", "origin/main"]);
  const file = join(t.clone, "AGENTS.md");
  await writeFile(file, (await readFile(file, "utf8")).replace("- A", "- A, but hand edited"));
  await pg.run(["add", "-A"]);
  await pg.run([...ID, "commit", "-q", "-m", "hand edit"]);
  await pg.run(["push", "-q", "origin", "main"]);

  const refused = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(refused.ok, false);
  assert.match(refused.handEdit, /hand edited/);
  assert.ok(t.writer.status(SLUG).pendingHandEdit);

  const s = await t.writer.sync(SLUG);
  assert.match(s.handEdit, /hand edited/);
  assert.equal(s.prState, "none");
  // reported once; baseline moved, so the curator can now write on top of the adopted text
  assert.equal((await t.writer.sync(SLUG)).handEdit, null);
  const r = await t.writer.applyRules(SLUG, rules("A, but hand edited", "B"));
  assert.equal(r.ok, true);
});

test("hand edit: removing the block is a hand edit with empty text; an unknown pre-existing block is adopted first", async () => {
  const t = await rig({ files: { "AGENTS.md": `# a\n\n${renderBlock(["Somebody's own rule"]).block}\n` } });
  const first = await t.writer.applyRules(SLUG, rules("Mine"));
  assert.equal(first.ok, false);
  assert.match(first.handEdit, /Somebody's own rule/);
  assert.match((await t.writer.sync(SLUG)).handEdit, /Somebody's own rule/);
  assert.equal((await t.writer.applyRules(SLUG, rules("Somebody's own rule", "Mine"))).ok, true);

  const pg = await t.peer();
  await pg.run(["checkout", "-q", "-B", "main", "origin/main"]);
  await writeFile(join(t.clone, "AGENTS.md"), "# a\n");
  await pg.run(["add", "-A"]);
  await pg.run([...ID, "commit", "-q", "-m", "drop block"]);
  await pg.run(["push", "-q", "origin", "main"]);
  assert.equal((await t.writer.sync(SLUG)).handEdit, "");
});

async function mergePrBranch(t, { squash = false, edit = null } = {}) {
  const pg = await t.peer();
  await pg.run(["checkout", "-q", "-B", "main", "origin/main"]);
  if (squash) {
    await pg.run(["merge", "--squash", `origin/${PR_BRANCH}`]);
    if (edit) {
      const file = join(t.clone, "AGENTS.md");
      await writeFile(file, (await readFile(file, "utf8")).replace(edit[0], edit[1]));
      await pg.run(["add", "-A"]);
    }
    await pg.run([...ID, "commit", "-q", "-m", "squash merge"]);
  } else await pg.run([...ID, "merge", "-q", "--no-ff", "-m", "Merge PR", `origin/${PR_BRANCH}`]);
  await pg.run(["push", "-q", "origin", "main"]);
  t.prs.at(-1).state = "merged";
}

test("PR lifecycle: open → merged (merge commit)", async () => {
  const t = await rig({ mode: "pull-request" });
  await t.writer.applyRules(SLUG, rules("A"));
  assert.equal((await t.writer.sync(SLUG)).prState, "open");
  await mergePrBranch(t);
  t.prs[0].state = "closed"; // the fake forge lists open PRs only
  const s = await t.writer.sync(SLUG);
  assert.equal(s.prState, "merged");
  assert.equal(s.mergedText, undefined);
  assert.equal((await t.writer.sync(SLUG)).prState, "none");
});

test("PR lifecycle: squash-merged with edits → merged-edited carrying the merged text", async () => {
  const t = await rig({ mode: "pull-request" });
  await t.writer.applyRules(SLUG, rules("Use pnpm"));
  await mergePrBranch(t, { squash: true, edit: ["Use pnpm", "Use pnpm always"] });
  t.prs[0].state = "closed";
  const s = await t.writer.sync(SLUG);
  assert.equal(s.prState, "merged-edited");
  assert.match(s.mergedText, /Use pnpm always/);
  // adopted: not reported again as a hand edit
  assert.equal((await t.writer.sync(SLUG)).handEdit, null);
});

test("PR lifecycle: closed unmerged; with the forge's own merged flag too", async () => {
  const t = await rig({ mode: "pull-request", getPullRequest: true });
  await t.writer.applyRules(SLUG, rules("A"));
  t.prs[0].state = "closed";
  const s = await t.writer.sync(SLUG);
  assert.equal(s.prState, "closed");
  assert.equal(s.handEdit, null);
  assert.equal(t.writer.status(SLUG).pr, null);

  const u = await rig({ mode: "pull-request", getPullRequest: true });
  await u.writer.applyRules(SLUG, rules("A"));
  await mergePrBranch(u, { squash: true });
  const m = await u.writer.sync(SLUG);
  assert.equal(m.prState, "merged");
});

test("PR lifecycle: branch deleted while the PR is open → recreated on the next change", async () => {
  const t = await rig({ mode: "pull-request" });
  await t.writer.applyRules(SLUG, rules("A"));
  await t.g.run(["--git-dir", t.remote, "branch", "-D", PR_BRANCH]);
  assert.equal((await t.writer.sync(SLUG)).prState, "branch-deleted");
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, true);
  assert.ok(await t.remoteHas(PR_BRANCH));
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile(PR_BRANCH)).text), ["A", "B"]);
  assert.equal(t.calls.create.length, 1); // the PR is still the same open one
});

test("pull-request: when the default branch changed the block, the branch is rebuilt rather than conflicting", async () => {
  const t = await rig({ mode: "pull-request", files: { "README.md": "x", "AGENTS.md": "# a\n" } });
  await t.writer.applyRules(SLUG, rules("A"));
  const pg = await t.peer();
  await pg.run(["checkout", "-q", "-B", "main", "origin/main"]);
  await writeFile(join(t.clone, "AGENTS.md"), `# a\n\n${renderBlock(["Somebody else"]).block}\n`);
  await pg.run(["add", "-A"]);
  await pg.run([...ID, "commit", "-q", "-m", "someone added a block"]);
  await pg.run(["push", "-q", "origin", "main"]);
  await t.writer.sync(SLUG); // adopt
  const r = await t.writer.applyRules(SLUG, rules("Somebody else", "A"));
  assert.equal(r.ok, true);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile(PR_BRANCH)).text), ["Somebody else", "A"]);
});

test("revert (direct): a revert commit is pushed; a later conflicting commit fails naming it", async () => {
  const t = await rig();
  const a = await t.writer.applyRules(SLUG, rules("A"));
  const b = await t.writer.applyRules(SLUG, rules("A", "B"));
  // reverting B is clean
  const ok = await t.writer.revert({ slug: SLUG, data: { sha: b.sha } });
  assert.equal(ok.ok, true);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A"]);
  assert.match((await t.remoteLog())[0], /Revert Manta knowledge rules update/);
  assert.equal((await t.writer.revert({ slug: SLUG, data: { sha: b.sha } })).ok, false); // already reverted

  // reverting A now clashes with nothing (block removed cleanly)...
  const c = await t.writer.applyRules(SLUG, rules("A", "C"));
  const d = await t.writer.applyRules(SLUG, rules("A", "C", "D"));
  // ...but reverting C after D touched the same region conflicts
  const bad = await t.writer.revert({ slug: SLUG, data: { sha: c.sha } });
  assert.equal(bad.ok, false);
  assert.ok(bad.conflictWith?.subject);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A", "C", "D"]);
  assert.ok(a.sha && d.sha);
});

test("revert (unmerged PR): the change is taken out of the PR branch and the body refreshed", async () => {
  const t = await rig({ mode: "pull-request" });
  const a = await t.writer.applyRules(SLUG, rules("A"));
  const b = await t.writer.applyRules(SLUG, rules("A", "B"));
  const r = await t.writer.revert({ slug: SLUG, data: { sha: b.sha } });
  assert.equal(r.ok, true);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile(PR_BRANCH)).text), ["A"]);
  assert.match(t.prs[0].body, /- A/);
  assert.ok(!/- B/.test(t.prs[0].body));
  assert.equal(t.calls.create.length, 1);
  assert.ok(a.sha);
});

test("revert (merged PR, merge commit and squash): a revert PR is opened", async () => {
  const t = await rig({ mode: "pull-request" });
  const a = await t.writer.applyRules(SLUG, rules("A"));
  await mergePrBranch(t);
  t.prs[0].state = "closed";
  await t.writer.sync(SLUG);
  const r = await t.writer.revert({ slug: SLUG, data: { sha: a.sha } });
  assert.equal(r.ok, true);
  assert.equal(r.pr.number, 2);
  assert.match(t.calls.create[1].title, /Revert/);
  assert.match(t.calls.create[1].head, /revert/);
  assert.equal(findBlock(await t.remoteFile(t.calls.create[1].head)).status, "none");
  assert.ok(await t.remoteFile("main")); // main untouched

  const u = await rig({ mode: "pull-request" });
  const x = await u.writer.applyRules(SLUG, rules("A"));
  await mergePrBranch(u, { squash: true });
  u.prs[0].state = "closed";
  await u.writer.sync(SLUG);
  await u.g.run(["--git-dir", u.remote, "branch", "-D", PR_BRANCH]).catch(() => {});
  const sq = await u.writer.revert({ slug: SLUG, data: { sha: x.sha } });
  assert.equal(sq.ok, true);
  assert.equal(findBlock(await u.remoteFile(u.calls.create[1].head)).status, "none");
});

test("revert: unknown change and a change whose PR never merged", async () => {
  const t = await rig({ mode: "pull-request" });
  assert.equal((await t.writer.revert({ slug: SLUG, data: { sha: "deadbeef" } })).ok, false);
  assert.equal((await t.writer.revert({ slug: SLUG })).ok, false);
});

test("applyRules serialises per project: concurrent calls don't corrupt each other", async () => {
  const t = await rig();
  const rs = await Promise.all([t.writer.applyRules(SLUG, rules("A")), t.writer.applyRules(SLUG, rules("A", "B")), t.writer.applyRules(SLUG, rules("A", "B", "C"))]);
  assert.ok(rs.every((r) => r.ok));
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A", "B", "C"]);
});

test("a project without a GitHub/GitLab remote is box-only", async () => {
  const t = await rig();
  const w = createRepoWriter({
    dir: t.dir,
    git: execGitRunner(t.dir),
    registry: { get: async () => ({ slug: SLUG, canonicalId: "path:/home/x/y", displayName: "y" }) },
    settings: { effectiveRepoRules: async () => ({ repoRules: "direct", reason: null }), outward: async () => ({ allowed: true }) },
    state: t.state,
    scanner: { scan: async () => ({ clean: true }) },
    forge: {},
    log: () => {},
  });
  assert.equal((await w.applyRules(SLUG, rules("A"))).mode, "box-only");
  assert.deepEqual(await w.sync(SLUG), { handEdit: null, prState: "none" });
});

// ---- fix round F1 ----------------------------------------------------------------------------------

const peerCommit = async (t, branch, file, edit, msg = "person edit") => {
  const pg = await t.peer();
  await pg.run(["checkout", "-q", "-B", branch, `origin/${branch}`]);
  const p = join(t.clone, file);
  const cur = await readFile(p, "utf8").catch(() => "");
  await writeFile(p, edit(cur));
  await pg.run(["add", "-A"]);
  await pg.run([...ID, "commit", "-q", "-m", msg]);
  await pg.run(["push", "-q", "origin", branch]);
};

test("R2-B2: a hand edit that lands while a direct push is in flight is never overwritten", async () => {
  const t = await rig();
  await t.writer.applyRules(SLUG, rules("A"));
  t.hooks.beforePush = () => peerCommit(t, "main", "AGENTS.md", (c) => c.replace("- A", "- A, hand edited in flight"), "hand edit");
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, false);
  assert.match(r.error, /person edited/);
  assert.match(r.handEdit, /hand edited in flight/);
  assert.match(await t.remoteFile(), /hand edited in flight/);
  assert.ok(!/- B/.test(await t.remoteFile()));
  assert.ok(t.writer.status(SLUG).pendingHandEdit);
  assert.match((await t.writer.sync(SLUG)).handEdit, /hand edited in flight/);
  // adopted, so the curator can write on top of it
  assert.equal((await t.writer.applyRules(SLUG, rules("A, hand edited in flight", "B"))).ok, true);
});

test("R2-B2: an unrelated push in flight is just re-applied on top (no false hand edit)", async () => {
  const t = await rig({ files: { "README.md": "x", "AGENTS.md": "# a\n" } });
  await t.writer.applyRules(SLUG, rules("A"));
  t.hooks.beforePush = () => peerCommit(t, "main", "README.md", () => "changed\n", "docs");
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, true);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile()).text), ["A", "B"]);
  assert.equal(await t.remoteFile("main", "README.md"), "changed\n");
});

test("R2-S1: a reviewer's edit on the PR branch is adopted, not overwritten or force-pushed over", async () => {
  const t = await rig({ mode: "pull-request" });
  await t.writer.applyRules(SLUG, rules("A"));
  await peerCommit(t, PR_BRANCH, "AGENTS.md", (c) => c.replace("- A", "- A, reviewer reworded"), "review fix");
  const tip = (await t.g.run(["--git-dir", t.remote, "rev-parse", PR_BRANCH])).trim();
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, false);
  assert.match(r.error, /reviewer edited/);
  assert.match(r.handEdit, /reviewer reworded/);
  assert.equal((await t.g.run(["--git-dir", t.remote, "rev-parse", PR_BRANCH])).trim(), tip);
  const s = await t.writer.sync(SLUG);
  assert.equal(s.prState, "open");
  assert.match(s.handEdit, /reviewer reworded/);
  assert.equal((await t.writer.sync(SLUG)).handEdit, null); // reported once
  const ok = await t.writer.applyRules(SLUG, rules("A, reviewer reworded", "B"));
  assert.equal(ok.ok, true);
  assert.deepEqual(parseBlockRules(findBlock(await t.remoteFile(PR_BRANCH)).text), ["A, reviewer reworded", "B"]);
  assert.ok((await t.remoteLog(PR_BRANCH)).includes("review fix"), "the reviewer's commit is still in the history");
});

async function conflictingDefault(t) {
  await peerCommit(t, "main", "AGENTS.md", () => "# b\n", "retitle");
}

test("R2-S1: a PR branch with a person's commits that no longer merges is left alone (no force push)", async () => {
  const t = await rig({ mode: "pull-request", files: { "README.md": "x", "AGENTS.md": "# a\n" } });
  await t.writer.applyRules(SLUG, rules("A"));
  await peerCommit(t, PR_BRANCH, "README.md", () => "reviewer note\n", "reviewer commit");
  await conflictingDefault(t);
  const tip = (await t.g.run(["--git-dir", t.remote, "rev-parse", PR_BRANCH])).trim();
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, false);
  assert.match(r.error, /commits from people/);
  assert.equal((await t.g.run(["--git-dir", t.remote, "rev-parse", PR_BRANCH])).trim(), tip);
});

test("R2-S1: a branch made only of Manta's commits is rebuilt from the new default (force-with-lease)", async () => {
  const t = await rig({ mode: "pull-request", files: { "README.md": "x", "AGENTS.md": "# a\n" } });
  await t.writer.applyRules(SLUG, rules("A"));
  await conflictingDefault(t);
  const r = await t.writer.applyRules(SLUG, rules("A", "B"));
  assert.equal(r.ok, true);
  const text = await t.remoteFile(PR_BRANCH);
  assert.ok(text.startsWith("# b\n"));
  assert.deepEqual(parseBlockRules(findBlock(text).text), ["A", "B"]);
});

test("R2-S5: the forge's own answer wins — closed PR plus an overlapping hand edit on the default branch is `closed`", async () => {
  const t = await rig({ mode: "pull-request", getPullRequest: true });
  await t.writer.applyRules(SLUG, rules("Use pnpm"));
  await peerCommit(t, "main", "AGENTS.md", () => `# a\n\n${renderBlock(["Use pnpm always, said a person"]).block}\n`, "hand edit overlapping the PR");
  t.prs[0].state = "closed";
  const s = await t.writer.sync(SLUG);
  assert.equal(s.prState, "closed");
  assert.match(s.handEdit, /Use pnpm always/);
  assert.equal(s.mergedText, undefined);
});

test("R2-S5: when the forge call fails the git-based inference is only a fallback", async () => {
  const t = await rig({ mode: "pull-request", getPullRequest: "fail" });
  await t.writer.applyRules(SLUG, rules("Use pnpm"));
  assert.equal((await t.writer.sync(SLUG)).prState, "open"); // fallback: the PR is still listed as open
  await mergePrBranch(t, { squash: true, edit: ["Use pnpm", "Use pnpm always"] });
  t.prs[0].state = "closed";
  assert.equal((await t.writer.sync(SLUG)).prState, "merged-edited");
});

test("R2-S6: clones from the origin of the project's most recent clone (ssh stays ssh); other repos and failures fall back to https", async () => {
  const calls = [];
  const store = await tmpDir("repowriter-store-");
  const mk = (originOf) =>
    createRepoWriter({
      dir: store,
      git: {
        run: async (args, o) => {
          calls.push({ args, cwd: o?.cwd });
          if (args[0] === "remote") {
            const u = originOf[o.cwd];
            if (!u) throw new Error("not a git repository");
            return `${u}\n`;
          }
          throw new Error("stop after clone");
        },
      },
      recentDirectories: () => ["/home/dev/gone", "/home/dev/other", "/home/dev/widgets"],
      registry: { get: async () => ({ slug: SLUG, canonicalId: "github.com/acme/widgets", displayName: "widgets" }) },
      settings: { effectiveRepoRules: async () => ({ repoRules: "direct", reason: null }), outward: async () => ({ allowed: true, defaultBranch: "main" }) },
      state: { kvGet: () => null, kvSet() {}, kvDelete() {} },
      scanner: { scan: async () => ({ clean: true }) },
      forge: {},
      log: () => {},
    });
  await mk({ "/home/dev/other": "git@github.com:someone/else.git", "/home/dev/widgets": "git@github.com:acme/widgets.git" }).applyRules(SLUG, rules("A"));
  const clone = calls.find((c) => c.args[0] === "clone");
  assert.deepEqual(clone.args.slice(0, 4), ["clone", "--filter=blob:none", "--quiet", "--"]);
  assert.equal(clone.args[4], "git@github.com:acme/widgets.git"); // the other repo's clone was skipped, the missing dir too

  calls.length = 0;
  await mk({}).applyRules(SLUG, rules("A"));
  assert.equal(calls.find((c) => c.args[0] === "clone").args[4], "https://github.com/acme/widgets.git");
});

test("nit: the first-outward notification is recorded only after it was sent; a failed PR creation is worded as such", async () => {
  const t = await rig({ notifyFails: 1 });
  await t.writer.applyRules(SLUG, rules("A")); // notification fails, the write still succeeds
  assert.equal(t.calls.notify.length, 0);
  await t.writer.applyRules(SLUG, rules("A", "B")); // tried again, now sent
  assert.equal(t.calls.notify.length, 1);
  await t.writer.applyRules(SLUG, rules("A", "B", "C"));
  assert.equal(t.calls.notify.length, 1);

  const u = await rig({ mode: "pull-request", createFails: true });
  const r = await u.writer.applyRules(SLUG, rules("A"));
  assert.equal(r.ok, false);
  assert.match(r.error, /Pushed manta\/knowledge, but/);
  assert.match(u.calls.notify[0].message, /pushed the manta\/knowledge branch/);
  assert.match(u.calls.notify[0].message, /couldn't be opened/);
});

test("nit: removing the block keeps an AGENTS.md that holds anything else", async () => {
  const t = await rig({ files: { "README.md": "x", "AGENTS.md": "# Agents\n\nBe nice.\n" } });
  await t.writer.applyRules(SLUG, rules("A"));
  await t.writer.applyRules(SLUG, []);
  assert.equal(await t.remoteFile(), "# Agents\n\nBe nice.\n");
});
