import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { BOX_ID, SLUG_RE, createIdentityResolver, createProjectRegistry, emptyRegistry, normalizeRemote, parseMainWorktree, pickRemoteName, slugFor, slugName } from "./identity.mjs";
import { execGitRunner, makeRepo, tmpDir } from "./testHelpers.mjs";

const git = execGitRunner();
const resolver = () => createIdentityResolver({ git, cacheMs: 0 });

test("normalizeRemote: ssh and https forms of a forge repo agree; credentials and .git are stripped", () => {
  const a = normalizeRemote("git@github.com:Acme/Widget.git");
  const b = normalizeRemote("https://user:tok@github.com/acme/widget");
  assert.equal(a.id, "github.com/acme/widget");
  assert.equal(b.id, a.id);
  assert.equal(a.name, "widget");
});

test("normalizeRemote: another host → host/path, host lowercased, scheme/credentials/.git stripped, path case kept", () => {
  assert.equal(normalizeRemote("ssh://git@Git.Example.COM:2222/Team/Repo.git").id, "git.example.com/Team/Repo");
  assert.equal(normalizeRemote("https://tok@git.example.com/Team/Repo/").id, "git.example.com/Team/Repo");
  assert.equal(normalizeRemote("git@git.example.com:team/repo.git").id, "git.example.com/team/repo");
  assert.equal(normalizeRemote("/srv/git/repo.git"), null);
  assert.equal(normalizeRemote("file:///srv/git/repo.git"), null);
  assert.equal(normalizeRemote(""), null);
  assert.equal(normalizeRemote(undefined), null);
});

test("pickRemoteName: origin, else the alphabetically first", () => {
  assert.equal(pickRemoteName(["upstream", "origin"]), "origin");
  assert.equal(pickRemoteName(["zeta", "alpha"]), "alpha");
  assert.equal(pickRemoteName([]), null);
});

test("parseMainWorktree takes the first worktree entry", () => {
  assert.equal(parseMainWorktree("worktree /a/main\nHEAD x\n\nworktree /a/wt\nHEAD y\n"), "/a/main");
});

test("slug shape: <name>-<10 hex>, name cut to 40, no dots, matches the pinned regex", () => {
  const s = slugFor("github.com/acme/widget", "Widget.Core_v2");
  assert.match(s, SLUG_RE);
  assert.match(s, /^widget-core-v2-[0-9a-f]{10}$/);
  const long = slugFor("x", "a".repeat(100));
  assert.equal(long.length, 40 + 1 + 10);
  assert.match(long, SLUG_RE);
  assert.match(slugFor("x", "!!!"), /^project-[0-9a-f]{10}$/);
  assert.equal(slugName("  -Hello World- "), "hello-world");
});

test("slug collisions: same repo name under different owners get different slugs", () => {
  assert.notEqual(slugFor("github.com/a/tool", "tool"), slugFor("github.com/b/tool", "tool"));
});

test("resolve: remote repo → remote id; worktrees share the id; the main worktree is the root", async () => {
  const root = await makeRepo({ remote: "git@github.com:acme/widget.git" });
  const wt = join(await tmpDir("knowledge-wt-"), "wt");
  await git.run(["worktree", "add", "-q", wt, "-b", "feature"], { cwd: root });
  const r = resolver();
  const a = await r.resolve(root);
  const b = await r.resolve(wt);
  assert.equal(a.canonicalId, "github.com/acme/widget");
  assert.equal(b.canonicalId, a.canonicalId);
  assert.equal(b.repoRoot, await realpath(root));
  assert.equal(a.kind, "remote");
});

test("resolve: no remote → path:<realpath of the main worktree>; origin beats other remotes; first alpha otherwise", async () => {
  const noRemote = await makeRepo();
  const r = resolver();
  const x = await r.resolve(noRemote);
  assert.equal(x.canonicalId, `path:${await realpath(noRemote)}`);
  assert.equal(x.kind, "path");
  const two = await makeRepo({ remotes: { upstream: "https://github.com/o/up.git", origin: "https://github.com/o/mine.git" } });
  assert.equal((await r.resolve(two)).canonicalId, "github.com/o/mine");
  const alpha = await makeRepo({ remotes: { zeta: "https://github.com/o/z.git", beta: "https://github.com/o/b.git" } });
  assert.equal((await r.resolve(alpha)).canonicalId, "github.com/o/b");
});

test("resolve: a directory outside any repo is the `box` pseudo-project; a missing directory is null", async () => {
  const plain = await tmpDir("knowledge-plain-");
  const r = resolver();
  const x = await r.resolve(plain);
  assert.equal(x.canonicalId, BOX_ID);
  assert.equal(x.kind, "box");
  assert.equal(await r.resolve(join(plain, "nope")), null);
  assert.equal(await r.resolve(""), null);
});

