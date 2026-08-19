# Native iOS app — agent guide

This file is the Swift half of the repo's agent guidance. The root `AGENTS.md`
covers the Electron desktop app and the Node box server; this one covers the
~21k lines of Swift in `mobile/native/` — the app where the live crashes are.

Read this before touching anything under `mobile/native/`. It is a map, not a
tutorial; every claim below was verified against the code at the time of
writing (2026-08-18). If a number or path reads wrong now, trust the code.

## 1. Orientation

`mobile/native/` is the **native iOS client** for MantaUI: a SwiftUI app
(`${PRODUCT_BUNDLE_IDENTIFIER}` = `com.antoinedc.mantaui`) that talks to the
box server over HTTPS with a bearer token from the Keychain. It is one
consumer of the box's RPC + `/events` HTTP surface, exactly parallel to the
desktop and web clients described in root `AGENTS.md` — this client just
speaks to it natively rather than through Electron.

It sits in the monorepo under `mobile/native/` alongside `mobile/www/` (the
retired web bundle — not this). The box server/desktop concerns in root
`AGENTS.md` still apply; this file only layers the Swift-specific detail on
top.

## 2. Layout and architecture

- **One flat app target.** All application code lives in `MantaUI/` — **63
  `.swift` files, 21,322 lines** (counted `find MantaUI -name '*.swift'`).
  There is no module split: no SwiftPM target for the app itself, no
  architecture framework, no DI container. View models are plain SwiftUI
  `ObservableObject` stores.
- **The mass is in a few files.** Know where the size is before you edit:

  | file | lines |
  |---|---|
  | `MantaUI/ChatScreen.swift` | 1,710 |
  | `MantaUI/ComposerView.swift` | 1,426 |
  | `MantaUI/ChatSessionStore.swift` | 1,080 |
  | `MantaUI/SessionListView.swift` | 956 |
  | `MantaUI/TranscriptComponents.swift` | 796 |
  | `MantaUI/MantaOnboarding.swift` | 759 |
  | `MantaUI/MantaAPIClient.swift` | 738 |

- **15 `ObservableObject` stores** (`UsageStore`, `VoiceRecorder`,
  `MantaQRScannerModel`, `VoicePlaybackEngine`, `TerminalSessionState`,
  `MantaOnboardingFlow`, `ComposerTextController`, `ChatModelCatalog`,
  `SessionListStore`, `MantaSettingsStore`, `ChatSessionStore`,
  `ChatModelStore`, `MantaPushRouter`, `MantaPairingRouter`,
  `MantaEventStore`). Every one is `@MainActor`-isolated — see Concurrency.
- **Two files are machine-generated and compiled in from outside this
  directory.** `project.yml` references them by path (`../../generated/swift/`),
  so they are NOT part of the `MantaUI/` folder entry:

  | generated file | generator | source |
  |---|---|---|
  | `generated/swift/Theme.swift` | `npm run gen:swift-tokens` (`scripts/gen-swift-tokens.mjs`) | `src/renderer/tokens.css` |
  | `generated/swift/SettingsSchema.swift` | `npm run gen:swift-settings` (`scripts/gen-swift-settings.mjs`) | `src/shared/settingsSchema.ts` |

  **Never edit them by hand.** They are regenerated from TypeScript sources and
  committed; a hand-edit is silently discarded on the next regeneration, and CI
  runs `--check` on both generators to catch drift. The Swift source of truth
  for design tokens and the settings inventory is the generated file.
- **Two test bundles, doing very different jobs:**

  - `MantaUITests` — the **real unit suite**: 23 files, **552 `func test…`
    methods** (XCTest). This is the merge gate.
  - `MantaUIUITests` — **NOT a conventional regression suite.** Project.yml's
    own comment and `FINDINGS.md` are explicit: it is the **hierarchy-dump leg
    of the native capture harness**, driven by `capture.sh`, and its tests
    pair against a fixture box on `127.0.0.1:8787` that only the capture
    harness runs. Run in Xcode or CI without that fixture they go red for
    environmental reasons on any branch. **Do not treat a `MantaUIUITests`
    red as a code verdict, and do not add "regression" tests to it.**

## 3. Build: xcodegen is the source of truth

`mobile/native/project.yml` is **authoritative**; the committed
`MantaUI.xcodeproj/project.pbxproj` is **generated**. Never hand-edit the
`.pbxproj` — the next `xcodegen generate` discards it.

