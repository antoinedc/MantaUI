# WS08 — Accounts: seats, sign-ins, provider connections, custom endpoints

Status: draft · Wave A · Owner files: `AccountsScreen.swift`, `AccountsStore.swift`,
`AccountsModels.swift`, new `Accounts*` / `Provider*` files, `MantaAPIClient+Accounts.swift`,
plus one small server hardening in `src/server/ptyWs.mjs` (§S1).

## Scope

| # | Feature | Today on iOS |
|---|---|---|
| F0 | Accounts screen restructure; remove every "use the desktop" sentence | Seats only; footer + fix rows point at the desktop |
| F1 | Add a seat / add an account (Claude, Codex) | Client methods exist, no UI |
| F2 | Re-sign a logged-out seat (same account only) | Text "Sign in … from the MantaUI desktop app" |
| F3 | Connect a subscription provider (Claude terminal sign-in, Codex device code, Kimi API key) | Nothing |
| F4 | Add a custom endpoint (test before save + model checklist) | Nothing |
| F5 | Per-model on/off switches on a saved endpoint | Nothing |
| F6 | Disconnect / Try again (subscriptions); Refresh / Send probe / Remove (endpoints) | Nothing |

What iOS already has and must be reused, not duplicated:

- `AccountsStore` (`MantaUI/AccountsStore.swift`): `accounts:list` + `accounts:session-seat`, bus
  refetch, 60 s poll, single-flight `perform`, feedback banner (`report`, private, line 340).
- `AccountsScreen` (`MantaUI/AccountsScreen.swift`): provider sections, mode control, seat rows,
  rename alert, remove confirmation (`confirmActionSheet`, `MantaUI/NativeActionSheet.swift:110`),
  `AccountsFeedbackBanner`.
- `AccountsModels.swift`: wire types `AccountsProvider/Account/Seat`, `AddSeatReply` (line 301,
  `connect` kept as opaque `JSONValue`), `SeatStatusReply` (line 307), `AccountsCopy` (line 654),
  `AccountsSelectors.rowAction` (line 1002; `.fix` for expired / signed-out seats).
- `MantaAPIClient.swift:510–540`: `accountsAddSeat`, `accountsSeatStatus`,
  `accountsAddSeatConfirm`, `accountsCancelSeat`. `accountsAction` (line 543) is **private** — the
  WS08 extension writes its own 4-line equivalent; `MantaAPIClient.swift` is not edited (C1).
- `MantaEventStore.addRawFrameHandler` (`MantaEventStore.swift:464`) receives every non-`stream`
  frame, including `kind:"pty"` frames (they are published to every `/events` subscriber,
  `src/server/rpc.mjs:2611–2626`, `src/server/events.mjs`).
- The usage sheet's "Fix" button already navigates to `AccountsScreen(focusProvider:)`
  (`UsageSheets.swift:422`), so F2 needs no mount there.

---

## F0 — Screen structure and copy

### Desktop today

`src/renderer/AccountsCard.tsx` renders ONE list (lines 900–1017): every subscription provider
from `opencode:provider-auth {action:"status"}` (Claude, Codex, Kimi — server table
`src/server/subscriptionProviders.mjs:38`) as a row with a state column and one control, the seats
panel (`SeatsPanel.tsx`) under a subscription row that has seats, then each custom endpoint, then
"Add endpoint" (`CustomProviderForm`). Row help text: `Supported · subscription · <plan>`
(`helpText`, line 189); custom rows: `Custom · …`.

### iOS design

`AccountsScreen` keeps its `List(.insetGrouped)` and gains a second data source.

**New store** `ProviderConnectionsStore` (new file `MantaUI/ProviderConnectionsStore.swift`,
`@MainActor final class`, `ObservableObject`) — refetch-driven like the desktop (no poll):
loads in parallel, on appear / pull-to-refresh / after every action it performs:

- `opencode:provider-auth {action:"status"}` → `[SubscriptionStatus]`
- `opencode:get-providers` → `[ProviderEndpoint]`
- `accounts:health` → `AccountsHealth`

Each source keeps its own `Phase` (loading / loaded / failed(reason)) so one failing source never
hides the others. Owned by `AccountsScreen` as `@StateObject` (created with
`MantaAPIClient.live()`); both existing call sites (`SettingsScreen.swift:175`,
`UsageSheets.swift:310`) keep compiling — add an `init` parameter with a default.
It posts `Notification.Name.mantaProvidersChanged` (declared in `ProviderConnectionModels.swift`)
after any change that alters which models exist (connect, disconnect, endpoint save / toggle /
remove) — see Contracts.

**Section layout** (pure builder `AccountsSectionPlan.build(statuses:seatProviders:endpoints:focus:)`
in `ProviderConnectionModels.swift`):

1. One section per subscription provider, in the box's status order, the `focusProvider` first.
   Section header = provider label (`SubscriptionStatus.label`). Rows:
   - **Connection row** (always): name, help `Supported · subscription · <plan>`, state text
     (F6 `describeAccountState`), one control (F3/F6).
   - If a seat view exists for the provider (`accounts:list` entry): the existing mode control and
     account/seat rows, unchanged except F1/F2 additions, then an **"Add <Provider> account"**
     button row (F1).
   - Seat providers map to status ids with a fixed table (same as desktop
     `SEAT_PROVIDER_OPENCODE_IDS`, `src/renderer/chatUtils.ts:3584`):
     `claude ↔ anthropic`, `codex ↔ openai`. A seat provider with no status row (old box) still
     gets its section, without a connection row.
2. **Custom endpoints** section: one block per endpoint (F5/F6), then a **"Add endpoint…"**
   navigation row (F4). Footer: "Custom endpoints are OpenAI-compatible servers you add yourself."
3. Error rows: a failed source shows one footnote row in its section,
   `Couldn't load subscriptions — <reason>` / `Couldn't load endpoints — <reason>` + "Try again".
   A failed `accounts:health` shows nothing (rows simply carry no health state — the desktop
   treats missing health as unknown, never healthy: `AccountsCard.tsx:252`).

Empty state (no status rows, no seats, no endpoints, all loaded): "Nothing is connected yet.
Connect a subscription or add an endpoint below." — but the subscription sections always exist
when the status call succeeded, so this only appears on a box that answers an empty status list.

### Copy removed / replaced (all in owned files)

