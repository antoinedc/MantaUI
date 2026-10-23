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
- U1 A `queue` synthetic posted while the parent runs waits for the turn to end and then starts its own turn.
- U2 A `synthetic` with `resume:false` posted to an idle session adds a timeline record and starts nothing.
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
conversation sessions and for names that are not an opencode command or skill.

**N3 — command list (B).** `OpencodeCommand` gains `background?: true` — set only when manta-server can
prove the definition runs in the background (§B3); absent means "unknown / foreground".

**N4 — background result on the message model (B).** `mapTimeline` maps a `synthetic` record whose
`metadata.source === "subagent"` to a message in the existing `{info, parts}` shape:
```
info:  { id, role: "assistant", sessionID, time:{created}, background: true }
parts: [{ id: `${id}:bg`, type: "background-result",
          childSessionId, state: "completed"|"failed"|"cancelled"|string,
          name?: string /* "/review HEAD~1" for command runs */, agent?: string,
          text /* inner text of the <subagent> envelope */ }]
```
Other synthetic records stay dropped. The iOS client must keep decoding transcripts that contain this
(it skips unknown part types — the implementer must confirm in `mobile/native` and add a decode test);
iOS rendering of the card is a follow-up, not this spec.

**N5 — background-start marker (B).** A Manta-started background run is visible in the parent from the
moment it starts, durably (survives reload, shows on every client). Mechanism, decided by U2:
- if U2 holds: `POST /api/session/{parent}/synthetic` `{ text: "Started /<name> <args> in the background.",
  metadata: { source: "manta-background-start", childID, command: { name, arguments } }, resume: false }`
  and N4 also maps `source === "manta-background-start"` to a `background-result`-style part with
  `state: "running"` (the renderer pairs start + result by `childSessionId` and shows ONE card that flips
  from running to finished, as in the mockup);
- if U2 does not hold: no marker message; the renderer derives the running chip from the job store
  (`delegateList` for this parent, `origin: "command"`) and the result card from N4 only.
The implementer reports which branch was taken.

**N6 — job origins (B, C).** Job records gain origin values `"command"` (a background slash command —
Manta-started or V2-native) alongside today's `"delegate"`, `"subagent"`, `"cto"` (whatever the existing
names are — keep them; add only `"command"`), and a field `engine: "v2" | "legacy"` (C).

