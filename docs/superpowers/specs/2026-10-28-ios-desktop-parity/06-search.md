# WS06 — Conversation search (iOS)

Status: revised after round 1 · Date: 2026-10-28 · Wave: B.

Scope: one feature, three parts.

1. **F1 — Search screen**: search the full history of every chat window on the
   box with one server query. Results are grouped "This conversation" vs other
   conversations, and each hit shows a snippet with the matched text
   highlighted, its role and its age.
2. **F2 — Jump to a hit**: tapping a hit closes search and opens that message,
   scrolled to and highlighted, in the same conversation or another one.
3. **F3 — Entry points**: from the chat nav bar (scoped to the open chat) and
   from the session list (no current conversation).

No server change is needed. The existing `opencode:search-messages` channel
already does everything (D7 lists no WS06 server change). **No new server
routes.**

Wave B timing (D18):
- WS06 writes only its own new files.
- WS02 (wave B) applies the chat nav-bar mount.
- Integration agent B applies the session-list mount and the `Package.swift`
  additions after the wave-B workers finish.
- Jumps call the C2 `.message` route. The route is handled by WS02 (same
  session, wave B) and by WS04's root handler (other session, wave A, WS02
  M2). Both are live by the end of wave B. Nothing in WS06 is reachable from
  the UI until its mounts are applied, so it is never usable before the route
  works.

---

## F1 — Search screen

### Desktop behaviour today

The desktop search is `src/renderer/SearchPalette.tsx` (⌘F). It opens from
`src/renderer/App.tsx:1449-1462`, only when a chat pane is active, and is
mounted at `App.tsx:2307-2314`. It is a dumb renderer of one server query.

- **Scope** (`SearchPalette.tsx:74-86`):
  - The active session id goes first.
  - Then every OTHER window, in sidebar order, that has an
    `opencodeSessionId`, de-duplicated, with no cap.
  - `flatSessions` (`src/renderer/store.ts:1774-1781`) walks every window of
    every project, job windows included.
- **Query gating**:
  - `q = query.trim()` (line 70) must be at least 2 characters
    (`MIN_QUERY_CHARS`, line 27).
  - The trimmed `q` is what is sent (line 113).
  - Debounce is 120 ms (`SEARCH_DEBOUNCE_MS`, line 28).
  - A sequence counter guards the success path, the `catch` path and the
    `finally` path (lines 100-125).
  - A query under 2 characters bumps the sequence, clears results and stops
    loading (lines 101-106).
- **Grouping** (`groupHits`, lines 39-54):
  - The server returns a flat list, ordered primary first, then in scope order.
  - Hits are grouped by `sessionId` in first-appearance order.
  - The active session's group is "This conversation"; the rest sit under an
    "other conversations" divider.
- **Section headers** (`SectionHeader`, lines 270-293):
  - "This conversation" carries the count `N match` / `N matches`.
  - Other groups show `workspace › session-name` with a bare count, falling
    back to the raw session id.
- **Hit row** (`HitRow`, lines 295-355):
  - Glyph `›` for user, `✳` for assistant.
  - `pre`, then a highlighted `match`, then `post`, clamped to 2 lines.
  - A caption: "you" / "assistant".
  - A right-aligned age via `formatAge` (`src/renderer/chatUtils.ts:542-550`),
    omitted when `timeCreated` is null.
- **Footer** (lines 170-173): `"{total} result(s) · {n} conversation(s)"` when
  there are hits.
- **Copy** (exact strings):
  - Idle: "Search this conversation — and all others. Type at least 2 characters."
  - `supported:false`: "Search needs a newer server runtime — update the server."
  - Loading: "Searching other conversations…"
  - Empty: `No matches for “{q}”`
  - Placeholder: "Search in conversations…"
  - Label: "Search conversations"
- **Transport errors** are swallowed into "no results" (lines 116-119). iOS
  shows these instead.
- **`truncated: true`** is ignored by the desktop.

### Wire contract (verified)

Channel: **`opencode:search-messages`** (`src/shared/types.ts:1554`,
`IPC.opencodeSearchMessages`).
- Desktop call: `src/renderer/api/httpApi.ts:1439`.
- Server: `src/server/rpc.mjs:2017`, which passes the whole input object to
  `searchMessages` (`src/server/messageSearch.mjs:52`).

Request: `POST /rpc/opencode:search-messages` with
`Authorization: Bearer <boxToken>` and body
`{"args":[{ "query": string, "sessionIds": string[], "maxPrimary"?: number }]}`.

