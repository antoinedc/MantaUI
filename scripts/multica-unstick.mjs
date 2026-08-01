#!/usr/bin/env node
/**
 * Multica: re-dispatch issues whose hand-off was dropped.
 *
 * WHY THIS EXISTS
 * ---------------
 * Multica agents are EVENT-triggered: a run starts when an issue is assigned to
 * them (or a comment arrives). Nothing is polling on their behalf. So when an
 * agent finishes a run but forgets the hand-off — leaves the issue assigned to
 * ITSELF instead of reassigning to whoever owes the next move — the issue sits
 * forever in a state that reads perfectly healthy ("in_review, assigned, work
 * done") while literally nothing will ever touch it again.
 *
 * Observed live (2026-07-27): BET-297's implementer finished at 00:30, pushed a
 * green PR, set the issue `in_review` — and left itself as assignee. No reviewer
 * run, no PM run, 7 hours dead. Five downstream issues sat `blocked` on it, so
 * the entire website epic stopped. `scripts/multica-unblock.mjs` correctly
 * refused to clear them: their blocker genuinely had not finished.
 *
 * The blocked-status sweep fixes the SYMPTOM (stale `blocked`). This fixes the
 * CAUSE (a dropped hand-off nobody re-fires). Together they close the loop:
 *
 *   multica-unblock  → blocked issue whose blockers are done  → todo
 *   multica-unstick  → live issue nobody will ever pick up    → reassigned
 *
 * WHAT COUNTS AS STUCK
 * --------------------
 * An agent-assigned `in_progress` / `in_review` issue is healthy only if
 * something will move it next. If its newest task-run is TERMINAL, no run is in
 * flight, and that has been true for longer than the grace period, then its next
 * transition was dropped and no event will ever fire it. That is the stall.
 *
 * WHO GETS IT NEXT (mirrors the MANTA pipeline dev → reviewer → pm)
 *   any role    + todo                     → re-run the assignee (never started)
 *   any role    + no runs at all           → re-run the assignee (dispatch lost)
 *   implementer + in_review                → reviewer  (forgot to hand off)
 *   implementer + in_progress + open PR    → reviewer  (pushed, never handed off)
 *   implementer + in_progress + no PR      → pm        (no-op run; PM triages)
 *   reviewer    + either                   → pm        (verdict never routed)
 *   pm          + either                   → rerun the PM (nothing downstream)
 *
 * SCOPE — deliberately conservative
 *   - Only ever reassigns or re-runs. It never changes status, closes, merges,
 *     comments on GitHub, or touches priorities.
 *   - Human-assigned and unassigned issues are LEFT ALONE. If a person owns it,
 *     a bot has no business paging an agent about it.
 *   - `blocked` is out of scope — `multica-unblock.mjs` owns that status. The
 *     two never act on the same issue: unblock changes status, unstick changes
 *     assignment, and their status sets are disjoint.
 *   - Anything with a run in flight is untouched, whatever its age. A long turn
 *     is not a stall.
 *   - Per-issue backoff (`metadata.unstick_last`) and a per-tick action cap stop
 *     a wedged issue from being re-paged every 15 minutes.
 *   - It records what it did in issue METADATA, never a comment: a comment on an
 *     agent-assigned issue dispatches a run of its own, so an audit comment
 *     would cost an extra agent run on every single sweep.
 *
 * USAGE
 *   MULTICA_TOKEN=… node scripts/multica-unstick.mjs [--dry-run] [--verbose]
 *
 * ENV
 *   MULTICA_TOKEN          required — same secret the close-on-merge workflow uses
 *   MULTICA_WORKSPACE_ID   optional — defaults to the MantaUI (BET) workspace
 *   MULTICA_API_BASE       optional — defaults to https://api.multica.ai
 *   MULTICA_UNSTICK_GRACE_MIN    optional — minutes a terminal run must be cold (default 30)
 *   MULTICA_UNSTICK_BACKOFF_MIN  optional — minutes between unsticks of one issue (default 120)
 *   MULTICA_UNSTICK_MAX_ACTIONS  optional — mutating actions per tick (default 5)
 *
 * Exit code is 0 unless the run could not complete (missing token, list call
 * failed). Individual failures warn and do not fail the run — this is
 * housekeeping and must never break a pipeline.
 */

import { api, DEFAULT_WORKSPACE, DEFAULT_API_BASE } from "./lib/multicaApi.mjs";

/**
 * Statuses this sweep reasons about. `blocked` belongs to multica-unblock.
 *
 * `todo` is in scope and load-bearing: a status change does NOT dispatch a run
 * (only an assignment or a comment does), so when multica-unblock flips a
 * `blocked` issue to `todo` it fixes the label and starts nothing. Without the
 * `todo` rule the two sweeps would hand off to each other and drop the work.
 */
