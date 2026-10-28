# WS06 — Conversation search (iOS + server + desktop)

Status: revised for server-first (D23/D24) · Date: 2026-10-28 · Wave: B.

Scope: one feature, three parts, plus the server-first move of its logic.

1. **F1 — Search screen**: search the full history of every chat window on the
   box with one server query. The **box** decides the scope, groups the hits,
   labels each group, and says whether the search failed; both clients only
   render that. Each hit shows a snippet with the matched text highlighted,
   its role and its age.
2. **F2 — Jump to a hit**: tapping a hit closes search and opens that message,
   scrolled to and highlighted, in the same conversation or another one.
3. **F3 — Entry points**: from the chat nav bar (scoped to the open chat) and
   from the session list (no current conversation).

Server work (audit Q1–Q3, see "Server-first (D23/D24)"): the existing
`opencode:search-messages` channel is **extended additively** in
`src/server/messageSearch.mjs`. There is no new channel, route or frame. The
desktop's `SearchPalette.tsx` switches to the new response in the same change.

Wave B timing (D18/D24):
- WS06 writes its own new iOS files, extends `messageSearch.mjs` and its node
  tests, and switches the desktop palette (`SearchPalette.tsx`,
  `src/shared/api.ts`, `src/shared/types.ts`). No other wave-B worker touches
  those desktop/shared lines (checked: specs 02/07/09 do not name
  `SearchPalette.tsx` or the search types).
- The one-line handler change in `src/server/rpc.mjs` is mount M-06-srv-1,
  applied by integration agent B **last** in the D24 order 02 → 07 → 09 → 06.
- WS02 (wave B) applies the chat nav-bar mount.
- Integration agent B applies the session-list mount and the `Package.swift`
  additions after the wave-B workers finish.
- Jumps call the C2 `.message` route. The route is handled by WS02 (same
  session, wave B) and by WS04's root handler (other session). Both are live
  by the end of wave B. Nothing in WS06 is reachable from the UI until its
  mounts are applied, so it is never usable before the route works.

---

## F1 — Search screen

### Desktop behaviour today (before this change)

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


The scope, grouping and failure rules above move to the box; see
"Server-first (D23/D24)" for what the desktop deletes.

### Wire contract (verified today, extended by this spec)

Channel: **`opencode:search-messages`** (`src/shared/types.ts:1554`,
`IPC.opencodeSearchMessages`).
- Desktop call: `src/renderer/api/httpApi.ts:1439` (passes the input through
  unchanged — no httpApi edit needed).
- Server today: `src/server/rpc.mjs:2017`
  `"opencode:search-messages": (input) => searchMessages(input ?? {})`, which
  calls `src/server/messageSearch.mjs:52`.
- Other server caller: the CTO engine (`src/server/cto.mjs:408`, wired at
  `index.mjs:2233`) calls `searchMessages({query, sessionIds})`. It keeps
  working unchanged (legacy input; extra response fields are ignored).

**Today's request:** `{"args":[{ "query": string, "sessionIds": string[], "maxPrimary"?: number }]}`.
**Today's response** (`src/shared/api.ts:1621-1629`):
`{ supported: boolean; hits: TranscriptHit[]; truncated?: boolean }`, where
`TranscriptHit` (`src/shared/types.ts:1937-1945`) is
`{ sessionId, messageId, role: "user"|"assistant", pre, match, post, timeCreated: number|null }`.

The new request/response (both clients use only the new form) is pinned in
"Server-first (D23/D24)" below.

Facts that do not change:
- `query` must be trimmed by the client. The server trims only to detect an
  empty query (`messageSearch.mjs:60-63`); it matches the untrimmed value
  (`likePattern` line 103, `indexOf` line 143). Desktop trims
  (`SearchPalette.tsx:70,113`); iOS trims whitespace and newlines.
- One hit per message. `pre` may start with "…". Whitespace is collapsed.
- `truncated:true` = the 8 s scan budget ran out; newest matches only.
- `supported:false` = no `node:sqlite` or no opencode.db
  (`messageSearch.mjs:16-20,66,93`).
- `messageId` is the V2 `session_message.id`, the same id the transcript's
  `opencode:messages` returns as `info.id` (`mapTimeline` in
  `src/shared/opencodeV2.mjs` keeps `m.id`), so it is valid for C2 `.message`.

Transport and envelope failures on iOS:
- An `{error}` envelope becomes `MantaError.server`.
- A 401 becomes `MantaError.authRequired`.
- A non-JSON body becomes `MantaError.transport`.
- `MantaAPIClient.decode` / `transport` (`MantaAPIClient.swift:920-1000`)
  already produce these.

No `/events` frames are involved.

## Server-first (D23/D24)

Audit rows folded here (`server-first-audit.md` §WS06, all MOVE-NOW, all in
`src/server/messageSearch.mjs`): **Q1** scope, **Q2** grouping + labels,
**Q3** failed vs no-matches. Rows Q4 (trim / min length / debounce /
sequence), Q5 (count and footer plurals) and Q6 (jump reachability) are
KEEP-CLIENT per the audit and stay in both clients.

### Q1 — Scope resolved by the box

**Module:** `src/server/messageSearch.mjs` (extended).

