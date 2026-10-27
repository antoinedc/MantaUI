# Background-job reconciliation, `delegate_send`, and delegate tool copy

Box server + opencode tool registrars + a small renderer change. Native iOS is
not changed. Revision 2 (after review): no takeover, no follow-up queuing, and
every new run is a NEW job record so runs can never interfere with each other.

## 0. Problem (measured 2026-10-27)

Seven sessions were busy on the box with no sidebar row:

| Session | Why it had no row |
|---|---|
| cantina "P3-B execution engine", "P3-G2 capture and grants"; crypto-otc "Astra recheck" | A delegate job that went `done` (window closed) and was then **re-prompted** — via opencode's HTTP API from a script, or a resumed `task`. A terminal record never comes back. |
| cantina "P3-C evidence and custody" | Driven only through opencode's HTTP API by a project script (`tools/oc-session/send.mjs` + `wait-idle.mjs`). Manta never saw it. |
| cantina "J early"; crypto-otc "A.4", "A.5" | A `task` with `background:true` whose parent session **has no window**. `observeEvent` returns at "could not resolve the owning window" (8 warnings in one morning). |

Plus: adoption is event-only, so work started while manta-server restarts is
never picked up.

A job's sidebar row IS a chat-mode tmux window stamped with the child session
id; `computeJobNesting` nests it under the window of `job.parentSessionID`.
"Visible" = "has a job record + window".

## 1. Shared rules (both implementers code against these)

### 1.1 Record identity: one run = one record
A record is never brought back from a terminal state. A new run of a session
that already has a terminal record gets a **new record** (new id) with:
- `childSessionID` = the same session, `attempt` = previous `attempt ?? 1` + 1,
  `continues: <previous id>`;
- the previous record gets `supersededBy: <new id>` (one locked write together
  with the append of the new record).

Consequences that must hold everywhere:
- All writes are id-scoped already (`patchJob`, `finishV2Job` re-read by id
  under the lock); a late settle / delivery / cleanup of the old record can only
  touch the old record.
- **Window/worktree side effects of a superseded record are suppressed**:
  `closeJobWindow`, `cleanupTerminalJob`, `finishV2Cleanup`, the sweep's
  "close once" loop, `deleteJob` (window + worktree part; it may still delete
  the record) and `dropResumeRestore` do nothing to the window/worktree when the
  record has `supersededBy` set. (The window is stamped with the shared child id,
  so the existing stamp check cannot tell the runs apart.)
- Every lookup by `childSessionID` must not pick a superseded record when a newer
  one exists. Implementer audits all `childSessionID ===` finds in
  `delegate.mjs` / `index.mjs` and lists them in the report.

### 1.2 One accounting predicate
`countsTowardCap(job)` := `job.status === "running" && job.origin !== "observed"`.
Used by `launchRefusal` (cap), `runningJobCount`, and `delegate_send`.
The nesting refusal ("a background job cannot start another background job")
applies only when the caller's session is the child of a running record with
`origin !== "observed"`.

### 1.3 Observed records are track-only
`origin:"observed"` records always have `completionOwner:"opencode"` (Manta
never posts a result for them) and:
- never count toward the cap (1.2);
- are excluded from the sweep's timeout (already true for `opencode` owners)
  and from the "parent session gone → stop" pass (skip `completionOwner
  "opencode"` there);
- settle through the existing `settleV2Job` path, whose `finishV2Cleanup`
  closes the window;
- Pause is refused for them server-side (already true for `opencode` owners);
  the renderer must not show a Pause control for any job whose
  `completionOwner` resolves to `opencode` (check what it does today; fix only
  if it shows one).

### 1.4 Shared adoption helper
New `adoptExistingSession(input, deps)` in `delegate.mjs`, used by the
reconciler (§2), the `task` event path (`observeEvent`) and command candidates
(`adoptCandidate`):

```
input = { childSessionID, owner: {tmuxSession}, displayParentID, sessionParentID,
          cwd, name, prompt, model, origin, supersedes? }
```
Under `jobsLock`: if any record for `childSessionID` is non-terminal → return
`{ok:true, alreadyAdopted:true}`. If `supersedes` is given it must be the id of
the newest terminal record for that session, still without `supersededBy`
(else return alreadyAdopted). Then create the window (reuse a window already
stamped with `childSessionID` if one exists — match by stamp, never by recorded
index) in `owner.tmuxSession` with `cwd`, append the record, set
`supersededBy` on the old one, publish `delegate.updated`. `registerJob` is
refactored to accept an explicit `owner` and must not append outside the lock.
Record extra fields: `engine:"v2"`, `completionOwner:"opencode"`,
`launchState:"running"`, `submittedAt:null`, `completionMessageId:null`,
`completionDelivery:null`, `attempt`, `continues`, `sessionParentID`.
`parentSessionID` = `displayParentID` (the window it nests under; may be a
windowless id, in which case the row renders top-level). `adoptSubagentJob`
keeps its lifecycle-replay behaviour after adopting.