- `query`: the trimmed user text, as desktop sends it. The server trims only to
  detect an empty query (`messageSearch.mjs:60-63`). It matches the untrimmed
  value (`likePattern` line 103, `indexOf` line 143), so the client must trim.
  Trimming covers whitespace and newlines.
- `sessionIds`: the scope in priority order. `sessionIds[0]` is the primary
  conversation. Falsy entries are dropped.
- `maxPrimary`: optional, and an existing parameter.
  - Defaults: 50 for the primary, `maxPerSession` 3 for each other session,
    `maxTotal` 200 overall.
  - The session-list entry sends `maxPrimary: 3` (D9), so no conversation is
    favoured when there is no current one.
  - The chat entry omits it.

Response (`src/shared/api.ts:1621-1629`):

```ts
{ supported: boolean; hits: TranscriptHit[]; truncated?: boolean }
// TranscriptHit (src/shared/types.ts:1937-1945)
{ sessionId: string; messageId: string; role: "user" | "assistant";
  pre: string; match: string; post: string; timeCreated: number | null } // ms epoch
```

Semantics (`messageSearch.mjs`):

| Case | Response |
|---|---|
| Empty query or empty scope | `{supported:true, hits:[]}` |
| No `node:sqlite`, or no opencode.db | `{supported:false, hits:[]}` (lines 16-20, 66, 93) |
| DB or worker error | `{supported:true, hits:[]}` after a server log (lines 94-97). **The client cannot tell this from a genuine empty result.** This is an inherited server limitation, out of scope under D7. |
| Scan exceeds the 8 s budget | Newest matches plus `truncated:true` |

- There is one hit per message. `pre` may start with "…". Whitespace is
  collapsed.
- Results are ordered by index in `sessionIds`, then newest first within a
  session.
- `messageId` is the V2 `session_message.id`. That is the same id the
  transcript's `opencode:messages` returns as `info.id` (`mapTimeline` in
  `src/shared/opencodeV2.mjs` keeps `m.id`), so it is valid for C2
  `.message`.

Transport and envelope failures:
- An `{error}` envelope becomes `MantaError.server`.
- A 401 becomes `MantaError.authRequired`.
- A non-JSON body becomes `MantaError.transport`.
- `MantaAPIClient.decode` / `transport` (`MantaAPIClient.swift:920-1000`)
  already produce these.

No `/events` frames are involved.

### iOS today

There is nothing for message search yet.
- `SessionListView.swift:28,370-380,700-712` filters sessions by NAME only.
- Nothing in `mobile/native/` calls `opencode:search-messages`.
- The names `TranscriptHit` / `SearchScope` / `SearchSection` / `SearchStore`
  are unused (grepped), so there are no collisions.

Reusable pieces:
- `MantaAPIClient.callRequired` / `jsonObject` (`MantaAPIClient.swift:954-982`;
  internal per C1).
- `SessionTimerFormat.age(_:)` (`SessionModels.swift:506,550-555`): a 1:1 port
  of desktop `formatAge`. Use it for the hit age in the view.
- `SessionListStore.projects` (published, every window including jobs).
  `SessionListStore` is already an `@EnvironmentObject` in the chat screen
  (`ChatScreen.swift:197`).
- `SessionListStore.window(forSessionID:)` (WS04, wave A, `04-sessions.md:96`).
- `MantaAPIClient.live()` (`MantaAPIClient.swift:20`).

### iOS design

New files, all owned by WS06:

| File | Imports | Contents |
|---|---|---|
| `MantaUI/SearchModels.swift` | **Foundation only** | Wire types, scope, grouping, copy and the query state machine. Added to `Package.swift` (D19). |
| `MantaUI/MantaAPIClient+Search.swift` | | The one RPC method. |
| `MantaUI/SearchStore.swift` | | A thin `@MainActor final class` that drives the state machine. |
| `MantaUI/SearchScreen.swift` | | The SwiftUI screen. |

**Presentation**
- `SearchScreen` is a sheet (`.presentationDetents([.large])`) with its own
  `NavigationStack`.
- Title "Search conversations", with a leading "Done" button that dismisses.
- The field is `.searchable(text:, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search in conversations…")`,
  focused on appear so the keyboard is up.
- A seeded query (from the session list) is placed in the field and searched
  immediately.

