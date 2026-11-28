// The Fleet page's read model (docs/superpowers/specs/2026-11-28-fleet-redesign.md §2.2): what is in progress or paused by the user,
// and what ended today with one plain sentence each. Pure shaping over task records — the I/O (stores, git, the registry) is the
// caller's (agents.mjs `fleetTasks`). Nothing here invents a status: a task is running, paused by the user, or ended one of four ways.

import { LEAD_SLUG } from "../shared/agentsShared.mjs";
import { displayTitle } from "./jobTitle.mjs";
import { jobModelOf } from "./jobModel.mjs";

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
const UNTITLED_SESSION = "Untitled session";
const isEnded = (j) => j.status === "done" || j.status === "failed" || j.status === "stopped";

/** A tree node's descendants, pre-order. */
function descendantsOf(node) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Where a tree root's work happens: its window's folder, else its job's folder, else the workspace's default folder. */
function rootDirectory(project, root, job) {
  const win = root.windowIndex != null ? (project.windows ?? []).find((w) => w.index === root.windowIndex) : null;
  return win?.paneCurrentPath || job?.parentDirectory || project.defaultCwd || null;
}

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
 * @param {(target: {sessionId: string|null, jobProgress: object|null, job: object|null}) => string} [a.lineOf] the one-liner of a row
 * @param {object|null} [a.sessions] the session tree (spec §5b): rows are working top-level sessions, jobs beneath one are its `subs`.
 *   `{ projects, statusOf(sid) → {running, busy, startedAt}, agentOfSession(sid) → slug|null, projectOfDir(dir) → {slug, name}|null, lineOf? }`
 *   `projects` is the annotated session list (each with its `tree`). Absent (an older tree, not hydrated): every job is a row.
 */
