# OpenCode V2 — next: pending messages, background commands, background jobs on V2, typed client

Status: **draft 2026-10-23** · Base: `origin/main` @ `beb66c34` (after #1608) · opencode pinned **2.0.30**
Builds on `docs/superpowers/specs/2026-10-23-opencode-v2-cleanup.md` (the "cleanup spec": K1–K7, the
`inbox` frame, the command-origin correlator). Read that first.

Four stages, each its own PR, merged in order **A → B → C → D**. A stage may start before the previous
one merges only where §8 says so.

| Stage | What the user gets |
|---|---|
| **A** Pending messages | The pending-message card from the approved mockup: **Now** vs **After this turn**, ⌥Enter, Send now / Wait / ×, ↑ edit last, clear Stop behaviour — on desktop and iOS |
| **B** Background slash commands | A valid slash command is highlighted in the primary colour; a **Run in background** box appears for it; background runs (ours and V2-native) get a sidebar row and a result card; the agent replies to the result automatically |
| **C** Background jobs on V2 | Every Manta background job becomes a real V2 child session (moved into its worktree), finishing through V2's own result message — one sidebar rule, one result card, one completion path |
| **D** Typed client | manta-server's request/response calls to opencode go through the official `@opencode/client` pinned to the binary's version, type-checked |

Approved mockups (the visual source of truth for A and B; they are the target design, not "inspiration"):
- A: `https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com/pages/pending-messages-mockup`
- B: `https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com/pages/bg-commands-mockup`
Both are committed next to this spec as `docs/superpowers/specs/2026-10-23-opencode-v2-next/pending-messages-mockup.html`
and `.../bg-commands-mockup.html` (the served pages expire; the committed files don't).

Product decisions already taken by the owner (do not re-open):
- D-A1 **Enter sends into the running turn** ("Now", V2 `steer`); **⌥Enter keeps it for after this turn** (V2 `queue`).
- D-A2 **No reordering** of pending messages.
- D-A3 The mockup's card design **replaces** today's "⏳ queued" ambient card.
- D-B1 A finished background run **makes the agent reply automatically** (V2's native behaviour).
- D-C1 Manta keeps its job manager (worktree/branch, caps, timeout, pause/resume, model whitelist,
  permission preflight, CTO hooks); **V2 becomes the engine underneath**.

---

## 0. Facts this spec relies on (verified on 2.0.30 unless marked)

| # | Fact | Evidence |
|---|---|---|
| F1 | `POST /api/session/{id}/prompt` and `/command` take `delivery: "steer" \| "queue"`; `PATCH /api/session/{id}/inbox/{inboxID} {delivery}` changes a pending item (204, emits `session.inbox.delivery.changed`); "Steering wakes session execution" | OpenAPI `/tmp/opencode/v2openapi.json` (re-download from `https://opencode.ai/v2/openapi.json` if missing); `docs/opencode-v2/spikes/round1-b.md` B2 |
| F2 | A real model reads a `steer` message at the next step after the running tool finishes and follows it | live probe 2026-10-23 (sonnet-5-5, throwaway session); CTO fact |
| F3 | `interrupt?resume=true` runs pending **steer** items as the next turn and keeps **queue** items parked | cleanup-spec smoke (c) |
| F4 | A command defined with `subagent: true` **in the native `commands` key** (or a `.md` command file — unverified) runs in a child session. The V1 `command` key's `subagent` field is ignored (ran in the foreground) | sandbox probe 2026-10-23 |
| F5 | For such a command: the parent gets **no** user message and **no** tool part; a child session is created (`session.created` with `data.parentID`); when the child finishes, the parent gets a `synthetic` inbox item with `payload.metadata = {source:"subagent", childID, agent, state:"completed"\|…}` and text `<subagent sessionID="…" state="…">…</subagent>`, which **starts a new parent execution** (the agent replies) | sandbox probe 2026-10-23 |
| F6 | The command route has **no per-call background switch**; Command.Info is `{name, description}` only | OpenAPI |
| F7 | `POST /api/session {parentID}` creates a linked child **always at the parent's location** (a `location` in the body is ignored); `POST /api/session/{id}/move {directory}` then moves it — the parent link survives | sandbox probe 2026-10-23 |
| F8 | `POST /api/session` also accepts `agent`, `model`, `title`, `metadata`, `permissions` (ruleset) | OpenAPI |
| F9 | `POST /api/session/{id}/synthetic {text, description?, metadata, delivery?, resume?}` durably admits synthetic input and schedules execution unless `resume:false` | OpenAPI |
| F10 | `mapTimeline` (`src/shared/opencodeV2.mjs`) **drops** `synthetic` records — background results (incl. today's background `task` subagents) are invisible in the transcript | code |
| F11 | Background `task` subagents are adopted into the sidebar from a `task` tool part with `background:true` (`delegate.mjs` `observeEvent` → `adoptSubagentJob`, creates a window + job record) | code |
| F12 | `session.created` carries `data.parentID` for children | `src/server/fixtures/opencodeV2Events/04-task-subagent.jsonl` |
| F13 | `@opencode/client@2.0.30` exists (deps `@opencode/schema`, `@opencode/protocol` 2.0.30; `effect`/`solid-js` are optional peers; the Promise entry needs neither); its event subscription has **no replay and no reconnect** | npm; client docs |

Facts **not yet verified** — each stage's smoke must prove or refute them before relying on them (if refuted:
stop and report, do not work around silently):
- U1 A `queue` synthetic posted while the parent runs waits for the turn to end and then starts its own turn;
  posted to an idle (or stopped) parent it starts a turn at once.
- U2 A `synthetic` posted twice with the same explicit `id` is admitted once (idempotent, like prompts).
- U3 A child moved with `/move` runs its tools (shell `pwd`) inside the new directory.
- U4 `PATCH …/inbox/{id} {delivery:"steer"}` on a parked `queue` item of an **idle** session starts a turn.
- U5 A `.md` command with `subagent: true` frontmatter behaves like F4/F5.

---

## 1. Pinned contracts (all stages code against these, not against each other's code)

**N1 — delivery change RPC (A).** `opencode:inbox-set-delivery` `({ sessionId, id, delivery: "steer"|"queue" })` →
`{ outcome: "changed" | "delivered" | "unknown" }`. Decided from authoritative evidence only, like K4:
`changed` iff the interpreter observes `session.inbox.delivery.changed` for that id with that delivery
(wait ≤ 3 s after the PATCH); `delivered` iff it observes `.delivered` or the message exists; else `unknown`.
Refused for CTO conversation sessions (same error as K4). `Api.opencodeInboxSetDelivery(input)`.

**N2 — background run input (B).** `opencode:run-command` input gains `background?: boolean`.
`Api.opencodeRunCommand` input type gains the field. `background:true` is refused (clear error) for CTO
conversation sessions and for names that are not an opencode command or skill. For a command N3 marks
`background: true`, the server **ignores** `background` and runs it on the parent — V2 makes the child
itself (F4/F5); wrapping it again would create two children. For such a command the server **never syncs
the parent's controls** (no `syncSessionControls` call, the parent's agent/model stay exactly as they are,
even mid-turn): the child's agent/model come from the command definition, else V2's own inheritance; the
composer's picker does not apply to always-background commands (stated in the box's disabled title). For
a wrapped run (§B-server 3) the resolved composer `model`/`agent` in the input are the child's controls,
unless the command definition sets its own (V2 applies a command's own `agent`/`model` over them).

**N3 — command list (B).** `OpencodeCommand` gains `background?: true` — set only when manta-server can
prove the definition runs in the background (§B3); absent means "unknown / foreground".

**N4 — background result on the message model (B).** `mapTimeline` maps a `synthetic` record whose
`metadata.source === "subagent"` to a message in the existing `{info, parts}` shape:
```
info:  { id, role: "assistant", sessionID, time:{created}, background: true }
parts: [{ id: `${id}:bg`, type: "background-result",
          childSessionId, jobId?: string /* metadata.manta.jobId when Manta posted it */,
          state: "completed"|"failed"|"cancelled"|string,
          name?: string /* "/review HEAD~1" for command runs */, agent?: string,
          text /* inner text of the <subagent> envelope */ }]
```
Other synthetic records stay dropped. The iOS client must keep decoding transcripts that contain this
(the implementer must confirm in `mobile/native` that an unknown part type and the extra `info.background`
field are skipped, and add a decode test); iOS rendering of the card is a follow-up, not this spec.

**N5 — running background work, shown from the job store (B).** There is NO start-marker message (a
synthetic posted into a busy parent could be consumed by its running turn). A running background run is
shown from the job store, which is durable and reaches every client: the renderer lists jobs with
`parentSessionID === this session` whose `status` is `running`/`paused` (existing `delegateList` /
job-ownership data) as **running cards** under the transcript — "Running in background: /review HEAD~1 ·
Open session" — and replaces each with its N4 result card once one arrives, **paired by `jobId`** (falling
back to `childSessionId` for opencode-owned children). A job that fails before its child ran turns its
running card into a failure card with the error (never a card that spins forever).

**N6 — job record fields (B, C).** Keep today's `origin` values (`"delegate"`, `"subagent"`, …) and the
`actor` field (`"cto"` marks CTO-dispatched jobs — `delegate.mjs` ~1121, `ctoWorkTools.mjs` ~2423). Add:
- `origin: "command"` — a background slash command (Manta-wrapped or V2-native);
- `engine: "v2" | "legacy"` — absent = legacy (C);
- `completionOwner: "manta" | "opencode"` — who reports the result to the parent. `"opencode"` for
  children V2 started and reports itself (background `task` subagents, V2-native background commands): Manta
  NEVER posts a result for them (it only tracks the row). `"manta"` for children Manta started (wrapped
  command runs, delegate jobs on V2): Manta posts exactly one N7 result. Exactly one result and one parent
  reply per job is a tested invariant.
- `attempt` (C): the resume counter; `childSessionID` may change across attempts, `jobId` never does.

**N7 — job result delivery (B for wrapped command runs, C for delegate jobs).** A finished
`completionOwner:"manta"` job is reported to its parent by
`POST /api/session/{parent}/synthetic` `{ id: job.completionMessageId, text: buildCompletionText(job),
description: job.name, metadata: { source: "subagent", childID: job.childSessionID, agent: job.agent ?? null,
state, manta: { jobId: job.id } }, delivery: "queue", resume: true }`.
- **One policy from B onward:** `delivery:"queue"` — never steers a running parent turn (today's
  defer-until-idle behaviour); delivered when the parent's turn ends, or at once when the parent is idle
  or stopped (U1); the agent then replies (D-B1).
- **Retry-safe:** `completionMessageId` (`msg_…`, minted once) and `completionDelivery:
  "pending"|"delivered"` are persisted **in the same write** that makes the job terminal. Delivery runs
  after that write and is retried (boot reconcile + the existing sweeper tick) until `delivered`; the
  explicit `id` makes a retry after an uncertain POST harmless (U2). A terminal transition never re-runs.
- **CTO conversation parents:** if the parent is the CTO conversation session, the result does NOT go
  through N7 — it keeps going through `promptDelivery` and its admission redirect (`promptDelivery.mjs`
  ~290–310), unchanged. N7 is only for ordinary parent sessions.

**N8 — client pin (D).** `package.json` pins `@opencode/client` to exactly `OPENCODE_V2_VERSION`
(`scripts/opencode-v2/version.mjs`); a test fails when they differ.

---

## Stage A — Pending messages (the approved mockup)

### A-behaviour (what the user sees)
1. **While the agent works:** Enter = **Now** (as today: steer). **⌥Enter** (Alt+Enter on Windows/Linux)
   = **After this turn** (`delivery:"queue"`, same busy-send path as today, same refusals, same captured-
   draft rules). When idle, ⌥Enter is an ordinary send. Hint row while running:
   `⏎ send now · ⌥⏎ after this turn`; idle hint unchanged. The Send button says **Send** (not "Queue"),
   the running placeholder becomes "Message the agent…" — the CTO surface keeps its `placeholderOverride`.
2. **The pending card** replaces the "⏳ queued" ambient card, matching the mockup: header
   `Pending · N message(s)` + `↑ edit last`; one row per inbox item: badge (**Now** accent / **After this
   turn** neutral), the text (single line, ellipsis), for Now rows a quiet `at next step` (or `runs next`
   once the agent is stopped) and a **Wait** link, for After rows a primary **Send now** button, and × on
   every row. No drag handle, no reorder.
3. **Send now / Wait** call N1 with `steer` / `queue`. Outcomes: `changed` → the badge flips (the next
   `inbox` frame confirms it); `delivered` → toast "Already sent to the agent"; `unknown` → error banner
   "Couldn't confirm the change — check the pending list". Never a silent no-op.
4. **Stop** (unchanged server behaviour, K5): Now items run next; After items stay. When the agent is not
   running and After items remain, the card shows the footer from the mockup:
   "Agent stopped — these are waiting. Send now, or ×." (Send now on an idle session starts a turn — U4.)
5. ↑ edit last and × keep the cleanup spec's semantics and outcome messages.

### A-server
- `opencode.mjs`: `setInboxDelivery(sessionId, id, delivery)` (PATCH). `streamInterp.mjs`: the N1 outcome
  wait (same waiter mechanism as `cancelInbox`; `delivery.changed` already updates the snapshot).
  `rpc.mjs`: the N1 channel. `src/shared/api.ts` / `types.ts`: N1 types + IPC name.
- Smoke (`scripts/opencode-v2/c1-smoke.mjs`, mock model allowed): a queue item → PATCH steer → `changed`
  and it is delivered in the running execution; PATCH on a delivered id → `delivered`; Stop with one steer +
  one queue item → steer runs next, queue stays; then PATCH steer on the parked item of the idle session →
  a turn starts (U4).

### A-desktop
- `InputArea.tsx` (⌥Enter, hint, label, placeholder), `ChatPanel.tsx` (card, N1 actions, footer),
  `useSseBus.ts` / `inboxState.ts` (pure helpers + tests), `httpApi.ts` (N1). Visual spec = mockup A;
  implement with the app's existing tokens/components (`tokens.css`, `Button`), not the mockup's raw CSS.
- Tests: busy-send with `queue`; ⌥Enter idle = normal send; Send now / Wait for all three outcomes; footer
  visibility; CTO surface unchanged.

### A-iOS (`mobile/native/**`, read `mobile/native/AGENTS.md` first)
- While running, the composer's send offers **Send now** (tap) and **Send after this turn** (long-press menu
  on the send button); both post immediately with `delivery` instead of holding the prompt in the local
  outbox until idle. The local outbox (`PendingPromptStore`) stays ONLY for sends that failed to reach the
  box (tap-to-retry).
