#!/usr/bin/env node
// guidance-history.mjs — regenerate docs/opencode-tools/AGENTS.history.
//
//   node scripts/release/guidance-history.mjs
//
// AGENTS.history lists every (heading, canonical hash) that ANY committed
// version of docs/opencode-tools/AGENTS.md ever had. The box-side
// `sync_opencode_guidance` (scripts/lib/release.sh) uses it to tell a section
// the user never touched (safe to refresh) from one they edited (left alone).
// Run this whenever docs/opencode-tools/AGENTS.md changes, and commit the result.
//
// The parser below is the JS twin of `_guidance_split` in scripts/lib/release.sh
// (spec: docs/superpowers/specs/2026-10-27-guidance-section-refresh.md §1). The two
// must produce identical hashes; scripts/lib/guidance-sync.test.mjs pins that.
//
// The file is APPEND-ONLY: existing lines are merged with the walk's output and
// never dropped. Refuses to run on a shallow clone (a shallow walk would miss
// older versions). Prints headings that appear in history but not in the current
// file — candidates for docs/opencode-tools/AGENTS.aliases (renames).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REL = "docs/opencode-tools/AGENTS.md";
const HISTORY_REL = "docs/opencode-tools/AGENTS.history";
const ALIASES_REL = "docs/opencode-tools/AGENTS.aliases";

const BLANK = /^[ \t]*$/;

function fenceRun(line) {
  let i = 0;
  while (line[i] === " ") i++;
  if (i > 3) return null;
  const c = line[i];
  if (c !== "`" && c !== "~") return null;
  let j = i;
  while (line[j] === c) j++;
  if (j - i < 3) return null;
  return { char: c, len: j - i, rest: line.slice(j) };
}

/**
 * Split markdown into `## ` sections. Returns [{ heading, lines, canonical, hash }]
 * where `lines` is the section's CR-stripped line span and `canonical` its hashed
 * bytes (trailing blank lines dropped, exactly one final "\n").
 */
export function parseSections(text) {
  const all = text.split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  const sections = [];
  let cur = null;
  let fence = null;
  for (const raw of all) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let isStart = false;
    if (fence) {
      const f = fenceRun(line);
      if (f && f.char === fence.char && f.len >= fence.len && BLANK.test(f.rest)) fence = null;
    } else if (line.startsWith("## ")) {
      isStart = true;
    } else {
      const f = fenceRun(line);
      if (f) fence = { char: f.char, len: f.len };
    }
    if (isStart) {
      cur = { heading: line.replace(/[ \t\r]+$/, ""), lines: [] };
      sections.push(cur);
    }
    if (cur) cur.lines.push(line);
  }
  for (const s of sections) {
    let last = s.lines.length;
    while (last > 0 && BLANK.test(s.lines[last - 1])) last--;
    s.canonical = s.lines.slice(0, last).join("\n") + "\n";
    s.hash = createHash("sha256").update(s.canonical, "utf8").digest("hex");
  }
  return sections;
}

/** History lines ("heading\thash") for one version of the file. */
export function historyLines(text) {
  return parseSections(text)
    .filter((s) => !s.heading.includes("\t"))
    .map((s) => `${s.heading}\t${s.hash}`);
}

/** Merge existing history lines with new ones: union, deduplicated, sorted. Never drops a line. */
export function mergeHistory(existing, incoming) {
  const set = new Set();
  for (const l of existing) if (l.trim() !== "") set.add(l.replace(/\r$/, ""));
  for (const l of incoming) set.add(l);
  return [...set].sort();
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Every committed version of the guidance file, newest first: [{ sha, text }]. */
export function collectVersions(root) {
  const out = git(root, ["log", "--follow", "--name-only", "--format=format:%H", "--", SOURCE_REL]);
  const versions = [];
  let sha = null;
  for (const line of out.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) sha = line;
    else if (line !== "" && sha) {
      try {
        versions.push({ sha, text: git(root, ["show", `${sha}:${line}`]) });
      } catch {
        // the commit that deleted/moved the path has no copy at that name
      }
      sha = null;
    }
  }
  return versions;
}

export function generate({ root, write = true } = {}) {
  const repoRoot = root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (git(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("shallow clone: AGENTS.history needs the full git history (run `git fetch --unshallow`)");
  }
  const historyPath = join(repoRoot, HISTORY_REL);
  const existing = existsSync(historyPath) ? readFileSync(historyPath, "utf8").split("\n") : [];
  const incoming = [];
  const versions = collectVersions(repoRoot);
  for (const v of versions) incoming.push(...historyLines(v.text));
  const merged = mergeHistory(existing, incoming);
  if (write) writeFileSync(historyPath, merged.join("\n") + "\n");

  const current = new Set(parseSections(readFileSync(join(repoRoot, SOURCE_REL), "utf8")).map((s) => s.heading));
  const aliasesPath = join(repoRoot, ALIASES_REL);
  const aliased = new Set(
    existsSync(aliasesPath)
      ? readFileSync(aliasesPath, "utf8").split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[0])
      : [],
  );
  const gone = [...new Set(merged.map((l) => l.slice(0, l.indexOf("\t"))))].filter((h) => !current.has(h));
  return { merged, versions: versions.length, aliasCandidates: gone.filter((h) => !aliased.has(h)), gone };
}

function main() {
  const r = generate();
  process.stdout.write(`▸ ${HISTORY_REL}: ${r.merged.length} (heading, hash) lines from ${r.versions} versions\n`);
  if (r.aliasCandidates.length) {
    process.stdout.write(`▸ headings in history but not in the current file (alias candidates — add "old<TAB>new" to ${ALIASES_REL} for renames):\n`);
    for (const h of r.aliasCandidates) process.stdout.write(`  ${h}\n`);
  } else {
    process.stdout.write(`▸ no un-aliased headings have disappeared from the current file\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