**List** (`.listStyle(.plain)`), in the order produced by
`SearchGrouping.sections`:
- "This conversation" comes first, only when opened from a chat and it has
  hits. Its trailing count is "N match" / "N matches".
- An "Other conversations" divider header appears when there are other groups
  or a search is in flight.
- Then one section per other conversation. The header is "`workspace › name`"
  on one line (middle-truncated, `tx3`), with a bare trailing count.

**Hit row** (a button, minimum height 44)
- Glyph `›` (accent) for user, `✳` (`tx4`) for assistant.
- A 2-line `AttributedString`: `pre` + `match` (accent-tinted background,
  semibold) + `post`.
- A caption: "you" / "assistant".
- A trailing age, `SessionTimerFormat.age(now - timeCreated/1000)` (mono,
  `tx4`), omitted when `timeCreated` is nil.
- Accessibility label "`{you|assistant}`: `{pre}{match}{post}`, `{age}`",
  hint "Opens this message".

**Footer row** (`tx4`, small)
- `SearchCopy.footer(...)` when there are hits.
- When `truncated`, a second line: "Showing the newest matches — this history
  is very large."

**States**: exactly one renders, from `SearchStore.state.phase`.

| Phase | Render | Copy |
|---|---|---|
| `.idle` (trimmed < 2) | `ContentUnavailableView` (magnifyingglass) | Title from `SearchCopy.idleTitle(hasPrimary:)`: chat entry "Search this conversation — and all others.", list entry "Search every conversation." Description: "Type at least 2 characters." |
| `.loading`, no results yet | `ProgressView` + caption | "Searching conversations…" |
| `.loading`, previous results kept | The results, plus an inline last row | "Searching other conversations…" |
| `.results` | The list above | — |
| `.empty` | `ContentUnavailableView.search(text: q)` | System copy |
| `.unsupported` | `ContentUnavailableView` (exclamationmark.triangle) | "Search needs a newer server runtime — update the server." |
| `.failed(msg)` | `ContentUnavailableView` + "Try again" (re-runs the current query) | "Couldn't search — {msg}." |

`.failed` covers transport and RPC-envelope failures only. A server-side DB or
worker failure arrives as an ordinary empty response and renders `.empty`; see
the wire table.

**Query state machine (pure, `SearchModels.swift`).** All sequencing lives in
a value type, so cancellation and stale-result rules are testable under
`verify.sh`.

```swift
struct SearchQueryState: Equatable, Sendable {
  enum Phase: Equatable, Sendable { case idle, loading, results, empty, unsupported, failed(String) }
  private(set) var phase: Phase = .idle
  private(set) var sections: [SearchSection] = []
  private(set) var truncated = false
  private(set) var seq = 0                       // current request generation
  let primarySessionId: String?

  /// Text changed. Always bumps `seq` (invalidating anything in flight).
  /// Below min chars → phase .idle, sections cleared, returns nil.
  /// Otherwise → phase .loading (sections KEPT), returns the token to run.
  mutating func queryChanged(_ raw: String) -> SearchTicket?
  /// Re-run the last active query (Try again). Same rules as queryChanged.
  mutating func retry() -> SearchTicket?
  /// Apply a response; ignored unless ticket.seq == seq.
  mutating func receive(_ response: SearchResponse, for ticket: SearchTicket)
  /// Apply a failure; ignored unless ticket.seq == seq. CancellationError
  /// (or an NSError with code NSURLErrorCancelled — avoids URLError, which lives in
  /// FoundationNetworking on Linux) is ignored ALWAYS — an expected exit, never .failed.
  mutating func fail(_ error: Error, for ticket: SearchTicket)
  /// Sheet dismissed: bump seq so any late completion is dropped.
  mutating func invalidate()
}
struct SearchTicket: Equatable, Sendable { let seq: Int; let query: String }  // query = trimmed
```

Rules:
- `SearchStore` is the only caller. Every mutation after an `await` (success,
  failure, cleanup) goes through `receive` / `fail`, which check the ticket.
  Nothing writes state directly after suspension.
- Cancellation never produces `.failed`.
- Clearing the field mid-request bumps `seq`, so the late response is dropped
  and the phase stays `.idle`.

**Store** (`SearchStore.swift`)

```swift
@MainActor final class SearchStore: ObservableObject {
  @Published private(set) var state: SearchQueryState
  @Published var query = "" { didSet { queryDidChange() } }
  init(scope: SearchScope, search: @escaping SearchFunction)
  func retry()
  func dismissed()          // cancels the task + state.invalidate()
}
typealias SearchFunction = @MainActor @Sendable (SearchRequest) async throws -> SearchResponse
```

