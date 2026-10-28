# Round 2 — cross-cutting seams

Reviewed all ten revised specs against master D1–D21 and searched the current Swift code. Line references below refer to the revised specs, relative to this folder, unless a repository path is given. This is a specification integration review, not a claim that the proposed code has been compiled.

## Round-1 disposition

| Round-1 finding | Result in round 2 |
|---|---|
| 1 — conflicting draft types | **Type declaration resolved:** D11, WS03 F7 and WS04 §12 use the single D2 type. **Consumption remains broken:** see finding 3. |
| 2 — new-session confirmation bypass | **Resolved by explicit decision:** D12 accepts the quote-fork exception; WS05 now passes a draft and waits for Create, with no eager worktree creation or forgeIssue association. |
| 3 — composer adoption owner/wave | **Resolved:** WS03 M-03-1…4 performs adoption in A1; WS02 consumes it. Later composer mounts still have missing receipts (findings 4–5). |
| 4 — duplicate GitHub sign-in implementations | **Resolved:** D14/WS04 provide GitHubDeviceSignInView/Store; WS05 no longer creates a second flow. Client references still contain old names (finding 9). |
| 5 — C5 consumer/provider mismatch | **Not resolved:** command map name now agrees, but conversion type, media properties and truncation dependency do not (finding 2). |
| 6 — duplicate shared client methods | **Original duplicates resolved:** stopped-list belongs only to WS04; forgeStatus(validate:) only to WS10. Launcher provider is now absent rather than duplicated (finding 1). |
| 7 — same-wave shared-file edits | **Resolved by D18/D20:** integration agents own later-wave root/list/settings/package edits; A1/A2 separate prerequisite work. No remaining two-worker same-file/same-subwave edit identified under those binding decisions. |
| 8 — missing/conflicting mount receipts | **Partially resolved:** appliers are named, but receiver tables still implement old requests; several new requests have no receipt. See ledger and findings 2–8, 10. |
| 9 — duplicate stopped-state stores/backward dependency | **Resolved:** WS09 removes UsageStoppedStore, consumes WS04's records; WS04 no longer depends on WS09 for A2 row markers. |
| 10 — package/project ownership and schedule | **Resolved:** D18–20 assign integration A/B/C and one final orchestrator pbxproj regeneration. WS04/08/09 provide manifests even where they lack numbered request rows. |
| 11 — duplicate seat-row providers | **Resolved:** D17 makes this WS02's existing conversationSeat projection; WS09 F8 removed. |
| 12 — composer behavior drift | **Resolved in provider/consumers:** Bool returns, blank-line append and existing quote formatting agree. The master's older C3 wording is superseded by its binding decisions; no blocker on that wording alone. |

## Findings

1. **BLOCKING — D21 / WS10 F12 and client members / WS04 launcher consumers: no spec supplies the canonical launcher API.**
   - D21 assigns `launchersList()`, `AvailableLauncher` and `ExtensionsLaunchers.resolve` to WS10. WS04 correctly consumes them and removes its old discovery member (`04-sessions.md:160-161,1295-1296,1353-1354`). WS10 instead explicitly consumes the removed WS04 `launchers()`, `SessionLauncher` and `SessionLauncherFlags.resolve`, and its complete client table contains no launcher method (`10-settings-box.md:435-438,935-956,1201,1283`). Neither can implement/compile its launcher UI from the promised provider surface.
   - The overflow receiver compounds this: WS04 requests `SessionModeRows` with catalog/retry parameters and `[AvailableLauncher]` (`04:1312,1315`); WS07 implements the old three-argument view with `[SessionLauncher]`, no catalog/retry parameters (`07:879`).
   - **Fix:** Implement D21 explicitly in WS10's types, client-member table and F12. Pin the resolver signature and wire fields there. Replace WS07's receiver row with M-04-2 verbatim (including optional mode, catalog, retry closure), and make WS02 pass those exact fields in M-04-5. Do not restore WS04's removed provider as a workaround.

