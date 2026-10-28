import Combine
import Foundation

// ===========================================================================
// WS05 Feature E — the work inbox store. `load()` calls `forge:inbox` ONLY (the
// box returns rows ready to render, with each repo's local checkout joined in).
// "Start a session" creates NOTHING here (D12): it hands a `NewSessionDraft` to
// the create sheet, where one Create tap makes the worktree and session.
// ===========================================================================

struct InboxWorkClient: Sendable {
    var inbox: @Sendable () async throws -> WorkInboxResult
    var projects: @Sendable () async throws -> [MantaProject]
    var delegateStart: @Sendable (_ prompt: String, _ sessionID: String, _ directory: String) async throws -> GitDelegateStartResult

    static func live(_ api: MantaAPIClient = MantaAPIClient.live()) -> InboxWorkClient {
        InboxWorkClient(
            inbox: { try await api.forgeInbox() },
            projects: { try await api.projects() },
            delegateStart: { try await api.delegateStart(prompt: $0, sessionID: $1, directory: $2) }
        )
    }
}

enum InboxWorkPhase: Equatable, Sendable {
    case loading
    case loaded
    case notConnected
    case failed(String)
}

@MainActor
final class InboxWorkStore: ObservableObject {
    @Published private(set) var items: [WorkInboxItem] = []
    @Published private(set) var phase: InboxWorkPhase = .loading
    @Published private(set) var stale = false
    /// Chat sessions a background job could run under (loaded with the inbox).
    @Published private(set) var chatSessions: [WorkInboxSession] = []
    /// The id of the row an action is running for.
    @Published private(set) var busyItem: String?
    @Published var actionError: String?
    @Published var actionNotice: String?

    private let client: InboxWorkClient

    init(client: InboxWorkClient = .live()) {
        self.client = client
    }

    /// An older box answers with rows that carry none of the box's row fields.
    var boxNeedsUpdate: Bool {
        !items.isEmpty && items.allSatisfy { !$0.hasBoxRowFields }
    }

    func load() async {
        if case .failed = phase { phase = .loading }
        do {
            let result = try await client.inbox()
            stale = result.stale
            if result.error == "not_connected" {
                items = []
                phase = .notConnected
            } else {
                items = result.items
                phase = .loaded
                // Secondary read: without it "Delegate in background" simply isn't offered.
                if let projects = try? await client.projects() {
                    chatSessions = WorkInbox.sessions(from: projects)
                }
            }
        } catch {
            // A failed refresh keeps the rows already shown; a first load says so.
            if items.isEmpty {
                phase = .failed(WorkInbox.loadFailedMessage)
            } else {
                actionError = WorkInbox.loadFailedMessage
            }
        }
    }

    // MARK: Start a session

    /// The draft for the create sheet, or nil (with the reason in `actionError`)
    /// when the repo has no checkout on the box. Creates nothing.
    func startSessionDraft(for item: WorkInboxItem) -> NewSessionDraft? {
        actionError = nil
        guard let fields = WorkInbox.draftFields(for: item) else {
            actionError = WorkInbox.noCheckoutMessage(repoName: item.repoName ?? Self.repoName(item.repoKey))
            return nil
        }
        return NewSessionDraft(
            cwd: fields.cwd,
            text: fields.text,
            attachments: [],
            worktreeBranch: fields.worktreeBranch,
            linkedIssueURL: fields.linkedIssueURL
        )
    }

    // MARK: Delegate in the background

    /// The chat sessions a job could nest under, repo's own sessions first.
    func parentCandidates(for item: WorkInboxItem) -> [WorkInboxSession] {
        guard let repoPath = item.localPath else { return [] }
        return WorkInbox.parentCandidates(sessions: chatSessions, repoPath: repoPath)
    }

    /// Start the job under `parent`. The sheet stays; `actionNotice` is the
    /// visible confirmation.
    func delegate(_ item: WorkInboxItem, under parent: WorkInboxSession) async {
        guard let directory = item.localPath, !directory.isEmpty else {
            actionError = WorkInbox.noCheckoutMessage(repoName: item.repoName ?? Self.repoName(item.repoKey))
            return
        }
        actionError = nil
        actionNotice = nil
        busyItem = item.id
        defer { busyItem = nil }
        do {
            let result = try await client.delegateStart(item.seed, parent.sessionID, directory)
            if result.ok {
                actionNotice = "Background job started under \(parent.name)"
            } else {
                actionError = result.error.flatMap { $0.isEmpty ? nil : $0 } ?? "Couldn't start the background job."
            }
        } catch {
            actionError = GitForgeText.describe(error)
        }
    }

    private static func repoName(_ repoKey: String) -> String {
        repoKey.split(separator: "/").last.map(String.init) ?? repoKey
    }
}
