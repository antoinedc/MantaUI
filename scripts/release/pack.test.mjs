// pack.test.mjs — node:test cases for scripts/release/pack.mjs
//
// Covers the resolveArch mapping (the single source of truth that ties the
// `--arch` flag to the nodejs.org tarball filename token and the manifest
// arch key). The rest of pack.mjs is impure (it downloads the vendored Node
// from nodejs.org and shells out to tar / npm) and is covered end-to-end by
// the deploy workflow's `pack` job on a native runner, not by unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

// pack.mjs is a CLI script that calls main() unconditionally at the bottom
// (which would try to read package.json / network). We side-step that by
// importing the file in a fresh context: since the module body is at top
// level and the only side-effecting import is `readFile`, the import itself
// is cheap — but `main()` runs on import and would fail in this harness.
// Trick: spawn a sub-node that runs the script with --arch foo, and capture
// the die() message — that's the test surface for the unknown-arch branch.
//
// The happy-path cases used to re-declare resolveArch's mapping inline, which
// meant the assertions could keep passing after pack.mjs changed. They now run
// the REAL function, lifted out of the source by `evalFunctionDecl` (defined
// with the git-commit cases below — a function declaration, so hoisted). Pure
// 1:1 lookup with no dependencies, so it needs no injected scope.
function resolveArch(arch) {
  return evalFunctionDecl("resolveArch")(arch);
}

test("resolveArch(\"x64\") returns linux_x64 / linux-x64", () => {
  assert.deepEqual(resolveArch("x64"), { key: "linux_x64", file: "linux-x64" });
});

test("resolveArch(\"arm64\") returns linux_arm64 / linux-arm64", () => {
  assert.deepEqual(resolveArch("arm64"), { key: "linux_arm64", file: "linux-arm64" });
});

test("resolveArch(\"darwin-arm64\") returns darwin_arm64 / darwin-arm64", () => {
  assert.deepEqual(resolveArch("darwin-arm64"), { key: "darwin_arm64", file: "darwin-arm64" });
});

test("resolveArch throws on an unknown arch", () => {
  assert.throws(() => resolveArch("x86_64"), /unsupported --arch/);
  assert.throws(() => resolveArch(""), /unsupported --arch/);
  assert.throws(() => resolveArch("arm64-hf"), /unsupported --arch/);
});

test("the throw message lists every supported arch", () => {
  // Single point of failure if someone adds a new --arch but forgets the
  // error message — the throw must enumerate ALL supported values.
  try {
    resolveArch("bogus");
    assert.fail("expected resolveArch to throw");
  } catch (e) {
    const msg = String(e?.message ?? "");
    assert.match(msg, /x64/);
    assert.match(msg, /arm64/);
    assert.match(msg, /darwin-arm64/);
  }
});

// Integration: import pack.mjs with a guaranteed-bad arch flag to verify
// the parseArgs validation actually fires. We don't run the full main()
// (it would hit the network); we just confirm the `die()` message names
// every supported value. If a future change loosens validation without
// keeping the message accurate, this test fails.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const PACK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pack.mjs");