**Request** (additive; `sessionIds` stays accepted for old clients and the CTO
engine):

```jsonc
{ "query": "string",                 // trimmed by the client
  "scope": "all",                    // NEW — the box enumerates the windows itself
  "primarySessionId": "ses_…" }      // NEW, optional — the current conversation
```

**Signature:**
`searchMessages(input = {}, deps = {})`, where
`deps = { listProjects?: () => Promise<Project[]>, runDbTask?: typeof runDbTask }`.
`runDbTask` is a test seam only and defaults to the `dbOffload.mjs` import.

**Rules** (new pure export `resolveSearchScope(projects, primarySessionId)`
→ `{ sessionIds: string[], labels: Map<string, {workspace, name}> }`):
- `primarySessionId` comes first when given, even if no window carries it
  (desktop parity: the active chat is always searched).
- Then every window of every project, in the `projects` order (project order,
  then window order — the same list `tmux:list` serves and both sidebars
  render), whose `opencodeSessionId` is non-empty. De-duplicated. Job windows
  are included.
- Labels: `workspace = project.tmuxSession`, `name = window.name`.
- **Hit caps:** when `scope:"all"` has no `primarySessionId`, the default
  `maxPrimary` becomes `maxPerSession` (3). No conversation is favoured. This
  replaces the client's `maxPrimary: 3` (D9 is now implemented server-side).
  With a primary, the default stays 50. An explicit `maxPrimary` is still
  honoured.
- `scope:"all"` with no `deps.listProjects`, or a `listProjects` that throws →
  `{supported:true, hits:[], groups:[], degraded:true}`, with one server log.
- Legacy `sessionIds` input (no `scope`): behaviour is unchanged, and labels
  come from `deps.listProjects` when present.

**rpc wiring (mount M-06-srv-1):** the handler passes the same snapshot
`tmux:list` reads (`rpc.mjs:1143-1148`):

```js
"opencode:search-messages": (input) =>
  searchMessages(input ?? {}, {
    listProjects: async () => {
      if (!syncState.everSucceeded()) await syncState.refreshNow();
      return syncState.snapshot().projects;
    },
  }),
```

### Q2 — Groups and labels computed by the box

**New pure export** `groupHits(hits, { primarySessionId, labels })` returns
`TranscriptHitGroup[]`:
- Hits are grouped by `sessionId` in first-appearance order (the hits are
  already scope-ordered).
- The `primarySessionId` group, if any, comes first with `isCurrent: true`.
- `label` is `"<workspace> › <name>"` when both are known, else the raw
  `sessionId`.

**Response** (additive — the flat `hits` stays, for old clients and CTO):

```jsonc
{ "supported": true,
  "hits":   [ TranscriptHit… ],      // unchanged, scope order
  "groups": [                        // NEW — ALWAYS present on a box with this change (even [])
    { "sessionId": "ses_…",
      "isCurrent": true,             // only the primarySessionId group
      "workspace": "manta" | null,   // tmux session name, null when the window is unknown
      "name": "fix login" | null,    // window name
      "label": "manta › fix login",  // or the sessionId when workspace/name is unknown
      "hits": [ TranscriptHit… ] } ],
  "truncated": true,                 // unchanged, optional
  "degraded": true }                 // NEW, optional — see Q3
```

Shared type (`src/shared/types.ts`, next to `TranscriptHit`):

```ts
export type TranscriptHitGroup = {
  sessionId: string; isCurrent: boolean;
  workspace: string | null; name: string | null; label: string;
  hits: TranscriptHit[];
};
```

`src/shared/api.ts` `opencodeSearchMessages` changes to:

```ts
opencodeSearchMessages(input: {
  query: string;
  scope?: "all";
  primarySessionId?: string;
  sessionIds?: string[];            // legacy — no renderer sends it after this change
}): Promise<{ supported: boolean; hits: TranscriptHit[]; groups?: TranscriptHitGroup[];
              truncated?: boolean; degraded?: boolean }>;
```

(`groups` is optional in the type because an older box omits it; that absence
is the capability signal below.)

### Q3 — Failed vs no matches

- In the `catch` at `messageSearch.mjs:92-97`, a non-`no_db` error (query
  error, worker trouble) now returns
  `{supported:true, hits:[], groups:[], degraded:true}`. The log line is
  kept.
- The `no_db` path (`supported:false`) and the empty-query path are unchanged,
  apart from carrying `groups: []`.
- Clients render `degraded` as a failure ("Couldn't search…"), never as "No
  matches".

### Errors (whole channel)

| Case | Response |
|---|---|
| Empty or whitespace query | `{supported:true, hits:[], groups:[]}` |
| Scope resolves to no sessions | `{supported:true, hits:[], groups:[]}` |
| No `node:sqlite` / no DB | `{supported:false, hits:[], groups:[]}` |
| DB/worker error, or `listProjects` failure / missing for `scope:"all"` | `{supported:true, hits:[], groups:[], degraded:true}` |
| Budget exceeded | hits + groups for what was found, `truncated:true` |
| Malformed input (non-string query, non-array sessionIds) | treated as empty → first row (never throws, as today) |

### Wire compatibility (D24) and the capability flag

