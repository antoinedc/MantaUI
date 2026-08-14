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

import { normalizePrState, repoKey, rollupChecks } from "../../shared/forge.mjs";

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

// Typed merge failures (issue §4). The UI cannot act on a generic "merge
// failed" — each status has a different next action, so each is its own class:
//   405 → cannot merge (branch protection / draft / conflict)
//   409 → the head SHA no longer matches what the user reviewed
//   403 → no permission to merge
// Anything else falls through to the generic GithubRequestError. The base
// error class carries `.status` so callers can still switch on the raw code.
export class MergeNotAllowedError extends Error {
  constructor(url) {
    super(`cannot merge ${url}`);
    this.name = "MergeNotAllowedError";
    this.status = 405;
    this.kind = "cannot_merge";
    this.url = url;
  }
}
export class MergeShaMismatchError extends Error {
  constructor(url) {
    super(`head sha no longer matches for ${url}`);
    this.name = "MergeShaMismatchError";
    this.status = 409;
    this.kind = "sha_mismatch";
    this.url = url;
  }
}
export class MergePermissionError extends Error {
  constructor(url) {
    super(`no permission to merge ${url}`);
    this.name = "MergePermissionError";
    this.status = 403;
    this.kind = "permission";
    this.url = url;
  }
}

// Map a merge PUT's failure status to its distinguished error kind. Anything
// not in the three known statuses stays an ordinary GithubRequestError (the
// caller can still read `.status`). 404 is not a merge state — a vanished PR
// is surfaced generically rather than as one of the three actionable kinds.
function mergeFailure(status, url) {
  if (status === 405) return new MergeNotAllowedError(url);
  if (status === 409) return new MergeShaMismatchError(url);
  if (status === 403) return new MergePermissionError(url);
  return new GithubRequestError(status, url);
}

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

function issuePath(repo) {
  return `/repos/${repo.owner}/${repo.repo}`;
}

// ---------------------------------------------------------------------------
// Work-inbox helpers (BET-795)
// ---------------------------------------------------------------------------
//
// The inbox is the ONE cross-repo read in the project. Per-repo iteration is
// O(N repos) and would exhaust the search rate limit on anyone with more than
// a handful of repos, so the three populations come from three SEARCH queries
// against GET /search/issues: `assignee:@me` (my issues), `review-requested:@me`
// (PRs awaiting my review), `author:@me is:open` (my open PRs — kept only when
// their checks are red). This module owns query construction + result
// normalisation + the dedupe-with-precedence merge; index.mjs owns the network
// and the per-PR checks fetch for the checks-failing population.
//
// Inbox reason precedence — which population's claim "wins" when the same PR
// matches two queries (a PR on a branch I authored can also be awaiting my
// review). A checks-failing PR is the most urgent (bad dot), a requested review
// next (warn dot), a plain assignment least (mute dot) — the dot-tone order in
// the mockup. The `reason` values are the shared InboxReason vocabulary.
const INBOX_REASON_PRIORITY = Object.freeze({
  "checks failing": 3,
  "review requested": 2,
  assigned: 1,
});

/**
 * The three search queries that answer the whole inbox in three requests,
 * regardless of how many repos the user has. Each carries the `reason` its
 * results are claimed with — the caller iterates EXACTLY this set, so the
 * queries the tests pin are the queries production runs.
 *
 * @returns {Array<{ query: string, reason: "assigned"|"review requested"|"checks failing" }>}
 */
export function buildInboxQueries() {
  return [
    { query: "assignee:@me", reason: "assigned" },
    { query: "review-requested:@me", reason: "review requested" },
    { query: "author:@me is:open", reason: "checks failing" },
  ];
}

