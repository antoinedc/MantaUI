// homePath.mjs against REAL tmp directories: a throwaway "home" and a sibling
// "outside" dir, with the fake homedir injected. Run via `npm run test:server`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, realpath, chmod, open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHomePath } from "./homePath.mjs";

let root;
let home;
let outside;
let hp;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "homepath-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  await mkdir(home);
  await mkdir(outside);
  await writeFile(join(home, "a.txt"), "hello");
  await mkdir(join(home, "sub"));
  await writeFile(join(home, "sub", "b.txt"), "bee");
  await writeFile(join(outside, "secret.txt"), "secret");
  hp = createHomePath({ homedir: () => home });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("resolveInHome: absolute path inside home", async () => {
  const r = await hp.resolveInHome(join(home, "a.txt"));
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "a.txt"));
  assert.equal(r.canonical, join(home, "a.txt"));
  assert.equal(r.stat.isFile(), true);
});

test("resolveInHome: ~ and ~/x expand against the home dir", async () => {
  const h = await hp.resolveInHome("~");
  assert.equal(h.ok, true);
  assert.equal(h.canonical, home);
  assert.equal(h.stat.isDirectory(), true);
  const f = await hp.resolveInHome("~/sub/b.txt");
  assert.equal(f.ok, true);
  assert.equal(f.abs, join(home, "sub", "b.txt"));
});

test("resolveInHome: home itself is inside", async () => {
  const r = await hp.resolveInHome(home);
  assert.equal(r.ok, true);
  assert.equal(r.canonical, home);
});

test("resolveInHome: .. escape out of home is outside-home", async () => {
  const r = await hp.resolveInHome(join(home, "sub", "..", "..", "outside", "secret.txt"));
  assert.deepEqual(r, { ok: false, reason: "outside-home" });
  assert.deepEqual(await hp.resolveInHome("~/../outside/secret.txt"), { ok: false, reason: "outside-home" });
});

test("resolveInHome: a sibling whose name merely starts with home's is outside", async () => {
  const sibling = home + "-evil";
  await mkdir(sibling);
  await writeFile(join(sibling, "x"), "x");
  const r = await hp.resolveInHome(join(sibling, "x"));
  assert.deepEqual(r, { ok: false, reason: "outside-home" });
});

test("resolveInHome: symlink to a file outside home is outside-home", async () => {
  await symlink(join(outside, "secret.txt"), join(home, "link-file"));
  const r = await hp.resolveInHome(join(home, "link-file"));
  assert.deepEqual(r, { ok: false, reason: "outside-home" });
});

test("resolveInHome: symlink to a dir outside home (and a path through it) is outside-home", async () => {
  await symlink(outside, join(home, "link-dir"));
  assert.deepEqual(await hp.resolveInHome(join(home, "link-dir")), { ok: false, reason: "outside-home" });
  assert.deepEqual(await hp.resolveInHome(join(home, "link-dir", "secret.txt")), {
    ok: false,
    reason: "outside-home",
  });
});

test("resolveInHome: symlink inside home resolves to its target", async () => {
  await symlink(join(home, "a.txt"), join(home, "link-in"));
  const r = await hp.resolveInHome(join(home, "link-in"));
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "link-in"));
  assert.equal(r.canonical, join(home, "a.txt"));
});

test("resolveInHome: missing, and a path through a file, are missing", async () => {
  assert.deepEqual(await hp.resolveInHome(join(home, "nope.txt")), { ok: false, reason: "missing" });
  assert.deepEqual(await hp.resolveInHome(join(home, "a.txt", "x")), { ok: false, reason: "missing" });
});

test("resolveInHome: relative path needs a base; resolves against it", async () => {
  assert.deepEqual(await hp.resolveInHome("sub/b.txt"), { ok: false, reason: "invalid_input" });
  const r = await hp.resolveInHome("b.txt", { base: join(home, "sub") });
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "sub", "b.txt"));
  const up = await hp.resolveInHome("../a.txt", { base: "~/sub" });
  assert.equal(up.ok, true);
  assert.equal(up.abs, join(home, "a.txt"));
});

