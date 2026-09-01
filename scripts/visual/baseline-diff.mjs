#!/usr/bin/env node
/**
 * scripts/visual/baseline-diff.mjs — one side-by-side before/after image per
 * changed visual baseline.
 *
 * Recording a baseline is the moment of judgement in this system: layers 1
 * and 2 compare the app to its own committed record, so both stay green when
 * the record itself is wrong, and a baseline first recorded from a broken
 * render locks the breakage in. The only defence is a person looking at the
 * picture once — with the "before" beside the new one, since a lone "after"
 * is nearly unreadable. This script turns "this PR re-recorded a baseline"
 * into one labelled composite PNG per changed baseline, pulled straight from
 * git (no hook into Playwright, no second capture run).
 *
 * Usage:
 *   node scripts/visual/baseline-diff.mjs            # vs origin/main
 *   node scripts/visual/baseline-diff.mjs --base HEAD~1
 *
 * Exit codes: 0 always — a no-change run prints "no baseline changes" and
 * never fails a pipeline.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";
import { ROOT } from "./harness.mjs";
import { writeComposite } from "./composite.mjs";

const OUT_DIR = join(ROOT, ".visual-out");
const SNAPSHOT_GLOB = "tests/visual/screens.visual.ts-snapshots/*.png";

function log(msg) {
  process.stdout.write(`[visual:baselines] ${msg}\n`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** `git show <rev>:<path>` as a binary Buffer (the committed "before"). */
function gitShow(rev, path) {
  return execFileSync("git", ["show", `${rev}:${path}`], { cwd: ROOT });
}

/**
 * True when this checkout has truncated history (`.git/shallow` present —
 * `git clone --depth N`, a throwaway checkout, …). Memoized; a non-repo reads
 * as not-shallow. (BET-1500: on a shallow clone the base rev's blob objects
 * can be absent and `git show` dies with a bare git "object not found" that
 * does not point at the real cause — say shallow instead.)
 */
let shallow;
function isShallowRepo() {
  if (shallow === undefined) {
    try {
      shallow = git(["rev-parse", "--is-shallow-repository"]) === "true";
    } catch {
      shallow = false;
    }
  }
  return shallow;
}

/** List every baseline PNG modified and added against `base`, in git order. */
function changedBaselines(base) {
  const modified = git([
    "diff",
    "--name-only",
    "--diff-filter=M",
    base,
    "--",
    SNAPSHOT_GLOB,
  ])
    .split("\n")
    .filter(Boolean);
  const added = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    base,
    "--",
    SNAPSHOT_GLOB,
  ])
    .split("\n")
    .filter(Boolean);
  return [
    ...modified.map((path) => ({ path, kind: "modified" })),
    ...added.map((path) => ({ path, kind: "new" })),
  ];
}

/** A plain mid-grey panel matching the image's dimensions — the "before" of a brand-new baseline. */
async function greyPanelLike(png) {
  const { width, height } = await sharp(png).metadata();
  return sharp({
    create: { width, height, channels: 3, background: "#808080" },
  })
    .png()
    .toBuffer();
}

async function main() {
  const baseIdx = process.argv.indexOf("--base");
  const base = baseIdx !== -1 ? process.argv[baseIdx + 1] : "origin/main";

  const changed = changedBaselines(base);

  if (changed.length === 0) {
    log("no baseline changes");
    process.exit(0);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  for (const { path, kind } of changed) {
    const name = basename(path, ".png");
    const after = readFileSync(join(ROOT, path));
    let before;
    let labels;
    if (kind === "new") {
      before = await greyPanelLike(after);
      labels = ["(new — no prior baseline)", "after"];
      log(`new baseline      → ${name}.png (no prior baseline, grey panel)`);
    } else {
      try {
        before = gitShow(base, path);
      } catch (e) {
        if (isShallowRepo()) {
          log(
            `shallow clone: run \`git fetch --unshallow origin\` — the committed ` +
              `"before" blob for ${path} at ${base} is absent from the truncated ` +
              `history (git: ${String(e?.message ?? e).split("\n")[0]})`,
          );
          process.exit(1);
        }
        throw e;
      }
      labels = ["before", "after"];
      log(`re-recorded       → ${name}.png`);
    }
    const outPath = join(OUT_DIR, `${name}.before-after.png`);
    const width = await writeComposite(before, after, outPath, labels);
    log(`wrote composite   → .visual-out/${name}.before-after.png (${width}×…)`);
  }
}

main().catch((e) => {
  process.stderr.write(`[visual:baselines] FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
