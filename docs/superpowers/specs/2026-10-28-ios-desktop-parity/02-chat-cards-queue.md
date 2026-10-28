# WS02 — Chat cards, queue, and chat-screen hotspot

Status: revised (server-first, D23/D24) · Date: 2026-10-28 · Wave: **B** · Master: `00-master.md`

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

**Server-first (D23/D24).** Audit items C1, C2, C5, C9, C10, C11 and S16
(`server-first-audit.md` §WS02) are computed on the box; the clients render the
result. New server pieces: `src/server/delegateView.mjs` (+ `delegate:job-for-session`,
decorated `delegate:list`, `delegate:approve` rule check, read-only job refusal),
`src/server/inboxCopy.mjs`, `src/server/boxCapabilities.mjs`, and additive frame
fields from `src/shared/streamInterpretation.mjs`. Contract in
"## Server-first (D23/D24)". The desktop switches in this same workstream.

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

### iOS design (renders the server's copy — audit C1)
- `MantaStreamModels.swift`: `StreamRetryAction {title, message, label, link: String?}`,
  `StreamRetryPayload {attempt: Double; message: String; next: Double?; action: StreamRetryAction?; headline: String?; caption: String?; body: String?}`
  (the last three are the box's copy, SF-1).
- `MantaSessionStreamState.retry: StreamRetryPayload?`. Router `"retry"`:
  `s.retry = try? frame.decodedPayload(...)` (JSON `null` → nil). Also cleared
  by `ChatCardStreamRules.clearsRetry(sub:running:complete:)` on `running`
  `false` and `turnComplete` `complete:true`, and in `applyingRunningSet` for
  sessions absent from the set (the box does not replay `retry`).
- `ChatSessionStore.retry` (published, copied in `applyStreamState`).
- View `ChatCardRetry` (`ChatCardViews.swift`) in `bottomCards` when non-nil:
  `arrow.clockwise` + `headline` + `caption` (when non-nil); `body` ≤ 3 lines;
  `Link(action.label ?? "Open", destination:)` when `action.link` parses as a
  URL (presentational). No client copy rule: the box decides headline/caption/
  body (`describeRetry`, SF-1). **Old box** (fields absent): the fixed label
  "Retrying…" and the raw `message`, no caption.

### Pure logic (`ChatCardLogic.swift`)
`ChatCardStreamRules.clearsRetry` only. (`ChatCardRetryCopy` is deleted —
server-first.)

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
- **Server copy (audit C2):** the `compaction` `ended` frame carries
  `firstLine` (the box accumulates the started text + deltas and takes the
  first non-blank line), folded into `ChatCardCompactionState.firstLine`; the
  `optimizer.compacted` frame carries `text` (e.g. "⟳ Compacted while you were
  away · 128k → 31k"), which iOS shows verbatim. iOS formats no token counts.
- Published: `compaction: ChatCardCompactionState?`,
  `compactionNotice: ChatCardCompactionNotice?` (`{text: String}` = the frame's
  `text`; a frame without `text` (old box) publishes nothing).
- Views: `ChatCardCompaction` (`sparkle`, `.symbolEffect(.pulse)` while
  running; "Compacting…"/"Compacted", `reason`, streamed text while running,
  `firstLine` when done — omitted when absent), `ChatCardCompactionNotice`
  (one quiet line).
- `ChatSessionStore.compact()` keeps its existing request hints.

### Pure logic
`ChatCardCompactionReducer` (folds phases; copies `firstLine` from `ended`),
`ChatCardExpiryLatch` (view timing, KEEP-CLIENT per audit C3).
`ChatCardCompactionNotice.text` and `ChatCardTokens` are deleted (server-first).

### Acceptance
- started → delta → ended shows growing text, then "Compacted" + first line,
  gone ≤ 3.5 s later, and does not come back on later frames.
- A `transcriptStale` frame triggers exactly one refetch and the card is gone
  for good.
- `optimizer.compacted` with the box's `text` shows that text for 10 s (the
  box produces "⟳ Compacted while you were away · 128k → 31k" /
  "⟳ Compacted in the background", pinned by node tests SF-2).
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

### iOS design (renders the server's `display` — audit C5)
- `StreamSessionErrorPayload` gains `rawMessage: String?` and
  `display: StreamSessionErrorDisplay?` with
  `StreamSessionErrorDisplay { text: String; reconnect: Reconnect? }`,
  `Reconnect { providerID: String; label: String; accountsId: String }` (SF-3).
  The box classifies the failure against the provider of the session's
  current model (it tracks it from `session.step.started` /
  `session.model.selected`), so iOS needs no model-store plumbing.
- Router: `sessionErrorSeq: Int` bumped on every `sessionError` frame
  (identical payloads are distinct occurrences).
- `ChatSessionStore`:
  - `dismissedSessionErrorSeq: Int?`; `dismissSessionError()` records the
    current `sessionErrorSeq`. The published `sessionError` is nil while
    `sessionErrorSeq == dismissedSessionErrorSeq`; a new frame (even an
    identical payload) has a higher seq and shows; a `running:true` edge resets
    the dismissal (the router already clears the error on a new turn,
    `MantaEventStore.swift` `running` case).
  - `trailingBlocks` takes `sessionErrorText: String?` = `display?.text ??
    message` (an old box has no `display`: the raw message is shown, never a
    client-side reclassification) and gets `nil` when `display?.reconnect` is
    non-nil — that error is shown pinned (one copy, actionable). Existing
    `trailingBlocks` tests updated.
- View `ChatCardSendErrorLine` (pinned, reconnect case only): danger-tinted,
  `display.text`, **Reconnect**, × ("Dismiss error"). Reconnect →
  `reconnectTarget = ReconnectTarget(provider: display.reconnect.accountsId)`;
  ChatScreen presents
  `.sheet(item:) { NavigationStack { AccountsScreen(store: accountsStore, focusProvider: $0.provider, ownsLifecycle: false).toolbar { Done } } }`
  and calls `dismissSessionError()`.
- **Reset health: deferred** (D8).

### Acceptance
- `ProviderAuthError` on an anthropic session → pinned "Claude needs to be
  reconnected." with Reconnect, no duplicate transcript notice; Reconnect opens
  Accounts with Claude first.
- `ApiError` "rate limit window expired" → the box's `display.text`
  ("API error: …") as a plain notice (classification pinned by SF-3 tests).
- Old box (no `display`): the raw `message` as a plain notice, no Reconnect.
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
- **Empty edited list is NOT deny-all:** the engine uses edited tools only when
  non-empty, otherwise the original request (`delegate.mjs:4783–4787`).
  **New (audit C6 enforcement, folded into SF-4):** `delegate:approve` refuses
  an explicit empty list or any rule with a blank `permission`/`pattern`:
  `{ok:false, error:"A job needs at least one rule with a permission and a pattern."}`
  — the approval stays pending.
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
    "Background job declined"; `ok:false` **with** `error` (the box refused the
    rules) → keep the card, `error = <box error>`; `ok:false` without `error` →
    tombstone, `pending = nil`, hint **"That request is no longer pending"**,
    then refresh; thrown error → keep the card,
    `error = "Couldn't reach your box — try again"`.
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
non-blank — client gating, KEEP-CLIENT per audit C6; the box re-checks),
`.footnote(tools:)`, `.outcomeHint(ok:approved:)`,
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

### Wire (server-first — audit C9/C10)
- **NEW** `delegate:job-for-session` (SF-4): arg `{sessionId}` →
  `{readOnly:false}` or `{readOnly:true, job: DelegateJobView}`; the box decides
  job-ness (`correlation.kind !== "work"`), the headline (with the catalog
  model name), status line, parent line, parent window and stoppability. iOS and
  desktop render it.
