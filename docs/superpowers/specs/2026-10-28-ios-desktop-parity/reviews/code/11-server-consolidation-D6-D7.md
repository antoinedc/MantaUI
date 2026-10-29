# Code review — WS11 server consolidation, steps D6 (close flow) + D7 (window status + job nesting)

**Scope:** the committed diffs only.
- `830e0312` (D6): `sessionClose.mjs`, `sessions:close-preview` / `sessions:close`, `deleteConversation`.
- `b9d037bd` (D7): `sessionStatus.mjs`, the `windowStatus` frame, `windows[].job`, and `tmux:list` waiting for `settled()`.

I read them from a `git archive b9d037bd` snapshot. Node tests for `sessionClose`, `sessionStatus`, `rpc`, `serverFirstGuard` and `boxCapabilities`: 166/166 pass. Neither commit has been compiled on the Mac yet; I found no Swift 6 compile risk on reading:
- The synthesized `Codable` on `MantaWindow` picks up the optional `job`.
- The new `SessionCloseFeedbackKind` case is handled in the only exhaustive switch (`SessionListView.swift:513`).
- `SessionWorktreePrompt(…, ask:)` is updated at its two construction sites.

**What both steps got right:**
- **The logic is on the box.** The close is orchestrated by `closeSession` (removal → kill → metadata → refresh). The rollup lives in `createSessionStatus`, built from authoritative sources only: own-session frames, parent edges and delegate records. It never infers anything from tool status.
- **Both clients switched.**
- **The old copies are deleted, with guard rows:** `describeSessionClose`, `describeProjectClose`, `killWindow`, `killProject`, `killWorktreeDirtyAndClose`, `SessionCloseCopy/Counts/Decision/Outcome/Step`, `readCleanOnClose`, `gitRemoveWorktree`, `computeJobNesting`, `sessionsWithActiveWork`, `shouldResyncWindowsForJobs`, `sessionParents`, `setChatSubagents`, `countRunningSubagents`, `SessionJobNesting`, `DelegateNesting`, `SessionSubagentCount`, `delegateJobs`.
- **Wire changes are additive:** new channels, an optional `job`, and a new `windowStatus` sub.
- **Warnings vs failures follow the spec.** Each path appears in exactly one of `removed` / `kept` / `failed`. A metadata failure is a warning with `ok:true`. A tmux failure is a class-1 sentence, and raw git/tmux text only goes to `console.warn`.

---

## BLOCKING

### 1. The close resolves the target window by index at confirm time. A stale index can delete the wrong conversation or force-remove the wrong worktree.

**Where:**
- Box: `src/server/sessionClose.mjs` `closeSession` (worktree path and `opencodeSessionId` resolved from `windowIndex` at call time).
- Desktop: `src/renderer/Sidebar.tsx` `runClose`.
- iOS: `SessionListStore.processClose`.

**Problem:** the window is identified only by `project` + `windowIndex`, and every fact is re-read on the box when the call arrives:
- the worktree path;
- whether to delete a conversation, and which one.

Between the user's confirm and the call, the index can come to name a different window:
- another device closes the window and a new one is created (tmux reuses the lowest free index by default);
- `renumber-windows` is on (a common setting in `~/.tmux.conf`).

Three concrete losses follow:
- **iOS "delete" with `deleteConversation:true`** deletes the opencode conversation of whatever window now sits at that index. The old iOS flow deleted the session id the phone had shown.
- **Dirty-worktree confirm.** The first call returns `needsConfirm` for path P. The user then chooses "Remove worktree" and the client re-calls with only `{project, windowIndex, dirtyWorktree:"remove"}`. If the index now names a window with worktree Q, the box runs `git worktree remove --force Q`. That silently destroys uncommitted work the user never saw a prompt for. The old desktop flow force-removed the exact path it had shown.
- **Kill** can hit the wrong window. This race existed before, but now it also drives the two deletions above.

**Fix (additive wire):**
- `sessions:close` takes an `expect` object, for example `{opencodeSessionId?: string|null, worktreePath?: string|null}`, taken from the row the user confirmed. The `windowName` may also go in it as a soft check.
- The box refuses with a class-1 sentence ("That session changed — refresh and try again.") when the window at `windowIndex` doesn't match.
- `deleteConversation` deletes only `expect.opencodeSessionId`, and only when it matches.
- `dirtyWorktree:"remove"` forces only when `needsConfirm.path` (sent back as `expect.worktreePath`) equals the window's current path. On a mismatch it re-asks.
- Both clients send the fields: desktop `runClose`, iOS `processClose` / `closeProject`. For the project close, the box can ignore them.
- Node tests:
  - an index re-used by another window → refused, nothing deleted;
  - `remove` with a path that no longer matches → no `--force`, a fresh `needsConfirm`;
  - a matching call behaves as today.

