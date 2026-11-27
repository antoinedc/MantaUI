# Agents — Phase 7: Architect v2 (problem first, tested agents, skills, learning)

Status: draft for review (2026-11-27). Owner: Antoine. Builds on Phases 1–6 (`2026-11-22-agents-phase1.md` …
`2026-11-26-agents-screens.md`), the research library (`2026-11-24-research-library.md`) and the knowledge system
(`src/server/knowledge/`). Inspired by a comparison with Dispatch's agent fleet (agents.voska.org, 2026-11-27): its
Architect treats "a request for an agent [as] a request to solve a problem, not a requirement to create another record",
gives agents skills beyond one prompt, test-runs agents before calling them done, and learns from the owner's
corrections. We take the **process**, never its content.

**Speed rule: smallest usable version per stage; edge cases go to `docs/agents/follow-ups.md`.** Ship to `main`, no
release tags. Stages ship in order (0 → 1 → 2 → 3), each one usable alone.

## 0. Core principles (binding, from the user)

1. **Manta drives itself.** The default is to act, show what was done and make it undoable; asking is for answers that
   change what gets built and can't be found out. Everything automatic is visible (history, Tell-me feed, profile) and
   has Undo.
2. **A request for an agent is a request to solve a problem**, not an order to create a record. The Architect works out
   the problem first, considers the shapes that could solve it (including changing an existing agent or no change at
   all), and **may ask the user clarifying questions** when the shape is genuinely open.
