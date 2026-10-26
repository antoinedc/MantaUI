# Auto-handoff — design

Status: draft v3 (Astra review round 1 addressed) · Branch: `feat/auto-handoff`
Target runtime: opencode **V2** (box verified on 2.0.30; main already on V2).

Decisions taken with the user (2026-10-26):
- Default mode is **auto**.
- Automatic handoff applies to **all chats**, including ones with background
  jobs, schedules or webhooks — so successor routing (Part G) is in scope.
- Part A (pruning default) ships first as its own change (`feat/prune-default`).

## Problem

When a chat session gets long, the user manually asks "give me a handoff prompt
to keep going in a fresh session", clears, and pastes it. The only automatic
mechanisms today are opencode's own auto-compaction (fires mid-task on overflow)
and the optimizer's idle background compaction. Both summarise in place: lossy,
and they stack summary on summary.

## Evidence

- **Context rot** (Chroma, 18 models): quality degrades with input length well
  before the window is full → trigger on an absolute budget.
- **Handoff beats compaction** (Amp, Oct 2025): goal-directed extraction into a
  fresh thread, editable draft.
- **Structured > free-form** (Factory, 36k messages): fixed sections win;
  artifact recall is the weakest dimension → the system records artifacts.
- **Durable state > summary** (Anthropic long-running harness).
- **Tool-output clearing** is the cheapest lever (`compaction.prune`).

## Part A — pruning default (separate PR, `feat/prune-default`)

One-time migration in the updater (before opencode restarts) and installer:
surgical comment-preserving edit sets `compaction.prune: true` only if absent;
marker `migrations.pruneDefault` in the box state config; never fatal.

## Part B — terminology and lifecycle

- **Handoff record** — the server's durable object for one handoff (B5).
- **Predecessor / successor** — the old session and the session that continues
  it. A successor can itself be handed off (a chain).
- **Card** — the UI rendering of a handoff record in the predecessor's
  transcript (B3).
- **Start** — creating the successor and attaching the handoff to it.
  - **send** start: the handoff is sent as the successor's first turn (the agent
    keeps working immediately).
  - **armed** start: the successor is created and the handoff is shown in it as
    a "Carried-over context" block; nothing runs until the user sends their next
    message, which is delivered as `handoff + user message` in one turn.
- **How**: `clear` (successor replaces the predecessor in the same window) or
  `new-session` (successor gets a new window in the same project; predecessor
  untouched).

## Part B1 — producing the handoff text

Two producers, one template, same appended facts (B2):

1. **Agent-authored** — the `handoff` tool's `body` argument. No extra model
   call. The server checks the six template headings; if any is missing it
   regenerates via (2) **after** the turn completes (never inside the tool call).
2. **Server-generated** — `POST /api/session/{id}/generate {prompt}` (V2's
   session-scoped one-shot, the call behind `/btw`). Verified live: uses the
   session's full history and adds no message. Only while the session is idle.
   Timeout 120 s; one retry; on failure the record goes `failed` with a reason
   shown on the card.

Template headings: `## Goal · ## Current state · ## Decisions (and why) ·
## Dead ends tried · ## Next step · ## Open questions`. `## Next step` may be
exactly `None — waiting for the user.` (used by C, see there). An optional user
`goal` steers generation.

## Part B2 — appended facts

Section `## Context from the previous session`, each line labelled
**observed** (read from a system source) or **inferred** (model-derived):
- observed: predecessor session id + title, and a line saying the agent may read
  that transcript on demand;
- observed: files changed — union of edit/write/patch tool parts AND the
  directory's current uncommitted changes (covers shell edits); truncated to 40
  paths with a count;
- observed: branch + one-line uncommitted summary;
- observed: todo list (status + text);
- inferred: standing instructions from the optimizer constraint store, labelled
  with their extraction time; re-extracted first if older than the last user
  message;
- no build/test claims unless a tool part's command matched a known test/build
  runner, then labelled observed with exit status.

Whole prompt capped at ~6k tokens (facts truncated first, then body sections
trimmed from the bottom). Assembly is a pure function, unit-tested.

## Part B3 — the handoff card

Shown in the predecessor's transcript whenever a record is in `ready`
(suggestion) or later state:
- Header: "Handoff prompt" · source (agent / you / context budget at N tokens) ·
  state badge (ready / starting / started → link / failed → reason + Retry).
