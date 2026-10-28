# WS05 review — round3

## Round-2 findings verified

1. **Resolved — probe/client names.** WS05 now consumes `forgeProbe() -> ForgeProbeResult`, and explicitly prohibits the obsolete alias. WS04's provider and reuse table agree; device methods remain WS04-owned and WS05 presents only the shared view. Evidence: `05-git-pr-review.md:51,845-846,1047-1052`; `04-sessions.md:1322-1325,1336-1340`; master shared member registry, `00-master.md:449-450`.

2. **Resolved — read-only mount receipt.** The canonical M-03-7 binding now appears in both requester and receiver: on appear and every change, `composer.acceptsInput = !store.isBackgroundJobReadOnly`. WS05 additionally receives the canonical read-only flag directly, hides insertion actions, and rechecks writability when invoked. The integration tests cover policy changes with a real composer. Evidence: `03-composer.md:669`; `02-chat-cards-queue.md:451-454,867-870,902`; `05-git-pr-review.md:264-300,969`; master ledger `00-master.md:392,403`.

3. **Resolved — shared sign-in lifecycle.** WS04 now specifies async cancellation awaited before the dismissal callback, logged cancellation failure in the live adapter, a generation token guarding the start itself, and a foreground wake channel that cannot start another loop. Its five added lifecycle tests match WS05's required cases. Evidence: `04-sessions.md:630-652,685-705,746-752`; `05-git-pr-review.md:573-614`; master reconciliation `00-master.md:500-502`.

## Revision and integration check

No new findings. M-05-1 through M-05-4 agree with the canonical mount ledger, including wave-C application and the separate package integration step. Shared API member names and ownership agree with the registry. The previous merge-snapshot, ship-preview invalidation, thread-coordinate and busy-dismissal fixes remain specified. Inbox creation still uses the confirmed WS04 flow, with the issue-stamp deferral explicitly authorized by D12.

Counts: BLOCKING 0 · SHOULD 0 · NIT 0.

VERDICT: APPROVE
