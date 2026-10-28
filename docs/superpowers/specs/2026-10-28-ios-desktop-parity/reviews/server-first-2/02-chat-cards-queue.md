# WS02 review — server-first-2

Specification review against the current worktree, master D23–D30 and the revised WS11. No implementation, build or runtime verification is claimed.

## Previous findings

| Previous finding | Disposition |
|---|---|
| 1 — Desktop consumer chain | Resolved. The migration now carries retry fields through the hook projection and state types, carries compaction/notice fields, replaces every listed SessionHeader use, and extends both approval result declarations. Distinctive hook-to-card values and an approval-refusal test are required. |
| 2 — Old-box inbox actions | Resolved in the behavior contract. F8 and the desktop migration gate all four controls and their callbacks/store entry points; the keyboard pop-last path is included. Known absence and unknown capability are distinguished. Test detail could be tightened as noted below. |
| 3 — Cancelled without item | Resolved. SF-5 defines a successful-cancellation/text-unavailable notice for restore requests and all-null report fields for non-restore cancellation. Pure and RPC tests cover both branches. This matches the optional item returned by `src/server/streamInterp.mjs:619–625`. |
| 4 — Guarded-mutation coverage | Resolved. SF-4 requires all five channels through the HTTP handler, exact 409 bodies, zero downstream calls on refusal, ordinary/work-session pass-through, async compact return preservation and the existing HandoffError branch. |
| 5 — Mount IDs | Resolved. SF-4 cites 6/7/8 plus registration 10; SF-5 cites 9. The detailed rows agree with the master's canonical ledger. |

## Findings

1. **SHOULD — Desktop migration: preserve the local token-formatter binding.**
   - **Problem:** The proposed `export { formatTokens } from "../shared/formatTokens.mjs"` preserves exports for other modules but does not bind `formatTokens` inside `chatUtils.ts`. One retained function still calls it. This is a small implementation detail to make explicit alongside the new `formatTokenCount` import, rather than another architectural blocker; the mandated typecheck will also catch it.
   - **Evidence:** `02-chat-cards-queue.md:1010` specifies the re-export; `src/renderer/chatUtils.ts:3248` calls `formatTokens(tokens)` inside `workingIndicatorLabel`. That function is not in WS02's deletion list.
   - **Fix:** Specify `import { formatTokens, formatTokenCount } from "../shared/formatTokens.mjs"; export { formatTokens };` (or an equivalent local import plus re-export). Keep the existing working-indicator tests exercising a positive token count.

2. **SHOULD — Tests: spell out the expanded capability-gate matrix.**
   - **Problem:** The behavior was fixed, but the desktop test row references “finding-2 cases below” without an explicit case matrix, and iOS test 21 still names only Edit last. This leaves the important row-action and keyboard protections less directly checkable than the revised contract.
   - **Evidence:** `02-chat-cards-queue.md:1025` references those cases; `:1219–1220` retains the narrow iOS capability test. The actual retained desktop entry paths are `src/renderer/ChatPanel.tsx:909–923` (row callbacks and `queuePopRef`), and iOS has independent mutation methods at `mobile/native/MantaUI/ChatSessionStore.swift:1429–1465`.
   - **Fix:** Require absent and unknown capability tests for ×, Send now, Wait and Edit last on both clients: disabled controls, zero RPC calls when entry points are invoked, and the update note only for known absence. Include desktop `onQueuePop` returning false with zero cancellation calls, then a capability-present case proving the same actions still execute and render server feedback.

## WS11 compatibility check

- **Capabilities:** WS11 D1 explicitly migrates discovery from the wave-B RPC accessor to upgrade-exempt `GET /api/version`, preserves WS02's desktop hook, and deletes the iOS accessor/store only after migrating their consumers. WS02 supplies the required capability field on both endpoints. The staged change is consistent with D25; it does not require WS02 to introduce a competing accessor. The exemption distinction is confirmed by `src/server/upgradeV2.mjs:82–90`.
- **Job lookup:** WS11 D7 needs raw delegate relationships beyond WS02's read-only presentation result. Its Files section explicitly assigns an additive export in `delegateView.mjs` to WS11; it does not require WS02's `DelegateJobView` to acquire raw-record fields or change its wire shape. WS11 preserves `delegate:list` labels/summary and the Background Jobs sheet.
- **Token formatting:** WS11 D4 consumes the D26 shared formatter; it introduces no replacement module. The local-import clarification above preserves that single implementation.
- **Transcript consumers:** WS11 explicitly inventories WS02's mapper receipts, preserves their signatures except for named in-step migrations, updates the live-truncation factory and its ChatSessionStore caller together, and retains the slimness preference/refetch contract. Its D8–D11 section also requires updating WS02's relevant store tests. No additional WS02-provided symbol is assumed without an assigned migration.
- **Ownership:** The revised server mount order and shared-file ownership remain consistent with integration B; WS11's later direct edits occur alone in wave D.

No remaining BLOCKING findings.

VERDICT: APPROVE