### 2. D7 makes iOS run a full session-list refresh on every `delegate.updated`, i.e. every ~10 s per running job. That is not acceptable.

**Where:** `mobile/native/MantaUI/SessionListStore.swift:495-500` (`trackDelegate` → `refresh()`), and the activity ticks in `src/server/delegate.mjs:1798-1802`.

**Problem:** the delegate activity poller publishes `delegate.updated {id, status, activity}` whenever a job's activity line changes, which is about every 10 s per running job. Each one now triggers `fetchOnce()`, and that is not one call:

| Step | Calls |
|---|---|
| `tmux:list` | 1 (the box first waits for `settled()`) |
| `refreshSessionMeta()` | 1 unscoped `opencode:list-sessions` (100 sessions) |
| | 1 `list-sessions` per distinct window directory |
| | 1 progress read per windowed session, sequentially |
| `refreshStopped()` | 1 |

With three running jobs and twenty windows, that is roughly 30 RPCs, plus the box's opencode listings, every ~3 s for as long as the list is alive. Before D7 the same frame cost one `delegate:list`, and the full refresh happened only when the list was behind.

The box already knows exactly when nesting changes: `jobsSignature` gates `onJobsChanged`, which then re-reads the session list.

**Fix:** make the box say so, and have iOS refresh only then. Either:
- (a) publish `{kind:"sessions.nesting"}` (or add `nestingChanged:true` to that `delegate.updated`) from the `onJobsChanged` path; or
- (b) have iOS react to the `sync` delta that `syncState.refreshNow()` already publishes.

Then make `trackDelegate` refresh only on that signal, and only the project list (`api.projects()` + `recomputeNesting()`), not the session-meta / stopped decoration.

Add an XCTest: a stream of activity-only `delegate.updated` frames triggers no `tmux:list`, and a nesting signal triggers exactly one. The desktop is unaffected: it still does one `delegate:list` per frame for its activity strings and gets nesting from `sync` deltas.

---

## SHOULD

### 3. A close that fails part-way misreports what it already did

**Where:** `sessionClose.mjs` (the `try` around delete + kill).

**Problem:** the order is: worktree removal → conversation delete → kill. A failed kill returns `{ok:false, error:"Couldn't close it — the server couldn't stop it."}` with no `removed` data, even when the worktree is already gone and, for iOS delete, the conversation is already deleted. The client says nothing happened.

There is a second problem in the same `try`: a failed `deleteSessionRaw` (for example a 404 because the conversation was already gone) aborts the kill and reports the same "couldn't stop it" sentence.

**Fix:**
- Kill first, then delete the conversation. The kill is the user's intent and the step most likely to fail. Treat a delete failure after a successful kill as a warning ("The session was closed, but its conversation couldn't be deleted."). A 404 counts as done.
- On a kill failure, still return `removed` / `kept` / `failed` so the client can say "The worktree was removed, but the session couldn't be stopped."
- Tests for both orders.

### 4. Two other close entry points bypass the box flow

**Where:** desktop `ChatPanel.tsx:2300` and iOS `ChatScreen.swift:1219` (`deleteSession`).

**Problem:** these in-chat "Delete" actions still call `opencode:delete-session`. That skips worktree clean-on-close and the dirty-tree check, so the same action behaves differently depending on where it was pressed.

The iOS one also passes `sessionName: w.name`, the **window** name, not the project. The box's `tmux.killWindow` then fails, the box swallows the error (`.catch(() => {})`), and the conversation is deleted while its window stays behind. This bug predates D6.

