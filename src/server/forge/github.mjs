// github.mjs — the GitHub REST read-path adapter for the forge seam (BET-788).
//
// Plain `fetch` only. No Octokit, no HTTP dependency — the surface here is a
// handful of endpoints and a dependency is a supply-chain + bundle cost for
// it (issue §2, Do-NOT).
//
// The adapter is PURE normalisation + URL construction and holds NO cache,
// NO single-flight, NO rate-limit state. Serialisation all lives in index.mjs:
// this module's `request(url)` is injected there, and the request layer
// applies ETags, single-flight and the rate-limit cooling period. Every
// method returns NORMALISED shapes (from the shared forge vocabulary) wrapped
// as `{ data, stale }`, never a raw GitHub payload — a raw GitHub object
// escaping this module is a bug (it is exactly how the abstraction rots).
//
// Three traps this module owns at the adapter boundary (issue §2):
//   1. PRs are issues on GitHub. `GET /issues` returns pull requests too;
//      we filter them out by the presence of the `pull_request` key. (GitLab
//      is the inverse — issues and MRs are disjoint — which is why this must
//      live here and never leak upward.)
//   2. Checks and statuses are two DIFFERENT systems that both render as
//      "CI". A complete answer needs check-runs AND legacy commit statuses,
//      merged into one array before rollupChecks sees it.
//   3. `mergeable` can be null (GitHub is still computing it). We do not
//      coerce it to false — the shared type has three states for this reason.

import { normalizePrState, rollupChecks } from "../../shared/forge.mjs";

const API = "https://api.github.com";

// Error thrown when a request to the forge fails in a way that is not a
// rate-limit (a genuine network/HTTP failure the caller should surface, not
// swallow into a stale value). Carries the URL for diagnostics.
export class GithubRequestError extends Error {
  constructor(status, url) {
    super(`github request failed (${status}) for ${url}`);
    this.name = "GithubRequestError";
    this.status = status;
    this.url = url;
  }
}

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

function issuePath(repo) {
  return `/repos/${repo.owner}/${repo.repo}`;
}

// Normalise one raw GitHub PR (from `/pulls` list or `/pulls/{n}`) into the
// shared PullRequest shape, given the fetched reviews + inline comment
// threads (both optional — the list endpoint can't afford them).
function normalizePr(raw, { reviews = [], threads = [] } = {}) {
  const author = raw.user?.login ?? "";
  const reviewerLogins = Array.from(
    new Set(
      (Array.isArray(reviews) ? reviews : [])
        .map((r) => r?.user?.login)
        .filter((l) => typeof l === "string" && l && l !== author),
    ),
  );
  const threadCount = (Array.isArray(threads) ? threads : []).filter(
    (c) => c && !c.in_reply_to_id,
  ).length;

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    url: raw.html_url,
    state: normalizePrState(
      { state: raw.state, merged: raw.merged, draft: raw.draft },
      "github",
    ),
    draft: Boolean(raw.draft),
    headRef: raw.head?.ref ?? "",
    baseRef: raw.base?.ref ?? "",
    headSha: raw.head?.sha ?? "",
    author,
    reviewers: reviewerLogins,
    mergeable: raw.mergeable ?? null,
    mergeBlockedReason: deriveMergeBlockedReason(raw),
    unresolvedThreads: threadCount,
  };
}

// Derive a short human "why can't I merge". GitHub does not hand one to you;
// this comes from mergeable_state + the draft flag (issue §2). `mergeable`
// null (still computing) and `mergeable` true both → null; only a definite
// false produces a reason.
function deriveMergeBlockedReason(raw) {
  if (raw.draft) return "draft";
  if (raw.mergeable !== false) return null;
  switch (raw.mergeable_state) {
    case "dirty":
      return "conflicts";
    case "unstable":
      return "checks failing";
    case "blocked":
    case "review_requested":
      return "review required";
    default:
      return "checks failing";
  }
}

// Normalise one raw check-run (`.check_runs[]`) into the shared ForgeCheckRun.
function normalizeCheckRun(c) {
  return {
    name: c.name ?? c.check_name ?? "",
    status: c.status,
    conclusion: c.conclusion,
    url: c.html_url,
  };
}

// Normalise one raw legacy commit status (`.statuses[]`) into the shared
// ForgeCheckRun: its `state` maps onto the same status/conclusion vocabulary
// so rollupChecks sees a union array.
function normalizeLegacyStatus(s) {
  const conclusion = s.state === "success" ? "success" : s.state === "failure" || s.state === "error" ? "failure" : undefined;
  return {
    name: s.context ?? "",
    status: s.state === "pending" ? "pending" : "completed",
    conclusion,
    url: s.target_url,
  };
}