export const LIVE_STATUSES = ["todo", "in_progress", "in_review"];

/** Run states that mean work is (or is about to be) happening. */
export const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "pending",
  "dispatched",
  "running",
  "in_progress",
  "starting",
]);

/** PR states that count as "there is a work product to review". */
export const LIVE_PR_STATES = new Set(["open", "draft", "merged"]);

/**
 * Classify an agent by name into its pipeline role.
 *
 * Names are workspace conventions (`manta-dev`, `manta-reviewer`, `manta-pm`,
 * `manta-ops`), so match on the suffix rather than hardcoding the prefix — the
 * same script then works unchanged if the workspace is renamed.
 *
 * @param {string|null|undefined} name
 * @returns {"reviewer"|"pm"|"ops"|"implementer"|"unknown"}
 */
export function agentRole(name) {
  if (typeof name !== "string" || name.trim() === "") return "unknown";
  const n = name.toLowerCase();
  if (n.includes("reviewer")) return "reviewer";
  if (/(^|[-_])pm([-_]|$)/.test(n)) return "pm";
  if (/(^|[-_])ops([-_]|$)/.test(n)) return "ops";
  return "implementer";
}

/**
 * Newest-first ordering for task runs. The API returns them newest-first today,
 * but relying on that is a silent-corruption risk: the wrong "latest run" turns
 * a healthy issue into a spurious re-page.
 *
 * @param {Array<object>} runs
 * @returns {Array<object>}
 */
export function sortRunsNewestFirst(runs) {
  const at = (r) =>
    Date.parse(r?.completed_at || r?.started_at || r?.dispatched_at || r?.created_at || 0) || 0;
  return [...(Array.isArray(runs) ? runs : [])].sort((a, b) => at(b) - at(a));
}

/**
 * When did this run stop being able to move the issue?
 *
 * @param {object} run
 * @returns {number|null} epoch ms, or null if unknowable
 */
export function runSettledAt(run) {
  const t = Date.parse(run?.completed_at || run?.started_at || run?.created_at || "");
  return Number.isFinite(t) ? t : null;
}

/**
 * Issue-level screen: can this issue be a stall candidate at all?
 *
 * Split out from `decideUnstick` so the sweep can reject an issue from the
 * single list call alone, before spending a runs fetch and a PRs fetch on it. A
 * healthy board therefore costs almost nothing.
 *
 * @param {{
 *   issue: {status?:string, assignee_type?:string, assignee_id?:string,
 *           metadata?:{unstick_last?:string}},
 *   roleById: Map<string,{name:string, role:string}>,
 *   now: number,
 *   backoffMs: number,
 * }} args
 * @returns {{candidate:false, reason:string} | {candidate:true, role:string}}
 */
export function screenIssue({ issue, roleById, now, backoffMs }) {
  const no = (reason) => ({ candidate: false, reason });

  if (!issue || typeof issue !== "object") return no("not an issue");
  if (!LIVE_STATUSES.includes(issue.status)) return no(`status ${issue.status} not in scope`);

  // A human owning the issue is the end of the matter. Never page an agent
  // about work a person has taken.
  if (issue.assignee_type !== "agent" || !issue.assignee_id) {
    return no("not agent-assigned");
  }

  const role = roleById?.get?.(issue.assignee_id)?.role ?? "unknown";
  if (role === "unknown") return no("assignee is not a known agent");
  // ops is a watchdog, not a pipeline stage — it never "owes" a hand-off.
  if (role === "ops") return no("assigned to ops");

  // Backoff: one unstick per issue per window. A successful reassign starts a
  // run, so the next tick sees it in flight and stops anyway — this only guards
  // the case where the reassign did not take.
  const last = Date.parse(issue.metadata?.unstick_last ?? "");
  if (Number.isFinite(last) && now - last < backoffMs) {
    return no("unstuck recently (backoff)");
  }

  return { candidate: true, role };
}

/**
 * Decide what (if anything) to do about ONE issue.
 *
 * Pure: every input is passed in, nothing is fetched. This is where all the
 * judgement lives, so it is the whole unit-test surface.
 *
 * @param {{
 *   issue: {identifier?:string, status?:string, assignee_type?:string,
 *           assignee_id?:string, metadata?:{unstick_last?:string}},
 *   runs: Array<object>,
 *   pullRequests: Array<{state?:string}>,
 *   roleById: Map<string,{name:string, role:string}>,
 *   now: number,
 *   graceMs: number,
 *   backoffMs: number,
 * }} args
 * @returns {{act:false, reason:string} |
 *           {act:true, action:"assign", role:"reviewer"|"pm", reason:string} |
 *           {act:true, action:"rerun", role:"pm", reason:string}}
 */
