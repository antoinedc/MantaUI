# WS06 — Conversation search (iOS)

Status: draft · Date: 2026-10-28 · Wave: B (after WS04 has landed; the
`.message` route from C2 must be live before any jump is wired — see
"Contracts consumed").

Scope: one feature, three parts.

1. **F1 — Search screen**: search the full history of every chat window on the
   box with one server query; results grouped "This conversation" vs other
   conversations; snippet with the matched text highlighted; role and age.
2. **F2 — Jump to a hit**: tapping a hit closes search and opens that message —
   scrolled to and highlighted — in the same or another conversation.
3. **F3 — Entry points**: from the chat nav bar (scoped to the open chat) and
   from the session list (no "current" conversation).

No server change is needed: the existing `opencode:search-messages` channel
already does everything. **No new server routes.**

---

## F1 — Search screen

### Desktop behaviour today

`src/renderer/SearchPalette.tsx` (⌘F, opened from `src/renderer/App.tsx:1449-1462`,
only when a chat pane is active; mounted at `App.tsx:2307-2314`). It is a dumb
renderer of one server query:

- **Scope** (`SearchPalette.tsx:74-86`): the active session id first, then every
  OTHER window in sidebar order that has an `opencodeSessionId`, de-duplicated,
  no cap. `flatSessions` (`src/renderer/store.ts:1774-1781`) walks every
  project's every window — job windows included.
- **Query gating**: trimmed query must be ≥ 2 characters
  (`MIN_QUERY_CHARS = 2`, line 27); 120 ms debounce (`SEARCH_DEBOUNCE_MS`,
  line 28); a sequence counter drops stale responses (lines 100-125).
- **Grouping** (`groupHits`, lines 39-54): the server returns a flat list
  already ordered primary-first, then by scope order; hits are grouped by
  `sessionId` in first-appearance order. The group whose id is the active
  session is "This conversation"; the rest sit under an "other conversations"
  divider.
- **Section headers** (`SectionHeader`, lines 270-293): "This conversation" with
  count `N match` / `N matches`; other groups show `workspace › session-name`
  (tmux session name › window name; falls back to the raw session id) with a
  bare numeric count.
- **Hit row** (`HitRow`, lines 295-355): glyph `›` for user / `✳` for assistant;
  `pre` + highlighted `match` + `post`, clamped to 2 lines; a "you" /
  "assistant" caption; right-aligned age via `formatAge`
  (`src/renderer/chatUtils.ts:542-550`: `now` / `Nm` / `Nh` / `Nd`), omitted
  when `timeCreated` is null.
- **Footer**: `"{total} result(s) · {n} conversation(s)"` when there are hits
  (lines 170-173).
- **States / copy** (exact strings):
  - idle (< 2 chars): "Search this conversation — and all others. Type at least 2 characters."
  - `supported:false`: "Search needs a newer server runtime — update the server."
  - loading (below any results): "Searching other conversations…"
  - empty: `No matches for “{q}”`
  - placeholder: "Search in conversations…"; label "Search conversations".
- **Errors**: a transport failure is swallowed into "no results"
  (lines 116-119). iOS must NOT copy this (no-dead-controls rule) — see iOS
  design.
- `truncated: true` from the server is ignored by the desktop.

### Wire contract (verified)

Channel: **`opencode:search-messages`** (`src/shared/types.ts:1554`,
`IPC.opencodeSearchMessages`). Desktop call: `src/renderer/api/httpApi.ts:1439`
→ `rpc(IPC.opencodeSearchMessages, input)`. Server: `src/server/rpc.mjs:2017`
`"opencode:search-messages": (input) => searchMessages(input ?? {})` →
`src/server/messageSearch.mjs:52`.

Request: `POST /rpc/opencode:search-messages`, `Authorization: Bearer <boxToken>`,
body `{"args":[{ "query": string, "sessionIds": string[], "maxPrimary"?: number }]}`.

- `query` — raw user text (server matches case-insensitively, LIKE-escaped).
- `sessionIds` — scope in priority order; `sessionIds[0]` is the "primary"
  (current) conversation. Falsy entries are dropped server-side.
