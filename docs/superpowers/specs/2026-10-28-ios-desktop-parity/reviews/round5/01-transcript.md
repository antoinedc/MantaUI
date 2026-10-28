# WS01 review — round5 confirmation

## Round-4 disposition

- **#1 resolved:** `turn` / `inCurrentTurn`, `currentTurn` / `turnOpen`, `observeRunning` and `vended` are declared with population rules. The store subscribes to the existing published session-state running observations. Verified against `mobile/native/MantaUI/MantaEventStore.swift:184-202,399,584-586`. The reducer/store path tests cover first-frame ordering and subsequent turns. No undeclared timestamp or new snapshot input remains.
- **#2 resolved:** canonical absorption is identity-based render replacement, not deletion on owner presence or settlement. Pending and failed entries remain available under loaded owners; earlier-turn entries with absent owners do not enter a new tail. The placement table, bounded earlier-turn eviction and reducer-driven tests specify these cases.
- **#3 resolved:** F4's reload-persistence acceptance now explicitly requires canonical finish metadata.
- **Integration confirmed:** WS01 M-01-1…4 match the master canonical ledger/shared registry and WS02's receiving rows (`02-chat-cards-queue.md:898-901`). `entries(for:)`, `$sessions`, `liveMediaTail(messages:live:isLiveWindow:)` and the footer-suppression contract are unchanged. The turn counter is internal to the existing store publication, so no additional receiving mount is required.

## Findings

1. **NIT — F1, “One message list, disjoint segments.”** A leftover sentence still says a historical focus slice “never shows the live tail's media,” contradicting the immediately preceding corrected Historical focus paragraph and placement table, which intentionally allow current-turn media at the end of a focused suffix. **Evidence:** `01-transcript.md:494-507`; WS02 F10 defines the slice as `Array(messages[index...])`, retaining the latest message. **Concrete fix:** delete the obsolete sentence or replace it with “Earlier-turn entries whose owners are outside the presented list are not rendered.” The explicit placement table already gives an implementable rule, so this is not blocking.

No blocking issue found in the confirmation changes.

VERDICT: APPROVE
