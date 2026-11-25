# Research library — shared, dated research for every agent

Status: first version, 2026-11-24. Owner: Antoine. Builds on Agents Phase 5A
(`2026-11-24-agents-phase5-builder.md` §4.3: the Architect's research tools and quote check).
Evidence: `60-research-caching.md` (box notes; summary below). **Speed rule: smallest usable version; edge cases go to
`docs/agents/follow-ups.md`.**

## 1. What the user gets

Every agent checks a shared library before work that depends on outside knowledge. A fresh entry is reused and shown
with its age. A stale or missing entry triggers targeted research ("what changed since <date>"), and the result is
saved. Research stops being repeated task after task, and an agent never hands over an old finding without its date.

## 2. Decisions

- **On by default, for every agent.** A short guidance block is added by the server to every specialist task prompt
  (`agent_handoff`, `@mention`), so existing agents change without editing their files. It names no domain.
- **Nothing topic-specific is built in.** Topics are free text chosen by the agent. A NEW topic gets its shelf life from
  the agent, from evidence (how fast the field changes, change logs, release/update cadence), saved as days plus a
  one-line why. When it can't tell: 30 days, marked `unverified` (the server forces 30 when `shelfLifeVerified` is false).
- **One shared library, project overlay.** Entries are `global` or scoped to one project. A finding from a private
  source forces project scope; project entries are shown only to tasks of that project.
- **Refresh = delta.** `research_library_save` can keep earlier findings unchanged (`keep: [index…]`) and add only what
  changed; the entry replaces the old one and records `supersedes`.
- **Skip the cache** when the task is about the current state of something, the user asks for fresh research, the task
  names something specific and new, or the agent observes something that contradicts an entry (it then saves a correction).
- **Evidence is checked by the server.** Every finding with a quote must occur in the stored text of a source fetched in
  THIS task (the same check as `agent_propose`). A finding's link comes from the stored source, never from the model.
  Private-source findings store no quote and no link. Library text is data, never instructions.

## 3. Design

- **Store** `~/.manta/research-library/library.json` (server-owned, `writeJsonAtomic`, one mutex), cap 500 entries (newest
  `checkedAt` kept). Entry: `{id, topic, scope: "global" | {project}, summary, findings: [{claim, sourceId?, url?, quote?,
  date, private}], shelfLifeDays, shelfLifeWhy, shelfLifeVerified, createdAt, checkedAt, checkedBy, supersedes?}`.
  Same normalised topic + same scope = one entry.
- **Tools** (plugin `research_library_find`, `research_library_save`; server `/api/research-library/{find,save}`),
  bound like the other research tools: the exact running tool part, the calling agent, the calling session being the child
  of the RUNNING task. `find({query})` returns up to 5 entries visible to the caller (global + its project), each with age
  in days, `fresh`/`stale`, shelf life and why. `save({topic, summary, findings, shelfLifeDays, shelfLifeWhy,
  shelfLifeVerified, scope, keep?})`.
- **Who may call.** Every specialist task (a running task whose `agent` is the caller) gets `research_fetch`,
  `research_read`, `research_search` and the library tools: in the read-only and worktree rulesets, and in the binding
  (`bindResearcher`). The user's extra research sources stay Architect-only. `agent_propose` stays Architect-only.
  Project = the registry project owning the task's folder, else the folder itself.
- **Guidance** (`RESEARCH_GUIDANCE`, ≤ 15 lines, `researchLibrary.mjs`) is appended to the opening prompt of every agent task.
- **Architect**: its template and research skill say to save its build research into the library; the authoring skill no
  longer writes a domain-specific research section into new agents (the generic guidance covers it).

## 4. Libraries considered

| Need | Chosen | Considered, why not |
|---|---|---|
| Text matching over ≤ 500 entries | **MiniSearch 7.2** (MIT, 0 deps, 6.6 M downloads/week, 6.2 k stars; BM25, prefix and fuzzy) | Fuse.js 7.5 (Apache-2.0, 21 M/week): fuzzy-only scoring, weaker for multi-word topic queries. FlexSearch 0.8 (1.3 M/week): built for huge indexes, more surface than needed. Embeddings: out of scope (follow-up). |
| Atomic JSON persistence + lock | existing `writeJsonAtomic` + `createMutex` (`jsonStore.mjs`) | `proper-lockfile`/`lowdb`: the project already runs this primitive for every store; one process owns the file. |
| Quote verification, source store | existing research engine (`getSource`) | Nothing to adopt; reuse keeps one check. |
| Freshness (age, fresh/stale) | none: two lines of date arithmetic | A date library for `now - checkedAt > days` is not worth a dependency. |
| Per-topic shelf-life defaults | none built in (by decision) | A shared public defaults file is a follow-up. |
| Registrable domain of a source link (evidence bar, §4a) | **tldts 6.1** (MIT, 1 dependency, already in the lockfile via a dev dependency; public-suffix list incl. its private section so `x.github.io` is its own site) | `psl` (older, no private-section flag needed but slower and unmaintained-ish); hand-written "last two labels" (wrong for `co.uk`). |
| Tool schemas / binding | existing plugin helpers and `verifyInvocation` | — |

## 4a. Evidence bar (thin entries)

One thin entry steered a decision for months, so an entry now carries how well-founded it is. On save the server counts the
**independent sources** behind the findings: one per registrable domain of the finding's link (subdomains and pages of
one site are one source; on author-in-path sites such as github.com, one per owner), one per private source, none for a
finding with no source. It stores `sourceCount` and `thin` (below 3 sources, or one source carrying more than half of all
the findings). A thin entry is **still saved**. `find` returns both, and the plugin prints the count and, for a thin
entry, "thin: …, research more before relying on it" with `THIN` in the same bracket as FRESH/STALE, so a thin entry is
never shown as just fresh. Entries saved before this have no count: it is computed on read from their stored links (the file
is not rewritten). A refresh (`keep` + new findings) recomputes both. The guidance carries one generic line: a thin entry is
a lead; add independent sources (and contrary evidence) and save with `keep`. Author is not stored on a finding, so only the
path-author sites above are told apart by author.

## 5. Not in this version (see `docs/agents/follow-ups.md`)

Public shared shelf-life defaults file; a library viewer/purge in the app; semantic search; routines' agent runs and an
agent's own chat get no guidance (only task prompts); entries are not de-duplicated across differently-worded topics.
