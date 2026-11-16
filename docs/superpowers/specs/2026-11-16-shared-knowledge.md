# Shared knowledge: stop re-explaining things across sessions and projects

Status: draft for review (revision 2), 2026-11-16. Scope: the box server, the
V2 `manta` opencode plugin, Settings (desktop). iOS: out of scope for v1.

Agreed with the user:

- No human review queue. An agent decides what is worth keeping; the user gets
  a digest with one-click undo.
- Every session (not only the CTO) can search past sessions and leave notes;
  other sessions and projects simply know about them.
- Repeated work becomes tested skills (the AgentRun idea, not the product).
- Memory is wiki-shaped, borrowed from the `agent-cto` project (§10 of its
  SPEC): versioned Markdown pages, an evidence-backed fact index beside them.
- Two choices are **user settings**, not design decisions: how rule changes
  reach a repository's `AGENTS.md`, and whether a project shares its knowledge
  with other projects.
- Nothing is tailored to one user's projects: no project names, patterns or
  per-project defaults are hard-coded. Every box starts from the same global
  defaults and the user changes them.
- The curator's models are picked by Manta's existing model router from what
  the box has available, never hard-coded (§6.2.1).

## 1. Problem

Measured on the dev box, 2026-11-16:

- **The blackboard is written but never read by a working session.** 426 active
  facts sit in `~/.manta/cto/facts/`. The spawn-context block that would hand
  them to a session (`factsContextBlock`, `ctoEngine.mjs`) has no caller, and
  `buildJobPrompt`'s `facts` slot (`delegate.mjs`) is omitted by all three
  callers. Ordinary sessions, background jobs and CTO-dispatched work start
  blind.
- **One project is filed under many names.** 57 fact files, because the project
  key is free text. MantaUI alone is `MantaUI`, `better-ui`, `manta`,
  `better-ui-debug-landing`, `better-ui-debug-test-2`; Capo is `Capo`,
  `airtranscript`, `airtranscript (Capo)`, `CAPO-323`; plus `leasebot`/`Leasebot`,
  `tenanture`/`Tenanture` and four bare UUIDs. A note written under one name is
  invisible under the others.
- **No cross-project knowledge exists.** A fact belongs to exactly one project;
  "how we do X everywhere" has nowhere to live except the global
  `~/.config/opencode/AGENTS.md`, which is now 980 lines and hand-curated.
- **Past-session search is hidden.** `context_search` exists, but behind the
  `cto` tool with a CTO-flavoured description. An FTS5 index
  (`ctoSearchIndex.mjs`) is built and tested but nothing uses it.
- **Writing a note depends on the agent remembering to.** Nothing captures what
  a session learned when it ends.
- **Repeated corrections never become rules**, and repeated procedures never
  become skills.

## 2. Research summary

- **agent-cto (`/home/dev/projects/agent-cto/docs/SPEC.md` §4, §10)**: two wikis
  the agent writes itself (product wiki "for a new CTO joining tomorrow" with a
  fixed page set; a wiki about the user). Markdown in a git repo outside the
  product repo; every edit is a commit with a reason and sources; edits name the
  commit they start from; a fact index beside the wiki; everything cites a
  source and a last-verified date; user edits win; weekly tidy-up; untrusted
  text is quoted, never obeyed; the wiki never grants authority; a secret scan
  on every commit. Acceptance: a fresh session answers "how do we deploy" from
  the wikis alone. **We adopt all of these rules.**
- **improvemyagent** (AgnostAI, MIT): mines agent history for corrections
  repeated across separate sessions and turns them into `AGENTS.md` rules;
  tracks whether an applied rule stopped the mistake. Its grounding rule (≥ 2
  sessions or ≥ 3 corrections) is the right bar — ungrounded AI-written context
  files make agents worse (ETH Zurich 2026, cited in its README). Its OpenCode
  adapter reads the legacy JSON-file storage, not the V2 database, and it
  expects a human to `--apply`.
