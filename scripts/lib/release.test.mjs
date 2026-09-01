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
 * Assert no `.new` staging directory survived under `root`. The swap stages
 * each path as `<dest>/<rel>.new` and `mv`s it into place, so a leftover means
 * the swap tore rather than completed — asserted by both the success path and
 * every refuse-before-mutating path.
 */
function assertNoStagingDirs(root) {
  for (const rel of allPaths(root)) {
    assert.ok(!rel.endsWith(".new"), `staging dir survived: ${rel}`);
    assert.ok(!rel.includes(".new/"), `staging dir survived: ${rel}`);
  }
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
    assertNoStagingDirs(dest);
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

// A package whose payload owns exactly ONE path: `runtime`. Keeps the low-disk
// / copy-failure cases deterministic — the first (and only) staged copy is
// always `runtime`, so assertions on `/copy failed for runtime/` are stable.
function makeRuntimeOnlyPkg() {
  const pkg = mkdtempSync(join(tmpdir(), "manta-rel-pkg-"));
  writeFileSync(
    join(pkg, "RELEASE.json"),
    JSON.stringify({ name: "manta", version: "2.0.0", includes: ["runtime"] }),
  );
  writeTree(pkg, { "runtime/node/bin/node": "new node binary" });
  return pkg;
}

test("replace_release_payload: copy failure carries the underlying reason", () => {
  // The regression: the swap used to die with only "<rel> copy failed" — the
  // actionable half ("No space left on device") lived on the cp stderr line
  // BEFORE the die line, which the caller surfaces last and therefore threw
  // away. Folding cp_err into the die message fixes diagnosability.
  const pkg = makeRuntimeOnlyPkg();
  const dest = makeInstalledDest();
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const r = sourceAndRun(`
      cp() { echo "cp: cannot create regular file: No space left on device" >&2; return 1; }
      replace_release_payload '${pkg}' '${dest}' '${NODE_CMD}'
    `);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /copy failed for runtime: /);
    assert.match(r.stdout, /No space left on device/);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("replace_release_payload: preflight refuses when disk is short, mutating nothing", () => {
  // available (1000 KB) < needed (500000 KB) → refuse before ANY staged copy.
  // The "nothing was mutated" half is the point: not a .new dir, not a
  // touched original.
  const pkg = makeRuntimeOnlyPkg();
  const dest = makeInstalledDest();
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  const before = JSON.stringify(readTree(dest));
  try {
    const r = sourceAndRun(`
      du() { echo "500000 $2"; }
      df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 100 1000 99%% /\\n'; }
      replace_release_payload '${pkg}' '${dest}' '${NODE_CMD}'
    `);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not enough disk space/);
    const after = readTree(dest);
    assert.equal(JSON.stringify(after), before, "dest must be untouched when refused");
    assertNoStagingDirs(dest);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("replace_release_payload: preflight stays out of the way when a probe fails", () => {
  // du returning 1 (no `du`, unusual mount) must NOT become a new way for a
  // healthy update to fail: require_free_space is non-fatal and the swap
  // proceeds exactly as it does today.
  const pkg = makeRuntimeOnlyPkg();
  const dest = makeInstalledDest();
  writeTree(dest, { "runtime/node/bin/node": "old node binary" });
  try {
    const r = sourceAndRun(`
      du() { return 1; }
      replace_release_payload '${pkg}' '${dest}' '${NODE_CMD}'
    `);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(readTree(dest)["runtime/node/bin/node"], "new node binary");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
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

// --- detect_install_kind: packaged-vs-git routing ------------------------------
//
// RELEASE.json (true for every install.sh box) MUST win over .git/, because
// install.sh git-inits the dir it creates — so .git alone does NOT mean "dev
// checkout". If .git were checked first (the pre-fix bug), every install.sh
// box would route to the on-box `npm ci` path and brick on a toolchain-less
// box. Only a checkout with no RELEASE.json is a real dev box.

function detectKind(hasReleaseJson, hasGit) {
  const script = `
    log() { :; }; ok() { :; }; warn() { :; }; die() { echo "$*" >&2; exit 1; }
    . "${RELEASE_LIB}"
    detect_install_kind "$1" "$2"
  `;
  const out = execFileSync(
    "bash",
    ["-c", script, "bash", String(hasReleaseJson), String(hasGit)],
    { encoding: "utf-8" },
  );
  return out.trim();
}

test("detect_install_kind: an install.sh box (RELEASE.json + .git) is packaged, not git", () => {
  // The regression: install.sh boxes carry BOTH a RELEASE.json stamp AND an
  // incidental .git/ (install.sh git-inits the dir). RELEASE.json must win.
  assert.equal(detectKind(1, 1), "packaged");
});

test("detect_install_kind: a dev clone (no RELEASE.json, has .git) stays git", () => {
  assert.equal(detectKind(0, 1), "git");
});

test("detect_install_kind: a bare extracted tarball (RELEASE.json only) is packaged", () => {
  assert.equal(detectKind(1, 0), "packaged");
});

test("detect_install_kind: neither → none", () => {
  assert.equal(detectKind(0, 0), "none");
});

// --- should_skip_self_update: the early-exit decision -------------------------
//
// The updater's early exit must skip the whole update ONLY when the box is
// current AND no CLI changed. If a CLI changed, the box must keep going so its
// restart step runs — otherwise a CLI-only upgrade is swallowed by the cheap
// exit and the new binary never gets restarted. `clis_changed` is a flag the
// caller derives from the upgrade-clis state file: 1 when ANY changed CLI is
// listed (opencode is now just one row of the catalog). This is the full 2x2
// (box-current x clis-changed) matrix.

function shouldSkip(installedVersion, installedSha, releaseVersion, releaseSha, clisChanged) {
  const script = `
    log() { :; }; ok() { :; }; warn() { :; }; die() { echo "$*" >&2; exit 1; }
    . "${RELEASE_LIB}"
    if should_skip_self_update "$1" "$2" "$3" "$4" "$5"; then echo skip; else echo prog; fi
  `;
  const out = execFileSync(
    "bash",
    ["-c", script, "bash", installedVersion, installedSha, releaseVersion, releaseSha, clisChanged],
    { encoding: "utf-8" },
  );
  return out.trim() === "skip";
}

test("should_skip_self_update: box current + no CLI changed → skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.29", "abc123", "0"), true);
});

test("should_skip_self_update: box current + a CLI CHANGED → do NOT skip", () => {
  // A CLI-only upgrade on an already-current box must fall through to the
  // restart — this is the whole reason the early exit is now conditional.
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.29", "abc123", "1"), false);
});

test("should_skip_self_update: box stale + no CLI changed → do NOT skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.30", "def456", "0"), false);
});

test("should_skip_self_update: box stale + a CLI changed → do NOT skip", () => {
  assert.equal(shouldSkip("0.0.29", "abc123", "0.0.30", "def456", "1"), false);
});

// --- KillMode policy (BET-1192): the systemd unit patch -----------------------
//
// The systemd default KillMode=control-group SIGTERMs every process in the
// service's cgroup on stop/restart, and manta-server's tmux + pane shells live
// in that cgroup — so every restart destroyed every session. The fix narrows
// the kill to the main process with KillMode=process. `ensure_kill_policy_text`
// is the pure text transform (unit-tested directly); `ensure_server_kill_policy`
// patches the INSTALLED unit in place and daemon-reloads. The patcher must be
// idempotent and NEVER override an operator's explicit KillMode= line.

// The shipped systemd template — used by the drift guard below. The test file
// lives in scripts/lib/, so the template is one dir up under scripts/systemd/.
const MANTA_SERVICE_TEMPLATE = join(__dirname, "../systemd/manta-server.service");

const SERVICE_TEXT = `[Unit]
Description=manta box server
[Service]
Type=simple
Restart=on-failure
[Install]
WantedBy=default.target
`;

/** Source release.sh and echo the result of ensure_kill_policy_text "$KILL_TEXT". */
function killPolicyText(text) {
  // Pass the text via an env var (not argv) so arbitrary content survives
  // shell quoting; the function echoes the (possibly transformed) text.
  return execFileSync(
    "bash",
    ["-c", `log(){ :;}; ok(){ :;}; warn(){ :;}; die(){ echo "$*" >&2; exit 1; }\n. '${RELEASE_LIB}'\nensure_kill_policy_text "$KILL_TEXT"`],
    { env: { ...process.env, KILL_TEXT: text }, encoding: "utf-8" },
  );
}

test("ensure_kill_policy_text: text with no KillMode gains ONE KillMode=process right after [Service]", () => {
  const out = killPolicyText(SERVICE_TEXT);
  assert.equal(out, `[Unit]\nDescription=manta box server\n[Service]\nKillMode=process\nType=simple\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`);
  assert.equal((out.match(/^KillMode=process$/gm) ?? []).length, 1, "exactly one KillMode=process");
});

test("ensure_kill_policy_text: already containing KillMode=process comes back byte-identical", () => {
  const text = `[Service]\nKillMode=process\nRestart=on-failure\n`;
  assert.equal(killPolicyText(text), text);
});

test("ensure_kill_policy_text: containing KillMode=mixed is never overridden", () => {
  const text = `[Service]\nKillMode=mixed\nRestart=on-failure\n`;
  assert.equal(killPolicyText(text), text);
});

test("ensure_kill_policy_text: applying twice equals applying once (idempotent)", () => {
  const once = killPolicyText(SERVICE_TEXT);
  assert.equal(killPolicyText(once), once);
});

test("ensure_kill_policy_text: a unit with no [Service] section is left unchanged", () => {
  const text = `[Unit]\nDescription=no service section\n`;
  assert.equal(killPolicyText(text), text);
});

/**
 * Run a unit-patching helper with `systemctl` stubbed on PATH to a recorder,
 * so a test can assert whether daemon-reload actually ran — both patchers must
 * reload ONLY when they really wrote. `build(tmpDir)` returns the shell line to
 * run (it gets the temp dir so it can place extra fixture paths there).
 * Returns { status, stdout, reloaded }.
 */
function runUnitPatcher(build) {
  const dir = mkdtempSync(join(tmpdir(), "manta-unit-patch-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const calls = join(dir, "systemctl.calls");
  writeFileSync(
    join(binDir, "systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,
    { mode: 0o755 },
  );
  const r = sourceAndRun(build(dir), { preamble: `export PATH='${binDir}':"$PATH"` });
  const reloaded = existsSync(calls)
    && readFileSync(calls, "utf8").split("\n").some((l) => l.includes("daemon-reload"));
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, reloaded };
}

function runServerKillPolicy(unitPath) {
  return runUnitPatcher(() => `ensure_server_kill_policy '${unitPath}'`);
}

test("ensure_server_kill_policy: a missing unit path returns 0 and creates nothing", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "manta-kill-missing-")), "nope.service");
  const r = runServerKillPolicy(missing);
  assert.equal(r.status, 0);
  assert.equal(existsSync(missing), false, "must not create the unit");
  assert.equal(r.reloaded, false, "must not daemon-reload for a missing unit");
});

