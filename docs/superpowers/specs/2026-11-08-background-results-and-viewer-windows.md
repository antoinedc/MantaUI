# Background results after a handoff, subagent handoffs, viewer windows, run settlement

Status: approved direction (user, 2026-11-08). Scope: `src/server/` only (no renderer, no iOS, no wire change
except one new `@manta-owner` value).

## Problem (live box, 2026-11-08)

1. **A background result goes to a retired session.** opencode posts a background `task` subagent's result
   (a `synthetic` record, `metadata.source:"subagent"`, `metadata.childID`) to the session id that launched it.
   After a Manta handoff that id is the retired predecessor: it wakes, runs a turn on stale context, and the
   live successor (the one in the window) never sees the result. crypto-otc: handoff `ses_eb54fd8d…` →
   `ses_151e730c…` committed 2026-11-06 16:17:58 UTC; three results arrived on the predecessor at 16:18:54,
   16:22:31, 16:54:24 and woke it three times. Manta re-routes only the messages it sends itself
   (`handoff.admit*` → `followReplacement`).
2. **`task` subagent sessions hand off, orphaning the successor.** A subagent calls the `handoff` tool (trigger
   `agent`) or auto-handoff fires; a successor is created; but the parent keeps resuming the ORIGINAL id
   (`task` with `sessionID`), so the original keeps working while the sidebar's conversation node points at
   the idle successor. On this box ~25 committed links have an original `task` child as predecessor (cantina "J early",
   "A: foundation", "P5-T builder", the orchestrator itself). Clicking the row opened the wrong session; the
   window row lit up "running" while showing an idle session.
3. **Windows opened on background rows are never closed.** `sessions:materialize` stamps
   `@manta-owner=user`; the box never closes `user` windows (crypto-otc windows 2–4, finished 2026-11-06).
