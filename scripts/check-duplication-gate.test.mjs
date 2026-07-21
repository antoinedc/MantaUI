import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GATE_SH = join(__dirname, "check-duplication-gate.sh");
const JCPD_CONFIG = join(REPO_ROOT, ".jscpd.json");

// A canonical JS block large enough to clear jscpd's minTokens=70 threshold
// when it appears twice in the same file. Token count is the jscpd-relevant
// metric (not line count) — the function below weighs in at ~110 tokens,
// well over the gate's min-tokens=70 floor (and well over the advisory
// report's 70, which is the same value reused from `.jscpd.json`).
const CLONE_BLOCK = `
function computeAdjustedScore(input) {
  const baseline = input + 1;
  const weighted = baseline * 2;
  const normalized = weighted / 3;
  const adjusted = normalized + 5;
  if (adjusted > 100) return adjusted - 50;
  if (adjusted > 50) return adjusted - 10;
  if (adjusted > 20) return adjusted + 1;
  if (adjusted > 10) return adjusted + 2;
  if (adjusted > 0) return adjusted + 3;
  return adjusted;
}
`.trim();

const PAD = "// padding line to bulk the file above any historical 1000-line mask\n";

// Spin up an isolated temp git repo with the gate script and .jscpd.json
// copied in. The script does `cd "$ROOT"` where ROOT = `dirname $0/..` —
// i.e. the PARENT of the script's directory — so we put the script at
// `<tmp>/scripts/check-duplication-gate.sh` to make ROOT the temp dir
// itself. Without that nesting the script would `cd` to the test's real
// working dir (the better-ui repo) and try to gate the whole real diff.
function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "dup-gate-test-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(GATE_SH, join(scriptsDir, "check-duplication-gate.sh"));
  copyFileSync(JCPD_CONFIG, join(dir, ".jscpd.json"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.local", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  // Baseline commit so `git diff HEAD~1...HEAD` resolves to a real merge-base.
  writeFileSync(join(dir, "README.md"), "test repo\n");
  execSync("git add README.md && git commit -q -m 'baseline'", { cwd: dir });
  return dir;
}

// Build a single-file >1000-line .mjs whose only content is two identical
// copies of CLONE_BLOCK surrounded by padding. jscpd's intra-file scan
// (cross-file is the advisory report's job, per the gate script's header
// comment) catches the duplicate block as one clone event.
function buildLongFileWithClone({ lineCount, cloneOffset, cloneCount = 2 }) {
  const lines = [];
  for (let i = 0; i < cloneOffset; i++) lines.push(PAD);
  for (let c = 0; c < cloneCount; c++) {
    lines.push(CLONE_BLOCK);
    for (let i = 0; i < 30; i++) lines.push(PAD);
  }
  while (lines.length < lineCount) lines.push(PAD);
  return lines.join("\n") + "\n";
}

function runGate(repo, baseRef) {
  // The gate's "no scannable changed files — PASS" branch fires when there
  // are zero changes; we want the strict-scan branch, so always pass an
  // explicit base ref.
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execSync(`bash scripts/check-duplication-gate.sh ${baseRef}`, {
      cwd: repo,
      encoding: "utf8",
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    stdout = (e.stdout ?? "").toString();
    stderr = (e.stderr ?? "").toString();
  }
  return { exitCode, stdout, stderr };
}

test("duplication-gate: PASS on a 1000-line file with no clones", () => {
  const repo = makeTempRepo();
  try {
    // Bulk up without any duplication — 1100 unique-ish lines so the test
    // also stresses any "too large → skip" regression beyond the 1000 line
    // mark.
    const lines = [];
    for (let i = 0; i < 1100; i++) lines.push(`const unique_${i} = ${i};`);
    writeFileSync(join(repo, "clean.mjs"), lines.join("\n") + "\n");
    execSync("git add clean.mjs && git commit -q -m 'add clean'", { cwd: repo });

    const { exitCode, stdout, stderr } = runGate(repo, "HEAD~1");
    assert.equal(
      exitCode,
      0,
      `gate should PASS on a file with no clones\nexit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`,
    );
    assert.match(stdout, /PASS/, "expected PASS marker in gate output");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test(
  "duplication-gate: FAIL on a 1200-line file with an obvious 70+ token clone",
  () => {
    const repo = makeTempRepo();
    try {
      const content = buildLongFileWithClone({
        lineCount: 1200,
        cloneOffset: 200,
        cloneCount: 2,
      });
      writeFileSync(join(repo, "huge.mjs"), content);
      execSync(
        "git add huge.mjs && git commit -q -m 'add huge'",
        { cwd: repo },
      );

      // Sanity: the file is actually >1000 lines (this is the test target —
      // a file size that the historical jscpd@^4.x default `--max-lines 1000`
      // would silently mask, which is exactly the BET-220 regression we're
      // guarding against).
      const written = readFileSync(join(repo, "huge.mjs"), "utf8");
      assert.ok(
        written.split("\n").length >= 1200,
        `synthetic file should be >=1200 lines, got ${written.split("\n").length}`,
      );

      const { exitCode, stdout, stderr } = runGate(repo, "HEAD~1");
      assert.notEqual(
        exitCode,
        0,
        `gate should FAIL on a 1200-line file with an obvious clone ` +
          `(the BET-220 regression guard — if this passes, jscpd is masking ` +
          `large files again)\nexit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`,
      );
      assert.match(
        stdout + stderr,
        /FAIL|clone/i,
        `expected FAIL/clone marker in gate output\nexit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