// Normalise one raw GET /search/issues item into the cross-repo InboxItem
// skeleton. Kind flips on GitHub's PR marker (PRs are issues — the same trap
// the issue list handles). Repo identity comes from `repository_url`
// (GitHub's canonical per-item source) via repoKey; `updatedAt` is the search
// item's updated_at in ms. `headSha` is read defensively — a PR whose search
// item omits `head` just carries an empty SHA (checks can't be fetched).
export function normalizeSearchHit(raw) {
  const m = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(raw?.repository_url ?? "");
  const owner = m ? m[1] : "";
  const repo = m ? m[2] : "";
  const updatedAt = raw?.updated_at ? Date.parse(raw.updated_at) : 0;
  return {
    kind: raw?.pull_request ? "pr" : "issue",
    owner,
    repo,
    repoKey: owner && repo ? repoKey({ host: "github.com", owner, repo }) : "",
    number: raw?.number ?? 0,
    title: raw?.title ?? "",
    url: raw?.html_url ?? "",
    state: raw?.state ?? "open",
    updatedAt,
    headSha: raw?.head?.sha ?? "",
    headRef: raw?.head?.ref ?? "",
    // Stamped by the caller from the query — see buildInboxQueries.
    reason: "assigned",
  };
}

/**
 * Merge the per-query inbox populations into ONE deduplicated list. A single
 * PR can match two queries (e.g. `author:@me` AND `review-requested:@me`) and
 * must appear exactly once — the more urgent `reason` wins (checks failing >
 * review requested > assigned). Items are keyed by `repoKey#number`.
 *
 * @param {Array<Array<object>>} sources the per-query normalised arrays
 * @returns {Array<object>}
 */