function registry(saved = []) {
  let doc = emptyRegistry();
  return createProjectRegistry({
    resolver: resolver(),
    load: async () => doc,
    save: async (d, message) => {
      doc = JSON.parse(JSON.stringify(d));
      saved.push(message);
    },
  });
}

test("registry: registers once, shares the slug across worktrees, persists with a message", async () => {
  const saved = [];
  const reg = registry(saved);
  const root = await makeRepo({ remote: "https://github.com/acme/widget.git" });
  const wt = join(await tmpDir("knowledge-wt2-"), "wt");
  await git.run(["worktree", "add", "-q", wt, "-b", "f"], { cwd: root });
  const a = await reg.identify(root);
  assert.equal(a.created, true);
  assert.match(a.slug, SLUG_RE);
  assert.equal(a.displayName, "widget");
  const b = await reg.identify(wt);
  assert.equal(b.slug, a.slug);
  assert.equal(b.created, false);
  assert.match(saved[0], /Register project/);
  assert.equal((await reg.list()).length, 1);
});

test("registry: a remote added later keeps the slug and records the path id as an alias", async () => {
  const reg = registry();
  const root = await makeRepo();
  const first = await reg.identify(root);
  assert.match((await reg.get(first.slug)).canonicalId, /^path:/);
  const oldId = (await reg.get(first.slug)).canonicalId;
  await git.run(["remote", "add", "origin", "git@github.com:acme/later.git"], { cwd: root });
  const second = await reg.identify(root);
  assert.equal(second.slug, first.slug);
  assert.equal(second.canonicalId, "github.com/acme/later");
  const p = await reg.get(first.slug);
  assert.deepEqual(p.aliases, [oldId]);
  assert.equal((await reg.findById(oldId)).slug, first.slug);
  assert.equal((await reg.list()).length, 1);
});

test("registry: a renamed remote at the same path finds the existing project; the old id becomes an alias", async () => {
  const reg = registry();
  const root = await makeRepo({ remote: "https://github.com/acme/old-name.git" });
  const first = await reg.identify(root);
  await git.run(["remote", "set-url", "origin", "https://github.com/acme/new-name.git"], { cwd: root });
  const second = await reg.identify(root);
  assert.equal(second.slug, first.slug);
  assert.deepEqual((await reg.get(first.slug)).aliases, ["github.com/acme/old-name"]);
});

test("registry: a moved directory (with a remote) is the same project; a path-only project follows `movedFrom`", async () => {
  const reg = registry();
  const base = await tmpDir("knowledge-move-");
  const a = join(base, "a");
  const withRemote = await makeRepo({ remote: "https://github.com/acme/moved.git", dir: a });
  const first = await reg.identify(withRemote);
  const b = join(base, "b");
  await rename(withRemote, b);
  assert.equal((await reg.identify(b)).slug, first.slug);

  const pathOnly = await makeRepo({ dir: join(base, "p1") });
  const p1 = await reg.identify(pathOnly);
  const moved = join(base, "p2");
  await rename(pathOnly, moved);
  const rid = await reg.identify(moved, { movedFrom: pathOnly });
  assert.equal(rid.slug, p1.slug);
  assert.match((await reg.get(p1.slug)).canonicalId, new RegExp(`p2$`));
  void mkdir;
});

test("registry: an unresolvable directory identifies as null and registers nothing", async () => {
  const reg = registry();
  assert.equal(await reg.identify("/definitely/not/here"), null);
  assert.equal((await reg.list()).length, 0);
});

// ---- R3-B2: only git's own "not a git repository" means `box` ----
function scriptedGit(fail) {
  const calls = [];
  return {
    calls,
    run: async (args, o) => {
      calls.push(args.join(" "));
      const f = fail(args);
      if (f) throw f;
      return execGitRunner().run(args, o);
    },
  };
}
const gitErr = (message, code) => Object.assign(new Error(message), { stderr: message, code });

test("resolve: a git timeout or a dubious-ownership refusal is unresolved (null) and never cached; only 'not a git repository' is box", async () => {
  const root = await makeRepo({ remote: "https://github.com/acme/widget.git" });
  for (const failure of [gitErr("spawn git ETIMEDOUT", "ETIMEDOUT"), gitErr("fatal: detected dubious ownership in repository at '/x'")]) {
    let broken = true;
    const g = scriptedGit((args) => (broken && args[0] === "rev-parse" ? failure : null));
    const r = createIdentityResolver({ git: g, cacheMs: 60_000 });
    assert.equal(await r.resolve(root), null);
    broken = false; // the same directory is retried, not served from a cache
    assert.equal((await r.resolve(root)).canonicalId, "github.com/acme/widget");
  }
  // a later command failing is just as unresolved (never a wrong path:/box identity)
  const g2 = scriptedGit((args) => (args[0] === "remote" && args[1] === undefined ? gitErr("spawn git ETIMEDOUT", "ETIMEDOUT") : null));
  assert.equal(await createIdentityResolver({ git: g2, cacheMs: 0 }).resolve(root), null);
  const plain = await tmpDir("knowledge-plain-");
  const box = await createIdentityResolver({ git: scriptedGit(() => null), cacheMs: 0 }).resolve(plain);
  assert.equal(box.kind, "box");
  const reg = createProjectRegistry({ resolver: createIdentityResolver({ git: scriptedGit((a) => (a[0] === "rev-parse" ? gitErr("ETIMEDOUT", "ETIMEDOUT") : null)), cacheMs: 0 }), load: async () => emptyRegistry(), save: async () => {} });
  assert.equal(await reg.identify(root), null);
});

