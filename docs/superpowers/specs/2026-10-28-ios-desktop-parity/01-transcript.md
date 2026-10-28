# WS01 — Transcript parity

Status: draft · Wave A · Owner files: `ChatModels.swift`, `TranscriptComponents.swift`,
`TranscriptRow.swift`, `ToolActivity.swift`, `ActivitySheet.swift`,
`VoiceNotePlayer.swift` + new `Transcript*` files (master §File ownership).

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
- **Wave A independence.** Everything the transcript itself contains (file parts,
  `media_show` tool parts, `info.command`, `info.tokens`, `info.finish`, reasoning
  parts) is handled inside `ChatTranscriptMapper`, which WS01 owns, through the
  overloads `ChatSessionStore` already calls. Live-only data (media placeholders
  still pending, the `commandExecuted` frame that arrives before a refetch, the
  `running` gate) arrives later through options that WS02 passes in wave B. Until
  then those options default to empty, and features degrade to "shows after the
  turn settles". Nothing breaks.

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

- **User file parts**: `opencode:messages`. `mapUser` (`src/shared/opencodeV2.mjs:293-317`)
  emits `{id:"<msg>:file:<i>", type:"file", mime?, filename?, url?}`. `url` is
  either the file's `file://…` source URI or `data:<mime>;base64,<…>` for inline
  data. On iOS these fields are in `OpencodePart.extra` (`MantaModels.swift:82`).
- **`media` bus frame** (raw `/events` frame, `kind:"media"`, NOT a `stream`
  sub). Its payload is `MediaEventPayload` (`src/shared/types.ts:1092-1106`):
  `{action, handle?, sessionID?, messageID?, kind?: "image"|"video", width?,
  height?, aspectRatio?, count?, title?, path?, mime?, size?}`. The routing
  fields use an uppercase `ID` (BET-1328), unlike the widget frame.
- **`media_show` tool part** (persisted in the transcript): `state.input =
  {path, handle?, title?}`. On success, `state.output` is
  `Displayed <resolvedPath> (<mime>[ <W>x<H>], <size> bytes) in the transcript.`
  (`docs/opencode-plugins-v2/manta/tools/media.ts:110-113`).
- **Bytes**: `GET /api/peek?path=<path>` (`src/server/index.mjs:4230`,
  `src/server/peek.mjs`). The box expands `~`, keeps the path inside home, and
  supports `HEAD`. iOS already has `MantaAPIClient.peekFile(path:)`
  (`MantaAPIClient.swift:559`); it throws on non-2xx and on 401. **No new
  client method.** (A `HEAD` would need `session`/`tokenProvider`, which are
  `private`. Size comes from the payload or the tool output instead, see below.)

### What iOS has today

- `TranscriptAttachment.Kinds` has only `.voiceNote` and `.widget`
  (`TranscriptComponents.swift:855-869`). `attachmentView`
  (`TranscriptRow.swift:482-501`) and `ChatTranscriptMapper.process`
  (`ChatModels.swift:419-441`) state that image/file rendering is
  "deliberately not implemented yet (BET-1029)".
- Message rows are only emitted when the message has text (`ChatModels.swift:199`),
  so a user message that is only an attachment disappears.
- Precedents to copy: `WidgetLiveStore` (box-wide `@MainActor` store bound to raw
  frames, `WidgetLiveStore.swift:20-102`, bound at `MantaUIApp.swift:39`);
  `WidgetMetrics` reserved box (`WidgetModels.swift:115-126`);
  `Metrics.type.inlineMaxW` (520); QuickLook staging in
  `SessionResourceCards.swift:497-660`. That staging is `private` to WS07, so WS01
  ships its own small wrapper.

### iOS design

**Data (pure, new `TranscriptMedia.swift`):**

