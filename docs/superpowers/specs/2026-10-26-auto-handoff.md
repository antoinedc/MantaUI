# Auto-handoff — design

Status: approved for implementation (Astra review: no blockers, round 5) · Branch: `feat/auto-handoff`
Target runtime: opencode **V2** (box verified on 2.0.30; main already on V2).

Decisions taken with the user (2026-10-26):
- Default mode is **auto**.
- Automatic handoff applies to **all chats** (including ones with background
  jobs, schedules, webhooks, and background-job sessions themselves) — so
  successor routing and ownership continuity are in scope.
- Part A (pruning default) ships first as its own change (`feat/prune-default`).

## Problem

When a chat session gets long, the user manually asks for a handoff prompt,
clears, and pastes it. Today's automatic mechanisms (opencode overflow
compaction mid-task, the optimizer's idle compaction) summarise in place —
lossy and stacking.

## Evidence

Context rot (Chroma, 18 models) → absolute budget trigger. Handoff over
compaction (Amp). Structured sections win, artifacts must be system-recorded
(Factory). Durable state over summary (Anthropic long-running harness).
Tool-output clearing is the cheapest lever.

## Part A — pruning default (separate PR `feat/prune-default`)

Updater (before opencode restart) + installer: surgical comment-preserving edit
sets `compaction.prune: true` only if absent; marker `migrations.pruneDefault`;
never fatal.

---

## 1. Terminology

- **Handoff record** — durable server object for one handoff (§7).
- **Replacement** (`how: clear`) — the successor takes over the predecessor's
  window and conversation identity. A **replacement link** redirects delivery
  (§6). A predecessor has at most one replacement successor.
- **Branch** (`how: new-session`) — a new window in the same project; the
  original continues independently. An **ancestry link** is for navigation
  only; it never redirects. A session may have many branches.
- **Disposition** of a start:
  - `send` — handoff text is the successor's first turn (agent keeps working).
  - `armed` — successor created; handoff held as a **preamble** and delivered
    together with the successor's first admitted message (§5.4).
  - `draft` — successor created; handoff placed in its composer, unsent.
- **Admission** — the moment manta-server accepts a message for a session
  (user send, queued drain, delegate completion, schedule, webhook, peer).

## 2. Producing the handoff text

1. **Agent-authored** — `handoff` tool `body`. If any template heading is
   missing, the server regenerates via (2) after the turn completes, never
   inside the tool call.
2. **Server-generated** — `POST /api/session/{id}/generate {prompt}` (V2's
   session-scoped one-shot behind `/btw`). Verified live: uses full history,
   adds no message. Idle only; 120 s timeout; one retry; failure → record
   `failed` with reason.

Template: `## Goal · ## Current state · ## Decisions (and why) ·
## Dead ends tried · ## Next step · ## Open questions`. Optional user `goal`
steers it. **The record's `text` is canonical**; every card renders it.

### 2.1 Appended facts — `## Context from the previous session`

Each line labelled **observed** or **inferred**:
- observed: predecessor id + title; the agent may read that transcript on demand;
- observed: *files this session edited* (edit/write/patch tool parts);
- observed: *current worktree changes* (git status of the directory — may
  include changes not made by this session), branch;
- observed: todo list;
- inferred: standing instructions from the optimizer constraint store, with
  extraction time; re-extracted first if older than the last user message;
- observed test/build result only when a tool part's command matched a known
  runner, with exit status; otherwise omitted.

Cap ~6k tokens (facts truncated first, then body bottom-up). Pure function,
unit-tested.

## 3. The handoff card

Rendered for any record whose `fromSessionId` is the displayed session:
- Header: "Handoff prompt" · source · state badge (preparing / ready /
  starting / started → link / failed → reason + **Retry**).
- Body: `record.text` as markdown, collapsed after ~12 lines.
- Actions, enabled only in `ready`:
  1. **Copy** — raw markdown of `record.text`.
  2. **Clear & start** — replacement, `send`.
  3. **Start in new session** — branch, `send`, same model settings (§8);
     the initiating client switches to the branch.
  4. **Edit first** (desktop link; iOS context menu) — chooses replacement or
     branch, disposition `draft`.
