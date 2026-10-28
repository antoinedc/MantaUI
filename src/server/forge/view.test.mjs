import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTone, orderChecks, countChecks, checksChip, failuresPrompt, logsUrl, panelState, shipState,
  canMerge, mergeableDisplay, mergeFailureMessage, shipErrorMessage, reviewErrorMessage,
  pullRequestView, createLastPrCache, inboxRowView,
} from "./view.mjs";

const ok = (name, url) => ({ name, status: "completed", conclusion: "success", ...(url ? { url } : {}) });
const bad = (name, url) => ({ name, status: "completed", conclusion: "failure", ...(url ? { url } : {}) });
const run = (name) => ({ name, status: "in_progress", conclusion: null });

test("checkTone: no conclusion / queued / in_progress → running; success → ok; else error", () => {
  assert.equal(checkTone({ name: "a" }), "running");
  assert.equal(checkTone({ name: "a", status: "queued", conclusion: "success" }), "running");
  assert.equal(checkTone({ name: "a", status: "in_progress", conclusion: "success" }), "running");
  assert.equal(checkTone(ok("a")), "ok");
  assert.equal(checkTone(bad("a")), "error");
  assert.equal(checkTone({ name: "a", status: "completed", conclusion: "cancelled" }), "error");
});

test("orderChecks: failed → running → passed, stable inside a bucket, each with tone", () => {
  const out = orderChecks([ok("p1"), run("r1"), bad("f1"), ok("p2"), bad("f2"), run("r2")]);
  assert.deepEqual(out.map((c) => c.name), ["f1", "f2", "r1", "r2", "p1", "p2"]);
  assert.deepEqual(out.map((c) => c.tone), ["error", "error", "running", "running", "ok", "ok"]);
  assert.deepEqual(orderChecks(undefined), []);
});

test("countChecks counts the three buckets", () => {
  assert.deepEqual(countChecks([ok("a"), ok("b"), bad("c"), run("d")]), { passed: 2, failed: 1, running: 1 });
});

test("checksChip: one chip per rollup, none → null", () => {
  assert.deepEqual(checksChip("green", { passed: 7, failed: 0, running: 0 }), { glyph: "✓", label: "✓ 7", tone: "ok" });
  assert.deepEqual(checksChip("red", { passed: 1, failed: 2, running: 0 }), { glyph: "✗", label: "✗ 2 failed", tone: "danger" });
  assert.deepEqual(checksChip("yellow", { passed: 1, failed: 0, running: 3 }), { glyph: "◐", label: "◐ 3 running", tone: "warn" });
  assert.equal(checksChip("none", { passed: 0, failed: 0, running: 0 }), null);
  assert.equal(checksChip("bogus", { passed: 0, failed: 0, running: 0 }), null);
});

test("failuresPrompt: exact text with and without url, null when nothing failed", () => {
  assert.equal(
    failuresPrompt([bad("build", "https://ci/1"), ok("lint"), bad("test")]),
    "Checks are failing on this pull request:\n- build (https://ci/1)\n- test\n\nPlease investigate and fix them.",
  );
  assert.equal(failuresPrompt([ok("a"), run("b")]), null);
  assert.equal(failuresPrompt([]), null);
});

test("logsUrl: first failing with url, else any url, else the PR url, else null", () => {
  assert.equal(logsUrl([ok("a", "https://ok"), bad("b", "https://bad")], "https://pr"), "https://bad");
  assert.equal(logsUrl([bad("b"), ok("a", "https://ok")], "https://pr"), "https://ok");
  assert.equal(logsUrl([bad("b")], "https://pr"), "https://pr");
  assert.equal(logsUrl([], ""), null);
});

test("panelState: error or no branch → none; pr → pr; else no-pr (connected-but-no_forge → none)", () => {
  assert.equal(panelState({ error: "no_forge", branch: "x", pr: null }), "none");
  assert.equal(panelState({ error: "not_connected", branch: "x", pr: null }), "none");
  assert.equal(panelState({ error: null, branch: null, pr: null }), "none");
  assert.equal(panelState({ error: null, branch: "x", pr: null }), "no-pr");
  assert.equal(panelState({ error: null, branch: "x", pr: { number: 1 } }), "pr");
});

