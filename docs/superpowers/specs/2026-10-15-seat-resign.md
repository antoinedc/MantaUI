# Sign a logged-out seat back in from the usage popover

## Goal

When a subscription seat's login is dead, the usage popover says so with a
**Logged out** badge. Clicking it opens a modal that runs the sign-in for **that
same seat**. When the sign-in lands, the seat, its usage bars and the popover
update on their own — no reload, no trip to Settings.

## What "logged out" means

A seat shows the badge when its view status is `signed-out` or `expired`
(`seatStateText` non-null). The live login is still always reported `ok`
(unchanged; re-signing the box's own live login is out of scope).

**New signal — a Claude seat answering 401 is signed out.** Today a Claude
usage 401 only logs a warning, so a dead seat keeps showing `ok` (seen live:
seat 3). New rule, for a NON-live Claude seat:

1. usage fetch → HTTP 401 → run that seat's credential refresh once
   (existing `refreshClaudeSeatAndNote`, single-flight per seat);
2. refresh ok → retry the usage fetch once; refresh reason
   `refresh-token-expired` → `expired` (existing behaviour);
3. any other refresh failure, or a 401 again after a good refresh → store
   status `signed-out` (the first writer of that value).
4. A later successful usage reading or refresh puts the seat back to `ok`
   (same as `expired` today).

Codex keeps its existing 401 path.

`usable` already excludes `signed-out`, so the seat assigner stops placing
conversations on it.

## Contract (already committed in this branch — code against it)

`src/shared/types.ts` / `src/shared/api.ts` / `httpApi.ts`:

| Channel | Input | Answer |
|---|---|---|
| `accounts:resign-seat` | `{provider, seatId}` | `{flowId, connect}` or `{error: AccountsError}` (`unknown-seat`, `unknown-provider`, `login-failed`) |
| `accounts:resign-status` | `{flowId}` | `ResignStatusResult` `{state: pending\|ok\|failed, error?, expectedEmail?, gotEmail?, seat?}` |
| `accounts:resign-cancel` | `{flowId}` | `{ok: true}` (unknown flow → `{ok:true}` too) |

`connect` is the same `SeatConnect` shape as add-seat (`claude-login` with
`sessionKey` for the terminal pane + code paste; OAuth/device shapes for Codex).

`error: "unknown-flow"` on resign-status = the box forgot the flow (restart,
timeout) — the UI treats it as failed with "try again".

## Box behaviour (server)

- **Never touch the existing seat until the new login is proven to be the same
  account.**
  - Claude: start `claude auth login` with `CLAUDE_CONFIG_DIR` pointed at a
    fresh TEMP directory beside the seat's (`<seatsRoot>/claude/.resign-<flowId>`,
    0700). On landing, read its credentials + profile. Same account
    (`accountUuid` match; fall back to email match when the seat has no uuid)
    → atomically replace the seat's `.credentials.json` (0600) with the new
    one, delete the temp dir, set status `ok`. Different account → state
    `failed`, `error:"different-account"`, `expectedEmail`/`gotEmail`, temp dir
    deleted, seat untouched.
  - Codex: reuse the add-seat mechanics (borrow the live slot via the provider
    auth start, restore the previous live login afterwards), but land the new
    login on the existing seat only after the same account check (Codex account
    id).
- One flow per seat: starting a re-sign for a seat that already has one cancels
  the old one first. Flows time out like add-seat (15 min) and are swept.
- Cancel deletes only the temp directory / restores the borrowed live login.
  It never removes or rewrites the seat.
- On success: emit the normal accounts change (the store save already fires
  `accounts.updated`) AND trigger an immediate usage poll (wire the usage
  poller's `tick` into the accounts manager; also use it after a successful
  add-seat). The poll result fires `usage.updated`, which the renderer already
  listens to.
- No credential in any answer, log line or event (same rule as add-seat).
- All 500s on these channels follow the existing accounts error handling.

## UI behaviour (renderer)

- **Usage popover (`UsageDial.tsx`)**
  - Current conversation's seat header and every "Other seats" row: when the
    seat's status is `signed-out`/`expired`, show a warn `Logged out` badge
    (a button). The existing "Fix" link is replaced by it.
  - Clicking it closes the popover and opens a **Modal** (mounted by the dial,
    outside the popover so an outside-click doesn't kill it) titled
    "Sign Seat N back in" with the seat's email.
- **`ResignSeatFlow`** (new component; share the phase machine / blocks with
  `AddSeatFlow` rather than copying — extract what is common):
  - calls `accountsResignSeat`, renders the Claude terminal + code paste or the
    device-code/URL block from `connect`;
  - polls `accountsResignStatus` every 2 s;
  - `ok` → shows "Signed back in as <email>" for ~1.5 s, awaits
    `refreshAccountsAndUsage()`, closes;
  - `failed` → a clear message: `different-account` → "You signed in as X, but
    this seat is Y. Sign in with Y." with **Try again**; `login-failed` /
    `unknown-flow` → "Sign-in didn't complete" + Try again;
  - closing/cancelling → `accountsResignCancel`, and the modal says nothing
    changed to the seat.
  - Every outcome is visible (no silent close, no swallowed errors).
- Seats panel in Settings: out of scope (mention as follow-up).

## Done

- Server tests: 401 → refresh → signed-out / ok paths; resign happy path
  replaces credentials and resets status; different account leaves the seat
  byte-identical; cancel never deletes the seat dir; one-flow-per-seat; usage
  tick called on success.
- Renderer tests: badge shown for signed-out/expired (header + other rows),
  hidden for ok; click opens the modal; ok path refreshes and closes;
  different-account message; cancel calls resign-cancel.
- `npm run typecheck && npm test` green.
