import SwiftUI
import UIKit

// ===========================================================================
// WS04 §6 — Clone from GitHub: sign in (WS04's own device sign-in), pick
// repositories, clone them one after another with real progress, then hand the
// cloned paths to the caller (the create sheet turns them into workspaces
// exactly like repositories the scan found).
//
// Desktop reference: `CloneFromGitHub.tsx`. Behaviours kept:
//   - nothing is pre-checked;
//   - clones run sequentially, destination `<root>/<repo name>`;
//   - the destination preflight message is shown verbatim, never blamed on the
//     token; polling every 0.5 s with a 130 s cap per repository;
//   - `forge:repos` answering `rejected` / `not_connected` returns to sign-in.
// Fixed relative to desktop: a retry re-queues only repositories that were not
// already cloned (desktop re-ran the finished ones and failed on "not empty").
// ===========================================================================

@MainActor
final class CloneFromGitHubStore: ObservableObject {
    enum Phase: Equatable {
        case connect
        case pick
        case cloning(name: String, index: Int, total: Int)
        case failed(name: String, kind: CloneErrorKind, message: String, raw: String)
    }

    enum ReposState: Equatable {
        case loading
        case ready([GitHubRepo])
        case error(String)
    }

    @Published private(set) var phase: Phase = .connect
    @Published private(set) var reposState: ReposState = .loading
    @Published var search = ""
    /// nil = all owners.
    @Published var owner: String?
    @Published private(set) var checked: Set<String> = []
    @Published var root: String
    @Published private(set) var status: CloneJobStatus?
    /// Bumped to rebuild the sign-in view when the box dropped the credential.
    @Published private(set) var signInAttempt = 0
    /// A transient line ("Copied", or a cancel that failed).
    @Published private(set) var note: String?

    private let api: MantaAPIClient
    private var cloneTask: Task<Void, Never>?
    private var currentJobID: String?
    private var queue: [GitHubRepo] = []
    private var clonedPaths: [String] = []
    private var finished = false
    var onCloned: ([String]) -> Void = { _ in }

    init(defaultRoot: String, api: MantaAPIClient = MantaAPIClient.live()) {
        self.root = defaultRoot
        self.api = api
    }

    // MARK: - Picker

    var repos: [GitHubRepo] {
        if case .ready(let list) = reposState { return list }
        return []
    }

