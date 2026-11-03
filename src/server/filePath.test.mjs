// filePath.mjs against REAL tmp directories: a throwaway "home" and a sibling
// "outside" dir, with the fake homedir injected (`~` expands against it; nothing
// else is home-scoped any more — 2026-11-03 explorer follow-up §7a). Run via `npm run test:server`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, realpath, chmod, open as fsOpen } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilePath } from "./filePath.mjs";

let root;
let home;
let outside;
let hp;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "filepath-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  await mkdir(home);
  await mkdir(outside);
  await writeFile(join(home, "a.txt"), "hello");
  await mkdir(join(home, "sub"));
  await writeFile(join(home, "sub", "b.txt"), "bee");
  await writeFile(join(outside, "secret.txt"), "secret");
  hp = createFilePath({ homedir: () => home });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("resolvePath: absolute path inside home", async () => {
  const r = await hp.resolvePath(join(home, "a.txt"));
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "a.txt"));
  assert.equal(r.canonical, join(home, "a.txt"));
  assert.equal(r.stat.isFile(), true);
});

test("resolvePath: ~ and ~/x expand against the home dir", async () => {
  const h = await hp.resolvePath("~");
  assert.equal(h.ok, true);
  assert.equal(h.canonical, home);
  assert.equal(h.stat.isDirectory(), true);
  const f = await hp.resolvePath("~/sub/b.txt");
  assert.equal(f.ok, true);
  assert.equal(f.abs, join(home, "sub", "b.txt"));
});

test("resolvePath: a path outside home resolves (no home boundary)", async () => {
  const r = await hp.resolvePath(join(outside, "secret.txt"));
  assert.equal(r.ok, true);
  assert.equal(r.canonical, join(outside, "secret.txt"));
  const root = await hp.resolvePath("/");
  assert.equal(root.ok, true);
  assert.equal(root.stat.isDirectory(), true);
});

test("resolvePath: .. out of home resolves to the real target", async () => {
  const r = await hp.resolvePath(join(home, "sub", "..", "..", "outside", "secret.txt"));
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(outside, "secret.txt"));
  const t = await hp.resolvePath("~/../outside/secret.txt");
  assert.equal(t.ok, true);
  assert.equal(t.canonical, join(outside, "secret.txt"));
});

test("resolvePath: symlinks to outside resolve to their real target", async () => {
  await symlink(join(outside, "secret.txt"), join(home, "link-file"));
  const f = await hp.resolvePath(join(home, "link-file"));
  assert.equal(f.ok, true);
  assert.equal(f.abs, join(home, "link-file"));
  assert.equal(f.canonical, join(outside, "secret.txt"));
  await symlink(outside, join(home, "link-dir"));
  const d = await hp.resolvePath(join(home, "link-dir"));
  assert.equal(d.ok, true);
  assert.equal(d.canonical, outside);
  const through = await hp.resolvePath(join(home, "link-dir", "secret.txt"));
  assert.equal(through.ok, true);
  assert.equal(through.canonical, join(outside, "secret.txt"));
});

test("resolvePath: symlink inside home resolves to its target", async () => {
  await symlink(join(home, "a.txt"), join(home, "link-in"));
  const r = await hp.resolvePath(join(home, "link-in"));
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "link-in"));
  assert.equal(r.canonical, join(home, "a.txt"));
});

test("resolvePath: missing, and a path through a file, are missing", async () => {
  assert.deepEqual(await hp.resolvePath(join(home, "nope.txt")), { ok: false, reason: "missing" });
  assert.deepEqual(await hp.resolvePath(join(home, "a.txt", "x")), { ok: false, reason: "missing" });
});

test("resolvePath: relative path needs a base; resolves against it", async () => {
  assert.deepEqual(await hp.resolvePath("sub/b.txt"), { ok: false, reason: "invalid_input" });
  const r = await hp.resolvePath("b.txt", { base: join(home, "sub") });
  assert.equal(r.ok, true);
  assert.equal(r.abs, join(home, "sub", "b.txt"));
  const up = await hp.resolvePath("../a.txt", { base: "~/sub" });
  assert.equal(up.ok, true);
  assert.equal(up.abs, join(home, "a.txt"));
});