- `queryDidChange` cancels the previous `Task`, then calls
  `state.queryChanged(query)`.
- If that returns a ticket, it starts a new `Task`:
  1. Sleep 120 ms. If the sleep throws, return.
  2. `try await search(scope.request(query: ticket.query))`.
  3. Call `state.receive(_:for:)`, or `state.fail(_:for:)` in the `catch`.
- There is no other state write and no `catch {}`.
- `SearchScreen` calls `dismissed()` from `.onDisappear`.

**API extension** (`MantaAPIClient+Search.swift`)

```swift
extension MantaAPIClient {
  /// `opencode:search-messages` — server-side search over every given
  /// session's full history (BET-698).
  func searchMessages(_ request: SearchRequest) async throws -> SearchResponse {
    try await callRequired("opencode:search-messages",
                           args: [jsonObject(request)], as: SearchResponse.self)
  }
}
```

### Pure logic (`SearchModels.swift`, Foundation only)

```swift
struct SearchRequest: Encodable, Equatable, Sendable {
  let query: String; let sessionIds: [String]; let maxPrimary: Int?   // nil → key omitted
}
struct TranscriptHit: Decodable, Equatable, Hashable, Sendable {
  let sessionId: String; let messageId: String
  let role: String                    // "user"; anything else renders as assistant
  let pre: String; let match: String; let post: String
  let timeCreated: Double?            // ms epoch
  var isUser: Bool { role == "user" }
}
struct SearchResponse: Decodable, Equatable, Sendable {
  let supported: Bool; let hits: [TranscriptHit]; let truncated: Bool?
}
/// One chat window, as the scope builder sees it — decoupled from MantaProject
/// (SessionModels.swift is not in Package.swift) so this file stays Foundation-only.
struct SearchScopeWindow: Equatable, Sendable { let workspace: String; let name: String; let sessionId: String? }
struct SearchLabel: Equatable, Sendable { let workspace: String; let name: String }
struct SearchScope: Equatable, Sendable {
  let primarySessionId: String?
  let sessionIds: [String]
  let labels: [String: SearchLabel]
  static func build(windows: [SearchScopeWindow], primarySessionId: String?) -> SearchScope
  func request(query: String) -> SearchRequest   // query trimmed (whitespacesAndNewlines); maxPrimary = primary == nil ? 3 : nil
}
struct SearchSection: Identifiable, Equatable, Sendable {
  let sessionId: String; let isCurrent: Bool; let hits: [TranscriptHit]
  var id: String { sessionId }
}
enum SearchGrouping {
  static func sections(hits: [TranscriptHit], primarySessionId: String?) -> [SearchSection]
}
enum SearchCopy {
  static let minQueryChars = 2
  static func normalized(_ raw: String) -> String          // trimmingCharacters(in: .whitespacesAndNewlines)
  static func isActive(_ raw: String) -> Bool              // normalized count >= 2
  static func currentCount(_ n: Int) -> String             // "1 match" / "N matches"
  static func footer(total: Int, conversations: Int) -> String
  static func header(label: SearchLabel?, sessionId: String) -> String  // "ws › name" or raw id
  static func idleTitle(hasPrimary: Bool) -> String
}
enum SearchJump {
  /// `owner` is SessionListStore.window(forSessionID:) bridged to a Bool.
  static func isReachable(sessionId: String, owner: (String) -> Bool) -> Bool
}
```

`SearchScope.build`:
- The primary goes first, if non-nil.
- Then every window, in order, whose `sessionId` is non-empty, de-duplicated.
- Job windows are included, for desktop parity.

The screen maps `sessionStore.projects` (not `visibleProjects`) to
`[SearchScopeWindow]` (`workspace = project.tmuxSession`, `name = window.name`,
`sessionId = window.opencodeSessionId`).

`SearchGrouping.sections`:
- Groups are in first-appearance order.
- The primary's group, if any, is moved first and marked `isCurrent`.

### XCTest — `MantaUITests/SearchTests.swift`

Foundation only. Added to `Package.swift` and runs under `verify.sh`.

1. `scopeBuild_primaryFirstThenWindowOrder_dedupes`: the primary also appears
   as a window and ends up listed once, first.
