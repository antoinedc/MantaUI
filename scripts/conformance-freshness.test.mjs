import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SCREENS } from "./visual/screens.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SNAPSHOTS = "tests/visual/screens.visual.ts-snapshots";

const gitBuf = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "buffer" });

/**
 * True when this checkout has truncated history (`.git/shallow` present —
 * `git clone --depth N`, a CI depth-1 graft, …). Memoized; a repo that is not
 * a git repo at all reads as not-shallow so the per-test failures below keep
 * their ordinary STALE meaning. (BET-1491: on a shallow clone an old
 * recordSha's objects are absent, `git show` fails, and the unreachable case
 * below must not be reported as STALE — the record may be perfectly fresh;
 * the clone simply cannot prove it either way.)
 */
let shallow;
const isShallowRepo = () => {
  if (shallow === undefined) {
    try {
      shallow = gitBuf(["rev-parse", "--is-shallow-repository"]).toString().trim() === "true";
    } catch {
      shallow = false;
    }
  }
  return shallow;
};

/**
 * Freshness of conformance records (BET-564). A conformance record is
 * judgement — no test can arbitrate what it says. But whether a record has
 * been LOOKED AT since its screen's baseline moved is mechanical, and that
 * is what this test asserts: a record whose "Last reviewed" sha predates the
 * last change to its pixel baseline is stale by construction, because it was
 * written before the thing it claims to describe.
 *
 * Mechanism (git, not file mtimes — mtimes lie after a fresh clone):
 *   recordSha       = the sha on the "Last reviewed" line
 *   reviewedBlob    = the committed <id>-visual-linux.png at recordSha
 *   FAIL            = reviewedBlob differs from the baseline on disk — the
 *                     baseline moved after the review — or is unreachable at
 *                     recordSha. Unreachable on a FULL clone means the record
 *                     is stale (the baseline appeared after the review, or the
 *                     sha is bad); unreachable on a SHALLOW clone only means
 *                     the history is truncated, so that case fails with its
 *                     own unshallow message instead of claiming STALE (BET-1491).
 *
 * We compare BLOB CONTENT at recordSha, NOT commit ancestry. Computing "the
 * last commit that touched a path" via `git log -- <path>` is not
 * deterministic on CI: GitHub checks out the pull-request MERGE ref and, in
 * typecheck-test, additionally runs `git fetch --depth=1 origin main`, which
 * grafts main's tip as a shallow root. A path-limited `git log` then treats
 * that grafted root as having touched EVERY path (a root commit has no parent
 * to diff against), so every baseline reported main's merge as its last change
 * and every screen looked stale. Reading the blob reachable at recordSha needs
 * no history walk, so it is immune to grafts — on the same refs it reproduces
 * the ancestry result exactly (the baseline changed after the review if and
 * only if its content at recordSha differs from today).
 *
 * Screens with `mockup: null` are skipped — no design, nothing to conform to,
 * no record expected. Screens without a committed baseline are skipped too
 * (nothing to have gone stale).
 *
 * A screen's record lives in the directory of the mockup it renders against
 * (region rows share their parent screen's record), e.g. `session-header`
 * and `session-composer` both reconcile against
 * `docs/screens/session/conformance.md`.
 */
for (const screen of SCREENS) {
  if (!screen.mockup) continue;

  const mockupDir = dirname(screen.mockup);
  const recordPath = join(mockupDir, "conformance.md");
  const recordScreen = screen.mockup.split("/")[2];
  const baseline = join(SNAPSHOTS, `${screen.id}-visual-linux.png`);
  const fullBaseline = join(REPO_ROOT, baseline);

  let baselineBlob;
  try {
    accessSync(fullBaseline);
    baselineBlob = readFileSync(fullBaseline);
  } catch {
    // No committed baseline for this screen — nothing can have gone stale.
    continue;
  }

  test(`conformance record for "${recordScreen}" is fresh (baseline ${screen.id})`, () => {
    let record;
    try {
      record = readFileSync(join(REPO_ROOT, recordPath), "utf8");
    } catch {
      assert.fail(`missing conformance record ${recordPath} for screen "${screen.id}" with a filed mockup. ` +
        `Fix: write one and set its Last reviewed sha.`);
    }

    const match = record.match(/^Last reviewed:.*\(([0-9a-fA-F]+)\)/m);
    assert.ok(
      match,
      `"Last reviewed" line missing a (sha) in ${recordPath}. ` +
        `Fix: run \`npm run visual:compare ${recordScreen}\`, reconcile ` +
        `\`docs/screens/${recordScreen}/conformance.md\`, and update its Last reviewed sha.`,
    );
    const recordSha = match[1];

    // Fresh = the committed baseline at the reviewed sha is byte-identical to
    // the baseline on disk. STALE when it differs, or isn't reachable at
    // recordSha at all on a full clone (a baseline that did not exist at the
    // review, or a sha we cannot resolve, cannot prove the record current).
    // On a shallow clone, "not reachable" usually means the history is
    // truncated, not that the record is stale — say so explicitly instead of
    // reporting a false STALE with a visual:compare instruction (BET-1491).
    // See the mechanism comment above for why this is ancestry-equivalent but
    // graft-immune.
    let reviewedBlob;
    try {
      reviewedBlob = gitBuf(["show", `${recordSha}:${baseline}`]);
    } catch {
      reviewedBlob = null;
    }
    const fresh = reviewedBlob !== null && reviewedBlob.equals(baselineBlob);
    assert.ok(
      fresh,
      reviewedBlob === null && isShallowRepo()
        ? `conformance record for "${recordScreen}" cannot be judged on this ` +
          `shallow clone: the reviewed sha ${recordSha} is outside the truncated ` +
          `history, so its baseline object is absent — this is not evidence of ` +
          `staleness (${recordPath}). Fix: run \`git fetch --unshallow origin\` ` +
          `(or a full clone) and re-run the suite before judging conformance records.`
        : `conformance record for "${recordScreen}" is STALE: baseline ${screen.id} ` +
          `differs from its committed state at the reviewed sha ${recordSha} ` +
          `(${recordPath}) — the baseline moved after the review, so the ` +
          `record does not describe the screen as it exists now. Fix: run ` +
          `\`npm run visual:compare ${recordScreen}\`, reconcile ` +
          `\`docs/screens/${recordScreen}/conformance.md\`, and update its Last reviewed sha.`,
    );
  });
}