- After a start, actions are disabled on every client.

**Carrier and identity:**
- Agent path: the `handoff` tool part (V2 `codemode: false`). Tool output is a
  short status line (`suggest`: "Handoff prompt ready below."; `handoff`:
  "Handoff queued — it happens when this turn ends. End your turn now.")
  followed by `<!-- manta-handoff:<id> -->`. Clients render the card from
  `GET /api/handoff/:id`; if the record is gone (retention), the card shows
  "This handoff has expired" with no actions.
- Server path: pinned card above the composer, from
  `GET /api/handoff?sessionId=`; never in model context.

## 4. When it fires

### 4.1 Entry points × mode

| Entry | auto | suggest | off |
|---|---|---|---|
| Automatic (turn end, over budget, §4.2) | replacement, `send` | `ready` card | — |
| Agent tool `action: handoff` | replacement, `send`, at turn end | `ready` card | `ready` card |
| Agent tool `action: suggest` | `ready` card | `ready` card | `ready` card |
| `/handoff [goal]`, "Hand off" button | `ready` card | `ready` card | `ready` card |
| Card actions | as pressed | as pressed | as pressed |

Manual and agent entries ignore budget and cooldown (the agent may hand off
below budget). The budget note (§4.4) is injected only when mode ≠ off.

### 4.2 Automatic trigger

At the end of a turn that **completed successfully** (not aborted, not errored,
not a drain-abort) while context > budget and outside cooldown (30 min after a
session's creation by a handoff): generate, then run the start (§5) as
replacement + `send`: the handoff is the successor's first message, so the
work continues without the user typing anything. (Revised 2026-10-28: this was
`armed` — held until the next message — and users in auto mode found they had
to nudge the new session. `armed` (§5.4) is kept only for records made before.)

Agent `action: handoff`: tool records `requested` and returns at once; when the
turn completes successfully → (regenerate if needed) → start as replacement +
`send`. Turn failed/aborted → record becomes a `ready` card instead.

### 4.3 Budget

min(family ceiling, 60% of window). Table: frontier (Opus, Sonnet, GPT-6
class) ≈ 200k; smaller/cheaper ≈ 100k; unknown → 60% of window. No setting.

### 4.4 Agent awareness (optimizer plugin, V2 `context` hook)

- Policy adds `{contextTokens, budget, measuredAt, handoffMode}` per session.
- Inject only if the policy is authoritative for this exact session (never the
  `lastAny` fallback, `docs/opencode-plugins-v2/manta-optimizer/lib/policy.ts`
  ~L72), `measuredAt` < 10 min, mode ≠ off.
- Threshold state per `(sessionID, budget)` in plugin memory: inject once when
  usage first reaches 70% and once at 90%; reset when usage falls below 50%
  (after a compaction). A plugin restart forgets state → at most one repeat.
- Generation exclusion: the plugin registers only `context` (not `generate`).
  **Implementation must verify** with a logging test that V2 does not run the
  `context` hook for `/session/{id}/generate`; if it does, the server passes a
  marker in the generate prompt and the plugin skips requests containing it.
- Placement: after the last message. Cache effect measured, not assumed.

### 4.5 Idle compaction

`handoffMode ≠ off` → the optimizer idle-compaction scheduler skips all
sessions (covered by §4.2). `off` → scheduler unchanged. `optimizerEnabled`
does not gate handoff. opencode's overflow compaction stays on.

## 5. Starting — the transition protocol

All per-session state changes run under one in-memory **per-session mutex**
(single server process). Every check-and-set that guards admission is
synchronous (no `await` between check and set).

### 5.1 Write-ahead identities

Before any side effect the record persists: `successorId` (caller-minted
`ses_…`, V2 create accepts `id`), `messageId` for a `send` (`msg_…`, required
prefix), and the branch window's temporary name `handoff-<recordId>` (windows
are found by that name or by their `@manta-session-id` stamp). Recovery
reconciles against these, so no step can create a duplicate.