- Regenerate with `xcodegen generate` inside `mobile/native/` (this requires a
  **Mac** — there is no xcodegen on the Linux box). The `ios-regen-pbxproj`
  plugin on the Mac exists precisely for this: it regenerates the committed
  `.pbxproj` and pushes a branch when `project.yml` changes from the box.
- The two Swift generators above run before xcodegen in the build (and on CI);
  see §4 for the Mac-side plugin that does this.
- `project.yml` declares `SWIFT_VERSION: "6.0"` and `deploymentTarget: "26.0"`
  (iOS 26). The generated project is Xcode format 77, so it needs Xcode 26 —
  this is why CI runs on `macos-26` (see §4).

## 4. Verification — what an agent can and cannot do here

**There is no Swift toolchain, no Xcode and no simulator on the Linux dev
box** (verified: `swift`, `xcodebuild`, `xcrun` are all absent). An agent
working there **cannot compile, run or test Swift directly.** Do not attempt
it and do not report a build/test result you did not obtain.

The route to the Mac is the **plugin system** (see root `AGENTS.md`). The
relevant plugin is **`ios-mantaui`** — read its manifest with `plugin_get`
before running it. Its actions:

| action | what it does |
|---|---|
| `preflight` | read-only: reports Xcode/xcodegen/repo/signing/devices; **replays the previous run's verdict** |
| `device` | builds (Debug, `iphoneos`) + installs + launches on a real iPhone |
| `simulator` | builds (Debug), boots and launches in the iOS Simulator |
| `compile-only` | compiles the app target for a generic simulator destination, runs NO tests |
| `test` | runs **both** bundles — **not a usable gate** (UI tests go red environmentally, see §2) |
| `test-unit` | **the deterministic merge gate**: builds both bundles but runs only `MantaUITests` |
| `logs` | tail of the most recent build log (the job log is head-capped) |
| `devices` | lists iPhones the Mac can see |

Key facts that make or break a run:

- **`action: "test-unit"` is the signal an agent should actually use** — it
  closes the hole in `compile-only` (which builds the app target and runs
  nothing) without importing the UI bundle's flake. Inputs: `branch`,
  `simulator` (default `iPhone 17 Pro`), `team_id`.
- The Mac clone is **force-reset** to the requested branch and is shared with
  other builds — never expect it to hold uncommitted work.
- **`test-unit`, `simulator` and `logs` all exist** — BET-1103/1104/1105
  reference them by name and they are real actions on `ios-mantaui`.

**CI** (`.github/workflows/ios-build.yml`, on `main` at time of writing): a
single job on `macos-26` that `brew install xcodegen`, `xcodegen generate`,
then `xcodebuild build-for-testing` for `generic/platform=iOS Simulator`
(`CODE_SIGNING_ALLOWED=NO`). It is **compile-only** — it proves the app and
both test bundles compile, but never runs tests; execution stays on the Mac
plugin. It is NOT in `required-checks.json` (only `typecheck-test` is
required; the path filter means most PRs never trigger it). **There is no
SwiftLint workflow on `main` yet** — do not describe one as existing.

**Reading production crashes:** crashes are captured by **Firebase
Crashlytics** (replaced the box-upload PLCrashReporter) and read through the
`firebase` MCP server's `crashlytics_*` tools. Root `AGENTS.md` documents this
in full — the `## iOS crash reporting — Firebase Crashlytics` and `Reading
crashes from an agent session (Firebase MCP)` sections, including the required
`appId` and the four traps that look like missing data. **Go read that section
rather than re-deriving it here.** Two headlines worth repeating because they
are cheap to trip on: Debug-build symbols are attributed to
`MantaUI.debug.dylib` (not `MantaUI`), and `topIssues` returns only OPEN
issues.

## 5. Concurrency rules

The codebase is in **Swift 6 language mode** (`SWIFT_VERSION: "6.0"` in
`project.yml`) and its concurrency hygiene is genuinely good. The purpose of
this section is to keep an agent from degrading it.

Verified state (counted across `MantaUI/`):

- **Every one of the 15 `ObservableObject` stores is `@MainActor`-isolated.**
- **No file-scope `var`/`let`** and **no `static var`** anywhere in the app
  target. Global/static mutable state is absent by construction.
- **No `actor` declarations** and **no `Task.detached`** calls.
- **`@unchecked Sendable` appears exactly once** —
  `MantaAppDelegate.swift:214` (`NotificationCompletionHandler`), with a
  comment justifying it.

Rules for new code, which follow directly from the above:

- New stores are `@MainActor final class ...: ObservableObject`.
- No new global mutable state. If a singleton is needed it is `static let`,
  and either main-actor-isolated or an immutable value type.
- `@unchecked Sendable` requires a comment explaining why it is safe. One
  justified instance exists; do not add more casually.
- Prefer structured `Task {}` (which inherits the enclosing actor context)
  over `Task.detached`.

One caution worth internalizing: **Swift 6 mode converts some previously-silent
data races into deterministic runtime traps at Objective-C boundaries.** A new
crash after a concurrency-annotation change is often a pre-existing race
becoming visible, not a newly introduced bug — treat it as a signal, not a
regression to hide.

## 6. Crash-prone patterns — the section with teeth

The classic Swift footguns are in good shape here. Counted:

| pattern | count | where |
|---|---|---|
| `try!` | 2 | both are `try! NSRegularExpression` on a static regex (ArtifactDerivation, PlanDerivation) — safe by construction |
| `as!` | 1 | `MultilineTextView.swift:134` (`as! WrappingTextView`) |
| `fatalError(` | 4 | all `required init?(coder:)` = "not used" no-op storyboard-coder inits |
| force-unwrap operators | ~3 | `UsageMeters` `limit!`, `MantaPairingModels` `$0!`, `MantaEventStore` `callID!` — plus a handful of implicitly-unwrapped bridge props (`WKWebView!`, `UIButton!`) |

That is a healthy profile. **Keep it that way** — new `try!`/`as!`/force-unwrap
need the same level of justification.

But — **this is not where the app actually crashes.** The live Crashlytics
issues are all in the **chat transcript list**, which is backed by the
third-party `MessagingUI` `TiledView` (a `UICollectionView` wrapper). As of
2026-08-18 the three OPEN fatal issues on Crashlytics are:

- `TiledView.swift … _TiledView.applyChange(_:from:)` — `Invalid batch updates
  detected` / `attempt to delete item 0 from section 0 which only contains 0
  items`
- `TiledView.swift … _TiledView.applyChange(_:from:)` — `NSInternalInconsistencyException`
- `Deque+Collection.swift … Deque.subscript.getter` — `EXC_BREAKPOINT`

**The failure mode:** `TiledView` keeps a log of changes and replays it to
animate updates; when that log disagrees with the actual transcript, UIKit
detects the impossible arithmetic and deliberately terminates the process.
The two in-app names to know:

- `ChatSessionStore.swift:172` — comment on the `rows` property headlined
  **`invalid-batch-updates / deque-out-of-bounds crash pair`**: the `TiledView`
  data source is owned by each view (not the store) so its change log and the
  view's replay cursor share a lifetime. A store-owned data source replays from
  the beginning against a final snapshot whenever a new view is created — the
  exact crash pair this comment names.
- `TranscriptRow.swift` — `uniqueTranscriptRows` (and the `stableScrollID`
  extension): `MessagingUI`'s `ListDataSource.apply` builds
  `Dictionary(uniqueKeysWithValues:)` over row ids on its diff path, which
  **traps on a duplicate**. A comment documents that the app crashed exactly
  when scrolling up after `loadEarlier()` widened the window into older
  history where ids collided.

**The operative rule for an agent: anything that changes transcript row
identity, row ordering, or the update path is high-risk.** Row ids must be
deterministic and reproducible from the block alone, because a canonical
refetch re-derives them (see `stableScrollID`/`uniqueTranscriptRows`).

This area has been diagnosed and fixed **more than once** and has recurred
each time. BET-1103, BET-1104 and BET-1105 rewrote exactly this, and **all
three are now merged into `main`** (verified 2026-08-19):

- **BET-1103** — stable identity for the `.steps` transcript block.
- **BET-1104** — the hand-rolled transcript gestures are **gone**, replaced by
  MessagingUI's own recognisers (`eda646e1`). The reveal is now horizontal-only
  (`abs(x) > abs(y) && x < 0`) and runs *simultaneously* with the scroll pan, so
  **it cannot swallow a vertical drag** — do not diagnose a scrolling fault as
  the reveal gesture eating the pan. That mechanism no longer exists.
- **BET-1105** — the list renders from a plain snapshot of the rows; the
  hand-rolled `ListDataSource` and its append-only change log are gone, which
  removed the mechanism behind the "invalid batch updates" crash.

Row identity still matters, but the sharpest edge is gone. **Verify against the
code on your base rather than trusting this paragraph** — an earlier version of
it said BET-1104 was unmerged for a day after it landed, and that stale line
sent an agent chasing a gesture that had already been deleted. Treat any new
`TiledView`/batch-update crash as a likely regression of this family.

