# WS02 — Chat cards, queue, and chat-screen hotspot

Status: revised (round 1) · Date: 2026-10-28 · Wave: **B** · Master: `00-master.md`

WS02 owns the chat screen hotspot (C4), stream decoding (C5), and — per D1 —
`InboxModels.swift`, `PendingMessagesCard.swift`, `HandoffStore.swift`. It
also applies, in wave B, every ChatScreen / ChatSessionStore / MantaEventStore /
MantaStreamModels mount other workstreams request (D18; see "Mounts applied by
this workstream").

| # | Feature | Verdict |
|---|---|---|
| F1 | Retry card (`retry` frame) | build |
| F2 | Compaction card + "Compacted while you were away" line | build (+ fix: iOS ignores `transcriptStale`) |
| F3 | "Blocked — needs a decision" card | build |
| F4 | Send-error line: **Reconnect** (expired sign-in) / **Reset health** | Reconnect: build · Reset health: **deferred** (D8) |
| F5 | Background-job approval card (Start job / Edit access / Not now) | build |
| F6 | Read-only bar for background-job sessions (Go to parent / Stop) | build |
| F7 | Queued-message drain at the next step boundary | **already at parity** — verify only |
| F8 | Remove a queued message; pull the newest one back to edit | remove exists; build "Edit last" |
| F9 | Seat row in the context sheet (D17) | build |
| F10 | C2 `.message` route: open chat, show the message, highlight | build |
| F11 | C5 frame decoding (`commandExecuted` per D15) | build |

No server edits and no new server routes.

---

## 0. Read first (iOS state today)

- `ChatSessionStore` (`MantaUI/ChatSessionStore.swift`) publishes stream state
  (161–247); `applyStreamState()` (556–720) copies the per-session snapshot
  from `MantaEventStore.sessionStates`; `trailingBlocks` (932–970) appends the
  session-error and truncation notices to the transcript tail (BET-1214).
  `isReadOnly` is an immutable `let` set at construction (261, 383–389) and
  guards inbox mutations (1430, 1447). The transcript is mapped in three places
  (`fetchTranscript` ~1065, `refreshVoiceNotes` ~1111, `refreshWidgets` ~1137).
  `fetchTranscript` returns immediately while another fetch is in flight
  (998–1001, sets `fetchPending`).
- `MantaStreamRouter.applying` (`MantaEventStore.swift` ~160–276) decodes
  `stream` subs; it does NOT decode `retry`, `compaction`, `transcriptStale`,
  `commandExecuted`, `optimizer.compacted`. Per-session state
  (`MantaSessionStreamState`, 64–107) persists for the app's lifetime.
- `MantaEventStore.handleFrame` (~556–575) fans non-stream frames to subjects
  (`delegateUpdates`, `accountsUpdates`, `handoffUpdates`) and raw handlers.
- Pinned stack above the composer: `ChatScreen.bottomCards` (~1356–1400).
  Composer overlay: `loadedLayout` (~517–577). Blocking-card arrival scrolls to
  bottom (`ChatScreen.swift:424–429`).
- Composer: after D13, WS03 has replaced `@State composerText` with
  `@StateObject composer: ComposerTextController` in wave A. WS02 uses
  `composer.insert(text:mode:) -> Bool` (C3); no legacy-binding fallback.
- Pending (inbox) messages already work: `PendingMessagesCard.swift`,
  `InboxModels.swift` (`InboxActionReport` 249, `PendingCardLogic` 355), store
  `setInboxDelivery` / `cancelInboxItem` (1426–1460), busy send
  `sendOrSteer` → `sendWhileRunning` with `delivery: steer|queue` (1272–1380).
- Linux inner loop (D19): `mobile/native/Package.swift` compiles only
  Foundation files (`MantaStreamModels.swift`, `InboxModels.swift`,
  `AccountsModels.swift`, `PendingPrompt.swift`, … are in it;
  `MantaEventStore.swift` (Combine) and `ChatModels.swift` are not). WS02's
  pure logic therefore lives in Foundation-only files (see Files).

---

## F1. Retry card

### Desktop today
- `useSseBus.ts:593–615` stores `retryInfo {attempt, message, next, action?}`;
  a `null` payload clears it. `ChatPanel.tsx:3166–3167` pins `<RetryCard>`.
- `Cards.tsx:86–129`: `↻`, headline `action.title || "Retrying… (attempt N)"`
  then `· attempt N` when `attempt > 0`; body `action.message || message`;
  link button (`action.label || "Open"`) when `action.link`. No controls.

### Wire
`kind:"stream", sub:"retry"` (`streamInterp.mjs:771–783`):
`{attempt: number, message: string, next?: number}`; cleared by a `retry`
frame with payload `null` (`clearRetry`, 308–312). `action` exists in the TS
type (`types.ts:2932–2937`) but is never set by the interpreter — decode it
optionally.

### iOS design
- `MantaStreamModels.swift`: `StreamRetryAction {title, message, label, link: String?}`,
  `StreamRetryPayload {attempt: Double; message: String; next: Double?; action: StreamRetryAction?}`.
- `MantaSessionStreamState.retry: StreamRetryPayload?`. Router `"retry"`:
  `s.retry = try? frame.decodedPayload(...)` (JSON `null` → nil). Also cleared
  by `ChatCardStreamRules.clearsRetry(sub:running:complete:)` on `running`
  `false` and `turnComplete` `complete:true`, and in `applyingRunningSet` for
  sessions absent from the set (the box does not replay `retry`).
- `ChatSessionStore.retry` (published, copied in `applyStreamState`).
- View `ChatCardRetry` (`ChatCardViews.swift`) in `bottomCards` when non-nil:
  `arrow.clockwise` + headline + caption; body ≤ 3 lines; `Link` when the
  action link is a valid URL. Headline = `action.title` if non-empty else
  **"Retrying…"**; caption "attempt N" when `attempt > 0` (desktop prints the
  attempt twice; iOS once — intentional).

### Pure logic (`ChatCardLogic.swift`)
`ChatCardRetryCopy.headline/caption/body/link`, `ChatCardStreamRules.clearsRetry`.

### Acceptance
- A `retry` frame shows the card; the `null` frame removes it; a reconnect whose
  running set omits the session removes it. The link opens Safari.

---

## F2. Compaction card + "compacted while you were away"

### Desktop today
- `useSseBus.ts:653–671`: `started` → running (`reason ?? "context"`),
  `delta` appends, `ended` → done, cleared after 3000 ms; `transcriptStale`
  (672–676) clears and refetches.
- `Cards.tsx:131–171`: `✻` (pulsing while running), "Compacting…" /
  "Compacted", `· <reason>`; body = streamed text (3 lines, mono) while
  running, first non-empty line when done.
- `useSseBus.ts:756–764` + `ChatPanel.tsx:3170–3180`: `optimizer.compacted` →
  10 s line `"⟳ Compacted while you were away"` (away) or
  `"⟳ Compacted in the background"`, plus `" · 128k → 31k"` from
  `formatCompactionSaving` (`chatUtils.ts:305–310`, `formatTokens` 219–223).

### Wire
- `sub:"compaction"` (`streamInterp.mjs:973–985`):
  `{phase:"started", text:"", reason?}` · `{phase:"delta", text}` · `{phase:"ended"}`.
- `sub:"transcriptStale"` `{}` (`:738`, `:986–990`, `:1021`).
- `sub:"optimizer.compacted"` (`index.mjs:1925–1937`):
  `{beforeTokens: number|null, afterTokens: number|null, away: boolean}`.

### iOS gap
iOS never decodes `transcriptStale`; after a compaction the refetch only
happens if a `turnComplete` edge lands later. Fixed here.

### Lifetime model (resolves review #3)
State that persists in the event store must never be "cleared" by a timer in
the chat store, or the next snapshot resurrects it. So:

- **Router (event store, persistent):**
  - `compactionGeneration: Int` — incremented on every `started`.
  - `compaction: ChatCardCompactionState?` where
    `ChatCardCompactionState { generation: Int; reason: String; text: String; phase: .running | .done }`,
    folded by `ChatCardCompactionReducer.apply(_:to:generation:)`:
    `started` → new state with the new generation; `delta` appends (no prior
    state → stays nil); `ended` → `.done` (no prior → nil).
  - `transcriptStale` → `compaction = nil` **in the router** and
    `transcriptStaleSeq += 1`.
  - `optimizer.compacted` → `compactionNotice` payload and
    `compactionNoticeSeq += 1`.
- **Chat store (visibility, consumed once):** a pure latch
  `ChatCardExpiryLatch` (in `ChatCardLogic.swift`) used twice — once keyed by
  compaction generation, once by notice seq:
  ```swift
  struct ChatCardExpiryLatch: Equatable, Sendable {
      private(set) var expiredThrough: Int      // keys ≤ this are never shown again
      private(set) var scheduled: Int?          // key whose expiry timer is running
      init(seed: Int)                           // first snapshot: seed with the current key
      /// Returns whether `key` is visible, and a key to start an expiry timer for (at most once per key).
      mutating func observe(key: Int, expiring: Bool) -> (visible: Bool, schedule: Int?)
      mutating func expire(_ key: Int)          // expiredThrough = max(expiredThrough, key); clears `scheduled` if equal
  }
  ```
  - Compaction: `observe(key: generation, expiring: phase == .done)`. A timer
    (3 s) is started only when `schedule` is non-nil — i.e. on the first
    snapshot where that generation is `.done` — never per snapshot. When it
    fires it calls `expire(generation)`; the published `compaction` becomes
    nil and later snapshots carrying the same generation stay hidden. A new
    `started` has a higher generation, so an old timer can only expire the old
    one.
  - Notice: `observe(key: compactionNoticeSeq, expiring: true)`, 10 s timer.
  - Seeding: on the first snapshot after `start()`, both latches are created
    with `seed` = the current generation/seq **if** that compaction is already
    `.done` (or for any existing notice), so opening a chat never shows a stale
    card; a compaction still `.running` at open is shown.
  - `transcriptStaleSeq` advance (vs. last seen, seeded the same way) →
    `scheduleRefetch()` once.
  - Timer `Task`s are cancelled in `stop()`.
- Published: `compaction: ChatCardCompactionState?`,
  `compactionNotice: ChatCardCompactionNotice?` (`{text: String}` built by
  `ChatCardCompactionNotice.text(before:after:away:)`).
- Views: `ChatCardCompaction` (`sparkle`, `.symbolEffect(.pulse)` while
  running; copy as desktop), `ChatCardCompactionNotice` (one quiet line).
- `ChatSessionStore.compact()` keeps its existing request hints.

### Pure logic
`ChatCardCompactionReducer`, `ChatCardCompactionState.firstLine`,
`ChatCardExpiryLatch`, `ChatCardCompactionNotice.text`, and
`ChatCardTokens.desktopCompact(_:)` (port of `formatTokens` minus " tokens":
`<1000` whole; `<100k` one decimal, trailing `.0` dropped, "k"; else rounded
"k"). Not `UsageMeters.formatTokens` (different rounding).

### Acceptance
- started → delta → ended shows growing text, then "Compacted" + first line,
  gone ≤ 3.5 s later, and does not come back on later frames.
- A `transcriptStale` frame triggers exactly one refetch and the card is gone
  for good.
- `optimizer.compacted {away:true, 128000, 31000}` → "⟳ Compacted while you
  were away · 128k → 31k" for 10 s; `{away:false, null, null}` →
  "⟳ Compacted in the background".
- Opening a chat with an old compaction/notice in the event store shows neither.

---

## F3. "Blocked — needs a decision" card

### Desktop today
`ChatPanel.tsx:2648–2678` loads `progress:get` on mount and on each
`progress.updated` for the session; `ChatPanel.tsx:3150–3159` pins
`BlockedProgressCard` (`Cards.tsx:713–729`) in the blocking tier when
`state === "blocked"`: warn card, dot, **"Blocked — needs a decision"**,
markdown `detail`. Not dismissible.

### Wire
`progress:get` (`rpc.mjs:2466–2467`) → `ProgressRecord | null`
(`types.ts:2537–2545`). iOS has `api.progressGet(sessionID:)`
(`MantaAPIClient.swift:30–33`) and `MantaProgress` (`SessionModels.swift:284`).
Bus `kind:"progress.updated"`, payload `{sessionID}` (`progress.mjs:155`, `198`).

### iOS design
- `MantaEventStore`: `let progressUpdates = PassthroughSubject<String, Never>()`,
  sent in `handleFrame` for `progress.updated` with a session id (raw handlers
  still get the frame — `SessionListStore` relies on that).
- `ChatSessionStore`: `@Published private(set) var progress: MantaProgress?`;
  `refreshProgress()` on first `start()`, on `progressUpdates` for this
  session, on reconnect. Failure keeps the last value and logs (ambient, as
  desktop). Skipped when `isReadOnly`.
  `blockedProgress` = `progress` when `ChatCardProgressRule.isBlocked(state:)`.
- View `ChatCardBlocked`: warn-tinted card, dot + title, body
  `Text(ChatCardMarkdown.inline(detail))` (`AttributedString(markdown:,
  options: .inlineOnlyPreservingWhitespace)`, plain-text fallback). No controls.
  First in `bottomCards`, after F5's card.

### Acceptance
A `blocked` progress report shows the card within one `progress.updated`
round-trip; a later state hides it; inline `code` renders monospaced.

---

## F4. Send-error line: Reconnect / Reset health

### Desktop today
- `useSseBus.ts:628–637` → `describeSessionError` (`chatUtils.ts:800–826`) /
  `authErrorAdvice` (1817–1853): `ProviderAuthError`, or `ApiError` whose
  `rawMessage ?? message` matches the credential regex (1850), for a provider
  in `AUTH_PROVIDER_LABELS` (1777–1781: anthropic→Claude, openai→Codex,
  kimi-for-coding→Kimi) → **"<Label> needs to be reconnected."** + Reconnect.
  Otherwise typed prefixes (`Context full — try /compact: …`,
  `Response truncated (hit output limit)`, `Structured output failed: …`,
  `API error: …`).
- `ChatPanel.tsx:3182–3207` renders the line with Reconnect / Reset health / ×.
  Desktop Reconnect dispatches `manta-open-subscriptions`, which nothing listens
  to (D10 — renderer-only bug, reported, not fixed here).

### Wire
`sub:"sessionError"` `{name: string|null, message: string, rawMessage?: string}`
(`streamInterp.mjs:751–757`). No error id exists (resolves review #7 below).
Reconnect is navigation to WS08's `AccountsScreen(store:focusProvider:ownsLifecycle:)`.

### iOS design
- `StreamSessionErrorPayload` gains `rawMessage: String?`.
- Router: `sessionErrorSeq: Int` bumped on every `sessionError` frame
  (identical payloads are distinct occurrences).
- `ChatCardSendError.describe(name:message:rawMessage:providerID:) -> ChatCardSendErrorDescription {text; reconnect: (label, accountsProvider)?}`
  — port of `describeSessionError` + `authErrorAdvice` + `isAuthErrorName`
  (same regex, case-insensitive); `accountsProvider` maps
  anthropic→`claude`, openai→`codex`, kimi-for-coding→`kimi` (the ids
  `AccountsSelectors.ordered` matches).
- `ChatSessionStore`:
  - `dismissedSessionErrorSeq: Int?`; `dismissSessionError()` records the
    current `sessionErrorSeq`. The published `sessionError` is nil while
    `sessionErrorSeq == dismissedSessionErrorSeq`; a new frame (even an
    identical payload) has a higher seq and shows; a `running:true` edge resets
    the dismissal (the router already clears the error on a new turn,
    `MantaEventStore.swift` `running` case).
  - `sessionErrorProviderID: String?` set by ChatScreen from
    `ChatModel.activeModel(modelStore.models, override:…, configuration:…, provider:…)?.providerID ?? modelStore.override?.providerID`.
  - `trailingBlocks` takes `sessionErrorText: String?` (from `describe(...).text`)
    instead of reading `sessionError.message`, and gets `nil` when `reconnect`
    is non-nil — that error is shown pinned (one copy, actionable). Existing
    `trailingBlocks` tests updated.
- View `ChatCardSendErrorLine` (pinned, reconnect case only): danger-tinted,
  text, **Reconnect**, × ("Dismiss error"). Reconnect →
  `reconnectTarget = ReconnectTarget(provider:)`; ChatScreen presents
  `.sheet(item:) { NavigationStack { AccountsScreen(store: accountsStore, focusProvider: $0.provider, ownsLifecycle: false).toolbar { Done } } }`
  and calls `dismissSessionError()`.
- **Reset health: deferred** (D8).

### Acceptance
- `ProviderAuthError` on an anthropic session → pinned "Claude needs to be
  reconnected." with Reconnect, no duplicate transcript notice; Reconnect opens
  Accounts with Claude first.
- `ApiError` "rate limit window expired" → plain notice "API error: …".
- × hides the line; a second identical error frame shows it again.

---

## F5. Background-job approval card

### Desktop today
- `ChatPanel.tsx:946–968`: poll `delegate:pending-approvals(sessionId)` every
  3 s while active (trust off); show the first. It also auto-approves when the
  parent's pending permissions' `always[]` cover every tool
  (`isApprovalCoveredByAlways`, `chatUtils.ts:2261–2280`). **That is a desktop
  bug:** `PermissionRequest.always` on a *pending* ask is what *would* be
  saved if approved (`opencodeV2.mjs:470–490`; pending list maintained by
  `streamInterp.mjs:957–971`), not a grant. iOS does NOT port it (D10:
  renderer-only, reported).
- `PanelCards.tsx:585–707` `DelegateApprovalCard`: bot icon,
  **"Background job approval"** `· <name>`, × (Not now); prompt (2 lines);
  **"Will be allowed to:"**; chips `permission: pattern` or
  **"No tools declared."**; edit mode = two text fields + remove per row,
  **"+ Add rule"** (`bash`, empty pattern); footnote **"Anything not listed is
  denied (the job will not ask again)."**; **Start job**, **Edit access** /
  **Done editing**, **Not now**. Approve/decline swallow errors (D10, reported).

### Wire
- `delegate:pending-approvals` (`rpc.mjs:2473–2474`) arg `sessionId` →
  `DelegateApproval[]` (desktop also tolerates `{approvals: []}`,
  `httpApi.ts:1310–1313`); `DelegateApproval = {id, parentSessionID, name,
  prompt, tools:[{permission, pattern, action?}], createdAt}` (`types.ts:2623–2635`).
- `delegate:approve` (`rpc.mjs:2475–2478`) `{id, tools?}` → `{ok}`;
  `delegate:decline` (`2479–2480`) `id` → `{ok}`. `ok:false` only means the
  entry is no longer pending (`delegate.mjs:2501–2505`) — expired (2 min,
  `:125`) **or already resolved elsewhere**.
- **Empty edited list is NOT deny-all:** the server uses edited tools only when
  non-empty, otherwise the original request (`delegate.mjs:4783–4787`).
- Bus `kind:"delegate.approval.requested"`, payload = approval (`:4782`), not
  session-enveloped. Trust on → no approval is ever created (`:4769–4775`).

### iOS design
- Client members in `MantaAPIClient+ChatCards.swift` (see "Client members");
  the store depends on a protocol `ChatCardApprovalAPI` (the three approval
  methods) so it is testable with a fake; `MantaAPIClient` conforms there.
- `MantaEventStore`: `let delegateApprovalRequests = PassthroughSubject<ChatCardApproval, Never>()`
  fed from `handleFrame`.
- `ChatCardApprovalStore` (`@MainActor final class`, own file), owned by
  ChatScreen, only when the session's mutation policy is `.allowed` (F6):
  - `@Published private(set) var pending: ChatCardApproval?`, `busy`, `error`.
  - Refresh on appear, foreground, reconnect, a matching
    `delegateApprovalRequests` value, and every 3 s while visible **and**
    `store.running`. Fetch errors keep the current card and log.
  - **No auto-approval of any kind** (resolves review #2).
  - `resolvedIDs: Set<String>` — an id decided locally (either outcome) is
    tombstoned; every fetch result drops tombstoned ids, so an in-flight poll
    that returns after a local decision cannot restore the card.
  - `approve(tools:)` / `decline()`: guarded by
    `ChatCardApprovalLogic.canStart(tools:)` for approve; `busy` while in flight;
    `ok:true` → tombstone, `pending = nil`, hint "Background job approved" /
    "Background job declined"; `ok:false` → tombstone, `pending = nil`, hint
    **"That request is no longer pending"**, then refresh; thrown error → keep
    the card, `error = "Couldn't reach your box — try again"`.
- View `ChatCardApprovalCard`: desktop copy; edit mode rows with two
  `TextField`s (monospaced, no autocorrect/autocapitalisation) and a trash
  button; "Add rule" appends `{bash, ""}`. **Start job** disabled when
  `canStart` is false, with one footnote:
  - list empty → **"A job needs at least one rule. To give it no access, tap
    Not now."** (resolves review #1);
  - any empty field → **"Fill in or remove empty rules."**
  Edit state resets when `approval.id` changes. First in `bottomCards`.

### Pure logic
`ChatCardApprovalLogic.canStart(tools:)` (non-empty AND every field
non-blank), `.footnote(tools:)`, `.outcomeHint(ok:approved:)`,
`.filterResolved(_:resolved:)`; `ChatCardApprovalsDecoding.decode(_:)`
(both shapes).

### Acceptance
- Trust off: a `delegate` call with tools shows the card within 3 s (or on the
  bus frame). Edited access is what the job starts with.
- Removing every rule disables Start with the explanation; no approve RPC is sent.
- A pending parent permission whose patterns match never approves anything.
- Approving on the desktop first → the phone's Start says "That request is no
  longer pending"; a poll finishing after a local approve does not bring the
  card back. No card in trust mode.

---

## F6. Read-only bar for background-job sessions

### Desktop today
- `ChatPanel.tsx:360–373`: a job session = jobs map has this session as
  `childSessionID` and `isReadOnlyJob` (`chatUtils.ts:1869–1873`: everything
  except `correlation.kind === "work"`).
- `ChatPanel.tsx:3509–3550` replaces the composer with `ReadOnlyJobBar`
  (`PanelCards.tsx:715–774`); blocking cards/panels hidden (`viewOnly`, 780).
- Copy: **"Read-only — this is a background job running <model>."** /
  **"Read-only — this is a background job."**; **"It reports to <parent>."**;
  second line running → `activity || "running…"`, terminal →
  `formatJobSummary` (`chatUtils.ts:1901–1911`) + `" · <error ?? status>"` for
  failed/stopped. **Go to parent**, **Stop** (running only).

### Wire
`delegate:list` no arg → all jobs (`rpc.mjs:2434–2435`; fields `id,
parentSessionID, childSessionID, status, model, branch, worktree, activity,
error, filesChanged, correlation{kind}`); `delegate:stop` (`:2437`) via the
existing `api.delegateStop(id:)` (throws on refusal); `api.projects()` to find
the parent window; freshness via `eventStore.delegateUpdates`.

### Ownership states (resolves review #8)
`enum ChatCardMutationPolicy: Equatable, Sendable { case resolving, allowed, readOnlyJob }`
(in `ChatCardModels.swift`).

- `ChatSessionStore` gains `@Published private(set) var mutationPolicy: ChatCardMutationPolicy`
  (initial `.resolving`; read-only subagent stores never leave it and stay
  read-only through `isReadOnly` as today), `func applyMutationPolicy(_:)`,
  `var canMutate: Bool { !isReadOnly && mutationPolicy == .allowed }` and
  `var isBackgroundJobReadOnly: Bool { mutationPolicy == .readOnlyJob }`.
  **Canonical read-only API (master ledger):** other workstreams read ONLY
  `store.isBackgroundJobReadOnly` (read-only job yes/no) and, where a
  "still checking" state matters, `store.mutationPolicy` (`.resolving`,
  `.allowed`, `.readOnlyJob`). `jobOwnership.job` is WS02-internal (bar content).
- **Every mutation entry point guards on it**, not only composer visibility:
  `send`, `sendOrSteer`, `sendWhileRunning`, `retry(promptID:)`,
  `setInboxDelivery`, `cancelInboxItem`, `editLastInboxItem`,
  `replyPermission`, `replyQuestion`, `rejectQuestion`, `keepPlanning`,
  `compact`, `abort`. Behaviour per policy:
  - `.resolving`: `send`/`sendOrSteer` put the prompt in the durable outbox as
    `.waiting` (exactly as when a turn runs) and do not deliver;
    `drainPendingPromptIfIdle` also requires `.allowed`. Other mutations are
    refused with hint "One moment — checking this session". Blocking cards
    render inert (`transcriptCardActions` nil). The composer stays usable, so
    the degraded-mode promise (typing while the box is unreachable) holds.
  - `.allowed`: today's behaviour; held `.waiting` prompts drain.
  - `.readOnlyJob`: the composer is replaced by the bar; any held `.waiting`
    prompt becomes `.failed` with reason "This is a background job — it can't
    take messages"; every other mutation is refused (and no control for it is
    rendered, so the refusal is never user-visible).
- `ChatCardJobOwnershipStore` (`@MainActor final class`, own file, owned by
  ChatScreen) resolves the policy with the pure
  `ChatCardOwnershipResolver.next(current:result:sessionID:)`:
  - success with a read-only record for this `childSessionID` → `.readOnlyJob`
    (the record itself is published as the ownership store's `job`);
  - success with none (or a `work` record) → `.allowed`;
  - **any failure, of any error class → keep the current state** (a known job
    stays read-only; `.resolving` stays resolving). Only a successful list can
    release held prompts. Rationale: `MantaAPIClient` maps every non-empty RPC
    `error` string to `MantaError.server` (`MantaAPIClient.swift:923–929`), and
    `delegate:list` is a live read (`rpc.mjs:2434–2435`) that can fail
    transiently on a box that does have jobs. No unsupported-box exception is
    needed: iOS already calls `delegate:list` today (`MantaAPIClient.swift:205`,
    Background jobs sheet), and a box without the delegate engine answers
    `{jobs: []}` (`rpc.mjs:2435`) — a success, which resolves `.allowed`.
  Re-resolves on appear, `delegateUpdates`, reconnect, app foreground, and every
  30 s while `.resolving` or while the bar shows a running job (recovers a
  missed `delegate.updated`). Pushes the result into
  `store.applyMutationPolicy`. Publishes `job: ChatCardJob?` (non-nil only for a
  read-only job), `parentWindowKey: String?`, `parentName: String?`,
  `stopping`, `lastFailure: String?`. ChatScreen holds it as
  `@StateObject private var jobOwnership: ChatCardJobOwnershipStore`
  (WS02-internal; no other workstream references it).
- **Feedback while resolving after a failure:** `bottomCards` shows
  `ChatCardResolvingLine` — "Can't confirm this session yet — messages you send
  will wait" with **Retry** (calls `jobOwnership.resolve()`; disabled while a
  resolve is in flight). Shown only when `mutationPolicy == .resolving` and
  `lastFailure != nil` (a normal first resolve is quick and silent). Held
  prompts already render as waiting rows in the transcript tail.
- **Composer writability (M-03-7):** on appear and on every change of
  `store.isBackgroundJobReadOnly` (including a transition back to ordinary),
  ChatScreen sets `composer.acceptsInput = !store.isBackgroundJobReadOnly`.
  `jobOwnership` pushes the policy into the store in the same main-actor step
  that publishes `job`, so the two never disagree. So while `.resolving`
  the shared controller still accepts typing and insertions (sends are held,
  never delivered), and a read-only job refuses them — WS05's send-to-agent
  bridge and WS07's attach read the same controller value.
- iOS's `DelegateJob` (WS04's `SessionModels.swift`) lacks the needed fields;
  WS02 decodes its own lenient `ChatCardJob` (skip-bad-element list decoding
  like `LenientDelegateJobs`).
- ChatScreen when `.readOnlyJob`:
  - `ChatCardReadOnlyJobBar` replaces `ComposerView` in the overlay slot and
    reports its height through the same measurement that feeds
    `bottomBarHeight`.
  - `.environment(\.transcriptCardActions, nil)` (read-only path,
    `TranscriptRow.swift:233–241`); no approval store; `bottomCards` shows only
    retry / compaction / notice / blocked.
  - `ContextSheet(allowsActions: false)` hides Compact / Clear / Hand off.
  - Overflow sheet gets `isReadOnlyJob: true` (M-02-2, applied by WS07).
  - `store.isBackgroundJobReadOnly` (`mutationPolicy == .readOnlyJob`) is the
    one read-only signal for consumers: M-02-2 (overflow), M-03-7 (composer),
    M-05-1 (git header, which also reads `composer.acceptsInput`).
- Bar copy per desktop; model name via `ChatCardJobLogic.parseModelRef` then
  `modelStore.models` name lookup.
- **Stop** when `ChatCardJobLogic.isStoppable(status)` (running or paused,
  matching `stopJob`): confirm ("Stop this job?" / "The job stops and its window
  stays open.") → `api.delegateStop` → hint "Job stopped" + re-resolve; failure
  → "Couldn't stop the job: <reason>".
- **Go to parent** (D9):
  `navigator.open(.session(windowKey: MantaNavigator.windowKey(project: parent.project, windowIndex: parent.index)))`
  — WS04 declares `windowKey` **static** (`04-sessions.md` §11), so it is called
  on the type. `parent` = the window whose `opencodeSessionId ==
  parentSessionID` from `api.projects()` (stored as `parentWindowKey`). Parent window not found → no button;
  line reads "It reports to a session that's closed."

### Pure logic
`ChatCardJobLogic.isReadOnly`, `.job(forSession:in:)`, `.parseModelRef`,
`.summary` (formatJobSummary port), `.headline(modelName:)`, `.statusLine`,
`.isStoppable`; `ChatCardOwnershipResolver.next`; `ChatCardMutationGate.decide(policy:action:) -> .run | .hold | .refuse(String)`.

### Acceptance
- A job session opened from Background jobs shows the bar; permission cards are
  inert; no store mutation runs even if called.
- A CTO work worker opens writable.
- Initial `delegate:list` failure (transport OR server error) → composer usable,
  sends held as waiting, the resolving line with Retry appears; nothing is
  delivered until a successful list; after it resolves `.allowed` they go out;
  resolved `.readOnlyJob` they fail with the reason.
- `composer.acceptsInput` is false exactly while `store.isBackgroundJobReadOnly`,
  including after a job → ordinary transition.
- Missed `delegate.updated`: the 30 s re-resolve updates the bar.
- Stop confirms, then reports success or the box's reason.

---

## F7. Queued-message drain at the next step boundary — already at parity

The brief's `maybeDrainQueuedPrompt` / `shouldAbortForQueuedDrain` /
drain-abort no longer exist on desktop (grep of `src/renderer`: zero hits).
Desktop uses V2's inbox: a busy send goes with `delivery:"steer"` (next step)
or `"queue"` (after the turn) — `inboxState.ts:115–140`,
`PendingMessagesCard.tsx`; the box frames `inbox` (`streamInterp.mjs:20–31`,
517–528). iOS already does the same (`ComposerView.swift:1412` →
`sendOrSteer` → `opencode:prompt {messageID, delivery}`,
`ChatSessionStore.swift:1302–1380`). `toolBoundary` / `aborted` need no iOS
decoding. **Work:** none. Acceptance: a "Now" message reaches the agent at its
next tool step without interrupting the turn (manual simulator check).

---

## F8. Remove a queued message; pull the newest one back to edit

### Desktop today
× = `cancelInboxItem(item, restore:false)` (`ChatPanel.tsx:858–906`) — iOS
has it. **↑ edit last** (`editLastInboxItem`, 918–923) cancels the newest
non-busy item with `restore:true`; `describeInboxCancel`
(`inboxState.ts:216–…`): only `cancelled` restores; with attachments also
**"Attachments weren't restored — re-attach them"**; `delivered` → "Already
sent to the agent"; else "Couldn't confirm it was cancelled — it may still be sent".

### Wire
`opencode:inbox-cancel {sessionId, id}` → `{outcome, item?}` — existing
`api.inboxCancel`, `InboxCancelResult` (`InboxModels.swift:201`).

### iOS design
- `PendingMessagesCard`: header `HStack` adds trailing **"Edit last"**
  (`arrow.up`, id `pending-edit-last`), disabled when no non-busy item; new
  closure `onEditLast`.
- `InboxModels.swift` is not edited: `ChatCardEditLast` lives in
  `ChatCardLogic.swift` (it only reads `InboxItem` / `InboxCancelResult`).
- `ChatSessionStore.editLastInboxItem() async -> String?` (guarded by
  `canMutate`): pick via `ChatCardEditLast.pick(items:busy:)`, cancel through
  the shared private cancel helper, return text only for `cancelled`, hint for
  every other outcome via `ChatCardEditLast.report(result:item:)`.
- ChatScreen: if `composer.text` is non-blank, confirm first ("Replace your
  draft with the pending message?", D9) — before any cancel RPC. Then
  `if let t = await store.editLastInboxItem() { if !composer.insert(text: t, mode: .replace) { UIPasteboard.general.string = t; store.actionHint = "Removed from the queue — it couldn't go back in the composer, so it's on your clipboard" } }`
  (C3: the Bool is never ignored; `insert` focuses the field on success via
  `focusRequest`).
- The ↑-key gesture is not ported (keyboard shortcuts out of scope).

### Acceptance
Edit last removes the newer of two items and puts its text in the composer,
focused; `delivered`/`unknown` never restore and always say why; an
attachment-bearing item restores text and says attachments weren't restored;
a non-empty draft is never overwritten without confirmation.

---

## F9. Seat row in the context sheet (D17)

### Desktop today
`SessionHeader.tsx:641–643`, `792–800`: **"Seat: <account>"** /
**"Seat: <account> · <seat>"** (`describeSeatLine`, `chatUtils.ts:3812–3822`);
absent without a seat.

### iOS design
- Data: `accountsStore.conversationSeat` (`AccountsStore.swift:98–99`,
  `ConversationSeat.displayName`, `AccountsModels.swift:745–763`, same rule).
  No WS09 provider (F8 there removed by D17).
- `ChatCardSeatLine.value(_ seat: ConversationSeat?) -> String?` (trimmed
  `displayName`, nil when empty) — the single helper and test suite for this
  formatting.
- `ContextSheet` gains `var seat: String? = nil`, rendered as
  `LabeledContent("Seat", value: seat)` (id `ctx-seat-line`) in the first
  section, single line, truncating; ChatScreen passes
  `ChatCardSeatLine.value(accountsStore.conversationSeat)`.

### Acceptance
Multi-seat Claude conversation → "Seat  Work · Seat 2"; no seat → no row.

---

## F10. C2 `.message` route

### Constraints
- The pinned MessagingUI (`project.yml:19–28`, rev `1ec611ad`) only scrolls to
  an edge: `TiledScrollPosition.scrollTo(edge:)`
  (`Sources/MessagingUI/Tiled/TiledScrollPosition.swift:95`). No scroll-to-item.
- The transcript is fetched as a tail window by count (`fetchTranscript`,
  996–1026) and refetched at turn boundaries (689–692); a fetch requested
  while one is in flight returns immediately (998–1001).

### Design: anchor by message id; present a slice that starts at it (resolves review #4)
1. **Routing.** WS04's `SessionListView` handler (`04-sessions.md` §11) opens
   the chat for `.message(sid, _)` and leaves `pending` set. `ChatScreen`
   observes `navigator.pending` on appear and on change; for its own
   `store.sessionId` it clears `pending` and calls `store.focus(messageID:)`.
   Other sessions' routes are ignored here.
2. **State.** `ChatSessionStore`:
   ```swift
   enum ChatCardFocusPhase: Equatable { case none, locating(id: String, token: Int), presented(id: String, token: Int), failed(String) }
   @Published private(set) var focusPhase: ChatCardFocusPhase = .none
   @Published private(set) var focusedRowID: String?
   ```
   `focus(messageID:)` cancels any previous focus (latest wins: new `token`),
   sets `.locating` **synchronously** (the screen disables bottom-follow on this
   change, before any row changes), then `scheduleRefetch()`.
3. **Anchoring on every fetch.** After every successful fetch (inside the
   `MainActor.run` block, before mapping), while focus is `.locating` or
   `.presented`, run the pure planner
   `ChatCardFocusPlanner.next(target:messageIDs:limit:hasEarlier:cap:) -> .present(index) | .widen(newLimit) | .tooFarBack | .notFound`
   (cap 500, step `earlierMessageStep`):
   - target found at `index` → `.present(index)`; `presentedMessages =
     Array(messages[index...])`, phase `.presented` (same token).
   - not found and `hasEarlier && limit < cap` → `.widen`: set `messageLimit =
     min(limit + step, cap)` and `scheduleRefetch()`. The widen survives the
     in-flight early return because `fetchPending` re-runs the loop with the
     new limit.
   - not found, `hasEarlier`, `limit >= cap` → `.tooFarBack` → phase
     `.failed("That message is too far back to open here — it's more than 500
     messages ago")`. The history exists (e.g. WS06 searches the whole store);
     the phone simply won't page that far.
   - not found and `!hasEarlier` (the whole conversation is loaded) →
     `.notFound` → `.failed("Couldn't find that message — it may have been
     compacted away")`.
   Both failures set the hint and clear focus.
   Because the target is found **by id** on each fetch, messages appended
   between lookup and focus — or turn-boundary refetches while focused — never
   shift it; if new turns push it out of the tail, the planner widens.
   A failed fetch while `.locating` → `.failed("Couldn't load that message —
   check the connection")`.
4. **Mapping with the same options (review #5).** The three mapper call sites
   become one `remap()` that maps `presentedMessages` (the focus slice, or all
   `messages` when unfocused) through `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:options: mapOptions)`
   with `mapOptions()` (M-01-1). `hasEarlier` is published as `true` while
   presenting a slice with `index > 0`.
   **Which row is the target (review round 2 #5).** The mapper can produce no
   block for a message (an unfinished assistant message is skipped,
   `ChatModels.swift:183–192`; an empty/unsupported one maps to nothing), so
   "first row of the slice" is not proof. On `.present`, the store maps the
   target ALONE with the same options —
   `ChatTranscriptMapper.blocks(from: [target], voiceNotes: voiceNotes, widgets: widgets, options: mapOptions())`
   — and calls the pure
   `ChatCardFocusHighlight.resolve(targetBlockCount:targetIsUnfinishedAssistant:sliceRowIDs:) -> .row(String) | .unfinished | .nothingToShow`:
   - `targetBlockCount > 0` → `.row(sliceRowIDs[0])` (the slice starts with the
     target and the mapper emits blocks message by message, so its first
     block is row 0 of the slice) → `focusedRowID`.
   - 0 and unfinished assistant (`info.role.rawValue == "assistant"`,
     `info.time?.completed == nil` — the mapper's own skip rule) → no highlight, hint "That reply is still
     being written — it will appear here when it finishes". Focus stays
     presented (the slice starts where it will land).
   - 0 otherwise → no highlight, hint "That message has nothing to show here —
     showing what came after it".
5. **Scrolling (ChatScreen).**
   - On `.locating`: `scrollPosition.autoScrollsToBottomOnAppend = false`,
     `scrollsToBottomOnReplace = false`, show chip "Finding message…".
   - On `.presented` (token change): next run loop
     `scrollPosition.scrollTo(edge: .top, animated: true)`; chip "Showing an
     earlier message · Jump to latest".
   - While focus is not `.none`, the blocking-card arrival bottom-jump
     (`ChatScreen.swift:424–429`) is suppressed
     (`ChatCardFocusPolicy.allowsBottomJump(phase:) == false`).
   - Leaving focus: "Jump to latest", the existing scroll-to-bottom button, or
     any send → `store.clearFocus()` (restore `initialMessageLimit`, clear
     slice/row/phase, refetch) and the screen restores both auto-scroll flags
     and scrolls to bottom. The prepend loader ("Load earlier") while focused
     calls `store.loadEarlierWhileFocused()`, which is NOT `clearFocus()`:
     it keeps `messageLimit` and the fetched `messages` exactly as they are
     and removes only the local slice (`presentedMessages = messages`, phase
     `.none`, no refetch, no limit reset). The rows gain the `index` messages
     before the target — a prepend, which TiledView handles without a jump.
     If the target was already the first fetched message (`index == 0`, so
     there is nothing local to reveal), it then calls the normal
     `loadEarlier()` widening. The screen restores both scroll flags without
     scrolling. `.failed` → hint, flags restored.
   - `stop()` clears focus.
6. **Highlight.** `focusedRowID` reaches cells through
   `EnvironmentValues.transcriptHighlightedRowID` (declared in
   `ChatCardMessageFocus.swift`); the cell draws it (M-02-1). The highlight
   value is cleared after 2.5 s; the slice stays until focus ends.

Risk: a head-trim may diff as `.replace`; both scroll flags are off for the
whole focus, so it cannot jump to the bottom. Verify on the simulator.

### Pure logic
`ChatCardFocusPlanner.next`, `ChatCardFocusHighlight.resolve`,
`ChatCardFocusPolicy.allowsBottomJump`, `ChatCardFocusPolicy.loadEarlierAction(index:) -> .revealLocal | .revealLocalThenWiden`,
`ChatCardFocusPhase` transitions (`ChatCardFocusMachine.reduce(_:event:)`:
focus/presented/tooFarBack/notFound/fetchFailed/clear, stale-token events ignored).

### Acceptance
- `navigator.open(.message(sid, mid))` 120 messages back opens the chat with
  that message at the top, highlighted.
- A message appended between lookup and presentation, a completion refetch
  while focused, and a new permission card all leave the target at the top
  (no bottom jump).
- A second `.message` while the first is locating wins; the first's late
  result is ignored.
- Jump to latest restores tail-follow; an unknown id says so; a valid id more
  than 500 messages back says it is too far back (not "compacted").
- Load earlier at a deep focus keeps the target loaded and reveals the messages
  above it without a jump; at `index == 0` it also widens normally.
- A still-streaming target is not highlighted and says it is still being
  written; the next message is never highlighted in its place.

---

## F11. C5 — frames decoded for other workstreams (D15)

| Frame (`sub`) | Server source | Payload | `ChatSessionStore` property |
|---|---|---|---|
| `commandExecuted` | `streamInterp.mjs:1038–1040` | `{messageID, name, arguments}` (`arguments` always a string, `""` when absent) | `@Published private(set) var commandByMessageID: [String: StreamCommandExecutedPayload]` |
| `truncation` | `:885–893` | `{kind, label, messageID?}` | `truncation: StreamTruncationPayload?` (existing, latest only — unchanged) |
| `retry` | `:771–783` | see F1 | `retry` |
| `compaction` | `:973–985` | see F2 | `compaction` |
| `optimizer.compacted` | `index.mjs:1925–1937` | see F2 | `compactionNotice` |

`StreamCommandExecutedPayload { messageID: String; name: String; arguments: String }`
(`Codable, Equatable, Sendable`) in `MantaStreamModels.swift`. The router keeps
the map in `MantaSessionStreamState` (`commandByMessageID`), bounded to the
newest 200 entries by `ChatCardBoundedLog` (insertion-ordered; state lives for
the app's lifetime). Eviction loses nothing durable: the canonical command
origin arrives on the transcript (WS01 M-01-1 inputs are fallbacks only).

**Live-truncation decision (reconciled after round 2, matches D15 and WS01).**
WS02 publishes NO per-message truncation map. WS01 consumes the existing single
`truncation` (only the latest warning can lack a canonical record) through
`TranscriptLiveTruncation.from(kind:messageID:)` into
`TranscriptMapOptions.liveTruncation`.

The conversions into WS01's mapper input are WS01's exact expressions (M-01-1):
`liveCommands: commandByMessageID.mapValues { TranscriptCommandOrigin.fromLive(name: $0.name, arguments: $0.arguments) }`,
`liveTruncation: truncation.flatMap { TranscriptLiveTruncation.from(kind: $0.kind, messageID: $0.messageID) }`.

**Notice suppression (M-01-4).** `trailingBlocks` drops the tail truncation
notice only when `truncation.messageID` is in
`ChatTranscriptMapper.footerTruncationMessageIDs(liveTranscript)` — i.e. a
rendered footer actually shows it. A loaded message whose footer has no
truncation (no canonical metadata and no live kind, or an unknown kind) keeps
its standalone notice.

Dropped (no consumer): `stepEnded`, `stepEndedByMessageID`. Not decoded:
`toolBoundary`, `aborted`, `messageChanged`, `childSession`, `attention`.

---

## Files

**Edit (owned):**
- `MantaUI/MantaStreamModels.swift` — retry/compaction/notice/command payloads,
  `rawMessage`.
- `MantaUI/MantaEventStore.swift` — router cases + state fields
  (`retry`, `compactionGeneration`, `compaction`, `transcriptStaleSeq`,
  `compactionNotice`, `compactionNoticeSeq`, `sessionErrorSeq`,
  `commandByMessageID`), running-set retry clear, subjects `progressUpdates`,
  `delegateApprovalRequests`.
- `MantaUI/ChatSessionStore.swift` — F1–F4, F6 policy + guards, F8, F10,
  F11, `remap()`/`mapOptions`, and the received WS01 mounts.
- `MantaUI/ChatScreen.swift` — `bottomCards`, read-only branch +
  `composer.acceptsInput` sync, resolving line, reconnect sheet, navigator
  observation, focus scrolling, context-sheet args, and the received mounts.
- `MantaUI/UsageSheets.swift` (context sheet only) — `seat`, `allowsActions`.
- `MantaUI/PendingMessagesCard.swift` — Edit last.

**Create:**
- `MantaUI/MantaAPIClient+ChatCards.swift` — client members + `ChatCardApprovalAPI` conformance.
- `MantaUI/ChatCardModels.swift` — **Foundation only**: `ChatCardApproval`,
  `ChatCardApprovalTool`, `ChatCardJob`, `ChatCardCompactionState`,
  `ChatCardCompactionNotice`, `ChatCardMutationPolicy`, `ChatCardFocusPhase`,
  `ChatCardBoundedLog`.
- `MantaUI/ChatCardLogic.swift` — **Foundation only**: every pure enum/struct
  named above (retry copy, stream rules, compaction reducer, expiry latch,
  tokens, send-error, approval logic/decoding, job logic, ownership resolver,
  mutation gate, edit-last, seat line, progress rule, focus planner/policy/
  machine, `ChatCardMarkdown` (Foundation `AttributedString`)). Depends only
  on package files (`MantaStreamModels`, `InboxModels`, `AccountsModels`,
  `MantaError`, `MantaModels`); never on `SessionModels` / `ChatModels`.
- `MantaUI/ChatCardViews.swift`, `MantaUI/ChatCardApprovalStore.swift`,
  `MantaUI/ChatCardJobOwnershipStore.swift`, `MantaUI/ChatCardMessageFocus.swift`
  (environment key; SwiftUI).
- `MantaUITests/ChatCardsTests.swift` (pure; Linux + Mac) and
  `MantaUITests/ChatCardsStoreTests.swift` (router, stores; Mac only — needs
  Combine/SwiftUI).
- Manifest for the integration step (D18/D19): add `ChatCardModels.swift`,
  `ChatCardLogic.swift` to `Package.swift` sources and `ChatCardsTests.swift`
  to the test target (M-02-3). No `project.yml` edit; workers never touch the
  `.pbxproj`.

## Client members

All in `MantaUI/MantaAPIClient+ChatCards.swift`; no other spec declares these
names (grep of all specs and `MantaAPIClient*.swift`, 2026-10-28):

```swift
func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval]   // delegate:pending-approvals
func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> Bool  // delegate:approve → ok
func delegateDecline(id: String) async throws -> Bool                                 // delegate:decline → ok
func chatCardJobs() async throws -> [ChatCardJob]                                     // delegate:list (no arg)
```
Existing members used, not redeclared: `progressGet(sessionID:)`,
`delegateStop(id:)`, `projects()`, `inboxCancel(sessionId:id:)`.

## Tests

`MantaUITests/ChatCardsTests.swift` (Foundation; runs under `verify.sh` and Mac):
1. `ChatCardRetryCopy` (title override, attempt 0, fallback body, invalid link);
   `ChatCardStreamRules.clearsRetry`.
2. `ChatCardCompactionReducer`: started→delta→ended; delta/ended without prior → nil; generation carried.
3. `ChatCardExpiryLatch`: unrelated observations during the window don't
   reschedule; after `expire` the same key stays hidden; a new key while an old
   timer is pending is visible and the old `expire` doesn't hide it; seed hides
   an existing `.done`; stale (nil state) followed by an unrelated observation
   stays nil.
4. `ChatCardTokens.desktopCompact` (999, 1000→"1k", 12_340→"12.3k", 128_000→"128k");
   `ChatCardCompactionNotice.text` (away, background, zero saving, after ≥ before, nils).
5. `ChatCardSendError.describe` (auth/anthropic, ApiError api-key/openai,
   "rate limit window expired" not auth, unknown provider, rawMessage used,
   typed prefixes).
6. `ChatCardApprovalLogic`: `canStart` false for empty list and blank fields;
   footnotes; `outcomeHint(ok:false)` = "That request is no longer pending";
   `filterResolved`; decoding both shapes.
7. `ChatCardJobLogic` (work worker not read-only, lookup, parseModelRef edge
   cases, summary 0/1/2 files ± worktree, status line, isStoppable).
8. `ChatCardOwnershipResolver`: resolving+success-none → allowed;
   resolving+transport failure → resolving; resolving+`MantaError.server`
   (transient server read failure) → **resolving**; readOnlyJob+any failure →
   readOnlyJob; work record → allowed.
9. `ChatCardMutationGate`: resolving send → hold, resolving reply → refuse,
   readOnlyJob → refuse, allowed → run.
10. `ChatCardEditLast` pick/report.
11. `ChatCardSeatLine.value` (nil, empty, normal).
12. `ChatCardFocusPlanner` (found → present; target shifted by appended ids →
    same id found; missing+hasEarlier → widen capped at 500; missing+hasEarlier
    +limit ≥ cap → `.tooFarBack` (a valid target beyond the cap); missing+
    !hasEarlier → `.notFound`); `ChatCardFocusHighlight.resolve` (target with
    blocks → row 0; unfinished assistant target followed by a visible message
    → `.unfinished`, never row 0; empty target → `.nothingToShow`);
    `ChatCardFocusPolicy.loadEarlierAction` (index > 0 → `.revealLocal`,
    index 0 → `.revealLocalThenWiden`); `ChatCardFocusMachine` (stale token
    ignored; second focus wins).
13. `ChatCardBoundedLog` evicts the oldest past 200.

`MantaUITests/ChatCardsStoreTests.swift` (Mac `test-unit`):
14. Router: `retry` decode/null/turn-end/running-set clear; compaction
    generation increments; `transcriptStale` nils compaction and bumps seq;
    `sessionErrorSeq` bumps on identical payloads; `commandExecuted` map
    (bounded to 200).
15. `ChatCardApprovalStore` with a fake `ChatCardApprovalAPI`: a matching
    pending permission never triggers approve; a fetch completing after a local
    approve does not restore the card; `ok:false` → hint + refresh; empty list
    → no approve call.
16. `ChatSessionStore.trailingBlocks`: auth error omitted, typed text used;
    dismissal by seq (two identical errors). M-01-4: `footerTruncationIDs`
    empty → notice kept; containing M with truncation on M → omitted.
    End-to-end (mapper + store): a loaded, settled assistant message M with NO
    canonical truncation metadata plus a live `truncation{messageID: M,
    kind: "output-cap"}` frame → M's footer shows the badge (via
    `liveTruncation`) and the tail notice is gone; same with an unknown kind →
    no footer badge and the tail notice stays; a live truncation on M while
    M is incomplete in the snapshot (`time.completed == nil`) → notice kept
    (WS01 M-01-4 integration test).
17. Mutation policy: resolving send held as `.waiting`; allowed drains it;
    readOnlyJob fails it with the reason; a resolve that fails with
    `MantaError.server` delivers nothing.
18. M-03-7: with a real `ComposerTextController`, `acceptsInput` is true while
    `.resolving`, false once `isBackgroundJobReadOnly`, true again after job →
    ordinary;
    `insert`/`attach` return false only in the job state.
19. Focus: Load earlier at index 12 keeps `messageLimit` and `messages`
    unchanged and reveals 12 rows (no refetch); at index 0 it also widens;
    `.tooFarBack` copy for a target beyond 500.

Checks before reporting done: `mobile/native/verify.sh` (pure suite) green,
`ios-mantaui action: test-unit` green on the branch, `npm run typecheck` and
`npm test` unchanged-green.

## Mount requests

IDs match the master's canonical mount ledger (`00-master.md`).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-02-1 | `TranscriptRow.swift` (WS01) | Integration agent B (WS01 does not run in B) | `EnvironmentValues.transcriptHighlightedRowID: String?` (WS02, `ChatCardMessageFocus.swift`) | In `TranscriptCellReveal` add `@Environment(\.transcriptHighlightedRowID) private var highlightedRowID`; on `cellContent` add `.background(item.id == highlightedRowID ? tokens.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: Metrics.radius.md))` and `.animation(.easeOut, value: highlightedRowID)`. Nothing else. | WS02 commit containing `ChatCardMessageFocus.swift` |
| M-02-2 | `ChatOverflowSheet.swift` (WS07) | WS07 (wave B) | — (plain parameter) | Add `var isReadOnlyJob: Bool = false`; when true hide Compact, Clear, Fork, Delete, the Trust-mode toggle, Rename (M-04-1) and the Mode rows (M-04-2). ChatScreen passes `isReadOnlyJob: store.isBackgroundJobReadOnly`. The default keeps either landing order compiling. | none |
| M-02-3 | `mobile/native/Package.swift` | Integration agent B | `ChatCardModels.swift`, `ChatCardLogic.swift`, `ChatCardsTests.swift` (WS02) | Append the two files to the `MantaUI` target `sources` and the test file to `MantaUITests` `sources`, then run `./verify.sh`. Do NOT add `MantaAPIClient+ChatCards.swift`, `ChatCardViews.swift`, `ChatCardApprovalStore.swift`, `ChatCardJobOwnershipStore.swift`, `ChatCardMessageFocus.swift`, `ChatCardsStoreTests.swift`. | WS02 commit |

## Mounts applied by this workstream (wave B)

Reconciled against the master's canonical mount ledger (`00-master.md`
"Mount ledger (canonical)"). Every row's receiving file is owned by WS02, so
WS02 applies it in wave B (D18). Provider symbols are quoted verbatim from the
providers' specs.

| ID | From | Receiving file | Provider symbol(s) | Change as applied | Prerequisite |
|---|---|---|---|---|---|
| M-01-1 | WS01 | `ChatSessionStore.swift` | `TranscriptMapOptions`, `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:options:)`, `TranscriptCommandOrigin.fromLive(name:arguments:)`, `TranscriptLiveTruncation.from(kind:messageID:)`, `TranscriptMediaStore.shared.entries(for:)`, `TranscriptDisplayOptions.showDetails` | Replace the three mapper calls (`fetchTranscript` ~1064, `refreshVoiceNotes` ~1111, `refreshWidgets` ~1137) with one `private func mapOptions() -> TranscriptMapOptions` + the `options:` overload, mapping **`presentedMessages`** (F10 slice, else `messages`). Value: `TranscriptMapOptions(showReasoning: TranscriptDisplayOptions.showDetails, running: running, liveCommands: commandByMessageID.mapValues { TranscriptCommandOrigin.fromLive(name: $0.name, arguments: $0.arguments) }, liveTruncation: truncation.flatMap { TranscriptLiveTruncation.from(kind: $0.kind, messageID: $0.messageID) }, liveMedia: TranscriptMediaStore.shared.entries(for: sessionId))`. No per-message truncation map exists. | WS01 merged (A1); WS02 F11 `commandByMessageID`; F10 `presentedMessages` |
| M-01-2 | WS01 | `ChatSessionStore.swift` (`rebuildBlocks`) | `ChatTranscriptMapper.liveMediaTail(messages:live:isLiveWindow:)` | In both branches append, through `uniqueTranscriptRows`, `ChatTranscriptMapper.liveMediaTail(messages: presentedMessages, live: TranscriptMediaStore.shared.entries(for: sessionId), isLiveWindow: presentedMessages.last?.info.id == messages.last?.info.id)` after `liveTranscript`, before the live prose tail and `trailing`. Same `presentedMessages` as M-01-1 (keeps the two media segments disjoint). | M-01-1 |
| M-01-3 | WS01 | `ChatSessionStore.swift` | `TranscriptMediaStore.shared.$sessions`, `TranscriptDisplayOptions.didChange` | Next to the widget sink (~445–450): `TranscriptMediaStore.shared.$sessions.map { $0[sessionId] }.removeDuplicates()` and `NotificationCenter.default.publisher(for: TranscriptDisplayOptions.didChange)`, each → private `remap()` (re-map `transcript` from `presentedMessages` with `mapOptions()` under the `refreshWidgets` no-blank-clobber guard, then `rebuildBlocks()`). Also `remap()` when `commandByMessageID` or `truncation` changes and when `running` flips to false. | M-01-1 |
| M-01-4 | WS01 | `ChatSessionStore.swift` (`trailingBlocks`, `rebuildBlocks`) | `ChatTranscriptMapper.footerTruncationMessageIDs(_:)` | New `trailingBlocks` parameter `footerTruncationIDs: Set<String> = []`, passed `ChatTranscriptMapper.footerTruncationMessageIDs(liveTranscript)` from `rebuildBlocks`; skip the truncation `.notice` only when `truncation.messageID` is non-nil and in that set (the old "message exists in `messages`" rule is removed). Tests #16 (incl. WS01's incomplete-snapshot integration case). | M-01-1 |
| M-03-7 | WS03 | `ChatScreen.swift` (`ChatScreenContent`) | `ComposerTextController.acceptsInput` (WS03); `ChatSessionStore.isBackgroundJobReadOnly` (WS02) | `.onAppear { composer.acceptsInput = !store.isBackgroundJobReadOnly }` and `.onChange(of: store.isBackgroundJobReadOnly) { _, ro in composer.acceptsInput = !ro }` (F6 "Composer writability"). `.resolving` keeps `true`. | M-03-1 (A1); WS02 F6 |
| M-04-3 | WS04 | `ChatScreen.swift` | `SessionListStore.window(forSessionID:) -> (project: String, window: MantaWindow)?` | `.navigationTitle(sessionStore.window(forSessionID: store.sessionId)?.window.name ?? title)` (`:342`). | WS04 merged (A2) |
| M-04-4 | WS04 | `ChatScreen.swift` | `SessionRenameSheet(title:initialName:onSave:)`, `SessionListStore.renameSession(project:index:newName:) async -> String?`, `ChatOverflowSheet.onRename` (M-04-1, WS07) | Pass `onRename:` → dismiss the overflow, then present `SessionRenameSheet(title: "Rename session", initialName: <live window name>, onSave: { await sessionStore.renameSession(project: projectName, index: w.index, newName: $0) })`; window unresolved → `store.actionHint = "Can't rename — session's window not found."`. | M-04-1 (WS07, same wave, param pinned) |
| M-04-5 | WS04 | `ChatScreen.swift` | `MantaNavigator.switchMode(windowKey:sessionID:to:)`, static `MantaNavigator.windowKey(project:windowIndex:)`, `SessionModeStore.read(sessionID:)`, `SessionListStore.launchers: [AvailableLauncher]`, `.launcherCatalog: SessionLauncherCatalog`, `.refreshLaunchers()`; overflow params from M-04-2 | Pass to `ChatOverflowSheet`: `mode: sessionWindow == nil ? nil : SessionModeStore.read(sessionID: store.sessionId)`, `launchers: sessionStore.launchers`, `launcherCatalog: sessionStore.launcherCatalog`, `onSelectMode: { m in guard m != .chat, let w = sessionWindow else { return }; navigator.switchMode(windowKey: MantaNavigator.windowKey(project: projectName, windowIndex: w.index), sessionID: store.sessionId, to: m) }`, `onRetryLaunchers: { Task { await sessionStore.refreshLaunchers() } }`. Add `@EnvironmentObject private var navigator: MantaNavigator`. | M-04-2 (WS07, same wave, params pinned) |
| M-04-6 | WS04 | `ChatScreen.swift` | `MantaNavigator.presentSwitcher()` | `ToolbarItem(placement: .topBarTrailing)` before the overflow button (`:346`): `Button { navigator.presentSwitcher() } label: { Image(systemName: "rectangle.stack") }.accessibilityLabel("Switch session")`. | WS04 merged |
| M-06-1 | WS06 | `ChatScreen.swift` | `SearchScreen(scope:seed:search:)`, `SearchScope.fromProjects(_:primarySessionId:)` | In `.toolbar` (`:345–351`), before the ellipsis: `ToolbarItem(placement: .primaryAction) { Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search conversations") }`; `@State private var showSearch = false`; `.sheet(isPresented: $showSearch) { SearchScreen(scope: .fromProjects(sessionStore.projects, primarySessionId: sessionId)) }`. Not on the read-only subagent screen. | WS06 symbols (same wave, pinned) |
| M-07-1 | WS07 | `ChatScreen.swift` | `ArtifactsCard(sessionId:onClose:projectName:cwd:composer:onJumpToMessage:)`, `composer` (WS03 M-03-1), `MantaNavigator.open(.message(sessionID:messageID:))` | In `destinationCard(.artifacts)` (`:782–785`): `ArtifactsCard(sessionId: store.sessionId, onClose: { overflowDestination = nil }, projectName: projectName, cwd: sessionWindow?.cwd, composer: composer, onJumpToMessage: { mid in pendingArtifactJump = mid; overflowDestination = nil })`; `@State private var pendingArtifactJump: String?`; in `flushPendingPush()` (`:825`), first: `if let mid = pendingArtifactJump { pendingArtifactJump = nil; navigator.open(.message(sessionID: store.sessionId, messageID: mid)) }` → F10. No `onAttach`, no attach hint — the card owns attach feedback. | M-03-1 (A1), WS04 navigator (A2), WS07 params (B, defaulted) |
| M-07-2 | WS07 | `ChatScreen.swift` | `WebhooksCard(sessionId:onClose:)`, `ChatOverflowSheet.onWebhooks: (() -> Void)?` | `OverflowDestination` (`:88`) + `case webhooks`; `destinationCard`: `case .webhooks: WebhooksCard(sessionId: store.sessionId, onClose: { overflowDestination = nil })`; `overflowSheet` (`:658`) passes `onWebhooks: { overflowDestination = .webhooks }`. | WS07 (B) |
| M-09-5 | WS09 | `ChatScreen.swift` | `UsageAlertsStore.shared.activeSessionId` | Beside the two `reportFocus(sessionId: store.sessionId, visible: true)` calls (`:371`, `:472`): `UsageAlertsStore.shared.activeSessionId = store.sessionId`. Beside the two `visible: false` calls (`:381`, `:475`): `if UsageAlertsStore.shared.activeSessionId == store.sessionId { UsageAlertsStore.shared.activeSessionId = nil }`. | WS09 symbol (same wave, pinned) |

**Not received / superseded:**
- `M-04-7` (`ChatScreen(initialCarryOver:)`) — **superseded**: WS04's create
  flow passes the confirmed draft through WS03's A1 `ChatScreen(draft:)`
  (M-03-4). WS02 adds no `initialCarryOver` parameter and applies nothing for it;
  the old `seedAttachments` receipt is gone with it.
- `M-08-2` (optional, `UsageSheets.swift` usage-sheet seat "Fix" →
  Accounts): **declined** — WS02 owns only the context sheet in that file; the
  existing Fix already opens Accounts.
- `M-05-1` (`ChatScreen.swift` `sessionHeaderBlock`): applied by WS05 in wave C
  (D18). WS02 provides `store.isBackgroundJobReadOnly` and M-03-7 so
  `composer.acceptsInput` is correct for WS05's bridge.
- `M-03-9` (`ComposerView.swift`, IB after B) reads WS02's
  `store.mutationPolicy` / `ChatCardMutationPolicy.resolving`; not a mount into
  a WS02 file.
- Withdrawn/void, history only: WS01's former decoder request (WS02 F11 owns
  the decoder intrinsically, D15); WS09's former seat-row request (D17). The
  `.message` route handling in ChatScreen is WS02's own C2 duty (F10), not a
  mount.
- WS03 M-03-1…M-03-4 are applied by WS03 in A1 (D13); WS02 builds on them.
- WS08 and WS10 request nothing in WS02 files (WS08's Reconnect note is a
  provider compatibility statement for `AccountsScreen(store:focusProvider:ownsLifecycle:)`).

## Contracts provided / consumed

- **C1 provided:** see Client members.
- **C2:** implements `.message` in the chat screen (F10); consumes WS04's
  `.session`, static `MantaNavigator.windowKey(project:windowIndex:)`,
  `presentSwitcher()`, `switchMode(windowKey:sessionID:to:)`.
- **C3 consumed:** `composer.insert(text:mode:)`, `acceptsInput` (M-03-7),
  every `false` surfaced.
- **C4 owner;** received mounts above.
- **C5 provided:** `commandByMessageID` (D15), `truncation` (existing, latest;
  WS01's live fallback), `retry`, `compaction`, `compactionNotice`.
- **Provided to WS03/WS05/WS07:** `ChatSessionStore.isBackgroundJobReadOnly`,
  `ChatSessionStore.mutationPolicy` / `ChatCardMutationPolicy`, and the
  `composer.acceptsInput` sync (M-03-7). `jobOwnership` is internal.
- **Consumed:** WS08 `AccountsStore.conversationSeat`,
  `AccountsScreen(store:focusProvider:ownsLifecycle:)`; WS04 `MantaProgress`,
  `SessionListStore`, `SessionRenameSheet`, `SessionModeStore`; WS01
  `TranscriptMapOptions`, `TranscriptMediaStore`, `TranscriptDisplayOptions`,
  `TranscriptCommandOrigin`, `TranscriptLiveTruncation`, `ChatTranscriptMapper`
  extensions; WS06 `SearchScreen`,
  `SearchScope.fromProjects`; WS07 `ArtifactsCard`, `WebhooksCard`; WS09
  `UsageAlertsStore`.
- **C7:** the two test files; no node tests.

## Deferred

- **Reset health (F4)** — D8: the only producer is desktop Auto routing
  (`routing:choose`, `ChatPanel.tsx:1837–1849`; `rpc.mjs:1627–1646`), which iOS
  never calls.
- ↑ on an empty composer for Edit last — keyboard shortcut, out of scope.
- Approval expiry countdown — desktop has none.
- **Desktop bugs reported (D10, renderer-only, not fixed):** Reconnect
  dispatches an unheard event; approve/decline/stop swallow errors; approval
  auto-approve trusts *pending* permissions' `always[]` patterns
  (`ChatPanel.tsx:956–960`).

## Open questions

None open. Former Q1 (ownership) settled by D1, Q2 (Go to parent) by D9,
Q3 (Edit last over a draft) by D9.

## Review responses (round 1)

| Finding | Resolution |
|---|---|
| WS02 #1 (empty edited list) | F5: `canStart` false for an empty list with the "tap Not now" footnote; test that no approve RPC is sent; spec states the server reverts an empty list to the original tools. |
| WS02 #2 (auto-approve from pending permissions) | Removed; F5 forbids any auto-approval; desktop behaviour reported under D10; store test with a matching pending permission. |
| WS02 #3 (compaction lifetime) | F2 rewritten: router owns generation + clears on `transcriptStale`; chat store uses `ChatCardExpiryLatch` (schedule once per generation, tombstone via `expiredThrough`, seeded on open); tests for unrelated frames, stale+unrelated, new compaction during old timer. |
| WS02 #4 (tail-count anchor) | F10 rewritten: id anchor re-located on every fetch by a pure planner, slice presentation, widen on drift, follow disabled at `.locating` before rows change, blocking-card jump suppressed, tokenised latest-wins focus, explicit failure paths, in-flight fetch handled by `fetchPending` + planner; tests listed. |
| WS02 #5 / cross #5 (command contract) | D15 adopted: `commandByMessageID: [String: StreamCommandExecutedPayload]`, `arguments: String`; F11 gives the conversion into `TranscriptMapOptions`; WS01 M3a–M3e listed as WS02 wave-B deliverables with M3e corrected; focus maps with the same `mapOptions`. Unused `stepEnded`/per-message truncation maps dropped. |
| WS02 #6 (approval copy/races) | "That request is no longer pending" + refresh; `resolvedIDs` tombstones drop stale fetch results; two store tests. |
| WS02 #7 (identical errors) | `sessionErrorSeq` in the router; dismissal by seq; reset on a new turn; test with two identical payloads. |
| WS02 #8 (ownership across gaps) | `ChatCardMutationPolicy` (resolving/allowed/readOnlyJob) pushed into `ChatSessionStore`; every mutation entry point gated; sends held in the outbox while resolving; known state kept on failure; re-resolve on reconnect/foreground/30 s; tests. |
| WS02 #9 (settled questions / mounts) | Open questions removed (D1, D9); Go to parent uses the navigator only; WS04's handler is in `SessionListView`/`MantaAppRoot` injection (D1), no RootView reference; WS06's same-wave search mount applied by WS02. |
| Cross #3 (composer adoption) | §0 and F8 consume WS03's wave-A adoption (D13); no legacy binding fallback. |
| Cross #8 (mount receipt) | New "Mounts applied by this workstream" table covering WS01, WS04, WS06, WS07, WS09 (and WS05/WS08/WS10 status); outgoing table per D18. |
| Cross #11 (seat row) | D17: F9 renders from `AccountsStore.conversationSeat` with one helper `ChatCardSeatLine` and one test; WS09 M6 marked void. |
| Cross #12 (C3 Bool) | Every `insert`/`attach` call in F8 and the received mounts handles `false` with a hint (Edit last also copies to the clipboard). |
| Cross #10 (package/pbxproj) | Package additions moved to M-02-3 for integration agent B; no worker pbxproj regeneration. |

## Review responses (round2)

| Finding | Resolution |
|---|---|
| WS02 r2 #1 / cross #2 (WS01 integration) | Receipts are M-01-1…M-01-4 verbatim from WS01 (reconciled after round 2): `entries(for:)` (array), `$sessions`, `liveMediaTail(messages:live:isLiveWindow:)` over `presentedMessages`, `TranscriptCommandOrigin.fromLive`, remap on command/truncation changes and `running`→false. Notice suppression uses `footerTruncationMessageIDs(liveTranscript)`. Live-truncation contract resolved ONE way: WS02 publishes no per-message map; WS01 consumes the existing single `truncation` via `TranscriptLiveTruncation.from(kind:messageID:)` (D15 unchanged). Tests #16 cover a loaded message with no canonical metadata + a live frame, the unknown-kind case, and the incomplete-snapshot case. |
| WS02 r2 #2 (stale provider signatures) | `SearchScope.fromProjects(_:primarySessionId:)` (M-06-1); `ArtifactsCard(…composer:onJumpToMessage:)`, card owns attach feedback (M-07-1); M-04-7 / `initialCarryOver` superseded by WS03's `ChatScreen(draft:)` (M-03-4); Go to parent and M-04-5 call the **static** `MantaNavigator.windowKey(project:windowIndex:)`; M-04-5 passes `launcherCatalog`/`onRetryLaunchers`/optional `mode` exactly as M-04-2 pins (WS07 receiver aligned); WS09 receipt is M-09-5; all receipts use canonical IDs. |
| WS02 r2 #3 (server error releases sends) | Removed the server-error → `.allowed` rule. Any failure keeps the current state; only a successful list releases held prompts. Added the resolving line with Retry. Test #8/#17 now assert a `MantaError.server` failure delivers nothing. Evidence for dropping the compatibility exception: `delegate:list` without an engine already answers `{jobs: []}` (`rpc.mjs:2435`), i.e. a success. |
| WS02 r2 #4 (Load earlier vs clearFocus) | New `loadEarlierWhileFocused()`: keeps `messageLimit` and `messages`, removes only the slice (a prepend), and calls normal `loadEarlier()` only when `index == 0`. Tests #12/#19. |
| WS02 r2 #5 (highlighting the wrong row; cap copy) | Target mapped alone with the same `mapOptions()`; `ChatCardFocusHighlight.resolve` highlights row 0 only when the target yields blocks, otherwise gives "still being written" / "nothing to show" feedback. Planner distinguishes `.tooFarBack` (cap) from `.notFound` (fully loaded, absent). Tests #12. |
| Cross #3 (draft transport) | Resolved by the master ledger: the draft reaches the new chat only through WS03's A1 `ChatScreen(draft:)` (M-03-4); M-04-7 superseded; WS02 adds no `initialCarryOver` and applies nothing for it. |
| Cross #5 (M-03-7 missing) | Added M-03-7 receipt and F6 "Composer writability": `composer.acceptsInput = !store.isBackgroundJobReadOnly` on appear and on every change, incl. back to ordinary; `.resolving` permits typing/insertion (sends held). Canonical read-only API pinned in F6 (`isBackgroundJobReadOnly`, `mutationPolicy`). Test #18 with a real controller. |
| Cross #7 (search scope) | M-06-1 uses `.fromProjects(sessionStore.projects, primarySessionId: sessionId)` verbatim. |
| Cross #8 (artifacts) | M-07-1 passes `composer: composer`; no `onAttach`; M-07-2 under its canonical ID. |
| Cross #10 (ledger IDs) | Both tables use ledger IDs; withdrawn/void requests moved to a "not received / superseded" list; M-08-2 recorded as declined; `.message` handling relabelled as WS02's own C2 work. |