- `maxPrimary` — OPTIONAL, an existing parameter of `searchMessages`
  (default 50; per-other-session cap `maxPerSession` default 3, overall
  `maxTotal` default 200). The handler passes the whole input object through,
  so it is honoured today. iOS sends `maxPrimary: 3` ONLY from the session-list
  entry point (no current conversation, so the first session must not get 50
  hits while the others get 3). The chat entry point omits it, exactly like
  desktop.

Response (`src/shared/api.ts:1621-1629`):

```ts
{ supported: boolean; hits: TranscriptHit[]; truncated?: boolean }
// TranscriptHit (src/shared/types.ts:1937-1945)
{ sessionId: string; messageId: string; role: "user" | "assistant";
  pre: string; match: string; post: string; timeCreated: number | null } // ms epoch
```

Semantics (`messageSearch.mjs`):
- empty/whitespace query or empty scope → `{supported:true, hits:[]}`.
- no `node:sqlite` / no opencode.db → `{supported:false, hits:[]}` (lines 16-20, 66, 93).
- DB/worker error → logged server-side, `{supported:true, hits:[]}` (never throws).
- 8 s scan budget exceeded on a huge history → newest matches + `truncated:true`.
- One hit per message; `pre` may start with "…"; whitespace collapsed.
- Order: by index in `sessionIds`, then newest first within a session.
- `messageId` is the V2 `session_message.id` — the same id the transcript's
  `opencode:messages` returns as `info.id` (`mapTimeline` in
  `src/shared/opencodeV2.mjs` keeps `m.id`), so it is valid for the C2
  `.message` route.

Transport-level errors use the normal RPC envelope (`{error:"…"}` →
`MantaError.server`, 401 → `MantaError.authRequired`, 503 upgrade handled by the
client transport) — `MantaAPIClient.decode` already maps these.

No `/events` frames are involved.

### iOS today

Nothing. `SessionListView.swift:28,370-380,700-712` has a *session-name* filter
("Search sessions" capsule) only; it never looks at message text. There is no
call to `opencode:search-messages` anywhere in `mobile/native/`.

Reusable pieces:
- `MantaAPIClient.call` / `callRequired` (`MantaAPIClient.swift:944-959`),
  internal after the C1 foundation commit.
- `SessionTimerFormat.age(_:)` (`SessionModels.swift:550-555`) is already a 1:1
  port of desktop `formatAge` — reuse it for the hit age; do not re-implement.
- `MantaProject` / `MantaWindow` (`SessionModels.swift:33-64`; `opencodeSessionId`,
  `name`, `tmuxSession`) and `SessionListStore.projects` (published) for scope
  and labels. `SessionListStore` is already an `@EnvironmentObject` inside the
  chat screen (`ChatScreen.swift:197`).
- `MantaAPIClient.live()` (`MantaAPIClient.swift:20`) for the default client.

### iOS design

New files (all WS06-owned):

- `MantaUI/MantaAPIClient+Search.swift` — the RPC method + wire types.
- `MantaUI/SearchModels.swift` — pure logic (scope, grouping, copy, gating).
- `MantaUI/SearchStore.swift` — `@MainActor final class SearchStore: ObservableObject`.
- `MantaUI/SearchScreen.swift` — the SwiftUI screen.

**Presentation**: `SearchScreen` is a sheet (`.presentationDetents([.large])`)
with its own `NavigationStack` for a title bar: title "Search conversations",
leading "Done" button (dismisses). Search field uses `.searchable(text:,
placement: .navigationBarDrawer(displayMode: .always), prompt: "Search in conversations…")`
and is focused on appear (`.searchFocused` / `@FocusState`) so the keyboard is
up immediately. (DECISIONS §3.2.14 puts *list* search at the bottom; this is a
dedicated search screen where the field is the whole point, and the system
search-drawer idiom is the native one — the keyboard sits in thumb reach.)
Seeded text (from the session list) is placed in the field and searched
immediately.

**List**: a plain `List` (`.listStyle(.plain)`), sections in the order produced
by `SearchGrouping`:

- Section "This conversation" (only when opened from a chat and it has hits),
  header trailing count "N match" / "N matches".
