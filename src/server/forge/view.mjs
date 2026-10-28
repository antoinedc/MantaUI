// view.mjs — the box-side "view" of the forge surface (WS05, D23/D24).
//
// The box owns every rule the pull-request panel, the checks chip, the merge
// gate, the error copy and the work-inbox rows depend on; the desktop and the
// iOS app only render what this module returns. Everything here is pure (the
// one cache is injectable) so it is unit-tested without a forge.
//
// The logic moved here from src/renderer/chatUtils.ts, SessionHeader.tsx and
// InboxPalette.tsx verbatim (then was deleted there). Do not re-derive any of
// it in a client.

import { LRUCache } from "lru-cache";

// ---- Checks (G6, G7) --------------------------------------------------------

/** One check's traffic-light state — THE single classifier. A check with no
 * conclusion yet (queued / in progress / pending) is "running"; anything that
 * finished on something other than success is "error". */
export function checkTone(check) {
  const done = check?.conclusion;
  if (!done || check?.status === "queued" || check?.status === "in_progress") return "running";
  return done === "success" ? "ok" : "error";
}

/** Failed, then running, then passed. `sort` is stable, so the forge's own
 * order survives inside a bucket. Each returned check carries its `tone`. */
export function orderChecks(checks) {
  const rank = { error: 0, running: 1, ok: 2 };
  return (Array.isArray(checks) ? checks : [])
    .map((c) => ({ ...c, tone: checkTone(c) }))
    .sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** The shape index.mjs imports: ordered failed → running → passed, each with `tone`. */
export const tonedChecks = orderChecks;

export function countChecks(checks) {
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const c of Array.isArray(checks) ? checks : []) {
    const tone = checkTone(c);
    if (tone === "running") running++;
    else if (tone === "ok") passed++;
    else failed++;
  }
  return { passed, failed, running };
}

/** The checks chip for a rollup. `none` (or an unknown rollup) yields null — no
 * chip at all. Glyph + label, never colour alone. */
export function checksChip(rollup, counts) {
  switch (rollup) {
    case "green":
      return { glyph: "✓", label: `✓ ${counts.passed}`, tone: "ok" };
    case "red":
      return { glyph: "✗", label: `✗ ${counts.failed} failed`, tone: "danger" };
    case "yellow":
      return { glyph: "◐", label: `◐ ${counts.running} running`, tone: "warn" };
    default:
      return null;
  }
}

/** The "send failures to the agent" text. Names each failing check (plus its
 * log URL) so the agent can act without the user transcribing. `null` when
 * nothing failed. */
