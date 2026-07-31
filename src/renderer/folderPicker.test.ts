import { describe, it, expect } from "vitest";
import {
  breadcrumbs,
  crumbLabel,
  parentPath,
  isDimmedDir,
  worktreeBadge,
  hasWorktreeFanOut,
  gitStateLabel,
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

  it("handles bare tilde", () => {
    expect(breadcrumbs("~")).toEqual(["~"]);
  });

  it("splits tilde-form paths", () => {
    expect(breadcrumbs("~/code/foo")).toEqual([
      "~",
      "~/code",
      "~/code/foo",
    ]);
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
    expect(breadcrumbs("~/code/")).toEqual(["~", "~/code"]);
  });
});

describe("parentPath", () => {
  it("goes up from tilde paths", () => {
    expect(parentPath("~/code/foo")).toBe("~/code");
    expect(parentPath("~/code")).toBe("~");
    expect(parentPath("~")).toBe("~");
  });

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
  it("labels tilde", () => {
    expect(crumbLabel("~")).toBe("~");
  });

  it("labels root", () => {
    expect(crumbLabel("/")).toBe("/");
  });

  it("extracts the last segment", () => {
    expect(crumbLabel("~/code/foo")).toBe("foo");
    expect(crumbLabel("/home/dev")).toBe("dev");
  });
});

describe("isDimmedDir", () => {
  it("dims node_modules", () => {
    expect(isDimmedDir("node_modules")).toBe(true);
  });

  it("dims dot-folders", () => {
    expect(isDimmedDir(".git")).toBe(true);
    expect(isDimmedDir(".venv")).toBe(true);
    expect(isDimmedDir(".cache")).toBe(true);
  });

  it("does not dim regular folders", () => {
    expect(isDimmedDir("src")).toBe(false);
    expect(isDimmedDir("my-project")).toBe(false);
    expect(isDimmedDir("code")).toBe(false);
  });
});

describe("worktreeBadge", () => {
  it("returns empty for null", () => {
    expect(worktreeBadge(null)).toBe("");
  });

  it("returns empty for 0 or 1 worktree", () => {
    expect(worktreeBadge([])).toBe("");
    expect(worktreeBadge([wt("/repo", "main")])).toBe("");
  });

  it("returns count for >1 worktree", () => {
    expect(worktreeBadge([wt("/repo", "main"), wt("/repo-wt", "wt")])).toBe(
      "⎇ 2 worktrees",
    );
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
