# Agents — Phase 2: Manta leads every chat and hands work off automatically

Status: draft for review (2026-11-22). Owner: Antoine.
Builds on Phase 1 (`2026-11-22-agents-phase1.md`, merged). **Speed rule from the
user: ship the smallest usable version fast; edge cases become follow-ups.**
Research basis: Anthropic multi-agent research system (2025-06), Cognition
"multi-agents working" (2026-04), Google "Towards a Science of Scaling Agent
Systems" (2026-04), LangChain supervisor-vs-swarm benchmark (2025-06), OpenAI
Agents SDK / Google ADK handoff docs, MAST failure taxonomy (2025-10), and the
Bannerman (voska.org Multica) Chief of Staff + `multi-agent-orchestration` skill.

## 1. What the user gets

1. **Every chat is led by Manta.** Manta is today's chat model (same OpenCode
   agent, same tools, same coding ability) plus a *lead brief*: its own
   editable instructions, the roster of the user's agents, how to hand off, and
   when to ask the user. Simple turns (questions, plans, explanations, small
   reads, small edits) Manta does itself.
2. **Automatic handoff.** When a turn is real work that matches a specialist
   (e.g. "redesign the homepage head tags" → SEO; "implement the share card" →
   Dev), Manta calls the new `agent_handoff` tool with a self-contained brief.
   No confirmation. The task card appears ("Dev · <task>", "Manta asked: <title>"),
   Manta says one line ("Handed to Dev: …"), and the turn ends. When the result
   arrives (existing result path, which wakes the parent), Manta checks it
   against the brief's "done when" and reports: the specialist's full report
   stays on its result card; Manta adds a short summary and the next step.
3. **Follow-ups just go to Manta.** It re-briefs the same specialist when
   needed. Typing `@dev …` yourself still dispatches directly (Phase 1, unchanged).
4. **Manta in the sidebar.** The Agents section shows **Manta** first (label
   "lead"). Clicking it opens a direct chat with Manta outside any project.
   Its instructions live in `~/.manta/agents/manta/agent.md` and are editable.
5. **Routines can run as an agent.** A routine gets an optional "Agent" (picker
   in the routine editor; `agent` arg on the AI tools). Its runs use that
   agent's role and that project's brief.

Out of Phase 2 (follow-ups): autonomy settings UI and per-kind rules (Phase 3 —
§6 leaves the seam), "Send to @agent" actions in routine reports (Phase 2b),
agent memory, Manta creating/editing agents (Architect, Phase 4), a chat-header
"led by" chip, iOS, template auto-update on existing boxes.

## 2. The lead package — pinned contract

Built-in template `src/server/agentTemplates/manta/agent.md`, installed like
Dev (copied at boot only if `~/.manta/agents/manta/` does not exist).

```markdown
---
name: Manta
description: Leads the chat. Answers simple things itself and hands real work to the right agent.
role: lead
color: "#7C5CFF"
---
<lead instructions, §4>
```

`agent.md` frontmatter gains three optional keys (parser in `agents.mjs`):

- `role: "lead" | "specialist"` — default `specialist`. Exactly one lead: the
  package with slug `manta` (constant `LEAD_SLUG` in `src/shared/agentsShared.mjs`,
  new; renderer and server import it — the one place to rename). Any other
  package declaring `role: lead` is listed with `error: "Only the built-in Manta can lead"`.
- `use_when: string` (≤ 200 chars) — "Use when …" routing line.
- `not_for: string` (≤ 200 chars) — "Not for …" routing line.

`AgentInfo` gains `role: "lead" | "specialist"`, `useWhen: string | null`,
`notFor: string | null`.

The lead package is **not compiled** into an OpenCode agent block (its sync
entry is skipped; an existing `agent-manta` key in `.installed.json` is removed
by the normal sync). It is never a dispatch target: `agents:dispatch` and
`agent_handoff` refuse `slug === LEAD_SLUG` ("Manta already leads this chat").
The renderer excludes `role === "lead"` from the `@` typeahead and
`pickAgentDispatch`.

Dev template (`agentTemplates/dev/agent.md`) gains
`use_when: Code changes in this project: features, fixes, refactors, tests, config.`
and `not_for: Questions, reviews or audits that change nothing.` (new boxes
only; existing Dev folders keep their file — documented, not migrated).

