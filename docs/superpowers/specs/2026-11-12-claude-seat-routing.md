# Claude seat routing: fast, never on a dead identity

Status: approved direction (2026-11-12). This replaces draft PR #1685, which is closed when this PR lands.
Decisions taken with the user:
- one PR and one restart window;
- when the box has Claude seats, a request never falls back to OpenCode's stored Anthropic API key.

## 1. What goes wrong today (observed 2026-11-12)

OpenCode sessions on Claude models fail with `401 "OAuth access token has been revoked"`, even though all
10 seats are healthy. Batch runners that open one session per call fail most often.

The full chain, confirmed in code (OpenCode 2.0.30 source, `packages/core/src`) and on the box:

1. **The plugin gives up on a seat after 1.5 s.** A new conversation has no cached placement, so the
   plugin asks manta-server `GET /api/accounts/resolve` with a 1.5 s timeout. On a timeout it falls back
   to the live login `~/.claude/.credentials.json`.
2. **The live login is dead.** The `claude` CLI blanked it on 11-05 11:23: access and refresh tokens are
   empty strings and `expiresAt` is 0. The plugin cannot parse an empty token, so it has no identity at all.
3. **No identity means "fail open".** The plugin leaves the request exactly as OpenCode built it. OpenCode
   signs it with its own stored Anthropic credential (`~/.local/share/opencode/auth.json`, a dead
   `sk-ant-usr…` key). Anthropic answers "OAuth access token has been revoked". The server finishes the
   placement 1 to 2 s later, which is why the failed sessions show up in the seat log after their 401.
4. **Why the lookup takes over 1.5 s.** Every resolve runs under ONE global lock. Inside it,
   `accounts.seatStates` re-reads every seat file, and once a minute runs discovery, which can call
   Anthropic's profile API for the live login with no timeout. A cache miss for a dead live login retries
   every 30 s. Each new placement then rewrites the 400 KB assignments file before the lock is released
   (30-day retention, about 1,500 conversations and 1,800 child links). Bursts of 4 to 8 new
   conversations push the last one past 1.5 s, and a fresh directory makes every conversation new to that
   directory's plugin instance (each instance has its own cache).
5. **Every 401 restarts the live-login refresh.** OpenCode reports each one as a session error, and
   manta-server's credential recovery treats it as a live-login problem. It runs `claude` against the
   dead live file (logged 44 times on 11-12 as `refresh ok=false reason=refresh-token-expired`). That
   live login has nothing to do with seat traffic.

**Plugin reload race (cause 3 in the brief), checked against the OpenCode source:**
- **New directory instance: not a race.** Plugin hooks are per directory instance. A new instance holds
  the plugin registry's readiness latch until the first activation finishes, and a turn waits on that
  latch before it starts (`plugin/supervisor.ts`, `session/runner/llm.ts`). So a turn in a fresh
  directory always has the seat hooks.
- **Reload mid-turn: a real but narrow window.** Re-activation keeps a plugin's hooks unless its source
  digest, or the digest of a plugin loaded before it, changed. If one did change, its hooks are removed
  and re-registered. A turn that is already running does not wait for that, so for a few milliseconds
  OpenCode can see no hooks and send the request with its stored key. This only happens when plugin files
  change on disk without an opencode restart, which the deploy procedure below avoids.
- **The 8/8 cold-directory failures were the cold-cache case above (points 1 to 4), not this race.**

**Side finding, the `~/.claude/.credentials.json.bak.<epoch>` files (6,779 of them).** They are written by
the live-login connect flow (`startClaudeLogin` in `src/server/rpc.mjs`). The cause is `rpc.test.mjs`:
it starts that flow, and `CREDENTIALS_PATH` is built from `homedir()`, which the test sandbox does not
cover. So every `npm test` run on this box made about 3 copies of the real login; the daily counts follow
test activity and stop once tests moved to Freestyle on 11-03. The flow only copies the file. Restoring
from a backup needs a separate login-completion poll, and no test drives that against the real path. So
the backups never corrupted the login, but the test suite should not touch it.

## 2. Goals

- A placement lookup is a memory read: **≤ 5 ms p99 for 20 concurrent new conversations**, measured in
  the assigner (excluding HTTP).
- With seats on the box, **no Claude request ever leaves signed by a dead credential or by OpenCode's
  stored API key.** If no seat can be found, the user sees a clear Manta error instead.
- A seat that rejects a request (401 after refresh, or a usage limit) gets the request resent **once**,
  on another healthy seat, preferring the same org.
