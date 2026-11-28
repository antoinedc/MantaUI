// How an ended task ended, in Fleet's four words — the ONE mapping the box's Fleet read (`endedOutcome`, agentsFleetTasks.mjs) and the
// chat's task cards share, so the card and the Fleet row can never disagree: "done" | "didnt-finish" | "interrupted" | "stopped".
// Pure; reads only what the job record holds.

const INTERRUPTED_RE = /^interrupted|cut off|upgrade/i;

/** @param {{ status?: string, error?: unknown, endReason?: unknown, endedBlocked?: unknown }} job */
export function outcomeOfJob(job) {
  if (job?.status === "stopped") return job.error === "stopped by user" ? "stopped" : "interrupted";
  if (job?.status === "failed") {
    if (job.endReason === "time-limit" || job.endReason === "stalled") return "didnt-finish";
    return INTERRUPTED_RE.test(String(job.error ?? "")) ? "interrupted" : "didnt-finish";
  }
  if (job?.endedBlocked === true) return "didnt-finish";
  return "done";
}