- If there are other groups (or a search is still loading), a quiet divider
  header "Other conversations" (sentence case; desktop's lowercase divider is a
  visual choice).
- One section per other conversation: header "`workspace › name`" (one line,
  middle-truncated, `tx3`), trailing bare count.

**Hit row** (button, min height 44): leading glyph (`›` accent for user, `✳`
`tx4` for assistant — the desktop glyphs), then a 2-line text built as an
`AttributedString`: `pre` + `match` (accent-tinted background, semibold) +
`post`; caption "you" / "assistant" below; trailing age
(`SessionTimerFormat.age(now - timeCreated/1000)`, mono, `tx4`) — omitted when
`timeCreated` is nil. Accessibility label: "`{you|assistant}`: `{pre}{match}{post}`, `{age}`",
hint "Opens this message".

**Footer** (last row, `tx4`, small): "`{total} result(s) · {n} conversation(s)`"
when there are hits; when the response had `truncated: true`, append on its own
line "Showing the newest matches — this history is very large." (the desktop
ignores `truncated`; showing it is the honest outcome, not a new feature).

**States** (exactly one renders, all from `SearchStore.phase`):

| State | Render | Copy |
|---|---|---|
| idle (trimmed < 2 chars) | `ContentUnavailableView` (magnifyingglass) | Chat entry: "Search this conversation — and all others." List entry: "Search every conversation." Both + description "Type at least 2 characters." |
| loading, no results yet | `ProgressView` + caption | "Searching conversations…" |
| loading with results shown (re-query) | keep previous results, small inline row at the end | "Searching other conversations…" |
| results | list above | — |
| empty | `ContentUnavailableView.search(text: q)` | (system copy "No Results for “q”") |
| unsupported | `ContentUnavailableView` (exclamationmark.triangle) | "Search needs a newer server runtime — update the server." |
| failed | `ContentUnavailableView` + "Try again" button (re-runs current query) | "Couldn't search — {error message}." |

The "failed" state replaces desktop's silent swallow: on a phone a dropped
connection must not look like "no matches".

**Store** (`SearchStore`):

```swift
@MainActor final class SearchStore: ObservableObject {
  enum Phase: Equatable { case idle, loading, results, empty, unsupported, failed(String) }
  @Published private(set) var phase: Phase = .idle
  @Published private(set) var sections: [SearchSection] = []
  @Published private(set) var truncated = false
  @Published var query = ""                  // bound to .searchable
  init(scope: SearchScope, search: @escaping SearchFunction)   // injectable
  func queryChanged()                        // debounced 120 ms, seq-guarded
  func retry()
}
typealias SearchFunction = @MainActor (SearchRequest) async throws -> SearchResponse
```

- Debounce: one `Task` per change, `Task.sleep(120 ms)`, cancelled by the next
  change; a monotonically increasing `seq` drops stale responses (mirrors
  `SearchPalette.tsx:100-125` and the existing `ComposerView` file-search
  pattern at `ComposerView.swift:1542-1560`).
- While loading, previous `sections` stay visible (no flash to empty).
- `catch` maps the error to `.failed(message)` — no `catch {}`.
- Scope is captured at open (`SearchScope.build`), not live-updated; a session
  closed meanwhile is handled at tap time (F2).

**API extension** (`MantaAPIClient+Search.swift`):

```swift
struct SearchRequest: Encodable, Equatable {
  let query: String
  let sessionIds: [String]
  let maxPrimary: Int?          // nil → omitted from JSON
}
struct TranscriptHit: Decodable, Equatable, Hashable {
  let sessionId: String; let messageId: String
  let role: String              // "user" | anything else → assistant
  let pre: String; let match: String; let post: String
  let timeCreated: Double?      // ms epoch
}
struct SearchResponse: Decodable, Equatable {
  let supported: Bool; let hits: [TranscriptHit]; let truncated: Bool?
}
extension MantaAPIClient {
  /// `opencode:search-messages` — server-side search over every given
  /// session's full history (BET-698).
  func searchMessages(_ request: SearchRequest) async throws -> SearchResponse {
    try await callRequired("opencode:search-messages",
                           args: [jsonObject(request)], as: SearchResponse.self)
  }
}
```