    var owners: [String] { ClonePicker.owners(repos) }
    var filtered: [GitHubRepo] { ClonePicker.filter(repos: repos, owner: owner, query: search) }
    var selected: [GitHubRepo] { repos.filter { checked.contains($0.fullName) } }
    var canClone: Bool { !selected.isEmpty && !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func toggle(_ repo: GitHubRepo) {
        if checked.contains(repo.fullName) { checked.remove(repo.fullName) } else { checked.insert(repo.fullName) }
    }

    /// The device sign-in succeeded (or the box was already connected).
    func connected() {
        phase = .pick
        Task { await loadRepos() }
    }

    func loadRepos() async {
        reposState = .loading
        do {
            let reply = try await api.forgeRepos()
            if RepoListError.needsSignIn(code: reply.error) {
                // The box cleared the dead credential: back to sign-in.
                signInAttempt += 1
                phase = .connect
                return
            }
            if let code = reply.error, !code.isEmpty {
                reposState = .error(RepoListError.message(code: code))
            } else {
                reposState = .ready(reply.repos)
            }
        } catch {
            reposState = .error(RepoListError.message(code: nil))
        }
    }

    // MARK: - Clone

    func cloneSelected() {
        guard canClone else { return }
        // Repositories cloned earlier (before a failure and "Pick another repo")
        // are kept: they are on disk and still get set up as workspaces.
        finished = false
        run(selected)
    }

    /// "Try again": the failed repository goes last; ones already cloned stay done.
    func retry() {
        guard case .failed(let name, _, _, _) = phase else { return }
        let remaining = queue.filter { repo in
            !clonedPaths.contains(ClonePicker.dest(root: root, name: repo.name))
        }
        let failed = remaining.filter { $0.name == name }
        let others = remaining.filter { $0.name != name }
        run(others + failed)
    }

    func pickAnother() {
        phase = .pick
        status = nil
    }

    func copyDiagnostics() {
        guard case .failed(_, _, _, let raw) = phase else { return }
        UIPasteboard.general.string = raw
        showNote("Copied")
    }

    /// Cancel during a clone: stop it on the box, then back to the picker.
    func cancelClone() async {
        let job = currentJobID
        cloneTask?.cancel()
        cloneTask = nil
        currentJobID = nil
        phase = .pick
        status = nil
        guard let job else { return }
        do {
            try await api.forgeCloneCancel(id: job)
        } catch {
            showNote("Couldn't stop the clone on the server — it may finish in the background.")
        }
    }

    /// The screen went away mid-clone (back swipe): don't leave it running.
    func abandon() {
        guard !finished, cloneTask != nil, let job = currentJobID else { return }
        cloneTask?.cancel()
        cloneTask = nil
        currentJobID = nil
        let api = self.api
        Task { try? await api.forgeCloneCancel(id: job) }
    }

    private func run(_ repos: [GitHubRepo]) {
        queue = repos
        cloneTask?.cancel()
        cloneTask = Task { [weak self] in
            await self?.runQueue(repos)
        }
    }

    private func runQueue(_ repos: [GitHubRepo]) async {
        for (offset, repo) in repos.enumerated() {
            guard !Task.isCancelled else { return }
            phase = .cloning(name: repo.name, index: offset, total: repos.count)
            status = nil
            let dest = ClonePicker.dest(root: root.trimmingCharacters(in: .whitespacesAndNewlines), name: repo.name)
            // Already cloned in an earlier pass: nothing to do (cloning again
            // would fail on a non-empty destination).
            if clonedPaths.contains(dest) { continue }

            let start: CloneStartResult
            do {
                start = try await api.forgeCloneStart(url: repo.cloneUrl, dest: dest, name: repo.name)
            } catch {
                guard !Task.isCancelled else { return }
                fail(repo, kind: .unknown, raw: "Couldn't reach the server.")
                return
            }
            guard !Task.isCancelled else { return }
            guard let id = start.id, !id.isEmpty else {
                // The box preflights the destination and says what is wrong —
                // shown verbatim (it names the folder, never the token).
                if let message = start.message, !message.isEmpty {
                    fail(repo, kind: .destination, raw: message)
                } else {
                    fail(repo, kind: .unknown, raw: "Couldn't start the clone.")
                }
                return
            }
            currentJobID = id

            switch await poll(id: id) {
            case .cancelled:
                return
            case .failed(let kind, let raw):
                currentJobID = nil
                fail(repo, kind: kind, raw: raw)
                return
            case .done:
                currentJobID = nil
                clonedPaths.append(dest)
            }
        }
        guard !Task.isCancelled else { return }
        finished = true
        cloneTask = nil
        onCloned(clonedPaths)
    }

    private enum PollResult {
        case done
        case failed(CloneErrorKind, String)
        case cancelled
    }

    private func poll(id: String) async -> PollResult {
        let deadline = Date().addingTimeInterval(CloneTiming.timeout)
        var consecutiveThrows = 0
        while !Task.isCancelled {
            if Date() > deadline { return .failed(.network, "The clone timed out.") }
            let reply: CloneJobStatus?
            do {
                reply = try await api.forgeCloneStatus(id: id)
                consecutiveThrows = 0
            } catch {
                guard !Task.isCancelled else { return .cancelled }
                // One network blip must not end the clone UI while the box keeps
                // cloning: only a run of failures does.
                consecutiveThrows += 1
                if consecutiveThrows >= CloneTiming.maxConsecutiveThrows {
                    return .failed(.network, "Lost contact with the server while cloning.")
                }
                try? await Task.sleep(nanoseconds: UInt64(CloneTiming.pollInterval * 1_000_000_000))
                continue
            }
            guard !Task.isCancelled else { return .cancelled }
            // `null` means the box forgot the job.
            guard let snapshot = reply else { return .failed(.unknown, "The clone job went away.") }
            status = snapshot
            if snapshot.done {
                if snapshot.ok { return .done }
                let raw = snapshot.error ?? ""
                return .failed(CloneErrorKind.classify(raw), raw.isEmpty ? "Clone failed" : raw)
            }
            try? await Task.sleep(nanoseconds: UInt64(CloneTiming.pollInterval * 1_000_000_000))
        }
        return .cancelled
    }

    private func fail(_ repo: GitHubRepo, kind: CloneErrorKind, raw: String) {
        phase = .failed(name: repo.name, kind: kind, message: CloneFailureCopy.message(kind: kind, raw: raw), raw: raw)
        cloneTask = nil
    }

    private func showNote(_ text: String) {
        note = text
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if self?.note == text { self?.note = nil }
        }
    }
}

// MARK: - View

struct CloneFromGitHubView: View {
    let defaultRoot: String
    let onCloned: ([String]) -> Void

    @StateObject private var store: CloneFromGitHubStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(defaultRoot: String, onCloned: @escaping ([String]) -> Void) {
        self.defaultRoot = defaultRoot
        self.onCloned = onCloned
        _store = StateObject(wrappedValue: CloneFromGitHubStore(defaultRoot: defaultRoot))
    }

