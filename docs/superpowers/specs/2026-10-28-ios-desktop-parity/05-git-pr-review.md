# WS05 — Git, pull requests, review, work inbox (iOS)

Status: draft · Wave: **C** · Owner prefix: `Git*`, `Review*`, `Inbox*`
Depends on: WS02 (ChatScreen mounts), WS03 (C3 composer insertion), WS04 (C2
navigator, C3 `NewSessionDraft` create flow, session-list toolbar).

This workstream brings the desktop's GitHub surface to the phone: the branch/PR
sheet behind the chat's branch chip, the checks chip, the "Connect GitHub"
offer + device-code sign-in, the review screen (PR diff, line comments,
threads, verdict, submit) and the work inbox.

**No new server routes.** Every feature uses the existing `forge:*`,
`git:add-worktree`, `tmux:new-session`, `delegate:start` and `config:*` RPC
channels exactly as the desktop does. The only Electron-local pieces on desktop
are `openExternal` (→ iOS `openURL`) and `clipboardWriteText` (→
`UIPasteboard`). No `/events` frames are involved: the box publishes
`forge-draft.updated` (`src/server/forge/draft.mjs:173…249`) and
`forge.inbox.invalidated` (`src/server/index.mjs:1353`) on its bus, but no
client consumes them — the desktop is poll/refetch-driven and iOS matches.

---

## 0. Naming collision — read first

`mobile/native/MantaUI/InboxModels.swift` already exists and is **the pending
messages inbox** (V2 steer/queue), unrelated to this work. It also already
declares `InboxItem`, `InboxSnapshot`, `InboxDelivery`. Therefore:

- Work-inbox files are named `InboxWork*.swift` (still inside the `Inbox*`
  prefix), and **never edit `InboxModels.swift`**.
- Work-inbox types are named `WorkInbox*` (e.g. `WorkInboxItem`), never
  `InboxItem`.
- All forge wire types are prefixed `Git*` (e.g. `GitPullRequest`) — there is no
  `PullRequest`/`Forge*` type on iOS today (verified: no `forge` symbol in
  `MantaUI/*.swift`).

---

## 1. Shared wire contract (all features)

All calls go through `MantaAPIClient.call/callRequired` (made internal by C1)
from a new extension file `MantaUI/MantaAPIClient+Git.swift`. Channel names are
in `src/shared/types.ts:1286-1334` (IPC map); server handlers in
`src/server/rpc.mjs:944-1075`; implementations in `src/server/forge/index.mjs`.
Arguments are one JSON object in `args[0]` (or `args: []` where noted) —
matching `src/renderer/api/httpApi.ts:850-881`.

| Swift method (NEW, `+Git`) | Channel | args[0] | Result type (TS source) |
|---|---|---|---|
| `forgeStatus()` | `forge:status` | none (`args: []`) | `ForgeStatusResult` (types.ts:622) |
| `forgePullRequest(cwd:)` | `forge:pull-request` | `{cwd}` | `ForgePullRequestResult` (types.ts:655) |
| `forgeShipPreview(cwd:model:sessionId:)` | `forge:ship-preview` | `{cwd, model?:{providerID,modelID}, sessionId?}` | `ForgeShipPreviewResult` (types.ts:781) |
| `forgeShip(cwd:title:body:)` | `forge:ship` | `{cwd, title, body}` | `ForgeShipResult` (types.ts:759) |
| `forgeMerge(cwd:number:sha:)` | `forge:merge` | `{cwd, number, method:"merge", sha}` | `ForgeMergeResult` (types.ts:802) |
| `forgeDiff(_ ref:)` | `forge:diff` | `GitRef` (see below) | `ForgeDiffResult` (types.ts:701) |
| `forgeDraftGet(_ ref:)` | `forge:draft-get` | `GitRef` | `ForgeDraftGetResult` (types.ts:842) |
| `forgeDraftComment(_ ref:, op:…)` | `forge:draft-comment` | `GitRef ∪ {op, comment?, verdict?, body?}` | `ForgeDraftCommentResult` (types.ts:866) |
| `forgeDraftSubmit(_ ref:, verdict:)` | `forge:draft-submit` | `GitRef ∪ {verdict?}` | `ForgeDraftSubmitResult` (types.ts:878) |
| `forgeThreadReply(_ ref:, threadId:, body:)` | `forge:thread-reply` | `GitRef ∪ {threadId, body}` | `ForgeThreadReplyResult` (types.ts:890) |
| `forgeInbox()` | `forge:inbox` | none | `ForgeInboxResult` (types.ts:741) |
| `forgeProbe()` | `forge:probe` | none | `ForgeProbeResult` (types.ts:502) — only `repos[].{path, repoKey}` are decoded |
| `forgeDeviceStart()` | `forge:device-start` | none | `ForgeDeviceStartResult` (types.ts:541) |
| `forgeDevicePoll(grantId:)` | `forge:device-poll` | `{grantId}` | `ForgeDevicePollResult` (types.ts:549) |
| `forgeDeviceCancel(grantId:)` | `forge:device-cancel` | `{grantId}` | `{ok}` |
| `gitAddWorktree(cwd:name:)` | `git:add-worktree` | `{cwd, name}` | `{path, branch}` (api.ts:1027; throws with git stderr on failure, local.mjs:295-324) |
| `delegateStart(prompt:sessionID:directory:)` | `delegate:start` | `{prompt, sessionID, directory}` | `{ok, error?}` (types.ts:2643-2649; rpc.mjs:2448) |

