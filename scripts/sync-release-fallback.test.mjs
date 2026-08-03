// scripts/sync-release-fallback.test.mjs — the byte-parity gate for BET-643.
//
// install.sh carries an inline fallback of the four release helpers
// (manifest_get, resolve_arch, _sha256_of, verify_sha256) for its PRIMARY
// `curl -fsSL … | bash` mode, where scripts/lib/release.sh isn't on disk yet.
// That fallback is generated from scripts/lib/release.sh by
// sync-release-fallback.mjs — the single source of truth. This test is what
// makes drift IMPOSSIBLE to ship: it regenerates the fallback in memory and
// fails if the committed block in install.sh differs by even one byte. A future
// edit to a helper in the lib (but not the fallback, or vice-versa) turns CI
// red instead of silently ghosting the two copies apart.
//
// Fix: run `node scripts/sync-release-fallback.mjs` and commit the result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INSTALL_SH,
  BEGIN_MARKER,
  HELPER_NAMES,
  buildFallbackBlock,
  extractFallbackBlock,
  extractHelper,
  readReleaseLines,
} from "./sync-release-fallback.mjs";

const releaseLines = readReleaseLines();
const installLines = readFileSync(INSTALL_SH, "utf8").split("\n");

test("release fallback: install.sh committed block is byte-identical to a regeneration from the lib", () => {
  const generated = buildFallbackBlock(releaseLines, HELPER_NAMES);
  const committed = extractFallbackBlock(installLines);
  assert.equal(
    committed,
    generated,
    [
      "install.sh's inline fallback has drifted from scripts/lib/release.sh.",
      "Run `node scripts/sync-release-fallback.mjs` and commit the result.",
    ].join("\n"),
  );
});

test("release fallback: every helper lives in the lib (single source of truth)", () => {
  for (const name of HELPER_NAMES) {
    assert.doesNotThrow(
      () => extractHelper(releaseLines, name),
      `helper ${name} should exist in scripts/lib/release.sh`,
    );
  }
});

test("release fallback: install.sh still defines every helper (no helper dropped)", () => {
  for (const name of HELPER_NAMES) {
    const body = [...installLines].slice(
      installLines.findIndex((l) => l.includes(BEGIN_MARKER)),
    );
    const found = body.some((l) => {
      const re = new RegExp(`^${name}\\(\\) \\{`);
      return re.test(l);
    });
    assert.ok(found, `install.sh fallback should define ${name}`);
  }
});

