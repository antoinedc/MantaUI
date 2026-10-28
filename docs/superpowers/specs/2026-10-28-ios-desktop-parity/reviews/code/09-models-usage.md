# Code review — WS09 models, spend & usage (iOS + box)

Reviewed: `69067c71` (feat: WS09) plus the WS09 parts of integration commits
`21ea7d07` (M-09-srv-1 registrations in `rpc.mjs`, M-09-srv-2 capability ids +
test), `f0a68d7c` (M-09-7 `Package.swift`) and `1b4e9492` (M-09-1/2/3/4/6/8/9 Swift
mounts). Read in full: every new/changed iOS file (`ModelsWire`, `MantaAPIClient+Models`,
`ModelsBoxBinding`, `ChatModelCatalog`, `ChatModelStore` diff, `ModelPickerSheet` diff,
`ModelsStore`, `ModelsScreen`, `ModelsDetailSheet`, `ModelsLedgerScreen`,
`OptimizerLogic`, `OptimizerScreen`, `ModelsIdentifyLogic`, `ModelsUnidentifiedView`,
`ModelsPriceForm`, `UsageAlertsLogic`, `UsageAlertsStore`, `UsageAlertBanner`,
`UsageResumeLogic`, `UsageResumeSheet`, `UsageMeters` diff), the WS09 test files, the
mounts in `MantaAppRoot` / `SessionListView` / `SettingsScreen` / `AccountsScreen` /
`ComposerView` / `MantaModels` / `UsageSheets`, and the box modules (`modelsTable`,
`modelsUnidentified`, `modelsPricing`, `ledgerView`, `optimizer/view`,
`usageResumeView`, `usageAlerts`, `usageWindowView`, `usage.mjs` + `providers.mjs`
diffs, the `rpc.mjs` registration). Desktop files spot-checked (`usageAlertsQueue.ts`,
the `App.tsx` alerts/`onModelsUpdated` effects) for parity with iOS.

Overall: the server-first split is faithfully implemented — every wire shape the
phone decodes matches what the box modules emit (checked field-by-field, incl.
nullables: `costPerTurn` via `safeDiv`, `windowLabel` defaulting to `""`,
`forecastLabel`/`pressure` always present, activity `id` always minted), the
registration block is the pinned one, the capability ids and their test landed, the
hydration contract is implemented identically on both clients, and the Foundation-only
manifest is correct. Findings below are about errors that are not visible where the
user acted, one lifecycle bug that wipes the open chat id, and missing store tests.

## Findings

### 1. BLOCKING — failures from the edit / identify forms are rendered behind the form (dead Save)

- `ModelsDetailSheet.swift:182-188` (`ModelsEditForm` Save), `:33-37`;
  `ModelsStore.swift:147-153, 168-173`.
- `ModelsUnidentifiedView.swift:121-123, 125-133, 387-398` (`ModelsIdentifyForm.save`), `:95-97`.

Problem: `ModelsStore.write` / `ModelsUnidentifiedStore.run` put every non-field
failure (`ok:false` without `field`, e.g. `unknown-model`) and every thrown error into
`store.feedback`. That feedback is drawn ONLY by `ModelsFeedbackBar` in
`.safeAreaInset` on the ModelsScreen list and on the *root* of the detail sheet's
`NavigationStack`. `ModelsEditForm` is pushed inside that stack (the inset does not
follow a pushed view) and `ModelsIdentifyForm` is a `.large` sheet covering
ModelsScreen. So: tap Save → spinner → nothing (the form stays open, no message).
`ModelsIdentifyForm.save` additionally returns silently on a `nil` reply (thrown error).
Same for Confirm / candidate pick: `declare(key:catalogId:)` discards the reply, so an
`ok:false` WITH `field` (e.g. `catalogId: "Pick the model this is."`) shows nothing at
all. This is exactly the "save that shows no confirmation" defect root AGENTS.md bans.

