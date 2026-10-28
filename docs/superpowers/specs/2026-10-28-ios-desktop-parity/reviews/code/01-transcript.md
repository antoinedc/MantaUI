# Code review — WS01 transcript (commit `94368930`)

Reviewer: Opus (code-review round). Scope: every file in `git show --stat 94368930`
(24 files), read in full, against `00-master.md`, `01-transcript.md` (incl. round
2–5 responses), `mobile/native/AGENTS.md` and root "NEVER STUB A CONTROL".

**Verification I ran.** The three Foundation-only files
(`TranscriptMediaModel.swift`, `TranscriptTurns.swift`,
`TranscriptDisplayOptions.swift`) plus `TranscriptParityTests.swift` were added to
a scratch copy of `Package.swift` (with WS03's two pure files, which
`ComposerTypeahead.swift` now needs) and run under `swift:6.1` in Docker
(`verify.sh` recipe): **build clean in Swift 6 language mode, all 70
TranscriptParityTests pass** (0 failures across the whole package). The
`TranscriptTurnVerb.index` expectations were re-derived with `node -e` and match
the desktop hash for all 8 fixtures; `formatTokens` tie handling checked against
JS `toFixed` (1250 → 1.3k, 99 950 → 100k). App-only files were reviewed by hand
(no Swift UI toolchain here); every referenced symbol was grepped
(`MantaLogoMark`, `Font.manta(size:weight:design:)`, `mantaFontWeight`,
`MantaDynamicType.scaled`, all `Tokens` members, `Metrics.radius.xs`,
`Metrics.spacing.spPx`, `ToolActivity.makeToolPart(…metadata:…)`,
`MantaEventStore(stream:tokenProvider:serverProvider:)`,
`addRawFrameHandler`, `MantaStreamFrame.decodedPayload`, `KeychainCredentialStore.boxId`,
`ActivityKind.task/.read`, `@MainActor protocol MantaEventStreamControl`). No
compile problem found.

Seams: every WS01 provider symbol in the mount ledger / member registry exists
with the pinned signature (`TranscriptMapOptions` fields, `blocks(from:voiceNotes:widgets:options:)`,
`liveMediaTail(messages:live:isLiveWindow:)`, `footerTruncationMessageIDs(_:)`,
`OpencodeCommandOrigin`, `TranscriptCommandOrigin.fromLive(name:arguments:)`,
`TranscriptLiveTruncation.from(kind:messageID:)`, `TranscriptMediaStore.shared`
`$sessions` / `entries(for:)`, `TranscriptDisplayOptions` `showDetails` /
`defaultsKey` / `setShowDetails(_:)` / `didChange`, `peekFileSize(path:)`,
`downloadPeekFile(path:to:maxBytes:)`, `static peekRequest(url:method:token:)`).
`onQuote` became optional and the only production call site
(`ChatScreen.swift:1456`) still compiles as a closure literal. Row ids are all
block-derived (`fufiles:`, `fmedia:h:`/`fmedia:s:`, `cmd-`, `r<partID>`, `tf-`)
and go through `uniqueTranscriptRows`; mapper/tail disjointness is tested.

---

## Findings

### 1. BLOCKING — the iOS transcript fetch strips the parts F2 and F4 depend on (reasoning rows never appear; canonical truncation never comes from `step-finish`)

