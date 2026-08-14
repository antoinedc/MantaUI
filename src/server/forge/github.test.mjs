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
  buildInboxQueries,
  normalizeSearchHit,
  mergeInboxSources,
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

// ---- getDiff / thread normalisation (BET-792) ----

const DIFF_TEXT = [
  "@@ -142,7 +142,9 @@ async function submitReview(repo, num, draft) {",
  "   const body = { event: draft.verdict, body: draft.body };",
  "-  for (const c of draft.comments) await post(`/pulls/${num}/comments`, c);",
  "+  // flush the box-buffered draft as ONE review",
  "+  body.comments = draft.comments.map(toGithubAnchor);",
  "+  return post(`/pulls/${num}/reviews`, body);",
  "   }",
].join("\n");

// Captured GitHub review-comment payloads covering a single-line comment, a
// multi-line comment (start_line set), a reply, and a file-level comment.
const REVIEW_COMMENTS = [
  { id: 11, path: "src/forge.mjs", line: 20, side: "RIGHT", user: { login: "ada" }, body: "single-line note", created_at: "2026-08-01T10:00:00Z", in_reply_to_id: null, resolved: false },
  { id: 12, path: "src/forge.mjs", line: 25, side: "RIGHT", start_line: 22, start_side: "RIGHT", user: { login: "grace" }, body: "a multi-line comment", created_at: "2026-08-01T10:05:00Z", in_reply_to_id: null, resolved: true },
  { id: 13, path: "src/forge.mjs", line: 25, side: "RIGHT", user: { login: "ada" }, body: "reply to 12", created_at: "2026-08-01T10:06:00Z", in_reply_to_id: 12, resolved: false },
  { id: 14, path: "src/forge.mjs", line: null, side: null, user: { login: "grace" }, body: "file-level note", created_at: "2026-08-01T10:07:00Z", in_reply_to_id: null, resolved: false },
];

function diffAdapter() {
  const pull = `https://api.github.com/repos/acme/widget/pulls/42`;
  const json = {
    [pull]: { number: 42, title: "t", html_url: "u", state: "open", merged: false, draft: false, head: { ref: "x", sha: "abc123" }, base: { ref: "main", sha: "d" }, user: { login: "octocat" } },
    [`${pull}/comments?per_page=100&page=1`]: REVIEW_COMMENTS,
  };
  const jsonReq = async (url) => ({ data: json[url], stale: false });
  const textReq = async (url) => (url === pull ? { data: DIFF_TEXT, stale: false } : { data: "", stale: false });
  return createGithubAdapter(jsonReq, undefined, textReq);
}

test("getDiff returns the raw diff text, headSha and normalised threads", async () => {
  const { data, stale } = await diffAdapter().getDiff(REPO, 42);
  assert.equal(data.diff, DIFF_TEXT);
  assert.equal(data.headSha, "abc123");
  assert.equal(stale, false);
  assert.equal(data.threads.length, 3, "the reply to #12 groups into #12's thread");
});

test("thread normalisation yields a startLine for a multi-line comment and groups its reply", async () => {
  const { data } = await diffAdapter().getDiff(REPO, 42);
  const multi = data.threads.find((t) => t.id === "12");
  assert.equal(multi.startLine, 22);
  assert.equal(multi.line, 25);
  assert.equal(multi.side, "RIGHT");
  assert.equal(multi.resolved, true);
  assert.equal(multi.comments.map((c) => c.author).join(","), "grace,ada");
  assert.equal(multi.comments[1].body, "reply to 12");
});

test("a file-level comment (no line) normalises to a thread with a null line, and its body/path survive", async () => {
  const { data } = await diffAdapter().getDiff(REPO, 42);
  const file = data.threads.find((t) => t.id === "14");
  assert.equal(file.line, null);
  assert.equal(file.side, null);
  assert.equal(file.startLine, null);
  assert.equal(file.path, "src/forge.mjs");
  assert.equal(file.comments[0].body, "file-level note");
});

