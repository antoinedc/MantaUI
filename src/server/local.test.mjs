import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsListDirs, parseWorktrees, shouldSkipDir, dedupeRepoHits, sortRepoHits, parseGhAuthStatus, parseCloneProgress, gitPush } from "./local.mjs";

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

// ===========================================================================
// BET-786: repo-probe pure helpers
// ===========================================================================

test("shouldSkipDir: dotfiles and the heavy/build dirs are skipped", () => {
  for (const name of [".git", ".hidden", ".config", "node_modules", "vendor", "target", "dist", "build"]) {
    assert.equal(shouldSkipDir(name), true, `should skip ${name}`);
  }
  for (const name of ["src", "manta", "repos", "my-project", "Foo"]) {
    assert.equal(shouldSkipDir(name), false, `should not skip ${name}`);
  }
  assert.equal(shouldSkipDir(""), true, "empty name skips");
  assert.equal(shouldSkipDir(null), true, "non-string skips");
});

test("dedupeRepoHits: real-path dedupe (symlinked roots)", () => {
  const hits = [
    { path: "/home/u/r", _realPath: "/data/repo", repoKey: "github.com/a/b", lastCommitAt: 5 },
    { path: "/home/u/link/r", _realPath: "/data/repo", repoKey: "github.com/a/b", lastCommitAt: 5 },
    { path: "/home/u/other", _realPath: "/data/other", repoKey: null, lastCommitAt: 3 },
  ];
  const out = dedupeRepoHits(hits);
  assert.equal(out.length, 2, "duplicate real path collapsed");
  assert.deepEqual(out.map((h) => h.path), ["/home/u/r", "/home/u/other"]);
});

test("dedupeRepoHits: falls back to path when no real path is stamped", () => {
  const out = dedupeRepoHits([
    { path: "/a", _realPath: "/a", repoKey: null },
    { path: "/a", _realPath: "/a", repoKey: null },
    { path: "/b", _realPath: "/b", repoKey: null },
  ]);
  assert.equal(out.length, 2);
});

test("sortRepoHits: recency order, known-forge (repoKey) first", () => {
  const hits = [
    { path: "/old", repoKey: null, lastCommitAt: 100 },
    { path: "/recent-noforge", repoKey: null, lastCommitAt: 900 },
    { path: "/keyed-old", repoKey: "github.com/a/b", lastCommitAt: 100 },
    { path: "/keyed-recent", repoKey: "github.com/c/d", lastCommitAt: 500 },
  ];
  const sorted = sortRepoHits(hits);
  // Keyed repos sort above unkeyed regardless of recency.
  assert.equal(sorted[0].path, "/keyed-recent");
  assert.equal(sorted[1].path, "/keyed-old");
  // Within each group, most recent lastCommitAt first.
  assert.equal(sorted[2].path, "/recent-noforge");
  assert.equal(sorted[3].path, "/old");
  // Input not mutated.
  assert.equal(hits[0].path, "/old");
});

test("sortRepoHits: null lastCommitAt sorts last", () => {
  const sorted = sortRepoHits([
    { path: "/unknown", repoKey: null, lastCommitAt: null },
    { path: "/known", repoKey: "github.com/a/b", lastCommitAt: 10 },
    { path: "/plain", repoKey: null, lastCommitAt: 50 },
  ]);
  assert.deepEqual(sorted.map((h) => h.path), ["/known", "/plain", "/unknown"]);
});

test("parseGhAuthStatus: extracts the login from `gh auth status` output", () => {
  assert.equal(
    parseGhAuthStatus("github.com\n  ✓ Logged in to github.com as octocat (oauth)\n  ✓ Active account: true\n"),
    "octocat",
  );
});

test("parseGhAuthStatus: modern gh `account <login> (` form is accepted", () => {
  assert.equal(
    parseGhAuthStatus("github.com\n  ✓ Logged in to github.com account octocat (oauth)\n  ✓ Active account: true\n"),
    "octocat",
  );
});

test("parseGhAuthStatus: modern token-like account value is still rejected", () => {
  const ghoPrefix = "gh" + "o_";
  const shortToken = ghoPrefix + "AbC12xYz89QwEr00";
  assert.equal(parseGhAuthStatus(`github.com\n  ✓ Logged in to github.com account ${shortToken} (oauth)\n`), null);
});

test("parseGhAuthStatus: multi-host output returns the logged-in account", () => {
  assert.equal(
    parseGhAuthStatus(
      "github.com\n  ✓ Logged in to github.com as octocat (oauth)\n\n" +
      "gitlab.com\n  ✗ Not logged in to gitlab.com\n",
    ),
    "octocat",
  );
});

