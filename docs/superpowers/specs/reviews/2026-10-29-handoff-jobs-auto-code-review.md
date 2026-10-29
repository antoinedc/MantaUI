# Code review — handoff-jobs-auto (`feat/handoff-jobs-auto` @ 2cee5804)

Reviewer: Opus 5.5 (read-only). Spec: `docs/superpowers/specs/2026-10-29-handoff-jobs-auto.md` (binding).
Read in full: `handoff/engine.mjs` (resolver, create, processRequested, maybeAuto, startRecord/runStart/stepCreate/commit,
abortToReady/rollback, recovery), `handoff/policy.mjs`, `handoff/wiring.mjs`, the `delegate.mjs` hunks plus `withRunningJob`,
`stopJob`, `pauseJob`, `sweepDelegateJobs`, `settleV2Job`, `finishV2Cleanup`, `loadJobs`, the plugin tool, and every changed test.

## Spec conformance (Decision points)

| # | Decision | Status |
|---|---|---|
| 1 | `resolveMode` own → job → box; no lookup with an own mode; `modeFor`/`list()` derived | ✅ (`engine.mjs:432-443`, `list` 1362-1369) |
| 2 | `entryPlan({…, unattended})`, `create` passes `source === "job"` | ✅ (`policy.mjs:47`, `engine.mjs:602-603`) |
| 3 | Successor inherits only when `source !== "job"` | ✅ (`engine.mjs:1184-1192`; inheritance runs before the re-point, so `pred` still resolves as the job) |
| 4 | Failed turn in a job → cancelled, no generation, settler told | ✅ for planned records (see deviation 1) |
| 5 | Stop/pause cancel pending sends; start re-check before create | ⚠ re-check ✅; cancellation has a gap that breaks the stated invariant — **finding 1** |
| 6 | Sweeper skips a job with a pending send | ✅ (`delegate.mjs:1885`; engine deps carry `deferSettlement` into `startSweeper`) |
| 7 | `maybeAuto` returns early for `source === "job"` before measuring | ✅ (`engine.mjs:682-684`) |
| 8 | `/handoff`/button stay cards; dismissed refuses; adopted unchanged | ✅ |
| — | `runningJobOwner` + `isRunningJobSession` derived; `isJobSession` set unchanged | ✅ (`delegate.mjs:2574-2579, 4863-4866`) — same "any running record on that session" set as before |
| — | Plugin status line from `kind`; description sentence | ✅ |

## Findings

### 1. BLOCKING — a stop/pause that lands while the successor is being created (or in the ready→starting gap) still moves the job onto a successor

- **Where:** `src/server/handoff/engine.mjs` `cancelPendingSends` (979-998) and `runStart` (1016-1020).
- **Problem:** `cancelPendingSends` flags a `starting` record only when `!r.internal.created`, and `runStart` checks the flag
  exactly once — before `stepCreate`. `stepCreate` is two or three opencode round-trips. A stop that arrives while it is in
  flight sees `created === false`, sets `internal.cancelled`, and returns; nothing ever reads the flag again. The start then
  prepares the continuation, POSTs the handoff prompt to the successor (`deliverSend`) and commits: it re-points the now
  **stopped** job record to the successor, stores the box default as the successor's mode (`resolveMode(pred)` is no longer
  `job`), while `stopJob` has already run `finishV2Cleanup` (window killed, clean worktree removed). Result: an agent
  session working on a stopped job that no record tracks as running, possibly in a deleted directory. The job-rule re-check
  (`mustCancelStart`) is the same TOCTOU: it can read `running` just before the stop's store write lands.
  The same gap exists one step earlier: between `produceText` setting `ready` (and awaiting `persist()`) and `startRecord`
  claiming it, the record is `ready` with a send plan, which `cancelPendingSends` skips. For a stop the re-check usually
  catches it; for a **pause** it never does (the job stays `running` until its next tool boundary), so a paused job is moved.
  Spec Decision 5 says "A stopped/paused job is never moved onto a fresh successor." This is deviation (2); I don't accept
  it, because the code to close it already exists (`rollback` deletes an uncommitted successor) and the point of no return
  is later than creation.
