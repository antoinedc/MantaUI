import { describe, it, expect } from "vitest";
import {
  breadcrumbs,
  crumbLabel,
  parentPath,
  hasWorktreeFanOut,
  gitStateLabel,
  worktreeName,
} from "./folderPicker";
import type { WorktreeInfo } from "../shared/types";

function wt(path: string, branch: string): WorktreeInfo {
  return { path, head: "abc123", branch, bare: false, detached: false };
}

describe("breadcrumbs", () => {
  it("returns empty for empty input", () => {
    expect(breadcrumbs("")).toEqual([]);
    expect(breadcrumbs("   ")).toEqual([]);
  });

  it("splits absolute paths", () => {
    expect(breadcrumbs("/home/dev/code")).toEqual([
      "/",
      "/home",
      "/home/dev",
      "/home/dev/code",
    ]);
  });

  it("handles root", () => {
    expect(breadcrumbs("/")).toEqual(["/"]);
  });

  it("handles trailing slash", () => {
    expect(breadcrumbs("/home/dev/")).toEqual(["/", "/home", "/home/dev"]);
  });
});

describe("parentPath", () => {
  it("goes up from absolute paths", () => {
    expect(parentPath("/home/dev/code")).toBe("/home/dev");
    expect(parentPath("/home/dev")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });

  it("returns empty for empty", () => {
    expect(parentPath("")).toBe("");
  });
});

describe("crumbLabel", () => {
  it("labels root", () => {
    expect(crumbLabel("/")).toBe("/");
  });

  it("extracts the last segment", () => {
    expect(crumbLabel("/home/dev/code")).toBe("code");
    expect(crumbLabel("/home/dev")).toBe("dev");
  });
});

describe("hasWorktreeFanOut", () => {
  it("is false for null", () => {
    expect(hasWorktreeFanOut(null)).toBe(false);
  });

  it("is false for 0 or 1", () => {
    expect(hasWorktreeFanOut([])).toBe(false);
    expect(hasWorktreeFanOut([wt("/repo", "main")])).toBe(false);
  });

  it("is true for >1", () => {
    expect(hasWorktreeFanOut([wt("/a", "a"), wt("/b", "b")])).toBe(true);
  });
});

describe("gitStateLabel", () => {
  it("returns empty for null", () => {
    expect(gitStateLabel(null)).toBe("");
  });

  it("returns empty for empty", () => {
    expect(gitStateLabel([])).toBe("");
  });

  it("returns branch from first worktree", () => {
    expect(gitStateLabel([wt("/repo", "main"), wt("/repo-wt", "dev")])).toBe(
      "⎇ main",
    );
  });

  it("returns empty when branch is missing", () => {
    expect(gitStateLabel([wt("/repo", "")])).toBe("");
    expect(gitStateLabel([{ path: "/repo", head: "x", branch: null, bare: false, detached: false }])).toBe("");
  });
});

describe("worktreeName", () => {
  it("returns the path basename", () => {
    expect(worktreeName(wt("/home/dev/leasebot", "main"))).toBe("leasebot");
    expect(worktreeName(wt("/home/dev/leasebot-wt", "feature/foo"))).toBe("leasebot-wt");
  });

  it("falls back to branch when path has no basename", () => {
    expect(worktreeName(wt("", "feature"))).toBe("feature");
  });

  it("falls back to 'wt' when both are empty", () => {
    expect(worktreeName(wt("", ""))).toBe("wt");
    expect(worktreeName({ path: "", head: "x", branch: null, bare: false, detached: false })).toBe("wt");
  });
});
