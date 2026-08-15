// planMode.mjs — the ONE shared rule for reading plan-mode state off a tool
// part (BET-977). Consumed by the desktop renderer (useSseBus.ts) AND the box's
// stream interpreter (streamInterp.mjs) so both mirror opencode's local
// plan_enter/plan_exit switch identically. Do not copy this elsewhere.

/**
 * The plan-mode state a tool part asserts, or `null` if it asserts nothing.
 *
 * Only a COMPLETED plan_enter/plan_exit counts. An ERRORED one is a switch that
 * did NOT happen — most importantly the plan card's "Keep planning", which
 * answers the plan question "No" and so rejects the `plan_exit` tool. Reading
 * that as an exit dropped the session out of plan mode behind the user's back.
 * (This is why the drain's `isToolStepBoundary`, which accepts `error` on
 * purpose, must not be reused here.)
 */
export function planModeFromToolPart(part) {
  if (!part || typeof part !== "object") return null;
  const p = part;
  if (p.type !== "tool") return null;
  if (p.state?.status !== "completed") return null;
  if (p.tool === "plan_enter") return true;
  if (p.tool === "plan_exit") return false;
  return null;
}

/**
 * Whether `name` is a plan-mode agent, so manta-plan is recognized uniformly.
 */
export function isPlanAgent(name) {
  if (name === undefined || name === null || typeof name !== "string") return false;
  return name === "plan" || name === "manta-plan";
}
