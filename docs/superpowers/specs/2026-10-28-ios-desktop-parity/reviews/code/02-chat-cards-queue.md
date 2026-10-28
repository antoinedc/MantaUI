# Code review — WS02 chat cards / queue (commit `ed9eaf3a`)

Scope: every changed file in `ed9eaf3a` (server `delegateView` / `inboxCopy` / `boxCapabilities` / `version`, shared `formatTokens` / `streamInterpretation`, the desktop migration, all iOS files) plus the not-yet-applied applier `_appliers/ws02-srv-rows.patch`.

Verification I ran: a throwaway worktree of `ed9eaf3a` with the applier patch applied.
- `git apply --check`: the patch applies cleanly.
- WS02 node suites (`rpc.delegateView`, `streamInterp.chatCards`, `delegateView`, `inboxCopy`, `boxCapabilities`, `version`, `streamInterp`, `rpc.inbox`): 130/130 pass.
- Full `npm test`: vitest 4874 pass. node: 2 failures. One is caused by the patch (finding 3). The other, `modelLedger` stale-while-revalidate, is a timing flake: 40/40 pass when re-run on its own.
- `npm run typecheck`: the only errors are in `ArtifactsPanel.tsx` and `SearchPalette*.tsx`. Those are WS07/WS06 rows still waiting on integration agent B, not WS02. No WS02 file errors, and no reference to a deleted export is left (grep across `src/renderer`, `src/main`, `src/preload`).

## Findings

### 1. BLOCKING — iOS "Start job" turns the job's `deny` rules into `allow` rules (security)
`mobile/native/MantaUI/MantaAPIClient+ChatCards.swift:37`
```swift
let payload: [[String: String]] = tools.map { ["permission": $0.permission, "pattern": $0.pattern] }
```
The approval tool's `action` is dropped from what is sent. On the box, `buildPermissionRuleset` (`delegate.mjs:296`) treats any rule without `action:"deny"` as `allow`. iOS always sends a non-empty list, and the engine uses an edited list in place of the original request (`delegate.mjs:4787`). So any declared deny rule (for example `bash: rm *` deny) becomes an **allow** when the job is approved from the phone, even if the user never opened "Edit access". The desktop sends the whole tool object and keeps `action`.

**Fix:**
- Build the payload as `[String: Any]` and include `"action": action` when it is non-nil:
  `tools.map { t -> [String: Any] in var d: [String: Any] = ["permission": t.permission, "pattern": t.pattern]; if let a = t.action { d["action"] = a }; return d }`
- Add a test that a `{permission:"bash", pattern:"rm *", action:"deny"}` tool reaches the wire with `action:"deny"`, using the `MantaActionRPCWireTests` capture pattern.
- Optional: in the editor, show deny rules as "deny: …" so the user can see what they are approving.

### 2. BLOCKING — every first chat open sits up to 30 s in "Can't confirm this session yet", and sends are held
- `ChatCardCapabilities.swift:334-344` (`refresh()` returns early while `inFlight`)
- `ChatCardJobOwnershipStore.swift:230-249`
- `ChatSessionStore.swift:562`
- `ChatScreen.swift` `onAppear` (calls `store.start()` before `wireChatCards()`)

What happens on first open:
1. `store.start()` enqueues `Task { await chatCardCapabilities.refresh() }`. That task sets `inFlight = true` and suspends on the network call.
2. `wireChatCards()` then enqueues `jobOwnership.resolve()` on the same shared `ChatCardCapabilities`.
3. `resolve()` sees `has(...) == nil` and calls `refresh()`. Because a load is already in flight, `refresh()` **returns immediately without waiting**. The capability is still nil.
4. `resolve()` therefore sets `lastFailure` and applies `.failure`. The policy stays `.resolving`.
5. The red "Can't confirm this session yet — messages you send will wait" line appears, and every send is held.
6. Nothing re-resolves when the capability list lands. Recovery comes only from the 30 s `.task(id: needsPolling)` tick, a `delegate.updated`, a reconnect or the Retry button.

The same thing happens after any reconnect that arrives while the capability list is still unknown. The store tests use fake loaders and run one caller at a time, so they cannot see this.

**Fix:**
- Give `ChatCardCapabilities` a shared `private var loadTask: Task<Void, Never>?`. `refresh()` starts it if it is nil and always `await loadTask!.value`, so a concurrent caller waits for the same answer instead of returning early.
- Also have `ChatCardJobOwnershipStore` subscribe to `capabilities.$ids` and call `resolve()` when the list goes from nil to non-nil (belt and braces).
- Add a store test: a loader that suspends until released, `store.start()` and `jobOwnership.resolve()` started concurrently, then release. Expect `.allowed`, `lastFailure == nil`, and a held prompt that was delivered.

