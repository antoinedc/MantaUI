// projectName.mjs — the ONE module that owns project / session / window naming.
//
// Consolidated here (BET-1090) so renderer and server share a single home for
// naming logic instead of importing pure string helpers out of the
// NewSessionScreen React component. Pure + framework-free, matching the
// style of src/shared/worktree.mjs: no fs, no fetch, no React.
//
//   generateProjectName  — a random `<adjective>-<noun>-<noun>` (e.g.
//                          `safe-couch-bottle`) from the vendored
//                          friendly-words list, safe as a directory name, a
//                          tmux session name and a git branch.
//   slugifyProjectName   — turn a free-form name into a safe slug.
//   projectDirFor        — join a project root + name into a path.
//   deriveProjectName    — basename of a folder path, with fallbacks.
//   uniqueSessionName    — numeric de-dup (`base`, `base-2`, `base-3`, …).
//   promptWindowName     — readable window name from the first word of a prompt.

import { ADJECTIVES, NOUNS } from "./friendlyWords.mjs";

/**
 * Generate a random three-word project name `<adjective>-<noun>-<noun>`,
 * e.g. `safe-couch-bottle`. The return value always matches
 * `^[a-z]+-[a-z]+-[a-z]+$`, and because every vendored word is `[a-z]{2,10}`
 * (pinned by src/shared/projectName.test.ts), the longest possible name is
 * ≤ 32 characters — safe as a directory name, a tmux session name and a git
 * branch without any sanitising.
 *
 * `rand` is a parameter with a default so tests can inject a deterministic
 * source; the body must never call `Math.random` directly.
 *
 * @param {() => number} [rand] — source of `[0,1)` values, defaults to Math.random
 * @returns {string}
 */
export function generateProjectName(rand = Math.random) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(NOUNS)}`;
}

/**
 * Turn a free-form project/session name into a filesystem- and git-branch-safe
 * slug. Lowercases; replaces every run of `[^a-z0-9]+` with a single `-`;
 * strips leading/trailing `-`; truncates to 32 characters; strips any trailing
 * `-` left by the truncation. Empty or all-punctuation input returns `""`.
 *
 * @param {string} input
 * @returns {string}
 */
export function slugifyProjectName(input) {
  const slug = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return slug.slice(0, 32).replace(/-+$/g, "");
}

/**
 * Join a project root and its name into a directory path. Strips any trailing
 * slash(es) from the root first. No tilde expansion here — that is the
 * server's job (src/server rpc.mjs resolves cwd).
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function projectDirFor(root, name) {
  return `${root.replace(/\/+$/, "")}/${name}`;
}

// Derive a tmux session name from a folder path: the basename, fallback to
// "project". Tilde-form and trailing slashes are handled. Exported for
// testing (pure).
export function deriveProjectName(cwd) {
  const clean = cwd.replace(/\/+$/, "");
  if (!clean || clean === "~") return "project";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "project";
}

// Numeric de-dup on top of deriveProjectName: returns the base name if free,
// else the first free `base-2`, `base-3`, … against the `taken` set (the
// existing project session names). THE one naming helper for a session name —
// shared by every path that creates a project (the repo-probe batch, the
// draft composer submit, and the worktree fan-out), so a twin never lands with
// the same tmux session name. Exported for testing (pure).
export function uniqueSessionName(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// A readable, largely-unique window name derived from the first word of the
// typed prompt (e.g. "Deploy the billing service" → "deploy"). This avoids the
// old constant "worktree"/"session" that produced a sidebar full of identical
// rows. Falls back to "session" on a non-alphanumeric or empty first word.
export function promptWindowName(input) {
  const clean = (input.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return clean ? clean.slice(0, 24) : "session";
}
