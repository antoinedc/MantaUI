import SwiftUI
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
    let mime: String
    let remotePath: String
    let isImage: Bool
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
    @StateObject private var controller = ComposerTextController()
    @StateObject private var recorder = VoiceRecorder()
    @State private var micMode: VoiceMode = .dictate
    @State private var micRecording = false

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
            if !attachments.isEmpty { chipsRow }
            HStack(spacing: Metrics.spacing.sp1) {
                attachButton
                modelPill
                Spacer(minLength: 0)
            }
            HStack(alignment: .bottom, spacing: Metrics.spacing.sp2) {
                MultilineTextView(
                    text: $text,
                    controller: controller,
                    placeholder: "Message…",
                    font: UIFont.systemFont(ofSize: Metrics.type.body),
                    textColor: UIColor(tokens.tx1),
                    placeholderColor: UIColor(tokens.tx4),
                    maxHeight: Metrics.type.display * 3
                )
                .frame(maxWidth: .infinity)
                if micAvailable { micButton }
                sendButton
            }
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .background(tokens.canvas.ignoresSafeArea())
        .overlay(alignment: .top) { topDivider }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .fileImporter(isPresented: $showDocPicker, allowedContentTypes: [.item]) { result in
            handleDocument(result)
        }
        .onChange(of: photoItems) { _ in
            Task { await processPhotos() }
        }
        .onAppear {
            modelStore.load()
            checkMicAvailability()
            controller.focus()
        }
    }

    /// The composer's top hairline. While a background transcript refetch (or the
    /// initial load) runs — and the turn is NOT running — it becomes an ambient
    /// accent sweep (BET-630, D1). A running turn shows the working row instead;
    /// the two states never share an indicator.
    @ViewBuilder
    private var topDivider: some View {
        if store.refreshing && !store.running {
            RefetchSweep(tokens: tokens)
        } else {
            Rectangle()
                .fill(tokens.borderSubtle)
                .frame(height: Metrics.spacing.spPx)
        }
    }

    // MARK: - Model pill

    private var modelPill: some View {
        Menu {
            Button {
                modelStore.setOverride(nil)
            } label: {
                Label(settingIsDefault ? "Default (in use)" : "Default", systemImage: settingIsDefault ? "checkmark" : "circle")
            }
            if modelStore.models.isEmpty {
                Text("No models")
            } else {
                ForEach(ChatModel.groups(modelStore.models), id: \.provider) { group in
                    Section(group.provider) {
                        ForEach(group.models, id: \.id) { model in
                            Button {
                                modelStore.setOverride(OpencodeModelID(providerID: model.providerID, modelID: model.id))
                            } label: {
                                Label(model.name, systemImage: isActive(model) ? "checkmark" : "circle")
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: Metrics.spacing.sp1) {
                Image(systemName: "sparkles")
                    .font(.system(size: Metrics.type.xs, weight: .medium))
                Text(ChatModel.label(modelStore.models, override: modelStore.override, default: modelStore.defaultModel))
                    .font(.system(size: Metrics.type.small, weight: mantaFontWeight(Metrics.type.medium)))
                    .lineLimit(1)
            }
            .foregroundColor(tokens.accentTx)
            .padding(.horizontal, Metrics.spacing.sp2)
            .padding(.vertical, Metrics.spacing.sp1)
            .background(tokens.accentSoft, in: Capsule())
        }
        .accessibilityLabel("Model picker")
        .accessibilityIdentifier("model-picker")
    }

    private var settingIsDefault: Bool {
        modelStore.override == nil
    }

    private func isActive(_ model: OpencodeModel) -> Bool {
        guard let active = modelStore.active else { return false }
        return active.providerID == model.providerID && active.modelID == model.id
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
            Image(systemName: "paperclip")
                .font(.system(size: Metrics.type.body, weight: .medium))
                .foregroundColor(tokens.tx2)
                .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                .background(attachments.isEmpty ? AnyShapeStyle(tokens.inset) : AnyShapeStyle(tokens.accentSoft), in: Circle())
                .accessibilityLabel("Attach")
        }
        .accessibilityIdentifier("attach-button")
    }

    private func handleDocument(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let filename = url.lastPathComponent
        guard let data = try? Data(contentsOf: url) else {
            surfaceHint("Couldn't read that file")
            return
        }
        let mime = ChatVoice.mime(forFilename: filename)
        Task {
            do {
                let remote = try await api.upload(project: projectName, filename: filename, data: data)
                await MainActor.run {
                    attachments.append(ComposerAttachment(filename: filename, mime: mime, remotePath: remote, isImage: mime.hasPrefix("image/")))
                }
            } catch {
                surfaceHint("Upload failed")
            }
        }
    }

    private func processPhotos() async {
        for item in photoItems {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let mime = ChatVoice.mime(forImageData: data)
            let filename = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
            do {
                let remote = try await api.upload(project: projectName, filename: filename, data: data)
                await MainActor.run {
                    attachments.append(ComposerAttachment(filename: filename, mime: mime, remotePath: remote, isImage: true))
                }
            } catch {
                surfaceHint("Photo upload failed")
            }
        }
        await MainActor.run { photoItems = [] }
    }

    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Metrics.spacing.sp1) {
                ForEach(attachments) { attachment in
                    HStack(spacing: Metrics.spacing.sp1) {
                        Image(systemName: attachment.isImage ? "photo" : "doc")
                            .font(.system(size: Metrics.type.twoXS))
                            .foregroundColor(tokens.accentTx)
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
                Circle()
                    .fill(micIconFill)
                    .frame(width: Metrics.type.chatHeaderBtn, height: Metrics.type.chatHeaderBtn)
                Image(systemName: micIcon)
                    .font(.system(size: Metrics.type.body, weight: .semibold))
                    .foregroundColor(micIconColor)
            }
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
        if controller.textView != nil {
            controller.insertAtCaret(string)
        } else {
            text += string
        }
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
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let model = modelStore.promptModel
        let sendAttachments = attachments.map { attachment in
            SendPromptInput.Attachment(remotePath: attachment.remotePath, mime: attachment.mime, filename: attachment.filename)
        }
        store.send(text: trimmed, attachments: sendAttachments, model: model)
        text = ""
        attachments = []
        controller.focus()
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

/// Ambient transcript-refetch sweep on the composer's top hairline (BET-630, D1).
/// A slow accent gradient travels L→R while the canonical transcript syncs in the
/// background; border-only (1px) so there is no layout shift. Distinct from the
/// running row — the two mean different things and never share an indicator.
/// Mirrors the desktop `.manta-loading-divider` (src/renderer/index.css).
private struct RefetchSweep: View {
    let tokens: Tokens

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
            let period = 1.5
            let t = (context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: period) / period)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(tokens.borderSubtle)
                    Rectangle()
                        .fill(
                            LinearGradient(
                                colors: [.clear, tokens.accent.opacity(0.85), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * 0.42)
                        .offset(x: (CGFloat(t) * 1.45 - 0.42) * geo.size.width)
                }
            }
            .frame(height: Metrics.spacing.spPx)
            .clipped()
        }
    }
}