- **AgentRun** (Parcha, Apache-2.0): repeated steps → proposed skill → checked
  and graded → reused; unused learning retires. We take the loop, not the
  platform (it would be a second control plane next to Manta's).
- **OpenCrawl** (Apache-2.0): verbatim session search beats summaries for
  recall. We keep full transcripts searchable (opencode's own store) and use
  wiki pages as the readable layer, not as a replacement.

## 3. Concepts (pinned)

- **Project**: identified by a canonical id derived from the git remote
  (`host/owner/repo`, lowercased, `.git` stripped); no remote → the main
  worktree's absolute path. All worktrees of a repo map to one project. A
  directory outside any repo maps to the pseudo-project `box`.
- **Knowledge store**: one git repository at `~/.manta/knowledge/` (box-local,
  never in a product repo):
  - `user/` — the **user wiki**: preferences, standing instructions, how the
    user works, people and accounts (names only). Always readable by every
    session.
  - `commons/` — **shared how-tos**: procedures and gotchas that apply beyond
    one project. Fed only by projects whose sharing setting allows it.
  - `projects/<slug>/` — one **project wiki** per project.
  - `facts/` is NOT here: the existing blackboard stays the fact index, re-keyed
    by canonical project id (§6.1).
- **Note**: a short candidate statement from a session ("deploys go through
  `fs-run`, never local builds"). Notes are input; only the curator writes
  pages.
- **Curator**: one server-owned agent loop that turns notes, session summaries
  and correction evidence into page edits, rules and skills. It is the only
  writer of the knowledge store, managed `AGENTS.md` blocks and learned skills.
- **Briefing**: the short context block a new session receives (§7.1).

## 4. Settings (user-controlled, pinned)

Stored in `~/.manta/config.json` under `knowledge`. Desktop Settings → a new
**Knowledge** card; per-project overrides in the same card's project list.

```jsonc
"knowledge": {
  "enabled": true,                       // master switch; off = no capture, no curator, no briefing
  "repoRules": "pull-request",           // default for projects: "pull-request" | "direct" | "box-only"
  "sharing": "share-and-read",           // default for projects: "share-and-read" | "read-only" | "private"
  "projects": {
    "<canonical project id>": { "repoRules": "direct", "sharing": "private" }
  }
}
```

### 4.1 `repoRules` — how a rule reaches a repository's `AGENTS.md`

| Value | Behaviour |
|---|---|
| `pull-request` | The curator commits to a branch `manta/knowledge-<date>` and opens a PR with the reasons and evidence in the body. It never merges. One open knowledge PR per repo at a time; later changes are pushed to it. |
| `direct` | The curator commits to the default branch and pushes. If the push is rejected (protected branch, no rights) it falls back to `pull-request` for that change and says so in the digest. |
| `box-only` | The repo is never touched. Project rules live in the project wiki and reach sessions through the briefing only. |

Rules for every mode:

- The curator edits only a **managed block** delimited by
  `<!-- manta:knowledge:start -->` / `<!-- manta:knowledge:end -->`, created at
  the end of the file on first write. Text outside it is the user's and is never
  changed. A hand edit inside the block is adopted as the new truth (user
  edits win) and recorded in the project wiki.
- The block has a budget of 120 lines; the curator merges or drops rules to
  stay within it.
- `pull-request` needs `gh` installed and authenticated on the box. When it
  isn't, the option is shown disabled with that reason (never a dead control),
  and a project already set to it behaves as `box-only` and says so in the
  digest.
- The global `~/.config/opencode/AGENTS.md` is not in git: the curator edits its
  managed block directly (same markers, budget 200 lines), rendered from the
  user wiki's preferences page. Every edit is mirrored as a commit in the
  knowledge store, so undo works the same way.

### 4.2 `sharing` — what a project gives and takes

| Value | Its own knowledge feeds `commons/` | Its sessions read `commons/` | Its project wiki readable by other projects |
|---|---|---|---|
| `share-and-read` | yes | yes | yes (search hits, not the briefing) |
| `read-only` | no | yes | no |
| `private` | no | no | no |

- The **user wiki** is readable by every project regardless (it is about the
  user, not a project).
- What a project contributes to `commons/` is a **rewritten, generic** how-to,
  never a copy of project pages; evidence refs pointing into a non-sharing
  project are dropped from commons pages.
- Changing a project from sharing to `read-only`/`private` removes its
  contributions: the curator rewrites or deletes the commons pages whose only
  evidence came from it (one commit, listed in the digest). Git history keeps
  them (single-user box; no history rewrite in v1).
- Past-session search obeys the same rule: a `private` or `read-only` project's
  transcripts never appear in another project's search results, and a `private`
  project's sessions search only themselves.

## 5. Capture

### 5.1 Notes from any session — `knowledge_note` tool

Every session gets the tool (V2 `manta` plugin):

```ts
knowledge_note({
  kind: "howto" | "gotcha" | "decision" | "preference" | "status",
  text: string,          // ≤ 400 chars
  scope?: "project" | "general",   // the agent's guess; the curator decides
  refs: string[],        // ≥ 1: commit, file path, PR, message id, URL
}) → { accepted: true, id } | { accepted: false, reason }
```

- Writes to a durable queue `~/.manta/knowledge/.queue/` (outside git), stamped
  with the session id and canonical project. Returns at once.
- `preference` notes are about the user and route to the user wiki.
- `cto_fact` keeps working unchanged; its writes also enqueue a note.

### 5.2 Automatic capture at the end of work

The CTO segmenter already closes a segment on inactivity or `session.idle` and
writes one summary per segment (`ctoSegments.mjs`). Extend that summary's
prompt to also return up to 5 candidate notes (same shape as 5.1, with refs to
message ids). No extra model call. Covers user sessions and background jobs.
CTO-internal sessions and routine runs are excluded.

### 5.3 Correction evidence (rules)

A weekly run uses **improvemyagent** (§10) as the detector, pinned to an exact
version:

1. Export the last 60 days of opencode V2 sessions into improvemyagent's
   expected legacy layout in a temp dir (read-only DB access through the
   existing `dbOffload` worker).
2. Run it with `IMA_OPENCODE_DIR=<export>`, `IMA_STATE_DIR=~/.manta/knowledge/.ima`,
   `--report` (never `--apply`), backend `opencode`.
3. Read its structured `rules.json` / `last-run.json` as candidate rules with
   their evidence. Its own tracking tells us whether an applied rule stopped the
   correction (used in 6.4).

If the run fails, the week's rule pass is skipped and the digest says so; no
other part depends on it.

## 6. Curation

### 6.1 Project identity migration (one-time, idempotent)

Map every existing blackboard key to a canonical project id: by tmux session →
pane directory → repo; by known aliases; UUID keys via the opencode project
table. Unmapped keys stay as they are and are listed in the first digest.
Merging keeps every fact (supersede chains intact). The `cto_fact` tool and
`proposeFact` resolve the caller's project from its session directory from now
on; a free-text `project` argument becomes an alias lookup.

### 6.2 The curator loop

Runs inside manta-server (CTO engine sweep), one project at a time, with the
gatekeeper's per-project single-writer pattern. Triggers: ≥ 5 queued notes for a
project, or 30 minutes after the last note; plus the weekly tidy-up (a routine).

For each batch the curator (model chosen per §6.2.1) reads the queue, the affected pages and the fact
index, and returns a list of decisions:

| Decision | Effect |
|---|---|
| `page.edit` | Rewrite one section of one page (project, user or commons). |
| `fact.add` / `fact.supersede` | Through the existing gatekeeper. |
| `rule.add` / `rule.change` / `rule.remove` | In a managed `AGENTS.md` block (§4.1). |
| `skill.propose` | Start the skill pipeline (§6.5). |
| `drop` | With a reason. |

Bars it must meet (checked in code after the model answers, not just prompted):

- **Grounding.** A rule needs ≥ 3 corrections or the same correction in ≥ 2
  sessions. A page edit needs ≥ 1 ref per new claim.
- **No contradiction** with a user-written line; a conflict becomes a digest
  item, not an edit.
- **Placement.** General vs project is decided by the curator, then filtered by
  the project's `sharing` setting.
- **Budgets.** Briefing page ≤ 60 lines; managed blocks per §4.1.

#### 6.2.1 Model selection

Reuses the CTO's existing per-task routing (`TASK_CLASSES` + `defaultResolveModel`
in `ctoSessions.mjs` → `chooseSubagentModel` in the shared model router). That
path already:

- picks only from models connected and usable on this box, honouring the
  user's deactivated models and routing policy;
- ranks by measured quality (`modelQuality.mjs` scores, tier floor), then plan
  quota headroom and pacing, then cost;
- skips unhealthy endpoints and fails over to another endpoint once
  (`runEphemeral`), with spend metered by the CTO budget.

New task classes (a literal table, never a model id):

| Task class | Work | Tier → router band | Context budget |
|---|---|---|---|
| `curator-notes` | notes → page edits, fact proposals, drops | `mid` → `balanced` | 12k |
| `curator-rules` | rule add/change/remove, conflict calls, commons rewrites | `deep` → `deep` | 24k |
| `curator-skills` | skill draft and trial grading | `deep` → `deep` | 24k |

- Add `deep: "deep"` to `TIER_TO_ROUTER_TIER`. The `nano` → `mid` escalation
  on invalid output stays as it is; `deep` classes never escalate (there is
  nothing above).
- If the router has no model meeting the band (typed `no-healthy-endpoint`),
  the batch stays queued and is retried on the next trigger; after 24 h of
  failures the digest says which work is waiting and why. It never falls back
  to a weaker band for `curator-rules` / `curator-skills` (a weak model writing
  standing rules is the failure we most want to avoid).
- The skill trial job (§6.5 step 3) is an ordinary `delegate` job with no
  `model` argument, so Auto routing picks it the same way.
- The capture step (§5.2) adds no model call; it rides the segment summary's
  existing class.

Every applied batch is **one commit** in the knowledge store: message =
one-line summary, body = each decision with its reason and refs, trailer
`Manta-Curator-Batch: <id>`.

### 6.3 Page shape (borrowed from agent-cto §10.1, trimmed for a dev box)

Project wiki starter pages: `overview.md` (what it is, where it runs, the
briefing source), `run-and-test.md`, `release-and-rollback.md`, `runbooks/*.md`,
`decisions/*.md`, `gotchas.md`, `access.md` (which secrets/accounts exist —
names only). User wiki: `preferences.md` (renders the global managed block),
`how-i-work.md`, `people-and-accounts.md`. Commons: `howto/*.md`.

Each page starts with front matter:

```yaml
---
title: Release and rollback
verified: 2026-11-16        # last time a claim on this page was checked against evidence
sources: [commit:c4bbd906, ses_…/msg_…]
---
```

### 6.4 Self-correction

- **Rules** whose correction keeps recurring after they were applied
  (improvemyagent tracking, 2 more occurrences) are rewritten once, then removed.
- **Pages** not verified in 90 days are re-checked in the weekly tidy-up: a
  claim whose refs no longer resolve (file gone, command changed) is marked
  stale in the briefing and fixed or removed.
- **User edits** to any page or managed block are never reverted; the curator
  only adapts around them.

### 6.5 Skills from repeated work

1. **Detect**: the weekly tidy-up looks for a procedure repeated in ≥ 3 segment
   summaries across ≥ 2 sessions (same goal, overlapping commands/tools), or a
   runbook page followed step by step ≥ 3 times.
2. **Draft**: a `SKILL.md` in opencode's format, named `learned-<slug>`.
3. **Trial**: a background job (`delegate`, its own worktree, 20-minute limit)
   runs the skill against the most recent real instance of the task in
   **dry-run** form (reads, builds, tests; no pushes, deploys, or writes outside
   its worktree). The curator grades the result against what the original
   sessions achieved. Pass → install; fail → keep as a runbook page.
4. **Never promoted**: procedures that touch production, money, credentials or
   other people's systems stay runbook pages only.
5. **Install** to `~/.config/opencode/skills/learned-<slug>/` (the prefix marks
   what the curator owns; it never touches other skills). Scope: `project` skills
   mention their project in the description so the model only loads them there.
6. **Retire** a learned skill with no load in 30 days, or that led to a
   correction twice.

## 7. Reading

### 7.1 Briefing (every session and background job)

- **How**: the `manta` plugin's `ctx.session.hook("context")` (the seam
  `manta-optimizer` already uses) asks manta-server for the briefing on the
  first request of a session and prepends it as a system block. Cached per
  session; refetched after compaction.
- **What** (≤ 1,500 tokens, in this order, truncated from the bottom):
  1. The project's `overview.md` "Briefing" section.
  2. Top active facts for the project (the existing `buildFactsContext`
     ordering), blockers and invariants first.
  3. Titles + one-line summaries of the most relevant runbooks and commons
     how-tos (by the session's first user message, FTS ranked), with a pointer
     to `knowledge_read`.
- The user wiki is not in the briefing: it already reaches every harness
  through the global `AGENTS.md` managed block.
- Delegate jobs get the same block (this also wires the unused `facts` slot).

### 7.2 Tools for every session

```ts
knowledge_search({ query: string, scope?: "project" | "all", sources?: ("wiki"|"facts"|"sessions")[], limit?: number /* ≤ 20 */ })
  → { hits: Array<{ source, project, title, snippet, ref, at }> , truncated: boolean }
knowledge_read({ ref: string })   // a page path, or a session/message ref from a hit
  → { title, body, verified?, sources? } | { error, reason }
```

- `sessions` searches past transcripts: the FTS5 index (`ctoSearchIndex.mjs`,
  wired up and refreshed incrementally by the sweep), with the bounded direct
  scan (`ctoContext.mjs`) as the fallback while the index catches up.
- Default scope `project`; `all` obeys §4.2.
- Tool guidance: "Before non-trivial work, or when the user mentions something
  done before, search first."
- `context_search` on the `cto` tool stays for the CTO.

## 8. Digest and undo

- One weekly report through the existing routines engine ("Knowledge",
  `notify: findings`): what was added, changed, removed, promoted to a skill or
  retired, each with its reason; PRs opened; conflicts that need the user;
  failures (detector, push).
- **Undo** per item: reverts that batch's commit in the knowledge store and
  re-renders the affected managed blocks/skills; for a `direct` repo change it
  pushes a revert commit; for a `pull-request` change it removes the change from
  the open PR. Undo is a real action with a visible result or an error.
- The Knowledge card has **Open knowledge** (opens `~/.manta/knowledge/` in the
  Explorer) — pages are plain Markdown and user edits are welcome.

## 9. Safety (pinned)

1. **Secrets**: every knowledge commit and every managed-block write is scanned
   with secretlint's recommended preset; a hit drops the offending decision and
   records it in the digest. Page `access.md` holds names only.
2. **Untrusted text** (tool output, logs, web pages, file contents) may be
   quoted as evidence; it can never create a rule, a preference or a skill. A
   rule needs user-authored evidence (a user message).
3. **Knowledge never grants authority.** No page, rule or skill can change
   permissions, trust mode, budgets or autonomy settings.
4. **Isolation between projects** is the `sharing` setting only; there is no
   built-in list of sensitive projects.
5. The curator's repo writes use the box user's existing git credentials only;
   it never stores new ones.

## 10. Libraries considered

| Need | Chosen | Considered and why not |
|---|---|---|
| Correction detection | **improvemyagent 0.2.2** (MIT, 109 dl/wk, first release 2026-10-30), pinned, run as a subprocess with a V2 export shim | Our own detector: rejected, this one exists, is MIT, grounded and tracked. Risks noted: very young, no V2 adapter (we feed it the legacy layout; contribute a V2 adapter upstream as a follow-up); isolated so a failure only skips the week's rules. |
| Versioned page store | **git via simple-git 4.0.2** (MIT, 15.3M dl/wk, 2026-09-26) | isomorphic-git 1.44.15 (MIT, 3.3M/wk): a JS re-implementation, slower, no benefit on a box that has git. A database table: loses diffs, history and hand-editing. |
| Front matter | **`yaml`** (already a dependency) + the standard `---` fence (~10 lines) | gray-matter 4.0.3 (14.6M/wk): last release 2021 and brings a second YAML parser (js-yaml). |
| Section-level page edits | **unified + remark-parse** (MIT, 84M/wk; already in the tree via react-markdown) | Regex splitting on headings: breaks on code fences. |
| Search (wiki + sessions) | **SQLite FTS5 via `node:sqlite`** (box runtime; `ctoSearchIndex.mjs` already built and tested) | minisearch 7.2.0 (6.1M/wk), flexsearch 0.8.212 (1.3M/wk): in-memory, can't hold a 34 GB history; would duplicate an index we already have. |
| Secret scanning | **@secretlint/core 14.0.1** + `@secretlint/secretlint-rule-preset-recommend` (MIT, 2.8M/wk, 2026-11-16) | gitleaks: a Go binary, not on boxes (CI only). Hand-written regexes: no. |
| PR creation | **`gh` CLI** when present and authenticated | Octokit + a stored token: would need Manta to hold a GitHub token; the user's own `gh` login is the right trust boundary. |
| Skill format and loading | **opencode's native skills** (`SKILL.md`) | AgentRun as a platform: a second control plane next to delegate/routines/CTO. |
| Shared memory platform | **none — Manta's own store** | OpenCrawl: cross-machine/team product, no OpenCode support listed, uploads transcripts unless self-hosted. Revisit if multi-machine. |
| Scheduling | **existing routines engine** (weekly tidy, digest, measurement) and the CTO sweep | A new scheduler: no. |
| Settings UI | native `<input type="radio">` groups in a `<fieldset>` per project (MWG `forms`, `brand-consistent-forms`) | A custom segmented control: no reason over the native control. |

## 11. Contracts (pinned)

- **Store layout**: §3. Branch `main`, one commit per curator batch, trailer
  `Manta-Curator-Batch`. `.queue/` and `.ima/` are git-ignored.
- **Config**: §4 schema; unknown values rejected by `config:update`.
- **Tools** (V2 `docs/opencode-plugins-v2/manta/tools/knowledge.ts`, V2-only,
  added to `V2_ONLY` in the pack test): `knowledge_note`, `knowledge_search`,
  `knowledge_read` per §5.1 / §7.2.
- **HTTP**: `POST /api/knowledge/notes`, `GET /api/knowledge/search`,
  `GET /api/knowledge/page`, `GET /api/knowledge/briefing?sessionID=`
  (class-2 errors). RPC for the desktop: `knowledge:settings-get`,
  `knowledge:settings-set`, `knowledge:digest`, `knowledge:undo`.
- **Managed block markers**: §4.1.
- **Learned skill prefix**: `learned-`.

## 12. Tests (injected fakes; heavy runs on Freestyle per the box rule)

- Project identity: remotes (ssh/https/.git), worktrees, no remote, the alias
  migration over a copy of the real 57 keys.
- Sharing matrix (§4.2) for search, briefing and commons contribution,
  including the downgrade cleanup.
- `repoRules`: managed-block create/edit/budget, user text outside untouched, a
  hand edit inside adopted, `direct` push rejected → PR fallback, `gh` missing →
  disabled + `box-only` behaviour.
- Curator post-checks: ungrounded rule refused, contradiction → digest, budget
  enforced, untrusted-only evidence refused, secret dropped.
- Skill pipeline: production-touching procedure never promoted, trial fail →
  runbook, retirement.
- Briefing: token budget, ordering, delegate jobs receive it.
- Undo: each mode reverts and reports.
- improvemyagent shim: export layout parsed by the pinned version (fixture DB),
  failure → week skipped.

## 13. Rollout and follow-up

1. Ship with the global defaults `enabled: true`, `repoRules: "pull-request"`,
   `sharing: "share-and-read"`, identical on every box, with no per-project
   presets. The first digest lists every detected project with its effective
   settings so the user can change any of them in one place.
2. **Baseline first**: before the curator writes anything, record a week of
   "re-explanations" — improvemyagent's correction count per 100 user turns,
   plus user messages that restate a fact already in the store (FTS match).
3. **Measurement routine** (created with the release, weekly for 6 weeks): the
   same two numbers, rules/skills added and removed, undo count, briefing size,
   search tool usage. Decision it informs: keep, tune budgets, or switch the
   default `repoRules`. Thresholds: re-explanations down ≥ 30% at week 4 →
   keep; undo rate > 20% of curator items → curator gets stricter bars; search
   tool used in < 10% of sessions → rewrite its guidance.
4. **Acceptance** (borrowed from agent-cto M4): for MantaUI, Capo and LeaseBot, a
   fresh session answers "how do we run tests / deploy / what does the user
   prefer here?" correctly from the briefing and tools alone.
5. Follow-up: contribute an OpenCode V2 adapter to improvemyagent.

## 14. Open questions

1. Should the user wiki also be shown (read-only) in the iOS app in v1?

Resolved: defaults are generic (§13.1); curator models per §6.2.1.
