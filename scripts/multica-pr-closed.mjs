#!/usr/bin/env node
/**
 * Multica: react to a closed PR — mark the issue done, or explain the closure.
 *
 * WHY THIS EXISTS
 * ---------------
 * A merged PR is easy: flip its `BET-N` issue to `done`. The hard case is a PR
 * that closes WITHOUT merging, because GitHub closes a PR for two reasons that
 * look identical in the webhook and mean opposite things:
 *
 *   1. Someone abandoned it.
 *   2. It was STACKED on another PR, and that parent merged. GitHub deletes the
 *      merged branch, and every PR still targeting it is auto-closed.
 *
 * Case 2 is routine here: an implementer splits a follow-up out of a parent and
 * bases the follow-up branch on the parent, so the PR diff is the delta only.
 *
 * The original workflow treated both as case 1 and commented "Marking BET-N as
 * still open — please reopen". On 2026-07-31 that comment landed on BET-429
 * seconds after its parent BET-421 merged. It read as an instruction, so the PM
 * agent reopened the issue and dispatched an implementer to rebase and re-PR —
 * except the parent had been sent back in review for exactly those gaps and had
 * absorbed the child's entire scope. The feature was already on `main`. The
 * reopen would have re-landed shipped code on top of a rebase resolution.
 *
 * A comment on an agent-assigned Multica issue DISPATCHES A RUN, so a wrong
 * comment is not cosmetic — it is a wrong instruction with an agent behind it.
 *
 * WHAT THIS DOES ABOUT IT
 * -----------------------
 * Distinguish the two closures from evidence, and never assert more than the
 * evidence supports:
 *
 *   merged      → set the issue `done` (unchanged behaviour).
 *   stacked     → say so, change nothing, and require a check against `main`
 *                 before anyone reopens. CI cannot know whether the parent
 *                 absorbed the scope — duplicated CONTENT leaves the child's
 *                 commits genuinely absent from `main` — so it must not guess.
 *   abandoned   → say so, change nothing.
 *
 * No branch ever changes an issue's status except the merged one. "Reopen" is
 * never suggested, because that is the word the PM acted on.
 *
 * USAGE
 *   node scripts/multica-pr-closed.mjs [--dry-run]
 *
 * ENV
 *   GITHUB_EVENT_PATH      required — the pull_request_target payload
 *   GITHUB_TOKEN           required — reads branches/PRs to detect the stack
 *   MULTICA_TOKEN          required to mutate Multica; absent → log and skip
 *   MULTICA_WORKSPACE_ID   optional — defaults to the MantaUI (BET) workspace
 *   MULTICA_API_BASE       optional — defaults to https://api.multica.ai
 *   GITHUB_API_URL         optional — set by Actions
 *
 * Exit code is 0 unless the payload itself is unreadable. Every remote call
 * warns and continues: housekeeping must never fail a merge pipeline.
 */

import { readFile } from "node:fs/promises";
import { api, DEFAULT_WORKSPACE, DEFAULT_API_BASE } from "./lib/multicaApi.mjs";

export const DEFAULT_ISSUE_PREFIX = "BET";

/**
 * Find the issue key a PR belongs to.
 *
 * Title first, branch second — the title is what a human curates, the branch is
 * what an agent generates. Either is authoritative on its own; when they
 * disagree the title wins because a branch can be reused across attempts.
 *
 * @param {{title?:string, headRef?:string, prefix?:string}} args
 * @returns {string|null}
 */
export function extractIssueKey({ title, headRef, prefix = DEFAULT_ISSUE_PREFIX } = {}) {
  const re = new RegExp(`${prefix}-(\\d+)`, "i");
  for (const candidate of [title, headRef]) {
    if (typeof candidate !== "string") continue;
    const m = candidate.match(re);
    if (m) return `${prefix}-${m[1]}`;
  }
  return null;
}

/**
 * Why did this PR close?
 *
 * Pure: every input is passed in, nothing is fetched. This is the whole
 * judgement of the script and therefore the whole unit-test surface.
 *
 * `baseBranchExists` and `baseMerged` may be `null` when the lookup failed. A
 * failed lookup must never be read as evidence of abandonment, so an unknown
 * base on a non-default branch still classifies as `stacked` — the conservative
 * side, since the stacked comment changes nothing and asks for a check.
 *
 * @param {{
 *   merged?: boolean,
 *   baseRef?: string,
 *   defaultBranch?: string,
 *   baseBranchExists?: boolean|null,
 *   baseMerged?: boolean|null,
 * }} args
 * @returns {{kind:"merged"|"stacked"|"abandoned", reason:string}}
 */