| Where | Old | New |
|---|---|---|
| `AccountsScreen.swift:220` `providerFooter` | `AccountsCopy.addSeatOnDesktop` | footer removed (the Add rows are the action) |
| `AccountsScreen.swift:340` `.fix` row | "Sign in to this seat again from the MantaUI desktop app…" | F2 button / live-seat text |
| `AccountsScreen.swift:13–17` header comment | "no add a seat button on purpose…" | describe the new flows |
| `AccountsModels.swift:659` `addSeatOnDesktop` | — | deleted |
| `AccountsModels.swift:660` `noSeats` | "…from the MantaUI desktop app…" | "No subscription seats yet. Use Connect or Add account to sign one in." |
| `AccountsModels.swift:674,676` `removeConfirmMessage` | "…by signing in from the desktop app." | "…with Add account." |
| `AccountsModels.swift:300` / `MantaAPIClient.swift:510` comments | "iOS has no such flow" | (MantaAPIClient comment is left; not owned — harmless) |

Acceptance (F0): `grep -rn -i desktop MantaUI/Accounts*.swift MantaUI/Provider*.swift` finds no
user-facing string; existing `AccountsTests` still pass (they assert only prefixes of
`removeConfirmMessage`, `MantaUITests/AccountsTests.swift:660`).

---

## Shared sign-in machinery (used by F1, F2, F3)

### Connect shapes (wire)

`accounts:add-seat`, `accounts:resign-seat` and `opencode:provider-auth {action:"start"}` all answer
the same `connect` shape (`SeatConnect`, `src/shared/types.ts:2406`;
`OpencodeProviderAuthResult` start branch, `types.ts:3416`):

```
{ shape: "claude-login" | "oauth-auto" | "oauth-code" | "api-key",
  url?, instructions?, methodIndex?, sessionKey?, startedAt?, cwd? }
```

Pure decode `SignInConnect(json: JSONValue)` + mapping `SignInPhase.from(connect)` (port of
`signInFromConnect`, `src/renderer/SeatSignIn.tsx:33`): `claude-login` with a non-empty
`sessionKey` → `.claude(sessionKey, cwd ?? "~")`; `oauth-auto` → `.device(url, instructions)`;
anything else → nil. For seat flows nil means "This provider's sign-in can't be started from here
yet." and the half-made seat/flow is cancelled. For the connect flow (F3) `oauth-code` and
`api-key` are handled by F3 itself.

### Claude terminal sign-in — how iOS drives it (decision: NO terminal screen)

The brief suggested reusing the terminal screen. **Do not.** Reasons, verified in code:

1. iOS's terminal (`TerminalSocket` → `/pty` WebSocket, `TerminalModels.swift:159`) spawns its own
   pty through `src/server/ptyWs.mjs:90`, which calls `pty.spawn` directly and **bypasses** the
   `pty:spawn` RPC guard (`rpc.mjs:2611–2626`). That guard is what (a) refuses an unregistered
   `claude-auth-login` and (b) points a seat sign-in at the seat's own directory
   (`CLAUDE_CONFIG_DIR`). A login spawned through `/pty` would write the box's **live** Claude
   credentials and silently replace them — the exact incident the guard's comment describes.
2. `pty.spawn` reuses an existing pty for the same `sessionKey` and drops the new listener
   (`src/server/pty.mjs:159–170`), and `/pty` kills the pty when its socket closes — so the
   WebSocket cannot attach to a login started any other way.

So iOS drives the login exactly like the desktop renderer does, minus the xterm pane (which the
desktop collapses behind "Show what's happening on the server" anyway,
`ConnectProvider.tsx:1093`):

1. **Subscribe first.** `AccountsStore` registers ONE raw frame handler in `init` (weak self, the
   `WidgetLiveStore`/`UpgradeStore` pattern) that decodes `kind == "pty"` frames into
   `PtyEvent { sessionKey, kind: .data(String) | .exit(code: Int?) }` and sends them on a new
   `let ptyEvents = PassthroughSubject<PtyEvent, Never>()`. A sign-in controller subscribes with a
   Combine cancellable filtered on its `sessionKey` BEFORE spawning.
2. **Spawn** via RPC `pty:spawn` with args
   `[{sessionKey, cwd, cols: 500, rows: 50, launcher: {id: "claude-auth-login", flags: {}}}]`.
   500 columns (the server clamp maximum, `ptyWs.mjs`/`pty.mjs`) keeps the ~400-character OAuth URL
   on one line. A thrown error (e.g. "This sign-in has expired. Close it and start again.",
   `rpc.mjs:2622`) fails the flow with that text.
3. **Find the URL** in the accumulated data buffer with the desktop's pattern
   `https://claude\.com/cai/oauth/authorize\?[^\s\x07\x1b]+` (`ConnectProvider.tsx:999`), trailing
   `)].,;` stripped. iOS improvement: accept a match only when it is followed by a terminator
   (whitespace, `\x07`, `\x1b`) inside the buffer, so a URL split across two chunks is never taken
   half-read. Pure: `ClaudeLoginURL.extract(from buffer: String) -> URL?`. Buffer capped at 64 KB
   (keep the tail).
4. **Show** "Open the link below in your browser, then paste the code Claude shows you here."
   + the host-less URL + **Open** (`openURL`, system Safari) + **Copy link** (`UIPasteboard`,
   button label flips to "Copied"). Until the URL arrives: spinner "Waiting for the sign-in link…".
   If no URL arrives within 20 s of spawning: "The sign-in link didn't appear. Start again." with
   "Try again" (re-runs the whole flow).
5. **Code field** (`TextField`, no autocorrect/capitalisation, monospaced) + **Submit**:
   `pty:write` args `[sessionKey, code.trimmed + "\r"]`. Submit shows "Saving…" until the flow
   settles (done / failed / asks), matching `useSubmitSettle` (`SeatSignIn.tsx:64`). A write
   failure shows "Couldn't reach the server. Try again." under the field.
6. **Exit watch:** a `.exit(code)` with `code != 0` → fail now ("That code didn't work (it may
   have expired). Start the sign-in again.") instead of waiting out the deadline
   (`useClaudeLoginExit`, `SeatSignIn.tsx:86`). Exit 0 = success; keep polling the box.
7. **No event stream** (`AccountsStore` built without an event store): the Claude path fails at
   start with "Can't show the Claude sign-in link right now — reconnect and try again." (never a
   silent spinner). Device-code and key paths don't need the stream.

### Device-code block (Codex)