2. `scopeBuild_skipsWindowsWithoutChatSession`: nil and `""` ids.
3. `scopeBuild_includesJobWindows`: windows are passed through as given.
4. `request_noPrimary_sendsMaxPrimary3`; `request_withPrimary_omitsMaxPrimaryKey`
   (encode to JSON and assert the key is absent).
5. `request_trimsWhitespaceAndNewlines`: `"  foo \n"` → `"foo"`. This replaces
   the old untrimmed test.
6. `grouping_firstAppearanceOrder`; `grouping_currentSectionFirstAndFlagged`;
   `grouping_noPrimary_noCurrentSection`.
7. `isActive_trimsAndRequiresTwoChars`: `"a"`, `" a "`, `"ab"`, `"a\n"`.
8. `copy_pluralisation`: "1 match" / "2 matches"; "1 result · 1 conversation" /
   "3 results · 2 conversations".
9. `header_fallsBackToSessionId`.
10. `decode_supportedFalse`, `decode_truncated`, `decode_nullTimeCreated`,
    `decode_unknownRoleIsAssistant`.
11. State machine:
    - `state_belowMin_isIdle_noTicket`
    - `state_staleResponseDropped`: ticket 1 is issued, then ticket 2; ticket
      1's response is ignored.
    - `state_staleFailureDropped`: ticket 1 fails after ticket 2 was issued;
      the phase stays `.loading`.
    - `state_cancellationNeverFails`: a `CancellationError` for the CURRENT
      ticket leaves the phase unchanged.
    - `state_clearWhileInFlight_staysIdle`: ticket issued, query set to `""`,
      then the response arrives; the phase stays `.idle` with no sections.
    - `state_invalidateDropsLateResult`
    - `state_errorBecomesFailed`, `state_unsupported`, `state_emptyHits_isEmpty`
    - `state_loadingKeepsPreviousSections`
    - `state_retryReissuesLastQuery`
12. `jump_reachable` / `jump_unreachable`.

There are no Mac-only test files. `SearchStore` is a thin driver, and its
behaviour is covered by the state-machine tests. There are no server tests,
because there is no server change.

### Acceptance criteria

- [ ] Typing at least 2 non-whitespace characters sends exactly one
  `opencode:search-messages` call per settled query (120 ms debounce), with the
  query trimmed of surrounding whitespace and newlines. Fewer than 2 shows the
  idle hint and sends nothing.
- [ ] Opened from a chat, that chat's results come first under "This
  conversation" with "N match(es)". Other chats follow under "Other
  conversations", each headed "workspace › name".
- [ ] Every chat window on the box is in scope, including background-job
  windows.
- [ ] Matched text is visibly highlighted. User and assistant rows are
  distinguishable by glyph and caption. Age shows unless the box returned none.
- [ ] A box without the search runtime shows "Search needs a newer server
  runtime — update the server."
- [ ] A transport or RPC-envelope failure (no connection, timeout, auth, `{error}`
  envelope) shows "Couldn't search — …" with a working "Try again", never "no
  results". A server-side DB/worker failure shows as no results (inherited
  limitation, documented above).
- [ ] Typing fast never shows an error, and a late response or failure for an
  old query never replaces newer state. Clearing the field mid-search leaves the
  idle hint. Closing the sheet mid-search does nothing afterwards.
- [ ] `truncated:true` shows the "newest matches" note.
- [ ] `SearchTests` passes under `mobile/native/verify.sh` and under the Mac
  `test-unit` gate.

---

## F2 — Jump to a hit

### Desktop behaviour today

Jump is handled at `SearchPalette.tsx:139-156`. Picking a row also closes the
palette (`PaletteShell.tsx:13`).
- **Same session**: the `manta-scroll-to-message` event goes to
  `ChatPanel.tsx:1243-1272`, which scrolls to the row and flashes it, with the
  query highlighted inside the row.
- **Other session**: a pending-scroll latch is set and the window is activated.
  `ChatPanel.tsx:1274-1288` consumes the latch once the row has loaded.
- **Session no longer has a window**: the click silently does nothing
  (line 150). iOS does not copy this.

### Wire contract

WS06 has no wire contract of its own here; it only calls C2
`MantaNavigator.open(.message(sessionID:messageID:))`.
- WS02 F10 consumes it for its own session. It widens the loaded window if
  needed, scrolls and highlights. If the message is missing it shows "Couldn't
  find that message — it may have been compacted away"
  (`02-chat-cards-queue.md:590-610`).
