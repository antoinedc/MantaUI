---
name: authoring
description: The shape of a good agent, the admission table, routing, pruning, and the agent_propose fields.
---
# Writing an agent

## Admission (before writing anything)

Mark every candidate rule:
- **General** — supported by good evidence across contexts, and the model would not do it unprompted.
- **Scoped** — true only in a named situation; write it with its condition ("When X, do Y").
- **Excluded** — weak, single-source, contradicted, generic advice, or something a capable model already does.
Write only General and Scoped rules. Put every candidate in the admission table you pass to `agent_propose`, with a
one-line why, so the user sees what you left out.

## Shape of the agent file

- **Frontmatter:** `name` (≤ 40), `description` (one line, what it does, ≤ 200), `use_when` and `not_for` (≤ 200
  each), `isolation` (`none` = read-only; `worktree` = edits code on its own branch). Leave `model` empty unless the
  charter names one.
- **Body, 100–150 lines at most:**
  1. One or two sentences: the job and what "done" means. No persona.
  2. **How you work** — a short numbered workflow for the job's main path. Decision points as "If X → Y".
  3. **Rules** — the admitted rules, each specific enough to check. Pair every "don't" with a "do".
  4. **Gotchas** — the failures the research found, each with what to do instead. This section earns the most.
  5. **What to report** — what the final message must contain.
- **Never include:** overviews of the domain, "you are a world-class expert", long mandatory checklists, rules for
  everything, examples that box the model into one way of working.
- **No research section.** Don't write a "when to look things up" or domain research section into the agent: every
  agent's task prompt already carries the generic research-library guidance. Add research rules only when the evidence
  shows a failure specific to this job (for example, a source the agent must always check).
- **Hard limits** are better as isolation than as prose: an agent that must not edit code is `isolation: none`.

## Routing

`use_when` decides whether Manta hands work to this agent. Write it as a routing rule, not a job title:
- Name the trigger this agent owns ("Search-engine and AI-search visibility of pages: metadata, structured data…").
- Check it against every sibling in the roster: a request meant for a sibling must not match. Adjust `not_for` to
  send near-misses to the right sibling by name.

## Improving an existing agent

- Read its current file (in your brief) and its recent failures if given.
- Re-check each existing rule: still true? still needed by today's models? A rule written to correct an older model can
  mislead a newer one. Removing rules is a good proposal.
- Change little and say why. One small, well-evidenced update beats a rewrite.

## `agent_propose` fields

- `action`: "create" or "update"; `agent` and `baseHash` (from the roster) for an update.
- `draft`: the fields you change (for create: name, description, isolation, instructions, and the routing lines).
  Instructions are the body only, without frontmatter.
- `summary` (≤ 600): what this changes and why, in plain words for the user.
- `evidence` (1–12): `{sourceId, quote, claim}` — the quote copied exactly from the fetched text.
- `admission` (≤ 40): `{rule, verdict, why}` for every candidate, including excluded ones.