export function failuresPrompt(checks) {
  const failed = (Array.isArray(checks) ? checks : []).filter((c) => checkTone(c) === "error");
  if (failed.length === 0) return null;
  const lines = failed.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`);
  return `Checks are failing on this pull request:\n${lines.join("\n")}\n\nPlease investigate and fix them.`;
}

/** Where "Open logs" goes: the first failing check with a URL, else any check
 * URL, else the PR URL. */
export function logsUrl(checks, prUrl) {
  const list = Array.isArray(checks) ? checks : [];
  return (
    list.find((c) => checkTone(c) === "error" && c.url)?.url ??
    list.find((c) => c.url)?.url ??
    (prUrl || null)
  );
}

// ---- Panel / ship state (G1) ------------------------------------------------

/** How the branch chip renders and whether it is interactive. `"none"` — no
 * recognised/connected forge or no forge branch; `"no-pr"` / `"pr"` — the
 * popover/sheet opens. */
export function panelState({ error, branch, pr }) {
  if (error != null) return "none";
  if (!branch) return "none";
  return pr ? "pr" : "no-pr";
}

const NO_SHIP_COPY = {
  "on-base": "On the base branch — nothing to ship.",
  detached: "Detached HEAD — nothing to ship.",
  unknown: "Base branch unknown — nothing to ship.",
};

/** The ship gate, first match wins: has-pr, detached, unknown, on-base,
 * no-commits, ready. `aheadCount: null` (unknown) still falls through to
 * `ready` — the count is an optimisation, not a safety fact. */
export function shipState({ branch, base, aheadCount, hasPr }) {
  let state;
  if (hasPr) state = "has-pr";
  else if (!branch) state = "detached";
  else if (!base) state = "unknown";
  else if (branch === base) state = "on-base";
  else if (aheadCount === 0) state = "no-commits";
  else state = "ready";
  let copy = NO_SHIP_COPY[state] ?? null;
  if (state === "no-commits") copy = `Nothing to ship — no commits ahead of ${base}`;
  return { state, copy };
}

// ---- Merge gate (G2, G3) ----------------------------------------------------

/** Whether merge is enabled, with a user-visible reason when it is not. Only
 * when the rollup is green, there are no unresolved threads and the forge says
 * mergeable === true. `mergeable: null` = still computing. */
export function canMerge({ rollup, unresolvedThreads, mergeable }) {
  if (mergeable === null || mergeable === undefined) return { can: false, reason: "still computing" };
  if (mergeable !== true) return { can: false, reason: "not mergeable" };
  if (rollup !== "green") {
    const reason = rollup === "yellow" ? "checks still running" : rollup === "red" ? "checks failing" : "no checks";
    return { can: false, reason };
  }
  const n = Number(unresolvedThreads) || 0;
  if (n > 0) return { can: false, reason: `${n} unresolved thread${n === 1 ? "" : "s"}` };
  return { can: true, reason: null };
}

/** The "Mergeable" row text + tone: the forge's own blocked reason in danger,
 * else "mergeable" (ok), else "computing…" (muted). */
export function mergeableDisplay(pr) {
  if (pr?.mergeBlockedReason) return { text: pr.mergeBlockedReason, tone: "danger" };
  if (pr?.mergeable === true) return { text: "mergeable", tone: "ok" };
  return { text: "computing…", tone: "muted" };
}

/** User-facing message for a merge failure, keyed by its distinguished kind.
 * `reason` is only used by `blocked` (the gate's own reason). */
export function mergeFailureMessage(kind, reason = null) {
  switch (kind) {
    case "sha_mismatch":
      return "Merge failed — the head SHA moved. This PR changed after you reviewed it; re-review before merging.";
    case "cannot_merge":
      return "Cannot merge — the PR is blocked (branch protection, draft, or a conflict).";
    case "permission":
      return "No permission to merge this pull request.";
    case "blocked":
      return reason ? `Can't merge yet: ${reason}` : "Can't merge yet.";
    default:
      return kind ? `Merge failed (${kind}).` : "Merge failed.";
  }
}

// ---- Error copy (G4, G11) ---------------------------------------------------

/** Plain-word message for a ship / ship-preview failure. */
export function shipErrorMessage(raw) {
  const error = String(raw ?? "");
  switch (error) {
    case "no_forge":
      return "This folder isn't linked to a GitHub repository.";
    case "not_connected":
      return "GitHub isn't connected on this server.";
    case "no_branch":
      return "Detached HEAD — check out a branch first.";
    case "unknown_base":
      return "Couldn't tell which branch to target.";
    default:
  }
  if (error.startsWith("push failed:")) return `Couldn't push the branch: ${error.slice("push failed:".length).trim()}`;
  if (error.startsWith("create pull request failed:")) {
    return `GitHub refused the pull request: ${error.slice("create pull request failed:".length).trim()}`;
  }
  return error;
}

/** Plain-word message for a review failure. `op` is one of "diff", "draft-get",
 * "draft-comment", "draft-submit", "thread-reply". */
export function reviewErrorMessage(op, error, kind = null) {
  const err = String(error ?? "");
  switch (err) {
    case "no_pr":
      return "No pull request on this session's branch.";
    case "not_connected":
      return "No forge connection to this repository.";
    case "no_forge":
      return "No linked forge repository.";
    default:
  }
  if (op === "draft-comment") {
    if (err === "comment body is required") return "Write a comment first.";
    if (err === "invalid comment anchor") return "That line can't take a comment.";
    if (err === "comment not found") return "That comment was already removed.";
  }
  if (op === "thread-reply") {
    if (err === "empty reply") return "Write a reply first.";
    if (err === "missing threadId") return "That thread is no longer available.";
    return `GitHub didn't accept the reply: ${err}`;
  }
  if (op === "draft-submit") {
    if (err === "nothing to submit") return "Add at least one line comment before submitting.";
    if (kind === "http_422") {
      return "GitHub rejected the review — a comment may point at a line that's no longer in the pull request. Your comments are kept.";
    }
    return `Couldn't submit — your comments are kept. (${err})`;
  }
  return err;
}