- **A separate busy-send path**, not today's `deliver` (which resets the completion latch, mints a new
  streaming tail and rolls `running` back on failure — wrong for a turn that is already running): it never
  touches `running`, the tail or the completion state. Each prompt carries a client-minted `messageID`
  (persisted with the outbox row, reused on retry — V2 treats it as idempotent) and its `delivery`, so a retry
  after an uncertain failure can never enqueue twice. A definite refusal (4xx) marks the row failed with the
  reason; an uncertain failure (timeout / network) marks it "may have been sent — tap to retry", and the
  row disappears by itself if that id shows up in the `inbox` frame or the transcript.
- The pending list renders from the `inbox` frame + `opencode:inbox` (K3 acceptance rule, epoch/rev) with
  the same rows and actions (Send now / Wait / ×) and the stopped footer. Swipe-to-cancel is fine in place
  of a visible ×.
- Verification per `mobile/native/AGENTS.md` (there is no Swift toolchain on the Linux box: the Mac
  build plugin). If the Mac is unreachable, stop after the Swift code + decode tests compile-checked as far
  as possible and report exactly what was not verified — do not merge iOS unverified (A-iOS may ship as a
  follow-up PR after A-server/A-desktop).

---

## Stage B — Background slash commands

### B-behaviour
1. **Highlight:** while the composer text is `/<name>` or `/<name> <args>` and `<name>` is a known opencode
   command, a skill, or one of Manta's own commands (`MANTA_BUILTIN_NAMES`), the `/<name>` token renders in
   the primary colour with a subtle accent background (mockup B). Arguments stay normal. Anything else
   (unknown name, slash not at the start, mid-word) is not highlighted. Desktop only in this stage.