### 5.2 Admission reservations

Every admission path, as its **first synchronous action** (before any `await`),
resolves its target (§6.1) and increments `reservations[target]`; it
decrements when `sendPrompt` settles (accepted, refused, or uncertain-then-
reconciled). Each accepted user admission also bumps an in-memory
`userRevision[target]`. Generation records the `userRevision` it started from.

### 5.3 Steps

The successor's id is known only to the server until commit, and no window
points at it until commit, so nothing can reach it early (the topology snapshot
never shows it). Steps 1–3 are reversible; from the first delivery POST
attempt in step 3 onwards the start only ever **recovers forward**.

1. **Fence (replacement only).** Synchronously, under the mutex: require
   `reservations[pred] == 0`, `userRevision[pred]` unchanged since generation
   began, and no other session operation (§6.2). Pass → install
   `fence = {successorId}`: from now on every admission to the predecessor is
   **held** in manta (persisted with its stable message id, not posted). Fail →
   abort auto-start, record → `ready` (`reason: "you kept working"`).
   Then the asynchronous checks: predecessor not active in V2 and its V2 inbox
   empty. Fail → remove fence, release held messages to the predecessor, abort
   as above.
2. **Create** the successor (skipped if `successorId` exists): same directory;
   model, variant, agent and **permissions** copied from the predecessor's V2
   session; `parentID` copied (a child conversation stays a child).
3. **Prepare delivery** (persisted on the successor's continuation, §7, before
   any effect):
   - `send`: persist `{messageId, payload}`, set `sendAttempted`, then post.
     Confirmed acceptance → continue. **Definitive refusal** → rollback
     (below). **Uncertain** → reconcile by id (inbox + history); absent from
     both → re-post the same id (idempotent) — never roll back.
   - `armed`: persist `{preamble}`.
   - `draft`: persist `{draft, draftRevision}`.
4. **Commit** (each sub-step idempotent, journaled; recovery re-runs it):
   a. attach — replacement: restamp the window to `successorId`; branch: create
      a window named `handoff-<recordId>`, stamp it, then rename it
      (recovery finds it by stamp OR by that temporary name and finishes the
      remaining sub-steps);
   b. write the link (replacement or ancestry) and re-point ownership (§6.3);
   c. record `committed`; publish the bus event. Replacement: the fence becomes
      the permanent replacement link.
5. **Release** held admissions in order to the successor (through §5.4 if
   armed; behind the accepted `send` turn otherwise). Each held admission is
   posted with its stable message id and removed from the journal only after
   confirmed acceptance (uncertain → reconcile as above).

**Rollback** (only steps 1–3, and in step 3 only before any `send` POST was
attempted or after a definitive refusal of the **first** POST): delete the
successor session, remove the fence, release held messages to the predecessor,
record `failed` with **Retry**. A refusal of a *re-post* after an uncertain
first POST does not prove the original was rejected — keep reconciling and
recover forward.

**Release failures:** a held admission definitively refused at release is
reported durably to its sender through the normal failure path, removed from
the journal, and the queue advances (no permanent retry).

**Ordering during commit and release:** from step 4 until the held queue is
empty, any new admission resolving to the successor joins the end of the held
queue instead of posting directly, so nothing overtakes a held message.

### 5.4 Armed preamble

Continuation state on the successor: `{preamble, claim?}`. Under the mutex, the
first admission (any kind — user, queued, delegate completion, schedule,
webhook, peer) claims it: persist `{claim: messageId, payload: preamble +
"\n\n---\n\n" + text}` with agent/skill mention offsets shifted by the prefix
length, then post. **While a claim is unconfirmed, every later admission to the
successor is held** behind it. Confirmed acceptance → clear `preamble`, release
held admissions plain. Uncertain → reconcile by id (inbox + history; absent =
inconclusive → re-post same id). Definitive refusal → that admission fails to
its sender through the normal failure path, the claim is dropped, and the next
held admission becomes the claimer.
UI copy: "Carried-over context — sent with the next message."

### 5.5 Recovery on boot