Port of `WaitingBlockBody` + `DeviceCodeSteps` (`ConnectProvider.tsx:859`, `DeviceFlow.tsx`):
"Step 1 — open this link" (host-less URL, **Open**, **Copy**), "Step 2 — enter the code" (large
monospaced code, **Copy**; auto-copy to the pasteboard when it first appears and say "copied to
clipboard"). Code parsed with `/\bcode[:\s]+([A-Z0-9]+-[A-Z0-9]+)/i` (`parseDeviceCode`,
`chatUtils.ts:1555`); unparsed + instructions present → "The code is in the message below — copy
it from there." and a disclosure "Message from ChatGPT" with the verbatim instructions
(`deviceCodeFallback`, `chatUtils.ts:1568`). A countdown line "M:SS remaining" against the 15-min
server limit (`formatRemaining`, `chatUtils.ts:1581`).

### Timing rules (iOS-specific, load-bearing)

The user leaves the app to sign in (Safari), so the app is suspended mid-flow. All deadlines use
**wall-clock `Date`** captured at flow start, never accumulated timer ticks; polling is a
`Task` loop with `Task.sleep` that simply resumes when the app returns. The box keeps waiting
15 min (`LOGIN_TIMEOUT_MS`, `src/server/accountsManager.mjs:89`). Pure:
`SignInClock.isExpired(startedAt:now:limit:)`.

### Sheet lifecycle

Every flow runs in a `.sheet` with its own `NavigationStack` (title + **Cancel** toolbar button).
While a sign-in is open on the box, `.interactiveDismissDisabled(true)` — a stray swipe must not
throw away a sign-in whose link the user is about to paste. **Cancel** awaits the box's cancel
call and reports both outcomes. `.onDisappear` runs a best-effort cancel only if the flow is still
open (covers the parent screen being popped).

---

## F1 — Add a seat / add an account

### Desktop today

`AddSeatFlow` / `AddSeatGate` (`src/renderer/AddSeatFlow.tsx`), mounted from `SeatsPanel.tsx:350–
385` ("Add seat to <account>" per account, "Add <Provider> account" once per provider) and from the
subscription row's Connect when the provider already has seats (`AccountsCard.tsx:497`).
State machine (lines 11–15): `starting → signin → ok | different-org | duplicate | timed out |
login-failed`. Copy:

- title: "Add a seat to <account>" / "Add a <Provider> account"; starting: "Preparing sign-in…"
- failures (`seatFailureMessage`, line 66): duplicate → "That login is already added as a seat.
  Sign in with a different account."; timed out → "The sign-in wasn't finished within 15 minutes,
  so the box stopped waiting. Try again and finish it in the browser."; else → "The sign-in
  failed — the code may have been wrong or expired. Try again."
- unreachable at deadline: "Couldn't reach the server to check the sign-in. If you finished it,
  the seat will appear in the list once the box is reachable."
- different-org (line 326): "That sign-in belongs to a different organization (<org>), so it
  can't join “<account>”. Create a new account for it?" → **Create new account** / **Cancel**.
- done (`finishAdded`, line 161): "Added <seat> to <account>." /
  "Added the account “<account>” — <email|seat> is signed in." / "Added <name> to <Provider>."
- ToS note before a second ACCOUNT (not a seat of an existing account), once per device
  (`AddSeatGate`, line 384; `SEAT_TOS_NOTE`, `chatUtils.ts:3891`): "Rotating several personal
  subscriptions to get around one plan's limits may breach the provider's terms. Team and
  Enterprise seats are each licensed to a person." → **I understand** / **Cancel**.

### Wire

| Channel | Args | Result |
|---|---|---|
| `accounts:add-seat` | `[{provider: "claude"\|"codex", accountId?, label?}]` | `{seatId, connect}` \| `{error}` |
| `accounts:seat-status` | `[{seatId}]` | `{state: pending\|ok\|failed, error?: duplicate-login\|login-failed\|different-org, seat?, orgName?}` |
| `accounts:add-seat-confirm` | `[{seatId, newAccount: true}]` | `ProviderView` \| `{error}` |
| `accounts:cancel-seat` | `[{seatId}]` | `{ok: true}` |
| `pty:spawn` / `pty:write` (Claude) | see shared machinery | — |

Server: `accountsManager.mjs` `addSeat` (838), `seatStatus` (915), `confirmSeat` (939),
`cancelSeat` (958; also kills the Claude pty via `claudeLogin.cancel`, `index.mjs:760–766`).
Refusals arrive as `{error}` results or rpc errors; existing `AccountsCopy.reason(forCode:)`
maps them (add none). Client methods already exist (`MantaAPIClient.swift:514–540`).

### iOS design

- Entry points in `AccountsScreen`: the provider section's last row **"Add Claude account"** /
  **"Add OpenAI account"** (label from `AccountsSelectors.providerName`); account header menu
  (`accountHeader`) and single-seat seat menu gain **"Add seat to <account>…"**. All disabled
  while `store.acting` or a sign-in sheet is open.
- New controller `AccountsSeatSignIn` (`MantaUI/AccountsSignInFlow.swift`, `@MainActor final
  class`, `ObservableObject`) with `mode: .add(provider, accountId?, accountLabel?)` or
  `.resign(...)` (F2) and `@Published phase`:
  `.tosNote | .starting | .claude(…) | .device(…) | .differentOrg(org?, busy) | .done(message) |
  .failed(message)`.
  - `.tosNote` only when `mode` adds a new account and the provider already has ≥1 account and the
    device hasn't acknowledged (`UserDefaults` key `manta.accounts.tosAck`). Pure:
    `AccountsSignInRules.needsTosNote(accountCount:acknowledged:addingAccount:)`.
  - Poll `accounts:seat-status` every 2 s; transient errors keep polling until the client limit
    (15 min + 30 s), then cancel and fail with the unreachable / timed-out message.
  - `ok` → `await accountsStore.refresh()`, compose the done message from the refreshed list
    (pure `AccountsSignInCopy.addedMessage(...)`), then `accountsStore.announce(message)` (new
    public wrapper around the private `report`) and dismiss the sheet. The new seat is on screen
    before the sheet closes.
  - different-org → **Create new account** calls `add-seat-confirm {newAccount:true}`; failure
    keeps the choice up and shows the error inline; success = done.
- View `AccountsSignInSheet` (`MantaUI/AccountsSignInSheet.swift`) renders every phase; failed
  shows the message + **Try again** (restarts at `.starting`) + **Close**.

### Pure logic + tests (`MantaUITests/AccountsSignInTests.swift`)

- `SignInConnect` decode from `JSONValue` (each shape, missing fields, wrong types).
- `SignInPhase.from` — claude with/without sessionKey, oauth-auto, oauth-code → nil, api-key → nil.
- `AccountsSignInRules.needsTosNote` truth table.
- `AccountsSignInCopy.seatFailureMessage(error:timedOut:)` three branches + unreachable text.
- `AccountsSignInCopy.addedMessage` — seat into named account, new account with email, fallback.
- `SignInClock.isExpired` at limit-1 ms / limit / limit+1 ms.
- `ClaudeLoginURL.extract` — clean URL, URL followed by `\x07`/ESC/space, trailing `).,;`
  stripped, URL at end of buffer with no terminator → nil, URL split across two appends → found
  only after the second.