```swift
enum TranscriptMediaState: Equatable, Sendable { case pending, ready, failed, expired }
struct TranscriptMediaEntry: Equatable, Sendable {
  let id: String              // "media:" + (handle ?? partID ?? "msg:" + messageID)
  var state: TranscriptMediaState
  var kind: MediaKind          // .image | .video
  var path: String?            // box path for /api/peek
  var mime: String?
  var width: Double?; var height: Double?; var aspectRatio: Double?
  var count: Int?; var title: String?
  var size: Int?               // bytes, when known
  var beganAt: Date?
  var messageID: String?; var handle: String?
}
enum TranscriptMediaReducer {           // port of applyMediaEvent / dispatchMedia
  static func apply(_ prev: TranscriptMediaEntry?, _ p: MediaFramePayload, now: Date) -> TranscriptMediaEntry
}
enum TranscriptMediaParse {
  /// A completed, non-error `media_show` tool part → a ready entry, or nil.
  static func entry(fromMediaShow part: OpencodePart) -> TranscriptMediaEntry?
  /// "Displayed /p (image/png 800x600, 1234 bytes) in the transcript." → (path, mime, w, h, size)
  static func parseShowOutput(_ s: String) -> (path: String, mime: String?, w: Double?, h: Double?, size: Int?)?
}
enum TranscriptMediaGeometry {
  static let defaultAspect = 16.0 / 9.0
  static let maxHeight: CGFloat = 480   // iOS-only: a phone column cannot fit a 1:3 image
  static let maxPreviewBytes = 25 * 1024 * 1024
  static func aspect(width:height:aspectRatio:) -> Double          // resolveMediaAspect
  static func box(entry:availableWidth:) -> CGSize                  // min(avail, inlineMaxW); height = w/aspect; if > maxHeight, shrink width to keep aspect
  static func grid(count: Int?) -> (tiles: Int, more: Int)          // mediaGrid
}
struct TranscriptFileRef: Equatable, Sendable {
  let partID: String; let filename: String; let mime: String?
  let source: Source           // .boxPath(String) | .dataURL(mime: String?, base64: String) | .none
}
enum TranscriptFileParse { static func refs(of message: OpencodeMessage) -> [TranscriptFileRef] }
```

`MediaFramePayload` is a `Codable` struct with the `MediaEventPayload` fields,
defined in `TranscriptMedia.swift`. The rules, from the desktop:

- Tool matching: `ToolActivity.toolName(of:)` lowercased `== "media_show"`.
- Path: prefer the resolved path parsed from `state.output`, else `state.input.path`
  (peek expands `~`).
- mime: from the output, else guessed from the extension with the
  `MIME_BY_EXT` table (`media.mjs:44-56`).
- Kind: `image/*` → image, `video/*` → video, else image.
- `filename` fallback: `url` last path segment, then `"file"`.
- `file://` is stripped to get a box path.

**Live store (new, `TranscriptMedia.swift`):** `@MainActor final class
TranscriptMediaStore: ObservableObject`, `static let shared`. It has
`@Published private(set) var entries: [String /*sessionID*/: [String /*messageID*/: [TranscriptMediaEntry]]]`
(a list per message, because one message can show several images).
`bind(eventStore:)` is idempotent and calls `eventStore.addRawFrameHandler`,
handling `frame.kind == "media"` only. Updates go through
`TranscriptMediaReducer`, matched by `handle`, else appended. The store is
in-memory only, like the desktop. After a reload the canonical `media_show`
parts carry the media (below).

**Mapper (`ChatModels.swift`):**

- **User message.** `refs = TranscriptFileParse.refs(of:)`. If it is non-empty,
  emit `.file(TranscriptAttachment(kind: .userFiles(TranscriptUserFiles(messageID:, refs:))))`
  BEFORE the `.user` / `.command` block. Emit it even when the message has no
  text. Id: `"f" + "ufiles:" + messageID`.
- **Settled assistant message.**
  1. First emit its media, in order: one `.file(.media(entry))` per
     `media_show` part found in `msg.parts`. Then add
     `options.liveMedia[messageID]` entries whose `handle`/`path` is not already
     covered, which carries pending/failed placeholders through to after the
     turn settles.
  2. Then the existing layout blocks. Then widgets (unchanged). Then the turn
     footer (F4).
  The `media_show` call also stays in its tool run, so the Activity sheet keeps
  the call. `ToolActivity.layout` is NOT changed: it is a shared parity fixture
  with the desktop.
- **New pure helper for WS02:**
  `static func liveMediaTail(entries: [String: [TranscriptMediaEntry]], settledMessageIDs: Set<String>) -> [TranscriptBlock]`.
  It returns `.file(.media)` blocks for messages not yet settled (the running
  turn), ordered by `beganAt`.
- **Id continuity.** A placeholder started with `media_begin` keeps the id
  `media:<handle>` from pending, through ready, to the canonical part (which
  carries the same `input.handle`). The row updates in place. A `media_show` with
  no handle changes id once, at the turn boundary. That is acceptable: other
  turn-boundary swaps already behave this way.

