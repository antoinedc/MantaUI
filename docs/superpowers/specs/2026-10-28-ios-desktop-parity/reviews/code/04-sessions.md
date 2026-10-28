# Code review — WS04 sessions (commit 081ed15e)

Reviewer: Opus (main-session model). Scope: every file in `git show --stat 081ed15e`
(39 files: 30 app files incl. `MantaAPIClient+Sessions.swift`, the terminal files, and
`MantaAppRoot.swift`; 9 test files). Every changed file was read in full.

Checks run here:
- `mobile/native/verify.sh` (Docker `swift:6.1`) on a throwaway copy of the commit with
  the §13 manifest applied to `Package.swift`: all 9 WS04 [pkg] sources compile under
  Swift 6 language mode. With `SessionModelsTests.swift` in the test list the build
  FAILS (finding 9); without it: **749 tests, 0 failures** (`SessionsTests`,
  `CloneFromGitHubTests` 16, `GitHubDeviceSignInTests` 22 included).
- Grepped every consumed symbol: `launchersList()`, `AvailableLauncher` (Identifiable,
  Hashable), `ExtensionsLaunchers.resolve(schema:saved:)` / `.savedFlags(from:)`,
  `SettingsAppearance.storageKey/systemValue/preference(for:)`,
  `ThemePreference.colorScheme`, `.mantaBoxRemoved`, `flow.backToEntry()` /
  `isSwitching`, `SettingsScreen(eventStore:initialSection:)`, `MantaEventStore.stop()`,
  `confirmActionSheet(isPresented:title:message:destructiveTitle:destructiveAction:)`,
  `ChatScreen(…, seed:, draft:)`, `MantaAPIClient.live()` (nonisolated). Every
  `switch` over the new `SessionDotState.halted` is exhaustive (list row, dot, switcher).
- Server contracts checked against `rpc.mjs` / `local.mjs` / `tmux.mjs` /
  `launchers.mjs` / `ptyWs.mjs` / `forge/*` for every new member.

What is good: B1 is fixed correctly (`fs:list-dirs` decoded as `{dir, entries}`,
dot-folders filtered, absolute `entry.path`, cancellation-safe spinner); B2 is fixed
(`TmuxCreateResult.sessionId/windowIndex`, legacy array still absorbed, every new create
path resolves by `windowIndex` first). The D14 store follows the WS05 §C.3 lifecycle to
the letter: one `pollTask`, `generation` bumped before `api.start()`, every await site
re-checks it, a late start reply's grant is cancelled, `cancel()` is awaited before
`onCancel`, `sceneBecameActive()` only ticks + wakes the existing loop, the timer aims
at min(next poll, expiry) so expiry shows with no request, and the live adapter logs a
failed cancel. M-10-1 and M-10-2 are applied verbatim in `MantaAppRoot.swift`
(`.preferredColorScheme(...)`, navigator injection, `.mantaBoxRemoved` →
`store.stop(); sessionStore.resetForBoxChange(); flow.isSwitching = false;
flow.backToEntry(); paired = false`); `resetForBoxChange` clears the launcher catalog,
stopped records, close queue, prompts and feedback and keeps recents/saved modes. The
close flows are careful: project close counts the COMPLETE project, reads the clean-on-
close setting fresh at confirm and at run, keeps dirty worktrees, never aborts on a
worktree/meta failure and fires the success haptic only after a real kill; the per-
session close queue is FIFO, single-worker, prompts are keyed/deduped, Cancel sends no
RPC, and feedback follows real outcomes. Shared-member registry seams all exist with the
pinned signatures (`forgeProbe`, `forgeDevice*` incl. `forgeDeviceCancel async throws`,
`usageStoppedList`, `SessionListStore.stopped*` / `unarmedStoppedCount` /
`isStopped(sessionID:)` / `refreshStopped()` / `window(forSessionID:)` /
`renameSession(…) -> String?` / `launchers` / `launcherCatalog` / `refreshLaunchers()`,
`MantaNavigator.switchMode/windowKey/presentSwitcher/pendingDraft/switcherPresented`,
`SessionModeRows(current:launchers:catalog:onSelect:onRetry:)`,
`SessionRenameSheet(title:initialName:onSave:)`, `GitHubDeviceSignInView(onConnected:onCancel:)`).

## Findings

