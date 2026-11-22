# Agents — Phase 1: named agents you can @mention and talk to

Status: draft for review (2026-11-22). Owner: Antoine.
Context: the agents proposal (https://…/pages/manta-agents), research in the
conversation's artifacts. **Speed rule from the user: ship the smallest usable
version fast; edge cases become follow-ups, not blockers.**

## 1. What the user can do when Phase 1 ships

1. Open the new **Agents** section in the sidebar and see the agents on the box.
   A built-in **Dev** agent exists on every box.
2. Click an agent → a **direct chat** with it opens (no project; it runs in the
   agent's own home folder). Ask "how would you build X?".
3. In any project chat, type `@` → matching agents appear → pick `@dev` → write
   the request → Enter. The request is **not** sent to the current chat's model.
   Instead a **task** starts for that agent: a running card appears
   ("Dev · <task>", with the user's request quoted on it), and when the agent is
   done its result card lands in the same chat. Dev works in its own worktree
   and branch (it edits code); agents with `isolation: none` work read-only in
   the chat's own folder. One agent per message in Phase 1.
4. Click **+** in the Agents section → name + one-line description (+ "edits
   code in its own branch" checkbox) → a new agent exists. Its files are plain
   Markdown under `~/.manta/agents/<slug>/`; editing them (by hand or by asking
   any chat) changes the agent.
5. Per-project specialisation: an optional file
   `~/.manta/agents/<slug>/seats/<project-slug>.md` is added to that agent's
   tasks in that project only.

Out of Phase 1 (follow-ups): agent profile page, versions, the meta agent,
autonomy rules, catalog tools, iOS mentions, agent-to-agent tasks, per-agent
memory beyond the seat brief, variants, mentions in the CTO conversation
(still refused there), Phase 2 routines (§9 sketch only).

## 2. Agent package (the file format) — pinned contract

```
~/.manta/agents/<slug>/
  agent.md                 # required
  skills/<name>/SKILL.md   # optional, Agent Skills format (name/description frontmatter)
  seats/<project-slug>.md  # optional per-project brief (project-slug = knowledge registry slug)
  home/                    # created by Manta; cwd of the direct chat
  .compiled.md             # written by Manta; never edit
```

`agent.md`:

```markdown
---
name: Dev                 # display name, required, ≤ 40 chars
description: Writes and fixes code in the current project.   # required, ≤ 200 chars
isolation: worktree       # "worktree" | "none" (default "worktree"; a non-git chat folder falls back to "none")
model: anthropic/claude-sonnet-5-5   # optional "provider/model"; omitted = Auto/default
color: "#5A88FF"          # optional
---
<role prompt, Markdown>
```

- `slug`: the folder name, `^[a-z][a-z0-9-]{0,30}$`. Reserved (refused on create,
  skipped on scan): `build plan general explore compaction title summary cto
  manta-plan`.
- An `agent.md` that fails to parse is listed with `error` and is not compiled
  (never crashes the scan).
- The compiled block also carries `permission: { external_directory:
  { "<abs agent dir>/**": "allow" } }` so the agent can read its own skills
  and briefs from any working directory.
- `.compiled.md` = role prompt + (when `skills/` has entries) a section
  `## Your skills` listing each skill's name, description and absolute
  `SKILL.md` path, with the line "Read a skill's file before doing work it
  covers." Skills are progressive disclosure through the read tool; no
  per-agent opencode skill permissions in Phase 1.

## 3. Compilation into OpenCode

Each valid agent becomes an OpenCode V2 agent block through the existing single
writer (`editConfig`/`setSubagents` path in `src/server/providers.mjs`, live
reload, no restart):

```jsonc
"agent": { "agent-<slug>": {
  "mode": "all", "description": "<description>",
  "prompt": "{file:/home/…/.manta/agents/<slug>/.compiled.md}",
  "model": "<model>"        // only when set
} }
```

- Manta-installed blocks are tracked in `~/.manta/agents/.installed.json`
  (list of opencode keys). Sync = upsert every valid agent; remove only keys in
  that list whose package is gone/invalid; never touch other blocks (a user's
  own `agent-foo` survives). No-op diff = no write.
- **If any `.compiled.md` content changed but the config diff is empty, call
  `reloadOpencodeConfig()` once** (the prompt file path is constant, so the
  config writer would otherwise skip the reload and the old prompt stays live).
- **Model-subagent sync must ignore package agents:** `readAgentBlocks` /
  `syncSubagents` skip keys starting with `agent-`, and `deriveSubagentName`
  never produces a name starting with `agent-` (prefix it with `m-` if it would).
- Sync runs: at boot (after built-ins are installed), after `agents:create`, and
  on every `agents:list` when any `agent.md`/skill mtime changed since the last
  sync (cheap stat scan; no file watcher in Phase 1).

## 4. Built-in agent

`src/server/agentTemplates/dev/agent.md` ships in the repo (under `src/`, so
the release tarball packs it) (isolation `worktree`, a short,
general dev role prompt; no project-specific text). At boot, if
`~/.manta/agents/dev/` does not exist, copy it there. Never overwrite an
existing folder (user edits win; template updates reach a box only if the
user deletes the folder — follow-up: versioned template sync). No other
built-ins (agents stay use-case agnostic).

## 5. Server — `src/server/agents.mjs` (new, dependency-injected)

`createAgentsEngine({ root, fs, editConfig/readConfig deps, oc, delegate, tmux, registry, now })`:

- `list()` → `AgentInfo[]`, also triggers the mtime-gated sync.
- `create({ name, description, isolation })` → slug from name (lowercase,
  non-alnum → `-`, trimmed; collision → `-2`, `-3`); writes `agent.md` with a
  one-paragraph generic role prompt built from the description; sync; returns
  `AgentInfo`.
- `dispatch({ sessionId, directory, slug, text })` → starts a task:
  1. Resolve agent (unknown / invalid → throw "No agent named @slug"). Refuse a
     CTO-conversation parent ("@agent mentions aren't available here").
  2. Build the job prompt: the user's request; then, if present, the seat brief
     for `registry.identify(directory).slug`; then "Recent conversation"
     (last 10 user/assistant text messages of `sessionId`, newest last,
     ≤ 6 000 chars total, read with `oc.listMessages`; a read failure just
     omits the section).
  3. `delegate.startJob({ prompt, parentSessionID: sessionId, parentDirectory:
     directory, agent: "agent-<slug>", isolation, model: <agent model or
     undefined>, name: <first 6 words of text>, agentName, request: text })`.
     Before that, `delegateView.assertWritable(sessionId)` like `opencode:prompt`.
  4. Return `{ jobId }`. A start failure throws with the refusal message
     (nothing was recorded, so a retry is safe).
  - The request is NOT posted into the parent session (no synthetic): it lives
    on the job record and is shown on the card. The chat's model never sees the
    request; the result arrives through the existing result path
    (`resume: true`), so the chat shows the result card and its model may
    react to it — accepted for Phase 1.
- `openChat({ slug })` → `{ tmuxSession, windowIndex }`: reuse the window in
  tmux session `manta-agents` whose `opencodeSessionId` equals the id stored in
  `~/.manta/agents/<slug>/.chat.json` (`tmux.listProjects()` already exposes
  it); otherwise `oc.createSession({ directory: home, agent: "agent-<slug>",
  title: name })`, write `.chat.json`, then `tmux.newWindow({ sessionName:
  "manta-agents", windowName: name, chatMode: true, existingSessionId, cwd:
  home })` — or `tmux.newSession({ name: "manta-agents", cwd: home, windowName:
  name, chatMode: true, existingSessionId })` when the tmux session doesn't
  exist (newWindow does not recover from "no tmux server"), then
  `syncState.refreshNow()` as `tmux:new-window` does.

## 6. Background job changes — `src/server/delegate.mjs`

`startJob` input gains (all optional, existing callers unchanged):
- `agent` — OpenCode agent for the child (default stays `"build"`); set on the
  job record (replacing the hardcoded `V2_JOB_AGENT` only when given) and so
  passed to `createChildSession` and the prompt.
- `isolation: "worktree" | "none"`:
  - `"worktree"` → `isolationRequired: true` (fail closed: no worktree ⇒ refuse,
    never fall back to the parent checkout).
  - `"none"` → skip `prepareWorktree`; `executionDirectory = parentDirectory`;
    the child ruleset is deny-by-default (`"*": "deny"` first) then allows only
    `read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `todowrite`, the
    `progress_report` tool, and `external_directory` for the agent's own folder
    (no bash, no edit); the no-worktree prompt drops "Commit your work as you go".
- `agentName`, `request` — stored on the record, exposed in the job view.
- Result delivery unchanged.

## 7. Wire — RPC channels (contract for both implementers)

Types in `src/shared/types.ts` + `Api` in `src/shared/api.ts`:

```ts
export interface AgentInfo {
  slug: string; name: string; description: string;
  isolation: "worktree" | "none"; model: string | null; color: string | null;
  builtIn: boolean; error?: string;   // error set ⇒ not usable
}
// IPC
agentsList: "agents:list"            // () => AgentInfo[]
agentsCreate: "agents:create"        // ({name, description, isolation?}) => AgentInfo (no checkbox in the UI: the default applies)
agentsDispatch: "agents:dispatch"    // ({sessionId, directory, slug, text}) => {jobId: string}
agentsOpenChat: "agents:open-chat"   // ({slug}) => {tmuxSession: string, windowIndex: number}
```

Errors are thrown with a human message (class-1: shown to the user).

Job views (`delegateView` / `jobViews`) carry `agentName` and `request` when
set. No transcript mapping change.

## 8. Renderer

- **Typeahead** (`useTypeahead.ts`): a NEW package-agent catalog (from
  `agentsList()`, valid agents only) feeds the mention rows; the existing
  OpenCode `agentCatalog` stays as is (Plan discovery uses it). Typing `@`
  shows matching package agents first, then files; `@@` shows agents only.
  Picking an agent row (decided by `row.kind`, not popup mode) inserts
  `@<slug> ` and records the mention keyed by slug.
- **Send** (`ChatPanel.tsx`): intercept ONCE at the top of `submit`, before the
  busy branch and before any optimistic update. Pure helper
  `pickAgentDispatch(text, mentions, agents)` → `{ slug } | { error } | null`
  (tested): null = no package-agent mention (normal path); more than one
  distinct package agent → `{ error: "Mention one agent per message for now" }`.
  On `{slug}` call `agentsDispatch({sessionId, directory, slug, text})`; do NOT
  call `opencodePrompt`. Success → clear the composer (only if it still holds
  the submitted draft); failure → keep the draft, show the error. Slash
  commands and the CTO conversation keep their existing paths.
- **Cards** (`BackgroundCards.tsx`, `backgroundRun.ts`): carry `agentName` and
  `request` through `deriveBackgroundCards`. When a job has `agentName`, the
  running card's label reads `<agentName> · <job name>` instead of "Running in
  background:" and shows the request (one line, ellipsis, full text as title);
  the result card title uses the agent name when
  `part.agent` starts with `agent-` (look up the slug in the catalog, fall back
  to the slug).
- **Sidebar** (`Sidebar.tsx`): an **Agents** section above the Workspace list:
  one row per agent (colour dot or initial, name; description as title;
  invalid agents greyed with the error as title). Click → `agentsOpenChat` →
  refresh projects → select the returned window. The `manta-agents` tmux
  session is hidden from the Workspace DISPLAY only (it stays in the store so
  selection works). `+` → a small `<dialog>` (name, description, checkbox "Edits code in
  its own branch") → `agentsCreate`; errors inline. The tmux session
  `manta-agents` is hidden from the Workspace list.
- **Direct chat**: an ordinary chat-mode window. Plan-mode toggle hidden in
  `manta-agents` windows (it would reset the session agent to `build`).
- New `Api` methods get demo stubs or `DEMO_UNIMPLEMENTED` entries.

UI follows Modern Web Guidance `dialog`, `forms`, `accessibility` (native
`<dialog>` with `showModal()`, real `<form method="dialog">`, labels, Esc closes).

## 9. Phase 2 sketch (not built now; keeps the format forward-compatible)

- Routine gains optional `agent: <slug>`: its run session is created with
  `agent-<slug>` (skills, role) and the seat brief of the routine's project.
- `routine_report` gains optional `actions[]`:
  `{ key, title, why, evidence?: string[], suggestedAgent?: slug, kind?, urgency? }`;
  the report UI shows a "Send to @agent" button per action calling
  `agents:dispatch`; the next run receives open actions + their job status.

## 10. Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Frontmatter parsing | `yaml` (already a dependency) + a 10-line `---` split | `gray-matter` (adds a dep for a trivial split) |
| opencode config writes | existing `editConfig` (jsonc-parser) | writing `~/.config/opencode/agents/*.md` (V2 markdown agents) — would bypass the single-writer rule and need its own reload story |
| Change detection | mtime stat scan on `list()` | `chokidar` / `fs.watch` — not needed at this scale; follow-up if edits feel laggy |
| Request visibility | job record + card | posting a synthetic into the parent — becomes model input and only shows on delivery |
| Task execution | existing delegate engine (worktree, liveness, result delivery, cards) | a new runner — duplicate of shipped machinery |
| Skill loading per agent | prompt index + read tool | V2 `permission.skill` rules — unverified behaviour, not needed for Phase 1 |
| Dialog | native `<dialog>` | modal library (guide-backed native feature wins) |

## 11. Tests (each implementer runs the real checks; heavy suites on Freestyle)

- `src/server/agents.test.mjs`: frontmatter parse (valid / invalid / reserved
  slug), slugging + collision, `.compiled.md` content with skills, sync plan
  (upsert / remove / no-op) via injected config I/O, dispatch builds the right
  synthetic + job input (brief included when present, excerpt capped), openChat
  reuse vs create.
- `delegate` tests: `isolation:"none"` skips the worktree; `agent` reaches
  `createChildSession`; `agentName` in the view.
- providers: `readAgentBlocks`/`syncSubagents` ignore `agent-*`;
  `deriveSubagentName` never yields `agent-*`.
- Renderer: `pickAgentDispatch` unit tests; typeahead ordering test.

## 12. Implementation split (no shared paths)

- **Server implementer**: `src/server/agents.mjs` + tests, `delegate.mjs`,
  `rpc.mjs` channels, `index.mjs` boot wiring (install built-ins, first sync),
  `providers.mjs` + `src/shared/subagentSync.mjs` (ignore/reserve `agent-*`),
  job view files, `src/server/agentTemplates/dev/agent.md`.
- **Renderer implementer**: `useTypeahead.ts`, `agentCatalog.ts`, `ChatPanel.tsx`,
  `BackgroundCards.tsx`, `backgroundRun.ts`, `Sidebar.tsx` (+ a new `AgentsSection.tsx`),
  `httpApi.ts`, `demoApi.ts`/`demoCoverage.test.ts`, renderer tests.
- `src/shared/types.ts` / `src/shared/api.ts` contract additions are committed
  by the orchestrator before dispatch.
