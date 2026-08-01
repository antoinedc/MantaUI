#!/usr/bin/env node
/**
 * Multica: clear stale `blocked` statuses whose blockers have finished.
 *
 * WHY THIS EXISTS
 * ---------------
 * When the PM agent blocks an issue it writes a free-text `metadata.waiting_on`
 * note naming the blockers, e.g.
 *
 *   "BET-294 (site.css extraction, in_progress) and BET-295 (deploy
 *    verify-glob, in_progress). Both must merge before this can start."
 *
 * That note is a SNAPSHOT taken once. Nothing re-reads it when the blockers
 * finish, so an issue stays `blocked` forever after its dependencies are done.
 * Observed live: BET-297 sat `blocked` with a note calling BET-294 and BET-295
 * "in_progress" long after both had merged and gone `done`. The whole website
 * epic stalled and only moved because a human noticed nothing was happening.
 *
 * This script closes that loop: for every `blocked` issue, resolve the BET keys
 * named in `waiting_on`, and if ALL of them are terminal (`done`/`cancelled`),
 * flip the issue to `todo`.
 *
 * SCOPE — deliberately conservative
 *   - Only ever moves `blocked` → `todo`. It never blocks, closes, reassigns or
 *     reprioritises anything.
 *   - An issue with no `waiting_on`, or whose note names no BET key, is LEFT
 *     ALONE. We cannot know why a human blocked it, so we do not guess.
 *   - A blocker key that cannot be fetched is treated as NOT done, so a
 *     transient API error can never cause a spurious unblock.
 *
 * `metadata` is not writable through the public issues API (a PUT containing it
 * returns 200 and silently discards it — verified 2026-07-26), so the stale
 * `waiting_on` text remains after unblocking. That is cosmetic: `status` is
 * what the agents dispatch on.
 *
 * USAGE
 *   MULTICA_TOKEN=… node scripts/multica-unblock.mjs [--dry-run] [--verbose]
 *
 * ENV
 *   MULTICA_TOKEN         required — same secret the close-on-merge workflow uses
 *   MULTICA_WORKSPACE_ID  optional — defaults to the MantaUI (BET) workspace
 *   MULTICA_API_BASE      optional — defaults to https://api.multica.ai
 *
 * Exit code is 0 unless the run could not complete (missing token, list call
 * failed). Individual update failures warn and do not fail the run — this is
 * housekeeping and must never break a deploy pipeline.
 */

import { api, DEFAULT_WORKSPACE, DEFAULT_API_BASE } from "./lib/multicaApi.mjs";

/** Statuses that mean a blocker is finished and no longer blocking. */
export const TERMINAL_STATUSES = new Set(["done", "cancelled", "canceled"]);

/**
 * Extract issue keys (BET-123) named in a free-text waiting_on note.
 * Case-insensitive, de-duplicated, order preserved.
 *
 * @param {string|null|undefined} waitingOn
 * @returns {string[]}
 */
