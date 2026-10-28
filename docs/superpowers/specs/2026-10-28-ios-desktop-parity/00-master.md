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
func insert(text: String, mode: ComposerInsertMode)  // .append | .replace | .quote (prefix "> " per line + blank line)
func attach(remotePath: String, displayName: String, mime: String?) // existing chip pipeline, already-uploaded file
```

and a `NewSessionDraft { cwd, text, attachments }` value consumed by WS04's
create flow ("Quote in new session", inbox "start a session").

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
- WS09: context sheet gains a "Seat" row (WS02 owns, WS09 provides data).

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
| 02 | `ChatScreen.swift`, `ChatSessionStore.swift`, `MantaEventStore.swift`, `MantaStreamModels.swift`, `PendingPrompt.swift`, `RunningIndicator.swift`, `UsageSheets.swift` (context sheet only) | `ChatCard*` |
| 03 | `ComposerView.swift`, `ComposerTypeahead.swift`, `ComposerHistory.swift` | `Composer*` |
| 04 | `SessionListView.swift`, `SessionListStore.swift`, `SessionModels.swift`, `SessionCreateSheet.swift`, `FolderPickerView.swift`, `RootView.swift`, `MantaAppRoot.swift` | `Session*`, `MantaNavigation.swift`, `CloneFromGitHub*` |
| 05 | — (new files only + mounts) | `Git*`, `Review*`, `Inbox*` |
| 06 | — (new files only + mounts) | `Search*` |
| 07 | `SessionResourceCards.swift`, `ArtifactDerivation.swift`, `ChatOverflowSheet.swift` | `Artifact*`, `Webhook*` |
| 08 | `AccountsScreen.swift`, `AccountsStore.swift`, `AccountsModels.swift` | `Accounts*`, `Provider*` |
| 09 | `UsageMeters.swift`, `ModelPickerSheet.swift`, `ChatModelCatalog.swift` | `Models*`, `Usage*`, `Optimizer*` |
| 10 | `SettingsScreen.swift`, `MantaSettingsStore.swift`, `MantaSettingsModels.swift`, `UpgradeScreen.swift`, `UpgradeStore.swift`, `UpgradeModels.swift`, `MantaOnboarding.swift`, `MantaPairingModels.swift`, `src/shared/settingsSchema.ts`, `generated/swift/SettingsSchema.swift` | `Settings*`, `Box*`, `Extensions*` |

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

Server-file conflicts: only one workstream per wave may edit `rpc.mjs` /
`index.mjs`; if two in the same wave need it, the second serialises behind the
first within the wave.

## Definition of done (whole effort)

- Every gap in the table above is either built per its spec or explicitly
  recorded in that spec as "deferred — reason" and accepted in review.
- `npm run typecheck` and `npm test` green.
- iOS: `ios-mantaui` plugin `action: test-unit` on the branch green (app +
  both test bundles compile, `MantaUITests` pass). `.pbxproj` regenerated.
- Opus review rounds report nothing blocking.
- Squash-merged to `main` via PR.