- For another session, WS04's root handler (WS02 mount M2) opens the chat
  without clearing `pending`, and the new chat consumes it.

### iOS design

`SearchScreen` reads `@EnvironmentObject MantaNavigator` (injected in
`MantaAppRoot.swift`, D1) and `@EnvironmentObject SessionListStore`. On tap:

1. If `SearchJump.isReachable(sessionId:owner: { sessionStore.window(forSessionID: $0) != nil })`
   is false:
   - Keep the sheet open.
   - Show an inline banner at the top of the list: "That conversation is no
     longer open." It auto-dismisses after 4 s.
   - Do not navigate.
2. Otherwise:
   - Fire the selection haptic (respect `sessionStore.hapticsEnabled`).
   - Store the hit in `@State pendingJump`, then call `dismiss()`.
   - In `.onDisappear`, after `store.dismissed()`, if `pendingJump` is set, call
     `navigator.open(.message(sessionID:, messageID:))`.
   - Opening after the sheet has fully gone avoids a navigation push being
     dropped mid-dismiss.

The call is the same for same-session and cross-session hits.

The query is not carried in the route. Matched-text highlight after the jump is
deferred (D8); the whole row is highlighted by WS02.

### Acceptance criteria

- [ ] Tapping a hit in the current conversation closes search and scrolls to
  and highlights that message, even when it is older than what was loaded.
- [ ] Tapping a hit in another conversation closes search, opens that chat,
  and scrolls to and highlights the message.
- [ ] Tapping a hit whose conversation was closed meanwhile shows "That
  conversation is no longer open." and does not navigate.

---

## F3 — Entry points

### Desktop behaviour today

The desktop has ⌘F only, and only while a chat is active
(`App.tsx:1449-1462`). There is no list-level entry. On iOS the session list is
the home screen, so an entry there is the phone equivalent of "search from
anywhere".

### iOS design

`SearchScreen.init(scope: SearchScope, seed: String = "", search: SearchFunction? = nil)`.
When `search` is nil it uses `MantaAPIClient.live().searchMessages`. A
convenience builder keeps the call sites one-liners:

```swift
extension SearchScope {   // in SearchScreen.swift (needs MantaProject)
  static func fromProjects(_ projects: [MantaProject], primarySessionId: String?) -> SearchScope
}
```

1. **Chat nav bar** (mount M-06-1, applied by WS02):
   - A magnifyingglass toolbar button labelled "Search conversations".
   - It presents
     `SearchScreen(scope: .fromProjects(sessionStore.projects, primarySessionId: sessionId))`.
   - It appears only on the main chat screen, never on the read-only subagent
     screen.
2. **Session list** (mount M-06-2, applied by integration agent B):
   - When the "Search sessions" capsule holds at least 2 trimmed characters,
     show a final row in the list reading "Search messages for “{text}”"
     (`text.magnifyingglass`). Show the same as a button in `noMatchState`.
   - It presents
     `SearchScreen(scope: .fromProjects(store.projects, primarySessionId: nil), seed: trimmed)`.
   - This reuses the thumb-reach capsule (DECISIONS §3.2.14, §7.1) instead of
     adding a toolbar button.

### Acceptance criteria

- [ ] Every chat session has a search button in its nav bar, and it opens
  search scoped to that chat.
- [ ] Typing at least 2 characters in the session list's search capsule offers
  "Search messages for “…”", including when no session name matches. It opens
  search pre-filled and already searching.
- [ ] From the session list there is no "This conversation" section and no
  conversation is favoured.

---

## Files

Create (all owned by WS06):
- `mobile/native/MantaUI/SearchModels.swift` (Foundation only)
- `mobile/native/MantaUI/MantaAPIClient+Search.swift`
- `mobile/native/MantaUI/SearchStore.swift`
- `mobile/native/MantaUI/SearchScreen.swift`
- `mobile/native/MantaUITests/SearchTests.swift` (Foundation only)

Edit: none. Mounts and `Package.swift` are applied by others (below). WS06
never edits `project.pbxproj`; the orchestrator regenerates it at the end
(D18).

Manifest for the integration step:
- App sources: the four files above.
- `Package.swift` sources: `SearchModels.swift`.
- `Package.swift` test sources: `SearchTests.swift`.

