# Code review — WS06 search (commit 6d19ae48)

Reviewer: Opus (main-session model). Scope: every file in `git show --stat 6d19ae48`
(13 files), each read in full, plus the not-yet-applied
`_appliers/ws06-appliers.diff`. Uncommitted WS09 work was ignored.

Checks run here (throwaway worktree of HEAD + `ws06-appliers.diff` applied):
- `git apply --check` of the appliers diff against HEAD: clean (offsets only).
- `tsc --noEmit -p tsconfig.web.json`: no error in any WS06 file (the one error,
  `ArtifactsPanel.tsx` `artifactsList`, is WS07's pending applier). `tsconfig.server.json`: clean.
- `node --test messageSearch.test.mjs ctoP0Fixture.test.mjs rpc.test.mjs`: 164 pass, 0 fail,
  0 skipped (node 22.22, `node:sqlite` present, so the fixture-DB tests really ran).
- `vitest run SearchPalette.test.tsx PaletteShell.test.tsx`: 17/17 pass.
- No Swift toolchain / `swift` Docker image on the box, so the iOS files were checked by
  reading: every consumed symbol grepped (`Tokens.scheme` + `tx2/tx3/tx4/accent/accentTx/
  accentSoft/warn/panel` in `generated/swift/Theme.swift`, `Metrics.spacing.sp1…sp5`,
  `Metrics.type.body/small/twoXS`, `Font.manta(size:weight:design:)`,
  `SessionHaptics.fire(_:enabled:)` + `.selection`, `SessionTimerFormat.age(_:)`,
  `SessionListStore.window(forSessionID:)` / `hapticsEnabled`, `MantaNavigator.open(_:)`,
  `MantaRoute.message(sessionID:messageID:)`, `MantaAPIClient.callRequired/jsonObject/live()`,
  `MantaError.authRequired/server/transport` — `MantaError.swift` is already in
  `Package.swift`, so `SearchModels.swift` stays Foundation-only). No name collisions
  for any new type. Deployment target 26.0 covers `searchFocused`, `ContentUnavailableView`.
- Seams: WS02's M-06-1 mount (`ChatScreen.swift:226,414,807`) calls
  `SearchScreen(primarySessionId: store.sessionId)` — matches. `.message` is consumed by
  `ChatScreen.consumeMessageRoute` (same session) and `SessionListView.handleRoute`
  (other session, left pending). CTO caller (`cto.mjs:408`) reads only `res.hits`; legacy
  path unchanged.

What is good: the server change is exactly the pinned Q1–Q3 contract — `resolveSearchScope`
/ `groupHits` / `projectsFromSyncState` pure and node-tested over a REAL `createSyncState`
(never-succeeded → degraded with the DB task never called; empty listing ≠ failure; stale
last-known-good used; refresh once). Legacy `sessionIds` input keeps its scope and caps
and only borrows labels, never `degraded`. `degraded` vs `supported:false` vs empty are
distinct on both clients. The desktop deleted `groupHits`/scope/owner memos and renders
`g.label` verbatim; the `PaletteShell` veto is one path for click and Enter, and the two
other consumers return `void`. The iOS state machine is a clean ticketed value type: every
post-`await` write goes through `receive`/`fail`, cancellation is never `.failed`, dismiss
invalidates. Jump opens only after the sheet is gone. No dead controls (Done, Try again,
hit rows all act; unreachable hit shows a notice on both clients).

---

### 1. SHOULD — iOS re-searches an unchanged query (trailing space, identical binding writes)

`mobile/native/MantaUI/SearchStore.swift:15-17` — `query`'s `didSet` calls
`queryDidChange()` on every write. `SearchQueryState.queryChanged` always bumps `seq` and
issues a new ticket, so typing a trailing space after "needle" cancels the in-flight
request, flips the list to "Searching other conversations…", and sends a second identical
`opencode:search-messages` call. The desktop keys its effect on the TRIMMED `q`
(`SearchPalette.tsx:113`) and does not. This breaks the acceptance criterion "exactly one
call per settled query" and wastes a full-history scan on the box.

Fix (keep `queryChanged`'s "always bumps" contract; dedupe in the driver):

```swift
@Published var query = "" {
    didSet {
        guard SearchCopy.normalized(oldValue) != SearchCopy.normalized(query) else { return }
        queryDidChange()
    }
}
```

### 2. SHOULD — a budget-truncated search with zero hits hides the truncation (iOS) / hides "No matches" (desktop)

The 8 s budget running out before anything is found (`{groups:[], truncated:true}`) is
exactly when "no matches" is least trustworthy, and the two clients each drop half of it:
- iOS `SearchModels.swift:224-227` settles `.empty` with `truncated = false`, and
  `SearchScreen.swift:113-115` shows only the system "No Results" — the AC "`truncated:true`
  shows the 'newest matches' note on both clients" fails on iOS.
- Desktop `SearchPalette.tsx:273-286` pushes the truncated note, so `nodes.length !== 0`
  and "No matches for “q”" is never shown.

Fix:
- iOS: `settle(.empty, [], response.truncated == true)`; in the `.empty` case render
  `ContentUnavailableView.search(text:)` and, when `state.truncated`, add
  `Text(SearchCopy.truncatedNote)` below it (e.g. a `VStack`, or
  `ContentUnavailableView { Label("No matches for “\(q)”", systemImage: "magnifyingglass") } description: { Text(SearchCopy.truncatedNote) }`).
  Add XCTest `state_emptyTruncated_keepsTruncatedNote`.
- Desktop: show "No matches for “q”" when `reply?.kind === "empty" && !searching`
  (instead of `nodes.length === 0`), before the truncated note. Extend the existing
  "an empty answer is 'No matches'…" vitest with `{groups: [], truncated: true}` asserting
  both strings.

### 3. SHOULD — the appliers diff omits M-06-srv-2 (capability id)

`_appliers/ws06-appliers.diff` carries M-06-srv-1, M-06-dsk-1 and M-06-dsk-2, but not
M-06-srv-2: appending `"search-scope-all-1"` to `BOX_CAPABILITIES` in
`src/server/boxCapabilities.mjs` (currently `["chat-cards-1"]`) and the matching expected id
in `boxCapabilities.test.mjs`. Without it `/api/version` never advertises the id WS11 D1 is
meant to gate on. Fix: add the two hunks to the diff (applied after M-07-S2 / M-09-srv-2
per the D24 order — if their context makes a hunk fragile, add an explicit line to
`_integration-notes.md` instead so integration agent B cannot miss it).

### 4. NIT — desktop keeps showing a previous failure while the next query loads

`SearchPalette.tsx:200-208`: `reply` is only reset when the query drops below 2 chars, and
the `unsupported` / `boxTooOld` / `failed` branches return before the `searching` row. After
a failed search, editing the query (which the copy tells the user to do) keeps showing
"Couldn't search — edit the query to try again." with no progress until the new answer
lands. Fix: gate those three early returns on `!loading` (results already keep their
groups while loading, as on iOS).

### 5. NIT — the commit alone turns desktop ⌘F into "Couldn't search"

The committed `SearchPalette.tsx` sends `{scope:"all"}`, while committed `rpc.mjs` still
calls `searchMessages(input ?? {})` with no `listProjects`, so every desktop search on this
branch answers `degraded:true` until M-06-srv-1 is applied. Expected under the D24 plan,
but integration agent B must apply M-06-srv-1 (and dsk-1/2) before any build of this branch
is used or released; worth a line in `_integration-notes.md`.

### 6. NIT — iOS failure reasons can surface internal strings

`SearchModels.swift:131-142`: `MantaError.transport` text is shown verbatim, e.g.
"Couldn't search — opencode:search-messages returned no result." / "…invalid rpc envelope.",
and a `DecodingError` falls to "check the connection", which is the wrong advice. Spec allows
the raw message; consider mapping transport/decoding failures to "the box sent an answer
this app can't read" and keeping verbatim text only for `MantaError.server`.

### 7. NIT — CTO search reports a degraded search as zero hits

`cto.mjs:412` maps only `hits`, so a box-side failure now marked `degraded:true` still
reads to the model as "no matches". Out of WS06 scope (caller pinned unchanged); follow-up:
pass `degraded` through as `ok:false` or a `degraded` field.

---

Counts: 0 BLOCKING · 3 SHOULD · 4 NIT.

VERDICT: APPROVE