- **Capability id: `search-scope-all-1`.** Appended to WS02's
  `src/server/boxCapabilities.mjs` by integration agent B in wave B (mount
  M-06-srv-2, master D25), so `/api/version` / `server:version` advertise it
  from this wave on.
- Both clients detect an older box with the response-shape probe, which is
  exact for this channel and costs no extra round trip (the capability id is
  still registered so WS11 D1 can gate the entry points through its store in
  wave D; any capability read in waves B/C goes through WS02's
  `boxCapabilities()` / `useBoxCapability`, never a WS06 copy):
  - A box with this change **always** returns `groups` (even `[]`).
  - An older box given `{query, scope:"all"}` with no `sessionIds` resolves an
    empty scope and answers `{supported:true, hits:[]}` with **no** `groups`.
- **Client behaviour on an older box:** if the reply has `supported:true` and
  no `groups`, render the "box too old" state: "Update your box to use
  search." on iOS, "Search needs a newer box — update your box to use this."
  on desktop. There is no fallback to sending `sessionIds` (D24: no copy of
  the old logic).
- An older desktop on a new box keeps sending `sessionIds`, which still works;
  it ignores `groups`/`degraded`.
- The CTO caller is unchanged.

### Node tests — `src/server/messageSearch.test.mjs` (extended)

Pure (no DB):
1. `resolveSearchScope`: primary first, then project/window order, deduped
   (the primary also present as a window is listed once).
2. `resolveSearchScope`: skips windows whose `opencodeSessionId` is null or
   empty; includes `owner:"job"` windows.
3. `resolveSearchScope`: a primary that no window carries is still first, with
   no label.
4. `resolveSearchScope`: labels map `tmuxSession`/window `name`.
5. `groupHits`: first-appearance order; current group first and `isCurrent`;
   no primary → no `isCurrent`.
6. `groupHits`: `label` is `"ws › name"`, or the sessionId when unknown;
   `workspace`/`name` are null when unknown.

With the existing V2 fixture DB (`createFixtureDb` / `withFixtureDb`, as in the
current budget test at line 277):
7. `scope:"all"` + injected `listProjects` (two projects, three windows, one
   job window) finds hits in every window; `groups` labels match.
8. `scope:"all"` without a primary: each session is capped at 3 (seed 5
   matching messages in the first session); with a primary, the primary gets up
   to 50.
9. Legacy `{query, sessionIds}` input still returns the same `hits` as before,
   plus `groups` (labels null without a `listProjects` dep).
10. Empty query → `groups: []` present.
11. `deps.runDbTask` that throws a plain Error → `degraded:true`, `hits:[]`,
    `groups:[]`; one that throws `{code:"no_db"}` → `supported:false`, with no
    `degraded`.
12. `scope:"all"` with `listProjects` throwing, or absent → `degraded:true`.

`npm run test:server` must pass. The existing `buildHits`/`likePattern` tests
stay untouched.

### Desktop migration (same change, no parallel implementation)

`src/renderer/SearchPalette.tsx`:
- **Delete:**
  - `groupHits` and the `Section` type (lines 30-54).
  - The `sessionIds` scope `useMemo` (lines 74-86).
  - The `ownerBySession` `useMemo` (lines 88-96).
  - The `flatSessions` import.
- **Replace** the call with
  `window.api.opencodeSearchMessages({ query: q, scope: "all", primarySessionId: sessionId })`.
- **New result state:** `{ kind: "idle" | "loading" | "results" | "empty" | "unsupported" | "boxTooOld" | "failed", groups, truncated }`,
  derived by an exported pure helper
  `classifySearchReply(res): { kind, groups, truncated }`:
  - `!res.supported` → `unsupported`.
  - `res.groups === undefined` → `boxTooOld`.
  - `res.degraded` → `failed`.
  - `groups` empty → `empty`.
  - Otherwise `results`.
  - The transport `catch` (today a silent swallow, lines 116-119) now sets
    `failed` instead of empty results. The sequence guard is unchanged (Q4
    stays client).
- **Rendering:**
  - `currentGroup = groups.find(g => g.isCurrent)`; other groups are the rest.
  - `SectionHeader` gets `workspace={g.workspace ?? undefined}` and
    `session={g.name ?? g.label}`.
  - Flat keyboard rows are built from the groups in order.
  - The footer counts `groups.length`.
  - New copy:
    - `failed`: "Couldn't search — edit the query to try again."
    - `boxTooOld`: "Search needs a newer box — update your box to use this."
    - `truncated`: "Showing the newest matches — this history is very large."
- **Jump (Q6, KEEP-CLIENT):** unchanged. It still uses `resolveSessionOwner`
  with the `projects` prop. If the owner is gone, it now shows "That
  conversation is no longer open." in the palette's message row instead of
  doing nothing (fixes the dead click at line 150).

`src/shared/types.ts`: add `TranscriptHitGroup`.
`src/shared/api.ts`: the input/response types above.
`src/renderer/api/httpApi.ts`: no change (pass-through).
`src/preload/*`: no change (the channel is unchanged; `demoCoverage.test.ts:191`
already lists `opencodeSearchMessages`).

**Vitest — new `src/renderer/SearchPalette.test.tsx`** (mock `window.api`,
pattern of the existing component tests such as `ActiveTodos.test.tsx`):
1. Sends `{query, scope:"all", primarySessionId}` after the debounce; never
   `sessionIds`.