test("getDiff accumulates review-comment threads spanning multiple pages", async () => {
  const pull = `https://api.github.com/repos/acme/widget/pulls/42`;
  const comment = (id, path, line) => ({
    id, path, line, side: "RIGHT", user: { login: "ada" }, body: `body ${id}`,
    created_at: "2026-08-01T10:00:00Z", in_reply_to_id: null, resolved: false,
  });
  const page1 = Array.from({ length: 100 }, (_, i) => comment(1000 + i, "a.ts", i + 1));
  const page2 = Array.from({ length: 37 }, (_, i) => comment(2000 + i, "b.ts", i + 1));
  const json = {
    [pull]: { number: 42, title: "t", html_url: "u", state: "open", merged: false, draft: false, head: { ref: "x", sha: "abc123" }, base: { ref: "main", sha: "d" }, user: { login: "octocat" } },
    [`${pull}/comments?per_page=100&page=1`]: page1,
    [`${pull}/comments?per_page=100&page=2`]: page2,
  };
  const jsonReq = async (url) => ({ data: json[url], stale: false });
  const textReq = async (url) => (url === pull ? { data: DIFF_TEXT, stale: false } : { data: "", stale: false });
  const adapter = createGithubAdapter(jsonReq, undefined, textReq);
  const { data } = await adapter.getDiff(REPO, 42);
  assert.equal(data.threads.length, 137, "threads from both pages are normalised together");
  assert.ok(data.threads.some((t) => t.id === "1000" && t.path === "a.ts"), "first page present");
  assert.ok(data.threads.some((t) => t.id === "2000" && t.path === "b.ts"), "second page present");
});

// ---- Review writes (BET-793): submitReview + replyToThread ------------------

test("submitReview POSTs ONE review carrying every buffered comment with correct anchors", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls/42/reviews";
  const write = fakeWrite({ [url]: { id: "rvw1", state: "APPROVED" } });
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);

  const comments = [
    { path: "a.ts", line: 1, side: "new", body: "c1" },
    { path: "a.ts", line: 2, side: "old", body: "c2" },
    { path: "b.ts", line: 5, side: "new", startLine: 3, body: "multi" },
  ];
  const { data } = await adapter.submitReview(REPO, 42, {
    verdict: "approved",
    body: "nice work",
    comments,
    headSha: "abc123",
  });

  assert.equal(write.calls.length, 1, "one write for the whole draft — the box-buffer payoff");
  assert.equal(write.calls[0].url, url);
  assert.equal(write.calls[0].opts.method, "POST");
  const body = write.calls[0].opts.body;
  assert.equal(body.event, "APPROVE");
  assert.equal(body.body, "nice work");
  assert.equal(body.comments.length, 3);
  assert.deepEqual(body.comments[0], { path: "a.ts", line: 1, side: "RIGHT", body: "c1", commit_id: "abc123" });
  assert.equal(body.comments[1].side, "LEFT", "old side maps to LEFT");
  const multi = body.comments[2];
  assert.equal(multi.line, 5);
  assert.equal(multi.side, "RIGHT");
  assert.equal(multi.start_line, 3);
  assert.equal(multi.start_side, "RIGHT");
  assert.equal(multi.commit_id, "abc123");
  assert.equal(data.state, "APPROVED");
});

test("submitReview verdict mapping: request_changes → REQUEST_CHANGES, null → COMMENT", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls/42/reviews";
  const seen = [];
  const write = async (u, opts) => { seen.push(opts.body); return { data: {}, stale: false }; };
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);

  await adapter.submitReview(REPO, 42, { verdict: "changes_requested", comments: [{ path: "a.ts", line: 1, side: "new", body: "x" }] });
  await adapter.submitReview(REPO, 42, { verdict: null, comments: [{ path: "a.ts", line: 1, side: "new", body: "x" }] });
  assert.equal(seen[0].event, "REQUEST_CHANGES");
  assert.equal(seen[1].event, "COMMENT", "no verdict → the neutral COMMENT event");
});