### 1. BLOCKING — creating a project whose name contains `.` or `:` reports failure after it succeeded (batch Retry then fails as a duplicate)
`SessionCreateLogic.swift:292-297` (`SessionCreatedWindow.find`), used by
`SessionSetupStore.swift:161-165` (repo batch / cloned repos), `SessionCreateSheet.swift:778-783`
(`finish`, new-project-from-folder, fan-out, draft-to-new-folder).

tmux silently rewrites `.` and `:` in a session name to `_` (spec §1 notes it;
`tmux.mjs` passes `-s name` straight through). The batch names each project
`SessionNaming.unique(deriveProjectName(path))` — the raw folder basename — so a repo
folder such as `next.js`, `antoinedc.github.io` or `api.v2` (very common, and every
cloned GitHub Pages repo) is created as `next_js`, then `find(in: reply.projects,
project: "next.js", …)` returns nil → the row is marked failed with "created session was
not returned" while the project exists on the box. Retry sends the same name again and
tmux answers "duplicate session". The single-create paths throw the same way after a
successful create (new project named from a dotted folder). This is new WS04 code (the
batch/clone/draft paths) and a wrong-behaviour bug on common input.

Fix: add `SessionNaming.tmuxSafe(_:) -> String` (replace every `.` and `:` with `_`,
exactly tmux's `session_check_name`) and apply it to EVERY name sent to
`tmux:new-session` from iOS — `SessionSetupBatch.init` (`unique(tmuxSafe(derive(path)),
taken:)`), `createNewProject` (`newProjectName` trimmed → `tmuxSafe`), `createFanOut`,
`createScratch`, and the draft prefill's derived name — so the name sent is the name
tmux keeps. Belt and braces: make `SessionCreatedWindow.find` fall back to the window
whose `opencodeSessionId == reply.sessionId` across all projects (returning the real
project name to put in `SessionCreated.project`) when the name lookup misses. Tests:
`testTmuxSafeReplacesDotAndColon`, `testBatchNameForDottedRepoIsTmuxSafe`
(`/r/next.js` → `next_js`, uniqueness applied after sanitising),
`testCreatedWindowFoundBySessionIdWhenNameDiffers`.

### 2. SHOULD — a mode switch re-opens an EQUAL navigation value; the swap relies on an implicit destination re-render
`SessionListView.swift:395` (`openSessionRoute`), `MantaNavigation.swift:38-41`.

`switchMode` writes the mode and opens `.session(windowKey)`; `openSessionRoute` builds
`SessionOpenTarget(…)` with `mode: nil`. A session opened from a row is ALSO
`mode: nil`, and `mode` is the only field that differs between "this session as chat" and
"this session as terminal" (`==`/`hash` deliberately include it, spec §2). So the new
path is equal to the current one and NavigationStack performs no transition; the screen
only changes if SwiftUI happens to re-run the pushed `navigationDestination` closure on
the `navigator.pending` re-render (it reads `SessionModeStore` from UserDefaults, which
nothing observes). That is undocumented behaviour, and if it doesn't fire the Terminal /
Chat / CLI rows in the overflow sheet and the terminal header menu are dead controls.
The spec says "append the target (mode from §2 resolution)".

Fix: in `openSessionRoute`, resolve the mode and put it IN the target:
`let saved = target.sessionId.map { SessionModeStore.read(sessionID: $0) }`;
`SessionOpenTarget(…, sessionId: target.sessionId, mode: saved)` (keep the existing
`.waiting` / downgrade toast logic). A switch then produces a different value and a real
replace; a plain `.session` route to a session already on screen in the same mode stays
equal (no flicker). Add a Mac test that two `openSessionRoute` targets for the same
window differ after `SessionModeStore.write(.terminal…)` (or test via a small pure
helper `SessionRouteLogic.openTarget(for:savedMode:)`).

### 3. SHOULD — `launchers:list` runs on every list refresh, inside the coalesced refresh loop
`SessionListStore.swift:309-310` (`fetchOnce`).

`listAvailableLaunchers` (`src/server/launchers.mjs`) spawns one login shell per
registered launcher, sequentially, each with a 3 s timeout. `fetchOnce` awaits it (and
`usage-stopped:list`) before `loading` clears, and refresh runs on every turn end
(`trackRunningTransitions`), every return to the list, every foreground and reconnect.
That adds hundreds of ms to seconds to every list refresh, holds `loading = true` (the
"Try again" button is disabled meanwhile) and queues further refreshes behind it, and it
re-publishes `launchers`/`launcherCatalog` (re-rendering the list) even when unchanged.

Fix: take launcher discovery out of `fetchOnce`. Refresh it (a) once on the first
successful fetch after launch/box change (catalog `.loading`), (b) on scene foreground,
(c) on demand (Retry, create sheet open, pending view) — with an in-flight guard so the
three callers coalesce — and only assign `launchers`/`launcherCatalog` when the value
changed. `refreshStopped()` can stay (cheap, and it has its own frame trigger), but run
it concurrently (`async let`) rather than serially after the launchers.

### 4. SHOULD — a CLI launches with stale or missing user flags
`SessionListStore.swift:991-1011` (`loadConfig`, only called from `init`),
`:1046-1048` (`resetForBoxChange` clears `launcherFlags`), `TerminalScreen.swift`
(`launcher` reads `sessionStore.launcherFlags[id]`).

`launcherFlags` is read once at store init. A user who changes a CLI's launch options in
Settings → Extensions (WS10) keeps launching with the old flags until the app is killed,
and after "Switch box" / "Remove server" + re-pair `launcherFlags` is `[:]` forever, so
every CLI launches with schema defaults instead of the user's saved flags (acceptance
§2: "A CLI launches with the user's saved flags"). The config read the box answers is
also the WS10 "never a cached copy" contract the spec cites for the other two settings.

