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
 * OWNERSHIP ON RELEASE — the `next_owner` key
 * -------------------------------------------
 * Assigning an issue DISPATCHES A RUN immediately, whatever its status. That
 * made "who owns this next" and "start now" the same act, so a PM sequencing an
 * epic could only start an agent too early or leave the issue owned by nobody —
 * and an unassigned `todo` is invisible to BOTH sweeps (this one only writes
 * `status`; unstick skips anything not agent-assigned). BET-556..559 sat silent
 * that way while the iOS epic stalled.
 *
 * So a blocked issue may also carry `next_owner` (an agent name). This sweep
 * assigns it at the moment the blockers clear — the one moment when
 * dispatch-on-assign is the correct behaviour:
 *
 *   status: blocked
 *   waiting_on: "BET-555 (S3a) must be done — …"
 *   next_owner: "macos"
 *
 * An issue with no `next_owner` behaves exactly as before (status only), so
 * nothing that predates the key changes behaviour.
 *
 * FOOTGUN — `waiting_on` is machine-read, so cite ONLY real blockers
 * -----------------------------------------------------------------
 * EVERY issue key in `waiting_on` is treated as a blocker. Citing a parent epic
 * for context ("… per BET-550 stage order") therefore deadlocks the issue
 * permanently: the epic cannot go `done` until its children do, and the child
 * now waits on the epic. Self-references are dropped for exactly this reason,
 * but a parent's key is indistinguishable from a blocker's. Put stage ordering
 * and rationale in the DESCRIPTION; keep `waiting_on` to the keys that must
 * actually finish first. (Caught by `--dry-run` on 2026-08-02, which reported
 * `waiting on BET-558, BET-550` for BET-559 — always dry-run after editing a
 * note.)
 *
 * The same sweep also runs a second, opt-in pass (BET-506): for every `done`
 * issue carrying BOTH `deliverable_branch` and `deliverable_paths` metadata, it
 * verifies the declared file(s) actually exist on that branch (via git against
 * this checkout). A `done` issue whose deliverable never landed — the artefact
 * left on an orphan branch the issue never named — is set to `in_review` with
 * `deliverable_missing` + `deliverable_checked` recorded. Issues without the
 * declaration are never touched.
 *
 * SCOPE — deliberately conservative
 *   - Only ever moves `blocked` → `todo`, and only ever assigns the agent the
 *     issue itself named in `next_owner`. It never blocks, closes, reprioritises
 *     anything, and never picks an owner of its own accord.
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

import { execFileSync } from "node:child_process";
import { api, DEFAULT_WORKSPACE, DEFAULT_API_BASE } from "./lib/multicaApi.mjs";

/** Statuses that mean a blocker is finished and no longer blocking. */
export const TERMINAL_STATUSES = new Set(["done", "cancelled", "canceled"]);

/**
 * Split a `deliverable_paths` metadata value into its paths.
 *
 * The value is newline-separated (the declaration format agreed in BET-506).
 * Whitespace is trimmed and empty lines dropped so a trailing newline cannot
 * quietly turn into a phantom path that never exists.
 *
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
export function parseDeliverablePaths(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Decide whether a `done` issue's declared deliverable is actually on its
 * branch, and what (if anything) to do about it.
 *
 * Opt-in: an issue is only ever checked when BOTH `deliverable_branch` and
 * `deliverable_paths` metadata keys are set. An incomplete declaration (only
 * one key) must never trip the check, and issues not `done` are never touched.
 *
 * `existingPaths` is the set of declared deliverable paths that exist on the
 * branch, as resolved by the git check; `null` means the branch itself could
 * not be found on the remote. Existence is the entire check — no contents, no
 * size, no authorship.
 *
 * @param {{identifier?:string, status?:string, metadata?:{deliverable_branch?:string, deliverable_paths?:string}}} issue
 * @param {Set<string>|null} existingPaths
 * @returns {{act:false, reason:string} |
 *           {act:true, status:"in_review", missing:string[], reason:string}}
 */
