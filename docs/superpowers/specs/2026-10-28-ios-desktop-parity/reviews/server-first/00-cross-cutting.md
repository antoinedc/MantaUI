# Server-first cross-cutting seam review

VERDICT: CHANGES REQUIRED

**2 BLOCKING · 2 SHOULD · 0 NIT.** Specification review, not an implementation/build certification. Canonical master decisions, ledger, registry and binding amendments take precedence over historical workstream prose. No specs or implementation files changed.

## BLOCKING

### B1 — M-09-srv-1 does not have a complete provider export/service contract

**Evidence:** `09-models-usage.md:224-231,319-326,350-355,411-480,489-492,1693`; master server registration row M-09-srv-1.

The integration worker is explicitly told to **import** `createModelsUnidentified`, `withLedgerView`, `withSummaryView`, `withSeriesView`, `withUnpricedGroups`, and `setPrice`, and wire the new channels through service methods. The provider sections do not pin matching exports and signatures:

- SF-M1's explicit `createModelsTable(deps)` return surface lists `table/setDefault/setMain/setSub/optIn/setOverride/picker`, but no method for `models:retry-sub-sync`. That channel has a real “Try again” consumer.
- SF-M9–11 describes unidentified-model behavior and the declare wire shape, but does not declare the `createModelsUnidentified` factory, its dependencies or its returned methods. The factory name appears only in the mount row.
- SF-M6 exports `ledgerView(summary)` and defines the wrapper algebra, but does not say that `withLedgerView` is exported or where the integration worker should obtain it.
- SF-M7 exports `summaryView(summary, { optimizerEnabled })` and `seriesView(series, { range })`, whereas registration calls `withSummaryView(summary, config)` and `withSeriesView(series, range)`. The adapters are named at the use sites, not declared as provider exports.
- SF-M13 exports `parseCostDraft` and `groupUnpriced`; it describes the price-write behavior but does not declare the `setPrice` / `withUnpricedGroups` exports required by the mount.
- `createUsageResumeView(...)` likewise lacks an explicit returned method surface for the row's generic `svc.fn(input ?? {})` registration instruction.

An implementer can invent these adapters, but then the two independently owned commits are not coding against the same contract. Following the currently declared exports literally leaves unresolved imports at server startup or undefined handler methods behind advertised controls. This fails the requested exact-symbol/signature seam check, not merely documentation polish.

**Required:** pin module-qualified exports, arguments and service return methods for every M-09-srv-1 registration. Either make the wrappers explicit WS09 exports or assign their inline construction explicitly to IB using the actual exported pure functions. Include a real retry method. Verify the integrated handlers by importing the modules and exercising each new channel, including retry-sub-sync and price/declare writes with injected dependencies.

### B2 — WS09's mandated one-line re-export removes a binding still used by AccountsCard

**Evidence:** `09-models-usage.md:422-425,654-655`; master D27 assigns `AccountsCard.tsx` to WS09 in wave B. Actual consumer: `src/renderer/AccountsCard.tsx:189-195`.

WS09 replaces the local declaration with:

```ts
export { describeMissing } from "../shared/autoEligibility.mjs";
```

But the same module's retained `helpText` still calls `describeMissing(r.eligibilityMissing)`. An export-from declaration does **not** introduce a local binding. The stated migration therefore fails TypeScript compilation in wave B. WS11 D4 moving that help text later cannot repair the required B → C build boundary.

**Required:** import the shared function into the module and re-export that binding if an export is still needed. Keep the existing custom-row consumer working until D4 migrates it. Verify typecheck and the custom-row help test after the wave-B migration.

## SHOULD

### S1 — WS11 points the capability-field edit at the API extension instead of the wire model

**Evidence:** `11-server-consolidation.md:126-127,1256-1260`; `10-settings-box.md:1002-1008`; actual `mobile/native/MantaUI/SettingsWireModels.swift:26` and `mobile/native/Package.swift:77`.

`ServerVersionInfo` is declared in the Foundation-only `SettingsWireModels.swift`, already included in the package, not `MantaAPIClient+Settings.swift`. D1 and its file inventory should name the real file. The required type/member is otherwise unambiguous, and the package already contains its dependency, so this is not classified as an integrated-build blocker. Do not move or duplicate the type in the app-only extension.

