import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// ===========================================================================
// BET-627 — overflow sheet items 1-3 (attach · scheduled tasks · secrets).
//
// Each overflow row opens one of these cards. They are deliberately built from
// STOCK SwiftUI (NavigationStack + List/Form + toolbar), the same system-shaped
// treatment as SessionCreateSheet: grouped styling, dynamic type and VoiceOver
// come from the platform instead of being re-implemented in tokens.
//
// The cards talk to the box over the existing RPC wire
// (`schedule:list` / `secrets:list` / `POST /api/upload`) — no new transport.
// Secrets are METADATA ONLY: the box never sends a value to the device, so the
// secrets card can list names without ever materialising a secret device-side.
// ===========================================================================

/// List of scheduled-prompt jobs scoped to the session. The count shown in the
/// overflow row ("Scheduled tasks" with live count) is this list's length.
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
        .task {
            guard !loaded else { return }
            if let result = try? await api.listSchedules(sessionId: sessionId) {
                jobs = result
            } else {
                failed = true
            }
            loaded = true
        }
    }

    private var emptyState: some View {
        ContentUnavailableView("No scheduled tasks", systemImage: "clock",
                               description: Text("Schedule a prompt from the desktop app to see it here."))
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

/// List of secret names (metadata only — values never leave the box).
struct SecretsCard: View {
    let sessionId: String
    let onClose: () -> Void

    @State private var secrets: [SecretMeta] = []
    @State private var loaded = false
    @State private var failed = false
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
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .task {
            guard !loaded else { return }
            if let result = try? await api.listSecrets(sessionId: sessionId) {
                secrets = result
            } else {
                failed = true
            }
            loaded = true
        }
    }

    private var emptyState: some View {
        ContentUnavailableView("No secrets", systemImage: "key",
                               description: Text("Secrets you've stored for this session appear here."))
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

/// Attach photo or file: uploads through the same `POST /api/upload` endpoint
/// the composer uses, then sends it as an attachment-only prompt.
struct AttachCard: View {
    let sessionId: String
    let projectName: String
    let onSend: (SendPromptInput.Attachment) -> Void
    let onClose: () -> Void

    let api: MantaAPIClient
    @State private var uploading = false
    @State private var errorText: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showFilePicker = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 1, matching: .images) {
                        Label("Photo", systemImage: "photo")
                    }
                    Button {
                        showFilePicker = true
                    } label: {
                        Label("File", systemImage: "doc")
                    }
                } footer: {
                    Text("The file is uploaded to the box and sent to the session.")
                }
                if uploading {
                    Section { HStack { Spacer(); ProgressView(); Spacer() } }
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Attach")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onClose) }
            }
            .fileImporter(isPresented: $showFilePicker,
                          allowedContentTypes: [.item],
                          allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first {
                    sendFile(url)
                }
            }
            .onChange(of: photoItems) { _, items in
                guard let item = items.first else { return }
                sendPhoto(item)
            }
        }
    }

    private func sendPhoto(_ item: PhotosPickerItem) {
        guard !uploading else { return }
        uploading = true
        errorText = nil
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run { fail("Couldn't read that photo") }
                return
            }
            let mime = ChatVoice.mime(forImageData: data)
            let filename = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
            do {
                let remote = try await api.upload(project: projectName, filename: filename, data: data)
                await MainActor.run {
                    uploading = false
                    onSend(SendPromptInput.Attachment(remotePath: remote, mime: mime, filename: filename))
                }
            } catch {
                await MainActor.run { fail("Photo upload failed") }
            }
        }
    }

    private func sendFile(_ url: URL) {
        guard !uploading else { return }
        uploading = true
        errorText = nil
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let filename = url.lastPathComponent
        guard let data = try? Data(contentsOf: url) else {
            uploading = false
            errorText = "Couldn't read that file"
            return
        }
        let mime = ChatVoice.mime(forFilename: filename)
        Task {
            do {
                let remote = try await api.upload(project: projectName, filename: filename, data: data)
                await MainActor.run {
                    uploading = false
                    onSend(SendPromptInput.Attachment(remotePath: remote, mime: mime, filename: filename))
                }
            } catch {
                await MainActor.run { fail("File upload failed") }
            }
        }
    }

    private func fail(_ message: String) {
        uploading = false
        errorText = message
    }
}
