// github.test.mjs — the GitHub read-path adapter (BET-788). No live network:
// `request` is injected. Pins the three traps (PRs-are-issues, two CI systems,
// mergeable:null) at the adapter boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGithubAdapter,
  GithubRequestError,
  MergeNotAllowedError,
  MergeShaMismatchError,
  MergePermissionError,
} from "./github.mjs";
import { rollupChecks } from "../../shared/forge.mjs";

const REPO = { owner: "acme", repo: "widget" };

// A real-ish captured GitHub PR payload (shape from GET /repos/{o}/{r}/pulls/{n}).
const PR_FIXTURE = {
  number: 42,
  title: "Add forge read path",
  body: "Implements the GitHub adapter.",
  html_url: "https://github.com/acme/widget/pull/42",
  state: "open",
  draft: false,
  merged: false,
  mergeable: false,
  mergeable_state: "unstable",
  user: { login: "octocat" },
  head: { ref: "feature/forge", sha: "abc123" },
  base: { ref: "main", sha: "def456" },
};

const REVIEWS = [
  { user: { login: "ada" }, state: "CHANGES_REQUESTED" },
  { user: { login: "ada" }, state: "APPROVED" },
  { user: { login: "octocat" }, state: "COMMENTED" }, // author excluded from reviewers
  { user: { login: "grace" }, state: "APPROVED" },
];

const COMMENTS = [
  { id: 1, body: "one thing", in_reply_to_id: null },
  { id: 2, body: "reply", in_reply_to_id: 1 },
  { id: 3, body: "unresolved", in_reply_to_id: null },
];

function fakeRequest(map) {
  return async (url) => ({ data: map[url], stale: false });
}

test("getPullRequest normalises a captured GitHub payload into the shared PullRequest shape", async () => {
  const base = `https://api.github.com/repos/acme/widget/pulls/42`;
  const adapter = createGithubAdapter(
    fakeRequest({
      [base]: PR_FIXTURE,
      [`${base}/reviews`]: REVIEWS,
      [`${base}/comments`]: COMMENTS,
    }),
  );
  const { data: pr } = await adapter.getPullRequest(REPO, 42);

  assert.equal(pr.number, 42);
  assert.equal(pr.title, "Add forge read path");
  assert.equal(pr.url, "https://github.com/acme/widget/pull/42");
  assert.equal(pr.state, "open");
  assert.equal(pr.draft, false);
  assert.equal(pr.headRef, "feature/forge");
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.headSha, "abc123");
  assert.equal(pr.author, "octocat");
  // reviewers: distinct logins, author excluded → ada, grace.
  assert.deepEqual(pr.reviewers, ["ada", "grace"]);
  // unresolvedThreads = top-level threads (not replies) → #1 + #3.
  assert.equal(pr.unresolvedThreads, 2);
});

test("mergeable:null survives as null (forge still computing)", async () => {
  const base = `https://api.github.com/repos/acme/widget/pulls/7`;
  const pending = { ...PR_FIXTURE, number: 7, mergeable: null, mergeable_state: null };
  const adapter = createGithubAdapter(
    fakeRequest({ [base]: pending, [`${base}/reviews`]: [], [`${base}/comments`]: [] }),
  );
  const { data: pr } = await adapter.getPullRequest(REPO, 7);
  assert.equal(pr.mergeable, null);
  assert.equal(pr.mergeBlockedReason, null, "null mergeable must not fabricate a reason");
});

test("deriveMergeBlockedReason: draft → 'draft', dirty → 'conflicts', unstable → 'checks failing'", async () => {
  const base = (n) => `https://api.github.com/repos/acme/widget/pulls/${n}`;
  const cases = [
    { ...PR_FIXTURE, number: 1, draft: true, mergeable: null },
    { ...PR_FIXTURE, number: 2, mergeable: false, mergeable_state: "dirty" },
    { ...PR_FIXTURE, number: 3, mergeable: false, mergeable_state: "unstable" },
    { ...PR_FIXTURE, number: 4, mergeable: true, mergeable_state: "clean" },
  ];
  const map = {};
  for (const c of cases) {
    map[`${base(c.number)}`] = c;
    map[`${base(c.number)}/reviews`] = [];
    map[`${base(c.number)}/comments`] = [];
  }
  const adapter = createGithubAdapter(fakeRequest(map));
  assert.equal((await adapter.getPullRequest(REPO, 1)).data.mergeBlockedReason, "draft");
  assert.equal((await adapter.getPullRequest(REPO, 2)).data.mergeBlockedReason, "conflicts");
  assert.equal((await adapter.getPullRequest(REPO, 3)).data.mergeBlockedReason, "checks failing");
  assert.equal((await adapter.getPullRequest(REPO, 4)).data.mergeBlockedReason, null);
});

test("listIssues filters out pull requests (PRs are issues on GitHub)", async () => {
  const url = "https://api.github.com/repos/acme/widget/issues?state=open";
  const adapter = createGithubAdapter(
    fakeRequest({
      [url]: [
        { number: 1, title: "real issue", body: "", html_url: "u/1", state: "open", closed_at: null },
        { number: 2, title: "pr masquerading", body: "", html_url: "u/2", state: "open", closed_at: null, pull_request: { url: "..." } },
        { number: 3, title: "another issue", body: "", html_url: "u/3", state: "open", closed_at: null },
      ],
    }),
  );
  const { data: issues } = await adapter.listIssues(REPO, { state: "open" });
  assert.deepEqual(issues.map((i) => i.number), [1, 3], "the entry carrying pull_request must be dropped");
});

