# WS02 — Chat cards, queue, and chat-screen hotspot

Status: draft · Date: 2026-10-28 · Wave: **B** · Master: `00-master.md`

WS02 owns the chat screen hotspot (C4) and the stream decoding (C5). This spec
covers eleven features:

| # | Feature | Verdict |
|---|---|---|
| F1 | Retry card (`retry` frame) | build |
| F2 | Compaction card + "Compacted while you were away" line | build (+ fix: iOS ignores `transcriptStale`) |
| F3 | "Blocked — needs a decision" card | build |
| F4 | Send-error line: **Reconnect** (expired sign-in) / **Reset health** (no endpoint) | Reconnect: build · Reset health: **deferred** (see §Deferred) |
| F5 | Background-job approval card (Start job / Edit access / Not now) | build |
| F6 | Read-only bar for background-job sessions (Go to parent / Stop) | build |
| F7 | Queued-message drain at the next step boundary | **already at parity** — verify only, no code |
| F8 | Remove a queued message; pull the newest one back to edit | remove exists; build "Edit last" |
| F9 | "Seat: …" row in the context sheet | build |
| F10 | C2 `.message` route: open chat, scroll to message, highlight | build |
| F11 | C5 frame decoding for other workstreams | build |

No new server routes. No server edits at all: every channel and frame below
already exists on the box.

---

## 0. Read first (iOS state today)

- `ChatSessionStore` (`mobile/native/MantaUI/ChatSessionStore.swift`) publishes
  stream state at lines 161–247; `applyStreamState()` (556–720) copies the
  per-session snapshot from `MantaEventStore.sessionStates`; `trailingBlocks`
  (932–970) appends the session-error and truncation **notices** into the
  transcript tail (BET-1214 moved them there).
- `MantaStreamRouter.applying` (`MantaEventStore.swift` ~160–276) decodes
  `stream` subs. It does **not** decode `retry`, `compaction`,
  `transcriptStale`, `stepEnded`, `commandExecuted`, `toolBoundary`,
  `aborted`, `optimizer.compacted`. `truncation` is kept as a single
  "latest" value only.
- `MantaEventStore.handleFrame` (~556–575) fans non-stream frames out to
  subjects (`delegateUpdates`, `accountsUpdates`, `handoffUpdates`) and raw
  handlers.
- The pinned stack above the composer is `ChatScreen.bottomCards`
  (`ChatScreen.swift` ~1356–1400): handoff cards, weekly banner, seat-move
  banner, `PendingMessagesCard`.
- The composer is mounted in `loadedLayout` (`ChatScreen.swift` ~517–577)
  with `text: $composerText`, `inputFocused: $composerFocused`.
- Pending (inbox) messages already work on iOS: `PendingMessagesCard.swift`,
  `InboxModels.swift` (`InboxTracker`, `InboxActionReport` 249,
  `PendingCardLogic` 355), store methods `setInboxDelivery` / `cancelInboxItem`
  (`ChatSessionStore.swift` ~1426–1460), busy send `sendOrSteer` →
  `sendWhileRunning` with `delivery: steer|queue` (~1272–1380).

**Ownership note.** `InboxModels.swift` and `PendingMessagesCard.swift` are not
listed in the master ownership table; their only consumers are the chat screen
and store. WS02 claims them (see Open questions, Q1).

---

## F1. Retry card

### Desktop today
- `useSseBus.ts:593–615` stores `retryInfo {attempt, message, next, action?}`
  from the `retry` frame; `null` payload clears it.
- `ChatPanel.tsx:3166–3167` pins `<RetryCard>` in the ambient tier.
- `Cards.tsx:86–129` `RetryCard`: accent-bordered card, `↻` glyph, headline
  `action.title || "Retrying… (attempt N)"`, then `· attempt N` when
  `attempt > 0`, body `action.message || message`, and an "Open"-style link
  button (`action.label || "Open"`) when `action.link` is present.
- No controls; it disappears on its own.

### Wire
- Frame `kind:"stream", sub:"retry"` (`streamInterp.mjs:771–783`), payload
  `{attempt: number, message: string, next?: number /*epoch ms*/}`; cleared by
  `retry` with payload `null` (`clearRetry`, `streamInterp.mjs:308–312`) on the
  next step start / turn edge. `action` is in the TS type
  (`src/shared/types.ts:2932–2937`) but the interpreter never sets it today —
  decode it optionally.

### iOS design
- `MantaStreamModels.swift`: add
  ```swift
  struct StreamRetryAction: Codable, Equatable, Sendable { var title: String?; var message: String?; var label: String?; var link: String? }
  struct StreamRetryPayload: Codable, Equatable, Sendable { var attempt: Double; var message: String; var next: Double?; var action: StreamRetryAction? }
  ```
- `MantaSessionStreamState.retry: StreamRetryPayload?`. Router case `"retry"`:
  `s.retry = try? frame.decodedPayload(StreamRetryPayload.self)` (a JSON
  `null` payload decodes to nil → cleared). Also clear `retry` on a
  `running` frame with `running:false`, on `turnComplete` with
  `complete:true`, and in `applyingRunningSet` for every session absent from
  the set (the box does not replay `retry` on reconnect).
- `ChatSessionStore.retry` published (copied in `applyStreamState`).
- New view `ChatCardRetry` in `ChatCardViews.swift`, mounted in
  `bottomCards` when `store.retry != nil` and not read-only.
  - Row 1: `arrow.clockwise` symbol (accent) + headline + caption.
  - Headline: `action.title` if non-empty, else **"Retrying…"**. Caption:
    "attempt N" when `attempt > 0`. (Desktop prints the attempt twice —
    "Retrying… (attempt 2) · attempt 2"; iOS prints it once. Intentional.)
  - Body: `action.message` if non-empty, else `message`; 3 lines max.
  - When `action.link` is a valid URL: a `Link(action.label ?? "Open", destination:)`.
  - No dismiss control (desktop has none; it clears itself).

### Pure logic
`ChatCardRetryCopy.headline(_:) -> String`, `.caption(_:) -> String?`,
`.body(_:) -> String?`, `.link(_:) -> (label: String, url: URL)?`.

### Acceptance
- A `retry` frame shows the card within one render; the `null` frame removes it.
- After a reconnect whose running set no longer lists the session, the card is gone.
- No control on the card does nothing; the link opens Safari.