## Mount requests

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-06-1 | `MantaUI/ChatScreen.swift` | **WS02**, wave B | `SearchScreen`, `SearchScope.fromProjects(_:primarySessionId:)` | See the M-06-1 notes below the table. | WS06's files exist in wave B (symbols are pinned here, so WS02 can write the call before they land). C2 `.message` handling (WS02 F10 in wave B; WS04 §11 `SessionListView` consumer in A2). |
| M-06-2 | `MantaUI/SessionListView.swift` | **Integration agent B** | `SearchScreen`, `SearchScope.fromProjects`, `SearchCopy.isActive`, `SearchCopy.normalized` | See the M-06-2 notes below the table. | WS04 landed (wave A) and the WS06 files landed (wave B). Apply in ledger order alongside WS09's mount on this file. |
| M-06-3 | `mobile/native/Package.swift` | **Integration agent B** | none | Add `"SearchModels.swift"` to `MantaUI` target `sources` and `"SearchTests.swift"` to `MantaUITests` `sources` (alphabetical). | WS06's files landed. |

**M-06-1 exact change** (`ChatScreen.swift`):
- **The receiver must call `SearchScope.fromProjects(_:primarySessionId:)`**
  (defined in `SearchScreen.swift`). There is NO `SearchScope.build(projects:…)`
  overload. The pure builder is `build(windows:primarySessionId:)` and stays
  free of `MantaProject`, so `SearchModels.swift` remains Foundation-only (D19).
  WS02's receipt row M-06-1 uses the call below verbatim (reconciled).
- In `.toolbar` (`ChatScreen.swift:345-351`), before the "Session actions"
  ellipsis, add
  `ToolbarItem(placement: .primaryAction) { Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search conversations") }`.
- Add `@State private var showSearch = false`.
- Add
  `.sheet(isPresented: $showSearch) { SearchScreen(scope: .fromProjects(sessionStore.projects, primarySessionId: sessionId)) }`,
  or a case in the screen's sheet enum if WS02 has one.
- Only on the main chat screen (non-empty `sessionId`), not the subagent
  screen.
- `MantaNavigator` and `SessionListStore` are already in the environment.

**M-06-2 exact change** (`SessionListView.swift`). This matches WS04's
receipt (§15, delegated to integration agent B) and the master's canonical
mount ledger. Integration agent B applies it BEFORE WS09's M-09-2 on the same
file.
- Add `case conversationSearch(seed: String)` to `SheetRoute`
  (`:1029-1041`), with id `"search:\(seed)"`. It renders
  `SearchScreen(scope: .fromProjects(store.projects, primarySessionId: nil), seed: seed)`.
- When `SearchCopy.isActive(searchText)`, append a final row to `list` reading
  "Search messages for “\(SearchCopy.normalized(searchText))”" with the
  `text.magnifyingglass` icon.
- Add a same-labelled button in `noMatchState` (`:818+`).
- Both set
  `sheetRoute = .conversationSearch(seed: SearchCopy.normalized(searchText))`.

## Mounts applied by this workstream

None. WS06 owns no existing file. I cross-checked the other specs' mount
tables in this folder: none targets a `Search*` file or `MantaAPIClient+Search.swift`.

## Client members

New `MantaAPIClient` members (in `MantaAPIClient+Search.swift`):
- `func searchMessages(_ request: SearchRequest) async throws -> SearchResponse`.
  This is the `opencode:search-messages` channel, and no other spec declares
  it (grepped: the channel appears only in this spec).

Consumed, owned elsewhere:
- `SessionListStore.window(forSessionID:)` (WS04).
- `SessionListStore.projects` and `hapticsEnabled` (existing).
- `MantaNavigator.open(_:)` (C2, WS04).

## Contracts provided / consumed

- **C1**: adds `MantaAPIClient+Search.swift`, with one member (see Client
  members). It uses the internal `callRequired` / `jsonObject`.
- **C2 consumed**: calls `open(.message(sessionID:messageID:))` only. This needs
  WS02 F10 (same session) and WS04's §11 `SessionListView` `.message` consumer (other session).
- **C4 consumed**: the chat nav-bar search mount (M-06-1), applied by WS02 per
  D18.
- **C7**: `MantaUITests/SearchTests.swift`. No server module.
- **D9**: `maxPrimary: 3` from the list entry. **D19**: `SearchModels.swift` and
  its tests are Foundation-only and go into `Package.swift`.
- C3, C5, C6: not used.

## Deferred

- **Matched-text highlight inside the target row after a jump** (D8). C2
  `.message` carries no query. WS02 highlights the whole row.
