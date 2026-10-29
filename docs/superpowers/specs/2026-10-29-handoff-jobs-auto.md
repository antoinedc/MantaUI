# Background jobs hand off on their own

Status: revised after review (round 1), 2026-10-29. Builds on
`2026-10-26-auto-handoff.md` (§4, §6.3) and
`2026-10-27-handoff-card-inline-dismiss-per-session-mode.md` (per-session mode).
Review: `reviews/2026-10-29-handoff-jobs-auto-spec-review.md` (Opus; Astra and
Luna were out of usage).

## Problem

A background job (a `delegate` job, which includes every CTO worker) is an
unattended session. Its handoff mode today is resolved like any chat: the
session's own mode if one was set, otherwise the **box default**
(`handoffMode` in the box config). A job never copies its parent's mode.

When the box default is `suggest` or `off`, a job whose context fills up and
calls the `handoff` tool gets a **card** instead of a replacement session. Nobody
is looking at a job's window, so the card is never clicked; the job's turn ends,
the job settles as finished with a full context, and the work stops. The same
happens when a job calls `handoff` with `action: "suggest"` in any mode.

## Scope: which sessions count

**A manta-owned running job**: a record in the delegate job store whose session
(after following replacements) is the session in question, whose status is
`running`, and whose completion owner is manta (`completionOwnerOf(job) ===
"manta"`). That covers `delegate` jobs and CTO workers. It EXCLUDES adopted
sessions whose completion opencode owns (`completionOwner: "opencode"`, e.g. a
backgrounded `task` subagent adopted into the rail): their parent waits on the
original child session, so a replacement would lose the result. Those keep
today's rules.

The delegate engine exposes ONE lookup, `runningJobOwner(sessionId) →
"manta" | "opencode" | null` (null = not a running job). The existing
`isJobSession` (any running record — used by the armed-trigger skip) is derived
from it (`!== null`), so its behaviour does not change. A failed lookup (store
unreadable) is treated as `null` and is not cached.

## Decision

1. **One resolver.** `resolveMode(sid) → { mode, isDefault, source }` where
   `source` is `"own" | "job" | "box"`:
   - the session's own stored mode if it has one (`source: "own"`,
     `isDefault: false`) — the box job lookup is NOT made in this case;
   - else, if `runningJobOwner(sid) === "manta"`, `auto` (`source: "job"`,
     `isDefault: true`);
   - else the box default (`source: "box"`, `isDefault: true`).
   `modeFor` becomes `resolveMode(sid).mode`; `list()` reports `mode` and
   `modeIsDefault` from it. Every existing caller of `modeFor` therefore sees
   the job rule — see "Other callers" below.
2. **Agent `suggest` starts the handoff in an unattended session.**
   `entryPlan({ mode, trigger, action, unattended })` gains a boolean
   `unattended`. When `unattended && mode === "auto"`, an agent `suggest` is
   planned exactly like `action: "handoff"` (`produce: "start"`, `kind: "auto"`,
   `how: "clear"`, `disposition: "send"`). `create` passes
   `unattended: source === "job"`. With an explicit own `suggest`/`off` mode on
   the job, both actions stay cards as today (`source` is then `"own"`).
3. **Successor inheritance.** At commit, the successor inherits the
   predecessor's mode explicitly ONLY when it was not from the job rule
   (`source !== "job"`). A job successor is re-pointed by the commit and so is
   itself a manta-owned running job; it gets `auto` from the job rule while the
   job runs, and falls back to the box default once the job has finished (no
   stored `auto` outliving the job). An explicit own mode on a job is still
   inherited as today.
4. **A failed turn does not make a card in a job.** In `processRequested`, when
   the turn failed and the record's session resolves with `source === "job"`,
   the record is **cancelled** (no text generation, no card) and the job
   settles normally — the pending-send deferral clears exactly as for any
   failed handoff. Everywhere else a failed turn still drops the plan to a card.
5. **Stop / pause during a pending handoff.** Stopping or pausing a job cancels
   every pending `send` handoff record on its session (`requested`,
   `generating`, `starting` before the successor is created). In addition,
   the start re-checks `runningJobOwner(pred) === "manta"` immediately before
   creating the successor when the record was planned under the job rule, and
   cancels if not. A stopped/paused job is never moved onto a fresh successor.
6. **Running-time limit.** The delegate sweeper's 30-minute "timed out" rule
   does not time out a job while it has a pending `send` handoff
   (`hasPendingSend`); it re-evaluates after the handoff commits or fails.
   The limit itself is unchanged: a job re-pointed to a successor keeps its
   original start time.