export function shapeFleetTasks({ rounds, now, slugOfJob, projectOf, verdictOf, proposalWaiting, stillNeedsYou, boxRunning, cap, lineOf: lineOfDep, sessions = null }) {
  const lineOf = sessions?.lineOf ?? lineOfDep ?? (() => "");
  rounds = rounds.filter((j) => j?.specialist === true);
  const jobById = new Map(rounds.map((j) => [j.id, j]));
  const statusOf = (sid) => (sid ? (sessions?.statusOf?.(sid) ?? {}) : {});

  // ---- the session tree: every root with what is beneath it ----
  const entries = []; // { key, project, root, subs: [{node|job}], jobIds }
  const rootOf = new Map(); // session id → entry
  for (const p of sessions?.projects ?? []) {
    for (const root of p.tree ?? []) {
      if (!root?.sessionId) continue; // a terminal window has no session: never a row
      const below = descendantsOf(root);
      const entry = { key: root.sessionId, project: p, root, below, extra: [], jobIds: new Set(root.job ? [root.job.id] : []) };
      for (const n of [root, ...below]) {
        if (n.sessionId) rootOf.set(n.sessionId, entry);
        if (n.job) entry.jobIds.add(n.job.id);
      }
      entries.push(entry);
    }
  }
  const entryOfJob = (j) => (sessions ? (rootOf.get(j.childSessionID) ?? rootOf.get(j.parentSessionID) ?? null) : null);

  const askedFor = (j) => askedByOf(j);
  const jobBase = (job) => {
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
      askedBy: askedFor(job),
      model: jobModelOf(job),
    };
  };

  /** A job beneath a session: title and where it stands. */
  const subOfJob = (j) => ({
    key: j.id,
    title: displayTitle(j),
    status: j.status === "paused" ? "paused-by-you" : j.status === "running" ? "in-progress" : j.status === "done" ? "finished" : "didnt-finish",
    jobId: j.id,
    agentSlug: slugOfJob(j),
  });
  /** A tree node beneath a session (a subagent, a job's session, a linked session). */
  const subOfNode = (n) => {
    const j = n.job ? jobById.get(n.job.id) : null;
    const js = n.job?.status ?? j?.status ?? null;
    const st = statusOf(n.sessionId);
    const status = js === "paused" ? "paused-by-you" : js === "running" || (!js && (st.running || st.busy)) ? "in-progress" : js === "failed" || js === "stopped" ? "didnt-finish" : "finished";
    return {
      key: n.job?.id ?? n.sessionId ?? n.key,
      title: (j ? displayTitle(j) : String(n.title ?? "").trim()) || UNTITLED_SESSION,
      status,
      jobId: n.job?.id ?? null,
      agentSlug: j ? slugOfJob(j) : null,
    };
  };

  // ---- jobs the tree doesn't show: folded under their parent session's root when it has one, else a row of their own ----
  const orphans = [];
  const live = rounds.filter((j) => j.status === "running" || j.status === "paused");
  for (const j of live) {
    const entry = entryOfJob(j);
    if (entry && entry.root.job?.id !== j.id) {
      if (!entry.jobIds.has(j.id)) {
        entry.jobIds.add(j.id);
        entry.extra.push(j);
      }
    } else if (!entry) {
      orphans.push(j);
    }
  }

  const running = [];
  for (const entry of entries) {
    const { root, project: p } = entry;
    const rootJob = root.job ? (jobById.get(root.job.id) ?? null) : null;
    const rootJobStatus = root.job?.status ?? rootJob?.status ?? null;
    const subs = [...entry.below.map(subOfNode), ...entry.extra.map(subOfJob)];
    const own = statusOf(root.sessionId);
    const anyRunning = own.busy === true || own.running === true || rootJobStatus === "running" || subs.some((s) => s.status === "in-progress");
    const anyPaused = rootJobStatus === "paused" || subs.some((s) => s.status === "paused-by-you");
    if (!anyRunning && !anyPaused) continue;
    const paused = !anyRunning;
    const isTask = root.job != null;
    const dir = rootDirectory(p, root, rootJob);
    const proj = (rootJob ? projectOf(rootJob) : null) ?? sessions.projectOfDir?.(dir) ?? null;
    // when it was paused: the row's own job, else the newest pause among the jobs beneath it
    const pausedBeneath = [...entry.extra, ...entry.below.map((n) => (n.job ? jobById.get(n.job.id) : null))].filter((j) => j?.status === "paused");
    const pausedAt = paused ? (rootJob?.pausedAt ?? pausedBeneath.map((j) => j.pausedAt ?? 0).sort((a, b) => b - a)[0] ?? null) : null;
    running.push({
      key: isTask ? root.job.id : root.sessionId,
      kind: isTask ? "task" : "chat",
      sessionId: root.sessionId,
      window: root.kind === "window" && root.windowIndex != null ? { tmuxSession: p.tmuxSession, index: root.windowIndex } : null,
      jobId: isTask ? root.job.id : "",
      rootJobId: isTask ? (rootJob?.rootJobId ?? root.job.id) : "",
      title: isTask ? (rootJob ? displayTitle(rootJob) : String(root.title ?? "").trim() || UNTITLED_SESSION) : String(root.title ?? "").trim() || UNTITLED_SESSION,
      oneLiner: lineOf({ sessionId: root.sessionId, jobProgress: rootJob?.jobProgress ?? null, job: rootJob }) || "",
      agentSlug: (rootJob ? slugOfJob(rootJob) : null) ?? sessions.agentOfSession?.(root.sessionId) ?? LEAD_SLUG,
      project: proj?.slug ?? null,
      projectName: proj?.name ?? p.tmuxSession,
      startedAt: rootJob ? startedOf(rootJob) : (statusOf(root.sessionId).startedAt ?? 0),
      branch: typeof rootJob?.branch === "string" && rootJob.branch ? rootJob.branch : null,
      model: rootJob ? jobModelOf(rootJob) : null,
      askedBy: rootJob ? askedFor(rootJob) : { by: "you" },
      status: paused ? "paused-by-you" : "in-progress",
      pausedAt: paused ? pausedAt : null,
      subs,
    });
  }
  for (const j of orphans) {
    running.push({
      ...jobBase(j),
      key: j.id,
      kind: "task",
      sessionId: j.childSessionID ?? null,
      window: null,
      oneLiner: lineOf({ sessionId: j.childSessionID ?? null, jobProgress: j.jobProgress ?? null, job: j }) || "",
      status: j.status === "paused" ? "paused-by-you" : "in-progress",
      pausedAt: j.status === "paused" ? (j.pausedAt ?? null) : null,
      subs: [],
    });
  }
  running.sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === "in-progress" ? -1 : 1));

  // ---- Ended today: one row per top-level session (its ended jobs beneath it); a job without a placed session is its own row ----
  const since = localMidnight(now);
  const endedJobs = rounds.filter((j) => isEnded(j) && (j.finishedAt ?? 0) >= since).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const groups = new Map(); // group key → { entry|null, jobs: newest first }
  for (const j of endedJobs) {
    const entry = entryOfJob(j);
    const own = entry && entry.root.job?.id !== j.id ? entry : null;
    const key = own ? `s:${own.key}` : `j:${j.id}`;
    const g = groups.get(key) ?? { entry: own, jobs: [] };
    g.jobs.push(j);
    groups.set(key, g);
  }
  const ended = [...groups.values()].slice(0, FLEET_ENDED_MAX).map(({ entry, jobs }) => {
    const newest = jobs[0];
    const outcome = endedOutcome(newest, { verdict: verdictOf(newest), proposalWaiting: proposalWaiting(newest), stillNeedsYou: stillNeedsYou(newest) });
    const base = jobBase(newest);
    const common = { ...base, endedAt: newest.finishedAt ?? 0, startedAt: Math.min(...jobs.map(startedOf)), ...outcome };
    if (!sessions) return { ...common, key: newest.id, kind: "task", sessionId: newest.childSessionID ?? null, window: null, subs: [] };
    if (!entry) return { ...common, key: newest.id, kind: "task", sessionId: newest.childSessionID ?? null, window: null, subs: [] };
    const { root, project: p } = entry;
    const proj = sessions.projectOfDir?.(rootDirectory(p, root, null)) ?? null;
    return {
      ...common,
      key: root.sessionId,
      kind: "chat",
      sessionId: root.sessionId,
      window: root.kind === "window" && root.windowIndex != null ? { tmuxSession: p.tmuxSession, index: root.windowIndex } : null,
      title: String(root.title ?? "").trim() || UNTITLED_SESSION,
      agentSlug: sessions.agentOfSession?.(root.sessionId) ?? LEAD_SLUG,
      project: proj?.slug ?? base.project,
      projectName: proj?.name ?? base.projectName ?? p.tmuxSession,
      subs: jobs.map(subOfJob),
    };
  });
  ended.sort((a, b) => b.endedAt - a.endedAt);

  return { asOf: now, running, ended, cap, full: boxRunning >= cap };
}
