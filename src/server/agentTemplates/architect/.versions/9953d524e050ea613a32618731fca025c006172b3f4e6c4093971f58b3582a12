---
name: authoring
description: The shape of a good agent, the admission table, routing, pruning, and the agent_propose fields.
---
# Writing an agent

## Admission (before writing anything)

Mark every candidate rule:
- **General** — supported by good evidence across contexts.
- **Scoped** — true only in a named situation; write it with its condition ("When X, do Y").
- **Excluded** — weak, single-source or contradicted.
Write only General and Scoped rules. Put every candidate in the admission table you pass to `agent_propose`, with a
one-line why, so the user sees what you left out.

## Shape of the agent file

What the file is made of; how to write it well is for your research to decide.
- **Frontmatter:** `name` (≤ 40), `description` (one line, what it does, ≤ 200), `use_when` and `not_for` (≤ 200
  each), `isolation` (`none` = read-only; `worktree` = edits code on its own branch). Leave `model` empty unless the
  charter names one.
- **Body:** the agent's instructions, without frontmatter.
- **No research section.** Manta adds the generic research-library guidance to every
  agent's task prompt; don't write a research section into the file.
- **Hard limits** are better as isolation than as prose: an agent that must not edit code is `isolation: none`.

## Routing

`use_when` decides whether Manta hands work to this agent; `not_for` sends near-misses elsewhere. Write both the way
your research says routing works best, and check them against the roster in your brief.

## Improving an existing agent

Read its current file (in your brief) and its recent failures if given, then pass its `baseHash` with the update.

## `agent_propose` fields

- `action`: "create" or "update"; `agent` and `baseHash` (from the roster) for an update.
- `draft`: the fields you change (for create: name, description, isolation, instructions, and the routing lines).
  Instructions are the body only, without frontmatter.
- `summary` (≤ 600): what this changes and why, in plain words for the user.
- `evidence` (1–12): `{sourceId, quote, claim}` — the quote copied exactly from the fetched text.
- `admission` (≤ 40): `{rule, verdict, why}` for every candidate, including excluded ones.
- `fitCheck`: `{researchSays, matches, why}` — your fit check, also the first block of your result: what your research says
  about this kind of request, whether the request matches it (`matches`, true or false), and why. A proposal with no fit
  check is refused. When `matches` is false, ask the user with the question tool first; the proposal is refused until you have.