---

## F2. Compaction card + "compacted while you were away"

### Desktop today
- `useSseBus.ts:653–671`: `compaction` frames drive
  `compactionState {reason, text, phase: running|done}`:
  `started` → running with `reason ?? "context"`; `delta` → append text;
  `ended` → `done`, cleared 3000 ms later. `transcriptStale` (672–676) clears
  it and refetches the transcript.
- `Cards.tsx:131–171` `CompactionCard`: `✻` (pulsing while running),
  "Compacting…" / "Compacted", `· <reason>`; body = streamed text (3 lines,
  mono) while running, the first non-empty line once done.
- Background compaction notice: `useSseBus.ts:756–764` handles
  `sub:"optimizer.compacted"` → `compactionNotice {beforeTokens, afterTokens,
  away}`, shown 10 s. `ChatPanel.tsx:3170–3180` renders one line:
  `"⟳ Compacted while you were away"` when `away`, else
  `"⟳ Compacted in the background"`, plus `" · 128k → 31k"` from
  `formatCompactionSaving` (`chatUtils.ts:305–310`, built on `formatTokens`
  219–223) when the saving is non-zero.

### Wire
- `sub:"compaction"` (`streamInterp.mjs:973–985`):
  `{phase:"started", text:"", reason?: string}` · `{phase:"delta", text}` ·
  `{phase:"ended"}`.
- `sub:"transcriptStale"` payload `{}` (`streamInterp.mjs:738`, `986–990`,
  `1021`) — the transcript changed wholesale; refetch.
- `sub:"optimizer.compacted"` (`src/server/index.mjs:1925–1937`), payload
  `{beforeTokens: number|null, afterTokens: number|null, away: boolean}`.

### iOS gap found
iOS does not decode `transcriptStale` at all. After a manual or automatic
compaction the canonical refetch only happens if a `turnComplete` edge
happens to land after the rewrite. Fix it here.

### iOS design
- `MantaStreamModels.swift`: `StreamCompactionPayload {phase: String, text: String?, reason: String?}`,
  `StreamOptimizerCompactedPayload {beforeTokens: Double?, afterTokens: Double?, away: Bool?}`.
- `MantaSessionStreamState` adds:
  - `compaction: ChatCardCompactionState?` folded by the pure reducer below;
  - `transcriptStaleSeq: Int` (bumped per `transcriptStale` frame);
  - `compactionNotice: StreamOptimizerCompactedPayload?` and
    `compactionNoticeSeq: Int` (bumped per `optimizer.compacted`).
  Counters, not the `lastStreamFrame` stamp: the store's comment at
  `ChatSessionStore.swift` ~330 explains why a stamp can be overwritten
  before the deferred sink runs.
- `ChatSessionStore`:
  - `@Published private(set) var compaction: ChatCardCompactionState?`
  - `@Published private(set) var compactionNotice: ChatCardCompactionNotice?`
  - In `applyStreamState`: when `transcriptStaleSeq` advanced → set
    `compaction = nil` and `scheduleRefetch()`. When `compaction.phase` is
    `.done` → start (or restart) a 3 s `Task` that clears it (cancel the task on
    a new `started`). When `compactionNoticeSeq` advanced → set the notice,
    start a 10 s clear `Task`. Both tasks are cancelled in `stop()`.
  - First snapshot rule: like `lastRunning`, seed the last-seen seqs on the
    first snapshot without acting, so opening a chat does not refetch or show a
    stale notice.
- Views (`ChatCardViews.swift`):
  - `ChatCardCompaction`: `sparkle` symbol (pulsing with
    `.symbolEffect(.pulse)` while running), "Compacting…" / "Compacted",
    caption `reason`; body as desktop (running: text, 3 lines, monospaced;
    done: first non-empty line).
  - `ChatCardCompactionNotice`: one quiet line, the exact desktop copy.
- `ChatSessionStore.compact()` keeps its "Compacted — context freed" /
  failure hints (`ChatSessionStore.swift` ~1604–1626); they confirm the
  request, the card shows the work.

### Pure logic
- `ChatCardCompactionState { reason: String; text: String; phase: .running|.done }`
  and `ChatCardCompactionReducer.apply(_ payload: StreamCompactionPayload, to: ChatCardCompactionState?) -> ChatCardCompactionState?`
  (delta/ended with no prior state → unchanged nil, as desktop).
- `ChatCardCompactionState.firstLine`.
- `ChatCardCompactionNotice.text(before:after:away:) -> String` and
  `ChatCardTokens.desktopCompact(_ n: Double) -> String` — a port of
  `formatTokens` without the " tokens" suffix (`<1000` → whole number,
  `<100k` → one decimal with trailing `.0` dropped + "k", else rounded "k").
  Do not reuse `UsageMeters.formatTokens`: its rounding differs from desktop.

### Acceptance
- started → delta → ended shows "Compacting…" with growing text, then
  "Compacted" + first line, gone ≤ 3.5 s later.
- A `transcriptStale` frame triggers exactly one transcript refetch and removes
  the card.
- `optimizer.compacted {away:true, 128000, 31000}` shows
  "⟳ Compacted while you were away · 128k → 31k" for 10 s; `{away:false,null,null}`
  shows "⟳ Compacted in the background".
- Opening a chat never refetches or shows a notice because of an old seq.

---

## F3. "Blocked — needs a decision" card

### Desktop today
- `ChatPanel.tsx:2648–2678`: `liveProgress` from `progress:get` on mount and
  on every `progress.updated` bus event for this session.
- `ChatPanel.tsx:3150–3159`: when `liveProgress.state === "blocked"`, a card
  in the **blocking** tier: `Cards.tsx:713–729` `BlockedProgressCard` — warn
  card, warn dot, title **"Blocked — needs a decision"**, body = `detail`
  rendered as markdown. Not dismissible; it clears when the model reports a
  different state.

### Wire
- RPC `progress:get` (`src/server/rpc.mjs:2466–2467`), arg `sessionID` →
  `ProgressRecord | null` (`src/shared/types.ts:2537–2545`:
  `{sessionID, label, step, total, state, detail, updatedAt}`).
  iOS already has `MantaAPIClient.progressGet(sessionID:)`
  (`MantaAPIClient.swift:30–33`) and `MantaProgress` (`SessionModels.swift:284`).
