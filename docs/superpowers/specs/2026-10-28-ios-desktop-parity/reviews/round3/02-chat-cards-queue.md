# WS02 review — round3

## Round-2 disposition

1. **Resolved — WS01 integration.** F11 and receipts M-01-1–4 now use `entries(for:)`, `$sessions`, `liveMediaTail(messages:live:isLiveWindow:)`, and the shared `presentedMessages` slice. Truncation suppression depends on `footerTruncationMessageIDs`, not mere message presence. The master reconciliation explicitly settles the fallback as the existing single `truncation` converted to `TranscriptLiveTruncation`; WS01's current receipts agree. Tests include incomplete snapshots and unknown truncation kinds retaining their notice.

2. **Resolved — provider signatures and draft transport.** The canonical ledger and WS02 receipts now agree with WS06's `fromProjects`, WS07's `composer:` artifact parameter, WS04's static window-key builder and launcher catalog/retry parameters, and WS09's M-09-5 identifier. The master explicitly supersedes M-04-7 with WS03's `ChatScreen(draft:)` adoption; WS04 consumes that same transport. WS07's mode receipt now uses `AvailableLauncher` and the full initializer. WS02's four client methods match the shared member registry without duplicate ownership.

3. **Resolved — server errors releasing held prompts.** F6 retains the current policy for every failure class; only a successful job-list result can allow sends. This matches the actual distinction between `MantaAPIClient.swift:923–929` error-envelope handling and the successful no-engine `{jobs: []}` fallback at `src/server/rpc.mjs:2434–2435`. The new resolving feedback provides Retry, and test 17 explicitly requires server errors to deliver nothing.

4. **Resolved — Load earlier resetting the focus window.** F10 now specifies a distinct `loadEarlierWhileFocused()` operation that preserves fetched messages and their limit, reveals the local prefix without refetching, and invokes normal widening only at index zero. Test 19 covers both branches.

5. **Resolved — highlighting a different message and misleading cap errors.** F10 checks whether the target itself maps to visible blocks with the same options before assigning a highlight. Unfinished/empty targets receive explicit feedback rather than highlighting their successor. Cap exhaustion is now `.tooFarBack`, separate from exhausted-history `.notFound`, with tests for both.

## New-problem and integration check

No new findings. Checked the revised F6/F10/F11 contracts and incoming/outgoing mount tables against the master's canonical ledger, shared member registry, reconciliation log, and the corresponding WS01/03/04/06/07/09 provider declarations. M-03-7 now synchronizes composer writability; read-only overflow restrictions also include Rename and Mode. The approved specification still requires the stated implementation-time Swift/Linux tests and simulator verification; this review does not claim those have run.

BLOCKING: 0 · SHOULD: 0 · NIT: 0

VERDICT: APPROVE