(Name the hit type `SearchHit` instead if `TranscriptHit` collides with any
existing Swift symbol at implementation time; grep first.)

### Pure logic (`SearchModels.swift`)

```swift
struct SearchScope: Equatable {
  let primarySessionId: String?        // nil when opened from the session list
  let sessionIds: [String]             // request order
  let labels: [String: SearchLabel]    // sessionId → (workspace, name)
  static func build(projects: [MantaProject], primarySessionId: String?) -> SearchScope
  func request(query: String) -> SearchRequest   // maxPrimary = primary == nil ? 3 : nil
}
struct SearchLabel: Equatable { let workspace: String; let name: String }
struct SearchSection: Identifiable, Equatable {
  let sessionId: String; let isCurrent: Bool; let hits: [TranscriptHit]
  var id: String { sessionId }
}
enum SearchGrouping {
  static func sections(hits: [TranscriptHit], primarySessionId: String?) -> [SearchSection]
}
enum SearchCopy {
  static let minQueryChars = 2
  static func isActive(_ query: String) -> Bool           // trimmed count >= 2
  static func currentCount(_ n: Int) -> String             // "1 match" / "N matches"
  static func footer(total: Int, conversations: Int) -> String
  static func header(label: SearchLabel?, sessionId: String) -> String  // "ws › name" or raw id
  static func idleTitle(hasPrimary: Bool) -> String
}
```

`SearchScope.build`: primary first (if non-nil), then every window of every
project in `projects` order whose `opencodeSessionId` is non-empty, de-duped —
job windows included (desktop parity; use `SessionListStore.projects`, not
`visibleProjects`). `SearchGrouping.sections`: group in first-appearance order;
the primary's group (if any) is moved first and marked `isCurrent`.

### XCTest — `MantaUITests/SearchTests.swift`

1. `scopeBuild_primaryFirstThenProjectOrder_dedupes` — primary also appears as a window → appears once, first.
2. `scopeBuild_skipsWindowsWithoutChatSession` (nil and "" ids).
3. `scopeBuild_includesJobWindows`.
4. `scopeBuild_noPrimary_requestSendsMaxPrimary3`; with primary → `maxPrimary` nil and absent from encoded JSON.
5. `request_encodesQueryUntrimmed` (server matches what the user typed; gating uses trimmed).
6. `grouping_firstAppearanceOrder` and `grouping_currentSectionFirstAndFlagged`.
7. `grouping_noPrimary_noCurrentSection`.
8. `isActive_trimsAndRequiresTwoChars` ("a", " a ", "ab").
9. `copy_pluralisation` (1 match / 2 matches; 1 result · 1 conversation / 3 results · 2 conversations).
10. `header_fallsBackToSessionId` when label missing.
11. `decode_response_supportedFalse`, `decode_response_truncated`, `decode_hit_nullTimeCreated`.
12. `store_staleResponseDropped` — two queries, first resolves last → only the second's results land (inject a controllable `SearchFunction`).
13. `store_errorBecomesFailedNotEmpty`, `store_unsupported`, `store_emptyHits_isEmpty`, `store_belowMinChars_isIdle_noCall`.

No server tests: no server change. (Existing `src/server/messageSearch.test.mjs`
already covers the channel; add a case there only if the implementer touches it.)

### Acceptance criteria

- [ ] Typing ≥ 2 characters sends exactly one `opencode:search-messages` call per settled query (120 ms debounce); fewer than 2 shows the idle hint and sends nothing.
- [ ] Opened from a chat, results for that chat appear first under "This conversation" with "N match(es)"; other chats follow under "Other conversations", each headed "workspace › name".
- [ ] Every chat window on the box is in scope, including ones with no recent activity and background-job windows.
- [ ] Matched text is visibly highlighted in each row; user vs assistant is distinguishable by glyph and caption; age shows except when the box returned none.
- [ ] A box without the search runtime shows "Search needs a newer server runtime — update the server."
- [ ] A network/server failure shows an error with a working "Try again" — never "no results".
- [ ] A late response for an old query never replaces newer results.
- [ ] `truncated:true` shows the "newest matches" note.