## 7. Networking and error handling

- **One RPC client:** `MantaUI/MantaAPIClient.swift` — a single `URLSession`
  client over the box's JSON-RPC-ish surface (`channel` + `args` per method,
  bearer `Authorization` header from `KeychainCredentialStore`). It exposes
  `call` / `callRequired` / `callVoid` helpers and the raw methods the screens
  need.
- **The error it throws:** `MantaError` — `authRequired`, `server(String)`,
  `transport(String)`, and `storedButUntranscribed(noteID:)` (the voice-clip
  409 path where the recorder must be kept so the caller can surface a retry).
- **Two WebSocket paths, two owners:**
  - `MantaEventStore.swift` owns the `/events` stream (`comps?.path = "/events"`),
    the interpreted event bus the session list and chat stores consume.
  - `TerminalSocket.swift` owns the terminal WebSocket
    (`URLSessionWebSocketTask`) — the `WKWebView` deliberately never opens a
    connection of its own, so a reconnect keeps the terminal text alive in
    native code.
- **The honest state of error handling:**
  - Catch blocks are consistently handled: **34 catch blocks, zero empty**
    (no `catch {}`, no `catch { _ in }`).
  - But there are **~99 `try?` sites** that swallow failures silently. The
    largest concentrations are `MantaEventStore.swift` (18), `ChatScreen.swift`
    (9), `ComposerView.swift` (6). Many are legitimate — tolerant decoding of
    unknown stream frames, `try? JSONSerialization` where a nil just means
    "not that shape", sleeps. A smaller set are genuinely fire-and-forget
    network calls where the caller chose to ignore the failure. Before relying
    on a `try?` you did not write, read the surrounding comment to tell which
    kind it is.

## 8. Testing conventions

- **Framework: XCTest.** There is no Swift Testing (`@Test` / `import
  Testing`) anywhere in the repo (verified).
- **The real suite is `MantaUITests`: 552 `func test…` methods across 23
  files** (counted). `MantaUIUITests` are capture drivers — see §2, not a
  regression suite.
- **The pattern the codebase already follows:** pure, derivable logic is
  factored into separate types, and **those** are what the unit suite targets.
  Real examples: `ChatModels.swift` (wire→`TranscriptBlock` mapping) tested by
  `ChatTranscriptTests` + `ChatStreamMergeTests`; `MantaPairingModels.swift`
  (pairing/claim logic) tested by `MantaPairingTests`; `PlanDerivation.swift` /
  `ArtifactDerivation.swift` by their tests; `SessionModels.swift` by
  `SessionModelsTests`; `Waveform.swift`, `VoiceGesture.swift`,
  `ComposerTypeahead`, `ModelRecents`, `UsageMeters`, `TerminalModels` all
  follow the same extract-and-test shape.
- **Instruction for new work:** when adding logic to a large view or store
  (the mass in §2), **extract the pure part into its own type and unit-test
  it**, rather than testing through the UI. This is not a nicety — it is how
  this codebase keeps a 1,700-line `ChatScreen` and a 1,080-line
  `ChatSessionStore` correct.

## 9. Known traps

A short list of things that have bitten before and are non-obvious. Root
`AGENTS.md` documents the Crashlytics/dSYM/TestFlight traps in detail — go to
its iOS sections for the full write-up; the essentials are:

- **Crashlytics dSYM:** Debug-installed builds need the `dSYM` BUNDLE uploaded
  (the split `ENABLE_DEBUG_DYLIB` two-UUID trap) or crashes stay
  unsymbolicated. Do not "fix" the in-build upload phase back to Firebase's
  `Crashlytics/run` wrapper — it silently uploaded nothing. By reference to
  root `AGENTS.md`.
- **`MantaUIUITests` need the fixture box** on `127.0.0.1:8787`; run without
  it, they fail environmentally. Never a code verdict.
- **Generated Swift** (`Theme.swift`, `SettingsSchema.swift`): edit the
  TypeScript source and regenerate (`npm run gen:swift-*`), never the `.swift`.
  CI's `--check` gate fails on drift.
- **`project.pbxproj` is generated** — edit `project.yml` and re-`xcodegen`,
  never the `.pbxproj` by hand.
- **The transcript-list crash family** (§6) is the app's live crash surface —
  treat row-identity/ordering changes as high-risk and check which of
  BET-1103/1104/1105 (see §6) have landed on your base.