2. Renders "This conversation" from the `isCurrent` group and the
   `workspace › name` header from a non-current group.
3. `degraded:true` → the failed copy, not "No matches".
4. A reply without `groups` → the box-too-old copy.
5. A transport rejection → the failed copy.
6. `classifySearchReply` table test (all six kinds).
7. Picking a hit whose session has no owner shows "That conversation is no
   longer open." and does not call `onJumpToWindow`.

`npm run typecheck` and `npm test` must pass.

### iOS today

There is nothing for message search yet.
- `SessionListView.swift:28,370-380,700-712` filters sessions by NAME only.
- Nothing in `mobile/native/` calls `opencode:search-messages`.
- The names `TranscriptHit` / `TranscriptHitGroup` / `SearchStore` are unused
  (grepped), so there are no collisions.

Reusable pieces:
- `MantaAPIClient.callRequired` / `jsonObject` (`MantaAPIClient.swift:954-982`;
  internal per C1).
- `SessionTimerFormat.age(_:)` (`SessionModels.swift:506,550-555`): a 1:1 port
  of desktop `formatAge` (device-clock formatting, KEEP-CLIENT). Use it for the
  hit age in the view.
- `SessionListStore.window(forSessionID:)` (WS04, `04-sessions.md:97`) for
  jump reachability (Q6, KEEP-CLIENT).
- `MantaAPIClient.live()` (`MantaAPIClient.swift:20`).

### iOS design

iOS **renders the box's groups**. It does not build a scope, group hits or
compose labels, and it never reads `SessionListStore.projects` for search.

New files, all owned by WS06:

| File | Imports | Contents |
|---|---|---|
| `MantaUI/SearchModels.swift` | **Foundation only** | Wire types, client copy (labels/plurals), the query state machine, the jump check. Added to `Package.swift` (D19). |
| `MantaUI/MantaAPIClient+Search.swift` | | The one RPC method. |
| `MantaUI/SearchStore.swift` | | A thin `@MainActor final class` that drives the state machine. |
| `MantaUI/SearchScreen.swift` | | The SwiftUI screen. |

**Presentation**
- `SearchScreen` is a sheet (`.presentationDetents([.large])`) with its own
  `NavigationStack`.
- Title "Search conversations", with a leading "Done" button that dismisses.
- The field is
  `.searchable(text:, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search in conversations…")`,
  focused on appear so the keyboard is up.
- A seeded query (from the session list) is placed in the field and searched
  immediately.

**List** (`.listStyle(.plain)`), one section per `TranscriptHitGroup`, in
server order:
- The group with `isCurrent == true` (first, when present) is headed "This
  conversation", with trailing count "N match" / "N matches"
  (`SearchCopy.currentCount`).
- An "Other conversations" divider header appears when there are non-current
  groups or a search is in flight.
- Each other group is headed by the server's `label`, on one line
  (middle-truncated, `tx3`), with a bare trailing count.

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
- `SearchCopy.footer(total: hits in groups, conversations: groups.count)` when
  there are hits.
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
| `.unsupported` (`supported:false`) | `ContentUnavailableView` (exclamationmark.triangle) | "Search needs a newer server runtime — update the server." |
| `.boxTooOld` (no `groups`) | `ContentUnavailableView` (arrow.down.circle) | "Update your box to use search." |
| `.failed(msg)` | `ContentUnavailableView` + "Try again" (re-runs the current query) | "Couldn't search — {msg}." `msg` is the error's message for transport/envelope failures, and "the box couldn't read its history" for `degraded:true`. |

**Query state machine (pure, `SearchModels.swift`).** Sequencing is
KEEP-CLIENT (Q4). It lives in a value type so cancellation and stale-result
rules are testable under `verify.sh`.

```swift
struct SearchQueryState: Equatable, Sendable {
  enum Phase: Equatable, Sendable { case idle, loading, results, empty, unsupported, boxTooOld, failed(String) }
  private(set) var phase: Phase = .idle
  private(set) var groups: [TranscriptHitGroup] = []
  private(set) var truncated = false
  private(set) var seq = 0                       // current request generation
  let primarySessionId: String?

  /// Text changed. Always bumps `seq` (invalidating anything in flight).
  /// Below min chars → phase .idle, groups cleared, returns nil.
  /// Otherwise → phase .loading (groups KEPT), returns the ticket to run.
  mutating func queryChanged(_ raw: String) -> SearchTicket?
  /// Re-run the last active query (Try again). Same rules as queryChanged.
  mutating func retry() -> SearchTicket?
  /// Apply a response; ignored unless ticket.seq == seq. Phase mapping:
  /// !supported → .unsupported; groups == nil → .boxTooOld;
  /// degraded == true → .failed("the box couldn't read its history");
  /// groups empty → .empty; else .results.
  mutating func receive(_ response: SearchResponse, for ticket: SearchTicket)
  /// Apply a failure; ignored unless ticket.seq == seq. CancellationError
  /// (or an NSError with code NSURLErrorCancelled — avoids URLError, which lives in
  /// FoundationNetworking on Linux) is ignored ALWAYS — an expected exit, never .failed.
  mutating func fail(_ error: Error, for ticket: SearchTicket)
  /// Sheet dismissed: bump seq so any late completion is dropped.
  mutating func invalidate()
  /// The request for a ticket: {query: ticket.query, scope: "all", primarySessionId}.
  func request(for ticket: SearchTicket) -> SearchRequest
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
  init(primarySessionId: String?, search: @escaping SearchFunction)
  func retry()
  func dismissed()          // cancels the task + state.invalidate()
}
typealias SearchFunction = @MainActor @Sendable (SearchRequest) async throws -> SearchResponse
```

