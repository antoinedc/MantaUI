# WS07 — Artifacts, agent-sent files, webhooks, shared secrets

Status: draft (revised, round 1) · Wave B · Owner files:
`SessionResourceCards.swift`, `ArtifactDerivation.swift`,
`ChatOverflowSheet.swift`, `mobile/native/Package.swift` + `project.yml` (D1;
edits routed through the wave-B integration step per D18), new `Artifact*` /
`Webhook*` files. Binding rules: `00-master.md` (C1–C7, D1–D19).

**No new server routes.** Every feature reuses a channel, route or bus event the
desktop already uses. No server file is edited.

Features in scope (7):

| # | Feature |
|---|---|
| F1 | Artifacts **Plans** tab |
| F2 | Artifacts **search** |
| F3 | Artifacts **Jump to message** (C2 `.message`) |
| F4 | Artifacts **Attach to message** (C3 `attach`) |
| F5 | Artifacts **expiry display** (hosted pages + agent-sent files) |
| F6 | **Agent-sent file notice** (`send_file` with `notify:true` → `agentFile` bus event) with Save / Share |
| F7 | **Webhooks card** in the chat overflow; **secrets "shared" scope** (F7b) |

---

## 0. What iOS has today (do not duplicate)

- `ArtifactsCard` (`MantaUI/SessionResourceCards.swift:370-641`): sheet with a
  Files · Images · Links segmented control (`:443-453`), day-grouped list
  (`:455-466`), 3 s poll while open (`:425-430`), tap → QuickLook via
  `/api/peek` staging (`:484-534`), long-press → Share / Copy path (`:536-557`).
  Loads `api.messages`, `api.servePageList()`, `api.listOutbox` (`:468-482`).
- `ArtifactDerivation` (`MantaUI/ArtifactDerivation.swift`): a port of the
  desktop `deriveArtifacts`, **but** it lacks: the `plan` kind, `messageId`,
  link `context`, `isHosted`, the plan-page exclusion from Links, the outbox
  row's `messageID`, and the video extensions. Expiry is only shown when
  ≤ 48 h (`ArtifactFormat.ageOrExpiry`, `:282-293`) — the desktop always shows
  a pill on hosted pages and outbox files.
- `PlanDerivation` (`MantaUI/PlanDerivation.swift`, not owned by anyone; read
  only here): already ports `planRefsFromPart` (`:82`), `planSubdomain`
  (`:182`) and `planPageURL(sessionID:baseURL:)` (`:193`). **Reuse them.**
  Its `planMetrics` (`:162`) is the plan *card's* rule, NOT the desktop
  Plans-tab step rule — do not reuse it for F1.
- `SecretsCard` + `SecretAddForm` (`SessionResourceCards.swift:134-346`):
  scope picker offers only `session` / `project` (`:295-298`), default
  `session` (`:269`), always sends `sessionID` (`:339`). Row shows raw scope.
- `ChatOverflowSheet` (`MantaUI/ChatOverflowSheet.swift:389-590`): rows
  Scheduled tasks / Secrets / Artifacts / Background jobs. No webhooks row.
- `MantaAPIClient`: `listOutbox` (`:442`) decodes `OutboxFile`
  (`MantaModels.swift:444`, **no `messageID`**), `servePageList` (`:450`),
  `peekFile(path:)` (`:559`), `downloadOutboxFile(path:)` (`:596`),
  `upload(project:filename:data:)` (`:378`), `setSecret` (`:430`). No
  `webhook:*` methods.
- `MantaEventStore.addRawFrameHandler(_:)` (`MantaEventStore.swift:464`) —
  every non-`stream`, non-`runningSet` frame (e.g. `kind:"agentFile"`) reaches
  registered handlers (`:576`). Used by `UpgradeStore`, `WidgetLiveStore`,
  `SessionListStore`, `ChatModelPrefs`. **F6 uses this; it does not edit
  `MantaEventStore.swift`.**

---

## F1 — Plans tab

### Desktop behaviour
- Tab bar is Links · Images · Files · **Plans**, each with a count
  (`src/renderer/ArtifactsPanel.tsx:163-169`, `:909-937`).
- A plan artifact is derived from any `.opencode/plans/*.md` reference in any
  non-synthetic, non-ignored part (text, authoring-tool input
  `filePath|path|planPath`, patch `files`) (`src/renderer/artifacts.ts:365-380`,
  `src/renderer/chatUtils.ts:2638-2678`).
  - id `plan:<rel lowercased>`, key `<rel lowercased>`, `origin: "agent"`,
    `mime: "text/markdown"`, `href = cwd + "/" + rel` (`joinHref`, `:210-213`),
    `at` = owning message created, `messageId` = owning message
    (`artifacts.ts:227-266`).
  - label = filename without `.md`, without a leading `YYYY-MM-DD-`, `-`/`_`
    → spaces, trimmed (`planTitleFromPath`, `:180-185`).
  - step count = number of lines matching `^#{2,3}\s+.+$` (multiline) in the
    part's text, else the authoring tool input's `content`, else the joined text
    of the message (`planStepCount` `:190-193`, `partAnnounceText` `:271-280`).
  - status = `planStatus({})` → always `"draft"` today (`:199-208`, `:257`).
  - `pageUrl` = the `serve-page:list` row whose `subdomain == planSubdomain(sessionId)`
    AND `sessionID == sessionId` (`:240-243`).
  - Same plan referenced several times → newest `at` wins (`:375-377`).
- The plan's auto-published page (`subdomain == planSubdomain(sessionId)`) is
  **not** also listed under Links (`:384-388`).
- Row (`ArtifactsPanel.tsx:516-585`): plan icon, title + status pill
  (`draft`/`approved`/`building`/`done`), subline `N step(s)` or `plan`.
  Actions: **Open published page** (`pageUrl` else deterministic
  `planPageUrl(sessionId, serverBase())`, opened externally; failure → inline
  dismissible error, `:739-748`, `:948-961`), **Open plan file** (preview),
  "Open implementing session" is passed `null` → not rendered (`:999-1001`).
- Row tap = open published page (`openRow`, `:758-761`).
- Empty: "No plans yet" / "N links, N images, N files" (`:196-208`).

### Wire contract
Unchanged from today's card: `opencode:messages` (`api.messages`),
`serve-page:list` → `ServedPageMeta[]` (`src/server/rpc.mjs:2529`), and
`GET /api/peek?path=<abs>` (bearer) for "Open plan file". No new channel.

### iOS design
- `ArtifactKind` gains `.plan`. Segments become
  **Files · Images · Links · Plans** (keep the existing iOS order + default
  `.file`; append Plans). Label `"Plans \(count)"`.
- `Artifact` gains: `messageID: String?`, `context: String?`,
  `isHosted: Bool`, `dedupeKey: String`, `planStepCount: Int?`,
  `planStatus: ArtifactPlanStatus?` (`draft|approved|building|done`),
  `pageURL: String?`.
- `ArtifactDerivation.derive(messages:pages:sessionId:outbox:cwd:)` — `cwd:
  String? = nil` added; plan pass ported line-for-line from
  `artifacts.ts:365-380` using `PlanDerivation.planRefsFromPart` and
  `PlanDerivation.planSubdomain`. Dedupe switches from `href.lowercased()` to
  `dedupeKey` (desktop `key`) so a plan's key is its rel path, not the
  cwd-joined href.
- New `ArtifactDerivation.planTitle(fromPath:)` and
  `ArtifactDerivation.planStepCount(_ text: String?) -> Int` (desktop rule
  exactly; `0` when nil/empty).
- Plan row (in `ArtifactsCard`): `list.clipboard` glyph, title (middle-truncated),
  trailing status capsule (`draft` = `tokens.tx3` on fill; `approved` = warn;
  `building` = accent; `done` = ok), subline `"3 steps"` / `"1 step"` / `"plan"`.
  - Tap → open the published page: `ArtifactPlanLink.pageURL(artifact:sessionId:serverURL:)`
    (artifact `pageURL`, else `PlanDerivation.planPageURL(sessionID:baseURL: api.serverURL)`),
    `UIApplication.shared.open(url) { ok in … }`; `ok == false` or no URL →
    the card's inline error banner: **"Couldn't open the plan page."**
  - Context menu: **Open published page** · **Open plan file** (only when
    `cwd` is non-nil; stages via `/api/peek` then QuickLook, same path as files)
    · **Copy path**. No "implementing session" action (desktop renders none).