export function decideDeliverable(issue, existingPaths) {
  const meta = issue?.metadata ?? {};
  const branch = meta?.deliverable_branch;
  const hasBranch = typeof branch === "string" && branch.trim() !== "";
  const declared = parseDeliverablePaths(meta?.deliverable_paths);
  const hasPaths = declared.length > 0;

  // An incomplete or absent declaration is not a deliverable issue. Never trip
  // the check on it.
  if (!hasBranch || !hasPaths) {
    return { act: false, reason: "no complete deliverable declaration" };
  }
  if (issue?.status !== "done") {
    return { act: false, reason: "not done" };
  }

  // Branch missing on the remote is a failed check, not a skip.
  if (existingPaths == null) {
    return {
      act: true,
      status: "in_review",
      missing: ["branch not found"],
      reason: `deliverable branch \`${branch}\` not found on remote`,
    };
  }

  const missing = declared.filter((p) => !existingPaths.has(p));
  if (missing.length === 0) {
    return { act: false, reason: `all deliverables present on \`${branch}\`` };
  }
  return {
    act: true,
    status: "in_review",
    missing,
    reason: `missing on \`${branch}\`: ${missing.join(", ")}`,
  };
}

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

/**
 * Resolve the agent that should OWN an issue the moment it is unblocked.
 *
 * WHY THIS EXISTS
 * ---------------
 * Assigning an issue DISPATCHES A RUN immediately, whatever its status —
 * verified live 2026-08-02 by assigning a `blocked` issue and watching an agent
 * start on it seconds later. So "who owns this next" and "start now" were the
 * same act, and a PM sequencing an epic had only two bad options:
 *
 *   - assign the next child anyway → an agent starts work whose prerequisite
 *     does not exist yet;
 *   - leave it unassigned (or park it on a human) → NOTHING ever starts it.
 *     `multica-unblock` only ever writes `status`, and `multica-unstick` skips
 *     anything not agent-assigned, so an unassigned `todo` is invisible to both
 *     sweeps. This is exactly how BET-556..559 sat silent while the iOS epic
 *     stalled: correctly labelled, owned by nobody, seen by nothing.
 *
 * `next_owner` splits the two apart. The PM records the intended owner as
 * metadata and does NOT assign; this sweep assigns it at the moment the
 * blockers clear — which is precisely when dispatch-on-assign is the correct
 * behaviour. Assignment recovers its single honest meaning: start now.
 *
 * An unresolvable name deliberately does NOT unblock. A typo'd or renamed agent
 * is a declaration error, and releasing it anyway would produce the exact
 * silent stall this key exists to prevent — an unassigned `todo` no sweep will
 * ever look at again, since it has left the `blocked` list for good. Staying
 * blocked keeps it in scope, so a corrected `next_owner` (or a restored agent
 * name) is picked up on the next tick, and it stays visibly blocked on the
 * board instead of masquerading as ready work nobody has taken.
 *
 * @param {{metadata?:{next_owner?:string}}} issue
 * @param {Map<string,string>} agentIdByName lower-cased agent name → agent id
 * @returns {{assign:false, reason:string} |
 *           {assign:false, unresolved:string, reason:string} |
 *           {assign:true, id:string, name:string, reason:string}}
 */
export function resolveNextOwner(issue, agentIdByName) {
  const raw = issue?.metadata?.next_owner;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { assign: false, reason: "no next_owner declared" };
  }
  const name = raw.trim();
  const id = agentIdByName?.get?.(name.toLowerCase());
  if (!id) {
    return {
      assign: false,
      unresolved: name,
      reason: `next_owner \`${name}\` is not an agent in this workspace`,
    };
  }
  return { assign: true, id, name, reason: `next_owner \`${name}\`` };
}

/* ------------------------------------------------------------------ *
 * IO below this line. Everything above is pure and unit-tested.
 * ------------------------------------------------------------------ */

