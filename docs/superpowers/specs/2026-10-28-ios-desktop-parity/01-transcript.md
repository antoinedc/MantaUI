# WS01 — Transcript parity

Status: revised after review round 2 · Wave A1 (D20).

Owner files: `ChatModels.swift`, `TranscriptComponents.swift`,
`TranscriptRow.swift`, `ToolActivity.swift`, `ActivitySheet.swift`,
`VoiceNotePlayer.swift`, plus `MantaModels.swift` and `MantaUIApp.swift` (D1),
plus new `Transcript*` files and `MantaAPIClient+Transcript.swift` (C1).

Paths below are relative to the repo root; Swift files without a directory live in
`mobile/native/MantaUI/`.

## Scope (6 features)

| # | Feature | Server change |
|---|---|---|
| F1 | Inline files and media: files attached to a user message; images/videos the agent shows with `media_show` | none |
| F2 | "Show reasoning & full output" switch (desktop Ctrl+O) | none |
| F3 | Collapsed `/command` user turns | none |
| F4 | Turn footer: duration, tokens, "truncated" warning | none |
| F5 | Copy buttons on code blocks and tool output | none |
| F6 | Quote / Quote in new session reachable from the transcript | none |

**No new server routes, channels or frames.** Everything comes from data the box
already sends: the `opencode:messages` transcript (via `src/shared/opencodeV2.mjs`
`mapTimeline`), the `media` bus kind, the `commandExecuted` stream frame, and
`GET /api/peek`.

## Ground rules this spec relies on

- **Row identity (mobile/native/AGENTS.md §6).** Every new transcript row has an id
  built only from the block's own data (part id, message id, media handle). None
  uses an index, a UUID or a render-time value. All new blocks go through the
  existing `uniqueTranscriptRows` (`TranscriptRow.swift:114`).
- **Exhaustive switches.** `TranscriptBlock` is only switched exhaustively in WS01
  files: `TranscriptRow.swift:37` (`stableScrollID`), `TranscriptRow.swift:359`
  (`transcriptBlockView`) and `TranscriptComponents.swift:843` (`timestamp`). I
  checked this with `grep -rn TranscriptBlock`: `ChatStreamMergeTests.kind(_:)` has
  a `default:`. So adding cases does not break files owned by other workstreams.
- **Wave A independence.** Everything the transcript itself contains is handled
  inside `ChatTranscriptMapper`, which WS01 owns. That covers file parts,
  `media_begin`/`media_show` tool parts, `info.command`, `info.tokens`,
  `info.finish`, `step-finish` reasons and reasoning parts. It works through the
  overloads `ChatSessionStore` already calls, so WS02 needs no change in wave A.
  - Live-only data arrives later through `TranscriptMapOptions`, which WS02
    passes in wave B. Per D15 every WS01 mount in `ChatSessionStore.swift` is a
    WS02 wave-B deliverable. The live-only inputs are:
    - media placeholders that are still pending;
    - WS02's `commandByMessageID` (D15);
    - WS02's existing single `truncation` (the latest warning, with its `messageID`);
    - the `running` gate.
  - Until then those options default to empty, and features degrade to "shows
    after the turn settles". Nothing breaks.
- **Linux inner loop (D19).** Pure logic lives in Foundation-only files listed
  in **Package manifest**, so `mobile/native/verify.sh` can compile and test it.
  Mapper and view tests need `TranscriptBlock` (SwiftUI), so they run only on
  the Mac.

---

## F1 — Inline files and media

### Desktop behaviour

**Files attached to a user message.** `src/renderer/MessageRow.tsx:421-448`: each
`type:"file"` part of a user message is a small mono chip above the bubble, aligned
right, showing `filename` (or the last `/` segment of `url`, or `"file"`). It is
truncated at 260px and its tooltip is the `url`. The chip cannot be clicked.

**Media the agent creates** (BET-1148). These come from the `media_save` /
`media_begin` / `media_show` tools (`docs/opencode-plugins-v2/manta/tools/media.ts`):

- The box publishes ONE bus kind, `media`, whose `action` is `begin` | `show` |
  `fail` (`src/server/media.mjs:293-363`, published via `src/server/index.mjs:3283`).
  An orphaned `begin` turns into `fail` after 10 minutes (`ORPHAN_TIMEOUT_MS`,
  `media.mjs:40`).
- `src/renderer/App.tsx:1268-1290` subscribes once. The pure reducer
  `applyMediaEvent` (`src/renderer/chatUtils.ts:4736-4790`) stores each entry under
  `sessionID → messageID`.
- `MessageRow.tsx:485` draws `MediaBody` at the TOP of the assistant message that
  owns the entry. `MediaBody.tsx`:
  - The card is a ToolCard titled "Image"/"Video" with the media title as its
    argument. It is expanded by default and has the error tone when failed or
    expired (`MediaBody.tsx:273-295`).
  - **Pending**: a reserved box with a spinner; up to 4 numbered tiles in 2
    columns when `count > 1`, then `+N more`. Below it: "Generating image" /
    "Generating video", an elapsed clock, and "· this usually takes a few
    seconds" (`MediaBody.tsx:55-92`). No percentage is shown.
  - **Ready**: `HEAD` then `GET /api/peek?path=` with auth. Files over 25 MB are
    refused (`MAX_PREVIEW_BYTES`, `chatUtils.ts:2936`); the refusal shows
    "⚠ Couldn’t load this media". Images use `object-contain`. Videos show
    controls with `preload=metadata` and **never autoplay**. Clicking opens the
    artifact preview; a hover button offers Download (`MediaBody.tsx:94-258`).
  - **Failed / expired**: the same reserved box with "⚠ The media failed to
    generate" / "⚠ This media expired" (`MediaBody.tsx:260-265`).
  - **Box size**: the explicit width÷height wins, then the declared
    `aspectRatio`, then 16:9 (`resolveMediaAspect`, `chatUtils.ts:4690`). The
    width is capped at `--inline-max-w` (`inlineEmbed.tsx:32-34`). Every state
    uses the same box, so the transcript never jumps.
- Desktop media is **live-only**: the store is in memory, so after a reload the
  picture is gone and only the `media_show` tool line remains in its tool group.
  iOS improves on this (see below). A file part with an image/video mime also
  renders through `MediaBody` (`ToolCall.tsx:170-176`, `filePartToMediaEntry`
  `chatUtils.ts:4715`). On V2 that path only happens for user parts, because
  `mapAssistant` emits no file parts (`opencodeV2.mjs:233-291`).

### Wire contract

- **User file parts** come from `opencode:messages`. `mapUser`
  (`src/shared/opencodeV2.mjs:293-317`) emits
  `{id:"<msg>:file:<i>", type:"file", mime?, filename?, url?}`.
  - `url` is either the file's `file://…` source URI or a
    `data:<mime>;base64,<…>` URL for inline data.
  - On iOS these fields sit in `OpencodePart.extra` (`MantaModels.swift:82`).
- **`media` bus frame.** This is a raw `/events` frame (`kind:"media"`), not a
  `stream` sub.
  - Payload is `MediaEventPayload` (`src/shared/types.ts:1092-1106`):
    `{action, handle?, sessionID?, messageID?, kind?: "image"|"video", width?,
    height?, aspectRatio?, count?, title?, path?, mime?, size?}`.
  - Routing fields use an uppercase `ID` (BET-1328).
  - **Every call forwards the CALLING assistant message id**
    (`docs/opencode-plugins-v2/manta/tools/media.ts:12-23`). The server
    publishes `begin` with the begin call's message (`src/server/media.mjs:308-316`)
    and `show` with the show call's message (`:348-360`).
  - One model step is one assistant message (`ToolActivity.swift:655-656`), so
    `begin` and `show` for one handle routinely carry **different**
    `messageID`s.
  - `show` deletes the pending handle server-side (`media.mjs:348`), so no later
    `fail` arrives for it.
- **`media_begin` tool part** (persisted):
  - `state.input = {kind, width?, height?, aspectRatio?, count?, title?}`.
  - On success, `state.output = "Placeholder reserved. Handle: <hex>. Keep it…"`
    (`media.ts:61-84`).
- **`media_show` tool part** (persisted):
  - `state.input = {path, handle?, title?}`.
  - On success, `state.output =
    "Displayed <resolvedPath> (<mime>[ <W>x<H>], <size> bytes) in the transcript."`
    (`media.ts:87-113`).
- **Bytes** come from `GET` and `HEAD /api/peek?path=<path>`
  (`src/server/index.mjs:4230`, `src/server/peek.mjs`).
  - The box expands `~` and keeps the path inside home.
  - `HEAD` returns `content-length` without a body (`peek.mjs:93-100`).
  - Bearer auth.
- The existing `MantaAPIClient.peekFile(path:)` (`MantaAPIClient.swift:559-579`)
  loads the WHOLE body into memory (`session.data(for:)`). WS01 therefore adds
  two bounded members (see **Client members**) and does not use `peekFile` for
  transcript media.

### What iOS has today

- `TranscriptAttachment.Kinds` has only `.voiceNote` and `.widget`
  (`TranscriptComponents.swift:855-869`).
- `attachmentView` (`TranscriptRow.swift:482-501`) and
  `ChatTranscriptMapper.process` (`ChatModels.swift:419-441`) say image/file
  rendering is "deliberately not implemented yet (BET-1029)".
- Message rows are emitted only when the message has text
  (`ChatModels.swift:199`). A user message that is only an attachment therefore
  disappears.
- Precedents to copy:
  - `WidgetLiveStore`: a box-wide `@MainActor` store bound to raw frames
    (`WidgetLiveStore.swift:20-102`), bound at `MantaUIApp.swift:39`.
    `MantaUIApp.swift` is now WS01-owned (D1).
  - `WidgetMetrics` reserved box (`WidgetModels.swift:115-126`).
  - `Metrics.type.inlineMaxW` (520).
  - QuickLook staging in `SessionResourceCards.swift:497-660`. It is private to
    WS07, so WS01 ships its own small wrapper.

### iOS design

#### Pure model (new `TranscriptMediaModel.swift`, Foundation-only, listed in `Package.swift` per D19)

```swift
enum TranscriptMediaKind: String, Equatable, Sendable { case image, video }
enum TranscriptMediaState: Equatable, Sendable { case pending, ready, failed }
struct TranscriptMediaGeometryInput: Equatable, Sendable { var width: Double?; var height: Double?; var aspectRatio: Double? }

struct TranscriptMediaEntry: Equatable, Sendable {
  let id: String                 // TranscriptMediaIdentity.id(...) — see below
  var ownerMessageID: String     // the message the card renders under (see "Owner policy")
  var seq: Int                   // first-sight order, for deterministic ordering
  var state: TranscriptMediaState
  var kind: TranscriptMediaKind
  var reserved: TranscriptMediaGeometryInput   // IMMUTABLE once set by a begin (see "Geometry")
  var count: Int?
  var title: String?
  var path: String?              // box path for /api/peek (ready only)
  var mime: String?
  var size: Int64?               // bytes, when known
  var beganAt: Date?
  var handle: String?
}

struct TranscriptMediaFrame: Codable, Equatable, Sendable {   // the `media` payload
  var action: String; var handle: String?; var sessionID: String?; var messageID: String?
  var kind: String?; var width: Double?; var height: Double?; var aspectRatio: Double?
  var count: Int?; var title: String?; var path: String?; var mime: String?; var size: Int64?
}

enum TranscriptMediaIdentity {
  /// handle present → "media:h:<handle>"; otherwise → "media:s:<messageID>:<path>"
  static func id(handle: String?, showMessageID: String, path: String) -> String
}

/// Session-wide live reducer state: entries keyed by id, plus a seq counter.
struct TranscriptMediaSessionState: Equatable, Sendable {
  var byID: [String: TranscriptMediaEntry] = [:]
  var nextSeq = 0
  mutating func apply(_ frame: TranscriptMediaFrame, now: Date)
  var ordered: [TranscriptMediaEntry] { get }   // sorted by seq
}

enum TranscriptMediaParse {
  static func showOutput(_ s: String) -> (path: String, mime: String?, w: Double?, h: Double?, size: Int64?)?
  static func beginHandle(_ output: String) -> String?        // "Handle: <[0-9a-f]+>"
  static func mimeForPath(_ path: String) -> String?          // MIME_BY_EXT port (media.mjs:44-56)
  /// Canonical reconstruction over the WHOLE loaded message list (session-wide).
  static func canonicalEntries(_ messages: [OpencodeMessage]) -> [TranscriptMediaEntry]
}

enum TranscriptMediaReconcile {
  /// Live entries the canonical list does not cover (by id), in seq order.
  static func liveOnly(live: [TranscriptMediaEntry], canonical: [TranscriptMediaEntry]) -> [TranscriptMediaEntry]
}

enum TranscriptMediaGeometry {
  static let defaultAspect = 16.0 / 9.0
  static let maxHeight = 480.0            // iOS-only: a phone column cannot fit a 1:3 image
  static let inlineMaxWidth = 520.0       // = Metrics.type.inlineMaxW (pure copy; a test pins equality on the Mac)
  static let maxPreviewBytes: Int64 = 25 * 1024 * 1024   // MAX_PREVIEW_BYTES, chatUtils.ts:2936
  static func aspect(_ g: TranscriptMediaGeometryInput) -> Double        // resolveMediaAspect
  static func box(_ g: TranscriptMediaGeometryInput, availableWidth: Double) -> (width: Double, height: Double)
  static func grid(count: Int?) -> (tiles: Int, more: Int)               // mediaGrid
}

struct TranscriptFileRef: Equatable, Sendable {
  enum Source: Equatable, Sendable { case boxPath(String), dataURL(mime: String?, base64: String), none }
  let partID: String; let filename: String; let mime: String?; let source: Source
}
enum TranscriptStagingKey {
  /// Canonical, collision-free key INPUT (hashing happens app-side with CryptoKit — finding 3, round 2).
  static func input(boxID: String?, serverURL: String?, source: TranscriptFileRef.Source) -> String
}
enum TranscriptPeekRequest {
  /// "<serverURL>/api/peek?path=<encoded>" via URLComponents; nil if serverURL is unusable.
  static func url(serverURL: URL, path: String) -> URL?
}
enum TranscriptFileParse {
  static func refs(of message: OpencodeMessage) -> [TranscriptFileRef]
  /// Decoded byte count of a base64 payload without decoding it (len*3/4 − padding).
  static func decodedSize(base64: String) -> Int64
}
```