export function mergeInboxSources(sources) {
  const byKey = new Map();
  for (const source of sources ?? []) {
    for (const it of Array.isArray(source) ? source : []) {
      const key = `${it.repoKey}#${it.number}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...it });
        continue;
      }
      // Tie (same PR, same reason) keeps the first claim — order is stable.
      if (INBOX_REASON_PRIORITY[it.reason] > INBOX_REASON_PRIORITY[existing.reason]) {
        byKey.set(key, { ...existing, ...it });
      }
    }
  }
  return [...byKey.values()];
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

// Group raw GitHub review comments (GET /pulls/{n}/comments) into forge-neutral
// Threads. A thread is a top-level comment (no `in_reply_to_id`) plus its
// replies, in posting order. The thread's position anchor — path/line/side plus
// startLine for a multi-line comment — comes from the top-level comment, since
// replies inherit it. `resolved` is read off the top comment (GitHub's REST
// carries it; resolving a thread is a GraphQL-only write we do not model here).
//
//   Thread = { id, path, line, side, startLine, resolved, comments }
//
// `path`/`line`/`side`/`startLine` are null (never dropped) when absent, so a
// file-level comment (no line) normalises to a well-formed thread the renderer
// can place at the file's top rather than mangling the key.
function normalizeReviewThreads(raw) {
  const byTop = new Map(); // top comment id -> comments of that thread, top first
  for (const c of Array.isArray(raw) ? raw : []) {
    if (c?.in_reply_to_id == null) {
      byTop.set(c.id, [c]);
    } else {
      const arr = byTop.get(c.in_reply_to_id);
      if (arr) arr.push(c);
    }
  }
  const threads = [];
  for (const comments of byTop.values()) {
    const top = comments[0] ?? {};
    threads.push({
      id: String(top.id),
      path: top.path ?? null,
      line: top.line ?? null,
      side: top.side ?? null,
      startLine: top.start_line ?? null,
      resolved: Boolean(top.resolved),
      comments: comments.map((c) => ({
        author: c?.user?.login ?? "",
        body: c?.body ?? "",
        createdAt: c?.created_at ?? null,
      })),
    });
  }
  return threads;
}

// Map the shared ReviewVerdict draft-action to GitHub's `event`. null (a plain
// "post the comments, no verdict") → COMMENT, the neutral publish event.
function verdictToEvent(verdict) {
  if (verdict === "approved") return "APPROVE";
  if (verdict === "changes_requested") return "REQUEST_CHANGES";
  return "COMMENT";
}

// Map a forge-neutral DraftComment onto a GitHub review-comment payload.
// Anchoring uses `path` + `line` + `side` (LEFT/RIGHT) plus `start_line` +
// `start_side` for the multi-line highlight, plus `commit_id` (the reviewed
// head SHA). The old `position` field (offset from the hunk header) is being
// retired and is deliberately never emitted.
function toGithubAnchor(c, headSha) {
  const a = {
    path: c.path,
    line: c.line,
    side: c.side === "old" ? "LEFT" : "RIGHT",
    body: c.body,
  };
  if (c.startLine != null) {
    a.start_line = c.startLine;
    a.start_side = a.side;
  }
  if (headSha) a.commit_id = headSha;
  return a;
}

/**
 * Create a GitHub adapter bound to an injected `request(url)`.
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
 * `request` fetches a JSON endpoint (`{ data, stale }`); `requestText` is the
 * same serialisation layer but returns the RAW body as a string (the diff
 * Accept header), so the two view the same URL without colliding in the ETag
 * store. Both are injected by index.mjs.
 *
 * @param {(url: string) => Promise<{ data: any, stale: boolean }>} request
 * @param {(url: string, opts: { method: string, body?: any }) => Promise<{ data: any, stale: boolean }>} [requestWrite]
 * @param {(url: string) => Promise<{ data: any, stale: boolean }>} [requestText]
 */
export function createGithubAdapter(request, requestWrite, requestText = request) {
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
     * GET /search/issues — the CROSS-REPO search surface (spec §4.5④). The
     * inbox answers its three populations in three requests regardless of the
     * user's repo count; per-repo /repos iteration would be O(N repos) and
     * would exhaust the search bucket's much lower rate limit. Results are
     * normalised by {@link normalizeSearchHit} and `reason` is stamped by the
     * caller from buildInboxQueries. Pass `{ ttl }` to extend the request
     * layer's freshness window — search has its own, lower rate limit, so the
     * box caches it a full 60s (spec §4.5④, "cache aggressively").
     *
     * @param {string} query the raw GitHub search qualifiers, e.g. "assignee:@me"
     * @param {{ ttl?: number }} [opts]
     * @returns {Promise<{ data: Array<object>, stale: boolean }>}
     */
    async searchIssues(query, { ttl } = {}) {
      const url = `${API}/search/issues${qs({ q: query })}`;
      const { data, stale } = await request(url, { ttl });
      const items = Array.isArray(data?.items) ? data.items : [];
      return { data: items.map(normalizeSearchHit), stale };
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
      const url = `${API}${issuePath(repo)}/issues${qs({
        state: filter.state ?? "open",
        ...(filter.labels !== undefined
          ? { labels: Array.isArray(filter.labels) ? filter.labels.join(",") : filter.labels }
          : {}),
      })}`;
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

    /**
     * POST /repos/{o}/{r}/pulls — create a pull request. Returns the created,
     * normalised PR. One code path for both the human ship action and any
     * future automated one (rule §Hygiene) — a draft-automated caller passes
     * `draft: true` and never reaches merge.
     * @param {{ owner: string, repo: string }} repo
     * @param {{ title: string, head: string, base: string, body?: string, draft?: boolean }} input
     * @returns {Promise<{ data: import("./index.mjs").PullRequestLike, stale: boolean }>}
     */
    async createPullRequest(repo, { title, head, base, body = "", draft = false }) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}${issuePath(repo)}/pulls`;
      const { data } = await requestWrite(url, {
        method: "POST",
        body: { title, head, base, body, draft },
      });
      return { data: normalizePr(data), stale: false };
    },

    /**
     * PUT /repos/{o}/{r}/pulls/{n}/merge — merge a pull request. **Always pass
     * `sha`** (the head SHA the user approved): without it the API merges
     * whatever landed after the reviewed diff and the failure is invisible
     * (issue §4). A non-ok response is mapped to its distinguished error kind
     * (405 cannot-merge / 409 sha-mismatch / 403 permission).
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @param {{ method?: string, sha: string }} input
     * @returns {Promise<{ data: any, stale: boolean }>}
     */
    async merge(repo, number, { method = "merge", sha } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}${issuePath(repo)}/pulls/${number}/merge`;
      let data;
      try {
        ({ data } = await requestWrite(url, {
          method: "PUT",
          body: { merge_method: method, sha },
        }));
      } catch (err) {
        if (err && typeof err === "object" && typeof err.status === "number" && err.name === "GithubRequestError") {
          throw mergeFailure(err.status, url);
        }
        throw err;
      }
      return { data, stale: false };
    },

    // ---- Review writes (BET-793) ------------------------------------------
    //
    // The box-buffered draft review flushes as ONE submitReview call. This is
    // precisely why the buffer lives on the box: there is NO REST endpoint to
    // add a comment to an existing pending review — the entire comments[] array
    // must be passed at creation. One batched review is well inside the rate
    // limit (mutations cost 5 points each); thirty individual comment POSTs are
    // not. `replyToThread` is the one genuinely per-thread write (a reply to an
    // existing incoming thread — there is no batching concept for those).

    /**
     * POST /repos/{o}/{r}/pulls/{n}/reviews — submit the box-buffered draft as
     * ONE review carrying every buffered comment in the same call (the whole
     * point of the box-side buffer). `verdict` maps to the review `event`
     * (null → COMMENT). Anchors are built with `toGithubAnchor`.
     *
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @param {{ verdict?: "approved" | "changes_requested" | "commented" | null,
     *           body?: string,
     *           comments?: Array<{ path: string, line: number, side: string, startLine?: number | null, body: string }>,
     *           headSha?: string }} [input]
     * @returns {Promise<{ data: any, stale: boolean }>}
     */
    async submitReview(repo, number, { verdict = null, body = "", comments = [], headSha = "" } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}${issuePath(repo)}/pulls/${number}/reviews`;
      const payload = { event: verdictToEvent(verdict), body };
      if (Array.isArray(comments) && comments.length > 0) {
        payload.comments = comments.map((c) => toGithubAnchor(c, headSha));
      }
      const { data } = await requestWrite(url, { method: "POST", body: payload });
      return { data, stale: false };
    },

    /**
     * POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies — reply to an
     * incoming thread. The one per-thread write; a reply anchors to the parent
     * comment, so only the body + reviewed commit are needed.
     *
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @param {{ threadId: string, body: string, headSha?: string }} input
     * @returns {Promise<{ data: any, stale: boolean }>}
     */
    async replyToThread(repo, number, { threadId, body, headSha = "" } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}${issuePath(repo)}/pulls/${number}/comments/${threadId}/replies`;
      const payload = { body: String(body ?? "").trim() };
      if (headSha) payload.commit_id = headSha;
      const { data } = await requestWrite(url, { method: "POST", body: payload });
      return { data, stale: false };
    },

    /**
     * GET /repos/{o}/{r}/pulls/{n} with `Accept: application/vnd.github.diff`
     * (raw unified diff as TEXT) + GET /repos/{o}/{r}/pulls/{n}/comments
     * (normalised into forge-neutral Threads). headSha comes from the PR
     * object so the renderer can key a draft comment to the SHA it reviewed.
     *
     * Returns `{ diff, threads, headSha }` — never a raw GitHub payload. The
     * diff is consumed verbatim by the existing UnifiedDiff renderer; a future
     * structured differ is deliberately NOT built.
     *
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @returns {Promise<{ data: { diff: string, threads: Array<any>, headSha: string }, stale: boolean }>}
     */
    async getDiff(repo, number) {
      const pull = `${API}${issuePath(repo)}/pulls/${number}`;
      let stale = false;
      let headSha = "";
      let diff = "";
      let threads = [];
      const pr = await request(pull);
      stale = stale || Boolean(pr?.stale);
      headSha = pr?.data?.head?.sha ?? "";
      const [diffRes, commentsRes] = await Promise.all([
        requestText(pull).catch(() => null),
        request(pull + "/comments").catch(() => null),
      ]);
      if (diffRes) {
        stale = stale || Boolean(diffRes.stale);
        diff = typeof diffRes.data === "string" ? diffRes.data : "";
      }
      if (commentsRes) {
        stale = stale || Boolean(commentsRes.stale);
        threads = normalizeReviewThreads(commentsRes.data);
      }
      return { data: { diff, threads, headSha }, stale };
    },

    /**
     * GET /repos/{o}/{r}/issues/{n}/comments — the plain (issue) comments on a
     * PR or issue, reduced to {id, body}. The forge progress sink reads these
     * to find its topic marker before upserting.
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @returns {Promise<{ data: Array<{ id: any, body: string }>, stale: boolean }>}
     */
    async listIssueComments(repo, number) {
      const url = `${API}${issuePath(repo)}/issues/${number}/comments`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      return { data: raw.map((c) => ({ id: c?.id ?? null, body: c?.body ?? "" })), stale };
    },

    /**
     * POST /repos/{o}/{r}/issues/{n}/comments — create a plain comment on a PR
     * or issue.
     * @param {{ owner: string, repo: string }} repo
     * @param {number} number
     * @param {string} body
     * @returns {Promise<{ data: { id: any }, stale: boolean }>}
     */
    async createIssueComment(repo, number, body) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}${issuePath(repo)}/issues/${number}/comments`;
      const { data } = await requestWrite(url, { method: "POST", body: { body } });
      return { data: { id: data?.id ?? null }, stale: false };
    },

    /**
     * PATCH /repos/{o}/{r}/issues/comments/{id} — update an existing plain
     * comment in place (the "update" half of ensure-comment-by-topic).
     * @param {{ owner: string, repo: string }} repo
     * @param {any} commentId
     * @param {string} body
     * @returns {Promise<{ data: { id: any }, stale: boolean }>}
     */
    async updateIssueComment(repo, commentId, body) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${API}/repos/${repo.owner}/${repo.repo}/issues/comments/${commentId}`;
      const { data } = await requestWrite(url, { method: "PATCH", body: { body } });
      return { data: { id: data?.id ?? null }, stale: false };
    },

    /**
     * GET /user/repos — the repos the connected user can actually PUSH to,
     * most-recently-pushed first. Filtering to write access is what keeps the
     * clone picker usable: a read-only repo you cannot push to is noise here,
     * so it is dropped (from `/user/repos`' per-repo `permissions.push`).
     * Normalised to a forge-neutral shape; the renderer groups by `owner`.
     *
     * @returns {Promise<{ data: Array<object>, stale: boolean }>}
     */
    async listMyRepos() {
      const url = `${API}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member`;
      const { data, stale } = await request(url);
      return { data: pushableRepos(data), stale };
    },
  };
}

// normalizeRepo — pure mapping of a GitHub repository payload to the
// forge-neutral clone-picker shape. Callers sort / group; this only maps.
export function normalizeRepo(r) {
  return {
    name: r?.name ?? "",
    fullName: r?.full_name ?? "",
    owner: r?.owner?.login ?? "",
    description: typeof r?.description === "string" ? r.description : null,
    pushedAt: r?.pushed_at ? Date.parse(r.pushed_at) : null,
    defaultBranch: r?.default_branch ?? "main",
    cloneUrl: r?.clone_url ?? "",
    url: r?.html_url ?? "",
  };
}

// pushableRepos — drop read-only repos (permissions.push !== true) and map the
// rest, most-recently-pushed first. Pure.
export function pushableRepos(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => r?.permissions?.push === true)
    .map(normalizeRepo)
    .sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
}
