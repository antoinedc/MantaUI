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
  each), `isolation` (`worktree` = works on its own branch and can edit files, the default; `none` = read-only). Leave `model` empty unless the
  charter names one.
- **Body:** the agent's instructions, without frontmatter.
- **No research section.** Manta adds the generic research-library guidance to every
  agent's task prompt; don't write a research section into the file.
- **Isolation:** agents work on their own branch and can edit files by default (`worktree`), so they can deliver
  finished work such as mockups, docs, specs and code. Use `none` (read-only) only when the job is purely advisory and
  the user asked for that; a hard limit is better as isolation than as prose.

## Skills

An agent's `skills/<name>/` folder holds method files it reads when it needs them.
- **Files:** `SKILL.md` with frontmatter `name` (the folder name, 1–50 lowercase letters, digits and dashes) and `description`,
  plus up to 20 text files in all (paths are relative, up to 4 folders deep, compared without regard to case). A skill is at most
  256 KiB, an agent's skills at most 1 MiB, and an agent has at most 15 skills. The `description` is at most 300 characters. The
  Architect's own and Manta's own skills ship with Manta: a draft that changes them is refused.
- **Draft:** `draft.skills` is a list of `{name, op, files?, provenance?, installed?}`. `op` is `add`, `replace` (the skill's whole folder is
  swapped for the files you send) or `remove` (no files). Each file is `{path, content, origin, sourceId?}`; `origin` is `copied`
  (text unchanged from a page you fetched, with that page's `sourceId`; at least 20 characters, never from a private source) or
  `written` (yours). `SOURCE.md` and `LICENSE` are written by the server; don't send them. A copied file must be a contiguous piece
  of its page: only line endings and trailing spaces may differ, never newlines or indentation, so a shell line stays the line it
  was. All copied files of one skill come from the provenance page or from other pages of the same GitHub repository. A written
  file that holds a passage of 400 or more characters found verbatim in a page you fetched is refused: label it copied, with provenance.
- **A skill installed on this box** (listed by `skills_installed`) is taken by reference, with no file text from you:
  `{name, op, installed: {skill, taken, take?}}`. `skill` is its name or folder as listed (pass the folder when two share a name);
  `taken` is `whole` (every file) or `part` (SKILL.md plus the paths in `take`, files or folders such as `["reference"]`; leave
  `scripts/` out to take the text without the commands). The server copies the files and writes `SOURCE.md` from the folder itself
  (its licence is read from its SKILL.md frontmatter, its own `SOURCE.md` or its licence file, and must be one of the allowed ones
  below). It takes no `files` and no `provenance`; the skill's own frontmatter name is the `name`. The 20-file and 256 KiB limits
  don't apply (you type nothing), the agent's 250 files and 1 MiB do; links, non-text files and paths the rules above refuse
  are named in the refusal, and a hidden file is left out. Scripts that come along are read by the independent check like any other.
- **Provenance** (needed when any file is copied): `{url, sourceId, repo, ref, licence, taken, licenseSourceId?, registry?}` —
  `url` is the address of the page `sourceId` was fetched from and must be a github.com (or raw.githubusercontent.com) page of the
  repository; `repo` is `owner/repo` and `ref` the commit (40 hex characters) or tag, and both must agree with the address (the
  server reads them from it, and a `/blob/<ref>/` in the address is the ref); `taken` is `whole` or `part`, `registry` the installs
  / stars you saw, if any.
- **Licences you may copy under:** MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, CC-BY-4.0,
  MPL-2.0 (the SPDX id). Any other, unknown or missing licence can't be copied: write your own and cite what you learned as
  research. Every one of them except 0BSD, Unlicense and CC0-1.0 needs `licenseSourceId`, the source id of the fetched licence file:
  a page of the same repository that holds that licence's own text. For those three, a licence file isn't needed, but the licence must
  be stated on a fetched page of the repository (the provenance page, or a licence file you pass as `licenseSourceId`).
- **`skillSearch`** goes with an added skill: `{queries: [{source, query}], candidates: [{ref, installs, stars, licence, verdict,
  why}]}`. Each query must be one you ran with `research_search` in this task; each candidate `ref` (`owner/repo@skill`,
  `owner/repo`, an address, or an installed skill's name) must have appeared in a result or in `skills_installed`; `verdict` is
  `used-whole`, `used-part` or `rejected`.
- A skill change needs a trial like any change to the agent: the skill files are part of the draft that runs.
- A skill with a script (`.sh`, `.py`, `.js`, `.mjs`, `.ts`, `.rb`, `.pl`, `.ps1`, `.bat`, `.cmd`, or a file starting with `#!`), copied or
  written, is read first by an independent check: another model, no tools, seeing only the scripts, the SKILL.md, the origin and the agent's
  name and description (never your transcript or the pages you read). A clean verdict lets the change follow the user's setting; a flagged
  one, or a check that couldn't run, waits for the user's click. A skill of text only is not checked.

## Routing

`use_when` decides whether Manta hands work to this agent; `not_for` sends near-misses elsewhere. Write both the way
your research says routing works best, and check them against the roster in your brief.

## Improving an existing agent

Read its current file (in your brief) and its recent failures if given, then pass its `baseHash` with the update.

## `agent_propose` fields

- `action`: "create" or "update"; `agent` and `baseHash` (from the roster) for an update.
- `draft`: the fields you change (for create: name, description, isolation, instructions, and the routing lines), and `skills`.
  Instructions are the body only, without frontmatter. A draft may change only its skills.
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
- `trial`: `{trialId, verdicts}` — required for a new agent and for an update of instructions, skills, isolation or model. It is the
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