- Bus frame `kind:"progress.updated"`, payload `{sessionID}`
  (`src/server/progress.mjs:155`, `198`). `MantaStreamFrame.parse` lifts
  `payload.sessionID` into `frame.sessionId`.

### iOS design
- `MantaEventStore`: new `let progressUpdates = PassthroughSubject<String, Never>()`;
  in `handleFrame`, `if frame.kind == "progress.updated", let sid = frame.sessionId { progressUpdates.send(sid) }`
  (raw handlers still receive the frame — `SessionListStore` relies on that).
- `ChatSessionStore`: `@Published private(set) var progress: MantaProgress?`;
  `func refreshProgress()` on `start()` (first run), on `progressUpdates`
  filtered to `sessionId`, and on reconnect (`handleConnection`). Failure: keep
  the last value, `NSLog` it (progress is ambient; no user banner, same as
  desktop). Skip for read-only stores.
  `var blockedProgress: MantaProgress? { progress?.state == "blocked" ? progress : nil }`.
- View `ChatCardBlocked`: warn-tinted card (`tokens.warn` border/tint), dot +
  "Blocked — needs a decision" (semibold), body =
  `Text(ChatCardMarkdown.inline(detail))` where `inline` builds an
  `AttributedString(markdown:options:.inlineOnlyPreservingWhitespace)` and
  falls back to the plain string on parse failure. No controls.
- Mounted first in `bottomCards` (blocking tier).

### Acceptance
- `progress_report state:"blocked"` from an agent shows the card within one
  `progress.updated` round-trip; a later `working`/`done` hides it.
- Inline `code` renders monospaced.

---

## F4. Send-error line: Reconnect / Reset health

### Desktop today
- `useSseBus.ts:628–637`: `sessionError` → `describeSessionError`
  (`chatUtils.ts:800–826`). If `authErrorAdvice` (`1817–1853`) matches —
  error name `ProviderAuthError`, or `ApiError` with a credential-shaped
  message (regex at 1850), checked against `rawMessage ?? message` — and the
  session's provider has a label in `AUTH_PROVIDER_LABELS` (`1777–1781`:
  `anthropic→Claude`, `openai→Codex`, `kimi-for-coding→Kimi`), the banner text
  is **"<Label> needs to be reconnected."** and `authReconnect = label`.
  Otherwise the text gets a typed prefix (`Context full — try /compact: …`,
  `Response truncated (hit output limit)`, `Structured output failed: …`,
  `API error: …`).
- `ChatPanel.tsx:3182–3207` renders `⚠ <sendError>` with **Reconnect** (when
  `authReconnect`), **Reset health** (when the verdict below matches) and ×.
- Reconnect calls `openAuthReconnect` (`useSseBus.ts:386–392`), which
  dispatches a `manta-open-subscriptions` window event. **Nothing in
  `src/renderer` listens to it** (grep) — on desktop the button only clears the
  banner. iOS must do better: it opens Accounts.
- Reset health: only set by the Auto-routing verdict
  `routing:choose → {kind:"no-healthy-endpoint"}` (`ChatPanel.tsx:1837–1849`,
  server `rpc.mjs:1627–1646`); the button calls `accounts:retry {providerID}`
  per affected provider (`ChatPanel.tsx:740–756`).

### Wire
- `sub:"sessionError"` payload `{name: string|null, message: string, rawMessage?: string}`
  (`streamInterp.mjs:751–757`, type `types.ts` StreamSessionErrorPayload).
- No RPC for Reconnect: it is navigation to the Accounts screen (WS08,
  `AccountsScreen(store:focusProvider:ownsLifecycle:)`, `AccountsScreen.swift:92`).

### iOS design
- `StreamSessionErrorPayload` gains `var rawMessage: String?`.
- Pure `ChatCardSendError.describe(name:message:rawMessage:providerID:) -> ChatCardSendErrorDescription { text: String; reconnect: (label: String, accountsProvider: String)? }`
  — a line-for-line port of `describeSessionError` + `authErrorAdvice` +
  `isAuthErrorName` (same regex, case-insensitive). `accountsProvider` maps the
  opencode provider to the Accounts provider id: `anthropic→claude`,
  `openai→codex`, `kimi-for-coding→kimi` (the ids `AccountsSelectors.ordered`
  matches on; an unknown focus is harmless).
- `ChatSessionStore`:
  - stores `sessionErrorDismissed: StreamSessionErrorPayload?`; `func dismissSessionError()` records the current payload; the published
    `sessionError` is nil while it equals the dismissed one (a new error, or
    the next turn, shows again).
  - `trailingBlocks` uses `ChatCardSendError.describe(...).text` for the
    transcript notice (typed prefixes now match desktop), and **omits** the
    notice when `reconnect != nil` — that error is shown pinned instead (one
    copy, actionable). `trailingBlocks` gains a parameter
    `sessionErrorText: String?` replacing its use of `sessionError.message`;
    update `ChatTranscriptTests`/existing callers accordingly.
  - The provider id is passed in by the screen (it owns `modelStore`):
    `store.sessionErrorProviderID = activeProviderID` on change, where
    `activeProviderID = ChatModel.activeModel(modelStore.models, override:…, configuration:…, provider:…)?.providerID ?? modelStore.override?.providerID`.
- View `ChatCardSendErrorLine` (pinned in `bottomCards` only for the
  reconnect case): danger-tinted row, `exclamationmark.triangle.fill`, text,
  **Reconnect** button, × (accessibility "Dismiss error").
  - Reconnect → `reconnectTarget = ReconnectTarget(provider:)`; ChatScreen
    presents `.sheet(item: $reconnectTarget) { NavigationStack { AccountsScreen(store: accountsStore, focusProvider: $0.provider, ownsLifecycle: false).toolbar { Done } } }`
    and calls `store.dismissSessionError()`. The Accounts screen is the place
    the user re-signs (WS08).
- **Reset health: deferred** (see §Deferred).

### Acceptance
- A `sessionError {name:"ProviderAuthError"}` on an `anthropic` session shows
  "Claude needs to be reconnected." pinned with Reconnect; no duplicate notice in
  the transcript; Reconnect opens Accounts with Claude first.
