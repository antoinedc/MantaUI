#!/usr/bin/env node
// pack.mjs — build a self-contained, versioned release tarball the VPS
// installer downloads.
//
//   node scripts/release/pack.mjs [--out dist] [--arch x64|arm64|darwin-arm64]
//
// Produces a per-arch tarball + per-arch manifest sidecar in `dist/`. ONE
// invocation builds ONE arch (`--arch x64`, `arm64`, or `darwin-arm64`); the
// per-arch invocations are merged into the combined `manta-<version>.txt`
// by `scripts/release/merge-manifest.mjs` — install.sh reads the combined
// manifest and picks its own arch's keys via `resolve_arch`. (`<arch>` is
// linux-x64 / linux-arm64 / darwin-arm64; manifest keys are linux_x64 /
// linux_arm64 / darwin_arm64.) The darwin-arm64 tarball MUST be built on a
// macOS runner — node-pty's native binding cannot be cross-compiled.
//
// The tarball's top-level dir is `manta-<version>/`. install.sh extracts with
// `--strip-components=1` into `~/manta`. The tarball is SELF-CONTAINED — the
// box does NOT run `npm ci` after extraction:
//
//   manta-<version>/
//     runtime/node/                  vendored Node 24.19.0 (.tar.gz prebuilt by
//                                    nodejs.org — same Node binary + npm the
//                                    box will use, so node-pty's native ABI
//                                    matches the runtime that runs it)
//     src/, scripts/,                 the allowlisted box surface
//     package.json, package-lock.json
//     node_modules/                  prebuilt production deps (--omit=dev),
//                                    with node-pty's native binding already in
//                                    place — COMPILED against the vendored
//                                    node's ABI on Linux, or taken from the
//                                    prebuilds node-pty ships for darwin/win32
//     docs/opencode-tools/           manta-native opencode tool bundle
//     RELEASE.json                   { name, version, built_at, includes,
//                                      node, arch }
//
// Why a vendored runtime + prebuilt deps (vs the previous "apt-install node +
// npm ci on the box"): the one-liner installer used to silently use sudo +
// distro package managers to fetch Node and (because node-pty has a native
// binding) build-essential. Every launch-gate E2E failure traced back to that
// seam. Shipping a self-contained user-space tarball (rustup/uv/opencode-style)
// eliminates it: the box needs only `curl` + `tar` + `sha256sum` + `tmux` +
// `git`, and the install is verified end-to-end before it starts.
//
// What we do NOT do:
//   * No package-manager calls (no apt / dnf / yum / nodesource).
//   * No `sudo` in any code path.
//   * No tarball template generation — install.sh is served verbatim from the
//     repo. Version + sha256 live in the manifest, not in install.sh.
//
// What's excluded from the tarball: the Electron desktop build, dist itself,
// tests, dev configs, .git — none of it runs on the box.

