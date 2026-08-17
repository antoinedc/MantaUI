import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

// ===========================================================================
// S5 — the composer (BET-597).
//
// The app's primary control, attached to the bottom of the chat screen. Three
// extras land here, all ported — none reimplemented:
//
//   1. Attachments — native PhotosPicker + UIDocumentPicker, uploaded through
//      the UNCHANGED `POST /api/upload?session=<project>` endpoint (raw bytes
//      + `X-Filename`, exactly as the desktop's uploadBuffer does), then sent
//      as FilePart attachments on `opencode:prompt`.
//   2. Model picker — per-session override (UserDefaults) with the configured
//      default as fallback; box data from `opencode:models`/`default-model`.
//   3. Voice — hold to record + dictate (insert at caret); voice notes are a
//      dedicated companion surface. The mic button is
//      hidden when no Groq key is configured (same as desktop).
//
// The device does NOT transcribe or classify — Groq runs on the box (voice:*
// RPCs). Every colour/spacing/radius/size resolves through the tokens.
// ===========================================================================

struct ComposerAttachment: Identifiable, Equatable {
    let id = UUID()
    let filename: String
    var mime: String
    /// Set once the upload completes; nil while the attachment is still being
    /// read + uploaded. A chip with a nil path renders a loading spinner.
    var remotePath: String?
    let isImage: Bool

    /// True until the upload finishes — the chip is a placeholder.
    var isUploading: Bool { remotePath == nil }
}

