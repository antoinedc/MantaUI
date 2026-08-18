import QuickLook
import SwiftUI
import UIKit

// ===========================================================================
// BET-627 — overflow sheet items (scheduled tasks · secrets).
//
// Each overflow row opens one of these cards. They are deliberately built from
// STOCK SwiftUI (NavigationStack + List/Form + toolbar), the same system-shaped
// treatment as SessionCreateSheet: grouped styling, dynamic type and VoiceOver
// come from the platform instead of being re-implemented in tokens.
//
// Attaching used to be a third card here. It was removed: the composer already
// carries a paperclip, so the sheet only offered a slower path to the same
// picker.
//
// The cards talk to the box over the existing RPC wire
// (`schedule:list`/`schedule:delete` / `secrets:list`/`secrets:set`/`secrets:delete`).
// Secrets are METADATA ONLY: the box never sends a value to the device, so the
// secrets card can list names without ever materialising a secret device-side,
// and it only ever collects an incoming value that is discarded after save.
// ===========================================================================

/// List of scheduled-prompt jobs scoped to the session. The count shown in the
/// overflow row ("Scheduled tasks" with live count) is this list's length.
/// Jobs are created by the AI's `schedule` tool / `POST /api/schedule` — the
/// UI can delete but never fabricates a create RPC, so there is no create form.
struct SchedulesCard: View {
    let sessionId: String
    let onClose: () -> Void

    @State private var jobs: [ScheduledJob] = []
    @State private var loaded = false
    @State private var failed = false
    private let api = MantaAPIClient.live()

