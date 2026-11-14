# Background jobs: stay alive while working, and show their progress

Status: revision 2 (after review round 1), 2026-11-14. Scope: background jobs
started with `delegate` (Manta-owned, `completionOwner:"manta"`). Jobs opencode
owns (adopted subagents, native background commands) keep their lifecycle and
get no new limits; they get the progress `view` where the data exists.

Agreed with the user: 15-minute stall window; extension is a parent-agent tool
(no button); iOS ships in the same release.

## 1. Problem

### 1.1 Good work is killed at 30 minutes

Every Manta-owned job is failed "timed out after 30 minutes" by the sweeper
(`RUNNING_TIMEOUT_MS`, `sweepDelegateJobs`), whatever it is doing. The limit came
with the first engine (BET-378) and was copied from the plugin-job sweeper with
no stated reason. It used to be the only defence against dead runs, runaway
agents, real hangs and a stuck job holding one of the 5 slots. Dead runs are now
caught separately in ~2 minutes (lost-run detection, spec 2026-11-02).

Measured on the dev box (`~/.manta/delegate-jobs.json` × opencode's DB):

- 20 of ~230 Manta-launched jobs ended "timed out after 30 minutes" (9%), all in
  the last 6 days.
- 17 of the 20 had written a message within ~2.5 minutes of the kill.
- 3 were inside one long shell command; 0 were hung.
- One session was killed 5 times in a row and re-sent by hand each time.
- opencode-owned subagents (no limit) ran up to 153 minutes and finished
  normally.

### 1.2 The parent can't see how a job is going

- The parent's job card (desktop `BackgroundCards.tsx` `RunCard`) says only
  "Running in background: <name>". On iOS, the jobs sheet
  (`BackgroundJobsSheet.swift`) shows status and a one-line activity guess.
- `progress_report` exists, but 0 of 49 Manta-launched job sessions called it.
- 29 of 49 (59%) kept a todo list (`todo_write`). That is real, measured
  progress, and it isn't shown to the parent.

## 2. Research summary

Liveness:

- **Temporal**: a short heartbeat timeout plus a long start-to-close limit set
  above the longest legitimate run.
- **AWS Step Functions**: `HeartbeatSeconds` < `TimeoutSeconds`.
- **Celery**: a soft limit, so the task can clean up, before the hard one;
  limits are per task.
- **Agent harnesses**: catch loops with repetition detectors and spending
  budgets, not a clock. opencode V2 accepts `doom_loop` but nothing raises it
  (opencode #59339 / PR #61328).

Progress:

- **NN/g**: anything over 10 s needs percent-done or completed/remaining steps.
  Prefer steps when a percentage can't be accurate. Show the current step.
  Users need to re-orient after long waits.
- **Microsoft progress-bar guidelines**: never back up or restart; no 100% before
  done; an ETA only if accurate.
- **MCP progress / LSP WorkDoneProgress**: a title, a short message, an optional
  monotonic number; rate-limited.
- **A2A**: separate states for working, input-required and terminal.
- **User asks** (Codex #10685/#35930, FeedbackBench, Cursor/Devin/Claude Code):
  - current step and elapsed time;
  - a completion figure from a declared checklist, not a model's guess;
  - what it is running now;
  - findings so far;
  - files touched;
  - spend so far.

## 3. Part A — liveness

### A0. Definitions (pinned)

- **Run segment**: the span from a launch to the job's next terminal or paused
  state.
  - A new job, a resume (`attempt`++ on the same record, fresh child) and a
    continuation (`delegate_send`, a new record) each start a new segment.
  - A child handoff (the record's `childSessionID` is repointed to the
    successor) does NOT start a new segment.
- **Segment clock**: wall time since `segmentStartedAt` (= today's `startedAt`,
  which every launch path already resets).
  - Paused time is not in any segment.
  - No time is subtracted for "waiting", because jobs cannot wait on a person
    (see A5).
- **Job sessions**: the record's current `childSessionID` plus every session
  whose opencode `parentID` chain reaches it (its subagents). The engine already
  learns descendants from `session.created` events.

### A1. Liveness signal (pinned collection contract)

The delegate engine already receives every raw opencode event (`observeEvent` /
`observeRaw` in the opencode pump, `index.mjs`). It keeps, in memory, per
running Manta-owned job (keyed by job id + `attempt` + `childSessionID`):

```
live = {
  lastProgressAt: number,          // epoch ms
  tools: Map<callID, { name, target, startedAt, timeoutMs | null, lastOutputAt }>,
  reconstructedAt: number | null   // set when the tool map was rebuilt from opencode after boot/reconnect
}
```

**What advances `lastProgressAt`** — raw events whose session is one of the
job's sessions:

- `session.text.delta`
- `session.reasoning.delta`
- `session.step.ended`
- `session.tool.progress`
- `session.tool.success`
- `session.tool.failed`
- `session.execution.*`
- `session.created` (a new descendant)

Plus a new hook from the stream interpreter: `onShellOutput(sessionId, callID,
bytes)`. It is called each time the shell poll (`streamInterp.mjs`, 250 ms) gets
NEW bytes, BEFORE the 20 000-character display truncation. It also sets that
tool's `lastOutputAt`.

**Not a signal**: polling or reading an unchanged transcript; `progress_report`
calls; todo-list writes. A model calling a reporting tool in a loop must not keep
a dead job alive. Todo writes are tool events and already count once as such.

**Tool tracking**:

- `session.tool.progress` / start registers a tool:
  - `target` (≤ 80 chars): the shell command's first line, or the file path for
    patch/read/edit/write, or empty.
  - `timeoutMs`: the shell input `timeout` when it is a finite number > 0, else
    null (0, missing, invalid → null).
- `session.tool.success` / `.failed` removes it.

**Boot / reconnect**:

- On manta-server boot and on every opencode stream reconnect, each running
  job's `lastProgressAt` is set to now and `reconstructedAt` to null.
- The 60 s sweep then rebuilds the tool map from opencode outside the jobs lock.
  It reads the child's newest assistant message and keeps the parts with a
  running tool state. At most 2 jobs are read concurrently, with a 5 s timeout
  each.
- A failed or timed-out read leaves `reconstructedAt` null and is retried on the
  next sweep.
- **A job with `reconstructedAt === null` is never judged stalled** (fail-open).

### A2. Stall rule (evaluated by the 60 s sweep)

A running, Manta-owned, launch-confirmed job (not `creating`/`uncertain`, not
handoff-deferred, `reconstructedAt` set) is **stalled** when ALL hold:

- `now − lastProgressAt > 15 min`;
- no tracked tool is still within its allowance. A tool's allowance:
  - `timeoutMs` set → alive until `startedAt + timeoutMs + 5 min`;
  - `timeoutMs` null → alive until `lastOutputAt (or startedAt) + 60 min`.

With several tools running, the job is alive if any one of them is. Lost-run
detection runs first and keeps its own outcome.

Outcome:

- `failed`, `endReason:"stalled"`.
- Error with no tool: `stalled — no progress for 15 minutes (last: <headline>)`.
- Error with a tool: `stalled — "<target>" ran with no output for 60 minutes` or
  `stalled — "<target>" ran past its own timeout`.
- The child is interrupted as the current timeout path does.

### A3. Ceiling

- `ceilingMs` per segment.
  - Default 4 h.
  - `delegate.maxDurationMinutes` (integer 10–720) sets it at launch.
  - The CTO's `sweepAllowanceMs`, when present, is the initial `ceilingMs`.
- **Resume**: the segment restarts with the job's base ceiling (launch value);
  extensions from the previous segment are dropped.
- **Continuation**: the new record starts with the base ceiling of the record it
  continues.
- Reached (`segment clock > ceilingMs`) → `failed`, `endReason:"time-limit"`,
  `reached its time limit of <N>` where `<N>` is e.g. "4 hours" or "2 hours 30
  minutes".

### A4. Warning before the ceiling

- **When**: once remaining time ≤ `min(10 min, ceilingMs / 2)`, if
  `ceilingWarnedFor !== ceilingMs` and the job isn't stalled.
- **How**:
  - Under the jobs lock, set `ceilingWarnedFor = ceilingMs` and persist.
  - Then, outside the lock, send a steered prompt (`delivery:"steer"`) with
    message id `msg_ceil_<jobId>_<ceilingMs>` (idempotent at opencode).
  - V2 injects a steered message at the child's next step. A warning landing
    mid-tool is read after that tool ends.
  - A failed send is logged and not retried (best-effort; the ceiling still
    applies).
- **Text**: "Background job notice: about <m> minutes left before this job is
  stopped. Commit your work, record where you got to with progress_report, and
  finish with your summary."
- An extension changes `ceilingMs`, so a later warning is re-armed
  automatically.

### A5. Jobs cannot wait on a person

Jobs run with a catch-all-deny permission ruleset, so a permission is denied,
never asked (`buildPermissionRuleset`). This spec adds `question` to that
ruleset as an explicit trailing deny, so a granted `"*"` can't re-enable it.

A job that needs a decision:

1. calls `progress_report({ state:"blocked", label:"<what it needs>" })`;
2. ends its turn with the question in its final message.

The job ends `done` and its result reaches the parent as today. The result card
and completion text say **"Needs a decision"** when the job's final progress
state was `blocked` (`endedBlocked:true`). The parent answers with
`delegate_send`.

No "waiting on you" state exists for Manta jobs. The read-only guard on job
sessions (`delegateView.assertWritable`) is unchanged.

### A6. Atomic terminal transition (no race with extend)

The sweep picks candidates from a snapshot. Immediately before ending a job for
`stalled` / `time-limit`, the engine re-reads the LIVE record under the jobs lock
and re-checks all of:

- same `id`, `attempt` and `childSessionID`;
- `status === "running"`;
- for time-limit: `ceilingMs` unchanged since the snapshot, and still exceeded;
- for stall: `live.lastProgressAt` unchanged since the snapshot, and the rule
  still holds.

Any mismatch → skip; the next sweep re-evaluates. `delegate_extend` takes the
same lock, so an accepted extension and a time-limit end can't both happen.

### A7. `delegate_extend` (parent tool)

- **Tool**: `delegate_extend({ id, minutes, reason })`.
- **Route**: `POST /api/delegate/:id/extend` with body
  `{ minutes, reason, sessionID }`. `sessionID` is the tool's
  `context.sessionID`; it is never taken from model-written arguments.
- **Checks**, under the jobs lock, against the live record. Each failure is
  refused as `{ ok:false, error }`, which the tool returns verbatim as text:
  - the record exists, is Manta-owned and `running`;
  - the caller is the job's `parentSessionID` or a session in its handoff chain
    (the same chain `listJobs({ sessionIDs })` uses);
  - `minutes` is an integer in 15–480;
  - `reason` is 1–200 chars;
  - the new `ceilingMs` is ≤ 12 h.
- **On success**:
  - `ceilingMs += minutes`;
  - append `extensions: [{ at, minutes, reason }]` (bounded to 20);
  - publish `delegate.updated`;
  - return `{ ok:true, job:{ id, name, ceilingMs, segmentStartedAt } }`.
- **Tool text**:
  `Extended "<name>" by <m> min — it can now run until <HH:MM> (box time).`

### A8. Runaway protection by behaviour (stage 2)

- **Loops**:
  - Add `doom_loop: deny` to the job ruleset.
  - Trial `opencode-doom-loop-detector` on the dev box against recorded job
    transcripts (replay). Adopt only if it never fires on the 208 finished-done
    jobs.
  - Fallback: our own detector (same normalized call + identical output, 6 in a
    row per signature).
  - Outcome: `failed`, `endReason:"loop"`,
    `stopped: repeated the same action (<tool>)`.
- **Spending**: see B1 `usage`, recorded from stage 1.
  - A default budget is proposed by the follow-up routine (§8).
  - Enforcement (stage 2): warn at 80% (steered, same idempotency as A4); stop at
    100% with `endReason:"budget"`, `stopped: spending limit reached`.

### A9. Outcomes and continuity

- Every new outcome is resumable with `delegate_send`.
- The completion text gains a `Reason:` line for `stalled` / `time-limit` /
  `loop` / `budget`, plus the final headline.
- The 5-job cap and lost-run detection are unchanged.

## 4. Part B — standardized progress

### B1. Sources and storage

Progress the parent sees is stored **on the job record** (`job.progress`), not
only per session. It therefore survives handoff (same record), resume (same
record, new child), and the `clearProgress(childSessionID)` that `finishV2Job`
already runs.

Two inputs feed it:

1. **Model reports** — `progress_report` from a job session.
   - `/api/progress` keeps writing the per-session record (the child's own
     working indicator uses it).
   - When the session is a running Manta-owned job's current child, it ALSO
     merges into `job.progress`.
   - Merges are serialized per job (keyed mutex) and per session (the existing
     store gets the same keyed mutex; today's read-modify-write is unlocked).
   - Every accepted report is stored. Only the bus publish is throttled (B4).
2. **Checklist** — the latest `todo_write` input seen on the child's raw tool
   events (`session.tool.success` with tool name `todowrite`/`todo_write`).
   - Parsed with the same rule as `summarizeTranscript` (`peers.mjs`).
   - Kept in `job.progress.checklist`, so a resumed or handed-off child with no
     todo list yet still shows the last known one.

Server-only facts are computed from engine state, never from a fresh transcript
or DB read:

- live tool (A1);
- `usage` (from `session.step.ended` events);
- files changed (B3).

### B2. Computation rules (pinned)

**Checklist steps**:

- Items with status `cancelled` are excluded from both counts.
- `total` = the remaining items; `done` = the items with status `completed`.
- `current` = the first `in_progress` item, else null.

**Reported steps**: `progress_report.step` is the CURRENT 1-based step, so
`done = step − 1` and `total = total`. Usable only when `total` is set.

**Source**:

- `checklist` when it has ≥ 2 items after excluding cancelled;
- else `reported` when usable;
- else no steps.

**Plan revision**:

- `planRevision` increments whenever the chosen source or `total` changes.
- `grewAt` = the time of the last revision where `total` increased, else null.

**Bar** (`bar`, 0..1, server-owned, persisted):

- Within one revision: `bar = max(previous bar, done/total)`.
- On a new revision: `done/total` (it may drop; clients show "plan grew" while
  `now − grewAt < 120 s`).
- Clamped to ≤ 0.95 while not terminal.
- Set to 1 only when the job ends `done`. Failed / stopped / paused keep the
  last value.

**State precedence**: the job lifecycle always wins. Model states only matter
while running:

- `blocked` shows as "Needs a decision" (amber);
- a model `done` or `failed` while still running is ignored for state; its label
  is used as the headline.

**Headline** (plain text, ≤ 120 chars, first line only), first non-empty of:

1. the model label, if reported within the last 30 min (`headlineAt`);
2. the current checklist item;
3. the running tool (`<name>: <target>`);
4. the existing activity line.

**Milestones**:

- `progress_report.milestone` (plain text, ≤ 160 chars, trimmed, empty ignored).
- Appended with `at`; an exact duplicate of the newest is dropped.
- Bounded to 8 (oldest dropped). Stored newest-last.

**Usage**:

- For every `session.step.ended` of a job session, dedupe on
  `(sessionID, messageID, stepIndex)`. The dedupe set is in memory and bounded
  to 2 000 per job.
- `tokens += input + output + reasoning + cache.read + cache.write`.
- `costUsd += cost` when the event carries a finite `cost`.
- `costUsd` stays null until a cost is seen. `costPartial: true` when any step
  lacked a cost after one had one.
- Persisted at most once a minute. After a restart, up to a minute of usage may
  be missed: `usage` is documented as approximate. No DB backfill.
- Scope:
  - resume and handoff accumulate on the same record;
  - a continuation record starts at 0;
  - descendants are included.

### B3. Files changed

- Computed by the 60 s sweep for running Manta-owned jobs with a `worktree` and
  `baseSha`.
  - Outside the jobs lock, at most 2 concurrently, 5 s timeout each.
- Value: the number of UNIQUE paths in
  `git diff --name-only <baseSha>` (working tree vs base: covers committed and
  uncommitted) plus untracked files from `git status --porcelain`.
- The result goes to `job.progress.files = { changed: number | null, at }`.
  `null` means unknown (git failed); it is never 0 by mistake.
- The final count is taken by the existing completion path before worktree
  cleanup. That path switches to the same unique-path rule (fixes today's
  committed + uncommitted double count).
- No PR link (no source exists today).

### B4. Wire, bus and client refresh

- `listJobs` adds `view` (§5.3), computed from the record plus in-memory `live`
  only: no I/O.
- `delegate.updated` payload gains `view`.
  - Per job it is published at most every 5 s, trailing (the last state is
    always sent).
  - Terminal transitions publish immediately.
  - The trigger is any change to `view` except `elapsedMs`/`quietMs` (clients
    tick those locally from `asOf`).
- **Desktop**: on `delegate.updated` carrying `view`, patch that job in the
  store instead of refetching the whole list (`App.tsx` today refetches on every
  event). Refetch only when the id is unknown or the status changes (nesting may
  change).
- **iOS**: the same patch-in-place in its job store; the existing 10 s poll
  stays as the healer.

### B5. Reporting prompt

`buildJobPrompt` adds this paragraph (exact text):

> Progress: keep your todo list current — it is shown to the user as your
> progress. At each plan step call progress_report with a one-line label; when
> you find or finish something the user would want to know, add it as a
> milestone. You cannot ask the user questions from here: if you need a decision,
> call progress_report with state "blocked" and a label saying what you need, then
> end your turn with the question.

`progress_report` gains `milestone?: string`. Its description keeps the
anti-narration wording and adds: "In a background job, `milestone` records a
notable finding (≤160 chars)." It still says it does not notify. No push is added
by this spec.

### B6. Surfaces

All model text is rendered as plain text (no Markdown, no HTML, no links),
single-line with ellipsis truncation. The full text is in a title/tooltip
(desktop) or the expanded view.

**Desktop parent card** (`RunCard`, running/settling only):

- **Row 1**: spinner · "Running in background:" · name · steps chip `3/7`
  (when steps) · elapsed · Open session.
- **Row 2**: headline. In amber, prefixed "Needs a decision:", when the model
  state is `blocked`.
- **Row 3**: a 2 px bar (when steps).
- Fixed height per state: rows 2–3 reserve their space with `visibility:hidden`
  when empty.
- **Disclosure** — a separate button "Details" (keyboard-focusable, not wrapping
  Open session). Shows:
  - checklist (✓ done, ▸ current, ○ pending; cancelled hidden);
  - milestones (newest first, with relative time);
  - live tool + its age;
  - "Quiet for N min" when `quietMs ≥ 3 min`;
  - files changed;
  - tokens / cost;
  - "time left Hh Mm" when `limitRemainingMs` is set;
  - "plan grew" for 120 s after `grewAt`.
- Open-session errors keep showing under the card.

**Finished result card**: unchanged, except:

- "Needs a decision" state when `endedBlocked`;
- the new reasons from A2/A3/A8 shown as the failure text.

**Sidebar job row**: the `3/7` chip; tooltip = headline.

**iOS** (`BackgroundJobsSheet.swift` rows; model `DelegateJob` in
`SessionModels.swift`):

- Add a lenient optional `view` (unknown or invalid → nil; an older box sends
  none).
- Row: line 1 name + `3/7`; line 2 headline (instead of `activity` when `view`
  exists); a thin bar.
- Tap the row's info button → a detail sheet with the same content as the desktop
  disclosure. Tapping the row still opens the session.
- The generic blocked card (`ChatCardViews.swift`) is untouched.
- Decoding tests: full, partial, invalid-typed and absent `view`.

**Parent agent** (`delegate_list` text) gains per job: `state`, headline,
`steps 3/7`, the last 3 milestones, `quiet Nm` (when ≥ 3 min), elapsed,
`time left` (when set).

**Completion text**: gains `Milestones:` (only when non-empty) and `Reason:`
(A9). It is built from the job record, so it can't be lost to `clearProgress`.

## 5. Contracts (pinned)

### 5.1 Job record — new / changed fields

```
segmentStartedAt: number          // = startedAt (alias, existing field kept)
ceilingMs: number                 // current segment ceiling
baseCeilingMs: number             // launch value, restored on resume
extensions: [{ at, minutes, reason }]   // ≤ 20, current segment only
ceilingWarnedFor: number | null   // the ceilingMs a warning was sent for
endReason: "stalled" | "time-limit" | "loop" | "budget" | null
endedBlocked: boolean             // final model state was "blocked"
lastProgressAt: number | null     // display only; never used to judge after a restart
progress: {
  label: string, labelAt: number | null,
  modelState: "working" | "blocked" | "done" | "failed" | null,
  checklist: [{ text: string, status: "pending" | "in_progress" | "completed" | "cancelled" }] | null,
  reported: { step: number, total: number } | null,
  planRevision: number, grewAt: number | null, bar: number | null,
  milestones: [{ at: number, text: string }],
  files: { changed: number | null, at: number } | null,
  usage: { tokens: number, costUsd: number | null, costPartial: boolean }
}
```

**Defaults**: legacy running records with none of these fields get them at first
touch:

- `ceilingMs = baseCeilingMs = sweepAllowanceMs ?? 4 h`;
- empty `progress`, `extensions: []`, `ceilingWarnedFor: null`;
- `endReason: null`, `endedBlocked: false`.

**Reset rules** (continuation spreads the old record today — these must be reset
explicitly there):

- **Continuation** resets `extensions`, `ceilingWarnedFor`, `endReason`,
  `endedBlocked`, `lastProgressAt` and `progress` (all fields), and sets
  `ceilingMs = baseCeilingMs`.
- **Resume** resets `extensions`, `ceilingWarnedFor` and `endReason`, sets
  `ceilingMs = baseCeilingMs`, and keeps `progress`.

### 5.2 Per-session progress record (`progress.json`)

Unchanged shape. `milestone` is accepted by `/api/progress` and routed only to
`job.progress`. Writes become serialized per session.

### 5.3 `view` (wire, computed; identical for desktop, iOS, tool)

```
view: {
  asOf: number,                   // epoch ms the view was computed
  state: "working" | "needs-decision" | "done" | "failed" | "stopped" | "paused" | "settling",
  headline: string,               // ≤120, plain text, may be ""
  headlineSource: "model" | "checklist" | "tool" | "activity" | "none",
  steps: {
    done: number, total: number, current: string | null,    // current ≤120
    items: [{ text: string, status: "done" | "current" | "pending" }],  // ≤ 30, text ≤ 120
    source: "checklist" | "reported", planRevision: number, grewAt: number | null
  } | null,
  bar: number | null,             // 0..1 per B2
  live: { tool: string, target: string, startedAt: number } | null,  // longest-running tracked tool
  lastProgressAt: number | null,  // client derives "quiet for"; show only when running and ≥ 3 min
  milestones: [{ at: number, text: string }],   // newest first, ≤ 8
  segmentStartedAt: number | null,
  ceilingAt: number | null,       // segmentStartedAt + ceilingMs; null for opencode-owned
  files: { changed: number | null } | null,
  usage: { tokens: number, costUsd: number | null, costPartial: boolean } | null,
  model: string | null
}
```

**Clients**:

- elapsed = `now − segmentStartedAt` (wall, current segment);
- "time left" is shown only while running and `ceilingAt − now < 30 min`;
- quiet = `now − lastProgressAt`.

**State mapping**:

- `running` + modelState `blocked` → `needs-decision`;
- `running` → `working`;
- `done` + `endedBlocked` → `needs-decision`;
- otherwise the job status (`settling` is the existing card kind).

**opencode-owned jobs**: `ceilingAt` null; `usage`/`files` null; steps and
headline as available.

`progress` (per-session) and `activity` stay on the wire for one release, then
are removed.

### 5.4 Tools (V1 `docs/opencode-tools/*.ts` and V2 `docs/opencode-plugins-v2/manta/tools/*.ts` stay twins; pack test updated)

- `delegate` + `maxDurationMinutes?: integer 10–720`; invalid → refused with a
  message, the job isn't started.
- `delegate_extend({ id: string, minutes: integer 15–480, reason: string 1–200 })`
  → `POST /api/delegate/:id/extend` (A7).
- `progress_report` + `milestone?: string`.
- `delegate_list` output adds the fields in B6.

### 5.5 Bus

`delegate.updated` `{ id, status, activity, view }`, with the publish rules of
B4.

## 6. Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Heartbeat + timeout engine | Existing 60 s job sweeper + in-memory liveness map fed by the existing opencode event pump. | **Temporal** (`@temporalio/client` 1.25.0, 2026-10-27, MIT, 5 deps, 6.7M/wk; sdk-typescript 950★, pushed 2026-11-13). **BullMQ** (6.7.6, 2026-11-12, MIT, 5 deps, 13.6M/wk; 9.6k★, pushed 2026-11-14; its `lockDuration` + stalled-job checker is the same idea). **pg-boss** (12.38.2, 2026-11-10, MIT, 4 deps, 4.9M/wk; 4.1k★, pushed 2026-11-13). All are healthy, but each drives work in workers it runs. Our work runs inside opencode, and the heartbeat is opencode's event stream, which only our pump sees. Each would add a server (Temporal / Redis / Postgres) to own one timer the engine already runs. We adopt their design (heartbeat + start-to-close + soft warning), not the infrastructure. |
| Loop detection (stage 2) | Trial `opencode-doom-loop-detector` (0.2.0, 2026-11-13, MIT, 0 deps, 309/wk, repo metal-huang/opencode-doom-loop-detector). | Upstream PR anomalyco/opencode#61328 (same design, unmerged). Too new to adopt blind, hence a replay trial with a pass bar (A8). Our own detector only if the trial fails it. |
| Throttle / coalesce publishes | Small per-job trailing timer in the engine. | lodash.throttle etc.: trivial, and the coalescer must also key on job id and flush on terminal; same pattern as `streamInterp`'s existing coalescing. |
| Per-key serialization | Existing `createKeyedMutex` (already used by delegate). | — |
| Usage / pricing | `cost` and token fields already on `session.step.ended` events (opencode prices them). | Optimizer price table: not needed when opencode supplies `cost`; a gap is flagged `costPartial`. |
| Persistence | Existing `jsonStore` atomic writes of the job store. | — |
| Progress schema | Own `view`; semantics from MCP progress / LSP WorkDoneProgress / A2A TaskStatus. | Those are protocols, not packages. `@a2a-js/sdk` would add a protocol we don't speak. |
| UI | Existing card primitives (desktop), SwiftUI (iOS). | — |

## 7. Tests (injected fakes; no live opencode/tmux; nothing heavy on this box)

### Liveness

- Output every 2 min for 3 h → alive; ends at 4 h with `time-limit`.
- 16 min with no events → stalled.
- `progress_report` calls only (no other events) for 20 min → stalled.
- Shell with `timeout: 1200000`, silent: alive at 24 min, stalled at 26 min
  (anchored to start).
- Shell with `timeout: 0` and no output: alive at 59 min, stalled at 61 min.
- Shell output bytes beyond the 20 000-char display cap still advance liveness.
- Two tools, one within allowance → alive.
- A descendant's events advance the parent job; a silent descendant that is
  merely active does not.
- After boot, `reconstructedAt === null` → never stalled. A failed
  reconstruction is retried; a successful one restores a running shell with its
  start time.
- Handoff-deferred, `creating` or `uncertain` → never judged.
- Lost-run detection wins.

### Ceiling and extension

- Warning sent once at the threshold. A 10-minute ceiling warns at 5 min left.
- An extension re-arms the warning (new `ceilingMs`).
- Snapshot-then-extend race → no timeout (A6).
- Extend checks:
  - foreign session refused;
  - handoff-chain session accepted;
  - terminal / opencode-owned refused;
  - minutes outside 15–480 refused;
  - exceeding 12 h refused;
  - the refusal text is returned by the tool.
- CTO `sweepAllowanceMs` becomes the ceiling.
- Resume restores `baseCeilingMs` and drops extensions.
- Continuation resets every field in §5.1.
- A legacy running record gets the defaults.

### Progress

- `view` from: checklist only; reported only; both (checklist wins steps, model
  wins headline); neither.
- Cancelled items are excluded.
- Reported step 3 of 5 → done 2.
- The bar is monotonic within a revision, drops on a new one, sets `grewAt`,
  caps at 0.95, and is 1 only on `done`.
- A model `done` while running doesn't change the state.
- `blocked` → `needs-decision`; an end while blocked → `endedBlocked`.
- Milestones: bound 8, duplicate dropped, survive `clearProgress`, appear in the
  completion text.
- Concurrent reports don't lose milestones (keyed mutex).
- Usage dedupe; `costPartial`; reset on continuation; accumulates across
  handoff.
- Files: unique paths, `null` on git failure, no double count at completion.
- Publish throttle: ≤ 1 per 5 s per job, the trailing one is delivered, terminal
  is immediate.
- `buildJobPrompt` contains B5 verbatim.
- The job ruleset ends with a `question` deny.

### Clients

- Desktop store patch-in-place on `view`; refetch on an unknown id or a status
  change.
- RunCard visual-gate states: working with steps, without steps,
  needs-decision, quiet ≥ 3 min, details open, plan grew.
- Model text with `<b>` / markdown renders literally.
- iOS decoding tests: full, partial, invalid and absent `view`. iOS build per
  `mobile/native/AGENTS.md`.

### Upgrade

- An existing box needs no manual step: the plugin/tool twins ship through the
  normal update path (`upgradeV2Prepare`), and legacy records get defaults (§5.1).

## 8. Rollout and follow-up

- **Stage 1** (one release): A1–A7, A9, B1–B6 incl. iOS; usage recorded
  (shadow).
- **Stage 2**: A8 (loop trial → enforcement; budget default + enforcement).
- **Follow-up routine**: created when this spec is approved for implementation
  (rule: at the moment we commit to observing).
  - It first checks whether the box's running release contains this feature (the
    job store has records with `ceilingMs`) and reports "not deployed yet" until
    it does.
  - From deploy + 7 days it reports, read-only from `~/.manta/delegate-jobs.json`
    and opencode's DB (via the worker-offloaded readers):
    - counts by `endReason`;
    - for each `stalled`, whether events/messages occurred in its last 15 min
      (a false stall);
    - jobs that reached 4 h;
    - the share of jobs with steps / milestones;
    - the per-job tokens/cost distribution (p50/p90/max).
  - Thresholds:
    - more than 2 false stalls → propose raising 15 min;
    - more than 10% of jobs hitting 4 h → propose raising the default;
    - steps on < 50% → strengthen B5;
    - propose the stage-2 budget as p99 × 1.5.

## 9. Open questions

None blocking.
