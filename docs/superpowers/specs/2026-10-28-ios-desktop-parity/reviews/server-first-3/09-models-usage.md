# WS09 — server-first-3 confirmation

Confirmation of the four server-first-2 findings only. No implementation changes or tests executed.

1. **Previous BLOCKING — alert hydration: resolved.** SF-M16 now buffers deltas during hydration and replays them over the authoritative snapshot, rather than discarding the snapshot. Request epochs, boot-change/gap recovery, bounded buffering and retries are specified (`09-models-usage.md:751–793`). Both clients adopt this contract; tests explicitly cover the previously failing A/B case, retirement races, late responses and restarts (`:1833–1845`).

2. **Previous BLOCKING — downstream default/catalogue refresh: resolved.** SF-M1 explicitly requires config synchronization, raw catalogue/default/picker refresh and immediate writer-side reconciliation (`:332–350`). The registration now injects `configUpdateSynced`, including `syncState.applyConfig(next)` (`:2061–2085`). The desktop App subscription and Models card refresh are pinned, with mounted-composer and cross-device tests (`:868`, `:883`, `:905–913`). This matches the existing config-consumption path in `src/renderer/store.ts:1063–1075` and catalogue refresh entry point in `src/renderer/modelCatalog.ts:120–123`.

3. **Previous SHOULD — matcher deletion receipt: rebuttal accepted; finding withdrawn.** My previous review incorrectly assumed WS11 D4 would remove the last matcher consumer. `src/renderer/AccountsCard.tsx:275–306` still uses it for endpoint identity/eligibility, while WS11 D4's specified migration/deletion list covers Accounts copy and state presentation, not that eligibility computation (`11-server-consolidation.md:499–564`). Keeping the matcher is necessary. WS09 now removes the incorrect D4 handoff and records eligibility migration followed by consumer-checked matcher removal as deferred work (`09-models-usage.md:2171–2182`, Deferred). No WS11 deletion receipt is required.

4. **Previous NIT — duplicate wire envelopes: resolved.** F7 includes `bootId` and `revision` in both frame and snapshot envelopes and identifies SF-M16 as the sole wire definition (`:1753–1757`).

Outstanding findings: **0 BLOCKING, 0 SHOULD, 0 NIT**. Approval is for the revised specification, not implementation verification.

VERDICT: APPROVE