test("replyToThread POSTs a reply body + reviewed commit to the thread endpoint", async () => {
  const url = "https://api.github.com/repos/acme/widget/pulls/42/comments/77/replies";
  const write = fakeWrite({ [url]: { id: 88, body: "ok" } });
  const adapter = createGithubAdapter(() => Promise.resolve({ data: [], stale: false }), write);
  const { data } = await adapter.replyToThread(REPO, 42, { threadId: "77", body: "got it", headSha: "abc123" });
  assert.equal(write.calls[0].url, url);
  assert.equal(write.calls[0].opts.method, "POST");
  assert.deepEqual(write.calls[0].opts.body, { body: "got it", commit_id: "abc123" });
  assert.equal(data.id, 88);
});

// ---- listMyRepos (BET-796): the clone picker's remote repo source -----------

test("listMyRepos drops read-only repos and orders most-recently-pushed first", async () => {
  const url = "https://api.github.com/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member";
  const adapter = createGithubAdapter(
    fakeRequest({
      [url]: [
        {
          name: "tenanture",
          full_name: "acme/tenanture",
          owner: { login: "acme" },
          description: null,
          pushed_at: "2026-08-01T00:00:00Z",
          default_branch: "main",
          clone_url: "https://github.com/acme/tenanture.git",
          html_url: "https://github.com/acme/tenanture",
          permissions: { push: true },
        },
        {
          name: "manta-skills",
          full_name: "octo/manta-skills",
          owner: { login: "octo" },
          description: "Skill registry",
          pushed_at: "2026-07-20T00:00:00Z",
          default_branch: "main",
          clone_url: "https://github.com/octo/manta-skills.git",
          html_url: "https://github.com/octo/manta-skills",
          permissions: { push: true },
        },
        {
          name: "readonly",
          full_name: "acme/readonly",
          owner: { login: "acme" },
          description: "I cannot push here",
          pushed_at: "2026-08-02T00:00:00Z",
          default_branch: "main",
          clone_url: "https://github.com/acme/readonly.git",
          html_url: "https://github.com/acme/readonly",
          permissions: { push: false },
        },
      ],
    }),
  );
  const { data, stale } = await adapter.listMyRepos();
  assert.equal(stale, false);
  // read-only repo dropped, and order is most-recent-pushed first.
  assert.deepEqual(data.map((r) => r.name), ["tenanture", "manta-skills"]);
  assert.equal(data[0].fullName, "acme/tenanture");
  assert.equal(data[0].owner, "acme");
  assert.equal(data[0].pushedAt, Date.parse("2026-08-01T00:00:00Z"));
  assert.equal(data[1].description, "Skill registry");
  assert.equal(data[1].defaultBranch, "main");
  assert.equal(data[1].cloneUrl, "https://github.com/octo/manta-skills.git");
  assert.ok(!data.some((r) => r.fullName === "acme/readonly"));
});

// ---- Work inbox (BET-795) --------------------------------------------------

test("buildInboxQueries returns the three cross-repo populations with their reasons", () => {
  const qs = buildInboxQueries();
  assert.deepEqual(qs, [
    { query: "assignee:@me", reason: "assigned" },
    { query: "review-requested:@me", reason: "review requested" },
    { query: "author:@me is:open", reason: "checks failing" },
  ]);
});

