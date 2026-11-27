// agentsShared.mjs — constants shared by the box server and the renderer for Agents.
// The lead's folder slug: the ONE place to rename it.
export const LEAD_SLUG = "manta";
// The Architect's folder slug (Agents Phase 5A): with `role: architect`, the built-in agent builder.
export const ARCHITECT_SLUG = "architect";
/** A teammate the lead can hand work to: a valid agent (no error) that is not the lead. The one predicate for the roster, handoff, dispatch, the sidebar and the picker. */
export const isTeamAgent = (info) => !!info && !info.error && info.role !== "lead";
/** The Architect's trial tools (Architect v2 Stage 1): run a drafted agent on sample tasks before proposing it. Server rulesets and the Architect's block both name them. */
export const ARCHITECT_TRIAL_TOOLS = Object.freeze(["agent_trial", "agent_trial_wait", "agent_trial_read"]);
/** The Architect's read-only list of the skills on this box (Architect v2 Stage 2): the candidates a skill search may name besides search results. */
export const ARCHITECT_SKILL_TOOLS = Object.freeze(["skills_installed"]);
/** Every opencode agent block of a trial is `agent-trial-<id>`, the id being `tr_<hex>` (a slug never holds an underscore, so a user's agent can't collide). */
export const TRIAL_BLOCK_RE = /^agent-trial-tr_[0-9a-f]+$/;
