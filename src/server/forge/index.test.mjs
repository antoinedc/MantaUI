// index.test.mjs — the forge registry + serialisation layer (BET-788). No live
// network: fetch is injected and counted. Pins ETag/304, the freshness window
// (zero network), single-flight, rate-limit cooling, the forge:status
// token-invariance, and the cwd → origin → repo pull-request resolution.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRequestLayer,
  createForgeRuntime,
  forgeStatus,
  forgeDeviceStart,
  pullRequestForCwd,
  forgeDiffForCwd,
  shipPullRequest,
  shipPreview,
  humanizeBranch,
  mergePullRequest,
  draftGetForCwd,
  draftCommentForCwd,
  draftSubmitForCwd,
  forgeInbox,
  seedPromptFor,
  INBOX_SEED_PROMPT,
  ForgeRateLimitedError,
} from "./index.mjs";
import { getDraft, putComment } from "./draft.mjs";

const URL = "https://api.github.com/repos/acme/widget/pulls?state=open";

function clock(seed = 0) {
  let t = seed;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

let id = 0;
function freshBody() {
  return { marker: `body-${id++}`, n: 1 };
}

test("ETag: a 304 returns the cached value, does not overwrite it, and sends If-None-Match", async () => {
  const c = clock(0);
  const calls = [];
  const body = freshBody();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return json(body, 200, { etag: "w/\"v1\"", "x-ratelimit-remaining": "5000" });
    }
    return new Response(null, { status: 304 });
  };
  const layer = createRequestLayer({ fetch, now: c.now });

  const first = await layer.getJson(URL, { token: "t" });
  assert.deepEqual(first, { data: body, stale: false });

  c.advance(40_000); // past the freshness window → forces a conditional GET
  const second = await layer.getJson(URL, { token: "t" });

  assert.deepEqual(second.data, body, "304 serves the cached value");
  assert.equal(second.stale, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers["if-none-match"], 'w/"v1"', "conditional request carries the held ETag");
});

test("freshness window: repeated calls within it issue zero network requests", async () => {
  const c = clock(0);
  let calls = 0;
  const body = freshBody();
  const fetch = async () => (calls++, json(body, 200, { etag: '"e1"', "x-ratelimit-remaining": "5000" }));
  const layer = createRequestLayer({ fetch, now: c.now });

  await layer.getJson(URL, { token: "t" });
  const again = await layer.getJson(URL, { token: "t" });
  const thrice = await layer.getJson(URL, { token: "t" });

  assert.equal(calls, 1, "only the first call touched the network");
  assert.deepEqual(again, { data: body, stale: false });
  assert.deepEqual(thrice.data, body);
});

test("single-flight: two concurrent identical calls issue one fetch", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const fetch = async (url, init) => {
    calls.push(init);
    await gate;
    return json({ ok: true }, 200, { etag: '"e"', "x-ratelimit-remaining": "5000" });
  };
  const layer = createRequestLayer({ fetch });

  const p1 = layer.getJson(URL, { token: "t" });
  const p2 = layer.getJson(URL, { token: "t" });
  await Promise.resolve(); // let both schedule against the single-flight map
  assert.equal(calls.length, 1, "concurrent callers coalesce onto one request");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.data.ok, true);
  assert.equal(r2.data.ok, true);
});

test("rate-limit 403: serves last-known stale and cools the bucket (no further requests)", async () => {
  const c = clock(0);
  const calls = [];
  const body = freshBody();
  const fetch = async (url, init) => {
    calls.push(init);
    if (calls.length === 1) return json(body, 200, { etag: '"e1"', "x-ratelimit-remaining": "5000" });
    return json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0" });
  };
  const layer = createRequestLayer({ fetch, now: c.now });

  await layer.getJson(URL, { token: "t" }); // seed the cache
  c.advance(40_000); // exit freshness so the next call is a real request

  const limited = await layer.getJson(URL, { token: "t" });
  assert.equal(limited.stale, true, "403 during a rate-limit serves last-known, stale");
  assert.deepEqual(limited.data, body);
  assert.equal(calls.length, 2);

  // Within the cooling period the request layer does not even issue a fetch.
  const cooled = await layer.getJson(URL, { token: "t" });
  assert.equal(cooled.stale, true);
  assert.equal(calls.length, 2, "cooling period suppresses further network requests");
});