export function decideUnstick({
  issue,
  runs,
  pullRequests,
  roleById,
  now,
  graceMs,
  backoffMs,
}) {
  const no = (reason) => ({ act: false, reason });

  const screen = screenIssue({ issue, roleById, now, backoffMs });
  if (!screen.candidate) return no(screen.reason);
  const role = screen.role;

  const ordered = sortRunsNewestFirst(runs);
  const inFlight = ordered.find((r) => ACTIVE_RUN_STATUSES.has(r?.status));
  if (inFlight) return no(`run ${inFlight.status}`);

  if (ordered.length === 0) {
    // Assigned to an agent but never dispatched — the assignment event was
    // lost. Fall back to the issue's own clock; if that is unreadable we
    // cannot tell a lost dispatch from one made a second ago, so do nothing.
    const touched = Date.parse(issue.updated_at ?? "");
    if (!Number.isFinite(touched)) return no("no runs and no usable updated_at");
    const idleMs = now - touched;
    if (idleMs < graceMs) return no(`no runs yet, only ${Math.round(idleMs / 60000)}m old`);
    return {
      act: true,
      action: "rerun",
      role,
      reason: `assigned ${Math.round(idleMs / 60000)}m ago but never dispatched`,
    };
  }

  const latest = ordered[0];
  const settled = runSettledAt(latest);
  // An unreadable timestamp must never be read as "cold" — that would page an
  // agent about a run that may have started seconds ago.
  if (settled == null) return no("latest run has no usable timestamp");
  const coldMs = now - settled;
  if (coldMs < graceMs) return no(`latest run only ${Math.round(coldMs / 60000)}m cold`);

  const mins = Math.round(coldMs / 60000);
  const hasPr = (Array.isArray(pullRequests) ? pullRequests : []).some((p) =>
    LIVE_PR_STATES.has(p?.state),
  );

  if (issue.status === "todo") {
    // `todo` means the work has not started, so the current assignee is still
    // the right actor — there is no hand-off to route, only a dispatch to
    // re-fire. This is the case multica-unblock creates when it clears a
    // `blocked` issue: correct status, nothing running.
    return {
      act: true,
      action: "rerun",
      role,
      reason: `todo with a terminal run ${mins}m ago — nothing will start it`,
    };
  }

  if (role === "pm") {
    // The PM is the last stage — there is nobody downstream to hand to, so the
    // only way to restart it is to re-fire its own assignment.
    return {
      act: true,
      action: "rerun",
      role: "pm",
      reason: `pm run terminal ${mins}m ago on ${issue.status}, nothing in flight`,
    };
  }

  if (role === "reviewer") {
    return {
      act: true,
      action: "assign",
      role: "pm",
      reason: `reviewer run terminal ${mins}m ago, verdict never routed onward`,
    };
  }

  // implementer
  if (issue.status === "in_review" || hasPr) {
    return {
      act: true,
      action: "assign",
      role: "reviewer",
      reason: hasPr
        ? `implementer run terminal ${mins}m ago with a PR, never handed to review`
        : `implementer run terminal ${mins}m ago on in_review, never handed to review`,
    };
  }

  return {
    act: true,
    action: "assign",
    role: "pm",
    reason: `implementer run terminal ${mins}m ago with no PR (no-op run), needs triage`,
  };
}