- `queryDidChange` cancels the previous `Task`, then calls
  `state.queryChanged(query)`.
- If that returns a ticket, it starts a new `Task`:
  1. Sleep 120 ms. If the sleep throws, return.
  2. `try await search(state.request(for: ticket))`.
  3. Call `state.receive(_:for:)`, or `state.fail(_:for:)` in the `catch`.
- There is no other state write and no `catch {}`.
- `SearchScreen` calls `dismissed()` from `.onDisappear`.

**API extension** (`MantaAPIClient+Search.swift`)

```swift
extension MantaAPIClient {
  /// `opencode:search-messages` with `scope:"all"` — the box resolves the scope,
  /// groups and labels the hits (server-first, D23).
  func searchMessages(_ request: SearchRequest) async throws -> SearchResponse {
    try await callRequired("opencode:search-messages",
                           args: [jsonObject(request)], as: SearchResponse.self)
  }
}
```

### Pure logic (`SearchModels.swift`, Foundation only)

All of this is either a server-shape decoder or KEEP-CLIENT logic (Q4–Q6). The
round-2 `SearchScope`, `SearchScopeWindow`, `SearchLabel`, `SearchSection`,
`SearchGrouping`, `SearchCopy.header` and `SearchScope.fromProjects` are
**deleted from the plan**; the box does that work (Q1/Q2).

```swift
struct SearchRequest: Encodable, Equatable, Sendable {
  let query: String
  let scope: String                  // always "all"
  let primarySessionId: String?      // nil → key omitted
}
struct TranscriptHit: Decodable, Equatable, Hashable, Sendable {
  let sessionId: String; let messageId: String
  let role: String                    // "user"; anything else renders as assistant
  let pre: String; let match: String; let post: String
  let timeCreated: Double?            // ms epoch
  var isUser: Bool { role == "user" }
}
struct TranscriptHitGroup: Decodable, Equatable, Identifiable, Sendable {
  let sessionId: String; let isCurrent: Bool
  let workspace: String?; let name: String?; let label: String
  let hits: [TranscriptHit]
  var id: String { sessionId }
}
struct SearchResponse: Decodable, Equatable, Sendable {
  let supported: Bool
  let hits: [TranscriptHit]           // decoded but not rendered (old-client field)
  let groups: [TranscriptHitGroup]?   // nil = box predates search-scope-all-1
  let truncated: Bool?
  let degraded: Bool?
}
enum SearchCopy {                     // fixed labels and plurals only (Q5)
  static let minQueryChars = 2
  static func normalized(_ raw: String) -> String          // trimmingCharacters(in: .whitespacesAndNewlines)
  static func isActive(_ raw: String) -> Bool              // normalized count >= 2
  static func currentCount(_ n: Int) -> String             // "1 match" / "N matches"
  static func footer(total: Int, conversations: Int) -> String
  static func idleTitle(hasPrimary: Bool) -> String
}
enum SearchJump {                     // Q6, KEEP-CLIENT
  /// `owner` is SessionListStore.window(forSessionID:) bridged to a Bool.
  static func isReachable(sessionId: String, owner: (String) -> Bool) -> Bool
}
```

### XCTest — `MantaUITests/SearchTests.swift`

Foundation only. Added to `Package.swift` and runs under `verify.sh`. Scope
and grouping tests now live server-side (node tests 1-12 above). These are
decode tests of the server shape, plus KEEP-CLIENT logic.

1. `request_encodesScopeAll_andPrimary`;
   `request_withoutPrimary_omitsPrimaryKey` (encode to JSON and assert the key
   is absent); `request_neverSendsSessionIds`.
2. `request_trimsWhitespaceAndNewlines`: `"  foo \n"` → `"foo"`.
3. `decode_groups_fullShape` (isCurrent, workspace, name, label, hits);
   `decode_group_nullWorkspaceName`.
4. `decode_missingGroups_isNil` (old box);
   `decode_supportedFalse`, `decode_truncated`, `decode_degraded`,
   `decode_nullTimeCreated`, `decode_unknownRoleIsAssistant`.
5. `isActive_trimsAndRequiresTwoChars`: `"a"`, `" a "`, `"ab"`, `"a\n"`.
6. `copy_pluralisation`: "1 match" / "2 matches"; "1 result · 1 conversation"
   / "3 results · 2 conversations".