test("searchIssues GETs /search/issues with the query and passes the ttl through", async () => {
  const seen = [];
  const request = async (url, opts) => {
    seen.push({ url, opts });
    return {
      data: {
        items: [
          {
            number: 5,
            title: "Fix login",
            html_url: "https://github.com/acme/widget/issues/5",
            state: "open",
            repository_url: "https://api.github.com/repos/acme/widget",
            updated_at: "2026-08-13T10:00:00Z",
          },
        ],
      },
      stale: false,
    };
  };
  const adapter = createGithubAdapter(request);
  const { data } = await adapter.searchIssues("assignee:@me", { ttl: 60000 });
  assert.equal(seen[0].url, "https://api.github.com/search/issues?q=assignee%3A%40me");
  assert.equal(seen[0].opts.ttl, 60000, "the search bucket's longer freshness is threaded through");
  assert.equal(seen[0].opts.method, undefined); // a plain GET
  assert.equal(data[0].number, 5);
  assert.equal(data[0].kind, "issue");
  assert.equal(data[0].repoKey, "github.com/acme/widget");
});

test("normalizeSearchHit: repo identity from repository_url, kind flips on the PR marker, headSha read defensively", () => {
  const issue = normalizeSearchHit({
    number: 1,
    title: "t",
    html_url: "https://github.com/acme/widget/issues/1",
    state: "open",
    repository_url: "https://api.github.com/repos/acme/widget",
    updated_at: "2026-08-13T10:00:00Z",
  });
  assert.equal(issue.kind, "issue");
  assert.equal(issue.owner, "acme");
  assert.equal(issue.repo, "widget");
  assert.equal(issue.repoKey, "github.com/acme/widget");

  const pr = normalizeSearchHit({
    number: 2,
    title: "p",
    html_url: "https://github.com/acme/widget/pull/2",
    repository_url: "https://api.github.com/repos/acme/widget",
    updated_at: "2026-08-13T11:00:00Z",
    pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/2", html_url: "https://github.com/acme/widget/pull/2" },
    head: { ref: "feat/x", sha: "abc123" },
  });
  assert.equal(pr.kind, "pr");
  assert.equal(pr.headSha, "abc123");
  assert.equal(normalizeSearchHit(null).kind, "issue", "defensive: a null/empty item normalises, doesn't throw");
});

test("mergeInboxSources dedupes a PR matching two queries to one row with the more urgent reason", () => {
  const a = {
    kind: "pr", owner: "acme", repo: "widget", repoKey: "github.com/acme/widget",
    number: 9, title: "Same PR", url: "https://github.com/acme/widget/pull/9",
    state: "open", updatedAt: 1000, headSha: "s", reason: "review requested",
  };
  const b = { ...a, reason: "checks failing" }; // same PR, claimed by the red-checks population
  const c = { ...a, number: 10, reason: "assigned", kind: "issue" };

  const merged = mergeInboxSources([[a], [b, c]]);
  assert.equal(merged.length, 2, "the two claims for PR 9 collapse into one row");
  const pr9 = merged.find((i) => i.number === 9);
  assert.equal(pr9.reason, "checks failing", "checks failing beats review requested");
  assert.equal(pr9.owner, "acme");
  const pr10 = merged.find((i) => i.number === 10);
  assert.equal(pr10.reason, "assigned");
});

test("mergeInboxSources precedence: checks failing > review requested > assigned", () => {
  const base = {
    kind: "pr", repoKey: "github.com/acme/widget", number: 3,
    title: "x", url: "u", state: "open", updatedAt: 0, headSha: "",
  };
  const assigned = { ...base, reason: "assigned" };
  const review = { ...base, reason: "review requested" };
  const red = { ...base, reason: "checks failing" };
  // assigned then review → review wins
  const m1 = mergeInboxSources([[assigned, review]]);
  assert.equal(m1[0].reason, "review requested");
  // review then assigned → review still wins (order-independent)
  const m2 = mergeInboxSources([[review, assigned]]);
  assert.equal(m2[0].reason, "review requested");
  // red beats review regardless of order
  const m3 = mergeInboxSources([[red, review]]);
  const m4 = mergeInboxSources([[review, red]]);
  assert.equal(m3[0].reason, "checks failing");
  assert.equal(m4[0].reason, "checks failing");
});
