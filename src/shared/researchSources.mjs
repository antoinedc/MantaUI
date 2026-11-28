// researchSources.mjs — the built-in research sources every box has (research layer spec
// docs/superpowers/specs/2026-11-28-research-layer.md §7), as pure data shared by the box (store, prompts, adapters) and the
// renderer (Settings, profile line). No I/O. Order is the default priority; every one is keyless, free, and OUTSIDE (a query to it
// leaves the box: no confidential or project-specific material in it).

export const BUILTIN_SOURCES = Object.freeze(
  [
    { id: "web", name: "Web search", description: "Anything; discovery; official docs with site: (use the websearch tool; read pages with research_fetch)", via: "websearch" },
    { id: "github", name: "GitHub", description: "Libraries in use: stars, last push, licence, description" },
    { id: "packages", name: "Packages (deps.dev)", description: "Versions, publish dates, licences, deprecation and advisories for npm, PyPI, Go, Maven, Cargo, NuGet and RubyGems; query `npm:react`, `pypi:requests`, or a bare word for npm" },
    { id: "stackoverflow", name: "Stack Overflow", description: "How others solved a concrete error or pattern: accepted answers, scores, dates" },
    { id: "hn", name: "Hacker News", description: "Practitioner discussion, launches, opinions on tools" },
    { id: "reddit", name: "Reddit", description: "Practitioner experience (searched through a third party, Exa)" },
    { id: "arxiv", name: "arXiv", description: "Research papers" },
    { id: "x", name: "X", description: "Announcements, practitioner threads (searched through a third party, Exa)" },
  ].map((s) => Object.freeze(s)),
);

/** The ids of the built-in sources, in the default priority order. */
export const DEFAULT_ORDER = Object.freeze(BUILTIN_SOURCES.map((s) => s.id));

export const isBuiltinSourceId = (id) => DEFAULT_ORDER.includes(id);
export const builtinSource = (id) => BUILTIN_SOURCES.find((s) => s.id === id) ?? null;

/** The refusal of a save that left a built-in out. */
export const BUILTIN_NOT_REMOVABLE = "Built-in sources can be turned off, not removed";
/** The refusal of a draft that carries `sources` (agent_change / agent_propose). */
export const SOURCES_IN_SETTINGS = "Research sources are set in Settings → Research sources";