- `PtyEvent.from(frame)` — data, exit with/without code, non-pty frame → nil, missing sessionKey → nil.

### Acceptance

- "Add Claude account" on a box with one Claude account shows the terms note once; after "I
  understand" it never shows again on that phone.
- Claude: the link appears, Open goes to Safari, returning and pasting the code adds the seat;
  the sheet closes and the banner says "Added the account “…” — x@y is signed in." and the row is
  already listed.
- A wrong code fails within seconds ("That code didn't work…"), not after 15 minutes.
- Codex: the device code is shown and copied; approving in Safari adds the seat.
- A login of another org offers "Create new account"; choosing it adds the account.
- Cancel tells the box (`accounts:cancel-seat`) and closes; if the box can't be reached the banner
  says "Couldn't cancel the sign-in on the server — it will expire by itself."
- The box's live login is never touched by an add-seat flow (CLAUDE_CONFIG_DIR path only via
  `pty:spawn` RPC; `/pty` is never used).

---

## F2 — Re-sign a logged-out seat (same account only)

### Desktop today

`ResignSeatFlow` (`src/renderer/ResignSeatFlow.tsx`), opened by the "Logged out" badge in the usage
popover (`UsageDial.tsx:483–498`). Modal title "Sign <seat> back in", subtitle
"<account> · <email|email unknown>", lead "Sign in with <email|this seat's account>. <seat> stays
as it is until the sign-in is confirmed to be the same account." Outcomes (lines 8–11, 46–60):

- ok → "Signed back in as <email>" (or "<seat> is signed back in"), held 1.5 s
  (`RESIGN_DONE_HOLD_MS`) while the list refreshes, then closes.
- different-account → "You signed in as <got>, but this seat is <expected>. Sign in with
  <expected>." (no expected email: "…but that isn't the account <seat> belongs to. Sign in with
  the same account.")
- other → "Sign-in didn't complete. <seat> was not changed — try again."
- timeout → "The sign-in wasn't finished within 15 minutes, so the box stopped waiting. <seat> was
  not changed — try again."; unreachable → "Couldn't reach the server to check the sign-in. <seat>
  was not changed — try again once the box is reachable."
- bad code exit → "That code didn't work (it may have expired). <seat> was not changed — start the
  sign-in again."
- Cancel → toast "Sign-in cancelled — <seat> was not changed." / on failure "Couldn't cancel the
  sign-in on the server — it will expire by itself. <seat> was not changed."

### Wire

| Channel | Args | Result |
|---|---|---|
| `accounts:resign-seat` | `[{provider, seatId}]` | `{flowId, connect}` \| `{error}` (`live-seat`, `unknown-seat`, `login-failed`, `unknown-provider`) |
| `accounts:resign-status` | `[{flowId}]` | `{state, error?: login-failed\|different-account\|unknown-flow, expectedEmail?, gotEmail?, seat?}` |
| `accounts:resign-cancel` | `[{flowId}]` | `{ok: true}` |

Types `src/shared/types.ts:2428–2441`; server `accountsManager.mjs:976` (`resignSeat`, refuses the
live seat with `live-seat` at line 988), `1051` (`resignStatus`), `1070` (`resignCancel`). Channels
registered `accountsManager.mjs:1128–1130`; desktop client `httpApi.ts:1214–1216`. NEW iOS client
methods in `MantaAPIClient+Accounts.swift` (C1).

### iOS design

- `AccountsScreen.seatRow`, `.fix` case: replace the desktop sentence with
  - not live → bordered button **"Sign in again"** → presents `AccountsSignInSheet` with
    `AccountsSeatSignIn(mode: .resign(provider, seat, accountLabel))`.
  - live (`seat.live`) → no button; text "This is the box's own login. Switch conversations to
    another seat, or remove this seat and add the account again." (the box refuses re-signing the
    live seat; see Open questions).
- Same controller/sheet as F1, different driver: poll `accounts:resign-status` every 2 s; done
  holds the message 1.5 s while `accountsStore.refresh()` runs, then dismisses and announces it.
- `live-seat` from the box (race: the seat became live) → "This is the box's own login, so it
  can't be signed in again from here." Add this as a resign-specific mapping in
  `AccountsSignInCopy`, not in `AccountsCopy.reason(forCode:)` (whose `live-seat` text is about
  removal).
- Usage sheet: its existing "Fix" → Accounts screen (focused) is the entry; no mount needed.

### Tests (`AccountsSignInTests.swift`)

- `AccountsSignInCopy.resignFailureMessage` — different-account with both emails, with only the
  seat's email, with none; login-failed; unknown-flow; timeout; unreachable.
- `ResignStatusReply` decode (all fields optional; unknown state → pending).
- Wire (`MantaUITests/AccountsRPCWireTests.swift`): `resign-seat` / `-status` / `-cancel` send one
  object arg; `{error:"live-seat"}` result throws `MantaError.server("live-seat")`.

### Acceptance

- An expired, non-live seat shows "Sign in again"; signing in with the same account flips it to
  healthy and shows "Signed back in as …".
- Signing in with another account leaves the seat untouched and names both emails.
- No "desktop" wording remains on a broken seat row.

---

## F3 — Connect a subscription provider (Claude / Codex / Kimi)

### Desktop today

`ConnectProvider` (`src/renderer/ConnectProvider.tsx`), opened by the row's **Connect** when the
provider has no seat view (`AccountsCard.tsx:476–511`); when it has one, Connect opens the F1
"add account" flow instead (so a live login is never replaced). Phases (lines 8–35):
`starting → waiting (device) | needsCode | needsKey | needsClaudeLogin | installingClaudeCli →
applying → done | failed`. Header "Connect <label>" + phase label (`connectPhaseLabel`).