`GitRef` is the forge target (types.ts:691):

```swift
enum GitRef: Hashable, Sendable {
    case cwd(String)                          // → {"cwd": path}
    case pr(repoKey: String, number: Int)     // → {"repoKey": k, "number": n}
    var json: [String: Any] { … }
}
```

If WS04's `+Sessions` already defines `gitAddWorktree`, WS05 calls that instead
of adding a second one (grep before adding). `configGet`/`configUpdate` already
exist on `MantaAPIClient` (`MantaAPIClient.swift:752,757`) and are reused.

**Decoding rules** (all wire types live in `GitForgeModels.swift`,
Foundation-only):

- Every type is `Decodable` with `decodeIfPresent` + defaults for every field
  except identity fields, so a new/missing field never drops the payload.
- `ForgeStatusResult` is a union discriminated by `connected`; decode as
  `GitForgeStatus { connected: Bool; login: String?; source: String?; valid: Bool? }`.
- `PullRequest.mergeable` is `true | false | null` → `Bool?` (null = still computing).
- `PullRequest.state` → `String` (`"draft"|"open"|"merged"|"closed"`, unknown kept verbatim).
- `ForgeCheckRun` → `GitCheckRun { name: String; status: String?; conclusion: String?; url: String? }`.
- `CheckRollup` → `GitRollup` enum `green|yellow|red|none` with unknown → `.none`.
- `ForgeDeviceStartResult` has three shapes: `{connected:true, grant:null}`,
  `{connected:false, grant, error:null}`, `{connected:false, notConfigured:true, grant:null}` →
  `enum GitDeviceStart { case alreadyConnected, notConfigured, grant(GitDeviceGrant) }`.
- `ForgeDevicePollResult` → `enum GitDevicePoll { case pending(interval: Int?), done, expired, error(String) }`, unknown status → `.error("unknown status")`.
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
GitForgeStore: ObservableObject`), one per chat screen:

- `@Published private(set) var state: GitForgeState` (pure value: `connected`,
  `kind: String?`, `pr`, `checks`, `rollup`, `stale`, `branch`, `base`,
  `aheadCount`, `offerDismissed`).
- `func run(cwd: String) async` — the poll loop: fetch immediately, then every
  5 s (`BranchFreshnessPolicy.pollInterval`) while not cancelled. Started from
  `.task(id: cwd)` on the mounted header view, so it stops when the chat screen
  disappears and restarts on cwd change. Skips a tick while `scenePhase !=
  .active`.
- Each tick: `async let` both calls; merge with `GitForgeState.applying(status:,
  pr:)` (pure, see A.4). On throw: keep last-known, no UI noise (matches desktop
  — the poll is ambient, not a user action).
- `offerDismissed` loaded once from `configGet()["forgeConnectOfferDismissed"]`.
- Ship: `@Published shipPreview: GitShipPreviewState` (`.idle | .loading |
  .ready(head, base, fileCount, title, body) | .failed(String)`), `shipBusy`,
  `justShipped: Int?` (PR number, cleared after 4 s). `ensureShipPreview(cwd:,
  model:, sessionId:)` fetches once per cwd (not re-fetched while `.ready`;
  re-fetched after `.failed` when the sheet re-opens). `createPullRequest(cwd:)`
  calls `forge:ship`; on `ok` sets `state.pr = pr` immediately (no flicker),
  `justShipped = pr.number`, clears the preview, triggers a refresh. On
  failure sets `.failed(GitCopy.shipError(error))`.
- Merge: `mergeBusy`, `mergeMessage: GitBanner?` (`.ok("Merged #N")` or
  `.error(text)`). `merge(cwd:)` uses `state.pr!.headSha` captured at the moment
  the user confirmed (never re-read after the dialog).

**Mounted view `GitSessionHeaderRow`** (`MantaUI/GitSessionHeaderRow.swift`),
replaces the `subtitleChip` call in `sessionHeaderBlock` (see Mount requests).
Inputs: `branch: String?`, `relPath: String?`, `cwd: String?`, `sessionId:
String`, `shipModel: OpencodeModelID?` (the chat's model **override** only, as
desktop), `tokens`, `onInsertIntoComposer: (String) -> Void`, `readOnly: Bool`.

Renders, in one `HStack` row (nothing at all if there is no branch AND no
offer):
1. **Branch chip** — same look as today's label (`arrow.triangle.branch`,
   `BranchLabel.display`, `· relPath`), plus ` · #N` when a PR exists.
   - `GitPanel.branchState(...) == .none` → plain `Label`, not a button (as today).
   - otherwise → `Button` presenting `GitBranchSheet` (`.sheet`,
     `.presentationDetents([.medium, .large])`). VoiceOver label
     "Pull request #N: title" or "Current branch: name" + hint "Opens git actions".
