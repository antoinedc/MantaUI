# WS05 — Git, pull requests, review, work inbox (iOS)

Status: draft, revised after review round 1 · Wave: **C** (runs alone) · Owner prefix: `Git*`, `Review*`, `Inbox*`
Depends on (all land before wave C): WS02 (ChatScreen, read-only job state
`jobOwnership`), WS03 (C3 `ComposerTextController` adopted in `ChatScreen`),
WS04 (C2 `MantaNavigator` + `startNewSession`, D14 GitHub device sign-in,
`repoProbe()`), WS10 (`forgeStatus(validate:)`, D16).

This workstream brings the desktop's GitHub surface to the phone: the branch/PR
sheet behind the chat's branch chip, the checks chip, the "Connect GitHub"
offer (sign-in itself is WS04's shared view, D5/D14), the review screen (PR
diff, line comments, threads, verdict, submit) and the work inbox.

**No new server routes.** Every feature uses the existing `forge:*`,
`delegate:start` and `config:*` RPC channels exactly as the desktop does. The
only Electron-local pieces on desktop are `openExternal` (→ iOS `openURL`) and
`clipboardWriteText` (→ `UIPasteboard`). No `/events` frames are involved: the
box publishes `forge-draft.updated` (`src/server/forge/draft.mjs:173…249`) and
`forge.inbox.invalidated` (`src/server/index.mjs:1353`) on its bus, but no
client consumes them — the desktop is poll/refetch-driven and iOS matches.

---

## 0. Naming collision — read first

`mobile/native/MantaUI/InboxModels.swift` already exists (owned by WS02, D1) and
is **the pending messages inbox** (V2 steer/queue), unrelated to this work. It
already declares `InboxItem`, `InboxSnapshot`, `InboxDelivery`. Therefore:

- Work-inbox files are named `InboxWork*.swift` (inside the `Inbox*` prefix);
  **never edit `InboxModels.swift`**.
- Work-inbox types are named `WorkInbox*` (e.g. `WorkInboxItem`), never
  `InboxItem`.
- All forge wire types WS05 declares are prefixed `Git*` (e.g.
  `GitPullRequest`). The forge **status** type is WS10's (D16) and the device
  sign-in types are WS04's (D14); WS05 declares neither.

---

## 1. Shared wire contract (all features)

All calls go through `MantaAPIClient.call/callRequired` (internal per C1). WS05
adds only the methods in "Client members" (§12) to
`MantaUI/MantaAPIClient+Git.swift`, and **consumes** members other specs own:

| Consumed member | Owner (D16) | Channel |
|---|---|---|
| `forgeStatus(validate: Bool)` → WS10's forge-status type (`connected`, `login`, `source`, `valid`) | WS10, `MantaAPIClient+Settings.swift` (wave A) | `forge:status` `[{validate}]` — WS05 always passes `validate: false` (desktop `ChatPanel.tsx:1055` calls it with no args; `rpc.mjs:952` → `validate === true` only when asked) |
| `repoProbe()` → `{repos:[RepoHit{path, repoKey?…}], …}` | WS04, `MantaAPIClient+Sessions.swift` (wave A) | `forge:probe` |
| `githubDeviceStart/Poll/Cancel` + `GitHubDeviceSignInStore`/`GitHubDeviceSignInView` | WS04 (D14) | `forge:device-*` — WS05 never calls these directly; it only presents the view |
| `configGet()` / `configUpdate(_:)` | existing (`MantaAPIClient.swift:752,757`) | `config:get` / `config:update` |
| `projects()` | existing (`MantaAPIClient.swift:192`) | `tmux:list` |

WS05's own channels (server handlers `src/server/rpc.mjs:944-1075`,
implementations `src/server/forge/index.mjs`; args shape as
`src/renderer/api/httpApi.ts:850-881`, one JSON object in `args[0]`):

| Channel | args[0] | Result (TS source) |
|---|---|---|
| `forge:pull-request` | `{cwd}` | `ForgePullRequestResult` (types.ts:655) |
| `forge:ship-preview` | `{cwd, model?:{providerID,modelID}, sessionId?}` | `ForgeShipPreviewResult` (types.ts:781) |
| `forge:ship` | `{cwd, title, body}` | `ForgeShipResult` (types.ts:759) |
| `forge:merge` | `{cwd, number, method:"merge", sha}` | `ForgeMergeResult` (types.ts:802) |
| `forge:diff` | `GitRef` | `ForgeDiffResult` (types.ts:701) |
| `forge:draft-get` | `GitRef` | `ForgeDraftGetResult` (types.ts:842) |
| `forge:draft-comment` | `GitRef ∪ {op, comment?, verdict?}` | `ForgeDraftCommentResult` (types.ts:866) |
| `forge:draft-submit` | `GitRef ∪ {verdict?}` | `ForgeDraftSubmitResult` (types.ts:878) |
| `forge:thread-reply` | `GitRef ∪ {threadId, body}` | `ForgeThreadReplyResult` (types.ts:890) |
| `forge:inbox` | none (`args: []`) | `ForgeInboxResult` (types.ts:741) |
| `delegate:start` | `{prompt, sessionID, directory}` | `{ok, error?}` (types.ts:2643-2649; rpc.mjs:2448) |

`GitRef` is the forge target (types.ts:691):

```swift
enum GitRef: Hashable, Sendable {
    case cwd(String)                          // → {"cwd": path}
    case pr(repoKey: String, number: Int)     // → {"repoKey": k, "number": n}
    var json: [String: Any] { … }
}
```

