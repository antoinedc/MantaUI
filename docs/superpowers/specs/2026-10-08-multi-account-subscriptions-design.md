# Multiple accounts & seats per subscription provider — design

Status: DRAFT for agreement · 2026-10-08 · branch `work/multi-account`

Related: `docs/subscription-providers.md`, `docs/adaptive-cto-spec.md` §11.2–11.3,
`docs/routing-scenarios.md`, `docs/endpoint-health-spec.md`,
`docs/superpowers/specs/2026-06-29-provider-management-design.md`.

## 0. Goals / non-goals

Goals
- A subscription provider (v1: **Claude** and **Codex/ChatGPT**) can hold several
  **accounts**, each with several **seats**, each with a custom label.
- Per provider, when it has ≥2 seats: **Manual** mode (the user picks the seat in
  the provider list) or **Automatic** mode (Manta picks, using 5h + weekly limits).
- Seat choice is **per conversation**, so switching never breaks the prompt cache of
  conversations that did not need to move.
- Fix the missing weekly limit (Team plans report it in a different field).

Non-goals (v1): Kimi / API-key providers; automatic compaction on move; moving a
turn mid-stream; sharing seats across boxes.

**Terms-of-service note.** Rotating several *personal* subscriptions to get around
one plan's limits may breach the provider's terms. Team/Enterprise seats are each
licensed to a person. The UI says this once when a second account is added; we do
not enforce it.

## 1. Findings that shape the design

1. **Weekly limit missing (bug).** This box is on Claude **Team** (`team_tier_1`,
   usage tier Max 5x). Anthropic returns `seven_day: null` and puts weekly limits in
   a newer `limits[]` list (`{kind, group, percent, resets_at, scope, is_active}`),
   e.g. `weekly_scoped` for one model ("Fable"), inactive. Manta only reads
   `seven_day`, so it shows 5h only.
2. **Per-conversation routing is possible (spike, verified live on opencode
   1.18.34).** Every model request carries `x-opencode-session-id` (and
   `x-opencode-parent-session-id` for sub-agents). A plugin's `auth.loader` fetch sees
   it. A user plugin registering `auth.provider:"openai"` **overrides** the built-in
   Codex loader and receives the same header.
3. **Everything downstream is keyed by provider**: usage poller, stopper, resume,
   pacing, forecast, routing (`accounts[providerID]`). Today there is no account
   dimension anywhere.
4. Claude credentials on Linux are one hard-coded file (`~/.claude/.credentials.json`),
   cached 30 s in the plugin; Codex lives in opencode's `auth.json.openai`, re-read
   per request.
5. **The prompt cache is per organization.** Moving a conversation to a seat in a
   *different* org re-sends its whole history once (cache write, 1.25×) and bills it to
   the new seat. Whether two seats of the *same* Team org share cache is **unverified**
   (Phase 0).

## 2. Model

```
Provider (claude | codex)
 └─ Account   id, label, orgId?, orgName?, plan, mode-independent
     └─ Seat  id, label, email, accountUuid, credential file, status
```
- A personal plan = an account with one seat (UI hides the seat level when an
  account has exactly one seat).
- Seats are grouped into accounts automatically by org id (from the profile call);
  the user can relabel anything. Signing the same login in twice is refused
  ("already added as …").
- Per provider: `mode: "manual" | "auto"` (default `auto` once a second seat
  exists), `activeSeatId` (used by manual mode and as the default).

Storage (server-only, never sent to the renderer):
- `~/.manta/accounts.json` (0600, atomic write): providers → accounts → seats
  metadata + mode + activeSeatId + conversation assignments.
- Credentials: `~/.manta-secrets/accounts/<provider>/<seatId>.json` (0600, dir 0700).
- **Migration:** the existing Claude login becomes Seat 1 of an auto-created account
  and **keeps its current file** (`~/.claude/.credentials.json`), so the `claude`
  CLI and today's refresh sweep keep working. Same for Codex (`auth.json.openai`
  copied into the seat store; the original is left in place).

## 3. Sign-in per seat

