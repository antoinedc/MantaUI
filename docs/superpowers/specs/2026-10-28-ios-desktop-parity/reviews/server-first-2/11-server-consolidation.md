# WS11 server-first-2 review

Reviewed the revised spec, its response table and library choice against the master D23–D30, audit, and current server/desktop/Swift sources. Source review only; no builds or tests run.

## Previous findings

| server-first # | Resolution |
|---|---|
| 1 | Resolved: authenticated `/api/version`, explicit failure state, and upgrade recovery independent of discovery. |
| 2 | Concurrent allocation resolved by `async-mutex`; the added cleanup and concurrency test need corrections below (1, 7). |
| 3 | Authoritative live source resolved; reconnect relationship hydration remains incomplete (2). |
| 4 | Resolved: live hint/label carried through footer, honest old-box fallback. |
| 5 | Router and prose anchors resolved; reasoning placement and partial canonical handover remain incorrect (3, 4). |
| 6 | Execution-boundary rule resolved; asynchronous delivery classification still permits wrong membership (5). |
| 7 | Same-epoch revision ordering resolved; cross-epoch acceptance still regresses state (6). |
| 8 | Resolved: descriptor-relevant output retained internally, generated-name fixture specified. |
| 9 | Resolved: wording-only delegate helper explicitly deleted; retained status members and compile gates identified. |
| 10 | Resolved: partial outcomes, warnings, deduplication and client feedback specified. |
| 11 | Resolved: full/reference union, placement ownership, self-contained splices and synthetic byte guard specified. |
| 12 | Resolved in normative ground rules: release-atomic D8+D9, stage-aware registry and per-step gates. |

`async-mutex` is an appropriate scoped dependency for the critical section; replacing it is not required by this review.

## Findings

1. **BLOCKING — D5 external-collision cleanup can delete a caller-owned conversation.**
   - Problem: the new error carries a `sessionId`, and both explicit-name collision and exhausted retries delete it unconditionally. The existing API also accepts `existingSessionId`; that is not a session allocated by this attempt. A duplicate tmux name must not delete the supplied conversation and its history.
   - Evidence: spec D5 lines 635–649; `src/server/tmux.mjs:508,521–534` explicitly reuses `existingSessionId` before creating anything; `src/shared/api.ts:983` exposes that input; `src/server/tmux.test.mjs:300–320` tests reuse of a preexisting session.
   - Fix: carry allocation ownership separately from the id, preserve it across retries, and delete only a session created by this create operation. Supplied ids survive every failure. Add explicit-name collision and retry-exhaustion tests with a supplied id, asserting no deletion, alongside cleanup tests for newly allocated ids.

2. **BLOCKING — D7 reconnect hydration treats a bounded, directory-filtered listing as the complete child graph.**
   - Problem: replacing `parentOf` using `listSessions(directory)` for live tmux workspace directories drops legitimate windowless ancestors/children outside those listings. That method also caps at 500 newest sessions. An older parent edge can disappear while its descendant is actively running, making the parent incorrectly idle after reconnect. Absence from this partial enumeration is not proof of removal.
   - Evidence: spec D7 lines 851–859 explicitly drops absent edges; `src/server/opencode.mjs:850–873` limits enumeration to five pages and forwards the directory filter. V2 session moves change directory (`opencode.mjs:343–365`); session-parent state is independent of whether a tmux window exists (`streamInterp.mjs:909–915`). D7 expressly promises windowless descendants at any depth.
   - Fix: hydrate a complete relevant ancestry closure, e.g. fetch each active session and recursively resolve parent ids, retaining required relationships across directories, or use a genuinely complete paginated graph read. Distinguish incomplete/failed hydration from authoritative deletion. Test an active grandchild whose parent is beyond page five and a windowless child in another directory; reconnect must preserve ancestor busy state.

3. **BLOCKING — D11's live layout cannot place reasoning between the segments of one run.**
   - Problem: for tool A → reasoning R → tool B, the ledger opens one run and appends one reasoning block. B joins that same run, so the specified layout is `[run A, reasoning R]`. `liveTail` draws the whole run at its entry; even expanding its segment array there places B before R. No placement entry locates segment B after R. The named parity test therefore cannot pass with reasoning visible.
   - Evidence: spec D11 rules 5/8 and lines 1460–1474 (one run entry on open), 1502–1516 (whole-run rendering); `mobile/native/MantaUI/ToolActivity.swift:723–735` currently closes the visible group around shown reasoning. The spec's identity section requires each visible segment to retain its own first-part id.
   - Fix: supply ordered segment placements (run id plus segment id) interleaved with reasoning, and explicitly define how hidden-reasoning layout collapses them into one run. Reuse that ordering for canonical and live layout. Test A → R → B with reasoning both on and off, including toggling while streaming; visible order must be segment A, R, segment B, with stable ids.

