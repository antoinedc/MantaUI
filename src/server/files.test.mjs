// files.mjs (fs:resolve-paths / fs:list / fs:git-status) against REAL tmp
// directories and real git repos, with a fake home injected. Timeouts and
// unexpected git failures use an injected runGit. Run via `npm run test:server`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFiles, defaultRunGit, FS_RESOLVE_MAX, FS_LIST_MAX } from "./files.mjs";
import { createFilePath } from "./filePath.mjs";

let root;
let home;
let outside;
let files;

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
}

async function newRepo(name) {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "files-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  await mkdir(home);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  files = createFiles({ filePath: createFilePath({ homedir: () => home }) });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolvePaths
// ---------------------------------------------------------------------------

test("resolvePaths: files, dirs, relative-to-base, and every failure reason", async () => {
  const proj = join(home, "proj");
  await mkdir(join(proj, "src"), { recursive: true });
  await writeFile(join(proj, "src", "a.ts"), "12345");
  await symlink(join(outside, "secret.txt"), join(proj, "escape"));
  const { results } = await files.resolvePaths({
    base: proj,
    paths: ["src/a.ts", "./src", "~/proj/src/a.ts", "nope.ts", "../../outside/secret.txt", "escape", 42, ""],
  });
  assert.equal(results.length, 8);
  assert.deepEqual(results[0], {
    input: "src/a.ts",
    ok: true,
    abs: join(proj, "src", "a.ts"),
    kind: "file",
    size: 5,
    mtimeMs: results[0].mtimeMs,
  });
  assert.equal(typeof results[0].mtimeMs, "number");
  assert.equal(results[1].ok && results[1].kind, "dir");
  assert.equal(results[2].ok && results[2].abs, join(proj, "src", "a.ts"));
  assert.deepEqual(results[3], { input: "nope.ts", ok: false, reason: "missing" });
  assert.equal(results[4].ok && results[4].abs, join(outside, "secret.txt"));
  assert.equal(results[5].ok && results[5].abs, join(proj, "escape"));
  assert.equal(results[5].ok && results[5].size, 6);
  assert.deepEqual(results[6], { input: 42, ok: false, reason: "invalid_input" });
  assert.deepEqual(results[7], { input: "", ok: false, reason: "invalid_input" });
});

test("resolvePaths: a base outside home resolves its relative paths", async () => {
  const { results } = await files.resolvePaths({ base: outside, paths: ["secret.txt", "/"] });
  assert.equal(results[0].ok && results[0].abs, join(outside, "secret.txt"));
  assert.equal(results[1].ok && results[1].kind, "dir");
});

test("resolvePaths: a FIFO is not-file", async () => {
  execFileSync("mkfifo", [join(home, "resolve-fifo")]);
  const { results } = await files.resolvePaths({ base: home, paths: ["resolve-fifo"] });
  assert.deepEqual(results, [{ input: "resolve-fifo", ok: false, reason: "not-file" }]);
});

test("resolvePaths: exactly the cap is fine, over the cap is rejected whole", async () => {
  await writeFile(join(home, "cap.txt"), "x");
  const ok = await files.resolvePaths({ base: home, paths: Array(FS_RESOLVE_MAX).fill("cap.txt") });
  assert.equal(ok.results.length, FS_RESOLVE_MAX);
  await assert.rejects(
    files.resolvePaths({ base: home, paths: Array(FS_RESOLVE_MAX + 1).fill("cap.txt") }),
    /too many paths/,
  );
  await assert.rejects(files.resolvePaths({ base: home, paths: "nope" }), /invalid input/);
});

// ---------------------------------------------------------------------------
// listDir
// ---------------------------------------------------------------------------

test("listDir: folders first, then case-insensitive natural order; dotfiles hidden-flagged; .git excluded", async () => {
  const d = join(home, "list-order");
  await mkdir(d);
  for (const f of ["file10.txt", "file2.txt", "Banana.txt", "apple.txt", ".env"]) await writeFile(join(d, f), f);
  for (const sub of ["zeta", "Alpha", ".config", ".git"]) await mkdir(join(d, sub));
  const r = await files.listDir({ dir: d });
  assert.equal(r.ok, true);
  assert.equal(r.dir, d);
  assert.deepEqual(
    r.entries.map((e) => e.name),
    [".config", "Alpha", "zeta", ".env", "apple.txt", "Banana.txt", "file2.txt", "file10.txt"],
  );
  assert.equal(r.total, 8);
  assert.equal(r.truncated, false);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(byName[".env"].hidden, true);
  assert.equal(byName[".config"].hidden, true);
  assert.equal(byName["apple.txt"].hidden, false);
  assert.equal(byName["Alpha"].kind, "dir");
  assert.equal(byName["apple.txt"].kind, "file");
  assert.equal(byName["apple.txt"].abs, join(d, "apple.txt"));
  assert.equal(byName["apple.txt"].size, 9);
  assert.equal(typeof byName["apple.txt"].mtimeMs, "number");
  assert.equal(byName["apple.txt"].ignored, false);
});

test("listDir: cap + truncated + total; limit is honoured and clamped", async () => {
  const d = join(home, "list-cap");
  await mkdir(d);
  for (let i = 0; i < 12; i++) await writeFile(join(d, `f${String(i).padStart(2, "0")}.txt`), "");
  const r = await files.listDir({ dir: d, limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 5);
  assert.equal(r.total, 12);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.entries.map((e) => e.name), ["f00.txt", "f01.txt", "f02.txt", "f03.txt", "f04.txt"]);
  const all = await files.listDir({ dir: d, limit: FS_LIST_MAX * 10 });
  assert.equal(all.entries.length, 12);
  assert.equal(all.truncated, false);
  assert.deepEqual(await files.listDir({ dir: d, limit: 0 }), { ok: false, reason: "invalid_input" });
});

test("listDir: git-ignored entries (files and dirs) are flagged from one check-ignore call", async () => {
  const repo = await newRepo("list-ignore");
  await writeFile(join(repo, ".gitignore"), "build/\n*.log\n");
  await mkdir(join(repo, "build"));
  await writeFile(join(repo, "keep.txt"), "k");
  await writeFile(join(repo, "debug.log"), "l");
  await mkdir(join(repo, "src"));
  let gitCalls = 0;
  const counting = createFiles({
    filePath: createFilePath({ homedir: () => home }),
    runGit: (...a) => {
      gitCalls++;
      return defaultRunGit(...a);
    },
  });
  const r = await counting.listDir({ dir: repo });
  const ignored = Object.fromEntries(r.entries.map((e) => [e.name, e.ignored]));
  assert.deepEqual(ignored, {
    build: true,
    src: false,
    ".gitignore": false,
    "debug.log": true,
    "keep.txt": false,
  });
  assert.equal(gitCalls, 1);
  assert.ok(!r.entries.some((e) => e.name === ".git"));
});

test("listDir: outside a git repo, or when git times out, nothing is ignored", async () => {
  const d = join(home, "list-nogit");
  await mkdir(d);
  await writeFile(join(d, "a.log"), "");
  const plain = await files.listDir({ dir: d });
  assert.equal(plain.entries[0].ignored, false);

  const timing = createFiles({
    filePath: createFilePath({ homedir: () => home }),
    runGit: async () => {
      const e = new Error("git timed out");
      e.timedOut = true;
      throw e;
    },
  });
  const r = await timing.listDir({ dir: d });
  assert.equal(r.ok, true);
  assert.equal(r.entries[0].ignored, false);
});

test("listDir: symlinks — every link follows its target kind (inside or outside home), broken is skipped", async () => {
  const d = join(home, "list-links");
  await mkdir(join(d, "realdir"), { recursive: true });
  await writeFile(join(d, "real.txt"), "12345");
  await symlink(join(d, "realdir"), join(d, "dirlink"));
  await symlink(join(d, "real.txt"), join(d, "filelink"));
  await symlink(join(outside, "secret.txt"), join(d, "escape-file"));
  await symlink(outside, join(d, "escape-dir"));
  await symlink(join(d, "gone"), join(d, "broken"));
  const r = await files.listDir({ dir: d });
  assert.equal(r.ok, true);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(byName.dirlink.kind, "dir");
  assert.equal(byName.filelink.kind, "file");
  assert.equal(byName.filelink.size, 5);
  assert.equal(byName["escape-file"].kind, "file");
  assert.equal(byName["escape-file"].size, 6);
  assert.equal(byName["escape-dir"].kind, "dir");
  assert.equal(byName.broken, undefined);
  assert.equal(r.total, r.entries.length);
  assert.equal(byName["escape-dir"].abs, join(d, "escape-dir"));
});

test("listDir: failures are returned, not thrown", async () => {
  const out = await files.listDir({ dir: outside });
  assert.equal(out.ok, true);
  assert.deepEqual(out.entries.map((e) => e.name), ["secret.txt"]);
  assert.deepEqual(await files.listDir({ dir: join(home, "nope-dir") }), { ok: false, reason: "missing" });
  assert.deepEqual(await files.listDir({ dir: join(home, "cap.txt") }), { ok: false, reason: "not-file" });
  assert.deepEqual(await files.listDir({ dir: "relative" }), { ok: false, reason: "invalid_input" });
});

test("listDir: an unreadable directory is permission", { skip: process.getuid?.() === 0 }, async () => {
  const d = join(home, "list-locked");
  await mkdir(d);
  await chmod(d, 0o000);
  try {
    assert.deepEqual(await files.listDir({ dir: d }), { ok: false, reason: "permission" });
  } finally {
    await chmod(d, 0o755);
  }
});

// ---------------------------------------------------------------------------
// gitStatus
// ---------------------------------------------------------------------------

async function statusFixture() {
  const repo = await newRepo("status-repo");
  await mkdir(join(repo, "sub"));
  for (const f of ["mod.txt", "del.txt", "ren-old.txt", join("sub", "inner.txt"), join("sub", "inner2.txt")]) {
    await writeFile(join(repo, f), "base\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  await writeFile(join(repo, "mod.txt"), "changed\n");
  await unlink(join(repo, "del.txt"));
  git(repo, "mv", "ren-old.txt", "ren-new.txt");
  await writeFile(join(repo, "added.txt"), "new\n");
  git(repo, "add", "added.txt");
  await writeFile(join(repo, "u.txt"), "untracked\n");
  await mkdir(join(repo, "newdir"));
  await writeFile(join(repo, "newdir", "x.txt"), "x\n");
  await writeFile(join(repo, "sub", "inner.txt"), "changed\n");
  return repo;
}

test("gitStatus: maps modified / added / rename target / untracked, omits deletions", async () => {
  const repo = await statusFixture();
  const r = await files.gitStatus({ root: repo });
  assert.deepEqual(r, {
    ok: true,
    changes: {
      "mod.txt": "M",
      "added.txt": "A",
      "ren-new.txt": "A",
      "u.txt": "?",
      newdir: "?",
      "sub/inner.txt": "M",
    },
  });
});

test("gitStatus: a nested root strips the toplevel prefix and drops entries outside it", async () => {
  const repo = join(home, "status-repo");
  const r = await files.gitStatus({ root: join(repo, "sub") });
  assert.deepEqual(r, { ok: true, changes: { "inner.txt": "M" } });
});

test("gitStatus: merge conflicts are `!`", async () => {
  const repo = await newRepo("status-conflict");
  await writeFile(join(repo, "f.txt"), "base\n");
  await writeFile(join(repo, "both.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "other");
  await writeFile(join(repo, "f.txt"), "other\n");
  git(repo, "commit", "-q", "-am", "other");
  git(repo, "checkout", "-q", "main");
  await writeFile(join(repo, "f.txt"), "main\n");
  git(repo, "commit", "-q", "-am", "main");
  assert.throws(() => git(repo, "merge", "other"));
  const r = await files.gitStatus({ root: repo });
  assert.deepEqual(r, { ok: true, changes: { "f.txt": "!" } });
});

test("gitStatus: a clean repo has no changes; a non-git dir is not-git", async () => {
  const clean = await newRepo("status-clean");
  assert.deepEqual(await files.gitStatus({ root: clean }), { ok: true, changes: {} });
  const plain = join(home, "status-plain");
  await mkdir(plain);
  assert.deepEqual(await files.gitStatus({ root: plain }), { ok: false, reason: "not-git" });
});

test("gitStatus: policy failures are returned", async () => {
  assert.deepEqual(await files.gitStatus({ root: outside }), { ok: false, reason: "not-git" });
  assert.deepEqual(await files.gitStatus({ root: join(home, "nope") }), { ok: false, reason: "missing" });
  assert.deepEqual(await files.gitStatus({ root: join(home, "cap.txt") }), { ok: false, reason: "not-file" });
});

function fakeGit(handlers) {
  return createFiles({
    filePath: createFilePath({ homedir: () => home }),
    runGit: async (args) => handlers(args),
  });
}

test("gitStatus: a git timeout is `timeout`", async () => {
  const f = fakeGit(() => {
    const e = new Error("git timed out");
    e.timedOut = true;
    throw e;
  });
  assert.deepEqual(await f.gitStatus({ root: home }), { ok: false, reason: "timeout" });
});

test("gitStatus: parses rename records (extra source field) from raw porcelain", async () => {
  const f = fakeGit((args) =>
    args.includes("rev-parse")
      ? { code: 0, stdout: home + "\n" }
      : { code: 0, stdout: "R  new name.txt\0old name.txt\0 M plain.txt\0?? dir/\0 D gone.txt\0UU c.txt\0DD d.txt\0 T t.txt\0" },
  );
  assert.deepEqual(await f.gitStatus({ root: home }), {
    ok: true,
    changes: { "new name.txt": "A", "plain.txt": "M", dir: "?", "c.txt": "!", "d.txt": "!", "t.txt": "M" },
  });
});

test("gitStatus: an unexpected git failure throws a safe message and logs the raw one", async () => {
  const f = fakeGit(() => {
    throw new Error("/home/secret/path: boom");
  });
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    await assert.rejects(f.gitStatus({ root: home }), (e) => e.message === "file system error");
  } finally {
    console.warn = warn;
  }
  assert.ok(logged.some((l) => l.includes("boom")));
});