### S2 — Canonical table omits a binding mount and understates the final prerequisite

**Evidence:** master D22 and the canonical mount table; `11-server-consolidation.md:824-836,1289-1293`.

D22 defines M-01-7 (`TranscriptDisplayOptions.fetchSlim`, change notification → refetch in `ChatSessionStore.swift`), and WS11 explicitly preserves that mount, but the canonical table lists M-01-1…6 only. D22 also carries the media box-reset receipt outside the table. Add these to the table for dispatch traceability. O-final still lists C-int as its prerequisite even though the binding wave order places D before final and WS11 edits `project.yml`; make the row say D complete. Binding prose already resolves both scheduling questions, so neither is a new blocker.

## Ledger and registry reconciliation

The following covers the canonical rows and the additional desktop/server mount tables. “Consistent” means the spec provider/receiver and applier are aligned; it does not claim their implementation is built.

| Rows | Result |
|---|---|
| M-01-1…5 | Consistent WS01 mapper/display/media interfaces consumed by WS02/WS07 in B. D8–D11 retain the entry points or require the receiver migration in the same step. |
| M-01-6; D22 M-01-7 | Package integration remains IA A-int; fetchSlim/refetch receipt is binding but missing from the canonical table (S2). |
| M-02-1…3 | Highlight environment, read-only overflow parameter and package integration have matching owners/receivers. |
| M-02-4/5 | D28 closes ownership: IB adds optional job fields to SessionModels; WS02 updates BackgroundJobsSheet. B-int is the explicit compile boundary. |
| M-03-1…4 | Existing wave-0 draft prerequisite and A1 composer owner remain coherent. |
| M-03-5/6 | WS09 provides agentsLoadError/retryAgents; IB consumes the pinned agentRows interface in ComposerView. |
| M-03-7…9 | Composer mutation gate and package receipt retain their owners and order; no second composer-controller declaration. |
| M-04-1…6, M-04-8 | Overflow/navigation/launcher/draft package receipts remain aligned with A2 → B. M-04-7 is explicitly withdrawn. |
| M-05-1…4 | C worker consumes completed B chat/composer interfaces; ReviewDiff package addition is withdrawn. |
| M-06-1…3 | Both mounts use primarySessionId/seed/search, without the deleted scope argument; chat passes store.sessionId. |
| M-07-1…4 | Composer attachment interface, webhook mount, root notice and replacement artifact package manifest agree. |
| M-08-1/3 | Provider-change notification and package receipt remain aligned. M-08-2 stays declined. |
| M-09-1…7 | Models/alerts/root/resume mounts agree with the shared member registry; resume-sheet API does not redeclare the stopped-list API. |
| M-09-8/9 | Optional UsageWindow.tone and the window overload of band agree. WS02 owns UsageSheets in B; IB owns ComposerView/AccountsScreen receipts in B-int. Context's numeric overload is explicitly retained at this boundary. |
| M-10-1…3 | Appearance and box-removal contracts remain A1 → A2; package integration is IA. |
| O-final | Single orchestrator owner; must run after D per binding wave order (S2). |
| M-02-srv-1…10 | Capability, delegate factory/guards, error handling, retry/compaction/error decoration and inbox copy have provider contracts and ordered IB receivers. |
| M-07-S1/S2 | createArtifactsService dependency names/list(sessionId), dynamic baseUrl and capability append agree. |
| M-09-srv-1/2 | **M-09-srv-1 fails exact provider-contract check (B1).** Capability append itself is consistent. |
| M-06-srv-1/2 | Search scope dependency injection and capability append agree; applied after 09. |
| M-05-srv-1/2 | forgeInbox({probeRepos}) and four capability additions are owned by the sole C worker. |
| M-07-D1…5 | Server plan-ref export, renderer deletion, artifacts types/API/http/demo receivers align under IB. Current extractPlanData does not call planRefsFromPart, so deleting the latter in B does not strand the plan-question consumer before D10. |
| M-09-dsk-1…5 | API/types/http/demo/shared utility and picker receipts are assigned consistently. App/store halves are explicitly WS09 direct edits, not duplicate IB edits. Separate direct AccountsCard migration is blocked by B2. |
| M-06-dsk-1/2 | TranscriptHitGroup and search API shape are IB edits after 07/09; no competing shared-file writer. |

