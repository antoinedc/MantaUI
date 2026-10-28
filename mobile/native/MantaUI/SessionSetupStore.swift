import Foundation

// ===========================================================================
// WS04 §5 — the repository scan and the "Set up N workspaces" batch.
//
// The decisions (zero-state mode, row copy, unique names, which row lands) are
// pure and live in `SessionCreateLogic.swift`; this store is the I/O around
// them: probe the box once when the create sheet opens in "New project" mode,
// then create one project per checked repository, one after another, with a
// status per row and a working Retry.
// ===========================================================================

/// The two calls the batch needs, so the store is testable without a box.
protocol SessionSetupAPI: Sendable {
    func forgeProbe() async throws -> ForgeProbeResult
    func createSession(_ input: SessionNewProjectInput) async throws -> TmuxCreateResult
}

extension MantaAPIClient: SessionSetupAPI {}

@MainActor
final class SessionSetupStore: ObservableObject {
    enum ProbeState: Equatable {
        case idle
        case scanning
        case failed
        case done(ForgeProbeResult)
    }

    @Published private(set) var probe: ProbeState = .idle
    /// Repositories added after the scan (freshly cloned ones).
    @Published private(set) var extraRepos: [RepoHit] = []
    /// Paths of the repositories the user ticked. Nothing is pre-checked.
    @Published var checked: Set<String> = []
    @Published private(set) var batch: SessionSetupBatch?

    /// The newest project list the box returned — handed to the list store.
    private(set) var latestProjects: [MantaProject] = []
    private var createdByPath: [String: SessionCreated] = [:]
    private var worker: Task<Void, Never>?
    private let api: SessionSetupAPI

    init(api: SessionSetupAPI = MantaAPIClient.live()) {
        self.api = api
    }

    // MARK: - Probe

    var probeResult: ForgeProbeResult? {
        if case .done(let result) = probe { return result }
        return nil
    }

    /// Scanned repositories plus cloned ones, without duplicates.
    var repos: [RepoHit] {
        var seen = Set<String>()
        return (extraRepos + (probeResult?.repos ?? [])).filter { seen.insert($0.path).inserted }
    }

    var homeDir: String? { probeResult?.homeDir }
    var cli: ForgeCliStatus? { probeResult?.cli }

    var zeroState: RepoZeroState {
        RepoZeroState.mode(
            pending: probe == .idle || probe == .scanning,
            failed: probe == .failed,
            repos: repos
        )
    }

    /// Where new workspaces go (and where clones land): the common parent of the
    /// scanned repositories, else `<home>/projects`; empty when nothing is known.
    var proposedRoot: String {
        SessionWorkspaceRoot.proposed(repoPaths: (probeResult?.repos ?? []).map(\.path), homeDir: homeDir)
    }

    func runProbe() async {
        guard probe == .idle || probe == .failed else { return }
        probe = .scanning
        do {
            let result = try await api.forgeProbe()
            guard !Task.isCancelled else { probe = .idle; return }
            probe = .done(result)
        } catch {
            // A cancelled sheet is not a failed scan.
            probe = Task.isCancelled ? .idle : .failed
        }
    }

    /// Re-scan after a failure (or on demand).
    func rescan() async {
        if probe == .scanning { return }
        probe = .idle
        await runProbe()
    }

    func toggle(_ path: String) {
        guard batch == nil else { return }
        if checked.contains(path) { checked.remove(path) } else { checked.insert(path) }
    }

    /// Repositories in scan order (what "Set up N" runs).
    var checkedPathsInOrder: [String] {
        repos.map(\.path).filter { checked.contains($0) }
    }

    // MARK: - Batch

    /// Starts the batch for `paths`. Names are unique across the batch and
    /// against `taken` (the existing project names).
    func setUp(paths: [String], taken: Set<String>) {
        guard !paths.isEmpty, !(batch?.isRunning ?? false) else { return }
        let known = Set(repos.map(\.path))
        for path in paths where !known.contains(path) {
            extraRepos.append(RepoHit(path: path, name: SessionNaming.deriveProjectName(path)))
        }
        checked.formUnion(paths)
        batch = SessionSetupBatch(paths: paths, taken: taken)
        createdByPath = [:]
        startWorker()
    }

    /// Put a failed row back and run it again.
    func retry(path: String) {
        guard var current = batch, !current.isRunning else { return }
        current.requeue(path: path)
        batch = current
        startWorker()
    }

    /// The created session for `path`, with the newest project list attached.
    func landing(path: String?) -> SessionCreated? {
        guard let path, var created = createdByPath[path] else { return nil }
        created.projects = latestProjects
        return created
    }

    func cancel() {
        worker?.cancel()
        worker = nil
    }

    private func startWorker() {
        guard worker == nil else { return }
        worker = Task { [weak self] in
            await self?.drain()
        }
    }

    private func drain() async {
        while !Task.isCancelled, var current = batch, let index = current.nextQueuedIndex {
            let row = current.rows[index]
            current.markCreating(at: index)
            batch = current
            let input = SessionNewProjectInput(
                name: row.name, cwd: row.path, windowName: "default", chatMode: true, createDir: false
            )
            do {
                let reply = try await api.createSession(input)
                guard !Task.isCancelled else { break }
                guard let window = SessionCreatedWindow.find(
                    in: reply.projects, project: row.name, windowIndex: reply.windowIndex, name: "default"
                ) else {
                    throw MantaError.transport("created session was not returned")
                }
                latestProjects = reply.projects
                createdByPath[row.path] = SessionCreated(
                    project: row.name,
                    windowIndex: window.index,
                    sessionId: window.opencodeSessionId ?? reply.sessionId,
                    projects: reply.projects,
                    mode: .chat,
                    draft: nil
                )
                batch?.markReady(path: row.path)
            } catch {
                guard !Task.isCancelled else { break }
                batch?.markFailed(path: row.path, message: SessionCreateFailure.message(for: error))
            }
        }
        worker = nil
    }
}
