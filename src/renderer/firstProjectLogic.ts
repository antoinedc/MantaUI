// firstProjectLogic.ts — pure logic for onboarding Step 4 (First project),
// BET-49-T5. Framework-free so it's unit-testable in vitest (see
// firstProjectLogic.test.ts), exactly like pairStepLogic.ts / onboardingUtils.ts.
// FirstProjectStep.tsx owns the React/DOM; this module owns the "what's the
// prefilled directory" / "can we create yet" decisions.
//
// The step is a simple name + working-directory form (per docs/onboarding/
// mockup.html — no worktree fan-out, no path autocomplete; the first project is
// usually fresh). The directory is prefilled from the name (`~/projects/<name>`)
// and keeps tracking the name UNTIL the user manually edits the directory, at
// which point their explicit path wins and the auto-fill stops. All of that
// "should the dir follow the name" bookkeeping is pure and lives here.

// The prefix every auto-derived working directory sits under. A fresh onboarding
// project lands in ~/projects/<name>; power users can retype anything.
export const PROJECT_DIR_PREFIX = "~/projects/";

// Slugify a raw project name into the trailing path segment of its default
// working directory. We keep this permissive (the name itself is free-form and
// used verbatim as the tmux session name) but the *path* segment is sanitized so
// spaces / punctuation don't produce an awkward directory: lowercase, spaces and
// runs of non [a-z0-9._-] collapse to a single hyphen, and leading/trailing
// hyphens are trimmed. An empty/whitespace name yields "" (→ the bare prefix).
export function slugifyProjectName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The default working directory derived from a project name: `~/projects/<slug>`.
// An empty name yields the bare prefix (`~/projects/`) so the field is never a
// dangling half-path the user has to fix before typing.
export function defaultCwdForName(name: string): string {
  return PROJECT_DIR_PREFIX + slugifyProjectName(name);
}

// While the user hasn't touched the directory field, it should keep mirroring
// the name. Once they manually edit it, their value is authoritative and we stop
// auto-filling. `dirEdited` is the latch the component holds; this helper picks
// the next directory value to show given a name change.
//
//   - dirEdited === false → follow the name (defaultCwdForName)
//   - dirEdited === true  → keep the user's current directory unchanged
export function nextCwdOnNameChange(name: string, currentCwd: string, dirEdited: boolean): string {
  return dirEdited ? currentCwd : defaultCwdForName(name);
}

// Whether a manual directory edit should flip the "user owns the dir" latch.
// Typing the exact value the name would have auto-filled is NOT a manual edit
// (so the field keeps following the name); anything else is. This keeps the
// common "type name, glance at dir, keep typing name" flow auto-filling while
// still latching the instant the user deviates.
export function isManualDirEdit(name: string, nextCwd: string): boolean {
  return nextCwd !== defaultCwdForName(name);
}

// Gate for the "Create project" button. A project needs a non-blank name and a
// non-blank working directory. The directory defaults to a real path, so the
// only way it's blank is if the user cleared it — in which case we block rather
// than silently fall back to $HOME (tmux's -c does that on a bad path).
export function canCreateProject(name: string, cwd: string): boolean {
  return name.trim().length > 0 && cwd.trim().length > 0;
}
