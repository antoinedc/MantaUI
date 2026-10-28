# iOS ↔ desktop parity — master spec

Status: draft · Date: 2026-10-28 · Branch: `feat/ios-desktop-parity`

## Goal

Bring the native iOS app (`mobile/native/`) to feature parity with the desktop
renderer (`src/renderer/`), except for the items explicitly excluded below. Each
gap is owned by exactly one workstream spec in this folder. This file pins
everything that crosses workstreams: scope, ownership, waves, shared contracts.

## Out of scope (decided by the user — do not build)

- On-call CTO in any form (overview pane, CTO chat, CTO settings, voice call).
- Typing/sending into a subagent; the subagent screen stays read-only.
- The Auto-routing indicator in the composer ("◆ … · routed", one-tap revert).
- The optimizer savings pill ("↓ N% this conversation").
- Desktop-only by nature: SSH install, macOS screenshot detection, drag-and-drop,
  keyboard shortcuts, OS file "Reveal", plugins executor toggle *execution*
  (the Mac runs plugins; the phone may only view/edit the setting).
- Design-cut items from `docs/mobile-redesign/DECISIONS.md`: per-session mute,
  an "Attach" row in the chat overflow sheet, creating scheduled tasks.

## Workstreams

| # | Spec | Covers |
|---|---|---|
| 01 | `01-transcript.md` | inline images/files/media in transcript; reasoning + verbose tool output toggle; collapsed `/command` user turns; turn footer (duration, tokens, truncated); copy buttons on code blocks + tool output; Quote / Quote in new session buttons |
| 02 | `02-chat-cards-queue.md` | retry card; compaction card + "compacted while away"; blocked-needs-decision card; send-error Reconnect / Reset health; background-job approval card; read-only bar for background-job sessions (Go to parent / Stop job); queued-message drain at step boundary; edit/remove queued messages; seat-in-use in context sheet |
| 03 | `03-composer.md` | custom slash commands + skills in `/` palette; `@` agents and references in typeahead |
| 04 | `04-sessions.md` | rename inside chat; mode switch (chat / terminal / installed AI CLI); create terminal-only or CLI session; new-session options (worktree + branch name, start from scratch); repo scan / first-run setup; Clone from GitHub; close a whole project; worktree prompt on close; "N subagents" + "stopped by limit" in rows; quick session switcher |
| 05 | `05-git-pr-review.md` | branch/PR sheet (create PR, PR status, merge); checks chip + check list + "send failures to agent"; Connect GitHub (device flow); review screen (diff, line comments, threads, verdict, submit); work inbox (issues, review requests, failing PRs) |
| 06 | `06-search.md` | conversation search across all chats (server `opencode:search-messages`), jump to message (incl. other session) |
| 07 | `07-artifacts-cards.md` | artifacts Plans tab, search, Jump to message, Attach to message, expiry; agent-sent file notice; webhooks card; secrets "shared" scope |
| 08 | `08-accounts.md` | add seat; re-sign a logged-out seat; connect provider (Claude / Codex / Kimi); custom endpoint form; per-model on/off; disconnect / refresh / remove |
| 09 | `09-models-usage.md` | models table (default / in picker / subagent); spend ledger; optimizer dashboard (read-only view); unidentified models fix-up; model price form; resume-after-limit screen; usage alerts (90% / limit with remind / keep going) |
| 10 | `10-settings-box.md` | missing settings (worktree toggles, auto-save files, theme override, haptics toggle, opencode port, restore windows); extensions (plugins list, forge rules + GitHub, skill registries, references, CLI launch options); box (add a device, remove server, restart opencode, device list + revoke); server update check/apply; upgrade screen actions (retry / roll back / copy details); pairing: "Link this phone?" confirm + no Box ID field |
| 11 | `11-server-consolidation.md` | server-first consolidation (D23/D24): moves logic already ported in waves A–C (WS01/03/04/08/10 + older ports) onto the box, switches the desktop, deletes the Swift ports; capability store/guardrail (runs alone, wave D) |

## Ground rules for every workstream

1. **Server first, reuse, don't fork.** The desktop renderer reaches the box only
   through `/rpc/<channel>`, `/events` and `/api/*`. Every feature must use the
   SAME channel/route the desktop uses (cite the desktop call site + server
   handler in the spec). A new server route is allowed only when the desktop
   capability is genuinely Electron-local; it then lives in its own server module
   and the spec defines its contract (route, payload, errors, auth) in full.
2. **No dead controls** (root `AGENTS.md`). Every control does the thing and
   says so, fails with an actionable message, or is not rendered.
3. **Swift rules** (`mobile/native/AGENTS.md`): `@MainActor final class` stores,
   no global mutable state, no new `try!`/`as!`/force-unwraps, no `catch {}`.
   Pure logic is extracted into its own type and unit-tested in `MantaUITests`
   (XCTest). Transcript row identity/order changes are high-risk (§6 there) —
   new transcript rows must have deterministic ids derived from the block alone.
4. **Desktop parity is behavioural, not visual.** Use native iOS idioms (sheets,
   swipe actions, context menus, `ShareLink`, QuickLook) and the generated
   `Theme.swift` tokens. Never edit `generated/swift/*` by hand — change the TS
   source and run `npm run gen:swift-tokens` / `npm run gen:swift-settings`.
5. **Plain-language copy**, no jargon; match desktop wording where it exists.

## Shared contracts

### C1. API client extensions