- **Fix:**
  1. In `cancelPendingSends`, flag any `starting` record that has not passed the point of no return: replace
     `!r.internal.created && !pointOfNoReturn(r)` with `!pointOfNoReturn(r)`. Also flag a `ready` record whose
     `internal.plan?.disposition === "send"` (a planned start about to be claimed): set `r.internal.cancelled = true`.
  2. In `runStart`, check the flag again **after** `stepCreate` and before step 3 (also covers recovery, where
     `j.created` is already true):
     `if (j.cancelled && !pointOfNoReturn(rec)) return await cancelCreatedStart(rec);` where `cancelCreatedStart` is
     `rollback` (it deletes the successor, clears the continuation, the fence and the op, tells the settler, drains held)
     but ending in `state: "cancelled"` with the stop/pause reason instead of `failed`. Fold `cancelStart` into it
     (successor delete is a no-op when none was created).
  3. In `startRecord`, refuse a record with `internal.cancelled` before the check-and-set (cancel it and return), so the
     ready-window case never takes the fence.
- **Tests (engine.jobs):** (a) `hooks.step` on `"create"` calls `cancelPendingSends("ses_p")` → record `cancelled`, the
  successor deleted (`w.deleted` contains it), no message accepted by the successor, no re-point, fence/op released,
  `hasPendingSend` false; (b) cancel while the record is `ready` with a plan (park `persist`/`gather.facts` after
  `produceText`, or call `cancelPendingSends` from a `facts` hook that resolves after `ready`) with the job still `running`
  (pause case) → no successor; (c) recovery: a persisted `starting` record with `internal.cancelled` and `created: true`
  → `recover()` cancels and deletes the successor.

### 2. SHOULD — the failed-turn rule and the commit inheritance re-ask the store instead of using what the record was planned under

- **Where:** `engine.mjs` `processRequested` 656-667; `commit` 1187-1189.
- **Problem:** `create` already records `plan.job = true` when the plan came from the job rule, but the failed-turn branch
  and the successor inheritance call `resolveMode` again. Two practical consequences: (a) a pause interrupt can park the job
  (status `paused`) before the handoff's turn-end handler runs; a record created after the pause request then resolves as
  `box` and turns into a card plus a full-history generation on a paused job, which is the outcome Decision 4 exists to
  avoid; (b) if the lookup reads nothing at commit (a store re-read that returns `[]`), the successor gets the box default
  **stored**, and the rest of that job chain falls back to cards for good. `loadJobs` swallows read errors into `[]`, so
  "failed lookup" in practice looks like "not a job", not an exception.
- **Fix:** in the failed branch use `planned.job || (await resolveMode(sid)).source === "job"`; in `commit` skip
  inheritance when `rec.internal.plan?.job` (keep the `resolveMode` path for records without the flag).
- **Test:** failed turn where `runningJobOwner` now answers `null` but the record was planned under the job rule → still
  cancelled, no generation; commit where the lookup answers `null` for a `plan.job` record → no stored successor mode.

### 3. NIT — boot recovery cancels a running job's queued handoff

`recover()` replays every `requested` record as a failed turn (`processRequested(rec, false)`), so after any manta-server
restart (self-update), a job whose agent was just told "Handoff queued — end your turn now" has its record cancelled. Its
turn then ends with nothing pending and the job settles with a full context. No regression (it was a card before), but for
a job whose turn is still running in opencode, leaving the record `requested` for the real turn end would keep the work
going. Follow-up, not this PR.

### 4. NIT — deviation (4): a job with an explicit own `auto` still makes unseen cards on an agent `suggest`

Spec-conformant (`unattended: source === "job"`), and the existing `mode === "auto" && isJobSession` skip still covers the
armed trigger for it, so (4) is right as written. But own-`auto` and the stored modes that successors of job chains
inherited before this release (`source: "own"`, often the box `suggest`) keep today's broken behaviour. Worth a follow-up:
derive `unattended` from the job lookup whatever the mode source, at the cost of one lookup per agent call.

