# Background jobs: stay alive while working, and show their progress

Status: draft for review, 2026-11-14. Scope: background jobs started with
`delegate` (Manta-owned). Jobs opencode owns (adopted subagents, native
background commands) keep their current lifecycle; they get the progress
display, not the new limits.

## 1. Problem

### 1.1 Good work is killed at 30 minutes

Every Manta-owned job is failed "timed out after 30 minutes" by the sweeper,
whatever it is doing. The limit came with the first engine (BET-378, July),
copied from the plugin-job sweeper with no stated reason. It used to be the only
defence against dead runs, runaway agents, real hangs and a stuck job holding one
of the 5 slots. Dead runs are now caught separately in ~2 minutes (lost-run
detection, 2026-11-02).

Measured on the dev box (`~/.manta/delegate-jobs.json` × opencode's DB):

- 20 of ~230 Manta-launched jobs ended "timed out after 30 minutes" (9%), all in
  the 6 days before this spec.
- 17 of the 20 had written a message within ~2.5 minutes of the kill.
- 3 were inside one long shell command (a wait loop with its own 20-minute
  timeout, an analysis script with no timeout, a test-speed run).
- 0 were hung.
- One session was killed 5 times in a row and re-sent by hand each time
  (~2.5 h of work in 30-minute slices, each kill landing mid-step).
- opencode-owned subagents have no limit; they ran up to 153 minutes and
  finished normally.

### 1.2 The parent can't see how a job is going

- The parent's job card says only "Running in background: <name>".
- A progress channel exists (`progress_report`: label, step/total, state,
  detail), but no job has ever used it (0 of 49 Manta-launched job sessions).
  Voluntary reporting doesn't happen.
- The agents DO keep a checklist: 29 of 49 job sessions (59%) used the todo
  list. That is real, measured progress nobody shows to the parent.
- The parent AGENT sees only a one-line "activity" guess in `delegate_list`.

## 2. Research summary

Liveness:

- **Temporal** (activities): a short *heartbeat timeout* ("no proof of progress
  for N") plus a long *start-to-close* limit. Their docs: set the overall limit
  longer than the longest legitimate run, and use heartbeats to fail fast on a
  stuck one. A heartbeat can carry progress details.
- **AWS Step Functions**: `HeartbeatSeconds` < `TimeoutSeconds`, same split.
  A heartbeat "indicates the task is still running and needs more time".
- **Celery**: soft limit (the task gets a chance to clean up) before the hard
  limit; limits settable per task.
- **Agent harnesses**: loops are caught by repetition detectors and spending
  budgets, not by a clock. opencode V2 accepts the `doom_loop` permission but
  nothing raises it (upstream issue #59339, PR #61328); a community plugin
  restores it.

Progress display:

- **NN/g / Nielsen**: anything over 10 s needs a percent-done or a list of
  completed and remaining steps. When an accurate percentage is impossible, show
  steps. Show the current step without drowning the user in system detail. Users
  returning after a long wait need to re-orient.
- **Microsoft progress-bar guidelines**: never go backwards or restart; never
  show 100% before it's done; show a time estimate only if it is accurate.
- **MCP progress** (`progress`, optional `total`, `message`; progress must
  increase) and **LSP WorkDoneProgress** (`title`, `message`, `percentage`,
  begin/report/end): one title, one short changing message, an optional number.
  Rate-limit updates.
- **A2A** task states separate `working` from `input-required` (waiting on a
  person) and from terminal states. Status messages are for progress; results go
  in artifacts.
- **What users ask for** (Codex issues #10685/#35930, FeedbackBench interface
  criteria, Cursor/Devin/Claude Code "fleet views"):
  - current step and elapsed time;
  - a stable, monotonic completion figure based on an explicit checklist, not a
    model's guess, clearly marked when it is an estimate;
  - "waiting on you" as its own state, distinct from "busy" (the most common
    complaint);
  - a tail of what it is running now, and the files it is changing;
  - what it has found or decided so far, so they can redirect early;
  - cost / context so far.
  The Codex maintainers' point stands: a model cannot reliably estimate the
  percentage of open-ended work, so counts of declared steps beat percentages.

## 3. Part A — liveness

### A1. Stall timeout replaces the fixed 30 minutes

A Manta-owned running job records `lastProgressAt`. Any of these moves it
forward:

- model output (text/reasoning deltas, a finished step);
- a tool starting or finishing;
- live shell output growing;
- a `progress_report` call or a todo-list change;
- an active descendant (subagent) of the child.

Rules, evaluated by the existing 60 s sweep:

- **Waiting on a person** (a pending permission or question on the child):
  never stalls; the time does not count toward any limit.
- **A tool is running**: allowed `tool timeout + 5 min` when the tool declares a
  timeout (shell `timeout`, in ms), else **60 min** since the last output from
  that tool.
- **Otherwise**: stalled after **15 min** without progress.

A stalled job ends `failed` with
`stalled — no progress for 15 minutes (last: <activity>)` (or the tool variant:
`stalled — "<command>" produced no output for 60 minutes`). The child is
interrupted, exactly as the timeout path does today.

`lastProgressAt` is kept in memory and persisted at most once a minute. After a
manta-server restart a job restarts its stall window from boot (never judged on
a stale value).

### A2. Hard ceiling, much higher, set per job

- Default **4 h** of active time (time waiting on a person is added back).
- `delegate` gains `maxDurationMinutes` (10–720). Omitted → 240.
- The overnight CTO path keeps working: its `sweepAllowanceMs` becomes the
  job's ceiling.
- Reaching it: `failed`, `reached its time limit of <N>` (`<N>` formatted, e.g.
  "4 hours").

### A3. Warning before the ceiling

At ceiling − 10 min, once per job: a steered message into the child.
> "Background job notice: about 10 minutes left before this job is stopped.
> Commit your work, record where you got to with progress_report, and finish with
> your summary."

Not sent for stalls (a stalled job is not reading).

### A4. Parent can extend: `delegate_extend`

New tool for the parent (no UI button).

- `delegate_extend({ id, minutes, reason })` adds `minutes` (15–480) to the
  ceiling, capped at 12 h total from start.
- Caller-scoped: only the session that started the job (or its handoff chain)
  may extend it.
- Refused for terminal and opencode-owned jobs. A refusal is a readable string
  returned to the model, not a throw.
- Recorded on the job (`extensions[]: {at, minutes, reason}`).
- If an extension lands after the warning, the warning is re-armed for the new
  ceiling.

### A5. Runaway protection by behaviour (stage 2, measured first)

- **Loops**: the job's permission ruleset sets `doom_loop: deny` so an
  unattended job is stopped rather than left asking. Interactive sessions keep
  `ask`. Something must raise `doom_loop` on V2:
  - Candidate: trial the `opencode-doom-loop-detector` plugin on the dev box.
  - Fallback if it misfires: a small detector of our own (same repeated
    call + identical output signal), tested on recorded job transcripts.
  - Outcome: `failed`, `stopped: repeated the same action (<tool>)`.
- **Spending**: per-job token/cost totals are recorded from day one (shadow).
  A default budget is set from the measured distribution after a week (routine,
  §8). Enforcement: warn at 80% (steered message), stop at 100% with
  `stopped: spending limit reached`. `delegate` will take `maxCostUsd` once the
  default is set.

### A6. Outcomes

All new outcomes stay resumable with `delegate_send`. The completion text to the
parent names the reason and the last progress headline, so the parent can resume
with the right instruction.

The existing 5-job cap is unchanged. Lost-run detection is unchanged and still
runs first.

## 4. Part B — standardized progress

### B1. What is shown (and where it comes from)

| Item | Source | Why |
|---|---|---|
| State: working / waiting on you / blocked / done / failed | server (pending ask → waiting); model (`blocked`) | "waiting on you" ≠ "busy" is the #1 ask |
| Headline: one line, what it is doing now | model (`progress_report.label`); fallback: current todo item; else server activity | the current step in its own words |
| Steps: `done / total` + current item | todo list (measured, preferred); else `progress_report.step/total` | counts of declared steps, not guesses |
| Bar | derived from steps only | never a model-invented % |
| Live action | server: running tool + its short target (`shell: npm test`, `patch: src/x.ts`) and its age | "is it stuck?" at a glance |
| Quiet for | server: now − `lastProgressAt`, shown after 3 min | ties the display to the stall rule |
| Milestones: notable results so far (≤ 8, newest first) | model (`progress_report.milestone`) | re-orient; redirect early |
| Elapsed; time left before limit (only when < 30 min) | server | no ETA: it can't be accurate |
| Files changed, branch, PR link | server (git on the worktree, existing) | what it is touching |
| Tokens / cost so far, model | server (existing ledger/pricing) | spend visibility |

Display rules:

- The bar never goes backwards on its own. If the plan grows (total rises), the
  counts show the truth ("4/9") with a "plan grew" hint for one update.
- The bar is capped at 95% until the job is terminal.
- With no steps, show no bar: an indeterminate spinner plus the headline.

### B2. Getting the agent to report

- The opening job prompt (`buildJobPrompt`) gains a short paragraph:
  > Keep your todo list current: it is shown to the user as your progress. Call
  > progress_report at each plan step with a one-line label, and add a milestone
  > when you find or finish something the user would want to know. If you need a
  > human decision, set state "blocked" and say what you need.
- `progress_report` gains an optional `milestone` (≤ 160 chars), appended to a
  bounded list (8, oldest dropped). Every other field keeps the
  replace-not-append rule.
- Server-side throttle: reports less than 15 s apart are coalesced (the last one
  wins, milestones are kept).
- The tool description keeps its anti-narration wording.

### B3. Surfaces

- **Desktop parent card** (running job), one line plus an optional second:
  - **Line 1**: status dot (accent / warn for waiting / danger for stalled
    warning) · name · `3/7` · elapsed · Open session.
  - **Line 2**: headline, or "Waiting on you: <question/permission title>" in
    warn tone.
  - A 2 px bar under line 2 when steps are known.
  - **Click to expand**: checklist (done ✓, current ▸, remaining), milestones,
    live action, quiet-for, files/branch/PR, tokens/cost.
  - The card's height is fixed per state (expansion is explicit).
- **Sidebar job row**: `3/7` chip and a warn dot when waiting; the tooltip keeps
  the activity line.
- **Parent agent**:
  - `delegate_list` returns, per job: state, headline, steps, the last 3
    milestones, quiet-for, elapsed, limit remaining.
  - The completion text gains a "Milestones" section only when there are some.
- **Push**: unchanged. A child's permission/question already notifies on the
  blocking tier. A model `blocked` state now also notifies once, on the blocking
  tier.
- **iOS**: same wire data and the same card content as desktop (collapsed line,
  second line, bar, tap to expand), in the same release. The native card already
  renders `progress.detail`; it switches to `view`. Verified per
  `mobile/native/AGENTS.md` (no Swift toolchain on the Linux box).

## 5. Contracts (pinned)

### 5.1 Job record (server, `delegate-jobs.json`) — new fields

```
maxDurationMs: number            // ceiling of active time; default 4h
extensions: [{ at: number, minutes: number, reason: string }]
waitingMs: number                // accumulated time waiting on a person
ceilingWarnedAt: number | null
endReason: "stalled" | "time-limit" | "loop" | "budget" | null   // with status failed
usage: { tokens: number, costUsd: number | null }                // shadow, updated by the activity poller
```

`lastProgressAt` is in-memory, persisted at most once a minute as
`lastProgressAt`.

### 5.2 Progress record (`progress.json`, per child session)

```
{ sessionID, label, step, total, state, detail, updatedAt,
  milestones: [{ at: number, text: string }]   // NEW, ≤ 8, newest last
}
```

`state` stays `working|blocked|done|failed`; "waiting on you" is derived, never
stored.

### 5.3 Wire: a job as returned by `delegate:list` / `delegate_list`

New `view` object, computed on the server (one source for desktop, iOS and the
tool):

```
view: {
  state: "working" | "waiting" | "blocked" | "done" | "failed" | "stopped" | "paused",
  headline: string,
  headlineSource: "model" | "checklist" | "activity",
  steps: { done: number, total: number, current: string | null,
           items: [{ text: string, status: "done" | "current" | "pending" | "cancelled" }],
           source: "checklist" | "reported", grew: boolean } | null,
  live: { tool: string, target: string, sinceMs: number } | null,
  quietMs: number | null,          // null when < 3 min or not running
  waitingOn: { kind: "permission" | "question", title: string } | null,
  milestones: [{ at: number, text: string }],
  elapsedMs: number,
  limitRemainingMs: number | null, // null unless < 30 min
  files: { changed: number, branch: string | null, prUrl: string | null },
  usage: { tokens: number, costUsd: number | null },
  model: string | null
}
```

The existing `progress` and `activity` fields stay for one release (older
clients), then are removed.

### 5.4 Tools

- `delegate` + `maxDurationMinutes?: number` (10–720).
- `delegate_extend({ id: string, minutes: number, reason: string })`. Returns
  `Extended "<name>" by <m> min — new limit <h:mm> after start.` or the refusal
  text.
- `progress_report` + `milestone?: string`.

V1 tool files (`docs/opencode-tools/`) and V2 plugin tools stay in sync (the
existing pack test).

### 5.5 Bus

`delegate.updated` payload gains `view` (same shape). It is published at most
every 5 s per job.

## 6. Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Heartbeat + timeout engine | existing job sweeper (60 s) + in-memory `lastProgressAt` | Temporal (`@temporalio/client` 1.25.0, MIT, 6.7M/wk), BullMQ (6.7.6, MIT, 13.6M/wk; `lockDuration` + stalled-job checker), pg-boss (12.38.2, MIT, 4.9M/wk): all adopt the same heartbeat model, but the work runs inside opencode, not a worker these libraries drive. The "heartbeat" is opencode's event stream, which only we observe. Adding one means a new service (Temporal server / Redis / Postgres) for a single timer the engine already runs. We adopt their design (heartbeat + start-to-close + soft limit), not the infrastructure. |
| Loop detection | trial `opencode-doom-loop-detector` (0.2.0, published 2026-11-13, MIT, 0 deps, 309/wk) | Upstream PR anomalyco/opencode#61328 (same code, unmerged). Too young to adopt blind, hence a trial plus a stated fallback. Hand-rolled only if the trial misfires on recorded transcripts. |
| Progress schema | own 10-field `view`, semantics from MCP progress / LSP WorkDoneProgress / A2A TaskStatus | Those are protocols, not libraries; no package stores a status record. A2A SDK (`@a2a-js/sdk`) would add a protocol we don't speak. |
| Checklist source | opencode's todo list (already parsed by `summarizeTranscript`) | — |
| UI | existing card primitives, no new dependency | — |

## 7. Tests (injected fakes; no live opencode/tmux)

Liveness:

- a job producing output every 2 min for 3 h → never stalled, ends at 4 h;
- 16 min silent → stalled;
- a shell with `timeout: 1200000` silent for 24 min → alive, at 26 min → stalled;
- a shell with no timeout and no output for 61 min → stalled;
- pending question → never stalled and the ceiling shifts by the wait;
- the warning is sent once, and re-armed after an extension;
- `delegate_extend` happy path, cap at 12 h, refused for terminal / opencode-owned
  / another session's job;
- manta-server restart → window restarts from boot;
- CTO overnight allowance maps onto the ceiling;
- lost-run detection still wins over stall.

Progress:

- `view` from: todo list only; progress_report only; both (checklist wins steps,
  model wins headline); neither (activity);
- plan grows → `grew:true` once;
- bar capped at 95%;
- milestone bound 8;
- throttle coalescing keeps milestones;
- waiting derived from a pending permission;
- `buildJobPrompt` contains the reporting paragraph.

UI:

- card states rendered in the visual gate (working with steps, without steps,
  waiting, quiet warning, expanded).

## 8. Rollout and follow-up

- **Stage 1**: A1–A4, A6 + B1–B3 (desktop card, iOS card, sidebar chip, tool
  output), shadow usage recording.
- **Stage 2**: A5 (loop trial, budget enforcement).
- **At merge**, create a routine for 7 days after deploy. It checks:
  - jobs ended by each new reason, each replayed against the old 30-minute rule;
  - stalls that were false (activity seen in the 5 min before);
  - jobs that reached 4 h;
  - the share of jobs with steps (checklist or reported) and with milestones;
  - the per-job token/cost distribution, used to propose the default budget.
  Thresholds:
  - false stalls > 2 → raise 15 min;
  - more than 1 in 10 jobs hits 4 h → raise the default;
  - steps shown on < 50% of jobs → strengthen the prompt.

## 9. Open questions

1. 15 min idle is agreed (2026-11-14). Active jobs showed silent gaps of up to
   ~2.5 min; the routine raises it if it sees false stalls.
2. Extension is a parent-agent tool only; no user button (agreed 2026-11-14).
   iOS ships in the same release (agreed 2026-11-14).
