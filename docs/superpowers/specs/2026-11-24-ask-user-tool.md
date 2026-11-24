# A specialist's task asks the user — with OpenCode's standard `question` tool

Status: second version, 2026-11-24 (the first version, PR #1730, was a custom `ask_user` tool; the user decided against a
custom tool). Owner: Antoine. Builds on the research library (`2026-11-24-research-library.md`) and Agents Phase 5A.
**Speed rule: smallest usable version; edge cases go to `docs/agents/follow-ups.md`.**

## 1. Why

The Architect must not carry agent-design opinions in Manta's code or templates: what it believes about good design comes
from its research and the library. When its research says a request is a bad idea, it must be able to tell the user instead
of silently complying or silently reshaping. That is a generic need of every specialist, so it is every specialist task's,
and it uses the tool OpenCode already has: `question`.

## 2. Decisions

- **No custom tool.** `ask_user` (plugin tool, route, binding, ruleset entry) is removed.
- **Specialist tasks (the Architect's included) may use `question`.** Their rulesets allow it, and their child session is
  created without the trailing `question` deny (`normalizeJobRuleset(rules, { allowQuestion: true })`). Every other Manta-owned
  job (plain `delegate`, CTO work, slash-command runs) keeps the trailing deny: its questions are denied and, if one is
  raised anyway, rejected by the pump.
- **The server captures the question** (`handleQuestion` in `delegate.mjs`, called by the pump for a question form raised in an
  owned session). When the form belongs to the ROOT session of a RUNNING specialist task:
  1. it is mapped (`decisionFromForm`, over the existing `questionFromForm`: question text, options as label + description,
     multiple) and stored on the job record as `decision`, with the task marked blocked (`recordDecision`);
  2. the turn is interrupted (`abortSession`, the same call a stop uses);
  3. the form is rejected so nothing stays pending (`rejectAsk`; a failure is queued for the sweep as for any job).
  The form is never interpreted, published or pushed: no card, no notification.
- **The task ends through the existing "needs a decision" path.** The raw `interrupted` outcome is read by `settleV2Job` as
  done instead of failed when the record holds a decision (a user stop or pause still wins); `endedBlocked` is "blocked state OR
  a stored decision", so a task that kept working after the interrupt failed still ends "needs a decision".
- **Result, lead brief and `continueJob` are unchanged.** The result carries the server-written block
  (`decisionLines`: `Question for the user (…)`, `Question:`, numbered `Options:`, `Several options may be chosen.`);
  `metadata.manta.decision` holds the structured form. The standard tool has no recommended / why / concern fields, so they are
  omitted: the generic guidance and the Architect's step tell the agent to put its recommendation and what it found in the
  question text. The lead puts it to the user in one question call and sends the answer back with `continueJob` (the next
  round starts with no decision). A finished task that asked owes no report of its own actions.
- **Subagents of a task** that ask are still denied/rejected as before (only the task's own session is captured).
- **Liveness and the cap:** the task ends at once, so it stops counting toward the 5-task cap and leaves the liveness picture
  with the run; the stall rule never sees it.
- **Generic guidance** (one domain-free line in `RESEARCH_GUIDANCE`) and the Architect's compare step say: ask the user with
  the question tool, with your recommendation and what you found.

## 3. Checks

Unit tests for the mapping and block (`taskDecision.test.mjs`), the rulesets, the capture, the settle, the cap and stall,
continuation and the not-captured cases (`delegateV2Jobs.test.mjs`). Real check on the pinned OpenCode binary with the real
delegate engine and a scripted model: `node scripts/opencode-v2/question-capture.e2e.mjs`.

## 4. Libraries considered

| Need | Chosen | Considered, why not |
|---|---|---|
| Asking the user from a task | OpenCode's own `question` tool | A custom `ask_user` tool (the first version): a second mechanism for what the platform already does. |
| Form → question mapping | existing `questionFromForm` | — |
| Ending a task "needs a decision" | existing `endedBlocked` path + the stop's interrupt | A parallel "waiting" state. |
| Anything else | none | Nothing to add. |

## 5. Not in this version (see `docs/agents/follow-ups.md`)