### 5. NIT — the job lookup is now on hot paths

`resolveMode` reads and parses the whole delegate store (`readJsonSync`, ~290 KB on this box) for every session without an
own mode on every `GET /api/handoff`, every optimizer policy request (one per model request), and every turn end.
It is synchronous I/O on the server's event loop. A small in-process index of running `childSessionID → owner` kept
current by the delegate engine's writes would remove it; not required for correctness.

### 6. NIT — the tool description contradicts itself for jobs

`handoff.ts:41-44`: "…or the turn fails, it becomes a card for the user instead" is followed by the job sentence; in a job
a failed turn cancels. Suggest "…(in a background job a failed turn cancels it)".

### 7. NIT — stop on an adopted (opencode-owned) session now cancels its pending send

`stopJob` calls `cancelPendingHandoff` for any running/paused record, so an adopted session in box-`auto` with a queued
agent handoff loses it on stop instead of getting a card. Covered by the wording of Decision 5 ("stopping a job") and
arguably better; noting it because the brief asked for no adopted-session regression. Also, the cancel runs before
`withRunningJob` confirms the stop, so a stop that then refuses (the record changed under it) has still cancelled the
handoff — harmless in practice.

## Implementer deviations / doubts

1. **Failed-turn cancel scoped to planned send records** — accept. In a job every agent entry is planned; an unplanned
   record there is a user-made `/handoff`/button card, which must stay a card.
2. **A stop during successor creation is too late** — reject; see finding 1 (the point of no return is the first send
   attempt / commit, and `rollback` already undoes a created successor).
3. **A failed job lookup at the start re-check cancels** — accept: consistent with "failed lookup = null" and the
   invariant. Note `loadJobs` swallows errors, so this branch is mostly unreachable.
4. **Own-`auto` job gets neither the job-rule re-check nor the job-rule armed-trigger skip** — accept as spec-conformant;
   the existing `isJobSession` skip still applies to it. See finding 4 for the follow-up.

## Tests

Good coverage of the resolver (incl. "no lookup with own mode"), entry plan, end-to-end two-link chain with no stored
successor mode, adopted card, failed turn (no generation, settler told), cancel during requested/generating/fence, the
finished-job re-check, the sweeper with and without a pending send, stop ordering (cancel before abort), refused pause,
and the plugin status line by `kind`. The changed trigger test matches the spec. Missing: the cases in findings 1 and 2.
Sandboxing: delegate tests use the in-memory `store()` with injected `load/save`; the stop/sweeper tests stub `publish`,
`abortSession`, `postSynthetic`, have no `killWindow`/worktree, and run under `testSandbox.mjs` — no live `~/.manta` writes.

## Check results (snapshot of 2cee5804 outside the worktree)

- `npm run typecheck` — pass (tsc ×3 + eslint, exit 0).
- `node --import ./scripts/testSandbox.mjs --test src/server/handoff/*.test.mjs src/server/delegate*.test.mjs` — 577/577 pass.
- `node --test scripts/opencode-v2/handoff.test.mjs` — 27/27 pass.

Counts: 1 BLOCKING, 1 SHOULD, 5 NIT.

VERDICT: CHANGES REQUIRED

## Round 2 — `40790c27`

Read: the full fix diff, `engine.mjs` (resolveMode, create, processRequested, maybeAuto, startRecord, abortToReady,
rollback, mustCancelStart/cancelStart, cancelPendingSends, runStart, stepCreate, deliverSend, commit, resumeStart, recover),
`delegate.mjs` (saveJobs, stopJob, pauseJob, cancelPendingHandoffOf, the owner index + runningJobOwner, repointJobSessions,
finishV2Cleanup, the active-session reconciler's skip rules, the engine export), the production wiring (no `load`
injected, so the cached index is the live path), the spec diff and every new test.

### Round-1 items

