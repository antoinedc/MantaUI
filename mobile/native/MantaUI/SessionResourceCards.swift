import SwiftUI

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
                    SecureField("Value (stored on the box; never shown again)", text: $value)
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
// BET-750 — artifacts / agent-file outbox receive card.
//
// The reverse of the composer's paperclip: files the AI pushes to the box's
// `~/.manta-outbox/<sessionID>/` are listed here, scoped to this session, and
// each row's download button pulls the bytes over `GET /api/download` and hands
// them to the system share sheet ("Save to Files"). Receive-only — this is not
// an upload path. Same stock-SwiftUI treatment as SchedulesCard/SecretsCard:
// the list refetches on `.task` (and lightly while presented, so a file the AI
// drops mid-chat appears) with an honest empty state and a `failed` flag.
// ===========================================================================

/// List of agent-pushed files for this session (`outbox:list`), each with a
/// system download action. Once a row's bytes are fetched it is written to the
/// app's temp directory and that row swaps its download button for a
/// `ShareLink`, so saving to Files goes through the platform share sheet.
struct ArtifactsCard: View {
    let sessionId: String
    let onClose: () -> Void

    @State private var files: [OutboxFile] = []
    @State private var loaded = false
    @State private var failed = false
    /// Per-path temp URL where a successfully-downloaded file lives. A row
    /// whose path is present here shows a ShareLink instead of a download tap.
    @State private var downloaded: [String: URL] = [:]
    /// Paths currently being fetched (row spinner).
    @State private var downloading: Set<String> = []
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
                    if files.isEmpty {
                        emptyState
                    } else {
                        List(files) { file in
                            row(file)
                        }
                        .listStyle(.insetGrouped)
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
    }

    private func load() async {
        if let result = try? await api.listOutbox(sessionId: sessionId) {
            files = result
            failed = false
        } else {
            failed = true
        }
        loaded = true
    }

    /// Fetch the file's bytes and stage them in the app's temp directory so the
    /// row can offer a system Save-to-Files share. A failed download leaves the
    /// row's download control in place — nothing is reported as saved.
    private func download(_ file: OutboxFile) async {
        guard !downloading.contains(file.path) else { return }
        downloading.insert(file.path)
        defer { downloading.remove(file.path) }
        do {
            let data = try await api.downloadOutboxFile(path: file.path)
            let url = Self.tempURL(for: file.name)
            try data.write(to: url)
            downloaded[file.path] = url
        } catch {
            // Failure: leave the control in place; no fabricated success.
        }
    }

    /// A writable temp URL the share sheet can hand to the OS. Derives from the
    /// file name and is overwritten on each (re)download of the same row.
    private static func tempURL(for name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
        let safe = name.replacingOccurrences(of: "/", with: "_")
        return dir.appendingPathComponent(safe)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No artifacts",
            systemImage: "doc",
            description: Text("Files the AI sends during this conversation will appear here.")
        )
        .accessibilityIdentifier("artifacts-empty")
    }

    private func row(_ file: OutboxFile) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.body)
                    .lineLimit(1)
                    .accessibilityIdentifier("artifact-name-\(file.name)")
                Text(Self.formatSize(file.size))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if let url = downloaded[file.path] {
                ShareLink(item: url)
                    .accessibilityLabel("Save \(file.name)")
            } else if downloading.contains(file.path) {
                ProgressView()
            } else {
                Button {
                    Task { await download(file) }
                } label: {
                    Image(systemName: "arrow.down.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Download \(file.name)")
            }
        }
        .padding(.vertical, 2)
    }

    private static func formatSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
