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
  pullRequestForCwd,
  ForgeRateLimitedError,
} from "./index.mjs";

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
  assert.deepEqual(status, { connected: true, login: "octocat", kind: "github" });
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
