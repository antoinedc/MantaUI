#!/usr/bin/env node
/**
 * Open a pull request for an agent branch that was pushed without one.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `macos` worker is forbidden from opening pull requests — deliberately, it
 * runs on a daily-driver laptop holding signing certificates, so its brief is
 * narrow: build, capture, commit to a branch, report. `.multica/agents/macos.md`
 * states "**The git branch is the hand-off medium**" and expects the agents on
 * the Linux box to consume it.
 *
 * Nothing consumed it. On 2026-08-02 BET-555 (the first Swift stage) built
 * cleanly, pushed `agent/macos/bbb581a9`, set itself `in_review` — and stopped
 * dead, because no pull request existed and therefore nothing was reviewable.
 * `multica-unstick` routes an implementer's finished issue to the reviewer, but
 * a reviewer with no PR has nothing to look at. The branch sat on the remote
 * and the whole iOS epic stalled behind it, with every board field looking
 * correct.
 *
 * This closes the gap on the CI side rather than by relaxing the Mac's limits:
 * the worker still never opens a PR, and the push it already performs is enough
 * to produce one. It also covers the general case — ANY agent that pushes a
 * branch and then fails to open a PR (a crashed run, a revoked token, a dropped
 * hand-off) now gets one automatically instead of stranding the work.
 *
 * WHY A REAL PAT, NOT `GITHUB_TOKEN`
 * ----------------------------------
 * A pull request opened with the default `GITHUB_TOKEN` does NOT trigger
 * `pull_request` workflows — GitHub suppresses them to prevent recursion. Since
 * `ci.yml` only runs on `pull_request` and on pushes to `main`, such a PR would
 * carry NO checks at all, and `typecheck-test` is the one required context on
 * `main`. The PR would be permanently unmergeable, which is a more confusing
 * failure than the stranded branch it replaced. `BUNDLE_PUSH_TOKEN` (an
 * admin-owned PAT) is used instead so CI runs normally.
 *
 * ISSUE LINKING
 * -------------
 * Multica links a PR to an issue by the key in its TITLE, so the key must be
 * recovered. Branch name first (`multica/BET-123-slug`, the convention every
 * Linux agent follows), then the branch's commit subjects. If neither yields a
 * key the PR is still opened — an unlinked PR is visible and fixable, a
 * stranded branch is neither — and a warning is emitted.
 *
 * USAGE
 *   node scripts/agent-branch-pr.mjs --branch <name> [--dry-run]
 *
 * ENV
 *   GH_TOKEN  required by the `gh` CLI for the API calls.
 *
 * Exit code is 0 unless the run could not complete. "A PR already exists" is a
 * success, not a failure — the script is idempotent and safe to re-run on every
 * push to the same branch.
 */

import { execFileSync } from "node:child_process";

/** Branch prefixes this sweep will open a PR for. */
export const AGENT_BRANCH_PREFIXES = ["agent/", "multica/"];

/** Base branch every agent PR targets. */
export const BASE_BRANCH = "main";

/**
 * Is this a branch the sweep is allowed to act on?
 *
 * Deliberately a prefix allowlist rather than "anything that is not main": a
 * human's scratch branch must never sprout a pull request because they pushed
 * it to share it.
 *
 * @param {string|null|undefined} branch
 * @returns {boolean}
 */
export function isAgentBranch(branch) {
  if (typeof branch !== "string" || branch.trim() === "") return false;
  const b = branch.trim();
  if (b === BASE_BRANCH) return false;
  return AGENT_BRANCH_PREFIXES.some((p) => b.startsWith(p));
}

/**
 * Recover the issue key from a branch name.
 *
 * Matches the `multica/BET-123-some-slug` convention. The digits must be
 * delimited so `BET-1234` never reads as `BET-123`.
 *
 * @param {string|null|undefined} branch
 * @returns {string|null}
 */
export function issueKeyFromBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/\b([A-Z]{2,10})-(\d+)\b/i);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/**
 * Recover the issue key from the branch's commit subjects, newest first.
 *
 * The fallback for a branch whose name carries no key — e.g. the runtime's own
 * `agent/macos/<taskid>` shape, which names the task run rather than the issue.
 *
 * @param {string[]} subjects newest-first commit subjects
 * @returns {string|null}
 */
export function issueKeyFromCommits(subjects) {
  for (const s of Array.isArray(subjects) ? subjects : []) {
    const k = issueKeyFromBranch(typeof s === "string" ? s : "");
    if (k) return k;
  }
  return null;
}

/**
 * Build the PR title. The issue key leads so Multica can link it; without one
 * the commit subject stands alone rather than inventing a key.
 *
 * @param {string|null} key
 * @param {string} subject
 * @returns {string}
 */
