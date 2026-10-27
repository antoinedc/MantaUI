# Background-job reconciliation, `delegate_send`, and delegate tool copy

Box server + opencode tool registrars + a one-line renderer label. Native iOS
is not changed.

## 0. Problem (measured 2026-10-27)

Seven sessions were busy on the box with no sidebar row:

| Session | Why it had no row |
|---|---|
| cantina "P3-B execution engine", "P3-G2 capture and grants"; crypto-otc "Astra recheck" | A delegate job that went `done` (window closed) and was then **re-prompted** — via opencode's HTTP API from a script, or a resumed `task`. A terminal job never comes back. |
| cantina "P3-C evidence and custody" | Driven only through opencode's HTTP API by a project script (`tools/oc-session/send.mjs` + `wait-idle.mjs`). Manta never saw it. |
| cantina "J early"; crypto-otc "A.4", "A.5" | A `task` with `background:true` whose parent session **has no window** (an orchestrator that was handed off). Adoption requires the parent's window and drops it — 8 `could not resolve the owning window` warnings in one morning. |

Plus: adoption is event-only, so anything that started while manta-server was
restarting is never picked up.

The sidebar row of a job IS a chat-mode tmux window stamped with the child
session id (`computeJobNesting` nests it under the window of
`job.parentSessionID`). So "make it visible" = "give it a job record + window".

## 1. The reconciler (source of truth = opencode's active set)

New engine method `reconcileActiveSessions()` in `src/server/delegate.mjs`,
run by a poller (`startActiveSessionReconciler`, 15 s interval, in-flight
guard, `timer.unref()`, same shape as `startActivityPoller`) and once at boot
after `reconcileV2`. Wired in `src/server/index.mjs`.

Each tick:

1. `active = listActiveIds()`. On failure: do nothing this tick.
2. `windowed` = every `opencodeSessionId` stamped on a tmux window (`listProjects()`).
3. For each `sid ∈ active`, `sid ∉ windowed`, classify (first match wins):
   1. **Tracked running job** (`jobs` has `childSessionID === sid` and status
      `running`/`paused`) → skip (its own machinery owns it).
   2. **Terminal job** (`childSessionID === sid`, status `done|failed|stopped`)
      → **revive** (§2).
   3. **Excluded** → skip: descendant of a Manta-owned wrapped run (the engine's
      `treeIndex`); a Manta-internal session (§1.1); a session whose `claims`
      entry says foreground (`background:false`).
   4. **Untracked** → candidate. Adopt (§1.2) once it has been seen busy on
      **2 consecutive ticks** (debounce; per-sid first-seen map, entries
      dropped when the sid leaves `active`).
      Foreground-`task` guard: if there is no `claims` entry for it AND its
      opencode parent is itself in `active`, read the parent's recent messages
      (`listMessages(parent)`, latest assistant message's tool parts) for a
      `task` part whose `metadata.sessionId === sid`. Foreground
      (`background` not true) → skip. Background → adopt. Not found → skip this
      tick (re-evaluated next tick). If the parent is NOT active, it cannot be
      a foreground child → adopt.

### 1.1 Manta-internal sessions are never adopted

The implementer must inventory every server-side session creator
(`grep -rn "createSession(\|session.create" src/server`) — title generation,
CTO conversation/role/ephemeral sessions (`ctoBinding.mjs`, `ctoAct.mjs`,
`index.mjs` ~2621), optimizer/compaction helpers, `rpc.mjs` window creation,
etc. Exclusion rule, in order:
- the session's `agent` is `title`, `compaction` or `summary`;
- the session's `metadata.manta.internal === true` — every server-side creator
  of a session that is NOT meant to be a user-visible row must stamp this
  (the opencode `createSession` wrapper accepts `metadata`; extend callers);
- a session the CTO binding currently owns (expose a predicate from ctoBinding
  if one does not exist).
Sessions created for user windows / delegate jobs need no stamp (they have a
window or a job). List the creators found and how each is handled in the report.

### 1.2 Adoption of an untracked session

- **Display parent** = walk `readSession(x).session.parentID` upward (max depth
  8, cycle-safe) to the nearest ancestor that has a window. If found → owner =
  that window's tmux session; `parentSessionID` = that ancestor.
- Otherwise → owner = the tmux project that owns the session's `directory`
  (reuse `resolveForgeOwner` matching rules: `defaultCwd` equal, or a window
  `paneCurrentPath` equal / prefix). `parentSessionID` = the session's real
  opencode parent id (may be windowless; the row then renders top-level).
- No owner at all → skip, warn **once per sid** (not every tick).
- Record via the existing `registerJob` path with `existingSessionId: sid`,
  `worktree: null`, `cwd: session.directory`, `name: session.title` (fallback
  "Background session"), `prompt: ""`, `origin: "observed"`,
  `extra: { engine:"v2", completionOwner:"opencode", attempt:1, launchState:"running",
  submittedAt:null, completionMessageId:null, completionDelivery:null,
  sessionParentID: <real opencode parent id or null> }`.
- `adoptSubagentJob` (event path) gets the same display-parent fallback instead
  of returning on "could not resolve the owning window": walk to a windowed
  ancestor, else directory owner. Its log line stays only for the no-owner case.

### 1.3 Observed jobs are track-only

`origin:"observed"` jobs (and revived jobs, §2) with `completionOwner:"opencode"`:
- never count toward `MAX_RUNNING_JOBS` and never trigger the "a background job
  cannot start another background job" refusal (`launchRefusal`);
- are never aborted/stopped automatically: excluded from the 30-min running
  timeout and the "parent session gone → stop" sweep;
- settle through the existing `settleV2Job` path (completionOwner `opencode` ⇒
  no result posted to anyone), which closes the window via `finishV2Cleanup`;
- the user can still Stop / Open them from the UI like any job.

## 2. Revive: a terminal job whose session is busy again

Under the jobs lock, re-check the live record is still terminal, then patch:
`status:"running"`, `finishedAt:null`, `result:null`, `error:null`,
`attempt: (attempt??1)+1`, `revivedAt: now`, `cleanedUp:null`,
`completionOwner:"opencode"`, `completionDelivery:null`,
`origin` unchanged. Then reopen its window (reuse `openJobSession` logic:
existing window → repoint; else `newWindow` under `job.tmuxSession` or the
§1.2 owner). Publish `delegate.updated`. A revived job is track-only (§1.3):
its prior result was already delivered; the re-prompter owns the new turn.
(`delegate_send`, §3, is the managed way that DOES deliver.)

## 3. `delegate_send` — continue a job (managed)

### REST
`POST /api/delegate/:id/send` body `{ prompt: string, sessionID: string, directory?: string }`
- `404 {error:"that background job no longer exists"}`
- `400 {error:"prompt is required"}`
- `403 {error:"that job belongs to another session"}` — when the job's
  `completionOwner` is `manta` and `sessionID` is neither `job.parentSessionID`
  nor in its replacement chain (`deps.replacementChain`). Jobs with
  `completionOwner:"opencode"` (observed, adopted subagents, revived) may be
  sent to by any session: the send **takes the job over**.
- `409 {error:"the job is paused — resume it first"}` for `paused`.
- `409 {error:"the job's branch <b> no longer exists"}` when the worktree is
  gone and its branch can't be re-added.
- `200 {ok:true, job}`.

### Behaviour
- **Running** job: send the prompt to the child with delivery `queue`
  (delivered after its current turn) via the same send path `peers_message`
  uses. If the caller is taking over an `opencode`-owned job, patch
  `parentSessionID=sessionID`, `parentDirectory=directory`,
  `completionOwner:"manta"`, `origin` unchanged.
- **Terminal** job: under the lock patch to `running` exactly as §2 but with
  `completionOwner:"manta"`, `parentSessionID` = caller (takeover rules above),
  `completionMessageId:null`, `completionDelivery:null`, `submittedAt:null`.
  If `job.worktree` is set and missing on disk: `git worktree add <path> <branch>`
  from the job's repo; failure → 409 above (and roll the record back). Reopen
  the window (§2). Submit the prompt, then set `submittedAt` — so `settleV2Job`
  treats the next idle after submission as completion and posts ONE result
  (N7) to the caller exactly like a fresh job.
- Never counts toward / is refused by the cap for a job that was already
  running; reviving a terminal job IS subject to the cap (it is new managed
  work) — refusal message is the existing `CAP_ERROR`.

### Tool (both registrars)
`docs/opencode-tools/delegate.ts` AND `docs/opencode-plugins-v2/manta/tools/delegate.ts`
(the installed one is the v2 plugin) get `delegate_send({ id, prompt })`,
description + return string pinned in §5.

## 4. `delegate_list` scope

`GET /api/delegate?sessionID=&scope=workspace` → jobs whose `tmuxSession`
equals the caller's tmux session (resolved via `resolveOwner`), running/paused
plus terminal from the last 24 h. Default scope (`mine`) unchanged. Tool gets an
optional `scope: "mine" | "workspace"` arg; each listed line also shows
`origin` when it is `observed`.

## 5. Tool + guidance copy (pinned)

### `delegate` description
> Run a piece of work in the background — in its own session, git worktree and
> branch — and get its result back automatically as a later message. This is
> THE way to hand work to another agent on this box: the user sees every job as
> a row in the sidebar and can open, pause or stop it. Use it whenever the work
> doesn't block what you do next: implementing a feature or fix, a refactor, a
> test-suite run-and-fix, a review or investigation that must not touch your
> checkout. Split independent pieces into parallel jobs (up to five at once);
> each one is a full model session, so don't start jobs whose result you won't
> use. Prefer it over driving opencode sessions yourself (scripts calling its
> HTTP API, wait-for-idle scripts, sleep/poll loops, tmux): those run invisibly
> to the user and their results are lost on a restart. Use the built-in `task`
> tool instead when you need the answer before you can continue (foreground),
> or for read-only research (`background: true`). The job starts with NO
> knowledge of this conversation: put the goal, paths, constraints and what
> "done" looks like in the prompt. To give the SAME job more work later (a fix
> round, the next milestone), use `delegate_send` with its id — it keeps the
> job's context and branch; don't start a new job for it. This call returns
> IMMEDIATELY and you do NOT have the result yet — it arrives on its own; do
> not report or guess it before then, and do not poll. A background job cannot
> start background jobs of its own.

### `delegate_send` description
> Give more work to an existing background job — a fix round after a review,
> the next milestone, an answer to something it asked. The job keeps its
> session, context, worktree and branch, which makes this cheaper and better
> than starting a new job. If the job is still working, your message is queued
> after its current turn; if it has finished, it restarts with your message.
> Its next result comes back to you automatically as a later message — do not
> poll. You can also take over a job shown by `delegate_list` with scope
> "workspace" (for example one an earlier session of yours started): after the
> send, its results report to you. Returns immediately; you do NOT have the
> result yet.

Return string: `Sent to background job "<name>" (id <id>). You do NOT have its
result yet — it will arrive as a separate message when this round finishes. Do
not report or guess it before then.`

### `delegate_list` description (append)
> Pass scope "workspace" to see every job in this workspace, including ones
> started by other sessions, so you can pick one up with `delegate_send`.

### `docs/opencode-tools/AGENTS.md` — "MantaUI background delegation"
Replace the table + bullets with: the same three-row table plus two rows —
"Follow-up work for a job you (or an earlier session) started →
`delegate_send`", and "Driving another session yourself (opencode HTTP API,
wait-for-idle scripts, tmux) → don't; use `delegate` / `delegate_send` — that
work is invisible to the user." Document `delegate_send` and `scope` in the
bullet list. Keep the "you do NOT have a result" paragraph and the cap
paragraph (note observed jobs don't count). Drop the "do not fan out
speculatively" phrasing in favour of the §5 wording. Mirror the same change in
the repo `AGENTS.md` "Background delegation" section (tools list + one
paragraph on the reconciler and observed jobs).

## 6. Renderer

Job rows/cards whose job `origin === "observed"` show the secondary label
"started outside Manta" (title attribute: "Picked up automatically — this
session was started by a script or another tool; its result isn't reported to
any chat"). Nothing renders job `origin` today: add it to the nested sidebar
job row (Sidebar) and the background job card (`BackgroundCards.tsx`), and
carry `origin` through the renderer's job type if it is not already there. No
other renderer change.

## 7. Tests (node:test / vitest, pure + injected I/O)

- reconciler: untracked busy session adopted only on the 2nd tick; leaves
  `active` → first-seen dropped; windowed / tracked-running skipped; internal
  (agent `title`, `metadata.manta.internal`) skipped; foreground task child
  (claims or parent-message lookup) skipped; parent idle ⇒ adopted; windowless
  parent ⇒ nearest windowed ancestor; no windowed ancestor ⇒ directory owner;
  no owner ⇒ skipped with one warning; listActiveIds failure ⇒ no-op.
- revive: done job busy again → running, window reopened, completionOwner
  `opencode`, settles without posting a result.
- observed jobs: excluded from cap, nesting refusal, timeout, parent-gone stop.
- adoptSubagentJob with windowless parent → adopted under windowed ancestor.
- `delegate_send`: running → queued send, no status change; terminal → revived
  with completionOwner manta + one N7 on next completion; takeover of an
  `opencode` job repoints parent; 403 / 404 / 409 paths; missing worktree
  re-added from branch; cap applies to revive only.
- `listJobs` scope workspace.
- renderer: the observed label renders for `origin:"observed"` only.

## 8. Deploy notes (not part of the PR)

Server tarball release (`server-v*`), then copy the v2 plugin tool
(`docs/opencode-plugins-v2/manta/tools/delegate.ts` → `~/.config/opencode/plugins/manta/tools/delegate.ts`)
and refresh the AGENTS.md blurb, restart `opencode-serve`.