/**
 * Resolve which of the declared paths exist on a branch, using the git CLI
 * against the already-checked-out repository the sweep runs in.
 *
 * Returns `null` when the branch itself cannot be resolved on the remote (the
 * failed-check case), otherwise a Set of the declared paths present on it.
 * Nothing is checked out and nothing is cloned — reading the remote tree is
 * enough and leaves the working copy untouched.
 *
 * @param {{branch:string, paths:string[]}} args
 * @returns {Promise<Set<string>|null>}
 */
export async function resolveDeliverablePaths({ branch, paths }) {
  const ref = `refs/remotes/origin/${branch}`;
  try {
    // Fetch only the branch; failure means it does not exist on the remote.
    execFileSync("git", ["fetch", "origin", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: process.cwd(),
    });
    // Verify the fetched ref resolves.
    execFileSync("git", ["rev-parse", "--verify", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: process.cwd(),
    });
  } catch {
    return null;
  }

  const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    cwd: process.cwd(),
  });
  const present = new Set(tree.split("\n").filter(Boolean));
  return new Set(paths.filter((p) => present.has(p)));
}

export async function run({
  token,
  workspace = DEFAULT_WORKSPACE,
  base = DEFAULT_API_BASE,
  dryRun = false,
  verbose = false,
  fetchImpl = fetch,
  resolveDeliverable = resolveDeliverablePaths,
} = {}) {
  if (!token) {
    console.error("MULTICA_TOKEN is not set — nothing to do.");
    return 1;
  }

  let writeFailed = false;

  // --- Pass 1: clear stale `blocked` statuses ------------------------------
  const listed = await api(
    base,
    token,
    `/issues?workspace_id=${workspace}&status=blocked&limit=200`,
    {},
    fetchImpl,
  );
  const blocked = listed.issues ?? [];
  if (blocked.length > 0) {
    // Agent names → ids, resolved live so a renamed or newly added agent needs
    // no code change (same approach as multica-unstick). Only fetched when
    // something is actually blocked, and only used for `next_owner`.
    const agentIdByName = new Map();
    try {
      const agents = await api(base, token, `/agents?workspace_id=${workspace}`, {}, fetchImpl);
      for (const a of Array.isArray(agents) ? agents : (agents.agents ?? [])) {
        if (a?.name && a?.id) agentIdByName.set(String(a.name).toLowerCase(), a.id);
      }
    } catch (e) {
      // A failed agent list must not unblock anything into an unowned `todo`,
      // so every next_owner simply fails to resolve and its issue stays blocked.
      console.log(`::warning::could not list agents (${e.message}) — next_owner assignment is unavailable this tick`);
    }

    // Resolve every referenced blocker once. Unresolvable = READ, warn + continue.
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
    for (const issue of blocked) {
      const { unblock, reason } = decideUnblock(issue, statusByKey);
      const id = issue.identifier;
      if (!unblock) {
        if (verbose) console.log(`  · ${id} stays blocked (${reason})`);
        continue;
      }

      // An issue that names an owner we cannot resolve stays blocked — see
      // resolveNextOwner. Releasing it would strand it as an unassigned `todo`
      // that has left this sweep's scope and that unstick will not touch.
      const owner = resolveNextOwner(issue, agentIdByName);
      if (owner.unresolved) {
        console.log(`::warning::${id} stays blocked — ${owner.reason}`);
        continue;
      }
      const handoff = owner.assign ? `, hand to ${owner.name}` : "";

      if (dryRun) {
        console.log(`  → ${id} WOULD unblock (${reason}${handoff})`);
        unblocked++;
        continue;
      }
      try {
        // Status first: if the assignment then fails we have an unowned `todo`
        // and a red job, not an agent already running on a `blocked` issue.
        await api(
          base,
          token,
          `/issues/${id}?workspace_id=${workspace}`,
          { method: "PUT", body: JSON.stringify({ status: "todo" }) },
          fetchImpl,
        );
        if (owner.assign) {
          // This is the dispatch. Assignment starts a run immediately, which is
          // exactly right here — the blockers are done and the work can start.
          await api(
            base,
            token,
            `/issues/${id}?workspace_id=${workspace}`,
            {
              method: "PUT",
              body: JSON.stringify({ assignee_id: owner.id, assignee_type: "agent" }),
            },
            fetchImpl,
          );
        }
        console.log(`  → ${id} unblocked (${reason}${handoff})`);
        unblocked++;
      } catch (e) {
        // Fail the job on a failed WRITE; keep sweeping the rest of the batch.
        console.error(`Failed to release ${id} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
        writeFailed = true;
      }
    }
    console.log(
      `${dryRun ? "[dry-run] " : ""}${unblocked} of ${blocked.length} blocked issue(s) ${dryRun ? "would be" : ""} unblocked.`,
    );
  } else {
    console.log("No blocked issues.");
  }

  // --- Pass 2: verify opt-in deliverable declarations on `done` issues ------
  let doneIssues = [];
  try {
    const done = await api(
      base,
      token,
      `/issues?workspace_id=${workspace}&status=done&limit=200`,
      {},
      fetchImpl,
    );
    doneIssues = done.issues ?? [];
  } catch (e) {
    // List read failure is a READ: warn and continue, never abort the sweep.
    console.log(`  ! could not list done issues, skipping deliverable check: ${e.message}`);
  }
  const withDeliverable = doneIssues.filter(
    (i) =>
      typeof i?.metadata?.deliverable_branch === "string" &&
      i.metadata.deliverable_branch.trim() !== "" &&
      parseDeliverablePaths(i.metadata.deliverable_paths).length > 0,
  );
  if (withDeliverable.length === 0) {
    console.log("No done issues with a deliverable declaration.");
  } else {
    let checked = 0;
    const nowIso = new Date().toISOString();
    for (const issue of withDeliverable) {
      const id = issue.identifier;
      const branch = issue.metadata.deliverable_branch.trim();
      const paths = parseDeliverablePaths(issue.metadata.deliverable_paths);
      let existing;
      try {
        existing = await resolveDeliverable({ branch, paths });
      } catch (e) {
        // A git failure is a READ problem: never act on an unverifiable issue.
        console.log(`  ! ${id} deliverable unverifiable, leaving alone: ${e.message}`);
        continue;
      }
      const decision = decideDeliverable(issue, existing);
      if (!decision.act) {
        if (verbose) console.log(`  · ${id} deliverable ok (${decision.reason})`);
        continue;
      }
      if (dryRun) {
        console.log(`  → ${id} WOULD flag deliverable missing (${decision.reason})`);
        checked++;
        continue;
      }
      try {
        await api(
          base,
          token,
          `/issues/${id}?workspace_id=${workspace}`,
          { method: "PUT", body: JSON.stringify({ status: decision.status }) },
          fetchImpl,
        );
      } catch (e) {
        console.error(`Failed to set ${id} ${decision.status} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
        writeFailed = true;
        continue;
      }
      const stamps = {
        deliverable_missing: decision.missing.join("\n"),
        deliverable_checked: nowIso,
      };
      for (const [key, value] of Object.entries(stamps)) {
        try {
          await api(
            base,
            token,
            `/issues/${issue.id}/metadata/${key}?workspace_id=${workspace}`,
            { method: "PUT", body: JSON.stringify({ value }) },
            fetchImpl,
          );
        } catch (e) {
          console.error(`Failed to write ${key} on ${id} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
          writeFailed = true;
        }
      }
      console.log(`  → ${id} marked ${decision.status}, deliverable missing (${decision.reason})`);
      checked++;
    }
    console.log(
      `${dryRun ? "[dry-run] " : ""}${checked} of ${withDeliverable.length} deliverable declaration(s) ${dryRun ? "would be" : ""} flagged.`,
    );
  }

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