- `delegate:stop` (`rpc.mjs:2437`) via the existing `api.delegateStop(id:)`
  (throws on refusal). Freshness via `eventStore.delegateUpdates`.
- **NEW refusal (C10):** the box itself refuses `opencode:prompt`,
  `opencode:inbox-cancel`, `opencode:inbox-set-delivery`,
  `opencode:compact-session`, `opencode:run-command` aimed at a read-only job
  session: HTTP 409 `{error:"This is a background job — it can't take messages", code:"read_only_job"}`.
  The client policy below remains the UX; the box is the authority.

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
  `ChatCardOwnershipResolver.next(current:result:)` over the box's answer
  (the `.resolving` machine is connection state — KEEP-CLIENT per audit C9):
  - capability `chat-cards-1` present and `delegate:job-for-session` →
    `{readOnly:true, job}` → `.readOnlyJob` (the `job` view is published as the
    ownership store's `job`);
  - `{readOnly:false}` → `.allowed`;
  - capability absent (old box, read once via `boxCapabilities()`) →
    `.allowed` and `jobBarUnavailable = true` (D24: the dependent feature is
    hidden; there is no bar to disable, and the old box has no refusal either —
    exactly today's behaviour);
  - **any failure, of any error class → keep the current state** (a known job
    stays read-only; `.resolving` stays resolving). Only a successful answer can
    release held prompts. Rationale: `MantaAPIClient` maps every non-empty RPC
    `error` string to `MantaError.server` (`MantaAPIClient.swift:923–929`), and
    the lookup is a live read of the job store that can fail transiently.
  Re-resolves on appear, `delegateUpdates`, reconnect, app foreground, and every
  30 s while `.resolving` or while the bar shows a running job (recovers a
  missed `delegate.updated`). Pushes the result into
  `store.applyMutationPolicy`. Publishes `job: ChatCardJobView?` (non-nil only
  for a read-only job), `stopping`, `lastFailure: String?`,
  `jobBarUnavailable: Bool`. ChatScreen holds it as
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
- The wire type is WS02's `ChatCardJobView` (decoded leniently, see SF-4); iOS
  no longer reads raw job records for this feature.
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
- Bar content = the box's view, verbatim: `job.headline`, `job.parentLine`,
  `job.statusLine`. No client-side model lookup, summary or status rule.
- **Stop** when `job.stoppable`: confirm ("Stop this job?" / "The job stops and
  its window stays open.") → `api.delegateStop(id: job.id)` → hint "Job
  stopped" + re-resolve; failure → "Couldn't stop the job: <reason>".
- **Go to parent** (D9), shown only when `job.parent != nil`:
  `navigator.open(.session(windowKey: MantaNavigator.windowKey(project: job.parent.project, windowIndex: job.parent.windowIndex)))`
  — WS04's key builder is static and the key format is a client navigation
  concern, so the box returns `project` + `windowIndex`, not a key. No parent
  window → no button; the box's `parentLine` already says "It reports to a
  session that's closed."

### Pure logic
`ChatCardOwnershipResolver.next` (maps the box answer / failure / missing
capability onto the policy); `ChatCardMutationGate.decide(policy:action:) -> .run | .hold | .refuse(String)`
(client UX gate — the box refuses anyway, C10). `ChatCardJobLogic` is deleted
(server-first, SF-4).

### Acceptance
- A job session opened from Background jobs shows the bar; permission cards are
  inert; no store mutation runs even if called.
- A CTO work worker opens writable (box answers `{readOnly:false}`).
- An old client (or a bug) that POSTs a prompt into a job session gets the
  box's 409 refusal; nothing reaches opencode.
- Old box without `chat-cards-1`: the session resolves writable, no bar.
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

### Wire (server-first — audit C11)
`opencode:inbox-cancel {sessionId, id, restore?}` → `{outcome, item?, notice,
error, restoreText}` and `opencode:inbox-set-delivery {sessionId, id, delivery}`
→ `{outcome, notice, error}` (SF-5). The box writes every outcome sentence and
decides whether text may be restored (only `cancelled` with `restore:true`).

### iOS design
- `PendingMessagesCard`: header `HStack` adds trailing **"Edit last"**
  (`arrow.up`, id `pending-edit-last`), disabled when no non-busy item; new
  closure `onEditLast`.
- `InboxModels.swift` (WS02, D1): `InboxCancelResult` and
  `InboxSetDeliveryResult` decode the new optional `notice`, `error`,
  `restoreText`; `InboxActionReport.cancel(_:)` / `.setDelivery(_:)` (the
  outcome→sentence rules) are **deleted**. Only the transport-failure strings
  (`cancelFailed`, `setDeliveryFailed` — no box answer exists) stay.
- `ChatSessionStore`: `cancelInboxItem` / `setInboxDelivery` /
  `editLastInboxItem` call the box and show `error ?? notice` as `actionHint`
  (refresh the inbox when either is non-nil, as today).
  `editLastInboxItem() async -> String?` (guarded by `canMutate`) picks via
  `ChatCardEditLast.pick(items:busy:)` (KEEP-CLIENT, audit C12), calls
  `api.inboxCancelReported(sessionId:id:restore: true)` and returns
  `restoreText`. **Old box** (capability absent): the "Edit last" button is
  disabled with the caption "Update your box to use this"; × still works and
  shows only what the box returns (no notice) plus the inbox refresh.
- ChatScreen: if `composer.text` is non-blank, confirm first ("Replace your
  draft with the pending message?", D9) — before any cancel RPC. Then
  `if let t = await store.editLastInboxItem() { if !composer.insert(text: t, mode: .replace) { UIPasteboard.general.string = t; store.actionHint = "Removed from the queue — it couldn't go back in the composer, so it's on your clipboard" } }`
  (C3: the Bool is never ignored; `insert` focuses the field on success via
  `focusRequest`).
- The ↑-key gesture is not ported (keyboard shortcuts out of scope).

### Acceptance
Edit last removes the newer of two items and puts its text in the composer,
focused; `delivered`/`unknown` never restore and show the box's sentence; an
attachment-bearing item restores text and shows the box's "attachments weren't
restored" notice;
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

## Server-first (D23/D24)

Audit items folded (`server-first-audit.md` §WS02, MOVE-NOW): **C1, C2, C5, C9,
C10, C11, S16** (plus C6's server enforcement, which the audit folds into C9's
module). KEEP-CLIENT items stay client: C3 expiry latch, C4 `state == "blocked"`,
C6 edit gating (UX), C12 edit-last pick, C13 inbox acceptance, C15 pending-row
labels, C17 focus planner, C18 drain. MOVE-LATER (C7, C8, C14, C16) are WS11
follow-ups and are not built here.

Every piece is additive (new fields / channel / opt-in arg); an old client on a
new box keeps working unchanged (audit §4 "Old desktop ↔ new box"). One
capability id, **`chat-cards-1`**, covers all of SF-1…SF-5.

### SF-0 Capabilities (`src/server/boxCapabilities.mjs`, NEW)
- `export const BOX_CAPABILITIES = Object.freeze(["chat-cards-1"])`. This is
  the ONE capability module of the whole effort (master D25 + id registry).
  Other wave-B workstreams append their ids through integration agent B
  (M-07-S2, M-09-srv-2, M-06-srv-2, order 02 → 07 → 09 → 06); WS05 appends its
  own in wave C; WS11 D1 extends the same file in wave D (no second module).
- `src/server/version.mjs` (edited by the WS02 worker — not one of the three
  integration-only files): `writeVersionResponse` adds
  `capabilities: [...BOX_CAPABILITIES]` to `GET /api/version`.
- `rpc.mjs` `"server:version"` adds the same `capabilities` field (mount
  M-02-srv-1).
- Response: `{version, minClient, opencodeVersion, opencode, capabilities: string[]}`
  (REST) / `{version, minClient, opencodeVersion, capabilities: string[]}` (RPC).
- Node tests `src/server/boxCapabilities.test.mjs`: list is frozen, contains
  `chat-cards-1`, no duplicates; `version.test.mjs` adds a case that the REST
  body carries `capabilities`.
- **Client gate.** iOS: `MantaAPIClient.boxCapabilities() async throws -> Set<String>`
  (reads `server:version`; absent field → empty set), read by ChatScreen once
  on appear and on reconnect into `ChatCardCapabilities` (`@MainActor` store,
  `has(_:) -> Bool?`, nil = unknown → treat as `.resolving` for F6, hide
  Edit last until known). Desktop: new `src/renderer/hooks/useBoxCapabilities.ts`
  → `useBoxCapability(id: string): boolean | null` (reads
  `window.api.getServerVersion().capabilities`; refetched on reconnect via the
  same refresh key `useCompatibilityCard` takes). These two are the ONLY
  client accessors in waves B/C (master D25): WS05/06/07/09 call them, never a
  copy. `ChatCardCapabilities` is WS02-internal (chat screen). WS11 D1 later
  folds `boxCapabilities()` into `ServerVersionInfo.capabilities` + an app-level
  store and keeps `useBoxCapability` as the desktop hook. Missing capability → the
  dependent control is hidden or disabled with **"Update your box to use this"**
  (static copy); no fallback copy of the moved logic is kept on either client.

### SF-1 Retry copy (C1) — `src/shared/streamInterpretation.mjs` + `streamInterp.mjs`
- New pure `describeRetry({attempt, message, action}) -> {headline, caption, body}`:
  `headline = action?.title || "Retrying…"`; `caption = attempt > 0 ? "attempt N" : null`;
  `body = action?.message || message || null`.
- `streamInterp.mjs` `session.retry.scheduled` (`:771–783`) spreads it into
  the payload (mount M-02-srv-2): frame `retry` =
  `{attempt, message, next?, headline, caption, body}`. `null` clear unchanged.
- Desktop behaviour change (PR note): the headline no longer repeats the
  attempt ("Retrying… (attempt 2) · attempt 2" → "Retrying… · attempt 2").
- Tests: `src/shared/streamInterpretation.test.ts` (`describeRetry` 4 cases);
  `src/server/streamInterp.chatCards.test.mjs` (frame carries the fields).

### SF-2 Compaction copy (C2)
- NEW `src/shared/formatTokens.mjs` (+ `.d.mts`, test `src/shared/formatTokens.test.ts`;
  master D26 — the ONE token formatter, created by WS02 in wave B, consumed by
  WS09 and WS11): `formatTokenCount(n) -> string` (compact, no unit: `<1000` →
  whole number, `<100k` → one decimal with `.0` dropped + "k", else rounded
  "k") and `formatTokens(n) -> string` (`n < 1000 ? "<n> tokens" : "<formatTokenCount(n)> tokens"`,
  byte-identical to today's `chatUtils.ts:219`).
- `streamInterpretation.mjs`: `compactionFirstLine(text) -> string|null` (first
  non-blank line, trimmed); imports `formatTokenCount` from `./formatTokens.mjs`;
  `describeBackgroundCompaction({beforeTokens, afterTokens, away}) -> string`
  (`"⟳ Compacted while you were away"` when `away`, else
  `"⟳ Compacted in the background"`, plus `" · <before> → <after>"` only when
  both are positive finite and `after < before`).
- `streamInterp.mjs` (mount M-02-srv-3): per-session `st.compactionText`
  reset on `session.compaction.started` (seeded with its `text`), appended on
  `.delta`; the `ended` frame becomes
  `{phase:"ended", firstLine: compactionFirstLine(st.compactionText)}`.
- `index.mjs` (mount M-02-srv-4): the `optimizer.compacted` publish
  (`:1925–1937`) adds `text: describeBackgroundCompaction({beforeTokens, afterTokens, away})`.
- Tests: `streamInterpretation.test.ts` (firstLine blank/indent/multi-line;
  `formatTokenCount` 999/1000/12_340/128_000; notice away/background/zero
  saving/after ≥ before/nulls); `streamInterp.chatCards.test.mjs`
  (started+2 deltas+ended → `firstLine`; a new started resets).

### SF-3 Session-error display (C5)
- Moved verbatim from `src/renderer/chatUtils.ts` (800–826, 1777–1853) into
  `streamInterpretation.mjs`: `AUTH_PROVIDER_LABELS`, `isAuthErrorName`,
  `authErrorAdvice`, `describeSessionError`. New shape:
  `describeSessionError({name, message, rawMessage}, providerID) -> {text, reconnect: {providerID, label, accountsId} | null}`
  where `accountsId` = `{anthropic:"claude", openai:"codex", "kimi-for-coding":"kimi"}[providerID]`
  (the ids WS08's `AccountsScreen(focusProvider:)` accepts).
- `streamInterp.mjs` `session.execution.failed` (`:742–760`, mount M-02-srv-5):
  frame `sessionError` = `{name, message, rawMessage?, display: describeSessionError({name, message: human, rawMessage: message}, st.model?.providerID)}`.
  The box's `st.model` is set from `session.created` / `step.started` /
  `model.selected` (`streamInterp.mjs:907`, `:783`, `:931`).
- Tests: the existing desktop cases move from `chatUtils.frames.test.ts` (29–56)
  and `chatUtils.test.ts` (2027–2085, `authErrorAdvice`) to
  `streamInterpretation.test.ts`, plus `accountsId` cases;
  `streamInterp.chatCards.test.mjs`: a failed execution after a step on
  `anthropic` with `ProviderAuthError` → `display.reconnect.accountsId == "claude"`;
  no model known → `reconnect: null`.

### SF-4 Job view, refusal, approve check, list labels (C9, C10, C6-enforce, S16) — `src/server/delegateView.mjs` (NEW)
```js
export class ReadOnlyJobError extends Error { code = "read_only_job"; rpcStatus = 409 }
export const READ_ONLY_JOB_MESSAGE = "This is a background job — it can't take messages";
export function createDelegateView({ listJobs, listProjects, listModels, now = Date.now }) → {
  jobForSession(sessionId) → Promise<{readOnly:false} | {readOnly:true, job: DelegateJobView}>,
  assertWritable(sessionId) → Promise<void>,        // throws ReadOnlyJobError
  decorateList(jobs) → jobs.map(j => ({...j, statusLabel, summary})),
  validateApprovalTools(tools) → string | null,     // null = ok
}
// pure, exported for tests:
isReadOnlyJob(job), jobStatusLabel(job), jobSummary(job), jobHeadline(modelName), jobStatusLine(job), parseModelRef(ref)
```
- `DelegateJobView = {id, status, statusLabel, headline, statusLine, parentLine, stoppable: boolean, parent: {sessionId, name, project, windowIndex} | null}`.
- Rules (ported from the desktop, then deleted there): job for a session = the
  newest non-superseded record with `childSessionID === sessionId`;
  read-only = `correlation?.kind !== "work"` (`chatUtils.ts:1869`);
  `headline` = `"Read-only — this is a background job running <model name>."`
  when `parseModelRef(job.model)` resolves in `listModels()` (memoized 5 min),
  else `"Read-only — this is a background job."`; `parentLine` = `"It reports to <window name>."`
  when the parent window is found in `listProjects()` (window whose
  `opencodeSessionId === parentSessionID`; name = `window.name ?? project.tmuxSession`),
  else `"It reports to a session that's closed."`; `statusLine` = running/paused →
  `activity || "running…"`, terminal → `jobSummary(job)` (`"<branch> · N files changed"` /
  `"N file(s) changed"`, `chatUtils.ts:1901`) + `" · <error ?? status>"` for
  failed/stopped; `stoppable` = `status ∈ {running, paused}` (matches
  `stopJob`; desktop used running only — PR note); `statusLabel` = the status
  word, `"unknown"` when empty (S16); `summary` = `jobSummary(job)` (S16).
- `validateApprovalTools(tools)`: `undefined` → null (use original request);
  an array that is empty, or has a rule with blank `permission`/`pattern` →
  `"A job needs at least one rule with a permission and a pattern."`.
- RPC (mounts M-02-srv-6…9, `rpc.mjs`):
  - NEW `"delegate:job-for-session": (input) => delegateView.jobForSession(input?.sessionId)`;
    missing `sessionId` → `throw new Error("sessionId is required")`.
  - `"delegate:list"` returns `delegateView.decorateList(...)` (array shape
    unchanged, two fields added; the `{jobs: []}` no-engine fallback untouched).
  - `"delegate:approve"`: `const err = delegateView.validateApprovalTools(input?.tools); if (err) return {ok:false, error: err};`
    before resolving.
  - `await delegateView.assertWritable(<sessionId>)` first in
    `opencode:prompt` (`input.sessionId`), `opencode:inbox-cancel`,
    `opencode:inbox-set-delivery` (`input.sessionId`), `opencode:compact-session`
    (arg), `opencode:run-command` (`input.sessionId`).
  - `handleRpcRequest` catch: `if (typeof e?.rpcStatus === "number") { sendJson(e.rpcStatus, {error: e.message, code: e.code}); return; }`
    — the body's `error` is the human sentence, so an old desktop shows it as-is
    (audit §4).
- `index.mjs` (mount M-02-srv-10): `const delegateView = createDelegateView({ listJobs: (f) => delegateEngine.listJobs(f ?? {}), listProjects: () => tmux.listProjects(), listModels: () => oc.listModels() })`
  and pass `delegateView` into `buildHandlers`.
- Node tests `src/server/delegateView.test.mjs`: work vs delegate vs subagent
  record; superseded record ignored; headline with/without a catalog hit;
  parent found/closed; statusLine running (activity / fallback), done (0/1/2
  files ± worktree), failed with/without error, stopped; stoppable
  running/paused/done; `assertWritable` throws for a read-only job, not for a
  work job or a non-job; `validateApprovalTools` undefined/empty/blank/ok;
  `decorateList` adds both fields; models fetched once within the memo window.
  `src/server/rpc.delegateView.test.mjs` (integration, after the mounts):
  `delegate:job-for-session` round trip; `opencode:prompt` to a job → 409 body.

### SF-5 Inbox outcome copy (C11) — `src/server/inboxCopy.mjs` (NEW)
- Moved from `src/renderer/inboxState.ts` (175–230):
  `describeInboxCancel(result, {restore}) -> {notice, error, restoreText}`,
  `describeInboxSetDelivery(result) -> {notice, error}`, constants
  `ATTACHMENTS_NOT_RESTORED`, `SET_DELIVERY_UNCONFIRMED`, `ALREADY_SENT`,
  `CANCEL_UNCONFIRMED`. `restoreText` = `result.item.text` only for
  `outcome:"cancelled"` with `restore:true`; attachments notice only then and
  when `item.attachmentCount > 0`.
- RPC (mount M-02-srv-11): `opencode:inbox-cancel` accepts optional
  `input.restore` (boolean) and returns `{...r, ...describeInboxCancel(r, {restore: input?.restore === true})}`;
  `opencode:inbox-set-delivery` returns `{...r, ...describeInboxSetDelivery(r)}`.
- Node tests `src/server/inboxCopy.test.mjs`: the existing `inboxState.test.ts`
  cases (145–211) ported 1:1, plus `restore:false` never returns text.

### Desktop migration (same workstream, no parallel implementation)
| File | Change |
|---|---|
| `src/renderer/chatUtils.ts` | **Delete** `describeSessionError`, `authErrorAdvice`, `AUTH_PROVIDER_LABELS`, `isAuthErrorName`, `formatCompactionSaving`, `formatTokensCompact`, `isReadOnlyJob`, `parseModelRef`, `formatJobSummary`. `formatTokens` becomes `export { formatTokens } from "../shared/formatTokens.mjs"` (one implementation, D26). `formatLastMove` (`:3803`, still live until WS11 D4) switches from the deleted `formatTokensCompact` to `formatTokenCount`. WS02 is the wave-B OWNER of this file (D27); WS07/WS09 hunks are ledger rows IB applies after WS02's commit. |
| `src/shared/formatTokens.mjs` / `.d.mts` / `formatTokens.test.ts` (NEW) | D26 formatter (see SF-2). |
| `src/renderer/SessionHeader.tsx` | Its private `formatTokensCompact` (`:75`) is deleted; the two call sites (`:668`, `:699`) use `formatTokenCount` (no other wave-B worker edits this file; WS05 edits it in wave C). |
| `src/renderer/api/demoApi.ts`, `src/renderer/api/demoCoverage.test.ts` | WS02 owns both in wave B (D27): add `delegateJobForSession` to `DEMO_UNIMPLEMENTED` (or a stub); WS07/WS09 entries are ledger rows. |
| `src/renderer/chatUtils.test.ts`, `chatUtils.frames.test.ts` | Remove the moved cases (they now live in `streamInterpretation.test.ts`); keep a `formatTokens` case. |
| `src/renderer/inboxState.ts` (+ test) | **Delete** `describeInboxCancel`, `describeInboxSetDelivery`, `ATTACHMENTS_NOT_RESTORED`, `SET_DELIVERY_UNCONFIRMED` and their tests. |
| `src/renderer/hooks/useSseBus.ts` | `sessionError`: `setSendError(p.display?.text ?? p.message)`, `setAuthReconnect(p.display?.reconnect?.label ?? null)`; remove the `describeSessionError` import and `providerIDRef` if no other use remains. `compaction` `ended`: store `firstLine` from the frame. |
| `src/renderer/Cards.tsx` | `RetryCard` renders `info.headline ?? "Retrying…"`, `info.caption`, `info.body ?? info.message`, link unchanged. `CompactionCard` shows `state.firstLine` when done (no client split). |
| `src/renderer/ChatPanel.tsx` | Compaction notice line = `compactionNotice.text` (omit when absent; `useSseBus` stores `text` from `optimizer.compacted`). Read-only job: replace `jobs[sessionId]`/`isReadOnlyJob` (360–373) with `window.api.delegateJobForSession(sessionId)` on mount and on `onDelegateUpdated`, gated by `useBoxCapability("chat-cards-1")`; `ReadOnlyJobBar` (3509–3550) gets the view. Inbox cancel/set-delivery (858–906): send `restore`, show `result.error ?? result.notice` (`setSendError` for `error`, system notice for `notice`), restore `result.restoreText`; Edit last disabled with "Update your box to use this" when the capability is missing. Approve: show the box's `error` instead of swallowing it. |
| `src/renderer/PanelCards.tsx` | `ReadOnlyJobBar` props → `{view: DelegateJobView, onGoToParent, onStop}`; renders `headline`, `parentLine`, `statusLine`; Stop when `view.stoppable`; drop `formatJobSummary` import. |
| `src/renderer/hooks/useBoxCapabilities.ts` (NEW) | SF-0 hook. |
| `src/shared/types.ts` | `StreamRetryPayload` + `headline?`, `caption?`, `body?`; `StreamSessionErrorPayload` + `display?`; `StreamCompactionPayload` + `firstLine?`; `OpencodeInboxCancelResult` + `notice?`, `error?`, `restoreText?`; `OpencodeInboxSetDeliveryResult` + `notice?`, `error?`; `DelegateJob` + `statusLabel?`, `summary?`; NEW `DelegateJobView`, `DelegateJobForSession`; IPC `delegateJobForSession: "delegate:job-for-session"`. |
| `src/shared/api.ts`, `src/renderer/api/httpApi.ts` | `delegateJobForSession(sessionId): Promise<DelegateJobForSession>`; `opencodeInboxCancel` input gains `restore?`; `getServerVersion` type + `capabilities?: string[]`. |
| `src/shared/streamInterpretation.mjs` / `.d.mts` / `.test.ts` | SF-1…SF-3 functions + types + tests. |
| vitest | `src/renderer/hooks/useSseBusFrames.test.tsx`: frames with the new fields render the box's text; `PanelCards` ReadOnlyJobBar snapshot from a view; `ChatPanel.harness.test.tsx` inbox cancel uses result fields. |

**Same-wave desktop file ledger (D24, D27).** WS02 is the wave-B OWNER of
`chatUtils.ts` (+ tests), `ChatPanel.tsx`, `src/shared/types.ts`,
`src/shared/api.ts`, `httpApi.ts`, `demoApi.ts`, `demoCoverage.test.ts` and
creates `src/shared/formatTokens.mjs`. Every other wave-B worker's hunk in those
files is a ledger row (M-07-D1…D5, M-09-dsk-1/2/4/5, M-06-dsk-1/2) applied by
integration agent B after WS02's commit, in the order 02 → 07 → 09 → 06; those
workers apply their rows locally (uncommitted) only to verify.

### iOS consumption (summary)
SF-1 → F1, SF-2 → F2, SF-3 → F4, SF-4 → F5/F6 (+ S16 mounts M-02-4/5), SF-5 → F8.
Deleted from the iOS plan: `ChatCardRetryCopy`, `ChatCardCompactionNotice.text`,
`ChatCardTokens`, `ChatCardSendError`, `sessionErrorProviderID`,
`ChatCardJobLogic`, `ChatCardEditLast.report`, `InboxActionReport.cancel/
setDelivery`, `ChatCardJob` (raw record decoding). Their XCTests become decode
tests of the server shapes.

---

## Files

**Server (WS02 worker creates/edits; never `rpc.mjs` / `index.mjs` /
`streamInterp.mjs` — those are mounts M-02-srv-*, applied by integration agent B
first in the 02 → 07 → 09 → 06 order):**
- NEW `src/server/delegateView.mjs` + `delegateView.test.mjs` (SF-4).
- NEW `src/server/inboxCopy.mjs` + `inboxCopy.test.mjs` (SF-5).
- NEW `src/server/boxCapabilities.mjs` + `boxCapabilities.test.mjs` (SF-0).
- EDIT `src/server/version.mjs` (+ `version.test.mjs`): `capabilities` in the REST body.
- NEW `src/server/streamInterp.chatCards.test.mjs` and `src/server/rpc.delegateView.test.mjs`
  (written by the worker; green once the M-02-srv mounts are applied — integration
  agent B runs `npm run test:server` after applying them).
- EDIT `src/shared/streamInterpretation.mjs`, `.d.mts`, `.test.ts` (SF-1…SF-3).
- NEW `src/shared/formatTokens.mjs`, `.d.mts`, `formatTokens.test.ts` (D26).

**Desktop:** see "Desktop migration" (SF section).

**iOS — edit (owned):**
- `MantaUI/MantaStreamModels.swift` — retry/compaction/notice/command payloads
  incl. the box's copy fields (`headline`, `caption`, `body`, `firstLine`,
  `text`), `rawMessage`, `display`.
- `MantaUI/MantaEventStore.swift` — router cases + state fields
  (`retry`, `compactionGeneration`, `compaction`, `transcriptStaleSeq`,
  `compactionNotice`, `compactionNoticeSeq`, `sessionErrorSeq`,
  `commandByMessageID`), running-set retry clear, subjects `progressUpdates`,
  `delegateApprovalRequests`.
- `MantaUI/ChatSessionStore.swift` — F1–F4, F6 policy + guards, F8, F10,
  F11, `remap()`/`mapOptions`, M-01-7 fetch slimness, and the received WS01 mounts.
- `MantaUI/ChatScreen.swift` — `bottomCards`, read-only branch +
  `composer.acceptsInput` sync, resolving line, reconnect sheet, navigator
  observation, focus scrolling, context-sheet args, capabilities load, and the
  received mounts.
- `MantaUI/UsageSheets.swift` (context sheet only) — `seat`, `allowsActions`.
- `MantaUI/PendingMessagesCard.swift` — Edit last (+ disabled "Update your box
  to use this" state).
- `MantaUI/InboxModels.swift` (WS02, D1) — result fields `notice` / `error` /
  `restoreText`; delete `InboxActionReport.cancel` / `.setDelivery`.
- `MantaUI/BackgroundJobsSheet.swift` (WS02 from wave B, master D28) — M-02-5:
  render the box's `statusLabel` / `summary`.
- `MantaUI/UsageSheets.swift` usage-sheet rows — receipt M-09-9 only (WS09's
  `UsageMeters.band(_ window:)`).

**iOS — create:**
- `MantaUI/MantaAPIClient+ChatCards.swift` — client members + `ChatCardApprovalAPI` conformance.
- `MantaUI/ChatCardModels.swift` — **Foundation only**: `ChatCardApproval`,
  `ChatCardApprovalTool`, `ChatCardApproveResult`, `ChatCardJobView`,
  `ChatCardJobForSession`, `ChatCardCompactionState`, `ChatCardCompactionNotice`,
  `ChatCardMutationPolicy`, `ChatCardFocusPhase`, `ChatCardBoundedLog`.
- `MantaUI/ChatCardLogic.swift` — **Foundation only**: stream rules,
  compaction reducer, expiry latch, approval gating/decoding, ownership
  resolver, mutation gate, edit-last pick, seat line, progress rule, focus
  planner/policy/machine, `ChatCardMarkdown`. Depends only on package files
  (`MantaStreamModels`, `InboxModels`, `AccountsModels`, `MantaError`,
  `MantaModels`). (No copy rules: those are on the box.)
- `MantaUI/ChatCardViews.swift`, `MantaUI/ChatCardApprovalStore.swift`,
  `MantaUI/ChatCardJobOwnershipStore.swift`, `MantaUI/ChatCardMessageFocus.swift`,
  `MantaUI/ChatCardCapabilities.swift` (SwiftUI / Combine).
- `MantaUITests/ChatCardsTests.swift` (pure; Linux + Mac) and
  `MantaUITests/ChatCardsStoreTests.swift` (router, stores; Mac only).
- Manifest for the integration step (D18/D19): add `ChatCardModels.swift`,
  `ChatCardLogic.swift` to `Package.swift` sources and `ChatCardsTests.swift`
  to the test target (M-02-3). No `project.yml` edit; workers never touch the
  `.pbxproj`.

## Client members

All in `MantaUI/MantaAPIClient+ChatCards.swift` (WS02 is the registry owner;
this revision replaces `chatCardJobs()` and changes `delegateApprove`'s return
type — both unbuilt, no other consumer):

```swift
func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval]              // delegate:pending-approvals
func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> ChatCardApproveResult  // delegate:approve → {ok, error?}
func delegateDecline(id: String) async throws -> Bool                                            // delegate:decline → ok
func delegateJobForSession(sessionId: String) async throws -> ChatCardJobForSession              // delegate:job-for-session (NEW, SF-4)
func inboxCancelReported(sessionId: String, id: String, restore: Bool) async throws -> InboxCancelResult  // opencode:inbox-cancel {…, restore} (SF-5)
func boxCapabilities() async throws -> Set<String>                                               // server:version → capabilities (SF-0)
```
Existing members used, not redeclared: `progressGet(sessionID:)`,
`delegateStop(id:)`, `projects()`, `inboxCancel(sessionId:id:)` (× keeps it;
the server adds `notice`/`error` there too), `inboxSetDelivery(...)`,
`messages(sessionId:limit:slim:)`. WS10's `serverVersion()` is not reused: its
`ServerVersionInfo` (WS10-owned) has no `capabilities` field, and WS02 must not
edit it. Decided (master D25): `boxCapabilities()` is the single iOS accessor in
waves B/C; WS11 D1 folds it into `ServerVersionInfo.capabilities` +
`BoxCapabilitiesStore` and deletes it (migrating every caller) in wave D.

## Tests

`MantaUITests/ChatCardsTests.swift` (Foundation; runs under `verify.sh` and Mac):
1. Decoding of the box's retry payload (with and without
   `headline`/`caption`/`body`); `ChatCardStreamRules.clearsRetry`.
2. `ChatCardCompactionReducer`: started→delta→ended; delta/ended without prior → nil; generation carried; `firstLine` copied from the `ended` frame (absent → nil).
3. `ChatCardExpiryLatch`: unrelated observations during the window don't
   reschedule; after `expire` the same key stays hidden; a new key while an old
   timer is pending is visible and the old `expire` doesn't hide it; seed hides
   an existing `.done`; stale (nil state) followed by an unrelated observation
   stays nil.
4. `optimizer.compacted` decode: `text` present → notice; absent (old box) →
   no notice.
5. `sessionError` decode: `display` with/without `reconnect`; absent `display`
   → `sessionErrorText == message`, no reconnect.
6. `ChatCardApprovalLogic`: `canStart` false for empty list and blank fields;
   footnotes; `outcomeHint(ok:false)` = "That request is no longer pending";
   `filterResolved`; decoding both shapes; `ChatCardApproveResult` with
   `error` (box refusal) vs without.
7. `ChatCardJobForSession` decode: `{readOnly:false}`; `{readOnly:true, job}`
   with/without `parent`; unknown extra fields ignored.
8. `ChatCardOwnershipResolver`: resolving+`{readOnly:false}` → allowed;
   resolving+`{readOnly:true}` → readOnlyJob; capability absent → allowed +
   `jobBarUnavailable`; resolving+transport failure → resolving;
   resolving+`MantaError.server` → **resolving**; readOnlyJob+any failure →
   readOnlyJob.
9. `ChatCardMutationGate`: resolving send → hold, resolving reply → refuse,
   readOnlyJob → refuse, allowed → run.
10. `ChatCardEditLast.pick`; `InboxCancelResult` / `InboxSetDeliveryResult`
    decode `notice`/`error`/`restoreText` (present and absent).
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
    approve does not restore the card; `ok:false` → hint + refresh;
    `ok:false, error` → card kept with the box's error; empty list → no
    approve call.
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

20. M-01-7: with `TranscriptDisplayOptions.showDetails` off the fetch passes
    `slim: true`; on → `slim: false`; posting `didChange` triggers one refetch
    (and the remap of M-01-3).
21. Capabilities: `ChatCardCapabilities` unknown → Edit last hidden-disabled;
    absent `chat-cards-1` → "Update your box to use this" caption.

Server/desktop tests: SF-0…SF-5 node tests listed above; vitest per "Desktop
migration".

Checks before reporting done: `npm run typecheck`, `npm test` (incl. the new
node tests — the two integration test files run green after integration agent B
applies M-02-srv-*), `mobile/native/verify.sh` (pure suite) green,
`ios-mantaui action: test-unit` green on the branch.

## Mount requests

IDs match the master's canonical mount ledger (`00-master.md`).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-02-1 | `TranscriptRow.swift` (WS01) | Integration agent B (WS01 does not run in B) | `EnvironmentValues.transcriptHighlightedRowID: String?` (WS02, `ChatCardMessageFocus.swift`) | In `TranscriptCellReveal` add `@Environment(\.transcriptHighlightedRowID) private var highlightedRowID`; on `cellContent` add `.background(item.id == highlightedRowID ? tokens.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: Metrics.radius.md))` and `.animation(.easeOut, value: highlightedRowID)`. Nothing else. | WS02 commit containing `ChatCardMessageFocus.swift` |
| M-02-2 | `ChatOverflowSheet.swift` (WS07) | WS07 (wave B) | — (plain parameter) | Add `var isReadOnlyJob: Bool = false`; when true hide Compact, Clear, Fork, Delete, the Trust-mode toggle, Rename (M-04-1) and the Mode rows (M-04-2). ChatScreen passes `isReadOnlyJob: store.isBackgroundJobReadOnly`. The default keeps either landing order compiling. | none |
| M-02-3 | `mobile/native/Package.swift` | Integration agent B | `ChatCardModels.swift`, `ChatCardLogic.swift`, `ChatCardsTests.swift` (WS02) | Append the two files to the `MantaUI` target `sources` and the test file to `MantaUITests` `sources`, then run `./verify.sh`. Do NOT add `MantaAPIClient+ChatCards.swift`, `ChatCardViews.swift`, `ChatCardApprovalStore.swift`, `ChatCardJobOwnershipStore.swift`, `ChatCardMessageFocus.swift`, `ChatCardsStoreTests.swift`. | WS02 commit |
| M-02-4 | `SessionModels.swift` (WS04) | Integration agent B (WS04 not in B) | `delegate:list` row fields `statusLabel`, `summary` (SF-4, S16) | `DelegateJob` gains `var statusLabel: String? = nil`, `var summary: String? = nil` (CodingKeys + lenient decode in the existing `init(from:)`); **delete** `BackgroundJobFormat.statusLabel(_:)` (the box owns it). `timing`, `sorted`, `failureReason` stay (clock/sort/transport — KEEP-CLIENT). | WS02 commit (SF-4 server) |
| M-02-5 | `BackgroundJobsSheet.swift` (WS02 from wave B, master D28) | WS02 (wave B, own file) | `DelegateJob.statusLabel: String?`, `.summary: String?` (pinned; added to WS04's `SessionModels.swift` by IB via M-02-4) | In `detailLine(_:)` (~:376) use `job.statusLabel ?? job.status` instead of `BackgroundJobFormat.statusLabel(job)`; for a terminal job append `job.summary` when non-nil. Old box: the raw `status` word (data, no rule). | M-02-4 |
| M-02-srv-1 | `src/server/rpc.mjs` (`"server:version"`, :2584) | Integration agent B (1st in wave-B server order) | `BOX_CAPABILITIES` (`boxCapabilities.mjs`) | `({ version: serverVersion, minClient: MIN_CLIENT, opencodeVersion, capabilities: [...BOX_CAPABILITIES] })` + import. | WS02 commit |
| M-02-srv-2 | `src/server/streamInterp.mjs` (`session.retry.scheduled`, :771–782) | Integration agent B | `describeRetry` (`streamInterpretation.mjs`) | Emit `{attempt, message, ...(next), ...describeRetry({attempt, message, action: null})}`. | WS02 commit |
| M-02-srv-3 | `src/server/streamInterp.mjs` (compaction cases, :973–985) | Integration agent B | `compactionFirstLine` | `started`: `st.compactionText = textOf(d.text)`; `delta`: `st.compactionText += textOf(d.text)`; `ended`: `emit(sid, "compaction", { phase: "ended", firstLine: compactionFirstLine(st.compactionText ?? "") })`, then `st.compactionText = ""`. | WS02 commit |
| M-02-srv-4 | `src/server/index.mjs` (`optimizer.compacted` publish, :1925–1937) | Integration agent B | `describeBackgroundCompaction` | Add `text: describeBackgroundCompaction({ beforeTokens: before ?? null, afterTokens: after ?? null, away })` to the payload + import. | WS02 commit |
| M-02-srv-5 | `src/server/streamInterp.mjs` (`session.execution.failed`, :742–760) | Integration agent B | `describeSessionError` | Add `display: describeSessionError({ name: err?.name ?? null, message: human, rawMessage: message }, st.model?.providerID ?? null)` to the `sessionError` payload + import. | WS02 commit |
| M-02-srv-6 | `src/server/rpc.mjs` (`buildHandlers` deps + delegate channels, :2434–2480) | Integration agent B | `createDelegateView` instance `delegateView` | Destructure `delegateView` from deps; `"delegate:list"` → `delegateView ? delegateView.decorateList(list) : list` (array case only); NEW `"delegate:job-for-session"`; `"delegate:approve"` → `validateApprovalTools` check first (SF-4). | M-02-srv-10 |
| M-02-srv-7 | `src/server/rpc.mjs` (`opencode:prompt` :1344, `opencode:inbox-cancel` :1388, `opencode:inbox-set-delivery` :1402, `opencode:compact-session` :1968, `opencode:run-command` :2055) | Integration agent B | `delegateView.assertWritable` | First statement of each handler: `await delegateView?.assertWritable(<sessionId>)` (`input?.sessionId`, or the arg for compact). | M-02-srv-6 |
| M-02-srv-8 | `src/server/rpc.mjs` (`handleRpcRequest` catch, :2705) | Integration agent B | `ReadOnlyJobError.rpcStatus/code` | Before the HandoffError branch: `if (typeof e?.rpcStatus === "number") { sendJson(e.rpcStatus, { error: String(e.message), code: e.code }); return; }`. | M-02-srv-7 |
| M-02-srv-9 | `src/server/rpc.mjs` (inbox handlers :1388–1419) | Integration agent B | `describeInboxCancel`, `describeInboxSetDelivery` (`inboxCopy.mjs`) | Wrap results: `{...r, ...describeInboxCancel(r, { restore: input?.restore === true })}` / `{...r, ...describeInboxSetDelivery(r)}`. | WS02 commit |
| M-02-srv-10 | `src/server/index.mjs` (after `delegateEngine`, :1105; `buildHandlers` call) | Integration agent B | `createDelegateView` | `const delegateView = createDelegateView({ listJobs: (f) => delegateEngine.listJobs(f ?? {}), listProjects: () => tmux.listProjects(), listModels: () => oc.listModels() });` and pass `delegateView` into `buildHandlers({...})`. | WS02 commit |

Server-mount order inside integration agent B: M-02-srv-1 → 10 → 6 → 7 → 8 → 9
→ 2 → 3 → 5 → 4, then `npm run test:server` (includes WS02's
`streamInterp.chatCards.test.mjs` and `rpc.delegateView.test.mjs`), all before
any 07/09/06 server mount (D24 order).

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
| M-01-7 | WS01 (master D22) | `ChatSessionStore.swift` (`fetchTranscript`, ~1013; M-01-3 sink) | `TranscriptDisplayOptions.fetchSlim: Bool`, `TranscriptDisplayOptions.didChange: Notification.Name` (WS01, `TranscriptDisplayOptions.swift`) | Read the persisted toggle at fetch time: `api.messages(sessionId: sessionId, limit: limit, slim: TranscriptDisplayOptions.fetchSlim)` (replaces the hard-coded `slim: true`), so "show reasoning & full output" ON fetches full parts (reasoning is slim-dropped, D22). On `didChange` the M-01-3 subscription calls `scheduleRefetch()` (a real refetch at the new slimness — the canonical history changes shape) in addition to `remap()`. Test #20. | M-01-3; WS01 `TranscriptDisplayOptions.fetchSlim` (shipped, A1) |
| M-03-7 | WS03 | `ChatScreen.swift` (`ChatScreenContent`) | `ComposerTextController.acceptsInput` (WS03); `ChatSessionStore.isBackgroundJobReadOnly` (WS02) | `.onAppear { composer.acceptsInput = !store.isBackgroundJobReadOnly }` and `.onChange(of: store.isBackgroundJobReadOnly) { _, ro in composer.acceptsInput = !ro }` (F6 "Composer writability"). `.resolving` keeps `true`. | M-03-1 (A1); WS02 F6 |
| M-04-3 | WS04 | `ChatScreen.swift` | `SessionListStore.window(forSessionID:) -> (project: String, window: MantaWindow)?` | `.navigationTitle(sessionStore.window(forSessionID: store.sessionId)?.window.name ?? title)` (`:342`). | WS04 merged (A2) |
| M-04-4 | WS04 | `ChatScreen.swift` | `SessionRenameSheet(title:initialName:onSave:)`, `SessionListStore.renameSession(project:index:newName:) async -> String?`, `ChatOverflowSheet.onRename` (M-04-1, WS07) | Pass `onRename:` → dismiss the overflow, then present `SessionRenameSheet(title: "Rename session", initialName: <live window name>, onSave: { await sessionStore.renameSession(project: projectName, index: w.index, newName: $0) })`; window unresolved → `store.actionHint = "Can't rename — session's window not found."`. | M-04-1 (WS07, same wave, param pinned) |
| M-04-5 | WS04 | `ChatScreen.swift` | `MantaNavigator.switchMode(windowKey:sessionID:to:)`, static `MantaNavigator.windowKey(project:windowIndex:)`, `SessionModeStore.read(sessionID:)`, `SessionListStore.launchers: [AvailableLauncher]`, `.launcherCatalog: SessionLauncherCatalog`, `.refreshLaunchers()`; overflow params from M-04-2 | Pass to `ChatOverflowSheet`: `mode: sessionWindow == nil ? nil : SessionModeStore.read(sessionID: store.sessionId)`, `launchers: sessionStore.launchers`, `launcherCatalog: sessionStore.launcherCatalog`, `onSelectMode: { m in guard m != .chat, let w = sessionWindow else { return }; navigator.switchMode(windowKey: MantaNavigator.windowKey(project: projectName, windowIndex: w.index), sessionID: store.sessionId, to: m) }`, `onRetryLaunchers: { Task { await sessionStore.refreshLaunchers() } }`. Add `@EnvironmentObject private var navigator: MantaNavigator`. | M-04-2 (WS07, same wave, params pinned) |
| M-04-6 | WS04 | `ChatScreen.swift` | `MantaNavigator.presentSwitcher()` | `ToolbarItem(placement: .topBarTrailing)` before the overflow button (`:346`): `Button { navigator.presentSwitcher() } label: { Image(systemName: "rectangle.stack") }.accessibilityLabel("Switch session")`. | WS04 merged |
| M-06-1 | WS06 | `ChatScreen.swift` | `SearchScreen(primarySessionId:seed:search:)` (server-first: no `scope:` argument; `SearchScope` no longer exists) | In `.toolbar` (`:345–351`), before the ellipsis: `ToolbarItem(placement: .primaryAction) { Button { showSearch = true } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search conversations") }`; `@State private var showSearch = false`; `.sheet(isPresented: $showSearch) { SearchScreen(primarySessionId: store.sessionId) }`. Not on the read-only subagent screen. | WS06 symbols (same wave, pinned) |
| M-09-9 (UsageSheets part) | WS09 | `UsageSheets.swift` (usage-sheet rows, `:513`) | `UsageMeters.band(_ window: UsageWindow) -> MeterBand?` (WS09); `UsageWindow.tone` (M-09-8, IB) | Replace `UsageMeters.band(window.pct)` with `UsageMeters.band(window)`; a nil band tints with `tokens.tx4` (neutral). | WS09 (B, pinned); M-09-8 |
| M-02-5 | WS02 (own) | `BackgroundJobsSheet.swift` | M-02-4 fields | as in Mount requests | M-02-4 (IB) |
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
  extensions; WS06 `SearchScreen(primarySessionId:seed:search:)`; WS07
  `ArtifactsCard`, `WebhooksCard`; WS09 `UsageAlertsStore`,
  `UsageMeters.band(_ window:)`.
- **Server-first (D23/D24) provided:** `delegate:job-for-session`,
  decorated `delegate:list` (`statusLabel`, `summary`), `delegate:approve`
  rule check, read-only-job 409 refusal, inbox result `notice`/`error`/
  `restoreText`, frame fields `retry.headline/caption/body`,
  `sessionError.display`, `compaction.firstLine`, `optimizer.compacted.text`,
  capability `chat-cards-1` in `server:version` / `GET /api/version`, and the
  `BOX_CAPABILITIES` list other workstreams append to.
- **C7:** the two XCTest files; node tests `delegateView`, `inboxCopy`,
  `boxCapabilities`, `version`, `streamInterp.chatCards`, `rpc.delegateView`;
  vitest `streamInterpretation.test.ts` + the desktop updates.

## Deferred

- **Reset health (F4)** — D8: the only producer is desktop Auto routing
  (`routing:choose`, `ChatPanel.tsx:1837–1849`; `rpc.mjs:1627–1646`), which iOS
  never calls.
- ↑ on an empty composer for Edit last — keyboard shortcut, out of scope.
- Approval expiry countdown — desktop has none.
- **Desktop bugs reported (D10, renderer-only, not fixed):** Reconnect
  dispatches an unheard event; decline/stop swallow errors; approval
  auto-approve trusts *pending* permissions' `always[]` patterns
  (`ChatPanel.tsx:956–960`, audit C7 → WS11 follow-up). (Approve now shows the
  box's refusal, because the desktop switches to SF-4 in this workstream.)
- Audit MOVE-LATER for WS02 (C7 auto-approve on the box, C8 single
  pending-approvals shape, C14 prompt error codes, C16 seat `displayName`) —
  WS11 follow-ups, not built here.

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
| Cross #7 (search scope) | M-06-1 uses `.fromProjects(sessionStore.projects, primarySessionId: store.sessionId)` verbatim. |
| Cross #8 (artifacts) | M-07-1 passes `composer: composer`; no `onAttach`; M-07-2 under its canonical ID. |
| Cross #10 (ledger IDs) | Both tables use ledger IDs; withdrawn/void requests moved to a "not received / superseded" list; M-08-2 recorded as declined; `.message` handling relabelled as WS02's own C2 work. |

## Review responses (server-first)

| Item | Change |
|---|---|
| D23/D24 scope | New "## Server-first (D23/D24)" section folds audit C1, C2, C5, C9, C10, C11, S16 (+ C6 server enforcement) with modules, wire shapes, errors and node tests. |
| C1 retry copy | `describeRetry` in `src/shared/streamInterpretation.mjs`; `retry` frame + `headline/caption/body` (M-02-srv-2). iOS `ChatCardRetryCopy` deleted; desktop `RetryCard` renders the fields. |
| C2 compaction copy | `compaction` `ended` + `firstLine` (box accumulates text, M-02-srv-3); `optimizer.compacted` + `text` (M-02-srv-4); one shared `formatTokenCount` (desktop `formatTokens` built on it). iOS `ChatCardTokens`/`ChatCardCompactionNotice.text` deleted; desktop `formatCompactionSaving` deleted. |
| C5 send-error | `describeSessionError`/`authErrorAdvice`/`AUTH_PROVIDER_LABELS` moved from `chatUtils.ts` to the shared module, run in streamInterp against the box's own model record (`sessionError.display`, M-02-srv-5). iOS `ChatCardSendError` + `sessionErrorProviderID` deleted; desktop `useSseBus` reads `display`. |
| C9 job view | NEW `src/server/delegateView.mjs` + `delegate:job-for-session` (M-02-srv-6/10). iOS `ChatCardJobLogic` and raw `ChatCardJob` decoding deleted, bar renders the view; desktop `isReadOnlyJob`/`parseModelRef`/`formatJobSummary` deleted, `ReadOnlyJobBar` takes the view. The `.resolving` machine stays client (audit). Deviation from the audit's sketch: the parent is returned as `{sessionId, name, project, windowIndex}` instead of a `windowKey`, because the key format is a client navigation concern (`MantaNavigator.windowKey` is static client code). |
| C10 refusal | `assertWritable` on prompt / inbox-cancel / inbox-set-delivery / compact / run-command, 409 `{error: <sentence>, code:"read_only_job"}` via a generic `rpcStatus` branch in `handleRpcRequest` (M-02-srv-7/8). Client gate kept as UX. |
| C11 inbox copy | NEW `src/server/inboxCopy.mjs`; results gain `notice`/`error`/`restoreText`, cancel takes `restore` (M-02-srv-9). iOS `InboxActionReport.cancel/setDelivery` deleted; desktop `describeInboxCancel/describeInboxSetDelivery` deleted. |
| S16 list labels | `delegate:list` rows + `statusLabel`, `summary`; iOS `BackgroundJobFormat.statusLabel` deleted via M-02-4/5 (integration B). |
| Wire compat | Additive only; capability `chat-cards-1` (`boxCapabilities.mjs`, `server:version`, `/api/version`); per-feature old-box behaviour stated in F1/F2/F4/F6/F8 and SF-0 — hidden/disabled with "Update your box to use this", never a fallback copy of the moved logic. |
| D22 / M-01-7 | Added to "Mounts applied": fetch with `slim: TranscriptDisplayOptions.fetchSlim`, refetch on `didChange`; test #20. |
| Client members | `chatCardJobs()` replaced by `delegateJobForSession(sessionId:)`; `delegateApprove` returns `ChatCardApproveResult`; NEW `inboxCancelReported(sessionId:id:restore:)`, `boxCapabilities()`. Master registry row for WS02 must be updated accordingly. |
| Rejected audit items | None. |
| Reconciliation (master "Reconciliation log (server-first)") | `formatTokenCount` moved to the ONE module `src/shared/formatTokens.mjs` (D26, also exports `formatTokens`); `formatLastMove` + `SessionHeader.tsx` stop using deleted/duplicate compact formatters; WS02 is the wave-B owner of the shared desktop files (D27) incl. `demoApi.ts`/`demoCoverage.test.ts`; `BackgroundJobsSheet.swift` is WS02's (D28) so M-02-5 is WS02's own edit; M-06-1 receipt now `SearchScreen(primarySessionId:)`; M-09-9 receipt (UsageSheets band) added; `boxCapabilities.mjs` / `boxCapabilities()` / `useBoxCapability` confirmed as the single module/accessors (D25). |
