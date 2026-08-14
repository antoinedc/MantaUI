// gitlab.mjs — the GitLab REST adapter for the forge seam (BET-799).
//
// This module is the acceptance test for the whole L0 seam: everything before
// it was designed against GitLab's documentation precisely so this file is
// small. When GitLab does not fit, the rule is to change THIS adapter, never
// `src/shared/forge.mjs` — if a GitLab-shaped field is needed in the shared
// vocabulary, that is the abstraction failing and is a design finding, not an
// implementation change.
//
// Plain `fetch` only (no dependency). Like the GitHub adapter it is PURE
// normalisation + URL construction and holds no cache / single-flight /
// rate-limit state — serialisation lives in index.mjs. It differs from GitHub
// in exactly the places GitLab's API differs, which is the point.
//
// The eight mismatches this module owns (each is a real bug if missed):
//   1. `iid`, never `id`. Every GitLab API path uses the per-project `iid`;
//      the shared `number` IS the iid, never the global `id`.
//   2. Project addressing: `/projects/{id}` accepts the URL-encoded FULL path
//      (`group%2Fsub%2Fproj`), which is how `detectForge` returns sub-group
//      owners. Encoded here, never split.
//   3. `"opened"`, not `"open"` — reconciled by `normalizePrState`, reused.
//   4. Issues and MRs are DISJOINT objects on GitLab (the inverse of GitHub) —
//      labels/assignees/notes for an MR go through the MR endpoints, and
//      `listIssues` does NOT need to filter out PRs.
//   5. There is no review object. Approval is a boolean per user
//      (`approve`/`unapprove`); "changes requested" surfaces only inside
//      `detailed_merge_status`. `submitReview` posts each buffered comment as
//      its own discussion then approve/unapprove for the verdict — the box-side
//      buffer exists so the user-visible behaviour matches GitHub exactly.
//   6. Inline comment anchoring needs three SHAs (`base_sha`, `head_sha`,
//      `start_sha`) from `/merge_requests/{iid}/versions` — one extra request
//      before the batch, cached per head SHA. Added line → `new_line` only;
//      removed → `old_line` only; unchanged → both.
//   7. Pipelines + commit statuses, not checks. `manual`/`scheduled` (which
//      have no GitHub analogue) map to a pending-ish status → roll to yellow.
//   8. `detailed_merge_status` (~25 values) maps to `mergeable` + a rich
//      `mergeBlockedReason`.
//
// Bonus capability: thread resolution is plain REST here
// (`PUT .../discussions/{id}` with `{resolved: true}`) where GitHub needs
// GraphQL — so this adapter exposes the optional `resolveThread` (absent on
// the GitHub adapter). That asymmetry is the capability model working as
// designed (spec §3.2).

import { normalizePrState } from "../../shared/forge.mjs";
import { GithubRequestError, MergeNotAllowedError, MergeShaMismatchError, MergePermissionError } from "./github.mjs";

const API = "https://gitlab.com/api/v4";

// Map a merge PUT's failure status to its distinguished error kind, exactly as
// the GitHub adapter does. GitLab: 405 = not mergeable, 409 = head sha no
// longer matches, 403 = no permission; anything else stays generic.
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

// The GitLab project path is `/projects/<url-encoded-full-path>` where the full
// path is `owner/repo` (owner may itself be `group/subgroup`). `detectForge`
// already splits subgroup owners into `owner`; we rejoin and encode the whole
// thing, never the segments — splitting would break nested groups.
function projectPath(repo) {
  return `/projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`;
}

// GitLab's MR `state` filter values differ from the shared filter's "open".
const STATE_FILTERS = { open: "opened", opened: "opened", closed: "closed", merged: "merged", all: "all" };
function stateFilter(state) {
  return STATE_FILTERS[state] ?? state;
}