### 1.5 Owner resolution for a session that has no window
`resolveSessionOwner(sid, deps)`:
1. Walk `readSession(x).session.parentID` upward (max depth 8, cycle-safe). The
   first ancestor stamped on a window → `{owner: that window's tmuxSession,
   displayParentID: ancestor}`.
2. Else the tmux project that owns `readSession(sid).session.directory`
   (`resolveForgeOwner` matching: `defaultCwd` equal, or a window
   `paneCurrentPath` equal or a prefix) → `{owner, displayParentID:
   sessionParentID ?? null}`.
3. Else none. Any unreadable `readSession` on the way → `unknown` (caller skips
   this tick, does not warn).
`cwd` for the window is always the session's own `directory`.

## 2. The reconciler

`reconcileActiveSessions()` on the engine, run by
`startActiveSessionReconciler` (15 s, in-flight guard, `timer.unref()`, the
`startPoller` shape) and once at boot **after** `reconcileV2()` resolves. Also
wire it to the existing auto-handoff deferral: skip any sid for which
`deps.deferSettlement?.(sid)` is true.

Per tick:
1. `active = listActiveIds()`; failure → no-op tick. `projects = listProjects()`.
2. Drop debounce entries for sids no longer active.
3. For each `sid ∈ active`, classify in this order:
   a. **Has a non-superseded non-terminal record** (running/paused) → skip.
      (A running job whose window was closed is out of scope: it stays in the
      background cards and can be reopened with Open.)
   b. **Has a record whose launch is in progress in this process**
      (`inLaunch` / `resuming`) → skip.
   c. **Inside a job's tree**: walk `parentID` up (max 8); if any ancestor is
      the `childSessionID` of a non-terminal record → skip (that row already
      represents the work). Unreadable → skip this tick.
   d. **Manta-internal** (§2.1) → skip.
   e. **Foreground `task` child**: if it has a `parentID`, read the parent's
      assistant timeline (`listRawTimeline(parent, {type:"assistant"})`,
      `toolBlockFor`). Block found and not background → skip. Block found and
      background → eligible. No block → eligible only after the debounce below
      reaches 3 ticks. Unreadable → skip this tick.
   f. **Debounce**: eligible sids must be seen busy on 2 consecutive ticks
      (3 when e found no block) before adoption.
   g. Adopt via `adoptExistingSession` with owner from §1.5 (none → skip and
      warn once per sid per process), `origin:"observed"`, `name` =
      session title or "Background session", `prompt:""`, and
      `supersedes` = the newest terminal record for this sid if one exists
      (this is the "re-prompted finished job" case: it becomes a new observed
      run; its old record keeps its delivered result).
   A session that already has a window and no record is a user window → skip
   (step a does not apply; check `sid ∈ windowed && no records` → skip).
   A session with a window AND only terminal records (dirty-worktree window
   kept, or reopened) → proceed to c–g; `adoptExistingSession` reuses the window.

### 2.1 Manta-internal sessions
Inventory every server-side session creator (`grep -rn "createSession(\|session.create\|session\.create" src/server`):
title generation, CTO conversation/role/ephemeral sessions (`ctoBinding.mjs`,
`ctoAct.mjs`, `index.mjs` ~2621), optimizer/compaction/handoff helpers, etc.
Every creator of a session that is NOT meant to be a user-visible window or a
job must pass `metadata: { manta: { internal: true } }` (extend
`createSession` to forward `metadata` if it does not). Exclusion predicate:
`session.metadata?.manta?.internal === true` OR `session.agent ∈ {title,
compaction, summary}` OR the CTO binding owns it (expose a predicate if none
exists). The 2-tick debounce additionally keeps seconds-long helpers out.
List every creator and its handling in the report.

### 2.2 Event path fix
`observeEvent`'s background-`task` branch and `adoptCandidate` call
`resolveSessionOwner` instead of `resolveOwner(projects, parent)`, so a
windowless parent no longer drops the child. The "could not resolve" warning
remains only for owner = none, once per child.

## 3. `delegate_send` — another round for one of YOUR finished jobs

### REST
`POST /api/delegate/:id/send`, body `{ prompt: string, sessionID: string }`.
`sessionID` is the caller's opencode session (box-token authenticated caller,
same trust model as every `/api/delegate` route).

Checks, in order (first failure wins):
- `404 {error:"that background job no longer exists"}`
- `400 {error:"prompt is required"}` (empty/whitespace)
- `403 {error:"that job belongs to another session"}` unless `sessionID` is
  `job.parentSessionID` or in `deps.replacementChain(job.parentSessionID)`.