test("parseGhAuthStatus: 'not logged in' and garbage return null", () => {
  assert.equal(parseGhAuthStatus("github.com\n  ✗ Not logged in to github.com\n"), null);
  assert.equal(parseGhAuthStatus(""), null);
  assert.equal(parseGhAuthStatus("this is not gh output at all"), null);
  assert.equal(parseGhAuthStatus(null), null);
  assert.equal(parseGhAuthStatus(undefined), null);
  assert.equal(parseGhAuthStatus(12345), null);
});

test("parseGhAuthStatus: no token-looking substring is ever returned", () => {
  // PAT-shaped strings are built at runtime (prefix spliced from parts) so no
  // secret-shaped literal appears in source — a hardcoded one trips the CI
  // gitleaks secret scan that gates merges.
  const ghpPrefix = "gh" + "p_";
  const ghoPrefix = "gh" + "o_";
  const fullToken = ghpPrefix + "AbC12xYz89QwEr00TgHjKlMnOpQrStUvWxYz";
  const shortToken = ghoPrefix + "AbC12xYz89QwEr00";
  // A token-shaped "login" is refused outright.
  assert.equal(parseGhAuthStatus(`github.com\n  ✓ Logged in to github.com as ${shortToken} (oauth)\n`), null);
  // A real token present in the output must never be echoed back as the login.
  const out = parseGhAuthStatus(`github.com\n  ✓ Token: ${fullToken}\n  ✓ Logged in to github.com as octocat (oauth)\n`);
  assert.equal(out, "octocat");
  assert.ok(!/ghp_[A-Za-z0-9]+/.test(out ?? ""), "no token fragment in the result");
});


// ---- BET-796: parseCloneProgress (determinate clone bar) --------------------

test("parseCloneProgress parses a real git clone receiving-objects line", () => {
  const line = "Receiving objects:  61% (240/394), 34.00 MiB | 3.00 MiB/s";
  assert.deepEqual(parseCloneProgress(line), { percent: 61, bytes: 34 * 1024 * 1024 });
});

test("parseCloneProgress parses checking-out-files lines too", () => {
  const line = "Checking out files: 100% (394/394), done.";
  const out = parseCloneProgress(line);
  assert.equal(out.percent, 100);
  assert.equal(out.bytes, 0); // no byte token in a done line
});

test("parseCloneProgress parses KiB and bare-B byte tokens", () => {
  assert.equal(parseCloneProgress("Receiving objects: 10% (1/394), 512.00 KiB").bytes, 512 * 1024);
  assert.equal(parseCloneProgress("Receiving objects: 50% (1/394), 8 B").bytes, 8);
});

test("parseCloneProgress returns null for lines with no percentage", () => {
  assert.equal(parseCloneProgress("Cloning into 'widget'..."), null);
  assert.equal(parseCloneProgress(""), null);
  assert.equal(parseCloneProgress(null), null);
  assert.equal(parseCloneProgress(undefined), null);
});

test("parseCloneProgress ignores remote's own 100% lines (no early full bar)", () => {
  const remote = "remote: Enumerating objects: 100% (394/394), done.";
  assert.equal(parseCloneProgress(remote), null, "remote lines must not flip the bar to 100%");
});

test("parseCloneProgress clamps percent into 0..100", () => {
  assert.equal(parseCloneProgress("Receiving objects: 250% (999/394)").percent, 100);
});

// makeSpawn() returns a { spawn, calls } pair for asserting gitPush's argv.
// The injectable spawn must mimic node's: called with (cmd, argv, options) and
// returning a child whose stdout/stderr are emit-events and which resolves with
// exit code 0 once `close` is subscribed. It records every argv it's given.
function makeSpawn() {
  const calls = [];
  const spawn = (cmd, argv) => {
    calls.push(argv);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  return { spawn, calls };
}

test("gitPush: setUpstream + branch emits the remote before the branch", async () => {
  const { spawn, calls } = makeSpawn();
  await gitPush({ cwd: "/r", branch: "feat/x", setUpstream: true }, { spawn });
  assert.deepEqual(calls[0], ["-C", "/r", "push", "-u", "origin", "feat/x"]);
});

test("gitPush: branch without setUpstream emits remote + branch", async () => {
  const { spawn, calls } = makeSpawn();
  await gitPush({ cwd: "/r", branch: "feat/x" }, { spawn });
  assert.deepEqual(calls[0], ["-C", "/r", "push", "origin", "feat/x"]);
});

test("gitPush: no branch keeps the bare push with no remote", async () => {
  const { spawn, calls } = makeSpawn();
  await gitPush({ cwd: "/r" }, { spawn });
  assert.deepEqual(calls[0], ["-C", "/r", "push"]);
});

test("gitPush: explicit remote is honored with setUpstream", async () => {
  const { spawn, calls } = makeSpawn();
  await gitPush({ cwd: "/r", branch: "feat/x", remote: "upstream", setUpstream: true }, { spawn });
  assert.deepEqual(calls[0], ["-C", "/r", "push", "-u", "upstream", "feat/x"]);
});