**Views (new `TranscriptMedia.swift` / `TranscriptFiles.swift`):**

- `TranscriptMediaCard`: a header row with the SF Symbol `photo` / `video`, the
  name "Image"/"Video", and the title in tx3 (one line, tail-truncated). Below it
  sits the reserved box (`TranscriptMediaGeometry.box`, `tokens.inset`
  background, `Metrics.radius.md`, border `tokens.border`). The box size comes
  ONLY from the entry, never from the loaded image, so the cell height never
  changes after loading.
  - **pending**: a `ProgressView` per tile (up to 4 tiles in 2 columns, with a
    tile number in the corner), `+N more`. Below: "Generating image" /
    "Generating video", an elapsed clock (`TimelineView(.periodic(from:.now, by:1))`,
    `TranscriptTurnFormat.duration`), and "· this usually takes a few seconds".
  - **ready, loading**: a spinner. The load uses `TranscriptFileStager.shared.localURL(for:)`,
    which calls `peekFile`. If `size > maxPreviewBytes` it refuses BEFORE
    fetching, and also refuses after fetching when the size was unknown.
  - **ready, image**: shown with ImageIO downsampling
    (`CGImageSourceCreateThumbnailAtIndex`, max pixel size = box width × screen
    scale). `scaledToFit` inside the box. Tapping opens QuickLook full screen,
    whose share sheet covers saving to Photos/Files. Accessibility label
    "Image: <title|filename>"; hint "Opens the full image".
  - **ready, video**: a first-frame poster (`AVAssetImageGenerator` on the
    staged file) with a centred `play.circle.fill`. Tapping opens QuickLook,
    which plays the video. **No autoplay.**
  - **load error**: "⚠ Couldn’t load this media" (tx3). Too large: "⚠ Too large
    to preview here". Neither is tappable.
  - **failed / expired**: "⚠ The media failed to generate" / "⚠ This media
    expired" inside the same box, and the header icon turns `tokens.danger`.
- `TranscriptUserFilesRow`: a right-aligned wrapping row of chips. Each chip
  shows a paperclip, the filename (mono, xs, max 260pt, middle-truncated), and a
  `tokens.fill` background with a `tokens.border` stroke. **iOS addition
  (native idiom):** tapping a chip opens QuickLook. While the file is staged, the
  chip shows a small spinner; on failure, an inline "Couldn’t open <filename>"
  appears under the row (tokens.danger, twoXS) and clears after 4 s. A
  `.dataURL` source is decoded locally with no network. A `.none` source renders
  the chip as plain, non-button text.
- `TranscriptFileStager` (`@MainActor final class`, `static let shared`):
  `func localURL(for source:) async throws -> URL`. It writes to
  `FileManager.default.temporaryDirectory/transcript-files/<sha256(path)>.<ext>`,
  keeps an in-memory cache keyed by path, and coalesces in-flight requests.
- `TranscriptQuickLook`: a `UIViewControllerRepresentable` around
  `QLPreviewController` for one URL, presented with `.fullScreenCover` from the
  card. A card-local presentation is the precedent of `WidgetCard.swift:123`.

### Pure logic + tests (`MantaUITests/TranscriptParityTests.swift`)

- Reducer: `begin` → pending with dimensions; `begin` then `show` keeps
  `count`/`beganAt`/handle, sets path/mime/size, and the kind comes from the
  mime; `begin` then `fail` keeps the reserved dimensions; `show` with no prior
  entry creates a ready entry; an unknown action leaves the entry unchanged.
- `parseShowOutput`: with dimensions, without dimensions, a path containing
  spaces and parentheses (anchored on the LAST ` (`), and junk returns nil.
- `entry(fromMediaShow:)`: completed → entry with id `media:<handle>`; no handle
  → `media:<partID>`; error status → nil; other tool → nil; `~` input path used
  when the output is unparseable.
- Geometry: explicit dims beat aspect beat 16:9; width capped at 520; a tall
  1:3 image is capped at 480 high with its width shrunk; `grid` for 0/1/3/4/7.
- `TranscriptFileParse.refs`: a `file://` URL → `.boxPath`; a `data:` URL →
  `.dataURL`; filename fallbacks.