test("shipState: first match wins; aheadCount null is still ready; copy per state", () => {
  assert.deepEqual(shipState({ branch: "x", base: "main", aheadCount: 3, hasPr: true }), { state: "has-pr", copy: null });
  assert.deepEqual(shipState({ branch: null, base: "main", aheadCount: 3, hasPr: false }), {
    state: "detached", copy: "Detached HEAD — nothing to ship.",
  });
  assert.deepEqual(shipState({ branch: "x", base: null, aheadCount: 3, hasPr: false }), {
    state: "unknown", copy: "Base branch unknown — nothing to ship.",
  });
  assert.deepEqual(shipState({ branch: "main", base: "main", aheadCount: 0, hasPr: false }), {
    state: "on-base", copy: "On the base branch — nothing to ship.",
  });
  assert.deepEqual(shipState({ branch: "x", base: "main", aheadCount: 0, hasPr: false }), {
    state: "no-commits", copy: "Nothing to ship — no commits ahead of main",
  });
  assert.deepEqual(shipState({ branch: "x", base: "main", aheadCount: null, hasPr: false }), { state: "ready", copy: null });
  assert.deepEqual(shipState({ branch: "x", base: "main", aheadCount: 2, hasPr: false }), { state: "ready", copy: null });
});

test("canMerge: every blocking reason, and the one allowing case", () => {
  assert.deepEqual(canMerge({ rollup: "green", unresolvedThreads: 0, mergeable: null }), { can: false, reason: "still computing" });
  assert.deepEqual(canMerge({ rollup: "green", unresolvedThreads: 0, mergeable: false }), { can: false, reason: "not mergeable" });
  assert.deepEqual(canMerge({ rollup: "yellow", unresolvedThreads: 0, mergeable: true }), { can: false, reason: "checks still running" });
  assert.deepEqual(canMerge({ rollup: "red", unresolvedThreads: 0, mergeable: true }), { can: false, reason: "checks failing" });
  assert.deepEqual(canMerge({ rollup: "none", unresolvedThreads: 0, mergeable: true }), { can: false, reason: "no checks" });
  assert.deepEqual(canMerge({ rollup: "green", unresolvedThreads: 1, mergeable: true }), { can: false, reason: "1 unresolved thread" });
  assert.deepEqual(canMerge({ rollup: "green", unresolvedThreads: 3, mergeable: true }), { can: false, reason: "3 unresolved threads" });
  assert.deepEqual(canMerge({ rollup: "green", unresolvedThreads: 0, mergeable: true }), { can: true, reason: null });
});

test("mergeableDisplay: blocked reason wins, then mergeable, then computing", () => {
  assert.deepEqual(mergeableDisplay({ mergeBlockedReason: "conflicts", mergeable: true }), { text: "conflicts", tone: "danger" });
  assert.deepEqual(mergeableDisplay({ mergeable: true }), { text: "mergeable", tone: "ok" });
  assert.deepEqual(mergeableDisplay({ mergeable: null }), { text: "computing…", tone: "muted" });
});

test("mergeFailureMessage: each kind incl. blocked", () => {
  assert.match(mergeFailureMessage("sha_mismatch"), /head SHA moved/);
  assert.match(mergeFailureMessage("cannot_merge"), /^Cannot merge — the PR is blocked/);
  assert.equal(mergeFailureMessage("permission"), "No permission to merge this pull request.");
  assert.equal(mergeFailureMessage("blocked", "checks failing"), "Can't merge yet: checks failing");
  assert.equal(mergeFailureMessage("http_500"), "Merge failed (http_500).");
  assert.equal(mergeFailureMessage(null), "Merge failed.");
});

test("shipErrorMessage table", () => {
  assert.equal(shipErrorMessage("no_forge"), "This folder isn't linked to a GitHub repository.");
  assert.equal(shipErrorMessage("not_connected"), "GitHub isn't connected on this server.");
  assert.equal(shipErrorMessage("no_branch"), "Detached HEAD — check out a branch first.");
  assert.equal(shipErrorMessage("unknown_base"), "Couldn't tell which branch to target.");
  assert.equal(shipErrorMessage("push failed: denied"), "Couldn't push the branch: denied");
  assert.equal(shipErrorMessage("create pull request failed: 422"), "GitHub refused the pull request: 422");
  assert.equal(shipErrorMessage("weird"), "weird");
});

test("reviewErrorMessage table", () => {
  assert.equal(reviewErrorMessage("diff", "no_pr"), "No pull request on this session's branch.");
  assert.equal(reviewErrorMessage("draft-get", "not_connected"), "No forge connection to this repository.");
  assert.equal(reviewErrorMessage("draft-comment", "no_forge"), "No linked forge repository.");
  assert.equal(reviewErrorMessage("draft-comment", "comment body is required"), "Write a comment first.");
  assert.equal(reviewErrorMessage("draft-comment", "invalid comment anchor"), "That line can't take a comment.");
  assert.equal(reviewErrorMessage("draft-comment", "comment not found"), "That comment was already removed.");
  assert.equal(reviewErrorMessage("thread-reply", "empty reply"), "Write a reply first.");
  assert.equal(reviewErrorMessage("thread-reply", "missing threadId"), "That thread is no longer available.");
  assert.equal(reviewErrorMessage("thread-reply", "boom"), "GitHub didn't accept the reply: boom");
  assert.equal(reviewErrorMessage("draft-submit", "nothing to submit"), "Add at least one line comment before submitting.");
  assert.match(reviewErrorMessage("draft-submit", "x", "http_422"), /^GitHub rejected the review/);
  assert.equal(reviewErrorMessage("draft-submit", "boom"), "Couldn't submit — your comments are kept. (boom)");
});