2. **Run in background box:** shown (animated in/out, height reserved per mockup) only while the text is a
   valid **opencode command or skill** — never for Manta's own commands, never for CTO conversation
   sessions. It disappears the moment the text stops qualifying, and its checked state resets when it
   disappears. Checked → helper text "runs in its own session, without this chat's history; the result
   comes back here", Send label "Run in background". If N3 says the command always runs in the background,
   the box shows checked + disabled with title "This command always runs in the background".
3. **Sending with the box checked** (idle or busy — a background run never steers the current turn):
   composer clears per the usual draft rule; a running card appears in the parent (N5); a new sidebar row
   appears under the session (the job); the conversation stays usable.
4. **When it finishes:** the card flips to finished with the result text and "Open session →"; the sidebar
   row turns done; the agent replies to the result (D-B1, F5). The same card renders for V2-native
   background commands and for background `task` subagents (N4 fixes F10 for them too).

### B-server
1. **Highlight data:** no new data — the renderer already has the command list (incl. skills since #1607).
2. **N3:** best-effort `background: true` from definitions manta-server can read: native `commands` in the
   global `opencode.jsonc` (`subagent: true`, or `agent` naming an agent whose mode is `subagent` per
   `GET /api/agent`), `~/.config/opencode/commands/**/*.md` frontmatter, and the session-directory
   project's `.opencode/commands/**/*.md` + `opencode.json(c)` (read via the existing config helpers; no
   new writer). Unknown → absent. Unit-tested on fixtures.