The pure file depends only on `MantaModels.swift` and `ChatJSON.swift`, both
already in `Package.swift`. It reads the tool name as
`ChatJSON.string(part.extra["tool"])`, which is what `ToolActivity.toolName`
does (`ToolActivity.swift:214-216`). It does not depend on `ToolActivity`,
which is not in the package.

#### Owner policy: one rule for live and canonical data

- **Identity.** A card is identified by its handle when it has one
  (`media:h:<handle>`). Otherwise the id is the show call's message plus the
  resolved path (`media:s:<messageID>:<path>`).
  - Live (`frame.messageID`, `frame.path`) and canonical (`part.messageID`, path
    parsed from the output) produce the same id. The server resolves the path
    once and reports the same string in the frame and in the output text
    (`media.mjs:351-358`, `media.ts:112`).
  - The live store and the canonical list are **session-wide maps keyed by
    id**. The incoming message is never the key, so a `show` in message B
    updates the entry that `begin` created in message A. There is never a
    second row.
- **Owner message** is where the card renders:
  - When a `begin` was seen (live, or a canonical `media_begin` part whose
    output names the handle), the owner is the **begin's** message, so the
    placeholder never moves.
  - Otherwise the owner is the **show's** message.
  - `ownerMessageID` is set once, on first sight, and never rewritten.
- **Reconciliation** (`TranscriptMediaParse.canonicalEntries`, over all loaded
  messages in order):
  1. Every completed `media_begin` part with a parseable handle seeds
     `byID[media:h:<handle>]`, as `pending`. Its owner is that part's message;
     its reserved geometry and its title/count/kind come from `state.input`.
  2. Every completed, non-error `media_show` part resolves its entry: by
     `input.handle` when present, else by `media:s:…`. The entry becomes
     `ready`, with path/mime/size from the output. A seeded entry keeps the
     owner and geometry from step 1. An unseeded entry takes the show's message
     as owner and its measured dims as `reserved`.
  3. A begin that was never shown stays `pending` only while it is in the live
     store. Canonically it is dropped (the desktop shows nothing after reload
     either). A live `fail` keeps the `failed` state.
- **Live merge.** `TranscriptMediaReconcile.liveOnly` keeps only live entries
  whose id the canonical list lacks. Placement:
  - If the entry's `ownerMessageID` is a settled, loaded message, it renders
    there through the mapper (`options.liveMedia`).
  - Otherwise it renders in the live tail (`liveMediaTail`).
- **Ordering** inside one owner message: by `seq`. Canonical entries get `seq`
  from their part order (begin part first, else show part), live entries from
  first-sight order. Ties are broken by `id` (string compare), so equal or nil
  `beganAt` never decides order. `liveMediaTail` orders by `(seq, id)`.
