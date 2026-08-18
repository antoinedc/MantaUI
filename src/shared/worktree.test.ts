import { describe, it, expect } from "vitest";
import {
  deriveWorktree,
  isWorktreeDirtyError,
} from "./worktree.mjs";

describe("deriveWorktree", () => {
  const REPO = "/home/me/projects/myapp";
  const PARENT = "/home/me/projects";
  const BASE = "myapp";
  const noDir = () => false;
  const noBranch = () => false;

  it("returns the base sibling + slugged branch when nothing collides", () => {
    const r = deriveWorktree({
      repoRoot: REPO,
      name: "Feature A",
      dirExists: noDir,
      branchExists: noBranch,
    });
    expect(r).toEqual({ path: `${PARENT}/${BASE}-feature-a`, branch: "feature-a" });
  });

  it("falls back to 'session' branch when the name slugifies to empty", () => {
    const r = deriveWorktree({
      repoRoot: REPO,
      name: "!!!",
      dirExists: noDir,
      branchExists: noBranch,
    });
    expect(r).toEqual({ path: `${PARENT}/${BASE}-session`, branch: "session" });
  });

  it("caps a long name to a 32-character branch", () => {
    // The 32-char cap now applies to worktree branches too (BET-1115).
    const name = "x".repeat(40);
    const r = deriveWorktree({
      repoRoot: REPO,
      name,
      dirExists: noDir,
      branchExists: noBranch,
    });
    expect(r.branch).toHaveLength(32);
    expect(r.branch).toBe("x".repeat(32));
  });

  it("appends -2, -3, … when the directory collides", () => {
    const takenDirs = new Set([`${PARENT}/${BASE}-feature-a`]);
    const r = deriveWorktree({
      repoRoot: REPO,
      name: "feature-a",
      dirExists: (p) => takenDirs.has(p),
      branchExists: noBranch,
    });
    expect(r).toEqual({ path: `${PARENT}/${BASE}-feature-a-2`, branch: "feature-a-2" });
  });

  it("appends -2, -3, … when the branch collides", () => {
    const takenBranches = new Set(["feature-a"]);
    const r = deriveWorktree({
      repoRoot: REPO,
      name: "feature-a",
      dirExists: noDir,
      branchExists: (b) => takenBranches.has(b),
    });
    expect(r).toEqual({ path: `${PARENT}/${BASE}-feature-a-2`, branch: "feature-a-2" });
  });

  it("keeps the numeric suffix in lockstep across two collisions", () => {
    // dir AND branch both collide at base + -2 → bump to -3.
    const takenDirs = new Set([
      `${PARENT}/${BASE}-feature-a`,
      `${PARENT}/${BASE}-feature-a-2`,
    ]);
    const takenBranches = new Set(["feature-a", "feature-a-2"]);
    const r = deriveWorktree({
      repoRoot: REPO,
      name: "feature-a",
      dirExists: (p) => takenDirs.has(p),
      branchExists: (b) => takenBranches.has(b),
    });
    expect(r).toEqual({ path: `${PARENT}/${BASE}-feature-a-3`, branch: "feature-a-3" });
  });
});

describe("isWorktreeDirtyError", () => {
  it("matches git's real dirty-worktree stderr", () => {
    const stderr =
      "fatal: '/repo/feature-a' contains modified or untracked files, use --force to delete it";
    expect(isWorktreeDirtyError(stderr)).toBe(true);
  });

  it("matches an untracked-only variant", () => {
    const stderr =
      "fatal: '/repo/feature-a' contains untracked files, use --force to delete it";
    expect(isWorktreeDirtyError(stderr)).toBe(true);
  });

  it("rejects non-dirty errors (path missing, no 'use --force')", () => {
    expect(isWorktreeDirtyError("fatal: cannot find worktree '/x'")).toBe(false);
    expect(isWorktreeDirtyError("permission denied")).toBe(false);
  });

  it("rejects messages that mention 'force' but no modified/untracked", () => {
    // would-be false positive — must not classify as dirty.
    expect(isWorktreeDirtyError("fatal: unable to force-replace branch")).toBe(false);
  });

  it("handles empty / non-string input safely", () => {
    expect(isWorktreeDirtyError("")).toBe(false);
    expect(isWorktreeDirtyError(undefined as unknown as string)).toBe(false);
    expect(isWorktreeDirtyError(null as unknown as string)).toBe(false);
  });
});