### 3. BLOCKING — the applier patch makes `npm test` red
`_appliers/ws02-srv-rows.patch`, `index.mjs` hunk at the `buildHandlers` call: `delegateView,` is inserted between `delegate: delegateEngine,` and `handoff: handoffEngine,`. That breaks `src/server/handoff/wiring.test.mjs:121` (`/delegate: delegateEngine,\s*handoff: handoffEngine,/`). I reproduced it by applying the patch and running `npm test`: `not ok 3633 - index.mjs: the engine is wired into every seam the spec names`.

**Fix:** put `delegateView,` after the `handoff: handoffEngine,` line, or anywhere else not between those two keys. Regenerate the patch and re-run `npm run test:server` with it applied.

### 4. SHOULD — what the read-only-job 409 guard does and doesn't cover (answer to the brief's question)
The five guarded channels look correct:
- The guard is the first statement of each handler. It runs before the CTO branch, the handoff admission branch, `handoff.guardCommand` and the background-command path. None of these can route a job session's request around it, because each routes on the already-checked `input.sessionId`.
- The `rpcStatus` branch can't be triggered by anything except `ReadOnlyJobError` (grep: no other `rpcStatus` in `src/`), and it runs ahead of the `HandoffError` branch without shadowing it (tested).
- Auth: the guard sits behind the existing `/rpc` bearer gate.

**It can still be bypassed through other channels that act on a job session:**
- `opencode:permission-reply`, `opencode:question-reply`, `opencode:question-reject`. These answer the job's own asks. The iOS gate refuses them, but the box does not.
- `opencode:abort`: interrupts the job's turn without going through `delegate:stop`, so the job record never learns the job was stopped.
- `opencode:clear-session`, `opencode:delete-session`, `opencode:delete-session-raw`.
- `handoff:create` / `handoff:start` / `handoff:set-mode` with the job session's id.
- Prompts injected without going through `/rpc`: `schedule` jobs targeting the job session, `webhooks`, `POST /api/peers` (`peers_message` → `oc.sendPrompt`).

The spec's C10 lists only the five channels, so this is not a spec deviation. But if the bar is meant as a real authority, it is not one yet.