- **Keyboard navigation of results** (↑/↓/Enter). Hardware-keyboard shortcuts
  are out of scope (master, "Desktop-only by nature").
- **Telling a server DB/worker failure apart from "no matches"**. The server
  returns `{supported:true, hits:[]}` for both (`messageSearch.mjs:94-97`).
  Fixing that is a server change, which D7 does not allow.

## Open questions

None. The two round-0 questions were settled by D8 (no query in the route) and
D9 (`maxPrimary: 3`).

## Review responses (round 1)

**06-search.md**

1. **BLOCKING, chat mount owner/timing.** Fixed per D18: M-06-1 is applied by
   WS02 in wave B, with provider symbols pinned so WS02 can write the call in
   the same wave.
   - The session-list mount moved to integration agent B (M-06-2). Previously
     WS06 was to edit it itself, which conflicted with WS09 on the same file.
   - The stale line in `02-chat-cards-queue.md:773-776` ("applied by their
     owners in later waves") is overridden by D18. It is WS02's to update; I
     did not edit it (I may edit only this file).
2. **SHOULD, untrimmed query.** Fixed.
   - `SearchScope.request` trims whitespace and newlines, matching desktop
     `SearchPalette.tsx:70,113`.
   - The field keeps the raw text.
   - Test 5 is now `request_trimsWhitespaceAndNewlines`.
3. **SHOULD, cancellation/stale rules.** Fixed with the pure
   `SearchQueryState`.
   - Every post-suspension mutation is ticket-checked, including failures.
   - Cancellation is never `.failed`.
   - A below-minimum query bumps `seq` (mirrors `SearchPalette.tsx:101-106`).
   - Dismissal invalidates and cancels.
   - Added the tests for stale failure, cancellation, clear-while-in-flight and
     invalidate.
4. **SHOULD, failure criterion overreach.** Fixed. The criterion is now limited
   to transport and RPC-envelope failures. The DB/worker degradation is
   recorded as an inherited limitation (wire table and Deferred), with no
   server change (D7).

**00-cross-cutting.md**

- **#7 (wave-B SessionListView edits).** Resolved by M-06-2 → integration
  agent B. WS06 no longer edits `SessionListView.swift`.
- **#8 (conflicting ChatScreen mount owner).** Resolved by M-06-1 → WS02
  (D18).
- **#10 (Package/pbxproj).** WS06 no longer regenerates the project.
  - Package additions are mount M-06-3 for integration agent B.
  - `SearchModels.swift` was made Foundation-only by replacing `MantaProject`
    with `SearchScopeWindow` and moving the wire types into it, so it and its
    tests run under `verify.sh` (D19).

No rebuttals.

## Review responses (round 2)

**06-search.md**

1. **BLOCKING, the WS02 receipt calls the removed `SearchScope.build(projects:)`.**
   No change is needed to WS06's provider. This spec already pins only
   `build(windows:primarySessionId:)` (pure, Foundation-only) plus the app
   adapter `SearchScope.fromProjects(_:primarySessionId:)` in
   `SearchScreen.swift`. Per the finding, no compatibility overload was added.
   - M-06-1 now states explicitly that the receiver must use
     `.fromProjects(sessionStore.projects, primarySessionId: sessionId)` and the
     ID `M-06-1`.
   - WS02's receipt now matches (reconciliation after round 2).

**00-cross-cutting.md**

- **#7 (same issue).** Handled as above.
- **Consolidated ledger rows M-06-1/2/3.** My table matches them exactly:
  - M-06-1: ChatScreen.swift, applied by WS02 in wave B, providers
    `SearchScreen` / `SearchScope.fromProjects`.
  - M-06-2: SessionListView.swift, applied by integration agent B after wave B,
    providers `SearchScreen` / `fromProjects` / `SearchCopy.isActive` /
    `SearchCopy.normalized`.
  - M-06-3: Package.swift, applied by integration agent B, `SearchModels` /
    `SearchTests`.

Provider symbol names were re-verified against current spec text:
- `SessionListStore.window(forSessionID:) -> (project: String, window: MantaWindow)?`
  (`04-sessions.md:97,1352`).
- `MantaNavigator.open(_ route: MantaRoute)` (`04-sessions.md:1081`).
- The `.message` route is left pending by WS04 for WS02 to consume
  (`04-sessions.md:1104-1108`).

D20 (wave A sub-waves) and D21 do not affect WS06, which runs in wave B.

No rebuttals.
