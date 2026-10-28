# Nest background rows under the session that actually runs them

## Problem
Rows Manta adopts for sessions it didn't start (`origin` `observed`, plus
`subagent` / `command` adoptions) nest under `job.parentSessionID`. When that
session has no window the row renders top-level. Live example (2026-10-28):
cantina "P3-B execution engine" and "J early" have opencode parent
`ses_e8d7c1d0…` (an old orchestrator with no window). The work is driven by the
current orchestrator `ses_3204aa6f…` (window cantina:16), which reached it by:
- a hand-off with no record (`e8d7c1d0` → `e85ae240`, user pasted a summary),
- then a recorded auto-handoff `e85ae240` → `3204aa6f` (handoff `links`
  `replacedBy`),
- and it prompts / waits on the builders by session id from its own shell tool
  calls (`node tools/oc-session/send.mjs ses_e8aa2e47…`, `wait-idle.mjs …`).

## Rule: a display parent, separate from the real parent
New record field `displayParentID` (opencode-owned records only:
`completionOwnerOf(job) === "opencode"`). `parentSessionID` keeps its meaning
(result routing, listJobs, delegate_send ownership) and is never changed by
this feature. The renderer nests by `displayParentID ?? parentSessionID`
(`computeJobNesting`, `sessionsWithActiveWork`, and any other place that nests
or attributes a job row to a parent — implementer audits and lists them).

`resolveDisplayParent(job, deps)` — first match wins, every candidate must be a
session that currently has a window:
1. **Windowed ancestor** — the existing walk (`resolveSessionOwner`).
2. **Replacement successor** — for the opencode parent and each ancestor, follow
   handoff `replacedBy` links (`handoffEngine.chainOf` / an exported
   `successorOf(sid)`; transitive, cycle-safe, max 8) to a windowed session.
3. **Driver** — the windowed session that most recently referenced the job's
   child session id in its own transcript (tool-call input or output, any
   message type) within the last 24 h. One read-only query per tick over
   opencode's DB (`opencodeDb.mjs` / `dbTasks` worker, same budget pattern as
   messageSearch): candidate sessions = every windowed session id; match =
   `instr(session_message.data, <childSessionID>) > 0` with `time_created >=
   now-24h`; exclude the child itself and its own descendants/records' children;
   pick the newest hit; tie → same tmux workspace as the job's row first.
   No DB (`supported:false`) / budget hit → skip this rule.
4. None → leave `displayParentID` unset (row stays top-level, as today).

## When it runs
- At adoption (`adoptExistingSession`, all callers) — computed and stored.
- Every reconciler tick, for each non-terminal opencode-owned record whose
  current display parent (`displayParentID ?? parentSessionID`) has NO window:
  recompute; patch `displayParentID` when it changes (publish
  `delegate.updated`). A record whose display parent has a window is left
  alone (stable rows; no flapping). Driver lookups are batched: one DB task per
  tick for all such records.
- If the row's window lives in a different tmux workspace than the display
  parent, the renderer can't nest across workspaces: then also MOVE nothing —
  just leave it top-level (out of scope), and prefer same-workspace candidates
  in rule 3.

## Tests
- server: each rule in isolation and precedence; cycle safety; driver query
  against a temp SQLite store with the V2 schema (reuse existing opencodeDb
  test fixtures); 24 h window; DB unsupported → rule skipped; recompute only
  when current display parent is windowless; never patches manta-owned records;
  never changes `parentSessionID`.
- renderer: nesting uses `displayParentID` when present; falls back to
  `parentSessionID`.
- Real-box check (read-only): run the resolver against this box's live data
  (dry run, no writes) and report the display parent for the cantina rows
  P3-B / J early (expected `ses_3204aa6f…`).