- Parent and sub-agents keep sharing one seat. Existing placement rules are unchanged: stay on the seat,
  move at 95 to targets under 70, use-it-or-lose-it, no move back within 5 h, at most one cross-org move
  per 5 h, manual mode.
- Boxes with **no** seats behave exactly as today, including API-key users.
- No token ever crosses HTTP, and only manta-server refreshes seat tokens.
- The audit pilot's direct reads of seat files under `~/.manta-secrets/accounts/` keep working.

## 3. Server design

### 3.1 Seat table in memory (`src/server/seatTable.mjs`, new)

The table keeps the last `accounts.seatStates(provider)` answer per provider, the same shape as today. It
is rebuilt in the background only, never on a request:
- at startup;
- every `SEAT_TABLE_REFRESH_MS = 10_000`;
- right after any accounts store change (accounts service listener), a seat refresh outcome, `forgetSeat`,
  and a seat sign-in landing;
- after a best-effort `fs.watch(seatsRoot, {recursive: true})` event (debounced 250 ms). If the watcher
  fails to start, a warning is logged and the periodic rebuild still runs.

Rebuilds are single-flight. A rebuild that fails keeps the previous table and logs one warning. Methods:

- `get(provider) → states | null`: synchronous.
- `ready(provider, timeoutMs)`: waits only for the first build.
- `invalidate(reason)`: schedules a rebuild.

`resolve` reads `get()`. Before the first build has finished, `resolve` waits on `ready()` for at most
`SEAT_TABLE_FIRST_BUILD_WAIT_MS = 3_000`. If the table is still not ready, the route answers
`503 {"error":"warming"}`, which the plugin treats as "server unreachable" (§4.2).

`refreshSeat` keeps its current behaviour (refresh, then re-read) but reads the fresh state through a
forced rebuild (`invalidate` and await), so its answer and the table agree.

### 3.2 No global lock

Once the table is in memory, `place` / `decideSeat` / `reconsider` / `forgetSeat` / `markLimited` run as
synchronous map operations with no `await` between reading and writing the assignment, so JavaScript's
single thread makes them atomic. The global mutex is removed. Consequences:

- **Parent and sub-agent.** Each first request computes the root synchronously (`resolveRoot`) and places
  it in the same synchronous turn. The first one in pins the seat and the second one reads that pin, so
  both get the same seat.
- **Seat refresh.** `refreshSeat` stays single-flight per seat (existing `refreshing` map) and does not
  hold up any resolve.

### 3.3 Write-behind persistence and pruning

- `persist()` becomes `scheduleSave()`: a save runs `SAVE_DEBOUNCE_MS = 2_000` after the last change, and
  at the latest `SAVE_MAX_WAIT_MS = 10_000` after the first unsaved one. Saves are single-flight and atomic
  (as today). A failed save is retried by the next schedule.
- `flush()` saves at once. `index.mjs` calls it on `SIGTERM`/`SIGINT` before exit, alongside any existing
  shutdown hook. Losing at most 10 s of pins only means a few conversations get re-placed, as today.
- `lastUsedAt` is updated in memory on every request. A change that only touches `lastUsedAt` is saved
  at most every `TOUCH_SAVE_MS = 10 * 60_000`, so it does not cause a write on every request.
- **Pin idle TTL `PIN_IDLE_TTL_MS = 6 h`, replacing the 30-day `ASSIGNMENT_TTL_MS`.** Six hours is longer
  than every window a pin still needs to remember (no move back within 5 h, the 5 h cross-org cap), so
  no rule loses information. A child link's `at` is updated whenever the link is used, and the link
  expires on the same TTL.
- **Size caps:** `MAX_PINS_PER_PROVIDER = 5_000` and `MAX_CHILD_LINKS = 10_000`. Beyond those, the least
  recently used entries are dropped first.
- Pruning runs on load, on each scheduled save, and every 10 minutes.
- **Visible effect:** the accounts panel's per-seat conversation counts now cover conversations used in
  the last 6 h instead of the last 30 days. A conversation idle for over 6 h gets placed again on its next
  request; its prompt cache would have expired by then anyway.
- The seat-attribution log is unchanged: an async append after the decision.

### 3.4 Live login identity off the request path

These changes are in `accounts.mjs`:
- `fetchClaudeProfile` gets a 10 s timeout through an `AbortController`, and reports `dead` when the
  answer is 401/403. Its answer is now `{identity}`, `{dead: true}` or `{error: true}`.
