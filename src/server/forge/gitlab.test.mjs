// gitlab.test.mjs — the GitLab adapter (BET-799). No live network: `request`
// / `requestWrite` are injected. Pins the eight mismatches at the adapter
// boundary (iid-vs-id, subgroup path encoding, opened-vs-open, disjoint issues,
// no-review-object submitReview, three-SHA position building, pipelines-not-
// checks, detailed_merge_status) plus the webhook signature schemes and the
// atomic OAuth token rotation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createGitlabAdapter,
  buildPosition,
} from "./gitlab.mjs";
import { rollupChecks } from "../../shared/forge.mjs";
import { verifyGitlabSignature, resolveSignature } from "../webhooks.mjs";
import { rotateOauthPair, parseGlabToken } from "./auth.mjs";

const REPO = { owner: "acme", repo: "widget" };

// A captured GitLab MR payload (GET /projects/{p}/merge_requests/{iid}).
// `iid` is 123, the GLOBAL `id` is 9999 — the whole #1 point is that `number`
// must be the iid, never the global id.
const MR_FIXTURE = {
  id: 9999,
  iid: 123,
  title: "Add GitLab adapter",
  description: "Implements the GitLab seam.",
  web_url: "https://gitlab.com/acme/widget/-/merge_requests/123",
  state: "opened",
  draft: false,
  detailed_merge_status: "can_be_merged",
  author: { username: "octocat" },
  source_branch: "feature/forge",
  target_branch: "main",
  sha: "abc123",
  reviewers: [{ username: "ada" }, { username: "octocat" }],
};

function fakeRequest(map) {
  return async (url) => ({ data: map[url], stale: false });
}

// A fake write transport that records every call (url + method + body).
function fakeWrite(map = {}) {
  const calls = [];
  const write = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    if (map[url]) return { data: map[url], stale: false };
    return { data: { ok: true }, stale: false };
  };
  write.calls = calls;
  return write;
}

const projectBase = (repo) =>
  `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`;

// ---- Mismatch #1: iid, never id --------------------------------------------

test("getPullRequest normalises a captured MR; number === iid, never the global id", async () => {
  const base = `${projectBase(REPO)}/merge_requests/123`;
  const adapter = createGitlabAdapter(
    fakeRequest({ [base]: MR_FIXTURE, [`${base}/discussions`]: [] }),
  );
  const { data: pr } = await adapter.getPullRequest(REPO, 123);

  assert.equal(pr.number, 123, "number is the iid");
  assert.notEqual(pr.number, MR_FIXTURE.id, "the global id must never leak into number");
  assert.equal(pr.title, "Add GitLab adapter");
  assert.equal(pr.url, "https://gitlab.com/acme/widget/-/merge_requests/123");
  assert.equal(pr.headRef, "feature/forge");
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.headSha, "abc123");
  assert.equal(pr.author, "octocat");
  assert.deepEqual(pr.reviewers, ["ada", "octocat"]);
  assert.equal(pr.mergeable, true);
  assert.equal(pr.mergeBlockedReason, null);
});

// ---- Mismatch #2: subgroup project addressing ------------------------------

test("a subgroup project path encodes the FULL owner/repo, never the segments", async () => {
  const subgroup = { owner: "group/sub", repo: "widget" };
  const seen = [];
  const request = async (url) => {
    seen.push(url);
    return { data: [], stale: false };
  };
  const adapter = createGitlabAdapter(request);
  await adapter.listPullRequests(subgroup, { state: "open" });

  assert.equal(seen.length, 1);
  assert.ok(
    seen[0].includes("/projects/group%2Fsub%2Fwidget/merge_requests"),
    `path must URL-encode the full group/sub path, got ${seen[0]}`,
  );
  assert.ok(!seen[0].includes("/group/sub/"), "slashes must be encoded, not raw");
});

test("listPullRequests head filter narrows the request to the source branch (BET-1422)", async () => {
  const url = `${projectBase(REPO)}/merge_requests?state=all&source_branch=cto-branch`;
  const adapter = createGitlabAdapter(
    fakeRequest({
      [url]: [MR_FIXTURE],
    }),
  );
  const { data: mrs } = await adapter.listPullRequests(REPO, { state: "all", head: "cto-branch" });
  assert.equal(mrs.length, 1);
  assert.equal(mrs[0].headRef, "feature/forge");
});

// ---- Mismatch #3: opened, not open -----------------------------------------