    var body: some View {
        NavigationStack {
            Group {
                if failed {
                    Text("Couldn't load scheduled tasks.")
                        .foregroundStyle(.secondary)
                } else if loaded {
                    if jobs.isEmpty {
                        emptyState
                    } else {
                        List(jobs) { job in
                            row(job)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await delete(job) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                        }
                        .listStyle(.insetGrouped)
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Scheduled tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        if let result = try? await api.listSchedules(sessionId: sessionId) {
            jobs = result
            failed = false
        } else {
            failed = true
        }
        loaded = true
    }

    private func delete(_ job: ScheduledJob) async {
        if (try? await api.deleteSchedule(id: job.id)) != nil {
            await load()
        }
    }

    private var emptyState: some View {
        ContentUnavailableView("No scheduled tasks", systemImage: "clock",
                               description: Text("Schedule a prompt from the desktop app or the AI to see it here."))
    }

    private func row(_ job: ScheduledJob) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(displayName(job))
                    .font(.body)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if job.recurring {
                    Image(systemName: "repeat")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text(displayDetail(job))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }

    private func displayName(_ job: ScheduledJob) -> String {
        let label = job.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty { return label }
        let prompt = job.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let firstLine = prompt.split(separator: "\n").first else { return "Scheduled prompt" }
        let trimmed = String(firstLine).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Scheduled prompt" : trimmed
    }

    private func displayDetail(_ job: ScheduledJob) -> String {
        "\(job.cron)\(job.recurring ? " · repeats" : " · once")"
    }
}

/// List of secret names (metadata only — values never leave the box). The user
/// can add a new secret (a `+` toolbar button → `secrets:set`) and swipe to
/// delete an existing one (`secrets:delete`). The incoming value is discarded
/// after save — this card never displays a value back.
struct SecretsCard: View {
    let sessionId: String
    let onClose: () -> Void

    @State private var secrets: [SecretMeta] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var showingAdd = false
    private let api = MantaAPIClient.live()

    var body: some View {
        NavigationStack {
            Group {
                if failed {
                    Text("Couldn't load secrets.")
                        .foregroundStyle(.secondary)
                } else if loaded {
                    if secrets.isEmpty {
                        emptyState
                    } else {
                        List(secrets) { secret in
                            row(secret)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await delete(secret) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                        }
                        .listStyle(.insetGrouped)
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Secrets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add secret")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showingAdd) {
            SecretAddForm(sessionId: sessionId) { input in
                await saveNewSecret(input)
            } onCancel: {
                showingAdd = false
            }
        }
    }

    private func load() async {
        if let result = try? await api.listSecrets(sessionId: sessionId) {
            secrets = result
            failed = false
        } else {
            failed = true
        }
        loaded = true
    }

    private func delete(_ secret: SecretMeta) async {
        if (try? await api.deleteSecret(id: secret.id)) != nil {
            await load()
        }
    }

    private func saveNewSecret(_ input: SecretInput) async -> String? {
        do {
            let result = try await api.setSecret(input)
            if result.ok {
                await load()
                return nil
            }
            return result.error ?? "save failed"
        } catch {
            return Self.message(for: error)
        }
    }

    private static func message(for error: Error) -> String {
        switch error {
        case MantaError.server(let message): return message
        case MantaError.transport(let message): return message
        default: return error.localizedDescription
        }
    }

    private var emptyState: some View {
        ContentUnavailableView("No secrets", systemImage: "key",
                               description: Text("Tap + to add a secret for this session."))
    }

    private func row(_ secret: SecretMeta) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(secret.key ?? secret.id)
                .font(.body)
                .lineLimit(1)
            Text(detail(secret))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }

    private func detail(_ secret: SecretMeta) -> String {
        var parts: [String] = []
        if let scope = secret.scope, !scope.isEmpty { parts.append(scope) }
        if let hint = secret.hint, !hint.isEmpty { parts.append(hint) }
        return parts.joined(separator: " · ")
    }
}

/// The `+` add-secret form. Collects key/value/scope/hint, calls `secrets:set`
/// (the value travels to the box and is never shown again), and surfaces the
/// box's `error` when the set fails. On success the card refetches.
private struct SecretAddForm: View {
    let sessionId: String
    let onSave: (SecretInput) async -> String?
    let onCancel: () -> Void

    @State private var key = ""
    @State private var value = ""
    @State private var scope = "session"
    @State private var hint = ""
    @State private var saving = false
    @State private var errorMessage: String?

    private var keyValid: Bool {
        key.range(of: #"^[A-Za-z_][A-Za-z0-9_]{0,63}$"#, options: .regularExpression) != nil
    }
    private var canSave: Bool { keyValid && !value.isEmpty && !saving }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("KEY (e.g. GITHUB_PAT)", text: $key)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                } footer: {
                    Text("1–64 chars: a letter or underscore, then letters/digits/underscores.")
                }
                Section {
                    SecureField("Value (stored on the server; never shown again)", text: $value)
                        .font(.system(.body, design: .monospaced))
                }
                Section {
                    Picker("Scope", selection: $scope) {
                        Text("This session").tag("session")
                        Text("This project").tag("project")
                    }
                    .pickerStyle(.automatic)
                    TextField("Hint (optional)", text: $hint)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New secret")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private func save() async {
        saving = true
        // Clear any prior error at the START of a save attempt so a stale
        // message doesn't linger after a subsequent successful save; a failed
        // set then sets `errorMessage` below and it is NOT cleared on return.
        errorMessage = nil
        defer { saving = false }
        let input = SecretInput(
            key: key,
            value: value,
            scope: scope,
            // Send the card's sessionId for BOTH session and project scope: the
            // card is always read from within a session, and the box resolves
            // the project name from sessionID when it is not supplied directly.
            sessionID: sessionId,
            hint: hint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : hint
        )
        if let error = await onSave(input) {
            errorMessage = error
        }
    }
}

// ===========================================================================
// BET-822 — artifacts palette: all four sources, QuickLook preview, no download.
//
// The reverse of the composer's paperclip. Unlike the BET-750 version (which
// read ONLY the agent's `outbox:list`), this card derives its rows from the
// same four feeds as the desktop panel — transcript file parts, URLs in user
// messages, published serve-pages, and the outbox — via the pure
// `ArtifactDerivation` (ArtifactDerivation.swift, unit-tested).
//
// Tapping a row PREVIEWS it (QuickLook), not downloads it: iOS has no
// user-visible Downloads folder, and duplicating a share-sheet action is a
// misstep. Sharing is reachable only through the long-press context menu. A
// box artifact must be staged to the temp dir first — a genuine task of
// unknown duration, so it gets a row spinner while staging, and the preview
// only presents when the bytes land (a failure leaves the row untouched).
// Same stock-SwiftUI treatment as SchedulesCard/SecretsCard.
// ===========================================================================

/// List of everything THIS conversation produced: files the user attached,
/// files the agent pushed, published preview pages, and links, grouped by day
/// behind a Files · Images · Links segmented control. Tap → QuickLook;
/// long-press → Share / Copy path.
struct ArtifactsCard: View {
    let sessionId: String
    let onClose: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    @State private var artifacts: [Artifact] = []
    @State private var segment: ArtifactKind = .file
    @State private var loaded = false
    @State private var failed = false
    /// Artifact ids currently having their bytes streamed to the temp dir
    /// (row spinner while QuickLook staging runs).
    @State private var staging: Set<String> = []
    /// Staged local file URLs, keyed by artifact id — the rows QuickLook can
    /// already present without another fetch.
    @State private var stagedFiles: [String: URL] = [:]
    @State private var quickLookURLs: [URL] = []
    @State private var quickLookStartIndex = 0
    @State private var showingQuickLook = false
    private let api = MantaAPIClient.live()
    /// Poll cadence while the card is presented, so a file the AI drops mid-chat
    /// appears without needing to dismiss and reopen the card.
    private static let refreshIntervalNanoseconds: UInt64 = 3_000_000_000

    var body: some View {
        NavigationStack {
            Group {
                if failed {
                    Text("Couldn't load artifacts.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("artifacts-failed")
                } else if loaded {
                    VStack(spacing: 0) {
                        segmented
                        if filtered.isEmpty {
                            emptyState
                        } else {
                            list
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Artifacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        // Live update: refetch while presented (matches the other cards' `.task`
        // load, extended to a light poll). Cancels when the card dismisses.
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: Self.refreshIntervalNanoseconds)
            }
        }
        .fullScreenCover(isPresented: $showingQuickLook) {
            QuickLookPreview(urls: quickLookURLs, startIndex: quickLookStartIndex)
                .ignoresSafeArea()
        }
    }

    private var counts: (link: Int, image: Int, file: Int) { ArtifactCounts.of(artifacts) }

    private var filtered: [Artifact] {
        artifacts.filter { $0.kind == segment }
    }

    private var segmented: some View {
        Picker("Segment", selection: $segment) {
            Text("Files \(counts.file)").tag(ArtifactKind.file)
            Text("Images \(counts.image)").tag(ArtifactKind.image)
            Text("Links \(counts.link)").tag(ArtifactKind.link)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .accessibilityIdentifier("artifacts-segment")
    }

    private var list: some View {
        List {
            ForEach(ArtifactDayGrouping.grouped(filtered, now: Date()), id: \.label) { group in
                Section(header: Text(group.label)) {
                    ForEach(group.items) { artifact in
                        row(artifact)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func load() async {
        do {
            // All four feeds arrive before deriving — the merged list is the
            // only consistent snapshot for the counts and segments.
            async let messages = api.messages(sessionId: sessionId)
            async let pages = api.servePageList()
            async let outbox = api.listOutbox(sessionId: sessionId)
            let (msgs, pgs, rows) = try await (messages, pages, outbox)
            artifacts = ArtifactDerivation.derive(messages: msgs, pages: pgs, sessionId: sessionId, outbox: rows)
            failed = false
        } catch {
            failed = true
        }
        loaded = true
    }

    private func onTap(_ artifact: Artifact) {
        // A remote link opens in the browser — QuickLook has nothing to preview.
        // Everything else (box path or data: URI) is staged then previewed.
        let href = artifact.href.lowercased()
        if href.hasPrefix("http://") || href.hasPrefix("https://") {
            if let url = URL(string: artifact.href) {
                UIApplication.shared.open(url)
            }
            return
        }
        Task { await presentPreview(artifact) }
    }

    /// Ensure the tapped artifact is staged, then present QuickLook over every
    /// prepared file/image row (multi-item navigation comes free). Failure
    /// leaves the row untouched — nothing is ever reported as previewed.
    private func presentPreview(_ artifact: Artifact) async {
        if stagedFiles[artifact.id] == nil {
            guard !staging.contains(artifact.id) else { return }
            staging.insert(artifact.id)
            defer { staging.remove(artifact.id) }
            guard let url = await stage(artifact) else { return }
            stagedFiles[artifact.id] = url
        }
        let previewables = filtered.filter { $0.kind != .link && stagedFiles[$0.id] != nil }
        let urls = previewables.compactMap { stagedFiles[$0.id] }
        guard !urls.isEmpty else { return }
        quickLookURLs = urls
        quickLookStartIndex = max(0, previewables.firstIndex { $0.id == artifact.id } ?? 0)
        showingQuickLook = true
    }

    /// Fetch the artifact's bytes into the app's temp directory. A `data:` URI
    /// carries its own bytes — decode, never fetch; a box path is streamed via
    /// `/api/peek`. Returns nil on any failure (row stays untouched).
    private func stage(_ artifact: Artifact) async -> URL? {
        do {
            let data: Data
            if artifact.href.lowercased().hasPrefix("data:") {
                guard let decoded = Self.decodeDataURI(artifact.href) else { return nil }
                data = decoded
            } else {
                data = try await api.peekFile(path: artifact.href)
            }
            let url = Self.tempURL(for: artifact)
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }

    private func contextMenu(for artifact: Artifact) -> some View {
        Group {
            if let url = shareURL(for: artifact) {
                ShareLink(item: url)
            }
            Button {
                UIPasteboard.general.string = artifact.href
            } label: {
                Label("Copy path", systemImage: "doc.on.doc")
            }
        }
    }

    /// The shareable URL: the staged local file for a file/image, the href for
    /// a link. A file with no staged bytes yet has nothing shareable — sharing
    /// a raw box path would be a lie, so the menu omits ShareLink then.
    private func shareURL(for artifact: Artifact) -> URL? {
        if artifact.kind != .link {
            return stagedFiles[artifact.id]
        }
        return URL(string: artifact.href)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No artifacts",
            systemImage: "doc",
            description: Text("Files, images and links from this conversation will appear here.")
        )
        .accessibilityIdentifier("artifacts-empty")
    }

    private func row(_ artifact: Artifact) -> some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: Self.glyph(artifact.kind))
                .font(.system(size: Metrics.type.small))
                .foregroundStyle(tokens.tx4)
                .frame(width: Metrics.spacing.sp4)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text(artifact.label)
                    .font(.manta(size: Metrics.type.body))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(ArtifactFormat.secondaryLine(artifact, now: Date()))
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundStyle(tokens.tx3)
                    .lineLimit(1)
            }
            Spacer(minLength: Metrics.spacing.sp2)
            if staging.contains(artifact.id) {
                ProgressView()
            }
        }
        .padding(.vertical, Metrics.spacing.sp1)
        .contentShape(Rectangle())
        .onTapGesture { onTap(artifact) }
        .contextMenu { contextMenu(for: artifact) }
    }

    private static func glyph(_ kind: ArtifactKind) -> String {
        switch kind {
        case .file: return "doc"
        case .image: return "photo"
        case .link: return "link"
        }
    }

    /// A writable temp URL QuickLook can hand to the OS. Keyed so re-staging
    /// the same id overwrites in place.
    private static func tempURL(for artifact: Artifact) -> URL {
        let dir = FileManager.default.temporaryDirectory
        let safe = artifact.id
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return dir.appendingPathComponent("manta-qp-\(safe)\(Self.fileExtension(from: artifact.label))")
    }

    /// The last-dot extension of an artifact's name, so QuickLook detects the
    /// right type; "" when the name has none or it isn't a clean extension.
    private static func fileExtension(from label: String) -> String {
        let name: Substring
        if let slash = label.lastIndex(of: "/") {
            name = label[label.index(after: slash)...]
        } else {
            name = Substring(label)
        }
        guard let dot = name.lastIndex(of: ".") else { return "" }
        let ext = name[name.index(after: dot)...]
        guard !ext.isEmpty, ext.count <= 8, ext.allSatisfy({ $0.isLetter || $0.isNumber }) else { return "" }
        return "." + ext
    }

    /// Decode a `data:[mime][;base64],payload` URI. base64 when flagged,
    /// otherwise percent-decoded UTF-8.
    private static func decodeDataURI(_ href: String) -> Data? {
        guard let comma = href.firstIndex(of: ",") else { return nil }
        let metaStart = href.index(href.startIndex, offsetBy: 5) // skip "data:"
        guard metaStart < comma else { return nil }
        let meta = href[metaStart..<comma]
        let payload = String(href[href.index(after: comma)...])
        if meta.contains(";base64") {
            return Data(base64Encoded: payload)
        }
        return payload.removingPercentEncoding?.data(using: .utf8)
    }
}

/// QuickLook as a SwiftUI surface. `QLPreviewController` (not `.quickLookPreview`)
/// gives multi-item navigation between several artifacts plus a share button
/// inside the preview for free — a session usually has several.
private struct QuickLookPreview: UIViewControllerRepresentable {
    let urls: [URL]
    let startIndex: Int

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.urls = urls
        controller.reloadData()
        // Jump to the tapped row; safe-guarded because a stale index would trap.
        controller.currentPreviewItemIndex = min(max(0, startIndex), urls.count - 1)
    }

    func makeCoordinator() -> Coordinator { Coordinator(urls: urls) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var urls: [URL]
        init(urls: [URL]) { self.urls = urls }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            PreviewItem(url: urls[index])
        }
    }
}

private final class PreviewItem: NSObject, QLPreviewItem {
    let url: URL
    var previewItemURL: URL? { url }
    init(url: URL) { self.url = url }
}