3. **Manta-wrapped run (N2, command not marked background by N3).** A NEW launch entry point
   `startCommandJob` in `delegate.mjs` — NOT `adoptSubagentJob`, which deliberately skips launch checks
   because opencode already started the child. `startCommandJob` enforces, before creating anything:
   - the box-wide `MAX_RUNNING_JOBS` cap and the no-nesting rule (no background run from inside a
     background job's session), same refusals and messages as `startJob`;
   - **permissions:** the child gets the parent session's own ruleset (`GET /api/session/{parent}` →
     `permissions`), so a command run can do exactly what the user's conversation can — no wider (it is
     the user's own command, in the same checkout, so no delegate-style preflight grant list and no
     approval card);
   - **controls:** the child's agent/model = the input's resolved composer `agent`/`model` (what the user
     sees in the picker / plan toggle), else the parent session's current ones; passed **explicitly** to
     the child create AND to the `runCommand` call on the child, so `syncSessionControls`' omitted-agent rule
     can never flip it. The model is whatever the user already uses in this conversation, so no delegate
     model-whitelist check;
   then, in order:
   a. **register the job first** (`origin:"command"`, `engine:"v2"`, `completionOwner:"manta"`, no
      worktree, cwd = parent's directory, `launchState:"creating"`) with a **client-minted child session
      id** (`ses_…`, V2 accepts `id` on create) and a minted `completionMessageId`, so every later step is
      reconcilable by id;
   b. `POST /api/session { id, parentID, title: "/<name> <args>", agent, model, permissions }` (F7, F8);
      then the window/sidebar row; `launchState:"submitting"`;
   c. persist `submittedAt` (and `launchState:"submitting"`) **before** sending, then run the command
      **in the child** (`runCommand` on the child id; skills keep their prompt branch); `launchState:"running"`
      once the POST returns 2xx. `submittedAt` is never rewritten for this attempt, also not after an
      uncertain response;
   d. completion: from the child's raw `session.execution.succeeded|failed|interrupted` (§C1 step 6 —
      the same detection C1 uses), mark terminal, deliver N7 with the child's last assistant text.
   **Failure handling — roll back only what is proven not admitted.** A definite 4xx on create → delete the
   record, report. A definite 4xx on the command POST → delete the child + window + record, report. An
   uncertain failure (timeout, network, 5xx) on either POST → keep everything, mark
   `launchState:"uncertain"` and reconcile (§B-server 4 reconnect rules). **Not-admitted is proven only
   by:** the child session doesn't exist; OR it exists, is not active, has no user message in its timeline,
   an empty inbox (`GET /api/session/{child}/inbox`), and no descendant sessions. Only then → `failed:
   "didn't start"` (deleting the empty child). Elapsed time alone never proves it: after a 60 s grace an
   unproven run stays `uncertain`, and its card says "Couldn't confirm this started — open the session to
   check" with the Open session link (not a spinner). Any evidence of admission (a user message, an inbox
   item, activity, a descendant) → `running`. The user can't start a second run of the same record while
   it is uncertain. Tests: lost create response; lost command response with the input still queued in the
   child's inbox; lost response while a grandchild runs.
   **Nested children:** if the wrapped command turns out to background itself (N3 said "unknown"), V2
   creates a grandchild under the wrapper child, posts the grandchild's result into the wrapper child as a
   synthetic, and the wrapper child then runs a turn that replies. **The completion predicate** (used
   identically by live processing and by reconnect/boot reconcile) is: (1) the wrapper child is not active;
   (2) no descendant (sessions whose `parentID` chain leads to the wrapper child) is active; (3) for every
   descendant, its result synthetic (`metadata.childID` = that descendant) is present in its parent's
   timeline and that parent's inbox is empty; (4) the wrapper child's latest execution outcome is set with
   `time.idle` later than the newest such synthetic. Only then is the job terminal; the result text is the
   wrapper child's last assistant text. Tested with a background-defined command N3 can't read, including
   the gap between grandchild completion and the wrapper's reply.