**Fix:** route both through `sessions:close` (with `deleteConversation` and the `expect` guard from #1), or record them as an explicit follow-up. Fix the iOS session-name argument either way.

### 5. Desktop: the reconnect read can overwrite a newer `windowStatus` frame and leave a dot stuck

**Where:** `src/renderer/App.tsx` `pullWindowStatus` (called on every `runningSet`), and `replaceWindowStatus`.

**Problem:**
1. The connect snapshot already replays every windowed session's frame.
2. The extra RPC is computed at time T and applied wholesale whenever it arrives.
3. A frame emitted after T (for example `busy:false` when a child finishes) can reach the client before the RPC response. The response then puts back `busy:true`.
4. The box has already recorded `busy:false` as sent (`lastEmitted`) and will not send another frame until something changes.

**Fix:** drop the RPC when the stream is live (the snapshot is the full replacement), or stamp payloads with a sequence and keep the newer value. Keep the RPC only for the no-stream case.

### 6. Box hydration can drop a turn that starts while it runs

**Where:** `sessionStatus.mjs` `hydrate()`.

**Problem:** `running.clear()` is followed by refilling from `listActiveSessionIds()`, a list read before the await. A live `running:true` frame that arrives while that read is in flight gets wiped by the older list. The row then stays not-running until the turn's next edge, which can be minutes away. Hydrated sessions also get `startedAt: null`.

**Fix:**
- Record ids touched by live `running` / `turnComplete` frames since hydration began, and re-apply their live value after the replace.
- Seed `since` from the interpreter's state (`streamInterp.getState(id).runningSince`) for hydrated ids.
- Add a test.

---

## NIT

7. **Raw error on a capability-unknown older box.** With `sessions-close-1` still `null`, the desktop calls the preview and `showError`s the raw "unknown rpc channel: sessions:close-preview"; iOS does the same through `SessionActionError`. Map `isUnknownChannelError` to `UPDATE_BOX_NOTE_TEXT` on both clients.
8. **Desktop confirm is invisible while the preview loads.** The modal stays closed (`open={false}`), so a slow preview reads as a dead Close click. Show a pending state ("Checking…"), or open the modal with a spinner.
9. **iOS repeated sentences.** `requestDelete` sets `deleteWorktreeNote = preview.body`. That is the whole confirm body ("Its tmux window will be killed… A turn is currently running…"), shown inside iOS's own running-turn confirm, which already says the same. Show only the worktree sentence: add a `worktreeLine` field to the preview, or check `preview.worktrees` and word the line client-side from the path the box returned.
10. **Wasted work on every tick.** `deriveWindowStatus` rebuilds a full `links` map (up to 5000 edges + jobs) once per windowed session per tick, i.e. O(windows × edges). Compute direct-child running counts once per flush in `allPayloads`.
11. **Missing older-box note.** Spec fallback for `sessions-window-status-1`: "one note in the list footer". Neither client shows it; the rail just goes flat. Add the note, or amend the spec.
12. **`rootIds` never shrinks.** Bound it the same way as `parentOf`, or clear it at the start of each hydration.
13. **The implementer's `stopped` / `attention` deviation is accepted.** Both fields ride the payload, nothing consumes them yet, and that is additive and harmless. Record the open master-D29 item (retire WS04's stopped list, or rewire M-09-2 and the desktop marker to `windowStatus.stopped`) in Follow-ups so it isn't lost.

---

## Older-box behaviour