- `claudeLiveIdentity` caches by token hash, as today:
  - an identified login is trusted for 1 h;
  - a login Anthropic refused (`dead`) is remembered as dead **until the live file's token changes**,
    with no TTL;
  - a network error is retried after 60 s;
  - an empty token is "absent" and makes no call.
- Discovery itself is unchanged, but it now only runs from the seat table's background rebuild.

### 3.5 Credential recovery stays away from seat traffic

`maybeRecoverCredentials` (`opencode.mjs`) refreshes the live login only when all of these hold:
- (a) the box has no Claude seats, or the session's conversation is placed on a seat whose source is the
  live login (checked through an injected `isLiveServed(sessionID)`, which reads the assigner and the
  seat table);
- (b) the live file has a non-empty token;
- (c) the live refresh has not already returned `refresh-token-expired` for the current content of the
  file. That signature is remembered until the file changes.

The proactive refresh sweep applies (b) and (c) to the live login as well. Seat refreshes are untouched.

### 3.6 Answers and the `/limit` route

`GET /api/accounts/resolve` returns the same answer shape, plus one optional field, `reason`, when there
is no seat:

| Situation | Answer |
|---|---|
| no seats for the provider | `{seatId: null, live: true, reason: "no-seats"}` |
| seats exist but none usable | `{seatId: null, live: true, reason: "no-usable-seat"}` |
| exactly one seat | `seatResult(provider, seat)`, i.e. `live: false` + its file when that seat has its own directory (today it always answered `live: true`, which sent a single-seat box with a dead live file to the dead login) |
| otherwise | unchanged |

`POST /api/accounts/limit` accepts an optional `reason: "limit" | "auth"` (default `"limit"`; any other
value is a 400). The answer shape is unchanged.

- `"limit"` behaves as today.
- `"auth"` calls `seatAssigner.markAuthFailed(provider, root)`. This marks the conversation's seat
  unusable for `AUTH_FAILED_MARK_MS = 5 * 60_000`: it is treated as not usable in every decision (the
  same mechanism as `markLimited`, but it sets `usable: false` instead of `exhausted`). It also kicks a
  table rebuild and a background refresh of that seat, then reconsiders and resolves like the limit path.
  Both marks clear early when a refresh of that seat succeeds.

### 3.7 Pacing forced moves

When a seat dies or fills up, every conversation on it moves within seconds. Usage readings lag, so the
rules would send all of them to the same least-loaded seat. To spread them, every **forced** move
(`exhausted`, `unusable`, or an auth mark) onto a seat in the last `MOVE_PACING_WINDOW_MS = 10 * 60_000`
adds `MOVE_PACING_PCT = 5` points (capped at +30) to that seat's 5h and weekly readings in `snapshotsFor`.
This is a projection of the load those conversations will bring. It feeds every decision through the
same readings path the limited marks already use. Optional moves (load at 95, reset-soon, rebalance) and
new placements add nothing.

## 4. Plugin design (`docs/opencode-plugins-v2/manta-claude-max`)

### 4.1 Hook registration order

`setup` registers the `http.request`/`http.response` hooks **first**, before the provider transform and
the system-prompt hooks. This shrinks the reload window from §1 to the smallest possible.

### 4.2 Seat lookup (`lib/seats.ts`)

- **Uncached conversation:** ONE request with the full budget, `RESOLVE_BUDGET_MS = 10_000`. There is
  no abort-and-retry, which was the PR #1685 review finding: retries only re-queue work on the server.
- **Cached conversation older than 30 s:** a refresh with the existing 1.5 s timeout; on failure the last
  answer is used, as today.
- **Single-flight per conversation and the 500-entry cache:** unchanged.
- **The resolver now reports why it failed:** `seatFor` returns `{ok: true, result}` or
  `{ok: false, why: "unreachable" | "timeout" | "warming"}`. This lets the exchange choose the right
  error.

### 4.3 Choosing the identity (`lib/exchange.ts`)

"Seats exist" means the server said so (`reason !== "no-seats"`). When the server is unreachable, it
means at least one `~/.manta-secrets/accounts/claude/<seat>/.credentials.json` exists, checked from the
directory and cached for 30 s.

| Server answer | Identity |
|---|---|
| a seat with its own file | that seat; refreshed through the server first when it expires within 60 s, as today |
| `live: true`, the seat (or no seat) served by the live login | **live login** (rules below) |
| `reason: "no-usable-seat"` | **no identity**; the error is `no-usable-seat` |
| failure (`unreachable`/`timeout`/`warming`) and the conversation has a cached answer | the cached answer |
| failure, no cached answer, seats exist | **no identity**; the error is `seat-service-unavailable` |
| failure, no cached answer, no seats | live login if usable, else as today: OpenCode's own credential |