test('"opened" → "open" and "locked" is handled', async () => {
  const cases = [
    { state: "opened", expected: "open" },
    { state: "locked", expected: "open" },
    { state: "merged", expected: "merged" },
    { state: "closed", expected: "closed" },
  ];
  for (const { state, expected } of cases) {
    const base = `${projectBase(REPO)}/merge_requests/7`;
    const mr = { ...MR_FIXTURE, iid: 7, state, detailed_merge_status: "can_be_merged" };
    const adapter = createGitlabAdapter(fakeRequest({ [base]: mr, [`${base}/discussions`]: [] }));
    const { data: pr } = await adapter.getPullRequest(REPO, 7);
    assert.equal(pr.state, expected, `raw "${state}" → "${expected}"`);
  }
});

// ---- Mismatch #7: pipelines, not checks ------------------------------------

test("pipeline statuses incl. manual & scheduled roll up to yellow, not red", async () => {
  const base = projectBase(REPO);
  const adapter = createGitlabAdapter(
    fakeRequest({
      [`${base}/pipelines?sha=abc123`]: [
        { status: "success", name: "ci", web_url: "https://gl/ci/1" },
        { status: "manual", name: "ci/manual", web_url: "https://gl/ci/2" },
        { status: "scheduled", name: "ci/sched", web_url: "https://gl/ci/3" },
      ],
      [`${base}/repository/commits/abc123/statuses`]: [
        { status: "scheduled", name: "deploy", target_url: "https://gl/st/1" },
      ],
    }),
  );
  const { data: checks } = await adapter.getChecks(REPO, "abc123");
  assert.equal(checks.length, 4, "pipelines + commit statuses merged");
  assert.equal(rollupChecks(checks), "yellow", "manual/scheduled are pending-ish → yellow, never red");

  const allGreen = createGitlabAdapter(
    fakeRequest({
      [`${base}/pipelines?sha=abc123`]: [{ status: "success" }],
      [`${base}/repository/commits/abc123/statuses`]: [{ status: "success" }],
    }),
  );
  assert.equal(rollupChecks((await allGreen.getChecks(REPO, "abc123")).data), "green");
});

// ---- Mismatch #8: detailed_merge_status → mergeable + reason ---------------

test("detailed_merge_status maps to mergeable + a distinct mergeBlockedReason", async () => {
  const cases = [
    { status: "conflict", reason: "conflicts" },
    { status: "need_rebase", reason: "needs rebase" },
    { status: "ci_must_pass", reason: "checks failing" },
    { status: "not_approved", reason: "approval required" },
    { status: "discussions_not_resolved", reason: "unresolved discussions" },
  ];
  const seen = new Set();
  for (const { status, reason } of cases) {
    const base = `${projectBase(REPO)}/merge_requests/9`;
    const mr = { ...MR_FIXTURE, iid: 9, detailed_merge_status: status };
    const adapter = createGitlabAdapter(fakeRequest({ [base]: mr, [`${base}/discussions`]: [] }));
    const { data: pr } = await adapter.getPullRequest(REPO, 9);
    assert.equal(pr.mergeable, false, `${status} is not mergeable`);
    assert.ok(pr.mergeBlockedReason, `${status} yields a reason`);
    assert.equal(pr.mergeBlockedReason, reason);
    seen.add(pr.mergeBlockedReason);
  }
  assert.ok(seen.size >= 4, `at least four distinct reasons, got ${seen.size}: ${[...seen].join(", ")}`);
});

test("detailed_merge_status still computing → mergeable null, no fabricated reason", async () => {
  const base = `${projectBase(REPO)}/merge_requests/11`;
  const mr = { ...MR_FIXTURE, iid: 11, detailed_merge_status: "checking" };
  const adapter = createGitlabAdapter(fakeRequest({ [base]: mr, [`${base}/discussions`]: [] }));
  const { data: pr } = await adapter.getPullRequest(REPO, 11);
  assert.equal(pr.mergeable, null);
  assert.equal(pr.mergeBlockedReason, null);
});

// ---- Position building (mismatch #6) ---------------------------------------

const SHAS = { base_sha: "b", start_sha: "s", head_sha: "h" };

test("position building: added / removed / unchanged line → right new_line/old_line", () => {
  const added = buildPosition(SHAS, { path: "a.ts", line: 10, side: "new" });
  assert.equal(added.new_line, 10);
  assert.equal(added.old_line, undefined, "an added line sets new_line only");
  assert.equal(added.width, "right");
  assert.equal(added.head_sha, "h");

  const removed = buildPosition(SHAS, { path: "a.ts", line: 20, side: "old" });
  assert.equal(removed.old_line, 20);
  assert.equal(removed.new_line, undefined, "a removed line sets old_line only");
  assert.equal(removed.width, "left");

  const unchanged = buildPosition(SHAS, { path: "a.ts", line: 30, side: "both" });
  assert.equal(unchanged.new_line, 30, "an unchanged line sets new_line");
  assert.equal(unchanged.old_line, 30, "an unchanged line sets old_line too");
  assert.equal(unchanged.width, "right");
  assert.equal(unchanged.position_type, "text");
});