import { mkdir, rm, writeFile, cp, readFile } from "node:fs/promises";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Pin the vendored Node version. Bump deliberately, not from `nvm ls`. The
// runtime is built once on the pack box and shipped as-is — the box never
// touches a package manager.
const NODE_VERSION = "24.19.0";
const NODE_SHA_FILE = "SHASUMS256.txt";
const NODE_SHA_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_SHA_FILE}`;

// Map the --arch flag to the arch-dependent strings. Single source of
// truth so a new arch is one line here, not scattered edits. The hyphen
// `file` form matches nodejs.org's tarball filename token (linux-x64 /
// linux-arm64 / darwin-arm64); the underscore `key` form matches install.sh's
// manifest_get keys (file_linux_x64 / file_linux_arm64 / file_darwin_arm64).
function resolveArch(arch) {
  switch (arch) {
    case "x64":          return { key: "linux_x64",    file: "linux-x64" };
    case "arm64":        return { key: "linux_arm64",  file: "linux-arm64" };
    case "darwin-arm64": return { key: "darwin_arm64", file: "darwin-arm64" };
    default:
      throw new Error(`unsupported --arch ${JSON.stringify(arch)} (expected: x64 | arm64 | darwin-arm64)`);
  }
}

// The commit this release was built from — the release's true identity.
//
// WHY THIS EXISTS: the box's updater used to decide "am I already running the
// published release?" by comparing `version` alone. That number is maintained
// by hand, so a release cut without bumping it was INDISTINGUISHABLE from the
// one already installed and every box silently skipped a real update — the
// failure is invisible (the updater cheerfully reports "already at 0.0.29")
// and lasts until someone notices the fix never shipped. Identifying a build
// by its commit removes the class of mistake: same commit = genuinely the same
// code, different commit = a real update, no bookkeeping required.
//
// Resolution order: an explicit override, then CI's own commit variable, then
// the working checkout. Falls back to null OUTSIDE a git checkout (a tarball
// built from an exported source tree is still valid) — the manifest key is
// then omitted and the updater degrades to its old version-only comparison.
function resolveGitSha() {
  const fromEnv = process.env.MANTA_GIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv.trim())) return fromEnv.trim().toLowerCase();
  const r = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf-8" });
  const out = (r.stdout || "").trim();
  if (r.status === 0 && /^[0-9a-f]{40}$/i.test(out)) return out.toLowerCase();
  return null;
}

function log(msg) {
  process.stdout.write(`▸ ${msg}\n`);
}
function ok(msg) {
  process.stdout.write(`\u2713 ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { outDir: "dist", skipBuild: false, arch: "x64" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--skip-build") out.skipBuild = true;
    else if (argv[i] === "--arch") out.arch = argv[++i];
  }
  // Validate --arch eagerly so an invalid value dies before any work.
  if (!["x64", "arm64", "darwin-arm64"].includes(out.arch)) {
    die(`unsupported --arch ${JSON.stringify(out.arch)} (expected: x64 | arm64 | darwin-arm64)`);
  }
  return out;
}

// The set of paths that make up the box runtime. Kept explicit (allowlist) so a
// stray dev file never leaks into a public release tarball. node_modules is
// NOT on this list — we materialize a fresh --omit=dev tree in <stage>/node_modules
// below so the box ships with production-only deps (no devDeps → smaller
// tarball, no `.bin/` shells that would resolve to a missing node).
const INCLUDE = [
  "src",
  "scripts",
  "docs/opencode-tools",
  "package.json",
  "package-lock.json",
  "README.md",
  "llms-install.md",
];

// Paths the release OWNS on an installed box — the list self-update.sh
// replaces wholesale, written to RELEASE.json as `includes`. This is INCLUDE
// plus `runtime`: the vendored Node is produced by ensureNodeRuntime() during
// staging rather than copied from the repo, so it cannot be in the staging
// allowlist above, but it must be replaced on update or a runtime version bump
// can never reach an installed box.
//
// `node_modules` is here too, as of BET-829. It used to be excluded on the
// grounds that the box would materialize it with `npm ci --omit=dev` after the
// swap — but doing that ON the box was the single worst step in the update
// path. It needs a C toolchain a clean VPS does not have (install.sh never
// installs one, precisely because this tarball ships deps prebuilt); it builds
// against whatever Node the SYSTEM has rather than the vendored runtime, so a
// box with a mismatched system npm gets a wrong-ABI binding and a "successful"
// update that will not start; and it silently loses the node-pty
// `spawn-helper` executable bit that this script repairs below.
//
// The tree staged here is strictly better than anything the box could build:
// it is --omit=dev, spawn-helper is repaired, and it is PROVEN by requiring
// node-pty through the vendored node for this exact arch before we tar it.
// Tarballs are per-arch, so the copy a box downloads always matches it.
const OWNED_ON_BOX = [...INCLUDE, "runtime", "node_modules"];

