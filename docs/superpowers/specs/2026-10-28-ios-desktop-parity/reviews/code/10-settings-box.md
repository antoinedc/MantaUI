# Code review — WS10 settings / box (commit b9a1f208)

Reviewer: Opus (main-session model). Scope: every file in `git show --stat b9a1f208`
(53 files: Swift app + [pkg] files, tests, generated schema, `src/shared/settingsSchema.ts`
+ test, server S1 in `src/server/{devices,auth,index}.mjs` + tests).

Checks run here: `node scripts/gen-swift-settings.mjs --check` (up to date),
`node --test src/server/devices.test.mjs src/server/auth.test.mjs` (77/77),
`vitest run src/shared/settingsSchema.test.ts` (42/42). No Swift toolchain on this
box — Swift findings are by reading (symbols grepped: `Tokens`/`Metrics` members,
`MantaError` cases, `KeychainCredentialStore` members, `MantaAPIClient.makeRequest`/
`callRequired`, `UpgradeStatus.isUpgradeRefusal`, `MantaLoader`, `MantaPushService`,
`SessionListStore.loadConfig/refresh`, WS03 `references()`/`OpencodeReferenceInfo`;
no duplicate top-level type names in `MantaUI/`).

Server S1 is correct and minimal: `current` is computed with the existing
constant-time `tokenMatches` (which also rejects malformed/absent tokens), no row ever
carries `token`, revoked rows are filtered before the comparison, and the route still
sits behind the auth gate. Schema change matches §0.1 exactly; desktop rendering is
unaffected (all new entries are `platform: "mobile"`). Seams in the shared member
registry (`opencodeRestart`, `forgeStatus(validate:)`/`ForgeConnectionStatus`,
`launchersList`/`AvailableLauncher*`/`ExtensionsLaunchers.*`, `SettingsAppearance`,
`ThemePreference.colorScheme`, `.mantaBoxRemoved`, `SettingsScreen(eventStore:initialSection:)`,
`OkResult`, `BoxRESTClient`) all exist with the pinned signatures. Round-3 SHOULD
(ScrollViewReader around the real ScrollView) is done.

## Findings

### 1. BLOCKING — Updates screen re-subscribes to the connection publisher on every render → update loop
`mobile/native/MantaUI/SettingsUpdatesScreen.swift:68,85-91`; `SettingsUpdatesStore.swift:117-120`.

`connectionPublisher` is a computed property that builds a NEW `AnyPublisher` from
`eventStore.$connectionState` on every body evaluation. SwiftUI's `onReceive` cannot
compare a non-Equatable publisher, so it re-subscribes on each update; a `@Published`
publisher replays its current value on subscribe, so every render calls
`store.connectionChanged(connected:)`, which does `flow.reduce(.connection(...))` — an
assignment to the `@Published var flow` that fires `objectWillChange` even when nothing
changed — which re-renders the screen, which re-subscribes… (and, while an update is in
flight, spawns a `readVersionAfterRestart` Task per pass). Expect "Publishing changes
from within view updates" and a render/CPU loop on the screen in production (the
eventStore is always non-nil there). `removeDuplicates()` doesn't help — it is per
subscription.

Fix (both parts):
- Make the subscription stable: give `SettingsUpdatesStore` a `func bind(connection: AnyPublisher<Bool, Never>)`
  (or `bind(eventStore:)`) that stores one `AnyCancellable`, called once from the
  screen's `.task`/`.onAppear`; delete the computed `connectionPublisher` + `.onReceive`.
  (Alternatively hold the publisher in `@State` created once.)
- Make `connectionChanged` idempotent: `guard connected != flow.connected else { return }`
  before reducing, so a replayed value can never mutate published state.
Add a store test: calling `connectionChanged(connected: true)` twice publishes at most once
(count `objectWillChange` emissions) and starts no version read when not busy.

### 2. BLOCKING — an empty `device_id` turns a single-device revoke into a WHOLE-BOX RESET
`BoxRESTClient.swift:63-71` (`revokeDevice(id:)`), reached from `BoxDevicesScreen.swift:55-59`
and `BoxRemovalStore.swift:84-91` via `BoxRemoval.plan` (`BoxDevicesModels.swift:172-175`).