test("pack.mjs --arch bogus fails the parseArgs validation with the right message", () => {
  // pack.mjs calls main() on import. main() reads package.json and would
  // network-call nodejs.org — we can't run it end-to-end here. Instead, we
  // exercise the parseArgs path: pass a bad --arch and confirm die() prints
  // the supported-arch list (covers the regex/array in parseArgs without
  // running main). Use a short timeout because node will block on
  // npm/tar even if it gets past --arch validation.
  let stderr = "";
  let stdout = "";
  try {
    const out = execFileSync(
      "node",
      [PACK_SCRIPT, "--arch", "bogus", "--skip-build"],
      { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    stdout = out;
  } catch (e) {
    stderr = e?.stderr?.toString() ?? "";
    stdout = e?.stdout?.toString() ?? "";
  }
  // die() prints to stderr with the "✗ unsupported --arch" prefix.
  assert.match(stderr, /unsupported --arch/);
  assert.match(stderr, /darwin-arm64/);
  assert.match(stderr, /\bx64\b/);
  assert.match(stderr, /\barm64\b/);
});

// The staging allowlist (INCLUDE) and the owned-on-box list (OWNED_ON_BOX =
// [...INCLUDE, "runtime", "node_modules"]) are two distinct concepts in
// pack.mjs. INCLUDE is which repo paths get COPIED into the tarball;
// OWNED_ON_BOX is which paths self-update replaces on an installed box.
//
// They differ by exactly two entries — `runtime` and `node_modules` — and for
// the same underlying reason: both are PRODUCED during staging rather than
// copied from the repo, so neither can be in INCLUDE, yet both must reach an
// installed box on update. The full rationale for each lives on OWNED_ON_BOX
// in pack.mjs and is deliberately not restated here.
//
// pack.mjs can't be imported (main() runs on import and hits the network), so
// we read its SOURCE and evaluate the two array literals — the same way the
// harness above reaches into the script without running it.
const PACK_SRC = readFileSync(PACK_SCRIPT, "utf8");

function evalArrayLiteral(declName, scope = {}) {
  const m = PACK_SRC.match(new RegExp(`const\\s+${declName}\\s*=\\s*(\\[[\\s\\S]*?\\];)`));
  assert.ok(m, `could not find const ${declName} in pack.mjs`);
  return Function(...Object.keys(scope), `return ${m[1]}`)(...Object.values(scope));
}

test("OWNED_ON_BOX = INCLUDE + runtime + node_modules + vendor: staged-not-copied paths are owned, otherwise equal", () => {
  const include = evalArrayLiteral("INCLUDE");
  const owned = evalArrayLiteral("OWNED_ON_BOX", { INCLUDE: include });

  for (const staged of ["runtime", "node_modules", "vendor"]) {
    assert.ok(owned.includes(staged), `owned-on-box list must include ${staged}`);
    assert.ok(!include.includes(staged), `staging allowlist must NOT include ${staged}`);
  }
  assert.deepEqual(
    owned.filter((p) => p !== "runtime" && p !== "node_modules" && p !== "vendor"),
    include,
    "owned list must otherwise equal the staging allowlist",
  );
  // guard against the two lists silently collapsing back into one
  assert.notDeepEqual(owned, include);
});

test("the release ships the V2 plugins and no longer the V1 plugin directory", () => {
  const include = evalArrayLiteral("INCLUDE");
  assert.ok(include.includes("docs/opencode-plugins-v2"));
  assert.ok(!include.includes("docs/opencode-plugins"));
});

// --- stageOpencodeBinary: the pinned OpenCode V2 binary rides in the tarball ----------------
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

function stager() {
  return evalFunctionDecl("stageOpencodeBinary", {
    // the helpers the function closes over
    join,
    mkdir, copyFile, chmod, readFile, writeFile, createHash,
    opencodePlatformFor: evalFunctionDecl("opencodePlatformFor"),
    OPENCODE_V2_VERSION: "2.0.30",
    ensureOpencodeBinary: null,
    opencodePlatformKey: null,
  });
}

test("stageOpencodeBinary: copies the binary executable, with a sha256 sidecar + VERSION, into vendor/opencode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "manta-pack-oc-"));
  try {
    const src = join(dir, "cache-opencode");
    await writeFile(src, "PINNED-BINARY");
    const stage = join(dir, "stage");
    const r = await stager()(stage, "x64", { ensureBinary: async () => src, platformKey: () => "linux-x64" });
    const out = join(stage, "vendor", "opencode");
    assert.equal(await readFile(join(out, "opencode"), "utf8"), "PINNED-BINARY");
    assert.equal((await stat(join(out, "opencode"))).mode & 0o777, 0o755);
    const want = createHash("sha256").update("PINNED-BINARY").digest("hex");
    assert.equal(await readFile(join(out, "opencode.sha256"), "utf8"), `${want}  opencode\n`);
    assert.equal(await readFile(join(out, "VERSION"), "utf8"), "2.0.30\n");
    assert.deepEqual(r, { version: "2.0.30", sha256: want, platform: "linux-x64" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stageOpencodeBinary: refuses to ship a binary built for a different platform than --arch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "manta-pack-oc-"));
  try {
    await assert.rejects(
      () => stager()(join(dir, "s"), "arm64", { ensureBinary: async () => assert.fail("must not download"), platformKey: () => "linux-x64" }),
      /cannot stage the linux-arm64 OpenCode binary on a linux-x64 host/,
    );
    await assert.rejects(() => stager()(join(dir, "s"), "bogus", { platformKey: () => "linux-x64" }), /no OpenCode build for --arch bogus/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the staged binary's sidecar is exactly what the box-side installer verifies (round trip through installPinnedBinary)", async () => {
  const { installPinnedBinary } = await import("../../src/server/upgradeV2Prepare.mjs");
  const dir = await mkdtemp(join(tmpdir(), "manta-pack-oc-"));
  try {
    const src = join(dir, "cache-opencode");
    await writeFile(src, "PINNED-BINARY");
    const stage = join(dir, "stage");
    await stager()(stage, "x64", { ensureBinary: async () => src, platformKey: () => "linux-x64" });
    const r = await installPinnedBinary({ src: join(stage, "vendor", "opencode", "opencode"), destDir: join(dir, "home", ".opencode", "bin") });
    assert.equal(r.changed, true);
    assert.equal(await readFile(r.bin, "utf8"), "PINNED-BINARY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// BET-829 regression. Dropping node_modules from the owned list would silently
// restore the old behaviour: the box would fall back to `npm ci` on a machine
// with no compiler and a mismatched system Node, and the failure only surfaces
// as a manta-server that will not start after the next restart.
test("BET-829: node_modules stays release-owned so the box never rebuilds deps locally", () => {
  const include = evalArrayLiteral("INCLUDE");
  const owned = evalArrayLiteral("OWNED_ON_BOX", { INCLUDE: include });
  assert.ok(
    owned.includes("node_modules"),
    "node_modules must be release-owned — the tarball ships a prebuilt, arch- and ABI-verified tree",
  );
});

// --- resolveGitSha: the release's update identity ---------------------------
//
// Why a release is identified by its commit rather than its version lives on
// resolveGitSha in pack.mjs and in AGENTS.md; it is deliberately not restated
// here. These cases pin the resolution order and the two shapes that would
// break a box: a missing commit (must degrade, not fail) and a malformed one
// (must never be stamped).
//
// Same source-reading harness as the array-literal tests above: pack.mjs can't
// be imported (main() runs on import and hits the network), so we lift the
// function out of the source and evaluate it against injected dependencies.

function evalFunctionDecl(declName, scope = {}) {
  const m = PACK_SRC.match(new RegExp(`\\nfunction\\s+${declName}\\s*\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `could not find function ${declName} in pack.mjs`);
  return Function(
    ...Object.keys(scope),
    `${m[0]}; return ${declName};`,
  )(...Object.values(scope));
}

// A spawnSync stub standing in for `git rev-parse HEAD`.
function gitStub(result) {
  return () => result;
}

const NOT_A_REPO = { status: 128, stdout: "" };
const HEAD = "a".repeat(40);

test("resolveGitSha prefers an explicit override over the checkout", () => {
  const resolveGitSha = evalFunctionDecl("resolveGitSha", {
    process: { env: { MANTA_GIT_SHA: "abc1234" } },
    spawnSync: gitStub({ status: 0, stdout: `${HEAD}\n` }),
    REPO_ROOT: "/repo",
  });
  assert.equal(resolveGitSha(), "abc1234");
});

test("resolveGitSha falls back to CI's own commit variable", () => {
  const resolveGitSha = evalFunctionDecl("resolveGitSha", {
    process: { env: { GITHUB_SHA: HEAD.toUpperCase() } },
    spawnSync: gitStub(NOT_A_REPO),
    REPO_ROOT: "/repo",
  });
  // Normalized so a manifest value and a RELEASE.json value can be compared
  // as plain strings on the box, where there is no case-insensitive compare.
  assert.equal(resolveGitSha(), HEAD);
});

test("resolveGitSha reads the working checkout when nothing is injected", () => {
  const resolveGitSha = evalFunctionDecl("resolveGitSha", {
    process: { env: {} },
    spawnSync: gitStub({ status: 0, stdout: `${HEAD}\n` }),
    REPO_ROOT: "/repo",
  });
  assert.equal(resolveGitSha(), HEAD);
});

test("resolveGitSha returns null outside a git checkout rather than failing the pack", () => {
  // A tarball built from an exported source tree is still a valid release —
  // it just degrades the box to the old version-only comparison.
  const resolveGitSha = evalFunctionDecl("resolveGitSha", {
    process: { env: {} },
    spawnSync: gitStub(NOT_A_REPO),
    REPO_ROOT: "/repo",
  });
  assert.equal(resolveGitSha(), null);
});

test("resolveGitSha ignores a malformed override instead of stamping garbage", () => {
  // A stamped non-sha would never match any box's RELEASE.json, making every
  // box reinstall the same tarball on every update check.
  const resolveGitSha = evalFunctionDecl("resolveGitSha", {
    process: { env: { MANTA_GIT_SHA: "not-a-sha" } },
    spawnSync: gitStub({ status: 0, stdout: `${HEAD}\n` }),
    REPO_ROOT: "/repo",
  });
  assert.equal(resolveGitSha(), HEAD);
});

test("the release stamp and the manifest key come from the same resolved value", () => {
  // RELEASE.json (what the box reports it is running) and the manifest (what
  // the box compares against) must never disagree about the commit — if they
  // can drift, the box either skips a real update or reinstalls forever.
  assert.match(PACK_SRC, /const gitSha = resolveGitSha\(\);/);
  assert.match(PACK_SRC, /git_sha: gitSha,/);
  assert.match(PACK_SRC, /gitSha \? `git_sha=\$\{gitSha\}\\n` : ""/);
});
