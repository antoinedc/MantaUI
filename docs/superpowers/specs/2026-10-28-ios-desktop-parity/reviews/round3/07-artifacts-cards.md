# Round 3 — 07-artifacts-cards

## Round-2 findings verified

1. **Resolved — launcher API.** WS07's M-04-2 now uses `AvailableLauncher`, optional mode, the catalog, and both selection/retry callbacks. Its receipt agrees with WS04 M-04-2/M-04-5 (`04-sessions.md:1353,1356`), WS02's caller (`02-chat-cards-queue.md:905`), and the master's canonical M-04-2 signature. The read-only gate is consistent across the ledgers.

2. **Resolved — artifacts initializer and feedback ownership.** M-07-1 passes `composer`, explicitly excludes `onAttach`, and leaves attachment feedback and successful dismissal inside the card. WS02 now consumes exactly that contract (`02-chat-cards-queue.md:908-909`). Deferred jump handling is retained. The canonical ledger and shared member registry agree.

3. **Resolved — temporary-file cleanup.** F6 retains the URL in `.saved`, returns `AgentFileEffect` from timer completion, and gives presentation callbacks their captured URL. Its transition rules now specify cleanup for completion, cancellation, dismissal, and stale results. The revised pure-machine and Xcode-only store tests cover cleanup effects and actual file removal.

4. **Resolved — attachment visibility in read-only jobs.** F4 observes `acceptsInput`, hides the action when false, guards before starting work, and rechecks after upload. Rejections use the controller's typed reason. This matches WS03's declared controller/rejection API and the canonical M-03-7 binding (`03-composer.md:510-511,524,538,669`).

5. **Resolved — mount IDs and placement.** Incoming rows now use M-01-5, M-02-2, M-04-1 and M-04-2. Rename is optional and before Compact on both sides (`04-sessions.md:1352`); the display toggle and read-only guard match their providers (`01-transcript.md:1483`, `02-chat-cards-queue.md:886`).

## Additional checks

No new findings. M-07-1/2 remain WS02-owned mounts; M-07-3/4 go through integration agent B. The package manifest explicitly depends on WS03's pure insertion types and excludes API/UI/store tests. The three client members match the shared registry without duplicate ownership. The revised cleanup and attachment contracts preserve the previously resolved credential isolation, visible failures, haptic gating, and modal-retention behavior.

Counts: BLOCKING 0 · SHOULD 0 · NIT 0.

VERDICT: APPROVE
