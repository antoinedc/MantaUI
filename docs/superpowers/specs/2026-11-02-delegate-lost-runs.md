# Background jobs cut off by an opencode restart ("lost runs")

Status: agreed 2026-11-02. Scope: `src/server/delegate.mjs` only.

## Problem

Background-job records stay `running` forever when opencode (V2) stops mid-turn
(a restart, a crash, the OOM killer). The sidebar then shows the job row as
running, its parent as busy ("background work"), and the parent's transcript
keeps a running job card — for days.

Evidence (live box, 2026-11-02): four records stuck 20–64 h; each child
session's last `time.updated` is within seconds of an `opencode-serve` restart
(Oct 30 19:28, Oct 31 21:37, Nov 1 10:35, Nov 1 17:30). None of the children
were in `GET /api/session/active`. Two had no `outcome`/`time.idle` at all; two
still carried the PREVIOUS turn's outcome, with `time.idle` older than the
job's `runStartedAt`.

Why: V2 records no outcome for a turn killed by a restart and does not resume
it — the session just leaves the active set (its Session.Info outcome/idle lag
by design, `docs/opencode-v2/spikes/round1-b.md` §B3). `settleV2Job` finishes a
job only on a FRESH outcome, so it answers `no-outcome` forever. Jobs opencode
owns (`completionOwner:"opencode"`: adopted subagents, observed sessions,
native commands) are also exempt from the 30-minute running timeout, so nothing
ever ends them; Manta-owned jobs end only at that timeout, labelled "timed out".

Not the cause (measured): the live finish path. opencode writes
`outcome`/`time.idle` 9–52 ms BEFORE emitting `session.execution.succeeded`, so
the settle on the live event reads fresh data. The per-session running
indicator (stream interpreter / session status) is already correct.

## Rule

`settleV2Job` treats a run as **lost** when, on an authoritative read, the child
is NOT active and has no fresh outcome (today's `no-outcome` answer), AND:

1. it was seen that way on ≥ 2 consecutive checks spanning ≥ `LOST_RUN_GRACE_MS`
   (90 s) — the existing 60 s sweep and the reconnect reconcile supply the
   checks, so a dead run ends ~1.5–2 min after opencode stops;
2. the child's `time.updated` has not advanced since the first such check
   (an advance resets the record);
3. no descendant of the child is active;
4. the child has no pending permission or question (when readable).

The absence record is in memory (per job id, bounded, cleared when the job
ends or the child is seen active). A manta-server restart only restarts the
grace. Any read that fails or is inconclusive leaves the record unchanged.

Never applied to: launches not yet confirmed (`creating`/`submitting`/
`uncertain`, or a Manta-owned job with no `submittedAt`), a job with a handoff
pending (`deferSettlement`), or a job that is not `running`.

Outcome, through `finishV2Job` (so result delivery, `onJobTerminal`, progress
clearing and window/worktree cleanup are unchanged): `stopRequested` →
`stopped`; Manta-owned with `pauseRequested` → `paused`; otherwise `failed` with
the error "the run was cut off — opencode stopped before it finished". A
Manta-owned job still posts exactly one result to its parent.

The 30-minute running timeout stays as the backstop for a run that is
genuinely active but hung. Records already stuck on a box clear through this
same rule after deploy; no migration.

## Tests (injected fakes)

a. opencode-owned, absent, no outcome → first check leaves it running; a check
   past the grace → `failed` with the message.
b. same with a stale previous outcome (`idle < runStartedAt`).
c. child active between checks → reset, not settled.
d. `time.updated` advances → reset.
e. Manta-owned submitted job lost → `failed`, exactly one result to the parent.
f. `stopRequested` → `stopped`; Manta-owned `pauseRequested` → `paused`.
g. uncertain / unsent launch → never settled by this rule.
h. handoff pending → deferred.
i. pending permission/question, or an active descendant → not settled.
j. a read that throws → unchanged.

## Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Decide a run is dead | ~15 lines in `settleV2Job` | No library models opencode's session lifecycle; the decision needs this codebase's own authoritative reads (active set, Session.Info, job record). |
| Absence bookkeeping | in-memory `Map` | A durable store (the jobs file) would add a write per sweep for every running job; losing the record on restart only restarts a 90 s grace. |
| Scheduling the re-check | the existing 60 s delegate sweep + reconnect reconcile | A new poller or timer library would duplicate the sweep that already re-reads every running job. |