- Mapper: a user message with only a file part produces a `.file(.userFiles)`
  row with no text row; media blocks come before the message's prose; a
  `liveMedia` entry with the same handle as a canonical part is not duplicated;
  `liveMediaTail` excludes settled messages; ids are identical across two
  mappings of the same input.

### Acceptance

- [ ] A message sent from the phone or desktop with an attached image shows a
      chip above the prompt; tapping it opens the image in QuickLook.
- [ ] A turn where the agent calls `media_begin` then `media_show` shows a
      pending box at its final size, then the image in that same box. The
      transcript does not jump.
- [ ] After force-quitting and reopening the session, the image is still shown
      (from the `media_show` part).
- [ ] A video shows a poster and plays only after a tap.
- [ ] An orphaned `begin` ends as "The media failed to generate".
- [ ] A 30 MB file says "Too large to preview here" and downloads nothing.

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

- **Preference (new `TranscriptReasoning.swift`):**
  ```swift
  enum TranscriptDisplayOptions {
    static let defaultsKey = "manta.transcript.showDetails"
    static let didChange = Notification.Name("TranscriptDisplayOptions.didChange")
    static var showDetails: Bool { UserDefaults.standard.bool(forKey: defaultsKey) }   // default false
    static func setShowDetails(_ on: Bool)  // writes + posts didChange on the main queue
  }
  ```
  It is **persisted app-wide**. The desktop's per-panel, non-persisted state is
  tied to a keyboard shortcut; on a phone, a switch that silently resets every
  time you open a chat reads as broken. (See Open questions.)
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
  - When on, `ActivityCallRow.detailView` shows the **full** `d.output` (still
    bounded by the box's 20,000-character tool cap) with `lineLimit(nil)`, and a
    completed `read` call is expanded by default. Expansion keeps
    `ActivityDisclosure`'s user-wins rule (`ToolActivity.swift:957`): the
    default is computed with a new `verbose` parameter, and the user's toggle
    still beats it.
  - When off: today's behaviour.
- **Second entry point:** the chat overflow sheet row (Mount request M4).
- **Live refresh:** the transcript re-maps when the switch changes. ChatSessionStore
  must observe `didChange` (Mount request M3c). Until WS02 lands, the Activity
  sheet changes instantly and reasoning rows appear on the next transcript fetch.

### Pure logic + tests

- Mapper with `showReasoning: false`: no reasoning rows, and a tool → reasoning →
  tool sequence stays one run (same as the existing desktop fixture).
- With `true`: reasoning row id `r<partID>`; the run splits in two, and the
  second run's id is its first part's id; blank reasoning produces no row.
- `ActivityDisclosure.expanded(… verbose:)`: a verbose completed `read`
  defaults to expanded; a user toggle overrides it.
- `ToolActivity.outputForDisplay(_:verbose:)` returns
  `ToolOutputPreview.tail(output)` when not verbose and the full output when
  verbose.

### Acceptance

- [ ] With the switch off, nothing changes compared with today.
- [ ] Turning it on in the Activity sheet shows full command output immediately.
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
  (`src/server/streamInterp.mjs:1037-1040`; desktop consumer
  `src/renderer/hooks/useSseBus.ts`). iOS does not decode it today
  (`MantaEventStore.swift` switch, around line 200-290).

### iOS design

- **Model (unowned file, Mount request M1):** `OpencodeMessageInfo` gains
  `command: OpencodeCommandOrigin?` with `{name: String, arguments: String?}`.
- **New block** `.command(TranscriptCommandTurn)` (`TranscriptComponents.swift`):
  ```swift
  struct TranscriptCommandTurn: Equatable, Sendable { let messageID: String; let name: String; let arguments: String; let expandedText: String; let at: Date? }
  ```
  Row id: `"cmd-" + messageID`. Its timestamp is `at`, so the swipe gutter shows
  it like a user turn.
- **Mapper:** for a user message, `origin = msg.info.command ?? options.liveCommands[msg.info.id]`.
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
- `OpencodeMessageInfo` decoding: `command` missing → nil; well-formed →
  decoded; malformed (for example `"command": 3`) → nil and the message still
  decodes.
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

- **Model (Mount request M1):** `OpencodeMessageInfo` gains
  `tokens: OpencodeTokenUsage?` (`input/output/reasoning: Double?`,
  `cache: {read, write: Double?}?`) and `finish: String?`.
- **iOS improvement over the desktop:** truncation is derived from the
  **transcript** (the `step-finish` part's `reason`, falling back to
  `info.finish`; `lastPartIsToolUse = info.finish == "tool-calls"`). It
  therefore survives reload with no live map and no WS02 dependency.
- **Pure (new `TranscriptTurnFooter.swift`):**
  ```swift
  enum TruncationKind: String, Sendable { case outputCap = "output-cap", contextWall = "context-wall", toolCutoff = "tool-cutoff" }
  enum TranscriptTruncation {
    static func classify(_ finish: String?, lastPartIsToolUse: Bool) -> TruncationKind?   // classifyFinish port
    static func describe(_ k: TruncationKind) -> (label: String, hint: String)            // verbatim copy
    static func kind(of message: OpencodeMessage) -> TruncationKind?
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
    let truncation: TruncationKind?
    let turnText: String             // the turn's prose joined "\n\n" — feeds F6
  }
  ```
  `present` is exported so WS02 can make `RunningIndicator`'s verb match the
  footer, which is the desktop rule. RunningIndicator currently uses a random
  verb (`RunningIndicator.swift:33-39`, WS02-owned). That alignment is optional
  for WS02.
- **Mapper:** compute `turns = TranscriptTurns.info(messages, running: options.running)`
  over ALL messages before filtering to `settled`. After each settled assistant
  message's blocks (and widgets), emit `.turnFooter(...)` when any of these hold:
  - `turns[id]` exists, or
  - `TranscriptTruncation.kind(of: msg) != nil` (a mid-turn truncation gives a
    footer with no summary), or
  - `id` is the turn's last assistant message and the turn has prose (F6
    needs that menu).
  Row id: `"tf-" + messageID`.
  `summary` is `"\(past) for \(duration)"`, plus `" · \(tokens)"` when tokens > 0;
  it is nil when there is no duration.