export function parseBlockerKeys(waitingOn) {
  if (typeof waitingOn !== "string") return [];
  const out = [];
  const seen = new Set();
  for (const m of waitingOn.matchAll(/\b([A-Z]{2,10})-(\d+)\b/gi)) {
    const key = `${m[1].toUpperCase()}-${m[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Decide whether one blocked issue should be unblocked.
 *
 * @param {{identifier:string, status:string, metadata?:{waiting_on?:string}}} issue
 * @param {Map<string,string|null>} statusByKey resolved blocker statuses;
 *        a missing/null entry means "could not resolve" and blocks the unblock.
 * @returns {{unblock:boolean, reason:string, blockers:string[]}}
 */
export function decideUnblock(issue, statusByKey) {
  if (issue?.status !== "blocked") {
    return { unblock: false, reason: "not blocked", blockers: [] };
  }
  // Drop self-references. The notes routinely name the issue itself, e.g.
  // BET-300's note reads "…BET-299 (…). BET-300 cannot start until…". Left in,
  // the issue would be waiting on its own blocked self and could never clear.
  const self = issue?.identifier?.toUpperCase();
  const blockers = parseBlockerKeys(issue?.metadata?.waiting_on).filter(
    (k) => k !== self,
  );
  if (blockers.length === 0) {
    // No machine-readable dependency. A human may have blocked this for a
    // reason we cannot see — never guess.
    return { unblock: false, reason: "no blocker keys in waiting_on", blockers };
  }
  const unfinished = blockers.filter((k) => {
    const s = statusByKey.get(k);
    return !(typeof s === "string" && TERMINAL_STATUSES.has(s));
  });
  if (unfinished.length > 0) {
    return {
      unblock: false,
      reason: `waiting on ${unfinished.join(", ")}`,
      blockers,
    };
  }
  return { unblock: true, reason: `all of ${blockers.join(", ")} done`, blockers };
}

/* ------------------------------------------------------------------ *
 * IO below this line. Everything above is pure and unit-tested.
 * ------------------------------------------------------------------ */

export async function run({
  token,
  workspace = DEFAULT_WORKSPACE,
  base = DEFAULT_API_BASE,
  dryRun = false,
  verbose = false,
  fetchImpl = fetch,
} = {}) {
  if (!token) {
    console.error("MULTICA_TOKEN is not set — nothing to do.");
    return 1;
  }

  const listed = await api(
    base,
    token,
    `/issues?workspace_id=${workspace}&status=blocked&limit=200`,
    {},
    fetchImpl,
  );
  const blocked = listed.issues ?? [];
  if (blocked.length === 0) {
    console.log("No blocked issues. Nothing to reconcile.");
    return 0;
  }

  // Resolve every referenced blocker once. A single unresolvable blocker is a
  // READ: warn and keep sweeping — it must never abort the batch.
  const statusByKey = new Map();
  const needed = new Set(blocked.flatMap((i) => parseBlockerKeys(i?.metadata?.waiting_on)));
  for (const key of needed) {
    try {
      const issue = await api(base, token, `/issues/${key}?workspace_id=${workspace}`, {}, fetchImpl);
      statusByKey.set(key, issue?.status ?? null);
    } catch (e) {
      // Unresolvable → treated as still blocking. Never unblock on an error.
      statusByKey.set(key, null);
      if (verbose) console.log(`  ! could not resolve ${key}: ${e.message}`);
    }
  }

  let unblocked = 0;
  let writeFailed = false;
  for (const issue of blocked) {
    const { unblock, reason } = decideUnblock(issue, statusByKey);
    const id = issue.identifier;
    if (!unblock) {
      if (verbose) console.log(`  · ${id} stays blocked (${reason})`);
      continue;
    }
    if (dryRun) {
      console.log(`  → ${id} WOULD unblock (${reason})`);
      unblocked++;
      continue;
    }
    try {
      await api(
        base,
        token,
        `/issues/${id}?workspace_id=${workspace}`,
        { method: "PUT", body: JSON.stringify({ status: "todo" }) },
        fetchImpl,
      );
      console.log(`  → ${id} unblocked (${reason})`);
      unblocked++;
    } catch (e) {
      // A failed WRITE is fatal to the job. Log the key + status + body, keep
      // sweeping the rest of the batch, and exit non-zero at the end.
      console.error(`Failed to set ${id} todo (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
      writeFailed = true;
    }
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}${unblocked} of ${blocked.length} blocked issue(s) ${dryRun ? "would be" : ""} unblocked.`,
  );
  return writeFailed ? 1 : 0;
}

async function main() {
  const code = await run({
    token: process.env.MULTICA_TOKEN,
    workspace: process.env.MULTICA_WORKSPACE_ID,
    base: process.env.MULTICA_API_BASE,
    dryRun: process.argv.includes("--dry-run"),
    verbose: process.argv.includes("--verbose"),
  });
  if (code) process.exit(code);
}

// Only run when invoked directly, so the pure exports stay importable in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`multica-unblock failed: ${e.message}`);
    process.exit(1);
  });
}
