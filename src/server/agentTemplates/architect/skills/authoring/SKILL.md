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
- `admission` (≤ 40): `{rule, verdict, why}` for every candidate, including excluded ones. On an update, an item may add
  `replaces` (10–600 characters of the current instructions that this rule replaces: they must be in the current
  instructions and gone from the new ones) or `revises` (the same, for a rule that is reworded: it must be in the current
  instructions; it may stay in some form). One of the two at most. A quote that isn't in the current instructions is refused.
- `problem`: `{userWords, statement, shapes, chosen, why}` — `userWords` (10–600) is copied exactly from the request any round
  of your task was given; `statement` (≤ 300) is the problem; `shapes` are the 2–5 shapes you listed, each `{shape,
  wouldBuild}` (1–5 in a refresh or check-up round); `chosen` is the index of the one you picked; `why` (≤ 600). Refused
  when the words aren't in the request.
- `trial`: `{trialId, verdicts}` — required for a new agent and for an update of instructions, isolation or model. It is the
  trial you ran on exactly this draft (`agent_trial`), with one verdict `{case, pass, quote, note}` per case: `quote` is
  20–300 characters copied exactly from what the agent did in that case, its messages or tool calls in the transcript (`agent_trial_read`), never the task text. Refused when the trial belongs to
  another task, ran on a different draft (the refusal names the files), has a case that didn't finish, lacks a verdict or
  has one that isn't a pass ("Case <name> failed: fix the draft and run a trial again").
- `fitCheck`: `{researchSays, matches, why, basis}` — your fit check, also the first block of your result: what your research says
  about this kind of request, whether the request matches it (`matches`, true or false), and why. A proposal with no fit
  check is refused. When `matches` is false, ask the user with the question tool first; the proposal is refused until you have.
  `basis` lists the library entries the fit check rests on (entry ids or exact topics, 1–10), at least one per topic you
  researched for this request. Each must exist, be fresh and rest on at least 3 independent sources; a missing, stale or
  thin entry refuses the proposal, naming it. Research more and save it again with `keep`; if you still can't reach the
  bar, ask the user and say you couldn't establish it, and the thin entry is then allowed (the card shows the evidence was thin).