- **View `TranscriptTurnFooterView`:** one line, `Metrics.type.xs`, tx3, padded
  like prose.
  - `MantaLogoMark(size: 12)` followed by the summary.
  - If truncated: `·`, then a pill with `exclamationmark.triangle.fill` and the
    label (warn text, `tokens.warn.opacity(0.12)` background, warn 33% border,
    `Metrics.radius.xs`). The pill is a `Button`; tapping it shows the hint in a
    `.popover` with `.presentationCompactAdaptation(.popover)`.
  - Trailing `Spacer` then the F6 reply menu.
  - `.lineLimit(1)` with the summary tail-truncated; the pill never truncates.
- **No duplicate notice:** once the footer shows a message's truncation, WS02's
  tail notice for the same `messageID` must go (Mount request M3d).

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
- Mapper: `.turnFooter` follows the last block of the turn; a mid-turn truncated
  message gets a footer with `summary == nil`; ids are stable.

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

### Tests

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

- **Reply menu.** `TranscriptTurnFooterView` (F4) ends with a SwiftUI `Menu`.
  The icon is `ellipsis`, tx4, with a 44pt hit target; a11y label "Reply
  actions". A tap opens it, so long-press and text selection are untouched. Items:
  1. **"Quote"** → `cards.onQuote(footer.turnText, .thisSession)`.
  2. **"Quote in new session"** → `cards.onQuote(footer.turnText, .newSession)`.
  3. **"Select text…"** → presents `TranscriptSelectTextSheet`.
  - Items 1 and 2 are only shown when `cards != nil`, which means a live chat
    surface; read-only surfaces get inert actions (`TranscriptRow.swift:207-226`).
    They are also only shown when `turnText` is non-empty.
  - Item 3 is shown when `turnText` is non-empty.
  - If no item is shown, the menu is not rendered.
  - `turnText` is the turn's `.prose` texts joined with `"\n\n"`.
    `QuoteText.buildQuoteBlock` (already used by `ChatScreen.quote`) collapses
    and middle-truncates it, so whole-reply quoting yields the same one-line
    pointer the desktop produces.
