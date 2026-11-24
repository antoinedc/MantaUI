# `ask_user` — a generic question to the user, for every specialist task

Status: first version, 2026-11-24. Owner: Antoine. Builds on the research library
(`2026-11-24-research-library.md`) and Agents Phase 5A. **Speed rule: smallest usable version; edge cases go to
`docs/agents/follow-ups.md`.**

## 1. Why

The Architect must not carry agent-design opinions in Manta's code or templates: what it believes about good design comes
from its research and the library, so it updates without a release. When its research says a request is a bad idea (a new
agent that overlaps or is too narrow next to an existing one), it needs a way to say so to the user instead of silently
complying or silently reshaping. That is a **generic** need of every specialist (a request the research says is a mistake),
so the tool is every task's, not the Architect's.

## 2. Decisions

- **One tool, `ask_user`, in every specialist task** (the Architect's included): `question`, `options` (2–4, each
  `{label, description}`), `recommended` (0-based index, optional), `why` (short; may cite library entries or sourceIds),
  `concern` (boolean, optional: the agent thinks the request as given is a mistake). The name collides with nothing.
- **It does not wait.** A background task can't wait on a person (questions are denied in tasks). Calling it stores the
  structured question on the task's job record and marks the task blocked: it **ends as "needs a decision"** through the
  existing `endedBlocked` path (no parallel one). The tool tells the model to end its turn at once. A stored question
  decides even if the model reports "working" afterwards (`endedBlocked` = blocked state OR a stored question).
- **The result carries a server-written block** (`askUserLines`, like the Architect's `Outcome:` lines): header
  `Question for the user (written by the server; …)`, `Question:`, numbered `Options:`, `Recommended: option N (label)`,
  `Why:`, `Concern: yes — …`. Each field is one line (line breaks collapse), so a field can never forge another line. Only a
  finished (`done`) task that asked carries it; the structured question is also in the result's metadata.
- **The lead puts it to the user** (lead brief `MECHANICS` + `agentTemplates/manta/agent.md`): in ONE question call, all
  the questions of the turn at once, the recommended option first, any concern stated plainly; it never answers for the user.
  The answer goes back to the same task with `agent_handoff` + `continueJob: <jobId>` (the existing continuation: the next
  round starts with no question and no blocked state).
- **Generic guidance**: ONE domain-free line in `RESEARCH_GUIDANCE` (every task prompt): if what you found says the request
  as asked is likely a mistake, don't silently comply or silently change it; call `ask_user`.
- **The Architect behaves like any agent.** Its templates lose every agent-design opinion (prefer extending, don't overlap,
  how specialised, size, personas, pruning, "what a model would do anyway"). Kept: the process (read the roster, check the
  library, research, propose with quotes, admission table), the evidence bar, the tool usage, the safety/permission
  mechanics. One process line added: compare the request with the roster in light of what the research says; `ask_user`
  when they conflict.

## 3. Design

- **Tool** `ask_user` (`docs/opencode-plugins-v2/manta/tools/ask-user.ts`) → `POST /api/ask-user` (same body shape as the
  research tools: `sessionID`, `messageID`, `callID`, the arguments). A refusal is a sentence, never an error.
- **Binding** (`bindResearcher`, now also returns the task's `jobId`): the exact running tool part and its arguments, the
  calling agent being an agent package, the calling session being the child of that agent's RUNNING specialist task (the
  Architect also its stamp). Nothing is stored before it passes; a call can be used once.
- **Permission**: `SPECIALIST_TASK_TOOLS` (research tools + library + `ask_user`) is allowed in the read-only and worktree
  rulesets, added to a user-edited grant list (`withResearchToolAllows`) and in the Architect's ruleset — the same places the
  research tools are.
- **Engine** `src/server/askUser.mjs`: bind → validate (`normalizeAsk`) → `delegateEngine.recordAskUser(jobId, ask)`, which
  writes `askUser` + `jobProgress.modelState = "blocked"` on a RUNNING record under the jobs lock (null when not running).
- **Result** `buildCompletionText` appends the block after the agent's own text; the result's `metadata.manta.askUser`
  carries `{question, options, recommended, why, concern}`.

## 4. Libraries considered

| Need | Chosen | Considered, why not |
|---|---|---|
| Ending a task "needs a decision" | existing `endedBlocked` path (`delegate.mjs`) | A parallel "waiting" state: more states for the same outcome. |
| Binding / permission of the tool | existing `bindResearcher` + `SPECIALIST_*` rulesets | A new binding: the research tools already prove the calling task. |
| Putting the question to the user | the lead's existing question tool (brief text only) | A new UI: out of scope. |
| Schema of the question | plugin schema helpers (`lib/schema.ts`) + a 40-line validator | `zod`/`ajv`: the project validates tool input by hand next to every route; one object of five fields. |
| Anything else | none | Nothing to add. |

## 5. Not in this version (see `docs/agents/follow-ups.md`)