- **Claude**: before sign-in, `opencode:claude-cli-status`; missing CLI → run the installer pty
  (launcher `claude-cli-install`), poll every 2 s for 5 min, then continue to sign-in with the same
  session key (lines 206–249, 365–445). Install copy: "The claude CLI isn't on this server yet.
  Installing it now via the official installer — no action needed." Install failure offers
  **Try again** / **Use a different model** / **Install manually** (https://claude.ai).
  Sign-in: shared terminal machinery; poll `claude-status` every 1 s for 5 min (lines 303–363):
  `completed` → applying with `restarted: true` (server already restarted opencode);
  `pre-existing` → applying (no restart; poll); timeout → "The Claude sign-in didn't complete in
  time. Try again."
- **Codex** (`oauth-auto`): device block; poll `oauth-status` every 3 s (lines 456–492): `ok` →
  applying; `error` → `deviceAuthErrorMessage` ("The sign-in code expired. Try again." /
  "Sign-in didn't start. Try again." / "Sign-in failed. Try again."). Leaving the wait unsettled
  sends `oauth-cancel`.
- **oauth-code** (server never picks it today, but supported): "Code from the page" field →
  `code` action; `unauthorized` → "That code didn't work. Try again."
- **Kimi** (`api-key`): optional "Get a key" link (the status row's `console`), "API key"
  password field + **Save** → `key` action; `unauthorized` → "That key didn't work. Try again.",
  else "Save failed: <error>".
- **applying** (lines 507–557): unless `restarted`, call `opencode:restart`; then poll `status`
  every 3 s up to 30 s for `connected` → "Connected." else "Saved, but the provider didn't come
  online. Check the credential and try again."
- failed → message + **Retry**. Starting failure → "Couldn't reach the server. Try again."

### Wire (`opencode:provider-auth`, one object arg; handler `rpc.mjs:2201–2340`)

| Request | Result |
|---|---|
| `{action:"status"}` | `{action:"status", providers:[{id,label,plan,console,docs,connected,managedExternally,managedBy}]}` |
| `{action:"start", id}` | `{action:"start", shape, url?, instructions?, methodIndex?, sessionKey?, startedAt?, cwd?}` (`providerAuthStart`, `rpc.mjs:350`) |
| `{action:"claude-status", sessionKey, startedAt}` | `{action:"claude-status", ok, progress?:{state:"no-file"\|"pre-existing"\|"completed", …}, error?:"unknown_session"}` |
| `{action:"oauth-status", id}` | `{action:"oauth-status", state:"pending"\|"ok"\|"error", error?}` |
| `{action:"oauth-cancel", id}` | `{action:"oauth-cancel", ok:true}` |
| `{action:"code", id, methodIndex, code}` | `{action:"code", ok, error?}` |
| `{action:"key", id, key}` | `{action:"key", ok, error?}` — the key is never returned or logged |
| `{action:"disconnect", id}` | F6 |

Other channels: `opencode:claude-cli-status` `[]` → `{installed, path}` (`rpc.mjs:2358`);
`claude:login-cancel` `[sessionKey]` (positional string) → `{ok:true}` (`rpc.mjs:2350`; drops the
server record only — the client must ALSO `pty:kill [sessionKey]`, `rpc.mjs:2638`, as the
desktop's Terminal teardown does); `opencode:restart` `[]` → `{ok}` | `{ok:false,error}`
(`rpc.mjs:1887`); `pty:spawn` / `pty:write` / `pty:kill` as above.

### iOS design

- Controller `ProviderConnectFlow` (`MantaUI/ProviderConnectFlow.swift`), view
  `ProviderConnectSheet` (`MantaUI/ProviderConnectSheet.swift`, sheet titled "Connect <label>").
  Phases mirror the desktop exactly (including `installingClaudeCli` and `applying`), timings and
  copy as above.
- Connection row control (F0): not connected → **Connect**; when the provider has a seat view,
  Connect presents F1 `.add(provider, accountId: nil)` instead (desktop rule,
  `AccountsCard.tsx:350–353`), after first awaiting `accountsStore.refresh()` so the decision uses a
  fresh seat list (`startConnect`, line 729).
- `unknown_session` from `claude-status` is terminal on iOS (the record is gone; it can never
  recover): fail at once with "This sign-in has expired. Start again." (desktop keeps polling
  until its 5-min cap — an iOS improvement, not a contract change).
- Cancel / close: waiting → `oauth-cancel`; Claude → `pty:kill` + `claude:login-cancel`;
  installing → `pty:kill`. Best effort, but the explicit Cancel reports a failure in the banner.
- Install pty: `pty:spawn [{sessionKey: "claude-install-<epoch ms>", cwd, cols: 120, rows: 40,
  launcher: {id: "claude-cli-install", flags: {}}}]`; the exit frame without a binary = installer
  failed. "Show what's happening" is deferred (see Deferred).
- On `done`: dismiss, `providers.refresh()`, `accountsStore.refresh()`, post
  `.mantaProvidersChanged`, banner "<label> connected."
- The key field is a `SecureField`; the value lives only in the controller's state and is cleared
  on submit and on dismiss. Never logged.

### Tests (`MantaUITests/ProviderConnectTests.swift`)

- `ProviderAuthStartReply` decode for each shape; `ClaudeStatusReply` decode (each progress state,
  `ok:false` + `unknown_session`).
- `ProviderConnectRules.next(after:)` — pure transition helper: claude-status completed →
  `.applying(restarted: true)`; pre-existing → `.applying(restarted: false)`; no-file → stay;
  oauth-status ok → applying; error → failed with `deviceAuthErrorMessage` text for `expired`,
  `not_started`, other.
- `DeviceCode.parse` / `DeviceCode.fallback` (desktop cases: `code: ABCD-1234`, lowercase, no code
  with instructions, empty).
- `formatRemaining` (0, mid, past limit, NaN-safe → "0:00 remaining").
- `keyErrorText` / `codeErrorText` (`unauthorized` vs other vs nil).

### Acceptance

- On a box with no Claude login, Connect → (installs the CLI if missing) → link → code → the row
  reads connected and Claude models appear in the model picker after `mantaProvidersChanged`.
- Codex connect shows the device code and finishes after approval.
- Kimi connect with a bad key says "That key didn't work. Try again." and keeps the field.
- Connect on a provider that already has seats opens "Add <Provider> account", never a live login.

---

## F4 — Add a custom endpoint (test before save + model checklist)

### Desktop today

`CustomProviderForm` (`src/renderer/CustomProviderForm.tsx`): "Add endpoint" box with **Name**
(placeholder "e.g. VoskaAI"; help "Provider id: <slug>"), **Base URL**
("https://api.voska.org/v1"), **API key (optional)** (password). Validation
`customProviderDraftError` (`chatUtils.ts:1625`): "Name is required." / "Name must contain a
letter or digit." / "Base URL is required." / "Base URL must start with http:// or https://".
**Probe endpoint** → `opencode:discover-models(baseURL, apiKey)`; errors: "Couldn't reach the
endpoint" / "The endpoint rejected the key" / "The endpoint didn't return a model list" +
`: <detail>`. Success → `ModelChecklist` (all pre-checked; filter box "Filter N models…";
"K of N selected · M shown"; **All** / **None** act on visible rows; "No model matches “q”.").
**Save N models** (disabled at 0; "Select at least one model.") → `opencode:set-providers
{upsert:[{id: slug, name, baseURL, apiKey, enabledModels}]}` → then `opencode:restart`
("Restarting opencode…") → reset. "Edit details" link returns to editing.

### Wire

| Channel | Args (POSITIONAL where noted) | Result |
|---|---|---|
| `opencode:discover-models` | `[baseURL, apiKey]` — two positional strings (`rpc.mjs:1843`; an object arg silently probes `""`) | `{ok:true, models:[{id}]}` \| `{ok:false, error:"unreachable"\|"unauthorized"\|"bad_response", detail?}` |
| `opencode:set-providers` | `[{upsert?:[ProviderInput], remove?:[id]}]` | `{ok:true}` \| `{ok:false, error}` |
| `opencode:get-providers` | `[]` | `[{id, name, baseURL, hasApiKey, enabledModels}]` (key never returned) |

`ProviderInput` = `{id, name, baseURL, apiKey?, enabledModels}` (`types.ts:3130`); `apiKey`
omitted = keep the stored key, `""` = no key (`providers.mjs:533`). `set-providers` edits
`opencode.jsonc` and hot-reloads (no restart; `providers.mjs:523–565`, root AGENTS.md "opencode.jsonc
writes go through exactly ONE writer").

### iOS design

- **"Add endpoint…"** row pushes `ProviderEndpointForm` (`MantaUI/ProviderEndpointForm.swift`,
  controller `ProviderEndpointDraft` in `ProviderEndpointModels.swift`). Native `Form`:
  Section "Endpoint": Name, Base URL (`.URL` keyboard, no autocorrect), API key (`SecureField`,
  footer "Optional. Stored on your box; never shown again."), derived id footnote
  "Provider id: <slug>". Inline validation message under the section.
- Toolbar/bottom button **"Test endpoint"** (desktop "Probe endpoint"; same call) — disabled while
  the draft is invalid; shows "Testing…" with a spinner.
- After a successful test: Section "Models" with a `.searchable`-style filter field, "K of N
  selected · M shown", **All** / **None** (visible rows only), and one `Toggle` per model id
  (monospaced). Editing Name / Base URL / key after a test clears the result (desktop "Edit
  details" equivalent) so a stale test can't be saved.
- **"Save N models"** (disabled at 0 selected) → `set-providers` upsert. **No `opencode:restart`**
  (see Open questions): on `{ok:true}` re-read `opencode:get-providers`, confirm the id is
  present, pop back, banner "Added <name> with N models.", post `.mantaProvidersChanged`.
  `{ok:false}` → error under the button, form kept.
- **Id collision guard (iOS addition):** if the slug equals an existing endpoint id or a
  subscription id (`anthropic`, `openai`, `kimi-for-coding`, or any id in the status list), show
  "An endpoint with the id “<slug>” already exists — choose another name." and disable Test.
  (An upsert would otherwise overwrite that provider.)

### Pure logic + tests (`MantaUITests/ProviderEndpointTests.swift`)

- `ProviderEndpointDraft.slug(name)` — port of `slugifyProviderId` (`chatUtils.ts:1608`):
  "VoskaAI" → "voskaai", "My  Box!" → "my-box", "--" → "".
- `ProviderEndpointDraft.validationError(name:baseURL:takenIds:)` — each desktop message + the
  collision message.
- `discoverErrorText(error:detail:)` — three codes ± detail.
- `ModelChecklistState` — filter (case-insensitive substring), counts line, All/None only on
  visible ids, `allChecked`/`noneChecked` disabling rules, empty-filter message.
- Wire: `discover-models` sends `args: [baseURL, apiKey]` (two strings, NOT an object);
  `set-providers` sends one object; upsert omits `apiKey` key entirely when nil.

### Acceptance

- An invalid URL can't be tested; an unreachable endpoint says why; a working one lists its models
  pre-selected; filtering + None + toggling three gives "Save 3 models"; saving makes the endpoint
  appear in Accounts and its models in the picker without restarting opencode.
- A name colliding with an existing provider is refused before any network call.

---

## F5 — Per-model on/off switches on a saved endpoint

### Desktop today

Under each custom row (`AccountsCard.tsx:959–997`): base URL, register line, discovery results,
and `ModelChecklist` without filter/bulk (`onBulkChange` absent) over `discovered ?? enabledModels`.
Each tick writes immediately (`toggleModel`, lines 791–810): `set-providers {upsert:[{id, name,
baseURL, enabledModels}]}` (no `apiKey` → key kept). Per-model badges from `accounts:health`
`endpoints["<providerID>/<modelID>"]` via `formatEndpointStateLine` (`chatUtils.ts:5229`).

### iOS design

- Endpoint block in the Custom endpoints section (view `ProviderEndpointSection` in
  `MantaUI/ProviderEndpointSection.swift`): title row (name + state text, F6), base URL
  (monospaced footnote, truncated middle, long-press → Copy), register line (F6), then one
  `Toggle` row per model. Model rows = pure `ProviderEndpointModels.rows(enabled:discovered:
  disabledThisSession:)`: discovered list when present, else enabled ids **plus** ids the user
  switched off on this screen visit (desktop drops an unticked model from view until Refresh; iOS
  keeps it re-tickable). Sorted as the box returns them; dedup.
- A toggle writes immediately, single-flight per endpoint (the endpoint's toggles disable while a
  write is in flight). Optimistic: the switch moves at once; on `{ok:false}`/throw it moves back
  and the banner says "Couldn't update <name> — <error>". Success: quiet (the switch state is the
  confirmation), then `providers.refresh()` + post `.mantaProvidersChanged`.
- Turning off the last enabled model is allowed (desktop parity) but the toggle row footer then
  reads "No models from this endpoint are in the picker."
- Badge: when a model has a register entry, its state line (port of `formatEndpointStateLine`:
  label · "retry in Nm" · "HTTP 429"/errorName · "last success 5m ago" · "N attempts · P% success
  in window") as a caption under the model id.

### Tests (`ProviderEndpointTests.swift`)

- `ProviderEndpointModels.rows` — enabled only; discovered wins; unticked-this-session retained;
  duplicates removed.
- `EndpointHealth.stateLine` — every label from `ENDPOINT_STATE_LABEL`
  (`src/shared/providerHealthLabel.mjs`: Unproven, Dead, Degraded, Not found, Blocked, Rate
  limited), unknown state passes through, retry minutes rounding (`formatRetryMinutes`, min 1),
  `formatAgeAt` buckets, attempts/percent, empty for nil.
- `EndpointHealth.statesFor(providerID:endpoints:)` — prefix match on `"<id>/"` only.
- Upsert payload builder omits `apiKey`.

### Acceptance

- Switching a model off removes it from the model picker (after `.mantaProvidersChanged`) and the
  row stays visible so it can be switched back on; a failed write snaps the switch back and says why.

---

## F6 — Disconnect / Try again / Refresh / Send probe / Remove endpoint

### Desktop today (`AccountsCard.tsx`)

- **State text** (`describeAccountState`, lines 105–139): out-of-credit → "Out of credit" (danger);
  rate-limited → "Rate limited · retry in Nm" (warn); failing → "Not responding" (warn);
  connected + managedExternally → "connected · signed in with <managedBy>" (ok); usage reading →
  "<label> <pct>% · <pace>" (≥90 danger, ≥70 warn); balance → "$x.xx remaining" (<$5 danger);
  not connected → "Not connected" (quiet); else "No usage data".
- **Subscription controls** (lines 401–487): out-of-credit → **Try again**
  (`accounts:retry {providerID}` → `{ok, state, message}`, message shown in ok/danger; the verdict
  is dropped once the row is no longer out of credit, lines 772–789); connected & managed
  externally → no control; connected → **Disconnect** with inline confirm "This restarts opencode
  and interrupts every running session." → `provider-auth {action:"disconnect", id}` (server
  removes the credential, then restarts opencode, `rpc.mjs:2276–2297`); not connected → Connect (F3).
- **Custom endpoint controls**: **Refresh** → `discover-models(baseURL, "")` (empty key = server
  uses the stored key, `rpc.mjs:1836–1844`) → "Discovered N model(s)" or the error in danger;
  **Send probe** → `accounts:endpoint-probe {endpointKey: worst key or "<id>/<first enabled>"}`
  → `{ok, outcome, message}` shown ok/danger (lines 840–870); **×** → confirm → `set-providers
  {remove:[id]}` (lines 872–898). Register line = the worst endpoint state for the provider
  (`ENDPOINT_STATE_BADNESS`, lines 227–234: dead 5, not-found/forbidden 4, rate-limited 3,
  degraded 2, unproven 1), or "Unproven" when the register is empty but models are enabled.

### Wire

| Channel | Args | Result |
|---|---|---|
| `accounts:health` | `[]` | `{providers:{<id>:{state, retryInMs?}}, endpoints:{"<id>/<model>":{state, until?, retryInMs?, streak?, since?, lastSuccessAt?, attempts?, successes?, reason?:{httpStatus?, errorName?}}}}` — never throws (`rpc.mjs:1758`) |
| `accounts:retry` | `[{providerID}]` | `{ok, state, message}` — message never empty (`rpc.mjs:1718`) |
| `accounts:endpoint-probe` | `[{endpointKey}]` | `{ok, outcome, message}` (`rpc.mjs:1784`) |
| `opencode:provider-auth` disconnect | `[{action:"disconnect", id}]` | `{action:"disconnect", ok, error?}` |
| `opencode:discover-models` | `[baseURL, ""]` | as F4 |
| `opencode:set-providers` | `[{remove:[id]}]` | `{ok, error?}` |

### iOS design

- Connection row (subscriptions): state text + one control, same precedence as desktop.
  Usage reading for the state text comes only from `accounts:health` + status here (iOS does not
  pull `usage:list` into this screen; seat meters below already show usage) — so the reading/
  balance branches are skipped and a connected row with no health issue reads "Connected"
  (seat rows carry the numbers). Pure `AccountRowState.describe(status:health:)`.
- **Disconnect**: `confirmActionSheet` title "Disconnect <label>?", message "This restarts opencode
  and interrupts every running session.", destructive "Disconnect". In flight: row shows a
  spinner and every row control disables (desktop `busy`). Success → banner "<label>
  disconnected.", refresh both stores, post `.mantaProvidersChanged`. Failure → "Couldn't
  disconnect <label> — <error>".
- **Try again** (out-of-credit): button; result `message` goes to the banner (ok/error by `ok`).
- Endpoint block (F5) gets a trailing `Menu` (ellipsis) with **Refresh model list**,
  **Send probe** (hidden when the endpoint has no enabled model and no register entry), and
  destructive **Remove endpoint…**. Results:
  - Refresh: banner "Found N models on <name>." / "Couldn't refresh <name> — <discoverErrorText>";
    the discovered list feeds F5's rows.
  - Send probe: banner with the box's `message` (ok/error).
  - Remove: confirm "Remove <name>?" message "Its models leave the model picker. Conversations
    using one of them will need another model." destructive "Remove endpoint" → banner
    "Removed <name>." + post `.mantaProvidersChanged`.
- Register line under the endpoint name: `EndpointHealth.worst(...)` → state line; "Unproven"
  when no entries and ≥1 enabled model; nothing otherwise.

### Tests

- `ProviderConnectTests.swift`: `AccountRowState.describe` — each health state, rate-limited with
  and without retry, managed externally, connected, not connected; precedence (out-of-credit beats
  managed externally).
- `ProviderEndpointTests.swift`: `EndpointHealth.worst` ordering incl. ties and unknown states;
  probe key choice (worst key, else first enabled, else nil → control hidden).
- `AccountsRPCWireTests.swift`: `accounts:retry` / `endpoint-probe` single object; `health` empty
  args; disconnect request shape.

### Acceptance

- Disconnecting Codex asks first, warns about the restart, and the row turns "Not connected".
- A Claude login owned by the box's CLI shows "connected · signed in with the Claude CLI on this
  box" and no Disconnect.
- Refresh, Send probe and Remove each end in a visible banner, success or failure.

---

## S1 — Server hardening (small, required)

`src/server/ptyWs.mjs`: after `parsePtyQuery`, if `launcher?.id` resolves through
`findLauncher` (`launcherRegistry.mjs:90`) to an entry with `hidden: true`
(`claude-auth-login`, `claude-cli-install`), refuse: send
`{"type":"error","error":"launcher_not_allowed"}` and close with 1008, never spawn. Those launchers
exist only for the `pty:spawn` RPC, which owns the sign-in registry and the seat directory; via
`/pty` they would run an unregistered login against the box's live credentials. The desktop never
uses `/pty` (`grep -rn "/pty" src/renderer` → comments only), so no client regresses.

Node tests in `src/server/ptyWs.test.mjs`: hidden launcher id → error frame + close 1008 + injected
pty `spawn` not called; visible launcher and no launcher → spawn called as before.

No new routes, no `rpc.mjs` / `index.mjs` edits.

---

## Files

**Edit (owned):**
- `mobile/native/MantaUI/AccountsScreen.swift` — F0 layout, F1 entry points, F2 button, sheets,
  connection rows and endpoint section mounts (all views live in new files).
- `mobile/native/MantaUI/AccountsStore.swift` — `ptyEvents` subject + one raw frame handler in
  `init`; public `announce(_:isError:)`.
- `mobile/native/MantaUI/AccountsModels.swift` — copy changes (F0); `ResignStatusReply` +
  `ResignSeatReply`; `PtyEvent`.
- `src/server/ptyWs.mjs`, `src/server/ptyWs.test.mjs` — S1.

**Create:**
- `MantaUI/MantaAPIClient+Accounts.swift` — `accountsResignSeat/ResignStatus/ResignCancel`,
  `accountsHealth`, `accountsRetry`, `accountsEndpointProbe`, `providerAuthStatus/Start/Code/Key/
  Disconnect/ClaudeStatus/OauthStatus/OauthCancel`, `providerClaudeCliStatus`,
  `providerClaudeLoginCancel`, `signInPtySpawn/Write/Kill`, `providerEndpoints`,
  `providerSetEndpoints`, `providerDiscoverModels`, `providerRestartOpencode`. Names are prefixed
  to avoid colliding with other workstreams' extensions (e.g. WS10's own opencode restart).
- `MantaUI/AccountsSignInModels.swift` — `SignInConnect`, `SignInPhase`, `ClaudeLoginURL`,
  `SignInClock`, `AccountsSignInRules`, `AccountsSignInCopy`, `DeviceCode`, `formatRemaining`.
- `MantaUI/AccountsSignInFlow.swift` — `AccountsSeatSignIn` controller (add + resign).
- `MantaUI/AccountsSignInSheet.swift` — sheet + Claude block + device block views (device block
  reused by F3).
- `MantaUI/ProviderConnectionModels.swift` — `SubscriptionStatus`, `ProviderAuthStartReply`,
  `ClaudeStatusReply`, `AccountsHealth`, `AccountRowState`, `AccountsSectionPlan`,
  `ProviderConnectRules`, seat↔opencode id table, `Notification.Name.mantaProvidersChanged`.
- `MantaUI/ProviderConnectionsStore.swift`, `MantaUI/ProviderConnectFlow.swift`,
  `MantaUI/ProviderConnectSheet.swift`.
- `MantaUI/ProviderEndpointModels.swift` — `ProviderEndpoint`, `DiscoverResult`, draft/validation,
  `ModelChecklistState`, `ProviderEndpointModels.rows`, `EndpointHealth`.
- `MantaUI/ProviderEndpointForm.swift`, `MantaUI/ProviderEndpointSection.swift`.
- Tests: `MantaUITests/AccountsSignInTests.swift`, `ProviderConnectTests.swift`,
  `ProviderEndpointTests.swift`, `AccountsRPCWireTests.swift` (own private capturing
  `URLProtocol`, copied from `MantaActionRPCWireTests.swift:611` — that one is file-private).
- Regenerate the Xcode project (xcodegen) so the new files are in both targets as appropriate.

## Mount requests

None required. (The usage sheet's existing "Fix" already opens the Accounts screen.) Optional, for
WS02 if cheap: in `UsageSheets.swift`'s seat row, let "Fix" pass the seat id so the Accounts screen
can open F2's sheet directly — `AccountsScreen` will accept `resignSeatId: String? = nil` and open
the sheet on appear when set.

## Contracts provided / consumed

- **C1** — provides `MantaAPIClient+Accounts.swift`; does not edit `MantaAPIClient.swift`.
- **C5** — none: `pty` frames are plain bus frames reaching `addRawFrameHandler` already; WS08
  does not touch `MantaEventStore.swift` / `MantaStreamModels.swift`.
- **C6** — none.
- **C7** — four XCTest files above + node test for S1.
- **Provided to WS09:** `Notification.Name.mantaProvidersChanged` (posted after connect,
  disconnect, endpoint add/toggle/remove). WS09 (owner of `ChatModelCatalog.swift`) should observe
  it and re-run its model load (today `loadIfNeeded` is once-per-process, `ChatModelCatalog.swift:46`,
  so new models stay invisible until relaunch). Also provided: `EndpointHealth` (endpoint-register
  labels + state line) for WS09's model badges, so the two surfaces word states identically.
- **Coordinate with WS10** (same wave): both may want an `opencode:restart` wrapper; WS08's is
  named `providerRestartOpencode()` to avoid a duplicate-symbol clash.
- **Coordinate with WS04** (same wave): S1 touches `ptyWs.mjs`; if WS04 adds launcher support to
  iOS terminal sessions it must use visible launchers only (S1 refuses hidden ones).

## Deferred

- **Live terminal output for the Claude sign-in / CLI install** ("Show what's happening on the
  server"). The desktop collapses it by default; on iOS it would need an xterm surface fed from bus
  frames (not the `/pty` socket, see above). The link + code card is the whole job.
- **"Auto needs: which model, what it costs…" on custom rows** (`endpointEligibility`,
  `AccountsCard.tsx:275`). It depends on the shared eligibility gate, model identity resolution and
  the routing catalogue — that belongs with WS09's "unidentified models fix-up" and price form.
  Custom rows show "Custom endpoint" until then.
- **Unpriced-models panel** (`UnpricedModelsPanel`, `AccountsCard.tsx:1007`) — WS09 (model price form).
- **Usage reading / balance in the connection row's state text** — seat rows already show the
  meters; the subscription row shows connection + health only.
- **Editing a saved endpoint's name / URL / key** — the desktop has no edit either (remove + add).

## Open questions (each with a proposed default)

1. **Restart after saving an endpoint.** Desktop `CustomProviderForm` still calls
   `opencode:restart` after `set-providers`, but on OpenCode V2 the write hot-reloads and AGENTS.md
   reserves restarts for explicit user action. *Default:* iOS does not restart; it verifies the
   endpoint via `get-providers`. (Desktop's restart — and its stale "restarts opencode" warning on
   Remove — are a separate desktop cleanup.)
2. **Restart after connecting with a key / device code** (desktop `applying`). *Default:* keep
   parity (call `opencode:restart` unless the box already did), since the credential lives in the
   auth store, not the config file, and the desktop proves the provider came online this way.
3. **A live seat that is expired / signed out.** The box refuses to re-sign it (`live-seat`).
   *Default:* no button; explanatory text pointing at switching seats or remove-and-re-add. A
   proper fix (re-sign the live login) would be a server change outside this workstream.
