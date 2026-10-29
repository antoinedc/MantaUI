# Review — `2026-10-29-handoff-jobs-auto.md` (branch `feat/handoff-jobs-auto` @ ad07013a)

The direction is right. An unattended job should never get a card it can't act on, and the plumbing the spec relies on is real: the settler defers on `hasPendingSend`, the commit re-points `childSessionID`, the successor inherits the mode before the re-point, and `create` always returns `kind`. But the predicate the spec names matches more sessions than it intends, and a few consequences of changing `modeFor` aren't stated.

## BLOCKING

**B1. The job check also matches backgrounded `task` subagents, which the spec says are out of scope.**
- **Where:** "Running background job" paragraph; `delegate.mjs` `isRunningJobSession` (≈4835).
- **Problem:** `isRunningJobSession` matches any record in the job store with `status: "running"`. That includes:
  - adopted background `task` subagents (`adoptSubagentJob`, `origin: "subagent"`);
  - adopted existing sessions and native background commands (`adoptExistingSession`).
  All of these have `completionOwner: "opencode"`. So they would also default to `auto` and have an agent `suggest` promoted to a start. The optimizer note would also start reaching them (see S1).

  The outcome is exactly what the spec says it avoids. opencode's parent waits on the original child. That child's last turn is now "ending turn for the handoff". The successor's real result never reaches the parent.
- **Fix:** Define the predicate as a running job record **with `completionOwnerOf(job) === "manta"`**. That covers `delegate` jobs and CTO workers, which are started through `startJob` and therefore owned by Manta. Keep the broader "any running record" check for the existing §6.3 armed-trigger skip. Narrowing that one would let the armed trigger fire on adopted subagents when the box default is `auto`.

  So the delegate engine should expose one lookup that returns `"manta" | "opencode" | null`, or two predicates. Add tests:
  - an opencode-owned running record with box default `suggest` → box default, and agent `suggest` → card;
  - the armed trigger is still skipped for that record.

## SHOULD

**S1. The spec doesn't say that changing `modeFor` changes two more callers.**
- **Where:** Decision §1 and Visible effects.
- **Problem:** `modeFor` also feeds:
  - **`policyFor`**, the optimizer plugin's handoff budget note. That note is gated on `mode ≠ off`. Today, with box default `off`, a job never sees "Context: N of a B budget … call `handoff`". After the change it will. This is the main thing that makes the feature work with box default `off`, so the spec should say so and test it.
  - **The compaction scheduler's `eligible` check** (`index.mjs` ≈1958). A job is now never eligible for background compaction while it runs, even with box default `off`. This is probably fine, but it should be stated.
- **Fix:** Add both to "Visible effects". Add a test: `policyFor` on a running Manta job with box default `off` → `mode: "auto"`.

**S2. Inherited `auto` outlives the job.**
- **Where:** Decision §4 and commit (`engine.mjs` ≈1086).
- **Problem:** The spec says "a job that is no longer running → box default". That holds only for the original session. Every successor gets an explicit `auto` written at commit, because `modeFor(pred)` is evaluated while the predecessor is still a running job. So once the job finishes, its window keeps `auto` forever. The automatic over-budget handoff then applies there if a user later chats in that window (the session is no longer a job), even if the box default is `suggest`. The toggle also shows "auto" without the "default" mark, which contradicts the Visible-effects bullet for every successor.
- **Fix (pick one and state it):**
  - **(a) Recommended:** at commit, store the inherited mode only when the predecessor has its own mode or is not a job. If the predecessor's `auto` came from the job rule, leave the successor without one. After the re-point the job rule resolves it to `auto` anyway. The only gap is the moment between "link written" and "ownership re-pointed", and nothing reaches a turn end inside it.
  - **(b)** Accept it and say so explicitly.

  Then adjust the end-to-end test ("the successor's stored mode is `auto`") to match.

**S3. Stopping or pausing a job during a handoff start doesn't stop the successor.**
- **Where:** New. Relevant code: `startRecord`/`runStart`, `delegate.mjs` `stopJob`/`pauseJob`, and `repointJobSessions`.
- **Problem:** After the agent's turn ends there is a window before commit: fact gathering, plus a regeneration of up to 2×120 s when the body is thin. If the user stops or pauses the job inside that window:
  - `stopJob` aborts the predecessor, which is already idle, and marks the job finished.
  - The start carries on. It mints a successor and sends it the handoff.
  - `repointJobSessions` moves the stopped record onto the successor without checking its status.

  The successor then runs with no job controlling it, and the stop or pause the user asked for is silently undone. This exists today for explicit-auto jobs; this spec makes it the default for every job.
- **Fix:** Before the reversible create step, a start on a session that was a job when the record was created must re-check that the job is still running. If it isn't, cancel the record (or drop it to a card) and clear the pending send. Alternatively, `stopJob`/`pauseJob` cancel the session's pending `send` records. Add a test.

**S4. A failed turn should not make a card for a job.**
- **Where:** Edge cases; `processRequested`.
- **Problem:** On a failed or aborted turn the plan is cleared and `produceText` still runs. With a thin body that means a full-history generation on a nearly full context (up to two calls) to make a card nobody will see. Meanwhile the settler is no longer deferred: `hasPendingSend` went false the moment the plan was cleared, so the job may already be wrapping up.

  Letting the job settle is the right outcome, since the failure is the job's real result.