2. **BLOCKING — WS01 M-01-1…4 / WS02 F11 and receipts: transcript integration targets nonexistent symbols and can suppress the only truncation warning.**
   - WS01 defines `TranscriptMediaStore.sessions`, `entries(for:) -> [TranscriptMediaEntry]`, `TranscriptCommandOrigin.fromLive`, a `liveTruncations` mapper input and `footerTruncationMessageIDs` (`01:314-324,1215-1226,1371-1374`). WS02's receiver still uses dictionary `entries[sessionId]` and `$entries` (`02:793,795`), converts to the former `OpencodeCommandOrigin` (`02:657-658`), and explicitly drops `truncationByMessageID` even though WS01 now requires it (`02:660-661` versus `01:831,1371,1373`). These are missing/type-incompatible members, not harmless old IDs.
   - WS02 also suppresses the trailing warning whenever its message exists (`02:796`), whereas WS01 requires suppressing it only when an actual rendered footer contains that truncation (`01:1374`). A message without a footer can lose its warning altogether.
   - **Fix:** Update WS02's receipt to the four current request IDs and signatures, including the exact command conversion, media subscription and rendered-footer predicate. Resolve the new live-truncation requirement explicitly: provide the bounded map in WS02, or redesign WS01 to consume the existing single truncation without referencing an absent map. Keep the master C5 amendment aligned with that decision. The existing server payload uses string arguments (`src/server/streamInterp.mjs:1037-1040`), so no wire change is needed.

3. **BLOCKING — WS03 M-03-4 / WS04 M-04-7: the create-flow draft handoff still has incompatible entry points and a backward wave dependency.**
   - WS03 provides `ChatScreen(draft:)` and `ChatScreenContent(draft:)` in A1, with `apply(_:)` converting attachments through the composer API (`03:518-522,545-555,596`). WS04 instead calls a new `ChatScreen(initialCarryOver:)` in A2 and asks WS02 to add that initializer only in B (`04:1174-1183,1317`). Defaulting the new parameter in B cannot make an A2 call to a nonexistent parameter compile. WS02's receipt still promises `seedAttachments`, a field WS04 has replaced with `carryOver` (`02:798`; `04:1216`).
   - **Fix:** Select one end-to-end transport. Prefer the already-provided A1 `draft:` path: carry the post-confirmation draft in SessionOpenTarget and pass it once; remove M-04-7 and the old seedAttachments receipt. If retaining the master's permitted internal HandoffCarryOver transport instead, have WS03 supply its initializer in A1 and pin its conversion/one-time application. Ensure draft text is seeded once, not through both `seed` and carry-over/apply.

4. **BLOCKING — WS03 M-03-5 / M-03-6 versus WS09 receipts: agent retry UI depends on members nobody implements.**
   - WS03 requests `ChatModelStore.agentsLoadError` and `retryAgents()` from WS09, then assigns the integration agent to consume them in ComposerView (`03:597-598`). WS09 says no request targets any of its files and does not include those additions in its ChatModelStore edit plan (`09:1181-1184,1237-1245`). Existing `mobile/native/MantaUI/ChatModelStore.swift:137-139` only has `loadAgentsIfNeeded`/`didLoadAgents`; the requested members do not exist.
   - **Fix:** Add M-03-5 to WS09's received/applied table, file plan and checks; define both members exactly as WS03 requests. Apply M-03-6 only after that commit. Otherwise the integrated composer does not compile (or its retry action is omitted).

5. **BLOCKING — WS03 M-03-7 / WS02 read-only mount / WS05 composer bridge: writability is never propagated to the shared controller.**
   - WS03 defaults `acceptsInput` to true and requests WS02 to maintain it (`03:483-484,599`). WS02's complete receiving table has no M-03-7 (`02:791-804`), and its read-only behavior only replaces the composer view, clears transcript actions and exposes `store.isBackgroundJobReadOnly` (`02:432-443`). WS05 no longer takes the read-only argument WS02 promises: its header/bridge reads only `composer.acceptsInput` (`05:234-244,264-275`). Consequently a background-job chat can still show send-to-agent controls that insert into a hidden composer, reporting an outcome the user cannot use.
   - **Fix:** Add M-03-7 to WS02's actual read-only transition logic and receipt; update it on every ownership resolution, including transitions back to allowed. Pin whether resolving permits composer insertion (current F6 permits typing) separately from sending. Test the real controller value through read-only transitions and the WS05 bridge, rather than relying on hidden ComposerView alone.