// ---- submitReview (mismatch #5): N discussions + one approve --------------

test("submitReview posts N discussions (each buffered comment) then ONE approve", async () => {
  const base = `${projectBase(REPO)}/merge_requests/42`;
  const write = fakeWrite({});
  const adapter = createGitlabAdapter(
    fakeRequest({ [`${base}/versions`]: [{ base_sha: "b", start_sha: "s", head_sha: "abc123" }] }),
    write,
  );

  const comments = [
    { path: "a.ts", line: 1, side: "new", body: "c1" },
    { path: "a.ts", line: 2, side: "old", body: "c2" },
    { path: "b.ts", line: 5, side: "new", body: "c3" },
  ];
  const { data } = await adapter.submitReview(REPO, 42, {
    verdict: "approved",
    body: "",
    comments,
    headSha: "abc123",
  });

  const discussionCalls = write.calls.filter((c) => c.url === `${base}/discussions` && c.method === "POST");
  const approveCalls = write.calls.filter((c) => c.url === `${base}/approve`);
  assert.equal(write.calls.length, 4, "3 discussions + 1 approve");
  assert.equal(discussionCalls.length, 3, "every buffered comment becomes a discussion");
  assert.equal(approveCalls.length, 1, "exactly one approve");
  assert.equal(data.verdict, "approved");
  assert.equal(data.comments, 3);

  // The first discussion carries a position (anchored with the three SHAs).
  assert.ok(discussionCalls[0].body.position, "a comment posts a positioned discussion");
  assert.equal(discussionCalls[0].body.position.head_sha, "abc123");
});

test("submitReview changes_requested → discussions + unapprove, no approve", async () => {
  const base = `${projectBase(REPO)}/merge_requests/42`;
  const write = fakeWrite({});
  const adapter = createGitlabAdapter(
    fakeRequest({ [`${base}/versions`]: [{ base_sha: "b", start_sha: "s", head_sha: "h" }] }),
    write,
  );
  await adapter.submitReview(REPO, 42, {
    verdict: "changes_requested",
    body: "",
    comments: [{ path: "a.ts", line: 1, side: "new", body: "c1" }],
    headSha: "h",
  });
  const unapprove = write.calls.filter((c) => c.url === `${base}/unapprove`);
  const approve = write.calls.filter((c) => c.url === `${base}/approve`);
  assert.equal(unapprove.length, 1);
  assert.equal(approve.length, 0);
});

test("submitReview posts a non-empty review body as a general MR note", async () => {
  const base = `${projectBase(REPO)}/merge_requests/42`;
  const write = fakeWrite({});
  const adapter = createGitlabAdapter(
    fakeRequest({ [`${base}/versions`]: [{ base_sha: "b", start_sha: "s", head_sha: "h" }] }),
    write,
  );
  await adapter.submitReview(REPO, 42, {
    verdict: "commented",
    body: "summary note",
    comments: [],
    headSha: "h",
  });
  const note = write.calls.find((c) => c.url === `${base}/notes`);
  assert.ok(note, "a review body is posted as a general MR note");
  assert.equal(note.body.body, "summary note");
});

// ---- resolveThread (optional capability, absent on GitHub) -----------------

test("resolveThread PUTs resolved:true to the discussion endpoint", async () => {
  const base = `${projectBase(REPO)}/merge_requests/42/discussions/d1`;
  const write = fakeWrite({ [base]: { id: "d1", resolved: true } });
  const adapter = createGitlabAdapter(() => Promise.resolve({ data: {}, stale: false }), write);
  const { data } = await adapter.resolveThread(REPO, 42, { discussionId: "d1" });
  assert.equal(write.calls.length, 1);
  assert.equal(write.calls[0].url, base);
  assert.equal(write.calls[0].method, "PUT");
  assert.deepEqual(write.calls[0].body, { resolved: true });
  assert.equal(data.id, "d1");
});

// ---- createPullRequest: draft via title prefix -----------------------------