No new duplicate channel, stream sub, shared client member or capability-id ownership was found in the authoritative contracts. In particular:

- `BOX_CAPABILITIES` is created once by WS02, appended by IB for 07/09/06, by WS05 in C, and by WS11 in D. Older mentions of `artifacts.list` or a second capability module are superseded, not additional registrations.
- `formatTokenCount` / `formatTokens` have one provider, WS02/D26. WS09 consumes them; WS11 reuses them. WS02 also updates formatLastMove before deleting its old compact formatter.
- WS11's `capabilities` field summary describes an existing B field it extends, not a second field declaration.
- WS02 owns the B retry/compaction/session-error/job/inbox additions; WS09 owns optimizer/ledger/usage tone; WS06 owns search groups; WS05 owns its forge view additions. WS11's later fields are separate or explicit migrations.
- D27 removes same-file/same-wave double ownership across desktop and server files. Shared registration files remain IB-only in B; non-owner local verification patches are expressly uncommitted. C and D each have one worker.

## B → C → D deletion audit

| WS11 step | Earlier consumer and migration obligation | Result |
|---|---|---|
| D1 | WS02 chat capability resolver plus any C forge consumer | Explicitly migrates all callers before deleting boxCapabilities()/ChatCardCapabilities; keeps desktop useBoxCapability. Unknown-channel classifiers also migrate together. S1 corrects the field's file pointer. |
| D2 | ChatScreen/ChatSessionStore context and cache consumers | Recompute deletion has named replacements and an opening fetch; preserves usage-window tone introduced by WS09. |
| D3 | WS10 settings/update/launcher types and WS04 launcher consumers | File inventory includes SessionListStore, TerminalScreen/Socket and SessionModeLogic alongside settings consumers. One D worker can apply the change atomically. |
| D4 | WS08 account state/copy and existing desktop usage-dial seat text | Both clients migrate in the step; no need to redefine the B formatter or WS09 price/model APIs. Does not excuse B2's earlier compile failure. |
| D5/D6 | WS04 creation/naming and close/worktree flows | Named iOS and desktop receiving files migrate with the server rules; shared server naming utilities are not indiscriminately deleted. |
| D7 | WS04 session nesting/markers, WS02 background-job sheet, WS09 capsule | Explicit split and same-step conditional migration preserve these consumers; details below. |
| D8/D9 | WS02's M-01 mapper mounts and live-media reconciliation | WS11 explicitly preserves the mapper signatures or updates ChatSessionStore and its tests in the same step. Live frame/canonical replacement and stable media identities are specified. |
| D10 | WS02 plan questions and WS07 plan-ref provider | Imports WS07's server planRefsFromPart; does not recreate/delete that provider. Question consumers migrate before local plan derivation is deleted. |
| D11 | WS02 live transcript merge, activity sheet and running indicator | Changes live-run merging and its ChatSessionStore receiver together, plus activity/indicator consumers; canonical and live paths use the same server rules. |

### D29 stopped-conversation split

Coherent as specified. WS04 keeps `usageStoppedList`, stoppedRecords/lastLooked, row markers and the M-09-2 count. WS09's new view/apply endpoints serve only the resume screen; the existing stamp-last-looked operation is reused. Desktop usageResume keeps the count/marker helpers while removing resume-screen derivations. D7 can replace row rendering with windowStatus.stopped, but may retire the old source only when it supplies unarmedCount and migrates both the iOS capsule and desktop Sidebar in the same step. WS02's delegate list/sheet fields are explicitly outside that deletion.

## Verification boundary

Reviewed the master, provider/receiver specs, mount tables and relevant existing Swift/TypeScript declarations. No Swift build, typecheck or test suite was run: these are proposed contracts. Only this review report was written. Resolve B1/B2 before treating the wave-B integrated build as a valid prerequisite for C or D.
