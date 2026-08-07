// scripts/repo-hygiene.test.mjs — guards against machine-specific junk being
// committed to the repo.
//
// WHY THIS EXISTS. `node_modules` was committed as a SYMLINK three times.
// The failure is invisible in review and expensive in the field:
//
//   1. `.gitignore` said `node_modules/`. A trailing slash matches DIRECTORIES
//      ONLY, so when the path was a symlink git happily tracked it, and a
//      `git add -A` from a worktree swept it into an unrelated commit.
//   2. The tracked target was an ABSOLUTE path on one developer's machine
//      (`/home/dev/projects/better-ui/node_modules`) — and after one checkout
//      it pointed at ITSELF, so resolving it looped: `ls node_modules` failed
//      with ELOOP and every `node`/`npm` command in that checkout died. Six
//      worktrees that shared that install broke at once.
//   3. On any checkout where a real install shadowed it, `git status` showed a
//      permanent phantom ` D node_modules`, which the next `git add -A` swept
//      into ANOTHER PR. That cost BET-676 a full review cycle and #693 a
//      second one.
//
// The ignore pattern is fixed (`node_modules`, no slash) so this cannot happen
// silently again — but an explicit `git add -f`, or a future edit that
// re-narrows the pattern, would bring it back. These tests are the tripwire.
// They are pure git-index reads: no network, no install, ~10ms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Files in the index, with mode, as `[{ mode, path }]`. */
function indexEntries() {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      // "<mode> <sha> <stage>\t<path>"
      const tab = line.indexOf("\t");
      return { mode: line.slice(0, 6), path: line.slice(tab + 1) };
    });
}

/** True when this is a real git checkout (release tarballs are not). */
function inGitCheckout() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("node_modules is never tracked in git", (t) => {
  if (!inGitCheckout()) return t.skip("not a git checkout");
  const tracked = indexEntries().filter(
    (e) => e.path === "node_modules" || e.path.startsWith("node_modules/"),
  );
  assert.deepEqual(
    tracked.map((e) => e.path),
    [],
    "node_modules must never be committed — it is machine-specific and, as a " +
      "symlink, has repeatedly broken every checkout that resolved it. " +
      "Fix: `git rm --cached -r node_modules` and keep `.gitignore`'s pattern " +
      "as `node_modules` (NO trailing slash, so symlinks are ignored too).",
  );
});

test("no tracked symlink points at an absolute path", (t) => {
  if (!inGitCheckout()) return t.skip("not a git checkout");
  const symlinks = indexEntries().filter((e) => e.mode === "120000");
  const absolute = symlinks.filter((e) => {
    const target = execFileSync("git", ["cat-file", "-p", `:${e.path}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
  });
  assert.deepEqual(
    absolute.map((e) => e.path),
    [],
    "A tracked symlink with an ABSOLUTE target only resolves on the machine " +
      "that created it; everywhere else it dangles (or loops, if it points at " +
      "its own path). Commit a repo-relative symlink, or nothing at all.",
  );
});

test(".gitignore ignores node_modules WITHOUT a trailing slash", () => {
  // Asserted against the pattern TEXT, deliberately, after the obvious
  // `git check-ignore` version of this test was found to be useless: on a
  // machine where a real node_modules DIRECTORY exists, check-ignore matches
  // the directory-only `node_modules/` rule and reports "ignored" — passing
  // green on exactly the broken config it was meant to catch. The symlink
  // form is what escapes that rule, and it only exists on the machine that
  // is already broken, so there is nothing safe to probe. The invariant is
  // therefore stated directly: the pattern must carry no trailing slash.
  const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(
    lines.includes("node_modules"),
    "`.gitignore` must contain the line `node_modules` with NO trailing slash. " +
      "`node_modules/` matches DIRECTORIES ONLY, so a node_modules SYMLINK " +
      "stays trackable — which is how it was committed, and how a checkout " +
      "ended up with a symlink pointing at itself (ELOOP: every node/npm " +
      `command in that tree failed). Current node_modules lines: ${JSON.stringify(
        lines.filter((l) => l.includes("node_modules")),
      )}`,
  );
});