| Capability | Result |
|---|---|
| `sessions-close-1` | The desktop shows the note when Close is pressed (`false`), and iOS shows it from delete / close-project ✓. While the capability is unknown, see #7. |
| `sessions-window-status-1` | No `job` → flat rail (owner-tagged job windows still hide on iOS); no `windowStatus` → own-turn dot only ✓. No footer note (#11). |

VERDICT: CHANGES REQUIRED

---

## Round 2 — re-check against fix commit `d146bd71`

I read the full diff of `d146bd71` only. I ran the checks in the foreground on a `git archive d146bd71` snapshot:

- **`npm run typecheck`:** clean.
- **`npm run test:server`:** 6263 pass, 0 fail.
- **Full `npx vitest run`:** 4837 pass, 1 fail. The failure is `tests/unit/e2e-smoke.test.ts › should confirm Playwright is installed`, an environment check that times out under the box's current load from other agents' suites. It passed in the previous round, and this commit doesn't touch Playwright.
- **Swift:** read, not compiled. The earlier `ChatScreenContent.capabilities` compile error is fixed by `a1c76a54`. The new types (`SessionCloseExpect`, `PendingDelete.expect`, `SessionWorktreePrompt.expect`) are plain `Equatable`/`Sendable` values. `nestingTask` inherits the store's main actor, and `NSNull` in `expect.wire` serialises.

### Findings 1–13

| # | Status | Notes |
|---|---|---|
| 1 BLOCKING (close bound to the confirmed window) | **Mostly resolved — one gap, R2-1** | See the detailed check below. |
| 2 BLOCKING (iOS refresh storm) | **Resolved** | iOS no longer reacts to `delegate.updated`. It refreshes only on `sessions.nesting`, re-reads only the project list, and coalesces the reads. An XCTest pins that activity-only frames cost nothing. The box raises the signal from a per-window `job` signature, so activity ticks never fire it. On the ordering, see R2-2 (a NIT). |
| 3 SHOULD (partial failure) | **Resolved** | Worktree → kill → conversation. A failed kill returns the sentence plus "Its worktree at X was already removed.", with the `removed`/`kept`/`failed`/`warnings` lists. A failed conversation delete after the kill is a warning, and a 404 counts as done. Tested. |
| 4 SHOULD (other close entry points) | **Resolved — and the dispute is upheld** | Desktop and iOS in-chat Delete now go through `sessions:close` with `deleteConversation` and `expect`, the dirty-tree question and the same notices. `opencodeDeleteSession` / `MantaAPIClient.deleteSession` are deleted, with guard rows. The box handler stays for older clients. **I was wrong about the iOS tuple:** the old code was `sessionWindow = (project.tmuxSession, window.index, cwd)`, so the field labelled `name` held the project's tmux session, not the window name. There was no bug. Retracted. |
| 5 SHOULD (desktop reconnect overwrite) | **Resolved** | `fillWindowStatus` only fills sessions that no frame has covered. The connect snapshot replays every windowed session, so the frames correct anything held from before. A guard row forbids `replaceWindowStatus`. |
| 6 SHOULD (hydration race) | **Resolved** | Live `running`/`turnComplete` edges seen during the active-list read are re-applied after the replace. Hydrated sessions take `since` from the interpreter. Tested. |
| 7 NIT (raw unknown-channel errors) | Resolved | Both clients, all close entry points. |
| 8 NIT (invisible desktop confirm) | Resolved | The confirm opens at once ("Checking…", confirm held back). |
| 9 NIT (iOS repeated sentences) | Resolved | The preview carries `worktreeLine`; iOS shows only that. |
| 10 NIT (per-tick recompute) | Resolved | `runningChildCounts` runs once per flush. |
| 11 NIT (older-box footer note) | **Amended — accepted** | A flat rail without a rollup is missing decoration, not a lost or dead control. Surfaces that lose a control keep their note. |
| 12 NIT (`rootIds` growth) | Resolved | Cleared per hydration. |
| 13 NIT (`stopped` / `attention` follow-up) | Resolved | Recorded as a Follow-up (master D29). |

### #1 in detail: is every destructive action now gated on the confirmed window?

**Box (`closeSession`):**
- With `expect`, every key sent must match the window now at the index. Otherwise the box refuses with "That session changed — refresh and try again." before any removal, kill or delete.
- Force-removing a worktree requires `expect.worktreePath === path`. Without it the box never forces and asks again.
- The conversation it deletes is `expect.opencodeSessionId`, which the check has just verified.
- Tests cover all three, plus a window that moved index between preview and confirm.

**Callers:**

| Caller | Bound when | Gated? |
|---|---|---|
| Desktop Sidebar close | captured from the row when the confirm opens | ✓ |
| Desktop dirty-worktree answer | sends back `ask.path` | ✓ |
| Desktop in-chat Delete | the panel's own `sessionId`, which is the identity itself | ✓ |
| iOS idle delete | captured at the tap (`beginIdleDelete`), carried through the 5 s undo into the queue | ✓ |
| iOS worktree-prompt answers | `prompt.shownExpect` | ✓ |
| iOS in-chat Delete | `store.sessionId` | ✓ |
| iOS running-turn delete | **at the Delete tap, not the confirm** | ✗ — R2-1 |
| Project close | n/a (no index to reuse) | n/a |

**Can an `expect`-less call from an older client destroy the wrong thing?**
- No client that ships has ever sent an `expect`-less `sessions:close`. The channel is new in this same release, and every in-tree caller now sends `expect`.
- Older clients (before D6) never call `sessions:close` at all. They use `opencode:delete-session`, which deletes the session id the client supplied and kills by index. That is the pre-existing behaviour, no worse than before.
- Without `expect` the box still never forces a dirty worktree.
- It *would* still resolve `deleteConversation` from the index, and an empty `expect: {}` checks nothing. That residue only matters to a hypothetical third-party caller; I recommend closing it (R2-3).

### New problems

**R2-1 BLOCKING — the iOS running-turn delete is bound at the Delete tap, not at the window the confirm showed.**
- **Where:** `mobile/native/MantaUI/SessionListView.swift:932`.
- **Problem:** the confirm sheet's Delete button calls `store.enqueueClose(project: project, index: index)` with no `expect`. `enqueueClose` then fills `expect` from `window(session:index:)`, i.e. whatever the list holds at that index when Delete is tapped. While the sheet is open, another device can close that window and a new window can take the index; tmux reuses the lowest free index, and any list refresh makes it visible. The `expect` then describes the NEW window, so the box's check passes. iOS then kills it and, because `deleteConversation` follows `expect.opencodeSessionId`, deletes its conversation. That is exactly the loss #1 was raised for, on the one path still unbound.
- **Fix (one line):** the sheet already holds the confirmed window (`target`), so pass `expect: SessionCloseExpect(window: target)`.
- **Hardening:** drop the implicit fallback in `enqueueClose`. Make `expect` a required parameter, so a future caller can't quietly bind at execution time.
- **Test:** an XCTest that changes the window at the index between confirm and tap, and asserts the close is refused.

**R2-2 NIT — `sessions.nesting` reaches clients before the `sync` delta, not after.**
- **Where:** `src/server/sessionStatus.mjs` `observe(sync)` → `d.publish(sessions.nesting)`.
- **Problem:** `bus.publish` delivers to subscribers synchronously, in subscription order. The status aggregator subscribed at boot, before any `/events` connection. So when it publishes `sessions.nesting` from inside its handler for the `sync` event, every SSE client receives `sessions.nesting` first and the `sync` delta second. The comment and the test name say "AFTER the sync delta"; the test checks only the order of calls inside the aggregator.
- **Effect today:** harmless. The box applies the new list before publishing `sync`, and `tmux:list` also awaits `settled()`, so the iOS refresh reads the new nesting regardless.
- **Fix:** defer the publish (`queueMicrotask`, or `setImmediate`, inside the `sync` branch) so it really follows on the wire, or correct the comment. Add a bus-level test with a later subscriber.

**R2-3 NIT — the box still accepts an unbound single-window close.**
- **Problem:** `deleteConversation` without `expect.opencodeSessionId`, or an `expect` with no keys, is still resolved from the index.
- **Fix:** since no released client sends either, refuse a single-window `sessions:close` that sets `deleteConversation` without `expect.opencodeSessionId`. This makes the guarantee hold for any future caller.

**R2-4 NIT — an empty list from the iOS nesting refresh is discarded.**
- **Where:** `SessionListStore.trackNesting`.
- **Problem:** it skips `list.isEmpty`, so a nesting change that leaves the box with no projects is never applied until the next full refresh.
- **Fix:** apply empty lists too. A failed read already throws and is skipped.

VERDICT: CHANGES REQUIRED

---

## Round 3 — re-check against `d13bae58`

(The request named it `d13bae56`; the commit on the branch is `d13bae58`.) I read `git show d13bae58` only. `sessionClose.test.mjs` passes as part of the server suite on the `d831f84a` snapshot, which contains this commit: 6298 pass, and the 1 failure is the known `upgradeV2Reclaim` load flake, which passes 76/76 in isolation.

| # | Status | Notes |
|---|---|---|
| R2-1 BLOCKING (iOS running-turn delete bound at the tap) | **Resolved** | `SessionListView.swift` confirm sheet now passes `expect: SessionCloseExpect(window: target)`, where `target` is the `MantaWindow` the sheet was built for (`confirmDeleteSheet(target: MantaWindow)`), so it type-checks. If the index is reused while the sheet is open, the box refuses. The suggested hardening (make `expect` a required parameter of `enqueueClose`) was not taken. That is acceptable: every in-tree caller now passes one, and the box-side guard below covers the conversation delete regardless. |
| R2-2 NIT (nesting before the sync delta) | Open | Not addressed; harmless as noted. |
| R2-3 NIT (unbound single-window close) | **Resolved** | `closeSession` refuses `deleteConversation` unless `expect.opencodeSessionId` is a non-empty string, returning `SESSION_CHANGED` before any lookup, removal or kill. The conversation it deletes is now only `expect.opencodeSessionId`; the index fallback is gone. The new test covers `undefined`, `{}`, `{worktreePath:null}` and `{opencodeSessionId:""}`, and asserts nothing was killed or removed. |
| R2-4 NIT (empty nesting list discarded) | Open | Not addressed. |

**No regression from the stricter guard:**
- iOS list deletes send `deleteConversation` only when `expect.opencodeSessionId != nil`, so a terminal window (no conversation) still closes.
- The iOS in-chat Delete always carries its own session id.
- The desktop in-chat Delete passes the panel's session id. The Sidebar close never sets `deleteConversation`.

Every destructive path is now bound to the window the user confirmed.

VERDICT: APPROVE
