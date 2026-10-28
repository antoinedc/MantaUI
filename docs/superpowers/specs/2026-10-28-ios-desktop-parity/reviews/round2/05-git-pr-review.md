# WS05 review — round2

## Round-1 disposition

- **1 resolved:** E.2/E.4 now use the confirmed create flow; dropping the issue stamp is explicitly authorized by master D12.
- **2 resolved in ownership/public view:** D14's `GitHubDeviceSignInView` is reused. Remaining client-name disagreement is finding 1 below.
- **3 locally resolved, integration incomplete:** A.3a supplies both guards, but the controlling read-only property has no matching WS02 mount receipt (finding 2).
- **4 resolved:** immutable merge target captured before the dialog; no force unwrap; replacement/clearing tests specified.
- **5 resolved:** preview keys include cwd/branch/base and late responses are discarded.
- **6 resolved:** LEFT/RIGHT threads use old/new coordinates, with the unequal-offset test.
- **7 resolved:** interactivity explicitly requires recognized forge kind and forge branch.
- **8 resolved in WS05's behavioral contract:** cancellation, generation guards and a single-loop foreground wake are now specified. WS04's detailed contract still disagrees (finding 3).
- **9 resolved:** Done is disabled and guarded, in addition to interactive dismissal prevention.
- **10 resolved:** package integration names WS07 ownership and the wave-C integration step, consistent with D18/D20.

## Findings

1. **BLOCKING — §1, §6.2, §10, §12 / WS04 Client members: the repository probe consumer calls a nonexistent provider member.** WS05 requires `repoProbe()` and explicitly forbids adding `forgeProbe`; WS04's actual pinned public member is `forgeProbe() async throws -> ForgeProbeResult`. Neither the existing client nor WS04 supplies `repoProbe()`, so the inbox loader as specified cannot compile. The same tables disagree on `githubDevice*` versus WS04's `forgeDevice*`, although WS05 correctly calls only the sign-in view. **Evidence:** `05-git-pr-review.md` §1 consumed-member table and §12 exclusion list; `04-sessions.md:1285-1288,1299-1301` declares `forgeProbe`/`forgeDevice*`; `src/server/rpc.mjs:944,1070-1072` supplies the underlying existing RPCs. **Fix:** use WS04's exact `forgeProbe()` name and `ForgeProbeResult` throughout WS05, and describe its consumed device methods as `forgeDevice*` (no direct calls). Update WS04's stale reuse note to remove the assertion that WS05 calls worktree/device methods. Do not add alias methods to paper over the disagreement.

2. **BLOCKING — §2 A.3a, M-05-1 / WS02 Mounts applied: the read-only guard depends on an unacknowledged and differently named mount.** WS05 removes its `readOnly` input and relies entirely on `composer.acceptsInput` being set by M-03-7. WS03 requests that mount, but WS02's exhaustive receipt table omits it and instead promises `ChatSessionStore.isBackgroundJobReadOnly` for `GitSessionHeaderRow(readOnly:)`. WS03/WS05 additionally phrase the source as `jobOwnership.job`, which WS02 does not pin as a public symbol. Since the controller defaults to `acceptsInput = true`, independently implementing the receiving spec leaves review/check insertion enabled in a background-job chat. **Evidence:** `03-composer.md:483-484,599`; `02-chat-cards-queue.md:442-443,785-808,820`; WS05 A.3a and M-05-1. **Fix:** add M-03-7 to WS02's applied-mount table and bind the controller to the canonical `!store.isBackgroundJobReadOnly` state on initial resolution and every policy change. Update WS03 and WS05 to that same source; remove WS02's obsolete `GitSessionHeaderRow(readOnly:)` promise. Require a cross-component test opening both sheets in a resolved read-only job and confirming no insertion control or write is possible.

3. **SHOULD — §4 C.3 / WS04 sign-in contract: lifecycle fix is claimed but not consistently specified by its implementing owner.** WS05 requires a generation guard covering late starts, cancellation awaited before `onCancel`, logged cancellation failures, and foreground wake signaling the one existing loop. WS04 says it adopts this contract, but its concrete API declares `cancel()` with a result-ignored comment, its cancel seam cannot throw, and its foreground description independently polls/reschedules using grant identity rather than the required generation token. Its listed tests omit the late-start/dismiss and cancellation-failure cases. **Evidence:** `04-sessions.md:622-647,681-691,731-734`; WS05 §C.3 Lifecycle and lifecycle-test list. **Fix:** make WS04's API, detailed lifecycle and tests explicitly implement WS05 C.3: define the async dismissal/cancel completion contract, identify where failures are logged, guard starts before a grant exists, and route foreground wakes through the existing loop. Remove the contradictory result-ignored wording. Ownership and the shared view name themselves are now correct.

## Cross-spec checks

M-05-2/M-05-3 match WS04's session-list inbox/review integration and pending-draft create flow. M-05-4 follows D19/D20; WS10 includes the Foundation-only `SettingsWireModels.swift` dependency containing `ForgeConnectionStatus` in its package manifest. WS05's own newly declared client members do not collide with other workstreams. No new server surface is requested.

VERDICT: CHANGES REQUIRED
