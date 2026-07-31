import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractIssueKey, classifyClosure, buildComment } from "./multica-pr-closed.mjs";

describe("extractIssueKey", () => {
  test("reads the key from the PR title", () => {
    assert.equal(
      extractIssueKey({ title: "BET-429: wire lazy Claude CLI install", headRef: "feature" }),
      "BET-429",
    );
  });

  test("falls back to the branch name", () => {
    assert.equal(
      extractIssueKey({ title: "wire lazy install", headRef: "multica/BET-429-claude-cli" }),
      "BET-429",
    );
  });

  test("title wins over branch — a branch is reused across attempts", () => {
    assert.equal(
      extractIssueKey({ title: "BET-430: probe", headRef: "multica/BET-429-old" }),
      "BET-430",
    );
  });

  test("null when neither carries a key", () => {
    assert.equal(extractIssueKey({ title: "chore: bump deps", headRef: "chore/bump" }), null);
    assert.equal(extractIssueKey({}), null);
  });
});

describe("classifyClosure", () => {
  test("merged short-circuits everything else", () => {
    const out = classifyClosure({ merged: true, baseRef: "parent", defaultBranch: "main" });
    assert.equal(out.kind, "merged");
  });

  test("closed against the default branch is abandoned", () => {
    const out = classifyClosure({ merged: false, baseRef: "main", defaultBranch: "main" });
    assert.equal(out.kind, "abandoned");
  });

  test("REGRESSION (BET-429): parent merged → stacked, not abandoned", () => {
    // PR #374 targeted multica/BET-421-onboarding-processpanel. When #373
    // merged, GitHub deleted that branch and auto-closed #374. The old workflow
    // called this abandoned and told the PM to reopen.
    const out = classifyClosure({
      merged: false,
      baseRef: "multica/BET-421-onboarding-processpanel",
      defaultBranch: "main",
      baseBranchExists: false,
      baseMerged: true,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /was merged/);
  });

  test("base branch gone but no merged PR found is still stacked", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: false,
      baseMerged: false,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /no longer exists/);
  });

  test("a failed probe is not evidence of abandonment", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: null,
      baseMerged: null,
    });
    assert.equal(out.kind, "stacked");
    assert.match(out.reason, /could not be checked/);
  });

  test("live unmerged parent means a person closed it", () => {
    const out = classifyClosure({
      merged: false,
      baseRef: "parent",
      defaultBranch: "main",
      baseBranchExists: true,
      baseMerged: false,
    });
    assert.equal(out.kind, "abandoned");
  });

  test("missing base ref degrades to abandoned, never crashes", () => {
    assert.equal(classifyClosure({}).kind, "abandoned");
    assert.equal(classifyClosure({ merged: false, defaultBranch: "trunk" }).kind, "abandoned");
  });

  test("default branch need not be called main", () => {
    assert.equal(
      classifyClosure({ merged: false, baseRef: "trunk", defaultBranch: "trunk" }).kind,
      "abandoned",
    );
  });
});

describe("buildComment", () => {
  const stacked = buildComment({
    kind: "stacked",
    key: "BET-429",
    reason: "its base branch `parent` was merged",
    headRef: "multica/BET-429-child",
    defaultBranch: "main",
  });
  const abandoned = buildComment({
    kind: "abandoned",
    key: "BET-430",
    reason: "it targeted `main` directly",
    headRef: "multica/BET-430-x",
    defaultBranch: "main",
  });

  test("INVARIANT: no comment ever tells anyone to reopen", () => {
    // A comment on an agent-assigned Multica issue dispatches a run, so the
    // word "reopen" is a wrong instruction with an agent behind it.
    for (const c of [stacked, abandoned]) assert.doesNotMatch(c, /reopen/i);
  });

  test("INVARIANT: every comment states that nothing changed", () => {
    for (const c of [stacked, abandoned]) assert.match(c, /[Nn]o status was changed/);
  });

  test("the stacked comment demands a check against the default branch", () => {
    assert.match(stacked, /already on `main`/);
    assert.match(stacked, /superseded/);
  });

  test("the stacked comment names both outcomes, and the branch in each", () => {
    assert.match(stacked, /cancel \*\*BET-429\*\* as superseded and delete `multica\/BET-429-child`/);
    assert.match(stacked, /rebase `multica\/BET-429-child` onto `main`/);
  });

  test("the branch name degrades to prose when the head ref is unknown", () => {
    const c = buildComment({ kind: "stacked", key: "BET-1", reason: "r", defaultBranch: "main" });
    assert.match(c, /delete the branch/);
    assert.doesNotMatch(c, /``/);
  });

  test("the abandoned comment does not claim a stack", () => {
    assert.doesNotMatch(abandoned, /stacked/i);
    assert.match(abandoned, /BET-430/);
  });
});