- Staging fix: `ArtifactsCard.tempURL(for:)` must take the extension from the
  **href's** last path segment when the label has none (a plan's label is a
  title, so `.md` would be lost and QuickLook would not recognise the file).
- Empty Plans tab: `ContentUnavailableView("No plans yet", systemImage:
  "list.clipboard", description: Text(ArtifactEmptyCopy.sub(.plan, counts)))`
  → "2 links, 0 images, 3 files". Apply the same per-tab copy to the other three
  tabs ("No links yet" / "No images yet" / "No files yet" + the other counts),
  replacing the single "No artifacts" state (keep its
  `accessibilityIdentifier("artifacts-empty")`).
- Inline error banner (shared by F1/F4 and by EVERY preview): a dismissible red
  row at the top of the list (`Section` with the message + an `xmark` button,
  `accessibilityIdentifier("artifacts-error")`). The card stays open; the
  failed row is untouched, so tapping it again retries.
- **Preview / staging failures are never silent** (applies to file, image and
  plan-file previews, not only to plans). `presentPreview` today returns
  silently when `stage` yields nil (`SessionResourceCards.swift:500-506`,
  `:519-534`); it must instead set the banner from
  `ArtifactStagingError.message(_:name:)`:
  - box file missing / 404 / 403 → **"Couldn't open <name> — it may no longer be on the box."**
  - malformed `data:` URI → **"Couldn't open <name> — the file data is damaged."**
  - remote URL non-2xx / network error → **"Couldn't download <name> from <host>."**
  - writing the temp file failed → **"Couldn't prepare <name> for preview."**
  `stage` therefore returns `Result<URL, ArtifactStagingError>` (cases
  `.missing`, `.badDataURI`, `.remote(host: String)`, `.write`), not `URL?`.
- **Byte source routing** for staging, used by preview, Share and Attach: see
  F4 "Byte resolution" — the same three-branch resolver.

---

## F2 — Search

### Desktop behaviour
- Header search toggle → input `placeholder="Search links & files…"`
  (`ArtifactsPanel.tsx:840-857`).
- Filters the **current tab** by case-insensitive substring of `label` OR
  `href` (`:699-705`). Tab badges show live match counts for links/files/plans
  and a flat 0 for images while a query is active (`:711-722`).
- No match: `No matches for “<query>”` (`:964-965`).
- Query is cleared on session change (`:665-671`).

### Wire contract
None (client-side filter over the derived list).

### iOS design
- `.searchable(text: $query, placement: .navigationBarDrawer(displayMode:
  .automatic), prompt: "Search links & files")` on the card's
  `NavigationStack` content.
- Pure `ArtifactSearch.filter(_ items: [Artifact], query: String) -> [Artifact]`
  (trimmed query; empty → unchanged) and
  `ArtifactSearch.counts(_ items:, query:) -> ArtifactCounts` (per-kind match
  counts). **Deliberate deviation:** the Images badge shows its real match
  count (the desktop's hard 0 is an artefact of images not being labelled, not
  a behaviour); the image list itself is filtered exactly as on desktop.
- Segment labels use `ArtifactSearch.counts` while a query is active.
- No match in the current tab: `ContentUnavailableView.search(text: query)`.
- The 3 s poll keeps running while searching; the filter re-applies.

---

## F3 — Jump to message

### Desktop behaviour
- File rows and image tiles: **Jump to message** action, disabled when
  `messageId` is null (`ArtifactsPanel.tsx:250-270`, `:265-267`). Link cards
  carry it in the context strip (`:354-371`).
- `messageId` sources (`artifacts.ts`): file part → owning message (`:87`);
  link → owning message (`:111`); hosted page → newest **assistant** message
  whose joined text contains the page URL (`:300-314`, `:293`); outbox row →
  `row.messageID` from the file's sidecar, stamped by `send_file`
  (`:165`, `src/server/outbox.mjs:125-126`, `src/server/index.mjs:4179-4196`);
  plan → owning message (`:254`).
- Click dispatches `manta-scroll-to-message {sessionId, messageId}`
  (`:778-785`) — the chat scrolls to and flashes the message.

### Wire contract
- `outbox:list` rows carry `messageID: string | null` (`src/shared/types.ts:2200-2210`,
  `src/server/outbox.mjs:113-145`). The iOS `OutboxFile` drops it; WS07 adds
  its own wire type (below) instead of editing `MantaModels.swift`.
- Navigation: C2 `MantaRoute.message(sessionID:messageID:)` (handled by WS02).

### iOS design
- New wire type `ArtifactOutboxRow` (in `ArtifactModels.swift`):
  `path, name, size, sessionID?, mtime?, expiresAt?, messageID?, media?` (all
  optional except `path`/`name`/`size`, matching `statRow`). Convenience
  `init(_ file: OutboxFile)` (messageID nil) so existing tests adapt.
- C1: `MantaAPIClient+Artifacts.swift` adds
  `func listOutboxRows(sessionId: String) async throws -> [ArtifactOutboxRow]`
  → `call("outbox:list", args: [sessionId], …) ?? []`. The card uses it
  instead of `listOutbox`.
- Derivation fills `messageID` for all sources as above, including the
  page's newest-announcing-assistant-message rule and the link/page `context`
  (whitespace collapsed, trimmed, URL's first occurrence removed for links,
  hard-capped at 160 characters — `artifacts.ts:42-50`, `:294`).
- `ArtifactsCard` gains `var onJumpToMessage: ((String) -> Void)? = nil`.
  - Context menu item **Jump to message** (`arrow.turn.down.right`) on every
    row kind, rendered **only** when `onJumpToMessage != nil &&
    artifact.messageID != nil` (`ArtifactActions.canJump`).
  - Link rows show `context` as a second caption line (2-line limit) when
    present.
  - Action: call `onJumpToMessage(messageID)`; the closure (ChatScreen) closes
    the card and then opens `.message(sessionID: store.sessionId,
    messageID:)` (see Mount requests). The card itself never navigates.

---

## F4 — Attach to message

### Desktop behaviour
- **Attach to message** on image tiles, file rows and the preview overlay
  (`ArtifactsPanel.tsx:265`, `:1017`, `:1042`). Not on links or plans.
- `attachArtifact` (`:131-144`): resolve the bytes (data URI decoded, remote
  URL fetched, box path via `/api/peek`), wrap in a `File`, dispatch
  `manta-attach-files` → the composer's normal upload pipeline (chip
  uploading → ready → FilePart on submit). Failure is swallowed (a known
  desktop defect; iOS must report it).

### Wire contract
- `GET /api/peek?path=<abs>` (bearer) → bytes; `403 path outside home
  directory`, `404` (`src/server/index.mjs:3725-3755`).
- `POST /api/upload?session=<project>` → `{path}` (existing
  `api.upload(project:filename:data:)`).
- C3: `@discardableResult ComposerTextController.attach(remotePath:displayName:mime:) -> Bool`
  (WS03 `ComposerTextController.swift`; returns `false` for a duplicate path,
  a non-absolute path or a composer that cannot take attachments).
- Remote URLs: a plain `GET <href>` with **no** box credentials (desktop
  `artifactToBlob`, `ArtifactsPanel.tsx:69-78`).

### Byte resolution (shared by preview, Share and Attach)
Desktop `artifactToBlob` (`ArtifactsPanel.tsx:58-87`) has three branches; iOS
today has two and sends an `http(s)` href to `/api/peek`
(`SessionResourceCards.swift:519-532`), which can never succeed. Pure
classifier in `ArtifactDerivation.swift`:

```swift
enum ArtifactByteSource: Equatable, Sendable {
  case dataURI(String)        // href starts with "data:" (case-insensitive)
  case remote(URL)            // scheme http / https, host non-empty
  case boxPath(String)        // absolute path ("/…" or "~/…")
  case unsupported            // anything else (relative path, other scheme, empty)
  static func classify(_ href: String) -> ArtifactByteSource
}
```