Fix:
- Add `.safeAreaInset(edge: .bottom) { ModelsFeedbackBar(feedback: store.feedback, tokens:…, retry: { Task { await store.retrySubSync() } }, dismiss: { store.dismissFeedback() }) }`
  to `ModelsEditForm`'s `Form`, and the same (over `unidentified.feedback`) to
  `ModelsIdentifyForm`'s `Form`.
- In `ModelsIdentifyForm.save()`: when `reply == nil` set a form-level error row
  ("Couldn't confirm the save — pull to refresh.") instead of returning silently;
  when `!reply.ok && reply.field == nil` the bar above now shows it.
- In `ModelsUnidentifiedStore.run`, when `!reply.ok && reply.field != nil` and the
  caller is the Confirm/pick path, show `.failed(reply.message)` (simplest: give
  `run` a `showFieldErrors: Bool` parameter, `true` from `declare(key:catalogId:)`).
- Test (ModelsStoreTests): `set-override` reply `{ok:false, code:"unknown-model"}` →
  `store.feedback == .failed(...)` (already true) AND a UI-level assertion is not
  possible here, so add a `ModelsUnidentifiedStore` test that `declare(key:catalogId:)`
  with `{ok:false, field:"catalogId", …}` sets `feedback`.

### 2. BLOCKING — the first client bind (and every post-switch rebind) wipes `activeSessionId` / `resumeSheetPresented`

- `UsageAlertsStore.swift:264-281` (`currentClient`, `.rebind` → `resetForBoxChange()`),
  `:246-262`; same pattern `ChatModelCatalog.swift:264-265`.

Problem: `binding` starts `nil`, so the FIRST `currentClient()` call returns
`.rebind(_, boxChanged: true)` and runs `resetForBoxChange()`, which sets
`activeSessionId = nil` and `resumeSheetPresented = false`. That first call happens in
`requestSnapshot` when the event stream first reaches `.connected`. On a cold start
into a chat (push-notification tap) — and after every box switch, where M-09-4 already
reset the store and nilled `binding` — ChatScreen sets `activeSessionId` (M-09-5) before
the stream connects, and the rebind then erases it: "Remind me at reset" disappears
while a chat is open (acceptance criterion F7-3) until the user leaves and re-enters
the chat. A `presentResume()` that raced the first connect is also cancelled.

Fix: only run the reset when there WAS a previous binding (an explicit
`resetForBoxChange()` already ran for the explicit switch/remove paths):
`case .rebind(let next, let boxChanged): if boxChanged && binding != nil { resetForBoxChange() }`
in both stores. Test (UsageAlertsStoreTests, with `credentials:` injected): set
`activeSessionId = "s1"`, then `beginHydration()` for the first time → after the snapshot
lands `activeSessionId == "s1"`; then switch credentials to box B → it is cleared.

### 3. SHOULD — price editor claims "Nothing was changed" after a transport error

- `ModelsPriceForm.swift:72-74`.