| # | Item | Status |
|---|---|---|
| 1 | BLOCKING — stop/pause during creation / ready→starting gap still moved the job | **Resolved** for every window before the first message: a `ready` planned send is flagged and refused by the automatic start (`startRecord` 836-844, before the fence); a `starting` record is flagged until the point of no return; `runStart` checks before create, after create (also on recovery, `created: true`), and before the send; `deliverSend` checks the flag in the same synchronous block that sets `attempted` (1117-1118, no await between), and `cancelPendingSends` reads `pointOfNoReturn` and sets the flag in one synchronous loop — so the two sides are mutually exclusive on the event loop and both values reach disk in the same state object. `cancelStart` = `rollback(…, {cancelled: true})`: successor deleted, continuation/fence/op cleared, record `cancelled`, settler told, held drained, no re-point. Tests cover create-hook stop, ready-window stop (stop and pause), recovery with a persisted flag. The window **after** the first message is new finding N1. |
| 2 | SHOULD — re-asking the store | **Resolved**: failed turn uses `planned.job`; commit skips inheritance on `plan.modeFromJob`. Both tests present. |
| 3 | NIT — recovery cancels a queued job handoff | Deferred, documented in the spec's follow-ups. OK. |
| 4 | NIT — own `auto` on a job | **Resolved**: `unattended` comes from the lookup for own `auto` too; own `suggest`/`off` never looked up (tested, incl. a pre-release chain). |
| 5 | NIT — hot-path store reads | **Resolved**: index keyed on `mtimeNs:size:ino`; every in-process `saveJobs` drops it (it is the only writer of the store); an out-of-process atomic rename changes the inode; ENOENT = empty, unreadable/torn read = `null` and not cached. Production engine injects no `load`, so the cache is the live path. |
| 6 | NIT — tool description | **Resolved** (+ test). |
| 7 | NIT — stop on an adopted session | **Resolved**: `cancelPendingHandoffOf` acts only for `completionOwnerOf(job) === "manta"`. The cancel-before-confirm ordering remains (see doubts) — harmless. |

### New findings

#### N1. BLOCKING — a stop that lands after the first message was sent leaves the successor's turn running on a stopped job

- **Where:** `engine.mjs` `cancelPendingSends` (995: a `starting` record past `pointOfNoReturn` is skipped) and `runStart`
  after `commit` (1058); spec Decision 5 last sentences + the new follow-up bullet.
- **Problem:** the window is send-attempt → end of commit: one POST plus attach/link/ownership normally, but **unbounded
  when the first POST is uncertain** (`deliverSend` → `pending` → `scheduleRetry`, the record stays `starting` past the
  point of no return for as long as reconciliation takes). A stop in that window: `cancelPendingSends` does nothing;
  `stopJob` aborts the (idle) predecessor, writes `stopped`, delivers the "stopped" result, and `finishV2Cleanup` kills the
  window and removes a clean worktree. The start then commits: `attachWindow` finds no window (link only),
  `repointJobSessions` moves the **stopped** record onto the successor (it ignores status). The successor's turn — the
  whole handed-off task — keeps running with no running record, no window, its cwd possibly deleted (or, if the worktree
  was dirty and kept, still committing to the branch). The active-session reconciler skips nothing for it (the only record
  is terminal, no window, not a successor any more), so ~2 ticks later it reappears as a *new adopted row*. Net effect: the
  user (or `work_cancel`) pressed Stop and the agent carried on. Same class as round-1 finding 1 — a stop that doesn't
  stop — and the window is no smaller than the creation window was. The same post-commit check also closes the residual
  TOCTOU where a handoff record is created *after* the stop's `cancelPendingSends` ran (agent calls the tool between the
  stop's cancel and its abort, the turn ends successfully) and so carries no flag, leaving only the store re-checks.
  Pause is NOT affected in practice: the re-point carries `pauseRequested` to the successor and the pause interrupt fires at
  its next tool boundary — but the fix below handles it uniformly anyway.