test("pullRequestView: PR with failing check, blocked merge", () => {
  const checks = [bad("build", "https://ci/b"), ok("lint")];
  const v = pullRequestView({
    pr: { number: 412, url: "https://gh/pr/412", unresolvedThreads: 0, mergeable: true },
    checks, rollup: "red", error: null, branch: "feat/x", base: "main", aheadCount: 2,
  });
  assert.equal(v.panel, "pr");
  assert.equal(v.chipLabel, "feat/x · #412");
  assert.deepEqual(v.ship, { state: "has-pr", copy: null });
  assert.deepEqual(v.merge, { can: false, reason: "checks failing", mergeable: { text: "mergeable", tone: "ok" } });
  assert.deepEqual(v.checks.counts, { passed: 1, failed: 1, running: 0 });
  assert.deepEqual(v.checks.chip, { glyph: "✗", label: "✗ 1 failed", tone: "danger" });
  assert.match(v.checks.failuresPrompt, /- build \(https:\/\/ci\/b\)/);
  assert.equal(v.checks.logsUrl, "https://ci/b");
});

test("pullRequestView: no PR → no merge, no chip; no forge → panel none, null chipLabel", () => {
  const noPr = pullRequestView({ pr: null, checks: [], rollup: "none", error: null, branch: "feat/x", base: "main", aheadCount: 1 });
  assert.equal(noPr.panel, "no-pr");
  assert.equal(noPr.chipLabel, "feat/x");
  assert.equal(noPr.merge, null);
  assert.equal(noPr.checks.chip, null);
  assert.equal(noPr.ship.state, "ready");
  const none = pullRequestView({ pr: null, checks: [], rollup: "none", error: "no_forge", branch: "feat/x", base: null, aheadCount: null });
  assert.equal(none.panel, "none");
  assert.equal(none.chipLabel, null);
});

test("pullRequestView: chip is null with a PR but no checks or rollup none", () => {
  const pr = { number: 1, url: "u", unresolvedThreads: 0, mergeable: true };
  assert.equal(pullRequestView({ pr, checks: [], rollup: "none", error: null, branch: "b", base: "main", aheadCount: 1 }).checks.chip, null);
  assert.equal(pullRequestView({ pr, checks: [ok("a")], rollup: "none", error: null, branch: "b", base: "main", aheadCount: 1 }).checks.chip, null);
});

test("createLastPrCache is bounded and drop removes an entry", () => {
  const cache = createLastPrCache({ max: 2 });
  cache.set("/a", "b1", { pr: 1 });
  cache.set("/b", "b2", { pr: 2 });
  cache.set("/c", "b3", { pr: 3 });
  assert.ok(cache.size <= 2);
  cache.set("/d", "b4", { pr: 4 });
  assert.deepEqual(cache.get("/d", "b4"), { pr: 4 });
  cache.drop("/d", "b4");
  assert.equal(cache.get("/d", "b4"), undefined);
});

test("inboxRowView: labels, identifier, secondary, repoName, tone, branchName, localPath", () => {
  const pr = { kind: "pr", number: 412, title: "Fix the Thing!!", repoKey: "github.com/acme/manta", reason: "checks failing" };
  assert.deepEqual(inboxRowView(pr, { "github.com/acme/manta": "/home/dev/projects/manta" }), {
    label: "checks red",
    identifier: "!412",
    secondary: "checks red · manta",
    repoName: "manta",
    tone: "danger",
    branchName: "manta/pr-412-fix-the-thing",
    localPath: "/home/dev/projects/manta",
  });
  const issue = { kind: "issue", number: 88, title: "", repoKey: "github.com/acme/web", reason: "assigned" };
  const row = inboxRowView(issue, new Map());
  assert.equal(row.label, "issue · assigned to you");
  assert.equal(row.identifier, "#88");
  assert.equal(row.secondary, "issue · assigned to you");
  assert.equal(row.tone, "muted");
  assert.equal(row.branchName, "manta/issue-88");
  assert.equal(row.localPath, null);
  const rr = inboxRowView({ kind: "pr", number: 1, title: "x", repoKey: "h/o/r", reason: "review requested" });
  assert.equal(rr.label, "review requested");
  assert.equal(rr.tone, "warn");
});

test("inboxRowView: branch slug is capped at 40 chars", () => {
  const row = inboxRowView({ kind: "issue", number: 5, title: "a".repeat(100), repoKey: "h/o/r", reason: "assigned" });
  assert.equal(row.branchName, `manta/issue-5-${"a".repeat(40)}`);
});