Reservations are in-memory and start at zero. Then, for every record:
- `generating` → `failed` (Retry).
- `starting`, no `send` POST attempted → resume from the first step whose
  effect is not observed (fence? successor exists? continuation persisted?), or
  roll back if that step cannot complete.
- `starting`, `send` POST attempted → reconcile the send (§5.3 step 3) and
  recover forward through commit.
- commit journaled but incomplete → finish the remaining commit sub-steps.
- `committed` with held admissions still journaled → drain them (step 5).
- armed claim present → reconcile as §5.4.

### 5.6 Idempotency

Start on a record not in `ready` → `409 already_started` with the record.
`failed` → `POST …/retry` regenerates if needed and returns it to `ready`.

## 6. Routing, exclusion, ownership

### 6.1 One resolver, at admission

`resolveAdmissionTarget(sessionId)` follows **replacement** links (never
ancestry) to the live end and returns `{target, fenced}`. It runs:
- in `promptDelivery.deliver` before the busy check (same spot as the
  existing conversation redirect, `src/server/promptDelivery.mjs` ~L120);
- in the client send RPC handler before `sendPrompt`;
- in every other `sendPrompt` caller.
`sendPrompt` itself (incl. `syncSessionControls`) only ever receives a resolved
id; busy tracking, receipts and errors are keyed by the resolved id and the
response carries `deliveredTo`. A source test (like `commandOrigins.test.mjs`)
fails if a `sendPrompt` call site does not go through the resolver. Fenced →
the message is held (§5.3 step 1).

### 6.2 One maintenance operation per session

In-memory registry: `handoff-generate`, `handoff-start`, `compaction`. Any
operation skips a session that has another. User admissions are never blocked
except by a fence.

### 6.3 Ownership continuity on commit (replacement only)

- Delegate jobs whose **parent** is the predecessor: parent re-pointed to the
  successor at commit. A job that settles before commit delivers its completion
  to the predecessor, where the fence holds it and releases it to the
  successor — no ordering issue.
