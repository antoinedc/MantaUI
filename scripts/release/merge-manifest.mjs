#!/usr/bin/env node
// merge-manifest.mjs — merge N per-arch release manifest sidecars (one per
// pack.mjs --arch invocation) into a single combined manifest the installer
// fetches.
//
//   node scripts/release/merge-manifest.mjs <sidecar1.txt> [<sidecar2.txt> ...] --out <combined.txt>
//
// Each sidecar carries `version=`, `file_<archkey>=`, `sha256_<archkey>=` where
// `<archkey>` is the underscore form (`linux_x64`, `linux_arm64`). The combined
// manifest echoes `version=` first, then each sidecar's arch pair in the order
// the sidecars were passed in. Unknown keys are dropped silently (forward
// compatibility). Mismatched `version=` between sidecars is a hard error —
// that means the two arch builds are from different commits.
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
// `archKey` is the underscore form (linux_x64 / linux_arm64). Values may
// contain `=` — split on the first one only.
function parseSidecar(body) {
  const out = { version: null, arches: {} };
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "version") {
      if (out.version === null) out.version = value;
      continue;
    }
    // Recognize file_<archkey> + sha256_<archkey>. Drop unknown keys.
    const m = key.match(/^(file|sha256)_(linux_(?:x64|arm64))$/);
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
    for (const [archKey, entry] of Object.entries(parsed.arches)) {
      arches[archKey] = entry;
    }
  }
  const lines = [`version=${version}`];
  for (const [archKey, { file, sha }] of Object.entries(arches)) {
    lines.push(`file_${archKey}=${file}`);
    lines.push(`sha256_${archKey}=${sha}`);
  }
  await writeFile(outPath, lines.join("\n") + "\n");
  log(`merged ${inputs.length} sidecar(s) → ${outPath} (${Object.keys(arches).join(", ")})`);
}

main().catch((e) => die(String(e?.stack ?? e)));
