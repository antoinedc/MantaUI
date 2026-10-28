# Code review — WS08 accounts (commit f245c590)

Reviewer: Opus. Scope: every file in `git show --stat f245c590` (23 files), read in full.

## Checks run

- `node --import ./scripts/testSandbox.mjs --test src/server/ptyWs.test.mjs`: 21/21 pass (incl. the two new S1 tests).
- Linux SwiftPM (`swift:6.1` in Docker, against a `git archive HEAD` copy using the committed integration-A `Package.swift`, which lists the four WS08 pure files and three WS08 pure test files): **build clean, 907 tests, 0 failures**. So `AccountsSignInModels`, `ProviderConnectionModels`, `ProviderEndpointModels` and `ProviderOAuthLease` compile under Swift 6 strict concurrency, and their tests pass.
- Mac-only files (`AccountsSignInFlow`, `AccountsSignInSheet`, `ProviderConnectFlow/Sheet`, `ProviderConnectionsStore`, `ProviderEndpointForm(+Model)`, `ProviderEndpointSection`, `AccountsScreen`, `MantaAPIClient+Accounts`, `AccountsFlowTests`, `AccountsRPCWireTests`) were checked by hand. Every referenced symbol exists with the signature used: `callRequired`/`callVoid`, `accountsAddSeat(provider:accountId:)`, `accountsSeatStatus`, `accountsAddSeatConfirm`, `accountsCancelSeat`, `opencodeRestart() -> OkResult`, `addRawFrameHandler`, `confirmActionSheet(isPresented:title:message:destructiveTitle:destructiveAction:)`, `AccountsStore.provider(_:)`, `refreshMoveNotice`, and the `Tokens` members `ok/warn/danger/tx3/info/accent`. Every server reply decoded through `callVoid` (`pty:*`, `claude:login-cancel`, `oauth-cancel`) returns `undefined` or an object, so the `VoidResult` decode is safe. I found no compile blockers.

## Security summary

- **S1 `/pty` hidden-launcher refusal is complete for its purpose and can't be bypassed.**
  - The guard calls the same `findLauncher(launcher.id)` (strict `===`) that `pty.mjs` `resolvePtyCommand` uses. So exactly the ids that would spawn `claude-auth-login` / `claude-cli-install` are refused.
  - Non-string ids, whitespace variants and unknown ids fall through to a plain shell in both places.
  - A string-typed `launcher` has no `.id`, so it also becomes a plain shell.
  - `tmuxTarget` and `extraEnv` can't be set through the `/pty` URL.
  - The guard runs before any spawn, sends one error frame, and closes with 1008.
  - Legitimate launchers still work: desktop never uses `/pty`, and iOS terminals only offer `launchers:list` entries, which already exclude hidden ones. The tests cover visible, unknown and absent launchers.
  - Caveat (not a defect): `/pty` is still an authenticated full shell, so a user can type `claude auth login` by hand. S1 is defence-in-depth against an accidental launcher spawn, not a security boundary. That matches the spec.
- **Secrets are handled correctly.**
  - Kimi key and endpoint key use `SecureField`.
  - `keyDraft`/`codeDraft` are cleared on submit, done, fail, cancel and abandon.
  - No key value reaches `NSLog`. Logs only carry error descriptions and teardown step names (seat/flow/session ids, no credentials).
  - `ProviderEndpoint` never decodes a key, and `apiKey` is omitted from an upsert when nil.
- **Destructive confirms are all present with the spec copy:** remove seat (existing), Disconnect ("This restarts opencode…"), and Remove endpoint.
- **"Use the desktop" text is gone.** No user-facing "desktop" string remains in `Accounts*` / `Provider*`; only code comments mention it. `addSeatOnDesktop` is deleted with no stray references.

## Findings

### 1. BLOCKING — Cancel/Close during a Retry can leave a sign-in running in a dismissed sheet, and can wedge the Codex lease until relaunch
**Files:** `ProviderConnectFlow.swift:107–118` (`runStart`), `:526–542` (`cancel`), `:545–559` (`abandonIfOpen`); same shape in `AccountsSignInFlow.swift:318–330` / `:606–644`.

