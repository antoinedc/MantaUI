// worktree.mjs — pure logic backing the "auto-create a git worktree when
// creating a new chat session (window)" feature (BET-246). Three functions:
//
//   slugify              — turn a free-form session/window name into a
//                          filesystem- and git-branch-safe slug.
//   deriveWorktree       — pick a non-colliding { path, branch } pair for
//                          a sibling worktree next to the repo root.
//   isWorktreeDirtyError — classify git's "worktree remove" stderr so the
//                          renderer can decide whether to confirm a force.
//
// Pure + framework-free (no fs, no fetch). Imports `node:path` only for the
// pure `dirname` / `basename` helpers — the I/O lives in
// src/server/local.mjs (gitAddWorktree / gitRemoveWorktree).

import { dirname, basename } from "node:path";

// Lowercase, non-[a-z0-9] runs → "-", trim leading/trailing "-". Empty
// (or all-symbol / all-unicode) result → "session". Kept in sync with the
// collision-safe naming style of deriveSubagentName in subagentSync.mjs.
export function slugify(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

/**
 * Compute the { path, branch } for a sibling worktree next to `repoRoot`.
 *
 *   parent = dirname(repoRoot); base = basename(repoRoot).
 *   baseSlug = slugify(name).
 *   branch candidates: baseSlug, baseSlug-2, baseSlug-3, ...
 *   path  candidates: `${parent}/${base}-${candidate}`, same suffix in lockstep.
 *   Return the first candidate where neither `dirExists(path)` nor
 *   `branchExists(branch)` is true.
 *
 * Pure: the caller injects the `dirExists` / `branchExists` predicates so
 * this function can be unit-tested without spawning git or touching the
 * filesystem. Mirrors deriveSubagentName's collision loop.
 *
 * @param {object} input
 * @param {string} input.repoRoot     absolute path to the git repo top-level
 * @param {string} input.name         session/window name to derive from
 * @param {(p: string) => boolean} input.dirExists
 * @param {(b: string) => boolean} input.branchExists
 * @returns {{ path: string, branch: string }}
 */
export function deriveWorktree({ repoRoot, name, dirExists, branchExists }) {
  const base = basename(repoRoot);
  const parent = dirname(repoRoot);
  const baseSlug = slugify(name);
  let candidate = baseSlug;
  let n = 2;
  while (
    dirExists(`${parent}/${base}-${candidate}`) ||
    branchExists(candidate)
  ) {
    candidate = `${baseSlug}-${n}`;
    n += 1;
  }
  return { path: `${parent}/${base}-${candidate}`, branch: candidate };
}

/**
 * Classify git's "worktree remove" stderr to detect the dirty-checkout case
 * (uncommitted / untracked content blocks the safe remove and requires the
 * user to confirm `--force`). Lives here so the renderer never has to
 * string-match git output — gitRemoveWorktree in src/server/local.mjs returns
 * the discriminated `{ removed:false, reason:"dirty" }` for this case.
 *
 * Match shape (paraphrased): git's stderr ends with the line
 *   "fatal: '<path>' contains modified or untracked files, use --force to delete it"
 * when refusing a safe remove. We test for both signals (the "use --force"
 * call-to-action AND a modified/untracked mention) to keep false positives
 * away from other errors that happen to mention "force".
 *
 * @param {string} stderr
 * @returns {boolean}
 */
export function isWorktreeDirtyError(stderr) {
  if (typeof stderr !== "string" || !stderr) return false;
  const hasForceHint = stderr.includes("use --force");
  const hasDirtyHint =
    stderr.includes("modified") || stderr.includes("untracked");
  return hasForceHint && hasDirtyHint;
}