**Fix:**
- Minimum: add `await delegateView?.assertWritable(input?.sessionId)` to permission-reply, question-reply, question-reject and `opencode:abort` (abort's argument is the session id), and add them to the table-driven test.
- Then either guard the handoff channels, or list the remaining deliberately unguarded paths (agent-to-agent tools, scheduler, webhooks, destructive session ops) in the `delegateView.mjs` header, so nobody believes the guard is complete.

### 5. SHOULD — `assertWritable` does N+1 file reads on every message
`delegateView.mjs:134-142`. Wiring: `listJobs: (f) => delegateEngine.listJobs(f ?? {})`.

The engine's `listJobs` loads the whole job store and then calls `readProgress()` for every record that has a child session. Each of those calls re-reads and re-parses `progress.json`. That cost now lands on every `opencode:prompt`, every inbox action, every compact and every run-command, in every session, including sessions that have nothing to do with jobs.

**Fix:**
- Pass a raw loader into the view (`loadJobs: () => delegateEngine.loadRecords?.() ?? loadJobs()`, or a new engine method `findRecordForSession(sid)`, like the existing `isRunningJobSession`). Use it in `jobFor()`.
- Keep `listJobs` only where progress is needed (`decorateList` is handed the list already).
- Add a test that `assertWritable` never calls the progress reader.

### 6. SHOULD — while `.resolving`, the blocking cards in the main chat are dead buttons
`ChatScreen.swift:1265` uses `readOnlyCardActions` for anything that isn't `.allowed`. The permission, question and plan cards keep their Allow / Deny / Submit buttons, but the closures do nothing and say nothing. That breaks the root AGENTS rule "NEVER STUB A CONTROL TO DO NOTHING". Finding 2 makes it far more visible, since `.resolving` would last up to 30 s on every open.

The store already gates and reports these actions: `replyPermission` / `replyQuestion` → `requireMutation()` → hint "One moment — checking this session".

**Fix:**
- Use the live `cardActions` for both `.allowed` and `.resolving`, so a tap reports why it can't act yet.
- Keep `readOnlyCardActions` only for `.readOnlyJob`.
- Update the spec line "Blocking cards render inert" to match.

### 7. SHOULD — notice (and compaction) latch stuck after `stop()`
`ChatSessionStore.swift:570` (`stop()`) cancels `compactionExpiry` and `noticeExpiry`, but leaves `latch.scheduled == key`. After a subagent push and pop (`stop()` then `start()`), `observe(key, expiring: true)` returns `(visible: true, schedule: nil)`, so no timer is ever started again.
- The "Compacted while you were away" line then stays pinned until the next background compaction. Nothing else clears `compactionNotice`.
- A `.done` compaction card stays until `transcriptStale`.

**Fix:**
- In `stop()`, expire whatever key is scheduled (`if let k = compactionLatch?.scheduled { expireCompaction(k) }`, and the same for the notice). Alternatively, add a `mutating func reschedule()` that clears `scheduled` without expiring, so `start()` restarts the timer.
- Add a latch or store test for stop-then-start inside the hold window.

### 8. SHOULD — spec'd tests missing
`ChatCardsStoreTests.swift` has no:
- **#16** end-to-end case (mapper + store): a live `truncation` on a settled message with no canonical metadata shows the footer badge; an unknown kind keeps the notice; an incomplete-snapshot message keeps the notice. Only the pure `trailingBlocks` case exists.
- **#18** M-03-7 test with a real `ComposerTextController` (`acceptsInput` true while resolving, false for a job, true again afterwards).
- **#19** Load earlier while focused: index 12 keeps `messageLimit` and `messages` and reveals 12 rows with no refetch; index 0 also widens; the `.tooFarBack` copy for a target beyond 500 messages.
- **#20** M-01-7: `slim` follows `TranscriptDisplayOptions.showDetails`; `didChange` causes one refetch.
- **#21** `PendingMessagesCard` gate: unknown capability = disabled with no note; absent capability = the "Update your box to use this" note.

Add these, plus the concurrency test from finding 2 and the wire test from finding 1.

### 9. NIT — desktop job view
`ChatPanel.tsx` `refreshJobView`:
- Overlapping `delegate.updated` refreshes can land out of order, and an older answer can overwrite a newer one. Guard with a request sequence ref.
- While the capability is still `null`, a job session shows the composer. The box will answer 409 and the error line shows, which is acceptable, but `jobsCapability === null` could keep the composer disabled instead.

### 10. NIT — `formatTokenCount` goes beyond the spec text
`src/shared/formatTokens.mjs`: values of 1M and above render as "1.2M". SF-2 / D26 only describes "else rounded k". The output is byte-identical to the deleted `SessionHeader.formatTokensCompact`, so behaviour is preserved and this is correct. Update the D26 / SF-2 wording to match.

### 11. NIT — M-02-4 follow-ups for integration agent B
- Deleting `BackgroundJobFormat.statusLabel` breaks `MantaUITests/SessionActivityOrderTests.swift:362-364`. Add their removal to the M-02-4 row.
- `BackgroundJobsSheet.detailLine` on an old box with an empty `status` now prints an empty word; it used to print "unknown". Cosmetic.

### 12. NIT — approval editor row identity
`ChatCardViews.swift:276`: `ForEach(Array(tools.enumerated()), id: \.offset)` with `TextField`s. Removing a middle rule shifts every later row's identity, so focus and in-progress edits can jump to the wrong row. Keep a local `[(id: UUID, tool)]` for the editor.

### 13. NIT — compile order on the Mac
`ChatScreen.swift` and `UsageSheets.swift` use pinned symbols that are not on the branch yet:
- `UsageAlertsStore.shared.activeSessionId` and `UsageMeters.band(_ window:)` (WS09, in progress)
- `DelegateJob.statusLabel` / `.summary` (M-02-4, integration agent B)

This is expected by the ledger. The Mac build of this commit only goes green after WS09 and integration agent B land M-02-4, M-02-1 and M-02-3, so `test-unit` cannot yet confirm WS02 on the Mac.

## Checked and fine (no action)
- **Shared copy.** `describeRetry`, `compactionFirstLine`, `describeBackgroundCompaction` and `describeSessionError` (incl. `accountsId`) match SF-1…SF-3.
- **Stream interpreter.** It resets `compactionText` on `started` and after `ended`.
- **Inbox copy.** `inboxCopy` covers cancelled-without-item for both `restore` values and never dereferences a missing item.
- **Approve rule check.** `validateApprovalTools` refuses empty lists and blank fields, and keeps the approval pending.
- **Back-compat.** Every new field and channel is additive. The new `rpcStatus` branch doesn't shadow `HandoffError`. `compact-session` still returns its value after becoming `async`.
- **Desktop migration.**
  - All nine deleted helpers are gone with no remaining callers, and `providerIDRef` is removed.
  - `SessionHeader` uses `formatTokenCount` at all five sites.
  - Every inbox action and the ↑ pop-last path are capability-gated, and pop-last returns `false` so the key falls through to prompt history.
  - Approve shows the box's `error`.
  - Stop failures are no longer swallowed.
- **iOS.**
  - Swift 6 isolation looks correct: the stores are `@MainActor`, the API protocols are `Sendable`, `MantaAPIClient` is `Sendable`, and the test fakes are `@unchecked Sendable`.
  - Switches are exhaustive.
  - The token and metric names used all exist.
  - Mount signatures (M-03-7, M-04-3…6, M-06-1, M-07-1/2, M-02-2 argument order) match their providers.
  - The focus planner, focus machine and highlight rule follow the spec.
  - The trailing-error suppression for the reconnect case is in place.

Counts: 3 BLOCKING, 5 SHOULD, 5 NIT.

VERDICT: CHANGES REQUIRED