test("createPullRequest posts source/target branches and prefixes Draft: for a draft MR", async () => {
  const url = `${projectBase(REPO)}/merge_requests`;
  const created = { ...MR_FIXTURE, iid: 99, draft: true, title: "Draft: Forge seam" };
  const write = fakeWrite({ [url]: created });
  const adapter = createGitlabAdapter(() => Promise.resolve({ data: [], stale: false }), write);
  const { data: pr } = await adapter.createPullRequest(REPO, {
    title: "Forge seam",
    head: "feature/forge",
    base: "main",
    body: "B",
    draft: true,
  });
  assert.equal(write.calls[0].method, "POST");
  assert.deepEqual(write.calls[0].body, {
    source_branch: "feature/forge",
    target_branch: "main",
    title: "Draft: Forge seam",
    description: "B",
  });
  assert.equal(pr.draft, true);
});

// ---- getDiff: assemble unified diff + normalised threads -------------------

test("getDiff assembles the diff from /changes and normalises discussions into threads", async () => {
  const base = `${projectBase(REPO)}/merge_requests/42`;
  const adapter = createGitlabAdapter(
    fakeRequest({
      [base]: { ...MR_FIXTURE, iid: 42, sha: "abc123" },
      [`${base}/changes`]: {
        changes: [{ diff: "@@ -1 +1 @@\n+a\n" }, { diff: "@@ -5 +5 @@\n+b\n" }],
      },
      [`${base}/discussions`]: [
        {
          id: "d1",
          resolved: false,
          notes: [
            {
              author: { username: "ada" },
              body: "look here",
              created_at: "2026-08-01T10:00:00Z",
              position: { new_path: "a.ts", new_line: 1 },
            },
          ],
        },
        {
          id: "d2",
          resolved: true,
          notes: [
            {
              author: { username: "grace" },
              body: "older",
              created_at: "2026-08-01T10:05:00Z",
              position: { new_path: "a.ts", old_line: 5 },
            },
          ],
        },
        {
          id: "d3",
          resolved: false,
          notes: [{ author: { username: "bob" }, body: "not a line comment" }],
        },
      ],
    }),
  );
  const { data } = await adapter.getDiff(REPO, 42);
  assert.equal(data.diff, "@@ -1 +1 @@\n+a\n\n@@ -5 +5 @@\n+b\n");
  assert.equal(data.headSha, "abc123");
  assert.equal(data.threads.length, 2, "general (non-line) discussions are not threads");
  assert.equal(data.threads[0].id, "d1");
  assert.equal(data.threads[0].line, 1);
  assert.equal(data.threads[0].side, "RIGHT", "new_line → RIGHT side");
  assert.equal(data.threads[0].comments[0].body, "look here");
  assert.equal(data.threads[1].side, "LEFT", "old_line → LEFT side");
  assert.equal(data.threads[1].resolved, true);
});

// ---- Progress sink comment methods (iid-scoped on GitLab) ------------------

test("comment methods address GitLab MR notes iid-scoped; update matches the shared 4-arg contract", async () => {
  const base = projectBase(REPO);
  const write = fakeWrite({
    [`${base}/merge_requests/42/notes/77`]: { id: 77 },
  });
  const adapter = createGitlabAdapter(
    fakeRequest({
      [`${base}/merge_requests/42/notes`]: [{ id: 7, body: "old" }],
    }),
    write,
  );

  const listed = await adapter.listIssueComments(REPO, 42);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, 7);

  await adapter.createIssueComment(REPO, 42, "hello");
  const createWrite = write.calls.find((c) => c.url === `${base}/merge_requests/42/notes` && c.method === "POST");
  assert.ok(createWrite, "createIssueComment POSTs to the MR notes endpoint");
  assert.equal(createWrite.body.body, "hello");

  // The sink calls updateComment(repo, number, commentId, body) — the unified
  // shared contract — which on GitLab must reach /merge_requests/{iid}/notes/{id}.
  await adapter.updateIssueComment(REPO, 42, 77, "updated");
  const updateWrite = write.calls.find((c) => c.url === `${base}/merge_requests/42/notes/77`);
  assert.ok(updateWrite, "updateIssueComment PUTs to the iid-scoped note endpoint");
  assert.equal(updateWrite.method, "PUT");
  assert.equal(updateWrite.body.body, "updated");
});

// ---- Mismatch #4: issues and MRs are disjoint ------------------------------