4. **V2-native background commands (N3 says background, or V2 turns out to background it anyway).**
   Run the command normally on the parent; adopt the child it creates:
   - **Provisional adoption:** a `session.created` with `data.parentID === P` while a command window for P
     is open becomes a *candidate*. It is held (no row yet) until a `task` tool part claims it or 2 s after
     the window closes, whichever is first. Claimed by a foreground `task` → dropped (inline-only, per the
     TERMINOLOGY rule); claimed by a background `task` → the existing subagent adoption; unclaimed → adopted
     (`origin:"command"`, `completionOwner:"opencode"`). Name = the window's command when exactly one
     command window was open for P; with overlapping windows the row is named "Background command".
   - **No lost lifecycle:** the pump keeps a short-lived (10 min, capped) map of child sessions' latest
     raw execution outcome, fed for every `session.execution.*`. Adoption (here and in the existing
     `task` path) reads it, so a child that finished before it was adopted is recorded as finished at once.
   - **Reconnect / boot reconcile** for every non-terminal `engine:"v2"` job, using only these authoritative
     fields: `GET /api/session/active` (is it running), `GET /api/session/{child}` → `outcome`
     (`succeeded|failed|interrupted`) and `time.idle`, and the job's persisted `launchState` /
     `submittedAt`. Active → still running. For `completionOwner:"manta"` wrapped runs, terminal only when the §B-server 3
     completion predicate holds (descendants included); otherwise: not active, `outcome` set and
     `time.idle ≥ submittedAt` → that terminal state (and N7 for `completionOwner:"manta"`). Not active and no qualifying outcome → if
     `launchState` is `uncertain` or `submitting`, apply the never-started grace rule above; otherwise keep
     it running and re-check on the next sweep (never guess a terminal state).
   - opencode posts the result itself (F5) — Manta posts nothing (N6).
