// The Fleet page's read model (docs/superpowers/specs/2026-11-28-fleet-redesign.md §2.2): what is in progress or paused by the user,
// and what ended today with one plain sentence each. Pure shaping over task records — the I/O (stores, git, the registry) is the
// caller's (agents.mjs `fleetTasks`). Nothing here invents a status: a task is running, paused by the user, or ended one of four ways.

import { displayTitle } from "./jobTitle.mjs";

/** Ended today holds at most this many rows (newest first). */
export const FLEET_ENDED_MAX = 50;

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const firstLine = (text) => String(text ?? "").split("\n")[0].trim();

/** The start of the box's calendar day that `ms` falls in (box-local time). */
export function localMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Who asked: a refresh / check-up task is a routine, a handoff is Manta (with its chat), anything else is the user. */
export function askedByOf(job) {
  if (job?.deliverResult === false) return { by: "routine" };
  if (job?.requestedBy === "manta") return { by: "manta", sessionId: typeof job.parentSessionID === "string" && job.parentSessionID ? job.parentSessionID : null };
  return { by: "you" };
}

const hasBranchWork = (job) => typeof job?.branch === "string" && job.branch !== "" && Number(job.filesChanged) > 0;
const INTERRUPTED_RE = /^interrupted|cut off|upgrade/i;

/** The technical record shown in Details: the reason, the files, the branch. */
function factsOf(job, verdict) {
  const parts = [];
  if (job.status === "stopped") parts.push(job.error === "stopped by user" ? "Stopped by you" : firstLine(job.error) || "Stopped");
  else if (job.status === "failed") {
    if (job.endReason === "time-limit") parts.push("Hit its time limit");
    else if (job.endReason === "stalled") parts.push("Stalled: no progress for 15 minutes");
    else parts.push(`Failed: ${firstLine(job.error).slice(0, 160) || "no reason recorded"}`);
  } else if (job.endedBlocked === true) parts.push("Ended on a decision for you");
  const files = Number(job.filesChanged) > 0 ? `${plural(Number(job.filesChanged), "file")} changed` : job.status === "done" ? "No files changed" : null;
  if (files) parts.push(files);
  if (typeof job.branch === "string" && job.branch) parts.push(`branch ${job.branch}${verdict === "landed" ? " (in the project)" : verdict === "unmerged" ? " (not in the project yet)" : ""}`);
  return parts.join(" · ") || "No details recorded";
}

/**
 * The badge and the one sentence of an ended task, from what the box recorded only.
 * @param {object} ctx `verdict`: "landed" | "unmerged" | "unknown" | null for its branch; `proposalWaiting`: a change it proposed waits for a click;
 *   `stillNeedsYou`: it is still an item in Needs you.
 * @returns {{ outcome: "done"|"didnt-finish"|"interrupted"|"stopped", sentence: string, facts: string }}
 */
export function endedOutcome(job, { verdict = null, proposalWaiting = false, stillNeedsYou = false } = {}) {
  const facts = factsOf(job, verdict);
  const out = (outcome, sentence) => ({ outcome, sentence, facts });
  if (job.status === "stopped") {
    if (job.error === "stopped by user") return out("stopped", "You stopped it. What it had done so far is kept.");
    return out("interrupted", "It was paused for over 7 days, so Manta stopped it.");
  }
  if (job.status === "failed") {
    if (job.endReason === "time-limit") return out("didnt-finish", "It ran out of time.");
    if (job.endReason === "stalled") return out("didnt-finish", "It stopped making progress.");
    if (INTERRUPTED_RE.test(String(job.error ?? ""))) return out("interrupted", "It was cut off when the box restarted.");
    return out("didnt-finish", "It hit a problem and stopped.");
  }
  if (job.endedBlocked === true) return out("didnt-finish", stillNeedsYou ? "It stopped to ask for your decision. It's in Needs you." : "It stopped to ask for a decision.");
  if (proposalWaiting) return out("done", "It suggests a change that needs your approval.");
  if (hasBranchWork(job)) {
    if (verdict === "landed") return out("done", "Its changes are in the project.");
    if (verdict === "unmerged") return out("done", "Its changes are on a branch, not in the project yet.");
    return out("done", `It finished and changed ${plural(Number(job.filesChanged), "file")}.`);
  }
  if (job.deliverResult === false) return out("done", "It finished its scheduled work.");
  return out("done", "Its report is in the chat that asked.");
}

const startedOf = (job) => job.startedAt ?? job.createdAt ?? 0;

/**
 * @param {object} a
 * @param {object[]} a.rounds the newest round of every task (specialist tasks only)
 * @param {(job) => string|null} a.slugOfJob
 * @param {(job) => {slug: string, name: string}|null} a.projectOf the registry project owning the task's folder
 * @param {(job) => "landed"|"unmerged"|"unknown"|null} a.verdictOf the branch verdict (null: not asked)
 * @param {(job) => boolean} a.proposalWaiting
 * @param {(job) => boolean} a.stillNeedsYou
 * @param {number} a.boxRunning running jobs box-wide, of every kind (what the cap counts)
 * @param {number} a.cap
 */
export function shapeFleetTasks({ rounds, now, slugOfJob, projectOf, verdictOf, proposalWaiting, stillNeedsYou, boxRunning, cap }) {
  const base = (job) => {
    const project = projectOf(job);
    return {
      jobId: job.id,
      rootJobId: job.rootJobId ?? job.id,
      title: displayTitle(job),
      agentSlug: slugOfJob(job) ?? "",
      project: project?.slug ?? null,
      projectName: project?.name ?? null,
      startedAt: startedOf(job),
      branch: typeof job.branch === "string" && job.branch ? job.branch : null,
      askedBy: askedByOf(job),
    };
  };

  rounds = rounds.filter((j) => j?.specialist === true);
  const running = rounds
    .filter((j) => j.status === "running" || j.status === "paused")
    .map((j) => ({ ...base(j), status: j.status === "paused" ? "paused-by-you" : "in-progress", pausedAt: j.status === "paused" ? (j.pausedAt ?? null) : null }))
    .sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === "in-progress" ? -1 : 1));

  const since = localMidnight(now);
  const ended = rounds
    .filter((j) => (j.status === "done" || j.status === "failed" || j.status === "stopped") && (j.finishedAt ?? 0) >= since)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, FLEET_ENDED_MAX)
    .map((j) => ({
      ...base(j),
      endedAt: j.finishedAt ?? 0,
      ...endedOutcome(j, { verdict: verdictOf(j), proposalWaiting: proposalWaiting(j), stillNeedsYou: stillNeedsYou(j) }),
    }));

  return { asOf: now, running, ended, cap, full: boxRunning >= cap };
}