- `403 {error:"that job is managed by the CTO"}` when `job.correlation` is set.
- `409 {error:"that job has a newer run — use <newId>"}` when `supersededBy`.
- `409 {error:"that job is still working — its result will arrive on its own"}`
  when status `running`; `409 {error:"that job is paused — resume it first"}`
  when `paused`.
- `409 {error:"its result is still being delivered — try again shortly"}` when
  `completionDelivery === "pending"`.
- `409 {error:"that job's session is busy"}` when its child is in
  `listActiveIds()` (someone else is driving it; the reconciler will show it).
- `409 {error:"that job has no session to continue"}` when no `childSessionID`
  or `readSession` says missing.
- `409 CAP_ERROR` when `countsTowardCap` jobs ≥ `MAX_RUNNING_JOBS`.
- `409 {error:"that job's branch <b> no longer exists"}` when the job had a
  worktree that is gone from disk and `git worktree add <worktree> <branch>`
  fails (run from the repo of `job.parentDirectory`).
- `200 {ok:true, job:<new record>}`.

### Behaviour
Under `jobsLock`: re-check the above against the live store, then append a NEW
record (§1.1) copied from the old one EXCEPT these fields, which are set fresh:
`id` (new), `attempt`, `continues`, `prompt` (the follow-up text),
`status:"running"`, `createdAt/startedAt: now`, `finishedAt:null`,
`result:null`, `error:null`, `filesChanged:null`, `activity:null`,
`completionOwner:"manta"`, `completionMessageId:null`,
`completionDelivery:null`, `pauseRequested:false`, `stopRequested:false`,
`pausedAt:null`, `cleanedUp:null`, `launch:null`, `launchState:"submitting"`,
`submittedAt: now`, `tmuxSession/windowIndex` (from the window step).
Inherited: `name`, `model`, `requestedModel`, `parentSessionID` (the caller),
`parentDirectory`, `childSessionID`, `worktree`, `branch`, `baseSha`, `origin`,
`permission`, `sweepAllowanceMs`, `actor`. Old record: `supersededBy`.
Register the new id in `inLaunch` for the duration.

Then, outside the lock:
1. Re-add the worktree if it is missing (see 409 above).
2. Window: reuse a window stamped with the child id; else `newWindow` in
   `job.tmuxSession` if that tmux session exists, else `resolveOwner(caller)`;
   `cwd` = `job.worktree` if set, else the session's own `directory`.
   `stampOwner(..., "job")`.
3. Submit the prompt the way `submitCommand` does for a delegate launch
   (`sendChildPrompt`, same accepted / definite-refusal / unknown
   classification): accepted → `launchState:"running"`; unknown →
   `launchState:"uncertain"` (existing reconcile path decides); definite
   refusal → roll back and return `500 {error:"couldn't send to the job:
   <reason>"}`. The rollback is NEW code, NOT `rollbackDelegateLaunch` /
   `abandonLaunch` (those delete the child session — the continued session must
   never be deleted): delete the new record, clear the old record's
   `supersededBy`, close the window only if step 2 created it, remove the
   worktree only if step 1 re-added it. The same rollback applies to a failure
   in steps 1–2 (with the matching 409/500). `submittedAt` is the value written
   under the lock (before the send), so an idle that predates the send never
   settles the new run.
4. Completion is the existing `settleV2Job`: `submittedAt` makes only an idle
   after this submission count (`fresh`), descendant evidence applies, and
   `finishV2Job` posts exactly ONE result (N7) to the caller.

### Tool (both registrars)
`docs/opencode-tools/delegate.ts` AND `docs/opencode-plugins-v2/manta/tools/delegate.ts`
(the v2 plugin is what is installed) get `delegate_send({ id, prompt })` →
`POST /api/delegate/:id/send` with `sessionID: context.sessionID`. On a 4xx/5xx
the tool returns the server's error text (not a throw), so the model can act.

## 4. Tool + guidance copy (pinned)

### `delegate` description
> Run a piece of work in the background — in its own session, git worktree and
> branch — and get its result back automatically as a later message. This is
> THE way to hand work to another agent on this box: the user sees every job as
> a row in the sidebar and can open or stop it. Use it whenever the work
> doesn't block what you do next and it edits files: implementing a feature or
> fix, a refactor, a test-suite run-and-fix, an investigation that must not
> touch your checkout. Split independent pieces into parallel jobs (up to five
> at once); each one is a full model session, so don't start jobs whose result
> you won't use. Prefer it over driving opencode sessions yourself (scripts
> calling opencode's HTTP API, wait-for-idle scripts, sleep/poll loops, tmux):
> nothing tracks that work — the user can't control it and no result is
> delivered to you. Use the built-in `task` tool instead when you need the
> answer before you can continue (foreground), or for read-only research
> (`background: true`). The job starts with NO knowledge of this conversation:
> put the goal, paths, constraints and what "done" looks like in the prompt.
> When a job of yours has finished and you want another round from the same
> worker (a fix round after review, the next milestone), use `delegate_send`
> with its id — it keeps the job's context, worktree and branch. This call
> returns IMMEDIATELY and you do NOT have the result yet — it arrives on its
> own; do not report or guess it before then, and do not poll. A background job
> cannot start background jobs of its own.