- Body: markdown, collapsed after ~12 lines ("Show all").
- Buttons (enabled only in `ready`):
  1. **Copy** — raw markdown (the visible prompt, without any internal marker).
  2. **Clear & start** — `how: clear`, send start.
  3. **Start in new session** — `how: new-session`, send start, same model
     settings (Part F), switches the view to it. Predecessor untouched.
  4. Secondary action **Edit first** (desktop: small link; iOS: long-press /
     context menu) — asks which (Clear / New session), creates the successor
     with the text as an unsent **composer draft** instead of sending
     (`disposition: draft`).
- Once started, all start actions are disabled on every client.

**Carrier and identity (survives reload, every client):**
- Agent path: the `handoff` tool part (registered with `codemode: false` like
  all Manta tools, so it is a tool part named `handoff`). The tool's output is
  the final markdown followed by a last line `<!-- manta-handoff:<id> -->`.
  Clients parse the id from that line, strip it for display and copy, and fetch
  live state from `GET /api/handoff/<id>`.
- Server-generated path: no transcript part. The card is pinned above the
  composer (same slot as other session cards), driven by
  `GET /api/handoff?sessionId=` (returns ALL records for the session with
  state). It is never added to the model's context.

## Part B4 — starting, durably

Single server process ⇒ an in-memory per-session mutex plus persisted record
states is sufficient. Record states:

`requested → generating → ready → starting → committed` (terminal), or
`failed` / `superseded` / `cancelled` (terminal).

`starting` sub-steps, each persisted before the next:
1. `dest_created` — successor session created (V2 create, same directory),
   model + variant + agent copied server-side from the predecessor's V2 session
   (they live on the session in V2).
2. `delivered` — send: prompt posted to the successor with a **stable message
   id** derived from the record id (so a retry cannot double-send); armed /
   draft: preamble stored on the record, nothing posted.
3. `attached` — `clear`: window restamped to the successor; `new-session`: new
   chat window created stamped to the successor.
4. `committed` — linkage written (B5), bus event published.

**Recovery on server boot:** any record in `generating` → `failed`
("interrupted, retry"); any in `starting` resumes from its last persisted
sub-step (creation is skipped if `dest` exists; delivery is skipped if the
stable message id is already in the successor). **Idempotency:** a start on a
record not in `ready` returns `already_started` with the record. Two clients
pressing at once: the mutex makes one win; the other gets `already_started`.

## Part B5 — persistence

`~/.manta/handoffs.json` via `statePath`, atomic writes:
- records `{id, fromSessionId, toSessionId?, kind: suggest|auto, trigger,
  state, step?, how?, disposition?, text, reason?, createdAt, updatedAt}`;
- linkage `{sessionId → {predecessorId?, successorId?}}`.
Retention: terminal records 30 days / 500 max; linkage for any session that
still exists is kept.

## Part C — when it fires (automatic, `handoffMode: auto`)

Two automatic paths; both need the session **over budget** and a turn that
**completed successfully** (not aborted, not errored, not a drain-abort).