4. **Fast-ending background runs are misreported.** An adopted record's `runStartedAt` is the moment Manta
   first saw the run (`part.state.time.start`, or the reconciler's first busy tick). A child that already
   ended before that (crypto-otc 16:12: "Model unavailable", "No cookie auth credentials found", both within
   1 s) has `time.idle < runStartedAt`, so its real outcome is ignored as stale and the lost-run judge reports
   "the run was cut off" 90 s later. A failed run that is not stale gets the generic "The run failed." — the
   real error text is in the parent's synthetic, never read.
5. **Job history is flooded.** Every resumed turn of a long-lived background subagent is a new record
   (cantina children at attempts 41/59/91/236). Superseded records count toward the 50-terminal-record cap, so
   the box's whole job history is a few hours of one workspace.
6. `sessions:close` with missing / malformed input answers `{ok:true}` having done nothing.

## A. `task` children never hand off into a successor (+ automatic repair)

**Definition — a *task child*:** a session whose opencode `parentID` is set AND which is not the own session
(`childSessionID`) of a job record with `completionOwnerOf(record) === "manta"` (a `delegate` launch / wrapped
command; those are repointed at commit and work). One pure predicate, `isTaskChild({ session, jobs })`, used by
both the policy and the repair. Unreadable session ⇒ not a task child for the policy (fail open = today's
behaviour), and SKIP (no change) for the repair.

**Policy (handoff engine):**
- `maybeAuto`: return early for a task child, next to the routine check.
- `create` with `trigger:"agent"`: for a task child throw `HandoffError("subagent", <message>)` for BOTH
  actions. Message (the tool relays it to the model verbatim):
  "This session is a subagent: its parent addresses it by this session id, so a handoff would orphan the new
  session. Don't hand off. Finish your task and report back; opencode compacts this session itself if it runs
  out of room."
- `trigger:"user"`/`"button"` are unchanged (an explicit user action).

**Repair (automatic, every box, idempotent):** on handoff-engine boot, once (a marker in the handoff state,
e.g. `state.repairs.taskChildLinks = <ISO date>`; absent marker ⇒ run), for every link `pred → succ`
(`links[pred].replacedBy === succ`):
- skip when `pred` is itself the `successorId` of any handoff record (a Manta-made successor — successors copy
  the parent's `parentID` but are never addressed by the parent);
- read `pred`; if it is a task child, cut the link (`delete links[pred].replacedBy`,
  `delete links[succ].replaces`, drop empty link entries — same as `state.mjs` line ~103 does);
- never touch records, fences, held queues or continuations.
Runs off the event loop's critical path (detached after load, bounded concurrency ≤ 4 reads), persists once,
logs `[handoff] repair: split N subagent handoff link(s)`. A read failure leaves that link and does not set the
marker (next boot retries). Session-status caches pick the change up on the next tree recompute (call the
existing refresh hook if one is wired; otherwise the next sync tick is fine).

## B. Relay a background result off a retired session

**Retired session:** `handoff.successorOf(sid) !== null` (it has a committed replacement link).

When a background result (a `synthetic` timeline record with `metadata.source === "subagent"`) lands on a
retired session `S`:
1. **Relay** it to the live end `L = followReplacement(S)` with `handoff.admitSynthetic(L, body)` where
   `body = { id, text, description, metadata: { ...original.metadata, relayedFrom: S, relayedMessageId:
   original.id }, delivery: "queue", resume: true }` and `id` is DETERMINISTIC from `(S, original.id)` (a valid
   opencode message id: `msg_` + hex of a sha256 prefix) so a retry or a second detection admits once.
2. **Keep `S` from acting on it:** if the item is still in `S`'s inbox, cancel it (`oc.cancelInboxItem`); else,
   if `S` is executing and the execution started at/after the result was delivered, interrupt it
   (`oc.interruptSession(S, { resume: false })`). Never interrupt an execution that started before the result
   arrived (someone else is driving `S`). Failures are logged, never thrown.

**Detection (implementer must confirm against the pinned V2 binary in the sandbox harness,
`scripts/opencode-v2/sandbox.mjs` — never the live `:4096`):** which raw event announces a synthetic arriving
(expected `session.inbox.enqueued` with a non-`user` item, or `session.inbox.delivered`), and its payload.
Wire it in the existing raw-event pump in `index.mjs`. Record the observed event in the spec's appendix and as
a fixture under `src/server/fixtures/opencodeV2Events/`.

**Backstop (pinned seam with D):** the engine exposes
`relayBackgroundResult({ sessionId: S, childSessionId }) → Promise<{ relayed: boolean, reason?: string }>`:
reads `S`'s raw timeline (`listRawTimeline(S, { type: "synthetic" })`), finds the newest record with
`metadata.childID === childSessionId`, and runs steps 1–2 (step 2's interrupt only if the execution started
after that record). No-op (`relayed:false, reason:"live"`) when `S` is not retired. Idempotent through the
deterministic id. `index.mjs` passes it into the delegate engine's deps as `deps.relayBackgroundResult`.

The relayed record renders as today's background-result card in `L` (same `metadata.childID`/`state`).

## C. Viewer windows (`@manta-owner=view`)

- `sessions:materialize` stamps a NEW holder `@manta-owner=view` (was `user`). An existing window it answers
  keeps its stamp. `tmux.mjs` accepts `"view"` in `stampOwner` / `resolveOwner`; anywhere that treats a
  non-`job` owner as "the user's" keeps doing so for `view` EXCEPT the close rule below.
- **Promotion:** when a client sends a message into session `X` (`opencode:prompt`, `opencode:run-command` —
  the user's own sends through `/rpc`), every window stamped with `X` whose owner is `view` is restamped
  `user` BEFORE the send is forwarded (await it; a stamp failure is logged and does not block the send).
- **Close rule:** a `view` window is closed by the box when its session is *finished*: not running, no pending
  question / permission, not the child of a live job record (`running`/`paused`/pending delivery / uncertain),
  and it has been in that state ≥ `LINGER_MS`. Driven by the session tree: when a linger expires and on each
  tree recompute, collect `view` windows meeting the rule and call an injected `closeViewWindow({ project,
  windowIndex, sessionId })`, which re-reads the window under the session's resource lock and kills it only if
  it is STILL stamped `view` with the same session id and the session is still not running. The worktree rule
  is unchanged (a `view` window never sits on a job worktree; materialize answers the job window there).
  Boot: the same evaluation runs on the first hydrated tree, so a view window whose session finished while the
  server was down is closed after one linger.
- Existing `user` windows are not migrated (the box cannot tell opened-to-watch from typed-in).

## D. Settling opencode-owned background runs

In `settleV2Job`, for `completionOwner:"opencode"`:
- **Born for this run:** when the child's `session.time.created >= job.runStartedAt - BORN_SLACK_MS`
  (`BORN_SLACK_MS = 60_000`), the run started at the child's creation: freshness compares `idleAt` against
  `min(job.runStartedAt, session.time.created)`. Otherwise unchanged. (An older resumed session keeps the
  current rule, so a previous run's outcome still cannot finish a new record.)
- **Real error text:** when the terminal status is `failed` and the error is generic (no `hint.error`), read the
  parent's (`job.sessionParentID ?? job.parentSessionID`) synthetic records (`listRawTimeline(parent,
  { type: "synthetic" })`) for the newest one with `metadata.childID === job.childSessionID`, created at/after
  the effective run start, and use its peeled body (the existing `backgroundResultText` peeler in
  `src/shared/opencodeV2.mjs`; export it if needed) trimmed to 500 chars as the record's `error`. Unreadable ⇒
  keep the generic text. Same lookup for `done`: if the record has no `result`, use the body (trimmed 2 000) as
  `result`.
- **Relay backstop:** after an opencode-owned record settles, if `deps.relayBackgroundResult` exists and the
  child's opencode parent is retired (`deps.successorOf?.(parent)`), call
  `relayBackgroundResult({ sessionId: parent, childSessionId })` (fire-and-forget with a `.catch` log — this is
  a background reconcile, not a user action).

## E. Job-record retention

`applyRetention`: superseded records (`supersededBy` set) do NOT count toward `MAX_TERMINAL_JOBS`. Per
`childSessionID`, keep at most the 5 newest superseded terminal records (by `finishedAt`); older ones are
pruned (unless `keeps()`). The 7-day cutoff is unchanged for all.

## F. `sessions:close` input

Missing `project` or a non-integer `windowIndex` ⇒ `{ ok:false, reason:"invalid", message:"No window was
named." }` (class-1 copy). A named window that no longer exists stays the current idempotent success.

## Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Deterministic message id | `node:crypto` sha256 | uuid v5 (`uuid`, 100M+/wk) — would add a dep for one hash; opencode ids are `msg_` + opaque, any stable hex works |
| Bounded concurrent reads in the repair | inline 4-slot loop | `p-limit` (ESM, 150M+/wk) — the repo already hand-rolls bounded loops in `dbOffload`; a one-off 10-line loop at boot doesn't justify a dep |
| Everything else | existing in-repo engines (handoff, delegate, sessionStatus, tmux) | Pure behaviour changes to Manta's own state machines; no library covers opencode session graphs |

## Ownership (parallel implementers)

- **Worker H (handoff side):** A, B — `src/server/handoff/**`, the raw-event wiring and the
  `relayBackgroundResult` / `successorOf` deps in `src/server/index.mjs`, the new fixture. Must not touch
  `delegate.mjs`, `sessionStatus.mjs`, `sessionMaterialize.mjs`, `tmux.mjs`, `rpc.mjs`.
- **Worker D (delegate/session side):** C, D, E, F — `src/server/delegate.mjs`, `sessionStatus.mjs`,
  `sessionMaterialize.mjs`, `sessionClose.mjs`, `tmux.mjs`, `rpc.mjs`, and the `closeViewWindow` wiring in
  `index.mjs` (a separate, small block). Consumes `deps.relayBackgroundResult` / `deps.successorOf` only if
  present.

## Tests

- handoff: `isTaskChild` truth table; `maybeAuto` skips a task child; agent `create` refuses with
  `HandoffError("subagent")`; user trigger still allowed; repair cuts only original-task-child links, skips
  Manta-made successors and manta-job children, is idempotent, sets the marker only on full success; relay:
  deterministic id, admits to the live end, cancels a pending inbox item, interrupts only an execution started
  after delivery, no-op on a live session.
- delegate: born-for-run freshness (the 16:12 case: created 339 553, idle 339 764, runStartedAt 340 261 →
  `failed` with the synthetic's error, not "cut off"); a resumed old session keeps the strict rule; error/result
  from the parent synthetic; retention excludes superseded from the cap and keeps 5 per child; relay backstop
  called once for a retired parent.
- session: materialize stamps `view`; prompt promotes `view` → `user`; close rule (not running, no ask, no live
  job, linger elapsed) closes; a promoted or re-stamped window is never closed; boot evaluation.
- `sessions:close` invalid input.

## Appendix — observed V2 event for a synthetic arrival

(Worker H fills this in from the sandbox run.)