test("ensure_server_kill_policy: patches a unit that lacks KillMode and daemon-reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-kill-"));
  const unitPath = join(dir, "manta-server.service");
  writeFileSync(unitPath, SERVICE_TEXT);
  try {
    const r = runServerKillPolicy(unitPath);
    assert.equal(r.status, 0);
    assert.match(readFileSync(unitPath, "utf8"), /^KillMode=process$/m);
    assert.equal(r.reloaded, true, "a changed unit must trigger daemon-reload");
    assert.match(r.stdout, /patched with KillMode=process/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure_server_kill_policy: an already-patched unit is not rewritten and not daemon-reloaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-kill-"));
  const unitPath = join(dir, "manta-server.service");
  const text = `[Service]\nKillMode=process\nRestart=on-failure\n`;
  writeFileSync(unitPath, text);
  try {
    const r = runServerKillPolicy(unitPath);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(unitPath, "utf8"), text, "file must be byte-identical");
    assert.equal(r.reloaded, false, "no-op patch must not daemon-reload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift guard: the shipped systemd template is already unchanged by ensure_kill_policy_text", () => {
  const template = readFileSync(MANTA_SERVICE_TEMPLATE, "utf8");
  assert.equal(killPolicyText(template), template);
});

// --- Claimed Claude Code version (BET-1503) ----------------------------------
//
// opencode reaches Anthropic through a plugin that authenticates AS Claude Code
// and sends a hardcoded, badly-lagging version. Anthropic refuses a request
// whose claim is below the floor for the model asked for, so a stale claim
// makes a model the user is entitled to unusable. The box therefore sets
// ANTHROPIC_CLI_VERSION on the opencode service, DERIVED from the real `claude`
// CLI (which self-update already keeps current) so the claim tracks the CLI
// rather than a constant needing a release each time Anthropic moves the floor.

// Ask release.sh for the floor rather than restating it, so raising it there
// does not turn these tests red for no reason.
const FLOOR = sourceAndRun("manta_claude_cli_version_floor").stdout.trim();

/** Source release.sh and echo `version_gte a b` as "yes"/"no". */
function versionGte(a, b) {
  const r = sourceAndRun(`if version_gte '${a}' '${b}'; then echo yes; else echo no; fi`);
  return r.stdout.trim();
}

test("version_gte: equal versions compare as >=", () => {
  assert.equal(versionGte("2.1.257", "2.1.257"), "yes");
});

test("version_gte: a higher patch component wins", () => {
  assert.equal(versionGte("2.1.258", "2.1.257"), "yes");
  assert.equal(versionGte("2.1.185", "2.1.257"), "no");
});

test("version_gte: components compare numerically, not as strings", () => {
  // The whole point: "2.1.9" > "2.1.10" is true as strings and false as numbers.
  assert.equal(versionGte("2.1.10", "2.1.9"), "yes");
  assert.equal(versionGte("2.1.9", "2.1.10"), "no");
});

test("version_gte: a missing component reads as zero, so 2.2 >= 2.1.9", () => {
  assert.equal(versionGte("2.2", "2.1.9"), "yes");
  assert.equal(versionGte("2.1", "2.1.0"), "yes");
});

test("version_gte: unparseable junk reads as zero and never compares HIGH", () => {
  assert.equal(versionGte("banana", "2.1.257"), "no");
  assert.equal(versionGte("", "0.0.1"), "no");
});

/**
 * Source release.sh with a stubbed `claude` on PATH and echo
 * resolve_anthropic_cli_version. `output` null = no claude CLI at all.
 */
function resolveClaimedVersion(output) {
  const dir = mkdtempSync(join(tmpdir(), "manta-ccver-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (output !== null) {
    writeFileSync(join(binDir, "claude"), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
  }
  // PATH is REPLACED, not prepended: a real `claude` on the runner's PATH would
  // otherwise answer for the "no CLI installed" case and make it flaky.
  const r = sourceAndRun(`resolve_anthropic_cli_version`, {
    preamble: `export PATH='${binDir}':/usr/bin:/bin`,
  });
  rmSync(dir, { recursive: true, force: true });
  return r.stdout.trim();
}

test("resolve_anthropic_cli_version: uses the box's own claude CLI when it meets the floor", () => {
  assert.equal(resolveClaimedVersion("2.1.300 (Claude Code)"), "2.1.300");
});

test("resolve_anthropic_cli_version: falls back to the floor when the CLI is older", () => {
  // The exact case that broke fable 5.1: a claim below Anthropic's gate.
  assert.equal(resolveClaimedVersion("2.1.185 (Claude Code)"), FLOOR);
});

test("resolve_anthropic_cli_version: falls back to the floor when no claude CLI exists", () => {
  // install.sh no longer installs the CLI (the app does, lazily), so this is
  // the normal state of a freshly-installed box — it must still claim a
  // supported version.
  assert.equal(resolveClaimedVersion(null), FLOOR);
});

test("resolve_anthropic_cli_version: unrecognised CLI output falls back to the floor", () => {
  assert.equal(resolveClaimedVersion("who knows"), FLOOR);
});

/** Source release.sh and echo ensure_cli_version_text "$UNIT_TEXT" <version>. */
function cliVersionText(text, version) {
  return execFileSync(
    "bash",
    ["-c", `log(){ :;}; ok(){ :;}; warn(){ :;}; die(){ echo "$*" >&2; exit 1; }\n. '${RELEASE_LIB}'\nensure_cli_version_text "$UNIT_TEXT" '${version}'`],
    { env: { ...process.env, UNIT_TEXT: text }, encoding: "utf-8" },
  );
}

const OC_SERVICE_TEXT = `[Unit]
Description=opencode server
[Service]
Type=simple
Restart=on-failure
[Install]
WantedBy=default.target
`;

test("ensure_cli_version_text: a unit with no claim gains ONE right after [Service]", () => {
  const out = cliVersionText(OC_SERVICE_TEXT, "2.1.257");
  assert.match(out, /^\[Service\]\nEnvironment=ANTHROPIC_CLI_VERSION=2\.1\.257$/m);
  assert.equal((out.match(/^Environment=ANTHROPIC_CLI_VERSION=/gm) ?? []).length, 1);
});

test("ensure_cli_version_text: applying twice equals applying once (idempotent)", () => {
  const once = cliVersionText(OC_SERVICE_TEXT, "2.1.257");
  assert.equal(cliVersionText(once, "2.1.257"), once);
});

test("ensure_cli_version_text: a STALE claim is replaced in place, not duplicated", () => {
  const text = `[Service]\nEnvironment=ANTHROPIC_CLI_VERSION=2.1.185\nRestart=on-failure\n`;
  const out = cliVersionText(text, "2.1.257");
  assert.match(out, /^Environment=ANTHROPIC_CLI_VERSION=2\.1\.257$/m);
  assert.equal((out.match(/^Environment=ANTHROPIC_CLI_VERSION=/gm) ?? []).length, 1);
});

test("ensure_cli_version_text: a HIGHER existing claim is never downgraded", () => {
  // Monotonic on purpose: an operator (or a newer box) who set a higher value
  // must not have it walked back by an older floor.
  const text = `[Service]\nEnvironment=ANTHROPIC_CLI_VERSION=2.9.0\nRestart=on-failure\n`;
  assert.equal(cliVersionText(text, "2.1.257"), text);
});

test("ensure_cli_version_text: a unit with no [Service] section is left unchanged", () => {
  const text = `[Unit]\nDescription=no service section\n`;
  assert.equal(cliVersionText(text, "2.1.257"), text);
});

function runEnsureOpencodeCliVersion(unitPath, version) {
  // The plist argument points at a path that does not exist, so the macOS
  // branch is inert on a Linux runner and this stays a pure systemd test.
  return runUnitPatcher(
    (dir) => `ensure_opencode_cli_version '${version}' '${unitPath}' '${join(dir, "absent.plist")}'`,
  );
}

test("ensure_opencode_cli_version: a missing unit returns 0 and creates nothing", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "manta-ccver-missing-")), "nope.service");
  const r = runEnsureOpencodeCliVersion(missing, "2.1.257");
  assert.equal(r.status, 0);
  assert.equal(existsSync(missing), false, "must not create the unit");
  assert.equal(r.reloaded, false);
});