**Problem:**
- `runStart` clears `current`, then awaits `pendingTeardown` before it creates the new attempt. If the user presses Cancel / Close (toolbar, or "Use a different model") in that window, `cancel()` sees `current == nil`, tears nothing down, and dismisses. `abandonIfOpen` also finds `current == nil`.
- `runStart` then resumes (its `Task` holds `self` strongly), mints a new attempt and starts it on the box with no UI. Both continuations await the same `pendingTeardown`, so the outcome is decided by which resumes first.
- What leaks per flow:
  - **F1:** an orphan pending seat (`accounts:add-seat`).
  - **F2:** an orphan resign flow.
  - **F3 Claude:** a registered login plus a spawned pty.
  - **F3 Codex:** the orphan attempt becomes owner of `ProviderOAuthLease.shared`'s `openai` slot. The device poll ends as soon as the flow deallocates (it holds `self` weakly), and nobody ever calls `retire` or `settled`. Every later Codex Connect then sits on "Closing the previous sign-in…" forever, until the app is relaunched.

**Fix:**
- Add `private var closed = false` to both controllers. Set it at the top of `cancel()` and `abandonIfOpen()`.
- In `runStart`, `guard !closed else { return }` right after `await pendingTeardown?.value`, before creating the attempt.
- After every later await that precedes recording an allocation, a gate failure already routes to teardown. Additionally, in `ProviderConnectFlow.runStart`, when `lease.start` returns a reply but `closed` is true, call `lease.retire(provider:attempt:)` for an `oauthAuto` reply. Today only Claude replies are torn down on that path; `oauthAuto` relies on a retire that never happened because `current` was nil when `cancel()` ran.
- Test (`AccountsFlowTests`):
  1. A failing attempt whose teardown is delayed.
  2. Press `retry()`, then `cancel()` before the teardown resolves.
  3. Assert that no `opencode:provider-auth start` / `accounts:add-seat` is sent after the cancel, and that a subsequent `ProviderOAuthLease.start` for the same provider runs immediately.

### 2. SHOULD — Every chat's `AccountsStore` registers a permanent raw-frame handler (unbounded growth)
**File:** `AccountsStore.swift:106–111`.

**Problem:** `MantaEventStore` handlers can't be removed. `ChatScreen.swift:328` creates an `AccountsStore` per opened chat, so the handler list grows by one closure per chat for the life of the app, and every raw frame runs all of them. Only the Accounts sign-in flows ever read `ptyEvents`.

**Fix:** register lazily on first use, so chat stores that never sign in never register:
```swift
private var ptyHandlerInstalled = false
var ptyEvents: PassthroughSubject<PtyEvent, Never> {
    if !ptyHandlerInstalled, let eventStore {
        ptyHandlerInstalled = true
        eventStore.addRawFrameHandler { [weak self] f in if let e = PtyEvent.from(f) { self?._ptyEvents.send(e) } }
    }
    return _ptyEvents
}
```
The subject becomes `private let _ptyEvents`. Subscribing still happens before the spawn, so no frames are lost.

### 3. SHOULD — Swiping the re-sign sheet away during the 1.5 s "Signed back in" hold drops the banner and the models-changed post
**File:** `AccountsSignInFlow.swift:537–550` with `isOpen` at `:278–283`.

**Problem:**
- `.done` makes `isOpen` false, so the sheet can be swiped away during the hold. `abandonIfOpen` then sets `current = nil`.
- After the sleep, `finishResigned`'s gate fails, so neither `ProviderChange.announce()` nor `accounts.announce(message)` runs. A successful re-sign ends silently, and the picker isn't told the seat's models came back.
- Because `flowId` was already nil, the teardown also sends a `pty:kill` plus `claude:login-cancel` for the seat login. Both are harmless (seat records ignore an unforced cancel), but they're noise.

**Fix:** in `finishResigned`, before the hold:
1. Capture the message.
2. Set `current = nil`.
3. Call `ProviderChange.announce()` and `accounts.announce(message)`.

Then hold and dismiss. An alternative is to keep `isOpen` true for `.done` in resign mode. Add a test: dismiss during the hold → the banner and the notification are still delivered.