test("resolvePath: base must itself pass and be a directory", async () => {
  assert.deepEqual(await hp.resolvePath("x", { base: outside }), { ok: false, reason: "missing" });
  assert.equal((await hp.resolvePath("secret.txt", { base: outside })).ok, true);
  assert.deepEqual(await hp.resolvePath("x", { base: join(home, "gone") }), { ok: false, reason: "missing" });
  assert.deepEqual(await hp.resolvePath("x", { base: join(home, "a.txt") }), { ok: false, reason: "not-file" });
});

test("resolvePath: relative escape through base resolves to the real target", async () => {
  const r = await hp.resolvePath("../../outside/secret.txt", { base: join(home, "sub") });
  assert.equal(r.ok, true);
  assert.equal(r.canonical, join(outside, "secret.txt"));
});

test("resolvePath: empty / NUL input is invalid_input", async () => {
  assert.deepEqual(await hp.resolvePath(""), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await hp.resolvePath(join(home, "a\0b")), { ok: false, reason: "invalid_input" });
  assert.deepEqual(await hp.resolvePath(undefined), { ok: false, reason: "invalid_input" });
});

test("resolvePath: EACCES is permission", { skip: process.getuid?.() === 0 }, async () => {
  const locked = join(home, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "f.txt"), "f");
  await chmod(locked, 0o000);
  try {
    assert.deepEqual(await hp.resolvePath(join(locked, "f.txt")), { ok: false, reason: "permission" });
  } finally {
    await chmod(locked, 0o755);
  }
});

test("openPath: opens a regular file and returns a usable handle", async () => {
  const r = await hp.openPath("~/a.txt");
  assert.equal(r.ok, true);
  try {
    assert.equal(r.stat.size, 5);
    assert.equal((await r.handle.readFile()).toString(), "hello");
  } finally {
    await r.handle.close();
  }
});

test("openPath: opens a file outside home", async () => {
  const r = await hp.openPath(join(outside, "secret.txt"));
  assert.equal(r.ok, true);
  try {
    assert.equal((await r.handle.readFile()).toString(), "secret");
  } finally {
    await r.handle.close();
  }
});

test("openPath: passes resolve failures through", async () => {
  assert.deepEqual(await hp.openPath(join(home, "nope")), { ok: false, reason: "missing" });
});

test("openPath: a directory is not-file", async () => {
  assert.deepEqual(await hp.openPath(join(home, "sub")), { ok: false, reason: "not-file" });
});

test("openPath: a FIFO is not-file (and never blocks)", async () => {
  const fifo = join(home, "pipe");
  execFileSync("mkfifo", [fifo]);
  assert.deepEqual(await hp.openPath(fifo), { ok: false, reason: "not-file" });
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

test("openPath: file swapped once between resolve and open succeeds on the retry", async () => {
  const f = join(home, "swap-once.txt");
  await writeFile(f, "original");
  const p = createFilePath({ homedir: () => home, open: swappingOpen(1) });
  const r = await p.openPath(f);
  assert.equal(r.ok, true);
  try {
    assert.equal((await r.handle.readFile()).toString(), "replacement");
  } finally {
    await r.handle.close();
  }
});

test("openPath: file swapped on every attempt is `changed`", async () => {
  const f = join(home, "swap-always.txt");
  await writeFile(f, "original");
  const p = createFilePath({ homedir: () => home, open: swappingOpen(5) });
  assert.deepEqual(await p.openPath(f), { ok: false, reason: "changed" });
});

test("openPath: a vetted file swapped for a symlink is never opened through the link", async () => {
  const f = join(home, "swap-link.txt");
  await writeFile(f, "original");
  const flagsSeen = [];
  let swapped = false;
  const evil = async (path, flags) => {
    flagsSeen.push(flags);
    if (!swapped) {
      swapped = true;
      await rm(path, { force: true });
      await symlink(join(outside, "secret.txt"), path);
    }
    return fsOpen(path, flags);
  };
  const p = createFilePath({ homedir: () => home, open: evil });
  const r = await p.openPath(f);
  // The first open hits the swapped link and fails (O_NOFOLLOW); the retry
  // re-vets the link and opens its real target, which matches what was vetted.
  assert.equal(flagsSeen.length, 2);
  assert.ok(flagsSeen.every((fl) => (fl & fsConstants.O_NOFOLLOW) !== 0));
  assert.equal(r.ok, true);
  assert.equal(r.canonical, join(outside, "secret.txt"));
  await r.handle.close();
});
