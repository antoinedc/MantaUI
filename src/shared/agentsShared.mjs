// agentsShared.mjs — constants shared by the box server and the renderer for Agents.
// The lead's folder slug: the ONE place to rename it.
export const LEAD_SLUG = "manta";
// The Architect's folder slug (Agents Phase 5A): with `role: architect`, the built-in agent builder.
export const ARCHITECT_SLUG = "architect";
/** A teammate the lead can hand work to: a valid agent (no error) that is not the lead. The one predicate for the roster, handoff, dispatch, the sidebar and the picker. */
export const isTeamAgent = (info) => !!info && !info.error && info.role !== "lead";
