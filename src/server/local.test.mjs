import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsListDirs, parseWorktrees, shouldSkipDir, dedupeRepoHits, sortRepoHits, parseGhAuthStatus, parseCloneProgress, gitPush, gitClone } from "./local.mjs";

test("parseWorktrees parses `git worktree list --porcelain`", () => {
  const out = parseWorktrees(
    "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
    "worktree /repo/wt\nHEAD def456\ndetached\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "/repo");
  assert.equal(out[0].branch, "main");
  assert.equal(out[1].detached, true);
});

// ---- BET-1072: fsListDirs returns an absolute-path DirListing --------------
//
// fsListDirs takes a DIRECTORY to list (no parent/prefix split, no cap) and
// returns `{ dir, entries: [...] }` with absolute paths only — a leading `~`
// is expanded into `dir`, and no tilde survives past the box's edge. Dot
// directories are present (flag `hidden:true`) for the renderer to filter.

test("fsListDirs: tilde input returns absolute paths and an absolute dir", async () => {
  const home = process.env.HOME;
  assert.ok(home, "HOME is set");
  const out = await fsListDirs("~");
  // The resolved `dir` is the expanded home directory (absolute).
  assert.ok(out.dir.startsWith("/"), `dir is absolute: ${out.dir}`);
  assert.ok(out.entries.every((e) => e.path.startsWith("/")),
    `all entry paths absolute: ${JSON.stringify(out.entries)}`);
  // A sibling created in HOME appears as an absolute path, not a tilde form.
  const root = await mkdtemp(join(home, "fslist-abs-home-"));
  try {
    const listed = await fsListDirs(home);
    assert.ok(listed.entries.some((e) => e.path === root),
      `home listing includes the absolute sibling ${root}: ${JSON.stringify(listed.entries.map((e) => e.path))}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: absolute input returns absolute paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-abs-root-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  await writeFile(join(root, "not-a-dir.txt"), "skip");
  try {
    const out = await fsListDirs(root);
    assert.equal(out.dir, root);
    const names = out.entries.map((e) => e.name);
    assert.ok(names.includes("alpha"), `alpha present: ${JSON.stringify(out.entries)}`);
    assert.ok(names.includes("beta"), `beta present: ${JSON.stringify(out.entries)}`);
    assert.ok(!names.includes("not-a-dir.txt"), "files are filtered out");
    assert.ok(out.entries.every((e) => e.path.startsWith("/")),
      "all results absolute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: >20 subdirectories returns ALL of them (no cap)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-cap-"));
  try {
    for (let i = 0; i < 30; i++) {
      await mkdir(join(root, `d${String(i).padStart(2, "0")}`), { recursive: true });
    }
    const out = await fsListDirs(root);
    assert.equal(out.entries.length, 30, `all 30 returned, got ${out.entries.length}`);
    // Dot-directories are present with hidden:true (case d, asserted here too).
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: dot-directories are present with hidden:true", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-dot-"));
  await mkdir(join(root, ".config"), { recursive: true });
  await mkdir(join(root, "visible"), { recursive: true });
  try {
    const out = await fsListDirs(root);
    const dot = out.entries.find((e) => e.name === ".config");
    assert.ok(dot, `.config present: ${JSON.stringify(out.entries)}`);
    assert.equal(dot.hidden, true);
    assert.equal(out.entries.find((e) => e.name === "visible").hidden, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: a symlink pointing at a directory appears in entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "fslist-link-"));
  try {
    await mkdir(join(root, "target"), { recursive: true });
    await symlink(join(root, "target"), join(root, "link"));
    await symlink(join(root, "missing"), join(root, "broke"));
    const out = await fsListDirs(root);
    const names = out.entries.map((e) => e.name);
    assert.ok(names.includes("link"), `dir symlink present: ${JSON.stringify(names)}`);
    assert.ok(!names.includes("broke"), "broken symlink not a directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fsListDirs: a missing directory returns { dir, entries: [] } without throwing", async () => {
  const missing = join(tmpdir(), "does-not-exist-" + Date.now());
  const out = await fsListDirs(missing);
  assert.equal(out.dir, missing);
  assert.deepEqual(out.entries, []);
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

test("gitClone: token emits -c BEFORE clone with an HTTP Basic x-access-token header", async () => {
  const { spawn, calls } = makeSpawn();
  await gitClone({ url: "https://github.com/acme/private.git", dest: "/d", token: "tok_123" }, { spawn });
  const argv = calls[0];
  const cIdx = argv.indexOf("-c");
  const cloneIdx = argv.indexOf("clone");
  assert.ok(cIdx !== -1 && cloneIdx !== -1, "both -c and clone are present");
  assert.ok(cIdx < cloneIdx, "-c must precede clone so the credential is not persisted");
  const header = argv[cIdx + 1];
  assert.ok(header.startsWith("http.extraheader=Authorization: Basic "), "header uses HTTP Basic");
  const b64 = header.slice("http.extraheader=Authorization: Basic ".length);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "x-access-token:tok_123");
});

test("gitClone: no token emits no -c argument at all", async () => {
  const { spawn, calls } = makeSpawn();
  await gitClone({ url: "https://github.com/acme/public.git" }, { spawn });
  assert.ok(!calls[0].includes("-c"), "public clone emits no extraheader");
  assert.deepEqual(calls[0], ["-C", "/", "clone", "--progress", "https://github.com/acme/public.git"]);
});