test("ensure_opencode_cli_version: patches an unclaimed unit and daemon-reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-ccver-"));
  const unitPath = join(dir, "opencode-serve.service");
  writeFileSync(unitPath, OC_SERVICE_TEXT);
  try {
    const r = runEnsureOpencodeCliVersion(unitPath, "2.1.257");
    assert.equal(r.status, 0);
    assert.match(readFileSync(unitPath, "utf8"), /^Environment=ANTHROPIC_CLI_VERSION=2\.1\.257$/m);
    assert.equal(r.reloaded, true, "a changed unit must be daemon-reloaded before the restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure_opencode_cli_version: upgrades the stale claim a hand-patched box already carries", () => {
  // The dev box was hand-patched before this shipped; an update must move it
  // forward rather than leave the manual edit frozen.
  const dir = mkdtempSync(join(tmpdir(), "manta-ccver-"));
  const unitPath = join(dir, "opencode-serve.service");
  writeFileSync(unitPath, `[Service]\nEnvironment=ANTHROPIC_CLI_VERSION=2.1.185\nRestart=on-failure\n`);
  try {
    const r = runEnsureOpencodeCliVersion(unitPath, "2.1.300");
    assert.equal(r.status, 0);
    assert.match(readFileSync(unitPath, "utf8"), /^Environment=ANTHROPIC_CLI_VERSION=2\.1\.300$/m);
    assert.equal(r.reloaded, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure_opencode_cli_version: an already-current unit is not rewritten and not reloaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "manta-ccver-"));
  const unitPath = join(dir, "opencode-serve.service");
  const text = `[Service]\nEnvironment=ANTHROPIC_CLI_VERSION=2.1.257\nRestart=on-failure\n`;
  writeFileSync(unitPath, text);
  try {
    const r = runEnsureOpencodeCliVersion(unitPath, "2.1.257");
    assert.equal(r.status, 0);
    assert.equal(readFileSync(unitPath, "utf8"), text, "file must be byte-identical");
    assert.equal(r.reloaded, false, "no-op patch must not daemon-reload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift guard: the shipped opencode template carries the placeholder, and install.sh substitutes it", () => {
  // The two halves of the fix must stay wired together: a template that lost
  // its placeholder, or an installer that stopped substituting one, would ship
  // a literal @@ANTHROPIC_CLI_VERSION@@ into a live unit.
  const tpl = readFileSync(join(__dirname, "../systemd/opencode-serve.service"), "utf8");
  assert.match(tpl, /^Environment=ANTHROPIC_CLI_VERSION=@@ANTHROPIC_CLI_VERSION@@$/m);
  const plist = readFileSync(join(__dirname, "../launchd/com.mantaui.opencode.plist"), "utf8");
  assert.match(plist, /<string>@@ANTHROPIC_CLI_VERSION@@<\/string>/);
  const installer = readFileSync(join(__dirname, "../install.sh"), "utf8");
  assert.match(installer, /--placeholder ANTHROPIC_CLI_VERSION="\$\(resolve_anthropic_cli_version\)"/);
  assert.match(installer, /s\|@@ANTHROPIC_CLI_VERSION@@\|\$\(resolve_anthropic_cli_version\)\|g/);
});