test("resolveInHome: base must itself pass and be a directory", async () => {
  assert.deepEqual(await hp.resolveInHome("x", { base: outside }), { ok: false, reason: "outside-home" });
  assert.deepEqual(await hp.resolveInHome("x", { base: join(home, "gone") }), { ok: false, reason: "missing" });
  assert.deepEqual(await hp.resolveInHome("x", { base: join(home, "a.txt") }), { ok: false, reason: "not-file" });
});

test("resolveInHome: relative escape through base is outside-home", async () => {
  const r = await hp.resolveInHome("../../outside/secret.txt", { base: join(home, "sub") });
  assert.deepEqual(r, { ok: false, reason: "outside-home" });
});

test("resolveInHome: empty / NUL input is invalid_input", async () => {
  assert.deepEqual(await hp.resolveInHome(""), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await hp.resolveInHome(join(home, "a\0b")), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await hp.resolveInHome(undefined), { ok: false, reason: "invalid_input" });
});

test("resolveInHome: EACCES is permission", { skip: process.getuid?.() === 0 }, async () => {
  const locked = join(home, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "f.txt"), "f");
  await chmod(locked, 0o000);
  try {
    assert.deepEqual(await hp.resolveInHome(join(locked, "f.txt")), { ok: false, reason: "permission" });
  } finally {
    await chmod(locked, 0o755);
  }
});

test("openInHome: opens a regular file and returns a usable handle", async () => {
  const r = await hp.openInHome("~/a.txt");
  assert.equal(r.ok, true);
  try {
    assert.equal(r.stat.size, 5);
    assert.equal((await r.handle.readFile()).toString(), "hello");
  } finally {
    await r.handle.close();
  }
});

test("openInHome: passes resolve failures through", async () => {
  assert.deepEqual(await hp.openInHome(join(outside, "secret.txt")), { ok: false, reason: "outside-home" });
  assert.deepEqual(await hp.openInHome(join(home, "nope")), { ok: false, reason: "missing" });
});

test("openInHome: a directory is not-file", async () => {
  assert.deepEqual(await hp.openInHome(join(home, "sub")), { ok: false, reason: "not-file" });
});

test("openInHome: a FIFO is not-file (and never blocks)", async () => {
  const fifo = join(home, "pipe");
  execFileSync("mkfifo", [fifo]);
  assert.deepEqual(await hp.openInHome(fifo), { ok: false, reason: "not-file" });
});

// Replace the vetted file with a fresh one (new inode) just before the real open.
function swappingOpen(times) {
  let n = 0;
  return async (path, flags) => {
    if (n < times) {
      n++;
      await rename(path, path + `.old${n}`);
      await writeFile(path, "replacement");
    }
    return fsOpen(path, flags);
  };
}

test("openInHome: file swapped once between resolve and open succeeds on the retry", async () => {
  const f = join(home, "swap-once.txt");
  await writeFile(f, "original");
  const p = createHomePath({ homedir: () => home, open: swappingOpen(1) });
  const r = await p.openInHome(f);
  assert.equal(r.ok, true);
  try {
    assert.equal((await r.handle.readFile()).toString(), "replacement");
  } finally {
    await r.handle.close();
  }
});

test("openInHome: file swapped on every attempt is `changed`", async () => {
  const f = join(home, "swap-always.txt");
  await writeFile(f, "original");
  const p = createHomePath({ homedir: () => home, open: swappingOpen(5) });
  assert.deepEqual(await p.openInHome(f), { ok: false, reason: "changed" });
});

test("openInHome: a vetted file swapped for a symlink to outside is never opened", async () => {
  const f = join(home, "swap-link.txt");
  await writeFile(f, "original");
  let opened = 0;
  const evil = async (path, flags) => {
    await rm(path, { force: true });
    await symlink(join(outside, "secret.txt"), path);
    opened++;
    return fsOpen(path, flags);
  };
  const p = createHomePath({ homedir: () => home, open: evil });
  const r = await p.openInHome(f);
  assert.equal(r.ok, false);
  assert.ok(["changed", "outside-home"].includes(r.reason), r.reason);
  assert.equal(r.handle, undefined);
  assert.ok(opened >= 1);
});