7. State machine:
   - `state_belowMin_isIdle_noTicket`
   - `state_staleResponseDropped`: ticket 1 is issued, then ticket 2; ticket
     1's response is ignored.
   - `state_staleFailureDropped`: ticket 1 fails after ticket 2 was issued;
     the phase stays `.loading`.
   - `state_cancellationNeverFails`: a `CancellationError` for the CURRENT
     ticket leaves the phase unchanged.
   - `state_clearWhileInFlight_staysIdle`
   - `state_invalidateDropsLateResult`
   - `state_errorBecomesFailed`, `state_unsupported`,
     `state_noGroups_isBoxTooOld`, `state_degraded_isFailedNotEmpty`,
     `state_emptyGroups_isEmpty`
   - `state_rendersServerGroupOrderVerbatim` (no client reordering)
   - `state_loadingKeepsPreviousGroups`
   - `state_retryReissuesLastQuery`
8. `jump_reachable` / `jump_unreachable`.

There are no Mac-only test files. `SearchStore` is a thin driver, and its
behaviour is covered by the state-machine tests.

### Acceptance criteria

- [ ] Typing at least 2 non-whitespace characters sends exactly one
  `opencode:search-messages` call per settled query (120 ms debounce), shaped
  `{query (trimmed), scope:"all", primarySessionId?}`, never `sessionIds`.
  Fewer than 2 shows the idle hint and sends nothing.
- [ ] Opened from a chat, that chat's results come first under "This
  conversation" with "N match(es)". Other chats follow under "Other
  conversations", each headed by the box's `label` ("workspace › name").
- [ ] Every chat window on the box is in scope, including background-job
  windows. This is decided by the box (node tests 1-3, 7).
- [ ] From the session list, no conversation gets more than 3 hits (box rule,
  node test 8).
- [ ] Matched text is visibly highlighted. User and assistant rows are
  distinguishable by glyph and caption. Age shows unless the box returned none.
- [ ] A box without the search runtime shows "Search needs a newer server
  runtime — update the server."
- [ ] A box that predates this change shows "Update your box to use search." on
  iOS and the "update your box to use this" note on desktop — no fallback
  search.
- [ ] A transport/RPC-envelope failure, OR a box-side `degraded:true`, shows
  "Couldn't search — …" with a working "Try again" (iOS) or the failed note
  (desktop), never "no matches".
- [ ] Typing fast never shows an error, and a late response or failure for an
  old query never replaces newer state. Clearing the field mid-search leaves the
  idle hint. Closing the sheet mid-search does nothing afterwards.
- [ ] `truncated:true` shows the "newest matches" note on both clients.
- [ ] The desktop palette contains no scope building or grouping code
  (`groupHits`, the scope `useMemo`, `ownerBySession` are gone) and passes the
  new vitest.
- [ ] `SearchTests` passes under `mobile/native/verify.sh` and the Mac
  `test-unit` gate; `npm run typecheck` and `npm test` pass.

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

`SearchScreen.init(primarySessionId: String?, seed: String = "", search: SearchFunction? = nil)`.
When `search` is nil it uses `MantaAPIClient.live().searchMessages`. The screen
needs no project list; the box resolves the scope.

1. **Chat nav bar** (mount M-06-1, applied by WS02):
   - A magnifyingglass toolbar button labelled "Search conversations".
   - It presents `SearchScreen(primarySessionId: store.sessionId)`.
   - It appears only on the main chat screen, never on the read-only subagent
     screen.
2. **Session list** (mount M-06-2, applied by integration agent B):
   - When the "Search sessions" capsule holds at least 2 trimmed characters,
     show a final row in the list reading "Search messages for “{text}”"
     (`text.magnifyingglass`). Show the same as a button in `noMatchState`.
   - It presents `SearchScreen(primarySessionId: nil, seed: trimmed)`.
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

**Server (WS06-owned edits):**
- `src/server/messageSearch.mjs`:
  - `searchMessages(input, deps)` gains `scope:"all"`, `primarySessionId`,
    `groups` and `degraded`.
  - New pure exports `resolveSearchScope` and `groupHits`.
  - New test seam `deps.runDbTask`.
- `src/server/messageSearch.test.mjs`: node tests 1-12.
- `src/server/rpc.mjs`: NOT edited by WS06. The handler change is mount
  M-06-srv-1.

**Desktop / shared (WS06-owned edits in wave B):**
- `src/renderer/SearchPalette.tsx`: migration above; deletes `groupHits`, the
  scope and owner memos and the `flatSessions` import; adds
  `classifySearchReply`.
- `src/renderer/SearchPalette.test.tsx` (new).
- `src/shared/types.ts` (add `TranscriptHitGroup`) and `src/shared/api.ts`
  (the `opencodeSearchMessages` input/response types): owned by WS02 in wave B
  (master D27), so these two hunks are ledger rows M-06-dsk-1 / M-06-dsk-2,
  applied by integration agent B last in the 02 → 07 → 09 → 06 order. WS06
  applies them locally (uncommitted) to verify.

**iOS (create, all owned by WS06):**
- `mobile/native/MantaUI/SearchModels.swift` (Foundation only)
- `mobile/native/MantaUI/MantaAPIClient+Search.swift`
- `mobile/native/MantaUI/SearchStore.swift`
- `mobile/native/MantaUI/SearchScreen.swift`
- `mobile/native/MantaUITests/SearchTests.swift` (Foundation only)

WS06 never edits `project.pbxproj`; the orchestrator regenerates it at the end
(D18).

