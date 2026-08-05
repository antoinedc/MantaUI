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
//   3. Voice — hold to record + dictate (insert at caret); long-press promotes
//      to command mode routed through the box classifier. The mic button is
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
    @Environment(\.colorScheme) private var colorScheme

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
    @State private var micMode: VoiceMode = .dictate
    @State private var micRecording = false
    @State private var showModelPicker = false
    /// Measured height of the text area, used to decide the composer's layout.
    /// Measured rather than counted because wrapping — not newlines — is what
    /// makes the box tall: one long pasted sentence is several visual lines.
    @State private var textHeight: CGFloat = 0
    /// Whether the box is in its tall (stacked) form. State rather than a
    /// derived value because the switch is hysteretic — see `updateLayout`.
    @State private var isTall = false
    /// The near-full-screen editing sheet, opened by the expand control.
    @State private var showExpanded = false
    /// Ties each control's inline slot to its pinned-bottom slot so the two are
    /// one moving view rather than two that fade.
    @Namespace private var controlSlots

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            // The pickers hang off a neutral, zero-size anchor. They cannot go
            // on the composer root (the model sheet is there) nor on the attach
            // button (a Menu is itself a presentation) — in both cases SwiftUI
            // runs one presentation and silently drops the others, which is
            // exactly how attaching a file came to do nothing at all.
            pickerAnchor
            expandAnchor
            // Model chip sits above the input box on its own row.
            HStack(spacing: Metrics.spacing.sp1) {
                modelPill
                Spacer(minLength: 0)
            }
            inputBox
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        // ONE presentation per view. The model sheet, the photo picker and the
        // file importer were all attached HERE, and SwiftUI honours only one of
        // them — which is why attaching a file silently did nothing. The two
        // pickers now hang off the attach button instead (see attachButton).
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(modelStore: modelStore)
        }
        // Attachments also drive the layout (chips force the stacked form), so
        // the box must move on the same curve when one is added or removed as
        // it does when the text grows — otherwise attaching a file snaps.
        .animation(.smooth(duration: 0.22), value: attachments.count)
        .onChange(of: photoItems) { _ in
            Task { await processPhotos() }
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

    // MARK: - Input box (two layouts)

    /// One visual line of the input's font — the unit the layout switch is
    /// measured in. Taken from the font itself rather than guessed, so it
    /// tracks a type-scale change.
    private var lineHeight: CGFloat {
        UIFont.systemFont(ofSize: Metrics.type.body).lineHeight
    }

    /// Chips force the stacked form even on a short message: they need a row of
    /// their own, and there is nowhere to put one inside a single-row capsule.
    private var isStacked: Bool {
        isTall || !attachments.isEmpty
    }

    /// The editor's measured height for a given number of text lines.
    ///
    /// The `+ sp2` is the editor's own internal padding and is the whole reason
    /// this helper exists: the previous thresholds were bare multiples of
    /// `lineHeight` and ignored it, so every comparison was off by most of a
    /// line. Two lines measured 2.45 line-heights, which cleared a "2.4"
    /// threshold — the box went stacked at TWO lines rather than more than two,
    /// and the return threshold was similarly mis-placed. Expressing the
    /// thresholds in LINES and converting here keeps them honest.
    private func editorHeight(forLines lines: CGFloat) -> CGFloat {
        lineHeight * lines + Metrics.spacing.sp2
    }

    /// Re-evaluate the layout from a fresh text height, WITH HYSTERESIS: it
    /// takes more height to grow into the stacked form than it takes to fall
    /// back out of it.
    ///
    /// The two thresholds sit in the GAPS between whole line counts, so each
    /// one is unambiguous:
    ///   * grow at 2.5 lines — 2 lines stays compact, 3 goes stacked, which is
    ///     "pin the controls once it is more than two lines".
    ///   * shrink at 1.5 lines — back to one line returns to the capsule, while
    ///     2 lines stays stacked.
    ///
    /// The gap between them is a full line, which is what stops the switch
    /// re-triggering itself: flipping changes the text's available width (the
    /// controls move out of its row), so the same string re-measures to a
    /// different height immediately after — a narrower band would let that
    /// re-measurement cross back and oscillate.
    ///
    /// The animation is applied HERE rather than as a `.animation(value:)` on
    /// the box, so it wraps the state change itself and every dependent piece
    /// of the layout — corner radius, height, control positions — moves on one
    /// curve.
    private func updateLayout(for height: CGFloat) {
        textHeight = height
        let next = isTall
            ? height > editorHeight(forLines: 1.5)   // stay stacked?
            : height > editorHeight(forLines: 2.5)   // become stacked?
        guard next != isTall else { return }
        withAnimation(.smooth(duration: 0.22)) { isTall = next }
    }

    /// Corner radius, animated between the two forms rather than swapped.
    ///
    /// This used to switch `Capsule` ↔ `RoundedRectangle` through an
    /// `AnyShape`, which is why the change was abrupt: type-erasing a shape
    /// discards its animatable data, so there was nothing for SwiftUI to
    /// interpolate and the corners changed in one frame. One RoundedRectangle
    /// whose radius animates gives the same two appearances — at half its own
    /// height a rounded rect IS a capsule — and morphs between them.
    private var cornerRadius: CGFloat {
        if isStacked { return Metrics.radius.lg }
        // Half the compact box's height, derived from the same metrics that
        // lay it out: the taller of the control row and one line of text, plus
        // the compact vertical padding.
        let content = max(Metrics.type.chatHeaderBtn, lineHeight + Metrics.spacing.sp2)
        return (content + Metrics.spacing.sp1 * 2) / 2
    }

    /// The input box. ONE view tree for both layouts — this is deliberate and
    /// load-bearing.
    ///
    /// It was previously an `if isStacked { … } else { … }`, which reads more
    /// clearly but is what DISMISSED THE KEYBOARD on every mode switch: the two
    /// branches are different view identities, so crossing the threshold tore
    /// down the TextEditor and built a new one, and focus (and with it the
    /// keyboard) died with the old instance. Keeping `textArea` at a fixed
    /// position in this builder keeps its identity — and therefore its
    /// first-responder status — stable across the switch.
    ///
    /// What actually changes between the two modes:
    ///   * the SHAPE — a capsule when it is one row, a rounded rect once it is
    ///     tall (a capsule's radius is half its height, so a tall one is a blob)
    ///   * WHERE the controls sit — inline beside the text when compact, pinned
    ///     along the bottom when stacked
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

            // Text, with the controls inline beside it while compact.
            //
            // The controls carry `matchedGeometryEffect` so they TRAVEL between
            // the two positions instead of cross-fading. Without it the inline
            // copy is removed and the bottom copy inserted, and SwiftUI's
            // default for that is opacity — the buttons blink out of one place
            // and in at another, which reads as the layout snapping even when
            // the box itself is animating smoothly. Only one copy of each id
            // exists at a time (the branches are exclusive), which is what the
            // effect requires.
            HStack(alignment: .bottom, spacing: Metrics.spacing.sp2) {
                if !isStacked {
                    attachButton.matchedGeometryEffect(id: "composer.attach", in: controlSlots)
                }
                textArea
                if !isStacked {
                    if micAvailable {
                        micButton.matchedGeometryEffect(id: "composer.mic", in: controlSlots)
                    }
                    sendButton.matchedGeometryEffect(id: "composer.send", in: controlSlots)
                }
            }

            // …and pinned along the bottom once stacked.
            if isStacked {
                HStack(spacing: Metrics.spacing.sp2) {
                    attachButton.matchedGeometryEffect(id: "composer.attach", in: controlSlots)
                    Spacer(minLength: 0)
                    if micAvailable {
                        micButton.matchedGeometryEffect(id: "composer.mic", in: controlSlots)
                    }
                    sendButton.matchedGeometryEffect(id: "composer.send", in: controlSlots)
                }
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, isStacked ? Metrics.spacing.sp2 : Metrics.spacing.sp1)
        .modifier(BoxChrome(cornerRadius: cornerRadius, stroke: borderColor))
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
    }



    /// Accent while a background refetch is in flight, and never while a turn
    /// runs — the two states must not share an indicator (BET-630 D1).
    private var borderColor: Color {
        store.refreshing && !store.running ? tokens.accent : tokens.borderSubtle
    }

    /// The text field, shared by both layouts. It reports its own height so the
    /// layout switch has something real to measure.
    private var textArea: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text("Message…")
                    .font(.system(size: Metrics.type.body))
                    .foregroundColor(tokens.tx4)
                    .padding(.top, 8)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(.system(size: Metrics.type.body))
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

    /// Opens the near-full-screen editing sheet. Only shown in the stacked
    /// layout, where the message is already long enough for the small box to be
    /// the constraint.
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
                .font(.system(size: Metrics.type.body))
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

    // MARK: - Model pill

    private var modelPill: some View {
        Button {
            showModelPicker = true
        } label: {
            HStack(spacing: Metrics.spacing.sp1) {
                Image(systemName: "sparkles")
                    .font(.system(size: Metrics.type.xs, weight: .medium))
                if modelStore.loaded {
                    Text(ChatModel.label(modelStore.models, override: modelStore.override, default: modelStore.defaultModel))
                        .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                        .lineLimit(1)
                    if let variant = modelStore.variant, !variant.isEmpty {
                        Text("·")
                            .font(.system(size: Metrics.type.small))
                        Text(variant.capitalized)
                            .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                            .lineLimit(1)
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
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.sp1)
        }
        // Glass rather than the flat accent-soft fill, so the chip belongs to
        // the same floating chrome as the box beneath it; the accent now lives
        // in the TEXT alone, which is enough to mark it.
        //
        // The system glass BUTTON style, not `.glassEffect` on the label of a
        // plain button — the layered form renders and then swallows the tap.
        // This chip had the same defect as the ⋯ menu button; it just was not
        // tapped before the menu was.
        .buttonStyle(.glass)
        .clipShape(.capsule)
        .accessibilityLabel("Model picker")
        .accessibilityIdentifier("model-picker")
    }

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
                            .font(.system(size: Metrics.type.twoXS))
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
            // Tap without hold = no-op (recording is gesture-driven); kept as a
            // hit target with an accessibility action that starts dictation.
        } label: {
            ZStack {
                // The disc is drawn only while RECORDING. At rest the glyph
                // sits bare on the glass, like the attach control — a resting
                // dark disc read as a hole in the surface. While recording the
                // fill is the state indicator, so it stays.
                if recorder.phase == .recording {
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
                .onChanged { _ in micPress() }
                .onEnded { _ in micRelease() }
        )
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.5)
                .onEnded { _ in promoteToCommand() }
        )
        .accessibilityLabel("Hold to dictate, long press for command")
        .accessibilityIdentifier("mic-button")
        .disabled(!micAvailable)
    }

    private var micIcon: String {
        switch recorder.phase {
        case .recording: return micMode == .command ? "waveform.badge.mic" : "mic.fill"
        case .processing: return "hourglass"
        case .error: return "exclamationmark.triangle"
        default: return "mic"
        }
    }

    private var micIconFill: Color {
        switch recorder.phase {
        case .recording: return micMode == .command ? tokens.danger.opacity(0.2) : tokens.accentSolid
        default: return tokens.inset
        }
    }

    private var micIconColor: Color {
        switch recorder.phase {
        case .recording: return micMode == .command ? tokens.danger : tokens.onAccent
        case .error: return tokens.danger
        default: return tokens.tx2
        }
    }

    private func micPress() {
        guard micAvailable, recorder.phase != .recording, recorder.phase != .processing else { return }
        Task {
            let granted = await recorder.requestPermission()
            guard granted else {
                recorder.fail("Microphone permission needed")
                hintState("Microphone permission is required")
                return
            }
            micMode = .dictate
            recorder.start()
        }
    }

    private func promoteToCommand() {
        guard recorder.phase == .recording else { return }
        micMode = .command
    }

    private func micRelease() {
        guard recorder.phase != .processing else { return }
        guard let data = recorder.stop() else {
            // Too short — treat as an accidental tap, not an error (§ desktop
            // too-short guard). Quiet.
            return
        }
        let mode = micMode
        Task {
            await transcribe(data: data, mode: mode)
        }
    }

    private func transcribe(data: Data, mode: VoiceMode) async {
        let result = try? await api.voiceTranscribe(data: data, mime: "audio/mp4")
        let transcript = result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !transcript.isEmpty else {
            hintState("No speech detected")
            return
        }
        if mode == .command {
            await classify(transcript)
        } else {
            await MainActor.run { insertAtCaret(transcript) }
        }
    }

    /// Insert text at the caret (dictate). Falls back to append if the input
    /// isn't focused/bound yet.
    private func insertAtCaret(_ string: String) {
        // TextEditor owns the selection; append at end for dictation.
        text += string
    }

    private func classify(_ transcript: String) async {
        guard let classify = try? await api.voiceClassifyCommand(transcript: transcript) else {
            hintState("Couldn't understand that command")
            return
        }
        let action = ChatVoice.parse(classify)
        let hint = handleVoiceAction(action)
        if let hint { hintState(hint) }
    }

    /// Route a typed voice action. Returns a hint string when the composer was
    /// responsible for surfacing it (text-inserting / not-handled-here), nil
    /// when the store handled it.
    private func handleVoiceAction(_ action: VoiceAction) -> String? {
        switch action {
        case .submit(let text):
            submitVoice(text)
            return nil
        case .append(let text):
            if !text.isEmpty { insertAtCaret(text) }
            return nil
        case .model(let query):
            if let model = ChatModel.findByQuery(modelStore.models, query: query) {
                modelStore.setOverride(OpencodeModelID(providerID: model.providerID, modelID: model.id))
                return nil
            }
            return "No model found for “\(query)”"
        case .unknown(let transcript):
            if !transcript.isEmpty { insertAtCaret(transcript) }
            return nil
        default:
            return store.dispatchVoice(action)
        }
    }

    private func submitVoice(_ voiceText: String) {
        let trimmed = voiceText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        insertAtCaret(trimmed)
        submit()
    }

    // MARK: - Send

    private var sendButton: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up")
                .font(.system(size: Metrics.type.body, weight: .semibold))
                .foregroundColor(canSend ? tokens.onAccent : tokens.tx4)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .background(canSend ? AnyShapeStyle(tokens.accentSolid) : AnyShapeStyle(tokens.inset), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send")
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
        store.send(text: trimmed, attachments: sendAttachments, model: model)
        text = ""
        attachments = []
        // Return to the compact form explicitly rather than waiting for the
        // emptied editor to re-measure. The measurement does arrive, but a beat
        // later — long enough for the box to sit stacked and empty after a
        // send, which reads as the composer being stuck.
        withAnimation(.smooth(duration: 0.22)) { isTall = false }
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

    private func hintState(_ message: String) {
        hint = message
        withAnimation { showHint = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
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
private struct BoxChrome: ViewModifier {
    let cornerRadius: CGFloat
    let stroke: Color

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return content
            // Liquid Glass, the iOS 26 system material, rather than the flat
            // `.ultraThinMaterial` this used to fill with — same treatment as
            // the session list's search capsule and the chat header buttons.
            // The shape is passed through so the glass morphs with the box
            // instead of snapping between the two forms.
            .glassEffect(.regular, in: shape)
            .overlay {
                shape.strokeBorder(stroke, lineWidth: 1)
            }
    }
}