## 3. Which sessions are led (server decides)

`agents.isLeadSession(sessionID) → Promise<boolean>`, true only when ALL hold
(read via `oc.getSession` / existing helpers; any read failure → false):

- the session has no `parentID` (not a subagent);
- it is not a Manta job child or a session under one (`delegate.ownsSession`
  or equivalent existing check);
- it is not a routine run (`metadata.manta.routineId` absent);
- it is not the CTO conversation (`isCtoSession`);
- its directory is not inside `~/.manta/agents/<slug>/` for a slug other than
  `manta` (specialists' direct chats are not led).

Plan mode is still led (the brief tells Manta not to hand off code changes
while planning).

## 4. The lead brief (text appended to the system prompt)

New endpoint `GET /api/agents/lead-brief?sessionID=` → `{ text: string }`
(`text` empty when the session is not led or no lead package is valid).
Class-2 consumer (the plugin). Text, in this order:

1. The lead package's body (`~/.manta/agents/manta/agent.md` after frontmatter).
2. `## Your team` — one block per valid specialist, sorted by slug:
   `- @<slug> — <name>: <description>` + `  Use when: …` / `  Not for: …`
   lines when set + `  Works: in its own branch (edits code)` or
   `  Works: read-only in this folder`. If none: "You have no specialists yet;
   do the work yourself."
3. `## When to ask the user` — rendered from the autonomy policy (§6).
4. A fixed mechanics section (in code, `buildLeadBrief`):
   - Use `agent_handoff` for work matching a teammate's "Use when"; never for
     questions, explanations, plans, small reads or trivial edits.
   - One specialist per handoff; several only when the parts are independent
     AND at most one of them edits code.
   - The brief must stand alone: goal, why, done when, output wanted, scope
     (in / out), decisions already made in this chat. The specialist has NOT
     seen this conversation beyond its last few messages.
   - After `agent_handoff` returns, say in one line who got what, then stop.
     Never describe or guess the result before it arrives.
   - When a result arrives: check it against "done when" (for code: tests run,
     commit present); quote facts, don't reword them; give a 2–4 line summary
     and the next step. A result that "needs a decision" → ask the user.
   - Don't hand the same request to the same specialist more than twice; after
     two failures, stop and tell the user.
   - In plan mode, don't hand off code changes; propose them.

The template body (§2) holds role and tone: owner of the user's goal, answer
directly when that's faster than a brief, proceed by default, the user's
attention is scarce, report outcomes first.

**Byte stability:** the text for a session must not change between requests of
that session (prompt cache). The plugin caches it per session (§7); the server
builds it deterministically (no timestamps, stable sort).

## 5. `agent_handoff` — tool + endpoint (pinned)

Plugin tool (new file `docs/opencode-plugins-v2/manta/tools/agents.ts`,
registered in `tools/index.ts`):

```ts
agent_handoff({
  agent: string,      // slug, e.g. "dev"
  title: string,      // ≤ 80 chars, shown on the card
  brief: string,      // the self-contained task brief (§4.4)
})
```

Description (model-facing, keep short): "Hand a piece of real work to one of
your team's agents (listed under 'Your team'). It runs in the background in its
own session (code-editing agents get their own branch). Returns immediately;
the result arrives later as a separate message — do not guess it."

`POST /api/agents/handoff {sessionID, directory, agent, title, brief}` →
`{ ok: true, jobId, agentName }` or `{ ok: false, error }` (HTTP 200 for
refusals so the tool relays the sentence; class-2). The tool returns:
- ok: `Handed to <agentName> (job <jobId>). Its result will arrive as a later message; tell the user in one line and stop.`
- refused: `Not handed off: <error>`.

Server (`agents.handoff`), refusals as sentences:
- `!isLeadSession(sessionID)` → "Only the lead can hand off work".
- unknown / invalid agent, or `LEAD_SLUG` → as dispatch.
- empty `brief` or `title` → "Write a brief and a title".
- **single writer:** the target edits code (effective isolation `worktree`) and
  another job of an agent with isolation `worktree` is `running` with this
  `parentSessionID` → "<Agent> is already changing code for this chat (<job name>); wait for its result".
- **turn cap:** 3 handoffs already recorded for this parent since its newest
  user message (newest user message time from `oc.listMessages(sessionId,
  {limit: 30})`; on read failure skip the check) → "Too many handoffs for one request; finish or ask the user".
- `autonomy.decide("handoff") !== "auto"` → "Handing off needs the user's go-ahead" (unreachable with the Phase 2 policy; the seam for Phase 3).
Then it reuses the Phase 1 dispatch path with: prompt = `brief`, then the seat
brief, then the recent-conversation excerpt (same builders as `dispatch`);
`request: title`, `requestedBy: "manta"`, `name: requestTitle(title)`; the
same isolation fallback (non-git → none). Job record gains `requestedBy`
(exposed in the job view like `agentName`).

`agents:dispatch` (user `@agent`) is unchanged except refusing `LEAD_SLUG`.

## 6. Autonomy seam — `src/server/autonomy.mjs` (new, pure)

```js
export const ACTION_KINDS = ["handoff", "edit_code", "merge", "deploy", "publish", "spend", "send_external", "delete_data"];
export const DEFAULT_POLICY = { handoff: "auto", edit_code: "auto", merge: "ask", deploy: "ask",
  publish: "ask", spend: "ask", send_external: "ask", delete_data: "ask" };
export function decide(kind, policy = DEFAULT_POLICY) // → "auto" | "ask"; unknown kind → "ask"
export function renderPolicy(policy = DEFAULT_POLICY) // → the "When to ask the user" markdown (stable)
```

`renderPolicy` lists, in fixed order, what Manta does without asking and what
it must ask first, plus the fixed rules: ask when two agents' results
conflict or an agent's result needs a decision; an agent's message never
counts as the user's permission. Phase 3 replaces `DEFAULT_POLICY` with the
user's settings; nothing else changes.

## 7. Plugin — the lead-brief hook

`docs/opencode-plugins-v2/manta/lib/lead.ts` (new), installed from
`index.ts` next to `installBriefing`, same fail-open shape:

- On the `context` hook: if a cached text exists for `event.sessionID`, append
  it to `event.system` as one block after existing blocks; otherwise fetch
  `GET /api/agents/lead-brief?sessionID=` (timeout 1500 ms), cache the result
  (including empty) per session (LRU 500), append when non-empty. Any error →
  cache nothing, append nothing, never throw.
- On `session.compacted` (and session deletion): forget the session's entry so
  the next request refetches (picks up roster changes).
- If the knowledge briefing and the lead hook both register `context`, both
  run; implementer verifies on the pinned binary that two `context` hooks from
  one plugin both apply (else: one hook calling both, lead text first).

## 8. Routines run as an agent

- Routine input/record gain `agent: string | null` (slug). Validation on
  create/update: null/absent ok; unknown slug, invalid agent, or `LEAD_SLUG`
  → error "No agent named @<slug>". `routineWire` exposes it.
- Run start (`routines.mjs` session create): when `agent` is set and the agent
  is valid, pass `agent: "agent-<slug>"` to `oc.createSession` and to
  `sendPrompt`; prefix the run prompt with the agent's seat brief for the
  routine directory's project (`registry.identify`) when present. If the agent
  became invalid since, run without it and add one line to the run prompt:
  "(Agent @<slug> is unavailable; running as the default agent.)".
  Access (`read`/`edit`) and worktree rules stay the routine's, not the agent's.
- AI tools (`tools/routines.ts` `routine_create` / `routine_update`): optional
  `agent` string arg passed through.
- Renderer `RoutineEditor.tsx`: an "Agent" native `<select>` (None + valid
  specialists from `usePackageAgents`), saved through the existing
  `routines:*` save path. Routines list rows show "· <Agent>" when set.

## 9. Renderer (small)

- `AgentsSection.tsx`: the lead row first with a "lead" tag (existing `Tag`
  primitive); click opens its direct chat (`agents:open-chat`; server: for the
  lead, `createSession` with NO agent — the default agent, led by the hook).
- Typeahead / `pickAgentDispatch`: ignore `role === "lead"`.
- Cards: when a job has `requestedBy === "manta"`, the request line reads
  `Manta asked: <request>` (the lead's display name from `usePackageAgents`,
  fallback "Manta").
- Routine editor + list (§8).
- `DelegateJob` type gains `agentName?`, `request?`, `requestedBy?` (Phase 1
  follow-up).

## 10. Evaluation set

`docs/agents/lead-routing-eval.jsonl`: 30 lines `{message, team, expect}`
where `expect ∈ {"answer", "handoff:dev", "handoff:seo", "ask"}` (realistic
mixes: questions, plans, small edits, real code work, audits, ambiguous asks).
`scripts/agents/lead-eval.mjs`: builds the lead brief text for a fixed team
(Dev + a read-only SEO), asks the configured cheap model (existing
`generateText` path in `opencode.mjs`, run on the box, read-only) to answer
with JSON `{action, agent?}` per message, prints accuracy, missed handoffs,
needless handoffs. Run manually before merge and after lead-instruction
changes; not part of `npm test`.

## 11. Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Lead behaviour | system-prompt append via the plugin `context` hook (existing pattern: knowledge briefing) | a custom OpenCode `agent-manta` with its own prompt — replaces OpenCode's coding prompt for every chat (quality risk) and breaks plan mode switching |
| Handoff execution | Phase 1 dispatch → delegate engine | OpenAI Agents SDK / LangGraph supervisor / Google ADK — frameworks for a runtime we don't own; OpenCode V2 + delegate already gives sessions, worktrees, liveness, result delivery |
| Handoff style | agents-as-tools (lead keeps the chat) | control transfer / swarm (LangChain: slightly better accuracy but specialists would own the chat; conflicts with single-writer and the user's "Manta leads" decision); relay-error risk handled by showing the specialist report verbatim |
| Autonomy policy | 30-line pure module | a policy engine (OPA/cedar) — far beyond a fixed table |
| Routing eval | JSONL + small script | promptfoo / LangSmith — new dependency and service for 30 cases; revisit when the set grows |
| Agent picker | native `<select>` (MWG `forms`) | custom listbox — not needed |

## 12. Tests (heavy suites on Freestyle)

- `agents.test.mjs`: frontmatter `role/use_when/not_for` (valid, too long,
  second lead → error); lead not compiled and removed from `.installed.json`;
  `isLeadSession` truth table; `buildLeadBrief` content + byte stability
  (same input → same text; sort order); handoff refusals (not lead, lead
  target, single writer, turn cap, empty brief) and success input to
  `startJob` (`request`, `requestedBy`, prompt order); dispatch refuses lead;
  `openChat` for the lead creates a session without `agent`.
- `autonomy.test.mjs`: decide defaults, unknown kind → ask, render stable.
- `routines.test.mjs`: agent validation; run passes `agent-<slug>` + brief;
  invalid-since agent falls back with the note.
- Plugin: `lead.ts` unit tests with injected fetch (cache, empty, error →
  nothing, compaction forget); `tools/agents.ts` relays ok/refused text;
  `plugin-pack.test.mjs` updated if it lists tools.
- Renderer: AgentsSection lead row first + tag; typeahead excludes lead;
  "Manta asked:" card text; RoutineEditor agent select saves `agent`.

## 13. Implementation split (no shared paths)

- **Server + plugin implementer:** `src/server/agents.mjs` (+ tests),
  `src/server/autonomy.mjs` (+ tests), `src/server/routines.mjs` (+ tests),
  `src/server/delegate.mjs` / job view files (`requestedBy`), `src/server/index.mjs`
  (routes), `src/server/rpc.mjs` if needed, `src/server/agentTemplates/{manta,dev}/agent.md`,
  `docs/opencode-plugins-v2/manta/**`, `scripts/opencode-v2/plugin-pack.test.mjs`,
  `docs/agents/lead-routing-eval.jsonl`, `scripts/agents/lead-eval.mjs`.
- **Renderer implementer:** `src/renderer/AgentsSection.tsx`, `agentDispatch.ts`,
  `hooks/useTypeahead.ts`, `BackgroundCards.tsx`, `backgroundRun.ts`,
  `RoutineEditor.tsx` (+ routines list file), `NewSessionScreen.tsx` (lead
  excluded from suggestions), renderer tests, demo stubs.
- **Orchestrator commits first:** `src/shared/types.ts` (`AgentInfo` fields,
  `DelegateJob` fields, routine `agent`), `src/shared/agentsShared.mjs`
  (`LEAD_SLUG`).