// ---- R3-S6 ----
test("the registry records the repository's root commit", async () => {
  const reg = registry();
  const root = await makeRepo({ remote: "https://github.com/acme/first.git" });
  const first = await reg.identify(root);
  assert.match((await reg.get(first.slug)).rootCommit, /^[0-9a-f]{40}$/);
});

test("registry: a reused folder with a different root commit is not carried over (controlled root commits)", async () => {
  let doc = emptyRegistry();
  const resolve = (canonicalId, rootCommit) => ({ canonicalId, name: canonicalId.split("/").pop(), repoRoot: "/reused", kind: "remote", pathId: "path:/reused", rootCommit });
  let current = resolve("github.com/acme/first", "a".repeat(40));
  const reg = createProjectRegistry({ resolver: { resolve: async () => current }, load: async () => doc, save: async (d) => (doc = JSON.parse(JSON.stringify(d))) });
  const first = await reg.identify("/reused");
  current = resolve("github.com/acme/second", "b".repeat(40));
  const second = await reg.identify("/reused");
  assert.notEqual(second.slug, first.slug);
  // same root commit → carried
  current = resolve("github.com/acme/second-renamed", "b".repeat(40));
  assert.equal((await reg.identify("/reused")).slug, second.slug);
  // a legacy project with no stored root commit and a non-path id is not carried either
  doc.projects[first.slug].rootCommit = undefined;
  current = resolve("github.com/acme/third", "c".repeat(40));
  const third = await reg.identify("/reused");
  assert.notEqual(third.slug, first.slug);
  assert.notEqual(third.slug, second.slug);
  // a path: project follows (nothing else to compare)
  let cur2 = { canonicalId: "path:/old", name: "old", repoRoot: "/old", kind: "path", pathId: "path:/old", rootCommit: "d".repeat(40) };
  const reg2 = createProjectRegistry({ resolver: { resolve: async () => cur2 }, load: async () => emptyRegistry(), save: async () => {} });
  const p = await reg2.identify("/old");
  cur2 = { canonicalId: "github.com/acme/now-remote", name: "now-remote", repoRoot: "/old", kind: "remote", pathId: "path:/old", rootCommit: "e".repeat(40) };
  assert.equal((await reg2.identify("/old")).slug, p.slug);
});

test("registry loader drops hand-edited entries with malformed slugs", async () => {
  const good = "alpha-0123456789";
  const reg = createProjectRegistry({
    resolver: resolver(),
    load: async () => ({ version: 1, projects: { [good]: { slug: good, canonicalId: "github.com/o/a", aliases: ["x", 5], paths: [], displayName: "a" }, "../evil": { slug: "../evil", canonicalId: "x", aliases: [], paths: [] }, "bad-0123456789": { slug: "other-0123456789", canonicalId: "y", aliases: [], paths: [] } } }),
    save: async () => {},
  });
  const list = await reg.list();
  assert.deepEqual(list.map((p) => p.slug), [good]);
  assert.deepEqual(list[0].aliases, ["x"]);
});

test("N7: a plain resolve (and a repeat identify of a known project) never runs rev-list; registration does, once", async () => {
  const root = await makeRepo({ remote: "https://github.com/acme/lazyroot.git" });
  const calls = [];
  const git = { run: (args, o) => (calls.push(args[0]), execGitRunner(root).run(args, o)) };
  const resolver = createIdentityResolver({ git, cacheMs: 0 });
  const r = await resolver.resolve(root);
  assert.equal(r.kind, "remote");
  assert.equal(calls.includes("rev-list"), false, "resolving costs no rev-list");
  assert.equal(Object.keys(r).includes("rootCommitOf"), false);
  let doc = emptyRegistry();
  const reg = createProjectRegistry({ resolver, load: async () => doc, save: async (d) => { doc = d; } });
  const first = await reg.identify(root);
  assert.equal(calls.filter((c) => c === "rev-list").length, 1, "registering a new project computes it");
  assert.match(doc.projects[first.slug].rootCommit, /^[0-9a-f]{40}$/);
  calls.length = 0;
  await reg.identify(root);
  await reg.identify(root);
  assert.equal(calls.includes("rev-list"), false, "a known project with a recorded root commit never recomputes it");
});
