# Code review — WS05 Git / PR / review / work inbox

Commits reviewed: `719256a8` (server + desktop), `94cd518b` (rpc test), `5b772416` (iOS).
Every changed file read in full (server `view.mjs`, `diffView.mjs`, the `forge/index.mjs` / `rpc.mjs` /
`boxCapabilities.mjs` hunks; desktop `ReviewPane.tsx`, `InboxPalette.tsx`, `ChatPanel.tsx`,
`SessionHeader.tsx`, `ToolBodies.tsx` hunks; all iOS `Git*` / `Review*` / `InboxWork*` files, the four
test files, and the `ChatScreen` / `SessionListView` / `MantaNavigation` / `Package.swift` edits).

Checks run here: `node --test` on `forge/view`, `forge/diffView`, `forge/index`, `rpc.inbox`,
`boxCapabilities` → 161/161 pass. `vitest` on ReviewPane / InboxPalette / UnifiedDiff /
SessionHeader.branch / SessionHeader.checks → 51/51 pass. `npm run typecheck` (3× tsc + eslint) is clean.
There is no Swift toolchain on this box, so I checked by hand that every iOS symbol exists with the
signature used: `ForgeConnectionStatus.init`, `boxCapabilities()`, `forgeStatus(validate:)`,
`ComposerTextController.insert(text:mode:)` / `acceptsInput`, `GitHubDeviceSignInView(onConnected:onCancel:)`,
`NewSessionDraft.init`, `MantaNavigator.startNewSession`, `.review(sessionID:)`, `SessionListStore.projects`,
`Tokens.scheme`, `Font.manta(size:weight:design:)`, and the `Metrics.*` / `tokens.*` members. No new
type name collides with an existing one. The Linux-package files (`GitForgeModels.swift`,
`InboxWorkModels.swift`) only reference types that are also in the package (`ForgeConnectionStatus`,
`MantaProject`, `OpencodeModelID`). I found no compile blockers.