test("rate-limit 403 with no last-known value throws ForgeRateLimitedError", async () => {
  const fetch = async () => json({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0" });
  const layer = createRequestLayer({ fetch });
  await assert.rejects(() => layer.getJson(URL, { token: "t" }), ForgeRateLimitedError);
});

test("forgeStatus: reports connected/login and NEVER leaks the token", async () => {
  const TOKEN = "ghp_SUPER_SECRET_VALUE";
  const status = await forgeStatus({
    resolveToken: async () => ({ token: TOKEN, source: "cli" }),
    detectCli: async () => ({ installed: true, authenticated: true, login: "octocat" }),
  });
  assert.deepEqual(status, { connected: true, login: "octocat", kind: "github", source: "cli" });
  const serialised = JSON.stringify(status);
  assert.ok(!serialised.includes(TOKEN), "the resolved token must never cross forge:status output");
});

test("forgeStatus: disconnected when no token resolves", async () => {
  const status = await forgeStatus({
    resolveToken: async () => null,
    detectCli: async () => ({ installed: true, authenticated: false, login: null }),
  });
  assert.deepEqual(status, { connected: false });
});

// ---- pullRequestForCwd -----------------------------------------------------

function fakeAdapter({ prs = [], checks = [] } = {}) {
  return {
    kind: "github",
    listPullRequests: async () => ({ data: prs, stale: false }),
    getPullRequest: async (_repo, number) => {
      const pr = prs.find((p) => p.number === number) ?? prs[0];
      return { data: pr, stale: false };
    },
    getChecks: async () => ({ data: checks, stale: false }),
  };
}

const OPEN_PR = {
  number: 42,
  title: "t",
  body: "",
  url: "u",
  state: "open",
  draft: false,
  headRef: "feature/x",
  baseRef: "main",
  headSha: "abc",
  author: "octocat",
  reviewers: [],
  mergeable: true,
  mergeBlockedReason: null,
  unresolvedThreads: 0,
};

test("pullRequestForCwd: repo with no known forge → no_forge (not an error)", async () => {
  const r = await pullRequestForCwd("/repo", {
    gitRemoteOrigin: async () => null, // not a git repo
    resolveToken: async () => null,
    getAdapter: () => fakeAdapter(),
  });
  assert.deepEqual(r.error, "no_forge");
  assert.equal(r.pr, null);
  assert.equal(r.rollup, "none");
});

test("pullRequestForCwd: forge known but no token → not_connected", async () => {
  const r = await pullRequestForCwd("/repo", {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    resolveToken: async () => null,
    getAdapter: () => fakeAdapter(),
  });
  assert.deepEqual(r.error, "not_connected");
  assert.equal(r.pr, null);
});

test("pullRequestForCwd: open PR on the current branch → normalized PR + checks + rollup", async () => {
  const r = await pullRequestForCwd("/repo", {
    gitRemoteOrigin: async () => "git@github.com:acme/widget.git",
    currentBranch: async () => "feature/x",
    resolveToken: async () => ({ token: "ghp_t", source: "cli" }),
    getAdapter: () =>
      fakeAdapter({
        prs: [OPEN_PR, { ...OPEN_PR, number: 43, headRef: "other" }],
        checks: [{ name: "ci", status: "completed", conclusion: "success" }],
      }),
  });
  assert.equal(r.error, null);
  assert.equal(r.pr.number, 42, "picks the PR whose headRef matches the current branch");
  assert.equal(r.pr.headRef, "feature/x");
  assert.equal(r.checks.length, 1);
  assert.equal(r.rollup, "green");
  assert.equal(r.stale, false);
});

test("pullRequestForCwd: no open PR → well-formed empty result, not an error", async () => {
  const r = await pullRequestForCwd("/repo", {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    resolveToken: async () => ({ token: "ghp_t", source: "cli" }),
    getAdapter: () => fakeAdapter({ prs: [] }),
  });
  assert.equal(r.pr, null);
  assert.equal(r.error, null);
  assert.equal(r.rollup, "none");
  assert.deepEqual(r.checks, []);
});

test("getAdapter throws UnsupportedByForgeError for an unknown kind", async () => {
  const runtime = createForgeRuntime({ fetch: async () => json({}, 200, {}) });
  assert.throws(() => runtime.getAdapter("gitea", "t"), (e) => e.name === "UnsupportedByForgeError");
});

// ---- Box-facing writes: shipPullRequest + mergePullRequest (BET-794) -------

function writeAdapter({ created = { ...OPEN_PR, number: 77 }, merge = { merged: true } } = {}) {
  return {
    kind: "github",
    createPullRequest: async () => ({ data: created, stale: false }),
    merge: async (_repo, _n, input) => ({ data: merge, input, stale: false }),
  };
}

const SHIP_DEPS = {
  gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
  currentBranch: async () => "feature/forge",
  resolveToken: async () => ({ token: "ghp_t", source: "cli" }),
  getAdapter: () => writeAdapter(),
  gitPush: async (input) => ({ input }),
};

test("shipPullRequest: no forge → no_forge, never pushes", async () => {
  const pushed = [];
  const r = await shipPullRequest("/repo", { title: "t" }, {
    ...SHIP_DEPS,
    gitRemoteOrigin: async () => null,
    gitPush: async (i) => { pushed.push(i); },
  });
  assert.deepEqual(r, { ok: false, error: "no_forge" });
  assert.equal(pushed.length, 0);
});

test("shipPullRequest: push (setUpstream) then createPullRequest with draft", async () => {
  const pushed = [];
  const created = { ...OPEN_PR, number: 88, draft: true };
  const adapter = writeAdapter({ created });
  const r = await shipPullRequest("/repo", { title: "Forge seam", body: "B", base: "main", draft: true }, {
    ...SHIP_DEPS,
    getAdapter: () => adapter,
    gitPush: async (i) => { pushed.push(i); return { stdout: "", stderr: "" }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, created.url);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0], { cwd: "/repo", branch: "feature/forge", setUpstream: true });
});

test("shipPullRequest: push failure surfaces a push-failed error, never creates", async () => {
  const r = await shipPullRequest("/repo", { title: "t" }, {
    ...SHIP_DEPS,
    gitPush: async () => { throw new Error("network down"); },
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith("push failed"));
});

test("shipPullRequest: onPrOpened is called with repoKey + number on a successful create", async () => {
  let opened = null;
  const created = { ...OPEN_PR, number: 91 };
  const adapter = writeAdapter({ created });
  const r = await shipPullRequest("/repo", { title: "t" }, {
    ...SHIP_DEPS,
    getAdapter: () => adapter,
    gitPush: async () => ({ stdout: "", stderr: "" }),
    onPrOpened: async (arg) => { opened = arg; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(opened, { cwd: "/repo", repoKey: "github.com/acme/widget", number: 91 });
});

test("shipPullRequest: a throwing onPrOpened never fails the ship", async () => {
  const r = await shipPullRequest("/repo", { title: "t" }, {
    ...SHIP_DEPS,
    gitPush: async () => ({ stdout: "", stderr: "" }),
    onPrOpened: async () => { throw new Error("link-store down"); },
  });
  assert.equal(r.ok, true);
});

test("mergePullRequest passes the head SHA and surfaces a sha_mismatch failure", async () => {
  let mergeInput = null;
  const adapter = {
    kind: "github",
    merge: async (_repo, _n, input) => { mergeInput = input; return { data: { merged: true }, stale: false }; },
  };
  const ok = await mergePullRequest("/repo", { number: 42, method: "merge", sha: "abc123" }, {
    ...SHIP_DEPS,
    getAdapter: () => adapter,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(mergeInput, { method: "merge", sha: "abc123" });

  const failing = {
    kind: "github",
    merge: async () => { const e = new Error("head sha no longer matches"); e.kind = "sha_mismatch"; throw e; },
  };
  const r = await mergePullRequest("/repo", { number: 42, method: "merge", sha: "abc999" }, {
    ...SHIP_DEPS,
    getAdapter: () => failing,
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "sha_mismatch");
});

test("shipPreview returns head, base and a best-effort file count", async () => {
  const r = await shipPreview("/repo", {
    ...SHIP_DEPS,
    currentBranch: async () => "feat/forge-seam",
  });
  assert.equal(r.ok, true);
  assert.equal(r.head, "feat/forge-seam");
  assert.equal(r.base, "main");
  assert.equal(typeof r.fileCount, "number");
});

test("shipPreview drafts a title from the tip commit (design step 1)", async () => {
  const r = await shipPreview("/repo", {
    ...SHIP_DEPS,
    currentBranch: async () => "feat/forge-seam",
    gitLog: async () => "Add forge seam + github adapter",
  });
  assert.equal(r.ok, true);
  assert.equal(r.title, "Add forge seam + github adapter");
});

test("shipPreview seeds the body from the repo's PR template", async () => {
  const r = await shipPreview("/repo", {
    ...SHIP_DEPS,
    currentBranch: async () => "feat/forge-seam",
    readPrTemplate: async () => "## Summary\n\n${head} → ${base}\n\n## Checklist\n- [x] tests",
  });
  assert.equal(r.ok, true);
  assert.match(r.body, /tests/);
  assert.ok(r.body.includes("feat/forge-seam"), "template ${head} placeholder is filled");
  assert.ok(r.body.includes("main"), "template ${base} placeholder is filled");
});

test("shipPreview falls back to a changed-files body when there is no template", async () => {
  const r = await shipPreview("/repo", {
    ...SHIP_DEPS,
    currentBranch: async () => "feat/forge-seam",
    readPrTemplate: async () => null,
  });
  // No template + git diff unavailable in the sandbox → empty body, not a throw.
  assert.equal(r.ok, true);
  assert.equal(typeof r.body, "string");
});

test("humanizeBranch drops the scope prefix and title-cases the slug", () => {
  assert.equal(humanizeBranch("feat/forge-seam"), "Forge seam");
  assert.equal(humanizeBranch("fix/bug-12"), "Bug 12");
  assert.equal(humanizeBranch("main"), "Main");
  assert.equal(humanizeBranch(""), "");
  assert.equal(humanizeBranch("  "), "");
});

test("shipPreview: repo with no forge → no_forge", async () => {
  const r = await shipPreview("/repo", {
    ...SHIP_DEPS,
    gitRemoteOrigin: async () => null,
  });
  assert.deepEqual(r, { ok: false, error: "no_forge" });
});


// ---- forgeDiffForCwd (BET-792) ---------------------------------------------

function diffAdapter({ prs = [], diff = "", threads = [], headSha = "" } = {}) {
  return {
    kind: "github",
    listPullRequests: async () => ({ data: prs, stale: false }),
    getDiff: async () => ({ data: { diff, threads, headSha }, stale: false }),
  };
}

test("forgeDiffForCwd: no known forge → no_forge", async () => {
  const r = await forgeDiffForCwd("/repo", {
    gitRemoteOrigin: async () => null,
    resolveToken: async () => ({ token: "t", source: "cli" }),
    getAdapter: () => diffAdapter(),
  });
  assert.deepEqual(r.error, "no_forge");
  assert.equal(r.diff, "");
});

test("forgeDiffForCwd: forge known but no token → not_connected", async () => {
  const r = await forgeDiffForCwd("/repo", {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    resolveToken: async () => null,
    getAdapter: () => diffAdapter(),
  });
  assert.deepEqual(r.error, "not_connected");
});

test("forgeDiffForCwd: open PR on current branch → raw diff + threads + headSha", async () => {
  const r = await forgeDiffForCwd("/repo", {
    gitRemoteOrigin: async () => "git@github.com:acme/widget.git",
    currentBranch: async () => "feature/x",
    resolveToken: async () => ({ token: "t", source: "cli" }),
    getAdapter: () =>
      diffAdapter({
        prs: [OPEN_PR, { ...OPEN_PR, number: 43, headRef: "other" }],
        diff: "@@ -1 +1 @@\n+a\n",
        threads: [{ id: "1", path: "a", line: 1, side: "RIGHT", resolved: false, comments: [] }],
        headSha: "abc",
      }),
  });
  assert.equal(r.error, null);
  assert.equal(r.diff, "@@ -1 +1 @@\n+a\n");
  assert.equal(r.threads.length, 1);
  assert.equal(r.headSha, "abc");
});

test("forgeDiffForCwd: no open PR → no_pr (not an error)", async () => {
  const r = await forgeDiffForCwd("/repo", {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    resolveToken: async () => ({ token: "t", source: "cli" }),
    getAdapter: () => diffAdapter({ prs: [] }),
  });
  assert.deepEqual(r.error, "no_pr");
  assert.deepEqual(r.threads, []);
});

// ---- Box-buffered draft review (BET-793) ------------------------------------

// A draft-op test kit: injectable git/forge deps plus an in-memory stand-in
// for the durable draft store (deep-copy load/save). `headSha` is what the
// adapter's getPullRequest reports as the PR's CURRENT head.
function draftKit({ prs = [OPEN_PR], headSha = "abc", adapter } = {}) {
  let store = [];
  const events = [];
  const deps = {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    currentBranch: async () => "feature/x",
    resolveToken: async () => ({ token: "ghp_t", source: "cli" }),
    getAdapter: () =>
      adapter ?? {
        kind: "github",
        listPullRequests: async () => ({ data: prs, stale: false }),
        getPullRequest: async () => ({ data: { ...OPEN_PR, headSha }, stale: false }),
        submitReview: async () => ({ data: {}, stale: false }),
      },
    async load() {
      return JSON.parse(JSON.stringify(store));
    },
    async save(d) {
      store = JSON.parse(JSON.stringify(d));
    },
    publish() {
      events.push(1);
    },
    snapshot: () => JSON.parse(JSON.stringify(store)),
    events,
  };
  return deps;
}

// Shared draft-submit test adapter: the forge-read half (list/get the PR) is
// identical for every submit test; only submitReview differs, so it is the one
// injected argument.
function submitAdapter(submitReview) {
  return {
    kind: "github",
    listPullRequests: async () => ({ data: [OPEN_PR], stale: false }),
    getPullRequest: async () => ({ data: { ...OPEN_PR, headSha: "abc" }, stale: false }),
    submitReview,
  };
}

// Seed a draft with comments through the real draftCommentForCwd path, so the
// multi-add setup never has to be written out per test.
async function addComments(k, comments) {
  for (const comment of comments) {
    await draftCommentForCwd("/repo", { op: "add", comment }, k);
  }
}

const DRAFT_REPO_KEY = "github.com/acme/widget";

test("draftGetForCwd: head SHA moved → draft marked stale, comments kept", async () => {
  const k = draftKit({ headSha: "newhead" });
  await putComment(DRAFT_REPO_KEY, 42, "oldhead", { path: "a.ts", line: 1, side: "new", body: "precious" }, k);
  const r = await draftGetForCwd("/repo", k);
  assert.equal(r.error, null);
  assert.equal(r.draft.stale, true, "head moved → stale flag set");
  assert.equal(r.draft.comments.length, 1, "content is never discarded");
  assert.equal(r.draft.comments[0].body, "precious");
  assert.ok(k.events.length >= 1, "the staleness write publishes");
});

test("draftGetForCwd: head unchanged → draft returned fresh (not stale)", async () => {
  const k = draftKit({ headSha: "abc" });
  await putComment(DRAFT_REPO_KEY, 42, "abc", { path: "a.ts", line: 1, side: "new", body: "fresh" }, k);
  const r = await draftGetForCwd("/repo", k);
  assert.equal(r.draft.stale, false);
  assert.equal(r.draft.comments[0].body, "fresh");
});

test("draftCommentForCwd: add + set-verdict persist box-side", async () => {
  const k = draftKit();
  const add = await draftCommentForCwd("/repo", { op: "add", comment: { path: "a.ts", line: 1, side: "new", body: "note" } }, k);
  assert.equal(add.ok, true);
  assert.equal(add.draft.comments.length, 1);

  const v = await draftCommentForCwd("/repo", { op: "set-verdict", verdict: "approved" }, k);
  assert.equal(v.ok, true);
  assert.equal(v.draft.verdict, "approved");
  assert.equal(v.draft.comments.length, 1, "set-verdict does not touch comments");

  const bad = await draftCommentForCwd("/repo", { op: "frobnicate" }, k);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes("unknown op"), true);
});

test("draftSubmitForCwd: flushes EVERY buffered comment as ONE review with correct anchors, then clears", async () => {
  let submitted = null;
  const k = draftKit({
    adapter: submitAdapter(async (repo, n, input) => {
      submitted = { repo, n, input };
      return { data: {}, stale: false };
    }),
  });
  await addComments(k, [
    { path: "a.ts", line: 1, side: "new", body: "c1" },
    { path: "a.ts", line: 2, side: "old", body: "c2" },
    { path: "b.ts", line: 5, side: "new", startLine: 3, body: "c3" },
  ]);

  const r = await draftSubmitForCwd("/repo", { verdict: "approved" }, k);
  assert.equal(r.ok, true);
  assert.equal(submitted.repo.owner, "acme");
  assert.equal(submitted.n, 42);
  assert.equal(submitted.input.verdict, "approved");
  assert.equal(submitted.input.comments.length, 3, "all three comments in one review");
  assert.equal(submitted.input.headSha, "abc");
  // The demo adapter receives the forge-NEUTRAL anchors (path/line/side/startLine);
  // the adapter maps new/old → RIGHT/LEFT via toGithubAnchor (covered in github.test.mjs).
  const multi = submitted.input.comments.find((c) => c.path === "b.ts");
  assert.equal(multi.line, 5);
  assert.equal(multi.side, "new");
  assert.equal(multi.startLine, 3);
  assert.equal(submitted.input.comments.find((c) => c.path === "a.ts" && c.line === 2).side, "old");

  assert.equal(await getDraft(DRAFT_REPO_KEY, 42, k), null, "draft cleared on SUCCESS");
});

test("draftSubmitForCwd: a failed submit returns a typed error and leaves the draft intact", async () => {
  const k = draftKit({
    adapter: submitAdapter(async () => {
      const e = new Error("review failed");
      e.kind = "http_422";
      throw e;
    }),
  });
  await addComments(k, [
    { path: "a.ts", line: 1, side: "new", body: "c1" },
    { path: "a.ts", line: 2, side: "new", body: "c2" },
  ]);

  const r = await draftSubmitForCwd("/repo", {}, k);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "http_422");
  const after = await getDraft(DRAFT_REPO_KEY, 42, k);
  assert.equal(after.comments.length, 2, "nothing is lost on a failed submit");
  assert.equal(after.comments[0].body, "c1");
  assert.equal(after.comments[1].body, "c2");
});

test("draftSubmitForCwd: no buffered comments → nothing to submit", async () => {
  const k = draftKit();
  const r = await draftSubmitForCwd("/repo", {}, k);
  assert.equal(r.ok, false);
  assert.equal(r.error, "nothing to submit");
});

test("draft ops resolve no_forge / not_connected like the other write ops", async () => {
  const rNo = await draftGetForCwd("/repo", {
    gitRemoteOrigin: async () => null,
    resolveToken: async () => ({ token: "t", source: "cli" }),
    getAdapter: () => ({}),
  });
  assert.equal(rNo.error, "no_forge");

  const rTok = await draftSubmitForCwd("/repo", {}, {
    gitRemoteOrigin: async () => "https://github.com/acme/widget.git",
    resolveToken: async () => null,
    getAdapter: () => ({}),
  });
  assert.equal(rTok.error, "not_connected");
});

test("forgeDeviceStart: an existing credential skips straight to the picker", async () => {
  const r = await forgeDeviceStart({
    resolveToken: async () => ({ token: "t", source: "cli" }),
    start: async () => {
      throw new Error("start must not run");
    },
  });
  assert.equal(r.connected, true);
  assert.equal(r.grant, null);
});

test("forgeDeviceStart: placeholder client_id surfaces a notConfigured state (guard)", async () => {
  const r = await forgeDeviceStart({
    resolveToken: async () => null,
    start: async () => {
      const { DeviceFlowNotConfiguredError } = await import("./auth.mjs");
      throw new DeviceFlowNotConfiguredError();
    },
  });
  assert.equal(r.connected, false);
  assert.equal(r.notConfigured, true);
  assert.equal(r.grant, null);
});

// ---- forge:inbox (BET-795) -------------------------------------------------

test("forgeInbox: not_connected → empty items, no adapter call", async () => {
  let called = false;
  const r = await forgeInbox({
    resolveToken: async () => null,
    getAdapter: () => {
      called = true;
      return {};
    },
  });
  assert.equal(r.error, "not_connected");
  assert.deepEqual(r.items, []);
  assert.equal(called, false);
});

test("forgeInbox: three search queries (60s ttl), keeps only red PRs, dedupes + sorts by updatedAt desc", async () => {
  const searched = [];
  const checksBySha = { red1: ["bad"], green1: ["good"] };
  const adapter = {
    searchIssues: async (query, opts) => {
      searched.push({ query, ttl: opts?.ttl });
      const hit = (num, title, kind, sha, updatedAt) => ({
        kind, owner: "acme", repo: "widget", repoKey: "github.com/acme/widget",
        number: num, title, url: `https://github.com/acme/widget/pull/${num}`,
        state: "open", updatedAt, headSha: sha, reason: "assigned",
      });
      if (query === "assignee:@me") {
        return { data: [hit(1, "issue a", "issue", "", 100)], stale: false };
      }
      if (query === "review-requested:@me") {
        // Only PR 9 is awaiting my review.
        return { data: [hit(9, "pr awaiting", "pr", "red1", 500)], stale: false };
      }
      // author:@me is:open — my open PRs; the inbox keeps only the red ones
      // (green PR 3 must be excluded).
      return { data: [hit(9, "pr awaiting", "pr", "red1", 500), hit(3, "green pr", "pr", "green1", 300)], stale: false };
    },
    getChecks: async (repo, sha) => {
      const list = checksBySha[sha] ?? [];
      return { data: list.map((c) => ({ name: c, status: "completed", conclusion: c === "bad" ? "failure" : "success" })), stale: false };
    },
  };
  const r = await forgeInbox({
    resolveToken: async () => ({ token: "t", source: "cli" }),
    getAdapter: () => adapter,
  });
  // Every query carries the 60s freshness override (the search bucket's own
  // lower rate limit) — the acceptance criterion's "no second round inside 60s".
  assert.equal(searched.length, 3);
  for (const s of searched) assert.equal(s.ttl, 60000);
  assert.deepEqual(searched.map((s) => s.query), ["assignee:@me", "review-requested:@me", "author:@me is:open"]);

  // PR 9 matches two queries (review-requested AND author is:open with red
  // checks) but must appear once, with the more urgent reason winning. The
  // green PR 3 (from the author query) is excluded — its checks aren't red.
  assert.equal(r.error, null);
  const nums = r.items.map((i) => i.number);
  assert.deepEqual(nums, [9, 1], "9 (500) sorts before 1 (100); green PR 3 is excluded");

  const pr9 = r.items.find((i) => i.number === 9);
  assert.equal(pr9.reason, "checks failing", "red-checks beats review-requested, and it appears exactly once");
  assert.equal(pr9.kind, "pr");
  const issue1 = r.items.find((i) => i.number === 1);
  assert.equal(issue1.reason, "assigned");
});

test("request layer: a resource fetched with a 60s ttl issues no second request inside 60s", async () => {
  const c = clock();
  let fetches = 0;
  const fetch = async () => {
    fetches++;
    return json({ items: [{ id: 1 }] }, 200, { etag: "\"e1\"" });
  };
  const layer = createRequestLayer({ fetch, now: c.now });
  await layer.getJson("https://api.github.com/search/issues?q=x", { token: "t", ttl: 60000 });
  // 30s later — inside the inbox's 60s shelf life — a second call serves from
  // memory with ZERO network requests.
  c.advance(30_000);
  await layer.getJson("https://api.github.com/search/issues?q=x", { token: "t", ttl: 60000 });
  assert.equal(fetches, 1, "opening the inbox twice inside 60s issues no second round of requests");
});

test("seedPromptFor fills the {{url}} placeholder from the shared template", () => {
  assert.equal(INBOX_SEED_PROMPT, "Complete {{url}}");
  assert.equal(seedPromptFor({ url: "https://github.com/acme/widget/issues/5" }), "Complete https://github.com/acme/widget/issues/5");
  assert.equal(seedPromptFor({ url: "u" }, "Fix {{url}}"), "Fix u");
});