- `ApiError` "rate limit exceeded" is NOT treated as auth (plain notice,
  "API error: …").
- × hides the line until the next distinct error.

---

## F5. Background-job approval card

### Desktop today
- `ChatPanel.tsx:946–968`: while the panel is active and trust mode is off,
  poll `delegate:pending-approvals(sessionId)` every 3 s; show the first. If
  the parent's pending permissions' `always[]` already cover every requested
  tool (`isApprovalCoveredByAlways`, `chatUtils.ts:2261–2280`, `globCovers`
  2245–2254) it approves silently.
- `PanelCards.tsx:585–707` `DelegateApprovalCard`: header bot icon +
  **"Background job approval"** + `· <name>` + × (Not now); prompt (2 lines);
  **"Will be allowed to:"**; one chip per tool `permission: pattern` (or
  **"No tools declared."**); in edit mode each row becomes two text fields
  (permission, pattern) + remove, plus **"+ Add rule"** (adds `bash`, empty
  pattern); footnote **"Anything not listed is denied (the job will not ask
  again)."**; buttons **Start job** (primary), **Edit access** / **Done
  editing**, **Not now**.
- `ChatPanel.tsx:3133–3147`: approve/decline are fire-and-forget with an empty
  catch (a root-AGENTS.md violation on desktop; iOS reports outcomes).

### Wire
- `delegate:pending-approvals` (`rpc.mjs:2473–2474`), arg `sessionId` →
  `DelegateApproval[]` (desktop also tolerates `{approvals: []}`,
  `httpApi.ts:1310–1313`). `DelegateApproval` = `{id, parentSessionID, name,
  prompt, tools:[{permission, pattern, action?}], createdAt}`
  (`types.ts:2623–2635`).
- `delegate:approve` (`rpc.mjs:2475–2478`), arg `{id, tools?}` → `{ok: boolean}`.
  `ok:false` = no such pending approval (expired after 2 min —
  `APPROVAL_TIMEOUT_MS`, `delegate.mjs:125`, `2485–2501` — or already
  resolved). Server uses edited tools only when non-empty (`delegate.mjs:4783–4787`).
- `delegate:decline` (`rpc.mjs:2479–2480`), arg `id` → `{ok: boolean}`.
- Bus frame `kind:"delegate.approval.requested"`, payload = the approval
  (`delegate.mjs:4782`). Not session-enveloped; filter on
  `payload.parentSessionID`.
- Trust mode: the server never creates an approval when trust is on
  (`delegate.mjs:4769–4775`), so iOS needs no trust check.

### iOS design
- `MantaAPIClient+ChatCards.swift` (new, C1):
  ```swift
  func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval]   // accepts bare array or {approvals:[]}
  func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> Bool  // returns `ok`
  func delegateDecline(id: String) async throws -> Bool
  ```
  Wire types `ChatCardApproval`, `ChatCardApprovalTool {permission, pattern, action?}`
  in `ChatCardModels.swift`.
- `MantaEventStore`: `let delegateApprovalRequests = PassthroughSubject<ChatCardApproval, Never>()`,
  fed in `handleFrame` when `frame.kind == "delegate.approval.requested"` and
  the payload decodes.
- New store `ChatCardApprovalStore` (`@MainActor final class`, in
  `ChatCardApprovalStore.swift`) owned by ChatScreen (`@StateObject`), not
  created for read-only sessions:
  - `@Published private(set) var pending: ChatCardApproval?`, `busy: Bool`,
    `error: String?`.
  - Refresh on screen appear, on app foreground (ChatScreen already observes
    scene phase), on reconnect, on a `delegateApprovalRequests` value for this
    session, and every 3 s while the screen is visible **and** `store.running`
    (approvals only arise mid-turn). Fetch errors keep the current card and are
    logged (ambient, like desktop).
  - Auto-approve when `ChatCardApprovalLogic.isCoveredByAlways(approval, permissions: store.permissions)`.
  - `approve(tools:)` / `decline()`: set `busy`, call RPC, then
    `ok:true` → `pending = nil`, `store.actionHint = "Background job approved"` /
    `"Background job declined"`; `ok:false` → `pending = nil`,
    `actionHint = "That request had already expired — the agent was told no"`;
    thrown error → keep the card, `error = "Couldn't reach your box — try again"`.
- View `ChatCardApprovalCard` (`ChatCardViews.swift`): native card with the
  desktop copy above. Edit mode: a `ForEach` of rows with two `TextField`s
  (monospaced, no autocorrect/autocapitalisation) and a trash button; "Add
  rule" appends `{bash, ""}`. **Start job** is disabled (with the footnote
  "Fill in or remove empty rules") while any row has an empty permission or
  pattern — desktop would send them; iOS refuses garbage rules. Local edit
  state resets when `approval.id` changes. Buttons disabled while `busy`.
  Mounted first in `bottomCards` (blocking tier, before F3).

### Pure logic
`ChatCardApprovalLogic.globCovers(_:_:)`, `.isCoveredByAlways(_:permissions:)`
(ports), `.canStart(tools:) -> Bool`, `.outcomeHint(ok:approved:) -> String`,
`ChatCardApprovalsDecoding.decode(_ data:)` (both shapes).

### Acceptance
- With trust off, a `delegate` call with tools shows the card on the phone
  within 3 s (or immediately on the bus frame).
- Start job with edits sends the edited list; the job starts with that access.
- Not now (× or button) declines; the agent's `delegate` returns declined.
- Approving after the 2-minute timeout says it had expired; never silent.
- No card at all in trust mode.

---

## F6. Read-only bar for background-job sessions

### Desktop today
- `ChatPanel.tsx:360–373`: the session is a job when the jobs map has a record
  keyed by this session as `childSessionID`, and `isReadOnlyJob`
  (`chatUtils.ts:1869–1873`) — every job except a CTO work worker
  (`correlation.kind === "work"`).
- `ChatPanel.tsx:3509–3550` replaces the composer with `ReadOnlyJobBar`
  (`PanelCards.tsx:715–774`); blocking cards and management panels are not
  mounted (`viewOnly`, `ChatPanel.tsx:780`).