    private var tokens: Tokens { Tokens.scheme(colorScheme) }

    var body: some View {
        content
            .navigationTitle(store.phase == .connect ? "Connect GitHub" : "Clone a repository")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { store.onCloned = onCloned }
            .onDisappear { store.abandon() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .connect:
            GitHubDeviceSignInView(
                onConnected: { store.connected() },
                onCancel: { dismiss() }
            )
            .id(store.signInAttempt)
        case .pick:
            picker
        case .cloning(let name, let index, let total):
            cloning(name: name, index: index, total: total)
        case .failed(let name, _, let message, _):
            failed(name: name, message: message)
        }
    }

    // MARK: Picker

    private var picker: some View {
        List {
            Section {
                switch store.reposState {
                case .loading:
                    HStack(spacing: Metrics.spacing.sp3) {
                        ProgressView()
                        Text("Loading repositories…").foregroundColor(tokens.tx3)
                    }
                case .error(let text):
                    VStack(alignment: .leading, spacing: Metrics.spacing.sp2) {
                        Text(text).foregroundColor(tokens.danger)
                        Button("Try again") { Task { await store.loadRepos() } }
                    }
                case .ready:
                    if store.filtered.isEmpty {
                        Text("No repositories match.").foregroundColor(tokens.tx3)
                    }
                    ForEach(store.filtered) { repo in
                        repoRow(repo)
                    }
                }
            }
            Section {
                LabeledContent("Clone into") {
                    TextField("Folder", text: $store.root)
                        .font(.system(.body, design: .monospaced))
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            } footer: {
                Text("Each repository is cloned into its own folder here.")
            }
        }
        .searchable(text: $store.search, prompt: "Search \(store.repos.count) repositories")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Owner", selection: $store.owner) {
                        Text("All owners").tag(String?.none)
                        ForEach(store.owners, id: \.self) { owner in
                            Text("@\(owner)").tag(String?.some(owner))
                        }
                    }
                } label: {
                    Label("Owner", systemImage: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Filter by owner")
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Clone \(store.selected.count) selected") { store.cloneSelected() }
                    .disabled(!store.canClone)
            }
        }
    }

    private func repoRow(_ repo: GitHubRepo) -> some View {
        let isOn = store.checked.contains(repo.fullName)
        return Button {
            store.toggle(repo)
        } label: {
            HStack(spacing: Metrics.spacing.sp3) {
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(isOn ? tokens.accent : tokens.tx4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.fullName)
                        .foregroundColor(tokens.tx1)
                        .lineLimit(1)
                    Text((repo.description ?? "").isEmpty ? "—" : (repo.description ?? ""))
                        .font(.footnote)
                        .foregroundColor(tokens.tx3)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let pushed = repo.pushedAt {
                    Text(RepoRowFormat.age(ms: Date().timeIntervalSince1970 * 1000 - pushed))
                        .font(.caption.monospacedDigit())
                        .foregroundColor(tokens.tx4)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    // MARK: Cloning

    private func cloning(name: String, index: Int, total: Int) -> some View {
        let percent = store.status?.percent ?? 0
        let bytes = store.status?.bytes ?? 0
        return VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text(CloneProgressCopy.headline(name: name, percent: percent, bytes: bytes))
                .font(.headline)
                .foregroundColor(tokens.tx1)
            ProgressView(value: max(0, min(100, percent)), total: 100)
            if let dest = store.status?.dest, !dest.isEmpty {
                Text("into \(dest)")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundColor(tokens.tx3)
            }
            if total > 1 {
                Text("Repository \(index + 1) of \(total)")
                    .font(.footnote)
                    .foregroundColor(tokens.tx4)
            }
            if let note = store.note {
                Text(note).font(.footnote).foregroundColor(tokens.warn)
            }
            Button("Cancel") { Task { await store.cancelClone() } }
                .buttonStyle(.bordered)
            Spacer(minLength: 0)
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: Failed

    private func failed(name: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.spacing.sp3) {
            Text("Clone failed")
                .font(.headline)
                .foregroundColor(tokens.tx1)
            Text("Couldn't clone \(name): \(message)")
                .foregroundColor(tokens.tx2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Metrics.spacing.sp3) {
                Button("Try again") { store.retry() }
                    .buttonStyle(.borderedProminent)
                Button("Pick another repo") { store.pickAnother() }
                    .buttonStyle(.bordered)
            }
            Button("Copy diagnostics") { store.copyDiagnostics() }
                .buttonStyle(.bordered)
            if let note = store.note {
                Text(note).font(.footnote).foregroundColor(tokens.ok)
            }
            Spacer(minLength: 0)
        }
        .padding(Metrics.spacing.sp4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
