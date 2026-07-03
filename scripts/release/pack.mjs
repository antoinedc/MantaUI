#!/usr/bin/env node
// pack.mjs — build a versioned release tarball the VPS installer downloads.
//
//   node scripts/release/pack.mjs [--out dist] [--skip-build]
//
// Produces `dist/bui-<version>.tar.gz` whose contents unpack into a single
// top-level `bui-<version>/` directory. The installer downloads this, extracts
// with --strip-components=1 into ~/bui, runs `npm ci --omit=dev`, and starts the
// server — NO renderer toolchain needed on the box, because we ship a PRE-BUILT
// `mobile/www/` here.
//
// What goes in (the box's runtime surface only):
//   src/            — the server (src/server/**) + shared code it imports
//   scripts/        — install.sh, bui-pair.mjs, install-lib.mjs, systemd unit
//   mobile/www/     — PRE-BUILT renderer bundle (this is why the box needs no
//                     Vite/electron toolchain)
//   package.json    — the "mobile"/"pair" npm scripts + prod deps list
//   package-lock.json — pins prod deps for `npm ci`
//   README.md       — manual-install fallback reference
//
// What's excluded: the Electron desktop build, node_modules, .git, dist, tests,
// dev configs — none of it runs on the box.

import { mkdir, rm, writeFile, cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function log(msg) {
  process.stdout.write(`▸ ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { outDir: "dist", skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.outDir = argv[++i];
    else if (argv[i] === "--skip-build") out.skipBuild = true;
  }
  return out;
}

// The set of paths that make up the box runtime. Kept explicit (allowlist) so a
// stray dev file never leaks into a public release tarball.
const INCLUDE = [
  "src",
  "scripts",
  "mobile/www",
  "package.json",
  "package-lock.json",
  "README.md",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf-8"));
  const version = pkg.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version || "")) {
    die(`package.json version ${JSON.stringify(version)} is not a valid release version`);
  }

  const stageRoot = join(REPO_ROOT, args.outDir, ".stage");
  const stageDir = join(stageRoot, `bui-${version}`);
  const outFile = join(REPO_ROOT, args.outDir, `bui-${version}.tar.gz`);

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

  // 2. Stage the allowlisted paths under bui-<version>/.
  log(`Staging release into ${stageDir}…`);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  for (const rel of INCLUDE) {
    const from = join(REPO_ROOT, rel);
    if (!existsSync(from)) {
      // package-lock is optional-ish; everything else is required.
      if (rel === "package-lock.json") {
        log(`  (no ${rel} — skipping; installer falls back to npm install)`);
        continue;
      }
      die(`required path missing from repo: ${rel}`);
    }
    await cp(from, join(stageDir, rel), { recursive: true });
  }

  // 3. Drop a manifest so the box can report exactly what it's running.
  await writeFile(
    join(stageDir, "RELEASE.json"),
    JSON.stringify(
      { name: "bui", version, built_at: new Date().toISOString(), includes: INCLUDE },
      null,
      2,
    ) + "\n",
  );

  // 4. Tar it up. Tarball root is bui-<version>/ so install.sh strips it.
  log(`Creating ${outFile}…`);
  await mkdir(dirname(outFile), { recursive: true });
  const r = spawnSync(
    "tar",
    ["-czf", outFile, "-C", stageRoot, `bui-${version}`],
    { stdio: "inherit" },
  );
  if (r.status !== 0) die("tar failed");

  // 5. Clean up the stage dir; leave the tarball.
  await rm(stageRoot, { recursive: true, force: true });

  log(`Done: ${outFile}`);
  log(`Upload it to <release-host>/releases/bui-${version}.tar.gz`);
}

main().catch((e) => die(String(e?.stack ?? e)));
