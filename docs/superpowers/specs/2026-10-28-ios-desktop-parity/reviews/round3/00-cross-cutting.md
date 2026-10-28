# Round 3 — cross-cutting seams

Reviewed the canonical mount ledger, shared member registry, reconciliation log, all ten workstreams' provider/consumer contracts and mount tables, and the existing Swift mount targets. D11–D21 and the canonical ledger take precedence over older prose. This is a spec review; no implementation build or test run is claimed. Spec references below are relative to the parity spec directory; code references are repository-relative.

## Findings

1. **BLOCKING — M-06-1: the canonical search mount now calls the right builder with an identifier that does not exist at the receiving site.**
   - **Problem:** the ledger, provider and receiver agree on `SearchScope.fromProjects`, but all pin `primarySessionId: sessionId` in the chat toolbar/sheet. That toolbar belongs to `ChatScreenContent`, which has no `sessionId` property. Its initializer parameter is not in scope in `body`. Following the exact mount produces an unresolved identifier; using the outer wrapper's original id instead would also select the wrong primary conversation after clear/handoff.
   - **Evidence:** `00-master.md:407`; `06-search.md:510-514,562-577`; `02-chat-cards-queue.md:907,1005`. In actual code, the outer wrapper declares `sessionId` at `mobile/native/MantaUI/ChatScreen.swift:126`, while the separate `ChatScreenContent` begins at `:164`, accepts but does not retain the initializer parameter at `:297-325`, and owns the toolbar at `:345-351`. It already uses `store.sessionId` for live identity, e.g. `:370-372,471-473`. Neither WS03's adoption nor WS02's file plan adds a content-level `sessionId` property.
   - **Concrete fix:** pin `SearchScreen(scope: .fromProjects(sessionStore.projects, primarySessionId: store.sessionId))` in the master ledger, WS06's entry-point/request text, and WS02's receipt. Test opening search after clear/handoff: its primary id must be the replacement store's id. Do not add a second stored id merely to preserve the erroneous mount expression.

2. **BLOCKING — M-04-8 / D2: the integrated Foundation package still excludes types required by WS04's draft helpers and tests.**
   - **Problem:** WS04 places `SessionDraftPrefill.apply(draft:projects:worktreePerSession:)` in package-listed `SessionCreateLogic.swift` and requires Linux tests to construct/use the canonical draft. D2 deliberately declares `NewSessionDraft` and `NewSessionDraftAttachment` in `MantaNavigation.swift`, alongside the app-level observable navigator; that file is not in the package manifest. The same test plan calls a “pure” `SessionCreatePlan.openTarget(...)` returning the destination carrying `seed` and `draft`, while `SessionOpenTarget` belongs to app-only `SessionListView.swift`. The integrated A-int package therefore cannot implement/compile these prescribed helpers/tests with the declared source set. Adding the SwiftUI-containing files to the Linux package is not a valid fix.
   - **Evidence:** D2 at `00-master.md:200-213`; navigator declaration at `04-sessions.md:1093-1118`; draft helper placement at `04-sessions.md:1182-1183`; Linux test contract at `:1216-1227`; M-04-8 manifest at `:1293-1305,1359`. Actual `mobile/native/Package.swift:35-60` uses an explicit source list, and `mobile/native/MantaUI/SessionListView.swift:1,1050-1070` contains the SwiftUI destination type. The manifest's fallback only addresses `MantaProject`/`SessionModels`, not these two excluded types. WS05 explicitly recognizes the same draft/package boundary and uses a pure fields value plus an app-only adapter (`05-git-pr-review.md:890-904`); WS04 has no corresponding split.
   - **Concrete fix:** preserve D2's single declaration and specify a Foundation-only input/output projection for prefill/create planning. Put conversions from `NewSessionDraft` and into `SessionOpenTarget` in a WS04 app-only file. Pin those adapter signatures and file ownership; move the draft/target conversion assertions into Mac-only tests, retaining Linux tests for the pure values. Update WS04's manifest/test lists and the M-04-8 ledger reference together. Require the complete A-int manifest to pass `verify.sh`, and the real draft-to-destination adapter to pass the Mac unit gate.

## Round-2 disposition