// Parse the nodejs.org SHASUMS256.txt into {filename: sha256}. Tolerates the
// `*` prefix some lines carry for binary-mode sha.
function parseShaSums(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[a-f0-9]{64}\s+\*?(\S+)\s*$/);
    if (m) out[m[1]] = line.slice(0, 64);
  }
  return out;
}

async function sha256OfFile(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

// Verify `tarballPath` (a file on disk) matches the sha256 recorded in the
// nodejs.org SHASUMS256.txt for `nodeTarball`. Dies on mismatch.
async function verifyTarballSha256(tarballPath, shaFileText, nodeTarball) {
  const expected = parseShaSums(shaFileText)[nodeTarball];
  if (!expected) {
    die(`SHASUMS256.txt did not contain a line for ${nodeTarball}`);
  }
  const actual = await sha256OfFile(tarballPath);
  if (actual !== expected) {
    die(
      `sha256 mismatch for ${nodeTarball}\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `  (re-run; if it persists, the upstream distribution may be corrupt)`,
    );
  }
  log(`sha256 verified: ${actual}`);
}

// Download + cache the vendored node tarball + its SHASUMS256.txt, verify the
// tarball's sha256 against the file, and extract the runtime into <stage>/runtime/node.
// Dies on any failure.
//
// Cache location: <outDir>/.cache/node-v<version>-<arch>.tar.gz (and the
// matching SHASUMS256.txt). A subsequent pack with the same version skips the
// network round-trip (the SHA is byte-stable).
async function ensureNodeRuntime(cacheDir, stageDir, nodeTarball) {
  const nodeTarballUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${nodeTarball}`;
  await mkdir(cacheDir, { recursive: true });
  const cachedTar = join(cacheDir, nodeTarball);
  const cachedSha = join(cacheDir, NODE_SHA_FILE);

  if (!existsSync(cachedTar) || !existsSync(cachedSha)) {
    log(`Downloading vendored Node ${NODE_VERSION}…`);
    const [tarRes, shaRes] = await Promise.all([
      fetch(nodeTarballUrl),
      fetch(NODE_SHA_URL),
    ]);
    if (!tarRes.ok) die(`download failed: ${nodeTarballUrl} → ${tarRes.status}`);
    if (!shaRes.ok) die(`download failed: ${NODE_SHA_URL} → ${shaRes.status}`);
    const tarBytes = Buffer.from(await tarRes.arrayBuffer());
    const shaText = await shaRes.text();
    await writeFile(cachedTar, tarBytes);
    await writeFile(cachedSha, shaText);
  } else {
    log(`Reusing cached ${nodeTarball} (.cache/).`);
  }

  log(`Verifying sha256 of vendored Node ${NODE_VERSION}…`);
  await verifyTarballSha256(cachedTar, readFileSync(cachedSha, "utf-8"), nodeTarball);

  // Extract into <stage>/runtime/node, stripping the leading `node-v.../`.
  // After this, <stage>/runtime/node/bin/{node,npm,corepack,...} exist.
  const runtimeDir = join(stageDir, "runtime", "node");
  await mkdir(runtimeDir, { recursive: true });
  log(`Extracting vendored Node into ${runtimeDir}…`);
  const r = spawnSync(
    "tar",
    ["-xzf", cachedTar, "-C", runtimeDir, "--strip-components=1"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) die("tar extract of vendored Node failed");

  if (!existsSync(join(runtimeDir, "bin", "node"))) {
    die(
      `vendored Node extract missing bin/node — bad tarball? expected ${join(runtimeDir, "bin", "node")}`,
    );
  }
  ok(`vendored Node ${NODE_VERSION} extracted (${join(runtimeDir, "bin", "node")}).`);
}

// Run `npm ci --omit=dev` IN the stage dir, using the VENDORED node's ABI.
// This is the load-bearing step for the "self-contained tarball" promise:
// node-pty's native binding compiles here, against the same Node binary the
// box will run it under, so the .node file loads on first `node src/server/index.mjs`
// without a second compile pass.
async function runPrebuiltDeps(stageDir) {
  const stageNpm = join(stageDir, "runtime", "node", "bin", "npm");
  if (!existsSync(stageNpm)) {
    die(`vendored npm missing — expected ${stageNpm} (the tarball's bin/ layout may have changed)`);
  }

  log(`Installing production deps with vendored npm (--omit=dev)…`);
  const r = spawnSync(stageNpm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stageDir,
    stdio: "inherit",
    // PATH-prefix the vendored node bin so any npm subprocesses (e.g. node-gyp
    // for node-pty) find the matching ABI. Without this, on a pack box where
    // /usr/bin/node is a different major than the vendored 24.19.0, the
    // binding compiles against the system ABI and refuses to load.
    env: {
      ...process.env,
      PATH: `${join(stageDir, "runtime", "node", "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  if (r.status !== 0) die("vendored npm ci failed");

  // Sanity: the box must be able to LOAD node-pty's native binding, because
  // every terminal surface on the box dies without it.
  //
  // This deliberately checks loadability, not the presence of a particular
  // file. node-pty does not always compile: since 1.1.0 it SHIPS prebuilt
  // bindings for darwin and win32 in `prebuilds/<platform>-<arch>/`, and its
  // install script (`node scripts/prebuild.js || node-gyp rebuild`) skips the
  // compile entirely when a prebuild for the current platform exists — its
  // post-install step then deletes `build/Release` outright. Linux has no
  // prebuild, so it still compiles. The old check asserted `build/Release`
  // existed and so was structurally unsatisfiable on macOS: the darwin-arm64
  // release leg failed on a perfectly good tree while the Linux legs passed.
  //
  // Requiring the module through the VENDORED node is both simpler and
  // stronger than any file check — it proves the exact binary the box will run
  // can load this binding (right ABI, executable bit intact, prebuild or
  // compile, we don't care which).
  // Repair node-pty's prebuilt `spawn-helper` before probing.
  //
  // On Unix, node-pty EXECS a small `spawn-helper` binary that sits next to the
  // binding it loaded. npm does not preserve the executable bit for files that
  // aren't declared as package `bin` entries, node-pty ships this one inside
  // `prebuilds/`, and nothing in its install scripts chmods it — so as
  // installed, the darwin prebuild is mode 0644 and every attempt to open a
  // terminal on the box would fail with EACCES. (Linux is unaffected: it has no
  // prebuild, so node-gyp compiles the helper and marks it executable.)
  // We restore the bit here, on the tree that is about to be tarred; the probe
  // below then re-asserts it, so if upstream ever changes this we fail loudly
  // instead of shipping a box with no terminals.
  for (const dir of ["build/Release", "build/Debug", "prebuilds"]) {
    const base = join(stageDir, "node_modules", "node-pty", dir);
    if (!existsSync(base)) continue;
    const found = spawnSync("sh", ["-c", `find ${base} -name spawn-helper -type f`], {
      encoding: "utf8",
    });
    for (const helper of (found.stdout ?? "").split("\n").filter(Boolean)) {
      if (statSync(helper).mode & 0o111) continue;
      chmodSync(helper, 0o755);
      log(`restored the executable bit on ${helper.slice(stageDir.length + 1)} (npm drops it)`);
    }
  }

  const probe = spawnSync(
    join(stageDir, "runtime", "node", "bin", "node"),
    [
      "-e",
      "const pty = require('node-pty');" +
        "if (typeof pty.spawn !== 'function') throw new Error('node-pty loaded without spawn()');" +
        // node-pty resolves its binding from build/Release, build/Debug, then
        // prebuilds/<platform>-<arch> — report which one won, so a release log
        // says whether this arch shipped a compile or a prebuild.
        "const fs = require('node:fs'), path = require('node:path');" +
        "const root = path.dirname(require.resolve('node-pty/package.json'));" +
        "const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];" +
        "const found = dirs.find((d) => fs.existsSync(path.join(root, d, 'pty.node')));" +
        // On Unix node-pty forks a `spawn-helper` binary that sits next to
        // pty.node. It is useless without its executable bit, and a lost mode
        // bit would only surface as "the box opens no terminals" long after
        // release — so check it here, where the tree is still on disk.
        "const helper = found && path.join(root, found, 'spawn-helper');" +
        "if (helper && fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) {" +
        "  throw new Error(`spawn-helper is not executable: ${helper}`);" +
        "}" +
        "console.log(found ?? 'unknown location');",
    ],
    { cwd: stageDir, encoding: "utf8" },
  );
  if (probe.status !== 0) {
    die(
      `node-pty does not load under the vendored Node — the box would have no terminals.\n` +
        `${(probe.stderr || probe.stdout || "").trim()}`,
    );
  }
  ok(`production deps installed; node-pty loads (binding from ${probe.stdout.trim()}).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf-8"));
  const version = pkg.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version || "")) {
    die(`package.json version ${JSON.stringify(version)} is not a valid release version`);
  }

  // Resolve the arch flag into the strings this pack uses. `ARCH` is the
  // hyphen form (matches nodejs.org's tarball filename + our tarball name);
  // `ARCH_KEY` is the underscore form (matches install.sh's manifest_get
  // keys). Resolved once here so nothing else in main() re-spells them.
  const { key: ARCH_KEY, file: ARCH } = resolveArch(args.arch);

  // Resolved once, up front, so the RELEASE.json stamp and the manifest key
  // can never disagree about which commit this tarball came from.
  const gitSha = resolveGitSha();
  if (gitSha) {
    log(`Release commit: ${gitSha}`);
  } else {
    log(
      "⚠ no git commit resolved (not a git checkout and no MANTA_GIT_SHA/GITHUB_SHA) — " +
        "boxes will fall back to comparing version numbers, so an unbumped release will be skipped",
    );
  }
  // nodejs.org's tarball filename token is exactly the hyphen form, so the
  // vendored-node URL + cache key + sha lookup all use this single string.
  const NODE_TARBALL = `node-v${NODE_VERSION}-${ARCH}.tar.gz`;

  const stageRoot = join(REPO_ROOT, args.outDir, ".stage");
  const stageDir = join(stageRoot, `manta-${version}`);
  // Archive name encodes the arch so a future arm64 build is data, not code.
  // install.sh's manifest key file_linux_<arch> mirrors this.
  const outFile = join(REPO_ROOT, args.outDir, `manta-${version}-${ARCH}.tar.gz`);
  // Per-arch sidecar manifest — keeps per-arch builds from overwriting each
  // other on the release host. Stage 2 merges these into the combined
  // `manta-<version>.txt` install.sh fetches by default.
  const outManifest = join(REPO_ROOT, args.outDir, `manta-${version}-${ARCH}.txt`);
  const cacheDir = join(REPO_ROOT, args.outDir, ".cache");

  // BET-559: the renderer web-bundle (build:mobile → mobile/www) was the served
  // PWA client. It is retired — the box no longer builds or ships a web
  // bundle, so there is nothing to build before staging.

  // 2. Stage the allowlisted paths under manta-<version>/.
  log(`Staging release into ${stageDir}…`);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  for (const rel of INCLUDE) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) {
      // package-lock is optional-ish; everything else is required.
      if (rel === "package-lock.json") {
        log(`  (no ${rel} — skipping; this would otherwise break the box's npm ci)`);
        continue;
      }
      die(`required path missing from repo: ${rel}`);
    }
    await cp(from, join(stageDir, rel), { recursive: true });
  }

  // BET-640: self-update.sh sources the shared release helpers
  // (scripts/lib/release.sh) at runtime on the box. It ships inside the
  // `scripts` include (copied recursively above); fail LOUD here if it's ever
  // missing, so a packaged box never ends up with the updater but not the
  // library it sources — which would convert the self-update fix into a worse
  // failure.
  if (!existsSync(join(stageDir, "scripts/lib/release.sh"))) {
    die("release tarball is missing scripts/lib/release.sh — self-update.sh sources it");
  }

  // 3. Vendored Node 24.19.0 — downloaded + sha256-verified + extracted under
  //    stage/runtime/node. Tarball is cached under .cache/ so re-packs skip the
  //    network round-trip. This is the runtime the box will use.
  await ensureNodeRuntime(cacheDir, stageDir, NODE_TARBALL);

  // 4. Prebuilt production deps via the vendored npm/node. Runs BEFORE
  //    RELEASE.json/tar so the box gets a tarball whose node_modules is already
  //    self-consistent (no `npm ci` step on the box).
  await runPrebuiltDeps(stageDir);

  // 5. RELEASE.json — also documents the runtime + arch so the box can report
  //    exactly what it's running. Not used by install.sh (which uses the
  //    sha256 manifest instead); kept for human audit / future tooling.
  await writeFile(
    join(stageDir, "RELEASE.json"),
    JSON.stringify(
      {
        name: "manta",
        version,
        // The commit this payload was built from. `replace_release_payload`
        // stamps this file onto the box, so the installed RELEASE.json is how
        // the box knows which build it is actually running. null only when
        // packed outside a git checkout.
        git_sha: gitSha,
        built_at: new Date().toISOString(),
        node: NODE_VERSION,
        arch: ARCH,
        includes: OWNED_ON_BOX,
      },
      null,
      2,
    ) + "\n",
  );

  // 6. Tar it up. Tarball root is manta-<version>/ so install.sh strips it.
  log(`Creating ${outFile}…`);
  await mkdir(dirname(outFile), { recursive: true });
  const r = spawnSync(
    "tar",
    ["-czf", outFile, "-C", stageRoot, `manta-${version}`],
    { stdio: "inherit" },
  );
  if (r.status !== 0) die("tar failed");

  // 7. Manifest — flat key=value, parseable in bash before any node exists on
  //    the box. install.sh uses this to fetch + verify the tarball. The
  //    sha256 is computed AFTER tar (the tarball is the artifact being verified).
  //    Keys: version, git_sha, file_<arch> (underscore form — matches
  //    install.sh's manifest_get calls), sha256_<arch>.
  //
  //    `git_sha` is in the manifest as well as RELEASE.json so the box can
  //    answer "is this a new build?" from the manifest ALONE — preserving the
  //    cheap early exit, i.e. no tarball download when nothing changed. It is
  //    omitted entirely when unresolved rather than written empty, so an older
  //    box parsing this file sees no key and behaves exactly as before.
  log(`Writing manifest ${outManifest}…`);
  const tarSha = await sha256OfFile(outFile);
  const manifest =
    `version=${version}\n` +
    (gitSha ? `git_sha=${gitSha}\n` : "") +
    `file_${ARCH_KEY}=${`manta-${version}-${ARCH}.tar.gz`}\n` +
    `sha256_${ARCH_KEY}=${tarSha}\n`;
  await writeFile(outManifest, manifest);
  ok(`manifest written: ${outManifest}`);

  // 8. Clean up the stage dir; leave the tarball + manifest + .cache.
  await rm(stageRoot, { recursive: true, force: true });
  // Keep .cache/ — re-packs for the same Node version skip the network round-trip.
  // Operators can `rm -rf dist/.cache` to force a re-download.

  log(`Done: ${outFile}`);
  log(`Manifest: ${outManifest}`);
  log(`Upload both to <release-host>/releases/ — install.sh fetches the manifest first.`);
}

main().catch((e) => die(String(e?.stack ?? e)));
