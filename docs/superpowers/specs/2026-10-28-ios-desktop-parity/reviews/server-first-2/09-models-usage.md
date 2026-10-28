# WS09 review — server-first-2

Specification review against the current server/desktop sources and the master ownership, capability and member contracts. No implementation changes or test runs.

## Previous findings

| Previous finding | Verification |
|---|---|
| 1. Reconcile outcome swallowed | Resolved: SF-M1 pins `syncSubagentsDetailed`, preserves the old array projection, and routes set-sub/retry/opt-in through explicit outcomes. `setSubagents` actually preserves the failure result from `editConfig` (`providers.mjs:666–681`). The master now assigns `providers.mjs` and its tests to WS09 (`00-master.md:636`). |
| 2. Removing the matcher breaks Accounts | Resolved for wave B: desktop migration explicitly keeps `routingCatalog.ts` unchanged (`09-models-usage.md:830`), matching the retained Accounts consumers and master ownership row. The later deletion handoff still needs the recipient update noted below. |
| 3. Re-export leaves the local caller unbound | Resolved: the migration now specifies both the import and re-export, preserving `helpText` and the existing test imports (`:829`). |
| 4. Live tone payload undecorated | Resolved: SF-M18 explicitly uses decorated arrays for caches, observation and publication, with a changed-second-tick payload test (`:775–800`). |
| 5. Missed alert retirements | Partially resolved: authoritative pruning and revision guards fix the stated missed-retirement case, but the new ordering algorithm loses snapshot hydration when a newer delta arrives. Finding 1 below. |
| 6. False “nothing changed” price feedback | Resolved for the reported reload-refusal path: SF-M13 preserves `changed` through `setModelCostDetailed`, invalidates prices and reports a saved-with-warning result (`:550–584`). The optimizer does read the config file (`rpc.mjs:769–773`). |
| 7. Missing last-looked input | Resolved: SF-M14 explicitly takes the full `{records,lastLooked}` envelope and pins its adapter and stamp tests (`:593–620`, `:671–672`). D29 remains intact. |
| 8. iOS resume refresh | Resolved: F6 adds lifetime-bound stopped-update/reconnect subscriptions, view/plan sequence guards, selection reconciliation and cross-device tests (`:1565–1590`, `:1633–1641`). Desktop uses the same selection rule. |

## Findings

1. **BLOCKING — SF-M16 client reconciliation: dropping an older snapshot can permanently lose unrelated active alerts.**
   - **Problem:** a delta is not a complete active-set snapshot. On reconnect, suppose the client missed active alert A at revision 4. The snapshot request captures revision 4 with A. Before its response arrives, a revision-5 frame raises B (or retires some unrelated X). The specified client applies the frame, sets `lastRevision = 5`, and drops snapshot 4. A never enters the queue, and no further fetch is required by the contract. The same failure occurs at initial hydration once the boot id is known. Pruning alone therefore does not deliver all active alerts raised while disconnected.
   - **Evidence:** `09-models-usage.md:729–745` explicitly drops older snapshots and triggers a new snapshot only for a different boot id; the desktop and iOS consumers adopt this algorithm at `:834–836` and `:1707–1715`. The tests at `:1758–1761` cover preventing resurrection, but not retaining unrelated active alerts.
   - **Fix:** pin a complete hydration protocol: buffer/replay deltas over the fetched snapshot, or request a fresh authoritative snapshot whenever the initial/reconnect snapshot is superseded, retaining a “needs snapshot” state until hydration succeeds. Detect revision gaps as well. Pin connection/request epochs so a late response from an older boot cannot switch `lastBootId` back. Test the A/B example, a retirement racing hydration, and a server restart during a request on both clients.

2. **BLOCKING — Desktop migration / M-09-srv-1: new writes bypass the existing default-model and catalogue refresh paths.**
   - **Problem:** the new Models card replaces the existing mutation bodies with new RPC calls plus replacement of the table cache. That updates the Settings table, but neither the retained desktop `defaultModel` mirror nor the raw model catalogue used by the composer. The new picker hook only refetches keys and maps them onto that existing catalogue. Consequently selecting/clearing a default can leave new chats using the previous default, and editing a name/context can leave the composer showing the previous values. This is a presentation/data-refresh gap, not a request to move deferred M3 selection logic.
   - **Evidence:** spec `:819–823` removes those mutation bodies but specifies no replacement refresh for these consumers; registration `:1979–1983` calls `local.configUpdate` directly. The old default action calls the store setter (`src/renderer/ModelsCard.tsx:337–350`; `store.ts:1178–1183`), hiding the default explicitly clears that mirror (`ModelsCard.tsx:273–276`), and override saving calls `refreshModelCatalog()` (`:357–377`). The catalogue only refreshes on mount/explicit refresh (`src/renderer/modelCatalog.ts:90–123`); the remaining default consumers include `ChatPanel.tsx:244` and `store.ts:982–996`. Also, direct `local.configUpdate` does not perform `syncState.applyConfig(next)`, unlike the existing RPC wrapper (`src/server/rpc.mjs:906`).
   - **Fix:** explicitly carry the saved config through the existing sync-state publication path and reconcile the desktop default mirror after new writes/events. Specify raw catalogue invalidation/refetch on `models.updated` (including cross-device writes), not just picker-key/table reloads. Ledger `modelCatalog.ts` if edited. Test set-default, clearing it by hiding Main, and editing name/context while an existing composer is mounted; assert the actual new-session model and composer metadata update without remounting.

3. **SHOULD — Cross-spec dependencies: the deferred matcher deletion has no WS11 receipt.**
   - **Problem:** keeping the matcher in wave B fixes the compile failure, but the spec assigns its eventual deletion to WS11 D4 without updating that recipient's deletion list. This can leave the no-longer-needed client matcher after consolidation.
   - **Evidence:** WS09 desktop row `:830` and Cross-spec dependencies `:2078–2082` assign the deletion to WS11; `11-server-consolidation.md` D4 “Desktop switch” (`:558–564`) does not mention `routingCatalog`, `matcher` or `createModelIndex` (none occur elsewhere in that specification).
   - **Fix:** add the explicit WS11 D4 receipt, retaining the `entries` typeahead surface, and check for remaining matcher consumers before deletion. Keep the wave-B no-edit rule unchanged.

4. **NIT — F7 repeats the pre-revision wire envelope.**
   - **Problem:** F7 still documents frames as `{alert}` / `{retired}` and the snapshot as `{supported,alerts}`, omitting the now-required `bootId` and `revision`. The detailed SF-M16 contract is correct, but duplicate shapes invite incomplete wire models.
   - **Evidence:** `09-models-usage.md:1684–1689` versus `:706–728`; the client algorithm below F7 requires both fields.
   - **Fix:** update those envelopes or replace them with a direct reference to SF-M16 as the sole wire definition.

D25 capability gating, D26 formatter ownership, D27 integration ownership and the D29 stopped-state split remain consistent. Alert generation remains in-app-only; explicit reset reminders retain the existing notification path.

VERDICT: CHANGES REQUIRED