// Map `detailed_merge_status` (~25 values) onto the shared `mergeable` +
// `mergeBlockedReason`. These are GITLAB's raw values; the shared vocabulary
// only ever sees the reconciled `mergeable` boolean + human reason.
const MERGE_STATUS = Object.freeze({
  // mergeable
  can_be_merged: { mergeable: true, reason: null },
  mergeable: { mergeable: true, reason: null },
  merge_when_pipeline_succeeds: { mergeable: true, reason: null },
  // still computing
  checking: { mergeable: null, reason: null },
  unchecked: { mergeable: null, reason: null },
  preparing: { mergeable: null, reason: null },
  // mergeable with effort
  need_rebase: { mergeable: false, reason: "needs rebase" },
  conflict: { mergeable: false, reason: "conflicts" },
  // blocked — each a distinct, readable reason
  ci_must_pass: { mergeable: false, reason: "checks failing" },
  ci_still_running: { mergeable: false, reason: "checks still running" },
  not_approved: { mergeable: false, reason: "approval required" },
  discussions_not_resolved: { mergeable: false, reason: "unresolved discussions" },
});

function mergeableFrom(raw) {
  if (raw.draft) return { mergeable: false, reason: "draft" };
  const status = raw.detailed_merge_status ?? null;
  if (status == null || typeof status !== "string") {
    // Older GitLab only exposes the coarse `merge_status`. Fall back to it.
    if (raw.merge_status === "can_be_merged") return { mergeable: true, reason: null };
    if (raw.merge_status === "cannot_be_merged" || raw.merge_status === "cannot_be_merged_recheck") {
      return { mergeable: false, reason: "not mergeable" };
    }
    return { mergeable: null, reason: null };
  }
  const m = MERGE_STATUS[status];
  if (m) return m;
  // Any other raw value is a real "not mergeable" — surface it generically.
  return { mergeable: false, reason: "not mergeable" };
}

// Normalise one raw GitLab MR into the shared PullRequest shape. `number` is
// the iid (mismatch #1) — a captured payload's `iid` and the URL both carry it,
// and the raw global `id` must never be used as `number`.
function normalizeMr(raw, { unresolvedThreads = 0 } = {}) {
  const { mergeable, reason } = mergeableFrom(raw);
  return {
    number: raw.iid,
    title: raw.title ?? "",
    body: raw.description ?? "",
    url: raw.web_url ?? "",
    state: normalizePrState(
      { state: raw.state, merged: raw.state === "merged", draft: raw.draft },
      "gitlab",
    ),
    draft: Boolean(raw.draft),
    headRef: raw.source_branch ?? "",
    baseRef: raw.target_branch ?? "",
    headSha: raw.sha ?? "",
    author: raw.author?.username ?? "",
    reviewers: Array.isArray(raw.reviewers)
      ? raw.reviewers.map((r) => r?.username ?? "").filter(Boolean)
      : [],
    mergeable,
    mergeBlockedReason: reason,
    unresolvedThreads: unresolvedThreads ?? 0,
  };
}

// GitLab pipeline `status` values → the shared check vocabulary. `manual` and
// `scheduled` have no GitHub analogue and must NOT read as failed (red) — they
// map to a pending-ish `waiting` status so rollupChecks rolls them to yellow,
// and the raw list is kept for display (spec §3.4②).
function normalizePipeline(p) {
  const url = p?.web_url ?? "";
  const name = p?.name ?? "pipeline";
  switch (p?.status) {
    case "success":
      return { name, status: "completed", conclusion: "success", url };
    case "failed":
      return { name, status: "completed", conclusion: "failure", url };
    case "canceled":
    case "skipped":
      return { name, status: "completed", conclusion: undefined, url };
    case "manual":
    case "scheduled":
      return { name, status: "waiting", url };
    default:
      // created / waiting_for_resource / preparing / pending / running
      return { name, status: "running", url };
  }
}

// GitLab commit-status `status` values → shared check vocabulary. Same manual /
// scheduled → yellow rule as pipelines.
function normalizeCommitStatus(s) {
  const url = s?.target_url ?? "";
  const name = s?.name ?? s?.ref ?? "status";
  switch (s?.status) {
    case "success":
      return { name, status: "completed", conclusion: "success", url };
    case "failed":
      return { name, status: "completed", conclusion: "failure", url };
    case "canceled":
    case "skipped":
      return { name, status: "completed", conclusion: undefined, url };
    case "manual":
    case "scheduled":
      return { name, status: "waiting", url };
    default:
      // pending / running
      return { name, status: "running", url };
  }
}

