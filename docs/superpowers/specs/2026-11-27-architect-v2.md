# Agents — Phase 7: Architect v2 (problem first, tested agents, skills, learning)

Status: reviewed, ready to implement (2026-11-27; Gemini 4 Argon, 3 rounds, see §12). Owner: Antoine. Builds on Phases 1–6 (`2026-11-22-agents-phase1.md` …
`2026-11-26-agents-screens.md`), the research library (`2026-11-24-research-library.md`) and the knowledge system
(`src/server/knowledge/`). Inspired by a comparison with Dispatch's agent fleet (agents.voska.org, 2026-11-27): its
Architect treats "a request for an agent [as] a request to solve a problem, not a requirement to create another record",
gives agents skills beyond one prompt, test-runs agents before calling them done, and learns from the owner's
corrections. We take the **process**, never its content.

**Speed rule: smallest usable version per stage; edge cases go to `docs/agents/follow-ups.md`.** Ship to `main`, no
release tags. Stages ship in order (0 → 1 → 2 → 3), each one usable alone.

## 0. Core principles (binding, from the user)

1. **Manta drives itself.** The default is to act, show what was done and make it undoable; asking is for answers that
   change what gets built and can't be found out. Everything automatic is visible (profile History / Learned / Tests,
   the Fleet recap line "<Agent> was changed (your setting: <level>)" that exists today) and has Undo.
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
5. Autonomy settings are not changed by this phase, except the one new server-side kind in §5.1 (default "Tell me").

## 1. What the user gets

1. **The Architect thinks before it builds.** Every proposal carries a **problem statement** (quoting the request) and
   the **shapes it considered** (e.g. a reviewer vs a designer, a new agent vs a change to an existing one vs no
   change). When the shape is open and would change the result, it asks — up to 3 questions in one card, recommended
   option first — and keeps researching what's shared meanwhile.
2. **Agents are tested before they go live.** A new or changed agent is run on 1–3 sample tasks in a throwaway copy of
   the project (one it should decline included). The change card shows the cases, what the agent did and the
   Architect's verdict. No passing test, no proposal.
3. **Edits replace, they don't append.** A changed rule names the rule it replaces; the old text must be gone.
4. **Agents have skills.** Method files, checklists and scripts loaded only when needed, preferably taken from proven
   public skills, with origin, licence and install count shown in the agent's profile.
5. **Agents learn from you automatically.** When you correct an agent's work, it learns a rule (your words as the
   evidence), scoped to that project. You see it in the agent's **Learned** tab and can undo it; nothing to approve.
6. **A weekly team check-up.** A server-built fact sheet (failures, undone changes, idle agents, duplicated rules,
   stale research, upstream skill updates, finished branches nobody merged) goes to the Architect, which proposes up to
   3 fixes, tested like any other change.
7. **Built-in agents update on existing boxes** (Stage 0), so the improved Architect reaches every box.

## 2. Stage 0 — built-in templates reach existing boxes

Today `installBuiltIns()` copies a template only when the folder is missing, so `architect`, `manta` and `dev` never
update after install (`follow-ups.md`).

- **History of shipped versions.** `src/server/agentTemplates/<slug>/.history.json`: `{ "<relative path>": [sha256,
  …] }` for every file ever shipped. `scripts/agents/template-history.mjs` appends current hashes; a test fails when a
  template file's hash is missing from it.
- **Base copy.** On install and on every applied upgrade the shipped files are copied to
  `~/.manta/agents/<slug>/.base/` (same relative paths; `scan()` already skips dot entries).
- **When:** `upgradeBuiltIns()` runs **once in `init()`**, after `installBuiltIns()` and `recover()`, before the first
  `sync()`. Never inside `sync()`/`syncLocked()` (which run from `list()` and mid-activation). It takes the store lock
  for the decision + record write, does file I/O outside it, then calls `sync()` once.
