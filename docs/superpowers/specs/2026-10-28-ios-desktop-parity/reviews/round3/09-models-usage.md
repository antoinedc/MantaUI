# WS09 review — round3

No outstanding or new findings. BLOCKING: 0; SHOULD: 0; NIT: 0.

## Round-2 verification

1. **Resolved — client rebinding.** “Box lifecycle” now replaces the singleton clients using one credentials snapshot, captures its token alongside its URL, invalidates the old binding, and rejects old-generation responses. This addresses the fixed-URL/dynamic-token behavior in `mobile/native/MantaUI/MantaAPIClient.swift:3-21` and the retained client in `ChatModelCatalog.swift:30-37`. Required tests cover first pairing, box switching, request host/authorization pairing and late responses.
2. **Resolved — stopped timestamp contract.** The master's Shared member registry and Reconciliation log now bind both timestamps to epoch-millisecond `Double` values. WS04 §9/Contracts and WS09 F6 consistently provide/consume `stoppedLastLooked: Double?` and `stoppedAt: Double`; the adapter copies into `stoppedAtMs` without conversion. This matches the numeric store values in `src/server/stoppedStore.mjs:274-289`.
3. **Resolved — package-visible resume input.** `UsageStoppedEntry` is declared in Foundation-only `UsageResumeLogic.swift`. Only the WS04 adapter extension and views remain in `UsageResumeSheet.swift`. M-09-7 explicitly includes the logic and tests while excluding the sheet, consistent with the explicit-source package at `mobile/native/Package.swift:37-59`.
4. **Resolved — mount ledger.** WS09 acknowledges M-08-1 and its reload test, and M-03-5 with the agent retry members/test. M-09-5 matches WS02's receipt. M-09-1…7 match the canonical ledger, including WS04's count/reset contracts, WS08's accepted price link, and integration-agent ownership. The client inventory agrees with the master's Shared member registry; no duplicate client member was found in the counterpart specifications.
5. **Resolved — unsupported identification refresh.** F4's `declareOutcome` consumes the complete `UnidentifiedList?`. Only a supported response with the key absent establishes resolution; unsupported responses produce `.catalogueUnavailable`, preserve the successful-write distinction, and have a specified regression test. This respects the catalogue degradation contract in `src/server/modelCatalog.mjs:18-24`.

The revised binding helper, package manifest, agent-retry addition, and mount receipts introduce no further blocking discrepancy found in this review. This approves the implementation specification; it does not claim implementation or test execution.

VERDICT: APPROVE