- **`TranscriptSelectTextSheet`** (new `TranscriptSelectText.swift`) gives real
  sub-selection, matching the desktop:
  - Navigation title "Select text", a Done button, detents `.medium, .large`.
  - Body is `TranscriptSelectableTextView`, a `UIViewRepresentable` around a
    `UITextView` with `isEditable = false`, `isSelectable = true` and
    `isScrollEnabled = true`. It shows `turnText`, rendered with
    `AttributedString(markdown:options: .init(interpretedSyntax:
    .inlineOnlyPreservingWhitespace))`, falling back to plain text if that
    throws. The font is the body manta font and the colour tx1.
  - **WS01 owns the delegate.** `textView(_:editMenuForTextIn:suggestedActions:)`
    (iOS 16+) returns `UIMenu(children: [quoteAction, quoteNewAction] +
    suggestedActions)` when `cards != nil`, otherwise `suggestedActions`.
  - The actions are titled "Quote" and "Quote in new session".
  - The selection is computed with
    `TranscriptSelection.text(in: textView.text, range: selectedRange)`.
  - The sheet then dismisses and calls `onQuote(selection, destination)`.
- **Presentation** is local to the footer cell (`.sheet(isPresented:)`), the same
  precedent as `WidgetCard.swift:123`. No ChatScreen mount is needed, because
  `onQuote` already reaches ChatScreen through the `transcriptCardActions`
  environment.
- **Feedback:** "Quote" lands the text in the composer and focuses it, which is
  visible. "Quote in new session" navigates to the fork. A failed fork already
  sets `store.actionHint` ("Fork failed — nothing was created",
  `ChatScreen.swift:977-983`). So every outcome is visible.
- **Quoting from user bands: deferred.** See Deferred.

### Pure logic + tests

- `TranscriptSelection.text(in:range:)`:
  - valid range → substring;
  - zero length → nil;
  - out of bounds → clamped, or nil when empty;
  - a range inside a string with emoji (UTF-16 `NSRange`) does not split a
    character, using `Range(nsRange, in:)`.
- `TranscriptTurnFooter.turnText`: two prose blocks are joined with a blank
  line; tool runs are excluded.
- Existing `QuoteText` tests stay unchanged.

### Acceptance

- [ ] Under any finished reply, ⋯ → Quote puts `> <reply…>` at the top of the
      composer and focuses it.
- [ ] ⋯ → Quote in new session opens a fork whose composer holds the quote.
- [ ] ⋯ → Select text… lets the user select part of the reply; the edit menu
      shows Quote / Quote in new session above Copy; choosing Quote inserts only
      the selected words.
- [ ] Long-pressing prose in the transcript still selects text natively (no
      regression of BET-1363).
- [ ] In a subagent drill-in, ⋯ offers only "Select text…".

---

## Mapper contract (all features)

`ChatModels.swift` gains:

```swift
struct TranscriptMapOptions: Equatable, Sendable {
  var showReasoning: Bool = false
  var running: Bool = false
  var liveCommands: [String: OpencodeCommandOrigin] = [:]          // user messageID → origin (commandExecuted)
  var liveMedia: [String: [TranscriptMediaEntry]] = [:]            // assistant messageID → live entries
  static var current: TranscriptMapOptions { .init(showReasoning: TranscriptDisplayOptions.showDetails) }
}
extension ChatTranscriptMapper {
  static func blocks(from: [OpencodeMessage], voiceNotes: [VoiceNote], widgets: [WidgetRef], options: TranscriptMapOptions) -> [TranscriptBlock]
  static func liveMediaTail(entries: [String: [TranscriptMediaEntry]], settledMessageIDs: Set<String>) -> [TranscriptBlock]
}
```

The existing three `blocks(from:…)` overloads forward `.current`.

Block order for one turn:

1. user files
2. `.user` | `.command`
3. voice note
4. user widgets
5. for each assistant message: media → layout blocks (runs, prose, reasoning,
   handoff) → widgets → footer

New `TranscriptBlock` cases:

- `.command(TranscriptCommandTurn)`, id `cmd-<msgID>`
- `.reasoning(TranscriptReasoning)`, id `r<partID>`
- `.turnFooter(TranscriptTurnFooter)`, id `tf-<msgID>`

New `TranscriptAttachment.Kinds`:

- `.userFiles(TranscriptUserFiles)`, id `f` + `ufiles:<msgID>`
- `.media(TranscriptMediaEntry)`, id `f` + `entry.id`

`timestamp`: `.command` → `at`; the new kinds → nil.

`.turnFooter` and `.reasoning` add rows. This is identity-safe: the ids are
derived from part and message ids, and BET-1105's snapshot rendering absorbs
inserts.

## Files

**Edit (owned):**

- `ChatModels.swift`: mapper overload, options, user file/command emission,
  media, reasoning, footer, `liveMediaTail`; update the BET-1029 comments.
