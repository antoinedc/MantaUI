import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorktrees } from "./local.mjs";

test("parseWorktrees parses `git worktree list --porcelain`", () => {
  const out = parseWorktrees(
    "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
    "worktree /repo/wt\nHEAD def456\ndetached\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "/repo");
  assert.equal(out[0].branch, "main");
  assert.equal(out[1].detached, true);
});
