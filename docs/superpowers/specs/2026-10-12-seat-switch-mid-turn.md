# Seat switch mid-turn — design

Status: draft · Branch: `fix/seat-switch-midturn` · Builds on
`2026-10-08-multi-account-subscriptions-design.md` (§5.3 limit follow-up).

## Problem

A conversation whose seat hits 100% **during a turn** spins forever instead of
moving to another seat.

Root cause (verified against opencode 1.18.34 and the box's logs):

1. The provider answers the next model request with **HTTP 429** (Anthropic
   usage limit / Codex `usage_limit_reached`).
2. opencode treats a 429 as **retryable** and sleeps for the response's
   `retry-after` — capped only at 2^31 ms (~24 days). For a plan limit that is
   hours until reset. The UI shows "retrying" / loading.
3. A retry is a `session.status {type:"retry"}` event, **never a
   `session.error`**, so the existing limit signal (which listens only for
   `session.error`) never fires — no seat is marked limited, nothing re-places
   the conversation. The box logs contain zero Claude limit failures for exactly
   this reason.
4. Even when the 10-minute usage poll later moves the conversation, nothing
   happens: a move only takes effect on the conversation's *next request*, and
   opencode is asleep on `retry-after`, so there is no next request.

Stopping + re-sending "works" only because it makes a new request after the
poller already moved the assignment.

## Fix — two layers

### Layer 1 (primary, seamless): the plugin switches seats inside the request

`docs/opencode-plugins/manta-accounts.ts` (installed automatically by
`sync_opencode_plugins` / startup plugin sync).

When an intercepted model request (`POST api.anthropic.com/v1/messages*` or
`POST chatgpt.com/backend-api/codex/*`) that carries session ids gets a **429**
— whether it went out on the live login or a non-live seat — and its body is
replayable:

1. `POST /api/accounts/limit {provider, sessionID, parentSessionID?}` (new
   route, below; timeout 10 s; any failure → return the original 429 untouched).
2. Drop that conversation's resolve-cache entry, whatever the answer.
3. If the answer names a **different seat** than the one the request was sent
   on (`seatId` differs; the first attempt's seat is the one `seatFor`
   returned, `null` if none), cancel the 429's body and **re-send once** with
   the new identity: a live answer → the ORIGINAL headers; a non-live answer →
   read that seat's file and `rewriteHeaders` (same expiry/refresh handling as
   the first attempt). At most **one** seat-switch retry per request; the
   existing 401-refresh retry stays as is and does not stack with it.
4. Otherwise return the original 429 (body intact).

The live path currently forwards the caller's `input` as-is; when it may need a
replay it must capture a `Request` body first (`bodyFor`) so the retry can send
it. A non-replayable body → no seat-switch retry (return the 429).

Effect: opencode never sees the 429 when another seat has room. The turn
continues on the new seat with no abort and no extra message.

### Layer 2 (backstop): the server wakes a conversation stuck in retry

New `src/server/seatRetryWatch.mjs` (pure + injected I/O), wired in
`index.mjs`'s event pump next to `usageStopEngine`, and to the seat assigner's
`onMoved`.

- Tracks sessions currently in `session.status {type:"retry"}`; clears on
  `busy` / `idle` / `session.idle` / `session.error`.
- On a retry event: provider = the session's seat assignment
  (`seatAssigner.sessionAssignment`), else skip. Classify `status.message` with
  the existing `classifyLimitSignal` (overload never counts). On a limit →
  run the existing limit handler (mark limited, refresh usage, reconsider).
  Debounced per session (once per 60 s).
- **Recover** a retrying session when its conversation was moved — either by
  that limit handler's result (`moved:true`) or by ANY automatic move of its
  conversation reported through `onMoved` (covers the 10-minute poller moving
  it while opencode sleeps):
  1. `abortSession(session)`.
  2. If the session is a top-level conversation (not a sub-agent child), send
     the literal `KEEP_GOING_PROMPT` ("Keep going") through
     `promptDelivery.deliver` (defers to idle), pinned to the model of the
     session's last user message (`{providerID, modelID}`), as `usageResume`
     does. A sub-agent child is only aborted: its parent's task tool returns
     and the parent's next request already resolves to the new seat.
  3. At most one recovery per session per 2 minutes; never throws into the
     pump; logs `[seat-retry] recovered <sid> <from> -> <to>`.

Layer 2 only acts when a move actually happened, so a conversation with no
seat that has room keeps opencode's normal retry (no abort loop).

### New route: `POST /api/accounts/limit`

In `src/server/accountsRoute.mjs` (`ACCOUNTS_ROUTE_PATHS`), same loopback-only
gate and validation shape as `/resolve`.

- Body: `{provider: "claude"|"codex", sessionID: string, parentSessionID?: string}`.
- Server: `seatAssigner.markLimited(provider, sessionID)`; kick the debounced
  usage refresh in the background (do NOT await it); `reconsider(provider,
  sessionID)`; then answer `seatAssigner.resolve(provider, sessionID,
  parentSessionID)` — the same resolve-shaped body (`{seatId, live,
  credentialFile?, …}`) plus `moved: boolean`.
- 400 on invalid input, 403 off-loopback, 405 on non-POST.
- Note `markLimited`/`reconsider` key on the conversation root; a child id is
  resolved to its root via `children` as today (pass `parentSessionID` through
  if needed so a first-ever child request is linked).

## Out of scope

- A non-retryable limit `session.error` (rare: opencode retries 429s). Existing
  behaviour (re-place, user re-sends) is unchanged.
- UI changes. The existing in-conversation seat-move notice already announces
  the move.

## Tests

- Plugin (`src/server/opencodePlugins.test.mjs` harness via `__test`):
  429 on live seat → limit call → retried on new non-live seat with swapped
  auth; 429 on non-live seat → retried on live with original headers; answer
  with same seat → original 429 returned, body readable; limit call fails →
  original 429; non-replayable body → no retry; exactly one retry (second 429
  returned); resolve cache dropped after a 429.
- Route: validation, loopback gate, does not await refresh, `moved` flag.
- `seatRetryWatch`: retry+limit message → limit handler; overload message →
  nothing; moved → abort + Keep going on the last user model; child → abort
  only; `onMoved` for a retrying conversation → recover; not retrying → nothing;
  busy/idle clears; per-session debounce; handler throwing never escapes.
