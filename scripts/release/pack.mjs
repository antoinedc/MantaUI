#!/usr/bin/env node
// pack.mjs — build a self-contained, versioned release tarball the VPS
// installer downloads.
//
//   node scripts/release/pack.mjs [--out dist] [--skip-build] [--arch x64|arm64]
//
// Produces a per-arch tarball + per-arch manifest sidecar in `dist/`. ONE
// invocation builds ONE arch (`--arch x64` or `--arch arm64`); two invocations
// (one per arch, run on native runners) are merged into the combined
// `manta-<version>.txt` by `scripts/release/merge-manifest.mjs` — install.sh
// reads the combined manifest and picks its own arch's keys via `resolve_arch`.
// (`<arch>` is linux-x64 / linux-arm64; manifest keys are linux_x64 / linux_arm64.)
//
// The tarball's top-level dir is `manta-<version>/`. install.sh extracts with
// `--strip-components=1` into `~/manta`. The tarball is SELF-CONTAINED — the
// box does NOT run `npm ci` after extraction:
//
//   manta-<version>/
//     runtime/node/                  vendored Node 20.20.2 (.tar.gz prebuilt by
//                                    nodejs.org — same Node binary + npm the
//                                    box will use, so node-pty's native ABI
//                                    matches the runtime that runs it)
//     src/, scripts/, mobile/www/,   the allowlisted box surface
//     package.json, package-lock.json
//     node_modules/                  prebuilt production deps (--omit=dev),
//                                    with node-pty's binding already compiled
//                                    against the vendored node's ABI
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
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Pin the vendored Node version. Bump deliberately, not from `nvm ls`. The
// runtime is built once on the pack box and shipped as-is — the box never
// touches a package manager.
const NODE_VERSION = "20.20.2";
const NODE_SHA_FILE = "SHASUMS256.txt";
const NODE_SHA_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_SHA_FILE}`;

// Map the --arch flag to the two arch-dependent strings. Single source of
// truth so a third arch is one line here, not scattered edits. The hyphen
// `file` form matches nodejs.org's tarball filename token (linux-x64 /
// linux-arm64); the underscore `key` form matches install.sh's
// manifest_get keys (file_linux_x64 / file_linux_arm64).
function resolveArch(arch) {
  switch (arch) {
    case "x64":   return { key: "linux_x64",   file: "linux-x64" };
    case "arm64": return { key: "linux_arm64", file: "linux-arm64" };
    default:
      throw new Error(`unsupported --arch ${JSON.stringify(arch)} (expected: x64 | arm64)`);
  }
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
  if (out.arch !== "x64" && out.arch !== "arm64") {
    die(`unsupported --arch ${JSON.stringify(out.arch)} (expected: x64 | arm64)`);
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
  "mobile/www",
  "package.json",
  "package-lock.json",
  "README.md",
  "llms-install.md",
];

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
    // /usr/bin/node is a different major than the vendored 20.20.2, the
    // binding compiles against the system ABI and refuses to load.
    env: {
      ...process.env,
      PATH: `${join(stageDir, "runtime", "node", "bin")}:${process.env.PATH ?? ""}`,
    },
  });
  if (r.status !== 0) die("vendored npm ci failed");

  // Sanity: node-pty's compiled .node file must be present after `npm ci`.
  // Without it, the server's PTY surfaces throw at runtime on the box.
  const releaseDir = join(stageDir, "node_modules", "node-pty", "build", "Release");
  if (!existsSync(releaseDir)) {
    die(
      `node-pty build/Release missing — expected ${releaseDir} (npm ci did not run node-pty's install script?)`,
    );
  }
  // Glob for at least one *.node file. existsSync on the dir is necessary
  // but not sufficient (the dir can exist with no binary). We use a tiny
  // shell glob rather than pulling in glob/fast-glob just for this check.
  const gl = spawnSync("sh", ["-c", `ls -1 ${releaseDir}/*.node 2>/dev/null | head -n1`], {
    encoding: "utf8",
  });
  if (gl.status !== 0 || !gl.stdout || gl.stdout.trim() === "") {
    die(
      `node-pty compiled .node missing under ${releaseDir} — node-pty's install script did not produce a native binding`,
    );
  }
  ok(`production deps installed; node-pty binding present (${gl.stdout.trim()}).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf-8"));
  const version = pkg.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version || "")) {
    die(`package.json version ${JSON.stringify(version)} is not a valid release version`);
  }

  // Resolve the arch flag into the two strings this pack uses. `ARCH` is the
  // hyphen form (matches nodejs.org's tarball filename + our tarball name);
  // `ARCH_KEY` is the underscore form (matches install.sh's manifest_get
  // keys). Resolved once here so nothing else in main() re-spells them.
  const { key: ARCH_KEY, file: ARCH } = resolveArch(args.arch);
  // nodejs.org's tarball filename token is exactly the hyphen form, so the
  // vendored-node URL + cache key + sha lookup all use this single string.
  const NODE_TARBALL = `node-v${NODE_VERSION}-${ARCH}.tar.gz`;

  const stageRoot = join(REPO_ROOT, args.outDir, ".stage");
  const stageDir = join(stageRoot, `manta-${version}`);
  // Archive name encodes the arch so a future arm64 build is data, not code.
  // install.sh's manifest key file_linux_<arch> mirrors this.
  const outFile = join(REPO_ROOT, args.outDir, `manta-${version}-${ARCH}.tar.gz`);
  // Per-arch sidecar manifest — keeps two arch builds from overwriting each
  // other on the release host. Stage 2 merges these into the combined
  // `manta-<version>.txt` install.sh fetches by default.
  const outManifest = join(REPO_ROOT, args.outDir, `manta-${version}-${ARCH}.txt`);
  const cacheDir = join(REPO_ROOT, args.outDir, ".cache");

  // 1. Build the renderer bundle unless told to skip (CI may pre-build).
  if (!args.skipBuild) {
    log("Building renderer bundle (npm run build:mobile)…");
    const r = spawnSync("npm", ["run", "build:mobile"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) die("build:mobile failed");
  } else {
    log("Skipping build:mobile (--skip-build).");
  }

  if (!existsSync(join(REPO_ROOT, "mobile", "www", "index.html"))) {
    die("mobile/www/index.html missing — the renderer bundle must be built before packing");
  }

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

  // 3. Vendored Node 20.20.2 — downloaded + sha256-verified + extracted under
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
        built_at: new Date().toISOString(),
        node: NODE_VERSION,
        arch: ARCH,
        includes: INCLUDE,
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
  //    Keys: version, file_<arch> (underscore form — matches install.sh's
  //    manifest_get calls), sha256_<arch>.
  log(`Writing manifest ${outManifest}…`);
  const tarSha = await sha256OfFile(outFile);
  const manifest =
    `version=${version}\n` +
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
