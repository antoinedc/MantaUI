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
