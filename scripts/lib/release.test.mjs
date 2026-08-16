// release.test.mjs — node:test cases for scripts/lib/release.sh
//
// Exercises the REAL shell function `replace_release_payload` by sourcing
// scripts/lib/release.sh from a bash subprocess against temp directories.
// scripts/lib/release.sh is a functions-only library (it runs nothing at
// source time) and relies on the `log`/`ok`/`warn`/`die` helpers the CALLER
// owns, so each test defines trivial copies before sourcing it — the same
// contract install.sh / self-update.sh observe.
//
// This is the payload-swap used by packaged self-update: replace every path
// the INCOMING release owns, including the vendored Node `runtime/`, so a
// runtime version bump can actually reach an installed box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_LIB = join(__dirname, "release.sh");
const NODE_CMD = process.execPath; // the node running the test doubles as the box's node

function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

function readTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = p.slice(root.length + 1);
      const st = statSync(p);
      if (st.isDirectory()) {
        out[rel + "/"] = true; // marker so the tree entry exists
        walk(p);
      } else {
        out[rel] = readFileSync(p, "utf8");
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function allPaths(root) {
  const paths = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = p.slice(root.length + 1);
      paths.push(rel);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  if (existsSync(root)) walk(root);
  return paths;
}

/**
 * Source scripts/lib/release.sh (trivial log/ok/warn/die defined first), then
 * call `replace_release_payload <pkg> <dest> <node>`. Runs in a throwaway
 * bash subprocess. Returns { status, stdout }.
 */
function runReplace(pkg, dest) {
  return sourceAndRun(`replace_release_payload '${pkg}' '${dest}' '${NODE_CMD}'`);
}

/**
 * The one place a bash subprocess is built for these tests: define the
 * `log`/`ok`/`warn`/`die` helpers release.sh expects its CALLER to own, source
 * the library, then run `body`. `preamble` injects anything that must be set
 * before sourcing (PATH, seed variables). Returns { status, stdout } with
 * stderr folded in, so assertions can match on `die` output.
 */
function sourceAndRun(body, { preamble = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manta-release-"));
  const script = join(dir, "run.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set +e
log()  { printf 'log: %s\\n' "$*"; }
ok()   { printf 'ok: %s\\n' "$*"; }
warn() { printf 'warn: %s\\n' "$*" >&2; }
die()  { printf 'die: %s\\n' "$*" >&2; exit 1; }
${preamble}
source '${RELEASE_LIB}'
${body}
exit $?
`,
    { mode: 0o755 },
  );
  try {
    const stdout = execFileSync("bash", [script], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The canonical `includes` self-update.sh ships with today (pack.mjs INCLUDE
// + runtime). Not load-bearing on the function's behaviour — each test passes
// its own — just a realistic fixture.
const PKG_INCLUDES = ["src", "scripts", "docs/opencode-tools", "docs/opencode/skills", "package.json", "runtime"];

function makePkg(includes) {
  const pkg = mkdtempSync(join(tmpdir(), "manta-rel-pkg-"));
  writeFileSync(
    join(pkg, "RELEASE.json"),
    JSON.stringify(
      { name: "manta", version: "1.0.0", built_at: "2026-08-13T00:00:00.000Z", includes },
    ),
  );
  const tree = {
    "src/server/index.mjs": "new index",
    "scripts/self-update.sh": "new self-update",
    "docs/opencode-tools/peers.ts": "new peers",
    "docs/opencode/skills/manta-plan/prompt.md": "new prompt",
    "package.json": "new package",
    "runtime/node/bin/node": "new node binary",
  };
  writeTree(pkg, tree);
  return pkg;
}

// A dest that looks like an already-installed box: it has a pre-existing copy
// of every payload path with OLD contents, plus its OWN installed RELEASE.json
// whose `includes` reflects an older release (notably WITHOUT `runtime`).
function makeInstalledDest() {
  const dest = mkdtempSync(join(tmpdir(), "manta-rel-dest-"));
  writeFileSync(
    join(dest, "RELEASE.json"),
    JSON.stringify({
      name: "manta",
      version: "0.0.19",
      built_at: "2026-01-01T00:00:00.000Z",
      includes: ["src", "scripts", "docs/opencode-tools", "package.json"], // no runtime
    }),
  );
  writeTree(dest, {
    "src/server/index.mjs": "old index",
    "scripts/self-update.sh": "old self-update",
    "package.json": "old package",
  });
  return dest;
}

test("replace_release_payload replaces every included path, including runtime", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  // dest has no runtime yet — install it as content the update must overwrite
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    const tree = readTree(dest);
    assert.equal(tree["src/server/index.mjs"], "new index");
    assert.equal(tree["scripts/self-update.sh"], "new self-update");
    assert.equal(tree["package.json"], "new package");
    assert.equal(tree["runtime/node/bin/node"], "new node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("the list is read from the INCOMING RELEASE.json, not the installed one", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest(); // installed includes omits `runtime`
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    // dest's installed RELEASE.json didn't list runtime, but it must still be
    // replaced because the INCOMING release owns it.
    assert.equal(readTree(dest)["runtime/node/bin/node"], "new node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("dest/RELEASE.json is byte-identical to pkg/RELEASE.json (version stamp advanced)", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    assert.equal(
      readTree(dest)["RELEASE.json"],
      readTree(pkg)["RELEASE.json"],
    );
    assert.equal(readTree(dest)["RELEASE.json"], readFileSync(join(pkg, "RELEASE.json"), "utf8"));
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("a path in includes but missing from pkg exits non-zero, leaving dest's copy untouched", () => {
  const pkg = mkdtempSync(join(tmpdir(), "manta-rel-pkg-"));
  // includes CLAIM runtime, but the tarball is missing it (torn/corrupt pkg)
  writeFileSync(
    join(pkg, "RELEASE.json"),
    JSON.stringify({ name: "manta", version: "2.0.0", includes: ["runtime"] }),
  );
  const dest = makeInstalledDest();
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const { status, stdout } = runReplace(pkg, dest);
    assert.notEqual(status, 0);
    assert.match(stdout, /tarball is missing/);
    // dest's existing copy of the missing path is untouched
    assert.equal(readTree(dest)["runtime/node/bin/node"], "old node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("no *.new staging directories survive a successful run", () => {
  const pkg = makePkg(PKG_INCLUDES);
  const dest = makeInstalledDest();
  try {
    const { status } = runReplace(pkg, dest);
    assert.equal(status, 0);
    for (const rel of allPaths(dest)) {
      assert.ok(!rel.endsWith(".new"), `staging dir survived: ${rel}`);
      assert.ok(!rel.includes(".new/"), `staging dir survived: ${rel}`);
    }
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

// --- install_prod_deps (BET-829) --------------------------------------------
//
// The old update step was a bare `npm ci --omit=dev`, which DELETES
// node_modules before installing. Every failure mode therefore left the box
// without a loadable node-pty — a manta-server that cannot start. These cases
// pin the two properties that make it survivable: prefer the prebuilt tree the
// release payload already carries, and never destroy a working tree on failure.

/**
 * Source release.sh and call `install_prod_deps <dest>` with a stubbed `npm`
 * on PATH whose exit status the test chooses, so no real install ever runs.
 * `replaced` seeds REPLACED_NODE_MODULES the way replace_release_payload would.
 */
function runInstallDeps(dest, { npmExit = 0, replaced = 0, npmOnPath = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manta-deps-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  // Hermetic PATH: the ONLY entry is binDir, so `npmOnPath:false` really means
  // npm is unreachable (this box has a system /usr/bin/npm that would
  // otherwise satisfy the lookup and void the test). The coreutils the
  // function genuinely needs are symlinked in explicitly.
  for (const cmd of ["rm", "mv", "mkdir"]) {
    const src = ["/bin/", "/usr/bin/"].map((p) => p + cmd).find((p) => existsSync(p));
    if (src) symlinkSync(src, join(binDir, cmd));
  }
  if (npmOnPath) {
    // A fake npm that mimics the destructive part of `npm ci`: it wipes the
    // target node_modules FIRST, then exits with the status under test. If the
    // function did not set the tree aside beforehand, a non-zero exit leaves
    // nothing behind — which is exactly the brick we are testing against.
    writeFileSync(
      join(binDir, "npm"),
      `#!/bin/sh\nrm -rf '${dest}/node_modules'\nmkdir -p '${dest}/node_modules'\necho fresh > '${dest}/node_modules/INSTALLED'\nexit ${npmExit}\n`,
      { mode: 0o755 },
    );
  }
  try {
    return sourceAndRun(`install_prod_deps '${dest}'`, {
      preamble: `export PATH='${binDir}'\nREPLACED_NODE_MODULES=${replaced}`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("install_prod_deps: skips npm entirely when the payload already supplied node_modules", () => {
  const dest = mkdtempSync(join(tmpdir(), "manta-dest-"));
  writeTree(dest, { "node_modules/from-payload.txt": "prebuilt" });
  // npm is absent from PATH: if the function tried to run it, this would fail.
  const r = runInstallDeps(dest, { replaced: 1, npmOnPath: false });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /came from the release payload/);
  assert.equal(
    readFileSync(join(dest, "node_modules/from-payload.txt"), "utf8"),
    "prebuilt",
    "the payload tree must be left exactly as swapped in",
  );
  rmSync(dest, { recursive: true, force: true });
});

test("install_prod_deps: runs npm ci when there is no payload tree (git checkout)", () => {
  const dest = mkdtempSync(join(tmpdir(), "manta-dest-"));
  writeTree(dest, { "node_modules/old.txt": "stale" });
  const r = runInstallDeps(dest, { replaced: 0, npmExit: 0 });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(existsSync(join(dest, "node_modules/INSTALLED")), "npm ci should have installed");
  assert.ok(
    !existsSync(join(dest, "node_modules.prev")),
    "the set-aside copy must be cleaned up on success",
  );
  rmSync(dest, { recursive: true, force: true });
});

test("install_prod_deps: RESTORES the previous node_modules when npm ci fails (the brick case)", () => {
  const dest = mkdtempSync(join(tmpdir(), "manta-dest-"));
  writeTree(dest, { "node_modules/node-pty/pty.node": "working-binding" });
  const r = runInstallDeps(dest, { replaced: 0, npmExit: 1 });
  assert.equal(r.status, 1, "a failed dependency install must still fail the update");
  assert.equal(
    readFileSync(join(dest, "node_modules/node-pty/pty.node"), "utf8"),
    "working-binding",
    "the working tree must be restored so the box still starts — this is the whole point",
  );
  assert.ok(!existsSync(join(dest, "node_modules.prev")), "no leftover set-aside directory");
  assert.match(r.stdout, /restoring the previous node_modules/);
  rmSync(dest, { recursive: true, force: true });
});

test("install_prod_deps: fails with actionable guidance when npm is not on PATH", () => {
  const dest = mkdtempSync(join(tmpdir(), "manta-dest-"));
  writeTree(dest, { "node_modules/keep.txt": "keep" });
  const r = runInstallDeps(dest, { replaced: 0, npmOnPath: false });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /npm not found on PATH/);
  assert.equal(
    readFileSync(join(dest, "node_modules/keep.txt"), "utf8"),
    "keep",
    "bailing early must not have touched the existing tree",
  );
  rmSync(dest, { recursive: true, force: true });
});

test("replace_release_payload: signals when it swapped node_modules from the payload", () => {
  const pkg = mkdtempSync(join(tmpdir(), "manta-pkg-"));
  const dest = mkdtempSync(join(tmpdir(), "manta-dest-"));
  writeTree(pkg, {
    "RELEASE.json": JSON.stringify({ version: "9.9.9", includes: ["src", "node_modules"] }),
    "src/server/index.mjs": "new",
    "node_modules/node-pty/pty.node": "prebuilt-verified",
  });
  writeTree(dest, {
    "RELEASE.json": JSON.stringify({ version: "0.0.1", includes: ["src"] }),
    "src/server/index.mjs": "old",
    "node_modules/node-pty/pty.node": "stale",
  });
  const r = runReplace(pkg, dest);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(
    readFileSync(join(dest, "node_modules/node-pty/pty.node"), "utf8"),
    "prebuilt-verified",
    "node_modules must be swapped from the payload when the release owns it",
  );
  rmSync(pkg, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

// --- release_is_current: the updater's skip decision ------------------------
//
// The regression this pins: the check used to compare `version` only, so a
// release cut without bumping package.json looked identical to the installed
// build. Every box reported "already at <version>" and skipped a real update
// — silently, with no error to notice. Identity is now the build's commit.

function isCurrent(installedVersion, installedSha, releaseVersion, releaseSha) {
  const script = `
    log() { :; }; ok() { :; }; warn() { :; }; die() { echo "$*" >&2; exit 1; }
    . "${RELEASE_LIB}"
    if release_is_current "$1" "$2" "$3" "$4"; then echo current; else echo stale; fi
  `;
  const out = execFileSync(
    "bash",
    ["-c", script, "bash", installedVersion, installedSha, releaseVersion, releaseSha],
    { encoding: "utf-8" },
  );
  return out.trim() === "current";
}

test("release_is_current: same commit → skip, even when both sides share a version", () => {
  assert.equal(isCurrent("0.0.29", "abc123", "0.0.29", "abc123"), true);
});

test("release_is_current: different commit at the SAME version → update (the regression)", () => {
  // This is the exact case that shipped nothing: package.json was never
  // bumped, so a real code change published as 0.0.29 over an installed
  // 0.0.29 was skipped by every box.
  assert.equal(isCurrent("0.0.29", "abc123", "0.0.29", "def456"), false);
});

test("release_is_current: different commit at a different version → update", () => {
  assert.equal(isCurrent("0.0.29", "abc123", "0.0.30", "def456"), false);
});

test("release_is_current: no commit on either side falls back to comparing versions", () => {
  assert.equal(isCurrent("0.0.29", "", "0.0.29", ""), true);
  assert.equal(isCurrent("0.0.29", "", "0.0.30", ""), false);
});

test("release_is_current: a box predating commit stamps still updates normally", () => {
  // Installed RELEASE.json has no git_sha; the published release does. Falls
  // back to versions rather than treating "" as a mismatch, which would make
  // the box reinstall the same tarball on every check.
  assert.equal(isCurrent("0.0.29", "", "0.0.29", "def456"), true);
  assert.equal(isCurrent("0.0.29", "", "0.0.30", "def456"), false);
});

test("release_is_current: a release packed outside a checkout falls back to versions", () => {
  assert.equal(isCurrent("0.0.29", "abc123", "0.0.29", ""), true);
  assert.equal(isCurrent("0.0.29", "abc123", "0.0.30", ""), false);
});

test("release_is_current: an unreadable installed stamp is never 'current'", () => {
  // Skipping forever on a corrupt RELEASE.json would strand the box; letting
  // it reinstall repairs it.
  assert.equal(isCurrent("", "", "0.0.29", ""), false);
  assert.equal(isCurrent("", "", "0.0.29", "def456"), false);
});

// --- should_skip_self_update: the BET-1016 early-exit decision ------------------
//
// The updater's early exit must skip the whole update ONLY when the box is
// current AND opencode is unchanged. If opencode changed, the box must keep
// going so its restart step runs — otherwise an opencode-only upgrade is
// swallowed by the cheap exit and the new binary never gets restarted. This is
// the full 2x2 (box-current x opencode-changed) matrix.

function shouldSkip(installedVersion, installedSha, releaseVersion, releaseSha, opencodeChanged) {
  const script = `
    log() { :; }; ok() { :; }; warn() { :; }; die() { echo "$*" >&2; exit 1; }
    . "${RELEASE_LIB}"
    if should_skip_self_update "$1" "$2" "$3" "$4" "$5"; then echo skip; else echo prog; fi
  `;
  const out = execFileSync(
    "bash",
    ["-c", script, "bash", installedVersion, installedSha, releaseVersion, releaseSha, opencodeChanged],
    { encoding: "utf-8" },
  );
  return out.trim() === "skip";
}

test("should_skip_self_update: box current + opencode unchanged → skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.29", "abc123", "0"), true);
});

test("should_skip_self_update: box current + opencode CHANGED → do NOT skip", () => {
  // An opencode-only upgrade on an already-current box must fall through to the
  // restart — this is the whole reason the early exit is now conditional.
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.29", "abc123", "1"), false);
});

test("should_skip_self_update: box stale + opencode unchanged → do NOT skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.30", "def456", "0"), false);
});

test("should_skip_self_update: box stale + opencode changed → do NOT skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.30", "def456", "1"), false);
});