5. **Finished rows stay.** Today `finishJob` → `cleanupTerminalJob` kills the window even when there is no
   worktree, so a finished background row would vanish and "Open session →" would have nothing to open.
   For jobs **without a worktree** (`origin` `command` / `subagent`): keep the window and record after
   finishing (row shows done) until the user closes the row or the retention sweep removes it. The sweep
   (age 7 days / count 50, both tested) must, for each pruned no-worktree record, close its window first
   and then delete the record; it never prunes a record whose `completionDelivery` is `pending`. If the
   parent session was deleted (N7 POST answers 404), `completionDelivery` becomes `abandoned` (stop
   retrying, log once) and the record becomes prunable. Worktree jobs keep today's behaviour. "Open session →" calls a new RPC
   `delegate:open-session({ jobId })` → focuses the job's window, re-creating a chat window stamped with the
   child session id if it was closed; it reports a visible error if the child session no longer exists.
6. **N4 mapping** in `mapTimeline` + the iOS decode check (§1 N4).
7. **CTO refusals** for N2 in `rpc.mjs`.
8. Smoke (mock model): wrapped run → cap/nesting refusals, child created with the parent's permissions and
   the composer's agent/model (a plan-agent parent stays plan), job registered, N7 result (busy parent:
   waits for the turn; idle parent: immediate turn; U1), exactly ONE result + ONE parent reply, N4 part in
   the parent transcript; a native `subagent:true` command (native `commands` key) → adopted row, no Manta
   result, exactly one opencode result + one reply, row stays done; a child that finishes in < 1 s is still
   recorded finished; U2 (same synthetic id twice → one record); U5 with a `.md` command.

### B-desktop
- Highlight overlay in `InputArea.tsx`: the textarea stays the input (caret, IME, selection, undo, paste,
  autosize untouched); a mirrored overlay renders the coloured token, aligned character-for-character
  (same font/size/padding/wrapping — the Sidebar ghost-text overlay is the precedent; read its comments).
  Must not lag typing (memoised, no per-keystroke re-render of the transcript).
- The box + helper text + Send label per B-behaviour; Enter sends with `background:true` when checked.
- Transcript: the N5 running cards (from the job store) and the N4 result cards, paired by `jobId`, look
  like the mockup (running → finished / failed). "Open session →" calls `delegate:open-session` and reports
  both outcomes. Background `task` subagent results get the same card.
- Tests: validity matrix (known / unknown / skill / Manta built-in / slash mid-text / leading space /
  arguments), box show/hide/reset, locked state, send payload, card states.

---

## Stage C — Background jobs on the V2 engine

