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

const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const gitStatus = (args) => {
  try {
    git(args);
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
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
 *   baselineChanged = last commit touching <id>-visual-linux.png
 *   recordSha       = the sha on the "Last reviewed" line
 *   FAIL           = baselineChanged is NOT an ancestor of recordSha
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

  let baselineSha;
  try {
    accessSync(fullBaseline);
    baselineSha = git(["log", "-1", "--format=%H", "--", baseline]);
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

    // exit 0 = ancestor (baseline moved before the review -> record is fresh),
    // exit 1 = not an ancestor (baseline moved after the review -> stale),
    // anything else = a sha we cannot resolve -> treat as stale, it cannot be
    // proven current.
    const ancestor = gitStatus(["merge-base", "--is-ancestor", baselineSha, recordSha]) === 0;
    assert.ok(
      ancestor,
      `conformance record for "${recordScreen}" is STALE: baseline ${screen.id} ` +
        `last changed at ${baselineSha.slice(0, 9)}, but its record was reviewed at ` +
        `${recordSha} (${recordPath}) — the baseline moved after the review, so the ` +
        `record does not describe the screen as it exists now. Fix: run ` +
        `\`npm run visual:compare ${recordScreen}\`, reconcile ` +
        `\`docs/screens/${recordScreen}/conformance.md\`, and update its Last reviewed sha.`,
    );
  });
}
