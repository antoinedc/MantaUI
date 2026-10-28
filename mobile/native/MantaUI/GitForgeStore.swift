import Combine
import Foundation
import os

// ===========================================================================
// WS05 Features A–C — the branch / pull request / checks store of one chat
// screen. It polls the box (the box computes the view — G1/G2/G5/G6/G7), keeps
// the KEEP-CLIENT state (ship-preview sequencing, the merge snapshot, the
// connect-offer dismissal) and turns every failure of a USER action into a
// visible message. A failed AMBIENT poll keeps the last state: the desktop does
// the same (`ChatPanel.tsx:1074-1076`) — the poll is background, not an action.
// ===========================================================================

/// The network seam, so the store is unit-testable with a fake.
struct GitForgeClient: Sendable {
    var status: @Sendable () async throws -> ForgeConnectionStatus
    var pullRequest: @Sendable (_ cwd: String) async throws -> GitPullRequestResult
    var shipPreview: @Sendable (_ cwd: String, _ model: OpencodeModelID?, _ sessionId: String?) async throws -> GitShipPreviewResult
    var ship: @Sendable (_ cwd: String, _ title: String, _ body: String) async throws -> GitShipResult
    var merge: @Sendable (_ cwd: String, _ number: Int, _ sha: String) async throws -> GitMergeResult
    var capabilities: @Sendable () async throws -> Set<String>
    /// `config:get().forgeConnectOfferDismissed`.
    var offerDismissed: @Sendable () async throws -> Bool
    /// `config:update({forgeConnectOfferDismissed: true})`.
    var dismissOffer: @Sendable () async throws -> Void

    static func live(_ api: MantaAPIClient = MantaAPIClient.live()) -> GitForgeClient {
        GitForgeClient(
            status: { try await api.forgeStatus(validate: false) },
            pullRequest: { try await api.forgePullRequest(cwd: $0) },
            shipPreview: { try await api.forgeShipPreview(cwd: $0, model: $1, sessionId: $2) },
            ship: { try await api.forgeShip(cwd: $0, title: $1, body: $2) },
            merge: { try await api.forgeMerge(cwd: $0, number: $1, sha: $2) },
            capabilities: { try await api.boxCapabilities() },
            offerDismissed: {
                if case .bool(let dismissed)? = try await api.configGet()?[GitConnectOffer.configKey] { return dismissed }
                return false
            },
            dismissOffer: { _ = try await api.configUpdate([GitConnectOffer.configKey: true]) }
        )
    }
}

/// A one-line outcome shown in the sheet.
enum GitBanner: Equatable, Sendable {
    case ok(String)
    case error(String)

    var text: String {
        switch self {
        case .ok(let text), .error(let text): return text
        }
    }

    var isError: Bool {
        if case .error = self { return true }
        return false
    }
}

enum GitForgeText {
    /// What the user reads for a thrown error (the transport, not the forge).
    static func describe(_ error: Error) -> String {
        switch error {
        case MantaError.authRequired:
            return "This device isn't signed in to the box."
        case MantaError.server(let text) where !text.isEmpty:
            return text
        case MantaError.transport(let text) where !text.isEmpty:
            return text
        default:
            return "Couldn't reach your box. Check the connection and try again."
        }
    }
}

@MainActor
final class GitForgeStore: ObservableObject {
    /// The capability behind the PR view / checks chip / ship + merge copy.
    nonisolated static let pullRequestViewCapability = "forge-pr-view-1"

    @Published private(set) var state: GitForgeState = .empty
    /// True once a poll has answered.
    @Published private(set) var loadedOnce = false
    /// What the box says it can do; nil until asked.
    @Published private(set) var capabilities: Set<String>?
    @Published private(set) var offerDismissed = false
    @Published private(set) var shipPreview: GitShipPreviewState = .idle
    @Published private(set) var shipBusy = false
    @Published private(set) var mergeBusy = false
    /// The PR number just created ("Opened #N"), cleared after a few seconds.
    @Published private(set) var justShipped: Int?
    @Published private(set) var mergeMessage: GitBanner?

