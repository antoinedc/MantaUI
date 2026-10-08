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
5. **The prompt cache is per organization, shared by every seat in it.** Verified on
   2026-10-08 with two `team_tier_1` seats of one org: seat 2 wrote a 28.8k-token
   prefix, and seat 1's first identical request read all 28.8k from cache (0 written).
   So a move between seats of the **same org costs nothing extra**. A move to a
   *different* org re-sends the whole history once (cache write, 1.25×) and bills it
   to the new seat.

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
GET /api/accounts/resolve?provider=claude|codex&sessionID=&parentSessionID=
→ { seatId, live: true }                                       (use the live login)
→ { seatId, live: false, provider, credentialFile, expiresAt? } (use this seat)
```
**The response never carries a credential.** The box's HTTP surface is reachable
from the internet through the gateway hostname and every paired device holds the
bearer token, so a token in a response body would let any of them pull Claude/Codex
credentials. `credentialFile` is the absolute path of the seat's file under
`~/.manta-secrets/accounts/`; the plugin (same OS user) reads the token from it,
after checking the real path is inside that directory. Both routes also refuse any
caller that is not DIRECTLY on loopback (a loopback socket and none of
`x-forwarded-for`, `x-forwarded-host`, `x-real-ip`, `forwarded`, `cf-connecting-ip`,
`cdn-loop`, which proxied public traffic always carries) with a 403.

**REVISED 2026-10-08 (spike-verified): one Manta plugin, no fork change, no auth
override.** `manta-accounts` (a plain opencode plugin at
`~/.config/opencode/plugins/manta-accounts.ts`) wraps the process-global `fetch` once
at load. Both the Claude plugin (fork 1.5.4-bui.1 and upstream 2.2.1) and the
built-in Codex loader send their final model request through the global `fetch`,
AFTER they have built every header and the body. The wrapper therefore sees the
finished request and only swaps the identity:
- It matches only model calls: `api.anthropic.com` `/v1/messages*` and
  `chatgpt.com` `/backend-api/codex/*`. Everything else passes through untouched,
  including token refreshes, profile and usage calls.
- It reads `x-opencode-session-id` (falling back to `x-opencode-parent-session-id`,
  then to Manta's own sub-agent → root map) and asks `resolve`.
- When the seat is the **live** login, the request passes through unchanged. This
  is the zero-risk default.
- Otherwise it replaces `authorization` with the seat's access token, read from the
  seat's credential file (cached by mtime, re-read after a refresh). For Codex it
  also sets `ChatGPT-Account-Id`, and recomputes `x-openai-internal-codex-residency`
  from the seat's token (removed when the seat has none).
- Nothing else in the request changes. The Claude billing header is derived from
  the messages, not the account.
- Seat tokens are kept fresh **server-side** (the §3 sweep); the plugin never talks
  to the provider's OAuth endpoints itself. A seat token within 60 s of expiry triggers
  `POST /api/accounts/refresh {seatId}` (single-flight on the server) before sending.
  A 401 from a non-live seat triggers one refresh + one retry; if that fails, the
  401 is returned as-is.
- **Installed automatically, never by hand.** Plugin sources live in
  `docs/opencode-plugins/` (a new directory, shipped in the release tarball).
  `install.sh` and `self-update.sh` both copy every `*.ts` there (excluding tests)
  into `~/.config/opencode/plugins/` as REAL copies. This is one shared helper in
  `scripts/lib/release.sh`, also present in install.sh's inline fallback.
  - Manta-owned plugins are tracked in `~/.manta/opencode-plugins.manifest`. A
    plugin removed from the repo is deleted on the next update. A user's own files
    in `plugins/` are never touched.
  - Any plugin change sets a flag that makes self-update restart opencode. It
    joins the existing conditional-restart table: payload replaced → both restart
    anyway; plugin-only change → opencode only.
  - Non-fatal like the tools refresh: a copy failure warns and never aborts the
    update.
  - On a box with one seat per provider the plugin is a pure pass-through, so
    shipping it to every user is safe.
- **Why not the fork / an auth override:** no npm release, and no copy of the
  Codex loader to keep in sync. Opencode's own Codex behaviour (URL rewrite, model
  list, `instructions`) keeps running. The live logins in `~/.claude` and `auth.json`
  stay exactly as they are and keep enabling both providers.
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
3. **It moves only when its seat reaches 95%** (5h or weekly), or the seat is blocked
   or signed out. It moves to the least-loaded seat that is under 70%; if none is under
   70%, it stays until 100% and then takes any seat with room.
4. **Prefer a seat in the same org.** A same-org move is free (the cache is
   shared), so it is always tried first. A move to **another org** happens at most
   once per conversation per 5 hours. Either way, a conversation never moves back to a
   seat it left in the last 5 hours (no flip-flopping).

Why this is cheap:
- Rules 1–2 mean a conversation normally lives its whole life on one seat.
- Rule 3 moves before the hard wall, so a turn is never cut mid-way.
- Rule 4 makes the common case (Team seats) free, and caps the cross-org waste at one
  history re-send per conversation per 5h, roughly what an idle cache expiry already
  costs.
- There is no automatic compaction: it loses detail and is a separate decision.

Every move is logged and shown in the conversation as a one-line notice, e.g.
"Moved to Work · Seat 2 (Seat 1 at 91% of 5h)." A cross-org move adds
"History re-sent: 84k tokens."

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

## 7. UI — Settings → Accounts (desktop + iOS, phase 3)
- Provider row expands to accounts → seats. Each seat shows: label (editable), email,
  plan, 5h + weekly bars, and "used by N conversations".
- With ≥2 seats: a **Manual / Automatic** toggle. In manual mode each seat has a
  "Use this seat" radio.
- Actions: Add account, Add seat (runs sign-in), Rename, Remove seat (its
  conversations are re-placed on their next turn).
- Session header: the context pill popover shows "Seat: Work · Seat 2".
- Every control follows the "never a dead control" rule: success and failure are
  both shown.

## 7a. Usage dial + popover (composer, desktop + iOS)

Today the dial shows one provider snapshot, and the popover lists its windows. With
seats:

**Dial (the ring).** It shows **this conversation's seat**: its load (§5.1) and tone.
Visibility follows today's threshold rule, applied to that seat. One addition: in
automatic mode, when the seat is above the move line (95%) and another seat has
room, the ring keeps its tone but shows a small "↷" badge (a move is coming).

**Popover, top to bottom** (width stays 320px):
1. **Header:** provider name + plan, and on the right a mode chip, `Automatic` or
   `Manual`. The chip only appears with ≥2 seats.
2. **This conversation:** "Work · Seat 2" (account · seat; just the account label
   when it has one seat), then today's window rows (5h, weekly, active model-scoped
   weeklies; inactive scoped ones greyed with "not active"), and today's extras.
3. **Last move** (only if this conversation moved in the last 5h): one line, e.g.
   "Moved from Seat 1 at 91% of 5h · 2h ago", plus "history re-sent: 84k" for a
   cross-org move.
4. **Other seats** (only with ≥2 seats). One compact row per seat, grouped by
   account with a small account heading only when there are ≥2 accounts:
   - label · two thin bars (5h, weekly) with % · a reset hint when ≥90% ("resets
     14:10") · "N chats" when in use;
   - signed-out / expired seats show that state and a "Fix" link to Settings;
   - **Manual mode:** each row has a **Use** button. It sets the provider's active
     seat. Same-org: immediate, and the toast says "All conversations now use Seat 3".
     Cross-org: confirm first ("conversations will re-send their history once").
   - **Automatic mode:** rows are read-only. The best next seat carries a "next"
     tag, so the user can see where a move would go.
   - The list scrolls inside the popover past 5 rows; the popover never grows past
     its max height.
5. **Other subscriptions** (only if another subscription provider is connected):
   one line each, "Codex · best seat 12% of 5h", clicking opens that provider in
   Settings → Accounts. This replaces having to open another conversation to see it.
6. **Footer:** "Manage seats" (opens Settings → Accounts) on the left, today's
   "updated Xs ago" on the right.

**One seat, one subscription:** looks exactly like today, plus the weekly fix.
No empty sections are rendered.

**Data:** the popover needs the conversation's seat and every seat's windows. It
uses `accounts:list` plus `accounts:session-seat` (§8), refreshed on open and on
`accounts.updated` / `accounts.moved`. Pure selectors (`seatLoad`,
`selectConversationSeat`, `orderOtherSeats`, `nextSeatHint`) live in `chatUtils.ts`
with tests; the "next" tag must use the **same** function the server uses for rule 3
(`src/shared/seatChoice.mjs`), so the hint can never disagree with the actual move.

## 8. Contract (pinned for parallel implementers) — v2, phase 3

All RPC channels are `POST /rpc/<channel>` (desktop `window.api`, iOS `MantaAPIClient`).
Credentials and emails' tokens never appear in any response.

Types:
```
SeatView = { id, label, email|null, status: "ok"|"expired"|"signed-out"|"unknown",
             live: boolean,               // this seat is the box's current login
             windows: UsageWindow[],      // latest per-seat reading ([] if none)
             load: number|null,           // seatLoad() (§5.1)
             fetchedAt: number|null,
             conversations: number }      // assignments currently on this seat
AccountView = { id, label, orgName|null, plan|null, seats: SeatView[] }
ProviderView = { provider: "claude"|"codex", mode: "auto"|"manual",
                 activeSeatId|null, routingActive: boolean,   // plugin seen (§4)
                 nextSeatId|null,          // auto: seat a new conversation / a move goes to
                 accounts: AccountView[] }
```
Channels:
- `accounts:list` `{}` → `{ providers: ProviderView[] }` (providers with ≥1 seat).
- `accounts:set-mode` `{provider, mode}` → `ProviderView`.
- `accounts:set-active` `{provider, seatId}` → `ProviderView`. Manual mode: EVERY
  conversation of that provider uses the active seat from its next request (the
  resolver ignores stored assignments in manual mode). Auto mode: only the
  tie-break / default.
- `accounts:rename` `{provider, kind:"account"|"seat", id, label}` → `ProviderView`
  (label trimmed, 1–40 chars, no control chars).
- `accounts:add-seat` `{provider, accountId?: string, label?: string}` →
  `{ seatId, connect }` where `connect` is the SAME shape the existing connect flow
  uses (`claude-login` with sessionKey for Claude; the opencode OAuth shape for
  Codex). Claude: the `claude auth login` launcher runs with
  `CLAUDE_CONFIG_DIR=<new seat dir>`. Codex: opencode's OAuth flow runs; on success
  the new `openai` entry is moved into the seat dir and the previous live entry is
  restored (the live login never changes).
- `accounts:seat-status` `{seatId}` → `{ state: "pending"|"ok"|"failed",
  error?: "duplicate-login"|"login-failed"|"different-org", seat?: SeatView,
  orgName?: string }`. On `ok` the seat is identified (profile) and placed:
  - with `accountId`, a different org → `failed` / `different-org`, and the seat is
    kept unplaced until `accounts:add-seat-confirm {seatId, newAccount:true}`;
  - the same login as an existing seat → `failed` / `duplicate-login`, and the new
    directory is deleted.
- `accounts:add-seat-confirm` `{seatId, newAccount: boolean}` → `ProviderView`.
- `accounts:cancel-seat` `{seatId}` → `{ok:true}` (aborts the login, deletes the dir).
- `accounts:remove-seat` `{provider, seatId}` → `ProviderView`. Refused
  (`{error:"live-seat"}`) for the live seat. Its conversations are re-placed on their
  next request; its directory is deleted.
- `accounts:session-seat` `{sessionId}` → `{ provider, seatId, seatLabel,
  accountLabel, lastMove?: {from, fromLabel, at, reason} } | null`.
  Null when the conversation has no assignment.
- Errors (class-1, safe literal text): `{error: "unknown-seat"|"invalid-label"|
  "live-seat"|"unknown-provider"|"login-failed"}`.

REST (plugins, Bearer box token, direct-loopback callers only): `GET
/api/accounts/resolve` and `POST /api/accounts/refresh` (§4) — they return a seat
id and its credential FILE, never a token.

Bus (`/events`):
- `accounts.updated {provider}` on any list change (mode, active, rename, add/remove,
  status, assignment counts).
- `accounts.moved {sessionId, provider, from, to, fromLabel, toLabel, reason:
  "load"|"exhausted"|"unusable", trigger: {kind, pct}|null, crossOrg}` on every
  AUTOMATIC move (manual switches publish only `accounts.updated`).
  `accounts:session-seat` → `lastMove` carries the same optional `trigger` / `crossOrg`.
  The provider view gains `moveTargetSeatId` (where a conversation on the most-loaded
  in-use seat ≥95% would go; null in manual mode / when it would stay).
- Every automatic move is also appended to the optimizer activity log as kind
  `seat-move`, whatever the optimizer switch says.

## 9. Phases
0. **Spike leftovers** (needs a second Claude seat login):
   (a) `CLAUDE_CONFIG_DIR` login writes a separate credential;
   (b) measure the cache across two seats of the same org (does a move re-send?);
   (c) diff the built-in Codex fetch to copy it faithfully.
   All three done (see §10).
1. Weekly fix (`limits[]`) + seat store + migration + per-seat usage polling + aggregate. (Done, #1563.)
2. `manta-accounts` fetch-wrapper plugin, resolve + refresh routes, sticky
   assignment + exhausted floor, self-installing plugins. (Done, #1564.)
3. Manual mode + Accounts UI + session seat display.
4. Automatic moves (§5.3 rules 3–4: 95/70, same org first, cross-org once per 5h,
   no move back within 5h), move notices on desktop + iOS, activity log.

Implementer ownership: server (`src/server/accounts*.mjs`, usage adapters, rpc
wiring) · plugins (fork + `manta-accounts`) · renderer (`AccountsCard`, header,
dial). Each phase ships tests for its pure logic (seat choice, aggregate, limit
parsing, migration).

## 10. Decisions (2026-10-08)
- Spec approved as drafted (thresholds 90/70, one move per 5h).
- 2026-10-08: the move line was raised from 90% to 95% (user decision). The 70%
  target line and the 90% reset hint in the seat rows are unchanged.
- ~~Fork release~~ superseded: seat routing is a Manta plugin wrapping `fetch`
  (§4). The fork and the installer pin are untouched.
- Phase 0 (c) done: the built-in Codex loader was mapped. It no longer needs
  copying, because the wrapper sits after it.
- iOS Accounts screen ships in phase 3, alongside the desktop UI.
- Seats are not discoverable: OAuth tokens cannot list org members (verified: the
  members endpoints 404, or reject OAuth tokens). Each seat is added by signing in as
  that member.
- Phase 0 (a) confirmed: `claude` with `CLAUDE_CONFIG_DIR` set starts logged out,
  with its own config directory.
- Phase 0 (b) confirmed: seats of the same org share the prompt cache (see §1.5).
  Seat 2 is signed in at `~/.manta-secrets/accounts/claude/seat-2/`; the migration
  in phase 1 adopts it.
