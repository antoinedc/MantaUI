// src/server/forge/poller.mjs — the polling fallback (BET-798).
//
// The webhook is the primary path, but it is NOT the whole story — for two
// live constraints the poller is a required peer, not a nice-to-have:
//   1. Not every box is reachable. The macOS install path deliberately skips
//      public TLS, and a Tailscale-only box has no public ingress at all —
//      neither will ever receive a webhook.
//   2. GitLab disables failing webhooks — a handful of consecutive failures
//      suspends them, more kills them permanently with no automatic recovery.
//      A box that sleeps overnight goes silently deaf.
//
// Design rules (issue §3 + spec §3.4⑤):
//   - Reuse the shared poller shape (startPoller — immediate first tick,
//     inFlight guard, timer.unref()) that schedule.mjs / delegate.mjs /
//     capabilities.mjs already share. This is NOT a fourth hand-rolled copy.
//   - A 304 costs NOTHING against the rate limit. The ETag/if-none-match and
//     single-flight mechanics already live in the forge request layer
//     (forge/index.mjs createRequestLayer) — the poller REUSES it via the
//     injected adapter rather than owning a second cache.
//   - Prefer webhooks where they work; poll where they cannot. Never both for
//     the same repo (a repo with a working webhook is skipped here).
//   - Honour the poll-interval the API returns where the injected poller opts
//     in (pollIssueLabels ignores it today; a future caller may thread it
//     through).
//
// The poller produces the SAME normalised forge events the webhook ingest
// does, and routes them through the SAME engine dispatchEvent — one path.

import { rollupChecks } from "../../shared/forge.mjs";
import { startPoller } from "../startPoller.mjs";

/**
 * Build the polling loop. `pollRepo` is the injected per-repo unit (the shape
 * below is one concrete implementer); it returns `{ events: [forgeEvent] }`
 * where each event is a normalised forge event exactly like a webhook would
 * produce. The loop owns only the cadence (startPoller) and the
 * webhook-vs-poll exclusivity.
 *
 * @param {object} deps
 * @param {() => Promise<Array<{repoKey: string, webhookRegistered?: boolean}>>} deps.listRepos
 *   Repos that have rules (each with whether it has a working webhook).
 * @param {(repo) => Promise<{events: Array<any>}>} deps.pollRepo
 * @param {(event: any) => Promise<unknown>} deps.handleEvent
 * @param {number} [deps.intervalMs]
 * @returns {{ stop: () => void }}
 */
export function createForgePoller({
  listRepos,
  pollRepo,
  handleEvent,
  intervalMs = 60_000,
} = {}) {
  async function tick() {
    let repos = [];
    try {
      repos = await listRepos();
    } catch (e) {
      console.warn("[forge-poller] listRepos failed:", e?.message ?? e);
      return;
    }
    for (const repo of repos) {
      // Prefer webhooks where they work; poll where they cannot. Never both
      // for the same repo.
      if (repo.webhookRegistered) continue;

      let result;
      try {
        result = await pollRepo(repo);
      } catch (e) {
        console.warn(`[forge-poller] poll ${repo.repoKey} failed:`, e?.message ?? e);
        continue;
      }
      const events = result?.events ?? [];
      for (const ev of events) {
        try {
          await handleEvent(ev);
        } catch (e) {
          console.warn(`[forge-poller] dispatch ${repo.repoKey} failed:`, e?.message ?? e);
        }
      }
    }
  }

  return startPoller(tick, { intervalMs, label: "forge-poller" });
}

// The identity used to de-duplicate a polled issue event, so a 304 / an
// unchanged list does not re-dispatch the same labelled issue.
function issueIdentity(repo, number, label) {
  return `${repo.owner}/${repo.repo}#${number}:${label ?? ""}`;
}

// The identity used to de-duplicate a polled PR event (checks.failed /
// review.requested). `kind` namespaces the set so a PR's failure and its
// pending review are independent dispatch slots.
function prIdentity(repo, number, kind) {
  return `${repo.owner}/${repo.repo}#${number}:${kind}`;
}

/**
 * One concrete per-repo poll unit: fetch a repo's open issues carrying a
 * given label and emit a normalised `issue.labeled` event for each that has
 * NOT been emitted since the last successful poll. The ETag/304 guarantee is
 * supplied by the underlying fetch (getJson returns the same list on a 304)
 * and this module's `seen` set turns "same list again" into "zero events".
 * Pure of cadence — fully testable with a stub issue list.
 *
 * @param {{ repo: {owner: string, repo: string}, label: string, listIssues: (repo, filter) => Promise<{data: Array<any>}> }} deps
 * @param {{ seen?: Set<string> }} [state]
 * @returns {Promise<{events: Array<any>}>}
 */
