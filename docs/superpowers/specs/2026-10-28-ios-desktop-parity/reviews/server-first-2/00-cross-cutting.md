# Server-first-2 cross-cutting seam review

VERDICT: PASS WITH NON-BLOCKING FOLLOW-UPS

**0 BLOCKING · 2 SHOULD · 0 NIT.** Specification integration review, not a build certification. Reviewed against `34b6a2c6` plus the current working-tree revisions to WS05 and WS09 observed during this review (including `parseFailed`/nullable draft handling and buffered usage-alert hydration). Canonical decisions and binding amendments take precedence over historical prose. No implementation or spec changes made.

## Previous findings

| Server-first finding | Disposition |
|---|---|
| B1 — incomplete M-09-srv-1 provider contracts | **Resolved.** WS09 SF-M1 explicitly returns `retrySubSync()`. SF-M6/M7 export `withLedgerView`, `withSummaryView`, `withSeriesView` from their named modules. SF-M9–11 pins `createModelsUnidentified` dependencies and `list/declare`; SF-M13 pins `withUnpricedGroups` and `createModelsPricing(...).setPrice`; SF-M14–15 pins `createUsageResumeView(...).view/apply`. The registration block supplies matching dependency names and calls matching methods, including retry, price and both declaration forms. Existing catalogue/stopped-store aliases match the current `rpc.mjs` imports. The integrated handler smoke test belongs to WS09 and runs after IB applies the mount. |
| B2 — AccountsCard loses its local `describeMissing` binding in B | **Resolved.** The migration imports `describeMissing` with `autoEligibility`/`MISSING`, then re-exports the local binding. Retained `helpText` and existing tests work against that binding until D4. |
| S1 — wrong file for `ServerVersionInfo.capabilities` | **Resolved.** WS11 D1 and Files name `SettingsWireModels.swift`, already included by `Package.swift`; the type is explicitly neither moved nor duplicated. |
| S2 — canonical table bookkeeping | **Mostly resolved.** M-01-7 is now in the canonical table and O-final depends on D complete. D22's media-reset receipt still exists only in binding prose; included in S1 below. |

## SHOULD

### S1 — Finish synchronizing the master member registry and reset receipt

**Evidence:** master D22, M-09-4, shared-member registry; WS11 D1, D6, “Client members,” and M-11-11.

The concrete wave-D instructions are sufficient to implement the seams, but the master registry is not yet an exact inventory:

- Neither client's new `apiVersion()` is listed in the master member registry. WS11 explicitly supplies it on both clients, including desktop API/http/demo/coverage edits and the iOS Settings extension, so this is not an unowned implementation task.
- The master lists `sessionsClosePreview(_:)` / `sessionsClose(_:)`, also used as shorthand in D6, while WS11's explicit client-member table declares `sessionsClosePreview(project:windowIndex:)` and `sessionsClose(project:windowIndex:dirtyWorktree:)`. Use the explicit labeled signatures consistently in both inventories and the consumer prose; no second overload is needed.
- D22 assigns `TranscriptMediaStore.shared.resetForBoxChange()` to IB in the root's `.mantaBoxRemoved` handler **with M-09-4**, but M-09-4 still lists only the usage/model resets. Include the media reset in that row's exact change/provider list.
- The master records the B-era `TranscriptLiveTruncation.from(kind:messageID:)` without its D8 replacement. Add a wave-qualified note pointing to `from(payload:)`; retain the B contract until D8 rather than prematurely changing M-01-1.

**Why non-blocking:** D22 explicitly assigns the reset, and WS11 runs alone in D with explicit provider, receiver and same-step migration instructions. These are incomplete summaries, not missing provider implementations or competing workers. They should nevertheless be aligned before dispatch briefs are generated solely from the master tables.

### S2 — The specified allocation test's barrier is inside the mutex

**Evidence:** WS11 D5 “Name allocation is serialized” and Tests (`sessionNaming.alloc.test.mjs`, approximately lines 620–700).

The required critical section encloses `listSessionNames()` → choose → `tmux.newSession()`. The test then says the fake `listSessionNames` resolves only after a barrier **both calls** reach. With a correct mutex, the second call cannot enter `listSessionNames` until the first releases the lock; the first waits forever for the second.

**Change:** start two handler requests concurrently outside the allocator. Hold the first fake read on a test-controlled deferred promise, assert only one read/create entered the critical section, release it, then await both requests and verify distinct names and final-name metadata. Bound the test with a timeout. Keep the external-collision/reused-session test separate.

**Why non-blocking under this review's threshold:** this is a contradictory verification recipe, not a broken production provider/receiver contract, dead control or cross-client drift requirement. Following it literally would hang the verification gate, so fix it before implementing the test.

## Canonical Swift mount reconciliation

“Aligned” below means the declared provider, receiving edit, applier and integration boundary agree. It does not claim the proposed code has compiled.

