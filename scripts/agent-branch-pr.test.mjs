import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isAgentBranch,
  issueKeyFromBranch,
  issueKeyFromCommits,
  buildPrTitle,
  decideAutoPr,
  buildPrBody,
  AGENT_BRANCH_PREFIXES,
  BASE_BRANCH,
} from "./agent-branch-pr.mjs";

describe("isAgentBranch", () => {
  test("accepts the two agent branch conventions", () => {
    // The shape the runtime produced for BET-555, which stranded.
    assert.ok(isAgentBranch("agent/macos/bbb581a9"));
    assert.ok(isAgentBranch("multica/BET-566-split-host-consts"));
  });

  test("never acts on main", () => {
    assert.equal(isAgentBranch(BASE_BRANCH), false);
  });

  test("leaves a human's scratch branch alone", () => {
    // Pushing a branch to share it must not sprout a pull request.
    for (const b of ["antoine/wip", "spike/native-visual", "fix-typo", "release"]) {
      assert.equal(isAgentBranch(b), false, `${b} must not be an agent branch`);
    }
  });

  test("tolerates junk input", () => {
    for (const b of [null, undefined, "", "   ", 42]) {
      assert.equal(isAgentBranch(b), false);
    }
  });

  test("the prefix list is an allowlist, not a denylist", () => {
    assert.deepEqual(AGENT_BRANCH_PREFIXES, ["agent/", "multica/"]);
  });
});

describe("issueKeyFromBranch", () => {
  test("recovers the key from the standard convention", () => {
    assert.equal(issueKeyFromBranch("multica/BET-566-split-host-consts"), "BET-566");
  });

  test("normalises case", () => {
    assert.equal(issueKeyFromBranch("multica/bet-12-x"), "BET-12");
  });

  test("does not truncate a longer number", () => {
    assert.equal(issueKeyFromBranch("multica/BET-1234-x"), "BET-1234");
  });

  test("returns null for the task-id shape that carries no key", () => {
    // This is exactly why the commit-subject fallback exists.
    assert.equal(issueKeyFromBranch("agent/macos/bbb581a9"), null);
  });
});

describe("issueKeyFromCommits", () => {
  test("finds the key in a commit subject, newest first", () => {
    assert.equal(
      issueKeyFromCommits(["chore: tidy", "feat(ios): foundation (BET-555)"]),
      "BET-555",
    );
  });

  test("returns null when no subject names an issue", () => {
    // The real BET-555 commit subject — which is why its PR had to be opened
    // by hand and why the warning path matters.
    assert.equal(
      issueKeyFromCommits(["feat(ios): add SwiftUI app foundation consuming generated tokens (S3a)"]),
      null,
    );
  });

  test("tolerates junk input", () => {
    assert.equal(issueKeyFromCommits(null), null);
    assert.equal(issueKeyFromCommits([null, 42]), null);
  });
});

describe("buildPrTitle", () => {
  test("leads with the issue key so Multica can link the PR", () => {
    assert.equal(buildPrTitle("BET-555", "feat(ios): foundation"), "BET-555: feat(ios): foundation");
  });

  test("does not double-prefix a subject that already names the issue", () => {
    const s = "fix(demo): reveal assistant text part (BET-569)";
    assert.equal(buildPrTitle("BET-569", s), s);
  });

  test("stands on the subject alone rather than inventing a key", () => {
    assert.equal(buildPrTitle(null, "feat(ios): foundation"), "feat(ios): foundation");
  });

  test("never produces an empty title", () => {
    assert.equal(buildPrTitle(null, "   "), "agent branch");
    assert.equal(buildPrTitle("BET-1", undefined), "BET-1: agent branch");
  });
});

describe("decideAutoPr", () => {
  const ok = { branch: "agent/macos/bbb581a9", existingPrCount: 0, commitsAhead: 1 };

  test("opens a PR for a pushed agent branch that has none", () => {
    const r = decideAutoPr(ok);
    assert.equal(r.create, true);
    assert.match(r.reason, /no pull request/);
  });

  test("REGRESSION: is idempotent — an existing PR is never duplicated", () => {
    // The workflow fires on EVERY push to the branch, including the agent's
    // own follow-up commits, so this is the common case, not the edge case.
    const r = decideAutoPr({ ...ok, existingPrCount: 1 });
    assert.equal(r.create, false);
    assert.match(r.reason, /already exists/);
  });

  test("a closed PR still counts — a human's decision is not reopened", () => {
    // `gh pr list --state all` feeds this, deliberately.
    assert.equal(decideAutoPr({ ...ok, existingPrCount: 1 }).create, false);
  });

  test("refuses an empty branch rather than failing to create a PR", () => {
    const r = decideAutoPr({ ...ok, commitsAhead: 0 });
    assert.equal(r.create, false);
    assert.match(r.reason, /no commits ahead/);
  });

  test("never acts on a non-agent branch", () => {
    const r = decideAutoPr({ branch: "antoine/wip", existingPrCount: 0, commitsAhead: 3 });
    assert.equal(r.create, false);
    assert.match(r.reason, /not an agent branch/);
  });
});

describe("buildPrBody", () => {
  test("names the branch and says a sweep opened it", () => {
    const b = buildPrBody({ branch: "agent/macos/bbb581a9", key: "BET-555" });
    assert.match(b, /agent\/macos\/bbb581a9/);
    assert.match(b, /automatically/i);
    assert.match(b, /BET-555/);
  });

  test("says so loudly when the PR could not be linked", () => {
    const b = buildPrBody({ branch: "agent/macos/bbb581a9", key: null });
    assert.match(b, /No issue key/);
    assert.doesNotMatch(b, /Relates to/);
  });
});