- **Claude:** the existing `claude auth login` flow, run with
  `CLAUDE_CONFIG_DIR=~/.manta-secrets/accounts/claude/<seatId>/` so the CLI writes
  the new seat's credentials there instead of overwriting Seat 1 (verify in
  Phase 0). After login, call the profile endpoint for email / org / plan / seat tier.
- **Codex:** reuse opencode's OpenAI OAuth flow, then move the resulting entry out of
  `auth.json.openai` into the seat file and restore the previous entry.
- Token refresh: today's refresh sweep is generalised to iterate seats; each seat
  refreshes and writes back to its own file. The plugin refreshes on demand too
  (single-flight per seat).

## 4. Request path (the plugins)

One authority, the server:

```
GET /api/accounts/resolve?provider=claude|codex&sessionID=&parentSessionID=&model=
→ { seatId, credentialsPath }
```
- **Claude:** extend our fork `opencode-claude-auth-bui`. Its fetch reads
  `x-opencode-session-id` and asks resolve (cached per conversation 30 s), then loads
  that seat's credentials (per-seat 30 s cache, per-seat refresh + write-back).
  `syncAuthJson` keeps syncing **Seat 1 only** (opencode needs an `oauth` entry to
  enable the provider).
- **Codex:** new Manta plugin `manta-accounts` registering `auth.provider:"openai"`.
  It must reproduce the built-in Codex fetch behaviour (URL rewrite to the ChatGPT
  Codex endpoint, `ChatGPT-Account-Id`, `originator`, refresh). That is a risk to pin
  in Phase 0 by diffing against the built-in.
- **Fail-safe:** if manta-server is unreachable, the plugin uses the last assignment
  it saw for that conversation, else the provider's active seat. A model request
  never fails because the resolver is down.
- **Sub-agents** always use their parent's seat (they share its cached prefix).

## 5. Choosing a seat

### 5.1 Limits per seat
Each seat has a **5h** window and a **weekly** window. Weekly comes from `seven_day`
or from `limits[]` entries in group `weekly`:
- an unscoped one is the account-wide weekly;
- a model-scoped one (`scope.model.display_name`) applies only to conversations on
  that model family;
- `is_active:false` entries are shown greyed and ignored.