6. **BLOCKING — WS10 M-10-1 / WS04 theme receipt: the applier calls an API the provider deliberately moved.**
   - WS10's Foundation-only helper is `SettingsAppearance.preference(for:) -> ThemePreference`; the SwiftUI extension supplies `ThemePreference.colorScheme` (`10:183-188,1172`). WS04's applied row still calls `SettingsAppearance.colorScheme(for:)` (`04:1323`), which WS10 does not provide.
   - **Fix:** Replace WS04's receipt with `.preferredColorScheme(SettingsAppearance.preference(for: themePref).colorScheme)` and list both provider files as prerequisites. It belongs in A2 under D20/D21; the old A fallback wording is not an alternative dispatch plan.

7. **BLOCKING — WS06 M-06-1 / WS02 search receipt: wrong scope-builder signature.**
   - The pure builder takes `windows: [SearchScopeWindow]` (`06:318-323`); the app adapter is `SearchScope.fromProjects(_:primarySessionId:)` (`06:505,558,568`). WS02 still calls `SearchScope.build(projects:primarySessionId:)` (`02:799`). No provider defines that overload.
   - **Fix:** Use the exact M-06-1 adapter invocation in WS02 and replace its old receipt ID with M-06-1. Do not add a second overload solely to preserve obsolete mount text.

8. **BLOCKING — WS07 M-07-1 / WS02 artifacts receipt: removed callback instead of the controller parameter.**
   - WS07 now declares `ArtifactsCard(...composer:onJumpToMessage:)`, performs upload/attach and handles Bool rejection inside the card (`07:287-313,860`). WS02 still passes an `onAttach` closure (`02:800`). That initializer label is no longer provided; omitting the incompatible argument instead leaves `composer` nil and hides Attach to message.
   - **Fix:** Replace the receiver's old artifact row with M-07-1 exactly: pass `composer: composer`, retain the deferred jump callback and let the card own attach feedback. Also receive M-07-2 under its canonical ID.

9. **BLOCKING — WS05 inbox / WS04 client members: missing probe method.**
   - WS04 supplies `forgeProbe() -> ForgeProbeResult` (`04:1285`) and specifically tells WS05 to consume it (`04:1299-1301`). WS05 calls `repoProbe()` for its inbox checkout lookup (`05:7,49,805,949,1003`); no current client or provider spec implements that method. The code search found neither as an existing base-client member, so there is no compatibility alias to rescue the call.
   - **Fix:** Change WS05's actual inbox call and all consumed-member rows to `forgeProbe()`. Also replace its obsolete `githubDevice*` client references with `forgeDevice*` (WS05 presents the shared view rather than calling them directly, so those references alone are documentation drift, not another blocker).

10. **SHOULD — D18 mount ledger integrity: receiver tables still use obsolete request identities and claim nonexistent cross-checks.**
    - The normalized ledger below identifies all unmatched/obsolete entries. Not every missing receipt is a runtime defect: WS09 already plans the provider-change observer (`09:234-235`), despite denying M-08-1 exists (`09:1239-1245`); optional M-08-2 is expressly declined; old WS02 navigation and WS10 settings-init requests are now providers' own work. These are ledger defects, not additional BLOCKING findings.
    - **Fix:** Use current M-xx-n IDs in both directions; mark removed requests as superseded instead of presenting them as active mounts. Add M-08-1's receipt and its requested check. Reconcile optional M-09-6: WS08 accepts it under the old M7 name (`08:1004`), while WS09 says default not applied unless accepted (`09:1232`); record it as accepted for integration B. Remove stale “none targets my files” assertions. Give the WS04/08/09 package manifests IDs if machine-checking this ledger.

## Consolidated MOUNT LEDGER

Abbreviations: **IA/IB/IC** = sole integration agent after A2/B/C; **O-final** = orchestrator final project regeneration. A1/A2 below apply D20 even where a workstream still says only “A.” All filenames without a directory are under `mobile/native/MantaUI/`. “Receipt” means an explicit matching applied/received row, or the master's explicit integration assignment; an old ID is normalized only when its intent is identifiable. This table records discrepancies, not permission to implement obsolete receiver text.