- **Fix:** State that outcome explicitly. For a job session, cancel the record on a failed turn instead of producing a card.

**S5. The job's running time limit doesn't move with a handoff.**
- **Where:** Problem / Decision §3; `sweepDelegateJobs`.
- **Problem:** A Manta-owned job is failed after `sweepAllowanceMs ?? 30 min` from `startedAt`. A job that fills 60% of its window has usually run a while already. The handoff doesn't extend the limit, so the successor is likely to be timed out (and interrupted) soon after.

  The sweeper also ignores a pending send. A timeout between turn end and commit fails the job and aborts the predecessor while the start mints a successor (the same orphan as S3).
- **Fix:** At minimum, say this in the spec, and have the sweeper skip a job with a pending send, like the settler does. Ideally decide whether a committed handoff extends the allowance. If that's out of scope, record it as a known limit so "the work stops" isn't reported as fixed when it isn't.

**S6. Pin the entry-plan input and the mode resolver's contract.**
- **Where:** Decision §2 and the Tests section.
- **Problem:** `entryPlan` is pure and only receives `mode`. It needs a flag (for example `unattended: true`) for the job + `auto` + agent `suggest` → start rule. `create` needs three facts: the effective mode, whether it came from the job rule, and whether the session is a Manta job.
- **Fix:** Specify one internal resolver, for example `resolveMode(sid) → { mode, isDefault, job: "manta"|"opencode"|null }`, used by `modeFor`/`list`/`create`/`maybeAuto`/commit, plus the new `entryPlan` field.

**S7. The job lookup's cost and failure handling.**
- **Where:** The `modeFor` change.
- **Cost:** `isRunningJobSession` reads the job store from disk synchronously (`loadJobs` → `readJsonSync`). If `modeFor` calls it unconditionally, it runs:
  - on every turn end of every session (`maybeAuto` resolves the mode before its cheap budget check);
  - on every `GET /api/handoff`;
  - on each compaction-scheduler candidate;
  - on each policy fetch (at most once per minute per session).

  That's cheap but avoidable. Don't cache it: a cache goes stale exactly when a job finishes or is re-pointed.
- **Failure handling:** `p.delegate()` is lazy. A throw early in boot, or from a store read, would turn `list`, `create` and the compaction check into errors.
- **Fix:**
  - Look the job up only when the session has no own mode.
  - In `maybeAuto`, a mode that came from the job rule can return immediately: §6.3 skips the trigger anyway, and this avoids the measurement.
  - Treat a lookup failure as "not a job", so it falls back to the box default.

**S8. Tests are close but incomplete.**
- **Existing tests that must change:**
  - `engine.triggers.test.mjs`, "a running background job's own session … suggest still offers a card". Its second half (box default `suggest` + job → ready card) is now wrong. Expected result: no record. The spec says only "existing test keeps passing"; it should name this deliberate change.
  - `scripts/opencode-v2/handoff.test.mjs`. That harness exists, so drop "if the plugin has a test harness". Its "handoff: queued status line" fake response has no `kind`, so under the new rule it would print "ready below". Update it to carry `kind: "auto"`. Add three cases:
    - `action: "suggest"` + `kind: "auto"` → queued line;
    - `action: "handoff"` + `kind: "suggest"` → ready line;
    - a missing `kind` → the ready line, the safe default.
- **New tests to add:**
  - B1: an opencode-owned record keeps the old behaviour.
  - S1: `policyFor` mode for a job; `list()` returns `modeIsDefault: true` for a job with no own mode (the contract line).
  - S2: the inheritance rule actually chosen.
  - S3: stop or pause during the start.
  - S4: a failed turn after a promoted `suggest` → the pending send is cleared, the settler re-runs, and no successor is minted.
  - Second link of a chain: an agent `suggest` from an already re-pointed successor → start.
  - A paused job (`status: "paused"`) → box default.

## NIT

- **N1. Client refresh.** The client caches the mode from `list()`. When a job finishes, its window keeps showing "auto (default)" until the next fetch. This is harmless; one sentence saying the label follows the job's live state on refetch is enough.
- **N2. Tool description.** The description is static and global, so the added sentence should say that inside a background job `suggest` also starts the handoff — "end your turn after either action". Otherwise an agent that calls `suggest` meaning "just propose it" and keeps working gets replaced at the end of its turn.
- **N3. CTO evidence.** CTO evidence (`withJobEvidence`) links only the final `childSessionID`, which is the last successor. Most of a handed-off worker's transcript sits in the predecessors. Out of scope, but worth a follow-up note now that every CTO worker can hand off.
- **N4. Wording.** The task brief refers to `info`; the engine's read is `list()`. The spec's Contract section is correct.

## Checked and fine

- **Order of `followReplacement` and the job lookup.** `create` resolves the id before looking it up. A successor matches after the re-point. The window between link and re-point is covered by the mode inherited first in the commit.
- **CTO workers.** They are `startJob` delegate jobs (`ctoWorkTools` → `startJob`), owned by Manta, and keyed by job id.
- **Dismissed sessions** still refuse agent handoffs, and the budget note already reports `off` for them.
- **`create`'s response always carries `kind`** (`publicRecord`).
- **A promoted `suggest` is a `send`,** so `hasPendingSend` defers the settler from the moment the tool returns.

VERDICT: CHANGES REQUIRED