// Group GitLab discussions into forge-neutral Threads (same shape the review
// pane reads for GitHub). A discussion whose first note has no `position` is a
// general (non-line) comment and is not a thread. Anchoring comes from the
// position: `new_line` (added) → RIGHT side, `old_line` (removed) → LEFT.
function normalizeThreads(discussions) {
  const threads = [];
  for (const d of Array.isArray(discussions) ? discussions : []) {
    const notes = Array.isArray(d?.notes) ? d.notes : [];
    if (notes.length === 0) continue;
    const pos = notes[0]?.position;
    if (!pos || (pos.new_path == null && pos.old_path == null)) continue;
    const newLine = pos.new_line ?? null;
    const oldLine = pos.old_line ?? null;
    threads.push({
      id: String(d.id),
      path: pos.new_path ?? pos.old_path ?? null,
      line: newLine ?? oldLine,
      side: newLine != null ? "RIGHT" : "LEFT",
      startLine: pos.line_range?.start?.new_line ?? null,
      resolved: Boolean(d.resolved),
      comments: notes.map((n) => ({
        author: n?.author?.username ?? "",
        body: n?.body ?? "",
        createdAt: n?.created_at ?? null,
      })),
    });
  }
  return threads;
}

// ---------------------------------------------------------------------------
// Position building (mismatch #6)
// ---------------------------------------------------------------------------

// An extra request before inline comments: GitLab needs three SHAs which come
// from `/merge_requests/{iid}/versions`. Cached per head SHA (the latest
// version's `head_sha` IS the current head). The module-level cache spans
// adapter instances because index.mjs creates a fresh adapter per call — this is
// the one deliberate piece of adapter-side memoisation the design permits.
const positionShaCache = new Map(); // `${base}#${headSha}` -> { base_sha, start_sha, head_sha }
const POSITION_CACHE_MAX = 200;

async function positionShas(base, headSha, request) {
  const key = `${base}#${headSha}`;
  const hit = positionShaCache.get(key);
  if (hit) return hit;
  let shas = { base_sha: "", start_sha: "", head_sha: headSha };
  try {
    const { data } = await request(`${base}/versions`);
    const versions = Array.isArray(data) ? data : [];
    if (versions.length > 0) {
      const v = versions[0];
      shas = {
        base_sha: v?.base_sha ?? "",
        start_sha: v?.start_sha ?? "",
        head_sha: v?.head_sha ?? headSha,
      };
    }
  } catch {
    // Fall back to the head SHA alone; GitLab still resolves the position.
  }
  if (positionShaCache.size >= POSITION_CACHE_MAX) positionShaCache.clear();
  positionShaCache.set(key, shas);
  return shas;
}

/**
 * Build a GitLab discussion `position` from a forge-neutral anchor.
 *
 * The `new_line`/`old_line` combination is the trap: an ADDED line sets
 * `new_line` only, a REMOVED line sets `old_line` only, and an UNCHANGED line
 * sets BOTH. `side` `"new"` → added; `"old"` → removed; anything else → both.
 * Pure and exported for tests.
 *
 * @param {{ base_sha?: string, start_sha?: string, head_sha?: string }} shas
 * @param {{ path: string, line: number, side?: string, startLine?: number | null }} a
 */
