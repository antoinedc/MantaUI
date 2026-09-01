#!/usr/bin/env node
// scripts/sync-release-fallback.mjs — single-source the four release helpers
// that install.sh must carry inline for its `curl -fsSL … | bash` mode.
//
// install.sh sources scripts/lib/release.sh when a local copy exists (dev
// checkout, an installed box re-running it, or the test harness) — but in its
// PRIMARY mode, `curl … | bash`, there is NO local file yet (the tarball that
// carries the lib is downloaded MID-install) and a piped script cannot read a
// sibling. So install.sh also carries an inline fallback of the four helpers:
// manifest_get, resolve_arch, _sha256_of, verify_sha256.
//
// That fallback is the residual duplicate BET-643 exists to de-risk. Running
// this script REGENERATES the fallback verbatim from scripts/lib/release.sh —
// the single source of truth — so a future edit to a helper in the lib is
// pushed into install.sh automatically instead of drifting silently.
//
// This is a dev-time/CI-time generator whose OUTPUT IS COMMITTED, matching the
// "install.sh is served byte-identical across channels" contract in its header:
// the served copy is still the repo's own install.sh, just with a fallback that
// is guaranteed (and CI-checked, see sync-release-fallback.test.mjs) to match
// the lib. No publication-time substitution, no change to the one-liner.
//
// Usage:
//   node scripts/sync-release-fallback.mjs         # rewrite install.sh in place
//   node scripts/sync-release-fallback.mjs --check # exit 1 if install.sh is stale
//
// Exits 0 when the fallback is up to date, non-zero otherwise. Deterministic and
// idempotent: running it on an already-synced tree is a no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..");
export const RELEASE_SH = join(__dirname, "lib", "release.sh");
export const INSTALL_SH = join(__dirname, "install.sh");

// The fallback's marker boundary inside install.sh. The block between the BEGIN
// and END marker lines (exclusive) is exactly the four extracted helpers.
export const BEGIN_MARKER =
  "# >>> BEGIN GENERATED — scripts/sync-release-fallback.mjs — do not edit by hand <<<";
export const END_MARKER =
  "# >>> END GENERATED — scripts/sync-release-fallback.mjs — do not edit by hand <<<";

// The four helpers shared between the lib and the piped fallback. Every name
// MUST exist in scripts/lib/release.sh and be absent there only if the fallback
// should not ship it (sync_opencode_guidance is deliberately NOT here — it
// lives only in the lib, sourced post-extraction from $MANTA_HOME).
export const HELPER_NAMES = [
  "manifest_get",
  "resolve_arch",
  "_sha256_of",
  "verify_sha256",
  // BET-1503: install.sh renders the opencode unit / LaunchAgent (and the
  // nohup fallback) with the Claude Code version the box should claim to
  // Anthropic, so the resolver has to exist in piped mode too — otherwise the
  // substitution would silently render an empty value on the primary install
  // path. The patcher functions are NOT here: only self-update calls them, and
  // self-update always sources the lib.
  "version_gte",
  "claude_cli_version",
  "manta_claude_cli_version_floor",
  "resolve_anthropic_cli_version",
];

// Extract one helper (its preceding contiguous `#` comment block + the function
// body up to its column-0 closing `}`) from a line array. Returns the slice as
// an array of lines. Throws if the function is not found or has no close.
export function extractHelper(lines, name) {
  const startRe = new RegExp(`^${name}\\(\\) \\{`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error(`helper not found in release.sh: ${name}`);

  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === "}") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`helper has no closing brace: ${name}`);

  let cstart = start;
  while (cstart > 0 && lines[cstart - 1].startsWith("#")) cstart--;

  return lines.slice(cstart, end + 1);
}

// Build the fallback block text from the release.sh source lines: each helper
// unit (comment + body) joined by a single blank line, like the lib lays them
// out, with no trailing blank line beyond the final newline.
export function buildFallbackBlock(lines, names = HELPER_NAMES) {
  const units = names.map((n) => extractHelper(lines, n).join("\n"));
  return units.join("\n\n") + "\n";
}

// Locate the marker boundary in install.sh. Returns { startIdx, endIdx } where
// startIdx is the BEGIN line and endIdx is the END line (both inclusive).
export function findFallbackBoundary(installLines) {
  const startIdx = installLines.findIndex((l) => l.trim() === BEGIN_MARKER);
  const endIdx = installLines.findIndex((l) => l.trim() === END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      "install.sh has no valid BEGIN/END fallback markers — " +
        "did the generated block get removed?",
    );
  }
  return { startIdx, endIdx };
}

// Extract the committed fallback block (the text between markers, exclusive)
// from install.sh, preserving line structure for byte comparison.
export function extractFallbackBlock(installLines) {
  const { startIdx, endIdx } = findFallbackBoundary(installLines);
  return installLines.slice(startIdx + 1, endIdx).join("\n") + "\n";
}

export function readReleaseLines() {
  return readFileSync(RELEASE_SH, "utf8").split("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const releaseLines = readReleaseLines();
  let install = readFileSync(INSTALL_SH, "utf8");
  const installLines = install.split("\n");

  const { startIdx, endIdx } = findFallbackBoundary(installLines);
  const generated = buildFallbackBlock(releaseLines);
  const committed = extractFallbackBlock(installLines);

  if (generated === committed) {
    process.stdout.write(
      "sync-release-fallback: install.sh fallback is up to date with scripts/lib/release.sh\n",
    );
    return 0;
  }

  if (check) {
    process.stderr.write(
      "sync-release-fallback: install.sh fallback is STALE vs scripts/lib/release.sh.\n" +
        "  Run `node scripts/sync-release-fallback.mjs` and commit the result.\n",
    );
    return 1;
  }

  install =
    installLines.slice(0, startIdx + 1).join("\n") +
    "\n" +
    generated +
    installLines.slice(endIdx).join("\n");
  writeFileSync(INSTALL_SH, install);
  process.stdout.write(
    "sync-release-fallback: regenerated install.sh fallback from scripts/lib/release.sh\n",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