- Bar copy: **"Read-only — this is a background job running <model>."** (or
  **"Read-only — this is a background job."** when the model is unknown),
  **"It reports to <parent name>."** when the parent window is found. Second
  line: running → `activity || "running…"`; terminal → `formatJobSummary`
  (`chatUtils.ts:1901–1911`: `"<branch> · N files changed"` or
  `"N file(s) changed"`) + `" · <error ?? status>"` for failed/stopped.
  Buttons: **Go to parent**, **Stop** (only while running).
- Model name: `parseModelRef(job.model)` (`chatUtils.ts:1892`) → catalog name.

### Wire
- `delegate:list` (`rpc.mjs:2434–2435`), no arg → all jobs (`DelegateJob`,
  `types.ts:2557–…`; relevant fields `id, parentSessionID, childSessionID,
  status, model, branch, worktree, activity, error, filesChanged,
  correlation{kind}`).
- `delegate:stop` (`rpc.mjs:2437`), arg `id` → `{ok, error?}`; iOS already has
  `delegateStop(id:)` which throws on refusal (`MantaAPIClient.swift` ~211–222).
- `tmux:list` via `api.projects()` (`MantaAPIClient.swift:192`) to resolve the
  parent's window (`opencodeSessionId == parentSessionID`).
- Freshness: `delegate.updated` → `eventStore.delegateUpdates` (exists).

### iOS design
- iOS's `DelegateJob` (`SessionModels.swift:88`, WS04) lacks `model`,
  `worktree`, `error`, `filesChanged`, `correlation`. Do NOT edit it: decode a
  WS02 type `ChatCardJob` (`ChatCardModels.swift`) with exactly those fields
  plus `id, parentSessionID, childSessionID, status, branch, activity`, all
  lenient (`decodeIfPresent`), list decoded per element like
  `LenientDelegateJobs` (skip a bad record).
  `MantaAPIClient+ChatCards.swift`: `func chatCardJobs() async throws -> [ChatCardJob]`.
- `ChatCardJobOwnershipStore` (`@MainActor final class`, own file) owned by
  ChatScreen: `@Published private(set) var job: ChatCardJob?` (only when
  read-only per `ChatCardJobLogic.isReadOnly`), `parent: SessionOpenTarget?`,
  `parentName: String?`, `stopping: Bool`. Loads on appear; refreshes on
  `delegateUpdates`. A failed load leaves the screen writable (desktop
  behaviour when the job map is empty) and logs.
- ChatScreen when `jobOwnership.job != nil`:
  - Replace `ComposerView` with `ChatCardReadOnlyJobBar` in the same overlay
    slot (it must report its height through the same `onGeometryChange` that
    feeds `bottomBarHeight`).
  - `.environment(\.transcriptCardActions, nil)` → permission/question cards
    render inert (the read-only path already supported by
    `TranscriptRow.swift:233–241`).
  - Do not mount F5's approval store or F4's pending line; `bottomCards`
    shows only retry/compaction/notice/blocked.
  - Context sheet: hide Compact / Clear / Hand off (`ContextSheet` gains
    `allowsActions: Bool = true`).
  - Overflow sheet: see Mount requests (M3). Until applied, hide the overflow
    nav-bar button for read-only job sessions.
- Bar content per desktop copy; model name via `ChatCardJobLogic.parseModelRef`
  then `modelStore.models.first { providerID/id match }?.name`.