Fix: re-read `launcherFlags` from a fresh `configGet()` inside `refreshLaunchers()` (one
extra cheap read, now that finding 3 makes `refreshLaunchers` rare), and/or resolve the
flags at launch time in `TerminalScreen` via an async `sessionStore.launcherFlagsFresh(id)`
before the socket opens. Test: `testRefreshLaunchersReReadsSavedFlags` and
`testBoxChangeThenRefreshRestoresFlags`.

### 5. SHOULD — the close worker can be duplicated after a box reset (queue no longer serial)
`SessionListStore.swift:700-723`, `:1052-1054`.

`resetForBoxChange` cancels `closeWorker` and sets it to nil, but `drainCloseQueue`
ignores cancellation and finishes its in-flight `processClose` (refresh, feedback into the
NEW box's state) and then runs `closeWorker = nil`. If a close was enqueued on the new box
meanwhile, that line wipes the NEW worker's handle, and the next `enqueueClose` starts a
second concurrent worker — exactly the overlap §8 forbids. Same shape in
`SessionSetupStore.drain()` (`worker = nil` after a `cancel()` + `startWorker()`).

Fix: give the worker a generation token: `closeGeneration += 1` in `resetForBoxChange`;
`drainCloseQueue(generation:)` checks `Task.isCancelled || generation != closeGeneration`
after every await and before publishing feedback/refreshing, and only clears
`closeWorker` when `generation == closeGeneration`. Same pattern in `SessionSetupStore`
(and on cancel mark a `.creating` row back to `.failed("Cancelled")` so a reopened view
never shows a row stuck in "Creating…"). Test: `testBoxResetDuringCloseDoesNotStartSecondWorker`.

### 6. SHOULD — `.message` route rebuilds a chat that is already on screen
`SessionListView.swift:415-428`.

`routedSessionID` is only set by routes, never by `push()`. If the user opened a chat from
its row (target `mode: nil`) and a `.message` for that same session arrives (WS06 search
"jump to message" from inside that chat, a WS07 artifact's "Jump to message"), the guard
passes and the path is replaced with a `mode: .chat` target — a different value — so the
ChatScreen is torn down and rebuilt (transcript reload, scroll lost, composer draft lost)
instead of WS02 scrolling in place. Spec §11: "if the stack top is not that chat, reset
the path".

Fix: track the top of the stack: in `push(_:)` and `openSessionRoute` set
`routedSessionID = target.sessionId` when the destination resolves to chat (and clear it in
the existing `path.count == 0` handler, already done). Then `openMessageRoute` leaves the
stack alone when the chat for `sessionID` is already on top and only leaves `pending` set
for WS02.

### 7. SHOULD — `.settings` / `.session` present while a sheet is still dismissing
`SessionListView.swift:372-377`, `:383-385`.

`handleDraft` already waits 350 ms after closing a sheet before presenting the next one,
because UIKit refuses a new presentation while one is dismissing. `.settings` sets
`sheetRoute = nil` and `showSettings = true` in the same transaction: a `.settings` route
raised from inside a sheet (WS05's inbox/Connect GitHub "Open Settings", WS10 links)
leaves the full-screen cover silently unpresented — a dead control from the caller's
point of view. (`.session` only clears sheets and pushes, which UIKit tolerates; the
full-screen cover is the presentation that drops.)

Fix: share `handleDraft`'s pattern: `let hadSheet = sheetRoute != nil || navigator.switcherPresented`;
dismiss; then `Task { if hadSheet { try? await Task.sleep(nanoseconds: 350_000_000) }; settingsSection = section; showSettings = true }`.

### 8. SHOULD — `GitHubDeviceSignInView` is dead if it disappears and re-appears
`CloneFromGitHubSignIn.swift:277-285`.

`onDisappear` cancels the store (generation bumped, loop stopped, grant released) but
`started` stays `true`, so a re-appearance never calls `start()` again: the code and
countdown stay on screen and nothing polls (signing in on github.com never completes
here). Within WS04 the view is only ever replaced, but WS05 consumes this view unchanged
and may host it where `onDisappear`/`onAppear` pair (a tab, a cover over it, a pushed
child). Fix: set `started = false` at the end of the `onDisappear` closure (before the
cancel Task), so the next `onAppear` starts a fresh attempt. Add a view-level note in the
type's doc comment that every appearance starts a new attempt.

### 9. SHOULD — M-04-8's package manifest lists a test file that cannot build on Linux
Spec §13 "Package manifest" / ledger M-04-8; `MantaUITests/SessionModelsTests.swift`.

`SessionModelsTests.swift` already contained Mac-only suites before WS04
(`SessionListMutationTests` uses `SessionListStore`, `MantaAPIClient`, `URLProtocol`,
`MantaEventStreamControl`) and WS04 points it at `SessionListFake` (in Mac-only
`SessionStoreTests.swift`). Adding it to `Package.swift` as the manifest says makes
`verify.sh` fail to compile (reproduced: "cannot find type 'SessionListStore'",
"'URLProtocol' is unavailable"). Without it everything is green.

Fix (for integration agent A, recorded here so it is not rediscovered): apply M-04-8
WITHOUT `SessionModelsTests.swift` in the `MantaUITests` sources; the 9 WS04 sources plus
`SessionsTests.swift`, `CloneFromGitHubTests.swift`, `GitHubDeviceSignInTests.swift` are
verified Linux-eligible. `SessionModels.swift` itself does build in the package. Update
the §13 list in `04-sessions.md` accordingly.

### 10. SHOULD — the folder picker's "up" control does nothing at `~`
`FolderPickerView.swift:103-110, 140-146` with `FolderPath.parentPath` (`SessionModels.swift:875-878`).

Every picker opens at `"~"` when no folder is set, and `parentPath("~")` returns `"~"`,
so the header ↑ and the `..` row are no-ops from the starting folder: a user can never
browse to `/srv`, `/opt`, `/mnt/data` (where many boxes keep code). Root AGENTS rule:
a control that can be pressed must do something. Fix: when a listing for `"~"` (or any
`~/…` path) succeeds, adopt the box's absolute `listing.dir` as `path` (the box expands
`~` and answers the absolute directory), so `parentPath` walks up normally; keep the
`.task(id: path)` re-list idempotent (the absolute path lists the same entries).

### 11. NIT — mount instructions for `SessionModeRows` (implementer's doubt, resolved)
`SessionModeMenu.swift:31-71`; receiving file `ChatOverflowSheet.swift:101-112` (WS07, M-04-2).

`SessionModeRows.body` is a `@ViewBuilder` (inherited from `View.body`) producing TWO
top-level `Section`s (`"Mode"` and, conditionally, `"AI CLI"`). It compiles and flattens
correctly ONLY when placed as a direct child of the overflow's `List` — a `Section`
nested inside another `Section` in an `.insetGrouped` List loses its header and grouping.
The ledger text "replace the 'Open terminal' row (`:111`) with `SessionModeRows(…)`"
must therefore be applied as follows by WS07:

```swift
Section {                       // existing second section, minus "Open terminal"
    Button { onCompactTap() } label: { … }      // unchanged
    row("Fork session", systemImage: "arrow.triangle.branch", action: onFork)
    if !isReadOnlyJob, (mode == nil || onSelectMode == nil) {
        row("Open terminal", systemImage: "terminal", action: onOpenTerminal)
    }
}
if !isReadOnlyJob, let mode, let onSelectMode {
    SessionModeRows(
        current: mode, launchers: launchers, catalog: launcherCatalog,
        onSelect: { m in dismiss(); onSelectMode(m) },
        onRetry: { onRetryLaunchers?() }
    )
}
```

i.e. `SessionModeRows` is a sibling BETWEEN the Compact/Fork section and the Trust-mode
section, never inside a `Section { }`. The rows use `.buttonStyle(.plain)` and do not
dismiss themselves, so the `dismiss()` in the wrapper is required (selecting the current
mode then just closes the sheet, as the spec asks). WS07 should copy this into its M-04-2
receipt; no WS04 change is needed.

### 12. NIT — terminal launcher vs WS08's `/pty` hardening (in-flight `src/server/ptyWs.mjs`)
No incompatibility. iOS sends `launcher={"flags":{…},"id":"<id>"}` (`SessionPtyLauncher.queryJSON`,
sorted keys, URL-encoded by `URLQueryItem`), which `parsePtyQuery` JSON-parses into the
`{id, flags}` object WS08's guard inspects (`typeof launcher.id === "string"`). iOS only
ever sends an id from `launchers:list`, which already excludes `hidden` launchers, and only
after `SessionModeResolution` confirmed the id against an authoritative list — so WS08's
`launcher_not_allowed` (1008 close + `{type:"error"}`) is unreachable from WS04's paths.
The CLI pty key `"<project>:<index>:tui:<id>"` is accepted (`sessionKey` is free-form).
One forward note for WS08: if a future change makes `/pty` refuse a launcher iOS considers
visible, `TerminalSocket` reconnects with the same launcher on every retry; the refusal
should keep arriving as the `{type:"error"}` text frame `TerminalModels` already parses so
the terminal shows the reason rather than looping.

### 13. NIT — clone poll treats one transport hiccup as "the clone job went away"
`CloneFromGitHubView.swift:224-227`. `try? await api.forgeCloneStatus` folds a thrown
network error into `nil`, ending the clone UI on a single blip while the box keeps
cloning. Distinguish: `nil` reply → "went away"; a throw → count it and fail only after 3
consecutive throws (reuse the device flow's budget idea).

### 14. NIT — "Pick another repo" after a mid-queue failure drops the already-cloned repos
`CloneFromGitHubView.swift:105-110, 123-126`. Repos cloned before the failure are on disk
but `cloneSelected()` resets `clonedPaths`, so they are never set up as workspaces. Keep
`clonedPaths` across `pickAnother()`/`cloneSelected()` (dedupe by dest) and include them
in the final `onCloned`.

### 15. NIT — the countdown re-publishes the flow every second
`CloneFromGitHubSignIn.swift:123-133`. `flow.tick(now:)` is a mutating call on a
`@Published` struct, so it fires `objectWillChange` every TimelineView tick even when the
stage doesn't change. Guard: compute on a copy and assign only when it differs
(`var next = flow; next.tick(now: now()); if next != flow { flow = next }`), in both
`tick()` and `sceneBecameActive()`.

### 16. NIT — navigator state survives a box change
`MantaAppRoot.swift:140-146`. On `.mantaBoxRemoved` (and in `commitPairing` when
switching) a pending `.review`/`.message` route, `pendingDraft` or `switcherPresented`
from the old box would be acted on against the new one. Add
`navigator.pending = nil; navigator.pendingDraft = nil; navigator.switcherPresented = false`
to both reset paths (a `MantaNavigator.reset()` helper).

### 17. NIT — transport-level text reaches the user verbatim
`SessionCreateLogic.swift:20-30` (`SessionActionError.message`) and `SessionModels.swift`
`SessionCreateFailure.message` show `MantaError.transport` strings such as
"tmux:new-session returned no result" / "invalid rpc envelope". Map `.transport` to the
generic "check the connection" wording (only `.server` text is written for people).

### 18. NIT — `testCancelFailureIsLoggedAndStillDismisses` asserts nothing about the failure path
`GitHubDeviceSignInStoreTests.swift:400-412`. The live-adapter half only proves the call
returns; the store half uses a fake whose cancel never fails. Inject a fake whose
`cancel(grantId:)` records it was called and the test asserts `onCancel`-equivalent
completion ordering after it (or drop the misleading name).

## Summary
1 BLOCKING (dotted project names), 9 SHOULD, 8 NIT. The D14 sign-in store and the B1/B2
fixes are correct; M-10-1/M-10-2 are applied verbatim; no incompatibility with WS08's
`/pty` hardening. The pure logic builds and passes under `verify.sh` once the manifest
drops `SessionModelsTests.swift` (finding 9).

VERDICT: CHANGES REQUIRED