export function classifyClosure({
  merged,
  baseRef,
  defaultBranch,
  baseBranchExists = null,
  baseMerged = null,
} = {}) {
  if (merged === true) return { kind: "merged", reason: "PR merged" };

  const base = typeof baseRef === "string" ? baseRef : "";
  const main = typeof defaultBranch === "string" && defaultBranch ? defaultBranch : "main";

  // Targeting the default branch: there is no parent to have taken it down, so
  // the close was a decision someone made.
  if (base === "" || base === main) {
    return { kind: "abandoned", reason: `it targeted \`${main}\` directly` };
  }

  if (baseMerged === true) {
    return { kind: "stacked", reason: `its base branch \`${base}\` was merged` };
  }
  if (baseBranchExists === false) {
    return { kind: "stacked", reason: `its base branch \`${base}\` no longer exists` };
  }
  if (baseBranchExists === null && baseMerged === null) {
    return { kind: "stacked", reason: `its base branch \`${base}\` could not be checked` };
  }

  // Base branch is alive and unmerged — nothing took this PR down but a person.
  return { kind: "abandoned", reason: `its base branch \`${base}\` is still open` };
}

/**
 * The comment to post for a non-merged closure.
 *
 * INVARIANT: never tells anyone to reopen, and always states that no status
 * changed. The previous wording ("Marking X as still open — please reopen")
 * was read as an instruction by an agent and cost a wrong dispatch.
 *
 * @param {{kind:string, key:string, reason?:string, headRef?:string, defaultBranch?:string}} args
 * @returns {string}
 */
export function buildComment({ kind, key, reason = "", headRef = "", defaultBranch = "main" }) {
  const branch = headRef ? `\`${headRef}\`` : "the branch";
  if (kind === "stacked") {
    return [
      `This PR closed automatically because ${reason} — it was **stacked** on another PR,` +
        ` not abandoned. **No status was changed on ${key}.**`,
      ``,
      `Before acting on this, check whether the work is already on \`${defaultBranch}\`.` +
        ` When a parent PR is sent back in review it often absorbs its follow-up's scope,` +
        ` which leaves the child branch holding commits whose CONTENT already shipped.` +
        ` Re-landing that is worse than doing nothing: it re-applies stale code on top of` +
        ` the conflict resolutions that came with the parent.`,
      ``,
      `- Scope already on \`${defaultBranch}\` → cancel **${key}** as superseded and delete ${branch}.`,
      `- Scope missing from \`${defaultBranch}\` → rebase ${branch} onto \`${defaultBranch}\`,` +
        ` open a fresh PR targeting \`${defaultBranch}\`, and carry the existing review verdict.`,
    ].join("\n");
  }
  return [
    `This PR was closed without merging — ${reason || "no automated cause found"}.` +
      ` **No status was changed on ${key}.**`,
    ``,
    `A person decided this. Confirm whether the work is still wanted, then either open a` +
      ` fresh PR or cancel the issue.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// I/O below this line. Everything above is pure and tested.
// ---------------------------------------------------------------------------

const log = (...a) => console.log(...a);
const warn = (...a) => console.log("WARN:", ...a);

async function gh(path, { token, apiBase }) {
  const resp = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  return resp;
}

/**
 * Did the branch this PR targeted get merged, and does it still exist?
 *
 * Both answers are best-effort: a failed lookup returns `null` so
 * `classifyClosure` can tell "no" from "don't know".
 */
async function probeBaseBranch({ owner, repo, baseRef, token, apiBase }) {
  let baseBranchExists = null;
  let baseMerged = null;

  try {
    const resp = await gh(
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(baseRef)}`,
      { token, apiBase },
    );
    if (resp.status === 200) baseBranchExists = true;
    else if (resp.status === 404) baseBranchExists = false;
    else warn(`branch probe returned HTTP ${resp.status}`);
  } catch (e) {
    warn(`branch probe failed: ${e.message}`);
  }

  try {
    const resp = await gh(
      `/repos/${owner}/${repo}/pulls?state=closed&per_page=20&head=${encodeURIComponent(`${owner}:${baseRef}`)}`,
      { token, apiBase },
    );
    if (resp.ok) {
      const prs = await resp.json();
      baseMerged = Array.isArray(prs) && prs.some((p) => p?.merged_at);
    } else {
      warn(`base-PR probe returned HTTP ${resp.status}`);
    }
  } catch (e) {
    warn(`base-PR probe failed: ${e.message}`);
  }

  return { baseBranchExists, baseMerged };
}