- **Stop** (shown when `ChatCardJobLogic.isStoppable(status)` — running or
  paused, matching `stopJob`): confirm with the existing
  `confirmActionSheet` pattern ("Stop this job?" / "The job stops and its
  window stays open.") → `api.delegateStop` → success: `actionHint = "Job stopped"`
  and refresh; failure: `actionHint = "Couldn't stop the job: <reason>"`.
- **Go to parent**: when `parent` resolved → navigate (see Q2): use
  `MantaNavigator.open(.session(windowKey:))` with WS04's key for that window;
  if WS04 provides no way to build the key from `(project, windowIndex)`,
  reset `path` and append the parent `SessionOpenTarget`. When the parent window
  is not found the button is not rendered and the line reads
  "It reports to a session that's closed."

### Pure logic
`ChatCardJobLogic.isReadOnly(_:)`, `.job(forSession:in:)`,
`.parseModelRef(_:)`, `.summary(_:)` (formatJobSummary port incl. 0-file and
no-worktree cases), `.headline(modelName:)`, `.statusLine(_:)`,
`.isStoppable(_:)`.

### Acceptance
- Opening a job's session from Background jobs shows the bar, not the
  composer; permission cards in it are inert.
- A CTO work worker opens writable.
- Stop asks first, then reports success or the box's reason.
- After the job finishes (delegate.updated), the bar switches to the summary
  and Stop disappears.

---

## F7. Queued-message drain at the next step boundary — already at parity

The brief names `maybeDrainQueuedPrompt` / `shouldAbortForQueuedDrain` /
drain-abort. **Those no longer exist on desktop** (grep of `src/renderer`:
zero hits). Desktop now uses OpenCode V2's native inbox: a send while running
goes to the box with `delivery:"steer"` (joins the turn at its next step) or
`"queue"` (after the turn) — `inboxState.ts:115–140` `planBusySend`,
`PendingMessagesCard.tsx`. The box interprets `session.inbox.*` into the
`inbox` frame (`streamInterp.mjs:20–31`, 517–528).

iOS already does exactly this: `ComposerView` calls `store.sendOrSteer(...,
delivery:)` (`ComposerView.swift:1412`), which posts
`opencode:prompt {messageID, delivery}` while running
(`ChatSessionStore.swift` ~1302–1380), and shows the box's pending list
(`PendingMessagesCard`). `toolBoundary` / `aborted` need no iOS decoding (no
consumer; an interrupt is not an error on iOS by design, `streamInterp.mjs:761–764`).

**Work:** none beyond F8. Acceptance: a message sent mid-turn with "Now"
reaches the agent at its next tool step without interrupting the turn (manual
check on the simulator against the box).

---

## F8. Remove a queued message; pull the newest one back to edit

### Desktop today
- × on a row: `cancelInboxItem(item, restore:false)` (`ChatPanel.tsx:858–906`).
  iOS has this (`PendingMessagesCard` × → `store.cancelInboxItem`).
- **↑ edit last** (card header button, and ↑ on an empty composer):
  `editLastInboxItem` (`ChatPanel.tsx:918–923`) picks the newest item not busy
  and cancels it with `restore:true`. `describeInboxCancel`
  (`inboxState.ts:216–…`): only `cancelled` restores text (into the composer,
  focused, caret at end); with attachments it also shows
  **"Attachments weren't restored — re-attach them"**; `delivered` →
  "Already sent to the agent"; anything else → error
  "Couldn't confirm it was cancelled — it may still be sent".

### Wire
`opencode:inbox-cancel` `{sessionId, id}` → `{outcome, item?}` — iOS
`api.inboxCancel` + `InboxCancelResult` (`InboxModels.swift:201`) exist.

### iOS design
- `PendingMessagesCard`: header becomes an `HStack` with the existing header
  text and a trailing **"Edit last"** button (`arrow.up` + text,
  accessibility id `pending-edit-last`), disabled when no non-busy item
  exists; new closure `onEditLast: () -> Void`.
- `ChatSessionStore.editLastInboxItem() async -> String?`: picks via
  `ChatCardEditLast.pick(items:busy:)`; runs the same cancel call as
  `cancelInboxItem` (shared private helper, same busy handling); returns the
  text to restore only for `cancelled`; sets `actionHint` for every other
  outcome via `ChatCardEditLast.report(result:item:)`
  (attachments-lost notice / already sent / unconfirmed / connection failure).
- ChatScreen wires `onEditLast` → `Task { if let t = await store.editLastInboxItem() { composerText = t; composerFocused = true } }`.
  If the composer already holds text, the restored text **replaces** it only
  after a confirmation ("Replace your draft with the pending message?") —
  desktop overwrites silently; on a phone the draft is harder to retype.
  Alternatively, use WS03's C3 `insert(text:mode:.replace)` if the composer
  controller is reachable; the binding is equivalent.
- The ↑-key gesture is not ported (keyboard shortcuts are out of scope).

### Acceptance
- Edit last on a two-item list removes the newer item and puts its text in the
  composer, focused.
- `delivered` / `unknown` never restore text and always say why.
- Attachment-bearing item restores text and says attachments were not restored.

---

## F9. "Seat: …" row in the context sheet

### Desktop today
`SessionHeader.tsx:641–643`, `792–800`: the context popover shows
`describeSeatLine` (`chatUtils.ts:3812–3822`): **"Seat: <account>"** for a
single-seat account, **"Seat: <account> · <seat>"** otherwise; absent when the
conversation has no seat.

### Data
Already on iOS: `accountsStore.conversationSeat` (`ConversationSeat`,
`AccountsModels.swift:745–763`) with `displayName` implementing the same rule.
`AccountsStore` is created by ChatScreen (`ChatScreen.swift:321`). WS09 does
not need to provide anything; this consumes WS08's existing model read-only.

### iOS design
- `ContextSheet` (`UsageSheets.swift:63`) gains `var seatLine: String? = nil`;
  rendered as a secondary `Text` row in the first section under the header
  (accessibility id `ctx-seat-line`), single line, truncating.
- ChatScreen passes `ChatCardSeatLine.text(accountsStore.conversationSeat)`
  → `"Seat: \(displayName)"` or nil (also nil when `displayName` is empty).

### Acceptance
Multi-seat Claude conversation shows "Seat: Work · Seat 2"; no seat → no row.

---

## F10. C2 `.message` route (scroll to + highlight)

### Constraint discovered
The pinned MessagingUI revision (`project.yml:19–28`, rev `1ec611ad`) has **no
scroll-to-item API**: `TiledScrollPosition` exposes only `scrollTo(edge:)`
(`Sources/MessagingUI/Tiled/TiledScrollPosition.swift:95`). Transcript blocks
carry no message id either.

### Design: window the transcript so the target is the first row, then scroll to top
1. **Receiving the route.** ChatScreen observes `MantaNavigator.pending`
   (C2, WS04 provides the `@EnvironmentObject`). For
   `.message(sessionID, messageID)` with `sessionID == store.sessionId`, it
   consumes the route (`pending = nil`) and calls `store.focus(messageID:)`.
   For another session: the route is WS04's to open (Mount request M2); the
   newly pushed ChatScreen consumes it on appear.
2. **Finding the message** — `ChatSessionStore.focus(messageID:)`:
   - If `messages` (the raw window, `ChatSessionStore.swift:178`) lacks it and
     `hasEarlier`, widen `messageLimit` by `earlierMessageStep` and refetch,
     repeating up to `ChatCardMessageFocus.maxSearchMessages` (500). Not found
     → `actionHint = "Couldn't find that message — it may have been compacted away"`.
   - Found at index `i` of `n` → set `messageLimit = n - i` and refetch, so the
     target message is the oldest one loaded (`hasEarlier` stays true; "Load
     earlier" keeps working).
   - Compute `focusedRowID` with `ChatCardMessageFocus.rowID(messageID:messages:voiceNotes:widgets:rows:)`:
     map the target message alone through
     `ChatTranscriptMapper.blocks(from:[msg], voiceNotes:, widgets:)`, take the
     first block's `stableScrollID`, return the first row in `rows` whose id is
     that id (or that id + `#dup…`). Publish `@Published private(set) var focusedRowID: String?`
     and bump `@Published private(set) var focusSeq: Int`.
3. **Scrolling.** On `focusSeq` change ChatScreen sets
   `scrollPosition.autoScrollsToBottomOnAppend = false`,
   `scrollPosition.scrollsToBottomOnReplace = false`, then
   `scrollPosition.scrollTo(edge: .top, animated: true)` on the next run loop
   (after the rows apply). A pinned chip "Showing an earlier message · Jump to
   latest" appears in `bottomCards`.
4. **Leaving focus.** "Jump to latest", the existing scroll-to-bottom button,
   or a send → `store.clearFocus()` (restores `messageLimit` to
   `initialMessageLimit`, refetches, clears `focusedRowID`), and ChatScreen
   restores both auto-scroll flags and scrolls to bottom. The highlight alone
   fades after 2.5 s (focus window stays).
5. **Highlight.** `focusedRowID` is published to cells through a new
   environment key `\.transcriptHighlightedRowID` declared in
   `ChatCardMessageFocus.swift`; the cell draws it (Mount request M1).

Risk: TiledView's diff for a head-trim could fall back to `.replace`; that is
why `scrollsToBottomOnReplace` is turned off for the duration. Verify on the
simulator (acceptance below).

### Pure logic
`ChatCardMessageFocus.locate(messageID:in:) -> Int?`, `.windowLimit(index:count:) -> Int`,
`.rowID(...)`, `.shouldWiden(found:hasEarlier:loaded:)`.

### Acceptance
- `navigator.open(.message(sid, mid))` for a message 120 messages back opens
  the chat with that message at the top, highlighted, and streaming does not
  yank the view down.
- Jump to latest returns to the normal tail-follow behaviour.
- An unknown id says so; it never leaves the screen blank.

---

## F11. C5 — frames decoded for other workstreams

All decoded in `MantaStreamModels.swift` + `MantaStreamRouter.applying`,
stored on `MantaSessionStreamState`, copied in `applyStreamState`, published on
`ChatSessionStore` (read-only `private(set)`). Per-message maps are bounded to
the newest **200** entries (pure `ChatCardBoundedLog` keeps insertion order and
evicts oldest) because stream state lives for the app's lifetime.

| Frame (`sub`) | Server source | Payload | `ChatSessionStore` property (contract) |
|---|---|---|---|
| `retry` | `streamInterp.mjs:771–783` | `{attempt, message, next?, action?}` or `null` | `retry: StreamRetryPayload?` |
| `compaction` | `:973–985` | `{phase, text?, reason?}` | `compaction: ChatCardCompactionState?` |
| `transcriptStale` | `:738, 986–990` | `{}` | (internal: refetch) |
| `optimizer.compacted` | `index.mjs:1925–1937` | `{beforeTokens, afterTokens, away}` | `compactionNotice: ChatCardCompactionNotice?` |
| `truncation` | `:885–893` | `{kind, label, messageID?}` | `truncation` (unchanged) **and** `truncationByMessageID: [String: StreamTruncationPayload]` |
| `commandExecuted` | `:1038–1040` | `{messageID, name, arguments}` | `commandByMessageID: [String: StreamCommandExecutedPayload]` |
| `stepEnded` | `:874–883` | `{messageID, tokens:{input,output,reasoning,cache:{read,write}}, cost?, finish?}` | `lastStepEnded: StreamStepEndedPayload?` **and** `stepEndedByMessageID: [String: StreamStepEndedPayload]` (last step per message wins) |

New Codable types (all `Equatable, Sendable`):
`StreamCommandExecutedPayload {messageID: String, name: String, arguments: String}`,
`StreamStepTokens {input, output, reasoning: Double; cache: StreamStepCache {read, write: Double}}`,
`StreamStepEndedPayload {messageID: String, tokens: StreamStepTokens, cost: Double?, finish: String?}`.

Not decoded on purpose: `toolBoundary`, `aborted`, `messageChanged`,
`childSession`, `attention` (no iOS consumer in this effort).

Equality cost: these maps make `MantaSessionStreamState` comparisons larger;
`removeDuplicates()` still short-circuits on the first differing field. Keep
the maps out of any per-frame hot path besides the router.

---

## Files

**Edit (owned):**
- `MantaUI/MantaStreamModels.swift` — F1, F2, F4 (`rawMessage`), F11 types.
- `MantaUI/MantaEventStore.swift` — router cases, state fields,
  `applyingRunningSet` retry clear, subjects `progressUpdates`,
  `delegateApprovalRequests`.
- `MantaUI/ChatSessionStore.swift` — published properties (F1, F2, F3, F4,
  F10, F11), timers, `trailingBlocks` text param, `editLastInboxItem`,
  `focus(messageID:)`/`clearFocus()`, `refreshProgress()`,
  `dismissSessionError()`.
- `MantaUI/ChatScreen.swift` — `bottomCards` mounts, read-only job branch,
  reconnect sheet, navigator observation, scroll handling, context-sheet args.
- `MantaUI/UsageSheets.swift` — `ContextSheet.seatLine`, `allowsActions`.
- `MantaUI/PendingMessagesCard.swift`, `MantaUI/InboxModels.swift` — Edit last
  (pending Q1 confirmation of ownership).

**Create:**
- `MantaUI/MantaAPIClient+ChatCards.swift` — approvals, job list.
- `MantaUI/ChatCardModels.swift` — `ChatCardApproval*`, `ChatCardJob`,
  `ChatCardCompactionState`, `ChatCardCompactionNotice`, `ChatCardBoundedLog`.
- `MantaUI/ChatCardLogic.swift` — all pure enums listed per feature
  (`ChatCardRetryCopy`, `ChatCardCompactionReducer`, `ChatCardTokens`,
  `ChatCardSendError`, `ChatCardApprovalLogic`, `ChatCardJobLogic`,
  `ChatCardEditLast`, `ChatCardSeatLine`, `ChatCardMarkdown`).
- `MantaUI/ChatCardViews.swift` — `ChatCardRetry`, `ChatCardCompaction`,
  `ChatCardCompactionNotice`, `ChatCardBlocked`, `ChatCardSendErrorLine`,
  `ChatCardApprovalCard`, `ChatCardReadOnlyJobBar`, `ChatCardFocusChip`.
- `MantaUI/ChatCardApprovalStore.swift`, `MantaUI/ChatCardJobOwnershipStore.swift`.
- `MantaUI/ChatCardMessageFocus.swift` — locator + environment key.
- `MantaUITests/ChatCardsTests.swift`.
- `project.yml` needs no change (the `MantaUI` folder entry picks up new
  files); regenerate `.pbxproj` on the Mac per `mobile/native/AGENTS.md` §3.

## Tests (`MantaUITests/ChatCardsTests.swift`)

Router (through `MantaStreamRouter.applying` with hand-built frames):
1. `retry` payload decodes; `null` payload clears; `running:false` clears;
   `applyingRunningSet` without the session clears.
2. Compaction started→delta→ended folds to running text then `.done`;
   delta with no prior state stays nil.
3. `transcriptStale` and `optimizer.compacted` bump their seqs once per frame.
4. `truncation` with messageID lands in the map and in `truncation`;
   without messageID only in `truncation`.
5. `commandExecuted` and `stepEnded` maps; second `stepEnded` for the same
   message replaces; `lastStepEnded` tracks the newest.
6. `ChatCardBoundedLog` evicts the oldest past 200.

Copy / logic:
7. `ChatCardRetryCopy`: title override, attempt 0 → no caption, empty
   action.message falls back, invalid link → nil.
8. `ChatCardTokens.desktopCompact`: 999, 1000→"1k", 12_340→"12.3k",
   128_000→"128k"; `ChatCardCompactionNotice.text` for away/background,
   saving zero, after ≥ before, nils.
9. `ChatCardSendError.describe`: ProviderAuthError+anthropic → Claude/claude;
   ApiError "invalid api key"+openai → Codex/codex; ApiError "rate limit window
   expired" → not auth, "API error: …"; ProviderAuthError + unknown provider →
   no reconnect; rawMessage used for classification; ContextOverflowError,
   MessageOutputLengthError, StructuredOutputError prefixes.
10. `ChatCardApprovalLogic`: globCovers exact / `*` / prefix-star / mismatch;
    isCoveredByAlways empty tools → false, all covered → true, one uncovered →
    false; `canStart` rejects empty fields; approvals decoding both shapes.
11. `ChatCardJobLogic`: work worker not read-only; job lookup by
    childSessionID; parseModelRef (`a/b/c` → `a`,`b/c`; `/x`, `x/`, "" → nil);
    summary 0/1/2 files, with/without worktree; status line for failed with
    and without error; isStoppable running/paused only.
12. `ChatCardEditLast.pick`: newest non-busy; all busy → nil; `report` for
    cancelled (with/without attachments), delivered, unknown.
13. `ChatCardSeatLine`: nil seat, empty name, normal.
14. `ChatCardMessageFocus`: locate, windowLimit, rowID with a `#dup` suffix,
    widen decision at the 500 cap.
15. `ChatSessionStore.trailingBlocks` (existing tests updated): auth error
    omitted, other errors carry the typed text.

Checks before reporting done: `ios-mantaui` `action: test-unit` on the branch
(app + both bundles compile, `MantaUITests` green); `npm run typecheck` and
`npm test` stay green (no TS change expected).

## Mount requests

- **M1 → WS01 (`TranscriptRow.swift`)**, applied by the WS02 implementer in
  wave B (WS01 has landed): in `TranscriptCellReveal` add
  `@Environment(\.transcriptHighlightedRowID) private var highlightedRowID`
  and, on `cellContent`, `.background(item.id == highlightedRowID ? tokens.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: Metrics.radius.md))`
  with `.animation(.easeOut, value: highlightedRowID)`. ChatScreen sets the
  environment on `transcript`. Nothing else in WS01 files changes.
- **M2 → WS04 (C2 root handler in `MantaNavigation.swift` / `RootView.swift`)**:
  when `.message(sessionID, _)` is opened and no chat screen for `sessionID`
  is on top, open that session exactly as `.session` would, **without**
  clearing `pending`; the opened `ChatScreen` consumes it on appear. Also: a
  way to build `.session(windowKey:)` from `(project, windowIndex)` (used by F6
  Go to parent).
- **M3 → WS07 (`ChatOverflowSheet.swift`)**: add
  `var isReadOnlyJob: Bool = false`; when true hide Compact, Clear, Fork,
  Delete and the trust toggle. ChatScreen passes it.
- C4 mounts other workstreams request in ChatScreen (WS05 branch/checks chip,
  WS06 search button) are applied by their owners in later waves per the
  master; WS02 keeps the nav-bar trailing `HStack` and the branch chip `onTap`
  closure stable so they can attach.

## Contracts provided / consumed

- **C1 provided:** `MantaAPIClient+ChatCards.swift` (`delegatePendingApprovals`,
  `delegateApprove`, `delegateDecline`, `chatCardJobs`).
- **C2:** implements `.message` inside the chat screen; consumes `.session`
  (WS04) for Go to parent; requests M2.
- **C3 consumed (optional):** `insert(text:mode:.replace)` for Edit last; the
  `composerText` binding is the fallback.
- **C4 owner:** ChatScreen / ChatSessionStore / MantaEventStore /
  MantaStreamModels; accepts the master's allowed mounts.
- **C5 provided:** the property table in F11 — names are the contract
  (`retry`, `compaction`, `compactionNotice`, `truncation`,
  `truncationByMessageID`, `commandByMessageID`, `lastStepEnded`,
  `stepEndedByMessageID`).
- **C7:** `MantaUITests/ChatCardsTests.swift`; no node tests (no server change).
- Consumes WS08 `AccountsStore.conversationSeat`, `AccountsScreen`; WS04
  `MantaProgress`, `SessionOpenTarget`; existing `BackgroundJobsStore` untouched.

## Deferred

- **Reset health (F4).** The only producer of the "no healthy endpoint"
  verdict is the desktop's Auto-routing call `routing:choose`
  (`ChatPanel.tsx:1837–1849`; server `rpc.mjs:1627–1646`). iOS never calls
  `routing:choose` (grep: zero hits) and the Auto-routing indicator is out of
  scope, so an iOS send can never receive that verdict — a Reset health button
  would never appear. Revisit when iOS adopts Auto routing; the action is then
  `accounts:retry {providerID}` per provider (`rpc.mjs:1718–…`).
- **↑ on an empty composer to edit the last pending message** — keyboard
  shortcut; out of scope by the master.
- **Approval expiry countdown** — desktop has none.
- **Desktop finding (not WS02 work):** desktop's Reconnect button dispatches
  `manta-open-subscriptions`, which nothing listens to, and its approval
  approve/decline/stop calls swallow errors. Report to the desktop owner.

## Open questions

- **Q1 — ownership of `InboxModels.swift` and `PendingMessagesCard.swift`.**
  Unlisted in the master table. Default: WS02 owns both (sole consumers are the
  chat screen and store).
- **Q2 — Go to parent navigation shape.** Default: `MantaNavigator.open(.session(windowKey:))`
  via WS04's key builder (M2); fallback: reset `path` and push the parent's
  `SessionOpenTarget` (the back button then returns to the session list, not to
  the job).
- **Q3 — Edit last overwriting a non-empty draft.** Default: ask first
  ("Replace your draft with the pending message?"); desktop overwrites silently.