### `delegate_send` description
> Start another round of work in one of YOUR background jobs that has finished —
> a fix round after a review, the next milestone, a follow-up question. The job
> keeps its session, context, worktree and branch, so this is cheaper and
> better than starting a new job for the same work. Only works once the job's
> previous result has reached you (while it is still working, wait for that
> result). The new round's result comes back to you automatically as a later
> message — do not poll. Returns immediately; you do NOT have the result yet.

Return string: `Sent another round to background job "<name>" (id <newId>). You
do NOT have its result yet — it will arrive as a separate message when this
round finishes. Do not report or guess it before then.`
On a server error: `Could not send to background job "<id>": <error>.`

### `delegate_list`
Unchanged args. Each line additionally shows `round <attempt>` when
`attempt > 1`, and lists the NEW id for continued jobs (superseded records are
omitted from the list).

### `docs/opencode-tools/AGENTS.md` — "MantaUI background delegation"
Same three-row table plus two rows: "Another round for a job of yours that has
finished → `delegate_send`" and "Driving another session yourself (opencode
HTTP API, wait-for-idle scripts, tmux) → don't; use `delegate` /
`delegate_send` — that work is untracked and its result never reaches you."
Add `delegate_send` to the tool bullets. Keep the "you do NOT have a result"
paragraph and the cap paragraph (add: sessions Manta only observes don't count).
Replace "do not fan out speculatively" with the §4 wording. Mirror in the repo
`AGENTS.md` "Background delegation" section: tool list + one paragraph on the
reconciler, observed records, and one-run-one-record.

## 5. Renderer

- Job rows/cards with `origin === "observed"` show a secondary label
  "started outside Manta", title "Picked up automatically — this session was
  started by a script or another tool. Manta shows it but doesn't report its
  result to a chat." Nothing renders job `origin` today: add it to the nested
  sidebar job row and the background job card (`BackgroundCards.tsx`); carry
  `origin`, `attempt`, `supersededBy` through the renderer job type if missing.
- Background cards and the sidebar never show a superseded record.
- No Pause control for `completionOwner` `opencode` jobs (§1.3).

## 6. Tests (node:test / vitest, pure + injected I/O)

- one-run-one-record: send creates a new record + `supersededBy`; a late
  `finishV2Job`/`deliverJobResult`/cleanup/`deleteJob` on the old record does not
  touch the new record, its window or worktree.
- reconciler: windowless busy untracked session adopted only on 2nd tick (3rd
  when no task block); debounce dropped when it leaves `active`; non-terminal
  record → skip; `inLaunch` → skip; descendant of a non-terminal job → skip;
  internal (metadata marker, agent title) → skip; foreground task block → skip;
  background task block → adopt; windowless parent → nearest windowed ancestor;
  no windowed ancestor → directory owner; no owner → skip + one warning;
  unreadable reads → skip without warning; `listActiveIds` failure → no-op;
  user window with no record → skip; terminal record busy again → new observed
  record superseding it (window reused when present); `deferSettlement` → skip.
- observed: excluded from cap/nesting/timeout/parent-gone; settles without a
  result post.
- `observeEvent` background task with windowless parent → adopted.
- `delegate_send`: each 403/404/409/400 path; success → new record fields per
  §3 table, prompt submitted, `inLaunch` cleared; definite refusal → full
  rollback; worktree re-added from branch; settle after submission posts one
  N7 to the caller; idle before `submittedAt` does not settle.
- `countsTowardCap` used by launch, `runningJobCount`, send.
- renderer: observed label; superseded records hidden; no Pause for opencode-owned.

## 7. Non-goals

Taking over another session's job; queuing follow-ups into a running job;
reopening a closed window of a running job automatically; a workspace-wide
`delegate_list` scope.

## 8. Deploy notes (not part of the PR)

Server tarball release (`server-v*`); copy the v2 plugin tool
(`docs/opencode-plugins-v2/manta/tools/delegate.ts` →
`~/.config/opencode/plugins/manta/tools/delegate.ts`), refresh the AGENTS.md
blurb in `~/.config/opencode/AGENTS.md`, restart `opencode-serve`.