async function commentOnPr({ owner, repo, number, token, apiBase, content }) {
  // GitHub, not Multica — kept local (warn-and-continue, different headers).
  const resp = await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: content }),
  });
  if (resp.ok) log(`Posted comment to PR #${number}.`);
  else warn(`GitHub comment failed (HTTP ${resp.status}): ${await resp.text()}`);
}

export async function run({
  event,
  dryRun = false,
  ghToken = "",
  multicaToken = "",
  workspace = DEFAULT_WORKSPACE,
  multicaApi: apiBase = DEFAULT_API_BASE,
  ghApi = "https://api.github.com",
  fetchImpl = fetch,
} = {}) {
  const pr = event?.pull_request;
  if (!pr) throw new Error("payload has no pull_request — wrong trigger?");

  const owner = event.repository?.owner?.login;
  const repo = event.repository?.name;
  const defaultBranch = event.repository?.default_branch || "main";

  const key = extractIssueKey({ title: pr.title, headRef: pr.head?.ref });
  if (!key) {
    log("No issue key in PR title or branch — nothing to do.");
    return 0;
  }

  const baseRef = pr.base?.ref ?? "";
  let probe = { baseBranchExists: null, baseMerged: null };
  if (pr.merged !== true && baseRef && baseRef !== defaultBranch && ghToken) {
    probe = await probeBaseBranch({ owner, repo, baseRef, token: ghToken, apiBase: ghApi });
  }

  const { kind, reason } = classifyClosure({
    merged: pr.merged,
    baseRef,
    defaultBranch,
    ...probe,
  });
  log(`${key}: PR #${pr.number} → ${kind} (${reason})`);

  if (!multicaToken) {
    warn("MULTICA_TOKEN is not set — skipping every Multica call.");
  }

  let writeFailed = false;

  if (kind === "merged") {
    if (dryRun || !multicaToken) return 0;
    try {
      await api(
        apiBase,
        multicaToken,
        `/issues/${key}?workspace_id=${workspace}`,
        { method: "PUT", body: JSON.stringify({ status: "done" }) },
        fetchImpl,
      );
      log(`Set ${key} to done.`);
    } catch (e) {
      // The exact bug BET-504 exists to surface: a silent status-write failure.
      console.error(`Failed to set ${key} done (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
      writeFailed = true;
    }
    return writeFailed ? 1 : 0;
  }

  const content = buildComment({ kind, key, reason, headRef: pr.head?.ref ?? "", defaultBranch });
  if (dryRun) {
    log("--- comment (dry run) ---");
    log(content);
    return 0;
  }
  if (multicaToken) {
    try {
      await api(
        apiBase,
        multicaToken,
        `/issues/${key}/comments?workspace_id=${workspace}`,
        { method: "POST", body: JSON.stringify({ workspace_id: workspace, content }) },
        fetchImpl,
      );
      log(`Posted comment to ${key}.`);
    } catch (e) {
      console.error(`Failed to comment on ${key} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
      writeFailed = true;
    }
  }
  if (ghToken) {
    await commentOnPr({
      owner,
      repo,
      number: pr.number,
      token: ghToken,
      apiBase: ghApi,
      content,
    });
  }
  return writeFailed ? 1 : 0;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("GITHUB_EVENT_PATH is not set — nothing to react to.");
    process.exit(1);
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const code = await run({
    event,
    dryRun,
    ghToken: process.env.GITHUB_TOKEN || "",
    multicaToken: process.env.MULTICA_TOKEN || "",
    workspace: process.env.MULTICA_WORKSPACE_ID,
    multicaApi: process.env.MULTICA_API_BASE,
    ghApi: process.env.GITHUB_API_URL,
  });
  if (code) process.exit(code);
}

// Only run when invoked directly, so the pure exports stay importable in tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