export function buildPrTitle(key, subject) {
  const s = (typeof subject === "string" ? subject : "").trim() || "agent branch";
  if (!key) return s;
  // Do not double-prefix a subject that already names the issue.
  if (s.toUpperCase().includes(key.toUpperCase())) return s;
  return `${key}: ${s}`;
}

/**
 * Decide whether to open a PR for a pushed branch.
 *
 * @param {{branch:string, existingPrCount:number, commitsAhead:number}} args
 * @returns {{create:boolean, reason:string}}
 */
export function decideAutoPr({ branch, existingPrCount, commitsAhead }) {
  if (!isAgentBranch(branch)) {
    return { create: false, reason: `\`${branch}\` is not an agent branch` };
  }
  if (existingPrCount > 0) {
    return { create: false, reason: "a pull request already exists" };
  }
  // A branch with nothing on it would produce an empty PR that fails to create
  // and reads as a broken sweep.
  if (!(commitsAhead > 0)) {
    return { create: false, reason: `no commits ahead of ${BASE_BRANCH}` };
  }
  return { create: true, reason: `${commitsAhead} commit(s) ahead, no pull request` };
}

/**
 * Body for an auto-carried PR. States plainly that a sweep opened it, so a
 * reviewer is never left wondering who authored the request.
 *
 * @param {{branch:string, key:string|null}} args
 * @returns {string}
 */
export function buildPrBody({ branch, key }) {
  const lines = [
    `Opened automatically for \`${branch}\`, which was pushed without a pull request.`,
    "",
    "Some agents push a branch but never open a PR — the `macos` worker is",
    "forbidden from opening one, and any run can die between its push and its",
    "hand-off. Either way the work is stranded on the remote and invisible to",
    "review. This sweep carries it into a reviewable PR instead.",
    "",
    "The commits are the agent's own and have not been modified.",
  ];
  if (key) lines.push("", `Relates to ${key}.`);
  else {
    lines.push(
      "",
      "**No issue key** could be recovered from the branch name or its commit",
      "subjects, so this PR is not linked to an issue. Retitle it with the key",
      "to link it.",
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * IO below this line. Everything above is pure and unit-tested.
 * ------------------------------------------------------------------ */

/** Run `gh` and return trimmed stdout. */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Run `git` and return trimmed stdout. */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function run({ branch, dryRun = false, exec = { gh, git } } = {}) {
  if (!branch) {
    console.error("--branch is required.");
    return 1;
  }

  if (!isAgentBranch(branch)) {
    console.log(`· \`${branch}\` is not an agent branch — nothing to do.`);
    return 0;
  }

  // An existing PR (in any state) means this branch has already been carried.
  // `--state all` matters: a closed PR is a deliberate human decision and must
  // not be silently reopened as a new one on the next push.
  let existing = [];
  try {
    existing = JSON.parse(exec.gh(["pr", "list", "--head", branch, "--state", "all", "--json", "number,state"]) || "[]");
  } catch (e) {
    console.error(`Could not list pull requests for ${branch}: ${e.message}`);
    return 1;
  }

  let commitsAhead = 0;
  let subjects = [];
  try {
    const range = `origin/${BASE_BRANCH}..origin/${branch}`;
    const log = exec.git(["log", "--format=%s", range]);
    subjects = log ? log.split("\n").filter(Boolean) : [];
    commitsAhead = subjects.length;
  } catch (e) {
    console.error(`Could not read ${branch} against ${BASE_BRANCH}: ${e.message}`);
    return 1;
  }

  const { create, reason } = decideAutoPr({
    branch,
    existingPrCount: existing.length,
    commitsAhead,
  });
  if (!create) {
    console.log(`· ${branch} skipped (${reason})`);
    return 0;
  }

  const key = issueKeyFromBranch(branch) ?? issueKeyFromCommits(subjects);
  const title = buildPrTitle(key, subjects[subjects.length - 1]);
  const body = buildPrBody({ branch, key });

  if (!key) {
    console.log(`::warning::${branch} carries no issue key — the PR will not link to an issue`);
  }
  if (dryRun) {
    console.log(`→ ${branch} WOULD open a PR (${reason})\n  title: ${title}`);
    return 0;
  }

  try {
    const url = exec.gh([
      "pr", "create",
      "--base", BASE_BRANCH,
      "--head", branch,
      "--title", title,
      "--body", body,
    ]);
    console.log(`→ ${branch} carried into ${url} (${reason})`);
  } catch (e) {
    console.error(`Failed to open a PR for ${branch}: ${e.message}`);
    return 1;
  }
  return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--branch");
  const branch = at >= 0 ? argv[at + 1] : (process.env.GITHUB_REF_NAME ?? "");
  process.exit(await run({ branch, dryRun: argv.includes("--dry-run") }));
}