`MantaAPIClient`'s `call`, `callRequired`, `callVoid`, `jsonAny`, `jsonObject`
are made `internal` (foundation commit, done before wave A). Each workstream adds
its RPC methods in its OWN file `MantaUI/MantaAPIClient+<Area>.swift`
(`+Transcript`, `+ChatCards`, `+Composer`, `+Sessions`, `+Git`, `+Search`,
`+Artifacts`, `+Accounts`, `+Models`, `+Settings`). Nobody else edits
`MantaAPIClient.swift`. Decodable wire types live next to their extension (or in
the workstream's models file), never in a shared file.

### C2. Cross-feature navigation

One app-level router value, added by WS04 in a new file `MantaNavigation.swift`:

```swift
enum MantaRoute: Hashable {
  case session(windowKey: String)                       // open a session (chat or terminal)
  case message(sessionID: String, messageID: String)    // open chat + scroll + highlight
  case review(sessionID: String)                        // WS05 review screen
  case settings(section: String?)                       // WS10
}
@MainActor final class MantaNavigator: ObservableObject {
  @Published var pending: MantaRoute?
  func open(_ route: MantaRoute)
}
```

Injected as an `@EnvironmentObject` from `RootView`. WS04 implements `.session`
and `.settings`; WS02 implements `.message` handling inside the chat screen
(scroll-to + highlight; uses the existing load-earlier path if the message is
outside the window); WS05 implements `.review`. WS06 and WS07 only *call*
`open(...)`. Until a route's owner lands, `open` for it must not be called.

### C3. Composer insertion

Quote (WS01), "send failures to agent" (WS05), Attach artifact (WS07), inbox
"start a session" (WS05) all need to put text/attachments into a composer. WS03
adds to the composer controller (`ComposerTextController`) one public API:

```swift
@discardableResult func insert(text: String, mode: ComposerInsertMode) -> Bool
  // .append = existing draft + blank line + text (just text if draft empty)
  // .replace = whole draft replaced
  // .quote   = the quote format iOS already ships (QuoteText.buildQuoteBlock) — see D4
@discardableResult func attach(remotePath: String, displayName: String, mime: String?) -> Bool
  // existing chip pipeline for an already-uploaded file
```

Both return `false` when they reject (e.g. composer read-only, attachment limit
reached, duplicate); EVERY caller must surface a rejection to the user (hint or
toast) — never ignore the Bool. The new-session value is `NewSessionDraft`,
defined once per D2.

### C4. Chat-screen mount points (hotspot)

`ChatScreen.swift`, `ChatSessionStore.swift`, `MantaEventStore.swift` and
`MantaStreamModels.swift` are OWNED by WS02. Other workstreams that need a mount
in the chat screen ship a self-contained view in their own file and list the
exact mount in their spec under "Mount requests"; the WS02 implementer — or the
later-wave owner, see Waves — applies it. Allowed mounts:

- WS01: transcript rows are already rendered by WS01-owned files; WS01 may not
  edit ChatScreen except via the existing quote callback.
- WS05: the branch chip `onTap` → present `BranchSheet`; a checks chip view
  beside the branch chip.
- WS06: a search button in the chat nav bar → present `SearchScreen`.
- (WS09 seat-row bullet voided by D17.) Further allowed mounts are exactly
  those listed in workstream `Mount requests` tables under D18.

### C5. New stream frames

If a workstream needs a frame the iOS event store does not decode yet (e.g.
`retry`, `compaction`, `truncation`, `commandExecuted`), it is decoded by WS02
in `MantaStreamModels.swift` and exposed on `ChatSessionStore` as a published
property. WS01 consumes `truncation` / `commandExecuted` / `stepEnded` data
through properties WS02 publishes; WS01's spec names the property and WS02's
spec defines it. Frame names/payloads are those emitted by
`src/server/streamInterp.mjs` — do not invent frames.

### C6. Settings schema

Settings that exist on desktop but are `platform: "desktop"` in
`src/shared/settingsSchema.ts` move to `"both"` only via WS10, which regenerates
`generated/swift/SettingsSchema.swift`. No other workstream edits the schema.

### C7. Tests

Each workstream adds XCTest files named `MantaUITests/<Area>Tests.swift` for its
pure logic, and node tests for any server module it adds. The desktop suites
(`npm run typecheck`, `npm test`) must stay green.

## File ownership

| WS | Owns (may edit) | New files prefix |
|---|---|---|
| 01 | `ChatModels.swift`, `TranscriptComponents.swift`, `TranscriptRow.swift`, `ToolActivity.swift`, `ActivitySheet.swift`, `VoiceNotePlayer.swift` | `Transcript*` |
| 02 | `ChatScreen.swift`, `ChatSessionStore.swift`, `MantaEventStore.swift`, `MantaStreamModels.swift`, `PendingPrompt.swift`, `RunningIndicator.swift`, `UsageSheets.swift` (context sheet + M-09-9 receipt), `BackgroundJobsSheet.swift` (D28) | `ChatCard*` |
| 03 | `ComposerView.swift`, `ComposerTypeahead.swift`, `ComposerHistory.swift` | `Composer*` |
| 04 | `SessionListView.swift`, `SessionListStore.swift`, `SessionModels.swift`, `SessionCreateSheet.swift`, `FolderPickerView.swift`, `RootView.swift`, `MantaAppRoot.swift` | `Session*`, `MantaNavigation.swift`, `CloneFromGitHub*` |
| 05 | — (new files only + mounts) | `Git*`, `Review*`, `Inbox*` |
| 06 | — (new files only + mounts) | `Search*` |
| 07 | `SessionResourceCards.swift`, `ArtifactDerivation.swift`, `ChatOverflowSheet.swift` | `Artifact*`, `Webhook*` |
| 08 | `AccountsScreen.swift`, `AccountsStore.swift`, `AccountsModels.swift` | `Accounts*`, `Provider*` |
| 09 | `UsageMeters.swift`, `ModelPickerSheet.swift`, `ChatModelCatalog.swift` | `Models*`, `Usage*`, `Optimizer*` |
| 10 | `SettingsScreen.swift`, `MantaSettingsStore.swift`, `MantaSettingsModels.swift`, `UpgradeScreen.swift`, `UpgradeStore.swift`, `UpgradeModels.swift`, `MantaOnboarding.swift`, `MantaPairingModels.swift`, `src/shared/settingsSchema.ts`, `generated/swift/SettingsSchema.swift` | `Settings*`, `Box*`, `Extensions*` |
| 11 | any file (wave D runs alone, D24) | `BoxCapabilit*`, `UpdateBoxNote*`, `TranscriptView*` |

Server-side: any new server module is owned by the workstream that adds it;
registering a channel in `src/server/rpc.mjs` / a route in `index.mjs` is an
additive edit allowed only in the wave where that workstream runs alone on that
file (see Waves).

## Waves (implementation order)

Workstreams in the same wave never share a file.

- **Wave 0 (orchestrator):** foundation — C1 visibility change, empty
  `MantaNavigation.swift` scaffold (C2 types + no-op `open`), composer insertion
  API signatures (C3) stubbed to real behaviour by WS03 in wave A.
- **Wave A:** WS01, WS03, WS04, WS08, WS10.
- **Wave B:** WS02, WS07, WS09, WS06 (WS06 adds its session-list entry point
  after WS04 has landed).
- **Wave C:** WS05 (needs WS02's ChatScreen and WS03's insertion API).
- **Wave D:** WS11 alone (D24), after C-int; sub-steps D1…D11 in order.

Server-file conflicts (superseded by D24/D27): in wave B no worker edits
`rpc.mjs` / `index.mjs` / `streamInterp.mjs`; integration agent B applies every
registration in the ordered "Server registration mounts" table. Waves C and D
have a single worker that edits them directly.

## Consolidation decisions (binding; override any workstream spec that disagrees)

D1. **Ownership amendments.** `MantaModels.swift`, `MantaUIApp.swift` → WS01.
`InboxModels.swift`, `PendingMessagesCard.swift`, `HandoffStore.swift` → WS02.
`TerminalScreen.swift`, `TerminalWebView.swift`, `TerminalModels.swift` → WS04
(additive edits only). `ChatModelStore.swift` → WS09. `mobile/native/Package.swift`
and `project.yml` → WS07 (wave B); any other workstream needing a package or
project change lists it as a mount request. Navigator injection happens in
`MantaAppRoot.swift` (not `RootView`, which is the capture-harness fixture).
WS07 mounts its agent-file notice in `MantaAppRoot.swift` in wave B.

D2. **`NewSessionDraft` is defined once, in `MantaNavigationModels.swift`** — a Foundation-only file (listed in `Package.swift` by M-04-8) holding ONLY `NewSessionDraft`, `NewSessionDraftAttachment` and `MantaRoute`; the observable `MantaNavigator` stays in app-only `MantaNavigation.swift` (round-3 seam fix) (wave-0
scaffold, owned by WS04 afterwards):

```swift
struct NewSessionDraftAttachment: Hashable, Sendable { var remotePath: String; var displayName: String; var mime: String? }
struct NewSessionDraft: Hashable, Sendable {
  var cwd: String?                 // absolute box path; nil = user picks
  var text: String                 // composer seed — placed in the new chat's composer, NEVER auto-sent
  var attachments: [NewSessionDraftAttachment]
  var worktreeBranch: String?      // non-nil = create flow pre-ticks "new worktree" with this branch name
  var linkedIssueURL: String?      // informational; shown in the create sheet header (WS05 inbox)
}
// on MantaNavigator:
func startNewSession(_ draft: NewSessionDraft)   // presents WS04's create sheet prefilled
```

WS03's `ComposerTextController.newSessionDraft(cwd:)` produces this type; WS03
must not declare a second `NewSessionDraft`. The create sheet always needs one
user confirmation (Create) — no silent session creation.

D3. **`ComposerTextController` adoption in `ChatScreen.swift`** is done by WS03
in wave A as a minimal, additive edit (WS02 does not run in wave A). WS02 builds
on it in wave B.

D4. **Quote format**: keep the behaviour iOS already ships (WS03 F6 default);
C3's `.quote` wording follows WS03's spec.

D5. **GitHub device sign-in** is built ONCE by WS04 in wave A as a reusable view
(`GitHubDeviceSignIn` in `CloneFromGitHub*`), to the contract written in WS05 §4.
WS05 reuses it.

D6. **"Send failures to the agent"** appends (C3 `.append`), never replaces.

D7. Accepted server changes (and only these): WS08 S1 (`ptyWs.mjs` refuses
hidden sign-in launchers); WS09 `models:unidentified` channel in
`src/server/modelsUnidentified.mjs` with a desktop-parity node test; WS10
`current` flag on `GET /auth/devices`. Wave A: WS08 (`ptyWs.mjs`) and WS10
(`devices.mjs`, `auth.mjs`, `index.mjs`). Wave B: WS09 (`rpc.mjs`).

D8. Accepted deferrals: "Reset health" (Auto routing never runs from iOS);
auto-save files, downloads folder, opencode port; revoking the shared desktop
pairing from the phone; model tier tag/description; matched-text highlight after
a search jump; the gateway code→box lookup (manual pairing becomes one "Server
address" field + code).

D9. Defaults accepted from specs: search session-list entry sends `maxPrimary: 3`;
"show reasoning & full output" is an app-wide persisted toggle, off by default;
secrets default scope = shared (desktop parity); agent-file notice always shown;
custom-endpoint save does not restart opencode, API-key / device-code connect
keeps desktop's restart-and-poll; "Edit last" queued message asks before
replacing a non-empty draft; "Go to parent" uses `MantaNavigator.open(.session)`;
background job from the inbox asks "Run under which session?".

D11. **One `NewSessionDraft`, no other.** WS03 declares NO draft type; its
`ComposerTextController.newSessionDraft(cwd:) -> NewSessionDraft` maps READY
`ComposerAttachment` chips → `NewSessionDraftAttachment` (`remotePath`,
`displayName`, `mime`), and WS04's create flow maps back via
`ComposerTextController.attach(...)` on the new chat's composer. Defaults:
`worktreeBranch = nil`, `linkedIssueURL = nil` unless the producer sets them.
WS04's prefill: `cwd` preselects the project/folder; `worktreeBranch` pre-ticks
"new worktree" with that branch; `linkedIssueURL` shows as a header line; `text`
+ attachments seed the new chat's composer (`HandoffStore` carry-over is the
transport WS04 uses internally — not a public contract).

D12. **Producers of a NEW session go through
`MantaNavigator.startNewSession(_:)` and the WS04 create sheet with one
Create tap.** Exception: "Quote in new session" (WS01) keeps desktop parity —
it FORKS the current session and seeds the fork's composer with the quote
(desktop `QuoteToolbar.tsx:3`, `ChatPanel.tsx:2130`; iOS already does this in
`ChatScreen.swift`), so it does not use `NewSessionDraft`. WS05's
inbox "Start a session" passes `cwd` (repo path), `worktreeBranch`, `linkedIssueURL`
and a seed `text` that includes the issue URL; it creates NO worktree or session
itself (creation happens on Create). Any `forgeIssue` association is dropped.
Only the Quote BUTTON wiring is new (WS01 rows → existing ChatScreen callback).

D13. **WS03 does all composer-adoption edits in `ChatScreen.swift` in wave A**
(D3), as a declared exception in its Files list. WS02 consumes the adopted
controller; no legacy-binding fallback.

D14. **GitHub device sign-in canonical API** (owned by WS04, wave A, files
`CloneFromGitHubSignIn.swift` + `MantaAPIClient+Sessions.swift` methods + tests):

```swift
@MainActor final class GitHubDeviceSignInStore: ObservableObject { ... }
struct GitHubDeviceSignInView: View {
  init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void)
}
```
WS05 consumes exactly this; WS05 creates no device-flow store/sheet of its own.

D15. **C5 command frame contract:** WS02 publishes on `ChatSessionStore`
`@Published var commandByMessageID: [String: StreamCommandExecutedPayload]`
where `StreamCommandExecutedPayload { messageID: String; name: String; arguments: String }`
(server always sends a string, `""` when absent — `streamInterp.mjs`). WS01
consumes this name and converts to its own mapper input. WS01's footer uses
transcript-derived data (accepted amendment to C5); no step/truncation property
is required from WS02 for the footer beyond what WS02 already decodes. Every
WS01 mount in `ChatScreen.swift`/`ChatSessionStore.swift` (mapper inputs, media,
command, display toggle) is a WS02 wave-B deliverable.

D16. **Single owners for shared client members (C1 is member-level, not
file-level).** `usageStoppedList()` + its decoding + stopped records live in
WS04 (`SessionListStore` is the one source of stopped state, wave A). WS09's
resume screen reads WS04's records/API — WS09 creates NO stopped store and no
second fetch. `forgeStatus(validate: Bool)` + its wire type are owned by WS10
(wave A, `MantaAPIClient+Settings.swift`); WS05 calls it. Before dispatching each
wave the orchestrator greps all `MantaAPIClient+*.swift` member names for
duplicates.

D17. **Seat row in the context sheet:** WS02 renders it from the existing
`AccountsStore.conversationSeat` projection; WS09 F8 is removed. C4's WS09 bullet
is void.

D18. **Integration steps (fixes same-wave shared-file edits).** After each wave's
workers finish, ONE integration agent (dispatched by the orchestrator) applies
every mount whose receiving file is NOT owned by a worker running in that wave,
in ledger order, and updates `Package.swift` (pure-logic files only) and
`project.yml` from the workers' manifests. Specifically:
- Wave B: `SessionListView.swift` (WS06 search entry, WS09 resume/stopped entry),
  `MantaAppRoot.swift` (WS07 agent-file notice, WS09 stores/overlay/sheet),
  `SettingsScreen.swift` (WS09 models/usage rows) → integration agent B.
- ChatScreen/ChatSessionStore/MantaEventStore mounts requested by WS01, WS06,
  WS07, WS09 in waves A/B → WS02 applies them in wave B (provider symbols are
  pinned in the requesting spec, so WS02 can write the call even if the provider
  lands in the same wave).
- ChatOverflowSheet mounts (WS01 display toggle, WS02 read-only guard, WS04
  rename/mode rows) → WS07 applies them in wave B.
- Wave C: WS05 runs alone and applies all of its own mounts in any file.
- `MantaUI.xcodeproj/project.pbxproj` is regenerated once, at the end, by the
  orchestrator via the Mac (`ios-regen-pbxproj` / build). Workers never edit it.
Workers list mounts in a `Mount requests` table with columns: ID (`M-<ws>-<n>`),
receiving file, applier (per this rule), provider symbol(s), exact change,
prerequisite.

D19. **Inner-loop verification:** `mobile/native/verify.sh` compiles + tests the
Foundation-only subset (`Package.swift`) in Docker on the Linux box. Pure-logic
files that import only Foundation must be added to `Package.swift` (by the
integration step) and their XCTests must pass under `verify.sh`. The merge gate
remains `ios-mantaui` `test-unit` on the Mac.

D20. **Wave A is two sub-waves.** A1: WS10, WS01, WS03 (parallel). A2: WS04 and
WS08 (parallel), after A1 is committed — WS04 consumes WS10's launcher
symbols and applies WS10's `MantaAppRoot` mounts (M-10-1, M-10-2); WS08 calls
WS10's `opencodeRestart()`. `TerminalSocket.swift` → WS04 (additive only).
Integration agent A runs after A2 (`Package.swift` manifests from all wave-A
workstreams). Wave C also gets an integration step for WS05's `Package.swift`
manifest.

D21. **Launcher discovery is owned by WS10** (`launchersList()`,
`AvailableLauncher`, `ExtensionsLaunchers.resolve`, in WS10 files). WS04
consumes them; WS04 declares no `launchers()` member and WS10 does not consume
anything launcher-related from WS04. `references()` / `OpencodeReferenceInfo` are
owned by WS03; WS10 consumes. `forgeStatus(validate:)` / `ForgeConnectionStatus`
are owned by WS10; WS05 consumes. Same-wave consumers code against the pinned
signatures; the UI compile happens on the Mac after the wave is integrated.
WS10's `MantaAppRoot.swift` mounts (M-10-1 theme, M-10-2 return to onboarding)
are applied by WS04 in A2.

D22. **Slim transcripts vs WS01 (code-review finding).** iOS fetches
`opencode:messages` with `slim: true`, which drops `reasoning` and `step-finish`.
(a) Server: `step-finish` is removed from `SLIM_DROP_PART_TYPES`
(`src/server/opencode.mjs`, + node test) so finish metadata (tokens, reason →
truncation kind) survives a reload. Applied by WS01's fix round. (b) Reasoning
stays slim-dropped; while `TranscriptDisplayOptions` "show reasoning & full
output" is ON, WS02's `ChatSessionStore` fetches with `slim: false`, and flipping
the toggle triggers a refetch — new mount **M-01-7** (receiving file
`ChatSessionStore.swift`, applier WS02, wave B, provider
`TranscriptDisplayOptions` (WS01) — read the persisted toggle at fetch time and
observe its change). Provider symbols (shipped): `TranscriptDisplayOptions.fetchSlim: Bool`
(pass as `slim:`), `TranscriptDisplayOptions.didChange: Notification.Name` (refetch on it).
Also: `TranscriptMediaStore.shared.resetForBoxChange()` must be called from the
`.mantaBoxRemoved` handler in `MantaAppRoot.swift` (integration B, with M-09-4).

D23. **Server-first logic (user directive, 2026-10-28).** The box server is the
single owner of logic; desktop and iOS are presentation layers. Anything that is
a business rule, a derivation/aggregation/classification of server data, an
eligibility decision, or copy that must match across clients is computed on the
server and returned ready to render (one `/rpc` channel or `/events` frame, one
node-tested module). Clients keep only view state, gestures, local device
preferences, layout/formatting that is purely presentational, and optimistic UI.
When a server channel replaces logic the desktop already has, the desktop switches
to it in the same change (no parallel implementations, no "parity fixtures" as
the drift guard). Applies to all unbuilt workstreams (02, 05, 06, 07, 09) and,
via the consolidation workstream WS11, to logic already ported in wave A.
Authority: `server-first-audit.md` in this folder.

D24. **Server-first execution (user decisions 2026-10-28).**
- Scope = FULL: every MOVE-NOW item in `server-first-audit.md` is built in this
  effort. Items assigned to unbuilt specs (02, 05, 06, 07, 09) are folded into
  those specs; the rest form **WS11 "server consolidation"** (`11-server-consolidation.md`),
  which runs ALONE as **wave D** after wave C and also migrates logic already
  ported in wave A (WS01/03/04/08/10) and the desktop onto the server.
  MOVE-LATER items become follow-up tickets listed in WS11 "Follow-ups".
- D7 is superseded: new server modules/channels/frame fields are allowed wherever
  the audit says MOVE-NOW. Each is its own module + node tests; the desktop
  switches in the same workstream (no dual implementations). WS09's
  `models:unidentified` is consumed by the desktop too.
- Usage 90% / limit alerts are computed by the box and shown IN-APP only on both
  clients; no new push notification type.
- Deprecated-model opt-ins move to the box config (desktop's location); iOS does
  a one-time copy of its on-device opt-ins to the box, then reads the config.
- Wire compat: additive only (new fields/channels/opt-in args). The box advertises
  a capabilities list; a client on an older box hides/disables the dependent
  feature with an "Update your box to use this" note — no fallback copy of the
  old logic.
- Server file contention: workers create their own server modules + tests and
  desktop/iOS consumers; registrations in `src/server/rpc.mjs` / `index.mjs` /
  `streamInterp.mjs` are applied by the wave's integration agent in order
  02 → 07 → 09 → 06 (wave B), or by the sole worker in waves C/D. Desktop
  renderer files touched by two same-wave workers are ledgered like Swift mounts.
- WS08 (in flight) is not churned: its wording/error items go to WS11.

D25. **One capability module, one id list, one client accessor per client.**
- Server: `src/server/boxCapabilities.mjs` (`export const BOX_CAPABILITIES`),
  created by WS02 in wave B with `chat-cards-1`; WS02 also returns it as
  `capabilities: string[]` from `GET /api/version` (`version.mjs`) and
  `server:version` (M-02-srv-1). Every other id is APPENDED to that list:
  wave B by integration agent B (M-07-S2, M-09-srv-2, M-06-srv-2, in the D24
  order), wave C by WS05 itself (M-05-srv-2), wave D by WS11 (D1…D11). No other
  module (`serverCapabilities.mjs`, `boxFeatures.mjs`) is created.
- Ids follow `kebab-name-N` (`/^[a-z0-9-]+-\d+$/`); the full list is the
  "Capability id registry" below (a node test pins it).
- Client accessors (waves B/C): iOS `MantaAPIClient.boxCapabilities() async
  throws -> Set<String>` (WS02, `+ChatCards`; chat-scoped cache
  `ChatCardCapabilities` is WS02-internal); desktop `useBoxCapability(id):
  boolean | null` in `src/renderer/hooks/useBoxCapabilities.ts` (WS02). WS10's
  `serverVersion()` does NOT grow a second copy. Specs 05/06/07/09 keep their
  exact response-shape / unknown-channel detection (same "Update your box to
  use this" state, no extra round trip); any list read they do goes through
  the accessors above.
- Wave D (decided): WS11 D1 adds `ServerVersionInfo.capabilities` +
  `BoxCapabilitiesStore`, DELETES `boxCapabilities()` and `ChatCardCapabilities`
  after migrating every caller, and keeps `useBoxCapability` as the desktop
  hook (no new `boxCapabilities.ts`).

D26. **One token formatter.** `src/shared/formatTokens.mjs` (+ `.d.mts`, test),
created by WS02 in wave B, exports `formatTokenCount(n)` (compact, no unit) and
`formatTokens(n)` ("N tokens", byte-identical to today's `chatUtils.ts:219`).
`streamInterpretation.mjs`, WS09's box views, WS11's `resentText` and every
renderer caller import it; `chatUtils.ts` re-exports `formatTokens`; the
private copies (`chatUtils.formatTokensCompact`, `SessionHeader.tsx`'s
`formatTokensCompact`) are deleted by WS02. WS09 consumes it and creates no
second module. (The iOS token-formatter consolidation stays a WS11 hygiene
follow-up.)

D27. **One owner per shared desktop/server file per wave** (extends D24). Wave
B owners and the IB ledger rows for everyone else are the table "Wave-B shared
desktop / server file ownership" below. A non-owner applies its rows locally
(uncommitted) to verify; integration agent B applies them after the owner's
commit, desktop order 02 → 07 → 09 → 06, then runs `npm run typecheck` and
`npm test`. Waves C and D have one worker each, which edits any file.

D28. **`BackgroundJobsSheet.swift` → WS02 from wave B** (D1-style amendment;
it was unowned). WS02 applies M-02-5 itself; M-02-4 (`SessionModels.swift`,
WS04-owned, built) is applied by integration agent B. WS11 D7 does not touch
the sheet (job nesting is a session-list concern).

D29. **Stopped state: two channels, two jobs.** WS04's built
`usageStoppedList()` + `SessionListStore.stoppedRecords` / `stoppedLastLooked` /
`unarmedStoppedCount` / `isStopped(sessionID:)` remain the source for ROW
markers and WS09's M-09-2 capsule; WS09's `usage-stopped:view` /
`usage-stopped:apply` drive ONLY the resume screen. WS09 creates no stopped
store (D16 holds). WS11 D7 may later drive row markers from
`windowStatus.stopped`; if it retires WS04's API it migrates M-09-2 and the
desktop Sidebar marker in the same step.

D30. **WS11 open questions accepted with their defaults** (written into
`11-server-consolidation.md` "Decisions"): per-family capability ids;
per-feature gating, no compatibility-matrix bump; repeat the full `RunView` on
every message a run touches with a 30 % iOS tail-payload guard (switch to
`{id}` references beyond it); context basis falls back to the last reply's
model and is labelled "(last reply's model)"; seat-move text comes from the
box for both the notice and the dial line.

D10. Desktop bugs found while speccing (Reconnect button only clears the banner;
job approve/decline/stop swallow errors; `@@` agent typeahead never opens) are
fixed by the workstream that touches the matching iOS feature ONLY if the fix is
in a shared/pure module both clients use; desktop-renderer-only fixes are out of
scope and reported at the end.

## Mount ledger (canonical)

Binding after round 2; supersedes `reviews/round2/00-cross-cutting.md`'s
ledger and every workstream table that disagrees. Sub-waves: **A1** (WS10,
WS01, WS03) → **A2** (WS04, WS08) → **A-int** (integration agent A,
single-threaded) → **B** (WS02, WS07, WS09, WS06) →
**B-int** (integration agent B) → **C** (WS05) → **C-int** (integration
agent C) → **D** (WS11 alone; no ledger rows — it edits any file) → **final**
(orchestrator regenerates `.pbxproj`). Server registrations, capability ids and
shared desktop files have their own tables after this one (D24–D27). Files are under
`mobile/native/MantaUI/` unless a path is given. Within an integration step,
rows on the same file are applied top-to-bottom in this table's order.

| ID | Receiving file (owner) | Applier | Sub-wave | Provider symbol(s) — exact signature (owner) | Prereq |
|---|---|---|---|---|---|
| M-01-1 | `ChatSessionStore.swift` (WS02) | WS02 | B | `struct TranscriptMapOptions { showReasoning: Bool; running: Bool; liveCommands: [String: OpencodeCommandOrigin]; liveTruncation: TranscriptLiveTruncation?; liveMedia: [TranscriptMediaEntry] }`, `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:options:) -> [TranscriptBlock]`, `TranscriptCommandOrigin.fromLive(name: String, arguments: String) -> OpencodeCommandOrigin`, `TranscriptLiveTruncation.from(kind: String, messageID: String?) -> TranscriptLiveTruncation?`, `TranscriptMediaStore.shared.entries(for: String) -> [TranscriptMediaEntry]`, `TranscriptDisplayOptions.showDetails` (WS01); `ChatSessionStore.commandByMessageID: [String: StreamCommandExecutedPayload]`, `.truncation: StreamTruncationPayload?` (existing), `.presentedMessages` (WS02) | WS01 (A1) |
| M-01-2 | `ChatSessionStore.swift` (WS02) | WS02 | B | `ChatTranscriptMapper.liveMediaTail(messages: [OpencodeMessage], live: [TranscriptMediaEntry], isLiveWindow: Bool) -> [TranscriptBlock]` (WS01) | M-01-1 |
| M-01-3 | `ChatSessionStore.swift` (WS02) | WS02 | B | `TranscriptMediaStore.shared.$sessions`, `TranscriptDisplayOptions.didChange: Notification.Name` (WS01) | M-01-1 |
| M-01-4 | `ChatSessionStore.swift` (WS02) | WS02 | B | `ChatTranscriptMapper.footerTruncationMessageIDs(_ blocks: [TranscriptBlock]) -> Set<String>` (WS01); new `trailingBlocks(…, footerTruncationIDs: Set<String> = [])` (WS02) | M-01-1 |
| M-01-5 | `ChatOverflowSheet.swift` (WS07) | WS07 | B | `TranscriptDisplayOptions.defaultsKey: String`, `TranscriptDisplayOptions.setShowDetails(_: Bool)` (WS01, `TranscriptDisplayOptions.swift`) | WS01 (A1) |
| M-01-6 | `mobile/native/Package.swift` (WS07) | IA | A-int | WS01 package manifest | WS01 (A1) |
| M-01-7 | `ChatSessionStore.swift` (WS02) | WS02 | B | `TranscriptDisplayOptions.fetchSlim: Bool` (pass as `slim:`), `TranscriptDisplayOptions.didChange: Notification.Name` (refetch on it) (WS01) — per D22 | WS01 (A1) |
| M-02-1 | `TranscriptRow.swift` (WS01) | IB | B-int | `EnvironmentValues.transcriptHighlightedRowID: String?` (WS02, `ChatCardMessageFocus.swift`) | WS02 (B) |
| M-02-2 | `ChatOverflowSheet.swift` (WS07) | WS07 | B | `ChatOverflowSheet.isReadOnlyJob: Bool = false` (param, WS07); caller passes `ChatSessionStore.isBackgroundJobReadOnly: Bool` (WS02) — hides Compact, Clear, Fork, Delete, Trust toggle, Rename, Mode rows | — |
| M-02-3 | `mobile/native/Package.swift` (WS07) | IB | B-int | WS02 manifest (`ChatCardModels.swift`, `ChatCardLogic.swift`, `ChatCardsTests.swift`) | WS02 (B) |
| M-02-4 | `SessionModels.swift` (WS04, built) | IB | B-int | `delegate:list` row fields `statusLabel`, `summary` (WS02 SF-4/S16). Change: `DelegateJob` gains `var statusLabel: String? = nil`, `var summary: String? = nil` (CodingKeys + lenient decode); delete `BackgroundJobFormat.statusLabel(_:)` | WS02 (B) |
| M-02-5 | `BackgroundJobsSheet.swift` (WS02, D28) | WS02 | B | `DelegateJob.statusLabel: String?`, `.summary: String?` (pinned, M-02-4). Change: `detailLine(_:)` uses `job.statusLabel ?? job.status`; terminal jobs append `job.summary` when non-nil | M-02-4 (compiles after B-int) |
| M-03-1 | `ChatScreen.swift` (WS02) | WS03 (D13) | A1 | `ComposerTextController.init(text: String = "", attachments: [ComposerAttachment] = [], draft: NewSessionDraft? = nil)` (WS03) | wave-0 scaffold |
| M-03-2 | `ChatScreen.swift` (WS02) | WS03 | A1 | `ComposerTextController.text: String`, `.attachments: [ComposerAttachment]` (WS03) | M-03-1 |
| M-03-3 | `ChatScreen.swift` (WS02) | WS03 | A1 | `EnvironmentValues.composerController: ComposerTextController?`, `.focusRequest: Int`, `insert(text: String, mode: ComposerInsertMode) -> Bool` (WS03) | M-03-1 |
| M-03-4 | `ChatScreen.swift` (WS02) | WS03 | A1 | `ChatScreen.draft: NewSessionDraft? = nil`, `ChatScreenContent.init(…, draft:)`, `ComposerTextController.consumeSeedNotice() -> String?`, `apply(_: NewSessionDraft) -> Int` (WS03); `NewSessionDraft` (D2) | M-03-1 |
| M-03-5 | `ChatModelStore.swift` (WS09) | WS09 | B | `@Published private(set) var agentsLoadError: String?`, `func retryAgents()` (WS09 adds, WS03 specifies) | — |
| M-03-6 | `ComposerView.swift` (WS03) | IB | B-int | `ComposerTypeahead.agentRows(agents: [OpencodeAgent]?, loadError: String?, query: String, limit: Int = 12) -> [MentionRow]` (WS03); M-03-5 members | M-03-5 |
| M-03-7 | `ChatScreen.swift` (WS02) | WS02 | B | `ComposerTextController.acceptsInput: Bool` (WS03); `ChatSessionStore.isBackgroundJobReadOnly: Bool { mutationPolicy == .readOnlyJob }` (WS02). Change: `.onAppear { composer.acceptsInput = !store.isBackgroundJobReadOnly }` + `.onChange(of: store.isBackgroundJobReadOnly) { _, ro in composer.acceptsInput = !ro }` | M-03-1 |
| M-03-8 | `mobile/native/Package.swift` (WS07) | IA | A-int | WS03 manifest (`ComposerModels.swift`, `ComposerInsertion.swift` + 2 tests) | WS03 (A1) |
| M-03-9 | `ComposerView.swift` (WS03) | IB | B-int | `ChatSessionStore.mutationPolicy: ChatCardMutationPolicy` (`.resolving`, `.allowed`, `.readOnlyJob`) (WS02) | WS02 (B); after M-03-6 |
| M-04-1 | `ChatOverflowSheet.swift` (WS07) | WS07 | B | `ChatOverflowSheet.onRename: (() -> Void)? = nil` (param) | — |
| M-04-2 | `ChatOverflowSheet.swift` (WS07) | WS07 | B | params `mode: SessionMode? = nil`, `launchers: [AvailableLauncher] = []`, `launcherCatalog: SessionLauncherCatalog = .loading`, `onSelectMode: ((SessionMode) -> Void)? = nil`, `onRetryLaunchers: (() -> Void)? = nil`; `SessionModeRows(current: SessionMode, launchers: [AvailableLauncher], catalog: SessionLauncherCatalog, onSelect: (SessionMode) -> Void, onRetry: () -> Void)` (WS04); `AvailableLauncher` (WS10) | WS04 (A2), WS10 (A1). **Placement (code review):** `SessionModeRows` renders TWO top-level Sections — mount it as a SIBLING Section between the Compact/Fork section and the Trust-mode section (never inside a `Section {}`), wrapping `onSelect` as `{ m in dismiss(); onSelectMode(m) }`; mount it only when `mode`, `onSelectMode` AND `onRetryLaunchers` are all non-nil (no dead "Try again"), passing `onRetry: onRetryLaunchers`; keep "Open terminal" only when `mode == nil || onSelectMode == nil || onRetryLaunchers == nil`. Exact code: `reviews/code/04-sessions.md` finding 11 + the retry condition (WS07 spec M-04-2 receipt). |
| M-04-3 | `ChatScreen.swift` (WS02) | WS02 | B | `SessionListStore.window(forSessionID: String) -> (project: String, window: MantaWindow)?` (WS04) | WS04 (A2) |
| M-04-4 | `ChatScreen.swift` (WS02) | WS02 | B | `SessionRenameSheet(title:initialName:onSave:)`, `SessionListStore.renameSession(project: String, index: Int, newName: String) async -> String?` (WS04) | M-04-1 |
| M-04-5 | `ChatScreen.swift` (WS02) | WS02 | B | `MantaNavigator.switchMode(windowKey: String, sessionID: String, to: SessionMode)`, `static MantaNavigator.windowKey(project: String, windowIndex: Int) -> String`, `SessionModeStore.read(sessionID:defaults:) -> SessionMode`, `SessionListStore.launchers: [AvailableLauncher]`, `.launcherCatalog: SessionLauncherCatalog`, `.refreshLaunchers() async` (WS04) | M-04-2 |
| M-04-6 | `ChatScreen.swift` (WS02) | WS02 | B | `MantaNavigator.presentSwitcher()` (WS04) | WS04 (A2) |
| ~~M-04-7~~ | — | — | — | **Superseded**: the create flow passes the draft through `ChatScreen(…, draft:)` (M-03-4). No `initialCarryOver`, no `seedAttachments`. | — |
| M-04-8 | `mobile/native/Package.swift` (WS07) | IA | A-int | WS04 manifest (§13) | WS04 (A2) |
| M-05-1 | `ChatScreen.swift` (WS02) | WS05 | C | `GitSessionHeaderRow(branch:relPath:cwd:sessionId:shipModel:readOnly:tokens:)` (WS05); `ChatSessionStore.isBackgroundJobReadOnly` (WS02); `EnvironmentValues.composerController`, `ComposerTextController.acceptsInput` (WS03); verifies M-03-7 | WS02 (B), M-03-3, M-03-7 |
| M-05-2 | `SessionListView.swift` (WS04) | WS05 | C | `InboxWorkScreen(onClose:)` (WS05); `MantaNavigator.startNewSession(_: NewSessionDraft)` (WS04) | WS04 (A2) |
| M-05-3 | `SessionListView.swift` (WS04) | WS05 | C | `ReviewScreen.forSession(_ sessionID: String)` (WS05) | WS04 (A2); after M-05-2 |
| M-05-4 | `mobile/native/Package.swift` (WS07) | IC | C-int | WS05 manifest (`GitForgeModels`, `InboxWorkModels` + `GitForgeTests`, `InboxWorkTests`; `ReviewDiff` withdrawn server-first) | WS05 (C) |
| M-06-1 | `ChatScreen.swift` (WS02) | WS02 | B | `SearchScreen.init(primarySessionId: String?, seed: String = "", search: SearchFunction? = nil)` (WS06; server-first: no `scope:` arg, `SearchScope` deleted). Call: `SearchScreen(primarySessionId: store.sessionId)` | WS06 (B, pinned) |
| M-06-2 | `SessionListView.swift` (WS04) | IB | B-int | `SearchScreen(primarySessionId:seed:search:)` — call `SearchScreen(primarySessionId: nil, seed: seed)`; `SearchCopy.isActive(_:)`, `SearchCopy.normalized(_:)` (WS06) | WS04 (A2), WS06 (B) |
| M-06-3 | `mobile/native/Package.swift` (WS07) | IB | B-int | WS06 manifest (`SearchModels.swift`, `SearchTests.swift`) | WS06 (B) |
| M-07-1 | `ChatScreen.swift` (WS02) | WS02 | B | `ArtifactsCard(sessionId:onClose:projectName:cwd:composer:onJumpToMessage:)` (WS07); `composer` (M-03-1); `MantaNavigator.open(.message(sessionID:messageID:))` (WS04/C2). No `onAttach`. | M-03-1, WS04 (A2), M-03-7 |
| M-07-2 | `ChatScreen.swift` (WS02) | WS02 | B | `WebhooksCard(sessionId:onClose:)`, `ChatOverflowSheet.onWebhooks: (() -> Void)? = nil` (WS07) | WS07 (B, pinned) |
| M-07-3 | `MantaAppRoot.swift` (WS04) | IB | B-int | `ArtifactAgentFileNotice()` (WS07) | WS07 (B) |
| M-07-4 | `mobile/native/Package.swift` (WS07) | IB | B-int | WS07 manifest: REMOVE `ArtifactDerivation.swift` + `ArtifactDerivationTests.swift` (deleted server-first); ADD `ArtifactModels`, `ArtifactPresentation`, `ArtifactAgentFileModel`, `WebhookModels` + 5 tests | WS07 (B); M-03-8 |
| M-07-pkg-1 | `package.json` + `package-lock.json` (root; unowned — wave-B owner WS07, D27) | WS07 | B | `npm install lru-cache@11.5.3` (BlueOak-1.0.0; consumed by WS07 `src/server/artifacts.mjs`, later by WS05 `src/server/forge/view.mjs`). WS07 is wave B's ONLY dependency change; any other wave-B dependency need becomes an IB row here and integration agent B runs the install after B (never a second wave-B worker editing these files). Wave C: WS05 (sole worker) runs `npm install diff@9.0.0` itself; wave D: WS11 runs `npm install async-mutex@0.5.0` itself — no rows needed (one worker per wave) | — (libraries review, `libraries.md`) |
| M-08-1 | `ChatModelCatalog.swift` (WS09) | WS09 | B | `Notification.Name.mantaProvidersChanged` (WS08, `ProviderConnectionModels.swift`); `ChatModelCatalog.reload()` (WS09) | WS08 (A2) |
| ~~M-08-2~~ | `UsageSheets.swift` (WS02) | — | — | **Declined** by WS02; no edit, no WS08 API kept. | — |
| M-08-3 | `mobile/native/Package.swift` (WS07) | IA | A-int | WS08 manifest (4 sources, 3 tests) | WS08 (A2) |
| M-09-1 | `SettingsScreen.swift` (WS10) | IB | B-int | `ModelsScreen()` (WS09) | WS10 (A1), WS09 (B) |
| M-09-2 | `SessionListView.swift` (WS04) | IB | B-int | `UsageStoppedCapsule(count: Int, action: () -> Void)`, `UsageAlertsStore.shared.presentResume()` (WS09); `SessionListStore.unarmedStoppedCount: Int` (WS04) | WS04 (A2), WS09 (B); after M-06-2 |
| M-09-3 | `MantaAppRoot.swift` (WS04) | IB | B-int | `UsageAlertsStore.shared.bind(eventStore:)`, `UsageAlertBanner(store:)`, `UsageResumeSheet(sessions: SessionListStore, usage: UsageAlertsStore)`, `UsageAlertsStore.resumeSheetPresented` (WS09) | WS04 (A2), WS09 (B); after M-07-3 |
| M-09-4 | `MantaAppRoot.swift` (WS04) | IB | B-int | `UsageAlertsStore.resetForBoxChange()`, `ChatModelCatalog.resetForBoxChange()` (WS09) — in `commitPairing` switch branch AND in the M-10-2 closure | M-09-3, M-10-2 |
| M-09-5 | `ChatScreen.swift` (WS02) | WS02 | B | `UsageAlertsStore.shared.activeSessionId: String?` (WS09) | WS09 (B, pinned) |
| M-09-6 | `AccountsScreen.swift` (WS08) | IB | B-int | `ModelsScreen()` (WS09) — accepted (optional) | WS08 (A2), WS09 (B) |
| M-09-7 | `mobile/native/Package.swift` (WS07) | IB | B-int | WS09 manifest (6 sources: `ModelsWire`, `OptimizerLogic`, `ModelsIdentifyLogic`, `UsageResumeLogic`, `UsageAlertsLogic`, `ModelsBoxBinding`; 5 tests) | WS09 (B) |
| M-09-8 | `MantaModels.swift` (WS01, built) | IB | B-int | `struct UsageWindow` gains `var tone: String? = nil` (decode-if-present; box `tone`, WS09 SF-M18) | WS09 (B) |
| M-09-9 | `ComposerView.swift` (WS03), `AccountsScreen.swift` (WS08) → IB B-int; `UsageSheets.swift` usage-sheet rows (WS02) → WS02 B | IB / WS02 | B-int / B | `UsageMeters.band(_ window: UsageWindow) -> MeterBand?` (WS09; nil = neutral `tx4`). Change: `UsageMeters.band(window.pct)` → `UsageMeters.band(window)` at `ComposerView.swift:616`, `AccountsScreen.swift:716`, `UsageSheets.swift:513`; the context meter (`ChatScreen.swift:1143`) keeps `band(_ pct:)` until WS11 D2 | M-09-8; ComposerView after M-03-6/M-03-9; AccountsScreen after M-09-6 |
| M-10-1 | `MantaAppRoot.swift` (WS04) | WS04 | A2 | `SettingsAppearance.storageKey`, `.systemValue`, `static func preference(for stored: String?) -> ThemePreference` (`SettingsAppearance.swift`), `ThemePreference.colorScheme: ColorScheme?` (`SettingsAppearanceView.swift`) (WS10). Call: `.preferredColorScheme(SettingsAppearance.preference(for: themePref).colorScheme)` | WS10 (A1) |
| M-10-2 | `MantaAppRoot.swift` (WS04) | WS04 | A2 | `Notification.Name.mantaBoxRemoved` (WS10, `BoxDevicesModels.swift`); `MantaOnboardingFlow.backToEntry()` (WS10); `SessionListStore.resetForBoxChange()` (WS04) | WS10 (A1); after M-10-1 |
| M-10-3 | `mobile/native/Package.swift` (WS07) | IA | A-int | WS10 [pkg] manifest | WS10 (A1) |
| O-final | `MantaUI.xcodeproj/project.pbxproj` | orchestrator | final | xcodegen from `project.yml` (no worker edits it; WS11 D11 removes the fixture resource from `project.yml`) | D complete (WS11) |

Same-file / same-sub-wave audit: A1 — WS03 alone edits `ChatScreen.swift`;
A2 — WS04 alone edits `MantaAppRoot.swift`/`SessionListView.swift`; B — WS02
alone edits `ChatScreen.swift`/`ChatSessionStore.swift`/`UsageSheets.swift`/
`BackgroundJobsSheet.swift`, WS07 alone edits
`ChatOverflowSheet.swift`, WS09 alone edits `ChatModelCatalog.swift`/
`ChatModelStore.swift`; every other cross-owner edit is in a single-threaded
integration step (A-int/B-int/C-int) or in wave C (WS05 alone).

### Server registration mounts (D24 — ordered; integration agent B in wave B)

`src/server/rpc.mjs`, `index.mjs`, `streamInterp.mjs` are edited ONLY by
integration agent B in wave B, in exactly this order (02 → 07 → 09 → 06), then
`npm run test:server`; by WS05 itself in wave C; by WS11 itself in wave D.
Exact text of each row lives in the owning spec's mount table.

| # | ID | File (anchor) | Change | Owner spec |
|---|---|---|---|---|
| 1 | M-02-srv-1 | `rpc.mjs` `"server:version"` (:2584) | add `capabilities: [...BOX_CAPABILITIES]` + import | 02 |
| 2 | M-02-srv-10 | `index.mjs` (after `delegateEngine`, :1105; `buildHandlers` call) | build `delegateView`, pass into `buildHandlers` | 02 |
| 3 | M-02-srv-6 | `rpc.mjs` delegate channels (:2434–2480) | NEW `delegate:job-for-session`; decorate `delegate:list`; `delegate:approve` rule check | 02 |
| 4 | M-02-srv-7 | `rpc.mjs` `opencode:prompt` / `inbox-cancel` / `inbox-set-delivery` / `compact-session` / `run-command` | `await delegateView?.assertWritable(…)` first | 02 |
| 5 | M-02-srv-8 | `rpc.mjs` `handleRpcRequest` catch (:2705) | generic `rpcStatus` branch | 02 |
| 6 | M-02-srv-9 | `rpc.mjs` inbox handlers (:1388–1419) | wrap with `describeInboxCancel` / `describeInboxSetDelivery` | 02 |
| 7 | M-02-srv-2 | `streamInterp.mjs` `session.retry.scheduled` (:771) | `retry` + `headline/caption/body` | 02 |
| 8 | M-02-srv-3 | `streamInterp.mjs` compaction cases (:973) | `compaction` ended + `firstLine` | 02 |
| 9 | M-02-srv-5 | `streamInterp.mjs` `session.execution.failed` (:742) | `sessionError.display` | 02 |
| 10 | M-02-srv-4 | `index.mjs` `optimizer.compacted` (:1925) | `text` | 02 |
| 11 | M-07-S1 | `rpc.mjs` (next to `"outbox:list"`, :2537) | `createArtifactsService` + NEW `artifacts:list` | 07 |
| 12 | M-07-S2 | `boxCapabilities.mjs` (+ test) | append `artifacts-list-1` | 07 |
| 13 | M-09-srv-1 | `rpc.mjs` | NEW `models:table`, `models:picker`, `models:set-default`, `models:set-main`, `models:set-sub`, `models:retry-sub-sync`, `models:opt-in`, `models:set-override`, `models:unidentified`, `models:declare`, `models:set-price`, `usage-stopped:view`, `usage-stopped:apply`, `usage:alerts`, `usage:remind-at-reset`; wrap `ledger:summary` (:2024), `optimizer:summary` (:2030), `optimizer:series` (:2037), `optimizer:prices` (:2045) | 09 |
| 14 | M-09-srv-2 | `boxCapabilities.mjs` (+ test) | append the nine WS09 ids | 09 |
| 15 | M-06-srv-1 | `rpc.mjs` `"opencode:search-messages"` (:2017) + import (:58) | pass `listProjects: projectsFromSyncState(syncState)` | 06 |
| 16 | M-06-srv-2 | `boxCapabilities.mjs` (+ test) | append `search-scope-all-1` | 06 |
| C1 | M-05-srv-1 | `rpc.mjs` `"forge:inbox"` (:990) | `forgeInbox({ probeRepos })` (WS05 itself, wave C) | 05 |
| C2 | M-05-srv-2 | `boxCapabilities.mjs` (+ test) | append the four WS05 ids (WS05 itself, wave C) | 05 |

**Collision check (grep of `rpc.mjs` / `index.mjs` / `src/server/*.mjs` at
`cc54b741`, re-run at reconciliation):** none of the new channel names exists
today — `delegate:job-for-session`, `artifacts:list`, every `models:*` above,
`usage-stopped:view` / `usage-stopped:apply` (existing: `list`, `arm`, `disarm`,
`stamp-last-looked`, `mark-ran`), `usage:alerts`, `usage:remind-at-reset`, and
WS11's `opencode:cache`, `launchers:set-flag` (existing: `launchers:list`),
`accounts:row-states`, `sessions:propose-name`, `sessions:close-preview`,
`sessions:close`, `sessions:window-status`. No two specs register the same
channel. Raw bus kinds `models.updated`, `usage.alert` (WS09) and stream subs
`toolRuns`, `windowStatus` (WS11) are new; no existing `kind`/`sub` uses them.
Additive fields per existing channel/frame have a single owner: `retry`,
`compaction`, `sessionError`, `optimizer.compacted`, `delegate:list`,
`delegate:approve`, inbox results, `server:version` → 02; `ledger:summary`,
`optimizer:*`, `usage:list` windows (`tone`, via `usage.mjs`) → 09;
`opencode:search-messages` → 06; `forge:pull-request` / `diff` / `merge` /
`ship*` / `draft-*` / `thread-reply` / `inbox` → 05 (WS11 later adds disjoint
fields to `forge:probe`, `forge:clone-*`, `forge:repos`, `forge:status`);
`cache`, `context`, `questions`, `opencode:messages` / `message`, `tmux:list`,
`accounts:*`, `/auth/devices`, `/api/upgrade`, `launchers:list`,
`server:update-check`, `routing:choose` → 11.

### Wave-B shared desktop / server file ownership (D27)

| File | Wave-B owner (edits directly) | Other wave-B workers → IB ledger rows (order 07 → 09 → 06) |
|---|---|---|
| `src/renderer/chatUtils.ts` + `chatUtils.test.ts` | WS02 | M-07-D1 (WS07), M-09-dsk-4 (WS09) |
| `src/renderer/ChatPanel.tsx` | WS02 | M-09-dsk-5, ChatPanel part (WS09) |
| `src/shared/types.ts` | WS02 | M-07-D2, M-09-dsk-1, M-06-dsk-1 |
| `src/shared/api.ts` | WS02 | M-07-D3, M-09-dsk-1, M-06-dsk-2 |
| `src/renderer/api/httpApi.ts` | WS02 | M-07-D4, M-09-dsk-2 |
| `src/renderer/api/demoApi.ts`, `demoCoverage.test.ts` | WS02 | M-07-D5, M-09-dsk-2 |
| `src/shared/formatTokens.mjs` (+ `.d.mts`, test) — NEW | WS02 (D26) | — (WS09 consumes) |
| `src/shared/streamInterpretation.mjs` (+ `.d.mts`, test), `hooks/useSseBus.ts`, `hooks/useBoxCapabilities.ts` (NEW), `Cards.tsx`, `PanelCards.tsx`, `inboxState.ts`, `SessionHeader.tsx` | WS02 | — |
| `src/renderer/App.tsx`, `src/renderer/store.ts` | WS09 (M-09-dsk-3, store half of M-09-dsk-5 applied by WS09 itself) | — |
| `ModelsCard.tsx`, `ModelPicker.tsx`, `modelsPicker.ts` (NEW), `ModelLedgerCard.tsx`, `OptimizerCard.tsx`, `ModelsWeCouldntIdentify.tsx`, `ModelPriceForm.tsx`, `UsageResumeModal.tsx`, `usageResume.ts`, `usageEscalation.ts` (delete), `usageAlertsQueue.ts` (NEW), `UsageDial.tsx`, `routingCatalog.ts` (not edited in B — matcher kept for Accounts), `AccountsCard.tsx`, `src/shared/autoEligibility.mjs` | WS09 | — |
| `artifacts.ts`, `ArtifactsPanel.tsx`, `MediaBody.tsx`, `ArtifactPreview.tsx`, `src/shared/artifactsTypes.ts` (NEW), `api/demoArtifacts.ts` (NEW) | WS07 | — |
| `SearchPalette.tsx` (+ NEW test), `PaletteShell.tsx` (+ test) | WS06 | — |
| `src/server/boxCapabilities.mjs` (+ test) — NEW | WS02 | M-07-S2, M-09-srv-2, M-06-srv-2 |
| `src/server/version.mjs` (+ test) | WS02 | — |
| `src/server/delegateView.mjs`, `inboxCopy.mjs` (NEW) | WS02 | — |
| `src/server/artifacts.mjs` (NEW) | WS07 | — |
| `src/server/media.mjs` + `media.test.mjs` (export the one extension → MIME allowlist + `mimeForName`, libraries review) | WS07 | — |
| `package.json` + `package-lock.json` (root) | WS07 (`lru-cache@11.5.3`, M-07-pkg-1) | — (no other wave-B worker adds a dependency; a future need → IB row, installed by integration agent B) |
| `src/server/usage.mjs`, `providers.mjs` (+ test; additive `syncSubagentsDetailed` / `setModelCostDetailed`), `modelsTable.mjs`, `modelsUnidentified.mjs`, `ledgerView.mjs`, `optimizer/view.mjs`, `modelsPricing.mjs`, `usageResumeView.mjs`, `usageAlerts.mjs`, `usageWindowView.mjs`, `rpc.models.test.mjs` (NEW) | WS09 | — |
| `src/server/messageSearch.mjs` | WS06 | — |
| `src/server/rpc.mjs`, `index.mjs`, `streamInterp.mjs` | IB only (table above) | — |

Wave C: WS05 alone edits `SessionHeader.tsx`, `ChatPanel.tsx`, `chatUtils.ts`,
`ReviewPane.tsx`, `ToolBodies.tsx`, `InboxPalette.tsx`, `src/shared/types.ts`,
`forge/*.mjs`, `rpc.mjs`, `boxCapabilities.mjs`, and `package.json` /
`package-lock.json` (`diff@9.0.0`). Wave D: WS11 alone (incl. `package.json`
for `async-mutex@0.5.0`).

### Capability id registry (D25)

All ids live in `src/server/boxCapabilities.mjs` `BOX_CAPABILITIES`; format
`/^[a-z0-9-]+-\d+$/`.

| Id | Owner | Covers | Added (wave, by) | Client detection |
|---|---|---|---|---|
| `chat-cards-1` | WS02 | retry/compaction/send-error copy, job view + refusal, inbox outcome copy | B, WS02 (creates the file) | `boxCapabilities()` / `useBoxCapability` |
| `artifacts-list-1` | WS07 | `artifacts:list` | B, IB M-07-S2 | `unknown rpc channel: artifacts:list` |
| `models-table-1` | WS09 | SF-M1 | B, IB M-09-srv-2 | unknown channel |
| `models-picker-1` | WS09 | SF-M2 | B, IB M-09-srv-2 | unknown channel |
| `models-unidentified-1` | WS09 | SF-M9/M10/M11 | B, IB M-09-srv-2 | unknown channel |
| `models-price-form-1` | WS09 | SF-M13 | B, IB M-09-srv-2 | unknown channel / no `unpricedByProvider` |
| `ledger-view-1` | WS09 | SF-M6 | B, IB M-09-srv-2 | no `view` |
| `optimizer-view-1` | WS09 | SF-M7 | B, IB M-09-srv-2 | no `view` |
| `usage-resume-view-1` | WS09 | SF-M14/M15 | B, IB M-09-srv-2 | unknown channel |
| `usage-alerts-1` | WS09 | SF-M16/M17 | B, IB M-09-srv-2 | unknown channel |
| `usage-window-tone-1` | WS09 | SF-M18 | B, IB M-09-srv-2 | no `tone` |
| `search-scope-all-1` | WS06 | Q1–Q3 | B, IB M-06-srv-2 | no `groups` |
| `forge-pr-view-1` | WS05 | G1/G2/G5/G6/G7 | C, WS05 M-05-srv-2 | accessor; no `view` |
| `forge-diff-view-1` | WS05 | G10 | C, WS05 | accessor; no `files` |
| `forge-inbox-view-1` | WS05 | G13 | C, WS05 | accessor; no `label` |
| `forge-messages-1` | WS05 | G3/G4/G11 | C, WS05 | accessor; no `message` |
| `cache-stale-at-1`, `context-selected-model-1` | WS11 | D2 | D, WS11 | `BoxCapabilitiesStore` |
| `devices-view-1`, `forge-status-secondary-1`, `update-targets-view-1`, `upgrade-view-1`, `launchers-flags-1` | WS11 | D3 | D, WS11 | `BoxCapabilitiesStore` |
| `accounts-copy-1` | WS11 | D4 | D, WS11 | `BoxCapabilitiesStore` |
| `sessions-naming-1`, `forge-clone-view-1` | WS11 | D5 | D, WS11 | `BoxCapabilitiesStore` |
| `sessions-close-1` | WS11 | D6 | D, WS11 | `BoxCapabilitiesStore` |
| `sessions-window-status-1` | WS11 | D7 | D, WS11 | `BoxCapabilitiesStore` |
| `transcript-view-1` | WS11 | D8/D9 | D, WS11 | `BoxCapabilitiesStore` |
| `questions-plan-1` | WS11 | D10 | D, WS11 | `BoxCapabilitiesStore` |
| `transcript-runs-1` | WS11 | D11 | D, WS11 | `BoxCapabilitiesStore` |

## Shared member registry

Single owner per member/type (D16 is member-level). No other spec may declare
these; consumers call them by exactly these names.

**`MantaAPIClient` extension members** (file `MantaAPIClient+<Area>.swift` of
the owner):

| Owner (file) | Members |
|---|---|
| WS01 (`+Transcript`) | `peekFileSize(path:) async throws -> Int64?`, `downloadPeekFile(path:to:maxBytes:) async throws`, internal `static peekRequest(url:method:token:) -> URLRequest` |
| WS02 (`+ChatCards`) | `delegatePendingApprovals(sessionId:) -> [ChatCardApproval]`, `delegateApprove(id:tools:) -> ChatCardApproveResult`, `delegateDecline(id:) -> Bool`, `delegateJobForSession(sessionId:) -> ChatCardJobForSession` (replaces the withdrawn `chatCardJobs()`), `inboxCancelReported(sessionId:id:restore:) -> InboxCancelResult`, `boxCapabilities() -> Set<String>` (THE iOS capability accessor in waves B/C, D25; deleted by WS11 D1). WS11 adds `opencodeCache(sessionId:)` here in wave D |
| WS03 (`+Composer`) | `commands(directory:) -> [OpencodeCommandInfo]`, `references() -> [OpencodeReferenceInfo]` (consumed by WS10), `runCommand(_:) -> RunCommandResult?` |
| WS04 (`+Sessions`) | (wave D, WS11: `sessionsProposeName(_:) -> SessionNameProposal`, `sessionsClosePreview(_:)`, `sessionsClose(_:)`, `sessionsWindowStatus()`) · `createSession(_:)`, `createWindow(_:)`, `tmuxRenameSession(oldName:newName:)`, `tmuxKillSession(_:)`, `projectMetaDelete(_:)`, `gitAddWorktree(cwd:name:)`, `gitRemoveWorktree(path:force:)`, `fsListDirectory(_:)`, `projectCreateScratch(root:name:)`, `forgeProbe() -> ForgeProbeResult` (consumed by WS05), `forgeDeviceStart()`, `forgeDevicePoll(grantId:)`, `forgeDeviceCancel(grantId:) async throws`, `forgeRepos()`, `forgeCloneStart(url:dest:name:)`, `forgeCloneStatus(id:)`, `forgeCloneCancel(id:)`, `usageStoppedList() -> SessionStoppedList` (row markers + M-09-2 count; D29) |
| WS05 (`+Git`) | `forgePullRequest(cwd:)`, `forgeShipPreview(cwd:model:sessionId:)`, `forgeShip(cwd:title:body:)`, `forgeMerge(cwd:number:sha:)`, `forgeDiff(_:)` (also returns the placed draft), `forgeDraftComment(_:op:)`, `forgeDraftSubmit(_:verdict:)`, `forgeThreadReply(_:threadId:body:)`, `forgeInbox()`, `delegateStart(prompt:sessionID:directory:)`. (`forgeDraftGet` withdrawn server-first; WS05 no longer calls `forgeProbe()`.) |
| WS06 (`+Search`) | `searchMessages(_: SearchRequest) -> SearchResponse` |
| WS07 (`+Artifacts`) | `artifactsList(sessionId:) -> ArtifactsListResult` (`artifacts:list`), `listWebhooks(sessionId:)`, `deleteWebhook(id:)`. (`listOutboxRows` withdrawn — the box reads the outbox.) |
| WS08 (`+Accounts`) | (wave D, WS11: `accountsRowStates()`) · `accountsResignSeat`, `accountsResignStatus`, `accountsResignCancel`, `accountsHealth`, `accountsRetry`, `accountsEndpointProbe`, `providerAuthStatus`, `providerAuthStart`, `providerAuthCode`, `providerAuthKey`, `providerAuthDisconnect`, `providerAuthClaudeStatus`, `providerAuthOauthStatus`, `providerAuthOauthCancel`, `providerClaudeCliStatus`, `providerClaudeLoginCancel`, `signInPtySpawn`, `signInPtyWrite`, `signInPtyKill`, `providerEndpoints`, `providerSetEndpoints`, `providerDiscoverModels` (signatures in WS08 "Client members") |
| WS09 (`+Models`) | `modelsTable()`, `modelsSetDefault(key:)`, `modelsSetMain(key:on:)`, `modelsSetSub(key:on:)`, `modelsRetrySubSync()`, `modelsOptIn(keys:)`, `modelsSetOverride(key:name:description:context:)`, `modelsPicker()`, `ledgerSummary()`, `optimizerSummary()`, `optimizerSeries(range:)`, `optimizerPrices()`, `modelsSetPrice(providerID:modelID:input:output:cacheRead:cacheWrite:)`, `modelCatalog()`, `modelsUnidentified()`, `modelsDeclare(key:catalogId:)`, `modelsDeclare(key:form:)`, `usageStoppedView()` (resume screen only, D29), `usageStoppedApply(selected:dryRun:)`, `usageStoppedStampLastLooked()`, `usageAlerts()`, `usageRemindAtReset(key:sessionID:)`. (Withdrawn server-first: `modelsSyncSubagents`, `setModelCost`, `usageStoppedArm/Disarm`, `scheduleCreate`.) |
| WS10 (`+Settings`) | (wave D, WS11: `launchersSetFlag(id:key:value:)`; `ServerVersionInfo.capabilities`) · `serverVersion()` (no capabilities in B/C — D25), `serverUpdateCheck()`, `serverCliUpdate(cliID:)`, `restorePreview()`, `restoreTopology()`, `authPair()`, `opencodeRestart() -> OkResult` (consumed by WS08), `pluginsRegistry()`, `forgeStatus(validate: Bool) -> ForgeConnectionStatus` (consumed by WS05), `forgeRulesList()`, `forgeDisconnect()`, `opencodeSetReferences(upsert:)`, `launchersList() -> [AvailableLauncher]` (consumed by WS04) |

Existing base members (`MantaAPIClient.swift`) are reused, never redeclared.
WS11 (wave D, alone) adds `view: Bool = false` to the base
`messages(sessionId:limit:slim:view:)` — the only base-file edit of the effort.

**Desktop `window.api` members added (single owner each):** WS02
`delegateJobForSession`, `opencodeInboxCancel` input `restore?`,
`getServerVersion` type `capabilities?`; WS07 `artifactsList`; WS09
`modelsTable`, `modelsPicker`, `modelsSetDefault`, `modelsSetMain`,
`modelsSetSub`, `modelsRetrySubSync`, `modelsOptIn`, `modelsSetOverride`,
`modelsUnidentified`, `modelsDeclare`, `modelsSetPrice`, `usageStoppedView`,
`usageStoppedApply`, `usageAlerts`, `usageRemindAtReset`, `onModelsUpdated`,
`onUsageAlert`; WS06 `opencodeSearchMessages` (types only); WS05 none (fields
only); WS11 one member per new channel (`opencode:cache`, `launchers:set-flag`,
`accounts:row-states`, `sessions:*`). Desktop hooks: `useBoxCapability` (WS02,
kept by WS11), `useModelsPicker` (WS09).

**Cross-workstream types / properties:**

| Owner | Symbols |
|---|---|
| WS01 | `TranscriptMapOptions`, `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:options:)` / `.liveMediaTail(messages:live:isLiveWindow:)` / `.footerTruncationMessageIDs(_:)`, `OpencodeCommandOrigin`, `TranscriptCommandOrigin.fromLive(name:arguments:)`, `TranscriptLiveTruncation.from(kind:messageID:)`, `TranscriptMediaStore.shared` (`$sessions`, `entries(for:)`), `TranscriptDisplayOptions` (`showDetails`, `defaultsKey`, `setShowDetails(_:)`, `didChange`) |
| WS02 | `ChatSessionStore.commandByMessageID: [String: StreamCommandExecutedPayload]`, `.truncation` (existing), `.presentedMessages`, `.mutationPolicy: ChatCardMutationPolicy` (`.resolving`, `.allowed`, `.readOnlyJob`), `.isBackgroundJobReadOnly: Bool`, `.canMutate`; `StreamCommandExecutedPayload {messageID, name, arguments: String}`; `EnvironmentValues.transcriptHighlightedRowID`; `ChatCardJobOwnershipStore` (`jobOwnership`, `job: ChatCardJobView?` — WS02-internal); `ChatCardCapabilities` (WS02-internal until WS11 D1); `DelegateJob.statusLabel` / `.summary` (added to WS04's file by M-02-4); server `BOX_CAPABILITIES`, `createDelegateView`, `describeRetry`, `describeSessionError`, `describeBackgroundCompaction`, `compactionFirstLine`; shared `formatTokenCount` / `formatTokens` (`src/shared/formatTokens.mjs`, D26) |
| WS03 | `ComposerTextController` (`text`, `attachments`, `acceptsInput`, `focusRequest`, `seedNotice`, `init(text:attachments:draft:)`, `insert(text:mode:) -> Bool`, `attach(remotePath:displayName:mime:) -> Bool`, `lastAttachRejection`, `newSessionDraft(cwd:)`, `apply(_:) -> Int`, `consumeSeedNotice()`), `ComposerInsertMode`, `ComposerInsertion` (`AttachRejection`), `EnvironmentValues.composerController`, `ChatScreen(…, draft:)`, `ComposerTypeahead.agentRows(agents:loadError:query:limit:)`, `OpencodeReferenceInfo`, `OpencodeCommandInfo` |
| WS04 | `MantaRoute`, `MantaNavigator` (`pending`, `open(_:)`, `pendingDraft`, `startNewSession(_:)`, `switcherPresented`, `presentSwitcher()`, `switchMode(windowKey:sessionID:to:)`, `static windowKey(project:windowIndex:)`), `NewSessionDraft` / `NewSessionDraftAttachment` (D2), `SessionMode`, `SessionLauncherCatalog`, `SessionModeStore`, `SessionModeRows`, `SessionRenameSheet`, `SessionListStore` (`window(forSessionID:)`, `renameSession(project:index:newName:)`, `launchers`, `launcherCatalog`, `refreshLaunchers()`, `stoppedRecords: [SessionStoppedRecord]`, `stoppedLastLooked: Double?` (epoch ms), `stoppedConversations`, `unarmedStoppedCount`, `isStopped(sessionID:)`, `refreshStopped()`, `resetForBoxChange()`), `SessionStoppedRecord {…, stoppedAt: Double}`, `SessionStoppedList`, `GitHubDeviceSignInStore` (`cancel() async`, attempt `generation`), `GitHubDeviceSignInView(onConnected:onCancel:)`, `GitHubDeviceSignInAPI`, `GitHubDeviceFlow`, `GitHubDevice*` wire types, `ForgeProbeResult`, `RepoHit` |
| WS05 | `GitSessionHeaderRow`, `InboxWorkScreen(onClose:)`, `ReviewScreen.forSession(_:)`; server `src/server/forge/view.mjs`, `forge/diffView.mjs` |
| WS06 | `SearchScreen(primarySessionId:seed:search:)`, `SearchCopy.isActive/normalized`; server `resolveSearchScope`, `groupHits` (`messageSearch.mjs`). (`SearchScope.*` deleted server-first.) |
| WS07 | server `createArtifactsService`, `planRefsFromPart` (`src/server/artifacts.mjs` — consumed by WS11 D10); `ArtifactsListResult`; `ArtifactsCard(sessionId:onClose:projectName:cwd:composer:onJumpToMessage:)`, `WebhooksCard(sessionId:onClose:)`, `ArtifactAgentFileNotice()`, all `ChatOverflowSheet` parameters (`isReadOnlyJob`, `onRename`, `mode`, `launchers`, `launcherCatalog`, `onSelectMode`, `onRetryLaunchers`, `onWebhooks`), `Package.swift` (written only by IA/IB/IC) |
| WS08 | `Notification.Name.mantaProvidersChanged`, `AccountsScreen(store:focusProvider:ownsLifecycle:)` (unchanged), `AccountsStore.conversationSeat` (unchanged, read by WS02), `EndpointHealth` |
| WS09 | `ChatModelStore.agentsLoadError`, `.retryAgents()`, `ChatModelCatalog.reload()` / `.resetForBoxChange()`, `UsageAlertsStore.shared` (`bind(eventStore:)`, `activeSessionId`, `resumeSheetPresented`, `presentResume()`, `resetForBoxChange()`), `UsageAlertBanner(store:)`, `UsageResumeSheet(sessions:usage:)`, `UsageStoppedCapsule(count:action:)`, `ModelsScreen()`, `UsageMeters.band(_ window: UsageWindow) -> MeterBand?`, `UsageWindow.tone` (added to WS01's file by M-09-8). (`UsageStoppedEntry` withdrawn server-first.) |
| WS10 | `AvailableLauncher {id, label, flags}`, `AvailableLauncherFlag {key, label, type, default}`, `ExtensionsLaunchers.resolve(schema:saved:)` / `.update(…)` / `.savedFlags(from:)`, `SettingsAppearance` (`storageKey`, `systemValue`, `preference(for:)`), `ThemePreference.colorScheme`, `Notification.Name.mantaBoxRemoved`, `SettingsScreen(eventStore:initialSection:)`, `OkResult`, `ForgeConnectionStatus`, `BoxRESTClient` |
| WS11 | `BoxCapability`, `BoxCapabilities`, `BoxCapabilitiesStore`, `UpdateBoxNote` (iOS + desktop), `TranscriptViewModels` types (`TranscriptMessageView`, `TranscriptPartView`, `TranscriptRunView`, …), server modules listed in WS11 Files |

## Definition of done (whole effort)

- Every gap in the table above is either built per its spec or explicitly
  recorded in that spec as "deferred — reason" and accepted in review.
- `npm run typecheck` and `npm test` green.
- iOS: `ios-mantaui` plugin `action: test-unit` on the branch green (app +
  both test bundles compile, `MantaUITests` pass). `.pbxproj` regenerated.
- Opus review rounds report nothing blocking.
- Squash-merged to `main` via PR.

## Reconciliation log (after round 2)

Canonical decisions taken here (binding, recorded in the ledger/registry above):
- **Live truncation:** WS02 publishes no per-message truncation map; WS01
  consumes the existing single `truncation` via
  `TranscriptLiveTruncation.from(kind:messageID:)` (D15 unchanged).
- **Read-only job API:** provider WS02. Consumers read
  `ChatSessionStore.isBackgroundJobReadOnly` (yes/no) and, only where
  "still checking" matters, `ChatSessionStore.mutationPolicy`
  (`.resolving/.allowed/.readOnlyJob`). `jobOwnership.job` is WS02-internal.
  M-03-7 = `composer.acceptsInput = !store.isBackgroundJobReadOnly` on appear
  and on change.
- **New-session draft:** only `ChatScreen(…, draft:)` (M-03-4). M-04-7 /
  `initialCarryOver` / `seedAttachments` superseded.
- **Stopped timestamps:** `stoppedLastLooked: Double?` and
  `SessionStoppedRecord.stoppedAt: Double`, both epoch ms; no conversion.
- **Device sign-in lifecycle:** WS05 §C.3 is specified inside WS04's API
  (`cancel() async`, attempt `generation`, wake channel, logged cancel failure,
  five lifecycle tests).
- **Package manifests** all have IDs (M-04-8, M-08-3, M-09-7 added).

Edits:
- `00-master.md` → added "Mount ledger (canonical)", "Shared member registry",
  this log; D20 wording (WS04 applies WS10's `MantaAppRoot` mounts M-10-1/2).
- `01-transcript.md` → mount-table header points to the canonical ledger;
  M-01-5 note and superseded-ID note updated (WS07/WS02 receipts now match).
- `02-chat-cards-queue.md` → F6: added `isBackgroundJobReadOnly`, canonical
  read-only API note, resolver wording, `jobOwnership` internal, M-03-7 keyed
  on `isBackgroundJobReadOnly`, acceptance; F11: dropped
  `truncationByMessageID` (table, router state, decision paragraph, conversion
  → `liveTruncation`); Files/Tests #14/#16/#18 aligned; M-02-2 also hides
  Rename + Mode rows; "Mounts applied" rewritten (M-01-1…4 verbatim from WS01
  incl. `presentedMessages` + `isLiveWindow:` + `footerTruncationIDs`; M-03-7;
  M-04-7 removed → superseded list; M-03-9 noted); Contracts (C5, provided
  read-only API, consumed WS01 symbols); four round-2 response rows amended.
- `03-composer.md` → M-03-7 uses `isBackgroundJobReadOnly`; M-03-9 provider
  symbol pinned; header → canonical ledger; consumed-from-WS02 list; seed call
  spelled `ChatScreen(…, seed: target.seed ?? "", draft: target.draft)`;
  cross-check paragraph; round-2 response wording.
- `04-sessions.md` → §6 `GitHubDeviceSignInStore` API (`cancel() async`,
  `generation`, wake channel), API seam logging, polling paragraph, five WS05
  lifecycle tests; `forgeDeviceCancel` `async throws` (awaited, logged);
  M-04-2 gated on `!isReadOnlyJob`; §14 header; §15 M-09-2 / M-09-4 receipts
  copied from WS09; §13 Files and §11 stale "M1/M2/M3" labels fixed; WS05
  `repoProbe` note removed; reconciliation note appended.
- `05-git-pr-review.md` → A.3a + M-05-1 read-only source =
  `isBackgroundJobReadOnly` (no `jobOwnership`); M-05-1(b) verifies the
  canonical M-03-7 binding; M-05-2 provider symbols + A2 prerequisites;
  M-05-4 applier = IC; §9 cross-refs; C.3 note (WS04 now specifies it);
  round-2 responses amended.
- `06-search.md` → stale "WS04 M2"/"WS02 M2" refs → WS04 §11 / WS02 F10;
  WS02 receipt notes resolved; M-06-2 ordered before M-09-2.
- `07-artifacts-cards.md` → header → canonical ledger; "receiver-side sync"
  note replaced (WS02 matches); Package request list completed.
- `08-accounts.md` → header; M-08-1 receipt recorded by WS09; M-08-3 ID;
  M-09-6 note.
- `09-models-usage.md` → `stoppedLastLooked: Double?` / `stoppedAt: Double`
  everywhere, `lastLookedMs` removed, tests reworded to ms; manifest row is
  M-09-7; M-09-5/M-09-6/M-09-1/M-09-2/M-09-4 cross-refs updated;
  cross-spec dependencies; round-2 response #2.
- `10-settings-box.md` → header → canonical ledger; M-09-1 ref; WS04 C2 note.

Verified by grep: every provider symbol in the ledger appears with the same
spelling in its provider spec; no `MantaAPIClient` member or top-level type is
declared by two specs (`Kind`/`Phase` are nested; `GitHubDeviceSignIn*` in
WS05 is a quoted consumed signature); no two workers edit one file in one
sub-wave.

## Reconciliation log (server-first)

Run after the server-first revision of 02/05/06/07/09 and the first draft of
11. Binding decisions taken: **D25–D30** (above). Tables added/updated above:
"Server registration mounts", "Wave-B shared desktop / server file ownership",
"Capability id registry", the Mount ledger and the Shared member registry.

Drifts resolved:
1. **Three capability modules → one.** WS02's `src/server/boxCapabilities.mjs`
   (wave B) is canonical; WS05's conditional `serverCapabilities.mjs` and
   WS11's `boxFeatures.mjs` are withdrawn. Ids were renamed to one format
   (`forge.prView` → `forge-pr-view-1`, `search.scope-all` →
   `search-scope-all-1`, `artifacts.list` → `artifacts-list-1`, `models.table`
   → `models-table-1`, …). Wave-B ids are appended by IB (new rows M-07-S2
   retargeted, M-09-srv-2, M-06-srv-2), wave-C ids by WS05 (M-05-srv-2
   retargeted, no `index.mjs`/`rpc.mjs` edit), wave-D ids by WS11. Client
   accessors: iOS `boxCapabilities()`, desktop `useBoxCapability` (WS02);
   WS11 D1 unifies iOS into `BoxCapabilitiesStore` and deletes the B-wave
   accessor; WS10's `serverVersion()` grows nothing until then.
2. **Search mount signature.** M-06-1 / M-06-2 now call
   `SearchScreen(primarySessionId:seed:search:)` (no `scope:`); WS02 receipt,
   ledger and registry updated; `SearchScope.*` removed from the registry.
3. **Job-list labels.** M-02-4 (`SessionModels.swift`, built WS04 file) is an
   IB row; `BackgroundJobsSheet.swift` is assigned to WS02 (D28) so M-02-5 is
   WS02's own wave-B edit. WS11 D7 does not touch either (checked).
4. **Member registry.** WS02 row rewritten (`delegateJobForSession`,
   `ChatCardApproveResult`, `inboxCancelReported`, `boxCapabilities`); WS05
   loses `forgeDraftGet`; WS07 `artifactsList` replaces `listOutboxRows`;
   WS09 row replaced by its server-first set; WS11 members recorded under the
   area files they extend; desktop `window.api` members listed once each.
   Stopped state: WS04's built API stays for row markers, WS09's
   `usage-stopped:view` only for the resume screen (D29).
5. **Server registration order.** One ordered table (02 → 07 → 09 → 06, then
   wave C WS05) with every `*-srv-*` / `M-07-S*` row; every new channel and
   frame kind grepped against `rpc.mjs` / `src/server/*.mjs`: no collision,
   no channel or field registered by two specs.
6. **Shared desktop files.** WS02 owns `chatUtils.ts`, `ChatPanel.tsx`,
   `types.ts`, `api.ts`, `httpApi.ts`, `demoApi.ts`, `demoCoverage.test.ts` in
   wave B; WS07/WS09/WS06 hunks are IB rows (M-07-D1…D5, M-09-dsk-1/2/4/5,
   new M-06-dsk-1/2). WS09 owns `App.tsx` and `store.ts` (sole editor). Token
   formatter: ONE module `src/shared/formatTokens.mjs` created by WS02 (D26);
   WS09's planned creation became consumption. Found and fixed while checking:
   WS02's deletion of `formatTokensCompact` would have broken `formatLastMove`
   (`chatUtils.ts:3803`) — now switched to `formatTokenCount`; `SessionHeader.tsx`
   had a private duplicate formatter — deleted by WS02.
7. **WS11 vs built code.** WS11's iOS/desktop file lists rebuilt per sub-step
   from a grep of every caller of each deleted symbol (added e.g.
   `AccountsStore`, `ProviderConnection*`, `ProviderEndpoint*`,
   `SessionCreateSheet`, `SessionSetupStore`, `SessionForgeModels`,
   `SessionRenameSheet`, `CloneFromGitHubView`, `SessionWorktreePromptSheet`,
   `BoxDevicesScreen`, `BoxRESTClient`, `Extensions*Screen`,
   `SettingsCustomRows`, `SettingsUpdates*`, `UpgradeScreen/Store`,
   `TranscriptMediaStore`, `TranscriptTurnFooterView`, desktop `ToolCall.tsx`,
   `UpgradeGate.tsx`, `SessionHeader.tsx`, server `push.mjs`). Dependencies of
   waves B/C on logic WS11 deletes: WS02's mapper call sites (signatures kept
   or migrated in-step), WS09's capsule + desktop stopped marker (D29), WS07's
   `planRefsFromPart` (WS11 imports it from `artifacts.mjs`; WS11 no longer
   lists it as a desktop deletion — M-07-D1 already did it). A second
   server-side `isPlanExitQuestion` in `push.mjs` is folded into WS11 D10.
8. **WS11 open questions** accepted with their defaults (D30), written into
   WS11 "Decisions".

Mount-ledger rows added: **M-02-4, M-02-5, M-09-8, M-09-9**. Rows changed:
**M-06-1, M-06-2** (signature), **M-05-4, M-07-4, M-09-7** (manifest contents).
New non-Swift rows (own tables): M-02-srv-1…10, M-07-S1/S2, M-07-D1…D5,
M-09-srv-1/2, M-09-dsk-1…5, M-06-srv-1/2, M-06-dsk-1/2, M-05-srv-1/2.

Spec edits: `02` (SF-0/SF-2/desktop table/Files/members/M-02-5/receipts
M-06-1, M-09-9), `05` (ids, M-05-srv-2, S.6 accessor, Files, §12), `06`
(id, M-06-srv-2, M-06-dsk-1/2, Files), `07` (id, M-07-S2, stale
`PlanDerivation` line, `planRefsFromPart` provided to WS11), `09` (ids,
M-09-srv-2, desktop ownership, formatter consumed, M-09-7/8/9 renumbered, D29
note), `11` (D1 rewritten, D4/D7/D10 notes, wave-B call-site section, Files,
Contracts, Decisions, reconciliation notes); notes-only appendices in `01`,
`03`, `04`, `08`, `10`.

Unresolved (recommendation recorded, not blocking): see the reply to the
orchestrator — (a) wave-B workers 06/07/09 compile against WS02-owned shared
desktop files that only exist after IB; they verify with locally applied,
uncommitted rows (pattern WS07 already specified). (b) WS07's
`ArtifactsCapability.isUnsupported` and WS09's `ModelsCapability.isUnsupported`
classify the same "unknown rpc channel" prefix twice on iOS (two tiny
decode guards in two same-wave workers' own files); tolerated in wave B and
folded by WS11 D1 into one `BoxCapabilities.isUnknownChannel(_:)` (written into
WS11).