2. **Checks chip** (Feature B) to the right of the branch chip.
3. Under the row: the **Connect offer** (Feature C) when
   `GitPanel.shouldOfferConnect(...)`.

**`GitBranchSheet`** (`MantaUI/GitBranchSheet.swift`) — `NavigationStack`
inside the sheet (so Review can push). Title = branch name; toolbar "Done".
`.interactiveDismissDisabled(store.shipBusy)` (parity with the desktop's
can't-close-while-creating). `.onAppear`: if no PR, `ensureShipPreview`.

- **Not-shippable states** (`on-base`, `detached`, `unknown`): branch name +
  the desktop line verbatim (see A.1). No buttons.
- **`no-commits`**: "Nothing to ship — no commits ahead of {base}".
- **`ready`**: a `Form`/list section: row "From → To" `{branch} → {base}`
  (base from preview, else poll's base, else "—"), row "Changes" `N file(s)`
  (hidden until preview lands), section "Title" with the drafted title in body
  text (redacted placeholder + footnote "Drafting title…" while loading).
  Primary full-width button **Create pull request** (disabled while title
  loading or busy; busy shows `ProgressView` + "Creating…"). Footnote under the
  button: "Pushes {branch} and opens a pull request into {base}. You can edit
  the title and description on GitHub." Preview/ship failure → red text with
  plain message (`GitCopy.shipError`) and a "Try again" button that re-runs the
  preview.
- **PR state**: header `#N title` (2 lines max), subtitle `state · head →
  base`; optional green banner "Opened #N" when `justShipped`; `LabeledContent`
  rows Reviewers / Unresolved threads / Mergeable (value tinted: blocked reason
  → `tokens.danger`, "mergeable" → `tokens.ok`, "computing…" → `tokens.tx4`).
  When `state.stale`: footnote "Showing last known state — GitHub didn't
  answer." Buttons:
  - **Merge** — enabled iff `GitPanel.canMerge(...).can`; when disabled, the
    reason is shown as a footnote under the button ("Can't merge yet: checks
    failing") — iOS has no hover tooltips, so the reason must be visible text.
    Tap → `confirmationDialog("Merge #N into {base}?", "Merge" destructive-free
    default, "Cancel")` → `store.merge`. Busy: "Merging…". Result: success
    banner "Merged #N" (then poll refresh), failure banner with
    `GitPanel.describeMergeFailure(kind)`.
  - **Review changes** — `NavigationLink` pushing `ReviewScreen(target:
    .cwd(cwd), sessionId: sessionId, prURL: pr.url, onSendToAgent:
    onInsertIntoComposer)` (Feature D).
  - **Open on GitHub** — `openURL(pr.url)`; hidden if `pr.url` is empty.

Deliberate iOS differences (behaviour, not visuals): Merge asks for a
confirmation (a phone tap is easy to misfire); after creating a PR the app does
**not** jump to Safari — it shows "Opened #N" with an **Open on GitHub** button;
blocked-merge reason is visible text; preview/ship error codes are translated
to plain words.

### A.4 Pure logic — `GitForgeModels.swift` (Foundation-only)

Port verbatim from `chatUtils.ts`:

- `enum GitPanel`
  - `branchState(pr:, connected:, branch:) -> .none | .noPR | .pr` (chatUtils.ts:4379)
  - `shipState(branch:, base:, aheadCount:, hasPR:) -> GitShipState` (`.hasPR,
    .detached, .unknown, .onBase, .noCommits, .ready`; :4414)
  - `noShipCopy(_:) -> String?` (SessionHeader.tsx:1284-1288 strings)
  - `canMerge(rollup:, unresolvedThreads:, mergeable:) -> (can: Bool, reason: String?)` (:4331)
  - `describeMergeFailure(_ kind: String?) -> String` (:4358)
  - `mergeableDisplay(pr) -> (text, tone)` (SessionHeader.tsx:1390-1395)
  - `shouldOfferConnect(connected:, forgeKind:, dismissed:)` (:4084)
  - `chipLabel(branch:, prNumber:)` → `"branch"` / `"branch · #N"`
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
  same branch, keep the previous PR/checks/rollup (a rate-limited poll must not
  flip the sheet to "Create pull request").
- `GitShipPreview.title(from:)` → preview title, falling back to head when empty
  (ChatPanel.tsx:1097).

Tests — `MantaUITests/GitForgeTests.swift`:
`testBranchStateNoneWithoutBranchOrConnection`, `testBranchStatePRvsNoPR`,
`testShipStateOrderFirstMatchWins` (all six), `testShipStateUnknownAheadIsReady`,
`testNoShipCopy`, `testCanMergeEveryBlockingReason` (null/false/yellow/red/none/
1 thread/2 threads/ok), `testDescribeMergeFailureKinds`, `testMergeableDisplay`,
`testShipErrorCopy` (each code + both prefixes + passthrough),
`testApplyingKeepsLastPRWhenStaleAndEmpty`, `testApplyingNoForgeClearsKind`,
`testDecodePullRequestResultWithNullMergeable`, `testDecodeUnknownRollupIsNone`,
`testDecodeShipResultFailedAndOK`, `testPreviewTitleFallsBackToHead`.

### A.5 Acceptance

- [ ] With GitHub connected and a feature branch with commits ahead and no PR,
  tapping the branch chip opens a sheet showing `branch → base`, file count and
  a drafted title; **Create pull request** stays disabled until the title arrives.
- [ ] Creating a PR swaps the sheet to the PR view with "Opened #N" in the same
  moment, without waiting for the next poll; the sheet can't be swiped away
  while creating.
- [ ] On the base branch / detached HEAD / unknown base / no commits ahead, the
  sheet shows the matching desktop sentence and no action.
- [ ] Not connected, or a non-git/scratch folder: the branch is a plain label
  (no tap target).
- [ ] With a PR: reviewers, unresolved threads and mergeability are shown;
  Merge is disabled with a visible reason unless checks are green, threads are
  0 and GitHub reports mergeable; Merge asks to confirm and sends the head SHA
  the user saw; both success and each failure kind show a message.
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
  - **Send failures to the agent** — only when the prompt is non-empty AND the
    sheet was opened from a writable chat (`readOnly == false`). Calls
    `onInsertIntoComposer(prompt)`, dismisses the sheet, and the composer now
    shows the text (the visible outcome). Uses C3 `insert(text:mode: .append)`
    — **deliberate difference**: desktop replaces the composer text; on iOS an
    in-progress draft is kept and the prompt appended below it (append into an
    empty composer == desktop's result).
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
- [ ] "Send failures to the agent" appears only when something failed, puts the exact desktop text into the composer without sending, and closes the sheet.
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

### C.2 iOS design

- **`GitConnectOffer`** (in `GitSessionHeaderRow.swift`): a compact info row
  (`tokens.accentBg`-style callout) with the desktop sentence, a **Connect**
  button and an **×** (`accessibilityLabel("Dismiss")`). × hides immediately,
  then `configUpdate(["forgeConnectOfferDismissed": true])`; a failed write
  keeps it hidden for this run (desktop parity) — no error toast for a
  dismissal. Connect presents `GitConnectGitHubSheet`.
- **`GitConnectGitHubSheet`** (`MantaUI/GitConnectGitHubSheet.swift`) —
  `init(onConnected: @escaping () -> Void, onCancel: @escaping () -> Void)`,
  the only device-flow UI on iOS (WS04's Clone from GitHub must use it — see
  Open questions). Driven by `GitDeviceFlowStore` (`@MainActor final class`,
  `MantaUI/GitDeviceFlowStore.swift`) wrapping the pure `GitDeviceFlow` state
  machine. Stages and copy are the desktop's:
  - `.starting`: `ProgressView` "Preparing sign-in…".
  - `.code(grant)`: nav title "Connect GitHub"; subtitle "Waiting for sign-in"
    with the live countdown (`TimelineView(.periodic(from:by: 1))`); step 1
    "Open this link" → **Open github.com/login/device** button (`openURL`) +
    **Copy link**; step 2 "Enter the code" → the code in large monospaced text
    with **Copy code**; note "Code copied to clipboard" after the automatic copy
    (`UIPasteboard.general.string = userCode` once, on entering this stage) and
    after a manual copy. **Cancel** → `forge:device-cancel` (fire, result
    ignored — it is a no-op server-side for unknown grants) then `onCancel`.
  - `.notConfigured`: warning callout "GitHub sign-in isn't configured on this
    server yet." + **Back**.
  - `.expired`: "The sign-in code expired before it was entered." + **Try
    again** (restart) / **Skip for now** (`onCancel`).
  - `.error(msg)`: "Couldn't sign in: {msg}" + **Try again** / **Cancel**.
  - `.connected` → `onConnected()` (caller dismisses and refreshes).
- Polling: one `Task` loop in the store: `sleep(interval)` → poll → feed the
  result into `GitDeviceFlow.reduce`. The app is usually suspended while the
  user is in Safari; when the scene becomes active again the store polls at
  once **only if** at least `interval` seconds have passed since the last poll
  (`GitDeviceFlow.shouldPollNow(lastPoll:now:interval:)`), otherwise it waits
  the remainder — this keeps the "never faster than the interval" invariant.
  When the countdown reaches 0 the store stops polling and shows `.expired`
  (the device code is dead; saves a wasted round trip).
- On connected from the chat: dismiss sheet, `GitForgeStore.refreshNow()` →
  offer disappears, chip becomes tappable.

### C.3 Pure logic — `GitDeviceFlow.swift` (Foundation-only) + tests

```swift
struct GitDeviceFlow: Equatable, Sendable {
  enum Stage: Equatable { case starting, code, notConfigured, expired, error(String), connected }
  var stage: Stage; var grant: GitDeviceGrant?; var interval: Int; var consecutiveErrors: Int; var deadline: Date?
  static let maxConsecutiveErrors = 3; static let minInterval = 5
  mutating func started(_ r: GitDeviceStart, now: Date)
  mutating func startFailed()                       // → .error("Couldn't reach the server. Try again.")
  mutating func polled(_ r: GitDevicePoll)
  mutating func pollThrew()                         // counts toward the budget; 3rd → .error("Couldn't reach the server. Try again.")
  mutating func tick(now: Date)                     // deadline passed → .expired
  static func shouldPollNow(lastPoll: Date, now: Date, interval: Int) -> Bool
  static func countdownLabel(remaining: TimeInterval) -> String   // "m:ss", clamps at 0
  static func displayURL(_ uri: String) -> String                 // strips http(s)://
}
```

Tests — `MantaUITests/GitDeviceFlowTests.swift`:
`testStartAlreadyConnectedIsConnected`, `testStartNotConfigured`,
`testStartGrantSetsCodeIntervalAndDeadline` (interval = max(pollInterval,5)),
`testPendingReReadsIntervalAndResetsErrors`, `testSlowDownLengthensInterval`,
`testPendingIntervalNeverBelowFive`, `testThreeConsecutiveErrorsStop`
(message = server error, or "GitHub sign-in failed." when empty),
`testTransportThrowsCountTowardBudget`, `testDoneConnects`, `testExpired`,
`testTickPastDeadlineExpires`, `testShouldPollNow`, `testCountdownLabel`
(`0:00` floor, `4:05`), `testDisplayURL`.

### C.4 Acceptance

- [ ] In a GitHub-origin chat with no GitHub connection, the offer line appears under the header; × hides it now and it stays hidden after relaunch.
- [ ] Connect shows the code, copies it automatically, opens github.com/login/device in Safari; after authorising and returning, the sheet closes by itself within one poll interval and the branch chip becomes tappable.
- [ ] No poll fires before the first interval; slow-down responses lengthen the gap; 3 errors in a row show "Couldn't sign in: …" with Try again.
- [ ] Expired code, not-configured server and unreachable server each show their own message with a working way out.

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
String?, onSendToAgent: ((String) -> Void)?)`, backed by `ReviewStore`
(`MantaUI/ReviewStore.swift`, `@MainActor final class`). Pushed inside the
branch sheet's `NavigationStack` (Feature A) or the inbox sheet's (Feature E).
`onSendToAgent == nil` → no "Send to agent" anywhere (inbox / standalone).

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
  - Send to agent → `onSendToAgent(text)` (C3 `.append`: joins with a newline
    as desktop), sheet closes, a transient banner "Added to your message — not
    sent yet" confirms (the composer is not visible from here).
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
  isn't in the diff). (Desktop silently loses a RIGHT-side thread on a context
  line because it keys by side; iOS matches `new` and `old` threads against
  `both` rows too.)

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
       // matching: exact side, OR note side new/old vs row side both on same path+line
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
`testPlaceNewThreadOnContextRow`, `testPlaceUnmatchedGoesTopOfFile`,
`testPlaceUnknownFileGoesUnplaced`, `testPendingLabel`,
`testSubmitErrorCopyNothingToSubmit`, `testDecodeDraftWithNullVerdict`,
`testDecodeThreadComments`.

### D.4 Acceptance

- [ ] From a chat with a PR, Review changes shows the PR diff grouped by file with line numbers, existing threads under their lines, and your saved draft comments.
- [ ] Tapping a line lets you write a comment and either put it in the chat message (not sent) or add it to the review; both say what happened; a failed add keeps your text.
- [ ] Replying to a thread posts immediately and the reply appears after refresh; failures show a message.
- [ ] With ≥1 draft comment the bottom bar shows the count, a verdict choice and Submit review; submit success clears the draft; failure keeps it with a message.
- [ ] When the branch moved since the comments were written, the desktop warning appears and nothing is discarded.
- [ ] Opened from the inbox (no session), no "Send to agent" control is shown anywhere.
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
  accessibility "Inbox") → `.sheet` with `InboxWorkScreen` (large detent). See
  Mount requests (WS04).
- **`InboxWorkStore`** (`MantaUI/InboxWorkStore.swift`, `@MainActor final
  class`): `load()` on appear and on pull-to-refresh (no polling); holds
  `items`, `repoPaths: [String: String]`, `phase: .loading | .loaded |
  .notConnected | .failed(String)`, `actionError: String?`, `busyItem: String?`.
- **`InboxWorkScreen`** (`MantaUI/InboxWorkScreen.swift`): `NavigationStack`,
  title "Inbox" with the count in the subtitle; `.searchable(prompt: "Filter
  inbox…")`; states with the desktop copy; for `.notConnected` also a
  **Connect GitHub** button presenting `GitConnectGitHubSheet` (on connected →
  reload). Rows: leading SF Symbol + tint by reason (`xmark.circle.fill` red /
  `eye.circle.fill` amber / `circle` grey — symbol, not colour alone),
  identifier + title (2 lines), secondary line, trailing age (ticks every 60 s).
- **Row actions**: tapping a row shows a `confirmationDialog` titled with the
  identifier + title:
  - **Start a session** — always listed; if the repo has no local checkout the
    action shows the desktop message instead of failing later. Flow: busy row
    spinner → `gitAddWorktree(cwd: path, name: WorkInbox.branchName(item))` →
    hand a `NewSessionDraft` to WS04's create flow (see Contracts consumed) →
    the inbox sheet dismisses and the new chat opens with the seed in the
    composer, unsent. Any failure → `actionError` banner in the sheet with the
    thrown message (git stderr is shown as-is; it's already human-readable).
  - **Open review** — PRs only (not listed for issues — no dead control);
    pushes `ReviewScreen(target: .pr(repoKey:, number:), sessionId: nil, title:
    "!N title", prURL: item.url, onSendToAgent: nil)`.
  - **Delegate in background** — listed when a local checkout exists. The
    parent session is chosen from a second dialog "Run under which session?"
    listing chat sessions (windows with `opencodeSessionId`, from
    `MantaAPIClient.projects()`), sessions whose cwd is inside the repo path
    first. No chat sessions → the action isn't listed. Success → banner
    "Background job started under {session}" and the sheet stays (desktop
    closes; on iOS the banner is the only visible confirmation, then the user
    closes). Failure → the error.
  - **Open on GitHub** — the row's `url` (desktop shows it as the row
    tooltip; on a phone it must be an action to be reachable).
  - Also available as the row's context menu.

### E.3 Pure logic — `InboxWorkModels.swift` (Foundation-only) + tests

`WorkInboxItem` (Decodable, `kind`, `repoKey`, `number`, `title`, `url`,
`state`, `rollup`, `updatedAt` ms, `reason: WorkInboxReason`
(`checksFailing|reviewRequested|assigned|other(String)`), `seed`), and
`enum WorkInbox { sorted(_:) (dedupe+priority+updatedAt desc), filter(_:query:)
(title contains, case-insensitive, or number contains), reasonLabel(_:),
identifier(_:), repoName(_:), secondary(_:), branchName(_:) (exact port of
InboxPalette.tsx:73-80), formatAge(ms:) (chatUtils.ts:542), sessionName(path:
existing:) (deriveProjectName + uniqueSessionName — port from
src/shared/projectName.mjs; if WS04 already ported these, reuse theirs),
forgeIssue(for:) (nil for PRs), parentCandidates(sessions:, repoPath:) }`.

Tests — `MantaUITests/InboxWorkTests.swift`:
`testSortDedupesMoreUrgentReasonWins`, `testSortUpdatedAtDescending`,
`testFilterByTitleAndNumber`, `testReasonLabels`, `testIdentifierBangForPR`,
`testSecondaryHasRepoOnlyForPR`, `testBranchNameSlugAndCap` (punctuation,
40-char cap, empty title), `testFormatAgeBuckets`, `testSessionNameDedup`,
`testForgeIssueOnlyForIssues`, `testParentCandidatesRepoFirst`,
`testDecodeUnknownReasonKept`, `testDecodeNotConnected`.

### E.4 Acceptance

- [ ] The session list has an Inbox button; the inbox shows assigned issues, PRs awaiting my review and my PRs with red checks, most recent first, no duplicates, filterable.
- [ ] Not connected → the desktop message plus a Connect GitHub button that, once signed in, loads the inbox.
- [ ] Start a session creates a worktree + session on the box (issues carry the issue link), opens it, and the composer holds "Complete <url>" unsent.
- [ ] Open review is offered only for PRs and opens the review screen without "Send to agent".
- [ ] Delegate in background asks which session to run under and confirms the job started; with no chat sessions it isn't offered.
- [ ] Every failure (no checkout, worktree error, delegate refused) shows a message.

---

## 7. Files

All new, within WS05's prefixes (no existing file edited by WS05 except via
Mount requests):

| File | Kind | Linux `Package.swift`? |
|---|---|---|
| `MantaUI/MantaAPIClient+Git.swift` | API extension (C1) | no |
| `MantaUI/GitForgeModels.swift` | wire types + `GitPanel`/`GitChecks`/`GitCopy`/`GitForgeState` (Foundation-only) | yes |
| `MantaUI/GitDeviceFlow.swift` | pure device-flow machine (Foundation-only) | yes |
| `MantaUI/GitForgeStore.swift` | `@MainActor` store (poll, ship, merge) | no |
| `MantaUI/GitDeviceFlowStore.swift` | `@MainActor` store driving `GitDeviceFlow` | no |
| `MantaUI/GitSessionHeaderRow.swift` | branch chip + checks chip + connect offer (mounted view) | no |
| `MantaUI/GitBranchSheet.swift` | branch/PR sheet | no |
| `MantaUI/GitChecksSheet.swift` | checks list sheet | no |
| `MantaUI/GitConnectGitHubSheet.swift` | device-code sheet | no |
| `MantaUI/ReviewDiff.swift` | diff parse, anchors, placement (Foundation-only) | yes |
| `MantaUI/ReviewStore.swift` | `@MainActor` review store | no |
| `MantaUI/ReviewScreen.swift` | review screen + `ReviewCommentSheet` + `ReviewReplySheet` | no |
| `MantaUI/InboxWorkModels.swift` | work-inbox types + pure helpers (Foundation-only) | yes |
| `MantaUI/InboxWorkStore.swift` | `@MainActor` inbox store | no |
| `MantaUI/InboxWorkScreen.swift` | inbox sheet | no |
| `MantaUITests/GitForgeTests.swift` | XCTest | yes |
| `MantaUITests/GitDeviceFlowTests.swift` | XCTest | yes |
| `MantaUITests/ReviewDiffTests.swift` | XCTest | yes |
| `MantaUITests/InboxWorkTests.swift` | XCTest | yes |

`project.yml` sources the `MantaUI/` directory, so new files are picked up by
`xcodegen generate` (regenerate and commit `.pbxproj`). Never touch
`InboxModels.swift`.

## 8. Mount requests

1. **WS02 — `ChatScreen.swift` `sessionHeaderBlock` (:1131-1150)**: replace
   `subtitleChip` with
   ```swift
   GitSessionHeaderRow(
       branch: branch, relPath: branchRelPath, cwd: sessionWindow?.cwd,
       sessionId: store.sessionId, shipModel: modelStore.override,
       readOnly: <WS02's background-job read-only flag, false otherwise>,
       tokens: tokens,
       onInsertIntoComposer: { text in /* C3 */ composerController.insert(text: text, mode: .append) }
   )
   ```
   `GitSessionHeaderRow` renders the existing branch label itself when the
   forge is not in play (same font/colour/`BranchLabel.display` as today's
   `subtitleChip`), so the old `subtitleChip` can be deleted. It owns its 5 s
   forge poll via `.task(id: cwd)`; ChatScreen's own branch poll is untouched.
2. **WS04 — `SessionListView.swift` toolbar (:105-129)**: add
   `ToolbarItem(placement: .topBarTrailing)` with an `Image(systemName:
   "tray")` button (accessibility "Inbox") presenting
   `InboxWorkScreen(onStartSession: { draft in <WS04 create flow>(draft) })`
   as a sheet (hang it off the stack's content like the existing `sheetRoute`,
   SessionListView.swift:146-153, or add a `sheetRoute` case `.inbox`).
3. **WS04 — C2 `.review(sessionID:)`**: in the navigator handler, present
   `ReviewScreen.forSession(sessionID)` (a WS05 static factory that resolves
   the session's cwd from `projects()` via `GitSessionLookup.cwd(for:in:)` —
   a small helper in `GitForgeStore.swift` (it uses `MantaProject`, so it is not
   in the Linux package) returning the window's `paneCurrentPath`, else the
   project's `defaultCwd`, exactly as `ChatScreen.resolveWindowAndBranch` does
   (:859-871) — then shows the review with
   `onSendToAgent: nil`). No WS05 flow calls `.review` itself (review is pushed
   locally from the branch sheet / inbox), so this is low priority and may be
   wired last.
4. **`mobile/native/Package.swift`** (unowned, additive): append
   `GitForgeModels.swift`, `GitDeviceFlow.swift`, `ReviewDiff.swift`,
   `InboxWorkModels.swift` to the `MantaUI` target `sources`, and the four test
   files to the `MantaUITests` test target, so `./verify.sh` runs them on
   Linux. They must import Foundation only (no `SessionModels.swift` types —
   the helpers take plain values).

## 9. Contracts provided / consumed

**Consumed**
- **C1**: `call`, `callRequired`, `jsonObject` internal → `MantaAPIClient+Git.swift`.
- **C2**: `MantaNavigator` (`.review` handled per Mount request 3). Inbox
  "Start a session" lands in the new chat through WS04's create flow, not by
  calling `open(.session)` with a seed (C2 carries no seed).
- **C3**: `insert(text:mode:)` with `.append` = "if the composer is non-empty,
  add `\n` + text, else set text" (the desktop's review bridge semantics,
  ChatPanel.tsx:1321). Used by "Send failures to the agent" and review "Send
  to agent". `NewSessionDraft { cwd, text, attachments }` for inbox "Start a
  session", **plus two optional fields WS05 needs** (request to WS03/WS04, see
  Open question 1): `forgeIssue: (repoKey: String, number: Int)?` passed
  through to `tmux:new-session`'s `forgeIssue`, and the guarantee that the
  flow creates a **new chat-mode project** named like the desktop
  (`uniqueSessionName(deriveProjectName(cwd))`) without further prompts, opens
  it, and seeds `text` unsent.
- **C4**: mounts 1 above (branch chip onTap → BranchSheet; checks chip beside it).
- **C5**: none (no new frames).
- **C6**: none. `forgeConnectOfferDismissed` is read/written through the
  existing `config:get`/`config:update` channels, not the settings schema.
- **C7**: four XCTest files above; no server change → no node tests.

**Provided**
- `GitConnectGitHubSheet(onConnected:onCancel:)` — the single iOS GitHub
  device-flow UI, for WS04's Clone from GitHub (and WS10 Extensions/forge if it
  wants a Connect button).