**Seat load** = the higher of its 5h % and weekly % (including the scoped weekly for
the conversation's model). This one number drives every decision.

### 5.2 Manual mode
- The user picks the seat in the provider list. All conversations use it from their
  **next turn**.
- Picking a seat shows the cost once: "Conversations will re-send their history to
  the new seat on their next message."
- If the chosen seat hits a limit, existing usage-stop/resume behaviour applies (no
  automatic move in manual mode).

### 5.3 Automatic mode — the simple default
Four rules, in this order. Defaults are shown; nothing else is tunable in v1.

1. **New conversation → least-loaded seat.** Ties go to the active seat.
2. **A conversation stays on its seat.** Its sub-agents use the same seat.
3. **It moves only when its seat reaches 90%** (5h or weekly), or the seat is blocked
   or signed out. It moves to the least-loaded seat that is under 70%; if none is under
   70%, it stays until 100% and then takes any seat with room.
4. **At most one move per conversation per 5 hours**, and never back to a seat it
   left in that period (no flip-flopping).

Why this is cheap:
- Rules 1–2 mean a conversation normally lives its whole life on one seat, so it
  keeps its cache.
- Rule 3 moves before the hard wall, so a turn is never cut mid-way.
- Rule 4 caps the waste at one history re-send per conversation per 5h, which is
  roughly what an idle cache expiry already costs.
- There is no automatic compaction: it loses detail and is a separate decision.

Every move is logged and shown in the conversation as a one-line notice, e.g.
"Moved to Work · Seat 2 (Seat 1 at 91% of 5h). History re-sent: 84k tokens."

### 5.4 Interaction with existing systems (minimal change)
Downstream consumers keep their per-provider shape through a **provider aggregate**
snapshot:
- auto mode: the least-loaded seat; exhausted only when all seats are.
- manual mode: the active seat.

So routing (Auto model choice), pacing, forecast, stopper and resume need no
structural change in v1. They see a provider that still has room while any seat
does.
- Stopper: a turn stops only if its seat is exhausted and (auto) no seat has room.
- Resume: resumes when any seat recovers (auto) or the active seat recovers
  (manual); the resumed turn is re-placed by rule 1.

## 6. Usage polling
- One usage call per seat per poll. Each snapshot gains
  `{accountId, seatId, seatLabel}`, plus the aggregate per provider as in §5.4.
- Usage history is keyed `<provider>:<seatId>:<kind>`; existing provider keys are
  kept for the aggregate.
- The Claude adapter parses `limits[]` (fixes §1.1) and emits `windows` with
  `kind: "session" | "weekly" | "weekly_scoped"`, `scope` and `active`.

## 7. UI (Settings → Accounts, desktop; iOS later)
- Provider row expands to accounts → seats. Each seat shows: label (editable), email,
  plan, 5h + weekly bars, and "used by N conversations".
- With ≥2 seats: a **Manual / Automatic** toggle. In manual mode each seat has a
  "Use this seat" radio.
- Actions: Add account, Add seat (runs sign-in), Rename, Remove seat (its
  conversations are re-placed on their next turn).
- Session header: the context pill popover shows "Seat: Work · Seat 2". The usage
  dial shows **this conversation's seat**, not the provider.
- Every control follows the "never a dead control" rule: success and failure are
  both shown.

## 8. Contract (pinned for parallel implementers)

RPC (`/rpc/<channel>`, renderer):
- `accounts:list` → `{ providers: [{ provider, mode, activeSeatId, accounts: [{ id,
  label, orgName, plan, seats: [{ id, label, email, status:
  "ok"|"expired"|"signed-out", windows: UsageWindow[], conversations: number }] }] }] }`
- `accounts:set-mode` `{provider, mode}` · `accounts:set-active` `{provider, seatId}`
- `accounts:rename` `{kind: "account"|"seat", id, label}` (1–40 chars)
- `accounts:add-account` `{provider, label}` → `{accountId}`
- `accounts:add-seat` `{provider, accountId?, label?}` → existing connect shape
  (`claude-login` / OAuth) + `seatId`; `accounts:seat-status` `{seatId}` polls it.
  After login, a profile/org mismatch returns `{warning:"different-org", orgName}`
  and offers to create a new account.
- `accounts:remove-seat` `{seatId}`
- Errors: `{error: "duplicate-login"|"unknown-seat"|"invalid-label"|"login-failed"}`
  (class-1: safe literal text).

REST (plugins, Bearer box token): `GET /api/accounts/resolve` (§4).

Bus: `accounts.updated` (list changed), `accounts.moved {sessionId, provider, from,
to, reason, resentTokens}`.

## 9. Phases
0. **Spike leftovers** (needs a second Claude seat login):
   (a) `CLAUDE_CONFIG_DIR` login writes a separate credential;
   (b) measure the cache across two seats of the same org (does a move re-send?);
   (c) diff the built-in Codex fetch to copy it faithfully.
   If (b) shows a shared cache, rule 4's cap can be relaxed for same-org moves.
1. Weekly fix (`limits[]`) + seat store + migration + per-seat usage polling + aggregate.
2. Plugins: Claude fork resolver, `manta-accounts` Codex plugin, resolve route, fail-safe.
3. Manual mode + Accounts UI + session seat display.
4. Automatic mode (§5.3) + move notices + activity log.

Implementer ownership: server (`src/server/accounts*.mjs`, usage adapters, rpc
wiring) · plugins (fork + `manta-accounts`) · renderer (`AccountsCard`, header,
dial). Each phase ships tests for its pure logic (seat choice, aggregate, limit
parsing, migration).

## 10. Decisions (2026-10-08)
- Spec approved as drafted (thresholds 90/70, one move per 5h).
- Fork source: `github.com/antoinedc/opencode-claude-auth` (published as
  `opencode-claude-auth-bui`). Claude seat resolution lands there as a new `-bui`
  release, and the installer pin is bumped.
- iOS Accounts screen ships in phase 3, alongside the desktop UI.
- Seats are not discoverable: OAuth tokens cannot list org members (verified: the
  members endpoints 404, or reject OAuth tokens). Each seat is added by signing in as
  that member.
- Phase 0 (a) confirmed: `claude` with `CLAUDE_CONFIG_DIR` set starts logged out,
  with its own config directory.
