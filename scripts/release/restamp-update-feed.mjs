#!/usr/bin/env node
// restamp-update-feed.mjs — rewrite electron-builder's `latest-mac.yml` so its
// checksums describe the DMG we ACTUALLY publish.
//
//   node scripts/release/restamp-update-feed.mjs dist/desktop/latest-mac.yml
//
// WHY THIS EXISTS
// ---------------
// electron-builder writes `latest-mac.yml` (the electron-updater feed) at the
// end of `electron-builder --mac`, recording each artifact's sha512 + size.
// The codemagic `mac-desktop` workflow then runs a LATER step that
// `codesign --force`s the DMG, submits it to the notary service, and staples
// the ticket into it. Stapling REWRITES the file — ~11KB larger, completely
// different hash.
//
// The feed is never regenerated, so it permanently describes a pre-staple file
// that no longer exists anywhere. electron-updater downloads the published DMG,
// verifies it against the feed's sha512, gets a mismatch, and REFUSES to
// install. Auto-update is dead on arrival — and silently, because the desktop's
// updater error handler only console.warn()s (src/main/autoUpdate.ts), so the
// user sees no banner and no error, just an app that never updates.
//
// Shipped broken in every notarized release (0.0.13, 0.0.14 — both verified
// against prod: feed size 98214660/97241753 vs actual 98226318/97253264).
//
// Run this AFTER the staple step and BEFORE publish, and the feed matches.
//
// The alternative — staple before electron-builder writes the feed — is not
// available: electron-builder owns both the DMG creation and the feed write in
// one invocation, and only notarizes the .app INSIDE the DMG, never the DMG.
//
// Pure node + the `yaml` dep (already a desktop runtime dependency).

import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import YAML from "yaml";

function die(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(`▸ ${msg}\n`);
}

/**
 * electron-updater's checksum encoding: base64 of the raw sha512 digest (NOT
 * hex). Getting this wrong produces a feed that parses fine and fails every
 * update — the exact failure mode this script exists to fix — so it is pinned
 * by a test against a known vector.
 */
export function sha512Base64(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

/**
 * Rewrite a parsed latest-mac.yml so every `files[]` entry carries the real
 * size + sha512 of the artifact on disk, and the legacy top-level `sha512` /
 * `size` mirror whichever entry `path` names.
 *
 * Pure: takes the parsed feed + a { filename -> {sha512, size} } lookup and
 * returns a NEW feed object. All IO stays in main().
 *
 * @param feed  parsed latest-mac.yml
 * @param stats { [filename]: { sha512: string, size: number } }
 * @returns { feed, changed: string[] } — `changed` lists files whose digest or
 *          size actually moved (empty = the staple step was a no-op and the
 *          feed was already correct).
 */
export function restampFeed(feed, stats) {
  if (!feed || typeof feed !== "object") die("feed is not an object");
  const files = Array.isArray(feed.files) ? feed.files : [];
  if (files.length === 0) die("feed has no files[] entries — refusing to write an empty feed");

  const changed = [];
  const nextFiles = files.map((entry) => {
    const name = entry?.url;
    if (typeof name !== "string" || name === "") die("a files[] entry has no url");
    const s = stats[name];
    // A file named in the feed but missing on disk means the publish would ship
    // a feed pointing at nothing. Fail loudly rather than silently keep the
    // stale digest — a stale digest is precisely the bug.
    if (!s) die(`feed references "${name}" but it was not found on disk`);
    if (entry.sha512 !== s.sha512 || entry.size !== s.size) changed.push(name);
    return { ...entry, sha512: s.sha512, size: s.size };
  });

  const next = { ...feed, files: nextFiles };

  // The top-level `path` + `sha512` are the legacy single-artifact fields
  // older electron-updater builds read. They must mirror the matching files[]
  // entry or a client on the old path re-introduces the mismatch.
  if (typeof next.path === "string") {
    const primary = nextFiles.find((f) => f.url === next.path);
    if (!primary) die(`feed.path "${next.path}" does not match any files[] entry`);
    next.sha512 = primary.sha512;
    // electron-builder omits a top-level `size`; only mirror it when present.
    if ("size" in next) next.size = primary.size;
  }

  return { feed: next, changed };
}

async function main() {
  const feedPath = process.argv[2];
  if (!feedPath) die("usage: restamp-update-feed.mjs <path/to/latest-mac.yml>");

  const raw = await readFile(feedPath, "utf-8");
  const feed = YAML.parse(raw);
  const dir = dirname(feedPath);

  const names = (Array.isArray(feed?.files) ? feed.files : [])
    .map((f) => f?.url)
    .filter((u) => typeof u === "string" && u !== "");

  const stats = {};
  for (const name of names) {
    const full = join(dir, name);
    try {
      const [buf, st] = await Promise.all([readFile(full), stat(full)]);
      stats[name] = { sha512: sha512Base64(buf), size: st.size };
    } catch {
      die(`cannot read artifact "${full}" referenced by the feed`);
    }
  }

  const { feed: next, changed } = restampFeed(feed, stats);

  if (changed.length === 0) {
    log(`update feed already matches the artifacts on disk (${names.join(", ")}) — nothing to restamp`);
    return;
  }

  await writeFile(feedPath, YAML.stringify(next));
  for (const name of changed) {
    log(`restamped ${name} → sha512=${stats[name].sha512.slice(0, 16)}… size=${stats[name].size}`);
  }
  log(`wrote ${feedPath} — electron-updater will now validate the published DMG`);
}

// Only run main() when invoked as a CLI, so the pure helpers stay importable
// from the test file without triggering argv parsing.
if (process.argv[1] && process.argv[1].endsWith("restamp-update-feed.mjs")) {
  main().catch((e) => die(String(e?.stack ?? e)));
}
