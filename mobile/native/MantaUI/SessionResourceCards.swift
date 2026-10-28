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
    /// "Couldn't delete <key>." — a failed delete is never silent.
    @State private var deleteError: String?
    private let api = MantaAPIClient.live()

    var body: some View {
        NavigationStack {
            Group {
                if failed {
                    Text("Couldn't load secrets.")
                        .foregroundStyle(.secondary)
                } else if loaded {
                    if secrets.isEmpty && deleteError == nil {
                        emptyState
                    } else {
                        List {
                            if let deleteError {
                                Section {
                                    Text(deleteError)
                                        .foregroundStyle(.red)
                                        .accessibilityIdentifier("secrets-error")
                                }
                            }
                            ForEach(secrets) { secret in
                                row(secret)
                                    .swipeActions(edge: .trailing) {
                                        Button(role: .destructive) {
                                            Task { await delete(secret) }
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
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
        deleteError = nil
        do {
            try await api.deleteSecret(id: secret.id)
            await load()
        } catch {
            deleteError = "Couldn't delete \(secret.key ?? secret.id)."
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
                               description: Text("Tap + to add a secret. A shared secret is available to every session."))
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
        var parts: [String] = [SecretScopeOption.badge(secret)]
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
    @State private var scope = SecretScopeOption.shared
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
                        ForEach(SecretScopeOption.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.automatic)
                    TextField("Hint (optional)", text: $hint)
                } footer: {
                    Text("Shared secrets are available to every session on this box. Project: every chat in this workspace. Session: only this chat.")
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
        // The session id goes with SESSION and PROJECT scope (the box resolves the
        // project name from it); a shared secret sends none.
        let input = SecretScopeOption.input(key: key, value: value, scope: scope, sessionId: sessionId, hint: hint)
        if let error = await onSave(input) {
            errorMessage = error
        }
    }
}

// ===========================================================================
// Artifacts card — renders the box's `artifacts:list` (WS07).
//
// The box derives the list (links the user pasted, files and images, hosted pages
// the agent published, files the agent pushed, plan files, expiry state, counts);
// this card renders it and offers the gestures: tap → preview / open, search,
// Jump to message, Attach to message, Share / Copy. No derivation lives here, so
// a box that predates `artifacts:list` shows "Update your box to use this".
//
// Tapping a file or image PREVIEWS it (QuickLook), not downloads it: iOS has no
// user-visible Downloads folder. A box artifact is staged to the temp dir first —
// a task of unknown duration, so the row spins — and a failure is reported in the
// card's inline banner, never swallowed. Same stock-SwiftUI treatment as
// SchedulesCard/SecretsCard.
// ===========================================================================

/// How an artifact's bytes are fetched, for preview, Share and Attach: a `data:` URI
/// is decoded, an `http(s)` URL is fetched WITHOUT box credentials (it is not a box
/// resource — the token must never reach another origin), and a box path is streamed
/// through `/api/peek`.
enum ArtifactBytes {
    /// A plain GET with no `Authorization` header and no cookies, 30 s timeout.
    static func remoteRequest(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 30
        return request
    }

    /// The remote fetch, on its OWN ephemeral session — never `MantaAPIClient`'s.
    static func fetchRemote(_ url: URL) async -> Result<Data, ArtifactStagingError> {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let host = url.host ?? url.absoluteString
        do {
            let (data, response) = try await session.data(for: remoteRequest(for: url))
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return .failure(.remote(host: host))
            }
            return .success(data)
        } catch {
            return .failure(.remote(host: host))
        }
    }

    static func load(
        _ source: ArtifactByteSource,
        api: MantaAPIClient,
        remote: (URL) async -> Result<Data, ArtifactStagingError> = ArtifactBytes.fetchRemote
    ) async -> Result<Data, ArtifactStagingError> {
        switch source {
        case .dataURI(let href):
            guard let data = ArtifactDataURI.decode(href) else { return .failure(.badDataURI) }
            return .success(data)
        case .remote(let url):
            return await remote(url)
        case .boxPath(let path):
            do {
                return .success(try await api.peekFile(path: path))
            } catch {
                return .failure(.missing)
            }
        case .unsupported:
            return .failure(.missing)
        }
    }
}

/// Everything THIS conversation produced — files and images the user attached or the
/// agent pushed, links, hosted pages and plans — behind a Files · Images · Links ·
/// Plans segmented control, grouped by day. Tap → QuickLook / browser / plan page;
/// long-press → Jump to message · Attach to message · Share · Copy.
struct ArtifactsCard: View {
    let sessionId: String
    let onClose: () -> Void
    /// The workspace the attach upload goes to (nil hides "Attach to message").
    var projectName: String? = nil
    /// The session's working folder. Pinned by the mount contract (M-07-1); the box
    /// resolves plan file locations itself, so the card does not read it.
    var cwd: String? = nil
    /// The chat's composer (nil hides "Attach to message"). Passed explicitly rather
    /// than read from the environment so the sheet does not depend on where the
    /// `.environment(\.composerController, …)` sits relative to its `.sheet`.
    var composer: ComposerTextController? = nil
    /// Close the card and open the message in the chat (nil hides "Jump to message").
    var onJumpToMessage: ((String) -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme
    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    @State private var result: ArtifactsListResult?
    @State private var loadFailed = false
    @State private var unsupported = false
    @State private var segment: ArtifactKind = .file
    @State private var query = ""
    /// Inline, dismissible banner for any preview / attach / open failure.
    @State private var errorMessage: String?
    /// Artifact ids currently having their bytes fetched (row spinner).
    @State private var staging: Set<String> = []
    /// Staged local files keyed by artifact id, with the revision they were fetched at —
    /// what QuickLook / Share / Attach can reuse while the row is unchanged.
    @State private var stagedFiles: [String: StagedFile] = [:]
    @State private var quickLookURLs: [URL] = []
    @State private var quickLookStartIndex = 0
    @State private var showingQuickLook = false
    private let api = MantaAPIClient.live()
    /// Poll cadence while presented, so a file the AI drops mid-chat appears without
    /// reopening the card. The box memoizes the derivation, so this is cheap.
    private static let refreshIntervalNanoseconds: UInt64 = 3_000_000_000

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Artifacts")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onClose)
                    }
                }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic),
                            prompt: "Search links & files")
        }
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

    // MARK: States

    @ViewBuilder
    private var content: some View {
        if unsupported {
            ContentUnavailableView(
                "Update your box to use this",
                systemImage: "arrow.down.circle",
                description: Text("Artifacts need a newer box version.")
            )
            .accessibilityIdentifier("artifacts-unsupported")
        } else if let result {
            VStack(spacing: 0) {
                segmented(result)
                if let errorMessage { errorBanner(errorMessage) }
                if loadFailed { refreshFailedRow }
                if filtered(result).isEmpty {
                    emptyState(result)
                } else {
                    list(result)
                }
            }
        } else if loadFailed {
            VStack(spacing: Metrics.spacing.sp3) {
                Text("Couldn't load artifacts.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("artifacts-failed")
                Button("Retry") { Task { await load() } }
                    .buttonStyle(.bordered)
            }
        } else {
            ProgressView()
        }
    }

    // MARK: Derived (render-only)

    private func items(_ result: ArtifactsListResult) -> [ArtifactItem] { result.renderable }

    private func filtered(_ result: ArtifactsListResult) -> [ArtifactItem] {
        ArtifactSearch.filter(items(result), query: query).filter { $0.kind == segment }
    }

    /// The box's totals; while searching, the live match counts.
    private func counts(_ result: ArtifactsListResult) -> ArtifactCountsWire {
        ArtifactSearch.isActive(query) ? ArtifactSearch.counts(items(result), query: query) : result.counts
    }

    private func segmented(_ result: ArtifactsListResult) -> some View {
        let counts = counts(result)
        return Picker("Segment", selection: $segment) {
            Text("Files \(counts.file)").tag(ArtifactKind.file)
            Text("Images \(counts.image)").tag(ArtifactKind.image)
            Text("Links \(counts.link)").tag(ArtifactKind.link)
            Text("Plans \(counts.plan)").tag(ArtifactKind.plan)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.vertical, Metrics.spacing.sp2)
        .accessibilityIdentifier("artifacts-segment")
    }

    private func list(_ result: ArtifactsListResult) -> some View {
        List {
            ForEach(ArtifactDayGrouping.grouped(filtered(result), now: Date()), id: \.label) { group in
                Section(header: Text(group.label)) {
                    ForEach(group.items) { item in
                        row(item)
                    }
                }
            }
            if let footer = ArtifactDegradedCopy.footer(result.degraded) {
                Section {
                    EmptyView()
                } footer: {
                    Text(footer)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func emptyState(_ result: ArtifactsListResult) -> some View {
        if ArtifactSearch.isActive(query) {
            ContentUnavailableView.search(text: query)
        } else {
            ContentUnavailableView(
                ArtifactEmptyCopy.big(segment),
                systemImage: Self.glyph(segment),
                description: Text(ArtifactEmptyCopy.sub(segment, result.counts))
            )
            .accessibilityIdentifier("artifacts-empty")
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: Metrics.spacing.sp2) {
            Text(message)
                .font(.manta(size: Metrics.type.small))
                .foregroundStyle(tokens.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                errorMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Metrics.type.small, weight: .semibold))
                    .foregroundStyle(tokens.tx3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(Metrics.spacing.sp3)
        .background(tokens.danger.opacity(0.12))
        .accessibilityIdentifier("artifacts-error")
    }

    /// A refresh failed while an older list is showing: say so, offer a retry.
    private var refreshFailedRow: some View {
        HStack {
            Text("Couldn't refresh artifacts.")
                .font(.manta(size: Metrics.type.xs))
                .foregroundStyle(tokens.tx3)
            Spacer(minLength: Metrics.spacing.sp2)
            Button("Retry") { Task { await load() } }
                .font(.manta(size: Metrics.type.xs, weight: .semibold))
        }
        .padding(.horizontal, Metrics.spacing.sp3)
        .padding(.bottom, Metrics.spacing.sp1)
    }

    // MARK: Loading

    private func load() async {
        do {
            result = try await api.artifactsList(sessionId: sessionId)
            loadFailed = false
            unsupported = false
        } catch {
            if ArtifactsCapability.isUnsupported(error) {
                unsupported = true
                loadFailed = false
            } else {
                loadFailed = true
            }
        }
    }

    // MARK: Row

    private func row(_ item: ArtifactItem) -> some View {
        HStack(spacing: Metrics.spacing.sp3) {
            Image(systemName: Self.glyph(item.kind))
                .font(.system(size: Metrics.type.small))
                .foregroundStyle(tokens.tx4)
                .frame(width: Metrics.spacing.sp4)
            VStack(alignment: .leading, spacing: Metrics.spacing.sp1) {
                Text(item.label)
                    .font(.manta(size: Metrics.type.body))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(secondaryLine(item))
                    .font(.manta(size: Metrics.type.xs))
                    .foregroundStyle(tokens.tx3)
                    .lineLimit(1)
                if item.kind == .link, let context = item.context, !context.isEmpty {
                    Text(context)
                        .font(.manta(size: Metrics.type.xs))
                        .foregroundStyle(tokens.tx3)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: Metrics.spacing.sp2)
            if staging.contains(item.id) {
                ProgressView()
            }
            trailingCapsule(item)
        }
        .padding(.vertical, Metrics.spacing.sp1)
        .opacity(item.expiry?.state == .expired ? 0.5 : 1)
        .contentShape(Rectangle())
        .onTapGesture { onTap(item) }
        .contextMenu { contextMenu(for: item) }
    }

    private func secondaryLine(_ item: ArtifactItem) -> String {
        if item.kind == .plan { return ArtifactFormat.planSubline(steps: item.plan?.steps ?? 0) }
        return ArtifactFormat.secondaryLine(item, now: Date())
    }

    @ViewBuilder
    private func trailingCapsule(_ item: ArtifactItem) -> some View {
        if item.kind == .plan, let plan = item.plan {
            capsule(plan.status.rawValue, color: Self.planColor(plan.status, tokens))
        } else if let expiry = item.expiry {
            let text = ArtifactExpiryLabel.text(expiry, now: Date())
            if !text.isEmpty { capsule(text, color: Self.expiryColor(expiry.state, tokens)) }
        }
    }

    private func capsule(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.manta(size: Metrics.type.twoXS, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
            .lineLimit(1)
    }

    private static func expiryColor(_ state: ArtifactExpiryState, _ tokens: Tokens) -> Color {
        switch state {
        case .live, .never, .unknown: return tokens.ok
        case .soon: return tokens.warn
        case .expired: return tokens.danger
        }
    }

    private static func planColor(_ status: ArtifactPlanStatus, _ tokens: Tokens) -> Color {
        switch status {
        case .draft, .unknown: return tokens.tx3
        case .approved: return tokens.warn
        case .building: return tokens.accent
        case .done: return tokens.ok
        }
    }

    private static func glyph(_ kind: ArtifactKind) -> String {
        switch kind {
        case .file, .unknown: return "doc"
        case .image: return "photo"
        case .link: return "link"
        case .plan: return "list.clipboard"
        }
    }

    // MARK: Tap / preview

    private func onTap(_ item: ArtifactItem) {
        switch item.kind {
        case .link:
            openLink(item)
        case .plan:
            openPlanPage(item)
        case .file, .image:
            Task { await presentPreview(item) }
        case .unknown:
            break
        }
    }

    /// A link opens in the browser (QuickLook has nothing to preview). A failure says so.
    private func openLink(_ item: ArtifactItem) {
        guard case .remote(let url) = ArtifactByteSource.classify(item.href) else {
            errorMessage = "Couldn't open the link."
            return
        }
        openExternally(url, failure: "Couldn't open the link.")
    }

    /// The box resolved the plan page URL; none → say so, never a dead tap.
    private func openPlanPage(_ item: ArtifactItem) {
        guard let raw = item.plan?.pageUrl, let url = URL(string: raw) else {
            errorMessage = ArtifactPlanCopy.openFailure(item.plan)
            return
        }
        openExternally(url, failure: ArtifactPlanCopy.openFailure(item.plan))
    }

    private func openExternally(_ url: URL, failure: String) {
        Task {
            let opened = await UIApplication.shared.open(url)
            if !opened { errorMessage = failure }
        }
    }

    /// Ensure the tapped artifact is staged, then present QuickLook over every
    /// staged previewable row of the segment (multi-item navigation comes free).
    /// A failure leaves the row untouched and reports in the banner.
    private func presentPreview(_ item: ArtifactItem) async {
        if currentStagedURL(item) == nil {
            guard !staging.contains(item.id) else { return }
            staging.insert(item.id)
            defer { staging.remove(item.id) }
            switch await stage(item) {
            case .success(let url):
                stagedFiles[item.id] = StagedFile(url: url, revision: ArtifactStaging.revision(item))
            case .failure(let error):
                errorMessage = ArtifactStagingError.message(error, name: item.label)
                return
            }
        }
        guard let result else { return }
        // The tapped row (just staged — a plan always is) plus every other row whose staged
        // copy is still current.
        let previewables = filtered(result).filter {
            $0.kind != .link && ($0.id == item.id || currentStagedURL($0) != nil)
        }
        let urls = previewables.compactMap { stagedFiles[$0.id]?.url }
        guard !urls.isEmpty else { return }
        quickLookURLs = urls
        quickLookStartIndex = max(0, previewables.firstIndex { $0.id == item.id } ?? 0)
        showingQuickLook = true
    }

    /// Fetch the artifact's bytes into the app's temp directory.
    private func stage(_ item: ArtifactItem) async -> Result<URL, ArtifactStagingError> {
        switch await ArtifactBytes.load(ArtifactByteSource.classify(item.href), api: api) {
        case .failure(let error):
            return .failure(error)
        case .success(let data):
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(ArtifactStaging.tempFileName(id: item.id, label: item.label, href: item.href))
            do {
                try data.write(to: url)
                return .success(url)
            } catch {
                return .failure(.write)
            }
        }
    }

    // MARK: Attach

    /// Upload a fresh copy of the artifact and attach it to the composer. The card
    /// closes ONLY after the attach succeeded (the ready chip is the visible success);
    /// every failure leaves it open with the reason in the banner.
    private func attach(_ item: ArtifactItem) async {
        guard let composer, let projectName else { return }
        guard !staging.contains(item.id) else { return }
        staging.insert(item.id)
        defer { staging.remove(item.id) }
        let name = item.label

        guard composer.acceptsInput else {
            errorMessage = ArtifactAttach.readOnlyMessage
            return
        }
        let loaded: Result<Data, ArtifactStagingError>
        if let staged = currentStagedURL(item), let data = try? Data(contentsOf: staged) {
            loaded = .success(data)
        } else {
            loaded = await ArtifactBytes.load(ArtifactByteSource.classify(item.href), api: api)
        }
        let bytes: Data
        switch loaded {
        case .failure(let error):
            errorMessage = ArtifactAttach.stagingFailureMessage(error, name: name)
            return
        case .success(let data):
            bytes = data
        }

        // A fresh copy is uploaded (as on desktop): the original may be an old upload,
        // an outbox file the box sweeps before the message is sent, or a remote URL the
        // box cannot read at all.
        let remotePath: String
        do {
            remotePath = try await api.upload(project: projectName, filename: ArtifactAttach.filename(for: item), data: bytes)
        } catch {
            errorMessage = ArtifactAttach.uploadFailureMessage(name: name)
            return
        }
        // The chat may have turned read-only while the bytes were in flight.
        guard composer.acceptsInput else {
            errorMessage = ArtifactAttach.readOnlyMessage
            return
        }
        if composer.attach(remotePath: remotePath, displayName: name, mime: item.mime) {
            onClose()
        } else {
            errorMessage = ArtifactAttach.rejectionMessage(composer.lastAttachRejection, name: name)
        }
    }

    // MARK: Context menu

    @ViewBuilder
    private func contextMenu(for item: ArtifactItem) -> some View {
        if ArtifactActions.canJump(hasHandler: onJumpToMessage != nil, messageId: item.messageId),
           let messageId = item.messageId {
            Button {
                onJumpToMessage?(messageId)
            } label: {
                Label("Jump to message", systemImage: "arrow.turn.down.right")
            }
        }
        if item.kind == .plan {
            Button {
                openPlanPage(item)
            } label: {
                Label("Open published page", systemImage: "safari")
            }
            if ArtifactActions.canOpenPlanFile(item) {
                Button {
                    Task { await presentPreview(item) }
                } label: {
                    Label("Open plan file", systemImage: "doc.text")
                }
            }
        }
        if let composer, let projectName {
            ArtifactAttachMenuItem(composer: composer, item: item, hasProject: !projectName.isEmpty) {
                Task { await attach(item) }
            }
        }
        if let url = shareURL(for: item) {
            ShareLink(item: url)
        }
        Button {
            UIPasteboard.general.string = item.href
        } label: {
            Label(item.kind == .link ? "Copy link" : "Copy path", systemImage: "doc.on.doc")
        }
    }

    /// The shareable URL: the staged local file for a file/image/plan, the href for a
    /// link. A file with no staged bytes yet has nothing shareable — sharing a raw box
    /// path would be a lie, so the menu omits ShareLink then.
    private func shareURL(for item: ArtifactItem) -> URL? {
        if item.kind == .link {
            if case .remote(let url) = ArtifactByteSource.classify(item.href) { return url }
            return nil
        }
        return currentStagedURL(item)
    }

    /// The staged copy of `item`, only while it still reflects the row (see
    /// `ArtifactStaging.isCurrent`); nil means it must be fetched again.
    private func currentStagedURL(_ item: ArtifactItem) -> URL? {
        guard let staged = stagedFiles[item.id],
              ArtifactStaging.isCurrent(stagedRevision: staged.revision, for: item) else { return nil }
        return staged.url
    }
}

/// A staged copy and the row revision it was fetched at.
private struct StagedFile {
    let url: URL
    let revision: String
}

/// "Attach to message" as its own view so it observes the composer: the item appears
/// and disappears as the chat's `acceptsInput` flips (a read-only background-job chat
/// takes no attachment).
private struct ArtifactAttachMenuItem: View {
    @ObservedObject var composer: ComposerTextController
    let item: ArtifactItem
    let hasProject: Bool
    let action: () -> Void

    var body: some View {
        if ArtifactActions.canAttach(kind: item.kind, hasComposer: true,
                                     acceptsInput: composer.acceptsInput, hasProject: hasProject) {
            Button(action: action) {
                Label("Attach to message", systemImage: "paperclip")
            }
        }
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