export function buildPosition(shas, a) {
  const pos = {
    base_sha: shas?.base_sha ?? "",
    start_sha: shas?.start_sha ?? "",
    head_sha: shas?.head_sha ?? "",
    position_type: "text",
    new_path: a?.path,
    old_path: a?.path,
  };
  if (a?.side === "old") {
    pos.old_line = a.line;
  } else if (a?.side === "new") {
    pos.new_line = a.line;
  } else {
    pos.new_line = a.line;
    pos.old_line = a.line;
  }
  pos.width = a?.side === "old" ? "left" : "right";
  if (a?.startLine != null) {
    pos.line_range = { start: { new_line: a.startLine }, end: { new_line: a.line } };
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Create a GitLab adapter bound to an injected `request(url)` (same contract as
 * the GitHub adapter; see index.mjs's typedef). Returns `{ data, stale }` where
 * `data` is always a NORMALISED shape.
 *
 * @param {(url: string) => Promise<{ data: any, stale: boolean }>} request
 * @param {(url: string, opts: { method: string, body?: any }) => Promise<{ data: any, stale: boolean }>} [requestWrite]
 * @param {(url: string) => Promise<{ data: any, stale: boolean }>} [requestText]
 * @param {string} [apiBase] the API root; defaults to gitlab.com. A self-hosted
 *   instance serves `<host>/api/v4`.
 */
export function createGitlabAdapter(request, requestWrite, requestText = request, apiBase = API) {
  return {
    kind: "gitlab",

    async listPullRequests(repo, filter = {}) {
      const url = `${apiBase}${projectPath(repo)}/merge_requests${qs({ state: stateFilter(filter.state ?? "opened") })}`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      return { data: raw.map((m) => normalizeMr(m)), stale };
    },

    async getPullRequest(repo, number) {
      const base = `${apiBase}${projectPath(repo)}/merge_requests/${number}`;
      const prRes = await request(base);
      const raw = prRes.data;
      let stale = prRes.stale;
      let unresolvedThreads = 0;
      try {
        const t = await request(`${base}/discussions`);
        stale = stale || Boolean(t?.stale);
        unresolvedThreads = normalizeThreads(t?.data).filter((th) => !th.resolved).length;
      } catch {
        // Thread count is display-only; a failure must not blank the PR.
      }
      return { data: normalizeMr(raw, { unresolvedThreads }), stale };
    },

    // GitLab issues and MRs are DISJOINT objects (mismatch #4) — unlike
    // GitHub, an issue list never leaks MRs, so nothing needs filtering.
    async listIssues(repo, filter = {}) {
      const url = `${apiBase}${projectPath(repo)}/issues${qs({ state: stateFilter(filter.state ?? "opened") })}`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      const issues = raw.map((i) => ({
        number: i.iid,
        title: i.title ?? "",
        body: i.description ?? "",
        url: i.web_url ?? "",
        state: i.state,
        closed: i.state === "closed",
      }));
      return { data: issues, stale };
    },

    // Pipelines + commit statuses, not checks (mismatch #7). Both are fetched
    // by HEAD SHA — GitLab indexes pipelines by commit too, so the shared
    // `getChecks(repo, sha)` signature (no MR iid) still resolves them.
    async getChecks(repo, sha) {
      const base = `${apiBase}${projectPath(repo)}`;
      let stale = false;
      let checks = [];
      try {
        const { data, stale: s } = await request(`${base}/pipelines${qs({ sha })}`);
        checks = (Array.isArray(data) ? data : []).map(normalizePipeline);
        stale = stale || s;
      } catch {
        // pipelines may be unavailable/empty; commit statuses below still cover it.
      }
      try {
        const { data, stale: s } = await request(`${base}/repository/commits/${encodeURIComponent(sha)}/statuses`);
        checks = checks.concat((Array.isArray(data) ? data : []).map(normalizeCommitStatus));
        stale = stale || s;
      } catch {
        // no commit statuses — pipelines above may still cover it.
      }
      return { data: checks, stale };
    },

    async createPullRequest(repo, { title, head, base, body = "", draft = false }) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests`;
      // GitLab has no `draft` boolean on create — a title prefixed "Draft:" is
      // how a draft MR is created (and how `work_in_progress` is signalled).
      const { data } = await requestWrite(url, {
        method: "POST",
        body: {
          source_branch: head,
          target_branch: base,
          title: draft ? `Draft: ${title}` : title,
          description: body,
        },
      });
      return { data: normalizeMr(data), stale: false };
    },

    async merge(repo, number, { method = "merge", sha } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/merge`;
      let data;
      try {
        ({ data } = await requestWrite(url, { method: "PUT", body: { sha } }));
      } catch (err) {
        if (err && typeof err === "object" && typeof err.status === "number" && err.name === "GithubRequestError") {
          throw mergeFailure(err.status, url);
        }
        throw err;
      }
      return { data, stale: false };
    },

    // ---- Review writes (BET-793) -----------------------------------------
    //
    // GitLab has NO review object (mismatch #5): no PENDING, no batching, no
    // review body. Every comment POST publishes immediately. So "submit" here
    // posts each buffered comment as its own discussion, then approve/unapprove
    // for the verdict. The user-visible behaviour — the box-buffered draft
    // flushes as one review — is identical to GitHub's; that is the payoff of
    // the buffer.
    async submitReview(repo, number, { verdict = null, body = "", comments = [], headSha = "" } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const base = `${apiBase}${projectPath(repo)}/merge_requests/${number}`;
      const commentsArr = Array.isArray(comments) ? comments : [];
      const shas = await positionShas(base, headSha, request);
      for (const c of commentsArr) {
        await requestWrite(`${base}/discussions`, {
          method: "POST",
          body: { body: c.body, position: buildPosition(shas, c) },
        });
      }
      // A review body has no home in a comment-only model; post it as a general
      // MR note so the author's summary survives (mirrors GitHub's review body).
      if (typeof body === "string" && body.trim()) {
        await requestWrite(`${base}/notes`, { method: "POST", body: { body: body.trim() } });
      }
      if (verdict === "approved") {
        await requestWrite(`${base}/approve`, { method: "POST" });
      } else if (verdict === "changes_requested") {
        await requestWrite(`${base}/unapprove`, { method: "POST" });
      }
      return { data: { verdict: verdict ?? "comment", comments: commentsArr.length }, stale: false };
    },

    async replyToThread(repo, number, { threadId, body, headSha = "" } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/discussions/${threadId}/notes`;
      const { data } = await requestWrite(url, { method: "POST", body: { body: String(body ?? "").trim() } });
      return { data, stale: false };
    },

    // OPTIONAL capability: plain REST thread resolution (absent on GitHub,
    // which needs GraphQL). Presence is the capability model.
    async resolveThread(repo, number, { discussionId } = {}) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/discussions/${discussionId}`;
      const { data } = await requestWrite(url, { method: "PUT", body: { resolved: true } });
      return { data, stale: false };
    },

    async getDiff(repo, number) {
      const base = `${apiBase}${projectPath(repo)}/merge_requests/${number}`;
      let stale = false;
      let headSha = "";
      let diff = "";
      let threads = [];
      try {
        const pr = await request(base);
        stale = stale || Boolean(pr?.stale);
        headSha = pr?.data?.sha ?? "";
      } catch {
        // leave headSha empty; the changes request below still best-efforts.
      }
      // GitLab serves the diff as JSON (`/changes`, one `diff` per file) rather
      // than a raw-text Accept variant — reassemble the unified diff from the
      // per-file `diff` fields so the existing UnifiedDiff renderer consumes it
      // verbatim (no structured differ is built).
      try {
        const changes = await request(`${base}/changes`);
        stale = stale || Boolean(changes?.stale);
        const files = Array.isArray(changes?.data?.changes) ? changes.data.changes : [];
        diff = files.map((f) => f?.diff ?? "").join("\n");
      } catch {
        // diff best-effort
      }
      try {
        const ds = await request(`${base}/discussions`);
        stale = stale || Boolean(ds?.stale);
        threads = normalizeThreads(ds?.data);
      } catch {
        // threads best-effort
      }
      return { data: { diff, threads, headSha }, stale };
    },

    // MR notes (GitLab's plain comments live on the MR, not an issues endpoint
    // — mismatch #4 again). The progress sink reads these for its topic marker.
    async listIssueComments(repo, number) {
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/notes`;
      const { data, stale } = await request(url);
      const raw = Array.isArray(data) ? data : [];
      return { data: raw.map((c) => ({ id: c?.id ?? null, body: c?.body ?? "" })), stale };
    },

    async createIssueComment(repo, number, body) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/notes`;
      const { data } = await requestWrite(url, { method: "POST", body: { body } });
      return { data: { id: data?.id ?? null }, stale: false };
    },

    // GitLab note ids are iid-scoped, so this needs the MR number where
    // GitHub's comment id is global — an interface asymmetry GitLab forces.
    async updateIssueComment(repo, number, commentId, body) {
      if (!requestWrite) throw new Error("write transport not available");
      const url = `${apiBase}${projectPath(repo)}/merge_requests/${number}/notes/${commentId}`;
      const { data } = await requestWrite(url, { method: "PUT", body: { body } });
      return { data: { id: data?.id ?? null }, stale: false };
    },
  };
}