// ---- Pull-request view (G1, G2, G6, G7) -------------------------------------

/** Compose the `view` field `forge:pull-request` returns. */
export function pullRequestView(result) {
  const pr = result?.pr ?? null;
  const branch = result?.branch ?? null;
  const base = result?.base ?? null;
  const rollup = result?.rollup ?? "none";
  const checks = Array.isArray(result?.checks) ? result.checks : [];

  const panel = panelState({ error: result?.error ?? null, branch, pr });
  const chipLabel = panel === "none" ? null : pr ? `${branch} · #${pr.number}` : branch;
  const ship = shipState({ branch, base, aheadCount: result?.aheadCount ?? null, hasPr: Boolean(pr) });

  let merge = null;
  if (pr) {
    const gate = canMerge({ rollup, unresolvedThreads: pr.unresolvedThreads, mergeable: pr.mergeable });
    merge = { can: gate.can, reason: gate.reason, mergeable: mergeableDisplay(pr) };
  }

  const counts = countChecks(checks);
  const chip = pr && checks.length > 0 ? checksChip(rollup, counts) : null;
  return {
    panel,
    chipLabel,
    ship,
    merge,
    checks: {
      counts,
      chip,
      failuresPrompt: failuresPrompt(checks),
      logsUrl: logsUrl(checks, pr?.url),
    },
  };
}

// ---- Last-PR cache (G5) -----------------------------------------------------

/** A bounded LRU of the last PR read per (cwd, branch), memory only. A
 * rate-limited read serves this flagged `stale: true` instead of flipping the
 * panel to "Create pull request". Storage is `lru-cache`; no TTL — an entry is
 * only ever served flagged stale. */
export function createLastPrCache({ max = 64 } = {}) {
  const lru = new LRUCache({ max });
  const key = (cwd, branch) => `${cwd}\0${branch}`;
  return {
    get: (cwd, branch) => lru.get(key(cwd, branch)),
    set: (cwd, branch, entry) => {
      lru.set(key(cwd, branch), entry);
    },
    drop: (cwd, branch) => {
      lru.delete(key(cwd, branch));
    },
    get size() {
      return lru.size;
    },
  };
}

// ---- Work inbox rows (G13) --------------------------------------------------

const REASON_LABEL = {
  "checks failing": "checks red",
  "review requested": "review requested",
  assigned: "issue · assigned to you",
};
const REASON_TONE = {
  "checks failing": "danger",
  "review requested": "warn",
  assigned: "muted",
};

function branchNameFor(item) {
  const slug = String(item?.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `manta/${item.kind}-${item.number}${slug ? `-${slug}` : ""}`;
}

/** The row fields the inbox renders. `localPaths` maps repoKey → the probed
 * local checkout (a plain object or a Map). */
export function inboxRowView(item, localPaths = {}) {
  const parts = String(item?.repoKey ?? "").split("/");
  const repoName = parts[parts.length - 1] || String(item?.repoKey ?? "");
  const label = REASON_LABEL[item?.reason] ?? String(item?.reason ?? "");
  const localPath = localPaths instanceof Map ? localPaths.get(item.repoKey) : localPaths?.[item?.repoKey];
  return {
    label,
    identifier: `${item?.kind === "pr" ? "!" : "#"}${item?.number}`,
    secondary: item?.kind === "pr" ? `${label} · ${repoName}` : label,
    repoName,
    tone: REASON_TONE[item?.reason] ?? "muted",
    branchName: branchNameFor(item),
    localPath: localPath || null,
  };
}