- **What this guarantees:** begin in A, show in B, then a refetch, then an app
  reload gives exactly one row, `media:h:<handle>`. It is pending under A, then
  ready under A, then ready under A from the canonical data (the begin part
  stays in A, which is in the loaded window). If A has scrolled out of the
  loaded window, the owner falls back to B (step 2's unseeded rule). That is a
  one-time move, only when older history is not loaded.

#### Geometry (reserved box never changes height)

- The desktop reducer overwrites width/height on `show`
  (`src/renderer/chatUtils.ts:4759-4779`). iOS does **not** copy that.
- `reserved` is set by the first frame or part that declares geometry:
  - a `begin`'s width/height/aspectRatio, when a begin exists;
  - otherwise the `show`'s measured width/height.
  - After that it is never overwritten: a later `show` only fills path, mime
    and size.
- The image is drawn `scaledToFit` (letterboxed) inside that box. A video, or an
  image whose header could not be measured (the server sends `null` dims,
  `media.mjs:359-360`), uses the 16:9 default box.
- `box()` computes the box this way:
  1. `w = min(availableWidth, inlineMaxWidth)`
  2. `h = w / aspect`
  3. if `h > maxHeight`, then `h = maxHeight` and `w = h * aspect`.

#### Live store (new `TranscriptMediaStore.swift`)

```swift
@MainActor final class TranscriptMediaStore: ObservableObject {
  static let shared = TranscriptMediaStore()
  @Published private(set) var sessions: [String: TranscriptMediaSessionState] = [:]
  func bind(eventStore: MantaEventStore)        // idempotent; addRawFrameHandler, kind == "media" only
  func entries(for sessionID: String) -> [TranscriptMediaEntry]
}
```

- The store is in memory only, like the desktop. Canonical parts carry the media
  after a reload.
- It is bound in `MantaUIApp.swift` next to
  `WidgetLiveStore.shared.bind(eventStore: event)` (line 39). WS01 now owns that
  file (D1) and applies the line itself.

#### Bounded staging (new `TranscriptFileStager.swift`)

```swift
@MainActor final class TranscriptFileStager {
  static let shared = TranscriptFileStager()
  enum Failure: Error, Equatable { case tooLarge(Int64), unavailable(String) }
  func localURL(for source: TranscriptFileRef.Source, sizeHint: Int64?) async throws -> URL
  func reset()                       // cancels in-flight work, drops the cache, deletes this run's files
}
```

- **Scope (finding 6).**
  - **The key input is pure; the hashing is app-only (round 2, finding 3).**
    - `TranscriptStagingKey.input(boxID:serverURL:source:) -> String` lives in
      the Foundation-only pure file and is tested on Linux. It returns
      `boxID + "\n" + serverURL + "\n" + <source tag>`, where the source tag is
      `"path:" + path`, or `"data:" + mime + ":" + <ENTIRE base64 payload>` (round 3,
      finding 1: a truncated prefix let two different equal-length attachments
      collide and display/share the wrong file). Tests: two equal-length,
      equal-64-char-prefix, different-suffix sources → different key inputs,
      different staged bytes, no in-flight coalescing between them.
    - `TranscriptFileStager` (app-only) hashes that string with
      `CryptoKit.SHA256` to get the file name. Swift Foundation has no SHA-256,
      the Linux package has no crypto dependency (`Package.swift:31-65`), and
      none is added.
  - On every call the stager reads the current identity
    (`KeychainCredentialStore.shared.boxId` and `.serverURL`). If it differs
    from the identity the cache was built for, the stager calls `reset()` first.
  - Files live under `temporaryDirectory/transcript-files/<SHA256(boxID+serverURL)>/<SHA256(input)>.<ext>`.
- **Lifecycle.**
  - The first use in a process deletes the whole `transcript-files/` directory,
    so there are no stale files from earlier runs.
  - `reset()` deletes the identity's directory.
  - The cache is capped at 64 files, least recently used first; an evicted file
    is deleted.
  - In-flight requests for the same key are coalesced into one `Task`.
  - `reset()` cancels in-flight tasks; their callers get `CancellationError`,
    which the views treat as "no change".
- **Memory bounds (finding 8).**
  - Box path:
    1. When `sizeHint` is nil, the stager calls
       `peekFileSize(path:)` first (HEAD).
    2. If the size is `> maxPreviewBytes`, it throws `.tooLarge(size)` **before**
       any download.
    3. Otherwise it calls
       `downloadPeekFile(path:to:maxBytes:)`, which streams to disk (never into
       memory) and aborts once the limit is crossed. That covers a missing or
       lying `content-length`.
  - Data URL: if `TranscriptFileParse.decodedSize > maxPreviewBytes`, it throws
    `.tooLarge` without decoding. Otherwise it decodes once and writes the file.
    The base64 text is already in memory as part of the transcript, which is an
    accepted limit of the wire format.
- Images are displayed with ImageIO downsampling
  (`CGImageSourceCreateThumbnailAtIndex`, maximum pixel size = box width ×
  screen scale) from the staged file. The full bitmap is never decoded into a
  cell.

#### Mapper (`ChatModels.swift`)

- **User message.**
  - Compute `refs = TranscriptFileParse.refs(of:)`. When it is non-empty, emit
    `.file(TranscriptAttachment(kind: .userFiles(TranscriptUserFiles(messageID:, refs:))))`
    BEFORE the `.user` / `.command` block.
  - Emit it even when the message has no text.
  - Id: `"f" + "ufiles:" + messageID`.
- **Media.**
  - Compute `canonical = TranscriptMediaParse.canonicalEntries(messages)` once,
    over all messages (settled and in-flight, so a begin in a settled message
    is seen even when its show is in-flight), and
    `live = TranscriptMediaReconcile.liveOnly(live: options.liveMedia, canonical:)`.
  - For each settled assistant message `m`, emit FIRST its media: canonical
    entries with `ownerMessageID == m.id`, then live entries with the same
    owner, each as `.file(.media(entry))`.
  - Then emit the existing layout blocks, then widgets (unchanged), then the
    turn footer (F4).
  - Canonical entries whose owner is NOT settled are not emitted by the mapper;
    `liveMediaTail` handles them. They include ready ones from a show in an
    already-settled step inside a running turn.
- **`media_begin` / `media_show` calls stay in their tool run**, so the Activity
  sheet keeps them. `ToolActivity.layout` is unchanged, because it is a shared
  parity fixture with the desktop.
- **New pure helper for WS02:**
  `static func liveMediaTail(messages: [OpencodeMessage], live: [TranscriptMediaEntry], isLiveWindow: Bool) -> [TranscriptBlock]`.
  It returns `.file(.media)` blocks, in `(seq, id)` order, for entries
  (canonical ∪ live-only) whose owner is one of these:
  - (a) a message in `messages` that is NOT settled;
  - (b) only when `isLiveWindow`, a message ABSENT from `messages` whose live
    entry was recorded during the CURRENT turn (`TranscriptMediaEntry.turnStartedAt`
    ≥ the session's current-turn start, i.e. created after the last user message
    the store has seen). This is the normal case for the running step, because the
    transcript is not refetched mid-turn.
  - **Retirement (round 3, finding 2):** `TranscriptMediaStore` drops a session's
    live-only entries for an owner as soon as a canonical snapshot contains that
    owner message (absorbed), and drops all live entries for a session when a turn
    settles and the post-turn refetch lands. So an old settled owner outside the
    30-message window can never resurrect at the tail. Tests: (i) settled media
    owner older than the loaded window + new turn → not in the tail; (ii) focus
    suffix whose last id equals the full list's last id → only current-turn
    entries in the tail.
- **One message list, disjoint segments (round 2, finding 1).** The mapper
  emits only entries whose owner is a SETTLED message of the list it was given.
  `liveMediaTail` emits only cases (a) and (b). So **as long as both calls
  receive the same array**, an owner can never appear in both segments.
  - WS02 maps `presentedMessages` (its F10 focus slice, or all messages), so it
    passes `presentedMessages` to BOTH calls, with
    `isLiveWindow: presentedMessages.last?.info.id == messages.last?.info.id`.
  - A historical focus slice therefore never shows the live tail's media, and
    an owner outside the slice shows nowhere until the user returns to the live
    window.
- **Row id** is `"f" + entry.id`. It is the same id for pending, ready and
  canonical, so the row updates in place.

#### Views (`TranscriptMediaCard.swift`, `TranscriptFiles.swift`)

- **`TranscriptMediaCard`.**
  - Header row: SF Symbol `photo` / `video`, then "Image" / "Video", then the
    title (tx3, one line).
  - Below it is the reserved box (`TranscriptMediaGeometry.box`,
    `tokens.inset` background, `Metrics.radius.md`, a `tokens.border` stroke).
    The box size comes ONLY from `entry.reserved`.
  - **pending.**
    - One `ProgressView` per tile: up to 4 tiles in 2 columns, numbered in the
      corner, plus `+N more`.
    - Below the tiles: "Generating image" / "Generating video", an elapsed clock
      (`TimelineView(.periodic(from:.now, by:1))` with
      `TranscriptTurnFormat.duration`), and "· this usually takes a few
      seconds".
  - **ready, loading:** a spinner while `TranscriptFileStager` works, called
    with `sizeHint: entry.size`.
  - **ready, image:** the downsampled image. Tapping opens QuickLook
    (`.fullScreenCover`), whose share sheet covers Save to Photos and Save to
    Files. Accessibility label "Image: <title|filename>", hint "Opens the full
    image".
  - **ready, video:** a first-frame poster (`AVAssetImageGenerator` on the
    staged file) with a centred `play.circle.fill`. Tapping opens QuickLook,
    which plays it. **No autoplay.**
  - **Load error:** "⚠ Couldn’t load this media" with a **Try again** button,
    which re-runs staging. Too large: "⚠ Too large to preview here (N MB)",
    shown as a label only.
  - **failed:** "⚠ The media failed to generate" in the same box, with the
    header icon in `tokens.danger`.
- **`TranscriptUserFilesRow`.**
  - A right-aligned, wrapping row of chips. Each chip has a paperclip and the
    filename (mono, xs, max 260pt, middle-truncated), on a `tokens.fill`
    background with a `tokens.border` stroke.
  - **iOS addition:** tapping a chip stages the file and opens QuickLook. While
    it stages, the chip shows a spinner.
  - On failure, an inline line under the row reads "Couldn’t open <filename>"
    or "<filename> is too large to preview" (tokens.danger, twoXS). It clears
    after 4 s.
  - A `.none` source renders as plain, non-button text.
- **`TranscriptQuickLook`:** a `UIViewControllerRepresentable` around
  `QLPreviewController` for one URL. It is presented card-locally, following the
  precedent at `WidgetCard.swift:123`.

### Pure logic + tests

`MantaUITests/TranscriptParityTests.swift` is pure and Linux-runnable under
`verify.sh`; it covers everything in `TranscriptMediaModel.swift`.

- **`TranscriptMediaSessionState.apply`**
  - begin → pending, with `reserved` and owner = the begin's message.
  - **begin(A, 16:9) then show(B, 600x600) → one entry**, with owner A,
    reserved still 16:9, state ready, and path/mime/size set (findings 2 and 5).
  - begin then fail → failed, reserved kept.
  - show with no handle and no prior entry → ready, owner = the show's message,
    reserved = measured dims.
  - Video show with null dims → reserved nil, so `box` gives 16:9.
  - An unknown action → no change.
  - `seq` increases by first sight; a second frame for the same id keeps its
    `seq`.
- **`showOutput`**
  - with dims;
  - without dims;
  - a path with spaces and parentheses (anchored on the LAST ` (`);
  - junk → nil.
- **`beginHandle`**: valid → hex; missing → nil.
- **`canonicalEntries`**
  - `media_begin` in A + `media_show` (handle) in B → one ready entry, owner A,
    begin geometry.
  - A show with no handle → id `media:s:<B>:<path>`.
  - An error-status show → none.
  - A begin with no show → none.
  - The output is identical when called twice.
- **`liveOnly`**: a live entry whose id is canonical is excluded; ordering is by
  `(seq, id)` with equal seq.
- **`TranscriptMediaGeometry`**
  - explicit dims beat aspect, which beats 16:9;
  - width capped at 520;
  - a 1:3 box capped at 480 high with its width shrunk;
  - `grid` for 0, 1, 3, 4 and 7.
- **`TranscriptFileParse`**
  - `file://` → `.boxPath`;
  - `data:` → `.dataURL`;
  - filename fallbacks;
  - `decodedSize` for padding cases 0, 1 and 2, and for a payload of
    26 214 401 decoded bytes, which is over the cap.
- **`TranscriptStagingKey.input`**
  - **the same path on two boxes gives different inputs**;
  - the same box and the same path give an equal input;
  - a server URL change gives a different input;
  - a path and a data URL never collide, because of the tag prefix.
- **`TranscriptPeekRequest.url(serverURL:path:)`** (Foundation `URLComponents`,
  no networking types):
  - the path is `/api/peek`;
  - the query encodes a path containing spaces, `#` and `&`;
  - a server URL with a trailing path segment is kept.

`MantaUITests/TranscriptMapperTests.swift` runs on the Mac, because it needs
`TranscriptBlock`.

- A user message with only a file part produces a `.file(.userFiles)` row and
  no text row.
- Media blocks come before the owner message's prose.
- Begin in A plus show in B, mapped with live data and then canonically, gives
  exactly one `media:h:` row each time, under A, with no `#dup` suffix.
- `liveMediaTail` excludes owners that are settled.
- `liveMediaTail` with an owner absent from `messages`: emitted when
  `isLiveWindow`, omitted when not.
- **Disjointness:** for one entry list and one message array, the ids from
  `blocks(…options:)` media and from `liveMediaTail` never intersect. The test
  covers a settled owner, an unsettled owner, an absent owner, and both values
  of `isLiveWindow`.
- Ids are identical across two mappings.
- `TranscriptFileStager` with an identity change clears its memory map. This is
  tested with an injected identity provider and file manager. The init has a
  test seam: `init(identity: @escaping () -> (String?, URL?), …)`.

### Acceptance

- [ ] A message with an attached image shows a chip above the prompt. Tapping it
      opens the image in QuickLook.
- [ ] A turn that calls `media_begin` then `media_show`, even from different
      steps, shows a pending box at its final size, then the image letterboxed
      in that same box. The transcript does not jump. There is exactly one
      card.
- [ ] After force-quitting and reopening, the image is still shown, under the
      same message.
- [ ] A video shows a poster and plays only after a tap.
- [ ] An orphaned `begin` ends as "The media failed to generate".
- [ ] A 30 MB file says "Too large to preview here (30 MB)". The phone fetches
      only the `HEAD`.
- [ ] After removing the server and pairing a different box, a chip with the
      same path shows the new box's file, not the cached one.

---

## F2 — "Show reasoning & full output" (desktop Ctrl+O)

### Desktop behaviour

- One toggle per chat panel, `showThinking`, default off and not persisted
  (`src/renderer/ChatPanel.tsx:973`). Ctrl+O flips it (`ChatPanel.tsx:1193-1202`).
  `/help` describes it as "ctrl+o — toggle reasoning / verbose tool output"
  (`ChatPanel.tsx:153`).
- **Off**: reasoning parts draw nothing and are transparent to tool-run grouping
  (`src/renderer/toolActivity.ts:388-391`).
- **On**: each non-blank reasoning part draws as muted italic text with an
  accent "✻ " gutter and a "Thinking…" caption (`ToolCall.tsx:116-134`). It splits
  the tool run it sits in. Tool bodies become verbose: Read shows its content,
  Bash shows all lines instead of 5, Grep shows its hits
  (`ToolBodies.tsx:98-132, 204-215`).

### Wire contract

Reasoning parts already arrive in `opencode:messages`:
`{id:"<msg>:reasoning:<n>", type:"reasoning", text, time?}`
(`opencodeV2.mjs:263-271`). No channel or frame is involved.

### What iOS has today

- `ToolActivity.layout(messages:running:showThinking:)` already implements the
  desktop rule (`ToolActivity.swift:662-710`). The mapper always passes
  `showThinking: false` (`ChatModels.swift:192`), and `process` ignores
  reasoning (`ChatModels.swift:419-441`).
- The Activity sheet shows only the last 12 lines / 2,000 characters of output
  (`ActivitySheet.swift:382`, `ToolOutputPreview` `ChatModels.swift:561-589`).

### iOS design

- **Preference.** The enum lives in the new Foundation-only
  `TranscriptDisplayOptions.swift`, which is in the Package manifest:
  ```swift
  enum TranscriptDisplayOptions {
    static let defaultsKey = "manta.transcript.showDetails"
    static let didChange = Notification.Name("TranscriptDisplayOptions.didChange")
    static var showDetails: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }   // default false
    static func setShowDetails(_ on: Bool)  // writes + posts didChange on the main queue
  }
  ```
  The setting is **persisted app-wide and off by default**, which is settled by
  D9.
- **Mapper:** the new `TranscriptMapOptions` (below) carries `showReasoning`. The
  existing overloads `blocks(from:)`, `blocks(from:voiceNotes:)` and
  `blocks(from:voiceNotes:widgets:)` forward
  `TranscriptMapOptions(showReasoning: TranscriptDisplayOptions.showDetails)`, so
  the subagent drill-in and every current call site follow the switch without
  any change. Layout is called with `showThinking: options.showReasoning`.
  `process` emits `.reasoning(TranscriptReasoning(id: part.id, text:))` for a
  non-blank reasoning part (blank text is trimmed of leading and trailing
  newlines, as in the desktop). Row id: `"r" + part.id`.
- **Row view `TranscriptReasoningView`:** a "Thinking…" caption (twoXS, tx4) over
  the text (small, italic, tx3, `.textSelection(.enabled)`), with an accent
  `sparkle` glyph at 60% opacity in a 16pt leading gutter. Padding matches prose.
- **Activity sheet (WS01):**
  - The toolbar gains `ToolbarItem(placement: .topBarLeading)` holding a `Menu`
    (`ellipsis.circle`, a11y "Display options"). It contains
    `Toggle("Show reasoning & full output", isOn:)`, bound through
    `@AppStorage(TranscriptDisplayOptions.defaultsKey)`. The setter calls
    `TranscriptDisplayOptions.setShowDetails` so `didChange` fires.
  - When on, `ActivityCallRow.detailView` shows **verbose** output through
    `ToolActivity.outputForDisplay(_:verbose: true)`.
    - **The output is not assumed to be bounded (finding 8).** The box's
      20,000-character cap applies only to live streamed chunks
      (`streamInterp.mjs:81, 410`). Canonical `state.output` has no cap.
    - The verbose view therefore shows the last
      `ToolOutputPreview.verboseMaxLines = 2_000` lines, hard-capped to the last
      `verboseMaxCharacters = 100_000` characters.
    - It keeps the same `"… \n"` prefix when trimmed, and adds a footnote line
      "Showing the last 2,000 lines — Copy gets the full output" (twoXS, tx4)
      whenever it was trimmed.
    - The well is a vertical `ScrollView` with `maxHeight: 480` inside the
      sheet row, so a huge output never sizes the row. The text uses
      `lineLimit(nil)`.
    - Copy (F5) always copies the full untrimmed text.
  - A completed `read` call is expanded by default when the switch is on. Expansion keeps
    `ActivityDisclosure`'s user-wins rule (`ToolActivity.swift:957`): the
    default is computed with a new `verbose` parameter, and the user's toggle
    still beats it.
  - When off: today's behaviour.
- **Second entry point:** a row in the chat overflow sheet (M-01-5, applied by
  WS07).
- **Live refresh:** the transcript re-maps when the switch changes, because
  `ChatSessionStore` observes `didChange` (M-01-3). Until WS02 lands, the
  Activity sheet changes instantly and reasoning rows appear on the next
  transcript fetch.

### Pure logic + tests

- Mapper with `showReasoning: false`: no reasoning rows, and a tool → reasoning →
  tool sequence stays one run (same as the existing desktop fixture).
- With `true`: reasoning row id `r<partID>`; the run splits in two, and the
  second run's id is its first part's id; blank reasoning produces no row.
- `ActivityDisclosure.expanded(… verbose:)`: a verbose completed `read`
  defaults to expanded; a user toggle overrides it.
- `ToolActivity.outputForDisplay(_:verbose:)` returns a `(text, trimmed)` pair:
  - When not verbose, it returns `ToolOutputPreview.tail(output)`.
  - When verbose, it returns output at or under 2,000 lines and 100,000
    characters unchanged with `trimmed == false`.
  - A 10,000-line output becomes the last 2,000 lines with `trimmed == true`.
  - A single 1,000,000-character line becomes the last 100,000 characters with
    `trimmed == true`.
  - These tests live in `TranscriptMapperTests.swift`, because `ToolActivity` is
    not in the Linux package.

### Acceptance

- [ ] With the switch off, nothing changes compared with today.
- [ ] Turning it on in the Activity sheet immediately shows full command output,
      up to the last 2,000 lines, with a note when trimmed. A 50,000-line output
      does not freeze the sheet.
- [ ] After the next transcript refresh (or immediately once WS02 lands), each
      turn's reasoning appears as "Thinking…" rows, split between tool runs as on
      the desktop.
- [ ] The setting survives an app relaunch.

---

## F3 — Collapsed `/command` user turns

### Desktop behaviour

- `src/renderer/MessageRow.tsx:204-239` `UserCommandBar`: a full-width row on the
  `bg-soft` band showing `›`, a chevron, `/name` in accent mono, and the trimmed
  args in muted mono (truncated). The tooltip is "Show expanded prompt" /
  "Collapse". Clicking toggles an indented, muted, mono block containing the full
  expanded prompt text (`concatUserMessageText`).
- Provenance, in order (`ChatPanel.tsx:2702-2740`): `info.command` (the box's
  durable record), else the live `commandExecuted` frame keyed by user message id.
  There is no text matching.
- "Inline" variant: a message whose own text starts with `/name` of a KNOWN
  command or skill (`parseSlashToken` against the composer's command catalog)
  stays a normal bubble with `/name` coloured (`MessageRow.tsx:450-454`).

### Wire contract

- `opencode:messages`: the box stamps `info.command = {name, arguments}` on user
  messages with a recorded origin (`src/server/commandOrigins.mjs:110-121`,
  applied at `src/server/opencode.mjs:511, 525`; the origin record is
  `{name, arguments, sessionId, at}`, `commandOrigins.mjs:91-92`; clients read
  only `name`/`arguments`).
- Stream frame `commandExecuted` `{messageID, name, arguments}`
  (`src/server/streamInterp.mjs:1037-1040`). `arguments` is always a string,
  `""` when absent. iOS does not decode it today. **Per D15, WS02 decodes it and
  publishes it** as
  `ChatSessionStore.commandByMessageID: [String: StreamCommandExecutedPayload]`,
  where `StreamCommandExecutedPayload { messageID: String; name: String; arguments: String }`
  (`02-chat-cards-queue.md` F11). WS01 does not declare a decoder.

### iOS design

- **Model.** `MantaModels.swift` is WS01-owned (D1). `OpencodeMessageInfo`
  gains `command: OpencodeCommandOrigin?`, where
  `struct OpencodeCommandOrigin: Codable, Equatable, Sendable { var name: String; var arguments: String? }`.
  `arguments` is optional because the durable record may lack it; WS01 reads it
  as `arguments ?? ""`.
- **Conversion from WS02's live map (finding 4).** The pure helper lives in
  `TranscriptTurns.swift`:
  ```swift
  enum TranscriptCommandOrigin {
    static func fromLive(name: String, arguments: String) -> OpencodeCommandOrigin   // "" → nil (same as WS02 F11's inline conversion)
    /// Durable info.command wins; live only fills a message with no durable origin.
    static func resolve(durable: OpencodeCommandOrigin?, live: OpencodeCommandOrigin?) -> OpencodeCommandOrigin?
  }
  ```
  `TranscriptMapOptions.liveCommands: [String: OpencodeCommandOrigin]` is filled
  by WS02 (M-01-1) as
  `store.commandByMessageID.mapValues { TranscriptCommandOrigin.fromLive(name: $0.name, arguments: $0.arguments) }`.
  WS01 never references WS02's type, so WS01 compiles in wave A1 before WS02
  exists.
- **New block** `.command(TranscriptCommandTurn)` (`TranscriptComponents.swift`):
  ```swift
  struct TranscriptCommandTurn: Equatable, Sendable { let messageID: String; let name: String; let arguments: String; let expandedText: String; let at: Date? }
  ```
  Row id: `"cmd-" + messageID`. Its timestamp is `at`, so the swipe gutter shows
  it like a user turn.
- **Mapper:** for a user message,
  `origin = TranscriptCommandOrigin.resolve(durable: msg.info.command, live: options.liveCommands[msg.info.id])`.
  If it is non-nil and has a non-empty `name`, emit `.command(...)` (with
  `expandedText = textParts(of:)`) instead of `.user(...)`. Voice-note and widget
  claims are unchanged.
- **View `TranscriptCommandRow`** (new `TranscriptCommand.swift`):
  - A full-bleed band like `UserBand` (`tokens.fill` background, 2px accent
    leading edge) showing `›`, `/name` (mono, accent), and args (mono, tx3, one
    line, tail-truncated), with a trailing `chevron.right` in tx4.
  - The whole row is a `Button` (a11y label "/name args", hint "Shows the full
    prompt").
  - **Tap opens a sheet** `TranscriptCommandSheet` with the navigation title
    "/name", a Done button, and the full `expandedText` in a `ScrollView` (mono,
    small, tx2, `.textSelection(.enabled)`). Detents are `.medium, .large`.
  - The desktop expands inline instead. iOS uses a sheet because inline
    expansion state would live in a recycled TiledView cell and change the row
    height. A sheet keeps the row height fixed (AGENTS §6).
- **Inline `/name` colouring: deferred.** It needs the slash-command catalog,
  which WS03 owns. Without the catalog, any text starting with `/word` (for
  example a path) would be coloured wrongly.

### Pure logic + tests

- A user message with `info.command` produces `.command` with name, arguments
  and expandedText; one without it produces `.user`; one with
  `liveCommands[id]` and no `info.command` produces `.command`; an empty name
  produces `.user`.
- `OpencodeMessageInfo` decoding (`TranscriptParityTests`, Linux):
  - `command` missing → nil;
  - well-formed → decoded;
  - `arguments` missing → nil;
  - malformed (for example `"command": 3`, `"tokens": "x"`) → nil, and the
    message still decodes;
  - the memberwise init is still available.
- `TranscriptCommandOrigin` (Linux):
  - `fromLive(name:"x", arguments:"")` → `arguments == nil`;
    `fromLive(name:"x", arguments:"a")` → `"a"`;
  - `resolve(durable: A, live: B)` → A, **durable precedence**;
  - `resolve(nil, B)` → B;
  - `resolve(nil, nil)` → nil.
- Row id `cmd-<messageID>` is stable across re-mapping.

### Acceptance

- [ ] Running a custom `/command` from the desktop shows on the phone as a single
      `› /name args` band, not the expanded template.
- [ ] Tapping the band shows the full prompt, which can be selected and copied.

---

## F4 — Turn footer (duration, tokens, truncated)

### Desktop behaviour

- `computeTurnInfo` (`src/renderer/chatUtils.ts:3093-3155`) treats a run of
  assistant messages after a user message, or after a background-result
  message, as one turn. A background result starts a new turn
  (`isBackgroundResultMessage`, `src/renderer/backgroundRun.ts:145-150`: either
  `info.background === true` or a `background-result` part).
  - Duration: first assistant `time.created` → last assistant `time.completed`,
    only if `>` 0.
  - Tokens: the sum of `info.tokens.output + info.tokens.reasoning` over every
    assistant message of the turn, shown only if `> 0`.
  - Verb seed: the turn's FIRST assistant message id.
  - The footer attaches to the turn's LAST assistant message. While `running`
    and that message is the transcript's last, no footer is shown.
- Footer (`MessageRow.tsx:519-557`), sans-serif, `text-label text-text-muted`:
  `<MantaMark> {pastVerb} for {formatDuration} · {formatTokens}`. Example:
  "Pondered for 1m44s · 12.4k tokens".
  - `pastVerbFor` (`src/renderer/chatShared.tsx:180-211`): hash
    `h = (h*31 + charCode) | 0` over the seed id, take `abs(h) % 12`, and index
    into `Cogitated, Ruminated, Pondered, Reflected, Considered, Deliberated,
    Mused, Contemplated, Generated, Forged, Brewed, Crafted`.
  - `formatDuration` (`chatUtils.ts:460-470`): `"<1s"` under 1000 ms; otherwise
    `Hh Mm Ss` with no spaces (`"2h3m4s"`, `"1m44s"`, `"59s"`), seconds rounded.
  - `formatTokens` (`chatUtils.ts:219-223`): `"512 tokens"`, `"12.4k tokens"`
    (one decimal, `.0` dropped) under 100k, `"148k tokens"` above.
- Truncation badge: a warn-tinted pill `⚠ {label}` whose tooltip is the `hint`.
  It sits after `·` on the footer line, or alone for a mid-turn message.
  Labels and hints come from `describeTruncation`
  (`src/shared/streamInterpretation.mjs:76-100`):
  - output-cap: "truncated (output limit)"
  - context-wall: "truncated (context full)"
  - tool-cutoff: "tool call cut off — retry needed"
- The desktop's per-message truncation comes only from the live `truncation`
  frame (`useSseBus.ts:721-731`), so it is lost on reload.

### Wire contract

- `opencode:messages` assistant `info` (`opencodeV2.mjs:233-250`) carries
  `tokens` (`{input, output, reasoning, cache:{read, write}}`), `finish` (V2's
  normalised finish), and `time.created/completed`.
- A `step-finish` part (`opencodeV2.mjs:276-289`) carries
  `reason = rawFinish ?? finish` and `tokens`.
- The box's own classification (`streamInterp.mjs:870-893`) is
  `classifyFinish(rawFinish ?? finish, {lastPartIsToolUse: finish === "tool-calls"})`
  (`streamInterpretation.mjs:53-73`).
- `truncation` frame `{kind, label, messageID?}`. iOS already decodes it as
  `StreamTruncationPayload` (`MantaStreamModels.swift:220-225`) and shows the
  latest one as a tail `.notice` (`ChatSessionStore.swift:952-954`, WS02).

### iOS design

- **Model (`MantaModels.swift`, WS01-owned per D1).** `OpencodeMessageInfo`
  gains:
  - `tokens: OpencodeTokenUsage?` (`input/output/reasoning: Double?`,
    `cache: {read, write: Double?}?`);
  - `finish: String?`.
  - It is decoded tolerantly; see **Model change**.
- **Truncation source: canonical first, live as fallback (finding 7).**
  - The canonical kind is derived from the **transcript**: the `step-finish`
    part's `reason`, falling back to `info.finish`, with
    `lastPartIsToolUse = info.finish == "tool-calls"`. That survives reload,
    which the desktop's does not.
  - The canonical source is not always available. The `step-finish` part exists
    only when the message has `tokens` (`opencodeV2.mjs:276`), and the mapper
    skips incomplete messages (`ChatModels.swift:189-191`). So the footer's
    **effective** kind is `canonical ?? live`, where `live` is
    `options.liveTruncation?.kind` when `options.liveTruncation?.messageID == m.id`.
  - **Round-2 redesign (finding 1): no new WS02 map.** WS02's F11 explicitly
    drops `truncationByMessageID` and keeps only its existing single
    `truncation: StreamTruncationPayload?`, which is the latest warning,
    `{kind, label, messageID?}` (`02-chat-cards-queue.md` F11;
    `ChatSessionStore.swift:203`). WS01 consumes exactly that property, which
    matches D15 ("no step/truncation property is required from WS02 … beyond
    what WS02 already decodes").
  - The single-value contract is a deliberate trade-off: an older warning whose
    message has no canonical `step-finish` metadata (no usage) may disappear after
    a newer warning arrives or after a reload. Acceptance is narrowed accordingly:
    the latest live warning always shows; older ones show only when the transcript
    carries the finish data.
  - The pure value lives in `TranscriptTurns.swift`:
    ```swift
    struct TranscriptLiveTruncation: Equatable, Sendable {
      let messageID: String; let kind: TranscriptTruncationKind
      /// nil when messageID is nil/empty or kind is not one of the three raw values.
      static func from(kind: String, messageID: String?) -> TranscriptLiveTruncation?
    }
    ```
    WS02 fills `TranscriptMapOptions.liveTruncation` with
    `truncation.flatMap { TranscriptLiveTruncation.from(kind: $0.kind, messageID: $0.messageID) }`
    (M-01-1). An unknown kind gives no badge.
- **Pure (new `TranscriptTurns.swift`, Foundation-only):**
  ```swift
  enum TranscriptTruncationKind: String, Sendable { case outputCap = "output-cap", contextWall = "context-wall", toolCutoff = "tool-cutoff" }
  enum TranscriptTruncation {
    static func classify(_ finish: String?, lastPartIsToolUse: Bool) -> TranscriptTruncationKind?   // classifyFinish port
    static func describe(_ k: TranscriptTruncationKind) -> (label: String, hint: String)            // verbatim copy
    static func kind(of message: OpencodeMessage) -> TranscriptTruncationKind?
  }
  struct TranscriptTurnInfo: Equatable, Sendable { let durationMs: Double?; let tokens: Double?; let verbSeedID: String }
  enum TranscriptTurns {
    /// computeTurnInfo port over the FULL message list (settled + in-flight):
    /// keyed by the turn's last assistant message id. A turn whose last assistant
    /// message has no time.completed, or (when `running`) is the transcript's
    /// last message, gets no entry.
    static func info(_ messages: [OpencodeMessage], running: Bool) -> [String: TranscriptTurnInfo]
    static func isBackgroundResult(_ m: OpencodeMessage) -> Bool
  }
  enum TranscriptTurnFormat {
    static func duration(ms: Double) -> String   // formatDuration
    static func tokens(_ n: Double) -> String    // formatTokens
  }
  enum TranscriptTurnVerb {
    static let past = ["Cogitated","Ruminated","Pondered","Reflected","Considered","Deliberated","Mused","Contemplated","Generated","Forged","Brewed","Crafted"]
    static let present = ["Cogitating","Ruminating","Pondering","Reflecting","Considering","Deliberating","Musing","Contemplating","Generating","Forging","Brewing","Crafting"]
    /// Int32 wrapping arithmetic over `id.utf16`; magnitude via Int64 so Int32.min cannot trap.
    static func index(for id: String) -> Int
  }
  struct TranscriptTurnFooter: Equatable, Sendable {
    let messageID: String            // the message the footer follows
    let summary: String?             // "Pondered for 1m44s · 12.4k tokens" (nil if no duration)
    let truncation: TranscriptTruncationKind?   // the EFFECTIVE kind (canonical ?? live)
    let isTurnEnd: Bool              // true only for the last assistant message of a FINISHED turn (turns[id] != nil)
    let turnText: String             // the turn's prose joined "\n\n" — feeds F6; "" when !isTurnEnd
  }
  enum TranscriptFooterRule {
    /// Pure emission predicate (round 2, finding 2).
    static func shouldEmit(finishedTurn: Bool, effectiveTruncation: TranscriptTruncationKind?) -> Bool   // finishedTurn || effectiveTruncation != nil
  }
  ```
  `present` is exported so WS02 can make `RunningIndicator`'s verb match the
  footer, which is the desktop rule. RunningIndicator currently uses a random
  verb (`RunningIndicator.swift:33-39`, WS02-owned). That alignment is optional
  for WS02.
- **Mapper.** First compute `turns = TranscriptTurns.info(messages, running: options.running)`
  over ALL messages, before filtering to `settled`.
  - Like the desktop (`chatUtils.ts:3137-3151`), `turns` has an entry for every
    FINISHED turn's last assistant message, even when its duration is nil. It
    has none for a turn still running.
  - For each settled assistant message `m`, after its blocks and widgets:
    1. `effective = TranscriptTruncation.kind(of: m) ?? live(m)`, computed
       BEFORE deciding emission.
    2. `finishedTurn = turns[m.id] != nil`.
    3. Emit `.turnFooter` iff
       `TranscriptFooterRule.shouldEmit(finishedTurn:effectiveTruncation:)`.
  - Field values:
    - `isTurnEnd = finishedTurn`.
    - `summary` is set only when `finishedTurn` and the duration is non-nil:
      `"\(past) for \(duration)"`, plus `" · \(tokens)"` when tokens > 0.
    - `turnText` is filled only when `finishedTurn`.
  - So:
    - a mid-turn or running-turn warning gives a **warning-only** row, with no
      summary and no reply menu;
    - a completed last step while the session is still `running` gives no
      footer (no entry in `turns`);
    - the old "last message with prose" condition is removed, because it is
      subsumed by `finishedTurn`.
  - Row id: `"tf-" + messageID`.
- **View `TranscriptTurnFooterView`:** one line, `Metrics.type.xs`, tx3, padded
  like prose.
  - `MantaLogoMark(size: 12)` followed by the summary.
  - If truncated: `·`, then a pill with `exclamationmark.triangle.fill` and the
    label (warn text, `tokens.warn.opacity(0.12)` background, warn 33% border,
    `Metrics.radius.xs`). The pill is a `Button`; tapping it shows the hint in a
    `.popover` with `.presentationCompactAdaptation(.popover)`.
  - Trailing `Spacer`, then the F6 reply menu, only when `isTurnEnd`.
  - `.lineLimit(1)` with the summary tail-truncated; the pill never truncates.
- **No duplicate notice, and no lost warning (finding 7).** The mapper exposes
  the warnings that are actually on screen:
  `static func footerTruncationMessageIDs(_ blocks: [TranscriptBlock]) -> Set<String>`,
  meaning the `messageID`s of the `.turnFooter` blocks whose `truncation != nil`.
  WS02 (M-01-4) skips its tail truncation `.notice` **only** when
  `truncation.messageID` is in that set for the blocks it is rendering. In every
  other case the notice stays, including:
  - an incomplete message;
  - a message with missing usage and no live entry;
  - a message outside the loaded window;
  - a nil `messageID`.

### Pure logic + tests

- `TranscriptTurnFormat.duration`: 0 → "<1s", 999 → "<1s", 1000 → "1s",
  59_499 → "59s", 104_000 → "1m44s", 7_384_000 → "2h3m4s".
- `TranscriptTurnFormat.tokens`: 512 → "512 tokens", 1000 → "1k tokens",
  12_400 → "12.4k tokens", 99_960 → "100k tokens" (desktop `toFixed` parity),
  148_000 → "148k tokens".
- `TranscriptTurnVerb.index` matches the desktop for fixed ids. The test
  computes the expected values by running the JS formula with `node -e`, and the
  implementer pastes them in; include `"msg_01"` and a string whose JS hash is
  negative.
- `TranscriptTruncation.classify`: `max_tokens`/`length` → outputCap (toolCutoff
  with the flag); `MODEL_CONTEXT_WINDOW_EXCEEDED` lowercased → contextWall;
  `end_turn`/`stop`/`tool-calls`/nil → nil. `describe` returns the exact strings.
- `TranscriptTurns.info`:
  - user, a1, a2, user, a3 gives footers on a2 and a3; a2's duration spans
    a1.created→a2.completed; tokens sum output+reasoning across a1 and a2; the
    seed is a1.
  - A background-result message splits turns.
  - `running: true` suppresses the footer on the transcript's last message only.
  - An in-flight last assistant message gives no footer for its turn.
- Mapper tests (Mac):
  - `.turnFooter` follows the last block of the turn.
  - A mid-turn truncated message gets a footer with `summary == nil`.
  - Ids are stable.
  - **A live truncation for message M, then an incomplete transcript snapshot of
    M** gives no footer for M and M is not in `footerTruncationMessageIDs`, so
    WS02 keeps the notice.
  - **A completed M with no `step-finish` part (missing usage) plus
    `liveTruncation = (M, outputCap)`** gives a footer with the live kind, and M
    is in the set.
  - **Live-only truncation on a NON-final message** (M is a mid-turn step with
    no usage and the turn continues with N) gives a warning-only footer on M:
    `isTurnEnd == false`, `summary == nil`, no menu. M is in the set (round 2,
    finding 2).
  - **A completed last step with prose while `running: true`** gives no footer
    and no reply menu (round 2, finding 2).
  - `liveTruncation` for a different message id does not affect M.
  - **A completed M with no `step-finish` and no live entry** gives no badge,
    and M is not in the set.
  - Canonical beats live when both exist and differ.

`TranscriptTurns`, `TranscriptTruncation`, `TranscriptTurnFormat`,
`TranscriptTurnVerb`, `TranscriptLiveTruncation.from` (nil message id,
unknown kind, valid) and `TranscriptFooterRule.shouldEmit` (four
combinations) tests are pure, so they run on Linux in
`TranscriptParityTests.swift`.

### Acceptance

- [ ] Every finished turn ends with "<Verb> for <duration> · <N> tokens", with the
      same verb the desktop shows for that turn.
- [ ] A reply cut off by the output limit shows "⚠ truncated (output limit)";
      tapping it explains what to do. It is still there after reopening the chat.
- [ ] No footer appears under a turn that is still running.

---

## F5 — Copy buttons (code blocks, tool output)

### Desktop behaviour

- `src/renderer/CopyButton.tsx:19-82`: a small icon button with title and aria
  "Copy". On success the icon becomes a check for 1.5 s. If the clipboard is
  blocked, nothing happens.
- Code blocks (`src/renderer/MarkdownBody.tsx:353-363`) have a language header
  and a Copy button in the top-right corner. Copied text is the code with its
  trailing newline trimmed.
- Tool cards have Copy in the card header (`ToolCard.tsx:44-75`). What is copied
  (`ToolCall.tsx:277-278`) is `diffText ?? resolveToolOutput(state)`; `task`
  gives nothing (no button). Patch cards copy the file list (`ToolCall.tsx:197`).

### Wire contract

None: this is client-only, using the clipboard.

### What iOS has today

- **Code blocks already have Copy.** `MantaProse` renders through MarkdownView's
  `MarkdownText` (`TranscriptComponents.swift:68-104`). With no
  `markdownCodeBlockStyle` set, code blocks use the library's
  `DefaultCodeBlockStyle`, which draws the language name and a "Copy" → "Copied"
  button writing `UIPasteboard.general.string`. Source: MarkdownView 3.0.0
  `Sources/MarkdownView/Styles/Code Blocks/DefaultCodeBlockStyle.swift:62-80, 189-230`.
  In `MarkdownText` code blocks are hosted views
  (`MarkdownTextConverter+Attachment.swift` → `MarkdownStyledCodeBlock`), so the
  button is live. The pinned version is in
  `MantaUI.xcodeproj/.../Package.resolved` (3.0.0, RichText 1.0.0).
- Tool output: the Activity sheet's code wells are `.textSelection(.enabled)` but
  have no Copy button (`ActivitySheet.swift:353-412`).

### iOS design

- **Code blocks: verify only, no code change.** The acceptance item below checks
  on a device that the library button copies.
  **Fallback**, only if it does not work on device: add a
  `TranscriptCodeBlockStyle: MarkdownCodeBlockStyle` in a new
  `TranscriptCodeBlock.swift`, applied in `MantaProse` with
  `.markdownCodeBlockStyle(...)`. It would show the language label (twoXS,
  uppercase, tx4), the shared `TranscriptCopyButton`, and a horizontal
  `ScrollView` with mono xs `.textSelection(.enabled)`, on `tokens.inset` with a
  `tokens.border` stroke and `Metrics.radius.xs`. That fallback loses Highlightr
  colouring, which is why it is a fallback only.
- **`TranscriptCopyButton`** (new `TranscriptCopy.swift`): `doc.on.doc` →
  `checkmark` for 1.5 s, a11y label "Copy". On copy it posts
  `UIAccessibility.post(notification: .announcement, argument: "Copied")` and
  plays `.sensoryFeedback(.success, trigger:)`. It sets
  `UIPasteboard.general.string`, which cannot fail, so there is no error state.
  44pt hit target.
- **Tool output:**
  - In `ActivityCallRow.detailView`, when `ToolActivity.copyText(of: part)` is
    non-nil, show a top-right `TranscriptCopyButton` (an `HStack { Spacer();
    TranscriptCopyButton(text:) }`) above the wells.
  - It copies the FULL text, never the 12-line preview.
  - The button appears only when the row is expanded, since that is where the
    content is. The collapsed header stays a single tap target.
- **Pure `ToolActivity.copyText(of:) -> String?`** (`ToolActivity.swift`):
  - `task` → nil.
  - patch → files joined with `\n`.
  - otherwise `detail.diff ?? detail.output`, and nil when empty.

### Tests (`TranscriptMapperTests.swift`, Mac: `ToolActivity` is not in the Linux package)

`copyText` for bash (full output, not the tail, checked with 40 lines),
edit-with-diff (the diff), write (nil when the output is empty), patch (file
list), task (nil), and a running tool with only `metadata.output` (that output).

### Acceptance

- [ ] On device, tapping Copy on a code block in an assistant reply puts exactly
      the code on the clipboard and shows "Copied".
- [ ] In the Activity sheet, an expanded command shows a Copy button that copies
      its full output (verified with output longer than 12 lines).
- [ ] VoiceOver announces "Copied".

---

## F6 — Quote / Quote in new session

### Desktop behaviour

- `src/renderer/hooks/useTranscriptSelection.ts` and `QuoteToolbar.tsx:13-56`:
  when the user finishes selecting text in the transcript, a floating bar
  offers "Quote" and "Quote in new session".
  - Quote prepends `buildQuoteBlock(selection)` (`chatUtils.ts:563-590`), one
    middle-truncated `> …` line plus a blank line, to the composer and focuses
    it (`ChatPanel.tsx:2427-2456`).
  - Quote in new session forks the session and seeds the fork's composer
    (`ChatPanel.tsx:2120-2139`).

### What iOS has today (the plumbing works, the trigger is missing)

- `QuoteDestination`, the `QuoteText` port and its tests already exist:
  `SessionModels.swift:967-1006`, `SessionModelsTests.swift:920-978`. The phone
  budget is 160/95/55 characters.
- `ChatScreen.quote(_:into:)` (`ChatScreen.swift:999-1011`) prepends to the
  composer, or forks with a seed (`forkSession(seed:)`,
  `ChatScreen.swift:966-993`).
- It is wired into `TranscriptCardActions.onQuote` (`ChatScreen.swift:1433-1435`,
  `TranscriptRow.swift:162-163`).
- **Nothing calls `onQuote`.** The whole-row `.contextMenu` from BET-1353 was
  removed in `a18a2bc4` because it took long-press away from native text
  selection. The intended replacement was a hook into the edit menu (BET-1364).
  It was never built, because `MarkdownText`'s `UITextView` delegate is owned by
  RichText 1.0.0 (`_TextView_UIKit.swift`), so no per-view edit-menu hook
  exists.

### iOS design — the turn's reply menu plus a select-and-quote sheet

#### Explicit quote capability (finding 1)

`cards != nil` does NOT mean the surface is writable. The subagent drill-in
injects a non-nil `TranscriptCardActions.readOnly(...)`
(`ChatScreen.swift:1616-1619`), whose `onQuote` does nothing
(`TranscriptRow.swift:221`). So the change in `TranscriptRow.swift` (WS01) is:

```swift
let onQuote: ((String, QuoteDestination) -> Void)?   // was non-optional; nil = this surface cannot quote
```

- `readOnly(...)` passes `onQuote: nil`.
- The `init` parameter becomes `onQuote: ((String, QuoteDestination) -> Void)? = nil`.
- The existing call site, `ChatScreen.swift:1433-1435`, passes a closure
  literal, which promotes to the optional. **No ChatScreen edit is needed.**
- The capability is `TranscriptQuoteCapability.canQuote(cards) = cards?.onQuote != nil`,
  a tiny helper next to the type. Both quote surfaces gate on it: the reply menu
  items and the select sheet's edit-menu items.

#### Reply menu

`TranscriptTurnFooterView` (F4) ends with a SwiftUI `Menu`:

- Icon `ellipsis` in tx4, with a 44pt hit target.
- Accessibility label "Reply actions".
- A tap opens it, so long-press and native text selection are untouched.

Items:

1. **"Quote"** calls `onQuote(footer.turnText, .thisSession)`. It is shown only
   when `canQuote` and `turnText` is non-empty.
2. **"Quote in new session"** calls `onQuote(footer.turnText, .newSession)`.
   It has the same gating.
3. **"Select text…"** presents `TranscriptSelectTextSheet`. It is shown when
   `turnText` is non-empty. Copying is read-only, so it is available on
   read-only surfaces too.

If no item is shown, no menu is rendered. The menu exists only on footers with
`isTurnEnd == true`. A warning-only footer (mid-turn, or while running) has
`turnText == ""`, so it gets no menu.

`turnText` is the turn's `.prose` texts joined with `"\n\n"`.
`QuoteText.buildQuoteBlock`, which `ChatScreen.quote` already uses, collapses it
and middle-truncates it to one line. That is the existing iOS quote format (D4).

#### `TranscriptSelectTextSheet` (new `TranscriptSelectText.swift`)

- Title "Select text", a Done button, detents `.medium, .large`.
- The body is `TranscriptSelectableTextView`: a `UIViewRepresentable` around a
  `UITextView` with these settings:
  - `isEditable = false`, `isSelectable = true`, `isScrollEnabled = true`;
  - text is `turnText` as
    `AttributedString(markdown:options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))`,
    falling back to plain text;
  - body manta font, tx1.
- **WS01 owns the delegate.** Its
  `textView(_:editMenuForTextIn:suggestedActions:)` (iOS 16+) returns:
  - `UIMenu(children: [quote, quoteInNewSession] + suggestedActions)` when
    `canQuote` is true;
  - `nil`, meaning the system menu, otherwise.
- The selection comes from `TranscriptSelection.text(in:range:)`. The sheet
  dismisses first, then calls `onQuote(selection, destination)`.
- **Presentation** is cell-local (`.sheet(isPresented:)`, the precedent at
  `WidgetCard.swift:123`). `onQuote` already reaches ChatScreen through the
  `transcriptCardActions` environment.

#### Destinations (D12)

- **"Quote"** goes through the existing `ChatScreen.quote(_:into: .thisSession)`
  (`ChatScreen.swift:999-1011`). It prepends the quote line and focuses the
  composer. Nothing is sent.
- **"Quote in new session"** keeps desktop parity per **D12**. It FORKS the
  current session and seeds the fork's composer with the quote, through the
  existing `ChatScreen.quote(_:into: .newSession)` → `forkSession(seed:)`
  (`ChatScreen.swift:966-993`).
  - It does not use `NewSessionDraft`.
  - The seed lands in the fork's composer and is **never auto-sent**: it reaches
    the fork's composer through `SessionOpenTarget.seed`.
  - The only new code is the button wiring.
- **Feedback.** "Quote" visibly fills and focuses the composer. "Quote in new
  session" navigates to the fork. A failed fork shows
  "Fork failed — nothing was created" (`ChatScreen.swift:977-983`).

Quoting from user bands is deferred; see Deferred.

### Pure logic + tests

- `TranscriptSelection.text(in:range:)` is pure and Foundation-only, so it is in
  `TranscriptParityTests` (Linux):
  - valid range → the substring;
  - zero length → nil;
  - out of bounds → clamped, or nil when empty;
  - an emoji-containing string with an `NSRange` never splits a character
    (`Range(nsRange, in:)`).
- `TranscriptTurnFooter.turnText` (Mac): two prose blocks are joined with a
  blank line; tool runs are excluded.
- **Action availability (Mac, `TranscriptMapperTests`):**
  - `TranscriptQuoteCapability.canQuote(.readOnly())` → false;
  - `canQuote(.readOnly(onOpenActivity: {_ in}))` → false;
  - `canQuote(nil)` → false;
  - live actions with an `onQuote` closure → true.
  - `TranscriptReplyMenuModel.items(canQuote:turnText:)`, a pure helper that
    returns the item list:
    - read-only → `[.selectText]`;
    - live → `[.quote, .quoteNewSession, .selectText]`;
    - empty text → `[]`.
- Existing `QuoteText` tests stay unchanged.

### Acceptance

- [ ] Under any finished reply, ⋯ → Quote puts `> <reply…>` at the top of the
      composer and focuses it. Nothing is sent.
- [ ] ⋯ → Quote in new session opens a fork whose composer holds the quote,
      unsent.
- [ ] ⋯ → Select text… allows selecting part of the reply. The edit menu shows
      Quote and Quote in new session before Copy, and Quote inserts only the
      selected words.
- [ ] Long-pressing prose in the transcript still selects text natively (no
      regression of BET-1363).
- [ ] In a subagent drill-in, ⋯ offers only "Select text…", and that sheet's
      edit menu shows no Quote items.

---

## Model change (`MantaModels.swift`, WS01-owned per D1)

```swift
struct OpencodeTokenUsage: Codable, Equatable, Sendable {
  var input: Double?; var output: Double?; var reasoning: Double?; var cache: Cache?
  struct Cache: Codable, Equatable, Sendable { var read: Double?; var write: Double? }
}
struct OpencodeCommandOrigin: Codable, Equatable, Sendable { var name: String; var arguments: String? }
// OpencodeMessageInfo gains:
var tokens: OpencodeTokenUsage?
var finish: String?
var command: OpencodeCommandOrigin?
```

- **Decoding is tolerant.** A custom `init(from:)` and `encode(to:)` are placed
  in an **extension**, which keeps the memberwise init that tests and fixtures
  use (`RootView.swift`, `MantaUITests`).
  - The existing keys decode exactly as today.
  - The three new keys use `try? container.decodeIfPresent(...)`, so a malformed
    value is nil. It never fails the message, and therefore never fails the
    transcript.
- `MantaModels.swift` is already in `Package.swift`, so its tests run under
  `verify.sh`.

## Mapper contract (all features)

`ChatModels.swift` gains:

```swift
struct TranscriptMapOptions: Equatable, Sendable {
  var showReasoning: Bool = false
  var running: Bool = false
  var liveCommands: [String: OpencodeCommandOrigin] = [:]          // user messageID → origin (from WS02 commandByMessageID)
  var liveTruncation: TranscriptLiveTruncation? = nil              // WS02's existing single `truncation`, converted (F4)
  var liveMedia: [TranscriptMediaEntry] = []                       // this session's live entries (session-wide, NOT keyed by message)
  static var current: TranscriptMapOptions { .init(showReasoning: TranscriptDisplayOptions.showDetails) }
}
extension ChatTranscriptMapper {
  static func blocks(from: [OpencodeMessage], voiceNotes: [VoiceNote], widgets: [WidgetRef], options: TranscriptMapOptions) -> [TranscriptBlock]
  static func liveMediaTail(messages: [OpencodeMessage], live: [TranscriptMediaEntry], isLiveWindow: Bool) -> [TranscriptBlock]
  static func footerTruncationMessageIDs(_ blocks: [TranscriptBlock]) -> Set<String>
}
```

The existing three `blocks(from:…)` overloads forward `.current`.

**Block order for one turn:**

1. user files
2. `.user` or `.command`
3. voice note
4. user widgets
5. for each settled assistant message, in this order:
   1. its owned media, ordered by `(seq, id)`;
   2. the layout blocks (runs, prose, reasoning, handoff);
   3. widgets;
   4. the footer.

**New `TranscriptBlock` cases:**

| Case | Row id |
|---|---|
| `.command(TranscriptCommandTurn)` | `cmd-<msgID>` |
| `.reasoning(TranscriptReasoning)` | `r<partID>` |
| `.turnFooter(TranscriptTurnFooter)` | `tf-<msgID>` |

**New `TranscriptAttachment.Kinds`:**

| Kind | Row id |
|---|---|
| `.userFiles(TranscriptUserFiles)` | `f` + `ufiles:<msgID>` |
| `.media(TranscriptMediaEntry)` | `f` + `entry.id` |

`timestamp` returns `at` for `.command` and nil for the other new kinds.

## Files

**Edit (owned):**

- `ChatModels.swift`:
  - the options type, the new overload, `liveMediaTail` and
    `footerTruncationMessageIDs`;
  - user-file, command, media, reasoning and footer emission;
  - update the BET-1029 comments.
- `TranscriptComponents.swift`: new `TranscriptBlock` cases and `timestamp`;
  new `TranscriptAttachment.Kinds`.
- `TranscriptRow.swift`:
  - ids and rendering for the new cases;
  - `onQuote` becomes optional;
  - `readOnly` passes nil;
  - `TranscriptQuoteCapability`.
- `ToolActivity.swift`: `copyText(of:)` and `outputForDisplay(_:verbose:)`.
- `ChatModels.swift` `ToolOutputPreview`: the `verboseMaxLines` and
  `verboseMaxCharacters` constants.
- `ActivitySheet.swift`:
  - the display-options menu;
  - verbose output in a bounded scroll well;
  - the copy button;
  - the `ActivityDisclosure` verbose default.
- `MantaModels.swift`: see **Model change**.
- `MantaUIApp.swift`: one line next to line 39,
  `TranscriptMediaStore.shared.bind(eventStore: event)`.

**Create — pure, Foundation-only (Package manifest):**

- `TranscriptMediaModel.swift`: entry, frame, identity, session state,
  parse, reconcile, geometry, file refs/parse, `TranscriptStagingKey.input`,
  `TranscriptPeekRequest.url`. No `URLRequest`, no hashing.
- `TranscriptTurns.swift`: `TranscriptTruncationKind`, `TranscriptTruncation`,
  `TranscriptLiveTruncation`, `TranscriptFooterRule`, `TranscriptTurns`,
  `TranscriptTurnFormat`, `TranscriptTurnVerb`, `TranscriptTurnFooter` (model),
  `TranscriptCommandOrigin`, `TranscriptSelection`.
- `TranscriptDisplayOptions.swift`.

**Create — UI / app (Mac only):**

- `TranscriptMediaStore.swift`.
- `TranscriptMediaCard.swift`.
- `TranscriptFiles.swift`: user-file chips and `TranscriptQuickLook`.
- `TranscriptFileStager.swift`.
- `TranscriptReasoning.swift`: the model and `TranscriptReasoningView`.
- `TranscriptCommand.swift`: the row and sheet.
- `TranscriptTurnFooterView.swift`: the footer view, the reply menu and
  `TranscriptReplyMenuModel`. The footer MODEL is in the pure
  `TranscriptTurns.swift`.
- `TranscriptSelectText.swift`.
- `TranscriptCopy.swift`.
- `MantaAPIClient+Transcript.swift`: see **Client members**.

**Create — tests:**

- `MantaUITests/TranscriptParityTests.swift`: pure; Linux and Mac.
- `MantaUITests/TranscriptMapperTests.swift`: mapper, `ToolActivity`, action
  availability and stager; Mac only.

**Fallback only:** `TranscriptCodeBlock.swift` (F5).

WS01 does not edit `project.yml` or the `.pbxproj`. The folder entry picks up new
files, and the `.pbxproj` is regenerated at the end by the orchestrator (D18).

### Package manifest (for the wave-A integration step, D18/D19)

- Add to `targets[0].sources`:
  - `TranscriptMediaModel.swift`
  - `TranscriptTurns.swift`
  - `TranscriptDisplayOptions.swift`
- Add to the test target: `TranscriptParityTests.swift`.
- Dependencies are `MantaModels.swift` and `ChatJSON.swift` only, both already
  listed.
- Gate: `mobile/native/verify.sh` passes.

## Client members (C1 / D16)

These go in the new `MantaAPIClient+Transcript.swift`. The names were checked
with `grep` against every other spec in this folder: no other spec declares
them.

```swift
extension MantaAPIClient {
  /// HEAD /api/peek?path= → content-length, or nil when the header is absent. Throws authRequired on 401, server(msg) on ≥400.
  func peekFileSize(path: String) async throws -> Int64?
  /// GET /api/peek?path= streamed to `destination` via `URLSession.bytes(for:)`, written in 64 KiB
  /// chunks through a FileHandle — disk, never memory. Aborts AS SOON AS the running byte count
  /// exceeds maxBytes (cancels the task, deletes the partial file) — not after the download — and
  /// also refuses up front when response.expectedContentLength > maxBytes. Throws
  /// TranscriptFileStager.Failure.tooLarge, CancellationError (reset/cancel), authRequired on 401,
  /// server(msg) on ≥400.
  func downloadPeekFile(path: String, to destination: URL, maxBytes: Int64) async throws
}
```

- **Auth.** `tokenProvider` and `session` are `private` in
  `MantaAPIClient.swift:5-6` and must not be edited (C1). So these two members
  build their request with the internal `serverURL` plus the token from
  `KeychainCredentialStore.shared.boxToken`. That is the same source
  `MantaAPIClient.live()` uses as its default `tokenProvider`
  (`MantaAPIClient.swift:9`).
- They use `URLSession.shared`.
- **Portability (round 2, finding 3).** `URLRequest` is a FoundationNetworking
  type on Linux (see the note in `MantaError.swift:3-5`). So the split is:
  - Only the URL is pure: `TranscriptPeekRequest.url(serverURL:path:) -> URL?`,
    built from `URLComponents` in `TranscriptMediaModel.swift`, Foundation-only,
    tested on Linux.
  - The `URLRequest` (method, `Authorization: Bearer`) is assembled inside
    `MantaAPIClient+Transcript.swift`, which is app-only and not in the
    package. Its auth-header and method behaviour is tested on the Mac in
    `TranscriptMapperTests.swift` through an internal
    `static func peekRequest(url:method:token:) -> URLRequest`, declared in
    that same extension file.

No other client member is added or changed. `peekFile(path:)` stays as it is
(WS07 uses it).

## Mount requests (D18)

The IDs, appliers, waves and symbols match the master's canonical mount ledger
(`00-master.md`). Provider symbols are WS01's exact current
names. The WS02 symbols consumed are WS02's exact current names from F11:
`commandByMessageID: [String: StreamCommandExecutedPayload]`, the existing
`truncation: StreamTruncationPayload?`, and `presentedMessages` (F10).

| ID | Receiving file | Applier (D18) | Provider symbol(s) | Exact change | Prerequisite |
|---|---|---|---|---|---|
| M-01-1 | `ChatSessionStore.swift` | WS02 (wave B) | `TranscriptMapOptions`, `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:options:)`, `TranscriptCommandOrigin.fromLive(name:arguments:)`, `TranscriptLiveTruncation.from(kind:messageID:)`, `TranscriptMediaStore.shared.entries(for:)`, `TranscriptDisplayOptions.showDetails` | Replace the three `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:)` calls (`fetchTranscript` ~1064, `refreshVoiceNotes` ~1111, `refreshWidgets` ~1137) with one private `func mapOptions() -> TranscriptMapOptions` and the `options:` overload, mapping **`presentedMessages`**. The value is `TranscriptMapOptions(showReasoning: TranscriptDisplayOptions.showDetails, running: running, liveCommands: commandByMessageID.mapValues { TranscriptCommandOrigin.fromLive(name: $0.name, arguments: $0.arguments) }, liveTruncation: truncation.flatMap { TranscriptLiveTruncation.from(kind: $0.kind, messageID: $0.messageID) }, liveMedia: TranscriptMediaStore.shared.entries(for: sessionId))`. **No `truncationByMessageID` is needed** (round-2 redesign; WS02 F11 drops it). WS02's existing inline conversion, `OpencodeCommandOrigin(name:, arguments: isEmpty ? nil : …)`, is value-identical to `fromLive` and also compiles; `fromLive` is preferred. | WS01 merged (A1); WS02 F11 `commandByMessageID`; WS02 F10 `presentedMessages` |
| M-01-2 | `ChatSessionStore.swift` | WS02 (wave B) | `ChatTranscriptMapper.liveMediaTail(messages:live:isLiveWindow:)` | In `rebuildBlocks`, append `ChatTranscriptMapper.liveMediaTail(messages: presentedMessages, live: TranscriptMediaStore.shared.entries(for: sessionId), isLiveWindow: presentedMessages.last?.info.id == messages.last?.info.id)` after `liveTranscript` and BEFORE the live prose tail and `trailing`, in both branches, through `uniqueTranscriptRows`. **Use the same `presentedMessages` array as M-01-1**; that is what keeps the two media segments disjoint (F1). | M-01-1 |
| M-01-3 | `ChatSessionStore.swift` | WS02 (wave B) | `TranscriptMediaStore.shared.$sessions`, `TranscriptDisplayOptions.didChange` | Next to the widget sink (`ChatSessionStore.swift:445-450`), add two subscriptions: `TranscriptMediaStore.shared.$sessions.map { $0[sessionId] }.removeDuplicates()` and `NotificationCenter.default.publisher(for: TranscriptDisplayOptions.didChange)`. Each calls the private `remap()`, which re-maps `transcript` from `presentedMessages` with `mapOptions()` under the same no-blank-clobber guard as `refreshWidgets` (`:1133-1141`), then calls `rebuildBlocks()`. Also call `remap()` when `commandByMessageID` or `truncation` changes, and when `running` flips to false. | M-01-1 |
| M-01-4 | `ChatSessionStore.swift` (`trailingBlocks`, `rebuildBlocks`) | WS02 (wave B) | `ChatTranscriptMapper.footerTruncationMessageIDs(_:)` | Add a parameter `footerTruncationIDs: Set<String> = []` to `trailingBlocks`, and pass `ChatTranscriptMapper.footerTruncationMessageIDs(liveTranscript)` from `rebuildBlocks`. Skip the truncation `.notice` **only** when `truncation.messageID` is non-nil and in that set. The rule "the message exists in `messages`" is **replaced**, not kept. Required tests in `ChatStreamMergeTests`: (1) empty set → notice kept; (2) set contains M and the truncation is on M → notice omitted; (3) **integration**: a live truncation on M, then a transcript snapshot where M is incomplete (`time.completed == nil`), run through the real `mapOptions()` → `blocks(options:)` → `footerTruncationMessageIDs` → `trailingBlocks` → notice kept. | M-01-1 |
| M-01-5 | `ChatOverflowSheet.swift` | WS07 (wave B) | `TranscriptDisplayOptions.defaultsKey`, `TranscriptDisplayOptions.setShowDetails(_:)`, both declared in **`TranscriptDisplayOptions.swift`** (WS01, A1) | After the "Trust mode" toggle (`ChatOverflowSheet.swift:116-131`), add a `Toggle` "Show reasoning & full output" with the subtitle "Thinking steps and complete tool output", bound with `@AppStorage(TranscriptDisplayOptions.defaultsKey) var showDetails = false` and `Binding(get: { showDetails }, set: { TranscriptDisplayOptions.setShowDetails($0) })`. Show it regardless of `isReadOnlyJob`. No new parameter, no ChatScreen change. (WS07's receipt row M-01-5 matches.) | WS01 merged (A1) |
| M-01-6 | `mobile/native/Package.swift` | Integration agent A (after A2) | the WS01 package manifest (below) | Add the three sources to `targets[0].sources` and the one test file to the test target. `verify.sh` must pass. | WS01 merged |

**Superseded IDs, for ledger cleanup:**

- The round-0/1 `M1`/`M2` (`MantaModels.swift`, `MantaUIApp.swift`) are WS01's
  own edits under D1.
- `M3a`–`M3d` are renamed `M-01-1`–`M-01-4`, with the symbols above.
- `M3e` (the command decoder) is withdrawn; per D15, WS02 F11 owns it.
- `M4` is now `M-01-5`.
- WS02's receipt rows now carry M-01-1 to M-01-4 verbatim (reconciliation
  after round 2); the `entries[sessionId]` / `$entries` / "message exists"
  forms are gone.

### Package manifest (M-01-6)

- Sources:
  - `TranscriptMediaModel.swift`
  - `TranscriptTurns.swift`
  - `TranscriptDisplayOptions.swift`
- Test: `TranscriptParityTests.swift`.
- Dependencies: `MantaModels.swift` and `ChatJSON.swift`, both already listed.
- None of these files uses `URLRequest`, `URLSession`, CryptoKit, SwiftUI or
  UIKit (round 2, finding 3).

## Mounts applied by this workstream

**None.** I cross-checked every mount table in `02`–`10`. The only request
targeting a WS01-owned file is M-02-1. Its receiving file is
`TranscriptRow.swift`, but WS01 does not run in wave B, so per D18 it is
applied by **integration agent B**, not by WS01. It is recorded here for
completeness:

| ID | Receiving file (WS01-owned) | Applier (D18) | Provider symbol | Change | Prerequisite |
|---|---|---|---|---|---|
| M-02-1 | `TranscriptRow.swift` (`TranscriptCellReveal`) | Integration agent B | `EnvironmentValues.transcriptHighlightedRowID` (`ChatCardMessageFocus.swift`, WS02) | `@Environment(\.transcriptHighlightedRowID) private var highlightedRowID`, plus a `.background(item.id == highlightedRowID ? tokens.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: Metrics.radius.md))` and `.animation(.easeOut, value: highlightedRowID)` on `cellContent`. WS01's A1 edits only add switch cases inside `transcriptBlockView`, so they do not conflict. | WS02 commit with `ChatCardMessageFocus.swift` |

No other spec targets `MantaModels.swift`, `MantaUIApp.swift`,
`ChatModels.swift`, `TranscriptComponents.swift`, `ToolActivity.swift`,
`ActivitySheet.swift` or `VoiceNotePlayer.swift`:

- WS07 uses its own wire type instead of `MantaModels.swift`
  (`07-artifacts-cards.md:188`).
- WS09 binds its stores in `MantaAppRoot` (M-09-3/M-09-4), not `MantaUIApp`.

## Contracts provided / consumed

- **C1:** provides two members in `MantaAPIClient+Transcript.swift` (see
  Client members). No other spec declares them; checked with `grep` across
  `02`–`10`.
- **C2:** not used.
- **C3:** not called directly.
  - Quote goes through the existing `TranscriptCardActions.onQuote` →
    `ChatScreen.quote`, which builds the line with `QuoteText.buildQuoteBlock`
    (D4).
  - Any later move onto `insert(text:mode: .quote)` passes the RAW selection,
    and the `Bool` result is surfaced to the user.
  - "Quote in new session" stays a fork with a seed (D12).
- **C4:** WS01 makes no ChatScreen edit.
- **C5 (D15):**
  - Consumes WS02 `commandByMessageID` and the existing single `truncation`.
  - Consumes no per-message truncation map and no `stepEnded`.
  - The footer is transcript-derived, with the latest live warning as a fallback.
  - Provides `TranscriptTurnVerb.present` (optional use by WS02).
- **C6:** no schema change.
- **C7:** `TranscriptParityTests.swift` (Linux and Mac) and
  `TranscriptMapperTests.swift` (Mac).

## Deferred

- **Quoting from user bands.** `UserBand` uses SwiftUI `.textSelection`, whose
  long-press menu owns the gesture. Adding Quote there needs the whole-row menu
  that BET-1363 removed.
- **Quote items in the native edit menu of transcript prose.** RichText 1.0.0
  owns the `UITextView` delegate. A responder-chain `buildMenu(with:)` hack is
  untestable on Linux and fragile.
- **Inline `/name` colouring in a user bubble.** It needs WS03's command and
  skill catalog. Without it, a `/path` would be coloured falsely.
- **A media Download button.** The QuickLook share sheet (Save Image / Save to
  Files) is the native equivalent.
- **Media variants beyond the first.** `media_show` displays one file. The
  desktop grid exists only while pending, and iOS matches that.
- **A pending placeholder that survives app relaunch.** The live store is in
  memory only, like the desktop. After a relaunch, a begin that has not yet been
  shown has no card until its `media_show` lands.

## Open questions

1. **Is the tool name exactly `media_show` / `media_begin` on the V2 wire, with
   no namespace prefix?** Default: match the exact names, and also names ending
   in `_media_show` or `.media_show` (the same for begin). The implementer
   confirms against one real `opencode:messages` response and removes the extra
   matches if they are unused.

(The former questions 1 and 2 are settled by D9 and D1.)

## Review responses (round 1)

**Per-workstream review (`reviews/round1/01-transcript.md`):**

1. **BLOCKING, read-only quote.** Resolved.
   - `TranscriptCardActions.onQuote` becomes optional, and `readOnly` passes nil.
   - `TranscriptQuoteCapability.canQuote` gates both the reply menu and the
     select sheet's edit menu.
   - New action-availability tests (F6). The existing ChatScreen call site
     compiles unchanged.
2. **BLOCKING, media ownership and reconciliation.** Resolved.
   - Entries are keyed session-wide by handle-based identity, never by the
     incoming message.
   - The owner is the begin's message, set once.
   - Canonical reconstruction scans every loaded message and pairs
     `media_begin` with `media_show` by handle.
   - Live entries are filtered by canonical id.
   - Ordering is `(seq, id)`, so `beganAt` is no longer used for ordering.
   - New tests: begin in A plus show in B, then live, then canonical, then
     reload gives exactly one row with no `#dup` (F1).
3. **BLOCKING, D2 new-session flow.** **Rebuttal: superseded by binding D12.**
   - D12 says "Exception: 'Quote in new session' (WS01) keeps desktop parity —
     it FORKS the current session and seeds the fork's composer … so it does not
     use `NewSessionDraft`."
   - The desktop evidence is `src/renderer/QuoteToolbar.tsx:3` ("forks the
     session with the quote seeded") and `ChatPanel.tsx:2120-2139`.
   - The spec now states explicitly that the seed is never auto-sent (F6).
4. **BLOCKING, command contract.** Resolved per D15.
   - WS01 consumes WS02's `commandByMessageID: [String: StreamCommandExecutedPayload]`
     (with non-optional `arguments`).
   - The conversion is `TranscriptCommandOrigin.fromLive`, and durable precedence
     is `resolve`; both are tested.
   - WS01's own decoder request is dropped. M-01-1 pins the exact expression.
5. **SHOULD, reserved geometry.** Resolved. `reserved` geometry is immutable
   once set by a begin (live or canonical); `show` only fills
   path/mime/size; the image is letterboxed; the spec explicitly says the
   desktop reducer does not do this. Tests: begin 16:9 then show 600×600, and a
   video with null dims.
6. **SHOULD, staging cache scope.** Resolved.
   - The key is a hash of box id + server URL + source.
   - There is a reset when the identity changes (in-flight work is cancelled, the
     directory is deleted), cleanup at first use, and a 64-file LRU cap.
   - Tests: the same path on two boxes gives different keys, and an identity
     change clears the map.
7. **SHOULD, premature truncation suppression.** Resolved.
   - The footer kind is `canonical ?? liveTruncations`. (Superseded in round 2: the fallback is now WS02's existing single `truncation`, see round 2 finding 1.)
   - WS02 suppresses the notice only for `messageID`s in
     `footerTruncationMessageIDs` of the blocks actually rendered (M-01-4).
   - Tests: incomplete snapshot, missing usage, missing usage with live data,
     canonical beats live.
8. **SHOULD, unbounded payloads.** Resolved.
   - Media: `HEAD` before download, disk-streamed bounded download
     (`downloadPeekFile`), and data URLs size-checked before decoding.
   - Tool output: the spec now states that canonical output is uncapped; verbose
     display is bounded to 2,000 lines / 100,000 characters in a capped scroll
     well, and Copy gives the full text.
   - Tests added for each.

**Cross-cutting review (`reviews/round1/00-cross-cutting.md`) findings that
mention WS01:**

- **#2 (producers bypass create flow, WS01 part).** Rebuttal: D12 explicitly
  exempts Quote in new session (fork). Its routing goes through the existing
  `ChatScreen` callback, with no new ChatScreen edit.
- **#5 (command-frame mismatch).** Resolved as in finding 4.
  - The transcript-derived footer is recorded as the D15 C5 amendment.
  - All WS01 mapper, media, command and display mounts in `ChatSessionStore`
    are listed as WS02 wave-B deliverables (M-01-1 to M-01-4).
- **#8 (mount receipt omissions).** Resolved with the D18 ledger above.
  - M-01-1 to M-01-4 → WS02.
  - M-01-5 → WS07.
  - M-01-6 → wave-A integration.
  - The mount WS01 receives (WS02 M1) → wave-B integration agent.
- **#10 (package and pbxproj).** WS01 supplies a Package manifest (M-01-6), never
  edits `project.yml` or the `.pbxproj`, and leaves regeneration to the
  orchestrator.

## Review responses (round2)

**Per-workstream review (`reviews/round2/01-transcript.md`):**

1. **BLOCKING, M-01-1 to M-01-4 do not match WS02 / the truncation map was
   dropped.** Resolved on WS01's side by redesigning to WS02's current surface.
   - WS01 now consumes WS02's **existing single** `truncation`
     (`ChatSessionStore.swift:203`; kept in WS02 F11), through
     `TranscriptLiveTruncation.from(kind:messageID:)`, into
     `TranscriptMapOptions.liveTruncation`. No `truncationByMessageID` is
     needed, which satisfies D15's "nothing beyond what WS02 already decodes".
     Rationale (F4): only the latest warning can lack a canonical record.
   - The M-01 table now pins exact expressions over WS01's current symbols:
     `entries(for:)`, `$sessions`, `fromLive`, `footerTruncationMessageIDs`.
   - It explicitly replaces the "message exists in `messages`" suppression rule.
   - It requires an integration test that runs the real
     `mapOptions` → `blocks(options:)` → `footerTruncationMessageIDs` →
     `trailingBlocks` chain on an incomplete-truncation snapshot (M-01-4).
   - **`presentedMessages` reconciliation:** M-01-1 to M-01-3 all map
     `presentedMessages`. `liveMediaTail` gained an `isLiveWindow` parameter and
     a disjointness rule, so one owner never appears in both segments. A
     disjointness test was added (F1).
   - WS02's receipt rows are WS02's to update; the ledger cleanup note lists the
     obsolete forms.
2. **SHOULD, footer emission predicates.** Resolved (F4).
   - The effective truncation (`canonical ?? live`) is computed BEFORE emission.
   - Emission is `TranscriptFooterRule.shouldEmit(finishedTurn:effectiveTruncation:)`.
   - The old "last message with prose" condition is removed. Reply actions
     require `isTurnEnd` (`turns[id] != nil`), which is never true for a
     running turn.
   - Tests added: live-only truncation on a non-final message gives a
     warning-only footer; a completed last step with prose while `running`
     gives no footer and no menu; the predicate's four combinations.
3. **SHOULD, portability of `URLRequest` and SHA-256.** Resolved.
   - The pure file now holds only `TranscriptPeekRequest.url(serverURL:path:)`
     (`URLComponents`) and `TranscriptStagingKey.input(...)` (a plain string).
   - `URLRequest` assembly (`peekRequest(url:method:token:)`) lives in the
     app-only `MantaAPIClient+Transcript.swift`, with Mac tests.
   - SHA-256 is computed with CryptoKit in the app-only `TranscriptFileStager`.
   - No package dependency is added (the manifest is unchanged in kind).
   - Also from round 1 #8's note: `downloadPeekFile` now streams with
     `URLSession.bytes(for:)` and aborts mid-download the moment the byte count
     exceeds the limit, not after a completed `download(for:)`.
4. **NIT, retired IDs and file names.** Resolved on WS01's side.
   - The received row is labelled `M-02-1`.
   - M-01-5 names `TranscriptDisplayOptions.swift` as the provider file, and
     notes that WS07's "WS01 M4" receipt is this request.
   - The superseded-ID list is in **Mount requests**.

**Cross-cutting review (`reviews/round2/00-cross-cutting.md`):**

- **#2 (WS01 / WS02 transcript integration).** Resolved on WS01's side as in
  finding 1 above.
  - Command conversion: `fromLive` now maps `""` to `nil`, value-identical to
    WS02 F11's inline expression, so either compiles and behaves the same.
  - Media: `entries(for:)` and `$sessions`.
  - Truncation: the existing single property; no new WS02 map. This matches the
    master's C5/D15 text unchanged.
  - Suppression: the rendered-footer predicate only.
- **#10 (ledger integrity).** All WS01 rows now use M-01-1 to M-01-6, with the
  ledger's appliers and waves (WS02 B ×4, WS07 B, IA after A2). The received
  row uses M-02-1, applied by IB. Removed requests are marked superseded.
- **Ledger rows M-01-1…M-01-6, M-02-1:** match the consolidated ledger, except
  M-01-1's provider symbols: `truncationByMessageID` is replaced by the existing
  `truncation` plus `TranscriptLiveTruncation.from` (finding 1 redesign), and
  M-01-2's signature gains `isLiveWindow:`.