**Where:** `ChatSessionStore.swift:1013` calls
`api.messages(sessionId:limit:slim: true)`; the box's `slimTranscript`
(`src/server/opencode.mjs:367`) drops
`SLIM_DROP_PART_TYPES = ["step-start", "step-finish", "reasoning", "snapshot"]`.
WS01 consumes those parts in `ChatModels.swift` (`process` → `.reasoning`,
`layout(… showThinking: options.showReasoning)`) and
`TranscriptTurns.swift:62-70` (`TranscriptTruncation.kind(of:)` reads the
`step-finish` part's `reason`).

**Problem.** On the real chat screen (and the subagent drill-in, same store) the
transcript never contains a `reasoning` or `step-finish` part, so:
- F2: turning on "Show reasoning & full output" never produces a single
  "Thinking…" row. Half of the switch (and of M-01-5's overflow row, which
  promises "Thinking steps…") does nothing — a dead control per the root rule,
  and F2's third acceptance item fails.
- F4: the canonical kind can only come from `info.finish` (V2's *normalised*
  finish). `"length"` still yields output-cap, but **context-wall and tool-cutoff
  can never be derived canonically** (they need `rawFinish`), so they vanish on
  reload, contrary to the spec's "canonical first" design and its tests.
- The mapper tests pass only because their fixtures are unslimmed transcripts —
  nothing exercises the real fetch shape.

Neither the spec nor any round caught this (`grep -i slim` in the spec folder
finds only an unrelated WS09 row), so the fix needs an orchestrator decision.

**Fix (pick one per part; both are small):**
1. *Reasoning* — add mount request **M-01-7** (receiving `ChatSessionStore.swift`,
   applier WS02, wave B): fetch with
   `slim: !TranscriptDisplayOptions.showDetails`, and on
   `TranscriptDisplayOptions.didChange` **refetch** (not just `remap()`, as
   M-01-3 says today) when the switch turns on. Record it in the ledger and in
   WS02's receipt table. Alternatively (server, needs a D7 amendment): stop
   dropping `reasoning` from `SLIM_DROP_PART_TYPES`.
2. *Truncation* — either (a) server, D7 amendment: keep `step-finish` in slim but
   reduce it to `{id, type, messageID, reason}` (tiny; tokens/cost already live
   in `info`), with a node test that `slimTranscript` keeps `reason`; or (b) spec
   amendment: canonical truncation = `info.finish` only, state that
   context-wall / tool-cutoff do not survive a reload on iOS, and update the F4
   acceptance + the `kind(of:)` doc comment accordingly.
3. Add one mapper test per chosen option that feeds a transcript in the shape
   the store actually fetches (run the fixture through the same part filter), so
   the dependency is pinned.

### 2. SHOULD — verbose output well: nested `ScrollView` in a `List` row with only `maxHeight`, recomputed every render

**Where:** `ActivitySheet.swift` `outputWell(_:)` (the `ScrollView(.vertical) { … }.frame(maxHeight: 480)` branch) inside `ActivitySheet`'s `List` (`ActivitySheet.swift` ~`:230`).

**Problem.** (a) A vertical `ScrollView` inside a self-sizing `List` row with no
fixed height is the classic "collapses to a sliver / wrong height" case; nothing
here pins its height, and there is no device evidence it sizes to
`min(content, 480)`. (b) `ToolActivity.outputForDisplay` (a
`components(separatedBy: "\n")` over the whole output + `count`/`suffix`) runs in
`body` on every re-render; while the run is live the sheet re-renders on every
store change, so a 50 000-line output is re-split continuously — the acceptance
item "does not freeze the sheet" is not demonstrated.

**Fix.** Verify on the simulator (`ios-mantaui` `simulator`) with a 50 000-line
bash output. If the well collapses, give it an explicit height:
`.frame(height: min(480, CGFloat(lineCount) * lineHeight + 2 * Metrics.spacing.sp2))`
using the line count already computed for the trim. Cache the
`(text, trimmed)` result per `(part.id, output.utf8.count, showDetails)` (e.g. a
small `@State` keyed by those, or compute once in the row's init) instead of in
`body`.

### 3. SHOULD — media reserved box is not built from `TranscriptMediaGeometry.box(_:availableWidth:)`

**Where:** `TranscriptMediaCard.swift:93-104` (`Color.clear.aspectRatio(…, contentMode: .fit).frame(maxWidth:)`).

**Problem.** The spec's "box never changes height" guarantee is defined by
`box(_, availableWidth:)`; production never calls it (only tests do). An
aspect-ratio view on `Color.clear` depends on the cell being proposed a concrete
width; if TiledView's self-sizing pass proposes `nil`/`.unspecified` width,
`Color.clear`'s ideal size (10×10) wins and the box collapses, then jumps when
the real width arrives — exactly the jump the design forbids.

**Fix.** Verify on device (pending → ready transition, a 1:3 image, a video with
null dims) that the row height is identical across states and on first layout.
If not, measure the container once (`onGeometryChange(for: CGFloat.self) { $0.size.width }`
into `@State`) and apply `.frame(width: b.width, height: b.height)` from
`TranscriptMediaGeometry.box(entry.reserved, availableWidth:)`, keeping the
current aspect-ratio path only as the pre-measurement fallback.

### 4. NIT — `TranscriptQuoteCapability.canQuote` is not what the production gates use

**Where:** `TranscriptTurnFooterView.swift:27`, `TranscriptSelectText.swift:30`
(both test `onQuote != nil`); `TranscriptRow.swift` `TranscriptQuoteCapability`.

**Problem.** Behaviour is equivalent today (the row passes `actions.onQuote`,
`actions = cards ?? .readOnly()`), but the spec says both surfaces gate on
`canQuote(cards)`, and the tested helper is dead code.

**Fix.** In `transcriptBlockView`'s `.turnFooter` case pass
`onQuote: TranscriptQuoteCapability.canQuote(cards) ? actions.onQuote : nil`,
or drop the helper and its tests and say so in the spec.

### 5. NIT — Select-text sheet: markdown styling is silently dropped and the font doesn't scale

**Where:** `TranscriptSelectText.swift` `attributed()` / `apply(to:)`.

**Problem.** `NSAttributedString(AttributedString(markdown:))` carries
`inlinePresentationIntent`, which `UITextView` does not render, then every run
gets the plain body font — bold/italic/code markers are removed but no styling
replaces them; the comment claims the traits are set. `adjustsFontForContentSizeCategory = true`
has no effect on a `UIFont.systemFont(ofSize:)` font.

**Fix.** Map `inlinePresentationIntent` (`.stronglyEmphasized` → bold,
`.emphasized` → italic, `.code` → monospaced) to `UIFont` while enumerating runs,
or render plain text; build the base font with
`UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: Metrics.type.body))`.
Correct the comment either way.

### 6. NIT — quote after dismiss uses a fixed 350 ms sleep

**Where:** `TranscriptSelectText.swift:168-176`.

**Fix.** Store the pending `(selection, destination)` in the footer's state and
fire it from `.sheet(isPresented: $showSelect, onDismiss: …)` in
`TranscriptTurnFooterView`, which is the real "sheet is gone" signal.

### 7. NIT — a background-result message's own prose leaks into the next turn's `turnText`

**Where:** `ChatModels.swift` assistant case: `if TranscriptTurns.isBackgroundResult(msg) { turnProse = [] }`
runs before that message's blocks are appended to `turnProse`.

**Problem.** Desktop treats the result message as the turn *head*, not part of
the reply; if it ever carries text, iOS's "Quote" would include it.

**Fix.** Skip the `turnProse.append` loop when `isBackgroundResult(msg)` (keep
the reset). `TranscriptTurns.isBackgroundResult` also ignores the
`info.background` flag the spec lists; acceptable given the comment, but note it.

### 8. NIT — "Too large" size uses MiB but says "MB"

**Where:** `TranscriptMediaCard.swift:279-281`.

**Fix.** Use `ByteCountFormatter.string(fromByteCount:countStyle: .file)` so a
30 000 000-byte file reads "30 MB" (acceptance wording), not "29 MB".

### 9. NIT — open question 1 left open

**Where:** `TranscriptMediaModel.swift:331-333` (`isTool` accepts `_media_show` / `.media_show`).

**Fix.** The V2 plugin registers plain `media_begin` / `media_show`
(`docs/opencode-plugins-v2/manta/tools/media.ts`) and `toolNameFromV2` passes
unknown names through unchanged; per the spec, confirm once against a real
`opencode:messages` response and drop the suffix matches, or record why they stay.

### 10. NIT — live media store is never pruned / reset

**Where:** `TranscriptMediaStore.swift` (`sessions`, `lastRunning`).

**Problem.** Every session that ever runs gets a state entry for the app's
lifetime, and nothing clears it on box change. Small, and ids don't collide
across boxes, so harmless today.

**Fix.** Drop `sessions[sid]` when its `byID` is empty and the turn closes, or
add `resetForBoxChange()` for the `mantaBoxRemoved` path later.

---

**Counts:** 1 BLOCKING · 2 SHOULD · 7 NIT

VERDICT: CHANGES REQUIRED