    private let client: GitForgeClient
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "git-forge")
    private static let pollInterval: TimeInterval = 5

    private var cwd: String?
    private var sceneActive = true
    /// Set while the branch sheet is open: the model/session a (re)fetched
    /// preview is drafted with.
    private var previewRequest: PreviewRequest?
    private var previewTask: Task<Void, Never>?
    private var justShippedTask: Task<Void, Never>?
    private var capabilitiesLoaded = false
    private var offerLoaded = false

    private struct PreviewRequest {
        var model: OpencodeModelID?
        var sessionId: String?
    }

    init(client: GitForgeClient = .live()) {
        self.client = client
    }

    // MARK: Derived (no rules — the box's view is rendered as received)

    /// An older box: GitHub is connected but the read carried no `view`, or the
    /// capability list lacks `forge-pr-view-1`.
    var boxNeedsUpdate: Bool {
        guard state.connected, loadedOnce else { return false }
        if capabilities?.contains(Self.pullRequestViewCapability) == false { return true }
        return state.view == nil
    }

    /// The branch is a button only when the box says the forge is in play.
    var branchIsInteractive: Bool {
        !boxNeedsUpdate && (state.view?.panel.isInteractive ?? false)
    }

    var showsConnectOffer: Bool {
        GitConnectOffer.shouldShow(connected: state.connected, forgeKind: state.kind, dismissed: offerDismissed)
    }

    var currentShipKey: GitShipKey? {
        guard let cwd else { return nil }
        return GitShipKey.current(state: state, cwd: cwd)
    }

    // MARK: Polling

    /// Poll the box every 5 s until cancelled (the view's `.task(id: cwd)` owns
    /// it, so it stops when the chat disappears and restarts on a cwd change).
    func run(cwd: String) async {
        attach(cwd: cwd)
        await loadCapabilitiesOnce()
        await loadOfferOnce()
        while !Task.isCancelled {
            if sceneActive { await tick(cwd: cwd) }
            do {
                try await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
            } catch {
                return // cancelled: the chat left the screen
            }
        }
    }

    /// Point the store at a working directory. A different folder starts from a
    /// clean slate.
    func attach(cwd: String) {
        guard self.cwd != cwd else { return }
        self.cwd = cwd
        state = .empty
        loadedOnce = false
        shipPreview = .idle
    }

    /// The app moved between foreground and background; the poll skips a tick
    /// while inactive and catches up at once on return.
    func setSceneActive(_ active: Bool) {
        let becameActive = active && !sceneActive
        sceneActive = active
        if becameActive { Task { await refreshNow() } }
    }

    /// One immediate refresh (after sign-in, after creating or merging).
    func refreshNow() async {
        guard let cwd else { return }
        await tick(cwd: cwd)
    }

    private func tick(cwd: String) async {
        do {
            async let status = client.status()
            async let result = client.pullRequest(cwd)
            let next = GitForgeState(status: try await status, result: try await result)
            guard self.cwd == cwd else { return } // the chat moved to another folder meanwhile
            apply(next, cwd: cwd)
        } catch {
            // Ambient poll: keep the last-known state, no UI noise (desktop parity).
            Self.log.debug("forge poll failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func apply(_ next: GitForgeState, cwd: String) {
        if state != next { state = next }
        loadedOnce = true
        // A terminal-side checkout can never leave the old branch's title on screen.
        let key = GitShipKey.current(state: next, cwd: cwd)
        let kept = shipPreview.invalidated(by: key)
        if kept != shipPreview {
            previewTask?.cancel()
            shipPreview = kept
            if previewRequest != nil { startPreviewIfNeeded() }
        }
    }

    private func loadCapabilitiesOnce() async {
        guard !capabilitiesLoaded else { return }
        do {
            capabilities = try await client.capabilities()
            capabilitiesLoaded = true
        } catch {
            Self.log.debug("capabilities read failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func loadOfferOnce() async {
        guard !offerLoaded else { return }
        do {
            offerDismissed = try await client.offerDismissed()
            offerLoaded = true
        } catch {
            Self.log.debug("offer flag read failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: Connect offer

    /// × on the offer: hide now; a failed write keeps it hidden for this run
    /// (desktop parity — no toast for a dismissal).
    func dismissConnectOffer() {
        offerDismissed = true
        Task {
            do {
                try await client.dismissOffer()
            } catch {
                Self.log.error("couldn't save the dismissal: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: Ship preview + create

    /// The branch sheet is open: draft the title / body for the CURRENT branch
    /// (once; a late answer for another branch is discarded).
    func ensureShipPreview(model: OpencodeModelID?, sessionId: String?) {
        previewRequest = PreviewRequest(model: model, sessionId: sessionId)
        startPreviewIfNeeded()
    }

    /// The sheet closed: stop re-drafting on branch changes.
    func releaseShipPreview() {
        previewRequest = nil
    }

    /// "Try again" after a failed preview or create.
    func retryShipPreview() {
        previewTask?.cancel()
        shipPreview = .idle
        startPreviewIfNeeded()
    }

    private func startPreviewIfNeeded() {
        guard let request = previewRequest, let cwd, let key = currentShipKey,
              state.view?.ship.state == .ready, !shipPreview.covers(key) else { return }
        shipPreview = .loading(key)
        previewTask?.cancel()
        let client = self.client
        previewTask = Task { [weak self] in
            let outcome: GitShipPreviewResult
            do {
                outcome = try await client.shipPreview(cwd, request.model, request.sessionId)
            } catch {
                guard !Task.isCancelled else { return }
                self?.applyPreviewFailure(GitForgeText.describe(error), for: key)
                return
            }
            guard !Task.isCancelled else { return }
            self?.applyPreview(outcome, for: key)
        }
    }

    private func applyPreview(_ response: GitShipPreviewResult, for key: GitShipKey) {
        // nil = the branch moved on while this was drafting: drop it.
        guard let next = GitShipPreviewState.accept(response: response, for: key, current: currentShipKey) else { return }
        shipPreview = next
    }

    private func applyPreviewFailure(_ message: String, for key: GitShipKey) {
        guard currentShipKey == key else { return }
        shipPreview = .failed(key, message)
    }

    /// Create the pull request from the ready preview of the current branch.
    func createPullRequest() async {
        guard !shipBusy, let cwd, case .ready(let key, let preview) = shipPreview,
              shipPreview.canCreate(current: currentShipKey) else { return }
        shipBusy = true
        defer { shipBusy = false }
        do {
            switch try await client.ship(cwd, preview.effectiveTitle, preview.body) {
            case .ok(let pr, _):
                shipPreview = .idle
                if let number = pr?.number { noteShipped(number) }
                // Swap to the PR view in the same moment: wait for the refreshed read.
                await refreshNow()
            case .failed(let failure):
                shipPreview = .failed(key, failure.display)
            }
        } catch {
            shipPreview = .failed(key, GitForgeText.describe(error))
        }
    }

    private func noteShipped(_ number: Int) {
        justShipped = number
        justShippedTask?.cancel()
        justShippedTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            self?.justShipped = nil
        }
    }

    // MARK: Merge

    /// The snapshot to confirm — nil unless the box's own gate says it can merge.
    func mergeTarget() -> GitMergeTarget? {
        guard let cwd else { return nil }
        return GitMergeTarget.target(state: state, cwd: cwd)
    }

    /// Merge exactly what the user confirmed. Never rereads `state`, so a poll
    /// that replaced or cleared the PR while the dialog was open changes nothing.
    func merge(_ target: GitMergeTarget) async {
        guard !mergeBusy else { return }
        mergeBusy = true
        mergeMessage = nil
        defer { mergeBusy = false }
        do {
            switch try await client.merge(target.cwd, target.number, target.headSha) {
            case .ok:
                mergeMessage = .ok("Merged #\(target.number)")
                await refreshNow()
            case .failed(let failure):
                mergeMessage = .error(failure.display)
            }
        } catch {
            mergeMessage = .error(GitForgeText.describe(error))
        }
    }

    func clearMergeMessage() {
        mergeMessage = nil
    }

    /// Whether a sheet over this store may be closed (not while creating / merging).
    var isBusy: Bool { shipBusy || mergeBusy }
}