- `TranscriptComponents.swift`: new `TranscriptBlock` cases and `timestamp`;
  new `TranscriptAttachment.Kinds`.
- `TranscriptRow.swift`: `stableScrollID` / `attachmentIdentity` for the new
  cases; `transcriptBlockView` / `attachmentView` render them; footer gets
  `cards`.
- `ToolActivity.swift`: `copyText(of:)`, `outputForDisplay(_:verbose:)`.
- `ActivitySheet.swift`: display-options menu, full output when verbose, copy
  button, `ActivityDisclosure` verbose default.

**Create:**

- `TranscriptMedia.swift`: models, reducer, parse, geometry,
  `TranscriptMediaStore`, `TranscriptMediaCard`.
- `TranscriptFiles.swift`: `TranscriptFileRef`/parse, `TranscriptUserFilesRow`,
  `TranscriptFileStager`, `TranscriptQuickLook`.
- `TranscriptReasoning.swift`: `TranscriptDisplayOptions`, `TranscriptReasoning`,
  `TranscriptReasoningView`.
- `TranscriptCommand.swift`: `TranscriptCommandTurn`, row, sheet.
- `TranscriptTurnFooter.swift`: truncation, turns, format, verb, footer model and
  view with the reply menu.
- `TranscriptSelectText.swift`: sheet, `UITextView` representable,
  `TranscriptSelection`.
- `TranscriptCopy.swift`: `TranscriptCopyButton`.
- `MantaUITests/TranscriptParityTests.swift`: all cases listed above.
- Fallback only: `TranscriptCodeBlock.swift`.

`project.yml` needs no change: the `MantaUI` folder entry picks up new files.
The `.pbxproj` is regenerated on the Mac per the master DoD.

## Mount requests

| # | File (owner) | Exact change | Wave |
|---|---|---|---|
| M1 | `MantaModels.swift` (**unowned**, proposed: WS01 applies in wave A) | Add `struct OpencodeTokenUsage: Codable, Equatable, Sendable { var input, output, reasoning: Double?; var cache: Cache?; struct Cache: Codable, Equatable, Sendable { var read, write: Double? } }` and `struct OpencodeCommandOrigin: Codable, Equatable, Sendable { var name: String; var arguments: String? }`. Add to `OpencodeMessageInfo`: `var tokens: OpencodeTokenUsage?`, `var finish: String?`, `var command: OpencodeCommandOrigin?`. Decode with a **custom `init(from:)` in an EXTENSION** (keeps the memberwise init) that uses `try?` for the three new keys, so a malformed value never fails the transcript decode. Encode them back. | A |
| M2 | `MantaUIApp.swift` (**unowned**, proposed: WS01 applies in wave A) | Next to `WidgetLiveStore.shared.bind(eventStore: event)` (line 39), add `TranscriptMediaStore.shared.bind(eventStore: event)`. | A |
| M3a | `ChatSessionStore.swift` (WS02) | Replace the three `ChatTranscriptMapper.blocks(from:voiceNotes:widgets:)` calls (lines ~1064, ~1111, ~1137) with one private `mapOptions` → `blocks(from:voiceNotes:widgets:options:)`. `options = TranscriptMapOptions(showReasoning: TranscriptDisplayOptions.showDetails, running: running, liveCommands: liveCommandsByMessageID, liveMedia: TranscriptMediaStore.shared.entries[sessionId] ?? [:])`. | B |
| M3b | `ChatSessionStore.swift` (WS02) | In `rebuildBlocks`, insert `ChatTranscriptMapper.liveMediaTail(entries: TranscriptMediaStore.shared.entries[sessionId] ?? [:], settledMessageIDs: Set(messages.filter{ $0.info.time?.completed != nil }.map(\.info.id)))` after `liveTranscript` and before the live prose tail, using `uniqueTranscriptRows` like the rest. | B |
| M3c | `ChatSessionStore.swift` (WS02) | Subscribe to `TranscriptMediaStore.shared.$entries` (filtered to this session) and to `NotificationCenter.default.publisher(for: TranscriptDisplayOptions.didChange)`. On each, re-map `transcript` from `messages` with the same no-blank-clobber guard as `refreshWidgets` (`ChatSessionStore.swift:1133-1141`), then `rebuildBlocks()`. | B |
| M3d | `ChatSessionStore.swift` `trailingBlocks` (WS02) | Skip the truncation `.notice` when `truncation.messageID` is non-nil and that id is in `messages`, because the turn footer shows it. Keep it otherwise. Update `ChatStreamMergeTests.testTrailingOrder…` if needed. | B |
| M3e | `MantaStreamModels.swift` + `MantaEventStore.swift` + `ChatSessionStore.swift` (WS02) | Decode stream sub `commandExecuted` as `StreamCommandExecutedPayload {messageID: String, name: String, arguments: String?}` and publish `ChatSessionStore.liveCommandsByMessageID: [String: OpencodeCommandOrigin]` for M3a. Optional: until it lands, the band appears once the transcript refetches. | B |
| M4 | `ChatOverflowSheet.swift` (WS07) | Next to the "Trust mode" toggle (`ChatOverflowSheet.swift:118-126`), add `Toggle` "Show reasoning & full output" with the subtitle "Thinking steps and complete tool output", bound via `@AppStorage(TranscriptDisplayOptions.defaultsKey)` and setting through `TranscriptDisplayOptions.setShowDetails`. No ChatScreen change. | B |