**Seams between the two implementers:** they line up. Channel names, argument shapes
(`{cwd}`, `GitRef.json`, `op`/`comment`/`verdict`, `threadId`/`body`, `delegate:start
{prompt, sessionID, directory}`), result field names (`view.panel/chipLabel/ship/merge/checks`,
`checks[].tone`, `files[].rows[].anchor`, `placement {at, file, row}`, `draft.comments[].placement`,
`parseFailed`, `message`, inbox `label/identifier/secondary/repoName/tone/branchName/localPath`), the
verdict words (`approved|changes_requested|commented`, the same as the draft store's `VERDICTS`), the tone
words, and the capability id `forge-pr-view-1` all match between what the box sends and what iOS decodes.
The ship-preview success fields (`head, base, fileCount, title, body`) match too.

---

## Findings

### 1. BLOCKING — the merge check lets a merge through when the SHA is missing — `src/server/forge/index.mjs:1317`

`if (sha && pr?.headSha && pr.headSha !== sha)` skips the head check when the request has no SHA (or
an empty one), and also when the box's own PR read has no `headSha`. In those cases the merge goes ahead
with `sha: undefined`/`""`. The adapter's own doc (`github.mjs:553-556`) says that without `sha` "the API
merges whatever landed after the reviewed diff". It is also a time-of-check/time-of-use gap: the gate
checks the PR at time T, and with no SHA, GitHub merges whatever the head is at T+δ. The block's own
comment says "Fail closed", but this path fails open. Both shipped clients always send a SHA (iOS sends
`pr.headSha`, which decodes to `""` when the field is missing, so it hits this path too), but this is
the box's own safety check and must not rely on clients behaving well.

**Fix:** before the gate, refuse unless both SHAs are present and equal:
```js
if (!sha || !pr?.headSha || pr.headSha !== sha) {
  return { ok: false, error: sha ? "head sha moved" : "missing sha", kind: "sha_mismatch",
           message: mergeFailureMessage("sha_mismatch") };
}
```
Add a node test: `mergePullRequest(cwd, {number: 42})` (no sha) and `{sha: ""}` both return
`kind: "sha_mismatch"` and never call `adapter.merge`.

### 2. BLOCKING — "Start a session" in the inbox can close the inbox and open nothing — `mobile/native/MantaUI/InboxWorkScreen.swift:234`

`start(_:)` calls `onClose()` (`sheetRoute = nil`) and then `navigator.startNewSession(draft)`.
`SessionListView.handleDraft` → `dismissPresentations()` then sees `sheetRoute == nil`, so `hadSheet` is
false. It skips the 350 ms wait and sets `sheetRoute = .create` while the inbox sheet is still animating
away. The codebase already guards this exact UIKit refusal in two places: the 350 ms in
`dismissPresentations` and the comment at `InboxWorkScreen.delegate` ("UIKit refuses a second
presentation until it has finished"). Bypassing that guard here means the create sheet can silently fail
to appear: the inbox closes and nothing happens, which is a dead control.

**Fix:** delete the `onClose()` call in `start(_:)` and call only `navigator.startNewSession(draft)`.
`handleDraft` already dismisses the inbox (`sheetRoute = nil`), waits, then presents `.create`, so the
acceptance "closes the inbox and opens the create sheet" is still met. The store test doesn't need to
change.

### 3. SHOULD — a new PR doesn't appear at once, and the sheet can fall back to a disabled "Create" — `GitForgeStore.swift:305-309`

Spec A.3: "on `ok` sets `state.pr = pr` immediately (no flicker), `justShipped = pr.number`". The code
instead sets the preview to `.idle` and waits on `refreshNow()`. GitHub's list endpoint often doesn't
include a just-created PR yet. When that happens, the refresh returns `pr: null` with `ship.state ==
ready`, and the sheet goes back to the ready form with a redacted "Drafting title…" placeholder and
Create disabled. Nothing restarts the preview, because the key and state didn't change. The "Opened #N"
banner only renders in the PR view, and its 4 s timer usually expires before the next 5 s poll shows the
PR. A failed refresh (which is swallowed) leaves the sheet in the same state. This breaks acceptance A.5
("swaps the sheet to the PR view with 'Opened #N' in the same moment").

**Fix:** add `func noteCreated(_ pr: GitPullRequest)` that sets `state.pr = pr` (so the sheet goes
straight to the PR view with `justShipped`), and keep that PR until a poll returns one with the same
number or the branch changes. Then trigger `refreshNow()` without awaiting it before clearing
`shipBusy`. In the PR view, tolerate `view.merge == nil` (that already works). Add a store test where the
fake returns `pr: nil` on the first refresh after a ship: `state.pr?.number == 5` and `justShipped == 5`.

### 4. SHOULD — "Merged #N" is never visible — `GitBranchSheet.swift:220`

After a successful merge, `refreshNow()` usually returns no open PR, so `content` switches to
`shipContent`. `mergeMessage` is only rendered inside `prContent`, so the success is never shown. The
sheet also jumps to the ship form or ship sentence for the branch that was just merged. That breaks
"each action says what happened" (AGENTS "NEVER STUB…", outcome 1).

**Fix:** render `store.mergeMessage` above both `prContent` and `shipContent` (for example, a `Section`
at the top of either `List`, or a `safeAreaInset(edge: .top)` on `content`). Clear it when the sheet
closes (`clearMergeMessage()` is unused today; call it from `onDisappear`).

### 5. SHOULD — a rate-limited refetch wipes the review, drafts included (both clients and the box) — `src/server/forge/index.mjs:1373,1380`; `ReviewStore.swift:111`; `ReviewPane.tsx:~290`

When the forge rate-limits, `forgeDiffForCwd` returns `empty(null, {stale: true})`, i.e. `files: []`,
`threads: []`, **`draft: null`**, even though the draft is in the box's local store. Both clients then
replace their snapshot. iOS `apply()` sets `files = []`, `draft = nil`, `phase = .empty`, so the screen
shows "No diff." The stale footnote only appears in `.loaded`, and the pending bar and draft cards
disappear. The desktop `load(true)` does the same with `setDraft(null)`. This happens on every
refetch triggered after Add / Reply / Submit / a merge-requested reload, so the user's unpublished
comments disappear from the screen exactly when GitHub is busy.

**Fix (both layers):**
- Box: in both rate-limited branches, still read the draft (`storeGetDraft`) and return it with every
  comment placed `{at:"unplaced"}`, so a client always gets the draft.
- Clients: when the result has `error == nil && stale && files.isEmpty` and a snapshot is already
  showing, keep the current `files`/`threads`/`draft` and only set `diffIsStale` (iOS:
  `apply()`; desktop: `load(keepUi=true)`). On iOS, show the stale footnote in the `.empty` state too.

Tests: an iOS store test (loaded snapshot with one draft comment → reload returns stale+empty → draft and
pending bar still there, footnote shown), a matching vitest, and a node test that the rate-limited
`forgeDiffForCwd` returns the stored draft.

### 6. SHOULD — the review toolbar has no title/subtitle, and `title` is unused — `ReviewScreen.swift:61`

Spec D.2: title "Review" + subtitle `#N` when known. The `title` parameter ("#412 Fix the thing" from the
branch sheet and the inbox) is accepted and then ignored, and `sessionId` is unused too.
**Fix:** `.navigationSubtitle(title ?? "")` (iOS 26, already used by `InboxWorkScreen`). Drop the unused
`sessionId` or keep it with a comment.

### 7. SHOULD — diff rows are only lazy per file, not per row — `ReviewScreen.swift:235-236`

`fileBody` wraps the whole file in a `VStack`, so each `Section` of the `LazyVStack` is one eager view:
opening a file builds all of its rows at once (each one a `Button` with a context menu). With the
400-row collapse threshold this is acceptable, but expanding a 2,000-row file builds 2,000 rows in one
pass, which works against acceptance D.4 ("3,000-line diff scrolls smoothly").
**Fix:** make `fileBody` a `@ViewBuilder` that emits the file notes, the truncated/collapsed button, and
`ForEach(rows)` directly as the `Section`'s content (no wrapping `VStack`), so `LazyVStack` creates rows
lazily. The pinned headers keep working.

### 8. NIT — the two `mergeDraftPlacements` copies disagree on edge cases — `ReviewPane.tsx:94-103` vs `GitForgeModels.swift ReviewDraftMerge`

The desktop drops an unknown, untapped comment from the list (`if (placement) comments.push`), so the
pending count is short until the refetch lands, and it stays short if the refetch fails. With no
previous draft it marks everything unplaced and refetches, where iOS places the single new comment at
the tapped row. S.2 rule 4 says "show the known comments", and both would be closer to it if the
desktop kept unknown comments as `{at:"unplaced"}` the way iOS does. That is the "one rule" the spec
promised.

### 9. NIT — the inbox and the review don't read the capability list — `InboxWorkStore.swift`, `ReviewStore.swift`

S.6 says clients select the fallback from `boxCapabilities()`, with field presence as a decode guard.
iOS only uses field presence here (`label == nil` / `files == nil`). The user sees the same thing, so
this is a note rather than a defect. The desktop does read `useBoxCapability`.

### 10. NIT — a failed Remove shows in the global banner, not on the card — `ReviewStore.swift:172`

Spec D.2: "Remove failure → inline `message`, card stays." It currently goes to the top banner. That is
acceptable, but a per-comment error map (like the desktop's `noteErrors`) would match.

### 11. NIT — small allocations and unused members

- `ReviewScreen.relativeTime` (`:424`) creates an `ISO8601DateFormatter` and a `RelativeDateTimeFormatter`
  for every comment on every render. Make them `static let`.
- `InboxWorkScreen.swift:67` builds `Timer.publish(...).autoconnect()` inside `body`, so the timer is
  re-subscribed on each re-render. Hold it in a `let` on the view (the same pattern
  `RunningIndicator` should use).
- `GitChecksSheet.prURL` (`:13`) is never read.
- Decoding `[GitThread]` / `[GitCheckRun]` / `[GitDraftComment]` is all-or-nothing: one element with a
  missing `id`/`name` drops the whole list. This is unlikely given the box's shapes. A lossy element
  decode would match the "never drop a payload" rule.

### 12. NIT — M-05-1(b): only the `.onChange` half of M-03-7 exists — `ChatScreen.swift:461`

There is no initial `.onAppear { composer.acceptsInput = !store.isBackgroundJobReadOnly }`. Today that
is harmless because `isBackgroundJobReadOnly` starts false and the bridge also checks `readOnly`
directly (layer 1). It would only matter if the store ever started read-only.

### 13. NIT — `package.json` pins `"diff": "^9.0.0"`, while the spec says `diff@9.0.0` exactly. Use the exact version or note the caret.

---

## Spec conformance summary

Features A–E are implemented as specified, apart from #3 (the PR doesn't appear immediately after
creation), #4 (merge success not visible) and #6 (the review subtitle). Other points checked:

- Read-only chats: the bridge is nil for read-only, missing-controller and no-input cases (layer 1),
  and it re-checks `acceptsInput` when called (layer 3).
- Merge: the target is captured when Merge is tapped and is never re-read from state.
- Ship preview: keyed by cwd/branch/base, with late responses discarded.
- Connect offer: dismissed optimistically and persisted.
- Review: the state precedence (error → parse failure → empty → diff) is followed, and the draft reconcile
  covers all five rules.
- Inbox: Start creates nothing on its own, Open review only appears for PRs, Delegate only appears when
  there are chat sessions, and both outcomes show a message.
- Server: `view` and `diffView` are pure and tested; the last-PR cache, the `message` fields and the
  inbox `localPath` join all work.
- No secrets are shown or logged, and no force unwraps were added.

**Counts:** BLOCKING 2 · SHOULD 5 · NIT 6

VERDICT: CHANGES REQUIRED