7. **`maybeAuto` returns early** when `source === "job"` (the armed trigger
   never applies to a manta-owned job, §6.3) before doing any context
   measurement. The existing `mode === "auto" && isJobSession` skip stays for
   the other cases.
8. **Unchanged:** `/handoff` and the Hand off button are always cards; a
   dismissed session still refuses agent handoffs; adopted (opencode-owned)
   sessions keep today's rules.

### Other callers of the effective mode

Because `modeFor` now sees the job rule, two existing behaviours change for
manta-owned running jobs, intentionally:
- **The optimizer's handoff budget note** (`policyFor`, gated on mode ≠ `off`)
  now reaches jobs even when the box default is `off`. This is what lets the
  job's agent know it is near budget and call `handoff`; it is part of the fix.
- **Background compaction eligibility** now always skips running jobs (their
  mode is `auto`), where today it depended on the box default.

## Visible effects

- The job window's handoff toggle reads **Handoff: auto** (marked as the
  default) even when the box default is `suggest`/`off`; clicking it sets an
  explicit mode on that job, which then wins. A finished job's window may keep
  showing that until the client next fetches the handoff info (no push for a
  job finishing — accepted).
- **Tool reply.** The `handoff` tool picks its status line from the returned
  record, not the requested action: `kind === "auto"` → "Handoff queued — it
  happens when this turn ends. End your turn now."; otherwise "Handoff prompt
  ready below." This also fixes an existing mismatch (`action: "handoff"` in a
  `suggest`/`off` session told the agent "queued" though only a card was made).
- **Tool description** gains one sentence: in a background job the mode
  defaults to auto, both actions start the handoff, and the agent must end its
  turn right after calling it.

## Contract

- `GET /api/handoff?sessionId=<manta-owned running job, no own mode>` →
  `mode: "auto"`, `modeIsDefault: true`. No new fields.
- `POST /api/handoff {trigger:"agent", action:"suggest"}` on such a job →
  record with `kind: "auto"`, a start planned for the turn end.
- Engine internals pinned for the implementer: `resolveMode(sid)` as above;
  `entryPlan({..., unattended})`; delegate `runningJobOwner(sessionId)`;
  `isJobSession` derived from it.
- No wire field is added or removed; clients need no change.

## Libraries considered

None apply: this is a rule inside the box's own handoff engine (mode
resolution and the entry plan). No library models it.

## Tests

Box (`src/server/handoff/*.test.mjs`, `src/server/delegate*.test.mjs`):
- `resolveMode`: manta job + box default `suggest` → `auto/job`; same with
  `off`; manta job with own `off` → `off/own` and no job lookup made;
  opencode-owned adopted job → box default; non-job → box default; paused or
  finished job → box default; failed lookup → box default.
- `entryPlan`: unattended+auto+agent `suggest` → start/`send`; attended auto +
  agent `suggest` → card (unchanged); unattended with own `suggest` → card.
- End to end (engine test world): box default `suggest`, a manta job calls
  agent `suggest` → at turn end a successor starts, the job's settlement is
  deferred until commit, the job is re-pointed, and the successor has NO stored
  mode (still `auto` via the job rule). A second-link successor calling
  `suggest` also starts.
- Opencode-owned adopted session + agent `suggest` with box default `suggest` →
  a card (unchanged).
- Failed turn in a job → record cancelled, no card, job settles.
- Stop and pause during a pending handoff → record cancelled, no successor;
  job finished between turn end and start → no successor.
- Sweeper does not time out a job with a pending send.
- `list()` for a job → `mode: "auto"`, `modeIsDefault: true`.
- Optimizer budget note reaches a job with box default `off`; compaction
  eligibility skips a running job.
- **Changed existing test:** the trigger test asserting a job "suggest still
  offers a card" with box default `suggest` must now expect no record from the
  armed trigger (the job rule makes it `auto`, and the armed trigger never
  applies to jobs).

Plugin (`scripts/opencode-v2/handoff.test.mjs`): the status line follows the
record's `kind` — `kind: "auto"` → queued line for both actions;
`kind: "suggest"` → prompt-ready line for both. Update the existing "queued"
fake to carry `kind`.

## Deploy

Box-only (server + the manta V2 plugin, both shipped in the box release
tarball). No client release needed.

## Known, accepted

- CTO evidence links only the last successor's transcript of a job chain
  (existing behaviour, follow-up).