| Request ID | Receiving file | Applier | Wave | Provider symbols | Receipt / reconciliation |
|---|---|---|---|---|---|
| M-01-1 | ChatSessionStore.swift | WS02 | B | TranscriptMapOptions; blocks(options:); TranscriptCommandOrigin.fromLive; entries(for:); truncationByMessageID | Old WS01 M3a/M3e receipt; incompatible symbols, finding 2 |
| M-01-2 | ChatSessionStore.swift | WS02 | B | liveMediaTail(messages:live:) | Old M3b receipt; reconcile exact signature with request |
| M-01-3 | ChatSessionStore.swift | WS02 | B | TranscriptMediaStore.$sessions; TranscriptDisplayOptions.didChange | Old M3c uses $entries, finding 2 |
| M-01-4 | ChatSessionStore.swift | WS02 | B | footerTruncationMessageIDs(_:) | Old M3d uses message existence, finding 2 |
| M-01-5 | ChatOverflowSheet.swift | WS07 | B | TranscriptDisplayOptions.defaultsKey/setShowDetails | Receipt WS01 M4 at 07:876; same current behavior, stale ID |
| M-01-6 | mobile/native/Package.swift | IA | after A2 | WS01 package manifest | D18/D19/D20 integration assignment |
| M-02-1 | TranscriptRow.swift | IB | after B | EnvironmentValues.transcriptHighlightedRowID | WS01 received row calls it WS02 M1 (01:1390); matches behavior |
| M-02-2 | ChatOverflowSheet.swift | WS07 | B | isReadOnlyJob parameter | WS07 receipt calls it WS02 M3 (07:877); matches behavior |
| M-02-3 | mobile/native/Package.swift | IB | after B | ChatCardModels/Logic; ChatCardsTests | D18 integration assignment |
| M-03-1 | ChatScreen.swift | WS03 | A1 | ComposerTextController | Own applied table 03:606 |
| M-03-2 | ChatScreen.swift | WS03 | A1 | composer.text/attachments | Own applied table 03:606 |
| M-03-3 | ChatScreen.swift | WS03 | A1 | composerController environment; focusRequest; insert | Own applied table 03:606 |
| M-03-4 | ChatScreen.swift | WS03 | A1 | draft: NewSessionDraft; apply(_:) | Own applied table; WS04 does not use provided entry point, finding 3 |
| M-03-5 | ChatModelStore.swift | WS09 | B | agentsLoadError; retryAgents | **No receipt or implementation commitment in WS09**, finding 4 |
| M-03-6 | ComposerView.swift | IB | after B | agentRows(loadError:); M-03-5 members | D18 generic integration rule; no receiving-worker row needed; blocked by M-03-5 |
| M-03-7 | ChatScreen.swift | WS02 | B | composer.acceptsInput; jobOwnership.job | **No WS02 receipt**, finding 5 |
| M-03-8 | mobile/native/Package.swift | IA | after A2 | WS03 package manifest | D18 integration assignment |
| M-04-1 | ChatOverflowSheet.swift | WS07 | B | onRename closure | Old WS04 (a) receipt at 07:878; provider asks required closure, receiver defaults optional/hides row — align to receiver's capture-safe default |
| M-04-2 | ChatOverflowSheet.swift | WS07 | B | SessionModeRows; SessionMode; SessionLauncherCatalog; AvailableLauncher; retry | Old WS04 (b) receipt has obsolete types/initializer, finding 1 |
| M-04-3 | ChatScreen.swift | WS02 | B | SessionListStore.window(forSessionID:) | Included in old (a)–(f) receipt at 02:798 |
| M-04-4 | ChatScreen.swift | WS02 | B | SessionRenameSheet; renameSession(project:index:newName:) | Included in old (a)–(f) receipt; use current exact signature |
| M-04-5 | ChatScreen.swift | WS02 | B | switchMode/windowKey; SessionModeStore.read; launcher catalog/retry | Old (a)–(f) receipt omits current catalog/retry arguments, finding 1 |
| M-04-6 | ChatScreen.swift | WS02 | B | MantaNavigator.presentSwitcher | Included in old (a)–(f) receipt |
| M-04-7 | ChatScreen.swift | WS02 | B | initialCarryOver; SessionOpenTarget.carryOver | **No matching current receipt**; old seedAttachments incompatible; A2 caller precedes B provider, finding 3 |
| M-05-1 | ChatScreen.swift | WS05 | C | GitSessionHeaderRow; composerController/acceptsInput | Own 05:938 + acknowledged 02:804; prereq M-03-7 missing, finding 5 |
| M-05-2 | SessionListView.swift | WS05 | C | InboxWorkScreen; startNewSession | Own 05:938 + 04:1331; aligned after obsolete IDs normalized |
| M-05-3 | SessionListView.swift | WS05 | C | ReviewScreen.forSession | Own 05:938 + 04:1331 |
| M-05-4 | mobile/native/Package.swift | IC | after C | GitForgeModels/ReviewDiff/InboxWorkModels and pure tests | D20 explicitly assigns C integration |
| M-06-1 | ChatScreen.swift | WS02 | B | SearchScreen; SearchScope.fromProjects | Old request 1 receipt calls build(projects:), finding 7 |
| M-06-2 | SessionListView.swift | IB | after B | SearchScreen; fromProjects; SearchCopy.isActive/normalized | D18 + 04:1327 |
| M-06-3 | mobile/native/Package.swift | IB | after B | SearchModels/SearchTests | D18 assignment |
| M-07-1 | ChatScreen.swift | WS02 | B | ArtifactsCard(composer:onJumpToMessage:…); composer; navigator | Old request 1 receipt uses onAttach instead, finding 8 |
| M-07-2 | ChatScreen.swift | WS02 | B | WebhooksCard; ChatOverflowSheet.onWebhooks | Old request 2 receipt at 02:800 matches intent |
| M-07-3 | MantaAppRoot.swift | IB | after B | ArtifactAgentFileNotice | D18 + 04:1330; WS07 no longer edits root itself |
| M-07-4 | mobile/native/Package.swift | IB | after B | ArtifactModels/ArtifactAgentFileModel/WebhookModels + pure tests | D18 assignment; project.yml explicitly unchanged |
| M-08-1 | ChatModelCatalog.swift | WS09 | B | Notification.Name.mantaProvidersChanged; reload | **No applied-table receipt**; implementation planned at 09:234-235, documentation/check gap only |
| M-08-2 optional | UsageSheets.swift (usage seat row) | WS02 proposed | B | AccountsScreen(resignSeatId:) | **Declined** at 02:803; existing Fix remains functional; no edit scheduled |
| M-09-1 | SettingsScreen.swift | IB | after B | ModelsScreen | D18 + 10:1187 (old M1 ID); matched |
| M-09-2 | SessionListView.swift | IB | after B | UsageStoppedCapsule; UsageResume.unarmedCount; UsageStoppedEntry; stoppedRecords | D18 + 04:1328 (old M2); one stopped-state source, no missing API |
| M-09-3 | MantaAppRoot.swift | IB | after B | UsageAlertsStore.bind; UsageAlertBanner; UsageResumeSheet(sessions:usage:) | D18 + 04:1329 |
| M-09-4 | MantaAppRoot.swift | IB | after B | UsageAlertsStore/ChatModelCatalog.resetForBoxChange | D18 generic integration assignment; no specific receiving-table row |
| M-09-5 | ChatScreen.swift | WS02 | B | UsageAlertsStore.activeSessionId | Old M4 receipt at 02:801; behavior aligned |
| M-09-6 optional | AccountsScreen.swift | IB | after B | ModelsScreen | **Accepted** at 08:1004 under old M7; update ledger disposition, finding 10 |
| M-10-1 | MantaAppRoot.swift | WS04 | A2 | SettingsAppearance.preference(for:); ThemePreference.colorScheme | Old M1 receipt calls removed colorScheme(for:), finding 6 |
| M-10-2 | MantaAppRoot.swift | WS04 | A2 | Notification.Name.mantaBoxRemoved; resetForBoxChange | Old M2 receipt at 04:1324; aligned |
| M-10-3 | mobile/native/Package.swift | IA | after A2 | WS10 [pkg] manifest | D18/D20 assignment; not the old settings-init M3 |
| Manifest-only WS04 | mobile/native/Package.swift | IA | after A2 | Sources/tests listed at 04:1255-1267 | No numbered request; covered by D18/D20 |
| Manifest-only WS08 | mobile/native/Package.swift | IA | after A2 | Sources/tests listed at 08:941-950 | No numbered request; covered by D18/D20 |
| Manifest-only WS09 | mobile/native/Package.swift | IB | after B | “yes” rows at 09:1158-1193 | No numbered request; covered by D18/D19 |
| Global D18 | mobile/native/project.yml | IA/IB/IC only if manifest needs it | sequential integrations | Worker manifests | No workstream currently requires a concrete project.yml change |
| Global D18 | mobile/native/MantaUI.xcodeproj/project.pbxproj | O-final | after C integration | xcodegen / integrated project | All revised workstreams defer generation; no worker edit conflict |