### C1 — `delegate` on V2 (not CTO-dispatched jobs)
Applies to `startJob` / `resumeJob` for every job **except** those with `actor:"cto"` (they stay
`engine:"legacy"` until C2). The gate is the `actor` field, never `origin` (CTO jobs are
`origin:"delegate", actor:"cto"`).
1. worktree + branch exactly as today;
2. `POST /api/session { parentID: parentSessionID, title: job.name, agent, model, permissions: <today's
   preflight ruleset> }` (F8) — replaces the session that `newWindow` chat-mode creation makes today; the
   model still goes through today's whitelist resolution first;
3. resolve the execution directory ONCE as `worktree ?? parentDirectory` (today's launch falls back to the
   parent directory when a worktree can't be made and isolation isn't required — keep that), persist it,
   and use it for create, move, stamp and resume. When it differs from the parent's directory:
   `POST /api/session/{child}/move { directory }` (F7) — verify U3 in the smoke (shell `pwd`); if the
   move fails definitively, undo (delete the child, remove the worktree) and report. Tested for a
   non-repository job (no move);
4. `newWindow` with `existingSessionId: child` so the sidebar row/window behave as today;
5. opening prompt via `sendPrompt` on the child, as today; record `engine:"v2"`,
   `completionOwner:"manta"`, `attempt`, `completionMessageId`;
6. **completion from raw V2 execution outcomes** for `engine:"v2"` children, not the lifecycle adapter
   (which turns an interrupt into an ignored abort followed by an idle that reads as success —
   `opencodeV2.mjs` ~500–518): `succeeded` → completed; `failed` → failed with the error; `interrupted` →
   `paused` if `pauseRequested`, `stopped` if a stop was requested, else `failed: "interrupted"`. The pump
   (`index.mjs`) feeds raw `session.execution.*` to the delegate engine for this (and for B's wrapped runs
   and the §B-server 4 lifecycle map). Pause / stop / timeout / result races are resolved by the job
   store's existing lock: the first terminal transition wins, later ones are no-ops;
7. then **N7** instead of `promptDelivery.deliver` — except when the parent is the CTO conversation session
   (N7 says why); `promptDelivery` keeps serving schedules / webhooks / peers / capabilities;
8. pause / resume / stop / timeout / sweep / reconcile-on-boot keep their behaviour on `engine:"v2"`
   records with `completionOwner:"manta"`. Pause / resume are **not offered** for `completionOwner:"opencode"`
   rows (V2 owns that lifecycle — the controls are not rendered for them, AGENTS.md outcome 3); stop is
   offered and interrupts the child. A job reports **exactly one** result, at its final terminal state: a paused attempt emits nothing; a
   resumed attempt that finishes emits the job's single N7 result (same `completionMessageId`); stopping a
   paused job emits a `stopped` result. Cards pair by `jobId` only. Resume creates a fresh child the same way (create → move → stamp), bumps `attempt`, keeps
   `jobId` — cards pair by `jobId` (N5), so a resumed job's running card still turns into its result;
9. B's wrapped command runs keep their own launch (`startCommandJob`) but share steps 6–7.
Records created before C1 have no `engine` field = legacy, and finish on the legacy path.

### C2 — CTO-dispatched jobs on V2, then delete legacy
Flip `actor:"cto"` jobs to `engine:"v2"` after C1 has been on `main` and the CTO work tests + one live CTO
dispatch on the dev box (orchestrator-run) pass. Their completions keep going through `promptDelivery` +
the admission redirect whenever the parent is the CTO conversation (N7) — only the child-session engine
changes; dedupe, ordering and turn authorization stay the admission engine's. Then delete the legacy
completion path and `engine:"legacy"` handling once no running legacy record can exist (boot reconcile
marks any left over `failed: "interrupted by upgrade"`, the same way it handles a dead job today).

### C-tests
Unit tests per step with injected I/O (create/move/stamp undo on each failure point; N7 payload; CTO
actor stays legacy in C1; interrupted → paused/stopped/failed mapping; first-terminal-wins races between
pause, stop, timeout and completion; N7 retry after a failed POST and after a boot mid-delivery, with
exactly one parent record). Smoke (mock model): a delegate job whose child runs `pwd` and writes a file —
the file lands in the worktree, not the parent checkout (U3); the parent gets the N7 result, rendered via
N4, and replies after its own turn ends (U1); pause → resume → completion; 30-min timeout path with a
shortened timeout injected.

---

## Stage D — Typed client