3. **Proven skills first.** Before writing a skill, the Architect searches for existing, battle-tested skills (skill
   registries, GitHub, the box's installed skills) and prefers them over writing its own. Copying part of a skill is
   fine; licences are respected.
4. **No agent-design opinions in code or templates** (unchanged; the guard test in `agents.test.mjs` grows to cover the
   new texts). What good agent design is comes from the Architect's research and the shared library. The server
   enforces **process and facts** only: that a trial ran on this exact draft, that a quote is real, that a licence
   allows copying, that a replaced rule is gone.
5. Autonomy settings are not changed by this phase, except the one new action kind in §5.1 (default "Tell me").

## 1. What the user gets

1. **The Architect thinks before it builds.** Every proposal carries a **problem statement** (in the user's words) and
   the **shapes it considered** (e.g. a reviewer vs a designer, a new agent vs a change to an existing one vs no change).
   When the shape is open and would change the result, it asks — up to 3 questions in one card, with a recommended
   option — and keeps researching what's shared meanwhile.
2. **Agents are tested before they go live.** A new or changed agent is run on 1–3 sample tasks in a sandbox (one it
   should decline included). The change card shows the cases, what the agent did and the Architect's verdict. No
   passing test, no proposal.
3. **Edits replace, they don't append.** Each changed rule names the rule it replaces; the old text must be gone.
4. **Agents have skills.** Method files, checklists and scripts loaded only when needed, preferably taken from proven
   public skills, with their origin, licence and install count shown in the agent's profile.
5. **Agents learn from you automatically.** When you correct an agent's work, it learns a rule (with your words as the
   reason), scoped to that project. You see it in the agent's **Learned** tab and can undo it; nothing to approve.
6. **A weekly team check-up.** A server-built fact sheet (failures, undone changes, idle agents, duplicated rules, stale
   research, upstream skill updates) goes to the Architect, which proposes up to 3 fixes, tested like any other change.
7. **Built-in agents update on existing boxes** (Stage 0), so the improved Architect actually reaches every box.

## 2. Stage 0 — built-in templates reach existing boxes

Today `installBuiltIns()` copies a template only when the folder is missing, so `architect`, `manta` and `dev` never
update after install (`follow-ups.md`). Stage 1 changes the Architect's template, so this ships first.

- **History of shipped versions.** `src/server/agentTemplates/<slug>/.history.json` lists the sha256 of every shipped
  version of each template file (agent.md, each skill file), same idea as `AGENTS.history`. A script
  (`scripts/agents/template-history.mjs`) appends the current hashes; a test fails when a template changed without it.
- **Base copy.** On install and on every successful upgrade the shipped files are copied to
  `~/.manta/agents/<slug>/.base/` (same relative paths).
- **Upgrade on `sync()`**, per template file, outside the store mutex for I/O, under it for the decision:
  1. live == new template → nothing.
  2. live == base, or live's hash is in `.history.json` (box installed before `.base` existed) → replace with the new
     template, update `.base`.
  3. otherwise (the user or an applied change edited it) → **three-way merge** (`node-diff3`) of base → live and
     base → new. agent.md frontmatter merges key-wise (keys only the user set, e.g. the Architect's `sources`, are kept).
     Clean merge → apply.
     Conflict → a pending change record (kind `"template-update"`, `after` = the new template with the user's
     frontmatter keys) shown in Needs you; nothing applied.
  Every applied upgrade is a change record (kind `"template-update"`, release = the user's "Change an agent" level,
  as `change()` does today: Auto/Tell me → applied + Undo; Ask → pending; Never → discarded and logged).
- Files only in the new template are added; files the template dropped are removed only when live == base.

## 3. Stage 1 — problem first, replace-not-append, trial runs

### 3.1 Problem first (instructions + proposal fields)

- **Lead charter** (`agentTemplates/manta/agent.md`, `buildLeadBrief`): the charter quotes the user's request
  verbatim under "The user's words" and states the problem it solves; a role name the user used is reported as part of
  their words, not as a decision. (Text must pass the guard test; no shape advice.)
- **Architect step 1** (template): work out the problem, who has it and what outcome they want; list the shapes that
  could solve it (at least two, one of which may be "change an existing agent" or "no change"); pick one. When two
  shapes would produce materially different agents and neither the charter nor research settles it, **ask before
  researching that part** (question tool, ≤ 3 questions, recommended option first); research the shared ground while
  the question is open. Otherwise choose and state the assumption in the result.
- **A task may end with no proposal** and an outcome "No change needed: …" (e.g. an existing agent already covers it,
  with how to ask it). The result's Outcome line says so (server-written, like today's).
- **`agent_propose` gains a required `problem`** (create and update; refresh/check-up rounds too):
  ```ts
  problem: {
    userWords: string;          // 10–600 chars, must occur verbatim in the task's brief (fact check)
    statement: string;          // ≤ 300: the problem in one sentence
    shapes: { shape: string; wouldBuild: string }[];   // 2–5 entries
    chosen: number;             // index into shapes
    why: string;                // ≤ 600
  }
  ```
  Server checks only facts: `userWords` is in the brief (whitespace-normalised), 2–5 shapes, `chosen` in range. The
  problem block is shown first on the change card and in the result.

### 3.2 Replace, don't append

- Admission items gain `replaces?: string` (the exact old rule text, 20–600 chars) for update proposals.
- Server checks (facts): each `replaces` occurs in the base file (`baseHash` version) and does **not** occur in the new
  instructions; refused otherwise ("the rule you replace is still in the new text" / "isn't in the current file").
- The change card shows the body size before → after.
- Template instructions: every changed rule names what it replaces; superseded text is removed in the same proposal.

### 3.3 Trial runs (new module `src/server/agentTrials.mjs`)

Tools (Architect only, bound to the live Architect job like `agent_propose`; in `ARCHITECT_BLOCK_PERMISSION`):

| Tool | In → out |
|---|---|
| `agent_trial` | `{ action, agent?, baseHash?, draft, cases: { name, task, expect: "does" \| "declines", checks, project? }[1..3] }` → `{ trialId, draftHash }` (returns at once) |
| `agent_trial_wait` | `{ trialId }` → status + per-case summary; waits ≤ 4 min per call |
| `agent_trial_read` | `{ trialId, case, offset? }` → the case transcript text, 20 000 chars per window |

- **Draft hash** = sha256 over the normalised draft that would be written: agent.md after the edit + every skill file
  (Stage 2). `agent_propose` recomputes it.
- **Materialise**: the draft goes to `~/.manta/agents/.trials/<trialId>/` (agent.md, skills, compiled prompt) and a
  temporary opencode block `agent-trial-<trialId>` (recorded in `.installed.json`, removed when the trial ends; boot
  sweeps leftovers).
- **Run** each case as a headless internal session (`withInternalMarker`, as `knowledge/trial.mjs`), never a sidebar
  row, prompt = the case `task` as a brief. Folder: a throwaway git worktree of the case `project` (registry slug; the
  agent's first seat when omitted) at its default branch, or an empty scratch repo
  `~/.manta/agents/.trials/scratch-<trialId>` when there is none. Read-only agents (`isolation: none`) run read-only in
  that folder.
- **Ruleset** = the agent's normal task ruleset (by isolation) plus trial overrides: the deploy / publish /
  send-external / delete-data / spend kinds at "never" whatever the user's settings; `git push`, `gh pr`, `gh release`,
  `gh issue`, `gh api -X` / `--method` denied; secrets tree denied (as today). The `question` tool is answered at once
  with "This is a test run with no user: continue on your best assumption and say what you assumed"; the question is
  recorded as "would ask".
- **Limits**: 15 min per case, ≤ 3 cases per trial, ≤ 3 trials per root task, ≤ 2 cases running box-wide (FIFO, own
  queue, not the delegate cap). Model = the draft's `model`, else Auto.
- **Recorded per case**: end state (done / failed / timed out), final answer, tools used, files changed (diff stat in
  the worktree), refused actions (permission denials), "would ask" questions, duration, the transcript. Stored in
  `~/.manta/agents/.trials/<trialId>/result.json`, kept 30 days (the profile Tests tab reads it), worktrees and blocks
  removed at the end.
- **Grading is the Architect's judgement.** `agent_propose` gains a required `trial` for every create, and for every
  update that changes instructions, skills, isolation or model:
  ```ts
  trial: { trialId: string; verdicts: { case: string; pass: boolean; quote: string; note: string }[] }
  ```
  Server checks (facts): the trial belongs to this root task, its draft hash equals the proposal's, every case reached
  an end state, there is a verdict for every case, every `quote` (20–300 chars) occurs in that case's transcript, and
  every verdict is `pass`. A failing case → refused: "Case <name> failed: fix the draft and run a trial again."
  Description / colour / routing-only updates need no trial.
- Lead's `agent_change` (small dictated edits) is unchanged and needs no trial.

### 3.4 What the user sees (Stage 1)

- Change card: Problem block first (user's words, shapes, chosen + why), then the diff, size delta, trial cases
  (name, expected, verdict, the quote, Details → transcript in the task side panel), then evidence.
- Agent profile **Tests** tab (the reserved one): trials for this agent, newest first (date, draft → change link,
  cases with verdicts).
- Architect create/rework task card: its own steps (as today) plus a "Trial running · case 2 of 3" line from
  `jobProgress`.

## 4. Stage 2 — skills

### 4.1 Bundle and proposals

- An agent's skills live in `~/.manta/agents/<slug>/skills/<name>/` (exists today, compiled as an index into
  `.compiled.md`; kept — see §8 on native skills): `SKILL.md` (frontmatter `name`, `description`) plus up to 20 text
  files. Limits: name `[a-z0-9-]{1,50}`, relative paths without `..`/absolute/symlinks, UTF-8 text without NUL, ≤ 256 KiB
  per skill, ≤ 1 MiB per agent, ≤ 15 skills per agent.
- Proposal `draft` gains:
  ```ts
  skills?: { name: string; op: "add" | "replace" | "remove";
             files?: { path: string; content: string; origin: "copied" | "written" }[];
             provenance?: SkillProvenance }[]
  SkillProvenance = { url: string; repo: string; ref: string /* commit sha or tag */; licence: string /* SPDX */;
                      taken: "whole" | "part"; registry?: { installs: number | null; stars: number | null } }
  ```
- Provenance is written to `skills/<name>/SOURCE.md` (server-generated: origin link, ref, licence, what was taken,
  install count/stars at the time) and shown in the compiled index and the profile.
- **Facts checked by the server:**
  - a `copied` file's content occurs (whitespace-normalised) in a source fetched by this task (`research.getSource`), and
    the skill has a `provenance` whose `url` was fetched in this task;
  - copying needs a permissive or attribution licence: allowlist `MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC,
    0BSD, Unlicense, CC0-1.0, CC-BY-4.0, MPL-2.0`. Anything else, unknown or missing → copied files refused; the
    Architect may write its own text and cite the skill as research. For Apache-2.0 / CC-BY / MPL / BSD the upstream
    licence text must be included as a `copied` file `LICENSE` (attribution);
  - a skill `add` needs `skillSearch` (§4.2).
- **Snapshots cover the bundle.** Change records snapshot agent.md + `skills/**` (+ `learned/**`, Stage 3) as
  content-addressed blobs in `~/.manta/agents/.blobs/<sha256>` (records hold `{path: sha}` maps; replaces the 64 KiB
  inline `before`/`after` for new records; old records still read). Undo / Restore / History work on the whole bundle;
  blobs no record references are swept after the record is pruned.

### 4.2 Finding proven skills

- **New research source `skills`** (built in, always available to the Architect): runs the pinned `skills` CLI
  (`npx -y skills@1.9.1 find <query>`, no shell, query as one argument, 40 s timeout, `npm_config_cache` in the box
  cache) and returns `owner/repo@skill`, install count and skills.sh URL per hit.
- **New tool `skills_installed`** (Architect): skills already on this box — `~/.config/opencode/skills`,
  `~/.agents/skills`, `~/.claude/skills`, and every team agent's `skills/` — name, description, folder, and for copied
  agent skills their provenance.
- GitHub (`research_search github`, stars / last push / licence) and `research_fetch` of `SKILL.md` and its files stay
  the way to read a candidate.
- Proposal field, required when any skill is added:
  ```ts
  skillSearch: { queries: string[] /* each run via the skills source or github in this task */;
                 candidates: { ref: string; installs: number | null; stars: number | null; licence: string | null;
                               verdict: "used-whole" | "used-part" | "rejected"; why: string }[] }
  ```
  Server checks that each query was run by this task and each candidate `ref` appeared in a result it got. Ranking
  (installs, stars, recency, fit) is the Architect's judgement.
- Template process text: search before writing; prefer a proven skill; take only the parts that fit; write your own
  only when nothing suitable exists, and say why in `skillSearch`.
- **Upstream updates**: the monthly refresh and the weekly check-up (§5.2) list copied skills whose upstream `ref` moved
  (`git ls-remote`, bounded, cached 1 day); the Architect may propose an update (new trial required).

### 4.3 Who can change skills

Only Architect proposals (create, update, refresh, check-up). The lead's `agent_change` stays instructions/fields only.

## 5. Stage 3 — learning

### 5.1 Learned preferences (automatic)

- **Signals** attributed to one agent task (root job → agent slug + project):
  1. user messages in the task's own session;
  2. in the parent chat, the user's next turn after that task's result card when the lead then continues that task
     (`continueJob`) or mentions the agent;
  3. answers to the task's questions where the user picked a non-recommended option or typed their own text;
  4. the user undoing or rejecting a change the task made, discarding its branch, or marking its Needs-you item
     "didn't need me";
  5. commits by the user on the task's branch after the task's last commit (silent edits; diff only, ≤ 20 KiB).
- **Extraction**: 30 min after a task's last signal (or 30 min after it ends with signals), one cheap-model call (the
  knowledge curator's model setting) gets the signals plus the relevant agent output and returns 0–3 candidates:
  `{ rule, why, whyIsInferred, quote, scope: "project" | "all", replacesId? }`. Server facts: `quote` occurs verbatim
  in a user-authored message/answer from the signals (or is a diff hunk the user authored); `rule` ≤ 300 chars; dedupe
  against existing rules (normalised text); `replacesId` must exist.
- **Storage**: `~/.manta/agents/<slug>/learned/<project>.md` and `learned/_all.md`, one entry per rule (id `lr_<hex>`,
  date, rule, why, quote, source task). Compiled into the prompt for tasks in that project (plus `_all`) under a fixed
  heading "What the user has taught you". ≤ 30 rules per file; when full, the least recently reinforced rule is
  archived (kept in history, not compiled). A new correction that contradicts a rule replaces it.
- **Automatic**: written at once as a change record (kind `"learned"`). New autonomy action kind **"learn a
  preference"**, default **Tell me** in every mode (applied + listed in the Tell-me feed + Undo); Ask → pending card;
  Never → not learned. The level is shown and changeable in Settings → Agents like the others.
- **Promotion**: the same rule learned in 2 projects moves to `_all` (a `"learned"` change).
- **Undo** removes the rule; the same quote never produces it again (tombstone by quote hash).
- **Who learns**: team agents and the Architect (it learns how the user likes agents built). Not the lead (the knowledge
  system covers Manta).
- The Architect sees an agent's learned rules when reworking it and may fold a durable one into the instructions
  (`replaces: "lr_<id>"`, which retires the learned rule when applied).
- Profile **Learned** tab: rules per scope with the quote, why (marked "inferred" when it is), date, source task link,
  Undo.

### 5.2 Weekly team check-up

- New internal routine kind `"fleet-checkup"` (`routines.createInternal`), one per box, provisioned like refresh
  routines (recorded in `.fleet.json`, never recreated after the user deletes it), cron `0 9 * * 1` box-local,
  `rollUp: true`, notify on findings.
- **Fact sheet** (server, no model), last 7 and 30 days, per team agent: tasks run; finished / failed / cut off /
  stalled; ended "needs a decision"; median duration; results the user rejected / undid / marked "didn't need me";
  changes undone; learned rules added / undone; trials failed; research basis entries stale or thin; copied skills
  with upstream updates; instruction size; agent and absolute-path references in its files that no longer resolve;
  rules repeated across 3+ agents (normalised sentence match); idle (no task in 30 days).
- **Architect round** with the fact sheet as its brief: "Check the team: propose only changes the facts and your
  research support (max 3)". All Stage 1–2 bars apply (problem, trials, replaces, skills). Retiring an agent is a
  recommendation in the report, never an automatic deletion.
- **Release (self-driving)**: refresh and check-up rounds today run in mode `"unknown"` and always wait for a click.
  They now follow the user's **"Change an agent"** level for the current mode (Auto / Tell me → applied with Undo;
  Ask → pending; Never → discarded), with the same exceptions as build mode (lead, core, raising isolation → pending).
- Report: a routine report with the highlights of the fact sheet and the Outcome lines; pending proposals appear in
  Needs you.

## 6. Contracts

### 6.1 Types (`src/shared/types.ts`)

```ts
export interface AgentProblem { userWords: string; statement: string;
  shapes: { shape: string; wouldBuild: string }[]; chosen: number; why: string }
export interface TrialCase { name: string; task: string; expect: "does" | "declines"; checks: string; project?: string }
export interface TrialCaseResult { name: string; expect: "does" | "declines";
  state: "queued" | "running" | "done" | "failed" | "timed-out";
  finalAnswer: string | null; tools: string[]; filesChanged: number; refused: string[]; wouldAsk: string[];
  durationMs: number | null }
export interface AgentTrial { id: string; rootJobId: string; agentSlug: string | null; draftHash: string;
  createdAt: number; cases: TrialCaseResult[] }
export interface TrialVerdict { case: string; pass: boolean; quote: string; note: string }
export interface SkillProvenance { url: string; repo: string; ref: string; licence: string; taken: "whole" | "part";
  registry?: { installs: number | null; stars: number | null } }
export interface AgentSkillInfo { name: string; description: string; files: number; bytes: number;
  provenance: SkillProvenance | null }
export interface LearnedRule { id: string; scope: string /* project slug | "_all" */; rule: string; why: string;
  whyIsInferred: boolean; quote: string; createdAt: number; sourceJobId: string | null; archived: boolean }
// AgentChange gains: kind?: "proposal" | "change" | "template-update" | "learned";
//   problem?: AgentProblem; trial?: { id: string; verdicts: TrialVerdict[] }; sizeBefore?: number; sizeAfter?: number;
//   skills?: { name: string; op: "add" | "replace" | "remove"; provenance: SkillProvenance | null }[];
//   learned?: { added?: LearnedRule; removedId?: string }
// AgentProfile gains: skills: AgentSkillInfo[]; learned: LearnedRule[]; trials: AgentTrial[] (≤ 20, newest first)
```

### 6.2 RPC + tools

| `window.api` | channel | in → out |
|---|---|---|
| `agentsTrial` | `agents:trial` | `{id}` → `AgentTrial` (no transcripts) |
| `agentsTrialTranscript` | `agents:trial-transcript` | `{id, case, offset?}` → `{text, nextOffset \| null}` |
| `agentsLearnedUndo` | `agents:learned-undo` | `{slug, id}` → `{ok:true}` (goes through the change store) |

Plugin tools (`docs/opencode-plugins-v2/manta/tools/agents.ts`): `agent_trial`, `agent_trial_wait`, `agent_trial_read`,
`skills_installed`; `agent_propose` gains `problem`, `trial`, admission `replaces`, draft `skills`, `skillSearch`.
Research source `skills` in `src/server/research/` (beside `extra.mjs`). Tool descriptions describe **mechanics only**
(guard test).

## 7. Security

- Trials run model-written agents on the user's box. Containment: throwaway worktree, kind overrides at "never",
  push/PR/release/issue/API-write commands denied, secrets tree denied, no user questions, 15-min ceiling, cleanup.
  Bash pattern denies are best effort (as `jobRules` says); the honest limit is stated in the Tests tab ("runs on this
  box with your agent's permissions, minus publishing and sending"). Network reads stay allowed.
- Copied skill files are text only and never executed by Manta; an agent with bash could run a copied script, the same
  as a script it writes itself. The change card marks copied scripts (`*.sh`, `*.py`, `*.js`, shebang) so they are seen
  before Apply on Ask, and in the Tell-me feed otherwise.
- Skill content enters a prompt only through the compiled index pointer (the agent reads the file); learned rules are
  compiled as quoted user text under a fixed heading. No model text is inserted into Manta's own instructions.
- `skills find` runs a pinned version, no shell, query as one argv entry; output parsed, never executed.
- Template upgrade never overwrites a user-edited file without a clean three-way merge.

## 8. Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Search proven skills | `skills` CLI (vercel-labs/skills: MIT, 41.1k ★, pushed 2026-11-27; npm `skills` 1.9.1, 4.97 M dl/wk, 3 deps) — **search only** (`find` is non-interactive and returns installs) | Its `add` installs into global dirs for every agent — not per agent, not reviewable; we vendor content through proposals instead |
| Skill sources | anthropics/skills (201k ★, licence per skill), openai/skills (29k ★), GitHub search | — (read via `research_fetch`; licence checked per skill) |
| Three-way merge of templates | `node-diff3` 4.0.0 (MIT, 0 deps, 1.22 M dl/wk, published 2026-11-13) | `diff3` (axosoft, last publish 2022), `three-way-merge` (1.7k dl/wk, 2022): unmaintained |
| Trial sandbox | existing headless internal sessions + rulesets (`knowledge/trial.mjs`, `delegate.mjs` rulesets) | Freestyle VMs: real isolation but cost per run and needs spend approval → `follow-ups.md`; `scripts/opencode-v2/sandbox.mjs` is a test harness, not a runtime |
| Correction extraction | existing `knowledge/corrections.mjs` classifier + curator model setting | a new classifier: duplicate |
| Licence check | SPDX id string allowlist + GitHub API `license.spdx_id` | `spdx-satisfies` etc.: expressions not needed for a flat allowlist (trivially small) |
| Snapshots | content-addressed files (sha256) | a VCS library: overkill for whole-file snapshots |
| Native OpenCode skills per agent | **not now**: the compiled index keeps skills scoped by construction | V2 filters `<available_skills>` by a `skill` permission per agent (seen in the binary, unverified on 2.0.30) → spike in `follow-ups.md` |

UI: modern-web-guidance consulted for the Tests / Learned tabs during implementation (`tabs`, `details`), cited in the PR.

## 9. Tests

- Stage 0: upgrade matrix (unchanged / known-history / user-edited clean merge / conflict → pending / added + dropped
  files / Architect `sources` kept); `.history.json` freshness test.
- Stage 1: `problem` fact checks; `replaces` present-in-base and absent-in-new; trial lifecycle with injected sessions
  (queue cap 2, 15-min timeout, cleanup of block + worktree on success/failure/boot); question auto-answer recorded;
  ruleset overrides contain the never-kinds and push/PR denies; `agent_propose` refuses: missing trial, other task's
  trial, hash mismatch, unfinished case, quote not in transcript, a failing verdict; description-only update needs no
  trial.
- Stage 2: skill path/size/name limits; `copied` content check; licence allowlist (MIT ok, GPL refused, missing
  refused, Apache requires LICENSE file); `skillSearch` queries/candidates must come from this task's results; bundle
  snapshots + Undo restore skills; `skills` source parses fixture output and refuses shell metacharacters as arguments
  (argv only).
- Stage 3: signal attribution (each of the 5 kinds); quote-verbatim check; replace on contradiction; cap 30 + archive;
  promotion at 2 projects; tombstone after Undo; autonomy level paths (Tell me / Ask / Never); check-up fact sheet on
  fixture jobs/changes; check-up and refresh release follow the mode's level.
- Guard test: extended to every new template/skill text and tool description.
- Live: one real Architect rework of `@ux-ui-review` → product designer (acceptance; §10).

## 10. Implementation split and order

One code-editing task at a time (one @dev job per chat). Each PR: targeted tests locally, full suite on CI.

1. **PR A — Stage 0 + Stage 1 server** (`agents.mjs`, new `agentTrials.mjs`, `delegate.mjs` hooks, plugin tools,
   `package.json` + `node-diff3`, `.history.json` + script, tests).
2. **PR B — Stage 1 templates + renderer**: Architect + lead template texts (process only; written by the lead
   session, reviewed against the guard), change card Problem/Trial/size, Tests tab, task progress line.
3. **PR C — Stage 2** (server + renderer Skills section + card skill diffs).
4. **PR D — Stage 3** (learning + check-up, Learned tab, autonomy kind, Settings row).
5. **Acceptance**: hand `@architect` the request "I want a UX/UI agent that designs the product's UI, not only reviews
   it" for `@ux-ui-review`; check the result uses every stage (problem + shapes, possible question, proven skills,
   trials, replaces).

## 11. Later (follow-ups.md)

Native OpenCode skill scoping per agent; trials on Freestyle VMs for agents with bash; trial cases generated from real
past tasks; learning for the lead; showing a skill's upstream diff before an update; usage-based routing checks
(requests the lead did itself while an agent fit).

## 12. Review log

(pending)