/* ------------------------------------------------------------------ *
 * IO below this line. Everything above is pure and unit-tested.
 * ------------------------------------------------------------------ */

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  const token = process.env.MULTICA_TOKEN;
  const workspace = process.env.MULTICA_WORKSPACE_ID || DEFAULT_WORKSPACE;
  const base = process.env.MULTICA_API_BASE || DEFAULT_API_BASE;
  const graceMs = minutesEnv("MULTICA_UNSTICK_GRACE_MIN", 30);
  const backoffMs = minutesEnv("MULTICA_UNSTICK_BACKOFF_MIN", 120);
  const maxActions = Number(process.env.MULTICA_UNSTICK_MAX_ACTIONS) || 5;

  if (!token) {
    console.error("MULTICA_TOKEN is not set — nothing to do.");
    process.exit(1);
  }

  // Roles, resolved live so a renamed or newly added agent needs no code change.
  const agents = await api(base, token, `/agents?workspace_id=${workspace}`);
  const roleById = new Map(
    (Array.isArray(agents) ? agents : (agents.agents ?? [])).map((a) => [
      a.id,
      { name: a.name, role: agentRole(a.name) },
    ]),
  );
  const idByRole = new Map();
  for (const [id, { role }] of roleById) if (!idByRole.has(role)) idByRole.set(role, id);

  for (const role of ["reviewer", "pm"]) {
    if (!idByRole.has(role)) {
      console.log(`::warning::no ${role} agent in this workspace — those routes are unavailable.`);
    }
  }

  const issues = [];
  for (const status of LIVE_STATUSES) {
    const page = await api(base, token, `/issues?workspace_id=${workspace}&status=${status}&limit=200`, {});
    issues.push(...(page.issues ?? []));
  }
  if (issues.length === 0) {
    console.log("No in_progress/in_review issues. Nothing to reconcile.");
    return 0;
  }

  const now = Date.now();
  let acted = 0;
  let writeFailed = false;

  for (const issue of issues) {
    const id = issue.identifier;

    // Cheap pre-filter: reject from the list payload alone, before spending a
    // runs fetch and a PRs fetch. A healthy board costs almost nothing.
    const screen = screenIssue({ issue, roleById, now, backoffMs });
    if (!screen.candidate) {
      if (verbose) console.log(`  · ${id} skipped (${screen.reason})`);
      continue;
    }

    let runs = [];
    let pullRequests = [];
    try {
      runs = await api(base, token, `/issues/${id}/task-runs?workspace_id=${workspace}`, {});
      const prs = await api(base, token, `/issues/${id}/pull-requests?workspace_id=${workspace}`, {});
      pullRequests = prs.pull_requests ?? [];
    } catch (e) {
      // Unreadable state is a READ: never a reason to act. Skip and retry next
      // tick — one issue's transient error must not abort the sweep.
      console.log(`  ! ${id} state unreadable, leaving alone: ${e.message}`);
      continue;
    }

    const decision = decideUnstick({
      issue,
      runs: Array.isArray(runs) ? runs : (runs.task_runs ?? []),
      pullRequests,
      roleById,
      now,
      graceMs,
      backoffMs,
    });
    if (!decision.act) {
      if (verbose) console.log(`  · ${id} healthy (${decision.reason})`);
      continue;
    }

    // A rerun re-fires the issue's CURRENT assignment, so its target is the
    // assignee itself; only an `assign` looks up the next role in the pipeline.
    const target =
      decision.action === "rerun" ? issue.assignee_id : idByRole.get(decision.role);
    const targetName = roleById.get(target)?.name ?? decision.role;
    const what =
      decision.action === "rerun" ? `re-run ${targetName}` : `hand to ${targetName}`;

    if (acted >= maxActions) {
      console.log(`  · ${id} would ${what} but the per-tick action cap (${maxActions}) is spent`);
      continue;
    }
    if (decision.action === "assign" && !target) {
      console.log(`  ! ${id} needs ${decision.role} but no such agent exists — skipping`);
      continue;
    }
    if (dryRun) {
      console.log(`  → ${id} WOULD ${what} (${decision.reason})`);
      acted++;
      continue;
    }

    try {
      if (decision.action === "rerun") {
        await api(base, token, `/issues/${issue.id}/rerun?workspace_id=${workspace}`, { method: "POST", body: "{}" });
      } else {
        await api(base, token, `/issues/${id}?workspace_id=${workspace}`, {
          method: "PUT",
          body: JSON.stringify({ assignee_id: target, assignee_type: "agent" }),
        });
      }
      acted++;
      console.log(`  → ${id} ${what} (${decision.reason})`);
    } catch (e) {
      // A failed WRITE (rerun/assign) is fatal to the job: log key + status +
      // body, keep sweeping, exit non-zero at the end.
      console.error(`Failed to ${what} ${id} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
      writeFailed = true;
      continue;
    }

    // Record it in METADATA, never a comment.
    //
    // A comment on an agent-assigned issue DISPATCHES A RUN (`kind:"comment"` —
    // verified live 2026-07-27). So an audit comment posted after a reassign
    // queues a SECOND run of the agent we just woke, and one posted before the
    // reassign wakes the stalled agent we are trying to route away from. Either
    // order burns a full agent run per sweep. Metadata writes are inert, so the
    // ledger lives there; the human-readable trail is the workflow log.
    const stamps = {
      unstick_last: new Date(now).toISOString(),
      unstick_action: `${decision.action}:${targetName}`,
      unstick_reason: decision.reason,
    };
    for (const [key, value] of Object.entries(stamps)) {
      try {
        await api(base, token, `/issues/${issue.id}/metadata/${key}?workspace_id=${workspace}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
      } catch (e) {
        // A metadata write is a WRITE and must be visible too. The unstick
        // action itself already landed; keep the batch moving, fail at the end.
        console.error(`Failed to write ${key} on ${id} (HTTP ${e.status ?? "?"}): ${e.body ?? e.message}`);
        writeFailed = true;
      }
    }
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}${acted} of ${issues.length} live issue(s) ${dryRun ? "would be" : ""} unstuck.`,
  );

  // A write that never landed must fail the job — invisible here means an
  // issue left assigned-but-dead with a green-looking run.
  if (writeFailed) process.exit(1);
}

function minutesEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw > 0 ? raw : fallback) * 60_000;
}

// Only run when invoked directly, so the pure exports stay importable in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`multica-unstick failed: ${e.message}`);
    process.exit(1);
  });
}