Manifest for the integration step:
- App sources: the four Swift files above.
- `Package.swift` sources: `SearchModels.swift`.
- `Package.swift` test sources: `SearchTests.swift`.
- Server registration: M-06-srv-1, M-06-srv-2 (capability id).
- Desktop ledger rows: M-06-dsk-1, M-06-dsk-2.

## Mount requests

| ID | Receiving file | Applier (D18/D24) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-06-srv-1 | `src/server/rpc.mjs` | **Integration agent B**, server order 02 → 07 → 09 → **06** (last) | `searchMessages(input, deps)` (extended, `messageSearch.mjs`) | Replace the `"opencode:search-messages"` handler (`rpc.mjs:2016-2017`) with the version under "Q1 — rpc wiring" (passes `listProjects` reading `syncState`, as `tmux:list` does at `:1143-1148`). No import change: `searchMessages` is already imported (`:58`) and `syncState` is already a `buildHandlers` parameter (`:511`). | WS06's `messageSearch.mjs` change landed; the 02/07/09 server mounts applied first. |
| M-06-srv-2 | `src/server/boxCapabilities.mjs` (WS02) | **Integration agent B**, after M-06-srv-1 | `BOX_CAPABILITIES` (WS02) | Append `"search-scope-all-1"`; extend `boxCapabilities.test.mjs`'s expected ids. | WS02 SF-0 landed; M-09-srv-2 applied first |
| M-06-dsk-1 | `src/shared/types.ts` (WS02 owns in B, D27) | **Integration agent B** (desktop order 02 → 07 → 09 → 06) | `TranscriptHitGroup` (WS06) | Add the `TranscriptHitGroup` type (Q2) right after `TranscriptHit`. | WS02 desktop commit |
| M-06-dsk-2 | `src/shared/api.ts` (WS02 owns in B, D27) | **Integration agent B** | — | Replace the `opencodeSearchMessages` input/response types with the Q2 version. | M-06-dsk-1 |
| M-06-1 | `mobile/native/MantaUI/ChatScreen.swift` | **WS02**, wave B | `SearchScreen(primarySessionId:seed:search:)` | See the M-06-1 notes below the table. | WS06's files exist in wave B (symbols pinned here). C2 `.message` handling (WS02 F10; WS04 root handler). |
| M-06-2 | `mobile/native/MantaUI/SessionListView.swift` | **Integration agent B** | `SearchScreen(primarySessionId:seed:search:)`, `SearchCopy.isActive`, `SearchCopy.normalized` | See the M-06-2 notes below the table. | WS04 landed (wave A) and the WS06 files landed (wave B). Applied BEFORE WS09's M-09-2 on the same file (ledger order). |
| M-06-3 | `mobile/native/Package.swift` | **Integration agent B** | none | Add `"SearchModels.swift"` to `MantaUI` target `sources` and `"SearchTests.swift"` to `MantaUITests` `sources` (alphabetical). | WS06's files landed. |

**M-06-1 exact change** (`ChatScreen.swift`). **The provider signature changed
in the server-first revision:** the receiver calls
`SearchScreen(primarySessionId: store.sessionId)`. There is no `scope:`
argument and no `SearchScope` type any more; `SearchScope.fromProjects` and
`SearchScope.build(...)` no longer exist. WS02's receipt row M-06-1 and the
master ledger must be updated to this call.
- In `.toolbar` (`ChatScreen.swift:345-351`), before the "Session actions"
  ellipsis, add
  `ToolbarItem(placement: .primaryAction) { Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search conversations") }`.
- Add `@State private var showSearch = false`.
- Add
  `.sheet(isPresented: $showSearch) { SearchScreen(primarySessionId: store.sessionId) }`,
  or a case in the screen's sheet enum if WS02 has one.
- Only on the main chat screen (non-empty `sessionId`), not the subagent
  screen.
- `MantaNavigator` and `SessionListStore` are already in the environment
  (SearchScreen uses them for F2 only).

**M-06-2 exact change** (`SessionListView.swift`). This matches WS04's receipt
(§15, delegated to integration agent B) and the master's canonical mount
ledger, apart from the provider call, which is now
`SearchScreen(primarySessionId: nil, seed:)`.
- Add `case conversationSearch(seed: String)` to `SheetRoute`
  (`:1029-1041`), with id `"search:\(seed)"`. It renders
  `SearchScreen(primarySessionId: nil, seed: seed)`.
- When `SearchCopy.isActive(searchText)`, append a final row to `list` reading
  "Search messages for “\(SearchCopy.normalized(searchText))”" with the
  `text.magnifyingglass` icon.
- Add a same-labelled button in `noMatchState` (`:818+`).
- Both set
  `sheetRoute = .conversationSearch(seed: SearchCopy.normalized(searchText))`.

**Desktop renderer ledger (D24, D27):** `SearchPalette.tsx` (+ its test) is
edited by WS06 directly (no other wave-B editor). `src/shared/api.ts` and
`src/shared/types.ts` are WS02-owned in wave B; WS06's hunks are M-06-dsk-1/2
above. WS02's M-06-1 receipt and the master ledger now use
`SearchScreen(primarySessionId:)` (reconciled).

## Mounts applied by this workstream

None. WS06 owns no existing Swift file. I cross-checked the other specs' mount
tables in this folder: none targets a `Search*` file,
`MantaAPIClient+Search.swift`, `messageSearch.mjs` or `SearchPalette.tsx`.