### Applied/received entries without a current request

| Applied-table entry | Classification | Required ledger correction |
|---|---|---|
| WS02 “WS01 M3e” (02:797) | WS01 explicitly withdrew this decoder mount (01:1380-1381); WS02 F11 owns it intrinsically | Remove as a received request; retain F11 decoder work |
| WS02 WS04 receipt item (e) seedAttachments (02:798) | Obsolete request; replaced by M-04-7/carryOver | Resolve finding 3, then remove this entry |
| WS02 WS04 receipt item (f) message handling (02:798) | Existing C2-owned work, not a current WS04 mount row | Relabel as C2 responsibility |
| WS02 “WS09 M6 — void” (02:802) | Explicitly canceled seat-row request under D17 | Keep only in history, not active ledger |
| WS04 “M3 (WS10)” settings-init receipt (04:1325) | WS10 explicitly says this is no longer a request (10:1176-1179) | Relabel as WS04's own C2 work; do not confuse with current M-10-3 Package.swift |
| WS04 “M2 (WS02)” message-route receipt (04:1326) | WS02 explicitly withdrew it (02:782-783) | Relabel as WS04's own C2 route implementation |
| WS08 “WS02 Reconnect sheet” (08:1005) | Provider compatibility statement, not a request into WS08 files | Keep under contracts rather than received mounts |