---

## F2 — Jump to a hit

### Desktop behaviour today

`SearchPalette.tsx:139-156`; picking a row also closes the palette
(`PaletteShell.tsx:13`, pick = onPick then close).
- Same session → `manta-scroll-to-message` event → `ChatPanel.tsx:1243-1272`
  scrolls to the row that draws the message and flashes it ~1.2 s, highlighting
  the query text inside the row.
- Other session → a pending-scroll latch, then the window is activated;
  `ChatPanel.tsx:1274-1288` consumes it once the row is in the loaded
  transcript (retries on each transcript commit).
- If the session no longer owns a window (`resolveSessionOwner` null), the
  desktop silently does nothing (line 150) — a dead click; iOS must not copy it.

### Wire contract

None of WS06's own. Navigation goes through C2:
`MantaNavigator.open(.message(sessionID:messageID:))`. WS02 owns scroll +
highlight (and fetching earlier history when the message is outside the loaded
window); WS04 owns resolving a session id to its window and pushing the chat.

### iOS design

`SearchScreen` gets `@EnvironmentObject var navigator: MantaNavigator` and
`@EnvironmentObject var sessionStore: SessionListStore`. On tap:

1. Check the hit's `sessionId` is still owned by a window in
   `sessionStore.projects` (pure helper `SearchJump.isReachable(sessionId:projects:)`).
   If not: keep the sheet open and show an inline banner at the top of the list
   "That conversation is no longer open." (auto-dismiss 4 s) — no navigation.
2. Otherwise: light selection haptic (respect `sessionStore.hapticsEnabled`),
   dismiss the sheet, and in the dismiss completion (or next main-actor turn)
   call `navigator.open(.message(sessionID: hit.sessionId, messageID: hit.messageId))`.
   This is the same call for same-session and cross-session hits; WS02's route
   handler treats "already on that chat" as scroll-only.

The query is NOT carried in the route (C2 has no field for it); the target row
is highlighted as a whole by WS02. See Open questions.

### Pure logic + tests (in `SearchTests.swift`)

- `jump_reachable_whenWindowOwnsSession`, `jump_unreachable_whenSessionGone`.

### Acceptance criteria

- [ ] Tapping a hit in the current conversation closes search and scrolls to + highlights that message, even if it is older than what was loaded.
- [ ] Tapping a hit in another conversation closes search, opens that chat, and scrolls to + highlights the message.
- [ ] Tapping a hit whose conversation was closed meanwhile shows "That conversation is no longer open." and does not navigate.
- [ ] No jump is wired until the `.message` route owner (WS02) has landed (C2 rule).

---

## F3 — Entry points

### Desktop behaviour today

⌘F only, and only while a chat pane is active (`App.tsx:1449-1462`). The
desktop has no list-level entry; on iOS the session list is the home screen, so
an entry there is the phone equivalent of "search from anywhere".

### iOS design

1. **Chat nav bar** (WS02-owned `ChatScreen.swift`): a `ToolbarItem(placement:
   .primaryAction)` with `Image(systemName: "magnifyingglass")`,
   `accessibilityLabel("Search conversations")`, placed before the existing
   "Session actions" ellipsis (`ChatScreen.swift:345-351`). Tap presents
   `SearchScreen(scope: SearchScope.build(projects: sessionStore.projects, primarySessionId: sessionId))`.
   Only rendered when the screen has a non-empty chat `sessionId` (never on the
   read-only subagent screen).
2. **Session list** (WS04-owned `SessionListView.swift`): when the name filter
   ("Search sessions" capsule) holds ≥ 2 trimmed characters, show a final row
   in the list — and a button in `noMatchState` (`SessionListView.swift:818+`) —
   reading "Search messages for “{text}”" with a `text.magnifyingglass` icon.
   Tap presents `SearchScreen(scope: SearchScope.build(projects: store.projects, primarySessionId: nil), seed: searchText)`.
   This reuses the existing thumb-reach capsule (DECISIONS §3.2.14, §7.1)
   instead of adding a fourth toolbar button.