## Client members

New `MantaAPIClient` members (in `MantaAPIClient+Search.swift`):
- `func searchMessages(_ request: SearchRequest) async throws -> SearchResponse`.
  This is the `opencode:search-messages` channel, and no other spec declares
  it.

Desktop `Api` member changed (types only): `opencodeSearchMessages` (input
gains `scope`/`primarySessionId`; response gains `groups`/`degraded`).

Consumed, owned elsewhere:
- `SessionListStore.window(forSessionID:)` (WS04).
- `SessionListStore.hapticsEnabled` (existing).
- `MantaNavigator.open(_:)` (C2, WS04).

## Contracts provided / consumed

- **C1**: adds `MantaAPIClient+Search.swift` with one member. It uses the
  internal `callRequired` / `jsonObject`.
- **C2 consumed**: calls `open(.message(sessionID:messageID:))` only. This
  needs WS02 F10 (same session) and WS04's root `.message` consumer (other
  session).
- **C4 consumed**: the chat nav-bar search mount (M-06-1), applied by WS02 per
  D18.
- **C7**: `MantaUITests/SearchTests.swift`; node tests in
  `messageSearch.test.mjs`; vitest `SearchPalette.test.tsx`.
- **D9**: "`maxPrimary: 3` without a primary" is now a server rule (Q1).
- **D19**: `SearchModels.swift` and its tests are Foundation-only and go into
  `Package.swift`.
- **D23/D24/D25**: Q1–Q3 are server-side; capability id `search-scope-all-1`
  (in `boxCapabilities.mjs`, M-06-srv-2) plus the `groups`-presence probe.
- C3, C5, C6: not used.

## Deferred

- **Matched-text highlight inside the target row after a jump** (D8). C2
  `.message` carries no query. WS02 highlights the whole row.
- **Keyboard navigation of results** (↑/↓/Enter) on iOS. Hardware-keyboard
  shortcuts are out of scope (master, "Desktop-only by nature").
- ~~Listing the capability id~~ — no longer deferred: `search-scope-all-1` is
  appended in wave B (M-06-srv-2). The `groups`-presence probe remains the
  clients' detection signal.

## Open questions

None. The two round-0 questions were settled by D8 (no query in the route) and
D9 (now implemented on the box).

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
     `.fromProjects(sessionStore.projects, primarySessionId: store.sessionId)` and the
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

## Review responses (server-first)

Audit items folded: **Q1, Q2, Q3** (all MOVE-NOW rows for WS06). Q4–Q6
remain KEEP-CLIENT per the audit.

- **Q1 (scope).**
  - The client-side scope builder is deleted from both clients' plans and
    code: iOS `SearchScope`/`SearchScopeWindow`/`fromProjects`; desktop's
    `sessionIds` memo.
  - `messageSearch.mjs` gains `scope:"all"` + `primarySessionId`, with
    `resolveSearchScope` reading the same `syncState` snapshot that
    `tmux:list` serves (mount M-06-srv-1).
  - The "no primary → cap 3" rule (D9) moved to the box.
  - The legacy `sessionIds` input stays accepted (old desktops, CTO engine).
- **Q2 (groups and labels).**
  - The response gains `groups[{sessionId, isCurrent, workspace, name, label, hits}]`.
  - iOS `SearchGrouping`/`SearchSection`/`SearchCopy.header` and desktop
    `groupHits`/`ownerBySession` are deleted.
  - Both clients render `groups` verbatim.
- **Q3 (failed vs no matches).** A DB/worker error now returns
  `degraded:true`. Both clients render it as a failure. The desktop's silent
  transport swallow becomes a visible failure too. The round-1/2 "inherited
  limitation" note is removed.
- **Wire compat (D24).** Additive only. Capability id `search-scope-all-1`
  (renamed to the master format and appended in wave B by M-06-srv-2 —
  reconciliation), with the exact `groups`-presence probe as the clients' signal.
  An old box gives "Update your box to use search." / "…update your box to use
  this."; there is no fallback.
- **Desktop.**
  - `SearchPalette.tsx` switched, with new `classifySearchReply` and a new
    `SearchPalette.test.tsx`.
  - Types updated in `src/shared/api.ts` and `src/shared/types.ts`.
  - The dead jump-to-closed-session click now shows a message.
- **Mounts.**
  - New M-06-srv-1 (`rpc.mjs`, integration agent B, last in 02 → 07 → 09 →
    06).
  - M-06-1 and M-06-2 now call `SearchScreen(primarySessionId:seed:)`, a
    signature change. **WS02's receipt row and the master ledger must be
    updated.**
  - M-06-3 is unchanged.
  - Reconciliation (master): WS02 receipt + ledger updated to
    `SearchScreen(primarySessionId:)`; capability id renamed
    `search-scope-all-1` and appended in wave B (M-06-srv-2); `types.ts` /
    `api.ts` hunks became IB rows M-06-dsk-1/2 (WS02 owns those files in B).
- **Tests.**
  - Node tests 1-12 added to `messageSearch.test.mjs`.
  - XCTest scope/grouping cases replaced by decode tests of the server shape.
  - The state machine gains the `boxTooOld` and `degraded` phases.
