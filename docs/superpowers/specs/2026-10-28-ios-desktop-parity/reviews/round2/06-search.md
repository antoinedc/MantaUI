# Round 2 — 06-search

## Round-1 disposition

- **#1 resolved (ownership/timing):** D18 and M-06-1 now assign the chat mount to WS02; WS02's receipt table accepts it. The session-list and package mounts consistently belong to integration agent B. A new signature mismatch in the receipt is reported below.
- **#2 resolved:** the field retains raw text, while `SearchCopy.normalized` / `SearchScope.request` trim whitespace and newlines; the revised encoding test pins that behavior, matching `src/renderer/SearchPalette.tsx:70,113`.
- **#3 resolved:** the pure state machine guards both success and failure by generation, ignores cancellation, invalidates on clear/dismissal, and lists the corresponding tests.
- **#4 resolved:** failure acceptance criteria now distinguish transport/envelope errors from the inherited successful-empty DB/worker response (`src/server/messageSearch.mjs:92–97`).

## Findings

1. **BLOCKING — Mount requests M-06-1 / WS02 Mounts applied: receiver calls a removed signature.** WS06 now correctly keeps its Foundation-only scope builder independent of `MantaProject`, but WS02's exact mount still calls `SearchScope.build(projects:primarySessionId:)`. That overload is no longer provided, so implementing the receiver table literally will fail the integrated iOS build. **Evidence:** `06-search.md:322` declares only `build(windows:primarySessionId:)`; `06-search.md:504–505,558,568` pins the app adapter as `fromProjects(_:primarySessionId:)`; `02-chat-cards-queue.md:799` still requires `build(projects: ...)`. **Concrete fix:** update WS02's receipt to ID `M-06-1` and use `SearchScreen(scope: .fromProjects(sessionStore.projects, primarySessionId: sessionId))`, exactly matching WS06. Keep the adapter in `SearchScreen.swift`; do not reintroduce a `MantaProject` dependency into the Linux-tested models file.

## Other cross-spec checks

- WS04's session-list receipt (`04-sessions.md:1327`) delegates the search entry to integration agent B and references WS06's exact change; WS09's same-file mount (`09-models-usage.md`, M-09-2) also serializes through that integration agent.
- M-06-3's package manifest follows D18/D19. WS06 applies no mounts to another worker's files.
- `searchMessages(_:)` has no duplicate declaration in the other specs' client-member contracts. WS04 provides the consumed `window(forSessionID:)` (`04-sessions.md:97,1352`); its `.message` handler leaves the route pending for WS02 (`04-sessions.md:1104–1108`).

VERDICT: CHANGES REQUIRED