| Canonical rows | Result |
|---|---|
| M-01-1…4 | Aligned: WS01 mapper/options/media/command/truncation providers → WS02's B store. D8/D11 receiver changes are explicitly atomic; see below. |
| M-01-5…7 | Overflow preference belongs to WS07 B; package manifest to IA A-int; newly tabled `fetchSlim`/notification receipt to WS02 B. D22 reset bookkeeping remains S1. |
| M-02-1…3 | Highlight environment → IB B-int; read-only overflow parameter → WS07 B; package → IB. |
| M-02-4/5 | IB adds optional job fields to WS04's built model; WS02 updates the sheet. The stated compile boundary is B-int, so the later model mount is accounted for. |
| M-03-1…4 | WS03 A1 owns composer/draft wiring against the wave-0 scaffold; no second draft/controller owner. |
| M-03-5/6 | WS09 supplies agent-load state/retry; IB applies the pinned `agentRows` receiver. |
| M-03-7…9 | Chat composer gate remains WS02 B, package IA, composer policy receipt IB after the earlier composer mount. |
| M-04-1…6, M-04-8 | Rename/mode/launcher/navigation providers and receivers align with A2 → B. Mode sections are siblings; retry is required before showing actionable mode rows. M-04-7 remains withdrawn. |
| M-05-1…4 | Sole C worker consumes B chat/composer contracts and A2 navigation; IC owns the package receipt. No `ReviewDiff` package dependency remains. |
| M-06-1…3 | Both search mounts use `primarySessionId/seed/search`, not deleted `SearchScope`; ChatScreen passes the current session. WS02 owns B chat mount, IB list/package mounts. |
| M-07-1…4 | Artifact composer/navigation, webhook, root notice and replacement package manifest align; no obsolete `onAttach` contract. |
| M-07-pkg-1 | WS07 alone installs the B root dependency. C/D additions have separate sole owners. |
| M-08-1/3 | Provider notification consumed by WS09 B; package IA A-int. M-08-2 remains declined. |
| M-09-1…7 | Models/settings/accounts, root alert/resume/reset and active-session mounts align. Root rows remain ordered after artifact/reset prerequisites. S1 concerns only the omitted media reset in the table. |
| M-09-8/9 | IB adds optional window tone; WS02 changes UsageSheets in B; IB changes ComposerView/AccountsScreen in B-int. Numeric context overload stays until D2. |
| M-10-1…3 | Appearance/removal providers A1 → WS04 A2; package IA. |
| O-final | Corrected: orchestrator only, after D, including D11's project.yml fixture-resource removal. |

## Desktop and server registration reconciliation

| Rows | Provider / receiver result |
|---|---|
| M-02-srv-1…10 | Aligned: capability list, shared copy exports, delegate factory/service, approval validation, write guards and generic status catch. Factory construction/passing precedes dependent handlers. IB alone edits registration files. |
| M-07-S1/S2 | `createArtifactsService` dependency object matches the handler construction; `list(sessionId)` and dynamic `baseUrl()` agree. Capability append follows WS02 creation. |
| M-07-D1…5 | Plan-ref helper/test deletion, shared artifact result type, IPC/API/http and demo factory have named receivers under IB. `extractPlanData` does not call the removed renderer `planRefsFromPart`; D10 imports the server export. |
| M-09-srv-1/2 | Prior blocker resolved as above. Table/unidentified/pricing/resume services, wrapper signatures, alert accessor and dependency aliases match the explicit registration block. Nine capability ids appended by IB after 07. |
| M-09-dsk-1…5 | API/type/http/demo/event members and shared utility/picker edits remain IB. App and store halves are WS09 direct edits. Local AccountsCard binding survives B. |
| M-06-srv-1/2 | Both exports come from `messageSearch.mjs`; registration passes `projectsFromSyncState(syncState)` using the existing handler dependency. Capability append is last in B. |
| M-06-dsk-1/2 | `TranscriptHitGroup` and search request/response update are IB edits after preceding shared-type/API mounts. |
| M-05-srv-1/2 | Sole C worker supplies `forgeInbox({probeRepos})`, using `local.forgeProbe`, and appends four ids. Existing forge registrations get their additive results from WS05 modules. Current `parseFailed` and nullable-draft changes migrate both clients within that same owner/wave. |
| M-11-1…11 | Traceability rows, all applied by WS11 itself in D. They do not assign edits back to B/C workers. Server registration files and shared desktop/API files are explicitly direct D edits. |

Registration order remains **02 → 07 → 09 → 06** in B-int, then WS05 in C, then WS11 in D. No newly conflicting channel, shared member, frame discriminator, capability id or same-file/same-wave writer was found in the authoritative instructions. The registry shorthand discrepancies are S1, not duplicate ownership.

## Required WS11 cross-spec checks