test("getChecks merges check-runs AND legacy statuses into one array that rollupChecks can roll", async () => {
  const url = (suffix) => `https://api.github.com/repos/acme/widget/commits/abc123${suffix}`;
  const checkRuns = {
    check_runs: [
      { id: 1, name: "ci / test", status: "completed", conclusion: "success", html_url: "https://check/1" },
      { id: 2, name: "ci / lint", status: "in_progress", conclusion: null, html_url: "https://check/2" },
    ],
  };
  const legacy = {
    state: "success",
    statuses: [
      { context: "legacy/status", state: "pending", target_url: "https://status/1" },
    ],
  };
  const adapter = createGithubAdapter(
    fakeRequest({ [url("/check-runs")]: checkRuns, [url("/status")]: legacy }),
  );
  const { data: checks } = await adapter.getChecks(REPO, "abc123");

  assert.equal(checks.length, 3, "check-runs + statuses merged into one array");
  // A still-running check makes the union roll to yellow (traffic-light).
  assert.equal(rollupChecks(checks), "yellow");

  // All-green inputs roll to green (union path proven end-to-end).
  const allOk = createGithubAdapter(
    fakeRequest({
      [url("/check-runs")]: {
        check_runs: [{ name: "a", status: "completed", conclusion: "success" }],
      },
      [url("/status")]: { state: "success", statuses: [{ context: "b", state: "success" }] },
    }),
  );
  assert.equal(rollupChecks((await allOk.getChecks(REPO, "abc123")).data), "green");
});

test("listPullRequests normalises an array of PRs with draft handling", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls?state=open";
  const adapter = createGithubAdapter(
    fakeRequest({
      [url]: [
        { ...PR_FIXTURE, number: 9, state: "closed", merged: true, head: { ref: "x", sha: "1" }, base: { ref: "main", sha: "2" } },
        { ...PR_FIXTURE, number: 10, draft: true, state: "open", head: { ref: "y", sha: "3" }, base: { ref: "main", sha: "4" } },
      ],
    }),
  );
  const { data: prs } = await adapter.listPullRequests(REPO, { state: "open" });
  assert.equal(prs[0].state, "merged");
  assert.equal(prs[0].draft, false);
  assert.equal(prs[1].state, "draft");
  assert.equal(prs[1].draft, true);
});

// ---------------------------------------------------------------------------
// Write path (BET-794): createPullRequest + merge
// ---------------------------------------------------------------------------

// A fake write transport that records every call and returns a canned body.
function fakeWrite(map = {}, rejecter) {
  const calls = [];
  const write = async (url, opts) => {
    calls.push({ url, opts });
    if (rejecter) rejecter(url, opts);
    if (map[url]) return { data: map[url], stale: false };
    return { data: { ok: true }, stale: false };
  };
  write.calls = calls;
  return write;
}

test("createPullRequest POSTs the payload shape including draft", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls";
  const created = { ...PR_FIXTURE, number: 99, draft: true, head: { ref: "feature/forge", sha: "abc123" } };
  const write = fakeWrite({ [url]: created });
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);

  const { data: pr } = await adapter.createPullRequest(REPO, {
    title: "Forge seam",
    head: "feature/forge",
    base: "main",
    body: "Adds the vocabulary layer.",
    draft: true,
  });

  assert.equal(write.calls.length, 1);
  assert.equal(write.calls[0].url, url);
  assert.equal(write.calls[0].opts.method, "POST");
  assert.deepEqual(write.calls[0].opts.body, {
    title: "Forge seam",
    head: "feature/forge",
    base: "main",
    body: "Adds the vocabulary layer.",
    draft: true,
  });
  // The created PR is normalised back to the shared PullRequest shape.
  assert.equal(pr.number, 99);
  assert.equal(pr.draft, true);
  assert.equal(pr.state, "draft");
});

test("createPullRequest default: non-draft, empty body, draft flag false", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls";
  const write = fakeWrite({ [url]: { ...PR_FIXTURE, number: 5, draft: true } });
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);
  await adapter.createPullRequest(REPO, { title: "t", head: "h", base: "main" });
  assert.deepEqual(write.calls[0].opts.body, {
    title: "t", head: "h", base: "main", body: "", draft: false,
  });
});

test("merge passes the head SHA (never merges without it)", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls/42/merge";
  const write = fakeWrite({ [url]: { merged: true, sha: "abc123" } });
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);
  const { data } = await adapter.merge(REPO, 42, { method: "squash", sha: "abc123" });
  assert.equal(write.calls[0].url, url);
  assert.equal(write.calls[0].opts.method, "PUT");
  assert.deepEqual(write.calls[0].opts.body, { merge_method: "squash", sha: "abc123" });
  assert.equal(data.merged, true);
});

test("merge maps each failure status to its distinguished typed error", async () => {
  const base = "https://api.github.com/repos/acme/widget/pulls/42/merge";
  const cases = [
    { status: 403, Expected: MergePermissionError, kind: "permission" },
    { status: 405, Expected: MergeNotAllowedError, kind: "cannot_merge" },
    { status: 409, Expected: MergeShaMismatchError, kind: "sha_mismatch" },
    // An out-of-band status surfaces generically (GithubRequestError) with .status.
    { status: 422, Expected: GithubRequestError, kind: null },
  ];
  for (const { status, Expected, kind } of cases) {
    const write = async () => { throw new GithubRequestError(status, base); };
    const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);
    await assert.rejects(
      () => adapter.merge(REPO, 42, { method: "merge", sha: "abc123" }),
      (err) => {
        assert.ok(err instanceof Expected, `status ${status} → ${Expected.name}, got ${err?.name}`);
        assert.equal(err.status, status);
        if (kind) assert.equal(err.kind, kind);
        return true;
      },
    );
  }
});
