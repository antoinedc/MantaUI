#!/usr/bin/env node
// Keeps `src/server/agentTemplates/<slug>/.history.json` current (Architect v2, Stage 0).
//
// The file maps each template file's relative path to the sha256 of every version of it that was ever shipped, oldest first,
// the shipped one last. The agents engine reads it at boot: a box file that still matches one of those hashes is unedited
// and is replaced by the new version; anything else is merged against the `.base` copy.
//
// `<slug>/.versions/<sha256>` holds the TEXT of every hash in the history. A box with no `.base` copy (one from before base
// copies existed) can't say which shipped version its edited file came from, so the engine tries each older version as the
// merge base until one merges cleanly. Hashes alone can't do that.
//
//   node scripts/agents/template-history.mjs             append the hashes of the files as they are now
//   node scripts/agents/template-history.mjs --backfill  also add every earlier committed version (git history)
//   node scripts/agents/template-history.mjs --check     change nothing; exit 1 when a file is not in its history
//
// Run it after editing any file under src/server/agentTemplates/ (src/server/agentTemplates.test.mjs fails otherwise).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const HISTORY_FILE = ".history.json";
export const VERSIONS_DIR = ".versions";
export const TEMPLATES_DIR = fileURLToPath(new URL("../../src/server/agentTemplates", import.meta.url));

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The relative paths of a template folder's shipped files (recursive, sorted; dot entries are bookkeeping, not template). */
export async function templateFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

/** `history` with the current hash of each file appended (once) and moved last. `files`: `{ rel: hash }`. Pure. */
export function historyOf(history, files) {
  const out = {};
  for (const [rel, hash] of Object.entries(files)) {
    const kept = (Array.isArray(history?.[rel]) ? history[rel] : []).filter((h) => h !== hash);
    out[rel] = [...kept, hash];
  }
  return out;
}

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, ...opts });

/** Every committed version of `repoPath`, oldest first, as `[hash, bytes]` (a path that was never committed has none). */
function committedVersions(repoPath) {
  let shas;
  try {
    shas = git(["log", "--format=%H", "--reverse", "--", repoPath]).toString("utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const versions = new Map();
  for (const sha of shas) {
    try {
      const bytes = git(["show", `${sha}:${repoPath}`], { stdio: ["ignore", "pipe", "ignore"] });
      const h = sha256(bytes);
      if (!versions.has(h)) versions.set(h, bytes);
    } catch {
      /* the file did not exist in that commit (a deletion) */
    }
  }
  return [...versions];
}

const hasVersion = (dir, hash) => readFile(join(dir, VERSIONS_DIR, hash)).then((b) => sha256(b) === hash, () => false);
const asyncFilter = async (list, keep) => {
  const out = [];
  for (const x of list) if (await keep(x)) out.push(x);
  return out;
};

async function readHistory(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Update (or, with `check`, only verify) every template's history. Returns the paths that were out of date. */
export async function updateHistories({ templatesDir = TEMPLATES_DIR, backfill = false, check = false } = {}) {
  const stale = [];
  const slugs = (await readdir(templatesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const slug of slugs) {
    const dir = join(templatesDir, slug);
    const path = join(dir, HISTORY_FILE);
    const before = await readHistory(path);
    const files = {};
    for (const rel of await templateFiles(dir)) files[rel] = sha256(await readFile(join(dir, rel)));
    let next = historyOf(before, files);
    const texts = new Map(); // hash → bytes, for what `.versions/` should hold
    for (const rel of Object.keys(files)) texts.set(files[rel], await readFile(join(dir, rel)));
    if (backfill) {
      const repo = relative(fileURLToPath(new URL("../..", import.meta.url)), dir).split("\\").join("/");
      for (const rel of Object.keys(files)) {
        const older = committedVersions(`${repo}/${rel}`);
        for (const [h, bytes] of older) texts.set(h, bytes);
        // oldest first: committed order first, then anything the file already held that we still have the text of (a hash that was
        // never committed, nor kept in .versions, was never on main and so never reached a box: it is dropped), the shipped hash last
        const kept = await asyncFilter(before[rel] ?? [], (h) => h !== files[rel] && (texts.has(h) || hasVersion(dir, h)));
        next[rel] = [...new Set([...older.map(([h]) => h).filter((h) => h !== files[rel]), ...kept, files[rel]])];
      }
    }
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (text !== (await readFile(path, "utf-8").catch(() => null))) {
      stale.push(`${slug}/${HISTORY_FILE}`);
      if (!check) await writeFile(path, text, "utf-8");
    }
    // the text of every version in the history, by hash (never removed: a version once shipped may still be on a box)
    const versionsDir = join(dir, VERSIONS_DIR);
    for (const h of new Set(Object.values(next).flat())) {
      const bytes = texts.get(h);
      const have = await hasVersion(dir, h);
      if (have) continue;
      stale.push(`${slug}/${VERSIONS_DIR}/${h.slice(0, 12)}`);
      if (!check && bytes) {
        await mkdir(versionsDir, { recursive: true });
        await writeFile(join(versionsDir, h), bytes);
      }
    }
  }
  return stale;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const stale = await updateHistories({ backfill: args.has("--backfill"), check });
  if (check && stale.length > 0) {
    console.error(`out of date: ${stale.join(", ")}\nrun: node scripts/agents/template-history.mjs`);
    process.exit(1);
  }
  console.log(stale.length > 0 ? `${check ? "out of date" : "updated"}: ${stale.join(", ")}` : "histories are current");
}