struct ComposerView: View {
    let sessionId: String
    let projectName: String
    let api: MantaAPIClient
    @ObservedObject var store: ChatSessionStore
    @ObservedObject var modelStore: ChatModelStore
    /// The plan-usage snapshot set (BET-824). The composer's band-coloured dot
    /// reads the 5-hour session window from it; the ring is the dot's only
    /// content — no percentage, no label.
    @ObservedObject var usageStore: UsageStore
    /// Tapped → the parent presents the usage sheet. Presented from the parent
    /// (not here) because ComposerView already presents the model sheet, and
    /// SwiftUI honours only one presentation per view on some versions.
    var onShowUsage: (() -> Void)? = nil
    /// Whether the transcript is scrolled up far enough that the round
    /// "scroll to bottom" control — in the model-selection row — should show.
    var showScrollToBottom: Bool = false
    /// Tapped → scroll the transcript to the newest message.
    var onScrollToBottom: (() -> Void)? = nil
    /// Reports the height of the glass input box PLUS the composer's own
    /// bottom padding — i.e. the distance from the glass box's top edge to
    /// the bottom of this view. ChatScreen sizes the under-composer scrim
    /// from this, so the fade starts exactly at the glass box's top edge,
    /// not at the top of the whole bottom stack (chip / cards / anchors
    /// excluded).
    var onGlassBoxHeightChange: (CGFloat) -> Void = { _ in }
    /// The session's working directory, threaded from the chat screen so the
    /// `@`-file typeahead searches within the session (BET-749). `findFiles`
    /// takes it directly, the same way `vcsBranch` does; nil when the session
    /// hasn't been resolved yet.
    var sessionDirectory: String? = nil
    /// Performs a `/clear` (BET-749 slash palette). Optional: the chat screen
    /// owns clearing + re-navigation; the composer just triggers it.
    var onSlashClear: (() -> Void)? = nil
    /// Performs a `/fork` (BET-749 slash palette). Optional: the chat screen
    /// owns forking + navigation; the composer just triggers it.
    var onSlashFork: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.layoutDirection) private var layoutDirection

    @State private var text = ""
    @State private var attachments: [ComposerAttachment] = []
    @State private var showPhotoPicker = false
    @State private var showDocPicker = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var micAvailable = false
    @State private var hint: String?
    @State private var showHint = false
    @FocusState private var inputFocused: Bool
    @StateObject private var recorder = VoiceRecorder()
    /// High-water flag for a press whose permission prompt is still resolving —
    /// lets the mic's press-start re-check after the await so a second change
    /// doesn't double-request permission.
    @State private var recordingStartInFlight = false
    /// Auto-dismiss task for the currently shown hint — tied to the hint's own
    /// identity so a new hint cancels and restarts the 4 s timer.
    @State private var hintDismissTask: Task<Void, Never>?
    @State private var showModelPicker = false
    /// Whether the text has grown beyond the expand overlay's threshold — only
    /// gates the full-screen edit affordance, since the composer is always two
    /// rows (see `updateLayout`).
    @State private var isTall = false
    /// The near-full-screen editing sheet, opened by the expand control.
    @State private var showExpanded = false
    /// The active `@`-file token the cursor is inside (nil when no mention is
    /// being composed) — BET-749 gap #10.
    @State private var activeMention: ComposerTypeahead.MentionAnchor?
    /// The `findFiles` matches for the active mention query, capped to bound
    /// RPC chatter. Empty hides the typeahead.
    @State private var fileResults: [String] = []
    /// Mentions chosen from the `@` typeahead, pending on the draft. They
    /// serialize onto the next send via the existing `Mention` path.
    @State private var draftMentions: [SendPromptInput.Mention] = []
    /// Debounced `findFiles` task (owned here so a fast typist doesn't pile up
    /// parallel RPCs) + the sequence guard that discards stale responses.
    @State private var fileSearchTask: Task<Void, Never>?
    @State private var fileSearchSeq = 0
    private var tokens: Tokens { Tokens.scheme(colorScheme) }
    /// Whether the layout direction is right-to-left — mirrored for the
    /// slide-to-cancel gesture (the machine + progress helpers mirror dx).
    private var isRTL: Bool { layoutDirection == .rightToLeft }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            // The pickers hang off a neutral, zero-size anchor. They cannot go
            // on the composer root (the model sheet is there) nor on the attach
            // button (a Menu is itself a presentation) — in both cases SwiftUI
            // runs one presentation and silently drops the others, which is
            // exactly how attaching a file came to do nothing at all.
            pickerAnchor
            expandAnchor
            // The `@`-file typeahead and the `/` slash palette float just above
            // the box (BET-749). At most one is active: `@` and `/` are disjoint
            // triggers, and each is nil unless its token is genuinely being
            // composed.
            if let palette = slashPalette {
                slashPaletteView(palette)
                    .transition(.opacity)
            }
            if activeMention != nil, !fileResults.isEmpty {
                mentionTypeahead
                    .transition(.opacity)
            }
            // The jump-to-bottom control sits right above the composer,
            // centered — not in the control row. Shown only while scrolled up.
            if showScrollToBottom {
                HStack {
                    Spacer(minLength: 0)
                    scrollToBottomChip
                    Spacer(minLength: 0)
                }
            }
            // Failure/notice hints surface ABOVE the input row as a capsule.
            // Show/hide is driven by `showHint` through the composer's existing
            // `withAnimation` default, so no custom animation is needed.
            if showHint, let hint {
                hintCapsule(text: hint)
            }
            // Two-row composer (BET: model inside the composer): the text input
            // sits at the top and the control row — model selector + attach on
            // the LEFT, mic + send on the RIGHT — is pinned to the box's last
            // line, INSIDE the same glass as the input. Hence the composer is
            // two rows by default — type up top, act below — rather than a
            // one-row capsule with inline controls.
            //
            // While a voice take is active the input box is REPLACED in place
            // by the recording surface (BET-1028, decision #1) — same position,
            // same outer padding, so nothing in the layout jumps. The surface
            // renders the machine's `VoicePhase`; it owns no transition logic.
            if recorder.phase == .idle {
                inputBox
                    .transition(.opacity)
            } else {
                VoiceRecordingSurface(
                    recorder: recorder,
                    isRTL: isRTL,
                    onTake: { take in
                        Task { await transcribe(data: take.data) }
                    }
                )
                .transition(.opacity)
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .animation(.smooth(duration: 0.22), value: recorder.phase != .idle)
        // ONE presentation per view. The model sheet, the photo picker and the
        // file importer were all attached HERE, and SwiftUI honours only one of
        // them — which is why attaching a file silently did nothing. The two
        // pickers now hang off the attach button instead (see attachButton).
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(modelStore: modelStore)
        }
        // Attachment chips live inside the box, so adding/removing one moves
        // the box (and the control row beneath it) on the same curve as the
        // text growing — no snapping when a chip appears or is dismissed.
        .animation(.smooth(duration: 0.22), value: attachments.count)
        .onChange(of: photoItems) { _ in
            Task { await processPhotos() }
        }
        .onChange(of: text) { _, newValue in
            handleTextChange(newValue)
        }
        .animation(.smooth(duration: 0.18), value: typeaheadOpen)
        .onChange(of: store.actionHint) { _, hint in
            guard let hint else { return }
            surfaceHint(hint)
            store.actionHint = nil
        }
        .onAppear {
            modelStore.load()
            checkMicAvailability()
            // Deliberately NOT focusing the input here: raising the keyboard on
            // entry hides most of the transcript you opened the session to
            // read. Tapping the input is the way in, as in Messages.
        }
    }

    // The composer's top hairline — and the ambient `RefetchSweep` that ran
    // along it during a background refetch (BET-630 D1) — are both gone with
    // the full-bleed bar: the floating box has no divider to sweep. The refetch
    // signal moved onto the box's border (see `boxChrome`), so the state is
    // still shown and still never shares an indicator with the running row.

    // MARK: - Input box + control row (two-row composer)

    /// One visual line of the input's font — the unit the layout switch is
    /// measured in. Taken from the font itself rather than guessed, so it
    /// tracks a type-scale change.
    private var lineHeight: CGFloat {
        MantaDynamicType.scaled(UIFont.systemFont(ofSize: Metrics.type.body).lineHeight)
    }

    /// The editor's measured height for a given number of text lines.
    ///
    /// The `+ sp2` is the editor's own internal padding and is the whole reason
    /// this helper exists — the previous mode-switch thresholds were bare
    /// multiples of `lineHeight` and ignored it, so every comparison was off by
    /// most of a line. Expressing the thresholds in LINES and converting here
    /// keeps them honest.
    private func editorHeight(forLines lines: CGFloat) -> CGFloat {
        lineHeight * lines + Metrics.spacing.sp2
    }

    /// Re-evaluate the layout from a fresh text height. `isTall` now only gates
    /// the expand overlay (the composer is always two rows), so a plain
    /// "more than two lines" threshold suffices — the hysteresis that used to
    /// guard a mode switch is gone because there is no mode switch to oscillate.
    private func updateLayout(for height: CGFloat) {
        let next = height > editorHeight(forLines: 2)
        guard next != isTall else { return }
        withAnimation(.smooth(duration: 0.22)) { isTall = next }
    }

    /// Corner radius: slightly MORE rounded on a single line (the resting
    /// state), easing back to the box's standard radius once the input grows
    /// past the `isTall` threshold. The radius animates with `isTall` (which
    /// flips under `withAnimation`), so the box breathes rather than snapping.
    private var cornerRadius: CGFloat {
        isTall ? Metrics.radius.lg : Metrics.radius.xl
    }

    /// The input box — the whole composer. The message (and attachment chips
    /// above it) sits at the top; the control row is pinned to the LAST LINE of
    /// the box, inside the same glass, so model + attach / mic + send read as
    /// the box's own footer rather than loose chrome below it.
    private var inputBox: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            // Chips rail — ONLY when something is actually attached. When the
            // box is merely tall there is no rail; the expand control is an
            // overlay (below) and so needs no row of its own.
            if !attachments.isEmpty {
                chipsRow
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Stop short of the expand control so a long chip list
                    // scrolls under its own clip instead of running into it.
                    .padding(.trailing, isTall ? Metrics.spacing.sp6 : 0)
                    .clipped()
            }

            // Plan mode label — one line above the text area so the mode stays
            // visible where you type (BET-952). Phones lose ambient state
            // fastest, so plan mode must be readable at a glance.
            if modelStore.planOn {
                Label("Plan mode · edits blocked", systemImage: planIcon)
                    .font(.manta(size: Metrics.type.twoXS, weight: mantaFontWeight(Metrics.type.medium)))
                    .foregroundColor(tokens.accentTx)
                    .padding(.bottom, Metrics.spacing.spPx)
            }

            // The message line.
            textArea

            // Control row — pinned to the box's final line. No separator above
            // it: the text and the controls sit on one continuous glass surface.
            controlRow
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .modifier(BoxChrome(cornerRadius: cornerRadius, stroke: borderColor, tint: tokens.panel.opacity(0.35)))
        // The expand control is an OVERLAY, not a row: it must sit in the top
        // right corner whether or not there are chips to share a line with, and
        // as an overlay it costs no vertical space when there are none.
        .overlay(alignment: .topTrailing) {
            if isTall {
                expandButton
                    .padding(.top, Metrics.spacing.sp2)
                    .padding(.trailing, Metrics.spacing.sp3)
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            onGlassBoxHeightChange(height + Metrics.spacing.sp2)
        }
    }

    /// The control row — model selector and attach grouped on the LEFT, mic +
    /// send on the RIGHT. Rendered inside `inputBox`, pinned to its last line,
    /// so it reads as the composer's footer: type in the box, act on its bottom
    /// line. The jump-to-bottom control lives above the composer, not here.
    private var controlRow: some View {
        HStack(spacing: Metrics.spacing.sp2) {
            // Model + dot + attach sit close together; the dot hugs the model
            // label. Final order `[modelPill] [dot] [plan] [attach]` — the dot is
            // always present (textless), between the label and the paperclip.
            // The plan chip sits immediately after the model pill (BET-952).
            HStack(spacing: 0) {
                modelPill
                usageDot
            }
            planToggleChip
            attachButton
            Spacer(minLength: 0)
            if micAvailable {
                micButton
            }
            sendButton
        }
    }

    // MARK: - Plan-usage dot (BET-824)

    /// The band-coloured ring beside the model name, filled clockwise from
    /// 12 o'clock to the session window's percentage (a solid disc at/over
    /// 100). Colour + fraction only — no number, no label, ever. It tracks
    /// the 5-hour `session` window, always (a dot that silently switched
    /// windows would force a tap to know what the colour meant). Hidden when
    /// there is no session window.
    @ViewBuilder
    private var usageDot: some View {
        if let window = UsageMeters.sessionWindow(usageStore.snapshots) {
            Button { onShowUsage?() } label: {
                MeterRing(pct: window.pct,
                          color: MeterRing.tint(UsageMeters.band(window.pct), tokens),
                          diameter: 13,
                          lineWidth: 2.5,
                          track: tokens.borderSubtle)
            }
            .buttonStyle(.plain)
            // 44pt tap target around the 13pt ring — colour+fill costs no
            // width and survives accessibility type sizes.
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .accessibilityLabel("Plan usage")
            .accessibilityIdentifier("usage-dot")
        }
    }

    /// Accent while a background refetch is in flight, and never while a turn
    /// runs — the two states must not share an indicator (BET-630 D1).
    private var borderColor: Color {
        // Plan mode tints the whole glass box with the accent tone so the mode
        // is visible where you type (BET-952). Same tone as the "on" state.
        if modelStore.planOn { return tokens.accent }
        return store.refreshing && !store.running ? tokens.accent : tokens.borderSubtle
    }

    /// The plan-mode capsule in the control row, immediately after the model
    /// pill (BET-952). Deliberately a per-turn, consequential control, so it
    /// lives in the composer row — NOT the model sheet. Hidden entirely when
    /// unavailable-and-off (the iOS convention used for fast on a narrow
    /// screen), so a box with no plan agent shows no greyed chip.
    @ViewBuilder
    private var planToggleChip: some View {
        let plan = modelStore.planToggle
        if !plan.available && !plan.on {
            EmptyView()
        } else {
            Button {
                modelStore.setPlan(!plan.on)
            } label: {
                HStack(spacing: Metrics.spacing.sp1) {
                    Image(systemName: planIcon)
                        .font(.system(size: Metrics.type.xs, weight: .medium))
                    Text("Plan")
                        .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                }
                .foregroundColor(plan.on ? tokens.accentTx : tokens.tx2)
                .padding(.vertical, Metrics.spacing.sp1)
                .padding(.horizontal, Metrics.spacing.sp2)
                .background(plan.on ? tokens.accentSoft : tokens.inset, in: Capsule())
            }
            .buttonStyle(.plain)
            // A lit-but-unavailable chip is honest, not toggleable: the plan
            // agent vanished mid-toggle, so it must not be clickable to "off".
            .disabled(!plan.available)
            .accessibilityLabel("Plan mode")
            .accessibilityHint(plan.title)
            .accessibilityIdentifier("plan-mode-toggle")
        }
    }

    /// The plan chip glyph — `compass.drawing` (the SF counterpart of the
    /// desktop `DraftingCompass`), falling back to `pencil.and.ruler` when the
    /// symbol is unavailable on the deployment target.
    private var planIcon: String {
        UIImage(systemName: "compass.drawing") != nil ? "compass.drawing" : "pencil.and.ruler"
    }

    /// The message field at the top of the box. It reports its own height so
    /// `isTall` can gate the expand overlay once the text wraps past two lines.
    private var textArea: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text("Message…")
                    .font(.manta(size: Metrics.type.body))
                    .foregroundColor(tokens.tx4)
                    .padding(.top, 8)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .scrollContentBackground(.hidden)
                .frame(minHeight: lineHeight + Metrics.spacing.sp2,
                       maxHeight: lineHeight * 6)
                .fixedSize(horizontal: false, vertical: true)
                .focused($inputFocused)
                .accessibilityIdentifier("composer-input")
                // `onGeometryChange` rather than a PreferenceKey +
                // `onPreferenceChange`: under Swift 6 that pair reports the
                // height through a @Sendable closure, which cannot write to
                // this view's @State without hopping actors. This modifier is
                // the iOS 18 replacement built for exactly this and runs on the
                // main actor already.
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { height in
                    updateLayout(for: height)
                }
        }
    }

    /// Opens the near-full-screen editing sheet. Only shown once the message is
    /// long enough (past the `isTall` threshold) for the small box to be the
    /// constraint.
    private var expandButton: some View {
        Button {
            showExpanded = true
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.system(size: Metrics.type.small, weight: .semibold))
                .foregroundColor(tokens.tx3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Expand composer")
        .accessibilityIdentifier("composer-expand")
    }

    /// The expanded sheet hangs off its OWN zero-size anchor. It cannot go on
    /// the composer root, which already carries the model-picker sheet — when
    /// two sheet-family presentations sit on one view SwiftUI honours only one
    /// of them, which is the bug that once made attaching a file do nothing.
    private var expandAnchor: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .sheet(isPresented: $showExpanded) { expandedComposer }
    }

    /// Near-full-screen editing surface: the text fills the sheet, a collapse
    /// control sits top-right and send sits bottom-right. Sending closes the
    /// sheet, because the message it was opened to write is gone.
    private var expandedComposer: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    showExpanded = false
                } label: {
                    Image(systemName: "arrow.down.right.and.arrow.up.left")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(tokens.tx2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Collapse composer")
            }
            if !attachments.isEmpty { chipsRow }
            TextEditor(text: $text)
                .font(.manta(size: Metrics.type.body))
                .foregroundColor(tokens.tx1)
                .scrollContentBackground(.hidden)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("composer-input-expanded")
            HStack(spacing: Metrics.spacing.sp2) {
                attachButton
                Spacer(minLength: 0)
                if micAvailable { micButton }
                Button {
                    submit()
                    showExpanded = false
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: Metrics.type.body, weight: .semibold))
                        .foregroundColor(canSend ? tokens.onAccent : tokens.tx4)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                        .background(canSend ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(Metrics.spacing.sp4)
        .background(tokens.panel.ignoresSafeArea())
        .presentationDetents([.large])
    }

    // MARK: - Model pill → cockpit sheet (BET-894)

    /// The composer chip: a plain button anchored on a filled capsule. The
    /// capsule is ONE token — "✦ Opus 4.7 · High" plus a bolt when fast — with
    /// a fill, so the resolved (model · effort · fast) triple reads at a glance
    /// and the model name can never wrap. Tapping opens the model sheet, whose
    /// cockpit hosts the effort/fast controls + recents that a SwiftUI `Menu`
    /// (a UIKit menu) cannot lay out — see `ModelPickerSheet`'s header comment.
    private var modelPill: some View {
        Button { showModelPicker = true } label: {
            chipLabel
        }
        .accessibilityLabel("Model")
        .accessibilityIdentifier("model-picker")
    }

    /// The chip's single-line label: "✦ Opus 4.7 · High" + bolt when fast.
    /// `.lineLimit(1)` + `.fixedSize(horizontal:)` is load-bearing — the model
    /// name must never wrap at any Dynamic Type size.
    private var chipLabel: some View {
        HStack(spacing: Metrics.spacing.sp1) {
            if modelStore.loaded {
                Image(systemName: "sparkles")
                    .font(.system(size: Metrics.type.xs, weight: .medium))
                Text(resolvedChipText)
                    .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if isFastActive {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: Metrics.type.xs, weight: .semibold))
                }
            } else {
                // Box-wide model list still arriving — show an explicit
                // loading state rather than a misleading "Default".
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Loading models")
            }
        }
        .foregroundColor(tokens.accentTx)
        .padding(.vertical, Metrics.spacing.sp1)
        .padding(.horizontal, Metrics.spacing.sp2)
        .background(tokens.accentSoft, in: Capsule())
        .lineLimit(1)
    }

    private var activeModel: OpencodeModel? {
        ChatModel.activeModel(modelStore.models, override: modelStore.override, default: modelStore.defaultModel)
    }

    private var isFastActive: Bool {
        guard let active = activeModel else { return false }
        return ChatModel.isFastModelID(active.id)
    }

    /// The chip's resolved triple as a single run: "Opus 4.7 · High" (the ⚡
    /// is a separate bolt glyph). One run, never two — three axes with only
    /// one visible is how a quota gets burned on max effort unnoticed.
    private var resolvedChipText: String {
        guard let model = activeModel else { return "Default" }
        var parts = [model.name]
        if let variant = modelStore.variant, !variant.isEmpty {
            parts.append(ChatModel.effortLabel(variant))
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Scroll to bottom

    /// The round glass "jump to bottom" control — floats centered just above
    /// the composer (not in the control row). Round and small (sized to the
    /// model chip's height) so it stays a secondary affordance that does not
    /// compete with the composer controls.
    private var scrollToBottomChip: some View {
        Button {
            onScrollToBottom?()
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: Metrics.type.xs, weight: .semibold))
                .foregroundColor(tokens.tx1)
                .frame(width: Self.scrollChipDiameter, height: Self.scrollChipDiameter)
        }
        .buttonStyle(.glass)
        .clipShape(.circle)
        .accessibilityLabel("Scroll to bottom")
    }

    /// Diameter of the round scroll control — the model chip's height (one
    /// line of its small text plus its vertical padding), so chip and control
    /// read as one aligned row.
    private static let scrollChipDiameter: CGFloat =
        UIFont.systemFont(ofSize: Metrics.type.small).lineHeight + Metrics.spacing.sp1 * 2

    // MARK: - Attach

    private var attachButton: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label("Photo", systemImage: "photo")
            }
            Button {
                showDocPicker = true
            } label: {
                Label("File", systemImage: "doc")
            }
        } label: {
            // No filled circle behind the glyph: inside the composer box these
            // are secondary controls, and a dark disc on a glass surface read
            // as a hole punched in it. Send keeps its fill — it is the one
            // primary action here. Tint still carries the attached state.
            Image(systemName: "paperclip")
                .font(.system(size: Metrics.type.body, weight: .medium))
                .foregroundColor(attachments.isEmpty ? tokens.tx2 : tokens.accentTx)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .contentShape(Rectangle())
                .accessibilityLabel("Attach")
        }
        .accessibilityIdentifier("attach-button")
    }

    /// A picked file shows a placeholder chip immediately, then resolves it via
    /// a background read + upload. Before, the file was read and uploaded
    /// before anything appeared, so a large file read looked like nothing
    /// happened.
    private func handleDocument(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        let accessed = url.startAccessingSecurityScopedResource()
        let filename = url.lastPathComponent
        let mime = ChatVoice.mime(forFilename: filename)
        let placeholder = ComposerAttachment(
            filename: filename, mime: mime, remotePath: nil,
            isImage: mime.hasPrefix("image/"))
        attachments.append(placeholder)
        let id = placeholder.id
        Task {
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                await MainActor.run { failAttachment(id: id, hint: "Couldn't read that file") }
                return
            }
            do {
                let remote = try await api.upload(project: projectName, filename: filename, data: data)
                await MainActor.run { completeAttachment(id: id, remote: remote, mime: nil) }
            } catch {
                await MainActor.run { failAttachment(id: id, hint: "Upload failed") }
            }
        }
    }

    /// Phase-then-load for the PhotosPicker: placeholder chips for EVERY
    /// selected photo appear on the same tick the picker dismisses, then each
    /// is read + uploaded and resolved in place. Previously each photo was
    /// loaded and uploaded before its chip appeared, so the first (and slowest
    /// — `loadTransferable(type: Data.self)` pulls the full-resolution image)
    /// stage read as a dead tap.
    ///
    /// `@MainActor`: the awaited read/upload suspend but this keeps every
    /// `@State` mutation on the main actor without `MainActor.run` hops.
    @MainActor
    private func processPhotos() async {
        struct Pending {
            let item: PhotosPickerItem
            let id: UUID
            let filename: String
        }

        let picked = photoItems
        photoItems = []

        // Phase 1 — one placeholder per photo, synchronously, so there is
        // never a gap with nothing on screen.
        var pending: [Pending] = []
        for (index, item) in picked.enumerated() {
            let filename = "photo-\(Int(Date().timeIntervalSince1970 * 1000))-\(index).jpg"
            let placeholder = ComposerAttachment(
                filename: filename, mime: "image/jpeg", remotePath: nil, isImage: true)
            attachments.append(placeholder)
            pending.append(Pending(item: item, id: placeholder.id, filename: filename))
        }

        // Phase 2 — read + upload each, resolving its chip in place.
        for entry in pending {
            guard let data = try? await entry.item.loadTransferable(type: Data.self) else {
                failAttachment(id: entry.id, hint: "Couldn't load photo")
                continue
            }
            let mime = ChatVoice.mime(forImageData: data)
            do {
                let remote = try await api.upload(project: projectName, filename: entry.filename, data: data)
                completeAttachment(id: entry.id, remote: remote, mime: mime)
            } catch {
                failAttachment(id: entry.id, hint: "Photo upload failed")
            }
        }
    }

    /// Move a placeholder chip to its ready state once the remote path is
    /// known. No-op if the user removed the chip meanwhile (a removed upload
    /// never resurfaces).
    @MainActor
    private func completeAttachment(id: UUID, remote: String, mime: String?) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].remotePath = remote
        if let mime { attachments[index].mime = mime }
    }

    /// Drop a failed placeholder (the chip never shows a dead state) and
    /// surface the reason.
    @MainActor
    private func failAttachment(id: UUID, hint: String) {
        guard attachments.contains(where: { $0.id == id }) else { return }
        attachments.removeAll { $0.id == id }
        surfaceHint(hint)
    }

    /// Zero-size host for the photo/file pickers. See the call site.
    private var pickerAnchor: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 5, matching: .images)
            .fileImporter(isPresented: $showDocPicker, allowedContentTypes: [.item]) { result in
                handleDocument(result)
            }
    }

    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Metrics.spacing.sp1) {
                ForEach(attachments) { attachment in
                    HStack(spacing: Metrics.spacing.sp1) {
                        // A placeholder chip (upload in flight) swaps the icon
                        // for a spinner so the "something is happening" is
                        // explicit instead of a static photo glyph.
                        if attachment.isUploading {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(tokens.accentTx)
                        } else {
                            Image(systemName: attachment.isImage ? "photo" : "doc")
                                .font(.system(size: Metrics.type.twoXS))
                                .foregroundColor(tokens.accentTx)
                        }
                        Text(ChatVoice.chipLabel(forFilename: attachment.filename))
                            .font(.manta(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.accentTx)
                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: Metrics.type.twoXS))
                                .foregroundColor(tokens.accentTx)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, Metrics.spacing.sp2)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .background(tokens.accentSoft, in: Capsule())
                }
            }
        }
        .accessibilityIdentifier("attachment-chips")
    }

    // MARK: - Voice

    private var micButton: some View {
        Button {
            // No-op on tap alone; recording is gesture-driven.
        } label: {
            ZStack {
                // The disc is drawn only while RECORDING. At rest the glyph
                // sits bare on the glass, like the attach control — a resting
                // dark disc read as a hole in the surface. While recording the
                // fill is the state indicator, so it stays.
                if recorder.isRecording {
                    Circle()
                        .fill(micIconFill)
                        .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                }
                Image(systemName: micIcon)
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(micIconColor)
            }
            .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in startRecordingIfPermitted() }
                .onEnded { _ in }
        )
        .accessibilityLabel("Record")
        .accessibilityHint("Tap to record, then slide up to lock or left to cancel")
        .accessibilityIdentifier("mic-button")
        .disabled(!micAvailable)
    }

    private var micIcon: String {
        recorder.isRecording ? "mic.fill" : "mic"
    }

    private var micIconFill: Color {
        recorder.isRecording ? tokens.accentSolid : tokens.inset
    }

    private var micIconColor: Color {
        recorder.isRecording ? tokens.onAccent : tokens.tx2
    }

    private func startRecordingIfPermitted() {
        guard micAvailable, !recorder.isRecording, !recordingStartInFlight else { return }
        recordingStartInFlight = true
        Task {
            let granted = await recorder.requestPermission()
            guard granted else {
                recordingStartInFlight = false
                recorder.fail("Microphone permission needed")
                hintState("Microphone permission is required")
                return
            }
            // The finger may have lifted while the permission prompt was up;
            // the held surface (which appears on start) owns the continued
            // gesture, so we don't re-check here — desktop parity keeps the
            // arms-the-take on press semantics of BET-1027.
            recordingStartInFlight = false
            recorder.start()
        }
    }

    private func transcribe(data: Data) async {
        let result = try? await api.voiceTranscribe(data: data, mime: "audio/mp4")
        let transcript = result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !transcript.isEmpty else {
            hintState("No speech detected")
            return
        }
        await MainActor.run { insertAtCaret(transcript) }
    }

    /// Insert text at the caret (dictate). If the composer's text field is the
    /// focused editor we insert at its live selection; otherwise fall back to
    /// appending (no caret to speak of).
    private func insertAtCaret(_ string: String) {
        if let tv = Self.activeTextView(),
           tv.selectedRange.location != NSNotFound,
           let current = tv.text {
            let result = Self.inserting(string, into: current, at: tv.selectedRange)
            text = result.newText
            tv.selectedRange = NSRange(location: result.cursorLocation, length: 0)
            tv.delegate?.textViewDidChange?(tv)
        } else {
            text += string
        }
    }

    /// Pure: the text + caret location that result from inserting `string` into
    /// `current` at the given selection. Testable without a UITextView.
    nonisolated static func inserting(
        _ string: String,
        into current: String,
        at selected: NSRange
    ) -> (newText: String, cursorLocation: Int) {
        let newText = (current as NSString).replacingCharacters(in: selected, with: string)
        return (newText, selected.location + (string as NSString).length)
    }

    /// The app's focused `UITextView` (first responder), if any — that is where
    /// the caret lives when the SwiftUI composer is the active editor.
    private static func activeTextView() -> UITextView? {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) else { return nil }
        return firstResponderTextView(in: window)
    }

    private static func firstResponderTextView(in view: UIView) -> UITextView? {
        if let tv = view as? UITextView, tv.isFirstResponder { return tv }
        for sub in view.subviews {
            if let found = firstResponderTextView(in: sub) { return found }
        }
        return nil
    }

    // MARK: - Send

    private var sendButton: some View {
        Button(action: { store.running ? store.abort() : submit() }) {
            Image(systemName: store.running ? "stop.fill" : "arrow.up")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(store.running || canSend ? tokens.onAccent : tokens.tx4)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .background(store.running || canSend ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!store.running && !canSend)
        .accessibilityLabel(store.running ? "Stop" : "Send")
        .accessibilityIdentifier("send-button")
    }

    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !attachments.contains { $0.isUploading }
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Never send while an attachment is still uploading (the button is
        // disabled too; this guards the non-button paths like voice submit).
        guard (!trimmed.isEmpty || !attachments.isEmpty),
              !attachments.contains(where: { $0.isUploading }) else { return }
        let model = modelStore.promptModel
        // canSend gates on no attachment still uploading, so none are dropped
        // here; compactMap keeps the unwrap type-safe.
        let sendAttachments: [SendPromptInput.Attachment] = attachments.compactMap { attachment in
            guard let remotePath = attachment.remotePath else { return nil }
            return SendPromptInput.Attachment(remotePath: remotePath, mime: attachment.mime, filename: attachment.filename)
        }
        let sentText = trimmed
        let mentions = draftMentions.isEmpty ? nil : draftMentions
        // Send the resolved plan agent only while plan mode is actually on.
        let agent = modelStore.planToggle.on ? modelStore.planToggle.agent : nil
        Task { @MainActor in
            // On a failed send the store rolled its running state back; restore
            // the user's message so it is never silently lost, and surface why.
            let ok = await store.send(text: sentText, attachments: sendAttachments, model: model, mentions: mentions, agent: agent)
            if !ok {
                text = sentText
                surfaceHint("Send failed — message restored")
            }
        }
        text = ""
        attachments = []
        draftMentions = []
        // Return to the compact form explicitly rather than waiting for the
        // emptied editor to re-measure. The measurement does arrive, but a beat
        // later — long enough for the box to sit stacked and empty after a
        // send, which reads as the composer being stuck.
        withAnimation(.smooth(duration: 0.22)) { isTall = false }
        inputFocused = true
    }

    // MARK: - @-file typeahead + / slash palette (BET-749 gap #10)

    /// True when either the `@` typeahead or the `/` palette is showing — the
    /// single value the popup animation keys off.
    private var typeaheadOpen: Bool {
        (activeMention != nil && !fileResults.isEmpty) || slashPalette != nil
    }

    /// The live caret, in UTF-16 units — read from the focused text view the
    /// same way dictation's insert-at-caret does. Falls back to end-of-text
    /// when no text view is focused.
    private var composerCaret: Int {
        Self.activeTextView()?.selectedRange.location ?? (text as NSString).length
    }

    /// The active `/` palette's filtered command list, or nil when the slash
    /// isn't being composed (no leading `/` / caret out of the word / no match).
    private var slashPalette: [ComposerTypeahead.SlashCommand]? {
        guard let anchor = ComposerTypeahead.detectSlash(in: text, caret: composerCaret) else { return nil }
        let filtered = ComposerTypeahead.filterSlashCommands(
            ComposerTypeahead.slashCommands(running: store.running),
            query: anchor.query
        )
        return filtered.isEmpty ? nil : filtered
    }

    /// The `@`-file typeahead: a compact floating list of `findFiles` matches.
    private var mentionTypeahead: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(fileResults, id: \.self) { file in
                Button {
                    selectFile(file)
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        Image(systemName: "doc")
                            .font(.system(size: Metrics.type.xs, weight: .medium))
                            .foregroundColor(tokens.accentTx)
                        Text("@\(file)")
                            .font(.manta(size: Metrics.type.small))
                            .foregroundColor(tokens.tx1)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mention-row")
            }
        }
        .padding(.vertical, Metrics.spacing.sp1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous)
                .stroke(tokens.borderSubtle, lineWidth: 1)
        }
        .accessibilityIdentifier("mention-typeahead")
    }

    /// The `/` command palette: one row per supported action. Selecting a row
    /// performs the corresponding existing store/screen action.
    private func slashPaletteView(_ commands: [ComposerTypeahead.SlashCommand]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(commands) { command in
                Button {
                    performSlash(command)
                } label: {
                    HStack(spacing: Metrics.spacing.sp2) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("/\(command.id)")
                                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                                .foregroundColor(tokens.tx1)
                            Text(command.subtitle)
                                .font(.manta(size: Metrics.type.twoXS))
                                .foregroundColor(tokens.tx2)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Metrics.spacing.sp3)
                    .padding(.vertical, Metrics.spacing.sp1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("slash-row-\(command.id)")
            }
        }
        .padding(.vertical, Metrics.spacing.sp1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.panel, in: RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius.lg, style: .continuous)
                .stroke(tokens.borderSubtle, lineWidth: 1)
        }
        .accessibilityIdentifier("slash-palette")
    }

    /// Re-run the `@` detection whenever the draft changes: update the active
    /// anchor and (debounced) fetch matches, or clear the typeahead when the
    /// mention composition has ended.
    private func handleTextChange(_ newText: String) {
        let caret = Self.activeTextView()?.selectedRange.location ?? (newText as NSString).length
        if let anchor = ComposerTypeahead.detectMention(in: newText, caret: caret) {
            activeMention = anchor
            searchFiles(query: anchor.query)
        } else {
            activeMention = nil
            fileResults = []
            fileSearchTask?.cancel()
        }
    }

    /// Debounced `findFiles`, sequence-guarded so a stale response can't
    /// clobber the latest. ~250 ms matches the desktop's fire-on-type look.
    private func searchFiles(query: String) {
        fileSearchTask?.cancel()
        let seq = fileSearchSeq + 1
        fileSearchSeq = seq
        fileSearchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let results = (try? await api.findFiles(query: query, directory: sessionDirectory)) ?? []
            guard fileSearchSeq == seq else { return }
            fileResults = Array(results.prefix(10))
        }
    }

    /// Insert a chosen file into the draft at the mention anchor and record the
    /// `Mention` so it serializes onto the next send.
    private func selectFile(_ file: String) {
        guard let anchor = activeMention else { return }
        let insertion = ComposerTypeahead.applyMention(file, to: text, anchor: anchor)
        text = insertion.newText
        draftMentions.append(insertion.mention)
        activeMention = nil
        fileResults = []
        fileSearchTask?.cancel()
        inputFocused = true
    }

    /// Perform a `/` palette selection: route to the corresponding existing
    /// store/screen action, then clear the composition so the palette doesn't
    /// reopen on the same text.
    private func performSlash(_ command: ComposerTypeahead.SlashCommand) {
        switch command.kind {
        case .submit:
            submit()
        case .compact:
            store.compact()
        case .clear:
            onSlashClear?()
        case .fork:
            onSlashFork?()
        case .abort:
            store.abort()
        }
        if command.kind != .submit { text = "" }
        activeMention = nil
        fileResults = []
        fileSearchTask?.cancel()
        inputFocused = true
    }

    // MARK: - Mic availability (Groq key gate)

    private func checkMicAvailability() {
        Task {
            let config = try? await api.configGet()
            let key = config.flatMap { ChatJSON.string($0["groqApiKey"]) }
            let available = !(key?.isEmpty ?? true)
            await MainActor.run { micAvailable = available }
        }
    }

    // MARK: - Hint

    /// The capsule shown just above the input row while `showHint` is true.
    /// Single line, truncating tail; text and accent treatment reuse the model
    /// chip's token lookups (no new literals). Tapping it dismisses at once.
    private func hintCapsule(text: String) -> some View {
        Button {
            hintDismissTask?.cancel()
            withAnimation { showHint = false }
        } label: {
            Text(text)
                .font(.manta(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                .foregroundColor(tokens.accentTx)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, Metrics.spacing.sp2)
                .padding(.vertical, Metrics.spacing.sp1)
                .background(tokens.accentSoft, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss hint")
    }

    private func hintState(_ message: String) {
        // A new hint replaces the current one: cancel the pending auto-dismiss
        // so the 4 s timer restarts for the new hint's own identity.
        hintDismissTask?.cancel()
        hint = message
        withAnimation { showHint = true }
        hintDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation { showHint = false }
        }
    }

    private func surfaceHint(_ message: String) {
        hintState(message)
    }
}


/// The input box's shared chrome: glass fill, hairline border, one shape.
///
/// It takes a RADIUS, not a shape. Both forms are the same RoundedRectangle —
/// at half its own height a rounded rect is a capsule — so the two appearances
/// differ only in this number, and SwiftUI can interpolate it. Passing an
/// `AnyShape` instead (a Capsule or a RoundedRectangle) type-erases the
/// animatable data, which is what made the change snap in one frame.
struct BoxChrome: ViewModifier {
    let cornerRadius: CGFloat
    let stroke: Color
    /// A LIGHT wash laid UNDER the glass so the box reads slightly less
    /// transparent without smothering the material — the Liquid Glass blur
    /// has to stay dominant. At higher opacities (this used to be 0.9) the
    /// box read as a solid panel instead of glass, defeating the whole
    /// point of the effect.
    let tint: Color

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return content
            // Liquid Glass, the iOS 26 system material, rather than the flat
            // `.ultraThinMaterial` this used to fill with — same treatment as
            // the session list's search capsule and the chat header buttons.
            // The shape is passed through so the glass morphs with the box
            // instead of snapping between the two forms. A panel fill sits
            // beneath the glass so the composer is a bit less see-through.
            .background(tint, in: shape)
            .glassEffect(.regular, in: shape)
            .overlay {
                shape.strokeBorder(stroke, lineWidth: 1)
            }
    }
}
