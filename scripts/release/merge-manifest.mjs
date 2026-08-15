#!/usr/bin/env node
// merge-manifest.mjs — merge N per-arch release manifest sidecars (one per
// pack.mjs --arch invocation) into a single combined manifest the installer
// fetches.
//
//   node scripts/release/merge-manifest.mjs <sidecar1.txt> [<sidecar2.txt> ...] --out <combined.txt>
//
// Each sidecar carries `version=`, `file_<archkey>=`, `sha256_<archkey>=` where
// `<archkey>` is the underscore form (`linux_x64`, `linux_arm64`,
// `darwin_arm64`). The combined manifest echoes `version=` first, then each
// sidecar's arch pair in the order the sidecars were passed in. Unknown keys
// are dropped silently (forward compatibility). Mismatched `version=` between
// sidecars is a hard error — that means the arch builds are from different
// commits.
//
// Pure node, no deps. Kept tiny (this file is intentionally short — it is
// only used by publish.sh + server-tarball-deploy.yml, never on the box).

import { readFile, writeFile } from "node:fs/promises";

function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`▸ ${msg}\n`);
}

// Parse a sidecar body into { version, arches: { archKey: { file, sha } } }.
// `archKey` is the underscore form (linux_x64 / linux_arm64 / darwin_arm64).
// Values may contain `=` — split on the first one only.
function parseSidecar(body) {
  const out = { version: null, gitSha: null, arches: {} };
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "version") {
      if (out.version === null) out.version = value;
      continue;
    }
    // The commit the arch was built from — the box's update identity. Absent
    // when pack.mjs ran outside a git checkout; see the merge rule in main().
    if (key === "git_sha") {
      if (out.gitSha === null && value !== "") out.gitSha = value;
      continue;
    }
    // Recognize file_<archkey> + sha256_<archkey>. Drop unknown keys.
    const m = key.match(/^(file|sha256)_(linux_(?:x64|arm64)|darwin_arm64)$/);
    if (!m) continue;
    const [, kind, archKey] = m;
    const arch = (out.arches[archKey] ||= {});
    // First occurrence wins (matches install.sh's manifest_get shape).
    if (kind === "file") arch.file ??= value;
    else arch.sha ??= value;
  }
  return out;
}

// Validate a parsed sidecar — every arch must have both `file` and `sha`.
function validateSidecar(parsed, source) {
  if (!parsed.version) die(`${source}: missing version=`);
  for (const [archKey, { file, sha }] of Object.entries(parsed.arches)) {
    if (!file) die(`${source}: missing file_${archKey}`);
    if (!sha) die(`${source}: missing sha256_${archKey}`);
  }
}

function parseArgs(argv) {
  const positional = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i];
    else positional.push(argv[i]);
  }
  if (positional.length === 0) die("no sidecar inputs — pass at least one .txt");
  if (!outPath) die("missing --out <path>");
  return { inputs: positional, outPath };
}

async function main() {
  const { inputs, outPath } = parseArgs(process.argv.slice(2));
  let version = null;
  let gitSha = null;
  // A sidecar built outside a git checkout carries no commit. Tracked
  // separately from `gitSha` so "nobody reported one" is distinguishable from
  // "one arch reported one and another didn't" — see the emit rule below.
  let missingGitSha = false;
  // Order of insertion = order of sidecar args = order in the combined file.
  const arches = {};
  for (const input of inputs) {
    const body = await readFile(input, "utf-8");
    const parsed = parseSidecar(body);
    validateSidecar(parsed, input);
    if (version === null) version = parsed.version;
    else if (parsed.version !== version) {
      die(`version mismatch: ${input} has version=${parsed.version}, expected ${version} (sidecar args must come from the same release commit)`);
    }
    // Two arches built from different commits is the failure this check
    // exists for — publishing them under one manifest would ship a release
    // whose halves disagree about what they contain.
    if (parsed.gitSha === null) missingGitSha = true;
    else if (gitSha === null) gitSha = parsed.gitSha;
    else if (parsed.gitSha !== gitSha) {
      die(`git_sha mismatch: ${input} has git_sha=${parsed.gitSha}, expected ${gitSha} (sidecar args must come from the same release commit)`);
    }
    for (const [archKey, entry] of Object.entries(parsed.arches)) {
      arches[archKey] = entry;
    }
  }
  const lines = [`version=${version}`];
  // Emit the commit ONLY when every sidecar agreed on one. A partial answer
  // would be worse than none: a box whose own arch was built without a commit
  // stamp would compare its null against the published sha, never match, and
  // reinstall the same tarball on every single update check — forever. Falling
  // back to the version-only comparison is the safe degradation.
  if (gitSha !== null && !missingGitSha) {
    lines.push(`git_sha=${gitSha}`);
  } else if (gitSha !== null) {
    log(`⚠ dropping git_sha — not every sidecar carried one; boxes fall back to comparing versions`);
  }
  for (const [archKey, { file, sha }] of Object.entries(arches)) {
    lines.push(`file_${archKey}=${file}`);
    lines.push(`sha256_${archKey}=${sha}`);
  }
  await writeFile(outPath, lines.join("\n") + "\n");
  log(`merged ${inputs.length} sidecar(s) → ${outPath} (${Object.keys(arches).join(", ")})`);
}

main().catch((e) => die(String(e?.stack ?? e)));