The server reads `q.device_id ?? q.deviceId ?? null` and branches on truthiness
(`auth.mjs:592`), so `DELETE /auth/revoke?device_id=` (empty) runs the legacy
whole-box reset that drops EVERY device. An empty id is reachable: `claim` accepts any
client-supplied string `device_id` not already present (`devices.mjs:249-251`), so a
device row with `device_id: ""` can exist in memory, and `BoxDevice` decodes it happily
(`BoxDevicesModels.swift:59`). Tapping "Revoke" on it — or Remove server on a phone whose
own row is `""` — resets the box for everyone. The file's own SAFETY comment claims the
phone can never do this.

Fix:
- `BoxRESTClient.revokeDevice(id:)`: `guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (nil, true) }`
  before building the request (one guard protects both callers).
- `BoxDevices.canRevoke` returns false for an empty `deviceID`; `BoxRemoval.plan`
  returns `.unknownDevice` when the current row's `deviceID` is empty.
- Tests (SettingsBoxTests): `canRevoke(BoxDevice(deviceID: ""))` is false; `plan` with a
  current non-primary row whose id is `""` → `.unknownDevice`.
(Separately worth a server ticket: `/auth/revoke` should treat a present-but-empty
`device_id` as 400, and `claim` should only accept a valid 32-hex `device_id`. Not
WS10's file set.)

### 3. SHOULD — Remove-server state can be orphaned (Done / search / swipe-dismiss)
`SettingsScreen.swift:78-94,106-112`; `SettingsCustomRows.swift:219-229`.

The confirm dialog and BOTH alerts (Keychain failure with "Try again", and the warning
that must be acknowledged before leaving) are attached to `BoxRemoveServerRow`, which
is only mounted in the section list. During `.revoking`/`.deletingLocal` only the
section `Group` is disabled: the search field and "Done" stay live. Typing a query
unmounts the row (search results don't contain it), so the warning / failure alert
can never be presented; tapping Done dismisses the cover while the Task keeps running,
deletes the Keychain credentials, and parks in `.warning` with no UI — the "warning is
never lost" guarantee (F15) fails and the app is left half-removed.

Fix: move the `.confirmationDialog` and `.alert` modifiers from `BoxRemoveServerRow`
onto the `SettingsScreen` `NavigationStack` (always mounted); and while
`removal.state != .idle` disable the search field and the Done button and apply
`.interactiveDismissDisabled(true)` to the screen.

### 4. SHOULD — `BoxStatusCard` observes the whole event store and reads the Keychain on every frame
`BoxStatusCard.swift:21-26,49`.

`Live` holds `@ObservedObject var eventStore: MantaEventStore`, which republishes on
every stream frame (`sessionStates`, `degraded`, …). Each publish re-renders the card,
and its body calls `KeychainCredentialStore.shared.serverURL` — a synchronous
`SecItemCopyMatching` on the main thread — so a busy session drives Keychain reads at
frame rate while Settings is open.

Fix: read the server URL once into `@State` in `.task`; derive `connected` from
`.onReceive(eventStore.$connectionState.map { $0.name == "connected" }.removeDuplicates())`
held stably (see #1), not from observing the whole store.

### 5. SHOULD — Forge-rules toggle shows "off" when the config was never read
`ExtensionsForgeScreen.swift:38-48,108-117`.

`rulesEnabled` starts `false`; if `configGet()` fails (or returns nil) the toggle is
rendered, enabled, showing `false` — a value the box never confirmed — and the failure is
silent. A user who sees "off" and flips it may be changing a setting that was already on.

Fix: add `@Published private(set) var rulesLoaded = false` (set only when the config read
succeeded); while false render the toggle disabled with a "Couldn't read this setting.
Try again" line (retry → `loadStatus()`) when the read failed.

### 6. SHOULD — server update with an unknown starting version can only end in "Couldn't confirm" after 10 min
`SettingsUpdatesStore.swift:77,103-108`.

`check()` swallows a failed `serverVersion()` read, so `serverVersion` may be nil while
the server row still offers Update. `confirmServerUpdate` then captures
`fromVersion: nil`; `UpdateTargets.landed` is false for a nil side, so even a perfectly
successful update spins "Restarting the box…" for 600 s and reports failure.

Fix: in `confirmServerUpdate`, if `serverVersion == nil` read it first (`try? await deps.version()`);
if still nil, end the flow with `.failed("Couldn't read the box's current version. Check again.")`
instead of applying. Add a store test with an injected failing `version`.

### 7. SHOULD — CLI launch options: a nil config read silently wipes other launchers' saved flags
`ExtensionsLaunchersScreen.swift:33-45` (`reload`).

`configGet()` returns `[String: JSONValue]?`; nil is treated as "nothing saved"
(`savedFlags(from: nil) == [:]`). The next toggle writes `launcherFlags` containing only
that launcher's map; `config:update` replaces the top-level key, so every other
launcher's saved flags are lost.

Fix: in `reload`, treat a nil config as a load failure:
`guard let current = try await config else { load = .failed("The box sent no settings."); return }`.

### 8. SHOULD — the Remove-server ordering is only tested at the reducer level
`BoxRemovalStore.swift` (no tests).

F15's core guarantee lives in the store's I/O sequencing (revoke → Keychain delete →
warning → announce; retry never re-revokes), and `Dependencies` / `announceRemoved` are
already injectable. Add `MantaUITests/BoxRemovalStoreTests.swift` (@MainActor, app-target
only): (a) revoke result `.unreachable` → delete called once → state `.warning`,
`announceRemoved` NOT called until `acknowledge()`; (b) delete throws → `.localDeleteFailed`,
`retryLocal()` calls delete again and `revoke`/`devices` call counts stay 1; (c) devices
throws `MantaError.authRequired` → no revoke call, leaves directly.

### 9. NIT — Registries: context-menu "Remove" is a silent no-op while a save runs
`ExtensionsRegistriesScreen.swift:162-164`. The × button is disabled while `saving`, the
context-menu item is not, and `persist` returns false silently. Add `.disabled(model.saving)`
to the menu button.

### 10. NIT — duplicate registry URLs from the box break `ForEach(id: \.self)`
`ExtensionsRegistriesScreen.swift:138`. Dedupe in `urls(from:)` (preserve order) or use
`Array(model.urls.enumerated())` with `id: \.offset`.

### 11. NIT — `BoxPairingQR.render` builds a `CIContext` on every body pass
`BoxPairingQR.swift:42`. Hoist a `private static let context = CIContext()`.

### 12. NIT — `isIdleTimerDisabled` is forced to false on disappear
`BoxAddDeviceScreen.swift:155-159`. Capture the previous value on appear and restore it.

### 13. NIT — capture harness has no scenes for the new onboarding phases
`MantaOnboarding.swift` `prepare(onboardingScene:)`: add `"confirm"` / `"not-mine"` cases
(staging the synthetic payload) so the new screens can be measured like the others.

### 14. NIT — CLI update clears its spinner before the re-check finishes if a check was already running
`SettingsUpdatesStore.swift:174-190`: `check()` returns immediately when `checking` is true,
so `cliUpdatingID = nil` happens against stale rows. Await the in-flight check (keep a
`checkTask` and await it) instead of returning early.

### 15. NIT (integration note, not a WS10 defect) — Remove server is a dead end until M-10-2 lands
Until WS04 applies M-10-2 in `MantaAppRoot`, `.mantaBoxRemoved` has no listener: the
Keychain is deleted and the user stays on Settings. The integration agent must not ship
A1 without A2's M-10-2.

## Spec conformance notes (accepted deviations)
- T10 cases live in `SettingsBoxTests.swift` rather than `MantaPairingTests.swift` — fine
  ([pkg] file, every F21 table row present).
- F17 uses a hand-rolled "N min ago" instead of `RelativeDateTimeFormatter` and a button +
  context menu instead of a swipe action (rows are panels, not a `List`) — acceptable, tested.
- `TransportFailure` (numeric URLError codes) instead of `URLError` in `RawRPCResponse` —
  justified for Linux [pkg] tests.
- `UpdateTargets.describe` says "Update available" (matches desktop `describeUpdateTarget`).

VERDICT: CHANGES REQUIRED
