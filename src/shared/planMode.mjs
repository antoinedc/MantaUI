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

// How many [a-z0-9] chars of the session id survive into the plan subdomain.
// Kept short so `plan-` + shortId never approaches the 63-char ceiling.
const SHORT_ID_LEN = 20;

/**
 * The stable subdomain for a session's plan page: `plan-<shortSessionId>`.
 * `shortSessionId` is the session id lowercased, non-alphanumerics stripped,
 * truncated to SHORT_ID_LEN chars. Returns null when the input yields no
 * usable slug (caller must refuse, matching the "never hand back a 404 URL"
 * rule). The result always satisfies isValidSubdomain.
 *
 * Single source of truth for both the server (which publishes the page under
 * this subdomain) and the renderer (which derives the deterministic URL for
 * the PlanCard's "Open page" link — BET-992).
 */
export function planSubdomain(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  const slug = sessionID
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, SHORT_ID_LEN);
  if (!slug) return null;
  return `plan-${slug}`;
}

/**
 * The deterministic public URL of a session's plan page:
 * `<baseUrl>/pages/plan-<shortSessionId>`. Trims a trailing slash off
 * `baseUrl`. Returns "" when `planSubdomain` yields no usable slug. Never
 * throws.
 */
export function planPageUrl(sessionID, baseUrl) {
  const slug = planSubdomain(sessionID);
  if (!slug) return "";
  return `${String(baseUrl).replace(/\/+$/, "")}/pages/${slug}`;
}