Resolver `ArtifactBytes.load(_ source:, api:, remote:) async -> Result<Data, ArtifactStagingError>`
(in `ArtifactsCard`'s file, UIKit-free but needs `MantaAPIClient`):
- `.dataURI` → existing `decodeDataURI` (moved into `ArtifactDerivation.swift`
  as `ArtifactDataURI.decode(_:)` so it is package-testable); nil → `.badDataURI`.
- `.remote(url)` → `remote(url)`: a dedicated `URLSession(configuration:
  .ephemeral)` request built fresh with **no `Authorization` header and no
  cookies** (`httpShouldSetCookies = false`), 30 s timeout. The box token is
  never sent to a non-box origin — the request is NOT built through
  `MantaAPIClient` or its `session`. Only a 2xx `HTTPURLResponse` is success;
  anything else → `.remote(host:)`. Injected as a closure so tests can stub it.
- `.boxPath(p)` → `api.peekFile(path: p)`; throws → `.missing`.
- `.unsupported` → `.missing`.
- The tap-to-open rule is unchanged for `.link` artifacts (they open in the
  browser); the remote branch matters for `.file` / `.image` artifacts whose
  file part `url` is an `http(s)` URL.

### iOS design
- `ArtifactsCard` gains `var projectName: String? = nil` and
  `var composer: ComposerTextController? = nil` (passed explicitly by ChatScreen,
  M-07-1 — not read from the environment, so the sheet does not depend on where
  WS03's `.environment(\.composerController, …)` sits relative to the `.sheet`
  modifier).
- Context menu **Attach to message** (`paperclip`) on `.file`/`.image` rows
  only, rendered only when `composer != nil && projectName != nil`
  (`ArtifactActions.canAttach(kind:hasComposer:hasProject:)`), so read-only
  surfaces never show a dead control (WS03 rule).
- Flow (row spinner while running; same `staging` set; a second tap on a row
  that is already working is ignored):
  1. Bytes: reuse `stagedFiles[id]` if present, else `ArtifactBytes.load`
     (three branches above).
  2. Upload a fresh copy: `api.upload(project: projectName, filename:
     ArtifactAttach.filename(for: artifact), data:)` — a fresh copy is used (as
     on desktop) because the original may be an old upload or an outbox file
     the box sweeps before the message is sent, or a remote URL the box cannot
     read at all.
  3. `let ok = composer.attach(remotePath:, displayName: artifact.label, mime: artifact.mime)`.
     `ok == true` → `onClose()`; the ready chip in the composer is the visible
     success. `ok == false` → banner **"<name> couldn't be added to the message."**
     (C3 rule: a rejection is always surfaced.)
- Failures → the inline error banner, card stays open:
  - staging error → **"Couldn't attach <name> — " + the F1 staging reason**
    (e.g. "it may no longer be on the box." / "couldn't download it from <host>.")
  - upload throws → **"Couldn't attach <name> — the upload to the box failed."**
- `ArtifactAttach.filename(for:)`: label if it has an extension, else label +
  extension from the href's last path segment (plans never reach here).

---

## F5 — Expiry display

### Desktop behaviour
- Hosted pages (`isHosted`) always show a pill: `expired` (danger), `<N>h`
  (soon = ≤ 6 h → warn, else ok), or `no expiry` when `expiresAt` is null
  (`ArtifactsPanel.tsx:274-288`, `:335-346`). Expired link cards render at 50 %
  opacity (`:308`).
- Outbox files with an `expiresAt` show the same pill; no pill when null
  (`:441-467`).
- `pageState` (`artifacts.ts:444-452`): null → nil; `≤ now` → expired;
  `≤ 6 h` → soon; else live. `expiryLabel` (`chatUtils.ts:451-455`): whole
  hours floored, minimum `1h`.

### Wire contract
`ServedPageMeta.expiresAt` (ms, nullable), outbox `expiresAt` (ms, nullable).
Already decoded.

### iOS design
- Pure `ArtifactExpiry`:
  - `state(expiresAt: Date?, now: Date) -> ArtifactExpiryState?` (`.live`,
    `.soon`, `.expired`; 6 h threshold, desktop rule).
  - `label(_ artifact: Artifact, now: Date) -> String?`:
    hosted + nil expiry → `"no expiry"`; expired → `"expired"`;
    remaining < 48 h → `"expires in \(max(1, floor(h)))h"`;
    else `"expires in \(floor(d))d"`; non-hosted with nil expiry → nil.
    (Behavioural parity with the desktop pill; the day form replaces the
    desktop's unreadable "167h".)
- Row: trailing capsule with that label, tone ok / warn / danger
  (`Theme.swift` tokens), only for hosted pages and outbox files.
  Expired rows: `.opacity(0.5)`, still tappable (desktop does not block).
- `ArtifactFormat.secondaryLine` stops appending expiry
  (`ageOrExpiry` → plain `relativeAge`); the pill owns expiry.
  Update/replace `ageOrExpiry` accordingly (delete it if unused).

---

## F6 — Agent-sent file notice (Save / Share)

### Desktop behaviour
- `send_file` → `POST /api/outbox/push {filePath, sessionID, ttlHours?,
  messageID?, notify?}`; `notify:true` stores `announce:true` in the sidecar
  (`src/server/index.mjs:4172-4196`).
- The box's 3 s outbox scanner publishes ONE `agentFile` bus event per file,
  only when `announce === true`, not `media`, and never announced before; it
  records `announcedAt` first so a restart never re-announces
  (`src/server/outbox.mjs:283-327`). Delivered on `/events` as
  `{"kind":"agentFile","payload":{remotePath,name,size,sessionName,autoPulled:false}}`
  — `sessionName` is actually the **opencode session id** (or null for a
  root-level file) (`outbox.mjs:309-317`, `src/shared/types.ts:2657-2670`).
- Desktop (`src/renderer/App.tsx:1019-1025`, `src/renderer/GlobalToasts.tsx:62-134`):
  one global toast, newest replaces older, no auto-dismiss (it has actions,
  `src/renderer/Toast.tsx:63-68`). Copy: `↓ <name> · <size> — AI sent you a
  file` with **Save** (`Saving…` while busy). Success → `✓ <name> · saved to
  <folder>` + Reveal. Failure keeps the toast and shows "Download failed — tap
  Save to retry". Download is non-destructive (file stays until TTL).

### Wire contract
- Event: `kind:"agentFile"` on `GET /events` (no `sub`; not a C5 stream frame).
  Payload decoded into `AgentFileEvent { remotePath: String, name: String,
  size: Int, sessionID: String? (from "sessionName"), autoPulled: Bool }`.
  Missing/empty `remotePath` → ignored. `name` empty → last path segment.
- Bytes: `GET /api/download?path=<remotePath>` (bearer, home-scoped, existing
  `api.downloadOutboxFile(path:)`).
- No server change. (Known limitation shared with desktop: an event fired
  while the phone is disconnected is not replayed — the file is still in the
  Artifacts card.)

### iOS design

Three layers, split so the race-prone part is a pure, Linux-testable value
type (D19) and the UIKit part stays thin.

**1. Pure model — `ArtifactAgentFileModel.swift` (Foundation only, in `Package.swift`).**

- `AgentFileEvent: Equatable, Sendable` + `static func from(_ frame: MantaStreamFrame) -> AgentFileEvent?`
  (`kind == "agentFile"` + `decodedPayload`; `sessionName` → `sessionID`).
- `AgentFileNoticeCopy`:
  - `title(event)` → `"report.pdf"`;
  - `detail(event, sessionTitle: String?)` → `"62 KB · AI sent you a file"`
    (size omitted when 0), plus `" · in <sessionTitle>"` when resolved;
  - `savedTitle(event)` → `"Saved report.pdf"`;
  - `failure(event)` → `"Couldn't download report.pdf — it's still on the box, try again."`
  - `pendingBadge(count)` → `"+1 more"` / `"+2 more"` (nil for 0).
- `AgentFileNoticeMachine` — a `struct` state machine. Every notice carries an
  immutable `token: UInt64` (monotonic generation, assigned on arrival); every
  asynchronous operation captures the `(token, opID)` it started with and every
  completion is a no-op unless BOTH still match.

  ```swift
  struct AgentFileNotice: Equatable, Sendable {
    let token: UInt64
    let event: AgentFileEvent
    var phase: Phase
    enum Op: Equatable, Sendable { case save, share }
    enum Phase: Equatable, Sendable {
      case idle
      case downloading(Op, opID: UInt64)
      case presenting(Op, opID: UInt64, fileURL: URL)   // exporter / share sheet is up
      case saved(opID: UInt64)                          // 2 s confirmation
      case failed(String)
    }
  }
  struct AgentFileNoticeMachine: Equatable, Sendable {
    private(set) var current: AgentFileNotice?
    private(set) var queued: [AgentFileEvent]           // arrivals while `current` is busy
    mutating func receive(_ e: AgentFileEvent)
    mutating func begin(_ op: Op) -> (token: UInt64, opID: UInt64)?      // nil = refused
    mutating func downloadFinished(token:, opID:, result: Result<URL, AgentFileFailure>) -> Effect
    mutating func presentationFinished(token:, opID:, completed: Bool) -> Effect
    mutating func savedTimerFired(token:, opID:)
    mutating func dismiss() -> Effect
  }
  enum Effect: Equatable { case none, deleteTemp(URL), scheduleSavedTimer(token: UInt64, opID: UInt64) }
  ```

  Rules (all pinned by tests):
  - **Arrival.** `current == nil`, `.idle` or `.failed` → the new event becomes
    `current` (newest wins, desktop parity) with a fresh token. `current` is
    `.downloading`, `.presenting` or `.saved` → the event is appended to
    `queued` and the visible notice gains the `"+N more"` badge; it never
    replaces a notice whose operation is in flight. Duplicate `remotePath`
    already current or queued → ignored.
  - **Re-entrancy.** `begin` is refused (returns nil, no state change) unless
    `current` is `.idle` or `.failed`. The UI disables both buttons for every
    other phase, so a double tap or Save-then-Share cannot start two downloads.
  - **Download finished.** Token/opID mismatch (the notice was dismissed or
    replaced) → `.deleteTemp(url)` on success, nothing else. Match + failure →
    `.failed(copy)`. Match + success → `.presenting(op, opID, url)`.
  - **Presentation finished** (exporter picked / cancelled, share completed /
    cancelled). Mismatch → `.deleteTemp`. Match: save + completed → `.saved`
    and `.scheduleSavedTimer`; share + completed → notice closes (promote);
    cancelled → `.idle` (notice stays, retry possible). Temp file deleted in
    every match case except `.saved` (deleted when the notice closes).
  - **Saved timer.** Fires 2 s later; closes the notice ONLY if `current`
    still has that token and is `.saved(opID)` with the same opID — a later
    notice is never closed by an older timer.
  - **Dismiss** (× or timer close). Clears `current` and promotes the first
    `queued` event (fresh token, `.idle`); returns `.deleteTemp` for any
    staged file. Dismiss during `.downloading` is allowed: the late completion
    then mismatches and only deletes its temp file. Dismiss is disabled while
    `.presenting` (the picker / share sheet is on top anyway).
  - **Promotion.** Whenever `current` closes, the oldest queued event becomes
    current; the queue is capped at 5 (oldest dropped — every file is still
    listed in the Artifacts card).

**2. Store — `ArtifactAgentFile.swift` (UIKit app target only).**
`@MainActor final class ArtifactAgentFileStore: ObservableObject` (no
singleton): `@Published private(set) var machine: AgentFileNoticeMachine`;
`init(download: @escaping @Sendable (String) async throws -> Data =
<api.downloadOutboxFile>, tempRoot: URL = FileManager.default.temporaryDirectory,
sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) })`.
- `bind(eventStore:)` — idempotent (`bound` flag); registers
  `addRawFrameHandler { [weak self] f in if let e = AgentFileEvent.from(f) { self?.receive(e) } }`.
- `save()` / `share()` → `machine.begin`; `Task { data = await download(path) }`;
  writes `tempRoot/manta-agentfile/<UUID>/<name>` (real filename for Files /
  share sheet); hands the result to `machine.downloadFinished(token:opID:…)`
  and executes the returned `Effect`.
- `presentationFinished(token:opID:completed:)`, `dismiss()` — forward to the
  machine, execute effects (`.scheduleSavedTimer` → `Task { await sleep(.seconds(2)); savedTimerFired(...) }`).
- Haptic on save success: `SessionHaptics.fire(.success, enabled: hapticsEnabled)`
  (existing helper, `SessionListView.swift:1009-1023`) where `hapticsEnabled`
  is read from the `SessionListStore` passed in by the view
  (`SessionListStore.hapticsEnabled`, `:71`). No haptic when the setting is off.

**3. View — `ArtifactAgentFileNotice` (same file).**
- Bottom floating card (system material, `Metrics` spacing, `Theme` tokens),
  `arrow.down.doc` glyph, title + detail (+ `"+N more"`), buttons **Save** and
  **Share** (each shows a `ProgressView` + "Saving…" / "Preparing…" while its
  op is downloading; both disabled unless `.idle`/`.failed`), × **Dismiss**
  (disabled while `.presenting`). `.failed` shows the failure copy in the
  danger tone with buttons enabled (retry is safe — download is
  non-destructive). `.saved` shows **"Saved report.pdf"**.
- Owns `@StateObject` store; `@EnvironmentObject MantaEventStore` +
  `SessionListStore` (session title = window name whose `opencodeSessionId ==
  event.sessionID`; haptics flag). `.task { store.bind(eventStore:) }`.
- **Presentation** of the exporter / share sheet is done in UIKit from the
  top-most presented view controller of the window that hosts the notice
  (`ArtifactPresenter.topMost(from: view.window)` — walks
  `rootViewController.presentedViewController`), NOT via a SwiftUI `.sheet` on
  the root overlay — a second SwiftUI presentation on `MantaAppRoot` would
  collide with the session list's own `.sheet` / `.fullScreenCover`
  (`SessionListView.swift:146-158`). `UIDocumentPickerViewController(forExporting:
  [url], asCopy: true)` delegate → `presentationFinished(completed: !urls.isEmpty)`
  / `documentPickerWasCancelled` → `completed: false`;
  `UIActivityViewController.completionWithItemsHandler` → `completed`. Each
  completion passes the `(token, opID)` captured when it was presented.
- No auto-dismiss while idle (desktop parity: the toast has actions).
- `accessibilityIdentifier("agent-file-notice")`; VoiceOver announcement on
  arrival (`AccessibilityNotification.Announcement("AI sent you a file: <name>")`).

**Modal behaviour (where the notice is visible).**
The notice is an overlay on the paired root (M-07-3). It is visible over the
session list and over any pushed chat (both live inside that root's
navigation stack). It is NOT drawn over a modal presented above the root —
Settings (`fullScreenCover`, `SessionListView.swift:157-158`), the create /
rename sheets, or a chat's overflow / resource sheets. In those cases the
event is **not lost**: the store keeps it (`current` / `queued`), and the
notice becomes visible the moment the modal closes, still `.idle`, still
actionable. The VoiceOver announcement still fires on arrival. A global
window-level host was considered and rejected: it would need a second
`UIWindow` owned outside every workstream's files, for a banner the user sees
seconds later anyway.

- Mounted once, globally (M-07-3) — the notice appears on the session list and
  inside any chat, like the desktop's global toast, and after any modal closes.

---

## F7 — Webhooks card

### Desktop behaviour (`src/renderer/PanelCards.tsx:113-213`)
- Opened from the composer toolbar 🪝 button ("View / revoke inbound webhooks
  (external events that wake this session)", `ComposerParts.tsx:223-228`).
- Header "Webhooks · N". Empty: "No webhooks in this session. Ask the agent to
  create one (e.g. “have Multica ping this session when the task finishes”)."
- Row: label; red `unsigned` badge (title "No signature required — anyone with
  the URL can trigger this hook"); delivery URL without scheme, click =
  copy, shows `copied!` for 1.5 s; `· <localized datetime> · N×` or
  `· never fired`; **Revoke** button (title "Revoke this webhook (further
  POSTs will 404)"), no confirm.
- Revoke: optimistic remove → `webhook:delete` → refetch; error → message in
  the card + refetch (`src/renderer/ChatPanel.tsx:3267-3281`).
- Data: refetch on open (`src/renderer/hooks/useSessionResources.ts:186-191`).
  Creation is the AI's job only — no create UI.

### Wire contract
- `webhook:list` — `args: [sessionId]` → `WebhookMeta[]`
  (`src/server/rpc.mjs:2516`, `src/server/webhooks.mjs:458-462`, `toMeta`
  `:275-288`): `{id, provider, label, url: string|null, unsigned: bool,
  sessionID: string|null, instructions: string, createdAt: number|null,
  lastDeliveredAt: number|null, deliveries: number}`. Never contains the
  signing secret or token.
- `webhook:delete` — `args: [id]` → `{ok:true, deleted:boolean}`
  (`rpc.mjs:2518`, `webhooks.mjs:446-454`); `deleted:false` = already gone
  (treat as success). Publishes `webhook.updated` (not consumed here —
  desktop is refetch-driven too).
- C1: `MantaAPIClient+Artifacts.swift` adds
  `listWebhooks(sessionId:) -> [WebhookMeta]` and `deleteWebhook(id:)`.

### iOS design
- `WebhookModels.swift` (pure): `struct WebhookMeta: Decodable, Equatable,
  Sendable, Identifiable` (all fields above; `provider`/`instructions`
  optional for older boxes) and `WebhookFormat`:
  - `lastDelivery(_ hook:) -> String` → `"never fired"` or
    `"<date, abbreviated date + short time> · 3×"`;
  - `displayURL(_ url: String?) -> String?` → scheme stripped.
- `WebhooksCard` (new file `WebhooksCard.swift`), stock
  `NavigationStack` + `List(.insetGrouped)`, same shape as `SchedulesCard`:
  - title "Webhooks", **Done** button; loading `ProgressView`; failure
    "Couldn't load webhooks." + **Retry** button.
  - Empty: `ContentUnavailableView("No webhooks", systemImage:
    "point.3.connected.trianglepath.dotted", description: Text("Ask the agent to
    create one — for example, “have Multica ping this session when the task
    finishes”."))`.
  - Row: label (or "Untitled webhook"); trailing red capsule **Unsigned**
    when `unsigned` (`accessibilityHint("No signature required — anyone with
    the URL can trigger this hook")`); monospaced caption of the display URL;
    caption `Last delivery: …`.
  - Tap row (when `url != nil`) → `UIPasteboard.general.string = url`; the
    URL caption reads **"Copied"** for 1.5 s (that text is the confirmation,
    so it is shown whether or not haptics are on); haptic via
    `SessionHaptics.fire(.selection, enabled: sessionStore.hapticsEnabled)`
    (`@EnvironmentObject SessionListStore`, inherited by the sheet — the same
    gate every existing caller uses, `SessionListView.swift:106-108`). With
    haptics off the copy is silent. No URL → caption
    "No delivery URL" and the row is not tappable.
  - Context menu: **Copy delivery URL** (when url), **Revoke** (destructive).
  - Swipe trailing **Revoke** (destructive, `trash`) — swipe is the
    confirmation gesture, matching `SchedulesCard` and the desktop's
    no-confirm Revoke.
  - Revoke: optimistic removal → `deleteWebhook` → reload. Error → reload and
    show an inline red row "Couldn't revoke <label> — <message>".
- Overflow row **Webhooks** (`point.3.connected.trianglepath.dotted`) in the
  first section after Secrets; no count badge (desktop has none). Shown only
  when the new `var onWebhooks: (() -> Void)? = nil` is non-nil (wired by
  M-07-2).
- `MantaAPIClient` is created inside the card as the other cards do
  (`MantaAPIClient.live()`); `WebhooksCard` takes `api` as an init parameter
  defaulted to `.live()` so previews/tests can pass a stub.

## F7b — Secrets "shared" scope

### Desktop behaviour (`PanelCards.tsx:240-330`, `SecretEditor.tsx:23-25`)
- Scope select: **shared** (default) / **this project** / **this session**,
  title "shared = every session · project = every chat in this workspace ·
  session = only this chat".
- `sessionID` sent for session AND project scope (server resolves the project
  name from it), `null` for shared (`PanelCards.tsx:300-301`).
- Row badge: `shared` / `project:<name>` / `session`.

### Wire contract
`secrets:set {key, value, scope:"shared"|"project"|"session", sessionID?,
project?, hint?}` (`rpc.mjs:2495-2500`, `src/server/secrets.mjs:203-231`:
shared ignores sessionID; session requires it; project requires a resolvable
project). `secrets:list(sessionId)` returns session + project + shared
visible secrets (`rpc.mjs:2490-2493`, `secrets.mjs:81-108`).

### iOS design
- Pure `SecretScopeOption` (in `WebhookModels.swift` under a
  `// MARK: - Secrets scope` section, to stay inside WS07's `Webhook*` new-file
  prefix; Foundation-only): `.shared/.project/.session`, `title` ("Shared — every session" /
  "This project" / "This session"), `wireScope`, and
  `static func input(key:value:scope:sessionId:hint:) -> SecretInput`
  (sessionID nil for shared). `static func badge(_ meta: SecretMeta) ->
  String` → `shared` / `project:<name or ?>` / `session`.
- `SecretAddForm`: picker gains **Shared — every session** first; default
  `.shared` (desktop parity); footer under the picker: "Shared secrets are
  available to every session on this box. Project: every chat in this
  workspace. Session: only this chat."
- `SecretsCard.detail` uses `SecretScopeOption.badge`.
- While here: `SecretsCard.delete` currently swallows a failure
  (`SessionResourceCards.swift:206-210`) — surface "Couldn't delete <key>." as an
  inline red row (no-dead-controls rule).

---

## Pure logic + tests (C7, D19)

Tests are split by what they compile against (finding 3). `Package.swift`
compiles an explicit list of Foundation-only sources and does NOT contain
`MantaAPIClient` (it depends on the Keychain store, `MantaAPIClient.swift:8-21`)
or any SwiftUI/UIKit/Combine file. So:

**Package-safe (Linux `verify.sh` + Mac `test-unit`)** — pure files only:

`MantaUITests/ArtifactDerivationTests.swift` (extend; adapt existing outbox
tests via `ArtifactOutboxRow(OutboxFile)`):
1. plan from a user text part mentioning `.opencode/plans/2026-10-28-ship-it.md`
   → kind `.plan`, label "ship it", href `"/repo/.opencode/plans/…"` with `cwd:
   "/repo"`, `messageID` set, status `.draft`.
2. plan from a `write` tool part `state.input.filePath`; a `read` tool part
   yields nothing.
3. same plan in two messages → one artifact, newest `at`.
4. `planStepCount`: `"## A\n### B\n#### C\ntext"` → 2; nil/"" → 0.
5. plan `pageURL` set only when the page's `sessionID` matches; plan subdomain
   page is NOT emitted as a link; another page still is.
6. hosted page `messageID`/`context` from the newest assistant message
   containing the URL; user message containing it is ignored.
7. link `context` removes the URL, collapses whitespace, caps at 160.
8. outbox `messageID` carried through; `.mp4` → `video/mp4`, kind `.file`.
9. `ArtifactCounts` counts plans.
10. dedupe uses `dedupeKey` (plan rel path vs cwd-joined href).

`MantaUITests/ArtifactPresentationTests.swift` (new):
- `ArtifactExpiry.state` (nil / expired / exactly 6 h → soon / 7 h → live);
  `ArtifactExpiry.label` (hosted nil → "no expiry", 30 min → "expires in 1h",
  5.9 h → "expires in 5h", 3.5 d → "expires in 3d", expired → "expired",
  non-hosted nil → nil).
- `ArtifactSearch.filter` (label match, href match, case-insensitive,
  whitespace-only query = all); `ArtifactSearch.counts`; `ArtifactEmptyCopy.sub`.
- `ArtifactActions.canAttach(kind:hasComposer:hasProject:)` (file/image only,
  false without composer or project), `canJump`, `canOpenPlanFile`.
- `ArtifactPlanLink.pageURL` (artifact URL wins, fallback deterministic, nil
  when neither); `ArtifactAttach.filename`;
  `ArtifactStaging.fileExtension(label:href:)` (plan title + `.md` href → `.md`).
- **Byte source routing (finding 1):** `ArtifactByteSource.classify` —
  `"data:image/png;base64,AAA"` → `.dataURI`; `"DATA:…"` → `.dataURI`;
  `"https://cdn.example.com/a.png"` → `.remote`; `"http://x/y"` → `.remote`;
  `"https://"` (no host) → `.unsupported`; `"/home/dev/.manta-outbox/s/a.pdf"`
  and `"~/a.pdf"` → `.boxPath`; `"relative/a.pdf"`, `"ftp://x/a"`, `""` →
  `.unsupported`. `ArtifactDataURI.decode` (base64, percent-encoded, missing
  comma → nil). `ArtifactStagingError.message` for every case.

`MantaUITests/ArtifactAgentFileTests.swift` (new; pure, against
`ArtifactAgentFileModel.swift`):
- `AgentFileEvent.from` decodes the exact desktop payload
  (`{"kind":"agentFile","payload":{"remotePath":…,"name":…,"size":…,"sessionName":"ses_1","autoPulled":false}}`);
  maps `sessionName` → `sessionID`; ignores `kind != "agentFile"`; nil on
  missing/empty `remotePath`; empty name → basename.
- Copy strings (with/without size, with/without session title, failure, saved,
  `+N more`).
- **Machine interleavings (finding 2)**, each a deterministic sequence of
  mutating calls:
  1. *A starts, B arrives, A finishes:* receive(A); begin(.save) → (tA, op1);
     receive(B) → B queued, current still A `.downloading`;
     downloadFinished(tA, op1, .success(u)) → A `.presenting`; B still queued.
  2. *Old picker completion after replacement:* A `.presenting` (tA, op1);
     dismiss() is refused while presenting → state unchanged; then
     presentationFinished(tA, op1, completed: true) → A `.saved`,
     effect `.scheduleSavedTimer(tA, op1)`.
  3. *Old success timer:* A `.saved`; dismiss() → B promoted with token tB;
     savedTimerFired(tA, op1) → B untouched (still `.idle`, still current).
  4. *Dismiss during download:* receive(A); begin(.share) → (tA, op1);
     dismiss() → current nil; downloadFinished(tA, op1, .success(u)) →
     effect `.deleteTemp(u)`, state unchanged.
  5. *Stale download for a re-arrived token:* begin twice → second `begin`
     returns nil (re-entrancy); a completion with a wrong opID is ignored.
  6. *Failure then retry:* downloadFinished(…, .failure) → `.failed(copy)`;
     begin(.save) allowed again with a new opID.
  7. *Idle replacement:* receive(A) (idle); receive(B) → B current, A dropped,
     token increases. Duplicate `remotePath` ignored. Queue cap 5.
  8. *Cancelled exporter:* presentationFinished(completed: false) → `.idle`,
     effect `.deleteTemp`.

`MantaUITests/WebhookTests.swift` (new; pure): decode `WebhookMeta` full +
nulls + missing `provider`/`instructions`; `WebhookFormat.lastDelivery`
(`deliveries == 0 && lastDeliveredAt == nil` → "never fired"; otherwise ends
with `· 3×`); `displayURL` strips `https://`/`http://`, nil passthrough.

`MantaUITests/SecretScopeTests.swift` (new; pure): shared input omits
`sessionID` (encode and inspect JSON); project/session include it; badges
(`shared`, `project:manta`, `project:?`, `session`).

**Xcode-only (Mac `test-unit`; NOT added to `Package.swift`):**

`MantaUITests/ArtifactAPITests.swift` (new): `MantaAPIClient.makeRequest(…
channel: "webhook:list", args: ["ses_1"])` → path `/rpc/webhook:list`, args
`["ses_1"]`; same for `webhook:delete` `["ab12cd34"]` and `outbox:list`
`["ses_1"]` (the channel `listOutboxRows` uses). A remote-fetch request built
by `ArtifactBytes.remoteRequest(for:)` carries **no `Authorization` header**
and `httpShouldHandleCookies == false`.

`MantaUITests/ArtifactAgentFileStoreTests.swift` (new, `@MainActor`): the
real store with an injected `download` closure that suspends on a
continuation the test controls, injected `sleep` that returns immediately on
demand, and a temp dir:
- A starts downloading; B's frame is delivered; A's continuation resumes →
  `machine.current?.event == A`, `.presenting`, B queued, A's temp file exists.
- Dismiss while A is downloading; resume A → temp file deleted, no state change.
- Save completes → saved timer fires → B promoted; a second (stale) timer for A
  fired later does not close B.
- `bind(eventStore:)` called twice registers one handler (a second frame
  produces one arrival).

No server changes → no node tests. `npm run typecheck` / `npm test`
unaffected.

---

## Acceptance criteria

- [ ] Artifacts card shows four segments with counts; Plans lists every plan
      the transcript references, titled from the filename, with status and
      step count; the plan's own page never appears under Links.
- [ ] Tapping a plan opens its published page in the browser; a failure shows
      "Couldn't open the plan page." in the card. "Open plan file" previews the
      markdown in QuickLook (hidden when the session folder is unknown).
- [ ] A plan file (or any file/image) that no longer exists on the box shows
      "Couldn't open <name> — it may no longer be on the box." in the card; the
      card stays open and tapping again retries. A damaged `data:` image shows
      the damaged-data message. No preview tap ever does nothing.
- [ ] Search filters the current segment by name or path, updates segment
      counts, and shows the system "No results for …" state.
- [ ] "Jump to message" appears only for artifacts with an owning message;
      choosing it closes the card and the chat scrolls to and highlights that
      message (via C2 `.message`).
- [ ] "Attach to message" appears only on files/images and only where a
      composer exists; it closes the card and a ready chip appears in the
      composer; a vanished file, a failed upload or a composer rejection shows
      the matching inline error and the card stays open.
- [ ] An image whose source is an `https://` URL can be previewed and attached;
      the request to that URL carries no box token; a 404 from it shows
      "Couldn't download <name> from <host>."
- [ ] Hosted pages always show an expiry capsule ("no expiry" when none);
      agent-sent files with a TTL show one; expired rows are dimmed.
- [ ] When the agent calls `send_file` with `notify:true`, a notice appears
      within ~3 s over the session list or the open chat, naming the file, size
      and conversation; Save opens "Save to Files" and confirms "Saved <name>";
      Share opens the share sheet; a download failure says the file is still on
      the box and leaves the notice up; × dismisses. A file sent without
      `notify` produces no notice.
- [ ] If the file arrives while Settings or a chat sheet (overflow, artifacts,
      secrets…) is open, nothing is lost: the notice is waiting, actionable,
      when that screen closes.
- [ ] Two files arriving while the first is being saved: the first notice is
      not replaced mid-save, shows "+1 more", and the second notice appears when
      the first is done or dismissed. A "Saved" confirmation never closes a
      different file's notice.
- [ ] With Haptics turned off in Settings, saving a file and copying a webhook
      URL produce no vibration (the on-screen "Saved…" / "Copied" still show).
- [ ] Overflow shows "Webhooks"; the card lists this session's hooks with
      unsigned badge, delivery URL (tap copies, shows "Copied"), last delivery
      or "never fired"; swipe/menu Revoke removes it and a failure is reported.
- [ ] New secret form defaults to "Shared — every session" (D9); saving a
      shared secret sends no session id and it appears in the list labelled
      `shared`; project secrets read `project:<name>`; a failed delete says so.
- [ ] The overflow sheet carries the received mounts (rename, mode rows,
      display toggle, read-only job guard) — see "Mounts applied by this
      workstream".
- [ ] No control is shown that cannot act (every new action is hidden when its
      closure/input is missing).
- [ ] `./verify.sh` green with the package-safe tests; `ios-mantaui`
      `test-unit` green (includes the Xcode-only tests).

---

## Files

Edit (owned):
- `mobile/native/MantaUI/ArtifactDerivation.swift` — plan kind, new fields,
  `cwd`, `ArtifactOutboxRow` input, dedupe key, video MIME, presentation
  helpers (`ArtifactExpiry`, `ArtifactSearch`, `ArtifactEmptyCopy`,
  `ArtifactActions`, `ArtifactPlanLink`, `ArtifactAttach`, `ArtifactStaging`,
  `ArtifactByteSource`, `ArtifactDataURI`, `ArtifactStagingError`). Stays
  Foundation-only (it is already in `Package.swift`).
- `mobile/native/MantaUI/SessionResourceCards.swift` — `ArtifactsCard`
  (Plans, search, jump, attach via `composer`, expiry, error banner, per-tab
  empty states, `ArtifactBytes` three-branch loader, `Result`-returning
  staging, `listOutboxRows`), `SecretsCard`/`SecretAddForm` (shared scope,
  badge, delete error).
- `mobile/native/MantaUI/ChatOverflowSheet.swift` — optional `onWebhooks`
  row, plus the received mounts (table below).
- `mobile/native/MantaUITests/ArtifactDerivationTests.swift` — extend/adapt.
- `mobile/native/Package.swift`, `mobile/native/project.yml` — owned by WS07
  (D1) but, per D18, written by integration agent B from this manifest (M-07-4).

Create:
- `mobile/native/MantaUI/MantaAPIClient+Artifacts.swift` — client members
  below (app target only).
- `mobile/native/MantaUI/ArtifactModels.swift` — `ArtifactOutboxRow` (pure).
- `mobile/native/MantaUI/ArtifactAgentFileModel.swift` — `AgentFileEvent`,
  `AgentFileNoticeCopy`, `AgentFileNotice`, `AgentFileNoticeMachine`,
  `AgentFileFailure` (pure).
- `mobile/native/MantaUI/ArtifactAgentFile.swift` — `ArtifactAgentFileStore`,
  `ArtifactAgentFileNotice`, `ArtifactPresenter`, picker/activity delegates
  (UIKit, app target only).
- `mobile/native/MantaUI/WebhookModels.swift` — `WebhookMeta`,
  `WebhookFormat`, `SecretScopeOption` (pure).
- `mobile/native/MantaUI/WebhooksCard.swift` (SwiftUI, app target only).
- Tests: `ArtifactPresentationTests.swift`, `ArtifactAgentFileTests.swift`,
  `WebhookTests.swift`, `SecretScopeTests.swift` (package-safe);
  `ArtifactAPITests.swift`, `ArtifactAgentFileStoreTests.swift` (Xcode-only).

## Client members (D16)

All in `MantaUI/MantaAPIClient+Artifacts.swift`; none duplicates a member
another spec declares (checked: no other spec in this folder adds an
`outbox:*` or `webhook:*` member; the existing `listOutbox`,
`downloadOutboxFile`, `peekFile`, `upload`, `servePageList`, `setSecret`,
`deleteSecret`, `listSecrets` in `MantaAPIClient.swift` are reused, not
redeclared).

| Member | Signature | Wire |
|---|---|---|
| `listOutboxRows` | `func listOutboxRows(sessionId: String) async throws -> [ArtifactOutboxRow]` | `outbox:list` `[sessionId]` → `call(…) ?? []` |
| `listWebhooks` | `func listWebhooks(sessionId: String) async throws -> [WebhookMeta]` | `webhook:list` `[sessionId]` → `call(…) ?? []` |
| `deleteWebhook` | `func deleteWebhook(id: String) async throws` | `webhook:delete` `[id]` → `callVoid` (`deleted:false` = success) |

## Mount requests (D18)

| ID | Receiving file | Applier | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-07-1 | `ChatScreen.swift` | WS02 (wave B) | `ArtifactsCard(sessionId:onClose:projectName:cwd:composer:onJumpToMessage:)` (WS07); `ComposerTextController` instance `composer` (WS03, D3/D13); `MantaNavigator.open(.message(sessionID:messageID:))` (WS04 C2) | In `destinationCard(.artifacts)` (`ChatScreen.swift:782-785`) pass `projectName: projectName`, `cwd: sessionWindow?.cwd`, `composer: composer`, `onJumpToMessage: { mid in pendingArtifactJump = mid; overflowDestination = nil }`. Add `@State private var pendingArtifactJump: String?`; in `flushPendingPush()` (`:825`, already the `onDismiss` of the destination sheet at `:632`) — before the existing push handling — `if let mid = pendingArtifactJump { pendingArtifactJump = nil; navigator.open(.message(sessionID: store.sessionId, messageID: mid)) }`. | WS03 composer adoption landed (wave A); WS04 navigator (wave A); WS07 `ArtifactsCard` params (wave B; defaults nil, so order-independent) |
| M-07-2 | `ChatScreen.swift` | WS02 (wave B) | `WebhooksCard(sessionId:onClose:)` (WS07); `ChatOverflowSheet.onWebhooks` (WS07) | `OverflowDestination` (`:88`) gains `case webhooks`; `destinationCard` adds `case .webhooks: WebhooksCard(sessionId: store.sessionId, onClose: { overflowDestination = nil })`; `overflowSheet` (`:658`) passes `onWebhooks: { overflowDestination = .webhooks }`. | WS07 `WebhooksCard` (wave B; the overflow row stays hidden until wired) |
| M-07-3 | `MantaAppRoot.swift` | Integration agent B | `ArtifactAgentFileNotice()` (WS07) | On the paired branch (`MantaAppRoot.swift:98-109`, the `SessionListView(store:)` view) add `.overlay(alignment: .bottom) { if scene == nil { ArtifactAgentFileNotice() } }`, placed BEFORE (i.e. beneath) the existing `.overlay { UpgradeScreen }` at `:123-128` so the upgrade screen covers it. Needs `MantaEventStore` + `SessionListStore` environment objects (already injected, `MantaUIApp.swift:46-50`). | WS07 `ArtifactAgentFile.swift` landed (wave B) |
| M-07-4 | `mobile/native/Package.swift` | Integration agent B (D18; file owned by WS07 per D1) | — | Append to target `sources`: `ArtifactModels.swift`, `ArtifactAgentFileModel.swift`, `WebhookModels.swift`. Append to test `sources`: `ArtifactPresentationTests.swift`, `ArtifactAgentFileTests.swift`, `WebhookTests.swift`, `SecretScopeTests.swift`. Do NOT add `MantaAPIClient+Artifacts.swift`, `ArtifactAgentFile.swift`, `WebhooksCard.swift`, `ArtifactAPITests.swift`, `ArtifactAgentFileStoreTests.swift`. Then run `./verify.sh`. | WS07 files landed |

`project.yml`: no change (the `MantaUI` / `MantaUITests` folder entries pick
up new files). `.pbxproj` is regenerated once by the orchestrator (D18).

## Mounts applied by this workstream (D18: all `ChatOverflowSheet` mounts → WS07, wave B)

Every new parameter is optional / defaulted so `ChatOverflowCaptureScene.swift:29-43`
and ChatScreen compile before their wiring lands, and a missing closure hides
its row (no dead controls).

| ID | Requested by | Provider symbol(s) | Exact change in `ChatOverflowSheet.swift` | Prerequisite |
|---|---|---|---|---|
| WS01 M4 | `01-transcript.md` Mount requests M4 | `TranscriptDisplayOptions.defaultsKey`, `TranscriptDisplayOptions.setShowDetails(_:)` (WS01 `TranscriptReasoning.swift`, wave A) | In the Trust-mode `Section` (`:116-131`), after the trust toggle: `Toggle` "Show reasoning & full output", subtitle "Thinking steps and complete tool output", bound with `@AppStorage(TranscriptDisplayOptions.defaultsKey) var showDetails = false` and a `Binding(get: { showDetails }, set: { TranscriptDisplayOptions.setShowDetails($0) })`. Shown regardless of `isReadOnlyJob` (display-only). No ChatScreen change. | WS01 landed (wave A) |
| WS02 M3 | `02-chat-cards-queue.md` Mount requests M3 | — (ChatScreen passes it) | Add `var isReadOnlyJob: Bool = false`; when true hide Compact, Clear, Fork, Delete and the Trust-mode toggle (`:120-131`, `:142-146`). Webhooks/Secrets/Artifacts/Scheduled rows stay (read + revoke parity with desktop's read-only view). | none |
| WS04 (a) | `04-sessions.md` §14 row "WS07 (B)" | — (ChatScreen wires `onRename`, WS02) | Add `var onRename: (() -> Void)? = nil`; row "Rename session" (`pencil`) in the second section (before Compact) via the existing `row(...)` helper, shown only when non-nil and not `isReadOnlyJob`. | none |
| WS04 (b) | `04-sessions.md` §14 row "WS07 (B)" | `SessionModeRows(current:launchers:onSelect:)`, `SessionMode`, `SessionLauncher` (WS04, wave A) | Add `var mode: SessionMode = .chat`, `var launchers: [SessionLauncher] = []`, `var onSelectMode: ((SessionMode) -> Void)? = nil`. When `onSelectMode != nil`: replace the "Open terminal" row (`:111`) with `SessionModeRows(current: mode, launchers: launchers, onSelect: { m in dismiss(); onSelectMode?(m) })`. When nil: keep the existing "Open terminal" row (the capture scene and any un-wired caller keep working). | WS04 landed (wave A) |

Cross-check: these are all `ChatOverflowSheet` mounts listed in the other
specs (`grep ChatOverflowSheet` over `01`–`10`): WS01 M4, WS02 M3, WS04 §14
(a)/(b). WS05/06/08/09/10 request none. Package.swift requests from other
workstreams (e.g. `05-git-pr-review.md` §files) are applied by the integration
agent of THEIR wave per D18, not by WS07.

## Contracts provided / consumed

- **C1 provided:** `MantaAPIClient+Artifacts.swift` (see Client members). Wire
  types live in `ArtifactModels.swift` / `WebhookModels.swift`.
- **C2 consumed:** `MantaNavigator.open(.message(sessionID:messageID:))`,
  called from ChatScreen's flush (M-07-1); WS02 owns handling.
- **C3 consumed:** `ComposerTextController.attach(remotePath:displayName:mime:) -> Bool`
  (WS03), called inside `ArtifactsCard` on the instance passed by M-07-1; a
  `false` result is surfaced.
- **C4:** M-07-1, M-07-2 (ChatScreen, applied by WS02 per D18).
- **C5:** not used — `agentFile` is a bus kind (no `sub`), observed through
  the existing `addRawFrameHandler`; `MantaStreamModels.swift` /
  `MantaEventStore.swift` are not edited.
- **C6:** not used. **C7:** tests above (package-safe vs Xcode-only split).
- **D9:** secrets default scope = shared; agent-file notice always shown.
- **Existing helpers consumed:** `SessionHaptics.fire(_:enabled:)` and
  `SessionListStore.hapticsEnabled` (WS04 files, read-only use);
  `PlanDerivation.planRefsFromPart/planSubdomain/planPageURL` (read-only use).

## Deferred

- **Desktop "Download"** action on artifacts — iOS keeps Share (long-press);
  Save-to-Files from the card is an easy follow-up reusing the F6 exporter, but
  not in the gap list.
- **Plan status other than "draft"** and **"Open implementing session"** —
  the desktop has no plan→job link either (always draft, action omitted).
- **Review mode** in the artifacts panel — owned by WS05.
- **Secrets inline edit / search / "Manage all in Settings"** — not in this
  workstream's scope.
- **Agent-file notice while the app is backgrounded/disconnected** — the box
  marks a file announced when it publishes, whether or not any client hears
  it; a push or catch-up path needs a server change and is out of scope. The
  file remains in the Artifacts card.
- **Notice drawn above modals** — would need a window-level host outside every
  workstream's files; the notice waits instead (F6 "Modal behaviour").
- **Live webhook list refresh on `webhook.updated`** — desktop is
  refetch-driven; iOS matches.

## Open questions

None remaining: both round-0 questions are decided by D9 (secrets default
scope = shared; agent-file notice always shown).

## Review responses (round 1)

Own review (`reviews/round1/07-artifacts-cards.md`):

1. **BLOCKING F4 byte resolution — resolved.** Added "Byte resolution" in F4:
   pure `ArtifactByteSource.classify` with data URI / remote http(s) / box path
   / unsupported branches; remote fetched through a separate ephemeral
   `URLSession` with no `Authorization` header and no cookies, 2xx required;
   used by preview, Share and Attach. Classifier tests in
   `ArtifactPresentationTests`, header-absence test in `ArtifactAPITests`,
   remote-image acceptance case added.
2. **BLOCKING F6 async lifecycle — resolved.** Replaced the store sketch with a
   pure `AgentFileNoticeMachine`: per-notice token + per-operation opID
   captured by every download, presentation callback and saved timer; arrivals
   during an in-flight operation are queued ("+N more"), not swapped in;
   `begin` refuses re-entry; dismiss during download allowed (late completion
   only deletes its temp file); dismiss disabled while the picker/sheet is up.
   Deterministic sequence tests (A-starts/B-arrives/A-finishes, old picker
   completion, old timer, dismiss-during-download, …) plus Xcode-only store
   tests with an injected suspending downloader.
3. **BLOCKING tests vs Package.swift — resolved.** API request tests moved to
   Xcode-only `ArtifactAPITests.swift`; MainActor store tests in Xcode-only
   `ArtifactAgentFileStoreTests.swift`; the pure machine/decoding lives in
   `ArtifactAgentFileModel.swift` and is package-tested. M-07-4 lists exactly
   which files go into the package and which must not; the ambiguous
   "#if canImport(UIKit)-free" instruction is removed.
4. **SHOULD Open plan file failure — resolved.** Staging now returns
   `Result<URL, ArtifactStagingError>`; every preview/staging failure
   (files, images, plan files, malformed data URIs, remote errors) sets the
   inline banner with a specific message; card stays open; retry by tapping
   again. Acceptance case for a vanished plan file added.
5. **SHOULD haptics — resolved.** Both new haptics go through
   `SessionHaptics.fire(_:enabled: SessionListStore.hapticsEnabled)`; the
   on-screen confirmations remain. Acceptance case with Haptics off added.
6. **SHOULD global visibility — resolved by narrowing.** Specified modal
   behaviour: the overlay is visible over the list and pushed chats (both inside
   `SessionListView`'s `NavigationStack(path:)`, `SessionListView.swift:75,134`);
   under Settings / sheets the event is retained and the notice appears,
   actionable, when the modal closes. Exporter/share sheet presented in UIKit
   from the top-most view controller to avoid colliding with the list's own
   SwiftUI presentations. Acceptance text narrowed; arrival-under-modal case
   added.

Cross-cutting review (`reviews/round1/00-cross-cutting.md`):

- **#7 (wave-B shared-file edits)** — `MantaAppRoot.swift` mount is now M-07-3,
  applied by integration agent B (D18), not by WS07.
- **#8 (bidirectional mount ledger)** — "Mount requests" is a D18 table with
  appliers and prerequisites; "Mounts applied by this workstream" accepts WS01
  M4, WS02 M3 and WS04 §14 (a)/(b) on `ChatOverflowSheet.swift`, cross-checked
  against those specs. The artifacts/webhooks ChatScreen callbacks are M-07-1/2
  for WS02.
- **#10 (Package.swift / pbxproj schedule)** — Package edits go through
  M-07-4 for integration agent B; WS07 does not pre-add other waves' files;
  pbxproj is left to the orchestrator.
- **C3 change** — `attach` now returns `Bool`; the card surfaces `false`.
- **D16** — Client members table added; no duplicates.