All other old applied-table IDs can be matched semantically to ledger rows above; the symbol/behavior mismatches are explicitly flagged rather than counted as additional orphan rows.

## Declaration and edit-conflict audit

- **Duplicate public members/types:** no remaining case found of two workstreams both *declaring* the same new public client member/type. `GitHubDeviceSignInView` appears in WS05 as the consumed D14 signature, not a second declaration. `Kind`/`Phase` declarations are nested in different owners. `NewSessionDraft`, stopped-list members, forgeStatus, opencodeRestart and references each have one owner. Removed names in consumer prose are missing-provider defects above, not duplicate declarations.
- **New filenames:** no new-file collision found between workstreams' current create lists. Shared existing files are handled below.
- **A1:** WS01 owns transcript files/MantaModels/MantaUIApp; WS03 owns composer files plus ChatScreen adoption; WS10 owns settings/onboarding/upgrade/schema and D7 server changes. No shared worker edit.
- **A2:** WS04 owns sessions/root/terminal (including TerminalSocket per D20); WS08 owns accounts/provider files and ptyWs. WS04 applies WS10's root mounts after A1. No shared worker edit. The unresolved launcher API is a provider problem, not an ownership collision.
- **B:** WS02 exclusively edits ChatScreen/store/event/stream and the context sheet; WS07 exclusively edits resource cards/overflow/artifact derivation; WS09 exclusively edits model files/UsageMeters and rpc.mjs; WS06 creates search files. IA/IB are separate later steps, not concurrent worker permissions. The optional usage-seat edit is declined. No two-worker same-file edit remains under D18.
- **C:** WS05 alone applies its ChatScreen/SessionListView mounts; IC later updates Package.swift. One orchestrator generates pbxproj at the end.
- **Server:** changes remain confined to D7; this review requests no additional server route or mutation.

VERDICT: CHANGES REQUIRED
