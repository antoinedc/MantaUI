# Background jobs hand off on their own

Status: draft, 2026-10-29. Builds on `2026-10-26-auto-handoff.md` (§4, §6.3) and
`2026-10-27-handoff-card-inline-dismiss-per-session-mode.md` (per-session mode).

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

## Decision

For a session that is a **running background job**:

1. **Default mode is `auto`.** The effective mode is the session's OWN mode if
   one was set explicitly (the per-session toggle in the job's window, or a mode
   inherited at a previous handoff commit), otherwise `auto` — the box default
   is not consulted. Every other session keeps today's rule (own mode, else box
   default).
2. **`suggest` from the agent starts the handoff too** when the effective mode is
   `auto`. In a job nobody can act on a card, so an agent `suggest` is planned
   exactly like `action: "handoff"` (`produce: "start"`, `kind: "auto"`,
   `how: "clear"`, `disposition: "send"`). With an explicit `suggest`/`off` mode
   on the job, both actions stay cards as today.
3. **Unchanged:** the server-initiated (armed) automatic trigger still never
   applies to a job (auto-handoff §6.3 — a job's turn end is its completion
   signal); `/handoff` and the Hand off button are always cards; a dismissed
   session still refuses agent handoffs; the delegate settler's deferral of a
   pending `send` handoff (§6.3) is what keeps the job running through the
   handoff, and it now covers a promoted `suggest` because that is a `send` too.
4. **Successor.** At commit the successor inherits the predecessor's effective
   mode explicitly (existing behaviour). For a job that is `auto` unless the job
   had an explicit mode, so the job keeps handing off on its own across a chain.

"Running background job" is the existing predicate the handoff wiring already
uses (`isJobSession` → the delegate engine's running-job lookup by the job's own
session id). Backgrounded `task` subagents are out of scope: their parent waits
on the original child session, so a replacement would need result re-routing.

## Visible effects

- The job window's handoff toggle reads **Handoff: auto** (marked as the
  default) even when the box default is `suggest`/`off`; clicking it sets an
  explicit mode on that job, which then wins.
- The `handoff` tool's reply must match what the box actually did. Today it
  picks its line from the requested action. It must instead pick it from the
  returned record: `kind === "auto"` (a start is planned) → the "Handoff queued
  … End your turn now." line; otherwise the "Handoff prompt ready below." line.
  This also fixes an existing mismatch: `action: "handoff"` in a `suggest`/`off`
  session today tells the agent "queued" although only a card was made.
- Tool description: one added sentence — in a background job the mode defaults
  to auto and `suggest` starts the handoff as well.

## Contract

- `GET /api/handoff?sessionId=<job>` → `mode: "auto"`, `modeIsDefault: true`
  for a running job with no own mode. No new fields.
- `POST /api/handoff {trigger:"agent", action:"suggest"}` on such a job →
  record with `kind: "auto"` and a start planned for the turn end.
- No wire field is added or removed; clients need no change.

## Libraries considered

None apply: this is a rule inside the box's own handoff engine (mode
resolution and the entry plan). No library models it.

## Tests (box)

- Effective mode: running job + box default `suggest` → `auto`; same with
  `off` → `auto`; job with explicit `off` → `off`; non-job session → box
  default; a job that is no longer running → box default.
- Entry plan: job (auto) + agent `suggest` → start/`send`; job with explicit
  `suggest` + agent `suggest` → card; non-job auto session + agent `suggest` →
  card (unchanged).
- End to end in the engine test world: box default `suggest`, a running job
  calls agent `suggest` → at turn end a successor is started, the job's
  settlement is deferred (`hasPendingSend` true before commit) and the job is
  re-pointed to the successor; the successor's stored mode is `auto`.
- Armed trigger still skipped for a job (existing test keeps passing).
- Tool (`docs/opencode-plugins-v2/manta/tools/handoff.ts`): status line chosen
  from the record's `kind`, with a test if the plugin has a test harness;
  otherwise covered by reading.

## Deploy

Box-only (server + the manta V2 plugin, both shipped in the box release
tarball). No client release needed.