- `ReviewScreen` + `ReviewScreen.forSession(_:)` for C2 `.review`.
- `GitForgeStatus` decode + `MantaAPIClient.forgeStatus()` for WS10's
  forge-connection row if needed (WS10 must not add a second one).

## 10. Deferred

- **Approve without any line comment** — the box refuses to submit a draft with
  zero comments (`draftSubmitForCwd`, forge/index.mjs:1418), and the desktop
  hides the bar at zero. Supporting it is a server change outside parity.
- **Editing a buffered draft comment** (`op:"edit"`) — the desktop has no UI
  for it; parity is add/remove only.
- **Multi-line comment ranges** (`startLine`) — desktop never sends one.
- **Live refresh of the review/inbox from `forge-draft.updated` /
  `forge.inbox.invalidated`** — no client consumes them today; iOS stays
  refetch-driven like the desktop.
- **Choosing the merge method** (squash/rebase) — desktop always sends
  `"merge"`.

## 11. Open questions

1. **Inbox "Start a session" vs `NewSessionDraft`.** C3's draft has no
   `forgeIssue` and no "create without asking" guarantee. *Default:* WS03/WS04
   add `forgeIssue` (optional) to `NewSessionDraft` and make the draft-consuming
   flow create the session immediately (desktop does no prompt); WS05 adds the
   worktree itself before handing the draft over. If WS04 has already shipped
   without it, WS05 adds the field and the pass-through as a reviewed edit in
   WS04's files during wave C (WS04 is not running then).
2. **Who builds the device-flow UI first?** WS04 (wave A) needs it for Clone
   from GitHub; WS05 runs in wave C. *Default:* WS04's implementer builds
   `GitDeviceFlow.swift`, `GitDeviceFlowStore.swift`,
   `GitConnectGitHubSheet.swift` and the device-flow subset of
   `MantaAPIClient+Git.swift` exactly per §4 of this spec in wave A; WS05
   consumes them unchanged and must not create a second device flow.
3. **Send failures: replace vs append.** Desktop replaces the composer text.
   *Default:* append (keeps an in-progress draft; identical when the composer
   is empty). Reviewer may flip it to `.replace` for strict parity.
4. **Delegate parent on iOS.** The desktop uses the active session; the iOS
   inbox opens from the session list. *Default:* a "Run under which session?"
   picker of chat sessions, repo-matching first (§6.2).