4. **BLOCKING — D11 skips a live run whenever any canonical portion of it is present.**
   - Problem: `liveTail` skips a block if its id already exists canonically. A canonical run can be only partially covered: tool A is settled, then a transparent background completion starts another execution and tool B joins run A. The initial canonical fetch contains A; subsequent frames contain A+B, but the whole live run is skipped. Since iOS does not refetch mid-turn, B and its raw disclosure are absent until completion. Updating the summary alone does not add B's part to the canonical row.
   - Evidence: spec lines 975–982 and 1502–1516; D11 rules 3/8 deliberately allow cross-execution continuation. `mobile/native/MantaUI/ChatModels.swift:230–236` builds canonical layout from settled messages. The existing `ToolRun.appending` (`ToolActivity.swift:612–634`) merges new parts into an existing run rather than dropping them solely because the run id matches; D11 removes its old merging path.
   - Fix: specify an upsert into the canonical placement row for a partially canonical run: merge parts by stable part/call id and apply the latest run view without duplicating the row. Only discard a live block when its relevant content/revision is fully covered, not merely when its id exists. Test settled A → transparent user delivery → streaming B before final refetch, and mixed settled/unsettled messages within one run.

5. **BLOCKING — D11 applies an asynchronously discovered user boundary after later tools have already joined the wrong run.**
   - Problem: when an unknown inbox item is delivered, the ledger holds the previous run open while `classifyDelivered` fetches it. Tool B can arrive in that interval and be assigned to old run A. If the fetch later identifies a drawing user message, closing/resetting at resolution time cannot undo that assignment correctly; it may also discard B. The boundary belongs before B, not at the time the lookup finishes.
   - Evidence: spec lines 1452–1459 and test script (6) at 1611–1613; `src/server/streamInterp.mjs:790–795` processes delivery synchronously and later events continue arriving independently. The existing inbox hydration code (`streamInterp.mjs:520–568`) explicitly buffers/replays events for this same asynchronous ordering problem.
   - Fix: buffer subsequent run-affecting events behind an unresolved boundary and replay them in event order after classification, or specify an equivalent deterministic rebuild before emitting memberships. Define failure/reconnect invalidation, and use enough delivered-content data to distinguish synthetic/ignored text, not just text and attachment count. Test a delayed classification with B already received, then both drawing and transparent results; assert exact canonical run ids, ownership and no lost parts.

6. **BLOCKING — D11 accepts stale responses from a retired process epoch as new state.**
   - Problem: `epoch differs → incoming wins` cannot distinguish a restarted server from a delayed response from the previous server. A pre-restart RPC response with epoch E1 arriving after the reconnect snapshot E2 replaces E2, contradicting the promised non-regression. The same rule can flip the map back and forth between epochs. UUIDs have no temporal ordering.
   - Evidence: spec lines 1382–1398; `src/server/streamInterp.mjs:210` supplies a random UUID epoch. Both canonical responses and stream frames are explicitly fed into this reducer in arrival order. The proposed test only covers an older sequence in the same epoch.
   - Fix: establish the current epoch through an authoritative connection/snapshot generation and reject results from retired epochs; invalidate requests issued under an older connection generation. Do not treat arbitrary RPC responses as permission to change epoch. Pin the policy for full snapshots as well as incremental updates on both clients. Test E1 fetch starts → E2 reconnect snapshot → E1 fetch resolves; E2 must remain authoritative.

7. **SHOULD — D5's required mutex test deadlocks the correct implementation.**
   - Problem: the fake `listSessionNames` resolves only after both callers reach its barrier, but that call is inside `runExclusive`. The second caller cannot reach it until the first releases the mutex; the first cannot release until the second reaches it. Correct serialization therefore hangs the proposed test.
   - Evidence: spec D5 lines 624–629 puts the read inside the lock; lines 702–705 requires both calls to reach the read barrier.
   - Fix: hold the first request inside the fake read/create using a test-controlled latch, start the second request, assert it has not entered the critical section, release the first, and then await both results. Assert distinct final names, correct metadata, and no overlapping critical sections. Keep external-collision tests separate.

VERDICT: CHANGES REQUIRED