1. Add `@opencode/client` pinned to exactly `OPENCODE_V2_VERSION` (N8), Promise entry only; confirm it
   installs without `effect`/`solid-js` and lands in the server release tarball (`scripts/release/pack.mjs`
   ships production deps — verify the tarball contains it, per the AGENTS.md "a dependency reaches a box
   only through a new tarball" rule).
2. Create the client in `opencode.mjs` with a custom `fetch` that wraps the existing pooled transport and
   applies `opencodeAuthHeader()` **per request** (today's code re-reads the password on every request —
   keep that; do not bake the header into the client at creation), and resolves the base URL per request
   so `_setApiBase` keeps working after the client exists. Keep pooling and timeouts. Tests: password
   rotation and `_setApiBase` changes after client creation both take effect.
3. Move every request/response call in `opencode.mjs` (and `upgradeV2.mjs`'s opencode calls) to typed
   client methods. **Keep** the hand-written SSE pump (`subscribeEvents`) — the client has no reconnect /
   `onDisconnect` (F13) and the pump's semantics are load-bearing.
4. Type checking: add `tsconfig.server.json` (`allowJs`, `checkJs`, `noEmit`) covering `src/server/opencode*.mjs`
   (and any new adapter module), wired into `npm run typecheck`, with JSDoc types imported from the client so
   a wrong path/field/body is a type error. Do not widen it to the rest of `src/server` in this stage.
5. Tests: N8 version-lock test; the existing `opencode.test.mjs` suite passes unchanged in behaviour (its
   fetch-level fakes keep working because the client uses the injected fetch) — any test that asserted raw
   URL strings may be updated to the client's URLs, but request bodies must stay identical; a contract test
   that every operation Manta calls exists in the pinned client.

---

## 7. Ownership per stage (parallel Sonnet implementers)

| Stage | Slice | Owns | Must not touch |
|---|---|---|---|
| A | A1 server | `opencode.mjs`, `streamInterp.mjs`, `rpc.mjs` (N1), `src/shared/{api.ts,types.ts}` (N1), c1-smoke | renderer, mobile |
| A | A2 desktop | `src/renderer/**`, `AGENTS.md` (queued-message section) | server, shared, mobile |
| A | A3 iOS | `mobile/native/**` | everything else |
| B | B1 server | `opencode.mjs`, `rpc.mjs`, `delegate.mjs` (`startCommandJob`, adoption, no-worktree retention, `delegate:open-session`), `commandOrigins.mjs` (window hooks for adoption), `index.mjs` (pump: raw `session.created` / `session.execution.*` feed, lifecycle map, reconnect reconcile), `src/shared/opencodeV2.mjs` (N4), `src/shared/{api.ts,types.ts}` (N2–N6 + `delegate:open-session`), N3 reader (new module), smoke | renderer; mobile except the N4 decode test under the iOS test target |
| B | B2 desktop | `src/renderer/**`, `AGENTS.md` | server, shared |
| C | C1 | `delegate.mjs`, `opencode.mjs` (create/move/delete-session helpers), `index.mjs` (pump wiring only if B1's feed needs extending), `promptDelivery.mjs` (only to stop routing ordinary-parent job completions), smoke | renderer, mobile, `cto*.mjs` |
| C | C2 | `delegate.mjs`, `cto*.mjs` job dispatch call sites | renderer, mobile |
| D | D1 | `package.json` + lockfile (dependency + `typecheck` script), new `tsconfig.server.json` (and `tsconfig.node.json` only if a reference is needed), `opencode.mjs`, `upgradeV2.mjs` (opencode calls), `scripts/release/pack.mjs` only if the tarball misses the dependency, tests | everything else |

Within a stage, slices run in parallel in separate worktrees on the attached volume
(`/mnt/HC_Volume_105783934/dev-cache/wt/…`), coding against §1; the orchestrator merges server → desktop
→ iOS. Shared files touched by two slices are edited only in disjoint blocks.

## 8. Order and gates
- A1+A2 together; A3 may follow as its own PR. B starts after A merges (B2 builds on A's InputArea changes).
- C1 after B merges (it reuses B's adoption + N4 card). C2 after C1 has run on `main` + one orchestrator
  live CTO dispatch on the dev box.
- D after C2 (it touches the same `opencode.mjs` call sites; doing it last avoids rebasing every stage).
- Every PR: `npm run typecheck`, full `npm test`, `npm run build` green; any failure shown to fail
  identically on `origin/main` before being called unrelated; the stage's smoke passing; the U-facts it
  depends on proven (or the stage stopped and reported).

## 9. Out of scope
iOS highlight / background box / background-result card rendering (iOS only needs to keep decoding, N4);
reordering pending messages (D-A2); retiring the lifecycle adapter; policies; snapshots/Undo; warming.
