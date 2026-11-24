// researchTools.mjs — the names of the research tools every agent task may call (spec
// docs/superpowers/specs/2026-11-24-research-library.md §3). Shared by the rulesets (delegate.mjs), the binding
// (agents.mjs) and the library (researchLibrary.mjs). Pure, no I/O.

/** The Architect's research tools (Agents Phase 5A), now every specialist's. */
export const RESEARCH_TOOLS = Object.freeze(["research_fetch", "research_read", "research_search"]);
/** The shared, dated research library. */
export const LIBRARY_TOOLS = Object.freeze(["research_library_find", "research_library_save"]);
/** What a specialist task's ruleset allows (permission pattern `*`). */
export const SPECIALIST_RESEARCH_TOOLS = Object.freeze([...RESEARCH_TOOLS, ...LIBRARY_TOOLS]);
/** What every specialist task's ruleset allows: the research tools, the library, and OpenCode's standard `question` tool (spec docs/superpowers/specs/2026-11-24-ask-user-tool.md). */
export const SPECIALIST_TASK_TOOLS = Object.freeze([...SPECIALIST_RESEARCH_TOOLS, "question"]);