export async function pollIssueLabels(
  { repo, label, listIssues },
  { seen = new Set() } = {},
) {
  const res = await listIssues(repo, { state: "open", labels: label });
  const rows = Array.isArray(res?.data) ? res.data : [];
  const events = [];
  for (const issue of rows) {
    if (typeof issue?.number !== "number" || typeof issue?.url !== "string") continue;
    const id = issueIdentity(repo, issue.number, label);
    if (seen.has(id)) continue; // 304 / no-change — must not re-dispatch
    seen.add(id);
    events.push({
      type: "issue.labeled",
      label,
      ...(typeof issue.title === "string" ? { title: issue.title } : {}),
      url: issue.url,
      fork: false,
    });
  }
  return { events };
}

/**
 * One concrete per-repo poll unit: fetch a repo's open PRs and emit a
 * normalised `checks.failed` event for each whose CI rollup is red (a check
 * with a failing conclusion). This is the poll fallback for a `checks.failed`
 * rule on a box the webhook cannot reach. It mirrors `pollIssueLabels`'
 * de-dup: the ETag/304 guarantee is supplied by the underlying fetch (getChecks
 * returns the same data on a 304) and the `seen` set turns "still red, same
 * list" into "zero events" — a 304 never re-dispatches a PR already failed.
 * `rollup` is injectable so the test can stub the tri-state without the real
 * check vocabulary.
 *
 * @param {{ repo: {owner: string, repo: string}, listPullRequests: (repo, filter) => Promise<{data: Array<any>}>, getChecks: (repo, sha) => Promise<{data: Array<any>}>, rollup?: (checks: Array<any>) => string }} deps
 * @param {{ seen?: Set<string> }} [state]
 * @returns {Promise<{events: Array<any>}>}
 */
export async function pollChecksFailed(
  { repo, listPullRequests, getChecks, rollup = rollupChecks },
  { seen = new Set() } = {},
) {
  const res = await listPullRequests(repo, { state: "open" });
  const rows = Array.isArray(res?.data) ? res.data : [];
  const events = [];
  for (const pr of rows) {
    if (typeof pr?.number !== "number" || typeof pr?.headSha !== "string" || !pr.headSha) continue;
    let checks = [];
    try {
      const c = await getChecks(repo, pr.headSha);
      checks = Array.isArray(c?.data) ? c.data : [];
    } catch {
      // Checks are best-effort — a PR whose CI is unreachable is skipped, not
      // blanked out of the poll.
      continue;
    }
    if (rollup(checks) !== "red") continue;
    const id = prIdentity(repo, pr.number, "checks.failed");
    if (seen.has(id)) continue; // 304 / no-change — must not re-dispatch
    seen.add(id);
    events.push({
      type: "checks.failed",
      ...(typeof pr.headRef === "string" && pr.headRef ? { branch: pr.headRef } : {}),
      ...(typeof pr.title === "string" ? { title: pr.title } : {}),
      ...(typeof pr.url === "string" ? { url: pr.url } : {}),
      fork: false,
    });
  }
  return { events };
}

/**
 * One concrete per-repo poll unit: fetch a repo's open PRs and emit a
 * normalised `review.requested` event for each that is waiting on a review —
 * the poll fallback for a `review.requested` rule on a box the webhook cannot
 * reach. The webhook fires once when a reviewer is added; a poll sees only a
 * snapshot, so it proxies the same signal through the PR's merge-block state
 * (a PR that is blocked on review is one whose review is still outstanding).
 * Same ETag/`seen`-set de-dup as `pollIssueLabels` — once dispatched, a PR's
 * pending review is not re-dispatched on the next unchanged poll.
 *
 * @param {{ repo: {owner: string, repo: string}, listPullRequests: (repo, filter) => Promise<{data: Array<any>}> }} deps
 * @param {{ seen?: Set<string> }} [state]
 * @returns {Promise<{events: Array<any>}>}
 */
export async function pollReviewRequested(
  { repo, listPullRequests },
  { seen = new Set() } = {},
) {
  const res = await listPullRequests(repo, { state: "open" });
  const rows = Array.isArray(res?.data) ? res.data : [];
  const events = [];
  for (const pr of rows) {
    if (typeof pr?.number !== "number") continue;
    // `review required` is the normalised merge-block reason for a PR whose
    // mergeable_state is `blocked` or `review_requested` — i.e. a review has
    // been requested and has not yet satisfied the merge gate.
    if (pr?.mergeBlockedReason !== "review required") continue;
    const id = prIdentity(repo, pr.number, "review.requested");
    if (seen.has(id)) continue; // 304 / no-change — must not re-dispatch
    seen.add(id);
    events.push({
      type: "review.requested",
      ...(typeof pr.headRef === "string" && pr.headRef ? { branch: pr.headRef } : {}),
      ...(typeof pr.title === "string" ? { title: pr.title } : {}),
      ...(typeof pr.url === "string" ? { url: pr.url } : {}),
      fork: false,
    });
  }
  return { events };
}