| Round-2 finding | Round-3 result |
|---|---|
| 1 — launcher provider absent; overflow signature stale | **Resolved.** WS10 F12 and its client table provide `launchersList()`, `AvailableLauncher`, `AvailableLauncherFlag`, and `ExtensionsLaunchers.resolve(schema:saved:)`. WS04 consumes them after A1; WS07 M-04-2 and WS02 M-04-5 agree on optional mode, catalog, list and retry parameters. |
| 2 — transcript signatures and lost truncation warning | **Resolved.** WS01's mapper contract and WS02 M-01-1…4 agree on `OpencodeCommandOrigin`, `TranscriptCommandOrigin.fromLive`, `$sessions`, `entries(for:)`, the single `liveTruncation`, `presentedMessages`, `isLiveWindow:` and actual footer-id suppression. WS02 retains the tail warning when no footer renders it; its integration test includes incomplete snapshots. No per-message truncation map is required. |
| 3 — draft initializer and backwards wave dependency | **Resolved for the app handoff.** WS03 provides defaulted `draft:` in A1, WS04 consumes it in A2 with an empty quote seed, and M-04-7 is superseded. The newly checked package boundary remains broken independently: finding 2 above. |
| 4 — agent retry members have no receiver | **Resolved.** WS09 receives M-03-5 with both members, failure/retry behavior and a store test; IB applies M-03-6 after it. |
| 5 — composer writability has no receiver | **Resolved.** WS02 receives M-03-7 and supplies `isBackgroundJobReadOnly`; appear/change bindings mirror it to `acceptsInput`, with resolving writable and sending separately gated. WS05 and WS07 consume that contract. |
| 6 — obsolete theme API | **Resolved.** WS04 M-10-1 calls `.preference(for:).colorScheme` and requires both WS10 provider files from A1. |
| 7 — wrong search builder | **Provider/consumer signature resolved, mount not fully resolved.** All now use `.fromProjects`; the exact receiving-site expression has the scope error in finding 1. |
| 8 — obsolete artifact attach callback | **Resolved.** WS07 and WS02 M-07-1 pass `composer`, not `onAttach`; the card owns rejection feedback and the caller retains deferred jump handling. |
| 9 — missing inbox probe method | **Resolved.** WS05's client consumption and inbox use `forgeProbe()` from WS04; `repoProbe()` appears only as a forbidden alias. Shared device members remain WS04-owned. |
| 10 — ledger/receipt integrity | **Resolved structurally.** Canonical IDs are received or explicitly assigned to integration steps. M-08-1 has a receipt/test; M-08-2 is declined; M-09-6 is accepted. Package manifests have IDs. No unexplained active orphan request or receipt found. Agreement between tables does not cure findings 1–2. |

## Canonical ledger validation

The following covers every active row. “Aligned” means requester, provider and receiver/integration assignment agree; it does not claim an implementation has been built. IA/IB/IC are the sequential A-int/B-int/C-int steps.