- **Per file**, with `live` = file on disk, `base` = `.base` copy (else the newest `.history.json` hash that matches
  `live`, else none), `next` = shipped:
  1. `live == next` → nothing (refresh `.base` if missing).
  2. `live` matches `base` or any `.history.json` hash → replace with `next`.
  3. otherwise merge:
     - `agent.md`: split with `splitFrontmatter()`. Frontmatter key-wise over keys of `next ∪ live`: `live[k] ==
       base[k]` → take `next[k]`; `next[k] == base[k]` → keep `live[k]` (user overrides like `model`, `color`,
       `sources`); both changed differently → conflict. Body: `node-diff3` `diff3Merge(live, base, next)` on lines.
       Result must pass `parseAgentMd()` (and the Architect's source checks).
     - other files: `diff3Merge` on lines.
     - no base known → conflict.
     Clean → apply; conflict → pending (below).
- **Records.** Each upgrade of one agent is one change record: `kind: "update"`, `origin: { kind: "template-update",
  templateHash }` (`templateHash` = sha256 of the shipped bundle), `before`/`after` = agent.md text (as today) plus
  bundle maps (§4.1). **Release is automatic, whatever the user's "Change an agent" level (Ask and Never included):** that
  setting governs agents changing agents; a shipped template is a Manta release the user already took. A clean upgrade is
  applied at once, with Undo on its card. Only a merge conflict waits as a pending card in Needs you (the card shows the
  shipped text with the user's frontmatter keys; Apply overwrites the body, and a click is not blocked by the level).
- **Dedupe:** skip creating a record when one exists for the same `(slug, origin.templateHash)` in any state
  (pending, applied, discarded, undone; an expired one doesn't count, so an update nobody clicked is offered again at the next boot). `.base` is updated when the record applies (incl. a later click) and restored
  to the record's previous base on Undo.
- Files only in `next` are added; files `next` dropped are removed only when `live` matches base/history.

## 3. Stage 1 — problem first, replace-not-append, trial runs

### 3.1 Problem first (instructions + proposal fields)

- **Lead charter** (`agentTemplates/manta/agent.md`, `buildLeadBrief`): the charter quotes the user's request
  verbatim under "The user's words" and states the problem it solves; a role name the user used is reported as part of
  their words, not as a decision. (Guard test applies.)
- **Architect step 1** (template, process only): work out the problem, who has it and the outcome wanted; list the
  shapes that could solve it (one may be "change an existing agent" or "no change"); pick one. When two shapes would
  produce materially different agents and neither the charter nor research settles it, ask before researching that
  part (question tool, ≤ 3 questions, recommended option first), researching shared ground meanwhile. Otherwise
  choose and state the assumption in the result.
- **A task may end with no proposal**: the result says "No change needed: …" (e.g. who already covers it). The
  server's Outcome lines say "No change was proposed" (new fixed sentence) when a finished Architect task has none.
- **`agent_propose` gains a required `problem`:**
  ```ts
  problem: {
    userWords: string;  // 10–600 chars; must occur (whitespace-normalised) in the text of ANY round of this root task
                        // (each round's prompt/brief, incl. continuations) — for refresh / check-up rounds, the
                        // server brief, i.e. it quotes the fact that triggered the change
    statement: string;  // ≤ 300
    shapes: { shape: string; wouldBuild: string }[];   // 2–5 for user-requested rounds; 1–5 for refresh / check-up
    chosen: number;     // index into shapes
    why: string;        // ≤ 600
  }
  ```
  Facts only: the quote check, counts, `chosen` in range. Shown first on the change card and in the result.
  Round texts come from the jobs store (`prompt` of every job with the same `rootJobOf`).

### 3.2 Replace, don't append

- Admission items (update proposals) gain one optional field, either
  - `replaces: string` (10–600 chars): the old rule is gone — must occur in the base **body** and must not occur in the
    new body; or
  - `revises: string` (10–600 chars): the old rule was reworded or narrowed — must occur in the base body; no absence
    check.
  Refusals: "the rule you replace is still in the new text" / "<quote> isn't in the current instructions". Folding a
  learned rule (§5.1) uses `replaces: "lr_<id>"` (checked against the learned store instead).
- The change card shows the body size before → after.

### 3.3 Trial runs (new module `src/server/agentTrials.mjs`)

**Tools** (Architect only, bound to the live Architect job like `agent_propose`; added to `ARCHITECT_BLOCK_PERMISSION`):

| Tool | In → out |
|---|---|
| `agent_trial` | `{ action: "create"\|"update", agent?, baseHash?, draft, cases: { name, task, expect: "does"\|"declines", checks, project? }[1..3] }` → `{ trialId, draftHash }` at once |
| `agent_trial_wait` | `{ trialId }` → `{ state, cases: TrialCaseResult[] }`; returns when all cases ended or after ≤ 4 min |
| `agent_trial_read` | `{ trialId, case, offset? }` → `{ text, nextOffset \| null }`, 20 000 chars per window |

The wait tool is a plain awaited call; while it waits the job is busy (normal tool activity for liveness).

**Draft hash** — one function `draftHash(bundle)` in `agentTrials.mjs`, used by both tools:
`bundle` = the complete resulting file map `{ "agent.md": planChange(base, draft).after, "skills/<name>/<path>":
content, … }` (Stage 2 adds skills; generated files like `SOURCE.md`/`LICENSE` included), computed against the base
snapshot named by `baseHash` (create: empty base). Preimage: `JSON.stringify(Object.keys(bundle).sort().map((k) => [k,
bundle[k]]))`, sha256 hex. A mismatch refusal names the files that differ.

**Materialise:** the draft bundle is written to `~/.manta/agents/.trials/<trialId>/` and a temporary opencode block
`agent-trial-<trialId>` (compiled prompt, `mode: "all"`, the draft model) is added through the normal config writer.
`syncLocked()` keeps every `agent-trial-*` key whose id is in the trials module's live set (`activeTrialKeys()`), and
removes the rest (so boot cleans leftovers). Trials never touch `.installed.json`.

**Run** each case as a headless internal session (`withInternalMarker`, as `knowledge/trial.mjs`), never a sidebar row:
- **Folder:** always a throwaway git worktree — of the case `project` (registry slug; else the agent's first seat),
  starting from the project's current HEAD (the worktree helper has no start point) — else a fresh empty scratch repo in
  the OS temp folder, outside `~/.manta`, because the task rulesets protect `~/.manta` by absolute path, which only holds
  for a session whose folder is outside it. Never the live checkout, for any isolation. `scanSymlinks` (as `knowledge/trial.mjs`) refuses a worktree with links out of it.
- **Ruleset** = the agent's normal task ruleset for its isolation, built with `noSecrets: true`, plus trial denies:
  the deploy / publish / send-external / delete-data / spend kinds at "never"; `git push`, `gh pr`, `gh release`,
  `gh issue`, `gh api`; `curl` with `-X`/`--request`/`-d`/`--data*`/`-F`/`--form`/`-T`/`--upload*` **as separate arguments** (first or later: `curl -d*`,
  `curl * -d*`; a URL such as `…/api-docs` is not a flag); `wget --post*`; `ssh`, `scp`,
  `rsync`, `nc`; the tools `agent_trial*`, `agent_propose`, `agent_change`, `research_library_save`, `delegate*`,
  `agent_handoff`, `routine_*`, `schedule_*`, `notify`, `send_file`, `serve_page`. The `question` tool is answered at
  once with "This is a test run with no user: continue on your best assumption and say what you assumed"; recorded as
  "would ask".
- **Limits:** 15 min per case; ≤ 3 cases per trial; ≤ 3 trials per target agent (keyed by `agent` for an update, by
  `slugForName(draft.name)` for a create — also stored as the trial's `agentSlug`, so the created agent's Tests tab shows
  the trials that made it) and ≤ 6 per root task; ≤ 2 cases
  running box-wide (own FIFO, not the delegate cap). Model = the draft's `model`, else Auto. Usage is checked with
  `budget.canSpend` and booked with `budget.book` (work type `agent-trial`), as `knowledge/trial.mjs` does.
- **Recorded per case:** end state (done / failed / timed out / aborted), final answer, tools used, files changed (diff
  stat), refused actions (permission denials), "would ask" questions, duration, transcript text (redacted with the
  knowledge `scanner.redact`). Written to `~/.manta/agents/.trials/<trialId>/result.json`; kept 30 days (Tests tab).
- **Cleanup:** after `result.json` is written: delete the opencode session (`deleteSessionRaw`), remove the worktree and
  force-delete its branch (`git branch -D`, only a name matching `agent-trial-tr_<hex>-<n>`: the helper's `-d` refuses a
  branch the case committed to), or remove the scratch repo, drop the block. Boot `recover()` does the same for leftovers. When the Architect job ends, fails or is stopped (`afterJobEnded`), its queued and running
  cases are aborted (state `aborted`) and cleaned up.
- A trial of the **Architect** itself runs the draft up to the point of proposing (`agent_propose` is denied); the
  case's final answer shows what it would have proposed.

**Grading is the Architect's judgement.** `agent_propose` gains `trial`, required for every create and every update
that changes instructions, skills, isolation or model (not for description / colour / use_when / not_for only):
```ts
trial: { trialId: string; verdicts: { case: string; pass: boolean; quote: string; note: string }[] }
```
Facts checked: the trial belongs to this root task; `draftHash` equals the proposal's; every case reached
done/failed/timed-out (not aborted/queued); one verdict per case; each `quote` (20–300 chars) occurs in the **assistant and
tool lines** of that case's transcript — never in its "User:" lines, which are the task the Architect itself wrote; every
verdict `pass`. Otherwise refused ("Case <name> failed: fix the draft and run a trial again").

The lead's `agent_change` (small dictated edits) is unchanged and needs no trial.

### 3.4 What the user sees (Stage 1)

- Change card (`AgentChangeView`, extended — not a new card): Problem block first (the quote, shapes, chosen + why),
  then the diff, body size before → after, trial cases (name, expected, verdict, the quote, "Transcript" → the task side
  panel), then evidence.
- Agent profile: a **new Tests tab** (Phase 6 deferred it, §11 there): trials for this agent, newest first.
- Architect task card: its own steps as today; the trials module reports "Trial running · case 2 of 3" through the
  job's `jobProgress` label.

## 4. Stage 2 — skills

### 4.1 Bundle, proposals, snapshots

- Skills live in `~/.manta/agents/<slug>/skills/<name>/` (exists today, compiled as an index into `.compiled.md`; kept):
  `SKILL.md` (frontmatter `name`, `description`) plus up to 20 text files. Limits: name `[a-z0-9-]{1,50}`, relative
  paths without `..`/absolute/symlinks, UTF-8 without NUL, ≤ 256 KiB per skill, ≤ 1 MiB per agent, ≤ 15 skills.
- Proposal `draft` gains:
  ```ts
  skills?: { name: string; op: "add" | "replace" | "remove";
             files?: { path: string; content: string; origin: "copied" | "written"; sourceId?: string }[];
             provenance?: SkillProvenance }[]
  SkillProvenance = { url: string; sourceId: string; repo: string; ref: string /* commit sha or tag */;
                      licence: string /* SPDX */; licenseSourceId?: string; taken: "whole" | "part";
                      registry?: { installs: number | null; stars: number | null } }
  ```
- Server-generated files (never sent by the model): `SOURCE.md` (origin link, ref, licence, what was taken, installs /
  stars at the time) and, when `licenseSourceId` is given, `LICENSE` = that fetched source's text.
- **Facts checked** (sources and searches are looked up across every child session of the root task — all jobs
  sharing `rootJobOf` — usually one):
  - a `copied` file carries `sourceId`; `research.getSource(childSessionID, sourceId)` exists in one of them
    and contains the content (whitespace-normalised); the skill's `provenance.sourceId` was fetched by this task and
    its `url` matches that source;
  - licence allowlist for copying: `MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, CC0-1.0,
    CC-BY-4.0, MPL-2.0`; anything else / unknown / missing → copied files refused (write your own, cite as research).
    All but `0BSD, Unlicense, CC0-1.0` need `licenseSourceId` (the notice must travel with the copy);
  - a skill `add` needs `skillSearch` (§4.2).
- **Snapshots.** `before` / `after` stay **agent.md strings** (unchanged contract; the card diff keeps working). New
  records add `beforeBundle` / `afterBundle: Record<path, sha256>` over agent.md + `skills/**` + `learned/**`, blobs in
  `~/.manta/agents/.blobs/<sha256>`. Apply / Undo / Restore / conflict detection use the bundle maps when present
  (every file must match its expected hash), else today's agent.md path. Blobs are swept when no record references
  them. The renderer gets `skillsDiff` (per skill: op + changed paths) for the card, never blob contents.

### 4.2 Finding proven skills

- **Research source `skills`** (built in, Architect only): runs the pinned `skills` CLI from a box-local install
  (`npm install --prefix ~/.manta/tools/skills skills@1.9.1` on first use, then `node …/bin`), argv
  `["find", query]`, no shell, `queryRefusal()` from `research/extra.mjs` first, 40 s timeout, ANSI stripped; parses
  `owner/repo@skill`, installs and the skills.sh URL.
- **The research engine records searches** (new): every `research_search` call stores `{ source, query, refs[] }` per
  child session (`research.searchesOf(childSessionID)`), refs = repo / URL ids it returned.
- **Tool `skills_installed`** (Architect): skills on this box — `~/.config/opencode/skills`, `~/.agents/skills`,
  `~/.claude/skills` and every team agent's `skills/` — name, description, folder, provenance when known.
- Proposal field, required when a skill is added:
  ```ts
  skillSearch: { queries: { source: string; query: string }[];
                 candidates: { ref: string; installs: number | null; stars: number | null; licence: string | null;
                               verdict: "used-whole" | "used-part" | "rejected"; why: string }[] }
  ```
  Facts: each query is in `searchesOf` for this task; each candidate `ref` appeared in one of its results or in
  `skills_installed`. Ranking (installs, stars, recency, fit) is the Architect's judgement.
- Template process text: search before writing; prefer a proven skill; take only the parts that fit; write your own
  only when nothing suitable exists, and say why in `skillSearch`.
- **Upstream updates:** the refresh and the check-up fact sheet list copied skills whose upstream ref moved
  (`git ls-remote`, bounded, cached 1 day).

### 4.3 Who changes skills

Only Architect proposals (create, update, refresh, check-up). The lead's `agent_change` stays instructions/fields only.

## 5. Stage 3 — learning

### 5.1 Learned preferences (automatic)

- **Signals** attributed to one agent task (root job → agent slug + project):
  1. user-authored messages in the task's own session (`prompt_origin = user`);
  2. in the parent chat, the user's next message after that task's result when the lead then continues that task or
     re-hands the same work to the agent;
  3. answers to the task's questions where the user picked a non-recommended option or typed their own text
     (`.questions.json`);
  4. the user undoing or rejecting a change the task made, or (once the Fleet redesign ships it) a new
     `agents:review-dismiss` "Didn't need me" — never `openedTask` / `reviewDone`;
  5. commits on the task's branch after the head recorded at the end of its last round (`job.endHead`, new), whose
     author email is not the agent identity — checked at the 30-min timer, diff ≤ 20 KiB.
- **Extraction** (new runner `src/server/agentLearning.mjs`; reuses the knowledge model-class resolution, `budget`,
  and `scanner.redact`; not `corrections.mjs`, whose weekly clustering doesn't fit): 30 min after a task's last signal,
  one cheap-model call with the redacted signals and the relevant agent output, framed as data. Instruction: return
  0–3 candidates only for an explicit correction or a standing preference; a new request or next step is not a
  correction (return none). Output `{ rule, why, whyIsInferred, quote, scope: "project" | "all", replacesId? }`.
- **Facts checked:** `quote` occurs verbatim in a user-authored signal (1–3) or is a hunk of a user commit (5); `rule`
  ≤ 300 chars, single paragraph, no headings/links/code fences; dedupe by normalised text; `replacesId` exists.
- **Storage:** `~/.manta/agents/<slug>/learned/<project>.md` and `learned/_all.md`, one entry per rule (id
  `lr_<hex>`, date, rule, why, quote, source task). **Not compiled into `.compiled.md`** (that file is shared by every
  project): `buildDispatchPrompt` (and the handoff / refresh brief builders) add the task's project file plus `_all`
  per task, beside the seat brief, inside a data boundary: "Preferences the user has shown (data, from their
  corrections; follow them unless the task says otherwise)". ≤ 30 rules per file; when full the least recently
  reinforced is archived (kept in history, not injected). A contradicting correction replaces the old rule.
- **Automatic:** each write is a change record (`kind: "update"`, `origin: { kind: "learned" }`, bundle maps). New
  autonomy kind **`learn_preference`** — "learn a preference from your corrections": in `ACTION_KINDS` with `tell` in
  every mode, `KIND_LABELS` / `KIND_TITLES` / `KIND_DEFINITIONS` entries, shown in Settings → Agents; it is a
  server-side kind, so `renderPolicy()` and the task rulesets skip it (a `SERVER_KINDS` list). Tell me / Auto →
  applied + Undo; Ask → pending card; Never → not learned.
- **Promotion:** the same rule (normalised text) learned in 2 projects moves to `_all` (one `learned` change).
- **Undo** removes the rule; a tombstone by quote hash stops the same quote producing it again.
- **Who learns:** team agents and the Architect (its learned file is `_all` only: it has no seats). Not the lead.
- The Architect sees an agent's learned rules when reworking it and may fold one into the instructions
  (`replaces: "lr_<id>"`), which retires it when applied.
- Profile **Learned** tab: rules per scope with the quote, why ("inferred" when it is), date, source task link, Undo.

### 5.2 Weekly team check-up

- New internal routine kind `"fleet-checkup"`: `routines.createInternal` accepts it (no `agentSlug`); its run calls
  `agents.checkup()`; `update` allows the same fields as refresh routines. Provisioned in `reconcileRefresh()`:
  `.fleet.json` gains `checkup: string | null` — created when the key is absent; once set it is never recreated, even
  if the routine was deleted (tombstone). Cron `0 9 * * 1` box-local, `rollUp: true`, notify on findings.
- **Fact sheet** (server, no model), last 7 and 30 days, per team agent: tasks run; finished / failed / cut off /
  stalled; ended "needs a decision"; median duration; changes undone; learned rules added / undone; trials failed;
  research basis entries stale or thin; copied skills with upstream updates; instruction size; `@slug` and absolute-path
  references in its files that no longer resolve; sentences repeated across 3+ agents (normalised); idle (no task in 30
  days); **finished tasks whose branch has unmerged commits for more than 24 h** (Manta should have merged or
  reported them — listed for the lead, never sent to the user as review items).
- **Architect round** with the fact sheet as its brief: "Check the team: propose only changes the facts and your
  research support (max 3)". All Stage 1–2 bars apply. Retiring an agent is a recommendation in the report.
- **Release (self-driving):** refresh and check-up jobs are stamped `architect: { mode: "routine" }` (today refresh
  uses `"unknown"`); `propose()` keeps it; `decideRelease()` step 5 becomes `if (rec.mode !== "build" && rec.mode !==
  "routine") → pending "plan"`. So they follow the user's "Change an agent" level, with the same exceptions (lead,
  core, raising isolation → pending). A routine proposal that waits keeps the existing specific reasons (`lead`, `core`, `isolation`, `ask`,
  `unfinished`); none is added.
- Report: a routine report with the highlights of the fact sheet and the Outcome lines.

## 6. Contracts

### 6.1 Types (`src/shared/types.ts`)

```ts
export interface AgentProblem { userWords: string; statement: string;
  shapes: { shape: string; wouldBuild: string }[]; chosen: number; why: string }
export interface TrialCaseResult { name: string; expect: "does" | "declines";
  state: "queued" | "running" | "done" | "failed" | "timed-out" | "aborted";
  finalAnswer: string | null; tools: string[]; filesChanged: number; refused: string[]; wouldAsk: string[];
  durationMs: number | null }
export interface AgentTrial { id: string; rootJobId: string; agentSlug: string | null; draftHash: string;
  createdAt: number; cases: TrialCaseResult[] }
export interface TrialVerdict { case: string; pass: boolean; quote: string; note: string }
export interface SkillProvenance { url: string; sourceId: string; repo: string; ref: string; licence: string;
  licenseSourceId?: string; taken: "whole" | "part"; registry?: { installs: number | null; stars: number | null } }
export interface AgentSkillInfo { name: string; description: string; files: number; bytes: number;
  provenance: SkillProvenance | null }
export interface LearnedRule { id: string; scope: string /* project slug | "_all" */; rule: string; why: string;
  whyIsInferred: boolean; quote: string; createdAt: number; sourceJobId: string | null; archived: boolean }
// AgentChange: `kind` stays "create" | "update". `origin.kind` gains "template-update" (+ templateHash) and "learned".
//   New optional fields: problem?: AgentProblem; trial?: { id: string; verdicts: TrialVerdict[] };
//   sizeBefore?: number; sizeAfter?: number; skillsDiff?: { name: string; op: "add" | "replace" | "remove";
//   paths: string[]; provenance: SkillProvenance | null; scripts: string[] }[];
//   learned?: { added?: LearnedRule; removedId?: string }. beforeBundle / afterBundle are server-only (stripped).
// AgentProfile gains: skills: AgentSkillInfo[]; learned: LearnedRule[]; trials: AgentTrial[] (≤ 20, newest first)
// DelegateJob gains (server-only): endHead?: string   // branch head at the end of each round
```

### 6.2 RPC + tools

| `window.api` | channel | in → out |
|---|---|---|
| `agentsTrial` | `agents:trial` | `{id}` → `AgentTrial` |
| `agentsTrialTranscript` | `agents:trial-transcript` | `{id, case, offset?}` → `{text, nextOffset \| null}` |
| `agentsLearnedUndo` | `agents:learned-undo` | `{slug, id}` → `AgentChange` (goes through the change store's Undo) |

Plugin tools (`docs/opencode-plugins-v2/manta/tools/agents.ts`): `agent_trial`, `agent_trial_wait`, `agent_trial_read`,
`skills_installed`; `agent_propose` gains `problem`, `trial`, admission `replaces` / `revises`, draft `skills`,
`skillSearch`. Research source `skills` in `src/server/research/`. Tool descriptions: mechanics only (guard test).

## 7. Security

- **Trials run model-written agents on the user's box.** Containment: throwaway worktree or scratch repo (never the
  live checkout), symlink scan, no secrets, kind overrides at "never", publishing / sending / network-write commands
  and Manta's own side-effect tools denied, no user questions, 15-min ceiling, cleanup and abort with the parent task.
  Bash pattern denies are best effort (as `jobRules` says); network reads stay allowed. The Tests tab says so: "Runs on
  this box with the agent's permissions, minus secrets, publishing and sending."
- Copied skill files are text, never executed by Manta; an agent with bash could run a copied script as it could one it
  wrote. `skillsDiff.scripts` marks copied scripts (`*.sh`, `*.py`, `*.js`, `*.mjs`, `*.ts`, shebang) on the card.
- Learned rules: only user-quoted evidence is accepted; the rule text is model-written, so it is size-capped, plain
  text, injected per task inside a data boundary, never into Manta's or the Architect's system prompt files.
- `skills find` runs a pinned local install, argv only, `queryRefusal`, output parsed and never executed.
- Template upgrades never overwrite a user-edited file without a clean merge; conflicts wait for a click.

## 8. Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Search proven skills | `skills` CLI (vercel-labs/skills: MIT, 41.1k ★, pushed 2026-11-27; npm `skills` 1.9.1, 4.97 M dl/wk, 3 deps), **search only**, pinned local install | Its `add` installs globally for every agent — not per agent, not reviewable; we vendor content through proposals. `npx` per call: slow, mutates the npm cache |
| Skill sources | anthropics/skills (201k ★, licence per skill), openai/skills (29k ★), GitHub search | read via `research_fetch`; licence checked per skill |
| Three-way merge of templates | `node-diff3` 4.0.0 (MIT, 0 deps, 1.22 M dl/wk, published 2026-11-13) | `diff3` (axosoft, last publish 2022), `three-way-merge` (1.7k dl/wk, 2022): unmaintained |
| Trial sandbox | existing headless internal sessions + rulesets (`knowledge/trial.mjs`, `delegate.mjs`) | Freestyle VMs: real isolation but paid per run and needs spend approval → `follow-ups.md`; `scripts/opencode-v2/sandbox.mjs` is a test harness |
| Correction extraction | new runner on the knowledge system's model-class resolution, budget and redaction | `knowledge/corrections.mjs`: weekly batch clustering over the DB, wrong shape for per-task extraction |
| Licence check | SPDX id allowlist + GitHub `license.spdx_id` | `spdx-satisfies`: expressions not needed for a flat allowlist |
| Snapshots | content-addressed files (sha256) beside today's agent.md strings | a VCS library: overkill for whole-file snapshots |
| Native OpenCode skills per agent | **not now**: the compiled index keeps skills scoped by construction | V2 filters `<available_skills>` by a per-agent `skill` permission (seen in the binary, unverified on 2.0.30) → spike in `follow-ups.md` |

UI: modern-web-guidance consulted for the Tests / Learned tabs during implementation (`tabs`, `details`), cited in the PR.

## 9. Tests

- Stage 0: upgrade matrix (unchanged / history match / clean body merge / frontmatter key-wise incl. kept `sources` /
  both-changed key → conflict pending / no base → conflict / added + dropped files); dedupe by templateHash across
  states; `.base` on apply and Undo; runs only from `init()`; `.history.json` freshness test.
- Stage 1: `problem` checks (quote from round 1 accepted on a continuation round; refresh quotes the server brief;
  1 shape ok only for refresh/check-up); `replaces` present/absent and `revises` present; trial lifecycle with injected
  sessions (queue cap 2, per-agent and per-task caps, 15-min timeout, cleanup on success / failure / parent stop / boot,
  `syncLocked` keeps live trial keys and drops dead ones); ruleset contains `noSecrets`, the never-kinds, the command
  and tool denies; question auto-answer recorded; budget booked; `agent_propose` refusals: missing trial, other task's
  trial, hash mismatch (names files), aborted case, quote not in transcript, failing verdict; description-only update
  needs no trial; "No change was proposed" Outcome.
- Stage 2: skill limits; `copied` needs `sourceId` + content match; licence allowlist (MIT + licenseSourceId ok, GPL
  refused, missing refused, CC0 without licence file ok); server writes SOURCE.md / LICENSE; `skillSearch` refs must
  come from recorded searches or `skills_installed`; bundle maps + blobs: apply, Undo, Restore, conflict when any file
  changed, old string-only records still work; `skills` source parses fixture output, strips ANSI, refuses `-query`.
- Stage 3: signal attribution (each kind; `openedTask` / `reviewDone` produce nothing; next-step messages produce
  nothing); quote checks; injection per task via `buildDispatchPrompt` (project A's rules absent from project B's
  prompt); cap + archive; promotion; tombstone; `learn_preference` absent from `renderPolicy()`; check-up provisioning
  tombstone; fact sheet on fixture jobs/changes (incl. unmerged branches); `decideRelease` with `mode: "routine"`.
- Guard test: extended to every new template/skill text and tool description.
- Live acceptance (§10).

## 10. Implementation split and order

One code-editing task at a time. Each PR: targeted tests locally, full suite on CI.

1. **PR A — Stage 0 + Stage 1 server and templates together** (`agents.mjs` incl. the bundle snapshots of §4.1 —
   `.blobs/`, `beforeBundle` / `afterBundle` — because template upgrades already touch the Architect's `skills/**`;
   new `agentTrials.mjs`, `delegate.mjs` hooks, plugin tools, `node-diff3`, `.history.json` + script, the
   Architect + lead template texts — process only, drafted by the lead session, checked by the guard — and tests). The
   server never requires a field the shipped Architect doesn't know.
2. **PR B — Stage 1 renderer**: change card Problem / Trial / size, Tests tab, progress line.
3. **PR C — Stage 2** (skill proposals, provenance and licences, search recording, the `skills` source, templates, renderer Skills section and card skill diff).
4. **PR D — Stage 3** (learning, `learn_preference`, check-up, Learned tab, Settings row).
5. **Acceptance:** hand `@architect` "I want a UX/UI agent that designs the product's UI, not only reviews it" for
   `@ux-ui-review`; check it uses every stage (problem + shapes, a question if open, proven skills, trials, replaces).

## 11. Later (follow-ups.md)

Native OpenCode skill scoping per agent; trials on Freestyle VMs for agents with bash; trial cases drawn from real past
tasks; learning for the lead; upstream skill diffs before an update; usage-based routing checks.

## 12. Review log

### Round 1 — Gemini 4 Argon (OpenCode Go), at 7f0d237c

13 MUST, 4 SHOULD; all applied:
- refresh/check-up provisioning (`createInternal` only took `agent-refresh`) → §5.2 extends it, `.fleet.json` `checkup`
  tombstone.
- `AgentChange.kind` collision → `kind` stays create/update; new sources go in `origin.kind` (§2, §5.1, §6.1).
- "Tell-me feed" / "reserved Tests tab" didn't exist → §0 names the real surfaces; §3.4 says the Tests tab is new.
- `corrections.mjs` reuse didn't fit → new runner (§5.1, §8).
- `userWords` failed on continuations and server-briefed rounds → checked across all rounds; refresh quotes the brief;
  1 shape allowed there (§3.1).
- `replaces` too strict → `replaces` / `revises`, 10 chars, body only (§3.2).
- trial block wiped by `syncLocked` → live-trial key set, not `.installed.json`; trials can't call proposal / trial /
  side-effect tools (§3.3).
- containment → always a throwaway folder, symlink scan, `noSecrets`, network-write denies (§3.3, §7).
- draft hash ambiguity → canonical preimage (§3.3).
- budget + orphans → `canSpend` / `book`, session deletion, abort on parent end (§3.3).
- trial cap vs 3 proposals → per-agent 3, per-task 6 (§3.3).
- `getSource` needs ids / searches unrecorded → `sourceId` fields, `searchesOf` (§4.1, §4.2).
- LICENSE echoed by the model → server writes it from `licenseSourceId` (§4.1).
- blob snapshots broke the agent.md string contract → strings kept, bundle maps added (§4.1).
- `npx` per call → pinned local install, `queryRefusal`, ANSI strip (§4.2).
- learned rules leaking across projects / injection → per-task injection in `buildDispatchPrompt`, data boundary,
  redaction, user-authored quotes only (§5.1, §7).
- signal ambiguity → explicit-correction-only extraction, no `openedTask`/`reviewDone`, `endHead` for user commits
  (§5.1).
- autonomy kind under-specified → `learn_preference`, server-only, skipped by `renderPolicy` (§5.1).
- `mode: "unknown"` vs release → `mode: "routine"` accepted by `decideRelease` (§5.2).
- template upgrade inside `sync()` + duplicate records → `init()` only, dedupe by templateHash (§2).
- merge algorithm under-specified → exact algorithm (§2).
- PR A without templates → templates ship in PR A (§10).

Also from the user (2026-11-27): background work reports to Manta, which merges; unmerged finished branches go to the
check-up fact sheet for the lead, never to the user as review items (§5.2).

### Round 2 — Gemini 4 Argon, at f744803e

All 17 round-1 findings verified resolved; no new MUST. Applied: per-agent trial key for creates (`slugForName`, §3.3);
sources / searches checked across all child sessions of the root task (§4.1); bundle snapshots moved to PR A (§10);
no new Outcome wait reason for routine rounds (§5.2).

### Round 3 — Gemini 4 Argon, at 0a723518

All round-2 findings verified resolved; no new MUST, SHOULD or COULD. Verdict: ready to implement.