## Contracts provided / consumed

- **C1:** no `MantaAPIClient+Transcript.swift` is needed. WS01 only uses the
  existing internal `peekFile(path:)`.
- **C2:** not used.
- **C3:** consumed indirectly. WS01 calls `TranscriptCardActions.onQuote`, and
  WS02's `ChatScreen.quote` performs the insertion. **Note for WS02/WS03:**
  `onQuote` passes the RAW selection, and `ChatScreen.quote` builds the block
  with `QuoteText.buildQuoteBlock` (one-line, middle-truncated, desktop parity).
  If WS02 moves it onto C3, it must call `insert(text: rawSelection, mode: .quote)`
  ONLY IF `.quote` mode applies the same `QuoteText.buildQuoteBlock` rule. Never
  pass an already-built block through `.quote`, or it gets a double `> `.
  "Quote in new session" keeps using `forkSession(seed:)`.
- **C4:** WS01 makes no ChatScreen edit. Quote rides the existing callback;
  sheets are cell-local.
- **C5:** consumed: `commandExecuted` (M3e). Not consumed: `truncation` and
  `stepEnded`. The footer is transcript-derived, which is strictly better (it
  survives reload) and removes the dependency. WS01 also **provides**
  `TranscriptTurnVerb.present` so WS02 may align `RunningIndicator`.
- **C6:** no settings-schema change. The display switch is a local UI
  preference (`UserDefaults`), not a box setting.
- **C7:** `MantaUITests/TranscriptParityTests.swift`. No server change, so no
  node tests.

## Deferred

- **Quoting from user bands.** `UserBand` uses SwiftUI `.textSelection`, whose
  long-press menu (Copy/Share) owns the gesture. Adding Quote there needs the
  same whole-row menu that BET-1363 removed. Reply-level quoting covers the
  dominant case.
- **Quote items in the native edit menu of transcript prose.** RichText 1.0.0
  owns the `UITextView` delegate. A responder-chain `buildMenu(with:)` hack
  (`UIMenuSystem.context` plus an `@objc` `UITextView` extension) is untestable
  on Linux and fragile. Revisit if MarkdownView exposes an edit-menu hook.
- **Inline `/name` colouring in a user bubble.** It needs WS03's command and
  skill catalog. Without it, a `/path` would be falsely coloured.
- **Download button on media.** The desktop downloads to the Mac's Downloads
  folder. On iOS the QuickLook share sheet (Save Image / Save to Files) is the
  native equivalent, so there is no separate control.
- **Media "+N variants" beyond the first.** `media_show` displays one file; the
  desktop renders a grid only while pending. iOS matches that.

## Open questions

1. **Should the "Show reasoning & full output" switch persist?** Default: yes,
   app-wide in `UserDefaults`, off at first launch. The desktop resets it per
   panel, but on a phone a switch that resets whenever a chat is opened reads as
   broken.
2. **Who applies M1/M2, which touch files no workstream owns?** Default: WS01, in
   wave A, as additive-only edits, because WS01 is the only workstream that
   needs them in that wave.
3. **Is the tool name exactly `media_show` on the V2 plugin wire, with no
   namespace prefix?** Default: match `media_show`, and also any name ending in
   `_media_show` or `.media_show`. The implementer confirms against one real
   `opencode:messages` response and removes the extra matches if they are
   unused.