### 4. SHOULD — "Copy URL" on an endpoint gives no visible result
**File:** `ProviderEndpointSection.swift:34–39`.

**Problem:** the context menu closes on tap, and the "Copied" title only shows the next time the menu opens. The copy has no visible confirmation, which the root AGENTS "NEVER STUB…" outcome 1 forbids.

**Fix:** after setting the pasteboard, call `store.announce`-equivalent through `ProviderConnectionsStore.say`; expose `func reportCopied(_ name: String)` that says "Copied <name>'s URL." Drop the `copiedURL` state.

### 5. NIT — A stale field error wins over the newer one on the code/key forms
**File:** `ProviderConnectSheet.swift:88, 111`.

**Problem:** `error ?? flow.fieldError` prefers the phase's old `unauthorized` text. A resubmit that then fails on transport still shows "That code/key didn't work", not "Couldn't reach the server".

**Fix:** show `flow.fieldError ?? error`. Alternatively, update the phase's error in the `catch` branches of `submitCode`/`submitKey`.

### 6. NIT — The lease sends a cancel for a start that never ran
**File:** `ProviderOAuthLease.swift:162–166`.

**Problem:** when a waiter is granted the slot and retired before running, `.startFinished` with `retirePending` sends a provider-wide `oauth-cancel` for a start that was never sent. It's harmless (this attempt owns the slot, and the box treats an empty slot as a no-op), but it's a spurious request.

**Fix:** add a reducer event `.grantedButRetired(UUID)` that releases without `.sendCancel`. Resolve the pending `retire` continuation with `.success(())`.

### 7. NIT — `EndpointWriteReconcile.matches` ignores name and base URL
**File:** `ProviderEndpointModels.swift:491–499`.

**Problem:** the spec defines "state" as name + baseURL + model set. `.present` only compares models.

**Fix (optional):** compare `after.comparable` to an expected `EndpointState`, by putting `name`/`baseURL` into `.present`. Either way, document the narrower match.

### 8. NIT — Claude pty chunks are handled one `Task` per chunk
**File:** `AccountsSignInFlow.swift:110–114` (and the installer sink in `ProviderConnectFlow.swift:214–219`).

**Problem:** the subject fires on the main actor already. A `Task` per chunk relies on main-executor FIFO to keep chunk order for the URL buffer.

**Fix:** use `MainActor.assumeIsolated { self?.handle(event) }`. Or `receive(on: DispatchQueue.main)` plus a direct call.

### 9. NIT — Backticks in the live-seat advice render literally
**File:** `AccountsSignInModels.swift:364`.

**Problem:** the `` `claude auth login` `` text is rendered through `Text(String)`, which doesn't parse markdown, so the backticks show.

**Fix:** use “claude auth login” in quotes, or render it with `Text(LocalizedStringKey(...))`.

### 10. NIT — `freshProviders()` leaves a stale "Couldn't refresh" warning in place
**File:** `AccountsStore.swift:200–210`.

**Problem:** a successful `freshProviders()` doesn't clear `refreshError`.

**Fix:** set `refreshError = nil` on success, the same as `fetchOnce` does on success.

## Spec conformance

- F0–F6 and S1 are implemented as specified:
  - section plan and focus aliases;
  - per-source phases;
  - "Add endpoint…" gated on the inventory;
  - fresh-list `ConnectRoute`;
  - attempt-scoped teardown;
  - the lease;
  - write reconciliation for save, toggle and remove, including the unconfirmed state with a Refresh;
  - no restart after an endpoint save;
  - a restart-and-poll after a key or device connect;
  - `unknown_session` treated as terminal.
- Round 3 SHOULDs:
  - `retire` returns `Result<Void, MantaError>`, and the transport uses `do/catch`. An explicit Cancel reports a failed cleanup in the banner; background cleanup logs it.
  - `PendingEndpointWrite` keeps the original expectation, and `recheck` returns partial when the selection differs. Both are tested.
- M-09-6 footer: a plain `VStack` is in place. The M-08-1 observer belongs to WS09 (wave B).

VERDICT: CHANGES REQUIRED
