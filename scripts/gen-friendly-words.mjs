// gen-friendly-words.mjs — dev-only, run BY HAND. Never at build or run time.
//
// Vendors the adjective + noun word lists from friendly-words@1.3.1 (the
// package that powers Glitch's generated project names) into
// src/shared/friendlyWords.mjs so the generated three-word project name
// (src/shared/projectName.mjs) needs no npm dependency at runtime.
//
// friendly-words is deliberately NOT added to package.json: its published
// `dependencies` include `express` and `ava`, which we must not inherit. This
// script downloads the pinned tarball on demand and writes the two frozen
// arrays.
//
// The word counts are ASSERTED (1391 adjectives / 2907 nouns) so an upstream
// change fails loudly and a human looks, rather than silently regenerating a
// different list.
//
// Regenerate with: node scripts/gen-friendly-words.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.3.1";
const TARBALL = `https://registry.npmjs.org/friendly-words/-/friendly-words-${VERSION}.tgz`;

const EXPECTED_ADJECTIVES = 1391;
const EXPECTED_NOUNS = 2907;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../src/shared/friendlyWords.mjs");

// --norm: trim, lowercase, keep entries matching ^[a-z]{2,10}$, de-dupe,
// sort ascending. One word per line in the source files.
function norm(raw) {
  const words = raw
    .split("\n")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]{2,10}$/.test(w));
  return [...new Set(words)].sort();
}

function readList(dir, file) {
  return readFileSync(join(dir, "package", "words", file), "utf8");
}

// Download + extract into a throwaway temp dir (never installed, never in
// package.json).
const tmp = mkdtempSync(join(tmpdir(), "friendly-words-"));
try {
  const archive = join(tmp, "friendly-words.tgz");
  execFileSync("curl", ["-fsSL", TARBALL, "-o", archive], { stdio: "pipe" });
  execFileSync("tar", ["-xzf", archive, "-C", tmp], { stdio: "pipe" });

  const adjectives = norm(readList(tmp, "predicates.txt"));
  const nouns = norm(readList(tmp, "objects.txt"));

  if (adjectives.length !== EXPECTED_ADJECTIVES) {
    throw new Error(
      `friendly-words@${VERSION} predicates.txt has ${adjectives.length} entries, expected ${EXPECTED_ADJECTIVES}. Upstream changed — a human must look before vendoring.`,
    );
  }
  if (nouns.length !== EXPECTED_NOUNS) {
    throw new Error(
      `friendly-words@${VERSION} objects.txt has ${nouns.length} entries, expected ${EXPECTED_NOUNS}. Upstream changed — a human must look before vendoring.`,
    );
  }

  const fmt = (arr) =>
    arr
      .map((w) => `  "${w}"`)
      .join(",\n");

  const out = `// GENERATED FILE - do not edit by hand.
// Regenerate with: node scripts/gen-friendly-words.mjs
//
// Source: friendly-words@${VERSION} (https://github.com/glitchdotcom/friendly-words)
// MIT License, Copyright (c) 2018 Glitch
export const ADJECTIVES = Object.freeze([
${fmt(adjectives)}
]);

export const NOUNS = Object.freeze([
${fmt(nouns)}
]);
`;

  writeFileSync(OUT, out);
  console.log(
    `Wrote ${OUT} (${adjectives.length} adjectives, ${nouns.length} nouns)`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