WS05 no longer calls `git:add-worktree` or `tmux:new-session` (D12: the inbox
hands a draft to WS04's create sheet, which creates on Create).

**Decoding rules** (WS05 wire types live in `GitForgeModels.swift`,
Foundation-only):

- Every type is `Decodable` with `decodeIfPresent` + defaults for every field
  except identity fields, so a new/missing field never drops the payload.
- `PullRequest.mergeable` is `true | false | null` → `Bool?` (null = still computing).
- `PullRequest.state` → `String` (`"draft"|"open"|"merged"|"closed"`, unknown kept verbatim).
- `ForgeCheckRun` → `GitCheckRun { name: String; status: String?; conclusion: String?; url: String? }`.
- `CheckRollup` → `GitRollup` enum `green|yellow|red|none` with unknown → `.none`.
- `*Result` unions with `ok: Bool` decode into `enum … { case ok(T), failed(error: String, kind: String?) }`.
- `ForgeInboxItem.updatedAt` is epoch **milliseconds**.
- A thrown transport error is caught at the store and turned into a visible
  message (never `try?` silently on a user action — AGENTS.md "no dead controls").

---

## 2. Feature A — Branch / PR sheet (from the chat branch chip)

### A.1 Desktop behaviour today

- **Data**: `ChatPanel.tsx:1043-1077` (`refreshForge`) calls `forgeStatus()` and
  `forgePullRequest({cwd})` together, on the SAME 5 s timer as the branch
  indicator, only while the panel is visible (`ChatPanel.tsx:1181-1191`). On a
  throw it keeps the last-known state. `forgeKind = "github"` unless
  `prResult.error === "no_forge"`.
- **Chip** (`SessionHeader.tsx:276-281, 438-468`, `branchPanelState`
  chatUtils.ts:4379): if there is no branch or the forge is not connected the
  branch stays a plain non-interactive tag. Otherwise it is a button labelled
  `branch` or `branch · #N` that opens a popover (`BranchChip`,
  SessionHeader.tsx:1192-1251).
- **No-PR state = the ship gate** (`BranchPanel` SessionHeader.tsx:1291-1376,
  `resolveShipState` chatUtils.ts:4414-4427, first match wins:
  `has-pr`, `detached` (no branch), `unknown` (no base), `on-base`
  (branch == base), `no-commits` (aheadCount == 0), `ready`; note
  `aheadCount == nil` still yields `ready`).
  - `on-base` / `detached` / `unknown`: branch name + one line —
    "On the base branch — nothing to ship." / "Detached HEAD — nothing to
    ship." / "Base branch unknown — nothing to ship." No action.
  - `no-commits`: "Nothing to ship — no commits ahead of {base}".
  - `ready`: `{branch} → {base}` plus ` · N file(s)` once the preview lands; a
    "Title" box showing the drafted title (skeleton + "Drafting title…" while
    null); primary **Create pull request** button, disabled until the title
    arrives, shows "Creating…" while busy; the popover cannot be dismissed while
    creating (SessionHeader.tsx:1235-1238).
  - The preview (`forge:ship-preview`) is fetched once when the popover opens in
    the no-PR state (`BranchChip` effect, :1207-1209; `ensureShipPreview`
    ChatPanel.tsx:1084-1107), passing the session's model **override** and
    `sessionId` so the box drafts the title/body with that model out of band.
    An empty title falls back to the head branch name. A failure shows the
    error string in red instead of the title.
  - Create (`confirmShip`, ChatPanel.tsx:1115-1139): `forge:ship {cwd, title,
    body}` with the preview's title/body. Success → the popover swaps straight
    to the PR state with an "Opened #N" callout, opens the PR in the browser,
    and refreshes. Failure → error line.
- **PR state** (`BranchPanel` :1378-1437): `#N title`; `state · head → base`;
  rows Reviewers (comma list or "none"), Unresolved threads, Mergeable (the
  `mergeBlockedReason` in red, else "mergeable" green, else "computing…").
  Buttons: **Merge** (gated by `canMerge` chatUtils.ts:4331-4348: mergeable must
  be `true`, rollup `green`, 0 unresolved threads; the disabled button's
  tooltip is the reason: "still computing" / "not mergeable" / "checks still
  running" / "checks failing" / "no checks" / "N unresolved thread(s)");
  **Review changes** (opens the review pane); **Open on GitHub** (icon button).
- **Merge** (`doMerge`, ChatPanel.tsx:1142-1157): `forge:merge {cwd, number,
  method:"merge", sha: pr.headSha}` — always the head SHA the user saw. Failure
  text from `describeMergeFailure` (chatUtils.ts:4358): `sha_mismatch` →
  "Merge failed — the head SHA moved. This PR changed after you reviewed it;
  re-review before merging.", `cannot_merge` → "Cannot merge — the PR is
  blocked (branch protection, draft, or a conflict).", `permission` → "No
  permission to merge this pull request.", other → "Merge failed (kind)." /
  "Merge failed.". Success shows nothing (next poll updates).

Server: `pullRequestForCwd` (forge/index.mjs:723-791) returns `{pr, checks,
rollup, stale, error, branch, base, aheadCount}`; on rate-limit it returns
`pr:null, stale:true` (index.mjs:758). `shipPreview` (:942-990) errors:
`no_forge`, `not_connected`, `no_branch`, `unknown_base`. `shipPullRequest`
(:1178-1204) errors: same plus `push failed: …`, `create pull request failed: …`.
`mergePullRequest` (:1218-1229) → `{ok:false, error, kind}`.

### A.2 iOS today

`ChatScreen.swift` shows the branch as a non-interactive `Label` (`subtitleChip`,
ChatScreen.swift:925-935) inside `sessionHeaderBlock` (:1131-1150). The branch
is polled every 5 s (`pollBranch`/`refreshBranch`, :876-895); the session's cwd
is `sessionWindow?.cwd` (resolved in `resolveWindowAndBranch`, :859-871). No
forge state exists. `BranchLabel.display` (ChatScreen.swift:70-80) truncates
branch names and is reused.

### A.3 iOS design

**`GitForgeStore`** (`MantaUI/GitForgeStore.swift`, `@MainActor final class
GitForgeStore: ObservableObject`), one per chat screen. Its network calls go
through an injected `GitForgeClient` (a struct of `async throws` closures whose
`.live` value wraps `MantaAPIClient`), so the store is unit-testable
(pattern: `UpgradeStoreTests`, `BackgroundJobsStoreTests`).

- `@Published private(set) var state: GitForgeState` (pure value: `connected`,
  `kind: String?`, `pr`, `checks`, `rollup`, `stale`, `branch` (the **forge**
  result's branch, nil on a forge error), `base`, `aheadCount`,
  `offerDismissed`).
- `func run(cwd: String) async` — the poll loop: fetch immediately, then every
  5 s (`BranchFreshnessPolicy.pollInterval`) while not cancelled. Started from
  `.task(id: cwd)` on the mounted header view, so it stops when the chat screen
  disappears and restarts on cwd change. Skips a tick while `scenePhase !=
  .active`.
- Each tick: `async let` `forgeStatus(validate: false)` + `forge:pull-request`;
  merge with `GitForgeState.applying(status:, pr:)` (pure, A.4). On throw: keep
  last-known, no UI noise (desktop `ChatPanel.tsx:1074-1076` — the poll is
  ambient, not a user action).
- `offerDismissed` loaded once from `configGet()["forgeConnectOfferDismissed"]`.
- **Ship preview, keyed to the branch it was drafted for.**
  `@Published private(set) var shipPreview: GitShipPreviewState` (`.idle |
  .loading(GitShipKey) | .ready(GitShipKey, base, fileCount, title, body) |
  .failed(GitShipKey, String)`), where `GitShipKey = {cwd, branch, base}`.
  - `ensureShipPreview(model:, sessionId:)` computes the current key from
    `state` (`cwd` + forge `branch` + `base`); if the preview already holds that
    exact key in `.loading`/`.ready` it does nothing, otherwise it starts a new
    fetch tagged with that key.
  - A response is applied only if its key still equals the current key
    (`GitShipPreviewState.accept(response:for:current:)`, pure). A late
    response for a previous branch is discarded.
  - Every applied poll whose `branch` or `base` differs from the preview's key
    resets the preview to `.idle` (and, if the sheet is open, re-fetches) —
    a terminal-side `git checkout` (ChatScreen polls it, `ChatScreen.swift:874-895`)
    can never leave the old branch's title on screen.
  - `canCreate` (pure, `GitShipPreviewState.canCreate(current:)`) is true only
    for `.ready` whose key equals the current key and whose title is non-empty
    (title falls back to `head` when empty, `ChatPanel.tsx:1097`).
- `createPullRequest()` — guard `canCreate`; calls `forge:ship {cwd, title,
  body}` from the `.ready` payload; on `ok` sets `state.pr = pr` immediately
  (no flicker), `justShipped = pr.number` (cleared after 4 s), clears the
  preview, triggers a refresh. On failure sets `.failed(key,
  GitCopy.shipError(error))`. `shipBusy` true for the duration.
- **Merge, tied to an immutable snapshot.**
  `struct GitMergeTarget: Equatable, Sendable { cwd: String; number: Int; title:
  String; base: String; headSha: String }` (pure, `GitForgeModels.swift`).
  - `func mergeTarget() -> GitMergeTarget?` returns nil unless `state.pr` exists
    and `canMerge` is true (no force unwraps; `pr` is optional throughout).
  - The sheet captures it **when the Merge button is tapped** into
    `@State pendingMerge: GitMergeTarget?`; the confirmation dialog's title and
    the request are rendered/built from that value only.
  - `func merge(_ target: GitMergeTarget) async` sends `forge:merge {cwd:
    target.cwd, number: target.number, method: "merge", sha: target.headSha}`
    and never rereads `state` before sending — a poll that replaces or clears
    the PR while the dialog is open changes nothing about what is merged
    (desktop captures the PR before awaiting, `ChatPanel.tsx:1144-1146`).
  - `mergeBusy`, `mergeMessage: GitBanner?` (`.ok("Merged #N")` or
    `.error(GitPanel.describeMergeFailure(kind))`). If the server reports
    `sha_mismatch`, the message tells the user the PR changed.

**Mounted view `GitSessionHeaderRow`** (`MantaUI/GitSessionHeaderRow.swift`),
replaces the `subtitleChip` call in `sessionHeaderBlock` (M-05-1). Inputs:
`branch: String?` (ChatScreen's ordinary git branch), `relPath: String?`,
`cwd: String?`, `sessionId: String`, `shipModel: OpencodeModelID?` (the chat's
model **override** only, as desktop), `tokens`.
It reads the composer from `@Environment(\.composerController)` (WS03,
injected on `ChatScreenContent` by M-03-3); writability is that controller's
`acceptsInput`, which WS02 sets to `jobOwnership.job == nil` (M-03-7). See A.3a.

Renders, in one `HStack` row (nothing at all if there is no branch AND no
offer):
1. **Branch chip** — the label is always ChatScreen's ordinary branch (same
   look as today's `subtitleChip`: `arrow.triangle.branch`,
   `BranchLabel.display`, `· relPath`), plus ` · #N` when a PR exists.
   - Interactive only when `GitPanel.isInteractive(connected:, kind:,
     forgeBranch:)` — connected **and** a recognised forge kind (the PR read
     did not answer `no_forge`) **and** a non-nil forge branch. Otherwise a
     plain `Label`, not a button — this covers a connected account in a repo
     whose origin is not GitHub (`pullRequestForCwd` returns `branch: null`
     with `error: "no_forge"`, forge/index.mjs:735,754-755).
   - Interactive → `Button` presenting `GitBranchSheet` (`.sheet`,
     `.presentationDetents([.medium, .large])`). VoiceOver label
     "Pull request #N: title" or "Current branch: name" + hint "Opens git actions".
2. **Checks chip** (Feature B) to the right of the branch chip.
3. Under the row: the **Connect offer** (Feature C) when
   `GitPanel.shouldOfferConnect(...)`.

**A.3a Read-only chats.** A background-job chat is read-only (WS02 F6,
`jobOwnership.job != nil`); the master excludes typing into such sessions.
Two guards, both keyed on WS03's `ComposerTextController.acceptsInput`:
1. **Not rendered.** `GitComposerBridge.make(controller:)` (in
   `GitSessionHeaderRow.swift`) returns nil when the environment controller is
   nil or `acceptsInput == false`. The header builds it when presenting a
   sheet; with nil, `GitBranchSheet` passes `onSendToAgent: nil` to
   `ReviewScreen` and `GitChecksSheet` gets `onSendFailures: nil`, so "Send to
   agent" (line composer AND saved-draft cards) and "Send failures to the
   agent" are not rendered.
2. **Re-checked on use.** The bridge closure reads `controller.acceptsInput`
   again at call time and calls `insert(text:mode: .append)`, which itself
   returns `false` when `acceptsInput` is false (WS03 contract). A chat that
   became read-only while a sheet was open therefore inserts nothing and shows
   "This chat is read-only."; any other `false` shows "Couldn't add it to your
   message." (C3: callers never ignore the Bool).

**`GitBranchSheet`** (`MantaUI/GitBranchSheet.swift`) — `NavigationStack`
inside the sheet (so Review can push). Title = branch name; toolbar **Done**.
While `store.shipBusy` (or `mergeBusy`) the sheet cannot be closed by any
path: `.interactiveDismissDisabled(busy)` blocks the swipe, and **Done** is
`.disabled(busy)` and its action is guarded (`guard !busy else { return }`)
(desktop blocks the popover's close while creating, `SessionHeader.tsx:1235-1238`).
`.onAppear` and every branch change while open: if no PR, `ensureShipPreview`.

- **Not-shippable states** (`on-base`, `detached`, `unknown`): branch name +
  the desktop line verbatim (see A.1). No buttons.
- **`no-commits`**: "Nothing to ship — no commits ahead of {base}".
- **`ready`**: a `Form`/list section: row "From → To" `{branch} → {base}`
  (base from preview, else poll's base, else "—"), row "Changes" `N file(s)`
  (hidden until the preview for this branch lands), section "Title" with the
  drafted title in body text (redacted placeholder + footnote "Drafting
  title…" while loading). Primary full-width button **Create pull request**,
  enabled only when `canCreate` and not busy; busy shows `ProgressView` +
  "Creating…". Footnote: "Pushes {branch} and opens a pull request into
  {base}. You can edit the title and description on GitHub." Preview/ship
  failure → red text (`GitCopy.shipError`) and a "Try again" button that
  re-runs the preview for the current branch.
- **PR state**: header `#N title` (2 lines max), subtitle `state · head →
  base`; optional green banner "Opened #N" when `justShipped`; `LabeledContent`
  rows Reviewers / Unresolved threads / Mergeable (value tinted: blocked reason
  → `tokens.danger`, "mergeable" → `tokens.ok`, "computing…" → `tokens.tx4`).
  When `state.stale`: footnote "Showing last known state — GitHub didn't
  answer." Buttons:
  - **Merge** — enabled iff `store.mergeTarget() != nil`; when disabled, the
    reason is shown as a footnote ("Can't merge yet: checks failing") — iOS has
    no hover tooltips. Tap → `pendingMerge = store.mergeTarget()` →
    `confirmationDialog("Merge #\(t.number) into \(t.base)?", presenting:
    pendingMerge)` with **Merge** and **Cancel** → `store.merge(t)`. Busy:
    "Merging…". Result banners as above.
  - **Review changes** — `NavigationLink` pushing `ReviewScreen(target:
    .cwd(cwd), sessionId: sessionId, title: "#N title", prURL: pr.url,
    onSendToAgent: bridge)` where `bridge` is nil for a read-only chat (A.3a).
  - **Open on GitHub** — `openURL(pr.url)`; hidden if `pr.url` is empty.

Deliberate iOS differences (behaviour, not visuals): Merge asks for a
confirmation (a phone tap is easy to misfire); after creating a PR the app does
**not** jump to Safari — it shows "Opened #N" with an **Open on GitHub** button;
blocked-merge reason is visible text; preview/ship error codes are translated
to plain words.

### A.4 Pure logic — `GitForgeModels.swift` (Foundation-only)

Port verbatim from `chatUtils.ts`:

- `enum GitPanel`
  - `branchState(pr:, connected:, branch:) -> .none | .noPR | .pr` (chatUtils.ts:4379), always called with the **forge** branch
  - `isInteractive(connected:, kind:, forgeBranch:) -> Bool` (A.3 rule)
  - `shipState(branch:, base:, aheadCount:, hasPR:) -> GitShipState` (`.hasPR,
    .detached, .unknown, .onBase, .noCommits, .ready`; :4414)
  - `noShipCopy(_:) -> String?` (SessionHeader.tsx:1284-1288 strings)
  - `canMerge(rollup:, unresolvedThreads:, mergeable:) -> (can: Bool, reason: String?)` (:4331)
  - `describeMergeFailure(_ kind: String?) -> String` (:4358)
  - `mergeableDisplay(pr) -> (text, tone)` (SessionHeader.tsx:1390-1395)
  - `shouldOfferConnect(connected:, forgeKind:, dismissed:)` (:4084)
  - `chipLabel(branch:, prNumber:)` → `"branch"` / `"branch · #N"`
- `struct GitMergeTarget` + `static func target(state: GitForgeState, cwd:) -> GitMergeTarget?` (nil without PR / when `canMerge` fails)
- `GitShipKey`, `GitShipPreviewState` with `accept(response:for:current:)`,
  `invalidated(by newState:)`, `canCreate(current:)`.
- `enum GitCopy.shipError(_ raw: String) -> String`:
  `no_forge` → "This folder isn't linked to a GitHub repository.",
  `not_connected` → "GitHub isn't connected on this server.",
  `no_branch` → "Detached HEAD — check out a branch first.",
  `unknown_base` → "Couldn't tell which branch to target.",
  prefix `push failed: ` → "Couldn't push the branch: <rest>",
  prefix `create pull request failed: ` → "GitHub refused the pull request: <rest>",
  anything else → raw.
- `GitForgeState.applying(status:, pr:) -> GitForgeState`: copies desktop's
  merge (kind = "github" unless `error == "no_forge"`), **plus one rule**: if
  the new result is `stale && pr == nil` and the previous state had a PR on the
  same branch, keep the previous PR/checks/rollup (a rate-limited poll,
  forge/index.mjs:758, must not flip the sheet to "Create pull request").
  `status` is WS10's forge-status value; `applying` reads only `connected`.

Tests — `MantaUITests/GitForgeTests.swift` (pure, runs under `verify.sh`):
`testBranchStateNoneWithoutBranchOrConnection`, `testBranchStatePRvsNoPR`,
`testInteractiveRequiresConnectedForgeKindAndForgeBranch`,
`testConnectedAccountNonForgeRepoIsNotInteractive` (`error:"no_forge", branch:null`),
`testShipStateOrderFirstMatchWins` (all six), `testShipStateUnknownAheadIsReady`,
`testNoShipCopy`, `testCanMergeEveryBlockingReason` (null/false/yellow/red/none/
1 thread/2 threads/ok), `testDescribeMergeFailureKinds`, `testMergeableDisplay`,
`testMergeTargetNilWithoutPRAndWhenBlocked`, `testMergeTargetCapturesHeadSha`,
`testShipErrorCopy` (each code + both prefixes + passthrough),
`testShipPreviewDiscardsLateResponseForOldBranch`,
`testShipPreviewInvalidatedBySameCwdBranchSwitch`,
`testCanCreateFalseUntilPreviewMatchesCurrentBranch`,
`testPreviewTitleFallsBackToHead`,
`testApplyingKeepsLastPRWhenStaleAndEmpty`, `testApplyingNoForgeClearsKind`,
`testDecodePullRequestResultWithNullMergeable`, `testDecodeUnknownRollupIsNone`,
`testDecodeShipResultFailedAndOK`.

Store tests — `MantaUITests/GitForgeStoreTests.swift` (Xcode only, uses a fake
`GitForgeClient`):
`testMergeSendsCapturedTargetAfterPollReplacesPR` (capture target for PR #1
sha `a`, apply a poll with PR #2 sha `b`, call `merge(target)` → client got
`{number:1, sha:"a"}`), `testMergeSendsCapturedTargetAfterPollClearsPR`
(no crash, original target sent), `testCreateDisabledWhileBusy`,
`testShipPreviewRefetchedAfterBranchChange`.

### A.5 Acceptance

- [ ] With GitHub connected and a feature branch with commits ahead and no PR,
  tapping the branch chip opens a sheet showing `branch → base`, file count and
  a drafted title; **Create pull request** stays disabled until the title for
  the current branch arrives.
- [ ] Switching branch in a terminal while the sheet is open replaces the
  preview with the new branch's one (old title never shown or submitted).
- [ ] Creating a PR swaps the sheet to the PR view with "Opened #N" in the same
  moment; neither swipe nor Done closes the sheet while creating.
- [ ] On the base branch / detached HEAD / unknown base / no commits ahead, the
  sheet shows the matching desktop sentence and no action.
- [ ] Not connected, a non-git/scratch folder, or a connected account in a repo
  whose origin isn't GitHub: the branch is a plain label (no tap target).
- [ ] With a PR: reviewers, unresolved threads and mergeability are shown;
  Merge is disabled with a visible reason unless checks are green, threads are
  0 and GitHub reports mergeable; Merge asks to confirm and sends exactly the
  PR number and head SHA shown when the dialog opened, even if a poll changed
  the PR meanwhile; success and each failure kind show a message.
- [ ] In a read-only background-job chat, no "Send to agent" or "Send failures
  to the agent" control appears anywhere reachable from the header (branch
  sheet → review line comment, review saved draft, checks sheet).
- [ ] Review changes pushes the review screen; Open on GitHub opens Safari.
- [ ] Polling runs every 5 s only while the chat is on screen and the app is
  active; a failed poll leaves the last state in place.

---

## 3. Feature B — Checks chip, check list, "Send failures to the agent"

### B.1 Desktop behaviour

- Chip registered only when there is a PR, ≥1 check and a non-`none` rollup
  (SessionHeader.tsx:262-266). `checksChipDescriptor` (chatUtils.ts:4052):
  green `✓ {passed}` (ok tone), red `✗ {failed} failed` (danger), yellow
  `◐ {running} running` (warn). Glyph + colour, never colour alone.
- `checkTone` (chatUtils.ts:4010): no conclusion OR status `queued`/`in_progress`
  → running; `success` → ok; anything else → error. `countsForChecks`
  (:4027), `orderChecks` failed → running → passed, stable (:4020).
- Popover (`ChecksPanel`, SessionHeader.tsx:1543-1595): header "Checks" + count;
  every check as a row with a status dot; a check with a URL is a link to its
  own log; the raw conclusion/status is the tooltip (CheckRow :1512-1541).
  Footer: **↻ Send failures to the agent** (only when ≥1 failed check) and
  **Open logs ↗** (URL = first failing check with a URL, else any check URL,
  else the PR URL).
- Send failures (`failuresToAgentPrompt`, chatUtils.ts:4101) builds:
  ```
  Checks are failing on this pull request:
  - <name> (<url>)
  - <name>

  Please investigate and fix them.
  ```
  and FILLS the composer, never sends (`onFillComposer` →
  `updateInputWithHistoryReset`, ChatPanel.tsx:3416 — replaces the input).

### B.2 iOS design

- `GitChecksChip` (in `GitSessionHeaderRow.swift`): capsule with the
  descriptor label, tinted `tokens.ok/warn/danger`; `Button` → `GitChecksSheet`
  (`.presentationDetents([.medium, .large])`). Rendered only when
  `GitChecks.descriptor(...) != nil` and a PR exists.
- `GitChecksSheet` (`MantaUI/GitChecksSheet.swift`): `List` of
  `GitChecks.ordered(checks)`; each row: status symbol (`checkmark.circle.fill`
  ok, `xmark.circle.fill` error, `circle.dotted` running — symbol + colour),
  name, secondary text = raw conclusion/status (the desktop tooltip, made
  visible). Rows with a URL are `Button`s → `openURL(url)` with a trailing
  `arrow.up.right`; rows without a URL are plain. Toolbar title "Checks (N)".
  Bottom bar (`safeAreaInset(edge: .bottom)`):
  - **Send failures to the agent** — only when the prompt is non-empty AND
    `onSendFailures != nil` (nil for read-only chats, A.3a). Calls it with the
    prompt (C3 `insert(text:mode: .append)` — D6; append = existing draft +
    blank line + text, just the text into an empty draft), dismisses the sheet
    on `true`, and the composer now shows the text (the visible outcome); on
    `false` the sheet stays with "Couldn't add it to your message." **Deliberate
    difference (D6):** desktop replaces the composer text; iOS keeps an
    in-progress draft.
  - **Open logs** — `openURL(GitChecks.logURL(checks:, prURL:))`; hidden if nil.

### B.3 Pure logic (in `GitForgeModels.swift`) + tests

`enum GitChecks { tone(_:), ordered(_:), counts(_:), descriptor(rollup:counts:),
failuresPrompt(_:), logURL(checks:prURL:) }`. Tests in `GitForgeTests.swift`:
`testToneRunningWhenNoConclusionOrQueued`, `testToneOkAndError`
(success/failure/cancelled/timed_out), `testOrderedFailedRunningPassedStable`,
`testCounts`, `testDescriptorPerRollupAndNoneIsNil`,
`testFailuresPromptExactText` (with and without URL), `testFailuresPromptEmptyWhenNoFailures`,
`testLogURLPrefersFirstFailingThenAnyThenPR`.

### B.4 Acceptance

- [ ] A PR with checks shows `✓ 7` / `✗ 2 failed` / `◐ 3 running` beside the branch chip; no PR or no checks → no chip.
- [ ] The checks sheet lists every check failed-first; tapping a check with a log opens it in Safari.
- [ ] "Send failures to the agent" appears only when something failed and the chat is writable, appends the exact desktop text to the composer without sending, and closes the sheet; a rejected insert shows a message.
- [ ] "Open logs" opens the first failing check's log (fallbacks as above).

---

## 4. Feature C — Connect GitHub offer + device-code sign-in

### C.1 Desktop behaviour

- **Offer** (`ConnectOffer`, SessionHeader.tsx:1606-1632): one info line under
  the header — "Connect GitHub to see checks and pull requests for this repo."
  with **Connect** and **×**. Shown only when not connected, the origin is a
  forge, and not permanently dismissed (`shouldOfferForgeConnect`). × writes
  `configUpdate({forgeConnectOfferDismissed: true})` optimistically
  (ChatPanel.tsx:1163-1169). Connect opens the device-code modal
  (ChatPanel.tsx:3570-3590); on connected it closes and refreshes the forge
  state so the chips appear.
- **Device flow** (`ConnectGithubPanel`, ConnectGithub.tsx:77-333), the ONE
  implementation (also used by Clone from GitHub, CloneFromGitHub.tsx:274):
  - On open: `forge:device-start`. `notConfigured` → "GitHub sign-in isn't
    configured on this server yet." + Back. `connected:true` → done
    immediately. Otherwise show the code; the code is auto-copied to the
    clipboard ("copied to clipboard" note). Throw → error panel "Couldn't
    reach the server. Try again."
  - Code screen: title "Connect GitHub · Waiting for sign-in", countdown
    `m:ss remaining`, step 1 "open this link" (verification URI shown without
    scheme, with copy), step 2 "enter the code" (large mono code, copy),
    **Cancel** (`forge:device-cancel` then close).
  - Poll invariants (ConnectGithub.tsx:17-26, 146-230): one self-rescheduling
    timer, **no immediate first poll**, interval = `max(pollInterval, 5)` s,
    re-read from every `pending` response (honours GitHub `slow_down`);
    `done` → connected; `expired` → "The sign-in code expired before it was
    entered." + **Try again** / **Skip for now**; three consecutive
    `error`/transport failures → "Couldn't sign in: <message>" + **Try again**
    / **Cancel**; any `pending` resets the error budget.

Server: `forgeDeviceStart`/`forgeDevicePoll`/`forgeDeviceCancel`
(forge/index.mjs:421-473). `device_code` never leaves the box.

### C.2 Ownership (D5, D14)

The device sign-in is built **once, by WS04 in wave A**:
`CloneFromGitHubSignIn.swift` declares `@MainActor final class
GitHubDeviceSignInStore: ObservableObject` and `struct GitHubDeviceSignInView:
View { init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void) }`;
the `githubDeviceStart/Poll/Cancel` client methods live in WS04's
`MantaAPIClient+Sessions.swift`; its pure logic and tests are WS04's. WS05
creates **no** device-flow store, view, pure type or client method. §C.3 is the
behavioural contract D5 says WS04 implements; §C.4 is the only part WS05 builds.

### C.3 Behavioural contract for `GitHubDeviceSignInView` (implemented by WS04)

Stages and copy are the desktop's (C.1):
- `.starting`: `ProgressView` "Preparing sign-in…".
- `.code(grant)`: title "Connect GitHub", subtitle "Waiting for sign-in" with
  the live countdown `m:ss remaining`; step 1 "Open this link" → **Open
  github.com/login/device** (`openURL`) + **Copy link**; step 2 "Enter the
  code" → large monospaced code + **Copy code**; note "Code copied to
  clipboard" after the one automatic `UIPasteboard.general.string = userCode`
  (on entering this stage) and after a manual copy. **Cancel**.
- `.notConfigured`: "GitHub sign-in isn't configured on this server yet." + **Back**.
- `.expired`: "The sign-in code expired before it was entered." + **Try again** / **Skip for now**.
- `.error(msg)`: "Couldn't sign in: {msg}" + **Try again** / **Cancel**.
- `.connected` → `onConnected()` exactly once.

Poll invariants (desktop `ConnectGithub.tsx:17-26, 146-230`): no immediate
first poll; interval = `max(pollInterval, 5)` s, re-read from every `pending`
reply (`slow_down`); `pending` resets the error budget; 3 consecutive
`error`/transport failures → `.error` (server message, or "GitHub sign-in
failed." when empty; transport → "Couldn't reach the server. Try again.");
`done` → connected; `expired`, or the local deadline passing → `.expired` and
polling stops.

**Lifecycle (required, review finding 8):**
1. **One loop owner.** The store owns at most one poll `Task` (`pollTask`).
   Starting a loop always cancels and replaces the previous one; there is no
   second entry point that can spawn a loop.
2. **Generation guard.** Every start (first open and every **Try again**)
   increments `generation`; each start/poll reply is applied only if the
   generation it was issued under is still current. A late `device-start` or
   `device-poll` reply from a dismissed or restarted flow is dropped — it can
   never call `onConnected`, change the stage, or reschedule.
3. **Cancellation on every exit.** `onDisappear` (swipe dismissal, Done, parent
   navigation), Cancel/Back/Skip and Try again all: cancel `pollTask`, bump
   `generation`, and — if a grant exists — send `forge:device-cancel`.
   Cancel/Back/Skip **await** that call before invoking `onCancel()`; a failed
   cancel is logged (`os_log`, desktop logs via `ship("warn", …)`) and does not
   block local dismissal (the grant simply expires box-side; the server's
   cancel is a no-op for an unknown grant, forge/index.mjs:465-473).
   `onDisappear` fires the cancel without awaiting (the view is gone).
4. **Foreground wake.** On `scenePhase` → `.active` the store does **not**
   start a loop; it only signals the existing `pollTask` (an
   `AsyncStream`/continuation "wake" the loop awaits alongside its sleep). The
   loop then polls at once only if `now - lastPoll >= interval`
   (`shouldPollNow`), else resumes sleeping for the remainder — so returning
   from Safari can neither double-poll nor beat the interval.

Lifecycle tests WS04 must include (in its `CloneFromGitHub*` test file):
dismissal during `.starting` (late start reply ignored, no `onConnected`),
Try again while a poll is outstanding (old reply ignored, one loop running),
foreground wake during sleep (no extra loop; poll only when interval elapsed),
Cancel awaits `device-cancel` and still dismisses when it throws.

### C.4 What WS05 builds

- **`GitConnectOffer`** (in `GitSessionHeaderRow.swift`): a compact info row
  with the desktop sentence "Connect GitHub to see checks and pull requests for
  this repo.", a **Connect** button and an **×** (`accessibilityLabel("Dismiss")`).
  × hides immediately, then `configUpdate(["forgeConnectOfferDismissed": true])`;
  a failed write keeps it hidden for this run (desktop parity,
  `ChatPanel.tsx:1163-1169`) — no error toast for a dismissal.
- **Connect** presents `.sheet { NavigationStack { GitHubDeviceSignInView(
  onConnected: { dismiss; forgeStore.refreshNow() }, onCancel: { dismiss }) } }`.
  On connected the offer disappears and the chip becomes tappable on the
  immediate refresh.
- The inbox's not-connected state presents the same view (Feature E).

### C.5 Acceptance (WS05 part)

- [ ] In a GitHub-origin chat with no GitHub connection, the offer line appears under the header; × hides it now and it stays hidden after relaunch.
- [ ] Connect opens WS04's sign-in view; after authorising in Safari and returning, it closes by itself and the branch chip becomes tappable without waiting for the next 5 s tick.
- [ ] Cancel or swipe-down leaves the chat unchanged and no sign-in keeps polling (verified via WS04's lifecycle tests).

---

## 5. Feature D — Review screen

### D.1 Desktop behaviour (`ReviewPane.tsx`)

- Target: the session's cwd (box resolves the open PR on the current branch)
  or an inbox `{repoKey, number}` (ReviewPane.tsx:90-110). "Send to agent"
  exists only when there is a session (`canSend`).
- Load (:140-180): `forge:diff(ref)` → `{diff, threads, headSha, stale?, error}`
  and `forge:draft-get(ref)` → `{draft, error}` in parallel; no polling,
  refetch on reopen. Errors: `no_pr` → "No pull request on this session's
  branch.", `not_connected` → "No forge connection to this repository.", else
  → "No linked forge repository."; empty diff → "No diff."; loading → "Loading
  diff…".
- Diff rows via `UnifiedDiff` (ToolBodies.tsx:318-500) with hunk headers shown
  as muted rows; anchors from `commentableLines` (chatUtils.ts:4454-4492): added
  → `{path, line:newLine, side:"new"}`, removed → `{path, line:oldLine,
  side:"old"}`, context → `{path, line:newLine, side:"both"}`; path from
  `+++ b/`, or `--- a/` when the file is deleted to `/dev/null`.
- Threads (:270-345) render under their anchor (`LEFT` → old side, else new;
  no line → top): attribution = first author (+ " · resolved"), every comment
  body, **Reply** → inline reply box (**Reply** / **Cancel**) →
  `forge:thread-reply {…ref, threadId, body}` posts immediately (never
  buffered), then refetches the diff for fresh threads.
- Composing (:346-410): every line has a `+` gutter → inline composer
  "Comment on this line…" with **Send to agent** (primary, session only),
  **Add to review**, **Cancel**. Add → `forge:draft-comment {…ref, op:"add",
  comment:{path,line,side,body}}`. Send to agent → appends the text to the
  chat composer on a new line, does not send (ChatPanel.tsx:1311-1325).
- Your draft comments render as "You · draft" with **Send to agent** and
  **Remove** (`op:"delete"`); once sent: "↳ attached to composer · not yet
  published" (renderer-local flag).
- Pending bar (:418-452), only when ≥1 buffered comment: "N comment(s) not yet
  published", verdict buttons **Approve / Request changes / Comment** (tap →
  `op:"set-verdict"`, selected one highlighted), **Submit** ("Submitting…") →
  `forge:draft-submit {…ref, verdict}`; success clears the draft; failure
  keeps it. If `draft.stale`: warning "The branch moved since you wrote these
  comments — the line anchors may be out of date. Your comments are kept;
  review them before submitting."
- Desktop swallows failures of add/reply/submit silently — iOS must not.

Server: `forgeDiffForCwd` (forge/index.mjs:1248-1272), `draftGetForCwd`
(:1332-1340, marks stale when head moved), `draftCommentForCwd` (:1352-1374;
errors `comment body is required`, `invalid comment anchor`, `comment not
found`, `unknown op`), `replyThreadForCwd` (:1385-1403; `missing threadId`,
`empty reply`, GitHub message), `draftSubmitForCwd` (:1414-1435; **refuses
with "nothing to submit" when the draft has no comments** — so a verdict-only
review is impossible; `kind` e.g. `http_422`). Verdict null submits as a plain
comment review (github.mjs:318-322).

### D.2 iOS design — `ReviewScreen` (`MantaUI/ReviewScreen.swift`)

`ReviewScreen(target: GitRef, sessionId: String?, title: String?, prURL:
String?, onSendToAgent: ((String) -> Bool)?)`, backed by `ReviewStore`
(`MantaUI/ReviewStore.swift`, `@MainActor final class`). Pushed inside the
branch sheet's `NavigationStack` (Feature A) or the inbox sheet's (Feature E).
`onSendToAgent == nil` → no "Send to agent" anywhere (inbox, standalone
`.review` route, and every read-only background-job chat — A.3a). The closure
returns C3's Bool; `false` is surfaced as "Couldn't add it to your message."

- **Toolbar**: title "Review" + subtitle `#N` when known; trailing menu:
  **Open on GitHub** (if `prURL`), **Refresh**.
- **States**: loading → `ProgressView("Loading diff…")`; `error` → desktop
  sentence + **Try again**; empty diff → "No diff."; `stale` diff result →
  footnote banner "Showing last known diff — GitHub didn't answer.".
  `.refreshable` re-runs both loads.
- **Body**: `ScrollView` + `LazyVStack(pinnedViews: .sectionHeaders)`, one
  `Section` per file from `ReviewDiff.parse`: header = path (middle-truncated,
  monospaced) + `+A −D`; file-level/unplaced threads first; then rows. Each row
  is monospaced, wraps (no horizontal scroll), with old/new line numbers and a
  coloured background (`tokens.ok`/`tokens.danger` at low opacity), hunk
  headers as muted rows. Row ids are deterministic: `"\(fileIndex):\(rowIndex)"`.
  Files over 400 rows start collapsed with "Show N lines" (perf on a phone).
- **Commenting**: tapping a commentable row (or its context menu "Comment on
  this line") opens `ReviewCommentSheet` (`.presentationDetents([.medium])`)
  showing the line being commented on, a `TextEditor` ("Comment on this
  line…"), and buttons **Send to agent** (prominent; only with
  `onSendToAgent`), **Add to review**, **Cancel**. Both actions are disabled on
  empty/whitespace text.
  - Send to agent → `onSendToAgent(text)` (C3 `.append`: existing draft +
    blank line + text — master C3; desktop joins with one newline,
    `ChatPanel.tsx:1321`, a cosmetic difference accepted for one shared
    append rule). On `true` the sheet closes and a transient banner "Added to
    your message — not sent yet" confirms (the composer is not visible from
    here); on `false` the sheet stays open with the error.
  - Add to review → busy spinner; success closes the sheet and the comment
    appears inline; failure keeps the sheet open with the text and shows the
    server error in red.
- **Threads** inline under their row as cards: author (+ " · resolved"),
  comments in order with author and relative time when `createdAt` is present,
  **Reply** → `ReviewReplySheet` (TextEditor "Reply…", **Reply** / **Cancel**);
  success refetches the diff (threads) and closes; failure keeps text + error.
- **Your draft comments** inline as "You · draft" cards with **Send to agent**
  (when available and not yet sent this screen) and **Remove** (also as a
  swipe/context action); after sending: "↳ added to your message · not yet
  published". Remove failure → inline error, card stays.
- **Pending bar** (`safeAreaInset(edge: .bottom)`), only when ≥1 draft comment:
  stale warning (desktop copy) when `draft.stale`; "N comment(s) not yet
  published"; a segmented `Picker` Approve / Request changes / Comment bound to
  `draft.verdict` (no selection = none; choosing calls `set-verdict`,
  optimistic, reverted with an error on failure); **Submit review** primary
  ("Submitting…"). Success → banner "Review submitted" then the bar
  disappears and the threads refetch. Failure → "Couldn't submit — your
  comments are kept. ({error})"; `nothing to submit` → "Add at least one line
  comment before submitting." (server rule; desktop never reaches it because
  the bar is hidden at zero).
- Threads whose anchor does not match any rendered row are **not dropped** —
  they show at the top of their file (or the top of the review if the file
  isn't in the diff). (Desktop silently loses a thread on a context line
  because it keys rows by side, `ToolBodies.tsx:340-355`; iOS matches by the
  line coordinate of the thread's side — see `ReviewDiff.place`.)

### D.3 Pure logic — `ReviewDiff.swift` (Foundation-only) + tests

```swift
struct ReviewAnchor: Hashable, Sendable { var path: String; var line: Int; var side: Side; enum Side: String { case new, old, both } }
struct ReviewDiffRow: Equatable, Sendable { enum Kind { case hunk, added, removed, context }; var kind: Kind; var text: String; var oldLine: Int?; var newLine: Int?; var anchor: ReviewAnchor? }
struct ReviewDiffFile: Equatable, Sendable { var path: String; var rows: [ReviewDiffRow]; var added: Int; var removed: Int }
enum ReviewDiff {
  static func parse(_ diff: String) -> [ReviewDiffFile]          // splits on `diff --git` / `--- `+`+++ `; drops Index:/===/--- /+++ preamble; keeps @@ as .hunk
  static func anchors(_ diff: String) -> [ReviewAnchor]           // exact port of commentableLines (chatUtils.ts:4454)
  static func threadAnchor(path: String?, line: Int?, side: String?) -> ReviewAnchor?  // LEFT → .old else .new; nil line → nil
  static func place(threads: [GitThread], drafts: [GitDraftComment], in files: [ReviewDiffFile]) -> ReviewPlacement
       // ReviewPlacement: byRow[(fileIndex,rowIndex)] → [note ids], topOfFile[fileIndex], unplaced
       // matching is by COORDINATE, never by comparing a note's line to a .both anchor's line:
       //   thread LEFT  (.old)  → the row in that file whose oldLine == line (removed or context rows)
       //   thread RIGHT (.new)  → the row whose newLine == line (added or context rows)
       //   draft .new → added row with newLine == line; draft .old → removed row with oldLine == line;
       //   draft .both → context row with newLine == line (commentableLines emits the NEW counter for context, chatUtils.ts:4486-4489)
       //   no match → topOfFile (path known) or unplaced
  static func pendingLabel(_ count: Int) -> String   // "1 comment" / "N comments"
  static func submitErrorCopy(error: String, kind: String?) -> String
}
```

Tests — `MantaUITests/ReviewDiffTests.swift`:
`testAnchorsMatchDesktopCommentableLines` (fixture with two files, add/remove/
context; expected array copied from `chatUtils.test.ts` cases),
`testDeletedFileUsesAPath`, `testHunkHeaderResetsLineNumbers`,
`testParseSplitsFilesAndCountsPlusMinus`, `testParseDropsPreambleKeepsHunks`,
`testEmptyDiffYieldsNoFiles`, `testThreadAnchorLeftIsOld`,
`testThreadAnchorNoLineIsNil`, `testPlaceExactMatch`,
`testPlaceNewThreadOnContextRow`,
`testPlaceLeftThreadOnContextRowUsesOldLine` (fixture where a hunk inserted 3
lines above, so one context row is old 10 / new 13 and another is new 10: a
LEFT thread at line 10 lands on the old-10 row, not the new-10 row),
`testPlaceLeftThreadOnRemovedRow`, `testPlaceDraftBothUsesNewLine`,
`testPlaceUnmatchedGoesTopOfFile`,
`testPlaceUnknownFileGoesUnplaced`, `testPendingLabel`,
`testSubmitErrorCopyNothingToSubmit`, `testDecodeDraftWithNullVerdict`,
`testDecodeThreadComments`.

### D.4 Acceptance

- [ ] From a chat with a PR, Review changes shows the PR diff grouped by file with line numbers, existing threads under their lines, and your saved draft comments.
- [ ] Tapping a line lets you write a comment and either put it in the chat message (not sent) or add it to the review; both say what happened; a failed add keeps your text.
- [ ] Replying to a thread posts immediately and the reply appears after refresh; failures show a message.
- [ ] With ≥1 draft comment the bottom bar shows the count, a verdict choice and Submit review; submit success clears the draft; failure keeps it with a message.
- [ ] When the branch moved since the comments were written, the desktop warning appears and nothing is discarded.
- [ ] Opened from the inbox (no session) or from a read-only background-job chat, no "Send to agent" control is shown anywhere (line composer or saved drafts).
- [ ] A thread on the old side of an unchanged line appears under the right line even when lines were added above it.
- [ ] A 3,000-line diff scrolls smoothly (large files collapsed by default).

---

## 6. Feature E — Work inbox

### E.1 Desktop behaviour (`InboxPalette.tsx`)

- Opened from the command palette (Sidebar.tsx:1008-1015). One fetch on open,
  never polled (:103-138): `forge:inbox` and, in parallel, `forge:probe`
  (repoKey → local path map; failure ignored). `error:"not_connected"` →
  "GitHub isn't connected on this server."; throw → "Couldn't load the
  inbox."; loading "Loading inbox…"; empty "Nothing needs you right now.";
  filtered empty `No inbox matches "q"`. Header "Inbox" + count. Filter by
  title or number.
- Rows (`sortInbox` chatUtils.ts:4953: dedupe by `repoKey#number`, more urgent
  reason wins — checks failing > review requested > assigned — then
  `updatedAt` desc): dot (checks failing = red, review requested = amber,
  assigned = grey), identifier `!N` for PRs / `#N` for issues, title,
  secondary = `inboxReasonLabel` ("checks red" / "review requested" / "issue ·
  assigned to you") plus ` · repo` for PRs, trailing age (`formatAge`
  chatUtils.ts:542: "now" / "Nm" / "Nh" / "Nd").
- Actions on the selected row:
  - **Start a session** (:157-200): needs a local checkout of the repo (else
    "No local checkout of {repo} on this server to start a session in.");
    `git:add-worktree {cwd: path, name: "manta/{issue|pr}-{N}-{slug≤40}"}`;
    `tmux:new-session {name: uniqueSessionName(deriveProjectName(path)), cwd:
    worktreePath, windowName:"default", chatMode:true, createDir:false,
    forgeIssue:{repoKey, number}}` (`forgeIssue` for **issues only**; the box
    stamps `@manta-forge-issue` so a later PR body gets "Closes #N",
    rpc.mjs:1011-1030, 1252); lands in the session with the box-built seed
    (`"Complete {url}"`, forge/index.mjs:803) in the composer, NOT sent.
  - **Open review** (:245-253): PRs only; opens ReviewPane with `{repoKey,
    number}` over the inbox ("Back to inbox").
  - **Delegate in background** (:206-238): needs a local checkout and an active
    chat session as parent ("Open a chat session first — a background job nests
    under its parent session."); `delegate:start {prompt: seed, sessionID:
    parent, directory: repoPath}`; `ok:false` → its error or "Couldn't start
    the background job.".

### E.2 iOS design

- **Entry point**: a toolbar button on the session list (`tray` symbol,
  accessibility "Inbox") → `sheetRoute = .inbox` (new `SheetRoute` case,
  M-05-2) → `InboxWorkScreen` (large detent).
- **`InboxWorkStore`** (`MantaUI/InboxWorkStore.swift`, `@MainActor final
  class`): `load()` on appear and on pull-to-refresh (no polling) running
  `forge:inbox` and WS04's `repoProbe()` concurrently (probe failure ignored,
  as desktop); holds `items`, `repoPaths: [String: String]` (repoKey → path),
  `phase: .loading | .loaded | .notConnected | .failed(String)`,
  `actionError: String?`, `actionNotice: String?`, `busyItem: String?`.
- **`InboxWorkScreen`** (`MantaUI/InboxWorkScreen.swift`): `NavigationStack`,
  title "Inbox" with the count in the subtitle; `.searchable(prompt: "Filter
  inbox…")`; states with the desktop copy; for `.notConnected` also a
  **Connect GitHub** button presenting WS04's `GitHubDeviceSignInView`
  (§C.4; on connected → reload). Rows: leading SF Symbol + tint by reason
  (`xmark.circle.fill` red / `eye.circle.fill` amber / `circle` grey — symbol,
  not colour alone), identifier + title (2 lines), secondary line, trailing age
  (ticks every 60 s).
- **Row actions**: tapping a row shows a `confirmationDialog` titled with the
  identifier + title (also available as the row's context menu):
  - **Start a session** — always listed. No local checkout → the desktop
    message "No local checkout of {repo} on this server to start a session in."
    Otherwise (D12) the inbox **creates nothing**: it builds
    `WorkInbox.draft(for: item, repoPath:)` =
    `NewSessionDraft(cwd: repoPath, text: item.seed, attachments: [],
    worktreeBranch: WorkInbox.branchName(item), linkedIssueURL: item.url)`
    (seed is the box's "Complete {url}", forge/index.mjs:803, so it contains
    the issue/PR URL), dismisses the inbox (`sheetRoute = nil`) and calls
    `navigator.startNewSession(draft)`. WS04's create sheet then shows the
    repo preselected, "new worktree" pre-ticked with that branch and the link
    as a header line; the worktree and session are created only when the user
    taps **Create**, and the chat opens with the seed unsent. Cancelling the
    create sheet leaves the box untouched. The desktop's `forgeIssue` session
    stamp (rpc.mjs:1252) is **dropped** (D12): a PR later shipped from that
    session gets the plain drafted body, without an automatic "Closes #N".
  - **Open review** — PRs only (not listed for issues — no dead control);
    pushes `ReviewScreen(target: .pr(repoKey:, number:), sessionId: nil, title:
    "!N title", prURL: item.url, onSendToAgent: nil)`.
  - **Delegate in background** — listed when a local checkout exists. The
    parent session is chosen from a second dialog "Run under which session?"
    (D9) listing chat sessions (windows with `opencodeSessionId` and not job
    windows, from `projects()`), sessions whose cwd is inside the repo path
    first. No chat sessions → the action isn't listed. Calls
    `delegateStart(prompt: item.seed, sessionID: parent, directory: repoPath)`
    (the delegate engine makes its own worktree, as desktop). Success →
    `actionNotice` "Background job started under {session}" (the sheet stays;
    the banner is the visible confirmation). `ok:false` → its error or
    "Couldn't start the background job."; a throw → its message.
  - **Open on GitHub** — the row's `url` (desktop shows it as the row
    tooltip; on a phone it must be an action to be reachable).

### E.3 Pure logic — `InboxWorkModels.swift` (Foundation-only) + tests

`WorkInboxItem` (Decodable, `kind`, `repoKey`, `number`, `title`, `url`,
`state`, `rollup`, `updatedAt` ms, `reason: WorkInboxReason`
(`checksFailing|reviewRequested|assigned|other(String)`), `seed`), and
`enum WorkInbox { sorted(_:) (dedupe+priority+updatedAt desc), filter(_:query:)
(title contains, case-insensitive, or number contains), reasonLabel(_:),
identifier(_:), repoName(_:), secondary(_:), branchName(_:) (exact port of
InboxPalette.tsx:73-80), formatAge(ms:) (chatUtils.ts:542),
draft(for:repoPath:) -> NewSessionDraft?` (nil when `repoPath` is nil; the
`NewSessionDraft` type is WS04's, declared in `MantaNavigation.swift` per D2 —
that file is not in the Linux package, so `draft(for:)` lives in
`InboxWorkStore.swift` instead and is tested from Xcode; the pure file returns
a `WorkInboxDraftFields { cwd, text, worktreeBranch, linkedIssueURL }` value
that the store maps 1:1), `parentCandidates(sessions:, repoPath:)` (takes plain
`(sessionID, name, cwd)` tuples, not `MantaWindow`).

Tests — `MantaUITests/InboxWorkTests.swift` (pure, `verify.sh`):
`testSortDedupesMoreUrgentReasonWins`, `testSortUpdatedAtDescending`,
`testFilterByTitleAndNumber`, `testReasonLabels`, `testIdentifierBangForPR`,
`testSecondaryHasRepoOnlyForPR`, `testBranchNameSlugAndCap` (punctuation,
40-char cap, empty title), `testFormatAgeBuckets`,
`testDraftFieldsCarryRepoBranchSeedAndURL`, `testDraftFieldsNilWithoutCheckout`,
`testParentCandidatesRepoFirst`, `testDecodeUnknownReasonKept`,
`testDecodeNotConnected`.
Xcode-only — `MantaUITests/InboxWorkStoreTests.swift`:
`testStartSessionCallsNavigatorAndCreatesNothing` (fake client records zero
`git:add-worktree`/`tmux:new-session` calls; navigator's `pendingDraft` equals
the expected draft).

### E.4 Acceptance

- [ ] The session list has an Inbox button; the inbox shows assigned issues, PRs awaiting my review and my PRs with red checks, most recent first, no duplicates, filterable.
- [ ] Not connected → the desktop message plus a Connect GitHub button that, once signed in, loads the inbox.
- [ ] Start a session closes the inbox and opens the create sheet pointed at the repo, with "new worktree" ticked and the branch named `manta/{issue|pr}-N-…`, and the link shown; nothing exists on the box until Create; after Create the chat opens with "Complete <url>" in the composer, unsent.
- [ ] Cancelling that create sheet leaves no worktree, branch or session behind.
- [ ] Open review is offered only for PRs and opens the review screen without "Send to agent".
- [ ] Delegate in background asks which session to run under and confirms the job started; with no chat sessions it isn't offered.
- [ ] Every failure (no checkout, delegate refused, load error) shows a message.

---

## 7. Files

All new, within WS05's prefixes. WS05 edits existing files only through the
mounts in §8 (wave C runs alone, D18).

| File | Kind | In Linux `Package.swift` (D19)? |
|---|---|---|
| `MantaUI/MantaAPIClient+Git.swift` | API extension (C1), members in §12 | no |
| `MantaUI/GitForgeModels.swift` | wire types + `GitPanel`/`GitChecks`/`GitCopy`/`GitForgeState`/`GitMergeTarget`/`GitShipPreviewState` (Foundation-only) | **yes** |
| `MantaUI/GitForgeStore.swift` | `@MainActor` store (poll, ship, merge) + `GitForgeClient` + `GitSessionLookup` | no |
| `MantaUI/GitSessionHeaderRow.swift` | branch chip + checks chip + connect offer + `GitComposerBridge` (mounted view) | no |
| `MantaUI/GitBranchSheet.swift` | branch/PR sheet | no |
| `MantaUI/GitChecksSheet.swift` | checks list sheet | no |
| `MantaUI/ReviewDiff.swift` | diff parse, anchors, placement (Foundation-only) | **yes** |
| `MantaUI/ReviewStore.swift` | `@MainActor` review store | no |
| `MantaUI/ReviewScreen.swift` | review screen + `ReviewCommentSheet` + `ReviewReplySheet` + `ReviewScreen.forSession(_:)` | no |
| `MantaUI/InboxWorkModels.swift` | work-inbox types + pure helpers (Foundation-only) | **yes** |
| `MantaUI/InboxWorkStore.swift` | `@MainActor` inbox store (+ `NewSessionDraft` mapping) | no |
| `MantaUI/InboxWorkScreen.swift` | inbox sheet | no |
| `MantaUITests/GitForgeTests.swift` | XCTest, pure | **yes** |
| `MantaUITests/ReviewDiffTests.swift` | XCTest, pure | **yes** |
| `MantaUITests/InboxWorkTests.swift` | XCTest, pure | **yes** |
| `MantaUITests/GitForgeStoreTests.swift` | XCTest, store (fake client) | no |
| `MantaUITests/InboxWorkStoreTests.swift` | XCTest, store | no |

No device-flow files (D14 — WS04's `CloneFromGitHubSignIn.swift`). Never touch
`InboxModels.swift`. `project.yml` sources the `MantaUI/` directory, so no
project edit is needed; `project.pbxproj` is regenerated once by the
orchestrator (D18) — WS05 never edits it.

## 8. Mount requests

Wave C runs WS05 alone, so per D18 WS05 applies all of its own mounts in any
file; `Package.swift` goes through the wave-C integration step (D18/D1).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-05-1 | `ChatScreen.swift` (`sessionHeaderBlock`, today :1131-1150) | WS05, wave C | `GitSessionHeaderRow` | Replace the `subtitleChip` call with `GitSessionHeaderRow(branch: branch, relPath: branchRelPath, cwd: sessionWindow?.cwd, sessionId: store.sessionId, shipModel: modelStore.override, tokens: tokens)`; delete the now-unused `subtitleChip` / `branchCapsuleInfo` (the row renders the identical plain label when the forge isn't in play). ChatScreen's own branch poll is untouched. | WS02 wave B landed (`ChatScreen` + `jobOwnership`); WS03 M-03-3 (`composerController` env on `ChatScreenContent`) and WS02 M-03-7 (`acceptsInput`) applied |
| M-05-2 | `SessionListView.swift` | WS05, wave C | `InboxWorkScreen` | (a) `SheetRoute` gains `case inbox` (`id: "inbox"`); (b) new `ToolbarItem(placement: .topBarTrailing)` before the `+` button: `Image(systemName: "tray")`, `.accessibilityLabel("Inbox")`, action `sheetRoute = .inbox` (with the existing selection haptic); (c) `sheetContent` case `.inbox` → `InboxWorkScreen(onClose: { sheetRoute = nil })`. The inbox's Start-a-session sets `sheetRoute = nil` then `navigator.startNewSession(draft)`, which WS04's `pendingDraft` consumer turns into `.create`. | WS04 wave A (`MantaNavigator.startNewSession`, `pendingDraft` consumer) |
| M-05-3 | `SessionListView.swift` (WS04's `navigator.pending` consumer) | WS05, wave C | `ReviewScreen.forSession(_:)` | WS04's consumer ignores `.review` (04-sessions §11). Add: `case .review(let sid)`: dismiss the settings cover, `sheetRoute = .review(sessionID: sid)` (new `SheetRoute` case, `id: "review:\(sid)"`), clear `pending`; `sheetContent` → `NavigationStack { ReviewScreen.forSession(sid) }` (resolves cwd via `GitSessionLookup.cwd(for:in: store.projects)`; unknown session → "That session is no longer open"; `onSendToAgent: nil`). | WS04 wave A navigator consumer |
| M-05-4 | `mobile/native/Package.swift` | Integration agent, wave C (D18; owner WS07 per D1) | — | Append `GitForgeModels.swift`, `ReviewDiff.swift`, `InboxWorkModels.swift` to the `MantaUI` target `sources`, and `GitForgeTests.swift`, `ReviewDiffTests.swift`, `InboxWorkTests.swift` to `MantaUITests` `sources`; then `./verify.sh` must pass (D19). | WS05 files exist (end of wave C) |

## 9. Mounts applied by this workstream

| ID | Requested by | Receiving file | Status |
|---|---|---|---|
| M-05-1 … M-05-3 | WS05 | as above | applied by WS05 in wave C |

Cross-checked the `Mount requests` tables of 01–04 and 06–10 in this folder:
no other workstream requests a mount in a `Git*`, `Review*` or `Inbox*` file,
and none is assigned to WS05 as applier. (WS10's GitHub settings row explicitly
does not add a Connect button — `10-settings-box.md:278-279`.)

## 10. Contracts provided / consumed

**Consumed**
- **C1/D16**: internal `call`/`callRequired`/`jsonObject`; WS10's
  `forgeStatus(validate:)` + its status type; WS04's `repoProbe()`; existing
  `configGet`/`configUpdate`/`projects()`.
- **C2**: `MantaNavigator.startNewSession(_:)` (inbox) and `.review(sessionID:)`
  handling (M-05-3, WS05 implements it per C2).
- **C3/D6**: `EnvironmentValues.composerController`,
  `insert(text:mode: .append)` → Bool (every `false` surfaced),
  `acceptsInput`. `.append` = existing draft + one blank line + text.
- **D2/D11/D12**: `NewSessionDraft(cwd:, text:, attachments: [],
  worktreeBranch:, linkedIssueURL:)`; one Create tap; no worktree/session
  created by WS05; `forgeIssue` dropped.
- **D5/D14**: `GitHubDeviceSignInView(onConnected:onCancel:)`.
- **C4**: M-05-1 (branch chip → `GitBranchSheet`, checks chip beside it).
- **C5/C6**: none. `forgeConnectOfferDismissed` uses `config:*`, not the schema.
- **C7/D19**: pure tests under `verify.sh`; store tests on the Mac. No server
  change → no node tests.

**Provided**
- `ReviewScreen` + `ReviewScreen.forSession(_:)` (C2 `.review`).
- The §C.3 behavioural contract that WS04's sign-in view implements (D5).

## 11. Deferred

- **Approve without any line comment** — the box refuses to submit a draft with
  zero comments (`draftSubmitForCwd`, forge/index.mjs:1418), and the desktop
  hides the bar at zero. Supporting it is a server change outside parity.
- **Automatic "Closes #N" for inbox-started sessions** — dropped by D12 (the
  create sheet has no `forgeIssue` pass-through).
- **Editing a buffered draft comment** (`op:"edit"`) — no desktop UI.
- **Multi-line comment ranges** (`startLine`) — desktop never sends one.
- **Live refresh from `forge-draft.updated` / `forge.inbox.invalidated`** — no
  client consumes them; iOS stays refetch-driven.
- **Choosing the merge method** — desktop always sends `"merge"`.

## 12. Client members

New `MantaAPIClient` members, all in `MantaUI/MantaAPIClient+Git.swift`
(grepped every other spec: no other workstream declares these names):

```swift
func forgePullRequest(cwd: String) async throws -> GitPullRequestResult            // forge:pull-request
func forgeShipPreview(cwd: String, model: OpencodeModelID?, sessionId: String?) async throws -> GitShipPreviewResult  // forge:ship-preview
func forgeShip(cwd: String, title: String, body: String) async throws -> GitShipResult   // forge:ship
func forgeMerge(cwd: String, number: Int, sha: String) async throws -> GitMergeResult    // forge:merge (method "merge")
func forgeDiff(_ ref: GitRef) async throws -> GitDiffResult                               // forge:diff
func forgeDraftGet(_ ref: GitRef) async throws -> GitDraftGetResult                       // forge:draft-get
func forgeDraftComment(_ ref: GitRef, op: GitDraftOp) async throws -> GitDraftCommentResult  // forge:draft-comment
     // GitDraftOp: .add(path:line:side:body:) | .delete(id:) | .setVerdict(GitVerdict?)
func forgeDraftSubmit(_ ref: GitRef, verdict: GitVerdict?) async throws -> GitDraftSubmitResult  // forge:draft-submit
func forgeThreadReply(_ ref: GitRef, threadId: String, body: String) async throws -> GitThreadReplyResult  // forge:thread-reply
func forgeInbox() async throws -> WorkInboxResult                                         // forge:inbox
func delegateStart(prompt: String, sessionID: String, directory: String) async throws -> GitDelegateStartResult  // delegate:start
```

**Not declared by WS05** (consumed, D16): `forgeStatus(validate:)` (WS10),
`repoProbe()` and `githubDevice*` (WS04), `configGet`/`configUpdate`/`projects`
(existing). WS05 must not add `forgeProbe`, `gitAddWorktree`,
`forgeDeviceStart/Poll/Cancel` or a zero-argument `forgeStatus()`.

## 13. Open questions

None blocking. (Round-1 questions 1–4 are settled by D12, D5/D14, D6 and D9.)

## Review responses (round 1)

Per-workstream review (`reviews/round1/05-git-pr-review.md`):

1. **BLOCKING — inbox creation vs D2.** Fixed (§E.2, §E.4, §10, §11): the inbox
   builds `NewSessionDraft(cwd: repoPath, text: seed, worktreeBranch:,
   linkedIssueURL: url)` and calls `navigator.startNewSession`; no
   `git:add-worktree`/`tmux:new-session` call from WS05; Create is the only
   mutation; `forgeIssue` dropped per D12 (deferred item). New acceptance
   "cancelling the create sheet leaves nothing behind" + store test asserting
   zero mutating calls.
2. **BLOCKING — device-flow ownership.** Fixed (§4 C.2–C.4, §7, §12): WS04 owns
   `GitHubDeviceSignInView`/`GitHubDeviceSignInStore` + `githubDevice*` (D14);
   WS05 deleted `GitConnectGitHubSheet`, `GitDeviceFlow*`, their tests and its
   device client methods, and only presents WS04's view. §C.3 is the behavioural
   contract D5 points at.
3. **BLOCKING — read-only chats.** Fixed (A.3a, B.2, D.2, acceptance A.5/D.4):
   bridge is nil when `composerController` is nil or `acceptsInput` is false →
   `onSendToAgent: nil` / `onSendFailures: nil`; second guard re-checks at call
   time and `insert` itself returns false (WS03 M-03-7).
4. **BLOCKING — merge snapshot.** Fixed (A.3): `GitMergeTarget` captured on tap,
   dialog rendered from it, `merge(_ target:)` never rereads state; no force
   unwraps; store tests for a poll replacing and clearing the PR.
5. **SHOULD — ship preview cache.** Fixed (A.3/A.4): preview keyed by
   `{cwd, branch, base}`, late responses discarded, invalidated on branch/base
   change, Create enabled only for a matching ready preview; same-cwd
   branch-switch tests.
6. **SHOULD — LEFT threads on context rows.** Fixed (D.3): matching by
   `oldLine` for LEFT and `newLine` for RIGHT; draft `.both` uses the new line;
   unequal-offset fixture test.
7. **SHOULD — non-forge chip gating.** Fixed (A.3/A.4): interactivity needs
   connected + recognised forge kind + non-nil forge branch; the label stays
   ChatScreen's ordinary branch; test for a connected account in a non-forge repo.
8. **SHOULD — device-flow lifecycle.** Fixed in the contract WS04 implements
   (§C.3 "Lifecycle"): one loop owner, generation guard, cancellation on every
   exit with awaited cancel + logged failure, foreground wake that cannot spawn
   a loop, and four required lifecycle tests.
9. **SHOULD — Done while busy.** Fixed (A.3): Done disabled and guarded while
   creating/merging, plus `interactiveDismissDisabled`; acceptance covers both.
10. **NIT — Package ownership.** Fixed (§8 M-05-4): applier is the wave-C
    integration step on WS07's file (D1/D18).

Cross-cutting review (`reviews/round1/00-cross-cutting.md`), findings naming WS05:

- **#2 producers bypass create flow** — same fix as finding 1.
- **#4 sign-in provider names** — same fix as finding 2; D14 names used verbatim.
- **#6 duplicate `forgeStatus()`** — WS05 no longer declares it; consumes WS10's
  `forgeStatus(validate:)` with `validate: false` (§1, §12).
- **#8 mount ledger** — §8/§9 tables with IDs, appliers, providers and
  prerequisites; all WS05 mounts are applied by WS05 in wave C.
- **#10 package scheduling** — M-05-4 scheduled after WS05's files exist, via
  the wave-C integration step; pbxproj left to the orchestrator.
- **#12 append semantics** — `.append` is one blank line everywhere (C3), Send
  failures appends (D6); the desktop's single-newline review bridge noted as an
  accepted cosmetic difference (D.2).