| Rows | Applier / sub-wave | Result and prerequisite check |
|---|---|---|
| M-01-1…4 | WS02 / B | Aligned with WS01 A1 mapper/media/display types and WS02's own F10/F11. M-01-2…4 follow M-01-1. Existing `StreamTruncationPayload` has the required `kind` and optional `messageID` (`MantaStreamModels.swift:221-225`). |
| M-01-5 | WS07 / B | Aligned display toggle; WS01 A1 provides defaults key/setter. Remains visible in read-only chats. |
| M-01-6 | IA | WS01 manifest received by the integration assignment. |
| M-02-1 | IB | WS01 records the incoming highlight mount; WS02 B provides its environment key. Existing `TranscriptCellReveal` has `item`, `tokens`, and `cellContent` (`TranscriptRow.swift:296-339`). |
| M-02-2 | WS07 / B | Read-only overflow parameter and hidden action set agree with WS02. |
| M-02-3 | IB | WS02 manifest assigned after B. |
| M-03-1…4 | WS03 / A1 | Aligned adoption exception; D2 wave-0 scaffold is the prerequisite. Existing wrapper takes `seed: String?` and content init takes `seed: String = ""`; passing `target.seed ?? ""` is valid optional promotion, not a type error (`ChatScreen.swift:138,154,297`; `SessionListView.swift:136`). Draft application is separate and one-shot. |
| M-03-5 | WS09 / B | Explicit receipt; adds retry/error members to the real existing `loadAgentsIfNeeded` flow (`ChatModelStore.swift:135-143`). |
| M-03-6 | IB | Exact `agentRows(agents:loadError:query:limit:)` signature; after M-03-5. |
| M-03-7 | WS02 / B | Explicit receipt and transition tests; after controller adoption. |
| M-03-8 | IA | WS03 Foundation manifest assigned after A2; controller/draft adapter stays app-only. |
| M-03-9 | IB | Reads WS02 B `mutationPolicy`, after M-03-6. **No missing store injection:** actual `ComposerView.swift:48-54` already has `@ObservedObject var store: ChatSessionStore`; WS03 explicitly keeps that view API unchanged. |
| M-04-1…2 | WS07 / B | Optional/defaulted parameters and `SessionModeRows` call align; WS04 A2 + WS10 A1 provide the types. Existing capture callers remain valid. |
| M-04-3…6 | WS02 / B | Aligned live-name lookup, rename, static window key/mode switch, catalog retry and switcher. `SessionModeStore.read(sessionID:)` is legal because its `defaults:` argument is defaulted in WS04. |
| M-04-8 | IA | Ownership and schedule agree; **package type closure fails: finding 2**. |
| M-05-1 | WS05 / C | Header signature matches provider; after WS02 B and M-03-3/7. Writability binding is verified, not separately reinvented. |
| M-05-2…3 | WS05 / C | Inbox/draft and review mounts received by WS04; after A2 navigator, review applied after inbox. |
| M-05-4 | IC | Pure WS05 manifest; draft conversion explicitly excluded from Linux. |
| M-06-1 | WS02 / B | Same-wave provider signature pinned; **receiving expression invalid: finding 1**. |
| M-06-2…3 | IB | Session-list search and package manifest aligned; M-06-2 precedes M-09-2. |
| M-07-1…2 | WS02 / B | Aligned artifacts/webhooks parameters and deferred jump; controller A1, navigator A2, writability M-03-7, pinned WS07 B views. |
| M-07-3…4 | IB | Agent-file notice before usage mounts and beneath upgrade overlay; pure manifest follows WS03 M-03-8. |
| M-08-1 | WS09 / B | Explicit receipt observes A2 `.mantaProvidersChanged`; calls non-async `reload()` with the specified actor hop and test. |
| M-08-3 | IA | Four sources/three tests agree with WS08 manifest. |
| M-09-1 | IB | WS10 receives Models row under accounts; WS09 B provides `ModelsScreen()`. |
| M-09-2 | IB | WS04 receives capsule using its own count and WS09's `presentResume`; follows M-06-2. |
| M-09-3…4 | IB | WS04 receives root binding, banner, sheet and resets; after M-07-3 and A2 M-10-2. Reset APIs agree. |
| M-09-5 | WS02 / B | Explicit active-session receipt; guarded clear on disappear/background. |
| M-09-6 | IB | Accepted by WS08; provider `ModelsScreen()` exists after B. |
| M-09-7 | IB | Ten pure sources/five tests agree with WS09 manifest; stopped-record adapter remains app-only. |
| M-10-1…2 | WS04 / A2 | Exact theme and box-removal receipts; both follow WS10 A1. Existing `backToEntry()` and `isSwitching` exist in `MantaOnboarding.swift:71,157`. |
| M-10-3 | IA | WS10 package manifest assigned after A2. |
| O-final | Orchestrator / final | Single pbxproj regeneration after C-int; no workstream requires a project.yml edit. |

Inactive rows are consistently classified: M-04-7 superseded by M-03-4; M-08-2 declined. Old decoder, seat-row and settings-navigation entries are no longer active requests. M-03-6/9 target an inactive wave-B owner and therefore correctly go to IB, not a second concurrent worker.

## Shared-member and ownership audit

- **Client registry:** compared all ten client-member tables with the registry and the existing base client. No duplicate new member declaration or redeclaration of an existing base member found. Shared ownership is consistent: launcher discovery/theme/forge status/restart → WS10; references/commands → WS03; probe/device flow/stopped list → WS04; stopped mutations → WS09. Consumer labels and return types match those providers.
- **Other shared types:** mapper/command/truncation interfaces, composer Bool APIs and rejection enum, navigation/draft types, search adapter, artifact initializer, account notification, model retry and usage presentation APIs agree. WS04 and WS09 now both use epoch-millisecond `Double` stopped timestamps. WS04's sign-in contract incorporates WS05's async cancel/generation lifecycle. Findings 1–2 concern actual receiving scope and target membership, not duplicate declarations.
- **Duplicate types/files:** no independent duplicate top-level type or new-file ownership collision found. Repeated `GitHubDeviceSignInView` in WS05 is a quoted consumption contract; repeated `Kind`/`Phase` declarations are nested.
- **Sub-waves:** A1 has one ChatScreen editor (WS03); A2 has one root/list/terminal editor (WS04); B has one chat/store/event editor (WS02), one overflow/cards editor (WS07), and one model/catalog editor (WS09). Later root/list/settings/composer/package mounts are assigned to the single integration agent. C has WS05 alone. No same-file/same-sub-wave concurrent worker edit found under D18/D20.
- **Server scope:** edits remain WS08 `ptyWs`, WS10 device/auth/index, and WS09 unidentified-model module/RPC; they fit D7 and do not overlap within a sub-wave. No additional server surface is requested by this review.

VERDICT: CHANGES REQUIRED