- A **running background-job session** (the job's own session) is in scope
  like any chat, but its turn end IS the job's terminal completion signal, so:
  - server-initiated (armed) handoff never applies to it — the job settles
    normally;
  - an agent `action: handoff` inside a job registers the record synchronously
    in the tool call, i.e. before the turn ends. The delegate settler checks for
    a pending `send` handoff on the session before settling and, if one exists,
    **defers**; at commit the job's session id is re-pointed to the successor
    and the job keeps running there. If the handoff fails, the deferred
    settlement runs normally.
- Schedules and webhooks addressed to the predecessor: left as is; they resolve
  via §6.1 at fire time.
- Listings keyed by parent session (delegate_list, rail rows) include jobs of
  the whole replacement chain.

### 6.4 Client reconciliation

Clients learn from the bus event and from `GET /api/handoff?sessionId=` on load
and reconnect. On a committed **replacement**, a view showing the predecessor
switches to the successor; on a **branch**, only the initiating client switches.

## 7. Persistence

`~/.manta/handoffs.json` via `statePath`, atomic writes:
- **records** — prunable card history: terminal records older than 30 days /
  beyond 500, **except** records whose continuation is unconsumed.
- **links** — `{replacedBy?, replaces?, branchedFrom?, branches[]}` per session;
  kept while either end exists.
- **continuation** per successor — `{preamble?, claim?, draft?,
  draftRevision?, send?}`; never pruned while unconsumed. A draft is consumed
  when a client loads it into the composer and calls
  `POST /api/handoff/:id/draft-consumed {draftRevision}` (idempotent) — only
  after the client has persisted the draft in its own local composer storage, so
  a client crash cannot lose the only copy. Clients only load a draft whose
  revision is not yet consumed.
- **fences** and **held admissions** — persisted so recovery can release them.

## 8. Settings carried to the successor

- Server: model, variant, agent, permissions, parentID (§5.3 step 2).
- Client-side preferences (desktop `sessionChoice` incl. Auto routing, fast,
  saved plan toggle — `src/renderer/ChatPanel.tsx` ~L2139; iOS
  `ChatModelPrefs`): each client copies its own from predecessor to successor
  on learning of a commit (event or reconcile).
- Composer: if a client shows the predecessor when a replacement commits, its
  unsent text and already-uploaded attachment chips move to the successor's
  composer; uploads in flight finish into it. If the successor already has a
  `draft` (Edit first), the client's text is appended below it, never
  overwritten.

## 9. Mode control & predecessors

- Config `handoffMode` (`auto` default · `suggest` · `off`).
- Desktop: next to "Bypassing permissions"; click cycles; label
  "Handoff: auto".
- iOS: chat overflow sheet under "Trust mode", segmented control.
- Predecessors (replacement chain) have no window → not in the sidebar / iOS
  list. **Previous sessions** in the "…" menu (desktop top right, iOS overflow
  sheet) lists the chain plus branch origin ("Branched from …"), newest first.
  Opening one is read-only ("Back to current" bar replaces the composer).
  Deleting one is allowed; links keep its id; opening shows "deleted".
- Auto notice at the top of a successor: "Continued from <title> — handed off
  at 182k tokens · View previous".

## 10. iOS scope (this feature)

1. Card (tool part + pinned) with Copy (`UIPasteboard`, markdown), Clear &
   start, Start in new session, Edit first (context menu), state badge, Retry.
2. Carried-over context block in armed successors (server does the
   concatenation; the client sends normally).
3. Mode control in the overflow sheet.
4. Previous sessions + read-only view.
5. Continuation notice.
6. `/handoff`: add a `.handoff` kind to `ComposerTypeahead` and route it in
   `performSlash` (`ComposerView.swift` ~L1553) → `POST /api/handoff`.
7. Event + reconcile (§6.4), prefs copy and composer carry-over (§8).
Verified per `mobile/native/AGENTS.md` (Mac worker / CI).

## 11. Contracts

**Routes** (bearer auth; client-visible error bodies are safe literals per
AGENTS.md BET-1460; JSON `{error: code, message}`):
- `POST /api/handoff` `{sessionId, trigger: "user"|"button"|"agent",
  action: "suggest"|"handoff", goal?, body?}` → `200 {handoff}`.
- `GET /api/handoff?sessionId=` → `200 {records, links, continuation?}` (records
  where the session is `from` or `to`).
- `GET /api/handoff/:id` → `200 {handoff}` · `404 expired`.
- `POST /api/handoff/:id/start` `{how: "clear"|"new-session",
  disposition: "send"|"draft", text?}` → `200 {handoff}` ·
  `409 already_started {handoff}` · `409 busy` · `422 not_ready`.
- `POST /api/handoff/:id/retry` → `200 {handoff}`.
- `POST /api/handoff/:id/draft-consumed {draftRevision}` → `204`.

**Record** `{id, fromSessionId, successorId?, messageId?, kind: suggest|auto,
trigger, state: requested|generating|ready|starting|committed|failed|cancelled,
step?, how?, disposition?, text, reason?,  
createdAt, updatedAt}`.

**Bus** `{kind: "handoff", payload: {id, fromSessionId, successorId?, state,
how?, disposition?}}` on every change.

**Tool** `handoff` (`docs/opencode-plugins-v2/manta/tools/`, added to
`allTools`): `{action: "suggest"|"handoff", body: string, goal?: string}` →
status line + marker.

**Plugin policy** adds `{contextTokens, budget, measuredAt, handoffMode}`.

**Config** `handoffMode`, `migrations.pruneDefault`.

**Desktop slash** `/handoff [goal]` in ChatPanel's submit path next to
`/clear` (~L1258).

## 12. Ownership for implementation

1. Server (`src/server/**`): engine, store, routes, transition protocol,
   recovery, resolver + call-site test, ownership re-pointing, triggers, budget,
   facts, compaction interplay, policy fields.
2. Plugin + tool (`docs/opencode-plugins-v2/**`).
3. Desktop (`src/renderer/**`).
4. iOS (`mobile/native/**`).

## 13. Risks

- `generate` token accounting may bypass the usage ledger — measure; record
  explicitly if so.
- Auto replacement may still surprise: notice, Previous sessions, composer
  carry-over.

## 14. Verification

- Unit: entry × mode table; trigger (turn outcome × budget × cooldown);
  fence check-and-set is synchronous; held admissions released in order to the
  right target on commit and on rollback; resolver follows replacement links
  only; call-site test; armed claim exactly once under concurrent admissions,
  offsets shifted; recovery from every step boundary (simulated crash after each
  effect, before its persist); idempotent start under concurrency; retention
  keeps unconsumed continuations; facts assembly + labels + cap; plugin gating.
- Quality gate: probe-based eval over ≥30 past sessions, handoff vs compaction
  at the same cut; handoff must match or beat.
- Live, desktop + iOS: auto armed replacement; agent send replacement; suggest
  cards with all actions; Edit first; branch keeps model + Auto + plan; a
  delegate job finishing after a replacement lands in the successor; a message
  sent during a start is delivered to the successor; restart mid-start
  recovers; Previous sessions read-only.

## 15. Implementation addendum (pinned 2026-10-26, before parallel work)

**Client transport.** Desktop (`src/renderer/api/httpApi.ts` `rpc()`) and iOS
(`MantaAPIClient.call`) use `/rpc` channels, not REST. The server exposes the
§11 routes BOTH as REST (for the agent tool) and as rpc channels with the same
payloads/results, implemented once:

| rpc channel | REST equivalent | args (single object) |
|---|---|---|
| `handoff:create` | `POST /api/handoff` | `{sessionId, trigger, action, goal?, body?}` |
| `handoff:list` | `GET /api/handoff?sessionId=` | `{sessionId}` |
| `handoff:get` | `GET /api/handoff/:id` | `{id}` |
| `handoff:start` | `POST /api/handoff/:id/start` | `{id, how, disposition, text?}` |
| `handoff:retry` | `POST /api/handoff/:id/retry` | `{id}` |
| `handoff:draft-consumed` | `POST /api/handoff/:id/draft-consumed` | `{id, draftRevision}` |

rpc errors surface the same `{error, message}` codes (thrown with `code`).

**Bus.** Server publishes `{kind: "handoff", payload}` on the existing bus
(`/events`); desktop subscribes with `on("handoff", …)` in httpApi (new
`onHandoff` on the `Api` type); iOS matches `frame.kind == "handoff"`.

**Config.** `handoffMode` readable/writable through the existing `config:get` /
`config:update` channels; server default `"auto"`.

**Generate marker.** Every server `generate` prompt starts with the line
`<!-- manta-handoff-generate -->`. The optimizer plugin skips its budget note
for any request whose last user content contains that marker (belt-and-braces
for §4.4's generate exclusion).

**Tool marker.** Tool output ends with the line `<!-- manta-handoff:<id> -->`
(regex `<!-- manta-handoff:([A-Za-z0-9_-]+) -->`). Record ids: `hof_` + 20
base36 chars.

**Plugin policy fields.** The existing per-session policy response gains
`handoff: {contextTokens, budget, measuredAt, mode} | null` (null when unknown —
plugin injects nothing).

**Card placement.** Agent-path card renders inline as the `handoff` tool part;
server-path cards (records with no tool part, i.e. `trigger !== "agent"`) and
`failed`/`ready` server records render pinned above the composer.

**Seam pins (added after iOS landed):**
- `handoff:list` / `GET /api/handoff?sessionId=` returns `links` as the object
  for the REQUESTED session only: `{replacedBy?, replaces?, branchedFrom?,
  branches: []}` — not a map keyed by session id — plus `chain: {predecessors:
  [{id, title?, deleted?}]}` (newest first) for Previous sessions.
- Record gains `contextTokens?: number` (context size of the predecessor when
  the handoff was created) — used by the continuation notice.
- rpc/REST error codes are exactly: `already_started`, `busy`, `not_ready`,
  `expired`, `not_found`, `generation_failed`, `invalid`.