`SearchScreen` init: `init(scope: SearchScope, seed: String = "", api: MantaAPIClient = .live())`.

### Acceptance criteria

- [ ] A search button is in the chat nav bar of every chat session and opens search scoped to that chat.
- [ ] Typing ≥ 2 characters in the session list's search capsule offers "Search messages for “…”", including when no session name matches; it opens search pre-filled and already searching.
- [ ] From the session list there is no "This conversation" section and no single conversation is favoured.

---

## Files

Create (WS06-owned):
- `mobile/native/MantaUI/MantaAPIClient+Search.swift`
- `mobile/native/MantaUI/SearchModels.swift`
- `mobile/native/MantaUI/SearchStore.swift`
- `mobile/native/MantaUI/SearchScreen.swift`
- `mobile/native/MantaUITests/SearchTests.swift`

Regenerate `MantaUI.xcodeproj` via xcodegen (new files are picked up by the
directory source entries in `project.yml`; no `project.yml` edit expected).

Edit: none outside the above (mounts below are applied by their owners).

## Mount requests

1. **WS02 — `ChatScreen.swift`** (allowed by C4): in the `.toolbar` at
   `ChatScreen.swift:345-351`, add before the ellipsis item:
   ```swift
   ToolbarItem(placement: .primaryAction) {
     Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }
       .accessibilityLabel("Search conversations")
   }
   ```
   plus `@State private var showSearch = false` and
   `.sheet(isPresented: $showSearch) { SearchScreen(scope: SearchScope.build(projects: sessionStore.projects, primarySessionId: sessionId)) }`
   (or as a case of the screen's existing sheet mechanism if it has a single
   sheet enum). `SearchScreen` needs `MantaNavigator` and `SessionListStore` in
   the environment — both are already injected app-wide.
2. **WS04 — `SessionListView.swift`**: add `case conversationSearch(seed: String)`
   to `SheetRoute` (`SessionListView.swift:1029-1041`, id
   `"search:\(seed)"`) rendering `SearchScreen(scope: SearchScope.build(projects: store.projects, primarySessionId: nil), seed: seed)`;
   add the "Search messages for “{searchText}”" row at the end of `list` and a
   button in `noMatchState`, both shown only when
   `SearchCopy.isActive(searchText)`, both setting
   `sheetRoute = .conversationSearch(seed: searchText.trimmingCharacters(in: .whitespaces))`.
   Per the master Waves note, WS06 applies this itself in wave B after WS04 has
   landed (WS04 is not editing the file in wave B).

## Contracts provided / consumed

- **C1 consumed**: uses internal `callRequired` / `jsonObject`; adds
  `MantaAPIClient+Search.swift` (provided: `searchMessages(_:)`).
- **C2 consumed**: calls `MantaNavigator.open(.message(sessionID:messageID:))`
  only; requires WS02's `.message` handler (incl. load-earlier) and WS04's
  session resolution. Does not implement any route.
- **C4 consumed**: one chat nav-bar mount (listed in C4 for WS06).
- C3, C5, C6: not used. **C7**: `MantaUITests/SearchTests.swift`; no server
  module added.
- Provided to others: `SearchScreen` / `SearchScope` (no other workstream needs them).

## Deferred

- **Highlighting the query inside the target row after a jump** (desktop flashes
  the matched text, `ChatPanel.tsx:1252-1254`): C2's `.message` route carries no
  query, and adding one changes a shared contract owned by WS02. The row-level
  highlight is delivered; text-level highlight deferred until C2 grows an
  optional `query`.
- **Keyboard navigation of results** (↑/↓/Enter in the palette): hardware
  keyboard shortcuts are out of scope (master "Desktop-only by nature").

## Open questions

1. Should C2's `.message` carry an optional `query` so WS02 can highlight the
   matched text? **Default: no** (deferred above); revisit if WS02 finds it cheap.
2. Is sending `maxPrimary: 3` from the session-list entry acceptable, given the
   server comment says "the renderer never overrides" the caps? **Default: yes**
   — it is an existing, already-honoured parameter, used only so no single
   conversation is favoured when there is no current one; no server change.