**Live login rules.** These fix the PR #1685 review finding that refusing soon-to-expire tokens broke
single-login boxes.
- When the token expires within 60 s and the answer named a seat, ask the server to refresh it, then
  re-read the file, as today.
- Refuse the token only when it has actually expired (`expiresAt <= now`) or this plugin instance saw it
  answer 401 (remembered by sha12 until the file holds another token).
- An empty token counts as absent.
- If the live login is refused and seats exist, there is no identity (`seat-service-unavailable`).
- If the live login is refused and there are no seats, behave as today (OpenCode's own credential).

### 4.4 Failing closed, without throwing

The hook never throws: OpenCode wraps promise hooks with `Effect.promise`, so a rejection would become an
unhandled defect, not an error message. When there is no identity and seats exist, the plugin does this:

1. `onRequest` rebuilds the request with `authorization` and `x-api-key` **removed**, so no stored key
   ever leaves. The request is recorded as `unsigned` with its error kind.
2. `onResponse` for an unsigned request tries ONE more lookup with a 3 s budget.
   - **A seat is found:** the request is resent signed, and the resent response goes through the normal
     recovery path.
   - **Still nothing:** the response is replaced by a synthetic Anthropic-style error:

| Error kind | Status | Body `error.type` | Retry |
|---|---|---|---|
| `seat-service-unavailable` | 529 + `retry-after: 3` | `overloaded_error` | OpenCode retries, at most 10 times (about 84 s), and each retry runs the hook again |
| `no-usable-seat` | 401 | `authentication_error` | none; the user sees the message |

The messages are fixed strings and never contain a token:
- `Manta could not reach its seat service to pick a Claude seat for this conversation; retrying.`
- `Manta has no usable Claude seat right now (all seats are signed out or failing). Open Settings → Accounts.`

### 4.5 Recovering on another seat

The response recovery path in `recover()` becomes:

1. **401 on a seat.** Ask the server to refresh the seat, re-read it and retry once (unchanged). If the
   refresh fails or the retry also gets 401, call `/limit` with `reason: "auth"`. If the conversation
   moved to a different seat, resend once there.
2. **401 on the live login.** Remember the token as dead, refresh it (unchanged), and retry once if the
   token changed. Otherwise, when seats exist, forget the cached answer, ask for a seat again, and resend
   once on that seat.
3. **429/529 blips, long-context betas, and a usage-limit 429 moving to another seat:** unchanged.

At most one request is resent on another seat per original request, across steps 1, 2 and 3.

### 4.6 Deploy

The plugin is installed by copying it (`prepare` copies `docs/opencode-plugins-v2/*` into
`~/.config/opencode/plugins/`). The new plugin and the new server must ship together: the plugin relies
on `reason` and `/limit {reason}`. An older server simply never sends `reason`; the plugin then decides
"seats exist" from the directory, so mixed versions degrade safely.

Restart order: deploy the server code and copy the plugins, restart `manta-server`, then restart
`opencode-serve`. Restarting opencode drops in-flight turns, so it needs the user's window.

## 5. Side fix: tests never touch the real Claude login

- `CREDENTIALS_PATH` (`claudeAuth.mjs`) honours `CLAUDE_CONFIG_DIR`, as the CLI and the plugin already do.
- `scripts/testSandbox.mjs` sets `CLAUDE_CONFIG_DIR=<sandbox>/.claude`, and `vitest.config.ts` passes it
  through.
- A canary test asserts that `CREDENTIALS_PATH` resolves inside the sandbox.

## 6. Tests (all with injected I/O, no live opencode, tmux or network)

Server (`node:test`):
- **20 concurrent new conversations.** p99 resolve ≤ 5 ms with the table warm, no global lock, and none
  of them answered `live` while seats exist.
- **Parent and sub-agent.** Their first requests arrive concurrently and land on one seat; so does a
  grandchild through the child link.
- **Pin pruning.** Idle pins over 6 h are dropped, the caps are enforced in LRU order, a 5 h move-back
  block survives while the pin is alive, and child links are touched on use.
- **Saves.** N placements in a burst produce one save; a pure `lastUsedAt` touch saves at most every
  10 min; `flush` saves at once.
- **Table not ready.** `resolve` waits up to 3 s, then the route answers 503 `warming`.
- **Live identity.** A 401 from the profile API is remembered until the token changes; an empty token
  makes no call; a hung profile fetch times out.
- **Credential recovery.** It is skipped when the failing session sits on a directory seat, when the live
  file is empty, and when it is remembered dead for the same content.
- **`/limit` with `reason: "auth"`.** The seat is marked unusable for 5 min, the conversation moves to a
  same-org seat first, and a successful refresh clears the mark.
- **Pacing.** Five conversations forced off one seat are spread across same-org targets instead of
  piling onto one.
- **Answers.** One seat yields `seatResult`; `reason` is correct for no-seats and no-usable-seat.
- **Sandbox canary.** `CREDENTIALS_PATH` resolves inside the sandbox.

Plugin (`scripts/opencode-v2/claude-max.test.mjs`):
- **Uncached lookup.** One request with the full budget, and no retry storm: the fake server sees
  exactly 1 call when it answers in 4 s.
- **Seats exist, server unreachable.** The request goes out without `x-api-key`/`authorization`, then a
  synthetic 529 with the message.
- **No usable seat.** A synthetic 401 `authentication_error`.
- **Second lookup succeeds.** An unsigned request is resent signed when the 3 s lookup in `onResponse`
  finds a seat.
- **Live token expiring soon on a single-login box.** It is refreshed and used; this guards the PR #1685
  regression.
- **Live token rejected.** An expired token, or one that got a 401 earlier, is never used again while
  the file is unchanged.
- **No seats and no live login.** OpenCode's own credential is untouched, so API-key boxes are unchanged.
- **401 on a seat.** Refresh fails, `/limit {reason:"auth"}` moves the conversation, and the request is
  resent once on the new seat. No second resend.
- **Hook order.** `setup` registers the http hooks first, checked with a fake `ctx` that records the
  registration order.

## 7. Libraries considered

Numbers fetched 2026-11-12 (GitHub API, npm registry).

| Need | Chosen | Considered, and why not |
|---|---|---|
| Multi-account routing/failover as a whole | Own code in the existing accounts layer, borrowing patterns (MIT) | **TeamClaude** (494★, MIT, pushed 11-10, npm 0.2.7, 13 downloads/week): header-fed quota and paced failover are good ideas, but running it adds a second token refresher. Claude refresh tokens rotate, so two refreshers sign each other out, and it would replace Manta's accounts UI and events. **CLIProxyAPI** (58,371★, MIT, Go): the same refresh-ownership conflict, plus a separate Go service. **ccflare** (1,054★, MIT, last push 2026-04-19): only sticks a session to an account; we use it as a reference for failover order. **claude-relay-service** (12,803★, MIT): a full hosted relay, superseded by sub2api, so not a fit. **LiteLLM router** (63,157★, Python): the reference design for in-memory routing and session affinity, but not embeddable in Node. |
| In-memory seat table | Own module (a map plus timer) | Nothing to adopt: the table is the existing `seatStates` answer, kept in memory. |
| Watching the seat directories | `node:fs.watch` recursive, best effort, with a periodic rebuild as backstop | **chokidar** 6.0.0 (12,266★, MIT, 272 M downloads/week): robust, but would be a new dependency for an optional trigger. The 10 s rebuild is the guarantee, so an occasional missed event costs at most 10 s. |
| Locking | None: synchronous decisions (§3.2) | **async-mutex** 0.5.0 (already a dependency, 1,436★, 17 M/week): not needed once nothing awaits between reading and writing. |
| LRU caps on pins | Own pruning in `pruneAssignments` (sort by `lastUsedAt`) | **lru-cache** 11.5.3 (already a dependency, 784 M/week): the pins are a plain JSON-persisted object with TTL rules tied to placement semantics; pruning in place on save is a few lines and keeps the file format. |
| Debounced save | Own (two timers) | **lodash.debounce**-style packages: two timers do not justify a dependency, and the save also needs single-flight. |
| Retry/backoff in the plugin | Own: no retry loop any more (one request with the full budget, then one later attempt) | **p-retry** 9.0.0 (1,040★, MIT, 69 M/week): the plugin is copied standalone with no `node_modules`, and the design no longer needs a backoff loop. |
| Synthetic provider error | Own (an Anthropic-shaped JSON error body) | None: this is the provider's own wire format. |

## 8. Out of scope

- Usage readings taken from `anthropic-ratelimit-unified-*` response headers. Worth doing next as a
  follow-up: the poller remains the source here, and pacing (§3.7) covers the readings lag for forced moves.
- Removing OpenCode's stored Anthropic key from `auth.json`: it is the user's credential. Since the plugin
  removes it from requests whenever seats exist, it can no longer cause a failure.