| Dependency | Provider and atomic receiver / applier |
|---|---|
| `apiVersion()` | D1 creates both client methods against upgrade-exempt `GET /api/version`; desktop API/http/demo/coverage included. iOS method lives in the Settings extension. Existing RPC `serverVersion()` stays separate. WS11 alone. |
| `ServerVersionInfo.capabilities` | D1 adds optional decoding to the existing Foundation wire model in `SettingsWireModels.swift`; existing package membership reused. No duplicate type or app-only dependency. |
| `toolRuns` / `windowStatus` | D11/D7 explicitly edit `MantaStreamModels.swift`, `MantaEventStore.swift`, `MantaSessionStreamState` and `MantaStreamRouter.applying`, not only leaf store decoding. Server emission and reconnect snapshots are assigned to WS11; M-11-4/10 record them. |
| Prose identity `"p" + partID` | D11 changes the enum, every prose pattern/construction, mapper `process`, stable-scroll id and live-tail builder together; canonical and flush part ids match. User bands keep hash ids; reasoning/run/media/footer identities keep their rules. `liveTailRowID` swapping is removed in the same step. Tests cover the intentional prose-id change and live/canonical equality. M-11-3/7 and Files include receivers/tests. |
| `TranscriptLiveTruncation.from(payload:)` | D8 adds stream hint, changes live value/factory and footer value/view, updates the M-01-1 ChatSessionStore call and tests in the same step. `footerTruncationMessageIDs` keeps its signature. No explanation control when hint is absent. |
| `SessionCloseFeedbackKind.closedWithWarnings` | D6 adds the case and requires warning rendering; Files explicitly includes `SessionCloseLogic`, `SessionListStore`, **SessionListView** (the current exhaustive feedback switch), and the prompt sheet. Thus extending the enum is not assigned without its switch consumer. Existing notice handling and new warnings are both required. |
| `listSessionNames` / `DuplicateSessionNameError` | D5 explicitly edits `tmux.mjs`, not just the handler: live-name read, typed duplicate failure carrying the created chat id, retries with `existingSessionId`, cleanup on exhaustion/explicit duplicate. Handler, provider and dependency installation belong to the sole D worker. Test barrier issue is S2. |
| `async-mutex` lock | One per-process allocator covers every RPC project creation's read/choose/create critical section; final-name metadata/result updates are prescribed. `package.json` and lockfile belong to WS11 D. No dependency on a future worker to make the import resolvable. |

### Remaining D1–D11 migration boundaries

- **D1:** migrate all B/C capability consumers before deleting iOS `boxCapabilities()`/`ChatCardCapabilities`; retain the desktop hook and replace its source. Failed/loading discovery is distinct from a loaded old box.
- **D2:** context/cache consumers migrate together; opening cache fetch is included. This does not delete WS09's independent usage-window tone contract.
- **D3:** settings/update/launcher model and consumer edits include the session-list and terminal consumers, not only WS10 files.
- **D4:** account copy/state and desktop consumers migrate together; the shared token formatter is reused. B's AccountsCard binding is valid until this step.
- **D5/D6:** naming/close providers and both clients migrate within the sole D worker; shared server naming consumers are retained rather than deleting the shared utility indiscriminately.
- **D7 / D29:** stopped-list row markers and capsule counts remain distinct from WS09 resume-screen view/apply. Retiring their old source requires `unarmedCount` plus same-step iOS capsule and desktop Sidebar migration. Delegate list/sheet fields are not retired by this consolidation.
- **D8/D9:** preserve the B mapper mounts or migrate their store/tests in the same step; preserve `fetchSlim` and toggle refetch. Canonical/live media identities are explicitly retained.
- **D10:** import WS07's `src/server/artifacts.mjs` `planRefsFromPart`; migrate plan-question consumers before deleting local derivation. No duplicate server implementation.
- **D11:** live ordered layout, run revision merge, activity/indicator consumers, enum patterns, package additions and fixture resource removal are assigned together. Final project regeneration follows D.

## Libraries and ownership

`libraries.md` and the workstream adoption sections agree on root-file ownership:

| Wave | Sole package owner | Adoption / consumers |
|---|---|---|
| B | WS07 | `lru-cache@11.5.3`; artifacts cache now, forge last-PR cache in C. WS07 also owns media MIME allowlist/export changes. |
| C | WS05 | `diff@9.0.0`; server diff mapper and desktop tool-output line-number helper use the parser. Existing B `lru-cache` is reused. |
| D | WS11 | `async-mutex@0.5.0`; name allocator. |

No parallel root-package writer, extra Swift package, duplicate MIME database or second cache dependency is required by these contracts. Their release-tarball requirement is recorded; merging a dependency alone does not install it on running boxes.

## Verification boundary

Inspected the current specs, canonical ledgers/registries, previous cross-cutting report and relevant existing Swift/TypeScript/server receivers. No builds or tests run for these proposed changes. This verdict closes the **server-first B1/B2** specification seams; it does not certify implementation or silently close the separate round-4 media lifecycle findings. Only this report was added; concurrent spec edits and other review reports were left untouched.