- **Fix (cheap, ~15 lines):** the start can't be undone, but the successor's turn can be ended.
  1. Wiring: expose `oc.interrupt: (sid) => oc.abortSession(sid)` (the same V2 `…/interrupt?resume=false` the delegate stop
     uses).
  2. `cancelPendingSends`: for a `starting` record that **is** past the point of no return and not `committed`, set
     `r.internal.stopAfterCommit = true` (persisted, so recovery honours it).
  3. `runStart`, right after `await commit(rec)` (before `drainHeld`): if `j.stopAfterCommit ||
     (j.plan?.job && (await runningJobOwner(succ)) !== "manta")` → `await oc.interrupt(succ)` (best-effort, warn on error;
     treat a thrown lookup as "not running"). The job record stays re-pointed to the successor and stays `stopped` (its
     history is the successor's now); for a parked pause the re-pointed `paused` record resumes onto the successor's
     worktree as usual; for a pause still `running` with `pauseRequested`, the interrupt produces the interrupted outcome
     that parks it. `commit`'s `repointJobSessions` writes via `saveJobs`, so the cached index is fresh for the check.
  4. Update Decision 5 / the follow-up bullet: "after the first message the handoff commits, and if the job was stopped or
     paused meanwhile the successor's turn is interrupted."
- **Tests (engine.jobs):** (a) `hooks.step("send")` calls `cancelPendingSends("ses_p")` and drops the job → record
  `committed`, job re-pointed, `oc.interrupt` called once with the successor; (b) same with the first POST `pending`
  (uncertain) and the stop landing before the retry confirms → interrupt after the eventual commit; (c) recovery with a
  persisted `stopAfterCommit` and `commit` partly done → interrupt after recovery commits; (d) control: no stop → no
  interrupt; (e) delegate: `stopJob` on a record whose handoff is past send → job ends `stopped` on the successor
  (existing stop ordering test extended).

#### N2. NIT — "an explicit user press clears the flag" doesn't make the press work on a stopped/parked job

`startRecord` clears `internal.cancelled` for `origin: "user"`, but `plan.job` stays, so `mustCancelStart`'s store re-check
still cancels the press when the job is no longer running (the record ends `cancelled`, "the job was stopped, paused or
finished"). The new test only covers a job that is still running. I think refusing is the right behaviour (it keeps
Decision 5's invariant, and the reason is shown), but the spec/test wording promises more. Fix: say so in the spec and add
the stopped-job case to the test (or, if the press should win, drop `plan.job` on a user press — then the stopped record
gets re-pointed to an attended successor, which is defensible but should be a decision). Also the clear happens before the
`no_window` throw, so a failed press un-flags the record — harmless (see doubt 2).

#### N3. NIT — a flagged start that fails its fence goes back to `ready`, not `cancelled`

A stop flags a `starting` record, then step 1 (`tryFence` → "you kept working" / not idle) runs `abortToReady` before any
flag check: the record becomes an ordinary `ready` card (still flagged) on a stopped job's session. No harm (nobody
restarts it automatically, `hasPendingSend` no longer counts it), but `abortToReady` could end a flagged record as
`cancelled` for a cleaner outcome.

#### N4. NIT — `cancelStart` before create can leak an empty successor after a crash

`deleteSuccessor: Boolean(rec.internal.created)` — a crash between `createSession` succeeding and the `created: true`
persist leaves `created: false` on recovery; a flagged record then cancels without deleting the (empty, never prompted)
session. `rollback` already tolerates a 404, so pass `deleteSuccessor: true` unconditionally (the id is pre-minted).

### Implementer doubts / deviations

1. **Stop after the first message** — not acceptable as documented: N1. The right fix is exactly the one suggested in the
   brief — keep the commit (the successor has the work), interrupt the successor's turn when the job was stopped/paused by
   commit time, leave the job record on the successor — and it is cheap (an `oc.interrupt` in the wiring, one persisted
   flag, one post-commit check).
2. **A flagged ready record that degraded to a card stays flagged; an automatic re-start would be refused** — accept.
   The only automatic `startRecord` is `processRequested`, once, right after `produceText`; `maybeAuto` makes new records
   and cancels old automatic ready cards, it never restarts one. So no automatic re-start of that card exists to refuse.
3. **`resolveMode` returns `unattended`** — accept (spec updated, the one deep-equal test updated, `list()` reads only
   `mode`/`isDefault`). **`pauseJob` cancels before its flag** — accept: `cancelPendingHandoffOf` already filters on
   `running` + manta-owned, so a refused pause that has cancelled is only the race where the record changed between the
   peek and the lock (or a manta-owned `command` job, which has no agent turn to hand off). Harmless.

### Checks (snapshot of `40790c27` outside the worktree)

- `npm run typecheck` — pass (tsc ×3 + eslint, exit 0).
- `node --import ./scripts/testSandbox.mjs --test src/server/handoff/*.test.mjs src/server/delegate*.test.mjs` — 596/596 pass.
- `node --test scripts/opencode-v2/handoff.test.mjs` — 27/27 pass.

Counts (round 2): 1 BLOCKING, 0 SHOULD, 3 NIT. Round-1: 1 BLOCKING resolved (pre-send windows), 1 SHOULD resolved, NITs 4-7 resolved, NIT 3 deferred (documented).

VERDICT: CHANGES REQUIRED

## Round 3 — `9089dfd3`

Read: the full fix diff (engine `abortToReady`, `rollback`, `cancelStart`, `cancelPendingSends`, new
`interruptIfJobStopped`, `commit`), the production wiring (`interrupt` → `oc.abortSession` → V2
`session.interrupt({resume:false})`), `runningJobOwner` / `readOwnerIndex`, `repointJobSessions`, `pauseJob` /
`cancelPendingHandoffOf`, the reconciler's skip rules (`isHandoffSuccessor` → engine `isSuccessor` = `releasing` or a
`starting` record), the V2 interrupt/inbox spike notes, the spec diff and every new test.