**N7 — job result delivery (C).** A finished `engine:"v2"` job is reported to its parent by
`POST /api/session/{parent}/synthetic` `{ text: buildCompletionText(job), description: job.name,
metadata: { source: "subagent", childID: job.childSessionID, agent: job.agent ?? null, state, manta: { jobId } },
delivery: "queue", resume: true }` — so it renders through N4, never interrupts a running parent turn
(today's defer-until-idle behaviour), and the agent replies when it is delivered (D-B1). Depends on U1.

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
  box (tap-to-retry), unchanged.
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
3. **Manta-started run (N2):** in `opencode.mjs` `runCommand`, `background:true` →
   a. resolve the parent's current agent/model (`GET /api/session/{parent}`);
   b. `POST /api/session` `{ parentID: parent, title: "/<name> <args>", agent?, model }` (F7, F8);
   c. register the job (origin `"command"`, `engine:"v2"`, no worktree, cwd = parent's directory) through
      the existing adoption path so the sidebar row + window exist before the run starts;
   d. N5 start marker (per U2);
   e. run the command **in the child** (existing `runCommand` on the child id — skills keep their prompt
      branch);
   f. completion: on the child's `session.execution.succeeded|failed|interrupted` (lifecycle adapter idle /
      error), take the child's last assistant text and post the N7-shaped synthetic **with
      `delivery` omitted (V2 default) and `resume:true`** — identical in shape to F5 so N4 renders both.
      (Stage C later moves this onto the generic job-result path.)
   Failures at any step are reported to the caller and leave no orphan job record (undo like `startJob`).
4. **V2-native background commands (F4/F5):** adopt their child into the sidebar: while a command window
   (cleanup spec §3) is open for parent P, a `session.created` with `data.parentID === P` that no `task`
   tool part claims within the window is adopted (origin `"command"`, `engine:"v2"`, name = the command).
   Background `task` subagents keep their existing adoption path (F11).
5. **N4 mapping** in `mapTimeline` + the iOS decode check (§1 N4).
6. **CTO refusals** for N2 in `rpc.mjs`.
7. Smoke (mock model): Manta-started background run → child created, job registered, marker (or job-store
   chip per U2), result synthetic, parent auto-reply, N4 part in the parent transcript; a native
   `subagent:true` command (native `commands` key) → adopted row + N4 card; U5 checked with a `.md` command.

### B-desktop
- Highlight overlay in `InputArea.tsx`: the textarea stays the input (caret, IME, selection, undo, paste,
  autosize untouched); a mirrored overlay renders the coloured token, aligned character-for-character
  (same font/size/padding/wrapping — the Sidebar ghost-text overlay is the precedent; read its comments).
  Must not lag typing (memoised, no per-keystroke re-render of the transcript).
- The box + helper text + Send label per B-behaviour; Enter sends with `background:true` when checked.
- Transcript: render the N4 / N5 part as the mockup's card (running → finished, "Open session →" opens
  the child's sidebar row/window). Background `task` subagent results get the same card.
- Tests: validity matrix (known / unknown / skill / Manta built-in / slash mid-text / leading space /
  arguments), box show/hide/reset, locked state, send payload, card states.

---

## Stage C — Background jobs on the V2 engine

### C1 — `delegate` (and B's command runs) on V2
`startJob` for every origin except the CTO's (kept `engine:"legacy"` until C2):
1. worktree + branch exactly as today;
2. `POST /api/session { parentID: parentSessionID, title: job.name, agent, model, permissions: <today's
   preflight ruleset> }` (F8) — replaces the session that `newWindow` chat-mode creation makes today;
3. `POST /api/session/{child}/move { directory: worktree }` (F7) — verify U3 in the smoke (shell `pwd`);
4. `newWindow` with `existingSessionId: child` (the adoption path already supports stamping an existing
   session) so the sidebar row/window behave as today;
5. opening prompt via `sendPrompt` on the child, as today;
6. completion from the child's lifecycle events (unchanged detection), then **N7** instead of
   `promptDelivery.deliver` — `promptDelivery` keeps serving schedules / webhooks / peers / capabilities;
7. pause / resume / stop / timeout / sweep / reconcile-on-boot work unchanged on `engine:"v2"` records
   (resume creates a fresh child the same way: create → move → stamp);
8. B's Manta-started command runs switch from their own completion (B-server 3f) to N7 — one path.
Records created before C1 have no `engine` field = legacy, and finish on the legacy path.

### C2 — the CTO on V2, then delete legacy
Flip the CTO origin to `engine:"v2"` after C1 has been on `main` and the CTO work tests + one live CTO
dispatch on the dev box (orchestrator-run) pass. Then delete the legacy job-completion delivery path and
`engine:"legacy"` handling once no running legacy record can exist (boot reconcile marks any left over
`failed: "interrupted by upgrade"`, the same way it handles a dead job today).

### C-tests
Unit tests per step with injected I/O (create/move/stamp undo on each failure point; N7 payload; CTO
origin stays legacy in C1). Smoke (mock model): a delegate job whose child runs `pwd` and writes a file —
the file lands in the worktree, not the parent checkout (U3); the parent gets the N7 result, rendered via
N4, and replies after its own turn ends (U1); pause → resume → completion; 30-min timeout path with a
shortened timeout injected.

---

## Stage D — Typed client

1. Add `@opencode/client` pinned to exactly `OPENCODE_V2_VERSION` (N8), Promise entry only; confirm it
   installs without `effect`/`solid-js` and lands in the server release tarball (`scripts/release/pack.mjs`
   ships production deps — verify the tarball contains it, per the AGENTS.md "a dependency reaches a box
   only through a new tarball" rule).
2. Create the client once in `opencode.mjs` with the Basic-auth header from `opencodeAuthHeader()` and the
   existing pooled `ocFetch` transport passed as its `fetch` (keep keep-alive pooling, timeouts, the
   `_setApiBase` test seam).
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
| B | B1 server | `opencode.mjs`, `rpc.mjs`, `delegate.mjs` (adoption + origin), `src/shared/opencodeV2.mjs` (N4), `src/shared/{api.ts,types.ts}` (N2–N5), N3 reader (new module), smoke | renderer, mobile (except the N4 decode test, which B1 adds under `mobile/native/**Tests**` only) |
| B | B2 desktop | `src/renderer/**`, `AGENTS.md` | server, shared |
| C | C1 | `delegate.mjs`, `opencode.mjs` (create/move helpers), `promptDelivery.mjs` (only to stop routing job completions), smoke | renderer, mobile, CTO modules |
| C | C2 | `delegate.mjs`, `cto*.mjs` job dispatch call sites | renderer, mobile |
| D | D1 | `package.json`/lockfile, `opencode.mjs`, `upgradeV2.mjs` (opencode calls), `tsconfig.server.json`, `package.json` typecheck script, tests | everything else |

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