test("listIssues maps iid → number with no PR filtering (GitLab issues are disjoint)", async () => {
  const url = `${projectBase(REPO)}/issues?state=opened`;
  const adapter = createGitlabAdapter(
    fakeRequest({
      [url]: [
        { iid: 1, title: "issue one", description: "", web_url: "u/1", state: "opened" },
        { iid: 2, title: "issue two", description: "", web_url: "u/2", state: "closed" },
      ],
    }),
  );
  const { data: issues } = await adapter.listIssues(REPO, { state: "open" });
  // "open" filter maps to GitLab's "opened", and no pull_request filtering needed.
  assert.equal(issues.map((i) => i.number).join(","), "1,2");
  assert.equal(issues[0].state, "opened");
  assert.equal(issues[1].closed, true);
});

// ---- Webhook signature schemes (a THIRD scheme) ----------------------------

test("Standard Webhooks signature verifies; X-Gitlab-Token verifies; a bad one fails", () => {
  const keyBytes = Buffer.from("0123456789abcdef0123456789abcdef");
  const secret = `whsec_${keyBytes.toString("base64")}`;
  const id = "msg_1234567890";
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ object_kind: "merge_request" });

  const sig = createHmac("sha256", keyBytes).update(`${id}.${ts}.${raw}`).digest("base64");
  const swHeaders = {
    "webhook-signature": `v1,${sig}`,
    "webhook-id": id,
    "webhook-timestamp": ts,
  };
  assert.equal(
    verifyGitlabSignature(secret, raw, swHeaders),
    true,
    "a valid Standard-Webhooks signature verifies",
  );
  assert.equal(
    resolveSignature("gitlab", secret, raw, swHeaders),
    true,
    "resolveSignature dispatches gitlab to the Standard-Webhooks verifier",
  );

  // Legacy: X-Gitlab-Token plain header.
  assert.equal(verifyGitlabSignature(secret, raw, { "x-gitlab-token": secret }), true);

  // A bad signature fails; a stale timestamp fails.
  assert.equal(
    verifyGitlabSignature(secret, raw, { ...swHeaders, "webhook-signature": "v1,AAAAAAAAAAAAAAAA" }),
    false,
  );
  assert.equal(
    verifyGitlabSignature(secret, raw, { ...swHeaders, "webhook-timestamp": String(Number(ts) - 999999) }),
    false,
    "a stale replay must not verify",
  );
  assert.equal(verifyGitlabSignature(secret, raw, { "x-gitlab-token": "wrong" }), false);
});

// ---- Auth: atomic token rotation + glab config parsing ---------------------

test("rotateOauthPair persists the new pair BEFORE the caller uses it again", async () => {
  const order = [];
  let persisted = null;
  const next = await rotateOauthPair(
    async () => {
      order.push("refresh");
      return { access_token: "at2", refresh_token: "rt2" };
    },
    async (pair) => {
      order.push("persist");
      persisted = pair;
    },
  );
  assert.deepEqual(next, { access_token: "at2", refresh_token: "rt2" });
  assert.deepEqual(order, ["refresh", "persist"], "persist settles before any further use");
  assert.deepEqual(persisted, next);
});

test("parseGlabToken reads the token for a host from glab config text", () => {
  const cfg = [
    "git_protocol: https",
    "api_protocol: https",
    "check_update: false",
    "hosts:",
    "  gitlab.com:",
    "    user: octocat",
    "    token: glpat-abc123",
    "  other.example.com:",
    "    token: glpat-other",
  ].join("\n");
  assert.equal(parseGlabToken(cfg, "gitlab.com"), "glpat-abc123");
  assert.equal(parseGlabToken(cfg, "other.example.com"), "glpat-other");
  assert.equal(parseGlabToken(cfg, "missing.com"), null);
  assert.equal(parseGlabToken("", "gitlab.com"), null);
});

test("getDefaultBranch maps the project's default_branch", async () => {
  const url = "https://gitlab.com/api/v4/projects/acme%2Fwidget";
  const adapter = createGitlabAdapter(fakeRequest({ [url]: { default_branch: "develop" } }));
  assert.equal(await adapter.getDefaultBranch(REPO), "develop");
});

test("getDefaultBranch returns null when the field is absent", async () => {
  const url = "https://gitlab.com/api/v4/projects/acme%2Fwidget";
  const adapter = createGitlabAdapter(fakeRequest({ [url]: { path_with_namespace: "acme/widget" } }));
  assert.equal(await adapter.getDefaultBranch(REPO), null);
});

test("getDefaultBranch returns null when the request fails", async () => {
  const throwing = async () => {
    throw new Error("revoked token");
  };
  const adapter = createGitlabAdapter(throwing);
  assert.equal(await adapter.getDefaultBranch(REPO), null);
});