**C1. Agent-initiated (agent intends to keep working).** The agent calls
`handoff` with `action: "handoff"`. The tool records the request and returns
immediately ("Handoff queued; it happens when this turn ends — end your turn
now."). When the turn completes: validate/regenerate (B1), then **send start,
how: clear**. If the turn fails or is aborted: no switch; the record becomes a
`ready` card instead.

**C2. Server-initiated (turn ended, control is back with the user).** At the
end of a successful turn over budget, the server generates the handoff and does
an **armed start, how: clear**. Nothing runs in the successor until the user
speaks — so auto mode never invents work. The user sees the successor with a
"Carried-over context" block and the notice "Continued from <title> — handed off
at 182k tokens · View previous".

**Commit re-check (both paths), immediately before step 1 of starting:**
session not busy; no user message arrived since generation began (last user
message id unchanged); the session's V2 inbox has no pending items; no other
session operation in flight (G2). If any fails → abort the auto start and leave
the record as a `ready` card (`reason: "you kept working"`).

**Budget** = min(family ceiling, 60% of the model's context window). One table:
frontier (Opus, Sonnet, GPT-6 class) ≈ 200k; smaller/cheaper ≈ 100k; unknown →
60% of window. No user setting.

**Cooldown:** no automatic handoff for a session within 30 min of its creation
by a handoff (prevents ping-pong if the successor is already large).

**Agent awareness.** The optimizer plugin (V2 `context` hook) gets
`{contextTokens, budget, measuredAt}` in its per-session policy. It injects a
note **only** when the policy is authoritative for that exact session (never
the `lastAny` fallback — `docs/opencode-plugins-v2/manta-optimizer/lib/policy.ts`
~L72) and `measuredAt` is < 10 min old, only when usage first crosses 70% and
90% of budget (not every turn), only when mode ≠ off, and never in the
`generate` hook. The note goes after the last message: "Context: 148k of a 200k
working budget. When you reach a natural stopping point and intend to keep
working, call `handoff` with action `handoff`; if you're done, just finish."
Cache effect is measured during implementation (cache read/write on the next
turn), not assumed.

**Idle background compaction.** When `handoffMode ≠ off`, the optimizer's idle
compaction scheduler does not compact; sessions it would have compacted are
already covered by C2 at their last turn end. When `handoffMode = off`, the
scheduler behaves exactly as today. `optimizerEnabled` does not gate handoff.

opencode's own overflow auto-compaction stays on as the mid-turn safety net.

## Part D — entry points × mode

| Entry | auto | suggest | off |
|---|---|---|---|
| Automatic C2 (turn end, over budget) | armed start, clear | `ready` card | — |
| Agent tool `action: handoff` (C1) | send start, clear at turn end | `ready` card | `ready` card |
| Agent tool `action: suggest` | `ready` card | `ready` card | `ready` card |
| `/handoff [goal]` or "Hand off" button | `ready` card | `ready` card | `ready` card |
| Card buttons | as pressed | as pressed | as pressed |

Manual entries ignore the budget and cooldown. The budget note is not injected
in `off`.

**Mode control:** box config `handoffMode`, default `auto`.
- Desktop: next to "Bypassing permissions"; click cycles auto → suggest → off;
  label "Handoff: auto".
- iOS: chat overflow sheet, under "Trust mode", three-way segmented control.

## Part E — predecessors

- After a `clear` start the predecessor has no window, so it already disappears
  from the desktop sidebar and the iOS session list. Nothing is deleted.
- **Previous sessions** in the session "…" menu (desktop top right; iOS chat
  overflow sheet) lists the predecessor chain, newest first. Opening one shows
  it read-only in the same pane with a "Back to current" bar (composer replaced
  by the bar — no send possible).
- Deleting a predecessor from that list is allowed; linkage keeps the id and
  the successor's facts line still names it; opening it then shows "deleted".

## Part F — settings carried to the successor

- **Server-side (V2 session):** model, variant/effort, agent — copied in B4
  step 1. This covers plan mode where it is expressed as the session agent.
- **Client-side preferences** (desktop per-session `sessionChoice` incl. Auto
  routing, fast toggle, saved plan toggle — `src/renderer/ChatPanel.tsx`
  ~L2139; iOS `ChatModelPrefs`): each client copies its own local preferences
  from predecessor id to successor id when it learns of a committed handoff
  (bus event or reconcile, G3). No server-side copy of client state.
- Unsent composer draft: if a client is displaying the predecessor when the
  switch commits, its current composer text moves to the successor's composer
  (never dropped).

## Part G — routing, exclusion, reconciliation

**G1. Successor routing (all chats).** `postPrompt` (`src/server/opencode.mjs`,
the single prompt chokepoint) resolves the target through the linkage: a prompt
addressed to a session with a committed successor goes to the end of the chain,
and the response says so (`redirectedTo`). This covers queued deliveries, delegate
completion notices, schedules, webhooks and peer messages without touching each.
Readers that look a session up by parent id (delegate `delegate_list`, background
job rail rows) treat the chain as one conversation (query predecessors too).
Background jobs keep running; their completion lands in the successor.

**G2. One operation per session.** A shared per-session operation registry
(server-side, in-memory) with kinds `handoff-generate`, `handoff-start`,
`compaction`. A session in any operation is skipped by the others. User prompts
are never blocked by it — instead the commit re-check (C) aborts an auto start
if the user acted.

**G3. Client reconciliation.** Clients learn of handoffs from the `handoff` bus
event AND from `GET /api/handoff?sessionId=` on load / reconnect for every
session they display. On a committed handoff a client switches its view **only
if** it is currently showing the predecessor; other views just refresh lists.

## Part H — iOS scope (ships in this feature)

1. Render the card for `handoff` tool parts and pinned server cards: Copy
   (`UIPasteboard`, markdown), Clear & start, Start in new session, Edit first
   (context menu), state badge.
2. Render the "Carried-over context" block in a successor and send
   `handoff + text` for the first user message of an armed successor (the
   server does the concatenation — the client just sends normally; see
   contract).
3. Mode control in the overflow sheet.
4. Previous sessions in the overflow sheet; read-only view.
5. Continuation notice.
6. `/handoff` in the slash palette: add a `.handoff` kind to
   `ComposerTypeahead` and route it in `performSlash`
   (`ComposerView.swift` ~L1553) to `POST /api/handoff`.
7. Bus event + reconcile handling (G3) and local prefs copy (F).
iOS is verified per `mobile/native/AGENTS.md` (Mac worker / CI build).

## Contracts (pin before parallel work)

**Server routes** (bearer-auth, class-2 error bodies are fine for the tool,
class-1 safe literals for anything a client shows — see AGENTS.md BET-1460):
- `POST /api/handoff` — create a record.
  `{sessionId, trigger: "user"|"button"|"agent", action: "suggest"|"handoff",
  goal?, body?}` → `200 {handoff: Record}`. Agent `handoff` action returns
  immediately with state `requested`.
- `GET /api/handoff?sessionId=` → `200 {records: Record[], chain:
  {predecessors: [{id,title,deleted}], successor?: id}}`.
- `GET /api/handoff/:id` → `200 {handoff: Record}` / `404`.
- `POST /api/handoff/:id/start` `{how: "clear"|"new-session", disposition:
  "send"|"draft", text?}` (`text` = edited prompt) → `200 {handoff: Record}`;
  `409 already_started {handoff}`; `409 busy`; `422 not_ready`.
- `POST /api/handoff/:id/retry` → regenerates a `failed` record.
- Errors are JSON `{error: code, message}`.

**Record** `{id, fromSessionId, toSessionId?, kind, trigger, state, step?,
how?, disposition?, text, reason?, armed: boolean, createdAt, updatedAt}`.

**Armed successor:** the server holds the preamble; the first prompt to that
session through `postPrompt` is sent as `preamble + "\n\n---\n\n" + user text`,
then `armed` clears. Clients render the preamble from the record (successor's
`GET /api/handoff?sessionId=` returns the record with `toSessionId` = it).

**Bus event** `{kind: "handoff", payload: {id, fromSessionId, toSessionId?,
state, how?, disposition?}}` on every state change.

**Agent tool** `handoff` (V2 registration:
`docs/opencode-plugins-v2/manta/tools/` + `tools/index.ts` `allTools`):
`{action: "suggest"|"handoff", body: string, goal?: string}` → markdown +
marker line (B3).

**Plugin policy** adds `{contextTokens, budget, measuredAt, handoffMode}`.

**Config keys:** `handoffMode` (`auto`|`suggest`|`off`, default `auto`),
`migrations.pruneDefault`.

**Desktop slash:** `/handoff [goal]` intercepted in ChatPanel's submit path next
to `/clear` (~L1258) → `POST /api/handoff`.

## Ownership for implementation

1. Server: engine, routes, store, recovery, G1/G2, C triggers, compaction
   interplay, budget table, facts assembly. (`src/server/**`)
2. Plugin + tool: optimizer policy note, `handoff` tool.
   (`docs/opencode-plugins-v2/**`)
3. Desktop: card, carried-over block, mode control, Previous sessions,
   `/handoff`, event/reconcile, prefs copy. (`src/renderer/**`)
4. iOS: Part H. (`mobile/native/**`)

## Risks

- Token accounting of `generate`: measure whether it reaches the usage ledger;
  if not, record it explicitly.
- Auto armed-switch still surprises some users: visible notice, Previous
  sessions, and the composer draft carry-over mitigate.

## Verification

- Unit: trigger decision (over budget × turn outcome × re-check × cooldown ×
  mode), entry×mode table, budget table, facts assembly + cap + labels, template
  check, state machine incl. recovery from every step, idempotent start under
  concurrency, chain redirect in `postPrompt`, armed first-prompt concatenation,
  plugin note gating (authoritative + fresh + thresholds + mode).
- Quality gate: probe-based eval (Factory method) over ≥30 past sessions:
  handoff vs opencode compaction at the same cut; handoff must match or beat.
- Live, desktop + iOS: C1 send-start, C2 armed-start, suggest cards with all
  buttons, Edit first, Start in new session keeps model + Auto + plan, a
  delegate job finishing after a handoff lands in the successor, server restart
  mid-start recovers, Previous sessions read-only.
