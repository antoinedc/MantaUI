# WS09 review — server-first

Reviewed the revised WS09 contract against the server and desktop sources, D23–D30, the capability/member registries, mount ledger, and WS11's later migration. Specification review only; no implementation or tests executed.

1. **BLOCKING — SF-M1 / M-09-srv-1: the injected reconcile cannot report the promised outcome.**
   - Problem: `models:set-sub` is said to call `providers.syncSubagents` and see `setSubagents`' `ok`, but that value is deliberately swallowed inside the existing helper. The new service cannot distinguish a successful no-op from a failed write by the returned array. `models:retry-sub-sync` has the same problem. The planned `subOutcome` signature still takes before/after arrays, despite the audit explicitly removing those heuristics.
   - Evidence: spec lines 224–228, 262–264, 1693; `src/server/providers.mjs:803–835` returns `[]` on read failure and the existing array on write failure, and returns an array on success. Providers is absent from WS09's edit list (spec lines 1566–1584; master wave-B ownership table).
   - Fix: pin an additive outcome-aware provider helper (or optional detailed-result mode), preserving the existing array-returning RPC for older clients. Return explicit read/write/reload status, consume it in all three reconcile paths including opt-in, and ledger the providers edit. Continue using the single `editConfig` writer; do not duplicate reconciliation/config-writing logic. Test failure versus successful no-op, and partial preference-save feedback/retry.

2. **BLOCKING — Desktop migration M9: removing the catalogue matcher breaks the still-live Accounts screen.**
   - Problem: the spec says `routingCatalog.matcher` has no remaining consumer and removes it in wave B. Accounts still uses it for endpoint eligibility; its migration is deferred to WS11/wave D. Following this instruction fails typechecking and removes an input needed by the existing screen.
   - Evidence: spec desktop migration row for `routingCatalog.ts` (line 658); `src/renderer/AccountsCard.tsx:278–306` accepts `RoutingCatalog["matcher"]` and performs identity/catalogue lookup; lines 577, 684, 702 read `routingCatalog.matcher`. WS11 §U4 moves the Accounts derivations later (`11-server-consolidation.md:437–491`).
   - Fix: keep the matcher and its construction for Accounts through wave B; remove WS09's use only. Assign its final deletion to WS11 after the last Accounts consumer migrates, and update both specs' deletion lists.

3. **BLOCKING — SF-M10 / Desktop migration: a re-export does not bind the retained local caller.**
   - Problem: the specified one-line `export { describeMissing } from "../shared/autoEligibility.mjs"` replaces the local function, but does not introduce a local `describeMissing` binding. The retained `helpText` call therefore becomes an unresolved identifier.
   - Evidence: spec lines 420–422 and the AccountsCard migration row; `src/renderer/AccountsCard.tsx:178–194`, particularly the local call at line 191.
   - Fix: specify an import for local use and a re-export if existing importers/tests still need that public symbol. Keep the shared implementation single-source and include the Accounts custom-row rendering/typecheck in verification.

4. **BLOCKING — SF-M18: the prescribed decoration leaves live bus payloads undecorated.**
   - Problem: assigning `snapshots = results.map(decorateSnapshot)` and `seatSnapshots = seatResults.map(decorateSnapshot)` updates the read caches only. The existing publish statement sends the original `results`/`seatResults`. Both clients are being changed to consume `tone`, so live updates would replace correctly coloured RPC results with windows lacking it, producing neutral/update-box states on a capable box.
   - Evidence: spec lines 620–627; `src/server/usage.mjs:640–648` stores the caches separately and publishes `{ snapshots: results, seatSnapshots: seatResults }`.
   - Fix: explicitly publish the decorated arrays as well as store them (or decorate the source arrays before both operations). Pin the same shape for `usage:list`, `usage:list-seats`, `usage.updated`, and copied account-seat windows. Test an initial read followed by a changed live tick, not only a direct decorator call.

5. **SHOULD — SF-M16 / F7: reconnect adds active alerts but never reconciles missed retirements.**
   - Problem: the iOS reconnect recipe only enqueues unseen ids. If a sticky alert retires while disconnected, its retirement frame is lost; the next `usage:alerts` response omits it, but nothing removes it from the local queue. Desktop's migration similarly specifies seeding and live retirement without snapshot reconciliation. A snapshot racing a retirement frame can also resurrect an expired banner.
   - Evidence: spec lines 590–596, 1497–1504 and desktop M16/M17; `usage:alerts` is defined as the active set, whereas `retired` is an ephemeral bus frame.
   - Fix: make reconnect an authoritative reconciliation: prune queued ids absent from the active response, then enqueue unseen active ids. Specify request-generation/event-order protection so a late snapshot cannot undo a newer retirement. Keep dismissed ids in the seen set. Test disconnect → retirement → reconnect and retirement during an in-flight fetch on both clients.

6. **SHOULD — SF-M13: the promised failure copy falsely says nothing changed after a reload failure.**
   - Problem: `models:set-price` maps failure from `setModelCost` to “Nothing was changed”. The underlying writer may already have saved the price before the live reload failed; the current helper discards that distinction.
   - Evidence: spec lines 470–474; `src/server/providers.mjs:224–228` writes first and returns `ok:false, changed:true` on reload failure; lines 780–781 collapse it into `{ok:false,error}`.
   - Fix: either propagate the persisted/not-applied result through an additive detailed contract, with retry feedback, or use honest generic failure copy that does not assert rollback. Test a successful disk write followed by failed reload; retain the single writer.

7. **SHOULD — SF-M14: pin the last-looked input rather than leaving the new badge contract implicit.**
   - Problem: `buildResumeView` lists `stopped` but no `lastLooked`, while its tests require the null/equal/before/after boundary. It is unclear whether `stopped` is the full store envelope or just records. Reading only records makes all rows perpetually new and makes closing the sheet unable to clear the shared badge/header.
   - Evidence: spec lines 488–490, 503–507, 538–541; `src/server/stoppedStore.mjs:65–70` stores `{lastLooked,records}`; `src/renderer/usageResume.ts:123–124` needs both the record and timestamp.
   - Fix: type `stopped` explicitly as the complete envelope, or add `lastLooked` as a required nullable input and specify the service adapter. Preserve D29: use this only for the resume view, leaving WS04's row-marker store/capsule intact.

8. **SHOULD — F6: specify iOS resume-view refresh and selection reconciliation.**
   - Problem: desktop explicitly reloads on `usage-stopped.updated`, but the new iOS `UsageResumeModel` is only told to load on appear. Its acceptance criteria nevertheless promise cross-device changes without reopening. Once the sheet stops rendering WS04's records, observing `SessionListStore` alone does not refresh its separate `view` or dry-run plan.
   - Evidence: spec desktop M14/M15 migration row; F6 lines 1380–1413 and acceptance at 1439–1440. The existing server publishes `usage-stopped.updated` from its mutations (`src/server/stoppedStore.mjs:151,171`).
   - Fix: add an explicit lifetime-bound raw-frame subscription and reconnect refresh for the sheet. Pin how refreshed rows merge with an in-progress selection, remove vanished ids, and invalidate/recompute the dry-run plan with stale-response protection. Test a second device arming/removing a row while this sheet remains open.

The D25 capability ownership/accessors, D26 shared formatter ownership, D27 shared-file integration rows, and D29 row-marker versus resume-screen split otherwise align with the revised master. Alerts are explicitly in-app-only; the user-requested reset reminder correctly remains the existing scheduled notification path.

VERDICT: CHANGES REQUIRED
