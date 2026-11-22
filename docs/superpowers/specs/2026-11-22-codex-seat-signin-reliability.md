# Codex seat sign-in reliability

Date: 2026-11-22. Status: agreed (user: "do both", same day).

## Problem (observed on the dev box, 2026-11-22 16:37–16:41)

Adding a second ChatGPT (Codex) account hung after the user pasted the device code, and a
seat that DID land was later listed as "logged out". Box logs show four defects:

1. **One click starts two sign-ins.** `[provider-auth] openai: oauth wait started` fired in
   pairs within ~1 s (attempts 1+2, 3+4, 5+6). Two `accounts:add-seat` calls ran
   concurrently; both computed the same new seat id (the id is reserved only after several
   awaits), both minted a device wait, and only one record survived in `pending`.
2. **The approved code can belong to the untracked attempt.** Attempt 5 was approved but the
   tracked record carried epoch 6 (`codex.oauthEpoch()` is read AFTER `startConnect`
   resolves, so it returns whatever attempt is newest, not the one this call minted). The
   landing was ignored (`ignoring superseded attempt 5`), the card spun until the 15-min
   timeout.
3. **Cancel during placement deletes a seat that then gets listed anyway.** Landing 16:39:35
   → seat dir written → `giveBackLive` took ~15 s → a cancel at 16:39:40 ran `failFlow` on
   the still-`pending` record and deleted the seat dir → `placeFlow` at 16:39:50 still
   wrote the seat into the store. Result: a listed seat with no credentials ("logged out").
4. **Placement is slow and silent.** ~15 s between approval and the seat appearing, with the
   card showing the same "waiting" state, invites the user to cancel/retry (which triggers 3).

## Required behaviour

### Server (`src/server/accountsManager.mjs`, `src/server/rpc.mjs`, `src/server/index.mjs`)

- **S1 — one add at a time per provider.** `addSeat` (and `resignSeat`) for a provider run
  under a per-provider mutex (`async-mutex`, already a dependency) covering everything from
  the supersede step through `pending.set`. Two concurrent adds can never get the same seat
  id or interleave their device waits.
- **S2 — a record owns the epoch it minted.** `providerAuthStart` (or the
  `codex.startConnect` wrapper) returns the epoch of the device wait it started; the record
  stores THAT value. No post-hoc global read.
- **S3 — idempotent add.** `accounts:add-seat` accepts an optional client `requestId`
  (string ≤ 64). A repeat with the same `requestId` while that flow is pending/ok returns the
  same `{seatId, connect}` without starting a new sign-in.
- **S4 — a landing for a superseded add-seat attempt is still used when it is the only
  candidate.** If a Codex login lands for an epoch whose record was superseded by a newer
  add-seat that is still pending, and the newer record has not landed, the landed login is
  processed for the NEWER pending record (it is the user's intent: "add a seat"), instead of
  being reverted by a guard. A landing for an abandoned flow with NO pending successor keeps
  today's guard behaviour (restore the previous live login).
- **S5 — no deletion mid-placement.** While a record is `processing` (or placing), `cancelSeat`,
  `failFlow` from supersede, and the timeout sweep must not delete its directory; a cancel
  that arrives mid-placement is recorded and honoured only if placement then fails. A
  placement that succeeds wins (the user approved the login).
- **S6 — never list a seat without credentials.** `placeFlow` verifies the seat's credential
  file exists immediately before the store mutation; if missing, the flow fails
  (`login-failed`) and nothing is listed.
- **S7 — report placement progress.** `accounts:seat-status` returns
  `{state:"pending", phase:"finishing"}` once a login has landed and placement is running
  (otherwise `phase` absent). Investigate why `giveBackLive` takes ~15 s and fix it if the
  cause is local (e.g. an avoidable reload/poll); otherwise document why in the report.

### Renderer (`src/renderer/AddSeatFlow.tsx`, its parents)

- **R1 — one click, one sign-in.** Find and fix why one click produced two `add-seat` calls
  (suspects: StrictMode double-invoked start effect in a dev build; a remount of the gate).
  The start effect sends a stable `requestId` (created once per flow instance, e.g. in a
  ref, and regenerated only on an explicit retry), so even a double-invoked effect resolves
  to one flow via S3.
- **R2 — never orphan a started seat.** If an `add-seat` response arrives after its effect
  was cancelled/unmounted and its seat is not the one the card shows, the card cancels it on
  the box.
- **R3 — show "Finishing…".** When status reports `phase:"finishing"`, the card says the
  login was received and the seat is being saved (no new controls; Cancel stays but per S5
  cannot lose an approved login).

## Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Per-provider serialization | `async-mutex` (already a dep, used by `sessionNaming.mjs`) | hand-rolled promise chain — rejected, the dep is already in the tree |
| Request idempotency key | `crypto.randomUUID()` (platform) | `uuid`/`nanoid` — unnecessary, native API exists |
| Everything else | existing accountsManager code | no library covers this domain logic |

## Tests (must exist and pass)

- Server (`accountsManager.test.mjs` / `accountsWiring.test.mjs`): two concurrent codex
  `add-seat` calls → distinct outcomes, one device wait per request; same `requestId` twice
  → one sign-in; record epoch equals the minted epoch even when another start happens in
  between; landing for superseded epoch with a pending successor places the seat (S4);
  cancel during a slow `giveBackLive` does not delete the dir and the seat ends `ok` with its
  credential file present (S5); placement with a missing credential file lists nothing (S6);
  status reports `phase:"finishing"` mid-placement (S7).
- Renderer (`SeatsPanel.test.tsx`): mounting `AddSeatFlow` under StrictMode results in one
  effective sign-in (one `requestId`); late response for a cancelled effect is cancelled
  (R2); "finishing" copy renders (R3).