### Round-2 items

| # | Item | Status |
|---|---|---|
| N1 | BLOCKING — stop after the first message leaves the successor running | **Resolved.** `cancelPendingSends` flags a `starting` record past the point of no return `stopAfterCommit` (persisted, same synchronous loop); `commit` runs `interruptIfJobStopped` after attach/link/ownership and before `committed`, guarded by a persisted `stopChecked` so a recovery re-run is idempotent apart from a repeated (harmless, no-op-on-idle) interrupt. The "job no longer runs" check reads the re-pointed record on the successor (the repoint's `saveJobs` drops the cached index first), so it also catches a handoff created after the stop's cancel step. It runs while `succ ∈ releasing`, so the reconciler skips the session and the interrupted turn leaves the active set before it could be adopted. A failing interrupt only warns. Tests: flagged at send (both `how`), "no flag, job gone", uncertain POST + late stop, recovery mid-commit, control (running job / attended), failing interrupt, wiring → `abortSession`, delegate stop-then-repoint stays `stopped`. |
| N2 | NIT — user press on a flagged card | **Resolved** (spec says a press succeeds only while the job runs; test covers the stopped/parked refusal). |
| N3 | NIT — flagged start failing its fence → `ready` | **Resolved**: `abortToReady` → `cancelStart` when flagged; fence, op and successor cleaned up (tested). |
| N4 | NIT — leak after crash between create and persist | **Resolved**: `rollback` always attempts the delete (404 tolerated); `deleteSuccessor` option removed (tested with a recovered `created:false` record whose session exists). |

### New findings

#### S1. SHOULD — "can't tell" now fails toward interrupting a healthy job

`interruptIfJobStopped` treats `runningJobOwner(succ) !== "manta"` as "stopped" (and a throw as stopped). In production
that lookup returns `null` not only for "no running record" but also when the owner index read is **unknown**:
`readOwnerIndex` returns `null` on an unreadable store and on a read that raced a rename ("changed while reading"), and
`?.get(...) ?? null` folds that into "not running". Pre-send (`mustCancelStart`) that direction is safe — cancel a
reversible start. Post-send it is not: a false "stopped" interrupts a **running** job's successor, and the job then
settles the raw `interrupted` outcome as `failed: "interrupted"` (`outcomeToTerminal`) — a healthy unattended job killed
by a store-read race. The window is tiny (a threadpool rename landing between the two `statSync`s around a sync read),
but the store is written often and the consequence is the job's loss, whereas the opposite error (missing a stop) is
visible and recoverable (the run shows up as an adopted row the user can stop). Fix (small): for the post-commit check,
interrupt only on a **positive** signal — `stopAfterCommit`, or a job record for `succ` that exists and is not `running`
(a delegate lookup over the record list, not the running-only index; unknown/unreadable → don't interrupt, warn). Test:
an owner lookup that answers `null` for an unreadable store must not interrupt a running job's successor.

#### S2. SHOULD — the interrupt can land before the successor's first turn exists

The V2 prompt POST enqueues to the session inbox and the execution starts asynchronously
(`session.inbox.enqueued → delivered`); interrupting a session with no active execution answers `{interrupted:false}`
and is a no-op (spike round1-b B1/B2), after which the queued item starts normally. `commit` interrupts tens of ms after
the confirmed POST (tmux lookups, two persists, the store lock), so in practice the turn is almost always active by then,
and on the uncertain/recovery paths confirmation means the message is already in history — but nothing verifies it.
If it misses, the stopped job's handoff runs to completion (adopted as a row after 2 ticks): N1 again, narrowly. Cheap
hardening: after the interrupt, check `oc.listActive()` / the successor's inbox once (or a few times, bounded) and
re-interrupt if the turn appeared or the item is still pending; or prove the ordering against the pinned binary
(a prompt immediately followed by `interrupt{resume:false}` on an idle session) and cite it in the spec.

#### N5. NIT — a pause via the commit interrupt bypasses the tool-boundary rule

`pauseJob` flags the job and parks it at the next completed-tool boundary ("never interrupted mid-write"). A pause that
lands past the handoff's point of no return sets `stopAfterCommit`, so commit interrupts the successor immediately —
possibly mid-tool when the commit is late (uncertain POST, recovery). For a still-`running` job with `pauseRequested`, the
re-point already carries the flag to the successor and the normal boundary interrupt parks it; the commit interrupt is
only needed when the job no longer runs. Folding S1's fix (interrupt on a non-running record) and keeping
`stopAfterCommit` for non-job-plan records would honour the pause contract. Low impact (worktree kept; resume re-seeds
from git state).

#### N6. NIT — `stopAfterCommit` is set and then ignored for a `new-session` record

`cancelPendingSends` flags any `starting` send record past the point of no return, but `interruptIfJobStopped` returns
early unless `how === "clear"`. A branch is a user-made, windowed session and is not re-pointed, so not interrupting is
defensible — say so in the spec (or don't set the flag for branches) so the persisted flag isn't misleading.

### Implementer doubts

1. **Interrupted successor of a stopped job has no window and stays in opencode history** — accept. The stopped job
   record is re-pointed onto it, so the job's history/rail row now resolves to the session that holds the handed-off
   message and the interrupted turn — consistent, nothing orphaned. The held-message follow-up (a message typed during
   the handoff starts a turn on the successor after the interrupt, then gets adopted) is a user-initiated turn and is
   documented; acceptable.
2. **A crash during the interrupt repeats it on recovery** — accept. `stopChecked` is persisted right after; the repeat
   hits either the same turn or an idle session (`{interrupted:false}`); no legitimate new turn can start on the successor
   before `committed` (held messages drain only after commit; a resume creates a fresh child session).

### Checks (snapshot of `9089dfd3` outside the worktree)

- `node --import ./scripts/testSandbox.mjs --test src/server/handoff/*.test.mjs src/server/delegate*.test.mjs` — 606/606 pass.
- (Orchestrator: typecheck, test:server, vitest, build all pass.)

Counts (round 3): 0 BLOCKING, 2 SHOULD, 2 NIT. Round-2: N1 BLOCKING resolved, N2–N4 resolved.

VERDICT: APPROVE
