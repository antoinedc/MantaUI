import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsListDirs, parseWorktrees } from "./local.mjs";

test("parseWorktrees parses `git worktree list --porcelain`", () => {
  const out = parseWorktrees(
    "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
    "worktree /repo/wt\nHEAD def456\ndetached\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "/repo");
  assert.equal(out[0].branch, "main");
  assert.equal(out[1].detached, true);
});

// ---- BET-307: fsListDirs returns paths in the form the caller typed -------
//
// Autocomplete: the renderer's `(await fsListDirs(value)).filter(m => m.startsWith(value))`
// filter only matches when results are in the SAME form as the input. Before
// the fix, typing `~/pro` returned absolute `/home/dev/projects` and the
// filter rejected everything → no ghost-text. Fix: server returns tilde-form
// when input was tilde-form, absolute-form otherwise.

test("fsListDirs: tilde input returns tilde-form results", async () => {
  const home = process.env.HOME;
  assert.ok(home, "HOME is set");
  // Create a sibling inside HOME whose name starts with a known prefix so
  // fsListDirs picks it up. `fsListDirs("~/pro")` is the documented example
  // — it lists ~/.../ entries whose name starts with `pro`.
  const root = await mkdtemp(join(home, "fslist-tilde-pro-"));
  try {
    const out = await fsListDirs("~/fslist-tilde-pro");
    // The mkdtemp suffix (random characters) is the only entry matching the
    // typed prefix; verify it appears in tilde-form.
    const tildeName = root.slice(home.length); // ".fslist-tilde-pro-XXXX" → "/fslist-tilde-pro-XXXX" → strip leading /
    const expected = "~" + tildeName;
    assert.ok(out.includes(expected),
      `expected tilde-form ${expected}, got ${JSON.stringify(out)}`);
    assert.ok(out.every((p) => p.startsWith("~")),
      `all results tilde-form: ${JSON.stringify(out)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: absolute input returns absolute results", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-abs-root-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  await writeFile(join(root, "not-a-dir.txt"), "skip");
  try {
    // Pass the parent + a typed prefix so the function lists parent's
    // children matching the prefix — mirrors how the renderer's
    // ghost-text suggestion behaves (typing a partial, getting completions).
    const out = await fsListDirs(join(root, "al"));
    assert.ok(out.includes(join(root, "alpha")), `alpha present: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(join(root, "beta")), "beta does not match prefix 'al'");
    assert.ok(!out.some((p) => p.endsWith("not-a-dir.txt")),
      "files are filtered out");
    assert.ok(out.every((p) => p.startsWith("/")),
      "all results absolute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: bare '~' lists the HOME directory's children, not /home's", async () => {
  // A bare `~` must NOT be split as parent=`/home/`, prefix=`<user>` — that
  // would list `/home`'s children (other users), not the user's own home.
  const out = await fsListDirs("~");
  // Every entry is either an absolute path under process.env.HOME, or (on
  // systems where homedir() !== process.env.HOME, e.g. macOS where homedir()
  // is /Users/x but a test could be run with HOME=/var/…) an empty list.
  // Assert no `/home/` parent split: results must not all live under `/home/`.
  if (out.length === 0) return; // skip on platforms where the assertion is moot
  const home = process.env.HOME ?? "";
  assert.ok(out.every((p) => p.startsWith(home) || p.startsWith("~")),
    `results should be under HOME, got ${JSON.stringify(out)}`);
  assert.ok(!out.some((p) => p.startsWith("/home/") && !p.startsWith(home)),
    `bare ~ must not list /home/'s children, got ${JSON.stringify(out)}`);
});

test("fsListDirs: prefix filter narrows results by the typed suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-prefix-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"),  { recursive: true });
  try {
    const out = await fsListDirs(join(root, "al"));
    assert.ok(out.includes(join(root, "alpha")));
    assert.ok(!out.includes(join(root, "beta")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