/**
 * Create a GitHub adapter bound to an injected `request(url)`.
 *
 * `request` is provided by the index.mjs request layer and returns
 * `{ data, stale }` — data is the raw parsed JSON body (or a cached value on
 * ETag 304 / rate-limit cooling), stale is true when the value came from
 * last-known state rather than a fresh response. This module only ever builds
 * URLs, calls `request`, and normalises `data`.
 *
 * The returned adapter implements the read-only forge interface written down
 * in the JSDoc typedef in index.mjs. Method PRESENCE is the capability model
 * — there is intentionally no separate capabilities registry to drift.
 *
 * @param {(url: string) => Promise<{ data: any, stale: boolean }>} request
 */
export function createGithubAdapter(request) {
  return {
    kind: "github",

    /**
     * GET /repos/{o}/{r}/pulls — the open PRs for a repo.
     * @param {{ owner: string, repo: string }} repo
     * @param {{ state?: string }} [filter]
     * @returns {Promise<{ data: import("./index.mjs").PullRequestLike[], stale: boolean }>}
     */
    async listPullRequests(repo, filter = {}) {
      const url = `${API}${issuePath(repo)}/pulls${qs({ state: filter.state ?? "open" })}`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      return { data: raw.map((p) => normalizePr(p)), stale };
    },

    /**
     * GET /repos/{o}/{r}/pulls/{n} + reviews + inline threads, normalised into
     * one PullRequest. `unresolvedThreads` is the count of top-level inline
     * review threads (comments not replying to another comment).
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @returns {Promise<{ data: import("./index.mjs").PullRequestLike, stale: boolean }>}
     */
    async getPullRequest(repo, number) {
      const base = `${API}${issuePath(repo)}/pulls/${number}`;
      const prRes = await request(base);
      const raw = prRes.data;
      let stale = prRes.stale;
      let reviews = [];
      let threads = [];
      try {
        const r = await request(`${base}/reviews`);
        reviews = Array.isArray(r.data) ? r.data : [];
        stale = stale || r.stale;
      } catch {
        // Reviews are best-effort for reviewers/unresolvedThreads; a failure
        // there must not blank the PR.
      }
      try {
        const t = await request(`${base}/comments`);
        threads = Array.isArray(t.data) ? t.data : [];
        stale = stale || t.stale;
      } catch {
        // Same — inline-thread count is display-only.
      }
      return { data: normalizePr(raw, { reviews: reviews ?? [], threads: threads ?? [] }), stale };
    },

    /**
     * GET /repos/{o}/{r}/issues — with the "PRs are issues" trap handled:
     * entries carrying a `pull_request` key are filtered out, so an issue list
     * never leaks a PR upward.
     * @param {{ owner: string, repo: string }} repo
     * @param {{ state?: string }} [filter]
     * @returns {Promise<{ data: Array<{ number: number, title: string, body: string, url: string, state: string, closed: boolean }>, stale: boolean }>}
     */
    async listIssues(repo, filter = {}) {
      const url = `${API}${issuePath(repo)}/issues${qs({ state: filter.state ?? "open" })}`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      const issues = raw
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body ?? "",
          url: i.html_url,
          state: i.state,
          closed: Boolean(i.closed_at),
        }));
      return { data: issues, stale };
    },

    /**
     * GET check-runs + GET legacy commit statuses for a sha, MERGED into one
     * normalised array — the two-systems trap (issue §2). rollupChecks in the
     * shared vocabulary gets the union.
     * @param {{ owner: string, repo: string }} repo
     * @param {string} sha
     * @returns {Promise<{ data: Array<{ name: string, status?: string, conclusion?: string, url?: string }>, stale: boolean }>}
     */
    async getChecks(repo, sha) {
      const base = `${API}${issuePath(repo)}/commits/${sha}`;
      let stale = false;
      let checks = [];
      try {
        const { data, stale: s } = await request(`${base}/check-runs`);
        checks = Array.isArray(data?.check_runs) ? data.check_runs.map(normalizeCheckRun) : [];
        stale = stale || s;
      } catch {
        // check-runs may 404 on a repo with no Checks API usage; statuses below
        // still cover it.
      }
      try {
        const { data, stale: s } = await request(`${base}/status`);
        const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
        checks = checks.concat(statuses.map(normalizeLegacyStatus));
        stale = stale || s;
      } catch {
        // statuses 404 on a repo with no legacy statuses; check-runs above may
        // still cover it.
      }
      return { data: checks, stale };
    },
  };
}