Problem: a thrown call (timeout / connection drop after the box wrote) is reported as
"Couldn't save — <reason>. Nothing was changed; try again." The spec (F1 AC "Nothing
was changed never appears after the preference was written"; F4 "A thrown error after
which the write may have landed → 'Couldn't confirm the save — pull to refresh.'")
reserves "Nothing was changed" for the box's own `changed:false` answer.

Fix: `return (nil, "Couldn't confirm the save — \(ModelsCapability.reason(error)). Pull to refresh to check.")`
and `await refresh()` in the catch so the section reflects what landed.

### 4. SHOULD — a catalogue reload clears the box default on a transient `config:get` failure

- `ChatModelCatalog.swift:146-154`.

Problem: `configDefault = Self.configDefaultID(config)` runs even when `config:get`
threw (`config == nil`), so a failed reload after a `models.updated` frame (or a
providers change) drops the saved default and new chats fall back to the provider
default. The comment above says "A failed reload keeps the list already shown"; the
same should hold for the defaults. `defaultModel` has the same issue when only
`opencode:default-model` fails.

Fix: capture `Result`s; assign `configDefault` only when `configGet()` succeeded
(`do { configDefault = Self.configDefaultID(try await client.configGet()) } catch {}`
before the generation check, or keep a `configOK` flag), and assign `defaultModel` only
when its call succeeded (a successful `nil` still clears it).

### 5. SHOULD — a recent chip the box keeps via its twin is a dead button

- `ChatModelStore.swift:322-330` (`visibleRecents`), `modelsTable.mjs:192-201`.

Problem: the box keeps a recent when EITHER its key or its `-fast` twin is selectable
(as the spec says), but `apply(_:)` checks the key it will actually set
(`fast ? twin : base`). A recent `{modelID:"opus", fast:true}` whose fast twin was
hidden (base still selectable) is rendered, and tapping it does nothing (no dismiss,
no message).

Fix (client, view state): `visibleRecents` maps the box's recents and then
`.filter { isSelectable("\($0.providerID)/\($0.fast ? ChatModel.fastModelID($0.modelID) : $0.modelID)") }`
(keep the `pickerUnsupported` branch as is). Add a case to
`testAKeyAbsentFromSelectableCannotBeAppliedByAnyPath` with such a recent.

### 6. SHOULD — the resume sheet's success message is never seen

- `UsageResumeSheet.swift:161-171, 317-319`.

Problem: on a clean apply the model sets `message = reply.message` and the view
dismisses in the same tick, so "Updated — 2 conversations will carry on at reset." is
never displayed (spec F6: "Apply: … → show `message` … else dismiss"). The only
evidence of success is the capsule count changing.

Fix: hand the box's sentence to the app-level banner before dismissing — add
`func showNotice(_ text: String)` (public wrapper over the private `show`) to
`UsageAlertsStore` and call `usage.showNotice(reply.message ?? "Updated.")` in
`apply()` on the success path (the banner already renders `notice` for 4 s).

### 7. SHOULD — default-argument isolation of `ChatModelCatalog.liveClient`

- `ChatModelCatalog.swift:76, 106-108`; `UsageAlertsStore.swift:59`.

Problem: `liveClient` is a static method of a `@MainActor` class, i.e. `@MainActor`-
isolated, and is converted to the non-isolated parameter type
`(ModelsBoxBinding) -> MantaAPIClient`. This relies on the SE-0434 same-isolation
conversion rule inside an isolated default-argument context; it is not exercised by
the Linux `verify.sh` (the file is Mac-only) and is an easy "loses global actor" error
to hit on the Mac.

Fix: `nonisolated static func liveClient(_ binding: ModelsBoxBinding) -> MantaAPIClient`
(it touches no isolated state; `MantaAPIClient` is `Sendable`).

### 8. SHOULD — store tests the spec requires are missing

- `MantaUITests/ModelsStoreTests.swift`, `UsageAlertsStoreTests.swift`; no resume store test file.

Missing, all pinned by the spec (F1 Tests, F6 Tests, F7 Tests, Box lifecycle):
1. `testModelsUpdatedRefreshesCatalogAndDefault` — a `models.updated` frame (through
   `catalog.subscribe(to:)` / `handle`) with a live `ChatModelStore` triggers one full
   reload; `configDefault`, the renamed model's `name`/`limit.context` update; a
   cleared default becomes nil. The existing
   `testModelsUpdatedAndProvidersChangedReloadTheCatalog` never sends a
   `models.updated` frame (only the providers notification) — rename it or add the frame.
2. `UsageResumeModel` (Mac): one armed row unchecked → dry-run `canApply:true`
   enables the button; a `failed` reply keeps the sheet open; `close()` calls
   `usage-stopped:stamp-last-looked` once; a `stoppedUpdates.send()` with a changed
   view drops the vanished id, keeps the user's toggle, and re-runs the dry run; an
   older view response arriving after a newer one is ignored; a `reconnects.send()`
   reloads once. (Inject `planDebounce: 0` and the stub client.)
3. `UsageAlertsStore` box binding: unpaired → no request; paired → first
   `usage:alerts` hits the paired host with its bearer; A → B → the next read hits B
   only and a held A response is dropped; plus the `$connectionState` path
   (`bind(eventStore:)` + connected → exactly one `usage:alerts`), which no test drives
   today (all tests call `beginHydration()` directly).

### 9. NIT — dead helper left behind

- `ChatModel.swift:217` `isCatalogueRowDisabled(_:optIn:)` has no caller any more (the
  picker reads `picker.locked`). Delete it (and its test if any) so nobody re-wires the
  device-local rule.

### 10. NIT — one opt-in failure relabels every locked row

- `ModelPickerSheet.swift:480` (`optInError != nil ? "Try again" : "Enable"`).
  `optInError` is not keyed, so after one failure every deprecated row says "Try again".
  Store the failing key (`optInErrorKey`) and compare per row.

### 11. NIT — catalogue says "No models match" while the picker is still loading

- `ModelPickerSheet.swift:410-412` + `ChatModelStore.pickerGroups`. With `picker == nil`,
  `!pickerUnsupported` and no `pickerError`, `groups` is empty and the platform search
  empty-state shows. Render `ProgressView("Loading models…")` in that state.

### 12. NIT — `nonisolated(unsafe)` observer tokens without a justification

- `ChatModelCatalog.swift:68-69`, `UsageAlertsStore.swift:54`. mobile/native/AGENTS.md
  §5 asks for a comment on every concurrency opt-out; add one line ("only touched in
  init and deinit; NSObjectProtocol tokens are not Sendable").

### 13. NIT — ledger bar can overflow by a rounding point

- `ModelsLedgerScreen.swift:84-99`: segment widths use the box's rounded `pct`, which
  can sum to 101; give the last segment `.frame(maxWidth: .infinity)` (or scale by
  `sum(pct)`) so the bar never exceeds its track.

### 14. NIT — box writes reject instead of resolving `{ok:false}` when the config write fails

- `modelsTable.mjs:284, 295, 315, 336, 375, 403`; `modelsUnidentified.mjs:177`. The
  spec's common rule ("config write rejects → `ok:false`") is not followed; a
  `configUpdate` rejection propagates as an RPC error. Both clients cope (iOS says
  "Couldn't save — … Pull to refresh"), so this is cosmetic; wrap `configUpdate` in the
  service and return `fail("write-failed", "Couldn't save — <why>. Nothing was changed; try again.")`.

### 15. NIT — desktop: a superseded hydration's rejection schedules an extra retry

- `src/renderer/App.tsx:851-871`: the rejection handler of an older `usageAlerts()`
  request still calls `retry()` after a newer `hydrate()` started. Guard with
  `if (epoch !== currentEpoch) return;` (track the latest epoch in the closure).

## Seams / mounts check

- M-09-srv-1 / M-09-srv-2: registration matches the pinned block; nine ids advertised
  with a test. ✓
- M-09-1 (Settings row + search), M-09-2 (capsule before the order menu), M-09-3
  (bind in `startModelPrefs`, banner overlay, sheet), M-09-4 (both switch and remove
  paths, plus `TranscriptMediaStore`), M-09-6, M-09-8 (`UsageWindow.tone`), M-09-9
  (Composer, Accounts, UsageSheets; context meter keeps `band(_ pct:)`). ✓
- M-09-5 consumer (`ChatScreen.swift:445, 502, 597, 601`) uses the pinned symbol. ✓
- Provided to WS03: `agentsLoadError` / `retryAgents()` (M-03-5) as pinned; consumed by
  M-03-6. ✓ M-08-1 observer present. ✓
- `UsageAlertBanner`'s `@EnvironmentObject SessionListStore` is satisfied (MantaAppRoot
  itself reads it from the environment). ✓
- Package manifest: six sources + five tests, all Foundation-only and their in-package
  dependencies (`UsageMeters`, `MantaModels`, `MantaError`) listed. ✓

## Counts

BLOCKING 2 · SHOULD 6 · NIT 7

VERDICT: CHANGES REQUIRED
